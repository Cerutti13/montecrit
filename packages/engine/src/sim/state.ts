// Game state: plain data, integers and small arrays only, no closures. Everything a fight
// changes lives here; templates, terrain and setup are shared read-only.

import type { CompiledAttack, CompiledStat, CompiledTemplate, ContentCond, Id, ZoneAffects } from '../content/types.ts';
import { ODDS_FLAGS } from '../rolls/rollspec.ts';
import { FLAG_KEYS, flagIndex, LEGACY_FLAG_COUNT, trimLateFlags, type RuleFlags } from '../rules/flags.ts';
import { canonicalJson } from '../util/canon.ts';
import { hash64 } from '../util/hash.ts';
import { buildCounterLayout, newCounters, type CounterLayout, type Counters } from './counters.ts';
import type { FightSetup } from './setup.ts';

/**
 * Condition bits. condMask is a cache of `conds`; only addCond/removeCond (and the removal
 * loops in sim/effects.ts, which call refreshMask) write either. Bits 16 and up are M3 step 4's
 * content conditions (SRD 5.2.1 Rules Glossary, srd-raw.txt lines cited in sim/conditions.ts);
 * append only: a bit is a log id's position and a condMask value in stateHash.
 */
export const COND = {
  prone: 1,
  unconscious: 2,
  incapacitated: 4,
  disengaged: 8,
  blinded: 16,
  charmed: 32,
  frightened: 64,
  paralyzed: 128,
  poisoned: 256,
  restrained: 512,
  stunned: 1024,
  /** M3 step 5a: the Dodge action's benefits, until the start of its next turn (sim/conditions.ts). */
  dodging: 2048,
} as const;
export const COND_IDS: readonly [number, Id][] = [
  [COND.prone, 'core:prone'],
  [COND.unconscious, 'core:unconscious'],
  [COND.incapacitated, 'core:incapacitated'],
  [COND.disengaged, 'core:disengaged'],
  [COND.blinded, 'core:blinded'],
  [COND.charmed, 'core:charmed'],
  [COND.frightened, 'core:frightened'],
  [COND.paralyzed, 'core:paralyzed'],
  [COND.poisoned, 'core:poisoned'],
  [COND.restrained, 'core:restrained'],
  [COND.stunned, 'core:stunned'],
  [COND.dodging, 'core:dodging'],
];

/** COND bit of a content condition name. */
export function condBit(name: ContentCond): number {
  return COND[name];
}

export type Life = 'up' | 'down' | 'stable' | 'dead';

/**
 * When something ends. turnStart/turnEnd fire at that boundary of `unit`'s first turn with
 * units[unit].turns > after: "until the end of your next turn" is after = your turns now,
 * Disengage's "this turn" is after = turns - 1. That's right whether the effect lands on the
 * anchor's own turn or someone else's. `timed` is a duration in rounds: it ends on the
 * creator's turn number `turn`, at the start or the end per timedDurationExpiryPoint.
 */
export type Expiry =
  | { readonly k: 'never' }
  | { readonly k: 'turnStart' | 'turnEnd'; readonly unit: number; readonly after: number }
  | { readonly k: 'timed'; readonly unit: number; readonly turn: number }
  | { readonly k: 'effect'; readonly effect: number }; // ends with that Fx

export interface CondInstance {
  readonly bit: number;
  /** What imposed it: 'core:downed', 'core:disengage', a content id... */
  readonly via: Id;
  readonly src: number; // unit idx, or -1
  readonly cause: number; // seq of the event that imposed it
  readonly until: Expiry;
}

export interface Budget {
  action: number;
  bonus: number;
  reaction: number;
  moveFt: number;
  /** Alternating diagonals only: 1 when the next diagonal costs 10 ft. */
  diagParity: number;
  /** An Attack action has started this turn and can still take more strikes. */
  atkActive: boolean;
  /** Strikes made with each attack index under the current Attack action. */
  readonly atkCounts: Uint8Array;
  /** Bitmask of attackAct.alts that can still absorb those strikes. */
  atkLive: number;
  /** The one free object interaction (p.10): 1 until used this turn. */
  freeObj: number;
  /**
   * Feet of voluntary movement spent this turn (the hasntMoved gate, M3 step 4). Reset with the
   * budget; left out of stateHash: it's within-turn bookkeeping that only a gate reads (C3).
   */
  movedFt: number;
  /**
   * The Speed `moveFt` was last derived from, the Dash actions taken and the feet spent standing
   * up this turn: when Speed changes mid-turn (a Restrained ends), the budget is re-derived from
   * them (walker.ts syncBudget). Within-turn bookkeeping, left out of stateHash like movedFt (C3).
   */
  speedAt: number;
  dashes: number;
  standFt: number;
  /**
   * M3 step 5b, within-turn bookkeeping left out of stateHash like movedFt (C3; only held-weapon
   * PCs ever set them). lightMask: bits (1 << tpl.items index) of the Light weapons it attacked
   * with in the Attack action this turn (the Light property's extra attack, srd-raw.txt:20341-20345).
   * atkEquip: 1 while the Attack action's last strike left its weapon equip unused ("You can
   * either equip or unequip one weapon when you make an attack as part of this action ... either
   * before or after the attack", srd-raw.txt:32707-32712).
   */
  lightMask: number;
  atkEquip: number;
  /**
   * Coverage step 9 review: a voluntary walk planned without a hidden zone that was refused on its
   * first step (walker.ts): bit 3*(dy+1)+(dx+1) for each neighbor of refusedFrom it refused. While it
   * still stands on refusedFrom on its own turn, computeReach treats those squares as impassable, so
   * its decider can't pick the same moves again (no endless re-pick; at most 8 refusals per square)
   * and can still pick any other. 0 / -1 when none; reset each turn.
   * Within-turn bookkeeping, left out of stateHash like movedFt (C3).
   */
  refused: number;
  refusedFrom: number;
  /**
   * W1 (docs/design/w1-plan.md P7): attack rolls made this turn, so a firstAttack feature (Reckless
   * Attack) is offered only before the first. W1 (P9): feet of free movement (a move step's half
   * Speed) taken this turn under freeMoveUsesMovement=false, kept apart from moveFt and movedFt; the
   * hasntMoved gate reads movedFt + freeFt. Both reset each turn (sim/fight.ts resetBudget, W1.1)
   * and, as within-turn bookkeeping, left out of stateHash like movedFt (C3).
   */
  rolls: number;
  freeFt: number;
}

/**
 * One live (or ended) effect: a spell's concentration instance, a zone, a rider, a form.
 * Plain data; what it does lives in its owner's compiled template (tpl.effects[tpl]).
 * Ids are indices into st.fx, append-only, so creation order is the canonical order.
 */
export interface Fx {
  readonly id: number;
  /** Index into units[owner].tpl.effects: the effect bound for that caster and cast level. */
  readonly tpl: number;
  readonly owner: number;
  /** Unit it sits on; -1 for zones and spell instances. */
  readonly bearer: number;
  /** Fx it ends with (a concentration instance or a form root); -1. */
  readonly parent: number;
  /** Interned spell id for same-spell potency (p.106); -1 for features. */
  readonly sid: number;
  /** Cast level, the potency rank. */
  readonly lvl: number;
  /** A per-cast choice (a chosen skill); -1. */
  readonly param: number;
  /** tpl.items index of the item it was cast through; -1. */
  readonly srcItem: number;
  /** owner.turns when it was created ("on later turns" grants). */
  readonly born: number;
  /** Mutable since W1 (P1): a sustained effect (Rage) is re-anchored by sim/effects.ts sustain and extendSource. */
  until: Expiry;
  readonly cause: number;
  alive: boolean;
  /** Children in creation order, as a linked list of fx ids (-1 ends it). */
  firstChild: number;
  lastChild: number;
  nextSib: number;
  /** Zone slot (0..31) and lattice anchor while it's a placed zone; -1. */
  zbit: number;
  anchor: number;
  /** Coverage step 7.2: which way an aimed zone points (grid/area.ts AIMS); undefined for every other effect. A zone whose BoundEffect has zone.from anchors on a square, not the lattice. */
  aim: number | undefined;
  /** The owner's hand a conjured effect occupies; -1. */
  hand: number;
  /** Once-per-turn ledger: st.turnIdx when it last fired on each unit (-1). */
  readonly hit: Int32Array | null;
  /** perMove: 5-ft increments traveled this move, per unit. */
  readonly acc: Uint8Array | null;
  /**
   * Per unit, what it knows of this zone (zoneKnowledge): 1 = saw it appear or recognized it
   * (a Search, or its damage under hiddenHazardRevealedByDamage); 2 (coverage step 9) = hurt by it
   * while it was a hidden zone it hadn't recognized (a reason to Search it can know); 0 = neither.
   */
  readonly seen: Uint8Array | null;
  /** Coverage step 9: a hidden zone's Search DC, bound when it was cast (BoundEffect.hiddenDc); -1. */
  readonly hdc: number;
}

export const NO_STATS: readonly BearerStat[] = Object.freeze([]);

/** Hand contents besides a tpl.items index. */
export const HAND = { empty: -1, conjured: -2 } as const;

export interface Unit {
  /** Position in setup.seats (seat id order). */
  readonly idx: number;
  readonly seat: string;
  readonly seatKey: number;
  readonly team: 0 | 1;
  readonly tpl: CompiledTemplate;
  readonly isPc: boolean;
  readonly atZero: 'dies' | 'deathSaves';
  cell: number;
  hp: number;
  hpMax: number;
  tempHp: number;
  life: Life;
  deathOk: number;
  deathFail: number;
  condMask: number;
  readonly conds: CondInstance[];
  init: number;
  initTie: number;
  readonly surprised: boolean;
  /** Remaining count per tpl.gear entry; -1 = not counted. */
  readonly gear: Int16Array;
  readonly b: Budget;
  /** Turns this unit has begun (ghost turns of a dead anchor included). Anchors Expiry.after. */
  turns: number;
  /**
   * Coverage 8'b G4, critique M7: the no-progress streak is fight state, not decider memory, so a
   * journal resumed mid-streak decides the same (read through noProgressTurns or Queries).
   * dodgeRun: its consecutive turns, among those it began up, on which it took the Dodge (the core
   * action or a feature's Dodge step). quietTurns: its turn ends in a row with no HP change on either
   * side since the one before (hpSeen: st.hpTick at its last turn end). dodgedTurn: u.turns when it last Dodged; -1.
   */
  dodgeRun: number;
  quietTurns: number;
  hpSeen: number;
  dodgedTurn: number;
  /** Fx id of the effect it's concentrating on; -1. */
  conc: number;
  /** st.turnIdx of the turn it last spent a spell slot on; -1. One slot per turn (p.105). */
  slotTurn: number;
  /** Per tpl.features: st.turnIdx of the turn a once-per-turn activation was last used (-1); null when it has none. */
  readonly featTurn: Int32Array | null;
  /**
   * M3 step 5a (RIDER, C1): per tpl.riders index r, at [r * (1 + units)] the st.turnIdx it was
   * last used (global, ownTurn), at [r * (1 + units) + 1 + t] the st.turnIdx it was last used on
   * unit t (perCreature); -1 never. null when its template has no riders (and left out of stateHash then).
   */
  readonly riderTurn: Int32Array | null;
  /** OR of the hook bits of the effects it bears, so most steps skip trigger collection. */
  hookMask: number;
  /** Spell slots L1..L9 at [0..8], then tpl pools in order. */
  readonly res: Int16Array;
  /** What each hand holds: a tpl.items index, HAND.empty or HAND.conjured. */
  readonly hands: Int16Array;
  /** Per tpl.items: the cell it was dropped on, or -1. */
  readonly dropped: Int16Array;
  /**
   * Step E (E2): a monster's thrown pieces on the ground. One slot per piece of its counted gear
   * that some attack throws (consumesGear), each the cell it landed on or -1; derived at unit
   * creation (no template field), empty for PCs and for monsters without such gear. Hashed only
   * while a piece is on the ground. landGear: each slot's tpl.gear index (constant, not hashed).
   */
  readonly landed: Int16Array;
  readonly landGear: Uint8Array;
  /** Live fx ids it bears, in creation order. */
  readonly borne: number[];
  /**
   * Cache of the stats (M3 step 4) of the live effects it bears, most potent copy only, in fx
   * order. Derived from borne, so left out of stateHash; only refreshStats (sim/effects.ts)
   * writes it. Empty for nearly every unit, so stat reads cost one length check.
   */
  stats: readonly BearerStat[];
}

/** One stat on a bearer: the compiled stat and the fx that carries it. */
export interface BearerStat {
  readonly s: CompiledStat;
  readonly fx: number;
}

export interface Outcome {
  readonly k: 'win' | 'loss' | 'stalemate';
  readonly round: number;
  /** Every party member dead. */
  readonly tpk: boolean;
}

export interface GameState {
  readonly setup: FightSetup;
  /** Per-fight counters for the reducers (sim/counters.ts); derived data, left out of stateHash. Set by createContext. */
  ctr: Counters;
  readonly seed: number;
  readonly run: number;
  round: number;
  /** Counts turns taken across the fight (1-based once the first turn starts). */
  turnIdx: number;
  orderPos: number;
  /** Unit whose turn it is, or -1 outside turns. */
  active: number;
  readonly order: Int16Array;
  readonly units: Unit[];
  /** Bodies per cell (for corpseSpace=difficult). */
  readonly corpses: Uint8Array;
  /** Next decision index (forced choices don't count). */
  decisionSeq: number;
  /** Next event seq. Advances whether or not anything is listening. */
  seq: number;
  /** Coverage 8'b G4: counts HP changes on either side (damage, temp HP soaking it, a heal, a revive, a death at HP above 0). Derived: stateHash has what it decides, not this. */
  hpTick: number;
  /** 1 for each flag a resolution site read; indexed like FLAG_KEYS. */
  readonly flagsUsed: Uint8Array;
  /** 1 for each flag a decider read while deciding (readFlag/oddsFlags; critique resolution 16). Left out of stateHash. */
  readonly aiFlags: Uint8Array;
  /** Above 0 while a decider is deciding (ask() brackets the call). */
  deciding: number;
  outcome: Outcome | null;
  /** Every effect created this fight, by id. */
  readonly fx: Fx[];
  /** How many of them are alive; 0 lets the d20 fold skip effects entirely. */
  liveFx: number;
  /** Per cell: a bit for each zone covering it (zone slot = Fx.zbit). */
  readonly zoneMask: Uint32Array;
  /** Fx id in each zone slot, -1 when free. */
  readonly zoneFx: Int32Array;
  /** Zone slots that are Difficult Terrain, deal per-distance damage, have enter/turn-end hooks, have enter hooks. */
  diffBits: number;
  travelBits: number;
  hookBits: number;
  enterBits: number;
  /** Coverage step 7.5: live zones around their owner (zone.from 'bearer'); 0 skips every aura path. Derived from fx, so not hashed. */
  ownerAuras: number;
  /** Coverage step 7.5: the slots of those zones that carry roll mods (foldMods). Derived from fx, so not hashed. */
  auraModBits: number;
  /** perDistanceDamageRolls=perMove: (zone, creature) pairs with increments not yet dealt, live zones or ended ones. Derived from Fx.acc. */
  accPending: number;
  /** Live pre-roll reactions anywhere; 0 skips the window. */
  watchD20: number;
  /** M3 step 5a: units with a hitTaken reaction; 0 skips the window. Fixed per setup, left out of stateHash. */
  readonly watchHit: number;
  /** M3 step 8'a: units with a hitKnown (AC after a hit) or damageTaken reaction; 0 skips those windows. Fixed per setup, left out of stateHash. */
  readonly watchHitKnown: number;
  readonly watchDamaged: number;
  /** Coverage step 9+: units with a declare-time reaction (Redirect Attack); 0 skips that window. Fixed per setup, left out of stateHash. */
  readonly watchDeclared: number;
}

/** What queries and deciders get: the same state, read-only. */
export type QueryState = Readonly<GameState>;

const NO_LANDED = new Int16Array(0);
const NO_LAND_GEAR = new Uint8Array(0);

/** Step E (E2): a monster's landing slots, one per piece of counted gear one of its attacks throws. */
function landSlots(tpl: CompiledTemplate, isPc: boolean): { landed: Int16Array; landGear: Uint8Array } {
  if (isPc) return { landed: NO_LANDED, landGear: NO_LAND_GEAR };
  const per: number[] = [];
  tpl.gear.forEach((g, gi) => {
    if (g.count > 0 && tpl.attacks.some((a) => a.consumesGear && a.gear === gi)) for (let k = 0; k < g.count; k++) per.push(gi);
  });
  if (per.length === 0) return { landed: NO_LANDED, landGear: NO_LAND_GEAR };
  return { landed: new Int16Array(per.length).fill(-1), landGear: Uint8Array.from(per) };
}

export function newBudget(attackCount: number): Budget {
  return { action: 0, bonus: 0, reaction: 1, moveFt: 0, diagParity: 0, atkActive: false, atkCounts: new Uint8Array(attackCount), atkLive: 0, freeObj: 0, movedFt: 0, speedAt: 0, dashes: 0, standFt: 0, lightMask: 0, atkEquip: 0, refused: 0, refusedFrom: -1, rolls: 0, freeFt: 0 };
}

/** Builds the starting state. Initiative and rolled HP are filled in by runFight. */
/** `layout` is per setup; callers running many fights pass a cached one. */
export function initState(setup: FightSetup, seed: number, run: number, layout: CounterLayout = buildCounterLayout(setup)): GameState {
  const units: Unit[] = setup.seats.map((s, idx) => {
    const isPc = s.tpl.kind === 'pc';
    const atZero = s.atZero ?? (isPc ? 'deathSaves' : setup.flags.statBlockAtZeroHp);
    const gear = new Int16Array(s.tpl.gear.length);
    s.tpl.gear.forEach((g, i) => (gear[i] = g.count));
    const u: Unit = {
      idx,
      seat: s.seat,
      seatKey: s.seatKey,
      team: s.team,
      tpl: s.tpl,
      isPc,
      atZero,
      cell: s.cell,
      hp: s.hp ?? s.tpl.hpMax,
      hpMax: s.tpl.hpMax,
      tempHp: 0,
      life: 'up',
      deathOk: 0,
      deathFail: 0,
      condMask: 0,
      conds: [],
      init: 0,
      initTie: 0,
      surprised: s.surprised,
      gear,
      b: newBudget(s.tpl.attacks.length),
      turns: 0,
      dodgeRun: 0,
      quietTurns: 0,
      hpSeen: 0,
      dodgedTurn: -1,
      conc: -1,
      slotTurn: -1,
      featTurn: s.tpl.features.some((f) => f.activate?.perTurn) ? new Int32Array(s.tpl.features.length).fill(-1) : null,
      riderTurn: s.tpl.riders ? new Int32Array(s.tpl.riders.length * (1 + setup.seats.length)).fill(-1) : null,
      hookMask: 0,
      res: Int16Array.from(s.res ?? s.tpl.resMax),
      hands: Int16Array.from(s.tpl.startHands),
      dropped: new Int16Array(s.tpl.items.length).fill(-1),
      ...landSlots(s.tpl, isPc),
      borne: [],
      stats: NO_STATS,
    };
    if (s.prone) addCond(u, COND.prone, 'core:prone', -1, -1, { k: 'never' });
    return u;
  });
  return {
    setup,
    ctr: newCounters(layout),
    seed,
    run,
    round: 0,
    turnIdx: 0,
    orderPos: 0,
    active: -1,
    order: new Int16Array(units.length),
    units,
    corpses: new Uint8Array(setup.w * setup.h),
    decisionSeq: 0,
    seq: 0,
    hpTick: 0,
    flagsUsed: new Uint8Array(FLAG_KEYS.length),
    aiFlags: new Uint8Array(FLAG_KEYS.length),
    deciding: 0,
    outcome: null,
    fx: [],
    liveFx: 0,
    zoneMask: new Uint32Array(setup.w * setup.h),
    zoneFx: new Int32Array(32).fill(-1),
    diffBits: 0,
    travelBits: 0,
    hookBits: 0,
    enterBits: 0,
    ownerAuras: 0,
    auraModBits: 0,
    accPending: 0,
    watchD20: units.filter((u) => u.tpl.features.some((f) => f.preRoll !== null)).length,
    watchHit: units.filter((u) => u.tpl.features.some((f) => f.hitTaken !== undefined)).length,
    watchHitKnown: units.filter((u) => u.tpl.features.some((f) => f.hitKnown !== undefined)).length,
    watchDamaged: units.filter((u) => u.tpl.features.some((f) => f.damageTaken !== undefined)).length,
    watchDeclared: units.filter((u) => u.tpl.features.some((f) => f.declared !== undefined)).length,
  };
}

/** Coverage 8'b G4: u's turn ends in a row with no HP change on either side, as of now (an HP change since its last turn end makes it 0). */
export function quietTurnsNow(st: QueryState, u: Unit): number {
  return st.hpTick === u.hpSeen ? u.quietTurns : 0;
}

/** Coverage 8'b G4: how many turns running u has Dodged with no HP change on either side. */
export function noProgressTurns(st: QueryState, u: Unit): number {
  const q = quietTurnsNow(st, u);
  return u.dodgeRun < q ? u.dodgeRun : q;
}

/** The closing of a stalemate, by cause (coverage.md "Frozen thresholds", M7, m10); the first that holds wins. */
export const STALEMATE_CAUSES = ['dodge-loop', 'downed-unrescued', 'no-damage', 'round-cap'] as const;
export type StalemateCause = (typeof STALEMATE_CAUSES)[number];
/** Frozen with coverage.md's table; tools/class-picks.ts THRESHOLDS keeps the same two (a test holds them equal). */
export const STALEMATE_DODGE_STREAK = 3;
export const STALEMATE_NO_DAMAGE_ROUNDS = 3;

/**
 * Why a fight that hit the round cap didn't end. dodge-loop: a PC still up whose last STALEMATE_DODGE_STREAK
 * turns were Dodges (a streak left on a dead or downed PC says nothing about the end of the fight). downed-unrescued: a party member lies at 0 HP, not stable (m10). no-damage:
 * no damage either way in the last STALEMATE_NO_DAMAGE_ROUNDS rounds. round-cap: damage was still landing.
 */
export function stalemateCauseOf(st: QueryState): StalemateCause | undefined {
  if (st.outcome?.k !== 'stalemate') return undefined;
  for (const u of st.units) if (u.isPc && u.life === 'up' && u.dodgeRun >= STALEMATE_DODGE_STREAK) return 'dodge-loop';
  for (const u of st.units) if (u.team === 0 && u.life === 'down') return 'downed-unrescued';
  const L = st.ctr.layout;
  const S = L.sources.length;
  const last = st.outcome.round;
  for (let r = Math.max(1, last - STALEMATE_NO_DAMAGE_ROUNDS + 1); r <= last; r++) {
    const row = Math.min(r, L.rounds - 1) * S;
    for (let k = 0; k < S; k++) if (st.ctr.dmgRolled[row + k]! > 0) return 'round-cap';
  }
  return 'no-damage';
}

type Wieldable = { readonly unarmed: boolean; readonly spell: boolean; readonly item?: number; readonly twoHands?: true; readonly throws?: true };

/**
 * A weapon attack needs a free hand (to draw and wield it). An Unarmed Strike and a spell
 * attack don't, and a creature with no item model (a stat block) is never limited.
 *
 * M3 step 5b, a held weapon (atk.item, a PcSource with heldWeapons): it must be in a hand, with
 * the other hand empty for a two-hands attack (Two-Handed, a Versatile two-handed grip, loading
 * Ammunition). Not in hand, it may be drawn into empty hands as part of the attack when `draw`
 * (an Attack action's strike: "If you equip a weapon before an attack", srd-raw.txt:32707-32711)
 * or when the attack throws it ("you can draw that weapon as part of the attack", 20387-20389).
 * A weapon lying somewhere after a throw or a drop can't, except that an Attack action's strike
 * may pick up one lying in the attacker's own square ("Equipping a weapon includes drawing it
 * from a sheath or picking it up", 32711; review INT-1); one on another square is out of reach.
 * Gear counts are gearOk's.
 */
export function canWield(u: Unit, atk: Wieldable, draw = false): boolean {
  if (atk.unarmed || atk.spell || u.tpl.items.length === 0) return true;
  const it = atk.item;
  if (it === undefined) return u.hands[0] === HAND.empty || u.hands[1] === HAND.empty;
  const h = u.hands[0] === it ? 0 : u.hands[1] === it ? 1 : -1;
  if (h >= 0) return !atk.twoHands || u.hands[1 - h] === HAND.empty;
  if (!(draw || atk.throws)) return false;
  if (u.dropped[it]! >= 0 && !(draw && u.dropped[it] === u.cell)) return false;
  const free = (u.hands[0] === HAND.empty ? 1 : 0) + (u.hands[1] === HAND.empty ? 1 : 0);
  return free >= (atk.twoHands ? 2 : 1);
}

/**
 * M3 step 5b, review R1: a counted stack of a Light Thrown weapon (four Daggers) is one item, but
 * each piece is a different weapon: attack `a` throws a piece other than the one in hand (or the
 * one just thrown), so it may make the Light extra attack after a strike with the same stack
 * ("must be made with a different Light weapon", srd-raw.txt:20344-20345; Thrown: "you can draw
 * that weapon as part of the attack", 20387-20389). Pieces left: the gear count, less the one in
 * hand. [U] The model throws the held piece (it leaves the hand) rather than drawing a second one.
 */
export function lightStackSpare(u: Unit, a: CompiledAttack): boolean {
  if (a.throws !== true || a.gear < 0 || a.item === undefined) return false;
  const held = u.hands[0] === a.item || u.hands[1] === a.item ? 1 : 0;
  return u.gear[a.gear]! - held >= 1;
}

/**
 * M3 step 5b: whether the Light property's extra attack is open for `u` (its own turn is the
 * gate's job): it attacked with a Light weapon in the Attack action this turn, and a Light weapon
 * other than that one can attack now ("That extra attack must be made with a different Light
 * weapon", srd-raw.txt:20344-20345). Two different Light weapons used already: either will do. A
 * counted Light stack supplies its own second weapon when it throws (lightStackSpare, review R1).
 */
export function lightExtraOpen(u: Unit, m = u.b.lightMask): boolean {
  // `m`: the Light mask to read in place of u.b.lightMask (perf: greedy's what-if without a unit copy; nothing else here reads u.b).
  if (m === 0) return false;
  const many = (m & (m - 1)) !== 0;
  const atks = u.tpl.attacks;
  for (let i = 0; i < atks.length; i++) {
    const a = atks[i]!;
    if (a.item === undefined || u.tpl.items[a.item]!.light !== true) continue;
    if (!many && (m & (1 << a.item)) !== 0 && !lightStackSpare(u, a)) continue;
    if (a.gear >= 0 && u.gear[a.gear]! === 0) continue;
    if (canWield(u, a)) return true;
  }
  return false;
}

export function has(u: Unit, bit: number): boolean {
  return (u.condMask & bit) !== 0;
}

/** Adds one instance of a condition. Conditions don't stack, but each source keeps its own instance. */
export function addCond(u: Unit, bit: number, via: Id, src: number, cause: number, until: Expiry): boolean {
  const had = has(u, bit);
  u.conds.push({ bit, via, src, cause, until });
  u.condMask |= bit;
  return !had;
}

/** Removes instances of a condition (all of them, or only those from `via`). Returns true if the condition ended. */
export function removeCond(u: Unit, bit: number, via?: Id): boolean {
  const had = has(u, bit);
  for (let i = u.conds.length - 1; i >= 0; i--) {
    const c = u.conds[i]!;
    if (c.bit === bit && (via === undefined || c.via === via)) u.conds.splice(i, 1);
  }
  refreshMask(u);
  return had && !has(u, bit);
}

/** Removes every instance anchored to this boundary of `unit`'s turn number `turns`; returns the bits that ended. */
export function expireConds(u: Unit, k: 'turnStart' | 'turnEnd', unit: number, turns: number): number {
  const before = u.condMask;
  for (let i = u.conds.length - 1; i >= 0; i--) {
    const e = u.conds[i]!.until;
    if (e.k === k && e.unit === unit && turns > e.after) u.conds.splice(i, 1);
  }
  refreshMask(u);
  return before & ~u.condMask;
}

/** Recomputes condMask from the condition instances (after removing some directly). */
export function refreshMask(u: Unit): void {
  let m = 0;
  for (const c of u.conds) m |= c.bit;
  u.condMask = m;
}

export function condId(bit: number): Id {
  for (const [b, id] of COND_IDS) if (b === bit) return id;
  throw new RangeError(`unknown condition bit ${bit}`);
}

/**
 * Pure flag read, for queries and resolution alike. A read while a decider is deciding is noted
 * in aiFlags, so reports can list the flags the AI's choices rested on; decide/ and query/ read
 * flags only through this and oddsFlags (lint).
 */
export function readFlag<K extends keyof RuleFlags>(st: QueryState, k: K): RuleFlags[K] {
  if (st.deciding > 0) st.aiFlags[flagIndex(k)] = 1;
  return st.setup.flags[k];
}

/** The flags object for an odds call (rollOdds, quickOdds), noting the flags those read when a decider asks. */
export function oddsFlags(st: QueryState): RuleFlags {
  if (st.deciding > 0) for (const k of ODDS_FLAGS) st.aiFlags[flagIndex(k)] = 1;
  return st.setup.flags;
}

/** Flag read at a resolution site: also records that the result depended on it. */
export function useFlag<K extends keyof RuleFlags>(st: GameState, k: K): RuleFlags[K] {
  st.flagsUsed[flagIndex(k)] = 1;
  return st.setup.flags[k];
}

export function markFlag(st: GameState, k: keyof RuleFlags): void {
  st.flagsUsed[flagIndex(k)] = 1;
}

export function flagsUsedKeys(used: Uint8Array): (keyof RuleFlags)[] {
  return FLAG_KEYS.filter((_, i) => used[i] === 1);
}

/** flagsUsed as hashed: its LEGACY_FLAG_COUNT prefix while no later flag was read (M3 step 8: old hashes hold). */
function legacyFlags(used: Uint8Array): Uint8Array {
  for (let i = LEGACY_FLAG_COUNT; i < used.length; i++) if (used[i] !== 0) return trimLateFlags(used);
  return used.subarray(0, LEGACY_FLAG_COUNT);
}

function anyLanded(u: Unit): boolean {
  for (let i = 0; i < u.landed.length; i++) if (u.landed[i]! >= 0) return true;
  return false;
}

/** Everything a fight can change, canonical; equal states hash equal. */
export function stateHash(st: QueryState): string {
  return hash64(
    canonicalJson({
      round: st.round,
      turnIdx: st.turnIdx,
      seq: st.seq,
      decisionSeq: st.decisionSeq,
      outcome: st.outcome,
      corpses: st.corpses,
      flagsUsed: legacyFlags(st.flagsUsed),
      units: st.units.map((u) => ({
        cell: u.cell, hp: u.hp, hpMax: u.hpMax, tempHp: u.tempHp, life: u.life, ok: u.deathOk, fail: u.deathFail,
        cond: u.condMask, init: u.init, gear: u.gear,
        b: { a: u.b.action, bo: u.b.bonus, r: u.b.reaction, m: u.b.moveFt, p: u.b.diagParity, aa: u.b.atkActive, ac: u.b.atkCounts, al: u.b.atkLive, fo: u.b.freeObj },
        np: u.dodgeRun > 0 && u.quietTurns > 0 && st.hpTick === u.hpSeen ? Math.min(u.dodgeRun, u.quietTurns) : undefined, // M7: greedy reads it (noProgressTurns); only a live streak shows, so other hashes hold. Written out on purpose: `noProgressTurns(st, u) || undefined` here hashed `np:0` under load on Node 26.9.0, a value that expression can't produce: a V8 Maglev miscompile seen at this expression (gone under --no-maglev; repro and tier counts in coverage.md's 8'b review; not reduced).
        t: u.turns, cc: u.conc, sl: u.slotTurn, res: u.res, hd: u.hands, dr: u.dropped, bn: u.borne,
        ft: u.featTurn ?? undefined, // only a creature with a once-per-turn activation (left out otherwise, so old hashes hold)
        rt: u.riderTurn ?? undefined, // only a creature with riders (M3 step 5a, C3)
        ld: anyLanded(u) ? u.landed : undefined, // step E: only while a thrown piece is on the ground, so other hashes hold
      })),
      fx: st.fx.map((f) => ({ t: f.tpl, o: f.owner, b: f.bearer, p: f.parent, l: f.lvl, pa: f.param, a: f.alive, z: f.zbit, an: f.anchor, am: f.aim ?? undefined, h: f.hand, u: f.until, hit: f.hit, acc: f.acc, sn: f.seen, hd: f.hdc >= 0 ? f.hdc : undefined })), // hd: only a hidden zone (coverage step 9), so other hashes hold
      zm: st.zoneMask,
    }),
  );
}

/** Coverage step 7.3: whether a zone with this `affects` leaves `u` alone. `allies` counts its owner: "You and your allies". */
export function zoneSpares(affects: ZoneAffects, owner: Unit, u: Unit): boolean {
  if (affects === 'notOwner') return u === owner;
  return affects === 'foes' ? u.team === owner.team : u.team !== owner.team;
}
