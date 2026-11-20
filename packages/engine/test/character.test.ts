// kind: character (M3 step 3, docs/design/m3.md 2.6 and critique resolutions C9a, C10, C15, C16,
// C24): the HP rule with its PDF tables, feature HP grants scoped to the right levels, AC from
// armor, shields and class formulas, the qualified and short @scale forms, narrative features
// above level 10, pick validation, the derived sheet, and determinism. Characters live in memory
// under packs/test/characters/ so no committed file changes.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandCharacter, hitPoints, renderSheet, sheetJson, type CharacterLib, type DerivedSheet } from '../src/content/character.ts';
import { loadContent, type LoadResult } from '../src/content/load.ts';
import { ArmorSchema, BackgroundSchema, CharacterSchema, ClassSchema, FeatSchema, FeatureSchema, SpeciesSchema, SubclassSchema, WeaponSchema } from '../src/content/schema.ts';
import type { CompiledTemplate, Content } from '../src/content/types.ts';
import { formatDiag, parseYaml, type SourceFile } from '../src/content/yaml.ts';
import { canonicalJson } from '../src/util/canon.ts';
import { hash64 } from '../src/util/hash.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const walk = (d: string): string[] =>
  readdirSync(d)
    .flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.yaml') ? [p] : [];
    })
    .sort();
const readPack = (name: string): SourceFile[] => walk(join(ROOT, 'packs', name)).map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, 'utf8') }));
// The committed sample characters (packs/test/characters/) are left out: these tests build the
// same ids in memory. apps/cli/test/sample-characters.test.ts checks the committed files.
const REPO = [...readPack('srd-5.2.1'), ...readPack('test').filter((f) => !f.path.startsWith('packs/test/characters/'))];
const withFiles = (extra: Record<string, string>): SourceFile[] => [...REPO.filter((f) => !Object.hasOwn(extra, f.path)), ...Object.entries(extra).map(([path, text]) => ({ path, text }))];
const errs = (r: LoadResult) => r.errors.map(formatDiag);
const warns = (r: LoadResult) => r.warnings.map(formatDiag);
const tplHash = (t: CompiledTemplate | undefined): string => hash64(canonicalJson(t ?? null));

const CHAR = 'packs/test/characters/c.yaml';

interface Built {
  readonly r: LoadResult;
  readonly content: Content | null;
  readonly tpl: CompiledTemplate | undefined;
  readonly sheet: DerivedSheet | undefined;
}
function build(yaml: string, extra: Record<string, string> = {}): Built {
  const r = loadContent(withFiles({ ...extra, [CHAR]: yaml }));
  const id = /^id: (\S+)/m.exec(yaml)![1]!;
  return { r, content: r.content, tpl: r.content?.get(id), sheet: (r.sheets ?? []).find((s) => s.id === id) };
}
function ok(yaml: string, extra: Record<string, string> = {}): Built & { tpl: CompiledTemplate; sheet: DerivedSheet } {
  const b = build(yaml, extra);
  if (!b.tpl || !b.sheet) throw new Error(errs(b.r).join('\n'));
  return b as Built & { tpl: CompiledTemplate; sheet: DerivedSheet };
}

/** C15: a class-built Fighter 5 beside the hand-filled test:sample-fighter (which stays a pc). */
const FIGHTER = `kind: character
id: test:sample-fighter-built
name: Sample Fighter (built)
rules: '2024'
classes: [{ class: srd:fighter, level: 5, subclass: srd:champion }]
species: srd:human
size: medium
background: srd:soldier
abilities: { str: 16, dex: 14, con: 14, int: 10, wis: 12, cha: 8 }
picks:
  srd:fighter#skills: [acrobatics, perception]
  srd:fighter#fighting-style: [srd:defense]
  srd:fighter#asi-4: { asi: { str: 1, con: 1 } }
  srd:fighter#weapon-mastery: [srd:longsword, srd:handaxe, srd:greatsword, srd:javelin]
  srd:human#skillful: [insight]
  srd:human#versatile: [srd:skilled]
  srd:skilled#skills: [history, survival, stealth]
  srd:soldier#tools: [Gaming Set (Dice)]
equipment: { armor: srd:chain-mail, shield: true, weapons: [srd:longsword, { id: srd:handaxe, count: 2 }] }
`;

/** The section 5 Monk 6, as a character file. */
const MONK = `kind: character
id: test:sample-monk
name: Sample Monk
rules: '2024'
classes: [{ class: srd:monk, level: 6, subclass: srd:warrior-of-the-open-hand }]
species: srd:dwarf
background: srd:soldier
abilities: { str: 10, dex: 16, con: 14, int: 10, wis: 16, cha: 8 }
picks:
  srd:monk#skills: [acrobatics, insight]
  srd:monk#asi-4: { asi: { dex: 1, wis: 1 } }
  srd:soldier#tools: [Gaming Set (Dice)]
  srd:soldier#abilities: { asi: { dex: 2, con: 1 } }
equipment: { weapons: [srd:shortsword, { id: srd:dart, count: 10 }] }
`;

describe('the HP rule (C10: SRD 5.2.1 p.22 Level 1 Hit Points by Class, p.23 Fixed Hit Points by Class)', () => {
  it('the hand check: a Fighter 5 with CON 14 has 10+2 + 4 x (6+2) = 44', () => {
    expect(hitPoints(10, 5, 2, 'average').total).toBe(44);
    const { sheet, tpl } = ok(FIGHTER);
    expect(tpl.hpMax).toBe(44);
    expect(sheet.hpMax.value).toBe(44);
    expect(sheet.hpMax.why).toBe('10 (L1 max d10, p.22) + 4 x 6 (fixed d10, p.23) + 5 x 2 (CON)');
  });

  it('level 1 and the fixed value match the PDF tables in srd-index.json for all 12 classes', () => {
    const index = JSON.parse(readFileSync(join(ROOT, 'tools/import-srd/srd-index.json'), 'utf8')) as { hitPoints: { level1: { page: number; values: Record<string, number> }; fixedPerLevel: { page: number; values: Record<string, number> } } };
    expect(index.hitPoints.level1.page).toBe(22);
    expect(index.hitPoints.fixedPerLevel.page).toBe(23);
    const names = Object.keys(index.hitPoints.level1.values).sort();
    expect(names).toHaveLength(12);
    const content = loadContent(REPO);
    for (const name of names) {
      const text = REPO.find((f) => f.path === `packs/srd-5.2.1/classes/${name}.yaml`)!.text;
      const hitDie = Number(/^hitDie: (\d+)$/m.exec(text)![1]);
      expect(hitPoints(hitDie, 1, 0, 'average').total, name).toBe(index.hitPoints.level1.values[name]);
      expect(hitPoints(hitDie, 2, 0, 'average').total - hitPoints(hitDie, 1, 0, 'average').total, name).toBe(index.hitPoints.fixedPerLevel.values[name]);
    }
    expect(content.errors).toEqual([]);
  });

  it('rolled hit points add each roll + CON with a minimum of 1 per level', () => {
    // d6, CON 6 (-2): rolls 1 and 2 come to -1 and 0, each raised to 1; the roll 6 gives 4.
    const h = hitPoints(6, 4, -2, { rolled: [1, 2, 6] });
    expect(h.total).toBe(4 + 1 + 1 + 4);
    expect(h.clamped).toBe(true);
    expect(hitPoints(8, 3, 2, { rolled: [8, 1] }).total).toBe(10 + 10 + 3);
    expect(hitPoints(8, 3, 2, { rolled: [8] }).error).toMatch(/needs 2 \(levels 2 to 3\)/);
    expect(hitPoints(8, 2, 2, { rolled: [9] }).error).toMatch(/above the d8 Hit Die/);
  });

  it('review R3: the why string adds up when the minimum of 1 applies (a clamped level is its own total, out of the CON term)', () => {
    // Wizard 3, CON 6 (-2), rolled [1, 6]: (6 - 2) + max(1, 1 - 2) + (6 - 2) = 9.
    const r = hitPoints(6, 3, -2, { rolled: [1, 6] });
    expect(r.total).toBe(9);
    expect(r.why).toBe('6 (L1 max d6, p.22) + rolls [1 + -2 -> 1, 6] (p.23: d6 + CON per level, minimum 1) + 2 x -2 (CON) [minimum 1 applied]');
    expect(6 + 1 + 6 + 2 * -2).toBe(r.total);
  });

  it('review M5: the [U] minimum of 1 on the fixed value and at level 1 is applied and shown', () => {
    // d6, CON 3 (-4): level 1 is 6 - 4 = 2; each later level 4 - 4 = 0, raised to 1.
    const f = hitPoints(6, 3, -4, 'average');
    expect(f).toMatchObject({ total: 4, clamped: true });
    expect(f.why).toBe('6 (L1 max d6, p.22) + 2 x (4 + -4 -> 1) (fixed d6, p.23, minimum 1, U) + 1 x -4 (CON) [minimum 1 per level applied, U]');
    expect(hitPoints(6, 3, -4, 'max')).toMatchObject({ total: 2 + 2 * 2, clamped: false });
    // Level 1: d6 with the lowest legal modifier (-5) is exactly 1; the floor itself needs -6.
    expect(hitPoints(6, 1, -5, 'average')).toMatchObject({ total: 1, clamped: false });
    const l1 = hitPoints(6, 1, -6, 'average');
    expect(l1).toMatchObject({ total: 1, clamped: true });
    expect(l1.why).toBe('(6 + -6 -> 1) (L1 max d6, p.22, floored at 1, U) [minimum 1 per level applied, U]');
  });

  it('hp: max takes the full die every level; a character file gets an error for a wrong roll count', () => {
    expect(hitPoints(10, 5, 2, 'max').total).toBe(5 * 12);
    const b = build(FIGHTER.replace("rules: '2024'", "rules: '2024'\nhp: { rolled: [6, 6] }"));
    expect(b.content).toBeNull();
    expect(errs(b.r).join('\n')).toMatch(/c\.yaml:\d+:\d+: hp: hp\.rolled lists 2 roll\(s\); a level 5 character needs 4/);
  });

  it('an override replaces the number and keeps the derivation beside it', () => {
    const { tpl, sheet } = ok(FIGHTER.replace("rules: '2024'", "rules: '2024'\noverrides: { hpMax: { value: 47, why: 'DM-approved rolled HP' } }"));
    expect(tpl.hpMax).toBe(47);
    expect(sheet.hpMax.override).toEqual({ derived: 44, derivedWhy: '10 (L1 max d10, p.22) + 4 x 6 (fixed d10, p.23) + 5 x 2 (CON)', why: 'DM-approved rolled HP' });
    expect(build(FIGHTER.replace("rules: '2024'", "rules: '2024'\noverrides: { mood: { value: 1, why: x } }")).r.errors.map((d) => d.message).join('\n')).toMatch(/unknown key "mood"/);
  });
});

describe('feature HP grants (C9a): perLevel counts the owner\'s levels', () => {
  it('Draconic Resilience counts Sorcerer levels; Dwarven Toughness counts character levels', () => {
    const sorc = ok(`kind: character
id: test:sorc
name: Sorc
rules: '2024'
classes: [{ class: srd:sorcerer, level: 6, subclass: srd:draconic-sorcery }]
species: srd:dwarf
background: srd:sage
abilities: { str: 8, dex: 14, con: 14, int: 10, wis: 12, cha: 18 }
`);
    // 6 + 5 x 4 + 6 x 2 = 38, + 6 (Draconic Resilience) + 6 (Dwarven Toughness).
    expect(sorc.tpl.hpMax).toBe(38 + 6 + 6);
    expect(sorc.sheet.hpMax.why).toContain('+ 6 x 1 (Draconic Resilience, Sorcerer levels)');
    expect(sorc.sheet.hpMax.why).toContain('+ 6 x 1 (Dwarven Toughness, character levels)');
    // Before the subclass (level 2), no Draconic Resilience.
    const l2 = ok(`kind: character
id: test:sorc2
name: Sorc 2
rules: '2024'
classes: [{ class: srd:sorcerer, level: 2 }]
species: srd:human
size: medium
background: srd:sage
abilities: { str: 8, dex: 14, con: 14, int: 10, wis: 12, cha: 18 }
`);
    expect(l2.tpl.hpMax).toBe(6 + 4 + 2 * 2);
  });

  it('a flat grant from a feat adds once', () => {
    const extra = {
      'packs/test/data/sturdy.yaml': 'kind: feature\nid: test:sturdy\nname: Sturdy\nsource: synthetic\nhp: { flat: 5, perLevel: 2 }\n',
      'packs/test/data/hardy-feat.yaml': 'kind: feat\nid: test:hardy-feat\nname: Hardy Feat\nsource: synthetic\ncategory: general\nfeatures: [test:sturdy]\n',
    };
    const { tpl, sheet } = ok(FIGHTER.replace('srd:fighter#asi-4: { asi: { str: 1, con: 1 } }', 'srd:fighter#asi-4: { feat: test:hardy-feat }'), extra);
    expect(tpl.hpMax).toBe(44 + 5 * 2 + 5);
    expect(sheet.hpMax.why).toContain('+ 5 x 2 (Sturdy, character levels) + 5 (Sturdy)');
  });
});

describe('AC: armor, shields and class formulas (SRD 5.2.1 Equipment; only one calculation at a time)', () => {
  it('heavy armor plus a held, trained shield; the template keeps the shield in a hand', () => {
    const { tpl, sheet } = ok(FIGHTER);
    // M3 step 4: the Defense fighting style's +1 AC while armored (SRD 5.2.1 p.88) is a passive stat;
    // the sheet adds it, the template leaves it to the fight.
    expect(sheet.ac.value).toBe(19);
    expect(sheet.ac.why).toBe('16 (Chain Mail, heavy) + 2 (Shield, held) + 1 (Defense, while armored)');
    expect(tpl.ac).toBe(16);
    // M3 step 5b: the weapons are hand items after the shield; with no hands given, the first weapon and the shield are in hand.
    expect(tpl.items.map((i) => [i.local, i.kind, i.shieldAc])).toEqual([['shield', 'shield', 2], ['longsword', 'weapon', 0], ['handaxe', 'weapon', 0]]);
    expect(tpl.startHands).toEqual([1, 0]);
  });

  it('medium armor caps DEX; light adds it all', () => {
    const scale = ok(FIGHTER.replace('srd:chain-mail', 'srd:scale-mail').replace('dex: 14', 'dex: 18'));
    expect(scale.sheet.ac.value).toBe(14 + 2 + 2 + 1); // + 1 Defense while armored
    expect(scale.sheet.ac.why).toContain('+ 2 (DEX, max 2)');
    const leather = ok(FIGHTER.replace('srd:chain-mail', 'srd:leather-armor').replace('dex: 14', 'dex: 18').replace('shield: true', 'shield: false'));
    expect(leather.sheet.ac.value).toBe(11 + 4 + 1);
  });

  it('Monk Unarmored Defense needs no armor and no shield; the best legal calculation wins', () => {
    const m = ok(MONK);
    expect(m.sheet.ac.value).toBe(16);
    expect(m.sheet.ac.why).toBe('10 + 3 (DEX) + 3 (WIS) = 16 (Monk, while unarmored and noShield); best of unarmored 13, srd:monk 16');
    const shielded = ok(MONK.replace('equipment: {', 'equipment: { shield: true,'));
    // The Monk has no Shield training: the shield adds nothing but still blocks Unarmored Defense.
    expect(shielded.sheet.ac.value).toBe(13);
    expect(warns(shielded.r).join('\n')).toMatch(/Monk has no Shield training: the shield adds no AC/);
    // Still a shield in hand (noShield gates see it; M3 step 4), with no AC bonus.
    expect(shielded.tpl.items.map((i) => [i.kind, i.shieldAc])).toEqual([['shield', 0], ['weapon', 0], ['weapon', 0]]);
  });

  it('acSource picks a named legal calculation; an illegal one is an error', () => {
    expect(ok(MONK.replace('classes:', 'acSource: unarmored\nclasses:')).sheet.ac.value).toBe(13);
    const bad = build(MONK.replace('classes:', 'acSource: armor\nclasses:'));
    expect(errs(bad.r).join('\n')).toMatch(/acSource: no legal AC calculation armor for this character \(legal: unarmored, srd:monk\)/);
  });

  it('heavy armor without the Strength it needs costs 10 ft of speed; untrained armor is a warning and an unimplemented line', () => {
    const weak = ok(FIGHTER.replace('str: 16', 'str: 12'));
    expect(weak.sheet.speed.value).toBe(20);
    expect(weak.sheet.speed.why).toBe('30 (Human) - 10 (Chain Mail needs STR 13)');
    const monk = ok(MONK.replace('equipment: {', 'equipment: { armor: srd:leather-armor,'));
    expect(warns(monk.r).join('\n')).toMatch(/Monk has no light armor training/);
    expect(monk.tpl.unimplemented).toContain('Leather Armor without armor training (Disadvantage on STR/DEX d20 tests, no spellcasting): not modeled');
    // Review M1: worn armor blocks Unarmored Defense; leather 11 + DEX is the only calculation.
    expect(monk.sheet.ac.value).toBe(11 + 3);
    expect(monk.sheet.ac.why).toBe('11 (Leather Armor, light) + 3 (DEX)');
    const named = build(MONK.replace('equipment: {', 'equipment: { armor: srd:leather-armor,').replace('classes:', 'acSource: srd:monk\nclasses:'));
    expect(errs(named.r).join('\n')).toMatch(/acSource: no legal AC calculation srd:monk for this character \(legal: armor\)/);
  });
});

describe('weapons to attacks', () => {
  it('to-hit is the ability mod (finesse: the better of STR and DEX; ranged: DEX) + PB if proficient by the class\'s categories', () => {
    const { tpl, sheet } = ok(MONK);
    expect(tpl.attacks.map((a) => [a.local, a.kind, a.toHit, a.normalFt, a.longFt])).toEqual([
      ['shortsword', 'melee', 6, 0, 0],
      ['dart', 'ranged', 6, 20, 60],
      ['unarmed-strike', 'melee', 6, 0, 0], // Martial Arts (step 5a): DEX + PB, SRD 5.2.1 p.50
    ]);
    expect(tpl.gear).toEqual([{ name: 'Dart', count: 10 }]);
    expect(sheet.attacks[0]!.toHit.why).toBe('3 (DEX mod, finesse) + 3 (PB, proficient: srd:shortsword)');
    expect(sheet.attacks[0]!.notes).toEqual([
      'properties: finesse, light',
      'mastery vex: not usable (no Weapon Mastery feature)',
      'Light: no second Light weapon, so no extra attack',
      '1d8 Martial Arts die in place of 1d6 (Martial Arts, @scale.monk.die at level 6)',
    ]);
  });

  it('a thrown melee weapon keeps its melee ability and gets a thrown mode; mastered weapons get their mastery riders (step 5b)', () => {
    const { tpl, sheet } = ok(FIGHTER);
    expect(tpl.attacks.map((a) => [a.local, a.toHit])).toEqual([['longsword', 6], ['handaxe', 6], ['handaxe-thrown', 6], ['unarmed-strike', 6]]);
    expect(tpl.attackAct.alts[0]![0]!.count).toBe(2);
    // With a Shield equipped the Longsword has no two-handed mode (doffing the Shield is the Utilize action, not modeled).
    expect(tpl.unimplemented).toContain('Longsword: Versatile two-handed damage with a Shield equipped (doffing the Shield, the Utilize action) not modeled');
    expect(sheet.attacks.find((a) => a.id === 'longsword')!.notes).toEqual(expect.arrayContaining(['mastery sap: mastered (Weapon Mastery)']));
    expect(sheet.options.map((o) => o.name)).toEqual(expect.arrayContaining(['Sap (Longsword)', 'Vex (Handaxe)']));
  });

  it('C15: the built Fighter 5 matches the hand sheet test:sample-fighter on every derived number it states', () => {
    const { tpl, content } = ok(FIGHTER);
    const hand = content!.get('test:sample-fighter')!;
    expect(tpl.pb).toBe(hand.pb);
    expect(tpl.hpMax).toBe(hand.hpMax);
    expect(tpl.saveMod).toEqual(hand.saveMod);
    expect(tpl.attackAct.alts).toEqual(hand.attackAct.alts);
    expect(tpl.attacks.map((a) => [a.local, a.toHit, a.damage, a.reachFt, a.normalFt, a.longFt])).toEqual(hand.attacks.map((a) => [a.local, a.toHit, a.damage, a.reachFt, a.normalFt, a.longFt]));
    // AC: the hand sheet states 18 with no shield item; the built one is 16 + a held Shield's 2.
    expect(tpl.ac + 2).toBe(hand.ac);
    // The template hashes differ (C15): class data adds pools, features, skills and the shield.
    expect(tplHash(tpl)).not.toBe(tplHash(hand));
  });

  it('a count on a weapon that isn\'t thrown is an error; a weapon the class can\'t use gets no PB', () => {
    const b = build(MONK.replace('weapons: [srd:shortsword,', 'weapons: [{ id: srd:shortsword, count: 2 },'));
    expect(errs(b.r).join('\n')).toMatch(/count: Shortsword isn't a thrown or Ammunition weapon/);
    const { sheet, r } = ok(MONK.replace('weapons: [srd:shortsword,', 'weapons: [srd:longsword,'));
    expect(sheet.attacks[0]!.toHit.value).toBe(0);
    expect(warns(r).join('\n')).toMatch(/Monk isn't proficient with Longsword/);
  });
});

describe('@scale (C16): the qualified form relative to its owner, and the short form', () => {
  const STRIKER = `kind: class
id: test:striker
name: Striker
source: synthetic test fixture
hitDie: 8
saves: [str, dex]
skills: { choose: 1, from: [acrobatics, athletics] }
subclassLevel: 3
scale:
  strike: { type: dice, at: { 1: 1d6, 5: 1d8 } }
  focus: { type: number, at: { 2: 2, 3: 3, 4: 4, 5: 5 } }
pools:
  - { id: focus, name: Focus, max: '@scale.striker.focus', recharge: [{ period: short, amount: all }] }
  - { id: bursts, name: Bursts, max: '@scale.focus + 1', recharge: longRest }
features: { 1: [test:strike-heal] }
`;
  const PALM = `kind: subclass
id: test:open-palm
name: Open Palm
source: synthetic test fixture
parent: test:striker
scaleOwner: palm
scale:
  ripple: { type: number, at: { 3: 2, 5: 3 } }
pools:
  - { id: ripples, name: Ripples, max: '@scale.palm.ripple + @scale.striker.focus', recharge: longRest }
  - { id: waves, name: Waves, max: '@scale.open-palm.ripple', recharge: longRest }
`;
  const HEAL = `kind: feature
id: test:strike-heal
name: Strike Heal
source: synthetic test fixture
activate:
  id: go
  name: Go
  cost: bonus
  do:
    - target: { range: 5, self: yes }
    - heal: { roll: '@scale.striker.strike' }
    - heal: { roll: '@scale.strike' }
`;
  const DATA = { 'packs/test/data/striker.yaml': STRIKER, 'packs/test/data/open-palm.yaml': PALM, 'packs/test/data/strike-heal.yaml': HEAL };
  const CHR = (level: number, sub = true) => `kind: character
id: test:striker-pc
name: Striker PC
rules: '2024'
classes: [{ class: test:striker, level: ${level}${sub ? ', subclass: test:open-palm' : ''} }]
species: srd:dwarf
background: srd:soldier
abilities: { str: 10, dex: 16, con: 14, int: 10, wis: 16, cha: 8 }
picks: { test:striker#skills: [acrobatics], srd:soldier#tools: [Gaming Set (Dice)] }
`;

  it('class pools bind the qualified and the short form at the class level; a feature\'s rolls bind dice columns', () => {
    const { tpl, sheet } = ok(CHR(5), DATA);
    expect(sheet.pools.map((p) => [p.id, p.max])).toEqual([['focus', 5], ['bursts', 6], ['ripples', 8], ['waves', 3]]);
    expect(tpl.pools.map((p) => [p.local, p.max])).toEqual([['focus', 5], ['bursts', 6], ['ripples', 8], ['waves', 3]]);
    const heals = tpl.features[0]!.activate!.steps.filter((s) => s.k === 'heal').map((s) => (s as { roll: unknown }).roll);
    expect(heals).toEqual([{ k: 'dice', n: 1, sides: 8 }, { k: 'dice', n: 1, sides: 8 }]);
    const l1 = ok(CHR(1, false), DATA);
    expect(l1.tpl.features[0]!.activate!.steps.filter((s) => s.k === 'heal').map((s) => (s as { roll: unknown }).roll)).toEqual([{ k: 'dice', n: 1, sides: 6 }, { k: 'dice', n: 1, sides: 6 }]);
    // Below a number column's first breakpoint it binds 0.
    expect(l1.sheet.pools.map((p) => [p.id, p.max])).toEqual([['focus', 0], ['bursts', 1]]);
  });

  it('the subclass\'s own columns are owned by the subclass (its id or its scaleOwner), not the parent', () => {
    const r = loadContent(withFiles({ ...DATA, 'packs/test/data/open-palm.yaml': PALM.replace("'@scale.open-palm.ripple'", "'@scale.striker.ripple'") }));
    expect(errs(r).join('\n')).toMatch(/open-palm\.yaml:\d+:\d+: pools\[1\]\.max: @scale\.striker\.ripple: ripple belongs to open-palm, not striker/);
  });

  it('the SRD Monk\'s stored qualified form binds at level 6', () => {
    expect(ok(MONK).tpl.pools.map((p) => [p.local, p.max])).toEqual([['monks-focus', 6], ['uncanny-metabolism', 1], ['wholeness-of-body', 3]]);
  });

  it('a short name two owners share is ambiguous in a feature; the qualified form still binds', () => {
    const both = { ...DATA, 'packs/test/data/open-palm.yaml': PALM.replace('  ripple:', '  strike: { type: dice, at: { 3: 1d10 } }\n  ripple:') };
    const b = build(CHR(5), both);
    expect(errs(b.r).join('\n')).toMatch(/features\[4\]: test:strike-heal: @scale\.strike is ambiguous here: open-palm and striker each have a "strike" column \(write @scale\.open-palm\.strike or @scale\.striker\.strike\)/);
    const qualified = ok(CHR(5), { ...both, 'packs/test/data/strike-heal.yaml': HEAL.replace("roll: '@scale.strike'", "roll: '@scale.palm.strike'") });
    expect(qualified.tpl.features[0]!.activate!.steps.filter((s) => s.k === 'heal').map((s) => (s as { roll: unknown }).roll)).toEqual([{ k: 'dice', n: 1, sides: 8 }, { k: 'dice', n: 1, sides: 10 }]);
  });

  it('a scale column id that starts with a digit is an error at the class (no @scale name could reach it)', () => {
    const r = loadContent(withFiles({ ...DATA, 'packs/test/data/striker.yaml': STRIKER.replace('  strike:', '  2nd-wind: { type: number, at: { 1: 1 } }\n  strike:') }));
    expect(errs(r).join('\n')).toMatch(/scale\.2nd-wind: scale column id "2nd-wind" starts with a digit/);
  });

  it('review M4: in a subclass\'s own expression the short form is the subclass\'s column, the qualified form the parent\'s', () => {
    const palm = PALM.replace('  ripple:', '  focus: { type: number, at: { 3: 7 } }\n  ripple:').replace('pools:\n', "pools:\n  - { id: focal, name: Focal, max: '@scale.focus', recharge: longRest }\n  - { id: parental, name: Parental, max: '@scale.striker.focus', recharge: longRest }\n");
    const { sheet } = ok(CHR(5), { ...DATA, 'packs/test/data/open-palm.yaml': palm });
    expect(sheet.pools.filter((p) => p.id === 'focal' || p.id === 'parental').map((p) => [p.id, p.max])).toEqual([['focal', 7], ['parental', 5]]);
  });
});

describe('C24: levels 11-20 load; features gained above level 10 are narrative', () => {
  const F12 = FIGHTER.replace('level: 5', 'level: 12').replace("srd:fighter#asi-4: { asi: { str: 1, con: 1 } }", "srd:fighter#asi-4: { asi: { str: 1, con: 1 } }\n  srd:fighter#asi-6: { asi: { str: 1, con: 1 } }\n  srd:fighter#asi-8: { asi: { str: 2 } }\n  srd:fighter#asi-12: { asi: { dex: 2 } }");
  it('a Fighter 12 has its table numbers and its level 11+ features only on the sheet', () => {
    const { tpl, sheet, r } = ok(F12);
    expect(errs(r)).toEqual([]);
    expect(sheet.pb.value).toBe(4);
    expect(sheet.extraAttacks.value).toBe(2);
    const high = sheet.features.filter((f) => f.level > 10);
    expect(high.map((f) => [f.id, f.compiled])).toEqual([['srd:fighter/two-extra-attacks', false]]);
    expect(sheet.features.filter((f) => f.level <= 10).every((f) => f.compiled)).toBe(true);
    expect(tpl.unimplemented).toContain('Two Extra Attacks (Fighter 11): gained above level 10, narrative in M3 (C24)');
    const ex = expandCharacter(CharacterSchema.parse(parseCharacter(F12)), libOf());
    expect(ex.pc!.features).not.toContain('srd:fighter/two-extra-attacks');
    expect(ex.pc!.features).toContain('srd:fighter/extra-attack');
  });
});

describe('picks: legal and complete for every choice at or below the level', () => {
  it('a complete build has no warnings; the sheet lists the picks by key', () => {
    const { r, sheet } = ok(FIGHTER);
    expect(warns(r)).toEqual([]);
    expect(sheet.picks.map((p) => p.key)).toEqual(['srd:fighter#asi-4', 'srd:fighter#fighting-style', 'srd:fighter#skills', 'srd:fighter#weapon-mastery', 'srd:human#skillful', 'srd:human#versatile', 'srd:skilled#skills', 'srd:soldier#tools']);
    expect(sheet.feats.map((f) => [f.id, f.from])).toEqual([['srd:defense', 'srd:fighter#fighting-style'], ['srd:savage-attacker', 'Soldier'], ['srd:skilled', 'srd:human#versatile']]);
  });

  it('an option not offered, a pick listed twice, too many picks, and an unknown key are errors', () => {
    const b = build(FIGHTER.replace('[acrobatics, perception]', '[arcana, perception, perception]').replace('srd:soldier#tools:', 'srd:soldier#nothing: [x]\n  srd:soldier#tools:'));
    const m = errs(b.r).join('\n');
    expect(b.content).toBeNull();
    expect(m).toMatch(/picks\.srd:fighter#skills\[0\]: arcana isn't an option for srd:fighter#skills/);
    expect(m).toMatch(/picks\.srd:fighter#skills\[2\]: perception is picked twice/);
    expect(m).toMatch(/picks\.srd:fighter#skills: srd:fighter#skills chooses 2, but 3 are picked/);
    expect(m).toMatch(/picks\.srd:soldier#nothing: no choice srd:soldier#nothing \(srd:soldier's choices at level 5 are srd:soldier#tools, srd:soldier#abilities\)/);
  });

  it('a missing pick, a short pick, a missing ASI record and a feat\'s own choices are warnings', () => {
    const b = build(FIGHTER.replace('  srd:skilled#skills: [history, survival, stealth]\n', '').replace('[acrobatics, perception]', '[acrobatics]').replace('  srd:fighter#asi-4: { asi: { str: 1, con: 1 } }\n', ''));
    expect(b.content).not.toBeNull();
    const m = warns(b.r).join('\n');
    expect(m).toMatch(/pick needed: srd:skilled#skills \(Skilled level 1\): choose 3 from acrobatics/);
    expect(m).toMatch(/srd:fighter#skills chooses 2; only 1 picked/);
    expect(m).toMatch(/srd:fighter#asi-4 isn't recorded/);
  });

  it('a pick for a choice above the level, a bad ASI total and the wrong background abilities are errors', () => {
    const b = build(FIGHTER.replace('level: 5', 'level: 3').replace('{ asi: { str: 1, con: 1 } }', '{ asi: { str: 2 } }').replace('srd:soldier#tools:', 'srd:soldier#abilities: { asi: { wis: 2, str: 1 } }\n  srd:soldier#tools:'));
    const m = errs(b.r).join('\n');
    expect(m).toMatch(/picks\.srd:fighter#asi-4: srd:fighter#asi-4 is a level 4 choice; this character is level 3/);
    expect(m).toMatch(/picks\.srd:soldier#abilities: Soldier raises only str, dex, con \(not wis\)/);
    const total = build(FIGHTER.replace('{ asi: { str: 1, con: 1 } }', '{ asi: { str: 1 } }'));
    expect(errs(total.r).join('\n')).toMatch(/an Ability Score Improvement is \+2 to one score or \+1 to two \(this adds 1\)/);
  });

  it('review M6: background increases that add less than 3 are an error', () => {
    const b = build(FIGHTER.replace('srd:soldier#tools:', 'srd:soldier#abilities: { asi: { str: 2 } }\n  srd:soldier#tools:'));
    expect(errs(b.r).join('\n')).toMatch(/picks\.srd:soldier#abilities: background increases are \+2 and \+1, or \+1 to all three \(this adds 2\)/);
  });

  it('review M7: an Epic Boon at an ASI level below 19, and a feat taken twice, are errors', () => {
    const boon = build(FIGHTER.replace('srd:fighter#asi-4: { asi: { str: 1, con: 1 } }', 'srd:fighter#asi-4: { feat: srd:boon-of-combat-prowess }'));
    expect(errs(boon.r).join('\n')).toMatch(/picks\.srd:fighter#asi-4: Boon of Combat Prowess is an Epic Boon feat \(level 19\)/);
    const twice = build(FIGHTER.replace('level: 5', 'level: 6').replace('srd:fighter#asi-4: { asi: { str: 1, con: 1 } }', 'srd:fighter#asi-4: { feat: srd:grappler }\n  srd:fighter#asi-6: { feat: srd:grappler }'));
    expect(errs(twice.r).join('\n')).toMatch(/picks\.srd:fighter#asi-6: Grappler is taken twice and isn't repeatable/);
    expect(warns(twice.r).join('\n')).not.toMatch(/taken twice/);
  });

  it('review M3: a choice due exactly at the character\'s level is offered: a pick is accepted, a missing one is a warning', () => {
    const CLERIC = `kind: character
id: test:cleric7
name: Cleric 7
rules: '2024'
classes: [{ class: srd:cleric, level: 7, subclass: srd:life-domain }]
species: srd:dwarf
background: srd:acolyte
abilities: { str: 10, dex: 12, con: 14, int: 10, wis: 18, cha: 8 }
picks:
  srd:cleric#skills: [history, medicine]
  srd:cleric#divine-order: [srd:cleric/divine-order-protector]
  srd:cleric#asi-4: { asi: { wis: 2 } }
  srd:cleric#blessed-strikes: [srd:cleric/blessed-strikes-divine-strike]
`;
    const picked = build(CLERIC);
    expect(errs(picked.r)).toEqual([]);
    expect(picked.sheet!.features.find((f) => f.id === 'srd:cleric/blessed-strikes-divine-strike')).toMatchObject({ level: 7, from: 'srd:cleric#blessed-strikes' });
    const missing = build(CLERIC.replace('  srd:cleric#blessed-strikes: [srd:cleric/blessed-strikes-divine-strike]\n', ''));
    expect(errs(missing.r)).toEqual([]);
    expect(warns(missing.r).join('\n')).toMatch(/pick needed: srd:cleric#blessed-strikes \(Cleric level 7\)/);
  });

  it('expertise choices give Expertise in proficient skills (2 x PB)', () => {
    const rogue = ok(`kind: character
id: test:rogue
name: Rogue
rules: '2024'
classes: [{ class: srd:rogue, level: 1 }]
species: srd:dwarf
background: srd:criminal
abilities: { str: 10, dex: 16, con: 14, int: 10, wis: 12, cha: 8 }
picks:
  srd:rogue#skills: [acrobatics, insight, perception, persuasion]
  srd:rogue#expertise-1: [perception, history]
`);
    const perception = rogue.sheet.skills.find((s) => s.skill === 'perception')!;
    expect([perception.rank, perception.mod]).toEqual(['expertise', 1 + 4]);
    expect(warns(rogue.r).join('\n')).toMatch(/Expertise in history needs proficiency in it first/);
  });

  it('a subclass below its level or of another class is an error; a missing one at its level is a warning', () => {
    expect(errs(build(FIGHTER.replace('level: 5', 'level: 2')).r).join('\n')).toMatch(/Fighter gains its subclass at level 3; this character is level 2/);
    expect(errs(build(FIGHTER.replace('srd:champion', 'srd:thief')).r).join('\n')).toMatch(/srd:thief is a srd:rogue subclass, not a srd:fighter one/);
    expect(warns(build(FIGHTER.replace(', subclass: srd:champion', '')).r).join('\n')).toMatch(/a level 5 Fighter has a subclass \(from level 3\)/);
  });

  it('a size the species can\'t be, or none when it has two, is an error', () => {
    expect(errs(build(FIGHTER.replace('size: medium\n', '')).r).join('\n')).toMatch(/a Human can be small or medium: choose one with size/);
    expect(errs(build(FIGHTER.replace('size: medium', 'size: large')).r).join('\n')).toMatch(/size: a Human is small or medium, not large/);
  });
});

describe('casting counts (the "cantrip granted twice" finding)', () => {
  const DRUID = `kind: character
id: test:druid
name: Druid
rules: '2024'
classes: [{ class: srd:druid, level: 3, subclass: srd:circle-of-the-land }]
species: srd:dwarf
background: srd:sage
abilities: { str: 10, dex: 14, con: 14, int: 10, wis: 16, cha: 8 }
picks: { srd:druid#skills: [nature, perception] }
casting:
  - { source: srd:druid, cantrips: [test:spark, test:spark], prepared: [srd:healing-word] }
`;
  it('counts are checked against @scale.cantrips-known and max-prepared; a cantrip twice is flagged', () => {
    const b = build(DRUID);
    const m = warns(b.r).join('\n');
    expect(m).toMatch(/casting\[0\]\.cantrips\[1\]: cantrip test:spark is granted twice \(also srd:druid\)/);
    expect(m).not.toMatch(/knows 2 cantrip/);
    expect(m).toMatch(/Druid 3 prepares 6 spell\(s\) \(@scale\.druid\.max-prepared\); 1 chosen/);
    expect(b.sheet!.slots.levels).toEqual([4, 2]);
    expect(b.sheet!.casting[0]!.cantripsExpected).toBe(2);
  });

  it('a casting source that isn\'t one of the character\'s spellcasters is an error', () => {
    expect(errs(build(DRUID.replace('source: srd:druid', 'source: srd:wizard')).r).join('\n')).toMatch(/casting\[0\]\.source: srd:wizard isn't a spellcasting class or subclass of this character \(srd:druid\)/);
  });
});

describe('hands', () => {
  it('a two-handed weapon with a shield in the other hand is flagged; an unknown hand entry is an error', () => {
    const b = build(FIGHTER.replace('weapons: [srd:longsword,', 'hands: [greatsword, shield], weapons: [srd:greatsword,'));
    expect(warns(b.r).join('\n')).toMatch(/greatsword is two-handed: the other hand holds shield/);
    expect(errs(build(FIGHTER.replace('weapons: [srd:longsword,', 'hands: [wand, null], weapons: [srd:longsword,')).r).join('\n')).toMatch(/no weapon or item "wand" is equipped/);
    const noShieldHand = build(FIGHTER.replace('weapons: [srd:longsword,', 'hands: [longsword, null], weapons: [srd:longsword,'));
    expect(warns(noShieldHand.r).join('\n')).toMatch(/Shield is equipped but in neither hand: it adds no AC/);
    expect(noShieldHand.sheet!.ac.value).toBe(16 + 1); // chain mail + Defense, no shield
  });
});

describe('species features gained later ({ id, level })', () => {
  it('a species trait with a level arrives at that character level; a bare id at level 1', () => {
    const species = `kind: species
id: test:skyborn
name: Skyborn
source: synthetic test fixture
size: [medium]
speed: 30
features: [srd:dwarf/darkvision, { id: test:sky-wings, level: 5 }]
`;
    const extra = { 'packs/test/data/skyborn.yaml': species, 'packs/test/data/sky-wings.yaml': 'kind: feature\nid: test:sky-wings\nname: Sky Wings\nsource: synthetic\nfidelity: narrative\n' };
    const at = (lvl: number) => ok(FIGHTER.replace('srd:human', 'test:skyborn').replace('size: medium\n', '').replace(/  srd:human#\S+ \[[^\]]*\]\n/g, '').replace('  srd:skilled#skills: [history, survival, stealth]\n', '').replace('level: 5', `level: ${lvl}`).replace(lvl < 4 ? '  srd:fighter#asi-4: { asi: { str: 1, con: 1 } }\n' : 'NOPE', ''), extra);
    expect(at(4).sheet.features.map((f) => f.id)).not.toContain('test:sky-wings');
    expect(at(5).sheet.features.find((f) => f.id === 'test:sky-wings')).toMatchObject({ level: 5, from: 'Skyborn (level 5)', compiled: true });
    expect(at(5).tpl.unimplemented).toContain('Sky Wings: narrative, not modeled');
  });
});

describe('review R1: a pool exists from the level its feature is gained', () => {
  const at = (cls: string, lvl: number, sub = '') => `kind: character
id: test:pool-${cls}-${lvl}
name: Pool Check
rules: '2024'
classes: [{ class: srd:${cls}, level: ${lvl}${sub ? `, subclass: srd:${sub}` : ''} }]
species: srd:dwarf
background: srd:sage
abilities: { str: 10, dex: 14, con: 14, int: 12, wis: 16, cha: 14 }
`;
  const poolIds = (b: Built & { sheet: DerivedSheet; tpl: CompiledTemplate }) => [b.sheet.pools.map((p) => p.id), b.tpl.pools.map((p) => p.local)];

  it('Monk 3 Open Hand has no Wholeness of Body (Monk 6); Monk 1 no Uncanny Metabolism (Monk 2)', () => {
    expect(poolIds(ok(at('monk', 3, 'warrior-of-the-open-hand')))).toEqual([['monks-focus', 'uncanny-metabolism'], ['monks-focus', 'uncanny-metabolism']]);
    expect(poolIds(ok(at('monk', 1)))).toEqual([[], []]);
    expect(ok(at('monk', 6, 'warrior-of-the-open-hand')).sheet.pools.map((p) => p.id)).toContain('wholeness-of-body');
  });

  it('Cleric 5 has no Divine Intervention (Cleric 10); Sorcerer 4, Druid 4 and Warlock 1 lack their level 5 and 2 pools', () => {
    expect(ok(at('cleric', 5, 'life-domain')).sheet.pools.map((p) => p.id)).toEqual(['channel-divinity-cleric']);
    expect(ok(at('cleric', 10, 'life-domain')).sheet.pools.map((p) => p.id)).toEqual(['channel-divinity-cleric', 'divine-intervention']);
    expect(ok(at('sorcerer', 4, 'draconic-sorcery')).sheet.pools.map((p) => p.id)).not.toContain('sorcerous-restoration');
    expect(ok(at('druid', 4, 'circle-of-the-land')).sheet.pools.map((p) => p.id)).not.toContain('wild-resurgence');
    expect(ok(at('warlock', 1)).sheet.pools.map((p) => p.id)).not.toContain('magical-cunning');
  });
});

describe('review R2: the Wood Elf\'s speed (M3 step 4: a passive speed stat from the reviewed override)', () => {
  it('"Your Speed increases to 35 feet" (p.84): a Wood Elf derives 35, the template keeps the Elf\'s 30 for the fight to add to', () => {
    const elf = ok(`kind: character
id: test:wood-elf
name: Wood Elf
rules: '2024'
classes: [{ class: srd:wizard, level: 1 }]
species: srd:elf
background: srd:sage
abilities: { str: 8, dex: 14, con: 14, int: 16, wis: 12, cha: 10 }
picks: { srd:elf#elven-lineage: [srd:elf/elven-lineage-wood-elf], srd:elf#keen-senses: [perception] }
`);
    expect(elf.sheet.speed.value).toBe(35);
    expect(elf.sheet.speed.why).toBe('30 (Elf) + 5 (Elven Lineage, Wood Elf)');
    expect(elf.tpl.speedFt).toBe(30);
    expect(elf.tpl.unimplemented.some((u) => /speed change/.test(u))).toBe(false);
  });
});

describe('the derived sheet', () => {
  it('renders every number with its source and every feature with its fidelity; the JSON form round-trips', () => {
    const { sheet } = ok(MONK);
    const text = renderSheet(sheet);
    expect(text).toContain('HP max         51   8 (L1 max d8, p.22) + 5 x 5 (fixed d8, p.23) + 6 x 2 (CON) + 6 x 1 (Dwarven Toughness, character levels)');
    expect(text).toContain('Speed          45   30 (Dwarf) + 15 (Unarmored Movement: @scale.monk.unarmored-movement at level 6, while unarmored and noShield)');
    expect(text).toMatch(/srd:monk\/stunning-strike\s+Stunning Strike \(Monk 5\)\s+full/);
    expect(text).toMatch(/srd:monk\/slow-fall\s+Slow Fall \(Monk 4\)\s+narrative/);
    expect(text).toContain('Monk\'s Focus 6   (@scale.monk.focus at level 6 (Monk)); spent by Flurry of Blows, Patient Defense (Focus), Step of the Wind (Focus), Stunning Strike');
    expect(text).toContain('Options (what the compiled features offer in a fight)');
    expect(sheetJson(sheet)).toEqual(JSON.parse(JSON.stringify(sheet)));
    expect(sheet.fidelity).toBe('partial');
    expect(sheet.unimplemented.length).toBeGreaterThan(0);
  });

  it('the sheet\'s unimplemented list is the compiled template\'s', () => {
    const { sheet, tpl } = ok(MONK);
    expect(sheet.unimplemented).toEqual(tpl.unimplemented);
  });
});

describe('determinism and kind: pc', () => {
  it('the same character gives the same template hash, whatever the file order', () => {
    const a = ok(MONK).tpl;
    const files = withFiles({ [CHAR]: MONK });
    const b = loadContent([...files].reverse()).content!.get('test:sample-monk');
    expect(tplHash(b)).toBe(tplHash(a));
    const x1 = expandCharacter(CharacterSchema.parse(parseCharacter(MONK)), libOf());
    const x2 = expandCharacter(CharacterSchema.parse(parseCharacter(MONK)), libOf());
    expect(canonicalJson([x1.pc, x1.sheet, x1.scale, x1.issues])).toBe(canonicalJson([x2.pc, x2.sheet, x2.scale, x2.issues]));
  });

  it('adding a character changes no other template and no other closure', () => {
    const base = loadContent(REPO).content!;
    const withChar = ok(MONK).content!;
    for (const t of base.templates) expect(tplHash(withChar.get(t.id)), t.id).toBe(tplHash(t));
  });

  it('a character compiles exactly like the kind: pc it expands to', () => {
    const ex = expandCharacter(CharacterSchema.parse(parseCharacter(FIGHTER)), libOf());
    const pcYaml = JSON.stringify(ex.pc);
    const r = loadContent(withFiles({ 'packs/test/characters/as-pc.yaml': pcYaml }));
    expect(errs(r)).toEqual([]);
    expect(tplHash(r.content!.get('test:sample-fighter-built'))).toBe(tplHash(ok(FIGHTER).tpl));
  });
});

// ---- helpers that build the expansion's library straight from the repo's packs ----

function parseCharacter(text: string): unknown {
  return parseYaml(text, 'c.yaml').doc!.value;
}

function libOf(): CharacterLib {
  const maps = { class: new Map(), subclass: new Map(), species: new Map(), background: new Map(), feat: new Map(), weapon: new Map(), armor: new Map(), feature: new Map() } as Record<string, Map<string, unknown>>;
  const schemas = { class: ClassSchema, subclass: SubclassSchema, species: SpeciesSchema, background: BackgroundSchema, feat: FeatSchema, weapon: WeaponSchema, armor: ArmorSchema, feature: FeatureSchema } as const;
  const kinds = new Map<string, string>();
  for (const f of REPO) {
    const v = parseYaml(f.text, f.path).doc?.value as { kind?: string; id?: string } | undefined;
    if (!v?.kind || !v.id) continue;
    kinds.set(v.id, v.kind);
    if (Object.hasOwn(schemas, v.kind)) maps[v.kind]!.set(v.id, schemas[v.kind as keyof typeof schemas].parse(v));
  }
  return {
    kinds,
    classes: maps.class,
    subclasses: maps.subclass,
    species: maps.species,
    backgrounds: maps.background,
    feats: maps.feat,
    weapons: maps.weapon,
    armor: maps.armor,
    features: maps.feature,
  } as unknown as CharacterLib;
}
