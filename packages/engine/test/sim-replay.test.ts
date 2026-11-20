// Determinism, journals and replay. A fight is a pure function of its replay key; journals
// match by key and decision index; recorded fights replay exactly; dice stay aligned across
// build variants.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { IllegalDecision, JournalMismatch, NeedInput, type Decider, type DecisionPoint, type UnitView } from '../src/decide/decider.ts';
import { makeDeciders } from '../src/decide/make.ts';
import { RandomLegalDecider } from '../src/decide/random-legal.ts';
import { Recorder, RecordingDecider } from '../src/decide/recording.ts';
import { HashSink } from '../src/log/events.ts';
import { newScratch } from '../src/sim/context.ts';
import { runFight } from '../src/sim/fight.ts';
import type { FightSetup } from '../src/sim/setup.ts';
import { ARCHER, DUMMY, FIGHTER, MULTI, REACHER, SENTRY, SKIRMISHER, WARDED, setup, template, type UnitSpec } from './helpers/build.ts';
import { ofKind, run } from './helpers/run.ts';

const demo = (pcToHit = 6) =>
  setup({
    w: 8, h: 4, flags: { initiativeMode: 'static' },
    units: [
      { seat: 'gob1', team: 1, tpl: SKIRMISHER, at: 'B2', hp: 30 },
      { seat: 'gob2', team: 1, tpl: SKIRMISHER, at: 'D3', hp: 30 },
      { seat: 'ally1', team: 0, tpl: SENTRY, at: 'C2' },
      { seat: 'pc1', team: 0, tpl: pcToHit === 6 ? FIGHTER : template({ id: 'fighter', kind: 'pc', ac: 18, hp: 44, str: 16, dex: 12, extraAttacks: 1, attacks: [{ local: 'longsword', toHit: pcToHit, damage: [['1d8+3', 'slashing']] }] }), at: 'H4' },
    ],
  });

describe('journals', () => {
  it('answers match by key and decision index; a wrong key or index throws JournalMismatch', () => {
    const s = demo();
    expect(() => run(s, 1, [{ seat: 'gob1', key: 'move:F3/p1', at: 0 }])).not.toThrow();
    expect(() => run(s, 1, [{ seat: 'gob1', key: 'move:F3/p1', at: 3 }])).toThrow(JournalMismatch);
    expect(() => run(s, 1, [{ seat: 'gob1', key: 'move:Z9/p1' }])).toThrow(JournalMismatch);
  });

  it('an entry for a seat that isn\'t deciding throws; one for an unknown seat is rejected up front', () => {
    const s = demo();
    expect(() => run(s, 1, [{ seat: 'gob1', key: 'move:F3/p1' }, { seat: 'pc1', key: 'pass' }])).toThrow(JournalMismatch);
    expect(() => makeDeciders(s, [{ seat: 'nobody', key: 'pass' }])).toThrow(/nobody/);
  });

  it('a journal seat with no fallback stops with NeedInput listing the legal keys', () => {
    const s = setup({ ...{ w: 8, h: 4 }, flags: { initiativeMode: 'static' }, units: [{ seat: 'gob1', team: 1, tpl: SKIRMISHER, at: 'B2', decider: 'journal' }, { seat: 'ally1', team: 0, tpl: SENTRY, at: 'C2' }] });
    try {
      run(s, 1);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(NeedInput);
      const n = e as NeedInput;
      expect([n.seat, n.kind, n.at]).toEqual(['gob1', 'turn', 0]);
      expect(n.keys).toContain('pass');
      expect(n.keys).toContain('attack:blade>ally1');
    }
  });

  it('forced choices (one legal option) are never asked and never journaled', () => {
    const s = demo();
    const rec = new Recorder();
    const ds = makeDeciders(s).map((d) => new RecordingDecider(d, rec));
    const r = runFight(s, 3, 0, ds, null);
    expect(rec.entries.length).toBe(r.decisionSeq);
    expect(rec.entries.map((e) => e.at)).toEqual(rec.entries.map((_, i) => i));
  });

  it('an answer outside the legal list is an IllegalDecision', () => {
    const s = demo();
    const bad: Decider = { name: 'bad', decide: () => 999 };
    expect(() => runFight(s, 1, 0, s.seats.map(() => bad), null)).toThrow(IllegalDecision);
  });
});

describe('dice alignment across build variants (common random numbers)', () => {
  it("an opportunity attack on gob1's turn doesn't shift ally1's own attack roll later that round", () => {
    // A: gob1 provokes ally1, who spends a reaction roll. B: gob1 Disengages, no roll. ally1's
    // own-turn attack sits in partition 0 either way, so its d20s must match.
    const s = demo();
    const a = run(s, 11, [{ seat: 'gob1', key: 'move:F3/p1' }, { seat: 'gob1', key: 'pass' }]);
    const b = run(s, 11, [{ seat: 'gob1', key: 'opt:nimble' }, { seat: 'gob1', key: 'move:F3/p0' }, { seat: 'gob1', key: 'pass' }]);
    const ally = s.seats.findIndex((x) => x.seat === 'ally1');
    const own = (r: ReturnType<typeof run>) => ofKind(r.events, 'attack').filter((e) => e.att === ally && e.round === 1 && !e.opportunity);
    expect(ofKind(a.events, 'attack').some((e) => e.att === ally && e.opportunity)).toBe(true);
    expect(ofKind(b.events, 'attack').some((e) => e.att === ally && e.opportunity)).toBe(false);
    expect(own(a).length).toBeGreaterThan(0);
    expect(own(a).map((e) => [e.d20, e.slot])).toEqual(own(b).map((e) => [e.d20, e.slot]));
  });

  it('a variant that changes only pc1\'s to-hit leaves every goblin attack roll in round 1 identical', () => {
    const a = run(demo(6), 21);
    const b = run(demo(9), 21);
    const gobAttacks = (r: ReturnType<typeof run>) => ofKind(r.events, 'attack').filter((e) => e.round === 1 && r.st.units[e.att]!.team === 1).map((e) => [e.att, e.slot, e.d20]);
    expect(gobAttacks(a)).toEqual(gobAttacks(b));
  });
});

// ---- property tests over random small fights ----

const POOL = [SKIRMISHER, SENTRY, FIGHTER, MULTI, REACHER, ARCHER, WARDED, DUMMY];
const FLAG_ARB = fc.record({
  diagonalCost: fc.constantFrom('uniform', 'alternate'),
  diagonalCorner: fc.constantFrom('eitherBlocks', 'bothBlock'),
  initiativeMode: fc.constantFrom('roll', 'static'),
  initiativeTies: fc.constantFrom('rollOff', 'pcsFirst', 'monstersFirst'),
  groupInitiative: fc.constantFrom('shared', 'individual'),
  monsterHp: fc.constantFrom('listed', 'rolled'),
  statBlockAtZeroHp: fc.constantFrom('dies', 'deathSaves'),
  corpseSpace: fc.constantFrom('clear', 'difficult'),
  moveBetweenAttacks: fc.constantFrom('all', 'extraAttackOnly'),
  monsterThrownWeapons: fc.constantFrom('gearCount', 'unlimited'),
  tempHpSoakAtZeroIsDamage: fc.boolean(),
}) as fc.Arbitrary<Partial<FightSetup['flags']>>;

const SCENARIO = fc
  .record({
    w: fc.integer({ min: 5, max: 9 }),
    h: fc.integer({ min: 3, max: 6 }),
    n: fc.integer({ min: 2, max: 5 }),
    picks: fc.array(fc.integer({ min: 0, max: POOL.length - 1 }), { minLength: 5, maxLength: 5 }),
    cells: fc.array(fc.integer({ min: 0, max: 53 }), { minLength: 5, maxLength: 5 }),
    walls: fc.array(fc.integer({ min: 0, max: 53 }), { maxLength: 4 }),
    flags: FLAG_ARB,
    maxRounds: fc.integer({ min: 2, max: 6 }),
    downEnds: fc.boolean(),
    seed: fc.integer({ min: 0, max: 1_000_000 }),
  })
  .map((r) => {
    const cells = r.w * r.h;
    const used = new Set<number>();
    const units: UnitSpec[] = [];
    for (let i = 0; i < r.n; i++) {
      let c = r.cells[i]! % cells;
      while (used.has(c)) c = (c + 1) % cells;
      used.add(c);
      const x = c % r.w;
      const y = Math.floor(c / r.w);
      units.push({ seat: `u${i}`, team: i === 0 ? 0 : i === 1 ? 1 : ((r.picks[i]! % 2) as 0 | 1), tpl: POOL[r.picks[i]!]!, at: `${String.fromCharCode(65 + x)}${y + 1}`, decider: 'random-legal' });
    }
    const rows = Array.from({ length: r.h }, (_, y) =>
      Array.from({ length: r.w }, (_, x) => {
        const c = y * r.w + x;
        return !used.has(c) && r.walls.some((wc) => wc % cells === c) ? '#' : '.';
      }).join(''),
    );
    return { s: setup({ w: r.w, h: r.h, terrain: rows, units, flags: r.flags, knobs: { maxRounds: r.maxRounds, downEnds: r.downEnds } }), seed: r.seed };
  });

/** Wraps a decider and checks every list it sees has unique keys. */
class KeyChecker implements Decider {
  readonly name: string;
  readonly inner: Decider;
  constructor(inner: Decider) {
    this.inner = inner;
    this.name = inner.name;
  }
  decide(view: UnitView, dp: DecisionPoint): number {
    const keys = new Set<string>();
    for (let i = 0; i < dp.legal.n; i++) keys.add(dp.keyOf(i));
    if (keys.size !== dp.legal.n) throw new Error(`duplicate legal keys for ${dp.k} @${dp.at}`);
    return this.inner.decide(view, dp);
  }
}

/** Calls every query for every pair before answering: must not change the fight. */
class Nosy implements Decider {
  readonly name = 'random-legal';
  private readonly inner = new RandomLegalDecider();
  decide(view: UnitView, dp: DecisionPoint): number {
    const us = view.q.units;
    for (const a of us) for (const t of us) {
      if (a === t) continue;
      view.queries.distFt(a.cell, t.cell);
      for (let ai = 0; ai < a.tpl.attacks.length; ai++) {
        view.queries.attackSpec(a.idx, ai, t.idx, a.cell);
        view.queries.odds(a.idx, ai, t.idx, a.cell);
      }
    }
    return this.inner.decide(view, dp);
  }
}

const hashOf = (s: FightSetup, seed: number, ds?: Decider[], scratch?: ReturnType<typeof newScratch>) => {
  const h = new HashSink();
  const r = runFight(s, seed, 0, ds ?? makeDeciders(s), h, { audit: true, scratch });
  return { r, h: h.hex() };
};

describe('properties of random fights (random-legal deciders, random flags)', () => {
  it('invariants: seq increases, causes point back, HP and budgets stay in bounds, no address opens twice, legal keys are unique', () => {
    fc.assert(
      fc.property(SCENARIO, ({ s, seed }) => {
        const r = run(s, seed, [], makeDeciders(s).map((d) => new KeyChecker(d)));
        let last = -1;
        for (const e of r.events) {
          expect(e.seq).toBeGreaterThan(last);
          last = e.seq;
          expect(e.cause).toBeLessThan(e.seq);
          if (e.k === 'damage') expect(e.slot).toBeGreaterThanOrEqual(0);
        }
        for (const u of r.st.units) {
          expect(u.hp).toBeGreaterThanOrEqual(0);
          expect(u.hp).toBeLessThanOrEqual(u.hpMax);
          expect(u.tempHp).toBeGreaterThanOrEqual(0);
          expect(u.b.moveFt).toBeGreaterThanOrEqual(0);
          expect(u.b.action).toBeGreaterThanOrEqual(0);
          expect(u.b.bonus).toBeGreaterThanOrEqual(0);
          if (u.life === 'up') {
            for (const o of r.st.units) if (o !== u && o.life === 'up' && o.cell === u.cell) throw new Error(`${u.seat} and ${o.seat} share a square while both up`);
          }
        }
      }),
      { numRuns: 120 },
    );
  });

  it('the same replay key gives the same log hash; logging on or off gives the same fight', () => {
    fc.assert(
      fc.property(SCENARIO, ({ s, seed }) => {
        const a = hashOf(s, seed);
        const b = hashOf(s, seed);
        expect(a.h).toBe(b.h);
        const silent = runFight(s, seed, 0, makeDeciders(s), null);
        expect(silent.stateHash).toBe(a.r.stateHash);
        expect(silent.seq).toBe(a.r.seq);
      }),
      // MONTECRIT_STRESS_RUNS: tools/stress-determinism.sh raises it (coverage.md 8'b review, determinism-1); a flaky failure shrinks for minutes, so it ends at the first.
      process.env.MONTECRIT_STRESS_RUNS ? { numRuns: Number(process.env.MONTECRIT_STRESS_RUNS), endOnFailure: true } : { numRuns: 60 },
    );
  });

  it('recording a fight and replaying the journal gives the same log hash and final state', () => {
    fc.assert(
      fc.property(SCENARIO, ({ s, seed }) => {
        const rec = new Recorder();
        const a = hashOf(s, seed, makeDeciders(s).map((d) => new RecordingDecider(d, rec)));
        const journalSetup: FightSetup = { ...s, seats: s.seats.map((x) => ({ ...x, decider: 'journal', fallback: null })) };
        const b = hashOf(journalSetup, seed, makeDeciders(journalSetup, rec.entries));
        expect(b.h).toBe(a.h);
        expect(b.r.stateHash).toBe(a.r.stateHash);
      }),
      { numRuns: 60 },
    );
  });

  it("deciders' queries don't change the fight, and fights run A,B vs B,A on one scratch match", () => {
    fc.assert(
      fc.property(SCENARIO, SCENARIO, (x, y) => {
        const plain = hashOf(x.s, x.seed);
        const nosy = hashOf(x.s, x.seed, x.s.seats.map(() => new Nosy()));
        expect(nosy.h).toBe(plain.h);
        expect(nosy.r.flagsUsed).toEqual(plain.r.flagsUsed);
        const cells = Math.max(x.s.w * x.s.h, y.s.w * y.s.h);
        const sc = newScratch(cells);
        const ab = [hashOf(x.s, x.seed, undefined, sc).h, hashOf(y.s, y.seed, undefined, sc).h];
        const ba = [hashOf(y.s, y.seed, undefined, sc).h, hashOf(x.s, x.seed, undefined, sc).h];
        expect([ab[0], ab[1]]).toEqual([ba[1], ba[0]]);
      }),
      { numRuns: 40 },
    );
  });

  it('random fights actually reach the interesting paths (opportunity attacks, a creature downed)', () => {
    let oas = 0;
    let downs = 0;
    fc.assert(
      fc.property(SCENARIO, ({ s, seed }) => {
        const r = run(s, seed);
        if (ofKind(r.events, 'attack').some((e) => e.opportunity)) oas++;
        if (ofKind(r.events, 'down').length || ofKind(r.events, 'death').length) downs++;
      }),
      { numRuns: 150, seed: 7 },
    );
    expect(oas).toBeGreaterThan(5);
    expect(downs).toBeGreaterThan(15);
  });
});
