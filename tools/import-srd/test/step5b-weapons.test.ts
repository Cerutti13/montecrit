// M3 step 5b, the importer's part (docs/design/m3.md C8): weapon properties and masteries from the
// PDF Weapons table, Weapon Mastery's count read against Foundry's advancements, and Shield, +N and
// Weapon, +N through reviewed overrides. Tests are named for the rule text they check.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { WEAPON_MASTERY } from '../../../packages/engine/src/content/character.ts';
import { masteryReading } from '../map/class.ts';
import { MAGIC_READINGS, readingProblem } from '../map/magic-item.ts';
import type { SrdIndex } from '../pdf/build.ts';
import type { MagicItemDetail } from '../pdf/magic-items.ts';
import { IMPORT_DIR, REPO_ROOT } from '../util.ts';

type Item = Record<string, unknown>;
const PACK = join(REPO_ROOT, 'packs/srd-5.2.1');
const item = (rel: string): Item => parse(readFileSync(join(PACK, rel), 'utf8')) as Item;
const ix = JSON.parse(readFileSync(join(IMPORT_DIR, 'srd-index.json'), 'utf8')) as SrdIndex;

describe('weapons: properties, range, versatile die and mastery are the PDF Weapons table\'s (p.91, srd-raw.txt:20470-20900)', () => {
  const files = readdirSync(join(PACK, 'weapons')).filter((f) => f.endsWith('.yaml'));
  const ORDER = ['finesse', 'light', 'heavy', 'two-handed', 'versatile', 'thrown', 'ammunition', 'loading', 'reach'];

  it('the index reads all 38 rows, each with its Properties cell', () => {
    expect(ix.weapons).toHaveLength(38);
    expect(files).toHaveLength(38);
    // "Heavy Crossbow ... Ammunition (Range 100/400; Bolt), Heavy, Loading, Two-Handed": a wrapped cell joined.
    expect(ix.weapons.find((w) => w.name === 'Heavy Crossbow')).toMatchObject({ properties: ['ammunition', 'heavy', 'loading', 'two-handed'], range: [100, 400], ammunition: 'bolt' });
    // "Lance ... Heavy, Reach, Two-Handed (unless mounted)": two-handed (mounted combat isn't modeled).
    expect(ix.weapons.find((w) => w.name === 'Lance')!.properties).toEqual(['heavy', 'reach', 'two-handed']);
  });

  it('every committed weapon equals its PDF row and is full', () => {
    for (const f of files) {
      const w = item(`weapons/${f}`) as Item & { name: string; properties?: string[]; range?: number[]; versatile?: string; mastery: string };
      const row = ix.weapons.find((r) => r.name === w.name)!;
      expect(row, w.name).toBeDefined();
      expect(w.properties ?? [], w.name).toEqual([...row.properties].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)));
      expect(w.range ?? null, w.name).toEqual(row.range ?? null);
      expect(w.versatile ?? null, w.name).toEqual(row.versatile ?? null);
      expect(w.mastery, w.name).toBe(row.mastery);
      expect(w.fidelity, w.name).toBe('full');
    }
  });
});

describe('Weapon Mastery: "the mastery properties of N kinds of weapons" (Barbarian, Fighter, Paladin, Ranger, Rogue)', () => {
  it('the reading covers exactly the classes that grant the feature, at level 1', () => {
    const classes = readdirSync(join(PACK, 'classes')).map((f) => item(`classes/${f}`) as Item & { id: string; features: Record<string, string[]> });
    const granting = classes.filter((c) => Object.values(c.features).flat().some((id) => id.endsWith('/weapon-mastery'))).map((c) => c.id).sort();
    expect(granting).toEqual(['srd:barbarian', 'srd:fighter', 'srd:paladin', 'srd:ranger', 'srd:rogue']);
    expect(WEAPON_MASTERY.map((m) => m.feature).sort()).toEqual(granting.map((c) => `${c}/weapon-mastery`));
    for (const c of classes.filter((x) => granting.includes(x.id))) {
      expect(c.features['1'], c.id).toContain(`${c.id}/weapon-mastery`);
      // The choice is mapped: the class no longer lists it.
      expect((c.unimplemented as string[] | undefined) ?? [], c.id).not.toContain('choice weapon-mastery not mapped');
    }
  });

  it('Barbarian and Fighter count from the table\'s Weapon Mastery column (2/3/4 at 1/4/10; 3/4/5/6 at 1/4/10/16)', () => {
    const at = (c: string) => ((item(`classes/${c}.yaml`).scale as Record<string, { at: Record<string, number> }>).mastery!.at);
    expect(at('barbarian')).toEqual({ 1: 2, 4: 3, 10: 4 });
    expect(at('fighter')).toEqual({ 1: 3, 4: 4, 10: 5, 16: 6 });
    expect(ix.classes.fighter.table.columns['weapon-mastery']!.slice(0, 16)).toEqual([3, 3, 3, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 6]);
    expect(WEAPON_MASTERY.find((m) => m.feature === 'srd:barbarian/weapon-mastery')).toMatchObject({ count: '@scale.barbarian.mastery', kinds: 'melee' });
    expect(WEAPON_MASTERY.find((m) => m.feature === 'srd:fighter/weapon-mastery')).toMatchObject({ count: '@scale.fighter.mastery', kinds: 'any' });
  });

  it('Paladin, Ranger and Rogue: "two kinds of weapons of your choice with which you have proficiency"', () => {
    for (const c of ['paladin', 'ranger', 'rogue']) expect(WEAPON_MASTERY.find((m) => m.feature === `srd:${c}/weapon-mastery`), c).toMatchObject({ count: 2, kinds: 'proficient' });
  });

  it('Foundry\'s advancements are a vote, fail closed: a running total that differs at any level is a problem', () => {
    const col = { mastery: { type: 'number', at: { 1: 3, 4: 4, 10: 5, 16: 6 } } };
    const fighter = ['srd:fighter/weapon-mastery'];
    const adds = [
      { level: 1, count: 3 },
      { level: 4, count: 1 },
      { level: 10, count: 1 },
      { level: 16, count: 1 },
    ];
    expect(masteryReading('fighter', fighter, col, adds)).toBe('ok');
    expect(masteryReading('fighter', fighter, col, adds.slice(0, 3))).toMatch(/level 16: Foundry's advancements total 5, the reading .* says 6/);
    expect(masteryReading('fighter', fighter, {}, adds)).toMatch(/says nothing/);
    expect(masteryReading('rogue', ['srd:rogue/weapon-mastery'], {}, [{ level: 1, count: 2 }])).toBe('ok');
    expect(masteryReading('rogue', ['srd:rogue/weapon-mastery'], {}, [{ level: 1, count: 2 }, { level: 9, count: 1 }])).toMatch(/level 9/);
    // No reading applies: the class doesn't grant it, or has no row.
    expect(masteryReading('fighter', [], col, adds)).toBeNull();
    expect(masteryReading('wizard', ['srd:wizard/weapon-mastery'], {}, [])).toBeNull();
  });
});

describe('magic Shields and Weapons (M3 step 5b gates; reviewed overrides)', () => {
  it('Shield, +N: "While holding this Shield, you have a bonus to Armor Class determined by the Shield\'s rarity" (p.243)', () => {
    for (const n of [1, 2, 3]) {
      const it = item(`features/shield-plus-${n}.yaml`);
      expect(it.effects).toEqual([{ id: `shield-plus-${n}`, name: `Shield, +${n}`, stats: [{ ac: n, when: ['itemHeld'] }] }]);
      expect(it.passive).toEqual({ effects: [`shield-plus-${n}`] });
      expect(it.fidelity).toBe('full');
      expect(it.unimplemented).toBeUndefined();
      expect(it.provenance).toMatchObject({ review: 'reviewed', pdfPage: 243, overrides: [{ file: `tools/import-srd/overrides/feature/shield-plus-${n}.yaml` }] });
    }
  });

  it('Weapon, +N: "a bonus to attack rolls and damage rolls made with this magic weapon" (p.253)', () => {
    for (const n of [1, 2, 3]) {
      const it = item(`features/weapon-plus-${n}.yaml`);
      expect(it.effects).toEqual([{ id: `weapon-plus-${n}`, name: `Weapon, +${n}`, stats: [{ magicWeapon: n }] }]);
      expect(it.passive).toEqual({ effects: [`weapon-plus-${n}`] });
      expect(it.fidelity).toBe('full');
      expect(it.provenance).toMatchObject({ review: 'reviewed', pdfPage: 253 });
    }
  });

  it('Ammunition, +N stays narrative: "Once it hits a target, the ammunition is no longer magical" needs per-piece ammunition', () => {
    expect(item('features/ammunition-1-2-or-3.yaml')).toMatchObject({ fidelity: 'narrative', unimplemented: ['needs engine support: magic-weapon-bonus'] });
  });

  it('each reading fails closed: the PDF must print +1/+2/+3 and the record\'s enchantments must be 1, 2, 3', () => {
    const ench = (key: string, n: number) => ({ type: 'enchantment', system: { changes: [{ key, mode: 'upgrade', value: n }] } });
    const pdf = (name: string, facts: string[], plus: number[]): MagicItemDetail => ({ name, page: 1, category: 'armor', attunement: false, plus, facts });
    const shield = MAGIC_READINGS['Shield, +1, +2, or +3']!;
    const sDoc = (ns: number[]) => ({ effects: ns.map((n) => ench('system.armor.magicalBonus', n)) });
    expect(readingProblem(shield, pdf('Shield, +1, +2, or +3', ['ac-by-rarity-while-holding'], [1, 2, 3]), sDoc([1, 2, 3]))).toBeUndefined();
    expect(readingProblem(shield, pdf('Shield, +1, +2, or +3', ['ac-by-rarity-while-holding'], [1, 2]), sDoc([1, 2, 3]))).toMatch(/PDF variants/);
    expect(readingProblem(shield, pdf('Shield, +1, +2, or +3', ['ac-by-rarity-while-holding'], [1, 2, 3]), sDoc([1, 1, 3]))).toMatch(/record variants/);
    expect(readingProblem(shield, pdf('Shield, +1, +2, or +3', [], [1, 2, 3]), sDoc([1, 2, 3]))).toMatch(/PDF tokens/);
    const weapon = MAGIC_READINGS['Weapon, +1, +2, or +3']!;
    const wDoc = (ns: number[]) => ({ effects: ns.map((n) => ench('system.magicalBonus', n)) });
    expect(readingProblem(weapon, pdf('Weapon, +1, +2, or +3', ['attack-damage-by-rarity'], [1, 2, 3]), wDoc([1, 2, 3]))).toBeUndefined();
    expect(readingProblem(weapon, pdf('Weapon, +1, +2, or +3', ['attack-damage-by-rarity'], [1, 2, 3]), wDoc([1, 2]))).toMatch(/record variants/);
  });
});
