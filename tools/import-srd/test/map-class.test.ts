// The class, subclass and feature mappers (docs/design/m3.md 2.2, 2.4, 4.3, 4.9; C2, C4, C16,
// C21). Synthetic Foundry-shaped records through the whole pipeline (filter, map, classify,
// overrides, emit) and then the engine loader; then, when the import cache holds the pinned
// Foundry tree, the real 12 classes and 12 subclasses. Nothing under the home dir is read.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { loadContent } from '../../../packages/engine/src/content/load.ts';
import { filterRecords, indexFromJson } from '../filter.ts';
import { buildImport } from '../main.ts';
import { MAPPERS } from '../map/index.ts';
import { scaleOf, slotsOf, spellListFromIndex } from '../map/class.ts';
import { mapEffects } from '../map/feature.ts';
import type { IndexClass, SrdIndex } from '../pdf/build.ts';
import { parsePins } from '../pins.ts';
import { parseRecord, readFoundry, type FoundryRecord } from '../read.ts';
import { isTemplateLine } from '../unimplemented.ts';
import { cachePaths, IMPORT_DIR, REPO_ROOT } from '../util.ts';

const SRC = { license: 'CC-BY-4.0', book: '', rules: '2024', revision: 1, custom: '' };
const fid = (stem: string): string => `${stem}${'0'.repeat(16)}`.slice(0, 16);
const uuid = (pack: string, id: string) => ({ uuid: `Compendium.dnd5e.${pack}.Item.${id}`, optional: false });
const rec = (path: string, doc: Record<string, unknown>): FoundryRecord => parseRecord(path, stringify(doc));
const pins = () => parsePins(readFileSync(join(IMPORT_DIR, 'pins.json'), 'utf8'));
const MANIFEST = { path: 'packs/srd-5.2.1/manifest.yaml', text: readFileSync(join(REPO_ROOT, 'packs/srd-5.2.1/manifest.yaml'), 'utf8') };

const ramp = (pairs: readonly [number, number][]): number[] => {
  const out: number[] = [];
  for (let l = 1; l <= 20; l++) out.push(pairs.filter(([at]) => at <= l).at(-1)?.[1] ?? 0);
  return out;
};

/** A Fighter-shaped class table: Second Wind printed, Epic Boon at 19, Extra Attack at 5 and 11. */
function fighterPdf(): IndexClass {
  return {
    name: 'Fighter',
    hitDie: 10,
    chapter: { first: 46, last: 48 },
    table: {
      page: 47,
      columnOrder: ['proficiency-bonus', 'second-wind'],
      units: { 'proficiency-bonus': 'bonus' },
      columns: { 'proficiency-bonus': ramp([[1, 2], [5, 3], [9, 4], [13, 5], [17, 6]]), 'second-wind': ramp([[1, 2], [4, 3], [10, 4]]) },
    },
    features: [
      { level: 1, name: 'Second Wind', page: 47, described: true },
      { level: 2, name: 'Danger Sense', page: 47, described: true },
      { level: 3, name: 'Fighter Subclass', page: 47, described: true },
      { level: 4, name: 'Ability Score Improvement', page: 47, described: true },
      { level: 5, name: 'Extra Attack', page: 47, described: true },
      { level: 11, name: 'Two Extra Attacks', page: 48, described: true },
      { level: 13, name: 'Second Wind', page: 47, detail: 'more', described: false },
      { level: 19, name: 'Epic Boon', page: 48, described: true },
    ],
    subclassLevels: [],
  };
}

function pdfIndex(classes: Record<string, IndexClass>): SrdIndex {
  return {
    source: { pdfSha256: 'f'.repeat(64), pages: 364 },
    counts: {},
    classes: classes as SrdIndex['classes'],
    subclasses: { champion: { class: 'fighter', name: 'Champion', page: 48, features: [{ level: 3, name: 'Improved Critical', page: 48 }] } },
    hitPoints: { level1: { page: 22, values: {} as never }, fixedPerLevel: { page: 23, values: {} as never } },
    species: [],
    speciesTraits: [],
    backgrounds: [],
    feats: [],
    spells: [
      { name: 'Magic Missile', level: 1, school: 'Evocation', classes: ['sorcerer', 'wizard'], page: 140 },
      { name: 'Fire Bolt', level: 0, school: 'Evocation', classes: ['sorcerer', 'wizard'], page: 130 },
      { name: 'Cure Wounds', level: 1, school: 'Abjuration', classes: ['bard', 'cleric'], page: 120 },
    ] as SrdIndex['spells'],
    weapons: [],
    armor: [],
    featureOptions: [],
    spellListTableGaps: [],
  };
}

const trait = (level: number, grants: string[], choices: unknown[] = [], extra: Record<string, unknown> = {}) => ({
  type: 'Trait',
  level,
  classRestriction: 'primary',
  configuration: { mode: 'default', grants, choices },
  ...extra,
});

const featureRec = (name: string, folder: string, id: string, system: Record<string, unknown> = {}, effects: unknown[] = [], source: Record<string, unknown> = SRC) =>
  rec(`packs/_source/classes24/fighter/${folder}/${id.toLowerCase()}.yml`, {
    _id: id,
    name,
    type: 'feat',
    system: { type: { value: folder === 'subclass-features' ? 'subclass' : 'class', subtype: '' }, source, identifier: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), description: { value: '<p>x</p>' }, ...system },
    effects,
  });

interface WorldOpts {
  readonly hd?: string;
  readonly asi?: readonly number[];
  readonly quarantined?: boolean;
  /** Whether the PDF table prints the quarantined feature's row (the C4 gate for quarantined grants). */
  readonly quarantinedInPdf?: boolean;
}

function world(o: WorldOpts = {}) {
  const sw = featureRec('Second Wind', 'class-features', fid('fSW'), {
    uses: { max: '@scale.fighter.second-wind', recovery: [{ period: 'lr', type: 'recoverAll' }, { period: 'sr', type: 'formula', formula: '1' }] },
    activities: { a1: { type: 'heal', activation: { type: 'bonus' } } },
  });
  const ds = featureRec('Danger Sense', 'class-features', fid('fDS'), {}, [
    { _id: 'e1', name: 'Danger Sense', transfer: true, disabled: false, statuses: [], system: { changes: [{ key: 'system.abilities.dex.save.roll.mode', type: 'add', value: '1' }] } },
  ]);
  const ea = featureRec('Extra Attack', 'class-features', fid('fEA'));
  const tea = featureRec('Two Extra Attacks', 'class-features', fid('fTEA'));
  const nope = featureRec('Arcane Vigor', 'class-features', fid('fAV')); // granted, not in the PDF table: the gate drops it
  const quar = featureRec('Secret Technique', 'class-features', fid('fQ'), {}, [], { ...SRC, license: '' });
  const ic = featureRec('Improved Critical', 'subclass-features', fid('fIC'), {}, [
    { _id: 'e2', name: 'Improved Critical', transfer: true, disabled: false, statuses: [], system: { changes: [{ key: 'flags.dnd5e.weaponCriticalThreshold', type: 'downgrade', value: '19' }] } },
  ]);
  const grants = [
    { type: 'ItemGrant', level: 1, configuration: { items: [uuid('classes24', sw.id), ...(o.quarantined ? [uuid('classes24', quar.id)] : [])] } },
    { type: 'ItemGrant', level: 2, configuration: { items: [uuid('classes24', ds.id), uuid('classes24', nope.id)] } },
    { type: 'ItemGrant', level: 5, configuration: { items: [uuid('classes24', ea.id)] } },
    { type: 'ItemGrant', level: 11, configuration: { items: [uuid('classes24', tea.id)] } },
  ];
  const cls = rec('packs/_source/classes24/fighter/fighter.yml', {
    _id: fid('cFighter'),
    name: 'Fighter',
    type: 'class',
    system: {
      identifier: 'fighter',
      source: SRC,
      hd: { denomination: o.hd ?? 'd10' },
      spellcasting: { progression: 'none', ability: '' },
      advancement: [
        { type: 'HitPoints' },
        ...grants,
        { type: 'Subclass', level: 3 },
        ...(o.asi ?? [4, 19]).map((level) => ({ type: 'AbilityScoreImprovement', level, configuration: { points: 2 } })),
        trait(1, ['saves:con', 'saves:str']),
        trait(1, [], [{ count: 2, pool: ['skills:ath', 'skills:acr', 'skills:prc'] }]),
        trait(1, ['weapon:sim', 'weapon:mar', 'armor:hvy', 'armor:lgt', 'armor:shl']),
        trait(1, ['weapon:mar'], [], { classRestriction: 'secondary' }),
        { type: 'Trait', level: 1, configuration: { mode: 'mastery', grants: [], choices: [{ count: 3, pool: ['weapon:*'] }] } },
        { type: 'Trait', level: 2, configuration: { mode: 'expertise', grants: [], choices: [{ count: 1, pool: ['skills:*'] }] } },
        { type: 'ScaleValue', title: 'Second Wind', configuration: { identifier: '', type: 'number', scale: { 1: { value: 2 }, 4: { value: 3 }, 10: { value: 9 } } } },
      ],
    },
  });
  const sub = rec('packs/_source/classes24/fighter/champion.yml', {
    _id: fid('sChampion'),
    name: 'Champion',
    type: 'subclass',
    system: { identifier: 'champion', classIdentifier: 'fighter', source: SRC, advancement: [{ type: 'ItemGrant', level: 3, configuration: { items: [uuid('classes24', ic.id)] } }] },
  });
  const fpdf = fighterPdf();
  const pdf = pdfIndex({ fighter: o.quarantinedInPdf ? { ...fpdf, features: [...fpdf.features, { level: 1, name: 'Secret Technique', page: 47, described: true }] } : fpdf });
  const records = [cls, sub, sw, ds, ea, tea, nope, quar, ic];
  return { records, pdf, gate: indexFromJson(JSON.parse(JSON.stringify(pdf))), quar };
}

function run(w: ReturnType<typeof world>, overrides: Parameters<typeof buildImport>[0]['overrides'] = []) {
  return buildImport({ records: w.records, index: w.gate, pdfIndex: w.pdf, overrides, pins: pins(), srdIndexSha256: 'c'.repeat(64), mappers: MAPPERS });
}
const doc = (out: ReturnType<typeof run>, rel: string) => {
  const t = out.plan.get(`packs/srd-5.2.1/${rel}`);
  if (t === undefined) throw new Error(`no ${rel} in ${[...out.plan.keys()].join(', ')}`);
  return parse(t) as Record<string, unknown>;
};
const engineLoad = (out: ReturnType<typeof run>) => loadContent([MANIFEST, ...[...out.plan].map(([path, text]) => ({ path, text }))]);

describe('class mapper', () => {
  it('maps hit die, saves, proficiencies, skills, ASI, scale, pools, extra attacks, features and choices', () => {
    const out = run(world());
    const c = doc(out, 'classes/fighter.yaml');
    expect(c.id).toBe('srd:fighter');
    expect(c.source).toBe('SRD 5.2.1 p.46');
    expect(c.hitDie).toBe(10);
    expect(c.saves).toEqual(['str', 'con']);
    expect(c.proficiencies).toEqual({ armor: ['light', 'heavy', 'shield'], weapons: ['simple', 'martial'], tools: [] }); // the secondary (multiclass) trait is skipped
    expect(c.skills).toEqual({ choose: 2, from: ['acrobatics', 'athletics', 'perception'] });
    expect(c.subclassLevel).toBe(3);
    expect(c.asiLevels).toEqual([4]); // 19 is the PDF's Epic Boon
    // The PDF prints Second Wind: its values win (Foundry's 9 at level 10 is wrong here), id as Foundry keys it.
    expect(c.scale).toEqual({ 'second-wind': { type: 'number', at: { 1: 2, 4: 3, 10: 4 } } });
    expect(c.pools).toEqual([{ id: 'second-wind', name: 'Second Wind', max: '@scale.fighter.second-wind', recharge: [{ period: 'long', amount: 'all' }, { period: 'short', amount: 1 }] }]);
    expect(c.extraAttacks).toEqual({ 5: 1, 11: 2 });
    expect(c.features).toEqual({
      1: ['srd:fighter/second-wind'],
      2: ['srd:fighter/danger-sense'], // Arcane Vigor is granted but not a PDF row: gone (C4)
      5: ['srd:fighter/extra-attack'],
      11: ['srd:fighter/two-extra-attacks'],
      19: ['srd:fighter/epic-boon'], // a PDF row no record carries: a narrative stub (C21)
    });
    expect(c.choices).toEqual([
      { id: 'skills', level: 1, choose: 2, from: { skills: ['acrobatics', 'athletics', 'perception'] }, grants: 'proficiency' },
      { id: 'expertise-2', level: 2, choose: 1, from: { skills: expect.arrayContaining(['stealth', 'arcana']) }, grants: 'expertise' },
    ]);
    expect(c.fidelity).toBe('partial');
    expect(c.unimplemented).toEqual(['choice weapon-mastery not mapped']);
    expect(c.spellcasting).toBeUndefined();
    expect(out.plan.has('packs/srd-5.2.1/features/fighter/arcane-vigor.yaml')).toBe(false);
  });

  it('emits items the engine loads with no errors and no warnings (narrative features say so)', () => {
    const out = run(world());
    const r = engineLoad(out);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    for (const text of out.plan.values()) {
      const d = parse(text) as { unimplemented?: string[] };
      for (const l of d.unimplemented ?? []) expect(isTemplateLine(l)).toBe(true);
      expect(text).not.toMatch(/<p>|description/); // no prose
    }
  });

  it('is byte-identical across runs and record orders', () => {
    const w = world();
    const a = run(w);
    const b = run({ ...w, records: [...w.records].reverse() });
    expect([...a.plan]).toEqual([...b.plan]);
  });

  it('fails closed when Foundry and the PDF disagree on the hit die or the ASI levels', () => {
    expect(() => run(world({ hd: 'd8' }))).toThrow(/hit die d8 but the PDF says d10/);
    expect(() => run(world({ asi: [4, 8, 19] }))).toThrow(/ASI levels 4,8 but the PDF says 4/);
  });

  it('leaves out a quarantined class feature the PDF table has no row for (C4), with no id derived from it', () => {
    const out = run(world({ quarantined: true }));
    const c = doc(out, 'classes/fighter.yaml');
    expect((c.features as Record<string, string[]>)['1']).toEqual(['srd:fighter/second-wind']);
    expect(c.unimplemented ?? []).not.toContain('grants an item that was quarantined');
    expect([...out.plan.values()].join('\n')).not.toMatch(/secret-technique/i);
    expect(engineLoad(out).errors).toEqual([]);
  });

  it('lists a quarantined class feature under the id its override must give, and fails closed without one', () => {
    const w = world({ quarantined: true, quarantinedInPdf: true });
    const out = run(w);
    const c = doc(out, 'classes/fighter.yaml');
    expect((c.features as Record<string, string[]>)['1']).toEqual(['srd:fighter/second-wind', 'srd:fighter/secret-technique']);
    expect(c.unimplemented).toContain('grants an item that was quarantined');
    expect(engineLoad(out).errors.map((e) => e.message).join('\n')).toMatch(/no feature srd:fighter\/secret-technique is loaded/);
    const ov = {
      kind: 'feature' as const,
      id: 'srd:fighter/secret-technique',
      file: 'tools/import-srd/overrides/feature/fighter/secret-technique.yaml',
      sha256: 'a'.repeat(64),
      replace: true,
      foundryPath: w.quar.path,
      body: { kind: 'feature', id: 'srd:fighter/secret-technique', name: 'Secret Technique', source: 'SRD 5.2.1 p.47', fidelity: 'narrative', provenance: { pdfPage: 47 } },
    };
    const fixed = run(w, [ov]);
    expect(engineLoad(fixed).errors).toEqual([]);
    // The stand-in is written from the PDF: its source is the page, the quarantined record only what it replaces.
    const st = doc(fixed, 'features/fighter/secret-technique.yaml');
    expect(st.provenance).toEqual({
      source: 'srd-pdf',
      pdfPage: 47,
      importer: 1,
      review: 'hand',
      replaces: { ref: pins().foundry.commit, path: w.quar.path, foreignId: w.quar.id, recordSha256: w.quar.sha256 },
      overrides: [{ file: ov.file, sha256: ov.sha256 }],
    });
    expect(() => run(w, [{ ...ov, body: { ...ov.body, provenance: undefined } }])).toThrow(/written from the PDF; give provenance\.pdfPage/);
  });

  it('maps nothing without the parsed PDF index (fail closed: counted as unmapped)', () => {
    const w = world();
    const out = buildImport({ records: w.records, index: w.gate, overrides: [], pins: pins(), srdIndexSha256: 'c'.repeat(64), mappers: MAPPERS });
    expect(out.plan.size).toBe(0);
    expect(out.unmapped).toEqual({ class: 1, feature: 5, subclass: 1 });
  });

  it('requires every printed PDF column to be claimed by a scale column', () => {
    const p = fighterPdf();
    const withExtra: IndexClass = { ...p, table: { ...p.table, columnOrder: [...p.table.columnOrder, 'mystery'], columns: { ...p.table.columns, mystery: ramp([[1, 1]]) } } };
    const r = world().records[0]!;
    expect(() => scaleOf(r, withExtra, 'fighter')).toThrow(/column mystery is claimed by no scale column/);
    expect(scaleOf(r, p, 'fighter').disagreements).toEqual([
      { column: 'second-wind', level: 10, foundry: 9, pdf: 4 },
      { column: 'second-wind', level: 11, foundry: 9, pdf: 4 },
      ...[12, 13, 14, 15, 16, 17, 18, 19, 20].map((level) => ({ column: 'second-wind', level, foundry: 9, pdf: 4 })),
    ]);
  });
});

describe('slots and spell lists from the PDF (2.2, C2)', () => {
  const base = fighterPdf();
  it('reads slot columns into pc-style slot rows at the levels they change', () => {
    const full: IndexClass = {
      ...base,
      table: { ...base.table, columns: { 'slot-1': ramp([[1, 2], [2, 3], [3, 4]]), 'slot-2': ramp([[3, 2], [4, 3]]), 'slot-3': ramp([]) } },
    };
    expect(slotsOf(full, 'x')).toEqual({ type: 'slots', at: { 1: [2], 2: [3], 3: [4, 2], 4: [4, 3] } });
  });
  it('reads Pact Magic as its count at its slot level', () => {
    const pact: IndexClass = { ...base, table: { ...base.table, columns: { 'spell-slots': ramp([[1, 1], [2, 2]]), 'slot-level': ramp([[1, 1], [3, 2]]) } } };
    expect(slotsOf(pact, 'x')).toEqual({ type: 'slots', at: { 1: [1], 2: [2], 3: [0, 2] } });
  });
  it('builds a class list from the spell headers, by level then name', () => {
    const pdf = pdfIndex({});
    expect(spellListFromIndex(pdf, 'wizard')).toEqual([
      { level: 0, name: 'Fire Bolt' },
      { level: 1, name: 'Magic Missile' },
    ]);
    expect(spellListFromIndex(pdf, 'druid')).toEqual([]);
  });
});

describe('subclass and feature mappers', () => {
  it('names a subclass by its kebab-case name and nests its features under it', () => {
    const out = run(world());
    const s = doc(out, 'subclasses/champion.yaml');
    expect(s).toMatchObject({ kind: 'subclass', id: 'srd:champion', parent: 'srd:fighter', source: 'SRD 5.2.1 p.48', features: { 3: ['srd:champion/improved-critical'] }, fidelity: 'full' });
    // critMin is a STAT since M3 step 4, mapped under its PDF reading (pdf-gates.ts); with no
    // override in this synthetic world it stays partial behind the review line (C7).
    expect(doc(out, 'features/champion/improved-critical.yaml')).toMatchObject({
      fidelity: 'partial',
      effects: [{ stats: [{ critMin: 19 }] }],
      unimplemented: ['not a bucket-A shape (needs a reviewed override to be full)'],
    });
  });

  it('marks a subclass whose PDF section has a "<Subclass> Spells" row as granting spells (F3)', () => {
    const w = world();
    const champion = w.pdf.subclasses.champion!;
    const pdf = { ...w.pdf, subclasses: { champion: { ...champion, features: [...champion.features, { level: 3, name: 'Champion Spells', page: 48 }] } } };
    const out = run({ ...w, pdf, gate: indexFromJson(JSON.parse(JSON.stringify(pdf))) });
    const s = doc(out, 'subclasses/champion.yaml');
    expect(s.unimplemented).toContain('grants spells (spells are imported at step 6)');
    expect(s.fidelity).toBe('partial');
  });

  it('maps an always-on advantage as a passive effect (partial: nothing auto-promotes, C7)', () => {
    const out = run(world());
    expect(doc(out, 'features/fighter/danger-sense.yaml')).toMatchObject({
      effects: [{ id: 'danger-sense', name: 'Danger Sense', mods: [{ on: ['d20.save.dex'], op: 'adv' }] }],
      passive: { effects: ['danger-sense'] },
      fidelity: 'partial',
      source: 'SRD 5.2.1 p.47',
    });
  });

  it('leaves activities as lines (no self-only target yet), and levels 11-20 as narrative stubs', () => {
    const out = run(world());
    expect(doc(out, 'features/fighter/second-wind.yaml')).toMatchObject({ fidelity: 'narrative', unimplemented: ['activity type heal'] });
    expect(doc(out, 'features/fighter/two-extra-attacks.yaml')).toMatchObject({ fidelity: 'narrative', unimplemented: ['levels 11-20 not mapped'], source: 'SRD 5.2.1 p.48' });
    expect(doc(out, 'features/fighter/epic-boon.yaml')).toMatchObject({ fidelity: 'narrative', unimplemented: ['levels 11-20 not mapped'], name: 'Epic Boon' });
  });

  it('maps effects whole or not at all', () => {
    const e = (changes: unknown[], extra: Record<string, unknown> = {}) => ({ effects: [{ name: 'X', transfer: true, disabled: false, statuses: [], system: { changes }, ...extra }] });
    expect(mapEffects(e([{ key: 'system.traits.dr.value', type: 'add', value: 'fire' }]), 'x')).toMatchObject({ resist: ['fire'], lines: [] });
    expect(mapEffects(e([{ key: 'system.attributes.hp.bonuses.overall', type: 'add', value: '@classes.sorcerer.levels' }]), 'sorcerer')).toMatchObject({ hpPerLevel: 1, lines: [] });
    expect(mapEffects(e([{ key: 'system.attributes.ac.calc', type: 'override', value: 'unarmoredMonk' }]), 'monk')).toMatchObject({ effects: [], lines: [] }); // the class's acFormulas carry it
    // One unmapped change sinks the effect: every change gets a line, nothing is applied.
    const mixed = mapEffects(e([{ key: 'system.traits.dr.value', type: 'add', value: 'fire' }, { key: 'system.bonuses.mwak.damage', type: 'add', value: '2' }]), 'x');
    expect(mixed.resist).toEqual([]);
    expect(mixed.lines).toEqual(['effect key system.traits.dr.value (add)', 'effect key system.bonuses.mwak.damage (add)']);
    // Disabled (applied by an activity) or with a status: not always on.
    expect(mapEffects(e([{ key: 'system.traits.dr.value', type: 'add', value: 'fire' }], { disabled: true }), 'x')).toMatchObject({ resist: [], lines: ['effect key system.traits.dr.value (add)'] });
    expect(mapEffects(e([], { statuses: ['stunned'] }), 'x').lines).toEqual(['effect status stunned']);
    expect(mapEffects(e([]), 'x').lines).toEqual(['effect with no changes (rules in prose only)']);
  });
});

// ---- the real records (skipped unless the import cache holds the pinned tree) ----------

const tree = (() => {
  try {
    const p = cachePaths().foundryTree;
    return existsSync(join(p, 'packs/_source/classes24')) ? p : undefined;
  } catch {
    return undefined;
  }
})();

describe.skipIf(!tree)('the pinned Foundry classes against the committed PDF index', () => {
  const pdf = JSON.parse(readFileSync(join(IMPORT_DIR, 'srd-index.json'), 'utf8')) as SrdIndex;
  const records = tree ? readFoundry(tree) : [];

  it('maps all 12 classes and 12 subclasses, and the only scale disagreement is the Monk focus dash at level 1', () => {
    const { kept } = filterRecords(records, indexFromJson(pdf));
    const classes = kept.filter((k) => k.kind === 'class');
    const subclasses = kept.filter((k) => k.kind === 'subclass');
    expect(classes).toHaveLength(12);
    expect(subclasses).toHaveLength(12);
    const dis = classes.flatMap((k) => {
      const cls = (k.rec.doc as { system: { identifier: string } }).system.identifier;
      return scaleOf(k.rec, pdf.classes[cls as keyof SrdIndex['classes']], cls).disagreements.map((d) => ({ cls, ...d }));
    });
    expect(dis).toEqual([{ cls: 'monk', column: 'focus', level: 1, foundry: 1, pdf: undefined }]);
  });

  it('gives the Monk and the Wizard the numbers their PDF tables print', () => {
    const out = buildImport({ records, index: indexFromJson(pdf), pdfIndex: pdf, overrides: [], pins: pins(), srdIndexSha256: 'c'.repeat(64), mappers: { ...MAPPERS } });
    const monk = doc(out, 'classes/monk.yaml');
    expect(monk).toMatchObject({ hitDie: 8, saves: ['str', 'dex'], subclassLevel: 3, asiLevels: [4, 8, 12, 16], extraAttacks: { 5: 1 } });
    expect((monk.scale as Record<string, unknown>).die).toEqual({ type: 'dice', at: { 1: '1d6', 5: '1d8', 11: '1d10', 17: '1d12' } });
    expect(monk.acFormulas).toEqual([{ when: ['unarmored', 'noShield'], ac: '10 + @mod.dex + @mod.wis' }]);
    expect((monk.features as Record<string, string[]>)['10']).toEqual(['srd:monk/heightened-focus', 'srd:monk/self-restoration']);
    const wiz = doc(out, 'classes/wizard.yaml');
    expect(wiz.spellcasting).toEqual({ progression: 'full', ability: 'int', list: 'srd:list/wizard', cantrips: '@scale.wizard.cantrips-known', prepared: '@scale.wizard.max-prepared' });
    const slots = (wiz.scale as Record<string, { at: Record<string, number[]> }>).slots!.at;
    expect(slots['1']).toEqual([2]);
    expect(slots['5']).toEqual([4, 3, 2]);
    expect(slots['20']).toEqual([4, 3, 3, 3, 3, 2, 2, 1, 1]);
    const lock = doc(out, 'classes/warlock.yaml');
    expect((lock.scale as Record<string, { at: Record<string, number[]> }>).slots!.at['5']).toEqual([0, 0, 2]);
    expect(spellListFromIndex(pdf, 'wizard')).toHaveLength(218);
  });
});
