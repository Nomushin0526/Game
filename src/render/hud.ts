/**
 * Per-player HUD, drawn as DOM over the 3D viewport.
 *
 * Read-only with respect to the simulation. One instance per split-screen
 * pane; it positions itself over its own viewport.
 */

import type { HudConfig, ItemKind, SkyTagConfig } from '../sim/config.ts';
import { dot, forwardVector, rightVector, sub } from '../sim/math.ts';
import type { PhysicsWorld } from '../sim/physics.ts';
import { describeResult, type MatchState } from '../sim/rules.ts';
import type { DecoyState, EntityState, ItemSlotState, Vec3 } from '../sim/types.ts';
import { TEAM_COLORS } from './scene.ts';

export interface HudViewport {
  /** CSS pixels from the left of the canvas. */
  left: number;
  /** CSS pixels from the top of the canvas. */
  top: number;
  width: number;
  height: number;
}

export interface HudFrame {
  self: EntityState;
  enemy: EntityState | undefined;
  /** Phantoms in the air. They get an indicator of their own; see `updateEnemy`. */
  decoys: readonly DecoyState[];
  match: MatchState;
  /** Banner across the middle of this pane, or null. */
  message: string | null;
  submessage?: string | null;
}

export class Hud {
  private readonly root: HTMLDivElement;
  private readonly banner: HTMLDivElement;
  private readonly subBanner: HTMLDivElement;
  private readonly clock: HTMLDivElement;
  private readonly score: HTMLDivElement;
  private readonly role: HTMLDivElement;
  private readonly selfHp: Bar;
  private readonly enemyHp: Bar;
  private readonly boost: Bar;
  private readonly heat: Bar;
  private readonly radar: HTMLDivElement;
  /** One dot per painted contact, real or fake; pooled across frames. */
  private readonly blips: HTMLDivElement[] = [];
  private readonly enemyLabel: HTMLDivElement;
  private readonly items: HTMLDivElement;
  private readonly itemSlots: ItemSlotView[] = [];
  private readonly blindOverlay: HTMLDivElement;

  constructor(
    container: HTMLElement,
    private readonly playerLabel: string,
    private readonly config: SkyTagConfig,
    private readonly physics: PhysicsWorld,
  ) {
    this.root = el('div', 'hud-pane');

    const top = el('div', 'hud-top');
    this.clock = el('div', 'hud-clock');
    this.score = el('div', 'hud-score');
    top.append(this.score, this.clock);

    const enemyBlock = el('div', 'hud-enemy');
    this.enemyLabel = el('div', 'hud-enemy-label');
    this.enemyHp = new Bar('hud-bar-enemy');
    enemyBlock.append(this.enemyLabel, this.enemyHp.root);

    const bottom = el('div', 'hud-bottom');
    this.role = el('div', 'hud-role');
    this.selfHp = new Bar('hud-bar-hp', 'HP');
    this.boost = new Bar('hud-bar-boost', 'BST');
    this.heat = new Bar('hud-bar-heat', 'HEAT');
    bottom.append(this.role, this.selfHp.root, this.boost.root, this.heat.root);

    this.items = el('div', 'hud-items');
    bottom.append(this.items);

    this.banner = el('div', 'hud-banner');
    this.subBanner = el('div', 'hud-subbanner');
    this.radar = el('div', 'hud-radar');
    this.radar.append(el('div', 'hud-radar-ring'), el('div', 'hud-radar-self'));
    this.blindOverlay = el('div', 'hud-blind');

    const crosshair = el('div', 'hud-crosshair');
    this.root.append(
      top, enemyBlock, bottom, this.radar, crosshair,
      this.blindOverlay, this.banner, this.subBanner,
    );
    container.append(this.root);
  }

  /** Move the pane over its viewport. Called on resize and on layout changes. */
  setViewport(v: HudViewport): void {
    Object.assign(this.root.style, {
      left: `${v.left}px`,
      top: `${v.top}px`,
      width: `${v.width}px`,
      height: `${v.height}px`,
    });
  }

  update(frame: HudFrame): void {
    const { self, enemy, match } = frame;
    const loadout = this.config.loadout[self.team];

    this.clock.textContent = formatClock(match.timeRemaining);
    this.clock.classList.toggle('urgent', match.timeRemaining <= 15);
    this.score.textContent = `R${match.round}  ${match.scores.join(' - ')}`;

    this.role.textContent = `${this.playerLabel} — ${self.team === 'hunter' ? '鬼 HUNTER' : '逃亡者 RUNNER'}`;
    this.role.style.color = `#${TEAM_COLORS[self.team].toString(16).padStart(6, '0')}`;

    this.selfHp.set(self.hp / loadout.maxHp, `${Math.ceil(self.hp)}`);
    this.boost.set(self.boostFuel / this.config.flight.boostCapacity, self.boosting ? 'BOOST' : '');
    this.heat.set(self.heat / loadout.heatCapacity, self.overheated ? 'OVERHEAT' : '');
    this.heat.root.classList.toggle('overheated', self.overheated);

    this.updateItems(self.items);
    // A flash whites the pane out and fades; the sim decides how long.
    const blinded = self.blindTimer > 0;
    this.blindOverlay.style.opacity = blinded ? String(Math.min(1, self.blindTimer / 0.8)) : '0';

    this.updateEnemy(self, enemy, frame.decoys);

    this.banner.textContent = frame.message ?? '';
    this.banner.classList.toggle('visible', Boolean(frame.message));
    this.subBanner.textContent = frame.submessage ?? '';
    this.subBanner.classList.toggle('visible', Boolean(frame.submessage));
  }

  private updateEnemy(
    self: EntityState,
    enemy: EntityState | undefined,
    decoys: readonly DecoyState[],
  ): void {
    if (!enemy || !this.config.hud.showEnemyHp) {
      this.enemyLabel.textContent = '';
      this.enemyHp.root.style.visibility = 'hidden';
    } else {
      this.enemyHp.root.style.visibility = 'visible';
      this.enemyLabel.textContent = enemy.team === 'hunter' ? '鬼 HUNTER' : '逃亡者 RUNNER';
      this.enemyHp.set(enemy.hp / this.config.loadout[enemy.team].maxHp, `${Math.ceil(enemy.hp)}`);
    }

    const painted = radarBlips(self, enemy, decoys, this.config.hud, (from, to) =>
      this.physics.isBlocked(from, to),
    );

    while (this.blips.length < painted.length) {
      const blip = el('div', 'hud-blip');
      this.blips.push(blip);
      this.radar.append(blip);
    }
    this.blips.forEach((blip, index) => {
      const contact = painted[index];
      blip.style.display = contact ? 'block' : 'none';
      if (!contact) return;

      // Radar space is +y forward; the screen is +y down.
      blip.style.left = `${(contact.x + 1) * 50}%`;
      blip.style.top = `${(1 - contact.y) * 50}%`;
      blip.className = `hud-blip ${contact.altitude}`;
      // Nearer contacts read hotter, so a closing threat is felt, not counted.
      blip.classList.toggle('close', contact.distance < this.config.hud.radarRange * 0.35);
    });
  }

  /** Rebuilds the chips only when the loadout changes, e.g. on a side swap. */
  private updateItems(slots: readonly ItemSlotState[]): void {
    if (this.itemSlots.length !== slots.length) {
      this.items.replaceChildren();
      this.itemSlots.length = 0;
      slots.forEach((slot, index) => {
        const root = el('div', 'hud-item');
        root.append(el('span', 'hud-item-key', String(index + 1)));
        root.append(el('span', 'hud-item-name', ITEM_LABELS[slot.kind]));
        const charges = el('span', 'hud-item-charges');
        const cooldown = el('div', 'hud-item-cooldown');
        root.append(charges, cooldown);
        this.items.append(root);
        this.itemSlots.push({ root, charges, cooldown });
      });
    }

    slots.forEach((slot, index) => {
      const view = this.itemSlots[index]!;
      const max = this.config.items[slot.kind].cooldown;
      view.charges.textContent = '●'.repeat(slot.charges) || '—';
      view.root.classList.toggle('spent', slot.charges <= 0);
      view.root.classList.toggle('cooling', slot.cooldown > 0 && slot.charges > 0);
      // A wipe that shrinks as the slot comes back up.
      view.cooldown.style.width = max > 0 ? `${(slot.cooldown / max) * 100}%` : '0%';
    });
  }

  dispose(): void {
    this.root.remove();
  }
}

/** Where a contact sits relative to you, in altitude terms. */
export type BlipAltitude = 'above' | 'level' | 'below';

/** One painted contact, in radar space. */
export interface RadarBlip {
  /** -1 (hard left) to 1 (hard right). */
  x: number;
  /** -1 (behind) to 1 (ahead). */
  y: number;
  altitude: BlipAltitude;
  /** Distance in metres, for styling near contacts more urgently. */
  distance: number;
}

/**
 * Everything the radar paints, real craft and decoys alike.
 *
 * Exported and pure so the rule can be tested without a DOM. Nothing in the
 * output says which blip is which: a display that singled out the real craft
 * would make the decoy worthless against a human, who would simply read the
 * radar and ignore the phantom. So contacts are collected the same way
 * `Perception` collects them for the CPU, and a decoy just adds a blip.
 *
 * Radar space is rotated into the viewer's heading — up is where they are
 * facing — and scaled by `range`, with anything beyond it left off entirely.
 */
export function radarBlips(
  self: EntityState,
  enemy: EntityState | undefined,
  decoys: readonly DecoyState[],
  config: HudConfig,
  isBlocked: (from: Vec3, to: Vec3) => boolean,
): RadarBlip[] {
  if (config.enemyIndicator === 'never' || !self.alive) return [];

  const contacts: Vec3[] = [];
  const visible = (at: Vec3): boolean =>
    config.enemyIndicator === 'always' || !isBlocked(self.pos, at);

  if (enemy && enemy.alive && visible(enemy.pos)) contacts.push(enemy.pos);
  for (const decoy of decoys) {
    // Your own phantoms are not contacts to you.
    if (decoy.ownerId === self.id) continue;
    if (visible(decoy.pos)) contacts.push(decoy.pos);
  }

  const forward = forwardVector(self.aimYaw, 0);
  const right = rightVector(self.aimYaw);
  const blips: RadarBlip[] = [];

  for (const at of contacts) {
    const offset = sub(at, self.pos);
    const distance = Math.hypot(offset.x, offset.y, offset.z);
    if (distance > config.radarRange) continue;

    const height = offset.y;
    blips.push({
      x: dot(offset, right) / config.radarRange,
      y: dot(offset, forward) / config.radarRange,
      altitude:
        height > config.radarAltitudeBand ? 'above'
        : height < -config.radarAltitudeBand ? 'below'
        : 'level',
      distance,
    });
  }
  return blips;
}

/** One item slot chip: key hint, name, charges, and a cooldown wipe. */
interface ItemSlotView {
  root: HTMLDivElement;
  charges: HTMLSpanElement;
  cooldown: HTMLDivElement;
}

const ITEM_LABELS: Record<ItemKind, string> = {
  decoy: 'デコイ',
  shield: 'シールド',
  flash: 'フラッシュ',
};

/** A labelled fill bar. */
class Bar {
  readonly root: HTMLDivElement;
  private readonly fill: HTMLDivElement;
  private readonly value: HTMLDivElement;

  constructor(className: string, label?: string) {
    this.root = el('div', `hud-bar ${className}`);
    if (label) this.root.append(el('div', 'hud-bar-label', label));
    const track = el('div', 'hud-bar-track');
    this.fill = el('div', 'hud-bar-fill');
    track.append(this.fill);
    this.value = el('div', 'hud-bar-value');
    this.root.append(track, this.value);
  }

  set(fraction: number, text: string): void {
    this.fill.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
    this.value.textContent = text;
  }
}

/** Round result text for the banner. */
export function resultBanner(match: MatchState, selfId: number): string | null {
  if (!match.lastResult) return null;
  const { winnerId } = match.lastResult;
  if (winnerId === null) return 'DRAW';
  return winnerId === selfId ? 'ROUND WIN' : 'ROUND LOSS';
}

export function resultDetail(match: MatchState): string | null {
  return match.lastResult ? describeResult(match.lastResult) : null;
}

function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
