// -----------------------------------------------------------------------------
// A complete test world: the SDK's fake Gladys (a real GladysIntegration on an
// in-memory transport), the integration wired on it by registerHandlers, and
// the fake openHAB. Short timings: everything settles in milliseconds.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { createLogger } from '@gladysassistant/integration-sdk';
import { registerHandlers } from '../../src/app.js';
import { TOKEN, createOpenhab } from './fakeOpenhab.js';

export const FAST_TIMINGS = {
  reconnectMin: 20,
  reconnectMax: 80,
  authRetry: 200,
  inventoryDebounce: 20,
  pollInterval: 60_000,
  refreshInterval: 60 * 60_000,
  streamSilence: 60_000,
  streamRetryMax: 80,
  commandReadBack: 20,
  musicDebounce: 20,
  musicMaxWait: 80,
};
export const FAST_PUBLISHER = { flushInterval: 10 };

export const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

/** Waits for a condition, failing with `what` after a while. */
export async function until(check, { what = 'the condition', timeout = 2000 } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

export const baseConfig = (extra = {}) => ({
  url: 'http://192.0.2.10:8080',
  token: TOKEN,
  ...extra,
});

/**
 * @param {object} [options]
 * @param {object} [options.oh] the fake openHAB (default: the real item list)
 * @param {object} [options.config] integration config (default: the fake's address and token)
 * @param {object[]} [options.devices] devices already added in Gladys
 */
export async function createWorld({
  oh = createOpenhab(),
  config,
  devices = [],
  connect = true,
  waitOnline = true,
  logger = createLogger({ level: 'silent' }),
  timings = FAST_TIMINGS,
} = {}) {
  const gladys = createFakeGladys({ config: config ?? baseConfig(), devices });
  const app = registerHandlers(gladys, {
    fetch: oh.fetch,
    timings,
    publisherTimings: FAST_PUBLISHER,
    logger,
  });
  if (connect) {
    await gladys.connect();
    await app.ready;
    if (waitOnline && !oh.down) {
      await until(() => app.bridge.status === 'online', { what: 'openHAB online' });
      if (oh.sse) {
        await until(() => app.bridge.live, { what: 'the event stream' });
      }
    }
  }
  return { gladys, fake: gladys.fake, app, bridge: app.bridge, oh };
}

/** The discovered device holding the features of this item. */
export function deviceOf(world, name) {
  const id = world.bridge.inventory.itemDevice.get(name);
  return world.fake.discoveredDevices.find((d) => d.external_id === id);
}

/** The discovered feature of one item and role. */
export function featureOf(world, name, role) {
  const device = deviceOf(world, name);
  const feature = device?.features.find(
    (f) => f.external_id === `${device.external_id}:${name}-${role}`,
  );
  if (!feature) {
    throw new Error(`No feature ${role} for ${name}`);
  }
  return feature;
}

/** Adds a discovered device to Gladys, like the user in the Discovery tab. */
export async function addDevice(world, device) {
  const created = structuredClone(device);
  await world.fake.deviceCreated(created);
  await settle();
  return created;
}

/** Waits for the publisher's next flush. */
export async function flushed(world) {
  await settle();
  await world.bridge.publisher.flush();
  await settle();
}
