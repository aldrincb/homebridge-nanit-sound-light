'use strict';

/**
 * HomeKit Accessory wrapper for a Nanit Sound + Light machine.
 *
 * Services exposed:
 *   1. AccessoryInformation (Manufacturer: Nanit, Model: Sound + Light, Serial: <speakerUid>)
 *   2. Night Light (Service.Lightbulb) -> On, Brightness (0-100%), Hue (0-360°), Saturation (0-100%)
 *   3. Sound Machine (Service.Fanv2 by default, or Service.Lightbulb / Service.Switch) -> Active/On + RotationSpeed/Brightness mapped to Volume (0-100%)
 *   4. Clock Display (Service.Switch, optional) -> On/Off
 *   5. Temperature Sensor (Service.TemperatureSensor, optional) -> CurrentTemperature (°C)
 *   6. Humidity Sensor (Service.HumiditySensor, optional) -> CurrentRelativeHumidity (%)
 *   7. Battery Service (Service.Battery, optional) -> BatteryLevel, ChargingState, StatusLowBattery
 *   8. Track Switches (Service.Switch per configured track, optional)
 */
class NanitSoundLightAccessory {
  constructor(platform, accessory, client) {
    this.platform = platform;
    this.accessory = accessory;
    this.client = client;
    this.log = platform.log;
    this.config = platform.config;

    const { Service, Characteristic } = this.platform;

    // 1. Accessory Information
    this.infoService =
      this.accessory.getService(Service.AccessoryInformation) ||
      this.accessory.addService(Service.AccessoryInformation);

    this.infoService
      .setCharacteristic(Characteristic.Manufacturer, 'Nanit')
      .setCharacteristic(Characteristic.Model, 'Sound + Light')
      .setCharacteristic(Characteristic.SerialNumber, this.client.speakerUid)
      .setCharacteristic(Characteristic.FirmwareRevision, this.client.state.firmwareVersion || '1.3.1');

    // 2. Night Light (Primary Service.Lightbulb)
    this.lightService =
      this.accessory.getService('Night Light') ||
      this.accessory.getService(Service.Lightbulb) ||
      this.accessory.addService(Service.Lightbulb, 'Night Light', 'night-light');

    this.lightService.setCharacteristic(Characteristic.Name, 'Night Light');
    if (typeof this.lightService.setPrimaryService === 'function') {
      this.lightService.setPrimaryService(true);
    }

    this.lightService
      .getCharacteristic(Characteristic.On)
      .onGet(() => Boolean(this.client.state.lightOn))
      .onSet((value) => {
        this.client.setLightOn(Boolean(value));
      });

    this.lightService
      .getCharacteristic(Characteristic.Brightness)
      .onGet(() => this.client.state.brightness)
      .onSet((value) => {
        this.client.setLightBrightness(Number(value));
      });

    this.lightService
      .getCharacteristic(Characteristic.Hue)
      .onGet(() => this.client.state.hue)
      .onSet((value) => {
        this.client.setLightHue(Number(value));
      });

    this.lightService
      .getCharacteristic(Characteristic.Saturation)
      .onGet(() => this.client.state.saturation)
      .onSet((value) => {
        this.client.setLightSaturation(Number(value));
      });

    // 3. Sound Machine Control (Default: Fanv2 so Apple Home shows On/Off + 0-100% Volume slider cleanly)
    const exposeSound = this.config.exposeSound !== false;
    const soundControlType = (this.config.soundControlType || 'fan').toLowerCase();

    this._cleanupUnusedSoundServices(exposeSound ? soundControlType : 'none');

    if (exposeSound) {
      if (soundControlType === 'lightbulb') {
        this.soundService =
          this.accessory.getServiceById(Service.Lightbulb, 'sound-machine') ||
          this.accessory.addService(Service.Lightbulb, 'Sound Machine', 'sound-machine');
        this.soundService.setCharacteristic(Characteristic.Name, 'Sound Machine');

        this.soundService
          .getCharacteristic(Characteristic.On)
          .onGet(() => Boolean(this.client.state.soundOn))
          .onSet((value) => {
            this.client.setSoundOn(Boolean(value));
          });

        this.soundService
          .getCharacteristic(Characteristic.Brightness)
          .onGet(() => this.client.state.volume)
          .onSet((value) => {
            this.client.setVolume(Number(value));
          });
      } else if (soundControlType === 'switch') {
        this.soundService =
          this.accessory.getServiceById(Service.Switch, 'sound-machine') ||
          this.accessory.addService(Service.Switch, 'Sound Machine', 'sound-machine');
        this.soundService.setCharacteristic(Characteristic.Name, 'Sound Machine');

        this.soundService
          .getCharacteristic(Characteristic.On)
          .onGet(() => Boolean(this.client.state.soundOn))
          .onSet((value) => {
            this.client.setSoundOn(Boolean(value));
          });
      } else {
        // Default: Service.Fanv2 (Active = Sound On/Off, RotationSpeed = Volume 0-100%)
        this.soundService =
          this.accessory.getServiceById(Service.Fanv2, 'sound-machine') ||
          this.accessory.getService(Service.Fanv2) ||
          this.accessory.addService(Service.Fanv2, 'Sound Machine', 'sound-machine');
        this.soundService.setCharacteristic(Characteristic.Name, 'Sound Machine');

        this.soundService
          .getCharacteristic(Characteristic.Active)
          .onGet(() =>
            this.client.state.soundOn
              ? Characteristic.Active.ACTIVE
              : Characteristic.Active.INACTIVE
          )
          .onSet((value) => {
            const on = value === Characteristic.Active.ACTIVE || value === 1 || value === true;
            this.client.setSoundOn(on);
          });

        this.soundService
          .getCharacteristic(Characteristic.RotationSpeed)
          .onGet(() => this.client.state.volume)
          .onSet((value) => {
            this.client.setVolume(Number(value));
          });
      }
    }

    // 4. Clock Display Switch (optional, default true)
    if (this.config.exposeClockSwitch !== false) {
      this.clockService =
        this.accessory.getServiceById(Service.Switch, 'clock-display') ||
        this.accessory.addService(Service.Switch, 'Clock Display', 'clock-display');
      this.clockService.setCharacteristic(Characteristic.Name, 'Clock Display');

      this.clockService
        .getCharacteristic(Characteristic.On)
        .onGet(() => Boolean(this.client.state.clockEnabled))
        .onSet((value) => {
          this.client.setClockEnabled(Boolean(value));
        });
    } else {
      const oldClock = this.accessory.getServiceById(Service.Switch, 'clock-display');
      if (oldClock) this.accessory.removeService(oldClock);
    }

    // 5. Temperature & Humidity Sensors (optional, default true)
    if (this.config.exposeSensors !== false) {
      this.tempService =
        this.accessory.getService(Service.TemperatureSensor) ||
        this.accessory.addService(Service.TemperatureSensor, 'Temperature', 'temperature');
      this.tempService.setCharacteristic(Characteristic.Name, 'Temperature');
      this.tempService
        .getCharacteristic(Characteristic.CurrentTemperature)
        .setProps({ minValue: -20, maxValue: 60 })
        .onGet(() => (this.client.state.temperature !== null ? this.client.state.temperature : 20));

      this.humidityService =
        this.accessory.getService(Service.HumiditySensor) ||
        this.accessory.addService(Service.HumiditySensor, 'Humidity', 'humidity');
      this.humidityService.setCharacteristic(Characteristic.Name, 'Humidity');
      this.humidityService
        .getCharacteristic(Characteristic.CurrentRelativeHumidity)
        .onGet(() => (this.client.state.humidity !== null ? this.client.state.humidity : 50));

      this.batteryService =
        this.accessory.getService(Service.Battery) ||
        this.accessory.addService(Service.Battery, 'Battery', 'battery');
      this.batteryService
        .getCharacteristic(Characteristic.BatteryLevel)
        .onGet(() => (this.client.state.batteryPercent !== null ? this.client.state.batteryPercent : 100));
      this.batteryService
        .getCharacteristic(Characteristic.ChargingState)
        .onGet(() =>
          this.client.state.batteryCharging
            ? Characteristic.ChargingState.CHARGING
            : Characteristic.ChargingState.NOT_CHARGING
        );
      this.batteryService
        .getCharacteristic(Characteristic.StatusLowBattery)
        .onGet(() =>
          this.client.state.batteryPercent !== null && this.client.state.batteryPercent <= 10
            ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
            : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
        );
    } else {
      for (const svcType of [Service.TemperatureSensor, Service.HumiditySensor, Service.Battery]) {
        const existing = this.accessory.getService(svcType);
        if (existing) this.accessory.removeService(existing);
      }
    }

    // 6. Optional Per-Track Switches
    this.trackServices = new Map();
    if (this.config.exposeTrackSwitches) {
      const tracks = Array.isArray(this.config.tracks) && this.config.tracks.length > 0
        ? this.config.tracks
        : ['White Noise', 'Waves', 'Rain', 'Wind', 'Lullaby 1'];
      for (const track of tracks) {
        const subType = `track-${track.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
        const svc =
          this.accessory.getServiceById(Service.Switch, subType) ||
          this.accessory.addService(Service.Switch, `Sound: ${track}`, subType);
        svc.setCharacteristic(Characteristic.Name, `Sound: ${track}`);
        svc
          .getCharacteristic(Characteristic.On)
          .onGet(() => Boolean(this.client.state.soundOn && this.client.state.currentTrack === track))
          .onSet((value) => {
            if (value) {
              this.client.setSoundTrack(track);
            } else if (this.client.state.currentTrack === track) {
              this.client.setSoundOn(false);
            }
          });
        this.trackServices.set(track, svc);
      }
    }

    // Subscribe to real-time updates from the WebSocket client
    this.client.on('stateChanged', (state) => this._updateHomeKitState(state));
  }

  _cleanupUnusedSoundServices(activeType) {
    const { Service } = this.platform;
    if (activeType !== 'fan') {
      const fan =
        this.accessory.getServiceById(Service.Fanv2, 'sound-machine') ||
        this.accessory.getService(Service.Fanv2);
      if (fan) this.accessory.removeService(fan);
    }
    if (activeType !== 'lightbulb') {
      const lb = this.accessory.getServiceById(Service.Lightbulb, 'sound-machine');
      if (lb) this.accessory.removeService(lb);
    }
    if (activeType !== 'switch') {
      const sw = this.accessory.getServiceById(Service.Switch, 'sound-machine');
      if (sw) this.accessory.removeService(sw);
    }
  }

  _updateHomeKitState(state) {
    const { Characteristic } = this.platform;

    if (state.firmwareVersion) {
      this.infoService.updateCharacteristic(Characteristic.FirmwareRevision, state.firmwareVersion);
    }

    // Update Night Light
    if (this.lightService) {
      this.lightService.updateCharacteristic(Characteristic.On, Boolean(state.lightOn));
      this.lightService.updateCharacteristic(Characteristic.Brightness, state.brightness);
      this.lightService.updateCharacteristic(Characteristic.Hue, state.hue);
      this.lightService.updateCharacteristic(Characteristic.Saturation, state.saturation);
    }

    // Update Sound Machine
    if (this.soundService) {
      const soundControlType = (this.config.soundControlType || 'fan').toLowerCase();
      if (soundControlType === 'lightbulb') {
        this.soundService.updateCharacteristic(Characteristic.On, Boolean(state.soundOn));
        this.soundService.updateCharacteristic(Characteristic.Brightness, state.volume);
      } else if (soundControlType === 'switch') {
        this.soundService.updateCharacteristic(Characteristic.On, Boolean(state.soundOn));
      } else {
        this.soundService.updateCharacteristic(
          Characteristic.Active,
          state.soundOn ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE
        );
        this.soundService.updateCharacteristic(Characteristic.RotationSpeed, state.volume);
      }
    }

    // Update Clock Display
    if (this.clockService) {
      this.clockService.updateCharacteristic(Characteristic.On, Boolean(state.clockEnabled));
    }

    // Update Sensors
    if (this.tempService && state.temperature !== null) {
      this.tempService.updateCharacteristic(Characteristic.CurrentTemperature, state.temperature);
    }
    if (this.humidityService && state.humidity !== null) {
      this.humidityService.updateCharacteristic(
        Characteristic.CurrentRelativeHumidity,
        state.humidity
      );
    }
    if (this.batteryService && state.batteryPercent !== null) {
      this.batteryService.updateCharacteristic(Characteristic.BatteryLevel, state.batteryPercent);
      this.batteryService.updateCharacteristic(
        Characteristic.ChargingState,
        state.batteryCharging
          ? Characteristic.ChargingState.CHARGING
          : Characteristic.ChargingState.NOT_CHARGING
      );
      this.batteryService.updateCharacteristic(
        Characteristic.StatusLowBattery,
        state.batteryPercent <= 10
          ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
      );
    }

    // Update Track Switches
    for (const [track, svc] of this.trackServices.entries()) {
      svc.updateCharacteristic(
        Characteristic.On,
        Boolean(state.soundOn && state.currentTrack === track)
      );
    }
  }
}

module.exports = {
  NanitSoundLightAccessory,
};
