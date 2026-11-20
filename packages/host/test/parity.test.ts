// Parity between the CLI and @montecrit/host (docs/design/m2.md 3, 7.3): the host's pure
// selection picks exactly the committed files the CLI reads, and the same texts under the
// browser's 'repo/' and 'home/' paths, in any order, give the CLI's content, scenario and policy
// hashes and its report JSON byte for byte. Private markers are assembled at runtime so this
// file carries none (critique resolution 14).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeReport, loadContent, runArms, type ReportMeta, type SourceFile } from '@montecrit/engine';
import { REPO_ROOT, readScenarioInput } from '../../../apps/cli/src/files.ts';
import { homeDir, loadKnown, loadPolicies, readKnown } from '../../../apps/cli/src/home.ts';
import { runRun } from '../../../apps/cli/src/run.ts';
import { buildArms, policiesFrom, reportJson, scenarioInput, selectKnown, type Job } from '../src/index.ts';

const PRIV = 'priv' + 'ate';
const put = (root: string, rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const manifest = (pack: string, ns: string, license: string) => `kind: manifest\npack: ${pack}\nversion: '1'\nrules: '2024'\nnamespace: ${ns}\nlicense: ${license}\n`;

/** Deterministic shuffle. */
function shuffled<T>(xs: readonly T[], salt: number): T[] {
  const out = xs.slice();
  let s = (salt * 2654435761) >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function listRepo(root: string): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\n').filter((p) => p !== '');
}

describe('selectKnown: the CLI\'s rules for committed content', () => {
  it('on a synthetic repo: packs need a manifest, dot names and node_modules are skipped, policies nest, scenarios do not', () => {
    const repo = mkdtempSync(join(tmpdir(), 'montecrit-repo-'));
    put(repo, 'packs/a/manifest.yaml', manifest('a', 'test', 'test'));
    put(repo, 'packs/a/monsters/m.yaml', 'kind: monster\n');
    put(repo, 'packs/a/deep/er/x.yml', 'x: 1\n');
    put(repo, 'packs/a/.hidden/h.yaml', 'x: 1\n');
    put(repo, 'packs/a/node_modules/n.yaml', 'x: 1\n');
    put(repo, 'packs/a/notes.md', '# not yaml\n');
    put(repo, 'packs/nomanifest/x.yaml', 'x: 1\n');
    put(repo, 'packs/.dot/manifest.yaml', manifest('dot', 'test', 'test'));
    put(repo, 'policies/p.yaml', 'kind: policy\n');
    put(repo, 'policies/nested/q.yaml', 'kind: policy\n');
    put(repo, 'policies/.h/r.yaml', 'kind: policy\n');
    put(repo, 'scenarios/s.yaml', 'kind: scenario\n');
    put(repo, 'scenarios/golden/g.yaml', 'kind: scenario\n');
    const listing = ['packs/a/manifest.yaml', 'packs/a/monsters/m.yaml', 'packs/a/deep/er/x.yml', 'packs/a/.hidden/h.yaml', 'packs/a/node_modules/n.yaml', 'packs/a/notes.md', 'packs/nomanifest/x.yaml', 'packs/.dot/manifest.yaml', 'policies/p.yaml', 'policies/nested/q.yaml', 'policies/.h/r.yaml', 'scenarios/s.yaml', 'scenarios/golden/g.yaml'];
    const sel = selectKnown(shuffled(listing, 3));
    const env = { MONTECRIT_HOME: mkdtempSync(join(tmpdir(), 'montecrit-home-')) };
    const cliPacks = readKnown(env, [], repo).files.map((f) => relative(repo, f.path)).sort();
    expect(sel.packs).toEqual(cliPacks);
    expect(sel.packs).toEqual(['packs/a/deep/er/x.yml', 'packs/a/manifest.yaml', 'packs/a/monsters/m.yaml']);
    expect(sel.policies).toEqual(['policies/nested/q.yaml', 'policies/p.yaml']);
    expect(sel.scenarios).toEqual(['scenarios/s.yaml']);
  });

  it('on the real repo: the same pack files the CLI loads', () => {
    const env = { MONTECRIT_HOME: mkdtempSync(join(tmpdir(), 'montecrit-home-')) };
    const cliPacks = readKnown(env, [], REPO_ROOT).files.map((f) => relative(REPO_ROOT, f.path)).sort();
    expect(selectKnown(listRepo(REPO_ROOT)).packs).toEqual(cliPacks);
  });
});

describe('hash and report parity: CLI from disk vs host from texts', () => {
  // A synthetic home: a listed pack (private, assembled at runtime), an unlisted pack and a dot
  // folder that must not load (both are broken YAML), a nested policy, and a twin scenario that
  // extends the repo's stars-ambush and swaps a goblin for the home pack's copy.
  const home = mkdtempSync(join(tmpdir(), 'montecrit-home-'));
  const env = { MONTECRIT_HOME: home };
  put(home, 'config.yaml', 'packs:\n  - packs/extra\n');
  put(home, 'packs/extra/manifest.yaml', manifest('extra', PRIV, PRIV));
  const gob = readFileSync(join(REPO_ROOT, 'packs/srd-5.2.1/monsters/goblin-warrior.yaml'), 'utf8').replace('id: srd:goblin-warrior', `id: ${PRIV}:goblin-copy`).replace('name: Goblin Warrior', 'name: Goblin Copy');
  put(home, 'packs/extra/monsters/goblin-copy.yaml', gob);
  put(home, 'packs/unlisted/manifest.yaml', manifest('unlisted', PRIV, PRIV));
  put(home, 'packs/unlisted/bad.yaml', 'kind: [unclosed\n');
  put(home, 'packs/extra/.junk/bad.yaml', 'kind: [unclosed\n');
  put(home, 'policies/nested/deep.yaml', readFileSync(join(REPO_ROOT, 'policies/test-volley-first.yaml'), 'utf8').replace('id: test-volley-first', 'id: home-nested'));
  put(home, 'scenarios/twin.yaml', `kind: scenario\nid: twin\nextends: stars-ambush\npacks: [+extra]\noverride:\n  units:\n    gob1: { use: '${PRIV}:goblin-copy' }\n`);
  const twin = join(home, 'scenarios', 'twin.yaml');

  // The browser's view: committed texts under repo/, home texts (as the dev server reads them with the CLI's code) under home/.
  const repoSel = selectKnown(listRepo(REPO_ROOT));
  const repoText = (p: string): SourceFile => ({ path: `repo/${p}`, text: readFileSync(join(REPO_ROOT, p), 'utf8') });
  const homeRel = (p: string) => `home/${relative(homeDir(env), p)}`;
  const homePacks = readKnown(env, [], REPO_ROOT).files.filter((f) => relative(homeDir(env), f.path).split('/')[0] !== '..').map((f) => ({ path: homeRel(f.path), text: f.text }));
  const packs = shuffled([...repoSel.packs.map(repoText), ...homePacks], 7);
  const scenarios = [...repoSel.scenarios.map(repoText), { path: 'home/scenarios/twin.yaml', text: readFileSync(twin, 'utf8') }];
  const policyFiles = [...repoSel.policies.map(repoText), { path: 'home/policies/nested/deep.yaml', text: readFileSync(join(home, 'policies/nested/deep.yaml'), 'utf8') }];

  it('loads the listed home pack only, and the same content, scenario and policy hashes', () => {
    expect(homePacks.map((f) => f.path).sort()).toEqual(['home/packs/extra/manifest.yaml', 'home/packs/extra/monsters/goblin-copy.yaml']);
    const cli = loadKnown(env);
    expect(cli.errors).toEqual([]);
    const host = loadContent(packs);
    expect(host.errors).toEqual([]);
    expect(host.content!.hash).toBe(cli.content!.hash);
    const cliPol = loadPolicies(env);
    const hostPol = policiesFrom(policyFiles);
    expect([...hostPol.byId.keys()].sort()).toEqual([...cliPol.byId.keys()].sort());
    for (const [id, p] of cliPol.byId) expect(hostPol.byId.get(id)!.hash).toBe(p.hash);
    const cliIn = readScenarioInput(twin);
    const hostIn = scenarioInput(scenarios, 'home/scenarios/twin.yaml', 'repo/scenarios');
    expect([hostIn.errors, hostIn.base]).toEqual([[], 'repo/scenarios/stars-ambush.yaml']);
    expect(hostIn.input).toEqual(cliIn.input);
  });

  it('gives the CLI\'s report JSON byte for byte (2 arms x 60 runs, the twin)', { timeout: 60_000 }, () => {
    const cli = runRun([twin, '-n', '60', '--seed', '11', '--policy', 'greedy,home-nested', '--chunk', '20', '--json'], env);
    expect([cli.code, cli.err]).toEqual([0, '']);
    const hostIn = scenarioInput(scenarios, 'home/scenarios/twin.yaml', 'repo/scenarios');
    const job: Job = {
      v: 1,
      packs,
      scenario: { input: hostIn.input, path: 'home/scenarios/twin.yaml' },
      policies: policyFiles,
      flags: {},
      knobs: {},
      arms: [
        { label: 'greedy', policy: 'greedy', hash: null },
        { label: 'home-nested', policy: 'home-nested', hash: null },
      ],
      seed: 11,
      run: { n: 60, chunkSize: 20 },
      expect: null,
    };
    const built = buildArms(job);
    expect(built.errors).toEqual([]);
    const run = runArms(built.arms, job.seed, job.run);
    const meta: ReportMeta = { seed: 11, replay: '', fileNote: null, adaptive: false, checkpoint: null, hitCap: false, untilCi: 0.01, pairs: 'ref', verbose: false };
    expect(reportJson(built.arms, run, 11, computeReport(built.arms, run.merged, meta))).toBe(cli.out);
    // A hash the worker didn't expect stops the rebuild.
    expect(buildArms({ ...job, expect: { scenarioHash: built.setup!.scenarioHash, contentHash: '0000000000000000' } }).errors).toEqual(['the scenario or content changed under the run']);
  });

  it('M3 step 5a: gives the CLI\'s report JSON for monk-ambush (a character PC, riders, Deflect, a rider policy), 2 arms x 40 runs', { timeout: 60_000 }, () => {
    const cli = runRun([join(REPO_ROOT, 'scenarios/monk-ambush.yaml'), '-n', '40', '--seed', '11', '--policy', 'greedy,stun-first', '--chunk', '20', '--json'], env);
    expect([cli.code, cli.err]).toEqual([0, '']);
    const hostIn = scenarioInput(scenarios, 'repo/scenarios/monk-ambush.yaml', 'repo/scenarios');
    expect([hostIn.errors, hostIn.base]).toEqual([[], 'repo/scenarios/stars-ambush.yaml']);
    const job: Job = {
      v: 1,
      packs,
      scenario: { input: hostIn.input, path: 'repo/scenarios/monk-ambush.yaml' },
      policies: policyFiles,
      flags: {},
      knobs: {},
      arms: [
        { label: 'greedy', policy: 'greedy', hash: null },
        { label: 'stun-first', policy: 'stun-first', hash: null },
      ],
      seed: 11,
      run: { n: 40, chunkSize: 20 },
      expect: null,
    };
    const built = buildArms(job);
    expect(built.errors).toEqual([]);
    const run = runArms(built.arms, job.seed, job.run);
    const meta: ReportMeta = { seed: 11, replay: '', fileNote: null, adaptive: false, checkpoint: null, hitCap: false, untilCi: 0.01, pairs: 'ref', verbose: false };
    expect(reportJson(built.arms, run, 11, computeReport(built.arms, run.merged, meta))).toBe(cli.out);
  });
});
