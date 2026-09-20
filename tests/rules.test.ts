import { describe, expect, it } from 'vitest';
import { CONFIG, cloneConfig } from '../src/sim/config.ts';
import { createEntity } from '../src/sim/entity.ts';
import {
  advanceRound,
  beginRound,
  bestSlot,
  checkTouch,
  createMatchState,
  evaluateRound,
  maxRounds,
  recordRoundResult,
  teamsForRound,
  timeoutResult,
  type RoundResult,
} from '../src/sim/rules.ts';
import type { EntityState, Team, Vec3 } from '../src/sim/types.ts';

const at = (x: number, y = 60, z = 0): Vec3 => ({ x, y, z });

function pair(
  hunterPos: Vec3,
  runnerPos: Vec3,
  overrides: { hunter?: Partial<EntityState>; runner?: Partial<EntityState> } = {},
): EntityState[] {
  return [
    createEntity(0, 'hunter', hunterPos, CONFIG, overrides.hunter),
    createEntity(1, 'runner', runnerPos, CONFIG, overrides.runner),
  ];
}

describe('side assignment', () => {
  it('starts slot 0 as the hunter and alternates when swapping is on', () => {
    expect(teamsForRound(1, CONFIG)).toEqual<Team[]>(['hunter', 'runner']);
    expect(teamsForRound(2, CONFIG)).toEqual<Team[]>(['runner', 'hunter']);
    expect(teamsForRound(3, CONFIG)).toEqual<Team[]>(['hunter', 'runner']);
  });

  it('keeps sides fixed when swapping is off', () => {
    const config = cloneConfig();
    config.rules.swapSidesEachRound = false;
    for (const round of [1, 2, 3, 4]) {
      expect(teamsForRound(round, config)).toEqual<Team[]>(['hunter', 'runner']);
    }
  });
});

describe('touch', () => {
  it('fires when the hunter closes inside touchRadius', () => {
    const inside = CONFIG.rules.touchRadius - 0.1;
    expect(checkTouch(pair(at(0), at(inside)), CONFIG)).not.toBeNull();
  });

  it('does not fire just outside the radius', () => {
    const outside = CONFIG.rules.touchRadius + 0.1;
    expect(checkTouch(pair(at(0), at(outside)), CONFIG)).toBeNull();
  });

  it('does not fire against a craft that is already down', () => {
    const entities = pair(at(0), at(0.5), { runner: { alive: false, hp: 0 } });
    expect(checkTouch(entities, CONFIG)).toBeNull();
  });

  it('reports both slots and the tag position', () => {
    const touch = checkTouch(pair(at(0), at(1)), CONFIG)!;
    expect(touch.hunterId).toBe(0);
    expect(touch.runnerId).toBe(1);
    expect(touch.pos).toEqual(at(1));
  });
});

describe('round outcome', () => {
  it('is undecided while both craft are alive, apart and on the clock', () => {
    expect(evaluateRound(pair(at(-100), at(100)), 90, CONFIG)).toBeNull();
  });

  it('gives the round to whoever is left standing', () => {
    const entities = pair(at(-100), at(100), { runner: { hp: 0, alive: false } });
    expect(evaluateRound(entities, 90, CONFIG)).toEqual<RoundResult>({
      winnerId: 0,
      winnerTeam: 'hunter',
      reason: 'hp',
    });
  });

  it('lets the runner win by knockout too', () => {
    const entities = pair(at(-100), at(100), { hunter: { hp: 0, alive: false } });
    expect(evaluateRound(entities, 90, CONFIG)).toEqual<RoundResult>({
      winnerId: 1,
      winnerTeam: 'runner',
      reason: 'hp',
    });
  });

  it('calls a double knockout a draw', () => {
    const entities = pair(at(-100), at(100), {
      hunter: { hp: 0, alive: false },
      runner: { hp: 0, alive: false },
    });
    expect(evaluateRound(entities, 90, CONFIG)?.reason).toBe('draw');
  });

  it('gives the round to the hunter on a tag', () => {
    expect(evaluateRound(pair(at(0), at(1)), 90, CONFIG)).toEqual<RoundResult>({
      winnerId: 0,
      winnerTeam: 'hunter',
      reason: 'touch',
    });
  });

  it('gives the round to the runner when the clock runs out', () => {
    expect(evaluateRound(pair(at(-100), at(100)), 0, CONFIG)).toEqual<RoundResult>({
      winnerId: 1,
      winnerTeam: 'runner',
      reason: 'timeout',
    });
  });

  it('calls the clock a draw when timeoutWinner says so', () => {
    const config = cloneConfig();
    config.rules.timeoutWinner = 'draw';
    expect(evaluateRound(pair(at(-100), at(100)), 0, config)).toEqual<RoundResult>({
      winnerId: null,
      winnerTeam: null,
      reason: 'draw',
    });
  });

  it('ranks a knockout above a tag above the clock', () => {
    // Touching, out of time, and the runner is down: the knockout wins out.
    const entities = pair(at(0), at(1), { runner: { hp: 0, alive: false } });
    expect(evaluateRound(entities, 0, CONFIG)?.reason).toBe('hp');

    // Touching as the clock expires: the tag lands first.
    expect(evaluateRound(pair(at(0), at(1)), 0, CONFIG)?.reason).toBe('touch');
  });

  it('follows the swapped side in round 2', () => {
    const swapped = [
      createEntity(0, 'runner', at(-100), CONFIG),
      createEntity(1, 'hunter', at(100), CONFIG),
    ];
    expect(timeoutResult(swapped, CONFIG)).toEqual<RoundResult>({
      winnerId: 0,
      winnerTeam: 'runner',
      reason: 'timeout',
    });
  });
});

describe('match bookkeeping', () => {
  const win = (slot: number): RoundResult => ({
    winnerId: slot,
    winnerTeam: slot === 0 ? 'hunter' : 'runner',
    reason: 'hp',
  });
  const draw: RoundResult = { winnerId: null, winnerTeam: null, reason: 'draw' };

  it('starts at round 1 with a countdown and a full clock', () => {
    const match = createMatchState(CONFIG);
    expect(match.round).toBe(1);
    expect(match.phase).toBe('countdown');
    expect(match.countdownRemaining).toBe(CONFIG.rules.countdown);
    expect(match.timeRemaining).toBe(CONFIG.rules.timeLimit);
    expect(match.scores).toEqual([0, 0]);
  });

  it('takes the match at roundsToWin', () => {
    const match = createMatchState(CONFIG);
    recordRoundResult(match, win(0), CONFIG);
    expect(match.phase).toBe('roundOver');
    expect(match.matchWinnerId).toBeNull();

    advanceRound(match, CONFIG);
    recordRoundResult(match, win(0), CONFIG);
    expect(match.phase).toBe('matchOver');
    expect(match.matchWinnerId).toBe(0);
    expect(match.scores).toEqual([2, 0]);
  });

  it('runs to a decider when the rounds are split', () => {
    const match = createMatchState(CONFIG);
    recordRoundResult(match, win(0), CONFIG);
    advanceRound(match, CONFIG);
    recordRoundResult(match, win(1), CONFIG);
    expect(match.phase).toBe('roundOver');

    advanceRound(match, CONFIG);
    expect(match.round).toBe(3);
    recordRoundResult(match, win(1), CONFIG);
    expect(match.matchWinnerId).toBe(1);
  });

  it('scores nothing for a draw but still ends at maxRounds', () => {
    const match = createMatchState(CONFIG);
    for (let round = 1; round <= maxRounds(CONFIG); round++) {
      recordRoundResult(match, draw, CONFIG);
      if (round < maxRounds(CONFIG)) advanceRound(match, CONFIG);
    }
    expect(match.scores).toEqual([0, 0]);
    expect(match.phase).toBe('matchOver');
    expect(match.matchWinnerId).toBeNull();
  });

  it('awards an exhausted match to whoever is ahead', () => {
    const config = cloneConfig();
    config.rules.roundsToWin = 2; // best of 3
    const match = createMatchState(config);
    recordRoundResult(match, win(1), config);
    advanceRound(match, config);
    recordRoundResult(match, draw, config);
    advanceRound(match, config);
    recordRoundResult(match, draw, config);
    expect(match.round).toBe(maxRounds(config));
    expect(match.phase).toBe('matchOver');
    expect(match.matchWinnerId).toBe(1);
  });

  it('refuses to advance past a decided match', () => {
    const match = createMatchState(CONFIG);
    recordRoundResult(match, win(0), CONFIG);
    advanceRound(match, CONFIG);
    recordRoundResult(match, win(0), CONFIG);
    expect(advanceRound(match, CONFIG)).toBe(false);
    expect(match.round).toBe(2);
  });

  it('resets the clocks between rounds without touching the score', () => {
    const match = createMatchState(CONFIG);
    match.timeRemaining = 12;
    match.countdownRemaining = 0;
    recordRoundResult(match, win(0), CONFIG);

    beginRound(match, CONFIG);
    expect(match.phase).toBe('countdown');
    expect(match.timeRemaining).toBe(CONFIG.rules.timeLimit);
    expect(match.countdownRemaining).toBe(CONFIG.rules.countdown);
    expect(match.lastResult).toBeNull();
    expect(match.scores).toEqual([1, 0]);
  });

  it('keeps a per-slot score so swapping sides cannot confuse it', () => {
    const match = createMatchState(CONFIG);
    // Slot 0 wins round 1 as hunter, then round 2 as runner.
    recordRoundResult(match, { winnerId: 0, winnerTeam: 'hunter', reason: 'touch' }, CONFIG);
    advanceRound(match, CONFIG);
    recordRoundResult(match, { winnerId: 0, winnerTeam: 'runner', reason: 'timeout' }, CONFIG);
    expect(match.scores).toEqual([2, 0]);
    expect(match.matchWinnerId).toBe(0);
  });

  it('finds the leading slot, or null when level', () => {
    expect(bestSlot([2, 1])).toBe(0);
    expect(bestSlot([1, 2])).toBe(1);
    expect(bestSlot([1, 1])).toBeNull();
  });
});
