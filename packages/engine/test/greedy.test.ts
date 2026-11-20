// The greedy AI's core (docs/design/m1c.md 1, build step 5): turn planning with weapon attacks,
// movement, Disengage and Dash, opportunity attacks and attackDowned. Behavior fixtures, plus
// replay safety: one decider reused across fights decides exactly like fresh ones.
import { describe, expect, it } from 'vitest';
import type { DecisionPoint } from '../src/decide/decider.ts';
import { GreedyDecider } from '../src/decide/greedy/greedy.ts';
import { quickOdds } from '../src/decide/greedy/odds.ts';
import { makeDeciders } from '../src/decide/make.ts';
import { parseExpr } from '../src/dice/expr.ts';
import { HashSink } from '../src/log/events.ts';
import { DEFAULT_FLAGS } from '../src/rules/flags.ts';
import { rollOdds, type RollSpec } from '../src/rolls/rollspec.ts';
import { resolveOption } from '../src/sim/act.ts';
import { copyLegal, legalKey, newLegal, releaseList, takeList, type Ctx } from '../src/sim/context.ts';
import { addCond, COND, type Unit } from '../src/sim/state.ts';
import { createContext, runFight } from '../src/sim/fight.ts';
import { listOptions, listReactions } from '../src/sim/options.ts';
import type { FightSetup } from '../src/sim/setup.ts';
import { compileKeyPattern } from '../src/content/rollkeys.ts';
import { newFx } from '../src/sim/effects.ts';
import { effect, FIGHTER, setup, SKIRMISHER, template, withEffects, type UnitSpec } from './helpers/build.ts';

/** Asks a greedy decider for `who`'s next turn choice in the current state; returns its key (and resolves it when `act`). */
function decideTurn(cx: Ctx, who: Unit, act = false, d = new GreedyDecider()): string {
  const list = listOptions(cx, who, takeList(cx));
  const dp: DecisionPoint = { k: 'turn', who: who.idx, at: 0, round: 1, cause: -1, legal: list, keyOf: (i) => legalKey(cx.st, who.idx, list.items[i]!) };
  const i = d.decide(cx.views[who.idx]!, dp);
  const key = dp.keyOf(i);
  const chosen = copyLegal(list.items[i]!, newLegal());
  releaseList(cx, list);
  if (act) resolveOption(cx, who, chosen, -1);
  return key;
}

/** Asks `r`'s greedy decider whether to make an opportunity attack as `mover` leaves `from`. */
function decideReaction(cx: Ctx, r: Unit, mover: Unit): string {
  const list = listReactions(cx, r, mover, mover.cell, takeList(cx));
  const dp: DecisionPoint = { k: 'reaction', who: r.idx, at: 0, round: 1, cause: -1, legal: list, keyOf: (i) => legalKey(cx.st, r.idx, list.items[i]!) };
  const key = dp.keyOf(new GreedyDecider().decide(cx.views[r.idx]!, dp));
  releaseList(cx, list);
  return key;
}

function scene(units: Parameters<typeof setup>[0]['units'], over: { w?: number; h?: number; knobs?: Partial<FightSetup['knobs']> } = {}) {
  const s = setup({ w: over.w ?? 20, h: over.h ?? 3, units, knobs: over.knobs });
  const cx = createContext(s, 1, 0, s.seats.map(() => new GreedyDecider()), null);
  const u = (seat: string): Unit => cx.st.units.find((x) => x.seat === seat)!;
  const begin = (who: Unit) => {
    cx.st.active = who.idx;
    cx.st.turnIdx++;
    who.turns++;
    Object.assign(who.b, { action: 1, bonus: 1, reaction: 1, freeObj: 1, moveFt: who.tpl.speedFt, atkActive: false });
  };
  return { cx, s, u, begin };
}

describe('quickOdds', () => {
  it('equals rollOdds for every attack and save spec without added dice', () => {
    for (const kind of ['attack', 'save'] as const) {
      for (const adv of ['none', 'adv', 'dis'] as const) {
        for (let flat = -3; flat <= 12; flat += 3) {
          for (const dc of [5, 10, 13, 15, 18, 21, 25]) {
            for (const extra of [{}, { critMin: 18 }, { floor: 10 }, { autoCritOnHit: true }, { autoFail: true }]) {
              const spec: RollSpec = { kind, adv, flat, preDice: [], dc, ...extra };
              const exact = rollOdds(spec, DEFAULT_FLAGS);
              const q = quickOdds(spec, DEFAULT_FLAGS);
              expect([q.pSuccess, q.pCrit]).toEqual([expect.closeTo(exact.pSuccess, 12), expect.closeTo(exact.pCrit, 12)]);
            }
          }
        }
      }
    }
    const withDice: RollSpec = { kind: 'attack', adv: 'none', flat: 4, preDice: [parseExpr('1d4')], dc: 15 };
    expect(quickOdds(withDice, DEFAULT_FLAGS).pSuccess).toBeCloseTo(rollOdds(withDice, DEFAULT_FLAGS).pSuccess, 12);
  });
});

describe('greedy turns', () => {
  const ARCHER = template({ id: 'archer', ac: 15, hp: 10, dex: 14, bonusDisengage: true, attacks: [{ local: 'blade', toHit: 4, damage: [['1d6+2', 'slashing']] }, { local: 'bow', kind: 'ranged', toHit: 4, range: [80, 320], damage: [['1d6+2', 'piercing']] }] });
  const SLOW_BRUTE = { ...FIGHTER, kind: 'monster' as const, speedFt: 20 };

  it('an archer next to a slow brute disengages for free, steps out of its reach, and shoots without Disadvantage', () => {
    const { cx, u, begin } = scene([{ seat: 'archer', team: 1, tpl: ARCHER, at: 'E2' }, { seat: 'brute', team: 0, tpl: SLOW_BRUTE, at: 'D2' }]);
    const a = u('archer');
    begin(a);
    expect(decideTurn(cx, a, true)).toBe('opt:nimble');
    expect(decideTurn(cx, a, true)).toMatch(/^move:/);
    expect(cx.views[0]!.queries.distFt(a.cell, u('brute').cell)).toBeGreaterThan(25); // beyond 20 ft speed + 5 ft reach
    expect(u('brute').b.reaction).toBe(1); // it disengaged: no opportunity attack
    expect(decideTurn(cx, a)).toBe('attack:bow>brute');
  });

  it('a melee brute that can\'t hit anything this turn Dashes and closes in; one that can reach moves in to strike', () => {
    const { cx, u, begin } = scene([{ seat: 'brute', team: 1, tpl: { ...FIGHTER, kind: 'monster' }, at: 'A2' }, { seat: 'pc', team: 0, tpl: FIGHTER, at: 'J2' }]);
    const b = u('brute');
    begin(b);
    expect(decideTurn(cx, b, true)).toBe('opt:dash'); // 45 ft: 30 ft of movement plus 5 ft of reach falls short
    expect(decideTurn(cx, b, true)).toMatch(/^move:/);
    expect(cx.views[0]!.queries.distFt(b.cell, u('pc').cell)).toBe(5); // Dashed into reach (for next turn)
    const near = scene([{ seat: 'brute', team: 1, tpl: { ...FIGHTER, kind: 'monster' }, at: 'A2' }, { seat: 'pc', team: 0, tpl: FIGHTER, at: 'G2' }]);
    near.begin(near.u('brute'));
    expect(decideTurn(near.cx, near.u('brute'))).toMatch(/^move:F[1-3]/); // 30 ft: moves in to strike this turn
  });

  it('attackDowned: never leaves a downed PC alone, always may finish it, ifNoOtherTarget only when no standing target is up', () => {
    const run = (knob: 'never' | 'always' | 'ifNoOtherTarget', allyAt: string) => {
      const { cx, u, begin } = scene([{ seat: 'brute', team: 1, tpl: { ...FIGHTER, kind: 'monster' }, at: 'B2' }, { seat: 'pc', team: 0, tpl: FIGHTER, at: 'C2' }, { seat: 'ally', team: 0, tpl: FIGHTER, at: allyAt }], { knobs: { attackDowned: knob } });
      const pc = u('pc');
      pc.hp = 0;
      pc.life = 'down';
      addCond(pc, COND.unconscious, 'core:downed', -1, -1, { k: 'never' });
      addCond(pc, COND.incapacitated, 'core:downed', -1, -1, { k: 'never' });
      begin(u('brute'));
      return decideTurn(cx, u('brute'));
    };
    expect(run('never', 'T2')).not.toMatch(/>pc$/);
    expect(run('always', 'T2')).toBe('attack:longsword>pc');
    // Greedy v12 (C, docs/design/stalemate-plan.md 4.1): a non-PC reads "another target" as any standing hostile,
    // not only one in reach, so with the ally up far away the body no longer holds it: it Dashes toward the ally.
    expect(run('ifNoOtherTarget', 'T2')).toBe('opt:dash');
    expect(run('ifNoOtherTarget', 'F2')).not.toMatch(/>pc$/); // a standing target is in reach
  });

  it('takes a worthwhile opportunity attack, and holds its Reaction for a pre-roll reaction over a weak one', () => {
    const WEAK = template({ id: 'weak', ac: 10, hp: 10, attacks: [{ local: 'poke', toHit: 0, damage: [['1', 'piercing']] }] });
    const omen = { ...WEAK, features: [{ id: 'test:omen' as never, local: 'omen', name: 'omen', activate: null, preRoll: {} as never }] };
    const take = (tpl: typeof WEAK) => {
      const { cx, u } = scene([{ seat: 'r', team: 0, tpl, at: 'B2' }, { seat: 'gob', team: 1, tpl: SKIRMISHER, at: 'C2' }]);
      return decideReaction(cx, u('r'), u('gob'));
    };
    expect(take(FIGHTER)).toBe('oa:longsword');
    expect(take(WEAK)).toMatch(/^oa:/); // anything beats nothing (its Unarmed Strike, +2, beats the +0 poke)
    expect(take(omen)).toBe('pass'); // 0.3 HP isn't worth the Reaction a pre-roll reaction could use
  });

  it('values an opportunity attack with its d20.attack.opportunity modifiers, as the sim rolls it', () => {
    const omen = { id: 'test:omen' as never, local: 'omen', name: 'omen', activate: null, preRoll: {} as never };
    const TANK = template({ id: 'tank', ac: 15, hp: 200, attacks: [{ local: 'poke', toHit: 0, damage: [['1', 'piercing']] }] });
    const take = (on: string | null) => {
      const mods = on === null ? [] : [{ on: [compileKeyPattern(on)], side: 'self' as const, op: 'flat' as const, value: -100, dice: null, consume: false, skillParam: false }];
      const tpl = withEffects({ ...FIGHTER, features: [omen] }, [effect('clumsy', { mods })]);
      const { cx, u } = scene([{ seat: 'r', team: 0, tpl, at: 'B2' }, { seat: 'tank', team: 1, tpl: TANK, at: 'C2' }]);
      const r = u('r');
      newFx(cx, { tpl: 0, owner: r.idx, bearer: r.idx, parent: -1, param: -1, srcItem: -1, until: { k: 'never' }, cause: -1 });
      return decideReaction(cx, r, u('tank'));
    };
    expect(take(null)).toBe('oa:longsword');
    expect(take('d20.attack.ranged')).toBe('oa:longsword'); // a modifier this roll doesn't match changes nothing
    expect(take('d20.attack.opportunity')).toBe('pass'); // only a natural 20 hits: not worth the Reaction a pre-roll reaction could use
  });

  it('one decider reused across fights decides exactly like fresh deciders per fight', () => {
    const units: UnitSpec[] = [
      { seat: 'a', team: 0, tpl: FIGHTER, at: 'B2', decider: 'greedy' },
      { seat: 'b', team: 0, tpl: { ...FIGHTER, kind: 'monster' }, at: 'B5', decider: 'greedy' },
      { seat: 'g1', team: 1, tpl: SKIRMISHER, at: 'J2', decider: 'greedy' },
      { seat: 'g2', team: 1, tpl: SKIRMISHER, at: 'K5', decider: 'greedy' },
    ];
    const s = setup({ w: 12, h: 6, units });
    const shared = makeDeciders(s);
    for (let run = 0; run < 12; run++) {
      const a = new HashSink();
      const b = new HashSink();
      runFight(s, 9, run, makeDeciders(s), a);
      runFight(s, 9, run, shared, b);
      expect(b.hex(), `run ${run}`).toBe(a.hex());
    }
  });
});
