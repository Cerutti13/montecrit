// Closure-only worker payloads (docs/design/m3.md section 11 and C19): a worker gets the pack
// files the scenario reaches and the policy files its arms play, not every pack. For every
// committed scenario the trimmed job rebuilds to the same scenario, content and policy hashes
// (so every report is unchanged), the init message a worker receives holds exactly that closure,
// and a closure that can't reproduce the hashes falls back to the full job.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contentClosure, idsIn, peekKind, type SourceFile } from '@montecrit/engine';
import { buildArms, closureJob, openSession, scenarioInput, selectKnown, type Job } from '../src/index.ts';
import { testTransport, type TestTransport } from './helpers/transport.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const listing = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((p) => p !== '');
const sel = selectKnown(listing);
const text = (p: string): SourceFile => ({ path: `repo/${p}`, text: readFileSync(join(ROOT, p), 'utf8') });
const PACKS = sel.packs.map(text);
const POLICIES = sel.policies.map(text);
const SCENARIO_FILES = listing.filter((p) => /^scenarios\/(golden\/|perf\/)?[^/]+\.yaml$/.test(p)).map(text);
const SCENARIOS = SCENARIO_FILES.filter((f) => peekKind(f.text) === 'scenario');

function jobFor(path: string, policies: (string | null)[]): Job {
  const input = scenarioInput(SCENARIO_FILES, path, 'repo/scenarios');
  if (input.errors.length) throw new Error(input.errors.map((d) => d.message).join('\n'));
  return {
    v: 1,
    packs: PACKS,
    scenario: { input: input.input, path },
    policies: POLICIES,
    flags: {},
    knobs: {},
    arms: policies.map((p) => ({ label: p ?? 'scenario', policy: p, hash: null })),
    seed: 7,
    run: { n: 20, chunkSize: 10 },
    expect: null,
  };
}

describe('idsIn and contentClosure (engine, load-time)', () => {
  it('idsIn finds every namespaced id in a text, each \'/\' prefix of a longer one, and an id inside a pick key', () => {
    expect(idsIn('features: [srd:monk/martial-arts]\npicks:\n  srd:monk#skills: [x]\nnot: core:dodge')).toEqual(['srd:monk', 'srd:monk/martial-arts']);
  });

  it('takes what the roots reach, the manifests of the packs they sit in and the packs those require; an unparseable file stays', () => {
    const man = (pack: string, req: string[] = []) => `kind: manifest\npack: ${pack}\nversion: '1'\nrules: '2024'\nnamespace: test\nlicense: test\nrequires: [${req.join(', ')}]\n`;
    const files: SourceFile[] = [
      { path: 'a/manifest.yaml', text: man('a', ['b']) },
      { path: 'a/x.yaml', text: 'kind: pc\nid: test:x\nfeatures: [test:y/part]\n' },
      { path: 'a/y.yaml', text: 'kind: feature\nid: test:y\n' },
      { path: 'a/z.yaml', text: 'kind: feature\nid: test:z\n' },
      { path: 'b/manifest.yaml', text: man('b') },
      { path: 'c/manifest.yaml', text: man('c') },
      { path: 'c/w.yaml', text: '- kind: monster\n  id: test:w\n- kind: monster\n  id: test:v\n' },
      { path: 'c/broken.yaml', text: 'kind: [unclosed\n' },
    ];
    expect(contentClosure(files, ['test:x']).map((f) => f.path)).toEqual(['a/manifest.yaml', 'a/x.yaml', 'a/y.yaml', 'b/manifest.yaml', 'c/manifest.yaml', 'c/broken.yaml']);
    expect(contentClosure(files, ['test:v']).map((f) => f.path)).toEqual(['c/manifest.yaml', 'c/w.yaml', 'c/broken.yaml']);
    // A pack listed by name comes along by its manifest (and what it requires) with no item of it reached.
    expect(contentClosure(files, ['test:v'], ['a']).map((f) => f.path)).toEqual(['a/manifest.yaml', 'b/manifest.yaml', 'c/manifest.yaml', 'c/w.yaml', 'c/broken.yaml']);
  });
});

describe('closureJob: every committed scenario rebuilds from its closure to the same hashes', () => {
  it('found the committed scenarios', () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(13);
  });

  for (const f of SCENARIOS) {
    it(`${f.path}: closure-only, same scenario, content and policy hashes, fewer pack files`, () => {
      const policies = f.path.includes('monk-') ? ['greedy', 'stun-first'] : f.path.includes('stars-ambush') ? ['greedy', 'moonbeam-first'] : [null];
      const job = jobFor(f.path, policies);
      const full = buildArms(job);
      expect(full.errors).toEqual([]);
      const c = closureJob(job, full);
      expect(c.closure).toBe(true);
      expect(c.job.packs.length).toBeLessThan(job.packs.length);
      const again = buildArms(c.job);
      expect(again.errors).toEqual([]);
      expect(again.setup!.scenarioHash).toBe(full.setup!.scenarioHash);
      expect(again.setup!.contentHash).toBe(full.setup!.contentHash);
      expect(again.arms.map((a) => a.policy?.hash ?? null)).toEqual(full.arms.map((a) => a.policy?.hash ?? null));
      // Only the policy files the arms play.
      expect(c.job.policies.length).toBe(policies.filter((p) => p !== null && !['greedy', 'greedy-spendy', 'baseline', 'random-legal'].includes(p)).length);
    });
  }

  it('a scenario that lists a pack its units never reach (packs: [srd-5.2.1, test], SRD units only) still gets the closure: the unused pack costs only its manifest', () => {
    const input = `kind: scenario\nid: listed-unused\nname: Listed unused\nrules: '2024'\npacks: [srd-5.2.1, test]\ngrid: { w: 8, h: 4 }\nunits:\n  - { seat: a, team: party, use: srd:guard, at: B2 }\n  - { seat: b, team: enemies, use: srd:goblin-warrior, at: F2 }\n`;
    const job: Job = { ...jobFor('repo/scenarios/stars-ambush.yaml', [null]), scenario: { input, path: 'repo/scenarios/listed-unused.yaml' } };
    const full = buildArms(job);
    expect(full.errors).toEqual([]);
    const c = closureJob(job, full);
    expect(c.closure).toBe(true);
    const paths = c.job.packs.map((p) => p.path);
    expect(paths.filter((p) => p.startsWith('repo/packs/test/'))).toEqual(['repo/packs/test/manifest.yaml']);
    expect(paths).toContain('repo/packs/srd-5.2.1/monsters/guard.yaml');
    expect(c.job.policies).toEqual([]);
    expect(buildArms(c.job).setup!.contentHash).toBe(full.setup!.contentHash);
  });

  it('a trimmed job whose policy hashes differ from the parent\'s falls back to the full job', () => {
    const job = jobFor('repo/scenarios/stars-ambush.yaml', ['greedy', 'moonbeam-first']);
    const full = buildArms(job);
    expect(full.errors).toEqual([]);
    expect(closureJob(job, full).closure).toBe(true);
    // The parent's built arms carry a different hash for moonbeam-first than the trimmed rebuild gives.
    const other = { ...full, arms: full.arms.map((a, i) => (i === 1 ? { ...a, policy: { ...a.policy!, hash: '0000000000000000' } } : a)) };
    const c = closureJob(job, other);
    expect(c.closure).toBe(false);
    expect(c.job).toBe(job);
  });

  it('a closure that can\'t reproduce the parent\'s hashes falls back to the full job', () => {
    const job = jobFor('repo/scenarios/stars-ambush.yaml', ['greedy']);
    const full = buildArms(job);
    const tampered = { ...full, setup: { ...full.setup!, contentHash: '0000000000000000' } };
    const c = closureJob(job, tampered);
    expect(c.closure).toBe(false);
    expect(c.job).toBe(job);
  });
});

describe('the worker payload holds only the job\'s closure', () => {
  it('every worker\'s init message carries the closure\'s pack files and the arms\' policy files, and the run still matches', { timeout: 60_000 }, async () => {
    const job = jobFor('repo/scenarios/monk-ambush.yaml', ['greedy', 'stun-first']);
    const full = buildArms(job);
    const want = closureJob(job, full).job;
    const ts: TestTransport[] = [];
    const s = await openSession(job, (i) => {
      const t = testTransport({ salt: i + 1 });
      ts.push(t);
      return t;
    }, 3);
    await s.run().done;
    s.close();
    expect(ts.length).toBe(3);
    for (const t of ts) {
      const init = t.sent.find((m) => m.t === 'init');
      expect(init && init.t === 'init').toBe(true);
      if (!init || init.t !== 'init') continue;
      const paths = init.job.packs.map((p) => p.path);
      expect(paths).toEqual(want.packs.map((p) => p.path));
      expect(paths.length).toBeLessThan(job.packs.length);
      // Nothing it can't reach: no SRD spell (the Monk casts none, its foes cast none) and no other class.
      expect(paths.some((p) => p.includes('/spells/'))).toBe(false);
      expect(paths.some((p) => p.endsWith('/classes/wizard.yaml'))).toBe(false);
      expect(paths).toContain('repo/packs/srd-5.2.1/manifest.yaml');
      expect(paths).toContain('repo/packs/srd-5.2.1/classes/monk.yaml');
      expect(init.job.policies.map((p) => p.path)).toEqual(['repo/policies/stun-first.yaml']);
      expect(init.job.expect).toEqual({ scenarioHash: full.setup!.scenarioHash, contentHash: full.setup!.contentHash });
    }
  });
});
