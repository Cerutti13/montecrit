// M3 step 3: the importer carry-overs that make the generated data serve kind: character
// (docs/design/m3.md step 2 build note "carried to step 3"; C9a, C16, C24). Each block is a
// regression test for one change: PDF feature options and species trait levels in the index,
// the featureOption gate, feature-option choices, species features at a level, subclass
// scaleOwner, the fail-closed @scale and hp-grant checks, explicit skill-choice grants, and
// feat ability choices. Synthetic inputs plus the committed pack; no cache, no home dir.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { HP_GRANTS, hpProblems, poolProblems, scaleProblems } from '../data-checks.ts';
import { filterRecords, indexFromJson, indexFromTuples } from '../filter.ts';
import { abilityChoice } from '../map/feat.ts';
import type { SrdIndex } from '../pdf/build.ts';
import { parseChapterHeadings } from '../pdf/headings.ts';
import { parseBboxLayout } from '../pdf/lines.ts';
import { parseOrigins } from '../pdf/origins.ts';
import { bbox, L } from '../pdf/test-fixtures.ts';
import { parseRecord, type FoundryRecord } from '../read.ts';
import { IMPORT_DIR, REPO_ROOT } from '../util.ts';

const H1 = 31.0;
const H2 = 21.5;
const H3 = 16.7;
const H4 = 14.3;
const SUB = 13.3;
const BODY = 34.1;
const RUNIN = 35.1;

const index = JSON.parse(readFileSync(join(IMPORT_DIR, 'srd-index.json'), 'utf8')) as SrdIndex;
const PACK = join(REPO_ROOT, 'packs/srd-5.2.1');
type Item = Record<string, unknown>;
const packItems = (): Map<string, Item> => {
  const out = new Map<string, Item>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.yaml') && e.name !== 'manifest.yaml') {
        const it = parse(readFileSync(p, 'utf8')) as Item;
        if (typeof it?.id === 'string') out.set(it.id, it);
      }
    }
  };
  walk(PACK);
  return out;
};
const items = packItems();
const get = (id: string): Item => {
  const it = items.get(id);
  if (!it) throw new Error(`no ${id} in the pack`);
  return it;
};
type Choice = { id: string; level: number; choose: number; from: Record<string, string[]>; grants?: string };
const choices = (id: string): Choice[] => (get(id).choices as Choice[] | undefined) ?? [];

describe('PDF index: feature options', () => {
  const lines = parseBboxLayout(
    bbox([
      [
        L(133, 35, H1, 'Classes'),
        L(63, 60, H2, 'Cleric'),
        L(63, 100, H4, 'Level 1: Holy Order'),
        L(63, 115, BODY, 'You take one of the following roles of your choice.'),
        L(71, 130, RUNIN, 'Shieldbearer. You gain heavy armor.'),
        L(63, 145, BODY, 'more text'),
        L(71, 160, RUNIN, 'Lorekeeper. You learn a cantrip.'),
        L(63, 190, H4, 'Level 1: Spellcasting'),
        L(63, 205, BODY, 'You cast spells.'),
        L(71, 220, RUNIN, 'Spellcasting Focus. A holy symbol.'),
        L(63, 250, H4, 'Level 2: Tricks'),
        L(63, 265, BODY, 'You gain tricks of your choice from "Trick Options" later in this class\'s description.'),
        L(71, 280, RUNIN, 'Prerequisites. Some need a level.'),
        L(313.5, 40, H3, 'Trick Options'),
        L(313.5, 60, H4, 'Quick Trick'),
        L(313.5, 74, SUB, 'Cost: 1 point'),
        L(313.5, 100, H4, 'Slow Trick'),
        L(313.5, 130, H3, 'Cleric Subclass: Light'),
        L(313.5, 150, H4, 'Level 3: Dawn Choice'),
        L(313.5, 165, BODY, 'Choose the option below.'),
        L(321.5, 180, RUNIN, 'Morning Glow. You shine.'),
      ],
    ]),
  );
  const h = parseChapterHeadings(lines);

  it('reads run-ins under a feature whose intro offers a choice, and an options section', () => {
    expect(h.options.map((o) => [o.subclass ?? o.class, o.level, o.feature, o.name])).toEqual([
      ['cleric', 1, 'Holy Order', 'Shieldbearer'],
      ['cleric', 1, 'Holy Order', 'Lorekeeper'],
      ['cleric', 2, 'Tricks', 'Quick Trick'],
      ['cleric', 2, 'Tricks', 'Slow Trick'],
      ['light', 3, 'Dawn Choice', 'Morning Glow'],
    ]);
  });

  it('leaves out a run-in that is a rule ("Spellcasting Focus.") and one in an intro that points elsewhere', () => {
    expect(h.options.some((o) => o.name === 'Spellcasting Focus' || o.name === 'Prerequisites')).toBe(false);
  });

  it('the committed index holds the 54 options of SRD 5.2.1, each under a real feature', () => {
    expect(index.featureOptions).toHaveLength(54);
    const of = (cls: string, feature: string) => index.featureOptions.filter((o) => o.class === cls && o.feature === feature).map((o) => o.name);
    expect(of('cleric', 'Divine Order')).toEqual(['Protector', 'Thaumaturge']);
    expect(of('druid', 'Primal Order')).toEqual(['Magician', 'Warden']);
    expect(of('paladin', 'Fighting Style')).toEqual(['Blessed Warrior']);
    expect(of('ranger', 'Fighting Style')).toEqual(['Druidic Warrior']);
    expect(of('sorcerer', 'Metamagic')).toHaveLength(10);
    expect(of('warlock', 'Eldritch Invocations')).toHaveLength(28);
  });
});

describe('PDF index: species traits that start at a character level', () => {
  it('reads "When you reach character level N" across the line break, and "Starting at character level N"', () => {
    const o = parseOrigins(
      parseBboxLayout(
        bbox([
          [
            L(63, 40, H3, 'Species Descriptions'),
            L(63, 60, H4, 'Wyrmkin'),
            L(63, 75, 11.9, 'Creature Type: Humanoid'),
            L(71, 100, RUNIN, 'Wing Flight. When you reach character level'),
            L(63, 115, BODY, '5, you can fly.'),
            L(71, 130, RUNIN, 'Big Shape. Starting at character level 7, you grow.'),
            L(71, 160, RUNIN, 'Tough Hide. You have scales.'),
          ],
        ]),
      ),
    );
    expect(o.speciesTraits).toEqual([
      { species: 'Wyrmkin', name: 'Wing Flight', page: 1, level: 5 },
      { species: 'Wyrmkin', name: 'Big Shape', page: 1, level: 7 },
      { species: 'Wyrmkin', name: 'Tough Hide', page: 1 },
    ]);
  });

  it('the committed index has exactly Draconic Flight and Large Form at 5', () => {
    expect(index.speciesTraits.filter((t) => t.level !== undefined).map((t) => [t.species, t.name, t.level])).toEqual([
      ['Dragonborn', 'Draconic Flight', 5],
      ['Goliath', 'Large Form', 5],
    ]);
  });
});

describe('the featureOption gate (C4)', () => {
  const SRC = { license: 'CC-BY-4.0', book: '', rules: '2024' };
  const rec = (path: string, doc: Record<string, unknown>): FoundryRecord => parseRecord(path, stringify(doc));
  const option = (id: string, name: string) =>
    rec(`packs/_source/classes24/cleric/class-features/${id.toLowerCase()}.yml`, { _id: id, name, type: 'feat', system: { type: { value: 'class' }, source: SRC, identifier: id.toLowerCase() } });
  const records = [
    rec('packs/_source/classes24/cleric/cleric.yml', {
      _id: 'cClericAAAAAAAAA',
      name: 'Cleric',
      type: 'class',
      system: {
        identifier: 'cleric',
        source: SRC,
        advancement: [{ type: 'ItemChoice', title: 'Holy Order Choice', configuration: { choices: { 1: { count: 1 } }, pool: [{ uuid: 'Compendium.dnd5e.classes24.Item.oShieldAAAAAAAAA' }, { uuid: 'Compendium.dnd5e.classes24.Item.oZealotAAAAAAAAA' }] } }],
      },
    }),
    option('oShieldAAAAAAAAA', 'Holy Order: Shieldbearer'),
    option('oZealotAAAAAAAAA', 'Holy Order: Zealot'),
  ];
  it('admits an option only on the PDF tuple (owner, level, option), with or without its feature prefix', () => {
    const ix = indexFromTuples({ class: [['Cleric']], featureOption: [['Cleric', 1, 'Holy Order: Shieldbearer']] });
    const { kept, drops } = filterRecords(records, ix);
    expect(kept.map((k) => k.rec.name)).toEqual(['Cleric', 'Holy Order: Shieldbearer']);
    expect(drops.find((d) => d.name === 'Holy Order: Zealot')?.reason).toBe('not-in-srd-pdf');
    // At the wrong level the tuple doesn't match.
    expect(filterRecords(records, indexFromTuples({ class: [['Cleric']], featureOption: [['Cleric', 2, 'Holy Order: Shieldbearer']] })).kept).toHaveLength(1);
  });
  it('the index adapter registers both spellings for every PDF option', () => {
    const ix = indexFromJson(index);
    expect(ix.has('featureOption', ['Cleric', 1, 'Divine Order: Protector'])).toBe(true);
    expect(ix.has('featureOption', ['Paladin', 2, 'Blessed Warrior'])).toBe(true);
    expect(ix.has('featureOption', ['Sorcerer', 2, 'Careful Spell'])).toBe(true);
    expect(ix.has('featureOption', ['Cleric', 2, 'Divine Order: Protector'])).toBe(false);
  });
});

describe('the committed pack: choices a character file picks', () => {
  it('feature-option choices name emitted option features, id from the title without " Choice"', () => {
    expect(choices('srd:cleric').find((c) => c.id === 'divine-order')).toEqual({ id: 'divine-order', level: 1, choose: 1, from: { features: ['srd:cleric/divine-order-protector', 'srd:cleric/divine-order-thaumaturge'] } });
    expect(choices('srd:cleric').find((c) => c.id === 'blessed-strikes')?.level).toBe(7);
    expect(choices('srd:druid').map((c) => c.id)).toEqual(expect.arrayContaining(['primal-order', 'elemental-fury']));
    for (const c of [...items.values()].flatMap((it) => (it.choices as Choice[] | undefined) ?? [])) for (const f of c.from.features ?? []) expect(items.has(f), f).toBe(true);
    // The step-2 lines for these choices are gone.
    expect(get('srd:cleric').unimplemented).toBeUndefined();
  });

  it('Fighting Style offers the class-specific option beside the feats (Paladin, Ranger)', () => {
    const p = choices('srd:paladin').find((c) => c.id === 'fighting-style')!;
    expect(p.from.features).toEqual(['srd:paladin/blessed-warrior']);
    expect(p.from.feats).toHaveLength(4);
    expect(choices('srd:ranger').find((c) => c.id === 'fighting-style')!.from.features).toEqual(['srd:ranger/druidic-warrior']);
    expect((get('srd:paladin').unimplemented as string[]).includes('choice fighting-style not mapped')).toBe(false);
  });

  it('a choice that picks again later is one choice per level (Metamagic 2/10/17, invocations 1-18)', () => {
    const m = choices('srd:sorcerer').filter((c) => c.id.startsWith('metamagic'));
    expect(m.map((c) => [c.id, c.level, c.choose, c.from.features!.length])).toEqual([
      ['metamagic-2', 2, 2, 10],
      ['metamagic-10', 10, 2, 10],
      ['metamagic-17', 17, 2, 10],
    ]);
    const inv = choices('srd:warlock').filter((c) => c.id.startsWith('eldritch-invocations'));
    // The PDF's Warlock table: 1 at level 1, then 3, 5, 6, 7, 8, 9, 10 invocations.
    expect(inv.map((c) => [c.level, c.choose])).toEqual([[1, 1], [2, 2], [5, 2], [7, 1], [9, 1], [12, 1], [15, 1], [18, 1]]);
    const cols = index.classes.warlock.table.columns;
    const col = 'eldritch-invocations';
    let sum = 0;
    for (const c of inv) {
      sum += c.choose;
      expect(cols[col]![c.level - 1], `level ${c.level}`).toBe(sum);
    }
  });

  it('every skills choice says what it grants; expertise choices say expertise', () => {
    for (const [id, it] of items) {
      for (const c of (it.choices as Choice[] | undefined) ?? []) {
        if (!c.from.skills) continue;
        expect(c.grants, `${id}#${c.id}`).toBe(c.id.startsWith('expertise') ? 'expertise' : 'proficiency');
      }
    }
  });

  it('feat ability choices follow the PDF\'s "Ability Score Increase" text; the ASI feat keeps its line', () => {
    const want: Record<string, string[]> = {
      'srd:grappler': ['str', 'dex'], // "Increase your Strength or Dexterity score by 1"
      'srd:boon-of-irresistible-offense': ['str', 'dex'],
      'srd:boon-of-spell-recall': ['int', 'wis', 'cha'],
      'srd:boon-of-combat-prowess': ['str', 'dex', 'con', 'int', 'wis', 'cha'], // "one ability score of your choice"
      'srd:boon-of-dimensional-travel': ['str', 'dex', 'con', 'int', 'wis', 'cha'],
      'srd:boon-of-fate': ['str', 'dex', 'con', 'int', 'wis', 'cha'],
      'srd:boon-of-the-night-spirit': ['str', 'dex', 'con', 'int', 'wis', 'cha'],
      'srd:boon-of-truesight': ['str', 'dex', 'con', 'int', 'wis', 'cha'],
    };
    for (const [id, from] of Object.entries(want)) expect(choices(id).find((c) => c.id === 'ability-scores'), id).toEqual({ id: 'ability-scores', level: 1, choose: 1, from: { abilities: from } });
    expect(get('srd:grappler').fidelity).toBe('narrative'); // the increase alone doesn't map the feat
    expect(get('srd:ability-score-improvement').unimplemented).toContain('choice ability-scores not mapped');
    expect(abilityChoice({ type: 'AbilityScoreImprovement', configuration: { points: 2, cap: 2, fixed: {}, locked: [] } })).toBeUndefined();
    expect(abilityChoice({ type: 'AbilityScoreImprovement', configuration: { points: 1, cap: 1, fixed: { str: 1 }, locked: [] } })).toBeUndefined();
  });
});

describe('species features at a character level', () => {
  it('Draconic Flight and Large Form are { id, level: 5 }; everything else is a bare id', () => {
    const leveled = [...items.values()].filter((it) => it.kind === 'species').flatMap((it) => ((it.features as unknown[]) ?? []).filter((f) => typeof f !== 'string'));
    expect(leveled).toEqual([
      { id: 'srd:dragonborn/draconic-flight', level: 5 },
      { id: 'srd:goliath/large-form', level: 5 },
    ]);
  });
});

describe('subclass scaleOwner (C16)', () => {
  it('is Foundry\'s identifier where it differs from the local id, so @scale.land.lands-aid resolves', () => {
    const owners = Object.fromEntries([...items.values()].filter((it) => it.kind === 'subclass').map((it) => [it.id, it.scaleOwner ?? null]));
    expect(owners).toEqual({
      'srd:champion': null,
      'srd:circle-of-the-land': 'land',
      'srd:college-of-lore': 'lore',
      'srd:draconic-sorcery': 'draconic',
      'srd:evoker': null,
      'srd:fiend-patron': 'fiend',
      'srd:hunter': null,
      'srd:life-domain': 'life',
      'srd:oath-of-devotion': 'devotion',
      'srd:path-of-the-berserker': 'berserker',
      'srd:thief': null,
      'srd:warrior-of-the-open-hand': 'hand',
    });
  });
});

describe('@scale references resolve (fail closed)', () => {
  const land = { kind: 'subclass', id: 'srd:circle-of-the-land', parent: 'srd:druid', scale: { 'lands-aid': { type: 'dice', at: { 3: '2d6' } } }, features: { 3: ['srd:circle-of-the-land/lands-aid'] } };
  const druid = { kind: 'class', id: 'srd:druid', scale: { 'wild-shape-uses': { type: 'number', at: { 2: 2 } }, slots: { type: 'slots', at: { 1: [2] } } }, features: { 2: ['srd:druid/wild-shape'] }, pools: [{ max: '@scale.druid.wild-shape-uses' }] };
  const feat = (id: string, formula: string) => [id, { kind: 'feature', id, effects: [{ roll: formula }] }] as const;
  const run = (extra: readonly (readonly [string, Item])[], landOver: Item = {}) =>
    scaleProblems(new Map<string, Item>([['srd:druid', druid], ['srd:circle-of-the-land', { ...land, ...landOver }], ...extra]));

  it('the committed pack has none that fail', () => {
    expect(scaleProblems(items)).toEqual([]);
  });
  it('a subclass feature reads @scale.<scaleOwner>.<col> only when scaleOwner is set', () => {
    expect(run([feat('srd:circle-of-the-land/lands-aid', '@scale.land.lands-aid')], { scaleOwner: 'land' })).toEqual([]);
    expect(run([feat('srd:circle-of-the-land/lands-aid', '@scale.land.lands-aid')])).toHaveLength(1);
    expect(run([feat('srd:circle-of-the-land/lands-aid', '@scale.circle-of-the-land.lands-aid')])).toEqual([]);
    expect(run([feat('srd:circle-of-the-land/lands-aid', '@scale.lands-aid')])).toEqual([]);
  });
  it('a subclass column under the parent\'s name, a 3-part ref, a slots column, an ungranted feature and a species all fail', () => {
    expect(run([feat('srd:circle-of-the-land/lands-aid', '@scale.druid.lands-aid')])).toHaveLength(1);
    expect(run([feat('srd:druid/wild-shape', '@scale.druid.wild-shape-uses.number')])).toHaveLength(1);
    expect(run([feat('srd:druid/wild-shape', '@scale.druid.slots')])).toHaveLength(1);
    expect(run([feat('srd:druid/orphan', '@scale.druid.wild-shape-uses')])).toHaveLength(1);
    expect(run([['srd:dragonborn', { kind: 'species', id: 'srd:dragonborn', note: '@scale.dragonborn.breath' }]])).toHaveLength(1);
  });
  it('a feature granted by two owners must resolve under both', () => {
    const other = { kind: 'class', id: 'srd:bard', scale: {}, features: { 1: ['srd:druid/wild-shape'] } };
    expect(run([feat('srd:druid/wild-shape', '@scale.wild-shape-uses'), ['srd:bard', other]])).toHaveLength(1);
  });
  it('a scale column id that starts with a digit fails', () => {
    expect(run([], { scale: { '2nd-wind': { type: 'number', at: { 3: 1 } } } }).some((p) => p.includes('2nd-wind'))).toBe(true);
  });
});

describe('feature hp grants equal the PDF (C9a, fail closed)', () => {
  it('the committed pack carries exactly HP_GRANTS', () => {
    expect(hpProblems(items)).toEqual([]);
    expect(get('srd:draconic-sorcery/draconic-resilience').hp).toEqual({ perLevel: 1 });
    expect(get('srd:dwarf/dwarven-toughness').hp).toEqual({ perLevel: 1 });
    expect(Object.keys(HP_GRANTS).sort()).toEqual(['srd:draconic-sorcery/draconic-resilience', 'srd:dwarf/dwarven-toughness']);
  });
  it('a different grant, an unlisted grant, or a missing one fails; an absent owner is skipped', () => {
    const m = (entries: [string, Item][]) => new Map<string, Item>(entries);
    expect(hpProblems(m([['srd:draconic-sorcery', {}], ['srd:draconic-sorcery/draconic-resilience', { kind: 'feature', hp: { flat: 3, perLevel: 1 } }]]))).toHaveLength(1);
    expect(hpProblems(m([['srd:x/tough', { kind: 'feature', hp: { perLevel: 2 } }]]))).toHaveLength(1);
    expect(hpProblems(m([['srd:dwarf', {}], ['srd:dwarf/dwarven-toughness', { kind: 'feature' }]]))).toHaveLength(1);
    expect(hpProblems(m([]))).toEqual([]);
  });
});

describe('every class and subclass pool is named after a feature its owner grants (review R1, fail closed)', () => {
  it('the committed pack has none that fail', () => {
    expect(poolProblems(items)).toEqual([]);
  });
  it('a pool with no same-named feature in its owner\'s features fails', () => {
    const cls = { kind: 'class', id: 'srd:x', features: { 2: ['srd:x/surge'] }, pools: [{ id: 'surge' }, { id: 'orphan' }] };
    expect(poolProblems(new Map<string, Item>([['srd:x', cls]]))).toEqual(['srd:x: pool orphan names no feature in its features by level, so no level gates it']);
  });
});
