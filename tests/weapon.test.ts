import { beforeAll, describe, expect, it } from 'vitest';
import { CONFIG, cloneConfig } from '../src/sim/config.ts';
import { createEntity } from '../src/sim/entity.ts';
import { raySphere } from '../src/sim/math.ts';
import { initPhysics, PhysicsWorld } from '../src/sim/physics.ts';
import { spawnProjectile, stepProjectiles, type ProjectileContext } from '../src/sim/projectile.ts';
import {
  neutralInput,
  type DamageEvent,
  type EntityState,
  type FireEvent,
  type PlayerInput,
  type ProjectileHitEvent,
  type ProjectileState,
  type SimEvent,
  type Vec3,
} from '../src/sim/types.ts';
import { stepWeapon, type WeaponContext } from '../src/sim/weapon.ts';
import type { MapData } from '../src/maps/types.ts';

/** Open air with a single wall standing at x = 0, spanning z = -20..20. */
const MAP: MapData = {
  id: 'range',
  name: 'Firing Range',
  size: { x: 400, z: 400 },
  ceiling: 150,
  floor: 0,
  spawns: [
    { x: -150, y: 60, z: 0 },
    { x: 150, y: 60, z: 0 },
  ],
  solids: [
    { shape: 'box', pos: { x: 0, y: 60, z: 0 }, size: { x: 2, y: 40, z: 40 }, tag: 'building' },
  ],
};

let physics: PhysicsWorld;

beforeAll(async () => {
  await initPhysics();
  physics = new PhysicsWorld(MAP);
});

/** Yaw that faces +X. */
const FACE_PLUS_X = -Math.PI / 2;
const firing: PlayerInput = { ...neutralInput(), fire: true, aimYaw: FACE_PLUS_X };

function shooter(pos: Vec3, team: 'hunter' | 'runner' = 'hunter', config = CONFIG): EntityState {
  return createEntity(0, team, pos, config, { aimYaw: FACE_PLUS_X, aimPitch: 0 });
}

function target(pos: Vec3, team: 'hunter' | 'runner' = 'runner', config = CONFIG): EntityState {
  return createEntity(1, team, pos, config);
}

/**
 * A miniature world: run the gun and the bolts it produces, the same way
 * `World.step` does, so a test exercises the whole firing path.
 */
class Range {
  readonly projectiles: ProjectileState[] = [];
  readonly events: SimEvent[] = [];
  private nextId = 1;

  constructor(readonly config = CONFIG) {}

  private get weaponCtx(): WeaponContext {
    return {
      dt: this.config.sim.fixedDt,
      config: this.config,
      controlEnabled: true,
      spawn: (p) => this.projectiles.push(p),
      nextProjectileId: () => this.nextId++,
    };
  }

  private get projectileCtx(): ProjectileContext {
    return { dt: this.config.sim.fixedDt, config: this.config, physics };
  }

  /** Hold the trigger for `seconds`, stepping bolts alongside. */
  run(craft: EntityState, others: EntityState[], seconds: number, cmd: PlayerInput = firing): SimEvent[] {
    const produced: SimEvent[] = [];
    const ticks = Math.round(seconds * this.config.sim.tickRate);
    for (let i = 0; i < ticks; i++) {
      produced.push(...stepWeapon(craft, cmd, this.weaponCtx));
      const flown = stepProjectiles(this.projectiles, [craft, ...others], [], this.projectileCtx);
      this.projectiles.length = 0;
      this.projectiles.push(...flown.survivors);
      produced.push(...flown.events);
    }
    this.events.push(...produced);
    return produced;
  }
}

/**
 * Seconds for a bolt to cross `metres`, plus a tick of slack.
 * Derived rather than hard-coded so these tests keep meaning the same thing
 * when the balance numbers are retuned.
 */
function flightTime(metres: number, team: 'hunter' | 'runner' = 'hunter', config = CONFIG): number {
  return metres / config.loadout[team].projectileSpeed + 2 * config.sim.fixedDt;
}

const fires = (events: SimEvent[]) => events.filter((e): e is FireEvent => e.type === 'fire');
const hits = (events: SimEvent[]) =>
  events.filter((e): e is ProjectileHitEvent => e.type === 'projectileHit');
const damage = (events: SimEvent[]) => events.filter((e): e is DamageEvent => e.type === 'damage');

describe('raySphere', () => {
  const origin = { x: 0, y: 0, z: 0 };
  const dir = { x: 1, y: 0, z: 0 };

  it('finds the near intersection', () => {
    expect(raySphere(origin, dir, { x: 10, y: 0, z: 0 }, 2, 100)).toBeCloseTo(8, 6);
  });

  it('misses when the sphere is off to the side', () => {
    expect(raySphere(origin, dir, { x: 10, y: 0, z: 5 }, 2, 100)).toBeNull();
  });

  it('ignores spheres behind the origin', () => {
    expect(raySphere(origin, dir, { x: -10, y: 0, z: 0 }, 2, 100)).toBeNull();
  });

  it('ignores spheres beyond the range', () => {
    expect(raySphere(origin, dir, { x: 50, y: 0, z: 0 }, 2, 10)).toBeNull();
  });

  it('returns 0 when the origin is already inside the sphere', () => {
    expect(raySphere(origin, dir, { x: 1, y: 0, z: 0 }, 3, 100)).toBe(0);
  });
});

describe('firing', () => {
  it('puts a bolt in the air on the trigger', () => {
    const range = new Range();
    const s = shooter({ x: -150, y: 60, z: 100 });
    const events = range.run(s, [], CONFIG.sim.fixedDt);

    expect(fires(events)).toHaveLength(1);
    expect(s.shotsFired).toBe(1);
    expect(range.projectiles).toHaveLength(1);

    const bolt = range.projectiles[0]!;
    expect(bolt.ownerId).toBe(0);
    expect(bolt.damage).toBe(CONFIG.loadout.hunter.damage);
    expect(bolt.vel.x).toBeCloseTo(CONFIG.loadout.hunter.projectileSpeed, 3);
  });

  it('respects the per-team fire interval', () => {
    const hunterShots = fires(new Range().run(shooter({ x: -150, y: 60, z: 100 }, 'hunter'), [], 1)).length;
    const runnerShots = fires(new Range().run(shooter({ x: -150, y: 60, z: 110 }, 'runner'), [], 1)).length;
    expect(hunterShots).toBe(Math.floor(1 / CONFIG.loadout.hunter.fireInterval) + 1);
    expect(runnerShots).toBe(Math.floor(1 / CONFIG.loadout.runner.fireInterval) + 1);
    expect(hunterShots).toBeGreaterThan(runnerShots);
  });

  it('does not fire without the trigger, while stunned, dead, or when control is off', () => {
    expect(fires(new Range().run(shooter({ x: -150, y: 60, z: 100 }), [], 1, neutralInput()))).toHaveLength(0);

    const stunned = shooter({ x: -150, y: 60, z: 100 });
    stunned.stunTimer = 5;
    expect(fires(new Range().run(stunned, [], 1))).toHaveLength(0);

    const dead = shooter({ x: -150, y: 60, z: 100 });
    dead.alive = false;
    expect(fires(new Range().run(dead, [], 1))).toHaveLength(0);
  });

  it('overheats on a sustained burst, then recovers', () => {
    const config = cloneConfig();
    config.weapon.heatDecay = 0;
    const range = new Range(config);
    const s = shooter({ x: -150, y: 60, z: 100 }, 'hunter', config);
    const loadout = config.loadout.hunter;

    const burst = range.run(s, [], loadout.fireInterval * loadout.heatCapacity);
    expect(fires(burst)).toHaveLength(loadout.heatCapacity);
    expect(s.overheated).toBe(true);

    expect(fires(range.run(s, [], loadout.cooldownTime - 0.1))).toHaveLength(0);
    range.run(s, [], 0.2, neutralInput());
    expect(s.overheated).toBe(false);
    expect(fires(range.run(s, [], config.sim.fixedDt))).toHaveLength(1);
  });
});

describe('bolts in flight', () => {
  it('travels at the loadout speed and takes real time to arrive', () => {
    const range = new Range();
    const s = shooter({ x: -100, y: 60, z: 100 }, 'hunter');
    const t = target({ x: 0, y: 60, z: 100 });

    // One tick to fire; the bolt is still short of a target 100 m away.
    range.run(s, [t], CONFIG.sim.fixedDt);
    expect(t.hp).toBe(CONFIG.loadout.runner.maxHp);
    expect(range.projectiles[0]!.pos.x).toBeLessThan(-90);

    const events = range.run(s, [t], flightTime(100), neutralInput());
    expect(damage(events).length).toBeGreaterThan(0);
    expect(t.hp).toBe(CONFIG.loadout.runner.maxHp - CONFIG.loadout.hunter.damage);
  });

  it('credits the hit to the craft that fired it', () => {
    const range = new Range();
    const s = shooter({ x: -60, y: 60, z: 100 }, 'hunter');
    const t = target({ x: 0, y: 60, z: 100 });
    range.run(s, [t], flightTime(60));

    expect(s.shotsHit).toBeGreaterThan(0);
    const hit = damage(range.events)[0]!;
    expect(hit.targetId).toBe(1);
    expect(hit.sourceId).toBe(0);
    expect(hit.cause).toBe('beam');
  });

  it('gives the hunter the harder-hitting, faster bolt', () => {
    expect(CONFIG.loadout.hunter.damage).toBeGreaterThan(CONFIG.loadout.runner.damage);
    expect(CONFIG.loadout.hunter.projectileSpeed).toBeGreaterThan(CONFIG.loadout.runner.projectileSpeed);
  });

  it('stops at a wall instead of passing through it', () => {
    const range = new Range();
    const s = shooter({ x: -40, y: 60, z: 0 }, 'hunter');
    const t = target({ x: 40, y: 60, z: 0 });
    const events = range.run(s, [t], flightTime(80));

    expect(t.hp).toBe(CONFIG.loadout.runner.maxHp);
    const wallHits = hits(events).filter((h) => !h.expired && h.hitEntityId === null);
    expect(wallHits.length).toBeGreaterThan(0);
    // The wall's near face is at x = -1.
    expect(wallHits[0]!.pos.x).toBeLessThan(0);
  });

  it('expires at its maximum range', () => {
    const range = new Range();
    const s = shooter({ x: -150, y: 60, z: 100 }, 'hunter');
    const lifetime = CONFIG.loadout.hunter.range / CONFIG.loadout.hunter.projectileSpeed;

    // Where the bolt was spawned, before its first tick of travel.
    const muzzle = s.pos.x + CONFIG.weapon.muzzleOffset;
    range.run(s, [], CONFIG.sim.fixedDt);
    const events = range.run(s, [], lifetime + 0.1, neutralInput());
    const expired = hits(events).filter((h) => h.expired);
    expect(expired).toHaveLength(1);
    // Range is measured from the muzzle, and it stops exactly there rather
    // than overshooting by whatever is left of the final tick.
    expect(expired[0]!.pos.x - muzzle).toBeCloseTo(CONFIG.loadout.hunter.range, 3);
    expect(range.projectiles).toHaveLength(0);
  });

  it('never hits the craft that fired it', () => {
    const range = new Range();
    const s = shooter({ x: -150, y: 60, z: 100 }, 'hunter');
    range.run(s, [], 1);
    expect(s.hp).toBe(CONFIG.loadout.hunter.maxHp);
    expect(damage(range.events)).toHaveLength(0);
  });

  it('never hits a craft that is already down', () => {
    const range = new Range();
    const s = shooter({ x: -60, y: 60, z: 100 }, 'hunter');
    const t = target({ x: 0, y: 60, z: 100 });
    t.alive = false;
    range.run(s, [t], flightTime(60));
    expect(damage(range.events)).toHaveLength(0);
  });

  it('cannot be outrun by a stationary target it has already passed', () => {
    // A bolt sweeps rather than samples: at 185 m/s it covers 3 m per tick,
    // which is wider than a craft, so a point test would shoot straight through.
    const ctx: ProjectileContext = { dt: CONFIG.sim.fixedDt, config: CONFIG, physics };
    const s = shooter({ x: -60, y: 60, z: 100 });
    const t = target({ x: 0, y: 60, z: 100 });
    const bolt = spawnProjectile(1, s, { x: 1, y: 0, z: 0 }, CONFIG);

    let live = [bolt];
    let struck = false;
    for (let i = 0; i < 240 && live.length > 0; i++) {
      const result = stepProjectiles(live, [s, t], [], ctx);
      live = result.survivors;
      if (result.events.some((e) => e.type === 'projectileHit' && e.hitEntityId === 1)) struck = true;
    }
    expect(struck).toBe(true);
    expect(t.hp).toBeLessThan(CONFIG.loadout.runner.maxHp);
  });

  it('kills a craft whose HP reaches zero', () => {
    const range = new Range();
    const s = shooter({ x: -60, y: 60, z: 100 }, 'hunter');
    const t = target({ x: 0, y: 60, z: 100 });
    t.hp = CONFIG.loadout.hunter.damage;
    const events = range.run(s, [t], flightTime(60));

    expect(t.alive).toBe(false);
    expect(events.some((e) => e.type === 'death' && e.entityId === 1)).toBe(true);
  });

  it('honours invulnerability when it is switched on', () => {
    const config = cloneConfig();
    config.rules.hitInvulnerability = 0.5;
    const range = new Range(config);
    const s = shooter({ x: -40, y: 60, z: 100 }, 'hunter', config);
    const t = target({ x: 0, y: 60, z: 100 }, 'runner', config);

    const events = range.run(s, [t], flightTime(40, 'hunter', config) + 0.5);
    expect(hits(events).filter((h) => h.hitEntityId === 1).length).toBeGreaterThan(1);
    expect(damage(events)).toHaveLength(1);
  });

  it('lets a craft outrun a bolt aimed where it used to be', () => {
    // The whole point of travelling bolts: a shot at a stationary point misses
    // a target that has moved on by the time it arrives.
    const ctx: ProjectileContext = { dt: CONFIG.sim.fixedDt, config: CONFIG, physics };
    const s = shooter({ x: -120, y: 60, z: 100 });
    const t = target({ x: 0, y: 60, z: 100 });
    const bolt = spawnProjectile(1, s, { x: 1, y: 0, z: 0 }, CONFIG);

    let live = [bolt];
    for (let i = 0; i < 240 && live.length > 0; i++) {
      // The target sidesteps at cruise speed while the bolt is in the air.
      t.pos.z += CONFIG.loadout.runner.cruiseSpeed * CONFIG.sim.fixedDt;
      live = stepProjectiles(live, [s, t], [], ctx).survivors;
    }
    expect(t.hp).toBe(CONFIG.loadout.runner.maxHp);
  });
});
