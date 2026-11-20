// Threat estimates for deciders (docs/design/m1c.md 3.2): what a unit's Attack action is worth
// against an AC, and how much damage a creature standing on a square could take before its
// next turn. Heuristics built from exact per-attack odds; pure and computed fresh on every
// call, so they can't go stale within a round (resolution 17).
//
// Simplifications, stated: weapon and stat-block attacks only (spells don't count yet); a
// straight roll against the AC (no position-based Advantage); an enemy threatens a square in
// melee when it could walk to it and still reach (speed + reach, by grid distance, ignoring
// terrain), and at range when the square is within its normal range; each enemy's damage is
// split across the creatures it threatens. When both of a foe's routines reach a square, the
// better one counts.

import type { CompiledAttack } from '../content/types.ts';
import { distFt, gearReady, hostile } from '../grid/reach.ts';
import { mean } from '../odds/pmf.ts';
import { rollOdds } from '../rolls/rollspec.ts';
import { acNow } from '../sim/hands.ts';
import { oddsFlags, canWield, type QueryState, type Unit } from '../sim/state.ts';
import { damagePmf } from './odds.ts';
import { coverAt, losMode } from '../sim/cover.ts';
import { COVER, COVER_BONUS } from '../grid/los.ts';

/** Expected damage of one attack against AC `ac` on a straight roll. */
export function attackEV(st: QueryState, atk: CompiledAttack, ac: number): number {
  const o = rollOdds({ kind: 'attack', adv: 'none', flat: atk.toHit, preDice: [], critMin: atk.critMin, dc: ac }, oddsFlags(st));
  const hit = mean(damagePmf(atk.damage, null, false, false));
  const crit = mean(damagePmf(atk.damage, null, true, false));
  return (o.pSuccess - o.pCrit) * hit + o.pCrit * crit;
}

export interface ActionEV {
  /** Best Attack-action routine using only melee attacks (0 if none), and only ranged ones. */
  readonly melee: number;
  readonly ranged: number;
  /** Longest usable melee reach and ranged normal range, in feet. */
  readonly reachFt: number;
  readonly rangeFt: number;
}

/** The unit's Attack action against AC `ac`: the best alternative, each group's strikes made with its best usable attack of the kind. */
export function actionEV(st: QueryState, u: Unit, ac: number): ActionEV {
  const atks = u.tpl.attacks;
  // An Attack action's strike may draw its weapon (srd-raw.txt:32707-32712): a sheathed held
  // weapon (M3 step 5b) still threatens (integration fix; before, such a PC threatened nothing).
  // Step E (E2): a monster standing on its own thrown piece threatens with it (gearReady on its
  // own square); a piece elsewhere isn't counted (a written miss).
  const usable = (i: number) => gearReady(st, u, atks[i]!.gear, u.cell) && canWield(u, atks[i]!, true);
  const ev = atks.map((a, i) => (usable(i) ? attackEV(st, a, ac) : 0));
  const best = (kind: 'melee' | 'ranged') => {
    let top = 0;
    for (const alt of u.tpl.attackAct.alts) {
      let sum = 0;
      let ok = true;
      for (const g of alt) {
        let b = -1;
        for (const i of g.from) if (atks[i]!.kind === kind && usable(i) && ev[i]! > b) b = ev[i]!;
        if (b < 0) {
          ok = false;
          break;
        }
        sum += g.count * b;
      }
      if (ok && sum > top) top = sum;
    }
    return top;
  };
  let reachFt = 0;
  let rangeFt = 0;
  atks.forEach((a, i) => {
    if (!usable(i)) return;
    if (a.kind === 'melee' && a.reachFt > reachFt) reachFt = a.reachFt;
    if (a.kind === 'ranged' && a.normalFt > rangeFt) rangeFt = a.normalFt;
  });
  return { melee: best('melee'), ranged: best('ranged'), reachFt, rangeFt };
}

/**
 * How a creature `d` feet away with speed `speedFt` and routines `a` could attack a square on its
 * next turn: in melee after walking, or at range from where it stands. When both reach, the
 * better routine, except within 5 ft, where the shot would have Disadvantage and melee counts.
 */
export function threatKind(d: number, speedFt: number, a: Pick<ActionEV, 'melee' | 'ranged' | 'reachFt' | 'rangeFt'>): 'melee' | 'ranged' | null {
  const m = a.melee > 0 && d <= speedFt + a.reachFt;
  const r = a.ranged > 0 && d <= a.rangeFt;
  // Within 5 ft a ranged attack has Disadvantage (straight-roll EVs can't compare), so melee counts.
  if (m && r) return d > 5 && a.ranged > a.melee ? 'ranged' : 'melee';
  return m ? 'melee' : r ? 'ranged' : null;
}

/** The drop curve the greedy AI ranks with: expected damage `e` against `hp`, piecewise linear in [0, 1]. */
export function pDrop(e: number, hp: number): number {
  return hp > 0 ? Math.min(1, Math.max(0, e / hp - 0.5)) : 1;
}

/** Whether `e` could attack a creature on `cell` on its next turn: in melee after walking, or at range. */
function threatens(st: QueryState, e: Unit, cell: number, a: ActionEV): 'melee' | 'ranged' | null {
  return threatKind(distFt(st, e.cell, cell), e.tpl.speedFt, a);
}

/**
 * Expected damage `me` could take on `cell` before its next turn: for each hostile creature
 * that's up and could attack it there, its best routine against me's AC, divided by the number
 * of my side's creatures it threatens (me counted on `cell`).
 */
export function threatAt(st: QueryState, me: Unit, cell: number): number {
  const s = threatSplitAt(st, me, cell);
  return s.melee + s.ranged;
}

/**
 * `threatAt` split by how the damage arrives: from foes that would walk up and strike, and from
 * foes that would shoot from where they stand. Stepping out of reach moves damage from the first
 * to the second; line of sight and cover (M3 step 8) filter only the second.
 */
export function threatSplitAt(st: QueryState, me: Unit, cell: number): { melee: number; ranged: number } {
  const ac = acNow(me);
  const los = losMode(st);
  let melee = 0;
  let ranged = 0;
  for (const e of st.units) {
    if (e.life !== 'up' || !hostile(e, me)) continue;
    const a = actionEV(st, e, ac);
    let how = threatens(st, e, cell, a);
    if (!how) continue;
    // M3 step 8: a shot from where it stands meets my cover on `cell`: Total rules it out (a walk-up
    // strike may still reach), Half and Three-Quarters raise the AC it rolls against.
    let cov = 0;
    if (how === 'ranged' && los > 0) {
      cov = coverAt(st, e, e.cell, cell, me, null);
      if (cov === COVER.total) {
        how = a.melee > 0 && distFt(st, e.cell, cell) <= e.tpl.speedFt + a.reachFt ? 'melee' : null;
        cov = 0;
        if (!how) continue;
      }
    }
    let victims = 1;
    for (const v of st.units) if (v !== me && v.life === 'up' && v.team === me.team && threatens(st, e, v.cell, a)) victims++;
    if (how === 'melee') melee += a.melee / victims;
    else ranged += (cov > 0 ? actionEV(st, e, ac + COVER_BONUS[cov]!).ranged : a.ranged) / victims;
  }
  return { melee, ranged };
}
