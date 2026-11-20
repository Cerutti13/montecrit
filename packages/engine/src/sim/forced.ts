// Forced movement: a pull or push of a chosen distance. The text says "up to 10 feet closer"
// with no "straight", so each square must bring the target closer (forcedMovementPath); a
// push moves it farther. The puller chooses the whole path before anything moves: one
// square at a time against a simulated position, stopping whenever it likes, so the choice
// can't depend on what a step's damage rolls. Then the target walks it square by square
// (sim/walker.ts, forced mode): no opportunity attacks, none of its movement spent, zone
// triggers per involuntaryMovementTriggersArea. It keeps going if it's knocked down, and
// stops if it dies.
//
// What blocks a square: walls and wall corners (diagonalCorner), the grid's edge, the
// puller's own square, and occupied squares (forcedMovementObstacle=stopBefore). Difficult
// Terrain is ignored (feet moved are feet moved) unless forcedMovementTerrainCost says
// otherwise.

import { TERR } from '../grid/cells.ts';
import { CELL, cellInfo, distFt, DX, DY } from '../grid/reach.ts';
import { ask, pushLegal, releaseList, takeList, type Ctx } from './context.ts';
import { markFlag, readFlag, useFlag, type QueryState, type Unit } from './state.ts';
import { walkPath } from './walker.ts';

export interface ForcedStep {
  readonly mode: 'pull' | 'push';
  readonly maxFt: number;
  readonly maxSize: number;
  /** M3 step 5b: the text itself says "straight" (Push), so forcedMovementPath doesn't decide. */
  readonly straight?: true;
  /** Coverage step 7.3: the text states the distance ("pushed 10 feet"): no stopping while squares remain. */
  readonly exact?: true;
}

/**
 * Squares one forced step from `at` may go to, given `left` feet; writes the cost of each.
 * `pullerCell` is where the puller stands: its live square, or (for a decider's plan to move
 * and then pull) where it will stand, in which case the square it left counts as empty.
 * Returns bits saying what shaped the choice (1 an occupied square, 2 Difficult Terrain), for
 * the flags; it reads flags without marking them, so queries may call it.
 */
export function forcedSteps(st: QueryState, puller: Unit, pullerCell: number, t: Unit, at: number, left: number, parity: number, mode: 'pull' | 'push', out: number[], cost: number[], straightText = false): number {
  const { w, h, terrain } = st.setup;
  out.length = 0;
  cost.length = 0;
  const x = at % w;
  const y = Math.floor(at / w);
  const here = distFt(st, pullerCell, at);
  const straight = straightText || readFlag(st, 'forcedMovementPath') === 'straightLineOnly';
  const line = straight ? nextOnLine(st, at, pullerCell, mode) : -1;
  const moved = pullerCell !== puller.cell;
  let shaped = 0;
  for (let d = 0; d < 8; d++) {
    const nx = x + DX[d]!;
    const ny = y + DY[d]!;
    if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
    const to = ny * w + nx;
    if (to === pullerCell || terrain[to]! & TERR.wall) continue;
    const there = distFt(st, pullerCell, to);
    if (mode === 'pull' ? there >= here : there <= here) continue;
    if (straight && to !== line) continue;
    const diagonal = nx !== x && ny !== y;
    if (diagonal) {
      const a = (terrain[y * w + nx]! & TERR.wall) !== 0;
      const b = (terrain[ny * w + x]! & TERR.wall) !== 0;
      if (readFlag(st, 'diagonalCorner') === 'eitherBlocks' ? a || b : a && b) continue;
    }
    const info = cellInfo(st, t, to, moved ? puller : null); // a planned move vacates the puller's square
    if (info & CELL.occupied) {
      shaped |= 1; // an occupied square would otherwise have been a step
      continue;
    }
    let c = diagonal && readFlag(st, 'diagonalCost') === 'alternate' && parity === 1 ? 10 : 5;
    if (info & CELL.difficult) {
      shaped |= 2;
      if (readFlag(st, 'forcedMovementTerrainCost') === 'terrainShortens') c *= 2;
    }
    if (c > left) continue;
    out.push(to);
    cost.push(c);
  }
  return shaped;
}

/** The next square on a straight line from `at` toward (or away from) `cell`. */
function nextOnLine(st: QueryState, at: number, cell: number, mode: 'pull' | 'push'): number {
  const w = st.setup.w;
  const ax = at % w;
  const ay = Math.floor(at / w);
  const dx = (cell % w) - ax;
  const dy = Math.floor(cell / w) - ay;
  const sx = Math.sign(dx) * (mode === 'pull' ? 1 : -1);
  const sy = Math.sign(dy) * (mode === 'pull' ? 1 : -1);
  // Along the dominant axis, diagonally only when both offsets are equal (a true straight line on squares).
  const ux = Math.abs(dx) >= Math.abs(dy) ? sx : 0;
  const uy = Math.abs(dy) >= Math.abs(dx) ? sy : 0;
  const nx = ax + ux;
  const ny = ay + uy;
  return nx >= 0 && nx < w && ny >= 0 && ny < st.setup.h ? ny * w + nx : -1;
}

/** A pull or push of `target` by `puller`, its distance and path chosen square by square up front. */
export function forcedMove(cx: Ctx, puller: Unit, target: number, step: ForcedStep, cause: number, via = '', lvl?: number): void {
  const st = cx.st;
  const t = st.units[target]!;
  if (t.life === 'dead' || t.tpl.size > step.maxSize) return;
  if (!step.straight) useFlag(st, 'forcedMovementPath');
  const path: number[] = [];
  const cand: number[] = [];
  const cost: number[] = [];
  let at = t.cell;
  let left = step.maxFt;
  let parity = 0;
  for (;;) {
    const shaped = forcedSteps(st, puller, puller.cell, t, at, left, parity, step.mode, cand, cost, step.straight === true);
    if (shaped & 1) markFlag(st, 'forcedMovementObstacle');
    if (shaped & 2) markFlag(st, 'forcedMovementTerrainCost');
    if (cand.length === 0) break;
    const list = takeList(cx);
    if (!step.exact) pushLegal(list, 'pull'); // stop here (cell -1)
    for (const c of cand) pushLegal(list, 'pull').cell = c;
    const i = ask(cx, puller.idx, 'pull', list, cause, undefined, undefined, { src: { via, target, ...(lvl !== undefined ? { lvl } : {}) } });
    const to = list.items[i]!.cell;
    releaseList(cx, list);
    if (to < 0) break;
    const k = cand.indexOf(to);
    left -= cost[k]!;
    const w = st.setup.w;
    if (readFlag(st, 'diagonalCost') === 'alternate' && to % w !== at % w && Math.floor(to / w) !== Math.floor(at / w)) parity ^= 1;
    path.push(to);
    at = to;
  }
  if (path.length === 0) return;
  walkPath(cx, t, Int32Array.from(path), path.length, 'forced', cx.lastDecided, step.mode);
}
