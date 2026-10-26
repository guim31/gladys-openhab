// The Gladys 5.3 music player of an equipment: channel recognition, values,
// inventory, publishNowPlaying, artwork and commands. The items, links and
// events are those of a real openHAB 5.0.1 (test/fixtures/openhab/
// music-5.0.1.json): a Squeezebox player of the binding (LMS + squeezelite),
// grouped in an equipment like "Create Equipment from Thing" does, an
// offline Sonos One, and a bare Player item.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLogger } from '@gladysassistant/integration-sdk';
import { buildInventory } from '../src/inventory.js';
import {
  channelRole,
  modeOf,
  modeOptions,
  parseImage,
  playbackState,
  splitChannel,
  toSeconds,
} from '../src/music.js';
import { TOKEN, createOpenhab } from './helpers/fakeOpenhab.js';
import { addDevice, baseConfig, createWorld, settle, until } from './helpers/world.js';
import { captureLogs } from './helpers/logs.js';

const FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/openhab/music-5.0.1.json', import.meta.url), 'utf8'),
);
const items = () => structuredClone(FIXTURE.items);
const links = () => structuredClone(FIXTURE.links);
const linkMap = (list = links()) => {
  const map = new Map();
  for (const l of list) {
    map.set(l.itemName, [...(map.get(l.itemName) ?? []), l.channelUID]);
  }
  return map;
};
const externalIds = (type, id) => ({
  device: `ext:test:${type}:${id}`,
  feature: (part) => `ext:test:${type}:${id}:${part}`,
});
const inventory = (options = {}) =>
  buildInventory(options.items ?? items(), {
    externalIds,
    language: 'fr',
    links: linkMap(),
    ...options,
  });
const SALON = 'ext:test:equipment:Salon';
const music = (device, type) =>
  device.features.filter((f) => f.category === 'music' && f.type === type);

// --- Pure helpers ----------------------------------------------------------------

test('channels: thing and id, channel groups, and the role of the item type', () => {
  assert.deepEqual(splitChannel('squeezebox:squeezeboxplayer:lms:020000000001:title'), {
    thing: 'squeezebox:squeezeboxplayer:lms:020000000001',
    id: 'title',
  });
  assert.equal(splitChannel('chromecast:audio:abc:control#title')?.id, 'title');
  assert.equal(splitChannel('nonsense'), null);
  const string = { type: 'String' };
  assert.equal(channelRole(string, 'sonos:One:RINCON_1:currenttitle').role, 'title');
  assert.equal(channelRole(string, 'b:t:x:trackArtist').role, 'artist');
  assert.ok(
    channelRole(string, 'b:t:x:artist').rank < channelRole(string, 'b:t:x:trackArtist').rank,
  );
  // The type must fit: a String is no artwork, a Number:Temperature no position.
  assert.equal(channelRole(string, 'b:t:x:coverartdata'), null);
  assert.equal(channelRole({ type: 'Image' }, 'b:t:x:coverartdata').role, 'artwork');
  assert.equal(channelRole({ type: 'Number:Temperature' }, 'b:t:x:position'), null);
  assert.equal(channelRole({ type: 'Number:Time' }, 'b:t:x:currentTime').role, 'position');
  assert.equal(channelRole({ type: 'Number' }, 'spotify:player:x:trackDurationMs').ms, true);
  assert.equal(channelRole(string, 'b:t:x:year'), null);
  // A Number or String mode needs its options; a Switch does not.
  assert.equal(channelRole({ type: 'Number' }, 'b:t:x:currentPlaylistShuffle'), null);
  assert.equal(channelRole({ type: 'Switch' }, 'b:t:x:shuffle').role, 'shuffle');
});

test('durations and positions in seconds, whatever openHAB sends', () => {
  assert.equal(toSeconds('240 s'), 240);
  assert.equal(toSeconds('4.5 min'), 270);
  assert.equal(toSeconds('245000 ms'), 245);
  assert.equal(toSeconds('245000', { ms: true }), 245);
  assert.equal(toSeconds('245'), 245);
  assert.equal(toSeconds('4:05'), 245);
  assert.equal(toSeconds('1:02:03'), 3723);
  for (const s of ['NULL', 'UNDEF', undefined, '', '-3 s', '12 °C', 'soon']) {
    assert.equal(toSeconds(s), null, String(s));
  }
});

test('shuffle and repeat modes from the options of the bindings', () => {
  const squeezebox = {
    stateDescription: {
      options: [
        { value: '0', label: 'No Repeat' },
        { value: '1', label: 'Repeat Song' },
        { value: '2', label: 'Repeat Playlist' },
      ],
    },
  };
  assert.deepEqual(
    [...modeOptions(squeezebox, 'repeat')],
    [
      [0, '0'],
      [2, '1'],
      [1, '2'],
    ],
  );
  // Sonos, HEOS, Spotify.
  assert.deepEqual(
    ['OFF', 'ALL', 'ONE'].map((v) => modeOf('repeat', v)),
    [0, 1, 2],
  );
  assert.deepEqual(
    ['OFF', 'ON_ALL', 'ON_ONE'].map((v) => modeOf('repeat', v)),
    [0, 1, 2],
  );
  assert.deepEqual(
    ['off', 'context', 'track'].map((v) => modeOf('repeat', v)),
    [0, 1, 2],
  );
  assert.deepEqual(
    ['0 No Shuffle', '1 Shuffle Songs', '2 Shuffle Albums'].map((v) => modeOf('shuffle', v)),
    [0, 1, 1],
  );
  // Without an "off" and another option, nothing to send back: not a mode.
  assert.equal(modeOptions({ stateDescription: { options: [{ value: 'X' }] } }, 'repeat'), null);
  assert.equal(modeOptions({}, 'repeat'), null);
});

test('playback state: playing, paused, stopped or nothing loaded', () => {
  assert.equal(playbackState('PLAY'), 1);
  assert.equal(playbackState('PAUSE'), 0);
  assert.equal(playbackState('PAUSE', { stop: 'ON' }), 2);
  assert.equal(playbackState('PAUSE', { title: '' }), 2);
  assert.equal(playbackState('PLAY', { stop: 'ON' }), 1);
  assert.equal(playbackState('UNDEF'), null);
  assert.deepEqual(parseImage('data:image/jpeg;base64,/9j/4AAQ'), {
    mime: 'image/jpeg',
    base64: '/9j/4AAQ',
  });
  assert.equal(parseImage('UNDEF'), null);
});

// --- Inventory -------------------------------------------------------------------

test('the Squeezebox equipment: one device, its channels attached to its player', () => {
  const inv = inventory();
  const salon = inv.devices.find((d) => d.external_id === SALON);
  const id = (part) => `${SALON}:${part}`;
  const types = Object.fromEntries(
    salon.features.filter((f) => f.category === 'music').map((f) => [f.external_id, f.type]),
  );
  assert.deepEqual(types, {
    [id('Salon_Control-playback')]: 'playback_state',
    [id('Salon_Control-play')]: 'play',
    [id('Salon_Control-pause')]: 'pause',
    [id('Salon_Control-next')]: 'next',
    [id('Salon_Control-previous')]: 'previous',
    [id('Salon_Title-title')]: 'title',
    [id('Salon_Artist-artist')]: 'artist',
    [id('Salon_Album-album')]: 'album',
    [id('Salon_Cover-artwork')]: 'artwork',
    [id('Salon_Duration-duration')]: 'duration',
    [id('Salon_Position-position')]: 'position',
    [id('Salon_Shuffle-shuffle')]: 'shuffle',
    [id('Salon_Repeat-repeat')]: 'repeat',
    // 1.0 imported it as a switch: same id, converted by "Update".
    [id('Salon_Mute-state')]: 'mute',
    [id('Salon_Volume-volume')]: 'volume',
  });
  // trackArtist and year are not the player's; the stop switch stays a switch.
  assert.ok(!salon.features.some((f) => /TrackArtist|Year/.test(f.external_id)));
  assert.equal(salon.features.find((f) => f.external_id === id('Salon_Stop-state')).type, 'binary');
  const playback = salon.features.find((f) => f.type === 'playback_state');
  assert.deepEqual(
    [playback.read_only, playback.has_feedback, playback.max, playback.supported_options.length],
    [false, true, 2, 3],
  );
  // Read-only as openHAB says (the duration), writable otherwise, feedback on every write.
  for (const f of salon.features.filter((x) => x.category === 'music')) {
    if (!f.read_only && !['play', 'pause', 'next', 'previous'].includes(f.type)) {
      assert.equal(f.has_feedback, true, f.type);
    }
  }
  assert.equal(music(salon, 'duration')[0].read_only, true);
  assert.equal(music(salon, 'position')[0].read_only, false);
  assert.deepEqual(
    music(salon, 'repeat')[0].supported_options.map((o) => [o.value, o.label]),
    [
      [0, 'Désactivée'],
      [1, 'Tout'],
      [2, 'Un seul'],
    ],
  );
  // Published through publishNowPlaying, not the state publisher.
  assert.ok(!inv.routes.has('Salon_Title') && !inv.routes.has('Salon_Control'));
  assert.ok(inv.routes.has('Salon_Volume'));
  assert.deepEqual([...inv.musicItems.get('Salon_Stop')], [SALON]);
});

test('a feature never changes device: an untagged Switch of the equipment stays its own', () => {
  const inv = inventory();
  const cuisine = inv.devices.find((d) => d.external_id === 'ext:test:equipment:Cuisine');
  assert.deepEqual(
    ['title', 'artist', 'album', 'shuffle', 'repeat', 'mute'].map((t) => music(cuisine, t).length),
    [1, 1, 1, 1, 1, 0],
  );
  assert.ok(inv.devices.some((d) => d.external_id === 'ext:test:item:Cuisine_Mute'));
  // No stop channel linked: Pause and Play only.
  assert.equal(music(cuisine, 'playback_state')[0].supported_options.length, 2);
});

test('without the links (anonymous openHAB, user token): the 1.0 devices, playback writable', () => {
  const inv = inventory({ links: undefined });
  const salon = inv.devices.find((d) => d.external_id === SALON);
  assert.deepEqual(
    salon.features
      .filter((f) => f.category === 'music')
      .map((f) => f.type)
      .sort(),
    ['next', 'pause', 'play', 'playback_state', 'previous', 'volume'],
  );
  assert.equal(inv.music.size, 0);
  assert.ok(inv.routes.has('Salon_Control'));
  const bare = inv.devices.find((d) => d.external_id === 'ext:test:item:Bureau_Player');
  assert.equal(bare.features.length, 5);
});

test('another thing linked in the equipment is not mixed into the player', () => {
  const list = links().map((l) =>
    l.itemName === 'Salon_Album'
      ? { ...l, channelUID: 'squeezebox:squeezeboxplayer:lms:other:album' }
      : l,
  );
  const inv = inventory({ links: linkMap(list) });
  const salon = inv.devices.find((d) => d.external_id === SALON);
  assert.equal(music(salon, 'album').length, 0);
});

// --- Bridge ----------------------------------------------------------------------

const musicWorld = (options = {}) =>
  createWorld({ oh: createOpenhab({ items: items(), links: links(), ...options }) });

const salonOf = (world) =>
  world.fake.discoveredDevices.find((d) => d.external_id.endsWith(':equipment:Salon'));
const feature = (device, suffix) => device.features.find((f) => f.external_id.endsWith(suffix));

test('an added player gets its whole now playing in one batch, then the changes', async () => {
  const world = await musicWorld();
  const salon = await addDevice(world, salonOf(world));
  const last = (suffix) => world.fake.lastState(feature(salon, suffix).external_id);
  await until(() => last('Salon_Title-title') === 'Long Tone 4', { what: 'the title' });
  assert.equal(last('Salon_Artist-artist'), 'Test Artist 4');
  assert.equal(last('Salon_Album-album'), 'Gladys Test Album');
  assert.equal(last('Salon_Control-playback'), 1);
  assert.equal(last('Salon_Duration-duration'), 240);
  assert.equal(last('Salon_Shuffle-shuffle'), 0);
  assert.equal(last('Salon_Repeat-repeat'), 0);
  assert.match(last('Salon_Cover-artwork'), /^art-[0-9a-f]{12}$/);

  // The artwork is the Image item: the binding's JPEG, served as is (3 KB).
  const art = await world.fake.musicGetArtwork(last('Salon_Cover-artwork'));
  assert.equal(art.success, true);
  const cover = FIXTURE.items.find((i) => i.name === 'Salon_Cover').state.split(',')[1];
  assert.equal(art.data.image, cover);
  const unknown = await world.fake.musicGetArtwork('art-000000000000');
  assert.equal(unknown.success, false);

  // The real events of a NEXT (PAUSE, stop ON, duration 0, PLAY, title...): one batch at the end.
  const batches = () => world.fake.bodies('POST', '/api/v1/external-integration/state').length;
  const before = batches();
  for (const block of FIXTURE.events) {
    const message = JSON.parse(block.split('data: ')[1]);
    const name = message.topic.split('/')[2];
    const { value } = JSON.parse(message.payload);
    world.oh.items.find((i) => i.name === name).state = value;
    world.oh.emit(message);
  }
  await until(() => last('Salon_Title-title') === 'Long Tone 5', { what: 'the next title' });
  await settle();
  assert.equal(last('Salon_Artist-artist'), 'Test Artist 5');
  assert.equal(last('Salon_Control-playback'), 1);
  assert.equal(last('Salon_Position-position'), 0);
  assert.ok(batches() - before <= 2, `${batches() - before} batches`);
  world.app.stop();
});

test('nothing loaded: the texts and the artwork are cleared, the player is idle', async () => {
  const world = await musicWorld();
  const salon = await addDevice(world, salonOf(world));
  const last = (suffix) => world.fake.lastState(feature(salon, suffix).external_id);
  await until(() => last('Salon_Title-title') === 'Long Tone 4');
  world.oh.change('Salon_Title', 'UNDEF');
  world.oh.change('Salon_Control', 'PAUSE');
  await until(() => last('Salon_Title-title') === '', { what: 'the cleared title' });
  assert.equal(last('Salon_Artist-artist'), '');
  assert.equal(last('Salon_Album-album'), '');
  assert.equal(last('Salon_Cover-artwork'), '');
  assert.equal(last('Salon_Control-playback'), 2);
  world.app.stop();
});

test('commands: play/pause/stop, seek, shuffle and repeat options, mute', async () => {
  const world = await musicWorld();
  const salon = await addDevice(world, salonOf(world));
  const set = (suffix, value) => world.fake.setValue(salon, feature(salon, suffix), value);
  const sent = () => world.oh.commands.at(-1);
  await set('Salon_Control-playback', 0);
  assert.deepEqual(sent(), { item: 'Salon_Control', command: 'PAUSE', type: 'text/plain' });
  await set('Salon_Control-playback', 1);
  assert.equal(sent().command, 'PLAY');
  // Stop goes to the stop channel of the equipment.
  await set('Salon_Control-playback', 2);
  assert.deepEqual([sent().item, sent().command], ['Salon_Stop', 'ON']);
  const refused = await set('Salon_Control-playback', 3);
  assert.equal(refused.success, false);
  await set('Salon_Position-position', 120);
  assert.deepEqual([sent().item, sent().command], ['Salon_Position', '120 s']);
  await set('Salon_Shuffle-shuffle', 1);
  assert.deepEqual([sent().item, sent().command], ['Salon_Shuffle', '1']);
  await set('Salon_Repeat-repeat', 2);
  assert.deepEqual([sent().item, sent().command], ['Salon_Repeat', '1']);
  await set('Salon_Repeat-repeat', 1);
  assert.equal(sent().command, '2');
  await set('Salon_Mute-state', 1);
  assert.deepEqual([sent().item, sent().command], ['Salon_Mute', 'ON']);
  const cuisine = world.fake.discoveredDevices.find((d) => d.external_id.endsWith(':Cuisine'));
  await world.fake.setValue(cuisine, music(cuisine, 'repeat')[0], 2);
  assert.deepEqual([sent().item, sent().command], ['Cuisine_Repeat', 'ONE']);
  world.app.stop();
});

test('an update of the device republishes everything (the new features were ignored before)', async () => {
  const world = await musicWorld();
  const salon = await addDevice(world, salonOf(world));
  const titleId = feature(salon, 'Salon_Title-title').external_id;
  await until(() => world.fake.lastState(titleId) === 'Long Tone 4');
  const count = () => world.fake.states.filter((s) => s.device_feature_external_id === titleId);
  const before = count().length;
  await world.fake.deviceUpdated(structuredClone(salon));
  await until(() => count().length > before, { what: 'the title again' });
  world.app.stop();
});

test('links refused (a user token): one line, the bridge works as 1.0', async (t) => {
  const { lines } = captureLogs(t, 'info');
  const oh = createOpenhab({ items: items(), links: links(), auth: 'anonymous' });
  const world = await createWorld({
    oh,
    logger: createLogger({ name: 'openhab' }),
    config: { ...baseConfig(), token: '' },
  });
  t.after(() => world.app.stop());
  assert.equal(world.bridge.status, 'online');
  assert.equal(world.bridge.links, null);
  assert.equal(world.bridge.inventory.music.size, 0);
  await world.bridge.refresh();
  assert.equal(lines.filter((l) => /item links/.test(l)).length, 1, lines.join('\n'));
  // The token is what shows them.
  assert.equal(oh.requests.filter((r) => r === 'GET /rest/links').length, 2);
  assert.ok(TOKEN);
});

test('links in error (500, timeout): the links read before stay, the devices stay reachable', async (t) => {
  const { lines } = captureLogs(t, 'info');
  const world = await createWorld({
    oh: createOpenhab({ items: items(), links: links() }),
    logger: createLogger({ name: 'openhab' }),
  });
  t.after(() => world.app.stop());
  assert.equal(world.bridge.inventory.music.size, 2);
  const failures = () => lines.filter((l) => /links not read/.test(l));
  for (const fail of [500, 'timeout']) {
    const before = world.bridge.links;
    world.oh.linksFail = fail;
    await world.bridge.refresh();
    await world.bridge.refresh();
    assert.equal(world.bridge.status, 'online');
    assert.equal(world.bridge.links, before);
    assert.equal(world.bridge.inventory.music.size, 2);
    world.oh.linksFail = null;
    await world.bridge.refresh();
  }
  // One line at the first failure of each run, none per attempt.
  assert.equal(failures().length, 2, lines.join('\n'));
  assert.match(failures()[1], /timeout/);
  assert.equal(lines.filter((l) => /item links to this token/.test(l)).length, 0);

  // At the connection: online, without the links until they are read.
  const oh = createOpenhab({ items: items(), links: links() });
  oh.linksFail = 500;
  const late = await createWorld({ oh });
  t.after(() => late.app.stop());
  assert.equal(late.bridge.status, 'online');
  assert.equal(late.bridge.links, null);
  oh.linksFail = null;
  await late.bridge.refresh();
  assert.equal(late.bridge.inventory.music.size, 2);
});

test('a live stream without duration (UNDEF) publishes 0, not the previous one', async (t) => {
  const world = await musicWorld();
  t.after(() => world.app.stop());
  const salon = await addDevice(world, salonOf(world));
  const last = (suffix) => world.fake.lastState(feature(salon, suffix).external_id);
  await until(() => last('Salon_Duration-duration') === 240, { what: 'the duration' });
  world.oh.change('Salon_Duration', 'UNDEF');
  await until(() => last('Salon_Duration-duration') === 0, { what: 'the duration 0' });
  assert.equal(last('Salon_Control-playback'), 1);
});

test('the features not yet in Gladys are published after "Update" only', async (t) => {
  const world = await musicWorld();
  t.after(() => world.app.stop());
  const full = salonOf(world);
  const titleId = feature(full, 'Salon_Title-title').external_id;
  const old = structuredClone(full);
  old.features = old.features.filter((f) => f.external_id !== titleId);
  await addDevice(world, old);
  const artistId = feature(full, 'Salon_Artist-artist').external_id;
  await until(() => world.fake.lastState(artistId) === 'Test Artist 4', { what: 'the artist' });
  assert.equal(world.fake.lastState(titleId), undefined);
  await world.fake.deviceUpdated(structuredClone(full));
  await until(() => world.fake.lastState(titleId) === 'Long Tone 4', { what: 'the title' });
});

test('the options of a repeat item are part of the structure; links in a stable order', async (t) => {
  const world = await musicWorld();
  t.after(() => world.app.stop());
  const repeat = () => {
    const cuisine = world.bridge.inventory.devices.find((d) => d.external_id.endsWith(':Cuisine'));
    return music(cuisine, 'repeat')[0].supported_options.map((o) => o.value);
  };
  assert.deepEqual(repeat(), [0, 1, 2]);
  const item = world.oh.items.find((i) => i.name === 'Cuisine_Repeat');
  item.stateDescription.options = item.stateDescription.options.filter((o) => o.value !== 'ONE');
  await world.bridge.refresh();
  assert.deepEqual(repeat(), [0, 1]);

  // The order of /rest/links does not matter.
  const order = world.bridge.structure;
  world.oh.links.reverse();
  world.oh.links.push({ itemName: 'Salon_Title', channelUID: 'a:b:c:other' });
  world.oh.links.unshift({ itemName: 'Salon_Title', channelUID: 'z:b:c:other' });
  await world.bridge.refresh();
  const channels = world.bridge.links.get('Salon_Title');
  assert.deepEqual(channels, [...channels].sort());
  world.oh.links.reverse();
  await world.bridge.refresh();
  assert.deepEqual(world.bridge.links.get('Salon_Title'), channels);
  assert.notEqual(world.bridge.structure, order);
});
