/**
 * The simulation. Holds all authoritative state and advances it in fixed steps.
 *
 * Purity contract: given the same map, config, seed and input sequence,
 * `step()` produces exactly the same states every time. Replays, unit tests,
 * head-less batch runs and the future authoritative server all depend on it,
 * so never read wall-clock time, `Math.random()` or anything from the DOM here.
 */

import { CONFIG, type SkyTagConfig } from './config.ts';
import { createEntity } from './entity.ts';
import { boundsFromMap, stepFlight, type ArenaBounds, type FlightContext } from './flight.ts';
import { distance } from './math.ts';
import { initPhysics, PhysicsWorld } from './physics.ts';
import { Rng } from './rng.ts';
import {
  advanceRound,
  beginRound,
  checkTouch,
  createMatchState,
  evaluateRound,
  recordRoundResult,
  teamsForRound,
  type MatchState,
} from './rules.ts';
import { stepDecoys, stepItems, type ItemContext } from './items.ts';
import { stepProjectiles, type ProjectileContext } from './projectile.ts';
import { neutralInput, type DecoyState, type EntityState, type PlayerInput, type ProjectileState, type SimEvent, type Team, type Vec3 } from './types.ts';
import { stepWeapon, type WeaponContext } from './weapon.ts';
import type { MapData } from '../maps/types.ts';

export interface WorldOptions {
  map: MapData;
  config?: SkyTagConfig;
  seed?: number;
  /** How many craft to spawn. The rules assign sides per round. */
  slots?: number;
}

/** Serialisable copy of the whole simulation state. */
export interface WorldSnapshot {
  tick: number;
  time: number;
  rngState: number;
  entities: EntityState[];
  projectiles: ProjectileState[];
  decoys: DecoyState[];
  nextProjectileId: number;
  nextDecoyId: number;
  match: MatchState;
}

export class World {
  readonly map: MapData;
  readonly config: SkyTagConfig;
  readonly physics: PhysicsWorld;
  readonly bounds: ArenaBounds;
  readonly rng: Rng;
  readonly slots: number;

  entities: EntityState[] = [];
  /** Bolts currently in the air. Read by the renderer, owned here. */
  projectiles: ProjectileState[] = [];
  /** Phantoms currently flying. Read by the renderer and by AI perception. */
  decoys: DecoyState[] = [];
  match: MatchState;
  /** Ticks elapsed since the world was reset. */
  tick = 0;
  /** Seconds elapsed since the world was reset. */
  time = 0;
  /** Cleared at the start of every step; read by the renderer for effects. */
  events: SimEvent[] = [];
  /** Derived from `match.phase` each step: false during countdown and after the round. */
  controlEnabled = false;

  private readonly seed: number;
  private nextProjectileId = 1;
  private nextDecoyId = 1;

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
    this.slots = options.slots ?? 2;
    this.physics = new PhysicsWorld(this.map);
    this.bounds = boundsFromMap(this.map);
    this.rng = new Rng(this.seed);
    this.match = createMatchState(this.config, this.slots);
    this.reset();
  }

  /** Restart the whole match at round 1. Re-seeds the RNG. */
  reset(seed: number = this.seed): void {
    this.rng.restore(new Rng(seed).save());
    this.tick = 0;
    this.time = 0;
    this.events = [];
    this.nextProjectileId = 1;
    this.nextDecoyId = 1;
    this.match = createMatchState(this.config, this.slots);
    this.spawnRound();
  }

  /**
   * Move to the next round of a best-of-N match, swapping sides if configured.
   * No-op once the match is decided.
   */
  nextRound(): boolean {
    if (!advanceRound(this.match, this.config)) return false;
    this.spawnRound();
    return true;
  }

  /** Re-run the current round from its countdown. */
  restartRound(): void {
    beginRound(this.match, this.config);
    this.spawnRound();
  }

  /** Drop straight into play. Used by tests and the head-less tools. */
  skipCountdown(): void {
    this.match.countdownRemaining = 0;
    if (this.match.phase === 'countdown') this.match.phase = 'live';
    this.controlEnabled = true;
  }

  /** Place fresh craft for `match.round` with that round's side assignment. */
  private spawnRound(): void {
    const teams = teamsForRound(this.match.round, this.config, this.slots);
    const spawns = this.pickSpawnPoints(this.slots);
    this.entities = teams.map((team, slot) => createEntity(slot, team, spawns[slot]!, this.config));
    // Nothing carries over: a round starts with clear air.
    this.projectiles = [];
    this.decoys = [];
    this.controlEnabled = false;
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
    this.advancePhase(dt);

    const flightCtx: FlightContext = {
      dt,
      config: this.config,
      physics: this.physics,
      bounds: this.bounds,
      controlEnabled: this.controlEnabled,
    };
    const weaponCtx: WeaponContext = {
      dt,
      config: this.config,
      controlEnabled: this.controlEnabled,
      spawn: (projectile) => this.projectiles.push(projectile),
      nextProjectileId: () => this.nextProjectileId++,
    };
    const projectileCtx: ProjectileContext = { dt, config: this.config, physics: this.physics };
    const itemCtx: ItemContext = {
      dt,
      config: this.config,
      physics: this.physics,
      controlEnabled: this.controlEnabled,
      spawnDecoy: (decoy) => this.decoys.push(decoy),
      spawnProjectile: (projectile) => this.projectiles.push(projectile),
      nextDecoyId: () => this.nextDecoyId++,
      nextProjectileId: () => this.nextProjectileId++,
    };

    // Craft keep coasting outside the live phase; only control is taken away.
    for (const entity of this.entities) {
      const input = inputs[entity.id] ?? neutralInput();
      this.events.push(...stepFlight(entity, input, flightCtx));
    }
    for (const entity of this.entities) {
      const input = inputs[entity.id] ?? neutralInput();
      this.events.push(...stepWeapon(entity, input, weaponCtx));
      this.events.push(...stepItems(entity, input, itemCtx));
    }

    // Decoys move before the bolts so a phantom cannot be shot at a position
    // it has already left this tick.
    const phantoms = stepDecoys(this.decoys, {
      dt,
      physics: this.physics,
      config: this.config,
      bounds: this.bounds,
    });
    this.decoys = phantoms.survivors;
    this.events.push(...phantoms.events);

    // Bolts move after the craft and after the guns, so one fired this tick
    // gets its first step immediately rather than hanging at the muzzle for a
    // frame. Craft move first, so a shot resolves against where they are now.
    const flown = stepProjectiles(this.projectiles, this.entities, this.decoys, projectileCtx);
    this.projectiles = flown.survivors;
    this.events.push(...flown.events);

    if (this.match.phase === 'live') {
      this.match.timeRemaining = Math.max(0, this.match.timeRemaining - dt);
      this.resolveRound();
    }

    this.tick++;
    this.time = this.tick * dt;
    return this.events;
  }

  private advancePhase(dt: number): void {
    if (this.match.phase === 'countdown') {
      this.match.countdownRemaining = Math.max(0, this.match.countdownRemaining - dt);
      if (this.match.countdownRemaining === 0) this.match.phase = 'live';
    }
    this.controlEnabled = this.match.phase === 'live';
  }

  private resolveRound(): void {
    const touch = checkTouch(this.entities, this.config);
    if (touch) this.events.push(touch);

    const result = evaluateRound(this.entities, this.match.timeRemaining, this.config);
    if (result) {
      recordRoundResult(this.match, result, this.config);
      this.controlEnabled = false;
    }
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

  /** The craft currently playing `team`, if any is still in the round. */
  entityByTeam(team: Team): EntityState | undefined {
    return this.entities.find((e) => e.team === team);
  }

  snapshot(): WorldSnapshot {
    return {
      tick: this.tick,
      time: this.time,
      rngState: this.rng.save(),
      entities: this.entities.map((e) => structuredClone(e)),
      projectiles: this.projectiles.map((p) => structuredClone(p)),
      decoys: this.decoys.map((d) => structuredClone(d)),
      nextProjectileId: this.nextProjectileId,
      nextDecoyId: this.nextDecoyId,
      match: structuredClone(this.match),
    };
  }

  restore(snapshot: WorldSnapshot): void {
    this.tick = snapshot.tick;
    this.time = snapshot.time;
    this.rng.restore(snapshot.rngState);
    this.entities = snapshot.entities.map((e) => structuredClone(e));
    this.projectiles = snapshot.projectiles.map((p) => structuredClone(p));
    this.decoys = snapshot.decoys.map((d) => structuredClone(d));
    this.nextProjectileId = snapshot.nextProjectileId;
    this.nextDecoyId = snapshot.nextDecoyId;
    this.match = structuredClone(snapshot.match);
    this.controlEnabled = this.match.phase === 'live';
  }

  dispose(): void {
    this.physics.dispose();
  }
}
