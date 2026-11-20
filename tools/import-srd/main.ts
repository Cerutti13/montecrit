// The SRD importer (docs/design/m3.md section 4). Offline, from the import cache:
//
//   npm run import:srd               import and write packs/srd-5.2.1/* (generated files only)
//   npm run import:srd -- --check    exit 1 if the output would differ from what's committed
//   --index <file>                   the PDF index (default tools/import-srd/srd-index.json)
//
// Fill the cache first with tools/import-srd/fetch.ts. The pipeline:
//   tree hash check (fail closed) -> read -> trigger-word scan -> filter (license, book,
//   rules, PDF tuple gate) -> strip -> map (map/index.ts) -> classify -> provenance ->
//   overrides -> engine schema check -> render -> private and pointer check -> write.
// Logs that name records (drops, remaps, quarantine) go to the cache only (C5). Nothing here
// reads ~/.montecrit.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadContent } from '../../packages/engine/src/content/load.ts';
import { formatDiag } from '../../packages/engine/src/content/yaml.ts';
import { classify } from './classify.ts';
import { checkHpGrants, checkPoolLevels, checkScaleRefs } from './data-checks.ts';
import { buildReview, classDocsOf, loadVotes, renderReview, REVIEW_REL, reviewSummary, type Review } from './crosscheck.ts';
import { crosscheckMonsters as open5eMonsters, notAvailable, open5eSpells, OPEN5E_MONSTERS, OPEN5E_SPELLS, readOpen5e } from './crosscheck-open5e.ts';
import { crosscheckMonsters, type MonsterReview } from './crosscheck-monsters.ts';
import { crNumber, monsterId } from './map/monster.ts';
import { crosscheckSpells, type SpellReview } from './crosscheck-spells.ts';
import { assertClean, diffEmit, isGenerated, itemPath, renderItem, writeEmit, type EmitDiff } from './emit.ts';
import { hashTree } from './fetch.ts';
import { dropCounts, filterRecords, IMPORT_SCOPE, loadSrdIndex, type Drop, type ImportKind, type Kept, type SrdNameIndex } from './filter.ts';
import { convertFormula } from './formula.ts';
import { defaultId, identOf } from './ids.ts';
import { buildImportJson, IMPORT_JSON_REL, renderImportJson } from './import-json.ts';
import { MAPPERS, type MapOutput, type MapperRegistry } from './map/index.ts';
import { applyOverride, loadOverrides, type Override } from './overrides.ts';
import { checkReadings } from './pdf-gates.ts';
import { loadPins, type Pins } from './pins.ts';
import { descriptionOf, readFoundry, readSpellListVotes, type FoundryRecord } from './read.ts';
import { RemapLog, resolveUuid } from './remap.ts';
import type { SrdIndex } from './pdf/build.ts';
import { strip } from './strip.ts';
import { triggerWordsIn, U } from './unimplemented.ts';
import { byString, cachePaths, GENERATED_HEADER, sha256, IMPORT_DIR, IMPORTER_VERSION, PACK_DIR, REPO_ROOT, stableJson } from './util.ts';

export interface ImportInput {
  readonly records: readonly FoundryRecord[];
  readonly index: SrdNameIndex;
  readonly overrides: readonly Override[];
  readonly pins: Pins;
  /** sha256 of the srd-index.json behind `index` (recorded in IMPORT.json). */
  readonly srdIndexSha256: string;
  readonly mappers?: MapperRegistry;
  readonly scope?: readonly ImportKind[];
  /** The parsed srd-index.json (the class and subclass mappers read pages and tables from it). */
  readonly pdfIndex?: SrdIndex | undefined;
}

export interface ImportOutput {
  /** Repo-relative path -> file text, for every generated item file. */
  readonly plan: ReadonlyMap<string, string>;
  readonly importJson: string;
  readonly drops: readonly Drop[];
  readonly remap: RemapLog;
  /** Kept records whose mapper produced nothing, by kind. */
  readonly unmapped: Readonly<Record<string, number>>;
  /** Why a mapper produced nothing (MapCtx.skip), by kind and reason; names stay in the cache log. */
  readonly skips: readonly { kind: string; path: string; reason: string; detail: string }[];
}

const LICENSE_REASONS: readonly string[] = ['book-set', 'license-empty', 'license-missing', 'license-other', 'rules-not-2024'];

/** The pure core: records in, file texts out. Deterministic for equal inputs. */
export function buildImport(input: ImportInput): ImportOutput {
  const mappers = input.mappers ?? MAPPERS;
  const commit = input.pins.foundry.commit;
  const records = [...input.records].sort((a, b) => byString(a.path, b.path));
  const { kept, drops } = filterRecords(records, input.index, input.scope ?? IMPORT_SCOPE);
  const keptById = new Map<string, Kept>();
  for (const k of kept) {
    if (keptById.has(k.rec.id)) throw new Error(`two kept records share the Foundry id ${k.rec.id} (${keptById.get(k.rec.id)!.rec.path}, ${k.rec.path})`);
    keptById.set(k.rec.id, k);
  }
  const byId = new Map(records.map((r) => [r.id, r]));
  const droppedIds = new Set(drops.map((d) => d.foreignId));
  const byPath = new Map(records.map((r) => [r.path, r]));
  const ownerIdent = (fid: string) => {
    const r = byId.get(fid);
    return r ? identOf(r.doc, r.name) : undefined;
  };
  const idCache = new Map<string, string>();
  const idOf = (fid: string): string | undefined => {
    const k = keptById.get(fid);
    if (!k) return undefined;
    let id = idCache.get(fid);
    if (id === undefined) idCache.set(fid, (id = defaultId(k, ownerIdent)));
    return id;
  };
  const remap = new RemapLog();
  const unmapped: Record<string, number> = {};
  const skips: { kind: string; path: string; reason: string; detail: string }[] = [];
  const items = new Map<string, { kind: string; item: Record<string, unknown>; from: string }>();

  for (const k of kept) {
    const doc = strip(k.rec.doc) as Record<string, unknown>;
    const triggers = triggerWordsIn(descriptionOf(k.rec));
    const raw = mappers[k.kind]({
      kept: k,
      doc,
      triggers,
      commit,
      lookup: (fid) => keptById.get(fid),
      idOf,
      formula: convertFormula,
      uuid: (uuid, field) => resolveUuid(uuid, k.rec.path, field, (fid) => keptById.has(fid), remap),
      remap,
      dropped: (fid) => (droppedIds.has(fid) ? byId.get(fid) : undefined),
      allKept: kept,
      pdf: input.pdfIndex,
      skip: (reason, detail) => skips.push({ kind: k.kind, path: k.rec.path, reason, detail }),
    });
    const outs: readonly MapOutput[] = raw === null ? [] : Array.isArray(raw) ? raw : [raw as MapOutput];
    // null: the mapper doesn't map this record; []: it folded into another record's item (a species lineage).
    if (raw === null) unmapped[k.kind] = (unmapped[k.kind] ?? 0) + 1;
    for (const o of outs) {
      const id = o.item.id;
      if (typeof id !== 'string') throw new Error(`${k.rec.path}: the ${k.kind} mapper returned an item without an id`);
      if (o.item.kind !== o.kind) throw new Error(`${k.rec.path}: item ${id} says kind ${String(o.item.kind)}, the mapper said ${o.kind}`);
      for (const key of ['fidelity', 'unimplemented', 'provenance']) {
        if (key in o.item) throw new Error(`${k.rec.path}: mappers don't set ${key} (main.ts does)`);
      }
      if (items.has(id)) throw new Error(`id ${id} is produced twice (${items.get(id)!.from}, ${k.rec.path})`);
      // Trigger words mark lifecycles the data doesn't carry; plain data items aren't programs.
      const handled = o.handledTriggers ?? [];
      const lines = [...o.unimplemented, ...(o.classify.shape === 'data' ? [] : triggers.filter((w) => !handled.includes(w)).map((w) => U.trigger(w)))];
      const c = classify({ ...o.classify, unimplemented: lines });
      const prov: Record<string, unknown> = {
        source: 'foundry-dnd5e',
        ref: commit,
        path: k.rec.path,
        foreignId: k.rec.id,
        recordSha256: k.rec.sha256,
        importer: IMPORTER_VERSION,
        review: 'auto',
      };
      if (o.pdfPage !== undefined) prov.pdfPage = o.pdfPage;
      const item: Record<string, unknown> = { ...o.item, fidelity: c.fidelity, provenance: prov };
      if (c.unimplemented.length) item.unimplemented = [...c.unimplemented];
      items.set(id, { kind: o.kind, item, from: k.rec.path });
    }
  }

  // Overrides: one per id at most (the file path is the id, so that's structural).
  for (const ov of input.overrides) {
    const cur = items.get(ov.id);
    if (cur && cur.kind !== ov.kind) throw new Error(`${ov.file}: ${ov.id} is a ${cur.kind}, the override is under ${ov.kind}/`);
    const next = applyOverride(cur?.item, ov, {
      commit,
      importer: IMPORTER_VERSION,
      recordAt: (p) => {
        const r = byPath.get(p);
        return r ? { path: r.path, foreignId: r.id, sha256: r.sha256 } : undefined;
      },
    });
    items.set(ov.id, { kind: ov.kind, item: next, from: ov.file });
  }

  // Whole-set checks (data-checks.ts): every @scale reference resolves; hp grants equal the PDF.
  const byIdItems = new Map([...items].map(([id, v]) => [id, v.item]));
  checkScaleRefs(byIdItems);
  checkHpGrants(byIdItems);
  checkPoolLevels(byIdItems);
  checkReadings(byIdItems);

  const plan = new Map<string, string>();
  for (const id of [...items.keys()].sort(byString)) {
    const { kind, item } = items.get(id)!;
    const rel = itemPath(kind as Override['kind'], id);
    const text = renderItem(item);
    assertClean(rel, text);
    plan.set(rel, text);
  }
  const importJson = renderImportJson(buildImportJson(input.pins, input.srdIndexSha256, plan, dropCounts(drops)));
  assertClean(IMPORT_JSON_REL, importJson);
  return { plan, importJson, drops, remap, unmapped, skips };
}

/** Loads the pack as the engine would, with the plan in place of generated files on disk: any error fails the import. */
export function engineCheck(plan: ReadonlyMap<string, string>): void {
  const files: { path: string; text: string }[] = [];
  const walk = (abs: string, rel: string) => {
    for (const e of readdirSync(abs, { withFileTypes: true }).sort((a, b) => byString(a.name, b.name))) {
      const a = join(abs, e.name);
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(a, r);
      else if (/\.ya?ml$/.test(e.name) && !plan.has(r)) {
        const text = readFileSync(a, 'utf8');
        if (!isGenerated(text)) files.push({ path: r, text }); // stale generated files are left out
      }
    }
  };
  walk(PACK_DIR, 'packs/srd-5.2.1');
  for (const [path, text] of plan) files.push({ path, text });
  const r = loadContent(files);
  // M3 step 6: a generated file the engine's lint warns about (a stat block's printed number it
  // reads differently, a fidelity that doesn't match its lines) fails the import too, so the
  // committed pack stays at zero warnings (content.test.ts, lint --strict).
  const warned = r.warnings.filter((w) => plan.has(w.path));
  if (warned.length) throw new Error(`the generated pack loads with warnings:\n${warned.slice(0, 40).map(formatDiag).join('\n')}`);
  if (r.errors.length) throw new Error(`the generated pack does not load:\n${r.errors.slice(0, 40).map(formatDiag).join('\n')}${r.errors.length > 40 ? `\n... and ${r.errors.length - 40} more` : ''}`);
}

function summary(out: ImportOutput, diff: EmitDiff | undefined, review?: Review): string {
  const j = JSON.parse(out.importJson) as { counts: { byKind: Record<string, Record<string, number>>; drops: Record<string, number> }; output: { files: number; sha256: string } };
  const lines = [`items: ${j.output.files} file(s), output sha256 ${j.output.sha256}`];
  for (const kind of Object.keys(j.counts.byKind).sort(byString)) {
    const c = j.counts.byKind[kind]!;
    const n = (c.full ?? 0) + (c.partial ?? 0) + (c.narrative ?? 0);
    if (n || out.unmapped[kind]) lines.push(`  ${kind}: ${n} (full ${c.full}, partial ${c.partial}, narrative ${c.narrative})`);
  }
  for (const kind of Object.keys(out.unmapped).sort(byString)) {
    lines.push(`  unmapped ${kind}: ${out.unmapped[kind]} kept record(s) the mapper didn't map`);
    const by: Record<string, number> = {};
    for (const s of out.skips) if (s.kind === kind) by[s.reason] = (by[s.reason] ?? 0) + 1;
    const keys = Object.keys(by).sort(byString);
    if (keys.length) lines.push(`    by reason: ${keys.map((r) => `${r} ${by[r]}`).join(', ')}`);
  }
  lines.push(`drops by reason: ${Object.entries(j.counts.drops).map(([r, n]) => `${r} ${n}`).join(', ')}`);
  const quarantined = out.drops.filter((d) => LICENSE_REASONS.includes(d.reason));
  lines.push(`quarantined (license/book/rules), every kind: ${quarantined.length}`);
  for (const q of quarantined) lines.push(`  ${q.reason}: ${q.path}`);
  const rc = out.remap.counts();
  lines.push(`pointers: kept ${rc.kept}, remapped ${rc.remapped}, dropped ${rc.dropped}`);
  if (review) lines.push(...reviewSummary(review));
  if (diff) lines.push(`changes: ${diff.added.length} added, ${diff.changed.length} changed, ${diff.stale.length} stale`);
  return lines.join('\n');
}

function writeLogs(logsDir: string, out: ImportOutput): void {
  mkdirSync(logsDir, { recursive: true });
  const k = (d: Drop) => `${d.path}\u0000${d.reason}`;
  writeFileSync(join(logsDir, 'drops.json'), stableJson({ drops: [...out.drops].sort((a, b) => byString(k(a), k(b))) }));
  writeFileSync(join(logsDir, 'remap.json'), stableJson({ pointers: out.remap.sorted() }));
  const sk = (x: ImportOutput['skips'][number]) => `${x.path}\u0000${x.reason}`;
  writeFileSync(join(logsDir, 'skips.json'), stableJson({ skips: [...out.skips].sort((a, b) => byString(sk(a), sk(b))) }));
  writeFileSync(
    join(logsDir, 'quarantine.json'),
    stableJson({ quarantined: out.drops.filter((d) => LICENSE_REASONS.includes(d.reason)).sort((a, b) => byString(a.path, b.path)) }),
  );
}

/** A pinned 5e-bits file from the cache as a list, or undefined (logged) when it isn't there. */
function readBits(paths: ReturnType<typeof cachePaths>, pins: Pins, name: string): Record<string, unknown>[] | undefined {
  const pin = pins.bits.files[name];
  const abs = join(paths.bitsDir, name);
  if (!pin || !existsSync(abs)) {
    console.log(`5e-bits ${name}: not available (no pinned file in the import cache)`);
    return undefined;
  }
  const bytes = readFileSync(abs);
  if (sha256(bytes) !== pin.sha256) throw new Error(`${abs} does not match its pin; fail closed (rerun fetch.ts)`);
  const j = JSON.parse(bytes.toString('utf8')) as unknown;
  if (!Array.isArray(j)) throw new Error(`${abs}: expected a list`);
  return j.filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null);
}

/** The step-6 monster cross-check: PDF stat blocks against Foundry, 5e-bits and (when cached and pinned) Open5e. */
function monsterCrosscheck(out: ImportOutput, records: readonly FoundryRecord[], pdf: SrdIndex, paths: ReturnType<typeof cachePaths>, pins: Pins): MonsterReview {
  const dropped = new Set(out.drops.filter((d) => d.kind === 'monster').map((d) => d.path));
  const foundry = records.filter((r) => r.type === 'npc' && !dropped.has(r.path));
  const details = pdf.monsterDetails ?? [];
  const o5 = readOpen5e(paths.open5eDir, OPEN5E_MONSTERS, pins);
  if (!o5.available) console.log(notAvailable('monsters', o5.why));
  const ours = details.map((d) => ({ id: monsterId(d.name, pdf), name: d.name, ac: d.ac, hp: d.hp.average, cr: crNumber(d.cr) }));
  return crosscheckMonsters({ details, pdf, foundry, bits: readBits(paths, pins, 'Monsters.json'), open5e: o5.available ? open5eMonsters(ours, o5.data) : undefined });
}

/** The step-6 spell cross-check from the cache's vote files (5e-bits pinned; Open5e when present and pinned). */
function spellCrosscheck(out: ImportOutput, records: readonly FoundryRecord[], pdf: SrdIndex, paths: ReturnType<typeof cachePaths>, pins: Pins): SpellReview {
  const droppedSpells = new Set(out.drops.filter((d) => d.kind === 'spell').map((d) => d.path));
  const foundry = records.filter((r) => r.type === 'spell' && !droppedSpells.has(r.path));
  const pin = pins.bits.files['Spells.json'];
  let bits: Record<string, unknown>[] | undefined;
  const bitsAbs = join(paths.bitsDir, 'Spells.json');
  if (pin && existsSync(bitsAbs)) {
    const bytes = readFileSync(bitsAbs);
    if (sha256(bytes) !== pin.sha256) throw new Error(`${bitsAbs} does not match its pin; fail closed (rerun fetch.ts)`);
    const j = JSON.parse(bytes.toString('utf8')) as unknown;
    if (!Array.isArray(j)) throw new Error(`${bitsAbs}: expected a list`);
    bits = j.filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null);
  } else console.log('5e-bits spells: not available (no pinned Spells.json in the import cache)');
  const o5 = readOpen5e(paths.open5eDir, OPEN5E_SPELLS, pins);
  if (!o5.available) console.log(notAvailable('spells', o5.why));
  return crosscheckSpells({ pdf, foundry, bits, open5e: o5.available ? open5eSpells(o5.data) : undefined });
}

export function runMain(argv: readonly string[]): number {
  let check = false;
  let indexFile = join(IMPORT_DIR, 'srd-index.json');
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') check = true;
    else if (argv[i] === '--index') indexFile = argv[++i] ?? '';
    else throw new Error(`unknown flag ${argv[i]}`);
  }
  const pins = loadPins();
  const paths = cachePaths();
  if (!existsSync(paths.foundryTree)) throw new Error(`no Foundry tree in ${paths.root}; run node tools/import-srd/fetch.ts first`);
  const tree = hashTree(paths.foundryTree, pins.foundry.extract);
  if (tree.treeSha256 !== pins.foundry.treeSha256) throw new Error(`the cached Foundry tree hash ${tree.treeSha256} does not match the pin; fail closed (rerun fetch.ts)`);
  const index = loadSrdIndex(indexFile);
  if (!index) throw new Error(`${indexFile} does not exist; the PDF tuple gate admits nothing without it (run tools/import-srd/pdf-index.ts). Fail closed.`);
  const indexBytes = readFileSync(indexFile);
  const records = readFoundry(paths.foundryTree);
  const pdfIndex = JSON.parse(indexBytes.toString('utf8')) as SrdIndex;
  const out = buildImport({ records, index, srdIndexSha256: sha256(indexBytes), pdfIndex, overrides: loadOverrides(), pins });
  engineCheck(out.plan);
  writeLogs(paths.logsDir, out);
  // The spell cross-check (step 6): the PDF against Foundry's headers, 5e-bits and, when its
  // pinned data is in the cache, Open5e. Votes only; the PDF decides.
  const spellReview = spellCrosscheck(out, records, pdfIndex, paths, pins);
  const monsterReview = monsterCrosscheck(out, records, pdfIndex, paths, pins);
  // The class-table cross-check (step 2 demo): ours must equal the PDF on every cell; the votes are recorded.
  const review = buildReview({
    spells: spellReview,
    monsters: monsterReview,
    classDocs: classDocsOf(out.plan),
    pdf: pdfIndex,
    votes: loadVotes(paths.open5eDir, paths.bitsDir, pins),
    foundryLists: readSpellListVotes(paths.foundryTree),
    records,
    srdIndexSha256: sha256(indexBytes),
    packOutputSha256: (JSON.parse(out.importJson) as { output: { sha256: string } }).output.sha256,
    pins,
  });
  const reviewText = renderReview(review);
  assertClean(REVIEW_REL, reviewText);
  if (review.classTables.oursVsPdf.mismatches) {
    console.error(reviewSummary(review).join('\n'));
    throw new Error(`${review.classTables.oursVsPdf.mismatches} class-table cell(s) differ from the PDF; fail closed`);
  }
  const reviewAbs = join(REPO_ROOT, REVIEW_REL);
  const curReview = existsSync(reviewAbs) ? readFileSync(reviewAbs, 'utf8') : undefined;
  const importJsonAbs = join(REPO_ROOT, IMPORT_JSON_REL);
  const curJson = existsSync(importJsonAbs) ? readFileSync(importJsonAbs, 'utf8') : undefined;
  if (check) {
    const d = diffEmit(out.plan);
    console.log(summary(out, d, review));
    const problems = [...d.added.map((p) => `would add ${p}`), ...d.changed.map((p) => `would change ${p}`), ...d.stale.map((p) => `would delete ${p}`)];
    if (curJson !== out.importJson) problems.push(`would ${curJson === undefined ? 'add' : 'change'} ${IMPORT_JSON_REL}`);
    if (curReview !== reviewText) problems.push(`would ${curReview === undefined ? 'add' : 'change'} ${REVIEW_REL}`);
    for (const p of problems) console.error(p);
    if (problems.length) {
      console.error(`import:srd --check: ${problems.length} difference(s) from the committed output`);
      return 1;
    }
    console.log('import:srd --check: committed output is current');
    return 0;
  }
  const d = writeEmit(out.plan);
  if (curJson !== out.importJson) writeFileSync(importJsonAbs, out.importJson);
  if (curReview !== reviewText) writeFileSync(reviewAbs, reviewText);
  console.log(summary(out, d, review));
  console.log(`logs (cache only): ${paths.logsDir}`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = runMain(process.argv.slice(2));
  } catch (e) {
    console.error(`import:srd: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

