// RIDER and REACT hitTaken (M3 step 5a, docs/design/m3.md section 3, critique C1 and C12).
//
// A rider is something a creature may add when one of its attacks hits, misses or deals damage
// (Stunning Strike, Open Hand Technique). Which attacks a rider takes (weapon, unarmed, spell,
// Monk weapon, melee or ranged, an ability) is decided at compile: the attack lists the riders
// in onHit/onMiss. What is left for the moment of the hit: the strike's granting activation
// (grantedBy), the C1 once-per-turn scopes, the cost, and gates. A usable rider is a 'rider'
// decision (pass first, then one item per option), asked when its trigger is known: a hit or a
// miss right after the attack roll, dealtDamage right after the attack's damage. Its cost is
// paid when chosen. On a hit, its extra damage joins the attack's damage instance (rolled on the
// attack's paired damage stream after the attack's own dice, so those never move; doubled on a
// Critical Hit under riderDiceCritDouble, "Critical Hits", srd-raw.txt:2207-2211: "If the attack
// involves other damage dice, such as from the Rogue's Sneak Attack feature, you also roll those
// dice twice"). Its other steps run after that damage is dealt, against the creature attacked
// (skipped if it died), with saves and their own dice under the 'rider' purpose.
//
// "Once per turn" scopes (C1): perCreature = at most once per creature attacked in each turn;
// global = at most once in each turn, anyone's turn (Stunning Strike, srd-raw.txt:11201-11202:
// "Once per turn when you hit a creature..."); ownTurn = at most once, and only on the bearer's
// own turn. Each "turn" is st.turnIdx, so every scope resets at every turn start.
//
// hitTaken: when an attack roll hits a creature with such a reaction, after the damage is rolled
// and before it's dealt, it may take its Reaction (one until the start of its next turn,
// srd-raw.txt:1438-1439 and 34031-34033, the same budget the pre-roll window uses) to reduce the
// attack's total damage against it (Deflect Attacks, srd-raw.txt:11154-11158: "When an attack
// roll hits you and its damage includes Bludgeoning, Piercing, or Slashing damage, you can take
// a Reaction to reduce the attack's total damage against you"). The reduction is rolled on the
// reactor's own 'hitTaken' stream and applied in sim/damage.ts, before or after Resistance per
// reduceBeforeResistance. Deflect's redirect (reduced to 0, 1 Focus Point, a DEX save) needs
// Total Cover and is printed as unimplemented until step 8.

import type { CompiledAttack, CompiledDamage, CompiledRider, RiderOpt, Step } from '../content/types.ts';
import type { AdvState } from '../rolls/rollspec.ts';
import { ask, emit, evBase, nextSeq, pushLegal, releaseList, takeList, type Ctx } from './context.ts';
import { closeRoll, drawExpr, openRoll } from './dice.ts';
import { countReactPick, countRes, countRiderPick } from './counters.ts';
import type { Cut } from './damage.ts';
import { gatesOk } from './stats.ts';
import { COND, has, type Unit } from './state.ts';
import { newFrame, runSteps } from './steps.ts';
import { seesCell } from './cover.ts';

/**
 * Whether rider `ri` of `a` may be used now on `t` (grant: the activation that made the strike, '' for
 * none). `roll` (W1, P5): the attack roll's resolved Advantage state where the rider rides on one,
 * for the roll-state gates (Sneak Attack, srd-raw.txt:13738-13743); they fail closed without it.
 */
export function riderReady(cx: Ctx, a: Unit, ri: number, t: Unit, grant: string, roll?: AdvState): boolean {
  const st = cx.st;
  const r = a.tpl.riders![ri]!;
  if (r.grantedBy !== undefined && r.grantedBy !== grant) return false;
  if (r.pool >= 0 && a.res[r.pool]! < (r.poolCost ?? 1)) return false;
  if (r.once !== undefined) {
    const base = ri * (1 + st.units.length);
    const rt = a.riderTurn!;
    if (r.once === 'perCreature') {
      if (rt[base + 1 + t.idx] === st.turnIdx) return false;
    } else {
      if (rt[base] === st.turnIdx) return false;
      if (r.once === 'ownTurn' && st.active !== a.idx) return false;
    }
  }
  if (r.when && !gatesOk(st, a, r.when, t, roll)) return false;
  return true;
}

/**
 * Asks about each usable rider in `list` (tpl.riders indices) whose trigger is `on`, in order,
 * and pays for the ones chosen. Appends (rider, option) pairs to `out`. `roll` (W1, P5): the attack
 * roll's resolved Advantage state.
 */
export function askRiders(cx: Ctx, a: Unit, list: readonly number[], on: CompiledRider['on'], t: Unit, atk: CompiledAttack, grant: string, crit: boolean, cause: number, out: number[], roll?: AdvState): void {
  askList(cx, a, list, on, t, atk.id, grant, crit, cause, out, roll);
}

/**
 * Session S (repo half): a rider with spellDamage (on: dealtDamage) when a spell `a` cast dealt
 * damage without an attack roll: each creature in `dealt`, in order, is one dealtDamage trigger
 * (the rider's own scopes, cost and gates decide; "once on each of your turns" is oncePerTurn
 * ownTurn), and the chosen riders run right after, before the next creature's. `via` is the
 * spell's (or its effect's) id. A spell's attack-roll damage reaches its riders through the attack,
 * as any attack's does (sim/attack.ts dealHit).
 */
export function askSpellRiders(cx: Ctx, a: Unit, dealt: readonly number[], via: string, cause: number): void {
  const rs = a.tpl.riders;
  if (!rs) return;
  let list: number[] | null = null;
  for (let ri = 0; ri < rs.length; ri++) if (rs[ri]!.spellDamage) (list ??= []).push(ri);
  if (!list) return;
  for (const ti of dealt) {
    if (cx.st.outcome) return;
    const t = cx.st.units[ti]!;
    const chosen: number[] = [];
    askList(cx, a, list, 'dealtDamage', t, via, '', false, cause, chosen);
    if (chosen.length > 0) runRiders(cx, a, t, chosen, cx.lastDecided);
  }
}

/** Does `a` carry a spellDamage rider (a cheap test before collecting who a spell's damage reached)? */
export function hasSpellRiders(a: Unit): boolean {
  const rs = a.tpl.riders;
  if (!rs) return false;
  for (const r of rs) if (r.spellDamage) return true;
  return false;
}

function askList(cx: Ctx, a: Unit, list: readonly number[], on: CompiledRider['on'], t: Unit, via: string, grant: string, crit: boolean, cause: number, out: number[], roll?: AdvState): void {
  const st = cx.st;
  const riders = a.tpl.riders!;
  for (const ri of list) {
    const r = riders[ri]!;
    if (r.on !== on || t.life === 'dead' || a.life === 'dead' || st.outcome) continue;
    if (!riderReady(cx, a, ri, t, grant, roll)) continue;
    if (r.auto) {
      // M3 step 5b: a rider whose rule isn't a choice (Sap, Vex) is used with no decision. Its
      // cause is what triggered it (the hit, miss or damage), as an asked rider's decision's is.
      cx.lastDecided = cause;
      useRider(cx, a, ri, 0, t);
      out.push(ri, 0);
      continue;
    }
    const l0 = takeList(cx);
    pushLegal(l0, 'pass');
    for (let oi = 0; oi < r.opts.length; oi++) {
      const l = pushLegal(l0, 'pick');
      l.opt = oi;
      l.aux = ri;
    }
    const f = a.tpl.features[r.feature]!;
    const pick = ask(
      cx, a.idx, 'rider', l0, cause,
      (l) => (l.k === 'pass' ? 'pass' : r.chooses ? `rider:${r.local}/${r.opts[l.opt]!.local}` : `rider:${r.local}`),
      undefined,
      { src: { via: f.id, target: t.idx }, hit: { attacker: a.idx, target: t.idx, via, crit, total: -1, types: 0 } },
    );
    const chosen = l0.items[pick]!;
    const oi = chosen.k === 'pick' ? chosen.opt : -1;
    releaseList(cx, l0);
    if (oi < 0) continue;
    useRider(cx, a, ri, oi, t);
    out.push(ri, oi);
  }
}

/** Marks the once-per-turn ledger, pays the cost and logs the use. */
function useRider(cx: Ctx, a: Unit, ri: number, oi: number, t: Unit): void {
  const st = cx.st;
  const r = a.tpl.riders![ri]!;
  if (r.once !== undefined) {
    const base = ri * (1 + st.units.length);
    a.riderTurn![r.once === 'perCreature' ? base + 1 + t.idx : base] = st.turnIdx;
  }
  countRiderPick(st.ctr, a.idx, ri, oi);
  const f = a.tpl.features[r.feature]!;
  const seq = nextSeq(cx);
  if (cx.sink) emit(cx, { ...evBase(cx, seq, cx.lastDecided), k: 'act', who: a.idx, via: f.id, name: r.chooses ? `${r.name}: ${r.opts[oi]!.name}` : r.name });
  if (r.pool >= 0) {
    const cost = r.poolCost ?? 1;
    a.res[r.pool]! -= cost;
    for (let k = 0; k < cost; k++) countRes(st.ctr, a.idx, r.pool);
    const s2 = nextSeq(cx);
    if (cx.sink) emit(cx, { ...evBase(cx, s2, seq), k: 'res', who: a.idx, pool: a.tpl.pools[r.pool - 9]!.name, left: a.res[r.pool]!, ...(cost !== 1 ? { delta: -cost } : {}) });
  }
  cx.lastDecided = seq;
}

/**
 * The extra damage parts of the chosen hit riders (pairs in `chosen`), in order; null when none.
 * W1 (P4): a part of the weapon's type (asAttack: Sneak Attack, "the same as the weapon's type",
 * srd-raw.txt:13739; Frenzy, "the same type as the weapon or Unarmed Strike used", 5177-5178) takes
 * `atkType`, the attack's first part's type as dealt (after an Unarmed Strike's damageType stat).
 */
export function riderExtra(a: Unit, chosen: readonly number[], atkType: number): CompiledDamage[] | null {
  let out: CompiledDamage[] | null = null;
  for (let i = 0; i < chosen.length; i += 2) {
    const o = optOf(a, chosen[i]!, chosen[i + 1]!);
    if (!o.extra) continue;
    out ??= [];
    for (const p of o.extra) {
      if (!p.asAttack) {
        out.push(p);
        continue;
      }
      // Content allows type: weapon only on an on: hit rider; an attack with no damage of its own has no type to give it.
      if (atkType < 0) throw new Error(`${a.tpl.riders![chosen[i]!]!.name}: a part of the attack's type on an attack with no damage type`);
      out.push({ ...p, type: atkType });
    }
  }
  return out;
}

/** Whether the chosen hit riders (pairs) add any extra damage part. */
export function riderHasExtra(a: Unit, chosen: readonly number[]): boolean {
  for (let i = 0; i < chosen.length; i += 2) if (optOf(a, chosen[i]!, chosen[i + 1]!).extra) return true;
  return false;
}

const optOf = (a: Unit, ri: number, oi: number): RiderOpt => a.tpl.riders![ri]!.opts[oi]!;

/** An option that is only a strike at another creature near the one hit (weaponAttack near). */
const nearStrike = (o: RiderOpt): boolean => o.steps.length > 0 && o.steps.every((x) => x.k === 'weaponAttack' && x.near === true);

/** W1 (P10): a step that acts on the attacker alone, never on the creature hit. */
const selfStep = (x: Step): boolean => x.k === 'move' || x.k === 'endConditions' || (x.k === 'apply' && x.to === 'self');
/**
 * W1 (P10): an option every step of which acts on the attacker alone (Cunning Strike's Withdraw:
 * "Immediately after the attack, you move up to half your Speed", srd-raw.txt:13835-13836; its
 * effects come "immediately after the attack's damage is dealt", 13817, whether or not the target lives).
 */
const selfOnly = (o: RiderOpt): boolean => o.steps.length > 0 && o.steps.every(selfStep);

/** Runs the chosen riders' steps against `t` (skipped once it's dead or the fight is over). */
export function runRiders(cx: Ctx, a: Unit, t: Unit, chosen: readonly number[], cause: number): void {
  const riders = a.tpl.riders!;
  for (let i = 0; i < chosen.length; i += 2) {
    if (cx.st.outcome) return;
    const r = riders[chosen[i]!]!;
    const o = r.opts[chosen[i + 1]!]!;
    if (o.steps.length === 0) continue;
    // A step aimed at someone near the creature hit (Cleave's second attack, M3 step 5b) still runs once
    // it died; so does one that acts on the attacker alone (W1, P10: Withdraw after a killing hit).
    if (t.life === 'dead' && !nearStrike(o) && !selfOnly(o)) continue;
    const f = a.tpl.features[r.feature]!;
    const fr = newFrame(a, { via: f.id, name: r.name, cause, targets: [t.idx], purpose: 'rider', savePurpose: 'rider' });
    runSteps(cx, fr, o.steps);
  }
}

/**
 * The hit window: `t`, just hit by `a`'s attack `via` and about to take damage `parts` as
 * rolled, may take its Reaction to reduce it. Returns the reduction, or null.
 */
export function hitTakenWindow(cx: Ctx, a: Unit, t: Unit, via: string, parts: readonly CompiledDamage[], rolled: Int32Array, applies: (i: number) => boolean, crit: boolean, cause: number): Cut | null {
  const st = cx.st;
  if (t.life !== 'up' || t.b.reaction === 0 || has(t, COND.incapacitated)) return null;
  let types = 0;
  let total = 0;
  for (let i = 0; i < parts.length; i++) {
    if (!applies(i)) continue;
    types |= 1 << parts[i]!.type;
    total += rolled[i]!;
  }
  const fs = t.tpl.features;
  let fi = -1;
  for (let i = 0; i < fs.length; i++) {
    const h = fs[i]!.hitTaken;
    if (!h) continue;
    if (h.types !== 0 && (h.types & types) === 0) continue; // "its damage includes Bludgeoning, Piercing, or Slashing damage" (C12)
    if (h.pool >= 0 && t.res[h.pool]! < (h.poolCost ?? 1)) continue;
    // W1 (P11): "an attacker that you can see" (Uncanny Dodge, srd-raw.txt:13840): not while Blinded,
    // and not past a wall that blocks its sight of the attacker's square (sim/cover.ts).
    if (h.sees && (has(t, COND.blinded) || !seesCell(st, t.cell, a.cell, st))) continue;
    fi = i;
    break;
  }
  if (fi < 0) return null;
  const f = fs[fi]!;
  const h = f.hitTaken!;
  const list = takeList(cx);
  pushLegal(list, 'pass');
  pushLegal(list, 'react').opt = fi;
  const pick = ask(cx, t.idx, 'hitTaken', list, cause, (l) => (l.k === 'pass' ? 'pass' : `react:${f.local}`), undefined, {
    src: { via, target: a.idx },
    hit: { attacker: a.idx, target: t.idx, via, crit, total: total < 0 ? 0 : total, types },
  });
  const took = list.items[pick]!.k === 'react';
  releaseList(cx, list);
  if (!took) return null;
  t.b.reaction = 0;
  countReactPick(st.ctr, t.idx, fi);
  if (h.pool >= 0) {
    const cost = h.poolCost ?? 1;
    t.res[h.pool]! -= cost;
    for (let k = 0; k < cost; k++) countRes(st.ctr, t.idx, h.pool);
  }
  let v = 0;
  let slot = -1;
  if (h.reduce !== 'halve') {
    const s = openRoll(st, cx.dice, t.idx, 'hitTaken');
    v = drawExpr(s, h.reduce);
    if (v < 0) v = 0;
    slot = s.slot;
    closeRoll(cx.dice, s);
  }
  const seq = nextSeq(cx);
  if (cx.sink) emit(cx, { ...evBase(cx, seq, cx.lastDecided), k: 'reduce', who: t.idx, att: a.idx, via: f.id, name: f.name, slot, v, ...(h.reduce === 'halve' ? { halve: true as const } : {}) });
  if (h.pool >= 0) {
    const s2 = nextSeq(cx);
    const cost = h.poolCost ?? 1;
    if (cx.sink) emit(cx, { ...evBase(cx, s2, seq), k: 'res', who: t.idx, pool: t.tpl.pools[h.pool - 9]!.name, left: t.res[h.pool]!, ...(cost !== 1 ? { delta: -cost } : {}) });
  }
  return { tgt: t.idx, v, halve: h.reduce === 'halve' };
}
