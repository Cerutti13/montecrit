// The committed srd-index.json: shape, counts, validation, determinism, and a hand
// cross-check of three class tables against the PDF's reading-order text dump
// (`pdftotext` without -layout, i.e. srd-raw.txt), transcribed by eye on 2026-11-03.
// When the pinned PDF is present ($SRD_PDF, or the import cache), the index is rebuilt and
// must come out byte-identical.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkText } from '../../check-private.ts';
import { INDEX_PATH, PDF_SHA256, loadIndex, renderIndex } from '../pdf-index.ts';
import { EXPECT, validateIndex } from '../pdf/build.ts';
import { CLASSES } from '../pdf/names.ts';
import { cachePaths, stableJson } from '../util.ts';

const ix = loadIndex();
const text = readFileSync(INDEX_PATH, 'utf8');

/** Rows as printed in srd-raw.txt: PB, then the value columns in table order ("—" = 0). */
function rows(cls: (typeof CLASSES)[number]): number[][] {
  const t = ix.classes[cls].table;
  return Array.from({ length: 20 }, (_, i) => t.columnOrder.map((id) => t.columns[id]![i]!));
}

describe('srd-index.json', () => {
  it('is canonical JSON (sorted keys, 2-space indent, trailing newline) with no non-SRD names', () => {
    expect(stableJson(ix)).toBe(text);
    expect(checkText('tools/import-srd/srd-index.json', text)).toEqual([]);
    expect(ix.source).toEqual({ pdfSha256: PDF_SHA256, pages: 364 });
  });

  it('has the counts the SRD 5.2.1 PDF holds and passes validation', () => {
    expect(ix.spells).toHaveLength(EXPECT.spells);
    expect(ix.species).toHaveLength(9);
    expect(ix.backgrounds).toHaveLength(4);
    expect(ix.feats).toHaveLength(17);
    expect(Object.keys(ix.subclasses)).toHaveLength(12);
    expect(ix.weapons).toHaveLength(38);
    expect(ix.armor).toHaveLength(13);
    expect(Object.keys(ix.classes)).toEqual([...CLASSES]);
    expect(validateIndex(ix)).toEqual([]);
  });

  it('keeps every list sorted with < and >', () => {
    const sorted = (xs: readonly string[]) => xs.every((x, i) => i === 0 || xs[i - 1]! < x);
    for (const list of [ix.spells, ix.species, ix.backgrounds, ix.feats, ix.weapons, ix.armor]) expect(sorted(list.map((e) => e.name))).toBe(true);
    for (const cls of CLASSES) {
      const f = ix.classes[cls].features;
      expect(f.every((x, i) => i === 0 || f[i - 1]!.level < x.level || (f[i - 1]!.level === x.level && f[i - 1]!.name < x.name))).toBe(true);
    }
  });

  it('has names and numbers only: no string longer than a name', () => {
    const long: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === 'string' && v.length > 64) long.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(ix);
    expect(long).toEqual([]);
  });

  it('Fighter table matches srd-raw.txt (p.47)', () => {
    expect(ix.classes.fighter.table.columnOrder).toEqual(['proficiency-bonus', 'second-wind', 'weapon-mastery']);
    // prettier-ignore
    expect(rows('fighter')).toEqual([
      [2, 2, 3], [2, 2, 3], [2, 2, 3], [2, 3, 4], [3, 3, 4], [3, 3, 4], [3, 3, 4], [3, 3, 4], [4, 3, 4], [4, 4, 5],
      [4, 4, 5], [4, 4, 5], [5, 4, 5], [5, 4, 5], [5, 4, 5], [5, 4, 6], [6, 4, 6], [6, 4, 6], [6, 4, 6], [6, 4, 6],
    ]);
    const f = ix.classes.fighter.features.map((x) => `${x.level} ${x.name}${x.detail ? ` (${x.detail})` : ''}`);
    expect(f).toContain('2 Action Surge (one use)');
    expect(f).toContain('17 Action Surge (two uses)');
    expect(f).toContain('17 Indomitable (three uses)');
    expect(f).toContain('20 Three Extra Attacks');
    expect(ix.classes.fighter.subclassLevels).toEqual([7, 10, 15, 18]);
    expect(ix.classes.fighter.table.page).toBe(47);
  });

  it('Druid table matches srd-raw.txt (p.41)', () => {
    expect(ix.classes.druid.table.columnOrder).toEqual(['proficiency-bonus', 'wild-shape', 'cantrips', 'prepared-spells', 'slot-1', 'slot-2', 'slot-3', 'slot-4', 'slot-5', 'slot-6', 'slot-7', 'slot-8', 'slot-9']);
    // prettier-ignore
    expect(rows('druid')).toEqual([
      [2, 0, 2, 4, 2, 0, 0, 0, 0, 0, 0, 0, 0],
      [2, 2, 2, 5, 3, 0, 0, 0, 0, 0, 0, 0, 0],
      [2, 2, 2, 6, 4, 2, 0, 0, 0, 0, 0, 0, 0],
      [2, 2, 3, 7, 4, 3, 0, 0, 0, 0, 0, 0, 0],
      [3, 2, 3, 9, 4, 3, 2, 0, 0, 0, 0, 0, 0],
      [3, 3, 3, 10, 4, 3, 3, 0, 0, 0, 0, 0, 0],
      [3, 3, 3, 11, 4, 3, 3, 1, 0, 0, 0, 0, 0],
      [3, 3, 3, 12, 4, 3, 3, 2, 0, 0, 0, 0, 0],
      [4, 3, 3, 14, 4, 3, 3, 3, 1, 0, 0, 0, 0],
      [4, 3, 4, 15, 4, 3, 3, 3, 2, 0, 0, 0, 0],
      [4, 3, 4, 16, 4, 3, 3, 3, 2, 1, 0, 0, 0],
      [4, 3, 4, 16, 4, 3, 3, 3, 2, 1, 0, 0, 0],
      [5, 3, 4, 17, 4, 3, 3, 3, 2, 1, 1, 0, 0],
      [5, 3, 4, 17, 4, 3, 3, 3, 2, 1, 1, 0, 0],
      [5, 3, 4, 18, 4, 3, 3, 3, 2, 1, 1, 1, 0],
      [5, 3, 4, 18, 4, 3, 3, 3, 2, 1, 1, 1, 0],
      [6, 4, 4, 19, 4, 3, 3, 3, 2, 1, 1, 1, 1],
      [6, 4, 4, 20, 4, 3, 3, 3, 3, 1, 1, 1, 1],
      [6, 4, 4, 21, 4, 3, 3, 3, 3, 2, 1, 1, 1],
      [6, 4, 4, 22, 4, 3, 3, 3, 3, 2, 2, 1, 1],
    ]);
    const f = ix.classes.druid.features.map((x) => `${x.level} ${x.name}`);
    expect(f.filter((x) => x.startsWith('1 ') || x.startsWith('2 '))).toEqual(['1 Druidic', '1 Primal Order', '1 Spellcasting', '2 Wild Companion', '2 Wild Shape']);
    expect(ix.classes.druid.hitDie).toBe(8);
  });

  it('Wizard table matches srd-raw.txt (p.77)', () => {
    // prettier-ignore
    expect(rows('wizard').map((r) => r.slice(0, 3))).toEqual([
      [2, 3, 4], [2, 3, 5], [2, 3, 6], [2, 4, 7], [3, 4, 9], [3, 4, 10], [3, 4, 11], [3, 4, 12], [4, 4, 14], [4, 5, 15],
      [4, 5, 16], [4, 5, 16], [5, 5, 17], [5, 5, 18], [5, 5, 19], [5, 5, 21], [6, 5, 22], [6, 5, 23], [6, 5, 24], [6, 5, 25],
    ]);
    // Full casters share one grid: the Druid's, checked above.
    expect(rows('wizard').map((r) => r.slice(3))).toEqual(rows('druid').map((r) => r.slice(4)));
    expect(ix.classes.wizard.features.filter((x) => x.level === 1).map((x) => x.name)).toEqual(['Arcane Recovery', 'Ritual Adept', 'Spellcasting']);
  });

  it('records the HP tables and every hit die agrees with them', () => {
    expect(ix.hitPoints.level1.values.barbarian).toBe(12);
    expect(ix.hitPoints.fixedPerLevel.values.wizard).toBe(4);
    for (const cls of CLASSES) {
      expect(ix.hitPoints.level1.values[cls]).toBe(ix.classes[cls].hitDie);
      expect(ix.hitPoints.fixedPerLevel.values[cls]).toBe(ix.classes[cls].hitDie / 2 + 1);
    }
  });

  it('keeps the spell names naive extraction got wrong, with their class lists (C2)', () => {
    const spell = (n: string) => ix.spells.find((s) => s.name === n);
    expect(spell('Animate Dead')).toEqual({ name: 'Animate Dead', level: 3, school: 'Necromancy', classes: ['cleric', 'wizard'], page: 108 });
    expect(spell('Goodberry')).toEqual({ name: 'Goodberry', level: 1, school: 'Conjuration', classes: ['druid', 'ranger'], page: 137 });
    expect(spell('Wall of Force')?.classes).toEqual(['wizard']);
    expect(spell('Acid Splash')?.level).toBe(0);
    expect(spell('Arcane Vigor')).toBeUndefined();
    expect(ix.spellListTableGaps).toHaveLength(4);
  });

  it('gates class and subclass features as (owner, level, name) tuples (C4)', () => {
    const has = (cls: (typeof CLASSES)[number], level: number, name: string) => ix.classes[cls].features.some((f) => f.level === level && f.name === name);
    expect(has('druid', 2, 'Wild Shape')).toBe(true);
    expect(has('druid', 3, 'Wild Shape')).toBe(false);
    expect(ix.subclasses['warrior-of-the-open-hand']?.features.map((f) => `${f.level} ${f.name}`)).toEqual(['3 Open Hand Technique', '6 Wholeness of Body', '11 Fleet Step', '17 Quivering Palm']);
    expect(Object.values(ix.subclasses).map((s) => s.class).sort()).toEqual([...CLASSES]);
  });

  const pdf = process.env.SRD_PDF ?? (process.env.XDG_CACHE_HOME ? join(process.env.XDG_CACHE_HOME, 'montecrit', 'import', 'pdf', 'srd.pdf') : '');
  it.skipIf(!pdf || !existsSync(pdf))('rebuilds byte-identical from the pinned PDF', () => {
    const dir = join(cachePaths().root, 'pdf-text-test');
    expect(renderIndex(pdf, dir)).toBe(text);
  });
});
