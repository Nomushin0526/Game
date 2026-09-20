/**
 * Title, mode select and the end-of-match result screen.
 *
 * Plain DOM over the canvas. Each screen resolves a promise, so `main.ts` can
 * read as a straight line: menu -> match -> result -> menu.
 */

import { builtinMapIds } from '../maps/loader.ts';
import type { AiDifficulty } from '../sim/config.ts';
import { describeResult, type MatchState } from '../sim/rules.ts';

export type DeviceKind = 'keyboard' | 'gamepad' | 'cpu';
export type GameMode = 'solo' | 'local2p' | 'cpu';

export interface MatchSetup {
  mode: GameMode;
  mapId: string;
  seed: number;
  /** Device per player slot. */
  devices: DeviceKind[];
  /** Difficulty for any `cpu` slot. */
  difficulty: AiDifficulty;
}

export interface MenuDefaults {
  mapId: string;
  seed: number;
}

/** Show the title screen and resolve once the player starts a match. */
export function showMenu(root: HTMLElement, defaults: MenuDefaults): Promise<MatchSetup> {
  return new Promise((resolve) => {
    const screen = el('div', 'screen');
    const panel = el('div', 'panel');

    panel.append(
      el('h1', 'title', 'SKY TAG'),
      el(
        'p',
        'subtitle',
        '空中鬼ごっこ — 鬼は速く重い。逃亡者は時間まで逃げ切れば勝ち。' +
          '逃亡者はデコイ・シールド・フラッシュを持つ。デコイはレーダー上でも本物と区別がつかない。',
      ),
    );

    const mapSelect = el('select', 'field-input') as HTMLSelectElement;
    for (const id of [...builtinMapIds(), 'generated']) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = id === 'generated' ? 'generated (シードから自動生成)' : id;
      mapSelect.append(option);
    }
    mapSelect.value = defaults.mapId;

    const seedInput = el('input', 'field-input') as HTMLInputElement;
    seedInput.type = 'number';
    seedInput.value = String(defaults.seed);

    const difficultySelect = el('select', 'field-input') as HTMLSelectElement;
    for (const [value, label] of [
      ['easy', 'Easy（反応 0.6秒・照準が甘い）'],
      ['normal', 'Normal'],
      ['hard', 'Hard（反応 0.15秒・偏差射撃が正確）'],
    ] as const) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      difficultySelect.append(option);
    }
    difficultySelect.value = 'normal';

    panel.append(field('マップ', mapSelect), field('シード', seedInput), field('CPU 難易度', difficultySelect));

    const gamepadNote = el('p', 'note');
    const refreshNote = (): void => {
      const pads = (navigator.getGamepads?.() ?? []).filter(Boolean).length;
      gamepadNote.textContent = pads > 0
        ? `ゲームパッド ${pads} 台を検出`
        : 'ゲームパッド未検出（接続後、ボタンを1回押すと認識されます）';
    };
    refreshNote();
    window.addEventListener('gamepadconnected', refreshNote);
    window.addEventListener('gamepaddisconnected', refreshNote);

    const start = (setup: MatchSetup): void => {
      window.removeEventListener('gamepadconnected', refreshNote);
      window.removeEventListener('gamepaddisconnected', refreshNote);
      screen.remove();
      resolve(setup);
    };

    const read = (mode: GameMode, devices: DeviceKind[]): MatchSetup => ({
      mode,
      mapId: mapSelect.value,
      seed: Number(seedInput.value) || defaults.seed,
      devices,
      difficulty: difficultySelect.value as AiDifficulty,
    });

    const buttons = el('div', 'buttons');
    buttons.append(
      button('CPU対戦（あなたが鬼）', 'primary', () => start(read('cpu', ['keyboard', 'cpu']))),
      button('CPU対戦（あなたが逃亡者）', 'primary', () => start(read('cpu', ['cpu', 'keyboard']))),
      button('CPU 同士を観戦', '', () => start(read('cpu', ['cpu', 'cpu']))),
      button('ローカル2人対戦（KB+マウス / ゲームパッド）', '', () =>
        start(read('local2p', ['keyboard', 'gamepad'])),
      ),
      button('ローカル2人対戦（ゲームパッド2台）', '', () =>
        start(read('local2p', ['gamepad', 'gamepad'])),
      ),
      button('1人で飛ぶ（練習）', '', () => start(read('solo', ['keyboard']))),
    );

    panel.append(buttons, gamepadNote, el('p', 'note', controlsText()));
    screen.append(panel);
    root.append(screen);
  });
}

/** Final scoreboard. Resolves with 'rematch' or 'menu'. */
export function showMatchResult(
  root: HTMLElement,
  match: MatchState,
  playerLabels: readonly string[],
): Promise<'rematch' | 'menu'> {
  return new Promise((resolve) => {
    const screen = el('div', 'screen');
    const panel = el('div', 'panel');

    const winner = match.matchWinnerId;
    panel.append(
      el('h1', 'title', winner === null ? 'DRAW' : `${playerLabels[winner] ?? `P${winner + 1}`} WINS`),
      el('p', 'subtitle', `${match.scores.join(' - ')}（${match.results.length} ラウンド）`),
    );

    const list = el('div', 'results');
    match.results.forEach((result, index) => {
      list.append(el('div', 'result-row', `Round ${index + 1}: ${describeResult(result)}`));
    });
    panel.append(list);

    const finish = (choice: 'rematch' | 'menu'): void => {
      screen.remove();
      resolve(choice);
    };
    const buttons = el('div', 'buttons');
    buttons.append(
      button('もう一度', 'primary', () => finish('rematch')),
      button('タイトルへ', '', () => finish('menu')),
    );
    panel.append(buttons);
    screen.append(panel);
    root.append(screen);
  });
}

function controlsText(): string {
  return (
    'KB+マウス: WASD 移動 / Space 上昇 / Ctrl 下降 / Shift ブースト / 左クリック 射撃 / 1・2・3 アイテム — ' +
    'ゲームパッド: 左スティック 移動 / RB 上昇 / LB 下降 / 右スティック 視点 / RT 射撃 / LT ブースト / A・B・X アイテム'
  );
}

function field(label: string, input: HTMLElement): HTMLElement {
  const wrapper = el('label', 'field');
  wrapper.append(el('span', 'field-label', label), input);
  return wrapper;
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const node = el('button', `button ${className}`.trim(), label) as HTMLButtonElement;
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
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
