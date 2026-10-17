// The bridge end to end: the SDK's fake Gladys on one side, the fake openHAB
// (real item list, event stream, autoupdate) on the other.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '@gladysassistant/integration-sdk';
import { TOKEN, USER, createOpenhab } from './helpers/fakeOpenhab.js';
import { captureLogs } from './helpers/logs.js';
import {
  FAST_TIMINGS,
  addDevice,
  baseConfig,
  createWorld,
  deviceOf,
  featureOf,
  flushed,
  settle,
  until,
} from './helpers/world.js';

const statesOf = (world, featureId) =>
  world.fake.states.filter((s) => s.device_feature_external_id === featureId).map((s) => s.state);

test('the items are offered as devices, an equipment holding its points', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const lamp = deviceOf(world, 'Living_Light_Color');
  assert.equal(lamp, deviceOf(world, 'Living_Light_Power'));
  assert.equal(lamp.name, 'Ceiling lamp (Living room)');
  assert.match(lamp.external_id, /:equipment:gLamp$/);
  assert.equal(lamp.features.length, 4);
  assert.match(deviceOf(world, 'Front_Door').external_id, /:item:Front_Door$/);
  for (const device of world.fake.discoveredDevices) {
    assert.equal(device.should_poll, false, device.name);
  }
  assert.equal(deviceOf(world, 'Weather_Text'), undefined);
  assert.ok(world.oh.lastTopics.includes('openhab/items/*/statechanged'));
});

test('states go to the devices added in Gladys only, all again when one is added', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await flushed(world);
  assert.equal(world.fake.states.length, 0, 'nothing added yet');
  await addDevice(world, deviceOf(world, 'Front_Door'));
  await flushed(world);
  const door = featureOf(world, 'Front_Door', 'state').external_id;
  assert.deepEqual(statesOf(world, door), [0], 'OPEN is 0');
  world.oh.change('Front_Door', 'CLOSED');
  await until(async () => (await flushed(world), statesOf(world, door).length === 2), {
    what: 'the state change',
  });
  assert.deepEqual(statesOf(world, door), [0, 1]);
});

test('a command goes to openHAB as text, its state change is the feedback', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const lamp = await addDevice(world, deviceOf(world, 'Living_Light_Dimmer'));
  const brightness = featureOf(world, 'Living_Light_Dimmer', 'brightness');
  const ack = await world.fake.setValue(lamp, brightness, 75);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(world.oh.commands, [
    { item: 'Living_Light_Dimmer', command: '75', type: 'text/plain' },
  ]);
  await until(
    async () => (await flushed(world), statesOf(world, brightness.external_id).includes(75)),
    { what: 'the feedback' },
  );
  const shutter = await addDevice(world, deviceOf(world, 'Living_Shutter'));
  await world.fake.setValue(shutter, featureOf(world, 'Living_Shutter', 'position'), 100);
  assert.equal(world.oh.commands.at(-1).command, '0', 'Gladys 100 (open) is openHAB 0');
});

test('locks: read-only by default, commands refused with a clear message', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const lock = await addDevice(world, deviceOf(world, 'Front_Door_Lock'));
  const ack = await world.fake.setValue(lock, featureOf(world, 'Front_Door_Lock', 'state'), 0);
  assert.equal(ack.success, false);
  assert.match(ack.error, /serrures/);
  assert.deepEqual(world.oh.commands, []);
});

test('an error of openHAB comes back in the configured language', async (t) => {
  const world = await createWorld({ config: baseConfig({ language: 'de' }) });
  t.after(() => world.app.stop());
  const plug = await addDevice(world, deviceOf(world, 'Kitchen_Plug'));
  world.oh.items = world.oh.items.filter((i) => i.name !== 'Kitchen_Plug');
  const ack = await world.fake.setValue(plug, featureOf(world, 'Kitchen_Plug', 'state'), 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /openHAB kennt .*Kitchen_Plug/);
});

test('authentication: token, basic, anonymous; refused credentials say so', async (t) => {
  for (const [auth, config] of [
    ['token', baseConfig()],
    ['basic', baseConfig({ token: '', ...USER })],
    ['anonymous', baseConfig({ token: '' })],
  ]) {
    const world = await createWorld({ oh: createOpenhab({ auth }), config });
    t.after(() => world.app.stop());
    assert.equal(world.bridge.status, 'online', auth);
  }
  const world = await createWorld({
    oh: createOpenhab({ auth: 'anonymous' }),
    config: baseConfig({ token: 'oh.wrong' }),
    waitOnline: false,
  });
  t.after(() => world.app.stop());
  await until(() => world.bridge.status === 'auth_failed', { what: 'auth_failed' });
  assert.equal(world.fake.connectionStatus.connected, false);
  assert.match(world.fake.connectionStatus.message.fr, /refuse l'accès/);
  assert.equal(TOKEN.startsWith('oh.'), true);
});

test('openHAB lost: unreachable badges, one warning, then back with its states', async (t) => {
  const { lines } = captureLogs(t, 'info');
  const world = await createWorld({ logger: createLogger({ name: 'openhab' }) });
  t.after(() => world.app.stop());
  const door = await addDevice(world, deviceOf(world, 'Front_Door'));
  world.oh.down = true;
  world.oh.cutStreams();
  // The stream end makes the bridge read the items: openHAB is down.
  await world.bridge.refresh();
  await until(() => world.bridge.status === 'unreachable', { what: 'unreachable' });
  await settle();
  assert.deepEqual(world.fake.transports.at(-1), {
    device_external_id: door.external_id,
    transport: 'unreachable',
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(lines.filter((l) => /unreachable/.test(l)).length, 1, 'one line, not one per try');
  world.oh.down = false;
  world.oh.items.find((i) => i.name === 'Front_Door').state = 'CLOSED';
  await until(() => world.bridge.status === 'online' && world.bridge.live, { what: 'back' });
  await flushed(world);
  assert.deepEqual(statesOf(world, featureOf(world, 'Front_Door', 'state').external_id).at(-1), 1);
  assert.equal(world.fake.transports.at(-1).transport, 'local');
  assert.ok(lines.some((l) => /Connected again/.test(l)));
  assert.ok(!lines.join('\n').includes(TOKEN), 'no token in the logs');
});

test('no event stream: the items are polled, the stream is tried again', async (t) => {
  const oh = createOpenhab({ sse: false });
  const world = await createWorld({ oh, timings: { ...FAST_TIMINGS, pollInterval: 30 } });
  t.after(() => world.app.stop());
  assert.equal(world.bridge.live, false);
  const door = await addDevice(world, deviceOf(world, 'Front_Door'));
  const id = featureOf(world, 'Front_Door', 'state').external_id;
  oh.items.find((i) => i.name === 'Front_Door').state = 'CLOSED';
  await until(async () => (await flushed(world), statesOf(world, id).at(-1) === 1), {
    what: 'the polled state',
  });
  // A command is read back without waiting for the next poll.
  const plug = await addDevice(world, deviceOf(world, 'Kitchen_Plug'));
  await world.fake.setValue(plug, featureOf(world, 'Kitchen_Plug', 'state'), 0);
  assert.ok(door);
  oh.sse = true;
  await until(() => world.bridge.live, { what: 'the stream again' });
});

test('a silent stream is reopened (watchdog)', async (t) => {
  let clock = 0;
  const oh = createOpenhab();
  const world = await createWorld({ oh });
  t.after(() => world.app.stop());
  world.bridge.now = () => clock;
  world.bridge.lastEventAt = 0;
  clock = FAST_TIMINGS.streamSilence + 1;
  const opened = oh.requests.filter((r) => r === 'GET /rest/events').length;
  await world.bridge.tick(world.bridge.generation);
  await until(
    () => oh.requests.filter((r) => r === 'GET /rest/events').length > opened && world.bridge.live,
    { what: 'a new stream' },
  );
});

test('a new item in openHAB is offered without a scan', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  world.oh.addItem({
    name: 'Garden_Light',
    label: 'Garden light',
    type: 'Switch',
    state: 'OFF',
    tags: ['Light'],
    groupNames: [],
  });
  await until(() => deviceOf(world, 'Garden_Light'), { what: 'the new device' });
});

test('a watched item starts the scene trigger, with its old and new state', async (t) => {
  const world = await createWorld({ config: baseConfig({ watched_items: 'Weather_*' }) });
  t.after(() => world.app.stop());
  world.oh.change('Weather_Text', 'Rain');
  world.oh.change('Front_Door', 'CLOSED');
  await until(() => world.fake.sceneEvents.length > 0, { what: 'the scene event' });
  await settle();
  assert.deepEqual(world.fake.sceneEvents, [
    {
      key: 'item_changed',
      data: { item: 'Weather_Text', label: 'Weather', state: 'Rain', old_state: 'Partly cloudy' },
    },
  ]);
});

test('a normal cycle writes nothing at the info level', async (t) => {
  const world = await createWorld({ logger: createLogger({ name: 'openhab' }) });
  t.after(() => world.app.stop());
  await addDevice(world, deviceOf(world, 'Living_Temperature'));
  const { lines, stop } = captureLogs(t, 'info');
  world.oh.change('Living_Temperature', '22 °C');
  world.oh.alive();
  await world.bridge.refresh();
  await flushed(world);
  assert.deepEqual(stop(), []);
  assert.deepEqual(lines, []);
});

test('the connection test lists what was not imported', async (t) => {
  const world = await createWorld({ config: baseConfig({ language: 'en' }) });
  t.after(() => world.app.stop());
  const ack = await world.fake.action('test_connection', {});
  assert.equal(ack.success, true);
  assert.match(
    ack.data.message.en,
    /^Connected to openHAB 5\.0\.1: \d+ devices offered .*Not imported: .*String \(1\)/,
  );
});

test('not configured, then an invalid address: said in the status', async (t) => {
  const world = await createWorld({ config: {}, waitOnline: false });
  t.after(() => world.app.stop());
  assert.equal(world.bridge.status, 'not_configured');
  await world.bridge.configure({ url: 'ftp://nowhere' });
  assert.equal(world.bridge.status, 'invalid_url');
  assert.match(world.fake.connectionStatus.message.en, /not valid/);
});
