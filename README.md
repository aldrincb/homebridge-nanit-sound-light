# homebridge-nanit-sound-light

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A complete **Homebridge** plugin for the **Nanit Sound + Light** machine (`L101` / `L151` series).

Even though the standalone Nanit Sound + Light machine connects to Google Home and the Nanit app, it has no official Apple HomeKit support or standalone Homebridge plugin. This plugin bridges the Nanit Sound + Light directly into Apple HomeKit using its native **Protobuf-over-WebSocket** protocol—preferring **direct local LAN (`wss://<ip>:442`)** for instant, low-latency response with automatic fallback to the **Nanit Cloud Relay (`wss://remote.nanit.com/speakers/<uid>/user_connect/`)**.

---

## Features

- **Dual Local LAN + Cloud Relay Transport:**
  - Automatically discovers your Nanit Sound + Light on your local network by inspecting TCP port `442` (`CN = Nanit-<speaker_uid>.local`) as well as your Nanit Cloud account (`/babies`, `/candidates/speakers`, and `/speakers`).
  - Fetches the local RS256 device token (`/speakers/<uid>/udtokens`) and connects directly to `wss://<ip>:442` on your LAN, while keeping the cloud relay ready as a backup.
- **RGBW Night Light (`Service.Lightbulb`):**
  - Full control of On/Off, Brightness (`0–100%`), Hue (`0–360°`), and Saturation (`0–100%`).
  - Implements firmware-validated color preservation (`brightness: 0` on turn-off so the lamp never resets to white on re-enable, and explicit hue/saturation restore on turn-on).
- **Sound Machine & Volume Control (`Service.Fanv2` / `Lightbulb` / `Switch`):**
  - Toggle White Noise / Lullabies On/Off and adjust Volume (`0–100%`) directly from Apple Home.
  - Optional individual switches for your favorite tracks (`White Noise`, `Waves`, `Rain`, `Wind`, `Birds`, `Lullaby 1`, etc.).
- **Built-in Room Sensors & Battery:**
  - **Temperature Sensor** (`°C` / `°F` in Apple Home)
  - **Humidity Sensor** (`%`)
  - **Battery Level & Charging Status** (`10%`, `25%`, `50%`, `75%`, `90%` + charging indicator)
- **Clock Display Switch:**
  - Toggle the digital clock display on/off from HomeKit scenes (e.g., bedtime automation).
- **Hardware-Safe Protocol Engine:**
  - Coalesces rapid HomeKit scene writes within a `150ms` window into a single combined `Settings` Protobuf frame.
  - Enforces a strict single-command-in-flight queue with no timeout re-sends (preventing firmware socket lockups) and a `30s` `float32` pin-guard to prevent stale device echoes from bouncing HomeKit sliders.

---

## Installation

```bash
npm install -g homebridge-nanit-sound-light
```

Or install directly from a local folder / GitHub repository inside your Homebridge directory (`/var/lib/homebridge`):

```bash
cd /var/lib/homebridge
npm install /path/to/homebridge-nanit-sound-light
```

---

## Configuration (`config.json`)

```json
{
  "platform": "NanitSoundLight",
  "name": "Nanit Sound + Light",
  "email": "your-email@example.com",
  "password": "your-nanit-password",
  "mfaCode": "",
  "soundControlType": "fan",
  "exposeSound": true,
  "exposeClockSwitch": true,
  "exposeSensors": true,
  "exposeTrackSwitches": false,
  "devices": [
    {
      "name": "Nursery Sound + Light",
      "speakerUid": "L101FSN0000000",
      "ipAddress": "192.168.1.50"
    }
  ]
}
```

### 2FA / MFA Login Flow
1. Enter your `email` and `password` in the plugin config and restart Homebridge.
2. If your Nanit account has 2FA enabled, Nanit will send a verification code to your email/phone and the plugin will cache the pending `mfaToken`.
3. Put the verification code in `"mfaCode"` in your config and restart Homebridge once.
4. Once authenticated, the plugin automatically saves and refreshes your `accessToken` and `refreshToken` in `<homebridgeStoragePath>/nanit-sound-light-tokens.json`.

---

## Credits & Protocol Acknowledgements

Special thanks to the open-source research by [@com6056/nanit-sound-light](https://github.com/com6056/nanit-sound-light) and [@wealthystudent/ha-nanit](https://github.com/wealthystudent/ha-nanit) for documenting the `sound_light.proto` schema and firmware 1.3.1 state behavior.

## License

MIT
