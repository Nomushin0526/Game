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
import type { DecoyState, EntityState, Vec3 } from '../sim/types.ts';

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
  /** True while what is being tracked is actually a decoy. */
  fooled = false;

  update(
    self: EntityState,
    enemy: EntityState | undefined,
    decoys: readonly DecoyState[],
    physics: PhysicsWorld,
    config: SkyTagConfig,
    tuning: AiTuning,
    dt: number,
  ): void {
    const wasVisible = this.visible;
    const contact = this.pickContact(self, enemy, decoys, physics, config);
    this.visible = contact !== null;
    this.fooled = contact?.decoy ?? false;

    if (contact) {
      this.visibleFor = wasVisible ? this.visibleFor + dt : 0;
      this.timeSinceSeen = 0;
      this.lastSeen = { pos: { ...contact.pos }, vel: { ...contact.vel } };
      this.acquired = this.visibleFor >= tuning.reactionTime;
    } else {
      this.visibleFor = 0;
      this.acquired = false;
      this.timeSinceSeen += dt;
    }
  }

  /**
   * Choose what the AI thinks it is looking at.
   *
   * Craft and decoys are indistinguishable to it, so when several are in view
   * it keeps tracking whichever is nearest to what it was already following.
   * That continuity is what makes a decoy work: dropped at the moment the
   * runner breaks away, the phantom carries on along the course already being
   * tracked and the real craft is the one that looks like the new contact.
   */
  private pickContact(
    self: EntityState,
    enemy: EntityState | undefined,
    decoys: readonly DecoyState[],
    physics: PhysicsWorld,
    config: SkyTagConfig,
  ): { pos: Vec3; vel: Vec3; decoy: boolean } | null {
    // A live scan overrides everything else: the craft is being tracked on
    // instruments, so decoys, cover and even a flash in the face do not get in
    // the way. Only distance does.
    const revealed = this.revealed(self, enemy, config);
    if (revealed) return revealed;

    // A flash takes the eyes entirely: no contact, and the clock on the last
    // sighting keeps running.
    if (self.blindTimer > 0) return null;

    const candidates: Array<{ pos: Vec3; vel: Vec3; decoy: boolean }> = [];
    if (enemy && this.canSee(self, enemy.pos, enemy.alive, physics, config)) {
      candidates.push({ pos: enemy.pos, vel: enemy.vel, decoy: false });
    }
    for (const phantom of decoys) {
      if (phantom.ownerId === self.id) continue;
      if (!this.canSee(self, phantom.pos, true, physics, config)) continue;
      candidates.push({ pos: phantom.pos, vel: phantom.vel, decoy: true });
    }

    if (candidates.length === 0) return null;
    if (candidates.length === 1 || !this.lastSeen) return candidates[0]!;

    const anchor = this.lastSeen.pos;
    return candidates.reduce((best, candidate) =>
      distance(candidate.pos, anchor) < distance(best.pos, anchor) ? candidate : best,
    );
  }

  /**
   * The true contact an active scan hands over, if it is in range.
   *
   * Deliberately not subject to the field of view: a ping goes out in every
   * direction, and a hunter that had to be looking the right way already would
   * not need it. What it cannot do is find a runner that has genuinely opened
   * the distance, which is what keeps `hide` worth playing.
   */
  private revealed(
    self: EntityState,
    enemy: EntityState | undefined,
    config: SkyTagConfig,
  ): { pos: Vec3; vel: Vec3; decoy: boolean } | null {
    if (self.revealTimer <= 0 || !self.alive) return null;
    if (!enemy || !enemy.alive) return null;
    if (distance(self.pos, enemy.pos) > config.items.scan.radius) return null;
    return { pos: enemy.pos, vel: enemy.vel, decoy: false };
  }

  private canSee(
    self: EntityState,
    target: Vec3,
    targetAlive: boolean,
    physics: PhysicsWorld,
    config: SkyTagConfig,
  ): boolean {
    if (!targetAlive || !self.alive) return false;

    const toEnemy = sub(target, self.pos);
    const range = Math.hypot(toEnemy.x, toEnemy.y, toEnemy.z);
    if (range < 1e-3) return true;
    if (range > config.ai.sightRange) return false;

    // Field of view first: it is a dot product, and it rejects most of the time.
    const forward = forwardVector(self.aimYaw, self.aimPitch);
    const cosAngle = dot(forward, scale(toEnemy, 1 / range));
    if (cosAngle < Math.cos(config.ai.fovRad / 2)) return false;

    return !physics.isBlocked(self.pos, target);
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
    // While fooled, the estimate is the phantom's position, which is the
    // whole point — so it comes from `lastSeen` rather than the real craft.
    if (this.visible && !this.fooled && enemy) return { ...enemy.pos };
    if (this.visible && this.lastSeen) return { ...this.lastSeen.pos };
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
    this.fooled = false;
    this.lastSeen = null;
    this.timeSinceSeen = Number.POSITIVE_INFINITY;
    this.visibleFor = 0;
  }
}
