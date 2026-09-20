/**
 * Third-person chase camera.
 *
 * Purely a view concern: it reads the craft's interpolated transform and never
 * feeds anything back into the simulation.
 */

import * as THREE from 'three';
import { forwardVector, rightVector } from '../sim/math.ts';
import type { EntityState, Vec3 } from '../sim/types.ts';

export interface FollowCameraOptions {
  /** Metres behind the craft. */
  distance?: number;
  /** Metres above the craft. */
  height?: number;
  /** Metres ahead of the craft that the camera looks at. */
  lookAhead?: number;
  /** Metres above the craft for the look-at point. Raising it drops the hull
   *  lower in frame so it stops covering the centre of the screen. */
  lookHeight?: number;
  /** Position smoothing, fraction of the remaining gap closed per second. */
  positionLag?: number;
  /** Extra pull-back at speed, metres per (m/s). */
  speedPullback?: number;
  fov?: number;
}

const DEFAULTS: Required<FollowCameraOptions> = {
  distance: 14,
  height: 4.2,
  lookAhead: 14,
  lookHeight: 5.5,
  positionLag: 12,
  speedPullback: 0.09,
  fov: 72,
};

export class FollowCamera {
  readonly camera: THREE.PerspectiveCamera;
  private readonly options: Required<FollowCameraOptions>;
  private readonly position = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private initialised = false;

  constructor(aspect: number, options: FollowCameraOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.camera = new THREE.PerspectiveCamera(this.options.fov, aspect, 0.2, 2000);
  }

  /**
   * @param renderPos interpolated craft position for this frame
   * @param dt        real frame time in seconds (not the fixed sim step)
   */
  update(entity: EntityState, renderPos: Vec3, dt: number): void {
    const fwd = forwardVector(entity.aimYaw, entity.aimPitch);
    const right = rightVector(entity.aimYaw);
    // Craft-up, so the camera rolls with a steep climb instead of clipping through.
    const up = cross(right, fwd);

    const speed = Math.hypot(entity.vel.x, entity.vel.y, entity.vel.z);
    const back = this.options.distance + speed * this.options.speedPullback;

    const desired = new THREE.Vector3(
      renderPos.x - fwd.x * back + up.x * this.options.height,
      renderPos.y - fwd.y * back + up.y * this.options.height,
      renderPos.z - fwd.z * back + up.z * this.options.height,
    );
    const lookAt = new THREE.Vector3(
      renderPos.x + fwd.x * this.options.lookAhead + up.x * this.options.lookHeight,
      renderPos.y + fwd.y * this.options.lookAhead + up.y * this.options.lookHeight,
      renderPos.z + fwd.z * this.options.lookAhead + up.z * this.options.lookHeight,
    );

    if (!this.initialised) {
      this.position.copy(desired);
      this.target.copy(lookAt);
      this.initialised = true;
    } else {
      // Frame-rate independent exponential smoothing.
      const t = 1 - Math.exp(-this.options.positionLag * dt);
      this.position.lerp(desired, t);
      this.target.lerp(lookAt, t);
    }

    this.camera.position.copy(this.position);
    this.camera.up.set(up.x, up.y, up.z);
    this.camera.lookAt(this.target);
  }

  /** Snap on the next update, e.g. after a respawn or a round reset. */
  reset(): void {
    this.initialised = false;
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}
