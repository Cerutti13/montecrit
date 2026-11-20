// Scratch for deciders' queries (docs/design/m1c.md 3): separate from the resolution scratch,
// so a query never disturbs a fight in progress. One per fight context, shared by its views
// (decisions are sequential and no query outlives its decide()).

import type { ReachScratch } from '../grid/reach.ts';
import { newModFold, type ModFold } from '../sim/effects.ts';

export interface QueryScratch {
  /** Pathfinding for queries (the context's reachQuery). */
  readonly reach: ReachScratch;
  readonly adv: string[];
  readonly dis: string[];
  readonly fold: ModFold;
  readonly cand: number[];
  readonly cost: number[];
}

export function newQueryScratch(reach: ReachScratch): QueryScratch {
  return { reach, adv: [], dis: [], fold: newModFold(), cand: [], cost: [] };
}
