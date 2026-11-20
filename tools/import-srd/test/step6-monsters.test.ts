// M3 step 6: the monster and simple-magic-item importer (docs/design/m3.md 2.7, 4.3-4.7, C4, C7,
// C9b). Synthetic PDF lines and Foundry-shaped records for each parsing and mapping branch, the
// Foundry and 5e-bits comparisons, and checks on the committed pack: the 8 hand-written stat
// blocks compile byte-identically from their replace: true overrides, no actor outside the PDF's
// stat-block headers is emitted, every emitted monster compiles and fights one round in a scratch
// scenario built here (not under scenarios/), and a character carrying a magic item gets its bonus.
// No cache, no network, no home dir.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { loadContent } from '../../../packages/engine/src/content/load.ts';
import { formatDiag, type SourceFile } from '../../../packages/engine/src/content/yaml.ts';
import { makeDeciders } from '../../../packages/engine/src/decide/make.ts';
import { resolveScenario } from '../../../packages/engine/src/scenario/resolve.ts';
import { createContext, runFight } from '../../../packages/engine/src/sim/fight.ts';
import { acNow } from '../../../packages/engine/src/sim/hands.ts';
import { applyPassives } from '../../../packages/engine/src/sim/precast.ts';
import { canonicalJson } from '../../../packages/engine/src/util/canon.ts';
import { hash64 } from '../../../packages/engine/src/util/hash.ts';
import { asMonsterToken, bitsMonsterTokens, crosscheckMonsters, pdfVoteTokens } from '../crosscheck-monsters.ts';
import { filterRecords, indexFromJson, kindOf } from '../filter.ts';
import { buildImport } from '../main.ts';
import { ENGINE_GAPS, MAGIC_READINGS, readingProblem, variantIds } from '../map/magic-item.ts';
import { buildMonster, floorMean, monsterDiffs, monsterId } from '../map/monster.ts';
import { loadOverrides } from '../overrides.ts';
import type { SrdIndex } from '../pdf/build.ts';
import type { Line } from '../pdf/lines.ts';
import { factsOf, parseCategory, type MagicItemDetail } from '../pdf/magic-items.ts';
import { parseBlock, parseEntry, parseHit, parseMonsters, usageToken, type MonsterDetail } from '../pdf/monsters.ts';
import { loadPins } from '../pins.ts';
import type { FoundryRecord } from '../read.ts';
import { isTemplateLine, U } from '../unimplemented.ts';
import { REPO_ROOT } from '../util.ts';

type Rec = Record<string, unknown>;
const PINS = loadPins();
const INDEX = JSON.parse(readFileSync(join(REPO_ROOT, 'tools/import-srd/srd-index.json'), 'utf8')) as SrdIndex;

// ---- synthetic PDF lines ------------------------------------------------------------------

/** A stat block as bbox lines (left column of page 400), in the SRD 5.2.1 styles. */
function blockLines(name: string, o: { size?: string; fields?: string[]; abilities?: string[]; sections?: Record<string, string[]> } = {}): Line[] {
  const out: Line[] = [];
  let y = 40;
  const at = (h: number, text: string, x = 63) => out.push({ page: 400, col: 0, x, y: (y += 12), h, text });
  at(17.9, name);
  at(10.7, o.size ?? 'Medium Humanoid, Neutral');
  for (const f of o.fields ?? ['AC 13', 'Initiative +1 (11)', 'HP 11 (2d8 + 2)', 'Speed 30 ft.']) at(10.7, f);
  at(6.9, 'MOD SAVE');
  const ab = o.abilities ?? ['Str 14 +2 +2', 'Dex 12 +1 +1', 'Con 12 +1 +1', 'Int 10 +0 +0', 'Wis 10 +0 +0', 'Cha 8 −1 −1'];
  for (const a of ab) at(11.6, a);
  at(10.7, 'Senses Passive Perception 10');
  at(10.7, 'Languages Common');
  at(10.7, 'CR 1/2 (XP 100; PB +2)');
  for (const [sec, entries] of Object.entries(o.sections ?? { Actions: ['Club. Melee Attack Roll: +4, reach 5 ft. Hit: 5 (1d6 + 2) Bludgeoning damage.'] })) {
    at(13.9, sec);
    for (const e of entries) at(11.4, e);
  }
  return out;
}

const detail = (name: string, o: Parameters<typeof blockLines>[1] = {}): MonsterDetail => parseBlock(blockLines(name, o));

// ---- the PDF stat-block parser --------------------------------------------------------------

describe('pdf/monsters.ts: stat blocks as printed numbers and entry tokens', () => {
  it('reads AC, Initiative, HP, Speed, the ability grid with saves, Skills, Senses, defenses, Gear and CR', () => {
    const d = detail('Test Brute', {
      size: 'Large Giant, Chaotic Evil',
      fields: ['AC 15 Initiative +2 (12)', 'HP 45 (6d10 + 12)', 'Speed 40 ft., Climb 30 ft., Fly 60 ft. (hover)', 'Skills Athletics +6, Sleight of Hand +4'],
      abilities: ['Str 18 +4 +6', 'Dex 14 +2 +2', 'Con 14 +2 +2', 'Int 6 −2 −2', 'Wis 10 +0 +0', 'Cha 7 −2 −2'],
    });
    expect([d.sizes, d.ac, d.initiative, d.hp, d.speed]).toEqual([['large'], 15, { mod: 2, score: 12 }, { average: 45, formula: '6d10 + 12' }, { walk: 40, climb: 30, fly: 60, hover: true }]);
    expect([d.abilities.str, d.abilities.int, d.skills, d.cr, d.xp, d.pb]).toEqual([{ score: 18, mod: 4, save: 6 }, { score: 6, mod: -2, save: -2 }, { athletics: 6, 'sleight-of-hand': 4 }, '1/2', 100, 2]);
  });

  it('reads the grid when pdftotext splits a cell ("Str 5" and "-3 -3") or merges one ("Con22")', () => {
    const d = detail('Test Centipede', { abilities: ['Str 5', '−3 −3', 'Dex 14 +2 +2', 'Con22 +6 +6', 'Int 1 −5 −5', 'Wis 7 −2 −2', 'Cha 3 −4 −4'] });
    expect([d.abilities.str, d.abilities.con]).toEqual([{ score: 5, mod: -3, save: -3 }, { score: 22, mod: 6, save: 6 }]);
  });

  it('splits damage types from conditions in Immunities and flags words outside both lists', () => {
    const d = detail('Test Ghost', { fields: ['AC 11', 'Initiative +1 (11)', 'HP 9 (2d8)', 'Speed 30 ft.', 'Resistances Bludgeoning from nonmagical attacks', 'Immunities Poison, Cold; Exhaustion, Frightened,', 'Prone'] });
    expect([d.resist, d.immune, d.conditionImmune, d.unparsed]).toEqual([[], ['poison', 'cold'], ['exhaustion', 'frightened', 'prone'], ['resistances']]);
  });

  it('a field it can not read fails the block (a spell summon with AC by spell level)', () => {
    expect(() => detail('Test Summon', { fields: ['AC 10 + 1 per spell level', 'Initiative +1 (11)', 'HP 11 (2d8 + 2)', 'Speed 30 ft.'] })).toThrow(/AC/);
    const lines = [...blockLines('Good One'), ...blockLines('Bad One', { fields: ['AC 11 + the spell’s level', 'Initiative +1 (11)', 'HP 9 (2d8)', 'Speed 30 ft.'] }).map((l) => ({ ...l, page: 401 }))];
    const r = parseMonsters(lines);
    expect([r.heads.map((h) => h.name), r.details.map((d) => d.name), r.failed.map((f) => f.name)]).toEqual([['Good One', 'Bad One'], ['Good One'], ['Bad One']]);
  });

  it('attack entries: melee, ranged, melee-or-ranged, several damage parts, the Advantage rider, flat damage, and text after the damage', () => {
    expect(parseEntry('Scimitar. Melee Attack Roll: +4, reach 5 ft. Hit: 5 (1d6 + 2) Slashing damage, plus 2 (1d4) Slashing damage if the attack roll had Advantage.')).toEqual({
      name: 'Scimitar',
      attack: { kind: 'melee', toHit: 4, reach: 5, damage: [{ avg: 5, dice: '1d6 + 2', type: 'slashing', ifAdvantage: false }, { avg: 2, dice: '1d4', type: 'slashing', ifAdvantage: true }] },
      more: false,
    });
    expect(parseEntry('Dagger. Melee or Ranged Attack Roll: +4, reach 5 ft. or range 20/60 ft. Hit: 4 (1d4 + 2) Piercing damage.').attack).toMatchObject({ kind: 'meleeOrRanged', reach: 5, range: [20, 60] });
    expect(parseEntry('Shortbow. Ranged Attack Roll: +4, range 80/320 ft. Hit: 5 (1d6 + 2) Piercing damage.').attack).toMatchObject({ kind: 'ranged', range: [80, 320] });
    expect(parseEntry('Bite. Melee Attack Roll: +0, reach 5 ft. Hit: 1 Piercing damage.').attack!.damage).toEqual([{ avg: 1, dice: '1', type: 'piercing', ifAdvantage: false }]);
    expect(parseEntry('Rend. Melee Attack Roll: +14, reach 10 ft. Hit: 13 (1d10 + 8) Slashing damage plus 5 (2d4) Fire damage.').attack!.damage.map((x) => x.type)).toEqual(['slashing', 'fire']);
    expect(parseEntry('Tentacle. Melee Attack Roll: +9, reach 15 ft. Hit: 12 (2d6 + 5) Bludgeoning damage. If the target is Large or smaller, it has the Grappled condition.').more).toBe(true);
    expect(parseHit('7 (1d8 + 3) Piercing damage, or 8 (1d10 + 3) Piercing damage if used with two hands.')!.more).toBe(true);
  });

  it('saves, usage limits and the "takes the Disengage or Hide action" bonus action', () => {
    expect(parseEntry('Fire Breath (Recharge 5–6). Dexterity Saving Throw: DC 21, each creature in a 60-foot Cone. Failure: 59 (17d6) Fire damage.')).toEqual({ name: 'Fire Breath', usage: 'recharge-5-6', save: { ability: 'dex', dc: 21 }, more: true });
    expect(['Recharge 6', '2/Day', '3/Day Each', 'Recharges after a Short or Long Rest', '3/Day, or 4/Day in Lair'].map(usageToken)).toEqual(['recharge-6', 'per-day-2', 'per-day-3-each', 'rest', 'other']);
    expect(parseEntry('Nimble Escape. The goblin takes the Disengage or Hide action.')).toEqual({ name: 'Nimble Escape', takes: ['disengage', 'hide'], more: false });
  });

  it('Multiattack: exactly the three sentence forms, every name one of the block entries', () => {
    const own = ['Scimitar', 'Shortbow', 'Bite', 'Claw', 'Spear', 'Greatsword', 'Heavy Crossbow'];
    const ma = (t: string) => parseEntry(`Multiattack. ${t}`, own);
    expect(ma('The goblin makes two attacks, using Scimitar or Shortbow in any combination.').multiattack).toEqual({ groups: [{ count: 2, from: ['Scimitar', 'Shortbow'] }] });
    expect(ma('The bear makes one Bite attack and two Claw attacks.').multiattack).toEqual({ groups: [{ count: 1, from: ['Bite'] }, { count: 2, from: ['Claw'] }] });
    expect(ma('The gladiator makes three Spear attacks. It can replace one attack with a use of Shield Bash.')).toMatchObject({ multiattack: { groups: [{ count: 3, from: ['Spear'] }] }, more: true });
    // Coverage C0 added "two A or B attacks" (alternatives, sameAttack) and more forms; see
    // c0-coverage.test.ts. A name that isn't one of the block's entries still parses to nothing.
    expect(ma('The warrior makes two Greatsword or Heavy Crossbow attacks.').multiattack).toEqual({ groups: [{ count: 2, from: ['Greatsword'] }], orGroups: [[{ count: 2, from: ['Heavy Crossbow'] }]], sameAttack: true });
    expect(ma('The thing makes two Tentacle attacks.').multiattack).toBeUndefined();
  });

  it('an entry whose bold run-in is short starts on an 11.3 pt line after a finished sentence', () => {
    const lines = blockLines('Test Rakshasa', { sections: { Actions: ['Cursed Touch. Melee Attack Roll: +10, reach 5 ft. Hit: 12 (2d6 + 5) Slashing damage.'] } });
    lines.push({ page: 400, col: 0, x: 63, y: 900, h: 11.3, text: 'Baleful Command (Recharge 5–6). Wisdom Saving Throw: DC 18, each enemy.' });
    expect(parseBlock(lines).actions.map((e) => e.name)).toEqual(['Cursed Touch', 'Baleful Command']);
  });
});

// ---- the monster mapper ------------------------------------------------------------------------

describe('map/monster.ts: the PDF stat block becomes the monster item; lines for everything else', () => {
  it('a plain block maps to the engine schema, full with no lines', () => {
    const b = buildMonster(detail('Test Thug'));
    if ('skip' in b) throw new Error(b.skip);
    expect(b.item).toEqual({
      kind: 'monster', id: 'srd:test-thug', name: 'Test Thug', source: 'SRD 5.2.1 p.400', size: 'medium', cr: '1/2', pb: 2, ac: 13,
      hp: { average: 11, formula: '2d8 + 2' }, speed: { walk: 30 }, initiative: { mod: 1, score: 11 },
      abilities: { str: 14, dex: 12, con: 12, int: 10, wis: 10, cha: 8 }, senses: { passivePerception: 10 },
      attacks: [{ id: 'club', name: 'Club', kind: 'melee', toHit: 4, reach: 5, damage: [{ roll: '1d6 + 2', type: 'bludgeoning', avg: 5 }] }],
    });
    expect(b.lines).toEqual([]);
  });

  it('saves that differ from MOD, condition immunities the engine has, the rest as lines; size, speed and footprint lines', () => {
    const b = buildMonster(detail('Test Golem', {
      size: 'Large or Medium Construct, Unaligned',
      fields: ['AC 17', 'Initiative +1 (11)', 'HP 45 (6d10 + 12)', 'Speed 30 ft., Swim 20 ft.', 'Immunities Poison; Charmed, Exhaustion'],
      abilities: ['Str 18 +4 +6', 'Dex 12 +1 +1', 'Con 14 +2 +2', 'Int 3 −4 −4', 'Wis 10 +0 +0', 'Cha 1 −5 −5'],
    }));
    if ('skip' in b) throw new Error(b.skip);
    expect([b.item.saves, b.item.immune, b.item.conditionImmune, b.item.speed]).toEqual([{ str: 6 }, ['poison'], ['charmed'], { walk: 30, swim: 20 }]);
    // The default Club's +4 isn't STR 18's +4 + PB; since coverage C0 it maps because exactly one
    // other ability, CON +2, plus PB gives +4 (toHitAbility; c0-coverage.test.ts has the no-match case).
    expect(b.lines.sort()).toEqual([U.footprint(), U.monsterConditionImmunity('exhaustion'), U.monsterSize('large', 'medium'), U.monsterSpeed('swim')].sort());
    expect(b.item.attacks).toEqual([expect.objectContaining({ id: 'club', toHit: 4, toHitAbility: 'con' })]);
  });

  it('Resistances and Vulnerabilities map to resist and vuln exactly, each in its own field, leaving Immunities alone', () => {
    const b = buildMonster(detail('Test Wight', { fields: ['AC 13', 'Initiative +1 (11)', 'HP 11 (2d8 + 2)', 'Speed 30 ft.', 'Resistances Cold, Fire', 'Vulnerabilities Radiant', 'Immunities Poison'] }));
    if ('skip' in b) throw new Error(b.skip);
    expect([b.item.resist, b.item.vuln, b.item.immune]).toEqual([['cold', 'fire'], ['radiant'], ['poison']]);
    const none = buildMonster(detail('Test Plain'));
    if ('skip' in none) throw new Error(none.skip);
    expect(['resist', 'vuln', 'immune'].filter((k) => k in none.item)).toEqual([]);
  });

  it('a mapped Multiattack with text after its attacks (replace one attack with Shield Bash) keeps the mapping and says the rest is not modeled', () => {
    const b = buildMonster(detail('Test Gladiator', { sections: { Actions: [
      'Multiattack. The gladiator makes two Club attacks. It can replace one attack with a use of Shield Bash.',
      'Club. Melee Attack Roll: +4, reach 5 ft. Hit: 5 (1d6 + 2) Bludgeoning damage.',
    ] } }));
    if ('skip' in b) throw new Error(b.skip);
    expect(b.item.multiattack).toEqual({ alternatives: [[{ count: 2, from: ['club'] }]] });
    expect(b.lines).toContain(U.monsterMultiattackMore());
    const plain = buildMonster(detail('Test Brawler', { sections: { Actions: ['Multiattack. The brawler makes two Club attacks.', 'Club. Melee Attack Roll: +4, reach 5 ft. Hit: 5 (1d6 + 2) Bludgeoning damage.'] } }));
    if ('skip' in plain) throw new Error(plain.skip);
    expect(plain.lines).not.toContain(U.monsterMultiattackMore());
  });

  it('traits, reactions, legendary actions, save and usage-limited actions, other-ability attacks and riders are lines, never approximated', () => {
    const b = buildMonster(detail('Test Mage', { sections: {
      Traits: ['Pack Tactics. The thing has Advantage on an attack roll against a creature.'],
      Actions: [
        'Multiattack. The mage makes two Club attacks.',
        'Club. Melee Attack Roll: +4, reach 5 ft. Hit: 5 (1d6 + 2) Bludgeoning damage. If the target is a creature, it has the Prone condition.',
        'Arcane Burst. Ranged Attack Roll: +6, range 120/480 ft. Hit: 7 (2d6) Force damage.',
        'Fire Breath (Recharge 5–6). Dexterity Saving Throw: DC 13, each creature in a 15-foot Cone.',
      ],
      Reactions: ['Parry. Trigger: A hit. Response: +2 AC.'],
      'Legendary Actions': ['Lash. The mage makes one Club attack.'],
    } }));
    if ('skip' in b) throw new Error(b.skip);
    expect((b.item.attacks as Rec[]).map((a) => a.id)).toEqual(['club']);
    expect(b.item.multiattack).toEqual({ alternatives: [[{ count: 2, from: ['club'] }]] });
    expect(b.lines.sort()).toEqual([
      U.monsterAttackMore('club'),
      U.monsterAttackToHit('arcane-burst'),
      U.monsterEntry('action', 'fire-breath', 'recharge-5-6'),
      U.monsterEntry('reaction', 'parry'),
      U.monsterEntry('trait', 'pack-tactics'),
      U.monsterLegendary(),
    ].sort());
    for (const l of b.lines) expect(isTemplateLine(l), l).toBe(true);
  });

  it('a Multiattack naming an attack that is not emitted is not mapped (one attack, with the line)', () => {
    const b = buildMonster(detail('Test Two', { sections: { Actions: ['Multiattack. The two makes two Bite attacks.', 'Bite. Melee Attack Roll: +7, reach 5 ft. Hit: 5 (1d6 + 2) Piercing damage.'] } }));
    if ('skip' in b) throw new Error(b.skip);
    expect([b.item.multiattack, b.lines]).toEqual([undefined, [U.monsterAttackToHit('bite'), U.monsterMultiattack()]]);
  });

  it('a thrown attack counts its Gear entry (one when the line gives no count, as the hand-written Guard reads it)', () => {
    const throwing = { Actions: ['Spear. Melee or Ranged Attack Roll: +4, reach 5 ft. or range 20/60 ft. Hit: 5 (1d6 + 2) Piercing damage.'] };
    const one = buildMonster(detail('Test Guard', { fields: ['AC 13', 'Initiative +1 (11)', 'HP 11 (2d8 + 2)', 'Speed 30 ft.', 'Gear Chain Shirt, Spear'], sections: throwing }));
    const three = buildMonster(detail('Test Minion', { fields: ['AC 13', 'Initiative +1 (11)', 'HP 11 (2d8 + 2)', 'Speed 30 ft.', 'Gear Spears (3)'], sections: throwing }));
    const none = buildMonster(detail('Test Bare', { sections: throwing }));
    if ('skip' in one || 'skip' in three || 'skip' in none) throw new Error('skipped');
    expect([one.item.gear, (one.item.attacks as Rec[])[0]!.thrownGear]).toEqual([[{ name: 'Chain Shirt' }, { name: 'Spear', count: 1 }], 'Spear']);
    expect([three.item.gear, (three.item.attacks as Rec[])[0]!.thrownGear]).toEqual([[{ name: 'Spears', count: 3 }], 'Spears']);
    expect([(none.item.attacks as Rec[])[0]!.thrownGear, none.lines]).toEqual([undefined, [U.monsterThrown('spear')]]);
  });

  it('"takes the Disengage or Hide action" gives the Disengage option and a line for the Hide part', () => {
    const b = buildMonster(detail('Test Goblin', { sections: { Actions: ['Club. Melee Attack Roll: +4, reach 5 ft. Hit: 5 (1d6 + 2) Bludgeoning damage.'], 'Bonus Actions': ['Nimble Escape. The goblin takes the Disengage or Hide action.'] } }));
    if ('skip' in b) throw new Error(b.skip);
    expect([b.item.options, b.lines]).toEqual([[{ id: 'nimble-escape-disengage', name: 'Nimble Escape (Disengage)', cost: 'bonus', core: 'core:disengage' }], [U.monsterEntry('bonus action', 'nimble-escape')]]);
  });

  it('printed numbers the engine lint reads differently are skipped with a closed reason, never corrected', () => {
    expect(buildMonster(detail('Bad HP', { fields: ['AC 13', 'Initiative +1 (11)', 'HP 12 (2d8 + 2)', 'Speed 30 ft.'] }))).toEqual({ skip: 'pdf-hp-mean', detail: '12' });
    expect(buildMonster(detail('Bad Save', { abilities: ['Str 14 +2 +2', 'Dex 12 +1 +1', 'Con 12 +1 +1', 'Int 6 −2 2', 'Wis 10 +0 +0', 'Cha 8 −1 −1'] }))).toEqual({ skip: 'pdf-save-odd', detail: 'int' });
    expect(buildMonster(detail('Bad Init', { fields: ['AC 13', 'Initiative +7 (16)', 'HP 11 (2d8 + 2)', 'Speed 30 ft.'] }))).toEqual({ skip: 'pdf-initiative', detail: '7' });
    expect([floorMean('2d8 + 2'), floorMean('1d4 - 1'), floorMean('3'), floorMean('d6')]).toEqual([11, 1, 3, undefined]);
  });

  it('a stat block named like a class or spell gets the -monster id (the Druid stat block, the Druid class)', () => {
    expect([monsterId('Druid', INDEX), monsterId('Goblin Boss', INDEX), monsterId('Druid', undefined)]).toEqual(['srd:druid-monster', 'srd:goblin-boss', 'srd:druid']);
  });
});

// ---- the gate and the whole import ------------------------------------------------------------

/** A Foundry actors24 npc record (only what the mapper and the comparison read). */
function npc(name: string, system: Rec = {}, items: Rec[] = []): FoundryRecord {
  const doc: Rec = {
    _id: `mm${name.replace(/\W/g, '')}`.slice(0, 16),
    name,
    type: 'npc',
    items,
    system: { source: { license: 'CC-BY-4.0', book: '', rules: '2024' }, traits: { size: 'med' }, details: { cr: 0.5 }, attributes: { hp: { max: 11, formula: '2d8 + 2' }, ac: { flat: 13 }, movement: { walk: '30' } }, ...system },
  };
  return { pack: 'actors24', path: `packs/_source/actors24/test/${name.toLowerCase().replace(/\W+/g, '-')}.yml`, sha256: 'a'.repeat(64), id: doc._id as string, name, type: 'npc', doc };
}
const club: Rec = { name: 'Club', type: 'weapon', system: { activities: { a: { type: 'attack' } } } };

function runMonsters(records: FoundryRecord[], details: MonsterDetail[]) {
  const pdfIndex = { ...INDEX, monsters: details.map((d) => ({ name: d.name, page: d.page })), monsterDetails: details } as SrdIndex;
  const out = buildImport({ records, index: indexFromJson(pdfIndex), overrides: [], pins: PINS, srdIndexSha256: 'b'.repeat(64), scope: ['monster'], pdfIndex });
  const items = new Map<string, Rec>();
  for (const [p, t] of out.plan) if (p.includes('/monsters/')) {
    const d = parse(t) as Rec;
    items.set(d.id as string, d);
  }
  return { items, out };
}

describe('C4: monsters pass only by stat-block header; the PDF decides, Foundry is compared', () => {
  it('a CC-BY npc whose name is no stat-block header is dropped by the gate; the other is emitted with provenance', () => {
    const { items, out } = runMonsters([npc('Test Thug', {}, [club]), npc('Not A Stat Block')], [detail('Test Thug')]);
    expect([...items.keys()]).toEqual(['srd:test-thug']);
    expect(out.drops.map((d) => [d.name, d.reason])).toEqual([['Not A Stat Block', 'not-in-srd-pdf']]);
    const it0 = items.get('srd:test-thug')!;
    expect([it0.fidelity, (it0.provenance as Rec).pdfPage, (it0.provenance as Rec).foreignId]).toEqual(['full', 400, 'mmTestThug']);
  });

  it('a Foundry field that disagrees with the PDF keeps the printed number and adds the review line', () => {
    const { items } = runMonsters([npc('Test Thug', { attributes: { hp: { max: 11, formula: '2d8 + 2' }, ac: { flat: 14 }, movement: { walk: '30' } } }, [club])], [detail('Test Thug')]);
    const it0 = items.get('srd:test-thug')!;
    expect([it0.ac, it0.fidelity, it0.unimplemented]).toEqual([13, 'partial', [U.pdfHeaderDisagrees()]]);
    expect(monsterDiffs(detail('Test Thug'), npc('Test Thug', { attributes: { ac: { flat: 14 } } }, [club]).doc)).toContainEqual({ field: 'ac', pdf: '13', foundry: '14' });
  });

  it('a stat block that did not parse whole is skipped with its reason', () => {
    const { items, out } = runMonsters([npc('Test Thug', {}, [club])], []);
    expect(items.size).toBe(0);
    // No details: the gate has no header either, so it's a drop; with a header but no details it's a skip.
    expect(out.drops.map((d) => d.reason)).toEqual(['not-in-srd-pdf']);
    const pdfIndex = { ...INDEX, monsters: [{ name: 'Test Thug', page: 400 }], monsterDetails: [] } as SrdIndex;
    const r = buildImport({ records: [npc('Test Thug')], index: indexFromJson(pdfIndex), overrides: [], pins: PINS, srdIndexSha256: 'b'.repeat(64), scope: ['monster'], pdfIndex });
    expect(r.skips.map((s) => s.reason)).toEqual(['pdf-block-unparsed']);
  });
});

describe('crosscheck-monsters.ts: PDF against Foundry and 5e-bits, tokens only', () => {
  it('5e-bits fields compare as tokens; a value that is not one is "unparsed", an empty one "none"', () => {
    const d = detail('Test Thug');
    expect(pdfVoteTokens(d)).toMatchObject({ ac: '13', hp: '11', hpFormula: '2d8+2', cr: '0.5', 'attack.club.toHit': '4', 'attack.club.dice': '1d6+2' });
    const bits = { name: 'Test Thug', armor_class: [{ value: 13 }], hit_points: 11, hit_points_roll: '2d8+2', challenge_rating: 0.5, speed: { walk: '30 ft.' }, strength: 14, dexterity: 12, constitution: 12, intelligence: 10, wisdom: 10, charisma: 8, actions: [{ name: 'Club', attack_bonus: 5, damage: [{ damage_dice: '1d6+2' }] }] };
    expect(bitsMonsterTokens(bits)['attack.club.toHit']).toBe('5');
    const r = crosscheckMonsters({ details: [d], foundry: [npc('Test Thug', {}, [club])], bits: [bits], pdf: INDEX });
    expect(r.disagreements).toEqual([{ monster: 'srd:test-thug', field: 'attack.club.toHit', pdf: '4', bits: '5', against: 'bits' }]);
    expect([asMonsterToken('a long sentence'), asMonsterToken(''), asMonsterToken('2d8+2')]).toEqual(['unparsed', 'none', '2d8+2']);
  });

  it('with no 5e-bits or Open5e data the votes are "not available"', () => {
    const r = crosscheckMonsters({ details: [detail('Test Thug')], foundry: [], bits: undefined, pdf: INDEX });
    expect([r.bits, r.open5e]).toEqual([{ available: false }, { available: false }]);
  });
});

// ---- magic items ----------------------------------------------------------------------------------

const mi = (name: string, facts: string[], o: Partial<MagicItemDetail> = {}): MagicItemDetail => ({ name, page: 238, category: 'ring', attunement: true, plus: [], facts, ...o });
function equipment(name: string, effects: Rec[], extra: Rec = {}): FoundryRecord {
  const doc: Rec = { _id: `dmg${name.replace(/\W/g, '')}`.slice(0, 16), name, type: 'equipment', effects, system: { source: { license: 'CC-BY-4.0', book: '', rules: '2024' }, properties: ['mgc'], rarity: 'rare', ...extra } };
  return { pack: 'equipment24', path: `packs/_source/equipment24/test/${name.toLowerCase().replace(/\W+/g, '-')}.yml`, sha256: 'a'.repeat(64), id: doc._id as string, name, type: 'equipment', doc };
}
const change = (key: string, value: unknown, type = 'add'): Rec => ({ key, value, type });
const transfer = (...changes: Rec[]): Rec => ({ type: 'base', transfer: true, system: { changes } });

function runItems(records: FoundryRecord[], pdf: MagicItemDetail[]) {
  const pdfIndex = { ...INDEX, magicItems: pdf } as SrdIndex;
  const out = buildImport({ records, index: indexFromJson(pdfIndex), overrides: [], pins: PINS, srdIndexSha256: 'b'.repeat(64), scope: ['magicItem'], pdfIndex });
  return new Map([...out.plan].filter(([p]) => p.includes('/features/')).map(([, t]) => { const d = parse(t) as Rec; return [d.id as string, d]; }));
}

describe('pdf/magic-items.ts and map/magic-item.ts (C9b): closed readings, both sides checked', () => {
  it('the category line and the closed fact phrases', () => {
    expect(parseCategory('Armor (Shield), Uncommon (+1), Rare (+2), or Very Rare (+3)')).toEqual({ category: 'armor', attunement: false, plus: [1, 2, 3] });
    expect(parseCategory('Ring, Rare (Requires Attunement)')).toEqual({ category: 'ring', attunement: true, plus: [] });
    expect(factsOf('You gain a +1 bonus to Armor Class and saving throws while wearing this ring.')).toEqual(['ac+1', 'save+1']);
    expect(factsOf("While wearing these bracers, you gain a +2 bonus to Armor Class if you are wearing no armor and using no Shield.")).toEqual(['ac+2', 'if-no-armor-no-shield']);
  });

  it('a mapped item is a passive feature: stats and d20 mods, attunement a line, partial until reviewed (C7)', () => {
    const items = runItems([equipment('Ring of Protection', [transfer(change('system.attributes.ac.bonus', '+1'), change('system.bonuses.abilities.save', '+1'))])], [mi('Ring of Protection', ['ac+1', 'save+1'])]);
    const r = items.get('srd:ring-of-protection')!;
    expect([r.kind, r.effects, r.passive, r.fidelity, r.unimplemented]).toEqual([
      'feature',
      [{ id: 'ring-of-protection', name: 'Ring of Protection', stats: [{ ac: 1 }], mods: [{ on: ['d20.save'], op: 'flat', value: 1 }] }],
      { effects: ['ring-of-protection'] },
      'partial',
      [U.attunement(), U.bucketHeuristic()].sort(),
    ]);
  });

  it('the +N family becomes one item per bonus, each gated as its reading says', () => {
    const ench = (n: number): Rec => ({ type: 'enchantment', system: { changes: [change('system.armor.magicalBonus', n, 'upgrade')] } });
    const items = runItems([equipment('Armor, +1, +2, or +3', [ench(1), ench(2), ench(3)], { rarity: '' })], [mi('Armor, +1, +2, or +3', ['ac-by-rarity-while-worn'], { category: 'armor', attunement: false, plus: [1, 2, 3] })]);
    expect([...items.keys()].sort()).toEqual(['srd:armor-plus-1', 'srd:armor-plus-2', 'srd:armor-plus-3']);
    expect(items.get('srd:armor-plus-2')!.effects).toEqual([{ id: 'armor-plus-2', name: 'Armor, +2', stats: [{ ac: 2, when: ['armored'] }] }]);
    expect(variantIds('Weapon, +1, +2, or +3').map((v) => v.local)).toEqual(['weapon-plus-1', 'weapon-plus-2', 'weapon-plus-3']);
  });

  it('a reading that the record or the PDF contradicts fails the import (fail closed)', () => {
    const ring = MAGIC_READINGS['Ring of Protection']!;
    expect(readingProblem(ring, mi('Ring of Protection', ['ac+1']), equipment('Ring of Protection', []).doc)).toMatch(/PDF tokens/);
    expect(readingProblem(ring, mi('Ring of Protection', ['ac+1', 'save+1']), equipment('Ring of Protection', [transfer(change('system.attributes.ac.bonus', 2))]).doc)).toMatch(/record changes/);
    expect(() => runItems([equipment('Ring of Protection', [])], [mi('Ring of Protection', ['ac+1', 'save+1'])])).toThrow(/fail closed/);
  });

  it('the +N family fails closed on either side: a PDF entry without +1/+2/+3, or a record whose enchantments are not 1, 2, 3', () => {
    const plus = MAGIC_READINGS['Armor, +1, +2, or +3']!;
    const ench = (n: number): Rec => ({ type: 'enchantment', system: { changes: [change('system.armor.magicalBonus', n, 'upgrade')] } });
    const good = equipment('Armor, +1, +2, or +3', [ench(1), ench(2), ench(3)], { rarity: '' });
    const bad = equipment('Armor, +1, +2, or +3', [ench(1), ench(2), ench(2)], { rarity: '' });
    const pdf = (p: number[]) => mi('Armor, +1, +2, or +3', ['ac-by-rarity-while-worn'], { category: 'armor', attunement: false, plus: p });
    expect(readingProblem(plus, pdf([1, 2, 3]), good.doc)).toBeUndefined();
    expect(readingProblem(plus, pdf([1, 2]), good.doc)).toMatch(/PDF variants/);
    expect(readingProblem(plus, pdf([1, 2, 3]), bad.doc)).toMatch(/record variants/);
    expect(() => runItems([good], [pdf([1, 2])])).toThrow(/fail closed/);
    expect(() => runItems([bad], [pdf([1, 2, 3])])).toThrow(/fail closed/);
  });

  it('anything else is narrative; +N ammunition and the wand name the engine gap (Shield and Weapon +N map since step 5b)', () => {
    const items = runItems([equipment('Ammunition, +1, +2, or +3', [], { rarity: '' }), equipment('Bag of Holding', [])], [mi('Ammunition, +1, +2, or +3', [], { attunement: false }), mi('Bag of Holding', [], { attunement: false })]);
    expect(items.get('srd:ammunition-1-2-or-3')).toMatchObject({ fidelity: 'narrative', unimplemented: [U.engineGap('magic-weapon-bonus')] });
    expect(items.get('srd:bag-of-holding')!.fidelity).toBe('narrative');
    expect(Object.keys(ENGINE_GAPS).sort()).toEqual(['Ammunition, +1, +2, or +3', 'Wand of the War Mage, +1, +2, or +3']);
  });

  it('only equipment24 records with the mgc property are magic items; a mundane weapon keeps its kind', () => {
    expect(kindOf(equipment('Bag of Holding', []))).toBe('magicItem');
    expect(kindOf({ ...equipment('Club', []), doc: { system: { type: { value: 'simpleM' }, properties: [] } }, type: 'weapon' })).toBe('weapon');
    const r = filterRecords([equipment('Not An Item', []), equipment('Bag of Holding', [])], indexFromJson({ ...INDEX, magicItems: [mi('Bag of Holding', [])] }), ['magicItem']);
    expect([r.kept.map((k) => k.rec.name), r.drops.map((d) => [d.name, d.reason])]).toEqual([['Bag of Holding'], [['Not An Item', 'not-in-srd-pdf']]]);
  });
});

// ---- the committed pack ------------------------------------------------------------------------------

const PACK = join(REPO_ROOT, 'packs/srd-5.2.1');
const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.yaml') ? [join(d, e.name)] : [])).sort();
const SRD: SourceFile[] = walk(PACK).map((p) => ({ path: p.slice(REPO_ROOT.length + 1), text: readFileSync(p, 'utf8') }));
const TEST_PACK = walk(join(REPO_ROOT, 'packs/test')).filter((p) => !p.includes('/characters/')).map((p) => ({ path: p.slice(REPO_ROOT.length + 1), text: readFileSync(p, 'utf8') }));
const MONSTERS = SRD.filter((f) => f.path.includes('/monsters/')).map((f) => parse(f.text) as Rec);

describe('the 8 hand-written stat blocks (m3.md 4.6): replace: true overrides that compile byte-identically', () => {
  /** hash64(canonicalJson(template)) at M3 step 0, the C3 baseline (packages/engine/test/m3-foundations.test.ts). */
  const BEFORE: Readonly<Record<string, string>> = {
    // Coverage step 9+ moved it on purpose: the hand block's Redirect Attack (a declared reaction) is modeled now (was dd8c594c1a913921); its "Small or Medium ally" minimum size, after review (was 513a0ab7696f21a8).
  'srd:goblin-boss': 'eea945b9643d5e3b', // step E (E1) on purpose: the plain Attack action appended to the Multiattack (was bc35b728647b10f8)
    'srd:goblin-minion': '6b886f193a87b6e2',
    'srd:goblin-warrior': '909688cbe8c90553',
    'srd:guard': '16fb2945af1230af',
    // Re-stamped after step 6 (was c408cc30524afe8b): its stat block's Frightened immunity is now data
    // (conditionImmune, srd-raw.txt:50602); only moonbeam-moved-then-turn-end's golden headers moved.
    // Coverage step 9+ moved it on purpose: the hand block's Parry (a hitKnown reaction) is modeled now (was 120d0882a16d25c4).
  'srd:knight': '4926b898de6a6184', // step E (E1), the same (was 5f8a47cb0d2c6d91)
    // Coverage step 9+ moved it on purpose: the hand block's Pack Tactics (a passive gated Advantage) is modeled now (was b0d86948d0e98c8d).
  'srd:tough': '34bc14f1f13f7ee0',
    // Coverage step 9+ moved it on purpose: the hand block's Pack Tactics (a passive gated Advantage) is modeled now (was 8c2e1496adb461de).
  'srd:warrior-infantry': 'c9a5f69b1f5b48cd',
    // Coverage step 9+ moved it on purpose: the hand block's Parry (a hitKnown reaction) is modeled now (was 73fa7ed700c4e3e6).
  'srd:warrior-veteran': '2788101b02163e23', // step E (E1), the same (was b8827e5635ceb995)
  };
  const content = loadContent(SRD).content!;
  for (const id of Object.keys(BEFORE)) {
    it(`${id}: its override is replace: true with the PDF page, and its template hashes as before the move`, () => {
      const ov = loadOverrides().find((o) => o.id === id)!;
      expect([ov.kind, ov.replace, (ov.body.provenance as Rec).review, typeof (ov.body.provenance as Rec).pdfPage]).toEqual(['monster', true, 'reviewed', 'number']);
      expect(readFileSync(join(PACK, 'monsters', `${id.slice(4)}.yaml`), 'utf8').startsWith('# GENERATED by tools/import-srd')).toBe(true);
      expect(hash64(canonicalJson(content.get(id)))).toBe(BEFORE[id]);
    });
  }
});

describe('C4: no actor outside the PDF stat-block headers is emitted; every monster fights', () => {
  const heads = new Map((INDEX.monsters ?? []).map((m) => [m.name, m.page]));
  it('the index has 336 stat-block headers and 331 blocks that parse whole (326 before coverage C0 read the lycanthropes\' and the insect swarm\'s speeds)', () => {
    expect([INDEX.monsters?.length, INDEX.monsterDetails?.length]).toEqual([336, 331]);
  });

  it('every committed monster names a stat-block header and sits on its page', () => {
    expect(MONSTERS.length).toBeGreaterThan(300);
    for (const m of MONSTERS) {
      expect(heads.has(m.name as string), `${String(m.id)} is not a PDF stat block`).toBe(true);
      expect(String(m.source)).toContain(`p.${heads.get(m.name as string)}`);
    }
  });

  it('every committed magic item names a "Magic Items A–Z" header (a +N family by its base name)', () => {
    const names = new Set((INDEX.magicItems ?? []).map((m) => m.name));
    const items = SRD.filter((f) => /\/features\/[^/]+\.yaml$/.test(f.path)).map((f) => parse(f.text) as Rec);
    expect(items.length).toBeGreaterThan(200);
    for (const it of items) {
      const n = String(it.name).replace(/^(.+), \+\d$/, '$1, +1, +2, or +3');
      expect(names.has(n), String(it.id)).toBe(true);
    }
  });

  it('every emitted monster compiles and fights one round against a dummy in a scratch scenario', () => {
    const r = loadContent([...SRD, ...TEST_PACK]);
    if (!r.content) throw new Error(r.errors.slice(0, 5).map(formatDiag).join('\n'));
    let fought = 0;
    for (const m of MONSTERS) {
      const id = m.id as string;
      const doc = { kind: 'scenario', id: 'smoke', name: 'Smoke', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: { w: 8, h: 3 }, knobs: { maxRounds: 1 }, units: [
        { seat: 'm', team: 'enemies', use: id, at: 'B2' },
        { seat: 'dummy', team: 'party', use: 'test:training-dummy', at: 'D2' },
      ] };
      const s = resolveScenario(doc, 'smoke.yaml', r.content);
      if (!s.setup) throw new Error(`${id}: ${s.errors.map(formatDiag).join('; ')}`);
      const res = runFight(s.setup, 1, 0, makeDeciders(s.setup), null);
      expect(res, id).toBeDefined();
      fought++;
    }
    expect(fought).toBe(MONSTERS.length);
  }, 120_000);
});

describe('a character carrying a magic item (features:) gets its bonus in the fight', () => {
  it('Ring of Protection: AC +1 on the fighter in chain mail and a shield', () => {
    const base = readFileSync(join(REPO_ROOT, 'packs/test/characters/sample-fighter-built.yaml'), 'utf8').replace(/^id: .*$/m, 'id: test:ringed');
    const ac = (text: string) => {
      const r = loadContent([...SRD, ...TEST_PACK, { path: 'packs/test/characters/ringed.yaml', text }]);
      if (!r.content) throw new Error(r.errors.map(formatDiag).join('\n'));
      const doc = { kind: 'scenario', id: 'st', name: 'ST', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: { w: 6, h: 3 }, units: [
        { seat: 'pc1', team: 'party', use: 'test:ringed', at: 'B2' },
        { seat: 'dummy', team: 'enemies', use: 'test:training-dummy', at: 'E2' },
      ] };
      const s = resolveScenario(doc, 'st.yaml', r.content);
      if (!s.setup) throw new Error(s.errors.map(formatDiag).join('\n'));
      const cx = createContext(s.setup, 1, 0, makeDeciders(s.setup), null);
      applyPassives(cx, -1);
      return acNow(cx.st.units.find((u) => u.seat === 'pc1')!, cx.st);
    };
    expect(ac(`${base}features: [srd:ring-of-protection]\n`) - ac(base)).toBe(1);
    expect(ac(`${base}features: [srd:armor-plus-2]\n`) - ac(base)).toBe(2);
    expect(ac(`${base}features: [srd:bracers-of-defense]\n`) - ac(base)).toBe(0); // armored and a shield: the gates don't hold
  });
});
