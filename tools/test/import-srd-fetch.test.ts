// fetch.ts on synthetic tarballs: hashes are verified, only the pinned paths are extracted
// into a fresh directory, links and escapes are refused, a tree mismatch fails closed, and
// the cache can never be the repo or the private home (checked by path only).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { allowedPath, extractFoundry, hashTree, installTree, seedFile, treeHash, type Logger } from '../import-srd/fetch.ts';
import type { Pins } from '../import-srd/pins.ts';
import { assertCacheDir, cachePaths, REPO_ROOT, sha256 } from '../import-srd/util.ts';
import { COMMIT, testPins } from './import-srd-helpers.ts';

const temps: string[] = [];
const temp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'montecrit-fetch-test-'));
  temps.push(d);
  return d;
};
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ROOT = `dnd5e-${COMMIT}`;

/** Builds a tarball shaped like GitHub's archive of the pinned commit. */
function tarball(files: Readonly<Record<string, string>>, opts: { link?: string } = {}): string {
  const src = temp();
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(src, ROOT, rel, '..'), { recursive: true });
    writeFileSync(join(src, ROOT, rel), text);
  }
  if (opts.link) {
    mkdirSync(join(src, ROOT, opts.link, '..'), { recursive: true });
    symlinkSync('/etc/hosts', join(src, ROOT, opts.link));
  }
  const out = join(temp(), 'src.tgz');
  execFileSync('tar', ['-czf', out, '-C', src, ROOT]);
  return out;
}

const FILES = {
  'packs/_source/classes24/fighter/fighter.yml': 'name: Fighter\n',
  'packs/_source/classes24/fighter/_folder.yml': 'name: Fighter\n',
  'packs/_source/equipment24/weapons/longsword.yml': 'name: Longsword\n',
  'packs/_source/content24/chapter-7/spells.yml': 'name: Spells\n',
  // never extracted:
  'packs/_source/content24/chapter-1/intro.yml': 'name: Intro\n',
  'packs/_source/tables24/spells/a.yml': 'name: Table\n',
  'packs/_source/monsterfeatures24/actions/x.yml': 'name: X\n',
  'module/config.mjs': 'export const X = 1;\n',
  'tokens/beast/wolf.webp': 'not an image',
  'README.md': '# readme\n',
};
const KEPT = ['packs/_source/classes24/fighter/_folder.yml', 'packs/_source/classes24/fighter/fighter.yml', 'packs/_source/content24/chapter-7/spells.yml', 'packs/_source/equipment24/weapons/longsword.yml'];

const quiet = (): Logger & { warnings: string[] } => {
  const warnings: string[] = [];
  return { warnings, info: () => {}, warn: (m) => warnings.push(m) };
};

describe('fetch: extraction', () => {
  const pins = testPins();

  it('keeps only the pinned paths, in a fresh directory, with a stable tree hash', () => {
    const tgz = tarball(FILES);
    const parent = temp();
    const ex = extractFoundry(tgz, pins.foundry, parent);
    expect(ex.entries.map((e) => e.path)).toEqual(KEPT);
    expect(existsSync(join(ex.dir, 'module'))).toBe(false);
    expect(existsSync(join(ex.dir, 'packs/_source/tables24'))).toBe(false);
    expect(existsSync(join(ex.dir, 'packs/_source/content24/chapter-1'))).toBe(false);
    expect(ex.entries[1]!.sha256).toBe(sha256('name: Fighter\n'));
    const again = extractFoundry(tgz, pins.foundry, parent);
    expect(again.fresh).not.toBe(ex.fresh);
    expect(again.treeSha256).toBe(ex.treeSha256);
    expect(hashTree(ex.dir, pins.foundry.extract).treeSha256).toBe(ex.treeSha256);
    expect(treeHash([...ex.entries].reverse())).toBe(ex.treeSha256);
  });

  it('refuses links, escapes and members outside the root', () => {
    expect(() => extractFoundry(tarball(FILES, { link: 'packs/_source/classes24/evil.yml' }), pins.foundry, temp())).toThrow(/not a regular file/);
    const src = temp();
    mkdirSync(join(src, 'other'), { recursive: true });
    writeFileSync(join(src, 'other', 'x.yml'), 'x');
    const bad = join(temp(), 'bad.tgz');
    execFileSync('tar', ['-czf', bad, '-C', src, 'other']);
    expect(() => extractFoundry(bad, pins.foundry, temp())).toThrow(/outside/);
  });

  it('allowedPath: exact files, folder prefixes, no dot segments', () => {
    const ex = pins.foundry.extract;
    expect(allowedPath('packs/_source/classes24/a/b.yml', ex)).toBe(true);
    expect(allowedPath('packs/_source/content24/chapter-7/spells.yml', ex)).toBe(true);
    expect(allowedPath('packs/_source/content24/chapter-7/other.yml', ex)).toBe(false);
    expect(allowedPath('packs/_source/classes24/../tables24/a.yml', ex)).toBe(false);
    expect(allowedPath('packs/_source/classes24x/a.yml', ex)).toBe(false);
    expect(allowedPath('packs/_source/tables24/a.yml', ex)).toBe(false);
  });
});

describe('fetch: hashes and the cache', () => {
  it('seeding checks sha256: a mismatch fails, or only warns for the tarball', () => {
    const dir = temp();
    const src = join(dir, 'in.bin');
    writeFileSync(src, 'payload');
    seedFile(src, join(dir, 'cache', 'a.bin'), sha256('payload'), 'fail');
    expect(readFileSync(join(dir, 'cache', 'a.bin'), 'utf8')).toBe('payload');
    expect(() => seedFile(src, join(dir, 'cache', 'b.bin'), 'f'.repeat(64), 'fail')).toThrow(/does not match the pin/);
    expect(existsSync(join(dir, 'cache', 'b.bin'))).toBe(false);
    const log = quiet();
    seedFile(src, join(dir, 'cache', 'c.bin'), 'f'.repeat(64), 'warn', log);
    expect(log.warnings.join()).toMatch(/tree hash decides/);
  });

  it('a tree that does not match the pin fails closed and leaves the cached tree alone', () => {
    const tgz = tarball(FILES);
    const paths = cachePaths(join(temp(), 'montecrit', 'import'));
    mkdirSync(paths.foundryDir, { recursive: true });
    writeFileSync(paths.foundryTgz, readFileSync(tgz));
    const real = extractFoundry(tgz, testPins().foundry, temp());
    const good: Pins = { ...testPins(), foundry: { ...testPins().foundry, treeSha256: real.treeSha256, treeFiles: real.entries.length } };
    installTree(paths, good, quiet());
    expect(hashTree(paths.foundryTree, good.foundry.extract).treeSha256).toBe(real.treeSha256);
    const wrong: Pins = { ...good, foundry: { ...good.foundry, treeSha256: '0'.repeat(64) } };
    expect(() => installTree(paths, wrong, quiet())).toThrow(/fail closed/);
    expect(hashTree(paths.foundryTree, good.foundry.extract).treeSha256).toBe(real.treeSha256);
  });

  it('the cache is never the repo or the private home (path checks only)', () => {
    expect(() => assertCacheDir(join(REPO_ROOT, 'cache'), {})).toThrow(/inside the repo/);
    expect(() => assertCacheDir(join(homedir(), '.montecrit', 'cache'), {})).toThrow(/private home/);
    expect(() => assertCacheDir('/somewhere/else', { MONTECRIT_HOME: '/somewhere' })).toThrow(/private home/);
    expect(() => assertCacheDir(join(tmpdir(), 'x', 'montecrit', 'import'), {})).not.toThrow();
  });
});
