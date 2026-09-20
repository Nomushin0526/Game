/**
 * Head-less smoke run of the simulation, with no renderer anywhere in sight.
 *
 *   npm run sim:headless -- --map city01 --seconds 10 --seed 7
 *
 * This is the phase 1 acceptance check for "sim/ runs standalone under Node",
 * and the harness that `tools/simBatch.ts` will build on in phase 4.
 */

import { loadMap } from '../src/maps/loader.ts';
import { generateCityMap } from '../src/maps/generator.ts';
import { World } from '../src/sim/world.ts';
import { neutralInput, type PlayerInput } from '../src/sim/types.ts';
import { length } from '../src/sim/math.ts';

interface Args {
  map: string;
  seconds: number;
  seed: number;
  generated: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { map: 'city01', seconds: 10, seed: 1, generated: false };
  for (let i = 0; i < argv.length; i++) {
    const [key, inline] = argv[i]!.split('=');
    const value = inline ?? argv[i + 1];
    const consume = () => { if (inline === undefined) i++; return value; };
    switch (key) {
      case '--map': args.map = consume() ?? args.map; break;
      case '--seconds': args.seconds = Number(consume()); break;
      case '--seed': args.seed = Number(consume()); break;
      case '--generated': args.generated = true; break;
      default: break;
    }
  }
  return args;
}

function fly(yaw: number, boost: boolean): PlayerInput {
  return { ...neutralInput(), move: { x: 0, y: 0, z: 1 }, aimYaw: yaw, boost };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const map = args.generated ? generateCityMap(args.seed) : loadMap(args.map);
  const world = await World.create({ map, seed: args.seed });

  console.log(`map: ${map.name} (${map.solids.length} solids, ${map.spawns.length} spawn points)`);
  for (const e of world.entities) {
    console.log(`  spawn ${e.team}: (${fmt(e.pos.x)}, ${fmt(e.pos.y)}, ${fmt(e.pos.z)})`);
  }

  // Both craft boost straight ahead. They will meet geometry; the point of this
  // run is that the sim survives it and the numbers stay finite.
  const inputs = world.entities.map((e) => fly(e.aimYaw, true));
  let collisions = 0;
  const totalTicks = Math.round(args.seconds * world.config.sim.tickRate);
  const started = Date.now();

  for (let i = 0; i < totalTicks; i++) {
    for (const event of world.step(inputs)) {
      if (event.type === 'collision') {
        collisions++;
        console.log(
          `  t=${fmt(world.time)}s  entity ${event.entityId} crashed at ${fmt(event.impactSpeed)} m/s ` +
          `(-${event.damage} hp)`,
        );
      }
    }
  }

  const elapsed = Date.now() - started;
  console.log(`\nsimulated ${totalTicks} ticks (${fmt(args.seconds)}s) in ${elapsed}ms, ${collisions} collisions`);
  for (const e of world.entities) {
    console.log(
      `  ${e.team}: hp=${fmt(e.hp)} speed=${fmt(length(e.vel))} m/s boost=${fmt(e.boostFuel)} ` +
      `pos=(${fmt(e.pos.x)}, ${fmt(e.pos.y)}, ${fmt(e.pos.z)})`,
    );
    if (!Number.isFinite(e.pos.x + e.pos.y + e.pos.z)) throw new Error('simulation diverged');
  }
  world.dispose();
}

const fmt = (n: number): string => n.toFixed(1);

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
