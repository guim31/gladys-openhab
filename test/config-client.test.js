// Configuration normalization and the openHAB client helpers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, normalizeUrl } from '../src/config.js';
import { authorization, sseParser } from '../src/openhab/client.js';

test('the address: a port added, /rest removed, credentials in the URL refused', () => {
  assert.equal(normalizeUrl('192.0.2.10'), 'http://192.0.2.10:8080');
  assert.equal(normalizeUrl(' http://192.0.2.10:8080/rest/ '), 'http://192.0.2.10:8080');
  assert.equal(normalizeUrl('https://oh.example/'), 'https://oh.example');
  assert.equal(normalizeUrl('http://user:pw@192.0.2.10:8080'), null);
  assert.equal(normalizeUrl('ftp://192.0.2.10'), null);
  assert.equal(normalizeUrl(''), null);
});

test('the configuration: lists, bounds, defaults', () => {
  const config = normalizeConfig({
    url: '192.0.2.10',
    groups: 'gLiving, Ground floor',
    tags: 'Lightbulb;Temperature',
    exclude_items: '*_Signal Test_*',
    sensor_interval: 99999,
    language: 'xx',
  });
  assert.deepEqual(config.groups, ['gliving', 'ground', 'floor']);
  assert.deepEqual(config.tags, ['lightbulb', 'temperature']);
  assert.deepEqual(config.exclude, ['*_Signal', 'Test_*']);
  assert.equal(config.sensorInterval, 3600);
  assert.equal(config.language, 'fr');
  assert.equal(config.allowSecurity, false);
  assert.equal(normalizeConfig({ url: 'nope://' }).invalidUrl, true);
});

test('the authorization header: basic with a user name, else the token, else none', () => {
  assert.equal(authorization({ token: 'oh.abc' }), 'Bearer oh.abc');
  assert.equal(
    authorization({ token: 'oh.abc', username: 'admin', password: 'pw' }),
    `Basic ${Buffer.from('admin:pw').toString('base64')}`,
  );
  assert.equal(authorization({}), undefined);
});

test('the SSE parser: events split anywhere, CRLF, alive events', () => {
  const events = [];
  const feed = sseParser((e) => events.push(e));
  const text =
    'event: message\r\ndata: {"topic":"a"}\r\n\r\nevent: alive\ndata: {"type":"ALIVE"}\n\n';
  for (const char of text) {
    feed(char);
  }
  assert.deepEqual(events, [
    { event: 'message', data: '{"topic":"a"}' },
    { event: 'alive', data: '{"type":"ALIVE"}' },
  ]);
});
