// Scene actions and the dashboard widget.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { statusContent } from '../src/widgets.js';
import { createOpenhab } from './helpers/fakeOpenhab.js';
import { addDevice, baseConfig, createWorld, deviceOf } from './helpers/world.js';

test('send_command: any item, the command as typed', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const ack = await world.fake.sceneAction('send_command', {
    item: 'Weather_Text',
    command: 'Sunny',
  });
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(world.oh.commands.at(-1), {
    item: 'Weather_Text',
    command: 'Sunny',
    type: 'text/plain',
  });
  for (const [fields, error] of [
    [{ item: 'Bad name', command: 'ON' }, /nom de l'item/],
    [{ item: 'Kitchen_Plug', command: ' ' }, /commande à envoyer/],
    [{ item: 'Nope', command: 'ON' }, /ne connaît pas .*Nope/],
  ]) {
    const refused = await world.fake.sceneAction('send_command', fields);
    assert.equal(refused.success, false);
    assert.match(refused.error, error);
  }
});

test('send_command: a lock, or a group holding one, follows the security switch', async (t) => {
  const oh = createOpenhab();
  oh.items.find((i) => i.name === 'Front_Door_Lock').groupNames = ['gAllLights'];
  const world = await createWorld({ oh });
  t.after(() => world.app.stop());
  for (const item of ['Front_Door_Lock', 'gAllLights', 'Garage_Door']) {
    const ack = await world.fake.sceneAction('send_command', { item, command: 'OFF' });
    assert.equal(ack.success, false, item);
    assert.match(ack.error, /désactivées/);
  }
  assert.deepEqual(oh.commands, []);
  const allowed = await createWorld({
    oh,
    config: baseConfig({ allow_security_commands: true }),
  });
  t.after(() => allowed.app.stop());
  const ack = await allowed.fake.sceneAction('send_command', {
    item: 'Front_Door_Lock',
    command: 'OFF',
  });
  assert.equal(ack.success, true, ack.error);
});

test('run_rule: by its UID; an unknown one is said', async (t) => {
  const world = await createWorld({ config: baseConfig({ language: 'en' }) });
  t.after(() => world.app.stop());
  assert.equal((await world.fake.sceneAction('run_rule', { rule: 'good_night' })).success, true);
  assert.deepEqual(world.oh.ranRules, ['good_night']);
  const unknown = await world.fake.sceneAction('run_rule', { rule: 'nope' });
  assert.match(unknown.error, /does not know .*nope/);
  const bad = await world.fake.sceneAction('run_rule', { rule: '../x' });
  assert.match(bad.error, /UID/);
});

test('the widget passes the SDK validation in every state, and reloads the items', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await addDevice(world, deviceOf(world, 'Living_Light_Power'));
  for (const status of ['online', 'unreachable', 'auth_failed', 'not_configured', 'connecting']) {
    for (const live of [true, false]) {
      const content = statusContent(
        { status, live, version: '5.0.1', offered: 30, added: 1, followed: 4 },
        'de',
      );
      assert.doesNotThrow(() => validateWidgetContent(content), `${status} ${live}`);
    }
  }
  const got = await world.fake.widgetGet('status', { settings: {}, language: 'fr' });
  assert.equal(got.success, true, got.error);
  const values = got.data.content.components.filter((c) => c.type === 'value').map((c) => c.value);
  assert.deepEqual(values.slice(1), [1, 3], 'one device added, its three items followed');
  const before = world.oh.requests.length;
  const action = await world.fake.widgetAction('status', 'reload');
  assert.equal(action.success, true, action.error);
  assert.equal(action.data.message.fr, 'Liste des items relue.');
  assert.ok(world.oh.requests.slice(before).includes('GET /rest/items'));
});
