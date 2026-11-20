// Roll addressing. This file is the only caller of openStreamInto in the simulator, and the
// only sim/ file that draws from a stream (tools/lint-determinism.ts enforces both). Every
// roll opens through one of three doors, draws with the helpers below, and closes; a closed
// stream throws if anything draws from it later.
//
//   openRoll(roller, purpose)        the roller's next roll of that purpose this round
//   openPaired(roller, slot, purpose) a second stream at an address already used (damage
//                                     paired with its attack roll)
//   openInit(roller, k)              initiative: slot k of round 0
//
// Address: (seed, run, seatKey(roller), purpose, round, slot), slot = partition << 10 | n.
//   partition = 0 when the roller is the unit whose turn it is, else 1 + active unit idx,
//               so an off-turn roll's bucket is keyed by whose turn it is.
//   n         = count of earlier rolls in the same (roller, purpose, partition) this round.
// Why: seats are scenario slots, so two build variants share addresses. A roll that exists
// in only one variant shifts later rolls only within its own bucket, and buckets reset every
// round and differ by whose turn it is. Damage dice sit at the attack roll's slot, so a miss
// in one variant never moves the next hit's damage. Extra dice inside one roll (advantage's
// second d20, crit dice) stay inside that roll's stream.

import { sampleExpr, type ExprNode } from '../dice/expr.ts';
import { nextU32, openStreamInto, PURPOSES, rollDie, type Purpose, type Stream } from '../rng/stream.ts';
import { drawRoll, sampleRoll, type RollDraw, type RollResult, type RollSpec } from '../rolls/rollspec.ts';
import type { RuleFlags } from '../rules/flags.ts';
import type { GameState } from './state.ts';

const N_BITS = 10;
const N_MAX = 1 << N_BITS; // rolls per bucket per round
const MAX_DEPTH = 8;
/** 63 << 10 | 1023 = 65535 is the largest slot M0's 16-bit field allows. */
export const MAX_UNITS = 63;

export interface DiceState {
  readonly cap: number;
  /** [unit][purpose][partition] roll counts for the current round. */
  readonly count: Uint16Array;
  readonly stack: Stream[];
  sp: number;
  /** Tests: every address opened this fight; opening one twice throws. */
  audit: Set<string> | null;
}

export function newDice(units: number, audit: boolean): DiceState {
  const cap = units;
  if (cap > MAX_UNITS) throw new RangeError(`at most ${MAX_UNITS} units fit the roll address, got ${cap}`);
  const stack: Stream[] = [];
  for (let i = 0; i < MAX_DEPTH; i++) stack.push({ k0: 0, k1: 0, run: 0, seat: 0, lane: 0, slot: 0, block: 0, buf: new Uint32Array(4), used: 4, closed: true });
  return { cap, count: new Uint16Array(cap * PURPOSES.length * (cap + 1)), stack, sp: 0, audit: audit ? new Set() : null };
}

/** Called at the start of every round (and of the fight). */
export function resetRoundCounts(d: DiceState): void {
  d.count.fill(0);
}

function push(st: GameState, d: DiceState, roller: number, purpose: Purpose, round: number, slot: number): Stream {
  if (d.sp >= MAX_DEPTH) throw new RangeError('roll windows nested too deep');
  const u = st.units[roller]!;
  if (d.audit) {
    const key = `${u.seatKey}/${purpose}/${round}/${slot}`;
    if (d.audit.has(key)) throw new Error(`roll address opened twice: ${u.seat} ${key}`);
    d.audit.add(key);
  }
  return openStreamInto(d.stack[d.sp++]!, st.seed, st.run, u.seatKey, purpose, round, slot);
}

function partition(st: GameState, roller: number): number {
  return st.active === roller || st.active < 0 ? 0 : 1 + st.active;
}

export function openRoll(st: GameState, d: DiceState, roller: number, purpose: Purpose): Stream {
  const part = partition(st, roller);
  const i = (roller * PURPOSES.length + PURPOSES.indexOf(purpose)) * (d.cap + 1) + part;
  const n = d.count[i]!;
  if (n >= N_MAX) throw new RangeError(`more than ${N_MAX} ${purpose} rolls by ${st.units[roller]!.seat} in one round and partition`);
  d.count[i] = n + 1;
  return push(st, d, roller, purpose, st.round, (part << N_BITS) | n);
}

export function openPaired(st: GameState, d: DiceState, roller: number, slot: number, purpose: Purpose): Stream {
  return push(st, d, roller, purpose, st.round, slot);
}

export function openInit(st: GameState, d: DiceState, roller: number, k: number): Stream {
  return push(st, d, roller, 'init', 0, k);
}

export function closeRoll(d: DiceState, s: Stream): void {
  if (d.sp === 0 || d.stack[d.sp - 1] !== s) throw new Error('closeRoll: not the innermost open roll');
  s.closed = true;
  d.sp--;
}

// The only draws sim/ may make, each from a roll that's open.

/** One dice expression (damage, healing, rolled HP). */
export function drawExpr(s: Stream, e: ExprNode): number {
  return sampleExpr(e, {}, s);
}

export function drawDie(s: Stream, sides: number): number {
  return rollDie(s, sides);
}

/** A raw 32-bit word (initiative tiebreaks). */
export function drawWord(s: Stream): number {
  return nextU32(s);
}

/** Every die of one d20 test; settle it with settleRoll after any windows. */
export function drawD20(spec: RollSpec, s: Stream, ext?: ArrayLike<number>): RollDraw {
  return drawRoll(spec, s, ext);
}

/** A d20 test with no windows at all (initiative). */
export function drawWholeRoll(spec: RollSpec, s: Stream, flags: RuleFlags): RollResult {
  return sampleRoll(spec, s, flags);
}
