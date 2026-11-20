// The step walker. A creature moves one square at a time; before each step, every hostile
// whose reach the step leaves may spend its Reaction on an opportunity attack, which lands
// while the mover is still on the square it's leaving (SRD 5.2.1 p.15, p.185). If that drops
// the mover, the step never happens and it stays where it was, even if that's an ally's
// square. Damage alone doesn't stop a move (Sage Advice); being downed (Speed 0) does.
//
// walkPath takes a path, not an option, so forced movement reuses it (sim/forced.ts): no
// opportunity attacks, no movement spent, a diagonal parity of its own, Difficult Terrain per
// forcedMovementTerrainCost, and it keeps going while the creature is down (it's being
// dragged); only death stops it. A walk also stops when something it set off moves the
// creature off its path (it never jumps back onto it). Coverage step 9 review: a voluntary walk
// also stops when the mover learns of a hidden zone on the way (it recognizes it, or finds that
// something there hurt it): it planned without it, so it hands the rest of its movement back to
// its decider to plan again (stopping partway is always allowed: srd-raw.txt:1878-1883).

import { TERR } from '../grid/cells.ts';
import { seesCell } from './cover.ts';
import { canReactAgainst, CELL, cellInfo, distFt, INF, nextParity, oaReach, stepCost } from '../grid/reach.ts';
import { ask, emit, evBase, nextSeq, pushLegal, releaseList, takeList, type Ctx } from './context.ts';
import { resolveAttack } from './attack.ts';
import { speedNow } from './damage.ts';
import { listReactions } from './options.ts';
import { drain, queueTrigger, TRIG } from './triggers.ts';
import { moveAuras } from './zones.ts';
import { hiddenLive, hiddenSeenMask } from './hidden.ts';
import { COND, has, markFlag, type QueryState, type Unit } from './state.ts';

export type WalkMode = 'voluntary' | 'forced';

/**
 * W1 (docs/design/w1-plan.md P9): a voluntary walk of a feature's free move ("move up to half your
 * Speed without provoking Opportunity Attacks": Tactical Shift, srd-raw.txt:10661-10663; Withdraw,
 * 13835-13836). `left`: feet it may still walk (counted down as it goes). It never polls for
 * opportunity attacks. `spends` (freeMoveUsesMovement=true on the walker's own turn): its feet come
 * out of moveFt and count in movedFt as a normal walk's do; otherwise they go to b.freeFt, and the
 * turn's movement stays whole (syncBudget leaves freeFt out of its sum).
 */
export interface FreeWalk {
  left: number;
  readonly spends: boolean;
}

export function walkPath(cx: Ctx, u: Unit, path: Int32Array, n: number, mode: WalkMode, cause: number, how: 'pull' | 'push' = 'pull', free: FreeWalk | null = null): void {
  const st = cx.st;
  const voluntary = mode === 'voluntary';
  const w = st.setup.w;
  let parity = voluntary ? u.b.diagParity : 0;
  let from = u.cell;
  let steps = 0;
  let why: 'arrived' | 'downed' | 'died' | 'blocked' | 'noSpeed' | 'ended' | 'displaced' | 'learned' = 'arrived';
  if (st.corpses.some((c) => c > 0)) markFlag(st, 'corpseSpace');
  const watch = voluntary && hiddenLive(st);
  const known0 = watch ? hiddenSeenMask(st, u, 1) : 0;
  const hurt0 = watch ? hiddenSeenMask(st, u, 2) : 0;
  for (let i = 0; i < n; i++) {
    const to = path[i]!;
    const info = cellInfo(st, u, to);
    const diagonal = from % w !== to % w && Math.floor(from / w) !== Math.floor(to / w);
    let cost: number;
    if (voluntary) {
      cost = stepCost(st, u, from, to, parity, info);
      if (cost >= INF || cost > (free ? free.left : u.b.moveFt)) {
        // A free move's refusal leaves the turn's own routes alone (its budget isn't theirs).
        if (watch && steps === 0 && !free) refuseFirst(st, u, to);
        why = 'blocked';
        break;
      }
      // With a hidden zone live, the route was planned without the Difficult Terrain the mover
      // doesn't know of, so its true cost can run out partway. A move can't end in another
      // creature's space (SRD 5.2.1 p.14), so it steps into one only if the true cost still
      // reaches a free square of the path beyond it (main-session fix, sim-props seed 827447).
      // Refused on the first step, nothing has changed and its decider would pick the same move
      // again without end (bench, Ranger 10 party: 256 decisions in one turn), so that first square
      // comes off its routes while it stays put this turn (refuseFirst) [U: a modeling call].
      if (watch && info & CELL.occupied && !reachesFreeSquare(st, u, path, n, i, from, parity, cost, free ? free.left : u.b.moveFt)) {
        if (steps === 0 && !free) refuseFirst(st, u, to);
        why = 'blocked';
        break;
      }
    } else {
      // The path was chosen square by square (walls, corners, occupied squares already ruled out).
      if (st.setup.terrain[to]! & TERR.wall || info & CELL.occupied) {
        why = 'blocked';
        break;
      }
      cost = diagonal && st.setup.flags.diagonalCost === 'alternate' && parity === 1 ? 10 : 5;
      if (info & CELL.difficult && st.setup.flags.forcedMovementTerrainCost === 'terrainShortens') cost *= 2;
    }
    if (diagonal) {
      markFlag(st, 'diagonalCost');
      const t = st.setup.terrain;
      if (t[Math.floor(from / w) * w + (to % w)]! & TERR.wall || t[Math.floor(to / w) * w + (from % w)]! & TERR.wall) markFlag(st, 'diagonalCorner');
    }
    // W1 (P9): a free move provokes no opportunity attacks (a walk-local exemption, beside Disengage's condition).
    if (voluntary && !free && !has(u, COND.disengaged)) {
      pollLeaveReach(cx, u, from, to, cause);
      if (u.life !== 'up') {
        why = u.life === 'dead' ? 'died' : 'downed';
        break;
      }
      if (st.outcome) {
        why = 'ended';
        break;
      }
      // Something the reaction did moved the mover: the planned step no longer starts where it is.
      if (u.cell !== from) {
        why = 'displaced';
        break;
      }
    }
    if (free) {
      free.left -= cost;
      if (free.spends) {
        u.b.moveFt -= cost;
        u.b.movedFt += cost;
      } else u.b.freeFt += cost; // the hasntMoved gate reads movedFt + freeFt (sim/stats.ts)
    } else if (voluntary) {
      u.b.moveFt -= cost;
      u.b.movedFt += cost; // the hasntMoved gate (M3 step 4)
    }
    // Feet traveled (not movement spent): a 10-ft alternating diagonal is two 5-ft increments.
    const incr = diagonal && st.setup.flags.diagonalCost === 'alternate' && parity === 1 ? 2 : 1;
    parity = nextParity(st, from, to, parity);
    if (voluntary) u.b.diagParity = parity;
    u.cell = to;
    steps++;
    const seq = nextSeq(cx);
    if (cx.sink) emit(cx, { ...evBase(cx, seq, cause), k: 'step', who: u.idx, from, to, ft: cost, left: u.b.moveFt, ...(voluntary ? {} : { forced: how }) });
    if (st.ownerAuras !== 0) moveAuras(cx, u, seq);
    const forced = voluntary ? 0 : 1;
    queueTrigger(cx, TRIG.move5ft, u.idx, from, to, forced | (incr << 1), seq);
    queueTrigger(cx, TRIG.enter, u.idx, to, from, forced, seq);
    drain(cx);
    if (u.life === 'dead' || (voluntary && u.life !== 'up')) {
      why = u.life === 'dead' ? 'died' : 'downed';
      break;
    }
    if (st.outcome) {
      why = 'ended';
      break;
    }
    // A trigger moved it (a zone that pushes, say): the rest of the path starts somewhere else.
    if (u.cell !== to) {
      why = 'displaced';
      break;
    }
    if (voluntary) syncBudget(st, u);
    if (voluntary && speedNow(u, st) === 0) {
      why = 'noSpeed';
      break;
    }
    // Only something new counts: a zone that ended (its bit gone) teaches nothing. A voluntary move
    // can't end in another creature's space, so on an ally's square it walks on and stops on the
    // first free square of the path (the masks still differ there; main-session fix, sim-props).
    if (
      watch &&
      i < n - 1 &&
      ((hiddenSeenMask(st, u, 1) & ~known0) !== 0 || (hiddenSeenMask(st, u, 2) & ~hurt0) !== 0) &&
      !st.units.some((o) => o !== u && o.life !== 'dead' && o.cell === to)
    ) {
      why = 'learned';
      break;
    }
    from = to;
  }
  const seq = nextSeq(cx);
  if (cx.sink) emit(cx, { ...evBase(cx, seq, cause), k: 'moveEnd', who: u.idx, cell: u.cell, why, steps, planned: n, ...(voluntary ? {} : { forced: how }) });
  // perDistanceDamageRolls=perMove deals its one instance now, however the move ended.
  queueTrigger(cx, TRIG.moveEnd, u.idx, -1, -1, voluntary ? 0 : 1, seq);
  drain(cx);
}

/**
 * Re-derives the active creature's movement budget when its Speed has changed since the budget
 * was last set (M3 step 4): its Speed now, plus the same again per Dash, less the feet it has
 * spent moving and standing up. "On your turn, you can move a distance equal to your Speed",
 * deducting each part of the move from it (srd-raw.txt:1852-1862), and Restrained's Speed 0
 * holds only while the condition does (34072-34075), so a creature that escapes on its turn
 * still has its Speed, less what it already spent. Dash adds "your Speed after applying any
 * modifiers" (33242-33248), so each Dash follows the Speed now [U: a Dash taken at Speed 0,
 * then the Speed restored, counts the restored Speed]. Forced movement spends none of it.
 * Inert while Speed holds steady: then the stored budget is exactly this sum.
 */
export function syncBudget(st: QueryState, u: Unit): void {
  if (st.active !== u.idx) return;
  const b = u.b;
  const s = speedNow(u, st);
  if (s === b.speedAt) return;
  b.speedAt = s;
  b.moveFt = Math.max(0, s * (1 + b.dashes) - b.movedFt - b.standFt);
}

/**
 * Opens a reaction window for each hostile whose reach the step from -> to leaves. When more
 * than one qualifies, whoever's turn it is orders them (simultaneous effects, p.187); the
 * candidates are offered in initiative order, starting after the active unit.
 */
function pollLeaveReach(cx: Ctx, u: Unit, from: number, to: number, cause: number): void {
  const st = cx.st;
  const reactors = cx.sc.reactors;
  reactors.length = 0;
  const N = st.order.length;
  for (let k = 1; k <= N; k++) {
    const r = st.units[st.order[(st.orderPos + k) % N]!]!;
    if (!canReactAgainst(st, r, u)) continue;
    const reach = oaReach(st, r);
    // "a creature that you can see leaves your reach" (srd-raw.txt:2096-2097): walls block sight (M3 step 8, sim/cover.ts).
    if (distFt(st, r.cell, from) <= reach && distFt(st, r.cell, to) > reach && seesCell(st, r.cell, from, st)) reactors.push(r.idx);
  }
  if (reactors.length === 0) return;
  if (reactors.length > 1) orderReactors(cx, reactors, cause);
  for (const ri of reactors) {
    // A reaction that moved the mover (Redirect Attack's swap, a Push) cancels the step: it no longer
    // leaves anyone's reach from `from` ("The attack occurs right before it leaves your reach",
    // srd-raw.txt:2096-2100), so the rest get no attack; the walker stops it `displaced`.
    if (u.life !== 'up' || st.outcome || u.cell !== from) return;
    const r = st.units[ri]!;
    if (!canReactAgainst(st, r, u)) continue;
    const pv = nextSeq(cx);
    if (cx.sink) emit(cx, { ...evBase(cx, pv, cause), k: 'provoke', mover: u.idx, by: r.idx, from, to });
    const list = listReactions(cx, r, u, from, takeList(cx));
    const i = ask(cx, r.idx, 'reaction', list, pv);
    const l = list.items[i]!;
    const atk = l.k === 'oa' ? l.atk : -1;
    releaseList(cx, list);
    if (atk < 0) continue;
    r.b.reaction = 0;
    resolveAttack(cx, r, atk, u, true, cx.lastDecided);
  }
}

/** The active unit picks the next reactor until one is left. Rewrites `reactors` in place. */
function orderReactors(cx: Ctx, reactors: number[], cause: number): void {
  const st = cx.st;
  const who = st.active >= 0 ? st.active : reactors[0]!;
  const pending = reactors.slice();
  reactors.length = 0;
  while (pending.length > 1) {
    const list = takeList(cx);
    for (const ri of pending) pushLegal(list, 'order').target = ri;
    const i = ask(cx, who, 'orderTriggers', list, cause);
    releaseList(cx, list);
    reactors.push(pending[i]!);
    pending.splice(i, 1);
  }
  reactors.push(pending[0]!);
}

/**
 * Whether the walk, about to step onto occupied square path[i] at `cost`, can still afford (at true
 * step costs, out of `budget` feet) to reach the first square of the path after it that it may stop in.
 */
function reachesFreeSquare(st: QueryState, u: Unit, path: Int32Array, n: number, i: number, from: number, parity: number, cost: number, budget: number): boolean {
  let need = cost;
  let par = nextParity(st, from, path[i]!, parity);
  let prev = path[i]!;
  for (let j = i + 1; j < n; j++) {
    const nx = path[j]!;
    const inf = cellInfo(st, u, nx);
    const c = stepCost(st, u, prev, nx, par, inf);
    if (c >= INF) return false;
    need += c;
    if (need > budget) return false;
    if (!(inf & CELL.occupied)) return true;
    par = nextParity(st, prev, nx, par);
    prev = nx;
  }
  return false;
}

/**
 * A voluntary walk planned without a hidden zone refused its first step (the true cost runs out
 * there, or on an occupied square before a free one): nothing changed, so its decider would pick the
 * same move again without end (RunawayTurn). That square is off its routes while it stays put
 * (state.ts refused); every other move is still its to choose [U: a modeling call, not rule text].
 */
function refuseFirst(st: QueryState, u: Unit, to: number): void {
  const w = st.setup.w;
  if (u.b.refusedFrom !== u.cell) {
    u.b.refused = 0;
    u.b.refusedFrom = u.cell;
  }
  u.b.refused |= 1 << (3 * (Math.floor(to / w) - Math.floor(u.cell / w) + 1) + (to % w) - (u.cell % w) + 1);
}
