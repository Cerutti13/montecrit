import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  clampLow,
  constant,
  convolve,
  die,
  keepDice,
  maxOf,
  mean,
  minOf,
  probAt,
  probAtLeast,
  scale,
  totalMass,
  variance,
} from '../src/odds/pmf.ts';

describe('Pmf', () => {
  it('2d6: P(7) = 6/36, mean 7', () => {
    const p = convolve(die(6), die(6));
    expect(probAt(p, 7)).toBeCloseTo(6 / 36, 12);
    expect(mean(p)).toBeCloseTo(7, 12);
    expect(p.min).toBe(2);
    expect(p.p.length).toBe(11);
  });

  it('advantage on a d20 has mean 13.825, disadvantage 7.175', () => {
    expect(mean(maxOf(die(20), die(20)))).toBeCloseTo(13.825, 12);
    expect(mean(minOf(die(20), die(20)))).toBeCloseTo(7.175, 12);
  });

  it('4d6 keep highest 3 has the known mean 15869/1296', () => {
    expect(mean(keepDice(4, 6, 'h', 3))).toBeCloseTo(15869 / 1296, 10);
  });

  it('keep-1 via order statistics matches enumeration', () => {
    const a = keepDice(3, 6, 'h', 1);
    // P(max of 3d6 = 6) = 1 - (5/6)^3
    expect(probAt(a, 6)).toBeCloseTo(1 - (5 / 6) ** 3, 12);
  });

  it('refuses an exact keep that would enumerate too many outcomes', () => {
    expect(() => keepDice(20, 20, 'h', 3)).toThrow(/capped/);
  });

  it('scale spreads support and handles negative factors', () => {
    const s = scale(die(4), 2);
    expect(s.min).toBe(2);
    expect(probAt(s, 3)).toBe(0);
    expect(probAt(s, 8)).toBeCloseTo(0.25, 12);
    const n = scale(die(4), -1);
    expect(n.min).toBe(-4);
    expect(probAt(n, -1)).toBeCloseTo(0.25, 12);
  });

  it('clampLow moves the low tail onto the floor', () => {
    const c = clampLow(die(20), 10);
    expect(c.min).toBe(10);
    expect(probAt(c, 10)).toBeCloseTo(10 / 20, 12);
    expect(probAtLeast(c, 10)).toBeCloseTo(1, 12);
  });

  it('constant has all its mass at one value', () => {
    expect(probAt(constant(3), 3)).toBe(1);
    expect(variance(constant(3))).toBe(0);
  });

  it('property: sums of small dice keep total mass 1 and add their means and variances', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 12 }), { minLength: 1, maxLength: 6 }), (sides) => {
        const dice = sides.map(die);
        const sum = dice.reduce(convolve, constant(0));
        expect(totalMass(sum)).toBeCloseTo(1, 10);
        expect(mean(sum)).toBeCloseTo(dice.reduce((a, d) => a + mean(d), 0), 9);
        expect(variance(sum)).toBeCloseTo(dice.reduce((a, d) => a + variance(d), 0), 8);
      }),
    );
  });
});
