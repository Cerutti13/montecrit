// Philox4x32-10 (Salmon, Moraes, Dror and Shaw, "Parallel Random Numbers: As Easy as
// 1, 2, 3", SC 2011). Counter-based: each output block is a pure function of
// (counter, key), so any draw can be addressed by its coordinates instead of by
// advancing hidden state. That is what makes runs reproducible across worker counts
// and lets build variants share dice (common random numbers).
//
// Verified against the Random123 known-answer vectors (test/philox.test.ts).

const M0 = 0xd2511f53;
const M1 = 0xcd9e8d57;
const W0 = 0x9e3779b9;
const W1 = 0xbb67ae85;

/** High 32 bits of the 64-bit product of two uint32 values, without BigInt. */
export function mulhi32(a: number, b: number): number {
  const aL = a & 0xffff;
  const aH = a >>> 16;
  const bL = b & 0xffff;
  const bH = b >>> 16;
  const ll = aL * bL;
  const lh = aL * bH;
  const hl = aH * bL;
  const hh = aH * bH;
  const mid = (ll >>> 16) + (lh & 0xffff) + (hl & 0xffff);
  return (hh + (lh >>> 16) + (hl >>> 16) + (mid >>> 16)) >>> 0;
}

/**
 * Writes one Philox4x32 block into `out` (4 uint32 words). Allocation-free, for hot loops.
 * Rounds default to 10; the 7-round variant exists only so the known-answer vectors
 * for it can be checked too.
 */
export function philox4x32Into(
  out: Uint32Array,
  c0: number,
  c1: number,
  c2: number,
  c3: number,
  k0: number,
  k1: number,
  rounds = 10,
): void {
  c0 >>>= 0;
  c1 >>>= 0;
  c2 >>>= 0;
  c3 >>>= 0;
  k0 >>>= 0;
  k1 >>>= 0;
  for (let r = 0; r < rounds; r++) {
    if (r > 0) {
      k0 = (k0 + W0) >>> 0;
      k1 = (k1 + W1) >>> 0;
    }
    const hi0 = mulhi32(M0, c0);
    const lo0 = Math.imul(M0, c0) >>> 0;
    const hi1 = mulhi32(M1, c2);
    const lo1 = Math.imul(M1, c2) >>> 0;
    const n0 = (hi1 ^ c1 ^ k0) >>> 0;
    const n2 = (hi0 ^ c3 ^ k1) >>> 0;
    c0 = n0;
    c1 = lo1;
    c2 = n2;
    c3 = lo0;
  }
  out[0] = c0;
  out[1] = c1;
  out[2] = c2;
  out[3] = c3;
}

/** Convenience wrapper that returns a fresh array. */
export function philox4x32(
  counter: readonly [number, number, number, number],
  key: readonly [number, number],
  rounds = 10,
): [number, number, number, number] {
  const out = new Uint32Array(4);
  philox4x32Into(out, counter[0], counter[1], counter[2], counter[3], key[0], key[1], rounds);
  return [out[0]!, out[1]!, out[2]!, out[3]!];
}
