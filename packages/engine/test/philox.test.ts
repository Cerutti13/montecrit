import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { mulhi32, philox4x32 } from '../src/rng/philox.ts';

// Known-answer vectors from Random123's tests/kat_vectors (DEShawResearch/random123).
// Format: rounds, counter[4], key[2], expected[4].
const KAT: [number, number[], number[], number[]][] = [
  [7, [0, 0, 0, 0], [0, 0], [0x5f6fb709, 0x0d893f64, 0x4f121f81, 0x4f730a48]],
  [7, [0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff], [0xffffffff, 0xffffffff], [0x5207ddc2, 0x45165e59, 0x4d8ee751, 0x8c52f662]],
  [7, [0x243f6a88, 0x85a308d3, 0x13198a2e, 0x03707344], [0xa4093822, 0x299f31d0], [0x4dfccaba, 0x190a87f0, 0xc47362ba, 0xb6b5242a]],
  [10, [0, 0, 0, 0], [0, 0], [0x6627e8d5, 0xe169c58d, 0xbc57ac4c, 0x9b00dbd8]],
  [10, [0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff], [0xffffffff, 0xffffffff], [0x408f276d, 0x41c83b0e, 0xa20bc7c6, 0x6d5451fd]],
  [10, [0x243f6a88, 0x85a308d3, 0x13198a2e, 0x03707344], [0xa4093822, 0x299f31d0], [0xd16cfe09, 0x94fdcceb, 0x5001e420, 0x24126ea1]],
];

describe('Philox4x32', () => {
  it.each(KAT)('matches the Random123 known-answer vector (%i rounds)', (rounds, ctr, key, expected) => {
    expect(philox4x32(ctr as [number, number, number, number], key as [number, number], rounds)).toEqual(expected);
  });

  it('mulhi32 equals the high word of the exact 64-bit product', () => {
    fc.assert(
      fc.property(fc.nat({ max: 0xffffffff }), fc.nat({ max: 0xffffffff }), (a, b) => {
        const exact = Number((BigInt(a) * BigInt(b)) >> 32n);
        expect(mulhi32(a, b)).toBe(exact);
      }),
      { numRuns: 2000 },
    );
  });
});
