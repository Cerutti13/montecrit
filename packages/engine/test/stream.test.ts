import { describe, expect, it } from 'vitest';
import { nextU32, openStream, rollDie, seedKey, uniformInt } from '../src/rng/stream.ts';

const draws = (s: ReturnType<typeof openStream>, n: number) => Array.from({ length: n }, () => nextU32(s));

describe('keyed streams', () => {
  it('the same coordinates give the same draws', () => {
    expect(draws(openStream(42, 7, 3, 'attack', 2), 10)).toEqual(draws(openStream(42, 7, 3, 'attack', 2), 10));
  });

  it('changing any coordinate changes the draws', () => {
    const base = draws(openStream(42, 7, 3, 'attack', 2), 8);
    for (const s of [
      openStream(43, 7, 3, 'attack', 2),
      openStream(42, 8, 3, 'attack', 2),
      openStream(42, 7, 4, 'attack', 2),
      openStream(42, 7, 3, 'damage', 2),
      openStream(42, 7, 3, 'attack', 3),
      openStream(42, 7, 3, 'attack', 2, 1),
    ]) {
      expect(draws(s, 8)).not.toEqual(base);
    }
  });

  it('splits large seeds across both key words', () => {
    expect(seedKey(5)).toEqual([5, 0]);
    expect(seedKey(2 ** 32 + 9)).toEqual([9, 1]);
    expect(() => seedKey(-1)).toThrow();
    expect(() => seedKey(1.5)).toThrow();
  });

  it('rejects out-of-range coordinates', () => {
    expect(() => openStream(1, -1, 0, 'init', 0)).toThrow();
    expect(() => openStream(1, 0, 0, 'init', 70000)).toThrow();
    expect(() => openStream(1, 0, 0, 'init', 0, 70000)).toThrow();
  });

  it('rollDie stays in range and covers every face', () => {
    const s = openStream(1, 0, 0, 'damage', 0);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const v = rollDie(s, 6);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(6);
      seen.add(v);
    }
    expect(seen.size).toBe(6);
  });

  it('d20 faces pass a chi-square uniformity test (fixed seed, so not flaky)', () => {
    const s = openStream(2026, 0, 0, 'check', 0);
    const n = 200_000;
    const counts = new Array<number>(20).fill(0);
    for (let i = 0; i < n; i++) counts[uniformInt(s, 20)]!++;
    const e = n / 20;
    const chi2 = counts.reduce((acc, c) => acc + (c - e) ** 2 / e, 0);
    // 19 degrees of freedom: the 99.9th percentile is about 43.8.
    expect(chi2).toBeLessThan(43.8);
  });
});
