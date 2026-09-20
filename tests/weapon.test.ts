import { beforeAll, describe, expect, it } from 'vitest';
import { CONFIG, cloneConfig } from '../src/sim/config.ts';
import { createEntity } from '../src/sim/entity.ts';
import { initPhysics, PhysicsWorld } from '../src/sim/physics.ts';
import { neutralInput, type BeamEvent, type DamageEvent, type EntityState, type PlayerInput, type SimEvent, type Vec3 } from '../src/sim/types.ts';
import { raySphere, stepWeapon, type WeaponContext } from '../src/sim/weapon.ts';
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

function ctx(config = CONFIG): WeaponContext {
  return { dt: config.sim.fixedDt, config, physics, controlEnabled: true };
}

/** Yaw that faces +X, i.e. along the positive X axis. */
const FACE_PLUS_X = -Math.PI / 2;

function shooter(pos: Vec3, team: 'hunter' | 'runner' = 'hunter', config = CONFIG): EntityState {
  return createEntity(0, team, pos, config, { aimYaw: FACE_PLUS_X, aimPitch: 0 });
}

function target(pos: Vec3, team: 'hunter' | 'runner' = 'runner', config = CONFIG): EntityState {
  return createEntity(1, team, pos, config);
}

const firing: PlayerInput = { ...neutralInput(), fire: true, aimYaw: FACE_PLUS_X };

/** Hold the trigger for `seconds` and collect everything that came out. */
function hold(
  s: EntityState,
  others: EntityState[],
  seconds: number,
  context = ctx(),
  cmd: PlayerInput = firing,
): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < Math.round(seconds * context.config.sim.tickRate); i++) {
    events.push(...stepWeapon(s, cmd, others, context));
  }
  return events;
}

const beams = (events: SimEvent[]) => events.filter((e): e is BeamEvent => e.type === 'beam');
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

describe('weapon', () => {
  it('fires on the trigger and emits a beam', () => {
    const s = shooter({ x: -150, y: 60, z: 100 });
    const events = beams(hold(s, [], CONFIG.sim.fixedDt));
    expect(events).toHaveLength(1);
    expect(events[0]!.shooterId).toBe(0);
    expect(events[0]!.hitEntityId).toBeNull();
    expect(s.shotsFired).toBe(1);
  });

  it('respects the per-team fire interval', () => {
    const hunterShots = beams(hold(shooter({ x: -150, y: 60, z: 100 }, 'hunter'), [], 1)).length;
    const runnerShots = beams(hold(shooter({ x: -150, y: 60, z: 110 }, 'runner'), [], 1)).length;
    // 1 s at 0.18 s and 0.22 s intervals.
    expect(hunterShots).toBe(Math.floor(1 / CONFIG.loadout.hunter.fireInterval) + 1);
    expect(runnerShots).toBe(Math.floor(1 / CONFIG.loadout.runner.fireInterval) + 1);
    expect(hunterShots).toBeGreaterThan(runnerShots);
  });

  it('does not fire without the trigger, while stunned, or when control is off', () => {
    expect(beams(hold(shooter({ x: -150, y: 60, z: 100 }), [], 1, ctx(), neutralInput()))).toHaveLength(0);

    const stunned = shooter({ x: -150, y: 60, z: 100 });
    stunned.stunTimer = 5;
    expect(beams(hold(stunned, [], 1))).toHaveLength(0);

    const locked = { ...ctx(), controlEnabled: false };
    expect(beams(hold(shooter({ x: -150, y: 60, z: 100 }), [], 1, locked))).toHaveLength(0);

    const dead = shooter({ x: -150, y: 60, z: 100 });
    dead.alive = false;
    expect(beams(hold(dead, [], 1))).toHaveLength(0);
  });

  it('hits an enemy in the line of fire and takes the right damage off', () => {
    const s = shooter({ x: -50, y: 60, z: 100 }, 'hunter');
    const t = target({ x: -10, y: 60, z: 100 });
    const events = hold(s, [t], CONFIG.sim.fixedDt);

    expect(beams(events)[0]!.hitEntityId).toBe(1);
    const hit = damage(events)[0]!;
    expect(hit.targetId).toBe(1);
    expect(hit.sourceId).toBe(0);
    expect(hit.cause).toBe('beam');
    expect(hit.amount).toBe(CONFIG.loadout.hunter.damage);
    expect(t.hp).toBe(CONFIG.loadout.runner.maxHp - CONFIG.loadout.hunter.damage);
    expect(s.shotsHit).toBe(1);
  });

  it('gives the hunter the harder-hitting gun', () => {
    expect(CONFIG.loadout.hunter.damage).toBeGreaterThan(CONFIG.loadout.runner.damage);

    const hunterTarget = target({ x: -10, y: 60, z: 100 }, 'runner');
    hold(shooter({ x: -50, y: 60, z: 100 }, 'hunter'), [hunterTarget], CONFIG.sim.fixedDt);

    const runnerTarget = createEntity(1, 'hunter', { x: -10, y: 60, z: 140 }, CONFIG);
    hold(shooter({ x: -50, y: 60, z: 140 }, 'runner'), [runnerTarget], CONFIG.sim.fixedDt);

    expect(hunterTarget.hp).toBeLessThan(runnerTarget.hp);
  });

  it('cannot shoot through a wall', () => {
    // Shooter at x = -20 facing +X, target at x = +20, wall across x = 0.
    const s = shooter({ x: -20, y: 60, z: 0 }, 'hunter');
    const t = target({ x: 20, y: 60, z: 0 });
    const events = hold(s, [t], CONFIG.sim.fixedDt);

    expect(beams(events)[0]!.hitEntityId).toBeNull();
    expect(damage(events)).toHaveLength(0);
    expect(t.hp).toBe(CONFIG.loadout.runner.maxHp);
    // The beam stops at the wall face, not at the target.
    expect(beams(events)[0]!.end.x).toBeCloseTo(-1, 1);
  });

  it('cannot hit past its range', () => {
    const range = CONFIG.loadout.hunter.range;
    const s = shooter({ x: -150, y: 60, z: 100 }, 'hunter');
    const far = target({ x: -150 + range + 10, y: 60, z: 100 });
    expect(beams(hold(s, [far], CONFIG.sim.fixedDt))[0]!.hitEntityId).toBeNull();

    const near = target({ x: -150 + range - 10, y: 60, z: 100 });
    const fresh = shooter({ x: -150, y: 60, z: 100 }, 'hunter');
    expect(beams(hold(fresh, [near], CONFIG.sim.fixedDt))[0]!.hitEntityId).toBe(1);
  });

  it('never hits a craft that is already down', () => {
    const s = shooter({ x: -50, y: 60, z: 100 }, 'hunter');
    const t = target({ x: -10, y: 60, z: 100 });
    t.alive = false;
    expect(beams(hold(s, [t], CONFIG.sim.fixedDt))[0]!.hitEntityId).toBeNull();
  });

  it('kills a craft whose HP reaches zero', () => {
    const s = shooter({ x: -50, y: 60, z: 100 }, 'hunter');
    const t = target({ x: -10, y: 60, z: 100 });
    t.hp = CONFIG.loadout.hunter.damage;
    const events = hold(s, [t], CONFIG.sim.fixedDt);

    expect(t.alive).toBe(false);
    expect(t.hp).toBe(0);
    expect(events.some((e) => e.type === 'death' && e.entityId === 1)).toBe(true);
  });

  it('overheats after heatCapacity shots held down, then recovers', () => {
    const config = cloneConfig();
    config.weapon.heatDecay = 0; // isolate the burst limit from the decay
    const s = shooter({ x: -150, y: 60, z: 100 }, 'hunter', config);
    const loadout = config.loadout.hunter;

    const burst = hold(s, [], loadout.fireInterval * loadout.heatCapacity, ctx(config));
    expect(beams(burst)).toHaveLength(loadout.heatCapacity);
    expect(s.overheated).toBe(true);
    expect(burst.some((e) => e.type === 'overheat')).toBe(true);

    // Locked out for the whole cool-down, whatever the trigger is doing.
    const locked = hold(s, [], loadout.cooldownTime - 0.1, ctx(config));
    expect(beams(locked)).toHaveLength(0);

    hold(s, [], 0.2, ctx(config), neutralInput());
    expect(s.overheated).toBe(false);
    expect(s.heat).toBe(0);
    expect(beams(hold(s, [], config.sim.fixedDt, ctx(config)))).toHaveLength(1);
  });

  it('overheats on a sustained burst with the shipped numbers', () => {
    const s = shooter({ x: -150, y: 60, z: 100 }, 'hunter');
    const loadout = CONFIG.loadout.hunter;
    // Holding the trigger must reach the limit in about heatCapacity shots,
    // never mind the idle ticks between them waiting on fireInterval.
    hold(s, [], loadout.fireInterval * loadout.heatCapacity + 0.05);
    expect(s.overheated).toBe(true);
    expect(s.shotsFired).toBe(loadout.heatCapacity);
  });

  it('does not decay heat in the gaps inside a burst', () => {
    const s = shooter({ x: -150, y: 60, z: 100 }, 'hunter');
    hold(s, [], CONFIG.loadout.hunter.fireInterval * 5);
    // Five shots in, five shots of heat: nothing bled off between them.
    expect(s.heat).toBe(5);
  });

  it('bleeds heat off between bursts so short taps never overheat', () => {
    const s = shooter({ x: -150, y: 60, z: 100 }, 'hunter');
    for (let i = 0; i < 10; i++) {
      hold(s, [], 0.4); // ~3 shots
      hold(s, [], 2.0, ctx(), neutralInput()); // long enough to fully recover
    }
    expect(s.overheated).toBe(false);
    expect(s.heat).toBe(0);
    expect(s.shotsFired).toBeGreaterThan(CONFIG.loadout.hunter.heatCapacity);
  });

  it('waits heatDecayDelay after the last shot before recovering', () => {
    const s = shooter({ x: -150, y: 60, z: 100 }, 'hunter');
    hold(s, [], CONFIG.sim.fixedDt); // exactly one shot
    expect(s.heat).toBe(1);
    expect(s.sinceLastShot).toBe(0);

    // Still inside the grace window: nothing has bled off yet.
    hold(s, [], CONFIG.weapon.heatDecayDelay - 0.1, ctx(), neutralInput());
    expect(s.heat).toBe(1);

    hold(s, [], 0.5, ctx(), neutralInput());
    expect(s.heat).toBeLessThan(1);
  });

  it('honours invulnerability when it is switched on', () => {
    const config = cloneConfig();
    config.rules.hitInvulnerability = 0.5;
    const s = shooter({ x: -50, y: 60, z: 100 }, 'hunter', config);
    const t = target({ x: -10, y: 60, z: 100 }, 'runner', config);

    const events = hold(s, [t], 0.5, ctx(config));
    // Several beams land, but only the first one gets through.
    expect(beams(events).filter((b) => b.hitEntityId === 1).length).toBeGreaterThan(1);
    expect(damage(events)).toHaveLength(1);
    expect(t.hp).toBe(config.loadout.runner.maxHp - config.loadout.hunter.damage);
  });
});
