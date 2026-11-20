// Every path a forced move could take (docs/design/m1c.md 3.4, resolution 3), from the same
// step generator forcedMove offers its choices from, so a decider can only plan paths the
// engine will accept. The puller's square is explicit: a plan to move and then pull is
// evaluated from where the puller will stand, with the square it left counted as empty.

import { forcedSteps, type ForcedStep } from '../sim/forced.ts';
import { readFlag, type QueryState, type Unit } from '../sim/state.ts';
import type { QueryScratch } from './scratch.ts';

export interface ForcedPath {
  /** Squares entered, in order; empty for "stop at once". */
  readonly cells: readonly number[];
  readonly ft: number;
}

/**
 * Appends every path `puller` (standing on `pullerCell`) could move `t`, in the order the
 * engine offers them: stop first, then each next square in candidate order, depth first. Under
 * step.exact there's no stopping, so only the paths that ran out of squares or feet.
 * Returns how many it wrote. A creature too big to move, or dead, has no paths.
 */
export function forcedPaths(st: QueryState, qs: QueryScratch, puller: Unit, pullerCell: number, t: Unit, step: ForcedStep, out: ForcedPath[]): number {
  out.length = 0;
  if (t.life === 'dead' || t.tpl.size > step.maxSize) return 0;
  const w = st.setup.w;
  const alt = readFlag(st, 'diagonalCost') === 'alternate';
  const walk = (at: number, left: number, parity: number, cells: number[], ft: number) => {
    forcedSteps(st, puller, pullerCell, t, at, left, parity, step.mode, qs.cand, qs.cost, step.straight === true);
    const cand = qs.cand.slice();
    if (!step.exact || cand.length === 0) out.push({ cells: cells.slice(), ft }); // under exact only a path that can't go on is a path
    const cost = qs.cost.slice();
    for (let k = 0; k < cand.length; k++) {
      const to = cand[k]!;
      const diagonal = to % w !== at % w && Math.floor(to / w) !== Math.floor(at / w);
      cells.push(to);
      walk(to, left - cost[k]!, alt && diagonal ? parity ^ 1 : parity, cells, ft + cost[k]!);
      cells.pop();
    }
  };
  walk(t.cell, step.maxFt, 0, [], 0);
  return out.length;
}
