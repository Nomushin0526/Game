/**
 * Browser entry point.
 *
 * Owns the frame loop and keeps it strictly separated from the simulation:
 * the world only ever advances in fixed 60 Hz steps, and the renderer
 * interpolates between the last two ticks so the picture stays smooth on any
 * refresh rate.
 */

import { generateCityMap } from './maps/generator.ts';
import { loadMap } from './maps/loader.ts';
import { AiController, buildGrid } from './ai/controller.ts';
import { areaGridFor, describeModel, PlayerModel } from './ai/learning/playerModel.ts';
import { defaultModelStore, type ModelKey, type ModelStore } from './ai/learning/storage.ts';
import type { VoxelGrid } from './ai/nav/voxelGrid.ts';
import { applyAimAssist } from './input/aimAssist.ts';
import { firstConnectedGamepad, GamepadInput } from './input/gamepad.ts';
import { KeyboardMouseInput } from './input/keyboardMouse.ts';
import type { InputSource } from './input/types.ts';
import { FollowCamera } from './render/camera.ts';
import { Effects } from './render/effects.ts';
import { Hud, resultBanner, resultDetail, type HudViewport } from './render/hud.ts';
import { SceneRenderer, TEAM_COLORS } from './render/scene.ts';
import { CONFIG, cloneConfig } from './sim/config.ts';
import { neutralInput, type PlayerInput, type Vec3 } from './sim/types.ts';
import { World } from './sim/world.ts';
import { showMatchResult, showMenu, type MatchSetup } from './ui/menu.ts';

/** Never advance more than this much simulated time in one frame. */
const MAX_FRAME_TIME = 0.25;

interface Player {
  slot: number;
  label: string;
  source: InputSource;
  camera: FollowCamera;
  hud: Hud;
  /** Aim assist is a gamepad-only concession (DESIGN.md section 3). */
  assisted: boolean;
  /** True for CPU slots, which drive their own view and need no pointer lock. */
  isCpu: boolean;
}

async function main(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  // One store for the tab: models are loaded before a match and saved after,
  // never during, so nothing here runs inside the frame loop.
  const store = defaultModelStore();
  const uiRoot = document.getElementById('ui') as HTMLElement;
  const hudRoot = document.getElementById('hud') as HTMLElement;

  const defaults = {
    mapId: params.get('map') ?? 'city01',
    seed: Number(params.get('seed') ?? CONFIG.sim.defaultSeed) || CONFIG.sim.defaultSeed,
  };
  // Shorter rounds on demand, because the thing most worth checking by hand is
  // phase 5’s learning, and that needs several matches — at the shipping
  // 180 s best-of-three that is nine minutes per data point.
  const rules = {
    timeLimit: Number(params.get('time')) || CONFIG.rules.timeLimit,
    roundsToWin: Number(params.get('rounds')) || CONFIG.rules.roundsToWin,
  };

  // menu -> match -> result -> menu, for as long as the tab is open.
  for (;;) {
    const setup = await showMenu(uiRoot, defaults, () => store.clear());
    let outcome: 'rematch' | 'menu' = 'rematch';
    while (outcome === 'rematch') {
      outcome = await runMatch(canvas, hudRoot, setup, store, rules);
    }
  }
}

async function runMatch(
  canvas: HTMLCanvasElement,
  hudRoot: HTMLElement,
  setup: MatchSetup,
  store: ModelStore,
  rules: { timeLimit: number; roundsToWin: number },
): Promise<'rematch' | 'menu'> {
  const map = setup.mapId === 'generated' ? generateCityMap(setup.seed) : loadMap(setup.mapId);
  const config = cloneConfig();
  config.rules.timeLimit = rules.timeLimit;
  config.rules.roundsToWin = rules.roundsToWin;
  const world = await World.create({ map, config, seed: setup.seed, slots: setup.devices.length });

  // What the CPUs remember about the human they are about to play (DESIGN.md
  // 7.2). Loaded before the match starts so it is ready for round one, and
  // saved once at the end rather than per round.
  const modelKey: ModelKey = { mapId: map.id, playerId: 'local' };
  const learned = PlayerModel.fromData(areaGridFor(map), await store.load(modelKey));

  const renderer = new SceneRenderer(canvas, map);
  const effects = new Effects(renderer.scene, (id) => TEAM_COLORS[world.entity(id).team]);
  const allPlayers = createPlayers(setup, world, canvas, hudRoot, learned);
  // Only human slots get a viewport. Watching two CPUs still needs one camera,
  // so fall back to the first slot when nobody is human.
  const humans = allPlayers.filter((p) => !p.isCpu);
  const players = humans.length > 0 ? humans : allPlayers.slice(0, 1);
  for (const player of allPlayers) {
    if (!players.includes(player)) player.hud.dispose();
  }
  const keyboard = allPlayers.find((p) => p.source instanceof KeyboardMouseInput)?.source as
    | KeyboardMouseInput
    | undefined;

  const layout = (): void => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    renderer.resize(width, height);
    for (const [index, player] of players.entries()) {
      const viewport = viewportFor(index, players.length, width, height);
      player.camera.setAspect(viewport.width / viewport.height);
      player.hud.setViewport(viewport);
    }
  };
  window.addEventListener('resize', layout);
  layout();

  const onClick = (): void => keyboard?.requestPointerLock();
  canvas.addEventListener('click', onClick);

  const fixedDt = world.config.sim.fixedDt;
  let previousPositions = new Map<number, Vec3>();
  let accumulator = 0;
  let lastFrame = performance.now();
  /** Real seconds spent showing the round result before the next round. */
  let intermission = 0;

  const outcome = await new Promise<'rematch' | 'menu'>((resolve) => {
    let running = true;

    const finish = async (): Promise<void> => {
      running = false;
      // The last round of a match never reaches `nextRound`, so without this
      // it would be observed but never counted.
      learned.endRound();
      // Saved here rather than after the result screen is dismissed: a player
      // who closes the tab on the result screen has still played the match,
      // and used to lose everything the CPU had learned from it.
      if (learnedThisMatch(setup)) await store.save(modelKey, learned.toData());
      const choice = await showMatchResult(
        document.getElementById('ui') as HTMLElement,
        world.match,
        players.map((p) => p.label),
        learnedThisMatch(setup) ? describeModel(learned) : [],
      );
      resolve(choice);
    };

    const frame = (now: number): void => {
      if (!running) return;
      requestAnimationFrame(frame);

      const frameTime = Math.min((now - lastFrame) / 1000, MAX_FRAME_TIME);
      lastFrame = now;

      accumulator += frameTime;
      while (accumulator >= fixedDt) {
        previousPositions = new Map(world.entities.map((e) => [e.id, { ...e.pos }]));
        world.step(collectInputs(allPlayers, world, fixedDt));
        effects.spawn(world.events);
        accumulator -= fixedDt;
      }

      const alpha = accumulator / fixedDt;
      renderer.syncEntities(world.entities, previousPositions, alpha);
      renderer.syncDecoys(world.decoys, world.config.items.decoy);
      effects.syncProjectiles(world.projectiles, alpha, fixedDt);
      effects.update(frameTime);
      drawPlayers(renderer, players, world, previousPositions, alpha, frameTime);

      // Round flow: hold the result up for a beat, then run the next round.
      if (world.match.phase === 'roundOver') {
        intermission += frameTime;
        if (intermission >= world.config.rules.roundIntermission) {
          intermission = 0;
          effects.clear();
          // A round is the unit the model's decay is defined over.
          learned.endRound();
          world.nextRound();
          for (const player of allPlayers) {
            player.camera.reset();
            player.source.setAim(world.entity(player.slot).aimYaw, 0);
          }
        }
      } else if (world.match.phase === 'matchOver') {
        intermission += frameTime;
        if (intermission >= world.config.rules.roundIntermission) void finish();
      } else {
        intermission = 0;
      }
    };
    requestAnimationFrame(frame);
  });

  window.removeEventListener('resize', layout);
  canvas.removeEventListener('click', onClick);
  if (document.pointerLockElement) document.exitPointerLock();
  for (const player of allPlayers) {
    player.source.dispose();
    player.hud.dispose();
  }
  renderer.dispose();
  world.dispose();
  return outcome;
}

/**
 * Whether anything in this match was worth learning from.
 *
 * A CPU-versus-CPU match teaches the model about a CPU, and saving that under
 * the local player's key would poison what it knows about the human.
 */
function learnedThisMatch(setup: MatchSetup): boolean {
  return setup.devices.includes('cpu') && setup.devices.some((d) => d !== 'cpu');
}

function createPlayers(
  setup: MatchSetup,
  world: World,
  canvas: HTMLCanvasElement,
  hudRoot: HTMLElement,
  learned: PlayerModel,
): Player[] {
  const usedPads: number[] = [];
  // Voxelising the map takes a few milliseconds, so every CPU on it shares one.
  let grid: VoxelGrid | undefined;

  return setup.devices.map((device, slot) => {
    const entity = world.entity(slot);
    let source: InputSource;
    let assisted = false;
    let isCpu = false;

    if (device === 'cpu') {
      grid ??= buildGrid(world);
      source = new AiController({
        world,
        slot,
        difficulty: setup.difficulty,
        grid,
        seed: setup.seed * 7919 + slot * 104729,
        opponentModel: learned,
      });
      isCpu = true;
    } else if (device === 'gamepad') {
      const index = firstConnectedGamepad(usedPads) ?? usedPads.length;
      usedPads.push(index);
      source = new GamepadInput(index, { config: world.config, initialYaw: entity.aimYaw });
      assisted = true;
    } else {
      source = new KeyboardMouseInput(canvas, { config: world.config, initialYaw: entity.aimYaw });
    }

    return {
      slot,
      label: device === 'cpu' ? `CPU${slot + 1}` : `P${slot + 1}`,
      source,
      assisted,
      isCpu,
      camera: new FollowCamera(1),
      hud: new Hud(hudRoot, device === 'cpu' ? `CPU ${setup.difficulty}` : `P${slot + 1}`, world.config, world.physics),
    };
  });
}

/** One command per slot, with aim assist folded back into the gamepad's view. */
function collectInputs(players: readonly Player[], world: World, dt: number): PlayerInput[] {
  const inputs: PlayerInput[] = [];
  for (const player of players) {
    const self = world.entity(player.slot);
    let input = player.source.available ? player.source.sample(dt) : neutralInput();

    if (player.assisted && world.controlEnabled) {
      const enemy = world.entities.find((e) => e.id !== self.id);
      const assisted = applyAimAssist(input, self, enemy, {
        config: world.config,
        physics: world.physics,
        dt,
      });
      if (assisted !== input) {
        player.source.setAim(assisted.aimYaw, assisted.aimPitch);
        input = assisted;
      }
    }
    inputs[player.slot] = input;
  }
  return inputs;
}

function drawPlayers(
  renderer: SceneRenderer,
  players: readonly Player[],
  world: World,
  previousPositions: ReadonlyMap<number, Vec3>,
  alpha: number,
  frameTime: number,
): void {
  const width = window.innerWidth;
  const height = window.innerHeight;

  for (const [index, player] of players.entries()) {
    const self = world.entity(player.slot);
    const from = previousPositions.get(self.id) ?? self.pos;
    const renderPos: Vec3 = {
      x: from.x + (self.pos.x - from.x) * alpha,
      y: from.y + (self.pos.y - from.y) * alpha,
      z: from.z + (self.pos.z - from.z) * alpha,
    };
    player.camera.update(self, renderPos, frameTime);

    const viewport = viewportFor(index, players.length, width, height);
    // Three.js measures viewports from the bottom; the HUD from the top.
    renderer.renderViewport(
      player.camera.camera,
      viewport.left,
      height - viewport.top - viewport.height,
      viewport.width,
      viewport.height,
    );

    player.hud.update({
      self,
      enemy: world.entities.find((e) => e.id !== self.id),
      decoys: world.decoys,
      match: world.match,
      message: bannerFor(world, self.id),
      submessage:
        world.match.phase === 'roundOver' || world.match.phase === 'matchOver'
          ? resultDetail(world.match)
          : null,
    });
  }
}

function bannerFor(world: World, slot: number): string | null {
  switch (world.match.phase) {
    case 'countdown':
      return String(Math.ceil(world.match.countdownRemaining) || 'GO');
    case 'roundOver':
    case 'matchOver':
      return resultBanner(world.match, slot);
    default:
      return null;
  }
}

/** Split screen stacks panes top to bottom, which keeps the horizontal view wide. */
function viewportFor(index: number, count: number, width: number, height: number): HudViewport {
  if (count <= 1) return { left: 0, top: 0, width, height };
  const paneHeight = Math.floor(height / count);
  return { left: 0, top: index * paneHeight, width, height: paneHeight };
}

main().catch((err) => {
  console.error(err);
  const ui = document.getElementById('ui');
  if (ui) {
    ui.innerHTML = `<div class="screen"><div class="panel"><h1 class="title">起動に失敗しました</h1><p class="subtitle">${String(err)}</p></div></div>`;
  }
});
