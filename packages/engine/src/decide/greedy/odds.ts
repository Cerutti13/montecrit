// Exact roll odds without allocating, for the specs the greedy AI scores most (no dice added
// to the d20): the same per-face rules as rollOdds, in 20 steps. Anything with added dice goes
// to rollOdds.

import { rollOdds, type RollSpec } from '../../rolls/rollspec.ts';
import type { RuleFlags } from '../../rules/flags.ts';

export interface QuickOdds {
  pSuccess: number;
  pCrit: number;
}

export function quickOdds(spec: RollSpec, flags: RuleFlags, out: QuickOdds = { pSuccess: 0, pCrit: 0 }): QuickOdds {
  if (spec.preDice.length > 0 || (spec.extDice && spec.extDice.length > 0) || spec.afterFail) {
    const o = rollOdds(spec, flags);
    out.pSuccess = o.pSuccess;
    out.pCrit = o.pCrit;
    return out;
  }
  const attack = spec.kind === 'attack';
  const critMin = spec.critMin ?? 20;
  let ps = 0;
  let pc = 0;
  for (let nat = 1; nat <= 20; nat++) {
    // P(kept natural = nat): 1/20 straight; max of two d20s (2n - 1)/400; min of two (41 - 2n)/400.
    const pn = spec.adv === 'adv' ? (2 * nat - 1) / 400 : spec.adv === 'dis' ? (41 - 2 * nat) / 400 : 1 / 20;
    const crit = attack && (spec.autoCritOnHit === true || nat >= critMin);
    let hit: boolean;
    if (spec.autoFail) hit = false;
    else if (attack && nat === 1) hit = false;
    else if (attack && nat === 20) hit = true;
    else if (attack && flags.expandedCritAutoHits && nat >= critMin) hit = true;
    else if (!attack && flags.natOnChecksAndSaves === 'autoPassFail' && (nat === 20 || nat === 1)) hit = nat === 20;
    else hit = (spec.floor !== undefined ? Math.max(nat, spec.floor) : nat) + spec.flat >= spec.dc;
    if (!hit) continue;
    ps += pn;
    if (crit) pc += pn;
  }
  out.pSuccess = Math.min(1, ps);
  out.pCrit = Math.min(1, pc);
  return out;
}
