// Effects: creating them, ending them along with everything that hangs off them, expiring them
// at turn boundaries (a dead creature's included), the once-per-turn ledger, same-spell potency
// (SRD 5.2.1 p.106), and folding their roll modifiers into a d20 test.
//
// An Fx is plain data in st.fx; what it does lives in its owner's compiled template
// (tpl.effects[fx.tpl]). Ending is a cascade: an effect's children end with it, in creation
// order, and so do conditions it imposed (CondInstance until {effect}).

import type { ExprNode } from '../dice/expr.ts';
import { keyMatches, RK } from '../content/rollkeys.ts';
import { END, type BoundEffect, type Id } from '../content/types.ts';
import type { ConcEndWhy, FxEndWhy } from '../log/events.ts';
import { emit, evBase, nextSeq, type Ctx } from './context.ts';
import { countConcEnd } from './counters.ts';
import { COND, condId, expireConds, HAND, has, NO_STATS, refreshMask, useFlag, zoneSpares, type BearerStat, type Expiry, type Fx, type GameState, type QueryState, type Unit } from './state.ts';
import { gatesOk, noConcentration } from './stats.ts';

export interface NewFx {
  /** Index into units[owner].tpl.effects. */
  readonly tpl: number;
  readonly owner: number;
  readonly bearer: number;
  readonly parent: number;
  readonly param: number;
  readonly srcItem: number;
  readonly until: Expiry;
  readonly cause: number;
  /** Don't log fxStart: the caller logs its own event (a zone appearing). */
  readonly quiet?: boolean;
}

export function boundOf(st: QueryState, fx: Fx): BoundEffect {
  return st.units[fx.owner]!.tpl.effects[fx.tpl]!;
}

/** Creates an effect, links it under its parent and onto its bearer, and logs it. */
export function newFx(cx: Ctx, a: NewFx): Fx {
  const st = cx.st;
  const owner = st.units[a.owner]!;
  const te = owner.tpl.effects[a.tpl]!;
  const n = st.units.length;
  const fx: Fx = {
    id: st.fx.length,
    tpl: a.tpl,
    owner: a.owner,
    bearer: a.bearer,
    parent: a.parent,
    sid: te.sid,
    lvl: te.lvl,
    param: a.param,
    srcItem: a.srcItem,
    born: owner.turns,
    until: a.until,
    cause: a.cause,
    alive: true,
    firstChild: -1,
    lastChild: -1,
    nextSib: -1,
    zbit: -1,
    anchor: -1,
    aim: undefined,
    hand: -1,
    hit: te.limit !== 'none' ? new Int32Array(n).fill(-1) : null,
    acc: te.zone ? new Uint8Array(n) : null,
    seen: te.zone ? new Uint8Array(n) : null,
    // Coverage step 9: the Search DC is bound into the zone here, when it's cast; later changes to its caster don't move it.
    hdc: te.zone && te.hiddenDc !== undefined ? te.hiddenDc : -1,
  };
  st.fx.push(fx);
  st.liveFx++;
  if (a.parent >= 0) {
    const p = st.fx[a.parent]!;
    if (p.lastChild >= 0) st.fx[p.lastChild]!.nextSib = fx.id;
    else p.firstChild = fx.id;
    p.lastChild = fx.id;
  }
  if (a.bearer >= 0) {
    const b = st.units[a.bearer]!;
    b.borne.push(fx.id);
    b.hookMask |= te.hookMask;
    if (te.stats) refreshStats(st, b);
  }
  let seq = a.cause;
  if (!a.quiet) {
    seq = nextSeq(cx);
    if (cx.sink) emit(cx, { ...evBase(cx, seq, a.cause), k: 'fxStart', fx: fx.id, via: te.id, name: te.name, owner: a.owner, bearer: a.bearer, parent: a.parent, conc: te.conc });
  }
  // W1 (P2): "You can't maintain Concentration" (Rage, srd-raw.txt:4980): a bearer that now holds a
  // noConcentration stat loses the concentration it had, after the effect's own line. Checked only
  // for an effect that carries stats, so nothing else pays for it.
  if (te.stats && a.bearer >= 0) {
    const b = st.units[a.bearer]!;
    if (b.conc >= 0 && b.conc !== fx.id && noConcentration(st, b)) endConcentration(cx, b, 'concentration', seq);
  }
  return fx;
}

/** Ends an effect, then its conditions, then its children in creation order. Ending a dead one does nothing. */
export function endFx(cx: Ctx, id: number, why: FxEndWhy, cause: number): void {
  const st = cx.st;
  const fx = st.fx[id]!;
  if (!fx.alive) return;
  fx.alive = false;
  st.liveFx--;
  const owner = st.units[fx.owner]!;
  const te = owner.tpl.effects[fx.tpl]!;
  if (fx.zbit >= 0) clearZone(st, fx);
  if (fx.bearer >= 0) {
    const b = st.units[fx.bearer]!;
    const i = b.borne.indexOf(id);
    if (i >= 0) b.borne.splice(i, 1);
    let mask = 0;
    for (const j of b.borne) mask |= boundOf(st, st.fx[j]!).hookMask;
    b.hookMask = mask;
    if (te.stats) refreshStats(st, b);
  }
  if (owner.conc === id) {
    owner.conc = -1;
    // A concentration instance never ends with a condition-only why (COND_END_WHYS).
    countConcEnd(st.ctr, owner.idx, why as ConcEndWhy);
  }
  if (fx.hand >= 0) {
    owner.hands[fx.hand] = HAND.empty;
    fx.hand = -1;
  }
  const seq = nextSeq(cx);
  if (cx.sink) emit(cx, { ...evBase(cx, seq, cause), k: 'fxEnd', fx: id, via: te.id, name: te.name, owner: fx.owner, bearer: fx.bearer, why });
  for (const u of st.units) {
    const before = u.condMask;
    for (let i = u.conds.length - 1; i >= 0; i--) {
      const e = u.conds[i]!.until;
      if (e.k === 'effect' && e.effect === id) u.conds.splice(i, 1);
    }
    refreshMask(u);
    condOffEvents(cx, u, before & ~u.condMask, te.id, seq);
  }
  for (let c = fx.firstChild; c >= 0; c = st.fx[c]!.nextSib) endFx(cx, c, 'parent', seq);
}

/**
 * Rebuilds u.stats (M3 step 4) from the live effects it bears, in fx order. Of two copies of
 * one spell's effect only the more potent counts (p.106). The only writer of u.stats.
 */
export function refreshStats(st: QueryState, u: Unit): void {
  let out: BearerStat[] | null = null;
  for (const id of u.borne) {
    const fx = st.fx[id]!;
    if (!fx.alive) continue;
    const ss = boundOf(st, fx).stats;
    if (!ss || outrankedIn(st, u.borne, fx)) continue;
    out ??= [];
    for (const s of ss) out.push({ s, fx: id });
  }
  u.stats = out ?? NO_STATS;
}

/**
 * The bearer took damage: effects that end on damage (a condition's endsOnDamage) end, in
 * fx order. `took` is the damage dealt before Temporary Hit Points [U: damage soaked entirely
 * by Temporary Hit Points counts as taking damage].
 */
export function endOnDamage(cx: Ctx, u: Unit, cause: number): void {
  const st = cx.st;
  for (let i = 0; i < u.borne.length; i++) {
    const id = u.borne[i]!;
    const fx = st.fx[id]!;
    if (!fx.alive || !boundOf(st, fx).endsOnDamage) continue;
    endFx(cx, id, 'damaged', cause);
    i = -1; // borne changed under us: rescan (ended effects are gone from it)
  }
}

/** Takes a zone off the grid: clears its bit everywhere and frees its slot. */
function clearZone(st: GameState, fx: Fx): void {
  const bit = 1 << fx.zbit;
  if (boundOf(st, fx).zone!.from === 'bearer') st.ownerAuras--;
  st.auraModBits &= ~bit;
  const m = st.zoneMask;
  for (let c = 0; c < m.length; c++) m[c] = m[c]! & ~bit;
  st.zoneFx[fx.zbit] = -1;
  st.diffBits &= ~bit;
  st.travelBits &= ~bit;
  st.hookBits &= ~bit;
  st.enterBits &= ~bit;
  fx.zbit = -1;
  fx.anchor = -1;
  fx.aim = undefined;
}

export function endConcentration(cx: Ctx, u: Unit, why: FxEndWhy, cause: number): void {
  if (u.conc >= 0) endFx(cx, u.conc, why, cause);
}

/** One cond-off event per bit in `ended` (a seq each even without a sink, so seqs match a logged run). */
export function condOffEvents(cx: Ctx, u: Unit, ended: number, via: Id, cause: number): void {
  if (!cx.sink) {
    for (let bit = 1; bit <= ended; bit <<= 1) if (ended & bit) nextSeq(cx);
    return;
  }
  for (let bit = 1; bit <= ended; bit <<= 1) {
    if (!(ended & bit)) continue;
    const seq = nextSeq(cx);
    emit(cx, { ...evBase(cx, seq, cause), k: 'cond', who: u.idx, cond: condId(bit), on: false, via });
  }
}

/**
 * A turn boundary of `u` (its turn number is already u.turns): conditions and effects anchored
 * to it expire, in effect-id order. Called at both ends of every turn, and for a dead
 * creature's initiative slot while something is still anchored to it (ghost turns).
 */
export function boundary(cx: Ctx, edge: 'start' | 'end', u: Unit, cause: number): void {
  const st = cx.st;
  const k = edge === 'start' ? 'turnStart' : 'turnEnd';
  for (const o of st.units) {
    const ended = expireConds(o, k, u.idx, u.turns);
    condOffEvents(cx, o, ended, edge === 'start' ? 'core:turn-start' : 'core:turn-end', cause);
  }
  if (st.liveFx === 0) return;
  for (let i = 0; i < st.fx.length; i++) {
    const f = st.fx[i]!;
    if (!f.alive) continue;
    const e = f.until;
    if (e.k === k && e.unit === u.idx && u.turns > e.after) endFx(cx, i, 'expired', cause);
    else if (e.k === 'timed' && e.unit === u.idx && u.turns >= e.turn) {
      const atStart = useFlag(st, 'timedDurationExpiryPoint') === 'startOfCreatorTurn';
      if (atStart === (edge === 'start') || u.turns > e.turn) endFx(cx, i, 'expired', cause);
    }
  }
}

/**
 * Would anything anchored to `t` still be waiting for one of t's turn boundaries after the
 * turn in progress? (A Disengage that ends at the end of t's own current turn isn't.)
 */
export function hasPendingAnchors(st: QueryState, t: Unit): boolean {
  const pending = (e: Expiry): boolean => {
    if (e.k === 'turnEnd' && e.unit === t.idx) return !(st.active === t.idx && t.turns > e.after);
    if (e.k === 'turnStart' && e.unit === t.idx) return true;
    if (e.k === 'timed' && e.unit === t.idx) return true;
    return false;
  };
  for (const f of st.fx) if (f.alive && pending(f.until)) return true;
  for (const o of st.units) for (const c of o.conds) if (pending(c.until)) return true;
  return false;
}

/**
 * A creature died. Its own concentration ends (p.179); effects it bears keep running (Dead,
 * p.180). Anything anchored to its future turns waits for its initiative slot (ghost turns),
 * or ends now, per deadAnchorTurnBoundary.
 */
export function onDeath(cx: Ctx, t: Unit, cause: number): void {
  const st = cx.st;
  endConcentration(cx, t, 'death', cause);
  // An Emanation "moves with the creature ... that is its origin" (srd-raw.txt:33383-33384); a passive one (duration: parent, no parent) has no other end.
  if (st.ownerAuras > 0) {
    for (let z = 0; z < 32; z++) {
      const id = st.zoneFx[z]!;
      if (id >= 0 && st.fx[id]!.owner === t.idx && boundOf(st, st.fx[id]!).zone!.from === 'bearer') endFx(cx, id, 'anchorDied', cause);
    }
  }
  if (!hasPendingAnchors(st, t)) return;
  if (useFlag(st, 'deadAnchorTurnBoundary') === 'keepInitiativeSlot') return;
  const anchored = (e: Expiry) => (e.k === 'turnStart' || e.k === 'turnEnd' || e.k === 'timed') && e.unit === t.idx;
  for (let i = 0; i < st.fx.length; i++) if (st.fx[i]!.alive && anchored(st.fx[i]!.until)) endFx(cx, i, 'anchorDied', cause);
  for (const o of st.units) {
    const before = o.condMask;
    for (let i = o.conds.length - 1; i >= 0; i--) if (anchored(o.conds[i]!.until)) o.conds.splice(i, 1);
    refreshMask(o);
    condOffEvents(cx, o, before & ~o.condMask, 'core:anchor-died', cause);
  }
}

/**
 * A creature gained the Incapacitated condition: its concentration ends (p.179), and so does
 * every effect it owns that ends on Incapacitated (a form).
 */
export function onIncapacitated(cx: Ctx, u: Unit, cause: number): void {
  const st = cx.st;
  endConcentration(cx, u, 'incapacitated', cause);
  for (let i = 0; i < st.fx.length; i++) {
    const f = st.fx[i]!;
    if (f.alive && f.owner === u.idx && boundOf(st, f).endsOn & END.incap) endFx(cx, i, 'incapacitated', cause);
  }
}

/**
 * W1 (docs/design/w1-plan.md P1): sustains `u`'s sustained effects (Rage). "If your Rage is still
 * active on your next turn, you can extend the Rage for another round by doing one of the following:
 * Make an attack roll against an enemy. Force an enemy to make a saving throw. ... Each time the Rage
 * is extended, it lasts until the end of your next turn" (srd-raw.txt:4985-4993). So on `u`'s own
 * turn only (an opportunity attack or a save on someone else's turn doesn't count: the text sets the
 * window, so it's plain code, not a flag), each live effect `u` owns and bears whose template
 * carries SUSTAIN bit `bit` (BoundEffect.sustain) lasts until the end of `u`'s next turn again.
 * The callers (sim/attack.ts, sim/steps.ts) check that the roll or the save is against an enemy.
 * Effects without `sustain` are never touched (C3); a creature bearing none pays one loop.
 */
export function sustain(cx: Ctx, u: Unit, bit: number): void {
  const st = cx.st;
  if (st.active !== u.idx || u.borne.length === 0) return;
  for (const id of u.borne) {
    const f = st.fx[id]!;
    if (!f.alive || f.owner !== u.idx) continue;
    const s = u.tpl.effects[f.tpl]!.sustain;
    if (s !== undefined && (s & bit) !== 0) reanchor(f, u);
  }
}

/**
 * W1 (P1): `f`, a sustained effect borne by `u`, lasts until the end of u's next turn from now
 * (a sustain call, or the extendSource step: Rage's Bonus Action extension, srd-raw.txt:4990).
 * Content refuses `sustain` without `duration: { until: endOfNextTurn, of: bearer }`, so its
 * expiry is already a turnEnd anchored to `u`; this moves only its turn number.
 */
export function reanchor(f: Fx, u: Unit): void {
  if (f.until.k === 'turnEnd' && f.until.unit === u.idx && f.until.after === u.turns) return;
  f.until = { k: 'turnEnd', unit: u.idx, after: u.turns };
}

/** A dead creature's initiative slot comes up while something is anchored to its turns. */
export function ghostTurn(cx: Ctx, t: Unit): void {
  t.turns++;
  boundary(cx, 'start', t, -1);
  boundary(cx, 'end', t, -1);
}

// ---- once per turn ----

/** May `fx` fire on unit `u` this turn? Keyed by turn, not round: "once per turn" is any creature's turn. */
export function ledgerOk(st: QueryState, fx: Fx, u: number): boolean {
  return !fx.hit || fx.hit[u] !== st.turnIdx;
}

export function ledgerMark(st: QueryState, fx: Fx, u: number): void {
  if (fx.hit) fx.hit[u] = st.turnIdx;
}

// ---- same-spell potency (p.106) ----

/** `a` beats `b` between copies of one spell: the higher cast level, then the more recent. */
export function outranks(a: Fx, b: Fx): boolean {
  return a.lvl > b.lvl || (a.lvl === b.lvl && a.id > b.id);
}

/**
 * Two copies of one effect of one spell: the same spell and the same effect within it. Two
 * different effects from one casting (a rider and a penalty, say) never compete; the tpl index
 * can't tell, since it differs per caster and cast level.
 */
export function sameEffect(st: QueryState, a: Fx, b: Fx): boolean {
  return a.sid === b.sid && boundOf(st, a).local === boundOf(st, b).local;
}

/** Is a live copy of the same effect of the same spell in `ids` more potent than `fx`? Features (sid -1) never compete. */
export function outrankedIn(st: QueryState, ids: readonly number[], fx: Fx): boolean {
  if (fx.sid < 0) return false;
  for (const j of ids) {
    const o = st.fx[j]!;
    if (o !== fx && o.alive && outranks(o, fx) && sameEffect(st, o, fx)) return true;
  }
  return false;
}

// ---- roll modifiers ----

/** Everything effects add to one d20 test besides Advantage and Disadvantage (which stay source lists). */
export interface ModFold {
  flat: number;
  readonly pre: ExprNode[];
  /** The highest d20 floor that applies; 0 for none. */
  floor: number;
  /** Fx ids of one-use riders that applied: spent after the roll. */
  readonly riders: number[];
}

export function newModFold(): ModFold {
  return { flat: 0, pre: [], floor: 0, riders: [] };
}

export function resetFold(f: ModFold): void {
  f.flat = 0;
  f.pre.length = 0;
  f.floor = 0;
  f.riders.length = 0;
}

/**
 * Folds the roll modifiers of the roller's effects ('self') and, for an attack roll, the
 * target's ('incoming') into adv/dis and `f`. Of two live copies of one spell on a creature
 * only the more potent folds (p.106). Pure: writes only adv, dis and f. `lasting` leaves out
 * one-use riders (consume: nextRoll), for a roll that can't spend them (initiative), so they
 * stay for the next real roll.
 */
export function foldMods(st: QueryState, roller: Unit, target: Unit | null, key: number, adv: string[], dis: string[], f: ModFold | null, lasting = false): void {
  if (st.liveFx === 0) return;
  foldFrom(st, roller.borne, 'self', key, adv, dis, f, lasting, roller, target, roller);
  if (target) foldFrom(st, target.borne, 'incoming', key, adv, dis, f, lasting, target, target, roller);
  if (st.auraModBits !== 0) foldAuras(st, roller, target, key, adv, dis, f, lasting);
}

/** Does this Emanation act on `u` now: up (offWhen, srd-raw.txt:11995) and not sparing it? */
function auraActsOn(st: QueryState, fx: Fx, u: Unit): boolean {
  const z = boundOf(st, fx).zone!;
  const owner = st.units[fx.owner]!;
  if (z.offWhenIncap && has(owner, COND.incapacitated)) return false;
  return z.affects === undefined || !zoneSpares(z.affects, owner, u);
}

/** What an aura's flat mods add up to: the creature takes the best of two copies. */
function auraFlat(st: QueryState, fx: Fx): number {
  let n = 0;
  for (const m of boundOf(st, fx).mods) if (m.op === 'flat') n += m.value;
  return n;
}

/**
 * Coverage step 7.5: the roll mods of the Emanations covering the roller's square, on the 'self'
 * side (an aura has no bearer: never through `borne`, so it folds once). "A creature can benefit
 * from only one Aura of Protection at a time; the creature chooses which aura" (srd-raw.txt:11999-12000):
 * of copies of one effect it takes the highest [U: assumes it always chooses the highest], ties to the older.
 */
function foldAuras(st: QueryState, roller: Unit, target: Unit | null, key: number, adv: string[], dis: string[], f: ModFold | null, lasting: boolean): void {
  const bits = st.zoneMask[roller.cell]! & st.auraModBits;
  if (bits === 0) return;
  for (let z = 0; z < 32; z++) {
    if (!(bits & (1 << z))) continue;
    const fx = st.fx[st.zoneFx[z]!]!;
    if (!auraActsOn(st, fx, roller)) continue;
    const id = boundOf(st, fx).id;
    let beaten = false;
    for (let y = 0; y < 32 && !beaten; y++) {
      if (y === z || !(bits & (1 << y))) continue;
      const o = st.fx[st.zoneFx[y]!]!;
      if (boundOf(st, o).id !== id || !auraActsOn(st, o, roller)) continue;
      const d = auraFlat(st, o) - auraFlat(st, fx);
      beaten = d > 0 || (d === 0 && o.id < fx.id);
    }
    if (!beaten) foldFrom(st, [fx.id], 'self', key, adv, dis, f, lasting, roller, target, roller);
  }
}

function foldFrom(st: QueryState, borne: readonly number[], side: 'self' | 'incoming', key: number, adv: string[], dis: string[], f: ModFold | null, lasting: boolean, bearer: Unit, target: Unit | null, roller: Unit): void {
  const skill = ((key & RK.SK) >> RK.SK_SHIFT) - 1;
  for (const id of borne) {
    const fx = st.fx[id]!;
    if (!fx.alive || outrankedIn(st, borne, fx)) continue;
    const te = boundOf(st, fx);
    for (const m of te.mods) {
      if (m.side !== side || (lasting && m.consume) || !m.on.some((p) => keyMatches(key, p))) continue;
      if (m.skillParam && skill !== fx.param) continue;
      if (m.ownerOnly && roller.idx !== fx.owner) continue; // M3 step 5b (Vex): only the owner's rolls
      if (m.when && !gatesOk(st, bearer, m.when, target)) continue;
      if (m.op === 'adv') adv.push(te.id);
      else if (m.op === 'dis') dis.push(te.id);
      else if (f) {
        if (m.op === 'flat') f.flat += m.value;
        else if (m.op === 'preDice') f.pre.push(m.dice!);
        else if (m.op === 'floor') f.floor = Math.max(f.floor, m.value);
      }
      if (m.consume && f && !f.riders.includes(fx.id)) f.riders.push(fx.id);
    }
  }
}

/**
 * Spends the one-use riders that applied to an attack roll: the next attack roll by anyone,
 * hit or miss. A rider whose Advantage changed nothing (another Advantage source, or any
 * Disadvantage) is spent or kept per nextRollRiderConsumedWhenRedundant.
 */
export function consumeRiders(cx: Ctx, riders: readonly number[], adv: readonly string[], dis: readonly string[], cause: number): void {
  for (const id of riders) {
    const redundant = adv.length > 1 || dis.length > 0;
    if (!redundant || useFlag(cx.st, 'nextRollRiderConsumedWhenRedundant') === 'consumed') endFx(cx, id, 'consumed', cause);
  }
}
