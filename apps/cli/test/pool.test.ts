// The worker pool on real worker threads (docs/design/m2.md 7.3, critique resolution 4): the n40
// golden job through apps/cli/src/pool-node.ts at 1 and 3 threads prints the golden text, the
// golden hashes and the in-process JSON; a worker that can't rebuild the job fails loudly. The
// slow suite adds 1 vs 8 threads vs in-process on three policies.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/files.ts';
import { reportOutput, runInProcess, runInWorkers, WorkerError } from '../src/report.ts';
import { planRun, type RunPlan } from '../src/run.ts';

const SLOW = !!process.env.MONTECRIT_SLOW;
const G = join(REPO_ROOT, 'scenarios', 'golden');
const env = { MONTECRIT_HOME: mkdtempSync(join(tmpdir(), 'montecrit-home-')) };
const GOLDEN_ARGS = ['stars-ambush', '-n', '40', '--policy', 'greedy,moonbeam-first', '--chunk', '20'];

const plan = (args: string[]): RunPlan => planRun(args, env, REPO_ROOT) as RunPlan;
const output = (p: RunPlan, run: Awaited<ReturnType<typeof runInWorkers>>) => reportOutput(p.arms, run, { ...p.view, meta: { ...p.view.meta, checkpoint: run.checkpoint, hitCap: run.hitCap } });

describe('worker pool on real threads', () => {
  it('the n40 golden job at 1 and 3 threads: golden text, golden hashes, in-process JSON', { timeout: 60_000 }, async () => {
    const text = readFileSync(join(G, 'stars-ambush.report.n40.txt'), 'utf8');
    const hashes = readFileSync(join(G, 'stars-ambush.report.n40.hash'), 'utf8');
    const p = plan([...GOLDEN_ARGS, '--report-hash']);
    const pj = plan([...GOLDEN_ARGS, '--json']);
    const json = output(pj, runInProcess(pj.arms, pj.job));
    for (const W of [1, 3]) {
      const out = output(p, await runInWorkers(p.job, W));
      expect(out + '\n').toBe(`${text}\n${hashes}`);
      expect(output(pj, await runInWorkers(pj.job, W))).toBe(json);
    }
  });

  it('a worker that rebuilds other hashes stops the run with a message, not a stack', { timeout: 30_000 }, async () => {
    const p = plan(GOLDEN_ARGS);
    const e = await runInWorkers({ ...p.job, expect: { scenarioHash: p.job.expect!.scenarioHash, contentHash: '0000000000000000' } }, 2).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(WorkerError);
    expect((e as WorkerError).message).toMatch(/the scenario or content changed under the run/);
  });

  // 180 s: on GitHub's runners this takes about 59 s when it passes, and it timed out at 60 s twice on 2026-11-15.
  it('M3 step 5a: monk-ambush (riders, Deflect, a rider policy) at 1 and 3 threads equals in-process, text and JSON', { timeout: 180_000 }, async () => {
    const args = ['monk-ambush', '-n', '60', '--policy', 'greedy,stun-first', '--chunk', '20'];
    const p = plan([...args, '--report-hash']);
    const pj = plan([...args, '--json']);
    const here = output(p, runInProcess(p.arms, p.job));
    const json = output(pj, runInProcess(pj.arms, pj.job));
    expect(here).toMatch(/Stunning Strike \(rider\)/);
    for (const W of [1, 3]) {
      expect(output(p, await runInWorkers(p.job, W))).toBe(here);
      expect(output(pj, await runInWorkers(pj.job, W))).toBe(json);
    }
  });

  it.skipIf(!SLOW)('1 vs 8 threads vs in-process: monk-ambush, greedy and stun-first, 400 runs, chunk 50', { timeout: 300_000 }, async () => {
    const p = plan(['monk-ambush', '-n', '400', '--policy', 'greedy,stun-first', '--chunk', '50', '--report-hash']);
    const here = output(p, runInProcess(p.arms, p.job));
    expect(output(p, await runInWorkers(p.job, 1))).toBe(here);
    expect(output(p, await runInWorkers(p.job, 8))).toBe(here);
  });

  it.skipIf(!SLOW)('1 vs 8 threads vs in-process: public stars-ambush, three policies, 600 runs, chunk 50', { timeout: 300_000 }, async () => {
    const p = plan(['scenarios/stars-ambush.yaml', '-n', '600', '--policy', 'greedy,moonbeam-first,spike-first', '--chunk', '50', '--report-hash']);
    const here = output(p, runInProcess(p.arms, p.job));
    expect(output(p, await runInWorkers(p.job, 1))).toBe(here);
    expect(output(p, await runInWorkers(p.job, 8))).toBe(here);
  });
});
