/** Common shape for anything that drives a craft: keyboard, gamepad, later AI. */

import type { PlayerInput } from '../sim/types.ts';

export interface InputSource {
  /** Human-readable name for the menu and the HUD. */
  readonly label: string;
  /** False when the device has gone away (unplugged gamepad, lost focus). */
  readonly available: boolean;
  /** Produce the command for one fixed tick. */
  sample(dt: number): PlayerInput;
  /** Point the view somewhere, e.g. after a respawn or from aim assist. */
  setAim(yaw: number, pitch?: number): void;
  dispose(): void;
}
