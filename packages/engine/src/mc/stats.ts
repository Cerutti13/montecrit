// Report statistics (docs/design/m1c.md 5.1; formulas and worked numbers in
// docs/research/m1c-stats-and-encounter.md part 1). Everything here uses + - * /, Math.sqrt,
// Math.floor/ceil/min/max and integer counts, which IEEE 754 rounds the same everywhere, so the
// report is bit-identical across JS engines like the fights are. No log/exp, no Phi^-1.

/** The 95% normal quantile, as a literal (no Phi^-1 at runtime). */
export const Z95 = 1.959963984540054;

export interface Interval {
  readonly lo: number;
  readonly hi: number;
}

/** A ratio of totals, with 0/0 read as 0 (an arm that never got a turn has no uptime). */
export function ratio(num: number, den: number): number {
  return den === 0 ? 0 : num / den;
}

/**
 * Wilson score interval for x successes in n trials (Wilson 1927). lo is forced to 0 at x = 0 and
 * hi to 1 at x = n, which only removes rounding dust. n = 0 gives [0, 1].
 */
export function wilson(x: number, n: number, z = Z95): Interval {
  if (n === 0) return { lo: 0, hi: 1 };
  const z2 = z * z;
  const center = (x + z2 / 2) / (n + z2);
  const half = (z / (n + z2)) * Math.sqrt((x * (n - x)) / n + z2 / 4);
  return { lo: x === 0 ? 0 : center - half, hi: x === n ? 1 : center + half };
}

export interface PairedDiff extends Interval {
  /** p1 - p2 = (b - c) / n. */
  readonly diff: number;
  readonly phi: number;
}

/**
 * Newcombe's hybrid score interval for a paired difference of proportions (Newcombe 1998, with
 * his phi correction), from the 2x2 table of paired runs: a = both win, b = only the first wins,
 * c = only the second wins, d = neither. Checked against the CAMIS worked example and the
 * contingencytables source; the paper's method number is unverified and doesn't matter here.
 */
export function newcombePaired(a: number, b: number, c: number, d: number, z = Z95): PairedDiff {
  const n = a + b + c + d;
  if (n === 0) return { diff: 0, phi: 0, lo: -1, hi: 1 };
  const p1 = (a + b) / n;
  const p2 = (a + c) / n;
  const diff = (b - c) / n;
  const w1 = wilson(a + b, n, z);
  const w2 = wilson(a + c, n, z);
  let phi = 0;
  if (a + b > 0 && c + d > 0 && a + c > 0 && b + d > 0) {
    const A = a * d - b * c;
    const C = A > n / 2 ? A - n / 2 : A >= 0 ? 0 : A;
    phi = C / Math.sqrt((a + b) * (c + d) * (a + c) * (b + d));
  }
  const dl1 = p1 - w1.lo;
  const du1 = w1.hi - p1;
  const dl2 = p2 - w2.lo;
  const du2 = w2.hi - p2;
  // Both radicands are >= (e - f)^2 >= 0 in exact arithmetic; a negative value is rounding.
  const lo = diff - Math.sqrt(Math.max(0, dl1 * dl1 - 2 * phi * dl1 * du2 + du2 * du2));
  const hi = diff + Math.sqrt(Math.max(0, dl2 * dl2 - 2 * phi * dl2 * du1 + du1 * du1));
  return { diff, phi, lo: Math.max(-1, lo), hi: Math.min(1, hi) };
}

/** Below this the report prints "p < 1e-300" instead of a number. */
export const P_FLOOR = 1e-300;

/**
 * Exact two-sided McNemar test on the discordant counts: p = min(1, 2 P(X <= min(b, c))) with
 * X ~ Bin(b + c, 1/2), and 1 when b + c = 0.
 *
 * Done without log/exp, and without underflow at demo scale (critique resolution 2): the tail is
 * summed relative to P(X = k), downward from k with ratio j / (m - j + 1), then P(X = k) =
 * C(m, k) 2^-m is built as a product of (m - k + i) / i factors with the halvings interleaved so
 * it stays near 1. Only a p genuinely below the double range comes out as 0 (or subnormal); both
 * print as "p < 1e-300".
 */
export function mcnemarExact(b: number, c: number): number {
  const m = b + c;
  const k = Math.min(b, c);
  if (m === 0 || 2 * k >= m) return 1;
  let t = 1;
  let tail = 1;
  for (let j = k; j > 0; j--) {
    t = (t * j) / (m - j + 1);
    const next = tail + t;
    if (next === tail) break;
    tail = next;
  }
  let v = 2 * tail;
  let halves = m;
  for (let i = 1; i <= k; i++) {
    v = (v * (m - k + i)) / i;
    while (v >= 2 && halves > 0) {
      v *= 0.5;
      halves--;
    }
  }
  for (; halves > 0 && v > 0; halves--) v *= 0.5;
  return Math.min(1, v);
}

/**
 * Holm step-down adjustment (Holm 1979). Returns adjusted p-values in input order; ties in p are
 * broken by comparison index so the order is total.
 */
export function holm(ps: readonly number[]): number[] {
  const m = ps.length;
  const order = ps.map((_, i) => i).sort((x, y) => (ps[x]! < ps[y]! ? -1 : ps[x]! > ps[y]! ? 1 : x - y));
  const adj = new Array<number>(m).fill(1);
  let running = 0;
  for (let r = 0; r < m; r++) {
    const i = order[r]!;
    running = Math.max(running, Math.min(1, (m - r) * ps[i]!));
    adj[i] = running;
  }
  return adj;
}

/**
 * Nearest-rank quantile of an ascending array: x_(ceil(pct n / 100)), 1-indexed, no
 * interpolation. pct is an integer percent in [0, 100]; p0 is the minimum.
 */
export function nearestRank(sorted: ArrayLike<number>, pct: number): number {
  if (!Number.isInteger(pct) || pct < 0 || pct > 100) throw new RangeError(`pct must be an integer in [0, 100], got ${pct}`);
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  // pct * n is an exact integer; unless it's a multiple of 100 its quotient is at least 0.01 from
  // an integer, so the rounded division can't push ceil to the wrong rank.
  return sorted[Math.max(1, Math.ceil((pct * n) / 100)) - 1]!;
}

/** Per-fight DPR histogram: bins of 1 HP/round over [0, 64), then one overflow bin. */
export const DPR_BINS = 65;

/** Histogram bin of one fight's damage per round. Integer inputs, so floor(d / r) is exact. */
export function dprBin(d: number, r: number): number {
  return r <= 0 ? 0 : Math.min(DPR_BINS - 1, Math.floor(d / r));
}

/**
 * Delta-method standard error of the ratio of totals sum(num) / sum(den) over runs:
 * sqrt(sum((num_i - r den_i)^2) / (n - 1) / n) / mean(den). The bootstrap's test oracle, and the
 * fallback for ratio statistics the report doesn't bootstrap.
 */
export function ratioDeltaSE(num: ArrayLike<number>, den: ArrayLike<number>): number {
  const n = num.length;
  if (den.length !== n) throw new RangeError('num and den must have the same length');
  if (n < 2) return Number.NaN;
  let sn = 0;
  let sd = 0;
  for (let i = 0; i < n; i++) {
    sn += num[i]!;
    sd += den[i]!;
  }
  if (sd === 0) return Number.NaN;
  const r = sn / sd;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const e = num[i]! - r * den[i]!;
    ss += e * e;
  }
  return Math.sqrt(ss / (n - 1) / n) / (sd / n);
}
