/**
 * Does the CPU actually get better at a player it has met before?
 *
 * That is DESIGN.md 9's acceptance condition for phase 5, and it is not
 * something you can eyeball — a hunter that wins more might simply have had
 * kinder seeds. So this measures the two things the learning is supposed to
 * improve, head to head against an identical run with learning switched off:
 *
 *   search   seconds from losing contact to finding them again
 *   aim      hit rate
 *
 * Both sides play the same seeds in the same order, so the only difference
 * between the two columns is whether the hunter kept a model.
 *
 *   npm run sim:learn -- --matches 12 --hunter hard --runner hard
 */

import { AiController, buildGrid } from '../src/ai/controller.ts';
import { areaGridFor, LOST_CONTACT_SECONDS, PlayerModel } from '../src/ai/learning/playerModel.ts';
import { MemoryModelStore } from '../src/ai/learning/storage.ts';
import { loadMap } from '../src/maps/loader.ts';
import { cloneConfig, type AiDifficulty } from '../src/sim/config.ts';
import { initPhysics } from '../src/sim/physics.ts';
import { World } from '../src/sim/world.ts';

interface Args {
  matches: number;
  map: string;
  hunter: AiDifficulty;
  runner: AiDifficulty;
  seed: number;
  timeLimit: number;
  /** Give the runner a one-sided dodge, so there is a habit to find. */
  jinkBias: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    matches: 12,
    map: 'city01',
    hunter: 'normal',
    runner: 'normal',
    seed: 1,
    timeLimit: 120,
    jinkBias: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const [key, inline] = argv[i]!.split('=');
    const value = inline ?? argv[i + 1];
    const consume = (): string | undefined => {
      if (inline === undefined) i++;
      return value;
    };
    switch (key) {
      case '--matches': args.matches = Number(consume()); break;
      case '--map': args.map = consume() ?? args.map; break;
      case '--hunter': args.hunter = consume() as AiDifficulty; break;
      case '--runner': args.runner = consume() as AiDifficulty; break;
      case '--seed': args.seed = Number(consume()); break;
      case '--time-limit': args.timeLimit = Number(consume()); break;
      case '--jink-bias': args.jinkBias = Number(consume()); break;
      default: break;
    }
  }
  return args;
}

interface RoundStats {
  /** Seconds spent searching, summed over every time contact was lost. */
  searchSeconds: number;
  /** Times contact was lost and then regained, which is what that averages over. */
  reacquisitions: number;
  /** Times contact was lost and never regained before the round ended. */
  neverFound: number;
  shots: number;
  hits: number;
}

/**
 * Play one round and report how the hunter's search and aim went.
 *
 * `model` is the hunter's memory of this runner. Passing null is the control:
 * identical code path, identical seeds, no learning.
 */
function playRound(
  args: Args,
  seed: number,
  model: PlayerModel | null,
): RoundStats {
  const config = cloneConfig();
  config.rules.swapSidesEachRound = false;
  config.rules.countdown = 0;
  config.rules.timeLimit = args.timeLimit;
  config.ai.jinkBias = args.jinkBias;

  const world = new World({ map: loadMap(args.map), config, seed });
  world.skipCountdown();
  const grid = buildGrid(world);

  const controllers = world.entities.map((entity) =>
    new AiController({
      world,
      slot: entity.id,
      difficulty: entity.team === 'hunter' ? args.hunter : args.runner,
      grid,
      seed: seed * 7919 + entity.id * 104729,
      // Only the hunter learns: it is the side whose job is finding someone.
      opponentModel: entity.team === 'hunter' ? (model ?? undefined) : undefined,
    }),
  );
  const hunterSlot = world.entities.findIndex((e) => e.team === 'hunter');
  const hunterAi = controllers[hunterSlot]!;

  const dt = config.sim.fixedDt;
  const maxTicks = Math.ceil((config.rules.timeLimit + 2) * config.sim.tickRate);
  const stats: RoundStats = {
    searchSeconds: 0,
    reacquisitions: 0,
    neverFound: 0,
    shots: 0,
    hits: 0,
  };

  let sawEver = false;
  let searching = 0;
  let ticks = 0;

  while (world.match.phase === 'live' && ticks < maxTicks) {
    world.step(controllers.map((c) => c.sample(dt)));
    ticks++;

    if (hunterAi.sees) {
      // Only count a search that followed an actual sighting — the opening
      // seconds before first contact are not the hunter failing to re-find
      // anyone -- and only one long enough to be a search rather than a craft
      // crossing behind a building. Without that threshold this measures
      // occlusion flicker and reads about 1.6 s no matter what the AI does.
      if (sawEver && searching >= LOST_CONTACT_SECONDS) {
        stats.searchSeconds += searching;
        stats.reacquisitions++;
      }
      searching = 0;
      sawEver = true;
    } else if (sawEver) {
      searching += dt;
    }
  }
  if (sawEver && searching >= LOST_CONTACT_SECONDS) stats.neverFound++;

  const hunter = world.entities[hunterSlot]!;
  stats.shots = hunter.shotsFired;
  stats.hits = hunter.shotsHit;
  world.dispose();
  return stats;
}

/** Run the whole series one way, with learning either on or off. */
function series(args: Args, learning: boolean): { rounds: RoundStats[]; model: PlayerModel | null } {
  const map = loadMap(args.map);
  const model = learning ? new PlayerModel(areaGridFor(map)) : null;
  const rounds: RoundStats[] = [];

  for (let i = 0; i < args.matches; i++) {
    rounds.push(playRound(args, args.seed + i, model));
    // A round is the unit the decay is defined over, so it is closed here
    // rather than inside the round.
    model?.endRound();
  }
  return { rounds, model };
}

function summarise(rounds: RoundStats[]): { search: number; accuracy: number; lost: number } {
  const total = rounds.reduce(
    (acc, r) => ({
      searchSeconds: acc.searchSeconds + r.searchSeconds,
      reacquisitions: acc.reacquisitions + r.reacquisitions,
      neverFound: acc.neverFound + r.neverFound,
      shots: acc.shots + r.shots,
      hits: acc.hits + r.hits,
    }),
    { searchSeconds: 0, reacquisitions: 0, neverFound: 0, shots: 0, hits: 0 },
  );
  return {
    search: total.reacquisitions > 0 ? total.searchSeconds / total.reacquisitions : NaN,
    accuracy: total.shots > 0 ? total.hits / total.shots : NaN,
    lost: total.neverFound / Math.max(rounds.length, 1),
  };
}

function fmt(value: number, suffix: string, digits = 2): string {
  return Number.isFinite(value) ? `${value.toFixed(digits)}${suffix}` : 'n/a';
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await initPhysics();

  const started = Date.now();
  const control = series(args, false);
  const learned = series(args, true);

  // The interesting comparison is not the whole series against the whole
  // series -- the learner is ignorant for the first few rounds too. It is the
  // second half, once a model exists, against the same rounds played blind.
  const half = Math.floor(args.matches / 2);
  const rows: Array<[string, RoundStats[], RoundStats[]]> = [
    ['all rounds', control.rounds, learned.rounds],
    ['first half', control.rounds.slice(0, half), learned.rounds.slice(0, half)],
    ['second half', control.rounds.slice(half), learned.rounds.slice(half)],
  ];

  const lines = [
    '',
    `map ${args.map}  hunter=${args.hunter}  runner=${args.runner}  ` +
      `matches=${args.matches}  seed=${args.seed}  limit=${args.timeLimit}s  ` +
      `jinkBias=${args.jinkBias}`,
    '─'.repeat(72),
    `search = mean seconds to re-find the runner after losing it for ${LOST_CONTACT_SECONDS}s+ (lower is better)`,
    'aim    = hunter hit rate (higher is better)',
    '',
    `${''.padEnd(13)}${'no learning'.padEnd(26)}${'learning'.padEnd(26)}`,
  ];

  for (const [label, off, on] of rows) {
    const a = summarise(off);
    const b = summarise(on);
    const delta = Number.isFinite(a.search) && Number.isFinite(b.search)
      ? ` (${b.search < a.search ? '' : '+'}${(b.search - a.search).toFixed(2)}s)`
      : '';
    lines.push(
      `${label.padEnd(13)}` +
        `search ${fmt(a.search, 's').padEnd(8)} aim ${fmt(a.accuracy * 100, '%', 1).padEnd(7)}` +
        `search ${fmt(b.search, 's').padEnd(8)} aim ${fmt(b.accuracy * 100, '%', 1).padEnd(7)}` +
        delta,
    );
  }

  const model = learned.model;
  if (model) {
    const lean = model.dodgeLean();
    const altitude = model.preferredAltitude();
    lines.push(
      '',
      'what the model ended up believing about the runner:',
      `  rounds seen        ${model.roundsSeen}`,
      `  observed seconds   ${model.samples.toFixed(1)}`,
      `  favourite areas    ${model
        .haunts(3)
        .map((h) => `(${h.x.toFixed(0)}, ${h.y.toFixed(0)}, ${h.z.toFixed(0)})`)
        .join('  ') || 'none yet'}`,
      `  dodges             ${describeLean(lean)}`,
      `  preferred altitude ${altitude === null ? 'unknown' : `${altitude.toFixed(0)}m`}`,
      `  preferred range    ${model.preferredRange()?.toFixed(0) ?? 'unknown'}m`,
      `  their accuracy     ${
        model.accuracy() === null ? 'unknown' : `${(model.accuracy()! * 100).toFixed(1)}%`
      }`,
    );
  }

  lines.push('', `simulated in  ${((Date.now() - started) / 1000).toFixed(1)}s`, '');
  process.stdout.write(lines.join('\n') + '\n');

  // Prove the store round-trips what the model holds, since the browser build
  // depends on exactly this and nothing else here would catch a regression.
  if (model) {
    const store = new MemoryModelStore();
    const key = { mapId: args.map, playerId: 'bench' };
    await store.save(key, model.toData());
    const restored = await store.load(key);
    process.stdout.write(
      `model round-trips through storage: ${restored !== null && restored.rounds === model.roundsSeen}\n`,
    );
  }
}

function describeLean(lean: number): string {
  if (lean === 0) return 'no clear habit';
  const side = lean > 0.05 ? 'right' : lean < -0.05 ? 'left' : 'even';
  return `${side} (${lean.toFixed(2)})`;
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
