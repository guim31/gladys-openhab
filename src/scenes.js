// -----------------------------------------------------------------------------
// Scene actions (manifest `scene_actions`): send a command to any openHAB
// item (a virtual switch that starts a rule, a String, a group of lights), or
// run an openHAB rule or scene. Items and rules are typed by the scene author:
// the scene editor can only list Gladys devices.
//
// The commands of locks, garage doors and gates follow the same switch as the
// devices (allow_security_commands): a scene is not a way around it, nor is a
// command to a group holding one of them (openHAB passes it to every member).
// -----------------------------------------------------------------------------

import { members } from './inventory.js';

const ITEM = /^[A-Za-z0-9_]+$/;
const RULE = /^[^/\\?#\s]+$/;

/**
 * Refuses a command to a security item, or to a group that holds one, when
 * the configuration does not allow them.
 */
export function guard(bridge, name) {
  if (bridge.config.allowSecurity) {
    return;
  }
  const security = bridge.inventory.security;
  if (security.has(name)) {
    throw bridge.error('security_disabled');
  }
  for (const member of members([...bridge.items.values()], name)) {
    if (security.has(member)) {
      throw bridge.error('security_disabled');
    }
  }
}

export function sceneActions(bridge) {
  return {
    async send_command(fields) {
      const name = String(fields.item ?? '').trim();
      if (!ITEM.test(name)) {
        throw bridge.error('bad_item');
      }
      const command = String(fields.command ?? '').trim();
      if (command === '' || command.length > 1000) {
        throw bridge.error('bad_command');
      }
      guard(bridge, name);
      bridge.logger.info(`Scene action: ${command.slice(0, 40)} to ${name}`);
      await bridge.sendCommand(name, command);
    },

    async run_rule(fields) {
      const uid = String(fields.rule ?? '').trim();
      if (!RULE.test(uid)) {
        throw bridge.error('bad_rule');
      }
      bridge.logger.info(`Scene action: run rule ${uid}`);
      await bridge.runRule(uid);
    },
  };
}

export const SCENE_ACTION_KEYS = ['send_command', 'run_rule'];
