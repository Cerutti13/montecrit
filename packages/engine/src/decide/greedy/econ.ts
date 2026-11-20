// Greedy valuation of M3 step 5a's primitives (docs/design/m3.md section 3, critique C6): weapon
// strikes from features (WATK), riders (RIDER), the damage-reducing reaction (REACT hitTaken),
// granted actions (ECON: Dash, Disengage, Dodge, one more action), the initiative hook (HOOKX)
// and pool steps and costs (POOLX). The decider-side code is in greedy.ts; this file holds the
// model's constants and its pure parts. SRD 5.2.1 lines are srd-raw.txt.
//
// What each term counts:
//   weaponAttack  count x the best single strike from where it stands: exact hit and crit odds
//                 (the engine's own attack spec), damage after defenses capped at the target's
//                 HP plus the drop chance x killValue (the same as the Attack action's strikes),
//                 plus, on a hit, the free riders the strike carries (no pool cost, the right
//                 grantedBy: Open Hand Technique on Flurry of Blows), each at its best option.
//   Dodge         until the start of my next turn, attack rolls against me have Disadvantage
//                 (33369-33376): my end cost where I end (exposure, drop risk, concentration)
//                 with and without it. Lost while Incapacitated or at Speed 0, none while Blinded (dodgeImposesDis).
//                 Not counted (it only raises the value): Advantage on DEX saves.
//   Dash          only when nothing is in reach from any square I can reach now, and something
//                 would be with my Speed added (the Dash action, 33240-33246): the strikes my
//                 action still buys there, less the exposure next to that target.
//   Disengage     0 inside a program; the turn decision's Disengage-first rule weighs it against
//                 the opportunity attacks of the best provoking move (33363-33366).
//   gainAction    one more Attack action: its full routine's strikes from the best square.
//   pool step     each point gained at its in-fight value (pointValue below).
//
// A pool point's value (what else it could buy over the fight horizon). No rest happens in a
// fight, so a point spent now is gone for the fight (Monk's Focus, 11120-11122). Its value is
//   scarcity(left) x max(poolUse, gamma x alt)
// where alt is the best marginal use of one point among the creature's activations that spend
// the same pool, the one being valued included (it could be used on a later turn instead): an
// activation's program value now less the best free activation of the same action cost (Flurry
// of Blows' two strikes against the free Martial Arts strike: one strike), per point; gamma
// because it would be spent on a later turn; poolUse (weights.ts) is the floor, the flat in-fight
// value of a pool use the AI had before step 5a. scarcity(left) = min(1, horizon / left): with
// more points left than the horizon's turns can spend (about one a turn), some would go unspent
// this fight, so each is worth less. A pool nothing else spends costs 0 for the one spender that
// can't use it later: the initiative hook (Uncanny Metabolism's own use).
//
// Riders: P(effect) x the effect's value, against the points they cost. On a hit already rolled,
// the extra damage is the attack's damage instance with the rider's dice joined (doubled on a
// crit under riderDiceCritDouble, 2207-2211), capped at the target's HP; the other steps (the
// Stunning Strike save, Open Hand's push or topple) count only if the target survives the
// attack's own damage, and the condition and stat terms come from cond.ts (Stunned on a Stunned
// target adds no rule effect: about 0; on a nearly dead foe it is capped at the turns it lives).
//
// hitTaken (Deflect Attacks, 11154-11158): the damage is already rolled (dp.hit.total), so the
// reduction's exact PMF gives the expected HP saved, E[min(total, R)], and the drop it prevents:
// P(drop) without it (total >= HP + temp HP) less P(total - R >= HP + temp HP), times what a drop
// costs me (killValue + RESCUE, the heal model's figure), plus a concentration save avoided when
// the reduction takes the damage to 0. Against keeping the Reaction: the better of an
// opportunity attack (OA_SHARE of my best one on a hostile in reach: the chance it leaves my
// reach before my next turn) and a later hit: one Reaction stops one hit, so it is the expected
// best saving among the strikes still coming at me before my next turn (each foe acting before
// it, and the attacker's own strikes left in its Attack action), each landing with its hit
// chance (shared among the creatures it could pick) and saving min(E[damage | hit], E[R]);
// E[max] over them taken in descending order (review AI-2, AI-3). A later hit that can't
// exceed this one's saving never outweighs it. Resistance isn't read [U]: the rolled total
// is before it, so a resisted hit's saving is overstated.
//
// HOOKX (Uncanny Metabolism, 11146-11152): refill plus heal against holding it. It works only when
// its bearer rolls Initiative and recovers on a Long Rest; the simulator runs one fight per run with
// no rests (CLAUDE.md rule 4), so a held use buys nothing later: holding is worth 0 and the hook is
// used whenever it does something (Focus spent or HP missing). At full Focus and HP it would do
// nothing, so greedy passes (same fight either way, the use is kept on the sheet).

import type { Step } from '../../content/types.ts';
import type { Weights } from './weights.ts';

/** Chance a hostile in my reach leaves it before my next turn (what keeping a Reaction for an opportunity attack is worth, as a share of that strike). */
export const OA_SHARE = 0.25;
/** Keeping a Reaction for a damage reduction: this share of min(E[reduction], my exposure) when an opportunity attack is offered. */
export const DEFLECT_KEEP = 0.5;

/** Points beyond what the horizon's turns could spend are worth proportionally less. */
export function scarcity(w: Weights, left: number): number {
  return left <= 0 ? 1 : Math.min(1, w.horizon / left);
}

/** Value of gaining (delta > 0) or losing (delta < 0) points of a pool at `left`, each point at `base` x scarcity at its level. */
export function pointsValue(w: Weights, base: number, left: number, delta: number): number {
  let v = 0;
  if (delta > 0) for (let k = 1; k <= delta; k++) v += base * scarcity(w, left + k);
  else for (let k = 0; k < -delta; k++) v -= base * scarcity(w, left - k);
  return v;
}

/** Does a program use a step-5a step (so its pool cost follows this file's model, not the flat poolUse)? */
export function hasEconSteps(steps: readonly Step[]): boolean {
  for (const s of steps) {
    if (s.k === 'weaponAttack' || s.k === 'core' || s.k === 'gainAction' || s.k === 'pool') return true;
    if (s.k === 'choose' && s.opts.some((o) => hasEconSteps(o.steps))) return true;
  }
  return false;
}
