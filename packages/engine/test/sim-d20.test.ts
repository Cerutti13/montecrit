// The pre-roll reaction window: a Reaction "when a creature you can see within 30 feet is
// about to make a D20 Test" (SRD 5.2.1 p.6 D20 Tests, p.10 Reactions). Hand-built feature.
import { describe, expect, it } from 'vitest';
import { RK, saveKey } from '../src/content/rollkeys.ts';
import type { CompiledTemplate } from '../src/content/types.ts';
import type { Decider, DecisionPoint, UnitView } from '../src/decide/decider.ts';
import { parseExpr } from '../src/dice/expr.ts';
import { ArraySink, type GameEvent } from '../src/log/events.ts';
import { renderLog } from '../src/log/render.ts';
import type { RuleFlags } from '../src/rules/flags.ts';
import { resolveOption } from '../src/sim/act.ts';
import { resolveAttack } from '../src/sim/attack.ts';
import { copyLegal, legalKey, newLegal, releaseList, takeList, type Ctx } from '../src/sim/context.ts';
import { dealDamage, deathSave } from '../src/sim/damage.ts';
import { newFx } from '../src/sim/effects.ts';
import { createContext } from '../src/sim/fight.ts';
import { listOptions } from '../src/sim/options.ts';
import { addCond, COND, type Unit } from '../src/sim/state.ts';
import { caster, dmg, DUMMY, effect, entry, feature, FIGHTER, S, setup, SKIRMISHER, spell, withEffects } from './helpers/build.ts';
import { ofKind } from './helpers/run.ts';

const ALL = (1 << RK.attack) | (1 << RK.save) | (1 << RK.check);

function seer(sign: 1 | -1 | 0 = -1, uses = 4, self: 'yes' | 'no' | 'textSilent' = 'textSilent', local = 'twist'): CompiledTemplate {
  return caster({
    features: [feature(local, null, { rangeFt: 30, self, pool: 9, die: parseExpr('1d6'), sign, kinds: ALL })],
    pools: [{ local: 'twist', name: 'Twists', max: uses, recharge: 'longRest' }],
    poolMax: [uses],
    slots: [],
  });
}

/** Answers every preRoll with `react` (or the given key), anything else with the first item; logs what it saw. */
class Reacts implements Decider {
  readonly name = 'reacts';
  readonly seen: DecisionPoint[] = [];
  readonly want: string | null;
  constructor(want: string | null = 'react') {
    this.want = want;
  }
  decide(_v: UnitView, dp: DecisionPoint): number {
    this.seen.push(dp);
    if (dp.k !== 'preRoll' || this.want === null) return 0;
    for (let i = 0; i < dp.legal.n; i++) if (dp.keyOf(i).startsWith(`react:${this.want === 'react' ? '' : this.want}`) || dp.keyOf(i) === this.want) return i;
    return 0;
  }
}

function choose(cx: Ctx, who: Unit, key: string): void {
  const list = listOptions(cx, who, takeList(cx));
  let chosen = null;
  for (let i = 0; i < list.n; i++) if (legalKey(cx.st, who.idx, list.items[i]!) === key) chosen = copyLegal(list.items[i]!, newLegal());
  releaseList(cx, list);
  if (!chosen) throw new Error(`${key} isn't offered`);
  resolveOption(cx, who, chosen, -1);
}

function scene(units: Parameters<typeof setup>[0]['units'], flags: Partial<RuleFlags> = {}, d: Decider = new Reacts(), seed = 5) {
  const sink = new ArraySink();
  const s = setup({ w: 12, h: 3, flags, units });
  const cx = createContext(s, seed, 0, s.seats.map(() => d), sink, { audit: true });
  const u = (seat: string): Unit => cx.st.units.find((x) => x.seat === seat)!;
  cx.st.order.set(s.seats.map((_, i) => i));
  const turnOf = (who: Unit) => {
    cx.st.active = who.idx;
    cx.st.orderPos = Array.from(cx.st.order).indexOf(who.idx);
    cx.st.turnIdx++;
  };
  const ev = <K extends GameEvent['k']>(k: K) => ofKind(sink.events, k);
  return { cx, s, u, turnOf, ev, sink };
}

describe('the pre-roll reaction window', () => {
  it('offered before an attack roll; reacting spends the Reaction and a use, and the die lowers the total', () => {
    const d = new Reacts();
    const { cx, u, turnOf, ev, sink, s } = scene([{ seat: 'seer', team: 0, tpl: seer(), at: 'B2' }, { seat: 'gob', team: 1, tpl: SKIRMISHER, at: 'D2' }, { seat: 'ally', team: 0, tpl: FIGHTER, at: 'E2' }], {}, d);
    const gob = u('gob');
    const seer_ = u('seer');
    turnOf(gob);
    resolveAttack(cx, gob, 0, u('ally'), false, -1);
    const dp = d.seen.find((x) => x.k === 'preRoll')!;
    expect([dp.roller, dp.rollTarget, dp.rollVia]).toEqual([gob.idx, u('ally').idx, 'test:skirmisher/blade']);
    expect([seer_.b.reaction, seer_.res[9]]).toEqual([0, 3]);
    const react = ev('react')[0]!;
    const atk = ev('attack')[0]!;
    expect(react.v).toBeLessThan(0);
    expect(atk.ext).toBe(react.v);
    expect(atk.total).toBe(atk.natural + 4 + react.v);
    expect(renderLog(sink.events, s).join('\n')).toMatch(/seer reacts before gob's roll: twist -\d \(3 left\)  \[seer react r0 p\d+\.0\]/);
  });

  it('offered before saves too: a spell save, a concentration save and a death save', () => {
    const conc = effect('beam', { conc: true });
    const d = new Reacts('pass');
    const pc = { ...withEffects(FIGHTER, [conc]), kind: 'pc' as const };
    // a DEX-save cantrip whose 45-ft range reaches the pc (C2) but not the seer (B2)
    const zap = entry(spell('zap', { level: 0, rangeFt: 45, s: false, sid: 7 }), { 0: [S.target(45), S.save(1, saveKey(1), 13, '1d6', 'fire', false)] });
    const mage = caster({ spells: [zap], slots: [] });
    const { cx, u, turnOf } = scene([{ seat: 'seer', team: 0, tpl: seer(), at: 'B2' }, { seat: 'pc', team: 0, tpl: pc, at: 'C2', hp: 200 }, { seat: 'gob', team: 1, tpl: DUMMY, at: 'F2' }, { seat: 'mage', team: 1, tpl: mage, at: 'L2' }], {}, d);
    const p = u('pc');
    turnOf(u('mage'));
    Object.assign(u('mage').b, { action: 1, bonus: 1 });
    choose(cx, u('mage'), 'cast:zap@0');
    const c = newFx(cx, { tpl: 0, owner: p.idx, bearer: -1, parent: -1, param: -1, srcItem: -1, until: { k: 'never' }, cause: -1 });
    p.conc = c.id;
    turnOf(u('gob'));
    dealDamage(cx, { unit: u('gob').idx, via: 'test:hit', slot: 0, cause: -1 }, [dmg(20, 'slashing')], Int32Array.from([20]), () => true, false, [p.idx]);
    p.hp = 0;
    p.life = 'down';
    turnOf(p);
    deathSave(cx, p, -1);
    const pre = d.seen.filter((x) => x.k === 'preRoll');
    expect(pre.map((x) => x.rollVia)).toEqual(['test:zap', 'test:fx/beam', 'core:death-save']);
    expect(pre.map((x) => x.roller)).toEqual([p.idx, p.idx, p.idx]);
  });

  it('not offered beyond 30 ft, with no uses left, while Incapacitated, or with no Reaction', () => {
    const run = (at: string, uses: number, prep?: (s: Unit) => void) => {
      const d = new Reacts();
      const { cx, u, turnOf } = scene([{ seat: 'seer', team: 0, tpl: seer(-1, uses), at }, { seat: 'gob', team: 1, tpl: SKIRMISHER, at: 'I2' }, { seat: 'ally', team: 0, tpl: FIGHTER, at: 'J2' }], {}, d);
      prep?.(u('seer'));
      turnOf(u('gob'));
      resolveAttack(cx, u('gob'), 0, u('ally'), false, -1);
      return d.seen.filter((x) => x.k === 'preRoll').length;
    };
    expect(run('C2', 4)).toBe(1); // 30 ft from I2
    expect(run('B2', 4)).toBe(0); // 35 ft
    expect(run('C2', 0)).toBe(0);
    expect(run('C2', 4, (s) => addCond(s, COND.incapacitated, 'test:stun', -1, -1, { k: 'never' }))).toBe(0);
    expect(run('C2', 4, (s) => (s.b.reaction = 0))).toBe(0);
  });

  it('its own roll: allowed when the text is silent, unless selfTargetWhenTextSilent=notAllowed', () => {
    for (const [flag, n] of [['allowed', 1], ['notAllowed', 0]] as const) {
      const d = new Reacts();
      const { cx, u, turnOf } = scene([{ seat: 'seer', team: 0, tpl: { ...seer(), attacks: FIGHTER.attacks, attackAct: FIGHTER.attackAct }, at: 'B2' }, { seat: 'gob', team: 1, tpl: DUMMY, at: 'C2' }], { selfTargetWhenTextSilent: flag }, d);
      turnOf(u('seer'));
      resolveAttack(cx, u('seer'), 0, u('gob'), false, -1);
      expect(d.seen.filter((x) => x.k === 'preRoll')).toHaveLength(n);
    }
  });

  it('a choose-the-sign reaction offers both signs', () => {
    const d = new Reacts(null);
    const { cx, u, turnOf } = scene([{ seat: 'seer', team: 0, tpl: seer(0), at: 'B2' }, { seat: 'gob', team: 1, tpl: SKIRMISHER, at: 'D2' }, { seat: 'ally', team: 0, tpl: FIGHTER, at: 'E2' }], {}, d);
    turnOf(u('gob'));
    resolveAttack(cx, u('gob'), 0, u('ally'), false, -1);
    const dp = d.seen.find((x) => x.k === 'preRoll')!;
    expect(Array.from({ length: dp.legal.n }, (_, i) => dp.keyOf(i))).toEqual(['pass', 'react:twist+', 'react:twist-']);
  });

  it('two reactors: whoever\'s turn it is orders them, and they go in the order picked', () => {
    for (const first of ['seer', 'sage']) {
      const d = new Reacts();
      const pickFirst = (v: UnitView, dp: DecisionPoint) => {
        if (dp.k !== 'orderTriggers') return d.decide(v, dp);
        d.seen.push(dp);
        return Array.from({ length: dp.legal.n }, (_, i) => dp.keyOf(i)).indexOf(`order:${first}`);
      };
      const { cx, u, turnOf, ev } = scene([{ seat: 'seer', team: 0, tpl: seer(), at: 'B2' }, { seat: 'sage', team: 0, tpl: seer(-1, 4, 'textSilent', 'omen'), at: 'C2' }, { seat: 'gob', team: 1, tpl: SKIRMISHER, at: 'D2' }, { seat: 'ally', team: 0, tpl: FIGHTER, at: 'E2' }], {}, { name: 'pick', decide: pickFirst });
      turnOf(u('gob'));
      resolveAttack(cx, u('gob'), 0, u('ally'), false, -1);
      const order = d.seen.find((x) => x.k === 'orderTriggers')!;
      expect(order.who).toBe(u('gob').idx);
      expect(ev('react').map((e) => cx.st.units[e.who]!.seat)).toEqual(first === 'seer' ? ['seer', 'sage'] : ['sage', 'seer']);
    }
  });

  it('a reaction never moves the roller\'s own dice (common random numbers)', () => {
    for (let seed = 0; seed < 40; seed++) {
      const roll = (tpl: CompiledTemplate) => {
        const { cx, u, turnOf, ev } = scene([{ seat: 'seer', team: 0, tpl, at: 'B2' }, { seat: 'gob', team: 1, tpl: SKIRMISHER, at: 'D2' }, { seat: 'ally', team: 0, tpl: FIGHTER, at: 'E2' }], {}, new Reacts(), seed);
        turnOf(u('gob'));
        resolveAttack(cx, u('gob'), 0, u('ally'), false, -1);
        return ev('attack')[0]!.d20;
      };
      expect(roll(seer())).toEqual(roll(caster({ slots: [] })));
    }
  });
});
