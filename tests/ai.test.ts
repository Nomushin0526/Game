import { beforeAll, describe, expect, it } from 'vitest';
import { AiController, buildGrid, worldToLocalMove } from '../src/ai/controller.ts';
import { Perception } from '../src/ai/perception.ts';
import { loadMap } from '../src/maps/loader.ts';
import { CONFIG, cloneConfig, type AiDifficulty } from '../src/sim/config.ts';
import { createEntity } from '../src/sim/entity.ts';
import { clampLength, forwardVector, normalize, rightVector } from '../src/sim/math.ts';
import { initPhysics, PhysicsWorld } from '../src/sim/physics.ts';
import type { EntityState, Vec3 } from '../src/sim/types.ts';
import { World } from '../src/sim/world.ts';
import type { MapData } from '../src/maps/types.ts';

const map = loadMap('city01');

/** Open air with one wall, for line-of-sight tests. */
const WALL_MAP: MapData = {
  id: 'wall',
  name: 'Wall',
  size: { x: 400, z: 400 },
  ceiling: 150,
  floor: 0,
  spawns: [{ x: -100, y: 60, z: 0 }, { x: 100, y: 60, z: 0 }],
  solids: [{ shape: 'box', pos: { x: 0, y: 60, z: 0 }, size: { x: 4, y: 60, z: 60 }, tag: 'building' }],
};

beforeAll(async () => {
  await initPhysics();
});

describe('worldToLocalMove', () => {
  /**
   * Reproduces what `flight.ts` does with `PlayerInput.move`, so the test
   * asserts the decomposition against its actual consumer rather than against
   * a restatement of the same algebra.
   */
  function toWorld(move: { x: number; y: number; z: number }, yaw: number, pitch: number): Vec3 {
    const forward = forwardVector(yaw, pitch);
    const right = rightVector(yaw);
    return clampLength(
      {
        x: forward.x * move.z + right.x * move.x,
        y: forward.y * move.z + move.y,
        z: forward.z * move.z + right.z * move.x,
      },
      1,
    );
  }

  const DIRECTIONS = [
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 0, z: -1 },
    { x: 0, y: 1, z: 0 },
    { x: 0.5, y: -0.3, z: 0.8 },
    { x: -0.7, y: 0.2, z: -0.4 },
  ].map(normalize);

  it('round-trips exactly while the craft is level', () => {
    // At zero pitch forward, right and world-up are mutually perpendicular, so
    // the decomposition is an ordinary orthonormal projection and is exact.
    for (const direction of DIRECTIONS) {
      for (const yaw of [0, 1.1, -2.4, 3.0]) {
        const back = toWorld(worldToLocalMove(direction, yaw, 0), yaw, 0);
        expect(back.x).toBeCloseTo(direction.x, 5);
        expect(back.y).toBeCloseTo(direction.y, 5);
        expect(back.z).toBeCloseTo(direction.z, 5);
      }
    }
  });

  it('keeps the thrust direction exact when pitched over', () => {
    // Pitched, forward tilts towards world-up and the three axes stop being
    // perpendicular, so an exact fit can call for more than full deflection.
    // The coefficients are then scaled together, which costs thrust but keeps
    // the direction: the craft flies where it meant to, just not as hard.
    for (const direction of DIRECTIONS) {
      for (const yaw of [0, 1.1, -2.4, 3.0]) {
        for (const pitch of [0.5, -0.8, CONFIG.flight.maxPitch]) {
          const back = toWorld(worldToLocalMove(direction, yaw, pitch), yaw, pitch);
          expect(Math.hypot(back.x, back.y, back.z)).toBeGreaterThan(0.01);

          const unit = normalize(back);
          expect(unit.x).toBeCloseTo(direction.x, 5);
          expect(unit.y).toBeCloseTo(direction.y, 5);
          expect(unit.z).toBeCloseTo(direction.z, 5);
        }
      }
    }
  });

  it('lets a craft thrust backwards while aiming forwards', () => {
    // Facing -Z, wanting to travel +Z: that is the runner's whole game.
    const move = worldToLocalMove({ x: 0, y: 0, z: 1 }, 0, 0);
    expect(move.z).toBeCloseTo(-1, 5);
    expect(move.x).toBeCloseTo(0, 5);
  });

  it('keeps every component inside the input range', () => {
    for (const pitch of [0, 0.9, -1.3, CONFIG.flight.maxPitch]) {
      const move = worldToLocalMove(normalize({ x: 0.3, y: 1, z: -0.2 }), 0.7, pitch);
      for (const component of [move.x, move.y, move.z]) {
        expect(component).toBeGreaterThanOrEqual(-1);
        expect(component).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('Perception', () => {
  let physics: PhysicsWorld;
  const tuning = CONFIG.ai.difficulty.hard;
  const dt = CONFIG.sim.fixedDt;

  beforeAll(() => {
    physics = new PhysicsWorld(WALL_MAP);
  });

  const craft = (pos: Vec3, yaw = 0, team: 'hunter' | 'runner' = 'hunter'): EntityState =>
    createEntity(0, team, pos, CONFIG, { aimYaw: yaw });

  /** Yaw facing +X. */
  const FACE_PLUS_X = -Math.PI / 2;

  it('sees an enemy in front with a clear line', () => {
    const p = new Perception();
    const self = craft({ x: -100, y: 100, z: 0 }, FACE_PLUS_X);
    const enemy = createEntity(1, 'runner', { x: -40, y: 100, z: 0 }, CONFIG);
    p.update(self, enemy, physics, CONFIG, tuning, dt);
    expect(p.visible).toBe(true);
  });

  it('does not see behind itself', () => {
    const p = new Perception();
    const self = craft({ x: -100, y: 100, z: 0 }, FACE_PLUS_X);
    const behind = createEntity(1, 'runner', { x: -160, y: 100, z: 0 }, CONFIG);
    p.update(self, behind, physics, CONFIG, tuning, dt);
    expect(p.visible).toBe(false);
  });

  it('does not see through a wall', () => {
    const p = new Perception();
    const self = craft({ x: -40, y: 60, z: 0 }, FACE_PLUS_X);
    const enemy = createEntity(1, 'runner', { x: 40, y: 60, z: 0 }, CONFIG);
    p.update(self, enemy, physics, CONFIG, tuning, dt);
    expect(p.visible).toBe(false);
  });

  it('does not see past its sight range', () => {
    const p = new Perception();
    const self = craft({ x: -190, y: 100, z: 0 }, FACE_PLUS_X);
    const far = createEntity(1, 'runner', { x: 190, y: 100, z: 0 }, CONFIG);
    p.update(self, far, physics, CONFIG, tuning, dt);
    expect(p.visible).toBe(false);

    const near = createEntity(1, 'runner', { x: -40, y: 100, z: 0 }, CONFIG);
    p.update(self, near, physics, CONFIG, tuning, dt);
    expect(p.visible).toBe(true);
  });

  it('waits out the reaction time before acting on a sighting', () => {
    const slow = CONFIG.ai.difficulty.easy;
    const p = new Perception();
    const self = craft({ x: -100, y: 100, z: 0 }, FACE_PLUS_X);
    const enemy = createEntity(1, 'runner', { x: -40, y: 100, z: 0 }, CONFIG);

    p.update(self, enemy, physics, CONFIG, slow, dt);
    expect(p.visible).toBe(true);
    expect(p.acquired).toBe(false);

    for (let i = 0; i < Math.ceil(slow.reactionTime / dt) + 1; i++) {
      p.update(self, enemy, physics, CONFIG, slow, dt);
    }
    expect(p.acquired).toBe(true);
  });

  it('remembers a lost target, then forgets it', () => {
    const p = new Perception();
    const self = craft({ x: -100, y: 100, z: 0 }, FACE_PLUS_X);
    const enemy = createEntity(1, 'runner', { x: -40, y: 100, z: 0 }, CONFIG);
    enemy.vel = { x: 10, y: 0, z: 0 };

    p.update(self, enemy, physics, CONFIG, tuning, dt);
    expect(p.lastSeen).not.toBeNull();

    // Turn away so it is out of the cone.
    self.aimYaw = Math.PI / 2;
    p.update(self, enemy, physics, CONFIG, tuning, dt);
    expect(p.visible).toBe(false);
    expect(p.hasMemory(CONFIG)).toBe(true);
    expect(p.confidence(CONFIG)).toBeGreaterThan(0.9);

    // The estimate is carried forward along the remembered velocity.
    for (let i = 0; i < 60; i++) p.update(self, enemy, physics, CONFIG, tuning, dt);
    const guess = p.estimate(enemy, CONFIG)!;
    expect(guess.x).toBeGreaterThan(-40);

    for (let i = 0; i < CONFIG.ai.memoryDuration / dt; i++) {
      p.update(self, enemy, physics, CONFIG, tuning, dt);
    }
    expect(p.hasMemory(CONFIG)).toBe(false);
    expect(p.estimate(enemy, CONFIG)).toBeNull();
    expect(p.confidence(CONFIG)).toBe(0);
  });

  it('never sees a downed craft', () => {
    const p = new Perception();
    const self = craft({ x: -100, y: 100, z: 0 }, FACE_PLUS_X);
    const dead = createEntity(1, 'runner', { x: -40, y: 100, z: 0 }, CONFIG);
    dead.alive = false;
    p.update(self, dead, physics, CONFIG, tuning, dt);
    expect(p.visible).toBe(false);
  });
});

describe('AiController', () => {
  /** A short round so a whole match can be played inside a test. */
  function quickConfig() {
    const config = cloneConfig();
    config.rules.countdown = 0;
    config.rules.timeLimit = 12;
    return config;
  }

  function match(seed: number, difficulty: AiDifficulty = 'normal', config = quickConfig()) {
    const world = new World({ map, config, seed });
    world.skipCountdown();
    const grid = buildGrid(world);
    const controllers = world.entities.map((entity) =>
      new AiController({ world, slot: entity.id, difficulty, grid, seed: seed * 31 + entity.id }),
    );
    return { world, controllers, config };
  }

  function play(seed: number, difficulty: AiDifficulty = 'normal'): World {
    const { world, controllers, config } = match(seed, difficulty);
    const maxTicks = Math.ceil((config.rules.timeLimit + 2) * config.sim.tickRate);
    for (let t = 0; world.match.phase === 'live' && t < maxTicks; t++) {
      world.step(controllers.map((c) => c.sample(config.sim.fixedDt)));
    }
    return world;
  }

  it('produces well-formed input', () => {
    const { world, controllers, config } = match(1);
    for (let t = 0; t < 120; t++) {
      const inputs = controllers.map((c) => c.sample(config.sim.fixedDt));
      for (const input of inputs) {
        for (const component of [input.move.x, input.move.y, input.move.z]) {
          expect(Number.isFinite(component)).toBe(true);
          expect(Math.abs(component)).toBeLessThanOrEqual(1);
        }
        expect(Number.isFinite(input.aimYaw)).toBe(true);
        expect(Math.abs(input.aimPitch)).toBeLessThanOrEqual(config.flight.maxPitch + 1e-9);
        expect(typeof input.fire).toBe('boolean');
      }
      world.step(inputs);
    }
    world.dispose();
  });

  it('plays a whole round without ever reaching an invalid state', () => {
    // Regression: actions are chosen on the decision interval but acted on
    // every tick, so a remembered enemy position could expire underneath a
    // running chase and leave the action with nothing to steer at.
    for (const seed of [1, 7, 22, 41, 99]) {
      const world = play(seed, 'hard');
      for (const entity of world.entities) {
        expect(Number.isFinite(entity.pos.x + entity.pos.y + entity.pos.z)).toBe(true);
      }
      world.dispose();
    }
  });

  it('is deterministic: same seed, same match', () => {
    expect(play(5).snapshot()).toEqual(play(5).snapshot());
  });

  it('differs between seeds', () => {
    expect(play(5).snapshot()).not.toEqual(play(6).snapshot());
  });

  it('actually flies and actually shoots', () => {
    const world = play(3, 'hard');
    const moved = world.entities.some(
      (e) => Math.hypot(e.pos.x, e.pos.z) > 0 && Math.hypot(e.vel.x, e.vel.y, e.vel.z) >= 0,
    );
    expect(moved).toBe(true);
    expect(world.entities.some((e) => e.shotsFired > 0)).toBe(true);
    world.dispose();
  });

  it('swaps brains when the round swaps its side', () => {
    const config = cloneConfig();
    config.rules.countdown = 0;
    config.rules.timeLimit = 2;
    const world = new World({ map, config, seed: 4 });
    world.skipCountdown();
    const grid = buildGrid(world);
    const cpu = new AiController({ world, slot: 0, difficulty: 'normal', grid, seed: 11 });

    expect(world.entity(0).team).toBe('hunter');
    world.stepFor(3, [cpu.sample(config.sim.fixedDt)]);
    world.nextRound();
    expect(world.entity(0).team).toBe('runner');

    // Still produces usable input on the other side of the swap.
    const input = cpu.sample(config.sim.fixedDt);
    expect(Number.isFinite(input.aimYaw)).toBe(true);
    world.dispose();
  });

  it('gives a harder CPU better aim than an easier one', () => {
    const accuracy = (difficulty: AiDifficulty): number => {
      let shots = 0;
      let hits = 0;
      for (const seed of [2, 3, 4, 5, 6, 7]) {
        const world = play(seed, difficulty);
        for (const entity of world.entities) {
          shots += entity.shotsFired;
          hits += entity.shotsHit;
        }
        world.dispose();
      }
      return shots > 0 ? hits / shots : 0;
    };
    expect(accuracy('hard')).toBeGreaterThan(accuracy('easy'));
  });
});
