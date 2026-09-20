/**
 * Keyboard + mouse to `PlayerInput`.
 *
 * Aim is accumulated here rather than in the simulation so that mouse motion is
 * not tied to the fixed tick rate; the simulation only ever sees the resulting
 * absolute yaw/pitch.
 */

import type { SkyTagConfig } from '../sim/config.ts';
import { CONFIG } from '../sim/config.ts';
import { clamp, wrapAngle } from '../sim/math.ts';
import { neutralInput, type PlayerInput } from '../sim/types.ts';
import type { InputSource } from './types.ts';

export interface KeyBindings {
  forward: string[];
  back: string[];
  left: string[];
  right: string[];
  up: string[];
  down: string[];
  boost: string[];
}

export const DEFAULT_BINDINGS: KeyBindings = {
  forward: ['KeyW'],
  back: ['KeyS'],
  left: ['KeyA'],
  right: ['KeyD'],
  up: ['Space'],
  down: ['ControlLeft', 'ControlRight'],
  boost: ['ShiftLeft', 'ShiftRight'],
};

export class KeyboardMouseInput implements InputSource {
  readonly label = 'Keyboard + Mouse';
  private readonly held = new Set<string>();
  private readonly bindings: KeyBindings;
  private readonly config: SkyTagConfig;
  private yaw = 0;
  private pitch = 0;
  private firing = false;
  private disposers: Array<() => void> = [];

  constructor(
    private readonly element: HTMLElement,
    options: { config?: SkyTagConfig; bindings?: KeyBindings; initialYaw?: number } = {},
  ) {
    this.config = options.config ?? CONFIG;
    this.bindings = options.bindings ?? DEFAULT_BINDINGS;
    this.yaw = options.initialYaw ?? 0;
    this.attach();
  }

  /** True while the browser has pointer lock, i.e. mouse look is active. */
  get pointerLocked(): boolean {
    return document.pointerLockElement === this.element;
  }

  /** Keyboard and mouse are always there; only pointer lock comes and goes. */
  get available(): boolean {
    return this.disposers.length > 0;
  }

  requestPointerLock(): void {
    void this.element.requestPointerLock();
  }

  sample(): PlayerInput {
    const axis = (negative: string[], positive: string[]): number =>
      (this.anyHeld(positive) ? 1 : 0) - (this.anyHeld(negative) ? 1 : 0);

    return {
      ...neutralInput(),
      move: {
        x: axis(this.bindings.left, this.bindings.right),
        y: axis(this.bindings.down, this.bindings.up),
        z: axis(this.bindings.back, this.bindings.forward),
      },
      aimYaw: this.yaw,
      aimPitch: this.pitch,
      fire: this.firing,
      boost: this.anyHeld(this.bindings.boost),
    };
  }

  /** Align the view with a freshly spawned craft. */
  setAim(yaw: number, pitch = 0): void {
    this.yaw = wrapAngle(yaw);
    this.pitch = clamp(pitch, -this.config.flight.maxPitch, this.config.flight.maxPitch);
  }

  private anyHeld(codes: string[]): boolean {
    return codes.some((code) => this.held.has(code));
  }

  private attach(): void {
    const onKeyDown = (e: KeyboardEvent): void => {
      this.held.add(e.code);
      // Space and Ctrl would otherwise scroll the page or open browser menus.
      if (e.code === 'Space' || e.code.startsWith('Control')) e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent): void => void this.held.delete(e.code);
    // Losing focus mid-flight must not leave a key stuck down.
    const onBlur = (): void => {
      this.held.clear();
      this.firing = false;
    };

    const onMouseMove = (e: MouseEvent): void => {
      if (!this.pointerLocked) return;
      const sensitivity = this.config.input.mouseSensitivity;
      this.yaw = wrapAngle(this.yaw - e.movementX * sensitivity);
      this.pitch = clamp(
        this.pitch - e.movementY * sensitivity,
        -this.config.flight.maxPitch,
        this.config.flight.maxPitch,
      );
    };
    const onMouseDown = (e: MouseEvent): void => {
      if (e.button !== 0) return;
      if (!this.pointerLocked) { this.requestPointerLock(); return; }
      this.firing = true;
    };
    const onMouseUp = (e: MouseEvent): void => { if (e.button === 0) this.firing = false; };
    const onContextMenu = (e: Event): void => e.preventDefault();

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    document.addEventListener('pointerlockchange', onBlur);
    window.addEventListener('mousemove', onMouseMove);
    this.element.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    this.element.addEventListener('contextmenu', onContextMenu);

    this.disposers = [
      () => window.removeEventListener('keydown', onKeyDown),
      () => window.removeEventListener('keyup', onKeyUp),
      () => window.removeEventListener('blur', onBlur),
      () => document.removeEventListener('pointerlockchange', onBlur),
      () => window.removeEventListener('mousemove', onMouseMove),
      () => this.element.removeEventListener('mousedown', onMouseDown),
      () => window.removeEventListener('mouseup', onMouseUp),
      () => this.element.removeEventListener('contextmenu', onContextMenu),
    ];
  }

  dispose(): void {
    for (const off of this.disposers) off();
    this.disposers = [];
  }
}
