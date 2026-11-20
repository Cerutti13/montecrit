// ~/.montecrit: the private side. config.yaml lists extra pack folders; a missing file is
// fine. Pack lookup is the repo's packs/* plus those, plus the characters folder
// (<home>/characters, or config.yaml's characters:). Character files there load as a private
// pack named "characters"; it needs no manifest.yaml of its own (one is supplied when it has
// none). MONTECRIT_HOME points elsewhere (tests).

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { loadContent, parseYaml, type Diag, type LoadResult, type SourceFile } from '@montecrit/engine';
import { policiesFrom, type Policies } from '@montecrit/host';
import { REPO_ROOT, enclosingPack, isUnderRepo, readYamlFiles } from './files.ts';

export type Env = Readonly<Record<string, string | undefined>>;

/** The user's home folder: env.HOME when the caller passes one (tests), else the OS's. */
function userHome(env: Env): string {
  return env.HOME ?? homedir();
}

export function homeDir(env: Env = process.env): string {
  return env.MONTECRIT_HOME ?? join(userHome(env), '.montecrit');
}

/** Expands ~/ and resolves relative paths against the home folder. */
function homePath(p: string, home: string, env: Env): string {
  if (p === '~' || p.startsWith('~/')) return join(userHome(env), p.slice(1));
  return resolve(home, p);
}

export interface HomeConfig {
  readonly packs: string[];
  /** The characters folder (absolute). */
  readonly characters: string;
  readonly errors: Diag[];
}

/** The manifest a characters folder without its own gets: private, like everything in ~/.montecrit. */
export const CHARACTERS_MANIFEST = "kind: manifest\npack: characters\nversion: '1'\nrules: '2024'\nnamespace: private\nlicense: private\n";

/** Reads ~/.montecrit/config.yaml: { packs: [folders], characters?: folder }. */
export function readHomeConfig(env: Env = process.env): HomeConfig {
  const home = homeDir(env);
  const characters = join(home, 'characters');
  const path = join(home, 'config.yaml');
  if (!existsSync(path)) return { packs: [], characters, errors: [] };
  const { doc, errors } = parseYaml(readFileSync(path, 'utf8'), path);
  if (!doc) return { packs: [], characters, errors };
  const v = doc.value;
  const bad = (message: string, at: (string | number)[] = []) => {
    const { line, col } = doc.at(at);
    return { packs: [], characters, errors: [{ path, line, col, message }] };
  };
  if (v === null || v === undefined) return { packs: [], characters, errors: [] };
  if (typeof v !== 'object' || Array.isArray(v)) return bad('expected a map like { packs: [folders] }');
  const cfg = v as Record<string, unknown>;
  for (const key of Object.keys(cfg)) if (key !== 'packs' && key !== 'characters') return bad(`unknown key "${key}"`, [key]);
  const packs = cfg.packs ?? [];
  if (!Array.isArray(packs) || packs.some((p) => typeof p !== 'string')) return bad('packs must be a list of folders', ['packs']);
  if (cfg.characters !== undefined && typeof cfg.characters !== 'string') return bad('characters must be a folder', ['characters']);
  return {
    packs: (packs as string[]).map((p) => homePath(p, home, env)),
    characters: typeof cfg.characters === 'string' ? homePath(cfg.characters, home, env) : characters,
    errors: [],
  };
}

/** The characters folder, when it exists: character files (kind: pc) live there. */
export function charactersDir(env: Env = process.env): string | null {
  const dir = readHomeConfig(env).characters;
  return existsSync(dir) && statSync(dir).isDirectory() ? dir : null;
}

/** Folders directly under dir that hold a manifest.yaml, sorted. */
function packFoldersIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => !n.startsWith('.'))
    .map((n) => join(dir, n))
    .filter((p) => statSync(p).isDirectory() && existsSync(join(p, 'manifest.yaml')))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Every known pack folder: the repo's packs/* then the home config's packs. */
export function packDirs(env: Env = process.env, repoRoot: string = REPO_ROOT): { dirs: string[]; errors: Diag[] } {
  const cfg = readHomeConfig(env);
  const errors = [...cfg.errors];
  for (const p of cfg.packs) {
    if (!existsSync(join(p, 'manifest.yaml'))) errors.push({ path: p, line: 0, col: 0, message: 'listed in config.yaml packs but has no manifest.yaml' });
  }
  const dirs = [...packFoldersIn(join(repoRoot, 'packs')), ...cfg.packs.filter((p) => existsSync(join(p, 'manifest.yaml')))];
  const chars = charactersDir(env);
  if (chars !== null) dirs.push(chars);
  return { dirs: [...new Set(dirs)], errors };
}

export interface Loaded extends LoadResult {
  readonly files: readonly SourceFile[];
}

/** Reads every known pack folder plus any extra paths. A characters folder with no manifest gets the private one. */
export function readKnown(env: Env = process.env, extra: readonly string[] = [], repoRoot: string = REPO_ROOT): { files: SourceFile[]; errors: Diag[] } {
  const { dirs, errors } = packDirs(env, repoRoot);
  const read = readYamlFiles([...dirs, ...extra], repoRoot);
  const chars = charactersDir(env);
  const files = [...read.files];
  if (chars !== null && !existsSync(join(chars, 'manifest.yaml')) && !isUnderRepo(chars, repoRoot)) {
    files.push({ path: join(chars, 'manifest.yaml'), text: CHARACTERS_MANIFEST });
  }
  return { files, errors: [...errors, ...read.errors] };
}

/**
 * Reads and loads every known pack, plus extra files already read (loadWithFiles). Read errors
 * count as load errors. sheets is every kind: character's derived sheet (LoadResult.sheets).
 */
export function loadKnown(env: Env = process.env, repoRoot: string = REPO_ROOT, extra: readonly SourceFile[] = [], extraErrors: readonly Diag[] = []): Loaded {
  const read = readKnown(env, [], repoRoot);
  const files = [...read.files, ...extra];
  const r = loadContent(files);
  const errors = [...read.errors, ...extraErrors, ...r.errors];
  return { content: errors.length > 0 ? null : r.content, errors, warnings: r.warnings, sheets: r.sheets ?? [], files };
}

/** A content file named on the command line, as the load saw it. */
export interface FileTarget {
  /** Absolute path. */
  readonly path: string;
  /** Its item's id and kind, when it has exactly one item with a string id. */
  readonly id: string | null;
  readonly kind: string | null;
  /** The pack it loaded in (a known pack, its own enclosing pack, or a supplied loose-N pack). */
  readonly pack: string | null;
}

export const kebab = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'file';

/** The manifest a loose file (no manifest.yaml above it) is loaded under: its id's namespace, never srd. */
export function looseManifest(pack: string, ns: string): string | null {
  if (ns === 'test') return `kind: manifest\npack: ${pack}\nversion: '1'\nrules: '2024'\nnamespace: test\nlicense: test\n`;
  if (ns === 'private') return `kind: manifest\npack: ${pack}\nversion: '1'\nrules: '2024'\nnamespace: private\nlicense: private\n`;
  return null;
}

/** The pack name in a manifest's text, if it parses. */
function packNameOf(text: string, path: string): string | null {
  const { doc } = parseYaml(text, path);
  const v = doc?.value as Record<string, unknown> | null | undefined;
  return v && typeof v === 'object' && typeof v.pack === 'string' ? v.pack : null;
}

/** The one item's id and kind in a content file's text. */
export function itemOf(text: string, path: string): { id: string | null; kind: string | null } {
  const { doc } = parseYaml(text, path);
  const v = doc?.value as Record<string, unknown> | null | undefined;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { id: null, kind: null };
  return { id: typeof v.id === 'string' ? v.id : null, kind: typeof v.kind === 'string' ? v.kind : null };
}

/**
 * Every known pack plus content files named on the command line. A file inside a known pack is
 * already there; one inside another pack folder brings that whole pack; a loose file (no
 * manifest.yaml above it) loads alone under a supplied manifest beside it (in memory, never
 * written) whose namespace is its id's: test: or private: only. Files under the repo with private
 * content are refused as always (readYamlFiles).
 */
export function loadWithFiles(paths: readonly string[], env: Env = process.env, repoRoot: string = REPO_ROOT): { loaded: Loaded; targets: FileTarget[] } {
  const known = readKnown(env, [], repoRoot);
  const knownPaths = new Set(known.files.map((f) => f.path));
  const knownDirs = new Set(packDirs(env, repoRoot).dirs.map((d) => resolve(d)));
  const extra: SourceFile[] = [];
  const errors: Diag[] = [];
  const targets: FileTarget[] = [];
  const nearestKnownPack = (path: string): string | null => {
    for (let dir = dirname(path); ; dir = dirname(dir)) {
      const m = join(dir, 'manifest.yaml');
      const f = known.files.find((x) => x.path === m) ?? extra.find((x) => x.path === m);
      if (f) return packNameOf(f.text, f.path);
      if (dirname(dir) === dir) return null;
    }
  };
  const looseByDir = new Map<string, { pack: string; ns: string }>();
  for (const raw of paths) {
    const abs = resolve(raw);
    const read = readYamlFiles([abs], repoRoot);
    if (read.errors.length > 0 || read.files.length !== 1) {
      errors.push(...(read.errors.length ? read.errors : [{ path: abs, line: 0, col: 0, message: "can't read it" }]));
      targets.push({ path: abs, id: null, kind: null, pack: null });
      continue;
    }
    const file = read.files[0]!;
    const { id, kind } = itemOf(file.text, file.path);
    if (knownPaths.has(file.path) || extra.some((x) => x.path === file.path)) {
      targets.push({ path: file.path, id, kind, pack: nearestKnownPack(file.path) });
      continue;
    }
    const packDir = enclosingPack(file.path);
    if (packDir !== undefined && !knownDirs.has(resolve(packDir))) {
      const pack = readYamlFiles([packDir], repoRoot);
      errors.push(...pack.errors);
      for (const f of pack.files) if (!knownPaths.has(f.path) && !extra.some((x) => x.path === f.path)) extra.push(f);
      knownDirs.add(resolve(packDir));
      targets.push({ path: file.path, id, kind, pack: nearestKnownPack(file.path) });
      continue;
    }
    // Loose: one supplied manifest per folder.
    const ns = id !== null && id.includes(':') ? id.slice(0, id.indexOf(':')) : '';
    const dir = dirname(file.path);
    let lp = looseByDir.get(dir);
    if (lp === undefined) {
      const name = `loose-${looseByDir.size + 1}-${kebab(basename(dir))}`;
      const text = looseManifest(name, ns);
      if (text === null) {
        errors.push({ path: file.path, line: 0, col: 0, message: `not inside a pack, and a file loaded on its own needs a test: or private: id (this one is ${id ?? 'missing'}); put it in a pack folder with a manifest.yaml` });
        targets.push({ path: file.path, id, kind, pack: null });
        continue;
      }
      lp = { pack: name, ns };
      looseByDir.set(dir, lp);
      extra.push({ path: join(dir, 'manifest.yaml'), text });
    } else if (lp.ns !== ns) {
      errors.push({ path: file.path, line: 0, col: 0, message: `loose files in one folder load as one pack: this one's namespace (${ns}) differs from ${lp.ns}` });
      targets.push({ path: file.path, id, kind, pack: null });
      continue;
    }
    extra.push(file);
    targets.push({ path: file.path, id, kind, pack: lp.pack });
  }
  const r = loadContent([...known.files, ...extra]);
  const all = [...known.errors, ...errors, ...r.errors];
  return { loaded: { content: all.length > 0 ? null : r.content, errors: all, warnings: r.warnings, sheets: r.sheets ?? [], files: [...known.files, ...extra] }, targets };
}

export interface LoadedPolicies extends Policies {
  /** The policy files read, repo before home (what a worker rebuilds them from). */
  readonly files: readonly SourceFile[];
}

/**
 * Every policy: the built-ins, then the repo's policies/ folder (SRD and test ids only), then
 * ~/.montecrit/policies/ (private). Two with one id is an error.
 */
export function loadPolicies(env: Env = process.env, repoRoot: string = REPO_ROOT): LoadedPolicies {
  const dirs = [join(repoRoot, 'policies'), join(homeDir(env), 'policies')].filter((d) => existsSync(d));
  const read = readYamlFiles(dirs, repoRoot);
  const p = policiesFrom(read.files);
  return { byId: p.byId, errors: [...read.errors, ...p.errors], files: read.files };
}

