import { beforeAll, describe, expect, it } from 'vitest';
import { interceptTime } from '../src/ai/tactics.ts';
import { loadMap } from '../src/maps/loader.ts';
import { CONFIG, cloneConfig } from '../src/sim/config.ts';
import { add, scale } from '../src/sim/math.ts';
import { initPhysics } from '../src/sim/physics.ts';
import { projectileLifetime } from '../src/sim/projectile.ts';
import { neutralInput, type PlayerInput } from '../src/sim/types.ts';
import { World } from '../src/sim/world.ts';

const map = loadMap('city01');

beforeAll(async () => {
  await initPhysics();
});

describe('interceptTime', () => {
  const origin = { x: 0, y: 0, z: 0 };

  it('is the plain flight time for a stationary target', () => {
    const t = interceptTime(origin, { x: 100, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 200);
    expect(t).toBeCloseTo(0.5, 6);
  });

  it('puts the bolt where a crossing target will be', () => {
    const target = { x: 100, y: 0, z: 0 };
    const velocity = { x: 0, y: 0, z: 40 };
    const speed = 200;
    const t = interceptTime(origin, target, velocity, speed)!;

    // At the solved time the bolt has flown exactly as far as the target is.
    const meeting = add(target, scale(velocity, t));
    expect(Math.hypot(meeting.x, meeting.y, meeting.z)).toBeCloseTo(speed * t, 4);
    // Leading a crossing target takes longer than shooting a still one.
    expect(t).toBeGreaterThan(0.5);
  });

  it('takes longer against a target running away than one closing', () => {
    const target = { x: 100, y: 0, z: 0 };
    const fleeing = interceptTime(origin, target, { x: 50, y: 0, z: 0 }, 200)!;
    const closing = interceptTime(origin, target, { x: -50, y: 0, z: 0 }, 200)!;
    expect(fleeing).toBeGreaterThan(closing);
  });

  it('gives up on a target faster than the bolt and running away', () => {
    expect(interceptTime(origin, { x: 100, y: 0, z: 0 }, { x: 250, y: 0, z: 0 }, 200)).toBeNull();
  });

  it('handles a target moving at exactly bolt speed', () => {
    const t = interceptTime(origin, { x: 100, y: 0, z: 0 }, { x: -200, y: 0, z: 0 }, 200);
    expect(t).not.toBeNull();
    expect(t!).toBeGreaterThan(0);
  });
});

describe('projectiles in the world', () => {
  function liveWorld(seed = 1) {
    const config = cloneConfig();
    config.rules.countdown = 0;
    config.rules.timeLimit = 30;
    const world = new World({ map, config, seed });
    world.skipCountdown();
    return { world, config };
  }

  /** Point both craft at each other, well apart, and hold the trigger. */
  function faceOff(world: World, gap = 60): PlayerInput[] {
    const hunter = world.entityByTeam('hunter')!;
    const runner = world.entityByTeam('runner')!;
    hunter.pos = { x: 0, y: 100, z: 0 };
    runner.pos = { x: 0, y: 100, z: -gap };
    // Yaw 0 faces -Z, so the hunter looks straight at the runner.
    return [
      { ...neutralInput(), aimYaw: 0, fire: true },
      { ...neutralInput(), aimYaw: Math.PI, fire: false },
    ];
  }

  it('puts bolts in the world and clears them once they land', () => {
    const { world, config } = liveWorld();
    const inputs = faceOff(world);

    world.step(inputs);
    expect(world.projectiles.length).toBe(1);

    // Long enough for everything fired to have hit or expired.
    world.stepFor(projectileLifetime(config, 'hunter') + 0.5, [neutralInput(), neutralInput()]);
    expect(world.projectiles).toHaveLength(0);
    world.dispose();
  });

  it('damages the craft a bolt reaches, a moment after it was fired', () => {
    const { world, config } = liveWorld();
    const inputs = faceOff(world, 60);
    const runner = world.entityByTeam('runner')!;

    world.step(inputs);
    // The bolt has not crossed 60 m in one tick.
    expect(runner.hp).toBe(config.loadout.runner.maxHp);

    const flight = 60 / config.loadout.hunter.projectileSpeed + 2 * config.sim.fixedDt;
    world.stepFor(flight, [inputs[0]!, neutralInput()]);
    expect(runner.hp).toBeLessThan(config.loadout.runner.maxHp);
    world.dispose();
  });

  it('clears bolts between rounds', () => {
    const { world } = liveWorld();
    world.stepFor(0.3, faceOff(world));
    expect(world.projectiles.length).toBeGreaterThan(0);

    world.restartRound();
    expect(world.projectiles).toHaveLength(0);
    world.dispose();
  });

  it('keeps bolts in the snapshot so a replay stays exact', () => {
    const { world } = liveWorld();
    const inputs = faceOff(world);
    world.stepFor(0.2, inputs);
    expect(world.projectiles.length).toBeGreaterThan(0);

    const mid = world.snapshot();
    world.stepFor(0.5, inputs);
    const end = world.snapshot();

    world.restore(mid);
    world.stepFor(0.5, inputs);
    expect(world.snapshot()).toEqual(end);
    world.dispose();
  });

  it('stays deterministic with bolts in the air', () => {
    const run = (): unknown => {
      const { world } = liveWorld(4);
      world.stepFor(1.5, faceOff(world));
      const snapshot = world.snapshot();
      world.dispose();
      return snapshot;
    };
    expect(run()).toEqual(run());
  });

  it('gives a bolt a flight time proportional to range over speed', () => {
    for (const team of ['hunter', 'runner'] as const) {
      const loadout = CONFIG.loadout[team];
      expect(projectileLifetime(CONFIG, team)).toBeCloseTo(
        loadout.range / loadout.projectileSpeed,
        6,
      );
    }
  });
});
