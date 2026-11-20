// Greedy valuation of M3 step 5b's weapon rules (docs/design/m3.md C8, critique C6): held weapons,
// the Light property's extra attack, Nick, and the 8 Mastery Properties (content/weapons.ts builds
// them as ordinary features, so most of their value comes from the step-4/5a walkers). The
// decider-side terms are in greedy.ts; this file holds the pure structural reads they share.
// SRD 5.2.1 lines are srd-raw.txt.
//
// What each term counts:
//   a strike's masteries  every free rider a strike carries (no pool, no grantedBy, or the
//                 activation making it), at P(hit) for hit and dealtDamage riders and P(miss) for
//                 miss riders, each at its best option (an auto rider at its only one):
//     Graze       (20424-20430) its @mod damage on a miss, capped at the target's HP
//     Cleave      (20360-20367) the second strike (no ability damage) at the best creature within
//                 5 ft of the one hit and in reach, counted even if the first dies; once per turn
//     Push        (20437-20440) the best straight push: zones it crosses, plus its new position for
//                 its next turn (cond.ts placeValue: what it can reach and what my side can reach),
//                 less what it costs my strikes still to come this turn (it may leave my reach)
//     Sap, Vex    (20442-20446, 20463-20467) one roll's token (cond.ts tokenValue)
//     Slow        (20448-20453) the speed stat through reach (cond.ts statsValue; it doesn't stack)
//     Topple      (20455-20461) P(fail) x Prone for one of its turns (cond.ts conditionValue)
//   Light extra   (20339-20349) a use option valued by its strike (a different Light weapon in
//                 hand, no ability damage) against the other bonus-action uses it competes with.
//   Light opener  an Attack-action strike with a Light weapon opens the extra attack: it adds that
//                 extra strike's value, less the best other bonus-action use (a bonus extra attack
//                 would take its place), when nothing else this action could open it.
//   Nick          (20432-20435) the same strike with no Bonus Action spent: it keeps the best
//                 other bonus-action use's value.
//   drawing       a weapon drawn (the free object interaction or the Attack action's equip,
//                 32707-32712) is worth the Light extra attack it makes possible, or an
//                 opportunity attack it arms (OA_SHARE of that strike); strikes in the Attack
//                 action draw for free, so they need no draw first.
//   loadout       coverage 8'b G7 (greedy.ts loadoutValue): the hand configuration is a state. A hand
//                 change now is also worth gamma x the best option next turn in those hands over
//                 these, each counting next turn's one free change, less loadoutSwitch; a strike that
//                 draws its weapon pays one switch over the routine.
//   thrown        a held weapon thrown leaves the hand (20387-20389): throwAway, as a spent dart.

import type { CompiledActivation, CompiledTemplate, RiderOpt, Step } from '../../content/types.ts';
import { activationOf } from '../../sim/cast.ts';
import { boundOf } from '../../sim/effects.ts';
import type { QueryState, Unit } from '../../sim/state.ts';
import type { Legal } from '../decider.ts';

type WeaponAttack = Extract<Step, { k: 'weaponAttack' }>;

/** One activation that makes the Light property's extra attack: its feature, itself, and its strike step. */
export interface LightAct {
  readonly fi: number;
  readonly a: CompiledActivation;
  readonly s: WeaponAttack;
}

/** The activations whose program is a Light extra attack (found by structure, never by id): none for content without held Light weapons. */
export function lightActs(me: Unit): readonly LightAct[] {
  // Perf (W1): a template's list never changes (content is immutable), and payoff asks for it per mod: one per template.
  let out = LIGHT_ACTS.get(me.tpl);
  if (out) return out;
  const list: LightAct[] = [];
  me.tpl.features.forEach((f, fi) => {
    if (!f.activate) return;
    for (const a of [f.activate, ...(f.more ?? [])]) for (const s of a.steps) if (s.k === 'weaponAttack' && s.lightExtra) list.push({ fi, a, s });
  });
  LIGHT_ACTS.set(me.tpl, (out = list));
  return out;
}
const LIGHT_ACTS = new WeakMap<CompiledTemplate, readonly LightAct[]>();

/** Is a Light act usable now by its budget: the Bonus Action (or free, Nick), and its once-per-turn use unspent? */
export function lightActReady(st: QueryState, me: Unit, x: LightAct): boolean {
  if (x.a.cost === 'bonus' ? me.b.bonus <= 0 : x.a.cost !== 'free') return false;
  return !(x.a.perTurn && me.featTurn && me.featTurn[x.fi] === st.turnIdx);
}

/** Is option `l` a Light extra attack (its bonus-action form or a Nick form)? */
export function isLightUse(me: Unit, l: Legal): boolean {
  if (l.k !== 'use' || l.fx >= 0) return false;
  const f = me.tpl.features[l.opt]!;
  return f.activate !== null && activationOf(f, l.aux).steps.some((s) => s.k === 'weaponAttack' && s.lightExtra === true);
}

/** Does option `l` (a cast or a use) spend the Bonus Action? */
export function spendsBonus(st: QueryState, me: Unit, l: Legal): boolean {
  if (l.k === 'cast') return me.tpl.spells[l.opt]!.spell.cast === 'bonus';
  if (l.k !== 'use') return false;
  if (l.fx >= 0) return boundOf(st, st.fx[l.fx]!).grants[l.opt]?.cost === 'bonus';
  const f = me.tpl.features[l.opt]!;
  return f.activate !== null && activationOf(f, l.aux).cost === 'bonus';
}

/** Loading (srd-raw.txt:20355-20358): this Attack action already fired the weapon `item`. */
export function loadedNow(me: Unit, item: number): boolean {
  const atks = me.tpl.attacks;
  for (let i = 0; i < atks.length; i++) if (atks[i]!.item === item && me.b.atkCounts[i]! > 0) return true;
  return false;
}

/** A rider option that is only a strike at a creature near the one hit (Cleave): it runs even when that one dies. */
export function nearStrike(o: RiderOpt): boolean {
  return o.steps.length > 0 && o.steps.every((x) => x.k === 'weaponAttack' && x.near === true);
}
