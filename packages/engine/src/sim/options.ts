// What a unit may do right now. Queries only: no dice, no state writes (the reach scratch
// they fill is engine scratch, not state). The order is canonical, so the same state always
// gives the same list:
//   pass; attacks by attack index then target idx; options in template order; casts in
//   spell-entry order (free, then by slot level); granted options by effect id; feature
//   activations; dismissals; items; stand; moves by destination cell, then parity, then provokes;
//   then the core Dodge action (M3 step 5a: appended, so nothing before it moves).

import { searchOffered } from './hidden.ts';
import type { AttackGroup } from '../content/types.ts';
import type { LegalList } from '../decide/decider.ts';
import { computeReach, distFt, forEachLabel, gearOk, gearReady, hostile } from '../grid/reach.ts';
import { pushLegal, resetList, type Ctx } from './context.ts';
import { listCasts, listEnds, listFeatures, listGrants } from './cast.ts';
import { listItems } from './hands.ts';
import { speedNow } from './damage.ts';
import { canWield, COND, has, useFlag, type GameState, type QueryState, type Unit } from './state.ts';
import { charmedBy } from './stats.ts';
import { targetable } from './cover.ts';

/**
 * Whether `t` is in range of attack `ai` from `fromCell` and not behind Total Cover (M3 step 8:
 * "can't be targeted directly", srd-raw.txt:2028-2032; walls only, sim/cover.ts). `mark` records
 * the flag at a resolution site.
 */
export function inRange(st: QueryState, a: Unit, ai: number, t: Unit, fromCell: number, mark: GameState | null = null): boolean {
  const atk = a.tpl.attacks[ai]!;
  const d = distFt(st, fromCell, t.cell);
  return (atk.kind === 'melee' ? d <= atk.reachFt : d <= atk.longFt) && targetable(st, fromCell, t.cell, mark);
}

/**
 * Whether the strikes counted in `counts` fit `alt`: each strike assigned to a group that
 * lists its attack and still has room. Small backtracking (<= 8 strikes, <= 4 groups).
 */
export function canPack(alt: readonly AttackGroup[], counts: Uint8Array): boolean {
  const room = alt.map((g) => g.count);
  const strikes: number[] = [];
  for (let a = 0; a < counts.length; a++) for (let k = 0; k < counts[a]!; k++) strikes.push(a);
  const place = (i: number): boolean => {
    if (i === strikes.length) return true;
    for (let g = 0; g < alt.length; g++) {
      if (room[g]! === 0 || !alt[g]!.from.includes(strikes[i]!)) continue;
      room[g]!--;
      if (place(i + 1)) return true;
      room[g]!++;
    }
    return false;
  };
  return place(0);
}

/** Bitmask of the alternatives in `alts` that can hold `counts`. */
export function liveAlts(alts: readonly (readonly AttackGroup[])[], counts: Uint8Array, among: number): number {
  let m = 0;
  for (let i = 0; i < alts.length; i++) if (among & (1 << i) && canPack(alts[i]!, counts)) m |= 1 << i;
  return m;
}

export function allAlts(u: Unit): number {
  return (1 << u.tpl.attackAct.alts.length) - 1;
}

/** Whether one more strike with attack `ai` fits the unit's Attack action (started or not). `tmp` is scratch, at least attacks.length long. */
export function canExtend(u: Unit, ai: number, tmp: Uint8Array): boolean {
  const n = u.tpl.attacks.length;
  const counts = tmp.subarray(0, n);
  if (u.b.atkActive) counts.set(u.b.atkCounts);
  else counts.fill(0);
  counts[ai]!++;
  const among = u.b.atkActive ? u.b.atkLive : allAlts(u);
  return liveAlts(u.tpl.attackAct.alts, counts, among) !== 0;
}

/**
 * Moving is offered whenever movement is left. Under moveBetweenAttacks=extraAttackOnly,
 * moving in the middle of a Multiattack gives up its remaining strikes (act.ts).
 */
export function canMoveNow(st: QueryState, u: Unit): boolean {
  return u.b.moveFt > 0 && speedNow(u, st) > 0;
}

/**
 * M3 step 5b, Loading: "You can fire only one piece of ammunition from a Loading weapon when you
 * use an action, a Bonus Action, or a Reaction to fire it, regardless of the number of attacks
 * you can normally make" (srd-raw.txt:20355-20358): this Attack action already fired it.
 */
function loadedThisAction(u: Unit, item: number): boolean {
  const atks = u.tpl.attacks;
  for (let i = 0; i < atks.length; i++) if (atks[i]!.item === item && u.b.atkCounts[i]! > 0) return true;
  return false;
}

export function listOptions(cx: Ctx, u: Unit, out: LegalList): LegalList {
  const st = cx.st;
  resetList(out);
  pushLegal(out, 'pass');
  const b = u.b;
  const incap = has(u, COND.incapacitated);
  const charmed = has(u, COND.charmed);
  if (!incap && (b.atkActive || b.action > 0)) {
    const attacks = u.tpl.attacks;
    for (let ai = 0; ai < attacks.length; ai++) {
      // An Attack action's strike may draw its weapon first (M3 step 5b, canWield's draw), and
      // (step E, E2) a monster's may pick its own thrown piece up off its square (gearReady).
      if (!gearReady(st, u, attacks[ai]!.gear, u.cell) || !canWield(u, attacks[ai]!, true) || !canExtend(u, ai, cx.sc.counts)) continue;
      if (attacks[ai]!.loading && b.atkActive && loadedThisAction(u, attacks[ai]!.item!)) continue;
      for (const t of st.units) {
        if (t === u || !hostile(u, t) || t.life === 'dead' || !inRange(st, u, ai, t, u.cell, st)) continue;
        if (charmed && charmedBy(u, t)) continue; // Charmed: can't attack the charmer (srd-raw.txt:32957-32958)
        const l = pushLegal(out, 'attack');
        l.atk = ai;
        l.target = t.idx;
      }
    }
  }
  if (!incap) {
    const opts = u.tpl.options;
    for (let oi = 0; oi < opts.length; oi++) {
      const o = opts[oi]!;
      if (o.cost === 'action' ? b.action > 0 : b.bonus > 0) pushLegal(out, 'option').opt = oi;
    }
  }
  listCasts(cx, u, out);
  listGrants(cx, u, out);
  listFeatures(cx, u, out);
  listEnds(cx, u, out);
  if (!incap) listItems(st, u, out);
  const speed = speedNow(u, st);
  if (has(u, COND.prone) && speed > 0 && b.moveFt >= Math.floor(speed / 2)) pushLegal(out, 'stand');
  if (canMoveNow(st, u)) {
    const sc = cx.sc.reachEngine;
    // Which zones count as hazards depends on zoneKnowledge whenever a hazard zone it didn't create is live.
    if ((st.enterBits | st.travelBits) !== 0) {
      for (let z = 0; z < 32; z++) {
        const id = st.zoneFx[z]!;
        if (id >= 0 && (st.enterBits | st.travelBits) & (1 << z) && st.fx[id]!.owner !== u.idx) {
          useFlag(st, 'zoneKnowledge');
          break;
        }
      }
    }
    computeReach(st, u, b.moveFt, sc);
    forEachLabel(st, u, sc, b.moveFt, (cell, ft, provokes, parity, hazard) => {
      const l = pushLegal(out, 'move');
      l.cell = cell;
      l.ft = ft;
      l.provokes = provokes;
      l.parity = parity;
      l.hazard = hazard;
    });
  }
  // The core Dodge action (M3 step 5a, srd-raw.txt:33369-33376), last in the list so every
  // earlier item keeps its index: only deciders that know it ever pick it.
  if (!incap && b.action > 0) pushLegal(out, 'dodge');
  // Coverage step 9: the core Search action (srd-raw.txt:34116-34118), after Dodge, only while a
  // hidden zone it hasn't recognized is live (sim/hidden.ts), so no other list changes.
  if (!incap && b.action > 0 && searchOffered(st, u)) pushLegal(out, 'search');
  return out;
}

/**
 * Reaction choices for reactor `r` as `mover` leaves its reach from `from`: decline, or an
 * opportunity attack with any single melee attack that reaches `from` (a monster's
 * Multiattack can't be used; the Unarmed Strike always can).
 */
export function listReactions(cx: Ctx, r: Unit, mover: Unit, from: number, out: LegalList): LegalList {
  const st = cx.st;
  resetList(out);
  pushLegal(out, 'pass');
  const d = distFt(st, r.cell, from);
  const attacks = r.tpl.attacks;
  // M3 step 8: the attack is made at `from` ("right before it leaves your reach", srd-raw.txt:2096-2099), so Total Cover there rules it out.
  const clear = targetable(st, r.cell, from, st);
  for (let ai = 0; ai < attacks.length; ai++) {
    const atk = attacks[ai]!;
    if (!clear || atk.kind !== 'melee' || atk.reachFt < d || !gearOk(st, r, atk.gear) || !canWield(r, atk)) continue;
    const l = pushLegal(out, 'oa');
    l.atk = ai;
    l.target = mover.idx;
  }
  return out;
}
