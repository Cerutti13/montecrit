// The greedy one-ply AI (docs/design/m1c.md 1). One decider drives every seat; units differ
// by their legal lists and their side's weights (PC, ally, monster). It draws no dice and
// reads the fight only through pure queries, so it never changes what it decides about.
//
// A turn decision is scored fresh each time it's asked (no plan carried between decisions):
// each offered option, and each shortlisted move scored as "move there, then do the best thing
// available from there", minus what the move risks (opportunity attacks, known hazards) and
// what ending there exposes the unit to. After the action, the same scoring picks a retreat,
// the bonus action or pass. Ties: scores are quantized to milli-EHP, then the earlier item in
// the legal list (whose order is canonical), a total order independent of scoring order.
//
// Spells, features and granted options are valued by walking their programs (value.ts), from
// where the creature stands and from its safest destinations. The choices inside them (target,
// place, pick, pull) are answered by the same valuation, so a cast does what it was chosen for;
// a pull follows the path planned at its first step. Pre-roll reactions are valued exactly from
// the roll's odds with and without the die.

import { CoverMemo } from './memo.ts';
import type { BoundEffect, CompiledActivation, CompiledAttack, CompiledDamage, CompiledFeature, CompiledRider, CompiledTemplate, Gate, RiderOpt, SpellEntry, Step } from '../../content/types.ts';
import { DAMAGE_TYPES, HOOK } from '../../content/types.ts';
import { hasSpellRiders } from '../../sim/riders.ts';
import { isLightUse, lightActReady, lightActs, loadedNow, nearStrike, spendsBonus, type LightAct } from './weapons.ts';
import { exprPmf, type ExprNode } from '../../dice/expr.ts';
import { saveKey } from '../../content/rollkeys.ts';
import { rollOdds, type AdvState } from '../../rolls/rollspec.ts';
import { boundOf } from '../../sim/effects.ts';
import type { AimCand } from '../../query/area.ts';
import type { ForcedPath } from '../../query/forced.ts';
import { aimCandidates, appliesPulse, auraDragValue, bestPull, chooseValues, harmOf, healReach, lastingPerRound, livePulse, moveZoneAnchorValue, programValue, pulseValue, zoneAnchors, zoneHoldValue, zoneValue, type VCtx } from './value.ts';
import { canReactAgainst, computeReach, distFt, FIELD_NONE, forEachLabel, gearOk, gearReady, hostile, newReachScratch, oaReach, pieceAt, piecesOf, terrainFieldFt, type ReachScratch } from '../../grid/reach.ts';
import { TERR } from '../../grid/cells.ts';
import { convolve, mean, probAtLeast, type Pmf } from '../../odds/pmf.ts';
import { damagePmf, expectedCapped } from '../../query/odds.ts';
import { pDrop, threatAt, threatKind } from '../../query/threat.ts';
import { buildAttackSpecFor } from '../../sim/attack.ts';
import { coverAgainst, coverAt, losMode, targetable } from '../../sim/cover.ts';
import { COVER, COVER_BONUS } from '../../grid/los.ts';
import { activationOf, componentsOk, poolCostOf } from '../../sim/cast.ts';
import { newLegal } from '../../sim/context.ts';
import { autoCritWithin5, dodgeImposesDis } from '../../sim/conditions.ts';
import { acNow, heldHand, ITEM } from '../../sim/hands.ts';
import { anchorDistFt } from '../../grid/area.ts';
import { oddsFlags, readFlag, canWield, COND, HAND, has, lightExtraOpen, lightStackSpare, type QueryState, type Unit } from '../../sim/state.ts';
import type { Decider, DecisionPoint, Legal, UnitView } from '../decider.ts';
import { quickOdds, type QuickOdds } from './odds.ts';
import { searchValue } from './search.ts';
import { canPack } from '../../sim/options.ts';
import { afterDrop, dropLoss, oaDropChance, type OaStrike } from './oa.ts';
import { clearRiderMemo, condNames, MODE, modPerRound, newRiderMemo, placeValue, programLabels, TERM } from './cond.ts';
import { dropSafe, riderAttack, selfOnlyOption, typedExtra, w1Kit } from './w1.ts';
import { speedNow } from '../../sim/damage.ts';
import { charmedBy, critMinOf, defensesOf, gatesOk, type Defenses } from '../../sim/stats.ts';
import { DEFAULT_WEIGHTS, future, type SideWeights, type Weights } from './weights.ts';
import { DEFLECT_KEEP, hasEconSteps, OA_SHARE, pointsValue } from './econ.ts';

/** A unit's Attack action against one AC: best routine of melee-only and of ranged-only strikes, its reach and range. */
interface Routine {
  readonly melee: number;
  readonly ranged: number;
  readonly reachFt: number;
  readonly rangeFt: number;
}

/** What one hostile threatens this decision: its routines against the decider's AC, and how many of the decider's side it can reach. */
interface Foe {
  readonly u: Unit;
  readonly r: Routine;
  readonly victims: number;
  /** Its walking speed now (speedNow: Speed 0 conditions, speed stats), and whether it's Frightened of the decider (it can't walk up to it, SRD 5.2.1 srd-raw.txt:33478-33479). */
  readonly speed: number;
  readonly fearMe: boolean;
}

/** M3 step 4's content conditions (sim/state.ts COND bits 16 and up): a unit with none reads exactly as before (C3). */
const CONTENT_CONDS = COND.blinded | COND.charmed | COND.frightened | COND.paralyzed | COND.poisoned | COND.restrained | COND.stunned;
/** Its attack rolls have Disadvantage (Blinded 32742-32743, Poisoned 33946-33947, Restrained 34076-34077; Frightened is checked with its source). */
const ATTACKER_DIS = COND.blinded | COND.poisoned | COND.restrained;
/** Attack rolls against it have Advantage (Blinded, Paralyzed 33939-33940, Restrained, Stunned 34378-34379). */
const TARGET_ADV = COND.blinded | COND.paralyzed | COND.restrained | COND.stunned;

/**
 * Unconscious on a creature that's up (Sleep; attack rolls against it have Advantage, srd-raw.txt:34529-34530).
 * A downed creature has the bit too, and its strikes read as they always did.
 */
const asleep = (d: Unit): boolean => d.life === 'up' && (d.condMask & COND.unconscious) !== 0;

/** Does `u` carry a resist/vuln/immune stat (M3 step 4)? Only then are its defenses read into foes' routines (C3: inert otherwise). */
function defStats(u: Unit): boolean {
  for (const { s } of u.stats) if (s.k === 'resist' || s.k === 'vuln' || s.k === 'immune') return true;
  return false;
}

/** Is `u` Frightened of `src`, or of any living source when `src` is null (sight stubbed)? */
function frightened(st: QueryState, u: Unit, src: Unit | null): boolean {
  if (!has(u, COND.frightened)) return false;
  for (const c of u.conds) if (c.bit === COND.frightened && c.src >= 0 && (src ? c.src === src.idx : st.units[c.src]!.life !== 'dead')) return true;
  return false;
}

interface Move {
  readonly i: number; // legal index
  readonly cell: number;
  readonly ft: number;
  readonly cost: number; // opportunity-attack risk + hazard + feet
  readonly oaRisk: number;
  /** Greedy v8: P(the opportunity attacks this move provokes drop me before I act); 0 when it provokes none. */
  readonly pDrop: number;
}

/** One scored term of an option (design 1.8). */
export interface ExplainPart {
  readonly term: string;
  readonly ev: number;
}

/** A turn decision's top options with their breakdowns: plain data, recorded only when an explain sink is attached. */
export interface ExplainRecord {
  readonly at: number;
  readonly who: number;
  /** The key it chose, and why when the choice skipped the scoring (standing up, a Dash or Disengage first). */
  readonly chosen: string;
  readonly note: string;
  /** Options scored, and the best three (highest first). */
  readonly scored: number;
  readonly top: readonly { readonly key: string; readonly ev: number; readonly parts: readonly ExplainPart[] }[];
}

const Q = (x: number) => Math.floor(x * 1000);
/** Getting a downed creature back up (value.ts RESCUE): what a drop costs on top of its killValue. */
const RESCUE = 10;
/** What the turn decision knows that a program's Dash and extra-action terms need (M3 step 5a, econ.ts); null off the turn decision. */
interface TurnCtx {
  readonly view: UnitView;
  readonly moves: readonly Move[];
  readonly canAttack: boolean;
  readonly engaged: boolean;
  /** Greedy v13 (G1a): each attack's strikes this Attack action (strikesFor), by attack index. */
  readonly strikes: Int8Array;
  readonly hereCost: number;
}
/** Greedy v13 (stepE-plan 5): see strikePlan. */
interface StrikePlan {
  readonly n: Int8Array;
  readonly later: readonly (Uint8Array | null)[];
  readonly masked: boolean;
}
/** About what one hit does: turns expected damage into expected hits (concentration saves). */
const HIT = 6;
/**
 * Coverage 8'b, M9 fallback (2): G1's exact next-turn strike is scored only on this many
 * destinations, the nearest to a target; the rest get the strike after next turn's move.
 * Measured, then frozen (2026-11-08; `node tools/measure-approach-k.ts`), every greedy seat at k
 * against every destination scored, identical log hashes: the bench's dummy-range and party setups
 * for all 12 classes at L3 and L5, 20 fights each (960): k = 0, 1, 2, 4, 8, 16, 32 gave 953, 954,
 * 954, 959, 960, 960, 960, with no speed trend across k; stars-ambush, monk-ambush and ambush-probe,
 * 200 fights each: 200 of 200 at every k, including 0. 8 is the smallest k equal everywhere; frozen
 * at 16 for the margin, since it costs nothing measurable. The cap buys no speed on these cases.
 */
export const APPROACH_TOP_K = 16;
/**
 * Coverage 8'b review (ai-logic-2): EHP per 5 ft of closing on the nearest standing hostile, for a PC
 * with nothing to do next turn from anywhere it can walk to. A tie-break: only just over a step's own
 * `perFoot` (0.05 per 5 ft), so any provoke, hazard or rise in exposure outweighs it, and it applies
 * only when no strike, rescue or spell has a value to compare it with.
 */
export const CLOSE_TIE = 0.06;

/** The Explain line of G3's credit. */
const DODGE_TERM = 'Dodge: attacks against it have Disadvantage';
/** Coverage step 9: the Search action's Explain line. */
const SEARCH_TERM = 'Search: P(it recognizes the hidden zone) x the hazard its next path then avoids';
const CLOSING_TERM = 'closing in: nothing in reach by next turn from any square, so the nearest foe';
/**
 * Greedy v12 (stalemate-plan 4.1 C): the Explain line when a downed body in reach would otherwise
 * have counted as engagement for a non-PC under attackDowned ifNoOtherTarget.
 */
export const DOWNED_FREE_TERM = "a downed body in reach doesn't hold me while a standing hostile is up (attackDowned ifNoOtherTarget)";
const RESCUE_NOW_TERM = 'rescue this turn: walk in range, then the heal on a downed ally (RESCUE)';
/** Coverage step 7.6: over any routine a monster has (a weight would move the weights hash; this is the book's order, not a tuned value). */
const BOOK_FIRST = 1000;
/** Greedy v8: the follow-up's value times P(the move's opportunity attacks drop me before I act). */
const OA_DROP_TERM = 'opportunity attacks on the way may drop me first: the follow-up x P(drop)';
/** Greedy v8 review: an action Disengage's escape, decayed by my no-HP-change streak (G4's weights). */
const DISENGAGE_STALE_TERM = 'no progress: turns running with no HP change on either side; an escape alone counts less';
/** Explain's line for walking my Emanation onto creatures (coverage step 7.5 review). */
const AURA_DRAG_TERM = 'my Emanation, walked onto them: its moved-onto hook on each creature it newly covers';
/** W1 review: a sustained self-buff (Rage) before the turn's first attack roll, then the best strike routine. */
const SUSTAIN_FIRST_TERM = 'before my first attack roll: then my best strike routine this turn (or staying), with it on';
/** Session S: a turn-end pulse's creatures where my turn ends, against here. */
const PULSE_TERM = 'my turn-end pulse there: who it reaches against here (allies count against)';
const BOOK_TERM = 'book: limited ability first';
const PROGRESS_TERM = 'progress: the foe output it removes (damage / HP x threat x rounds left)';

/** P(success) of `me`'s concentration save at DC 10 right now (a quick straight-roll read of its CON save and any floor). */
function saveOddsQuick(st: QueryState, me: Unit): number {
  const spec = { kind: 'save' as const, adv: 'none' as const, flat: me.tpl.saveMod[2]!, preDice: [], dc: 10 };
  let floor = 0;
  for (const id of me.borne) {
    const fx = st.fx[id]!;
    if (!fx.alive) continue;
    for (const m of boundOf(st, fx).mods) if (m.op === 'floor' && m.side === 'self' && m.on.some((p) => (saveKey(2, true) & p.mask) === p.val)) floor = Math.max(floor, m.value);
  }
  return quickOdds(floor > 0 ? { ...spec, floor } : spec, oddsFlags(st)).pSuccess;
}

export class GreedyDecider implements Decider {
  readonly name: string;
  readonly w: Weights;
  private state: QueryState | null = null;
  /** Per fight: damage distributions by (attack, defender template), and mean damage per attack. */
  private pmfs = new Map<CompiledAttack, Map<CompiledTemplate, (Pmf | null)[]>>();
  private means = new Map<CompiledAttack, [number, number]>();
  private readonly odds: QuickOdds = { pSuccess: 0, pCrit: 0 };
  /** Perf: attackEVX's straight-roll odds by packed (flat, AC, critMin, roll, auto-crit, expandedCritAutoHits): [pSuccess, pCrit]. Pure, so kept for the fight. */
  private readonly evxOdds = new Map<number, number>();
  /** Perf: the mean of each cached damage PMF (this.pmf's arrays are kept for the fight). */
  private readonly pmfMeans = new WeakMap<Pmf, number>();
  /**
   * Perf (W1): per fight, damage distributions against a defender with defense stats (Rage's
   * resistances), by (attack, its damage-type masks now, crit/adv). damagePmf reads only those
   * masks (defensesOf with a null state), so the same masks give the same PMF.
   */
  private maskPmfs = new Map<readonly CompiledDamage[], Map<number, Pmf>>();
  /** The same for a rider's extra parts joined to an attack's (riderOptValue), by (attack parts, extra parts). */
  /** The same for halved damage (dmgPmf's `half`: a save's half on a success). */
  private halfPmfs = new Map<readonly CompiledDamage[], Map<number, Pmf>>();
  private joinPmfs = new Map<readonly CompiledDamage[], Map<readonly CompiledDamage[], Map<number, Pmf>>>();
  private readonly defScratch: Defenses = { resist: 0, vuln: 0, immune: 0 };
  /** Perf (W1): per decision, foeRoutine's conditioned routines between real units (st.units' own objects), by (attacker, defender, AC). */
  private foeMemo = new Map<number, Routine>();
  /** Perf (W1): per decision, routineX between real units, by (attacker, defender, melee mode, ranged mode). */
  private rxMemo = new Map<number, Routine>();
  /** Perf (W1): per decision, laterBest's strikes (laterStrikeAt). */
  private laterMemo = new Map<number, { v: number; hitP: number; killP: number; adv: AdvState; progress: number }>();
  /** Greedy v13: per decision, strikePlan by unit idx. */
  private plans = new Map<number, StrikePlan>();
  /** Greedy v13 (G1b): the count routineAt's best routine has, and the best strike it saw (read right after the call). */
  private routineN = 0;
  /** E2: the attack routineAt's best routine opens with (-1: none), read right after the call. */
  private routineA = -1;
  private routineBest: [number, number, number] = [0, -1, -1];
  /** routineAt's scratch by call depth. */
  private perPool: { v: Float64Array; t: Int32Array }[] = [];
  private routineDepth = 0;
  /** Perf (W1): per decision, the last VCtx vctxFor built, and what it was built for. */
  private vctxMemo: { st: QueryState; me: Unit; view: UnitView | null; v: VCtx } | null = null;
  /** Per decision. */
  private routines = new Map<number, Routine>();
  private foes: Foe[] = [];
  /** Per fight: each cell's column and row. */
  private cx = new Int16Array(0);
  private cy = new Int16Array(0);
  /** This decision's usable (attack, allowed target) pairs, and each pair's strike value per class (NaN until computed). */
  private pairAi: number[] = [];
  private pairT: number[] = [];
  /**
   * Greedy v12 (stalemate-plan 4.1 B): per template, 1 where the attack appears in some group of some
   * alternative of its Attack action (static: never this action's progress), else 0. A PC's single
   * alternative covers every attack. Step E (E1) gives every compiled Multiattack monster the plain
   * Attack action as its last alternative (one strike with any attack, the Unarmed Strike included), so
   * the mask is all 1s for compiled content; it stays as the guard for any template with an attack
   * outside every alternative (a hand-built test template, say), whose strike the legal list never offers.
   */
  private actMask = new WeakMap<CompiledTemplate, Uint8Array>();
  private pairOf = new Int32Array(0);
  private strikeV = new Float64Array(0);
  private expoV = new Float64Array(0);
  /** Whether foes, expoV and adjHostile were built for this decision (exposure builds them lazily off the turn decision). */
  private foesBuilt = false;
  /** Per fight: does the map have terrain a path must go round or pay for (-1: not read yet), and the walking field by target square. */
  private pathed = -1;
  private pathFields = new Map<number, Int32Array>();
  /** Per fight, walled maps only: the walk to the nearest square a heal of some range can target a square from, by (target, range). */
  private lineFields = new Map<number, Int32Array>();
  /** Squares within 5 ft of a hostile that's up and able (a ranged shot from there has Disadvantage). */
  private adjHostile = new Uint8Array(0);
  /** The likeliest opportunity attack's expected damage this decision (-1 until computed). */
  private oaWorst = -1;
  /** Greedy v8. Per decision: P(drop) by provokes count (NaN until computed), and the reactors' strikes behind it (null until built). */
  private oaDrop: number[] = [];
  private oaStrikes: OaStrike[] | null = null;
  private alt = false;
  /** Per fight: damage distributions by (parts, defender template, crit/adv/half). */
  private dmgs = new Map<readonly CompiledDamage[], Map<CompiledTemplate, (Pmf | null)[]>>();
  /** Per fight: the path each forced move (keyed by its cause) is following, and how far along. */
  private pulls = new Map<number, { cells: readonly number[]; k: number }>();
  /** Coverage 8'b G5. Per decision: the enemy the target style narrows to, by square I'd strike from. */
  private styleMemo = new Map<number, number>();
  /** Coverage 8'b G7. Per decision: next turn's figures the loadout values read (null until needed), and values by hand pair. */
  private lo: { atk: number[]; cast: number[] } | null = null;
  private loMemo = new Map<number, number>();
  private loUnit: Unit | null = null;
  private castMemo = new Map<number, number>();
  /** Per decision: my concentration's per-round value (NaN until computed). */
  private conc = NaN;
  private concP = NaN;
  private meIdx = -1;
  /** Per fight: an attack's expected damage against each AC 0-40 on a straight roll (NaN until computed). */
  private evByAc = new Map<CompiledAttack, Float64Array>();
  /** Per decision: best pull values by (target, square). */
  private pullCache = new Map<number, [number, ForcedPath | null]>();
  /** Per fight: means of dice expressions. Per decision: zone values. */
  private exprMeans = new Map<ExprNode, number>();
  private zoneCache = new Map<BoundEffect, Map<number, number>>();
  private aimCache = new Map<number, readonly AimCand[]>();
  /** Coverage step 7.2: decisions that ranked destinations for an aimed area. Read by a test: it stays 0 with no aimed option listed (perf). */
  aimRanks = 0;
  /** M3 step 5a. Per fight: reduction PMFs. Per decision: the view, Dodge exposure by cell, foes' routines against me dodging, the turn's context, alt values. */
  private exprPmfs = new Map<ExprNode, Pmf>();
  private curView: UnitView | null = null;
  private dodgeExpo = new Float64Array(0);
  private dodgeR: (Routine | null)[] = [];
  private tc: TurnCtx | null = null;
  private altCache: { res: number; ex: unknown; v: number }[] = [];
  /** M3 step 8. Per decision: sim/cover.ts losMode (0 stubbed, 1 cover without walls, 2 with walls). */
  private los: 0 | 1 | 2 = 0;
  /** The cover the last `threatens` call found for a ranged threat (grid/los.ts COVER). */
  private thrCov = 0;
  /** M9 fallback (2): APPROACH_TOP_K, an instance field only so a test can compare it with every destination scored. */
  approachTopK = APPROACH_TOP_K;
  /**
   * M9 fallback (1), docs/design/coverage.md: cover memoized per decision (decide/greedy/memo.ts,
   * sized to what the decision stores: 8'a review G2). Strikes by (attacker, target, from square),
   * the target's square checked; threats against me by (foe, my square), the foe on its own square.
   */
  private covMemo = new CoverMemo();
  private thrMemo = new CoverMemo();
  /** G8. Per decision: rider valuations (cond.ts RiderMemo). */
  private riderMemo = newRiderMemo();
  private inAlt = false;
  /** P(hit) and P(it drops its target) of the last strikeAtk (its odds scratch is reused). */
  private lastHitP = 0;
  /** W1 (P5): the last strikeAtk's resolved Advantage state, for its riders' roll-state gates (freeRiders). */
  private lastAdv: AdvState = 'none';
  /** W1 (P11): strikeAtk rolls with Advantage added (a self consumed Advantage being valued: advGain). */
  private forceAdv = false;
  /** W1 (P2): this decision's cast margin (castMargin; NaN until computed), and its re-entry guard. */
  private margin = NaN;
  private inMargin = false;
  /** W1 (P9): a reach scratch of the decider's own for free-move valuation (the view's is the turn's). */
  private freeSc: ReachScratch | null = null;
  private lastKillP = 0;
  /** Coverage 8'b G3: the progress credit in the last strikeAtk's value. */
  private lastProgress = 0;
  /** M3 step 5b: valuing Cleave's second strike (it can't cleave again), and the decision kind (a rider's or pull's strike is already counted). */
  private inNear = false;
  private dpKind = '';
  /**
   * Review AI-2: valuing a later strike of this turn's Attack action (after the one counted first,
   * at creature index laterOf; -2 off): its once-per-turn free riders are spent (Cleave, "only once
   * per turn", srd-raw.txt:20366-20367), and on that creature Sap's token and Slow are already
   * applied (a refresh: Sap's one next attack roll, 20442-20446; Slow "doesn't exceed 10 feet",
   * 20452-20453) [U: as if the first strike always landed them]. Vex counts again: the later
   * strike spends the first token and leaves its own (20463-20467).
   */
  private laterOf = -2;
  /** Review AI-3: the tpl attack being valued by strikeExact (-1 none), and valuing a Light extra attack itself. */
  private curAi = -1;
  private inLight = false;

  /** Where explain records go (null: not recording, which costs nothing). */
  private explainSink: ((r: ExplainRecord) => void) | null = null;
  /** Spell ids whose concentration a policy holds: never replaced while live (design 2.2). */
  hold: readonly string[] = [];

  constructor(w: Weights = DEFAULT_WEIGHTS, name = 'greedy') {
    this.w = w;
    this.name = name;
  }

  explainTo(sink: ((r: ExplainRecord) => void) | null): void {
    this.explainSink = sink;
  }

  decide(view: UnitView, dp: DecisionPoint): number {
    if (view.q !== this.state) {
      this.state = view.q;
      this.pmfs.clear();
      this.maskPmfs.clear();
      this.halfPmfs.clear();
      this.joinPmfs.clear();
      this.means.clear();
      this.dmgs.clear();
      this.pulls.clear();
      this.pathed = -1;
      this.pathFields.clear();
      this.lineFields.clear();
      this.exprMeans.clear();
      this.exprPmfs.clear();
      this.evByAc.clear();
      const { w, h } = view.q.setup;
      this.cx = new Int16Array(w * h);
      this.cy = new Int16Array(w * h);
      for (let c = 0; c < w * h; c++) {
        this.cx[c] = c % w;
        this.cy[c] = Math.floor(c / w);
      }
    }
    this.routines.clear();
    this.foeMemo.clear();
    this.rxMemo.clear();
    this.laterMemo.clear();
    this.plans.clear();
    this.vctxMemo = null;
    this.styleMemo.clear();
    this.lo = null;
    this.loMemo.clear();
    this.loUnit = null;
    this.castMemo.clear();
    this.foesBuilt = false;
    this.los = losMode(view.q);
    this.covMemo.clear();
    this.thrMemo.clear();
    this.oaWorst = -1;
    this.oaDrop.length = 0;
    this.oaStrikes = null;
    this.conc = NaN;
    this.concP = NaN;
    this.margin = NaN;
    this.meIdx = view.me;
    this.lastScratch = view.scratch;
    this.zoneCache.clear();
    this.aimCache.clear();
    this.pullCache.clear();
    this.curView = view;
    this.tc = null;
    this.altCache.length = 0;
    clearRiderMemo(this.riderMemo);
    this.dodgeR.length = 0;
    this.pairAi.length = 0;
    this.pairT.length = 0;
    this.pairOf.fill(-1);
    this.alt = readFlag(view.q, 'diagonalCost') === 'alternate';
    this.dpKind = dp.k;
    switch (dp.k) {
      case 'turn':
        return this.turn(view, dp);
      case 'reaction':
        return this.reaction(view, dp);
      case 'target':
        return this.target(view, dp);
      case 'place':
        return this.place(view, dp);
      case 'pick':
        return this.pick(view, dp);
      case 'pull':
        return this.pull(view, dp);
      case 'preRoll':
        return this.preRoll(view, dp);
      case 'rider':
        return this.rider(view, dp);
      case 'hitKnown':
        return this.hitKnown(view, dp);
      case 'damageTaken':
        return this.damageTaken(view, dp);
      case 'attackDeclared':
        return this.attackDeclared(view, dp);
      case 'hitTaken':
        return this.hitTaken(view, dp);
      // W1 (docs/design/w1-plan.md P7, P9).
      case 'firstAttack':
        return this.firstAttack(view, dp);
      case 'moveTo':
        return this.moveTo(view, dp);
      default:
        return 0; // orderTriggers: engine order (design 1.2: scored from M3)
    }
  }

  // ---- valuation ----

  /** Grid feet between two cells (grid/reach.ts distFt, the diagonal rule read once per decision). */
  private dist(a: number, b: number): number {
    const dx = Math.abs(this.cx[a]! - this.cx[b]!);
    const dy = Math.abs(this.cy[a]! - this.cy[b]!);
    const hi = dx > dy ? dx : dy;
    const lo = dx > dy ? dy : dx;
    return this.alt ? 5 * (hi + Math.floor(lo / 2)) : 5 * hi;
  }

  /**
   * Coverage 8'b review (ai-logic-3): the feet of walking from `a` to `b` round walls and Difficult
   * Terrain; on a map with neither it is `dist`. One field per target square per fight (terrain never
   * changes) [U: creatures and zones aren't in it, they move].
   */
  private pathFt(st: QueryState, a: number, b: number): number {
    if (this.pathed < 0) {
      this.pathed = 0;
      for (const c of st.setup.terrain) if (c & (TERR.wall | TERR.difficult)) this.pathed = 1;
    }
    if (this.pathed === 0) return this.dist(a, b);
    let f = this.pathFields.get(b);
    if (!f) this.pathFields.set(b, (f = terrainFieldFt(st, b)));
    return f[a]!;
  }

  /** Could a program target a creature on `to` from `from` (not behind Total Cover; only walls give it, srd-raw.txt:2028-2032)? */
  private lineTo(st: QueryState, from: number, to: number): boolean {
    return this.los < 2 || targetable(st, from, to, null);
  }

  /**
   * The feet of walking from `cell` before a heal of range `e.reach` can reach `e.cell`; Infinity if no
   * walk gets there. On a walled map it's the walk to the nearest square in range with a line to the
   * target (one field per target and range per fight; walls never move). Elsewhere every square in
   * range has that line, so it's the distance less the range: open maps pay nothing.
   * [U: creatures and zones aren't in the walk; a square some creature stands on counts.]
   */
  private rescueShort(st: QueryState, cell: number, e: { cell: number; reach: number }): number {
    if (this.los < 2) {
      const ft = this.pathFt(st, cell, e.cell);
      return ft >= FIELD_NONE ? Infinity : ft - e.reach; // no walk reaches it (a wall under losMethod=stubbed): no credit, and rescueAt's loop never starts
    }
    const k = e.cell * 65536 + e.reach;
    let f = this.lineFields.get(k);
    if (!f) {
      const seeds: number[] = [];
      for (let c = 0; c < st.setup.terrain.length; c++) if (!(st.setup.terrain[c]! & TERR.wall) && this.dist(c, e.cell) <= e.reach && targetable(st, c, e.cell, null)) seeds.push(c);
      this.lineFields.set(k, (f = terrainFieldFt(st, seeds)));
    }
    return f[cell]! >= FIELD_NONE ? Infinity : f[cell]!;
  }

  /** What a rescue at `e` is worth from `cell`, as of next turn: all of it from a square in the heal's own range with a line to the target, gamma per turn of walking to get there. */
  private rescueAt(st: QueryState, cell: number, e: { cell: number; reach: number; v: number }, spd: number): number {
    const short = this.rescueShort(st, cell, e);
    if (short <= 0) return e.v;
    if (!(spd > 0) || short === Infinity) return 0;
    let x = e.v;
    for (let left = short; left > 0 && x > 0; left -= spd) x *= this.w.gamma;
    return x;
  }

  /** What a next-turn entry is worth from `cell`: a strike if next turn's move (round walls) brings it in reach; a rescue by distance to range. */
  private nextWorth(st: QueryState, cell: number, e: NextEntry, spd: number): number {
    if (e.rescue) return this.rescueAt(st, cell, e, spd);
    return this.pathFt(st, cell, e.cell) <= spd + e.reach ? e.v : 0;
  }

  private side(me: Unit): SideWeights {
    return me.team === 0 ? (me.isPc ? this.w.pc : this.w.ally) : this.w.monster;
  }

  private pmf(atk: CompiledAttack, t: Unit, crit: boolean, adv: boolean): Pmf {
    let byTpl = this.pmfs.get(atk);
    if (!byTpl) this.pmfs.set(atk, (byTpl = new Map()));
    let arr = byTpl.get(t.tpl);
    if (!arr) byTpl.set(t.tpl, (arr = [null, null, null, null]));
    const k = (crit ? 2 : 0) + (adv ? 1 : 0);
    return (arr[k] ??= damagePmf(atk.damage, t, crit, adv));
  }

  /**
   * The key damagePmf's result has for defender `t`: its damage-type masks now (damagePmf reads the
   * template's when it has no stats, else defensesOf with a null state) and the crit/adv flags; -1
   * when a mask doesn't fit the packing (uncached then).
   */
  private defKey(t: Unit, crit: boolean, adv: boolean): number {
    const def = t.stats.length === 0 ? t.tpl : defensesOf(null, t, this.defScratch);
    const R = 1 << DAMAGE_TYPES.length;
    if (def.resist >= R || def.vuln >= R || def.immune >= R || def.resist < 0 || def.vuln < 0 || def.immune < 0) return -1;
    return ((def.resist * R + def.vuln) * R + def.immune) * 4 + (crit ? 2 : 0) + (adv ? 1 : 0);
  }

  /** damagePmf(parts, t, crit, adv), cached for the fight by (parts, t's masks now, crit/adv): the same masks give the same PMF. */
  private maskPmf(parts: readonly CompiledDamage[], t: Unit, crit: boolean, adv: boolean): Pmf {
    const k = this.defKey(t, crit, adv);
    if (k < 0) return damagePmf(parts, t, crit, adv);
    let byDef = this.maskPmfs.get(parts);
    if (!byDef) this.maskPmfs.set(parts, (byDef = new Map()));
    let p = byDef.get(k);
    if (!p) byDef.set(k, (p = damagePmf(parts, t, crit, adv)));
    return p;
  }

  /** damagePmf(parts, t, crit, adv, half), cached for the fight by (parts, t's masks now, crit/adv, half): dmgPmf for a defender with defense stats. */
  private halfMaskPmf(parts: readonly CompiledDamage[], t: Unit, crit: boolean, adv: boolean, half: boolean): Pmf {
    if (!half) return this.maskPmf(parts, t, crit, adv);
    const k = this.defKey(t, crit, adv);
    if (k < 0) return damagePmf(parts, t, crit, adv, true);
    let byDef = this.halfPmfs.get(parts);
    if (!byDef) this.halfPmfs.set(parts, (byDef = new Map()));
    let p = byDef.get(k);
    if (!p) byDef.set(k, (p = damagePmf(parts, t, crit, adv, true)));
    return p;
  }

  /** damagePmf([...a, ...b], t, crit, false), cached the same way by (a, b). */
  private joinPmf(a: readonly CompiledDamage[], b: readonly CompiledDamage[], t: Unit, crit: boolean): Pmf {
    const k = this.defKey(t, crit, false);
    if (k < 0) return damagePmf([...a, ...b], t, crit, false);
    let byB = this.joinPmfs.get(a);
    if (!byB) this.joinPmfs.set(a, (byB = new Map()));
    let byDef = byB.get(b);
    if (!byDef) byB.set(b, (byDef = new Map()));
    let p = byDef.get(k);
    if (!p) byDef.set(k, (p = damagePmf([...a, ...b], t, crit, false)));
    return p;
  }

  /** Expected damage of one attack against an AC on a straight roll. */
  private attackEV(st: QueryState, atk: CompiledAttack, ac: number): number {
    let row = this.evByAc.get(atk);
    if (!row) this.evByAc.set(atk, (row = new Float64Array(41).fill(NaN)));
    const k = Math.max(0, Math.min(40, ac));
    const hit = row[k]!;
    if (hit === hit) return hit;
    const v = this.attackEVExact(st, atk, k);
    row[k] = v;
    return v;
  }

  /** `critMin`: the attacker's critical range (critMinOf: a critMin stat on it, M3 step 4 carry-over), the attack's own by default. */
  private attackEVExact(st: QueryState, atk: CompiledAttack, ac: number, critMin = atk.critMin): number {
    let m = this.means.get(atk);
    if (!m) this.means.set(atk, (m = [mean(damagePmf(atk.damage, null, false, false)), mean(damagePmf(atk.damage, null, true, false))]));
    const o = quickOdds({ kind: 'attack', adv: 'none', flat: atk.toHit, preDice: [], critMin, dc: ac }, oddsFlags(st), this.odds);
    return (o.pSuccess - o.pCrit) * m[0] + o.pCrit * m[1];
  }

  /**
   * `u`'s straight-roll expected damage with `a` against AC `ac`: the cached per-attack figure,
   * unless a critMin stat on `u` widens its critical range (M3 step 4 carry-over: attackEVExact
   * read only the attack's own critMin, so a PC's Improved Critical never counted in routines).
   */
  private attackEVOf(st: QueryState, u: Unit, a: CompiledAttack, ac: number): number {
    if (u.stats.length > 0) {
      const cm = critMinOf(st, u, a, null);
      if (cm !== a.critMin) return this.attackEVExact(st, a, Math.max(0, Math.min(40, ac)), cm);
    }
    return this.attackEV(st, a, ac);
  }

  private routine(st: QueryState, u: Unit, ac: number): Routine {
    const key = u.idx * 64 + ac;
    // E2: a unit with landing slots threatens with a piece on its own square, so a what-if copy of it
    // standing elsewhere isn't cached (no other unit's routine depends on its square).
    const cache = u.landed.length === 0 || st.units[u.idx] === u;
    const hit = cache ? this.routines.get(key) : undefined;
    if (hit) return hit;
    const atks = u.tpl.attacks;
    // Greedy v13 (stepE-plan 5, E2): a monster standing on its own thrown piece threatens with it
    // (gearReady on its own square); a piece elsewhere isn't counted (a written miss).
    const ev = atks.map((a) => (gearReady(st, u, a.gear, u.cell) && canWield(u, a, true) ? this.attackEVOf(st, u, a, ac) : -1));
    const best = (kind: 'melee' | 'ranged') => {
      let top = 0;
      for (const alt of u.tpl.attackAct.alts) {
        let sum = 0;
        let ok = true;
        for (const g of alt) {
          let b = -1;
          for (const i of g.from) if (atks[i]!.kind === kind && ev[i]! > b) b = ev[i]!;
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
      if (ev[i]! < 0) return;
      if (a.kind === 'melee') reachFt = Math.max(reachFt, a.reachFt);
      else rangeFt = Math.max(rangeFt, a.normalFt);
    });
    const r = { melee: best('melee'), ranged: best('ranged'), reachFt, rangeFt };
    if (cache) this.routines.set(key, r);
    return r;
  }

  /**
   * `u`'s routine against defender `d` (AC `ac`) as the engine would roll it: the plain cached
   * routine unless a content condition is on either of them or `d` has defense stats (M3 step 4;
   * so existing content reads exactly as before). Then the attacker's Disadvantage, the
   * target's incoming Advantage and Paralyzed's critical hits within 5 ft (melee) count.
   */
  private foeRoutine(st: QueryState, u: Unit, d: Unit, ac: number): Routine {
    if (((u.condMask | d.condMask) & CONTENT_CONDS) === 0 && !(d.condMask & COND.dodging) && !defStats(d) && !asleep(d)) return this.routine(st, u, ac);
    // Perf (W1): between real units the answer holds for the decision (nothing moves while I decide).
    const U = st.units.length;
    const memo = st.units[u.idx] === u && st.units[d.idx] === d && ac >= 0 && ac < 256 && Number.isInteger(ac) ? (u.idx * U + d.idx) * 256 + ac : -1;
    if (memo >= 0) {
      const hit = this.foeMemo.get(memo);
      if (hit) return hit;
    }
    const r = this.foeRoutineX(st, u, d);
    if (memo >= 0) this.foeMemo.set(memo, r);
    return r;
  }

  private foeRoutineX(st: QueryState, u: Unit, d: Unit): Routine {
    // The Dodge action (M3 step 5a): attack rolls against a dodger have Disadvantage while it holds (srd-raw.txt:33372-33376).
    const dis = (u.condMask & ATTACKER_DIS) !== 0 || frightened(st, u, null) || ((d.condMask & COND.dodging) !== 0 && dodgeImposesDis(st, d));
    const adv = (d.condMask & TARGET_ADV) !== 0 || asleep(d);
    const m = adv && dis ? MODE.none : adv ? MODE.adv : dis ? MODE.dis : MODE.none;
    // Paralyzed's automatic Critical Hit needs only the attacker within 5 ft (srd-raw.txt:33941-33943),
    // whatever the roll mode: melee strikes land from within reach, ranged ones from where it stands.
    const crit = autoCritWithin5(d) ? MODE.crit : 0;
    return this.routineX(st, u, d, m | crit, this.dist(u.cell, d.cell) <= 5 ? m | crit : m);
  }

  /** `u`'s routine against `d` (a real creature or a what-if copy) with melee and ranged strikes rolled in cond.ts MODEs; damage after `d`'s defenses. Uncached: only conditions and stats reach it. */
  routineX(st: QueryState, u: Unit, d: Unit, meleeMode: number, rangedMode: number): Routine {
    // Perf (W1): between real units the answer holds for the decision (as foeRoutine's memo).
    if (st.units[u.idx] !== u || st.units[d.idx] !== d || meleeMode < 0 || meleeMode > 15 || rangedMode < 0 || rangedMode > 15) return this.routineXNow(st, u, d, meleeMode, rangedMode);
    const key = ((u.idx * st.units.length + d.idx) * 16 + meleeMode) * 16 + rangedMode;
    let r = this.rxMemo.get(key);
    if (!r) this.rxMemo.set(key, (r = this.routineXNow(st, u, d, meleeMode, rangedMode)));
    return r;
  }

  private routineXNow(st: QueryState, u: Unit, d: Unit, meleeMode: number, rangedMode: number): Routine {
    const ac = acNow(d);
    const atks = u.tpl.attacks;
    const ev = atks.map((a) => (gearReady(st, u, a.gear, u.cell) && canWield(u, a, true) ? this.attackEVX(st, u, a, d, ac, a.kind === 'melee' ? meleeMode : rangedMode) : -1)); // E2: as routine
    const best = (kind: 'melee' | 'ranged') => {
      let top = 0;
      for (const alt of u.tpl.attackAct.alts) {
        let sum = 0;
        let ok = true;
        for (const g of alt) {
          let b = -1;
          for (const i of g.from) if (atks[i]!.kind === kind && ev[i]! > b) b = ev[i]!;
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
      if (ev[i]! < 0) return;
      if (a.kind === 'melee') reachFt = Math.max(reachFt, a.reachFt);
      else rangeFt = Math.max(rangeFt, a.normalFt);
    });
    return { melee: best('melee'), ranged: best('ranged'), reachFt, rangeFt };
  }

  private attackEVX(st: QueryState, u: Unit, atk: CompiledAttack, d: Unit, ac: number, mode: number): number {
    const roll = mode & (MODE.adv | MODE.dis);
    const adv = roll === MODE.adv;
    // Without defense stats on `d` its damage depends only on its template: the per-fight cache (same PMFs).
    const own = !defStats(d);
    const plain = this.pmfMean(own ? this.pmf(atk, d, false, adv) : this.maskPmf(atk.damage, d, false, adv));
    const crit = this.pmfMean(own ? this.pmf(atk, d, true, adv) : this.maskPmf(atk.damage, d, true, adv));
    const critMin = critMinOf(null, u, atk, d);
    const flags = oddsFlags(st); // read every call: it records the dependence (st.aiFlags)
    const flat = atk.toHit;
    const auto = mode & MODE.crit ? 1 : 0;
    const rIdx = adv ? 1 : roll === MODE.dis ? 2 : 0;
    let ps: number;
    let pc: number;
    if (flat >= -256 && flat < 256 && ac >= 0 && ac < 256 && critMin >= 0 && critMin < 32 && Number.isInteger(flat) && Number.isInteger(ac)) {
      const key = ((((flat + 256) * 256 + ac) * 32 + critMin) * 3 + rIdx) * 4 + auto * 2 + (flags.expandedCritAutoHits ? 1 : 0);
      const hit = this.evxOdds.get(2 * key);
      if (hit !== undefined) {
        ps = hit;
        pc = this.evxOdds.get(2 * key + 1)!;
      } else {
        const o = quickOdds(this.evxSpec(atk, rIdx, critMin, ac, auto), flags, this.odds);
        ps = o.pSuccess;
        pc = o.pCrit;
        this.evxOdds.set(2 * key, ps);
        this.evxOdds.set(2 * key + 1, pc);
      }
    } else {
      const o = quickOdds(this.evxSpec(atk, rIdx, critMin, ac, auto), flags, this.odds);
      ps = o.pSuccess;
      pc = o.pCrit;
    }
    return (ps - pc) * plain + pc * crit;
  }

  private evxSpec(atk: CompiledAttack, rIdx: number, critMin: number, ac: number, auto: number) {
    const spec = { kind: 'attack' as const, adv: rIdx === 1 ? ('adv' as const) : rIdx === 2 ? ('dis' as const) : ('none' as const), flat: atk.toHit, preDice: [], critMin, dc: ac };
    return auto ? { ...spec, autoCritOnHit: true } : spec;
  }

  private pmfMean(p: Pmf): number {
    let m = this.pmfMeans.get(p);
    if (m === undefined) this.pmfMeans.set(p, (m = mean(p)));
    return m;
  }

  /**
   * What removing `t` is worth: its best routine against my side's AC, for F rounds. Read as the
   * engine would roll it against me (foeRoutine: its conditions and mine, M3 step 4 carry-over);
   * with no condition on either it is the plain cached routine, as before.
   */
  private killValue(st: QueryState, me: Unit, t: Unit): number {
    const r = this.foeRoutine(st, t, me, acNow(me));
    return Math.max(r.melee, r.ranged) * future(this.w);
  }

  /**
   * Coverage 8'b G3, M6, m8: what `nonLethal` expected damage on `t` is worth beyond its HP, the
   * foe output it removes: damage / HP x its threat x future(w, the rounds left), at my side's
   * `progress` weight (PC side only). The kill term already pays for damage that drops it. A hit
   * that doesn't drop it pays only if someone finishes the job: alone, that's me, so the credit
   * counts my chance of staying up where I stand (pDrop; v4's reason a concentration spell's later
   * rounds are scaled; a square's own exposure would break the strike cache, so it's this one's).
   */
  private progressValue(st: QueryState, me: Unit, t: Unit, nonLethal: number): number {
    const k = this.side(me).progress;
    const cap = t.hp + t.tempHp;
    if (!(k > 0) || !(nonLethal > 0) || cap <= 0) return 0;
    const r = this.foeRoutine(st, t, me, acNow(me));
    let finish = 1;
    // W1 (P8): with a live drop-to-1 pool my next drop doesn't happen (w1.ts dropSafe).
    if (!st.units.some((u) => u !== me && u.team === me.team && u.life === 'up') && !dropSafe(me)) finish = 1 - pDrop(this.exposure(st, me, me.cell), me.hp + me.tempHp);
    return (k * finish * nonLethal * Math.max(r.melee, r.ranged) * future(this.w, st.setup.knobs.maxRounds - st.round + 1)) / cap;
  }

  /** How `f` could attack a creature on `cell` next turn: the better of the routines that reach it. */
  private threatens(st: QueryState, f: Foe, cell: number): 'melee' | 'ranged' | null {
    const d = this.dist(f.u.cell, cell);
    const speed = f.fearMe ? 0 : f.speed;
    const how = threatKind(d, speed, f.r);
    this.thrCov = 0;
    if (how !== 'ranged' || this.los === 0) return how;
    // M3 step 8: a shot from where it stands meets my cover there (me as the target, wherever I am now).
    const cov = this.coverVsMe(st, f.u, cell);
    if (cov === COVER.total) return f.r.melee > 0 && d <= speed + f.r.reachFt ? 'melee' : null;
    this.thrCov = cov;
    return how;
  }

  /** Bytes the per-decision cover memos hold (8'a review G2; tests). */
  coverMemoBytes(): number {
    return this.covMemo.bytes + this.thrMemo.bytes;
  }

  /** The cover `t` has against `a` striking from `from` (sim/cover.ts coverAgainst), memoized for the decision. */
  private coverOf(st: QueryState, a: Unit, from: number, t: Unit): number {
    if (this.los === 0) return 0;
    const U = st.units.length;
    const k = (a.idx * U + t.idx) * st.setup.w * st.setup.h + from;
    const hit = this.covMemo.get(k, t.cell);
    if (hit >= 0) return hit;
    const v = coverAgainst(st, a, from, t, null);
    this.covMemo.set(k, t.cell, v);
    return v;
  }

  /** The cover I'd have on `cell` against foe `u` shooting from its square, memoized for the decision. */
  private coverVsMe(st: QueryState, u: Unit, cell: number): number {
    const k = u.idx * st.setup.w * st.setup.h + cell;
    const hit = this.thrMemo.get(k, 0);
    if (hit >= 0) return hit;
    const v = coverAt(st, u, u.cell, cell, st.units[this.meIdx] ?? null, null);
    this.thrMemo.set(k, 0, v);
    return v;
  }

  /** What Half or Three-Quarters Cover leaves of `f`'s ranged routine against me (its plain routine at AC + 2 or + 5 over at my AC); 1 with none. */
  private coverScale(st: QueryState, f: Foe, me: Unit, cov: number): number {
    if (cov === 0) return 1;
    const ac = acNow(me);
    const base = this.routine(st, f.u, ac).ranged;
    return base > 0 ? this.routine(st, f.u, ac + COVER_BONUS[cov]!).ranged / base : 1;
  }

  private buildFoes(st: QueryState, me: Unit): void {
    this.foesBuilt = true;
    const ac = acNow(me);
    this.foes = [];
    for (const u of st.units) {
      if (u.life !== 'up' || !hostile(u, me) || has(u, COND.incapacitated)) continue;
      if (u.condMask & COND.charmed && charmedBy(u, me)) continue; // it can't attack the charmer (srd-raw.txt:32957-32958)
      const r = this.foeRoutine(st, u, me, ac);
      if (r.melee === 0 && r.ranged === 0) continue;
      const speed = speedNow(u);
      const fearMe = frightened(st, u, me);
      let v = 0;
      for (const o of st.units) if (o.life === 'up' && o.team === me.team && threatKind(this.dist(u.cell, o.cell), fearMe && o === me ? 0 : speed, r)) v++;
      this.foes.push({ u, r, victims: Math.max(1, v), speed, fearMe });
    }
    const n = st.setup.w * st.setup.h;
    if (this.adjHostile.length !== n) {
      this.adjHostile = new Uint8Array(n);
      this.expoV = new Float64Array(n);
    } else this.adjHostile.fill(0);
    this.expoV.fill(NaN);
    const w = st.setup.w;
    const h = st.setup.h;
    for (const u of st.units) {
      if (u === me || u.life !== 'up' || !hostile(u, me) || has(u, COND.incapacitated)) continue;
      const x = u.cell % w;
      const y = Math.floor(u.cell / w);
      for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++) for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) this.adjHostile[yy * w + xx] = 1;
    }
  }

  /** Expected damage `me` could take on `cell` before its next turn (query/threat.ts threatAt, with memoized routines). */
  private exposure(st: QueryState, me: Unit, cell: number): number {
    // A sub-decision (a scripted cast's target, a pick) can need exposure without the turn decision
    // having built it for this state.
    if (!this.foesBuilt) this.buildFoes(st, me);
    const hit = this.expoV[cell]!;
    if (hit === hit) return hit; // not NaN
    let total = 0;
    for (const f of this.foes) {
      const how = this.threatens(st, f, cell);
      if (!how) continue;
      // `victims` counted me on my own square; standing elsewhere I'm still one of them.
      total += (how === 'melee' ? f.r.melee : f.r.ranged * this.coverScale(st, f, me, this.thrCov)) / f.victims;
    }
    this.expoV[cell] = total;
    return total;
  }

  /** The cost of ending the turn on `cell`. */
  private endCost(st: QueryState, me: Unit, cell: number): number {
    return this.endCostE(st, me, this.exposure(st, me, cell));
  }

  /** The end cost for an exposure of `e`. */
  private endCostE(st: QueryState, me: Unit, e: number): number {
    const s = this.side(me);
    let c = s.exposure * e;
    if (s.dropRisk > 0 && me.hp > 0 && !dropSafe(me)) c += s.dropRisk * pDrop(e, me.hp); // W1 (P8): no drop with a live drop-to-1 pool
    if (me.conc >= 0 && e > 0) c += this.concBreak(st, me) * Math.min(3, e / HIT) * this.concLeft(st, me);
    return c;
  }

  /** May `me` attack `t` under attackDowned? `upInReach`: some standing hostile could be attacked this turn. */
  private allowed(st: QueryState, t: Unit, upInReach: boolean): boolean {
    if (t.life === 'up') return true;
    if (t.life === 'dead') return false;
    const k = st.setup.knobs.attackDowned;
    return k === 'always' || (k === 'ifNoOtherTarget' && !upInReach);
  }

  /**
   * One strike with attack `ai` at `t` from `from`: expected HP removed, plus the chance it
   * drops `t` times what that's worth. The attack's odds depend on `from` only through four
   * facts (beyond normal range, a hostile adjacent for a ranged shot, within 5 ft, the target's
   * cover: M3 step 8), so values are cached per (attack, target, those facts) for the decision. An opportunity attack
   * (`opportunity`) is valued fresh, with its roll key's opportunity bit, so
   * d20.attack.opportunity modifiers count.
   */
  private strike(view: UnitView, me: Unit, ai: number, t: Unit, from: number, opportunity = false): number {
    if (opportunity) return this.strikeExact(view, me, ai, t, from, true);
    const atk = me.tpl.attacks[ai]!;
    const d = this.dist(from, t.cell);
    const ranged = atk.kind === 'ranged';
    // M3 step 8: the target's cover from `from` is the fourth fact (docs/design/m3.md section 7).
    const cov = this.coverOf(view.q, me, from, t);
    const bits = (ranged && d > atk.normalFt ? 1 : 0) | (ranged && this.adjHostile[from] ? 2 : 0) | (d <= 5 ? 4 : 0) | (cov << 3);
    const p = this.pairOf[ai * 64 + t.idx];
    if (p === undefined || p < 0) return this.strikeExact(view, me, ai, t, from); // not a pair this decision (an opportunity attack, say)
    const hit = this.strikeV[p * 32 + bits]!;
    if (hit === hit) return hit;
    const v = this.strikeExact(view, me, ai, t, from);
    this.strikeV[p * 32 + bits] = v;
    return v;
  }

  private strikeExact(view: UnitView, me: Unit, ai: number, t: Unit, from: number, opportunity = false): number {
    const atk = me.tpl.attacks[ai]!;
    // Coverage 8'b G7: a strike that draws its weapon changes what's in hand: one switch, over the routine.
    const v = this.strikeAtk(view, me, atk, t, from, opportunity) - (this.drawsWeapon(me, atk) ? this.w.loadoutSwitch / this.strikesFor(me, ai) : 0);
    // M3 step 5b: its free riders (a weapon's mastery) at P(hit) or P(miss); none on existing content.
    if (!atk.onHit && !atk.onMiss) return v;
    const p = this.lastHitP;
    const kill = this.lastKillP;
    const roll = this.lastAdv;
    const wasAi = this.curAi;
    this.curAi = ai;
    const r = this.freeRiders(view, me, atk, t, '', p, null, roll);
    this.curAi = wasAi;
    this.lastHitP = p;
    this.lastKillP = kill;
    return v + r;
  }

  /**
   * Review AI-2: the best strike from `from` for the Attack action's later strikes, after one
   * counted at creature `first`: their once-per-turn riders spent, and on `first` Sap and Slow
   * already there (laterOf). `plain`: the best strike as bestStrike values it (riders in
   * full), returned as is when I have no riders (nothing to recount).
   */
  private laterBest(view: UnitView, me: Unit, from: number, first: number, plain: number, mask: Uint8Array | null = null): number {
    const riders = !!me.tpl.riders;
    if (!riders && mask === null) return plain;
    const st = view.q;
    let bv = 0;
    const was = this.laterOf;
    if (riders) this.laterOf = first;
    for (let p = 0; p < this.pairAi.length; p++) {
      const ai = this.pairAi[p]!;
      if (mask !== null && mask[ai] === 0) continue; // greedy v13 (G1b): only attacks that share the alternative
      const t = st.units[this.pairT[p]!]!;
      if (!this.inRange(st, me.tpl.attacks[ai]!, t, from) || !this.pickupFrom(st, me, me.tpl.attacks[ai]!, from) || !this.styleOk(st, me, from, t)) continue;
      bv = Math.max(bv, riders ? this.laterStrikeAt(view, me, p, ai, t, from, first) : this.strike(view, me, ai, t, from));
    }
    if (riders) this.laterOf = was;
    return bv;
  }

  /**
   * Greedy v13 (G1b): the strikes from `from` under `plan`, when its attacks don't all read as v12: per
   * attack its best strike (one pass over the pairs) plus its later strikes from the attacks that share
   * its alternative, the best of those over attacks. Sets routineN to the chosen attack's count (0
   * when nothing is worth striking) and routineBest to bestStrike's [value, attack, target] from `from`
   * (the same pass: pairs run attack by attack, so the first strict maximum is bestStrike's).
   */
  private routineAt(view: UnitView, me: Unit, from: number, plan: StrikePlan): number {
    const st = view.q;
    const na = me.tpl.attacks.length;
    // Scratch per depth: a later strike's riders can value one more action (extraActionValue), which comes back here.
    const d = this.routineDepth++;
    if (this.perPool.length <= d) this.perPool.push({ v: new Float64Array(0), t: new Int32Array(0) });
    const pool = this.perPool[d]!;
    if (pool.v.length < na) [pool.v, pool.t] = [new Float64Array(na), new Int32Array(na)];
    const perV = pool.v;
    const perT = pool.t;
    perV.fill(0, 0, na);
    perT.fill(-1, 0, na);
    for (let p = 0; p < this.pairAi.length; p++) {
      const ai = this.pairAi[p]!;
      const t = st.units[this.pairT[p]!]!;
      if (!this.inRange(st, me.tpl.attacks[ai]!, t, from) || !this.pickupFrom(st, me, me.tpl.attacks[ai]!, from) || !this.styleOk(st, me, from, t)) continue;
      const v = this.strike(view, me, ai, t, from);
      if (v > perV[ai]!) [perV[ai], perT[ai]] = [v, t.idx];
    }
    let b = 0;
    let bestA = -1;
    for (let ai = 0; ai < na; ai++) if (perV[ai]! > b) [b, bestA] = [perV[ai]!, ai];
    const riders = !!me.tpl.riders;
    let best = 0;
    let bestN = 0;
    let bestAi = -1;
    for (let ai = 0; ai < na; ai++) {
      const s1 = perV[ai]!;
      if (!(s1 > 0)) continue;
      const k = plan.n[ai]!;
      let later = 0;
      if (k > 1) {
        const mask = plan.later[ai] ?? null;
        if (riders) later = this.laterBest(view, me, from, perT[ai]!, b, mask);
        else if (mask === null) later = b;
        else for (let aj = 0; aj < na; aj++) if (mask[aj] === 1 && perV[aj]! > later) later = perV[aj]!; // laterBest's masked best, from this pass
      }
      const v = k > 1 ? s1 + (k - 1) * later : s1;
      if (v > best) [best, bestN, bestAi] = [v, k, ai];
    }
    this.routineDepth--;
    this.routineN = bestN;
    this.routineA = bestAi;
    this.routineBest = [b, bestA, bestA >= 0 ? perT[bestA]! : -1];
    return best;
  }

  /**
   * Perf (W1): laterBest's strikeExact for pair `p` under laterOf = `first`, memoized for the
   * decision by the same facts strike()'s cache keys `from` by, plus `first` and the decider's mode
   * flags a strike's valuation reads (forceAdv, inLight, inNear, inAlt, inMargin, rollComing). A
   * hit restores the fields strikeExact leaves behind (lastHitP, lastKillP, lastAdv, lastProgress),
   * so everything after reads exactly what the uncached call would have left.
   */
  private laterStrikeAt(view: UnitView, me: Unit, p: number, ai: number, t: Unit, from: number, first: number): number {
    const atk = me.tpl.attacks[ai]!;
    const d = this.dist(from, t.cell);
    const ranged = atk.kind === 'ranged';
    const cov = this.coverOf(view.q, me, from, t);
    const bits = (ranged && d > atk.normalFt ? 1 : 0) | (ranged && this.adjHostile[from] ? 2 : 0) | (d <= 5 ? 4 : 0) | (cov << 3);
    // Bypassed while tc is null: a rider's dash or gainAction step reads tc's fields (dashValue,
    // extraActionValue), which the one engaged bit below doesn't capture (perf review, 2026-11-12).
    const tc = this.tc;
    if (tc === null || !this.foesBuilt || this.explainSink !== null || first < 0 || first >= 64 || bits < 0 || bits >= 32) return this.strikeExact(view, me, ai, t, from);
    const flags = (this.forceAdv ? 1 : 0) | (this.inLight ? 2 : 0) | (this.inNear ? 4 : 0) | (this.inAlt ? 8 : 0) | (this.inMargin ? 16 : 0) | (tc.canAttack && tc.engaged ? 32 : 0);
    const key = ((p * 32 + bits) * 64 + first) * 64 + flags;
    const hit = this.laterMemo.get(key);
    if (hit) {
      this.lastHitP = hit.hitP;
      this.lastKillP = hit.killP;
      this.lastAdv = hit.adv;
      this.lastProgress = hit.progress;
      return hit.v;
    }
    const v = this.strikeExact(view, me, ai, t, from);
    this.laterMemo.set(key, { v, hitP: this.lastHitP, killP: this.lastKillP, adv: this.lastAdv, progress: this.lastProgress });
    return v;
  }

  /** One strike with `atk` (a tpl attack or a weaponAttack step's variant) at `t` from `from`; sets lastHitP. */
  private strikeAtk(view: UnitView, me: Unit, atk: CompiledAttack, t: Unit, from: number, opportunity = false): number {
    const st = view.q;
    const qs = view.scratch;
    let spec = buildAttackSpecFor(st, me, atk, t, from, qs.adv, qs.dis, qs.fold, opportunity, this.coverOf(st, me, from, t));
    // W1 (P11): one more Advantage source; any Disadvantage cancels it as resolveAdvantage would (srd-raw.txt:1056-1060).
    if (this.forceAdv) spec = { ...spec, adv: qs.dis.length > 0 ? 'none' : 'adv' };
    const o = quickOdds(spec, oddsFlags(st), this.odds);
    const crit = o.pCrit; // copied: killValue reuses the odds scratch
    const plain = o.pSuccess - crit;
    this.lastHitP = o.pSuccess;
    this.lastAdv = spec.adv;
    this.lastKillP = 0;
    this.lastProgress = 0;
    const adv = spec.adv === 'adv';
    let v: number;
    if (t.life !== 'up') {
      // A downed creature: a hit is a death-save failure, a critical hit two (p.18).
      v = ((plain + 2 * crit) / Math.max(1, 3 - t.deathFail)) * this.killValue(st, me, t);
    } else {
      const cap = t.hp + t.tempHp;
      // W1 review: a target with live defense stats (Rage's Resistance) reads its masks now, not the
      // per-fight template cache, which would keep whichever masks it had at its first look (attackEVX's guard).
      const own = !defStats(t);
      const d = own ? this.pmf(atk, t, false, adv) : this.maskPmf(atk.damage, t, false, adv);
      const dc = own ? this.pmf(atk, t, true, adv) : this.maskPmf(atk.damage, t, true, adv);
      v = plain * expectedCapped(d, cap) + crit * expectedCapped(dc, cap);
      const pk = plain * probAtLeast(d, cap) + crit * probAtLeast(dc, cap);
      this.lastKillP = pk;
      this.lastProgress = this.progressValue(st, me, t, v - pk * cap);
      v += pk * this.killValue(st, me, t) + this.lastProgress;
    }
    // A thrown weapon is gone (a counted one) or lies where it landed (M3 step 5b: a single held weapon thrown).
    // A piece of ammunition (a held weapon's counted pieces, fired, not thrown) costs nothing: the
    // bow stays in hand, and with no rest recovery a piece is worth nothing after the fight
    // (integration fix: throwAway per arrow made a counted Longbow worse than walking into melee;
    // [U] scarcity near the last pieces isn't valued).
    if (atk.throws || (atk.consumesGear && atk.item === undefined)) v -= this.w.throwAway;
    return v;
  }

  /** M3 step 5b: the best strike from `from` with a held Light weapon (one that would open the Light extra attack). */
  private bestLightStrike(view: UnitView, me: Unit, from: number): number {
    const st = view.q;
    let bv = 0;
    for (let p = 0; p < this.pairAi.length; p++) {
      const atk = me.tpl.attacks[this.pairAi[p]!]!;
      if (atk.item === undefined || me.tpl.items[atk.item]!.light !== true) continue;
      const t = st.units[this.pairT[p]!]!;
      if (!this.inRange(st, atk, t, from) || !this.pickupFrom(st, me, atk, from) || !this.styleOk(st, me, from, t)) continue;
      bv = Math.max(bv, this.strike(view, me, this.pairAi[p]!, t, from));
    }
    return bv;
  }

  /** Can attack `ai` reach `t` from `from`? */
  private inRange(st: QueryState, atk: CompiledAttack, t: Unit, from: number): boolean {
    const d = this.dist(from, t.cell);
    // M3 step 8: a target behind Total Cover can't be targeted (srd-raw.txt:2028-2032); only walls give it.
    return (atk.kind === 'melee' ? d <= atk.reachFt : d <= atk.longFt) && (this.los < 2 || targetable(st, from, t.cell, null));
  }

  /**
   * Review INT-1: a held weapon lying on the ground (dropped, or thrown) can be picked up by an
   * Attack-action strike only from its own square (sim/state.ts canWield); a strike from another
   * square `from` leaves it there. Always true for a weapon that isn't lying anywhere.
   */
  private pickupFrom(st: QueryState, me: Unit, atk: CompiledAttack, from: number): boolean {
    return (atk.item === undefined || me.dropped[atk.item]! < 0 || me.dropped[atk.item] === from) && this.pieceOk(st, me, atk, from);
  }

  /**
   * Greedy v13 (stepE-plan 5, E2): a monster's counted thrown gear it has none of (gearOk false) is
   * usable from `from` only if one of its own landed pieces lies there, which the strike's equip picks
   * up (srd-raw.txt:32707-32712, sim/act.ts). True for anything else, and for every unit with no
   * landing slots (PCs, monsters without thrown counted gear), so those read exactly as before.
   */
  private pieceOk(st: QueryState, me: Unit, atk: CompiledAttack, from: number): boolean {
    if (me.landed.length === 0 || atk.gear < 0 || me.gear[atk.gear] !== 0 || gearOk(st, me, atk.gear)) return true;
    return pieceAt(me, atk.gear, from);
  }

  /** E2: the gear a strike with `atk` from `from` first picks up off that square (pieceOk's case), or -1. */
  private pickupGear(st: QueryState, me: Unit, atk: CompiledAttack, from: number): number {
    if (me.landed.length === 0 || atk.gear < 0 || me.gear[atk.gear] !== 0 || gearOk(st, me, atk.gear)) return -1;
    return pieceAt(me, atk.gear, from) ? atk.gear : -1;
  }

  /**
   * Greedy v13 (stepE-plan 5, G1a): the strikes attack `ai` brings this Attack action: the size of the
   * largest live alternative that holds one more `ai` (liveAlts over the strikes made, plus `ai`), less
   * the strikes already made. An attack no live alternative holds (a destination's strike mid-action,
   * once its alternative is spent) keeps strikesLeft's reading, v12's. `ai` < 0: strikesLeft.
   */
  private strikesFor(me: Unit, ai: number): number {
    return ai < 0 ? this.strikesLeft(me) : this.strikePlan(me).n[ai]!;
  }

  /**
   * G1a/G1b: per decision and unit, each attack's strike count (strikesFor) and, when the unit's
   * alternatives differ in size or in the attacks they hold, the attacks its later strikes may use
   * (`later`: those that still fit, after it, an alternative of that size; null: any, as v12). `masked`
   * is false when every attack reads as v12 (one alternative size and one attack set), which keeps
   * v12's formulas exactly. One alternative of one group (every PC, most monsters): no packing needed.
   * `fresh`: as for an Attack action not yet started (extraActionValue's one more action).
   */
  private strikePlan(me: Unit, fresh = false): StrikePlan {
    const key = me.idx * 2 + (fresh ? 1 : 0);
    let p = this.plans.get(key);
    if (p !== undefined) return p;
    const tpl = me.tpl;
    const alts = tpl.attackAct.alts;
    const na = tpl.attacks.length;
    const left = fresh ? routineCount(me) : this.strikesLeft(me);
    const n = new Int8Array(na).fill(left);
    const later: (Uint8Array | null)[] = new Array<Uint8Array | null>(na).fill(null);
    let masked = false;
    if (!(alts.length === 1 && alts[0]!.length === 1)) {
      const act = me.b.atkActive && !fresh;
      const c = new Uint8Array(na);
      let made = 0;
      if (act) {
        c.set(me.b.atkCounts);
        for (let i = 0; i < na; i++) made += c[i]!;
      }
      const live = act ? me.b.atkLive : (1 << alts.length) - 1;
      const sizes = alts.map((alt) => alt.reduce((s, g) => s + g.count, 0));
      const inAct = this.inAttackAct(tpl);
      for (let ai = 0; ai < na; ai++) {
        c[ai]!++;
        let best = -1;
        let ks = 0; // the live alternatives of that size holding it
        for (let k = 0; k < alts.length; k++) {
          if (!(live & (1 << k)) || !canPack(alts[k]!, c)) continue;
          const size = sizes[k]! - made;
          if (size > best) [best, ks] = [size, 1 << k];
          else if (size === best) ks |= 1 << k;
        }
        if (best >= 0) {
          n[ai] = Math.max(1, best);
          if (n[ai] !== left) masked = true;
          // G1b: a later strike may use `aj` only if the strikes made, this one and `aj` still fit one of
          // those alternatives (for a multi-group alternative an upper bound on the later strikes, never
          // an illegal pair).
          if (best > 1) {
            const m = new Uint8Array(na);
            for (let aj = 0; aj < na; aj++) {
              c[aj]!++;
              for (let k = 0; k < alts.length && m[aj] === 0; k++) if (ks & (1 << k) && canPack(alts[k]!, c)) m[aj] = 1;
              c[aj]!--;
              if (m[aj] === 0 && inAct[aj] === 1) masked = true;
            }
            later[ai] = m;
          }
        }
        c[ai]!--;
      }
      // Every attack reads as v12 (one size, one attack set): keep v12's formulas exactly.
      if (!masked) later.fill(null);
    }
    p = { n, later, masked };
    this.plans.set(key, p);
    return p;
  }

  private strikesLeft(me: Unit): number {
    const alts = me.tpl.attackAct.alts;
    let made = 0;
    for (let i = 0; i < me.b.atkCounts.length; i++) made += me.b.atkCounts[i]!;
    let best = 0;
    alts.forEach((alt, k) => {
      if (me.b.atkActive && !(me.b.atkLive & (1 << k))) return;
      let n = 0;
      for (const g of alt) n += g.count;
      best = Math.max(best, n - (me.b.atkActive ? made : 0));
    });
    return Math.max(1, best);
  }

  /** Greedy v12 B: the template's static Attack-action mask (actMask), built once per template. */
  private inAttackAct(tpl: CompiledTemplate): Uint8Array {
    let m = this.actMask.get(tpl);
    if (m === undefined) {
      m = new Uint8Array(tpl.attacks.length);
      for (const alt of tpl.attackAct.alts) for (const g of alt) for (const i of g.from) m[i] = 1;
      this.actMask.set(tpl, m);
    }
    return m;
  }

  /** Builds this decision's (usable attack, allowed hostile target) pairs. */
  private buildPairs(st: QueryState, me: Unit, upInReach: boolean): void {
    const na = me.tpl.attacks.length;
    if (this.pairOf.length < na * 64) this.pairOf = new Int32Array(na * 64);
    this.pairOf.fill(-1);
    // M3 step 5b: an Attack action's strike may draw its weapon (srd-raw.txt:32707-32711); a Loading
    // weapon fires once per action (20355-20358). Both inert without held weapons.
    const draw = me.b.action > 0 || me.b.atkActive;
    const mask = this.inAttackAct(me.tpl);
    me.tpl.attacks.forEach((atk, ai) => {
      if (mask[ai] === 0) return; // greedy v12 B: no alternative of my Attack action holds it
      // E2: gear I have none of still makes a pair while one of my thrown pieces is on the ground
      // (picked up from its square only: pieceOk filters each square).
      if (atk.spell || !(gearOk(st, me, atk.gear) || piecesOf(me, atk.gear) > 0) || !canWield(me, atk, draw)) return;
      if (atk.loading && me.b.atkActive && loadedNow(me, atk.item!)) return;
      for (const t of st.units) {
        if (!hostile(me, t) || !this.allowed(st, t, upInReach)) continue;
        this.pairOf[ai * 64 + t.idx] = this.pairAi.length;
        this.pairAi.push(ai);
        this.pairT.push(t.idx);
      }
    });
    if (this.strikeV.length < this.pairAi.length * 32) this.strikeV = new Float64Array(this.pairAi.length * 32 * 2);
    this.strikeV.fill(NaN);
  }

  /** Best strike value from `from` over this decision's pairs in range: [value, attack, target]. */
  private bestStrike(view: UnitView, me: Unit, from: number): [number, number, number] {
    const st = view.q;
    let bv = 0;
    let ba = -1;
    let bt = -1;
    for (let p = 0; p < this.pairAi.length; p++) {
      const ai = this.pairAi[p]!;
      const t = st.units[this.pairT[p]!]!;
      if (!this.inRange(st, me.tpl.attacks[ai]!, t, from) || !this.pickupFrom(st, me, me.tpl.attacks[ai]!, from) || !this.styleOk(st, me, from, t)) continue;
      const v = this.strike(view, me, ai, t, from);
      if (v > bv) {
        bv = v;
        ba = ai;
        bt = t.idx;
      }
    }
    return [bv, ba, bt];
  }

  /** Could a standing hostile be attacked this turn (moving first)? Sets attackDowned's ifNoOtherTarget. */
  private upInReach(st: QueryState, me: Unit): boolean {
    let melee = 0;
    let ranged = 0;
    // E2: gear I have none of, used from one of my thrown pieces within my move (the reach from that square).
    let piece: Int32Array | null = null; // per gear, the longest reach of an attack that uses a piece of it
    const mask = this.inAttackAct(me.tpl);
    for (let ai = 0; ai < me.tpl.attacks.length; ai++) {
      if (mask[ai] === 0) continue; // greedy v12 B: as buildPairs
      const a = me.tpl.attacks[ai]!;
      if (a.spell || !canWield(me, a, me.b.action > 0 || me.b.atkActive)) continue;
      if (!gearOk(st, me, a.gear)) {
        if (piecesOf(me, a.gear) > 0) {
          piece ??= new Int32Array(me.tpl.gear.length);
          piece[a.gear] = Math.max(piece[a.gear]!, a.kind === 'melee' ? a.reachFt : a.longFt);
        }
        continue;
      }
      if (a.kind === 'melee') melee = Math.max(melee, a.reachFt);
      else ranged = Math.max(ranged, a.longFt);
    }
    for (const t of st.units) {
      if (t.life !== 'up' || !hostile(me, t)) continue;
      const d = distFt(st, me.cell, t.cell);
      if ((melee > 0 && d <= me.b.moveFt + melee) || d <= ranged) return true;
      if (piece !== null) {
        for (let i = 0; i < me.landed.length; i++) {
          const c = me.landed[i]!;
          const r = piece[me.landGear[i]!]!;
          if (c >= 0 && r > 0 && distFt(st, me.cell, c) <= me.b.moveFt && distFt(st, c, t.cell) <= r) return true;
        }
      }
    }
    return false;
  }


  // ---- coverage 8'b G5: the target style ----

  /** How much `t` deals me per round (what `threat` ranks by, and killValue's figure before the horizon). */
  private threatOf(st: QueryState, me: Unit, t: Unit): number {
    const r = this.foeRoutine(st, t, me, acNow(me));
    return Math.max(r.melee, r.ranged);
  }

  /** G5: the enemy among `cands` the style narrows to from `from`: standing ones first, then nearest, or dealing me the most; the lower seat on a tie. -1 under `ev`. */
  private styleAmong(st: QueryState, me: Unit, from: number, cands: readonly Unit[]): number {
    const style = this.w.targetStyle;
    if (style === 'ev') return -1;
    let best = -1;
    let bestUp = false;
    let bestK = Infinity;
    for (const t of cands) {
      if (!hostile(me, t)) continue;
      const up = t.life === 'up';
      const k = style === 'nearest' ? this.dist(from, t.cell) : -this.threatOf(st, me, t);
      if (best < 0 || (up && !bestUp) || (up === bestUp && (k < bestK || (k === bestK && t.idx < best)))) [best, bestUp, bestK] = [t.idx, up, k];
    }
    return best;
  }

  /** G5: may a strike from `from` aim at `t` under the style? Always under `ev`; else only at the enemy it narrows to among this decision's pairs in range from there. */
  private styleOk(st: QueryState, me: Unit, from: number, t: Unit): boolean {
    if (this.w.targetStyle === 'ev') return true;
    let pick = this.styleMemo.get(from);
    if (pick === undefined) {
      const seen: Unit[] = [];
      for (let p = 0; p < this.pairAi.length; p++) {
        const c = st.units[this.pairT[p]!]!;
        const a = me.tpl.attacks[this.pairAi[p]!]!;
        if (!seen.includes(c) && this.inRange(st, a, c, from) && this.pickupFrom(st, me, a, from)) seen.push(c);
      }
      pick = this.styleAmong(st, me, from, seen);
      this.styleMemo.set(from, pick);
    }
    return pick < 0 || pick === t.idx;
  }

  // ---- coverage 8'b G7: the loadout as a state ----

  /** G7: does this strike draw a weapon into a hand (a throw's draw leaves the hand again; only an Attack-action strike draws)? */
  private drawsWeapon(me: Unit, atk: CompiledAttack): boolean {
    return atk.item !== undefined && !atk.throws && heldHand(me, atk.item) < 0;
  }

  /** G7: next turn's best strikes per attack (a full routine at whoever it can reach by next turn) and best cast per spell entry, hands aside. */
  private loadoutFigures(view: UnitView, me: Unit, v: VCtx): { atk: number[]; cast: number[] } {
    if (this.lo) return this.lo;
    const st = view.q;
    const spd = speedNow(me, st);
    const full = routineCount(me);
    const atk = me.tpl.attacks.map((a) => {
      if (a.spell || !gearOk(st, me, a.gear)) return 0;
      let b = 0;
      for (const t of st.units) {
        if (t.life !== 'up' || !hostile(me, t) || this.dist(me.cell, t.cell) > spd + (a.kind === 'melee' ? a.reachFt : a.longFt)) continue;
        b = Math.max(b, this.strikeAtk(view, me, a, t, me.cell));
      }
      return b * full;
    });
    const cast = me.tpl.spells.map((e, ei) => {
      const lv = e.spell.level;
      if (lv === 0) return this.castValue(v, me, ei, 0, false, me.cell);
      if (e.freePool >= 0 && me.res[e.freePool]! > 0) return this.castValue(v, me, ei, lv, true, me.cell);
      if (e.slotted) for (let l = lv; l <= 9; l++) if (me.res[l - 1]! > 0) return this.castValue(v, me, ei, l, false, me.cell);
      return 0;
    });
    this.lo = { atk, cast };
    return this.lo;
  }

  /** G7: the best option next turn holding `hands`, no hand change but an Attack-action strike's own draw (one switch). */
  private loadoutBest(view: UnitView, me: Unit, v: VCtx, hands: Int16Array): number {
    const st = view.q;
    const f = this.loadoutFigures(view, me, v);
    const u = (this.loUnit ??= { ...me }) as { hands: Int16Array } & Unit; // a what-if copy: only the hands differ
    u.hands = hands;
    let best = 0;
    for (let ai = 0; ai < f.atk.length; ai++) {
      const a = me.tpl.attacks[ai]!;
      if (f.atk[ai]! > 0 && canWield(u, a, true)) best = Math.max(best, f.atk[ai]! - (this.drawsWeapon(u, a) ? this.w.loadoutSwitch : 0));
    }
    for (let ei = 0; ei < f.cast.length; ei++) {
      const e = me.tpl.spells[ei]!;
      if (f.cast[ei]! > best && (e.whileHeld < 0 || hands[0] === e.whileHeld || hands[1] === e.whileHeld) && componentsOk(st, me, e, null, hands)) best = f.cast[ei]!;
    }
    return best;
  }

  /** G7: what `hands` is worth as a state: its best option next turn, or the best after next turn's free object interaction (one hand change, at a switch). */
  private loadoutValue(view: UnitView, me: Unit, v: VCtx, hands: Int16Array): number {
    const key = (hands[0]! + 2) * 4096 + hands[1]! + 2;
    const hit = this.loMemo.get(key);
    if (hit !== undefined) return hit;
    let best = this.loadoutBest(view, me, v, hands);
    const items = me.tpl.items;
    const change = (h: number, to: number) => {
      const next = Int16Array.from(hands);
      next[h] = to;
      best = Math.max(best, this.loadoutBest(view, me, v, next) - this.w.loadoutSwitch);
    };
    for (let h = 0; h < 2; h++) if (hands[h]! >= 0 && items[hands[h]!]!.kind !== 'shield') change(h, HAND.empty);
    const free = hands[0] === HAND.empty ? 0 : hands[1] === HAND.empty ? 1 : -1;
    if (free >= 0) {
      for (let i = 0; i < items.length; i++) {
        if (items[i]!.kind === 'shield' || hands[0] === i || hands[1] === i) continue;
        if (me.dropped[i]! >= 0 && me.dropped[i] !== me.cell) continue;
        change(free, i);
      }
    }
    this.loMemo.set(key, best);
    return best;
  }

  /**
   * G7: a hand change to `hands` now, for next turn: gamma x what the new state is worth over the
   * one I hold, each with next turn's free change counted, so a change next turn could make just as
   * well is worth nothing now, and one that next turn must undo counts against it. A draw is valued
   * for a later charge this way, not only for the Light attack or an opportunity attack.
   */
  private loadoutGain(view: UnitView, me: Unit, v: VCtx, hands: Int16Array): number {
    return this.w.gamma * (this.loadoutValue(view, me, v, hands) - this.loadoutValue(view, me, v, Int16Array.from(me.hands)));
  }

  // ---- programs (step 6) ----

  private dmgPmf(parts: readonly CompiledDamage[], t: Unit, crit: boolean, adv: boolean, half: boolean): Pmf {
    // W1 review: with live defense stats on `t` the template key would go stale (strikeAtk's guard):
    // cached by its masks now instead (maskPmf's key, and `half`).
    if (defStats(t)) return this.halfMaskPmf(parts, t, crit, adv, half);
    let byTpl = this.dmgs.get(parts);
    if (!byTpl) this.dmgs.set(parts, (byTpl = new Map()));
    let arr = byTpl.get(t.tpl);
    if (!arr) byTpl.set(t.tpl, (arr = [null, null, null, null, null, null, null, null]));
    const k = (crit ? 4 : 0) + (adv ? 2 : 0) + (half ? 1 : 0);
    return (arr[k] ??= damagePmf(parts, t, crit, adv, half));
  }

  /** P(failing a concentration save) at the usual DC 10, with whatever floors and modifiers apply now. */
  private concBreak(st: QueryState, me: Unit): number {
    if (me.idx !== this.meIdx) return 1 - saveOddsQuick(st, me); // another creature (a pre-roll reaction's target)
    if (this.concP !== this.concP) this.concP = 1 - saveOddsQuick(st, me);
    return this.concP;
  }

  /**
   * Per-round value of my live concentration (coverage 8'b G6, m7): everything under it, at what each
   * pays per round where it is now (value.ts lastingPerRound): a zone's rounds once, a buff or a mark.
   */
  private concValue(st: QueryState, me: Unit): number {
    if (this.conc === this.conc) return this.conc;
    this.conc = 0; // a floor on my concentration saves, read while walking this, sees none
    let v = 0;
    if (me.conc >= 0) {
      const ctx = this.vctxFor(st, me, null);
      for (const fx of st.fx) {
        if (!fx.alive || fx.id === me.conc) continue;
        let p = fx.parent;
        while (p >= 0 && p !== me.conc) p = st.fx[p]!.parent;
        if (p === me.conc) v += lastingPerRound(ctx, fx, boundOf(st, fx));
      }
    }
    this.conc = v;
    return v;
  }

  /** Coverage 8'b G6: what my live concentration still has in it: per round x its rounds left, within the fight, discounted. */
  private concLeft(st: QueryState, me: Unit): number {
    if (me.conc < 0) return 0;
    const u = st.fx[me.conc]!.until;
    const left = st.setup.knobs.maxRounds - st.round + 1;
    return this.concValue(st, me) * future(this.w, u.k === 'timed' && u.unit === me.idx ? Math.min(left, Math.max(0, u.turn - me.turns)) : left);
  }

  private vctxFor(st: QueryState, me: Unit, view: UnitView | null): VCtx {
    // Perf (W1): the context is closures over (st, me, view) only, never written by its readers: one per decision.
    const m = this.vctxMemo;
    if (m && m.st === st && m.me === me && m.view === view) return m.v;
    const v = this.vctxBuild(st, me, view);
    this.vctxMemo = { st, me, view, v };
    return v;
  }

  private vctxBuild(st: QueryState, me: Unit, view: UnitView | null): VCtx {
    const self = this;
    const qs = view ? view.scratch : this.lastScratch!;
    return {
      st,
      qs,
      me,
      w: this.w,
      dist: (a, b) => self.dist(a, b),
      dmg: (parts, t, crit, adv, half) => self.dmgPmf(parts, t, crit, adv, half),
      killValue: (t) => self.killValue(st, me, t),
      progress: (t, nonLethal) => self.progressValue(st, me, t, nonLethal),
      threat: (t, cell) => self.threatTo(st, t, cell),
      dropCut: (t, cell, gain) => {
        if (t === me && dropSafe(me)) return 0; // W1 (P8): my next drop doesn't happen, so there's none to cut
        const e = t === me ? self.exposure(st, me, cell) : self.threatTo(st, t, cell);
        return pDrop(e, t.hp + t.tempHp) - pDrop(e, t.hp + t.tempHp + gain);
      },
      allyStrike: (t) => {
        let best = 0;
        for (const u of st.units) {
          if (u === me || u.life !== 'up' || u.team !== me.team) continue;
          const r = self.foeRoutine(st, u, t, acNow(t)); // conditions on either count (M3 step 4 carry-over)
          best = Math.max(best, r.melee, r.ranged);
        }
        return best;
      },
      concValue: () => self.concValue(st, me),
      stay: (from, conc) => {
        const e = self.exposure(st, me, from);
        const up = dropSafe(me) ? 1 : 1 - pDrop(e, me.hp + me.tempHp); // W1 (P8)
        return conc ? up * Math.max(0, 1 - self.concBreak(st, me) * Math.min(3, e / HIT)) : up;
      },
      styleOf: (from, cands) => self.styleAmong(st, me, from, cands),
      concSaves: () => Math.min(3, self.exposure(st, me, me.cell) / HIT),
      meanOf: (e) => {
        let m = self.exprMeans.get(e);
        if (m === undefined) self.exprMeans.set(e, (m = mean(exprPmf(e))));
        return m;
      },
      zoneCache: this.zoneCache,
      aimCache: this.aimCache,
      pullCache: this.pullCache,
      riderMemo: this.riderMemo,
      routineX: (a, d, melee, ranged) => self.routineX(st, a, d, melee, ranged),
      mute: 0,
      weaponStrike: (s, from, grant, mute, first) => self.weaponStrike(st, me, s, from, grant, mute, first),
      pushPlace: (t, cell) => self.pushPlace(st, me, t, cell),
      laterStrike: () => self.strikesAfter(me) > 0,
      laterStrikes: () => self.strikesAfter(me),
      dodge: (cell) => (me.idx === self.meIdx ? self.dodgeValue(st, me, cell) : 0),
      dash: () => self.dashValue(st, me),
      extraAction: () => self.extraActionValue(st, me),
      poolGain: (res, delta) => pointsValue(self.w, self.pointBase(st, me, res, null), me.res[res]!, delta),
      ...(view && me.tpl.riders
        ? {
            riderOn: (ri: number, t: Unit, ignoreSelfHas: boolean) => self.riderOnValue(view, me, ri, t, ignoreSelfHas),
            spellAttackRiders: (atk: CompiledAttack, t: Unit, hitP: number, roll?: AdvState) => self.freeRiders(view, me, atk, t, '', hitP, null, roll ?? 'none'),
          }
        : {}),
      // W1 (docs/design/w1-plan.md): only for a template with a W1 field (w1.ts w1Kit), so every other VCtx is built as before.
      ...(view && w1Kit(me.tpl)
        ? {
            concLeft: () => self.concLeft(st, me),
            castMargin: () => self.castMargin(view, me),
            hitsPerRound: (ri: number, t: Unit) => self.hitsPerRound(view, me, ri, t),
            freeMove: (from: number) => self.freeMoveValue(st, me, from),
            advGain: (from: number) => self.advGain(view, me, from),
            rollComing: () => self.tc !== null && self.tc.canAttack && self.tc.engaged,
            restartCost: (rootTpl: number) => self.restartCost(st, me, rootTpl),
          }
        : {}),
      prefersMelee: (u) => {
        // It walks up to fight if melee is its better routine, or nothing it can shoot is in normal range.
        const r = self.routine(st, u, acNow(me));
        if (r.melee > r.ranged) return true;
        let near = Infinity;
        for (const o of st.units) if (o.life === 'up' && o.team !== u.team) near = Math.min(near, self.dist(u.cell, o.cell));
        return near > r.rangeFt;
      },
    };
  }
  private lastScratch: UnitView['scratch'] | null = null;

  /** Expected damage `t` could take on `cell` before its next turn, from its hostiles (heal danger). */
  private threatTo(st: QueryState, t: Unit, cell: number): number {
    const ac = acNow(t);
    let total = 0;
    for (const e of st.units) {
      if (e.life !== 'up' || !hostile(e, t) || has(e, COND.incapacitated)) continue;
      if (e.condMask & COND.charmed && charmedBy(e, t)) continue;
      const r = this.foeRoutine(st, e, t, ac);
      const how = threatKind(this.dist(e.cell, cell), frightened(st, e, t) ? 0 : speedNow(e), r);
      if (how) total += how === 'melee' ? r.melee : r.ranged;
    }
    return total;
  }

  /** What casting spell entry `opt` at `lvl` (free or not) from `from` is worth, net of its cost and the concentration it replaces. */
  private castValue(v: VCtx, me: Unit, opt: number, lvl: number, free: boolean, from: number): number {
    // G7 reads every spell's value on each item decision, most of them just valued as options: one walk per decision (perf only; never under an explain what-if).
    if (v.mute !== 0 || from !== me.cell || me.idx !== this.meIdx) return this.castValueExact(v, me, opt, lvl, free, from);
    const key = (opt * 16 + lvl) * 2 + (free ? 1 : 0);
    let x = this.castMemo.get(key);
    if (x === undefined) this.castMemo.set(key, (x = this.castValueExact(v, me, opt, lvl, free, from)));
    return x;
  }

  private castValueExact(v: VCtx, me: Unit, opt: number, lvl: number, free: boolean, from: number): number {
    const e = me.tpl.spells[opt]!;
    const prog = e.prog[lvl];
    if (!prog) return -Infinity;
    const inst = e.instance[lvl] ?? -1;
    const te = inst >= 0 ? me.tpl.effects[inst]! : null;
    const rounds = te && te.dur.k === 'rounds' ? te.dur.n : 10;
    // Recasting a spell that replaces its live copy (a conjured flame) gains nothing.
    if (e.spell.recast === 'replace' && v.st.fx.some((x) => x.alive && x.owner === me.idx && x.sid === e.spell.sid)) return -0.01;
    // Coverage 8'b G6: what a concentration spell does after its first round counts only while it's
    // running: the program's lasting terms read my chance of staying up and keeping it, where I end.
    // Session S: `spell` only for a caster with a spellDamage rider, so no other walk changes.
    let val = programValue(v, prog, from, { rangeFt: e.spell.rangeFt, parentRounds: rounds, ...(hasSpellRiders(me) ? { spell: true as const } : {}), ...(e.spell.conc && rounds > 1 ? { stay: v.stay(from, true) } : {}) });
    if (e.spell.conc && me.conc >= 0) {
      // A policy holding this concentration never replaces it (design 2.2).
      const sid = v.st.fx[me.conc]!.sid;
      if (this.hold.length > 0 && me.tpl.spells.some((x) => x.spell.sid === sid && this.hold.includes(x.spell.id))) return -Infinity;
      val -= this.concLeft(v.st, me);
    }
    return val - (free ? this.w.freeCast : lvl > 0 ? this.w.slotPerLevel * lvl : 0);
  }

  /** What a granted option or feature activation is worth from `from`, net of its cost. */
  /**
   * Greedy v11: what using a pulse activation worth `val` next turn instead keeps of it: gamma x P(I
   * stay up on `from`) x `val`; nothing in the fight's last round (there is no next turn).
   */
  private deferral(v: VCtx, val: number, from: number): number {
    if (v.st.round >= v.st.setup.knobs.maxRounds) return 0;
    return this.w.gamma * v.stay(from, false) * val;
  }

  private useValue(v: VCtx, me: Unit, l: Legal, from: number): number {
    const st = v.st;
    if (l.fx < 0) {
      const f = me.tpl.features[l.opt]!;
      if (!f.activate) return -Infinity;
      const a = activationOf(f, l.aux);
      const cost = this.activationCost(st, me, f, a);
      const rootFx = a.root >= 0 ? st.fx.find((x) => x.alive && x.owner === me.idx && x.tpl === a.root) : undefined;
      if (rootFx) {
        // Already active: using it again only switches options, worth the gain over the current one.
        const vals = chooseValues(v, a.steps, from);
        const child = st.fx.find((x) => x.alive && x.parent === rootFx.id);
        const choose = a.steps.find((x) => x.k === 'choose');
        if (!vals || !child || !choose || choose.k !== 'choose') return -cost;
        const cur = choose.opts.findIndex((o) => o.steps.some((x) => x.k === 'apply' && x.fx === child.tpl));
        return Math.max(...vals) - (cur >= 0 ? vals[cur]! : 0) - cost;
      }
      let val = programValue(v, a.steps, from, { parentRounds: 100, grant: a.local, actCost: a.cost, ...(a.self ? { targets: [me] } : {}), ...(a.area ? { rangeFt: a.area.rangeFt } : {}) }) - cost;
      // W1 (P1): a sustained root (Rage) is what the activation is for: its own value on me (stats, riders it
      // switches on, per expected hit), as an apply of it would be valued. Other roots keep their children's
      // value only, as before (C3).
      if (a.root >= 0 && me.tpl.effects[a.root]!.sustain !== undefined) val += programValue(v, [{ k: 'apply', fx: a.root, to: 'self' }], from, { parentRounds: 100 });
      // Greedy v11 (session S follow-up): a lasting self effect with a turn-end Emanation pulse (and the
      // riders it switches on) is as good next turn as now, so using it now gains only what waiting
      // would lose: its value less gamma x P(I'm up next turn) x the same value then [U: the same value
      // from the same square]. Unspent, the Bonus Action goes to what can't wait (a heal on someone
      // about to drop). Any other activation reads as before.
      if (val > 0 && !(v.mute & TERM.defer) && appliesPulse(a.steps, me.tpl.effects)) return val - this.deferral(v, val, from);
      return a.book && this.bookCovers(v, me, a, from, val) ? val + BOOK_FIRST : val;
    }
    const fx = st.fx[l.fx]!;
    const g = boundOf(st, fx).grants[l.opt];
    if (!g) return -Infinity;
    const move = g.steps.find((x) => x.k === 'moveZone');
    if (move && move.k === 'moveZone') {
      // Moving my zone: the best landing's hooks on everyone the move catches (a swept ally
      // counts against it), against what it's doing where it is.
      let best = 0;
      for (const a of this.moveAnchors(st, me, fx.anchor, move.ft)) best = Math.max(best, moveZoneAnchorValue(v, fx.id, a));
      return best - zoneHoldValue(v, fx.id);
    }
    return programValue(v, g.steps, from, { srcFx: fx.id });
  }

  /**
   * Where moving a zone is worth trying: onto each standing enemy within `ft` of its anchor.
   * Square-centered anchors are the enemies' squares; grid-corner anchors are the four corners
   * of each enemy's square (anchor-to-anchor feet, as the engine measures a zone move).
   */
  private moveAnchors(st: QueryState, me: Unit, anchor: number, ft: number): number[] {
    const out: number[] = [];
    const corner = readFlag(st, 'areaOriginOnGrid') === 'gridIntersection';
    const w = st.setup.w;
    for (const u of st.units) {
      if (u.life !== 'up' || u.team === me.team) continue;
      if (!corner) {
        if (this.dist(anchor, u.cell) <= ft) out.push(u.cell);
        continue;
      }
      const x = u.cell % w;
      const y = Math.floor(u.cell / w);
      for (const a of [y * (w + 1) + x, y * (w + 1) + x + 1, (y + 1) * (w + 1) + x, (y + 1) * (w + 1) + x + 1]) {
        if (!out.includes(a) && anchorDistFt(st, anchor, a) <= ft) out.push(a);
      }
    }
    return out;
  }

  /**
   * Picking up, drawing or donning an item (design 1.2): what it gives back. A shield: the
   * damage its AC saves over the horizon. Anything else: the best cast it makes legal again this
   * turn (a focus for Material components, an item a spell is prepared only while holding);
   * next turn's is loadoutGain's (coverage 8'b G7). A held weapon (M3 step 5b): weaponDrawValue
   * (an Attack-action strike draws its own weapon for free).
   */
  private itemValue(v: VCtx, me: Unit, item: number): number {
    const st = v.st;
    const it = me.tpl.items[item]!;
    if (it.kind === 'shield') {
      const ac = acNow(me);
      let saved = 0;
      for (const f of this.foes) {
        const how = this.threatens(st, f, me.cell);
        if (!how) continue;
        const r = this.routine(st, f.u, ac + it.shieldAc);
        saved += (how === 'melee' ? f.r.melee - r.melee : f.r.ranged - r.ranged) / f.victims;
      }
      return this.side(me).exposure * saved * future(this.w);
    }
    if (it.kind === 'weapon') return this.weaponDrawValue(this.curView!, me, item); // M3 step 5b
    const hands = [me.hands[0]!, me.hands[1]!];
    const h = hands[0] === HAND.empty ? 0 : hands[1] === HAND.empty ? 1 : -1;
    if (h < 0) return 0;
    hands[h] = item;
    return this.castsUnlocked(v, me, hands, me.b.freeObj === 0);
  }

  /**
   * The best cast that holding `hands` (instead of what I hold) makes legal this turn: a focus for
   * Material components, an item a spell is prepared only while holding, or (M3 step 5b) a free
   * hand for Somatic components. `usesAction`: the hand change itself spends the Action. A cast
   * only next turn is loadoutGain's (coverage 8'b G7).
   */
  private castsUnlocked(v: VCtx, me: Unit, hands: number[], usesAction: boolean): number {
    const st = v.st;
    let best = 0;
    for (let ei = 0; ei < me.tpl.spells.length; ei++) {
      const e = me.tpl.spells[ei]!;
      const sp = e.spell;
      if ((e.whileHeld < 0 || heldHand(me, e.whileHeld) >= 0) && componentsOk(st, me, e, null)) continue; // castable already
      if ((e.whileHeld >= 0 && !hands.includes(e.whileHeld)) || !componentsOk(st, me, e, null, hands)) continue;
      const budget = sp.cast === 'action' ? me.b.action - (usesAction ? 1 : 0) > 0 : me.b.bonus > 0;
      const levels: [number, boolean][] = [];
      if (sp.level === 0) levels.push([0, false]);
      else {
        if (e.freePool >= 0 && me.res[e.freePool]! > 0) levels.push([sp.level, true]);
        if (e.slotted) for (let lvl = sp.level; lvl <= 9; lvl++) if (me.res[lvl - 1]! > 0) levels.push([lvl, false]);
      }
      for (const [lvl, free] of levels) {
        const val = this.castValue(v, me, ei, lvl, free, me.cell);
        if (!(val > 0)) continue;
        if (budget && (sp.level === 0 || free || me.slotTurn !== st.turnIdx)) best = Math.max(best, val);
      }
    }
    return best;
  }

  /**
   * Explain (M3 step 4, C6): each new term's share of a program's value, found by valuing it
   * again with that term switched off (VCtx.mute; caches bypassed), listed only when nonzero, so
   * an option without conditions, stats or temp HP shows exactly what it did before.
   */
  private termParts(v: VCtx, me: Unit, l: Legal, full: number, again: (vv: VCtx) => number): ExplainPart[] {
    if (!(full > -Infinity)) return [];
    const st = v.st;
    const feat = l.k !== 'cast' && l.fx < 0 ? me.tpl.features[l.opt]! : null;
    const steps = l.k === 'cast' ? (me.tpl.spells[l.opt]!.prog[l.lvl] ?? []) : feat ? (feat.activate ? activationOf(feat, l.aux).steps : []) : (boundOf(st, st.fx[l.fx]!).grants[l.opt]?.steps ?? []);
    const names = programLabels(me, steps);
    const conds = names.conds.length > 0 ? names.conds.join('+') : 'condition';
    const terms: [number, string][] = [
      [TERM.condOut, `${conds}: its lost actions`],
      [TERM.condIn, `${conds}: attacks against it`],
      [TERM.stat, `stats (${names.stats.length > 0 ? names.stats.join(', ') : 'none'})`],
      [TERM.thp, 'temp HP'],
      [TERM.escape, 'escape: the condition it ends'],
      // M3 step 5a (econ.ts).
      [TERM.strikes, 'weapon strikes'],
      [TERM.rider, 'riders on its hits'],
      [TERM.dodge, DODGE_TERM],
      [TERM.econ, 'Dash or extra action: the strikes it brings'],
      [TERM.pool, 'points regained'],
      [TERM.progress, PROGRESS_TERM],
      [TERM.lasting, 'lasting effect: its per-round payoff x its expected rounds left'],
      // Session S (repo half).
      [TERM.around, 'around me: every creature in the Emanation (allies count against)'],
      [TERM.selfRider, 'riders it switches on (selfHas): P(I deal damage) x the extra, per round'],
      [TERM.spellRider, 'a rider on this spell\'s damage (spellDamage or a spell attack\'s)'],
      // Greedy v11.
      [TERM.pulseLater, "my pulse's later rounds: no kill or progress credit (a foe drops once)"],
      [TERM.defer, 'using it next turn instead: gamma x P(I am up then) x its value'],
      // W1 (docs/design/w1-plan.md).
      [TERM.sustain, 'sustained: its expected rounds past this one (kept up by an attack roll, a save or a Bonus Action)'],
      [TERM.extend, 'extend: keeps it a round (it would end at the end of this turn)'],
      [TERM.noConc, 'ends my concentration'],
      [TERM.noCast, 'no spells while it lasts: the best cast over my best other option this turn'],
      [TERM.perHit, 'riders it switches on, per expected hit (strikes x P(hit)) over once a round'],
      [TERM.selfAdv, 'Advantage on my next attack roll (the riders it unlocks included)'],
      [TERM.endCond, `ends ${condNames(endBits(steps))} on me`],
      [TERM.freeMove, 'free move (no opportunity attacks): the exposure it takes off'],
    ];
    const out: ExplainPart[] = [];
    for (const [bit, term] of terms) {
      const d = full - again({ ...v, mute: bit });
      if (Q(d) !== 0 && d === d) out.push({ term, ev: d });
    }
    if (feat?.activate) {
      const a = activationOf(feat, l.aux);
      if (a.pool >= 0 && this.newCostModel(feat, a)) out.push({ term: `${me.tpl.pools[a.pool - 9]!.name} spent: what else it could buy`, ev: -this.activationCost(st, me, feat, a) });
    }
    return out;
  }

  /** The programs a sub-decision with this `via` could come from: a spell (at the level the decision carries, else its lowest), an effect's grants, a feature. */
  private programsFor(me: Unit, via: string, castLvl?: number): { steps: readonly Step[]; rangeFt: number; rounds: number }[] {
    const out: { steps: readonly Step[]; rangeFt: number; rounds: number }[] = [];
    for (const e of me.tpl.spells) {
      if (e.spell.id !== via) continue;
      const lvl = castLvl ?? e.prog.findIndex((x) => x !== null);
      const prog = e.prog[lvl];
      if (prog) out.push({ steps: prog, rangeFt: e.spell.rangeFt, rounds: 10 });
    }
    for (const te of me.tpl.effects) if (te.id === via) for (const g of te.grants) out.push({ steps: g.steps, rangeFt: 0, rounds: 10 });
    for (const f of me.tpl.features) {
      if (f.id !== via) continue;
      if (f.activate) out.push({ steps: f.activate.steps, rangeFt: f.activate.area?.rangeFt ?? 0, rounds: 100 });
      for (const a of f.more ?? []) out.push({ steps: a.steps, rangeFt: a.area?.rangeFt ?? 0, rounds: 100 });
      if (f.onInit) out.push({ steps: f.onInit.steps, rangeFt: 0, rounds: 100 });
    }
    return out;
  }

  private target(view: UnitView, dp: DecisionPoint): number {
    const st = view.q;
    const me = st.units[view.me]!;
    if (dp.legal.n > 0 && dp.legal.items[0]!.k === 'attack') return this.strikeTarget(view, dp);
    const v = this.vctxFor(st, me, view);
    const progs = this.programsFor(me, dp.src?.via ?? '', dp.src?.lvl);
    let best = 0;
    let bestV = -Infinity;
    // Coverage 8'b G5: a target style narrows the enemies on offer to one.
    const narrowed = this.w.targetStyle === 'ev' ? -1 : this.styleAmong(st, me, me.cell, Array.from({ length: dp.legal.n }, (_, i) => st.units[dp.legal.items[i]!.target]!));
    for (let i = 0; i < dp.legal.n; i++) {
      const t = dp.legal.items[i]!.target;
      if (narrowed >= 0 && t !== narrowed && st.units[t]!.team !== me.team) continue;
      let val = -Infinity;
      for (const p of progs) val = Math.max(val, programValue(v, p.steps, me.cell, { target: t, rangeFt: p.rangeFt, parentRounds: p.rounds }));
      if (val === -Infinity) val = st.units[t]!.team !== me.team ? -st.units[t]!.hp : -1000; // no program found: the weakest enemy
      if (Q(val) > Q(bestV)) [bestV, best] = [val, i];
    }
    return best;
  }

  private place(view: UnitView, dp: DecisionPoint): number {
    const st = view.q;
    const me = st.units[view.me]!;
    const v = this.vctxFor(st, me, view);
    const via = dp.src?.via ?? '';
    const n = dp.legal.n;
    // Moving a live zone of mine.
    const live = st.fx.find((f) => f.alive && f.owner === me.idx && f.zbit >= 0 && boundOf(st, f).id === via);
    if (live) {
      let best = 0;
      let bestV = -Infinity;
      for (let i = 0; i < n; i++) {
        const val = moveZoneAnchorValue(v, live.id, dp.legal.items[i]!.cell);
        if (Q(val) > Q(bestV)) [bestV, best] = [val, i];
      }
      return best;
    }
    // Placing a new zone: its apply-to-point effect, tried at the decider's candidate anchors that are legal.
    for (const e of me.tpl.spells) {
      if (e.spell.id !== via) continue;
      const lvl = dp.src?.lvl ?? e.prog.findIndex((x) => x !== null);
      const apply = (e.prog[lvl] ?? []).find((x) => x.k === 'apply' && x.to === 'point');
      if (!apply || apply.k !== 'apply') continue;
      const te = me.tpl.effects[apply.fx]!;
      if (!te.zone) continue;
      const index = new Map<number, number>();
      for (let i = 0; i < n; i++) index.set(dp.legal.items[i]!.cell, i);
      const inst = e.instance[lvl] ?? -1;
      const rounds = inst >= 0 && me.tpl.effects[inst]!.dur.k === 'rounds' ? (me.tpl.effects[inst]!.dur as { n: number }).n : 10;
      let best = 0;
      let bestV = -Infinity;
      const stay = e.spell.conc && rounds > 1 ? v.stay(me.cell, true) : 1; // coverage 8'b G6, as castValue valued it
      if (te.zone.from === 'aim') return this.bestAim(v, te, me.cell, rounds, stay, index)?.i ?? 0;
      for (const a of zoneAnchors(v, te, me.cell, e.spell.rangeFt)) {
        const i = index.get(a);
        if (i === undefined) continue;
        const val = zoneValue(v, te, a, rounds, stay);
        if (Q(val) > Q(bestV) || (Q(val) === Q(bestV) && i < best)) [bestV, best] = [val, i];
      }
      return best;
    }
    // A feature activation's area: its decision names the activation (sim/cast.ts activate).
    for (const f of me.tpl.features) {
      for (let k = 0; f.activate && k < 1 + (f.more?.length ?? 0); k++) {
        const a = activationOf(f, k);
        if (!a.area || `${f.id}/${a.local}` !== via) continue;
        const te = this.zoneOf(me, a.steps);
        if (!te) continue;
        const index = new Map<number, number>();
        for (let i = 0; i < n; i++) index.set(dp.legal.items[i]!.cell, i);
        if (te.zone!.from === 'aim') return this.bestAim(v, te, me.cell, 100, 1, index)?.i ?? 0;
        let best = 0;
        let bestV = -Infinity;
        for (const x of zoneAnchors(v, te, me.cell, a.area.rangeFt)) {
          const i = index.get(x);
          if (i === undefined) continue;
          const val = zoneValue(v, te, x, 100);
          if (Q(val) > Q(bestV) || (Q(val) === Q(bestV) && i < best)) [bestV, best] = [val, i];
        }
        return best;
      }
    }
    return 0;
  }

  /** The zone a program places (apply to: point), if it places one. */
  private zoneOf(me: Unit, steps: readonly Step[]): BoundEffect | null {
    const s = steps.find((x) => x.k === 'apply' && x.to === 'point');
    const te = s && s.k === 'apply' ? me.tpl.effects[s.fx]! : null;
    return te?.zone ? te : null;
  }

  /** Coverage step 7.2: a listed cast or activation whose area is aimed: its zone and the rounds it was valued for; null for any other option. */
  private aimedOption(me: Unit, l: Legal): { te: BoundEffect; rounds: number; stay: boolean } | null {
    if (l.k === 'cast') {
      const e = me.tpl.spells[l.opt]!;
      if (e.spell.areaFrom !== 'aim') return null;
      const te = this.zoneOf(me, e.prog[l.lvl] ?? []);
      if (!te) return null;
      const inst = e.instance[l.lvl] ?? -1;
      const dur = inst >= 0 ? me.tpl.effects[inst]!.dur : null;
      const rounds = dur && dur.k === 'rounds' ? dur.n : 10;
      return { te, rounds, stay: e.spell.conc && rounds > 1 };
    }
    if (l.k !== 'use' || l.fx >= 0) return null;
    const f = me.tpl.features[l.opt]!;
    if (!f.activate) return null;
    const a = activationOf(f, l.aux);
    const te = a.area?.from === 'aim' ? this.zoneOf(me, a.steps) : null;
    return te ? { te, rounds: 100, stay: false } : null;
  }

  /** The aim worth most from `from`, among aimCandidates and (`index`, a place decision's) what's legal. Null with no candidate. */
  private bestAim(v: VCtx, te: BoundEffect, from: number, rounds: number, stay: number, index?: Map<number, number>): { i: number; val: number; n: number } | null {
    let out: { i: number; val: number; n: number } | null = null;
    for (const c of aimCandidates(v, te, from)) {
      const i = index ? index.get(c.aim) : c.aim;
      if (i === undefined) continue;
      const val = zoneValue(v, te, from, rounds, stay, c.aim);
      if (!out || Q(val) > Q(out.val)) out = { i, val, n: c.nEnemies + c.nAllies };
    }
    return out;
  }

  /**
   * Coverage step 7.6, the book rule (srd-raw.txt:43608-43615): a monster uses its limited high-damage
   * ability "as quickly and as often as possible", and Multiattack otherwise. "Possible" here is at
   * least one enemy under it from `from`. A targeted one is worth something only with a target in reach.
   */
  private bookCovers(v: VCtx, me: Unit, a: CompiledActivation, from: number, val: number): boolean {
    // Worth nothing net (its best aim costs my side as much as it gives: friendly fire), it isn't "possible"
    // play, and the bonus would make place() fire a losing aim; Multiattack then, as the book says otherwise.
    if (!(val > 0)) return false;
    const te = this.zoneOf(me, a.steps);
    if (!te) return true;
    if (a.area?.from === 'aim') return aimCandidates(v, te, from).some((c) => c.nEnemies > 0);
    return zoneAnchors(v, te, from, a.area?.rangeFt ?? 0).length > 0;
  }

  /** Explain's line for the book rule, when it applies from `from`. */
  private bookParts(v: VCtx, me: Unit, l: Legal, from: number, val: number): ExplainPart[] {
    if (l.k !== 'use' || l.fx >= 0) return [];
    const f = me.tpl.features[l.opt]!;
    const a = f.activate ? activationOf(f, l.aux) : null;
    return a?.book && this.bookCovers(v, me, a, from, val - BOOK_FIRST) ? [{ term: BOOK_TERM, ev: BOOK_FIRST }] : [];
  }

  /** Explain's line for an aimed option: the creatures its best aim covers. */
  private aimParts(v: VCtx, me: Unit, l: Legal, from: number): ExplainPart[] {
    const o = this.aimedOption(me, l);
    const b = o ? this.bestAim(v, o.te, from, o.rounds, o.stay ? v.stay(from, true) : 1) : null;
    return b ? [{ term: `aim: ${b.n} creatures`, ev: b.val }] : [];
  }

  /**
   * Coverage step 7.2: an aimed area I could use next turn, per enemy: its value cast from the square
   * next to that enemy on my side [U: that square stands in for the best one], reached like a strike
   * of 5 ft (nextWorth). Lets a caster walk toward a Cone; a spell as nextTurnCast picks its level, a
   * feature as healsNext reads its limits.
   */
  private aimedNext(st: QueryState, me: Unit, v: VCtx, out: NextEntry[]): void {
    if (has(me, COND.incapacitated)) return;
    const w = st.setup.w;
    const each = (val: (from: number) => number) => {
      for (const t of st.units) {
        if (t.life !== 'up' || !hostile(me, t)) continue;
        const x = t.cell % w;
        const y = Math.floor(t.cell / w);
        const stand = (y + Math.sign(Math.floor(me.cell / w) - y)) * w + x + Math.sign((me.cell % w) - x);
        const sv = val(stand);
        if (sv > 0) out.push({ cell: t.cell, reach: 5, v: sv, rescue: false, aim: true });
      }
    };
    me.tpl.spells.forEach((e, ei) => {
      if (e.spell.areaFrom !== 'aim' || !this.castableNext(st, me, e)) return;
      const lv = e.spell.level;
      if (lv === 0) return each((from) => this.castValue(v, me, ei, 0, false, from));
      if (e.freePool >= 0 && me.res[e.freePool]! > 0) return each((from) => this.castValue(v, me, ei, lv, true, from));
      if (e.slotted) for (let l = lv; l <= 9; l++) if (me.res[l - 1]! > 0) return each((from) => this.castValue(v, me, ei, l, false, from));
    });
    me.tpl.features.forEach((f, fi) => {
      for (let k = 0; f.activate && k < 1 + (f.more?.length ?? 0); k++) {
        const a = activationOf(f, k);
        if (a.area?.from !== 'aim' || a.cost === 'reaction' || (a.pool >= 0 && me.res[a.pool]! < poolCostOf(a)) || (a.when && !gatesOk(st, me, a.when))) continue;
        const l = this.scratchUse;
        each((from) => {
          Object.assign(l, { k: 'use', fx: -1, opt: fi, aux: f.more ? k : -1 });
          return this.useValue(v, me, l, from);
        });
      }
    });
  }

  private pick(view: UnitView, dp: DecisionPoint): number {
    const st = view.q;
    const me = st.units[view.me]!;
    const v = this.vctxFor(st, me, view);
    const hook = me.tpl.features.find((f) => f.id === dp.src?.via && f.onInit);
    if (hook && dp.legal.n === 2 && dp.legal.items[0]!.opt === 0 && dp.legal.items[1]!.opt === 1) return this.initHook(view, dp, me, hook.onInit!, v);
    for (const p of this.programsFor(me, dp.src?.via ?? '', dp.src?.lvl)) {
      const vals = chooseValues(v, p.steps, me.cell);
      if (!vals) continue;
      let best = 0;
      let bestV = -Infinity;
      for (let i = 0; i < dp.legal.n; i++) {
        const val = vals[dp.legal.items[i]!.opt] ?? -Infinity;
        if (Q(val) > Q(bestV)) [bestV, best] = [val, i];
      }
      return best;
    }
    return 0; // a skill for a check, or nothing known: the first
  }

  private pull(view: UnitView, dp: DecisionPoint): number {
    const st = view.q;
    const me = st.units[view.me]!;
    let plan = this.pulls.get(dp.cause);
    if (!plan) {
      plan = { cells: [], k: 0 };
      const t = dp.src?.target !== undefined ? st.units[dp.src.target] : undefined;
      const step = t ? this.forcedStepFor(me, dp.src?.via ?? '', dp.src?.lvl) : null;
      if (t && step) {
        const [, path] = bestPull(this.vctxFor(st, me, view), t, step, me.cell);
        if (path) plan = { cells: path.cells, k: 0 };
      }
      this.pulls.set(dp.cause, plan);
    }
    const want = plan.cells[plan.k++] ?? -1;
    for (let i = 0; i < dp.legal.n; i++) if (dp.legal.items[i]!.cell === want) return i;
    for (let i = 0; i < dp.legal.n; i++) if (dp.legal.items[i]!.cell < 0) return i; // stop
    return 0;
  }

  private forcedStepFor(me: Unit, via: string, castLvl?: number): Extract<Step, { k: 'forced' }> | null {
    const find = (steps: readonly Step[]): Extract<Step, { k: 'forced' }> | null => {
      for (const s of steps) {
        if (s.k === 'forced') return s;
        const inner = s.k === 'attack' ? find(s.onHit) : s.k === 'save' ? find(s.onFail) : s.k === 'choose' ? s.opts.map((o) => find(o.steps)).find((x) => x) ?? null : null;
        if (inner) return inner;
      }
      return null;
    };
    for (const p of this.programsFor(me, via, castLvl)) {
      const s = find(p.steps);
      if (s) return s;
    }
    return null;
  }

  /** A pre-roll reaction: the roll's odds with and without the die, times what the roll decides. */
  private preRoll(view: UnitView, dp: DecisionPoint): number {
    const st = view.q;
    const me = st.units[view.me]!;
    const spec = dp.roll;
    let pass = 0;
    for (let i = 0; i < dp.legal.n; i++) if (dp.legal.items[i]!.k === 'pass') pass = i;
    if (!spec || dp.roller === undefined) return pass;
    const roller = st.units[dp.roller]!;
    const target = dp.rollTarget !== undefined && dp.rollTarget >= 0 ? st.units[dp.rollTarget]! : null;
    const base = rollOdds(spec, oddsFlags(st));
    let best = pass;
    let bestV = -Infinity;
    for (let i = 0; i < dp.legal.n; i++) {
      const l = dp.legal.items[i]!;
      if (l.k !== 'react') continue;
      const pr = me.tpl.features[l.opt]?.preRoll;
      if (!pr) continue;
      const left = Math.max(1, me.res[pr.pool] ?? 1);
      if (bestV === -Infinity) bestV = (this.w.reactMin * 4) / left;
      const die = l.aux > 0 ? pr.die : { k: 'neg' as const, a: pr.die };
      const after = rollOdds({ ...spec, extDice: [...(spec.extDice ?? []), die] }, oddsFlags(st));
      const dP = after.pSuccess - base.pSuccess; // > 0: more likely to succeed
      const mine = roller.team === me.team;
      let stake = 0;
      if (spec.kind === 'attack' && target) {
        // What the attack's hit does to its target (its damage if it's a weapon of the roller's), plus a concentration break.
        const atk = roller.tpl.attacks.find((a) => a.id === dp.rollVia);
        const dmg = atk ? mean(this.dmgPmf(atk.damage, target, false, false, false)) : HIT;
        stake = dmg + (target.conc >= 0 ? this.concBreak(st, target) * this.concLeft(st, target) : 0);
        if (target.team === me.team) stake = -stake; // a hit on my side is bad for me
        stake = mine ? Math.abs(stake) : stake;
      } else if (spec.kind === 'save') {
        // A save: against my effect (failing helps me), or my side's own (succeeding helps me; a concentration save keeps my spell).
        const keep = roller.conc >= 0 && dp.rollVia !== undefined ? this.concLeft(st, roller) : HIT;
        stake = mine ? keep : -HIT;
      }
      const val = dP * stake;
      if (val > bestV) [bestV, best] = [val, i];
    }
    return best;
  }

  // ---- coverage 8'b: the hit-known and damage-taken windows, valued (M3 step 8'a built them) ----

  /**
   * What a hit-known or damage-taken reaction's use costs: its points at what else they could buy, at
   * least what the pre-roll window asks of a use (reactMin x 4 / uses left: spent more freely while plentiful).
   */
  private reactionCost(st: QueryState, me: Unit, h: { readonly pool: number; readonly poolCost?: number }): number {
    if (h.pool < 0) return 0;
    return Math.max(this.pointsCost(st, me, h.pool, h.poolCost ?? 1, h), (this.w.reactMin * 4) / Math.max(1, me.res[h.pool]!));
  }

  /** My best opportunity attack on a hostile in my reach right now (what a Reaction spent now gives up, at OA_SHARE). */
  private oaHere(view: UnitView, me: Unit): number {
    const st = view.q;
    let oa = 0;
    for (let ai = 0; ai < me.tpl.attacks.length; ai++) {
      const a = me.tpl.attacks[ai]!;
      if (a.kind !== 'melee' || a.spell || !gearOk(st, me, a.gear) || !canWield(me, a)) continue;
      for (const t of st.units) if (t.life === 'up' && hostile(me, t) && this.dist(me.cell, t.cell) <= a.reachFt) oa = Math.max(oa, this.strike(view, me, ai, t, me.cell, true));
    }
    return oa;
  }

  /**
   * Coverage 8'b: every strike still coming at me before my next turn (the attacker's rest of its
   * routine, then each foe that acts first), one entry each: P(it lands on me) at my AC plus `acOff`,
   * and E[damage | hit] (hitTaken's reading of the turn order, review AI-2, AI-3).
   */
  private strikesComing(st: QueryState, me: Unit, attacker: number, acOff: number): { p: number; v: number }[] {
    if (!this.foesBuilt) this.buildFoes(st, me);
    const n = st.order.length;
    const off = (u: Unit) => {
      let pos = -1;
      for (let k = 0; k < n; k++) if (st.order[k] === u.idx) pos = k;
      const d = (pos - st.orderPos + n) % n;
      return d === 0 ? n : d;
    };
    const mine = off(me);
    const hits: { p: number; v: number }[] = [];
    for (const fo of this.foes) {
      const isAtt = fo.u.idx === attacker;
      const left = isAtt && st.active === fo.u.idx ? this.strikesToCome(fo.u) : off(fo.u) < mine ? -1 : 0;
      if (left === 0) continue;
      const how = this.threatens(st, fo, me.cell) ?? (isAtt ? 'melee' : null);
      if (how) this.laterHits(st, fo.u, me, how, left, isAtt && left > 0 ? 1 : fo.victims, Infinity, hits, acOff);
    }
    return hits;
  }

  /**
   * The hit-known window (a Reaction once a hit is known that raises AC against that attack, Shield's
   * +5 "including against the triggering attack", srd-raw.txt:30659-30670; Parry's shape,
   * 50631-50633). Each reaction on offer, net:
   *   the hit it turns into a miss: this attack's expected damage at my exposure weight (capped at
   *   what I have), the drop it prevents, the concentration save it spares me; a critical hit stays a
   *   hit (a natural 20 hits regardless, 991-993; an expanded-range crit is treated the same, which is
   *   conservative under expandedCritAutoHits=false);
   *   a lasting AC (the part its steps apply to me, until my next turn): what the strikes still coming
   *   would land less often;
   *   less its points' in-fight value, less the Reaction kept: an opportunity attack (OA_SHARE), or the
   *   same AC gain on the best later strike that lands.
   */
  private hitKnown(view: UnitView, dp: DecisionPoint): number {
    const st = view.q;
    const me = st.units[view.me]!;
    let pass = 0;
    for (let i = 0; i < dp.legal.n; i++) if (dp.legal.items[i]!.k === 'pass') pass = i;
    const h = dp.hit;
    const spec = dp.roll;
    if (!h || !spec) return pass;
    const s = this.side(me);
    const atk = st.units[h.attacker]?.tpl.attacks.find((a) => a.id === h.via);
    const dmg = atk ? mean(this.dmgPmf(atk.damage, me, h.crit, false, false)) : HIT;
    const pool = me.hp + me.tempHp;
    const rows: { i: number; v: number; parts: ExplainPart[] }[] = [{ i: pass, v: 0, parts: [] }];
    let best = pass;
    let bestV = 0;
    const oa = this.oaHere(view, me);
    for (let i = 0; i < dp.legal.n; i++) {
      const l = dp.legal.items[i]!;
      const hk = l.k === 'react' ? me.tpl.features[l.opt]?.hitKnown : undefined;
      if (!hk) continue;
      const lasting = acGainOf(me.tpl, hk) - hk.ac;
      const gain = hk.ac + lasting;
      const turns = !h.crit && h.total < spec.dc + gain;
      const hpTerm = turns ? s.exposure * Math.min(dmg, pool) : 0;
      const dropTerm = turns && atk ? probAtLeast(this.dmgPmf(atk.damage, me, false, false, false), pool) * (this.killValue(st, me, me) + RESCUE) : 0;
      const concTerm = turns && me.conc >= 0 ? this.concBreak(st, me) * this.concLeft(st, me) : 0;
      const coming = this.strikesComing(st, me, h.attacker, 0);
      let lastTerm = 0;
      if (lasting > 0) {
        const raised = this.strikesComing(st, me, h.attacker, lasting);
        for (let k = 0; k < coming.length; k++) lastTerm += (coming[k]!.p - (raised[k]?.p ?? 0)) * coming[k]!.v * s.exposure;
      }
      // Keeping it: the same gain on the best later strike that lands, E[max] in descending order.
      const off = this.strikesComing(st, me, h.attacker, gain);
      const later = coming.map((x, k) => ({ p: x.p - (off[k]?.p ?? 0), v: x.v })).sort((a, b) => b.v - a.v || b.p - a.p);
      let laterBest = 0;
      let none = 1;
      for (const x of later) {
        laterBest += none * x.p * x.v;
        none *= 1 - x.p;
      }
      const keep = Math.max(OA_SHARE * oa, laterBest * s.exposure);
      const cost = this.reactionCost(st, me, hk);
      const net = hpTerm + dropTerm + concTerm + lastTerm - cost - keep;
      rows.push({
        i,
        v: net,
        parts: [
          { term: 'the hit it turns into a miss (this attack\'s expected damage)', ev: hpTerm },
          ...(dropTerm !== 0 ? [{ term: 'the drop it prevents', ev: dropTerm }] : []),
          ...(concTerm !== 0 ? [{ term: 'concentration kept (no save to make)', ev: concTerm }] : []),
          ...(lastTerm !== 0 ? [{ term: 'its AC until my next turn: the strikes still coming land less', ev: lastTerm }] : []),
          ...(cost !== 0 ? [{ term: 'points spent: what else they could buy', ev: -cost }] : []),
          { term: 'Reaction kept for an opportunity attack or a later hit', ev: -keep },
        ],
      });
      if (Q(net) > Q(bestV)) [bestV, best] = [net, i];
    }
    return this.explainRows(dp, me, best, '', rows);
  }

  /**
   * The damage-taken window (Hellish Rebuke's shape, srd-raw.txt:27953-27961): each reaction on offer
   * at what its program does to the creature that damaged me (the value walk, with it as the target:
   * an ally's value is negative, so it's never answered), less its points' value, less the Reaction
   * kept for an opportunity attack (OA_SHARE).
   */
  private damageTaken(view: UnitView, dp: DecisionPoint): number {
    const st = view.q;
    const me = st.units[view.me]!;
    let pass = 0;
    for (let i = 0; i < dp.legal.n; i++) if (dp.legal.items[i]!.k === 'pass') pass = i;
    const from = dp.hit ? st.units[dp.hit.attacker] : undefined;
    if (!from) return pass;
    const v = this.vctxFor(st, me, view);
    const keep = OA_SHARE * this.oaHere(view, me);
    const rows: { i: number; v: number; parts: ExplainPart[] }[] = [{ i: pass, v: 0, parts: [] }];
    let best = pass;
    let bestV = 0;
    for (let i = 0; i < dp.legal.n; i++) {
      const l = dp.legal.items[i]!;
      const dt = l.k === 'react' ? me.tpl.features[l.opt]?.damageTaken : undefined;
      if (!dt) continue;
      const val = programValue(v, dt.steps, me.cell, { targets: [from], parentRounds: 10 });
      const cost = this.reactionCost(st, me, dt);
      const net = val - cost - keep;
      rows.push({ i, v: net, parts: [{ term: 'what it does to the creature that damaged me', ev: val }, ...(cost !== 0 ? [{ term: 'points spent: what else they could buy', ev: -cost }] : []), { term: 'Reaction kept for an opportunity attack', ev: -keep }] });
      if (Q(net) > Q(bestV)) [bestV, best] = [net, i];
    }
    return this.explainRows(dp, me, best, '', rows);
  }

  /**
   * One attack by `roller` with `atk` (null: an attack that isn't one of its own, a spell's: a straight
   * HIT at even odds [U]) at `t` as if `t` stood on `cell`, with the cover `cov`: what it takes from
   * `t` (expected damage capped at its HP) and the chance it drops `t`. Read from the RollSpec the
   * engine would roll (position rules, Pack Tactics, conditions: buildAttackSpecFor), so the exact odds.
   */
  private incoming(st: QueryState, qs: UnitView['scratch'], roller: Unit, atk: CompiledAttack | null, t: Unit, cell: number, cov: number): { e: number; drop: number; p: number } {
    const cap = t.hp + t.tempHp;
    if (!atk) return { e: Math.min(HIT, cap) * 0.5, drop: 0, p: 0.5 };
    const at = cell === t.cell ? t : ({ ...t, cell } as Unit);
    const spec = buildAttackSpecFor(st, roller, atk, at, roller.cell, qs.adv, qs.dis, qs.fold, false, cov);
    const o = quickOdds(spec, oddsFlags(st), this.odds);
    const crit = o.pCrit;
    const plain = o.pSuccess - crit;
    const adv = spec.adv === 'adv';
    const d = this.dmgPmf(atk.damage, t, false, adv, false);
    const dc = this.dmgPmf(atk.damage, t, true, adv, false);
    return { e: plain * expectedCapped(d, cap) + crit * expectedCapped(dc, cap), drop: plain * probAtLeast(d, cap) + crit * probAtLeast(dc, cap), p: o.pSuccess };
  }

  /**
   * Coverage step 9+, the declare-time window (Redirect Attack: "The goblin chooses a Small or Medium
   * ally within 5 feet of itself. The goblin and that ally swap places, and the ally becomes the
   * target of the attack instead", srd-raw.txt:48831-48834). Each ally on offer, net:
   *   the attack I no longer take: its expected damage on me at my exposure weight (capped at what I
   *   have) plus the drop it spares me (my kill value plus RESCUE, as the hit-known window counts it);
   *   less the same attack on the ally where I stand now (its AC, its HP, its conditions, my cover
   *   there [U: the cover I have now]), at the same weights (an ally's HP is my side's HP);
   *   plus the squares: my end cost where I stand less where the ally stands (I end up there), and the
   *   ally's exposure (threatAt) the other way round, both until my next turn [U: the ally's own turn
   *   may come first];
   *   less the Reaction kept: an opportunity attack (OA_SHARE), or the same swap on the best later
   *   strike coming at me, net of the share of it the ally would take (this attack's ratio).
   * A downed ally is never chosen (it takes the hit Unconscious: automatic critical hits within 5 ft).
   */
  private attackDeclared(view: UnitView, dp: DecisionPoint): number {
    const st = view.q;
    const me = st.units[view.me]!;
    let pass = 0;
    for (let i = 0; i < dp.legal.n; i++) if (dp.legal.items[i]!.k === 'pass') pass = i;
    if (dp.roller === undefined) return pass;
    const roller = st.units[dp.roller]!;
    const atk = this.attackById(roller, dp.rollVia ?? '');
    const s = this.side(me);
    const cov = this.coverOf(st, roller, roller.cell, me);
    const mine = this.incoming(st, view.scratch, roller, atk, me, me.cell, cov);
    const myLoss = s.exposure * mine.e + mine.drop * (this.killValue(st, me, me) + RESCUE);
    const oa = this.oaHere(view, me);
    const coming = this.strikesComing(st, me, roller.idx, 0);
    let laterBest = 0;
    let none = 1;
    for (const x of coming.slice().sort((a, b) => b.v - a.v || b.p - a.p)) {
      laterBest += none * x.p * x.v;
      none *= 1 - x.p;
    }
    const hereCost = this.endCost(st, me, me.cell);
    const rows: { i: number; v: number; parts: ExplainPart[] }[] = [{ i: pass, v: 0, parts: [] }];
    let best = pass;
    let bestV = 0;
    for (let i = 0; i < dp.legal.n; i++) {
      const l = dp.legal.items[i]!;
      if (l.k !== 'react' || l.target < 0) continue;
      const o = st.units[l.target]!;
      if (o.life !== 'up') continue;
      const theirs = this.incoming(st, view.scratch, roller, atk, o, me.cell, cov);
      const allyLoss = s.exposure * theirs.e + theirs.drop * (this.killValue(st, me, o) + RESCUE);
      const mySquares = hereCost - this.endCost(st, me, o.cell);
      const allySquares = s.exposure * (threatAt(st, o, o.cell) - threatAt(st, o, me.cell));
      const share = mine.e > 0 ? Math.min(1, theirs.e / mine.e) : 1;
      const keep = Math.max(OA_SHARE * oa, laterBest * s.exposure * (1 - share));
      const net = myLoss - allyLoss + mySquares + allySquares - keep;
      rows.push({
        i,
        v: net,
        parts: [
          { term: 'Redirect: the attack I no longer take (its expected damage and the drop it spares me)', ev: myLoss },
          { term: `Redirect: the same attack on ${o.seat} where I stand (its AC and HP)`, ev: -allyLoss },
          { term: 'Redirect: my end cost on its square against mine', ev: mySquares },
          { term: `Redirect: ${o.seat}'s exposure on my square against its own`, ev: allySquares },
          { term: 'Reaction kept for an opportunity attack or a later swap', ev: -keep },
        ],
      });
      if (Q(net) > Q(bestV)) [bestV, best] = [net, i];
    }
    return this.explainRows(dp, me, best, '', rows);
  }

  /**
   * Coverage 8'b: what holding my Reaction for a hit-known or damage-taken reaction is worth, for the
   * opportunity-attack decision (DEFLECT_KEEP's reading: about half the time it's called on): the
   * AC gain's cut to my exposure here (a lasting one in full, one attack's own AC over a foe's routine),
   * or the reaction's program on the worst foe in range if it's likely to hit me, less its points.
   */
  private reactionReserve(view: UnitView, me: Unit): number {
    const st = view.q;
    let reserve = 0;
    const s = this.side(me);
    for (const f of me.tpl.features) {
      const hk = f.hitKnown;
      const dt = f.damageTaken;
      if (hk && (hk.pool < 0 || me.res[hk.pool]! >= (hk.poolCost ?? 1))) {
        if (!this.foesBuilt) this.buildFoes(st, me);
        const lasting = acGainOf(me.tpl, hk) - hk.ac;
        const ac = acNow(me, st);
        let cut = 0;
        for (const fo of this.foes) {
          const how = this.threatens(st, fo, me.cell);
          if (!how) continue;
          const r = this.routine(st, fo.u, ac + hk.ac + lasting);
          const less = (how === 'melee' ? fo.r.melee - r.melee : fo.r.ranged - r.ranged) / fo.victims;
          cut += lasting > 0 ? less : less / Math.max(1, routineCount(fo.u));
        }
        const cost = this.reactionCost(st, me, hk);
        reserve = Math.max(reserve, DEFLECT_KEEP * (s.exposure * cut - cost));
      }
      if (dt && (dt.pool < 0 || me.res[dt.pool]! >= (dt.poolCost ?? 1))) {
        const e = this.exposure(st, me, me.cell);
        const v = this.vctxFor(st, me, view);
        let best = 0;
        for (const fo of this.foes) {
          if (this.dist(me.cell, fo.u.cell) > dt.rangeFt || !this.threatens(st, fo, me.cell)) continue;
          best = Math.max(best, programValue(v, dt.steps, me.cell, { targets: [fo.u], parentRounds: 10 }));
        }
        const cost = this.reactionCost(st, me, dt);
        reserve = Math.max(reserve, DEFLECT_KEEP * Math.min(1, e / HIT) * (best - cost));
      }
    }
    return reserve;
  }

  /**
   * Coverage step 9+: what holding my Reaction for a declared reaction (Redirect Attack) is worth, for
   * the opportunity-attack decision (DEFLECT_KEEP's reading, as reactionReserve): the biggest single
   * strike still coming at me before my next turn, at my exposure weight, scaled by how much sturdier
   * the sturdiest eligible ally next to me now is (1 - my HP / (my HP + its HP)) [U: a stand-in for
   * what it would take instead]; 0 with no eligible ally within the swap's range now (allies move, so
   * it's a reading of the moment).
   */
  private declaredReserve(view: UnitView, me: Unit): number {
    const st = view.q;
    const d = me.tpl.features.find((f) => f.declared)?.declared;
    if (!d) return 0;
    let roomiest = 0;
    for (const o of st.units) {
      if (o === me || o.team !== me.team || o.life !== 'up' || o.tpl.size < d.swapMinSize || o.tpl.size > d.swapMaxSize || this.dist(me.cell, o.cell) > d.swapRangeFt) continue;
      roomiest = Math.max(roomiest, o.hp + o.tempHp);
    }
    if (roomiest <= 0) return 0;
    let big = 0;
    // The creature whose turn it is counts with the strikes it has left (strikesComing's reading).
    const act = st.active >= 0 && hostile(st.units[st.active]!, me) ? st.active : -1;
    for (const x of this.strikesComing(st, me, act, 0)) big = Math.max(big, x.p * x.v);
    const mineHp = me.hp + me.tempHp;
    const share = mineHp + roomiest > 0 ? mineHp / (mineHp + roomiest) : 0;
    return DEFLECT_KEEP * this.side(me).exposure * big * (1 - share);
  }

  // ---- M3 step 5a: WATK, ECON, POOLX, RIDER, REACT hitTaken, HOOKX (econ.ts has the model) ----

  /** Exposure on `cell` if I took the Dodge action now: each foe's routine with Disadvantage while it holds (srd-raw.txt:33369-33376). */
  private exposureDodging(st: QueryState, me: Unit, cell: number): number {
    if (!this.foesBuilt) this.buildFoes(st, me);
    if (has(me, COND.dodging)) return this.exposure(st, me, cell); // already up: exposure counts it
    const meD: Unit = { ...me, condMask: me.condMask | COND.dodging };
    if (!dodgeImposesDis(st, meD)) return this.exposure(st, me, cell); // Incapacitated, Speed 0 or Blinded: no Disadvantage to give
    const n = st.setup.w * st.setup.h;
    if (this.dodgeR.length === 0) {
      if (this.dodgeExpo.length !== n) this.dodgeExpo = new Float64Array(n);
      this.dodgeExpo.fill(NaN);
      const ac = acNow(me);
      for (const f of this.foes) this.dodgeR.push(this.foeRoutine(st, f.u, meD, ac));
    }
    const hit = this.dodgeExpo[cell]!;
    if (hit === hit) return hit;
    let total = 0;
    this.foes.forEach((f, k) => {
      const how = this.threatens(st, f, cell);
      if (!how) return;
      const r = this.dodgeR[k]!;
      total += (how === 'melee' ? r.melee : r.ranged * this.coverScale(st, f, me, this.thrCov)) / f.victims;
    });
    this.dodgeExpo[cell] = total;
    return total;
  }

  /** Is `l` a feature activation with step-5a steps (econ.ts)? */
  private isEconUse(me: Unit, l: Legal): boolean {
    if (l.k !== 'use' || l.fx >= 0) return false;
    const f = me.tpl.features[l.opt]!;
    return f.activate !== null && hasEconSteps(activationOf(f, l.aux).steps);
  }

  /**
   * W1 review: does option `l` start a sustained effect of mine (a feature activation whose root has
   * `sustain`, Rage) that isn't live yet, without spending the action?
   */
  private startsSustain(st: QueryState, me: Unit, l: Legal): boolean {
    if (l.k !== 'use' || l.fx >= 0) return false;
    const f = me.tpl.features[l.opt]!;
    if (!f.activate) return false;
    const a = activationOf(f, l.aux);
    if (a.root < 0 || me.tpl.effects[a.root]!.sustain === undefined || a.cost === 'action') return false;
    for (const x of st.fx) if (x.alive && x.owner === me.idx && x.tpl === a.root) return false;
    return true;
  }

  /**
   * W1 review: is option `l` (a feature activation or a grant use) gated on hasntMoved, so a step
   * first would make it illegal? Top-level gates only (an anyOf with another way through isn't).
   */
  private needsUnmoved(st: QueryState, me: Unit, l: Legal): boolean {
    let when: readonly Gate[] | undefined;
    if (l.k !== 'use') return false;
    if (l.fx >= 0) when = boundOf(st, st.fx[l.fx]!).grants[l.opt]?.when;
    else {
      const f = me.tpl.features[l.opt]!;
      when = f.activate ? activationOf(f, l.aux).when : undefined;
    }
    return when !== undefined && when.some((g) => g.g === 'hasntMoved');
  }

  /** Does option `l` (a cast or a use) spend the action? */
  private spendsAction(st: QueryState, me: Unit, l: Legal): boolean {
    if (l.k === 'cast') return me.tpl.spells[l.opt]!.spell.cast === 'action';
    if (l.fx >= 0) return boundOf(st, st.fx[l.fx]!).grants[l.opt]?.cost !== 'bonus';
    const f = me.tpl.features[l.opt]!;
    return !f.activate || activationOf(f, l.aux).cost === 'action';
  }

  /** What Disadvantage on the attacks against me is worth ending on `cell`: my end cost without it less with it. */
  private dodgeRaw(st: QueryState, me: Unit, cell: number): number {
    if (!(this.exposure(st, me, cell) > 0)) return 0; // nothing threatens it there: nothing to have Disadvantage
    return this.endCost(st, me, cell) - this.endCostE(st, me, this.exposureDodging(st, me, cell));
  }

  /** Coverage 8'b G4, M7: what's left of the Dodge term after my no-progress streak (Weights dodgeStaleAfter, dodgeDecay). */
  private dodgeDecayNow(me: Unit): number {
    const over = this.curView!.queries.noProgress(me.idx) - this.w.dodgeStaleAfter + 1;
    let f = 1;
    for (let k = 0; k < over; k++) f *= this.w.dodgeDecay;
    return f;
  }

  /** A Dodge inside a feature's program (a bonus-action one gives up no action): the plain term, with G4's decay. */
  private dodgeValue(st: QueryState, me: Unit, cell: number): number {
    const raw = this.dodgeRaw(st, me, cell);
    return raw > 0 ? raw * this.dodgeDecayNow(me) : 0;
  }

  /**
   * Coverage 8'b G2, as amended by 7.0b: the Dodge action, valued for the time it buys. The
   * Disadvantage term counts up to what that's worth in EHP: an ally's turns before the attackers
   * act again, my concentration effect's remaining value, a rescue or heal I have pending next
   * turn. Past that it counts nothing: delay alone only lengthens the fight, however little damage
   * I'd give up, and a PC with nothing in reach should walk rather than turtle. A side with no
   * progress weight doesn't get this reading, and its Dodge stands as it was. G4's decay comes last.
   */
  private dodgeTerm(view: UnitView, me: Unit, cell: number, v: VCtx): { raw: number; ally: number; conc: number; heal: number; kept: number; value: number } {
    const st = view.q;
    const raw = this.dodgeRaw(st, me, cell);
    const out = { raw, ally: 0, conc: 0, heal: 0, kept: raw, value: raw };
    if (!(raw > 0)) return { ...out, kept: 0, value: 0 };
    if (this.side(me).progress > 0) {
      out.ally = this.dodgeAllyTurns(view, me, cell);
      if (out.ally < raw) out.conc = this.concLeft(st, me);
      if (out.ally + out.conc < raw) out.heal = this.dodgePendingHeal(me, cell, v);
      const bought = out.ally + out.conc + out.heal;
      if (bought < raw) out.kept = bought;
    }
    out.value = out.kept * this.dodgeDecayNow(me);
    return out;
  }

  /**
   * G2: what my side's other turns before the attackers act again are worth. Walking the initiative
   * order from me to my next turn, each ally's turn counts its best routine at a foe in its reach
   * [U: straight-line reach; routines, not its spells], times the share of the attacks against me
   * still to come. An ally that Dodged last turn isn't buying anything: it's turtling too.
   */
  private dodgeAllyTurns(view: UnitView, me: Unit, cell: number): number {
    const st = view.q;
    if (!this.foesBuilt) this.buildFoes(st, me);
    const n = st.order.length;
    const share = new Float64Array(st.units.length);
    let total = 0;
    for (const f of this.foes) {
      const how = this.threatens(st, f, cell);
      if (!how) continue;
      const e = (how === 'melee' ? f.r.melee : f.r.ranged * this.coverScale(st, f, me, this.thrCov)) / f.victims;
      share[f.u.idx] = e;
      total += e;
    }
    if (!(total > 0)) return 0;
    let left = total;
    let val = 0;
    const at = st.order.indexOf(me.idx);
    for (let k = 1; k < n && left > 0; k++) {
      const u = st.units[st.order[(at + k) % n]!]!;
      if (share[u.idx]! > 0) {
        left -= share[u.idx]!;
        continue;
      }
      if (u === me || u.team !== me.team || u.life !== 'up' || has(u, COND.incapacitated) || view.queries.dodgeRun(u.idx) > 0) continue;
      let best = 0;
      for (const f of this.foes) {
        const r = this.foeRoutine(st, u, f.u, acNow(f.u));
        if (threatKind(this.dist(u.cell, f.u.cell), speedNow(u), r)) best = Math.max(best, r.melee, r.ranged);
      }
      val += (best * left) / total;
    }
    return val;
  }

  /**
   * G2: a rescue or heal I have pending: the best of my heals next turn on a downed ally, or on an
   * ally or myself under half HP, x gamma, with a square in its range and line within next turn's
   * move from `cell` (rescueShort) [U: an ally's heal on me isn't counted].
   */
  private dodgePendingHeal(me: Unit, cell: number, v: VCtx): number {
    const st = v.st;
    const who = st.units.filter((u) => u.team === me.team && (u.life === 'down' || u.life === 'stable' || (u.life === 'up' && 2 * u.hp < u.hpMax)));
    if (who.length === 0 || has(me, COND.incapacitated)) return 0;
    const heals: NextEntry[] = [];
    this.healsNext(me, v, who, heals);
    const spd = speedNow(me, st);
    let best = 0;
    for (const h of heals) if (h.v > best && this.rescueShort(st, cell, h) <= spd) best = h.v;
    return this.w.gamma * best;
  }

  /**
   * Coverage 8'b G1 and m10: what I could do next turn, as targets with how far from them I can act.
   * Strikes: every weapon attack I could make next turn (an Attack action may draw its weapon,
   * srd-raw.txt:32707-32711 as buildPairs cites it) at each allowed hostile, reach its reach (melee)
   * or long range; valued once, from here [U: next turn's square facts, cover and the hostiles
   * adjacent to it, aren't known; the top-k destinations get the exact strike from there instead].
   * Rescues: each of my heals (healReach) on a downed ally, at what the program is worth cast from
   * the ally's square (v4's heal model: killValue + RESCUE for someone down) [U: standing on its
   * square stands in for standing within range of it, for the value; rescueAt reads range and line].
   */
  private nextTurnReach(view: UnitView, me: Unit, upInReach: boolean, v: VCtx): NextEntry[] {
    const st = view.q;
    const out: NextEntry[] = [];
    me.tpl.attacks.forEach((atk, ai) => {
      if (atk.spell || !gearOk(st, me, atk.gear) || !canWield(me, atk, true)) return;
      for (const t of st.units) {
        if (!hostile(me, t) || !this.allowed(st, t, upInReach)) continue;
        const sv = this.strike(view, me, ai, t, me.cell);
        if (sv > 0) out.push({ cell: t.cell, reach: atk.kind === 'melee' ? atk.reachFt : atk.longFt, v: sv, rescue: false });
      }
    });
    const down = st.units.filter((u) => u !== me && u.team === me.team && (u.life === 'down' || u.life === 'stable'));
    if (down.length > 0 && !has(me, COND.incapacitated)) this.healsNext(me, v, down, out);
    return out;
  }

  /**
   * My heals usable next turn on each of `who`, at what the program is worth cast from that creature's
   * square; pushed to `out`. `now`: the ones this turn's budget still pays for instead (coverage 8'b
   * review, ai-logic-1: move, then heal).
   */
  private healsNext(me: Unit, v: VCtx, who: readonly Unit[], out: NextEntry[], now = false): void {
    const st = v.st;
    const add = (steps: readonly Step[] | null | undefined, val: (from: number) => number) => {
      if (!steps) return;
      const reach = healReach(steps);
      if (reach < 0) return;
      for (const t of who) {
        const hv = val(t.cell);
        if (hv > 0) out.push({ cell: t.cell, reach, v: hv, rescue: true, val });
      }
    };
    // The heals I could use next turn, as sim/cast.ts listCasts and listFeatures offer them, but
    // with next turn's action and bonus action and no one needing to be in range now: a spell
    // whose components I meet now (a cantrip; a free use; else the lowest level I have a slot
    // for), a feature activation whose pool and gates allow it [U: a grant's heal isn't counted].
    me.tpl.spells.forEach((e, ei) => {
      if ((e.whileHeld >= 0 && heldHand(me, e.whileHeld) < 0) || !componentsOk(st, me, e, null)) return;
      if (now && (e.spell.cast === 'action' ? me.b.action === 0 : me.b.bonus === 0)) return;
      const lv = e.spell.level;
      if (lv === 0) return add(e.prog[0], (from) => this.castValue(v, me, ei, 0, false, from));
      if (e.freePool >= 0 && me.res[e.freePool]! > 0) return add(e.prog[lv], (from) => this.castValue(v, me, ei, lv, true, from));
      if (!e.slotted || (now && me.slotTurn === st.turnIdx)) return;
      for (let l = lv; l <= 9; l++) if (me.res[l - 1]! > 0) return add(e.prog[l], (from) => this.castValue(v, me, ei, l, false, from));
    });
    me.tpl.features.forEach((f, fi) => {
      if (!f.activate) return;
      const nAct = 1 + (f.more ? f.more.length : 0);
      for (let k = 0; k < nAct; k++) {
        const a = activationOf(f, k);
        if (now && (a.cost === 'action' ? me.b.action === 0 : a.cost === 'bonus' && me.b.bonus === 0)) continue;
        if (a.cost === 'reaction' || (a.pool >= 0 && me.res[a.pool]! < poolCostOf(a)) || (a.when && !gatesOk(st, me, a.when))) continue;
        const l = this.scratchUse;
        add(a.steps, (from) => {
          Object.assign(l, { k: 'use', fx: -1, opt: fi, aux: f.more ? k : -1 });
          return this.useValue(v, me, l, from);
        });
      }
    });
  }
  private readonly scratchUse: Legal = newLegal();

  /**
   * Coverage 8'b G1: the best spell I could cast next turn from where I stand (a cantrip, a free
   * use, else the lowest level I have a slot for; components as now), the floor every square's
   * next-turn value is measured over, so a caster with a ranged option doesn't walk up to use a
   * weapon it wouldn't use [U: a spell out of range here but in range from a destination isn't
   * credited to that destination].
   */
  private nextTurnCast(v: VCtx, me: Unit): number {
    const st = v.st;
    if (has(me, COND.incapacitated)) return 0;
    let best = 0;
    me.tpl.spells.forEach((e, ei) => {
      // Coverage 8'b G7: next turn's free object interaction can free a hand or draw the focus first.
      if (!this.castableNext(st, me, e)) return;
      const lv = e.spell.level;
      let x = -Infinity;
      if (lv === 0) x = this.castValue(v, me, ei, 0, false, me.cell);
      else if (e.freePool >= 0 && me.res[e.freePool]! > 0) x = this.castValue(v, me, ei, lv, true, me.cell);
      else if (e.slotted) for (let l = lv; l <= 9; l++) if (me.res[l - 1]! > 0) { x = this.castValue(v, me, ei, l, false, me.cell); break; }
      if (x > best) best = x;
    });
    return best;
  }

  /** G7: could I cast entry `e` next turn, as I am or after one hand change (no shield)? Item-less creatures: as they are. */
  private castableNext(st: QueryState, me: Unit, e: CompiledTemplate['spells'][number]): boolean {
    const ok = (hands: ArrayLike<number>) => (e.whileHeld < 0 || hands[0] === e.whileHeld || hands[1] === e.whileHeld) && componentsOk(st, me, e, null, hands);
    if (ok(me.hands)) return true;
    const items = me.tpl.items;
    const pair = [me.hands[0]!, me.hands[1]!];
    for (let h = 0; h < 2; h++) {
      const was = pair[h]!;
      if (was >= 0 && items[was]!.kind !== 'shield') {
        pair[h] = HAND.empty;
        if (ok(pair)) return true;
        pair[h] = was;
      }
    }
    const free = pair[0] === HAND.empty ? 0 : pair[1] === HAND.empty ? 1 : -1;
    if (free < 0) return false;
    for (let i = 0; i < items.length; i++) {
      if (items[i]!.kind === 'shield' || items[i]!.kind === 'weapon' || pair[0] === i || pair[1] === i || (me.dropped[i]! >= 0 && me.dropped[i] !== me.cell)) continue;
      pair[free] = i;
      if (ok(pair)) return true;
      pair[free] = HAND.empty;
    }
    return false;
  }

  /** A Dash's strikes (econ.ts): only off engagement, when my Speed added brings a target in reach (a straight-line read [U: walls]). */
  private dashValue(st: QueryState, me: Unit): number {
    const c = this.tc;
    if (!c || !c.canAttack || c.engaged) return 0;
    const extra = speedNow(me, st);
    let best = 0;
    for (let p = 0; p < this.pairAi.length; p++) {
      const ai = this.pairAi[p]!;
      const atk = me.tpl.attacks[ai]!;
      const t = st.units[this.pairT[p]!]!;
      const reach = atk.kind === 'melee' ? atk.reachFt : atk.normalFt;
      if (this.dist(me.cell, t.cell) > me.b.moveFt + extra + reach) continue;
      // E2: a piece's pair only from my own square, as the strike below is valued from it (a piece
      // elsewhere isn't fetched by the Dash: a written miss).
      if (!this.pieceOk(st, me, atk, me.cell)) continue;
      const v = c.strikes[ai]! * this.strike(c.view, me, ai, t, me.cell) - (this.endCost(st, me, t.cell) - c.hereCost);
      if (v > best) best = v;
    }
    return best;
  }

  /**
   * One more action: a fresh Attack action's strikes from the best square I can reach (move risk not
   * counted). Greedy v13 (G1a): each attack times the strikes a fresh action brings it (strikePlan's
   * fresh reading), the best of those.
   */
  private extraActionValue(st: QueryState, me: Unit): number {
    const c = this.tc;
    if (!c) return 0;
    const plan = this.strikePlan(me, true);
    // G1b: with attacks that don't all read as v12, each attack's routine (routineAt).
    const at = (cell: number) => (plan.masked ? this.routineAt(c.view, me, cell, plan) : this.bestTimes(c.view, me, cell, plan.n));
    let best = at(me.cell);
    for (const m of c.moves) best = Math.max(best, at(m.cell));
    void st;
    return best;
  }

  /** G1a: the best over this decision's pairs in range from `from` of a strike times its attack's count in `n` (at least 0, as bestStrike). */
  private bestTimes(view: UnitView, me: Unit, from: number, n: Int8Array): number {
    const st = view.q;
    let bv = 0;
    for (let p = 0; p < this.pairAi.length; p++) {
      const ai = this.pairAi[p]!;
      const t = st.units[this.pairT[p]!]!;
      if (!this.inRange(st, me.tpl.attacks[ai]!, t, from) || !this.pickupFrom(st, me, me.tpl.attacks[ai]!, from) || !this.styleOk(st, me, from, t)) continue;
      bv = Math.max(bv, this.strike(view, me, ai, t, from) * n[ai]!);
    }
    return bv;
  }

  /**
   * WATK: what step `s`'s strikes are worth from `from`, per strike (the walker multiplies by its
   * count): the best single strike, with its free riders on a hit; when it makes more than one, a
   * later strike goes to the next-best target with the chance the first dropped its own, so a
   * second strike at a 1-HP foe isn't counted twice.
   */
  private weaponStrike(st: QueryState, me: Unit, s: Extract<Step, { k: 'weaponAttack' }>, from: number, grant: string, mute: number, first: Unit | null = null): number {
    const view = this.curView!;
    let best = 0;
    let bestT = -1;
    let bestKill = 0;
    const perT: number[] = [];
    // M3 step 5b, as sim/steps.ts makes them: the Light extra attack not with the one Light weapon the
    // Attack action used (srd-raw.txt:20344-20345); Cleave only at a creature within 5 ft of the one
    // hit, not it (20362-20363), and never cleaving again from that strike (once per turn).
    const lm = s.lightExtra ? me.b.lightMask : 0;
    const skipLight = lm !== 0 && (lm & (lm - 1)) === 0 ? lm : 0;
    if (s.near && !first) return 0;
    const wasNear = this.inNear;
    if (s.near) this.inNear = true;
    const wasLight = this.inLight;
    if (s.lightExtra) this.inLight = true;
    for (let j = 0; j < s.from.length; j++) {
      const base = me.tpl.attacks[s.from[j]!]!;
      if (!gearOk(st, me, base.gear) || !canWield(me, base)) continue;
      if (skipLight !== 0 && base.item !== undefined && (skipLight & (1 << base.item)) !== 0 && !lightStackSpare(me, base)) continue;
      const atk = s.noAbility ? s.noAbility[j]! : base;
      for (const t of st.units) {
        if (t === me || !hostile(me, t) || t.life === 'dead' || !this.allowed(st, t, true)) continue;
        if (first && (t === first || this.dist(first.cell, t.cell) > 5)) continue;
        if (!this.inRange(st, base, t, from)) continue;
        if (!first && !this.styleStep(st, me, s, from, t)) continue; // G5
        let v = this.strikeAtk(view, me, atk, t, from);
        const p = this.lastHitP;
        const kill = this.lastKillP;
        if (t.life === 'up' && !(mute & TERM.rider)) v += this.freeRiders(view, me, atk, t, grant, p, null, this.lastAdv);
        if (!(v <= (perT[t.idx] ?? 0))) perT[t.idx] = v;
        if (v > best) [best, bestT, bestKill] = [v, t.idx, kill];
      }
    }
    this.inNear = wasNear;
    this.inLight = wasLight;
    if (s.count <= 1 || bestT < 0) return best;
    let other = 0;
    perT.forEach((x, i) => {
      if (i !== bestT && x > other) other = x;
    });
    const later = bestKill * other + (1 - bestKill) * best;
    return (best + (s.count - 1) * later) / s.count;
  }

  /** G5: may a feature's strike from `from` aim at `t`: among the enemies its attacks reach from there, is it the one the style narrows to? */
  private styleStep(st: QueryState, me: Unit, s: Extract<Step, { k: 'weaponAttack' }>, from: number, t: Unit): boolean {
    if (this.w.targetStyle === 'ev') return true;
    const cands = st.units.filter((c) => c !== me && hostile(me, c) && c.life !== 'dead' && this.allowed(st, c, true) && s.from.some((ai) => this.inRange(st, me.tpl.attacks[ai]!, c, from)));
    const pick = this.styleAmong(st, me, from, cands);
    return pick < 0 || pick === t.idx;
  }

  /**
   * Session S (VCtx.riderOn): rider `ri` on `t` if it fired now: its best option net of its pool cost,
   * 0 when its scope, pool or gates rule it out. `ignoreSelfHas`: valuing the effect that switches it on,
   * so its selfHas gates are read as holding and its once-per-turn ledger as fresh.
   */
  private riderOnValue(view: UnitView, me: Unit, ri: number, t: Unit, ignoreSelfHas: boolean): number {
    const st = view.q;
    const r = me.tpl.riders![ri]!;
    if (r.pool >= 0 && me.res[r.pool]! < (r.poolCost ?? 1)) return 0;
    if (!ignoreSelfHas && !this.riderOnce(st, me, ri, t)) return 0;
    const when = ignoreSelfHas && r.when ? r.when.filter((g) => g.g !== 'selfHas') : r.when;
    // W1 (P5): no roll is known here, so the roll-state gates read a straight roll (rollAdv fails closed: a floor).
    if (!gatesOk(st, me, when, t, 'none')) return 0;
    let best = 0;
    for (const o of r.opts) best = Math.max(best, this.riderOptValue(view, me, r, o, t, null, false));
    const cost = r.pool >= 0 ? this.pointsCost(st, me, r.pool, r.poolCost ?? 1, null) : 0;
    return Math.max(0, best - cost);
  }

  /** May rider `ri` be used on `t` now under its once-per-turn scope (C1; sim/riders.ts riderReady's ledger)? */
  private riderOnce(st: QueryState, me: Unit, ri: number, t: Unit): boolean {
    const r = me.tpl.riders![ri]!;
    if (r.once === undefined) return true;
    const base = ri * (1 + st.units.length);
    const rt = me.riderTurn!;
    if (r.once === 'perCreature') return rt[base + 1 + t.idx] !== st.turnIdx;
    return rt[base] !== st.turnIdx && (r.once !== 'ownTurn' || st.active === me.idx);
  }

  /**
   * The free (no pool cost) riders a strike with `atk` by activation `grant` carries, each at its
   * best option (an auto rider at its only one), not yet rolled: hit and dealtDamage riders at
   * `hitP`, miss riders (Graze) at 1 - hitP (M3 step 5b; dealtDamage is read as any hit [U: a hit
   * that deals 0 after defenses would not trigger it]). `out`, when given, gets each rider's share.
   * `roll` (W1, P5): the strike's resolved Advantage state (strikeAtk's lastAdv), for the roll-state gates.
   */
  private freeRiders(view: UnitView, me: Unit, atk: CompiledAttack, t: Unit, grant: string, hitP: number, out: ExplainPart[] | null = null, roll: AdvState = this.lastAdv): number {
    const rs = me.tpl.riders;
    if (!rs || (!atk.onHit && !atk.onMiss)) return 0;
    const st = view.q;
    let hit = 0;
    let miss = 0;
    for (const list of [atk.onHit, atk.onMiss]) {
      for (const ri of list ?? []) {
        const r = rs[ri]!;
        if (r.pool >= 0) continue;
        if (r.grantedBy !== undefined && r.grantedBy !== grant) continue;
        if (!this.riderOnce(st, me, ri, t) || !gatesOk(st, me, r.when, t, roll)) continue;
        // A later strike of the turn (review AI-2): a once-per-turn rider the first strike counted is spent.
        if (this.laterOf !== -2 && r.once !== undefined && (r.once !== 'perCreature' || t.idx === this.laterOf)) continue;
        const mute = this.laterOf === t.idx ? TERM.refresh | TERM.stat : 0;
        let best = r.auto ? -Infinity : 0;
        for (const o of r.opts) {
          if (this.inNear && nearStrike(o)) continue; // Cleave's own strike can't cleave (once per turn)
          best = Math.max(best, this.riderOptValue(view, me, r, o, t, atk, false, mute));
        }
        if (best === -Infinity) continue;
        if (r.on === 'miss') miss += best;
        else hit += best;
        if (out && best !== 0) out.push({ term: `${r.name}: ${r.on === 'miss' ? 'P(miss)' : 'P(hit)'} x its value`, ev: (r.on === 'miss' ? 1 - hitP : hitP) * best });
      }
    }
    return hitP * hit + (1 - hitP) * miss;
  }

  /**
   * One rider option on a hit by `atk` (null: its trigger isn't a hit, or the attack isn't one of
   * mine): its extra damage joined to the attack's damage instance, capped at what `t` has, plus
   * its other steps on `t` if it survives the attack's own damage (econ.ts).
   */
  private riderOptValue(view: UnitView, me: Unit, r: CompiledRider, o: RiderOpt, t: Unit, atk: CompiledAttack | null, crit: boolean, mute = 0): number {
    if (t.life !== 'up') return 0;
    const st = view.q;
    const v0 = this.vctxFor(st, me, view);
    // A weapon mastery's Prone (Topple) is worth the follow-up strikes it gets before the target
    // rights itself (review AI-4, cond.ts conditionValue); other riders' Prone (Open Hand) keeps v5's value.
    const topple = me.tpl.features[r.feature]!.id.startsWith('core:mastery-');
    const v = mute !== 0 || topple ? { ...v0, mute: v0.mute | mute, ...(topple ? { proneWindow: true as const } : {}) } : v0;
    const cap = t.hp + t.tempHp;
    const base = atk && r.on !== 'miss' ? this.dmgPmf(atk.damage, t, crit, false, false) : null;
    const survive = base ? 1 - probAtLeast(base, cap) : 1;
    let val = 0;
    if (o.extra) {
      // W1 (P4): a part of the attack's type (Sneak Attack, Rage Damage, Frenzy) takes it from `atk`, or,
      // valuing the effect that switches the rider on, from my best attack that carries it (w1.ts).
      const extra = typedExtra(st, me, t, atk ?? riderAttack(me.tpl, me.tpl.riders!.indexOf(r)), o.extra);
      if (base && atk && r.on === 'hit') {
        // One damage instance: the rider's dice double on a crit under riderDiceCritDouble (srd-raw.txt:2207-2211).
        const joined = !crit || readFlag(st, 'riderDiceCritDouble') ? this.joinPmf(atk.damage, extra, t, crit) : convolve(base, this.maskPmf(extra, t, false, false));
        val += expectedCapped(joined, cap) - expectedCapped(base, cap) + (probAtLeast(joined, cap) - probAtLeast(base, cap)) * this.killValue(st, me, t);
      } else val += harmOf(v, t, extra, crit, false, false);
    }
    // Cleave's second strike runs even when the first target dies (sim/riders.ts runRiders); so does an
    // option that acts on me alone (W1, P10: Withdraw's free move, srd-raw.txt:13817, 13835).
    if (o.steps.length > 0) val += (nearStrike(o) || selfOnlyOption(o) ? 1 : survive) * programValue(v, o.steps, me.cell, { targets: [t] });
    return val;
  }

  /** Is a 5a-model pool cost in force for activation `a` of `f` (econ.ts), or the flat poolUse it had before? */
  private newCostModel(f: { readonly more?: unknown; readonly onInit?: unknown }, a: CompiledActivation): boolean {
    return f.more !== undefined || f.onInit !== undefined || a.poolCost !== undefined || hasEconSteps(a.steps);
  }

  /** What using activation `a` of `f` costs in pool points (econ.ts for step-5a activations; else the flat poolUse). */
  private activationCost(st: QueryState, me: Unit, f: { readonly more?: unknown; readonly onInit?: unknown }, a: CompiledActivation): number {
    if (a.pool < 0 || a.book) return 0; // the book rule (7.6): a monster's limited action costs nothing to use
    if (!this.newCostModel(f, a)) return this.w.poolUse;
    return this.pointsCost(st, me, a.pool, poolCostOf(a), null);
  }

  /**
   * Spending `n` points of pool `res` (econ.ts pointValue). `ex`: a spender that can't use them
   * later (the initiative hook: Initiative comes once a fight), excluded from what else they could
   * buy; anything else (null) can, so it counts itself on a later turn.
   */
  private pointsCost(st: QueryState, me: Unit, res: number, n: number, ex: unknown): number {
    return -pointsValue(this.w, this.pointBase(st, me, res, ex), me.res[res]!, -n);
  }

  /** A point's base value: 0 when nothing but `ex` spends the pool, else max(poolUse, gamma x the best other use per point now). */
  private pointBase(st: QueryState, me: Unit, res: number, ex: unknown): number {
    for (const c of this.altCache) if (c.res === res && c.ex === ex) return c.v;
    const tpl = me.tpl;
    let other = false;
    for (const f of tpl.features) {
      for (const a of f.activate ? [f.activate, ...(f.more ?? [])] : []) if (a.pool === res && a !== ex) other = true;
      if (f.hitTaken && f.hitTaken.pool === res && f.hitTaken !== ex) other = true;
      if (f.hitKnown && f.hitKnown.pool === res && f.hitKnown !== ex) other = true;
      if (f.damageTaken && f.damageTaken.pool === res && f.damageTaken !== ex) other = true;
      if (f.onInit && f.onInit.pool === res && f.onInit !== ex) other = true;
    }
    for (const r of tpl.riders ?? []) if (r.pool === res && r !== ex) other = true;
    let v = 0;
    if (other) v = Math.max(this.w.poolUse, this.w.gamma * this.altPerPoint(st, me, res, ex));
    this.altCache.push({ res, ex, v });
    return v;
  }

  /** The best marginal use of one point of `res` right now among my activations (itself included, as a later turn's use): value less the best free activation of the same cost, per point. */
  private altPerPoint(st: QueryState, me: Unit, res: number, ex: unknown): number {
    if (this.inAlt || !this.curView) return 0;
    this.inAlt = true;
    const v = this.vctxFor(st, me, this.curView);
    const acts: CompiledActivation[] = [];
    for (const f of me.tpl.features) if (f.activate) acts.push(f.activate, ...(f.more ?? []));
    const valOf = (a: CompiledActivation) => programValue(v, a.steps, me.cell, { parentRounds: 100, grant: a.local, actCost: a.cost, ...(a.self ? { targets: [me] } : {}) });
    let best = 0;
    for (const a of acts) {
      if (a.pool !== res || a === ex || a.cost === 'reaction') continue;
      let free = 0;
      for (const b of acts) if (b.pool < 0 && b.cost === a.cost) free = Math.max(free, valOf(b));
      best = Math.max(best, (valOf(a) - free) / poolCostOf(a));
    }
    this.inAlt = false;
    return best;
  }

  /** The attack a hit came from: one of mine by id (a weaponAttack variant shares its base's id). */
  private attackById(me: Unit, id: string): CompiledAttack | null {
    for (const a of me.tpl.attacks) if (a.id === id) return a;
    return null;
  }

  /** An explain record for a decision other than the turn (M3 step 5a: riders, hitTaken, the initiative hook). */
  private explainRows(dp: DecisionPoint, me: Unit, chosen: number, note: string, rows: { i: number; v: number; parts: ExplainPart[] }[]): number {
    if (!this.explainSink) return chosen;
    const top = rows.slice().sort((a, b) => Q(b.v) - Q(a.v) || a.i - b.i).slice(0, 3);
    this.explainSink({ at: dp.at, who: me.idx, chosen: dp.keyOf(chosen), note, scored: rows.length, top: top.map((x) => ({ key: dp.keyOf(x.i), ev: x.v, parts: x.parts })) });
    return chosen;
  }

  /** RIDER: each option's P(effect) x value (the hit is known) against its pool cost; pass unless one is worth more than 0. */
  private rider(view: UnitView, dp: DecisionPoint): number {
    const st = view.q;
    const me = st.units[view.me]!;
    let pass = 0;
    for (let i = 0; i < dp.legal.n; i++) if (dp.legal.items[i]!.k === 'pass') pass = i;
    const h = dp.hit;
    const riders = me.tpl.riders;
    if (!h || !riders) return pass;
    const t = st.units[h.target]!;
    const atk = this.attackById(me, h.via);
    let best = pass;
    let bestQ = 0;
    const rows: { i: number; v: number; parts: ExplainPart[] }[] = [{ i: pass, v: 0, parts: [] }];
    for (let i = 0; i < dp.legal.n; i++) {
      const l = dp.legal.items[i]!;
      if (l.k !== 'pick') continue;
      const r = riders[l.aux]!;
      const o = r.opts[l.opt]!;
      const val = this.riderOptValue(view, me, r, o, t, atk, h.crit);
      const cost = r.pool >= 0 ? this.pointsCost(st, me, r.pool, r.poolCost ?? 1, null) : 0;
      const net = val - cost;
      rows.push({ i, v: net, parts: [{ term: `${o.name === r.name ? r.name : `${r.name}: ${o.name}`}: its effect, P(effect) x value`, ev: val }, ...(r.pool >= 0 ? [{ term: `${me.tpl.pools[r.pool - 9]!.name} spent: what else it could buy`, ev: -cost }] : [])] });
      if (Q(net) > bestQ) [bestQ, best] = [Q(net), i];
    }
    return this.explainRows(dp, me, best, '', rows);
  }

  /** REACT hitTaken: the hit's rolled damage against the reduction's exact PMF, against keeping the Reaction (econ.ts). */
  private hitTaken(view: UnitView, dp: DecisionPoint): number {
    const st = view.q;
    const me = st.units[view.me]!;
    let pass = 0;
    let react = -1;
    for (let i = 0; i < dp.legal.n; i++) {
      const k = dp.legal.items[i]!.k;
      if (k === 'pass') pass = i;
      else if (k === 'react' && react < 0) react = i;
    }
    const h = dp.hit;
    if (!h || react < 0) return pass;
    const f = me.tpl.features[dp.legal.items[react]!.opt]!;
    const ht = f.hitTaken!;
    const total = h.total;
    const hp = me.hp + me.tempHp;
    const R = ht.reduce === 'halve' ? null : this.reducePmf(ht.reduce);
    let saved = 0;
    let dropYes = 0;
    let zero = 0;
    if (!R) {
      const left = Math.floor(total / 2); // halved, rounded down (as sim/damage.ts applies it)
      saved = total - left;
      dropYes = left >= hp ? 1 : 0;
      zero = left <= 0 ? 1 : 0;
    } else {
      for (let k = 0; k < R.p.length; k++) {
        const p = R.p[k]!;
        if (p === 0) continue;
        const r = Math.max(0, R.min + k);
        saved += p * Math.min(total, r);
        if (total - r >= hp) dropYes += p;
        if (r >= total) zero += p;
      }
    }
    const s = this.side(me);
    const dropNo = total >= hp ? 1 : 0;
    const hpTerm = s.exposure * saved;
    // W1 (P8): with a live drop-to-1 pool the hit drops me to 1 either way, so the reduction prevents no drop.
    const dropTerm = dropSafe(me) ? 0 : (dropNo - dropYes) * (this.killValue(st, me, me) + RESCUE);
    const concTerm = me.conc >= 0 && total > 0 ? zero * this.concBreak(st, me) * this.concLeft(st, me) : 0;
    const cost = ht.pool >= 0 ? this.pointsCost(st, me, ht.pool, ht.poolCost ?? 1, null) : 0;
    // Keeping it: an opportunity attack on a hostile in my reach, or a later hit before my next turn.
    let oa = 0;
    for (let ai = 0; ai < me.tpl.attacks.length; ai++) {
      const a = me.tpl.attacks[ai]!;
      if (a.kind !== 'melee' || a.spell || !gearOk(st, me, a.gear) || !canWield(me, a)) continue;
      for (const t of st.units) if (t.life === 'up' && hostile(me, t) && this.dist(me.cell, t.cell) <= a.reachFt) oa = Math.max(oa, this.strike(view, me, ai, t, me.cell, true));
    }
    if (!this.foesBuilt) this.buildFoes(st, me);
    const n = st.order.length;
    const off = (u: Unit) => {
      let pos = -1;
      for (let k = 0; k < n; k++) if (st.order[k] === u.idx) pos = k;
      const d = (pos - st.orderPos + n) % n;
      return d === 0 ? n : d;
    };
    const mine = off(me);
    const eR = R ? mean(R) : total / 2;
    // The later hits it could reduce instead, each one hit at a time (review AI-2, AI-3): every
    // strike still coming at me before my next turn, its chance to land on me and what one
    // reduction would save of it, min(E[damage | hit], E[R]). The Reaction stops one of them:
    // the best that lands, E[max] over the strikes in descending order.
    const hits: { p: number; v: number }[] = [];
    for (const fo of this.foes) {
      const isAtt = fo.u.idx === h.attacker;
      const left = isAtt && st.active === fo.u.idx ? this.strikesToCome(fo.u) : off(fo.u) < mine ? -1 : 0;
      if (left === 0) continue;
      const how = this.threatens(st, fo, me.cell) ?? (isAtt ? 'melee' : null);
      if (!how) continue;
      this.laterHits(st, fo.u, me, how, left, isAtt && left > 0 ? 1 : fo.victims, eR, hits);
    }
    hits.sort((a, b) => b.v - a.v || b.p - a.p);
    let laterBest = 0;
    let none = 1;
    for (const x of hits) {
      laterBest += none * x.p * x.v;
      none *= 1 - x.p;
    }
    const keep = Math.max(OA_SHARE * oa, laterBest * s.exposure);
    const net = hpTerm + dropTerm + concTerm - cost - keep;
    const parts: ExplainPart[] = [
      { term: 'damage it stops, E[min(rolled, reduction)]', ev: hpTerm },
      ...(dropTerm !== 0 ? [{ term: 'the drop it prevents', ev: dropTerm }] : []),
      ...(concTerm !== 0 ? [{ term: 'concentration kept (reduced to 0)', ev: concTerm }] : []),
      ...(cost !== 0 ? [{ term: 'points spent: what else they could buy', ev: -cost }] : []),
      { term: 'Reaction kept for an opportunity attack or a later hit (the best one that lands)', ev: -keep },
    ];
    const chosen = Q(net) > 0 ? react : pass;
    return this.explainRows(dp, me, chosen, '', [{ i: pass, v: 0, parts: [] }, { i: react, v: net, parts }]);
  }

  /**
   * The active creature `u`'s strikes still to come in the Attack action it has started (its
   * live alternatives' strikes less those made); -1 when it hasn't started one but can (all of
   * its routine is still to come); 0 when its action is spent.
   */
  private strikesToCome(u: Unit): number {
    if (!u.b.atkActive) return u.b.action > 0 ? -1 : 0;
    let made = 0;
    for (let i = 0; i < u.b.atkCounts.length; i++) made += u.b.atkCounts[i]!;
    let most = 0;
    const alts = u.tpl.attackAct.alts;
    for (let k = 0; k < alts.length; k++) {
      if (!(u.b.atkLive & (1 << k))) continue;
      let n = 0;
      for (const g of alts[k]!) n += g.count;
      most = Math.max(most, n);
    }
    return Math.max(0, most - made);
  }

  /**
   * Pushes `u`'s later strikes of `kind` against `d` onto `out`, one entry per strike: its chance
   * to hit `d` (shared among `victims`) and min(E[damage | hit], eR), what one reduction saves of
   * it. `left` -1: its best Attack routine of that kind (the alternative with the most expected
   * damage, each group's best attack); else that many strikes with its best attack of that kind.
   * Rolled as the engine would (foeRoutine's modes: conditions, Dodge, Paralyzed's crits).
   */
  private laterHits(st: QueryState, u: Unit, d: Unit, kind: 'melee' | 'ranged', left: number, victims: number, eR: number, out: { p: number; v: number }[], acOff = 0): void {
    const ac = acNow(d) + acOff;
    const plainConds = ((u.condMask | d.condMask) & CONTENT_CONDS) === 0 && !(d.condMask & COND.dodging) && !asleep(d);
    const dis = !plainConds && ((u.condMask & ATTACKER_DIS) !== 0 || frightened(st, u, null) || ((d.condMask & COND.dodging) !== 0 && dodgeImposesDis(st, d)));
    const adv = !plainConds && ((d.condMask & TARGET_ADV) !== 0 || asleep(d));
    const m = adv && dis ? MODE.none : adv ? MODE.adv : dis ? MODE.dis : MODE.none;
    const crit = !plainConds && kind === 'melee' && autoCritWithin5(d) && this.dist(u.cell, d.cell) <= 5 ? MODE.crit : 0;
    const atks = u.tpl.attacks;
    const one = atks.map((a) => {
      if (a.kind !== kind || !gearOk(st, u, a.gear) || !canWield(u, a, true)) return null;
      const r = this.strikeOdds(st, u, a, d, ac, m | crit);
      return r.p > 0 ? r : null;
    });
    const push = (i: number) => {
      const r = one[i]!;
      out.push({ p: r.p / victims, v: Math.min(r.hit, eR) });
    };
    if (left > 0) {
      let b = -1;
      for (let i = 0; i < atks.length; i++) if (one[i] && (b < 0 || one[i]!.p * one[i]!.hit > one[b]!.p * one[b]!.hit)) b = i;
      if (b >= 0) for (let k = 0; k < left; k++) push(b);
      return;
    }
    let bestAlt: number[] = [];
    let bestSum = 0;
    for (const alt of u.tpl.attackAct.alts) {
      const picks: number[] = [];
      let sum = 0;
      let ok = true;
      for (const g of alt) {
        let b = -1;
        for (const i of g.from) if (one[i] && (b < 0 || one[i]!.p * one[i]!.hit > one[b]!.p * one[b]!.hit)) b = i;
        if (b < 0) {
          ok = false;
          break;
        }
        for (let k = 0; k < g.count; k++) picks.push(b);
        sum += g.count * one[b]!.p * one[b]!.hit;
      }
      if (ok && sum > bestSum) [bestSum, bestAlt] = [sum, picks];
    }
    for (const i of bestAlt) push(i);
  }

  /** One strike of `atk` by `u` against `d`: P(hit) and E[damage | hit] after `d`'s defenses (as attackEVX rolls it). */
  private strikeOdds(st: QueryState, u: Unit, atk: CompiledAttack, d: Unit, ac: number, mode: number): { p: number; hit: number } {
    const roll = mode & (MODE.adv | MODE.dis);
    const adv = roll === MODE.adv;
    const own = !defStats(d);
    const plain = mean(own ? this.pmf(atk, d, false, adv) : damagePmf(atk.damage, d, false, adv));
    const crit = mean(own ? this.pmf(atk, d, true, adv) : damagePmf(atk.damage, d, true, adv));
    const spec = { kind: 'attack' as const, adv: adv ? ('adv' as const) : roll === MODE.dis ? ('dis' as const) : ('none' as const), flat: atk.toHit, preDice: [], critMin: critMinOf(null, u, atk, d), dc: ac };
    const o = quickOdds(mode & MODE.crit ? { ...spec, autoCritOnHit: true } : spec, oddsFlags(st), this.odds);
    const p = o.pSuccess;
    return { p, hit: p > 0 ? ((p - o.pCrit) * plain + o.pCrit * crit) / p : 0 };
  }

  private reducePmf(e: ExprNode): Pmf {
    let p = this.exprPmfs.get(e);
    if (!p) this.exprPmfs.set(e, (p = exprPmf(e)));
    return p;
  }

  // ---- W1 (docs/design/w1-plan.md): the terms the VCtx closures read, and the two new decisions ----

  /** P1 (W1 review, VCtx.restartCost): the cost of my activation whose root is effect template `rootTpl` (Rage), 0 with none. */
  private restartCost(st: QueryState, me: Unit, rootTpl: number): number {
    for (const f of me.tpl.features) {
      for (const a of f.activate ? [f.activate, ...(f.more ?? [])] : []) if (a.root === rootTpl) return this.activationCost(st, me, f, a);
    }
    return 0;
  }

  /** P8's Explain (on the turn's pass row): with a live drop-to-1 pool, the drop risk the end cost leaves out. Empty otherwise. */
  private dropParts(st: QueryState, me: Unit): ExplainPart[] {
    const s = this.side(me);
    if (!dropSafe(me) || !(s.dropRisk > 0) || me.hp <= 0) return [];
    const left = s.dropRisk * pDrop(this.exposure(st, me, me.cell), me.hp);
    return [{ term: `drops to 1 instead (once): its drop risk here, ${left.toFixed(2)}, isn't counted`, ev: 0 }];
  }

  /**
   * P2 (VCtx.castMargin): the best cast I could make now (each spell entry at its lowest castable
   * level, as loadoutFigures reads them) over my best non-cast option this turn (my best strike from
   * here, times the strikes I have left), at least 0. Memoised per decision for me; 0 with no spells.
   */
  private castMargin(view: UnitView, me: Unit): number {
    if (me.tpl.spells.length === 0 || this.inMargin) return 0;
    if (me.idx === this.meIdx && this.margin === this.margin) return this.margin;
    this.inMargin = true; // a spell that applies a noCasting stat values this again: 0 inside
    const st = view.q;
    const v = this.vctxFor(st, me, view);
    let cast = 0;
    me.tpl.spells.forEach((e, ei) => {
      const lv = e.spell.level;
      let val = -Infinity;
      if (lv === 0) val = this.castValue(v, me, ei, 0, false, me.cell);
      else if (e.freePool >= 0 && me.res[e.freePool]! > 0) val = this.castValue(v, me, ei, lv, true, me.cell);
      else if (e.slotted) {
        for (let l = lv; l <= 9; l++) {
          if (me.res[l - 1]! > 0) {
            val = this.castValue(v, me, ei, l, false, me.cell);
            break;
          }
        }
      }
      if (val > cast) cast = val;
    });
    let strike = 0;
    if (cast > 0) {
      // Greedy v13 (G1a): each attack times the strikes it brings (strikesFor), the best of those.
      me.tpl.attacks.forEach((a, ai) => {
        if (a.spell || !gearOk(st, me, a.gear) || !canWield(me, a, true)) return;
        const k = this.strikesFor(me, ai);
        for (const t of st.units) if (t.life === 'up' && hostile(me, t) && this.inRange(st, a, t, me.cell)) strike = Math.max(strike, this.strikeAtk(view, me, a, t, me.cell) * k);
      });
    }
    this.inMargin = false;
    const m = Math.max(0, cast - strike);
    if (me.idx === this.meIdx) this.margin = m;
    return m;
  }

  /**
   * P3 (VCtx.hitsPerRound): my expected hits per round on `t` with the attacks that carry rider `ri`:
   * my fullest Attack routine's strikes x the best P(hit) among them from where I stand (the engine's
   * own attack spec, effects folded), 0 when none of my attacks carries it.
   */
  private hitsPerRound(view: UnitView, me: Unit, ri: number, t: Unit): number {
    const st = view.q;
    const qs = view.scratch;
    let p = 0;
    for (const a of me.tpl.attacks) {
      if (!a.onHit?.includes(ri) || a.spell || !gearOk(st, me, a.gear) || !canWield(me, a, true)) continue;
      const spec = buildAttackSpecFor(st, me, a, t, me.cell, qs.adv, qs.dis, qs.fold);
      p = Math.max(p, quickOdds(spec, oddsFlags(st)).pSuccess);
    }
    return routineCount(me) * p;
  }

  /**
   * P9 (VCtx.freeMove): a move step's free move from `from`, half my Speed rounded down to 5 ft
   * (floor(speed / 10) x 5: a Goliath's 35 ft gives 15; Speed 0 gives none) and provoking no
   * Opportunity Attacks: the end cost on `from` less the best end cost among the squares it reaches
   * (the turn decision's end-cost and exposure terms), at least 0.
   */
  private freeMoveValue(st: QueryState, me: Unit, from: number): number {
    const half = Math.floor(speedNow(me, st) / 10) * 5;
    if (half <= 0) return 0;
    const n = st.setup.w * st.setup.h;
    if (!this.freeSc || this.freeN !== n) {
      this.freeSc = newReachScratch(n, false);
      this.freeN = n;
    }
    const sc = this.freeSc;
    const u = from === me.cell ? me : { ...me, cell: from }; // a what-if copy standing on `from`
    computeReach(st, u, half, sc);
    const here = this.endCost(st, me, from);
    let best = here;
    forEachLabel(st, u, sc, half, (cell) => {
      const c = this.endCost(st, me, cell);
      if (c < best) best = c;
    });
    return Math.max(0, here - best);
  }
  private freeN = 0;

  /**
   * P11 (VCtx.advGain): Advantage on my next attack roll from `from` (Steady Aim, srd-raw.txt:13790-
   * 13791): my best single strike with Advantage added (any Disadvantage cancels it) less my best
   * without, each with its free riders, so a rider the roll state gates (Sneak Attack's Advantage
   * clause, 13738) counts when it unlocks. At least 0; 0 when no attack roll is left this turn.
   */
  private advGain(view: UnitView, me: Unit, from: number): number {
    const st = view.q;
    // W1.2: the token lasts until the end of this turn (13793-13794), so with no attack roll left in
    // my Attack action (spent, or its attacks all made) it's worth nothing.
    if (this.strikesToCome(me) === 0) return 0;
    const draw = me.b.action > 0 || me.b.atkActive;
    const was = this.forceAdv;
    let plain = 0;
    let adv = 0;
    for (const atk of me.tpl.attacks) {
      if (atk.spell || !gearOk(st, me, atk.gear) || !canWield(me, atk, draw)) continue;
      for (const t of st.units) {
        if (t.life !== 'up' || !hostile(me, t) || !this.inRange(st, atk, t, from)) continue;
        this.forceAdv = false;
        const s0 = this.strikeAtk(view, me, atk, t, from);
        const r0 = this.freeRiders(view, me, atk, t, '', this.lastHitP, null, this.lastAdv);
        this.forceAdv = true;
        const s1 = this.strikeAtk(view, me, atk, t, from);
        this.forceAdv = false;
        const r1 = this.freeRiders(view, me, atk, t, '', this.lastHitP, null, this.lastAdv);
        plain = Math.max(plain, s0 + r0);
        adv = Math.max(adv, s1 + r1);
      }
    }
    this.forceAdv = was;
    return Math.max(0, adv - plain);
  }

  /**
   * P7, the firstAttack decision (Reckless Attack, srd-raw.txt:5021-5022): each offered feature's
   * first-attack program run on me now (value.ts programValue: its effects' mods through modPerRound,
   * my strikes' Advantage share against the incoming Advantage share; an augment's gated step and
   * the rider it switches on), against a straight roll (pass, 0). Taken only when worth more than 0.
   */
  private firstAttack(view: UnitView, dp: DecisionPoint): number {
    const st = view.q;
    const me = st.units[view.me]!;
    let pass = 0;
    for (let i = 0; i < dp.legal.n; i++) if (dp.legal.items[i]!.k === 'pass') pass = i;
    const v: VCtx = { ...this.vctxFor(st, me, view), beforeFirstRoll: true };
    let best = pass;
    let bestQ = 0;
    const rows: { i: number; v: number; parts: ExplainPart[] }[] = [{ i: pass, v: 0, parts: [] }];
    for (let i = 0; i < dp.legal.n; i++) {
      const l = dp.legal.items[i]!;
      if (l.k !== 'pick') continue;
      const f = me.tpl.features[l.opt];
      const fa = f?.firstAttack;
      if (!f || !fa) continue;
      const val = programValue(v, fa.steps, me.cell, { targets: [me], parentRounds: 100 });
      rows.push({ i, v: val, parts: this.explainSink ? this.firstParts(v, me, f.name, fa.steps, val) : [] });
      if (Q(val) > bestQ) [bestQ, best] = [Q(val), i];
    }
    return this.explainRows(dp, me, best, best === pass ? 'no gain over a straight roll: pass' : '', rows);
  }

  /** P7's Explain: the mods of the effects a first-attack program applies to me, mine (my Advantage) and incoming (theirs), and the rest. */
  private firstParts(v: VCtx, me: Unit, name: string, steps: readonly Step[], val: number): ExplainPart[] {
    let mine = 0;
    let theirs = 0;
    for (const s of steps) {
      if (s.k !== 'apply' || s.to !== 'self' || (s.when && !gatesOk(v.st, me, s.when, null))) continue;
      const te = me.tpl.effects[s.fx]!;
      for (const m of te.mods) {
        if (m.consume || m.op === 'floor') continue;
        const x = modPerRound(v, te, m, me);
        if (m.side === 'incoming') theirs += x;
        else mine += x;
      }
    }
    const rest = val - mine - theirs;
    return [
      { term: `${name}: my Advantage +${mine.toFixed(2)}, theirs -${Math.abs(theirs).toFixed(2)}`, ev: mine + theirs },
      ...(Q(rest) !== 0 ? [{ term: `${name}: what its other steps switch on (riders)`, ev: rest }] : []),
    ];
  }

  /**
   * P9, the moveTo decision (Tactical Shift, srd-raw.txt:10661-10663; Withdraw, 13835-13836): where a
   * free move ends, by the turn decision's terms: the strikes I still have this turn from there (none
   * once my Attack action is spent) less the end cost there and the walk's feet and known hazards; no
   * opportunity attack is provoked. Staying (pass) is the same figure here; a tie stays.
   */
  private moveTo(view: UnitView, dp: DecisionPoint): number {
    const st = view.q;
    const me = st.units[view.me]!;
    this.buildFoes(st, me);
    this.buildPairs(st, me, this.upInReach(st, me));
    const come = this.strikesToCome(me);
    const strikes = come < 0 ? routineCount(me) : come;
    const score = (cell: number, l: Legal | null) => {
      const strike = strikes > 0 ? this.bestStrike(view, me, cell)[0] * strikes : 0;
      const end = this.endCost(st, me, cell);
      const walk = l ? l.hazard * 5 + l.ft * this.w.perFoot : 0;
      return { strike, end, walk, v: strike - end - walk };
    };
    let pass = 0;
    for (let i = 0; i < dp.legal.n; i++) if (dp.legal.items[i]!.k === 'pass') pass = i;
    const here = score(me.cell, null);
    let best = pass;
    let bestQ = Q(here.v);
    const rows: { i: number; v: number; parts: ExplainPart[] }[] = [{ i: pass, v: here.v, parts: [{ term: 'strikes from here', ev: here.strike }, { term: 'exposure here', ev: -here.end }] }];
    for (let i = 0; i < dp.legal.n; i++) {
      const l = dp.legal.items[i]!;
      if (l.k !== 'move') continue;
      const s = score(l.cell, l);
      if (this.explainSink) {
        const key = dp.keyOf(i);
        const name = key.startsWith('moveTo:') ? key.slice(7) : key;
        const less = here.end - s.end;
        rows.push({
          i,
          v: s.v,
          parts: [
            { term: `free move to ${name}: ${less >= 0 ? '-' : '+'}${Math.abs(less).toFixed(2)} exposure (exposure there)`, ev: -s.end },
            ...(Q(s.strike) !== 0 || Q(here.strike) !== 0 ? [{ term: 'strikes from there', ev: s.strike }] : []),
            ...(Q(s.walk) !== 0 ? [{ term: 'the walk (feet, known hazards)', ev: -s.walk }] : []),
          ],
        });
      }
      if (Q(s.v) > bestQ) [bestQ, best] = [Q(s.v), i];
    }
    return this.explainRows(dp, me, best, best === pass ? 'no square is better than here: stay' : '', rows);
  }

  /** HOOKX at initiative: its program (refill, heal) against holding it, which buys nothing in a one-fight run (econ.ts). */
  private initHook(view: UnitView, dp: DecisionPoint, me: Unit, h: NonNullable<Unit['tpl']['features'][number]['onInit']>, v: VCtx): number {
    const st = view.q;
    const val = programValue(v, h.steps, me.cell, { targets: [me], parentRounds: 100 });
    const cost = h.pool >= 0 ? this.pointsCost(st, me, h.pool, h.poolCost ?? 1, h) : 0;
    const net = val - cost;
    const chosen = Q(net) > 0 ? 1 : 0;
    const parts: ExplainPart[] = [
      { term: `${h.name}: what it restores (points regained, HP)`, ev: val },
      { term: 'held for later: nothing (Initiative comes once a fight, no rests)', ev: -cost },
    ];
    return this.explainRows(dp, me, chosen, chosen ? '' : 'it would restore nothing: pass', [{ i: 0, v: 0, parts: [] }, { i: 1, v: net, parts }]);
  }

  /** A weaponAttack strike decision: each (attack, target) by its strike value plus its free riders. */
  private strikeTarget(view: UnitView, dp: DecisionPoint): number {
    const st = view.q;
    const me = st.units[view.me]!;
    const via = dp.src?.via ?? '';
    // The step asking: a weaponAttack in one of the feature's activations whose `from` has this attack at this index.
    const find = (ai: number, j: number): { atk: CompiledAttack; grant: string } => {
      for (const f of me.tpl.features) {
        if (f.id !== via || !f.activate) continue;
        for (const a of [f.activate, ...(f.more ?? [])]) for (const s of a.steps) if (s.k === 'weaponAttack' && s.from[j] === ai) return { atk: s.noAbility ? s.noAbility[j]! : me.tpl.attacks[ai]!, grant: a.local };
      }
      // M3 step 5b: a rider's strike (Cleave's second attack, no ability damage).
      for (const r of me.tpl.riders ?? []) {
        if (me.tpl.features[r.feature]!.id !== via) continue;
        for (const o of r.opts) for (const s of o.steps) if (s.k === 'weaponAttack' && s.from[j] === ai) return { atk: s.noAbility ? s.noAbility[j]! : me.tpl.attacks[ai]!, grant: '' };
      }
      return { atk: me.tpl.attacks[ai]!, grant: '' };
    };
    let best = 0;
    let bestV = -Infinity;
    const narrowed = this.w.targetStyle === 'ev' ? -1 : this.styleAmong(st, me, me.cell, Array.from({ length: dp.legal.n }, (_, i) => st.units[dp.legal.items[i]!.target]!)); // G5
    for (let i = 0; i < dp.legal.n; i++) {
      const l = dp.legal.items[i]!;
      const t = st.units[l.target]!;
      if (narrowed >= 0 && t.idx !== narrowed) continue;
      const { atk, grant } = find(l.atk, l.opt);
      let v = this.strikeAtk(view, me, atk, t, me.cell);
      if (t.life === 'up') v += this.freeRiders(view, me, atk, t, grant, this.lastHitP);
      if (Q(v) > Q(bestV)) [bestV, best] = [v, i];
    }
    return best;
  }


  // ---- M3 step 5b: held weapons, the Light extra attack, Nick, the masteries (weapons.ts has the model) ----

  /**
   * My Attack-action strikes left after the one being valued: on a rider or pull decision the
   * strike is already counted in the action; on the turn decision it is one of strikesLeft.
   */
  private strikesAfter(me: Unit): number {
    const light = this.lightAfter(me);
    if (this.dpKind === 'rider' || this.dpKind === 'pull' || this.dpKind === 'target') return (me.b.atkActive ? Math.max(0, this.strikesToCome(me)) : 0) + light;
    if (!(me.b.action > 0 || me.b.atkActive)) return light;
    return this.strikesFor(me, this.curAi) - 1 + light; // greedy v13 (G1a): the valued attack's count
  }

  /**
   * Review AI-3: 1 when the Light property's extra attack (or Nick) still follows the strike being
   * valued this turn (srd-raw.txt:20339-20349): a ready Light act, and the extra attack open now
   * or opened by this strike (an Attack-action strike with a Light weapon, a different one left to
   * make it); 0 while valuing the extra attack itself. No Light feature (all pre-5b content): 0.
   */
  private lightAfter(me: Unit): number {
    if (this.inLight) return 0;
    const acts = lightActs(me);
    if (acts.length === 0) return 0;
    const st = this.curView?.q;
    if (!st || !acts.some((x) => lightActReady(st, me, x))) return 0;
    if (me.b.lightMask !== 0) return lightExtraOpen(me) ? 1 : 0;
    const ai = this.curAi;
    if (ai < 0 || !(me.b.action > 0 || me.b.atkActive)) return 0;
    const it = me.tpl.attacks[ai]!.item;
    if (it === undefined || me.tpl.items[it]!.light !== true) return 0;
    return lightExtraOpen(me, 1 << it) ? 1 : 0;
  }

  /** My best plain strike (no riders) from my square at any hostile, `t` standing on `tCell` instead of its own. */
  private bestPlainWith(view: UnitView, me: Unit, t: Unit, tCell: number): number {
    const st = view.q;
    const moved: Unit = tCell === t.cell ? t : { ...t, cell: tCell };
    const draw = me.b.action > 0 || me.b.atkActive;
    let best = 0;
    for (const atk of me.tpl.attacks) {
      if (atk.spell || !gearOk(st, me, atk.gear) || !canWield(me, atk, draw)) continue;
      for (const u0 of st.units) {
        if (u0 === me || !hostile(me, u0) || u0.life !== 'up') continue;
        const u = u0 === t ? moved : u0;
        if (!this.inRange(st, atk, u, me.cell)) continue;
        best = Math.max(best, this.strikeAtk(view, me, atk, u, me.cell));
      }
    }
    return best;
  }

  /**
   * Push (srd-raw.txt:20437-20440) leaving `t` on `cell`: its next turn from there (cond.ts
   * placeValue), less what my strikes still to come this turn lose if it leaves my reach (the best
   * plain strike from where I stand before and after; moving to follow it isn't counted).
   */
  private pushPlace(st: QueryState, me: Unit, t: Unit, cell: number): number {
    const view = this.curView!;
    const v = this.vctxFor(st, me, view);
    let val = placeValue(v, t, cell);
    const n = this.strikesAfter(me);
    if (n > 0 && !(v.mute & TERM.place)) val -= n * Math.max(0, this.bestPlainWith(view, me, t, t.cell) - this.bestPlainWith(view, me, t, cell));
    return val;
  }

  /**
   * The Light extra attack's value if it were open now for `u` (me, or a copy with a weapon drawn):
   * the best of its ready activations' strikes, a bonus-action one less `otherBonus` (the bonus
   * action it would take), a Nick one (free) in full. `skip`: the Light weapon item bits it can't use.
   */
  private lightExtraWith(view: UnitView, u: Unit, acts: readonly LightAct[], skip: number, otherBonus: number): number {
    const st = view.q;
    let best = 0;
    const wasLight = this.inLight;
    this.inLight = true;
    for (const x of acts) {
      if (!lightActReady(st, u, x)) continue;
      let strike = 0;
      for (let j = 0; j < x.s.from.length; j++) {
        const base = u.tpl.attacks[x.s.from[j]!]!;
        if (!gearOk(st, u, base.gear) || !canWield(u, base)) continue;
        if (base.item !== undefined && (skip & (1 << base.item)) !== 0 && !lightStackSpare(u, base)) continue;
        const atk = x.s.noAbility ? x.s.noAbility[j]! : base;
        for (const t of st.units) {
          if (t === u || !hostile(u, t) || t.life !== 'up' || !this.inRange(st, base, t, u.cell)) continue;
          const sv = this.strikeAtk(view, u, atk, t, u.cell);
          strike = Math.max(strike, sv + this.freeRiders(view, u, atk, t, x.a.local, this.lastHitP));
        }
      }
      best = Math.max(best, x.a.cost === 'bonus' ? strike - otherBonus : strike);
    }
    this.inLight = wasLight;
    return Math.max(0, best);
  }

  /**
   * Drawing weapon `item` (the free object interaction, or the Attack action's unused equip,
   * srd-raw.txt:32707-32712): the Light extra attack it opens (the Attack action used a Light
   * weapon and this is a different one in hand), else the opportunity attack it arms (OA_SHARE of
   * that strike over my best one now). An Attack-action strike draws for free, so that's all.
   */
  private weaponDrawValue(view: UnitView, me: Unit, item: number): number {
    const st = view.q;
    const h = me.hands[0] === HAND.empty ? 0 : me.hands[1] === HAND.empty ? 1 : -1;
    if (h < 0) return 0;
    const hands = Int16Array.from(me.hands);
    hands[h] = item;
    const drawn: Unit = { ...me, hands };
    let light = 0;
    const acts = lightActs(me);
    if (acts.length > 0 && me.b.lightMask !== 0 && !lightExtraOpen(me) && lightExtraOpen(drawn)) {
      const lm = me.b.lightMask;
      light = this.lightExtraWith(view, drawn, acts, (lm & (lm - 1)) === 0 ? lm : 0, 0);
    }
    let oa = 0;
    if (me.b.reaction > 0) {
      const bestOa = (u: Unit) => {
        let b = 0;
        for (const a of u.tpl.attacks) {
          if (a.kind !== 'melee' || a.spell || !gearOk(st, u, a.gear) || !canWield(u, a)) continue;
          for (const t of st.units) if (t.life === 'up' && hostile(u, t) && this.dist(u.cell, t.cell) <= a.reachFt) b = Math.max(b, this.strikeAtk(view, u, a, t, u.cell, true));
        }
        return b;
      };
      oa = OA_SHARE * Math.max(0, bestOa(drawn) - bestOa(me));
    }
    return Math.max(light, oa);
  }

  /**
   * M3 step 5b integration, coverage 8'b G7: stowing held item `item` (a weapon: the Attack action's
   * unused equip; else the free object interaction, else the Action; srd-raw.txt:32707-32712) frees
   * its hand, and a Two-Handed weapon (a Longbow, the Versatile two-handed grip, a loading crossbow)
   * or a throw may need that hand ("A Two-Handed weapon requires two hands when you attack with it",
   * 20392-20393), or a weapon held focus-in-hand blocks a Mace. Worth what it unblocks this turn: the
   * best strike from here over my best one now, if a strike is still to come after a stow that doesn't
   * spend the Action, or the cast it makes legal. A stow that spends the Action gains no strike this
   * turn (review AI-1). Next turn's is loadoutGain's.
   */
  private stowValue(v: VCtx, view: UnitView, me: Unit, item: number): number {
    const st = view.q;
    const h = heldHand(me, item);
    if (h < 0) return 0;
    const cheap = me.b.freeObj > 0 || (me.b.atkEquip > 0 && me.tpl.items[item]!.kind === 'weapon');
    // A free hand for a spell's Somatic component (or a focus or held item it then draws next): the
    // cast it makes legal again (castsUnlocked; Somatic: "A spellcaster must use at least one of
    // their hands to perform these movements", srd-raw.txt:23719-23724).
    const freed = [me.hands[0]!, me.hands[1]!];
    freed[h] = HAND.empty;
    const cast = this.castsUnlocked(v, me, freed, !cheap);
    if (!cheap || !(me.b.atkActive || me.b.action > 0)) return cast;
    const hands = Int16Array.from(me.hands);
    hands[h] = HAND.empty;
    const stowed: Unit = { ...me, hands };
    const best = (u: Unit) => {
      let b = 0;
      for (const a of u.tpl.attacks) {
        if (a.spell || !gearOk(st, u, a.gear) || !canWield(u, a, true)) continue;
        for (const t of st.units) {
          if (t.life !== 'up' || !hostile(u, t)) continue;
          const d = this.dist(u.cell, t.cell);
          if (a.kind === 'melee' ? d > a.reachFt : d > a.longFt) continue;
          b = Math.max(b, this.strikeAtk(view, u, a, t, u.cell));
        }
      }
      return b;
    };
    return Math.max(cast, best(stowed) - best(me));
  }

  // ---- decisions ----

  private moveCost(view: UnitView, me: Unit, l: Legal): { cost: number; oaRisk: number; pDrop: number } {
    const st = view.q;
    let oa = 0;
    if (l.provokes > 0) {
      if (this.oaWorst < 0) {
        // The likeliest opportunity attack: the strongest single melee strike among nearby reactors.
        let worst = 0;
        const ac = acNow(me);
        for (const r of st.units) {
          if (!canReactAgainst(st, r, me) || distFt(st, r.cell, me.cell) > 5 + 10) continue;
          for (const a of r.tpl.attacks) if (a.kind === 'melee' && gearOk(st, r, a.gear)) worst = Math.max(worst, this.attackEV(st, a, ac));
        }
        this.oaWorst = worst;
      }
      oa = l.provokes * this.oaWorst;
    }
    let hz = 0;
    if (l.hazard > 0) hz = l.hazard * 5; // a known zone's trigger: about 5 HP (2d4 per 5 ft); step 6 values each zone
    return { cost: oa + hz + l.ft * this.w.perFoot, oaRisk: oa, pDrop: l.provokes > 0 ? this.oaDropP(st, me, l.provokes) : 0 };
  }

  /**
   * Greedy v8: P(a move that provokes `k` opportunity attacks drops me before I act after it).
   * The reactors: hostiles able to react to me (Reaction unspent) whose reach my movement left can
   * enter (oaReach + moveFt; not moveCost's 15-ft pool, which a path past a farther foe escapes); a
   * reactor reacts once, so `k` counts the k strongest of them, each with its best melee attack it
   * can make now (canWield), its critical range (critMinOf), on a straight roll against my AC
   * [U: Advantage and Disadvantage on the reaction not counted, as oaWorst], ranked by expected
   * damage after my defenses; down at HP + temp HP of damage (oa.ts). [U] Which reactors the path
   * actually leaves is not read, so the top k is an upper bound. Memoised per decision by `k`.
   */
  oaDropP(st: QueryState, me: Unit, k: number): number {
    if (dropSafe(me)) return 0; // W1 (P8): the opportunity attacks can't drop me (I'd drop to 1)
    const hit = this.oaDrop[k];
    if (hit !== undefined && hit === hit) return hit;
    if (!this.oaStrikes) {
      const ac = acNow(me);
      const own = !defStats(me);
      const flags = oddsFlags(st);
      const rows: { ev: number; idx: number; s: OaStrike }[] = [];
      for (const r of st.units) {
        // Review fix: every reactor whose reach my walk this turn can enter (its reach plus my
        // movement left), not moveCost's 15-ft pool: a path past a foe 20 ft off provokes it too.
        if (!canReactAgainst(st, r, me) || distFt(st, r.cell, me.cell) > oaReach(st, r) + me.b.moveFt) continue;
        // Review fix: the attack it can make now (canWield, as oaReach), its critical range
        // (critMinOf), and chosen and ranked by its expected damage after my defenses.
        let best: OaStrike | null = null;
        let bestEv = 0;
        for (const a of r.tpl.attacks) {
          if (a.kind !== 'melee' || !gearOk(st, r, a.gear) || !canWield(r, a)) continue;
          const o = quickOdds({ kind: 'attack', adv: 'none', flat: a.toHit, preDice: [], critMin: critMinOf(st, r, a, me), dc: Math.max(0, Math.min(40, ac)) }, flags, this.odds);
          const hit = own ? this.pmf(a, me, false, false) : damagePmf(a.damage, me, false, false);
          const crit = own ? this.pmf(a, me, true, false) : damagePmf(a.damage, me, true, false);
          const ev = (o.pSuccess - o.pCrit) * mean(hit) + o.pCrit * mean(crit);
          if (ev > bestEv) [best, bestEv] = [{ pHit: o.pSuccess, pCrit: o.pCrit, hit, crit }, ev];
        }
        if (!best) continue;
        rows.push({ ev: bestEv, idx: r.idx, s: best });
      }
      rows.sort((a, b) => (a.ev > b.ev ? -1 : a.ev < b.ev ? 1 : a.idx - b.idx));
      this.oaStrikes = rows.map((x) => x.s);
    }
    const p = oaDropChance(this.oaStrikes.slice(0, k), me.hp + me.tempHp);
    this.oaDrop[k] = p;
    return p;
  }

  private turn(view: UnitView, dp: DecisionPoint): number {
    const st = view.q;
    const me = st.units[view.me]!;
    const items = dp.legal.items;
    const n = dp.legal.n;
    const ex = this.explainSink;
    const seen: { i: number; v: number; parts: () => ExplainPart[] }[] = [];
    const record = (chosen: number, note: string) => {
      if (!ex) return chosen;
      const top = seen.sort((a, b) => Q(b.v) - Q(a.v) || a.i - b.i).filter((x, k, all) => all.findIndex((y) => y.i === x.i) === k).slice(0, 3);
      ex({ at: dp.at, who: me.idx, chosen: dp.keyOf(chosen), note, scored: seen.length, top: top.map((x) => ({ key: dp.keyOf(x.i), ev: x.v, parts: x.parts() })) });
      return chosen;
    };
    for (let i = 0; i < n; i++) if (items[i]!.k === 'stand') return record(i, 'Prone: stand first'); // attackers within 5 ft have Advantage
    this.buildFoes(st, me);
    const upInReach = this.upInReach(st, me);
    this.buildPairs(st, me, upInReach);
    const canAttack = me.b.action > 0 || me.b.atkActive;
    // Greedy v13 (G1a): each attack's strikes this Attack action (strikePlan), not the largest alternative's.
    const plan = this.strikePlan(me);
    const strikes = plan.n;

    // Moves, one per destination: the cheapest label.
    const byCell = new Map<number, Move>();
    let pass = -1;
    let dash = -1;
    let disengage = -1;
    for (let i = 0; i < n; i++) {
      const l = items[i]!;
      if (l.k === 'pass') pass = i;
      else if (l.k === 'option') {
        const core = me.tpl.options[l.opt]!.core;
        if (core === 'core:dash') dash = i;
        else if (core === 'core:disengage' && (disengage < 0 || me.tpl.options[l.opt]!.cost === 'bonus')) disengage = i;
      } else if (l.k === 'move') {
        const { cost, oaRisk, pDrop } = this.moveCost(view, me, l);
        const prev = byCell.get(l.cell);
        if (!prev || cost < prev.cost) byCell.set(l.cell, { i, cell: l.cell, ft: l.ft, cost, oaRisk, pDrop });
      }
    }
    const moves = [...byCell.values()].sort((a, b) => a.cell - b.cell);

    let bestI = pass;
    let bestQ = pass >= 0 ? Q(-this.endCost(st, me, me.cell)) : -Infinity;
    if (ex && pass >= 0) seen.push({ i: pass, v: -this.endCost(st, me, me.cell), parts: () => [{ term: 'exposure here', ev: -this.endCost(st, me, me.cell) }, ...this.dropParts(st, me)] });
    const offer = (i: number, score: number, parts?: () => ExplainPart[]) => {
      if (ex) seen.push({ i, v: score, parts: parts ?? (() => []) });
      const q = Q(score);
      if (q > bestQ || (q === bestQ && (bestI === pass || (i !== pass && i < bestI)))) {
        bestQ = q;
        bestI = i;
      }
    };

    const v = this.vctxFor(st, me, view);
    // Greedy v11: my live pulse's change by destination (value.ts pulseValue, there over here; 0 with
    // none), added to every move offer below: the pulse fires where my turn ends, so a retreat gives it
    // up and a return doesn't earn it again. Positive only if the walk's opportunity attacks leave me up.
    // Incapacitated doesn't stop it: the pulse isn't an action and still fires at my turn's end
    // (sim/triggers.ts turnEnd), and I can still walk.
    const pulseAt = new Float64Array(n);
    const pulseLive = livePulse(st, me);
    if (pulseLive) {
      const p0 = pulseValue(v, me.cell);
      for (const m of moves) pulseAt[m.i] = pulseValue(v, m.cell) - p0;
    }
    const pz = (m: Move) => afterDrop(pulseAt[m.i]!, m.pDrop);
    const pzParts = (m: Move): ExplainPart[] => (Q(pz(m)) !== 0 ? [{ term: PULSE_TERM, ev: pz(m) }] : []);
    // Coverage step 9, greedy v9: the Search action (search.ts), valued once per decision.
    let searchI = -1;
    for (let i = 0; i < n && searchI < 0; i++) if (items[i]!.k === 'search') searchI = i;
    const sv = searchI >= 0 ? searchValue(st, me, view.scratch.reach, this.w.perFoot) : null;
    const searchParts = (hc: number) => () => [
      { term: SEARCH_TERM, ev: sv!.value },
      { term: `  P(the check meets the DC) ${sv!.p.toFixed(2)} x the hazard avoided ${sv!.avoided.toFixed(2)}; reason it knows: ${sv!.why === 'hurt' ? 'it took the hidden hazard\'s damage' : 'an ally saw it appear'}`, ev: 0 },
      { term: 'exposure here', ev: -hc },
    ];
    const valueAt = (i: number, from: number, vv: VCtx = v) => {
      const l = items[i]!;
      return l.k === 'cast' ? this.castValue(vv, me, l.opt, l.lvl, l.aux === 1, from) : this.useValue(vv, me, l, from);
    };

    // M3 step 5b, the Light property (srd-raw.txt:20339-20349): a strike with a Light weapon in the
    // Attack action opens the extra attack with a different Light weapon; it is worth that strike less
    // the best other bonus-action use it would displace (a Nick form: in full). No Light feature: 0.
    const acts = canAttack && me.b.lightMask === 0 ? lightActs(me) : [];
    let lightAny = 0;
    const lightOf: number[] = [];
    if (acts.length > 0) {
      let otherBonus = 0;
      for (let i = 0; i < n; i++) {
        const l = items[i]!;
        if ((l.k === 'cast' || l.k === 'use') && spendsBonus(st, me, l) && !isLightUse(me, l)) otherBonus = Math.max(otherBonus, valueAt(i, me.cell));
      }
      me.tpl.attacks.forEach((atk, ai) => {
        if (atk.item === undefined || me.tpl.items[atk.item]!.light !== true) return;
        const L = this.lightExtraWith(view, me, acts, 1 << atk.item, otherBonus);
        lightOf[ai] = L;
        if (L > lightAny && this.pairAi.includes(ai)) lightAny = L;
      });
    }
    // A strike that doesn't open it, or a destination's strikes: one of the strikes can still be a
    // Light one when more than one is left, at what that one gives up against the best strike.
    const lightLater = (from: number, best: number) => (lightAny > 0 ? Math.max(0, lightAny - (best - this.bestLightStrike(view, me, from))) : 0);

    // Strike now, then end here (or retreat later: the next decision re-scores).
    const here = canAttack ? this.bestStrike(view, me, me.cell) : ([0, -1, -1] as [number, number, number]);
    // The later strikes after one at creature t (review AI-2: once-per-turn riders spent, tokens on t already applied).
    // Greedy v13 (G1b): from the attacks that share the valued attack's alternative (plan.later), per (attack, target).
    const laterHere: number[] = [];
    const laterAt = (ai: number, t: number) => (laterHere[plan.masked ? ai * 64 + t : t] ??= this.laterBest(view, me, me.cell, t, here[0], plan.later[ai] ?? null));
    // W1 review: the best strike routine's score this turn (here, or after a move: below), for a
    // sustained self-buff started before the first attack roll (sustainFirst).
    let routineBest = -Infinity;
    for (let i = 0; i < n; i++) {
      const l = items[i]!;
      if (l.k !== 'attack' || !this.allowed(st, st.units[l.target]!, upInReach) || !this.styleOk(st, me, me.cell, st.units[l.target]!)) continue;
      const s1 = this.strike(view, me, l.atk, st.units[l.target]!, me.cell);
      const sN = strikes[l.atk]!;
      const L = acts.length > 0 ? Math.max(lightOf[l.atk] ?? 0, sN > 1 ? lightLater(me.cell, here[0]) : 0) : 0;
      const more = sN > 1 ? laterAt(l.atk, l.target) : here[0];
      const v = s1 + (sN - 1) * more + L;
      if (v - this.endCost(st, me, me.cell) > routineBest) routineBest = v - this.endCost(st, me, me.cell);
      offer(i, v - this.endCost(st, me, me.cell), () => {
        const atk = me.tpl.attacks[l.atk]!;
        const t = st.units[l.target]!;
        const rp: ExplainPart[] = [];
        this.strikeAtk(view, me, atk, t, me.cell);
        if (Q(this.lastProgress) !== 0) rp.push({ term: PROGRESS_TERM, ev: this.lastProgress });
        if (atk.onHit || atk.onMiss) {
          this.strikeAtk(view, me, atk, t, me.cell);
          this.freeRiders(view, me, atk, t, '', this.lastHitP, rp);
        }
        return [
          { term: 'this strike', ev: s1 },
          ...rp.map((x) => ({ term: `  of which ${x.term}`, ev: x.ev })),
          ...(this.drawsWeapon(me, atk) ? [{ term: `  of which loadout: drawing ${atk.item !== undefined ? me.tpl.items[atk.item]!.name : ''} changes what's in hand`, ev: -this.w.loadoutSwitch / sN }] : []),
          { term: `${sN - 1} more strike(s)`, ev: (sN - 1) * more },
          ...(L > 0 ? [{ term: 'Light: opens the extra attack (its strike less the best other bonus action)', ev: L }] : []),
          { term: 'exposure here', ev: -this.endCost(st, me, me.cell) },
        ];
      });
    }

    // Is some allowed target in reach of a usable attack from here or any destination?
    // Greedy v12 C (stalemate-plan 4.1): for a non-PC under attackDowned ifNoOtherTarget, a target that
    // isn't up doesn't make it engaged while some hostile is up anywhere: it closes on (or Dashes toward)
    // the standing one. "Another target" thus has two meanings, on purpose: here (whether to close) any
    // standing hostile; for whether a body may be struck this turn (allowed), upInReach as before.
    let downedFree = false;
    if (!me.isPc && st.setup.knobs.attackDowned === 'ifNoOtherTarget') {
      for (const u of st.units) {
        if (u.life === 'up' && hostile(me, u)) {
          downedFree = true;
          break;
        }
      }
    }
    const reachFrom = (cell: number, bodies = false) => {
      for (let p = 0; p < this.pairAi.length; p++) {
        const t = st.units[this.pairT[p]!]!;
        if (downedFree && (t.life !== 'up') !== bodies) continue;
        const a = me.tpl.attacks[this.pairAi[p]!]!;
        if (this.inRange(st, a, t, cell) && this.pieceOk(st, me, a, cell)) return true; // E2: a piece's pair only from its square
      }
      return false;
    };
    // Explain only: did C let go of a body that would have held me here or from a destination?
    const heldByBody = () => {
      if (!downedFree) return false;
      if (reachFrom(me.cell, true)) return true;
      for (const m of moves) if (reachFrom(m.cell, true)) return true;
      return false;
    };
    let reachHere = reachFrom(me.cell);
    let engaged = reachHere;
    for (let m = 0; m < moves.length && !engaged; m++) engaged = reachFrom(moves[m]!.cell);
    // Coverage 8'b G1: a PC whose only strikes in reach are worth nothing (a lone Dagger thrown at
    // long range is worth less than the Dagger: strikeAtk's throwAway) isn't engaged; it closes in.
    if (me.isPc && canAttack && engaged && !(here[0] > 0)) {
      let worth = false;
      for (let m = 0; m < moves.length && !worth; m++) worth = this.bestStrike(view, me, moves[m]!.cell)[0] > 0;
      if (!worth) reachHere = engaged = false;
    }
    this.tc = { view, moves, canAttack, engaged, strikes, hereCost: this.endCost(st, me, me.cell) };

    // Casts, granted options and feature activations: from here, and (stepping first) from the two safest destinations.
    const progVals: { i: number; v: number }[] = [];
    // The best option here that doesn't spend the action (a bonus-action cast or use), for "Dodge last" below.
    let bonusBest = -1;
    let bonusBestV = -Infinity;
    const prog: number[] = [];
    // Coverage step 7.6: a monster's action (a breath) worth something here or from a destination this
    // turn: the approach branch's "Dash first" mustn't take the action from it (the book rule).
    let monsterUse = false;
    for (let i = 0; i < n; i++) if (items[i]!.k === 'cast' || items[i]!.k === 'use') prog.push(i);
    const nickKeep: number[] = [];
    // W1 review (Rage before the first swing): with no attack roll made yet this turn and one coming, a
    // sustained self-buff that leaves the action (a Bonus Action Rage) is worth its value plus the best
    // strike routine after it (the buff's own value already counts this turn's hits: its riders per
    // expected hit, Frenzy's arming), so it competes on the routine's scale and comes first. Scored
    // below, once the move-and-strike routines are known. Only for a W1 template (w1Kit).
    const firstUp: { i: number; v: number }[] = [];
    const sustainFirst = canAttack && engaged && me.b.rolls === 0 && w1Kit(me.tpl);
    if (prog.length > 0) {
      const hereCost = this.endCost(st, me, me.cell);
      const here = prog.map((i) => ({ i, v: valueAt(i, me.cell) }));
      // M3 step 5b, Nick (srd-raw.txt:20432-20435): its extra attack takes no Bonus Action, so it also
      // keeps the best other bonus-action use (the bonus Light attack shares its use: not counted).
      if (here.some((x) => isLightUse(me, items[x.i]!))) {
        let keep = 0;
        for (const x of here) if (spendsBonus(st, me, items[x.i]!) && !isLightUse(me, items[x.i]!) && x.v > keep) keep = x.v;
        for (const x of here) {
          const l = items[x.i]!;
          if (keep > 0 && isLightUse(me, l) && activationOf(me.tpl.features[l.opt]!, l.aux).cost === 'free' && x.v > -Infinity) {
            x.v += keep;
            nickKeep[x.i] = keep;
          }
        }
      }
      progVals.push(...here);
      if (!me.isPc) for (const x of here) if (items[x.i]!.k === 'use' && Q(x.v) > 0) monsterUse = true;
      for (const x of here) if (!this.spendsAction(st, me, items[x.i]!) && Q(x.v - hereCost) > Q(bonusBestV)) [bonusBestV, bonusBest] = [x.v - hereCost, x.i];
      // A step-5a activation worth nothing here (a strike with no one in reach, a Dash that brings no
      // one in reach) isn't taken on a tie with pass: it would only spend the bonus action.
      // Coverage step 7.6: nor a monster's action with no one under it: a limited one would be spent on a tie with pass (the book's cost is 0).
      // W1.2: nor, for a template with a W1 field (w1.ts w1Kit), any feature or grant use worth nothing: an
      // Extend Rage after this turn's attack roll already extended it, a Steady Aim with no attack left.
      for (const x of here) {
        if (sustainFirst && Q(x.v) > 0 && this.startsSustain(st, me, items[x.i]!)) firstUp.push(x);
      }
      for (const x of here) if (!firstUp.includes(x) && !((this.isEconUse(me, items[x.i]!) || ((!me.isPc || w1Kit(me.tpl)) && items[x.i]!.k === 'use')) && Q(x.v) <= 0)) offer(x.i, x.v - hereCost, () => [{ term: 'program value, net of its cost', ev: x.v }, ...this.aimParts(v, me, items[x.i]!, me.cell), ...this.bookParts(v, me, items[x.i]!, me.cell, x.v), ...this.termParts(v, me, items[x.i]!, x.v - (nickKeep[x.i] ?? 0), (vv) => valueAt(x.i, me.cell, vv)), ...(nickKeep[x.i] ? [{ term: 'Nick: keeps the Bonus Action (the best other bonus-action use)', ev: nickKeep[x.i]! }] : []), { term: 'exposure here', ev: -hereCost }]);
      // Coverage step 7.2: an aimed area wants the opposite of safe, and is worth 0 here with no one in reach:
      // each listed one at its lowest castable level (list order) is re-valued too, at the squares it covers most from.
      const aimed: { i: number; te: BoundEffect }[] = [];
      for (const x of here) {
        const o = x.v > -Infinity ? this.aimedOption(me, items[x.i]!) : null;
        if (o && !aimed.some((a) => { const l = items[a.i]!; const m = items[x.i]!; return l.k === m.k && l.opt === m.opt && l.aux === m.aux; })) aimed.push({ i: x.i, te: o.te });
      }
      // Stepping somewhere safer first: the three best options here, re-valued from there.
      const top = here.sort((a, b) => b.v - a.v || a.i - b.i).slice(0, 3).filter((x) => x.v > -Infinity);
      const safe = moves.map((m) => ({ m, c: m.cost + this.endCost(st, me, m.cell) })).sort((a, b) => a.c - b.c || a.m.cell - b.m.cell);
      const dests = safe.slice(0, 2);
      const revalue: readonly { i: number }[] = aimed.length > 0 ? [...top, ...aimed.filter((a) => !top.some((x) => x.i === a.i))] : top;
      if (aimed.length > 0) {
        this.aimRanks++;
        const ranked = safe
          .map((sm) => {
            let count = 0;
            for (const a of aimed) for (const c of aimCandidates(v, a.te, sm.m.cell)) count = Math.max(count, c.nEnemies);
            return { sm, count };
          })
          .filter((r) => r.count > 0 && !dests.includes(r.sm))
          .sort((a, b) => b.count - a.count || a.sm.c - b.sm.c || a.sm.m.cell - b.sm.m.cell);
        for (const r of ranked.slice(0, 2)) dests.push(r.sm);
      }
      // W1 review: an option gated on not having moved this turn (Steady Aim, srd-raw.txt:13792-13793)
      // is illegal once I step, so it isn't a destination's program (w1Kit only: no other template has one).
      const kitMoved = w1Kit(me.tpl);
      for (const sm of dests) {
        let bestP = -Infinity;
        let bestAimed = false;
        for (const x of revalue) {
          if (kitMoved && this.needsUnmoved(st, me, items[x.i]!)) continue;
          const val = valueAt(x.i, sm.m.cell);
          if (!me.isPc && items[x.i]!.k === 'use' && Q(val) > 0) monsterUse = true;
          if (val > bestP) [bestP, bestAimed] = [val, aimed.some((a) => a.i === x.i)];
        }
        // Greedy v8: the program happens only if the move's opportunity attacks leave me up.
        const pd = sm.m.pDrop;
        if (bestP > -Infinity) offer(sm.m.i, afterDrop(bestP, pd) + pz(sm.m) - sm.c, () => [{ term: 'best program from there', ev: bestP }, ...(bestAimed ? [{ term: 'from there: aim', ev: bestP }] : []), ...(dropLoss(bestP, pd) > 0 ? [{ term: OA_DROP_TERM, ev: -dropLoss(bestP, pd) }] : []), ...pzParts(sm.m), { term: 'move risk + exposure there', ev: -sm.c }]);
      }
    }

    // Picking up, drawing, stowing or donning an item (coverage 8'b G7: the hand configuration is a
    // state). A hand item changes for what it does this turn (a stow unblocks a better strike or a
    // cast, a draw or pickup a cast, the Light attack or an opportunity attack) or for next turn's best
    // option (loadoutGain, the same state value on both sides), at a switch cost, so a change that buys
    // nothing isn't made and hands stop flipping between turns. A shield is its AC, for an action.
    for (let i = 0; i < n; i++) {
      const l = items[i]!;
      if (l.k !== 'item' || l.aux === ITEM.doff) continue;
      const it = me.tpl.items[l.opt]!;
      const hereCost = this.endCost(st, me, me.cell);
      if (it.kind === 'shield') {
        const g = this.itemValue(v, me, l.opt);
        if (g > 0) offer(i, g - hereCost, () => [{ term: `what ${it.name} gives back`, ev: g }, { term: 'exposure here', ev: -hereCost }]);
        continue;
      }
      const stow = l.aux === ITEM.stow;
      // Stowing the item a live spell of mine came through ends it (sim/hands.ts sourceLost) [U: not valued, so not offered].
      if (stow && st.fx.some((x) => x.alive && x.owner === me.idx && x.srcItem === l.opt)) continue;
      const now = stow ? this.stowValue(v, view, me, l.opt) : this.itemValue(v, me, l.opt);
      const next = Int16Array.from(me.hands);
      if (stow) next[heldHand(me, l.opt)] = HAND.empty;
      else next[next[0] === HAND.empty ? 0 : 1] = l.opt;
      const later = this.loadoutGain(view, me, v, next);
      // This turn's use and next turn's gain are often the same cast: the better of them; a state worse next turn takes off what this turn buys.
      const g = (later > 0 ? Math.max(now, later) : now + later) - this.w.loadoutSwitch;
      if (!(g > 0)) continue;
      const nowTerm = stow ? `stowing ${it.name}: the better strike or cast its hand unblocks` : `what ${it.name} gives back`;
      const laterTerm = "next turn's best option in those hands over these, x gamma";
      offer(i, g - hereCost, () => [
        // The row adds up: with a gain next turn only the better of the two counts (the same cast, this turn or next).
        ...(later > 0
          ? [now >= later ? { term: `${nowTerm} (this turn beats next turn's gain)`, ev: now } : { term: `${laterTerm} (beats this turn's use)`, ev: later }]
          : [{ term: nowTerm, ev: now }, { term: laterTerm, ev: later }]),
        { term: 'loadout: the switch', ev: -this.w.loadoutSwitch },
        { term: 'exposure here', ev: -hereCost },
      ]);
    }

    const stay = pass >= 0 ? -this.endCost(st, me, me.cell) : -Infinity;

    // Move, then strike from there; or move only. Every destination is scored exactly (strike
    // values are cached per class, so this is cheap).
    // Greedy v8: `free` is the value with the move's opportunity attacks gone (no HP cost, the
    // follow-up not discounted): what a bonus-action Disengage first would make of it.
    const scored: { m: Move; v: number; free: number; n?: number; pk?: number }[] = [];
    // Coverage 8'b G2: the best strike this turn, here or after a move (what a Dodge gives up).
    let bestS = { v: here[0], ai: here[1], t: here[2], cell: me.cell };
    if (canAttack && engaged) {
      for (const m of moves) {
        // Greedy v13: the best strike's own count (G1a); with attacks that don't all read as v12, the best
        // routine over attacks, each with its own count and later strikes (G1b, routineAt).
        let all: number;
        let sN: number;
        let b: number, bestA: number, bt: number;
        let lead: number; // the attack the routine opens with (E2: its pickup, for Explain)
        if (plan.masked) {
          all = this.routineAt(view, me, m.cell, plan);
          [b, bestA, bt] = this.routineBest;
          sN = this.routineN || this.strikesFor(me, bestA);
          lead = this.routineA;
        } else {
          [b, bestA, bt] = this.bestStrike(view, me, m.cell);
          sN = this.strikesFor(me, bestA);
          all = b > 0 && sN > 1 ? b + (sN - 1) * this.laterBest(view, me, m.cell, bt, b) : b * sN; // review AI-2
          lead = bestA;
        }
        all += b > 0 ? lightLater(m.cell, b) : 0;
        const there = this.endCost(st, me, m.cell);
        const pk = ex && lead >= 0 && all > 0 ? this.pickupGear(st, me, me.tpl.attacks[lead]!, m.cell) : -1;
        scored.push({ m, v: afterDrop(all, m.pDrop) + pz(m) - m.cost - there, free: all + pulseAt[m.i]! - (m.cost - m.oaRisk) - there, n: sN, pk });
        if (b > bestS.v) bestS = { v: b, ai: bestA, t: bt, cell: m.cell };
      }
      for (const x of scored) {
        if (x.v > routineBest) routineBest = x.v;
        offer(x.m.i, x.v, () => [
          { term: `${x.n ?? 0} strike(s) from there${lightAny > 0 ? ', the Light extra attack included' : ''}${x.pk !== undefined && x.pk >= 0 ? `, picks up its ${onePiece(me.tpl.gear[x.pk]!.name)} there` : ''}`, ev: x.free - pulseAt[x.m.i]! + (x.m.cost - x.m.oaRisk) + this.endCost(st, me, x.m.cell) },
          ...(x.m.pDrop > 0 ? [{ term: OA_DROP_TERM, ev: x.v + x.m.oaRisk - x.free }] : []),
          ...(Q(pulseAt[x.m.i]!) !== 0 ? [{ term: PULSE_TERM, ev: pulseAt[x.m.i]! }] : []),
          { term: 'move risk', ev: -x.m.cost },
          { term: 'exposure there', ev: -this.endCost(st, me, x.m.cell) },
        ]);
      }
      // The sustained self-buff first (sustainFirst above): then the best routine, or staying if none is worth it.
      if (firstUp.length > 0) {
        const hc = this.endCost(st, me, me.cell);
        const after = Math.max(routineBest, -hc);
        for (const x of firstUp) {
          offer(x.i, x.v + after, () => [
            { term: 'program value, net of its cost', ev: x.v },
            ...this.termParts(v, me, items[x.i]!, x.v, (vv) => valueAt(x.i, me.cell, vv)),
            { term: SUSTAIN_FIRST_TERM, ev: after },
          ]);
        }
      }
    } else if (!reachHere && me.isPc && moves.length > 0) {
      // Coverage 8'b G1 (docs/design/coverage.md section 2, m10, M9 (2)): a PC with nothing in reach
      // here closes in for next turn, exposure-aware: a destination is worth gamma x the best strike
      // (or rescue) it can make next turn from there, over what staying gives, less the move's risk
      // and the rise in end cost there. Monsters keep the closing-in term below.
      const hc = this.endCost(st, me, me.cell);
      const g = this.w.gamma;
      const spd = speedNow(me, st);
      const nx = this.nextTurnReach(view, me, upInReach, v);
      if (me.tpl.spells.some((e) => e.spell.areaFrom === 'aim') || me.tpl.features.some((f) => f.activate?.area?.from === 'aim' || f.more?.some((a) => a.area?.from === 'aim'))) this.aimedNext(st, me, v, nx);
      const nextAt = (cell: number, exact: boolean) => {
        // Next turn it strikes from there (exact, M9 (2): top-k destinations only) or moves first.
        let b = exact ? this.bestStrike(view, me, cell)[0] : 0;
        for (const e of nx) {
          if (!(e.v > b)) continue;
          const x = this.nextWorth(st, cell, e, spd);
          if (x > b) b = x;
        }
        return b;
      };
      const rescueOf = (cell: number) => {
        let b = 0;
        for (const e of nx) if (e.rescue && e.v > b) b = Math.max(b, this.rescueAt(st, cell, e, spd));
        return b;
      };
      // M9 fallback (2): the exact strike from a destination only on the APPROACH_TOP_K nearest to a target.
      const exact = new Uint8Array(moves.length);
      if (nx.some((e) => !e.rescue)) {
        const gap = moves.map((m, j) => {
          let d = Infinity;
          for (const e of nx) if (!e.rescue) d = Math.min(d, this.pathFt(st, m.cell, e.cell));
          return { j, d };
        });
        gap.sort((a, b) => a.d - b.d || moves[a.j]!.cell - moves[b.j]!.cell);
        for (let q = 0; q < Math.min(this.approachTopK, gap.length); q++) exact[gap[q]!.j] = 1;
      }
      const raw0 = nextAt(me.cell, true);
      const raw = moves.map((m, j) => nextAt(m.cell, exact[j] === 1));
      const dashOk = canAttack && !engaged && dash >= 0 && !me.b.atkActive;
      let dashE: NextEntry | null = null;
      let dashV = 0;
      if (dashOk) {
        // The core Dash, extra movement equal to my Speed (srd-raw.txt:33242-33248, 1324-1326, as sim/act.ts:25 cites them [U: not re-read, the PDF text isn't in this tree]):
        // this turn's move plus my Speed, then next turn's Speed and the strike or rescue.
        for (const e of nx) {
          if (!(e.v > dashV)) continue;
          const left = this.pathFt(st, me.cell, e.cell) - me.b.moveFt - spd;
          let x = left <= spd + e.reach && !e.rescue ? e.v : 0;
          if (e.rescue) {
            // The turn it heals is what a Dash can change: next turn at best (it has no action left now).
            const short = this.rescueShort(st, me.cell, e);
            x = spd > 0 && short !== Infinity ? e.v * g : 0;
            for (let l = short - me.b.moveFt - spd - spd; l > 0 && x > 0; l -= spd) x *= g;
          }
          if (x > dashV) [dashE, dashV] = [e, x];
        }
      }
      // Coverage 8'b review (ai-logic-2): no square within this turn's move changes next turn's value
      // and nothing could be done from here either, so the far side of the map is still the only way.
      const flat = raw0 === 0 && dashE === null && raw.every((x) => x === 0);
      // What I'd do next turn anyway from here: the best spell (nextTurnCast) is every square's floor.
      // It only matters where a square differs from staying or a Dash could beat it, so it's only
      // valued then (a spell valuation per spell is the cost of this branch: perf, same decisions).
      const floor = flat || raw.some((x) => x !== raw0) || dashV > raw0 ? this.nextTurnCast(v, me) : 0;
      const n0 = Math.max(floor, raw0);
      const closing = flat && !(floor > 0);
      const nearFoe = (cell: number) => {
        let d = Infinity;
        for (const t of st.units) if (t.life === 'up' && hostile(me, t)) d = Math.min(d, this.pathFt(st, cell, t.cell));
        return d;
      };
      const near0 = closing ? nearFoe(me.cell) : 0;
      const closeBy = (ft: number) => (Number.isFinite(ft) && ft > 0 ? (CLOSE_TIE * ft) / 5 : 0);
      let nBest = n0;
      let nearM: Move | null = null;
      let nearD = Infinity;
      let closeBest = 0;
      moves.forEach((m, j) => {
        const nv = Math.max(floor, raw[j]!);
        nBest = Math.max(nBest, nv);
        const rise = this.endCost(st, me, m.cell) - hc;
        const close = closing ? closeBy(near0 - nearFoe(m.cell)) : 0;
        closeBest = Math.max(closeBest, close);
        // Greedy v8: next turn's value from there counts only if this move's opportunity attacks leave me up.
        const gain = g * (afterDrop(nv, m.pDrop) - n0) + close + pz(m) - m.cost - rise;
        scored.push({ m, v: gain - hc, free: g * (nv - n0) + close + pulseAt[m.i]! - (m.cost - m.oaRisk) - rise - hc });
        if (dashE || closing) {
          const d = dashE ? this.pathFt(st, m.cell, dashE.cell) : nearFoe(m.cell);
          if (d < nearD || (d === nearD && nearM !== null && m.cell < nearM.cell)) [nearD, nearM] = [d, m];
        }
        // A pulse-only gain needs no clause here: the move-only fallback below offers the same move at least as high.
        if (nv > n0 || close > 0 ? gain > 0 : gain >= this.w.retreatMin) {
          offer(m.i, gain - hc, () => {
            const r = rescueOf(m.cell);
            return [
              { term: 'next turn: the best strike or rescue from there, x gamma, over staying', ev: g * (nv - n0) },
              ...(dropLoss(nv, m.pDrop) > 0 ? [{ term: OA_DROP_TERM, ev: -g * dropLoss(nv, m.pDrop) }] : []),
              ...(r > 0 && r >= nv ? [{ term: '  of which a rescue: a heal on a downed ally (RESCUE)', ev: g * (r - n0) }] : []),
              ...(nx.some((e) => e.aim && e.v >= nv && this.nextWorth(st, m.cell, e, spd) > 0) ? [{ term: '  of which from there: aim, next turn', ev: g * (nv - n0) }] : []),
              ...(close > 0 ? [{ term: CLOSING_TERM, ev: close }] : []),
              ...pzParts(m),
              { term: 'move risk', ev: -m.cost },
              { term: 'rise in exposure there', ev: -rise },
              { term: 'exposure here', ev: -hc },
            ];
          });
        }
      });
      // Dash only for what no move without it brings in reach by next turn; its rise is at least
      // the move nearest the target's (it ends nearer still).
      if (dashE && Q(dashV) > Q(nBest) && nearM) {
        const nm = nearM as Move;
        const riseD = nm.cost + this.endCost(st, me, nm.cell) - hc;
        // Greedy v8: the Dash's walk is at least the nearest move's, opportunity attacks included.
        const gv = g * (afterDrop(dashV, nm.pDrop) - n0);
        offer(dash, gv + pz(nm) - riseD - hc, () => [
          { term: `Dash: the ${dashE!.rescue ? 'rescue' : dashE!.aim ? 'aimed area' : 'strike'} it brings in reach by next turn, x gamma, over staying`, ev: g * (dashV - n0) },
          ...(dropLoss(dashV, nm.pDrop) > 0 ? [{ term: OA_DROP_TERM, ev: -g * dropLoss(dashV, nm.pDrop) }] : []),
          ...pzParts(nm),
          { term: 'move risk + rise in exposure (at least the nearest move\'s)', ev: -riseD },
          { term: 'exposure here', ev: -hc },
        ]);
      }
      // ai-logic-2: on the same basis, nothing else to spend the action on: Dash to close twice as far.
      if (closing && dashOk && nearM && closeBest > 0) {
        const nm = nearM as Move;
        const riseD = nm.cost + this.endCost(st, me, nm.cell) - hc;
        const cl = closeBy(Math.min(me.b.moveFt + spd, near0 - 5));
        if (cl > closeBest) {
          offer(dash, cl + pz(nm) - riseD - hc, () => [
            { term: `Dash: ${CLOSING_TERM}`, ev: cl },
            ...pzParts(nm),
            { term: 'move risk + rise in exposure (at least the nearest move\'s)', ev: -riseD },
            { term: 'exposure here', ev: -hc },
          ]);
        }
      }
    } else if (!reachHere && !me.isPc && moves.length > 0) {
      // Nothing in reach from here (and no strike this turn): close in on the nearest standing
      // hostile. Exposure doesn't count: a melee creature that keeps its distance never fights
      // (design 1.5). If nothing is reachable even after moving, the action buys movement.
      if (canAttack && !engaged && dash >= 0 && !me.b.atkActive && !monsterUse) {
        // Coverage step 9: unless a Search for a hazard it has reason to suspect is worth more than
        // the closing the Dash buys (approach per 5 ft of its Speed).
        const dashWorth = (this.w.approach * speedNow(me, st)) / 5;
        const hcS = sv ? this.endCost(st, me, me.cell) : 0;
        if (sv && Q(sv.value - hcS) > Q(dashWorth)) {
          if (ex) seen.push({ i: searchI, v: sv.value - hcS, parts: searchParts(hcS) });
          return record(searchI, `nothing in reach even after moving, and a hidden hazard it has reason to suspect: Search first${ex && heldByBody() ? `; ${DOWNED_FREE_TERM}` : ''}`);
        }
        return record(dash, `nothing in reach even after moving: Dash first${ex && heldByBody() ? `; ${DOWNED_FREE_TERM}` : ''}`);
      }
      const near = (cell: number) => {
        let d = Infinity;
        for (const t of st.units) if (t.life === 'up' && hostile(me, t)) d = Math.min(d, this.dist(cell, t.cell));
        return d;
      };
      const d0 = near(me.cell);
      for (const m of moves) {
        const v = (this.w.approach * (d0 - near(m.cell))) / 5 + pz(m) - m.cost;
        scored.push({ m, v, free: v - pz(m) + pulseAt[m.i]! + m.oaRisk });
        if (v > 0) offer(m.i, stay + v, () => [{ term: 'closing in', ev: v - pz(m) + m.cost }, ...(heldByBody() ? [{ term: DOWNED_FREE_TERM, ev: 0 }] : []), ...pzParts(m), { term: 'move risk', ev: -m.cost }, { term: 'exposure here (approach ignores it)', ev: stay }]);
      }
    } else {
      // The action's spent (or there's nothing to approach): move only to cut exposure, and only if it's worth it.
      for (const m of moves) {
        const v = pz(m) - m.cost - this.endCost(st, me, m.cell);
        scored.push({ m, v, free: v - pz(m) + pulseAt[m.i]! + m.oaRisk });
        if (v - stay >= this.w.retreatMin) offer(m.i, v, () => [...pzParts(m), { term: 'move risk', ev: -m.cost }, { term: 'exposure there', ev: -this.endCost(st, me, m.cell) }]);
      }
    }

    // Coverage 8'b review (ai-logic-1, m10): walk, then heal, this turn. A heal isn't legal until a
    // downed ally is in its range (sim/cast.ts anyTarget), so the casts above never see this one: each
    // heal this turn's budget pays for is valued from the cheapest destination in its range with a line to the target, whichever
    // branch ran above. One out of range from every destination is next turn's (nextWorth).
    if (me.isPc && moves.length > 0 && !has(me, COND.incapacitated)) {
      const down = st.units.filter((u) => u !== me && u.team === me.team && (u.life === 'down' || u.life === 'stable'));
      if (down.length > 0) {
        const heals: NextEntry[] = [];
        this.healsNext(me, v, down, heals, true);
        for (const h of heals) {
          if (this.dist(me.cell, h.cell) <= h.reach && this.lineTo(st, me.cell, h.cell)) continue; // in range here: its own option, above
          let best: Move | null = null;
          let bestC = Infinity;
          for (const m of moves) {
            if (this.dist(m.cell, h.cell) > h.reach) continue;
            if (!this.lineTo(st, m.cell, h.cell)) continue; // sim/cast.ts anyTarget wouldn't offer it there
            const c = m.cost + this.endCost(st, me, m.cell);
            if (c < bestC) [best, bestC] = [m, c];
          }
          if (!best) continue;
          const m = best as Move;
          const val = h.val!(m.cell);
          if (!(val > 0)) continue;
          // Greedy v8: the heal happens only if the walk's opportunity attacks leave me up.
          offer(m.i, afterDrop(val, m.pDrop) + pz(m) - bestC, () => [
            { term: RESCUE_NOW_TERM, ev: val },
            ...(dropLoss(val, m.pDrop) > 0 ? [{ term: OA_DROP_TERM, ev: -dropLoss(val, m.pDrop) }] : []),
            ...pzParts(m),
            { term: 'move risk', ev: -m.cost },
            { term: 'exposure there', ev: -this.endCost(st, me, m.cell) },
          ]);
        }
      }
    }

    // Coverage step 7.5 review: my live Emanation goes where I walk (sim/zones.ts moveAura), so a step that
    // drags it onto a foe is worth that foe's moved-onto hook (Spirit Guardians, srd-raw.txt:31041-31043),
    // whatever the branch above priced the move at: with the action spent, a move otherwise only cuts exposure.
    if (st.ownerAuras !== 0 && moves.length > 0 && !has(me, COND.incapacitated)) {
      for (const m of moves) {
        const d = auraDragValue(v, m.cell);
        if (!(d > 0)) continue;
        const there = this.endCost(st, me, m.cell);
        offer(m.i, d + pz(m) - m.cost - there, () => [{ term: AURA_DRAG_TERM, ev: d }, ...pzParts(m), { term: 'move risk', ev: -m.cost }, { term: 'exposure there', ev: -there }]);
      }
    }

    // Session S: my live turn-end Emanation pulse (an effect's turnEnd hook with an `around` step) fires
    // where my turn ends, so a move that puts more foes and fewer allies in it is worth the difference
    // (value.ts pulseValue; friendly fire counts against it), whatever else the move was priced at.
    // Greedy v11: the move-only fallback, at the engaged exposure there and only if the walk leaves me up;
    // every other move offer above carries the same delta (pulseAt).
    if (pulseLive && moves.length > 0) {
      for (const m of moves) {
        if (!(pulseAt[m.i]! > 0)) continue;
        const d = pz(m);
        const there = this.endCost(st, me, m.cell);
        offer(m.i, d - m.cost - there, () => [{ term: PULSE_TERM, ev: d }, { term: 'move risk', ev: -m.cost }, { term: 'exposure there', ev: -there }]);
      }
    }

    // The Dodge action (M3 step 5a, srd-raw.txt:33369-33376): Disadvantage on attacks against me
    // until my next turn, over my exposure here. Coverage 8'b G2 and G4: dodgeTerm.
    for (let i = 0; i < n; i++) {
      if (items[i]!.k !== 'dodge') continue;
      const hc = this.endCost(st, me, me.cell);
      const d = this.dodgeTerm(view, me, me.cell, v);
      // A Dodge worth nothing (nothing threatens me, or the attacks already have Disadvantage) isn't an
      // option: `offer` breaks a tie with pass toward the non-pass, and an idle Dodge would feed G4's streak,
      // the dodge-loop cause and H's Dodge share, and mark me as turtling for an ally's dodgeAllyTurns.
      if (!(d.value > 0)) continue;
      offer(i, d.value - hc, () => [
        { term: DODGE_TERM, ev: d.raw },
        ...(d.ally > 0 ? [{ term: "  of which bought: an ally's turns before the attackers act", ev: d.ally }] : []),
        ...(d.conc > 0 ? [{ term: '  of which bought: my concentration effect, what it has left', ev: d.conc }] : []),
        ...(d.heal > 0 ? [{ term: '  of which bought: a rescue or heal I have pending next turn', ev: d.heal }] : []),
        ...(d.kept < d.raw ? [{ term: 'past what the time buys: delay alone counts nothing', ev: d.kept - d.raw }] : []),
        ...(d.value < d.kept ? [{ term: 'no progress: Dodges running with no HP change on either side', ev: d.value - d.kept }] : []),
        { term: 'exposure here', ev: -hc },
      ]);
    }

    // Coverage step 9, greedy v9: the Search action for a hidden zone, worth P(success) x the hazard
    // its next path avoids, only with a reason the unit can know (search.ts). It spends the action here.
    if (sv) {
      const hc = this.endCost(st, me, me.cell);
      offer(searchI, sv.value - hc, searchParts(hc));
    }

    // Disengage first when the best plan would be a move that provokes: a bonus-action Disengage
    // removes the risk for free; the action one gives up any strike this turn.
    // M3 step 5a: a feature activation that takes the Disengage action (Patient Defense, Step of
    // the Wind's Focus form) is a candidate too, with what else it does net of its cost, less the
    // best other bonus-action use it gives up.
    // Its other steps (a Dodge) are valued where the move ends, not where it starts: the Dodge
    // lasts until my next turn, which I spend at the destination (review AI-1).
    const disC: { i: number; bonus: boolean; alt: number; v0: number; atDest: boolean }[] = [];
    if (disengage >= 0) disC.push({ i: disengage, bonus: me.tpl.options[items[disengage]!.opt]!.cost === 'bonus', alt: 0, v0: 0, atDest: false });
    for (const x of progVals) {
      const l = items[x.i]!;
      if (l.k !== 'use' || l.fx >= 0) continue;
      const a = activationOf(me.tpl.features[l.opt]!, l.aux);
      if (!a.steps.some((st2) => st2.k === 'core' && st2.act === 'disengage')) continue;
      let alt = 0;
      for (const y of progVals) {
        const m2 = items[y.i]!;
        if (y.i === x.i || m2.k !== 'use' || m2.fx >= 0) continue;
        const b = activationOf(me.tpl.features[m2.opt]!, m2.aux);
        if (b.cost === a.cost && !b.steps.some((st2) => st2.k === 'core' && st2.act === 'disengage')) alt = Math.max(alt, y.v);
      }
      disC.push({ i: x.i, bonus: a.cost !== 'action', alt, v0: x.v, atDest: a.steps.some((st2) => st2.k === 'core' && st2.act === 'dodge') });
    }
    let disBest = -Infinity;
    let disI = -1;
    let disW: { c: (typeof disC)[number]; cell: number; mv: number; own: number; stale: number } | null = null;
    // Greedy v8 review: an action Disengage only escapes (it buys no follow-up this turn), so after
    // dodgeStaleAfter of my turns with no HP change on either side its escape (end cost here less
    // the walk's other cost and the end cost there) decays like a stale Dodge (G4's weights): two
    // units otherwise loop Disengage-and-walk against Dash-after forever (duel no-damage stalemates).
    const quiet = this.curView!.queries.quietTurns(me.idx);
    let fade = 1;
    for (let k = 0; k < quiet - this.w.dodgeStaleAfter + 1; k++) fade *= this.w.dodgeDecay;
    const hcD = this.endCost(st, me, me.cell);
    for (const c of disC) {
      for (const x of scored) {
        if (x.m.oaRisk <= 0) continue;
        let mv = c.bonus ? x.free : -(x.m.cost - x.m.oaRisk) - this.endCost(st, me, x.m.cell);
        let stale = 0;
        if (!c.bonus && fade < 1 && mv > -hcD) {
          stale = (1 - fade) * (mv + hcD);
          mv -= stale;
        }
        const own = c.atDest ? valueAt(c.i, x.m.cell) : c.v0;
        const total = mv + own - c.alt;
        if (Q(total) > Q(disBest)) [disBest, disI, disW] = [total, c.i, { c, cell: x.m.cell, mv: mv + stale, own, stale }];
      }
    }
    if (disI >= 0 && disW && Q(disBest) > bestQ) {
      const { c, cell, mv, own, stale } = disW;
      if (ex) {
        seen.push({
          i: disI, v: disBest, parts: () => [
            { term: 'the move it frees of opportunity attacks, net of its risk and exposure there', ev: mv },
            ...(stale > 0 ? [{ term: DISENGAGE_STALE_TERM, ev: -stale }] : []),
            ...(c.i === disengage ? [] : [{ term: 'what else it does there, net of its cost', ev: own }, ...this.termParts(v, me, items[c.i]!, own, (vv) => valueAt(c.i, cell, vv))]),
            ...(c.alt !== 0 ? [{ term: 'the other bonus action it gives up', ev: -c.alt }] : []),
          ],
        });
      }
      return record(disI, 'the best move provokes: Disengage first');
    }
    // Dodge last (M3 step 5a): its benefit runs from when it's taken to the start of my next turn, so
    // taking it after a worthwhile bonus action loses nothing, and that bonus action (a heal) may
    // change what the action is best spent on. The next decision re-scores the Dodge.
    if (bestI >= 0 && items[bestI]!.k === 'dodge' && bonusBest >= 0 && Q(bonusBestV) > Q(stay)) return record(bonusBest, 'Dodge last: a bonus action first');
    const pick = bestI >= 0 ? bestI : 0;
    return record(pick, '');
  }

  private reaction(view: UnitView, dp: DecisionPoint): number {
    const st = view.q;
    const me = st.units[view.me]!;
    // Keep the Reaction for a pre-roll reaction worth more than a weak opportunity attack.
    let reserve = me.tpl.features.some((f) => f.preRoll !== null) ? 2 : 0;
    // M3 step 5a: and for a damage-reducing reaction (econ.ts DEFLECT_KEEP), what it would save of my exposure here.
    const ht = me.tpl.features.find((f) => f.hitTaken)?.hitTaken;
    if (ht) {
      const e = this.exposure(st, me, me.cell);
      const eR = ht.reduce === 'halve' ? e / 2 : mean(this.reducePmf(ht.reduce));
      reserve = Math.max(reserve, DEFLECT_KEEP * Math.min(eR, e) * this.side(me).exposure);
    }
    // Coverage 8'b: and for a hit-known or damage-taken reaction, valued (inert without one: no field on any feature).
    if (st.watchHitKnown || st.watchDamaged) reserve = Math.max(reserve, this.reactionReserve(view, me));
    // Coverage step 9+: and for a declared reaction (Redirect Attack), inert without one.
    if (st.watchDeclared) reserve = Math.max(reserve, this.declaredReserve(view, me));
    let best = 0;
    let bestV = reserve;
    for (let i = 0; i < dp.legal.n; i++) {
      const l = dp.legal.items[i]!;
      if (l.k !== 'oa') continue;
      const v = this.strike(view, me, l.atk, st.units[l.target]!, me.cell, true);
      if (v > bestV) {
        bestV = v;
        best = i;
      }
    }
    return best;
  }
}

/** Coverage 8'b G1: something I could do next turn, and how far from `cell` I can do it from; `val`: a rescue's worth cast from a given square. */
type NextEntry = { cell: number; reach: number; v: number; rescue: boolean; val?: (from: number) => number; aim?: true };

/** W1 (P11): the COND bits a program's endConditions steps end (a choice's options included), for its Explain line. */
function endBits(steps: readonly Step[]): number {
  let bits = 0;
  for (const s of steps) {
    if (s.k === 'endConditions') bits |= s.bits;
    else if (s.k === 'choose') for (const o of s.opts) bits |= endBits(o.steps);
  }
  return bits;
}

/** How many strikes `u`'s Attack action has at most. */
function routineCount(u: Unit): number {
  let most = 1;
  for (const alt of u.tpl.attackAct.alts) {
    let n = 0;
    for (const g of alt) n += g.count;
    most = Math.max(most, n);
  }
  return most;
}

/** M3 step 8'a: the AC a hitKnown reaction adds against the triggering attack (its ac, plus flat ac stats of effects its steps apply to self; gates ignored). */
function acGainOf(tpl: CompiledTemplate, hk: NonNullable<CompiledFeature['hitKnown']>): number {
  let g = hk.ac;
  for (const step of hk.steps) {
    if (step.k !== 'apply' || step.to !== 'self') continue;
    for (const stat of tpl.effects[step.fx]?.stats ?? []) if (stat.k === 'ac') g += stat.n;
  }
  return g;
}

/** E2's Explain line: one piece of a counted gear's (plural) name, "Spears" -> "Spear" (a trailing "s", not "ss"). */
function onePiece(name: string): string {
  return name.endsWith('s') && !name.endsWith('ss') ? name.slice(0, -1) : name;
}
