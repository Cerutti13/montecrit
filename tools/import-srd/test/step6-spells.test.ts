// M3 step 6: the spell importer (docs/design/m3.md 2.7, 4.3-4.7, C2, C4, C5, C7). Synthetic
// Foundry-shaped spell records for each mapping branch, the PDF stat-line and description-token
// parsers, the C7 header comparison, the 5e-bits and Open5e votes, the hand-line rule in
// import:verify, and two checks on the committed pack: the six hand-written spells compile
// byte-identically from their replace: true overrides, and no spell outside the 339 PDF headers
// is emitted. No cache, no network, no home dir.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { loadContent } from '../../../packages/engine/src/content/load.ts';
import { formatDiag } from '../../../packages/engine/src/content/yaml.ts';
import { canonicalJson } from '../../../packages/engine/src/util/canon.ts';
import { hash64 } from '../../../packages/engine/src/util/hash.ts';
import { classify } from '../classify.ts';
import { asToken, bitsTokens, crosscheckSpells, foundryTokens } from '../crosscheck-spells.ts';
import { crosscheckMonsters, notAvailable, open5eSpells, open5eSpellTokens, readOpen5e } from '../crosscheck-open5e.ts';
import { filterRecords, indexFromTuples, loadSrdIndex } from '../filter.ts';
import { buildImport } from '../main.ts';
import { baseCount, CONDITION_READINGS, foundryHeader, headerDiffs, inherited, partOf, pdfHeader, SAVE_IGNORES_COVER, SPELL_PARTS } from '../map/spell.ts';
import { convertFormula } from '../formula.ts';
import { loadOverrides } from '../overrides.ts';
import type { SrdIndex } from '../pdf/build.ts';
import { joinBody, parseFacts, parseStat, type SpellDetail } from '../pdf/spell-details.ts';
import { loadPins, type Pins } from '../pins.ts';
import type { FoundryRecord } from '../read.ts';
import { isTemplateLine, U } from '../unimplemented.ts';
import { verifyRepo } from '../verify.ts';
import { REPO_ROOT, sha256 } from '../util.ts';

type Rec = Record<string, unknown>;
const PINS = loadPins();

// ---- synthetic inputs -------------------------------------------------------------------

/** A PDF spell as srd-index.json carries it: header + details from stat lines and a description. */
function pdfSpell(name: string, level: number, stat: string, body: string, page = 200): { header: SrdIndex['spells'][number]; detail: SpellDetail } {
  return {
    header: { name, level, school: 'Evocation', classes: ['wizard'], page },
    detail: { name, page, stat: parseStat(stat), facts: parseFacts(body) },
  };
}

const ACTION_120 = 'Casting Time: Action Range: 120 feet Components: V, S Duration: Instantaneous';

/** A Foundry spells24 record (only the fields the mapper reads). */
function fSpell(name: string, system: Rec, effects: Rec[] = []): FoundryRecord {
  const doc: Rec = {
    _id: `test${name.replace(/\W/g, '')}`.slice(0, 16),
    name,
    type: 'spell',
    effects,
    system: {
      source: { license: 'CC-BY-4.0', book: '', rules: '2024' },
      activation: { type: 'action', value: null },
      range: { value: '120', units: 'ft' },
      duration: { value: '', units: 'inst' },
      target: { affects: { count: '', type: 'creature' }, template: { type: '' } },
      properties: ['vocal', 'somatic'],
      level: 1,
      school: 'evo',
      ...system,
    },
  };
  return { pack: 'spells24', path: `packs/_source/spells24/test/${name.toLowerCase().replace(/\W+/g, '-')}.yml`, sha256: 'a'.repeat(64), id: doc._id as string, name, type: 'spell', doc };
}

const act = (type: string, extra: Rec = {}): Rec => ({ type, activation: { type: 'action', override: false }, range: { override: false }, target: { override: false }, duration: { override: false }, effects: [], ...extra });
const part = (number: number, denomination: number, type: string, scaling: Rec = { mode: 'whole', number: 1 }, bonus = ''): Rec => ({ number, denomination, bonus, types: [type], custom: { enabled: false, formula: '' }, scaling });

/** Runs the importer's pure core over the given spells; returns emitted spell items by id and the skips. */
function run(spells: { rec: FoundryRecord; pdf: ReturnType<typeof pdfSpell> }[]) {
  const pdfIndex = { spells: spells.map((s) => s.pdf.header), spellDetails: spells.map((s) => s.pdf.detail), classes: {}, subclasses: {} } as unknown as SrdIndex;
  const out = buildImport({
    records: spells.map((s) => s.rec),
    index: indexFromTuples({ spell: spells.map((s) => [s.pdf.header.name]) }),
    overrides: [],
    pins: PINS,
    srdIndexSha256: 'b'.repeat(64),
    scope: ['spell'],
    pdfIndex,
  });
  const items = new Map<string, Rec>();
  for (const [p, t] of out.plan) if (p.includes('/spells/')) {
    const d = parse(t) as Rec;
    items.set(d.id as string, d);
  }
  return { items, skips: out.skips };
}

// ---- the PDF parsers ----------------------------------------------------------------------

describe('pdf/spell-details.ts: stat lines and description tokens', () => {
  it('reads casting time, ritual, range, components (a priced material), duration and concentration', () => {
    const s = parseStat('Casting Time: 1 minute or Ritual Range: Touch Components: V, S, M (a gem worth 50+ GP, which the spell consumes) Duration: Concentration, up to 10 minutes');
    expect(s).toEqual({
      castingTime: { unit: 'minute', n: 1 },
      ritual: true,
      range: { unit: 'touch' },
      components: { v: true, s: true, m: true, cost: true, consumed: true },
      duration: { unit: 'minute', n: 10, upTo: true },
      concentration: true,
    });
    expect(parseStat('Casting Time: Reaction, which you take when hit Range: Self Component: V Duration: 1 round').castingTime.unit).toBe('reaction');
    expect(parseStat('Casting Time: Bonus Action Range: 60 feet Components: V Duration: Concentration up to 1 minute').concentration).toBe(true);
    expect(() => parseStat('Casting Time: Action Range: 120 feet Components: V, S')).toThrow(/Duration/);
  });
  it('reads dice with damage types, saves, attack kind, heals, upgrades, areas, conditions and the turn-end repeat save', () => {
    const f = parseFacts(
      joinBody([
        'Each creature in a 20-foot-radius Sphere makes a Dexterity saving throw, taking 8d6 Fire damage. Make a ranged spell attack; a hit deals 2d8 + 4 Cold damage. It regains Hit Points equal to 2d4.',
        'It has the Paralyzed condition. At the end of each of its turns, the target repeats the save. Using a Higher-Level Spell Slot. The damage increases by 1d6 for each spell slot level above 3.',
        'A 10-foot-radius, 40-foot-high Cylinder; a 15-foot Cone; a 30-foot-tall, 5-foot-radius Cylinder. Cantrip Upgrade. The damage increases by 1d6 when you reach levels 5 (2d6), 11 (3d6), and 17 (4d6).',
      ]),
    );
    expect(f.damage).toEqual([
      { dice: '8d6', type: 'fire' },
      { dice: '2d8 + 4', type: 'cold' },
    ]);
    expect(f.saves).toEqual(['dex']);
    expect(f.attack).toEqual(['ranged']);
    expect(f.heal).toEqual(['2d4']);
    expect(f.upcast).toEqual(['1d6']);
    expect(f.cantripUpgrade).toEqual(['2d6', '3d6', '4d6']);
    expect(f.areas).toEqual([
      { shape: 'sphere', ft: 20 },
      { shape: 'cylinder', ft: 10, height: 40 },
      { shape: 'cone', ft: 15 },
      { shape: 'cylinder', ft: 5, height: 30 },
    ]);
    expect(f.conditions).toEqual(['paralyzed']);
    expect(f.repeatSaveTurnEnd).toBe(true);
    expect([f.cantripUpgradeLine, f.higherLevelLine]).toEqual([true, true]);
  });
  it('joinBody undoes end-of-line hyphenation only before a lower-case letter', () => {
    expect(joinBody(['it can’t re-', 'gain Hit', 'Points; Fire-', 'Bolt'])).toBe("it can't regain Hit Points; Fire- Bolt");
  });
  it('counted projectiles mark several attacks; "creature of your choice" and "willing creature" are read', () => {
    expect(parseFacts('You hurl three fiery rays.').multiAttack).toBe(true);
    expect(parseFacts('Two beams of light streak out.').multiAttack).toBe(true);
    expect(parseFacts('A ray of light.').multiAttack).toBe(false);
    expect(parseFacts('A creature of your choice within range').ofYourChoice).toBe(true);
    expect(parseFacts('You touch a willing creature').willing).toBe(true);
  });
  it('"half as much damage" (and "half the initial damage") marks a save that halves; its absence does not', () => {
    expect(parseFacts('taking 8d6 Fire damage on a failed save or half as much damage on a successful one.').half).toBe(true);
    expect(parseFacts('On a successful save, a creature takes half the initial damage only.').half).toBe(true);
    expect(parseFacts('The target must succeed on a Dexterity saving throw or take 1d8 Radiant damage.').half).toBe(false);
  });
});

// ---- the mapper, branch by branch -----------------------------------------------------------

describe('map/spell.ts: Foundry records to spell items, checked against the PDF tokens', () => {
  it('a ranged spell-attack cantrip: target, attack, cantrip-scaled damage; partial until reviewed (C7)', () => {
    const r = fSpell('Test Mote', { level: 0, activities: { a: act('attack', { attack: { type: { value: 'ranged' } }, damage: { parts: [part(1, 10, 'fire')] } }) } });
    const p = pdfSpell('Test Mote', 0, ACTION_120, 'Make a ranged spell attack. On a hit, it takes 1d10 Fire damage. Cantrip Upgrade. The damage increases by 1d10 when you reach levels 5 (2d10), 11 (3d10), and 17 (4d10).');
    const it = run([{ rec: r, pdf: p }]).items.get('srd:test-mote')!;
    expect(it.do).toEqual([{ target: { range: 120, self: 'no' } }, { attack: { kind: 'ranged', range: 120, onHit: [{ damage: [{ roll: '1d10', type: 'fire', cantrip: true }] }] } }]);
    expect(it.source).toBe('SRD 5.2.1 p.200');
    expect(it.fidelity).toBe('partial');
    expect(it.unimplemented).toEqual([U.bucketHeuristic()]);
  });
  it('a single-target save with half damage and whole upcast scaling', () => {
    const r = fSpell('Test Blast', { activities: { a: act('save', { save: { ability: ['con'], dc: { calculation: 'spellcasting' } }, damage: { onSave: 'half', parts: [part(2, 10, 'necrotic')] } }) } });
    const p = pdfSpell('Test Blast', 1, ACTION_120, 'The target makes a Constitution saving throw, taking 2d10 Necrotic damage on a failed save or half as much damage on a successful one. Using a Higher-Level Spell Slot. The damage increases by 1d10 for each spell slot level above 1.');
    const it = run([{ rec: r, pdf: p }]).items.get('srd:test-blast')!;
    expect(it.do).toEqual([{ target: { range: 120, self: 'no' } }, { save: { ability: 'con', half: true, damage: [{ roll: '2d10', type: 'necrotic', upcast: '1d10' }] } }]);
  });
  it('a save with no half on a success (onSave none, and the PDF says nothing of half) has no half key', () => {
    const r = fSpell('Test Sting', { activities: { a: act('save', { save: { ability: ['dex'], dc: { calculation: 'spellcasting' } }, damage: { onSave: 'none', parts: [part(1, 8, 'radiant', { mode: '' })] } }) } });
    const p = pdfSpell('Test Sting', 1, ACTION_120, 'The target must succeed on a Dexterity saving throw or take 1d8 Radiant damage.');
    const it = run([{ rec: r, pdf: p }]).items.get('srd:test-sting')!;
    expect(it.do).toEqual([{ target: { range: 120, self: 'no' } }, { save: { ability: 'dex', damage: [{ roll: '1d8', type: 'radiant' }] } }]);
  });
  it('half on a success must agree with the PDF both ways: Foundry half where the text has none, or none where it says half, is skipped', () => {
    const halfRec = fSpell('Test Halfway', { activities: { a: act('save', { save: { ability: ['dex'], dc: { calculation: 'spellcasting' } }, damage: { onSave: 'half', parts: [part(1, 8, 'radiant', { mode: '' })] } }) } });
    const noneRec = fSpell('Test Noway', { activities: { a: act('save', { save: { ability: ['dex'], dc: { calculation: 'spellcasting' } }, damage: { onSave: 'none', parts: [part(1, 8, 'radiant', { mode: '' })] } }) } });
    const out = run([
      { rec: halfRec, pdf: pdfSpell('Test Halfway', 1, ACTION_120, 'The target must succeed on a Dexterity saving throw or take 1d8 Radiant damage.') },
      { rec: noneRec, pdf: pdfSpell('Test Noway', 1, ACTION_120, 'A Dexterity saving throw, taking 1d8 Radiant damage on a failed save or half as much damage on a successful one.') },
    ]);
    expect(out.items.size).toBe(0);
    expect(out.skips.map((x) => [x.path.split('/').pop(), x.reason, x.detail]).sort()).toEqual([
      ['test-halfway.yml', 'pdf-text-disagrees', 'save-half'],
      ['test-noway.yml', 'pdf-text-disagrees', 'save-half'],
    ]);
  });
  it('a Foundry upcast step the PDF\'s "Using a Higher-Level Spell Slot" dice don\'t print is skipped, not emitted with Foundry\'s step', () => {
    const r = fSpell('Test Overcast', { activities: { a: act('save', { save: { ability: ['con'], dc: { calculation: 'spellcasting' } }, damage: { onSave: 'half', parts: [part(2, 10, 'necrotic', { mode: 'whole', number: 2 })] } }) } });
    const p = pdfSpell('Test Overcast', 1, ACTION_120, 'The target makes a Constitution saving throw, taking 2d10 Necrotic damage, or half as much damage on a successful one. Using a Higher-Level Spell Slot. The damage increases by 1d10 for each spell slot level above 1.');
    const out = run([{ rec: r, pdf: p }]);
    expect(out.items.size).toBe(0);
    expect(out.skips).toEqual([{ kind: 'spell', path: r.path, reason: 'pdf-text-disagrees', detail: 'damage' }]);
  });
  it('a cantrip whose Foundry scaling fits our tier rule but whose PDF "Cantrip Upgrade." prints other dice is skipped', () => {
    const r = fSpell('Test Spark', { level: 0, activities: { a: act('attack', { attack: { type: { value: 'ranged' } }, damage: { parts: [part(1, 10, 'fire')] } }) } });
    const p = pdfSpell('Test Spark', 0, ACTION_120, 'Make a ranged spell attack. On a hit, it takes 1d10 Fire damage. Cantrip Upgrade. The damage increases when you reach levels 5 (2d8), 11 (3d8), and 17 (4d8).');
    const out = run([{ rec: r, pdf: p }]);
    expect(out.items.size).toBe(0);
    expect(out.skips).toEqual([{ kind: 'spell', path: r.path, reason: 'pdf-text-disagrees', detail: 'damage' }]);
  });
  it('"each creature of your choice in" a zone: the zone has no side filter, so the choice is a line (Weird, srd-raw.txt:32249)', () => {
    const sphere = (name: string) => fSpell(name, {
      level: 3,
      target: { affects: { type: 'creature' }, template: { type: 'sphere', size: '20' } },
      activities: { a: act('save', { save: { ability: 'wis', dc: { calculation: 'spellcasting' } }, damage: { onSave: 'half', parts: [part(4, 10, 'psychic', { mode: '' })] } }) },
    });
    const chosen = run([{ rec: sphere('Test Dread'), pdf: pdfSpell('Test Dread', 3, ACTION_120, 'Each creature of your choice in a 20-foot-radius Sphere makes a Wisdom saving throw, taking 4d10 Psychic damage on a failed save or half as much damage on a successful one.') }]).items.get('srd:test-dread')!;
    expect(chosen.unimplemented).toContain(U.part('creatures-of-your-choice'));
    const all = run([{ rec: sphere('Test Gloom'), pdf: pdfSpell('Test Gloom', 3, ACTION_120, 'Each creature in a 20-foot-radius Sphere makes a Wisdom saving throw, taking 4d10 Psychic damage on a failed save or half as much damage on a successful one.') }]).items.get('srd:test-gloom')!;
    expect(all.unimplemented).not.toContain(U.part('creatures-of-your-choice'));
  });
  it('an instantaneous sphere: a zone placed at a point that saves when it appears and lasts one round', () => {
    const r = fSpell('Test Burst', {
      level: 3,
      target: { affects: { type: 'creature' }, template: { type: 'sphere', size: '20' } },
      activities: { a: act('save', { save: { ability: 'dex', dc: { calculation: 'spellcasting' } }, damage: { onSave: 'half', parts: [part(8, 6, 'fire')] } }) },
    });
    const p = pdfSpell('Test Burst', 3, ACTION_120, 'Each creature in a 20-foot-radius Sphere makes a Dexterity saving throw, taking 8d6 Fire damage on a failed save or half as much damage on a successful one. Using a Higher-Level Spell Slot. The damage increases by 1d6 for each spell slot level above 3.');
    const it = run([{ rec: r, pdf: p }]).items.get('srd:test-burst')!;
    expect(it.area).toBe('area');
    expect(it.do).toEqual([{ apply: { effect: 'area', to: 'point' } }]);
    expect(it.effects).toEqual([
      { id: 'area', name: 'Test Burst', zone: { shape: 'sphere', radius: 20 }, duration: { rounds: 1 }, on: [{ when: ['appear'], do: [{ save: { ability: 'dex', half: true, damage: [{ roll: '8d6', type: 'fire', upcast: '1d6' }] } }] }] },
    ]);
    expect(it.unimplemented).toContain(U.shapeReview());
  });
  it('a concentration sphere with difficult terrain: the zone ends with the spell and is Difficult Terrain; trigger words stay lines', () => {
    const r = fSpell(
      'Test Swarm',
      {
        level: 5,
        duration: { value: '10', units: 'minute' },
        properties: ['vocal', 'somatic', 'concentration'],
        target: { affects: { type: 'creature' }, template: { type: 'sphere', size: '20' } },
        activities: { a: act('save', { save: { ability: 'con', dc: { calculation: 'spellcasting' } }, damage: { onSave: 'half', parts: [part(4, 10, 'piercing', { mode: '' })] }, behaviors: [{ type: 'difficultTerrain' }] }) },
      },
    );
    const p = pdfSpell('Test Swarm', 5, 'Casting Time: Action Range: 120 feet Components: V, S Duration: Concentration, up to 10 minutes', 'A 20-foot-radius Sphere; each creature makes a Constitution saving throw, taking 4d10 Piercing damage on a failed save or half as much damage on a successful one.');
    const it = run([{ rec: r, pdf: p }]).items.get('srd:test-swarm')!;
    const fx = (it.effects as Rec[])[0]!;
    expect(fx.zone).toEqual({ shape: 'sphere', radius: 20, difficult: true });
    expect(fx.duration).toBeUndefined();
    expect(it.concentration).toBe(true);
    expect(it.duration).toEqual({ minutes: 10 });
  });
  it('a touch heal with the spellcasting modifier and upcast; "a creature you touch" leaves self-targeting to the flag', () => {
    const r = fSpell('Test Mend', { range: { units: 'touch' }, activities: { a: act('heal', { healing: { ...part(2, 8, 'healing', { mode: 'whole', number: 2 }, '@mod'), types: ['healing'] } }) } });
    const p = pdfSpell('Test Mend', 1, 'Casting Time: Action Range: Touch Components: V, S Duration: Instantaneous', 'A creature you touch regains a number of Hit Points equal to 2d8 plus your modifier. Using a Higher-Level Spell Slot. The healing increases by 2d8 for each spell slot level above 1.');
    const it = run([{ rec: r, pdf: p }]).items.get('srd:test-mend')!;
    expect(it.do).toEqual([{ target: { range: 'touch', self: 'textSilent' } }, { heal: { roll: '2d8 + @mod', upcast: '2d8' } }]);
  });
  it('a buff whose change maps (ac.bonus): an effect with a stat, applied to "a creature of your choice" (self allowed)', () => {
    const r = fSpell(
      'Test Ward',
      { activation: { type: 'bonus' }, properties: ['vocal', 'somatic', 'concentration'], duration: { value: '10', units: 'minute' }, activities: { a: act('utility', { activation: { type: 'bonus', override: false } }) } },
      [{ _id: 'e1', transfer: false, statuses: [], system: { changes: [{ key: 'system.attributes.ac.bonus', type: 'add', value: 2 }] } }],
    );
    const p = pdfSpell('Test Ward', 1, 'Casting Time: Bonus Action Range: 60 feet Components: V, S Duration: Concentration, up to 10 minutes', 'A creature of your choice within range gets +2 AC.');
    const it = run([{ rec: r, pdf: p }]).items.get('srd:test-ward')!;
    expect(it.effects).toEqual([{ id: 'buff', name: 'Test Ward', stats: [{ ac: 2 }] }]);
    expect(it.do).toEqual([{ target: { range: 60, self: 'yes' } }, { apply: { effect: 'buff', to: 'target' } }]);
    expect(it.unimplemented).not.toContain(U.activityType('utility'));
  });
  it('a reviewed condition reading: Paralyzed until the spell ends with the turn-end repeat save; the trigger line is dropped as modeled', () => {
    expect(Object.keys(CONDITION_READINGS).sort()).toEqual(['srd:hold-monster', 'srd:hold-person']);
    const r = fSpell(
      'Hold Monster',
      {
        level: 5,
        range: { value: '90', units: 'ft' },
        duration: { value: '1', units: 'minute' },
        properties: ['vocal', 'somatic', 'concentration'],
        description: { value: 'At the end of each of its turns, the target repeats the save.' },
        activities: { a: act('save', { save: { ability: 'wis', dc: { calculation: 'spellcasting' } }, damage: { parts: [] }, effects: [{ _id: 'p', onSave: false }] }) },
      },
      [{ _id: 'p', statuses: ['paralyzed'], system: { changes: [] } }],
    );
    const p = pdfSpell('Hold Monster', 5, 'Casting Time: Action Range: 90 feet Components: V, S Duration: Concentration, up to 1 minute', 'The target must succeed on a Wisdom saving throw or have the Paralyzed condition. At the end of each of its turns, the target repeats the save.');
    const it = run([{ rec: r, pdf: p }]).items.get('srd:hold-monster')!;
    expect(it.do).toEqual([{ target: { range: 90, self: 'no' } }, { save: { ability: 'wis', onFail: [{ condition: { id: 'paralyzed', until: 'parent', save: { ability: 'wis', at: 'turnEnd' } } }] } }]);
    expect(it.unimplemented).toContain(U.part('spell-ends-on-save'));
    expect((it.unimplemented as string[]).some((l) => l.startsWith('trigger: "repeat the save"'))).toBe(false);
  });
  it('a status with no reviewed reading is a line, not a condition; a save that then does nothing is not emitted', () => {
    const r = fSpell(
      'Test Charm',
      { activities: { a: act('save', { save: { ability: 'wis', dc: { calculation: 'spellcasting' } }, damage: { parts: [] }, effects: [{ _id: 'c', onSave: false }] }) } },
      [{ _id: 'c', statuses: ['charmed'], system: { changes: [] } }],
    );
    const p = pdfSpell('Test Charm', 1, ACTION_120, 'A Wisdom saving throw or have the Charmed condition.');
    const out = run([{ rec: r, pdf: p }]);
    expect(out.items.size).toBe(0);
    expect(out.skips).toEqual([{ kind: 'spell', path: r.path, reason: 'no-program', detail: 'save-without-effect' }]);
  });
  it('skips what the spell schema can not carry, each with its closed reason', () => {
    const base = (name: string, sys: Rec, stat: string, body: string) => ({ rec: fSpell(name, { activities: { a: act('attack', { attack: { type: { value: 'ranged' } }, damage: { parts: [part(1, 10, 'fire', { mode: '' })] } }) }, ...sys }), pdf: pdfSpell(name, 1, stat, body) });
    const BODY = 'Make a ranged spell attack, 1d10 Fire damage.';
    const out = run([
      base('Skip Reaction', { activation: { type: 'reaction' } }, 'Casting Time: Reaction, which you take when hit Range: 120 feet Components: V, S Duration: Instantaneous', BODY),
      base('Skip Costly', {}, 'Casting Time: Action Range: 120 feet Components: V, S, M (a pearl worth 100+ GP) Duration: Instantaneous', BODY),
      base('Skip Forever', {}, 'Casting Time: Action Range: 120 feet Components: V, S Duration: Until dispelled', BODY),
      base('Skip Miles', {}, 'Casting Time: Action Range: 1 mile Components: V, S Duration: Instantaneous', BODY),
      base('Skip Dice', {}, ACTION_120, 'Make a ranged spell attack, 2d10 Fire damage.'),
      base('Skip Rays', {}, ACTION_120, 'You hurl three fiery rays. Make a ranged spell attack, 1d10 Fire damage.'),
      {
        rec: fSpell('Skip Cube', { target: { affects: {}, template: { type: 'cube', size: '15' } }, activities: { a: act('save', { save: { ability: 'con' }, damage: { parts: [part(2, 8, 'thunder')] } }) } }),
        pdf: pdfSpell('Skip Cube', 1, ACTION_120, 'Each creature in a 15-foot Cube makes a Constitution saving throw, 2d8 Thunder damage.'),
      },
      {
        rec: fSpell('Skip Many', { target: { affects: { count: '3', type: 'creature' }, template: { type: '' } }, activities: { a: act('save', { save: { ability: 'con' }, damage: { parts: [part(2, 8, 'thunder')] } }) } }),
        pdf: pdfSpell('Skip Many', 1, ACTION_120, 'Up to three creatures make a Constitution saving throw, 2d8 Thunder damage.'),
      },
      {
        rec: fSpell('Skip Beams', { level: 0, activities: { a: act('attack', { attack: { type: { value: 'ranged' } }, damage: { parts: [part(1, 10, 'force', { mode: '' })] } }) } }),
        pdf: pdfSpell('Skip Beams', 0, ACTION_120, 'Make a ranged spell attack, 1d10 Force damage. Cantrip Upgrade. The spell creates more beams at higher levels.'),
      },
    ]);
    expect(out.items.size).toBe(0);
    expect(out.skips.map((s) => `${s.path.split('/').pop()} ${s.reason}`).sort(), JSON.stringify(out.skips)).toEqual([
      'skip-beams.yml pdf-text-disagrees',
      'skip-costly.yml costly-material',
      'skip-cube.yml area-shape',
      'skip-dice.yml pdf-text-disagrees',
      'skip-forever.yml duration',
      'skip-many.yml multiple-targets',
      'skip-miles.yml range',
      'skip-rays.yml multiple-targets',
      'skip-reaction.yml casting-time',
    ]);
  });
  it('activation inheritance (base-activity.mjs _setOverride): the item’s fields unless the activity overrides them', () => {
    const doc = { system: { activation: { type: 'action' }, range: { units: 'ft', value: '60' } } };
    expect(inherited(doc, { activation: { type: 'bonus', override: false } }, 'activation')).toEqual({ type: 'action' });
    expect(inherited(doc, { activation: { type: 'bonus', override: true } }, 'activation')).toEqual({ type: 'bonus', override: true });
    // A cast program plus a later-turn activity that overrides its activation: the later one is a line.
    const r = fSpell('Test Lance', {
      activities: {
        a: act('attack', { attack: { type: { value: 'ranged' } }, damage: { parts: [part(1, 10, 'fire', { mode: '' })] } }),
        b: act('attack', { activation: { type: 'bonus', override: true }, attack: { type: { value: 'ranged' } }, damage: { parts: [part(1, 10, 'fire', { mode: '' })] } }),
      },
    });
    const out = run([{ rec: r, pdf: pdfSpell('Test Lance', 1, ACTION_120, 'Make a ranged spell attack, 1d10 Fire damage.') }]);
    const it = out.items.get('srd:test-lance');
    if (!it) throw new Error(JSON.stringify(out.skips));
    expect(it.unimplemented).toContain(U.part('later-turn-activity'));
  });
  it('cantrip scaling: Foundry adds scaling.number dice per tier, ours multiplies the base; they agree only when the counts match', () => {
    expect(partOf(part(1, 10, 'fire'), 0, { formula: convertFormula }).part).toMatchObject({ roll: '1d10', cantrip: true });
    expect(partOf(part(2, 6, 'fire', { mode: 'whole', number: 1 }), 0, { formula: convertFormula }).lines).toEqual([U.part('cantrip-scaling')]);
    expect(partOf(part(2, 6, 'fire', { mode: 'whole', number: 1 }), 2, { formula: convertFormula }).part).toMatchObject({ upcast: '1d6' });
    expect(partOf(part(1, 6, 'fire', { mode: 'whole', formula: '1d8' }), 2, { formula: convertFormula }).lines).toEqual([U.part('custom-scaling-formula')]);
  });
  it('a target count over @item.level counts at the spell’s own level', () => {
    expect(baseCount('', 2)).toBe(1);
    expect(baseCount('@item.level - 1', 2)).toBe(1);
    expect(baseCount('@item.level', 1)).toBe(1);
    expect(baseCount('2 + @item.level', 1)).toBe(3);
    expect(baseCount('@scaling', 1)).toBeUndefined();
  });
  it('every SPELL_PARTS token makes a template line', () => {
    for (const parts of Object.values(SPELL_PARTS)) for (const t of parts) expect(isTemplateLine(U.part(t))).toBe(true);
  });
});

// ---- C7 ---------------------------------------------------------------------------------------

describe('C7: full needs the PDF header fields to agree, and the importer alone never makes a spell full', () => {
  it('Foundry and PDF header tokens compare field by field', () => {
    const doc = { system: { level: 2, activation: { type: 'action' }, range: { units: 'ft', value: '60' }, duration: { units: 'minute', value: '1' }, properties: ['vocal', 'somatic', 'concentration'] } };
    const pdf = pdfHeader(2, parseStat('Casting Time: Action Range: 60 feet Components: V, S, M (a pin) Duration: Concentration, up to 1 minute'));
    expect(headerDiffs(foundryHeader(doc), pdf)).toEqual(['components']);
  });
  it('headerDiffs reports each of the seven C7 fields on its own, from a pair that differs only there', () => {
    const p = pdfHeader(2, parseStat('Casting Time: Action Range: 60 feet Components: V, S Duration: Concentration, up to 1 minute'));
    const one: Record<string, Partial<ReturnType<typeof pdfHeader>>> = {
      level: { level: 3 },
      castingTime: { castingTime: 'bonus' },
      range: { range: 'feet:90' },
      components: { components: 'VSM' },
      duration: { duration: 'minute:10' },
      concentration: { concentration: false },
      ritual: { ritual: true },
    };
    expect(headerDiffs(p, p)).toEqual([]);
    for (const [field, change] of Object.entries(one)) expect(headerDiffs({ ...p, ...change }, p), field).toEqual([field]);
  });
  it('the mapper wires it: a Foundry record whose header disagrees with the PDF stat line (concentration, ritual) is emitted partial with the review line', () => {
    const body = 'The target makes a Constitution saving throw, taking 2d10 Necrotic damage on a failed save or half as much damage on a successful one.';
    const save = act('save', { save: { ability: ['con'], dc: { calculation: 'spellcasting' } }, damage: { onSave: 'half', parts: [part(2, 10, 'necrotic', { mode: '' })] } });
    const out = run([
      { rec: fSpell('Test Agree', { activities: { a: save } }), pdf: pdfSpell('Test Agree', 1, ACTION_120, body) },
      { rec: fSpell('Test Focus', { properties: ['vocal', 'somatic', 'concentration'], activities: { a: save } }), pdf: pdfSpell('Test Focus', 1, ACTION_120, body) },
      { rec: fSpell('Test Rite', { properties: ['vocal', 'somatic', 'ritual'], activities: { a: save } }), pdf: pdfSpell('Test Rite', 1, ACTION_120, body) },
    ]);
    expect(out.items.get('srd:test-agree')!.unimplemented).not.toContain(U.pdfHeaderDisagrees());
    for (const id of ['srd:test-focus', 'srd:test-rite']) {
      const it = out.items.get(id)!;
      expect(it.unimplemented, id).toContain(U.pdfHeaderDisagrees());
      expect(it.fidelity).toBe('partial');
      // The PDF decides the header: no concentration key from Foundry's property.
      expect(it.concentration).toBeUndefined();
    }
  });
  it('a header disagreement, a heuristic bucket-A shape and a reaction each keep a spell partial with their line', () => {
    const base = { maps: true, shape: 'bucketA' as const, unimplemented: [], hasDuration: false };
    expect(classify({ ...base, heuristicShape: true }).unimplemented).toEqual([U.bucketHeuristic()]);
    expect(classify({ ...base, pdfHeaderAgrees: false }).unimplemented).toEqual([U.pdfHeaderDisagrees()]);
    expect(classify({ ...base, activation: 'reaction' }).unimplemented).toEqual([U.activationReview('reaction')]);
    expect(classify(base).fidelity).toBe('full');
  });
});

// ---- votes ----------------------------------------------------------------------------------------

describe('crosscheck-spells.ts: the PDF decides; Foundry and 5e-bits are compared, as tokens only', () => {
  const p = pdfSpell('Test Burst', 3, 'Casting Time: Action Range: 150 feet Components: V, S, M (a pebble) Duration: Instantaneous', 'A Dexterity saving throw, taking 8d6 Fire damage.');
  const pdf = { spells: [p.header], spellDetails: [p.detail] } as unknown as SrdIndex;
  it('agreeing sources give no rows; a disagreeing vote is a row naming that source', () => {
    const f = fSpell('Test Burst', { level: 3, range: { units: 'ft', value: '150' }, properties: ['vocal', 'somatic', 'material'], activities: { a: act('save', { save: { ability: ['dex'] } }) } });
    const bits = [{ name: 'Test Burst', level: 3, school: { index: 'evocation' }, casting_time: 'Action', range: '150 feet', components: ['V', 'S', 'M'], duration: 'Instantaneous', concentration: false, ritual: false, damage: { damage_type: { index: 'cold' }, damage_at_slot_level: { 3: '8d6' } } }];
    const r = crosscheckSpells({ pdf, foundry: [f], bits });
    expect(r.disagreements).toEqual([{ spell: 'srd:test-burst', field: 'damage', pdf: '8d6 fire', bits: '8d6 cold', against: 'bits' }]);
    expect(r.foundry).toEqual({ spells: 1, compared: 9, agree: 9 });
    expect(r.open5e).toEqual({ available: false });
  });
  it('a vote value that is not a token is written as "formula" or "unparsed", never copied', () => {
    expect(asToken('hour:@item.level * 48 - 72')).toBe('formula');
    expect(asToken('feet:120')).toBe('feet:120');
    expect(bitsTokens({ range: 'Touch Component: V, S', components: [] }).range).toBe('unparsed');
    expect(foundryTokens({ system: { school: 'evo', activation: { type: 'action' }, range: { units: 'self' }, duration: { units: 'inst' }, properties: [] } }).school).toBe('evocation');
  });
});

describe('crosscheck-open5e.ts: runs when its pinned data is in the cache, skips cleanly when not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'montecrit-open5e-'));
  it('no file, or a file with no pin: not available, with the log line', () => {
    expect(readOpen5e(dir, 'spells.json', PINS)).toEqual({ available: false, why: 'no-file' });
    writeFileSync(join(dir, 'spells.json'), '[]');
    expect(readOpen5e(dir, 'spells.json', PINS)).toEqual({ available: false, why: 'no-pin' });
    expect(notAvailable('spells', 'no-file')).toMatch(/^open5e spells: not available/);
  });
  it('a pinned fixture is read and votes; a changed file fails closed', () => {
    const body = JSON.stringify({ results: [{ name: 'Test Burst', level: 3, school: { name: 'Evocation' }, casting_time: 'action', range_text: '150 feet', verbal: true, somatic: true, material: true, concentration: false, ritual: false, duration: 'instantaneous', damage_roll: '8d6', damage_types: ['fire'], saving_throw_ability: 'dexterity' }] });
    writeFileSync(join(dir, 'spells.json'), body);
    const pins = { ...PINS, open5e: { ...PINS.open5e, files: { ...PINS.open5e.files, 'spells.json': { remote: 'x', sha256: sha256(body) } } } } as Pins;
    const got = readOpen5e(dir, 'spells.json', pins);
    expect(got.available).toBe(true);
    const tokens = open5eSpells(got.available ? got.data : []);
    expect(tokens.get('Test Burst')).toEqual({ level: '3', school: 'evocation', castingTime: 'action', range: 'feet:150', components: 'VSM', duration: 'instant', concentration: 'false', ritual: 'false', damage: '8d6 fire', save: 'dex' });
    const p = pdfSpell('Test Burst', 3, 'Casting Time: Action Range: 150 feet Components: V, S, M (a pebble) Duration: Instantaneous', 'A Dexterity saving throw, taking 8d6 Fire damage.');
    const r = crosscheckSpells({ pdf: { spells: [p.header], spellDetails: [p.detail] } as unknown as SrdIndex, foundry: [], open5e: tokens });
    expect(r.open5e).toEqual({ spells: 1, compared: 10, agree: 10 });
    writeFileSync(join(dir, 'spells.json'), `${body} `);
    expect(() => readOpen5e(dir, 'spells.json', pins)).toThrow(/fail closed/);
  });
  it('a field Open5e lacks is not compared; monsters compare AC, HP and CR by name', () => {
    expect(open5eSpellTokens({ name: 'X', level: 1 })).toEqual({ level: '1' });
    const r = crosscheckMonsters([{ id: 'srd:test-goblin', name: 'Test Goblin', ac: 15, hp: 10, cr: 0.25 }], [{ name: 'Test Goblin', armor_class: 15, hit_points: 7, challenge_rating_decimal: '0.250' }]);
    expect(r).toEqual({ compared: 3, agree: 2, missing: 0, disagreements: [{ monster: 'srd:test-goblin', field: 'hp', ours: '10', open5e: '7' }] });
  });
});

// ---- import:verify's hand-line rule ----------------------------------------------------------------

describe('import:verify: free-text lines only from a replace: true override that lists them', () => {
  it('a generated item may keep its hand override’s own lines; any other free text is a problem', () => {
    const root = mkdtempSync(join(tmpdir(), 'montecrit-verify-'));
    mkdirSync(join(root, 'tools/import-srd/overrides/spell'), { recursive: true });
    mkdirSync(join(root, 'packs/srd-5.2.1/spells'), { recursive: true });
    copyFileSync(join(REPO_ROOT, 'tools/import-srd/pins.json'), join(root, 'tools/import-srd/pins.json'));
    const ov = 'replace: true\nkind: spell\nid: srd:test-hand\nunimplemented:\n  - the hand-written note\n';
    writeFileSync(join(root, 'tools/import-srd/overrides/spell/test-hand.yaml'), ov);
    const item = (lines: string[]) =>
      `# GENERATED by tools/import-srd; edit tools/import-srd/overrides/ instead\nid: srd:test-hand\nkind: spell\nprovenance:\n  importer: 1\n  overrides:\n    - file: tools/import-srd/overrides/spell/test-hand.yaml\n      sha256: ${sha256(ov)}\n  path: p\n  foreignId: f\n  recordSha256: ${'c'.repeat(64)}\n  ref: ${PINS.foundry.commit}\n  review: reviewed\n  source: foundry-dnd5e\nunimplemented:\n${lines.map((l) => `  - ${l}\n`).join('')}`;
    writeFileSync(join(root, 'packs/srd-5.2.1/spells/test-hand.yaml'), item(['the hand-written note']));
    expect(verifyRepo(root).filter((p) => p.includes('matches no template'))).toEqual([]);
    writeFileSync(join(root, 'packs/srd-5.2.1/spells/test-hand.yaml'), item(['the hand-written note', 'some other prose']));
    expect(verifyRepo(root).filter((p) => p.includes('matches no template'))).toEqual(['packs/srd-5.2.1/spells/test-hand.yaml: unimplemented line "some other prose" matches no template']);
  });
});

// ---- the committed pack -----------------------------------------------------------------------------

const PACK = join(REPO_ROOT, 'packs/srd-5.2.1');
const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.yaml') ? [join(d, e.name)] : [])).sort();

describe('the six hand-written spells (m3.md 4.6): replace: true overrides that compile byte-identically', () => {
  /** hash64(canonicalJson(template)) of a probe PC knowing each spell, computed at HEAD (de33b8f) from the hand files before the move. */
  const BEFORE: Readonly<Record<string, string>> = {
    'srd:guidance': 'b0b9d543330ca0cb',
    'srd:guiding-bolt': '2ac3f9e73a8b0b80',
    'srd:healing-word': 'e33b62f7090e2caa',
    'srd:moonbeam': '581b2e4b117686fb',
    'srd:produce-flame': 'ab5a35439f5b806d',
    // Coverage step 9 moved it on purpose: the override gained `hidden: { dc: caster }` (the bound Search DC) and fidelity full (was 4df12f8795535e0e).
    'srd:spike-growth': 'f6444610e99d9a1b',
  };
  const files = walk(PACK).map((p) => ({ path: p.slice(REPO_ROOT.length + 1), text: readFileSync(p, 'utf8') }));
  const manifest = { path: 'packs/test/manifest.yaml', text: readFileSync(join(REPO_ROOT, 'packs/test/manifest.yaml'), 'utf8') };
  const probe = (local: string, cantrip: boolean) => ({
    path: `packs/test/pcs/probe-${local}.yaml`,
    text: `kind: pc\nid: test:probe-${local}\nname: Probe\nsource: test\nrules: '2024'\nlevel: 5\nsize: medium\nspeed: 30\nabilities: { str: 10, dex: 10, con: 10, int: 10, wis: 16, cha: 10 }\nhpMax: 30\nac: 12\nslots: [4, 3, 2]\ncasting:\n  - source: druid\n    ability: wis\n    list: druid\n    ${cantrip ? 'cantrips' : 'prepared'}: [srd:${local}]\n`,
  });
  for (const id of Object.keys(BEFORE)) {
    it(`${id}: its override is replace: true and a PC knowing it hashes as before the move`, () => {
      const local = id.slice(4);
      const ov = loadOverrides().find((o) => o.id === id)!;
      expect(ov.replace).toBe(true);
      const gen = readFileSync(join(PACK, 'spells', `${local}.yaml`), 'utf8');
      expect(gen.startsWith('# GENERATED by tools/import-srd')).toBe(true);
      const r = loadContent([...files, manifest, probe(local, id === 'srd:guidance' || id === 'srd:produce-flame')]);
      if (!r.content) throw new Error(r.errors.map(formatDiag).join('\n'));
      expect(hash64(canonicalJson(r.content.get(`test:probe-${local}`)))).toBe(BEFORE[id]);
    });
  }
});

describe('C4: no spell outside the 339 PDF headers is emitted', () => {
  const index = loadSrdIndex(join(REPO_ROOT, 'tools/import-srd/srd-index.json'))!;
  const pdf = JSON.parse(readFileSync(join(REPO_ROOT, 'tools/import-srd/srd-index.json'), 'utf8')) as SrdIndex;
  it('the index has 339 headers, each with its stat lines and tokens', () => {
    expect(pdf.spells).toHaveLength(339);
    expect(pdf.spellDetails!.map((d) => d.name)).toEqual(pdf.spells.map((s) => s.name));
  });
  it('every committed spell item names a PDF header (and sits on its page)', () => {
    const names = new Map(pdf.spells.map((s) => [s.name, s.page]));
    const spells = walk(join(PACK, 'spells')).map((p) => parse(readFileSync(p, 'utf8')) as Rec);
    expect(spells.length).toBeGreaterThan(30);
    for (const s of spells) {
      expect(names.has(s.name as string), `${String(s.id)} is not a PDF spell`).toBe(true);
      expect(String(s.source)).toContain(`p.${names.get(s.name as string)}`);
    }
  });
  it('a CC-BY-stamped spell record whose name is not a PDF header is dropped by the gate', () => {
    const r = filterRecords([fSpell('Not A Real Spell', {}), fSpell('Fireball', {})], index, ['spell']);
    expect(r.kept.map((k) => k.rec.name)).toEqual(['Fireball']);
    expect(r.drops).toEqual([expect.objectContaining({ name: 'Not A Real Spell', reason: 'not-in-srd-pdf' })]);
  });
  it('every committed zone spell whose PDF text reads "creature of your choice" carries the creatures-of-your-choice line', () => {
    const facts = new Map(pdf.spellDetails!.map((d) => [d.name, d.facts]));
    const zones = walk(join(PACK, 'spells')).map((p) => parse(readFileSync(p, 'utf8')) as Rec).filter((x) => Array.isArray(x.effects) && (x.effects as Rec[]).some((e) => e.zone !== undefined));
    const chosen = zones.filter((x) => facts.get(x.name as string)?.ofYourChoice);
    expect(chosen.map((x) => x.id)).toContain('srd:weird');
    // A zone read as `affects: foes` (coverage step 7.3) models the choice as "every foe": it prints that reading, not "not modeled".
    const foes = (x: Rec) => (x.effects as Rec[]).some((e) => (e.zone as Rec | undefined)?.affects === 'foes');
    for (const x of chosen) {
      if (foes(x)) {
        expect(x.unimplemented as string[], String(x.id)).not.toContain(U.part('creatures-of-your-choice'));
        expect((x.unimplemented as string[]).some((l) => l.startsWith('creatures of your choice: read as every foe')), String(x.id)).toBe(true);
      } else expect(x.unimplemented as string[], String(x.id)).toContain(U.part('creatures-of-your-choice'));
    }
  });
  it('every SPELL_PARTS, CONDITION_READINGS and SAVE_IGNORES_COVER row names an emitted spell', () => {
    const ids = new Set(walk(join(PACK, 'spells')).map((p) => (parse(readFileSync(p, 'utf8')) as Rec).id as string));
    for (const id of [...Object.keys(SPELL_PARTS), ...Object.keys(CONDITION_READINGS), ...Object.keys(SAVE_IGNORES_COVER)]) expect(ids.has(id), id).toBe(true);
  });
  it('Sacred Flame: "The target gains no benefit from Half Cover or Three-Quarters Cover for this save" (srd-raw.txt:30314-30315) is its save step\'s ignoresCover, not an unmodeled part', () => {
    const sf = parse(readFileSync(join(PACK, 'spells', 'sacred-flame.yaml'), 'utf8')) as Rec;
    const save = (sf.do as Rec[]).find((s) => 'save' in s)!.save as Rec;
    expect(save.ignoresCover).toBe('partial');
    expect(sf.unimplemented as string[]).not.toContain(U.part('ignores-cover'));
  });
});
