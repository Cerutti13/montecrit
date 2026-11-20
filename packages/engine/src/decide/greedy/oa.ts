// Greedy v8: the chance a provoking move's opportunity attacks drop the mover before it acts.
// A move that provokes is charged its expected HP (moveCost's oaRisk); the action taken after it
// happens only if the mover is still up, so that action's value is multiplied by 1 - P(drop).
// Exact over the reactors' hit odds and damage distributions (after the mover's defenses); pure.

import type { Pmf } from '../../odds/pmf.ts';

/** One reactor's opportunity attack: P(hit, no crit) is pHit - pCrit; the damage on a hit and on a crit. */
export interface OaStrike {
  readonly pHit: number;
  readonly pCrit: number;
  readonly hit: Pmf;
  readonly crit: Pmf;
}

/**
 * P(the strikes together deal at least `hp` damage), each landing independently. The total is
 * tracked capped at `hp` (an absorbing "dropped" state), so the work is strikes x hp x support.
 * `hp` is the mover's HP plus its temporary HP; hp <= 0 reads as already down (1).
 */
export function oaDropChance(strikes: readonly OaStrike[], hp: number): number {
  if (hp <= 0) return 1;
  if (strikes.length === 0) return 0;
  let cur = new Float64Array(hp + 1);
  cur[0] = 1;
  for (const s of strikes) {
    const next = new Float64Array(hp + 1);
    const miss = 1 - s.pHit;
    const plain = s.pHit - s.pCrit;
    for (let t = 0; t <= hp; t++) {
      const m = cur[t]!;
      if (m === 0) continue;
      if (t === hp) {
        next[hp]! += m; // already down: stays down
        continue;
      }
      next[t]! += m * miss;
      addInto(next, t, m * plain, s.hit, hp);
      addInto(next, t, m * s.pCrit, s.crit, hp);
    }
    cur = next;
  }
  return Math.min(1, Math.max(0, cur[hp]!));
}

function addInto(out: Float64Array, t: number, w: number, d: Pmf, hp: number): void {
  if (w === 0) return;
  for (let i = 0; i < d.p.length; i++) {
    const p = d.p[i]!;
    if (p === 0) continue;
    const x = Math.max(0, d.min + i);
    out[Math.min(hp, t + x)]! += w * p;
  }
}

/**
 * A follow-up worth `v`, after a move whose opportunity attacks drop me with probability `p`: a gain
 * is multiplied by 1 - p; a value at or below 0 (friendly fire, a program that costs more than it
 * does) is kept whole, so a likelier drop never makes a move score higher (review fix).
 */
export function afterDrop(v: number, p: number): number {
  return v > 0 ? v * (1 - p) : v;
}

/** What `afterDrop` takes off `v` (Explain's OA_DROP_TERM line, as a negative ev). */
export function dropLoss(v: number, p: number): number {
  return v > 0 ? v * p : 0;
}
