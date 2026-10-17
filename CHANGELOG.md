# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [1.0.0] - 2026-10-17

### Added

- openHAB bridge: the items of an openHAB 4.x or 5.x server offered in the
  Discovery tab, one device per equipment of the semantic model (or per item),
  filtered by group, tag and name.
- Switches, lights (on/off, brightness, colour), shutters and curtains (open,
  close, stop, position), contacts, detectors (smoke, leak, CO, motion, tamper,
  vibration), players (playback state and commands), volumes, temperature
  setpoints, and sensors with their units (temperature, humidity, pressure,
  illuminance, power, energy, voltage, current, gas and water volume, wind,
  noise, CO2, battery).
- Live states through the openHAB event stream, polling every 30 seconds when
  it does not get through, and unreachable badges when openHAB is down.
- Authentication by API token, by user name and password (basic), or none.
- Locks, garage doors and gates read-only unless allowed in the configuration.
- Scene trigger "openHAB item changed" for the watched items, scene actions
  "Send a command to an openHAB item" and "Run an openHAB rule".
- Dashboard widget: connection, live updates, version, devices offered and
  added, items followed, and a Reload button.
- "Test the connection" action, listing the item types not imported.
- Texts and documentation in English, French, German and Spanish.

[Unreleased]: https://github.com/guim31/gladys-openhab/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/guim31/gladys-openhab/releases/tag/v1.0.0
