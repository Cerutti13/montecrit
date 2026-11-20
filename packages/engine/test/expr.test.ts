import { describe, expect, it } from 'vitest';
import { ExprError, bindExpr, diceOnly, exprPmf, formatExpr, parseExpr, sampleExpr, type ExprNode } from '../src/dice/expr.ts';
import { maxValue, mean, probAt, type Pmf } from '../src/odds/pmf.ts';
import { openStream } from '../src/rng/stream.ts';

describe('dice expressions', () => {
  it.each([
    ['1d4', '1d4'],
    ['d20', '1d20'],
    ['2d20kh1', '2d20kh1'],
    ['4d6KL3', '4d6kl3'],
    ['2d6 + 3', '2d6 + 3'],
    ['1d8 + @mod.wis', '1d8 + @mod.wis'],
    ['2 * (1d6 + 1)', '2 * (1d6 + 1)'],
    ['-1d4', '-1d4'],
    ['10 - 2 - 3', '10 - 2 - 3'],
  ])('parses %s', (src, formatted) => {
    expect(formatExpr(parseExpr(src))).toBe(formatted);
  });

  it.each(['', '1d', 'd', '2d6 +', '(1d4', '1d4)', '@', '0d6', '101d6', '1d0', '2d6kh3', '1d4 ^ 2'])(
    'rejects %j',
    (src) => {
      expect(() => parseExpr(src)).toThrow(ExprError);
    },
  );

  it('subtraction is left-associative', () => {
    expect(mean(exprPmf(parseExpr('10 - 2 - 3')))).toBe(5);
  });

  it('resolves variables and reports unknown ones', () => {
    const p = exprPmf(parseExpr('1d8 + @mod.wis'), { 'mod.wis': 3 });
    expect(p.min).toBe(4);
    expect(maxValue(p)).toBe(11);
    expect(() => exprPmf(parseExpr('@pb'))).toThrow(/unknown variable @pb/);
  });

  it('2 * (1d6 + 1) only hits even values 4..14', () => {
    const p = exprPmf(parseExpr('2 * (1d6 + 1)'));
    expect(p.min).toBe(4);
    expect(maxValue(p)).toBe(14);
    expect(probAt(p, 5)).toBe(0);
    expect(probAt(p, 6)).toBeCloseTo(1 / 6, 12);
  });

  it('refuses an exact product of two dice terms', () => {
    expect(() => exprPmf(parseExpr('1d4 * 1d4'))).toThrow(ExprError);
  });

  it('samples stay inside the exact support', () => {
    const node = parseExpr('4d6kh3 + 2');
    const p = exprPmf(node);
    const s = openStream(9, 0, 0, 'damage', 0);
    for (let i = 0; i < 2000; i++) {
      const v = sampleExpr(node, {}, s);
      expect(probAt(p, v)).toBeGreaterThan(0);
    }
  });
});

// M3 step 1 (design 2.5, C11): computed dice counts, min and max, class variables.
const N = process.env.MONTECRIT_SLOW ? 1_000_000 : 100_000;

/** Every value's sampled frequency is within 4 sigma of its exact probability, and nothing lands outside the support. */
function expectSampledMatchesExact(node: ExprNode, exact: Pmf, seed: number): void {
  const counts = new Map<number, number>();
  for (let run = 0; run < N; run++) {
    const v = sampleExpr(node, {}, openStream(seed, run, 0, 'damage', 0));
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  for (const v of counts.keys()) expect(probAt(exact, v), `value ${v}`).toBeGreaterThan(0);
  for (let i = 0; i < exact.p.length; i++) {
    const p = exact.p[i]!;
    if (p === 0) continue;
    const z = ((counts.get(exact.min + i) ?? 0) / N - p) / Math.sqrt((p * (1 - p)) / N);
    expect(Math.abs(z), `value ${exact.min + i}`).toBeLessThan(4);
  }
}

const samePmf = (a: Pmf, b: Pmf): void => {
  expect(a.min).toBe(b.min);
  expect(a.p.length).toBe(b.p.length);
  for (let i = 0; i < a.p.length; i++) expect(a.p[i]).toBeCloseTo(b.p[i]!, 14);
};

describe('the M3 expression grammar', () => {
  it.each([
    ['(@pb)d4', '(@pb)d4'],
    ['(@pb + 1)d6kh2', '(@pb + 1)d6kh2'],
    ['max(1, 1d8 - 2)', 'max(1, 1d8 - 2)'],
    ['MIN( 1d6 ,4 )', 'min(1d6, 4)'],
    ['max(1, @mod.wis)', 'max(1, @mod.wis)'],
    ['min(max(1, 1d8 - 2), 4)', 'min(max(1, 1d8 - 2), 4)'],
    ['@scale.martial-arts + @mod.dex', '@scale.martial-arts + @mod.dex'],
    ['@scale.monk.martial-arts', '@scale.monk.martial-arts'],
    ['@classLevel + @level', '@classlevel + @level'],
  ])('parses %s', (src, formatted) => {
    expect(formatExpr(parseExpr(src))).toBe(formatted);
  });

  it('a hyphen joins only letters, so @mod-1 is still @mod minus 1', () => {
    expect(parseExpr('@mod-1')).toEqual({ k: 'sub', a: { k: 'var', name: 'mod' }, b: { k: 'const', v: 1 } });
    expect(parseExpr('1d6+@mod-2')).toEqual(parseExpr('1d6 + @mod - 2'));
  });

  it('a hyphen never swallows a die: @pb-d4 and @mod.wis-d4 subtract 1d4, as before hyphens; only @scale ids take hyphens', () => {
    const d4 = { k: 'dice', n: 1, sides: 4 };
    expect(parseExpr('@pb-d4')).toEqual({ k: 'sub', a: { k: 'var', name: 'pb' }, b: d4 });
    expect(parseExpr('@mod.wis-d4')).toEqual({ k: 'sub', a: { k: 'var', name: 'mod.wis' }, b: d4 });
    expect(parseExpr('@level-d4+1')).toEqual(parseExpr('@level - 1d4 + 1'));
    expect(parseExpr('@scale.martial-arts')).toEqual({ k: 'var', name: 'scale.martial-arts' });
    expect(parseExpr('@scale.open-hand.martial-arts+@pb-d4')).toEqual(parseExpr('@scale.open-hand.martial-arts + @pb - 1d4'));
  });

  it.each(['max(1)', 'max(1, 2, 3)', 'max 1, 2', 'min(1, 2', 'mid(1, 2)', '(@pb)d', '(@pb)d0', '(2)d4kh', '@scale.-x'])('rejects %j', (src) => {
    expect(() => parseExpr(src)).toThrow(ExprError);
  });

  it('existing expressions parse to the same nodes as before (C3: byte-identical compiled nodes)', () => {
    expect(parseExpr('2d20kh1 + 3')).toEqual({ k: 'add', a: { k: 'dice', n: 2, sides: 20, keep: { mode: 'h', count: 1 } }, b: { k: 'const', v: 3 } });
    expect(parseExpr('(1d6 + 1) * 2')).toEqual({ k: 'mul', a: { k: 'add', a: { k: 'dice', n: 1, sides: 6 }, b: { k: 'const', v: 1 } }, b: { k: 'const', v: 2 } });
    expect(parseExpr('1d8 + @mod.wis')).toEqual({ k: 'add', a: { k: 'dice', n: 1, sides: 8 }, b: { k: 'var', name: 'mod.wis' } });
  });
});

describe('computed dice counts', () => {
  it('(@pb)d4 at PB 3 binds to plain 3d4, with exactly the 3d4 PMF', () => {
    const bound = bindExpr(parseExpr('(@pb)d4'), { pb: 3 });
    expect(bound).toEqual({ k: 'dice', n: 3, sides: 4 });
    samePmf(exprPmf(parseExpr('(@pb)d4'), { pb: 3 }), exprPmf(parseExpr('3d4')));
  });

  it('(@pb)d4 at PB 3 sampled matches the exact 3d4 PMF', () => {
    expectSampledMatchesExact(bindExpr(parseExpr('(@pb)d4'), { pb: 3 }), exprPmf(parseExpr('3d4')), 4101);
  });

  it('a computed count keeps its kh/kl and checks it against the count', () => {
    expect(bindExpr(parseExpr('(@n)d20kh1'), { n: 2 })).toEqual({ k: 'dice', n: 2, sides: 20, keep: { mode: 'h', count: 1 } });
    expect(() => bindExpr(parseExpr('(@n)d6kh3'), { n: 2 })).toThrow(/comes to 2, below its keep count 3/);
  });

  it('a count of 0 rolls nothing; a negative or dice count is an error naming the expression', () => {
    expect(bindExpr(parseExpr('(@n)d6 + 1'), { n: 0 })).toEqual({ k: 'add', a: { k: 'const', v: 0 }, b: { k: 'const', v: 1 } });
    expect(() => bindExpr(parseExpr('(@n)d6'), { n: -1 })).toThrow(/dice count of \(@n\)d6 comes to -1/);
    expect(() => bindExpr(parseExpr('(1d4)d6'), {})).toThrow(/a dice count must be a number, not dice: \(1d4\)d6/);
  });
});

describe('min and max', () => {
  it('max(1, @mod.wis) is the modifier, but never below 1', () => {
    expect(bindExpr(parseExpr('max(1, @mod.wis)'), { 'mod.wis': -2 })).toEqual({ k: 'const', v: 1 });
    expect(bindExpr(parseExpr('max(1, @mod.wis)'), { 'mod.wis': 3 })).toEqual({ k: 'const', v: 3 });
    expect(mean(exprPmf(parseExpr('max(1, @mod.wis)'), { 'mod.wis': 0 }))).toBe(1);
  });

  it('max(1, 1d8 - 2) clamps exactly: 1 with chance 3/8, then 2..6 at 1/8 each', () => {
    const p = exprPmf(parseExpr('max(1, 1d8 - 2)'));
    expect(p.min).toBe(1);
    expect(maxValue(p)).toBe(6);
    expect(probAt(p, 1)).toBeCloseTo(3 / 8, 14);
    for (let v = 2; v <= 6; v++) expect(probAt(p, v)).toBeCloseTo(1 / 8, 14);
  });

  it('max(1, 1d8 - 2) sampled matches its exact PMF', () => {
    const node = parseExpr('max(1, 1d8 - 2)');
    expectSampledMatchesExact(node, exprPmf(node), 4102);
  });

  it('nested min/max: min(max(1, 1d8 - 2), 4) is 1 at 3/8, 2 and 3 at 1/8, 4 at 3/8', () => {
    const node = parseExpr('min(max(1, 1d8 - 2), 4)');
    const p = exprPmf(node);
    expect([1, 2, 3, 4].map((v) => probAt(p, v))).toEqual([3 / 8, 1 / 8, 1 / 8, 3 / 8].map((x) => expect.closeTo(x, 14)));
    expectSampledMatchesExact(node, p, 4103);
  });

  it('min and max of two dice terms are the independent order statistics, sampled and exact', () => {
    const lo = parseExpr('min(1d6, 1d6)');
    samePmf(exprPmf(lo), exprPmf(parseExpr('2d6kl1')));
    const nested = parseExpr('max(min(1d6, 1d6), 2) + max(1d4, 1d4 - 1)');
    expectSampledMatchesExact(nested, exprPmf(nested), 4104);
  });

  it('a min or max of constants folds when bound; one with dice stays for the PMF and the sampler', () => {
    expect(bindExpr(parseExpr('min(max(1, @a), 4) + 1d6'), { a: 7 })).toEqual({ k: 'add', a: { k: 'const', v: 4 }, b: { k: 'dice', n: 1, sides: 6 } });
    expect(bindExpr(parseExpr('max(1, 1d8 - @a)'), { a: 2 })).toEqual({ k: 'max', a: { k: 'const', v: 1 }, b: { k: 'sub', a: { k: 'dice', n: 1, sides: 8 }, b: { k: 'const', v: 2 } } });
  });

  it('a critical hit has no reading for dice inside min/max', () => {
    expect(diceOnly(parseExpr('max(1, 3) + 1d6'))).toEqual({ k: 'dice', n: 1, sides: 6 });
    expect(() => diceOnly(parseExpr('max(1, 1d8 - 2)'))).toThrow(/inside max\(\) for a critical hit/);
  });
});

describe('binding variables', () => {
  it('a dice-valued binding splices in as dice: martial-arts 1d8 at level 5', () => {
    expect(bindExpr(parseExpr('@scale.martial-arts + @mod.dex'), { 'scale.martial-arts': parseExpr('1d8'), 'mod.dex': 3 })).toEqual({
      k: 'add',
      a: { k: 'dice', n: 1, sides: 8 },
      b: { k: 'const', v: 3 },
    });
  });

  it('an unknown variable is an error naming it, from a table or a function', () => {
    expect(() => bindExpr(parseExpr('1d6 + @nope'), {})).toThrow(/unknown variable @nope/);
    expect(() => bindExpr(parseExpr('@level'), () => undefined)).toThrow(/unknown variable @level/);
  });

  it('a dice binding may not itself carry variables', () => {
    expect(() => bindExpr(parseExpr('@scale.x'), { 'scale.x': parseExpr('1d8 + @mod') })).toThrow(/unknown variable @mod/);
  });
});
