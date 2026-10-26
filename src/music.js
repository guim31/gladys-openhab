// -----------------------------------------------------------------------------
// The Gladys 5.3 music player of an openHAB equipment (pure).
//
// openHAB has no "now playing" model: a `Player` item (PLAY/PAUSE/NEXT/
// PREVIOUS) and, beside it, items linked to the channels of the same thing
// (Squeezebox `title`, `artist`, `coverartdata`, `currentPlayingTime`...;
// Sonos `currenttitle`, `currentalbumart`, `shuffle`, `repeat`...; Chromecast
// `title`, `image`, `duration`, `currentTime`...). The bridge reads the links
// (GET /rest/links, an administrator token) and attaches to the player of an
// equipment the items of that equipment linked to a channel recognised by its
// id, on the same thing as the Player item. No configuration: an item that
// does not match stays what it was.
//
// Values: Gladys MUSIC_PLAYBACK_STATE (0 paused, 1 playing, 2 idle) and
// MUSIC_REPEAT_MODE (0 off, 1 all, 2 one); durations and positions in seconds.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
  MUSIC_PLAYBACK_STATE,
  MUSIC_REPEAT_MODE,
} from '@gladysassistant/integration-sdk';
import { WriteError } from './mapping.js';
import { MUSIC_LABELS } from './texts.js';

export { MUSIC_PLAYBACK_STATE, MUSIC_REPEAT_MODE };

/** Display bound of a duration or a position, in seconds. */
export const MAX_MEDIA_SECONDS = 86_400;

/**
 * Channel ids (lower case, without the channel group) of the bindings, by
 * role, best first: Squeezebox, Sonos, Chromecast, Kodi, HEOS, UPnP Control,
 * Spotify, Bose SoundTouch, MPD, Volumio, LinkPlay...
 */
export const MUSIC_CHANNELS = {
  title: ['title', 'currenttitle', 'tracktitle', 'trackname', 'nowplayingtrack', 'songtitle'],
  artist: ['artist', 'currentartist', 'trackartist', 'nowplayingartist', 'albumartist'],
  album: ['album', 'currentalbum', 'albumname', 'nowplayingalbum'],
  artwork: [
    'coverartdata',
    'currentalbumart',
    'albumart',
    'image',
    'cover',
    'coverart',
    'albumimage',
    'artwork',
    'thumbnail',
  ],
  duration: ['duration', 'trackduration', 'currenttrackduration', 'trackdurationms'],
  position: [
    'currentplayingtime',
    'currenttime',
    'currentposition',
    'trackposition',
    'position',
    'elapsedtime',
    'trackpositionms',
    'trackprogressms',
  ],
  shuffle: ['shuffle', 'currentplaylistshuffle', 'random', 'shufflemode'],
  repeat: ['repeat', 'currentplaylistrepeat', 'repeatmode'],
  mute: ['mute'],
  stop: ['stop'],
};

/** The item types each role accepts (base types: `Number:Time` is a Number). */
const ROLE_TYPES = {
  title: ['String'],
  artist: ['String'],
  album: ['String'],
  artwork: ['Image'],
  duration: ['Number', 'String'],
  position: ['Number', 'String'],
  shuffle: ['Switch', 'Number', 'String'],
  repeat: ['Switch', 'Number', 'String'],
  mute: ['Switch'],
  stop: ['Switch'],
};

/** The key of each role in publishNowPlaying. */
export const NOW_PLAYING_KEY = {
  playback: 'playback_state',
  title: 'title',
  artist: 'artist',
  album: 'album',
  artwork: 'artwork_url',
  duration: 'duration',
  position: 'position',
  shuffle: 'shuffle',
  repeat: 'repeat',
  mute: 'mute',
};

const baseType = (item) => String(item?.type ?? '').split(':')[0];
const isUndefined = (s) => s === undefined || s === null || s === 'NULL' || s === 'UNDEF';
const finite = (n) => typeof n === 'number' && Number.isFinite(n);

/** `binding:type:[bridge:]thing:[group#]channel` -> { thing, id } (id lower case, no group). */
export function splitChannel(uid) {
  const parts = String(uid ?? '').split(':');
  if (parts.length < 4) {
    return null;
  }
  const id = parts.at(-1).split('#').at(-1).toLowerCase();
  return { thing: parts.slice(0, -1).join(':'), id };
}

/**
 * The role of an item linked to a channel, with its rank (lower is better),
 * or null.
 * @param {object} item
 * @param {string} channelUID
 */
export function channelRole(item, channelUID) {
  const channel = splitChannel(channelUID);
  if (!channel) {
    return null;
  }
  for (const [role, ids] of Object.entries(MUSIC_CHANNELS)) {
    const rank = ids.indexOf(channel.id);
    if (rank === -1 || !ROLE_TYPES[role].includes(baseType(item))) {
      continue;
    }
    const dim = String(item.type).split(':')[1];
    if (baseType(item) === 'Number' && dim && dim !== 'Time' && dim !== 'Dimensionless') {
      return null;
    }
    if (['shuffle', 'repeat'].includes(role) && baseType(item) !== 'Switch') {
      // A Number or a String mode is only usable with its options (what to send back).
      if (!modeOptions(item, role)) {
        return null;
      }
    }
    return { role, rank, thing: channel.thing, ms: channel.id.endsWith('ms') };
  }
  return null;
}

// --- Values ------------------------------------------------------------------------

/** A text item: '' when openHAB has no value. */
export const text = (state) => (isUndefined(state) ? '' : String(state));

const UNIT_SECONDS = { s: 1, ms: 0.001, min: 60, h: 3600, d: 86_400 };

/**
 * Seconds of a duration or a position: "245 s", "4.08 min", "245000" (a
 * plain Number: seconds, or milliseconds when the channel says so), "4:05"
 * or "1:02:03". Null when unknown.
 */
export function toSeconds(state, { ms = false } = {}) {
  if (isUndefined(state)) {
    return null;
  }
  const s = String(state).trim();
  const clock = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (clock) {
    return Number(clock[1] ?? 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
  }
  const q = s.match(/^([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*(\S*)$/);
  if (!q) {
    return null;
  }
  const value = Number(q[1]);
  const factor = q[2] === '' ? (ms ? 0.001 : 1) : UNIT_SECONDS[q[2]];
  if (!finite(value) || factor === undefined || value < 0) {
    return null;
  }
  return Math.round(value * factor);
}

const OFF_WORDS = new Set(['off', 'none', 'no', 'disabled', 'false', 'normal']);
const ONE_WORDS = new Set(['one', 'single', 'song', 'track']);
const ALL_WORDS = new Set(['all', 'playlist', 'context', 'queue', 'list', 'album', 'on']);
const wordsOf = (...texts) =>
  texts
    .join(' ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** The Gladys mode of one option (or state) of a shuffle or repeat item, or null. */
export function modeOf(role, ...texts) {
  const w = wordsOf(...texts);
  if (w.some((x) => OFF_WORDS.has(x))) {
    return 0;
  }
  if (role === 'shuffle') {
    return w.length > 0 ? 1 : null;
  }
  if (w.some((x) => ONE_WORDS.has(x))) {
    return MUSIC_REPEAT_MODE.ONE;
  }
  if (w.some((x) => ALL_WORDS.has(x))) {
    return MUSIC_REPEAT_MODE.ALL;
  }
  return null;
}

/**
 * The options of a Number or String shuffle/repeat item, by Gladys mode:
 * Map(mode -> openHAB value), the first option of each mode. Null unless
 * there is an "off" option and another one.
 */
export function modeOptions(item, role) {
  const options = item?.stateDescription?.options;
  if (!Array.isArray(options)) {
    return null;
  }
  const byMode = new Map();
  for (const o of options) {
    const mode = modeOf(role, o?.value ?? '', o?.label ?? '');
    if (mode !== null && !byMode.has(mode)) {
      byMode.set(mode, String(o.value));
    }
  }
  return byMode.has(0) && byMode.size > 1 ? byMode : null;
}

/** "data:image/jpeg;base64,..." -> { mime, base64 }, or null. */
export function parseImage(state) {
  if (typeof state !== 'string') {
    return null;
  }
  const match = state.match(/^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/i);
  return match && match[2].length > 0 ? { mime: match[1].toLowerCase(), base64: match[2] } : null;
}

// --- Features ----------------------------------------------------------------------

const options = (values, labels) =>
  values.map((value) => ({ value, label: labels[value], sort_order: value }));

/**
 * The music feature of an item attached to a player.
 * @param {object} item
 * @param {object} slot { role, ms } from channelRole
 * @param {object} context
 * @param {string} context.language
 * @param {string} [context.featureRole] the role (external id part) the item already has
 * @param {boolean} [context.readOnly] openHAB says the item is read-only
 * @returns {object} { role, music, main, spec, read, write }
 */
export function musicFeature(item, slot, { language = 'fr', featureRole, readOnly = false } = {}) {
  const labels = MUSIC_LABELS[language] ?? MUSIC_LABELS.en;
  const type = baseType(item);
  const music = (spec, read, write) => {
    const writable = typeof write === 'function' && !readOnly;
    return {
      role: featureRole ?? slot.role,
      music: NOW_PLAYING_KEY[slot.role],
      main: true,
      spec: {
        category: C.MUSIC,
        min: 0,
        max: 0,
        keep_history: false,
        ...spec,
        read_only: !writable,
        has_feedback: writable,
      },
      read,
      write: writable ? write : undefined,
    };
  };
  const onOff = (s) => (s === 'ON' ? 1 : s === 'OFF' ? 0 : null);
  const switchWrite = (v) => (Number(v) > 0 ? 'ON' : 'OFF');

  switch (slot.role) {
    case 'title':
    case 'artist':
    case 'album':
      return music({ type: T.MUSIC[slot.role.toUpperCase()] }, text);
    case 'artwork':
      return music({ type: T.MUSIC.ARTWORK }, (s) => parseImage(s));
    case 'duration':
      return music({ type: T.MUSIC.DURATION, max: MAX_MEDIA_SECONDS, unit: U.SECONDS }, (s) =>
        toSeconds(s, slot),
      );
    case 'position':
      return music(
        { type: T.MUSIC.POSITION, max: MAX_MEDIA_SECONDS, unit: U.SECONDS },
        (s) => toSeconds(s, slot),
        type === 'Number'
          ? (v) => {
              const seconds = Number(v);
              if (!finite(seconds) || seconds < 0) {
                throw new WriteError('out_of_range');
              }
              const s = Math.round(seconds);
              if (String(item.type).includes(':')) {
                return `${s} s`;
              }
              return String(slot.ms ? s * 1000 : s);
            }
          : undefined,
      );
    case 'mute':
      return music({ type: T.MUSIC.MUTE, max: 1 }, onOff, switchWrite);
    case 'shuffle':
    case 'repeat': {
      const isRepeat = slot.role === 'repeat';
      const spec = isRepeat ? { type: T.MUSIC.REPEAT, max: 2 } : { type: T.MUSIC.SHUFFLE, max: 1 };
      if (type === 'Switch') {
        return music(
          isRepeat ? { ...spec, supported_options: options([0, 1], labels.repeat) } : spec,
          onOff,
          (v) => {
            const mode = Number(v);
            if (![0, 1].includes(mode)) {
              throw new WriteError('unsupported_value');
            }
            return switchWrite(mode);
          },
        );
      }
      const byMode = modeOptions(item, slot.role);
      const values = new Map([...byMode].map(([mode, value]) => [value, mode]));
      return music(
        isRepeat
          ? { ...spec, supported_options: options([...byMode.keys()].sort(), labels.repeat) }
          : spec,
        (s) => (isUndefined(s) ? null : (values.get(String(s)) ?? modeOf(slot.role, s))),
        (v) => {
          const mode = Number(v) > 0 && !isRepeat ? 1 : Number(v);
          const value = byMode.get(mode);
          if (value === undefined) {
            throw new WriteError('unsupported_value');
          }
          return value;
        },
      );
    }
    default:
      return null;
  }
}

/**
 * The playback state of a player, from its Player item and, when the
 * equipment has them, its stop switch and its title: 1 playing; 2 when
 * stopped (the stop switch is ON) or when nothing is loaded (empty title);
 * 0 paused. Null when openHAB has no value.
 */
export function playbackState(player, { stop, title } = {}) {
  if (player === 'PLAY' || player === 'FASTFORWARD' || player === 'REWIND') {
    return MUSIC_PLAYBACK_STATE.PLAYING;
  }
  if (player !== 'PAUSE') {
    return null;
  }
  if (stop === 'ON' || title === '') {
    return MUSIC_PLAYBACK_STATE.IDLE;
  }
  return MUSIC_PLAYBACK_STATE.PAUSED;
}

/** supported_options of a writable playback state (Stop only with a stop channel). */
export const playbackOptions = (language, withStop) =>
  options(withStop ? [0, 1, 2] : [0, 1], (MUSIC_LABELS[language] ?? MUSIC_LABELS.en).playback);
