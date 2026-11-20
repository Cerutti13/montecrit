// The Run panel's seat picker (docs/design/m3.md 10): a character seated in the browser is the
// CLI's `run X --pc seat=id`, through the one shared transformation (@montecrit/host seatPcs). Same
// scenario object, same report hash, same report text (calibration "not measured for this PC",
// and the replay command carries --pc).
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeReport, loadContent, renderReport, reportModel, runArms } from '@montecrit/engine';
import { buildArms, pcSeats, reportHash, reportJson, seatPcs } from '@montecrit/host';
import { loadKnown } from '../../cli/src/home.ts';
import { planRun, runRun, seatCharacters } from '../../cli/src/run.ts';
import { readScenarioInput } from '../../cli/src/files.ts';
import { catalog } from '../src/content/catalog.ts';
import { bundledSet } from '../src/content/select.ts';
import { buildJob, reportMeta, type RunRequest } from '../src/run/session.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const env = () => ({ MONTECRIT_HOME: mkdtempSync(join(tmpdir(), 'montecrit-home-')) });
const CHAR = 'test:sample-fighter-masteries';

const packKeys = (dir: string) => readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' }).filter((p) => /\.ya?ml$/.test(p)).map((p) => join(dir, p).split(sep).join('/'));
const raw: Record<string, string> = { '../../../../scenarios/stars-ambush.yaml': read('scenarios/stars-ambush.yaml') };
for (const p of [...packKeys('packs/srd-5.2.1'), ...packKeys('packs/test')]) raw[`../../../../${p}`] = read(p);
const SET = bundledSet(raw);
const SCEN = 'repo/scenarios/stars-ambush.yaml';
const req = (over: Partial<RunRequest> = {}): RunRequest => ({ scenario: SCEN, policies: ['greedy'], n: 40, untilCi: 0.01, seed: 11, chunkSize: 20, pcs: [{ seat: 'pc1', id: CHAR }], ...over });

describe('seat picker parity with run --pc', () => {
  it('the shared seating gives the CLI path\'s scenario object for stars-ambush pc1 = ' + CHAR, () => {
    const e = env();
    const loaded = loadKnown(e, ROOT);
    const cliIn = readScenarioInput(join(ROOT, 'scenarios/stars-ambush.yaml'), ROOT);
    const cli = seatCharacters(cliIn.input, cliIn.path, [{ seat: 'pc1', target: CHAR }], loaded, []);
    if ('error' in cli) throw new Error(cli.error);
    const host = seatPcs(cliIn.input, cliIn.path, [{ seat: 'pc1', id: CHAR, label: CHAR, file: null, pack: null }], loaded.content!, loaded.sheets);
    expect(host).toEqual(cli);
    const sc = cli.input as Record<string, unknown>;
    expect(sc.calibrated).toBeUndefined();
    expect((sc.units as { seat: string; use: string }[]).find((u) => u.seat === 'pc1')!.use).toBe(CHAR);
    expect(sc.reportNotes).toEqual(expect.arrayContaining([`--pc pc1: ${CHAR} (character file) in place of test:sample-druid; calibration: not measured for this PC`, expect.stringMatching(/^calibration: not measured for this PC; the scenario's record \(win \d+\.\d%\)/)]));
    // planRun's job carries the same object, and the browser's job (from texts) does too.
    const plan = planRun(['stars-ambush', '-n', '40', '--seed', '11', '--chunk', '20', '--pc', `pc1=${CHAR}`], e, ROOT);
    expect('job' in plan).toBe(true);
    const web = buildJob(SET, req());
    expect(web.errors).toEqual([]);
    expect(web.job!.scenario.input).toEqual((plan as { job: { scenario: { input: unknown } } }).job.scenario.input);
    // With the catalog's content and sheets handed in, the same again.
    const cat = catalog(SET);
    expect(buildJob(SET, req(), cat).job!.scenario.input).toEqual(web.job!.scenario.input);
  });

  it('a browser run gives the CLI\'s report hash and report text', { timeout: 60_000 }, () => {
    const e = env();
    const argv = ['stars-ambush', '-n', '40', '--seed', '11', '--chunk', '20', '--pc', `pc1=${CHAR}`];
    const cliText = runRun(argv, e, ROOT);
    expect([cliText.code, cliText.err]).toEqual([0, '']);
    const cliHash = runRun([...argv, '--report-hash'], e, ROOT);
    const web = buildJob(SET, req({ policies: [] }));
    // The CLI's report with no --policy has one arm, 'scenario'; build the same job.
    expect(web.errors).toEqual(['give at least one policy']);
    const job = { ...buildJob(SET, req()).job!, arms: [{ label: 'scenario', policy: null, hash: null }] };
    const built = buildArms(job);
    expect(built.errors).toEqual([]);
    const run = runArms(built.arms, job.seed, job.run);
    const meta = reportMeta(req(), run, null, 'ref');
    expect(meta.replay).toBe(`montecrit run scenarios/stars-ambush.yaml --seed 11 --pc pc1=${CHAR}`);
    const stats = computeReport(built.arms, run.merged, meta);
    const hash = reportHash(reportJson(built.arms, run, 11, stats));
    expect(cliHash.out).toContain(hash);
    const text = renderReport(built.arms, run.merged, meta, stats, reportModel(built.arms, run.merged)).join('\n');
    expect(text).toBe(cliText.out);
    expect(text).toMatch(/calibration: not measured for this PC/);
  });
});

describe('the catalog and the seating', () => {
  it('lists the scenario\'s PC seats (not the ally) and every loaded character', () => {
    const cat = catalog(SET);
    const entry = cat.scenarios.find((s) => s.path === SCEN)!;
    expect(entry.pcSeats).toEqual([{ seat: 'pc1', use: 'test:sample-druid' }]);
    const ids = cat.characters.map((c) => c.id);
    expect(ids).toContain(CHAR);
    expect(ids).toContain('test:sample-druid');
    expect(ids.some((id) => id.startsWith('srd:'))).toBe(false);
    expect(cat.characters.find((c) => c.id === CHAR)).toMatchObject({ origin: 'repo', kind: 'character file' });
    expect(cat.characters.find((c) => c.id === 'test:sample-druid')).toMatchObject({ kind: 'kind: pc' });
    expect([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(ids);
  });

  it('keeps the scenario as written with no pick, and refuses a monster, an unknown id, a missing seat and a seat given twice', () => {
    const plain = buildJob(SET, req({ pcs: [] }));
    expect(typeof plain.job!.scenario.input).toBe('string');
    expect(buildJob(SET, req({ pcs: [{ seat: 'pc1', id: 'srd:goblin-boss' }] })).errors).toEqual(['--pc pc1: srd:goblin-boss is a monster, not a character']);
    expect(buildJob(SET, req({ pcs: [{ seat: 'pc1', id: 'test:no-such' }] })).errors[0]).toMatch(/no character test:no-such is loaded/);
    expect(buildJob(SET, req({ pcs: [{ seat: 'nobody', id: CHAR }] })).errors[0]).toMatch(/no seat "nobody"/);
    expect(buildJob(SET, req({ pcs: [{ seat: 'pc1', id: CHAR }, { seat: 'pc1', id: 'test:sample-druid' }] })).errors).toEqual(['a seat is given two characters']);
  });

  it('pcSeats reads YAML text and merged documents, and skips monsters and unknown ids', () => {
    const content = loadContent(SET.packs).content!;
    const text = "units:\n  - { seat: a, use: 'test:sample-druid' }\n  - { seat: b, use: 'srd:goblin-boss' }\n  - { seat: c, use: 'test:nope' }\n";
    expect(pcSeats(text, 'x.yaml', content)).toEqual([{ seat: 'a', use: 'test:sample-druid' }]);
    expect(pcSeats({ units: [{ seat: 'z', use: CHAR }] }, 'x.yaml', content)).toEqual([{ seat: 'z', use: CHAR }]);
    expect(pcSeats('{', 'x.yaml', content)).toEqual([]);
  });

  it('seatPcs never mutates its input document', () => {
    const content = loadContent(SET.packs).content!;
    const doc = { packs: ['srd-5.2.1'], units: [{ seat: 'pc1', use: 'srd:goblin-boss' }], calibrated: { win: 0.5 } };
    const before = JSON.stringify(doc);
    const r = seatPcs(doc, 'x.yaml', [{ seat: 'pc1', id: CHAR, label: CHAR, file: null, pack: null }], content, []);
    expect(JSON.stringify(doc)).toBe(before);
    expect(r).toMatchObject({ input: { packs: ['srd-5.2.1', 'test'], units: [{ seat: 'pc1', use: CHAR }] } });
    expect((r as { notes: string[] }).notes).toEqual([`--pc pc1: ${CHAR} (kind: pc) in place of srd:goblin-boss; calibration: not measured for this PC`, "calibration: not measured for this PC; the scenario's record (win 50.0%) was measured with the scenario's own seats"]);
  });
});
