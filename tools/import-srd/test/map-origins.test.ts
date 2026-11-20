// The origin and equipment mappers (docs/design/m3.md 2.3, 4.3, 4.9, C4, C9): species (with
// Foundry's lineage records folded into one SRD species), species traits as features,
// backgrounds, feats, weapons and armor. Synthetic records first; then, when the import cache
// holds the pinned Foundry tree, the real records against tables transcribed by hand from the
// SRD 5.2.1 PDF (Weapons p.91, Armor p.92, Species p.84-86). Nothing under the home dir.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { loadContent } from '../../../packages/engine/src/content/load.ts';
import { classify } from '../classify.ts';
import { filterRecords, indexFromJson, indexFromTuples, speciesPasses, speciesTraitPasses, type Kept } from '../filter.ts';
import { defaultId, identOf } from '../ids.ts';
import { convertFormula } from '../formula.ts';
import { mapArmor } from '../map/armor.ts';
import { mapBackground } from '../map/background.ts';
import { mapFeat } from '../map/feat.ts';
import type { MapCtx, Mapper, MapOutput } from '../map/types.ts';
import { mapSpecies, mapSpeciesTrait } from '../map/species.ts';
import { mapWeapon } from '../map/weapon.ts';
import type { SrdIndex } from '../pdf/build.ts';
import { parseRecord, readFoundry, type FoundryRecord } from '../read.ts';
import { RemapLog } from '../remap.ts';
import { strip } from '../strip.ts';
import { isTemplateLine, U } from '../unimplemented.ts';
import { cachePaths, IMPORT_DIR } from '../util.ts';

const SRC = { license: 'CC-BY-4.0', book: '', rules: '2024', revision: 1, custom: '' };
let n = 0;
const fid = (stem: string): string => `${stem}${'0'.repeat(16)}`.slice(0, 16);
function rec(path: string, doc: Record<string, unknown>): FoundryRecord {
  n++;
  return parseRecord(path, stringify({ _id: fid(`syo${n}`), ...doc }));
}
const uuid = (pack: string, id: string) => ({ uuid: `Compendium.dnd5e.${pack}.Item.${id}`, optional: false });

/** A MapCtx over a set of kept records (what main.ts builds), without the rest of the pipeline. */
function ctxFor(k: Kept, keptAll: readonly Kept[], pdf: Partial<SrdIndex> | undefined, dropped: readonly FoundryRecord[] = []): MapCtx {
  const byId = new Map(keptAll.map((x) => [x.rec.id, x]));
  const ownerIdent = (f: string) => {
    const r = byId.get(f)?.rec;
    return r ? identOf(r.doc, r.name) : undefined;
  };
  const ctx = {
    kept: k,
    doc: strip(k.rec.doc) as Record<string, unknown>,
    triggers: [],
    commit: '87e94dbd9f930135e0694cd7e7d49f210603cd2c',
    lookup: (f: string) => byId.get(f),
    idOf: (f: string) => {
      const x = byId.get(f);
      return x ? defaultId(x, ownerIdent) : undefined;
    },
    formula: convertFormula,
    uuid: () => undefined,
    remap: new RemapLog(),
    dropped: (f: string) => dropped.find((r) => r.id === f),
    pdf: pdf as SrdIndex | undefined,
  };
  return ctx as unknown as MapCtx;
}

const outs = (r: ReturnType<Mapper>): MapOutput[] => (r === null ? [] : Array.isArray(r) ? [...r] : [r as MapOutput]);
const one = (r: ReturnType<Mapper>): MapOutput => {
  const o = outs(r);
  expect(o).toHaveLength(1);
  return o[0]!;
};

// ---- synthetic records -------------------------------------------------------------

const PDF: Partial<SrdIndex> = {
  species: [
    { name: 'Elf', page: 84 },
    { name: 'Dwarf', page: 84 },
  ],
  speciesTraits: [
    { species: 'Elf', name: 'Fey Ancestry', page: 85 },
    { species: 'Elf', name: 'Elven Lineage', page: 84 },
    { species: 'Elf', name: 'Drow', page: 85, of: 'Elven Lineage' },
    { species: 'Elf', name: 'High Elf', page: 85, of: 'Elven Lineage' },
    { species: 'Dwarf', name: 'Dwarven Resilience', page: 84 },
    { species: 'Dwarf', name: 'Dwarven Toughness', page: 84 },
  ],
  feats: [
    { name: 'Alert', category: 'origin', page: 87 },
    { name: 'Skilled', category: 'origin', page: 87 },
    { name: 'Grappler', category: 'general', page: 87 },
  ],
  backgrounds: [{ name: 'Criminal', page: 83 }],
  weapons: [
    { name: 'Spear', category: 'simple-melee', damage: '1d6', damageType: 'piercing', mastery: 'sap', properties: ['thrown', 'versatile'], range: [20, 60], versatile: '1d8', page: 91 },
    { name: 'Longbow', category: 'martial-ranged', damage: '1d8', damageType: 'piercing', mastery: 'slow', properties: ['ammunition', 'heavy', 'two-handed'], range: [150, 600], ammunition: 'arrow', page: 91 },
  ],
  armor: [
    { name: 'Breastplate', category: 'medium', ac: 14, addDex: true, dexMax: 2, stealthDisadvantage: false, page: 92 },
    { name: 'Chain Mail', category: 'heavy', ac: 16, addDex: false, strength: 13, stealthDisadvantage: true, page: 92 },
    { name: 'Shield', category: 'shield', ac: 2, addDex: false, stealthDisadvantage: false, page: 92 },
  ],
};
const gate = indexFromJson({ classes: {}, subclasses: {}, ...PDF });

const trait = (name: string, folder: string, id: string, extra: Record<string, unknown> = {}, effects: unknown[] = []) =>
  rec(`packs/_source/origins24/species/traits/${folder}/${id.toLowerCase()}.yml`, {
    _id: id,
    name,
    type: 'feat',
    system: { type: { value: 'race', subtype: '' }, source: SRC, identifier: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), activities: {}, ...extra },
    effects,
  });
const race = (name: string, file: string, id: string, adv: unknown[], walk = 30) =>
  rec(`packs/_source/origins24/species/${file}.yml`, { _id: id, name, type: 'race', system: { source: SRC, identifier: file, advancement: adv, movement: { walk } } });

function elfWorld() {
  const fey = trait('Fey Ancestry', 'elf', fid('tFey'));
  const drowL = trait('Elven Lineage, Drow', 'elf', fid('tDrow'));
  const highL = trait('Elven Lineage, High Elf', 'elf', fid('tHigh'));
  const woodL = trait('Elven Lineage, Wood Elf', 'elf', fid('tWood'));
  const size = { type: 'Size', level: 0, configuration: { sizes: ['med'] } };
  const keen = { type: 'Trait', level: 0, title: 'Keen Senses', configuration: { grants: [], choices: [{ count: 1, pool: ['skills:ins', 'skills:prc', 'skills:sur'] }] } };
  const spell = { type: 'ItemGrant', level: 1, title: 'Drow Traits', configuration: { items: [uuid('spells24', fid('splDance'))] } };
  const drow = race('Elf, Drow', 'elf-drow', fid('rDrow'), [size, keen, { type: 'ItemGrant', level: 0, configuration: { items: [uuid('origins24', fey.id), uuid('origins24', drowL.id)] } }, spell]);
  const high = race('Elf, High', 'elf-high', fid('rHigh'), [size, keen, { type: 'ItemGrant', level: 0, configuration: { items: [uuid('origins24', fey.id), uuid('origins24', highL.id)] } }], 30);
  const wood = race('Elf, Wood', 'elf-wood', fid('rWood'), [size, keen, { type: 'ItemGrant', level: 0, configuration: { items: [uuid('origins24', fey.id), uuid('origins24', woodL.id)] } }], 35);
  return { fey, drowL, highL, woodL, drow, high, wood, records: [fey, drowL, highL, woodL, drow, high, wood] };
}

describe('the species gate for lineage records (C4)', () => {
  it('admits "<species>, <lineage>" only when the PDF lists that lineage', () => {
    expect(speciesPasses(gate, 'Elf')).toBe(true);
    expect(speciesPasses(gate, 'Elf, Drow')).toBe(true);
    expect(speciesPasses(gate, 'Elf, High')).toBe(true); // "High" + " Elf" = "High Elf"
    expect(speciesPasses(gate, 'Elf, Shadow')).toBe(false);
    expect(speciesPasses(gate, 'Orc, Drow')).toBe(false);
    expect(speciesTraitPasses(gate, 'Elf, Drow', 'Fey Ancestry')).toBe(true);
    expect(speciesTraitPasses(gate, 'Elf, Drow', 'Elven Lineage, High Elf')).toBe(true);
    expect(speciesTraitPasses(gate, 'Elf, Drow', 'Elven Lineage, Shadow')).toBe(false);
    expect(speciesTraitPasses(gate, 'Elf, Drow', 'Dwarven Toughness')).toBe(false); // another species' trait
  });

  it('the Wood Elf lineage (not in this index) drops; the rest pass', () => {
    const w = elfWorld();
    const { kept, drops } = filterRecords(w.records, gate);
    expect(kept.map((k) => k.rec.name).sort()).toEqual(['Elf, Drow', 'Elf, High', 'Elven Lineage, Drow', 'Elven Lineage, High Elf', 'Fey Ancestry']);
    expect(drops.filter((d) => d.kind === 'species' || d.kind === 'speciesTrait').map((d) => `${d.name}:${d.reason}`).sort()).toEqual([
      'Elf, Wood:not-in-srd-pdf',
      'Elven Lineage, Wood Elf:no-owner',
    ]);
  });
});

describe('species', () => {
  const full = indexFromTuples({ species: [['Elf']], speciesTrait: [['Elf', 'Fey Ancestry'], ['Elf', 'Elven Lineage']], speciesOption: [['Elf', 'Elven Lineage', 'Drow'], ['Elf', 'Drow'], ['Elf', 'Elven Lineage', 'High Elf'], ['Elf', 'High Elf'], ['Elf', 'Elven Lineage', 'Wood Elf'], ['Elf', 'Wood Elf']] });

  it('folds lineage records into one SRD species with a lineage choice', () => {
    const w = elfWorld();
    const { kept } = filterRecords(w.records, full);
    const species = kept.filter((k) => k.kind === 'species');
    expect(species).toHaveLength(3);
    const results = species.map((k) => mapSpecies(ctxFor(k, kept, PDF)));
    expect(results.filter((r) => Array.isArray(r) && r.length === 0)).toHaveLength(2); // folded, not unmapped
    const o = one(results.find((r) => outs(r).length === 1)!);
    expect(o.item).toEqual({
      kind: 'species',
      id: 'srd:elf',
      name: 'Elf',
      source: 'SRD 5.2.1 p.84',
      size: ['medium'],
      speed: 30, // the Wood Elf's 35 belongs to its lineage
      features: ['srd:elf/fey-ancestry'],
      choices: [
        { id: 'elven-lineage', level: 1, choose: 1, from: { features: ['srd:elf/elven-lineage-drow', 'srd:elf/elven-lineage-high-elf', 'srd:elf/elven-lineage-wood-elf'] } },
        { id: 'keen-senses', level: 1, choose: 1, from: { skills: ['insight', 'perception', 'survival'] }, grants: 'proficiency' },
      ],
    });
    expect(o.unimplemented).toEqual([]); // the Drow's spells belong to its lineage trait
    expect(o.pdfPage).toBe(84);
  });

  it('a lineage trait carries its race record\'s spell grant; a shared trait does not', () => {
    const w = elfWorld();
    const { kept } = filterRecords(w.records, full);
    const lineage = one(mapSpeciesTrait(ctxFor(kept.find((k) => k.rec.name === 'Elven Lineage, Drow')!, kept, PDF)));
    expect(lineage.item.id).toBe('srd:elf/elven-lineage-drow');
    expect(lineage.unimplemented).toEqual([U.spellGrants()]);
    expect(classify({ ...lineage.classify, unimplemented: lineage.unimplemented }).fidelity).toBe('narrative');
    const fey = one(mapSpeciesTrait(ctxFor(kept.find((k) => k.rec.name === 'Fey Ancestry')!, kept, PDF)));
    expect(fey.unimplemented).toEqual([]);
    expect(fey.item).toEqual({ kind: 'feature', id: 'srd:elf/fey-ancestry', name: 'Fey Ancestry', source: 'SRD 5.2.1 p.85' });
  });

  it('a Trait grant titled with a trait\'s name is that trait\'s resistance; hp and save advantage map from transfer effects', () => {
    const res = trait('Dwarven Resilience', 'dwarf', fid('tRes'));
    const tough = trait('Dwarven Toughness', 'dwarf', fid('tTough'), {}, [
      { _id: 'e1', name: 'T', transfer: true, system: { changes: [{ key: 'system.attributes.hp.bonuses.level', value: 1, type: 'add' }] } },
      { _id: 'e2', name: 'S', transfer: true, system: { changes: [{ key: 'system.abilities.int.save.roll.mode', value: 1, type: 'add' }, { key: 'flags.dnd5e.something', value: true, type: 'override' }] } },
    ]);
    const dwarf = race('Dwarf', 'dwarf', fid('rDwarf'), [
      { type: 'Size', level: 0, configuration: { sizes: ['med'] } },
      { type: 'ItemGrant', level: 0, configuration: { items: [uuid('origins24', res.id), uuid('origins24', tough.id)] } },
      { type: 'Trait', level: 0, title: 'Dwarven Resilience', configuration: { grants: ['dr:poison'], choices: [] } },
    ]);
    const { kept } = filterRecords([res, tough, dwarf], gate);
    expect(kept).toHaveLength(3);
    const sp = one(mapSpecies(ctxFor(kept.find((k) => k.kind === 'species')!, kept, PDF)));
    expect(sp.item.resist).toBeUndefined();
    expect(sp.item.features).toEqual(['srd:dwarf/dwarven-resilience', 'srd:dwarf/dwarven-toughness']);
    const r = one(mapSpeciesTrait(ctxFor(kept.find((k) => k.rec.name === 'Dwarven Resilience')!, kept, PDF)));
    expect(r.item.resist).toEqual(['poison']);
    // Shape 'other': mapped traits are partial until a reviewed override (C7).
    expect(classify({ ...r.classify, unimplemented: r.unimplemented })).toEqual({ fidelity: 'partial', unimplemented: [U.shapeReview()] });
    const t = one(mapSpeciesTrait(ctxFor(kept.find((k) => k.rec.name === 'Dwarven Toughness')!, kept, PDF)));
    expect(t.item.hp).toEqual({ perLevel: 1 });
    expect(t.item.passive).toEqual({ effects: ['dwarven-toughness'] });
    expect(t.item.effects).toEqual([{ id: 'dwarven-toughness', name: 'Dwarven Toughness', mods: [{ on: ['d20.save.int'], op: 'adv' }] }]);
    expect(t.unimplemented).toEqual([U.effectKey('flags.dnd5e.something', 'override')]);
  });

  it('a record with activities maps none of its effects (they may hang on the activity)', () => {
    const t = trait('Dwarven Toughness', 'dwarf', fid('tAct'), { activities: { a: { type: 'utility' } } }, [
      { _id: 'e1', name: 'T', transfer: true, system: { changes: [{ key: 'system.attributes.hp.bonuses.level', value: 1, type: 'add' }] } },
    ]);
    const d = race('Dwarf', 'dwarf', fid('rDw2'), [{ type: 'Size', level: 0, configuration: { sizes: ['med'] } }, { type: 'ItemGrant', level: 0, configuration: { items: [uuid('origins24', t.id)] } }]);
    const { kept } = filterRecords([t, d], gate);
    const o = one(mapSpeciesTrait(ctxFor(kept.find((k) => k.kind === 'speciesTrait')!, kept, PDF)));
    expect(o.item.hp).toBeUndefined();
    expect(o.unimplemented).toEqual([U.activityType('utility'), U.effectKey('system.attributes.hp.bonuses.level', 'add')]);
    expect(o.classify.maps).toBe(false);
  });
});

describe('backgrounds and feats', () => {
  const alert = rec('packs/_source/feats24/origin-feats/alert.yml', { _id: fid('fAlert'), name: 'Alert', type: 'feat', system: { type: { value: 'feat', subtype: 'origin' }, source: SRC, identifier: 'alert', prerequisites: { repeatable: false } } });
  const skilled = rec('packs/_source/feats24/origin-feats/skilled.yml', {
    _id: fid('fSkilled'),
    name: 'Skilled',
    type: 'feat',
    system: { type: { value: 'feat', subtype: 'origin' }, source: SRC, identifier: 'skilled', prerequisites: { repeatable: true }, advancement: [{ type: 'Trait', level: 0, title: '', configuration: { grants: [], choices: [{ count: 3, pool: ['skills:*', 'tool:*'] }] } }] },
  });
  const grappler = rec('packs/_source/feats24/general-feats/grappler.yml', {
    _id: fid('fGrap'),
    name: 'Grappler',
    type: 'feat',
    system: { type: { value: 'feat', subtype: 'general' }, source: SRC, identifier: 'grappler', advancement: [{ type: 'AbilityScoreImprovement', level: 0, configuration: { locked: ['con', 'int', 'wis', 'cha'] } }] },
  });
  const criminal = rec('packs/_source/origins24/backgrounds/criminal.yml', {
    _id: fid('bCrim'),
    name: 'Criminal',
    type: 'background',
    system: {
      source: SRC,
      identifier: 'criminal',
      advancement: [
        { type: 'AbilityScoreImprovement', level: 0, configuration: { locked: ['str', 'wis', 'cha'], points: 3 } },
        { type: 'ItemGrant', level: 0, configuration: { items: [uuid('feats24', alert.id)] } },
        { type: 'Trait', level: 0, configuration: { grants: ['tool:thief', 'skills:ste', 'skills:slt'], choices: [{ count: 1, pool: [] }, { count: 1, pool: ['tool:game:*'] }] } },
        { type: 'Trait', level: 0, configuration: { grants: ['languages:standard:common'], choices: [{ count: 2, pool: ['languages:standard:*'] }] } },
      ],
    },
  });
  const all = [alert, skilled, grappler, criminal];
  const { kept } = filterRecords(all, gate);
  const k = (name: string) => kept.find((x) => x.rec.name === name)!;

  it('a background: unlocked abilities, skills in our order, tools by PDF name, its origin feat', () => {
    const o = one(mapBackground(ctxFor(k('Criminal'), kept, PDF)));
    expect(o.item).toEqual({
      kind: 'background',
      id: 'srd:criminal',
      name: 'Criminal',
      source: 'SRD 5.2.1 p.83',
      abilities: ['dex', 'con', 'int'],
      skills: ['sleight-of-hand', 'stealth'],
      tools: ["Thieves' Tools"],
      feat: 'srd:alert',
      choices: [{ id: 'tools', level: 1, choose: 1, from: { tools: ['Gaming Set (Dice)', 'Gaming Set (Dragonchess)', 'Gaming Set (Playing Cards)', 'Gaming Set (Three-Dragon Ante)'] } }],
    });
    expect(o.unimplemented).toEqual([]);
  });

  it('an unknown tool code fails the import instead of guessing a name', () => {
    const bad = rec('packs/_source/origins24/backgrounds/criminal.yml', {
      name: 'Criminal',
      type: 'background',
      system: { source: SRC, advancement: [{ type: 'Trait', level: 0, configuration: { grants: ['tool:art:brewer'], choices: [] } }] },
    });
    const kk = filterRecords([bad], gate).kept[0]!;
    expect(() => mapBackground(ctxFor(kk, [kk], PDF))).toThrow(/unknown Foundry tool code/);
  });

  it('feats: category from the PDF, repeatable, mapped choices, lines for the rest', () => {
    const a = one(mapFeat(ctxFor(k('Alert'), kept, PDF)));
    expect(a.item).toEqual({ kind: 'feat', id: 'srd:alert', name: 'Alert', source: 'SRD 5.2.1 p.87', category: 'origin' });
    expect(classify({ ...a.classify, unimplemented: a.unimplemented }).fidelity).toBe('narrative');
    const s = one(mapFeat(ctxFor(k('Skilled'), kept, PDF)));
    expect(s.item.repeatable).toBe(true);
    expect((s.item.choices as { choose: number; from: { skills: string[] } }[])[0]!.from.skills).toHaveLength(18);
    expect(s.unimplemented).toEqual([U.choiceNotMapped('tools')]);
    const g = one(mapFeat(ctxFor(k('Grappler'), kept, PDF)));
    expect(g.item.category).toBe('general');
    expect(g.unimplemented).toEqual([U.choiceNotMapped('ability-scores')]);
    for (const o of [a, s, g]) for (const l of o.unimplemented) expect(isTemplateLine(l)).toBe(true);
  });
});

describe('weapons and armor', () => {
  const w = (name: string, system: Record<string, unknown>) =>
    rec(`packs/_source/equipment24/weapons/${name.toLowerCase()}.yml`, { name, type: 'weapon', system: { source: SRC, identifier: name.toLowerCase(), ...system } });
  const a = (name: string, system: Record<string, unknown>) =>
    rec(`packs/_source/equipment24/armor/${name.toLowerCase().replace(/ /g, '-')}.yml`, { name, type: 'equipment', system: { source: SRC, identifier: name.toLowerCase().replace(/ /g, '-'), ...system } });
  const map = (m: Mapper, r: FoundryRecord) => {
    const kk = filterRecords([r], gate).kept[0]!;
    return one(m(ctxFor(kk, [kk], PDF)));
  };

  it('a thrown versatile weapon: range, and the two-handed die one size up when Foundry leaves it empty', () => {
    const o = map(mapWeapon, w('Spear', { type: { value: 'simpleM' }, damage: { base: { number: 1, denomination: 6, types: ['piercing'], bonus: '' }, versatile: { number: null, denomination: 0 } }, properties: ['ver', 'thr'], range: { value: 20, long: 60 }, mastery: 'sap' }));
    expect(o.item).toEqual({ kind: 'weapon', id: 'srd:spear', name: 'Spear', source: 'SRD 5.2.1 p.91', category: 'simple', attack: 'melee', damage: { roll: '1d6', type: 'piercing' }, properties: ['versatile', 'thrown'], range: [20, 60], versatile: '1d8', mastery: 'sap' });
    expect(o.unimplemented).toEqual([]);
  });

  it('the PDF decides (M3 step 5b): a property, range, versatile die or mastery Foundry gets wrong is a line, and the PDF\'s value is emitted', () => {
    const spear = (sys: Record<string, unknown>) =>
      map(mapWeapon, w('Spear', { type: { value: 'simpleM' }, damage: { base: { number: 1, denomination: 6, types: ['piercing'], bonus: '' }, versatile: { number: null, denomination: 0 } }, properties: ['ver', 'thr'], range: { value: 20, long: 60 }, mastery: 'sap', ...sys }));
    const pdfSpear = { kind: 'weapon', id: 'srd:spear', name: 'Spear', source: 'SRD 5.2.1 p.91', category: 'simple', attack: 'melee', damage: { roll: '1d6', type: 'piercing' }, properties: ['versatile', 'thrown'], range: [20, 60], versatile: '1d8', mastery: 'sap' };
    for (const sys of [{ properties: ['ver', 'thr', 'lgt'] }, { range: { value: 30, long: 120 } }, { damage: { base: { number: 1, denomination: 6, types: ['piercing'], bonus: '' }, versatile: { number: 1, denomination: 10 } } }, { mastery: 'vex' }]) {
      const o = spear(sys);
      expect(o.unimplemented, JSON.stringify(sys)).toEqual([U.pdfHeaderDisagrees()]);
      expect(o.item, JSON.stringify(sys)).toEqual(pdfSpear);
    }
  });

  it('disagreeing with the PDF row is a line; an unknown property fails', () => {
    const o = map(mapWeapon, w('Longbow', { type: { value: 'martialR' }, damage: { base: { number: 1, denomination: 10, types: ['piercing'] } }, properties: ['amm', 'hvy', 'two'], range: { value: 150, long: 600 }, mastery: 'slow' }));
    expect(o.unimplemented).toEqual([U.pdfHeaderDisagrees()]);
    expect(() => map(mapWeapon, w('Longbow', { type: { value: 'martialR' }, damage: { base: { number: 1, denomination: 8, types: ['piercing'] } }, properties: ['sil'], range: { value: 150, long: 600 }, mastery: 'slow' }))).toThrow(/closed table/);
  });

  it('armor: medium caps Dex, heavy has Strength and Stealth, the Shield adds', () => {
    expect(map(mapArmor, a('Breastplate', { type: { value: 'medium' }, armor: { value: 14, dex: 2 }, strength: null, properties: [] })).item).toEqual({ kind: 'armor', id: 'srd:breastplate', name: 'Breastplate', source: 'SRD 5.2.1 p.92', category: 'medium', ac: 14, dexCap: 2 });
    const cm = map(mapArmor, a('Chain Mail', { type: { value: 'heavy' }, armor: { value: 16, dex: 0 }, strength: 13, properties: ['stealthDisadvantage'] }));
    expect(cm.item).toEqual({ kind: 'armor', id: 'srd:chain-mail', name: 'Chain Mail', source: 'SRD 5.2.1 p.92', category: 'heavy', ac: 16, strength: 13, stealthDis: true });
    expect(cm.unimplemented).toEqual([]);
    expect(map(mapArmor, a('Shield', { type: { value: 'shield' }, armor: { value: 3, dex: null }, properties: [] })).unimplemented).toEqual([U.pdfHeaderDisagrees()]);
  });
});

// ---- the committed index --------------------------------------------------------------

describe('srd-index.json species traits (the (species, trait) tuples)', () => {
  const ix = JSON.parse(readFileSync(join(IMPORT_DIR, 'srd-index.json'), 'utf8')) as SrdIndex;
  const of = (sp: string) => ix.speciesTraits.filter((t) => t.species === sp && t.of === undefined).map((t) => t.name);
  const opts = (sp: string, tr: string) => ix.speciesTraits.filter((t) => t.species === sp && t.of === tr).map((t) => t.name);

  it('holds every species\' traits and options, read by eye from SRD 5.2.1 p.84-86', () => {
    expect(ix.speciesTraits).toHaveLength(47);
    expect(of('Dwarf')).toEqual(['Darkvision', 'Dwarven Resilience', 'Dwarven Toughness', 'Stonecunning']);
    expect(of('Goliath')).toEqual(['Giant Ancestry', 'Large Form', 'Powerful Build']);
    expect(opts('Goliath', 'Giant Ancestry')).toEqual(['Cloud’s Jaunt', 'Fire’s Burn', 'Frost’s Chill', 'Hill’s Tumble', 'Stone’s Endurance', 'Storm’s Thunder']);
    expect(opts('Elf', 'Elven Lineage')).toEqual(['Drow', 'High Elf', 'Wood Elf']);
    expect(opts('Gnome', 'Gnomish Lineage')).toEqual(['Forest Gnome', 'Rock Gnome']);
    expect(opts('Tiefling', 'Fiendish Legacy')).toEqual(['Abyssal', 'Chthonic', 'Infernal']);
    expect(of('Human')).toEqual(['Resourceful', 'Skillful', 'Versatile']);
  });
});

// ---- the real records (skipped without the cache) ------------------------------------

/** SRD 5.2.1 Weapons table, p.91, transcribed by hand: damage, properties, range, versatile, mastery. */
const WEAPONS: Readonly<Record<string, string>> = {
  Club: 'simple melee 1d4 bludgeoning | light | - | - | slow',
  Dagger: 'simple melee 1d4 piercing | finesse,light,thrown | 20/60 | - | nick',
  Greatclub: 'simple melee 1d8 bludgeoning | two-handed | - | - | push',
  Handaxe: 'simple melee 1d6 slashing | light,thrown | 20/60 | - | vex',
  Javelin: 'simple melee 1d6 piercing | thrown | 30/120 | - | slow',
  'Light Hammer': 'simple melee 1d4 bludgeoning | light,thrown | 20/60 | - | nick',
  Mace: 'simple melee 1d6 bludgeoning | - | - | - | sap',
  Quarterstaff: 'simple melee 1d6 bludgeoning | versatile | - | 1d8 | topple',
  Sickle: 'simple melee 1d4 slashing | light | - | - | nick',
  Spear: 'simple melee 1d6 piercing | versatile,thrown | 20/60 | 1d8 | sap',
  Dart: 'simple ranged 1d4 piercing | finesse,thrown | 20/60 | - | vex',
  'Light Crossbow': 'simple ranged 1d8 piercing | two-handed,ammunition,loading | 80/320 | - | slow',
  Shortbow: 'simple ranged 1d6 piercing | two-handed,ammunition | 80/320 | - | vex',
  Sling: 'simple ranged 1d4 bludgeoning | ammunition | 30/120 | - | slow',
  Battleaxe: 'martial melee 1d8 slashing | versatile | - | 1d10 | topple',
  Flail: 'martial melee 1d8 bludgeoning | - | - | - | sap',
  Glaive: 'martial melee 1d10 slashing | heavy,two-handed,reach | - | - | graze',
  Greataxe: 'martial melee 1d12 slashing | heavy,two-handed | - | - | cleave',
  Greatsword: 'martial melee 2d6 slashing | heavy,two-handed | - | - | graze',
  Halberd: 'martial melee 1d10 slashing | heavy,two-handed,reach | - | - | cleave',
  Lance: 'martial melee 1d10 piercing | heavy,two-handed,reach | - | - | topple',
  Longsword: 'martial melee 1d8 slashing | versatile | - | 1d10 | sap',
  Maul: 'martial melee 2d6 bludgeoning | heavy,two-handed | - | - | topple',
  Morningstar: 'martial melee 1d8 piercing | - | - | - | sap',
  Pike: 'martial melee 1d10 piercing | heavy,two-handed,reach | - | - | push',
  Rapier: 'martial melee 1d8 piercing | finesse | - | - | vex',
  Scimitar: 'martial melee 1d6 slashing | finesse,light | - | - | nick',
  Shortsword: 'martial melee 1d6 piercing | finesse,light | - | - | vex',
  Trident: 'martial melee 1d8 piercing | versatile,thrown | 20/60 | 1d10 | topple',
  Warhammer: 'martial melee 1d8 bludgeoning | versatile | - | 1d10 | push',
  'War Pick': 'martial melee 1d8 piercing | versatile | - | 1d10 | sap',
  Whip: 'martial melee 1d4 slashing | finesse,reach | - | - | slow',
  Blowgun: 'martial ranged 1 piercing | ammunition,loading | 25/100 | - | vex',
  'Hand Crossbow': 'martial ranged 1d6 piercing | light,ammunition,loading | 30/120 | - | vex',
  'Heavy Crossbow': 'martial ranged 1d10 piercing | heavy,two-handed,ammunition,loading | 100/400 | - | push',
  Longbow: 'martial ranged 1d8 piercing | heavy,two-handed,ammunition | 150/600 | - | slow',
  Musket: 'martial ranged 1d12 piercing | two-handed,ammunition,loading | 40/120 | - | slow',
  Pistol: 'martial ranged 1d10 piercing | ammunition,loading | 30/90 | - | vex',
};

/** SRD 5.2.1 Armor table, p.92, transcribed by hand: category ac dexCap strength stealth. */
const ARMOR: Readonly<Record<string, string>> = {
  'Padded Armor': 'light 11 - - dis',
  'Leather Armor': 'light 11 - - -',
  'Studded Leather Armor': 'light 12 - - -',
  'Hide Armor': 'medium 12 2 - -',
  'Chain Shirt': 'medium 13 2 - -',
  'Scale Mail': 'medium 14 2 - dis',
  Breastplate: 'medium 14 2 - -',
  'Half Plate Armor': 'medium 15 2 - dis',
  'Ring Mail': 'heavy 14 - - dis',
  'Chain Mail': 'heavy 16 - 13 dis',
  'Splint Armor': 'heavy 17 - 15 dis',
  'Plate Armor': 'heavy 18 - 15 dis',
  Shield: 'shield 2 - - -',
};

const tree = (() => {
  try {
    return cachePaths().foundryTree;
  } catch {
    return undefined;
  }
})();
const haveTree = tree !== undefined && existsSync(join(tree, 'packs/_source/origins24'));

describe.skipIf(!haveTree)('the real records (pinned Foundry tree in the import cache)', () => {
  const ix = JSON.parse(readFileSync(join(IMPORT_DIR, 'srd-index.json'), 'utf8')) as SrdIndex;
  const records = haveTree ? readFoundry(tree!, ['equipment24', 'feats24', 'origins24']) : [];
  const { kept } = filterRecords(records, indexFromJson(ix), ['armor', 'background', 'feat', 'species', 'speciesTrait', 'weapon']);
  const mappers: Readonly<Record<string, Mapper>> = { armor: mapArmor, background: mapBackground, feat: mapFeat, species: mapSpecies, speciesTrait: mapSpeciesTrait, weapon: mapWeapon };
  const all = kept.flatMap((k) => outs(mappers[k.kind]!(ctxFor(k, kept, ix))).map((o) => ({ o, k })));
  const byKind = (kind: string) => all.filter((x) => x.o.kind === kind).map((x) => x.o);

  it('every PDF entry, and only those, becomes one item', () => {
    expect(byKind('species').map((o) => o.item.name).sort()).toEqual(ix.species.map((s) => s.name).sort());
    expect(byKind('background')).toHaveLength(4);
    expect(byKind('feat')).toHaveLength(17);
    expect(byKind('feat').filter((o) => o.item.category === 'origin').map((o) => o.item.id).sort()).toEqual(['srd:alert', 'srd:magic-initiate', 'srd:savage-attacker', 'srd:skilled']);
    expect(byKind('weapon').map((o) => o.item.name).sort()).toEqual(Object.keys(WEAPONS).sort());
    expect(byKind('armor').map((o) => o.item.name).sort()).toEqual(Object.keys(ARMOR).sort());
    // 36 trait records, plus 7 PDF stubs for traits Foundry keeps outside trait items
    // (Darkvision for 6 species, Dragonborn's Draconic Ancestry; review F1).
    expect(byKind('feature')).toHaveLength(43);
  });

  it('weapons equal the PDF Weapons table, with no disagreement lines', () => {
    for (const o of byKind('weapon')) {
      const it = o.item as Record<string, unknown> & { damage: { roll: string; type: string }; range?: number[]; properties?: string[] };
      const got = `${it.category} ${it.attack} ${it.damage.roll} ${it.damage.type} | ${(it.properties ?? []).join(',') || '-'} | ${it.range ? it.range.join('/') : '-'} | ${it.versatile ?? '-'} | ${it.mastery}`;
      const want = WEAPONS[it.name as string]!.replace(/\| ([a-z,-]+) \|/, (_m, p: string) => `| ${p === '-' ? '-' : p.split(',').sort((x, y) => ORDER.indexOf(x) - ORDER.indexOf(y)).join(',')} |`);
      expect(got, String(it.name)).toBe(want);
      expect(o.unimplemented).toEqual([]);
    }
  });

  it('armor equals the PDF Armor table', () => {
    for (const o of byKind('armor')) {
      const it = o.item as Record<string, unknown>;
      expect(`${it.category} ${it.ac} ${it.dexCap ?? '-'} ${it.strength ?? '-'} ${it.stealthDis ? 'dis' : '-'}`, String(it.name)).toBe(ARMOR[it.name as string]);
      expect(o.unimplemented).toEqual([]);
    }
  });

  it('species read as the PDF prints them (size, speed), lineages as one choice', () => {
    const sp = Object.fromEntries(byKind('species').map((o) => [o.item.name as string, o.item]));
    expect(sp.Elf!.speed).toBe(30);
    expect(sp.Goliath!.speed).toBe(35);
    expect(sp.Human!.size).toEqual(['small', 'medium']);
    expect(sp.Tiefling!.size).toEqual(['small', 'medium']);
    expect(sp.Gnome!.size).toEqual(['small']);
    const choice = (s: Record<string, unknown>, id: string) => (s.choices as { id: string; from: Record<string, string[]> }[]).find((c) => c.id === id)!.from;
    expect(choice(sp.Elf!, 'elven-lineage').features).toHaveLength(3);
    expect(choice(sp.Gnome!, 'gnomish-lineage').features).toHaveLength(2);
    expect(choice(sp.Tiefling!, 'fiendish-legacy').features).toHaveLength(3);
    expect(choice(sp.Goliath!, 'giant-ancestry').features).toHaveLength(6);
    expect(choice(sp.Human!, 'versatile').feats).toEqual(['srd:alert', 'srd:magic-initiate', 'srd:savage-attacker', 'srd:skilled']);
    // Every feature a species names is emitted.
    const features = new Set(byKind('feature').map((o) => o.item.id as string));
    for (const s of Object.values(sp)) {
      for (const e of (s.features as (string | { id: string })[] | undefined) ?? []) {
        const f = typeof e === 'string' ? e : e.id;
        expect(features.has(f), f).toBe(true);
      }
      for (const c of (s.choices as { from: { features?: string[] } }[] | undefined) ?? []) for (const f of c.from.features ?? []) expect(features.has(f), f).toBe(true);
    }
  });

  it('the items load in the engine, with every line from the closed templates', () => {
    const files = all.map(({ o }, i) => {
      const c = classify({ ...o.classify, unimplemented: o.unimplemented });
      const item = { ...o.item, fidelity: c.fidelity, ...(c.unimplemented.length ? { unimplemented: c.unimplemented } : {}) };
      for (const l of c.unimplemented) expect(isTemplateLine(l)).toBe(true);
      return { path: `packs/srd-5.2.1/x/${i}.yaml`, text: stringify(item) };
    });
    files.push({ path: 'packs/srd-5.2.1/manifest.yaml', text: readFileSync(join(IMPORT_DIR, '..', '..', 'packs', 'srd-5.2.1', 'manifest.yaml'), 'utf8') });
    const r = loadContent(files);
    expect(r.errors.map((e) => e.message)).toEqual([]);
    expect(r.warnings.map((e) => e.message)).toEqual([]);
  });
});

const ORDER: readonly string[] = ['finesse', 'light', 'heavy', 'two-handed', 'versatile', 'thrown', 'ammunition', 'loading', 'reach'];
