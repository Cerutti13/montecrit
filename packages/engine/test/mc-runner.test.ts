// The Monte Carlo runner (docs/design/m1c.md 4, 8): merge identity across chunk sizes, worker
// counts and finishing orders; fresh deciders per fight (critique resolution 7); common random
// numbers; arm validation; the stopping rule; exemplar keys. The fast suite runs these small;
// MONTECRIT_SLOW=1 runs the merge identity at the design's scale (2 arms x 2,000 runs, 1/3/8 workers).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../src/content/load.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import { makeDeciders } from '../src/decide/make.ts';
import { BUILTIN_POLICIES, compilePolicy, type CompiledPolicy } from '../src/decide/policy.ts';
import { afterMerge, exemplars, maxWinHalfWidth, mergeInto, newMerged, OUT, pairCounts, resolveSchedule, runArms, runChunk, validateArms, type ArmAcc, type ArmSpec, type ChunkResult, type RunOptions } from '../src/mc/runner.ts';
import { runFight } from '../src/sim/fight.ts';
import type { FightSetup } from '../src/sim/setup.ts';
import { loadScenario } from './helpers/scenario.ts';

const SLOW = !!process.env.MONTECRIT_SLOW;
const ROOT = join(import.meta.dirname, '..', '..', '..');
const walk = (d: string): string[] =>
  readdirSync(d)
    .flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.yaml') ? [p] : [];
    })
    .sort();
const readPack = (name: string): SourceFile[] => walk(join(ROOT, 'packs', name)).map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, 'utf8') }));
const loaded = loadContent([...readPack('srd-5.2.1'), ...readPack('test')]);
if (!loaded.content) throw new Error(loaded.errors.map(formatDiag).join('\n'));
const CONTENT = loaded.content;
const PROBE = loadScenario('scenarios/perf/ambush-probe.yaml', CONTENT);
const AMBUSH = loadScenario('scenarios/stars-ambush.yaml', CONTENT);

const builtin = (id: string): CompiledPolicy => BUILTIN_POLICIES.find((p) => p.id === id)!;
const repoPolicy = (id: string): CompiledPolicy => compilePolicy(parse(readFileSync(join(ROOT, 'policies', `${id}.yaml`), 'utf8'))).policy!;
const reseat = (s: FightSetup, seat: string, over: object): FightSetup => ({ ...s, seats: s.seats.map((x) => (x.seat === seat ? { ...x, ...over } : x)) });

/** Deterministic shuffle (an LCG; the test only needs some fixed non-trivial order). */
function shuffled<T>(xs: T[], salt: number): T[] {
  const out = xs.slice();
  let s = (salt * 2654435761) >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * W simulated workers: worker w owns chunks k with k mod W = w and computes them in a shuffled
 * order; results arrive interleaved across workers and are buffered until they can merge in
 * chunkIdx order, as M2's pool will do.
 */
function mergeAsWorkers(arms: readonly ArmSpec[], seed: number, n: number, chunkSize: number, W: number) {
  const chunks = Math.ceil(n / chunkSize);
  const queues = Array.from({ length: W }, (_, w) =>
    shuffled(
      Array.from({ length: chunks }, (_, k) => k).filter((k) => k % W === w),
      w + 1,
    ),
  );
  const m = newMerged(arms, chunkSize);
  const buffer: (ChunkResult | undefined)[] = [];
  for (let step = 0; queues.some((q) => q.length > 0); step++) {
    const q = queues[step % W]!;
    const k = q.shift();
    if (k === undefined) continue;
    buffer[k] = runChunk(arms, seed, k, n, chunkSize);
    while (buffer[m.nextChunk]) mergeInto(m, buffer[m.nextChunk]!);
  }
  expect(m.n).toBe(n);
  return m;
}

describe('runner: merge identity', () => {
  const arms: ArmSpec[] = [
    { label: 'baseline', setup: PROBE, policy: builtin('baseline') },
    { label: 'random', setup: PROBE, policy: builtin('random-legal') },
  ];
  // [chunk size, workers], each compared with one process running chunks of the first size in order.
  const n = SLOW ? 2000 : 90;
  const base = SLOW ? 250 : 15;
  const combos: [number, number][] = SLOW ? [[250, 3], [250, 8], [100, 1]] : [[15, 3], [25, 2]];

  it(`gives deep-equal arms whatever the chunk size, worker count or finishing order (${n} runs, ${combos.map(([c, w]) => `${c}x${w}`).join(', ')} vs ${base}x1)`, { timeout: SLOW ? 300_000 : 20_000 }, () => {
    const ref = runArms(arms, 7, { n, chunkSize: base }).merged;
    expect(ref.arms[0]!.n).toBe(n);
    for (const [size, W] of combos) expect(mergeAsWorkers(arms, 7, n, size, W).arms, `chunk ${size}, ${W} workers`).toEqual(ref.arms);
  });

  it('refuses chunks out of order', () => {
    const m = newMerged(arms, 20);
    expect(() => mergeInto(m, runChunk(arms, 7, 1, 40, 20))).toThrow(/chunk 1 arrived when chunk 0 was next/);
  });
});

describe('runner: greedy on every seat (critique resolution 7)', () => {
  const twin = builtin('greedy');
  const arms: ArmSpec[] = [
    { label: 'greedy', setup: AMBUSH, policy: twin },
    { label: 'greedy-twin', setup: AMBUSH, policy: twin },
    { label: 'moonbeam-first', setup: AMBUSH, policy: repoPolicy('moonbeam-first') },
  ];
  const n = 16;
  const a = runArms(arms, 11, { n, chunkSize: 4 }).merged;

  it('chunk size changes nothing, and each run equals a standalone fight with fresh deciders', () => {
    const b = runArms(arms, 11, { n, chunkSize: n }).merged;
    expect(b.arms).toEqual(a.arms);
    const pc = AMBUSH.seats.findIndex((s) => s.tpl.kind === 'pc');
    for (const run of [0, 5, 11, 15]) {
      for (const [k, arm] of arms.entries()) {
        const r = runFight(AMBUSH, 11, run, makeDeciders(AMBUSH, [], undefined, arm.policy), null);
        const acc = a.arms[k]!;
        const S = r.counters.layout.sources.length;
        let dpc = 0;
        // PC damage to the other side: friendly fire is counted on its own.
        r.counters.dmgEff.forEach((d, i) => (dpc += r.counters.layout.sources[i % S]!.owner === pc ? d - r.counters.ffEff[i]! : 0));
        const out = r.outcome.k === 'win' ? OUT.win : r.outcome.k === 'loss' ? OUT.loss : OUT.stalemate;
        expect([acc.out[run]! & OUT.mask, acc.R[run], acc.Dpc[run], acc.pcHpEnd[run]], `${arm.label} run ${run}`).toEqual([out, r.outcome.round, dpc, Math.max(0, r.hp[pc]!)]);
      }
    }
  });

  it('identical arms pair perfectly (common random numbers): b = c = 0 and equal per-run arrays', () => {
    const [g, t] = a.arms as [ArmAcc, ArmAcc];
    expect(pairCounts(g, t)).toEqual({ a: g.win, b: 0, c: 0, d: n - g.win });
    for (const k of ['out', 'R', 'Dpc', 'Dparty', 'concT', 'turnsPc', 'foeHpLeft', 'foeHpMax', 'pcHpEnd'] as const) expect(t[k], k).toEqual(g[k]);
  });

  it('accumulators agree with each other and with the per-run arrays', () => {
    for (const acc of a.arms) {
      const sum = (xs: ArrayLike<number>) => Array.from(xs).reduce((s, x) => s + x, 0);
      expect(acc.win + acc.loss + acc.stalemate).toBe(n);
      expect(sum(acc.roundsHist)).toBe(n);
      expect(acc.reached[0]).toBe(n);
      expect(sum(acc.R)).toBe(acc.sumR);
      expect(sum(Array.from(acc.R, (r) => r * r))).toBe(acc.sumR2);
      expect(sum(acc.dprHist)).toBe(n);
      expect(Array.from(acc.out).filter((o) => o & OUT.pcDrop).length).toBe(acc.pcDrop);
      expect(Array.from(acc.out).filter((o) => (o & OUT.mask) === OUT.win && o & OUT.pcDrop).length).toBe(acc.winPcDown);
      const pc = AMBUSH.seats.findIndex((s) => s.tpl.kind === 'pc');
      expect(acc.dropRuns[pc]).toBe(acc.pcDrop);
      expect(sum(acc.concT)).toBe(acc.concTurns[pc]);
      expect(sum(acc.turnsPc)).toBe(acc.turns[pc]);
    }
    // The scripted opener fires in (nearly) every fight the PC gets a turn in; greedy has no script.
    expect(a.arms[2]!.script[0]).toBeGreaterThan(n / 2);
    expect(a.arms[0]!.script.length).toBe(0);
  });
});

describe('runner: arm validation', () => {
  const g = builtin('greedy');
  it('accepts arms that differ only in the policy', () => {
    expect(validateArms([{ label: 'a', setup: AMBUSH, policy: g }, { label: 'b', setup: AMBUSH, policy: repoPolicy('moonbeam-first') }])).toEqual([]);
  });

  it('refuses a mismatched non-policy decider, a different scenario, a seat a journal would need, duplicate labels and a policy that plays other seats', () => {
    const why = (arms: ArmSpec[]) => validateArms(arms).join('\n');
    expect(why([{ label: 'a', setup: AMBUSH, policy: g }, { label: 'b', setup: reseat(AMBUSH, 'gob1', { decider: 'baseline' }), policy: g }])).toMatch(/seat gob1: decider baseline in arm b but greedy in arm a/);
    expect(why([{ label: 'a', setup: AMBUSH, policy: g }, { label: 'b', setup: PROBE, policy: g }])).toMatch(/scenario ambush-probe .* differs/);
    expect(why([{ label: 'a', setup: reseat(AMBUSH, 'gob2', { decider: 'journal', fallback: null }), policy: g }])).toMatch(/seat gob2 is decider journal with no fallback/);
    expect(why([{ label: 'a', setup: AMBUSH, policy: g }, { label: 'a', setup: AMBUSH, policy: g }])).toMatch(/two arms are labelled "a"/);
    const party = compilePolicy({ kind: 'policy', id: 'party', name: 'Party', seats: 'party', base: 'greedy' }).policy!;
    expect(why([{ label: 'a', setup: AMBUSH, policy: g }, { label: 'b', setup: AMBUSH, policy: party }])).toMatch(/seat ally1: played by the policy in arm b but not in arm a/);
    expect(() => runArms([{ label: 'a', setup: AMBUSH, policy: g }, { label: 'b', setup: reseat(AMBUSH, 'gob1', { decider: 'baseline' }), policy: g }], 1, { n: 1 })).toThrow(/gob1/);
  });
});

describe('runner: stopping rule', () => {
  const arms: ArmSpec[] = [{ label: 'scenario', setup: PROBE, policy: null }];

  it('a fixed n runs exactly n, with a short last chunk', () => {
    const r = runArms(arms, 3, { n: 45, chunkSize: 20 });
    expect([r.adaptive, r.checkpoint, r.merged.n, r.merged.nextChunk, r.merged.arms[0]!.out.length]).toEqual([false, null, 45, 3, 45]);
  });

  it('adaptive: stops at the first checkpoint at or past the minimum where the win half-width meets the target', () => {
    const seen: [number, number][] = [];
    const r = runArms(arms, 3, { untilCi: 0.15, checkpoint: 20, minN: 20, chunkSize: 10, maxN: 400, onMerge: (m) => seen.push([m.n, maxWinHalfWidth(m)]) });
    const checks = seen.filter(([k]) => k % 20 === 0);
    expect(r.hitCap).toBe(false);
    expect(checks.at(-1)![1]).toBeLessThanOrEqual(0.15);
    for (const [, h] of checks.slice(0, -1)) expect(h).toBeGreaterThan(0.15);
    expect(r.checkpoint).toBe(r.merged.n / 20);
    expect(seen.at(-1)![0]).toBe(r.merged.n);
  });

  it('adaptive: an unreachable target stops at the cap; a chunk size that misses the checkpoints is refused', () => {
    const r = runArms(arms, 3, { untilCi: 1e-6, checkpoint: 20, minN: 20, chunkSize: 10, maxN: 30 });
    expect([r.hitCap, r.merged.n, r.checkpoint]).toEqual([true, 30, 2]);
    expect(() => runArms(arms, 3, { chunkSize: 300 })).toThrow(/divides the checkpoint spacing 1000/);
  });
});

describe('runner: one arm per task (docs/design/m2.md 2.2)', () => {
  // M2's pool runs (chunk k, arm a) tasks: runChunk([arms[a]]) must be exactly arm a of runChunk(arms).
  const cases: [string, ArmSpec[]][] = [
    ['probe', [{ label: 'scenario', setup: PROBE, policy: null }, { label: 'random', setup: PROBE, policy: builtin('random-legal') }]],
    ['stars-ambush', [{ label: 'greedy', setup: AMBUSH, policy: null }, { label: 'moonbeam-first', setup: AMBUSH, policy: repoPolicy('moonbeam-first') }]],
  ];
  for (const [name, arms] of cases) {
    it(`${name}: each arm alone deep-equals its slot in the all-arms chunk, short last chunk included`, { timeout: 30_000 }, () => {
      for (const k of [0, 2]) {
        const all = runChunk(arms, 11, k, 25, 10);
        arms.forEach((a, i) => expect(runChunk([a], 11, k, 25, 10).arms[0]).toEqual(all.arms[i]));
      }
    });
  }
});

describe('runner: the stopping rule, written once (docs/design/m2.md 2.1)', () => {
  const arms: ArmSpec[] = [{ label: 'greedy', setup: PROBE, policy: builtin('greedy') }, { label: 'random', setup: PROBE, policy: builtin('random-legal') }];
  // The loop runArms ran before resolveSchedule/afterMerge, verbatim in effect: the reference.
  function before(seed: number, o: RunOptions) {
    const chunkSize = o.chunkSize!;
    const m = newMerged(arms, chunkSize);
    const total = o.n ?? o.maxN!;
    for (let k = 0; m.n < total; k++) {
      mergeInto(m, runChunk(arms, seed, k, total, chunkSize));
      if (o.n === undefined && m.n % o.checkpoint! === 0 && m.n >= o.minN! && maxWinHalfWidth(m) <= o.untilCi!) return { n: m.n, checkpoint: m.n / o.checkpoint!, hitCap: false };
    }
    return { n: m.n, checkpoint: o.n === undefined ? Math.ceil(m.n / o.checkpoint!) : null, hitCap: o.n === undefined };
  }
  it('stops where the pre-refactor loop stopped: adaptive on 3 seeds, a capped run and a fixed n', { timeout: 60_000 }, () => {
    const opts: RunOptions[] = [
      { untilCi: 0.12, checkpoint: 20, minN: 40, chunkSize: 10, maxN: 300 },
      { untilCi: 1e-6, checkpoint: 20, minN: 20, chunkSize: 10, maxN: 50 },
      { n: 37, chunkSize: 10 },
    ];
    for (const seed of [1, 2, 3]) {
      for (const o of opts) {
        const r = runArms(arms, seed, o);
        expect({ n: r.merged.n, checkpoint: r.checkpoint, hitCap: r.hitCap }).toEqual(before(seed, o));
      }
    }
  });
  it('afterMerge says stop exactly once, at the merge runArms stops at', { timeout: 30_000 }, () => {
    const o: RunOptions = { untilCi: 0.12, checkpoint: 20, minN: 40, chunkSize: 10, maxN: 300 };
    const s = resolveSchedule(arms, o);
    const m = newMerged(arms, s.chunkSize);
    let stopAt = -1;
    for (let k = 0; stopAt < 0; k++) {
      mergeInto(m, runChunk(arms, 2, k, s.total, s.chunkSize));
      if (afterMerge(s, m)) stopAt = m.n;
    }
    expect(stopAt).toBe(runArms(arms, 2, o).merged.n);
  });
  it('resolveSchedule refuses what runArms refuses, with the same messages', () => {
    expect(() => resolveSchedule(arms, { chunkSize: 300 })).toThrow(/divides the checkpoint spacing 1000/);
    expect(() => resolveSchedule(arms, { chunkSize: 0 })).toThrow(/chunk size must be a positive integer/);
    expect(() => resolveSchedule(arms, { n: 0 })).toThrow(/runs must be an integer/);
    expect(() => resolveSchedule([arms[0]!, arms[0]!], { n: 5 })).toThrow();
  });
});

describe('runner: exemplars', () => {
  // A hand-built accumulator: only the per-run arrays exemplars reads.
  const acc = (rows: [number, number, number, number, number][]) =>
    ({
      n: rows.length,
      out: Uint8Array.from(rows, (r) => r[0]),
      R: Uint16Array.from(rows, (r) => r[1]),
      foeHpLeft: Uint16Array.from(rows, (r) => r[2]),
      foeHpMax: Uint16Array.from(rows, (r) => r[3]),
      pcHpEnd: Int16Array.from(rows, (r) => r[4]),
    }) as unknown as ArmAcc;
  const L = OUT.loss;
  const W = OUT.win;

  it('closest loss: smallest enemy HP fraction by cross-multiplication, then more rounds, then the earlier run', () => {
    // 3/30 = 1/10 = 2/20: runs 1, 2 and 4 tie on the fraction; run 2 lasted longest; run 4 ties run 2 and comes later.
    const e = exemplars(acc([[L, 5, 10, 30, 0], [L, 4, 3, 30, 0], [L, 7, 2, 20, 0], [W, 3, 0, 30, 9], [L, 7, 1, 10, 0], [OUT.stalemate, 20, 1, 100, 5]]));
    expect(e.closestLoss).toBe(2);
    expect(exemplars(acc([[W, 3, 0, 30, 9]])).closestLoss).toBe(-1);
  });

  it('typical win: nearest the median rounds, then the median PC HP, then the earlier run; TPK and PC death are the first such runs', () => {
    // Wins' rounds 3,4,4,6,9 (median 4); HP 5,12,8,8,1 (median 8). Runs 1 and 2 have R = 4; run 2 has HP 8.
    const e = exemplars(acc([[W, 3, 0, 9, 5], [W, 4, 0, 9, 12], [W, 4, 0, 9, 8], [L | OUT.tpk | OUT.pcDied, 2, 5, 9, 0], [W, 6, 0, 9, 8], [W, 9, 0, 9, 1], [L | OUT.pcDied, 3, 4, 9, 0]]));
    expect(e).toEqual({ closestLoss: 6, typicalWin: 2, tpk: 3, pcDeath: 3 });
  });
});
