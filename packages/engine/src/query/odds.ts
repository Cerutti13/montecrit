// Exact odds for deciders (docs/design/m1c.md 3.5): a damage roll's distribution after the
// target's defenses, expectations capped at the HP it has, and save odds with every effect
// modifier folded in. Pure: no dice, no state writes, no caches (callers in decide/ memoize).

import { DAMAGE_TYPES, damageBit, type CompiledDamage } from '../content/types.ts';
import { exprPmf } from '../dice/expr.ts';
import { constant, convolve, type Pmf } from '../odds/pmf.ts';
import { rollOdds, type RollOdds } from '../rolls/rollspec.ts';
import { resetFold } from '../sim/effects.ts';
import { saveSpec } from '../sim/d20.ts';
import { oddsFlags, type QueryState, type Unit } from '../sim/state.ts';
import { defensesOf } from '../sim/stats.ts';
import type { QueryScratch } from './scratch.ts';

/** Distribution of g(X) for an integer function g. */
function mapPmf(a: Pmf, g: (x: number) => number): Pmf {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < a.p.length; i++) {
    if (a.p[i] === 0) continue;
    const v = g(a.min + i);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (lo > hi) return constant(0);
  const out = new Float64Array(hi - lo + 1);
  for (let i = 0; i < a.p.length; i++) if (a.p[i] !== 0) out[g(a.min + i) - lo]! += a.p[i]!;
  return { min: lo, p: out };
}

/**
 * What `target` takes from one damage instance, as a distribution: each damage type summed,
 * floored at 0, halved on a save (before Resistance, p.16), then Immunity, Resistance and
 * Vulnerability (sim/damage.ts applyDamage). A critical hit adds each part's extra dice;
 * an Advantage-only rider counts only with Advantage. `target` null: no defenses.
 */
export function damagePmf(parts: readonly CompiledDamage[], target: Unit | null, crit: boolean, adv: boolean, half = false): Pmf {
  let total = constant(0);
  // The target's masks, its resist/vuln/immune stats included (M3 step 4; no gate here reads whose turn it is).
  const def = target === null ? null : target.stats.length === 0 ? target.tpl : defensesOf(null, target, { resist: 0, vuln: 0, immune: 0 });
  for (let type = 0; type < DAMAGE_TYPES.length; type++) {
    let sum: Pmf | null = null;
    for (const p of parts) {
      if (p.type !== type || (p.ifAdvantage && !adv)) continue;
      let d = exprPmf(p.roll);
      if (crit && p.critExtra) d = convolve(d, exprPmf(p.critExtra));
      sum = sum ? convolve(sum, d) : d;
    }
    if (!sum) continue;
    const bit = damageBit(type);
    const immune = def !== null && (def.immune & bit) !== 0;
    const resist = def !== null && (def.resist & bit) !== 0;
    const vuln = def !== null && (def.vuln & bit) !== 0;
    total = convolve(
      total,
      mapPmf(sum, (x) => {
        let v = Math.max(0, x);
        if (half) v = Math.floor(v / 2);
        if (immune) return 0;
        if (resist) v = Math.floor(v / 2);
        if (vuln) v *= 2;
        return v;
      }),
    );
  }
  return total;
}

/** E[min(D, cap)]: expected HP removed from a creature with `cap` HP left (overkill doesn't count). */
export function expectedCapped(d: Pmf, cap: number): number {
  let s = 0;
  for (let i = 0; i < d.p.length; i++) s += Math.min(d.min + i, cap) * d.p[i]!;
  return s;
}

/** Odds of `roller` making a save (roll key `key`, DC `dc`) right now, effects and conditions included. */
export function saveOdds(st: QueryState, qs: QueryScratch, roller: Unit, key: number, dc: number): RollOdds {
  qs.adv.length = 0;
  qs.dis.length = 0;
  resetFold(qs.fold);
  return rollOdds(saveSpec(st, roller, key, dc, qs.adv, qs.dis, qs.fold), oddsFlags(st));
}
