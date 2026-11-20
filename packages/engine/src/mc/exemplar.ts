// The replay check (docs/design/m2.md 4.3, critique resolution 2): a fight replayed with a log
// attached must be the fight the runner counted. The run is played once more through the
// runner's own path (runChunk, fresh deciders, no sink), and that copy must reach the logged
// replay's state hash and record exactly the per-run values the merged accumulator holds.

import type { FightResult } from '../sim/fight.ts';
import { runChunk, type ArmAcc, type ArmSpec } from './runner.ts';

/** Run `run` of one arm through the runner's path: its one-run accumulator and final state hash. */
export function runnerRun(arm: ArmSpec, seed: number, run: number): { readonly acc: ArmAcc; readonly stateHash: string } {
  let stateHash = '';
  const c = runChunk([arm], seed, run, run + 1, 1, (_a: number, _r: number, r: FightResult) => (stateHash = r.stateHash));
  return { acc: c.arms[0]!, stateHash };
}

/** Every per-run field the runner keeps (ArmAcc, in run order). */
export const PER_RUN_FIELDS = ['out', 'R', 'Dpc', 'Dparty', 'concT', 'turnsPc', 'foeHpLeft', 'foeHpMax', 'pcHpEnd'] as const;

/**
 * Null when the replay is the counted fight. Otherwise what differs: the state hash first, then
 * the first per-run field where the runner's copy (`oneRun`, index 0) and the merged accumulator
 * (index `run`) disagree.
 */
export function checkReplay(merged: ArmAcc, run: number, oneRun: ArmAcc, oneRunStateHash: string, replayStateHash: string): string | null {
  if (run < 0 || run >= merged.n) return `run ${run} is outside the ${merged.n} runs of ${merged.label}`;
  if (oneRun.n !== 1) return `the runner's copy of run ${run} holds ${oneRun.n} runs`;
  if (replayStateHash !== oneRunStateHash) return `state hash: the logged replay reached ${replayStateHash}, the runner's path ${oneRunStateHash}`;
  for (const f of PER_RUN_FIELDS) {
    if (merged[f][run] !== oneRun[f][0]) return `${f}: the runner recorded ${merged[f][run]}, the replay ${oneRun[f][0]}`;
  }
  return null;
}
