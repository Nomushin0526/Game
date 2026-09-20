/**
 * Head-less run of the simulation, with no renderer anywhere in sight.
 *
 *   npm run sim:headless -- --map city01 --seconds 10 --seed 7
 *   npm run sim:headless -- --match --seed 3
 *
 * `--match` plays a whole best-of-N with both craft flying a simple scripted
 * pattern, which exercises the phase 2 rules end to end. This is also the
 * harness `tools/simBatch.ts` will build on in phase 4.
 */

import { generateCityMap } from '../src/maps/generator.ts';
import { loadMap } from '../src/maps/loader.ts';
import { length, lookAngles } from '../src/sim/math.ts';
import { describeResult } from '../src/sim/rules.ts';
import { neutralInput, type PlayerInput } from '../src/sim/types.ts';
import { World } from '../src/sim/world.ts';

interface Args {
  map: string;
  seconds: number;
  seed: number;
  generated: boolean;
  match: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { map: 'city01', seconds: 10, seed: 1, generated: false, match: false };
  for (let i = 0; i < argv.length; i++) {
    const [key, inline] = argv[i]!.split('=');
    const value = inline ?? argv[i + 1];
    const consume = (): string | undefined => { if (inline === undefined) i++; return value; };
    switch (key) {
      case '--map': args.map = consume() ?? args.map; break;
      case '--seconds': args.seconds = Number(consume()); break;
      case '--seed': args.seed = Number(consume()); break;
      case '--generated': args.generated = true; break;
      case '--match': args.match = true; break;
      default: break;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const map = args.generated ? generateCityMap(args.seed) : loadMap(args.map);
  const world = await World.create({ map, seed: args.seed });

  console.log(`map: ${map.name} (${map.solids.length} solids, ${map.spawns.length} spawn points)`);
  for (const e of world.entities) {
    console.log(`  spawn ${e.team}: (${fmt(e.pos.x)}, ${fmt(e.pos.y)}, ${fmt(e.pos.z)})`);
  }

  const started = Date.now();
  const ticks = args.match ? playMatch(world) : playFreeFlight(world, args.seconds);
  const elapsed = Date.now() - started;

  console.log(`\nsimulated ${ticks} ticks (${fmt(ticks / world.config.sim.tickRate)}s) in ${elapsed}ms`);
  for (const e of world.entities) {
    console.log(
      `  ${e.team}: hp=${fmt(e.hp)} speed=${fmt(length(e.vel))} m/s boost=${fmt(e.boostFuel)} ` +
      `shots=${e.shotsFired}/${e.shotsHit} pos=(${fmt(e.pos.x)}, ${fmt(e.pos.y)}, ${fmt(e.pos.z)})`,
    );
    if (!Number.isFinite(e.pos.x + e.pos.y + e.pos.z)) throw new Error('simulation diverged');
  }
  world.dispose();
}

/** Both craft boost straight ahead. The point is that the sim survives it. */
function playFreeFlight(world: World, seconds: number): number {
  world.skipCountdown();
  const inputs = world.entities.map((e) => ({
    ...neutralInput(),
    move: { x: 0, y: 0, z: 1 },
    aimYaw: e.aimYaw,
    boost: true,
  }));

  const ticks = Math.round(seconds * world.config.sim.tickRate);
  for (let i = 0; i < ticks; i++) {
    for (const event of world.step(inputs)) {
      if (event.type === 'collision') {
        console.log(
          `  t=${fmt(world.time)}s  entity ${event.entityId} crashed at ${fmt(event.impactSpeed)} m/s ` +
          `(-${event.damage} hp)`,
        );
      }
    }
  }
  return ticks;
}

/**
 * A whole match with placeholder brains: the hunter chases and shoots, the
 * runner boosts away. Not AI, just enough motion to drive the rules.
 */
function playMatch(world: World): number {
  let ticks = 0;
  const limit = world.config.sim.tickRate * 60 * 20; // hard stop at 20 simulated minutes

  while (world.match.phase !== 'matchOver' && ticks < limit) {
    if (world.match.phase === 'roundOver') {
      console.log(`  round ${world.match.round}: ${describeResult(world.match.lastResult!)}`);
      world.nextRound();
      continue;
    }
    world.step(scriptInputs(world));
    ticks++;
  }

  if (world.match.lastResult) {
    console.log(`  round ${world.match.round}: ${describeResult(world.match.lastResult)}`);
  }
  const winner = world.match.matchWinnerId;
  console.log(
    `\nmatch: ${world.match.scores.join(' - ')} — ` +
    (winner === null ? 'draw' : `P${winner + 1} wins`),
  );
  return ticks;
}

function scriptInputs(world: World): PlayerInput[] {
  const inputs: PlayerInput[] = [];
  for (const self of world.entities) {
    const enemy = world.entities.find((e) => e.id !== self.id);
    if (!enemy) { inputs[self.id] = neutralInput(); continue; }

    const toward = lookAngles(self.pos, enemy.pos);
    const chasing = self.team === 'hunter';
    inputs[self.id] = {
      ...neutralInput(),
      move: { x: 0, y: 0, z: 1 },
      // The runner faces the hunter but flies backwards away from it.
      aimYaw: chasing ? toward.yaw : toward.yaw + Math.PI,
      aimPitch: chasing ? toward.pitch : 0,
      fire: chasing,
      boost: true,
    };
  }
  return inputs;
}

const fmt = (n: number): string => n.toFixed(1);

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
