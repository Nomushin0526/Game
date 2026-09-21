/**
 * The beam gun: trigger, heat and ammunition, and putting bolts in the air.
 *
 * Firing spawns a projectile rather than resolving a hit immediately. Whether
 * it connects is decided later, in `projectile.ts`, once the bolt has flown —
 * so the shot is aimed at where the target is going to be, not where it is.
 */

import type { SkyTagConfig } from './config.ts';
import { entityForward } from './flight.ts';
import { spawnProjectile } from './projectile.ts';
import type { EntityState, PlayerInput, ProjectileState, SimEvent } from './types.ts';

export interface WeaponContext {
  dt: number;
  config: SkyTagConfig;
  /** False during the countdown and after the round is decided. */
  controlEnabled: boolean;
  /** Called with each bolt the gun puts in the air. */
  spawn: (projectile: ProjectileState) => void;
  /** Supplies the id for the next bolt. */
  nextProjectileId: () => number;
}

/**
 * Advance one craft's gun by `dt` and launch a bolt if it fired.
 * Mutates `shooter`; hits are resolved later by `stepProjectiles`.
 */
export function stepWeapon(
  shooter: EntityState,
  input: PlayerInput,
  ctx: WeaponContext,
): SimEvent[] {
  const { dt, config } = ctx;
  const loadout = config.loadout[shooter.team];
  const events: SimEvent[] = [];

  shooter.fireCooldown = Math.max(0, shooter.fireCooldown - dt);
  shooter.invulnTimer = Math.max(0, shooter.invulnTimer - dt);
  shooter.sinceLastShot += dt;

  if (shooter.overheated) {
    shooter.cooldownRemaining = Math.max(0, shooter.cooldownRemaining - dt);
    if (shooter.cooldownRemaining === 0) {
      shooter.overheated = false;
      shooter.heat = 0;
    }
    return events;
  }

  if (!canFire(shooter, input, ctx)) {
    // Heat bleeds off between bursts only. The delay matters: most ticks inside
    // a burst are waiting on `fireInterval`, and decaying through those would
    // mean a held trigger could never overheat.
    if (shooter.sinceLastShot >= config.weapon.heatDecayDelay) {
      shooter.heat = Math.max(0, shooter.heat - config.weapon.heatDecay * dt);
    }
    return events;
  }

  shooter.fireCooldown = loadout.fireInterval;
  shooter.sinceLastShot = 0;
  shooter.shotsFired++;
  // Overcharge is the one thing that fires for free; heat still applies, so it
  // is a window of sustained fire rather than an infinite one.
  if (shooter.overchargeTimer <= 0) shooter.ammo--;
  shooter.heat = Math.min(loadout.heatCapacity, shooter.heat + 1);
  if (shooter.heat >= loadout.heatCapacity) {
    shooter.overheated = true;
    shooter.cooldownRemaining = loadout.cooldownTime;
    events.push({ type: 'overheat', entityId: shooter.id });
  }

  events.push(...launch(shooter, ctx));
  return events;
}

function canFire(shooter: EntityState, input: PlayerInput, ctx: WeaponContext): boolean {
  return (
    input.fire &&
    ctx.controlEnabled &&
    shooter.alive &&
    shooter.stunTimer <= 0 &&
    shooter.fireCooldown <= 0 &&
    (shooter.ammo > 0 || shooter.overchargeTimer > 0)
  );
}

/** Put a bolt in the air along the craft's current aim. */
function launch(shooter: EntityState, ctx: WeaponContext): SimEvent[] {
  const dir = entityForward(shooter);
  const projectile = spawnProjectile(ctx.nextProjectileId(), shooter, dir, ctx.config);
  ctx.spawn(projectile);

  return [
    {
      type: 'fire',
      shooterId: shooter.id,
      projectileId: projectile.id,
      origin: { ...projectile.pos },
      dir,
    },
  ];
}
