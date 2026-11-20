// Deciders: every seat (AI, human through a journal, later an LLM) answers a DecisionPoint
// by returning an index into its legal list. decide() is synchronous, always. No driver can
// make an illegal move: the engine builds the list and rejects any other answer.

import type { RollOdds, RollSpec } from '../rolls/rollspec.ts';
import type { QueryScratch } from '../query/scratch.ts';
import type { QueryState } from '../sim/state.ts';

export type LegalKind =
  | 'pass' | 'attack' | 'move' | 'option' | 'stand' | 'oa' | 'order'
  // M1b: cast a spell, use a granted or feature option, end an effect, handle an item, and the
  // choices inside a resolution (a target, an area anchor, a named option, a pull step, a reaction)
  | 'cast' | 'use' | 'end' | 'item' | 'target' | 'place' | 'pick' | 'pull' | 'react'
  // M3 step 5a: the core Dodge action (offered last in a turn's list, key 'dodge')
  | 'dodge'
  // Coverage step 9: the core Search action, for a hidden zone (after dodge, key 'search')
  | 'search';

/**
 * One choice. Pooled: one shape for every kind, unused fields -1. Don't keep a reference
 * after decide() returns; the engine reuses these objects.
 */
export interface Legal {
  k: LegalKind;
  atk: number; // attack index (attack, oa)
  target: number; // unit idx (attack, oa target, order: the reactor)
  cell: number; // move destination
  ft: number; // move cost
  provokes: number; // move: hostile reaches the route leaves (upper bound on opportunity attacks)
  parity: number; // move: diagonal parity at the end (alternate diagonals only)
  opt: number; // option index (option), spell entry (cast), grant or feature (use), item (item), choice (pick, react)
  lvl: number; // cast: slot level, 0 for a cantrip
  aux: number; // cast: 1 = a free (slotless) cast; item: the ITEM action; react: the sign (+1/-1)
  fx: number; // use, end: the effect id
  hazard: number; // move: known zone hazards the route crosses, capped (0..7)
}

export interface LegalList {
  n: number;
  readonly items: Legal[];
}

export type DecisionKind = 'turn' | 'reaction' | 'orderTriggers' | 'target' | 'place' | 'pick' | 'pull' | 'preRoll'
  // M3 step 5a: whether to use a rider on a hit, miss or damage (RIDER), and a damage-reducing reaction to a hit (REACT hitTaken)
  | 'rider' | 'hitTaken'
  // M3 step 8'a: an AC-raising reaction once a hit is known (hitKnown), a reaction after taking damage (damageTaken)
  | 'hitKnown' | 'damageTaken'
  // Coverage step 9+: a reaction when an attack roll is declared against the bearer, before the roll (Redirect Attack)
  | 'attackDeclared'
  // W1 (docs/design/w1-plan.md P7): at the bearer's first attack roll on its turn, before the roll, whether to use a
  //   firstAttack feature (Reckless Attack). Items: pass first, then one per feature: k 'pick', opt = tpl.features index,
  //   key 'first:<feature local>' (src.via the attack's id, src.target the creature attacked).
  // W1 (P9): where a move step's free move goes (Tactical Shift, Withdraw). Items: pass first, then one per reachable
  //   cell within the free budget: k 'move', cell, ft, key 'moveTo:<cell name>' (src.via the feature).
  // Both list pass first, so a decider that answers 0 by default declines (baseline, random-legal, a journal that doesn't name it).
  | 'firstAttack' | 'moveTo';

export interface DecisionPoint {
  readonly k: DecisionKind;
  readonly who: number;
  /** Decision index in this fight; forced choices (one option) aren't asked and don't count. */
  readonly at: number;
  readonly round: number;
  /** seq of the event that opened the window. */
  readonly cause: number;
  readonly legal: LegalList;
  /** Stable key for legal item i: what journals record ('move:F3/p1', 'attack:scimitar>pc1', 'oa:spear', 'pass'). */
  keyOf(i: number): string;
  /** Index of the item with this key, or -1; place lists (thousands of anchors) answer by binary search. */
  indexOfKey?(key: string): number;
  /** preRoll: the roll about to be made, who makes it, against whom (-1) and from what. */
  readonly roll?: Readonly<RollSpec>;
  readonly roller?: number;
  readonly rollTarget?: number;
  readonly rollVia?: string;
  /** target, place, pick, pull: what's asking (a spell id, or an effect template id for zones and grants), so a decider can find the program; pull: also the creature being moved. lvl: the level of the cast this comes from, carried here so a decider that didn't choose the cast (a journal handing back mid-cast, a policy's script) values the same program. */
  readonly src?: { readonly via: string; readonly target?: number; readonly lvl?: number };
  /**
   * M3 step 5a. rider: the attack it rides on (src.via is the feature, src.target the creature
   * attacked). hitTaken: the hit being reacted to, with its rolled damage before any reduction
   * (src.via is the attack, src.target the attacker). Items: pick (rider: opt = option, aux =
   * tpl.riders index) or react (hitTaken: opt = tpl.features index), after a pass.
   * M3 step 8'a. hitKnown: the hit (total is the attack roll's total, types 0; src.via the attack,
   * src.target the attacker); items pass, then react (opt = tpl.features index) per usable feature.
   * damageTaken: src.via the damage's source id, src.target the creature that dealt it; hit.total
   * the damage taken; items pass, then react (opt = tpl.features index).
   * Coverage step 9+. attackDeclared: roller the attacker, rollTarget the bearer (the creature
   * attacked), rollVia the attack's id, src.target the attacker; items pass, then react (opt =
   * tpl.features index, target = the ally it would swap with) per eligible ally.
   */
  readonly hit?: { readonly attacker: number; readonly target: number; readonly via: string; readonly crit: boolean; readonly total: number; readonly types: number };
}

/** Draws only from this seat's 'ai' purpose, so AI dice never move game dice. */
export interface AiDice {
  roll(sides: number): number;
}

export interface AttackSpecView {
  readonly spec: RollSpec;
  readonly adv: readonly string[];
  readonly dis: readonly string[];
}

/** Pure queries a decider may call any number of times without changing the fight. */
export interface Queries {
  /** Feet between two cells under the active diagonal rule. */
  distFt(cellA: number, cellB: number): number;
  /** Exact odds for unit `a` attacking `t` with attack index `atk` from `fromCell`. */
  odds(a: number, atk: number, t: number, fromCell: number): RollOdds;
  attackSpec(a: number, atk: number, t: number, fromCell: number): AttackSpecView;
  /** Coverage 8'b G4, M7: unit `u`'s consecutive Dodges (dodgeRun), its turns since an HP change on either side (quietTurnsNow), and the two together (noProgressTurns). */
  dodgeRun(u: number): number;
  quietTurns(u: number): number;
  noProgress(u: number): number;
}

export interface UnitView {
  readonly me: number;
  readonly q: QueryState;
  readonly queries: Queries;
  /** Scratch for the query functions in query/ (separate from the fight's own). */
  readonly scratch: QueryScratch;
  readonly ai: AiDice;
}

export interface Decider {
  readonly name: string;
  decide(view: UnitView, dp: DecisionPoint): number;
  /** Who actually answered the last decide() (a journal that ran out names its fallback). */
  readonly lastBy?: string;
  /** Deciders that can explain themselves (the greedy AI) send a record per turn decision here; null stops it. */
  explainTo?(sink: ((r: unknown) => void) | null): void;
}

/** A journal ran out (or a seat has no answer): the caller appends one and reruns from the seed. */
export class NeedInput extends Error {
  readonly seat: string;
  readonly kind: DecisionKind;
  readonly at: number;
  readonly keys: readonly string[];
  constructor(seat: string, kind: DecisionKind, at: number, keys: readonly string[]) {
    super(`needs input: ${seat} ${kind} @${at} (legal: ${keys.join(', ')})`);
    this.seat = seat;
    this.kind = kind;
    this.at = at;
    this.keys = keys;
  }
}

/** A journal entry doesn't match the decision the engine is asking. */
export class JournalMismatch extends Error {}

/** A decider returned something other than an index into the legal list. */
export class IllegalDecision extends Error {}

/** A turn asked for more decisions than any legal turn needs: a decider is looping. */
export class RunawayTurn extends Error {}
