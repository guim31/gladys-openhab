# gladys-openhab

[Gladys Assistant](https://gladysassistant.com) external integration that
bridges **openHAB**: the items of an openHAB 4.x or 5.x server become Gladys
devices, their states follow openHAB live, and Gladys controls them through
openHAB, which keeps its bindings. Local only. Not affiliated with the openHAB
Foundation.

> Tested against a real openHAB 5.0.1 in Docker with virtual items, and for the music player a
> real Squeezebox (binding, Lyrion Music Server, squeezelite) and an offline Sonos thing: feedback
> from real installations is welcome.

## What it does

- **Discovery**: one Gladys device per equipment of the openHAB semantic model
  (a lamp with its switch, dimmer and colour points), or per item outside any
  equipment. Filters by group (at any depth), by tag, and by item name.
- **Items**: `Switch` (switch, light, lock, detectors), `Dimmer` (brightness,
  volume), `Color` (colour and brightness), `Rollershutter` (shutter or curtain
  with open/close/stop and position), `Contact` (opening sensor), `Player`
  (playback state and commands), `Number` with a dimension (temperature,
  humidity, pressure, illuminance, power, energy, voltage, current, volume,
  speed, noise, CO2, battery) and temperature setpoints (thermostat).
- **Gladys 5.3 Music player**: an equipment holding a `Player` item becomes a player of the
  Music widget (artwork, title, artist, album, progress, seek, shuffle, repeat, mute, stop), from
  the items of that equipment linked to recognised channels of the same thing (Squeezebox, Sonos,
  Chromecast, Kodi, HEOS, UPnP…). No configuration; needs an administrator token (the links).
- **Live states** through the openHAB event stream (`/rest/events`, Server-Sent
  Events), with a watchdog on its 10-second "alive" events, and polling every
  30 s when the stream does not get through (reverse proxy).
- **Safety**: locks, garage doors and gates are read-only unless allowed; a
  scene cannot get around it, not even through a group.
- **Scene trigger** "openHAB item changed" for the watched items (Strings, alarm
  modes, anything), **scene actions** "send a command to an item" and "run a
  rule", a **dashboard widget** with the connection, the stream state and a
  reload button, and a **connection test** listing what was not imported.
- Four languages (English, French, German, Spanish).

## Requirements

- Gladys Assistant 5.3.0 or later.
- openHAB 4.x or 5.x reachable from the Gladys machine, and an API token (or a
  user and password with basic authentication enabled, or nothing if openHAB
  accepts anonymous requests).

## Installation

In Gladys: **Integrations → Install from GitHub**, address
`https://github.com/guim31/gladys-openhab`. Then follow the
[documentation](docs/en.md).

## How it works

- `GET /rest/` (version) and `GET /rest/items?recursive=false&metadata=semantics`
  build the inventory (`src/inventory.js`, `src/mapping.js`): items, groups,
  semantic equipments (`isPointOf`) and locations (`hasLocation`).
- `GET /rest/events?topics=openhab/items/*/statechanged,…/added,…/removed,…/updated`
  carries the changes; an added, removed or updated item makes the bridge read
  the item list again (debounced).
- Commands are `POST /rest/items/{name}` with a `text/plain` body (`ON`, `40`,
  `UP`, `0,100,50`); openHAB's state change is the feedback.
- `GET /rest/links` (administrators only) gives the channel of each item: in an equipment
  holding a `Player`, the items linked to a recognised channel id (`title`, `currenttitle`,
  `coverartdata`, `currentPlayingTime`, `shuffle`, `repeat`, `mute`, `stop`… of the same thing,
  `src/music.js`) become its music features, published with `publishNowPlaying` once per burst
  of changes. `Image` states (data URIs) are the artwork, served from memory and reduced under
  300 KB in pure JavaScript (`src/artwork-resize.js`, from gladys-mopidy).
- External ids are built from item names, which openHAB never changes:
  `equipment:<group>` or `item:<name>` for devices, `<item>-<role>` for
  features.
- States are sent only for the devices added in Gladys, only when they change
  (12 h heartbeat), within the 300 states per minute of the core.

Pitfalls met on the real openHAB 5.0.1 (see `CLAUDE.md`): a
`Number:Dimensionless` without `unit` metadata stores 48 % as `0.48`; cubic
metres arrive as `㎥` (U+33A5); a `Number:Temperature` with a °F pattern is
stored in °C on an SI system.

## Development

```bash
npm install
npm test                                        # node --test, no network
npm run lint && npm run format:check
npx github:GladysAssistant/integration-store .  # store admission checks
```

`test/fixtures/openhab/items-5.0.1.json` is the item list of a real openHAB
5.0.1 (Docker image `openhab/openhab:5.0.1`) loaded with
`test/fixtures/openhab/demo.items`, and `events-5.0.1.txt` a capture of its
event stream; addresses are replaced by documentation ones.
`test/helpers/fakeOpenhab.js` serves them through an injected `fetch`;
`test/gladys-rules.test.js` checks every device against the feature table of
the Gladys core.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release.

## Credits

- [openHAB](https://github.com/openhab/openhab-core) (EPL-2.0): the REST API,
  the semantic tags and the item types, read as documentation; its Docker image
  for the fixtures and the tests.
- [kubawolanin/ha-openhab](https://github.com/kubawolanin/ha-openhab) and
  [python-openhab](https://github.com/sim0nx/python-openhab): the openHAB
  integration of Home Assistant and its library, the references of the same
  bridge on the Home Assistant side.
- [guim31/gladys-homeassistant](https://github.com/guim31/gladys-homeassistant)
  (Apache-2.0), whose bridge structure is reused, and
  [LM1LC3N7/gladys-homey](https://github.com/LM1LC3N7/gladys-homey)
  (Apache-2.0), the origin of the state publisher (`src/publisher.js`).

## Limits

Not imported: `String`, `DateTime`, `Location`, `Call`, `Image` and group
items (watch them with the scene trigger, command them with the scene action),
except the ones a music player uses, and `Number` items without unit nor meaning.
No catalog, search or queue for players: openHAB has no standard for them. The
music player was checked with a real Squeezebox only.
See the [documentation](docs/en.md#limits).

## License

Apache-2.0, see [LICENSE](LICENSE). openHAB is a trademark of the openHAB
Foundation e.V.; this project is not affiliated with it.
