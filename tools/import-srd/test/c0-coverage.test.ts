// Coverage C0, the importer-only fixes (docs/design/coverage.md section 4 and Critique
// resolutions X1): the stat-block parser's printed variants and Multiattack forms, the printed
// to-hit that isn't STR or DEX + PB, the monster check (every emitted attack equals its PDF
// block; no monster at CR 10 or below whose block has an attack roll is inert, but a closed list
// with reasons), and the T relabel (mechanizedBy on the features the class table or the
// character expansion already mechanizes). No cache, no network, no home dir.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { MECHANIZED_BY } from '../../../packages/engine/src/content/schema.ts';
import { buildMonster, crNumber } from '../map/monster.ts';
import { applyOverride, loadOverrides, parseOverride } from '../overrides.ts';
import type { SrdIndex } from '../pdf/build.ts';
import type { Line } from '../pdf/lines.ts';
import { parseBlock, parseEntry, parseHit, usageToken, type MonsterDetail, type MonsterEntry } from '../pdf/monsters.ts';
import { U } from '../unimplemented.ts';
import { REPO_ROOT } from '../util.ts';

type Rec = Record<string, unknown>;
const INDEX = JSON.parse(readFileSync(join(REPO_ROOT, 'tools/import-srd/srd-index.json'), 'utf8')) as SrdIndex;
const PACK = join(REPO_ROOT, 'packs/srd-5.2.1');
const yamlDir = (d: string): Rec[] => readdirSync(join(PACK, d)).filter((f) => f.endsWith('.yaml')).sort().map((f) => parse(readFileSync(join(PACK, d, f), 'utf8')) as Rec);
const MONSTERS = yamlDir('monsters');
const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.yaml') ? [join(d, e.name)] : []));
const FEATURES = walk(join(PACK, 'features')).map((p) => parse(readFileSync(p, 'utf8')) as Rec);

/** A stat block as bbox lines in the SRD 5.2.1 styles (as step6-monsters.test.ts builds them). */
function blockLines(o: { speed?: string; abilities?: string[]; actions?: { h: number; text: string }[] } = {}): Line[] {
  const out: Line[] = [];
  let y = 40;
  const at = (h: number, text: string) => out.push({ page: 400, col: 0, x: 63, y: (y += 12), h, text });
  at(17.9, 'Test Beast');
  at(10.7, 'Medium Humanoid, Neutral');
  for (const f of ['AC 13', 'Initiative +1 (11)', 'HP 11 (2d8 + 2)', `Speed ${o.speed ?? '30 ft.'}`]) at(10.7, f);
  at(6.9, 'MOD SAVE');
  for (const a of o.abilities ?? ['Str 14 +2 +2', 'Dex 12 +1 +1', 'Con 12 +1 +1', 'Int 10 +0 +0', 'Wis 16 +3 +3', 'Cha 16 +3 +3']) at(11.6, a);
  at(10.7, 'Senses Passive Perception 10');
  at(10.7, 'Languages Common');
  at(10.7, 'CR 1/2 (XP 100; PB +2)');
  at(13.9, 'Actions');
  for (const e of o.actions ?? [{ h: 11.4, text: 'Club. Melee Attack Roll: +4, reach 5 ft. Hit: 5 (1d6 + 2) Bludgeoning damage.' }]) at(e.h, e.text);
  return out;
}
const block = (o: Parameters<typeof blockLines>[0]): MonsterDetail => parseBlock(blockLines(o));

describe('pdf/monsters.ts: the printed attack variants C0 reads (each was a lost attack before)', () => {
  it('"reach 5 feet." and "range 120 feet." (Djinni, Eagle, Giant Rat)', () => {
    expect(parseEntry('Talons. Melee Attack Roll: +4, reach 5 feet. Hit: 4 (1d4 + 2) Slashing damage.').attack).toMatchObject({ kind: 'melee', toHit: 4, reach: 5 });
    expect(parseEntry('Storm Bolt. Ranged Attack Roll: +9, range 120 feet. Hit: 13 (3d8) Thunder damage.').attack).toMatchObject({ kind: 'ranged', range: [120, 120] });
  });

  it('a single range is [n, n]: no long range and no attack beyond it (srd-raw.txt:2044-2049)', () => {
    expect(parseEntry('Radiant Flame. Ranged Attack Roll: +4, range 60 ft. Hit: 7 (2d6) Radiant damage.').attack).toMatchObject({ kind: 'ranged', range: [60, 60] });
    expect(parseEntry('Arcane Burst. Melee or Ranged Attack Roll: +6, reach 5 ft. or range 120 ft. Hit: 16 (3d8 + 3) Force damage.').attack).toMatchObject({ kind: 'meleeOrRanged', reach: 5, range: [120, 120] });
  });

  it('"+17 to hit" (Ancient Gold Dragon) and "reach 5 ft or range" without its period (the Werebear\'s Handaxe)', () => {
    expect(parseEntry('Rend. Melee Attack Roll: +17 to hit, reach 15 ft. Hit: 19 (2d8 + 10) Slashing damage plus 9 (2d8) Fire damage.').attack).toMatchObject({ toHit: 17, reach: 15 });
    expect(parseEntry('Handaxe. Melee or Ranged Attack Roll: +7, reach 5 ft or range 20/60 ft. Hit: 14 (3d6 + 4) Slashing damage.').attack).toMatchObject({ reach: 5, range: [20, 60] });
  });

  it('"+5 (with Advantage if ...)" after the to-hit is advantageIf (Ankheg, the bugbears, the sharks)', () => {
    const e = parseEntry('Bite. Melee Attack Roll: +9 (with Advantage if the target doesn\'t have all its Hit Points), reach 5 ft. Hit: 22 (3d10 + 6) Piercing damage.');
    expect(e).toMatchObject({ attack: { toHit: 9, advantageIf: true }, more: false });
    expect(parseEntry('Club. Melee Attack Roll: +4, reach 5 ft. Hit: 5 (1d6 + 2) Bludgeoning damage.').attack!.advantageIf).toBeUndefined();
  });

  it('"X damage—or Y damage if ...—plus Z damage" is X plus Z, with the alternative as more text (the snakes kept only X before C0)', () => {
    expect(parseHit('8 (1d8 + 4) Piercing damage—or 6 (1d4 + 4) Piercing damage if the swarm is Bloodied—plus 10 (3d6) Poison damage.')).toEqual({
      damage: [
        { avg: 8, dice: '1d8 + 4', type: 'piercing', ifAdvantage: false },
        { avg: 10, dice: '3d6', type: 'poison', ifAdvantage: false },
      ],
      more: true,
    });
  });

  it('an attack roll that still doesn\'t parse is marked attackRoll (Half-Dragon\'s chosen damage type, the Roper\'s damage-less Tentacle)', () => {
    expect(parseEntry('Claw. Melee Attack Roll: +7, reach 10 ft. Hit: 6 (1d4 + 4) Slashing damage plus 7 (2d6) damage of the type chosen for the Draconic Origin trait.')).toMatchObject({ more: true, attackRoll: true });
    expect(parseEntry('Tentacle. Melee Attack Roll: +7, reach 60 ft. Hit: The target has the Grappled condition (escape DC 14).')).toMatchObject({ more: true, attackRoll: true });
    expect(parseEntry('Fire Breath (Recharge 5–6). Dexterity Saving Throw: DC 21, each creature in a 60-foot Cone.').attackRoll).toBeUndefined();
  });

  it('a form limit in the name is form-<forms> (the lycanthropes, the Vampire, the Mimic)', () => {
    expect(['Humanoid or Hybrid Form Only', 'Wolf or Hybrid Form Only', 'Vampire Form Only', 'Bat or Vampire Form Only'].map(usageToken)).toEqual(['form-humanoid-hybrid', 'form-wolf-hybrid', 'form-vampire', 'form-bat-vampire']);
  });

  it('a name alone on its line opens an entry when the next line opens an attack roll (the Wererat\'s Hand Crossbow, srd-raw.txt:55849-55851)', () => {
    const d = block({
      actions: [
        { h: 11.4, text: 'Scratch. Melee Attack Roll: +5, reach 5 ft. Hit: 6 (1d6' },
        { h: 11.3, text: '+ 3) Slashing damage.' },
        { h: 11.3, text: 'Hand Crossbow (Humanoid or Hybrid Form Only).' },
        { h: 11.3, text: 'Ranged Attack Roll: +5, range 30/120 ft. Hit: 6 (1d6' },
        { h: 11.3, text: '+ 3) Piercing damage.' },
      ],
    });
    expect(d.actions.map((e) => [e.name, e.usage, e.attack?.toHit, e.more])).toEqual([
      ['Scratch', undefined, 5, false],
      ['Hand Crossbow', 'form-humanoid-hybrid', 5, false],
    ]);
  });

  it('a speed for another form only, or of the GM\'s kind, is a flag, not a number (srd-raw.txt:55921, 59742)', () => {
    expect(block({ speed: '30 ft., 40 ft. (wolf form only)' }).speed).toEqual({ walk: 30, formOnly: true });
    expect(block({ speed: '30 ft., 40 ft. (bear form only), Climb 30 ft. (bear form only)' }).speed).toEqual({ walk: 30, formOnly: true });
    expect(block({ speed: '20 ft., Climb or Fly 20 ft. (GM’s choice)' }).speed).toEqual({ walk: 20, choice: true });
  });
});

describe('pdf/monsters.ts: the Multiattack forms C0 adds', () => {
  const own = ['Scimitar', 'Pistol', 'Claws', 'Tail', 'Hurl Flame', 'Bite', 'Devilish Claw', 'Fiery Mace', 'Javelin', 'Morningstar', 'Pincer', 'Slam', 'Vine Lash', 'Thorn Burst'];
  const ma = (t: string): MonsterEntry => parseEntry(`Multiattack. ${t}`, own);
  it('"using A and B in any combination" (Bandit Captain, Scout)', () => {
    expect(ma('The bandit makes two attacks, using Scimitar and Pistol in any combination.').multiattack).toEqual({ groups: [{ count: 2, from: ['Scimitar', 'Pistol'] }] });
  });
  it('three or more comma-listed groups (Pit Fiend)', () => {
    expect(ma('The pit fiend makes one Bite attack, two Devilish Claw attacks, and one Fiery Mace attack.').multiattack).toEqual({ groups: [{ count: 1, from: ['Bite'] }, { count: 2, from: ['Devilish Claw'] }, { count: 1, from: ['Fiery Mace'] }] });
  });
  it('", or it makes ..." is a second alternative (Barbed Devil, Medusa)', () => {
    expect(ma('The devil makes one Claws attack and one Tail attack, or it makes two Hurl Flame attacks.').multiattack).toEqual({ groups: [{ count: 1, from: ['Claws'] }, { count: 1, from: ['Tail'] }], orGroups: [[{ count: 2, from: ['Hurl Flame'] }]] });
  });
  it('"two A or B attacks" is two alternatives of the same attack (sameAttack); with one attack there is nothing to read', () => {
    expect(ma('The bugbear makes two Javelin or Morningstar attacks.').multiattack).toEqual({ groups: [{ count: 2, from: ['Javelin'] }], orGroups: [[{ count: 2, from: ['Morningstar'] }]], sameAttack: true });
    expect(ma('The dryad makes one Vine Lash or Thorn Burst attack, and it can use Spellcasting to cast Charm Monster.')).toMatchObject({ multiattack: { groups: [{ count: 1, from: ['Vine Lash'] }], orGroups: [[{ count: 1, from: ['Thorn Burst'] }]] }, more: true });
    expect(ma('The dryad makes one Vine Lash or Thorn Burst attack.').multiattack!.sameAttack).toBeUndefined();
  });
  it('"... and uses X" keeps the attacks and marks the rest (Chuul, Mummy)', () => {
    expect(ma('The chuul makes two Pincer attacks and uses Paralyzing Tentacles.')).toMatchObject({ multiattack: { groups: [{ count: 2, from: ['Pincer'] }] }, more: true });
  });
  it('still not parsed: a conditional count, an unknown name, a non-attack alternative', () => {
    expect(ma('The golem makes two Slam attacks, or it makes three Slam attacks if it used Hasten this turn.').multiattack).toBeUndefined();
    expect(ma('The thing makes two Tentacle attacks.').multiattack).toBeUndefined();
    expect(ma('The planetar makes three Slam attacks or uses Holy Burst twice.').multiattack).toBeUndefined();
  });
});

describe('map/monster.ts: what C0 maps', () => {
  const build = (o: Parameters<typeof blockLines>[0]) => {
    const b = buildMonster(block(o));
    if ('skip' in b) throw new Error(b.skip);
    return b;
  };
  it('a printed to-hit that is neither STR nor DEX + PB maps when exactly one other ability + PB equals it (toHitAbility)', () => {
    // WIS 16 (+3) + PB 2 = +5; CHA is also +3, so +5 has two readings: not emitted.
    const two = build({ actions: [{ h: 11.4, text: 'Vine Staff. Melee Attack Roll: +5, reach 5 ft. Hit: 7 (1d8 + 3) Bludgeoning damage.' }] });
    expect([two.item.attacks, two.lines]).toEqual([undefined, [U.monsterAttackToHit('vine-staff')]]);
    const one = build({
      abilities: ['Str 10 +0 +0', 'Dex 12 +1 +1', 'Con 10 +0 +0', 'Int 10 +0 +0', 'Wis 16 +3 +3', 'Cha 10 +0 +0'],
      actions: [{ h: 11.4, text: 'Vine Staff. Melee Attack Roll: +5, reach 5 ft. Hit: 7 (1d8 + 3) Bludgeoning damage.' }],
    });
    expect([one.item.attacks, one.lines]).toEqual([[{ id: 'vine-staff', name: 'Vine Staff', kind: 'melee', toHit: 5, toHitAbility: 'wis', reach: 5, damage: [{ roll: '1d8 + 3', type: 'bludgeoning', avg: 7 }] }], []]);
    const none = build({ actions: [{ h: 11.4, text: 'Odd. Melee Attack Roll: +9, reach 5 ft. Hit: 7 (1d8 + 3) Bludgeoning damage.' }] });
    expect(none.lines).toEqual([U.monsterAttackToHit('odd')]);
  });
  it('a conditional Advantage is a line; a single-range Melee or Ranged attack isn\'t a thrown weapon', () => {
    const b = build({
      actions: [
        { h: 11.4, text: 'Bite. Melee Attack Roll: +4 (with Advantage if the target is Grappled by the beast), reach 5 ft. Hit: 5 (1d6 + 2) Piercing damage.' },
        { h: 11.4, text: 'Burst. Melee or Ranged Attack Roll: +5, reach 5 ft. or range 120 ft. Hit: 10 (3d6) Force damage.' },
      ],
      abilities: ['Str 14 +2 +2', 'Dex 12 +1 +1', 'Con 12 +1 +1', 'Int 16 +3 +3', 'Wis 10 +0 +0', 'Cha 10 +0 +0'],
    });
    expect(b.lines.sort()).toEqual([U.monsterAttackAdvantageIf('bite')]);
    expect((b.item.attacks as Rec[]).map((a) => [a.id, a.range, a.thrownGear, a.toHitAbility])).toEqual([['bite', undefined, undefined, undefined], ['burst', [120, 120], undefined, 'int']]);
  });
  it('an attack limited to forms with the humanoid one maps; another form\'s doesn\'t', () => {
    const b = build({
      speed: '30 ft., 40 ft. (wolf form only)',
      actions: [
        { h: 11.4, text: 'Bite (Wolf or Hybrid Form Only). Melee Attack Roll: +4, reach 5 ft. Hit: 12 (2d8 + 3) Piercing damage.' },
        { h: 11.4, text: 'Longbow (Humanoid or Hybrid Form Only). Ranged Attack Roll: +3, range 150/600 ft. Hit: 11 (2d8 + 2) Piercing damage.' },
      ],
    });
    expect((b.item.attacks as Rec[]).map((a) => a.id)).toEqual(['longbow']);
    expect(b.lines.sort()).toEqual([U.monsterEntry('action', 'bite', 'form-wolf-hybrid'), U.monsterSpeedOther('form')].sort());
  });
  it('review R4: "two attacks, using A or B in any combination" with B limited to another form is two A attacks (the Werebear, the Wereboar)', () => {
    const b = build({
      actions: [
        { h: 11.4, text: 'Multiattack. The beast makes two attacks, using Handaxe or Rend in any combination.' },
        { h: 11.4, text: 'Handaxe (Humanoid or Hybrid Form Only). Melee Attack Roll: +4, reach 5 ft. Hit: 5 (1d6 + 2) Slashing damage.' },
        { h: 11.4, text: 'Rend (Bear or Hybrid Form Only). Melee Attack Roll: +4, reach 5 ft. Hit: 6 (1d8 + 2) Slashing damage.' },
      ],
    });
    expect(b.item.multiattack).toEqual({ alternatives: [[{ count: 2, from: ['handaxe'] }]] });
    expect(b.lines).not.toContain(U.monsterMultiattack());
    // An unparsed attack (not a form limit) still blocks the Multiattack.
    const bad = build({
      actions: [
        { h: 11.4, text: 'Multiattack. The beast makes two attacks, using Handaxe or Rend in any combination.' },
        { h: 11.4, text: 'Handaxe (Humanoid or Hybrid Form Only). Melee Attack Roll: +4, reach 5 ft. Hit: 5 (1d6 + 2) Slashing damage.' },
        { h: 11.4, text: 'Rend. Melee Attack Roll: +4, reach 5 ft. Hit: a lot of Slashing damage.' },
      ],
    });
    expect(bad.item.multiattack).toBeUndefined();
    for (const [id, atk] of [['srd:werebear', 'handaxe'], ['srd:wereboar', 'javelin']] as const) {
      const m = MONSTERS.find((x) => x.id === id)!;
      expect(m.multiattack, id).toEqual({ alternatives: [[{ count: 2, from: [atk] }]] });
      expect(m.unimplemented as string[], id).not.toContain(U.monsterMultiattack());
    }
  });
  it('"two A or B attacks" maps as alternatives with its reading line', () => {
    const b = build({
      actions: [
        { h: 11.4, text: 'Multiattack. The beast makes two Club or Sling attacks.' },
        { h: 11.4, text: 'Club. Melee Attack Roll: +4, reach 5 ft. Hit: 5 (1d6 + 2) Bludgeoning damage.' },
        { h: 11.4, text: 'Sling. Ranged Attack Roll: +3, range 30/120 ft. Hit: 3 (1d4 + 1) Bludgeoning damage.' },
      ],
    });
    expect(b.item.multiattack).toEqual({ alternatives: [[{ count: 2, from: ['club'] }], [{ count: 2, from: ['sling'] }]] });
    expect(b.lines).toEqual([U.monsterMultiattackSameAttack()]);
  });
});

/** The PDF entries of a stat block, every section. */
const entriesOf = (d: MonsterDetail): MonsterEntry[] => [...d.traits, ...d.actions, ...d.bonusActions, ...d.reactions, ...d.legendaryActions];
const detailOf = new Map((INDEX.monsterDetails ?? []).map((d) => [d.name, d]));

describe('the committed pack against the PDF index (the C0 monster check)', () => {
  it('every emitted monster attack equals its stat block\'s entry: kind, to-hit, reach, range and every damage part', () => {
    let n = 0;
    for (const m of MONSTERS) {
      const d = detailOf.get(m.name as string);
      expect(d, String(m.id)).toBeDefined();
      for (const a of (m.attacks as Rec[] | undefined) ?? []) {
        const e = d!.actions.find((x) => x.name === a.name && x.attack);
        expect(e, `${String(m.id)} ${String(a.id)}`).toBeDefined();
        const p = e!.attack!;
        const want = {
          kind: p.kind,
          toHit: p.toHit,
          reach: p.kind === 'ranged' ? undefined : (p.reach ?? 5),
          range: p.range ? [...p.range] : undefined,
          damage: p.damage.map((x) => ({ roll: x.dice, type: x.type, avg: x.avg, ...(x.ifAdvantage ? { ifAdvantage: true } : {}) })),
        };
        const got = { kind: a.kind, toHit: a.toHit, reach: a.kind === 'ranged' ? undefined : ((a.reach as number | undefined) ?? 5), range: a.range, damage: a.damage };
        expect(got, `${String(m.id)} ${String(a.id)}`).toEqual(want);
        n++;
      }
    }
    expect(n).toBeGreaterThan(400);
  });

  it('the printed to-hits read through another ability are exactly these (each the only CON/INT/WIS/CHA + PB that sums to it)', () => {
    const got = MONSTERS.flatMap((m) => ((m.attacks as Rec[] | undefined) ?? []).filter((a) => a.toHitAbility).map((a) => `${String(m.id)} ${String(a.id)} ${String(a.toHitAbility)}`)).sort();
    expect(got).toEqual(
      [
        'srd:archmage arcane-burst int',
        'srd:druid-monster verdant-wisp wis',
        'srd:druid-monster vine-staff wis',
        'srd:dryad thorn-burst cha',
        'srd:dryad vine-lash cha',
        'srd:efreeti hurl-flame cha',
        'srd:ghost withering-touch cha',
        'srd:horned-devil hurl-flame cha',
        'srd:incubus restless-touch cha',
        'srd:iron-golem fiery-bolt con',
        'srd:lich eldritch-burst int',
        'srd:lich paralyzing-touch int',
        'srd:mage arcane-burst int',
        'srd:medusa poison-ray cha',
        'srd:rakshasa cursed-touch cha',
        'srd:stone-golem force-bolt con',
        'srd:succubus fiendish-touch cha',
        'srd:violet-fungus rotting-touch con',
        'srd:will-o-wisp shock wis',
      ].sort(),
    );
  });

  // X1(b): monsters that only cast or use save actions wait for the monster-features seam (step 7);
  // these few have an attack roll but stay out, each for a printed reason the importer can't fix exactly.
  const INERT_WITH_REASON: Readonly<Record<string, string>> = {
    'Gray Ooze': 'printed Initiative −2 (13): the score isn\'t 10 + mod (srd-raw.txt:49221), so the block is skipped (pdf-initiative)',
    'Invisible Stalker': 'printed Initiative +7 (22) (srd-raw.txt:50472): skipped (pdf-initiative)',
    'Young White Dragon': 'printed INT save 2 with mod −2 (srd-raw.txt:56086): skipped (pdf-save-odd)',
    'Half-Dragon': 'its one attack\'s second damage part is "of the type chosen for the Draconic Origin trait" (a GM choice): not emitted',
  };
  it('X1: no monster at CR 10 or below whose PDF block has an attack roll is inert, but the closed list above', () => {
    const emitted = new Map(MONSTERS.map((m) => [m.name as string, m]));
    const inert: string[] = [];
    for (const d of INDEX.monsterDetails ?? []) {
      if (crNumber(d.cr) > 10) continue;
      if (!entriesOf(d).some((e) => e.attack || e.attackRoll)) continue;
      const m = emitted.get(d.name);
      if (!m || !((m.attacks as unknown[] | undefined) ?? []).length) inert.push(d.name);
    }
    expect(inert.sort()).toEqual(Object.keys(INERT_WITH_REASON).sort());
  });
});

describe('the T relabel (X1): mechanizedBy on what the class table or the character expansion mechanizes', () => {
  const RELABEL: Readonly<Record<string, string>> = {
    'srd:barbarian/extra-attack': 'extraAttack',
    'srd:fighter/extra-attack': 'extraAttack',
    'srd:monk/extra-attack': 'extraAttack',
    'srd:paladin/extra-attack': 'extraAttack',
    'srd:ranger/extra-attack': 'extraAttack',
    'srd:barbarian/unarmored-defense': 'unarmoredDefense',
    'srd:monk/unarmored-defense': 'unarmoredDefense',
    'srd:barbarian/weapon-mastery': 'weaponMastery',
    'srd:fighter/weapon-mastery': 'weaponMastery',
    'srd:paladin/weapon-mastery': 'weaponMastery',
    'srd:ranger/weapon-mastery': 'weaponMastery',
    'srd:rogue/weapon-mastery': 'weaponMastery',
    'srd:bard/spellcasting': 'spellcasting',
    'srd:cleric/spellcasting': 'spellcasting',
    'srd:druid/spellcasting': 'spellcasting',
    'srd:paladin/spellcasting': 'spellcasting',
    'srd:ranger/spellcasting': 'spellcasting',
    'srd:sorcerer/spellcasting': 'spellcasting',
    'srd:wizard/spellcasting': 'spellcasting',
    'srd:warlock/pact-magic': 'pactMagic',
    'srd:fighter/fighting-style': 'fightingStyle',
    'srd:paladin/fighting-style': 'fightingStyle',
    'srd:ranger/fighting-style': 'fightingStyle',
    'srd:champion/additional-fighting-style': 'fightingStyle',
  };
  const PROGRAM = ['activate', 'reaction', 'passive', 'initiative', 'riders', 'hp'] as const;
  it('exactly these 24 features carry mechanizedBy, each from a reviewed override on the item\'s own PDF page, with no program', () => {
    const got = Object.fromEntries(FEATURES.filter((f) => f.mechanizedBy !== undefined).map((f) => [f.id as string, f.mechanizedBy as string]));
    expect(got).toEqual(RELABEL);
    const files = new Set(loadOverrides().filter((o) => o.body.mechanizedBy !== undefined).map((o) => o.id));
    for (const f of FEATURES.filter((x) => x.mechanizedBy !== undefined)) {
      const id = f.id as string;
      const p = f.provenance as Rec;
      expect(files.has(id), id).toBe(true);
      expect([id, p.review, `SRD 5.2.1 p.${String(p.pdfPage)}`]).toEqual([id, 'reviewed', f.source]);
      expect(PROGRAM.filter((k) => f[k] !== undefined), id).toEqual([]);
      expect((MECHANIZED_BY as readonly string[]).includes(f.mechanizedBy as string)).toBe(true);
    }
  });
  it('full, but Wizard Spellcasting, which is partial for its spellbook', () => {
    for (const id of Object.keys(RELABEL)) {
      const f = FEATURES.find((x) => x.id === id)!;
      expect([id, f.fidelity, f.unimplemented ?? []]).toEqual(id === 'srd:wizard/spellcasting' ? [id, 'partial', ['part spellbook not modeled']] : [id, 'full', []]);
    }
  });
});

describe('C0 review T6: an override refuses mechanizedBy unless it is reviewed, on its PDF page, on a feature that is not narrative', () => {
  const ctx = { commit: 'c', importer: 1, recordAt: () => undefined };
  const feature = (o: Rec = {}): Rec => ({ kind: 'feature', id: 'srd:x/y', name: 'Y', fidelity: 'partial', unimplemented: ['a line'], provenance: { source: 'foundry-dnd5e', review: 'auto' }, ...o });
  const ov = (rel: string, body: string) => parseOverride(rel, body, `tools/import-srd/overrides/${rel}`);
  const OK = 'mechanizedBy: extraAttack\nfidelity: partial\nprovenance: { review: reviewed, pdfPage: 46 }\n';
  it('accepts the reviewed form', () => {
    expect(applyOverride(feature(), ov('feature/x/y.yaml', OK), ctx).mechanizedBy).toBe('extraAttack');
  });
  it('refuses it on a non-feature', () => {
    const m = { kind: 'monster', id: 'srd:y', name: 'Y', fidelity: 'partial', provenance: { source: 'foundry-dnd5e', review: 'auto' } };
    expect(() => applyOverride(m, ov('monster/y.yaml', OK), ctx)).toThrow(/mechanizedBy is for features only/);
  });
  it('refuses one inherited from the mapped item rather than set by the override', () => {
    expect(() => applyOverride(feature({ mechanizedBy: 'extraAttack' }), ov('feature/x/y.yaml', 'fidelity: partial\nprovenance: { review: reviewed, pdfPage: 46 }\n'), ctx)).toThrow(/must be set by the override itself/);
  });
  it('refuses review auto, and a reviewed one with no pdfPage', () => {
    expect(() => applyOverride(feature(), ov('feature/x/y.yaml', 'mechanizedBy: extraAttack\nfidelity: partial\nprovenance: { review: auto, pdfPage: 46 }\n'), ctx)).toThrow(/mechanizedBy needs provenance.review: reviewed and a pdfPage/);
    expect(() => applyOverride(feature(), ov('feature/x/y.yaml', 'mechanizedBy: extraAttack\nfidelity: partial\nprovenance: { review: reviewed }\n'), ctx)).toThrow(/mechanizedBy needs provenance.review: reviewed and a pdfPage/);
  });
  it('refuses it on a narrative feature', () => {
    expect(() => applyOverride(feature({ fidelity: 'narrative' }), ov('feature/x/y.yaml', 'mechanizedBy: extraAttack\nprovenance: { review: reviewed, pdfPage: 46 }\n'), ctx)).toThrow(/a mechanized feature isn't narrative/);
  });
});
