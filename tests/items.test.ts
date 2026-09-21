import { beforeAll, describe, expect, it } from 'vitest';
import { Perception } from '../src/ai/perception.ts';
import { loadMap } from '../src/maps/loader.ts';
import { CONFIG, cloneConfig } from '../src/sim/config.ts';
import { createEntity } from '../src/sim/entity.ts';
import { applyDamage } from '../src/sim/damage.ts';
import { boundsFromMap, stepFlight } from '../src/sim/flight.ts';
import { createItemSlots } from '../src/sim/items.ts';
import { distance } from '../src/sim/math.ts';
import { initPhysics, PhysicsWorld } from '../src/sim/physics.ts';
import {
  NO_ITEM,
  neutralInput,
  type DecoyState,
  type EntityState,
  type PlayerInput,
  type SimEvent,
  type Vec3,
} from '../src/sim/types.ts';
import { radarBlips } from '../src/render/hud.ts';
import { World } from '../src/sim/world.ts';

const map = loadMap('city01');

beforeAll(async () => {
  await initPhysics();
});

/**
 * Every item, in a fixed slot order.
 *
 * The shipping kits carry three each and leave `shield` and `overdrive` on the
 * bench, but both are still real items with real rules, so the tests give each
 * side everything rather than testing only what is currently equipped.
 */
const RUNNER_KIT = ['decoy', 'shield', 'flash', 'overcharge'] as const;
const HUNTER_KIT = ['scan', 'snare', 'overdrive', 'overcharge'] as const;

const slotOf = (kind: (typeof RUNNER_KIT)[number]): number => RUNNER_KIT.indexOf(kind);
const hunterSlotOf = (kind: (typeof HUNTER_KIT)[number]): number => HUNTER_KIT.indexOf(kind);

/** A config whose loadouts hold every item, so any of them can be exercised. */
function fullKitConfig() {
  const config = cloneConfig();
  config.items.loadout.runner = [...RUNNER_KIT];
  config.items.loadout.hunter = [...HUNTER_KIT];
  return config;
}

/** A live round with both craft parked where the test wants them. */
function arena(seed = 1) {
  const config = fullKitConfig();
  config.rules.countdown = 0;
  config.rules.timeLimit = 60;
  const world = new World({ map, config, seed });
  world.skipCountdown();

  const hunter = world.entityByTeam('hunter')!;
  const runner = world.entityByTeam('runner')!;
  // High open air, well clear of the city, facing each other.
  hunter.pos = { x: 0, y: 120, z: 0 };
  runner.pos = { x: 0, y: 120, z: -60 };
  hunter.aimYaw = 0;
  runner.aimYaw = Math.PI;
  return { world, config, hunter, runner };
}

function use(slot: number, aimYaw = 0): PlayerInput {
  return { ...neutralInput(), aimYaw, useItem: slot };
}

describe('item slots', () => {
  it('gives each side the loadout its config asks for', () => {
    const runner = createEntity(0, 'runner', { x: 0, y: 50, z: 0 }, CONFIG);
    const hunter = createEntity(1, 'hunter', { x: 0, y: 50, z: 0 }, CONFIG);
    // The contract: a craft's slots mirror its side's configured kit.
    expect(runner.items.map((s) => s.kind)).toEqual(CONFIG.items.loadout.runner);
    expect(hunter.items.map((s) => s.kind)).toEqual(CONFIG.items.loadout.hunter);
  });

  it('ships the kits the balance was measured with', () => {
    // Stated separately from the contract above so that changing a kit is a
    // deliberate edit here, not something a config tweak slips through.
    expect(CONFIG.items.loadout.runner).toEqual(['decoy', 'flash', 'overcharge']);
    expect(CONFIG.items.loadout.hunter).toEqual(['scan', 'snare', 'overcharge']);
  });

  it('starts every slot loaded and ready', () => {
    for (const slot of createItemSlots('runner', CONFIG)) {
      expect(slot.charges).toBe(CONFIG.items[slot.kind].charges);
      expect(slot.cooldown).toBe(0);
    }
  });

  it('spends a charge and starts the cooldown', () => {
    const { world, runner } = arena();
    const slot = slotOf('shield');
    world.step([neutralInput(), use(slot, Math.PI)]);

    expect(runner.items[slot]!.charges).toBe(CONFIG.items.shield.charges - 1);
    expect(runner.items[slot]!.cooldown).toBeGreaterThan(0);
    world.dispose();
  });

  it('refuses a second use while the slot is cooling', () => {
    const { world, runner } = arena();
    const slot = slotOf('shield');
    world.step([neutralInput(), use(slot, Math.PI)]);
    const left = runner.items[slot]!.charges;

    world.step([neutralInput(), use(slot, Math.PI)]);
    expect(runner.items[slot]!.charges).toBe(left);
    world.dispose();
  });

  it('runs out of charges', () => {
    const { world, config, runner } = arena();
    const slot = slotOf('decoy');
    const cooldown = config.items.decoy.cooldown;

    for (let i = 0; i < config.items.decoy.charges; i++) {
      world.step([neutralInput(), use(slot, Math.PI)]);
      world.stepFor(cooldown + 0.1, [neutralInput(), neutralInput()]);
    }
    expect(runner.items[slot]!.charges).toBe(0);

    const before = world.decoys.length;
    world.step([neutralInput(), use(slot, Math.PI)]);
    expect(world.decoys.length).toBe(before);
    world.dispose();
  });

  it('cannot be used during the countdown or while stunned', () => {
    const config = fullKitConfig();
    config.rules.countdown = 2;
    const world = new World({ map, config, seed: 1 });
    const runner = world.entityByTeam('runner')!;
    const slot = slotOf('shield');

    world.step([neutralInput(), use(slot, Math.PI)]);
    expect(runner.items[slot]!.charges).toBe(config.items.shield.charges);

    world.skipCountdown();
    runner.stunTimer = 1;
    world.step([neutralInput(), use(slot, Math.PI)]);
    expect(runner.items[slot]!.charges).toBe(config.items.shield.charges);
    world.dispose();
  });

  it('restores the full loadout on the next round', () => {
    const { world, config } = arena();
    const slot = slotOf('shield');
    world.step([neutralInput(), use(slot, Math.PI)]);

    world.stepFor(config.rules.timeLimit + 0.2);
    world.nextRound();
    for (const entity of world.entities) {
      for (const item of entity.items) {
        expect(item.charges).toBe(config.items[item.kind].charges);
        expect(item.cooldown).toBe(0);
      }
    }
    world.dispose();
  });
});

describe('shield', () => {
  it('soaks beam damage up to its capacity, then breaks', () => {
    const config = cloneConfig();
    const runner = createEntity(0, 'runner', { x: 0, y: 50, z: 0 }, config);
    runner.shieldTimer = config.items.shield.duration;
    runner.shieldPool = 10;

    // First hit is smaller than the pool: fully absorbed, no HP lost.
    const absorbed = applyDamage(runner, 6, 'beam', 1, config);
    expect(runner.hp).toBe(config.loadout.runner.maxHp);
    expect(absorbed.some((e) => e.type === 'shieldAbsorbed')).toBe(true);
    expect(runner.shieldPool).toBe(4);

    // The next one overruns the pool: the remainder gets through and it breaks.
    applyDamage(runner, 10, 'beam', 1, config);
    expect(runner.shieldTimer).toBe(0);
    expect(runner.hp).toBe(config.loadout.runner.maxHp - 6);
  });

  it('does not stop crash damage', () => {
    const config = cloneConfig();
    const runner = createEntity(0, 'runner', { x: 0, y: 50, z: 0 }, config);
    runner.shieldTimer = config.items.shield.duration;
    runner.shieldPool = 100;

    applyDamage(runner, 5, 'collision', null, config);
    expect(runner.hp).toBe(config.loadout.runner.maxHp - 5);
    expect(runner.shieldPool).toBe(100);
  });

  it('expires on its timer', () => {
    const { world, config, runner } = arena();
    world.step([neutralInput(), use(slotOf('shield'), Math.PI)]);
    expect(runner.shieldTimer).toBeGreaterThan(0);

    world.stepFor(config.items.shield.duration + 0.2, [neutralInput(), neutralInput()]);
    expect(runner.shieldTimer).toBe(0);
    expect(runner.shieldPool).toBe(0);
    world.dispose();
  });

  it('keeps a runner alive through fire that would otherwise kill it', () => {
    const { world, config, hunter, runner } = arena();
    runner.hp = 10;
    const fire: PlayerInput = { ...neutralInput(), aimYaw: 0, fire: true };

    world.step([fire, use(slotOf('shield'), Math.PI)]);
    expect(runner.shieldTimer).toBeGreaterThan(0);

    const flight = 60 / config.loadout.hunter.projectileSpeed + 0.2;
    world.stepFor(flight, [fire, neutralInput()]);
    // The shield ate it: still alive with HP that a single hit would have taken.
    expect(runner.alive).toBe(true);
    expect(hunter.shotsFired).toBeGreaterThan(0);
    world.dispose();
  });
});

describe('decoy', () => {
  it('leaves a phantom flying the way its owner was', () => {
    const { world, runner } = arena();
    runner.vel = { x: 30, y: 0, z: 0 };
    world.step([neutralInput(), use(slotOf('decoy'), Math.PI)]);

    expect(world.decoys).toHaveLength(1);
    const decoy = world.decoys[0]!;
    expect(decoy.ownerId).toBe(runner.id);
    // Set off along the runner's heading at its speed. Compared against the
    // runner's velocity after the step, since flight runs before items and the
    // craft had already coasted a little.
    expect(decoy.vel.x).toBeCloseTo(runner.vel.x, 3);
    expect(decoy.vel.x).toBeGreaterThan(25);
    expect(distance(decoy.pos, runner.pos)).toBeLessThan(5);
    world.dispose();
  });

  it('flies on after the runner changes course, and expires', () => {
    const { world, config, runner } = arena();
    runner.vel = { x: 30, y: 0, z: 0 };
    world.step([neutralInput(), use(slotOf('decoy'), Math.PI)]);
    const decoy = world.decoys[0]!;

    world.stepFor(1, [neutralInput(), neutralInput()]);
    expect(decoy.pos.x).toBeGreaterThan(20);

    world.stepFor(config.items.decoy.duration + 0.2, [neutralInput(), neutralInput()]);
    expect(world.decoys).toHaveLength(0);
    world.dispose();
  });

  it('is destroyed by a bolt, which tells the shooter it was fake', () => {
    const { world, config, runner } = arena();
    runner.vel = { x: 0, y: 0, z: 0 };
    world.step([neutralInput(), use(slotOf('decoy'), Math.PI)]);
    const decoy = world.decoys[0]!;
    // Park the phantom right in front of the hunter's guns.
    decoy.pos = { x: 0, y: 120, z: -40 };
    decoy.vel = { x: 0, y: 0, z: 0 };

    const fire: PlayerInput = { ...neutralInput(), aimYaw: 0, fire: true };
    const events: SimEvent[] = [];
    const flight = 40 / config.loadout.hunter.projectileSpeed + 0.3;
    for (let i = 0; i < Math.round(flight * config.sim.tickRate); i++) {
      events.push(...world.step([fire, neutralInput()]));
    }

    expect(world.decoys).toHaveLength(0);
    expect(events.some((e) => e.type === 'decoyGone' && e.popped)).toBe(true);
    world.dispose();
  });

  it('stops at the invisible wall instead of sailing out of the arena', () => {
    const { world, runner } = arena();
    // Flung hard at the edge of the map.
    runner.pos = { x: 180, y: 120, z: 0 };
    runner.vel = { x: 120, y: 0, z: 0 };
    world.step([neutralInput(), use(slotOf('decoy'), Math.PI)]);

    world.stepFor(2, [neutralInput(), neutralInput()]);
    const decoy = world.decoys[0]!;
    expect(decoy.pos.x).toBeLessThanOrEqual(world.bounds.maxX + 1e-6);
    expect(decoy.vel.x).toBe(0);
    world.dispose();
  });

  it('is never hit by its own owner', () => {
    const { world, runner } = arena();
    world.step([neutralInput(), use(slotOf('decoy'), Math.PI)]);
    const decoy = world.decoys[0]!;
    decoy.pos = { x: runner.pos.x, y: runner.pos.y, z: runner.pos.z - 30 };
    decoy.vel = { x: 0, y: 0, z: 0 };

    // The runner shoots towards its own phantom.
    world.stepFor(1, [neutralInput(), { ...neutralInput(), aimYaw: 0, fire: true }]);
    expect(world.decoys).toHaveLength(1);
    world.dispose();
  });
});

describe('decoys against AI perception', () => {
  const tuning = CONFIG.ai.difficulty.hard;
  const dt = CONFIG.sim.fixedDt;
  let physics: PhysicsWorld;

  beforeAll(() => {
    physics = new PhysicsWorld(map);
  });

  function watcher(): EntityState {
    // Parked high over the city looking along -Z, with clear air ahead.
    return createEntity(0, 'hunter', { x: 0, y: 140, z: 60 }, CONFIG, { aimYaw: 0 });
  }

  function phantom(pos: { x: number; y: number; z: number }, vel = { x: 0, y: 0, z: 0 }): DecoyState {
    return { id: 1, ownerId: 1, team: 'runner', pos, vel, life: 5 };
  }

  it('sees a decoy as a contact', () => {
    const p = new Perception();
    p.update(watcher(), undefined, [phantom({ x: 0, y: 140, z: 0 })], physics, CONFIG, tuning, dt);
    expect(p.visible).toBe(true);
    expect(p.fooled).toBe(true);
  });

  it('keeps following the phantom it was already tracking', () => {
    const p = new Perception();
    const self = watcher();
    const runner = createEntity(1, 'runner', { x: 0, y: 140, z: 0 }, CONFIG);

    // Tracking the real craft first.
    p.update(self, runner, [], physics, CONFIG, tuning, dt);
    expect(p.fooled).toBe(false);

    // A phantom carries on along the tracked course while the runner breaks
    // away sideways: continuity of contact keeps the eye on the phantom.
    const decoy = phantom({ x: 0, y: 140, z: -2 }, { x: 0, y: 0, z: -20 });
    runner.pos = { x: 40, y: 140, z: 0 };
    p.update(self, runner, [decoy], physics, CONFIG, tuning, dt);
    expect(p.fooled).toBe(true);
    expect(p.estimate(runner, CONFIG)!.x).toBeCloseTo(decoy.pos.x, 1);
  });

  it('ignores a decoy thrown by itself', () => {
    const p = new Perception();
    const self = watcher();
    const own: DecoyState = { ...phantom({ x: 0, y: 140, z: 0 }), ownerId: self.id };
    p.update(self, undefined, [own], physics, CONFIG, tuning, dt);
    expect(p.visible).toBe(false);
  });
});

describe('decoys on the radar', () => {
  /** Facing -Z at the origin, high in open air. */
  const self = () => createEntity(0, 'hunter', { x: 0, y: 100, z: 0 }, CONFIG, { aimYaw: 0 });
  /** 80 m straight ahead. */
  const runner = () => createEntity(1, 'runner', { x: 0, y: 100, z: -80 }, CONFIG);
  const phantom = (pos: Vec3, ownerId = 1): DecoyState => ({
    id: 1, ownerId, team: 'runner', pos, vel: { x: 0, y: 0, z: 0 }, life: 5,
  });
  const clear = (): boolean => false;
  const hud = (overrides: Partial<typeof CONFIG.hud> = {}) => ({
    ...CONFIG,
    hud: { ...CONFIG.hud, ...overrides },
  });

  it('paints a decoy as an extra contact, with nothing to tell them apart', () => {
    // A display that singled out the real craft would let a human read the
    // radar and ignore the phantom.
    const blips = radarBlips(
      self(), runner(), [phantom({ x: 60, y: 100, z: -40 })], hud({ enemyIndicator: 'always' }), clear,
    );
    expect(blips).toHaveLength(2);
    // Nothing on a blip says which is the real one.
    for (const blip of blips) {
      expect(Object.keys(blip).sort()).toEqual(['altitude', 'distance', 'x', 'y']);
    }
  });

  it('places a contact straight ahead at the top of the radar', () => {
    const [blip] = radarBlips(self(), runner(), [], hud({ enemyIndicator: 'always' }), clear);
    expect(blip!.x).toBeCloseTo(0, 6);
    expect(blip!.y).toBeCloseTo(80 / CONFIG.hud.radarRange, 6);
    expect(blip!.distance).toBeCloseTo(80, 6);
  });

  it('rotates contacts into the viewer heading, so up is forward', () => {
    const turned = self();
    // Yaw PI faces +Z, so the contact at -Z is now behind.
    turned.aimYaw = Math.PI;
    const [behind] = radarBlips(turned, runner(), [], hud({ enemyIndicator: 'always' }), clear);
    expect(behind!.y).toBeCloseTo(-80 / CONFIG.hud.radarRange, 5);

    // A quarter turn puts it out to one side instead.
    turned.aimYaw = Math.PI / 2;
    const [beside] = radarBlips(turned, runner(), [], hud({ enemyIndicator: 'always' }), clear);
    expect(Math.abs(beside!.x)).toBeCloseTo(80 / CONFIG.hud.radarRange, 5);
    expect(beside!.y).toBeCloseTo(0, 5);
  });

  it('marks contacts above and below, and leaves near-level ones alone', () => {
    const band = CONFIG.hud.radarAltitudeBand;
    const at = (dy: number): Vec3 => ({ x: 0, y: 100 + dy, z: -60 });
    const altitudeOf = (dy: number): string =>
      radarBlips(self(), undefined, [phantom(at(dy))], hud({ enemyIndicator: 'always' }), clear)[0]!.altitude;

    expect(altitudeOf(band + 10)).toBe('above');
    expect(altitudeOf(-(band + 10))).toBe('below');
    expect(altitudeOf(band - 5)).toBe('level');
  });

  it('leaves out anything past the radar range', () => {
    const far = createEntity(1, 'runner', { x: 0, y: 100, z: -(CONFIG.hud.radarRange + 50) }, CONFIG);
    expect(radarBlips(self(), far, [], hud({ enemyIndicator: 'always' }), clear)).toEqual([]);
  });

  it('hides a contact the policy says is out of sight', () => {
    const blockDecoy = (_from: Vec3, to: Vec3): boolean => to.x === 60;
    const blips = radarBlips(
      self(), runner(), [phantom({ x: 60, y: 100, z: -40 })], hud({ enemyIndicator: 'lineOfSight' }), blockDecoy,
    );
    expect(blips).toHaveLength(1);
    expect(blips[0]!.x).toBeCloseTo(0, 6);
  });

  it('never paints your own decoy', () => {
    const me = self();
    const blips = radarBlips(
      me, runner(), [phantom({ x: 60, y: 100, z: -40 }, me.id)], hud({ enemyIndicator: 'always' }), clear,
    );
    expect(blips).toHaveLength(1);
  });

  it('paints nothing under the never policy, or when down', () => {
    expect(radarBlips(self(), runner(), [], hud({ enemyIndicator: 'never' }), clear)).toEqual([]);

    const dead = self();
    dead.alive = false;
    expect(radarBlips(dead, runner(), [], hud({ enemyIndicator: 'always' }), clear)).toEqual([]);

    const downed = runner();
    downed.alive = false;
    expect(radarBlips(self(), downed, [], hud({ enemyIndicator: 'always' }), clear)).toEqual([]);
  });
});

describe('flash grenade', () => {
  it('bursts on its fuse and blinds an enemy in range with line of sight', () => {
    const { world, config, hunter, runner } = arena();
    runner.pos = { x: 0, y: 120, z: -20 };
    // Aimed straight at the hunter.
    const events = world.stepFor(config.items.flash.fuse + 0.4, [
      neutralInput(),
      use(slotOf('flash'), Math.PI),
    ]);

    expect(events.some((e) => e.type === 'flashBurst')).toBe(true);
    expect(events.some((e) => e.type === 'blinded' && e.entityId === hunter.id)).toBe(true);
    expect(hunter.blindTimer).toBeGreaterThan(0);
    world.dispose();
  });

  it('never blinds the craft that threw it', () => {
    const { world, config, runner } = arena();
    runner.pos = { x: 0, y: 120, z: -20 };
    world.stepFor(config.items.flash.fuse + 0.4, [neutralInput(), use(slotOf('flash'), Math.PI)]);
    expect(runner.blindTimer).toBe(0);
    world.dispose();
  });

  it('does not reach an enemy beyond its radius', () => {
    const { world, config, hunter, runner } = arena();
    // Well outside the blast, and thrown the other way.
    hunter.pos = { x: 0, y: 120, z: config.items.flash.radius * 3 };
    runner.pos = { x: 0, y: 120, z: -40 };
    world.stepFor(config.items.flash.fuse + 0.4, [neutralInput(), use(slotOf('flash'), 0)]);
    expect(hunter.blindTimer).toBe(0);
    world.dispose();
  });

  it('wears off', () => {
    const { world, config, hunter } = arena();
    hunter.blindTimer = config.items.flash.blindDuration;
    world.stepFor(config.items.flash.blindDuration + 0.2);
    expect(hunter.blindTimer).toBe(0);
    world.dispose();
  });

  it('takes a blinded AI\'s eyes away completely', () => {
    const physics = new PhysicsWorld(map);
    const p = new Perception();
    const self = createEntity(0, 'hunter', { x: 0, y: 140, z: 60 }, CONFIG, { aimYaw: 0 });
    const runner = createEntity(1, 'runner', { x: 0, y: 140, z: 0 }, CONFIG);

    p.update(self, runner, [], physics, CONFIG, CONFIG.ai.difficulty.hard, CONFIG.sim.fixedDt);
    expect(p.visible).toBe(true);

    self.blindTimer = 1;
    p.update(self, runner, [], physics, CONFIG, CONFIG.ai.difficulty.hard, CONFIG.sim.fixedDt);
    expect(p.visible).toBe(false);
    // And the clock on the sighting keeps running while it cannot see.
    expect(p.timeSinceSeen).toBeGreaterThan(0);
    physics.dispose();
  });
});

describe('scan', () => {
  const tuning = CONFIG.ai.difficulty.hard;
  const dt = CONFIG.sim.fixedDt;

  /** A hunter parked high over the city, looking along -Z. */
  const watcher = (): EntityState =>
    createEntity(0, 'hunter', { x: 0, y: 140, z: 60 }, CONFIG, { aimYaw: 0 });

  it('lights the craft up for its duration and then goes dark', () => {
    const { world, config, hunter } = arena();
    world.step([use(hunterSlotOf('scan')), neutralInput()]);
    expect(hunter.revealTimer).toBeGreaterThan(0);

    world.stepFor(config.items.scan.duration + 0.2, [neutralInput(), neutralInput()]);
    expect(hunter.revealTimer).toBe(0);
    world.dispose();
  });

  it('finds the real craft behind a decoy, and drops the phantom', () => {
    const physics = new PhysicsWorld(map);
    const p = new Perception();
    const self = watcher();
    const runner = createEntity(1, 'runner', { x: 0, y: 140, z: 0 }, CONFIG);

    // Tracked honestly first, so the phantom has a course to inherit.
    p.update(self, runner, [], physics, CONFIG, tuning, dt);
    expect(p.visible).toBe(true);

    // The decoy takes over that position as the runner breaks away.
    const lure: DecoyState = {
      id: 1, ownerId: 1, team: 'runner',
      pos: { x: 0, y: 140, z: 0 }, vel: { x: 0, y: 0, z: 0 }, life: 5,
    };
    runner.pos = { x: 40, y: 140, z: 20 };
    p.update(self, runner, [lure], physics, CONFIG, tuning, dt);
    expect(p.fooled).toBe(true);

    self.revealTimer = CONFIG.items.scan.duration;
    p.update(self, runner, [lure], physics, CONFIG, tuning, dt);
    expect(p.fooled).toBe(false);
    expect(p.estimate(runner, CONFIG)!.x).toBeCloseTo(runner.pos.x, 5);
    physics.dispose();
  });

  it('sees through cover and through a flash, but not past its range', () => {
    const physics = new PhysicsWorld(map);
    const p = new Perception();
    const self = watcher();
    // Behind the hunter, so the field of view rejects it outright.
    const runner = createEntity(1, 'runner', { x: 0, y: 140, z: 130 }, CONFIG);

    p.update(self, runner, [], physics, CONFIG, tuning, dt);
    expect(p.visible).toBe(false);

    self.revealTimer = CONFIG.items.scan.duration;
    self.blindTimer = 2;
    p.update(self, runner, [], physics, CONFIG, tuning, dt);
    expect(p.visible).toBe(true);

    // Beyond the ping's reach the runner is genuinely lost again.
    runner.pos = { x: 0, y: 140, z: 60 + CONFIG.items.scan.radius + 40 };
    p.update(self, runner, [], physics, CONFIG, tuning, dt);
    expect(p.visible).toBe(false);
    physics.dispose();
  });

  it('paints one true blip on the radar, with the decoys gone', () => {
    const self = createEntity(0, 'hunter', { x: 0, y: 100, z: 0 }, CONFIG, { aimYaw: 0 });
    const runner = createEntity(1, 'runner', { x: 0, y: 100, z: -80 }, CONFIG);
    const lure: DecoyState = {
      id: 1, ownerId: 1, team: 'runner',
      pos: { x: 60, y: 100, z: -40 }, vel: { x: 0, y: 0, z: 0 }, life: 5,
    };
    // Everything blocked, so only the scan can be painting anything.
    const blocked = (): boolean => true;

    expect(radarBlips(self, runner, [lure], CONFIG, blocked)).toEqual([]);

    self.revealTimer = CONFIG.items.scan.duration;
    const blips = radarBlips(self, runner, [lure], CONFIG, blocked);
    expect(blips).toHaveLength(1);
    expect(blips[0]!.distance).toBeCloseTo(80, 6);
  });

  it('falls back to ordinary sight when the target is out of ping range', () => {
    const self = createEntity(0, 'hunter', { x: 0, y: 100, z: 0 }, CONFIG, { aimYaw: 0 });
    // Inside radar range but outside the scan's, with a decoy alongside.
    const far = CONFIG.items.scan.radius + 10;
    const runner = createEntity(1, 'runner', { x: 0, y: 100, z: -far }, CONFIG);
    const lure: DecoyState = {
      id: 1, ownerId: 1, team: 'runner',
      pos: { x: 20, y: 100, z: -far }, vel: { x: 0, y: 0, z: 0 }, life: 5,
    };
    self.revealTimer = CONFIG.items.scan.duration;

    expect(far).toBeLessThan(CONFIG.hud.radarRange);
    // Both contacts, undistinguished: a ping that found nothing blanks nothing.
    expect(radarBlips(self, runner, [lure], CONFIG, () => false)).toHaveLength(2);
  });
});

describe('snare', () => {
  it('bursts on its fuse and slows an enemy in range with line of sight', () => {
    const { world, config, hunter, runner } = arena();
    hunter.pos = { x: 0, y: 120, z: 0 };
    runner.pos = { x: 0, y: 120, z: -15 };

    const events = world.stepFor(config.items.snare.fuse + 0.4, [
      use(hunterSlotOf('snare')),
      neutralInput(),
    ]);

    expect(events.some((e) => e.type === 'snareBurst')).toBe(true);
    expect(events.some((e) => e.type === 'snared' && e.entityId === runner.id)).toBe(true);
    expect(runner.snareTimer).toBeGreaterThan(0);
    world.dispose();
  });

  it('never catches the craft that threw it, nor one outside the radius', () => {
    const { world, config, hunter, runner } = arena();
    runner.pos = { x: 0, y: 120, z: -60 };
    // Thrown the other way entirely, so the burst is nowhere near the runner.
    world.stepFor(config.items.snare.fuse + 0.4, [
      use(hunterSlotOf('snare'), Math.PI),
      neutralInput(),
    ]);

    expect(hunter.snareTimer).toBe(0);
    expect(runner.snareTimer).toBe(0);
    world.dispose();
  });

  it('cuts top speed while it lasts, and gives it back afterwards', () => {
    const config = cloneConfig();
    const physics = new PhysicsWorld(map);
    const bounds = boundsFromMap(map);
    const ctx = { dt: config.sim.fixedDt, config, physics, bounds, controlEnabled: true };
    // Full forward thrust, held long enough to reach terminal speed.
    const ahead: PlayerInput = { ...neutralInput(), move: { x: 0, y: 0, z: 1 } };

    const topSpeed = (snared: boolean): number => {
      const craft = createEntity(0, 'runner', { x: 0, y: 130, z: 120 }, config);
      for (let i = 0; i < 180; i++) {
        if (snared) craft.snareTimer = 5;
        stepFlight(craft, ahead, ctx);
      }
      return Math.hypot(craft.vel.x, craft.vel.y, craft.vel.z);
    };

    const free = topSpeed(false);
    expect(topSpeed(true)).toBeCloseTo(free * config.items.snare.speedMultiplier, 1);
    physics.dispose();
  });

  it('wears off on its own timer', () => {
    const { world, config, runner } = arena();
    runner.snareTimer = config.items.snare.duration;
    world.stepFor(config.items.snare.duration + 0.2);
    expect(runner.snareTimer).toBe(0);
    world.dispose();
  });
});

describe('overdrive', () => {
  it('raises top speed for its duration', () => {
    const config = cloneConfig();
    const physics = new PhysicsWorld(map);
    const bounds = boundsFromMap(map);
    const ctx = { dt: config.sim.fixedDt, config, physics, bounds, controlEnabled: true };
    const ahead: PlayerInput = { ...neutralInput(), move: { x: 0, y: 0, z: 1 } };

    const topSpeed = (surging: boolean): number => {
      const craft = createEntity(0, 'hunter', { x: 0, y: 130, z: 120 }, config);
      for (let i = 0; i < 180; i++) {
        if (surging) craft.overdriveTimer = 5;
        stepFlight(craft, ahead, ctx);
      }
      return Math.hypot(craft.vel.x, craft.vel.y, craft.vel.z);
    };

    const normal = topSpeed(false);
    expect(topSpeed(true)).toBeCloseTo(normal * config.items.overdrive.speedMultiplier, 1);
    physics.dispose();
  });

  it('runs the thrusters without touching the gauge', () => {
    const { world, config, hunter, runner } = arena();
    // A long clear run along -Z, with the runner parked out of tag range so
    // the round does not end mid-test.
    hunter.pos = { x: 0, y: 130, z: 190 };
    runner.pos = { x: 180, y: 130, z: -190 };
    const boosting: PlayerInput = { ...neutralInput(), move: { x: 0, y: 0, z: 1 }, boost: true };

    world.step([{ ...boosting, useItem: hunterSlotOf('overdrive') }, neutralInput()]);
    // Flight runs before items, so the tick the charge is spent on still pays
    // for its boost. Everything after it is free.
    const fuel = hunter.boostFuel;

    world.stepFor(config.items.overdrive.duration - 0.5, [boosting, neutralInput()]);
    expect(hunter.boosting).toBe(true);
    expect(hunter.boostFuel).toBe(fuel);

    // Once it lapses the boost costs what it always did.
    world.stepFor(1.5, [boosting, neutralInput()]);
    expect(hunter.boostFuel).toBeLessThan(config.flight.boostCapacity);
    world.dispose();
  });

  it('is cancelled out in part by a snare, rather than beating it outright', () => {
    const config = cloneConfig();
    const physics = new PhysicsWorld(map);
    const bounds = boundsFromMap(map);
    const ctx = { dt: config.sim.fixedDt, config, physics, bounds, controlEnabled: true };
    const ahead: PlayerInput = { ...neutralInput(), move: { x: 0, y: 0, z: 1 } };

    const craft = createEntity(0, 'hunter', { x: 0, y: 130, z: 120 }, config);
    for (let i = 0; i < 180; i++) {
      craft.overdriveTimer = 5;
      craft.snareTimer = 5;
      stepFlight(craft, ahead, ctx);
    }
    const both = Math.hypot(craft.vel.x, craft.vel.y, craft.vel.z);
    const cruise = config.loadout.hunter.cruiseSpeed;
    const expected =
      cruise * config.items.overdrive.speedMultiplier * config.items.snare.speedMultiplier;

    expect(both).toBeCloseTo(expected, 1);
    physics.dispose();
  });
});

describe('items and the simulation contract', () => {
  it('keeps decoys in the snapshot so a replay stays exact', () => {
    const { world, config } = arena(7);
    const inputs = [neutralInput(), use(slotOf('decoy'), Math.PI)];
    world.step(inputs);
    expect(world.decoys.length).toBe(1);

    const mid = world.snapshot();
    world.stepFor(1, [neutralInput(), neutralInput()]);
    const end = world.snapshot();

    world.restore(mid);
    world.stepFor(1, [neutralInput(), neutralInput()]);
    expect(world.snapshot()).toEqual(end);
    expect(config.items.loadout.runner.length).toBeGreaterThan(0);
    world.dispose();
  });

  it('stays deterministic with items in play', () => {
    const run = (): unknown => {
      const { world } = arena(9);
      world.step([neutralInput(), use(slotOf('decoy'), Math.PI)]);
      world.stepFor(0.5, [neutralInput(), use(slotOf('flash'), Math.PI)]);
      const snapshot = world.snapshot();
      world.dispose();
      return snapshot;
    };
    expect(run()).toEqual(run());
  });

  it('ignores an out-of-range slot index', () => {
    const { world, runner } = arena();
    world.step([neutralInput(), { ...neutralInput(), useItem: 99 }]);
    world.step([neutralInput(), { ...neutralInput(), useItem: NO_ITEM }]);
    expect(runner.items.every((s) => s.charges === CONFIG.items[s.kind].charges)).toBe(true);
    world.dispose();
  });
});

describe('overcharge', () => {
  it('fires without drawing on the magazine, then goes back to costing bolts', () => {
    const { world, config, hunter } = arena();
    const slot = hunterSlotOf('overcharge');
    const fire: PlayerInput = { ...neutralInput(), aimYaw: 0, fire: true };

    world.step([{ ...fire, useItem: slot }, neutralInput()]);
    const before = hunter.ammo;

    world.stepFor(config.items.overcharge.duration - 0.3, [fire, neutralInput()]);
    expect(hunter.overchargeTimer).toBeGreaterThan(0);
    expect(hunter.shotsFired).toBeGreaterThan(1);
    expect(hunter.ammo).toBe(before);

    // Once the window shuts the gun is back on its own supply.
    world.stepFor(1, [fire, neutralInput()]);
    expect(hunter.ammo).toBeLessThan(before);
    world.dispose();
  });

  it('lets a dry gun shoot again for the window only', () => {
    const { world, config, hunter } = arena();
    hunter.ammo = 0;
    const fire: PlayerInput = { ...neutralInput(), aimYaw: 0, fire: true };

    // Dry: nothing comes out.
    expect(world.stepFor(0.5, [fire, neutralInput()]).some((e) => e.type === 'fire')).toBe(false);

    world.step([{ ...fire, useItem: hunterSlotOf('overcharge') }, neutralInput()]);
    const during = world.stepFor(config.items.overcharge.duration - 0.2, [fire, neutralInput()]);
    expect(during.some((e) => e.type === 'fire')).toBe(true);

    // Close the window before asserting, or the tail of it still fires.
    world.stepFor(0.4, [fire, neutralInput()]);
    expect(hunter.overchargeTimer).toBe(0);

    const after = world.stepFor(1, [fire, neutralInput()]);
    expect(hunter.ammo).toBe(0);
    expect(after.some((e) => e.type === 'fire')).toBe(false);
    world.dispose();
  });
});

describe('cloud', () => {
  // Empty sky with one bank in it, so nothing but the cloud can answer a
  // query. On `city01` these lines run through the floaters.
  const bare = {
    id: 'sky', name: 'Empty Sky',
    size: { x: 400, z: 400 }, ceiling: 200, floor: 0,
    spawns: [{ x: -150, y: 120, z: 0 }, { x: 150, y: 120, z: 0 }],
    solids: [],
  };
  const clouded = { ...bare, clouds: [{ pos: { x: 0, y: 120, z: -30 }, radius: 20 }] };
  let physics: PhysicsWorld;
  beforeAll(() => { physics = new PhysicsWorld(clouded); });

  const a = { x: 0, y: 120, z: 0 };
  const b = { x: 0, y: 120, z: -60 };

  it('blocks a sight line that passes through it', () => {
    expect(new PhysicsWorld(bare).isBlocked(a, b)).toBe(false);
    expect(physics.isBlocked(a, b)).toBe(true);
  });

  it('leaves a line that misses it alone', () => {
    expect(physics.isBlocked(a, { x: 60, y: 120, z: 0 })).toBe(false);
  });

  it('does not stop movement or bolts', () => {
    // The whole point: you fly into weather, you do not bounce off it.
    expect(physics.sphereCast(a, { x: 0, y: 0, z: -1 }, 60, 1.2)).toBeNull();
    expect(physics.isClear({ x: 0, y: 120, z: -30 }, 1.2)).toBe(true);
    expect(physics.isInsideCloud({ x: 0, y: 120, z: -30 })).toBe(true);
  });

  it('hides a craft from the CPU and from the radar alike', () => {
    const self = createEntity(0, 'hunter', a, CONFIG, { aimYaw: 0 });
    const enemy = createEntity(1, 'runner', b, CONFIG);
    const p = new Perception();

    p.update(self, enemy, [], physics, CONFIG, CONFIG.ai.difficulty.hard, CONFIG.sim.fixedDt);
    expect(p.visible).toBe(false);
    expect(radarBlips(self, enemy, [], CONFIG, (f, t) => physics.isBlocked(f, t))).toEqual([]);
  });
});
