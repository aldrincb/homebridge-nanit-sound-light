'use strict';

/**
 * Pure JavaScript Protobuf (proto2) wire encoder & decoder for Nanit Sound + Light
 * (sound_light.proto). Zero external dependencies.
 *
 * Wire types:
 *   0 = Varint (int32, int64, uint32, uint64, sint32, sint64, bool, enum)
 *   1 = 64-bit (fixed64, sfixed64, double)
 *   2 = Length-delimited (string, bytes, embedded messages)
 *   5 = 32-bit (fixed32, sfixed32, float)
 */

const WIRE_VARINT = 0;
const WIRE_64BIT = 1;
const WIRE_LEN = 2;
const WIRE_32BIT = 5;

const StateOfCharge = {
  SoCLow: 0,
  SoC25: 1,
  SoC50: 2,
  SoC75: 3,
  SoC90: 4,
};

const SOC_TO_PERCENT = {
  0: 10,
  1: 25,
  2: 50,
  3: 75,
  4: 90,
};

const DeviceStatus = {
  Disconnected: 0,
  Connected: 1,
};

// ---------------------------------------------------------------------------
// Low-level Wire Writer
// ---------------------------------------------------------------------------

class ProtoWriter {
  constructor() {
    this.chunks = [];
  }

  writeVarint(value) {
    let v = BigInt(value);
    if (v < 0n) {
      v = (1n << 64n) + v;
    }
    const bytes = [];
    while (v >= 0x80n) {
      bytes.push(Number((v & 0x7fn) | 0x80n));
      v >>= 7n;
    }
    bytes.push(Number(v));
    this.chunks.push(Buffer.from(bytes));
  }

  writeTag(fieldNumber, wireType) {
    this.writeVarint((fieldNumber << 3) | wireType);
  }

  writeInt32(fieldNumber, value) {
    if (value === undefined || value === null) return;
    this.writeTag(fieldNumber, WIRE_VARINT);
    this.writeVarint(Math.trunc(value));
  }

  writeBool(fieldNumber, value) {
    if (value === undefined || value === null) return;
    this.writeTag(fieldNumber, WIRE_VARINT);
    this.writeVarint(value ? 1 : 0);
  }

  writeFloat(fieldNumber, value) {
    if (value === undefined || value === null) return;
    this.writeTag(fieldNumber, WIRE_32BIT);
    const buf = Buffer.allocUnsafe(4);
    buf.writeFloatLE(Number(value), 0);
    this.chunks.push(buf);
  }

  writeString(fieldNumber, value) {
    if (value === undefined || value === null) return;
    const strBuf = Buffer.from(String(value), 'utf8');
    this.writeTag(fieldNumber, WIRE_LEN);
    this.writeVarint(strBuf.length);
    this.chunks.push(strBuf);
  }

  writeBytes(fieldNumber, buf) {
    if (!buf) return;
    this.writeTag(fieldNumber, WIRE_LEN);
    this.writeVarint(buf.length);
    this.chunks.push(buf);
  }

  writeEmptyMessage(fieldNumber) {
    this.writeTag(fieldNumber, WIRE_LEN);
    this.writeVarint(0);
  }

  finish() {
    return Buffer.concat(this.chunks);
  }
}

// ---------------------------------------------------------------------------
// Low-level Wire Reader
// ---------------------------------------------------------------------------

class ProtoReader {
  constructor(buffer) {
    this.buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    this.pos = 0;
  }

  eof() {
    return this.pos >= this.buf.length;
  }

  readVarintBigInt() {
    let result = 0n;
    let shift = 0n;
    while (this.pos < this.buf.length) {
      const byte = this.buf[this.pos++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        return result;
      }
      shift += 7n;
      if (shift > 70n) {
        throw new Error('Protobuf varint too long');
      }
    }
    throw new Error('Unexpected EOF reading varint');
  }

  readInt32() {
    const v = this.readVarintBigInt();
    return Number(BigInt.asIntN(32, v));
  }

  readBool() {
    return this.readVarintBigInt() !== 0n;
  }

  readFloat() {
    if (this.pos + 4 > this.buf.length) {
      throw new Error('Unexpected EOF reading float');
    }
    const val = this.buf.readFloatLE(this.pos);
    this.pos += 4;
    return val;
  }

  readBytes() {
    const len = Number(this.readVarintBigInt());
    if (len < 0 || this.pos + len > this.buf.length) {
      throw new Error(`Invalid length-delimited field length: ${len}`);
    }
    const slice = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return slice;
  }

  readString() {
    return this.readBytes().toString('utf8');
  }

  readTag() {
    if (this.eof()) return null;
    const tag = Number(this.readVarintBigInt());
    return {
      fieldNumber: tag >>> 3,
      wireType: tag & 0x07,
    };
  }

  skipField(wireType) {
    switch (wireType) {
      case WIRE_VARINT:
        this.readVarintBigInt();
        break;
      case WIRE_64BIT:
        if (this.pos + 8 > this.buf.length) throw new Error('Unexpected EOF skipping 64-bit');
        this.pos += 8;
        break;
      case WIRE_LEN:
        this.readBytes();
        break;
      case WIRE_32BIT:
        if (this.pos + 4 > this.buf.length) throw new Error('Unexpected EOF skipping 32-bit');
        this.pos += 4;
        break;
      default:
        throw new Error(`Unsupported wire type: ${wireType}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Message Encoders (sound_light.proto)
// ---------------------------------------------------------------------------

function encodeColor(color) {
  const w = new ProtoWriter();
  if (color.noColor !== undefined) w.writeBool(1, color.noColor);
  if (color.hue !== undefined) w.writeFloat(2, color.hue);
  if (color.saturation !== undefined) w.writeFloat(3, color.saturation);
  return w.finish();
}

function encodeSound(sound) {
  const w = new ProtoWriter();
  if (sound.noSound !== undefined) w.writeBool(1, sound.noSound);
  if (sound.track !== undefined) w.writeString(2, sound.track);
  return w.finish();
}

function encodeClock(clock) {
  const w = new ProtoWriter();
  const enabled = clock.enabled !== undefined ? clock.enabled : clock.isEnabled;
  if (enabled !== undefined) w.writeBool(1, enabled);
  if (clock.use12hFormat !== undefined) w.writeBool(3, clock.use12hFormat);
  if (clock.brightness !== undefined) w.writeInt32(4, clock.brightness);
  return w.finish();
}

function encodeSettings(settings) {
  const w = new ProtoWriter();
  if (settings.brightness !== undefined) w.writeFloat(1, settings.brightness);
  if (settings.color !== undefined) w.writeBytes(2, encodeColor(settings.color));
  if (settings.volume !== undefined) w.writeFloat(3, settings.volume);
  if (settings.sound !== undefined) w.writeBytes(4, encodeSound(settings.sound));
  if (settings.isOn !== undefined) w.writeBool(5, settings.isOn);
  if (settings.temperature !== undefined) w.writeFloat(7, settings.temperature);
  if (settings.humidity !== undefined) w.writeFloat(8, settings.humidity);
  if (settings.clock !== undefined) w.writeBytes(11, encodeClock(settings.clock));
  return w.finish();
}

function encodeGetSettings(gs) {
  const w = new ProtoWriter();
  if (gs.all !== undefined) w.writeBool(1, gs.all);
  if (gs.savedSounds !== undefined) w.writeBool(7, gs.savedSounds);
  if (gs.temperature !== undefined) w.writeBool(8, gs.temperature);
  if (gs.humidity !== undefined) w.writeBool(9, gs.humidity);
  if (gs.clock !== undefined) w.writeBool(12, gs.clock);
  return w.finish();
}

function encodeGetStatus(gs) {
  const w = new ProtoWriter();
  if (gs.all !== undefined) w.writeBool(1, gs.all);
  if (gs.battery !== undefined) w.writeBool(2, gs.battery);
  if (gs.temperature !== undefined) w.writeBool(3, gs.temperature);
  if (gs.humidity !== undefined) w.writeBool(4, gs.humidity);
  return w.finish();
}

function encodeNetwork(net) {
  const w = new ProtoWriter();
  if (net.getStatus) w.writeEmptyMessage(8);
  return w.finish();
}

function encodeFirmware(fw) {
  const w = new ProtoWriter();
  if (fw.info) w.writeEmptyMessage(2);
  return w.finish();
}

function encodeRequest(req) {
  const w = new ProtoWriter();
  if (req.id !== undefined) w.writeInt32(1, req.id);
  if (req.network !== undefined) w.writeBytes(2, encodeNetwork(req.network));
  if (req.firmware !== undefined) w.writeBytes(3, encodeFirmware(req.firmware));
  if (req.getSettings !== undefined) w.writeBytes(5, encodeGetSettings(req.getSettings));
  if (req.settings !== undefined) w.writeBytes(6, encodeSettings(req.settings));
  if (req.getStatus !== undefined) w.writeBytes(11, encodeGetStatus(req.getStatus));
  if (req.sessionId !== undefined) w.writeString(200, req.sessionId);
  return w.finish();
}

function encodeMessage(msg) {
  const w = new ProtoWriter();
  if (msg.request !== undefined) {
    w.writeBytes(1, encodeRequest(msg.request));
  }
  return w.finish();
}

// ---------------------------------------------------------------------------
// Message Decoders (sound_light.proto) — with wireType guards on every field
// ---------------------------------------------------------------------------

function decodeColor(buf) {
  const r = new ProtoReader(buf);
  const out = {};
  while (!r.eof()) {
    const tag = r.readTag();
    if (!tag) break;
    if (tag.fieldNumber === 1 && tag.wireType === WIRE_VARINT) {
      out.noColor = r.readBool();
    } else if (tag.fieldNumber === 2 && tag.wireType === WIRE_32BIT) {
      out.hue = r.readFloat();
    } else if (tag.fieldNumber === 3 && tag.wireType === WIRE_32BIT) {
      out.saturation = r.readFloat();
    } else {
      r.skipField(tag.wireType);
    }
  }
  return out;
}

function decodeSound(buf) {
  const r = new ProtoReader(buf);
  const out = {};
  while (!r.eof()) {
    const tag = r.readTag();
    if (!tag) break;
    if (tag.fieldNumber === 1 && tag.wireType === WIRE_VARINT) {
      out.noSound = r.readBool();
    } else if (tag.fieldNumber === 2 && tag.wireType === WIRE_LEN) {
      out.track = r.readString();
    } else {
      r.skipField(tag.wireType);
    }
  }
  return out;
}

function decodeSoundList(buf) {
  const r = new ProtoReader(buf);
  const out = { tracks: [] };
  while (!r.eof()) {
    const tag = r.readTag();
    if (!tag) break;
    if (tag.fieldNumber === 1 && tag.wireType === WIRE_LEN) {
      out.tracks.push(r.readString());
    } else {
      r.skipField(tag.wireType);
    }
  }
  return out;
}

function decodeClock(buf) {
  const r = new ProtoReader(buf);
  const out = {};
  while (!r.eof()) {
    const tag = r.readTag();
    if (!tag) break;
    if (tag.fieldNumber === 1 && tag.wireType === WIRE_VARINT) {
      out.enabled = r.readBool();
      out.isEnabled = out.enabled;
    } else if (tag.fieldNumber === 2 && tag.wireType === WIRE_LEN) {
      out.timezone = r.readString();
    } else if (tag.fieldNumber === 3 && tag.wireType === WIRE_VARINT) {
      out.use12hFormat = r.readBool();
    } else if (tag.fieldNumber === 4 && tag.wireType === WIRE_VARINT) {
      out.brightness = r.readInt32();
    } else {
      r.skipField(tag.wireType);
    }
  }
  return out;
}

function decodeSettings(buf) {
  const r = new ProtoReader(buf);
  const out = {};
  while (!r.eof()) {
    const tag = r.readTag();
    if (!tag) break;
    if (tag.fieldNumber === 1 && tag.wireType === WIRE_32BIT) {
      out.brightness = r.readFloat();
    } else if (tag.fieldNumber === 2 && tag.wireType === WIRE_LEN) {
      out.color = decodeColor(r.readBytes());
    } else if (tag.fieldNumber === 3 && tag.wireType === WIRE_32BIT) {
      out.volume = r.readFloat();
    } else if (tag.fieldNumber === 4 && tag.wireType === WIRE_LEN) {
      out.sound = decodeSound(r.readBytes());
    } else if (tag.fieldNumber === 5 && tag.wireType === WIRE_VARINT) {
      out.isOn = r.readBool();
    } else if (tag.fieldNumber === 6 && tag.wireType === WIRE_LEN) {
      out.soundList = decodeSoundList(r.readBytes());
    } else if (tag.fieldNumber === 7 && tag.wireType === WIRE_32BIT) {
      out.temperature = r.readFloat();
    } else if (tag.fieldNumber === 8 && tag.wireType === WIRE_32BIT) {
      out.humidity = r.readFloat();
    } else if (tag.fieldNumber === 11 && tag.wireType === WIRE_LEN) {
      out.clock = decodeClock(r.readBytes());
    } else {
      r.skipField(tag.wireType);
    }
  }
  return out;
}

function decodeBattery(buf) {
  const r = new ProtoReader(buf);
  const out = {};
  while (!r.eof()) {
    const tag = r.readTag();
    if (!tag) break;
    if (tag.fieldNumber === 1 && tag.wireType === WIRE_VARINT) {
      out.soc = r.readInt32();
    } else if (tag.fieldNumber === 2 && tag.wireType === WIRE_VARINT) {
      out.isCharging = r.readBool();
    } else {
      r.skipField(tag.wireType);
    }
  }
  return out;
}

function decodeStatus(buf) {
  const r = new ProtoReader(buf);
  const out = {};
  while (!r.eof()) {
    const tag = r.readTag();
    if (!tag) break;
    if (tag.fieldNumber === 1 && tag.wireType === WIRE_LEN) {
      out.battery = decodeBattery(r.readBytes());
    } else if (tag.fieldNumber === 2 && tag.wireType === WIRE_32BIT) {
      out.temperature = r.readFloat();
    } else if (tag.fieldNumber === 3 && tag.wireType === WIRE_32BIT) {
      out.humidity = r.readFloat();
    } else {
      r.skipField(tag.wireType);
    }
  }
  return out;
}

function decodeAccessPoint(buf) {
  const r = new ProtoReader(buf);
  const out = {};
  while (!r.eof()) {
    const tag = r.readTag();
    if (!tag) break;
    if (tag.fieldNumber === 1 && tag.wireType === WIRE_LEN) {
      out.ssid = r.readString();
    } else if (tag.fieldNumber === 2 && tag.wireType === WIRE_LEN) {
      out.bssid = r.readString();
    } else if (tag.fieldNumber === 5 && tag.wireType === WIRE_VARINT) {
      out.rssi = r.readInt32();
    } else if (tag.fieldNumber === 6 && tag.wireType === WIRE_VARINT) {
      out.primaryChannel = r.readInt32();
    } else {
      r.skipField(tag.wireType);
    }
  }
  return out;
}

function decodeNetworkStatus(buf) {
  const r = new ProtoReader(buf);
  const out = {};
  while (!r.eof()) {
    const tag = r.readTag();
    if (!tag) break;
    if (tag.fieldNumber === 4 && tag.wireType === WIRE_LEN) {
      out.currentAp = decodeAccessPoint(r.readBytes());
    } else {
      r.skipField(tag.wireType);
    }
  }
  return out;
}

function decodeFirmwareInfo(buf) {
  const r = new ProtoReader(buf);
  const out = {};
  while (!r.eof()) {
    const tag = r.readTag();
    if (!tag) break;
    if (tag.fieldNumber === 1 && tag.wireType === WIRE_LEN) {
      out.url = r.readString();
    } else if (tag.fieldNumber === 2 && tag.wireType === WIRE_LEN) {
      out.version = r.readString();
    } else {
      r.skipField(tag.wireType);
    }
  }
  return out;
}

function decodeResponse(buf) {
  const r = new ProtoReader(buf);
  const out = {};
  while (!r.eof()) {
    const tag = r.readTag();
    if (!tag) break;
    if (tag.fieldNumber === 1 && tag.wireType === WIRE_VARINT) {
      out.requestId = r.readInt32();
    } else if (tag.fieldNumber === 2 && tag.wireType === WIRE_VARINT) {
      out.statusCode = r.readInt32();
    } else if (tag.fieldNumber === 3 && tag.wireType === WIRE_LEN) {
      out.statusMessage = r.readString();
    } else if (tag.fieldNumber === 4 && tag.wireType === WIRE_LEN) {
      out.settings = decodeSettings(r.readBytes());
    } else if (tag.fieldNumber === 6 && tag.wireType === WIRE_LEN) {
      out.firmware = decodeFirmwareInfo(r.readBytes());
    } else if (tag.fieldNumber === 8 && tag.wireType === WIRE_LEN) {
      out.networkStatus = decodeNetworkStatus(r.readBytes());
    } else if (tag.fieldNumber === 9 && tag.wireType === WIRE_LEN) {
      out.status = decodeStatus(r.readBytes());
    } else {
      r.skipField(tag.wireType);
    }
  }
  return out;
}

function decodeRequest(buf) {
  const r = new ProtoReader(buf);
  const out = {};
  while (!r.eof()) {
    const tag = r.readTag();
    if (!tag) break;
    if (tag.fieldNumber === 1 && tag.wireType === WIRE_VARINT) {
      out.id = r.readInt32();
    } else if (tag.fieldNumber === 6 && tag.wireType === WIRE_LEN) {
      out.settings = decodeSettings(r.readBytes());
    } else if (tag.fieldNumber === 10 && tag.wireType === WIRE_LEN) {
      out.status = decodeStatus(r.readBytes());
    } else if (tag.fieldNumber === 200 && tag.wireType === WIRE_LEN) {
      out.sessionId = r.readString();
    } else {
      r.skipField(tag.wireType);
    }
  }
  return out;
}

function decodeBackendDevice(buf) {
  const r = new ProtoReader(buf);
  const out = {};
  while (!r.eof()) {
    const tag = r.readTag();
    if (!tag) break;
    if (tag.fieldNumber === 1 && tag.wireType === WIRE_VARINT) {
      out.status = r.readInt32();
    } else {
      r.skipField(tag.wireType);
    }
  }
  return out;
}

function decodeBackend(buf) {
  const r = new ProtoReader(buf);
  const out = {};
  while (!r.eof()) {
    const tag = r.readTag();
    if (!tag) break;
    if (tag.fieldNumber === 1 && tag.wireType === WIRE_LEN) {
      out.device = decodeBackendDevice(r.readBytes());
    } else {
      r.skipField(tag.wireType);
    }
  }
  return out;
}

function decodeMessage(buf) {
  const r = new ProtoReader(buf);
  const out = {};
  while (!r.eof()) {
    const tag = r.readTag();
    if (!tag) break;
    if (tag.fieldNumber === 1 && tag.wireType === WIRE_LEN) {
      out.request = decodeRequest(r.readBytes());
    } else if (tag.fieldNumber === 2 && tag.wireType === WIRE_LEN) {
      out.response = decodeResponse(r.readBytes());
    } else if (tag.fieldNumber === 3 && tag.wireType === WIRE_LEN) {
      out.backend = decodeBackend(r.readBytes());
    } else {
      r.skipField(tag.wireType);
    }
  }
  return out;
}

module.exports = {
  StateOfCharge,
  SOC_TO_PERCENT,
  DeviceStatus,
  encodeMessage,
  decodeMessage,
};
