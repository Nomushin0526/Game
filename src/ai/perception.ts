/**
 * What the AI is allowed to know.
 *
 * The rule from DESIGN.md 7.1 is that the CPU does not cheat: it sees the enemy
 * only inside its field of view with a clear line of sight, and otherwise works
 * from a remembered last known position and velocity, exactly as a player would.
 */

import type { AiTuning, SkyTagConfig } from '../sim/config.ts';
import { add, distance, dot, forwardVector, normalize, scale, sub } from '../sim/math.ts';
import type { PhysicsWorld } from '../sim/physics.ts';
import type { EntityState, Vec3 } from '../sim/types.ts';

/** How far ahead a remembered velocity is extrapolated, seconds. */
const MAX_DEAD_RECKONING = 2.0;

export interface Sighting {
  pos: Vec3;
  vel: Vec3;
}

export class Perception {
  /** Enemy is in the cone and not behind cover, right now. */
  visible = false;
  /**
   * Visible for longer than the difficulty's reaction time.
   * Brains act on this, never on `visible`, so a target that flashes past a gap
   * does not get shot at instantly.
   */
  acquired = false;
  lastSeen: Sighting | null = null;
  /** Seconds since the enemy was last visible. Infinite before the first sighting. */
  timeSinceSeen = Number.POSITIVE_INFINITY;
  /** Seconds the enemy has been continuously visible. */
  visibleFor = 0;

  update(
    self: EntityState,
    enemy: EntityState | undefined,
    physics: PhysicsWorld,
    config: SkyTagConfig,
    tuning: AiTuning,
    dt: number,
  ): void {
    const wasVisible = this.visible;
    this.visible = Boolean(enemy) && this.canSee(self, enemy!, physics, config);

    if (this.visible) {
      this.visibleFor = wasVisible ? this.visibleFor + dt : 0;
      this.timeSinceSeen = 0;
      this.lastSeen = { pos: { ...enemy!.pos }, vel: { ...enemy!.vel } };
      this.acquired = this.visibleFor >= tuning.reactionTime;
    } else {
      this.visibleFor = 0;
      this.acquired = false;
      this.timeSinceSeen += dt;
    }
  }

  private canSee(
    self: EntityState,
    enemy: EntityState,
    physics: PhysicsWorld,
    config: SkyTagConfig,
  ): boolean {
    if (!enemy.alive || !self.alive) return false;

    const toEnemy = sub(enemy.pos, self.pos);
    const range = Math.hypot(toEnemy.x, toEnemy.y, toEnemy.z);
    if (range < 1e-3) return true;
    if (range > config.ai.sightRange) return false;

    // Field of view first: it is a dot product, and it rejects most of the time.
    const forward = forwardVector(self.aimYaw, self.aimPitch);
    const cosAngle = dot(forward, scale(toEnemy, 1 / range));
    if (cosAngle < Math.cos(config.ai.fovRad / 2)) return false;

    return !physics.isBlocked(self.pos, enemy.pos);
  }

  /** True while the remembered position is still worth acting on. */
  hasMemory(config: SkyTagConfig): boolean {
    return this.lastSeen !== null && this.timeSinceSeen < config.ai.memoryDuration;
  }

  /**
   * Best guess at where the enemy is now: the real position while visible, or
   * the last sighting carried forward along its velocity while it is fresh.
   */
  estimate(enemy: EntityState | undefined, config: SkyTagConfig): Vec3 | null {
    if (this.visible && enemy) return { ...enemy.pos };
    if (!this.hasMemory(config) || !this.lastSeen) return null;

    const elapsed = Math.min(this.timeSinceSeen, MAX_DEAD_RECKONING);
    return add(this.lastSeen.pos, scale(this.lastSeen.vel, elapsed));
  }

  /** Confidence in `estimate()`, 1 while watching and decaying once lost. */
  confidence(config: SkyTagConfig): number {
    if (this.visible) return 1;
    if (!this.hasMemory(config)) return 0;
    return 1 - this.timeSinceSeen / config.ai.memoryDuration;
  }

  /** Unit vector the enemy was last heading in, or null. */
  lastHeading(): Vec3 | null {
    if (!this.lastSeen) return null;
    const speed = Math.hypot(this.lastSeen.vel.x, this.lastSeen.vel.y, this.lastSeen.vel.z);
    return speed > 1 ? normalize(this.lastSeen.vel) : null;
  }

  distanceTo(self: EntityState, enemy: EntityState | undefined): number {
    return enemy ? distance(self.pos, enemy.pos) : Number.POSITIVE_INFINITY;
  }

  reset(): void {
    this.visible = false;
    this.acquired = false;
    this.lastSeen = null;
    this.timeSinceSeen = Number.POSITIVE_INFINITY;
    this.visibleFor = 0;
  }
}
