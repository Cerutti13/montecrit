// Conditions content imposes (M3 step 4, COND): what each one does to d20 tests, speed,
// actions and targeting, and how a condition step puts one on a creature.
//
// Every rule is plain code with its SRD 5.2.1 Rules Glossary line (the PDF text, srd-raw.txt):
//   Blinded     32738-32744  attack rolls against it have Advantage, its attack rolls have
//                            Disadvantage; it fails checks that need sight [U: no check in a
//                            fight says whether it needs sight yet, so that part isn't applied]
//   Charmed     32957-32961  it can't attack the charmer or target the charmer with damaging
//                            abilities or magical effects [U: read as "damaging (abilities or
//                            magical effects)"; a harmless effect may still target the charmer]
//   Frightened  33472-33479  Disadvantage on ability checks and attack rolls while the source of
//                            fear is in line of sight (LOS is stubbed: while the source lives);
//                            it can't willingly move closer to the source (grid/reach.ts)
//   Incapacitated 33650-33660 no action, Bonus Action or Reaction; Concentration breaks
//                            (already core: sim/options.ts, sim/effects.ts onIncapacitated)
//   Paralyzed   33929-33943  Incapacitated; Speed 0 and can't increase; fails STR and DEX saves;
//                            attack rolls against it have Advantage; a hit from within 5 ft is a
//                            Critical Hit
//   Poisoned    33945-33947  Disadvantage on attack rolls and ability checks
//   Prone       34010-34019  (core since M1a) crawl or stand; Disadvantage on its attacks;
//                            Advantage within 5 ft, Disadvantage beyond
//   Restrained  34072-34079  Speed 0 and can't increase; attack rolls against it have
//                            Advantage, its attack rolls have Disadvantage; Disadvantage on DEX saves
//   Stunned     34372-34379  Incapacitated; fails STR and DEX saves; attack rolls against it have
//                            Advantage (the 2024 text gives it no Speed rule)
//   Unconscious 34523-34535  (core since M1a; content since coverage step 7.4) Incapacitated and
//                            Prone, drops what it holds; when it ends the creature stays Prone
//                            (34525-34527); Speed 0; attack rolls against it have Advantage;
//                            fails STR and DEX saves; a hit from within 5 ft is a Critical Hit
//   Dodge       33369-33376  (M3 step 5a, the Dodge action) until the start of your next turn,
//                            attack rolls against you have Disadvantage if you can see the
//                            attacker (sight is stubbed: always), and you make DEX saves with
//                            Advantage; you lose these benefits while Incapacitated or at Speed 0
//                            [U: read as suspended while that holds, back if it ends before your
//                            next turn starts; the text says "lose", not "end"]
//   Immunity    2271-2276    "Immunity to a condition means you aren't affected by it": it blocks
//                            the condition being applied [U: gaining an immunity later doesn't
//                            end a condition already there]
//   Ending one  5183-5184    (W1, P11: Mindless Rage's "If you're Charmed or Frightened when you
//                            enter your Rage, the condition ends on you") an endConditions step:
//                            the condition ends, not whatever else imposed it (endConditions below)

import { seesCell } from './cover.ts';
import type { Id, Step } from '../content/types.ts';
import { emit, evBase, nextSeq, type Ctx } from './context.ts';
import { boundOf, condOffEvents, endFx, newFx, onIncapacitated } from './effects.ts';
import { dropHeld } from './hands.ts';
import { expiryOf, type Frame } from './steps.ts';
import { addCond, COND, condId, has, refreshMask, type Expiry, type QueryState, type Unit } from './state.ts';
import { speedOf } from './stats.ts';

/** The Dodge action's benefits hold now: it's dodging, not Incapacitated, Speed above 0 (33369-33376). */
export function dodgeHolds(st: QueryState | null, u: Unit): boolean {
  return has(u, COND.dodging) && !has(u, COND.incapacitated) && speedOf(st, u) > 0;
}

/**
 * Attack rolls against `u` have Disadvantage from its Dodge: the benefits hold and it can see the
 * attacker (33372-33374, "if you can see the attacker"). Blinded means it can't see (32741), so a
 * Blinded dodger gives none. Other sight (Invisible, darkness, LOS) is stubbed.
 */
export function dodgeImposesDis(st: QueryState | null, u: Unit): boolean {
  return dodgeHolds(st, u) && !has(u, COND.blinded);
}

/** Attack-roll Advantage and Disadvantage from conditions (beyond Prone and Unconscious, which attack.ts keeps). */
export function attackCondSources(st: QueryState, a: Unit, t: Unit, adv: string[], dis: string[]): void {
  const am = a.condMask;
  const tm = t.condMask;
  if (((am | tm) & (COND.blinded | COND.frightened | COND.paralyzed | COND.poisoned | COND.restrained | COND.stunned | COND.dodging)) === 0) return;
  if (tm & COND.dodging && dodgeImposesDis(st, t) && seesCell(st, t.cell, a.cell, null)) dis.push('core:target-dodging'); // 33372-33374; Blinded can't see, nor through walls (M3 step 8)
  if (tm & COND.blinded) adv.push('core:target-blinded'); // 32742-32743
  if (tm & COND.paralyzed) adv.push('core:target-paralyzed'); // 33939-33940
  if (tm & COND.restrained) adv.push('core:target-restrained'); // 34076-34077
  if (tm & COND.stunned) adv.push('core:target-stunned'); // 34378-34379
  if (am & COND.blinded) dis.push('core:attacker-blinded'); // 32742-32743
  if (am & COND.frightened && fearInSight(st, a)) dis.push('core:attacker-frightened'); // 33475-33477
  if (am & COND.poisoned) dis.push('core:attacker-poisoned'); // 33946-33947
  if (am & COND.restrained) dis.push('core:attacker-restrained'); // 34076-34077
}

/** A hit from within 5 ft is a Critical Hit: Unconscious (34533-34535) and Paralyzed (33941-33943). */
export function autoCritWithin5(t: Unit): boolean {
  return has(t, COND.unconscious | COND.paralyzed);
}

/** Saving throws: automatic failure on STR and DEX for Unconscious, Paralyzed and Stunned (34531-34532, 33937-33938, 34376-34377). */
export function autoFailsSave(u: Unit, ab: number): boolean {
  return (ab === 0 || ab === 1) && has(u, COND.unconscious | COND.paralyzed | COND.stunned);
}

/** Save Advantage and Disadvantage from conditions: Restrained on DEX saves (34078-34079), the Dodge action on DEX saves (33374-33375). */
export function saveCondSources(st: QueryState | null, u: Unit, ab: number, adv: string[], dis: string[]): void {
  if (ab !== 1) return;
  if (has(u, COND.restrained)) dis.push('core:restrained');
  if (has(u, COND.dodging) && dodgeHolds(st, u)) adv.push('core:dodging');
}

/** Ability-check Disadvantage from conditions: Poisoned (33946-33947), Frightened with its source in sight (33475-33477). */
export function checkCondSources(st: QueryState, u: Unit, dis: string[]): void {
  if (has(u, COND.poisoned)) dis.push('core:poisoned');
  if (has(u, COND.frightened) && fearInSight(st, u)) dis.push('core:frightened');
}

/** Is a source of `u`'s fear in line of sight (33475-33477)? A living one that walls don't hide (M3 step 8, sim/cover.ts). */
function fearInSight(st: QueryState, u: Unit): boolean {
  for (const c of u.conds) if (c.bit === COND.frightened && c.src >= 0 && st.units[c.src]!.life !== 'dead' && seesCell(st, u.cell, st.units[c.src]!.cell, null)) return true;
  return false;
}

/** Does a program deal damage (an attack, a damage step, a save with damage), for the Charmed targeting limit? */
export function programDamages(steps: readonly Step[]): boolean {
  for (const s of steps) {
    switch (s.k) {
      case 'attack':
      case 'damage':
        return true;
      case 'save':
        if (s.dmg || programDamages(s.onFail) || programDamages(s.onSuccess)) return true;
        break;
      case 'choose':
        if (s.opts.some((o) => programDamages(o.steps))) return true;
        break;
      default:
        break;
    }
  }
  return false;
}

/** COND bits `u` is immune to now: its template's and every live effect it bears. */
export function condImmunity(st: QueryState, u: Unit): number {
  let m = u.tpl.condImmune ?? 0;
  for (const id of u.borne) {
    const f = st.fx[id]!;
    if (f.alive) m |= boundOf(st, f).condImmune ?? 0;
  }
  return m;
}

/**
 * A condition step on every living target. Each gets the condition's own effect (an Fx on the
 * target, under the frame's root when there is one, so it ends with the concentration, form or
 * zone that imposed it, and at its until), whose CondInstances end with it (sim/effects.ts
 * endFx). Prone instead gets a plain instance that lasts until the creature rights itself
 * (34014-34016). An immune target is skipped (2273-2276), with everything the instance brings
 * (`also`, a Speed stat, the drop: "While Charmed", 28141-28142); for Stunned, Paralyzed and an
 * `also`, immunity to Incapacitated leaves that part off [U].
 *
 * Unconscious also brings the plain Prone instance, which stays when it ends (34525-34527): its
 * own instances end with its effect, and a downed creature's (`core:downed`) are its own.
 */
export function imposeCondition(cx: Ctx, fr: Frame, step: Extract<Step, { k: 'condition' }>): void {
  const st = cx.st;
  const owner = fr.owner;
  for (const ti of fr.targets) {
    const t = st.units[ti]!;
    if (t.life === 'dead') continue;
    const immune = condImmunity(st, t);
    if (immune & step.bit) continue;
    if (step.fx < 0) {
      if (addCond(t, step.bit, fr.via, owner.idx, fr.cause, { k: 'never' })) condOn(cx, t, step.bit, fr.via, fr.cause);
      continue;
    }
    const te = owner.tpl.effects[step.fx]!;
    const fx = newFx(cx, { tpl: step.fx, owner: owner.idx, bearer: ti, parent: fr.root, param: -1, srcItem: fr.srcItem, until: expiryOf(te, owner, t), cause: fr.cause });
    fr.lastFx = fx.id;
    const until: Expiry = { k: 'effect', effect: fx.id };
    const bits = (te.cond ?? 0) & ~immune;
    let gainedIncap = false;
    for (let bit = 1; bit <= bits; bit <<= 1) {
      if (!(bits & bit)) continue;
      if (addCond(t, bit, te.id, owner.idx, fx.cause, until)) {
        condOn(cx, t, bit, te.id, fr.cause);
        if (bit === COND.incapacitated) gainedIncap = true;
      }
    }
    if (step.bit === COND.unconscious && !(immune & COND.prone) && !has(t, COND.prone) && addCond(t, COND.prone, fr.via, owner.idx, fr.cause, { k: 'never' })) condOn(cx, t, COND.prone, fr.via, fr.cause);
    if (step.dropHeld) dropHeld(cx, t, fr.cause);
    // Incapacitated breaks Concentration and ends forms that end on it (33657). Already
    // Incapacitated (downed) means that already happened.
    if (gainedIncap) onIncapacitated(cx, t, fr.cause);
  }
}

/**
 * W1 (P11), the endConditions step: the conditions in `bits` end on `u` ("the condition ends on
 * you", Mindless Rage, srd-raw.txt:5183-5184). The condition ends, not the whole effect that imposed
 * it:
 * - a condition step's own effect (BoundEffect.cond) that carries only conditions in `bits` ends
 *   whole (its repeat save and escape go with it), logged as dismissed;
 * - an effect that also carries other conditions (an `also`, the Incapacitated a Stunned brings)
 *   stays, losing only the instances in `bits`;
 * - every other instance in `bits` (a plain Prone, one tied to a turn) is removed.
 * Each condition that ended is one cond event with via `via`, or the ended effect's id. Nothing to
 * end: no seq, no event. [U] An effect whose conditions are all ended this way but which does more
 * (stats, mods) can't arise: a condition step's effect carries only the condition's own parts.
 */
export function endConditions(cx: Ctx, u: Unit, bits: number, via: Id, cause: number): void {
  if ((u.condMask & bits) === 0) return;
  const st = cx.st;
  for (let i = 0; i < u.borne.length; i++) {
    const f = st.fx[u.borne[i]!]!;
    if (!f.alive) continue;
    const c = boundOf(st, f).cond;
    if (c === undefined || (c & bits) === 0 || (c & ~bits) !== 0) continue;
    endFx(cx, f.id, 'dismissed', cause);
    i = -1; // borne changed under us: rescan
  }
  const before = u.condMask;
  for (let i = u.conds.length - 1; i >= 0; i--) if (u.conds[i]!.bit & bits) u.conds.splice(i, 1);
  refreshMask(u);
  condOffEvents(cx, u, before & ~u.condMask, via, cause);
}

function condOn(cx: Ctx, t: Unit, bit: number, via: Id, cause: number): void {
  const seq = nextSeq(cx);
  if (cx.sink) emit(cx, { ...evBase(cx, seq, cause), k: 'cond', who: t.idx, cond: condId(bit), on: true, via });
}
