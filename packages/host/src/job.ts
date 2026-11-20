// A run as plain data (docs/design/m2.md 2.3): the texts it loads, the scenario input, flags,
// knobs, the arms by policy id and hash, the seed and the run options. Path-free and clone-safe,
// so it crosses to a worker (Node or browser) by structured clone; the worker rebuilds the arms
// from the texts and refuses to run if any hash differs from what the parent computed.

import { compilePolicy, contentClosure, formatDiag, loadContent, parseYaml, resolveScenario, type ArmSpec, type FightSetup, type Knobs, type RuleFlags, type RunOptions, type SourceFile } from '@montecrit/engine';
import { policiesFrom } from './sources.ts';

export interface JobArm {
  readonly label: string;
  /** Policy id; null plays every seat with its scenario decider. */
  readonly policy: string | null;
  /** The policy's hash when it has one (checked on rebuild). */
  readonly hash: string | null;
}

export interface Job {
  readonly v: 1;
  /** What loadContent gets: every pack file the run can reach. */
  readonly packs: readonly SourceFile[];
  /** The scenario, extends already merged. */
  readonly scenario: { readonly input: unknown; readonly path: string };
  /** Policy files, repo before home; the built-ins are always there. */
  readonly policies: readonly SourceFile[];
  readonly flags: Partial<RuleFlags>;
  readonly knobs: Partial<Knobs>;
  readonly arms: readonly JobArm[];
  readonly seed: number;
  readonly run: Omit<RunOptions, 'onMerge' | 'onFight'>;
  /** The parent's hashes; null skips the check (the parent itself, building the first time). */
  readonly expect: { readonly scenarioHash: string; readonly contentHash: string } | null;
}

export interface BuiltArms {
  readonly arms: ArmSpec[];
  readonly setup: FightSetup | null;
  readonly errors: string[];
}

/** Loads the job's content, resolves its scenario and binds each arm's policy, checking every hash. */
export function buildArms(job: Job): BuiltArms {
  const fail = (errors: string[]): BuiltArms => ({ arms: [], setup: null, errors });
  const loaded = loadContent(job.packs);
  if (!loaded.content) return fail(loaded.errors.map(formatDiag));
  const res = resolveScenario(job.scenario.input, job.scenario.path, loaded.content, { flags: job.flags, knobs: job.knobs });
  if (!res.setup) return fail(res.errors.map(formatDiag));
  const setup = res.setup;
  if (job.expect && (setup.scenarioHash !== job.expect.scenarioHash || setup.contentHash !== job.expect.contentHash)) return fail(['the scenario or content changed under the run']);
  const pol = policiesFrom(job.policies);
  if (pol.errors.length) return fail(pol.errors.map(formatDiag));
  const arms: ArmSpec[] = [];
  for (const a of job.arms) {
    const policy = a.policy === null ? null : (pol.byId.get(a.policy) ?? null);
    if (a.policy !== null && policy === null) return fail([`no policy ${a.policy}`]);
    if (policy !== null && a.hash !== null && policy.hash !== a.hash) return fail([`policy ${a.policy} changed under the run`]);
    arms.push({ label: a.label, setup, policy });
  }
  return { arms, setup, errors: [] };
}

/** The pack names a scenario input (YAML text or the merged document) lists in `packs:`. */
function listedPacks(input: unknown, path: string): string[] {
  const value = typeof input === 'string' ? parseYaml(input, path).doc?.value : input;
  const list = value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>).packs : undefined;
  return Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string') : [];
}

/**
 * The job a worker gets (docs/design/m3.md section 11, C19): only the pack files the scenario's
 * closure reaches (engine contentClosure, from its units' templates and every id the scenario
 * names, plus the manifest of every pack its `packs:` lists) and only the policy files its arms
 * play, instead of every pack and policy. `built` is buildArms(job) on the full job. The trimmed job is rebuilt here and must give the same
 * scenario, content and policy hashes; if it doesn't (a dependency the id scan can't see), the
 * full job goes instead and `closure` is false. A worker rebuilds and checks the hashes again.
 */
export function closureJob(job: Job, built: BuiltArms): { readonly job: Job; readonly closure: boolean } {
  const setup = built.setup;
  if (!setup || built.errors.length) return { job, closure: false };
  const roots = [...setup.seats.map((s) => s.tpl.id), JSON.stringify(job.scenario.input) ?? ''];
  const packs = contentClosure(job.packs, roots, listedPacks(job.scenario.input, job.scenario.path));
  const wanted = new Set(job.arms.map((a) => a.policy).filter((p): p is string => p !== null));
  const policies = job.policies.filter((f) => {
    const doc = parseYaml(f.text, f.path).doc;
    const id = doc ? compilePolicy(doc.value).policy?.id : undefined;
    // A file that doesn't compile stays: the full job's build would have refused it already.
    return id === undefined || wanted.has(id);
  });
  const trimmed: Job = { ...job, packs, policies, expect: { scenarioHash: setup.scenarioHash, contentHash: setup.contentHash } };
  const check = buildArms(trimmed);
  const same = check.errors.length === 0 && check.arms.length === built.arms.length && check.arms.every((a, i) => (a.policy?.hash ?? null) === (built.arms[i]!.policy?.hash ?? null));
  return same ? { job: { ...trimmed, expect: job.expect }, closure: true } : { job, closure: false };
}
