// Movement and opportunity attacks: SRD 5.2.1 p.13-15, p.185 (see docs/research/m1a-rules-2024.md).
import { describe, expect, it } from 'vitest';
import { cellName, parseCell } from '../src/grid/cells.ts';
import { cellInfo, computeReach, forEachLabel, newReachScratch, stepCost } from '../src/grid/reach.ts';
import { makeDeciders } from '../src/decide/make.ts';
import { createContext } from '../src/sim/fight.ts';
import { ARCHER, DUMMY, FIGHTER, REACHER, SENTRY, SKIRMISHER, setup, template } from './helpers/build.ts';
import { findSeed, ofKind, run } from './helpers/run.ts';

const at = (name: string, w: number, h: number) => parseCell(name, w, h);

/** Labels offered to unit `seat` at fight start, as 'C3/p1:15'. */
function labels(s: ReturnType<typeof setup>, seat: string, budget?: number): string[] {
  const cx = createContext(s, 1, 0, makeDeciders(s), null);
  const u = cx.st.units.find((x) => x.seat === seat)!;
  const sc = newReachScratch(s.w * s.h);
  const ft = budget ?? u.tpl.speedFt;
  computeReach(cx.st, u, ft, sc);
  const out: string[] = [];
  forEachLabel(cx.st, u, sc, ft, (c, f, p) => out.push(`${cellName(c, s.w)}/p${p}:${f}`));
  return out;
}

describe('grid costs (p.13-14)', () => {
  const base = (flags = {}) => setup({ w: 6, h: 6, units: [{ seat: 'a', team: 0, tpl: FIGHTER, at: 'C3' }, { seat: 'z', team: 1, tpl: SKIRMISHER, at: 'F6' }], flags });

  it('every adjacent square costs 5 ft, diagonals included (diagonalCost=uniform)', () => {
    const l = labels(base(), 'a');
    expect(l).toContain('D4/p0:5');
    expect(l).toContain('E5/p0:10');
    expect(l).toContain('A1/p0:10');
  });

  it('diagonalCost=alternate: the second diagonal costs 10 ft', () => {
    const l = labels(base({ diagonalCost: 'alternate' }), 'a');
    expect(l).toContain('D4/p0:5');
    expect(l).toContain('E5/p0:15');
  });

  it('Difficult Terrain doubles a square; crawling doubles again; crawling through Difficult Terrain costs 15', () => {
    const terrain = ['......', '......', '...:..', '......', '......', '......'];
    const s = setup({ w: 6, h: 6, terrain, units: [{ seat: 'a', team: 0, tpl: FIGHTER, at: 'C3' }, { seat: 'p', team: 0, tpl: FIGHTER, at: 'C5', prone: true }, { seat: 'z', team: 1, tpl: SKIRMISHER, at: 'F6' }] });
    const cx = createContext(s, 1, 0, makeDeciders(s), null);
    const [a, p] = [cx.st.units.find((u) => u.seat === 'a')!, cx.st.units.find((u) => u.seat === 'p')!];
    const d3 = at('D3', 6, 6);
    expect(stepCost(cx.st, a, a.cell, d3, 0, cellInfo(cx.st, a, d3))).toBe(10);
    const d5 = at('D5', 6, 6);
    expect(stepCost(cx.st, p, p.cell, d5, 0, cellInfo(cx.st, p, d5))).toBe(10);
    const d4 = at('D4', 6, 6);
    p.cell = d4;
    expect(stepCost(cx.st, p, d4, d3, 0, cellInfo(cx.st, p, d3))).toBe(15);
  });

  it('a diagonal can\'t cut a wall corner (diagonalCorner=eitherBlocks), but can with bothBlock if only one side is wall', () => {
    const terrain = ['......', '......', '...#..', '......', '......', '......'];
    const mk = (flags = {}) => setup({ w: 6, h: 6, terrain, units: [{ seat: 'a', team: 0, tpl: FIGHTER, at: 'C3' }, { seat: 'z', team: 1, tpl: SKIRMISHER, at: 'F6' }], flags });
    for (const [flags, cost] of [[{}, Infinity], [{ diagonalCorner: 'bothBlock' }, 5]] as const) {
      const s = mk(flags);
      const cx = createContext(s, 1, 0, makeDeciders(s), null);
      const a = cx.st.units.find((u) => u.seat === 'a')!;
      const d2 = at('D2', 6, 6);
      const c = stepCost(cx.st, a, a.cell, d2, 0, cellInfo(cx.st, a, d2));
      expect(c >= 0x3fffffff ? Infinity : c).toBe(cost);
    }
  });

  it('you can pass through an ally but not end there; an enemy blocks; its space would be Difficult Terrain', () => {
    const s = setup({ w: 5, h: 1, units: [{ seat: 'a', team: 0, tpl: FIGHTER, at: 'A1' }, { seat: 'b', team: 0, tpl: FIGHTER, at: 'B1' }, { seat: 'z', team: 1, tpl: FIGHTER, at: 'D1' }] });
    expect(labels(s, 'a')).toEqual(['C1/p0:10']); // through B1, not into it, and D1 blocks
  });

  it('you can pass through an Incapacitated enemy, a Tiny one, or one two sizes different; its space costs double', () => {
    const tiny = template({ id: 'mote', size: 'tiny', attacks: [{ local: 'nip', toHit: 0, damage: [['1', 'piercing']] }] });
    const huge = template({ id: 'giant', size: 'huge', attacks: [{ local: 'slam', toHit: 0, damage: [['1', 'bludgeoning']] }] });
    const mk = (tpl: typeof FIGHTER) => setup({ w: 4, h: 1, units: [{ seat: 'a', team: 0, tpl: FIGHTER, at: 'A1' }, { seat: 'z', team: 1, tpl, at: 'B1' }] });
    // C1 is still inside z's reach, so no provoke yet.
    expect(labels(mk(tiny), 'a')).toContain('C1/p0:10'); // Tiny: not Difficult Terrain
    expect(labels(mk(huge), 'a')).toContain('C1/p0:15'); // two sizes larger: Difficult Terrain
    expect(labels(mk(FIGHTER), 'a')).toEqual([]); // same size: blocked
  });

  it('standing up costs half your Speed; a Prone creature crawls', () => {
    const s = setup({ w: 8, h: 1, units: [{ seat: 'a', team: 0, tpl: FIGHTER, at: 'A1', prone: true }, { seat: 'z', team: 1, tpl: DUMMY, at: 'H1' }] });
    expect(labels(s, 'a').at(-1)).toBe('D1/p0:30'); // 3 squares crawled at 10 ft each
    const r = run(s, 3, [{ seat: 'a', key: 'stand' }, { seat: 'a', key: 'move:D1/p0' }]);
    const steps = ofKind(r.events, 'step').filter((e) => e.who === r.st.units.find((u) => u.seat === 'a')!.idx);
    expect(steps[0]!.left).toBe(10); // 30 - 15 to stand - 5
  });
});

describe('opportunity attacks (p.15, p.185)', () => {
  // gob1 starts adjacent to ally1 and goes first (static initiative 12 vs 11).
  const demo = (flags = {}, hp = 4) =>
    setup({
      w: 8, h: 4, name: 'oa-demo', flags: { initiativeMode: 'static', ...flags },
      units: [
        { seat: 'gob1', team: 1, tpl: SKIRMISHER, at: 'B2', hp },
        { seat: 'ally1', team: 0, tpl: SENTRY, at: 'C2' },
        { seat: 'pc1', team: 0, tpl: FIGHTER, at: 'H4' },
      ],
    });

  it('leaving reach provokes; the attack lands before the step, and a downed mover never leaves its square', () => {
    const s = demo();
    const seed = findSeed((sd) => {
      const r = run(s, sd, [{ seat: 'gob1', key: 'move:F3/p1' }]);
      return ofKind(r.events, 'death').length === 1 && ofKind(r.events, 'death')[0]!.who === 1;
    });
    const r = run(s, seed, [{ seat: 'gob1', key: 'move:F3/p1' }]);
    const ks = r.events.map((e) => e.k);
    const iProvoke = ks.indexOf('provoke');
    expect(ks.slice(iProvoke, iProvoke + 6)).toEqual(['provoke', 'decided', 'attack', 'damage', 'death', 'moveEnd']);
    const prov = ofKind(r.events, 'provoke')[0]!;
    const end = ofKind(r.events, 'moveEnd')[0]!;
    expect(end.why).toBe('died');
    expect(end.cell).toBe(prov.from);
    expect(ofKind(r.events, 'step').some((e) => e.from === prov.from && e.to === prov.to)).toBe(false);
    expect(ofKind(r.events, 'attack')[0]!.opportunity).toBe(true);
  });

  it('a mover that survives keeps walking its route', () => {
    const s = demo({}, 10);
    const seed = findSeed((sd) => {
      const r = run(s, sd, [{ seat: 'gob1', key: 'move:F3/p1' }]);
      return ofKind(r.events, 'moveEnd')[0]?.why === 'arrived';
    });
    const r = run(s, seed, [{ seat: 'gob1', key: 'move:F3/p1' }]);
    expect(ofKind(r.events, 'moveEnd')[0]!.cell).toBe(at('F3', 8, 4));
    expect(ofKind(r.events, 'provoke')).toHaveLength(1);
  });

  it('moving within reach doesn\'t provoke', () => {
    const r = run(demo(), 1, [{ seat: 'gob1', key: 'move:B3/p0' }]);
    expect(ofKind(r.events, 'provoke').filter((e) => e.mover === 1)).toHaveLength(0);
  });

  it('Disengage (here as a Bonus Action) stops the move from provoking', () => {
    const r = run(demo(), 1, [{ seat: 'gob1', key: 'opt:nimble' }, { seat: 'gob1', key: 'move:F3/p0' }]);
    expect(ofKind(r.events, 'provoke').filter((e) => e.mover === 1)).toHaveLength(0);
    expect(ofKind(r.events, 'moveEnd')[0]!.cell).toBe(at('F3', 8, 4));
    const off = ofKind(r.events, 'cond').find((e) => e.cond === 'core:disengaged' && !e.on);
    expect(off).toBeDefined(); // ends with the turn
  });

  it('a spent Reaction allows no second opportunity attack until its owner\'s next turn', () => {
    const s = setup({
      w: 8, h: 4, flags: { initiativeMode: 'static' },
      units: [
        { seat: 'gob1', team: 1, tpl: SKIRMISHER, at: 'B2', hp: 30 },
        { seat: 'gob2', team: 1, tpl: SKIRMISHER, at: 'B3', hp: 30 },
        { seat: 'ally1', team: 0, tpl: SENTRY, at: 'C2' },
      ],
    });
    // Goblins share one initiative roll (12) and go in seat order before ally1 (11).
    // gob2's route offers no provoking label at all: ally1 has nothing left to react with.
    const r = run(s, 5, [{ seat: 'gob1', key: 'move:F2/p1' }, { seat: 'gob1', key: 'pass' }, { seat: 'gob2', key: 'move:F3/p0' }]);
    const provokes = ofKind(r.events, 'provoke').filter((e) => e.round === 1);
    expect(provokes.map((e) => s.seats[e.mover]!.seat)).toEqual(['gob1']);
  });

  it('reach is the longest reach: stepping from 5 to 10 ft of a reach-10 creature is safe, leaving 10 ft provokes', () => {
    const s = setup({ w: 8, h: 1, flags: { initiativeMode: 'static' }, units: [{ seat: 'gob1', team: 1, tpl: SKIRMISHER, at: 'C1', hp: 30 }, { seat: 'r', team: 0, tpl: REACHER, at: 'B1' }] });
    expect(labels(s, 'gob1')).toContain('D1/p0:5');
    expect(labels(s, 'gob1')).toContain('E1/p1:10');
  });

  it('a creature with no melee weapon makes its opportunity attack with an Unarmed Strike', () => {
    const s = setup({ w: 8, h: 2, flags: { initiativeMode: 'static' }, units: [{ seat: 'gob1', team: 1, tpl: SKIRMISHER, at: 'B1', hp: 30 }, { seat: 'arc', team: 0, tpl: ARCHER, at: 'C1' }] });
    const r = run(s, 1, [{ seat: 'gob1', key: 'move:F1/p1' }]);
    const dec = ofKind(r.events, 'decided').find((e) => e.dk === 'reaction')!;
    expect(dec.key).toBe('oa:unarmed-strike');
  });

  it('when several creatures react at once, the mover (whose turn it is) orders them', () => {
    const s = setup({
      w: 8, h: 3, flags: { initiativeMode: 'static' },
      units: [{ seat: 'gob1', team: 1, tpl: SKIRMISHER, at: 'B2', hp: 50 }, { seat: 'ally1', team: 0, tpl: SENTRY, at: 'A2' }, { seat: 'ally2', team: 0, tpl: SENTRY, at: 'B3' }],
    });
    const r = run(s, 2, [{ seat: 'gob1', key: 'move:F1/p2' }, { seat: 'gob1', key: 'order:ally2' }]);
    const provs = ofKind(r.events, 'provoke');
    expect(provs.map((e) => s.seats[e.by]!.seat)).toEqual(['ally2', 'ally1']);
  });

  it('a mover downed while passing through an ally\'s square stays in it and ends up sharing it', () => {
    const terrain = ['##.###', '......'];
    const s = setup({
      w: 6, h: 2, terrain, flags: { initiativeMode: 'static' },
      units: [
        { seat: 'pc1', team: 0, tpl: template({ id: 'runner', kind: 'pc', hp: 5, dex: 20, attacks: [{ local: 'stick', toHit: 0, damage: [['1', 'bludgeoning']] }] }), at: 'A2' },
        // Hits on anything but a 1 for 6: drops the 5-HP runner without massive damage.
        { seat: 'brute', team: 1, tpl: template({ id: 'thug', ac: 12, hp: 40, attacks: [{ local: 'club', toHit: 100, damage: [['6', 'bludgeoning']] }] }), at: 'C1' },
        { seat: 'ally', team: 0, tpl: SENTRY, at: 'D2' },
      ],
    });
    const seed = findSeed((sd) => ofKind(run(s, sd, [{ seat: 'pc1', key: 'move:F2/p1' }]).events, 'down').length > 0);
    const r = run(s, seed, [{ seat: 'pc1', key: 'move:F2/p1' }]);
    const pc = r.st.units.find((u) => u.seat === 'pc1')!;
    expect(cellName(pc.cell, 6)).toBe('D2');
    expect(r.st.units.find((u) => u.seat === 'ally')!.cell).toBe(pc.cell);
  });
});
