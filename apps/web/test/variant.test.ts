// Compare's variants (M6): a copy of a character text with one-line structured edits.
import { describe, expect, it } from 'vitest';
import { loadContent, type DerivedSheet } from '@montecrit/engine';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listCharacters } from '../src/character/validate.ts';
import { oddsCompare } from '../src/compare/odds.ts';
import { asiPick, asiText, asiValue, shiftAbilities, setCasting, setPickValue, spellList, differences, freeSlot, nameOf, readCharacter, setName, setPick, setSubclass, startText, variantFile, variantId, variantPath, withVariants, type Variant } from '../src/compare/variant.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.ya?ml$/.test(e.name) ? [join(dir, e.name)] : []));
}
const PACKS = [
  ...['packs/srd-5.2.1', 'packs/test'].flatMap((d) => walk(join(ROOT, d))).map((p) => ({ path: `repo/${relative(ROOT, p)}`, text: readFileSync(p, 'utf8') })),
  { path: 'repo/packs/test/characters/heroes/fighter-5.yaml', text: readFileSync(join(ROOT, 'apps/web/heroes/fighter-5.yaml'), 'utf8') },
];

const TEXT = `# a comment
kind: character
id: test:sample
name: "Sample"
classes: [{ class: srd:fighter, level: 5, subclass: srd:champion }]
species: srd:human
background: srd:soldier
picks:
  srd:fighter#fighting-style: [srd:defense] # why
  srd:fighter#skills: [acrobatics, animal-handling]
  srd:fighter#asi-4: { asi: { str: 2 } }
  srd:soldier#tools:
    - "Gaming Set (Dice)"
casting:
  - { source: srd:druid, cantrips: [srd:produce-flame, srd:starry-wisp], prepared: [srd:cure-wounds] } # note
  - { source: srd:other }
`;

describe('variant text', () => {
  it('starts as the base with its own id and name', () => {
    const t = startText(TEXT, 'test:sample', 'Sample', 2)!;
    expect(t).toContain('id: test:sample-variant-2\n');
    expect(nameOf(t)).toBe('Sample (variant 2)');
    expect(t.replace(/^(id|name):.*$/gm, '')).toBe(TEXT.replace(/^(id|name):.*$/gm, ''));
    expect(startText('kind: character\n', 'x:y', 'Y', 1)).toBeNull();
    expect(nameOf(setName(t, 'Sample: "Archery"')!)).toBe('Sample: "Archery"');
  });
  it('reads the class, subclass and list picks', () => {
    const r = readCharacter(TEXT)!;
    expect([r.cls, r.level, r.subclass, r.species, r.background]).toEqual(['srd:fighter', 5, 'srd:champion', 'srd:human', 'srd:soldier']);
    expect(r.picks['srd:fighter#fighting-style']).toEqual(['srd:defense']);
    expect(r.picks['srd:soldier#tools']).toEqual(['Gaming Set (Dice)']);
    expect(r.picks['srd:fighter#asi-4']).toBeUndefined();
    expect(readCharacter('kind: pc\nid: a:b\n')).toBeNull();
    expect(readCharacter('{ not yaml')).toBeNull();
  });
  it('rewrites a one-line pick, adds a missing one, and refuses one written over several lines', () => {
    const a = setPick(TEXT, 'srd:fighter#fighting-style', ['srd:archery'])!;
    expect(a).toContain('  srd:fighter#fighting-style: [srd:archery]\n');
    expect(readCharacter(a)!.picks['srd:fighter#fighting-style']).toEqual(['srd:archery']);
    // Only that line changed.
    expect(a.split('\n').filter((l, i) => l !== TEXT.split('\n')[i])).toHaveLength(1);
    const b = setPick(TEXT, 'srd:human#skillful', ['arcana'])!;
    expect(readCharacter(b)!.picks['srd:human#skillful']).toEqual(['arcana']);
    expect(setPick(TEXT, 'srd:soldier#tools', ['x'])).toBeNull();
    expect(setPick('kind: character\n', 'a#b', ['x'])).toBeNull();
    expect(readCharacter(setPick(TEXT, 'srd:fighter#skills', ['Gaming Set: Dice', 'arcana'])!)!.picks['srd:fighter#skills']).toEqual(['Gaming Set: Dice', 'arcana']);
  });
  it('sets or adds the subclass in the classes line', () => {
    expect(readCharacter(setSubclass(TEXT, 'srd:other')!)!.subclass).toBe('srd:other');
    const none = TEXT.replace(', subclass: srd:champion', '');
    expect(readCharacter(setSubclass(none, 'srd:champion')!)!.subclass).toBe('srd:champion');
    expect(setSubclass('classes:\n  - { class: a:b, level: 1 }\n', 'x:y')).toBeNull();
  });
  it('says what differs from the base', () => {
    const base = readCharacter(TEXT);
    const cur = readCharacter(setSubclass(setPick(TEXT, 'srd:fighter#fighting-style', ['srd:archery'])!, 'srd:other')!);
    const needs = [{ key: 'srd:fighter#fighting-style', where: 'Fighter level 1', kind: 'choice' as const, choose: 1, what: 'feats', options: [{ id: 'srd:defense', name: 'Defense' }, { id: 'srd:archery', name: 'Archery' }] }];
    expect(differences(base, cur, needs, (id) => id)).toEqual(['subclass: srd:champion to srd:other', 'Fighter level 1: Defense to Archery']);
    expect(differences(base, base, needs, (id) => id)).toEqual([]);
  });
  it('gives each variant a slot and a file next to its base', () => {
    const v = (n: number): Variant => ({ n, base: 'test:sample', basePath: 'home/characters/sample.yaml', text: 't' });
    expect(freeSlot([])).toBe(1);
    expect(freeSlot([v(1), v(3)])).toBe(2);
    expect(freeSlot([v(1), v(2), v(3)])).toBeNull();
    expect(variantPath('home/characters/sample.yaml', 2)).toBe('home/characters/__compare-variant-2__.yaml');
    const set = withVariants({ packs: [{ path: 'home/characters/__compare-variant-1__.yaml', text: 'old' }], scenarios: [], policies: [] }, [v(1)]);
    expect(set.packs).toEqual([variantFile(v(1))]);
  });
});

describe('a variant of a premade hero', () => {
  it('loads next to the hero as its own character with the changed pick', () => {
    const hero = listCharacters(PACKS).find((c) => c.id === 'test:hero-fighter-5')!;
    const text = setPick(startText(hero.text, hero.id, hero.name, 1)!, 'srd:fighter#fighting-style', ['srd:archery'])!;
    const set = withVariants({ packs: PACKS, scenarios: [], policies: [] }, [{ n: 1, base: hero.id, basePath: hero.path, text }]);
    const res = loadContent(set.packs);
    expect(res.errors).toEqual([]);
    const id = variantId(hero.id, 1);
    expect(res.content!.templates.some((t) => t.id === id && t.name === 'Fighter 5 (variant 1)')).toBe(true);
    expect(res.content!.templates.some((t) => t.id === hero.id)).toBe(true);
  });
});

describe('ability score increases and spells', () => {
  it('reads and rewrites a map pick on its one line', () => {
    expect(readCharacter(TEXT)!.maps['srd:fighter#asi-4']).toEqual({ asi: { str: 2 }, feat: null });
    const t = setPickValue(TEXT, 'srd:fighter#asi-4', '{ feat: srd:grappler }')!;
    expect(readCharacter(t)!.maps['srd:fighter#asi-4']).toEqual({ asi: null, feat: 'srd:grappler' });
    expect(asiPick({ asi: { str: 2 }, feat: null }, false)).toMatchObject({ mode: 'two', a: 'str' });
    expect(asiPick({ asi: { dex: 1, con: 1 }, feat: null }, false)).toMatchObject({ mode: 'oneone', a: 'dex', b: 'con' });
    expect(asiPick({ asi: null, feat: 'srd:grappler' }, false)).toMatchObject({ mode: 'feat', feat: 'srd:grappler' });
    expect(asiPick({ asi: { wis: 2, con: 1 }, feat: null }, true)).toMatchObject({ mode: 'two', a: 'wis', b: 'con' });
    expect(asiPick({ asi: { wis: 1, con: 1, dex: 1 }, feat: null }, true).mode).toBe('all');
    expect(asiText({ asi: { dex: 1, con: 1 }, feat: null })).toBe('+1 DEX, +1 CON');
  });
  it('moves the final scores when an increase changes', () => {
    const t = 'abilities: { str: 17, dex: 13, con: 14 } # final\n';
    expect(shiftAbilities(t, asiValue('{ asi: { str: 2 } }'), asiValue('{ asi: { dex: 1, con: 1 } }'))).toBe('abilities: { str: 15, dex: 14, con: 15 } # final\n');
    expect(shiftAbilities(t, asiValue('{ asi: { str: 2 } }'), asiValue('{ feat: srd:grappler }'))).toBe('abilities: { str: 15, dex: 13, con: 14 } # final\n');
    expect(shiftAbilities(t, undefined, asiValue('{ asi: { wis: 2 } }'))).toBeNull();
    expect(shiftAbilities('abilities:\n  str: 10\n', undefined, undefined)).toBeNull();
  });
  it('rewrites a casting list on its one line, adds a missing list, and keeps the rest', () => {
    const t = setCasting(TEXT, 'srd:druid', 'cantrips', ['srd:produce-flame', 'srd:poison-spray'])!;
    const c = readCharacter(t)!.casting[0]!;
    expect(c.cantrips).toEqual(['srd:produce-flame', 'srd:poison-spray']);
    expect(c.prepared).toEqual(['srd:cure-wounds']);
    expect(t).toContain('} # note');
    expect(readCharacter(setCasting(TEXT, 'srd:other', 'prepared', ['srd:bless'])!)!.casting[1]).toEqual({ source: 'srd:other', cantrips: [], prepared: ['srd:bless'] });
    expect(setCasting(TEXT, 'srd:nobody', 'cantrips', [])).toBeNull();
    expect(differences(readCharacter(TEXT), readCharacter(t), [], (id) => id)).toEqual(['cantrips: dropped srd:starry-wisp, added srd:poison-spray']);
  });
  it('lists the loaded spells with their levels', () => {
    const all = spellList(PACKS);
    expect(all.find((x) => x.id === 'srd:produce-flame')).toEqual({ id: 'srd:produce-flame', name: 'Produce Flame', level: 0 });
    expect(all.some((x) => x.level >= 1)).toBe(true);
  });
});

describe('checks side by side', () => {
  it('shows only the checks whose modifier differs, with exact chances', () => {
    const res = loadContent(PACKS);
    const hero = res.sheets!.find((x) => x.id === 'test:hero-fighter-5')!;
    const other: DerivedSheet = { ...hero, skills: hero.skills.map((k) => (k.skill === 'acrobatics' ? { ...k, mod: k.mod + 5 } : k)) };
    const c = oddsCompare([hero, other], 15);
    expect(c.lines.map((l) => l.key)).toEqual(['skill:acrobatics']);
    expect(c.lines[0]!.mods[1]! - c.lines[0]!.mods[0]!).toBe(5);
    expect(c.lines[0]!.ps[1]! - c.lines[0]!.ps[0]!).toBeCloseTo(0.25);
    expect(c.same).toBeGreaterThan(20);
    expect(oddsCompare([hero, hero], 15).lines).toEqual([]);
    expect(oddsCompare([hero], 15)).toEqual({ lines: [], same: 0 });
  });
});
