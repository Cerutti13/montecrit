// npm run import:verify (docs/design/m3.md 4.2): checks the committed import output against
// itself, with no network and no cache, so CI can run it.
//   - every generated file sits at its id's path, carries provenance at the pinned commit,
//     writes only template unimplemented lines, and passes the private and pointer check
//   - every provenance.overrides[] entry names its own override file with that file's sha256
//   - every override file targets a generated file that records it
//   - IMPORT.json matches the files: pins, importer version, counts by kind and fidelity,
//     file count and output hash (drop counts need the cache, so only their shape is checked)
//   - review.json was built from these files and this srd-index.json, and its ours-vs-PDF
//     class-table cells (recomputed here from the committed class items) are all equal; the
//     Open5e and 5e-bits votes need the cache, so they're taken as written
// With no generated files, no overrides and no IMPORT.json (before the first import) it passes.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { classDocsOf, crosscheckTables, REVIEW_REL } from './crosscheck.ts';
import { assertClean, existingGenerated, itemPath } from './emit.ts';
import { DROP_REASONS } from './filter.ts';
import { countsOf, IMPORT_JSON_REL, outputHash } from './import-json.ts';
import { loadOverrides, overrideFileFor, OVERRIDE_KINDS, type ItemKind } from './overrides.ts';
import { loadPins, pinSummary } from './pins.ts';
import { isTemplateLine } from './unimplemented.ts';
import type { SrdIndex } from './pdf/build.ts';
import { byString, IMPORTER_VERSION, isRecord, REPO_ROOT, sha256, stableJson } from './util.ts';

/** The unimplemented lines of the replace: true override an item records, if it records one. */
function handLines(root: string, prov: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  const ovs = Array.isArray(prov.overrides) ? prov.overrides : [];
  for (const o of ovs) {
    if (!isRecord(o) || typeof o.file !== 'string') continue;
    const abs = join(root, o.file);
    if (!existsSync(abs)) continue;
    const body = parse(readFileSync(abs, 'utf8')) as unknown;
    if (!isRecord(body) || body.replace !== true || !Array.isArray(body.unimplemented)) continue;
    for (const l of body.unimplemented) if (typeof l === 'string') out.add(l);
  }
  return out;
}

export function verifyRepo(root: string = REPO_ROOT): string[] {
  const problems: string[] = [];
  const pins = loadPins(join(root, 'tools', 'import-srd', 'pins.json'));
  const files = new Map<string, string>();
  for (const rel of existingGenerated(root)) files.set(rel, readFileSync(join(root, rel), 'utf8'));
  const recorded = new Map<string, string>(); // override file -> the item path that records it

  for (const [rel, text] of files) {
    try {
      assertClean(rel, text);
    } catch (e) {
      problems.push((e as Error).message);
    }
    let doc: unknown;
    try {
      doc = parse(text);
    } catch (e) {
      problems.push(`${rel}: YAML parse failed (${(e as Error).message.split('\n')[0]})`);
      continue;
    }
    if (!isRecord(doc) || typeof doc.id !== 'string' || typeof doc.kind !== 'string' || !(OVERRIDE_KINDS as readonly string[]).includes(doc.kind)) {
      problems.push(`${rel}: not an item of an importable kind`);
      continue;
    }
    const kind = doc.kind as ItemKind;
    let want: string | undefined;
    try {
      want = itemPath(kind, doc.id);
    } catch (e) {
      problems.push(`${rel}: ${(e as Error).message}`);
    }
    if (want !== undefined && want !== rel) problems.push(`${rel}: ${doc.id} belongs at ${want}`);
    const prov = doc.provenance;
    if (!isRecord(prov)) {
      problems.push(`${rel}: no provenance`);
      continue;
    }
    if (prov.source === 'srd-pdf') {
      // A PDF stand-in for a quarantined record: it must come from an override and cite a page.
      const rep = prov.replaces;
      if (typeof prov.pdfPage !== 'number' || !Array.isArray(prov.overrides) || !prov.overrides.length) problems.push(`${rel}: an srd-pdf item needs a pdfPage and the override that wrote it`);
      if (prov.review !== 'hand' && prov.review !== 'reviewed') problems.push(`${rel}: an srd-pdf item's review is hand or reviewed`);
      if (rep !== undefined && (!isRecord(rep) || rep.ref !== pins.foundry.commit)) problems.push(`${rel}: provenance.replaces is not at the pinned Foundry commit`);
    } else if (prov.source !== 'foundry-dnd5e' || prov.ref !== pins.foundry.commit) problems.push(`${rel}: provenance is not the pinned Foundry commit`);
    else if (prov.review !== 'auto' && prov.review !== 'reviewed') problems.push(`${rel}: review ${String(prov.review)} is not auto or reviewed`);
    if (prov.importer !== IMPORTER_VERSION) problems.push(`${rel}: written by importer ${String(prov.importer)}, this is ${IMPORTER_VERSION}; rerun npm run import:srd`);
    if (Array.isArray(doc.unimplemented)) {
      // The importer writes template lines only (C5). A hand-written item kept whole as a
      // replace: true override (M3 step 6: the 14 committed SRD items, 4.6) keeps the lines its
      // author wrote: they come from that committed override file, never from a record's text,
      // and check-private scans the file like any other.
      const hand = handLines(root, prov);
      for (const l of doc.unimplemented) if (typeof l !== 'string' || !(isTemplateLine(l) || hand.has(l))) problems.push(`${rel}: unimplemented line ${JSON.stringify(l)} matches no template`);
    }
    const ovs = prov.overrides;
    if (ovs !== undefined) {
      if (!Array.isArray(ovs)) {
        problems.push(`${rel}: provenance.overrides is not a list`);
        continue;
      }
      for (const o of ovs) {
        if (!isRecord(o) || typeof o.file !== 'string' || typeof o.sha256 !== 'string') {
          problems.push(`${rel}: a provenance.overrides entry needs file and sha256`);
          continue;
        }
        if (o.file !== overrideFileFor(kind, doc.id)) problems.push(`${rel}: records override ${o.file}, but its override file is ${overrideFileFor(kind, doc.id)}`);
        const abs = join(root, o.file);
        if (!existsSync(abs)) problems.push(`${rel}: override ${o.file} does not exist`);
        else if (sha256(readFileSync(abs)) !== o.sha256) problems.push(`${rel}: override ${o.file} changed since the import (sha256 differs); rerun npm run import:srd`);
        recorded.set(o.file, rel);
      }
    }
  }

  const overrides = loadOverrides(root);
  for (const ov of overrides) {
    const target = itemPath(ov.kind, ov.id);
    if (!files.has(target)) problems.push(`${ov.file}: targets ${ov.id}, which has no generated file (${target})`);
    else if (recorded.get(ov.file) !== target) problems.push(`${ov.file}: ${target} does not record this override; rerun npm run import:srd`);
  }

  const jsonAbs = join(root, IMPORT_JSON_REL);
  if (!existsSync(jsonAbs)) {
    if (files.size || overrides.length) problems.push(`${IMPORT_JSON_REL} is missing; rerun npm run import:srd`);
    return problems;
  }
  let j: unknown;
  try {
    j = JSON.parse(readFileSync(jsonAbs, 'utf8'));
  } catch (e) {
    problems.push(`${IMPORT_JSON_REL}: not JSON (${(e as Error).message})`);
    return problems;
  }
  if (!isRecord(j)) return [...problems, `${IMPORT_JSON_REL}: not an object`];
  if (j.tool !== 'tools/import-srd' || j.importer !== IMPORTER_VERSION) problems.push(`${IMPORT_JSON_REL}: tool or importer version differs (this is importer ${IMPORTER_VERSION})`);
  if (stableJson(j.pins) !== stableJson(pinSummary(pins))) problems.push(`${IMPORT_JSON_REL}: pins differ from tools/import-srd/pins.json`);
  const indexAbs = join(root, 'tools', 'import-srd', 'srd-index.json');
  const indexSha = existsSync(indexAbs) ? sha256(readFileSync(indexAbs)) : undefined;
  if (j.srdIndexSha256 !== indexSha) problems.push(`${IMPORT_JSON_REL}: was built from a different srd-index.json; rerun npm run import:srd`);
  const counts = isRecord(j.counts) ? j.counts : {};
  let mine: unknown;
  try {
    mine = countsOf(files);
  } catch (e) {
    problems.push((e as Error).message);
  }
  if (mine !== undefined && stableJson(counts.byKind) !== stableJson(mine)) problems.push(`${IMPORT_JSON_REL}: counts by kind and fidelity differ from the files`);
  const drops = counts.drops;
  if (!isRecord(drops) || stableJson(Object.keys(drops).sort(byString)) !== stableJson([...DROP_REASONS]) || !Object.values(drops).every((n) => Number.isInteger(n) && (n as number) >= 0)) {
    problems.push(`${IMPORT_JSON_REL}: drop counts must be a count for each of ${DROP_REASONS.join(', ')}`);
  }
  const out = isRecord(j.output) ? j.output : {};
  if (out.files !== files.size) problems.push(`${IMPORT_JSON_REL}: says ${String(out.files)} file(s), there are ${files.size}`);
  if (out.sha256 !== outputHash(files)) problems.push(`${IMPORT_JSON_REL}: output hash differs from the generated files`);
  try {
    assertClean(IMPORT_JSON_REL, readFileSync(jsonAbs, 'utf8'));
  } catch (e) {
    problems.push((e as Error).message);
  }
  problems.push(...verifyReview(root, files, indexAbs, indexSha));
  return problems;
}

/** review.json against the committed class items and srd-index.json (no cache needed). */
function verifyReview(root: string, files: ReadonlyMap<string, string>, indexAbs: string, indexSha: string | undefined): string[] {
  const problems: string[] = [];
  const classDocs = classDocsOf(files);
  const abs = join(root, REVIEW_REL);
  if (!existsSync(abs)) return Object.keys(classDocs).length ? [`${REVIEW_REL} is missing; rerun npm run import:srd`] : [];
  const text = readFileSync(abs, 'utf8');
  try {
    assertClean(REVIEW_REL, text);
  } catch (e) {
    problems.push((e as Error).message);
  }
  let r: unknown;
  try {
    r = JSON.parse(text);
  } catch (e) {
    return [...problems, `${REVIEW_REL}: not JSON (${(e as Error).message})`];
  }
  const inputs = isRecord(r) && isRecord(r.inputs) ? r.inputs : {};
  if (inputs.srdIndexSha256 !== indexSha) problems.push(`${REVIEW_REL}: was built from a different srd-index.json; rerun npm run import:srd`);
  if (inputs.packOutputSha256 !== outputHash(files)) problems.push(`${REVIEW_REL}: was built from different generated files; rerun npm run import:srd`);
  const tables = isRecord(r) && isRecord(r.classTables) ? r.classTables : {};
  const pdf = indexSha === undefined ? undefined : (JSON.parse(readFileSync(indexAbs, 'utf8')) as SrdIndex);
  if (pdf && isRecord(pdf.classes) && Object.keys(pdf.classes).length) {
    let mine: ReturnType<typeof crosscheckTables> | undefined;
    try {
      mine = crosscheckTables(classDocs, pdf, undefined);
    } catch (e) {
      problems.push(`${REVIEW_REL}: ${(e as Error).message}`);
    }
    if (mine) {
      if (stableJson(tables.oursVsPdf) !== stableJson(mine.oursVsPdf) || tables.cells !== mine.cells) problems.push(`${REVIEW_REL}: its ours-vs-PDF class-table counts differ from the committed class items; rerun npm run import:srd`);
      if (mine.oursVsPdf.mismatches) {
        const bad = mine.disagreements.filter((d) => d.against.split('+').includes('ours'));
        problems.push(`class tables: ${mine.oursVsPdf.mismatches} cell(s) differ from the PDF (${bad.slice(0, 5).map((d) => `${d.class} ${d.column} level ${d.level}: pdf ${d.pdf}, ours ${d.ours}`).join('; ')})`);
      }
    }
  }
  return problems;
}

if (import.meta.main) {
  try {
    const problems = verifyRepo();
    for (const p of problems) console.error(p);
    if (problems.length) {
      console.error(`import:verify: ${problems.length} problem(s)`);
      process.exitCode = 1;
    } else {
      console.log(`import:verify: ${existingGenerated().length} generated file(s), overrides, IMPORT.json and review.json consistent`);
    }
  } catch (e) {
    console.error(`import:verify: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}
