import { beforeAll, describe, expect, it } from 'vitest';
import { loadMap } from '../src/maps/loader.ts';
import { CONFIG, cloneConfig } from '../src/sim/config.ts';
import { distance } from '../src/sim/math.ts';
import { initPhysics } from '../src/sim/physics.ts';
import { Rng } from '../src/sim/rng.ts';
import { NO_ITEM, neutralInput, type PlayerInput } from '../src/sim/types.ts';
import { World } from '../src/sim/world.ts';

const map = loadMap('city01');

beforeAll(async () => {
  await initPhysics();
});

/** A reproducible, noisy input stream — the point is that it is not neutral. */
function scriptedInputs(seed: number, ticks: number): PlayerInput[][] {
  const rng = new Rng(seed);
  const script: PlayerInput[][] = [];
  for (let t = 0; t < ticks; t++) {
    script.push([0, 1].map(() => ({
      move: { x: rng.range(-1, 1), y: rng.range(-1, 1), z: rng.range(-1, 1) },
      aimYaw: rng.range(-Math.PI, Math.PI),
      aimPitch: rng.range(-1, 1),
      fire: rng.bool(0.3),
      boost: rng.bool(0.4),
      useItem: rng.bool(0.05) ? rng.int(0, 2) : NO_ITEM,
    })));
  }
  return script;
}

function run(seed: number, script: PlayerInput[][]) {
  const world = new World({ map, seed });
  for (const inputs of script) world.step(inputs);
  const snapshot = world.snapshot();
  world.dispose();
  return snapshot;
}

describe('World', () => {
  it('spawns one hunter and one runner by default', () => {
    const world = new World({ map, seed: 1 });
    expect(world.entities.map((e) => e.team)).toEqual(['hunter', 'runner']);
    expect(world.entities.every((e) => e.hp === CONFIG.loadout[e.team].maxHp)).toBe(true);
    expect(world.entities.every((e) => e.boostFuel === CONFIG.flight.boostCapacity)).toBe(true);
    world.dispose();
  });

  it('keeps spawns at least minSpawnDistance apart', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const world = new World({ map, seed });
      const [a, b] = world.entities;
      expect(distance(a!.pos, b!.pos)).toBeGreaterThanOrEqual(CONFIG.rules.minSpawnDistance);
      world.dispose();
    }
  });

  it('spawns in clear air, not inside a building', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const world = new World({ map, seed });
      for (const e of world.entities) {
        expect(world.physics.isClear(e.pos, CONFIG.flight.bodyRadius)).toBe(true);
      }
      world.dispose();
    }
  });

  it('advances time in fixed steps', () => {
    const world = new World({ map, seed: 1 });
    world.stepFor(2);
    expect(world.tick).toBe(120);
    expect(world.time).toBeCloseTo(2, 9);
    world.dispose();
  });

  it('is deterministic: same seed and inputs give identical state', () => {
    const script = scriptedInputs(7, 600);
    expect(run(3, script)).toEqual(run(3, script));
  });

  it('diverges when the seed changes', () => {
    const script = scriptedInputs(7, 120);
    expect(run(3, script)).not.toEqual(run(4, script));
  });

  it('restores an exact snapshot and replays from it', () => {
    const script = scriptedInputs(11, 200);
    const world = new World({ map, seed: 5 });
    for (let t = 0; t < 100; t++) world.step(script[t]!);

    const mid = world.snapshot();
    for (let t = 100; t < 200; t++) world.step(script[t]!);
    const end = world.snapshot();

    world.restore(mid);
    for (let t = 100; t < 200; t++) world.step(script[t]!);
    expect(world.snapshot()).toEqual(end);
    world.dispose();
  });

  it('resets back to a fresh round', () => {
    const world = new World({ map, seed: 9 });
    const start = world.snapshot();
    world.stepFor(3, [{ ...neutralInput(), move: { x: 0, y: 0, z: 1 }, boost: true }]);
    expect(world.snapshot()).not.toEqual(start);

    world.reset();
    expect(world.snapshot()).toEqual(start);
    world.dispose();
  });

  it('treats missing inputs as neutral', () => {
    const world = new World({ map, seed: 1 });
    world.stepFor(1, []);
    expect(world.entities.every((e) => e.vel.x === 0 && e.vel.y === 0 && e.vel.z === 0)).toBe(true);
    world.dispose();
  });

  it('never lets an entity leave the arena, whatever the input', () => {
    const script = scriptedInputs(21, 1800);
    const world = new World({ map, seed: 2 });
    const r = CONFIG.flight.bodyRadius;
    for (const inputs of script) {
      world.step(inputs);
      for (const e of world.entities) {
        expect(Number.isFinite(e.pos.x + e.pos.y + e.pos.z)).toBe(true);
        expect(e.pos.x).toBeGreaterThanOrEqual(world.bounds.minX + r - 1e-6);
        expect(e.pos.x).toBeLessThanOrEqual(world.bounds.maxX - r + 1e-6);
        expect(e.pos.y).toBeGreaterThanOrEqual(world.bounds.minY + r - 1e-6);
        expect(e.pos.y).toBeLessThanOrEqual(world.bounds.maxY - r + 1e-6);
        expect(e.pos.z).toBeGreaterThanOrEqual(world.bounds.minZ + r - 1e-6);
        expect(e.pos.z).toBeLessThanOrEqual(world.bounds.maxZ - r + 1e-6);
      }
    }
    world.dispose();
  });

  it('emits collision events when a craft flies into a building', () => {
    const world = new World({ map, seed: 1 });
    world.skipCountdown();
    // Park the hunter on a collision course with the central tower.
    const hunter = world.entity(0);
    hunter.pos = { x: 0, y: 40, z: -60 };
    // Yaw PI faces +Z, straight at the tower that straddles the origin.
    const charge = { ...neutralInput(), move: { x: 0, y: 0, z: 1 }, aimYaw: Math.PI, boost: true };
    const events = world.stepFor(3, [charge, neutralInput()]);

    expect(events.some((e) => e.type === 'collision' && e.entityId === 0)).toBe(true);
    expect(hunter.hp).toBeLessThan(CONFIG.loadout.hunter.maxHp);
    world.dispose();
  });
});

describe('World rounds', () => {
  /** A short round so the clock can actually be run out in a test. */
  function quickConfig() {
    const config = cloneConfig();
    config.rules.countdown = 1;
    config.rules.timeLimit = 2;
    return config;
  }

  it('locks control during the countdown and unlocks it on time', () => {
    const config = quickConfig();
    const world = new World({ map, config, seed: 1 });
    const charge = { ...neutralInput(), move: { x: 0, y: 0, z: 1 }, boost: true };

    expect(world.match.phase).toBe('countdown');
    world.stepFor(0.5, [charge, charge]);
    expect(world.controlEnabled).toBe(false);
    expect(world.entities.every((e) => e.vel.x === 0 && e.vel.y === 0 && e.vel.z === 0)).toBe(true);

    world.stepFor(0.6, [charge, charge]);
    expect(world.match.phase).toBe('live');
    expect(world.controlEnabled).toBe(true);
    expect(world.entities.some((e) => e.vel.x !== 0 || e.vel.y !== 0 || e.vel.z !== 0)).toBe(true);
    world.dispose();
  });

  it('gives the round to the runner when the clock runs out', () => {
    const config = quickConfig();
    const world = new World({ map, config, seed: 1 });
    world.stepFor(config.rules.countdown + config.rules.timeLimit + 0.1);

    expect(world.match.timeRemaining).toBe(0);
    expect(world.match.lastResult).toEqual({
      winnerId: 1,
      winnerTeam: 'runner',
      reason: 'timeout',
    });
    expect(world.match.scores).toEqual([0, 1]);
    expect(world.controlEnabled).toBe(false);
    world.dispose();
  });

  it('calls the clock a draw when timeoutWinner is set to draw', () => {
    const config = quickConfig();
    config.rules.timeoutWinner = 'draw';
    const world = new World({ map, config, seed: 1 });
    world.stepFor(config.rules.countdown + config.rules.timeLimit + 0.1);

    expect(world.match.lastResult?.reason).toBe('draw');
    expect(world.match.scores).toEqual([0, 0]);
    world.dispose();
  });

  it('ends the round the moment the hunter tags the runner', () => {
    const config = quickConfig();
    const world = new World({ map, config, seed: 1 });
    world.skipCountdown();

    const hunter = world.entityByTeam('hunter')!;
    const runner = world.entityByTeam('runner')!;
    runner.pos = { ...hunter.pos, x: hunter.pos.x + config.rules.touchRadius - 0.2 };

    const events = world.step();
    expect(events.some((e) => e.type === 'touch')).toBe(true);
    expect(world.match.lastResult).toEqual({
      winnerId: hunter.id,
      winnerTeam: 'hunter',
      reason: 'touch',
    });
    world.dispose();
  });

  it('ends the round when a craft is shot down', () => {
    const world = new World({ map, seed: 1 });
    world.skipCountdown();
    const runner = world.entityByTeam('runner')!;
    runner.hp = 1;

    const hunter = world.entityByTeam('hunter')!;
    // Line the hunter up point blank, just outside tag range.
    runner.pos = { x: hunter.pos.x, y: hunter.pos.y, z: hunter.pos.z - 10 };
    const fire = { ...neutralInput(), fire: true, aimYaw: 0 };
    const inputs = [];
    inputs[hunter.id] = fire;
    world.stepFor(0.2, inputs);

    expect(runner.alive).toBe(false);
    expect(world.match.lastResult?.reason).toBe('hp');
    expect(world.match.lastResult?.winnerId).toBe(hunter.id);
    world.dispose();
  });

  it('swaps sides and respawns fresh craft on the next round', () => {
    const config = quickConfig();
    const world = new World({ map, config, seed: 1 });
    expect(world.entities.map((e) => e.team)).toEqual(['hunter', 'runner']);

    world.stepFor(config.rules.countdown + config.rules.timeLimit + 0.1);
    expect(world.match.phase).toBe('roundOver');

    world.entities[0]!.hp = 5;
    expect(world.nextRound()).toBe(true);
    expect(world.match.round).toBe(2);
    expect(world.match.phase).toBe('countdown');
    expect(world.entities.map((e) => e.team)).toEqual(['runner', 'hunter']);
    // Fresh craft, and each one is built from the side it is now playing.
    expect(world.entities[0]!.hp).toBe(config.loadout.runner.maxHp);
    expect(world.entities.every((e) => e.boostFuel === config.flight.boostCapacity)).toBe(true);
    expect(world.entities.every((e) => e.alive && e.heat === 0 && e.shotsFired === 0)).toBe(true);
    world.dispose();
  });

  it('plays a best-of-3 through to a match winner', () => {
    const config = quickConfig();
    const world = new World({ map, config, seed: 1 });
    const roundLength = config.rules.countdown + config.rules.timeLimit + 0.1;

    // Nobody does anything, so the runner takes every round on the clock.
    // Sides swap, so the two slots trade wins and it goes to a decider.
    world.stepFor(roundLength);
    expect(world.match.scores).toEqual([0, 1]);
    world.nextRound();
    world.stepFor(roundLength);
    expect(world.match.scores).toEqual([1, 1]);
    world.nextRound();
    world.stepFor(roundLength);

    expect(world.match.scores).toEqual([1, 2]);
    expect(world.match.phase).toBe('matchOver');
    expect(world.match.matchWinnerId).toBe(1);
    expect(world.nextRound()).toBe(false);
    world.dispose();
  });

  it('keeps stepping safely after the round is decided', () => {
    const config = quickConfig();
    const world = new World({ map, config, seed: 1 });
    world.stepFor(config.rules.countdown + config.rules.timeLimit + 0.1);
    const scores = [...world.match.scores];

    const charge = { ...neutralInput(), move: { x: 0, y: 0, z: 1 }, fire: true, boost: true };
    world.stepFor(2, [charge, charge]);
    expect(world.match.scores).toEqual(scores);
    expect(world.entities.every((e) => e.shotsFired === 0)).toBe(true);
    world.dispose();
  });

  it('restarts the whole match on reset', () => {
    const config = quickConfig();
    const world = new World({ map, config, seed: 1 });
    world.stepFor(config.rules.countdown + config.rules.timeLimit + 0.1);
    world.nextRound();
    expect(world.match.round).toBe(2);

    world.reset();
    expect(world.match.round).toBe(1);
    expect(world.match.scores).toEqual([0, 0]);
    expect(world.match.phase).toBe('countdown');
    expect(world.entities.map((e) => e.team)).toEqual(['hunter', 'runner']);
    world.dispose();
  });
});
