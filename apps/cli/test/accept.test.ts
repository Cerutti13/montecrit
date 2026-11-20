// M1c accept checks that need many greedy fights (docs/design/m1c.md, Accept checklist), on the
// public stars-ambush:
//   - Moonbeam damages a creature at most once per turn, yet hits the same creature on more than
//     one turn (the ledger is per turn, not per round); 40 fights, 500 under MONTECRIT_SLOW=1;
//   - (MONTECRIT_SLOW=1) two -n 1000 reports, one in this process and one in worker processes, are
//     the same bytes.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/files.ts';
import { planRun, playOne, runRun, runRunAsync, type RunPlan } from '../src/run.ts';

const SLOW = !!process.env.MONTECRIT_SLOW;
const env = { MONTECRIT_HOME: mkdtempSync(join(tmpdir(), 'montecrit-home-')) };

describe('M1c acceptance over greedy fights', () => {
  const N = SLOW ? 500 : 40;
  it(`Moonbeam damages a creature at most once per turn, and the same creature on more than one turn (${N} moonbeam-first fights)`, { timeout: SLOW ? 300_000 : 30_000 }, () => {
    const p = planRun(['stars-ambush', '-n', '2', '--policy', 'moonbeam-first'], env, REPO_ROOT) as RunPlan;
    const arm = p.arms[0]!;
    let hits = 0;
    let again = 0;
    for (let r = 0; r < N; r++) {
      const f = playOne(arm.setup, 42, r, arm.policy);
      let thisTurn = new Set<number>();
      const turnsHit = new Map<number, number>();
      for (const e of f.events) {
        if (e.k === 'turnStart') thisTurn = new Set();
        else if (e.k === 'damage' && e.via === 'srd:moonbeam/beam') {
          expect(thisTurn.has(e.tgt), `run ${r}: #${e.seq} is a second Moonbeam hit on ${arm.setup.seats[e.tgt]!.seat} this turn`).toBe(false);
          thisTurn.add(e.tgt);
          turnsHit.set(e.tgt, (turnsHit.get(e.tgt) ?? 0) + 1);
          hits++;
        }
      }
      for (const n of turnsHit.values()) if (n > 1) again++;
    }
    expect(hits).toBeGreaterThan(N);
    expect(again).toBeGreaterThan(0);
  });

  it.runIf(SLOW)('two -n 1000 reports, in-process and in worker processes, are the same bytes', { timeout: 300_000 }, async () => {
    const args = ['stars-ambush', '-n', '1000', '--policy', 'greedy,moonbeam-first'];
    const one = runRun(args, env);
    const two = await runRunAsync([...args, '--procs', '2'], env);
    expect([one.code, two.code]).toEqual([0, 0]);
    expect(two.out).toBe(one.out);
  });
});
