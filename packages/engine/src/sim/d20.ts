// Every d20 test in a fight (attack rolls, saves, death saves, checks) goes through rollD20,
// so each one gets the same windows in the same order:
//
//   0. coverage step 9+, the declare-time window (attack rolls only, declaredWindow below, called by
//      sim/attack.ts rollAttack before the roll is built): reactions to "a creature ... makes an
//      attack roll against it" that change who the attack is against (Redirect Attack's swap,
//      srd-raw.txt:48831-48834). It comes first because the RollSpec (AC, cover, Advantage) is the
//      new target's; the pre-roll window below then sees the roll as it will be made.
//   1. the pre-roll window: reactions to a creature that "is about to make" a D20 Test
//      (their dice come from their own streams and arrive as extDice values; M1b step 11)
//   2. one stream for the roll: every die drawn, then the roll closes
//   3. the after-roll window, reserved for M8 (Cutting Words, Bardic Inspiration): it sits
//      between drawing and deciding, so it can change the total before success is known
//   4. settle: naturals, floor, total, success
//   5. M3 step 8'a, the hit-known window (attack rolls only): once a hit is known and before any
//      damage is rolled, the creature hit may take a Reaction that raises its AC against that
//      attack (Shield: "+5 bonus to AC, including against the triggering attack",
//      srd-raw.txt:30659-30670; Parry: "adds 2 to its AC against that attack, possibly causing it
//      to miss", 50631-50633). If the total no longer reaches the new AC the attack misses, unless
//      it hit regardless of AC (a natural 20, "the attack hits regardless of any modifiers or the
//      target's AC", 991-993; an expanded crit under expandedCritAutoHits).
//
// Initiative doesn't come through here: nothing reacts to it yet, and it's printed as
// unimplemented wherever a pre-roll reaction could have applied.

import { checkKey, RK } from '../content/rollkeys.ts';
import type { ExprNode } from '../dice/expr.ts';
import type { Purpose } from '../rng/stream.ts';
import { autoOutcome, resolveAdvantage, settleRoll, type RollResult, type RollSpec } from '../rolls/rollspec.ts';
import type { RuleFlags } from '../rules/flags.ts';
import { distFt } from '../grid/reach.ts';
import { ask, emit, evBase, nextSeq, pushLegal, releaseList, takeList, type Ctx } from './context.ts';
import { closeRoll, drawD20, drawExpr, openRoll } from './dice.ts';
import { consumeRiders, foldMods, type ModFold } from './effects.ts';
import { countReactPick, countRes } from './counters.ts';
import { autoFailsSave, checkCondSources, saveCondSources } from './conditions.ts';
import { acNow } from './hands.ts';
import { seesCell } from './cover.ts';
import { newFrame, runSteps } from './steps.ts';
import { swapPlaces } from './swap.ts';
import { COND, has, markFlag, useFlag, type QueryState, type Unit } from './state.ts';

const NO_DICE: readonly ExprNode[] = [];

/**
 * Query: the RollSpec for `u`'s saving throw with roll key `key` against `dc`, with every
 * effect modifier folded in (a d20 floor, a d4, Advantage sources). Writes only adv, dis, f.
 * `targetAdv`: the save step's own Advantage (coverage step 7.4, Charm Person); the resolution and
 * the AI's odds both pass it, so they read one model (hard rule 6).
 */
export function saveSpec(st: QueryState, u: Unit, key: number, dc: number, adv: string[], dis: string[], f: ModFold, targetAdv?: true): RollSpec {
  const ab = ((key & RK.AB) >> RK.AB_SHIFT) - 1;
  if (targetAdv) adv.push('core:save-advantage');
  saveCondSources(st, u, ab, adv, dis); // Restrained: Disadvantage on DEX saves (M3 step 4); Dodge: Advantage (5a)
  foldMods(st, u, null, key, adv, dis, f);
  return {
    kind: 'save',
    adv: resolveAdvantage(adv, dis),
    flat: (ab >= 0 ? u.tpl.saveMod[ab]! : 0) + f.flat,
    preDice: f.pre.length > 0 ? f.pre.slice() : NO_DICE,
    floor: f.floor > 0 ? f.floor : undefined,
    // Unconscious (SRD 5.2.1 p.191), Paralyzed and Stunned: automatically fail STR and DEX saves.
    autoFail: autoFailsSave(u, ab) ? true : undefined,
    dc,
  };
}

/** A check's modifier: the best of `skills` (SKILLS indices; a PC's skillMod has proficiency and Expertise in it), or the plain ability modifier. */
export function checkMod(u: Unit, ability: number, skills: readonly number[]): { readonly mod: number; readonly skill: number } {
  const plain = Math.floor((u.tpl.scores[ability]! - 10) / 2);
  // A stat block's skill bonuses aren't modeled (tpl.skillMod is all 0): its checks use the ability modifier [U].
  if (u.tpl.kind !== 'pc' || skills.length === 0) return { mod: plain, skill: skills.length > 0 ? skills[0]! : -1 };
  let best = skills[0]!;
  for (const sk of skills) if (u.tpl.skillMod[sk]! > u.tpl.skillMod[best]!) best = sk;
  return { mod: u.tpl.skillMod[best]!, skill: best };
}

/**
 * Query (M3 step 4, check): the RollSpec for `u`'s ability check with `ability` and the best of
 * `skills` against `dc`, with conditions (Poisoned, Frightened) and effect modifiers folded in.
 * Its roll key is checkKey(ability, skill), so a skill modifier and an ability one both match.
 * Writes only adv, dis, f. An ability check has no automatic success or failure on a natural
 * 1 or 20 unless natOnChecksAndSaves says so (rollspec.ts).
 */
export function checkSpec(st: QueryState, u: Unit, ability: number, skills: readonly number[], dc: number, adv: string[], dis: string[], f: ModFold): { readonly spec: RollSpec; readonly key: number } {
  const m = checkMod(u, ability, skills);
  const key = checkKey(ability, m.skill);
  checkCondSources(st, u, dis);
  foldMods(st, u, null, key, adv, dis, f);
  return {
    key,
    spec: {
      kind: 'check',
      adv: resolveAdvantage(adv, dis),
      flat: m.mod + f.flat,
      preDice: f.pre.length > 0 ? f.pre.slice() : NO_DICE,
      floor: f.floor > 0 ? f.floor : undefined,
      dc,
    },
  };
}

export interface D20Roll extends RollResult {
  /** The roll's slot in its (roller, purpose) bucket; damage pairs with it. */
  readonly slot: number;
  /** M3 step 8'a: AC the target added in the hit-known window (success and crit already account for it); undefined when none. */
  readonly acUp?: number;
}

/** What a roll is against, for the pre-roll decision (an AI weighs "the goblin attacking my downed ally"). */
export interface RollAbout {
  readonly target: number;
  readonly via: string;
}

/**
 * Rolls a d20 test. `fold` is what built the spec: after an attack roll, the one-use riders
 * it folded in (an incoming "next attack has Advantage") are spent.
 */
export function rollD20(cx: Ctx, roller: Unit, spec: RollSpec, key: number, purpose: Purpose, flags: RuleFlags, cause: number, fold?: { adv: readonly string[]; dis: readonly string[]; f: ModFold }, about?: RollAbout): D20Roll {
  const st = cx.st;
  const ext = st.watchD20 > 0 ? preRollWindow(cx, roller, spec, key, cause, about) : undefined;
  const s = openRoll(st, cx.dice, roller.idx, purpose);
  const draw = drawD20(spec, s, ext);
  const slot = s.slot;
  closeRoll(cx.dice, s);
  const r = settleRoll(spec, draw, flags);
  // A natural 1 or 20 on a check or save decided the outcome only if natOnChecksAndSaves
  // could have flipped it. Death saves have their own 1/20 rule and never read the flag.
  const kind = key & RK.KIND;
  if (kind !== RK.attack && !(key & RK.death)) {
    const flips = (r.natural === 20 && r.total < spec.dc) || (r.natural === 1 && r.total >= spec.dc);
    if (flips) markFlag(st, 'natOnChecksAndSaves');
  }
  if (fold && fold.f.riders.length > 0) consumeRiders(cx, fold.f.riders, fold.adv, fold.dis, cause);
  if (st.watchHitKnown > 0 && kind === RK.attack && r.success && about && about.target >= 0) {
    const up = hitKnownWindow(cx, roller, st.units[about.target]!, spec, key, r, about.via, cause);
    if (up > 0) {
      const hits = autoOutcome(spec, r.natural, flags) === 'pass' || r.total >= spec.dc + up;
      return { ...r, success: hits, crit: hits && r.crit, slot, acUp: up };
    }
  }
  return { ...r, slot };
}

/**
 * The hit-known window: `t`, just hit by `roller`'s attack roll (`key`, from `via`), may take its
 * Reaction with one of its hitKnown features whose attack kinds match, paying its pool. Its steps
 * run on `t` first (Shield's AC effect), then its own `ac` is added against this attack only.
 * Returns the AC added against this attack (0 when it passes or has nothing to take).
 */
function hitKnownWindow(cx: Ctx, roller: Unit, t: Unit, spec: RollSpec, key: number, r: RollResult, via: string, cause: number): number {
  const st = cx.st;
  if (t === roller || t.life !== 'up' || has(t, COND.incapacitated) || t.b.reaction === 0) return 0;
  const kindBit = key & RK.melee ? 1 : key & RK.ranged ? 2 : 0;
  const fs = t.tpl.features;
  const list = takeList(cx);
  pushLegal(list, 'pass');
  for (let fi = 0; fi < fs.length; fi++) {
    const h = fs[fi]!.hitKnown;
    if (!h || !(h.attacks & kindBit) || (h.pool >= 0 && t.res[h.pool]! < (h.poolCost ?? 1))) continue;
    pushLegal(list, 'react').opt = fi;
  }
  if (list.n === 1) {
    releaseList(cx, list);
    return 0;
  }
  const pick = ask(cx, t.idx, 'hitKnown', list, cause, (l) => (l.k === 'pass' ? 'pass' : `react:${fs[l.opt]!.local}`), undefined, {
    roll: spec, roller: roller.idx, rollTarget: t.idx, rollVia: via,
    src: { via, target: roller.idx },
    hit: { attacker: roller.idx, target: t.idx, via, crit: r.crit, total: r.total, types: 0 },
  });
  const chosen = list.items[pick]!;
  const fi = chosen.k === 'react' ? chosen.opt : -1;
  releaseList(cx, list);
  if (fi < 0) return 0;
  const f = fs[fi]!;
  const h = f.hitKnown!;
  t.b.reaction = 0;
  countReactPick(st.ctr, t.idx, fi);
  const seq = nextSeq(cx);
  if (cx.sink) emit(cx, { ...evBase(cx, seq, cx.lastDecided), k: 'act', who: t.idx, via: f.id, name: f.name });
  payReaction(cx, t, h.pool, h.poolCost ?? 1, seq);
  const before = acNow(t, st);
  if (h.steps.length > 0) {
    const s = openRoll(st, cx.dice, t.idx, 'reaction');
    runSteps(cx, newFrame(t, { via: f.id, name: f.name, cause: seq, targets: [t.idx], stream: s, purpose: 'reaction', savePurpose: 'reaction' }), h.steps);
    closeRoll(cx.dice, s);
  }
  return acNow(t, st) - before + h.ac;
}

/**
 * M3 step 8'a, the damage-taken window (a trigger-queue handler, sim/triggers.ts): `t` just took
 * `dealt` damage from creature `from` and may take its Reaction with a damageTaken feature, when
 * it can see that creature (walls block sight, sim/cover.ts) within the feature's range (Hellish
 * Rebuke: "in response to taking damage from a creature that you can see within 60 feet of
 * yourself", srd-raw.txt:27953-27955). The feature's steps run with that creature as the target,
 * their dice on t's own 'reaction' stream. [U] damage a zone or lasting effect deals counts as
 * from its owner, as everywhere else (DamageSource.unit).
 */
export function damageTakenWindow(cx: Ctx, t: Unit, dealt: number, from: number, cause: number): void {
  const st = cx.st;
  if (from < 0 || from === t.idx || t.life !== 'up' || has(t, COND.incapacitated) || t.b.reaction === 0) return;
  const src = st.units[from]!;
  if (src.life === 'dead') return;
  const fs = t.tpl.features;
  const d = distFt(st, t.cell, src.cell);
  let sees = -1; // read once, and only when some feature is in range
  const list = takeList(cx);
  pushLegal(list, 'pass');
  for (let fi = 0; fi < fs.length; fi++) {
    const h = fs[fi]!.damageTaken;
    if (!h || d > h.rangeFt || (h.pool >= 0 && t.res[h.pool]! < (h.poolCost ?? 1))) continue;
    if (sees < 0) sees = seesCell(st, t.cell, src.cell, st) ? 1 : 0;
    if (sees === 0) break;
    pushLegal(list, 'react').opt = fi;
  }
  if (list.n === 1) {
    releaseList(cx, list);
    return;
  }
  const pick = ask(cx, t.idx, 'damageTaken', list, cause, (l) => (l.k === 'pass' ? 'pass' : `react:${fs[l.opt]!.local}`), undefined, {
    src: { via: '', target: from },
    hit: { attacker: from, target: t.idx, via: '', crit: false, total: dealt, types: 0 },
  });
  const chosen = list.items[pick]!;
  const fi = chosen.k === 'react' ? chosen.opt : -1;
  releaseList(cx, list);
  if (fi < 0) return;
  const f = fs[fi]!;
  const h = f.damageTaken!;
  t.b.reaction = 0;
  countReactPick(st.ctr, t.idx, fi);
  const seq = nextSeq(cx);
  if (cx.sink) emit(cx, { ...evBase(cx, seq, cx.lastDecided), k: 'act', who: t.idx, via: f.id, name: f.name });
  payReaction(cx, t, h.pool, h.poolCost ?? 1, seq);
  const s = openRoll(st, cx.dice, t.idx, 'reaction');
  runSteps(cx, newFrame(t, { via: f.id, name: f.name, cause: seq, targets: [from], stream: s, purpose: 'reaction', savePurpose: 'reaction' }), h.steps);
  closeRoll(cx.dice, s);
}

/**
 * Coverage step 9+, the declare-time window: `t` is about to have an attack roll made against it by
 * `roller` (attack `via`). If `t` has a declared reaction (Redirect Attack: "Trigger: A creature the
 * goblin can see makes an attack roll against it. Response: The goblin chooses a Small or Medium ally
 * within 5 feet of itself. The goblin and that ally swap places, and the ally becomes the target of
 * the attack instead", srd-raw.txt:48831-48834), is up, not Incapacitated, has its Reaction, and can
 * see the attacker (walls block sight, sim/cover.ts; Blinded sees nothing, srd-raw.txt:32740-32742),
 * it may spend its Reaction to swap with an eligible ally: a living creature on its side, not the
 * attacker [U: an ally attacking it can't be made its own target], of the reaction's size or smaller,
 * within its range. Returns the attack's target after the window: `t`, or the ally.
 *
 * The retarget keeps the attack's square: the ally now stands where `t` stood, so range, reach and
 * the line from the attacker are what they were (walls never move); the roll is then built against
 * the ally there (its AC, its cover from creatures as they now stand, its conditions). One window per
 * attack roll: the ally's own declared reaction isn't offered for the same roll [U: the trigger was the
 * roll against `t`; nothing says a retarget is a new one].
 */
export function declaredWindow(cx: Ctx, roller: Unit, t: Unit, via: string, cause: number): Unit {
  const st = cx.st;
  if (t === roller || t.life !== 'up' || has(t, COND.incapacitated) || t.b.reaction === 0) return t;
  const fs = t.tpl.features;
  let fi = -1;
  for (let i = 0; i < fs.length; i++) if (fs[i]!.declared) fi = fi < 0 ? i : fi;
  if (fi < 0) return t;
  const d = fs[fi]!.declared!;
  if (has(t, COND.blinded) || !seesCell(st, t.cell, roller.cell, st)) return t;
  // Each square must hold only the two that swap: passing through a creature's space mid-move, `t`
  // would leave the ally on a square it shares (a creature can't end in another's space, SRD 5.2.1
  // p.14) [U: no rule says what a swap from a shared square does, so none is offered].
  if (!aloneOn(st, t, t.cell, t)) return t;
  const list = takeList(cx);
  pushLegal(list, 'pass');
  for (const o of st.units) {
    if (o === t || o === roller || o.team !== t.team || o.life === 'dead' || o.tpl.size < d.swapMinSize || o.tpl.size > d.swapMaxSize) continue;
    if (o.cell === t.cell || distFt(st, t.cell, o.cell) > d.swapRangeFt || !aloneOn(st, o, o.cell, t)) continue;
    const l = pushLegal(list, 'react');
    l.opt = fi;
    l.target = o.idx;
  }
  if (list.n === 1) {
    releaseList(cx, list);
    return t;
  }
  markFlag(st, 'diagonalCost'); // "within 5 feet" was measured with it
  const f = fs[fi]!;
  const pick = ask(cx, t.idx, 'attackDeclared', list, cause, (l) => (l.k === 'pass' ? 'pass' : `react:${f.local}>${st.units[l.target]!.seat}`), undefined, {
    roller: roller.idx, rollTarget: t.idx, rollVia: via,
    src: { via, target: roller.idx },
  });
  const chosen = list.items[pick]!;
  const ally = chosen.k === 'react' ? chosen.target : -1;
  releaseList(cx, list);
  if (ally < 0) return t;
  t.b.reaction = 0;
  countReactPick(st.ctr, t.idx, fi);
  const seq = nextSeq(cx);
  if (cx.sink) emit(cx, { ...evBase(cx, seq, cx.lastDecided), k: 'act', who: t.idx, via: f.id, name: f.name });
  const o = st.units[ally]!;
  swapPlaces(cx, t, o, f.id, f.name, seq);
  return o;
}

/** No living creature but `u` (and `skip`) stands on `cell`. */
function aloneOn(st: QueryState, u: Unit, cell: number, skip: Unit): boolean {
  for (const o of st.units) if (o !== u && o !== skip && o.life !== 'dead' && o.cell === cell) return false;
  return true;
}

/** A reaction's pool cost (hitKnown, damageTaken), with its res event. */
export function payReaction(cx: Ctx, u: Unit, pool: number, cost: number, cause: number): void {
  if (pool < 0) return;
  const st = cx.st;
  u.res[pool]! -= cost;
  for (let k = 0; k < cost; k++) countRes(st.ctr, u.idx, pool);
  const seq = nextSeq(cx);
  if (cx.sink) emit(cx, { ...evBase(cx, seq, cause), k: 'res', who: u.idx, pool: u.tpl.pools[pool - 9]!.name, left: u.res[pool]!, ...(cost !== 1 ? { delta: -cost } : {}) });
}

/**
 * The window before a creature's D20 Test: anyone with a pre-roll reaction in range may spend
 * its Reaction and a use to roll a die into the total. Candidates are polled in initiative
 * order after the active unit (it comes last); with two or more, the active unit orders them
 * (simultaneous effects, p.187). Each die is drawn from the reactor's own 'react' stream and
 * added to spec.extDice, so the exact odds see it and the roller's dice never move.
 */
function preRollWindow(cx: Ctx, roller: Unit, spec: RollSpec, key: number, cause: number, about?: RollAbout): number[] | undefined {
  const st = cx.st;
  const kindBit = 1 << (key & RK.KIND);
  const reactors: Unit[] = [];
  const feats: number[] = [];
  const N = st.order.length;
  for (let k = 1; k <= N; k++) {
    const r = st.units[st.order[(st.orderPos + k) % N]!]!;
    if (r.life !== 'up' || has(r, COND.incapacitated) || r.b.reaction === 0) continue;
    const fs = r.tpl.features;
    for (let fi = 0; fi < fs.length; fi++) {
      const pr = fs[fi]!.preRoll;
      if (!pr || !(pr.kinds & kindBit) || r.res[pr.pool]! <= 0) continue;
      if (r === roller) {
        if (pr.self === 'no') continue;
        if (pr.self === 'textSilent' && useFlag(st, 'selfTargetWhenTextSilent') === 'notAllowed') continue;
      } else if (distFt(st, r.cell, roller.cell) > pr.rangeFt) continue;
      reactors.push(r);
      feats.push(fi);
      break;
    }
  }
  if (reactors.length === 0) return undefined;
  if (reactors.length > 1) orderReactors(cx, reactors, feats, cause);
  let ext: number[] | undefined;
  for (let i = 0; i < reactors.length; i++) {
    const r = reactors[i]!;
    const f = r.tpl.features[feats[i]!]!;
    const pr = f.preRoll!;
    const list = takeList(cx);
    pushLegal(list, 'pass');
    if (pr.sign === 0) {
      pushLegal(list, 'react').aux = 1;
      pushLegal(list, 'react').aux = -1;
    } else pushLegal(list, 'react').aux = pr.sign;
    const pick = ask(
      cx, r.idx, 'preRoll', list, cause,
      (l) => (l.k === 'pass' ? 'pass' : `react:${f.local}${pr.sign === 0 ? (l.aux > 0 ? '+' : '-') : ''}`),
      undefined,
      { roll: spec, roller: roller.idx, rollTarget: about ? about.target : -1, rollVia: about ? about.via : '' },
    );
    const chosen = list.items[pick]!;
    const sign = chosen.k === 'react' ? chosen.aux : 0;
    releaseList(cx, list);
    if (sign === 0) continue;
    r.b.reaction = 0;
    r.res[pr.pool]!--;
    countRes(st.ctr, r.idx, pr.pool);
    const s = openRoll(st, cx.dice, r.idx, 'react');
    const v = drawExpr(s, pr.die);
    const slot = s.slot;
    closeRoll(cx.dice, s);
    spec.extDice = [...(spec.extDice ?? []), sign > 0 ? pr.die : { k: 'neg', a: pr.die }];
    (ext ??= []).push(sign * v);
    const seq = nextSeq(cx);
    if (cx.sink) emit(cx, { ...evBase(cx, seq, cx.lastDecided), k: 'react', who: r.idx, roller: roller.idx, via: f.id, name: f.name, slot, v: sign * v, left: r.res[pr.pool]! });
  }
  return ext;
}

/** The active unit picks which reactor goes next until one is left; rewrites both arrays in place. */
function orderReactors(cx: Ctx, reactors: Unit[], feats: number[], cause: number): void {
  const st = cx.st;
  const who = st.active >= 0 ? st.active : reactors[0]!.idx;
  const pr = reactors.slice();
  const pf = feats.slice();
  reactors.length = 0;
  feats.length = 0;
  while (pr.length > 0) {
    let pick = 0;
    if (pr.length > 1) {
      const list = takeList(cx);
      for (const r of pr) pushLegal(list, 'order').target = r.idx;
      pick = ask(cx, who, 'orderTriggers', list, cause);
      releaseList(cx, list);
    }
    reactors.push(pr[pick]!);
    feats.push(pf[pick]!);
    pr.splice(pick, 1);
    pf.splice(pick, 1);
  }
}
