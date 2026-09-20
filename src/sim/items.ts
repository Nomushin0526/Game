/**
 * Consumables: the decoy, the shield and the flash.
 *
 * All three exist to give the runner something to do about a hunter that is
 * faster, out-ranges it and out-damages it. Measurement had shown the runner
 * could not win by evading — its only working win condition was shooting the
 * hunter down — so these are the tools that make breaking contact a real play
 * rather than a hope.
 *
 * Each does its work by denying the hunter information or time, never by
 * out-fighting it:
 * - decoy: gives the hunter the wrong thing to chase
 * - shield: buys seconds to get behind something
 * - flash: takes the hunter's eyes away entirely
 */

import type { ItemKind, SkyTagConfig } from './config.ts';
import type { ArenaBounds } from './flight.ts';
import { add, distance, length, normalize, scale } from './math.ts';
import { entityForward } from './flight.ts';
import type { PhysicsWorld } from './physics.ts';
import {
  NO_ITEM,
  type DecoyState,
  type EntityState,
  type ItemSlotState,
  type PlayerInput,
  type ProjectileState,
  type SimEvent,
} from './types.ts';

export interface ItemContext {
  dt: number;
  config: SkyTagConfig;
  physics: PhysicsWorld;
  /** False during the countdown and once the round is decided. */
  controlEnabled: boolean;
  spawnDecoy: (decoy: DecoyState) => void;
  spawnProjectile: (projectile: ProjectileState) => void;
  nextDecoyId: () => number;
  nextProjectileId: () => number;
}

/** Build the slots a craft carries, from its side's loadout. */
export function createItemSlots(
  team: EntityState['team'],
  config: SkyTagConfig,
): ItemSlotState[] {
  return config.items.loadout[team].map((kind) => ({
    kind,
    charges: config.items[kind].charges,
    cooldown: 0,
  }));
}

/**
 * Tick a craft's item state and act on `input.useItem`.
 * Mutates `entity`; returns whatever the use produced.
 */
export function stepItems(
  entity: EntityState,
  input: PlayerInput,
  ctx: ItemContext,
): SimEvent[] {
  const { dt } = ctx;
  for (const slot of entity.items) slot.cooldown = Math.max(0, slot.cooldown - dt);

  entity.shieldTimer = Math.max(0, entity.shieldTimer - dt);
  if (entity.shieldTimer === 0) entity.shieldPool = 0;
  entity.blindTimer = Math.max(0, entity.blindTimer - dt);

  const index = input.useItem;
  if (index === NO_ITEM || !ctx.controlEnabled || !entity.alive) return [];
  // Being stunned by a crash takes the item hand away too.
  if (entity.stunTimer > 0) return [];

  const slot = entity.items[index];
  if (!slot || slot.charges <= 0 || slot.cooldown > 0) return [];

  slot.charges--;
  slot.cooldown = ctx.config.items[slot.kind].cooldown;
  return use(slot.kind, entity, ctx);
}

function use(kind: ItemKind, entity: EntityState, ctx: ItemContext): SimEvent[] {
  switch (kind) {
    case 'decoy': return deployDecoy(entity, ctx);
    case 'shield': return raiseShield(entity, ctx);
    case 'flash': return throwFlash(entity, ctx);
  }
}

/**
 * Drop a phantom that keeps flying the way the runner was.
 *
 * Inheriting the velocity is the whole trick: it leaves along the course the
 * hunter was already tracking, so breaking away in a different direction at
 * the same moment is what sells it.
 */
function deployDecoy(entity: EntityState, ctx: ItemContext): SimEvent[] {
  const cfg = ctx.config.items.decoy;
  const speed = length(entity.vel);
  const heading = speed > 1 ? normalize(entity.vel) : entityForward(entity);
  const velocity = scale(heading, Math.max(speed * cfg.inheritVelocity, cfg.minSpeed));

  const decoy: DecoyState = {
    id: ctx.nextDecoyId(),
    ownerId: entity.id,
    team: entity.team,
    pos: { ...entity.pos },
    vel: velocity,
    life: cfg.duration,
  };
  ctx.spawnDecoy(decoy);

  return [{ type: 'itemUsed', entityId: entity.id, kind: 'decoy', pos: { ...entity.pos } }];
}

function raiseShield(entity: EntityState, ctx: ItemContext): SimEvent[] {
  const cfg = ctx.config.items.shield;
  entity.shieldTimer = cfg.duration;
  entity.shieldPool = cfg.capacity;
  return [{ type: 'itemUsed', entityId: entity.id, kind: 'shield', pos: { ...entity.pos } }];
}

/** Lob a grenade along the line of sight; `projectile.ts` bursts it on its fuse. */
function throwFlash(entity: EntityState, ctx: ItemContext): SimEvent[] {
  const cfg = ctx.config.items.flash;
  const heading = entityForward(entity);

  const grenade: ProjectileState = {
    id: ctx.nextProjectileId(),
    kind: 'flash',
    ownerId: entity.id,
    team: entity.team,
    pos: add(entity.pos, scale(heading, ctx.config.weapon.muzzleOffset)),
    // Thrown from a moving craft, so it does carry the throw along with it —
    // unlike a bolt, where inheriting velocity would break the AI's aim solve.
    vel: add(entity.vel, scale(heading, cfg.throwSpeed)),
    life: cfg.fuse,
    damage: 0,
  };
  ctx.spawnProjectile(grenade);

  return [{ type: 'itemUsed', entityId: entity.id, kind: 'flash', pos: { ...grenade.pos } }];
}

/**
 * Burst a flash: blind everyone in range who could see it.
 *
 * Line of sight is required, so ducking behind a building saves you, and the
 * thrower is never blinded by their own grenade.
 */
export function detonateFlash(
  grenade: ProjectileState,
  at: { x: number; y: number; z: number },
  entities: readonly EntityState[],
  config: SkyTagConfig,
  physics: PhysicsWorld,
): SimEvent[] {
  const cfg = config.items.flash;
  const events: SimEvent[] = [
    { type: 'flashBurst', projectileId: grenade.id, ownerId: grenade.ownerId, pos: { ...at }, radius: cfg.radius },
  ];

  for (const entity of entities) {
    if (entity.id === grenade.ownerId || !entity.alive) continue;
    if (distance(entity.pos, at) > cfg.radius) continue;
    if (physics.isBlocked(at, entity.pos)) continue;

    entity.blindTimer = Math.max(entity.blindTimer, cfg.blindDuration);
    events.push({ type: 'blinded', entityId: entity.id, duration: cfg.blindDuration });
  }
  return events;
}

export interface DecoyStepResult {
  survivors: DecoyState[];
  events: SimEvent[];
}

/** Fly the decoys on and retire the expired ones. */
export function stepDecoys(
  decoys: readonly DecoyState[],
  ctx: { dt: number; physics: PhysicsWorld; config: SkyTagConfig; bounds: ArenaBounds },
): DecoyStepResult {
  const survivors: DecoyState[] = [];
  const events: SimEvent[] = [];

  for (const decoy of decoys) {
    const step = scale(decoy.vel, ctx.dt);
    const travel = length(step);

    // A phantom that sails through a building gives itself away, so stop it at
    // the wall and let it sit there for the rest of its life.
    if (travel > 1e-9) {
      const direction = scale(step, 1 / travel);
      const hit = ctx.physics.sphereCast(decoy.pos, direction, travel, ctx.config.items.decoy.hitRadius);
      if (hit) {
        decoy.pos = add(decoy.pos, scale(direction, Math.max(0, hit.distance - 0.1)));
        decoy.vel = { x: 0, y: 0, z: 0 };
      } else {
        decoy.pos = add(decoy.pos, step);
      }
      // A phantom that sails out through the invisible wall would lure the
      // hunter somewhere no craft can go, and look wrong doing it. It stops at
      // the boundary the same way a craft does.
      clampToArena(decoy, ctx.bounds);
    }

    decoy.life -= ctx.dt;
    if (decoy.life <= 0) {
      events.push({ type: 'decoyGone', decoyId: decoy.id, pos: { ...decoy.pos }, popped: false });
      continue;
    }
    survivors.push(decoy);
  }
  return { survivors, events };
}

/** Hold a decoy inside the invisible walls, and stop it dead when it arrives. */
function clampToArena(decoy: DecoyState, bounds: ArenaBounds): void {
  const p = decoy.pos;
  const v = decoy.vel;
  if (p.x < bounds.minX) { p.x = bounds.minX; v.x = 0; }
  else if (p.x > bounds.maxX) { p.x = bounds.maxX; v.x = 0; }
  if (p.y < bounds.minY) { p.y = bounds.minY; v.y = 0; }
  else if (p.y > bounds.maxY) { p.y = bounds.maxY; v.y = 0; }
  if (p.z < bounds.minZ) { p.z = bounds.minZ; v.z = 0; }
  else if (p.z > bounds.maxZ) { p.z = bounds.maxZ; v.z = 0; }
}
