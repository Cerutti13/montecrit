// RollSpec: everything that decides one d20 test, as plain data. The engine samples it
// during fights; rollOdds() evaluates it exactly. Both read the same spec, so the
// odds calculator and the simulator can't disagree about what a modifier does.

import { exprsPmf, sampleExpr, type ExprNode } from '../dice/expr.ts';
import { clampLow, die, maxOf, minOf, probAt, probAtLeast, type Pmf } from '../odds/pmf.ts';
import { rollDie, type Stream } from '../rng/stream.ts';
import { DEFAULT_FLAGS, type RuleFlags } from '../rules/flags.ts';

export type RollKind = 'check' | 'save' | 'attack';
export type AdvState = 'none' | 'adv' | 'dis';

export interface RollSpec {
  kind: RollKind;
  adv: AdvState;
  /** Every fixed modifier, summed (ability + proficiency + flat bonuses). */
  flat: number;
  /** Dice added to every roll, decided before the outcome is known (Guidance, Bless). */
  preDice: readonly ExprNode[];
  /** A die added only after a failure is seen (Bardic Inspiration). Must be non-negative. */
  afterFail?: ExprNode;
  /** Treat a d20 below this as this (e.g. a concentration floor of 10). */
  floor?: number;
  /** Attacks: the lowest natural d20 that is a critical hit, 2..20. Default 20. */
  critMin?: number;
  /** Attacks: any hit is a critical hit (an Unconscious or Paralyzed target within 5 ft). */
  autoCritOnHit?: boolean;
  /** Fails whatever the dice say (an Unconscious creature's STR or DEX save). */
  autoFail?: boolean;
  /**
   * Signed dice other creatures roll into this test before the d20 (a pre-roll reaction).
   * The engine draws them from the reactor's own stream and passes the values in, so the
   * roller's dice never move; without values (odds --verify, tests) they're drawn last.
   */
  extDice?: readonly ExprNode[];
  /** The DC, or the target's AC for attacks. */
  dc: number;
}

/** Advantage and disadvantage come from sets of sources; any of each cancels to a straight roll. */
export function resolveAdvantage(advSources: readonly string[], disSources: readonly string[]): AdvState {
  const a = advSources.length > 0;
  const d = disSources.length > 0;
  if (a && !d) return 'adv';
  if (d && !a) return 'dis';
  return 'none';
}

export interface RollOdds {
  pSuccess: number;
  /** Success without any after-failure die. */
  pBaseSuccess: number;
  /** Chance the after-failure die gets rolled (it's spent only on a failure). */
  pAfterFailUsed: number;
  /** Attacks only: chance of a critical hit. */
  pCrit: number;
  /** Distribution of the d20 face after advantage and any floor. */
  d20: Pmf;
}

function validate(spec: RollSpec): void {
  for (const [name, v] of [['flat', spec.flat], ['dc', spec.dc], ['floor', spec.floor]] as const) {
    if (v !== undefined && !Number.isInteger(v)) throw new RangeError(`${name} must be an integer, got ${v}`);
  }
  if (spec.critMin !== undefined && (!Number.isInteger(spec.critMin) || spec.critMin < 2 || spec.critMin > 20)) {
    throw new RangeError(`critMin must be an integer in [2, 20], got ${spec.critMin}`);
  }
}

/** Distribution of the kept d20 face, after advantage/disadvantage and any floor. */
export function d20Pmf(adv: AdvState, floor?: number): Pmf {
  const d20 = die(20);
  let face = adv === 'adv' ? maxOf(d20, d20) : adv === 'dis' ? minOf(d20, d20) : d20;
  if (floor !== undefined) face = clampLow(face, floor);
  return face;
}

/**
 * Hit or miss decided by the natural d20 alone, if any. Naturals are read before any floor.
 * Attacks: a natural 1 misses and a natural 20 hits, whatever the crit range. Whether a
 * crit from an expanded range also auto-hits is a rule flag.
 */
/** Every flag rollOdds, settleRoll and the greedy AI's quickOdds read (oddsFlags marks them for the report). */
export const ODDS_FLAGS = ['expandedCritAutoHits', 'natOnChecksAndSaves'] as const satisfies readonly (keyof RuleFlags)[];

export function autoOutcome(spec: RollSpec, natural: number, flags: RuleFlags): 'pass' | 'fail' | undefined {
  if (spec.autoFail) return 'fail';
  if (spec.kind === 'attack') {
    if (natural === 1) return 'fail';
    if (natural === 20) return 'pass';
    if (flags.expandedCritAutoHits && natural >= (spec.critMin ?? 20)) return 'pass'; // the crit range, not autoCritOnHit
    return undefined;
  }
  if (flags.natOnChecksAndSaves === 'autoPassFail') {
    if (natural === 20) return 'pass';
    if (natural === 1) return 'fail';
  }
  return undefined;
}

/** A crit-range natural is a critical hit if the attack hits; with autoCritOnHit, every hit is. */
function isCrit(spec: RollSpec, natural: number): boolean {
  return spec.kind === 'attack' && (spec.autoCritOnHit === true || natural >= (spec.critMin ?? 20));
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export function rollOdds(spec: RollSpec, flags: RuleFlags = DEFAULT_FLAGS): RollOdds {
  validate(spec);
  const natural = d20Pmf(spec.adv); // the face before any floor decides naturals
  const before = spec.extDice && spec.extDice.length > 0 ? [...spec.preDice, ...spec.extDice] : spec.preDice;
  const pre = exprsPmf(before);
  const after = spec.afterFail ? exprsPmf([spec.afterFail]) : undefined;
  if (after && after.min < 0) throw new RangeError('an after-failure die must not be able to go negative');
  const withAfter = spec.afterFail ? exprsPmf([...before, spec.afterFail]) : pre;

  let pSuccess = 0;
  let pBase = 0;
  let pUsed = 0;
  let pCrit = 0;
  for (let nat = 1; nat <= 20; nat++) {
    const pn = probAt(natural, nat);
    if (pn === 0) continue;
    const crit = isCrit(spec, nat);
    const auto = autoOutcome(spec, nat, flags);
    if (auto === 'fail') continue;
    if (auto === 'pass') {
      pSuccess += pn;
      pBase += pn;
      if (crit) pCrit += pn;
      continue;
    }
    const face = spec.floor !== undefined ? Math.max(nat, spec.floor) : nat;
    const need = spec.dc - face - spec.flat;
    const base = probAtLeast(pre, need);
    // With a non-negative after-failure die, "add it only after a failure" succeeds exactly
    // when "always add it" does, so P(success) = P(pre + after >= need).
    const succ = after ? probAtLeast(withAfter, need) : base;
    pBase += pn * base;
    pSuccess += pn * succ;
    if (after) pUsed += pn * (1 - base);
    if (crit) pCrit += pn * succ;
  }
  // Sums of 0.05s land a few ulps past 1 on certain outcomes; keep them true probabilities.
  return {
    pSuccess: clamp01(pSuccess),
    pBaseSuccess: clamp01(pBase),
    pAfterFailUsed: clamp01(pUsed),
    pCrit: clamp01(pCrit),
    d20: d20Pmf(spec.adv, spec.floor),
  };
}

export interface RollResult {
  /** Both d20s as drawn (the second is drawn even on a straight roll, to keep dice aligned). */
  d20: [number, number];
  natural: number;
  face: number;
  total: number;
  success: boolean;
  crit: boolean;
  afterFailUsed: boolean;
  /** Sum of the preDice and of the extDice that went into the total. */
  pre: number;
  ext: number;
}

/** Every die one roll draws, before anything is decided. */
export interface RollDraw {
  a: number;
  b: number;
  pre: number;
  /** The after-failure die, drawn whether or not it ends up used. */
  after: number;
  ext: number;
}

/**
 * Draws every die of one roll from its own stream (see openStream's slot): both d20s, then
 * the preDice, then the after-failure die, then (only if no values are passed) the extDice.
 * The after-failure die sits where M0 drew it, and it's drawn even when it goes unused; the
 * stream belongs to this roll alone, so that moves nothing else. Deciding comes later
 * (settleRoll), which leaves room for windows between the two (M8's after-roll reactions).
 */
export function drawRoll(spec: RollSpec, s: Stream, ext?: ArrayLike<number>): RollDraw {
  const a = rollDie(s, 20);
  const b = rollDie(s, 20);
  let pre = 0;
  for (const d of spec.preDice) pre += sampleExpr(d, {}, s);
  const after = spec.afterFail ? sampleExpr(spec.afterFail, {}, s) : 0;
  let e = 0;
  const n = spec.extDice ? spec.extDice.length : 0;
  if (ext) for (let i = 0; i < n; i++) e += ext[i]!;
  else for (let i = 0; i < n; i++) e += sampleExpr(spec.extDice![i]!, {}, s);
  return { a, b, pre, after, ext: e };
}

/** Decides a drawn roll: naturals, floor, total, success, crit, and the after-failure die if needed. */
export function settleRoll(spec: RollSpec, draw: RollDraw, flags: RuleFlags = DEFAULT_FLAGS): RollResult {
  const { a, b, pre, ext } = draw;
  const natural = spec.adv === 'adv' ? Math.max(a, b) : spec.adv === 'dis' ? Math.min(a, b) : a;
  const face = spec.floor !== undefined ? Math.max(natural, spec.floor) : natural;
  let total = face + spec.flat + pre + ext;

  const d20: [number, number] = [a, b];
  const crit = isCrit(spec, natural);
  const auto = autoOutcome(spec, natural, flags);
  const done = (success: boolean, c: boolean, afterFailUsed: boolean): RollResult => ({ d20, natural, face, total, success, crit: c, afterFailUsed, pre, ext });
  if (auto === 'fail') return done(false, false, false);
  if (auto === 'pass') return done(true, crit, false);
  if (total >= spec.dc) return done(true, crit, false);
  if (!spec.afterFail) return done(false, false, false);
  total += draw.after;
  const success = total >= spec.dc;
  return done(success, crit && success, true);
}

/** Samples one roll: drawRoll then settleRoll. Pass a stream opened for this roll alone. */
export function sampleRoll(spec: RollSpec, s: Stream, flags: RuleFlags = DEFAULT_FLAGS, ext?: ArrayLike<number>): RollResult {
  validate(spec);
  return settleRoll(spec, drawRoll(spec, s, ext), flags);
}
