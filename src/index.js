'use strict';

const { NanitApiClient } = require('./nanitApi');
const { NanitSoundLightClient } = require('./soundLightClient');
const { NanitSoundLightAccessory } = require('./platformAccessory');

const PLUGIN_NAME = 'homebridge-nanit-sound-light';
const PLATFORM_NAME = 'NanitSoundLight';

class NanitSoundLightPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;

    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;

    this.accessories = new Map(); // uuid -> PlatformAccessory
    this.clients = new Map(); // speakerUid -> NanitSoundLightClient

    if (!config) {
      this.log.warn('No configuration found for NanitSoundLight platform.');
      return;
    }

    this.nanitApi = new NanitApiClient({
      log: this.log,
      storagePath: this.api.user.storagePath(),
      config: this.config,
    });

    this.api.on('didFinishLaunching', () => {
      this.discoverDevices().catch((err) => {
        this.log.error(`Failed to initialize Nanit Sound + Light platform: ${err.message}`);
      });
    });

    this.api.on('shutdown', () => {
      for (const client of this.clients.values()) {
        client.stop();
      }
    });
  }

  configureAccessory(accessory) {
    this.log.info(`Loading cached accessory: ${accessory.displayName}`);
    this.accessories.set(accessory.UUID, accessory);
  }

  async discoverDevices() {
    try {
      await this.nanitApi.ensureAuthenticated();
    } catch (err) {
      if (err.code === 'MFA_REQUIRED') {
        this.log.warn('====================================================================');
        this.log.warn('NANIT 2FA VERIFICATION CODE SENT!');
        this.log.warn('Check your email or SMS for the Nanit verification code, put it in');
        this.log.warn('your Homebridge config under "mfaCode", and restart Homebridge.');
        this.log.warn('====================================================================');
        return;
      }
      this.log.error(`Nanit authentication error: ${err.message}`);
      return;
    }

    const speakers = await this.nanitApi.discoverSpeakers();
    if (speakers.length === 0) {
      this.log.warn(
        'No Nanit Sound + Light machines were discovered via Cloud or LAN. You can specify them manually under "devices" in config.json.'
      );
      return;
    }

    for (const spk of speakers) {
      const uuid = this.api.hap.uuid.generate(`nanit-sl-${spk.speakerUid}`);
      const existingAccessory = this.accessories.get(uuid);

      const client = new NanitSoundLightClient({
        speakerUid: spk.speakerUid,
        name: spk.name || 'Nanit Sound + Light',
        ipAddress: spk.ipAddress || null,
        api: this.nanitApi,
        log: this.log,
      });
      this.clients.set(spk.speakerUid, client);

      if (existingAccessory) {
        this.log.info(
          `Restoring existing Nanit Sound + Light accessory: ${spk.name} (${spk.speakerUid}${spk.ipAddress ? ` @ ${spk.ipAddress}` : ''})`
        );
        existingAccessory.context.device = spk;
        this.api.updatePlatformAccessories([existingAccessory]);
        new NanitSoundLightAccessory(this, existingAccessory, client);
      } else {
        this.log.info(
          `Adding new Nanit Sound + Light accessory: ${spk.name} (${spk.speakerUid}${spk.ipAddress ? ` @ ${spk.ipAddress}` : ''})`
        );
        const accessory = new this.api.platformAccessory(spk.name || 'Nanit Sound + Light', uuid);
        accessory.context.device = spk;
        new NanitSoundLightAccessory(this, accessory, client);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.set(uuid, accessory);
      }

      client.start();
    }
  }
}

module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, NanitSoundLightPlatform);
};

module.exports.NanitSoundLightPlatform = NanitSoundLightPlatform;
module.exports.PLUGIN_NAME = PLUGIN_NAME;
module.exports.PLATFORM_NAME = PLATFORM_NAME;
