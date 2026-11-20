// Exact probability mass functions over integers.
//
// A Pmf is plain data: p[i] = P(X = min + i). Every operation assumes independence
// between its inputs (sum of separate dice, max of two separate d20s).

export interface Pmf {
  readonly min: number;
  readonly p: Float64Array;
}

export function constant(v: number): Pmf {
  if (!Number.isInteger(v)) throw new RangeError(`constant must be an integer, got ${v}`);
  return { min: v, p: Float64Array.of(1) };
}

export function die(sides: number): Pmf {
  if (!Number.isInteger(sides) || sides < 1) throw new RangeError(`die needs at least 1 side, got ${sides}`);
  return { min: 1, p: new Float64Array(sides).fill(1 / sides) };
}

export function maxValue(a: Pmf): number {
  return a.min + a.p.length - 1;
}

/** Distribution of X + Y for independent X ~ a, Y ~ b. */
export function convolve(a: Pmf, b: Pmf): Pmf {
  const out = new Float64Array(a.p.length + b.p.length - 1);
  for (let i = 0; i < a.p.length; i++) {
    const pa = a.p[i]!;
    if (pa === 0) continue;
    for (let j = 0; j < b.p.length; j++) out[i + j]! += pa * b.p[j]!;
  }
  return { min: a.min + b.min, p: out };
}

export function sumOf(list: readonly Pmf[]): Pmf {
  return list.reduce(convolve, constant(0));
}

export function shift(a: Pmf, c: number): Pmf {
  return { min: a.min + c, p: a.p };
}

/** Distribution of k * X for an integer k. */
export function scale(a: Pmf, k: number): Pmf {
  if (!Number.isInteger(k)) throw new RangeError(`scale factor must be an integer, got ${k}`);
  if (k === 0) return constant(0);
  if (k === 1) return a;
  const n = a.p.length;
  const out = new Float64Array((n - 1) * Math.abs(k) + 1);
  if (k > 0) {
    for (let i = 0; i < n; i++) out[i * k] = a.p[i]!;
    return { min: a.min * k, p: out };
  }
  // k < 0: the largest x maps to the smallest value.
  const m = -k;
  for (let i = 0; i < n; i++) out[(n - 1 - i) * m] = a.p[i]!;
  return { min: maxValue(a) * k, p: out };
}

function cdfArray(a: Pmf, lo: number, hi: number): Float64Array {
  // F[v - lo] = P(X <= v) for v in [lo, hi]
  const F = new Float64Array(hi - lo + 1);
  let acc = 0;
  for (let v = lo; v <= hi; v++) {
    const i = v - a.min;
    if (i >= 0 && i < a.p.length) acc += a.p[i]!;
    F[v - lo] = acc;
  }
  return F;
}

/** Distribution of max(X, Y) for independent X ~ a, Y ~ b (advantage). */
export function maxOf(a: Pmf, b: Pmf): Pmf {
  const lo = Math.min(a.min, b.min);
  const hi = Math.max(maxValue(a), maxValue(b));
  const Fa = cdfArray(a, lo, hi);
  const Fb = cdfArray(b, lo, hi);
  const out = new Float64Array(hi - lo + 1);
  let prev = 0;
  for (let i = 0; i < out.length; i++) {
    const F = Fa[i]! * Fb[i]!;
    out[i] = F - prev;
    prev = F;
  }
  return trim({ min: lo, p: out });
}

/** Distribution of min(X, Y) for independent X ~ a, Y ~ b (disadvantage). */
export function minOf(a: Pmf, b: Pmf): Pmf {
  return negate(maxOf(negate(a), negate(b)));
}

export function negate(a: Pmf): Pmf {
  return scale(a, -1);
}

/** Distribution of max(X, floor): every value below `floor` becomes `floor`. */
export function clampLow(a: Pmf, floor: number): Pmf {
  if (floor <= a.min) return a;
  const hi = maxValue(a);
  if (floor >= hi) return constant(floor);
  const out = new Float64Array(hi - floor + 1);
  for (let i = 0; i < a.p.length; i++) {
    const v = a.min + i;
    out[Math.max(v, floor) - floor]! += a.p[i]!;
  }
  return { min: floor, p: out };
}

/** P(X >= t). */
export function probAtLeast(a: Pmf, t: number): number {
  let s = 0;
  for (let i = Math.max(0, t - a.min); i < a.p.length; i++) s += a.p[i]!;
  return s;
}

/** P(X = v). */
export function probAt(a: Pmf, v: number): number {
  const i = v - a.min;
  return i >= 0 && i < a.p.length ? a.p[i]! : 0;
}

export function totalMass(a: Pmf): number {
  let s = 0;
  for (let i = 0; i < a.p.length; i++) s += a.p[i]!;
  return s;
}

export function mean(a: Pmf): number {
  let s = 0;
  for (let i = 0; i < a.p.length; i++) s += (a.min + i) * a.p[i]!;
  return s;
}

export function variance(a: Pmf): number {
  const mu = mean(a);
  let s = 0;
  for (let i = 0; i < a.p.length; i++) {
    const d = a.min + i - mu;
    s += d * d * a.p[i]!;
  }
  return s;
}

/** Drops zero-probability tails so min and length describe the true support. */
export function trim(a: Pmf): Pmf {
  let lo = 0;
  let hi = a.p.length - 1;
  while (lo < hi && a.p[lo] === 0) lo++;
  while (hi > lo && a.p[hi] === 0) hi--;
  if (lo === 0 && hi === a.p.length - 1) return a;
  return { min: a.min + lo, p: a.p.slice(lo, hi + 1) };
}

const ENUMERATION_CAP = 2_000_000;

/**
 * Keep the highest (or lowest) `count` of `n` dice with `sides` sides, summed.
 * count 1 uses the order-statistic CDF (any n); other counts enumerate outcomes,
 * capped so a typo like 20d20kh3 fails loudly instead of hanging.
 */
export function keepDice(n: number, sides: number, mode: 'h' | 'l', count: number): Pmf {
  if (!Number.isInteger(count) || count < 1 || count > n) {
    throw new RangeError(`keep count must be in [1, ${n}], got ${count}`);
  }
  if (count === n) return sumOf(Array.from({ length: n }, () => die(sides)));
  if (count === 1) {
    let acc = die(sides);
    for (let i = 1; i < n; i++) acc = mode === 'h' ? maxOf(acc, die(sides)) : minOf(acc, die(sides));
    return acc;
  }
  // sides^n by multiplication (no ** in the engine: lint); stops once past the cap, so it stays an exact integer.
  let outcomes = 1;
  for (let i = 0; i < n && outcomes <= ENUMERATION_CAP; i++) outcomes *= sides;
  if (outcomes > ENUMERATION_CAP) {
    throw new RangeError(
      `${n}d${sides}k${mode}${count} has ${sides}^${n} outcomes; exact keep is capped at ${ENUMERATION_CAP}`,
    );
  }
  const out = new Float64Array(count * sides - count + 1); // sums range count..count*sides
  const faces = new Array<number>(n).fill(1);
  const sorted = new Array<number>(n);
  const w = 1 / outcomes;
  for (let k = 0; k < outcomes; k++) {
    for (let i = 0; i < n; i++) sorted[i] = faces[i]!;
    sorted.sort((x, y) => (mode === 'h' ? y - x : x - y));
    let sum = 0;
    for (let i = 0; i < count; i++) sum += sorted[i]!;
    out[sum - count]! += w;
    // odometer increment
    for (let i = 0; i < n; i++) {
      if (faces[i]! < sides) {
        faces[i]!++;
        break;
      }
      faces[i] = 1;
    }
  }
  return { min: count, p: out };
}
