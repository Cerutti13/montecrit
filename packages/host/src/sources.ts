// Content sources as plain texts (docs/design/m2.md 3): which committed files load, the private
// marker, and policies from texts. Platform-free (no node:, no DOM): the CLI reads files from
// disk and the browser bundles them; both hand the texts here, so both load the same content and
// compute the same hashes. The private home folder never comes through selectKnown: the CLI reads
// it with its own rules, and the browser gets it from the dev server, which runs that same code.

import { BUILTIN_POLICIES, compilePolicy, extendScenario, extendsName, parseYaml, type CompiledPolicy, type Diag, type SourceFile } from '@montecrit/engine';

const YAML = /\.ya?ml$/i;
// Same shapes tools/check-private.ts looks for.
const PRIVATE_LICENSE = /(?:^|[{,\s])["']?license["']?\s*:\s*["']?private\b/im;
const PRIVATE_ID = /\bprivate:[a-z0-9]/i;

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** What marks text as private, with its 1-based line; null if nothing does. */
export function privateMarker(text: string): { what: string; line: number } | null {
  for (const [re, what] of [[PRIVATE_LICENSE, 'a private license'], [PRIVATE_ID, 'a private content id']] as const) {
    const m = re.exec(text);
    if (m) return { what, line: text.slice(0, m.index + (m[0].startsWith('\n') ? 1 : 0)).split('\n').length };
  }
  return null;
}

export interface RepoSelection {
  /** Every YAML file of every pack. */
  readonly packs: string[];
  /** Scenario files directly in scenarios/ (not golden/ or perf/). */
  readonly scenarios: string[];
  /** Policy files at any depth under policies/. */
  readonly policies: string[];
}

/**
 * The CLI's rules for committed content (apps/cli/src/home.ts packFoldersIn, files.ts
 * collectYaml) over '/'-separated repo-relative paths: a pack is a direct child folder of packs/
 * holding a manifest.yaml, and its files are every YAML file at any depth under it; policies are
 * YAML at any depth under policies/; scenarios are YAML directly in scenarios/. Names starting
 * with a dot, and node_modules, are skipped at every level. Each list sorted with <.
 */
export function selectKnown(paths: readonly string[]): RepoSelection {
  const ordinary = (segs: readonly string[]) => segs.every((s) => s !== '' && !s.startsWith('.') && s !== 'node_modules');
  const split = paths.map((p) => p.split('/'));
  const packRoots = split.filter((s) => s.length === 3 && s[0] === 'packs' && s[2] === 'manifest.yaml' && ordinary(s.slice(1, 2))).map((s) => s[1]!);
  const packs: string[] = [];
  const scenarios: string[] = [];
  const policies: string[] = [];
  split.forEach((s, i) => {
    const p = paths[i]!;
    if (!YAML.test(p) || !ordinary(s)) return;
    if (s[0] === 'packs' && s.length >= 3 && packRoots.includes(s[1]!)) packs.push(p);
    else if (s[0] === 'scenarios' && s.length === 2) scenarios.push(p);
    else if (s[0] === 'policies' && s.length >= 2) policies.push(p);
  });
  return { packs: packs.sort(byString), scenarios: scenarios.sort(byString), policies: policies.sort(byString) };
}

export interface Policies {
  readonly byId: ReadonlyMap<string, CompiledPolicy>;
  readonly errors: Diag[];
}

/** The built-in policies, then each file's in order (repo before home); two with one id is an error. */
export function policiesFrom(files: readonly SourceFile[]): Policies {
  const byId = new Map<string, CompiledPolicy>(BUILTIN_POLICIES.map((p) => [p.id, p]));
  const errors: Diag[] = [];
  for (const f of files) {
    const doc = parseYaml(f.text, f.path);
    if (!doc.doc) {
      errors.push(...doc.errors);
      continue;
    }
    const c = compilePolicy(doc.doc.value);
    if (!c.policy) {
      errors.push(...c.errors.map((message) => ({ path: f.path, line: 0, col: 0, message })));
      continue;
    }
    if (byId.has(c.policy.id)) errors.push({ path: f.path, line: 0, col: 0, message: `policy ${c.policy.id} is defined twice` });
    else byId.set(c.policy.id, c.policy);
  }
  return { byId, errors };
}

export interface ScenarioInput {
  /** YAML text, or the merged document for a scenario that extends another. */
  readonly input: unknown;
  readonly path: string;
  readonly base: string | null;
  readonly errors: Diag[];
}

const dirOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.');

/**
 * One scenario from texts, as the CLI's readScenarioInput does from disk: a file that `extends`
 * another is merged with its base, looked up first in the repo's scenarios folder
 * (`repoScenarios`, e.g. 'repo/scenarios'), then in its own folder, never itself.
 */
export function scenarioInput(files: readonly SourceFile[], path: string, repoScenarios: string): ScenarioInput {
  const fail = (message: string): ScenarioInput => ({ input: null, path, base: null, errors: [{ path, line: 0, col: 0, message }] });
  const file = files.find((f) => f.path === path);
  if (!file) return fail("can't read it");
  const parsed = parseYaml(file.text, file.path);
  const name = parsed.doc ? extendsName(parsed.doc.value) : null;
  if (!parsed.doc || name === null) return { input: file.text, path, base: null, errors: [] };
  const base = [`${repoScenarios}/${name}.yaml`, `${dirOf(path)}/${name}.yaml`, `${repoScenarios}/golden/${name}.yaml`].map((p) => files.find((f) => f.path === p && p !== path)).find((f) => f !== undefined);
  if (!base) return fail(`extends: no scenario "${name}" in the repo's scenarios/ folder, scenarios/golden/ or next to this file`);
  const baseDoc = parseYaml(base.text, base.path);
  if (!baseDoc.doc) return { input: null, path, base: base.path, errors: baseDoc.errors };
  const merged = extendScenario(parsed.doc.value, baseDoc.doc.value);
  if (merged.value === null) return { input: null, path, base: base.path, errors: merged.errors.map((message) => ({ path, line: 0, col: 0, message })) };
  return { input: merged.value, path, base: base.path, errors: [] };
}
