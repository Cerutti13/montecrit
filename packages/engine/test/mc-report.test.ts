// The Monte Carlo report's numbers (docs/design/m1c.md 5): each statistic recomputed directly
// from the accumulators, and the text independent of how the runs were chunked.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../src/content/load.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import { DEFAULT_WEIGHTS, GREEDY_VERSION, weightsHash } from '../src/decide/greedy/weights.ts';
import { BUILTIN_POLICIES, compilePolicy } from '../src/decide/policy.ts';
import { reportModel } from '../src/mc/model.ts';
import { computeReport, renderReport, type ReportMeta } from '../src/mc/report.ts';
import { resolveScenario } from '../src/scenario/resolve.ts';
import { OUT, runArms, type ArmSpec } from '../src/mc/runner.ts';
import { mcnemarExact, nearestRank, newcombePaired, wilson } from '../src/mc/stats.ts';
import { ENGINE_VERSION } from '../src/version.ts';
import { loadScenario } from './helpers/scenario.ts';

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
const AMBUSH = loadScenario('scenarios/stars-ambush.yaml', loaded.content);
const mb = compilePolicy(parse(readFileSync(join(ROOT, 'policies', 'moonbeam-first.yaml'), 'utf8'))).policy!;
const ARMS: ArmSpec[] = [
  { label: 'greedy', setup: AMBUSH, policy: BUILTIN_POLICIES[0]! },
  { label: 'moonbeam-first', setup: AMBUSH, policy: mb },
];
const META: ReportMeta = { seed: 5, replay: 'montecrit run scenarios/stars-ambush.yaml --seed 5', fileNote: null, adaptive: false, checkpoint: null, hitCap: false, untilCi: 0.01, pairs: 'ref', verbose: false };
const N = 24;
const merged = runArms(ARMS, 5, { n: N, chunkSize: 8 }).merged;
const sum = (xs: ArrayLike<number>) => Array.from(xs).reduce((s, x) => s + x, 0);

describe('report statistics', () => {
  const stats = computeReport(ARMS, merged, META);

  it('rates, CIs, ratios and quantiles equal a direct recomputation from the accumulators', () => {
    merged.arms.forEach((a, k) => {
      const s = stats.arms[k]!;
      expect([s.win.x, s.loss.x, s.stalemate.x, s.pcDrop.x, s.winPcDown.x]).toEqual([a.win, a.loss, a.stalemate, a.pcDrop, a.winPcDown]);
      expect({ lo: s.win.lo, hi: s.win.hi }).toEqual(wilson(a.win, N));
      expect(s.dprPc.value).toBe(sum(a.Dpc) / sum(a.R));
      expect(s.dprParty.value).toBe(sum(a.Dparty) / sum(a.R));
      expect(s.uptime.value).toBe(sum(a.concT) / sum(a.turnsPc));
      expect(s.pcPerTurn.value).toBe(sum(a.Dpc) / sum(a.turnsPc));
      expect(s.rounds.p50).toBe(nearestRank(a.R.slice().sort(), 50));
      expect(s.dprPc.lo).toBeLessThanOrEqual(s.dprPc.value);
      expect(s.dprPc.hi).toBeGreaterThanOrEqual(s.dprPc.value);
    });
  });

  it('the paired row counts discordant runs from the per-run outcomes, other minus reference', () => {
    const [g, m] = merged.arms;
    let b = 0;
    let c = 0;
    for (let i = 0; i < N; i++) {
      const wg = (g!.out[i]! & OUT.mask) === OUT.win;
      const wm = (m!.out[i]! & OUT.mask) === OUT.win;
      if (wm && !wg) b++;
      if (wg && !wm) c++;
    }
    const p = stats.pairs[0]!;
    expect([p.ref, p.other, p.b, p.c]).toEqual([0, 1, b, c]);
    expect(p.diff).toBe((b - c) / N);
    expect(p.p).toBe(mcnemarExact(b, c));
    expect(p.holm).toBe(p.p);
    expect(p.lo).toBe(newcombePaired(p.a, b, c, p.d).lo);
  });

  it('the text depends only on the runs: one chunk or many, the report is the same', () => {
    const one = renderReport(ARMS, runArms(ARMS, 5, { n: N, chunkSize: N }).merged, META);
    const many = renderReport(ARMS, merged, META);
    // The header names the chunk layout it ran with; nothing else may differ.
    expect(one[0]!.replace(/chunks \S+$/, '')).toBe(many[0]!.replace(/chunks \S+$/, ''));
    expect([one[0]!.endsWith('chunks 1x24'), many[0]!.endsWith('chunks 3x8')]).toEqual([true, true]);
    expect(one.slice(1)).toEqual(many.slice(1));
  });

  it('with two PCs, deaths by cause and a rule\'s "taken" count runs, never seats: a direct recount, at most n, no NaN', () => {
    const doc = {
      kind: 'scenario', id: 'twopc', name: 'Two PCs', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: { w: 12, h: 12 }, knobs: { downEnds: false, maxRounds: 8 },
      units: [
        { seat: 'pc1', team: 'party', use: 'test:sample-druid', at: 'F10', surprised: true },
        { seat: 'pc2', team: 'party', use: 'test:sample-druid', at: 'G10', surprised: true },
        ...['D4', 'I4', 'B7', 'K7'].map((at, i) => ({ seat: `boss${i + 1}`, team: 'enemies', use: 'srd:goblin-boss', at })),
        ...['C2', 'J2', 'F5', 'H5'].map((at, i) => ({ seat: `gob${i + 1}`, team: 'enemies', use: 'srd:goblin-warrior', at })),
      ],
    };
    const two = resolveScenario(doc, 'twopc.yaml', loaded.content!).setup!;
    const arms: ArmSpec[] = [{ label: 'moonbeam-first', setup: two, policy: mb }];
    const n = 120; // enough fights for one where both PCs die the same way, however greedy plays
    const pcs = two.seats.map((x, i) => (x.tpl.kind === 'pc' ? i : -1)).filter((i) => i >= 0);
    const byCause = [0, 0, 0];
    let both = 0; // runs where both PCs died the same way: what summing over seats double-counted
    let taken = 0;
    const r = runArms(arms, 11, { n, chunkSize: 10, onFight: (_k, _i, f) => {
      const died = pcs.filter((u) => f.counters.death[u]! > 0).map((u) => f.counters.death[u]! - 1);
      const causes = new Set(died);
      for (const c of causes) byCause[c]!++;
      if (died.length > causes.size) both++;
    } });
    const st = computeReport(arms, r.merged, META).arms[0]!;
    expect(st.pcDeaths).toEqual(byCause);
    for (const x of st.pcDeaths) expect(x).toBeLessThanOrEqual(n);
    expect(both, 'some run where both PCs died the same way').toBeGreaterThan(0);
    taken = r.merged.arms[0]!.script[0]!;
    expect(taken).toBeLessThanOrEqual(n);
    const text = renderReport(arms, r.merged, META).join('\n');
    expect(text).not.toMatch(/NaN/);
    expect(text).toMatch(/PC deaths by cause count runs where some PC died that way/);
  }, 30_000);

  it('the calibration line: STALE when the engine, the AI or its weights changed; "a different setup" when the scenario or content hashes differ', () => {
    const base = { engine: ENGINE_VERSION, weights: weightsHash(DEFAULT_WEIGHTS), ai: GREEDY_VERSION, scenarioHash: AMBUSH.scenarioHash, contentHash: AMBUSH.contentHash, policy: 'greedy', seed: 7, runs: 4000, win: 0.7 };
    const line = (cal: typeof base) => {
      const arms = ARMS.map((a) => ({ ...a, setup: { ...AMBUSH, calibrated: cal } }));
      return renderReport(arms, merged, META).find((l) => /^notes +calibrated:/.test(l))!;
    };
    expect(line(base)).not.toMatch(/STALE|different setup/);
    expect(line({ ...base, ai: GREEDY_VERSION - 1 })).toMatch(/ -- STALE: the engine, the greedy AI or its default weights changed since$/);
    expect(line({ ...base, weights: '00000000' })).toMatch(/STALE/);
    expect(line({ ...base, engine: '0.0.1' })).toMatch(/STALE/);
    expect(line({ ...base, scenarioHash: '0123456789abcdef' })).toMatch(/ -- measured on a different setup \(scenario 0123456789abcdef, content [0-9a-f]{16}\), not this one$/);
    expect(line({ ...base, contentHash: '0123456789abcdef' })).toMatch(/different setup/);
    expect(line({ ...base, contentHash: '0123456789abcdef' })).not.toMatch(/STALE/);
  });
});

describe('report model (docs/design/m2.md 5.1)', () => {
  const model = reportModel(ARMS, merged);
  it('its tables add up: every histogram covers every fight, each damage row totals its rounds plus later', () => {
    expect(model.arms).toHaveLength(ARMS.length);
    for (const [k, m] of model.arms.entries()) {
      expect(m.label).toBe(merged.arms[k]!.label);
      expect(sum(m.roundsHist)).toBe(N);
      expect(sum(m.dprBins.map((b) => b.count))).toBe(N);
      expect(sum(m.dprFine.map((b) => b.count))).toBe(N);
      expect(m.dprBins.at(-1)!.hi).toBeNull();
      expect(m.damage).toHaveLength(model.damageRows.length);
      for (const d of m.damage) {
        expect(d.perRound).toHaveLength(model.lastRound);
        expect(d.total).toBeCloseTo(d.perRound.reduce((x, y) => x + y, 0) + d.later, 12);
      }
      expect(m.reached).toHaveLength(model.lastRound);
    }
    expect(model.damageRows.some((r) => r.group === 'enemy')).toBe(true);
  });
  it('the text formats the model it is given (so the text and the Results screen cannot drift apart)', () => {
    const stats = computeReport(ARMS, merged, META);
    expect(renderReport(ARMS, merged, META, stats, model)).toEqual(renderReport(ARMS, merged, META));
    // A changed model shows up in the text: rows, rounds and concentration come from it.
    const row = model.damageRows.findIndex((r) => r.group === 'enemy');
    const marked = {
      ...model,
      damageRows: model.damageRows.map((r, j) => (j === row ? { ...r, label: 'MARKED-ROW' } : r)),
      arms: model.arms.map((m) => ({ ...m, roundsHist: m.roundsHist.map((x, r) => (r === 3 ? 777 : x)), concStartsPerFight: 9.87 })),
    };
    const text = renderReport(ARMS, merged, META, stats, marked).join('\n');
    expect(text).toContain('MARKED-ROW');
    expect(text).toMatch(/fights by length .*3:777/);
    expect(text).toContain('starts 9.87/fight');
  });
});
