// -----------------------------------------------------------------------------
// One openHAB item -> Gladys features (pure).
//
// An item is the object of GET /rest/items (`name`, `type`, `state`, `tags`,
// `groupNames`, `unitSymbol`, `stateDescription`, `metadata.semantics`).
// `mapItem` returns its features, each
//   role      part of the feature external id: never change it,
//   spec      category, type, unit, min, max, read_only, has_feedback,
//   read      (state string, item) -> number | null (null: nothing to publish),
//   write     (value, item) -> the command string POSTed to the item,
//   throttle  a measurement, spaced by the sensor interval,
// or `{ skipped: reason }` when nothing maps it.
//
// Value conventions: openHAB on one side (item types and semantic tags of
// openHAB 4/5), the Gladys core enums on the other (server/utils/constants.js,
// copied: the SDK does not export them). A Rollershutter is 0 when OPEN and
// 100 when CLOSED in openHAB; a Gladys shutter position is 100 when open. A
// Contact is OPEN/CLOSED; a Gladys opening sensor is 0 when OPEN.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { MUSIC_PLAYBACK_STATE, playbackOptions, playbackState } from './music.js';

// Value enums of the Gladys core.
export const COVER_STATE = { STOP: 0, OPEN: 1, CLOSE: -1 };
export const OPENING_SENSOR_STATE = { OPEN: 0, CLOSE: 1 };

const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const BIG = 1e9;

/** The error thrown for a refused write, keyed in src/texts.js ERRORS. */
export class WriteError extends Error {
  constructor(key) {
    super(key);
    this.name = 'WriteError';
    this.key = key;
  }
}

// --- Item helpers -----------------------------------------------------------------

/** `Number:Temperature` -> ['Number', 'Temperature']. */
export const baseType = (item) => String(item?.type ?? '').split(':')[0];
export const dimension = (item) => String(item?.type ?? '').split(':')[1] ?? '';

/** NULL and UNDEF: openHAB has no value. */
export const isUndefined = (state) =>
  state === undefined || state === null || state === 'NULL' || state === 'UNDEF';

/** Every word that describes the item: its tags and its semantic class, lower case. */
export function words(item) {
  const semantics = item?.metadata?.semantics ?? {};
  const list = [
    ...(Array.isArray(item?.tags) ? item.tags : []),
    ...String(semantics.value ?? '').split('_'),
    ...String(semantics.config?.relatesTo ?? '').split('_'),
  ];
  return new Set(list.map((w) => String(w).toLowerCase()).filter(Boolean));
}

/**
 * Units as openHAB writes them, made comparable: NFKC turns "㎥" (U+33A5, what
 * openHAB 5 sends for cubic metres) into "m3" and "℃" into "°C"; "μ" is "µ".
 */
export const normalizeUnit = (unit) =>
  String(unit ?? '')
    .normalize('NFKC')
    .replace(/μ/g, 'µ')
    .trim();

/**
 * The unit shown by a state pattern: "%.1f °C" -> "°C", "%d %%" -> "%",
 * "%.1f %unit%" -> the item unit.
 */
export function patternUnit(item) {
  const pattern = item?.stateDescription?.pattern;
  if (typeof pattern !== 'string') {
    return '';
  }
  return normalizeUnit(
    pattern
      .replace(/%unit%/g, item.unitSymbol ?? '')
      .split('%%')
      .map((part) => part.replace(/%[-#+ 0,(<]*\d*(?:\.\d+)?[a-zA-Z]/g, ''))
      .join('%'),
  );
}

/** "21.5 °C" -> { value: 21.5, unit: '°C' }; "48" -> { value: 48, unit: '' }; NULL -> null. */
export function parseQuantity(state) {
  if (isUndefined(state) || typeof state !== 'string') {
    return null;
  }
  const match = state.trim().match(/^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*(.*)$/);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) ? { value, unit: normalizeUnit(match[2]) } : null;
}

/** "120,100,50" -> { h: 120, s: 100, b: 50 }. */
export function parseHsb(state) {
  if (isUndefined(state) || typeof state !== 'string') {
    return null;
  }
  const parts = state.split(',').map(Number);
  if (parts.length !== 3 || !parts.every(Number.isFinite)) {
    return null;
  }
  return { h: parts[0], s: parts[1], b: parts[2] };
}

/** HSB (degrees, %, %) -> 0xRRGGBB at full brightness: Gladys keeps the brightness apart. */
export function hsbToInt({ h, s }) {
  const sat = clamp(s, 0, 100) / 100;
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * (1 - sat * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return (f(5) << 16) | (f(3) << 8) | f(1);
}

/** 0xRRGGBB -> { h, s } (degrees, %). */
export function intToHs(n) {
  const rgb = clamp(Math.round(Number(n) || 0), 0, 0xffffff);
  const r = ((rgb >> 16) & 255) / 255;
  const g = ((rgb >> 8) & 255) / 255;
  const b = (rgb & 255) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d > 0) {
    if (max === r) {
      h = 60 * (((g - b) / d) % 6);
    } else if (max === g) {
      h = 60 * ((b - r) / d + 2);
    } else {
      h = 60 * ((r - g) / d + 4);
    }
  }
  return { h: Math.round((h + 360) % 360), s: max === 0 ? 0 : Math.round((d / max) * 100) };
}

// --- Units and sensors ------------------------------------------------------------

/** openHAB unit (normalized) -> Gladys unit. */
export const UNITS = {
  '°C': U.CELSIUS,
  '°F': U.FAHRENHEIT,
  K: U.KELVIN,
  '%': U.PERCENT,
  hPa: U.HECTO_PASCAL,
  mbar: U.MILLIBAR,
  Pa: U.PASCAL,
  kPa: U.KILO_PASCAL,
  bar: U.BAR,
  psi: U.PSI,
  lx: U.LUX,
  ppm: U.PPM,
  ppb: U.PPB,
  W: U.WATT,
  kW: U.KILOWATT,
  Wh: U.WATT_HOUR,
  kWh: U.KILOWATT_HOUR,
  MWh: U.MEGAWATT_HOUR,
  V: U.VOLT,
  mV: U.MILLI_VOLT,
  A: U.AMPERE,
  mA: U.MILLI_AMPERE,
  m3: U.CUBIC_METER,
  l: U.LITER,
  L: U.LITER,
  'µg/m3': U.MICROGRAM_PER_CUBIC_METER,
  'm/s': U.METER_PER_SECOND,
  'km/h': U.KILOMETER_PER_HOUR,
  dB: U.DECIBEL,
  'mm/h': U.MILLIMETER_PER_HOUR,
};

const sensor = (category, type, min, max, round = false) => ({ category, type, min, max, round });

/** Display bounds of a temperature (Gladys never applies them to a write). */
const TEMPERATURE_BOUNDS = {
  [U.CELSIUS]: [-60, 150],
  [U.FAHRENHEIT]: [-76, 302],
  [U.KELVIN]: [0, 500],
};

/** Measurements recognised by their unit alone. */
const BY_UNIT = {
  '°C': sensor(C.TEMPERATURE_SENSOR, T.SENSOR.DECIMAL, ...TEMPERATURE_BOUNDS[U.CELSIUS]),
  '°F': sensor(C.TEMPERATURE_SENSOR, T.SENSOR.DECIMAL, ...TEMPERATURE_BOUNDS[U.FAHRENHEIT]),
  K: sensor(C.TEMPERATURE_SENSOR, T.SENSOR.DECIMAL, ...TEMPERATURE_BOUNDS[U.KELVIN]),
  hPa: sensor(C.PRESSURE_SENSOR, T.SENSOR.DECIMAL, 0, BIG),
  mbar: sensor(C.PRESSURE_SENSOR, T.SENSOR.DECIMAL, 0, BIG),
  Pa: sensor(C.PRESSURE_SENSOR, T.SENSOR.DECIMAL, 0, BIG),
  kPa: sensor(C.PRESSURE_SENSOR, T.SENSOR.DECIMAL, 0, BIG),
  bar: sensor(C.PRESSURE_SENSOR, T.SENSOR.DECIMAL, 0, BIG),
  psi: sensor(C.PRESSURE_SENSOR, T.SENSOR.DECIMAL, 0, BIG),
  lx: sensor(C.LIGHT_SENSOR, T.SENSOR.DECIMAL, 0, 200_000),
  W: sensor(C.ENERGY_SENSOR, T.ENERGY_SENSOR.POWER, -BIG, BIG),
  kW: sensor(C.ENERGY_SENSOR, T.ENERGY_SENSOR.POWER, -BIG, BIG),
  Wh: sensor(C.ENERGY_SENSOR, T.ENERGY_SENSOR.INDEX, 0, 1e12),
  kWh: sensor(C.ENERGY_SENSOR, T.ENERGY_SENSOR.INDEX, 0, 1e12),
  MWh: sensor(C.ENERGY_SENSOR, T.ENERGY_SENSOR.INDEX, 0, 1e12),
  V: sensor(C.ENERGY_SENSOR, T.ENERGY_SENSOR.VOLTAGE, 0, 1_000_000),
  mV: sensor(C.ENERGY_SENSOR, T.ENERGY_SENSOR.VOLTAGE, 0, 1_000_000),
  A: sensor(C.ENERGY_SENSOR, T.ENERGY_SENSOR.CURRENT, -BIG, BIG),
  mA: sensor(C.ENERGY_SENSOR, T.ENERGY_SENSOR.CURRENT, -BIG, BIG),
  m3: sensor(C.VOLUME_SENSOR, T.VOLUME_SENSOR.DECIMAL, 0, 1e12),
  l: sensor(C.VOLUME_SENSOR, T.VOLUME_SENSOR.DECIMAL, 0, 1e12),
  L: sensor(C.VOLUME_SENSOR, T.VOLUME_SENSOR.DECIMAL, 0, 1e12),
  'm/s': sensor(C.SPEED_SENSOR, T.SPEED_SENSOR.DECIMAL, 0, 1000),
  'km/h': sensor(C.SPEED_SENSOR, T.SPEED_SENSOR.DECIMAL, 0, 1000),
  dB: sensor(C.NOISE_SENSOR, T.SENSOR.INTEGER, 0, 200, true),
  'mm/h': sensor(C.PRECIPITATION_SENSOR, T.PRECIPITATION_SENSOR.DECIMAL, 0, 10_000),
  ppm: sensor(C.CO2_SENSOR, T.SENSOR.DECIMAL, 0, 100_000),
  ppb: sensor(C.VOC_SENSOR, T.SENSOR.DECIMAL, 0, 100_000),
};

/** Measurements that need a word as well as a unit (a "%" alone says nothing). */
const BY_WORD = [
  { word: /batter/, units: ['%'], def: sensor(C.BATTERY, T.BATTERY.INTEGER, 0, 100, true) },
  { word: /humidity/, units: ['%'], def: sensor(C.HUMIDITY_SENSOR, T.SENSOR.DECIMAL, 0, 100) },
  { word: /^pm25$/, units: ['µg/m3'], def: sensor(C.PM25_SENSOR, T.SENSOR.DECIMAL, 0, 10_000) },
  { word: /^pm10$/, units: ['µg/m3'], def: sensor(C.PM10_SENSOR, T.SENSOR.DECIMAL, 0, 10_000) },
];

/**
 * A Number:Dimensionless without `unit` metadata keeps its state in "one":
 * 48 % is "0.48", 612 ppm is "0.000612" (seen on openHAB 5.0.1). openHAB shows
 * it in the pattern unit, so does the bridge.
 */
const ONE_TO = { '%': 100, ppm: 1e6, ppb: 1e9 };

/** Switches tagged with these are detectors (Point_Alarm or Point_Status): read-only. */
const DETECTORS = [
  [/^smoke$/, C.SMOKE_SENSOR, T.SENSOR.BINARY],
  [/^(water|leak|leakage)$/, C.LEAK_SENSOR, T.SENSOR.BINARY],
  [/^co$/, C.CO_SENSOR, T.SENSOR.BINARY],
  [/^(presence|motion)$/, C.MOTION_SENSOR, T.SENSOR.BINARY],
  [/^lowbattery$/, C.BATTERY_LOW, T.BATTERY_LOW.BINARY],
  [/^(tampered|tamper)$/, C.TAMPER, T.TAMPER.BINARY],
  [/^vibration$/, C.VIBRATION_SENSOR, T.VIBRATION_SENSOR.BINARY],
];

/** Words of the things that open the house: locks, gates, garage and front doors. */
const OPENS_THE_HOUSE = /^(lock|smartlock|garagedoor|gate|frontdoor|door)$/;

/**
 * True for the items whose commands are a security choice: anything that is,
 * or belongs to, a lock, a gate, a garage or front door (a Rollershutter, an
 * impulse Switch, a String or a Number opener alike).
 */
export function isSecurityItem(item, equipment) {
  const all = [...words(item), ...(equipment ? words(equipment) : [])];
  return all.some((w) => OPENS_THE_HOUSE.test(w));
}

const binary = (category, type, extra = {}) => ({ category, type, min: 0, max: 1, ...extra });
const onOff = (state) => (state === 'ON' ? 1 : state === 'OFF' ? 0 : null);
const percent = (state) => {
  const q = parseQuantity(state);
  return q ? clamp(Math.round(q.value), 0, 100) : null;
};
const toCommand = (v) => String(clamp(Math.round(Number(v) || 0), 0, 100));

// --- Item types -------------------------------------------------------------------

function switchItem(item, ctx) {
  const w = ctx.words;
  const all = new Set([...w, ...ctx.equipmentWords]);
  if (all.has('lock') || all.has('smartlock')) {
    return [
      {
        role: 'state',
        main: true,
        spec: binary(C.LOCK, T.LOCK.BINARY),
        read: onOff,
        write: (v) => (Number(v) > 0 ? 'ON' : 'OFF'),
      },
    ];
  }
  if (w.has('alarm') || w.has('status')) {
    const detector = DETECTORS.find(([re]) => [...w].some((x) => re.test(x)));
    if (detector) {
      return [{ role: 'state', main: true, spec: binary(detector[1], detector[2]), read: onOff }];
    }
  }
  const light = w.has('light') || ctx.equipmentWords.has('lightsource') || w.has('lightbulb');
  return [
    {
      role: 'state',
      main: true,
      spec: light ? binary(C.LIGHT, T.LIGHT.BINARY) : binary(C.SWITCH, T.SWITCH.BINARY),
      read: onOff,
      write: (v) => (Number(v) > 0 ? 'ON' : 'OFF'),
    },
  ];
}

/** On/off of a Dimmer or a Color: only when the item is a lamp of its own (no Switch beside it). */
function lightPower(read) {
  return {
    role: 'power',
    main: true,
    spec: binary(C.LIGHT, T.LIGHT.BINARY),
    read,
    write: (v) => (Number(v) > 0 ? 'ON' : 'OFF'),
  };
}

function dimmerItem(item, ctx) {
  if (ctx.words.has('soundvolume') || ctx.words.has('volume')) {
    return [
      {
        role: 'volume',
        main: true,
        spec: { category: C.MUSIC, type: T.MUSIC.VOLUME, min: 0, max: 100, unit: U.PERCENT },
        read: percent,
        write: toCommand,
      },
    ];
  }
  const features = [];
  if (ctx.standalone) {
    features.push(lightPower((s) => (percent(s) === null ? null : percent(s) > 0 ? 1 : 0)));
  }
  features.push({
    role: 'brightness',
    main: !ctx.standalone,
    spec: { category: C.LIGHT, type: T.LIGHT.BRIGHTNESS, min: 0, max: 100, unit: U.PERCENT },
    read: percent,
    write: toCommand,
  });
  return features;
}

function colorItem(item, ctx) {
  const brightness = (s) => {
    const hsb = parseHsb(s);
    return hsb ? clamp(Math.round(hsb.b), 0, 100) : null;
  };
  const features = [];
  if (ctx.standalone) {
    features.push(lightPower((s) => (brightness(s) === null ? null : brightness(s) > 0 ? 1 : 0)));
  }
  features.push(
    {
      role: 'brightness',
      spec: { category: C.LIGHT, type: T.LIGHT.BRIGHTNESS, min: 0, max: 100, unit: U.PERCENT },
      read: brightness,
      write: toCommand,
    },
    {
      role: 'color',
      main: !ctx.standalone,
      spec: { category: C.LIGHT, type: T.LIGHT.COLOR, min: 0, max: 0xffffff },
      read: (s) => {
        const hsb = parseHsb(s);
        return hsb ? hsbToInt(hsb) : null;
      },
      write: (v, current) => {
        // The colour keeps the current brightness; a lamp switched off comes on at full.
        const { h, s } = intToHs(v);
        const b = parseHsb(current?.state)?.b;
        return `${h},${s},${finite(b) && b > 0 ? Math.round(b) : 100}`;
      },
    },
  );
  return features;
}

function rollershutterItem(item, ctx) {
  const all = new Set([...ctx.words, ...ctx.equipmentWords]);
  const sensitive = ctx.sensitive;
  const controllable = !sensitive || ctx.allowSecurity;
  const curtain = all.has('drapes') || all.has('curtain');
  const category = curtain ? C.CURTAIN : C.SHUTTER;
  const types = curtain ? T.CURTAIN : T.SHUTTER;
  const features = [];
  if (controllable) {
    features.push({
      role: 'command',
      main: true,
      spec: { category, type: types.STATE, min: -1, max: 1 },
      read: (s) => {
        const p = percent(s);
        return p === null ? null : p >= 100 ? COVER_STATE.CLOSE : COVER_STATE.OPEN;
      },
      write: (v) => {
        const value = Number(v);
        if (value === COVER_STATE.OPEN) {
          return 'UP';
        }
        if (value === COVER_STATE.CLOSE) {
          return 'DOWN';
        }
        if (value === COVER_STATE.STOP) {
          return 'STOP';
        }
        throw new WriteError('unsupported_value');
      },
    });
  }
  features.push({
    role: 'position',
    main: !controllable,
    spec: { category, type: types.POSITION, min: 0, max: 100, unit: U.PERCENT },
    read: (s) => {
      const p = percent(s);
      return p === null ? null : 100 - p;
    },
    write: controllable
      ? (v) => String(100 - clamp(Math.round(Number(v) || 0), 0, 100))
      : undefined,
  });
  if (sensitive) {
    // Always readable, even when the commands are off: open or closed.
    features.push({
      role: 'contact',
      spec: binary(C.OPENING_SENSOR, T.SENSOR.BINARY),
      read: (s) => {
        const p = percent(s);
        return p === null
          ? null
          : p >= 100
            ? OPENING_SENSOR_STATE.CLOSE
            : OPENING_SENSOR_STATE.OPEN;
      },
    });
  }
  return features;
}

function contactItem() {
  return [
    {
      role: 'state',
      main: true,
      spec: binary(C.OPENING_SENSOR, T.SENSOR.BINARY),
      read: (s) =>
        s === 'OPEN'
          ? OPENING_SENSOR_STATE.OPEN
          : s === 'CLOSED'
            ? OPENING_SENSOR_STATE.CLOSE
            : null,
    },
  ];
}

/**
 * A Player: its playback state, writable since 1.1 (Gladys 5.3: 0 pause,
 * 1 play, 2 stop; max 1 -> 2 makes Gladys offer "Update"), and the 1.0
 * one-shot commands. openHAB has no stop on a Player item: 2 pauses, unless
 * the equipment has a stop channel (src/inventory.js).
 */
function playerItem(item, ctx) {
  const command = (role, type, cmd) => ({
    role,
    spec: { ...binary(C.MUSIC, type), has_feedback: false, keep_history: false },
    write: () => cmd,
  });
  return [
    {
      role: 'playback',
      main: true,
      spec: {
        ...binary(C.MUSIC, T.MUSIC.PLAYBACK_STATE),
        max: 2,
        keep_history: false,
        supported_options: playbackOptions(ctx.language, false),
      },
      read: (s) => playbackState(s),
      write: (v) => {
        const value = Number(v);
        if (value === MUSIC_PLAYBACK_STATE.PLAYING) {
          return 'PLAY';
        }
        if (value === MUSIC_PLAYBACK_STATE.PAUSED || value === MUSIC_PLAYBACK_STATE.IDLE) {
          return 'PAUSE';
        }
        throw new WriteError('unsupported_value');
      },
    },
    command('play', T.MUSIC.PLAY, 'PLAY'),
    command('pause', T.MUSIC.PAUSE, 'PAUSE'),
    command('next', T.MUSIC.NEXT, 'NEXT'),
    command('previous', T.MUSIC.PREVIOUS, 'PREVIOUS'),
  ];
}

function numberItem(item, ctx) {
  const dim = dimension(item);
  // The unit of the values: the item unit, or the pattern one for a plain or dimensionless Number.
  const itemUnit = normalizeUnit(item.unitSymbol);
  const unit = dim && dim !== 'Dimensionless' ? itemUnit : patternUnit(item) || itemUnit;
  const scale = dim === 'Dimensionless' && itemUnit === 'one' ? (ONE_TO[unit] ?? 1) : 1;
  const all = [...ctx.words, ...ctx.equipmentWords, String(item.name).toLowerCase()];
  const read = (round) => (s) => {
    const q = parseQuantity(s);
    if (!q) {
      return null;
    }
    // A state carrying another unit than expected is not converted: dropped.
    if (q.unit !== '' && q.unit !== unit && q.unit !== itemUnit) {
      return null;
    }
    const value = q.unit === '' ? q.value * scale : q.value;
    return round ? Math.round(value) : Math.round(value * 1e6) / 1e6;
  };

  if (ctx.words.has('setpoint')) {
    if (['°C', '°F', 'K'].includes(unit)) {
      const sd = item.stateDescription ?? {};
      const gladysUnit = UNITS[unit];
      const min = finite(sd.minimum) ? sd.minimum : unit === '°F' ? 45 : 7;
      const max = finite(sd.maximum) ? sd.maximum : unit === '°F' ? 95 : 35;
      return [
        {
          role: 'value',
          main: true,
          spec: {
            category: C.THERMOSTAT,
            type: T.THERMOSTAT.TARGET_TEMPERATURE,
            min,
            max,
            unit: gladysUnit,
          },
          read: read(false),
          write: (v) => {
            // Bounded by what openHAB says this item accepts, never clamped:
            // a wrong value is refused rather than turned into another one.
            const value = Number(v);
            if (!finite(value) || value < min || value > max) {
              throw new WriteError('out_of_range');
            }
            return item.unitSymbol && dim ? `${value} ${item.unitSymbol}` : String(value);
          },
        },
      ];
    }
    return { skipped: 'Number:setpoint' };
  }

  const byWord = BY_WORD.find((e) => e.units.includes(unit) && all.some((w) => e.word.test(w)));
  const def = byWord?.def ?? BY_UNIT[unit];
  if (!def) {
    return { skipped: `${item.type}${unit ? ` (${unit})` : ''}` };
  }
  if (def.category === C.CO2_SENSOR && !all.some((w) => /co2|carbondioxide/.test(w))) {
    return { skipped: `${item.type} (${unit})` };
  }
  return [
    {
      role: 'value',
      main: true,
      spec: {
        category: def.category,
        type: def.type,
        min: def.min,
        max: def.max,
        unit: UNITS[unit],
      },
      read: read(def.round),
      throttle: true,
    },
  ];
}

const TYPES = {
  Switch: switchItem,
  Dimmer: dimmerItem,
  Color: colorItem,
  Rollershutter: rollershutterItem,
  Contact: contactItem,
  Player: playerItem,
  Number: numberItem,
};

/**
 * @param {object} item one item of GET /rest/items
 * @param {object} [options]
 * @param {boolean} [options.allowSecurity] locks, garage doors and gates controllable
 * @param {object} [options.equipment] the semantic equipment (Group item) the item is a point of
 * @param {boolean} [options.standalone] the item is a Gladys device of its own
 * @param {string} [options.language] language of the option labels
 * @returns {Array<object> | { skipped: string }}
 */
export function mapItem(
  item,
  { allowSecurity = false, equipment, standalone = true, language = 'fr' } = {},
) {
  const type = baseType(item);
  const build = TYPES[type];
  if (!build) {
    return { skipped: type || 'unknown' };
  }
  const ctx = {
    allowSecurity,
    language,
    sensitive: isSecurityItem(item, equipment),
    standalone,
    words: words(item),
    equipmentWords: equipment ? words(equipment) : new Set(),
  };
  const result = build(item, ctx);
  if (!Array.isArray(result)) {
    return result;
  }
  // Read-only too: the commands of a lock, a gate or a door, unless the user allowed them.
  const readOnly = item.stateDescription?.readOnly === true || (ctx.sensitive && !allowSecurity);
  return result.map((f) => {
    const writable = typeof f.write === 'function' && !readOnly;
    return {
      ...f,
      write: writable ? f.write : undefined,
      spec: {
        keep_history: true,
        ...f.spec,
        read_only: !writable,
        has_feedback: f.spec.has_feedback ?? (writable && typeof f.read === 'function'),
      },
    };
  });
}
