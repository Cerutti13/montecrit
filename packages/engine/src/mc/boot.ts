// Percentile bootstrap over runs for ratio-of-totals statistics (docs/design/m1c.md 5.1):
// PC DPR, party DPR, concentration uptime. B = 1999 replicates; the CI is order statistics 50 and
// 1950 of the sorted replicates. BCa was rejected: it needs Phi and Phi^-1 and differs by about
// 0.0007 DPR at n = 10^4.
//
// Resample b draws its n indices from aux stream (seed, domain 0, b), and every series shares
// them, so the replicates of two arms' statistics are paired and their differences give a paired
// CI for free. Sums are exact integers, accumulated in draw order. This is the only file that may
// open aux streams (lint).

import { auxInt, openAuxStream } from '../rng/stream.ts';
import { ratio, type Interval } from './stats.ts';

export const BOOT_B = 1999;
export const BOOT_DOMAIN = 0;

/** One ratio statistic's per-run integer numerators and denominators, in run order. */
export interface RatioSeries {
  readonly num: ArrayLike<number>;
  readonly den: ArrayLike<number>;
}

/** Bootstrap replicates of every series' ratio of totals; one Float64Array of length B per series. */
export function bootstrapRatios(seed: number, series: readonly RatioSeries[], B = BOOT_B): Float64Array[] {
  const S = series.length;
  const reps = series.map(() => new Float64Array(B));
  if (S === 0) return reps;
  const n = series[0]!.num.length;
  for (const s of series) if (s.num.length !== n || s.den.length !== n) throw new RangeError('every series must have one value per run');
  if (n === 0) return reps;
  const num = new Float64Array(S);
  const den = new Float64Array(S);
  for (let b = 0; b < B; b++) {
    const st = openAuxStream(seed, BOOT_DOMAIN, b);
    num.fill(0);
    den.fill(0);
    for (let i = 0; i < n; i++) {
      const j = auxInt(st, n);
      for (let k = 0; k < S; k++) {
        num[k]! += series[k]!.num[j]!;
        den[k]! += series[k]!.den[j]!;
      }
    }
    for (let k = 0; k < S; k++) reps[k]![b] = ratio(num[k]!, den[k]!);
  }
  return reps;
}

/** Percentile CI: order statistics round(0.025 (B + 1)) and round(0.975 (B + 1)), 1-indexed. */
export function percentileCI(reps: Float64Array): Interval {
  const B = reps.length;
  if (B === 0) return { lo: Number.NaN, hi: Number.NaN };
  const s = reps.slice().sort();
  const lo = Math.max(1, Math.floor(((B + 1) * 25 + 500) / 1000));
  const hi = Math.min(B, Math.floor(((B + 1) * 975 + 500) / 1000));
  return { lo: s[lo - 1]!, hi: s[hi - 1]! };
}

/** Replicate-wise a - b, for a paired percentile CI of a difference (descriptive, not Holm-adjusted). */
export function diffReps(a: Float64Array, b: Float64Array): Float64Array {
  if (a.length !== b.length) throw new RangeError('replicate arrays differ in length');
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i]! - b[i]!;
  return out;
}
