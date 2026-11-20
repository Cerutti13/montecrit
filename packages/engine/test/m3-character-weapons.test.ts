// M3 step 5b, content/character.ts (docs/design/m3.md C8, section 2.3): a character-built PC holds
// its weapons as hand items, its Weapon Mastery picks are its masteries, and the sheet shows each
// weapon's properties, mastery and whether it's mastered. Characters are built in memory under
// packs/test/characters/ (the committed fixture is read from its file). Tests are named for the
// rule text they check (SRD 5.2.1, srd-raw.txt lines).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WEAPON_MASTERY, type DerivedSheet } from '../src/content/character.ts';
import { loadContent, type LoadResult } from '../src/content/load.ts';
import type { CompiledTemplate } from '../src/content/types.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const walk = (d: string): string[] =>
  readdirSync(d)
    .flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.yaml') ? [p] : [];
    })
    .sort();
const readPack = (name: string): SourceFile[] => walk(join(ROOT, 'packs', name)).map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, 'utf8') }));
const REPO = [...readPack('srd-5.2.1'), ...readPack('test').filter((f) => !f.path.startsWith('packs/test/characters/'))];
const CHAR = 'packs/test/characters/c.yaml';
const errs = (r: LoadResult) => r.errors.map(formatDiag);
const warns = (r: LoadResult) => r.warnings.map(formatDiag);

interface Built {
  readonly r: LoadResult;
  readonly tpl: CompiledTemplate | undefined;
  readonly sheet: DerivedSheet | undefined;
}
function build(yaml: string, path = CHAR): Built {
  const r = loadContent([...REPO, { path, text: yaml }]);
  const id = /^id: (\S+)/m.exec(yaml)![1]!;
  return { r, tpl: r.content?.get(id), sheet: (r.sheets ?? []).find((s) => s.id === id) };
}
function ok(yaml: string): { r: LoadResult; tpl: CompiledTemplate; sheet: DerivedSheet } {
  const b = build(yaml);
  if (!b.tpl || !b.sheet) throw new Error(errs(b.r).join('\n'));
  return b as { r: LoadResult; tpl: CompiledTemplate; sheet: DerivedSheet };
}

const fighter = (o: { level?: number; mastery?: string | null; equipment: string; style?: string }) => `kind: character
id: test:wf
name: Weapons Fighter
rules: '2024'
classes: [{ class: srd:fighter, level: ${o.level ?? 5}${(o.level ?? 5) >= 3 ? ', subclass: srd:champion' : ''} }]
species: srd:human
size: medium
background: srd:soldier
abilities: { str: 16, dex: 14, con: 14, int: 10, wis: 12, cha: 8 }
picks:
  srd:fighter#skills: [acrobatics, perception]
  srd:fighter#fighting-style: [${o.style ?? 'srd:defense'}]
${(o.level ?? 5) >= 4 ? '  srd:fighter#asi-4: { asi: { str: 1, con: 1 } }\n' : ''}${o.mastery === null ? '' : `  srd:fighter#weapon-mastery: ${o.mastery ?? '[srd:longsword, srd:scimitar, srd:shortsword, srd:maul]'}\n`}  srd:human#skillful: [insight]
  srd:human#versatile: [srd:skilled]
  srd:skilled#skills: [history, survival, stealth]
  srd:soldier#tools: [Gaming Set (Dice)]
equipment: ${o.equipment}
`;

const other = (cls: string, mastery: string, weapons = '[srd:shortsword]') => `kind: character
id: test:wo
name: Other
rules: '2024'
classes: [{ class: srd:${cls}, level: 1 }]
species: srd:human
size: medium
background: srd:soldier
abilities: { str: 14, dex: 16, con: 14, int: 10, wis: 12, cha: 8 }
picks:
  srd:${cls}#weapon-mastery: ${mastery}
equipment: { weapons: ${weapons} }
`;

describe('weapons are hand items for a character-built PC (SRD 5.2.1 Weapon Properties, srd-raw.txt:20310-20404)', () => {
  it('every character PC compiles with its weapons as items after its own; a hand may name a weapon', () => {
    const { tpl } = ok(fighter({ equipment: '{ armor: srd:chain-mail, weapons: [srd:scimitar, srd:shortsword], hands: [scimitar, shortsword] }' }));
    expect(tpl.items.map((i) => [i.local, i.kind])).toEqual([
      ['scimitar', 'weapon'],
      ['shortsword', 'weapon'],
    ]);
    expect(tpl.startHands).toEqual([0, 1]);
    // The attacks need their weapon in hand.
    expect(tpl.attacks.filter((a) => a.local !== 'unarmed-strike').map((a) => [a.local, a.item])).toEqual([
      ['scimitar', 0],
      ['shortsword', 1],
    ]);
  });

  it('[U] with no hands given: the first weapon, then the Shield, else a second Light weapon beside a Light first one', () => {
    expect(ok(fighter({ equipment: '{ armor: srd:chain-mail, weapons: [srd:scimitar, srd:shortsword] }' })).tpl.startHands).toEqual([0, 1]);
    const shielded = ok(fighter({ equipment: '{ armor: srd:chain-mail, shield: true, weapons: [srd:longsword, srd:shortsword] }' })).tpl;
    expect(shielded.items.map((i) => i.local)).toEqual(['shield', 'longsword', 'shortsword']);
    expect(shielded.startHands).toEqual([1, 0]);
    // A Two-Handed first weapon takes both hands' worth: the other stays empty.
    expect(ok(fighter({ equipment: '{ armor: srd:chain-mail, weapons: [srd:maul, srd:shortsword] }' })).tpl.startHands).toEqual([0, -1]);
    // With a Shield, a Two-Handed first weapon can't be ready: the next one-handed weapon is.
    expect(ok(fighter({ equipment: '{ armor: srd:chain-mail, shield: true, weapons: [srd:maul, srd:shortsword] }' })).tpl.startHands).toEqual([2, 0]);
  });

  it('"A Two-Handed weapon requires two hands": named in both hands it is one item, held with the other hand empty', () => {
    const { tpl, r } = ok(fighter({ equipment: '{ armor: srd:chain-mail, weapons: [srd:maul], hands: [maul, maul] }' }));
    expect(errs(r)).toEqual([]);
    expect(tpl.startHands).toEqual([0, -1]);
    expect(tpl.attacks.find((a) => a.local === 'maul')!.twoHands).toBe(true);
  });

  it('"A Versatile weapon can be used with one or two hands": a two-handed mode with its die; none with a Shield equipped (a line)', () => {
    const free = ok(fighter({ equipment: '{ armor: srd:chain-mail, weapons: [srd:longsword] }' }));
    const two = free.tpl.attacks.find((a) => a.local === 'longsword-two-handed')!;
    expect(two.twoHands).toBe(true);
    expect(two.damage[0]!.avg).toBe(5 + 3); // 1d10 + STR 3
    expect(free.sheet.attacks[0]!.notes).toContain('two-handed: 1d10 damage (Versatile, with the other hand empty)');
    const shielded = ok(fighter({ equipment: '{ armor: srd:chain-mail, shield: true, weapons: [srd:longsword] }' }));
    expect(shielded.tpl.attacks.some((a) => a.local === 'longsword-two-handed')).toBe(false);
    expect(shielded.tpl.unimplemented).toContain('Longsword: Versatile two-handed damage with a Shield equipped (doffing the Shield, the Utilize action) not modeled');
  });

  it('"Each attack expends one piece of ammunition": count on an Ammunition weapon is the pieces carried; uncounted is a warning and a line', () => {
    const counted = ok(fighter({ equipment: '{ armor: srd:chain-mail, weapons: [{ id: srd:hand-crossbow, count: 20 }] }' }));
    expect(counted.tpl.gear).toEqual([{ name: 'Hand Crossbow ammunition', count: 20 }]);
    const hc = counted.tpl.attacks.find((a) => a.local === 'hand-crossbow')!;
    // "you need a free hand to load a one-handed weapon" (20319-20320); Loading (20351-20358).
    expect([hc.twoHands, hc.loading]).toEqual([true, true]);
    expect(counted.sheet.attacks[0]!.notes).toEqual(expect.arrayContaining(['ammunition: 20 pieces, one per attack', 'Loading: one shot per action, Bonus Action or Reaction']));
    const loose = build(fighter({ equipment: '{ armor: srd:chain-mail, weapons: [srd:hand-crossbow] }' }));
    expect(warns(loose.r).join('\n')).toMatch(/Hand Crossbow uses ammunition: give \{ id: srd:hand-crossbow, count: <pieces> \}/);
    expect(loose.tpl!.unimplemented).toContain('Hand Crossbow: ammunition not counted');
    const bad = build(fighter({ equipment: '{ armor: srd:chain-mail, weapons: [{ id: srd:longsword, count: 2 }] }' }));
    expect(errs(bad.r).join('\n')).toMatch(/Longsword isn't a thrown or Ammunition weapon/);
  });

  it('"Heavy": Disadvantage below STR 13 is on the sheet and the attack', () => {
    const weak = ok(fighter({ equipment: '{ weapons: [srd:maul] }' }).replace('str: 16', 'str: 12'));
    expect(weak.sheet.attacks[0]!.notes).toContain('Heavy with STR 12: Disadvantage on its attack rolls');
    expect(weak.tpl.attacks.find((a) => a.local === 'maul')!.heavyDis).toBe(true);
  });

  it('two of the same weapon are two items (dagger, dagger-2), so they can be a Light pair', () => {
    const { tpl, sheet } = ok(fighter({ mastery: '[srd:dagger, srd:longsword, srd:shortsword, srd:maul]', equipment: '{ weapons: [srd:dagger, srd:dagger], hands: [dagger, dagger-2] }' }));
    expect(tpl.items.map((i) => i.local)).toEqual(['dagger', 'dagger-2']);
    expect(sheet.attacks.map((a) => a.name)).toEqual(['Dagger', 'Dagger (2)', 'Unarmed Strike']);
    expect(tpl.features.map((f) => f.id)).toContain('core:light-weapons');
  });
});

describe('the Light property: "you can make one extra attack as a Bonus Action ... with a different Light weapon" (20339-20349)', () => {
  it('two Light weapons give the extra attack; Nick on a mastered Light weapon makes it part of the Attack action (20432-20435)', () => {
    const { tpl, sheet } = ok(fighter({ equipment: '{ armor: srd:chain-mail, weapons: [srd:scimitar, srd:shortsword], hands: [scimitar, shortsword] }' }));
    expect(tpl.features.map((f) => f.id)).toEqual(expect.arrayContaining(['core:light-weapons', 'core:mastery-shortsword']));
    expect(sheet.options.filter((o) => o.from === 'Light property (two Light weapons)').map((o) => o.name)).toEqual(['Light extra attack', 'Nick (Scimitar)']);
    expect(sheet.attacks[0]!.notes).toContain('Light: an extra attack with a different Light weapon after an Attack action\'s Light strike (Nick: as part of the Attack action, no Bonus Action; no ability modifier to its damage unless negative)');
  });

  it('one Light weapon: no extra attack, and the sheet says why', () => {
    const { tpl, sheet } = ok(fighter({ equipment: '{ armor: srd:chain-mail, weapons: [srd:scimitar, srd:longsword] }' }));
    expect(tpl.features.map((f) => f.id)).not.toContain('core:light-weapons');
    expect(sheet.attacks[0]!.notes).toContain('Light: no second Light weapon, so no extra attack');
  });

  it('review R1: four Daggers are four Light weapons ("you can draw that weapon as part of the attack", 20387-20389): a counted stack gives the extra attack, and the sheet says so', () => {
    const { tpl, sheet } = ok(fighter({ mastery: '[srd:dagger, srd:scimitar, srd:shortsword, srd:maul]', equipment: '{ armor: srd:chain-mail, weapons: [{ id: srd:dagger, count: 4 }], hands: [dagger, null] }' }));
    expect(tpl.features.map((f) => f.id)).toContain('core:light-weapons');
    expect(sheet.attacks[0]!.notes).not.toContain('Light: no second Light weapon, so no extra attack');
    expect(sheet.attacks[0]!.notes.some((n) => n.startsWith('Light: an extra attack with a different Light weapon (another piece of this stack, thrown)'))).toBe(true);
    const single = ok(fighter({ equipment: '{ armor: srd:chain-mail, weapons: [{ id: srd:dagger, count: 1 }], hands: [dagger, null] }' }));
    expect(single.tpl.features.map((f) => f.id)).not.toContain('core:light-weapons');
  });
});

describe('Weapon Mastery: the class\'s pick list <class>#weapon-mastery (WEAPON_MASTERY)', () => {
  it('Fighter: "three kinds of Simple or Martial weapons", more from the Weapon Mastery column (4 at Fighter 5)', () => {
    const { tpl, sheet, r } = ok(fighter({ equipment: '{ armor: srd:chain-mail, weapons: [srd:longsword, srd:maul, { id: srd:javelin, count: 2 }] }' }));
    expect(warns(r)).toEqual([]);
    expect(sheet.picks.find((p) => p.key === 'srd:fighter#weapon-mastery')!.value).toBe('srd:longsword, srd:scimitar, srd:shortsword, srd:maul (not carried: srd:scimitar, srd:shortsword)');
    expect(sheet.attacks.map((a) => a.notes.find((n) => n.startsWith('mastery ')))).toEqual(['mastery sap: mastered (Weapon Mastery)', 'mastery topple: mastered (Weapon Mastery)', 'mastery slow: not mastered (not among srd:fighter#weapon-mastery)', undefined]);
    // The mastered weapons get their riders; the javelin's Slow doesn't.
    expect((tpl.riders ?? []).map((x) => x.local).sort()).toEqual(['sap-longsword', 'topple-maul']);
    expect(sheet.features.find((f) => f.id === 'srd:fighter/weapon-mastery')!.fidelity).toBe('full');
    expect(tpl.unimplemented.some((u) => u.startsWith('Weapon Mastery'))).toBe(false);
    const l1 = build(fighter({ level: 1, mastery: '[srd:longsword, srd:scimitar, srd:shortsword, srd:maul]', equipment: '{ weapons: [srd:longsword] }' }));
    expect(errs(l1.r).join('\n')).toMatch(/chooses 3 at level 1, but 4 are picked/);
  });

  it('a missing pick is a warning, a partial sheet row and a line; a fighter without it has no masteries', () => {
    const b = ok(fighter({ mastery: null, equipment: '{ armor: srd:chain-mail, weapons: [srd:longsword] }' }));
    expect(warns(b.r).join('\n')).toMatch(/pick needed: srd:fighter#weapon-mastery \(Weapon Mastery, Fighter level 1\): choose 4 kinds of weapons/);
    expect(b.sheet.features.find((f) => f.id === 'srd:fighter/weapon-mastery')!.fidelity).toBe('partial');
    expect(b.tpl.unimplemented).toContain('Weapon Mastery: 0 of 4 weapon kinds chosen (pick srd:fighter#weapon-mastery)');
    expect(b.tpl.riders).toBeUndefined();
  });

  it('a kind picked twice, a non-weapon, and too few are reported', () => {
    const b = build(fighter({ mastery: '[srd:longsword, srd:longsword, srd:chain-mail]', equipment: '{ weapons: [srd:longsword] }' }));
    const m = errs(b.r).join('\n');
    expect(m).toMatch(/srd:longsword is picked twice/);
    expect(m).toMatch(/srd:chain-mail is a armor, not a weapon/);
  });

  it('Barbarian: "two kinds of Simple or Martial Melee weapons" (5001-5010): a ranged weapon is refused', () => {
    // W1: Rage's Rage Damage rider comes first (srd:barbarian/rage), then the mastery's.
    expect(ok(other('barbarian', '[srd:greataxe, srd:handaxe]', '[srd:greataxe]')).tpl.riders!.map((x) => x.local)).toEqual(['rage-damage', 'cleave-greataxe']);
    expect(errs(build(other('barbarian', '[srd:greataxe, srd:longbow]', '[srd:greataxe]')).r).join('\n')).toMatch(/Longbow isn't among Simple or Martial Melee weapons/);
  });

  it('Rogue: "two kinds of weapons ... with which you have proficiency" (13755-13765): a Longsword is refused, a Shortsword taken', () => {
    expect(errs(build(other('rogue', '[srd:shortsword, srd:longsword]')).r).join('\n')).toMatch(/Longsword isn't among weapons it is proficient with/);
    // W1: Sneak Attack's rider comes first (srd:rogue/sneak-attack), then the mastery's.
    expect(ok(other('rogue', '[srd:shortsword, srd:dagger]')).tpl.riders!.map((x) => x.local)).toEqual(['sneak-attack', 'vex-shortsword']);
  });

  it('the table names one feature per Weapon Mastery class; a class without it has no pick', () => {
    expect(WEAPON_MASTERY.map((m) => m.feature)).toEqual(['srd:barbarian/weapon-mastery', 'srd:fighter/weapon-mastery', 'srd:paladin/weapon-mastery', 'srd:ranger/weapon-mastery', 'srd:rogue/weapon-mastery']);
    const monk = build(other('monk', '[srd:shortsword]'));
    expect(errs(monk.r).join('\n')).toMatch(/no choice srd:monk#weapon-mastery/);
  });
});

describe('magic Shields and Weapons on a character file', () => {
  it('Shield, +N: "While holding this Shield": the equipped shield is bound to it; the sheet adds +N while it is in hand', () => {
    const withPlus = (hands: string) => fighter({ equipment: `{ armor: srd:chain-mail, shield: true, weapons: [srd:longsword]${hands} }` }).replace('picks:', 'features: [srd:shield-plus-2]\npicks:');
    const held = ok(withPlus(''));
    expect(held.tpl.items.find((i) => i.kind === 'shield')!.magic).toBe('srd:shield-plus-2');
    expect(held.sheet.ac.value).toBe(16 + 2 + 2 + 1); // Chain Mail, Shield, Shield +2, Defense
    expect(held.sheet.ac.why).toContain('+ 2 (Shield, +2, while itemHeld)');
    const stowed = ok(withPlus(', hands: [longsword, null]'));
    expect(stowed.sheet.ac.value).toBe(16 + 1);
    expect(stowed.sheet.ac.why).toContain('Shield, +2: +2, while itemHeld (not itemHeld in this build)');
    const none = build(fighter({ equipment: '{ armor: srd:chain-mail, weapons: [srd:longsword] }' }).replace('picks:', 'features: [srd:shield-plus-1]\npicks:'));
    expect(warns(none.r).join('\n')).toMatch(/Shield, \+1 is a magic Shield, but no shield is equipped/);
  });

  it('Weapon, +N: a character file can\'t yet say which weapon it is, so it is a warning and a line, never silently applied', () => {
    const b = ok(fighter({ equipment: '{ armor: srd:chain-mail, weapons: [srd:longsword] }' }).replace('picks:', 'features: [srd:weapon-plus-1]\npicks:'));
    expect(warns(b.r).join('\n')).toMatch(/Weapon, \+1 is a magic weapon's bonus, but a character file can't yet say which weapon it is/);
    expect(b.tpl.unimplemented).toContain('Weapon, +1: not bound to a weapon (a character file has no field for it yet)');
    expect(b.tpl.attacks.find((a) => a.local === 'longsword')!.toHit).toBe(6);
  });
});

describe('test:sample-fighter-masteries (design section 5\'s last paragraph): masteries, a Light pair and gainAction', () => {
  const text = readFileSync(join(ROOT, 'packs/test/characters/sample-fighter-masteries.yaml'), 'utf8');
  const { tpl, sheet, r } = ok(text);

  it('builds with no warnings; four mastered kinds at Fighter 5, a Light pair in hand', () => {
    expect(warns(r).filter((w) => w.includes('sample-fighter-masteries') || w.includes(CHAR))).toEqual([]);
    expect(sheet.picks.find((p) => p.key === 'srd:fighter#weapon-mastery')!.value).toBe('srd:scimitar, srd:shortsword, srd:maul, srd:javelin');
    expect(tpl.startHands).toEqual([0, 1]);
    expect(tpl.items.map((i) => i.local)).toEqual(['scimitar', 'shortsword', 'maul', 'javelin']);
  });

  it('offers Second Wind, Action Surge (gainAction), the Light extra attack and Nick, and the Vex, Topple and Slow riders', () => {
    expect(sheet.options.map((o) => o.name)).toEqual(['Action Surge', 'Second Wind', 'Vex (Shortsword)', 'Topple (Maul)', 'Slow (Javelin)', 'Light extra attack', 'Nick (Scimitar)']);
    expect((tpl.riders ?? []).map((x) => [x.local, x.on])).toEqual([
      ['vex-shortsword', 'dealtDamage'],
      ['topple-maul', 'hit'],
      ['slow-javelin', 'dealtDamage'],
    ]);
    expect(tpl.attacks.find((a) => a.local === 'maul')).toMatchObject({ twoHands: true, item: 2 });
    expect(tpl.attacks.find((a) => a.local === 'javelin-thrown')).toMatchObject({ throws: true, item: 3 });
  });
});
