// The class-table cross-check and review.json (docs/design/m3.md step 2 demo, C2), and
// import:verify on a copy of the real committed import: a tampered override sha, an orphan
// override, a stale IMPORT.json, a stale review.json and a class cell that no longer matches
// the PDF. No cache, no network, nothing under the home dir.

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkText } from '../../check-private.ts';
import { bitsTable, classDocsOf, crosscheckTables, open5eTable, oursTable, REVIEW_REL, type Review } from '../crosscheck.ts';
import { existingGenerated } from '../emit.ts';
import type { SrdIndex } from '../pdf/build.ts';
import { IMPORT_DIR, REPO_ROOT, stableJson } from '../util.ts';
import { verifyRepo } from '../verify.ts';

const index = JSON.parse(readFileSync(join(IMPORT_DIR, 'srd-index.json'), 'utf8')) as SrdIndex;
const reviewText = readFileSync(join(REPO_ROOT, REVIEW_REL), 'utf8');
const review = JSON.parse(reviewText) as Review;

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

/** The 9 cells research-sources §2.4 found wrong in 5e-bits (checked there against the PDF). */
const BITS_KNOWN_BAD = [
  'druid cantrips 7',
  'druid cantrips 16',
  ...[14, 15, 16, 17, 18, 19, 20].map((l) => `wizard prepared-spells ${l}`),
].sort();

describe('review.json (committed)', () => {
  it('is canonical and clean of non-SRD names and pointers', () => {
    expect(stableJson(review)).toBe(reviewText);
    expect(checkText(REVIEW_REL, reviewText)).toEqual([]);
  });

  it('has every cell of the 12 PDF tables and none differs from our output', () => {
    expect(review.classTables.classes).toBe(12);
    const cells = Object.values(index.classes).reduce((n, c) => n + c.table.columnOrder.length * 20, 0);
    expect(review.classTables.cells).toBe(cells);
    expect(review.classTables.oursVsPdf).toEqual({ agree: cells, mismatches: 0 });
  });

  it("shows exactly 5e-bits' 9 known bad cells, as 5e-bits-only disagreements; Open5e agrees everywhere", () => {
    const t = review.classTables;
    expect(t.byPattern).toEqual({ bits: 9 });
    expect(t.disagreements.map((d) => `${d.class} ${d.column} ${d.level}`).sort()).toEqual(BITS_KNOWN_BAD);
    for (const d of t.disagreements) {
      expect(d.ours).toBe(d.pdf);
      expect(d.open5e).toBe(d.pdf);
    }
    expect(t.votes.open5e.disagree).toBe(0);
    expect(t.votes.bits.disagree).toBe(9);
  });

  it('carries the PDF spell-list table gaps and the content24 vote as ids and counts', () => {
    expect(review.spellListTableGaps).toHaveLength(4);
    expect(Object.keys(review.spellLists).sort()).toEqual(['bard', 'cleric', 'druid', 'paladin', 'ranger', 'sorcerer', 'warlock', 'wizard']);
    for (const s of Object.values(review.spellLists)) {
      for (const id of [...s.pdfOnly, ...s.foundryOnly]) expect(id).toMatch(/^srd:[a-z0-9-]+$/);
      expect(s.agree + s.pdfOnly.length).toBe(s.pdf);
    }
  });

  it('recomputes from the committed class items (ours vs PDF needs no cache)', () => {
    const files = new Map(existingGenerated(REPO_ROOT).map((rel) => [rel, readFileSync(join(REPO_ROOT, rel), 'utf8')] as const));
    const t = crosscheckTables(classDocsOf(files), index, undefined);
    expect(t.oursVsPdf).toEqual(review.classTables.oursVsPdf);
    expect(t.byPattern).toEqual({});
  });
});

describe('crosscheck units', () => {
  it('reads dice, d6 counts, numbers and pact slots in the PDF units', () => {
    const monk = oursTable({ kind: 'class', id: 'srd:monk', scale: { die: { type: 'dice', at: { 1: '1d6', 5: '1d8' } } } }, 'monk', index);
    expect(monk['martial-arts']!.slice(0, 6)).toEqual([6, 6, 6, 6, 8, 8]);
    expect(monk['focus-points']!.every((v) => v === null)).toBe(true); // no such column: a mismatch, never a pass
    expect(monk['proficiency-bonus']!.slice(0, 5)).toEqual([2, 2, 2, 2, 3]);
    const rogue = oursTable({ scale: { 'sneak-attack': { type: 'dice', at: { 1: '1d6', 3: '2d6' } } } }, 'rogue', index);
    expect(rogue['sneak-attack']!.slice(0, 4)).toEqual([1, 1, 2, 2]);
    const wl = oursTable({ scale: { slots: { type: 'slots', at: { 1: [1], 3: [0, 2] } } } }, 'warlock', index);
    expect(wl['spell-slots']!.slice(0, 3)).toEqual([1, 1, 2]);
    expect(wl['slot-level']!.slice(0, 3)).toEqual([1, 1, 2]);
    expect(() => oursTable({ scale: { slots: { type: 'slots', at: { 1: [1, 1] } } } }, 'warlock', index)).toThrow(/more than one level/);
  });

  it('counts a wrong cell against ours', () => {
    const files = new Map(existingGenerated(REPO_ROOT).map((rel) => [rel, readFileSync(join(REPO_ROOT, rel), 'utf8')] as const));
    const docs = classDocsOf(files) as Record<string, Record<string, unknown>>;
    const druid = structuredClone(docs.druid!) as { scale: Record<string, { at: Record<string, number> }> };
    druid.scale['cantrips-known']!.at['4'] = 9;
    const t = crosscheckTables({ ...docs, druid }, index, undefined);
    expect(t.oursVsPdf.mismatches).toBe(6); // levels 4-9
    expect(t.byPattern).toEqual({ ours: 6 });
  });

  it('refuses vote keys outside the closed tables', () => {
    const o5 = { features: [{ key: 'srd-2024_rogue_mystery', data_for_class_table: [{ level: 1, column_value: '1' }] }] };
    expect(() => open5eTable(o5, 'rogue', index)).toThrow(/closed table/);
    const bits = [{ level: 1, class: { index: 'rogue' }, class_specific: { mystery: 1 } }];
    expect(() => bitsTable(bits, 'rogue', index)).toThrow(/closed table/);
    const ok = { features: [{ key: 'srd-2024_rogue_sneak-attack-column-data', data_for_class_table: [{ level: 3, column_value: '2d6' }] }] };
    expect(open5eTable(ok, 'rogue', index)['sneak-attack']!.slice(0, 3)).toEqual([0, 0, 2]);
  });
});

describe('import:verify on a copy of the committed import', () => {
  function copy(): string {
    const root = mkdtempSync(join(tmpdir(), 'montecrit-verify-test-'));
    temps.push(root);
    mkdirSync(join(root, 'tools/import-srd'), { recursive: true });
    for (const f of ['pins.json', 'srd-index.json', 'review.json']) cpSync(join(IMPORT_DIR, f), join(root, 'tools/import-srd', f));
    cpSync(join(IMPORT_DIR, 'overrides'), join(root, 'tools/import-srd/overrides'), { recursive: true });
    cpSync(join(REPO_ROOT, 'packs/srd-5.2.1'), join(root, 'packs/srd-5.2.1'), { recursive: true });
    return root;
  }
  const ov = 'tools/import-srd/overrides/feature/monk/unarmed-strike.yaml';

  it('passes as committed', () => {
    expect(verifyRepo(copy())).toEqual([]);
  });

  it('fails on a tampered override sha256', () => {
    const root = copy();
    writeFileSync(join(root, ov), `${readFileSync(join(root, ov), 'utf8')}# edited\n`);
    expect(verifyRepo(root).join('\n')).toMatch(/unarmed-strike\.yaml changed since the import/);
  });

  it('fails on an orphan override', () => {
    const root = copy();
    mkdirSync(join(root, 'tools/import-srd/overrides/weapon'), { recursive: true });
    writeFileSync(join(root, 'tools/import-srd/overrides/weapon/no-such-weapon.yaml'), 'mastery: vex\n');
    expect(verifyRepo(root).join('\n')).toMatch(/no-such-weapon\.yaml: targets srd:no-such-weapon, which has no generated file/);
  });

  it('fails on a stale IMPORT.json', () => {
    const root = copy();
    const j = join(root, 'packs/srd-5.2.1/IMPORT.json');
    const doc = JSON.parse(readFileSync(j, 'utf8')) as { counts: { byKind: { weapon: { full: number } } }; output: { files: number } };
    doc.counts.byKind.weapon.full -= 1;
    doc.output.files += 1;
    writeFileSync(j, stableJson(doc));
    const p = verifyRepo(root).join('\n');
    expect(p).toMatch(/counts by kind and fidelity differ/);
    const n = existingGenerated(root).length;
    expect(p).toMatch(new RegExp(`says ${n + 1} file\\(s\\), there are ${n}`));
  });

  it('fails when a class cell drifts from the PDF, and on a stale or missing review.json', () => {
    const root = copy();
    const f = join(root, 'packs/srd-5.2.1/classes/wizard.yaml');
    writeFileSync(f, readFileSync(f, 'utf8').replace("      '20': 25\n", "      '20': 22\n"));
    const p = verifyRepo(root).join('\n');
    expect(p).toMatch(/class tables: 1 cell\(s\) differ from the PDF \(wizard prepared-spells level 20: pdf 25, ours 22\)/);
    expect(p).toMatch(/review\.json: was built from different generated files/);
    expect(p).toMatch(/review\.json: its ours-vs-PDF class-table counts differ/);
    rmSync(join(root, REVIEW_REL));
    expect(verifyRepo(root).join('\n')).toMatch(/review\.json is missing/);
  });
});
