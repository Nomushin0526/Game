import { beforeAll, describe, expect, it } from 'vitest';
import { CONFIG, cloneConfig } from '../src/sim/config.ts';
import { boundsFromMap, stepFlight, type FlightContext } from '../src/sim/flight.ts';
import { length } from '../src/sim/math.ts';
import { initPhysics, PhysicsWorld } from '../src/sim/physics.ts';
import { createEntity } from '../src/sim/entity.ts';
import {
  neutralInput,
  type CollisionEvent,
  type EntityState,
  type PlayerInput,
  type SimEvent,
  type Vec3,
} from '../src/sim/types.ts';
import type { MapData } from '../src/maps/types.ts';

/** A 400 m box of empty air with one 40 m cube parked at the origin. */
const TEST_MAP: MapData = {
  id: 'test',
  name: 'Test Box',
  size: { x: 400, z: 400 },
  ceiling: 150,
  floor: 0,
  spawns: [
    { x: -150, y: 60, z: 0 },
    { x: 150, y: 60, z: 0 },
  ],
  solids: [
    { shape: 'box', pos: { x: 0, y: 60, z: 0 }, size: { x: 40, y: 40, z: 40 }, tag: 'building' },
  ],
};

let physics: PhysicsWorld;

beforeAll(async () => {
  await initPhysics();
  physics = new PhysicsWorld(TEST_MAP);
});

function craft(pos: Vec3, overrides: Partial<EntityState> = {}): EntityState {
  const team = overrides.team ?? 'runner';
  return createEntity(0, team, pos, CONFIG, { aimYaw: 0, ...overrides });
}

function context(config = CONFIG): FlightContext {
  return {
    dt: config.sim.fixedDt,
    config,
    physics,
    bounds: boundsFromMap(TEST_MAP),
    controlEnabled: true,
  };
}

function input(overrides: Partial<PlayerInput> = {}): PlayerInput {
  return { ...neutralInput(), ...overrides };
}

/** Run `seconds` of flight, returning every collision that happened. */
function fly(entity: EntityState, cmd: PlayerInput, seconds: number, ctx = context()) {
  const events: SimEvent[] = [];
  for (let i = 0; i < Math.round(seconds * ctx.config.sim.tickRate); i++) {
    events.push(...stepFlight(entity, cmd, ctx));
  }
  return events;
}

/** Only the crash reports, not the damage events they carry with them. */
function crashes(events: SimEvent[]): CollisionEvent[] {
  return events.filter((e): e is CollisionEvent => e.type === 'collision');
}

describe('flight', () => {
  it('accelerates forward up to cruise speed and no further', () => {
    const e = craft({ x: -150, y: 60, z: 100 });
    fly(e, input({ move: { x: 0, y: 0, z: 1 } }), 5);

    expect(length(e.vel)).toBeCloseTo(CONFIG.loadout.runner.cruiseSpeed, 3);
    // Yaw 0 faces -Z.
    expect(e.vel.z).toBeLessThan(0);
    expect(e.pos.z).toBeLessThan(100);
  });

  it('glides when the stick is released, rather than stopping dead', () => {
    const e = craft({ x: -150, y: 60, z: 100 });
    fly(e, input({ move: { x: 0, y: 0, z: 1 } }), 3);
    const cruising = length(e.vel);
    expect(cruising).toBeGreaterThan(20);

    // Speed bleeds off as a fraction per second, so it is well down after a
    // second and still carrying after three. Stopping dead is what made the
    // old model read as flat.
    fly(e, input(), 1);
    expect(length(e.vel)).toBeLessThan(cruising * 0.7);
    expect(length(e.vel)).toBeGreaterThan(cruising * 0.2);

    fly(e, input(), 2);
    expect(length(e.vel)).toBeGreaterThan(0.5);
    expect(length(e.vel)).toBeLessThan(cruising * 0.2);
  });

  it('carries its old heading through a turn instead of pivoting', () => {
    // The point of thrust-and-drag: the velocity you had decays while the one
    // you asked for builds, so a reversal carves rather than snapping over.
    const e = craft({ x: 0, y: 90, z: 0 });
    fly(e, input({ move: { x: 0, y: 0, z: 1 } }), 4);
    const before = e.vel.z;
    expect(before).toBeLessThan(0);

    // Ask for a right-angle turn. The old heading has to bleed off rather
    // than being overwritten, so for a while the craft is going both ways at
    // once and its total speed dips below either.
    fly(e, input({ move: { x: 1, y: 0, z: 0 } }), 0.2);
    expect(e.vel.z).toBeLessThan(0);
    expect(Math.abs(e.vel.x)).toBeGreaterThan(1);
    expect(length(e.vel)).toBeLessThan(Math.abs(before));

    // It does come round, it just takes the time a turn should take.
    fly(e, input({ move: { x: 1, y: 0, z: 0 } }), 3);
    expect(Math.abs(e.vel.z)).toBeLessThan(2);
  });

  it('does not let diagonal input exceed cruise speed', () => {
    const e = craft({ x: -150, y: 60, z: 100 });
    fly(e, input({ move: { x: 1, y: 1, z: 1 } }), 5);
    expect(length(e.vel)).toBeLessThanOrEqual(CONFIG.loadout.runner.cruiseSpeed + 1e-6);
  });

  it('boost raises top speed and drains the gauge, which refills when released', () => {
    const e = craft({ x: -150, y: 60, z: 150 });
    const forward = input({ move: { x: 0, y: 0, z: 1 } });

    // Longer than the old model needed: under drag the approach to terminal
    // velocity is exponential, so it arrives asymptotically rather than at a
    // fixed moment.
    fly(e, { ...forward, boost: true }, 3);
    const boosted = length(e.vel);
    expect(boosted).toBeCloseTo(
      CONFIG.loadout.runner.cruiseSpeed * CONFIG.loadout.runner.boostMultiplier,
      1,
    );
    expect(e.boosting).toBe(true);
    expect(e.boostFuel).toBeCloseTo(CONFIG.flight.boostCapacity - CONFIG.loadout.runner.boostDrain * 3, 2);

    fly(e, forward, 1);
    expect(e.boosting).toBe(false);
    // Settling back to cruise is exponential too, so a second gets close
    // without landing exactly on it.
    expect(length(e.vel)).toBeCloseTo(CONFIG.loadout.runner.cruiseSpeed, 0);
    expect(e.boostFuel).toBeCloseTo(
      CONFIG.flight.boostCapacity - CONFIG.loadout.runner.boostDrain * 3 + CONFIG.loadout.runner.boostRegen,
      2,
    );
  });

  it('cuts boost the moment the gauge empties', () => {
    const e = craft({ x: -150, y: 60, z: 180 }, { boostFuel: 20 });
    const cmd = input({ move: { x: 0, y: 0, z: 1 }, boost: true });
    const ctx = context();

    expect(e.boostFuel).toBeGreaterThan(CONFIG.flight.boostMinToEngage);
    let ticksBoosting = 0;
    while (true) {
      stepFlight(e, cmd, ctx);
      if (!e.boosting) break;
      ticksBoosting++;
      expect(ticksBoosting).toBeLessThan(600);
    }
    expect(e.boostFuel).toBe(0);
    // 20 units at the runner's 26/s drain is a hair under 0.77 s.
    expect(ticksBoosting / CONFIG.sim.tickRate).toBeCloseTo(20 / CONFIG.loadout.runner.boostDrain, 1);
  });

  it('will not re-engage boost until the gauge passes the threshold', () => {
    const cmd = input({ move: { x: 0, y: 0, z: 1 }, boost: true });
    const ctx = context();

    const low = craft({ x: -150, y: 60, z: 180 }, { boostFuel: CONFIG.flight.boostMinToEngage - 1 });
    stepFlight(low, cmd, ctx);
    expect(low.boosting).toBe(false);

    const ready = craft({ x: -150, y: 60, z: 180 }, { boostFuel: CONFIG.flight.boostMinToEngage + 1 });
    stepFlight(ready, cmd, ctx);
    expect(ready.boosting).toBe(true);
  });

  it('refills the gauge while boost is off', () => {
    const e = craft({ x: -150, y: 60, z: 180 }, { boostFuel: 40 });
    fly(e, input({ move: { x: 0, y: 0, z: 1 } }), 1);
    expect(e.boostFuel).toBeCloseTo(40 + CONFIG.loadout.runner.boostRegen, 2);
  });

  it('gives the hunter the faster craft, cruising and boosting', () => {
    const cmd = input({ move: { x: 0, y: 0, z: 1 } });
    const hunter = craft({ x: -150, y: 60, z: 150 }, { team: 'hunter' });
    const runner = craft({ x: -140, y: 60, z: 150 }, { team: 'runner' });
    fly(hunter, cmd, 2);
    fly(runner, cmd, 2);
    expect(length(hunter.vel)).toBeGreaterThan(length(runner.vel));

    const boostedHunter = craft({ x: -150, y: 60, z: 150 }, { team: 'hunter' });
    const boostedRunner = craft({ x: -140, y: 60, z: 150 }, { team: 'runner' });
    fly(boostedHunter, { ...cmd, boost: true }, 2);
    fly(boostedRunner, { ...cmd, boost: true }, 2);
    expect(length(boostedHunter.vel)).toBeGreaterThan(length(boostedRunner.vel));
  });

  it('gives the runner the better boost economy to offset that', () => {
    const cmd = input({ move: { x: 0, y: 0, z: 1 }, boost: true });
    const hunter = craft({ x: -150, y: 60, z: 150 }, { team: 'hunter' });
    const runner = craft({ x: -140, y: 60, z: 150 }, { team: 'runner' });

    // Same time on the throttle: the runner has more gauge left.
    fly(hunter, cmd, 2);
    fly(runner, cmd, 2);
    expect(runner.boostFuel).toBeGreaterThan(hunter.boostFuel);

    // And refills what it spent faster.
    const coast = input({ move: { x: 0, y: 0, z: 1 } });
    const hunterBefore = hunter.boostFuel;
    const runnerBefore = runner.boostFuel;
    fly(hunter, coast, 1);
    fly(runner, coast, 1);
    expect(runner.boostFuel - runnerBefore).toBeGreaterThan(hunter.boostFuel - hunterBefore);
  });

  it('damages and stuns a craft that slams into a building', () => {
    // 30 m clear run straight at the cube's -X face.
    const e = craft({ x: -50, y: 60, z: 0 }, { aimYaw: -Math.PI / 2 });
    const cmd = input({ move: { x: 0, y: 0, z: 1 }, aimYaw: -Math.PI / 2, boost: true });
    const events = crashes(fly(e, cmd, 3));

    expect(events.length).toBeGreaterThan(0);
    const crash = events[0]!;
    expect(crash.impactSpeed).toBeGreaterThanOrEqual(CONFIG.flight.minImpactSpeed);
    expect(crash.damage).toBe(CONFIG.flight.collisionDamage);
    expect(e.hp).toBeLessThanOrEqual(100 - CONFIG.flight.collisionDamage);
    // Stopped outside the wall, never inside it.
    expect(e.pos.x).toBeLessThan(-20 - CONFIG.flight.bodyRadius + 0.2);
  });

  it('ignores steering while stunned but still tracks aim', () => {
    const e = craft({ x: -150, y: 60, z: 0 }, { stunTimer: 0.5 });
    const cmd = input({ move: { x: 0, y: 0, z: 1 }, aimYaw: 1.2 });
    const ctx = context();

    stepFlight(e, cmd, ctx);
    expect(e.aimYaw).toBeCloseTo(1.2, 6);
    expect(length(e.vel)).toBe(0);

    // Control returns once the timer expires.
    fly(e, cmd, 1);
    expect(e.stunTimer).toBe(0);
    expect(length(e.vel)).toBeGreaterThan(0);
  });

  it('slides along a wall instead of snagging on it', () => {
    // Pressed against the cube's -X face, flying along +Z.
    const e = craft({ x: -20 - CONFIG.flight.bodyRadius - 0.01, y: 60, z: -18 });
    const cmd = input({ move: { x: 0, y: 0, z: 1 }, aimYaw: Math.PI });
    const startZ = e.pos.z;
    fly(e, cmd, 2);
    expect(e.pos.z - startZ).toBeGreaterThan(20);
  });

  it('holds the craft inside the invisible walls', () => {
    const bounds = boundsFromMap(TEST_MAP);
    const radius = CONFIG.flight.bodyRadius;

    const up = craft({ x: 150, y: 140, z: 150 });
    fly(up, input({ move: { x: 0, y: 1, z: 0 }, boost: true }), 5);
    expect(up.pos.y).toBeLessThanOrEqual(bounds.maxY - radius + 1e-6);
    expect(up.vel.y).toBe(0);

    const down = craft({ x: 150, y: 10, z: 150 });
    fly(down, input({ move: { x: 0, y: -1, z: 0 }, boost: true }), 5);
    expect(down.pos.y).toBeGreaterThanOrEqual(bounds.minY + radius - 1e-6);

    const east = craft({ x: 150, y: 60, z: 150 });
    fly(east, input({ move: { x: 1, y: 0, z: 0 }, boost: true }), 10);
    expect(east.pos.x).toBeLessThanOrEqual(bounds.maxX - radius + 1e-6);
  });

  it('clamps pitch to the configured limit', () => {
    const e = craft({ x: -150, y: 60, z: 0 });
    stepFlight(e, input({ aimPitch: 3 }), context());
    expect(e.aimPitch).toBeCloseTo(CONFIG.flight.maxPitch, 6);

    stepFlight(e, input({ aimPitch: -3 }), context());
    expect(e.aimPitch).toBeCloseTo(-CONFIG.flight.maxPitch, 6);
  });

  it('freezes control when the context disables it', () => {
    const e = craft({ x: -150, y: 60, z: 0 });
    const ctx = { ...context(), controlEnabled: false };
    fly(e, input({ move: { x: 0, y: 0, z: 1 }, boost: true }), 2, ctx);
    expect(length(e.vel)).toBe(0);
  });

  it('reads all its numbers from config', () => {
    const fast = cloneConfig();
    fast.loadout.runner.cruiseSpeed = 50;
    const e = craft({ x: -150, y: 60, z: 150 });
    fly(e, input({ move: { x: 0, y: 0, z: 1 } }), 5, context(fast));
    expect(length(e.vel)).toBeCloseTo(50, 2);
  });

  it('dashes as an impulse, which then bleeds off like any other speed', () => {
    const e = craft({ x: 0, y: 90, z: 0 });
    const forward = input({ move: { x: 0, y: 0, z: 1 } });
    fly(e, forward, 4);
    const cruising = length(e.vel);

    // One tick with the dash flag: all of it arrives at once.
    fly(e, { ...forward, dash: true }, 1 / 60);
    const dashed = length(e.vel);
    expect(dashed).toBeGreaterThan(cruising + CONFIG.flight.dashImpulse * 0.7);
    expect(e.boostFuel).toBeCloseTo(CONFIG.flight.boostCapacity - CONFIG.flight.dashCost, 2);

    // And then decays back towards cruise rather than being clipped.
    fly(e, forward, 1.5);
    expect(length(e.vel)).toBeLessThan(dashed);
    expect(length(e.vel)).toBeGreaterThan(cruising * 0.9);
  });

  it('will not dash again until the cooldown is up, or with an empty gauge', () => {
    const e = craft({ x: 0, y: 90, z: 0 });
    const dashing = input({ move: { x: 0, y: 0, z: 1 } });

    fly(e, { ...dashing, dash: true }, 1 / 60);
    const after = length(e.vel);
    // Immediately again: refused, so speed only follows the ordinary curve.
    fly(e, { ...dashing, dash: true }, 1 / 60);
    expect(length(e.vel)).toBeLessThan(after + 1);

    const dry = craft({ x: 0, y: 90, z: 0 }, { boostFuel: 1 });
    const before = length(dry.vel);
    fly(dry, { ...dashing, dash: true }, 1 / 60);
    expect(length(dry.vel)).toBeLessThan(before + CONFIG.flight.dashImpulse * 0.5);
    expect(dry.boostFuel).toBeGreaterThan(0);
  });
});