import { describe, expect, it } from 'vitest';
import { bindExpr, parseExpr, sampleExpr } from '../src/dice/expr.ts';
import { nextU32, openStream } from '../src/rng/stream.ts';
import { DEFAULT_FLAGS, type RuleFlags } from '../src/rules/flags.ts';
import { drawRoll, resolveAdvantage, rollOdds, sampleRoll, settleRoll, type RollSpec } from '../src/rolls/rollspec.ts';

const d = parseExpr;
const check = (over: Partial<RollSpec>): RollSpec => ({ kind: 'check', adv: 'none', flat: 0, preDice: [], dc: 10, ...over });

// Closed forms, each worked by hand (and spot-checkable on AnyDice).
describe('rollOdds closed forms', () => {
  it('d20+5 vs DC 15 is 11/20', () => {
    expect(rollOdds(check({ flat: 5, dc: 15 })).pSuccess).toBeCloseTo(0.55, 12);
  });

  it('advantage: 1 - (9/20)^2 = 79.75%', () => {
    expect(rollOdds(check({ flat: 5, dc: 15, adv: 'adv' })).pSuccess).toBeCloseTo(0.7975, 12);
  });

  it('disadvantage: (11/20)^2 = 30.25%', () => {
    expect(rollOdds(check({ flat: 5, dc: 15, adv: 'dis' })).pSuccess).toBeCloseTo(0.3025, 12);
  });

  it('Guidance-style +1d4: (12+13+14+15)/80 = 67.5%', () => {
    expect(rollOdds(check({ flat: 5, dc: 15, preDice: [d('1d4')] })).pSuccess).toBeCloseTo(0.675, 12);
  });

  it('a d6 added only after a failure: 87/120 = 72.5%, and it is spent 45% of the time', () => {
    const o = rollOdds(check({ flat: 5, dc: 15, afterFail: d('1d6') }));
    expect(o.pSuccess).toBeCloseTo(0.725, 12);
    expect(o.pBaseSuccess).toBeCloseTo(0.55, 12);
    expect(o.pAfterFailUsed).toBeCloseTo(0.45, 12);
  });

  it('a floor of 10 turns every low roll into a 10 (d20+3 vs DC 13 always passes)', () => {
    expect(rollOdds(check({ kind: 'save', flat: 3, dc: 13, floor: 10 })).pSuccess).toBeCloseTo(1, 12);
  });

  it('certain outcomes stay true probabilities (no 1.0000000000000002)', () => {
    const o = rollOdds(check({ flat: 0, dc: 2, preDice: [d('1d20')], afterFail: d('1d4') }));
    expect(o.pSuccess).toBe(1);
    expect(o.pBaseSuccess).toBe(1);
    expect(o.pAfterFailUsed).toBe(0);
  });

  it('checks: a natural 20 is not an automatic pass by default', () => {
    expect(rollOdds(check({ flat: 0, dc: 25 })).pSuccess).toBe(0);
    const flags = { ...DEFAULT_FLAGS, natOnChecksAndSaves: 'autoPassFail' as const };
    expect(rollOdds(check({ flat: 0, dc: 25 }), flags).pSuccess).toBeCloseTo(0.05, 12);
  });
});

describe('attack rolls', () => {
  const attack = (over: Partial<RollSpec>): RollSpec => check({ kind: 'attack', ...over });

  it('a natural 20 hits even AC 30', () => {
    const o = rollOdds(attack({ flat: 5, dc: 30 }));
    expect(o.pSuccess).toBeCloseTo(0.05, 12);
    expect(o.pCrit).toBeCloseTo(0.05, 12);
  });

  it('a natural 1 misses even AC 2', () => {
    expect(rollOdds(attack({ flat: 5, dc: 2 })).pSuccess).toBeCloseTo(0.95, 12);
  });

  it('crit on 19-20 doubles the crit chance', () => {
    expect(rollOdds(attack({ flat: 5, dc: 15, critMin: 19 })).pCrit).toBeCloseTo(0.1, 12);
  });

  it('an after-failure die cannot rescue a natural 1', () => {
    const o = rollOdds(attack({ flat: 0, dc: 2, afterFail: d('1d6') }));
    expect(o.pSuccess).toBeCloseTo(0.95, 12);
  });

  it('expandedCritAutoHits defaults to off: only a natural 20 auto-hits (SRD 5.2.1 p.7)', () => {
    expect(DEFAULT_FLAGS.expandedCritAutoHits).toBe(false);
    expect(rollOdds(attack({ flat: 5, dc: 30, critMin: 19 })).pSuccess).toBeCloseTo(0.05, 12);
  });

  it('with expandedCritAutoHits off, a crit-range roll that hits is still a crit', () => {
    const off = { ...DEFAULT_FLAGS, expandedCritAutoHits: false };
    const o = rollOdds(attack({ flat: 5, dc: 15, critMin: 19 }), off);
    expect(o.pSuccess).toBeCloseTo(0.55, 12);
    expect(o.pCrit).toBeCloseTo(0.1, 12);
    // AC 30: a natural 19 + 5 = 24 misses without the auto-hit; only the natural 20 lands.
    const high = rollOdds(attack({ flat: 5, dc: 30, critMin: 19 }), off);
    expect(high.pSuccess).toBeCloseTo(0.05, 12);
    expect(high.pCrit).toBeCloseTo(0.05, 12);
    const on = rollOdds(attack({ flat: 5, dc: 30, critMin: 19 }), { ...DEFAULT_FLAGS, expandedCritAutoHits: true });
    expect(on.pSuccess).toBeCloseTo(0.1, 12);
    expect(on.pCrit).toBeCloseTo(0.1, 12);
  });

  it('a crit rescued by an after-failure die still counts as a crit', () => {
    const off = { ...DEFAULT_FLAGS, expandedCritAutoHits: false };
    // natural 19 + 0 = 19 vs AC 21: needs the d4 to reach 21 (2+ on the d4 = 3/4).
    const o = rollOdds(attack({ flat: 0, dc: 21, critMin: 19, afterFail: d('1d4') }), off);
    expect(o.pCrit).toBeCloseTo(0.05 + 0.05 * 0.75, 12);
  });

  it('rejects a crit range outside 2..20', () => {
    expect(() => rollOdds(attack({ flat: 0, dc: 30, critMin: 21 }))).toThrow(/critMin/);
    expect(() => rollOdds(attack({ flat: 0, dc: 30, critMin: 1 }))).toThrow(/critMin/);
  });

  it('crit chance with advantage is 1 - (19/20)^2', () => {
    expect(rollOdds(attack({ flat: 5, dc: 15, adv: 'adv' })).pCrit).toBeCloseTo(1 - (19 / 20) ** 2, 12);
  });
});

describe('resolveAdvantage', () => {
  it('any advantage plus any disadvantage is a straight roll', () => {
    expect(resolveAdvantage(['help'], [])).toBe('adv');
    expect(resolveAdvantage([], ['prone'])).toBe('dis');
    expect(resolveAdvantage(['help', 'faerie-fire'], ['prone'])).toBe('none');
    expect(resolveAdvantage([], [])).toBe('none');
  });
});

// Sampler vs exact odds: the simulator and the calculator must agree.
const N = process.env.MONTECRIT_SLOW ? 1_000_000 : 100_000;
const SPECS: [string, RollSpec, RuleFlags?][] = [
  ['straight check', check({ flat: 5, dc: 15 })],
  ['advantage + Guidance-style d4', check({ flat: 2, dc: 16, adv: 'adv', preDice: [d('1d4')] })],
  ['disadvantage save with an after-failure d8', check({ kind: 'save', flat: 1, dc: 14, adv: 'dis', afterFail: d('1d8') })],
  ['floored concentration save', check({ kind: 'save', flat: 2, dc: 15, floor: 10 })],
  ['attack with crit on 19', check({ kind: 'attack', flat: 6, dc: 16, critMin: 19 })],
  ['attack with Bless-style d4 at disadvantage', check({ kind: 'attack', flat: 4, dc: 13, adv: 'dis', preDice: [d('1d4')] })],
  ['certain success (floored save vs DC 10)', check({ kind: 'save', flat: 2, dc: 10, floor: 10 })],
  ['crit on 19 without the expanded auto-hit, after-fail d4', check({ kind: 'attack', flat: 0, dc: 21, critMin: 19, afterFail: d('1d4') }), { ...DEFAULT_FLAGS, expandedCritAutoHits: false }],
  // M1b: dice other creatures roll in before the d20 (a pre-roll reaction), +/-, mixed with the rest.
  ['a subtracted reaction d6 on an attack', check({ kind: 'attack', flat: 6, dc: 15, extDice: [d('-1d6')] })],
  ['an added reaction d6 on a save at disadvantage', check({ kind: 'save', flat: 1, dc: 14, adv: 'dis', extDice: [d('1d6')] })],
  ['reaction die + floor + Guidance d4 on a concentration save', check({ kind: 'save', flat: 3, dc: 16, floor: 10, preDice: [d('1d4')], extDice: [d('-1d6')] })],
  ['reaction die + advantage + after-fail d8', check({ kind: 'attack', flat: 4, dc: 17, adv: 'adv', afterFail: d('1d8'), extDice: [d('-1d6')] })],
  ['two reaction dice with crit on 19', check({ kind: 'attack', flat: 5, dc: 14, critMin: 19, extDice: [d('1d6'), d('-1d6')] })],
  ['floor with autoPassFail on a check', check({ flat: -1, dc: 18, floor: 10 }), { ...DEFAULT_FLAGS, natOnChecksAndSaves: 'autoPassFail' }],
  // M3 (design 2.5, C11): compiled dice from a computed count, and min/max clamps holding dice.
  ['a (@pb)d4 bound at PB 3 as a pre-roll die', check({ flat: 0, dc: 19, preDice: [bindExpr(d('(@pb)d4'), { pb: 3 })] })],
  ['a max(1, 1d8 - 2) pre-roll die', check({ flat: 2, dc: 16, preDice: [d('max(1, 1d8 - 2)')] })],
  ['a nested min/max after-failure die at disadvantage', check({ kind: 'save', flat: 1, dc: 15, adv: 'dis', afterFail: d('min(max(1, 1d8 - 2), 4)') })],
  ['a subtracted max(1, 1d6 - 1) reaction die on an attack', check({ kind: 'attack', flat: 5, dc: 15, extDice: [d('-max(1, 1d6 - 1)')] })],
];

describe(`sampler agrees with exact odds within 4 sigma (${N.toLocaleString()} rolls each)`, () => {
  it.each(SPECS)('%s', (_name, spec, flags = DEFAULT_FLAGS) => {
    const exact = rollOdds(spec, flags);
    let hits = 0;
    let crits = 0;
    let used = 0;
    for (let run = 0; run < N; run++) {
      const r = sampleRoll(spec, openStream(31337, run, 0, 'check', 0), flags);
      if (r.success) hits++;
      if (r.crit) crits++;
      if (r.afterFailUsed) used++;
    }
    const z = (count: number, p: number) =>
      p < 1e-12 || p > 1 - 1e-12 ? (count / N === Math.round(p) ? 0 : Infinity) : (count / N - p) / Math.sqrt((p * (1 - p)) / N);
    expect(Math.abs(z(hits, exact.pSuccess))).toBeLessThan(4);
    expect(Math.abs(z(crits, exact.pCrit))).toBeLessThan(4);
    expect(Math.abs(z(used, exact.pAfterFailUsed))).toBeLessThan(4);
  });
});

// Common random numbers: one roll's extra dice must never shift another roll's dice.
describe('roll-level dice alignment', () => {
  const attack1 = (over: Partial<RollSpec>) => check({ kind: 'attack', flat: 5, dc: 15, ...over });

  it("advantage or Bless on roll 1 doesn't change roll 2's d20 (separate slots)", () => {
    let differ = 0;
    for (let run = 0; run < 2000; run++) {
      const roll2 = (first: RollSpec) => {
        sampleRoll(first, openStream(7, run, 0, 'attack', 1, 0));
        return sampleRoll(attack1({}), openStream(7, run, 0, 'attack', 1, 1)).natural;
      };
      const base = roll2(attack1({}));
      if (roll2(attack1({ adv: 'adv' })) !== base) differ++;
      if (roll2(attack1({ preDice: [d('1d4')] })) !== base) differ++;
      if (roll2(attack1({ afterFail: d('1d6') })) !== base) differ++;
    }
    expect(differ).toBe(0);
  });

  it("within one roll, Bless or an after-failure die doesn't change the d20s", () => {
    for (let run = 0; run < 2000; run++) {
      const nat = (spec: RollSpec) => sampleRoll(spec, openStream(7, run, 0, 'attack', 1)).natural;
      const base = nat(attack1({}));
      expect(nat(attack1({ preDice: [d('1d4')] }))).toBe(base);
      expect(nat(attack1({ afterFail: d('1d6') }))).toBe(base);
    }
  });
});

// M1b: the engine draws a reaction die from the reactor's own stream and passes the value in.
describe('extDice drawn outside the roll', () => {
  it("sampling with values from another stream still matches the exact odds (4 sigma)", () => {
    const spec = check({ kind: 'attack', flat: 6, dc: 15, extDice: [d('-1d6')] });
    const exact = rollOdds(spec);
    let hits = 0;
    for (let run = 0; run < N; run++) {
      const v = -sampleExpr(d('1d6'), {}, openStream(99, run, 1, 'react', 1));
      if (sampleRoll(spec, openStream(31337, run, 0, 'attack', 1), DEFAULT_FLAGS, [v]).success) hits++;
    }
    const z = (hits / N - exact.pSuccess) / Math.sqrt((exact.pSuccess * (1 - exact.pSuccess)) / N);
    expect(Math.abs(z)).toBeLessThan(4);
  });

  it("a reaction never moves the roller's own dice: same d20s and preDice with and without it", () => {
    for (let run = 0; run < 2000; run++) {
      const base = check({ kind: 'save', flat: 2, dc: 15, preDice: [d('1d4')], afterFail: d('1d8') });
      const a = drawRoll(base, openStream(7, run, 0, 'save', 1));
      const b = drawRoll({ ...base, extDice: [d('-1d6')] }, openStream(7, run, 0, 'save', 1), [-3]);
      expect([b.a, b.b, b.pre, b.after]).toEqual([a.a, a.b, a.pre, a.after]);
      expect(b.ext).toBe(-3);
    }
  });

  it('settleRoll on a draw gives exactly what sampleRoll gives', () => {
    const spec = check({ kind: 'attack', flat: 3, dc: 16, adv: 'dis', critMin: 19, preDice: [d('1d4')], afterFail: d('1d6') });
    for (let run = 0; run < 2000; run++) {
      expect(settleRoll(spec, drawRoll(spec, openStream(5, run, 0, 'attack', 1)))).toEqual(sampleRoll(spec, openStream(5, run, 0, 'attack', 1)));
    }
  });

  it('drawing from a closed roll throws', () => {
    const s = openStream(1, 0, 0, 'save', 1);
    nextU32(s);
    s.closed = true;
    expect(() => nextU32(s)).toThrow(/closed roll/);
  });
});
