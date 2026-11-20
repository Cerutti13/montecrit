// The Encounter check's verdict: a few plain numbers from a run's report, and a difficulty word.
// Every number is the report's (ArmStats); nothing is recomputed here. The difficulty cut-offs are
// this tool's own reading of those numbers, not the rulebook's encounter budget.

import type { ArmStats, Rate } from '@montecrit/engine';

export type Difficulty = 'Easy' | 'Moderate' | 'Hard' | 'Dangerous' | 'Deadly';

export interface Verdict {
  readonly difficulty: Difficulty;
  /** One sentence on why it got that word. */
  readonly why: string;
  readonly n: number;
  readonly win: Rate;
  readonly loss: Rate;
  readonly stalemate: Rate;
  /** Null when the party has no player character (stat blocks only). */
  readonly pcDrop: Rate | null;
  readonly pcDied: Rate | null;
  readonly wiped: Rate | null;
  readonly allyDied: ArmStats['allyDied'];
  readonly rounds: ArmStats['rounds'];
}

/** The cut-offs, in one place so the screen can print them. */
export const CUTS = { deadlyWin: 0.5, dangerousWin: 0.8, dangerousDied: 0.25, hardWin: 0.95, hardDrop: 0.5, moderateDrop: 0.15 } as const;

const pct = (p: number): string => `${Math.round(p * 100)}%`;

export function verdictOf(a: ArmStats, hasPc: boolean): Verdict {
  const win = a.win.p;
  const drop = hasPc ? a.pcDrop.p : 0;
  const died = hasPc ? a.pcDied.p : 0;
  let difficulty: Difficulty;
  let why: string;
  if (win < CUTS.deadlyWin) {
    difficulty = 'Deadly';
    why = `the party wins only ${pct(win)} of the time`;
  } else if (win < CUTS.dangerousWin || died >= CUTS.dangerousDied) {
    difficulty = 'Dangerous';
    why = win < CUTS.dangerousWin ? `the party loses about 1 fight in ${Math.max(2, Math.round(1 / (1 - win)))}` : `a character dies in ${pct(died)} of fights`;
  } else if (win < CUTS.hardWin || drop >= CUTS.hardDrop) {
    difficulty = 'Hard';
    why = win < CUTS.hardWin ? `the party wins ${pct(win)} of the time, so losing is a real chance` : `the party nearly always wins, but someone drops to 0 HP in ${pct(drop)} of fights`;
  } else if (drop >= CUTS.moderateDrop) {
    difficulty = 'Moderate';
    why = `the party wins, and someone drops to 0 HP in ${pct(drop)} of fights`;
  } else {
    difficulty = 'Easy';
    why = hasPc ? `the party wins ${pct(win)} of the time and rarely has anyone drop` : `the party wins ${pct(win)} of the time`;
  }
  return { difficulty, why, n: a.n, win: a.win, loss: a.loss, stalemate: a.stalemate, pcDrop: hasPc ? a.pcDrop : null, pcDied: hasPc ? a.pcDied : null, wiped: hasPc ? a.tpk : null, allyDied: a.allyDied, rounds: a.rounds };
}
