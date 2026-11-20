// Roll keys and the patterns content uses to say which rolls a modifier applies to. M3a
// (docs/design/m3.md section 3, RKEY) adds ability, weapon/unarmed and opportunity-attack bits
// to attack keys and d20.check.initiative, on top of the M1b layout (critique C3).
import { describe, expect, it } from 'vitest';
import { attackKey, checkKey, compileKeyPattern, DEATH_SAVE_KEY, INITIATIVE_KEY, keyMatches, keyName, saveKey, skillIndex } from '../src/content/rollkeys.ts';
import { unarmedStrike } from '../src/content/compile.ts';
import { ABILITIES } from '../src/content/types.ts';
import { attackKeyOf } from '../src/sim/attack.ts';

const ab = (a: string) => ABILITIES.indexOf(a as (typeof ABILITIES)[number]);
const m = (pattern: string, key: number) => keyMatches(key, compileKeyPattern(pattern));

describe('roll keys', () => {
  const conSave = saveKey(ab('con'));
  const concSave = saveKey(ab('con'), true);
  const perception = checkKey(ab('wis'), skillIndex('perception'));
  const intCheck = checkKey(ab('int'));

  it('the d20 floor pattern covers INT and WIS checks and concentration saves, not other CON saves', () => {
    const floors = ['d20.check.int', 'd20.check.wis', 'd20.save.con.concentration'].map(compileKeyPattern);
    const hit = (k: number) => floors.some((p) => keyMatches(k, p));
    expect([hit(intCheck), hit(perception), hit(concSave)]).toEqual([true, true, true]);
    expect([hit(conSave), hit(saveKey(ab('wis'))), hit(DEATH_SAVE_KEY), hit(attackKey('melee', true))]).toEqual([false, false, false, false]);
  });

  it('broader patterns match narrower keys', () => {
    expect(m('d20', perception)).toBe(true);
    expect(m('d20.save', DEATH_SAVE_KEY)).toBe(true);
    expect(m('d20.save.con', concSave)).toBe(true);
    expect(m('d20.attack', attackKey('ranged', true))).toBe(true);
    expect(m('d20.attack.melee', attackKey('ranged', false))).toBe(false);
    expect(m('d20.attack.spell', attackKey('melee', false))).toBe(false);
    expect(m('d20.check.perception', perception)).toBe(true);
    expect(m('d20.check.wis.perception', checkKey(ab('wis'), skillIndex('insight')))).toBe(false);
    expect(m('d20.save.death', conSave)).toBe(false);
  });

  it('rejects patterns that mean nothing', () => {
    for (const bad of ['d12', 'd20.attack.thrown', 'd20.save.luck', 'd20.save.wis.concentration', 'd20.check.str.perception', 'd20.attack.melee.ranged', 'd20.check.perception.extra']) {
      expect(() => compileKeyPattern(bad), bad).toThrow(RangeError);
    }
  });

  it('names keys for logs', () => {
    expect([keyName(concSave), keyName(DEATH_SAVE_KEY), keyName(perception), keyName(attackKey('melee', true))]).toEqual([
      'save.con.concentration',
      'save.death',
      'check.wis.perception',
      'attack.melee.spell',
    ]);
  });
});

describe('roll keys: M3a bits (RKEY)', () => {
  it('every pre-M3a pattern and key keeps its exact numbers, so compiled templates hash as before (C3)', () => {
    const pats = ['d20', 'd20.attack', 'd20.attack.melee', 'd20.attack.ranged.spell', 'd20.attack.spell', 'd20.save', 'd20.save.con.concentration', 'd20.save.death', 'd20.check', 'd20.check.wis', 'd20.check.wis.perception', 'd20.check.perception'];
    expect(pats.map((p) => { const c = compileKeyPattern(p); return [c.mask, c.val]; })).toEqual([
      [0, 0], [3, 1], [99, 33], [227, 193], [131, 129], [3, 2], [287, 270], [16387, 16386], [3, 3], [31, 23], [15903, 6167], [15903, 6167],
    ]);
    expect([attackKey('melee', false), attackKey('ranged', true), saveKey(ab('con'), true), DEATH_SAVE_KEY, checkKey(ab('wis'), skillIndex('perception'))]).toEqual([33, 193, 270, 16386, 6167]);
  });

  it('a shorter attack pattern still covers a key with every new segment set', () => {
    const full = attackKey('melee', false, { ability: ab('str'), source: 'unarmed', opportunity: true });
    for (const p of ['d20', 'd20.attack', 'd20.attack.melee', 'd20.attack.str', 'd20.attack.unarmed', 'd20.attack.opportunity', 'd20.attack.melee.str.unarmed.opportunity', 'd20.attack.opportunity.unarmed.melee']) {
      expect(m(p, full), p).toBe(true);
    }
    for (const p of ['d20.save', 'd20.check', 'd20.check.str', 'd20.save.str', 'd20.attack.ranged', 'd20.attack.spell']) expect(m(p, full), p).toBe(false);
  });

  it('an attack ability pattern matches that ability and not a sibling, nor an attack with no ability recorded', () => {
    const strAtk = attackKey('melee', false, { ability: ab('str') });
    expect([m('d20.attack.str', strAtk), m('d20.attack.dex', strAtk), m('d20.attack.str', attackKey('melee', false))]).toEqual([true, false, false]);
    // A save or check pattern on the same ability never matches an attack: the kind is masked too.
    expect([m('d20.save.str', strAtk), m('d20.check.str', strAtk)]).toEqual([false, false]);
  });

  it('weapon, spell and unarmed patterns each match only their own source', () => {
    const keys = { weapon: attackKey('melee', false, { source: 'weapon' }), spell: attackKey('melee', true), unarmed: attackKey('melee', false, { source: 'unarmed' }) };
    for (const src of ['weapon', 'spell', 'unarmed'] as const) {
      expect([m(`d20.attack.${src}`, keys.weapon), m(`d20.attack.${src}`, keys.spell), m(`d20.attack.${src}`, keys.unarmed)], src).toEqual([src === 'weapon', src === 'spell', src === 'unarmed']);
    }
  });

  it('an opportunity-attack pattern matches an opportunity attack and not the same attack on a turn', () => {
    const oa = attackKey('melee', false, { opportunity: true });
    expect([m('d20.attack.opportunity', oa), m('d20.attack.opportunity', attackKey('melee', false)), m('d20.attack.melee', oa)]).toEqual([true, false, true]);
  });

  it('d20.check.initiative matches initiative only; initiative is a DEX check, so DEX and plain check patterns cover it too (p.13)', () => {
    expect(m('d20.check.initiative', INITIATIVE_KEY)).toBe(true);
    expect(m('d20.check.dex.initiative', INITIATIVE_KEY)).toBe(true);
    expect([m('d20.check.initiative', checkKey(ab('dex'))), m('d20.check.initiative', checkKey(ab('dex'), skillIndex('stealth'))), m('d20.check.initiative', saveKey(ab('dex')))]).toEqual([false, false, false]);
    expect([m('d20.check', INITIATIVE_KEY), m('d20.check.dex', INITIATIVE_KEY), m('d20', INITIATIVE_KEY)]).toEqual([true, true, true]);
    expect([m('d20.check.wis', INITIATIVE_KEY), m('d20.check.stealth', INITIATIVE_KEY), m('d20.check.acrobatics', INITIATIVE_KEY), m('d20.save.dex', INITIATIVE_KEY)]).toEqual([false, false, false, false]);
  });

  it('the Unarmed Strike rolls a STR unarmed key; an opportunity attack adds its bit; other attacks are unchanged', () => {
    const fist = unarmedStrike(2, 2);
    expect(keyName(attackKeyOf(fist, false))).toBe('attack.melee.str.unarmed');
    expect(keyName(attackKeyOf(fist, true))).toBe('attack.melee.str.unarmed.opportunity');
    const spear = { ...fist, unarmed: false };
    expect(attackKeyOf(spear, false)).toBe(attackKey('melee', false));
    expect(keyName(attackKeyOf(spear, true))).toBe('attack.melee.opportunity');
  });

  it('rejects new segments that contradict each other', () => {
    for (const bad of ['d20.attack.weapon.spell', 'd20.attack.unarmed.weapon', 'd20.attack.str.dex', 'd20.attack.opportunity.opportunity', 'd20.check.wis.initiative', 'd20.check.initiative.stealth', 'd20.save.initiative', 'd20.attack.initiative']) {
      expect(() => compileKeyPattern(bad), bad).toThrow(RangeError);
    }
  });

  it('names the new segments in pattern order, so a name compiles back to its key', () => {
    const keys = [INITIATIVE_KEY, attackKey('ranged', false, { ability: ab('dex'), source: 'weapon', opportunity: true }), attackKey('melee', true, { ability: ab('wis') })];
    expect(keys.map(keyName)).toEqual(['check.dex.initiative', 'attack.ranged.dex.weapon.opportunity', 'attack.melee.wis.spell']);
    for (const k of keys) expect(compileKeyPattern(`d20.${keyName(k)}`).val).toBe(k);
  });
});
