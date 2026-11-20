// The fight context: state plus everything a fight uses but isn't state (dice counters,
// pooled scratch, deciders, the optional event sink), and the two primitives every module
// shares: emitting an event and asking a decider.

import type { Defenses } from './stats.ts';
import { cellName } from '../grid/cells.ts';
import { distFt as gridDist, newReachScratch, type ReachScratch } from '../grid/reach.ts';
import type { AttackSpecView, Decider, DecisionKind, DecisionPoint, Legal, LegalList, Queries, UnitView } from '../decide/decider.ts';
import { IllegalDecision } from '../decide/decider.ts';
import type { EventSink, GameEvent } from '../log/events.ts';
import { rollOdds, type RollOdds, type RollSpec } from '../rolls/rollspec.ts';
import type { RuleFlags } from '../rules/flags.ts';
import { closeRoll, drawDie, openRoll, type DiceState } from './dice.ts';
import { boundOf, newModFold, resetFold, type ModFold } from './effects.ts';
import { ITEM_ACTS } from './hands.ts';
import { newQueryScratch } from '../query/scratch.ts';
import type { CounterLayout } from './counters.ts';
import { noProgressTurns, oddsFlags, quietTurnsNow, type GameState, type QueryState, type Unit } from './state.ts';
import { HANDLER, TRIG_NAMES, type TriggerQueue } from './triggers.ts';

export interface Scratch {
  /**
   * Legal lists as a stack: decision windows nest (a turn's cast asks for a target, whose
   * attack opens a reaction window), so each window takes the next list and releases it.
   */
  readonly lists: LegalList[];
  depth: number;
  /** Copy of the chosen turn-level option; nested windows reuse the pools. */
  readonly chosen: Legal;
  /** Counter layout for the setup this scratch last served (rebuilt when the setup changes). */
  ctrLayout: CounterLayout | null;
  readonly reachEngine: ReachScratch;
  readonly reachQuery: ReachScratch;
  readonly rolled: Int32Array;
  readonly adv: string[][];
  readonly dis: string[][];
  readonly reactors: number[];
  /** Strike counts while testing whether one more attack fits (never the unit's own). */
  readonly counts: Uint8Array;
  /** Roll-modifier scratch as a stack: a save can roll inside an attack's resolution. */
  readonly folds: RollFold[];
  /** Damage taken per type in the instance being applied. */
  readonly byType: Int32Array;
  /** A second damage buffer (per-move flushes draw a step's dice several times). */
  readonly rolledExtra: Int32Array;
  /** A target's damage-type masks with its stats (M3 step 4), for the instance being applied. */
  readonly defenses: Defenses;
  foldTop: number;
}

/** Advantage and Disadvantage sources plus everything else effects add, for one d20 test being built. */
export interface RollFold {
  readonly adv: string[];
  readonly dis: string[];
  readonly f: ModFold;
}

export function newLegal(): Legal {
  return { k: 'pass', atk: -1, target: -1, cell: -1, ft: -1, provokes: -1, parity: -1, opt: -1, lvl: -1, aux: -1, fx: -1, hazard: -1 };
}

/** `reachCache: false` turns the pathfinding cache off (tests compare both ways). */
export function newScratch(cells: number, opts: { reachCache?: boolean } = {}): Scratch {
  const cache = opts.reachCache ?? true;
  return {
    lists: [],
    depth: 0,
    chosen: newLegal(),
    ctrLayout: null,
    reachEngine: newReachScratch(cells, cache),
    reachQuery: newReachScratch(cells, cache),
    rolled: new Int32Array(32),
    adv: [[], []],
    dis: [[], []],
    reactors: [],
    counts: new Uint8Array(64),
    folds: [],
    foldTop: 0,
    byType: new Int32Array(16),
    rolledExtra: new Int32Array(32),
    defenses: { resist: 0, vuln: 0, immune: 0 },
  };
}

export interface Ctx {
  readonly st: GameState;
  readonly dice: DiceState;
  readonly sc: Scratch;
  readonly deciders: readonly Decider[];
  readonly sink: EventSink | null;
  readonly views: readonly UnitView[];
  /** Flags for death saves: their own 1/20 rule, never natOnChecksAndSaves. */
  readonly deathFlags: RuleFlags;
  /** seq of the most recent 'decided' event, or of the window's cause for a forced choice. */
  lastDecided: number;
  /** Triggers raised by atomic steps, waiting to resolve. */
  readonly q: TriggerQueue;
  /** Set while a precast resolves (sim/precast.ts): it answers the precast's decisions and says who saw its zones appear. */
  pre: PrecastCtx | null;
}

export interface PrecastCtx {
  /** The index the scenario chose among `n` items (keys from keyOf); throws when it chose none of them. */
  answer(k: DecisionKind, n: number, keyOf: (i: number) => string): number;
  /** Per unit: 1 if it saw the cast. */
  readonly seen: Uint8Array;
}

/** Reserves the next event seq. Call it whether or not a sink is attached. */
export function nextSeq(cx: Ctx): number {
  return cx.st.seq++;
}

/** Emits a built event. Callers build the object only inside `if (cx.sink)`. */
export function emit(cx: Ctx, e: GameEvent): void {
  cx.sink!.emit(e);
}

export function evBase(cx: Ctx, seq: number, cause: number): { seq: number; round: number; turnOf: number; cause: number } {
  return { seq, round: cx.st.round, turnOf: cx.st.active, cause };
}

export function resetList(list: LegalList): void {
  list.n = 0;
}

/** Takes the next legal list off the stack, empty. Release it (in LIFO order) when the window closes. */
export function takeList(cx: Ctx): LegalList {
  const sc = cx.sc;
  let list = sc.lists[sc.depth];
  if (!list) {
    list = { n: 0, items: [] };
    sc.lists.push(list);
  }
  sc.depth++;
  list.n = 0;
  return list;
}

export function takeFold(cx: Ctx): RollFold {
  const sc = cx.sc;
  let fd = sc.folds[sc.foldTop];
  if (!fd) {
    fd = { adv: [], dis: [], f: newModFold() };
    sc.folds.push(fd);
  }
  sc.foldTop++;
  fd.adv.length = 0;
  fd.dis.length = 0;
  resetFold(fd.f);
  return fd;
}

export function releaseFold(cx: Ctx, fd: RollFold): void {
  const sc = cx.sc;
  if (sc.foldTop === 0 || sc.folds[sc.foldTop - 1] !== fd) throw new Error('roll folds released out of order');
  sc.foldTop--;
}

export function releaseList(cx: Ctx, list: LegalList): void {
  const sc = cx.sc;
  if (sc.depth === 0 || sc.lists[sc.depth - 1] !== list) throw new Error('legal lists released out of order');
  sc.depth--;
}

/** Appends a pooled item to `list` and returns it with every field reset. */
export function pushLegal(list: LegalList, k: Legal['k']): Legal {
  let l = list.items[list.n];
  if (!l) {
    l = newLegal();
    list.items.push(l);
  }
  list.n++;
  l.k = k;
  l.atk = l.target = l.cell = l.ft = l.provokes = l.parity = l.opt = l.lvl = l.aux = l.fx = l.hazard = -1;
  return l;
}

export function copyLegal(from: Legal, to: Legal): Legal {
  to.k = from.k;
  to.atk = from.atk;
  to.target = from.target;
  to.cell = from.cell;
  to.ft = from.ft;
  to.provokes = from.provokes;
  to.parity = from.parity;
  to.opt = from.opt;
  to.lvl = from.lvl;
  to.aux = from.aux;
  to.fx = from.fx;
  to.hazard = from.hazard;
  return to;
}

/** '#<fx id>' when the owner has another live copy of the same effect (ids are creation order, so stable on replay). */
function twin(st: QueryState, id: number): string {
  const f = st.fx[id]!;
  for (const o of st.fx) if (o !== f && o.alive && o.owner === f.owner && o.tpl === f.tpl) return `#${id}`;
  return '';
}

/**
 * '#id' when another live copy of the same effect from the same owner sits on the same bearer
 * (M3 step 4: one feature's condition imposed twice on one creature, both with a turn-end save),
 * so their trigger-order keys differ. Empty otherwise, so every older key is unchanged.
 */
function bearerTwin(st: QueryState, id: number): string {
  const f = st.fx[id]!;
  if (f.bearer < 0) return '';
  for (const o of st.fx) if (o !== f && o.alive && o.owner === f.owner && o.tpl === f.tpl && o.bearer === f.bearer) return `#${id}`;
  return '';
}

/** The journal key for a legal item. Stable across harmless list changes. */
export function legalKey(st: QueryState, who: number, l: Legal): string {
  const u = st.units[who]!;
  switch (l.k) {
    case 'pass':
      return 'pass';
    case 'attack':
      return `attack:${u.tpl.attacks[l.atk]!.local}>${st.units[l.target]!.seat}`;
    case 'move': {
      let key = `move:${cellName(l.cell, st.setup.w)}/p${l.provokes}`;
      if (st.setup.flags.diagonalCost === 'alternate') key += `/d${l.parity}`;
      return l.hazard > 0 ? `${key}/h${l.hazard}` : key;
    }
    case 'option':
      return `opt:${u.tpl.options[l.opt]!.local}`;
    case 'stand':
      return 'stand';
    case 'oa':
      return `oa:${u.tpl.attacks[l.atk]!.local}`;
    case 'order': {
      if (l.aux < 0) return `order:${st.units[l.target]!.seat}`; // opportunity attackers (M1a)
      const subject = st.units[l.target]!.seat;
      if (l.aux === HANDLER.conc) return `order:concentration@${subject}`;
      const fx = st.fx[l.fx]!;
      const te = boundOf(st, fx);
      const on = l.cell >= 0 ? `:${TRIG_NAMES[l.cell]}` : '';
      return `order:${st.units[fx.owner]!.seat}/${te.local}${l.lvl > 0 ? `#${l.lvl}` : ''}@${subject}${on}${bearerTwin(st, fx.id)}`;
    }
    case 'target':
      return `target:${st.units[l.target]!.seat}`;
    case 'place':
      return `place:${cellName(l.cell, st.setup.w)}`;
    case 'pull':
      return l.cell < 0 ? 'pull:-' : `pull:${cellName(l.cell, st.setup.w)}`;
    case 'cast': {
      const e = u.tpl.spells[l.opt]!;
      const dup = u.tpl.spells.some((o) => o !== e && o.spell.id === e.spell.id);
      return `cast:${e.spell.local}@${l.lvl}${l.aux === 1 ? '/free' : ''}${dup ? `#${e.source}` : ''}`;
    }
    case 'use': {
      if (l.fx < 0) {
        // A feature with several activations (M3 step 5a) names the one: use:<feature>/<activation>.
        const f = u.tpl.features[l.opt]!;
        if (!f.more) return `use:${f.local}`;
        const a = l.aux <= 0 ? f.activate! : f.more[l.aux - 1]!;
        return `use:${f.local}/${a.local}`;
      }
      const fx = st.fx[l.fx]!;
      const te = boundOf(st, fx);
      return `use:${st.units[fx.owner]!.seat}/${te.local}/${te.grants[l.opt]!.local}${twin(st, fx.id)}`;
    }
    case 'end': {
      const te = boundOf(st, st.fx[l.fx]!);
      return `end:${te.conc ? te.id.slice(te.id.indexOf(':') + 1, te.id.lastIndexOf('/')) : te.local}${twin(st, l.fx)}`;
    }
    case 'item':
      return `item:${ITEM_ACTS[l.aux]}/${u.tpl.items[l.opt]!.local}`;
    case 'dodge':
      return 'dodge';
    case 'search':
      return 'search';
    case 'pick':
    case 'react':
      throw new Error(`a ${l.k} list is asked with its own keys`);
  }
}

/**
 * Asks `who` to choose from `list`. A list with one item is forced: never asked, never
 * journaled, and the decision counter doesn't move.
 */
export function ask(cx: Ctx, who: number, k: DecisionKind, list: LegalList, cause: number, keyFn?: (l: Legal) => string, indexOfKey?: (key: string) => number, about?: Pick<DecisionPoint, 'roll' | 'roller' | 'rollTarget' | 'rollVia' | 'src' | 'hit'>): number {
  if (list.n === 0) throw new Error(`empty ${k} list for ${cx.st.units[who]!.seat}`);
  if (cx.pre) return cx.pre.answer(k, list.n, keyFn ? (i) => keyFn(list.items[i]!) : (i) => legalKey(cx.st, who, list.items[i]!));
  if (list.n === 1) {
    cx.lastDecided = cause;
    return 0;
  }
  const st = cx.st;
  const at = st.decisionSeq++;
  const keyOf = keyFn ? (i: number) => keyFn(list.items[i]!) : (i: number) => legalKey(st, who, list.items[i]!);
  const dp: DecisionPoint = { k, who, at, round: st.round, cause, legal: list, keyOf, ...(indexOfKey ? { indexOfKey } : {}), ...about };
  if (cx.dice.audit) assertUniqueKeys(dp, st.units[who]!.seat);
  const decider = cx.deciders[who]!;
  let i: number;
  st.deciding++;
  try {
    i = decider.decide(cx.views[who]!, dp);
  } finally {
    st.deciding--;
  }
  if (!Number.isInteger(i) || i < 0 || i >= list.n) {
    throw new IllegalDecision(`${decider.name} answered ${String(i)} for ${st.units[who]!.seat}'s ${k} decision @${at} (${list.n} options)`);
  }
  const seq = nextSeq(cx);
  if (cx.sink) emit(cx, { ...evBase(cx, seq, cause), k: 'decided', who, at, dk: k, key: dp.keyOf(i), by: decider.lastBy ?? decider.name });
  cx.lastDecided = seq;
  return i;
}

/** Tests and goldens: a journal key must name exactly one item, or replay could pick the wrong one. */
function assertUniqueKeys(dp: DecisionPoint, seat: string): void {
  const keys: string[] = [];
  for (let i = 0; i < dp.legal.n; i++) keys.push(dp.keyOf(i));
  keys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (let i = 1; i < keys.length; i++) if (keys[i] === keys[i - 1]) throw new Error(`two legal items share the key ${keys[i]} (${seat}'s ${dp.k} decision @${dp.at})`);
}

/** Builds the per-unit views deciders see. Queries use their own scratch, never the engine's. */
export function buildViews(
  st: GameState,
  dice: DiceState,
  sc: Scratch,
  spec: (st: QueryState, a: Unit, atk: number, t: Unit, fromCell: number, adv: string[], dis: string[], f: ModFold | null) => RollSpec,
): UnitView[] {
  // Queries fold effect modifiers (flat bonuses, preDice, floors) exactly as the engine's roll does.
  const qf = newModFold();
  const scratch = newQueryScratch(sc.reachQuery);
  const queries: Queries = {
    distFt: (a: number, b: number) => gridDist(st, a, b),
    attackSpec: (a: number, atk: number, t: number, fromCell: number): AttackSpecView => {
      const adv: string[] = [];
      const dis: string[] = [];
      const s = spec(st, st.units[a]!, atk, st.units[t]!, fromCell, adv, dis, newModFold());
      return { spec: s, adv, dis };
    },
    odds: (a: number, atk: number, t: number, fromCell: number): RollOdds => {
      const adv = sc.adv[1]!;
      const dis = sc.dis[1]!;
      return rollOdds(spec(st, st.units[a]!, atk, st.units[t]!, fromCell, adv, dis, qf), oddsFlags(st));
    },
    dodgeRun: (u: number) => st.units[u]!.dodgeRun,
    quietTurns: (u: number) => quietTurnsNow(st, st.units[u]!),
    noProgress: (u: number) => noProgressTurns(st, st.units[u]!),
  };
  return st.units.map((u) => ({
    me: u.idx,
    q: st,
    queries,
    scratch,
    ai: {
      roll: (sides: number) => {
        const s = openRoll(st, dice, u.idx, 'ai');
        const v = drawDie(s, sides);
        closeRoll(dice, s);
        return v;
      },
    },
  }));
}
