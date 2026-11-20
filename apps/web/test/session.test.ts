// The browser's run orchestration (apps/web/src/run/session.ts): jobs built from texts, the
// CLI-equivalent replay command and file note, worker counts. The run itself is covered by the
// scheduler tests and, in the browser, by the dev self-test.
import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildJob, cliPath, reportMeta, workerCount, type RunRequest } from '../src/run/session.ts';
import { bundledSet } from '../src/content/select.ts';
import { catalog } from '../src/content/catalog.ts';
import { readScenarioInput } from '../../cli/src/files.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const set = bundledSet({
  '../../../../packs/srd-5.2.1/manifest.yaml': read('packs/srd-5.2.1/manifest.yaml'),
  '../../../../scenarios/a.yaml': 'kind: scenario\nid: a\nname: A\nrules: "2024"\npacks: [srd-5.2.1]\ngrid: { w: 4, h: 4 }\nunits: []\n',
  '../../../../scenarios/b.yaml': 'kind: scenario\nid: b\nextends: a\n',
  '../../../../policies/p.yaml': read('policies/moonbeam-first.yaml'),
});
const req = (over: Partial<RunRequest> = {}): RunRequest => ({ scenario: 'repo/scenarios/a.yaml', policies: ['greedy', 'moonbeam-first'], n: 100, untilCi: 0.01, seed: 7, ...over });

describe('run orchestration', () => {
  it('builds a job from texts: arms carry their policy hashes; adaptive carries the target', () => {
    const b = buildJob(set, req());
    expect(b.errors).toEqual([]);
    expect(b.job!.arms.map((a) => a.label)).toEqual(['greedy', 'moonbeam-first']);
    expect(b.job!.arms.every((a) => /^[0-9a-f]{8}$/.test(a.hash!))).toBe(true);
    expect(b.job!.run).toEqual({ n: 100, chunkSize: 250 });
    expect(buildJob(set, req({ n: null, untilCi: 0.02 })).job!.run).toEqual({ untilCi: 0.02, maxN: 100_000, chunkSize: 250 });
  });
  it('refuses a missing policy, a repeated one and none', () => {
    expect(buildJob(set, req({ policies: ['greedy', 'nope'] })).errors).toEqual(['no policy nope']);
    expect(buildJob(set, req({ policies: ['greedy', 'greedy'] })).errors).toEqual(['a policy is listed twice']);
    expect(buildJob(set, req({ policies: [] })).errors).toEqual(['give at least one policy']);
  });
  it('prints the CLI\'s replay command and file note from the repo root', () => {
    const run = { merged: {} as never, adaptive: false, checkpoint: null, hitCap: false };
    expect(reportMeta(req(), run, null, 'ref')).toMatchObject({ replay: 'montecrit run scenarios/a.yaml --seed 7', fileNote: null, pairs: 'ref' });
    const b = buildJob(set, req({ scenario: 'repo/scenarios/b.yaml' }));
    expect(b.base).toBe('repo/scenarios/a.yaml');
    expect(reportMeta(req({ scenario: 'repo/scenarios/b.yaml' }), run, b.base, 'all')).toMatchObject({ fileNote: 'scenario file: scenarios/b.yaml (extends scenarios/a.yaml)', pairs: 'all' });
    expect(cliPath('home/scenarios/x.yaml')).toBe('~/.montecrit/scenarios/x.yaml');
  });
  it('cover-archer-replay is on the list to run, on its golden base, with the CLI\'s scenario', () => {
    const packKeys = (dir: string) => readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' }).filter((p) => /\.ya?ml$/.test(p)).map((p) => join(dir, p).split(sep).join('/'));
    const raw: Record<string, string> = { '../../../../scenarios/cover-archer-replay.yaml': read('scenarios/cover-archer-replay.yaml') };
    for (const p of [...packKeys('packs/srd-5.2.1'), ...packKeys('packs/test')]) raw[`../../../../${p}`] = read(p);
    const real = bundledSet(raw, { '../../../../scenarios/golden/cover-archer.yaml': read('scenarios/golden/cover-archer.yaml') });
    const entries = catalog(real).scenarios;
    expect(entries.map((s) => s.path)).toEqual(['repo/scenarios/cover-archer-replay.yaml']);
    expect(entries[0]!.errors).toEqual([]);
    expect(entries[0]!.scenarioHash).toMatch(/^[0-9a-f]{16}$/);
    const b = buildJob(real, req({ scenario: 'repo/scenarios/cover-archer-replay.yaml', policies: ['greedy'] }));
    expect(b.errors).toEqual([]);
    expect(b.base).toBe('repo/scenarios/golden/cover-archer.yaml');
    const cli = readScenarioInput(join(ROOT, 'scenarios/cover-archer-replay.yaml'), ROOT);
    expect(cli.errors).toEqual([]);
    expect(b.job!.scenario.input).toEqual(cli.input);
  });
  it('the shipped bundle (bundled.ts, its real globs) carries every base its top-level scenarios extend', async () => {
    const { BUNDLED, loadBundledPacks, withPacks } = await import('../src/content/bundled.ts');
    const shipped = withPacks(BUNDLED, await loadBundledPacks());
    expect(shipped.bases!.map((f) => f.path)).toEqual(['repo/scenarios/golden/cover-archer.yaml']);
    const entry = catalog(shipped).scenarios.find((c) => c.path === 'repo/scenarios/cover-archer-replay.yaml');
    expect(entry).toBeDefined();
    expect(entry!.errors).toEqual([]);
    for (const c of catalog(shipped).scenarios) expect(c.errors.filter((e) => /extends/.test(String(e))), c.path).toEqual([]);
  }, 30000);
  it('uses no more workers than there are tasks', () => {
    const j = buildJob(set, req({ n: 40, chunkSize: 20 })).job!;
    expect(workerCount(j, 8)).toBe(4);
    expect(workerCount(j, 1)).toBe(1);
  });
});
