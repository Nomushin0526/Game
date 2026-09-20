/**
 * Browser entry point.
 *
 * Owns the frame loop and keeps it strictly separated from the simulation:
 * the world only ever advances in fixed 60 Hz steps, and the renderer
 * interpolates between the last two ticks so the picture stays smooth on any
 * refresh rate.
 */

import { loadMap } from './maps/loader.ts';
import { generateCityMap } from './maps/generator.ts';
import { KeyboardMouseInput } from './input/keyboardMouse.ts';
import { FollowCamera } from './render/camera.ts';
import { SceneRenderer } from './render/scene.ts';
import { CONFIG } from './sim/config.ts';
import { length } from './sim/math.ts';
import { neutralInput, type Vec3 } from './sim/types.ts';
import { World } from './sim/world.ts';

/** Never advance more than this much simulated time in one frame. */
const MAX_FRAME_TIME = 0.25;

async function boot(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const seed = Number(params.get('seed') ?? CONFIG.sim.defaultSeed) || CONFIG.sim.defaultSeed;
  const mapId = params.get('map') ?? 'city01';
  const map = mapId === 'generated' ? generateCityMap(seed) : loadMap(mapId);

  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const hud = document.getElementById('hud') as HTMLElement;
  const overlay = document.getElementById('overlay') as HTMLElement;

  const world = await World.create({ map, seed });
  const player = world.entity(0);

  const renderer = new SceneRenderer(canvas, map);
  const camera = new FollowCamera(window.innerWidth / window.innerHeight);
  const input = new KeyboardMouseInput(canvas, { initialYaw: player.aimYaw });

  const resize = (): void => {
    renderer.resize(window.innerWidth, window.innerHeight);
    camera.setAspect(window.innerWidth / window.innerHeight);
  };
  window.addEventListener('resize', resize);
  resize();

  overlay.addEventListener('click', () => input.requestPointerLock());
  document.addEventListener('pointerlockchange', () => {
    overlay.classList.toggle('hidden', input.pointerLocked);
  });

  const fixedDt = world.config.sim.fixedDt;
  let previousPositions = new Map<number, Vec3>();
  let accumulator = 0;
  let lastFrame = performance.now();
  let smoothedFps = 60;

  const frame = (now: number): void => {
    requestAnimationFrame(frame);

    const frameTime = Math.min((now - lastFrame) / 1000, MAX_FRAME_TIME);
    lastFrame = now;
    smoothedFps += (1 / Math.max(frameTime, 1e-4) - smoothedFps) * 0.05;

    accumulator += frameTime;
    while (accumulator >= fixedDt) {
      previousPositions = new Map(world.entities.map((e) => [e.id, { ...e.pos }]));
      // Entity 1 is an idle target until phase 2 wires up a second controller.
      world.step([input.sample(), neutralInput()]);
      accumulator -= fixedDt;
    }

    const alpha = accumulator / fixedDt;
    renderer.syncEntities(world.entities, previousPositions, alpha);

    const from = previousPositions.get(player.id) ?? player.pos;
    const renderPos: Vec3 = {
      x: from.x + (player.pos.x - from.x) * alpha,
      y: from.y + (player.pos.y - from.y) * alpha,
      z: from.z + (player.pos.z - from.z) * alpha,
    };
    camera.update(player, renderPos, frameTime);
    renderer.render(camera.camera);

    hud.textContent = [
      `SPEED   ${length(player.vel).toFixed(1).padStart(5)} m/s${player.boosting ? '  BOOST' : ''}`,
      `ALT     ${player.pos.y.toFixed(1).padStart(5)} m`,
      `HP      ${gauge(player.hp, CONFIG.loadout[player.team].maxHp)}`,
      `BOOST   ${gauge(player.boostFuel, CONFIG.flight.boostCapacity)}`,
      player.stunTimer > 0 ? `STUNNED ${player.stunTimer.toFixed(2)} s` : '',
      `FPS     ${smoothedFps.toFixed(0).padStart(5)}   tick ${world.tick}`,
    ]
      .filter(Boolean)
      .join('\n');
  };

  requestAnimationFrame(frame);
}

function gauge(value: number, max: number, width = 12): string {
  const filled = Math.round((Math.max(0, value) / max) * width);
  return `${'#'.repeat(filled)}${'.'.repeat(width - filled)} ${value.toFixed(0).padStart(3)}`;
}

boot().catch((err) => {
  console.error(err);
  const overlay = document.getElementById('overlay');
  if (overlay) overlay.innerHTML = `<div><h1>起動に失敗しました</h1><p>${String(err)}</p></div>`;
});
