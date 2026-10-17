// Item -> features, on the items of a real openHAB 5.0.1 (test/fixtures/openhab).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COVER_STATE,
  OPENING_SENSOR_STATE,
  WriteError,
  hsbToInt,
  intToHs,
  mapItem,
  parseQuantity,
  patternUnit,
} from '../src/mapping.js';
import { fixture } from './helpers/fakeOpenhab.js';

const items = new Map(fixture().map((i) => [i.name, i]));
const item = (name) => structuredClone(items.get(name));
const feature = (name, role, options) => {
  const found = mapItem(item(name), options).find((f) => f.role === role);
  assert.ok(found, `${name}: no ${role}`);
  return found;
};
const read = (name, role, state, options) =>
  feature(name, role, options).read(state ?? items.get(name).state, items.get(name));

test('a Contact OPEN is 0 in Gladys, CLOSED is 1 (the opening sensor convention)', () => {
  assert.equal(read('Front_Door', 'state', 'OPEN'), OPENING_SENSOR_STATE.OPEN);
  assert.equal(read('Front_Door', 'state', 'CLOSED'), OPENING_SENSOR_STATE.CLOSE);
  assert.equal(read('Front_Door', 'state', 'NULL'), null);
  assert.equal(feature('Front_Door', 'state').spec.category, 'opening-sensor');
});

test('a Rollershutter is 0 when open in openHAB, its Gladys position 100', () => {
  assert.equal(read('Living_Shutter', 'position', '0'), 100);
  assert.equal(read('Living_Shutter', 'position', '100'), 0);
  assert.equal(read('Living_Shutter', 'position', '30'), 70);
  assert.equal(feature('Living_Shutter', 'position').write(70), '30');
  assert.equal(read('Living_Shutter', 'command', '100'), COVER_STATE.CLOSE);
  assert.equal(read('Living_Shutter', 'command', '40'), COVER_STATE.OPEN);
  const command = feature('Living_Shutter', 'command');
  assert.deepEqual(
    [COVER_STATE.OPEN, COVER_STATE.CLOSE, COVER_STATE.STOP].map((v) => command.write(v)),
    ['UP', 'DOWN', 'STOP'],
  );
  assert.throws(() => command.write(5), WriteError);
  assert.equal(feature('Bedroom_Curtain', 'position').spec.category, 'curtain');
});

test('Number:Dimensionless without unit metadata: openHAB keeps "one", the bridge shows the pattern unit', () => {
  // Read from openHAB 5.0.1: 48 % is stored "0.48", 612 ppm "0.000612".
  assert.equal(items.get('Living_Humidity').state, '0.48');
  assert.equal(read('Living_Humidity', 'value'), 48);
  assert.equal(read('Living_CO2', 'value'), 612);
  assert.equal(read('Hall_Sensor_Battery', 'value'), 92);
  // A plain Number is shown as it is, whatever its pattern.
  assert.equal(read('Battery_Hall', 'value'), 87);
});

test('units: the cubic metre openHAB sends as U+33A5, Fahrenheit converted by openHAB', () => {
  assert.equal(items.get('Gas_Meter').unitSymbol, '㎥');
  assert.equal(feature('Gas_Meter', 'value').spec.unit, 'cubicmeter');
  assert.equal(read('Gas_Meter', 'value'), 4521.37);
  // The item has a °F pattern, but openHAB (SI) stores it in °C: the item unit wins.
  assert.equal(feature('Outdoor_Temperature_F', 'value').spec.unit, 'celsius');
  assert.equal(read('Outdoor_Temperature_F', 'value'), 14);
  assert.equal(read('Living_Temperature', 'value', '21.5 °C'), 21.5);
  // A state in another unit is not converted: dropped rather than wrong.
  assert.equal(read('Living_Temperature', 'value', '70 °F'), null);
  assert.deepEqual(parseQuantity('1.2E3 W'), { value: 1200, unit: 'W' });
  assert.equal(parseQuantity('UNDEF'), null);
  assert.equal(patternUnit({ stateDescription: { pattern: '%d %%' } }), '%');
  assert.equal(patternUnit({ unitSymbol: 'W', stateDescription: { pattern: '%.1f %unit%' } }), 'W');
});

test('a temperature setpoint is a thermostat, bounded by its state description', () => {
  const setpoint = feature('Bedroom_Setpoint', 'value');
  assert.equal(setpoint.spec.category, 'thermostat');
  assert.deepEqual([setpoint.spec.min, setpoint.spec.max], [5, 30]);
  assert.equal(setpoint.write(19.5), '19.5 °C');
  assert.throws(() => setpoint.write(31), WriteError);
  assert.equal(read('Bedroom_Setpoint', 'value'), 18);
});

test('HSB and colours', () => {
  assert.equal(hsbToInt({ h: 120, s: 100, b: 50 }), 0x00ff00);
  assert.equal(hsbToInt({ h: 0, s: 0, b: 100 }), 0xffffff);
  assert.deepEqual(intToHs(0xff0000), { h: 0, s: 100 });
  assert.deepEqual(intToHs(0x0000ff), { h: 240, s: 100 });
  const color = feature('Living_Light_Color', 'color', { standalone: false });
  // The colour keeps the brightness; a lamp off comes on at full.
  assert.equal(color.write(0xff0000, { state: '120,100,50' }), '0,100,50');
  assert.equal(color.write(0xff0000, { state: '120,100,0' }), '0,100,100');
  assert.equal(read('Living_Light_Color', 'brightness', '10,20,30'), 30);
});

test('a Dimmer or a Color alone gets an on/off, not inside an equipment', () => {
  const alone = mapItem(item('Living_Light_Dimmer'), { standalone: true }).map((f) => f.role);
  const inside = mapItem(item('Living_Light_Dimmer'), { standalone: false }).map((f) => f.role);
  assert.deepEqual(alone, ['power', 'brightness']);
  assert.deepEqual(inside, ['brightness']);
  assert.equal(feature('Living_Speaker_Volume', 'volume').spec.category, 'music');
});

test('locks and garage doors stay read-only unless allowed; the garage door shows open/closed', () => {
  const lock = feature('Front_Door_Lock', 'state');
  assert.equal(lock.spec.category, 'lock');
  assert.equal(lock.write, undefined);
  assert.equal(lock.spec.read_only, true);
  assert.equal(
    feature('Front_Door_Lock', 'state', { allowSecurity: true }).write(0),
    'OFF',
    'allowed',
  );
  const garage = mapItem(item('Garage_Door')).map((f) => [f.role, Boolean(f.write)]);
  assert.deepEqual(garage, [
    ['position', false],
    ['contact', false],
  ]);
  assert.equal(read('Garage_Door', 'contact', '100'), OPENING_SENSOR_STATE.CLOSE);
  assert.equal(read('Garage_Door', 'contact', '20'), OPENING_SENSOR_STATE.OPEN);
  const allowed = mapItem(item('Garage_Door'), { allowSecurity: true }).map((f) => f.role);
  assert.deepEqual(allowed, ['command', 'position', 'contact']);
  // An impulse Switch tagged GarageDoor follows the same rule.
  const opener = { ...item('Virtual_Switch'), tags: ['GarageDoor'] };
  assert.equal(mapItem(opener)[0].write, undefined);
});

test('detectors are read-only; a read-only state description wins', () => {
  assert.equal(feature('Smoke_Kitchen', 'state').spec.category, 'smoke-sensor');
  assert.equal(feature('Water_Leak', 'state').spec.category, 'leak-sensor');
  assert.equal(feature('Motion_Hall', 'state').spec.category, 'motion-sensor');
  assert.equal(feature('Motion_Hall', 'state').spec.read_only, true);
  const boiler = feature('Boiler_Running', 'state');
  assert.equal(boiler.spec.read_only, true);
  assert.equal(boiler.write, undefined);
});

test('the player: playback state, and commands without feedback', () => {
  const roles = mapItem(item('Living_Speaker_Control'));
  assert.deepEqual(
    roles.map((f) => [f.role, f.spec.has_feedback, f.write?.()]),
    [
      ['playback', false, undefined],
      ['play', false, 'PLAY'],
      ['pause', false, 'PAUSE'],
      ['next', false, 'NEXT'],
      ['previous', false, 'PREVIOUS'],
    ],
  );
});

test('groups, strings, dates and locations are not imported', () => {
  for (const name of ['gAllLights', 'gLamp', 'Weather_Text', 'Last_Update', 'Home_Location']) {
    assert.ok(!Array.isArray(mapItem(item(name))), name);
  }
  assert.ok(!Array.isArray(mapItem(item('Plain_Counter'))), 'a Number without unit nor meaning');
});

test('any opener of the house is guarded: a String in a garage door, a Switch strike in a door', () => {
  const garage = { metadata: { semantics: { value: 'Equipment_Door_GarageDoor' } }, tags: [] };
  const opener = { ...item('Weather_Text'), type: 'Dimmer', tags: [] };
  assert.equal(
    mapItem(opener, { equipment: garage }).every((f) => !f.write),
    true,
    'read-only in a garage door equipment',
  );
  const strike = { ...item('Virtual_Switch'), tags: ['FrontDoor'] };
  assert.equal(mapItem(strike)[0].write, undefined);
  assert.equal(mapItem(strike, { allowSecurity: true })[0].write(1), 'ON');
});
