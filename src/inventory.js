// -----------------------------------------------------------------------------
// openHAB items -> Gladys devices and routing tables (pure).
//
// openHAB has no "device" but a semantic model: an Equipment (a Group item
// tagged Lightbulb, Blinds, Lock...) holds Points (the items, with
// `metadata.semantics.config.isPointOf`). One Gladys device per Equipment,
// holding the features of its points; an item outside any equipment is a
// Gladys device of its own. External ids are built from item names, which
// openHAB never changes (renaming an item creates another one):
//   device   ext:<selector>:equipment:<group name> | ext:<selector>:item:<item name>
//   feature  <device id>:<item name>-<role>
//
// Selection (configuration): groups (an item or one of its groups, at any
// depth), tags (of the item or of its equipment), items to exclude. Group
// items themselves are not imported: they are the locations and equipments.
//
// Music players (Gladys 5.3, src/music.js): the first Player item of an
// equipment is its player; the members of the equipment linked to a
// recognised channel of the same thing (links: GET /rest/links) become its
// title, artist, album, artwork, duration, position, shuffle, repeat and mute.
// Those features and the playback state are published through
// publishNowPlaying (`music`), not through the routes. An item already
// imported on another device stays there: a feature never changes device.
// -----------------------------------------------------------------------------

import { matcher } from './config.js';
import { baseType, isSecurityItem, mapItem } from './mapping.js';
import { channelRole, musicFeature, playbackOptions, splitChannel } from './music.js';
import { ROLE_NAMES } from './texts.js';

const cut = (text, max = 100) => String(text ?? '').slice(0, max);

/** Types never listed as "not imported": groups, and the ones Gladys has nothing for. */
const SILENT_TYPES = new Set(['Group']);

/**
 * @param {object[]} items GET /rest/items
 * @param {object} options the normalized configuration (src/config.js) + { externalIds }
 */
export function buildInventory(items, options) {
  const { externalIds, language = 'fr' } = options;
  const links = options.links instanceof Map ? options.links : new Map();
  const list = Array.isArray(items) ? items.filter((i) => typeof i?.name === 'string') : [];
  const byName = new Map(list.map((i) => [i.name, i]));
  const excluded = matcher(options.exclude ?? []);
  const groups = new Set(options.groups ?? []);
  const tags = new Set(options.tags ?? []);
  const roles = ROLE_NAMES[language] ?? ROLE_NAMES.en;

  /** Every group above an item (the model is a graph: an item may sit in many groups). */
  const ancestors = (item) => {
    const seen = new Set();
    const stack = [...(item.groupNames ?? [])];
    while (stack.length > 0) {
      const name = stack.pop();
      if (seen.has(name)) {
        continue;
      }
      seen.add(name);
      stack.push(...(byName.get(name)?.groupNames ?? []));
    }
    return seen;
  };
  const equipmentOf = (item) => {
    const name = item.metadata?.semantics?.config?.isPointOf;
    const group = name ? byName.get(name) : undefined;
    return group && baseType(group) === 'Group' ? group : undefined;
  };
  const locationOf = (item) => {
    const name = item?.metadata?.semantics?.config?.hasLocation;
    return name ? byName.get(name) : undefined;
  };
  const selected = (item, equipment) => {
    if (excluded(item.name)) {
      return false;
    }
    if (groups.size > 0) {
      const names = [...ancestors(item)].flatMap((g) => [
        g.toLowerCase(),
        String(byName.get(g)?.label ?? '').toLowerCase(),
      ]);
      if (!names.some((n) => groups.has(n))) {
        return false;
      }
    }
    if (tags.size > 0) {
      const itemTags = [...(item.tags ?? []), ...(equipment?.tags ?? [])].map((t) =>
        String(t).toLowerCase(),
      );
      if (!itemTags.some((t) => tags.has(t))) {
        return false;
      }
    }
    return true;
  };

  /** Equipments holding a Switch point. */
  const switchPoints = new Set(
    list
      .filter((i) => baseType(i) === 'Switch')
      .map((i) => equipmentOf(i)?.name)
      .filter(Boolean),
  );

  // --- Music players: equipment name -> { player, slots: Map(role -> slot) } ---------
  const imported = (item) =>
    Array.isArray(mapItem(item, { allowSecurity: options.allowSecurity, language }));
  const players = new Map();
  for (const item of [...list].sort((a, b) => a.name.localeCompare(b.name))) {
    const equipment = equipmentOf(item);
    if (baseType(item) !== 'Player' || !equipment || players.has(equipment.name)) {
      continue;
    }
    if (selected(item, equipment)) {
      players.set(equipment.name, { equipment, player: item, slots: new Map() });
    }
  }
  /** item name -> { profile, slot }: the items that become music features */
  const musicSlot = new Map();
  const used = new Set();
  for (const profile of players.values()) {
    const { equipment, player, slots } = profile;
    const things = new Set(
      (links.get(player.name) ?? []).map((uid) => splitChannel(uid)?.thing).filter(Boolean),
    );
    for (const item of list) {
      const member =
        equipmentOf(item)?.name === equipment.name ||
        (item.groupNames ?? []).includes(equipment.name);
      if (item === player || !member || !selected(item, equipment) || used.has(item.name)) {
        continue;
      }
      // An item imported today as a device of its own keeps it.
      if (equipmentOf(item)?.name !== equipment.name && imported(item)) {
        continue;
      }
      for (const uid of links.get(item.name) ?? []) {
        const slot = channelRole(item, uid);
        // Same thing as the Player item: a second player of the equipment is not mixed in.
        if (!slot || (things.size > 0 && !things.has(slot.thing))) {
          continue;
        }
        const current = slots.get(slot.role);
        if (
          !current ||
          slot.rank < current.rank ||
          (slot.rank === current.rank && item.name < current.item.name)
        ) {
          if (current) {
            musicSlot.delete(current.item.name);
            used.delete(current.item.name);
          }
          slots.set(slot.role, { ...slot, item });
          used.add(item.name);
          // The stop switch stays what it is: it is only read (idle) and sent ON (stop).
          if (slot.role !== 'stop') {
            musicSlot.set(item.name, { profile, slot: { ...slot, item } });
          }
        }
        break;
      }
    }
  }

  /** device external id -> { device, names } */
  const devices = new Map();
  /** item name -> [{ featureId, read, throttle }] */
  const routes = new Map();
  /** feature external id -> { item, write } */
  const writers = new Map();
  /** feature external id -> item name, read-only features included */
  const featureItem = new Map();
  /** item name -> device external id */
  const itemDevice = new Map();
  /** item names whose commands are a security choice */
  const security = new Set();
  /** device external id -> { player, stop, title, features: [{ key, featureId, item, read }] } */
  const music = new Map();
  /** item name -> device external ids whose now playing it changes */
  const musicItems = new Map();
  const followMusic = (name, deviceId) => {
    const set = musicItems.get(name) ?? new Set();
    set.add(deviceId);
    musicItems.set(name, set);
  };
  const ignored = new Map();
  let itemCount = 0;

  for (const item of list) {
    const type = baseType(item);
    const attached = musicSlot.get(item.name);
    const equipment = attached?.profile.equipment ?? equipmentOf(item);
    if (isSecurityItem(item, equipment)) {
      security.add(item.name);
    }
    if (SILENT_TYPES.has(type) || !selected(item, equipment)) {
      continue;
    }
    let features = mapItem(item, {
      allowSecurity: options.allowSecurity,
      equipment,
      language,
      // A Dimmer or Color gets its own on/off unless a Switch of its equipment is that on/off.
      standalone: !equipment || !switchPoints.has(equipment.name),
    });
    const profile = attached?.profile ?? players.get(equipment?.name);
    if (attached) {
      // Its external id is kept when it was imported already (a mute Switch: `-state`).
      const featureRole = Array.isArray(features) ? features[0].role : undefined;
      features = [
        musicFeature(item, attached.slot, {
          language,
          featureRole,
          readOnly: item.stateDescription?.readOnly === true,
        }),
      ];
    } else if (profile?.player === item && profile.slots.size > 0 && Array.isArray(features)) {
      // Without any channel attached, the player stays as 1.0: its state through the routes.
      const stop = profile.slots.get('stop')?.item;
      features = features.map((f) => {
        if (f.role !== 'playback') {
          return f;
        }
        const write = f.write;
        return {
          ...f,
          music: 'playback_state',
          spec: { ...f.spec, supported_options: playbackOptions(language, Boolean(stop && write)) },
          // Stop (2): the stop channel of the equipment, when it has one.
          write:
            write && stop
              ? (v, it) => (Number(v) === 2 ? { item: stop.name, command: 'ON' } : write(v, it))
              : write,
        };
      });
    }
    if (!Array.isArray(features)) {
      ignored.set(features.skipped, (ignored.get(features.skipped) ?? 0) + 1);
      continue;
    }

    const ids = equipment
      ? externalIds('equipment', equipment.name)
      : externalIds('item', item.name);
    let entry = devices.get(ids.device);
    if (!entry) {
      const holder = equipment ?? item;
      const base = String(holder.label || holder.name).trim();
      const location = locationOf(holder);
      const where = location ? String(location.label || location.name).trim() : '';
      const name =
        where && !base.toLowerCase().includes(where.toLowerCase()) ? `${base} (${where})` : base;
      entry = {
        names: new Set(),
        device: {
          name: cut(name),
          external_id: ids.device,
          should_poll: false,
          features: [],
          params: [
            equipment
              ? { name: 'openhab_equipment', value: equipment.name }
              : { name: 'openhab_item', value: item.name },
            ...(where ? [{ name: 'openhab_location', value: where }] : []),
          ],
        },
      };
      devices.set(ids.device, entry);
    }
    itemCount += 1;
    itemDevice.set(item.name, ids.device);
    const label = String(item.label || item.name).trim();
    for (const f of features) {
      const featureId = ids.feature(`${item.name}-${f.role}`);
      let name = f.main ? label : `${label} – ${roles[f.role] ?? f.role}`;
      if (entry.names.has(name)) {
        name = `${name} (${item.name})`;
      }
      entry.names.add(name);
      entry.device.features.push({ name: cut(name), external_id: featureId, ...f.spec });
      featureItem.set(featureId, item.name);
      if (f.music) {
        let entry = music.get(ids.device);
        if (!entry) {
          entry = {
            player: profile.player.name,
            stop: profile.slots.get('stop')?.item.name,
            title: profile.slots.get('title')?.item.name,
            features: [],
          };
          music.set(ids.device, entry);
          for (const name of [entry.player, entry.stop, entry.title].filter(Boolean)) {
            followMusic(name, ids.device);
          }
        }
        entry.features.push({ key: f.music, featureId, item: item.name, read: f.read });
        followMusic(item.name, ids.device);
      } else if (f.read) {
        const itemRoutes = routes.get(item.name) ?? [];
        itemRoutes.push({ featureId, read: f.read, throttle: Boolean(f.throttle) });
        routes.set(item.name, itemRoutes);
      }
      if (f.write) {
        writers.set(featureId, { item: item.name, write: f.write });
      }
    }
  }

  return {
    devices: [...devices.values()].map((e) => e.device),
    routes,
    writers,
    featureItem,
    itemDevice,
    itemCount,
    security,
    music,
    musicItems,
    ignored: [...ignored.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  };
}

/** Every item below a group, at any depth (a command to a group reaches them all). */
export function members(items, groupName) {
  const children = new Map();
  for (const item of items ?? []) {
    for (const g of item.groupNames ?? []) {
      const list = children.get(g) ?? [];
      list.push(item.name);
      children.set(g, list);
    }
  }
  const seen = new Set();
  const stack = [...(children.get(groupName) ?? [])];
  while (stack.length > 0) {
    const name = stack.pop();
    if (!seen.has(name)) {
      seen.add(name);
      stack.push(...(children.get(name) ?? []));
    }
  }
  return seen;
}
