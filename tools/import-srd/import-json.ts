// packs/srd-5.2.1/IMPORT.json (docs/design/m3.md 4.2, C5): what the last import produced.
// Pins, tool version, counts by kind and fidelity, drop counts by reason (never names) and
// a hash over the generated files. import:verify recomputes everything but the drop counts
// from the committed files alone, so CI needs no cache and no network.

import { parse } from 'yaml';
import { treeHash } from './fetch.ts';
import { DROP_REASONS, type DropReason } from './filter.ts';
import { OVERRIDE_KINDS, type ItemKind } from './overrides.ts';
import { pinSummary, type Pins } from './pins.ts';
import { byString, IMPORTER_VERSION, isRecord, sha256, stableJson } from './util.ts';

export const IMPORT_JSON_REL = 'packs/srd-5.2.1/IMPORT.json';

export type FidelityCounts = { full: number; partial: number; narrative: number };

export interface ImportJson {
  readonly tool: 'tools/import-srd';
  readonly importer: number;
  readonly pins: Record<string, unknown>;
  /** sha256 of the srd-index.json the PDF tuple gate read (an input like the pins). */
  readonly srdIndexSha256: string;
  readonly counts: { readonly byKind: Record<ItemKind, FidelityCounts>; readonly drops: Record<DropReason, number> };
  readonly output: { readonly files: number; readonly sha256: string };
}

/** Counts by kind and fidelity, every kind present, from the generated texts. */
export function countsOf(files: ReadonlyMap<string, string>): Record<ItemKind, FidelityCounts> {
  const out = Object.fromEntries(OVERRIDE_KINDS.map((k) => [k, { full: 0, partial: 0, narrative: 0 }])) as Record<ItemKind, FidelityCounts>;
  for (const rel of [...files.keys()].sort(byString)) {
    const doc = parse(files.get(rel)!) as unknown;
    if (!isRecord(doc) || typeof doc.kind !== 'string' || !(OVERRIDE_KINDS as readonly string[]).includes(doc.kind)) throw new Error(`${rel}: not an item of an importable kind`);
    const fid = doc.fidelity === undefined ? 'full' : doc.fidelity;
    if (fid !== 'full' && fid !== 'partial' && fid !== 'narrative') throw new Error(`${rel}: bad fidelity ${String(fid)}`);
    out[doc.kind as ItemKind][fid]++;
  }
  return out;
}

/** The output hash: sha256 over sorted "sha256  path" lines of the generated files. */
export function outputHash(files: ReadonlyMap<string, string>): string {
  return treeHash([...files].map(([path, text]) => ({ path, sha256: sha256(text) })));
}

export function buildImportJson(pins: Pins, srdIndexSha256: string, files: ReadonlyMap<string, string>, drops: Readonly<Record<DropReason, number>>): ImportJson {
  const d = Object.fromEntries(DROP_REASONS.map((r) => [r, drops[r] ?? 0])) as Record<DropReason, number>;
  return {
    tool: 'tools/import-srd',
    importer: IMPORTER_VERSION,
    pins: pinSummary(pins),
    srdIndexSha256,
    counts: { byKind: countsOf(files), drops: d },
    output: { files: files.size, sha256: outputHash(files) },
  };
}

export const renderImportJson = (j: ImportJson): string => stableJson(j);
