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
import { NO_ITEM, neutralInput, type PlayerInput } from '../sim/types.ts';
import type { InputSource } from './types.ts';

export interface KeyBindings {
  forward: string[];
  back: string[];
  left: string[];
  right: string[];
  up: string[];
  down: string[];
  boost: string[];
  /** One key per item slot, in slot order. */
  items: string[];
}

export const DEFAULT_BINDINGS: KeyBindings = {
  forward: ['KeyW'],
  back: ['KeyS'],
  left: ['KeyA'],
  right: ['KeyD'],
  up: ['Space'],
  down: ['ControlLeft', 'ControlRight'],
  boost: ['ShiftLeft', 'ShiftRight'],
  items: ['Digit1', 'Digit2', 'Digit3'],
};

export class KeyboardMouseInput implements InputSource {
  readonly label = 'Keyboard + Mouse';
  private readonly held = new Set<string>();
  private readonly bindings: KeyBindings;
  private readonly config: SkyTagConfig;
  private yaw = 0;
  private pitch = 0;
  private firing = false;
  /**
   * Item slot pressed since the last sample, or `NO_ITEM`.
   *
   * Latched on key down and cleared when read, so one press spends exactly one
   * charge no matter how the key press lines up with the fixed tick.
   */
  private queuedItem = NO_ITEM;
  /**
   * Movement keys double-tapped into a dash, and when the tap happened.
   *
   * Boost stays on while the key is held after the second tap, so a dash is
   * "tap tap and keep going" rather than a fixed-length lunge. Releasing the
   * key ends it, which makes stopping a dash the same gesture as stopping.
   */
  private readonly lastTap = new Map<string, number>();
  private readonly dashing = new Set<string>();
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
      // Either gesture boosts: the modifier still works for anyone who
      // prefers it, and a double tap is there for anyone who does not.
      boost: this.anyHeld(this.bindings.boost) || this.dashing.size > 0,
      useItem: this.takeQueuedItem(),
    };
  }

  private takeQueuedItem(): number {
    const queued = this.queuedItem;
    this.queuedItem = NO_ITEM;
    return queued;
  }

  /** Align the view with a freshly spawned craft. */
  setAim(yaw: number, pitch = 0): void {
    this.yaw = wrapAngle(yaw);
    this.pitch = clamp(pitch, -this.config.flight.maxPitch, this.config.flight.maxPitch);
  }

  private anyHeld(codes: string[]): boolean {
    return codes.some((code) => this.held.has(code));
  }

  /** Second press of a movement key inside the window starts a dash. */
  private noteTap(code: string): void {
    if (!this.isMovementKey(code)) return;
    const now = performance.now() / 1000;
    const previous = this.lastTap.get(code);
    if (previous !== undefined && now - previous <= this.config.input.doubleTapWindow) {
      this.dashing.add(code);
      // Consumed, so a third tap has to start a fresh pair rather than
      // re-triggering off the same timestamp.
      this.lastTap.delete(code);
      return;
    }
    this.lastTap.set(code, now);
  }

  private isMovementKey(code: string): boolean {
    const b = this.bindings;
    return [b.forward, b.back, b.left, b.right, b.up, b.down].some((codes) =>
      codes.includes(code),
    );
  }

  private attach(): void {
    const onKeyDown = (e: KeyboardEvent): void => {
      // Latch on the transition, not while held: repeat events would otherwise
      // queue a fresh use every frame the key is down.
      if (!this.held.has(e.code)) {
        const slot = this.bindings.items.indexOf(e.code);
        if (slot >= 0) this.queuedItem = slot;
        this.noteTap(e.code);
      }
      this.held.add(e.code);
      // Space and Ctrl would otherwise scroll the page or open browser menus.
      if (e.code === 'Space' || e.code.startsWith('Control')) e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      this.held.delete(e.code);
      // A dash lasts as long as you keep flying that way.
      this.dashing.delete(e.code);
    };
    // Losing focus mid-flight must not leave a key stuck down.
    const onBlur = (): void => {
      this.held.clear();
      this.dashing.clear();
      this.lastTap.clear();
      this.firing = false;
      this.queuedItem = NO_ITEM;
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
