// `montecrit run -n N` / `--policy a,b`: the Monte Carlo report (docs/design/m1c.md 4-6). Its golden
// (2 arms x 40 runs, public PC), worker processes printing the same text as one process, the
// flag rules, --json, and --pairs all. MONTECRIT_SLOW=1 adds an adaptive run through the CLI.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/files.ts';
import { ENGINE_VERSION, hash64 } from '@montecrit/engine';
import { runRun, runRunAsync } from '../src/run.ts';

const SLOW = !!process.env.MONTECRIT_SLOW;
const G = join(REPO_ROOT, 'scenarios', 'golden');
const env = { MONTECRIT_HOME: mkdtempSync(join(tmpdir(), 'montecrit-home-')) };
const GOLDEN_ARGS = ['stars-ambush', '-n', '40', '--policy', 'greedy,moonbeam-first', '--chunk', '20'];

describe('the Monte Carlo report', () => {
  it('matches its golden (2 arms x 40 runs; review any diff on purpose; regenerate with UPDATE_REPORT_GOLDEN=1)', { timeout: 60_000 }, () => {
    const o = runRun(GOLDEN_ARGS, env);
    expect([o.code, o.err]).toEqual([0, '']);
    const path = join(G, 'stars-ambush.report.n40.txt');
    if (process.env.UPDATE_REPORT_GOLDEN) writeFileSync(path, o.out + '\n');
    expect(o.out + '\n').toBe(readFileSync(path, 'utf8'));
    for (const head of ['OUTCOMES', 'PAIRED', 'ROUNDS', 'DPR', 'DAMAGE PER ROUND', 'CONCENTRATION', 'RESOURCES', 'OPTION PICKS', 'EXEMPLARS']) expect(o.out).toMatch(new RegExp(`^${head}`, 'm'));
    expect(o.out).toMatch(/^flags consulted by the AI while deciding/m);
    // MOD-1 2026-11-11: the record was re-stamped (engine 0.7.0, greedy v11, win 70.1%); greedy v12 2026-11-14: re-measured, unchanged at 70.1%; engine 0.8.0 + greedy v13 (step E): unchanged.
    expect(o.out).toMatch(/^notes +calibrated: engine 0\.8\.0, greedy v13, weights [0-9a-f]{8}, greedy, 4,000 runs at seed 7: win 70\.1% .* -- measured on a different setup \(scenario [0-9a-f]{16}, content [0-9a-f]{16}\), not this one$/m);
    // The record self-marks STALE whenever ENGINE_VERSION moves past the engine it names, until
    // the calibration is rerun (on the private twin, in Shane's session: m3.md C20).
    const recorded = /calibrated: engine (\S+),/.exec(o.out)?.[1];
    if (recorded === ENGINE_VERSION) expect(o.out).not.toMatch(/STALE/);
    else expect(o.out).toMatch(/calibrated: engine \S+, [^\n]* -- STALE: the engine, the greedy AI or its default weights changed since/);
    expect(o.out).toMatch(/^replay +greedy (closest loss|typical win): montecrit run scenarios\/stars-ambush\.yaml --seed 42 --run \d+ --policy greedy$/m);
    // Overrides ride along in the replay command, so it replays the same fight.
    expect(runRun([...GOLDEN_ARGS, '--knob', 'downEnds=true', '--flag', 'zoneKnowledge=all'], env).out).toMatch(/^replay +greedy .* --seed 42 --flag zoneKnowledge=all --knob downEnds=true --run \d+ --policy greedy$/m);
  });

  // 60 s: about 5.6 s locally, but GitHub's runner timed out at 20 s on the step 10 and W1 pushes (2026-11-12).
  it('--report-hash appends the report hash and the runs hash after the unchanged text; both match their golden (docs/design/m2.md 7.2)', { timeout: 60_000 }, async () => {
    const o = runRun([...GOLDEN_ARGS, '--report-hash'], env);
    expect([o.code, o.err]).toEqual([0, '']);
    const lines = o.out.split('\n');
    const tail = lines.slice(-2).join('\n') + '\n';
    expect(tail).toMatch(/^report-hash [0-9a-f]{16} \(pairs ref\)\nacc-hash [0-9a-f]{16}\n$/);
    const path = join(G, 'stars-ambush.report.n40.hash');
    if (process.env.UPDATE_REPORT_GOLDEN) writeFileSync(path, tail);
    expect(tail).toBe(readFileSync(path, 'utf8'));
    expect(lines.slice(0, -3).join('\n') + '\n').toBe(readFileSync(join(G, 'stars-ambush.report.n40.txt'), 'utf8'));
    // The report hash is the hash of --json's text.
    expect(tail).toContain(`report-hash ${hash64(runRun([...GOLDEN_ARGS, '--json'], env).out)} `);
    // Worker processes give the same two lines.
    expect((await runRunAsync([...GOLDEN_ARGS, '--report-hash', '--procs', '2'], env)).out.split('\n').slice(-2).join('\n') + '\n').toBe(tail);
    for (const extra of [['--pairs', 'all'], ['--json'], ['--replay', 'closest-loss']]) expect(() => runRun([...GOLDEN_ARGS, '--report-hash', ...extra], env)).toThrow(/--report-hash hashes the default report/);
    expect(() => runRun(['stars-ambush', '-n', '1', '--report-hash'], env)).toThrow(/--report-hash is for a Monte Carlo report/);
    // The runs' hash is the same at any chunk size; the report hash covers the chunk size its JSON records.
    const other = runRun(['stars-ambush', '-n', '40', '--policy', 'greedy,moonbeam-first', '--chunk', '8', '--report-hash'], env).out.split('\n').slice(-2);
    expect(other[1]).toBe(tail.split('\n')[1]);
    expect(other[0]).not.toBe(tail.split('\n')[0]);
  });

  it('prints the same text from worker processes as from one process', { timeout: 60_000 }, async () => {
    const one = runRun(GOLDEN_ARGS, env);
    const many = await runRunAsync([...GOLDEN_ARGS, '--procs', '2'], env);
    expect([many.code, many.err]).toEqual([0, '']);
    expect(many.out).toBe(one.out);
  });

  // MOD-1 2026-11-11: 10 units now; the 2x40 report plus the replay can pass 5 s under full-suite load, so the siblings' 20 s timeout.
  it('the replay command it prints replays that run: the exemplar is the fight the report counted', { timeout: 60_000 }, () => {
    const o = runRun(GOLDEN_ARGS, env);
    const m = /^replay +greedy (closest loss|typical win): montecrit run (.*)$/m.exec(o.out)!;
    const r = runRun(m[2]!.split(' '), env);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/fight ends: (win|loss|stalemate)/);
    expect(r.out).toMatch(m[1] === 'closest loss' ? /fight ends: loss/ : /fight ends: win/);
  });

  it('--json carries the accumulators and every statistic', () => {
    const o = runRun(['stars-ambush', '-n', '12', '--policy', 'greedy,moonbeam-first', '--json'], env);
    const j = JSON.parse(o.out) as { n: number; arms: { label: string; acc: { out: number[]; win: number } }[]; stats: { arms: { win: { x: number } }[]; pairs: unknown[] } };
    expect(j.n).toBe(12);
    expect(j.arms.map((a) => a.label)).toEqual(['greedy', 'moonbeam-first']);
    expect(j.arms[0]!.acc.out).toHaveLength(12);
    expect(j.stats.arms[1]!.win.x).toBe(j.arms[1]!.acc.win);
    expect(j.stats.pairs).toHaveLength(1);
  });

  it('--pairs all compares every pair; -n N without --policy reports the scenario as one arm', () => {
    const o = runRun(['stars-ambush', '-n', '6', '--policy', 'greedy,moonbeam-first,spike-first', '--pairs', 'all'], env);
    expect(o.out).toMatch(/Holm over 3 comparisons/);
    expect(o.out).toMatch(/^ {2}spike-first - moonbeam-first$/m);
    const s = runRun(['stars-ambush', '-n', '4'], env);
    expect(s.out).toMatch(/^arms +scenario \[reference\]$/m);
    expect(s.out).not.toMatch(/^PAIRED/m);
  });

  it('refuses flag combinations that mix one fight with a report', () => {
    const usage = (args: string[]) => {
      try {
        runRun(args, env);
        return '';
      } catch (e) {
        return (e as Error).message;
      }
    };
    expect(usage(['stars-ambush', '-n', '0'])).toMatch(/-n needs at least 1/);
    expect(usage(['stars-ambush', '--policy', 'greedy,greedy'])).toMatch(/lists greedy twice/);
    expect(usage(['stars-ambush', '-n', '5', '--run', '3'])).toMatch(/are for one fight/);
    expect(usage(['stars-ambush', '-n', '5', '--journal', 'x.yaml'])).toMatch(/are for one fight/);
    expect(usage(['stars-ambush', '-n', '1', '--policy', 'greedy,moonbeam-first'])).toMatch(/one fight plays one policy/);
    // No -n given: the message names the one-fight flag, not an -n to drop.
    expect(usage(['stars-ambush', '--policy', 'greedy,moonbeam-first', '--run', '3'])).toBe('--run is for one fight, and one fight plays one policy: give one --policy, or drop --run to compare several');
    expect(usage(['stars-ambush', '--policy', 'greedy,moonbeam-first', '--explain', 'pc1', '--run', '3'])).toMatch(/^--run, --explain are for one fight/);
    expect(usage(['stars-ambush', '--policy', 'greedy,moonbeam-first', '-n', '1', '--run', '3'])).toBe('--run is for one fight, and one fight plays one policy: give one --policy, or drop --run and -n 1 to compare several');
    expect(usage(['stars-ambush', '--pairs', 'all'])).toMatch(/--pairs is for a Monte Carlo report/);
    expect(usage(['stars-ambush', '-n', '20', '--chunk', '5000'])).toMatch(/--chunk needs a whole number from 0 to 1000/);
    expect(usage(['stars-ambush', '-n', '50', '--until-ci', '0.05'])).toMatch(/for an adaptive run; drop -n/);
    expect(usage(['stars-ambush', '--policy', 'greedy', '--until-ci', '2'])).toMatch(/--until-ci needs a half-width/);
    expect(usage(['stars-ambush', '--policy', 'greedy', '--max-n', '500'])).toMatch(/--max-n needs at least 1000/);
    expect(usage(['stars-ambush', '--policy', 'greedy', '--chunk', '300'])).toMatch(/divides 1,000/);
    expect(usage(['stars-ambush', '-n', '5', '--pairs', 'some'])).toMatch(/--pairs takes ref or all/);
  });

  it.runIf(SLOW)('adaptive: --policy without -n stops at a checkpoint and says so', { timeout: 300_000 }, () => {
    const o = runRun(['scenarios/perf/ambush-probe.yaml', '--policy', 'baseline,random-legal', '--until-ci', '0.04'], env);
    expect(o.code).toBe(0);
    expect(o.out).toMatch(/\| n 1,000 \(adaptive: stopped at checkpoint 1 \(every arm's win CI within ±4\.0%\)\)/);
  });
});
