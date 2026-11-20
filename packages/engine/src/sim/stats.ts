// Gates and stats (M3 step 4: GATE, STAT). Pure reads of live state: no dice, no writes.
//
// A gate is a predicate on the creature an effect sits on (or the one activating an option)
// and, for targetHas, the roll's target. A stat is a number an effect adds to its bearer while
// it lasts; u.stats caches the live ones (sim/effects.ts refreshStats, most potent copy of a
// spell only, p.106), so a creature with none pays one length check per read.
//
// Rules, SRD 5.2.1 (line numbers in the PDF text, srd-raw.txt):
//   Restrained, Paralyzed, Unconscious: "Your Speed is 0 and can't increase" (34075, 33936, 34528).
//   Resistance halves (round down), Vulnerability doubles, instances of either don't stack, and
//   Immunity means no damage of that type (2240-2276): masks OR together.
//   A speed change also changes special speeds (34229-34235); a Fly Speed (M3 step 5a) is the
//   only special speed modeled, and only as feet to spend (no altitude).

import { damageBit, type CompiledAttack, type CompiledStat, type Gate } from '../content/types.ts';
import type { AdvState } from '../rolls/rollspec.ts';
import { distFt } from '../grid/reach.ts';
import { COND, has, lightExtraOpen, type QueryState, type Unit } from './state.ts';

/** Whether `u` holds a shield in either hand. */
function holdsShield(u: Unit): boolean {
  for (let h = 0; h < 2; h++) {
    const i = u.hands[h]!;
    if (i >= 0 && u.tpl.items[i]!.kind === 'shield') return true;
  }
  return false;
}

/**
 * One gate on `u`. `st` is null for a read without the fight's turn (a decider's hypothetical
 * AC): ownTurn is then false. Unknown armor (tpl.armor undefined: a stat block, a kind: pc that
 * doesn't say) fails unarmored and armored alike, closed rather than guessed [U].
 * `roll` (W1, P5): the attack roll's resolved Advantage state where one is known (a rider on that
 * roll); the roll-state gates fail closed without it.
 */
export function gateOk(st: QueryState | null, u: Unit, g: Gate, target: Unit | null, roll?: AdvState): boolean {
  switch (g.g) {
    case 'unarmored':
      return u.tpl.armor === 'none';
    case 'armored':
      return u.tpl.armor === 'light' || u.tpl.armor === 'medium' || u.tpl.armor === 'heavy';
    case 'noShield':
      // A stat block has no item model: its shield, if any, is inside its listed AC [U].
      return !holdsShield(u);
    case 'notIncapacitated':
      return !has(u, COND.incapacitated);
    case 'ownTurn':
      return st !== null && st.active === u.idx;
    case 'hasntMoved':
      // Off its own turn a creature hasn't moved this turn; on it, no voluntary foot spent yet.
      // W1 (P9): a free move (Tactical Shift, Withdraw) counts as moving too: b.freeFt holds its
      // feet when freeMoveUsesMovement=false (otherwise they're in movedFt). Steady Aim's "you
      // haven't moved during this turn" (srd-raw.txt:13792-13793).
      return st === null || st.active !== u.idx || u.b.movedFt + u.b.freeFt === 0;
    case 'targetHas':
      return target !== null && has(target, g.bit);
    case 'allyWithin5ftOfTarget':
      return st !== null && target !== null && allyNear(st, u, target);
    // M3 step 5b, held-item gates.
    case 'shieldHeld':
      return holdsShield(u);
    case 'holding':
      return g.item >= 0 && (u.hands[0] === g.item || u.hands[1] === g.item);
    case 'lightExtra':
      // "When you take the Attack action on your turn and attack with a Light weapon, you can make
      // one extra attack ... later on the same turn" (srd-raw.txt:20341-20343).
      return st !== null && st.active === u.idx && lightExtraOpen(u);
    case 'selfHas':
      // Session S: a live effect of this template, owned by the bearer and on it. Fails closed without state.
      return st !== null && g.fx >= 0 && selfHas(st, u, g.fx);
    case 'notHeavyArmor':
      // W1 (P11): "while you aren't wearing Heavy armor" (Fast Movement, srd-raw.txt:5067-5068; Rage,
      // 4701-4702). Unknown armor fails closed, like unarmored and armored above.
      return u.tpl.armor === 'none' || u.tpl.armor === 'light' || u.tpl.armor === 'medium';
    case 'rollAdv':
      // W1 (P5): the roll as resolved has Advantage. Advantage and Disadvantage together leave
      // neither (srd-raw.txt:1056-1060), so this reads the resolved state, not the sources. No roll: closed.
      return roll === 'adv';
    case 'rollNotDis':
      // W1 (P5): Sneak Attack's "you don't have Disadvantage on the attack roll" (13743). No roll: closed.
      return roll !== undefined && roll !== 'dis';
    case 'anyOf':
      // W1 (P5): at least one list holds in full (one level deep: the schema refuses nesting).
      for (const list of g.any) if (gatesOk(st, u, list, target, roll)) return true;
      return false;
  }
}

/** Session S (coverage S3's minimal form): does `u` bear a live effect it owns, made from its own template effect `fx`? */
export function selfHas(st: QueryState, u: Unit, fx: number): boolean {
  for (const id of u.borne) {
    const f = st.fx[id]!;
    if (f.alive && f.owner === u.idx && f.tpl === fx) return true;
  }
  return false;
}

/**
 * Coverage step 9+, the ally-adjacent gate (Pack Tactics: "if at least one of the tough's allies is
 * within 5 feet of the creature and the ally doesn't have the Incapacitated condition",
 * srd-raw.txt:54928-54931, 55578-55580): a living creature on `u`'s side, not `u` itself (an ally is
 * another creature) and not the target, within 5 ft of `target` and not Incapacitated. A downed
 * creature is Unconscious and so Incapacitated; a dead one is no ally [U: the text says ally, and a
 * corpse takes no part]. Without the fight state (st null: a decider's hypothetical) it fails closed.
 */
export function allyNear(st: QueryState, u: Unit, target: Unit): boolean {
  for (const o of st.units) {
    if (o === u || o === target || o.team !== u.team || o.life === 'dead' || has(o, COND.incapacitated)) continue;
    if (distFt(st, o.cell, target.cell) <= 5) return true;
  }
  return false;
}

export function gatesOk(st: QueryState | null, u: Unit, when: readonly Gate[] | undefined, target: Unit | null = null, roll?: AdvState): boolean {
  if (!when) return true;
  for (const g of when) if (!gateOk(st, u, g, target, roll)) return false;
  return true;
}

/** AC from stats: the template's AC plus `base` (a held shield) plus every ac bonus, then the highest floor. */
export function statAc(st: QueryState | null, u: Unit, base: number): number {
  const ss = u.stats;
  if (ss.length === 0) return base;
  let ac = base;
  let floor = 0;
  for (const { s } of ss) {
    if (s.k === 'ac' && gatesOk(st, u, s.when)) ac += s.n;
    else if (s.k === 'acFloor' && gatesOk(st, u, s.when) && s.n > floor) floor = s.n;
  }
  return ac < floor ? floor : ac;
}

/**
 * Walking speed now. Speed 0 conditions win ("can't increase"); otherwise the template's speed
 * plus every bonus, then zero, then half (round down). Two halvings count once [U: the text
 * gives no order for a bonus and a halving, or for two halvings].
 */
export function speedOf(st: QueryState | null, u: Unit): number {
  if (has(u, COND.unconscious | COND.restrained | COND.paralyzed)) return 0;
  const ss = u.stats;
  if (ss.length === 0) return u.tpl.speedFt;
  let ft = u.tpl.speedFt;
  let fly = 0;
  let zero = false;
  let half = false;
  let keys: string[] | null = null;
  for (const { s } of ss) {
    if (s.k === 'fly') {
      if (s.n > fly && gatesOk(st, u, s.when)) fly = s.n;
      continue;
    }
    if (s.k !== 'speed' || !gatesOk(st, u, s.when)) continue;
    if (s.mode === 'add' && s.noStack !== undefined) {
      // M3 step 5b: changes sharing a noStack key count once, the largest of them (Slow: "the Speed
      // reduction doesn't exceed 10 feet", srd-raw.txt:20451-20453). The first live one adds it.
      if (keys === null) keys = [];
      else if (keys.includes(s.noStack)) continue;
      keys.push(s.noStack);
      ft += largestOfKey(st, u, ss, s.noStack);
      continue;
    }
    if (s.mode === 'add') ft += s.n;
    else if (s.mode === 'zero') zero = true;
    else half = true;
  }
  // A Fly Speed (M3 step 5a): a creature with several speeds may switch between them mid-move,
  // subtracting what it has moved from the new one (srd-raw.txt:34218-34228), so a move has the
  // larger to spend; a Speed change changes the Fly Speed by the same amount (34229-34236). The
  // grid has no altitude: a flier moves over the ground (flyingAvoidsGroundZones = false).
  if (fly > 0) ft = Math.max(ft, fly + (ft - u.tpl.speedFt));
  if (zero || ft <= 0) return 0;
  return half ? Math.floor(ft / 2) : ft;
}

type SpeedStat = Extract<CompiledStat, { k: 'speed' }>;
const sameKey = (x: CompiledStat, key: string): x is SpeedStat => x.k === 'speed' && x.mode === 'add' && x.noStack === key;

/** The change with the largest size among live stats with this key (a penalty if any is one: the larger penalty). */
function largestOfKey(st: QueryState | null, u: Unit, ss: Unit['stats'], key: string): number {
  let best = 0;
  for (const { s } of ss) {
    if (!sameKey(s, key) || !gatesOk(st, u, s.when)) continue;
    if (Math.abs(s.n) > Math.abs(best)) best = s.n;
  }
  return best;
}

export interface Defenses {
  resist: number;
  vuln: number;
  immune: number;
}

/** Damage-type masks now: the template's, OR every resist/vuln/immune stat. Writes `out` and returns it. */
export function defensesOf(st: QueryState | null, u: Unit, out: Defenses): Defenses {
  out.resist = u.tpl.resist;
  out.vuln = u.tpl.vuln;
  out.immune = u.tpl.immune;
  for (const { s } of u.stats) {
    if ((s.k !== 'resist' && s.k !== 'vuln' && s.k !== 'immune') || !gatesOk(st, u, s.when)) continue;
    out[s.k] |= s.mask;
  }
  return out;
}

/** The lowest natural that crits for `atk`: the attack's own, or a critMin stat for weapon attacks and Unarmed Strikes (never spell attacks). */
export function critMinOf(st: QueryState | null, u: Unit, atk: CompiledAttack, target: Unit | null): number {
  let c = atk.critMin;
  if (atk.spell || u.stats.length === 0) return c;
  for (const { s } of u.stats) if (s.k === 'critMin' && s.n < c && gatesOk(st, u, s.when, target)) c = s.n;
  return c;
}

/** W1 (P2): the bearer can't cast spells (a noCasting stat: Rage, "you can't cast spells", srd-raw.txt:4981). */
export function noCasting(st: QueryState | null, u: Unit): boolean {
  for (const { s } of u.stats) if (s.k === 'noCasting' && gatesOk(st, u, s.when)) return true;
  return false;
}

/** W1 (P2): the bearer can't maintain Concentration (a noConcentration stat: Rage, srd-raw.txt:4980). */
export function noConcentration(st: QueryState | null, u: Unit): boolean {
  for (const { s } of u.stats) if (s.k === 'noConcentration' && gatesOk(st, u, s.when)) return true;
  return false;
}

/** The bearer can't make Opportunity Attacks (a noOpportunityAttacks stat). */
export function noOpportunityAttacks(st: QueryState | null, u: Unit): boolean {
  for (const { s } of u.stats) if (s.k === 'noOpportunityAttacks' && gatesOk(st, u, s.when)) return true;
  return false;
}

/**
 * The damage type an Unarmed Strike by `a` deals to `t` for a part of type `type`: its own, or
 * a damageType stat's, whichever `t` defends against least (immune < resist < plain < vulnerable,
 * ranked by what the part would deal); ties keep the part's own type (C13, Empowered Strikes'
 * "Force damage or its normal damage type", srd-raw.txt:11212-11215).
 */
export function unarmedTypeFor(st: QueryState | null, a: Unit, t: Unit, type: number, scratch: Defenses): number {
  if (a.stats.length === 0) return type;
  const d = defensesOf(st, t, scratch);
  const rank = (ty: number): number => {
    const bit = damageBit(ty);
    if (d.immune & bit) return 0;
    const r = d.resist & bit ? 1 : 2;
    return d.vuln & bit ? r * 2 : r;
  };
  let best = type;
  let bestRank = rank(type);
  for (const { s } of a.stats) {
    if (s.k !== 'damageType' || !gatesOk(st, a, s.when, t)) continue;
    const r = rank(s.type);
    if (r > bestRank) {
      best = s.type;
      bestRank = r;
    }
  }
  return best;
}

// ---- condition queries the grid needs (sim/conditions.ts has the rest, with cites) ----

/** The cells of the living sources of `u`'s fear, for "can't willingly move closer" (33478-33479); empty when it isn't Frightened. */
export function fearCells(st: QueryState, u: Unit, out: number[]): number[] {
  out.length = 0;
  if (!has(u, COND.frightened)) return out;
  for (const c of u.conds) {
    if (c.bit !== COND.frightened || c.src < 0) continue;
    const s = st.units[c.src]!;
    if (s.life !== 'dead' && !out.includes(s.cell)) out.push(s.cell);
  }
  return out;
}

/** `u` is Charmed by `other` (Can't Harm the Charmer, 32957-32959). */
export function charmedBy(u: Unit, other: Unit): boolean {
  if (!has(u, COND.charmed)) return false;
  for (const c of u.conds) if (c.bit === COND.charmed && c.src === other.idx) return true;
  return false;
}

