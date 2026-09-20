/**
 * Gamepad to `PlayerInput`, using the standard mapping.
 *
 * Aim is accumulated here from the right stick, exactly as the mouse path does,
 * so the simulation still only ever receives an absolute yaw and pitch.
 */

import { CONFIG, type SkyTagConfig } from '../sim/config.ts';
import { clamp, wrapAngle } from '../sim/math.ts';
import { NO_ITEM, neutralInput, type PlayerInput } from '../sim/types.ts';
import type { InputSource } from './types.ts';

/** Standard-mapping indices (https://w3c.github.io/gamepad/#remapping). */
const AXIS_LEFT_X = 0;
const AXIS_LEFT_Y = 1;
const AXIS_RIGHT_X = 2;
const AXIS_RIGHT_Y = 3;
const BUTTON_LB = 4;
const BUTTON_RB = 5;
const BUTTON_LT = 6;
const BUTTON_RT = 7;
/** Face buttons, one per item slot: A, B, X in standard mapping order. */
const ITEM_BUTTONS = [0, 1, 2];

/** Analog triggers count as pressed past this much travel. */
const TRIGGER_THRESHOLD = 0.35;

export class GamepadInput implements InputSource {
  readonly label: string;
  private readonly config: SkyTagConfig;
  private yaw: number;
  private pitch = 0;
  private invertY: boolean;
  /** Face buttons held at the previous sample, for edge detection. */
  private heldItems = new Set<number>();

  constructor(
    private readonly index: number,
    options: { config?: SkyTagConfig; initialYaw?: number; invertY?: boolean } = {},
  ) {
    this.config = options.config ?? CONFIG;
    this.yaw = options.initialYaw ?? 0;
    this.invertY = options.invertY ?? false;
    this.label = `Gamepad ${index + 1}`;
  }

  get available(): boolean {
    return this.pad !== null;
  }

  private get pad(): Gamepad | null {
    // Snapshots, not live objects: the array has to be re-read every sample.
    return navigator.getGamepads?.()[this.index] ?? null;
  }

  sample(dt: number): PlayerInput {
    const pad = this.pad;
    if (!pad) {
      this.heldItems.clear();
      return { ...neutralInput(), aimYaw: this.yaw, aimPitch: this.pitch };
    }

    const move = stickVector(
      axis(pad, AXIS_LEFT_X),
      axis(pad, AXIS_LEFT_Y),
      this.config.input.gamepadDeadzone,
    );
    const look = stickVector(
      axis(pad, AXIS_RIGHT_X),
      axis(pad, AXIS_RIGHT_Y),
      this.config.input.gamepadDeadzone,
    );

    const rate = this.config.input.stickSensitivity * dt;
    this.yaw = wrapAngle(this.yaw - look.x * rate);
    this.pitch = clamp(
      this.pitch - (this.invertY ? -look.y : look.y) * rate,
      -this.config.flight.maxPitch,
      this.config.flight.maxPitch,
    );

    return {
      move: {
        x: move.x,
        // RB climbs, LB dives (DESIGN.md section 3).
        y: (pressed(pad, BUTTON_RB) ? 1 : 0) - (pressed(pad, BUTTON_LB) ? 1 : 0),
        // Stick up reads -1, and up means forward.
        z: -move.y,
      },
      aimYaw: this.yaw,
      aimPitch: this.pitch,
      fire: pressed(pad, BUTTON_RT),
      boost: pressed(pad, BUTTON_LT),
      useItem: this.pickItem(pad),
    };
  }

  /** The item slot newly pressed this sample, or `NO_ITEM`. */
  private pickItem(pad: Gamepad): number {
    let used = NO_ITEM;
    for (const [slot, button] of ITEM_BUTTONS.entries()) {
      const down = pressed(pad, button);
      // Edge-triggered: a held button spends one charge, not one per tick.
      if (down && !this.heldItems.has(button) && used === NO_ITEM) used = slot;
      if (down) this.heldItems.add(button);
      else this.heldItems.delete(button);
    }
    return used;
  }

  setAim(yaw: number, pitch = this.pitch): void {
    this.yaw = wrapAngle(yaw);
    this.pitch = clamp(pitch, -this.config.flight.maxPitch, this.config.flight.maxPitch);
  }

  dispose(): void {
    // Nothing to unsubscribe: the Gamepad API is polled, not evented.
  }
}

/** Index of the first connected pad, or null. */
export function firstConnectedGamepad(skip: number[] = []): number | null {
  const pads = navigator.getGamepads?.() ?? [];
  for (let i = 0; i < pads.length; i++) {
    if (pads[i] && !skip.includes(i)) return i;
  }
  return null;
}

function axis(pad: Gamepad, index: number): number {
  return pad.axes[index] ?? 0;
}

function pressed(pad: Gamepad, index: number): boolean {
  const button = pad.buttons[index];
  if (!button) return false;
  return button.pressed || button.value > TRIGGER_THRESHOLD;
}

/**
 * Radial deadzone, rescaled so the first usable movement starts at zero.
 * A per-axis deadzone would make diagonals feel notched.
 */
function stickVector(x: number, y: number, deadzone: number): { x: number; y: number } {
  const magnitude = Math.hypot(x, y);
  if (magnitude < deadzone) return { x: 0, y: 0 };
  const scaled = Math.min(1, (magnitude - deadzone) / (1 - deadzone)) / magnitude;
  return { x: x * scaled, y: y * scaled };
}
