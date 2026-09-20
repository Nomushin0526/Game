/**
 * Round and match rules: win conditions, the tag check, and best-of-N bookkeeping.
 *
 * Deliberately free of any dependency on `World`, so every rule can be unit
 * tested against hand-built entity states (DESIGN.md phase 2 acceptance).
 */

import type { SkyTagConfig } from './config.ts';
import { distance } from './math.ts';
import type { EntityState, Team, TouchEvent } from './types.ts';

export type MatchPhase = 'countdown' | 'live' | 'roundOver' | 'matchOver';

/**
 * How a round was decided.
 * - `hp`      a craft was shot (or crashed) down
 * - `touch`   the hunter tagged the runner
 * - `timeout` the clock ran out and `rules.timeoutWinner` is 'runner'
 * - `draw`    the clock ran out with `timeoutWinner: 'draw'`, or a double KO
 */
export type RoundEndReason = 'hp' | 'touch' | 'timeout' | 'draw';

export interface RoundResult {
  /** Winning player slot, or null for a draw. Slots keep their identity as sides swap. */
  winnerId: number | null;
  /** The side the winner was playing this round. */
  winnerTeam: Team | null;
  reason: RoundEndReason;
}

export interface MatchState {
  /** 1-based. */
  round: number;
  phase: MatchPhase;
  /** Seconds left of the pre-round countdown. */
  countdownRemaining: number;
  /** Seconds left in the round. */
  timeRemaining: number;
  /** Round wins per player slot. */
  scores: number[];
  results: RoundResult[];
  lastResult: RoundResult | null;
  /** Player slot that took the match, or null while it is still running. */
  matchWinnerId: number | null;
}

export function createMatchState(config: SkyTagConfig, slots = 2): MatchState {
  return {
    round: 1,
    phase: 'countdown',
    countdownRemaining: config.rules.countdown,
    timeRemaining: config.rules.timeLimit,
    scores: new Array<number>(slots).fill(0),
    results: [],
    lastResult: null,
    matchWinnerId: null,
  };
}

/** Longest a best-of-N match can run, so draws cannot extend it forever. */
export function maxRounds(config: SkyTagConfig): number {
  return config.rules.roundsToWin * 2 - 1;
}

/**
 * Side assignment for a round.
 * Slot 0 starts as the hunter; with `swapSidesEachRound` the sides alternate so
 * both players get the same number of rounds on each side.
 */
export function teamsForRound(round: number, config: SkyTagConfig, slots = 2): Team[] {
  const swapped = config.rules.swapSidesEachRound && round % 2 === 0;
  return Array.from({ length: slots }, (_, slot) => {
    const isHunter = slot === 0 ? !swapped : swapped;
    return isHunter ? 'hunter' : 'runner';
  });
}

/** Reset the clocks for a fresh round. Scores and round number are untouched. */
export function beginRound(match: MatchState, config: SkyTagConfig): void {
  match.phase = 'countdown';
  match.countdownRemaining = config.rules.countdown;
  match.timeRemaining = config.rules.timeLimit;
  match.lastResult = null;
}

/** Advance to the next round. Returns false when the match is already decided. */
export function advanceRound(match: MatchState, config: SkyTagConfig): boolean {
  if (match.phase === 'matchOver') return false;
  match.round++;
  beginRound(match, config);
  return true;
}

/** The hunter is close enough to tag the runner. */
export function checkTouch(
  entities: readonly EntityState[],
  config: SkyTagConfig,
): TouchEvent | null {
  const hunter = entities.find((e) => e.team === 'hunter' && e.alive);
  const runner = entities.find((e) => e.team === 'runner' && e.alive);
  if (!hunter || !runner) return null;
  if (distance(hunter.pos, runner.pos) > config.rules.touchRadius) return null;
  return { type: 'touch', hunterId: hunter.id, runnerId: runner.id, pos: { ...runner.pos } };
}

/**
 * Decide the round, or return null if it is still running.
 *
 * Checked in order: a craft down, then a tag, then the clock. `timeRemaining`
 * is whatever is left after this tick's subtraction.
 */
export function evaluateRound(
  entities: readonly EntityState[],
  timeRemaining: number,
  config: SkyTagConfig,
): RoundResult | null {
  const alive = entities.filter((e) => e.alive);

  if (alive.length === 0) return { winnerId: null, winnerTeam: null, reason: 'draw' };
  if (alive.length < entities.length) {
    const survivor = alive[0]!;
    return { winnerId: survivor.id, winnerTeam: survivor.team, reason: 'hp' };
  }

  const touch = checkTouch(entities, config);
  if (touch) {
    const hunter = entities.find((e) => e.id === touch.hunterId)!;
    return { winnerId: hunter.id, winnerTeam: hunter.team, reason: 'touch' };
  }

  if (timeRemaining <= 0) return timeoutResult(entities, config);
  return null;
}

/** The runner's second win condition: outlast the clock. */
export function timeoutResult(
  entities: readonly EntityState[],
  config: SkyTagConfig,
): RoundResult {
  if (config.rules.timeoutWinner === 'runner') {
    const runner = entities.find((e) => e.team === 'runner');
    if (runner) return { winnerId: runner.id, winnerTeam: 'runner', reason: 'timeout' };
  }
  return { winnerId: null, winnerTeam: null, reason: 'draw' };
}

/**
 * Bank a round result and work out whether the match is over.
 * A draw scores nothing, so `maxRounds` is what stops an endless match.
 */
export function recordRoundResult(
  match: MatchState,
  result: RoundResult,
  config: SkyTagConfig,
): void {
  match.results.push(result);
  match.lastResult = result;
  if (result.winnerId !== null) match.scores[result.winnerId]!++;

  const leader = bestSlot(match.scores);
  const decided = leader !== null && match.scores[leader]! >= config.rules.roundsToWin;
  const exhausted = match.round >= maxRounds(config);

  if (decided || exhausted) {
    match.phase = 'matchOver';
    match.matchWinnerId = decided ? leader : leader;
  } else {
    match.phase = 'roundOver';
  }
}

/** Slot with the strictly highest score, or null when it is tied. */
export function bestSlot(scores: readonly number[]): number | null {
  let best = 0;
  let tied = false;
  for (let i = 1; i < scores.length; i++) {
    if (scores[i]! > scores[best]!) { best = i; tied = false; }
    else if (scores[i]! === scores[best]!) tied = true;
  }
  return tied ? null : best;
}

/** Human-readable summary, used by the result screen and the batch runner. */
export function describeResult(result: RoundResult): string {
  switch (result.reason) {
    case 'hp': return `P${result.winnerId! + 1} (${result.winnerTeam}) won by knockout`;
    case 'touch': return `P${result.winnerId! + 1} (hunter) won by tag`;
    case 'timeout': return `P${result.winnerId! + 1} (runner) survived the clock`;
    case 'draw': return 'Draw';
  }
}
