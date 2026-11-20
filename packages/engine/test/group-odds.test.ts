import { describe, expect, it } from 'vitest';
import { groupCheckOdds } from '../src/odds/group.ts';

describe('groupCheckOdds', () => {
  it('one member: the group passes when they do', () => {
    const g = groupCheckOdds([0.3]);
    expect(g.need).toBe(1);
    expect(g.pPass).toBeCloseTo(0.3, 12);
  });
  it('two members need one pass; three need two', () => {
    expect(groupCheckOdds([0.5, 0.5]).pPass).toBeCloseTo(0.75, 12);
    const g = groupCheckOdds([0.5, 0.5, 0.5]);
    expect(g.need).toBe(2);
    expect(g.pPass).toBeCloseTo(0.5, 12);
  });
  it('unequal members: matches the enumeration', () => {
    const ps = [0.9, 0.2, 0.55, 0.4];
    let want = 0;
    for (let mask = 0; mask < 16; mask++) {
      let p = 1;
      let passes = 0;
      ps.forEach((x, i) => {
        const hit = (mask >> i) & 1;
        p *= hit ? x : 1 - x;
        passes += hit;
      });
      if (passes >= 2) want += p;
    }
    const g = groupCheckOdds(ps);
    expect(g.pPass).toBeCloseTo(want, 12);
    expect(g.count.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
  });
  it('certain and impossible members', () => {
    expect(groupCheckOdds([1, 1, 0, 0]).pPass).toBe(1);
    expect(groupCheckOdds([1, 0, 0]).pPass).toBe(0);
  });
  it('rejects an empty group and a bad chance', () => {
    expect(() => groupCheckOdds([])).toThrow(RangeError);
    expect(() => groupCheckOdds([1.2])).toThrow(RangeError);
  });
});
