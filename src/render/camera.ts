/**
 * Third-person chase camera.
 *
 * Purely a view concern: it reads the craft's interpolated transform and never
 * feeds anything back into the simulation.
 */

import * as THREE from 'three';
import { clamp, forwardVector, rightVector } from '../sim/math.ts';
import type { EntityState, Vec3 } from '../sim/types.ts';

/** Where the eye sits. First person removes the hull from the view entirely. */
export type CameraMode = 'chase' | 'cockpit';

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
  /**
   * Radians of roll at full turn rate.
   *
   * Nothing in the simulation rolls — a craft translates and yaws, and that
   * is exactly what playtesting described as "flat". Banking into a turn is
   * the cue that says a turn is happening, and putting it on the camera costs
   * the simulation nothing because the camera is already downstream of it.
   */
  bank?: number;
  /** Turn rate, rad/s, that produces a full `bank`. */
  bankAtRate?: number;
  /** Degrees of extra field of view while boosting. Speed you can feel. */
  boostFov?: number;
  /** Metres forward of the craft's centre for the cockpit eye. */
  eyeForward?: number;
  /** Metres above the craft's centre for the cockpit eye. */
  eyeHeight?: number;
}

const DEFAULTS: Required<FollowCameraOptions> = {
  distance: 14,
  height: 4.2,
  lookAhead: 14,
  lookHeight: 5.5,
  positionLag: 12,
  speedPullback: 0.09,
  fov: 72,
  bank: 0.42,
  bankAtRate: 2.2,
  boostFov: 11,
  eyeForward: 1.1,
  eyeHeight: 0.7,
};

export class FollowCamera {
  readonly camera: THREE.PerspectiveCamera;
  private readonly options: Required<FollowCameraOptions>;
  private readonly position = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private initialised = false;
  private mode: CameraMode = 'chase';
  /** Smoothed roll, so a flick of the mouse does not snap the horizon over. */
  private roll = 0;
  private lastYaw = 0;
  private fov: number;

  constructor(aspect: number, options: FollowCameraOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.fov = this.options.fov;
    this.camera = new THREE.PerspectiveCamera(this.fov, aspect, 0.2, 2000);
  }

  /** Which view this camera is showing. */
  get cameraMode(): CameraMode {
    return this.mode;
  }

  /**
   * Swap between chase and cockpit.
   *
   * Playtesting found the third-person view made height hard to judge, which
   * is inherent to it: the craft is drawn at a fixed offset from the eye, so
   * everything nearby is seen past a hull that is not where the eye is. From
   * inside, what the camera sees is what the craft will hit.
   */
  setMode(mode: CameraMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.initialised = false;
  }

  toggleMode(): CameraMode {
    this.setMode(this.mode === 'chase' ? 'cockpit' : 'chase');
    return this.mode;
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

    this.trackRoll(entity.aimYaw, dt);
    this.trackFov(entity.boosting, dt);

    const cockpit = this.mode === 'cockpit';
    const speed = Math.hypot(entity.vel.x, entity.vel.y, entity.vel.z);
    const back = cockpit
      ? -this.options.eyeForward
      : this.options.distance + speed * this.options.speedPullback;
    const rise = cockpit ? this.options.eyeHeight : this.options.height;
    const ahead = cockpit ? 60 : this.options.lookAhead;
    const aheadRise = cockpit ? this.options.eyeHeight : this.options.lookHeight;

    const desired = new THREE.Vector3(
      renderPos.x - fwd.x * back + up.x * rise,
      renderPos.y - fwd.y * back + up.y * rise,
      renderPos.z - fwd.z * back + up.z * rise,
    );
    const lookAt = new THREE.Vector3(
      renderPos.x + fwd.x * ahead + up.x * aheadRise,
      renderPos.y + fwd.y * ahead + up.y * aheadRise,
      renderPos.z + fwd.z * ahead + up.z * aheadRise,
    );

    if (!this.initialised) {
      this.position.copy(desired);
      this.target.copy(lookAt);
      this.initialised = true;
    } else {
      // Frame-rate independent exponential smoothing. The cockpit is rigid:
      // lag between the eye and the hull it sits in reads as sickness, not
      // weight.
      const lag = cockpit ? this.options.positionLag * 3 : this.options.positionLag;
      const t = 1 - Math.exp(-lag * dt);
      this.position.lerp(desired, t);
      this.target.lerp(lookAt, t);
    }

    this.camera.position.copy(this.position);
    this.camera.up.set(up.x, up.y, up.z).applyAxisAngle(
      new THREE.Vector3(fwd.x, fwd.y, fwd.z),
      this.roll,
    );
    this.camera.lookAt(this.target);
  }

  /** Roll of the horizon, driven by how fast the view is turning. */
  private trackRoll(yaw: number, dt: number): void {
    if (dt <= 0) return;
    // Shortest way round, so crossing the wrap point is not read as a spin.
    let delta = yaw - this.lastYaw;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    this.lastYaw = yaw;

    const rate = delta / dt;
    const wanted = clamp(rate / this.options.bankAtRate, -1, 1) * this.options.bank;
    // Slower than the turn itself, so the bank leans in and settles back
    // rather than tracking every twitch of the mouse.
    this.roll += (wanted - this.roll) * (1 - Math.exp(-6 * dt));
  }

  /** Field of view opens while boosting, which is what makes speed felt. */
  private trackFov(boosting: boolean, dt: number): void {
    const wanted = this.options.fov + (boosting ? this.options.boostFov : 0);
    this.fov += (wanted - this.fov) * (1 - Math.exp(-5 * dt));
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Snap on the next update, e.g. after a respawn or a round reset. */
  reset(): void {
    this.initialised = false;
    this.roll = 0;
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
