// -----------------------------------------------------------------------------
// The bridge: one openHAB server, its items, the live states, the commands
// and the scene events.
//
//   connect    GET /rest/ (version) and /rest/items, with the API token, a
//              user name and password, or nothing (anonymous openHAB);
//   inventory  src/inventory.js -> publishDiscoveredDevices (Discovery tab);
//   live       the event stream (SSE) of openHAB: state changes -> the
//              features of the devices ADDED in Gladys only (the others would
//              be dropped by the core and spend its 300 states/min); items
//              added, removed or updated -> the item list is read again;
//   fallback   no event stream (cut, refused by a proxy): the items are read
//              every 30 s, and the stream is opened again with a growing delay;
//   watchdog   openHAB sends "alive" every 10 s: a silent stream is reopened;
//   commands   onSetValue -> POST /rest/items/{name}; the state change that
//              follows is the feedback;
//   events     watched_items -> trigger `item_changed`;
//   failures   openHAB lost -> unreachable badges, new attempt after 5 s,
//              doubling up to 60 s (refused credentials: every 5 minutes).
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { matcher, normalizeConfig } from './config.js';
import { buildInventory } from './inventory.js';
import { WriteError } from './mapping.js';
import { OhAuthError, OhHttpError, OpenhabClient } from './openhab/client.js';
import { StatePublisher } from './publisher.js';
import { ERRORS, STATUS, localizedError, testMessage } from './texts.js';

export const BRIDGE_TIMINGS = {
  reconnectMin: 5000,
  reconnectMax: 60_000,
  // openHAB 5 answers 401 for a while when it starts: a refusal is tried again within a minute.
  authRetry: 60_000,
  inventoryDebounce: 2000,
  // Without the event stream, the items are read this often.
  pollInterval: 30_000,
  // With it, they are read again hourly anyway: the heartbeat of the values, and a safety net.
  refreshInterval: 60 * 60_000,
  // openHAB sends "alive" every 10 s: a stream silent for longer is dead.
  streamSilence: 35_000,
  streamRetryMax: 5 * 60_000,
  // A command while polling: its result is read back after this delay.
  commandReadBack: 1500,
};

export const TRIGGERS = { ITEM_CHANGED: 'item_changed' };
export const WIDGET_KEY = 'status';

/** Scene events per minute: the core takes 300, a chatty item must not spend them all. */
export const EVENTS_PER_MINUTE = 120;

/** The core refuses a discovered list longer than this (setDiscoveredDevices, 5.2.0). */
export const MAX_DISCOVERED_DEVICES = 2000;

const short = (value, max = 255) => {
  const text = String(value ?? '');
  return text.length > max ? text.slice(0, max) : text;
};

/** What the inventory is built from: a change here offers the devices again. */
const structureOf = (items) =>
  JSON.stringify(
    items.map((i) => [
      i.name,
      i.type,
      i.label,
      i.tags,
      i.groupNames,
      i.groupType,
      i.unitSymbol,
      i.stateDescription?.pattern,
      i.stateDescription?.readOnly,
      i.stateDescription?.minimum,
      i.stateDescription?.maximum,
      i.metadata?.semantics,
    ]),
  );

export class Bridge {
  constructor({
    gladys,
    logger,
    fetch,
    timers = globalThis,
    timings = BRIDGE_TIMINGS,
    clientTimings,
    publisherTimings,
    now = Date.now,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.fetch = fetch;
    this.timers = timers;
    this.timings = { ...BRIDGE_TIMINGS, ...timings };
    this.clientTimings = clientTimings;
    this.now = now;
    this.publisher = new StatePublisher({
      gladys,
      logger,
      now,
      timers,
      timings: publisherTimings,
    });
    this.config = normalizeConfig({});
    this.configKey = undefined;
    this.status = 'not_configured';
    this.version = undefined;
    this.client = undefined;
    /** item name -> item (its `state` kept up to date by the events) */
    this.items = new Map();
    /** item name -> time of its last state change received by the stream */
    this.changedAt = new Map();
    this.structure = undefined;
    this.inventory = buildInventory([], { externalIds: gladys.externalIds.bind(gladys) });
    this.generation = 0;
    this.reconnectTimer = undefined;
    this.inventoryTimer = undefined;
    this.tickTimer = undefined;
    this.streamTimer = undefined;
    this.stream = undefined;
    this.live = false;
    this.streamHealthy = false;
    this.streamSeq = 0;
    this.streamFailing = false;
    this.lastEventAt = 0;
    this.lastRefreshAt = 0;
    this.delay = this.timings.reconnectMin;
    this.streamDelay = this.timings.reconnectMin;
    this.transports = new Map();
    this.eventWindow = [];
    this.eventsDropped = false;
    this.watched = matcher([]);
  }

  // --- Configuration and lifecycle -----------------------------------------------

  /** Applies a configuration; restarts the connection when it changed. */
  async configure(raw) {
    const key = JSON.stringify(raw ?? {});
    if (key === this.configKey && this.status !== 'not_configured') {
      return;
    }
    this.configKey = key;
    this.config = normalizeConfig(raw);
    this.watched = matcher(this.config.watched);
    this.publisher.setInterval(this.config.sensorInterval);
    await this.restart();
  }

  async restart() {
    this.disconnect();
    this.generation += 1;
    this.delay = this.timings.reconnectMin;
    this.streamDelay = this.timings.reconnectMin;
    this.structure = undefined;
    // Nothing of the previous server survives a new configuration.
    this.items = new Map();
    this.changedAt.clear();
    this.transports.clear();
    this.inventory = buildInventory([], { externalIds: this.gladys.externalIds.bind(this.gladys) });
    this.publisher.clear();
    this.publisher.start();
    if (this.config.invalidUrl || !this.config.url) {
      this.status = this.config.invalidUrl ? 'invalid_url' : 'not_configured';
      await this.setConnectionStatus(false, STATUS[this.status]);
      return;
    }
    await this.connect(this.generation);
  }

  /** Stops everything (shutdown, tests). */
  stop() {
    this.generation += 1;
    this.disconnect();
    this.publisher.stop();
  }

  disconnect() {
    for (const timer of [this.reconnectTimer, this.inventoryTimer, this.streamTimer]) {
      this.timers.clearTimeout(timer);
    }
    this.timers.clearInterval(this.tickTimer);
    this.reconnectTimer = undefined;
    this.inventoryTimer = undefined;
    this.streamTimer = undefined;
    this.tickTimer = undefined;
    this.closeStream();
    this.client = undefined;
  }

  closeStream() {
    this.streamSeq += 1;
    const stream = this.stream;
    this.stream = undefined;
    this.live = false;
    stream?.close();
  }

  async setConnectionStatus(connected, message) {
    try {
      await this.gladys.setConnectionStatus(connected, message);
    } catch (err) {
      this.logger.debug(`Connection status not sent: ${err.message}`);
    }
  }

  async connect(generation) {
    if (generation !== this.generation) {
      return;
    }
    if (this.status !== 'unreachable' && this.status !== 'auth_failed') {
      this.status = 'connecting';
    }
    const client = new OpenhabClient({
      baseUrl: this.config.url,
      token: this.config.token,
      username: this.config.username,
      password: this.config.password,
      fetch: this.fetch,
      timings: this.clientTimings,
    });
    let items;
    try {
      const info = await client.getInfo();
      items = await client.getItems();
      this.version = info.version || undefined;
    } catch (err) {
      if (generation === this.generation) {
        await this.onFailure(generation, err);
      }
      return;
    }
    if (generation !== this.generation) {
      return;
    }
    const wasDown = this.status === 'unreachable' || this.status === 'auth_failed';
    this.client = client;
    this.status = 'online';
    this.delay = this.timings.reconnectMin;
    await this.applyItems(items, { force: true });
    this.logger.info(
      `${wasDown ? 'Connected again' : 'Connected'} to openHAB ${this.version ?? ''}: ${this.inventory.devices.length} devices, ${this.inventory.itemCount} items`.replace(
        '  ',
        ' ',
      ),
    );
    await this.setConnectionStatus(true);
    await this.publishTransports();
    this.requestWidgetRefresh();
    this.timers.clearInterval(this.tickTimer);
    this.tickTimer = this.timers.setInterval(() => {
      this.tick(generation).catch((err) => this.logger.debug(`Tick failed: ${err.message}`));
    }, this.timings.pollInterval);
    this.openStream(generation);
  }

  async onFailure(generation, err) {
    const auth = err instanceof OhAuthError;
    const status = auth ? 'auth_failed' : 'unreachable';
    this.timers.clearInterval(this.tickTimer);
    this.tickTimer = undefined;
    this.timers.clearTimeout(this.streamTimer);
    this.closeStream();
    this.client = undefined;
    if (this.status !== status) {
      // One line at the first failure, one at the recovery: not one per attempt.
      this.logger.warn(
        auth
          ? `openHAB refused the access (${err.message})`
          : `openHAB is unreachable: ${err.message}`,
      );
    }
    this.status = status;
    await this.setConnectionStatus(false, STATUS[status]);
    await this.publishTransports();
    this.requestWidgetRefresh();
    this.timers.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = this.timers.setTimeout(
      () => {
        this.reconnectTimer = undefined;
        this.connect(generation).catch((e) => this.logger.error(e.message));
      },
      auth ? this.timings.authRetry : this.delay,
    );
    if (!auth) {
      this.delay = Math.min(this.delay * 2, this.timings.reconnectMax);
    }
  }

  // --- Event stream --------------------------------------------------------------

  async openStream(generation) {
    if (generation !== this.generation || this.status !== 'online' || !this.client) {
      return;
    }
    this.streamSeq += 1;
    const seq = this.streamSeq;
    let stream;
    try {
      stream = await this.client.openEvents((event) => this.onStreamEvent(event, stream));
    } catch (err) {
      if (generation === this.generation && seq === this.streamSeq) {
        this.onStreamDown(generation, err.message);
      }
      return;
    }
    // A newer attempt (after a loss and a reconnection) owns the stream now.
    if (generation !== this.generation || this.status !== 'online' || seq !== this.streamSeq) {
      stream.close();
      return;
    }
    this.stream?.close();
    this.stream = stream;
    this.live = true;
    this.streamHealthy = false;
    this.lastEventAt = this.now();
    stream.done.then(() => {
      if (this.stream === stream) {
        this.stream = undefined;
        this.live = false;
        this.onStreamDown(generation, 'stream ended');
      }
    });
  }

  onStreamDown(generation, reason) {
    if (generation !== this.generation || this.status !== 'online') {
      return;
    }
    if (!this.streamFailing) {
      this.streamFailing = true;
      this.logger.warn(`openHAB event stream unavailable (${reason}): items read every 30 s`);
      this.requestWidgetRefresh();
    }
    this.timers.clearTimeout(this.streamTimer);
    this.streamTimer = this.timers.setTimeout(() => {
      this.streamTimer = undefined;
      this.openStream(generation).catch(() => {});
    }, this.streamDelay);
    this.streamDelay = Math.min(this.streamDelay * 2, this.timings.streamRetryMax);
  }

  onStreamEvent({ event, data }, stream) {
    if (stream && stream !== this.stream) {
      return;
    }
    this.lastEventAt = this.now();
    if (!this.streamHealthy) {
      // Healthy at its first event only: a proxy that accepts the stream and closes it,
      // or buffers it, must not reset the delay nor log a recovery every few seconds.
      this.streamHealthy = true;
      this.streamDelay = this.timings.reconnectMin;
      if (this.streamFailing) {
        this.streamFailing = false;
        this.logger.info('openHAB event stream works again');
        this.requestWidgetRefresh();
        // Changes may have been missed while it was down.
        this.refresh(this.generation).catch(() => {});
      }
    }
    if (event !== 'message') {
      return;
    }
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    const name = String(message?.topic ?? '').split('/')[2];
    if (!name) {
      return;
    }
    if (message.type === 'ItemStateChangedEvent') {
      let payload;
      try {
        payload = JSON.parse(message.payload);
      } catch {
        return;
      }
      this.onStateChanged(name, payload);
      return;
    }
    if (['ItemAddedEvent', 'ItemRemovedEvent', 'ItemUpdatedEvent'].includes(message.type)) {
      this.scheduleInventory();
    }
  }

  onStateChanged(name, { value, oldValue }) {
    const item = this.items.get(name);
    if (!item) {
      // An item created since the last read: the list is read again.
      this.scheduleInventory();
      return;
    }
    const previous = oldValue ?? item.state;
    item.state = value;
    this.changedAt.set(name, this.now());
    if (this.inventory.routes.has(name)) {
      this.pushItem(name);
    }
    if (this.watched(name) && previous !== value) {
      this.sceneEvent(TRIGGERS.ITEM_CHANGED, {
        item: name,
        label: short(item.label || name),
        state: short(value),
        old_state: short(previous),
      });
    }
  }

  /** Every 30 s: the items when the stream is down or the hour has passed, the watchdog. */
  async tick(generation) {
    if (generation !== this.generation || this.status !== 'online') {
      return;
    }
    const now = this.now();
    if (this.live && now - this.lastEventAt > this.timings.streamSilence) {
      this.logger.debug('openHAB event stream silent: reopened');
      // Its end calls onStreamDown, which opens it again.
      this.stream?.close();
    }
    if (!this.live || now - this.lastRefreshAt >= this.timings.refreshInterval) {
      await this.refresh(generation);
    }
  }

  // --- Items and inventory -------------------------------------------------------

  async refresh(generation = this.generation) {
    if (generation !== this.generation || this.status !== 'online' || !this.client) {
      return;
    }
    const started = this.now();
    let items;
    try {
      items = await this.client.getItems();
    } catch (err) {
      if (generation === this.generation && this.status === 'online') {
        await this.onFailure(generation, err);
      }
      return;
    }
    if (generation !== this.generation) {
      return;
    }
    // A change received while the list was read is newer than the list: it is kept.
    for (const item of items) {
      const changed = this.changedAt.get(item?.name);
      if (changed !== undefined && changed >= started && this.items.has(item.name)) {
        item.state = this.items.get(item.name).state;
      }
    }
    await this.applyItems(items);
  }

  /** New item list: states updated, devices offered again when the structure changed. */
  async applyItems(items, { force = false } = {}) {
    const previous = this.items;
    this.items = new Map(items.filter((i) => typeof i?.name === 'string').map((i) => [i.name, i]));
    this.lastRefreshAt = this.now();
    const structure = structureOf([...this.items.values()]);
    if (force || structure !== this.structure) {
      this.structure = structure;
      this.inventory = buildInventory([...this.items.values()], {
        ...this.config,
        externalIds: this.gladys.externalIds.bind(this.gladys),
      });
      await this.publishDevices();
      if (!force) {
        await this.publishTransports();
      }
    }
    // Without the stream, the watched items start their scenes from here.
    for (const [name, item] of this.items) {
      const before = previous.get(name)?.state;
      if (before !== undefined && before !== item.state && this.watched(name)) {
        this.sceneEvent(TRIGGERS.ITEM_CHANGED, {
          item: name,
          label: short(item.label || name),
          state: short(item.state),
          old_state: short(before),
        });
      }
    }
    this.pushAll();
  }

  async publishDevices() {
    if (!this.gladys.connected) {
      return;
    }
    let devices = this.inventory.devices;
    if (devices.length > MAX_DISCOVERED_DEVICES) {
      // The core refuses the whole list beyond it: the first ones are offered.
      this.logger.warn(
        `${devices.length} devices: only the first ${MAX_DISCOVERED_DEVICES} are offered, narrow the selection`,
      );
      devices = devices.slice(0, MAX_DISCOVERED_DEVICES);
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  scheduleInventory(delay = this.timings.inventoryDebounce) {
    if (this.inventoryTimer) {
      return;
    }
    const generation = this.generation;
    this.inventoryTimer = this.timers.setTimeout(() => {
      this.inventoryTimer = undefined;
      this.refresh(generation).catch((err) =>
        this.logger.warn(`Reading the openHAB items failed: ${err.message}`),
      );
    }, delay);
  }

  /** Scan button, widget "Reload": the items now, and the devices offered again. */
  async scan() {
    if (this.status === 'online' && this.client) {
      this.structure = undefined;
      await this.refresh();
    } else {
      await this.publishDevices();
    }
  }

  // --- States --------------------------------------------------------------------

  /** The external ids of the features of OUR devices added in Gladys. */
  createdFeatures() {
    const ids = new Set();
    for (const device of this.gladys.devices ?? []) {
      for (const feature of device.features ?? []) {
        ids.add(feature.external_id);
      }
    }
    return ids;
  }

  pushItem(name, created = this.createdFeatures()) {
    const item = this.items.get(name);
    for (const route of this.inventory.routes.get(name) ?? []) {
      if (!item || !created.has(route.featureId)) {
        continue;
      }
      let value;
      try {
        value = route.read(item.state, item);
      } catch {
        value = null;
      }
      if (value !== null && value !== undefined && Number.isFinite(value)) {
        this.publisher.push(route.featureId, value, route.throttle);
      }
    }
  }

  pushAll() {
    const created = this.createdFeatures();
    for (const name of this.inventory.routes.keys()) {
      this.pushItem(name, created);
    }
  }

  /** unreachable for every device while openHAB is. */
  async publishTransports() {
    if (!this.gladys.connected) {
      return;
    }
    const offered = new Set(this.inventory.devices.map((d) => d.external_id));
    const transport =
      this.status === 'online' ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE;
    const entries = [];
    for (const device of this.gladys.devices ?? []) {
      const id = device.external_id;
      if (offered.has(id) && this.transports.get(id) !== transport) {
        this.transports.set(id, transport);
        entries.push({ external_id: id, transport });
      }
    }
    for (let i = 0; i < entries.length; i += 100) {
      try {
        await this.gladys.publishTransports(entries.slice(i, i + 100));
      } catch (err) {
        for (const entry of entries.slice(i, i + 100)) {
          this.transports.delete(entry.external_id);
        }
        this.logger.debug(`Transport badges not sent: ${err.message}`);
      }
    }
  }

  // --- Gladys events -------------------------------------------------------------

  async onGladysConnected() {
    this.transports.clear();
    if (
      this.configKey === undefined ||
      JSON.stringify(this.gladys.config ?? {}) !== this.configKey
    ) {
      await this.configure(this.gladys.config ?? {});
      return;
    }
    await this.publishDevices();
    this.pushAll();
    await this.publishTransports();
  }

  async onDeviceCreated(device) {
    // The SDK forgot the values of this device: they are sent again now.
    this.publisher.forget(device.external_id);
    this.transports.delete(device.external_id);
    this.pushAll();
    await this.publishTransports();
    this.requestWidgetRefresh();
  }

  async onDeviceDeleted(device) {
    this.publisher.forget(device.external_id);
    this.transports.delete(device.external_id);
    this.requestWidgetRefresh();
  }

  requestWidgetRefresh() {
    if (this.gladys.connected) {
      // Fire-and-forget in the SDK: it may return nothing.
      Promise.resolve()
        .then(() => this.gladys.requestWidgetRefresh(WIDGET_KEY))
        .catch(() => {});
    }
  }

  // --- Commands ------------------------------------------------------------------

  error(key, detail = '') {
    return localizedError(ERRORS[key], this.config.language, detail);
  }

  /** One command to one item, the one way out for devices and scenes. */
  async sendCommand(name, command) {
    if (this.status !== 'online' || !this.client) {
      throw this.error('offline');
    }
    try {
      await this.client.sendCommand(name, command);
    } catch (err) {
      throw this.translate(err, name);
    }
    if (!this.live) {
      // No event stream: the result is read back instead of waiting for the next poll.
      this.scheduleInventory(this.timings.commandReadBack);
    }
  }

  async runRule(uid) {
    if (this.status !== 'online' || !this.client) {
      throw this.error('offline');
    }
    try {
      await this.client.runRule(uid);
    } catch (err) {
      throw this.translate(err, uid);
    }
  }

  translate(err, name) {
    if (err instanceof OhAuthError) {
      return this.error('forbidden');
    }
    if (err instanceof OhHttpError && err.status === 404) {
      return this.error('not_found', name);
    }
    return this.error('refused', err.detail || err.message);
  }

  async setValue(device, feature, value) {
    const id = feature.external_id;
    const writer = this.inventory.writers.get(id);
    if (!writer) {
      const name = this.inventory.featureItem.get(id);
      if (name && this.inventory.security.has(name)) {
        throw this.error('security_disabled');
      }
      throw this.error('unknown_feature');
    }
    let command;
    try {
      command = writer.write(value, this.items.get(writer.item));
    } catch (err) {
      if (err instanceof WriteError) {
        throw this.error(err.key);
      }
      throw err;
    }
    this.logger.info(`Command: ${command} to ${writer.item}`);
    await this.sendCommand(writer.item, command);
  }

  // --- Scene events --------------------------------------------------------------

  sceneEvent(key, data) {
    const now = this.now();
    this.eventWindow = this.eventWindow.filter((t) => now - t < 60_000);
    if (this.eventWindow.length >= EVENTS_PER_MINUTE) {
      if (!this.eventsDropped) {
        this.eventsDropped = true;
        this.logger.warn(
          `More than ${EVENTS_PER_MINUTE} openHAB events in a minute: the next ones are dropped`,
        );
      }
      return;
    }
    this.eventsDropped = false;
    this.eventWindow.push(now);
    this.gladys
      .publishSceneEvent(key, data)
      .catch((err) => this.logger.debug(`Scene event ${key} not sent: ${err.message}`));
  }

  // --- Connection test, widget ---------------------------------------------------

  async testConnection() {
    if (this.status === 'online') {
      return testMessage({
        version: this.version ?? '?',
        devices: this.inventory.devices.length,
        items: this.inventory.itemCount,
        ignored: this.inventory.ignored,
      });
    }
    const status = ['connecting', 'online'].includes(this.status) ? 'unreachable' : this.status;
    throw localizedError(STATUS[status], this.config.language);
  }

  summary() {
    const created = new Set((this.gladys.devices ?? []).map((d) => d.external_id));
    const added = this.inventory.devices.filter((d) => created.has(d.external_id));
    let followed = 0;
    for (const [, deviceId] of this.inventory.itemDevice) {
      if (created.has(deviceId)) {
        followed += 1;
      }
    }
    return {
      status: this.status,
      version: this.version,
      live: this.live,
      offered: this.inventory.devices.length,
      added: added.length,
      followed,
    };
  }
}
