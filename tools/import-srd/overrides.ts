// Committed hand fixes (docs/design/m3.md 4.6): tools/import-srd/overrides/<kind>/<local id>.yaml,
// where <local id> is the item id without "srd:" (slashes become folders:
// overrides/feature/monk/martial-arts.yaml is srd:monk/martial-arts).
//
// An override is either
//   - a JSON merge patch (RFC 7386) over the mapped item: objects merge, arrays and scalars
//     replace, null deletes a key; or
//   - `replace: true` plus the whole item, which then stands instead of the mapped one.
//     With no mapped item (a quarantined record, C21) it names the record it replaces with
//     `foundryPath: packs/_source/...` and its PDF page; its provenance is then source srd-pdf
//     (review hand), with the quarantined record only under `replaces`, never as its source.
// Reserved keys (`replace`, `foundryPath`) are never emitted. A patch may set only
// provenance.review, provenance.pdfPage and provenance.crossCheck; the rest of provenance is
// the importer's. Raising fidelity needs provenance.review: reviewed and a pdfPage (2.7).
// Every applied override is recorded as provenance.overrides[] { file, sha256 of its bytes },
// which import:verify checks without the cache.

import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parse } from 'yaml';
import { walkPlain } from './fetch.ts';
import { raises, type Fidelity } from './classify.ts';
import { byString, isRecord, OVERRIDES_DIR, REPO_ROOT, sha256 } from './util.ts';

/** Item kinds an override may target (the emitted kinds). */
export const OVERRIDE_KINDS = ['armor', 'background', 'class', 'feat', 'feature', 'monster', 'species', 'spell', 'subclass', 'weapon'] as const;
export type ItemKind = (typeof OVERRIDE_KINDS)[number];

export interface Override {
  readonly kind: ItemKind;
  readonly id: string;
  /** Repo-relative path of the override file. */
  readonly file: string;
  readonly sha256: string;
  readonly replace: boolean;
  readonly foundryPath?: string | undefined;
  /** The patch or replacement body, reserved keys removed. */
  readonly body: Readonly<Record<string, unknown>>;
}

const LOCAL = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/;

/** The override file (repo-relative) for an item. */
export function overrideFileFor(kind: ItemKind, id: string): string {
  if (!id.startsWith('srd:')) throw new Error(`override target ${id} is not an srd: id`);
  return `tools/import-srd/overrides/${kind}/${id.slice(4)}.yaml`;
}

/** Parses one override's text; `rel` is its path under overrides/ (e.g. class/fighter.yaml). */
export function parseOverride(rel: string, bytes: string, repoPath: string): Override {
  const m = /^([a-z]+)\/(.+)\.yaml$/.exec(rel);
  if (!m) throw new Error(`${repoPath}: override files are overrides/<kind>/<local id>.yaml`);
  const kind = m[1] as ItemKind;
  if (!(OVERRIDE_KINDS as readonly string[]).includes(kind)) throw new Error(`${repoPath}: unknown kind folder ${m[1]}`);
  if (!LOCAL.test(m[2]!)) throw new Error(`${repoPath}: ${m[2]} is not a local id`);
  const id = `srd:${m[2]}`;
  const doc = parse(bytes, { uniqueKeys: true, maxAliasCount: 0, customTags: [], merge: false, version: '1.2' }) as unknown;
  if (!isRecord(doc)) throw new Error(`${repoPath}: an override is a YAML mapping`);
  const { replace, foundryPath, ...body } = doc;
  if (replace !== undefined && typeof replace !== 'boolean') throw new Error(`${repoPath}: replace must be true or false`);
  if (foundryPath !== undefined && (typeof foundryPath !== 'string' || !foundryPath.startsWith('packs/_source/'))) {
    throw new Error(`${repoPath}: foundryPath must be a packs/_source/ path`);
  }
  if (foundryPath !== undefined && replace !== true) throw new Error(`${repoPath}: foundryPath is only for replace: true`);
  if (body.id !== undefined && body.id !== id) throw new Error(`${repoPath}: id ${String(body.id)} does not match the file (${id})`);
  if (body.kind !== undefined && body.kind !== kind) throw new Error(`${repoPath}: kind ${String(body.kind)} does not match the folder (${kind})`);
  if (body.provenance !== undefined) {
    if (!isRecord(body.provenance)) throw new Error(`${repoPath}: provenance must be a mapping`);
    for (const k of Object.keys(body.provenance)) {
      if (k !== 'review' && k !== 'pdfPage' && k !== 'crossCheck') throw new Error(`${repoPath}: an override may set only provenance.review, pdfPage and crossCheck, not ${k}`);
    }
  }
  return { kind, id, file: repoPath, sha256: sha256(bytes), replace: replace === true, foundryPath, body };
}

/** Every override under <root>/tools/import-srd/overrides, sorted by file; paths are relative to `root`. */
export function loadOverrides(root: string = REPO_ROOT): Override[] {
  const dir = root === REPO_ROOT ? OVERRIDES_DIR : join(root, 'tools', 'import-srd', 'overrides');
  let files: string[];
  try {
    files = walkPlain(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  return files
    .filter((f) => f.endsWith('.yaml'))
    .sort(byString)
    .map((rel) => parseOverride(rel, readFileSync(join(dir, rel), 'utf8'), relative(root, join(dir, rel)).split(sep).join('/')));
}

/** RFC 7386 JSON merge patch: objects merge recursively, null deletes, anything else replaces. */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isRecord(patch)) return patch;
  const out: Record<string, unknown> = isRecord(target) ? { ...target } : {};
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

export interface BaseRecord {
  readonly path: string;
  readonly foreignId: string;
  readonly sha256: string;
}

export interface ApplyCtx {
  readonly commit: string;
  readonly importer: number;
  /** Looks up a Foundry record by its path (for replace overrides with no mapped item). */
  readonly recordAt: (path: string) => BaseRecord | undefined;
}

/**
 * Applies one override. `item` is the mapped item (undefined when nothing was mapped for the
 * id); `computed` is the fidelity the importer gave it. Returns the final item.
 */
export function applyOverride(item: Readonly<Record<string, unknown>> | undefined, ov: Override, ctx: ApplyCtx): Record<string, unknown> {
  const where = ov.file;
  let out: Record<string, unknown>;
  let baseProv: Record<string, unknown>;
  if (item) {
    if (!isRecord(item.provenance)) throw new Error(`${where}: the mapped item ${ov.id} has no provenance`);
    baseProv = item.provenance;
    out = ov.replace ? { ...ov.body } : (mergePatch(item, ov.body) as Record<string, unknown>);
  } else {
    if (!ov.replace) throw new Error(`${where}: ${ov.id} was not imported, so there is nothing to patch (use replace: true with foundryPath)`);
    if (!ov.foundryPath) throw new Error(`${where}: ${ov.id} was not imported; a replacement names the record it stands for with foundryPath`);
    const rec = ctx.recordAt(ov.foundryPath);
    if (!rec) throw new Error(`${where}: foundryPath ${ov.foundryPath} is not a record at the pin`);
    // The stand-in is written from the PDF, so its source is the PDF page, never the record
    // the importer refused to license; that record is named only as the one it replaces.
    const page = isRecord(ov.body.provenance) ? ov.body.provenance.pdfPage : undefined;
    if (typeof page !== 'number') throw new Error(`${where}: a replacement for a quarantined record is written from the PDF; give provenance.pdfPage`);
    baseProv = {
      source: 'srd-pdf',
      importer: ctx.importer,
      review: 'hand',
      replaces: { ref: ctx.commit, path: rec.path, foreignId: rec.foreignId, recordSha256: rec.sha256 },
    };
    out = { ...ov.body };
  }
  if (out.kind !== ov.kind) throw new Error(`${where}: the result's kind is ${String(out.kind)}, expected ${ov.kind}`);
  if (out.id !== ov.id) throw new Error(`${where}: the result's id is ${String(out.id)}, expected ${ov.id}`);
  const patchProv = isRecord(ov.body.provenance) ? ov.body.provenance : {};
  const prov: Record<string, unknown> = { ...baseProv, ...patchProv, overrides: [{ file: ov.file, sha256: ov.sha256 }] };
  out.provenance = prov;
  const before = (item?.fidelity as Fidelity | undefined) ?? 'narrative';
  const after = (out.fidelity as Fidelity | undefined) ?? 'full';
  if (prov.source === 'srd-pdf' && prov.review !== 'hand' && prov.review !== 'reviewed') throw new Error(`${where}: a PDF stand-in's review is hand or reviewed`);
  if (prov.source !== 'srd-pdf' && prov.review !== 'auto' && prov.review !== 'reviewed') throw new Error(`${where}: review hand is only for a PDF stand-in`);
  if (raises(before, after) && !(prov.review === 'reviewed' && typeof prov.pdfPage === 'number')) {
    throw new Error(`${where}: raising ${ov.id} from ${before} to ${after} needs provenance.review: reviewed and a pdfPage`);
  }
  // Coverage C0 (X1): mechanizedBy says the class table or the character expansion carries a
  // feature; only a reviewed override with a PDF page may say it, on a feature that isn't narrative.
  if (out.mechanizedBy !== undefined) {
    if (ov.kind !== 'feature') throw new Error(`${where}: mechanizedBy is for features only`);
    if (!(isRecord(ov.body) && ov.body.mechanizedBy !== undefined)) throw new Error(`${where}: mechanizedBy must be set by the override itself`);
    if (!(prov.review === 'reviewed' && typeof prov.pdfPage === 'number')) throw new Error(`${where}: mechanizedBy needs provenance.review: reviewed and a pdfPage`);
    if (after === 'narrative') throw new Error(`${where}: a mechanized feature isn't narrative; give fidelity full or partial`);
  }
  // Full means zero lines (classify.ts): an override that makes an item full also clears its
  // lines (unimplemented: null), having fixed by hand whatever they named. A full item that
  // still lists something unmodeled is refused.
  if (after === 'full' && Array.isArray(out.unimplemented) && out.unimplemented.length) {
    throw new Error(`${where}: ${ov.id} is full but still lists ${out.unimplemented.length} unimplemented line(s); clear them (unimplemented: null) or leave it partial`);
  }
  return out;
}
