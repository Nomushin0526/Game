/**
 * The single place HP is taken away.
 *
 * Beam hits, crash damage and anything added later all funnel through here so
 * that invulnerability, death and the resulting events stay consistent.
 */

import type { SkyTagConfig } from './config.ts';
import type { DamageCause, EntityState, SimEvent } from './types.ts';

/**
 * Apply `amount` damage to `target` and return the events it produced.
 * Returns an empty array when the hit was ignored (already dead, or immune).
 */
export function applyDamage(
  target: EntityState,
  amount: number,
  cause: DamageCause,
  sourceId: number | null,
  config: SkyTagConfig,
): SimEvent[] {
  if (!target.alive || amount <= 0) return [];
  // Immunity covers incoming fire only: you cannot dodge your own crash.
  if (cause === 'beam' && target.invulnTimer > 0) return [];

  // A shield soaks beam damage until its pool runs out, then breaks. Crash
  // damage goes straight through: it is the price of flying badly, not an
  // attack to be blocked.
  if (cause === 'beam' && target.shieldTimer > 0) {
    const soaked = Math.min(amount, target.shieldPool);
    target.shieldPool -= soaked;
    amount -= soaked;
    if (target.shieldPool <= 0) {
      target.shieldTimer = 0;
      target.shieldPool = 0;
    }
    if (amount <= 0) {
      return [{ type: 'shieldAbsorbed', entityId: target.id, amount: soaked, broke: target.shieldTimer === 0, pos: { ...target.pos } }];
    }
  }

  target.hp = Math.max(0, target.hp - amount);
  if (cause === 'beam') target.invulnTimer = config.rules.hitInvulnerability;

  const events: SimEvent[] = [
    {
      type: 'damage',
      targetId: target.id,
      sourceId,
      amount,
      cause,
      remainingHp: target.hp,
      pos: { ...target.pos },
    },
  ];

  if (target.hp === 0) {
    target.alive = false;
    events.push({ type: 'death', entityId: target.id, killerId: sourceId, pos: { ...target.pos } });
  }
  return events;
}
