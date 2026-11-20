// Unit tests for the PDF index parsers on tiny synthetic pdftotext outputs.

import { describe, expect, it } from 'vitest';
import { crossCheckSpellLists } from '../pdf/build.ts';
import { parseClassTable, parseValue, splitFeatures } from '../pdf/class-tables.ts';
import { parseArmor, parseWeaponProperties, parseWeapons } from '../pdf/equipment.ts';
import { parseChapterHeadings } from '../pdf/headings.ts';
import { parseHitDice, parseHpTable } from '../pdf/hit-points.ts';
import { decodeEntities, layoutPages, parseBboxLayout } from '../pdf/lines.ts';
import { kebab } from '../pdf/names.ts';
import { parseOrigins } from '../pdf/origins.ts';
import { parseSpellHeaders, parseSpellListTables } from '../pdf/spells.ts';
import { L, bbox, layoutTable } from '../pdf/test-fixtures.ts';

const H1 = 31.0;
const H2 = 21.5;
const H3 = 16.7;
const H4 = 14.3;
const H5 = 12.5;
const SUB = 13.3;
const CELL = 10.8;
const BODY = 34.1;

describe('bbox lines', () => {
  it('reads lines in page, column, y order and drops the footer band', () => {
    const lines = parseBboxLayout(
      bbox([
        [L(313.5, 40, H4, 'Right Top'), L(63, 600, BODY, 'left bottom'), L(63, 40, BODY, 'left top'), L(21, 745, 13.1, '7')],
        [L(63, 40, BODY, 'next page')],
      ]),
    );
    expect(lines.map((l) => [l.page, l.col, l.text])).toEqual([
      [1, 0, 'left top'],
      [1, 0, 'left bottom'],
      [1, 1, 'Right Top'],
      [2, 0, 'next page'],
    ]);
    expect(lines[2]!.h).toBe(H4);
  });

  it('joins words whose boxes touch and decodes entities', () => {
    const xhtml = `<page width="594"><line xMin="63" yMin="10" xMax="200" yMax="24.3"><word xMin="63" yMin="10" xMax="71.7" yMax="24.3">A</word><word xMin="71.69" yMin="13" xMax="87" yMax="23">cid</word><word xMin="90.5" yMin="10" xMax="96.9" yMax="24.3">S</word><word xMin="97.1" yMin="13" xMax="124" yMax="23">plash</word><word xMin="127" yMin="10" xMax="140" yMax="24.3">&amp;&#8217;x</word></line></page>`;
    expect(parseBboxLayout(xhtml).map((l) => l.text)).toEqual(['Acid Splash &’x']);
    expect(decodeEntities('&lt;&gt;&quot;&#x41;&nope;')).toBe('<>"A&nope;');
  });

  it('splits layout text into pages without a trailing empty page', () => {
    expect(layoutPages('a\fb\f')).toEqual(['a', 'b']);
  });

  it('kebab-cases names with apostrophes', () => {
    expect(kebab('Warrior of the Open Hand')).toBe('warrior-of-the-open-hand');
    expect(kebab('Monk’s Focus')).toBe('monks-focus');
  });
});

describe('class tables', () => {
  const fighterish = layoutTable(
    'Fighter Features',
    ['                  Proficiency                                    Second        Weapon', '       Level        Bonus          Class Features                   Wind         Mastery'],
    (lv) => `${lv === 1 ? 'Fighting Style, Second Wind' : lv === 9 ? 'Indomitable (one use), Subclass feature' : lv === 11 ? '—' : `Feature ${lv}`}              ${lv < 4 ? 2 : 3}              ${lv < 4 ? 3 : 4}`,
    { 2: 'Wrapped Name' },
  );

  it('parses 20 rows from the right, with continuation lines and parentheticals', () => {
    const t = parseClassTable(['', fighterish], 'fighter');
    expect(t.page).toBe(2);
    expect(t.columnOrder).toEqual(['proficiency-bonus', 'second-wind', 'weapon-mastery']);
    expect(t.columns['second-wind']).toEqual([2, 2, 2, ...Array(17).fill(3)]);
    expect(t.columns['proficiency-bonus']!.slice(0, 6)).toEqual([2, 2, 2, 2, 3, 3]);
    expect(t.features.filter((f) => f.level <= 2)).toEqual([
      { level: 1, name: 'Fighting Style' },
      { level: 1, name: 'Second Wind' },
      { level: 2, name: 'Feature 2 Wrapped Name' },
    ]);
    expect(t.features.find((f) => f.level === 9)).toEqual({ level: 9, name: 'Indomitable', detail: 'one use' });
    expect(t.features.some((f) => f.level === 11)).toBe(false);
    expect(t.subclassLevels).toEqual([9]);
  });

  it('reads dice, bonuses and feet', () => {
    expect(parseValue('D10', 'die')).toBe(10);
    expect(parseValue('1d12', 'die')).toBe(12);
    expect(parseValue('10d6', 'd6')).toBe(10);
    expect(parseValue('+3', 'bonus')).toBe(3);
    expect(parseValue('+15 ft.', 'feet')).toBe(15);
    expect(parseValue('—', 'feet')).toBe(0);
    expect(parseValue('—', 'count')).toBe(0);
    expect(parseValue('—', 'bonus')).toBeUndefined();
    expect(parseValue('3', 'die')).toBeUndefined();
  });

  it('merges a "+10 ft." cell back into one token', () => {
    const monkish = layoutTable(
      'Monk Features',
      ['              Proficiency                                Martial       Focus     Unarmored', '      Level     Bonus     Class Features                   Arts         Points    Movement'],
      (lv) => `Feature ${lv}                 1d${lv < 5 ? 6 : 8}          ${lv === 1 ? '—' : lv}          ${lv === 1 ? '—' : '+10 ft.'}`,
    );
    const t = parseClassTable([monkish], 'monk');
    expect(t.columns['unarmored-movement']!.slice(0, 3)).toEqual([0, 10, 10]);
    expect(t.columns['martial-arts']!.slice(3, 5)).toEqual([6, 8]);
    expect(t.units).toEqual({ 'martial-arts': 'die', 'unarmored-movement': 'feet', 'proficiency-bonus': 'bonus' });
  });

  it('fails loudly on a short table, a bad cell or a header that lacks a column', () => {
    const short = fighterish.split('\n').filter((l) => !/^\s+20\s/.test(l)).join('\n');
    expect(() => parseClassTable([short], 'fighter')).toThrow(/19 rows|table ends/);
    expect(() => parseClassTable([fighterish.replace('Wind ', 'Breath ')], 'fighter')).toThrow(/header lacks Wind/);
    expect(() => parseClassTable([fighterish.replace(/ 4\s*$/m, ' x')], 'fighter')).toThrow(/weapon-mastery has "x"/);
    expect(() => parseClassTable([fighterish], 'monk')).toThrow(/no "Monk Features"/);
  });

  it('splits a features cell', () => {
    expect(splitFeatures('—', 9)).toEqual({ features: [], subclass: false });
    expect(splitFeatures('Mystic Arcanum (level 6 spell)', 11).features).toEqual([{ level: 11, name: 'Mystic Arcanum', detail: 'level 6 spell' }]);
  });
});

describe('chapter headings', () => {
  it('assigns Level N headings to the class, then to its subclass (wrapped title)', () => {
    const lines = parseBboxLayout(
      bbox([
        [L(133, 35, H1, 'Classes'), L(63, 60, H2, 'Monk'), L(313.5, 100, H3, 'Monk Class Features'), L(313.5, 130, H4, 'Level 1: Alpha Strike'), L(313.5, 160, BODY, 'body text')],
        [L(63, 40, H5, 'Level 1 Monk Spells'), L(63, 80, H4, 'Level 2: Beta Step'), L(313.5, 100, H3, 'Monk Subclass: Warden of the'), L(313.5, 114, H3, 'Quiet Way'), L(313.5, 140, H4, 'Level 3: Gamma Hold')],
        [L(63, 60, H2, 'Rogue'), L(63, 90, H4, 'Level 1: Delta Trick'), L(150, 400, H1, 'Character Origins'), L(63, 450, H4, 'Level 9: Not A Feature')],
      ]),
    );
    const h = parseChapterHeadings(lines);
    expect(h.classFeatures.monk).toEqual([
      { level: 1, name: 'Alpha Strike', page: 1 },
      { level: 2, name: 'Beta Step', page: 2 },
    ]);
    expect(h.subclasses).toEqual([{ id: 'warden-of-the-quiet-way', class: 'monk', name: 'Warden of the Quiet Way', page: 2, features: [{ level: 3, name: 'Gamma Hold', page: 2 }] }]);
    expect(h.classFeatures.rogue).toEqual([{ level: 1, name: 'Delta Trick', page: 3 }]);
    expect(h.chapters.monk).toEqual({ first: 1, last: 2 });
  });
});

describe('spells', () => {
  const lines = parseBboxLayout(
    bbox([
      [
        L(63, 100, H4, 'Test Bolt'),
        L(63, 114, SUB, 'Level 3 Evocation (Wizard, Cleric,'),
        L(63, 127, SUB, 'Druid)'),
        L(63, 140, BODY, 'Casting Time: Action'),
        L(63, 700, H4, 'Split Name'),
        L(313.5, 40, SUB, 'Conjuration Cantrip (Sorcerer)'),
      ],
      [L(63, 40, H4, 'Long Spell'), L(63, 54, H4, 'Name Here'), L(63, 68, SUB, 'Level 9 Illusion (Bard)')],
    ]),
  );

  it('reads name, level, school and class list; names come from the line before, even across columns', () => {
    expect(parseSpellHeaders(lines)).toEqual([
      { name: 'Test Bolt', level: 3, school: 'Evocation', classes: ['cleric', 'druid', 'wizard'], page: 1 },
      { name: 'Split Name', level: 0, school: 'Conjuration', classes: ['sorcerer'], page: 1 },
      { name: 'Long Spell Name Here', level: 9, school: 'Illusion', classes: ['bard'], page: 2 },
    ]);
  });

  it('refuses a header without a name or with an unknown class', () => {
    expect(() => parseSpellHeaders(parseBboxLayout(bbox([[L(63, 40, BODY, 'prose'), L(63, 60, SUB, 'Level 1 Abjuration (Wizard)')]])))).toThrow(/no h4 name/);
    expect(() => parseSpellHeaders(parseBboxLayout(bbox([[L(63, 40, H4, 'X'), L(63, 54, SUB, 'Level 1 Abjuration (Artificer)')]])))).toThrow(/unknown class "artificer"/);
  });

  it('reads class spell list tables across columns, and the cross-check reports known gaps only', () => {
    const t = parseSpellListTables(
      parseBboxLayout(
        bbox([
          [L(63, 40, H5, 'Cantrips (Level 0 Wizard Spells)'), L(67, 55, 11.0, 'Spell'), L(66.6, 70, CELL, 'Split Name'), L(189, 70, 11.0, 'Conjuration'), L(63, 100, H5, 'Level 3 Wizard Spells'), L(66.6, 120, CELL, 'Test Bolt'), L(317.1, 40, CELL, 'Phantasmal Force')],
          [L(63, 40, H3, 'Wizard Subclass: X'), L(66.6, 80, CELL, 'Stray Cell')],
        ]),
      ),
    );
    expect(t.map((e) => `${e.class}|${e.level}|${e.name}`)).toEqual(['wizard|0|Split Name', 'wizard|3|Test Bolt', 'wizard|3|Phantasmal Force']);
    const spells = [
      { name: 'Split Name', level: 0, school: 'Conjuration', classes: ['wizard' as const], page: 1 },
      { name: 'Test Bolt', level: 3, school: 'Evocation', classes: ['wizard' as const], page: 1 },
    ];
    const r = crossCheckSpellLists(spells, t);
    expect(r.problems.some((p) => p.includes('wizard|3|Phantasmal Force, the spell headers don'))).toBe(true);
    const r2 = crossCheckSpellLists([...spells, { name: 'Phantasmal Force', level: 2, school: 'Illusion', classes: ['wizard'], page: 1 }], t.slice(0, 2));
    expect(r2.gaps).toEqual([{ class: 'wizard', level: 2, name: 'Phantasmal Force' }]);
    expect(r2.problems.filter((p) => !p.startsWith('known spell list gap'))).toEqual([]);
  });
});

describe('origins', () => {
  it('takes only headings followed by their marker line', () => {
    const o = parseOrigins(
      parseBboxLayout(
        bbox([
          [
            L(63, 40, H2, 'Character Backgrounds'),
            L(63, 60, H4, 'Equipment'),
            L(63, 80, H3, 'Background Descriptions'),
            L(63, 100, H4, 'Farmer'),
            L(63, 115, 11.9, 'Ability Scores: Strength, Constitution, Wisdom'),
            L(313.5, 40, H2, 'Character Species'),
            L(313.5, 60, H4, 'Size'),
            L(313.5, 80, H3, 'Species Descriptions'),
            L(313.5, 100, H4, 'Gnoll'),
            L(313.5, 115, 11.9, 'Creature Type: Humanoid'),
          ],
          [L(140, 35, H1, 'Feats'), L(63, 60, H4, 'Lucky Find'), L(63, 74, SUB, 'Origin Feat'), L(63, 120, H4, 'Heavy Hitter'), L(63, 134, SUB, 'General Feat (Prerequisite: Level 4+)'), L(63, 200, H4, 'Not A Feat'), L(63, 214, BODY, 'prose')],
        ]),
      ),
    );
    expect(o.backgrounds).toEqual([{ name: 'Farmer', page: 1 }]);
    expect(o.species).toEqual([{ name: 'Gnoll', page: 1 }]);
    expect(o.feats).toEqual([
      { name: 'Lucky Find', category: 'origin', page: 2 },
      { name: 'Heavy Hitter', category: 'general', page: 2 },
    ]);
  });
});

describe('hit points', () => {
  it('reads a wrapped class-list cell and every class once', () => {
    const lines = parseBboxLayout(
      bbox([
        [
          L(313.5, 175, H5, 'Level 1 Hit Points by Class'),
          L(317.5, 190, 11.0, 'Class'),
          L(453, 190, 11.3, 'Hit Point Maximum'),
          L(317.1, 205, 11.0, 'Barbarian'),
          L(461.6, 205, 11.0, '12 + Con. modifier'),
          L(317.1, 220, 11.0, 'Fighter, Paladin, or Ranger'),
          L(461.4, 220, 11.0, '10 + Con. modifier'),
          L(317.1, 236, 11.0, 'Bard, Cleric, Druid, Monk,'),
          L(317.1, 248.6, 11.0, 'Rogue, or Warlock'),
          L(465.8, 236, 11.0, '8 + Con. modifier'),
          L(317.1, 263, 11.0, 'Sorcerer or Wizard'),
          L(465.8, 263, 11.0, '6 + Con. modifier'),
          L(313.5, 283, BODY, 'The character sheet includes'),
        ],
      ]),
    );
    const t = parseHpTable(lines, 'Level 1 Hit Points by Class');
    expect(t.page).toBe(1);
    expect(t.values).toEqual({ barbarian: 12, fighter: 10, paladin: 10, ranger: 10, bard: 8, cleric: 8, druid: 8, monk: 8, rogue: 8, warlock: 8, sorcerer: 6, wizard: 6 });
    expect(() => parseHpTable(lines.filter((l) => !l.text.startsWith('Sorcerer')), 'Level 1 Hit Points by Class')).toThrow(/no value for sorcerer, wizard/);
  });

  it('reads the Hit Point Die row of each class', () => {
    const pages = ['x'.repeat(3), ...['Barbarian', 'Bard', 'Cleric', 'Druid', 'Fighter', 'Monk', 'Paladin', 'Ranger', 'Rogue', 'Sorcerer', 'Warlock', 'Wizard'].map((c) => `     Hit Point Die            D8 per ${c} level      other column`)];
    expect(parseHitDice(pages).monk).toEqual({ die: 8, page: 7 });
    expect(() => parseHitDice(pages.slice(0, 3))).toThrow(/no Hit Point Die row for cleric/);
  });
});

describe('equipment', () => {
  const page = [
    '     Weapons',
    '     Name               Damage            Properties                                          Mastery   Weight      Cost',
    '     Simple Melee Weapons',
    '      Stick             1d4 Bludgeoning   Light                                               Slow         2 lb.     1 SP',
    '     Martial Ranged Weapons',
    '      Tube              1 Piercing        Ammunition (Range 25/100; Needle), Loading          Vex          1 lb.    10 GP',
    '      Big Crossbow 1d10 Piercing          Ammunition (Range 100/400; Bolt), Heavy, Loading,   Push        18 lb.    50 GP',
    '                                          Two-Handed',
    '',
    '     Armor',
    '     Armor                             Armor Class (AC)            Strength        Stealth           Weight         Cost',
    '     Medium Armor (5 Minutes to Don and 1 Minute to Doff)',
    '       Bark Armor                      13 + Dex modifier (max 2)   —               Disadvantage        20 lb.      50 GP',
    '     Heavy Armor (10 Minutes to Don and 5 Minutes to Doff)',
    '       Iron Suit                       17                          Str 15          Disadvantage        60 lb.     200 GP',
    '     Shield (Utilize Action to Don or Doff)',
    '       Buckler                         +2                          —               —                     6 lb.     10 GP',
    '',
  ].join('\n');

  it('reads weapon rows with their Properties cells, a wrapped cell joined to its row (M3 step 5b)', () => {
    expect(parseWeapons(['', page])).toEqual([
      { name: 'Stick', category: 'simple-melee', damage: '1d4', damageType: 'bludgeoning', mastery: 'slow', properties: ['light'], page: 2 },
      { name: 'Tube', category: 'martial-ranged', damage: '1', damageType: 'piercing', mastery: 'vex', properties: ['ammunition', 'loading'], range: [25, 100], ammunition: 'needle', page: 2 },
      { name: 'Big Crossbow', category: 'martial-ranged', damage: '1d10', damageType: 'piercing', mastery: 'push', properties: ['ammunition', 'heavy', 'loading', 'two-handed'], range: [100, 400], ammunition: 'bolt', page: 2 },
    ]);
  });

  it('a Properties cell: Thrown and Ammunition ranges, the Versatile die, "unless mounted", and a closed list', () => {
    expect(parseWeaponProperties('Thrown (Range 20/60), Versatile (1d8)', 'x')).toEqual({ properties: ['thrown', 'versatile'], range: [20, 60], versatile: '1d8' });
    expect(parseWeaponProperties('Heavy, Reach, Two-Handed (unless mounted)', 'x')).toEqual({ properties: ['heavy', 'reach', 'two-handed'] });
    expect(parseWeaponProperties('—', 'x')).toEqual({ properties: [] });
    expect(() => parseWeaponProperties('Silvered', 'x')).toThrow(/closed list/);
    expect(() => parseWeaponProperties('Versatile', 'x')).toThrow(/Versatile needs its die/);
    expect(() => parseWeaponProperties('Ammunition (Range 80/320)', 'x')).toThrow(/Range N\/M; Kind/);
    expect(() => parseWeaponProperties('Light, Light', 'x')).toThrow(/listed twice/);
  });

  it('reads armor rows', () => {
    expect(parseArmor([page])).toEqual([
      { name: 'Bark Armor', category: 'medium', ac: 13, addDex: true, dexMax: 2, stealthDisadvantage: true, page: 1 },
      { name: 'Iron Suit', category: 'heavy', ac: 17, addDex: false, strength: 15, stealthDisadvantage: true, page: 1 },
      { name: 'Buckler', category: 'shield', ac: 2, addDex: false, stealthDisadvantage: false, page: 1 },
    ]);
  });

  it('refuses a row it cannot read', () => {
    expect(() => parseWeapons([page.replace('Slow         2 lb.', 'Wobble       2 lb.')])).toThrow(/unparsed line "Stick/);
  });
});
