// Coverage step 9 (docs/design/m3.md section 8): what the Search action is worth to the greedy AI.
//
// P(the check meets the hidden zone's DC) x the hazard cost its next path avoids, and only for a
// hidden zone the unit has a reason it can know about: it took that zone's damage without
// recognizing it (fx.seen 2, under hiddenHazardRevealedByDamage=false), or an ally that is up saw
// it appear or recognized it (it cast it, or fx.seen 1). Never from the zone itself: with no reason,
// the value is 0 and Search is never chosen. Only under zoneKnowledge sawCast (where a recognized
// zone changes a route) and never for a Blinded creature. [U] The reason, once there, lets the AI
// read the zone's squares and DC (what the hurt square or the ally's warning would tell it); a stat
// block's Perception and Survival bonuses aren't modeled (sim/d20.ts checkMod), so a monster rolls
// (and is valued at) its plain WIS modifier.

import { cellInfo, computeReach, distFt, forEachLabel, hostile, INF, nextParity, rebuildPath, seesZone, stepCost, type ReachScratch } from '../../grid/reach.ts';
import { checkSpec } from '../../sim/d20.ts';
import { speedNow } from '../../sim/damage.ts';
import { canSearchBySight, SEARCH_ABILITY, searchSkillsOf, unrecognized } from '../../sim/hidden.ts';
import { newModFold } from '../../sim/effects.ts';
import { oddsFlags, readFlag, type QueryState, type Unit } from '../../sim/state.ts';
import { quickOdds } from './odds.ts';

/** Feet of hazard the moveCost of a route prices per known hazard step (greedy.ts moveCost: hazard x 5). */
export const HAZARD_PER_STEP = 5;
/** How far the next path looks (feet of movement, Difficult Terrain counted). */
export const SEARCH_PATH_FT = 300;

export interface SearchValue {
  /** P(success) x avoided. */
  readonly value: number;
  readonly p: number;
  /** What not knowing costs on the next path (all of it, or under hiddenHazardRevealedByDamage at most one hazard step) less the knowing route's cost. */
  readonly avoided: number;
  readonly why: 'hurt' | 'ally';
}

/**
 * The Search action's value for `me` now, or null when it has no reason it can know, nothing in
 * sight to find, or no foe to walk toward. The next path: from here to a square within 5 ft of the
 * nearest standing foe, over SEARCH_PATH_FT however many turns that takes (a hazard at a chokepoint
 * is usually more than a turn's walk away; [U] the horizon is a judgment call). Unknowing, it takes
 * the shortest route it plans without the zones, priced at its true feet and hazard steps;
 * knowing, the cheapest by feet x perFoot + hazard steps x HAZARD_PER_STEP.
 */
export function searchValue(st: QueryState, me: Unit, sc: ReachScratch, perFoot: number): SearchValue | null {
  // Coverage step 9 review: a recognized zone changes a route only under sawCast (under all every
  // zone is known already; under none a recognized one still isn't), and a Blinded creature finds nothing.
  if (readFlag(st, 'zoneKnowledge') !== 'sawCast' || !canSearchBySight(me)) return null;
  let mask = 0;
  let dc = 0;
  let why: 'hurt' | 'ally' | null = null;
  for (let z = 0; z < 32; z++) {
    const id = st.zoneFx[z]!;
    if (id < 0) continue;
    const fx = st.fx[id]!;
    if (!unrecognized(fx, me)) continue;
    const hurt = fx.seen![me.idx] === 2;
    let ally = false;
    if (!hurt) {
      for (const a of st.units) {
        if (a !== me && a.team === me.team && a.life === 'up' && (a.idx === fx.owner || fx.seen![a.idx] === 1)) {
          ally = true;
          break;
        }
      }
    }
    if (!hurt && !ally) continue;
    if (!seesZone(st, me.cell, z)) continue; // a Search finds only what it can see
    mask |= 1 << z;
    dc = Math.max(dc, fx.hdc);
    why = why === 'hurt' || hurt ? 'hurt' : 'ally';
  }
  if (mask === 0 || why === null) return null;
  let foe: Unit | null = null;
  let fd = Infinity;
  for (const t of st.units) {
    if (t.life !== 'up' || !hostile(me, t)) continue;
    const d = distFt(st, me.cell, t.cell);
    if (d < fd || (d === fd && foe !== null && t.idx < foe.idx)) [foe, fd] = [t, d];
  }
  if (!foe || fd <= 5) return null;
  if (speedNow(me, st) <= 0) return null;
  const budget = SEARCH_PATH_FT;
  // Unknowing: the route it plans now (the zones' squares plain ground to it, their hazard
  // uncounted: grid/reach.ts hiddenUnknownZones), the shortest to the foe, priced at what walking
  // it really costs: the true feet (their Difficult Terrain included) and every hazard step.
  computeReach(st, me, budget, sc, 0);
  let uCell = -1;
  let uFt = Infinity;
  let uP = 0;
  let uPar = 0;
  let uHz = 0;
  forEachLabel(st, me, sc, budget, (cell, ft, p, par, hazard) => {
    if (distFt(st, cell, foe.cell) > 5) return;
    if (ft < uFt || (ft === uFt && hazard < uHz)) [uCell, uFt, uP, uPar, uHz] = [cell, ft, p, par, hazard];
  });
  if (uCell < 0) return null;
  const len = rebuildPath(sc, uCell, uP, uPar, uHz);
  const zm = st.zoneMask;
  let from = me.cell;
  let parity = me.b.diagParity;
  let trueFt = 0;
  let hits = 0;
  for (let i = 0; i < len; i++) {
    const to = sc.path[i]!;
    const c = stepCost(st, me, from, to, parity, cellInfo(st, me, to));
    if (c >= INF) return null; // [U] someone stands in the way of the plan; no estimate
    trueFt += c;
    if (zm[to]! & mask & st.travelBits) hits++;
    if (zm[to]! & mask & st.enterBits & ~zm[from]!) hits++;
    parity = nextParity(st, from, to, parity);
    from = to;
  }
  // Knowing: the cheapest route once the zones count (their Difficult Terrain and hazard).
  computeReach(st, me, budget, sc, mask);
  let kCost = Infinity;
  forEachLabel(st, me, sc, budget, (cell, ft, _p, _par, hazard) => {
    if (distFt(st, cell, foe.cell) > 5) return;
    const k = ft * perFoot + hazard * HAZARD_PER_STEP;
    if (k < kCost) kCost = k;
  });
  if (kCost === Infinity) return null;
  const through = trueFt * perFoot + (uHz + hits) * HAZARD_PER_STEP - kCost;
  // Under hiddenHazardRevealedByDamage the first hazard step teaches it (sim/walker.ts stops the
  // walk there and it plans again), so not knowing costs at most that one step [U: an estimate; the
  // way back out isn't priced]. Otherwise it walks the whole route through, still not knowing.
  const avoided = Math.max(0, hits === 0 ? 0 : readFlag(st, 'hiddenHazardRevealedByDamage') ? Math.min(through, HAZARD_PER_STEP) : through);
  if (!(avoided > 0)) return null;
  const fold = newModFold();
  const { spec } = checkSpec(st, me, SEARCH_ABILITY, searchSkillsOf(me, () => readFlag(st, 'searchSkill')), dc, [], [], fold);
  const p = quickOdds(spec, oddsFlags(st)).pSuccess;
  return { value: p * avoided, p, avoided, why };
}
