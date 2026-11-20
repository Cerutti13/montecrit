// Fills the import cache (docs/design/m3.md 4.1-4.2, C2, C5, C17). Never the repo, never
// ~/.montecrit: the cache is $XDG_CACHE_HOME/montecrit/import or ~/Library/Caches/montecrit/import
// (util.ts cacheRoot refuses anything else).
//
//   node tools/import-srd/fetch.ts                 download whatever is missing (network)
//   node tools/import-srd/fetch.ts --offline       fail instead of downloading
//   --seed-foundry <src.tgz>  --seed-pdf <srd.pdf>  --seed-open5e <dir>  --seed-bits <dir>
//                                                  copy local files in, after checking their sha256
//   --print-tree                                   print the extracted tree's hash (for re-pinning)
//
// Downloads are untrusted data. Nothing here executes them: the tarball is listed, checked
// (regular files only, no '..', no absolute paths, only the pinned extract paths) and
// extracted with tar into a fresh empty directory, then walked again with lstat. The
// importer parses the YAML with the yaml package and the JSON with JSON.parse.
//
// The Foundry tarball is pinned twice: by its sha256 (GitHub archive tarballs aren't
// guaranteed byte-stable, so a mismatch is a loud warning) and by a tree hash over the
// extracted files (sorted path + sha256; a mismatch fails closed).

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadPins, type PinnedFile, type Pins } from './pins.ts';
import { byString, cachePaths, sha256, type CachePaths } from './util.ts';

export interface TreeEntry {
  /** Repo-relative inside the Foundry repository, e.g. packs/_source/classes24/fighter/fighter.yml. */
  readonly path: string;
  readonly sha256: string;
}

/** True when a repo-relative file path is one the pins allow extracting. */
export function allowedPath(rel: string, extract: readonly string[]): boolean {
  if (rel.includes('\\') || rel.split('/').some((s) => s === '..' || s === '.' || s === '')) return false;
  return extract.some((e) => (e.endsWith('/') ? rel.startsWith(e) : rel === e));
}

/** sha256 over "sha256  path\n" lines, sorted by path with < (shasum's line format). */
export function treeHash(entries: readonly TreeEntry[]): string {
  const sorted = [...entries].sort((a, b) => byString(a.path, b.path));
  return sha256(sorted.map((e) => `${e.sha256}  ${e.path}\n`).join(''));
}

interface Member {
  readonly name: string;
  readonly type: string;
}

/** The tarball's members with their type letters ('-' file, 'd' dir, 'l' symlink, 'h' hard link, ...). */
export function listTarball(tgz: string): Member[] {
  const names = execFileSync('tar', ['-tzf', tgz], { maxBuffer: 256 * 1024 * 1024 }).toString('utf8').split('\n').filter(Boolean);
  const verbose = execFileSync('tar', ['-tvzf', tgz], { maxBuffer: 256 * 1024 * 1024 }).toString('utf8').split('\n').filter(Boolean);
  if (names.length !== verbose.length) throw new Error(`tarball listing is inconsistent (${names.length} names, ${verbose.length} entries); refusing it`);
  return names.map((name, i) => ({ name, type: verbose[i]![0]! }));
}

/** Walks a directory with lstat: every entry must be a plain directory or regular file. Paths are relative, posix. */
export function walkPlain(dir: string, base = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort(byString)) {
    const abs = join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) throw new Error(`${rel} is a symlink; refusing the tree`);
    if (st.isDirectory()) out.push(...walkPlain(abs, rel));
    else if (st.isFile()) out.push(rel);
    else throw new Error(`${rel} is not a regular file; refusing the tree`);
  }
  return out;
}

export interface Extracted {
  /** The Foundry repository root inside the fresh directory. */
  readonly dir: string;
  /** The fresh directory itself (remove it when done). */
  readonly fresh: string;
  readonly entries: readonly TreeEntry[];
  readonly treeSha256: string;
}

/**
 * Extracts only the pinned paths of the tarball into a new, empty directory under `parent`.
 * Every member is checked before tar runs, and the result is walked again afterwards.
 */
export function extractFoundry(tgz: string, foundry: Pins['foundry'], parent: string): Extracted {
  mkdirSync(parent, { recursive: true });
  const prefix = `${foundry.root}/`;
  const wanted: string[] = [];
  for (const m of listTarball(tgz)) {
    if (m.name.startsWith('/') || m.name.split('/').includes('..')) throw new Error(`tarball member ${m.name} escapes its root; refusing the tarball`);
    if (!m.name.startsWith(prefix) && m.name !== prefix) throw new Error(`tarball member ${m.name} is outside ${foundry.root}/; refusing the tarball`);
    const rel = m.name.slice(prefix.length).replace(/\/$/, '');
    if (m.type === 'd') continue;
    if (!allowedPath(rel, foundry.extract)) continue;
    if (m.type !== '-') throw new Error(`tarball member ${m.name} is type '${m.type}', not a regular file; refusing the tarball`);
    wanted.push(m.name);
  }
  if (wanted.length === 0) throw new Error('the tarball holds none of the pinned extract paths');
  const fresh = mkdtempSync(join(parent, 'extract-'));
  if (readdirSync(fresh).length !== 0) throw new Error(`${fresh} is not empty`);
  const listDir = mkdtempSync(join(parent, 'list-'));
  const listFile = join(listDir, 'members.txt');
  try {
    writeFileSync(listFile, `${wanted.join('\n')}\n`);
    execFileSync('tar', ['-xzf', tgz, '-C', fresh, '-T', listFile], { stdio: ['ignore', 'ignore', 'pipe'] });
  } finally {
    rmSync(listDir, { recursive: true, force: true });
  }
  const top = readdirSync(fresh);
  if (top.length !== 1 || top[0] !== foundry.root) throw new Error(`extraction produced ${top.join(', ')}, expected only ${foundry.root}`);
  const dir = join(fresh, foundry.root);
  const got = walkPlain(dir);
  const want = new Set(wanted.map((w) => w.slice(prefix.length)));
  for (const rel of got) if (!want.has(rel) || !allowedPath(rel, foundry.extract)) throw new Error(`extraction wrote ${rel}, which was not requested`);
  if (got.length !== want.size) throw new Error(`extraction wrote ${got.length} files, expected ${want.size}`);
  const entries = got.map((path) => ({ path, sha256: sha256(readFileSync(join(dir, path))) }));
  return { dir, fresh, entries, treeSha256: treeHash(entries) };
}

/** The tree hash of an already-extracted tree (main.ts checks it before reading anything). */
export function hashTree(dir: string, extract: readonly string[]): { entries: TreeEntry[]; treeSha256: string } {
  const files = walkPlain(dir);
  for (const rel of files) if (!allowedPath(rel, extract)) throw new Error(`${rel} in the extracted tree is not a pinned extract path`);
  const entries = files.map((path) => ({ path, sha256: sha256(readFileSync(join(dir, path))) }));
  return { entries, treeSha256: treeHash(entries) };
}

export type OnMismatch = 'fail' | 'warn';

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

const consoleLog: Logger = { info: (m) => console.log(m), warn: (m) => console.warn(`WARNING: ${m}`) };

function checkHash(what: string, got: string, want: string, onMismatch: OnMismatch, log: Logger): void {
  if (got === want) return;
  const msg = `${what}: sha256 ${got} does not match the pin ${want}`;
  if (onMismatch === 'fail') throw new Error(msg);
  log.warn(`${msg}. GitHub archive tarballs aren't guaranteed byte-stable; the tree hash decides.`);
}

/** Copies a local file into the cache after checking its sha256 (write to a temp name, then rename). */
export function seedFile(src: string, dest: string, want: string, onMismatch: OnMismatch, log: Logger = consoleLog): void {
  const got = sha256(readFileSync(src));
  checkHash(src, got, want, onMismatch, log);
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.partial`;
  copyFileSync(src, tmp);
  if (sha256(readFileSync(tmp)) !== got) throw new Error(`${dest}: copy changed under us`);
  renameSync(tmp, dest);
}

/** Downloads a pinned URL into the cache (not exercised in tests; the seed path is). */
export async function download(url: string, dest: string, want: string, onMismatch: OnMismatch, log: Logger = consoleLog): Promise<void> {
  log.info(`downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  checkHash(url, sha256(buf), want, onMismatch, log);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(`${dest}.partial`, buf);
  renameSync(`${dest}.partial`, dest);
}

const cachedOk = (file: string, want: string): boolean => existsSync(file) && sha256(readFileSync(file)) === want;

/**
 * Extracts the cached tarball into a fresh directory, checks the tree hash against the pin
 * and swaps it in as <cache>/foundry/tree. A tree mismatch fails closed and leaves the old
 * tree alone.
 */
export function installTree(paths: CachePaths, pins: Pins, log: Logger = consoleLog, opts: { readonly allowUnpinned?: boolean } = {}): Extracted {
  const ex = extractFoundry(paths.foundryTgz, pins.foundry, paths.foundryDir);
  try {
    if (ex.treeSha256 !== pins.foundry.treeSha256 || ex.entries.length !== pins.foundry.treeFiles) {
      const msg = `extracted tree hash ${ex.treeSha256} (${ex.entries.length} files) does not match the pin ${pins.foundry.treeSha256} (${pins.foundry.treeFiles} files)`;
      if (!opts.allowUnpinned) throw new Error(`${msg}; fail closed`);
      log.warn(msg);
    }
    rmSync(paths.foundryTree, { recursive: true, force: true });
    renameSync(ex.dir, paths.foundryTree);
  } finally {
    rmSync(ex.fresh, { recursive: true, force: true });
  }
  log.info(`foundry tree: ${ex.entries.length} files, tree sha256 ${ex.treeSha256}`);
  return ex;
}

interface Args {
  offline: boolean;
  printTree: boolean;
  seedFoundry?: string;
  seedPdf?: string;
  seedOpen5e?: string;
  seedBits?: string;
}

function parseArgs(argv: readonly string[]): Args {
  const a: Args = { offline: false, printTree: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    const v = () => {
      const x = argv[++i];
      if (x === undefined) throw new Error(`${k} needs a value`);
      return x;
    };
    if (k === '--offline') a.offline = true;
    else if (k === '--print-tree') a.printTree = true;
    else if (k === '--seed-foundry') a.seedFoundry = v();
    else if (k === '--seed-pdf') a.seedPdf = v();
    else if (k === '--seed-open5e') a.seedOpen5e = v();
    else if (k === '--seed-bits') a.seedBits = v();
    else throw new Error(`unknown flag ${k}`);
  }
  return a;
}

async function fill(dest: string, url: string, want: string, onMismatch: OnMismatch, seed: string | undefined, offline: boolean, log: Logger): Promise<boolean> {
  if (seed !== undefined) {
    seedFile(seed, dest, want, onMismatch, log);
    return true;
  }
  if (cachedOk(dest, want) || (onMismatch === 'warn' && existsSync(dest))) return false;
  if (offline) throw new Error(`${dest} is missing or stale and --offline is set`);
  await download(url, dest, want, onMismatch, log);
  return true;
}

async function fillGroup(dir: string, base: string, files: Readonly<Record<string, PinnedFile>>, seedDir: string | undefined, offline: boolean, log: Logger): Promise<void> {
  for (const name of Object.keys(files).sort(byString)) {
    const f = files[name]!;
    await fill(join(dir, name), `${base}${f.remote}`, f.sha256, 'fail', seedDir === undefined ? undefined : join(seedDir, name), offline, log);
  }
}

export async function runFetch(argv: readonly string[], paths: CachePaths = cachePaths(), pins: Pins = loadPins(), log: Logger = consoleLog): Promise<void> {
  const a = parseArgs(argv);
  log.info(`import cache: ${paths.root}`);
  const newTgz = await fill(paths.foundryTgz, pins.foundry.tarballUrl, pins.foundry.tarballSha256, 'warn', a.seedFoundry, a.offline, log);
  await fill(paths.pdf, pins.pdf.url, pins.pdf.sha256, 'fail', a.seedPdf, a.offline, log);
  await fillGroup(paths.open5eDir, pins.open5e.base, pins.open5e.files, a.seedOpen5e, a.offline, log);
  await fillGroup(paths.bitsDir, pins.bits.base, pins.bits.files, a.seedBits, a.offline, log);
  if (newTgz || !existsSync(paths.foundryTree) || a.printTree) {
    installTree(paths, pins, log, { allowUnpinned: a.printTree });
  } else {
    const t = hashTree(paths.foundryTree, pins.foundry.extract);
    if (t.treeSha256 !== pins.foundry.treeSha256) throw new Error(`cached tree hash ${t.treeSha256} does not match the pin; delete ${paths.foundryTree} and rerun`);
    log.info(`foundry tree: cached, ${t.entries.length} files, matches the pin`);
  }
}

if (import.meta.main) {
  runFetch(process.argv.slice(2)).catch((e: unknown) => {
    console.error(`fetch: ${(e as Error).message}`);
    process.exitCode = 1;
  });
}
