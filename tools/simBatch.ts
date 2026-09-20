/**
 * Head-less AI-vs-AI batch runner: the balance tool from DESIGN.md 9.
 *
 *   npm run sim:batch -- --matches 500 --map city01 --hunter hard --runner hard
 *
 * Reports the hunter's win rate, average round length and the breakdown of how
 * rounds were decided. The design's target is a hunter win rate of 45-55%.
 *
 * Each round is played on its own seed with sides fixed, so the numbers say
 * something about the sides rather than about which slot got lucky.
 */

import { generateCityMap } from '../src/maps/generator.ts';
import { loadMap } from '../src/maps/loader.ts';
import { AiController, buildGrid } from '../src/ai/controller.ts';
import type { VoxelGrid } from '../src/ai/nav/voxelGrid.ts';
import { cloneConfig, type AiDifficulty, type SkyTagConfig } from '../src/sim/config.ts';
import { initPhysics } from '../src/sim/physics.ts';
import type { RoundEndReason } from '../src/sim/rules.ts';
import { World } from '../src/sim/world.ts';

interface Args {
  matches: number;
  map: string;
  hunter: AiDifficulty;
  runner: AiDifficulty;
  seed: number;
  /** Shorten the round clock to keep long batches tractable. */
  timeLimit: number | null;
  /** `--set loadout.hunter.damage=9` style overrides, for sweeping balance. */
  overrides: Array<[string, number]>;
  quiet: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    matches: 50,
    map: 'city01',
    hunter: 'normal',
    runner: 'normal',
    seed: 1,
    timeLimit: null,
    overrides: [],
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const [key, inline] = argv[i]!.split('=');
    const value = inline ?? argv[i + 1];
    const consume = (): string | undefined => { if (inline === undefined) i++; return value; };
    switch (key) {
      case '--matches': args.matches = Number(consume()); break;
      case '--map': args.map = consume() ?? args.map; break;
      case '--hunter': args.hunter = consume() as AiDifficulty; break;
      case '--runner': args.runner = consume() as AiDifficulty; break;
      case '--seed': args.seed = Number(consume()); break;
      case '--time-limit': args.timeLimit = Number(consume()); break;
      case '--set': args.overrides.push(parseOverride(consume())); break;
      case '--quiet': args.quiet = true; break;
      default: break;
    }
  }
  return args;
}

/** `loadout.hunter.damage=9` into a path and a number. */
function parseOverride(raw: string | undefined): [string, number] {
  const [path, value] = (raw ?? '').split('=');
  if (!path || value === undefined || Number.isNaN(Number(value))) {
    throw new Error(`--set expects path=number, got "${raw}"`);
  }
  return [path, Number(value)];
}

/**
 * Apply a dotted-path override to a config.
 *
 * This is what makes the balance loop in DESIGN.md 9 practical: sweep a value
 * across runs to find the setting that lands the hunter in the target band,
 * then write that one number into config.ts.
 */
function applyOverride(config: SkyTagConfig, path: string, value: number): void {
  const keys = path.split('.');
  let target: Record<string, unknown> = config as unknown as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) {
    const next = target[key];
    if (typeof next !== 'object' || next === null) throw new Error(`--set: no such config path "${path}"`);
    target = next as Record<string, unknown>;
  }
  const leaf = keys.at(-1)!;
  if (typeof target[leaf] !== 'number') throw new Error(`--set: "${path}" is not a number`);
  target[leaf] = value;
}

interface Tally {
  hunterWins: number;
  runnerWins: number;
  draws: number;
  reasons: Record<RoundEndReason, number>;
  totalSeconds: number;
  hunterShots: number;
  hunterHits: number;
  runnerShots: number;
  runnerHits: number;
  /** Rounds that hit the safety cap without the rules deciding anything. */
  unresolved: number;
  /** Charges spent, by item kind. */
  itemsUsed: Record<string, number>;
  /** Decoys shot down rather than left to expire. */
  decoysPopped: number;
  /** Times a craft was blinded by a flash. */
  blindings: number;
  /** Times a craft was caught by a snare. */
  snarings: number;
}

function emptyTally(): Tally {
  return {
    hunterWins: 0,
    runnerWins: 0,
    draws: 0,
    reasons: { hp: 0, touch: 0, timeout: 0, draw: 0 },
    totalSeconds: 0,
    hunterShots: 0,
    hunterHits: 0,
    runnerShots: 0,
    runnerHits: 0,
    unresolved: 0,
    itemsUsed: {},
    decoysPopped: 0,
    blindings: 0,
    snarings: 0,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await initPhysics();

  const config = cloneConfig();
  // Sides stay fixed so "hunter win rate" means what it says.
  config.rules.swapSidesEachRound = false;
  if (args.timeLimit !== null) config.rules.timeLimit = args.timeLimit;
  // The countdown is dead time for AI-vs-AI runs.
  config.rules.countdown = 0;
  for (const [path, value] of args.overrides) applyOverride(config, path, value);

  const tally = emptyTally();
  const started = Date.now();
  let grid: VoxelGrid | undefined;

  for (let i = 0; i < args.matches; i++) {
    const seed = args.seed + i;
    const map = args.map === 'generated' ? generateCityMap(seed) : loadMap(args.map);
    const world = new World({ map, config, seed });

    // A hand-authored map is the same every round, so voxelise it once.
    if (args.map !== 'generated') grid ??= buildGrid(world);
    const sharedGrid = args.map === 'generated' ? buildGrid(world) : grid;

    playRound(world, config, args, tally, sharedGrid, seed);
    world.dispose();

    if (!args.quiet && (i + 1) % 10 === 0) {
      process.stderr.write(`  ${i + 1}/${args.matches} rounds\r`);
    }
  }

  report(args, tally, Date.now() - started);
}

function playRound(
  world: World,
  config: SkyTagConfig,
  args: Args,
  tally: Tally,
  grid: VoxelGrid | undefined,
  seed: number,
): void {
  world.skipCountdown();

  const controllers = world.entities.map((entity) =>
    new AiController({
      world,
      slot: entity.id,
      difficulty: entity.team === 'hunter' ? args.hunter : args.runner,
      grid,
      // Distinct streams per slot and per round, still fully reproducible.
      seed: seed * 7919 + entity.id * 104729,
    }),
  );

  const dt = config.sim.fixedDt;
  const maxTicks = Math.ceil((config.rules.timeLimit + 5) * config.sim.tickRate);

  let ticks = 0;
  while (world.match.phase === 'live' && ticks < maxTicks) {
    for (const event of world.step(controllers.map((c) => c.sample(dt)))) {
      switch (event.type) {
        case 'itemUsed':
          tally.itemsUsed[event.kind] = (tally.itemsUsed[event.kind] ?? 0) + 1;
          break;
        case 'decoyGone':
          if (event.popped) tally.decoysPopped++;
          break;
        case 'blinded':
          tally.blindings++;
          break;
        case 'snared':
          tally.snarings++;
          break;
        default:
          break;
      }
    }
    ticks++;
  }

  const hunter = world.entities.find((e) => e.team === 'hunter');
  const runner = world.entities.find((e) => e.team === 'runner');
  if (hunter) { tally.hunterShots += hunter.shotsFired; tally.hunterHits += hunter.shotsHit; }
  if (runner) { tally.runnerShots += runner.shotsFired; tally.runnerHits += runner.shotsHit; }
  tally.totalSeconds += ticks * dt;

  const result = world.match.lastResult;
  if (!result) {
    tally.unresolved++;
    return;
  }
  tally.reasons[result.reason]++;
  if (result.winnerTeam === 'hunter') tally.hunterWins++;
  else if (result.winnerTeam === 'runner') tally.runnerWins++;
  else tally.draws++;
}

/** Per-round item usage, so a kit can be tuned on how much it actually gets used. */
function itemLine(tally: Tally, rounds: number): string {
  const kinds = Object.keys(tally.itemsUsed);
  if (kinds.length === 0) return '';
  const per = (n: number): string => (n / Math.max(rounds, 1)).toFixed(2);
  const used = kinds.map((kind) => `${kind} ${per(tally.itemsUsed[kind]!)}`).join('  ');
  return (
    `items/round   ${used}  ` +
    `| decoys shot ${per(tally.decoysPopped)}  blindings ${per(tally.blindings)}  ` +
    `snarings ${per(tally.snarings)}`
  );
}

function report(args: Args, tally: Tally, elapsedMs: number): void {
  const decided = tally.hunterWins + tally.runnerWins + tally.draws;
  const pct = (n: number): string => `${((n / Math.max(decided, 1)) * 100).toFixed(1)}%`;
  const accuracy = (hits: number, shots: number): string =>
    shots > 0 ? `${((hits / shots) * 100).toFixed(1)}%` : 'n/a';
  const hunterRate = tally.hunterWins / Math.max(decided, 1);

  const lines = [
    '',
    `map ${args.map}  hunter=${args.hunter}  runner=${args.runner}  rounds=${args.matches}  seed=${args.seed}`,
    args.overrides.length > 0
      ? `overrides     ${args.overrides.map(([k, v]) => `${k}=${v}`).join('  ')}`
      : '',
    '─'.repeat(64),
    `hunter wins   ${String(tally.hunterWins).padStart(5)}  ${pct(tally.hunterWins)}`,
    `runner wins   ${String(tally.runnerWins).padStart(5)}  ${pct(tally.runnerWins)}`,
    `draws         ${String(tally.draws).padStart(5)}  ${pct(tally.draws)}`,
    '',
    'decided by',
    `  knockout    ${String(tally.reasons.hp).padStart(5)}  ${pct(tally.reasons.hp)}`,
    `  tag         ${String(tally.reasons.touch).padStart(5)}  ${pct(tally.reasons.touch)}`,
    `  clock       ${String(tally.reasons.timeout).padStart(5)}  ${pct(tally.reasons.timeout)}`,
    `  draw        ${String(tally.reasons.draw).padStart(5)}  ${pct(tally.reasons.draw)}`,
    '',
    `avg round     ${(tally.totalSeconds / Math.max(args.matches, 1)).toFixed(1)}s`,
    `accuracy      hunter ${accuracy(tally.hunterHits, tally.hunterShots)}  ` +
      `runner ${accuracy(tally.runnerHits, tally.runnerShots)}`,
    itemLine(tally, args.matches),
    tally.unresolved > 0 ? `unresolved    ${tally.unresolved} (hit the tick cap)` : '',
    `simulated in  ${(elapsedMs / 1000).toFixed(1)}s`,
    '',
    // DESIGN.md 9: tune config.ts until the hunter sits in this band.
    hunterRate >= 0.45 && hunterRate <= 0.55
      ? 'balance: hunter win rate is inside the 45-55% target band'
      : `balance: hunter win rate ${pct(tally.hunterWins)} is OUTSIDE the 45-55% target band`,
    '',
  ];
  console.log(lines.filter((line) => line !== '').join('\n'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
