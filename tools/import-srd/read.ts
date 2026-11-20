// Reads the extracted Foundry records (docs/design/m3.md 4.2). Each .yml under the pinned
// packs is one document; _folder.yml files are folder records and are skipped. Parsing is
// the yaml package only: plain data, no custom tags, aliases capped, duplicate keys refused.
// Nothing from the download is ever executed.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { walkPlain } from './fetch.ts';
import { byString, getPath, isRecord, sha256 } from './util.ts';

/** The Foundry packs records come from (content24 is auxiliary, read on its own: C2). */
export const RECORD_PACKS = ['actors24', 'classes24', 'equipment24', 'feats24', 'origins24', 'spells24'] as const;
export type RecordPack = (typeof RECORD_PACKS)[number];

export interface FoundryRecord {
  readonly pack: RecordPack;
  /** Path inside the Foundry repository, e.g. packs/_source/classes24/fighter/fighter.yml. */
  readonly path: string;
  /** sha256 of the file's bytes (provenance.recordSha256). */
  readonly sha256: string;
  /** Foundry's own 16-character id. */
  readonly id: string;
  readonly name: string;
  /** Foundry's document type: class, subclass, feat, race, background, weapon, equipment, spell, npc... */
  readonly type: string;
  /** The parsed document, untouched (strip.ts makes the cleaned copy). */
  readonly doc: Readonly<Record<string, unknown>>;
}

/** Parses one record's text. Throws on anything that isn't a plain mapping with _id, name and type. */
export function parseRecord(path: string, text: string): FoundryRecord {
  let doc: unknown;
  try {
    doc = parse(text, { uniqueKeys: true, maxAliasCount: 100, customTags: [], merge: false, version: '1.2' });
  } catch (e) {
    throw new Error(`${path}: YAML parse failed (${(e as Error).message.split('\n')[0]})`);
  }
  if (!isRecord(doc)) throw new Error(`${path}: not a YAML mapping`);
  const id = doc._id;
  const name = doc.name;
  const type = doc.type;
  if (typeof id !== 'string' || !id) throw new Error(`${path}: no _id`);
  if (typeof name !== 'string' || !name) throw new Error(`${path}: no name`);
  if (typeof type !== 'string' || !type) throw new Error(`${path}: no type`);
  const m = /^packs\/_source\/([^/]+)\//.exec(path);
  const pack = m?.[1] as RecordPack | undefined;
  if (!pack || !(RECORD_PACKS as readonly string[]).includes(pack)) throw new Error(`${path}: not in a record pack`);
  return { pack, path, sha256: sha256(text), id, name, type, doc };
}

/** Every record under the tree's record packs, in path order. */
export function readFoundry(treeDir: string, packs: readonly RecordPack[] = RECORD_PACKS): FoundryRecord[] {
  const out: FoundryRecord[] = [];
  for (const rel of walkPlain(treeDir)) {
    if (!rel.endsWith('.yml') || rel.endsWith('/_folder.yml')) continue;
    const m = /^packs\/_source\/([^/]+)\//.exec(rel);
    if (!m || !(packs as readonly string[]).includes(m[1]!)) continue;
    out.push(parseRecord(rel, readFileSync(join(treeDir, rel), 'utf8')));
  }
  return out;
}

export const SPELL_LISTS_PATH = 'packs/_source/content24/chapter-7/spells.yml';

/**
 * content24's class spell-list pages (C2): read unfiltered as an auxiliary vote, UUID lists
 * only, never emitted. Returns { page name: [foreign spell ids] }; undefined when absent.
 */
export function readSpellListVotes(treeDir: string): Record<string, string[]> | undefined {
  let text: string;
  try {
    text = readFileSync(join(treeDir, SPELL_LISTS_PATH), 'utf8');
  } catch {
    return undefined;
  }
  const doc = parse(text, { uniqueKeys: true, maxAliasCount: 100, customTags: [], merge: false, version: '1.2' }) as unknown;
  const out: Record<string, string[]> = {};
  const pages = isRecord(doc) && Array.isArray(doc.pages) ? doc.pages : [];
  for (const p of pages) {
    if (!isRecord(p) || p.type !== 'spells' || typeof p.name !== 'string' || getPath(p, 'system.type') !== 'class') continue;
    const spells = getPath(p, 'system.spells');
    if (!Array.isArray(spells)) continue;
    out[p.name] = spells
      .filter((s): s is string => typeof s === 'string')
      .map((s) => s.split('.').pop()!)
      .sort(byString);
  }
  return out;
}

/** The description HTML of a record (system.description.value), for the trigger-word scan only. */
export function descriptionOf(rec: FoundryRecord): string {
  const v = getPath(rec.doc, 'system.description.value');
  return typeof v === 'string' ? v : '';
}
