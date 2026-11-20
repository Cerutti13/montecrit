// Casting, hands and features (SRD 5.2.1 p.104-106, p.191; 2024 SAC-SpellComponents3).
// Spells and effects are hand-built; the compiler makes the real ones from YAML.
import { describe, expect, it } from 'vitest';
import { compileKeyPattern } from '../src/content/rollkeys.ts';
import { END, HOOK, type BoundEffect, type CompiledTemplate, type SpellEntry } from '../src/content/types.ts';
import type { Decider, DecisionPoint, UnitView } from '../src/decide/decider.ts';
import { ArraySink, type GameEvent } from '../src/log/events.ts';
import { renderLog } from '../src/log/render.ts';
import { flagIndex, type RuleFlags } from '../src/rules/flags.ts';
import { resolveOption } from '../src/sim/act.ts';
import { buildAttackSpecFor } from '../src/sim/attack.ts';
import { copyLegal, legalKey, newLegal, releaseList, takeList } from '../src/sim/context.ts';
import { dealDamage } from '../src/sim/damage.ts';
import { onIncapacitated } from '../src/sim/effects.ts';
import { createContext } from '../src/sim/fight.ts';
import { acNow } from '../src/sim/hands.ts';
import { listOptions } from '../src/sim/options.ts';
import { addCond, COND, HAND, has, type Unit } from '../src/sim/state.ts';
import { caster, dmg, DUMMY, effect, entry, feature, FIGHTER, item, S, setup, spell, spellAttack, SKIRMISHER } from './helpers/build.ts';
import { ofKind } from './helpers/run.ts';

/** Picks the first queued key whenever it's legal, otherwise the first item. */
class Keys implements Decider {
  readonly name = 'keys';
  readonly queue: string[];
  constructor(queue: string[] = []) {
    this.queue = queue;
  }
  decide(_v: UnitView, dp: DecisionPoint): number {
    if (this.queue.length > 0) {
      for (let i = 0; i < dp.legal.n; i++) {
        if (dp.keyOf(i) === this.queue[0]) {
          this.queue.shift();
          return i;
        }
      }
    }
    return 0;
  }
}

// The caster's kit. Effects (tpl.effects): 0 lit (a Guiding-Bolt-style rider), 1 flame (in hand,
// grants a hurl), 2 form root, 3 volley (grants a shot), 4 mending (slot-heal rider).
const LIT: BoundEffect = effect('lit', {
  dur: { k: 'untilTurn', edge: 'end', of: 'owner' },
  mods: [{ on: [compileKeyPattern('d20.attack')], side: 'incoming', op: 'adv', value: 0, dice: null, consume: true, skillParam: false }],
});
const FLAME: BoundEffect = effect('flame', {
  sid: 2, dur: { k: 'rounds', n: 100 }, inHand: true, endsOn: END.dismiss,
  grants: [{ local: 'hurl', name: 'Hurl Flame', cost: 'action', laterTurns: false, to: 'owner', steps: [S.target(60), S.attack(spellAttack('hurl', 'ranged', 7, 60, '2d8', 'fire'), [S.damage('2d8', 'fire')])] }],
});
const FORM: BoundEffect = effect('form', { dur: { k: 'rounds', n: 100 }, endsOn: END.incap | END.dismiss, group: 'form' });
const VOLLEY: BoundEffect = effect('volley', {
  grants: [{ local: 'shot', name: 'Shot', cost: 'bonus', laterTurns: true, to: 'owner', steps: [S.target(60), S.attack(spellAttack('shot', 'ranged', 7, 60, '1d8+4', 'radiant'), [S.damage('1d8+4', 'radiant')])] }],
});
const MENDING: BoundEffect = effect('mending', { hooks: [{ on: HOOK.slotHeal, steps: [S.target(30, 'any', 'yes'), S.heal('1d8+4')] }], hookMask: HOOK.slotHeal });

const LASH = entry(spell('lash', { level: 0, m: 'focus', sid: 1 }), { 0: [S.target(30), S.attack(spellAttack('lash', 'melee', 7, 30, '2d6', 'piercing'), [S.damage('2d6', 'piercing')])] });
const FLAME_SP = entry(spell('flame', { level: 0, cast: 'bonus', rangeFt: 0, recast: 'replace', createsInHand: true, sid: 2 }), { 0: [S.apply(1, 'self')] });
const GESTURE = entry(spell('gesture', { level: 0, sid: 3 }), { 0: [S.target(30), S.attack(spellAttack('gesture', 'ranged', 7, 30, '1d8', 'fire'), [S.damage('1d8', 'fire')])] }); // V,S, no M
const MEND = entry(spell('mend', { level: 1, cast: 'bonus', s: false, rangeFt: 60, sid: 4 }), { 1: [S.target(60, 'any', 'yes'), S.heal('2d4+4')], 2: [S.target(60, 'any', 'yes'), S.heal('4d4+4')] });
const BOLT = (over: Partial<SpellEntry> = {}) =>
  entry(spell('bolt', { level: 1, rangeFt: 120, sid: 5 }), { 1: [S.target(120), S.attack(spellAttack('bolt', 'ranged', 7, 120, '4d6', 'radiant'), [S.damage('4d6', 'radiant'), S.apply(0, 'target')])] }, over);

function druid(over: Partial<CompiledTemplate> & { slots?: number[]; poolMax?: number[] } = {}): CompiledTemplate {
  return caster({
    items: [item('shield', 'shield'), item('charm', 'focus')],
    startHands: [0, 1],
    effects: [LIT, FLAME, FORM, VOLLEY, MENDING],
    spells: [LASH, FLAME_SP, GESTURE, MEND, BOLT({ source: 'charm', whileHeld: 1, freePool: 9 })],
    pools: [{ local: 'bolts', name: 'Charm Bolts', max: 2, recharge: 'longRest' }, { local: 'forms', name: 'Forms', max: 2, recharge: 'longRest' }],
    poolMax: [2, 2],
    features: [feature('stance', { local: 'stance', name: 'Stance', cost: 'bonus', pool: 10, root: 2, steps: [S.choose([['volley', [S.apply(3, 'self'), S.use(3, 0)]], ['mending', [S.apply(4, 'self')]]])] })],
    ...over,
  });
}

function scene(opts: { tpl?: CompiledTemplate; flags?: Partial<RuleFlags>; keys?: string[]; units?: Parameters<typeof setup>[0]['units'] } = {}) {
  const sink = new ArraySink();
  const s = setup({
    w: 10, h: 3, flags: opts.flags,
    units: opts.units ?? [
      { seat: 'pc', team: 0, tpl: opts.tpl ?? druid(), at: 'A1' },
      { seat: 'gob', team: 1, tpl: SKIRMISHER, at: 'F1' },
      { seat: 'ally', team: 0, tpl: FIGHTER, at: 'B2' },
    ],
  });
  const keys = new Keys(opts.keys);
  const cx = createContext(s, 7, 0, s.seats.map(() => keys), sink, { audit: true });
  const u = (seat: string): Unit => cx.st.units.find((x) => x.seat === seat)!;
  const begin = (who: Unit) => {
    cx.st.active = who.idx;
    cx.st.turnIdx++;
    who.turns++;
    Object.assign(who.b, { action: 1, bonus: 1, reaction: 1, freeObj: 1, moveFt: who.tpl.speedFt, atkActive: false });
  };
  const offered = (who: Unit): string[] => {
    const list = listOptions(cx, who, takeList(cx));
    const out: string[] = [];
    for (let i = 0; i < list.n; i++) out.push(legalKey(cx.st, who.idx, list.items[i]!));
    releaseList(cx, list);
    return out;
  };
  const choose = (who: Unit, key: string) => {
    const list = listOptions(cx, who, takeList(cx));
    let chosen = null;
    for (let i = 0; i < list.n; i++) if (legalKey(cx.st, who.idx, list.items[i]!) === key) chosen = copyLegal(list.items[i]!, newLegal());
    releaseList(cx, list);
    if (!chosen) throw new Error(`${key} isn't offered; offered: ${offered(who).join(', ')}`);
    resolveOption(cx, who, chosen, -1);
  };
  const ev = <K extends GameEvent['k']>(k: K) => ofKind(sink.events, k);
  return { cx, s, u, begin, offered, choose, ev, keys, sink };
}

describe('one spell slot per turn (p.105)', () => {
  it('after a slotted Bonus Action spell, no slotted spell is offered, but cantrips and free casts are', () => {
    // lenient: the bolt is V,S with no Material, so shield + focus would block it outright under strict
    const { u, begin, offered, choose } = scene({ flags: { focusHandSomatic: 'lenient' }, keys: ['target:ally'] });
    const pc = u('pc');
    begin(pc);
    expect(offered(pc)).toEqual(expect.arrayContaining(['cast:lash@0', 'cast:mend@1', 'cast:bolt@1/free', 'cast:bolt@1']));
    choose(pc, 'cast:mend@1');
    const now = offered(pc);
    expect(now).toContain('cast:lash@0');
    expect(now).toContain('cast:bolt@1/free');
    expect(now.filter((k) => /^cast:bolt@\d$/.test(k))).toEqual([]);
  });

  it('a slot spent on someone else\'s turn counts against that turn', () => {
    const { cx, u, begin, offered } = scene();
    const pc = u('pc');
    begin(u('gob'));
    pc.slotTurn = cx.st.turnIdx;
    Object.assign(pc.b, { action: 1, bonus: 1 });
    expect(offered(pc).filter((k) => /^cast:mend@/.test(k))).toEqual([]);
    begin(pc);
    expect(offered(pc)).toContain('cast:mend@1');
  });

  it('two Bonus Action spells never fit one turn', () => {
    const { u, begin, offered, choose } = scene({ keys: ['target:ally'] });
    const pc = u('pc');
    begin(pc);
    choose(pc, 'cast:mend@1');
    expect(offered(pc).some((k) => k.startsWith('cast:flame'))).toBe(false);
  });

  it('upcasting spends the higher slot and runs that level\'s program', () => {
    // flat heals that differ per level, so the amount says which program ran
    const mend = { ...MEND, prog: [null, [S.target(60, 'any', 'yes'), S.heal('3')], [S.target(60, 'any', 'yes'), S.heal('9')], null, null, null, null, null, null, null] };
    const { u, begin, choose, ev } = scene({ tpl: druid({ spells: [LASH, FLAME_SP, GESTURE, mend] }), keys: ['target:ally'] });
    const pc = u('pc');
    u('ally').hp = 1;
    begin(pc);
    choose(pc, 'cast:mend@2');
    expect([pc.res[0], pc.res[1]]).toEqual([4, 2]);
    expect(ev('cast')[0]!.lvl).toBe(2);
    expect(ev('heal').map((e) => e.rolled)).toEqual([9]);
  });
});

describe('Produce Flame-style effects and grants', () => {
  it('a grant with no one in range isn\'t offered (it would spend the action on nothing)', () => {
    const near = { ...FLAME, grants: [{ ...FLAME.grants[0]!, steps: [S.target(20), ...FLAME.grants[0]!.steps.slice(1)] }] };
    const { u, begin, offered, choose } = scene({ tpl: druid({ effects: [LIT, near, FORM, VOLLEY, MENDING] }), flags: { focusHandSomatic: 'lenient' } });
    const pc = u('pc');
    begin(pc);
    choose(pc, 'cast:flame@0');
    expect(offered(pc)).not.toContain('use:pc/flame/hurl'); // the goblin at F1 is 25 ft away
    u('gob').cell = 4; // E1: 20 ft
    expect(offered(pc)).toContain('use:pc/flame/hurl');
  });

  it('cast as a Bonus Action and hurled with the action on the same turn; casting again replaces the flame', () => {
    const { u, begin, offered, choose, ev, cx } = scene({ flags: { focusHandSomatic: 'lenient' }, keys: ['target:gob'] });
    const pc = u('pc');
    begin(pc);
    choose(pc, 'cast:flame@0');
    expect(offered(pc)).toContain('use:pc/flame/hurl');
    choose(pc, 'use:pc/flame/hurl');
    expect(ev('attack').map((e) => e.name)).toEqual(['hurl']);
    const first = ev('fxStart')[0]!.fx;
    begin(pc);
    choose(pc, 'cast:flame@0');
    expect(cx.st.fx[first]!.alive).toBe(false);
    expect(ev('fxEnd').map((e) => e.why)).toEqual(['replaced']);
  });
});

describe('healing (p.18)', () => {
  it('healing a creature at 0 HP revives it and resets its death saves; HP never passes the max', () => {
    const { cx, u, begin, choose, ev } = scene({ keys: ['target:ally'] });
    const ally = u('ally');
    dealDamage(cx, { unit: u('gob').idx, via: 'test:hit', slot: 0, cause: -1 }, [dmg(44, 'slashing')], Int32Array.from([44]), () => true, false, [ally.idx]);
    ally.deathFail = 2;
    expect(ally.life).toBe('down');
    const pc = u('pc');
    begin(pc);
    choose(pc, 'cast:mend@1');
    expect([ally.life, ally.deathFail, ally.hp > 0]).toEqual(['up', 0, true]);
    expect(ev('heal')[0]!.hpAfter).toBe(ally.hp);
    begin(pc);
    ally.hp = ally.hpMax - 1;
    choose(pc, 'cast:mend@1');
    expect(ally.hp).toBe(ally.hpMax);
  });

  it('a heal of 0 doesn\'t revive: the creature stays down and the next hit still fails a death save', () => {
    const zero = { ...MEND, prog: [null, [S.target(60, 'any', 'yes'), S.heal('0')], null, null, null, null, null, null, null, null] };
    const { cx, u, begin, choose } = scene({ tpl: druid({ spells: [LASH, FLAME_SP, GESTURE, zero] }), keys: ['target:ally'] });
    const ally = u('ally');
    dealDamage(cx, { unit: u('gob').idx, via: 'test:hit', slot: 0, cause: -1 }, [dmg(44, 'slashing')], Int32Array.from([44]), () => true, false, [ally.idx]);
    ally.deathFail = 1;
    const pc = u('pc');
    begin(pc);
    choose(pc, 'cast:mend@1');
    expect([ally.life, ally.hp, ally.deathFail, has(ally, COND.unconscious)]).toEqual(['down', 0, 1, true]);
    dealDamage(cx, { unit: u('gob').idx, via: 'test:hit', slot: 1, cause: -1 }, [dmg(3, 'slashing')], Int32Array.from([3]), () => true, false, [ally.idx]);
    expect(ally.deathFail).toBe(2);
  });
});

describe('components and hands (p.106; SAC-SpellComponents3)', () => {
  const VSM = entry(spell('vsm', { level: 0, m: 'focus', sid: 11 }), { 0: [S.target(30), S.attack(spellAttack('vsm', 'ranged', 7, 30, '1d8', 'fire'), [S.damage('1d8', 'fire')])] });
  const VM = entry(spell('vm', { level: 0, s: false, m: 'focus', sid: 12 }), { 0: [S.target(30), S.attack(spellAttack('vm', 'ranged', 7, 30, '1d8', 'fire'), [S.damage('1d8', 'fire')])] });
  const castable = (hands: readonly [number, number], flag: 'strict' | 'lenient') => {
    const tpl = caster({ items: [item('shield', 'shield'), item('pouch', 'pouch')], startHands: hands, spells: [VSM, VM], slots: [] });
    const { u, begin, offered } = scene({ tpl, flags: { focusHandSomatic: flag } });
    begin(u('pc'));
    const o = offered(u('pc'));
    return [o.includes('cast:vsm@0'), o.includes('cast:vm@0')];
  };

  it('a component pouch needs a free hand to reach into, and its hand can\'t make the gestures', () => {
    for (const flag of ['strict', 'lenient'] as const) {
      expect(castable([0, 1], flag)).toEqual([false, false]); // shield + pouch: no hand free
      expect(castable([1, HAND.empty], flag)).toEqual([true, true]); // pouch + a free hand
    }
  });
});

describe('spell attacks', () => {
  it('a 30-ft melee spell attack takes no close-combat Disadvantage; a Prone target beyond 5 ft gives Disadvantage', () => {
    const { cx, u } = scene({ units: [{ seat: 'pc', team: 0, tpl: druid(), at: 'A1' }, { seat: 'gob', team: 1, tpl: SKIRMISHER, at: 'G1' }, { seat: 'g2', team: 1, tpl: DUMMY, at: 'B1' }] });
    const pc = u('pc');
    const step = LASH.prog[0]![1]!;
    if (step.k !== 'attack') throw new Error('the lash program attacks second');
    const lash = step.atk;
    const adv: string[] = [];
    const dis: string[] = [];
    buildAttackSpecFor(cx.st, pc, lash, u('gob'), pc.cell, adv, dis);
    expect(dis).toEqual([]);
    addCond(u('gob'), COND.prone, 'core:prone', -1, -1, { k: 'never' });
    buildAttackSpecFor(cx.st, pc, lash, u('gob'), pc.cell, adv, dis);
    expect(dis).toEqual(['core:target-prone']);
  });
});

describe('hands and components (2024 SAC-SpellComponents3)', () => {
  it('shield + focus: V,S,M and V-only spells are castable; V,S without M only under lenient', () => {
    for (const [flag, gesture] of [['strict', false], ['lenient', true]] as const) {
      const { cx, u, begin, offered } = scene({ flags: { focusHandSomatic: flag } });
      const pc = u('pc');
      begin(pc);
      const o = offered(pc);
      expect(o).toContain('cast:lash@0');
      expect(o).toContain('cast:mend@1');
      expect(o.includes('cast:gesture@0')).toBe(gesture);
      expect(cx.st.flagsUsed[flagIndex('focusHandSomatic')]).toBe(1);
    }
  });

  it('stowing the focus frees a hand (V,S castable) and takes its held-item spells and free casts with it', () => {
    const { u, begin, offered, choose, ev } = scene();
    const pc = u('pc');
    begin(pc);
    expect(offered(pc)).toContain('item:stow/charm');
    choose(pc, 'item:stow/charm');
    expect(pc.b.freeObj).toBe(0);
    const o = offered(pc);
    expect(o).toContain('cast:gesture@0');
    expect(o.some((k) => k.startsWith('cast:bolt'))).toBe(false);
    expect(o).not.toContain('cast:lash@0'); // its Material component needs the focus or a pouch
    expect(ev('item').map((e) => e.act)).toEqual(['stow']);
  });

  it('losing the item a spell came through: the spell keeps going by default, ends under losingSpellSourceEndsActiveSpell', () => {
    for (const [ends, alive] of [[false, true], [true, false]] as const) {
      const { u, begin, choose, ev, cx } = scene({ flags: { losingSpellSourceEndsActiveSpell: ends, focusHandSomatic: 'lenient' }, keys: ['target:gob'] });
      const pc = u('pc');
      // a hit is needed for the rider: give the bolt a sure hit
      const sure = druid({ spells: [LASH, FLAME_SP, GESTURE, MEND, { ...BOLT({ source: 'charm', whileHeld: 1, freePool: 9 }), prog: [null, [S.target(120), S.attack({ ...spellAttack('bolt', 'ranged', 100, 120, '4d6', 'radiant') }, [S.apply(0, 'target')])], null, null, null, null, null, null, null, null] }] });
      Object.assign(pc, { tpl: sure });
      begin(pc);
      choose(pc, 'cast:bolt@1');
      const rider = ev('fxStart').find((e) => e.name === 'lit')!.fx;
      choose(pc, 'item:stow/charm');
      expect(cx.st.fx[rider]!.alive).toBe(alive);
    }
  });

  it('a conjured flame fills a free hand only under conjuredHandEffectBlocksHand, and then blocks S-only casting', () => {
    const tpl = druid({ startHands: [0, -1] }); // shield, one hand free
    const off = scene({ tpl, keys: [] });
    off.begin(off.u('pc'));
    off.choose(off.u('pc'), 'cast:flame@0');
    expect(Array.from(off.u('pc').hands)).toEqual([0, HAND.empty]);
    const on = scene({ tpl, flags: { conjuredHandEffectBlocksHand: true } });
    const pc = on.u('pc');
    on.begin(pc);
    on.choose(pc, 'cast:flame@0');
    expect(Array.from(pc.hands)).toEqual([0, HAND.conjured]);
    on.begin(pc);
    expect(on.offered(pc)).not.toContain('cast:gesture@0');
    const full = scene({ flags: { conjuredHandEffectBlocksHand: true } }); // shield + focus: no hand to hold it
    full.begin(full.u('pc'));
    expect(full.offered(full.u('pc')).some((k) => k.startsWith('cast:flame'))).toBe(false);
  });

  it('a held shield adds its AC', () => {
    const { u } = scene();
    expect(acNow(u('pc'))).toBe(15);
  });

  it('Unconscious drops what it holds (the shield too by default); picking it back up is the free object interaction', () => {
    for (const [dropsShield, kept] of [[true, [HAND.empty, HAND.empty]], [false, [0, HAND.empty]]] as const) {
      const { cx, u, begin, offered, choose } = scene({ flags: { unconsciousDropsShield: dropsShield } });
      const pc = u('pc');
      dealDamage(cx, { unit: u('gob').idx, via: 'test:hit', slot: 0, cause: -1 }, [dmg(40, 'slashing')], Int32Array.from([40]), () => true, false, [pc.idx]);
      expect(Array.from(pc.hands)).toEqual(kept);
      expect(pc.dropped[1]).toBe(pc.cell);
      Object.assign(pc, { hp: 5, life: 'up' });
      pc.conds.length = 0;
      pc.condMask = 0;
      begin(pc);
      expect(offered(pc)).toContain('item:pickup/charm');
      choose(pc, 'item:pickup/charm');
      expect([pc.b.freeObj, pc.dropped[1]]).toEqual([0, -1]);
    }
  });

  it('Incapacitated without Unconscious keeps held items', () => {
    const { cx, u } = scene();
    const pc = u('pc');
    addCond(pc, COND.incapacitated, 'test:stun', -1, -1, { k: 'never' });
    onIncapacitated(cx, pc, -1);
    expect(Array.from(pc.hands)).toEqual([0, 1]);
  });
});

describe('a form feature', () => {
  it('activation spends the Bonus Action and a use; the granted shot fires on activation, then only as a Bonus Action on later turns', () => {
    const { u, begin, offered, choose, ev } = scene({ keys: ['pick:volley', 'target:gob', 'target:gob'] });
    const pc = u('pc');
    begin(pc);
    choose(pc, 'use:stance');
    expect([pc.b.bonus, pc.res[10]]).toEqual([0, 1]);
    expect(ev('attack').map((e) => e.name)).toEqual(['shot']);
    expect(offered(pc)).not.toContain('use:pc/volley/shot');
    begin(pc);
    expect(offered(pc)).toContain('use:pc/volley/shot');
    choose(pc, 'use:pc/volley/shot');
    expect(ev('attack')).toHaveLength(2);
  });

  it('using it again replaces the old form; Incapacitated ends it; dismissing it is free', () => {
    const { cx, u, begin, offered, choose, ev } = scene({ keys: ['pick:mending', 'pick:mending'] });
    const pc = u('pc');
    begin(pc);
    choose(pc, 'use:stance');
    begin(pc);
    choose(pc, 'use:stance');
    expect(ev('fxEnd').map((e) => `${e.name}:${e.why}`)).toEqual(['form:replaced', 'mending:parent']);
    expect(offered(pc)).toContain('end:form');
    choose(pc, 'end:form');
    expect(pc.b.action).toBe(1);
    expect(cx.st.liveFx).toBe(0);
  });

  it('the heal rider fires once after a slot-cast heal (any creature within 30 ft, itself included), not after a free cast', () => {
    const tpl = druid({ spells: [LASH, FLAME_SP, GESTURE, { ...MEND, freePool: 9 }] });
    const { u, begin, choose, ev, sink, s } = scene({ tpl, keys: ['pick:mending', 'target:ally', 'target:pc', 'target:ally'] });
    const pc = u('pc');
    begin(pc);
    choose(pc, 'use:stance');
    begin(pc);
    pc.hp = 10;
    u('ally').hp = 20;
    choose(pc, 'cast:mend@1');
    const heals = ev('heal');
    expect(heals.map((e) => `${e.name}>${s.seats[e.tgt]!.seat}`)).toEqual(['mend>ally', 'mending>pc']);
    expect(renderLog(sink.events, s).join('\n')).toMatch(/pc regains \d+ \(\d+ rolled\) from mending/);
    begin(pc);
    u('ally').hp = 20;
    choose(pc, 'cast:mend@1/free');
    expect(ev('heal').slice(2).map((e) => e.name)).toEqual(['mend']);
  });
});
