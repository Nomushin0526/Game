/**
 * The AI's hands.
 *
 * A brain decides *what* it wants in world terms; this turns that into the very
 * same `PlayerInput` a keyboard or a gamepad produces. The simulation cannot
 * tell the difference, which is the whole point of the input contract in
 * DESIGN.md 6.2 — and it is what lets the head-less batch tool and, later, a
 * learned policy drop straight into the same slot.
 */

import type { AiDifficulty, AiTuning, SkyTagConfig } from '../sim/config.ts';
import {
  angleDelta,
  clamp,
  dot,
  forwardVector,
  lookAngles,
  normalize,
  rightVector,
  scale,
  sub,
  wrapAngle,
} from '../sim/math.ts';
import { Rng } from '../sim/rng.ts';
import { NO_ITEM, neutralInput, type EntityState, type PlayerInput, type Vec3 } from '../sim/types.ts';
import type { World } from '../sim/world.ts';
import type { InputSource } from '../input/types.ts';
import { hunterBrain } from './behavior/hunterBrain.ts';
import { runnerBrain } from './behavior/runnerBrain.ts';
import { Navigator } from './nav/navigator.ts';
import { VoxelGrid } from './nav/voxelGrid.ts';
import { Perception } from './perception.ts';
import { chooseAction, coast, createMemory, type Action, type Brain, type BrainContext, type BrainMemory, type Intent } from './types.ts';

/** Seconds of travel to look ahead when checking for an imminent crash. */
const AVOID_LOOKAHEAD = 1.1;
/** How hard an imminent obstacle pushes the steering direction away from it. */
const AVOID_STRENGTH = 2.2;

export interface AiControllerOptions {
  world: World;
  slot: number;
  difficulty?: AiDifficulty;
  /** Shared across controllers on the same map; built here if omitted. */
  grid?: VoxelGrid;
  /** Seed offset, so two CPUs on one map do not sample identically. */
  seed?: number;
}

export class AiController implements InputSource {
  readonly label: string;
  readonly available = true;
  readonly difficulty: AiDifficulty;
  readonly grid: VoxelGrid;

  private readonly world: World;
  private readonly slot: number;
  private readonly config: SkyTagConfig;
  private readonly tuning: AiTuning;
  private readonly rng: Rng;
  private readonly perception = new Perception();
  private readonly nav: Navigator;
  private readonly memory: BrainMemory = createMemory();

  private aimYaw = 0;
  private aimPitch = 0;
  private currentAction: Action | null = null;
  private sinceDecision = Number.POSITIVE_INFINITY;
  /** Latched for one tick, so a charge is spent once rather than every tick. */
  private pendingItem = NO_ITEM;
  /** Which team the brain was built for, so a side swap rebuilds it. */
  private brainTeam: EntityState['team'] | null = null;
  private brain: Brain = hunterBrain;

  constructor(options: AiControllerOptions) {
    this.world = options.world;
    this.slot = options.slot;
    this.config = options.world.config;
    this.difficulty = options.difficulty ?? 'normal';
    this.tuning = this.config.ai.difficulty[this.difficulty];
    this.label = `CPU ${this.difficulty}`;
    this.grid = options.grid ?? buildGrid(options.world);
    this.nav = new Navigator(this.grid, this.config);
    this.rng = new Rng((options.seed ?? 0x5c0 + options.slot * 977) >>> 0);

    const self = options.world.entity(this.slot);
    this.aimYaw = self.aimYaw;
    this.aimPitch = self.aimPitch;
  }

  /** The behaviour chosen this tick, for the HUD and the batch tool. */
  get actionName(): string {
    return this.currentAction?.name ?? 'idle';
  }

  get sees(): boolean {
    return this.perception.visible;
  }

  sample(dt: number): PlayerInput {
    const self = this.world.entity(this.slot);
    const enemy = this.world.entities.find((e) => e.id !== this.slot);

    // A side swap between rounds hands this slot a different job entirely.
    if (this.brainTeam !== self.team) {
      this.brainTeam = self.team;
      this.brain = self.team === 'hunter' ? hunterBrain : runnerBrain;
      this.reset(self);
    }

    this.perception.update(
      self,
      enemy,
      this.world.decoys,
      this.world.physics,
      this.config,
      this.tuning,
      dt,
    );
    this.memory.coverCommit = Math.max(0, this.memory.coverCommit - dt);
    this.memory.jinkPhase += dt;

    const ctx: BrainContext = {
      self,
      enemy,
      perception: this.perception,
      nav: this.nav,
      grid: this.grid,
      physics: this.world.physics,
      config: this.config,
      tuning: this.tuning,
      rng: this.rng,
      memory: this.memory,
      decisionTick: false,
      dt,
      timeRemaining: this.world.match.timeRemaining,
      estimate: this.perception.estimate(enemy, this.config),
      range: Number.POSITIVE_INFINITY,
    };
    ctx.range = ctx.estimate
      ? Math.hypot(ctx.estimate.x - self.pos.x, ctx.estimate.y - self.pos.y, ctx.estimate.z - self.pos.z)
      : Number.POSITIVE_INFINITY;

    // Re-scoring every tick would be wasteful and would make the AI twitchy.
    this.sinceDecision += dt;
    if (this.sinceDecision >= this.config.ai.decisionInterval || this.currentAction === null) {
      this.sinceDecision = 0;
      ctx.decisionTick = true;
      const chosen = chooseAction(this.brain, ctx, this.currentAction);
      if (chosen !== this.currentAction) this.clearDestinations();
      this.currentAction = chosen;
      // Items are chosen alongside the action, never re-decided mid-tick.
      this.pendingItem = this.brain.chooseItem?.(ctx) ?? NO_ITEM;
    }

    const intent = self.alive ? this.currentAction.act(ctx) : coast();
    return this.toInput(intent, ctx, dt);
  }

  /** Aim is owned here, so aim assist and respawns can steer it like any source. */
  setAim(yaw: number, pitch = this.aimPitch): void {
    this.aimYaw = wrapAngle(yaw);
    this.aimPitch = clamp(pitch, -this.config.flight.maxPitch, this.config.flight.maxPitch);
  }

  dispose(): void {
    // Nothing to release: the controller owns no listeners or wasm handles.
  }

  private reset(self: EntityState): void {
    this.perception.reset();
    this.nav.reset();
    this.clearDestinations();
    this.currentAction = null;
    this.sinceDecision = Number.POSITIVE_INFINITY;
    this.pendingItem = NO_ITEM;
    this.aimYaw = self.aimYaw;
    this.aimPitch = self.aimPitch;
  }

  private clearDestinations(): void {
    this.memory.searchTarget = null;
    this.memory.ambushSpot = null;
    this.memory.escapeTarget = null;
    this.memory.coverSpot = null;
    this.memory.coverCommit = 0;
  }

  private toInput(intent: Intent, ctx: BrainContext, dt: number): PlayerInput {
    const self = ctx.self;
    this.trackAim(intent, self, dt);

    const input: PlayerInput = {
      ...neutralInput(),
      aimYaw: this.aimYaw,
      aimPitch: this.aimPitch,
      boost: intent.boost && self.boostFuel > this.config.flight.boostMinToEngage,
      fire: intent.fire && this.rng.next() < this.tuning.fireWillingness,
      useItem: this.pendingItem,
    };
    this.pendingItem = NO_ITEM;

    if (intent.moveTo) {
      let direction = normalize(sub(intent.moveTo, self.pos));
      direction = this.avoidObstacles(direction, self);
      input.move = worldToLocalMove(direction, this.aimYaw, this.aimPitch);
    }
    return input;
  }

  /** Swing the view towards the target at the difficulty's turn rate. */
  private trackAim(intent: Intent, self: EntityState, dt: number): void {
    const target = intent.lookAt ?? aheadOf(self, intent.moveTo);
    if (!target) return;

    const desired = lookAngles(self.pos, target);
    // Aim error is re-rolled per tick and shrinks with difficulty, which makes
    // weak CPUs spray and strong ones track cleanly.
    const error = this.tuning.aimError;
    const wantYaw = desired.yaw + this.rng.range(-error, error);
    const wantPitch = desired.pitch + this.rng.range(-error, error);

    const maxStep = this.tuning.turnRate * dt;
    this.aimYaw = wrapAngle(this.aimYaw + clamp(angleDelta(this.aimYaw, wantYaw), -maxStep, maxStep));
    this.aimPitch = clamp(
      this.aimPitch + clamp(wantPitch - this.aimPitch, -maxStep, maxStep),
      -this.config.flight.maxPitch,
      this.config.flight.maxPitch,
    );
  }

  /**
   * Last line of defence against flying into a wall.
   *
   * The navigator routes around geometry on a 0.5 s interval, which at boost
   * speed is 40 m of travel. A short sphere cast every tick catches whatever
   * appears in between and bends the steering away from it.
   */
  private avoidObstacles(direction: Vec3, self: EntityState): Vec3 {
    const speed = Math.hypot(self.vel.x, self.vel.y, self.vel.z);
    const lookahead = Math.max(this.config.flight.bodyRadius * 4, speed * AVOID_LOOKAHEAD);
    const hit = this.world.physics.sphereCast(
      self.pos,
      direction,
      lookahead,
      this.config.flight.bodyRadius * 1.6,
    );
    if (!hit) return direction;

    // Closer obstacles push harder.
    const urgency = 1 - hit.distance / lookahead;
    return normalize({
      x: direction.x + hit.normal.x * urgency * AVOID_STRENGTH,
      y: direction.y + hit.normal.y * urgency * AVOID_STRENGTH,
      z: direction.z + hit.normal.z * urgency * AVOID_STRENGTH,
    });
  }
}

/** Where to look when the brain has no opinion: along the flight path. */
function aheadOf(self: EntityState, moveTo: Vec3 | null): Vec3 | null {
  if (moveTo) return moveTo;
  const speed = Math.hypot(self.vel.x, self.vel.y, self.vel.z);
  return speed > 1
    ? { x: self.pos.x + self.vel.x * 2, y: self.pos.y + self.vel.y * 2, z: self.pos.z + self.vel.z * 2 }
    : null;
}

/**
 * Decompose a world direction into the craft's control axes.
 *
 * `PlayerInput.move` is read by `flight.ts` as `forward * z + right * x + worldUp * y`,
 * and those three are not orthogonal — forward tilts with pitch. Right is
 * perpendicular to both of the others, so the x component comes straight off a
 * dot product and the remaining two fall out of a 2x2 solve in the vertical
 * plane. Getting this exact is what lets the runner thrust backwards while
 * aiming at its pursuer.
 */
export function worldToLocalMove(
  direction: Vec3,
  yaw: number,
  pitch: number,
): { x: number; y: number; z: number } {
  const forward = forwardVector(yaw, pitch);
  const right = rightVector(yaw);

  const x = dot(direction, right);
  const rest = sub(direction, scale(right, x));

  // rest = y * up + z * forward, with up = (0,1,0).
  const k = forward.y; // up . forward
  const restUp = rest.y;
  const restForward = dot(rest, forward);
  const denominator = 1 - k * k;

  // Straight up or down: forward and up are nearly parallel and the solve is
  // ill-conditioned, so fall back to pure vertical thrust.
  if (denominator < 1e-3) {
    return normaliseMove(x, restUp, 0);
  }

  const y = (restUp - k * restForward) / denominator;
  const z = (restForward - k * restUp) / denominator;
  return normaliseMove(x, y, z);
}

/**
 * Fit a set of axis coefficients into the -1..1 the input allows.
 *
 * Scaled together rather than clamped one at a time. Steeply pitched, the axes
 * are far from perpendicular and an exact fit can call for well over full
 * deflection; clamping each axis on its own would then point the thrust
 * somewhere other than where it was asked for, while scaling keeps the
 * direction exact and only gives up some of the thrust.
 */
function normaliseMove(x: number, y: number, z: number): { x: number; y: number; z: number } {
  const peak = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
  if (peak <= 1) return { x, y, z };
  return { x: x / peak, y: y / peak, z: z / peak };
}

/** Voxelise a world's map with the configured cell size and clearance. */
export function buildGrid(world: World): VoxelGrid {
  return new VoxelGrid(world.map, {
    cellSize: world.config.ai.cellSize,
    clearance: world.config.ai.clearance,
  });
}
