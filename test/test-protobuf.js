'use strict';

const assert = require('assert');
const { encodeMessage, decodeMessage, StateOfCharge, DeviceStatus } = require('../src/protobuf');

// 1. Test encoding & decoding a combined Settings Request
const encodedReq = encodeMessage({
  request: {
    id: 42,
    sessionId: 'deadbeefcafebabe',
    settings: {
      isOn: true,
      brightness: 0.75,
      volume: 0.5,
      color: {
        noColor: false,
        hue: 0.25,
        saturation: 0.8,
      },
      sound: {
        noSound: false,
        track: 'White Noise',
      },
      clock: {
        isEnabled: true,
        brightness: 5,
      },
    },
  },
});

const decodedReq = decodeMessage(encodedReq);
assert.strictEqual(decodedReq.request.id, 42);
assert.strictEqual(decodedReq.request.sessionId, 'deadbeefcafebabe');
assert.strictEqual(decodedReq.request.settings.isOn, true);
assert.strictEqual(Math.fround(decodedReq.request.settings.brightness), Math.fround(0.75));
assert.strictEqual(Math.fround(decodedReq.request.settings.volume), Math.fround(0.5));
assert.strictEqual(decodedReq.request.settings.color.noColor, false);
assert.strictEqual(Math.fround(decodedReq.request.settings.color.hue), Math.fround(0.25));
assert.strictEqual(Math.fround(decodedReq.request.settings.color.saturation), Math.fround(0.8));
assert.strictEqual(decodedReq.request.settings.sound.track, 'White Noise');
assert.strictEqual(decodedReq.request.settings.clock.isEnabled, true);
assert.strictEqual(decodedReq.request.settings.clock.brightness, 5);

console.log('✅ Protobuf round-trip test passed!');
