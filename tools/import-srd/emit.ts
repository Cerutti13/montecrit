// Writes the generated pack files (docs/design/m3.md 4.2, section 12): one item per file at
// packs/srd-5.2.1/<kind dir>/<local id>.yaml, keys sorted with <, fixed YAML formatting and
// the GENERATED header, so a re-run is byte-identical. The importer owns exactly the files
// that start with the header: it rewrites them, deletes the stale ones and never touches a
// file without it (the 14 hand-authored spells and monsters). Every emitted text passes the
// private-content check and the art and pointer lint before anything is written (4.7).

import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stringify } from 'yaml';
import { checkText } from '../check-private.ts';
import type { ItemKind } from './overrides.ts';
import { byString, GENERATED_HEADER, REPO_ROOT, sortDeep } from './util.ts';

/** The folder under packs/srd-5.2.1 for each kind (spells and monsters share the hand items' folders). */
export const KIND_DIRS: Readonly<Record<ItemKind, string>> = {
  armor: 'armor',
  background: 'backgrounds',
  class: 'classes',
  feat: 'feats',
  feature: 'features',
  monster: 'monsters',
  species: 'species',
  spell: 'spells',
  subclass: 'subclasses',
  weapon: 'weapons',
};

export const PACK_REL = 'packs/srd-5.2.1';

/** Repo-relative path of an item's generated file. */
export function itemPath(kind: ItemKind, id: string): string {
  if (!/^srd:[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/.test(id)) throw new Error(`${id} is not an srd: id the importer can place`);
  return `${PACK_REL}/${KIND_DIRS[kind]}/${id.slice(4)}.yaml`;
}

/** The fixed text of one item: header, then the sorted YAML document. */
export function renderItem(item: Readonly<Record<string, unknown>>): string {
  const body = stringify(sortDeep(item), {
    indent: 2,
    lineWidth: 0,
    minContentWidth: 0,
    sortMapEntries: false,
    aliasDuplicateObjects: false,
    defaultKeyType: 'PLAIN',
    defaultStringType: 'PLAIN',
    singleQuote: true,
    version: '1.2',
  });
  return `${GENERATED_HEADER}\n${body.endsWith('\n') ? body : `${body}\n`}`;
}

export const isGenerated = (text: string): boolean => text.startsWith(`${GENERATED_HEADER}\n`);

/** Throws if an emitted text would fail check-private (non-SRD names, private ids) or the art and pointer lint. */
export function assertClean(rel: string, text: string): void {
  // checkText includes the art and pointer lint for packs/ paths.
  const f = checkText(rel, text);
  if (f.length) throw new Error(`refusing to emit ${rel}: ${f.map((x) => x.why).join('; ')}`);
}

/**
 * Every generated file (by header) anywhere under the pack, any .yaml or .yml, repo-relative,
 * sorted. The whole pack, not just the kind folders: the engine loads every YAML file there, so
 * a leftover generated file in a renamed folder or with another extension must count as the
 * importer's (stale for --check, deleted by a write, counted and hashed by verify).
 */
export function existingGenerated(root: string = REPO_ROOT): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string) => {
    if (!existsSync(abs)) return;
    for (const name of readdirSync(abs, { withFileTypes: true }).sort((a, b) => byString(a.name, b.name))) {
      const a = join(abs, name.name);
      const r = `${rel}/${name.name}`;
      if (name.isDirectory()) walk(a, r);
      else if (name.isFile() && /\.ya?ml$/.test(name.name) && isGenerated(readFileSync(a, 'utf8'))) out.push(r);
    }
  };
  walk(join(root, PACK_REL), PACK_REL);
  return out.sort(byString);
}

export interface EmitDiff {
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly stale: readonly string[];
}

/** What writing `plan` (repo-relative path -> text) would change on disk. Throws on a collision with a hand file. */
export function diffEmit(plan: ReadonlyMap<string, string>, root: string = REPO_ROOT): EmitDiff {
  const added: string[] = [];
  const changed: string[] = [];
  for (const rel of [...plan.keys()].sort(byString)) {
    const abs = join(root, rel);
    if (!existsSync(abs)) {
      added.push(rel);
      continue;
    }
    const cur = readFileSync(abs, 'utf8');
    if (!isGenerated(cur)) throw new Error(`${rel} exists and is hand-authored (no GENERATED header); the importer never overwrites it`);
    if (cur !== plan.get(rel)) changed.push(rel);
  }
  const stale = existingGenerated(root).filter((rel) => !plan.has(rel));
  return { added, changed, stale };
}

/** Writes the plan: new and changed files, then deletes stale generated files (and folders they leave empty). */
export function writeEmit(plan: ReadonlyMap<string, string>, root: string = REPO_ROOT): EmitDiff {
  for (const [rel, text] of plan) assertClean(rel, text);
  const d = diffEmit(plan, root);
  for (const rel of [...d.added, ...d.changed]) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, plan.get(rel)!);
  }
  for (const rel of d.stale) {
    const abs = join(root, rel);
    if (!isGenerated(readFileSync(abs, 'utf8'))) throw new Error(`${rel} lost its header; not deleting it`);
    unlinkSync(abs);
    let dir = dirname(abs);
    const stop = join(root, PACK_REL);
    while (dir.startsWith(stop) && dir !== stop && readdirSync(dir).length === 0) {
      rmdirSync(dir);
      dir = dirname(dir);
    }
  }
  return d;
}
