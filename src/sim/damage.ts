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
