/**
 * Consumables, three to a side.
 *
 * The runner's kit came first, because measurement had shown it could not win
 * by evading a hunter that is faster, out-ranges it and out-damages it — its
 * only working win condition was shooting the hunter down. Each of its three
 * denies the hunter information or time, never out-fighting it:
 * - decoy: gives the hunter the wrong thing to chase
 * - shield: buys seconds to get behind something
 * - flash: takes the hunter's eyes away entirely
 *
 * That worked, and left the opposite hole: the hunter won rounds by knockout
 * and almost never by tagging, which is the win condition the game is named
 * after. Its kit answers the runner's item for item, and all three aim at the
 * tag rather than at the kill:
 * - scan: finds the real craft by instrument, so a decoy or a flash buys
 *   seconds instead of the whole escape
 * - snare: takes the runner's top speed away, which is what it escapes with
 * - overdrive: buys the hunter top speed, which is what it closes with
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
  entity.revealTimer = Math.max(0, entity.revealTimer - dt);
  entity.snareTimer = Math.max(0, entity.snareTimer - dt);
  entity.overdriveTimer = Math.max(0, entity.overdriveTimer - dt);
  entity.overchargeTimer = Math.max(0, entity.overchargeTimer - dt);

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
    case 'scan': return pulseScan(entity, ctx);
    case 'snare': return throwSnare(entity, ctx);
    case 'overdrive': return engageOverdrive(entity, ctx);
    case 'overcharge': return engageOvercharge(entity, ctx);
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
 * Light the enemy up on instruments.
 *
 * Nothing is resolved here: the ping only sets the timer, and whatever reads
 * the craft's contact — `Perception` for the CPU, the radar for a human —
 * applies `items.scan.radius` itself. Keeping the range check at the point of
 * reading is what lets a runner who is genuinely far away still be lost, and
 * keeps this module free of the entity list.
 */
function pulseScan(entity: EntityState, ctx: ItemContext): SimEvent[] {
  entity.revealTimer = ctx.config.items.scan.duration;
  return [{ type: 'itemUsed', entityId: entity.id, kind: 'scan', pos: { ...entity.pos } }];
}

/** Lob a snare charge; `projectile.ts` bursts it on contact or on its fuse. */
function throwSnare(entity: EntityState, ctx: ItemContext): SimEvent[] {
  const cfg = ctx.config.items.snare;
  const heading = entityForward(entity);

  const charge: ProjectileState = {
    id: ctx.nextProjectileId(),
    kind: 'snare',
    ownerId: entity.id,
    team: entity.team,
    pos: add(entity.pos, scale(heading, ctx.config.weapon.muzzleOffset)),
    vel: add(entity.vel, scale(heading, cfg.throwSpeed)),
    life: cfg.fuse,
    damage: 0,
  };
  ctx.spawnProjectile(charge);

  return [{ type: 'itemUsed', entityId: entity.id, kind: 'snare', pos: { ...charge.pos } }];
}

/** Open a window where the gun draws on nothing. */
function engageOvercharge(entity: EntityState, ctx: ItemContext): SimEvent[] {
  entity.overchargeTimer = ctx.config.items.overcharge.duration;
  return [{ type: 'itemUsed', entityId: entity.id, kind: 'overcharge', pos: { ...entity.pos } }];
}

function engageOverdrive(entity: EntityState, ctx: ItemContext): SimEvent[] {
  entity.overdriveTimer = ctx.config.items.overdrive.duration;
  return [{ type: 'itemUsed', entityId: entity.id, kind: 'overdrive', pos: { ...entity.pos } }];
}

/**
 * Burst a snare: slow everyone caught in the field.
 *
 * Deliberately the same shape as a flash burst, radius and line of sight
 * included, so the two read the same way to a player: get something solid
 * between you and the throw and it does not reach you.
 */
export function detonateSnare(
  charge: ProjectileState,
  at: { x: number; y: number; z: number },
  entities: readonly EntityState[],
  config: SkyTagConfig,
  physics: PhysicsWorld,
): SimEvent[] {
  const cfg = config.items.snare;
  const events: SimEvent[] = [
    { type: 'snareBurst', projectileId: charge.id, ownerId: charge.ownerId, pos: { ...at }, radius: cfg.radius },
  ];

  for (const entity of entities) {
    if (entity.id === charge.ownerId || !entity.alive) continue;
    if (distance(entity.pos, at) > cfg.radius) continue;
    if (physics.isBlocked(at, entity.pos)) continue;

    entity.snareTimer = Math.max(entity.snareTimer, cfg.duration);
    events.push({ type: 'snared', entityId: entity.id, duration: cfg.duration });
  }
  return events;
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
