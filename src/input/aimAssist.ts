/**
 * Weak aim assist for gamepad players (DESIGN.md section 3).
 *
 * It only ever nudges the view the player already pointed roughly at the
 * target: outside the cone, or with no line of sight, it does nothing. The
 * result is written back into the input source so the next sample continues
 * from the corrected angle instead of snapping back.
 */

import type { SkyTagConfig } from '../sim/config.ts';
import { angleDelta, distance, lookAngles } from '../sim/math.ts';
import type { PhysicsWorld } from '../sim/physics.ts';
import type { EntityState, PlayerInput } from '../sim/types.ts';

export interface AimAssistContext {
  config: SkyTagConfig;
  physics: PhysicsWorld;
  dt: number;
}

/**
 * Return `input` with its aim pulled towards `target`, or unchanged.
 * `self` and `target` are simulation state and are never modified.
 */
export function applyAimAssist(
  input: PlayerInput,
  self: EntityState,
  target: EntityState | undefined,
  ctx: AimAssistContext,
): PlayerInput {
  const { config, physics, dt } = ctx;
  if (!config.input.aimAssistEnabled) return input;
  if (!target || !target.alive || !self.alive) return input;
  if (distance(self.pos, target.pos) > config.loadout[self.team].range) return input;

  const desired = lookAngles(self.pos, target.pos);
  const dYaw = angleDelta(input.aimYaw, desired.yaw);
  const dPitch = desired.pitch - input.aimPitch;
  // Angular error along the shortest path, used as the cone test.
  if (Math.hypot(dYaw, dPitch) > config.input.aimAssistConeRad) return input;

  // Never help someone shoot through a wall.
  if (physics.isBlocked(self.pos, target.pos)) return input;

  // Frame-rate independent: close this fraction of the error per second.
  const pull = 1 - Math.exp(-config.input.aimAssistStrength * dt);
  return {
    ...input,
    aimYaw: input.aimYaw + dYaw * pull,
    aimPitch: input.aimPitch + dPitch * pull,
  };
}
