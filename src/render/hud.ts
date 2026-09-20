/**
 * Per-player HUD, drawn as DOM over the 3D viewport.
 *
 * Read-only with respect to the simulation. One instance per split-screen
 * pane; it positions itself over its own viewport.
 */

import * as THREE from 'three';
import type { SkyTagConfig } from '../sim/config.ts';
import type { PhysicsWorld } from '../sim/physics.ts';
import { describeResult, type MatchState } from '../sim/rules.ts';
import type { EntityState, ItemSlotState } from '../sim/types.ts';
import { TEAM_COLORS } from './scene.ts';

/** Fraction of the half-extent at which the off-screen arrow sits. */
const ARROW_INSET = 0.86;

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
  match: MatchState;
  camera: THREE.Camera;
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
  private readonly arrow: HTMLDivElement;
  private readonly enemyLabel: HTMLDivElement;
  private readonly items: HTMLDivElement;
  private readonly itemSlots: ItemSlotView[] = [];
  private readonly blindOverlay: HTMLDivElement;
  private readonly projected = new THREE.Vector3();

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
    this.arrow = el('div', 'hud-arrow');
    this.blindOverlay = el('div', 'hud-blind');

    const crosshair = el('div', 'hud-crosshair');
    this.root.append(
      top, enemyBlock, bottom, this.arrow, crosshair,
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

    this.updateEnemy(self, enemy, frame.camera);

    this.banner.textContent = frame.message ?? '';
    this.banner.classList.toggle('visible', Boolean(frame.message));
    this.subBanner.textContent = frame.submessage ?? '';
    this.subBanner.classList.toggle('visible', Boolean(frame.submessage));
  }

  private updateEnemy(self: EntityState, enemy: EntityState | undefined, camera: THREE.Camera): void {
    if (!enemy || !this.config.hud.showEnemyHp) {
      this.enemyLabel.textContent = '';
      this.enemyHp.root.style.visibility = 'hidden';
    } else {
      this.enemyHp.root.style.visibility = 'visible';
      this.enemyLabel.textContent = enemy.team === 'hunter' ? '鬼 HUNTER' : '逃亡者 RUNNER';
      this.enemyHp.set(enemy.hp / this.config.loadout[enemy.team].maxHp, `${Math.ceil(enemy.hp)}`);
    }

    const visible = enemy ? this.shouldPoint(self, enemy) : false;
    this.arrow.style.display = visible ? 'block' : 'none';
    if (visible && enemy) this.placeArrow(enemy, camera);
  }

  /** The `hud.enemyIndicator` policy from config (DESIGN.md section 10). */
  private shouldPoint(self: EntityState, enemy: EntityState): boolean {
    if (!enemy.alive || !self.alive) return false;
    switch (this.config.hud.enemyIndicator) {
      case 'never': return false;
      case 'always': return true;
      case 'lineOfSight': return !this.physics.isBlocked(self.pos, enemy.pos);
    }
  }

  /**
   * Put the arrow on the enemy when they are on screen, or pin it to the edge
   * of the pane pointing at them when they are not.
   */
  private placeArrow(enemy: EntityState, camera: THREE.Camera): void {
    this.projected.set(enemy.pos.x, enemy.pos.y, enemy.pos.z).project(camera);
    let { x, y } = this.projected;
    // `project` mirrors points that are behind the camera; flip them back so the
    // arrow points the way the player actually has to turn.
    const behind = this.projected.z > 1;
    if (behind) { x = -x; y = -y; }

    const offScreen = behind || Math.abs(x) > 1 || Math.abs(y) > 1;
    if (offScreen) {
      const scale = ARROW_INSET / Math.max(Math.abs(x), Math.abs(y), 1e-6);
      x *= scale;
      y *= scale;
    }

    this.arrow.classList.toggle('offscreen', offScreen);
    this.arrow.style.left = `${((x + 1) / 2) * 100}%`;
    this.arrow.style.top = `${((1 - y) / 2) * 100}%`;
    this.arrow.style.transform = `translate(-50%, -50%) rotate(${Math.atan2(-y, x) + Math.PI / 2}rad)`;
  }

  /** Rebuilds the chips only when the loadout changes, e.g. on a side swap. */
  private updateItems(slots: readonly ItemSlotState[]): void {
    if (this.itemSlots.length !== slots.length) {
      this.items.replaceChildren();
      this.itemSlots.length = 0;
      slots.forEach((slot, index) => {
        const root = el('div', 'hud-item');
        root.append(el('span', 'hud-item-key', String(index + 1)));
        root.append(el('span', 'hud-item-name', ITEM_LABELS[slot.kind] ?? slot.kind));
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

/** One item slot chip: key hint, name, charges, and a cooldown wipe. */
interface ItemSlotView {
  root: HTMLDivElement;
  charges: HTMLSpanElement;
  cooldown: HTMLDivElement;
}

const ITEM_LABELS: Record<string, string> = {
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
