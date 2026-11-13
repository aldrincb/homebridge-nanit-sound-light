'use strict';

const EventEmitter = require('events');
const crypto = require('crypto');
const WebSocket = require('ws');
const {
  SOC_TO_PERCENT,
  DeviceStatus,
  encodeMessage,
  decodeMessage,
} = require('./protobuf');

const NO_SOUND = 'No sound';

const COMMAND_COALESCE_MS = 150;
const COMMAND_PIN_MS = 30_000;
const COMMAND_ACK_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 20_000;
const POLL_INTERVAL_MS = 30_000;

function fround(val) {
  return typeof val === 'number' ? Math.fround(val) : val;
}

function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

/**
 * High-level client for a single Nanit Sound + Light device.
 *
 * Maintains dual WebSocket connections:
 *   1. Local LAN (`wss://<ip_or_mdns>:442`) with `Authorization: token <device_udtoken>`
 *   2. Cloud Relay (`wss://remote.nanit.com/speakers/<uid>/user_connect/`) with `Authorization: token <access_token>`
 *
 * Implements:
 *   - Prefer-local routing with instant cloud fallback
 *   - Single command in-flight lock with 10s ack timeout and NO re-send on timeout
 *   - 150ms command coalescing into a single combined `Settings` write
 *   - 30s float32-aware pin-guard to suppress stale device state echoes
 *   - Validated light semantics (firmware 1.3.1): `brightness: 0` for off, explicit hue/saturation restore on turn-on
 */
class NanitSoundLightClient extends EventEmitter {
  constructor({ speakerUid, name, ipAddress, api, log }) {
    super();
    this.speakerUid = speakerUid;
    this.name = name || 'Nanit Sound + Light';
    this.ipAddress = ipAddress || null;
    this.api = api;
    this.log = log;

    this.stopped = false;
    this.messageId = 0;
    this.sessionId = crypto.randomBytes(16).toString('hex');

    // WebSockets keyed by transport ('local' | 'cloud')
    this.sockets = { local: null, cloud: null };
    this.attached = { local: false, cloud: false };
    this.reconnectTimers = { local: null, cloud: null };
    this.pingIntervals = { local: null, cloud: null };
    this.backoffAttempts = { local: 0, cloud: 0 };
    this.deviceToken = null;

    // Single in-flight command queue
    this._sendChain = Promise.resolve();
    this._pendingAck = null; // { requestId, resolve, reject, timer }

    // Coalescing & pin-guard
    this._pendingCommands = {};
    this._coalesceTimer = null;
    this._pinnedFields = new Map(); // field -> { value, expiresAt }

    // Device state (normalized)
    this.state = {
      isOn: false,
      lightOn: false,
      brightness: 100, // 0-100%
      hue: 30, // 0-360 deg (default warm night light)
      saturation: 80, // 0-100%
      noColor: false,
      soundOn: false,
      currentTrack: NO_SOUND,
      availableTracks: [
        'White Noise',
        'Waves',
        'Rain',
        'Wind',
        'Birds',
        'Lullaby 1',
        'Lullaby 2',
      ],
      volume: 50, // 0-100%
      clockEnabled: false,
      clockBrightness: 4, // 0-8
      temperature: null, // Celsius
      humidity: null, // %
      batteryPercent: null, // 10, 25, 50, 75, 90
      batteryCharging: false,
      firmwareVersion: '1.3.1',
      wifiSsid: null,
      wifiRssi: null,
    };

    // Remembered values for restore
    this._lastBrightnessUnit = 0.5;
    this._lastHueUnit = 30 / 360;
    this._lastSaturationUnit = 0.8;
    this._lastTrack = 'White Noise';

    this._pollInterval = null;
    this._lastQueryTime = 0;
    this._loggedInitialState = false;
  }

  start() {
    this.stopped = false;
    this._connectLocal();
    this._connectCloud();

    this._pollInterval = setInterval(() => {
      if (!this.stopped) {
        this.requestFullState().catch((err) => {
          this.log.debug(`[${this.name}] Periodic state poll error: ${err.message}`);
        });
      }
    }, POLL_INTERVAL_MS);
  }

  stop() {
    this.stopped = true;
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
    if (this._coalesceTimer) {
      clearTimeout(this._coalesceTimer);
      this._coalesceTimer = null;
    }
    for (const transport of ['local', 'cloud']) {
      if (this.reconnectTimers[transport]) {
        clearTimeout(this.reconnectTimers[transport]);
        this.reconnectTimers[transport] = null;
      }
      if (this.pingIntervals[transport]) {
        clearInterval(this.pingIntervals[transport]);
        this.pingIntervals[transport] = null;
      }
      if (this.sockets[transport]) {
        try {
          this.sockets[transport].terminate();
        } catch {
          // ignore
        }
        this.sockets[transport] = null;
      }
      this.attached[transport] = false;
    }
    if (this._pendingAck) {
      clearTimeout(this._pendingAck.timer);
      this._pendingAck.reject(new Error('Client stopped'));
      this._pendingAck = null;
    }
  }

  isConnected() {
    return (
      (this._isSocketOpen('local') && this.attached.local) ||
      (this._isSocketOpen('cloud') && this.attached.cloud)
    );
  }

  _isSocketOpen(transport) {
    const ws = this.sockets[transport];
    return Boolean(ws && ws.readyState === WebSocket.OPEN);
  }

  _selectTransport() {
    if (this._isSocketOpen('local') && this.attached.local) {
      return 'local';
    }
    if (this._isSocketOpen('cloud') && this.attached.cloud) {
      return 'cloud';
    }
    if (this._isSocketOpen('local')) {
      return 'local';
    }
    if (this._isSocketOpen('cloud')) {
      return 'cloud';
    }
    return null;
  }

  async _connectLocal() {
    if (this.stopped || this._isSocketOpen('local')) return;

    const host = this.ipAddress || `Nanit-${this.speakerUid}.local`;
    try {
      if (!this.deviceToken) {
        this.deviceToken = await this.api.getDeviceToken(this.speakerUid);
      }
    } catch (err) {
      this.log.debug(`[${this.name}] Could not fetch local device token yet (${err.message}); will retry`);
      this._scheduleReconnect('local', 15_000);
      return;
    }

    const url = `wss://${host}:442`;
    this.log.debug(`[${this.name}] Connecting to local WebSocket ${url}...`);

    const ws = new WebSocket(url, {
      headers: {
        Authorization: `token ${this.deviceToken}`,
      },
      rejectUnauthorized: false,
      servername: `Nanit-${this.speakerUid}.local`,
      handshakeTimeout: 8000,
    });

    this._bindWebSocket('local', ws);
  }

  async _connectCloud() {
    if (this.stopped || this._isSocketOpen('cloud')) return;

    let accessToken;
    try {
      accessToken = await this.api.getAccessToken(false);
    } catch (err) {
      this.log.debug(`[${this.name}] Could not fetch cloud access token yet (${err.message}); will retry`);
      this._scheduleReconnect('cloud', 15_000);
      return;
    }

    const url = `wss://remote.nanit.com/speakers/${this.speakerUid}/user_connect/`;
    this.log.debug(`[${this.name}] Connecting to cloud relay WebSocket ${url}...`);

    const ws = new WebSocket(url, {
      headers: {
        Authorization: `token ${accessToken}`,
      },
      handshakeTimeout: 10000,
    });

    this._bindWebSocket('cloud', ws);
  }

  _bindWebSocket(transport, ws) {
    this.sockets[transport] = ws;

    ws.on('open', () => {
      this.backoffAttempts[transport] = 0;
      // Direct LAN connection talks directly to the speaker; mark attached immediately
      if (transport === 'local') {
        this.attached.local = true;
      }
      this.log.info(
        `[${this.name}] Connected via ${transport === 'local' ? `Local LAN (${this.ipAddress || `Nanit-${this.speakerUid}.local`}:442)` : 'Nanit Cloud Relay'}`
      );

      if (this.pingIntervals[transport]) {
        clearInterval(this.pingIntervals[transport]);
      }
      this.pingIntervals[transport] = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.ping();
          } catch {
            // ignore
          }
        }
      }, PING_INTERVAL_MS);

      // Prime initial state over this socket
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          this._sendInitialQueries(ws);
        }
      }, 300);
    });

    ws.on('message', (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      this._handleProtobufMessage(transport, buf);
    });

    ws.on('unexpected-response', (_req, res) => {
      const status = res ? res.statusCode : 0;
      this.log.debug(`[${this.name}] WebSocket (${transport}) HTTP ${status}`);
      if (status === 401 || status === 403) {
        if (transport === 'local') {
          this.deviceToken = null;
        } else {
          this.api.getAccessToken(true).catch(() => {});
        }
      }
      try {
        ws.terminate();
      } catch {
        // ignore
      }
    });

    ws.on('error', (err) => {
      this.log.debug(`[${this.name}] WebSocket (${transport}) error: ${err.message}`);
    });

    ws.on('close', () => {
      if (this.pingIntervals[transport]) {
        clearInterval(this.pingIntervals[transport]);
        this.pingIntervals[transport] = null;
      }
      if (this.sockets[transport] === ws) {
        this.sockets[transport] = null;
      }
      this.attached[transport] = false;
      if (!this.stopped) {
        this._scheduleReconnect(transport);
      }
    });
  }

  _scheduleReconnect(transport, overrideDelayMs) {
    if (this.stopped || this.reconnectTimers[transport]) return;
    const attempt = this.backoffAttempts[transport]++;
    const baseDelay = overrideDelayMs || Math.min(60_000, 2000 * Math.pow(2, Math.min(attempt, 5)));
    const jitter = Math.floor(Math.random() * 1000);
    const delay = baseDelay + jitter;

    this.reconnectTimers[transport] = setTimeout(() => {
      this.reconnectTimers[transport] = null;
      if (transport === 'local') {
        this._connectLocal();
      } else {
        this._connectCloud();
      }
    }, delay);
  }

  _nextMessageId() {
    this.messageId = (this.messageId % 2_000_000_000) + 1;
    return this.messageId;
  }

  _sendInitialQueries(ws) {
    const now = Date.now();
    if (now - this._lastQueryTime < 2500) {
      return;
    }
    this._lastQueryTime = now;

    try {
      // 1. GetSettings (all + clock + temperature + humidity + savedSounds)
      const settingsMsg = encodeMessage({
        request: {
          id: this._nextMessageId(),
          sessionId: this.sessionId,
          getSettings: {
            all: true,
            savedSounds: true,
            temperature: true,
            humidity: true,
            clock: true,
          },
        },
      });
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(settingsMsg);
      }

      // Space out GetStatus and Firmware so the ESP32 never sees back-to-back burst frames
      setTimeout(() => {
        if (this.stopped || ws.readyState !== WebSocket.OPEN) return;
        const statusMsg = encodeMessage({
          request: {
            id: this._nextMessageId(),
            sessionId: this.sessionId,
            getStatus: {
              all: true,
            },
          },
        });
        ws.send(statusMsg);
      }, 600);

      setTimeout(() => {
        if (this.stopped || ws.readyState !== WebSocket.OPEN) return;
        const fwMsg = encodeMessage({
          request: {
            id: this._nextMessageId(),
            sessionId: this.sessionId,
            firmware: {
              info: true,
            },
          },
        });
        ws.send(fwMsg);
      }, 1200);
    } catch (err) {
      this.log.debug(`[${this.name}] Initial query send error: ${err.message}`);
    }
  }

  async requestFullState() {
    const transport = this._selectTransport();
    if (!transport) {
      if (!this._isSocketOpen('local')) this._connectLocal();
      if (!this._isSocketOpen('cloud')) this._connectCloud();
      return;
    }
    const ws = this.sockets[transport];
    if (ws && ws.readyState === WebSocket.OPEN) {
      this._sendInitialQueries(ws);
    }
  }

  // ---------------------------------------------------------------------------
  // Inbound Protobuf Handling
  // ---------------------------------------------------------------------------

  _handleProtobufMessage(transport, buf) {
    let msg;
    try {
      msg = decodeMessage(buf);
    } catch (err) {
      this.log.debug(`[${this.name}] Failed to decode protobuf (${transport}): ${err.message}`);
      return;
    }

    if (msg.backend) {
      const status = msg.backend.device && msg.backend.device.status;
      if (status === DeviceStatus.Connected) {
        const wasAttached = this.attached[transport];
        this.attached[transport] = true;
        if (!wasAttached && this.sockets[transport]) {
          this._sendInitialQueries(this.sockets[transport]);
        }
      }
      return;
    }

    if (msg.response) {
      this.attached[transport] = true;
      const resp = msg.response;

      // Resolve any waiting command ACK
      if (this._pendingAck && resp.requestId === this._pendingAck.requestId) {
        const pending = this._pendingAck;
        this._pendingAck = null;
        clearTimeout(pending.timer);
        if (resp.statusCode && resp.statusCode !== 0 && resp.statusCode !== 200) {
          pending.reject(
            new Error(`Device returned status ${resp.statusCode}: ${resp.statusMessage || ''}`)
          );
        } else {
          pending.resolve(resp);
        }
      }

      let changed = false;
      if (resp.status) {
        changed = this._ingestStatus(resp.status) || changed;
      }
      if (resp.settings) {
        changed = this._ingestSettings(resp.settings) || changed;
      }
      if (resp.firmware && resp.firmware.version) {
        const cleanVer = String(resp.firmware.version).replace(/[^\x20-\x7E]/g, '').trim();
        if (cleanVer && cleanVer !== this.state.firmwareVersion) {
          this.state.firmwareVersion = cleanVer;
          changed = true;
        }
      }
      if (resp.networkStatus && resp.networkStatus.currentAp) {
        const ap = resp.networkStatus.currentAp;
        if (ap.ssid) this.state.wifiSsid = ap.ssid;
        if (ap.rssi !== undefined) this.state.wifiRssi = ap.rssi;
      }

      if (changed) {
        if (!this._loggedInitialState && this.state.temperature !== null) {
          this._loggedInitialState = true;
          this.log.info(
            `[${this.name}] State synced: power=${this.state.isOn}, light=${this.state.lightOn} (${this.state.brightness}%), sound=${this.state.soundOn} (${this.state.currentTrack} @ ${this.state.volume}%), clock=${this.state.clockEnabled}, temp=${this.state.temperature}°C, humidity=${this.state.humidity}%${this.state.batteryPercent !== null ? `, battery=${this.state.batteryPercent}%` : ''}`
          );
        }
        this.emit('stateChanged', { ...this.state });
      }
      return;
    }

    if (msg.request) {
      this.attached[transport] = true;
      const req = msg.request;
      let changed = false;
      if (req.status) {
        changed = this._ingestStatus(req.status) || changed;
      }
      if (req.settings) {
        changed = this._ingestSettings(req.settings) || changed;
      }
      if (changed) {
        this.emit('stateChanged', { ...this.state });
      }
    }
  }

  _isPinnedContradiction(field, wireVal) {
    const pin = this._pinnedFields.get(field);
    if (!pin) return false;
    if (Date.now() >= pin.expiresAt) {
      this._pinnedFields.delete(field);
      return false;
    }
    const compWire = typeof wireVal === 'number' ? fround(wireVal) : wireVal;
    if (compWire === pin.value) {
      // Device confirmed our commanded value -> release pin early!
      this._pinnedFields.delete(field);
      return false;
    }
    return true;
  }

  _pinField(field, wireVal) {
    this._pinnedFields.set(field, {
      value: typeof wireVal === 'number' ? fround(wireVal) : wireVal,
      expiresAt: Date.now() + COMMAND_PIN_MS,
    });
  }

  _ingestStatus(status) {
    let changed = false;
    if (typeof status.temperature === 'number' && Number.isFinite(status.temperature)) {
      const t = Math.round(status.temperature * 10) / 10;
      if (this.state.temperature !== t) {
        this.state.temperature = t;
        changed = true;
      }
    }
    if (typeof status.humidity === 'number' && Number.isFinite(status.humidity)) {
      const h = clamp(Math.round(status.humidity), 0, 100);
      if (this.state.humidity !== h) {
        this.state.humidity = h;
        changed = true;
      }
    }
    if (status.battery) {
      if (status.battery.soc !== undefined && SOC_TO_PERCENT[status.battery.soc] !== undefined) {
        const pct = SOC_TO_PERCENT[status.battery.soc];
        if (this.state.batteryPercent !== pct) {
          this.state.batteryPercent = pct;
          changed = true;
        }
      }
      const charging = Boolean(status.battery.isCharging);
      if (this.state.batteryCharging !== charging) {
        this.state.batteryCharging = charging;
        changed = true;
      }
    }
    return changed;
  }

  _ingestSettings(settings) {
    let changed = false;

    if (typeof settings.isOn === 'boolean' && !this._isPinnedContradiction('isOn', settings.isOn)) {
      if (this.state.isOn !== settings.isOn) {
        this.state.isOn = settings.isOn;
        changed = true;
      }
    }

    if (
      typeof settings.brightness === 'number' &&
      Number.isFinite(settings.brightness) &&
      !this._isPinnedContradiction('brightness', settings.brightness)
    ) {
      const unit = clamp(settings.brightness, 0, 1);
      if (unit > 0) {
        this._lastBrightnessUnit = unit;
      }
      const pct = Math.round(unit * 100);
      if (this.state.brightness !== pct) {
        this.state.brightness = pct;
        changed = true;
      }
    }

    if (settings.color) {
      const noColor = Boolean(settings.color.noColor);
      if (!this._isPinnedContradiction('noColor', noColor)) {
        if (this.state.noColor !== noColor) {
          this.state.noColor = noColor;
          changed = true;
        }
      }
      if (
        typeof settings.color.hue === 'number' &&
        Number.isFinite(settings.color.hue) &&
        !this._isPinnedContradiction('hue', settings.color.hue)
      ) {
        const unit = clamp(settings.color.hue, 0, 1);
        this._lastHueUnit = unit;
        const deg = Math.round(unit * 360);
        if (this.state.hue !== deg) {
          this.state.hue = deg;
          changed = true;
        }
      }
      if (
        typeof settings.color.saturation === 'number' &&
        Number.isFinite(settings.color.saturation) &&
        !this._isPinnedContradiction('saturation', settings.color.saturation)
      ) {
        const unit = clamp(settings.color.saturation, 0, 1);
        this._lastSaturationUnit = unit;
        const pct = Math.round(unit * 100);
        if (this.state.saturation !== pct) {
          this.state.saturation = pct;
          changed = true;
        }
      }
    }

    // Recompute lightOn: lamp emits iff isOn && brightness > 0 && !noColor
    const computedLightOn = Boolean(
      this.state.isOn && this.state.brightness > 0 && !this.state.noColor
    );
    if (this.state.lightOn !== computedLightOn) {
      this.state.lightOn = computedLightOn;
      changed = true;
    }

    if (
      typeof settings.volume === 'number' &&
      Number.isFinite(settings.volume) &&
      !this._isPinnedContradiction('volume', settings.volume)
    ) {
      const unit = clamp(settings.volume, 0, 1);
      const pct = Math.round(unit * 100);
      if (this.state.volume !== pct) {
        this.state.volume = pct;
        changed = true;
      }
    }

    if (settings.sound) {
      const isNoSound = Boolean(settings.sound.noSound) || !settings.sound.track;
      const trackVal = isNoSound ? NO_SOUND : settings.sound.track;
      if (!this._isPinnedContradiction('sound', trackVal)) {
        const soundOn = Boolean(this.state.isOn && trackVal !== NO_SOUND);
        if (trackVal !== NO_SOUND) {
          this._lastTrack = trackVal;
        }
        if (this.state.soundOn !== soundOn || this.state.currentTrack !== trackVal) {
          this.state.soundOn = soundOn;
          this.state.currentTrack = trackVal;
          changed = true;
        }
      }
    } else if (!this.state.isOn && this.state.soundOn) {
      this.state.soundOn = false;
      changed = true;
    }

    if (settings.soundList && Array.isArray(settings.soundList.tracks) && settings.soundList.tracks.length > 0) {
      const clean = settings.soundList.tracks
        .map((t) => String(t).trim())
        .filter((t) => t.length > 0 && t !== NO_SOUND);
      if (clean.length > 0) {
        this.state.availableTracks = clean;
      }
    }

    if (settings.clock) {
      if (
        typeof settings.clock.isEnabled === 'boolean' &&
        !this._isPinnedContradiction('clockEnabled', settings.clock.isEnabled)
      ) {
        if (this.state.clockEnabled !== settings.clock.isEnabled) {
          this.state.clockEnabled = settings.clock.isEnabled;
          changed = true;
        }
      }
      if (
        typeof settings.clock.brightness === 'number' &&
        !this._isPinnedContradiction('clockBrightness', settings.clock.brightness)
      ) {
        const cb = clamp(Math.round(settings.clock.brightness), 0, 8);
        if (this.state.clockBrightness !== cb) {
          this.state.clockBrightness = cb;
          changed = true;
        }
      }
    }

    if (typeof settings.temperature === 'number' && Number.isFinite(settings.temperature)) {
      const t = Math.round(settings.temperature * 10) / 10;
      if (this.state.temperature !== t) {
        this.state.temperature = t;
        changed = true;
      }
    }

    if (typeof settings.humidity === 'number' && Number.isFinite(settings.humidity)) {
      const h = clamp(Math.round(settings.humidity), 0, 100);
      if (this.state.humidity !== h) {
        this.state.humidity = h;
        changed = true;
      }
    }

    return changed;
  }

  // ---------------------------------------------------------------------------
  // High-level HomeKit Control Methods (Coalesced)
  // ---------------------------------------------------------------------------

  setLightOn(on) {
    if (!on) {
      // Validated firmware 1.3.1 semantics: brightness 0 turns the lamp off while preserving stored color
      this.state.lightOn = false;
      this.state.brightness = 0;
      this._pinField('brightness', 0.0);
      this._queueSettings({ brightness: 0.0 });
      this.emit('stateChanged', { ...this.state });
      return;
    }

    const restoreBrightness = this._lastBrightnessUnit > 0 ? this._lastBrightnessUnit : 0.5;
    const patch = {
      isOn: true,
      brightness: restoreBrightness,
      color: {
        noColor: false,
        hue: this._lastHueUnit,
        saturation: this._lastSaturationUnit,
      },
    };
    // If the device was completely powered off, keep sound silent so turning on the night light doesn't start audio
    if (!this.state.isOn && !this.state.soundOn) {
      patch.sound = { noSound: true };
      this._pinField('sound', NO_SOUND);
    }

    this.state.isOn = true;
    this.state.lightOn = true;
    this.state.noColor = false;
    this.state.brightness = Math.round(restoreBrightness * 100);
    this._pinField('isOn', true);
    this._pinField('brightness', restoreBrightness);
    this._pinField('noColor', false);
    this._pinField('hue', this._lastHueUnit);
    this._pinField('saturation', this._lastSaturationUnit);

    this._queueSettings(patch);
    this.emit('stateChanged', { ...this.state });
  }

  setLightBrightness(percent) {
    const pct = clamp(Math.round(percent), 0, 100);
    const unit = pct / 100;
    if (unit > 0) {
      this._lastBrightnessUnit = unit;
    }
    this.state.brightness = pct;
    this.state.lightOn = pct > 0;
    this._pinField('brightness', unit);

    if (pct > 0 && !this.state.isOn) {
      this.state.isOn = true;
      this._pinField('isOn', true);
      this._queueSettings({
        isOn: true,
        brightness: unit,
        color: {
          noColor: false,
          hue: this._lastHueUnit,
          saturation: this._lastSaturationUnit,
        },
      });
    } else {
      this._queueSettings({ brightness: unit });
    }
    this.emit('stateChanged', { ...this.state });
  }

  setLightHue(degrees) {
    const deg = clamp(Math.round(degrees), 0, 360);
    const unit = deg / 360;
    this._lastHueUnit = unit;
    this.state.hue = deg;
    this.state.noColor = false;
    this._pinField('hue', unit);
    this._pinField('noColor', false);

    this._queueSettings({
      color: {
        noColor: false,
        hue: unit,
        saturation: this._lastSaturationUnit,
      },
    });
    this.emit('stateChanged', { ...this.state });
  }

  setLightSaturation(percent) {
    const pct = clamp(Math.round(percent), 0, 100);
    const unit = pct / 100;
    this._lastSaturationUnit = unit;
    this.state.saturation = pct;
    this.state.noColor = false;
    this._pinField('saturation', unit);
    this._pinField('noColor', false);

    this._queueSettings({
      color: {
        noColor: false,
        hue: this._lastHueUnit,
        saturation: unit,
      },
    });
    this.emit('stateChanged', { ...this.state });
  }

  setSoundOn(on) {
    if (!on) {
      this.state.soundOn = false;
      this.state.currentTrack = NO_SOUND;
      this._pinField('sound', NO_SOUND);
      this._queueSettings({ sound: { noSound: true } });
      this.emit('stateChanged', { ...this.state });
      return;
    }

    const track = this._lastTrack && this._lastTrack !== NO_SOUND ? this._lastTrack : 'White Noise';
    const patch = {
      isOn: true,
      sound: { track },
    };
    if (!this.state.isOn && !this.state.lightOn) {
      patch.brightness = 0.0;
      this._pinField('brightness', 0.0);
    }
    this.state.isOn = true;
    this.state.soundOn = true;
    this.state.currentTrack = track;
    this._pinField('isOn', true);
    this._pinField('sound', track);

    this._queueSettings(patch);
    this.emit('stateChanged', { ...this.state });
  }

  setSoundTrack(trackName) {
    if (!trackName || trackName === NO_SOUND) {
      this.setSoundOn(false);
      return;
    }
    this._lastTrack = trackName;
    this.state.isOn = true;
    this.state.soundOn = true;
    this.state.currentTrack = trackName;
    this._pinField('isOn', true);
    this._pinField('sound', trackName);

    this._queueSettings({
      isOn: true,
      sound: { track: trackName },
    });
    this.emit('stateChanged', { ...this.state });
  }

  setVolume(percent) {
    const pct = clamp(Math.round(percent), 0, 100);
    const unit = pct / 100;
    this.state.volume = pct;
    this._pinField('volume', unit);
    this._queueSettings({ volume: unit });
    this.emit('stateChanged', { ...this.state });
  }

  setClockEnabled(enabled) {
    const en = Boolean(enabled);
    this.state.clockEnabled = en;
    this._pinField('clockEnabled', en);
    this._queueSettings({
      clock: {
        isEnabled: en,
      },
    });
    this.emit('stateChanged', { ...this.state });
  }

  // ---------------------------------------------------------------------------
  // Command Coalescing & Single-In-Flight Dispatcher
  // ---------------------------------------------------------------------------

  _queueSettings(partialSettings) {
    // Deep-merge color, sound, clock sub-objects
    if (partialSettings.color) {
      this._pendingCommands.color = {
        ...(this._pendingCommands.color || {}),
        ...partialSettings.color,
      };
    }
    if (partialSettings.sound) {
      this._pendingCommands.sound = { ...partialSettings.sound };
    }
    if (partialSettings.clock) {
      this._pendingCommands.clock = {
        ...(this._pendingCommands.clock || {}),
        ...partialSettings.clock,
      };
    }
    for (const key of ['isOn', 'brightness', 'volume']) {
      if (partialSettings[key] !== undefined) {
        this._pendingCommands[key] = partialSettings[key];
      }
    }

    if (this._coalesceTimer) {
      clearTimeout(this._coalesceTimer);
    }
    this._coalesceTimer = setTimeout(() => {
      this._coalesceTimer = null;
      const batch = { ...this._pendingCommands };
      this._pendingCommands = {};
      this._enqueueSendSettings(batch);
    }, COMMAND_COALESCE_MS);
  }

  _enqueueSendSettings(settingsBatch) {
    this._sendChain = this._sendChain
      .then(() => this._sendSettingsSingleInFlight(settingsBatch))
      .catch((err) => {
        this.log.warn(`[${this.name}] Command failed: ${err.message}`);
      });
  }

  async _sendSettingsSingleInFlight(settingsBatch) {
    const transport = this._selectTransport();
    if (!transport) {
      throw new Error('No active WebSocket connection to Nanit Sound + Light');
    }
    const ws = this.sockets[transport];
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error(`WebSocket (${transport}) is not open`);
    }

    const requestId = this._nextMessageId();
    const wireBytes = encodeMessage({
      request: {
        id: requestId,
        sessionId: this.sessionId,
        settings: settingsBatch,
      },
    });

    this.log.debug(
      `[${this.name}] Sending Settings (#${requestId} via ${transport}): ${JSON.stringify(settingsBatch)}`
    );

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._pendingAck && this._pendingAck.requestId === requestId) {
          this._pendingAck = null;
        }
        // IMPORTANT: Do NOT re-send on timeout (prevents wedging the speaker)
        reject(new Error(`Command #${requestId} timed out after ${COMMAND_ACK_TIMEOUT_MS}ms`));
      }, COMMAND_ACK_TIMEOUT_MS);

      this._pendingAck = { requestId, resolve, reject, timer };

      ws.send(wireBytes, (err) => {
        if (err) {
          clearTimeout(timer);
          if (this._pendingAck && this._pendingAck.requestId === requestId) {
            this._pendingAck = null;
          }
          reject(err);
        }
      });
    });
  }
}

module.exports = {
  NanitSoundLightClient,
  NO_SOUND,
};
