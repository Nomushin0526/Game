/**
 * The simulation. Holds all authoritative state and advances it in fixed steps.
 *
 * Purity contract: given the same map, config, seed and input sequence,
 * `step()` produces exactly the same states every time. Replays, unit tests,
 * head-less batch runs and the future authoritative server all depend on it,
 * so never read wall-clock time, `Math.random()` or anything from the DOM here.
 */

import { CONFIG, type SkyTagConfig } from './config.ts';
import { boundsFromMap, stepFlight, type ArenaBounds, type FlightContext } from './flight.ts';
import { distance } from './math.ts';
import { initPhysics, PhysicsWorld } from './physics.ts';
import { Rng } from './rng.ts';
import { neutralInput, type EntityState, type PlayerInput, type SimEvent, type Team, type Vec3 } from './types.ts';
import type { MapData } from '../maps/types.ts';

export interface WorldOptions {
  map: MapData;
  config?: SkyTagConfig;
  seed?: number;
  /** Team per entity, in slot order. Defaults to one hunter and one runner. */
  teams?: readonly Team[];
}

/** Serialisable copy of the whole simulation state. */
export interface WorldSnapshot {
  tick: number;
  time: number;
  rngState: number;
  entities: EntityState[];
}

export class World {
  readonly map: MapData;
  readonly config: SkyTagConfig;
  readonly physics: PhysicsWorld;
  readonly bounds: ArenaBounds;
  readonly rng: Rng;

  entities: EntityState[] = [];
  /** Ticks elapsed since the world was reset. */
  tick = 0;
  /** Seconds elapsed since the world was reset. */
  time = 0;
  /** Cleared at the start of every step; read by the renderer for effects. */
  events: SimEvent[] = [];
  /** Driven by `rules.ts` (phase 2) to lock input during the countdown. */
  controlEnabled = true;

  private readonly teams: readonly Team[];
  private readonly seed: number;

  /**
   * Async because Rapier's wasm has to be initialised once per process.
   * Prefer this over the constructor unless you already called `initPhysics()`.
   */
  static async create(options: WorldOptions): Promise<World> {
    await initPhysics();
    return new World(options);
  }

  constructor(options: WorldOptions) {
    this.map = options.map;
    this.config = options.config ?? CONFIG;
    this.seed = options.seed ?? this.config.sim.defaultSeed;
    this.teams = options.teams ?? (['hunter', 'runner'] as const);
    this.physics = new PhysicsWorld(this.map);
    this.bounds = boundsFromMap(this.map);
    this.rng = new Rng(this.seed);
    this.reset();
  }

  /** Rebuild every entity at fresh spawn points. Re-seeds the RNG. */
  reset(seed: number = this.seed): void {
    this.rng.restore(new Rng(seed).save());
    this.tick = 0;
    this.time = 0;
    this.events = [];
    this.controlEnabled = true;

    const spawns = this.pickSpawnPoints(this.teams.length);
    this.entities = this.teams.map((team, i) => this.makeEntity(i, team, spawns[i]!));
  }

  private makeEntity(id: number, team: Team, pos: Vec3): EntityState {
    const loadout = this.config.loadout[team];
    // Face the arena centre so both craft start looking at the action.
    const aimYaw = Math.atan2(-(0 - pos.x), -(0 - pos.z));
    return {
      id,
      team,
      pos: { ...pos },
      vel: { x: 0, y: 0, z: 0 },
      aimYaw,
      aimPitch: 0,
      hp: loadout.maxHp,
      boostFuel: this.config.flight.boostCapacity,
      boosting: false,
      stunTimer: 0,
      alive: true,
    };
  }

  /**
   * Choose well-separated spawn points from the map's candidates.
   *
   * Falls back to the furthest-apart pair available rather than failing, so a
   * cramped custom map still starts (DESIGN.md 2.2 asks for >= 150 m).
   */
  private pickSpawnPoints(count: number): Vec3[] {
    const candidates = this.rng.shuffle([...this.map.spawns]);
    const minDist = this.config.rules.minSpawnDistance;
    const chosen: Vec3[] = [];

    for (const candidate of candidates) {
      if (chosen.length >= count) break;
      if (chosen.every((c) => distance(c, candidate) >= minDist)) chosen.push(candidate);
    }

    // Relax the constraint until we have enough points.
    for (let relax = 0.75; chosen.length < count && relax > 0; relax -= 0.25) {
      for (const candidate of candidates) {
        if (chosen.length >= count) break;
        if (chosen.includes(candidate)) continue;
        if (chosen.every((c) => distance(c, candidate) >= minDist * relax)) chosen.push(candidate);
      }
    }
    while (chosen.length < count) chosen.push(candidates[chosen.length % candidates.length]!);

    return chosen.map((p) => ({ ...p }));
  }

  /**
   * Advance one fixed tick. `inputs` is indexed by entity id; any missing slot
   * is treated as neutral input.
   */
  step(inputs: readonly PlayerInput[] = []): SimEvent[] {
    const dt = this.config.sim.fixedDt;
    this.events = [];

    const ctx: FlightContext = {
      dt,
      config: this.config,
      physics: this.physics,
      bounds: this.bounds,
      controlEnabled: this.controlEnabled,
    };

    for (const entity of this.entities) {
      const input = inputs[entity.id] ?? neutralInput();
      const collision = stepFlight(entity, input, ctx);
      if (collision) this.events.push(collision);
    }

    this.tick++;
    this.time = this.tick * dt;
    return this.events;
  }

  /** Run `seconds` worth of ticks with a constant (or per-tick) input. */
  stepFor(seconds: number, inputs: readonly PlayerInput[] = []): SimEvent[] {
    const ticks = Math.round(seconds * this.config.sim.tickRate);
    const collected: SimEvent[] = [];
    for (let i = 0; i < ticks; i++) collected.push(...this.step(inputs));
    return collected;
  }

  entity(id: number): EntityState {
    const found = this.entities[id];
    if (!found) throw new Error(`No entity with id ${id}`);
    return found;
  }

  snapshot(): WorldSnapshot {
    return {
      tick: this.tick,
      time: this.time,
      rngState: this.rng.save(),
      entities: this.entities.map((e) => structuredClone(e)),
    };
  }

  restore(snapshot: WorldSnapshot): void {
    this.tick = snapshot.tick;
    this.time = snapshot.time;
    this.rng.restore(snapshot.rngState);
    this.entities = snapshot.entities.map((e) => structuredClone(e));
  }

  dispose(): void {
    this.physics.dispose();
  }
}
