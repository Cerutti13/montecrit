// The worker pool's scheduler (docs/design/m2.md 2.6, 7.3): for any worker count, any ahead
// window and any reply order, the merged runs are exactly runArms's (byte-equal report JSON, equal
// acc hash, deep-equal accumulators), fixed and adaptive. Plus the edges: the buffer bound, cancel,
// a worker error or crash, a stale reply, a short accumulator, a hash mismatch at ready, calls.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkReplay, computeReport, exemplars, runArms, type ReportMeta, type SourceFile } from '@montecrit/engine';
import { accHash, buildArms, Cancelled, openSession, PoolError, reportJson, selectKnown, type Job, type PlayReply, type Progress, type ReportReply } from '../src/index.ts';
import { testTransport, type TestOptions, type TestTransport } from './helpers/transport.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const listing = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((p) => p !== '');
const sel = selectKnown(listing);
const text = (p: string): SourceFile => ({ path: `repo/${p}`, text: readFileSync(join(ROOT, p), 'utf8') });
const PROBE = 'scenarios/perf/ambush-probe.yaml';

function job(run: Job['run'], seed = 3): Job {
  return {
    v: 1,
    packs: sel.packs.map(text),
    scenario: { input: readFileSync(join(ROOT, PROBE), 'utf8'), path: `repo/${PROBE}` },
    policies: sel.policies.map(text),
    flags: {},
    knobs: {},
    arms: [
      { label: 'greedy', policy: 'greedy', hash: null },
      { label: 'random-legal', policy: 'random-legal', hash: null },
    ],
    seed,
    run,
    expect: null,
  };
}

const META = (seed: number): ReportMeta => ({ seed, replay: '', fileNote: null, adaptive: false, checkpoint: null, hitCap: false, untilCi: 0.01, pairs: 'ref', verbose: false });

/** The in-process reference: runArms over the same job. */
function reference(j: Job) {
  const b = buildArms(j);
  const run = runArms(b.arms, j.seed, j.run);
  return { arms: b.arms, run, json: reportJson(b.arms, run, j.seed, computeReport(b.arms, run.merged, META(j.seed))), acc: accHash(b.arms, run, j.seed) };
}

async function pooled(j: Job, W: number, ahead: number, opts: (i: number) => TestOptions = (i) => ({ salt: i + 1 })) {
  const ts: TestTransport[] = [];
  const s = await openSession(j, (i) => {
    const t = testTransport(opts(i));
    ts.push(t);
    return t;
  }, W, { ahead });
  const seen: Progress[] = [];
  const run = await s.run((p) => seen.push(p)).done;
  return { s, run, seen, ts, json: reportJson(s.arms, run, j.seed, computeReport(s.arms, run.merged, META(j.seed))), acc: accHash(s.arms, run, j.seed) };
}

const FIXED = job({ n: 237, chunkSize: 20 }); // 12 chunks, the last one short (17 runs)
const ADAPTIVE = job({ untilCi: 0.12, checkpoint: 40, minN: 40, chunkSize: 20, maxN: 400 });

describe('scheduler: the same runs as runArms for any worker count, window and reply order', () => {
  for (const [name, j] of [['fixed n (short last chunk)', FIXED], ['adaptive', ADAPTIVE]] as const) {
    it(name, { timeout: 120_000 }, async () => {
      const ref = reference(j);
      for (const [W, ahead] of [[1, 16], [2, 1], [3, 2], [8, 16], [8, 1]] as const) {
        const p = await pooled(j, W, ahead);
        expect(p.run.merged).toEqual(ref.run.merged);
        expect([p.run.adaptive, p.run.checkpoint, p.run.hitCap]).toEqual([ref.run.adaptive, ref.run.checkpoint, ref.run.hitCap]);
        expect(p.json).toBe(ref.json);
        expect(p.acc).toBe(ref.acc);
        // The buffer never holds more than the window allows.
        for (const pr of p.seen) expect(pr.buffered).toBeLessThanOrEqual(ahead * j.arms.length);
        expect(p.seen.at(-1)!.merged).toBe(ref.run.merged.n);
        p.s.close();
      }
    });
  }
});

describe('scheduler: edges', () => {
  it('a transport that answers inside send() still gets every task exactly once', { timeout: 60_000 }, async () => {
    const ref = reference(FIXED);
    const p = await pooled(FIXED, 3, 2, () => ({ sync: true }));
    expect(p.json).toBe(ref.json);
    const tasks = p.ts.flatMap((t) => t.sent.filter((m) => m.t === 'task').map((m) => `${(m as { k: number }).k}/${(m as { arm: number }).arm}`));
    expect(new Set(tasks).size).toBe(tasks.length);
    expect(tasks).toHaveLength(12 * 2);
  });


  it('cancel rejects with Cancelled, closes every worker, and reports nothing after', { timeout: 60_000 }, async () => {
    const ts: TestTransport[] = [];
    const s = await openSession(FIXED, (i) => {
      const t = testTransport({ salt: i + 1 });
      ts.push(t);
      return t;
    }, 3);
    let after = 0;
    let cancelled = false;
    const h = s.run(() => {
      if (cancelled) after++;
      else {
        cancelled = true;
        h.cancel();
      }
    });
    await expect(h.done).rejects.toBeInstanceOf(Cancelled);
    for (let i = 0; i < 50; i++) await null;
    expect(after).toBe(0);
    expect(ts.every((t) => t.closed())).toBe(true);
    h.cancel(); // idempotent
  });

  it('a worker error rejects the run, naming the arm and the chunk; a crash does too', { timeout: 60_000 }, async () => {
    const s = await openSession(FIXED, (i) => testTransport({ salt: i + 1, rewrite: (r, m) => (i === 1 && m.t === 'task' && m.k >= 2 ? { t: 'error', gen: m.gen, message: 'boom', stack: 'at somewhere' } : r) }), 2);
    const e = await s.run().done.catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PoolError);
    expect((e as PoolError).message).toMatch(/^worker 1 \((greedy|random-legal), chunk \d+\): boom$/);
    expect((e as PoolError).detail).toBe('at somewhere');
    await expect(s.call({ op: 'play', arm: 0, run: 0, explain: null, fileNotes: [] })).rejects.toBe(e);

    const ts: TestTransport[] = [];
    const s2 = await openSession(FIXED, (i) => {
      const t = testTransport({ salt: i + 1, maxHops: 40 });
      ts.push(t);
      return t;
    }, 2);
    const h = s2.run((p) => {
      if (p.chunksMerged === 1) ts[0]!.crash('exit 1');
    });
    await expect(h.done).rejects.toThrow(/stopped \(exit 1\)/);
  });

  it('drops a stale reply (an older gen) and refuses a short accumulator', { timeout: 60_000 }, async () => {
    const ref = reference(FIXED);
    const stale = await pooled(FIXED, 2, 16, (i) => ({ salt: i + 1, rewrite: (r) => (r.t === 'chunk' ? [{ ...r, gen: r.gen - 1, acc: { ...r.acc, n: 999 } }, r] : r) }));
    expect(stale.json).toBe(ref.json);
    const s = await openSession(FIXED, (i) => testTransport({ salt: i + 1, rewrite: (r) => (r.t === 'chunk' && r.k === 1 ? { ...r, acc: { ...r.acc, n: r.acc.n - 1 } } : r) }), 2);
    await expect(s.run().done).rejects.toThrow(/came back with 19 runs .* expected 20/);
  });

  it('a worker reporting other hashes at ready stops the session before it runs', async () => {
    await expect(openSession(FIXED, (i) => testTransport({ rewrite: (r) => (i === 2 && r.t === 'ready' ? { ...r, contentHash: '0000000000000000' } : r) }), 3)).rejects.toThrow(/worker 2: the scenario or content changed under the run/);
  });

  it('after a cancel took every worker, a call respawns one and works', { timeout: 60_000 }, async () => {
    const ts: TestTransport[] = [];
    const s = await openSession(FIXED, (i) => {
      const t = testTransport({ salt: i + 1 });
      ts.push(t);
      return t;
    }, 2);
    const h = s.run(() => h.cancel());
    await expect(h.done).rejects.toBeInstanceOf(Cancelled);
    expect(ts.every((t) => t.closed())).toBe(true);
    const play = (await s.call({ op: 'play', arm: 0, run: 3, explain: null, fileNotes: [] })) as PlayReply;
    expect(ts).toHaveLength(3);
    expect(play.events[0]!.k).toBe('fightStart');
    s.close();
  });

  it('never hangs: a worker dying while another is still starting rejects the session; close() rejects a call whose worker is starting', async () => {
    const ts: TestTransport[] = [];
    const opening = openSession(FIXED, (i) => {
      const t = testTransport(i === 0 ? { delay: 1 } : { delay: 60 });
      ts.push(t);
      return t;
    }, 2);
    for (let k = 0; k < 5; k++) await null;
    ts[0]!.crash('exit 1');
    await expect(opening).rejects.toThrow(/worker 0: stopped \(exit 1\)/);

    const slow: TestTransport[] = [];
    const s = await openSession(FIXED, (i) => {
      const t = testTransport(i < 1 ? { salt: 1 } : { delay: 60 });
      slow.push(t);
      return t;
    }, 1);
    const h = s.run(() => h.cancel());
    await expect(h.done).rejects.toBeInstanceOf(Cancelled);
    const pending = s.call({ op: 'play', arm: 0, run: 0, explain: null, fileNotes: [] });
    for (let k = 0; k < 5; k++) await null;
    s.close();
    await expect(pending).rejects.toBeInstanceOf(Cancelled);
  });

  it('runs once; a call after a normal stop reuses the worker that delivered the last chunk', { timeout: 60_000 }, async () => {
    const ref = reference(FIXED);
    const p = await pooled(FIXED, 4, 16);
    const opened = p.ts.length;
    expect(() => p.s.run()).toThrow(/runs once/);
    const rep = (await p.s.call({ op: 'report', run: p.run, meta: META(FIXED.seed) })) as ReportReply;
    expect(rep.json).toBe(ref.json);
    expect(rep.accHash).toBe(ref.acc);
    expect(rep.text.join('\n')).toMatch(/^OUTCOMES/m);
    const ex = exemplars(p.run.merged.arms[0]!);
    const idx = [ex.closestLoss, ex.typicalWin, ex.pcDeath].find((x) => x >= 0)!;
    expect(idx).toBeGreaterThanOrEqual(0);
    const play = (await p.s.call({ op: 'play', arm: 0, run: idx, explain: null, fileNotes: [] })) as PlayReply;
    expect(checkReplay(p.run.merged.arms[0]!, idx, play.oneRun, play.oneRunStateHash, play.end.stateHash)).toBeNull();
    expect(play.events[0]!.k).toBe('fightStart');
    expect(play.header[0]).toMatch(/^replay {3}engine/);
    await expect(p.s.call({ op: 'play', arm: 9, run: 0, explain: null, fileNotes: [] })).rejects.toThrow(/no arm 9/);
    expect(p.ts).toHaveLength(opened);
    p.s.close();
    await expect(p.s.call({ op: 'play', arm: 0, run: 0, explain: null, fileNotes: [] })).rejects.toBeInstanceOf(Cancelled);
  });
});
