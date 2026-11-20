// Coverage step 7.6: area saves in stat blocks as monster actions (pdf/monsters.ts parseSaveArea,
// map/monster.ts monsterAreaAction). Only the damage-only form the PDF prints whole maps; anything with a
// rider keeps its "not modeled" line. No cache, no network, no home dir.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildMonster, monsterAreaAction } from '../map/monster.ts';
import type { SrdIndex } from '../pdf/build.ts';
import { parseEntry, parseSaveArea, type MonsterDetail } from '../pdf/monsters.ts';
import { REPO_ROOT } from '../util.ts';

type Rec = Record<string, unknown>;
const INDEX = JSON.parse(readFileSync(join(REPO_ROOT, 'tools/import-srd/srd-index.json'), 'utf8')) as SrdIndex;
const detail = (name: string): MonsterDetail => INDEX.monsterDetails!.find((m) => m.name === name)!;
const yamlOf = (id: string): Rec => parse(readFileSync(join(REPO_ROOT, 'packs/srd-5.2.1/monsters', `${id}.yaml`), 'utf8')) as Rec;
const COLD = 'Constitution Saving Throw: DC 12, each creature in a 15-foot Cone. Failure: 22 (5d8) Cold damage. Success: Half damage.';

describe('parseSaveArea', () => {
  it('a Cone, a Line (with the PDF\'s two line-break artifacts) and a Sphere at range', () => {
    expect(parseSaveArea(COLD)).toEqual({ shape: 'cone', size: 15, damage: [{ avg: 22, dice: '5d8', type: 'cold', ifAdvantage: false }] });
    for (const w of ['5-foot-wide', '5-foot- wide', '5-footwide']) {
      expect(parseSaveArea(`Dexterity Saving Throw: DC 14, each creature in a 60-foot-long, ${w} Line. Failure: 33 (6d10) Lightning damage. Success: Half damage.`)).toMatchObject({ shape: 'line', size: 60, width: 5 });
    }
    expect(parseSaveArea('Dexterity Saving Throw: DC 18, each creature in a 20-foot-radius Sphere centered on a point the dragon can see within 120 feet. Failure: 28 (8d6) Fire damage. Success: Half damage.')).toMatchObject({ shape: 'sphere', size: 20, rangeFt: 120 });
  });
  it.each([
    ['a condition on a failure', 'Constitution Saving Throw: DC 12, each creature in a 15-foot Cone. Failure: 22 (5d8) Cold damage, and the target has the Paralyzed condition. Success: Half damage.'],
    ['a sentence after the damage', 'Constitution Saving Throw: DC 12, each creature in a 15-foot Cone. Failure: 22 (5d8) Cold damage. The target can\'t take Reactions. Success: Half damage.'],
    ['text after Half damage', `${COLD} Failure or Success: The target is pushed 10 feet.`],
    ['no half', 'Constitution Saving Throw: DC 12, each creature in a 15-foot Cone. Failure: 22 (5d8) Cold damage.'],
    ['a condition and no damage', 'Wisdom Saving Throw: DC 12, each creature in a 15-foot Cone. Failure: The target has the Incapacitated condition until the end of its next turn.'],
    ['each creature that can see', 'Wisdom Saving Throw: DC 13, each creature in a 60-foot Cone that can see the ghost and isn\'t an Undead. Failure: 10 (4d4) Psychic damage. Success: Half damage.'],
    ['objects too', 'Dexterity Saving Throw: DC 18, each creature and each object that isn\'t being worn or carried in a 30-foot Cone. Failure: 28 (8d6) Fire damage. Success: Half damage.'],
    ['an Emanation', 'Dexterity Saving Throw: DC 11, each creature in a 5-foot Emanation originating from the mote. Failure: 4 (1d8) Fire damage. Success: Half damage.'],
    ['a Cylinder', 'Dexterity Saving Throw: DC 15, each creature in a 10-foot-radius, 40-foot-high Cylinder originating from a point the giant can see within 90 feet. Failure: 28 (8d6) Fire damage. Success: Half damage.'],
    ['one target', 'Dexterity Saving Throw: DC 12, one creature the troll can see within 60 feet. Failure: 22 (5d8) Fire damage. Success: Half damage.'],
    ['only some enemies', 'Dexterity Saving Throw: DC 15, each enemy in a 20-foot-radius Sphere centered on a point the planetar can see within 90 feet. Failure: 22 (5d8) Fire damage. Success: Half damage.'],
  ])('refuses %s', (_why, body) => {
    expect(parseSaveArea(body)).toBeUndefined();
  });
  it('parseEntry carries it, with the usage, and more only without it', () => {
    const e = parseEntry(`Cold Breath (Recharge 5–6). ${COLD}`);
    expect([e.usage, e.save, e.more, e.saveArea?.shape]).toEqual(['recharge-5-6', { ability: 'con', dc: 12 }, false, 'cone']);
    const r = parseEntry('Sleep Breath (Recharge 5–6). Constitution Saving Throw: DC 12, each creature in a 15-foot Cone. Failure: The target has the Incapacitated condition.');
    expect([r.saveArea, r.more]).toEqual([undefined, true]);
  });
});

describe('monsterAreaAction', () => {
  const d = detail('White Dragon Wyrmling');
  const entry = (text: string) => parseEntry(text);
  it('the wyrmling\'s breath, as the PDF prints it (srd-raw.txt:56054-56056)', () => {
    expect(monsterAreaAction(d, entry(`Cold Breath (Recharge 5–6). ${COLD}`))).toEqual({
      id: 'cold-breath', name: 'Cold Breath', cost: 'action', uses: { recharge: [5, 6] }, area: 'area',
      effects: [{ id: 'area', name: 'Cold Breath', zone: { shape: 'cone', size: 15 }, duration: { rounds: 1 }, on: [{ when: ['appear'], do: [{ save: { ability: 'con', dc: 12, half: true, damage: [{ roll: '5d8', type: 'cold' }] } }] }] }],
      do: [{ apply: { effect: 'area', to: 'point' } }],
    });
  });
  it('Recharge 6 is [6]; at will has no uses; a Sphere carries its range', () => {
    expect(monsterAreaAction(d, entry(`Cold Breath (Recharge 6). ${COLD}`))?.uses).toEqual({ recharge: [6] });
    expect(monsterAreaAction(d, entry(`Cold Breath. ${COLD}`))?.uses).toBeUndefined();
    expect(monsterAreaAction(d, entry('Blast. Dexterity Saving Throw: DC 12, each creature in a 20-foot-radius Sphere centered on a point within 60 feet. Failure: 7 (2d6) Fire damage. Success: Half damage.'))).toMatchObject({ range: 60, effects: [{ zone: { shape: 'sphere', radius: 20 } }] });
  });
  it('a per-day or form-limited use stays a line', () => {
    expect(monsterAreaAction(d, entry(`Cold Breath (2/Day). ${COLD}`))).toBeUndefined();
    expect(monsterAreaAction(d, entry(`Cold Breath (Wolf Form Only). ${COLD}`))).toBeUndefined();
  });
  it('a printed average that isn\'t the dice\'s mean stays a line: no number is corrected', () => {
    expect(monsterAreaAction(d, entry(`Cold Breath (Recharge 5–6). ${COLD.replace('22 (5d8)', '23 (5d8)')}`))).toBeUndefined();
  });
  it('a DC no ability gives stays a line', () => {
    expect(monsterAreaAction(d, entry(`Cold Breath (Recharge 5–6). ${COLD.replace('DC 12', 'DC 19')}`))).toBeUndefined();
  });
});

describe('the committed pack', () => {
  const files = readdirSync(join(REPO_ROOT, 'packs/srd-5.2.1/monsters')).map((f) => f.replace('.yaml', ''));
  const withActions = files.map((id) => [id, yamlOf(id)] as const).filter(([, y]) => y.actions !== undefined);
  it('the wyrmling loses its line and gains the action', () => {
    const y = yamlOf('white-dragon-wyrmling');
    expect(y.unimplemented).not.toContain('monster action cold-breath not modeled (recharge-5-6)');
    expect((y.actions as Rec[]).map((a) => a.id)).toEqual(['cold-breath']);
    expect(y.fidelity).toBe('partial');
  });
  it('a two-breath wyrmling gains only its damage breath; the rider breath stays a line', () => {
    const y = yamlOf('gold-dragon-wyrmling');
    expect((y.actions as Rec[]).map((a) => a.id)).toEqual(['fire-breath']);
    expect(y.unimplemented).toContain('monster action weakening-breath not modeled');
  });
  it('every mapped action is Recharge or at will, cone, line or sphere, and no monster that has one is full', () => {
    expect(withActions.length).toBeGreaterThan(0);
    for (const [id, y] of withActions) {
      expect(y.fidelity, id).toBe('partial');
      for (const a of y.actions as Rec[]) {
        expect(a.uses === undefined || 'recharge' in (a.uses as Rec), id).toBe(true);
        expect(['cone', 'line', 'sphere'], id).toContain(((a.effects as Rec[])[0]!.zone as Rec).shape);
      }
    }
  });
  it('no bench or hand-written block carries one (tools/bench-core.ts:70-83)', () => {
    for (const id of ['goblin-warrior', 'tough', 'berserker', 'guard-captain', 'knight', 'gladiator', 'goblin-boss', 'warrior-veteran']) expect(yamlOf(id).actions, id).toBeUndefined();
  });
  it('review.json lists each one, the PDF\'s numbers, and buildMonster agrees with the index', () => {
    const review = JSON.parse(readFileSync(join(REPO_ROOT, 'tools/import-srd/review.json'), 'utf8')) as { monsters: { areaActions: Rec[] } };
    const rows = review.monsters.areaActions;
    expect(rows.length).toBe(withActions.reduce((n, [, y]) => n + (y.actions as Rec[]).length, 0));
    expect(rows.find((r) => r.monster === 'srd:white-dragon-wyrmling')).toEqual({ monster: 'srd:white-dragon-wyrmling', action: 'cold-breath', usage: 'recharge-5-6', shape: 'cone', size: 15, dc: 12, dice: '5d8', type: 'cold' });
    const b = buildMonster(detail('White Dragon Wyrmling'), INDEX);
    expect('item' in b && (b.item.actions as Rec[]).length).toBe(1);
  });
});
