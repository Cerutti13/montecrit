// Report statistics (docs/design/m1c.md 5.1, 8): every committed vector from
// docs/research/m1c-stats-and-encounter.md part 1, plus exact-rational McNemar vectors at
// demo scale (critique resolution 2).
import { describe, expect, it } from 'vitest';
import { bootstrapRatios, diffReps, percentileCI } from '../src/mc/boot.ts';
import { dprBin, DPR_BINS, holm, mcnemarExact, nearestRank, newcombePaired, P_FLOOR, ratioDeltaSE, wilson, Z95 } from '../src/mc/stats.ts';
import { auxInt, openAuxStream, seedKey } from '../src/rng/stream.ts';

const close = (got: number, want: number, dp = 6) => expect(got.toFixed(dp)).toBe(want.toFixed(dp));
const rel = (got: number, want: number, tol: number) => expect(Math.abs(got - want) / want, `${got} vs ${want}`).toBeLessThan(tol);

// The toy fight set from the research (n = 20, seed 42).
const D = [12, 0, 25, 31, 8, 17, 22, 0, 40, 15, 9, 27, 33, 5, 19, 11, 24, 0, 36, 14];
const R = [3, 2, 4, 5, 2, 3, 4, 1, 6, 3, 2, 4, 5, 2, 3, 3, 4, 1, 6, 3];

describe('Wilson score interval', () => {
  it('matches the worked rows, with the ends forced at x = 0 and x = n', () => {
    const rows: [number, number, number, number][] = [
      [0, 10, 0, 0.277533],
      [7, 10, 0.396778, 0.892209],
      [10, 10, 0.722467, 1],
      [6000, 10000, 0.590362, 0.609562],
      [5000, 10000, 0.490202, 0.509798],
      [0, 10000, 0, 0.000384],
      [5800, 10000, 0.570298, 0.589641],
      [300, 10000, 0.026833, 0.033528],
      [5800, 9700, 0.588144, 0.607655],
    ];
    for (const [x, n, lo, hi] of rows) {
      const w = wilson(x, n);
      close(w.lo, lo);
      close(w.hi, hi);
    }
    expect(wilson(0, 10).lo).toBe(0);
    expect(wilson(10, 10).hi).toBe(1);
    expect(wilson(0, 0)).toEqual({ lo: 0, hi: 1 });
    expect(Z95).toBe(1.959963984540054);
  });
});

describe('Newcombe paired difference', () => {
  it('matches the CAMIS worked example and the research rows', () => {
    const rows: [number, number, number, number, number, number, number, number][] = [
      [20, 15, 6, 5, 0.195652, 0, 0.002602, 0.369943],
      [5200, 900, 500, 3400, 0.04, 0.71332978, 0.032702, 0.047288],
      [6000, 0, 0, 4000, 0, 0.99979167, -0.00021, 0.00021],
      [10000, 0, 0, 0, 0, 0, -0.000384, 0.000384],
      [8, 2, 0, 0, 0.2, 0, -0.112353, 0.509838],
    ];
    for (const [a, b, c, d, diff, phi, lo, hi] of rows) {
      const r = newcombePaired(a, b, c, d);
      close(r.diff, diff);
      close(r.phi, phi, 8);
      close(r.lo, lo);
      close(r.hi, hi);
    }
  });

  it('pairing narrows the interval against the same margins unpaired (phi = 0)', () => {
    const paired = newcombePaired(5200, 900, 500, 3400);
    // The same margins as if the two arms were independent: the square-and-add with phi = 0.
    const w1 = wilson(6100, 10000);
    const w2 = wilson(5700, 10000);
    const lo = 0.04 - Math.sqrt((0.61 - w1.lo) ** 2 + (w2.hi - 0.57) ** 2);
    const hi = 0.04 + Math.sqrt((0.57 - w2.lo) ** 2 + (w1.hi - 0.61) ** 2);
    close(lo, 0.026371);
    close(hi, 0.053608);
    expect(paired.hi - paired.lo).toBeLessThan((hi - lo) * 0.6);
  });
});

/** Exact two-sided McNemar p by BigInt, rounded to about 1e-16 relative (m <= 200). */
function mcnemarBig(b: number, c: number): number {
  const m = b + c;
  const k = Math.min(b, c);
  if (m === 0 || 2 * k >= m) return 1;
  let s = 0n;
  let t = 1n;
  for (let j = 0; j <= k; j++) {
    s += t;
    t = (t * BigInt(m - j)) / BigInt(j + 1);
  }
  // 2 s / 2^m with 80 extra bits, then scaled back by exact halvings.
  let v = Number(((2n * s) << 80n) / (1n << BigInt(m)));
  for (let i = 0; i < 80; i++) v *= 0.5;
  return Math.min(1, v);
}

describe('exact McNemar', () => {
  it('matches the research vectors', () => {
    rel(mcnemarExact(2, 8), 0.109375, 1e-12);
    rel(mcnemarExact(15, 6), 0.07835388, 1e-7);
    rel(mcnemarExact(900, 500), 6.789454e-27, 1e-6);
    rel(mcnemarExact(520, 480), 0.2174483, 1e-6);
    expect(mcnemarExact(0, 5)).toBe(0.0625);
    expect(mcnemarExact(0, 0)).toBe(1);
    expect(mcnemarExact(7, 7)).toBe(1);
    expect(mcnemarExact(1, 0)).toBe(1);
  });

  it('stays exact at demo scale, where a recurrence from 2^-(b+c) would underflow (vectors from exact rational arithmetic)', () => {
    const exact: [number, number, number][] = [
      [1060, 940, 0.007777118901978714],
      [1100, 900, 8.457089535503927e-6],
      [820, 600, 5.782406686968579e-9],
      [900, 500, 6.789454160524368e-27],
      [10150, 9850, 0.03449137260984106],
      [11000, 9000, 1.9540827705828963e-45],
    ];
    for (const [b, c, p] of exact) {
      rel(mcnemarExact(b, c), p, 1e-12);
      expect(mcnemarExact(c, b)).toBe(mcnemarExact(b, c));
    }
    // 2^-19999 is below the double range: reported as p < 1e-300, never as a wrong number.
    expect(mcnemarExact(20000, 0)).toBeLessThan(P_FLOOR);
  });

  it('agrees with a BigInt oracle over every table up to b + c = 60', () => {
    for (let m = 1; m <= 60; m++) for (let b = 0; b <= m; b++) rel(mcnemarExact(b, m - b), mcnemarBig(b, m - b), 1e-13);
  });
});

describe('Holm', () => {
  it('reproduces the research example: moonbeam-first is significant unadjusted and not after Holm', () => {
    const ps = [
      [610, 540],
      [700, 560],
      [480, 470],
      [820, 600],
    ].map(([b, c]) => mcnemarExact(b!, c!));
    close(ps[0]!, 0.041835);
    close(ps[1]!, 0.000089);
    close(ps[2]!, 0.770306);
    expect(ps[3]!).toBeLessThan(1e-6);
    const adj = holm(ps);
    close(adj[0]!, 0.083669);
    close(adj[1]!, 0.000266);
    close(adj[2]!, 0.770306);
    expect(adj[3]!).toBeLessThan(1e-6);
    expect(adj.map((p) => p <= 0.05)).toEqual([false, true, false, true]);
  });

  it('is monotone in rank and breaks ties by comparison index', () => {
    expect(holm([0.01, 0.01, 0.04])).toEqual([0.03, 0.03, 0.04]);
    expect(holm([0.5, 0.5])).toEqual([1, 1]);
    expect(holm([])).toEqual([]);
  });
});

describe('bootstrap', () => {
  it('pins the toy replicates and CI to the aux key, domain 0', () => {
    const [reps] = bootstrapRatios(42, [{ num: D, den: R }]);
    expect(reps!.length).toBe(1999);
    close(reps![0]!, 5.4084507, 8);
    close(reps![1]!, 5.36986301, 8);
    close(reps![2]!, 5.234375, 8);
    const ci = percentileCI(reps!);
    close(ci.lo, 4.517857);
    close(ci.hi, 5.810811);
    // The first resample's indices, as the research script drew them.
    const s = openAuxStream(42, 0, 0);
    expect(Array.from({ length: 10 }, () => auxInt(s, 20))).toEqual([18, 5, 17, 0, 11, 1, 12, 14, 3, 3]);
  });

  it('keys aux streams in a space no fight can reach, separated by domain', () => {
    for (const seed of [0, 42, 2 ** 32 + 5, Number.MAX_SAFE_INTEGER]) {
      const s = openAuxStream(seed, 0, 0);
      expect(s.k0).toBe(seedKey(seed)[0]);
      expect(s.k1 >>> 31).toBe(1);
      expect(seedKey(seed)[1] >>> 31).toBe(0);
      expect(openAuxStream(seed, 3, 0).k1).toBe((s.k1 | (3 << 21)) >>> 0);
    }
    expect(() => openAuxStream(1, 1024, 0)).toThrow(/domain/);
  });

  it('shares one index vector across series, so identical series give zero paired differences', () => {
    const [a, b, c] = bootstrapRatios(7, [{ num: D, den: R }, { num: D, den: R }, { num: R, den: R }], 99);
    expect(Array.from(diffReps(a!, b!)).every((x) => x === 0)).toBe(true);
    expect(Array.from(c!).every((x) => x === 1)).toBe(true);
    // B = 99: order statistics 3 and 98 (round(0.025 * 100), round(0.975 * 100)).
    const sorted = a!.slice().sort();
    expect(percentileCI(a!)).toEqual({ lo: sorted[2], hi: sorted[97] });
  });

  it('agrees with the delta method on the toy (se 0.338347, CI [4.609579, 5.935875])', () => {
    const se = ratioDeltaSE(D, R);
    close(se, 0.338347);
    close(348 / 66 - Z95 * se, 4.609579);
    close(348 / 66 + Z95 * se, 5.935875);
  });
});

describe('per-fight DPR quantiles and histogram', () => {
  it('nearest rank: p10 0, p50 5.0, p90 6.6 on the toy', () => {
    const per = Float64Array.from(D.map((d, i) => d / R[i]!)).sort();
    expect([nearestRank(per, 10), nearestRank(per, 50), nearestRank(per, 90)]).toEqual([0, 5, 6.6]);
    expect(nearestRank(per, 0)).toBe(per[0]);
    expect(nearestRank(per, 100)).toBe(per[19]);
    expect(() => nearestRank(per, 2.5)).toThrow();
  });

  it('bins floor(D / R) at 1 HP per round with an overflow bin', () => {
    const hist = new Array<number>(DPR_BINS).fill(0);
    for (let i = 0; i < D.length; i++) hist[dprBin(D[i]!, R[i]!)]!++;
    expect(hist.slice(0, 7)).toEqual([3, 0, 1, 1, 4, 3, 8]);
    expect(dprBin(640, 10)).toBe(64);
    expect(dprBin(1000, 1)).toBe(64);
    expect(dprBin(5, 0)).toBe(0);
  });
});
