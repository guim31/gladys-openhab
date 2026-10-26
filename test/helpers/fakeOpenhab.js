// -----------------------------------------------------------------------------
// A fake openHAB behind an injected `fetch`: the REST routes the bridge uses,
// the event stream (Server-Sent Events), and openHAB's "autoupdate" (a
// command changes the state and emits the change). Built on the items read
// from a real openHAB 5.0.1 (test/fixtures/openhab/items-5.0.1.json, from the
// demo.items beside it) and its answers to errors (401, 404 with a JSON body).
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

export const TOKEN = 'oh.gladys.test-token-not-a-real-one';
export const USER = { username: 'admin', password: 'correct horse' };

const ITEMS = JSON.parse(
  readFileSync(new URL('../fixtures/openhab/items-5.0.1.json', import.meta.url), 'utf8'),
);

/** A copy of the real item list, to change freely in a test. */
export const fixture = () => structuredClone(ITEMS);

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** The state openHAB's autoupdate gives an item after a command. */
function autoupdate(item, command) {
  const type = item.type.split(':')[0];
  const percentOf = (s) => (Number.isFinite(Number(s)) ? String(Number(s)) : null);
  switch (type) {
    case 'Switch':
      return ['ON', 'OFF'].includes(command) ? command : null;
    case 'Dimmer':
      return command === 'ON' ? '100' : command === 'OFF' ? '0' : percentOf(command);
    case 'Color': {
      const [h, s] = String(item.state).split(',');
      if (command === 'ON') return `${h ?? 0},${s ?? 0},100`;
      if (command === 'OFF') return `${h ?? 0},${s ?? 0},0`;
      if (command.includes(',')) return command;
      return percentOf(command) === null ? null : `${h ?? 0},${s ?? 0},${Number(command)}`;
    }
    case 'Rollershutter':
      return command === 'UP' ? '0' : command === 'DOWN' ? '100' : percentOf(command);
    case 'Player':
      return ['PLAY', 'PAUSE'].includes(command) ? command : null;
    case 'Image':
      return null;
    default:
      return command;
  }
}

/**
 * @param {object} [options]
 * @param {object[]} [options.items]
 * @param {'token'|'basic'|'anonymous'} [options.auth] what openHAB accepts
 * @param {boolean} [options.sse] the event stream answers (false: a proxy refuses it)
 * @param {object[]} [options.links] GET /rest/links (an administrator token only, like openHAB)
 */
export function createOpenhab({ items = fixture(), auth = 'token', sse = true, links = [] } = {}) {
  const oh = {
    items,
    links,
    auth,
    sse,
    down: false,
    version: '5.0.1',
    rules: new Set(['good_night']),
    commands: [],
    ranRules: [],
    requests: [],
    streams: new Set(),
  };

  const authorized = (header) => {
    if (header === `Bearer ${TOKEN}`) {
      return true;
    }
    const basic = `Basic ${Buffer.from(`${USER.username}:${USER.password}`).toString('base64')}`;
    if (header === basic) {
      return oh.auth === 'basic';
    }
    // Like openHAB: wrong credentials are refused even when anonymous requests are allowed.
    return header === undefined && oh.auth === 'anonymous';
  };

  oh.emit = (message) => {
    const text = `event: message\ndata: ${JSON.stringify(message)}\n\n`;
    for (const stream of oh.streams) {
      stream.enqueue(new TextEncoder().encode(text));
    }
  };
  oh.alive = () => {
    for (const stream of oh.streams) {
      stream.enqueue(
        new TextEncoder().encode('event: alive\ndata: {"type":"ALIVE","interval":10}\n\n'),
      );
    }
  };
  /** A state change in openHAB (a binding, a rule, another UI). */
  oh.change = (name, value) => {
    const item = oh.items.find((i) => i.name === name);
    const oldValue = item.state;
    item.state = value;
    oh.emit({
      topic: `openhab/items/${name}/statechanged`,
      payload: JSON.stringify({ type: 'Decimal', value, oldType: 'Decimal', oldValue }),
      type: 'ItemStateChangedEvent',
    });
  };
  oh.addItem = (item) => {
    oh.items.push(item);
    oh.emit({
      topic: `openhab/items/${item.name}/added`,
      payload: JSON.stringify(item),
      type: 'ItemAddedEvent',
    });
  };
  /** Cuts every open event stream, like a restart of openHAB or a proxy timeout. */
  oh.cutStreams = () => {
    for (const stream of oh.streams) {
      try {
        stream.close();
      } catch {
        // already closed
      }
    }
    oh.streams.clear();
  };

  oh.fetch = async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url);
    const method = init.method ?? 'GET';
    oh.requests.push(`${method} ${pathname}`);
    if (oh.down) {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    }
    if (!authorized(init.headers?.Authorization)) {
      return new Response('', { status: 401 });
    }
    if (method === 'GET' && pathname === '/rest/') {
      return json({ version: '8', runtimeInfo: { version: oh.version }, measurementSystem: 'SI' });
    }
    if (method === 'GET' && pathname === '/rest/links') {
      // openHAB serves the links to administrators: the token, not anonymous requests.
      if (init.headers?.Authorization !== `Bearer ${TOKEN}`) {
        return new Response('', { status: 401 });
      }
      return json(structuredClone(oh.links));
    }
    if (method === 'GET' && pathname === '/rest/items') {
      return json(structuredClone(oh.items));
    }
    if (method === 'GET' && pathname === '/rest/events') {
      if (!oh.sse) {
        return new Response('', { status: 404 });
      }
      oh.lastTopics = searchParams.get('topics');
      let controller;
      const body = new ReadableStream({
        start(c) {
          controller = c;
        },
      });
      oh.streams.add(controller);
      init.signal?.addEventListener('abort', () => {
        oh.streams.delete(controller);
        try {
          controller.error(new DOMException('aborted', 'AbortError'));
        } catch {
          // already closed
        }
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    const command = pathname.match(/^\/rest\/items\/([^/]+)$/);
    if (method === 'POST' && command) {
      const name = decodeURIComponent(command[1]);
      const item = oh.items.find((i) => i.name === name);
      if (!item) {
        return json({ error: { message: `Item ${name} does not exist!`, 'http-code': 404 } }, 404);
      }
      const body = String(init.body);
      oh.commands.push({ item: name, command: body, type: init.headers?.['Content-Type'] });
      const next = autoupdate(item, body);
      if (next !== null && next !== item.state) {
        oh.change(name, next);
      }
      return new Response(null, { status: 200 });
    }
    const rule = pathname.match(/^\/rest\/rules\/([^/]+)\/runnow$/);
    if (method === 'POST' && rule) {
      const uid = decodeURIComponent(rule[1]);
      if (!oh.rules.has(uid)) {
        return new Response('', { status: 404 });
      }
      oh.ranRules.push(uid);
      return new Response(null, { status: 200 });
    }
    return new Response('', { status: 404 });
  };

  return oh;
}
