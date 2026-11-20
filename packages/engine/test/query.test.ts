// Deciders' queries (docs/design/m1c.md 3): exact damage and save odds, forced paths the engine
// will offer, area candidates, threat. And calling them any number of times changes nothing.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../src/content/load.ts';
import { compileKeyPattern, saveKey } from '../src/content/rollkeys.ts';
import { DAMAGE_TYPES, damageBit, SIZES, type CompiledDamage } from '../src/content/types.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import type { Decider, DecisionPoint, UnitView } from '../src/decide/decider.ts';
import { makeDeciders } from '../src/decide/make.ts';
import { RandomLegalDecider } from '../src/decide/random-legal.ts';
import { parseExpr } from '../src/dice/expr.ts';
import { areaCells, anchorCount, anchorRangeFt, shapeKey } from '../src/grid/area.ts';
import { parseCell } from '../src/grid/cells.ts';
import { HashSink } from '../src/log/events.ts';
import { mean, probAt } from '../src/odds/pmf.ts';
import { areaCandidates, type AreaCand } from '../src/query/area.ts';
import { forcedPaths, type ForcedPath } from '../src/query/forced.ts';
import { damagePmf, expectedCapped, saveOdds } from '../src/query/odds.ts';
import { actionEV, threatAt, threatKind, threatSplitAt } from '../src/query/threat.ts';
import type { JournalEntry } from '../src/replay.ts';
import { resolveScenario } from '../src/scenario/resolve.ts';
import { newFx } from '../src/sim/effects.ts';
import { createContext, runFight } from '../src/sim/fight.ts';
import { forcedMove } from '../src/sim/forced.ts';
import type { FightSetup } from '../src/sim/setup.ts';
import type { Unit } from '../src/sim/state.ts';
import { DUMMY, effect, FIGHTER, setup, SKIRMISHER, withEffects } from './helpers/build.ts';
import { loadScenario } from './helpers/scenario.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const walk = (d: string): string[] =>
  readdirSync(d)
    .flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.yaml') ? [p] : [];
    })
    .sort();
const readPack = (name: string): SourceFile[] => walk(join(ROOT, 'packs', name)).map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, 'utf8') }));
const loaded = loadContent([...readPack('srd-5.2.1'), ...readPack('test')]);
if (!loaded.content) throw new Error(loaded.errors.map(formatDiag).join('\n'));
const CONTENT = loaded.content;
const scenario = (file: string): FightSetup => loadScenario(file, CONTENT);
const part = (roll: string, type: string, ifAdvantage = false): CompiledDamage => ({ roll: parseExpr(roll), critExtra: parseExpr(roll.split('+')[0]!.trim()), type: DAMAGE_TYPES.indexOf(type as never), avg: 0, ifAdvantage });

describe('damagePmf', () => {
  const ctx = (tplOver: Partial<typeof DUMMY> = {}) => {
    const s = setup({ w: 4, h: 1, units: [{ seat: 't', team: 1, tpl: { ...DUMMY, ...tplOver }, at: 'A1' }, { seat: 'a', team: 0, tpl: FIGHTER, at: 'D1' }] });
    return createContext(s, 1, 0, makeDeciders(s), null).st.units.find((u) => u.seat === 't')!;
  };

  it('a save for half floors each instance: 2d10 halved averages 5.25, not 5.5', () => {
    expect(mean(damagePmf([part('2d10', 'radiant')], null, false, false, true))).toBeCloseTo(5.25, 12);
  });

  it('a crit adds the dice again; an Advantage-only rider counts only with Advantage', () => {
    const scimitar = [part('1d6 + 2', 'slashing'), { ...part('1d4', 'slashing', true), critExtra: parseExpr('1d4') }];
    expect(mean(damagePmf(scimitar, null, false, false))).toBeCloseTo(5.5, 12);
    expect(mean(damagePmf(scimitar, null, false, true))).toBeCloseTo(8, 12);
    expect(mean(damagePmf(scimitar, null, true, false))).toBeCloseTo(9, 12);
  });

  it('defenses fold per damage type, half before Resistance: fire resisted, slashing not, cold immune, acid doubled', () => {
    const t = ctx({ resist: damageBit(DAMAGE_TYPES.indexOf('fire')), immune: damageBit(DAMAGE_TYPES.indexOf('cold')), vuln: damageBit(DAMAGE_TYPES.indexOf('acid')) });
    const d = damagePmf([part('5', 'fire'), part('3', 'slashing'), part('9', 'cold'), part('2', 'acid')], t, false, false);
    expect(probAt(d, 2 + 3 + 0 + 4)).toBe(1); // floor(5/2) + 3 + 0 + 2*2
    const halved = damagePmf([part('7', 'fire')], t, false, false, true);
    expect(probAt(halved, 1)).toBe(1); // floor(floor(7/2)/2)
  });

  it('expectedCapped counts no overkill', () => {
    expect(expectedCapped(damagePmf([part('1d6', 'piercing')], null, false, false), 3)).toBeCloseTo(2.5, 12);
  });
});

describe('saveOdds', () => {
  it('folds effect modifiers: a d20 floor of 10 on concentration saves makes a DC 10 save certain for CON +0', () => {
    const steady = effect('steady', { mods: [{ on: [compileKeyPattern('d20.save.con.concentration')], side: 'self', op: 'floor', value: 10, dice: null, consume: false, skillParam: false }] });
    const s = setup({ w: 4, h: 1, units: [{ seat: 'pc', team: 0, tpl: withEffects(FIGHTER, [steady]), at: 'A1' }, { seat: 'g', team: 1, tpl: DUMMY, at: 'D1' }] });
    const cx = createContext(s, 1, 0, makeDeciders(s), null);
    const pc = cx.st.units.find((u) => u.seat === 'pc')!;
    const qs = cx.views[pc.idx]!.scratch;
    expect(saveOdds(cx.st, qs, pc, saveKey(2, true), 10).pSuccess).toBeCloseTo(0.55, 12);
    newFx(cx, { tpl: 0, owner: pc.idx, bearer: pc.idx, parent: -1, param: -1, srcItem: -1, until: { k: 'never' }, cause: -1 });
    expect(saveOdds(cx.st, qs, pc, saveKey(2, true), 10).pSuccess).toBe(1);
    expect(saveOdds(cx.st, qs, pc, saveKey(2), 10).pSuccess).toBeCloseTo(0.55, 12); // other CON saves don't get the floor
    expect(saveOdds(cx.st, qs, pc, saveKey(2, true), 11).pSuccess).toBeCloseTo(0.5, 12); // a 10 still misses DC 11
  });
});

describe('forcedPaths', () => {
  const scene = (gobAt: string, others: { seat: string; at: string }[] = []) => {
    const s = setup({ w: 10, h: 7, units: [{ seat: 'pc', team: 0, tpl: FIGHTER, at: 'B4' }, { seat: 'gob', team: 1, tpl: SKIRMISHER, at: gobAt }, ...others.map((o) => ({ seat: o.seat, team: 1 as const, tpl: SKIRMISHER, at: o.at }))] });
    const cx = createContext(s, 1, 0, makeDeciders(s), null);
    const u = (seat: string): Unit => cx.st.units.find((x) => x.seat === seat)!;
    return { cx, s, u };
  };
  const STEP = { mode: 'pull' as const, maxFt: 10, maxSize: SIZES.indexOf('large') };

  it('lists stop first, then each square, depth first; every path walks through the engine\'s own pull choices', () => {
    const { cx, s, u } = scene('F4', [{ seat: 'x', at: 'E3' }]);
    const paths: ForcedPath[] = [];
    forcedPaths(cx.st, cx.views[0]!.scratch, u('pc'), u('pc').cell, u('gob'), STEP, paths);
    expect(paths[0]!.cells).toEqual([]);
    expect(paths.length).toBeGreaterThan(3);
    for (const p of paths) {
      const again = scene('F4', [{ seat: 'x', at: 'E3' }]);
      let stepIdx = 0;
      const follow: Decider = {
        name: 'follow',
        decide: (_v: UnitView, dp: DecisionPoint) => {
          const want = p.cells[stepIdx++] ?? -1; // then stop (cell -1)
          for (let i = 0; i < dp.legal.n; i++) if (dp.legal.items[i]!.cell === want) return i;
          throw new Error(`path ${p.cells.join(',')} offers no ${want} (${dp.legal.n} items)`);
        },
      };
      (again.cx.deciders as Decider[])[again.u('pc').idx] = follow;
      forcedMove(again.cx, again.u('pc'), again.u('gob').idx, STEP, -1);
      expect(again.u('gob').cell, `path ${p.cells.join(',')}`).toBe(p.cells.length ? p.cells[p.cells.length - 1] : parseCell('F4', s.w, s.h));
    }
  });

  it('planned from where the puller will stand equals what the engine offers once it stands there', () => {
    for (const to of ['C4', 'C3', 'D5', 'B6', 'E2']) {
      const planned = scene('G4', [{ seat: 'x', at: 'E4' }]);
      const live = scene('G4', [{ seat: 'x', at: 'E4' }]);
      const a: ForcedPath[] = [];
      const b: ForcedPath[] = [];
      const cell = parseCell(to, planned.s.w, planned.s.h);
      forcedPaths(planned.cx.st, planned.cx.views[0]!.scratch, planned.u('pc'), cell, planned.u('gob'), STEP, a);
      live.u('pc').cell = cell;
      forcedPaths(live.cx.st, live.cx.views[0]!.scratch, live.u('pc'), cell, live.u('gob'), STEP, b);
      expect(a, to).toEqual(b);
    }
    // the puller's old square opens up: from F4 the pull can now end on B4 territory once pc has left it
    const p = scene('C4');
    const out: ForcedPath[] = [];
    forcedPaths(p.cx.st, p.cx.views[0]!.scratch, p.u('pc'), parseCell('A4', p.s.w, p.s.h), p.u('gob'), STEP, out);
    expect(out.some((x) => x.cells.includes(parseCell('B4', p.s.w, p.s.h)))).toBe(true);
  });

  it('a creature too big to move, or dead, has no paths', () => {
    const { cx, u } = scene('F4');
    const out: ForcedPath[] = [];
    expect(forcedPaths(cx.st, cx.views[0]!.scratch, u('pc'), u('pc').cell, u('gob'), { ...STEP, maxSize: SIZES.indexOf('tiny') }, out)).toBe(0);
  });
});

describe('areaCandidates', () => {
  it('one anchor per distinct set of covered creatures: the nearest in range, matching a brute-force pass over every anchor', () => {
    for (const origin of ['squareCenter', 'gridIntersection'] as const) {
      const s = setup({ w: 12, h: 8, flags: { areaOriginOnGrid: origin }, units: [{ seat: 'pc', team: 0, tpl: FIGHTER, at: 'A8' }, ...['D3', 'E3', 'E5', 'H4', 'I6', 'K2'].map((at, i) => ({ seat: `g${i}`, team: 1 as const, tpl: DUMMY, at }))] });
      const cx = createContext(s, 1, 0, makeDeciders(s), null);
      const pc = cx.st.units.find((u) => u.seat === 'pc')!;
      const key = shapeKey('sphere', 10);
      const out: AreaCand[] = [];
      areaCandidates(cx.st, pc, key, 60, pc.cell, out);
      const best = new Map<string, { a: number; d: number }>();
      const cells: number[] = [];
      for (let a = 0; a < anchorCount(cx.st); a++) {
        const d = anchorRangeFt(cx.st, pc.cell, a);
        if (d > 60) continue;
        areaCells(cx.st, key, a, cells);
        const sig = cx.st.units.filter((u) => cells.includes(u.cell)).map((u) => u.idx).join(',');
        if (!sig) continue;
        const b = best.get(sig);
        if (!b || d < b.d) best.set(sig, { a, d });
      }
      expect(out.map((c) => c.anchor).sort((x, y) => x - y), origin).toEqual([...best.values()].map((b) => b.a).sort((x, y) => x - y));
      for (const c of out) expect(c.nEnemies + c.nAllies).toBeGreaterThan(0);
    }
  });
});

describe('threat', () => {
  it('a Goblin Boss\'s routine is worth 5.85 against AC 15 either way (two strikes, +4, 1d6 + 2)', () => {
    const s = scenario('scenarios/stars-ambush.yaml');
    const cx = createContext(s, 1, 0, makeDeciders(s), null);
    const boss = cx.st.units.find((u) => u.seat === 'boss1')!;
    const ev = actionEV(cx.st, boss, 15);
    expect([ev.melee, ev.ranged]).toEqual([expect.closeTo(5.85, 10), expect.closeTo(5.85, 10)]);
  });

  it('a melee-only enemy threatens a square within its speed plus reach, split across the creatures it threatens', () => {
    const brute = { ...FIGHTER, kind: 'monster' as const };
    const s = setup({ w: 20, h: 1, units: [{ seat: 'pc', team: 0, tpl: FIGHTER, at: 'A1' }, { seat: 'pc2', team: 0, tpl: FIGHTER, at: 'B1' }, { seat: 'brute', team: 1, tpl: brute, at: 'H1' }] });
    const cx = createContext(s, 1, 0, makeDeciders(s), null);
    const pc = cx.st.units.find((u) => u.seat === 'pc')!;
    const b = cx.st.units.find((u) => u.seat === 'brute')!;
    const full = actionEV(cx.st, b, 18).melee;
    expect(threatAt(cx.st, pc, parseCell('A1', s.w, s.h))).toBeCloseTo(full / 2, 12); // H1 to A1 is 35 ft = 30 + 5 reach; both PCs threatened
    expect(threatAt(cx.st, pc, parseCell('T1', s.w, s.h))).toBe(0); // out past it
  });

  it('when both routines reach, the better one counts, except within 5 ft, where the shot has Disadvantage and melee counts', () => {
    const bow = { melee: 3, ranged: 4, reachFt: 5, rangeFt: 80 };
    expect(threatKind(5, 30, bow)).toBe('melee');
    expect(threatKind(10, 30, bow)).toBe('ranged');
    expect(threatKind(10, 30, { ...bow, ranged: 3 })).toBe('melee'); // a tie stays melee
    expect(threatKind(60, 30, bow)).toBe('ranged'); // only the bow reaches
    expect(threatKind(90, 30, bow)).toBe(null);
  });

  it('threatAt is the sum of threatSplitAt\'s melee and ranged parts on every square', () => {
    const s = scenario('scenarios/stars-ambush.yaml');
    const cx = createContext(s, 1, 0, makeDeciders(s), null);
    const pc = cx.st.units.find((u) => u.seat === 'pc1')!;
    for (let c = 0; c < s.w * s.h; c++) {
      const sp = threatSplitAt(cx.st, pc, c);
      expect(threatAt(cx.st, pc, c)).toBeCloseTo(sp.melee + sp.ranged, 12);
    }
  });
});

describe('decision context', () => {
  it('target, place and pull decisions name what\'s asking', () => {
    const doc = parse(readFileSync(join(ROOT, 'scenarios', 'golden', 'pull-into-spikes.journal.yaml'), 'utf8')) as { seed: number; run: number; entries: JournalEntry[] };
    const s = scenario('scenarios/golden/pull-into-spikes.yaml');
    const seen: string[] = [];
    const ds = makeDeciders(s, doc.entries).map((d) => ({ name: d.name, decide: (v: UnitView, dp: DecisionPoint) => (dp.k !== 'turn' && seen.push(`${dp.k} ${dp.src?.via ?? '-'}`), d.decide(v, dp)) }));
    runFight(s, doc.seed, doc.run, ds, null, { journal: doc.entries });
    expect(seen).toEqual(['place srd:spike-growth', 'pull test:tether', 'pull test:tether']);
  });
});

/** Calls every query on every decision, then lets `inner` decide. */
class Nosy implements Decider {
  readonly name: string;
  readonly inner: Decider;
  calls = 0;
  constructor(inner: Decider) {
    this.inner = inner;
    this.name = inner.name;
  }
  decide(view: UnitView, dp: DecisionPoint): number {
    const st = view.q;
    const me = st.units[view.me]!;
    for (let k = 0; k < 3; k++) {
      for (const a of me.tpl.attacks) damagePmf(a.damage, st.units[(view.me + 1) % st.units.length]!, k === 1, k === 2);
      saveOdds(st, view.scratch, me, saveKey(2, true), 12);
      areaCandidates(st, me, shapeKey('sphere', 20), 150, me.cell, []);
      for (const t of st.units) {
        if (t === me) continue;
        forcedPaths(st, view.scratch, me, me.cell, t, { mode: 'pull', maxFt: 10, maxSize: 3 }, []);
        threatAt(st, t, t.cell);
      }
      actionEV(st, me, 15);
      this.calls++;
    }
    return this.inner.decide(view, dp);
  }
}

describe('queries change nothing', () => {
  it('a decider that calls every query three times per decision gives the same logs as one that calls none', () => {
    const golden = join(ROOT, 'scenarios', 'golden');
    let calls = 0;
    const check = (setupOf: FightSetup, seed: number, run: number, base: () => Decider[], journal: readonly JournalEntry[] = []) => {
      const plain = new HashSink();
      const nosy = new HashSink();
      const a = runFight(setupOf, seed, run, base(), plain, { journal });
      const ds = base().map((d) => new Nosy(d));
      const b = runFight(setupOf, seed, run, ds, nosy, { journal });
      calls += ds.reduce((n, d) => n + d.calls, 0);
      expect([nosy.hex(), b.stateHash]).toEqual([plain.hex(), a.stateHash]);
    };
    for (const f of readdirSync(golden).filter((x) => x.endsWith('.journal.yaml'))) {
      const doc = parse(readFileSync(join(golden, f), 'utf8')) as { seed: number; run: number; entries: JournalEntry[] };
      const s = scenario(join('scenarios', 'golden', f.replace('.journal.yaml', '.yaml')));
      check(s, doc.seed, doc.run, () => makeDeciders(s, doc.entries), doc.entries);
    }
    for (const f of ['scenarios/stars-ambush.yaml', 'scenarios/golden/moonbeam-moved-then-turn-end.yaml']) {
      const s = scenario(f);
      for (let run = 0; run < 3; run++) check(s, 5, run, () => s.seats.map(() => new RandomLegalDecider()));
    }
    expect(calls).toBeGreaterThan(100);
  });
});
