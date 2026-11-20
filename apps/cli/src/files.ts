// The CLI's only filesystem code. It collects .yaml/.yml files under the given paths,
// sorted by path, and refuses any file under the repo root that carries private content
// (a private license or a private id). Paths are checked both as written and after
// resolving symlinks, so neither a repo symlink into ~/.montecrit nor a home folder that
// links back into the repo can smuggle private content in.

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { extendScenario, extendsName, parseYaml, type Diag, type SourceFile } from '@montecrit/engine';
import { privateMarker } from '@montecrit/host';

// The marker lives in @montecrit/host so the browser bundle checks the same shapes.
export { privateMarker };

export const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');

const YAML_EXT = /\.ya?ml$/i;

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** True when child is parent or sits inside it. */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Under the repo root, judged both lexically and after resolving symlinks. */
export function isUnderRepo(path: string, repoRoot: string = REPO_ROOT): boolean {
  const lexical = resolve(path);
  const roots = [resolve(repoRoot), real(repoRoot)];
  return roots.some((r) => isInside(lexical, r) || isInside(real(lexical), r));
}

/** .yaml/.yml files under each path (a file path is taken as is), absolute and sorted. */
export function collectYaml(paths: readonly string[]): { files: string[]; errors: Diag[] } {
  const out = new Set<string>();
  const errors: Diag[] = [];
  const visited = new Set<string>();
  const walk = (dir: string) => {
    const r = real(dir);
    if (visited.has(r)) return; // symlink cycle
    visited.add(r);
    for (const name of readdirSync(dir).sort(byString)) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue; // dangling symlink
      }
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && YAML_EXT.test(name)) out.add(p);
    }
  };
  for (const raw of paths) {
    const p = resolve(raw);
    if (!existsSync(p)) {
      errors.push({ path: raw, line: 0, col: 0, message: 'no such file or folder' });
      continue;
    }
    if (statSync(p).isDirectory()) walk(p);
    else out.add(p);
  }
  return { files: [...out].sort(byString), errors };
}

export interface ReadResult {
  readonly files: SourceFile[];
  /** Unreadable paths and refused private files. */
  readonly errors: Diag[];
}

/** Reads the YAML under paths. Files under the repo root with private content are refused, not read in. */
export function readYamlFiles(paths: readonly string[], repoRoot: string = REPO_ROOT): ReadResult {
  const { files: found, errors } = collectYaml(paths);
  const files: SourceFile[] = [];
  for (const path of found) {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (e) {
      errors.push({ path, line: 0, col: 0, message: `can't read it: ${(e as Error).message}` });
      continue;
    }
    if (isUnderRepo(path, repoRoot)) {
      const m = privateMarker(text);
      if (m) {
        errors.push({
          path,
          line: m.line,
          col: 1,
          message: `refused: ${m.what} under the repo root; private content lives in ~/.montecrit/, never in the repo`,
        });
        continue;
      }
    }
    files.push({ path, text });
  }
  return { files, errors };
}

export interface ScenarioInput {
  /** YAML text, or the merged document for a scenario that extends another. */
  readonly input: unknown;
  readonly path: string;
  /** The base file when it extends one. */
  readonly base: string | null;
  readonly errors: Diag[];
}

/**
 * Reads one scenario file. One that `extends` another is merged with its base, found by name in
 * the repo's scenarios/ folder, then in its own folder, then in scenarios/golden/ (never itself). A merged scenario's
 * diagnostics carry no line numbers.
 */
export function readScenarioInput(path: string, repoRoot: string = REPO_ROOT): ScenarioInput {
  const read = readYamlFiles([path], repoRoot);
  const fail = (errors: Diag[]): ScenarioInput => ({ input: null, path, base: null, errors });
  if (read.errors.length || read.files.length !== 1) return fail(read.errors.length ? read.errors : [{ path, line: 0, col: 0, message: "can't read it" }]);
  const file = read.files[0]!;
  const parsed = parseYaml(file.text, file.path);
  const name = parsed.doc ? extendsName(parsed.doc.value) : null;
  if (!parsed.doc || name === null) return { input: file.text, path: file.path, base: null, errors: [] };
  const self = realpathSync(file.path);
  const base = [join(repoRoot, 'scenarios', `${name}.yaml`), join(dirname(file.path), `${name}.yaml`), join(repoRoot, 'scenarios', 'golden', `${name}.yaml`)].find((p) => existsSync(p) && realpathSync(p) !== self);
  if (!base) return fail([{ path: file.path, line: 0, col: 0, message: `extends: no scenario "${name}" in the repo's scenarios/ folder, scenarios/golden/ or next to this file` }]);
  const baseRead = readYamlFiles([base], repoRoot);
  if (baseRead.errors.length || baseRead.files.length !== 1) return fail(baseRead.errors);
  const baseDoc = parseYaml(baseRead.files[0]!.text, base);
  if (!baseDoc.doc) return fail(baseDoc.errors);
  const merged = extendScenario(parsed.doc.value, baseDoc.doc.value);
  if (merged.value === null) return fail(merged.errors.map((message) => ({ path: file.path, line: 0, col: 0, message })));
  return { input: merged.value, path: file.path, base, errors: [] };
}

/** A path for messages: relative to cwd when inside it, ~/... under home, else absolute. */
export function displayPath(path: string, cwd: string = process.cwd()): string {
  if (!isAbsolute(path)) return path;
  if (isInside(path, cwd)) return relative(cwd, path) || '.';
  const home = homedir();
  if (isInside(path, home)) return `~/${relative(home, path)}`;
  return path;
}

/** The folder holding the nearest manifest.yaml at or above path, if any. */
export function enclosingPack(path: string): string | undefined {
  let dir = resolve(path);
  if (existsSync(dir) && !statSync(dir).isDirectory()) dir = dirname(dir);
  for (;;) {
    if (existsSync(join(dir, 'manifest.yaml'))) return dir;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/** True when path names an existing file (not a folder). */
export function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

/** The real path of the nearest existing folder at or above p (p itself may not exist yet). */
function realDirOf(p: string): string {
  let d = p;
  while (!existsSync(d) && dirname(d) !== d) d = dirname(d);
  return realpathSync.native(d);
}

/**
 * Why a new content file can't be written at target, or null when it can. Never into the repo's
 * packs/ folder (judged as written, after resolving symlinks, and case-insensitively for
 * case-insensitive file systems), never over an existing file or symlink, only .yaml/.yml, and
 * never a private id anywhere under the repo root (rule 2).
 */
export function refuseNewFile(target: string, text: string, repoRoot: string = REPO_ROOT): string | null {
  const abs = resolve(target);
  if (!YAML_EXT.test(abs)) return `${displayPath(abs)}: a content file ends in .yaml or .yml`;
  if (existsSync(abs) || isSymlink(abs)) return `${displayPath(abs)} already exists; it is never overwritten (give another path)`;
  const packs = join(repoRoot, 'packs');
  const realPacks = existsSync(packs) ? realpathSync.native(packs) : packs;
  const realParent = realDirOf(dirname(abs));
  const insidePacks =
    isInside(abs, packs) ||
    isInside(join(realParent, basename(abs)), realPacks) ||
    (realParent + sep).toLowerCase().startsWith((realPacks + sep).toLowerCase());
  if (insidePacks) return `${displayPath(abs)} is inside the repo's packs/ folder; write characters somewhere else (packs are generated or hand-reviewed content)`;
  const m = privateMarker(text);
  if (m && (isUnderRepo(abs, repoRoot) || isInside(realParent, realDirOf(repoRoot)))) {
    return `${displayPath(abs)} is under the repo root and the file would carry ${m.what}; private content lives in ~/.montecrit/ (or give a test: id with --id)`;
  }
  if (!existsSync(dirname(abs))) return `${displayPath(dirname(abs))}: no such folder`;
  return null;
}

/** True when target (which may not exist yet) would be written under the repo root, judged as refuseNewFile judges it. */
export function landsInRepo(target: string, repoRoot: string = REPO_ROOT): boolean {
  const abs = resolve(target);
  return isUnderRepo(abs, repoRoot) || isInside(realDirOf(dirname(abs)), realDirOf(repoRoot));
}

/**
 * Why a file read from source is private content, or null: its own text carries a private id or
 * license, the pack it sits in has a private manifest, or it lives under one of the given private
 * folders (the home folder and its characters folder). migrate uses it so a private pc can't be
 * written into the repo under a relabelled test: id (rule 2).
 */
export function privateSource(source: string, text: string, privateDirs: readonly string[]): string | null {
  const own = privateMarker(text);
  if (own) return `it carries ${own.what}`;
  const pack = enclosingPack(source);
  if (pack !== undefined) {
    const manifest = join(pack, 'manifest.yaml');
    let mtext = '';
    try {
      mtext = readFileSync(manifest, 'utf8');
    } catch {
      mtext = '';
    }
    const m = privateMarker(mtext);
    if (m) return `its pack's manifest (${displayPath(manifest)}) carries ${m.what}`;
  }
  const abs = resolve(source);
  for (const d of privateDirs) if (isInside(abs, resolve(d)) || isInside(real(abs), real(resolve(d)))) return `it is under ${displayPath(d)}`;
  return null;
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Writes a new content file after refuseNewFile's checks; the error, or null. Exclusive create: never replaces a file. */
export function writeNewFile(target: string, text: string, repoRoot: string = REPO_ROOT): string | null {
  const why = refuseNewFile(target, text, repoRoot);
  if (why !== null) return why;
  try {
    writeFileSync(resolve(target), text, { flag: 'wx' });
    return null;
  } catch (e) {
    return `can't write ${displayPath(resolve(target))}: ${(e as Error).message}`;
  }
}
