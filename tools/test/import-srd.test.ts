// The SRD importer framework (docs/design/m3.md 4.1-4.8, C4, C5, C16, C21): filter, strip,
// formula, effect keys, the closed line templates, classify, overrides, emit determinism and
// verify, all on tiny synthetic records. No cache, no network, nothing under the home dir.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { checkText } from '../check-private.ts';
import { classify } from '../import-srd/classify.ts';
import { classifyChange } from '../import-srd/effect-keys.ts';
import { assertClean, diffEmit, existingGenerated, itemPath, renderItem, writeEmit } from '../import-srd/emit.ts';
import { dropCounts, DROP_REASONS, filterRecords, indexFromJson, indexFromTuples, kindOf, licenseDrop, normName } from '../import-srd/filter.ts';
import { convertFormula } from '../import-srd/formula.ts';
import { IMPORT_JSON_REL } from '../import-srd/import-json.ts';
import { buildImport } from '../import-srd/main.ts';
import type { MapOutput, MapperRegistry } from '../import-srd/map/index.ts';
import { MAPPERS } from '../import-srd/map/index.ts';
import { applyOverride, loadOverrides, mergePatch, parseOverride } from '../import-srd/overrides.ts';
import { leftovers, strip } from '../import-srd/strip.ts';
import { isTemplateLine, normalizeLines, triggerWordsIn, U } from '../import-srd/unimplemented.ts';
import { GENERATED_HEADER, sha256 } from '../import-srd/util.ts';
import { verifyRepo } from '../import-srd/verify.ts';
import { COMMIT, feature, fid, grant, klass, rec, SRC, testPins, weapon } from './import-srd-helpers.ts';

const temps: string[] = [];
const tempRoot = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'montecrit-import-test-'));
  temps.push(d);
  return d;
};
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

// A small world: a class with two features (one only by a premium pointer), a subclass, a
// weapon, a feature the PDF doesn't have, and one with an empty license.
function world() {
  const sw = feature('Second Wind', 'fighter', fid('phbftrSecondWind'), { uses: { max: '@scale.fighter.second-wind' } });
  const surge = feature('Action Surge', 'fighter', fid('phbftrActionSurg'));
  const vigor = feature('Arcane Vigor', 'fighter', fid('phbftrArcaneVig'));
  const empty = feature('Unarmed Thing', 'fighter', fid('phbftrUnarmedTh'), {}, { ...SRC, license: '' });
  const cls = klass('Fighter', 'fighter', [grant(1, [sw.id, empty.id]), grant(2, [surge.id, vigor.id])]);
  const sub = rec('packs/_source/classes24/fighter/champion.yml', {
    name: 'Champion',
    type: 'subclass',
    system: { identifier: 'champion', classIdentifier: 'fighter', source: SRC, advancement: [] },
  });
  const sword = weapon('Longsword');
  const fake = weapon('Sword of Nowhere');
  const index = indexFromTuples({
    class: [['Fighter']],
    subclass: [['Fighter', 'Champion']],
    feature: [
      ['Fighter', 1, 'Second Wind'],
      ['Fighter', 2, 'Action Surge'],
      ['Fighter', 1, 'Unarmed Thing'],
    ],
    weapon: [['Longsword']],
  });
  return { records: [cls, sw, surge, vigor, empty, sub, sword, fake], index, cls, sw, surge, vigor, empty, sub, sword, fake };
}

describe('filter (license, book, rules, tuple gate)', () => {
  it('passes only CC-BY-4.0, empty book, 2024 rules', () => {
    const base = { name: 'Dagger', type: 'weapon', system: { type: { value: 'simpleM' } } };
    const at = (source: unknown) => licenseDrop(rec('packs/_source/equipment24/weapons/dagger.yml', { ...base, system: { ...base.system, source } }));
    expect(at(SRC)).toBeUndefined();
    expect(at({ ...SRC, license: '' })).toBe('license-empty');
    expect(at({ rules: '2024' })).toBe('license-missing');
    expect(at({ ...SRC, license: 'CC-BY-NC-4.0' })).toBe('license-other');
    expect(at({ ...SRC, book: 'MM 2024' })).toBe('book-set');
    expect(at({ ...SRC, rules: '2014' })).toBe('rules-not-2024');
    expect(licenseDrop(rec('packs/_source/equipment24/weapons/x.yml', { name: 'X', type: 'weapon', system: {} }))).toBe('license-missing');
  });

  it('kinds come from Foundry type and subtype', () => {
    const w = world();
    expect(kindOf(w.cls)).toBe('class');
    expect(kindOf(w.sub)).toBe('subclass');
    expect(kindOf(w.sw)).toBe('feature');
    expect(kindOf(w.sword)).toBe('weapon');
    expect(kindOf(rec('packs/_source/equipment24/armor/shield.yml', { name: 'Shield', type: 'equipment', system: { type: { value: 'shield' }, source: SRC } }))).toBe('armor');
    expect(kindOf(rec('packs/_source/equipment24/gear/rope.yml', { name: 'Rope', type: 'loot', system: { source: SRC } }))).toBe('other');
    expect(kindOf(rec('packs/_source/feats24/general/asi.yml', { name: 'Ability Score Improvement', type: 'feat', system: { type: { value: '' }, source: SRC } }))).toBe('feat');
    expect(kindOf(rec('packs/_source/origins24/species/traits/x/dark.yml', { name: 'Darkvision', type: 'feat', system: { type: { value: 'race' }, source: SRC } }))).toBe('speciesTrait');
  });

  it('gates features by (owner, level, name), never by bare name (C4)', () => {
    const w = world();
    const r = filterRecords(w.records, w.index);
    const kept = r.kept.map((k) => k.rec.name).sort();
    expect(kept).toEqual(['Action Surge', 'Champion', 'Fighter', 'Longsword', 'Second Wind']);
    const why = Object.fromEntries(r.drops.map((d) => [d.name, d.reason]));
    expect(why['Arcane Vigor']).toBe('not-in-srd-pdf');
    expect(why['Sword of Nowhere']).toBe('not-in-srd-pdf');
    expect(why['Unarmed Thing']).toBe('license-empty'); // quarantined even though its tuple exists (C21)
    // The same name at the wrong level fails.
    const lvl = filterRecords(w.records, indexFromTuples({ class: [['Fighter']], feature: [['Fighter', 3, 'Second Wind']] }));
    expect(lvl.drops.find((d) => d.name === 'Second Wind')!.reason).toBe('not-in-srd-pdf');
  });

  it('a feature whose class is dropped has no owner', () => {
    const w = world();
    const r = filterRecords(w.records, indexFromTuples({ feature: [['Fighter', 1, 'Second Wind']] }));
    expect(r.drops.find((d) => d.name === 'Second Wind')!.reason).toBe('no-owner');
    expect(r.drops.find((d) => d.name === 'Fighter')!.reason).toBe('not-in-srd-pdf');
  });

  it('reads advancement stored as a map as well as a list, and premium pointers grant nothing', () => {
    const f = feature('Second Wind', 'ranger', fid('phbrgrSecondWin'));
    const g = feature('Favored Thing', 'ranger', fid('phbrgrFavoredTh'));
    const cls = klass('Ranger', 'ranger', {
      b: grant(1, [f.id]),
      a: { type: 'ItemGrant', level: 1, configuration: { items: [{ uuid: `Compendium.dnd-players-handbook.classes.Item.${g.id}` }] } },
    } as unknown as unknown[]);
    const r = filterRecords([cls, f, g], indexFromTuples({ class: [['Ranger']], feature: [['Ranger', 1, 'Second Wind'], ['Ranger', 1, 'Favored Thing']] }));
    expect(r.kept.map((k) => k.rec.name).sort()).toEqual(['Ranger', 'Second Wind']);
    expect(r.drops.find((d) => d.name === 'Favored Thing')!.reason).toBe('no-owner');
  });

  it('out-of-scope kinds drop after the license test, and counts carry every reason', () => {
    const spell = rec('packs/_source/spells24/1/x.yml', { name: 'Fireball', type: 'spell', system: { source: SRC } });
    const bad = rec('packs/_source/spells24/1/y.yml', { name: 'Ice Thing', type: 'spell', system: {} });
    const r = filterRecords([spell, bad], indexFromTuples({ spell: [['Fireball']] }));
    expect(r.drops.map((d) => d.reason).sort()).toEqual(['kind-out-of-scope', 'license-missing']);
    const c = dropCounts(r.drops);
    expect(Object.keys(c)).toEqual([...DROP_REASONS]);
    expect(c['kind-out-of-scope']).toBe(1);
  });

  it('names compare after typography only', () => {
    expect(normName('Nature’s  Veil')).toBe(normName("nature's veil"));
    expect(normName('Half–Plate')).toBe('half-plate');
    expect(normName('Second Wind')).not.toBe(normName('Second Winds'));
  });

  it('reads the srd-index.json shape pdf-index.ts writes', () => {
    const idx = indexFromJson({
      classes: { fighter: { name: 'Fighter', features: [{ level: 1, name: 'Second Wind', page: 47 }] } },
      subclasses: { champion: { class: 'fighter', name: 'Champion', page: 49, features: [{ level: 3, name: 'Improved Critical', page: 49 }] } },
      species: [{ name: 'Dwarf', page: 84 }],
      backgrounds: [{ name: 'Soldier', page: 83 }],
      feats: [{ name: 'Alert', page: 87, category: 'origin' }],
      spells: [{ name: 'Fireball', page: 130 }],
      weapons: [{ name: 'Longsword', page: 91 }],
      armor: [{ name: 'Shield', page: 92 }],
    });
    expect(idx.has('class', ['Fighter'])).toBe(true);
    expect(idx.has('feature', ['Fighter', 1, 'Second Wind'])).toBe(true);
    expect(idx.has('feature', ['Champion', 3, 'Improved Critical'])).toBe(true);
    expect(idx.has('subclass', ['Fighter', 'Champion'])).toBe(true);
    expect(idx.has('species', ['Dwarf'])).toBe(true);
    expect(idx.has('weapon', ['Longsword'])).toBe(true);
    expect(idx.has('speciesTrait', ['Dwarf', 'Darkvision'])).toBe(false); // nothing listed: fail closed
    expect(idx.has('monster', ['Goblin Warrior'])).toBe(false);
    expect(() => indexFromJson({ names: {} })).toThrow(/classes/);
  });
});

describe('strip', () => {
  it('removes art, prose and bookkeeping at every depth and keeps mechanics', () => {
    const doc = {
      name: 'Bless',
      img: 'icons/a.webp',
      _stats: { coreVersion: '13' },
      _key: '!items!x',
      folder: 'abc',
      ownership: { default: 0 },
      flags: { dnd5e: {} },
      sort: 100,
      prototypeToken: { texture: { src: 'modules/x/token.webp' } },
      system: { description: { value: '<p>rules text</p>', chat: '' }, activities: { a: { type: 'save', description: { chatFlavor: 'x' }, save: { ability: ['wis'] } } } },
      effects: [{ name: 'Blessed', img: 'icons/b.svg', tint: '#fff', changes: [{ key: 'system.bonuses.abilities.save', value: '1d4' }] }],
    };
    const before = JSON.stringify(doc);
    const s = strip(doc) as Record<string, unknown>;
    expect(JSON.stringify(doc)).toBe(before);
    const text = JSON.stringify(s);
    for (const k of ['"img"', '"_stats"', '"_key"', '"folder"', '"ownership"', '"flags"', '"prototypeToken"', '"tint"', '"description"', '"chatFlavor"', '"sort"', 'webp', 'rules text']) {
      expect(text).not.toContain(k);
    }
    expect(text).toContain('system.bonuses.abilities.save');
    expect(text).toContain('"wis"');
    expect(leftovers(s)).toEqual([]);
    expect(leftovers({ a: { b: '<p>x</p>' }, c: ['@UUID[Compendium.x]'] })).toEqual(['a.b', 'c[0]']);
  });
});

describe('formula (4.4, C16)', () => {
  const ok = (f: string | number, ctx = {}) => {
    const r = convertFormula(f, ctx);
    if (!r.ok) throw new Error(r.lines.join('; '));
    return r.expr;
  };
  const lines = (f: string, ctx = {}) => {
    const r = convertFormula(f, ctx);
    return r.ok ? [] : r.lines;
  };
  it('maps the five path forms and min/max', () => {
    expect(ok('2d4 + @mod')).toBe('2d4 + @mod');
    expect(ok('2 + @item.level')).toBe('2 + @slot');
    expect(ok('1d10 + @classes.fighter.levels', { ownerClass: 'fighter' })).toBe('1d10 + @classLevel');
    expect(ok('(@prof)d4')).toBe('(@pb)d4');
    expect(ok('max(1, @mod)')).toBe('max(1, @mod)');
    expect(ok('min(@prof, 3)')).toBe('min(@pb, 3)');
    expect(ok(3)).toBe('3');
    expect(ok('max(1, @abilities.wis.mod)')).toBe('max(1, @mod.wis)');
  });
  it('keeps @scale qualified (C16)', () => {
    expect(ok('@scale.rogue.sneak-attack')).toBe('@scale.rogue.sneak-attack');
    expect(ok('@scale.monk.die + @mod')).toBe('@scale.monk.die + @mod');
  });
  it('anything else is a templated line, and the formula is not emitted', () => {
    expect(lines('@abilities.wis.value')).toEqual(['formula path @abilities.wis.value']);
    expect(lines('floor(@prof / 2)')).toEqual(['formula function floor']);
    expect(lines('@scale.rogue.sneak-attack.number')).toEqual(['formula path @scale.rogue.sneak-attack.number']);
    expect(lines('1d10 + @classes.wizard.levels', { ownerClass: 'fighter' })).toEqual(['formula path @classes.wizard.levels']);
    expect(lines('2d6 +')).toEqual(['formula syntax not supported']);
    const premium = lines('@flags.dnd-players-handbook.mirrorImages');
    expect(premium.join()).not.toMatch(/handbook/);
    for (const l of [...premium, ...lines('floor(@prof)'), ...lines('@attributes.spell.dc')]) expect(isTemplateLine(l)).toBe(true);
  });
});

describe('effect keys (4.5)', () => {
  it('maps the seeded rows, ignores cosmetics, drops the premium-named key', () => {
    expect(classifyChange('system.attributes.ac.bonus', 'add')).toEqual({ status: 'mapped', target: { to: 'stat.ac' } });
    expect(classifyChange('system.bonuses.rsak.attack', 'add')).toEqual({ status: 'mapped', target: { to: 'd20.attack', range: 'ranged', attack: 'spell' } });
    expect(classifyChange('system.scale.druid.cantrips-known.value', 'add')).toEqual({ status: 'mapped', target: { to: 'scaleDelta', owner: 'druid', column: 'cantrips-known' } });
    expect(classifyChange('system.traits.armorProf.value', 'add')).toEqual({ status: 'mapped', target: { to: 'proficiency', what: 'armor' } });
    expect(classifyChange('name', 'override')).toEqual({ status: 'ignored' });
    const d = classifyChange('flags.dnd-players-handbook.mirrorImages', 'add');
    expect(d.status).toBe('dropped');
    expect(JSON.stringify(d)).not.toMatch(/handbook/);
    const u = classifyChange('system.attributes.senses.darkvision', 'upgrade');
    expect(u).toEqual({ status: 'unknown', line: 'effect key system.attributes.senses.darkvision (upgrade)' });
    expect(classifyChange('system.attributes.ac.bonus', 'multiply').status).toBe('unknown'); // mode matters
  });
});

describe('unimplemented lines are a closed set (C5)', () => {
  it('templates take machine tokens only', () => {
    expect(U.trigger('enters')).toBe('trigger: "enters" (zone lifecycle)');
    expect(() => U.trigger('when a creature you can see')).toThrow(/not a trigger word/);
    expect(() => U.formulaPath('@a b <p>')).toThrow(/token/);
    expect(() => U.effectKey('flags.dnd-monster-manual.x', 'add')).toThrow(/premium/);
    expect(isTemplateLine('Dim Light in the Cylinder')).toBe(false);
    expect(() => normalizeLines(['free text from a description'])).toThrow(/no template/);
    expect(normalizeLines([U.formulaSyntax(), U.effectNoChanges(), U.formulaSyntax()])).toEqual(['effect with no changes (rules in prose only)', 'formula syntax not supported']);
  });
  it('the trigger scan reports phrases, never the text around them', () => {
    expect(triggerWordsIn('<p>When a creature <em>enters</em> the area or ends its turn there, once per   turn...</p>')).toEqual(['ends its turn', 'enters', 'once per turn']);
    expect(triggerWordsIn('<p>nothing to see</p>')).toEqual([]);
  });
});

describe('classify (2.7, C7)', () => {
  const base = { maps: true, shape: 'bucketA' as const, unimplemented: [], hasDuration: false };
  it('narrative, partial, full', () => {
    expect(classify({ ...base, maps: false }).fidelity).toBe('narrative');
    expect(classify({ ...base, unimplemented: [U.formulaSyntax()] }).fidelity).toBe('partial');
    expect(classify(base)).toEqual({ fidelity: 'full', unimplemented: [] });
    expect(classify({ ...base, shape: 'data' }).fidelity).toBe('full');
  });
  it('nothing with a duration, a reaction or a non-bucket-A shape is promoted by the importer alone', () => {
    const d = classify({ ...base, hasDuration: true });
    expect(d.fidelity).toBe('partial');
    expect(d.unimplemented).toEqual(['has a duration (needs a reviewed override to be full)']);
    expect(classify({ ...base, activation: 'reaction' }).fidelity).toBe('partial');
    expect(classify({ ...base, shape: 'other' }).fidelity).toBe('partial');
    expect(classify({ ...base, open5e: 'disagree' }).fidelity).toBe('partial');
    expect(classify({ ...base, pdfHeaderAgrees: false }).fidelity).toBe('partial');
    for (const l of classify({ ...base, hasDuration: true, activation: 'special', open5e: 'disagree', shape: 'other', pdfHeaderAgrees: false }).unimplemented) {
      expect(isTemplateLine(l)).toBe(true);
    }
  });
});

describe('overrides (4.6)', () => {
  const item = () => ({
    kind: 'weapon',
    id: 'srd:longsword',
    name: 'Longsword',
    fidelity: 'partial',
    unimplemented: ['formula syntax not supported'],
    properties: ['versatile'],
    damage: { roll: '1d8', type: 'slashing' },
    provenance: { source: 'foundry-dnd5e', ref: COMMIT, path: 'packs/_source/x.yml', foreignId: 'x', recordSha256: 'a'.repeat(64), importer: 1, review: 'auto' },
  });
  const ctx = { commit: COMMIT, importer: 1, recordAt: () => ({ path: 'packs/_source/classes24/monk/u.yml', foreignId: 'phbmnkUnarmed000', sha256: 'b'.repeat(64) }) };

  it('merge patch: objects merge, arrays replace, null deletes; the file and its sha256 are recorded', () => {
    expect(mergePatch({ a: { b: 1, c: 2 }, d: [1] }, { a: { c: null, e: 3 }, d: [2] })).toEqual({ a: { b: 1, e: 3 }, d: [2] });
    const text = 'damage: { type: piercing }\nunimplemented: null\n';
    const ov = parseOverride('weapon/longsword.yaml', text, 'tools/import-srd/overrides/weapon/longsword.yaml');
    expect(ov.id).toBe('srd:longsword');
    const out = applyOverride(item(), ov, ctx);
    expect(out.damage).toEqual({ roll: '1d8', type: 'piercing' });
    expect(out.unimplemented).toBeUndefined();
    expect((out.provenance as Record<string, unknown>).overrides).toEqual([{ file: 'tools/import-srd/overrides/weapon/longsword.yaml', sha256: sha256(text) }]);
  });

  it('raising fidelity needs review: reviewed and a pdfPage', () => {
    const up = parseOverride('weapon/longsword.yaml', 'fidelity: full\n', 'f');
    expect(() => applyOverride(item(), up, ctx)).toThrow(/reviewed and a pdfPage/);
    const ok = parseOverride('weapon/longsword.yaml', 'fidelity: full\nunimplemented: null\nprovenance: { review: reviewed, pdfPage: 91 }\n', 'f');
    expect(applyOverride(item(), ok, ctx).fidelity).toBe('full');
    // M3 step 4: full means zero lines, so a raise that leaves a line is refused.
    const stillLines = parseOverride('weapon/longsword.yaml', 'fidelity: full\nprovenance: { review: reviewed, pdfPage: 91 }\n', 'f');
    expect(() => applyOverride(item(), stillLines, ctx)).toThrow(/is full but still lists 1 unimplemented line/);
    expect(() => parseOverride('weapon/longsword.yaml', 'provenance: { recordSha256: x }\n', 'f')).toThrow(/only provenance.review/);
    expect(() => parseOverride('weapon/longsword.yaml', 'id: srd:dagger\n', 'f')).toThrow(/does not match/);
    expect(() => parseOverride('nope/longsword.yaml', 'a: 1\n', 'f')).toThrow(/unknown kind/);
  });

  it('replace: true stands instead; a quarantined record is named with foundryPath (C21)', () => {
    const body = 'replace: true\nfoundryPath: packs/_source/classes24/monk/u.yml\nkind: feature\nid: srd:monk/unarmed-strike\nname: Unarmed Strike\nsource: SRD 5.2.1 p.50\nfidelity: partial\nprovenance: { review: reviewed, pdfPage: 50 }\n';
    const ov = parseOverride('feature/monk/unarmed-strike.yaml', body, 'tools/import-srd/overrides/feature/monk/unarmed-strike.yaml');
    const out = applyOverride(undefined, ov, ctx);
    expect(out).not.toHaveProperty('replace');
    expect(out).not.toHaveProperty('foundryPath');
    // Written from the PDF: source srd-pdf; the quarantined record is only what it replaces (LL-2).
    expect(out.provenance).toMatchObject({ source: 'srd-pdf', replaces: { path: 'packs/_source/classes24/monk/u.yml' }, review: 'reviewed', pdfPage: 50 });
    expect(out.provenance).not.toHaveProperty('path');
    const noPath = parseOverride('feature/monk/x.yaml', 'replace: true\nkind: feature\nid: srd:monk/x\n', 'f');
    expect(() => applyOverride(undefined, noPath, ctx)).toThrow(/foundryPath/);
    const patchNothing = parseOverride('feature/monk/x.yaml', 'name: X\n', 'f');
    expect(() => applyOverride(undefined, patchNothing, ctx)).toThrow(/nothing to patch/);
  });
});

// A test mapper registry: weapons become items; everything else maps nothing.
const testMappers: MapperRegistry = {
  ...MAPPERS,
  weapon: (ctx): MapOutput => ({
    kind: 'weapon',
    item: { kind: 'weapon', id: ctx.idOf(ctx.kept.rec.id)!, name: ctx.kept.rec.name, source: 'SRD 5.2.1 p.91', category: 'martial', attack: 'melee', damage: { roll: '1d8', type: 'slashing' } },
    unimplemented: ctx.doc.system && (ctx.doc.system as Record<string, unknown>).formula ? [U.formulaSyntax()] : [],
    classify: { maps: true, shape: 'data', hasDuration: false },
    pdfPage: 91,
  }),
};

describe('emit determinism', () => {
  it('renders sorted keys under the GENERATED header, independent of key order', () => {
    const a = renderItem({ name: 'B', kind: 'weapon', id: 'srd:b', z: { y: 1, x: [2, 1] } });
    const b = renderItem({ z: { x: [2, 1], y: 1 }, id: 'srd:b', kind: 'weapon', name: 'B' });
    expect(a).toBe(b);
    expect(a.startsWith(`${GENERATED_HEADER}\n`)).toBe(true);
    expect(a.endsWith('\n')).toBe(true);
    expect(a.split('\n').slice(1, 4)).toEqual(['id: srd:b', 'kind: weapon', 'name: B']);
    expect(parse(a)).toEqual({ id: 'srd:b', kind: 'weapon', name: 'B', z: { x: [2, 1], y: 1 } });
    expect(itemPath('feature', 'srd:monk/martial-arts')).toBe('packs/srd-5.2.1/features/monk/martial-arts.yaml');
  });

  it('the whole import is byte-identical across runs and record orders', () => {
    const w = world();
    const input = { records: w.records, index: w.index, overrides: [], pins: testPins(), srdIndexSha256: 'c'.repeat(64), mappers: testMappers };
    const one = buildImport(input);
    const two = buildImport({ ...input, records: [...w.records].reverse() });
    expect([...one.plan]).toEqual([...two.plan]);
    expect(one.importJson).toBe(two.importJson);
    expect([...one.plan.keys()]).toEqual(['packs/srd-5.2.1/weapons/longsword.yaml']);
    const doc = parse(one.plan.get('packs/srd-5.2.1/weapons/longsword.yaml')!) as Record<string, unknown>;
    expect(doc.fidelity).toBe('full');
    expect(doc.provenance).toEqual({ source: 'foundry-dnd5e', ref: COMMIT, path: w.sword.path, foreignId: w.sword.id, recordSha256: w.sword.sha256, importer: 1, pdfPage: 91, review: 'auto' });
    const j = JSON.parse(one.importJson);
    expect(j.counts.byKind.weapon).toEqual({ full: 1, partial: 0, narrative: 0 });
    expect(j.counts.drops['not-in-srd-pdf']).toBe(2);
    expect(one.importJson).not.toMatch(/Nowhere|Arcane Vigor/); // counts, never names (C5)
    expect(one.unmapped).toEqual({ class: 1, feature: 2, subclass: 1 });
  });

  it('refuses to emit a non-SRD name or an art pointer', () => {
    expect(() => assertClean('packs/srd-5.2.1/weapons/x.yaml', 'name: Thorn Whip\n')).toThrow(/non-SRD/);
    expect(() => assertClean('packs/srd-5.2.1/weapons/x.yaml', 'img: icons/sword.webp\n')).toThrow(/pointer/);
    expect(() => assertClean('packs/srd-5.2.1/weapons/x.yaml', 'from: Compendium.dnd5e.x\n')).toThrow(/Compendium/);
    const w = world();
    const leaky: MapperRegistry = { ...testMappers, weapon: (ctx) => ({ ...(testMappers.weapon(ctx) as MapOutput), item: { kind: 'weapon', id: 'srd:x', name: 'Star Map' } }) };
    expect(() => buildImport({ records: [w.sword], index: w.index, overrides: [], pins: testPins(), srdIndexSha256: 'c'.repeat(64), mappers: leaky })).toThrow(/non-SRD/);
  });

  it('writes, is idempotent, deletes its own stale files and never touches hand files', () => {
    const root = tempRoot();
    const hand = join(root, 'packs/srd-5.2.1/spells/moonbeam.yaml');
    mkdirSync(join(root, 'packs/srd-5.2.1/spells'), { recursive: true });
    writeFileSync(hand, 'kind: spell\nid: srd:moonbeam\n');
    const plan = new Map([
      ['packs/srd-5.2.1/weapons/a.yaml', renderItem({ kind: 'weapon', id: 'srd:a' })],
      ['packs/srd-5.2.1/features/monk/b.yaml', renderItem({ kind: 'feature', id: 'srd:monk/b' })],
    ]);
    expect(writeEmit(plan, root).added).toHaveLength(2);
    expect(diffEmit(plan, root)).toEqual({ added: [], changed: [], stale: [] });
    expect(existingGenerated(root)).toEqual(['packs/srd-5.2.1/features/monk/b.yaml', 'packs/srd-5.2.1/weapons/a.yaml']);
    const d = writeEmit(new Map([['packs/srd-5.2.1/weapons/a.yaml', plan.get('packs/srd-5.2.1/weapons/a.yaml')!]]), root);
    expect(d.stale).toEqual(['packs/srd-5.2.1/features/monk/b.yaml']);
    expect(existsSync(join(root, 'packs/srd-5.2.1/features'))).toBe(false); // emptied folders go too
    expect(readFileSync(hand, 'utf8')).toBe('kind: spell\nid: srd:moonbeam\n');
    expect(() => writeEmit(new Map([['packs/srd-5.2.1/spells/moonbeam.yaml', renderItem({ kind: 'spell', id: 'srd:moonbeam' })]]), root)).toThrow(/hand-authored/);
  });
});

describe('import:verify', () => {
  /** A temp repo with the real pins, a fixture index, one generated weapon and its override. */
  function repo(withOverride = true) {
    const root = tempRoot();
    mkdirSync(join(root, 'tools/import-srd/overrides/weapon'), { recursive: true });
    writeFileSync(join(root, 'tools/import-srd/pins.json'), readFileSync(join(import.meta.dirname, '..', 'import-srd', 'pins.json')));
    writeFileSync(join(root, 'tools/import-srd/srd-index.json'), '{"classes":{},"subclasses":{}}\n');
    const ovText = 'properties: [finesse]\n';
    if (withOverride) writeFileSync(join(root, 'tools/import-srd/overrides/weapon/longsword.yaml'), ovText);
    const w = world();
    const out = buildImport({
      records: w.records,
      index: w.index,
      overrides: loadOverrides(root),
      pins: testPins(),
      srdIndexSha256: sha256(readFileSync(join(root, 'tools/import-srd/srd-index.json'))),
      mappers: testMappers,
    });
    writeEmit(out.plan, root);
    writeFileSync(join(root, IMPORT_JSON_REL), out.importJson);
    return root;
  }

  it('passes on a consistent import and on an empty repo', () => {
    expect(verifyRepo(repo())).toEqual([]);
    const empty = tempRoot();
    mkdirSync(join(empty, 'tools/import-srd'), { recursive: true });
    writeFileSync(join(empty, 'tools/import-srd/pins.json'), readFileSync(join(import.meta.dirname, '..', 'import-srd', 'pins.json')));
    expect(verifyRepo(empty)).toEqual([]);
  });

  it('catches an edited override, an orphan override and a stale IMPORT.json', () => {
    const root = repo();
    writeFileSync(join(root, 'tools/import-srd/overrides/weapon/longsword.yaml'), 'properties: [light]\n');
    writeFileSync(join(root, 'tools/import-srd/overrides/weapon/dagger.yaml'), 'name: Dagger\n');
    const p = verifyRepo(root).join('\n');
    expect(p).toMatch(/longsword\.yaml changed since the import/);
    expect(p).toMatch(/dagger\.yaml: targets srd:dagger, which has no generated file/);
  });

  it('catches IMPORT.json drifting from the files', () => {
    const root = repo(false);
    const file = join(root, 'packs/srd-5.2.1/weapons/longsword.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('fidelity: full', 'fidelity: partial'));
    const p = verifyRepo(root).join('\n');
    expect(p).toMatch(/counts by kind and fidelity differ/);
    expect(p).toMatch(/output hash differs/);
    writeFileSync(join(root, 'tools/import-srd/srd-index.json'), '{"changed":true}\n');
    expect(verifyRepo(root).join('\n')).toMatch(/different srd-index\.json/);
    rmSync(join(root, IMPORT_JSON_REL));
    expect(verifyRepo(root).join('\n')).toMatch(/IMPORT\.json is missing/);
  });

  it('catches a free-text unimplemented line and a misplaced file', () => {
    const root = repo(false);
    const file = join(root, 'packs/srd-5.2.1/weapons/longsword.yaml');
    writeFileSync(file, `${readFileSync(file, 'utf8')}unimplemented:\n  - a sentence copied from somewhere\n`);
    writeFileSync(join(root, 'packs/srd-5.2.1/weapons/other.yaml'), renderItem({ kind: 'weapon', id: 'srd:dagger' }));
    const p = verifyRepo(root).join('\n');
    expect(p).toMatch(/matches no template/);
    expect(p).toMatch(/srd:dagger belongs at packs\/srd-5\.2\.1\/weapons\/dagger\.yaml/);
  });
});

describe('check-private: art and pointer lint under packs/ (4.7 point 5, C5)', () => {
  const whys = (file: string, text: string) => checkText(file, text).map((f) => f.why);
  it('flags art and premium pointers in packs/ only', () => {
    for (const t of ['icon: a.webp', 'icon: a.PNG', 'x.svg', 'icons/svg/a', 'systems/dnd5e/x', 'modules/x', 'tokens/x', '@UUID[x]', 'Compendium.dnd5e.x', 'dnd-players-handbook', 'dnd-monster-manual', 'dnd-dungeon-masters-guide']) {
      expect(whys('packs/srd-5.2.1/x.yaml', t).join()).toMatch(/pointer/);
      expect(whys('packages/engine/src/x.ts', t)).toEqual([]);
    }
    expect(whys('packs/srd-5.2.1/token.png', 'x').join()).toMatch(/image file/);
    expect(whys('packs/srd-5.2.1/spells/fine.yaml', 'name: Moonbeam\nrange: 120\n')).toEqual([]);
  });
});
