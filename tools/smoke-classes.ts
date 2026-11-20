// The step-6 "any character" demo (docs/design/m3.md build order step 6, C22): the 60-character
// smoke corpus (tools/smoke-corpus.ts) built, linted and fought; prints the 60-row summary.
// Reads only the repo's packs and tools/import-srd/srd-index.json (never ~/.montecrit).
//
//   node tools/smoke-classes.ts [-n 100] [--out FILE] [--write-baseline]   (M14: rewrites tools/test/smoke-combat-unmodeled.baseline.json;
//   refuses, writing nothing, when a character gains an id with no reason in smoke-combat-unmodeled.rises.json)

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import type { SourceFile } from '../packages/engine/src/index.ts';
import { combatBaseline, combatRises, renderSmoke, runSmoke, smokeCorpus, smokeSpells, unlistedRises, type RiseReasons, type SmokeRow } from './smoke-corpus.ts';

const ROOT = join(import.meta.dirname, '..');

/** Every YAML text under packs/srd-5.2.1 and packs/test, repo-relative paths, sorted. */
export function smokePackFiles(root: string = ROOT): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.ya?ml$/.test(e.name)) out.push({ path: relative(root, p).split('\\').join('/'), text: readFileSync(p, 'utf8') });
    }
  };
  walk(join(root, 'packs', 'srd-5.2.1'));
  walk(join(root, 'packs', 'test'));
  return out;
}

/**
 * M14 `--write-baseline` (review C0-T8: the guard is a function, so a test runs it): rewrites
 * `dir`/smoke-combat-unmodeled.baseline.json from `rows`, or throws and writes nothing when a
 * character gains an id with no reason in `dir`/smoke-combat-unmodeled.rises.json.
 */
export function writeBaseline(rows: readonly SmokeRow[], dir: string): void {
  const base = JSON.parse(readFileSync(join(dir, 'smoke-combat-unmodeled.baseline.json'), 'utf8')) as Record<string, string[]>;
  const reasons = JSON.parse(readFileSync(join(dir, 'smoke-combat-unmodeled.rises.json'), 'utf8')) as RiseReasons;
  const bad = unlistedRises(combatRises(rows, base), reasons);
  if (bad.length > 0) throw new Error(`M14: combat-relevant unmodeled ids rose with no listed reason (add one to tools/test/smoke-combat-unmodeled.rises.json): ${bad.join('; ')}`);
  writeFileSync(join(dir, 'smoke-combat-unmodeled.baseline.json'), combatBaseline(rows));
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { n: { type: 'string', short: 'n' }, out: { type: 'string' }, 'write-baseline': { type: 'boolean' } }, strict: true });
  const n = values.n === undefined ? 100 : Number(values.n);
  if (!Number.isInteger(n) || n < 1) throw new Error('-n needs a positive integer');
  const files = smokePackFiles();
  const corpus = smokeCorpus(files, smokeSpells(readFileSync(join(ROOT, 'tools', 'import-srd', 'srd-index.json'), 'utf8')));
  const rows = runSmoke(files, corpus, n);
  const text = renderSmoke(rows, n);
  if (values.out) writeFileSync(values.out, text);
  if (values['write-baseline']) writeBaseline(rows, join(ROOT, 'tools', 'test'));
  process.stdout.write(text);
  const bad = rows.some((r) => r.lintErrors.length > 0 || r.engineErrors.length > 0 || r.fights !== n);
  process.exitCode = bad ? 1 : 0;
}
