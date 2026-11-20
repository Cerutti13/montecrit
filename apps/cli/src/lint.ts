// `montecrit lint [paths...] [--all] [--strict]`: validates packs, scenarios and journals and
// prints every problem as path:line:col: message. Every known pack is always loaded (a
// scenario can't resolve without them); paths add files to check, and a path inside a pack
// brings in that whole pack. No paths means --all: known packs plus the scenarios folders.
// Exit 1 on errors, and on warnings too with --strict.

import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BUILTIN_POLICIES, compareDiags, compilePolicy, formatDiag, loadContent, parseJournal, parseYaml, peekKind, resolveScenario, type Diag, type SourceFile } from '@montecrit/engine';
import { REPO_ROOT, displayPath, enclosingPack, isInside, readScenarioInput } from './files.ts';
import { homeDir, itemOf, kebab, looseManifest, packDirs, readKnown, type Env } from './home.ts';

export const LINT_USAGE = `usage: montecrit lint [paths...] [--all] [--strict]

  paths      files or folders to check, on top of every known pack; a kind: character file outside every pack
             loads on its own (test: or private: id) and gets the character lint (picks, counts, training, hands)
  --all      every known pack plus the repo and ~/.montecrit scenarios folders (the default)
  --strict   exit 1 on warnings too`;

export interface CommandOutput {
  readonly out: string;
  readonly err: string;
  readonly code: number;
}

export function runLint(argv: readonly string[], env: Env = process.env, repoRoot: string = REPO_ROOT): CommandOutput {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { all: { type: 'boolean' }, strict: { type: 'boolean' }, help: { type: 'boolean' } },
    allowPositionals: true,
    strict: true,
  });
  if (values.help) return { out: LINT_USAGE, err: '', code: 0 };

  const extra: string[] = [];
  const packs = [...packDirs(env, repoRoot).dirs];
  for (const p of positionals) {
    extra.push(p);
    const pack = enclosingPack(p);
    if (pack) {
      extra.push(pack);
      packs.push(pack);
    }
  }
  const inPack = (path: string) => packs.some((d) => isInside(resolve(path), resolve(d)));
  if (values.all || positionals.length === 0) {
    for (const dir of [join(repoRoot, 'scenarios'), join(homeDir(env), 'scenarios'), join(repoRoot, 'policies'), join(homeDir(env), 'policies')]) if (existsSync(dir)) extra.push(dir);
  }

  const read = readKnown(env, extra, repoRoot);
  const errors: Diag[] = [...read.errors];
  const warnings: Diag[] = [];

  const contentFiles: SourceFile[] = [];
  const scenarios: SourceFile[] = [];
  const journals: SourceFile[] = [];
  const policyIds = new Map<string, string>();
  const loose: SourceFile[] = [];
  for (const f of read.files) {
    const kind = peekKind(f.text);
    if (kind === 'scenario') scenarios.push(f);
    else if (kind === 'journal') journals.push(f);
    else if (kind === 'policy') {
      const doc = parseYaml(f.text, f.path);
      const c = doc.doc ? compilePolicy(doc.doc.value) : null;
      if (!doc.doc) errors.push(...doc.errors);
      else if (!c!.policy) errors.push(...c!.errors.map((message) => ({ path: f.path, line: 0, col: 0, message })));
      else if (policyIds.has(c!.policy.id) || BUILTIN_POLICIES.some((b) => b.id === c!.policy!.id)) errors.push({ path: f.path, line: 0, col: 0, message: `policy ${c!.policy.id} is defined twice` });
      else policyIds.set(c!.policy.id, f.path);
    }
    else if (inPack(f.path)) contentFiles.push(f);
    else if (kind === 'character') loose.push(f);
    else {
      // Outside every pack and not a scenario or journal: report it on its own, so one broken
      // file can't stop the content (and every scenario) from being checked.
      const yamlErrors = parseYaml(f.text, f.path).errors;
      errors.push(...(yamlErrors.length ? yamlErrors : [{ path: f.path, line: 0, col: 0, message: 'not a scenario, journal or policy (kind is missing or unknown), and not inside a pack' }]));
    }
  }

  // A character file outside every pack loads on its own, under a supplied manifest beside it
  // (in memory) whose namespace is its id's: test: or private: only (home.ts loadWithFiles).
  const looseDirs = new Map<string, string>();
  for (const f of loose) {
    const id = itemOf(f.text, f.path).id ?? '';
    const ns = id.includes(':') ? id.slice(0, id.indexOf(':')) : '';
    const dir = dirname(f.path);
    const have = looseDirs.get(dir);
    if (have === undefined) {
      const text = looseManifest(`loose-${looseDirs.size + 1}-${kebab(basename(dir))}`, ns);
      if (text === null) {
        errors.push({ path: f.path, line: 0, col: 0, message: `a character file outside every pack loads on its own only with a test: or private: id (this one is ${id || 'missing'}); put it in a pack folder with a manifest.yaml` });
        continue;
      }
      looseDirs.set(dir, ns);
      contentFiles.push({ path: join(dir, 'manifest.yaml'), text });
    } else if (have !== ns) {
      errors.push({ path: f.path, line: 0, col: 0, message: `loose character files in one folder load as one pack: this one's namespace (${ns}) differs from ${have}` });
      continue;
    }
    contentFiles.push(f);
  }
  const loaded = loadContent(contentFiles);
  errors.push(...loaded.errors);
  warnings.push(...loaded.warnings);
  for (const s of scenarios) {
    if (!loaded.content) {
      errors.push({ path: s.path, line: 0, col: 0, message: 'not checked: the content it needs has errors' });
      continue;
    }
    const sc = readScenarioInput(s.path, repoRoot); // merges a scenario that extends another
    if (sc.errors.length) {
      errors.push(...sc.errors);
      continue;
    }
    const r = resolveScenario(sc.input, sc.path, loaded.content);
    errors.push(...r.errors);
    warnings.push(...r.warnings);
  }
  for (const j of journals) errors.push(...parseJournal(j.text, j.path).errors);

  errors.sort(compareDiags);
  warnings.sort(compareDiags);
  const show = (d: Diag, level: string) => formatDiag({ ...d, path: displayPath(d.path), message: `${level}: ${d.message}` });
  const lines = [...errors.map((d) => show(d, 'error')), ...warnings.map((d) => show(d, 'warning'))];
  const summary = `lint: ${read.files.length} file(s), ${errors.length} error(s), ${warnings.length} warning(s)`;
  const failed = errors.length > 0 || (values.strict === true && warnings.length > 0);
  return { out: [...lines, summary].join('\n'), err: '', code: failed ? 1 : 0 };
}
