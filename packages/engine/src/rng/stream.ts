// Keyed random streams on top of Philox.
//
// Every draw has an address:
//   key     = seed
//   counter = (run, seat, purpose<<16 | round, slot<<16 | block)
// Seats are scenario slots ('pc1', 'goblin3'), not builds. `slot` is the roll's index
// within its (seat, purpose, round): open one stream per roll. Then a roll that draws
// extra dice (advantage, Bless, an after-failure die) never shifts the dice of the next
// roll, and two build variants on the same (seed, run) keep rolling the same dice for
// the same roll even after their choices diverge. That's common random numbers for
// build comparison.
//
// A Stream is plain data (no closures) so it can live inside serializable game state.
// The simulator pools Stream objects and rekeys them with openStreamInto, so a fight
// allocates no streams per roll.

import { philox4x32Into } from './philox.ts';

// Append only: a purpose's index is part of every address it draws from.
// 'effect' covers dice that aren't paired with an attack roll (save damage, rolled HP). 'zone' is
// damage from a lasting area, 'heal' any healing, 'react' a die rolled into someone else's d20
// test, 'conc' a concentration save (so it never shifts a creature's other saves).
// M3 step 4 appends 'condSave' (a condition's repeat save, so it never shifts a creature's other
// saves) and 'tempHp' (Temporary Hit Points aren't healing, p.18, so they never shift a heal's dice).
// Ability checks (an escape) use 'check', unused before.
// M3 step 5a appends 'rider' (a rider's saves and its own damage dice, so using one never shifts
// a creature's other saves or effect dice) and 'hitTaken' (a damage-reducing reaction's die).
// M3 step 8'a appends 'reaction': the dice of a hitKnown or damageTaken reaction's program (its
// own damage and its target's saves), so taking one never shifts any other roll.
// Coverage step 7.6 appends 'recharge': a monster's 1d6 at the start of its turn (srd-raw.txt:44017-44025), only while its use is spent.
export const PURPOSES = ['init', 'attack', 'save', 'damage', 'check', 'death', 'ai', 'effect', 'zone', 'heal', 'react', 'conc', 'condSave', 'tempHp', 'rider', 'hitTaken', 'reaction', 'recharge'] as const;
export type Purpose = (typeof PURPOSES)[number];

const TWO_32 = 0x100000000;
const MAX_16 = 0xffff;

export interface Stream {
  k0: number;
  k1: number;
  run: number;
  seat: number;
  lane: number; // purpose << 16 | round
  slot: number;
  block: number; // next block within this slot
  readonly buf: Uint32Array;
  used: number; // words of buf already consumed (4 = empty)
  /** Set when the roll that opened it is closed; drawing from it then throws. */
  closed: boolean;
}

function assertInt(name: string, v: number, max: number): void {
  if (!Number.isInteger(v) || v < 0 || v > max) {
    throw new RangeError(`${name} must be an integer in [0, ${max}], got ${v}`);
  }
}

/** Splits a seed (any safe non-negative integer) into the two key words. */
export function seedKey(seed: number): [number, number] {
  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new RangeError(`seed must be a non-negative safe integer, got ${seed}`);
  }
  return [seed % TWO_32, Math.floor(seed / TWO_32)];
}

export function openStream(seed: number, run: number, seat: number, purpose: Purpose, round: number, slot = 0): Stream {
  const s: Stream = { k0: 0, k1: 0, run: 0, seat: 0, lane: 0, slot: 0, block: 0, buf: new Uint32Array(4), used: 4, closed: false };
  return openStreamInto(s, seed, run, seat, purpose, round, slot);
}

/** Rekeys an existing Stream in place (same address rules as openStream) and returns it. */
export function openStreamInto(s: Stream, seed: number, run: number, seat: number, purpose: Purpose, round: number, slot = 0): Stream {
  const [k0, k1] = seedKey(seed);
  assertInt('run', run, TWO_32 - 1);
  assertInt('seat', seat, TWO_32 - 1);
  assertInt('round', round, MAX_16);
  assertInt('slot', slot, MAX_16);
  const p = PURPOSES.indexOf(purpose);
  if (p < 0) throw new RangeError(`unknown purpose ${purpose}`);
  s.k0 = k0;
  s.k1 = k1;
  s.run = run;
  s.seat = seat;
  s.lane = ((p << 16) | round) >>> 0;
  s.slot = slot;
  s.block = 0;
  s.used = 4;
  s.closed = false;
  return s;
}

export function nextU32(s: Stream): number {
  if (s.closed) throw new Error('drew from a closed roll: every die must be drawn before its roll closes');
  if (s.used === 4) {
    if (s.block > MAX_16) throw new RangeError('stream exhausted: one roll drew more than 262,144 words');
    philox4x32Into(s.buf, s.run, s.seat, s.lane, ((s.slot << 16) | s.block) >>> 0, s.k0, s.k1);
    s.block++;
    s.used = 0;
  }
  return s.buf[s.used++]!;
}

/** Uniform integer in [0, n), unbiased (rejects the top partial range). */
export function uniformInt(s: Stream, n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > TWO_32) {
    throw new RangeError(`n must be an integer in [1, 2^32], got ${n}`);
  }
  const limit = TWO_32 - (TWO_32 % n);
  for (;;) {
    const u = nextU32(s);
    if (u < limit) return u % n;
  }
}

export function rollDie(s: Stream, sides: number): number {
  return uniformInt(s, sides) + 1;
}

// Auxiliary streams: randomness that isn't part of any fight (the report's bootstrap). Fight keys
// are seedKey(seed), whose second word is below 2^21 for every safe seed, so setting bit 31 of
// that word gives a key space disjoint from every fight's dice. Bits 21-30 hold a domain
// (bootstrap = 0). The counter is (c0, 0, 0, block): the block sits in a whole word of its own, so
// an aux stream has no per-roll word cap. Only mc/boot.ts may open or draw from one (lint).

const AUX_DOMAINS = 1 << 10;

export interface AuxStream {
  readonly k0: number;
  readonly k1: number;
  readonly c0: number;
  block: number;
  readonly buf: Uint32Array;
  used: number;
}

export function openAuxStream(seed: number, domain: number, c0: number): AuxStream {
  const [k0, hi] = seedKey(seed);
  assertInt('domain', domain, AUX_DOMAINS - 1);
  assertInt('c0', c0, TWO_32 - 1);
  return { k0, k1: (0x80000000 | (domain << 21) | hi) >>> 0, c0, block: 0, buf: new Uint32Array(4), used: 4 };
}

export function auxU32(s: AuxStream): number {
  if (s.used === 4) {
    if (s.block >= TWO_32) throw new RangeError('aux stream exhausted');
    philox4x32Into(s.buf, s.c0, 0, 0, s.block, s.k0, s.k1);
    s.block++;
    s.used = 0;
  }
  return s.buf[s.used++]!;
}

/** Uniform integer in [0, n), with the same rejection rule as uniformInt. */
export function auxInt(s: AuxStream, n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > TWO_32) {
    throw new RangeError(`n must be an integer in [1, 2^32], got ${n}`);
  }
  const limit = TWO_32 - (TWO_32 % n);
  for (;;) {
    const u = auxU32(s);
    if (u < limit) return u % n;
  }
}
