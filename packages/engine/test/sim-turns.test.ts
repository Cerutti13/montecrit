// Turns: the Attack action and Multiattack, thrown gear, initiative, end conditions.
import { describe, expect, it } from 'vitest';
import { makeDeciders } from '../src/decide/make.ts';
import { takeList } from '../src/sim/context.ts';
import { createContext } from '../src/sim/fight.ts';
import { listOptions } from '../src/sim/options.ts';
import { resolveOption } from '../src/sim/act.ts';
import { DUMMY, FIGHTER, MULTI, SENTRY, SKIRMISHER, setup } from './helpers/build.ts';
import { ofKind, run } from './helpers/run.ts';

/** Keys a unit is offered right now. */
function offered(cx: ReturnType<typeof createContext>, seat: string): string[] {
  const u = cx.st.units.find((x) => x.seat === seat)!;
  const list = listOptions(cx, u, takeList(cx));
  const out: string[] = [];
  for (let i = 0; i < list.n; i++) {
    const l = list.items[i]!;
    out.push(l.k === 'attack' ? `attack:${u.tpl.attacks[l.atk]!.local}` : l.k);
  }
  return [...new Set(out)];
}

function strike(cx: ReturnType<typeof createContext>, seat: string, local: string): void {
  const u = cx.st.units.find((x) => x.seat === seat)!;
  const list = listOptions(cx, u, takeList(cx));
  for (let i = 0; i < list.n; i++) {
    const l = list.items[i]!;
    if (l.k === 'attack' && u.tpl.attacks[l.atk]!.local === local) return resolveOption(cx, u, { ...l }, -1);
  }
  throw new Error(`${seat} can't strike with ${local}`);
}

function ready(seat: string, s: ReturnType<typeof setup>) {
  const cx = createContext(s, 1, 0, makeDeciders(s), null);
  const u = cx.st.units.find((x) => x.seat === seat)!;
  cx.st.active = u.idx;
  Object.assign(u.b, { action: 1, bonus: 1, moveFt: u.tpl.speedFt });
  return cx;
}

describe('the Attack action and Multiattack', () => {
  const s = (flags = {}) => setup({ w: 6, h: 3, flags, units: [{ seat: 'm', team: 1, tpl: MULTI, at: 'B2' }, { seat: 'd', team: 0, tpl: DUMMY, at: 'C2' }] });

  it("Multiattack's strikes can come in any order across overlapping lines, and it spends one action", () => {
    const cx = ready('m', s());
    strike(cx, 'm', 'bite');
    const m = cx.st.units.find((x) => x.seat === 'm')!;
    expect(m.b.action).toBe(0);
    // After a bite, either a claw/bite (line 1) or the tail (line 2) can follow.
    expect(offered(cx, 'm').filter((k) => k.startsWith('attack'))).toEqual(['attack:claw', 'attack:bite', 'attack:tail']);
    strike(cx, 'm', 'tail');
    expect(m.b.atkActive).toBe(false); // line 2 is full; nothing else fits
    expect(offered(cx, 'm').some((k) => k.startsWith('attack'))).toBe(false);
  });

  it('a claw first rules out the tail line', () => {
    const cx = ready('m', s());
    strike(cx, 'm', 'claw');
    expect(offered(cx, 'm').filter((k) => k.startsWith('attack'))).toEqual(['attack:claw', 'attack:bite']);
  });

  it('moveBetweenAttacks: moving mid-Multiattack keeps the strikes by default; under extraAttackOnly it gives them up', () => {
    const moveAway = (cx: ReturnType<typeof createContext>) => {
      const m = cx.st.units.find((x) => x.seat === 'm')!;
      const list = listOptions(cx, m, takeList(cx));
      for (let i = 0; i < list.n; i++) if (list.items[i]!.k === 'move' && list.items[i]!.provokes === 0) return resolveOption(cx, m, { ...list.items[i]! }, -1);
    };
    for (const [flag, still] of [['all', true], ['extraAttackOnly', false]] as const) {
      const cx = ready('m', s({ moveBetweenAttacks: flag }));
      strike(cx, 'm', 'claw');
      expect(offered(cx, 'm')).toContain('move');
      moveAway(cx);
      expect(cx.st.units.find((x) => x.seat === 'm')!.b.atkActive).toBe(still);
    }
  });

  it('Extra Attack gives a PC two strikes with any of its attacks, and unused strikes are lost at turn end', () => {
    const t = setup({ w: 6, h: 3, units: [{ seat: 'pc', team: 0, tpl: FIGHTER, at: 'B2' }, { seat: 'd', team: 1, tpl: DUMMY, at: 'C2' }] });
    const cx = ready('pc', t);
    strike(cx, 'pc', 'longsword');
    expect(offered(cx, 'pc')).toEqual(expect.arrayContaining(['attack:longsword', 'attack:unarmed-strike']));
    strike(cx, 'pc', 'unarmed-strike');
    expect(cx.st.units.find((x) => x.seat === 'pc')!.b.atkActive).toBe(false);
  });
});

describe('thrown gear', () => {
  const s = (flags = {}) => setup({ w: 8, h: 2, flags, units: [{ seat: 'g', team: 0, tpl: SENTRY, at: 'A1' }, { seat: 'd', team: 1, tpl: DUMMY, at: 'E1' }] });

  it('monsterThrownWeapons=gearCount: throwing the only spear leaves only the Unarmed Strike', () => {
    const cx = ready('g', s());
    expect(offered(cx, 'g')).toContain('attack:spear-thrown');
    strike(cx, 'g', 'spear-thrown');
    const g = cx.st.units.find((x) => x.seat === 'g')!;
    expect(g.gear[0]).toBe(0);
    g.b.action = 1;
    g.cell = 3; // D1, next to the dummy
    expect(offered(cx, 'g').filter((k) => k.startsWith('attack'))).toEqual(['attack:unarmed-strike']);
  });

  it('monsterThrownWeapons=unlimited: the spear never runs out', () => {
    const cx = ready('g', s({ monsterThrownWeapons: 'unlimited' }));
    strike(cx, 'g', 'spear-thrown');
    const g = cx.st.units.find((x) => x.seat === 'g')!;
    g.b.action = 1;
    expect(offered(cx, 'g')).toContain('attack:spear-thrown');
  });
});

describe('initiative (p.13)', () => {
  const units = [
    { seat: 'g1', team: 1 as const, tpl: SKIRMISHER, at: 'A1' },
    { seat: 'g2', team: 1 as const, tpl: SKIRMISHER, at: 'A3' },
    { seat: 'pc', team: 0 as const, tpl: FIGHTER, at: 'F2' },
  ];

  it('identical monsters share one roll (groupInitiative=shared), or roll separately', () => {
    const shared = run(setup({ w: 6, h: 3, units }), 4);
    const inits = ofKind(shared.events, 'initiative');
    const g = (r: typeof inits, seat: string) => r.find((e) => shared.st.units[e.who]!.seat === seat)!;
    expect(g(inits, 'g2').total).toBe(g(inits, 'g1').total);
    expect(g(inits, 'g2').leader).toBe(g(inits, 'g1').who);
    const sep = run(setup({ w: 6, h: 3, units, flags: { groupInitiative: 'individual' } }), 4);
    expect(ofKind(sep.events, 'initiative').every((e) => e.leader === e.who)).toBe(true);
  });

  it('static initiative uses the listed score, minus 5 when surprised', () => {
    const r = run(setup({ w: 6, h: 3, flags: { initiativeMode: 'static' }, units: [units[0]!, { ...units[2]!, surprised: true }] }), 1);
    expect(ofKind(r.events, 'initiative').map((e) => [r.st.units[e.who]!.seat, e.total])).toEqual([['g1', 12], ['pc', 6]]);
  });

  it('initiativeTies decides ties between groups: pcsFirst puts the PC first', () => {
    const s = setup({ w: 6, h: 3, flags: { initiativeMode: 'static', initiativeTies: 'pcsFirst' }, units: [units[0]!, { seat: 'pc', team: 0, tpl: { ...FIGHTER, initMod: 2, initScore: 12 }, at: 'F2' }] });
    const r = run(s, 1);
    expect(r.st.units[r.st.order[0]!]!.seat).toBe('pc');
    expect(r.result.flagsUsed[5]).toBe(1); // initiativeTies was read
  });
});

describe('end of the fight', () => {
  it('maxRounds without a winner is a stalemate', () => {
    const r = run(setup({ w: 6, h: 1, knobs: { maxRounds: 3 }, units: [{ seat: 'a', team: 0, tpl: DUMMY, at: 'A1' }, { seat: 'z', team: 1, tpl: DUMMY, at: 'F1' }] }), 1);
    expect(r.result.outcome).toEqual({ k: 'stalemate', round: 3, tpk: false });
  });

  it('lossCounts=pcs: the party loses when its PCs are down even if an ally stands; lossCounts=party plays on', () => {
    const mk = (lossCounts: 'pcs' | 'party') =>
      setup({
        w: 8, h: 2, flags: { initiativeMode: 'static' }, knobs: { lossCounts, maxRounds: 2 },
        units: [{ seat: 'pc', team: 0, tpl: FIGHTER, at: 'B1', hp: 1, surprised: true }, { seat: 'ally', team: 0, tpl: SENTRY, at: 'H2', surprised: true }, { seat: 'brute', team: 1, tpl: { ...DUMMY, speedFt: 30, attacks: [{ ...DUMMY.attacks[0]!, toHit: 100, damage: [{ ...DUMMY.attacks[0]!.damage[0]!, roll: { k: 'const', v: 5 } }] }, DUMMY.attacks[1]!] }, at: 'C1' }],
      });
    const pcs = run(mk('pcs'), 3);
    expect(pcs.result.outcome.k).toBe('loss');
    const party = run(mk('party'), 3);
    expect(party.result.outcome.k).not.toBe('loss');
  });
});
