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
// -----------------------------------------------------------------------------

import { matcher } from './config.js';
import { baseType, isSecurityItem, mapItem } from './mapping.js';
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
  const ignored = new Map();
  let itemCount = 0;

  for (const item of list) {
    const type = baseType(item);
    const equipment = equipmentOf(item);
    if (isSecurityItem(item, equipment)) {
      security.add(item.name);
    }
    if (SILENT_TYPES.has(type) || !selected(item, equipment)) {
      continue;
    }
    const features = mapItem(item, {
      allowSecurity: options.allowSecurity,
      equipment,
      // A Dimmer or Color gets its own on/off unless a Switch of its equipment is that on/off.
      standalone: !equipment || !switchPoints.has(equipment.name),
    });
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
      if (f.read) {
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
