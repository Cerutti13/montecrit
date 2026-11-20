// Build comparison (M6): the paired difference between two runs of the same fight on the same dice.
import { describe, expect, it } from 'vitest';
import type { ArmAcc, ArmStats, Rate } from '@montecrit/engine';
import { compare, grouped, ruleUse, type VariantResult } from '../src/compare/model.ts';

const WIN = 0;
const LOSS = 1;
const rate = (x: number, n: number): Rate => ({ x, n, p: x / n, lo: 0, hi: 1 });
function variant(name: string, out: number[]): VariantResult {
  const wins = out.filter((o) => o === WIN).length;
  return { id: name, name, wallMs: 1, acc: { label: 'greedy', n: out.length, out: Uint8Array.from(out) } as unknown as ArmAcc, stats: { win: rate(wins, out.length) } as unknown as ArmStats };
}
const runs = (wins: number, n: number): number[] => Array.from({ length: n }, (_, i) => (i < wins ? WIN : LOSS));

describe('compare', () => {
  it('pairs the variants run by run against the reference', () => {
    // Reference wins runs 0-49; the variant wins runs 0-79: 50 both, 30 only the variant, 20 neither.
    const c = compare([variant('Base', runs(50, 100)), variant('Better', runs(80, 100))]);
    expect(c.n).toBe(100);
    expect(c.pairs).toHaveLength(1);
    const p = c.pairs[0]!;
    expect([p.both, p.onlyOther, p.onlyRef, p.neither]).toEqual([50, 30, 0, 20]);
    expect(p.diff).toBeCloseTo(0.3);
    expect(p.lo).toBeGreaterThan(0);
    expect(p.clear).toBe(true);
    expect(c.headline).toBe('Better wins more often than Base: 30.0 points more.');
  });
  it('says when the reference is the better one, and when nothing is clear', () => {
    expect(compare([variant('Base', runs(80, 100)), variant('Worse', runs(50, 100))]).headline).toBe('Base wins more often than Worse: 30.0 points more.');
    const same = compare([variant('A', runs(50, 100)), variant('B', runs(51, 100))]);
    expect(same.pairs[0]!.clear).toBe(false);
    expect(same.headline).toContain('No clear difference');
  });
  it('with several variants names the best and counts the clear differences', () => {
    const c = compare([variant('A', runs(50, 100)), variant('B', runs(51, 100)), variant('C', runs(90, 100))]);
    expect(c.pairs.map((p) => p.other)).toEqual([1, 2]);
    expect(c.headline).toBe('C has the highest win rate; 1 of 2 variants differ clearly from A.');
  });
});

describe('the character picker', () => {
  it('lists premade heroes by class, then level as a number', () => {
    const ch = (id: string) => ({ id, name: id, origin: 'repo' as const, kind: 'character file' as const });
    const g = grouped([ch('test:hero-fighter-10'), ch('test:sample-monk'), ch('test:hero-fighter-2'), ch('test:hero-cleric-5')]);
    expect(g.heroes.map((c) => c.id)).toEqual(['test:hero-cleric-5', 'test:hero-fighter-2', 'test:hero-fighter-10']);
    expect(g.others.map((c) => c.id)).toEqual(['test:sample-monk']);
  });
});

describe('scripted-policy mode', () => {
  it('turns the engine rule counts into shares of the fights', () => {
    // Two rules: [taken, retries, retired] each.
    expect(ruleUse(['open', 'second'], Float64Array.from([150, 40, 50, 0, 0, 200]), 200)).toEqual([
      { rule: 'open', taken: 0.75, retired: 0.25 },
      { rule: 'second', taken: 0, retired: 1 },
    ]);
    expect(ruleUse(['open'], Float64Array.from([0, 0, 0]), 0)).toEqual([{ rule: 'open', taken: 0, retired: 0 }]);
  });
  it('records what every build was played by, the AI unless told', () => {
    const vs = [variant('A', runs(50, 100)), variant('B', runs(51, 100))];
    expect(compare(vs).played).toEqual({ id: 'greedy', name: 'Greedy', scripted: false });
    const played = { id: 'moonbeam-first', name: 'Moonbeam first', scripted: true };
    expect(compare(vs, played).played).toBe(played);
  });
});
