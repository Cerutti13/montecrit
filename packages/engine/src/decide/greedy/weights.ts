// The greedy AI's tuning (docs/design/m1c.md 1.4). Every term is in EHP: expected hit points of
// value. Reports print a hash of the weights in effect; policies may override any of them.

import { canonicalJson } from '../../util/canon.ts';
import { hash64 } from '../../util/hash.ts';

export interface SideWeights {
  /** Cost per point of damage the unit expects to take before its next turn where it ends. */
  readonly exposure: number;
  /** PC only: extra cost as expected damage nears its HP (piecewise linear, ranking only). */
  readonly dropRisk: number;
  /**
   * Coverage 8'b G3 (M6): how much non-lethal damage is also worth for the foe output it removes
   * (damage / foe HP x foe threat x future(w, rounds left)). PC side only: 0 for monsters and stat-block allies.
   */
  readonly progress: number;
}

/**
 * Coverage 8'b G5 (M6): how a greedy seat picks among the enemies it could hit. `ev` is the argmax
 * of the strike and spell values (every seat's behaviour before this knob); `nearest` and `threat`
 * first narrow to the nearest enemy in reach, or the one that deals the most to me. Printed in the
 * report under the calibration record, so a number says what it was measured under.
 */
export type TargetStyle = 'ev' | 'nearest' | 'threat';

export interface Weights {
  /** Rounds a removed threat or a lasting effect is worth, discounted: F = sum of gamma^k for k < horizon. */
  readonly horizon: number;
  readonly gamma: number;
  /** Cost per foot moved (a tiebreak toward shorter routes). */
  readonly perFoot: number;
  /** A thrown weapon lost (it may not come back this fight). */
  readonly throwAway: number;
  /** Value per 5 ft closer to an enemy it can't attack yet. */
  readonly approach: number;
  /** A move made only to cut exposure must save at least this much. */
  readonly retreatMin: number;
  /** In-fight opportunity cost of resources (no rests: a slot is worth something only inside this fight). */
  readonly slotPerLevel: number;
  readonly freeCast: number;
  readonly poolUse: number;
  /** A pre-roll reaction is used only when it's worth more than this times (4 / uses left): uses are spent more freely while plentiful. */
  readonly reactMin: number;
  /**
   * Coverage 8'b G4 (M7): from this many Dodges running with no HP change on either side, the
   * Dodge term decays by dodgeDecay per further turn [U: measured once, then frozen; build note].
   */
  readonly dodgeStaleAfter: number;
  readonly dodgeDecay: number;
  /** Coverage 8'b G5: see TargetStyle. */
  readonly targetStyle: TargetStyle;
  /**
   * Coverage 8'b G7: what changing what's in hand costs, once per change: the free object
   * interaction it spends, and the turn it takes to change back. Measured once, then frozen
   * (2026-11-08; `node tools/measure-loadout.ts --n 30`, bench L3 and L5): 1 is the smallest cost at
   * which the Barbarian keeps its Greataxe at L1, L3 and L5 (dummy DPR 6.49, 6.04, 14.35 against
   * Handaxes' 5.86, 5.56, 12.91); items per fight fall with it (duel 0.94 at 0, 0.31 at 1, 0.13 at 3)
   * and party wins don't move until 3 (85.6% at 1, 83.6% at 3) [U: this bench only].
   */
  readonly loadoutSwitch: number;
  readonly pc: SideWeights;
  readonly ally: SideWeights;
  readonly monster: SideWeights;
}

export const DEFAULT_WEIGHTS: Weights = {
  horizon: 3,
  gamma: 0.7,
  perFoot: 0.01,
  throwAway: 1,
  approach: 0.5,
  retreatMin: 0.5,
  slotPerLevel: 2,
  freeCast: 1,
  poolUse: 3,
  reactMin: 0.5,
  dodgeStaleAfter: 2,
  dodgeDecay: 0.5,
  targetStyle: 'ev',
  loadoutSwitch: 1,
  pc: { exposure: 1, dropRisk: 25, progress: 1 },
  ally: { exposure: 0.7, dropRisk: 0, progress: 0 },
  monster: { exposure: 0.4, dropRisk: 0, progress: 0 },
};

/**
 * F = sum of (gamma x stay)^k for k < min(horizon, rounds). `stay` (coverage 8'b G6): the chance per
 * round that what's being counted is still running; 1 is the plain discounted horizon.
 */
export function future(w: Weights, rounds = Infinity, stay = 1): number {
  let f = 0;
  let g = 1;
  const n = Math.min(w.horizon, rounds);
  for (let k = 0; k < n; k++) {
    f += g;
    g *= w.gamma * stay;
  }
  return f;
}

/** 8 hex characters over a set of weights (reports, the calibration record). */
export function weightsHash(w: Weights): string {
  return hash64(canonicalJson(w)).slice(0, 8);
}

/**
 * Bumped whenever the greedy AI's choices change under the same weights, so a calibration record
 * (and anything else measured with the AI) can tell it's stale.
 * 1: M1c step 6. 2: moving a zone values everyone the move catches, swept allies included (2026-11-02).
 * 3: picking a dropped focus or shield back up is valued; zone moves under grid-corner anchors (2026-11-02).
 * 4: a heal on a standing creature is also worth the drop chance it removes (itself included); a
 *    concentration spell's value after its first round is scaled by the caster's chance of staying
 *    up; a foe threatens a square with the better of the routines that reach it (2026-11-03).
 * 5: M3 step 5a (econ.ts): the Dodge action is valued (Disadvantage on attacks against it over its
 *    exposure, taken after a worthwhile bonus action), feature strikes, Dash, Disengage, extra
 *    actions, riders, the damage-reducing reaction and the initiative hook are valued; pool points
 *    cost what else they could buy; killValue and allyStrike read conditions; routines honor an
 *    attacker's critMin (2026-11-04).
 * 6: coverage.md 8'b, G1-G7: PCs approach and take the core Dash (with a rescue reachable next
 *    turn), Dodge valued for the time it buys, the PC progress credit, the no-progress decay read
 *    from fight state, `targetStyle`, the lasting-effect term in place of the zone walk, the
 *    loadout as a state, valued hit-known and damage-taken reactions (2026-11-08).
 * 7: coverage.md 7.0b: the Dodge action counts only what the time buys; past that, nothing (2026-11-09).
 * 8: what a move is for (a strike, cast, heal or next turn's action from there; a Dash's walk) is
 *    multiplied by 1 - P(the opportunity attacks the move provokes drop the mover first), exact over
 *    the reactors' odds and damage (oa.ts); the HP cost of those attacks stays. After its review:
 *    every reactor the walk can reach counts, a follow-up at or below 0 isn't discounted, and an
 *    action Disengage's escape decays with the no-HP-change streak (G4's weights) (2026-11-09).
 * 9: coverage step 9: the Search action is valued (P(the check meets a hidden zone's DC) x the
 *    hazard its next path avoids, only with a reason the unit can know: the zone's damage taken
 *    unrecognized, or an ally that saw it; search.ts), and under zoneKnowledge sawCast a zone that
 *    isn't hidden is avoided by anyone who can see a square of it (2026-11-09). After its review:
 *    a hidden zone a unit doesn't know is plain ground to its planning (grid/reach.ts), so the
 *    unknowing route is the one it would walk, priced at its true cost; under
 *    hiddenHazardRevealedByDamage not knowing costs at most one hazard step (the walk stops there);
 *    no value outside sawCast or while Blinded (2026-11-09).
 * 10: coverage step 9+: the declare-time reaction (Redirect Attack) is valued: the attack it moves off
 *    me (exact odds and damage from the RollSpec) less the same attack on the ally where I stand,
 *    both squares' exposure after the swap, less the Reaction kept (an opportunity attack or a later
 *    swap); the opportunity-attack decision holds the Reaction for it while an eligible ally is near
 *    (2026-11-10). Weights unchanged.
 * (10, not bumped: session S's repo half, 2026-11-10, adds terms only content using its new primitives
 *    reads: an `around` step's creatures, the riders an effect switches on through a selfHas gate, a
 *    spellDamage rider on a spell's damage, a spell attack's free riders, and a live turn-end pulse's
 *    move term. No existing choice changes: 0 goldens differ and every decision count is equal in the
 *    perf A/B.)
 * 11: session S follow-up (2026-11-11), only for content whose effect has a turn-end Emanation pulse
 *    (a turnEnd hook with an `around` step) or a selfHas rider: every move offer carries the live
 *    pulse's change there over here (after the move's drop chance), so a retreat counts the pulse it
 *    gives up and a return doesn't earn it again (no walking back and forth); a pulse's later rounds
 *    count its damage without a foe's kill and progress credit (a foe drops once; a downed ally in reach
 *    still counts against every round); a self rider counts no
 *    round whose action is already spent; and an activation that applies a pulse nets out what using
 *    it next turn instead keeps (gamma x P(up) x its value; nothing in the last round), so the Bonus
 *    Action goes to what can't wait. The plan's "engaged exposure" (a foe in reach splits only among
 *    those it reaches without moving) was built and measured: it cost the transformed PC 5 points of
 *    win rate (62.9% vs 68.0%, stars-ambush n 4,000 seed 7) by overpricing standing next to foes that
 *    walk wherever they like, so it was not kept. Weights unchanged; content without those primitives
 *    reads the same.
 */
export const GREEDY_VERSION = 13;
