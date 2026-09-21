/** Construction of craft state, shared by the world, the tools and the tests. */

import type { SkyTagConfig } from './config.ts';
import { createItemSlots } from './items.ts';
import type { EntityState, Team, Vec3 } from './types.ts';

/** A craft at full health with a full gauge and a cold gun. */
export function createEntity(
  id: number,
  team: Team,
  pos: Vec3,
  config: SkyTagConfig,
  overrides: Partial<EntityState> = {},
): EntityState {
  return {
    id,
    team,
    pos: { ...pos },
    vel: { x: 0, y: 0, z: 0 },
    // Face the arena centre so a craft starts looking at the action.
    aimYaw: Math.atan2(pos.x, pos.z),
    aimPitch: 0,
    hp: config.loadout[team].maxHp,
    boostFuel: config.flight.boostCapacity,
    boosting: false,
    stunTimer: 0,
    heat: 0,
    overheated: false,
    cooldownRemaining: 0,
    fireCooldown: 0,
    dashCooldown: 0,
    ammo: config.loadout[team].ammo,
    sinceLastShot: Number.POSITIVE_INFINITY,
    invulnTimer: 0,
    items: createItemSlots(team, config),
    shieldTimer: 0,
    shieldPool: 0,
    blindTimer: 0,
    revealTimer: 0,
    snareTimer: 0,
    overdriveTimer: 0,
    overchargeTimer: 0,
    shotsFired: 0,
    shotsHit: 0,
    alive: true,
    ...overrides,
  };
}
