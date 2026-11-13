'use strict';

const fs = require('fs');
const path = require('path');
const tls = require('tls');
const os = require('os');

const BASE_URL = 'https://api.nanit.com';

const NANIT_API_HEADERS = {
  'nanit-api-version': '1',
  'User-Agent': 'Nanit/767 CFNetwork/1498.700.2 Darwin/23.6.0',
  'Content-Type': 'application/json',
  'Accept': 'application/json',
};

const NANIT_LITE_HEADERS = {
  'accept': 'application/json',
  'accept-charset': 'UTF-8',
  'x-nanit-platform': 'homeassistant',
  'user-agent': 'NanitLite/1.8.0 (com.udisense.nanitlite; build:168; homeassistant)',
  'x-nanit-service': '1.8.0 (168)',
};

function parseJwtExpiryMs(token, fallbackSec = 3600) {
  try {
    const parts = String(token).split('.');
    if (parts.length === 3) {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      if (typeof payload.exp === 'number') {
        return payload.exp * 1000;
      }
    }
  } catch {
    // ignore
  }
  return Date.now() + fallbackSec * 1000;
}

/**
 * Probes a local IPv4 host on TCP port 442 and reads its TLS certificate Subject CN
 * to extract `Nanit-<speaker_uid>.local`.
 */
function probeSpeakerUidFromTls(ip, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (val) => {
      if (!settled) {
        settled = true;
        resolve(val);
      }
    };

    const socket = tls.connect(
      {
        host: ip,
        port: 442,
        rejectUnauthorized: false,
        timeout: timeoutMs,
      },
      () => {
        try {
          const cert = socket.getPeerCertificate();
          const cn = cert && cert.subject && cert.subject.CN;
          socket.destroy();
          if (typeof cn === 'string') {
            const match = cn.match(/^Nanit-([A-Za-z0-9_-]+)\.local$/i);
            if (match) {
              return done({ ip, speakerUid: match[1] });
            }
          }
        } catch {
          socket.destroy();
        }
        done(null);
      }
    );

    socket.on('timeout', () => {
      socket.destroy();
      done(null);
    });
    socket.on('error', () => {
      socket.destroy();
      done(null);
    });
  });
}

/**
 * Scans the local IPv4 /24 subnet(s) on TCP port 442 to auto-discover
 * Nanit Sound + Light machines on the LAN via their TLS certificates.
 */
async function scanLanForSpeakers(log) {
  const subnets = new Set();
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const iface of list || []) {
      if (iface.family === 'IPv4' && !iface.internal && iface.address) {
        const parts = iface.address.split('.');
        if (parts.length === 4) {
          subnets.add(`${parts[0]}.${parts[1]}.${parts[2]}`);
        }
      }
    }
  }

  const discovered = new Map(); // speakerUid -> ip
  for (const subnet of subnets) {
    const ips = [];
    for (let i = 1; i <= 254; i++) {
      ips.push(`${subnet}.${i}`);
    }
    // Probe in batches of 40 so we don't exhaust file descriptors
    const batchSize = 40;
    for (let i = 0; i < ips.length; i += batchSize) {
      const batch = ips.slice(i, i + batchSize);
      const results = await Promise.all(batch.map((ip) => probeSpeakerUidFromTls(ip, 1200)));
      for (const res of results) {
        if (res && res.speakerUid) {
          discovered.set(res.speakerUid, res.ip);
          if (log) {
            log.info(`[LAN Discovery] Found Nanit Sound + Light (${res.speakerUid}) at ${res.ip}:442`);
          }
        }
      }
    }
  }
  return discovered;
}

class NanitApiClient {
  constructor({ log, storagePath, config }) {
    this.log = log;
    this.config = config || {};
    this.tokenFile = storagePath
      ? path.join(storagePath, 'nanit-sound-light-tokens.json')
      : null;

    this.accessToken = this.config.accessToken || '';
    this.refreshToken = this.config.refreshToken || '';
    this.mfaToken = '';
    this.expiresAt = this.accessToken ? parseJwtExpiryMs(this.accessToken) : 0;
    this._refreshPromise = null;

    this._loadStoredTokens();
  }

  _loadStoredTokens() {
    if (!this.tokenFile || !fs.existsSync(this.tokenFile)) {
      return;
    }
    try {
      const data = JSON.parse(fs.readFileSync(this.tokenFile, 'utf8'));
      // Prefer stored tokens if they match the configured email (or if no email override)
      if (!this.config.email || !data.email || data.email.toLowerCase() === this.config.email.toLowerCase()) {
        if (data.accessToken && data.refreshToken) {
          this.accessToken = data.accessToken;
          this.refreshToken = data.refreshToken;
          this.expiresAt = parseJwtExpiryMs(this.accessToken);
        }
        if (data.mfaToken) {
          this.mfaToken = data.mfaToken;
        }
      }
    } catch (err) {
      this.log.debug(`Could not read stored Nanit tokens: ${err.message}`);
    }
  }

  _saveTokens(extra = {}) {
    if (!this.tokenFile) return;
    try {
      let existing = {};
      if (fs.existsSync(this.tokenFile)) {
        try {
          existing = JSON.parse(fs.readFileSync(this.tokenFile, 'utf8'));
        } catch {
          existing = {};
        }
      }
      const payload = {
        ...existing,
        email: this.config.email || existing.email || '',
        accessToken: this.accessToken,
        refreshToken: this.refreshToken,
        mfaToken: this.mfaToken,
        updatedAt: new Date().toISOString(),
        ...extra,
      };
      fs.writeFileSync(this.tokenFile, JSON.stringify(payload, null, 2), { mode: 0o600 });
    } catch (err) {
      this.log.warn(`Failed to save Nanit tokens to ${this.tokenFile}: ${err.message}`);
    }
  }

  async ensureAuthenticated() {
    // 1. If we already have a refresh token, try refreshing if access token is missing or expiring within 5m
    if (this.accessToken && this.refreshToken) {
      if (Date.now() + 300_000 < this.expiresAt) {
        return this.accessToken;
      }
      try {
        await this.refreshTokens();
        return this.accessToken;
      } catch (err) {
        this.log.warn(`Stored Nanit token refresh failed (${err.message}); falling back to login...`);
      }
    }

    // 2. Otherwise log in with email & password
    const email = (this.config.email || '').trim();
    const password = this.config.password || '';
    const mfaCode = (this.config.mfaCode || '').trim();

    if (!email || !password) {
      throw new Error('Nanit email/password or valid accessToken/refreshToken must be configured');
    }

    // If an MFA code and cached mfaToken are present, try completing MFA login first
    if (mfaCode && this.mfaToken) {
      try {
        await this.loginWithMfa(email, password, this.mfaToken, mfaCode);
        return this.accessToken;
      } catch (err) {
        this.log.warn(`MFA verification with cached mfaToken failed (${err.message}); requesting fresh login...`);
      }
    }

    await this.login(email, password);
    return this.accessToken;
  }

  async login(email, password) {
    const resp = await fetch(`${BASE_URL}/login`, {
      method: 'POST',
      headers: NANIT_API_HEADERS,
      body: JSON.stringify({ email, password }),
    });

    let body = {};
    try {
      body = await resp.json();
    } catch {
      body = {};
    }

    if (body && body.mfa_token) {
      this.mfaToken = body.mfa_token;
      this._saveTokens({ mfaToken: this.mfaToken });
      const err = new Error(
        'Nanit MFA verification required! Check your email/phone for the verification code, add it as "mfaCode" in your config, and restart Homebridge.'
      );
      err.code = 'MFA_REQUIRED';
      err.mfaToken = body.mfa_token;
      throw err;
    }

    if (!resp.ok || !body.access_token) {
      const msg = body.error_description || body.error || body.message || `HTTP ${resp.status}`;
      throw new Error(`Nanit login failed: ${msg}`);
    }

    this.accessToken = body.access_token;
    this.refreshToken = body.refresh_token || '';
    this.mfaToken = '';
    this.expiresAt = parseJwtExpiryMs(this.accessToken);
    this._saveTokens({ mfaToken: '' });
    this.log.info('Successfully authenticated with Nanit Cloud.');
  }

  async loginWithMfa(email, password, mfaToken, mfaCode) {
    const resp = await fetch(`${BASE_URL}/login`, {
      method: 'POST',
      headers: NANIT_API_HEADERS,
      body: JSON.stringify({
        email,
        password,
        mfa_token: mfaToken,
        mfa_code: mfaCode,
      }),
    });

    let body = {};
    try {
      body = await resp.json();
    } catch {
      body = {};
    }

    if (!resp.ok || !body.access_token) {
      const msg = body.error_description || body.error || body.message || `HTTP ${resp.status}`;
      throw new Error(`Nanit MFA login failed: ${msg}`);
    }

    this.accessToken = body.access_token;
    this.refreshToken = body.refresh_token || '';
    this.mfaToken = '';
    this.expiresAt = parseJwtExpiryMs(this.accessToken);
    this._saveTokens({ mfaToken: '' });
    this.log.info('Successfully verified Nanit MFA and saved persistent tokens!');
  }

  async getAccessToken(forceRefresh = false) {
    if (!forceRefresh && this.accessToken && Date.now() + 300_000 < this.expiresAt) {
      return this.accessToken;
    }
    if (this.refreshToken) {
      await this.refreshTokens();
      return this.accessToken;
    }
    return this.ensureAuthenticated();
  }

  async refreshTokens() {
    if (this._refreshPromise) {
      return this._refreshPromise;
    }
    this._refreshPromise = (async () => {
      try {
        const resp = await fetch(`${BASE_URL}/tokens/refresh`, {
          method: 'POST',
          headers: {
            ...NANIT_API_HEADERS,
            Authorization: this.accessToken,
          },
          body: JSON.stringify({ refresh_token: this.refreshToken }),
        });

        let body = {};
        try {
          body = await resp.json();
        } catch {
          body = {};
        }

        if (!resp.ok || !body.access_token) {
          const msg = body.error_description || body.error || body.message || `HTTP ${resp.status}`;
          throw new Error(`Token refresh failed: ${msg}`);
        }

        this.accessToken = body.access_token;
        if (body.refresh_token) {
          this.refreshToken = body.refresh_token;
        }
        this.expiresAt = parseJwtExpiryMs(this.accessToken);
        this._saveTokens();
        this.log.debug('Refreshed Nanit access token.');
      } finally {
        this._refreshPromise = null;
      }
    })();

    return this._refreshPromise;
  }

  async getDeviceToken(speakerUid) {
    const requestToken = async (access) => {
      const resp = await fetch(`${BASE_URL}/speakers/${speakerUid}/udtokens`, {
        method: 'GET',
        headers: {
          ...NANIT_LITE_HEADERS,
          authorization: `token ${access}`,
        },
      });
      if (resp.status === 401) {
        const err = new Error('Unauthorized');
        err.status = 401;
        throw err;
      }
      if (!resp.ok) {
        throw new Error(`GET /speakers/${speakerUid}/udtokens failed with HTTP ${resp.status}`);
      }
      const body = await resp.json();
      const token = body && body.user_device_token && body.user_device_token.token;
      if (!token) {
        throw new Error(`No user_device_token.token in response for ${speakerUid}`);
      }
      return token;
    };

    let access = await this.getAccessToken(false);
    try {
      return await requestToken(access);
    } catch (err) {
      if (err.status === 401) {
        access = await this.getAccessToken(true);
        return await requestToken(access);
      }
      throw err;
    }
  }

  /**
   * Discovers all Sound + Light machines from:
   *  1. Configured `devices` list in config.json
   *  2. Cloud `/babies` & `/babies/<uid>/candidates/speakers`
   *  3. Cloud `/speakers` (NanitLite endpoint)
   *  4. Local LAN TLS certificate scan on TCP port 442 (`CN = Nanit-<uid>.local`)
   */
  async discoverSpeakers() {
    const speakers = new Map(); // speakerUid -> { speakerUid, name, ipAddress }

    // 1. Manual config entries
    if (Array.isArray(this.config.devices)) {
      for (const dev of this.config.devices) {
        if (dev && dev.speakerUid) {
          speakers.set(dev.speakerUid, {
            speakerUid: dev.speakerUid.trim(),
            name: dev.name || `Nanit Sound + Light`,
            ipAddress: dev.ipAddress ? dev.ipAddress.trim() : null,
          });
        } else if (dev && dev.ipAddress) {
          const probed = await probeSpeakerUidFromTls(dev.ipAddress.trim(), 2500);
          if (probed && probed.speakerUid) {
            speakers.set(probed.speakerUid, {
              speakerUid: probed.speakerUid,
              name: dev.name || `Nanit Sound + Light`,
              ipAddress: probed.ip,
            });
          }
        }
      }
    }

    // 2. Cloud discovery via /babies and /babies/{uid}/candidates/speakers
    try {
      const access = await this.getAccessToken(false);
      const babiesResp = await fetch(`${BASE_URL}/babies`, {
        method: 'GET',
        headers: {
          ...NANIT_API_HEADERS,
          Authorization: access,
        },
      });
      if (babiesResp.ok) {
        const body = await babiesResp.json();
        const babies = Array.isArray(body.babies) ? body.babies : [];
        for (const baby of babies) {
          const spk = baby && baby.speaker && baby.speaker.speaker;
          if (spk && spk.uid) {
            const existing = speakers.get(spk.uid) || {};
            speakers.set(spk.uid, {
              speakerUid: spk.uid,
              name: existing.name || (baby.name ? `${baby.name} Sound + Light` : 'Nanit Sound + Light'),
              ipAddress: existing.ipAddress || null,
            });
          }
          if (baby && baby.uid) {
            try {
              const candResp = await fetch(`${BASE_URL}/babies/${baby.uid}/candidates/speakers`, {
                method: 'GET',
                headers: {
                  ...NANIT_API_HEADERS,
                  Authorization: access,
                },
              });
              if (candResp.ok) {
                const candBody = await candResp.json();
                for (const row of candBody.speakers || []) {
                  if (row && row.uid) {
                    const existing = speakers.get(row.uid) || {};
                    speakers.set(row.uid, {
                      speakerUid: row.uid,
                      name: existing.name || row.name || 'Nanit Sound + Light',
                      ipAddress: existing.ipAddress || null,
                    });
                  }
                }
              }
            } catch {
              // ignore candidate lookup errors
            }
          }
        }
      }
    } catch (err) {
      this.log.debug(`Cloud /babies speaker lookup skipped/failed: ${err.message}`);
    }

    // 3. Cloud discovery via NanitLite /speakers endpoint
    try {
      const access = await this.getAccessToken(false);
      const spkResp = await fetch(`${BASE_URL}/speakers`, {
        method: 'GET',
        headers: {
          ...NANIT_LITE_HEADERS,
          authorization: `token ${access}`,
        },
      });
      if (spkResp.ok) {
        const body = await spkResp.json();
        const list = Array.isArray(body) ? body : body.speakers || [];
        for (const row of list) {
          const uid = row && (row.uid || (row.speaker && row.speaker.uid));
          if (uid) {
            const existing = speakers.get(uid) || {};
            speakers.set(uid, {
              speakerUid: uid,
              name: existing.name || row.name || 'Nanit Sound + Light',
              ipAddress: existing.ipAddress || null,
            });
          }
        }
      }
    } catch {
      // ignore
    }

    // 4. Local LAN TLS scan on port 442 (finds both standalone speakers & resolves local IPs!)
    try {
      const lanMap = await scanLanForSpeakers(this.log);
      for (const [uid, ip] of lanMap.entries()) {
        const existing = speakers.get(uid) || {};
        speakers.set(uid, {
          speakerUid: uid,
          name: existing.name || 'Nanit Sound + Light',
          ipAddress: existing.ipAddress || ip,
        });
      }
    } catch (err) {
      this.log.debug(`LAN scan error: ${err.message}`);
    }

    return Array.from(speakers.values());
  }
}

module.exports = {
  NanitApiClient,
  probeSpeakerUidFromTls,
  scanLanForSpeakers,
};
