// The Monte Carlo runner (docs/design/m1c.md 4). Arms are the things being compared (policies
// now, build variants in M6); every arm plays the same runs 0..n-1 of the same seed, so dice
// line up run for run (common random numbers) and wins pair up for McNemar.
//
// runChunk is pure: (arms, seed, chunkIdx, n, chunkSize) -> integer accumulators. Deciders are
// built fresh for every fight (critique resolution 7), and the result holds only numbers, strings
// and typed arrays, so it can cross a worker boundary by structured clone (M2's seam). Merging is
// integer addition plus concatenation in chunkIdx order, so the merged result doesn't depend on
// chunk size, worker count, or the order chunks finished in. Every per-fight quantity is an
// integer, so there's no Welford here; Float64Array sums stay exact below 2^53.

import { makeDeciders } from '../decide/make.ts';
import { bindPolicy, playsSeat, ScriptedDecider, type CompiledPolicy } from '../decide/policy.ts';
import { FX_END_WHYS } from '../log/events.ts';
import { FLAG_KEYS } from '../rules/flags.ts';
import { newScratch } from '../sim/context.ts';
import { buildCounterLayout, MAX_POOLS, type CounterLayout } from '../sim/counters.ts';
import { runFight, type FightResult } from '../sim/fight.ts';
import type { FightSetup } from '../sim/setup.ts';
import { STALEMATE_CAUSES } from '../sim/state.ts';
import { DPR_BINS, dprBin, nearestRank, wilson } from './stats.ts';

export const CHUNK = 250;
/** Adaptive runs check the stopping rule every this many runs (4 chunks of 250). */
export const CHECKPOINT = 1000;
export const MIN_ADAPTIVE_N = 1000;
export const DEFAULT_UNTIL_CI = 0.01;
export const DEFAULT_MAX_N = 100_000;
/** Per-run arrays are capped here; a larger run is refused (histogram quantiles are deferred). */
export const MAX_RUNS = 1 << 20;

export interface ArmSpec {
  readonly label: string;
  readonly setup: FightSetup;
  /** Plays the seats it covers; null leaves every seat to its scenario decider. */
  readonly policy: CompiledPolicy | null;
}

/** Per-run outcome byte: the low two bits are the outcome, the rest are flags. */
export const OUT = { win: 0, loss: 1, stalemate: 2, mask: 3, tpk: 4, pcDrop: 8, allPcsDown: 16, pcDied: 32 } as const;
/** Death causes, as Counters.death codes 1..3. */
export const DEATH_CAUSES = ['zeroHp', 'massive', 'deathSaves'] as const;
const NC = DEATH_CAUSES.length;
const NW = FX_END_WHYS.length;

/**
 * Everything one arm accumulates. The PC figures (Dpc, concT, turnsPc, pcHpEnd, the PC flags)
 * sum over every PC seat; M1c fights have one.
 */
export interface ArmAcc {
  readonly label: string;
  n: number;
  win: number;
  loss: number;
  stalemate: number;
  /** Stalemates by cause (STALEMATE_CAUSES order); left undefined until one happens, so a report with none hashes as before. */
  stalemateBy?: number[];
  /** Engine TPK: every party member dead. */
  tpk: number;
  allPcsDown: number;
  /** Runs where some PC dropped, died; wins where some PC dropped (critique resolution 19). */
  pcDrop: number;
  pcDied: number;
  winPcDown: number;
  sumR: number;
  sumR2: number;
  /** Per unit: runs where it dropped at least once; runs where it died, [unit * 3 + cause]. */
  readonly dropRuns: Float64Array;
  readonly deathRuns: Float64Array;
  /** Per cause: runs where some PC died that way (a run counts once per cause, however many PCs). */
  readonly pcDeathRuns: Float64Array;
  /** [R]: fights that lasted R rounds; [r]: fights that reached round r (reached[0] = n). */
  readonly roundsHist: Float64Array;
  readonly reached: Float64Array;
  /** [round * S + source], as in Counters. */
  readonly dmgEff: Float64Array;
  readonly dmgRolled: Float64Array;
  /** The friendly-fire part of dmgEff and dmgRolled (damage to the source's own side). */
  readonly ffEff: Float64Array;
  readonly ffRolled: Float64Array;
  readonly dmgTaken: Float64Array;
  readonly slots: Float64Array;
  readonly preSlots: Float64Array;
  readonly pools: Float64Array;
  readonly freeCasts: Float64Array;
  readonly concStart: Float64Array;
  readonly concEnd: Float64Array;
  readonly turns: Float64Array;
  readonly concTurns: Float64Array;
  readonly picks: Float64Array;
  /** Per-fight PC damage per round, floor(Dpc / R), 1 HP/round bins plus overflow. */
  readonly dprHist: Float64Array;
  /** Policy rules, [rule * 3 + (taken, retried, retired)]: taken and retired count runs where any seat it plays did; retried sums over those seats. */
  readonly script: Float64Array;
  /** Per flag (FLAG_KEYS order): 1 if any run's resolution read it, or any decider consulted it. Merged by OR. */
  readonly flagsRead: Uint8Array;
  readonly aiFlags: Uint8Array;
  // Per-run arrays, in run order.
  out: Uint8Array;
  R: Uint16Array;
  Dpc: Int32Array;
  Dparty: Int32Array;
  concT: Uint16Array;
  turnsPc: Uint16Array;
  foeHpLeft: Uint16Array;
  foeHpMax: Uint16Array;
  pcHpEnd: Int16Array;
}

/** The fixed-size part of an arm's accumulator, from its counter layout. */
function newArmAcc(label: string, L: CounterLayout, rules: number, runs: number): ArmAcc {
  const U = L.units;
  const S = L.sources.length;
  const f = (k: number) => new Float64Array(k);
  return {
    label,
    n: 0,
    win: 0,
    loss: 0,
    stalemate: 0,
    tpk: 0,
    allPcsDown: 0,
    pcDrop: 0,
    pcDied: 0,
    winPcDown: 0,
    sumR: 0,
    sumR2: 0,
    dropRuns: f(U),
    deathRuns: f(U * NC),
    pcDeathRuns: f(NC),
    roundsHist: f(L.rounds),
    reached: f(L.rounds),
    dmgEff: f(L.rounds * S),
    dmgRolled: f(L.rounds * S),
    ffEff: f(L.rounds * S),
    ffRolled: f(L.rounds * S),
    dmgTaken: f(U),
    slots: f(U * 9),
    preSlots: f(U * 9),
    pools: f(U * MAX_POOLS),
    freeCasts: f(U),
    concStart: f(U),
    concEnd: f(U * NW),
    turns: f(U),
    concTurns: f(U),
    picks: f(L.picks),
    dprHist: f(DPR_BINS),
    script: f(rules * 3),
    flagsRead: new Uint8Array(FLAG_KEYS.length),
    aiFlags: new Uint8Array(FLAG_KEYS.length),
    out: new Uint8Array(runs),
    R: new Uint16Array(runs),
    Dpc: new Int32Array(runs),
    Dparty: new Int32Array(runs),
    concT: new Uint16Array(runs),
    turnsPc: new Uint16Array(runs),
    foeHpLeft: new Uint16Array(runs),
    foeHpMax: new Uint16Array(runs),
    pcHpEnd: new Int16Array(runs),
  };
}

function addInto(a: Float64Array, b: ArrayLike<number>): void {
  for (let i = 0; i < a.length; i++) a[i]! += b[i]!;
}

function orInto(a: Uint8Array, b: ArrayLike<number>): void {
  for (let i = 0; i < a.length; i++) a[i] = a[i]! | b[i]!;
}

function fits(v: number, max: number, what: string): number {
  if (v > max) throw new RangeError(`${what} is ${v}; the per-run arrays hold at most ${max}`);
  return v;
}

/** Folds one finished fight (run index i within the accumulator's per-run arrays) into acc. */
function record(acc: ArmAcc, i: number, setup: FightSetup, r: FightResult, scripted: readonly ScriptedDecider[]): void {
  const c = r.counters;
  const L = c.layout;
  const S = L.sources.length;
  const seats = setup.seats;
  const R = r.outcome.k === 'stalemate' ? setup.knobs.maxRounds : r.outcome.round;
  let out: number = r.outcome.k === 'win' ? OUT.win : r.outcome.k === 'loss' ? OUT.loss : OUT.stalemate;
  if (r.outcome.tpk) out |= OUT.tpk;

  let Dpc = 0;
  let Dparty = 0;
  // Damage to the other side; friendly fire is counted on its own.
  for (let k = 0; k < L.rounds * S; k++) {
    const d = c.dmgEff[k]! - c.ffEff[k]!;
    if (d === 0) continue;
    const owner = L.sources[k % S]!.owner;
    if (seats[owner]!.team === 0) Dparty += d;
    if (seats[owner]!.tpl.kind === 'pc') Dpc += d;
  }
  let concT = 0;
  let turnsPc = 0;
  let pcHp = 0;
  let pcCauses = 0;
  let pcs = 0;
  let pcsDown = 0;
  let foeLeft = 0;
  let foeMax = 0;
  for (let u = 0; u < seats.length; u++) {
    const s = seats[u]!;
    if (c.drops[u]! > 0) acc.dropRuns[u]!++;
    if (c.death[u]! > 0) acc.deathRuns[u * NC + c.death[u]! - 1]!++;
    if (s.team === 1) {
      foeLeft += Math.max(0, r.hp[u]!);
      foeMax += r.hpMax[u]!;
    }
    if (s.tpl.kind !== 'pc') continue;
    if (c.death[u]! > 0) pcCauses |= 1 << (c.death[u]! - 1);
    pcs++;
    concT += c.concTurns[u]!;
    turnsPc += c.turns[u]!;
    pcHp += Math.max(0, r.hp[u]!);
    if (r.life[u] !== 'up') pcsDown++;
    if (c.drops[u]! > 0) out |= OUT.pcDrop;
    if (c.death[u]! > 0) out |= OUT.pcDied;
  }
  if (pcs > 0 && pcsDown === pcs) out |= OUT.allPcsDown;

  acc.n++;
  if ((out & OUT.mask) === OUT.win) acc.win++;
  else if ((out & OUT.mask) === OUT.loss) acc.loss++;
  else {
    acc.stalemate++;
    if (r.stalemateCause) (acc.stalemateBy ??= STALEMATE_CAUSES.map(() => 0))[STALEMATE_CAUSES.indexOf(r.stalemateCause)]!++;
  }
  if (out & OUT.tpk) acc.tpk++;
  if (out & OUT.allPcsDown) acc.allPcsDown++;
  if (out & OUT.pcDrop) acc.pcDrop++;
  if (out & OUT.pcDied) acc.pcDied++;
  if ((out & OUT.mask) === OUT.win && out & OUT.pcDrop) acc.winPcDown++;
  acc.sumR += R;
  acc.sumR2 += R * R;
  acc.roundsHist[R]!++;
  for (let k = 0; k <= R; k++) acc.reached[k]!++;
  addInto(acc.dmgEff, c.dmgEff);
  addInto(acc.dmgRolled, c.dmgRolled);
  addInto(acc.ffEff, c.ffEff);
  addInto(acc.ffRolled, c.ffRolled);
  addInto(acc.dmgTaken, c.dmgTaken);
  addInto(acc.slots, c.slots);
  addInto(acc.preSlots, c.preSlots);
  addInto(acc.pools, c.pools);
  addInto(acc.freeCasts, c.freeCasts);
  addInto(acc.concStart, c.concStart);
  addInto(acc.concEnd, c.concEnd);
  addInto(acc.turns, c.turns);
  addInto(acc.concTurns, c.concTurns);
  addInto(acc.picks, c.picks);
  acc.dprHist[dprBin(Dpc, R)]!++;
  orInto(acc.flagsRead, r.flagsUsed);
  orInto(acc.aiFlags, r.aiFlags);
  for (let c2 = 0; c2 < NC; c2++) if (pcCauses & (1 << c2)) acc.pcDeathRuns[c2]!++;
  const rules = acc.script.length / 3;
  for (let k = 0; k < rules; k++) {
    let taken = 0;
    let retired = 0;
    for (const d of scripted) {
      const s = d.stats[k]!;
      taken |= s.taken > 0 ? 1 : 0;
      retired |= s.retired > 0 ? 1 : 0;
      acc.script[k * 3 + 1]! += s.retried;
    }
    acc.script[k * 3]! += taken;
    acc.script[k * 3 + 2]! += retired;
  }

  acc.out[i] = out;
  acc.R[i] = R;
  acc.Dpc[i] = Dpc;
  acc.Dparty[i] = Dparty;
  acc.concT[i] = concT;
  acc.turnsPc[i] = turnsPc;
  acc.foeHpLeft[i] = fits(foeLeft, 0xffff, 'enemy HP left');
  acc.foeHpMax[i] = fits(foeMax, 0xffff, 'enemy max HP');
  acc.pcHpEnd[i] = fits(pcHp, 0x7fff, 'PC HP at the end');
}

/**
 * Checks that arms can be compared run for run, before anything runs (design 4.6): the same
 * scenario and content hash and seat list, policies that bind, the same set of policy-played
 * seats, and identical deciders on every other seat. Returns every problem found.
 */
export function validateArms(arms: readonly ArmSpec[]): string[] {
  const errors: string[] = [];
  if (arms.length === 0) return ['no arms to run'];
  const ref = arms[0]!;
  arms.forEach((a, k) => {
    if (arms.findIndex((b) => b.label === a.label) !== k) errors.push(`two arms are labelled "${a.label}"`);
    if (a.policy) errors.push(...bindPolicy(a.policy, a.setup));
    const s = a.setup;
    const sameSeats = s.seats.length === ref.setup.seats.length && s.seats.every((x, i) => x.seat === ref.setup.seats[i]!.seat);
    if (k > 0) {
      if (s.scenarioHash !== ref.setup.scenarioHash) errors.push(`arm ${a.label}: scenario ${s.scenario} (${s.scenarioHash}) differs from arm ${ref.label}'s (${ref.setup.scenarioHash})`);
      if (s.contentHash !== ref.setup.contentHash) errors.push(`arm ${a.label}: content ${s.contentHash} differs from arm ${ref.label}'s (${ref.setup.contentHash})`);
      if (!sameSeats) errors.push(`arm ${a.label}: its seats differ from arm ${ref.label}'s`);
    }
    s.seats.forEach((x, i) => {
      const mine = a.policy !== null && playsSeat(a.policy, s, i);
      if (!mine && x.decider === 'journal' && x.fallback === null) errors.push(`arm ${a.label}: seat ${x.seat} is decider journal with no fallback; Monte Carlo runs have no journal`);
      if (k === 0 || !sameSeats) return;
      const y = ref.setup.seats[i]!;
      const theirs = ref.policy !== null && playsSeat(ref.policy, ref.setup, i);
      if (mine !== theirs) errors.push(`seat ${x.seat}: played by the policy in arm ${(mine ? a : ref).label} but not in arm ${(mine ? ref : a).label}`);
      else if (!mine && (x.decider !== y.decider || x.fallback !== y.fallback)) errors.push(`seat ${x.seat}: decider ${x.decider} in arm ${a.label} but ${y.decider} in arm ${ref.label}; seats no policy plays must match`);
    });
  });
  return errors;
}

export interface ChunkResult {
  readonly chunkIdx: number;
  readonly start: number;
  readonly count: number;
  readonly arms: readonly ArmAcc[];
}

/** Observes one finished fight: arm index, run index, result. It can't change anything the runner records. */
export type OnFight = (arm: number, run: number, r: FightResult) => void;

/** Runs [chunkIdx * chunkSize, min(n, (chunkIdx + 1) * chunkSize)) for every arm. Pure. */
export function runChunk(arms: readonly ArmSpec[], seed: number, chunkIdx: number, n: number, chunkSize = CHUNK, onFight: OnFight | null = null): ChunkResult {
  const start = chunkIdx * chunkSize;
  if (!Number.isInteger(chunkIdx) || chunkIdx < 0 || start >= n) throw new RangeError(`chunk ${chunkIdx} is outside runs [0, ${n})`);
  const count = Math.min(n, start + chunkSize) - start;
  const accs = arms.map((a, k) => {
    const layout = buildCounterLayout(a.setup);
    const sc = newScratch(a.setup.w * a.setup.h);
    sc.ctrLayout = layout;
    const acc = newArmAcc(a.label, layout, a.policy?.script.length ?? 0, count);
    for (let i = 0; i < count; i++) {
      const ds = makeDeciders(a.setup, [], undefined, a.policy);
      const r = runFight(a.setup, seed, start + i, ds, null, { scratch: sc });
      record(acc, i, a.setup, r, ds.filter((d): d is ScriptedDecider => d instanceof ScriptedDecider));
      onFight?.(k, start + i, r);
    }
    return acc;
  });
  return { chunkIdx, start, count, arms: accs };
}

function concat<T extends Uint8Array | Uint16Array | Int16Array | Int32Array>(a: T, b: T): T {
  const out = new (a.constructor as new (n: number) => T)(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function mergeArm(a: ArmAcc, b: ArmAcc): void {
  if (a.label !== b.label) throw new RangeError(`merging arm ${b.label} into ${a.label}`);
  a.n += b.n;
  a.win += b.win;
  a.loss += b.loss;
  a.stalemate += b.stalemate;
  if (b.stalemateBy) {
    const by = (a.stalemateBy ??= STALEMATE_CAUSES.map(() => 0));
    b.stalemateBy.forEach((x, i) => (by[i]! += x));
  }
  a.tpk += b.tpk;
  a.allPcsDown += b.allPcsDown;
  a.pcDrop += b.pcDrop;
  a.pcDied += b.pcDied;
  a.winPcDown += b.winPcDown;
  a.sumR += b.sumR;
  a.sumR2 += b.sumR2;
  orInto(a.flagsRead, b.flagsRead);
  orInto(a.aiFlags, b.aiFlags);
  for (const k of ['dropRuns', 'deathRuns', 'pcDeathRuns', 'roundsHist', 'reached', 'dmgEff', 'dmgRolled', 'ffEff', 'ffRolled', 'dmgTaken', 'slots', 'preSlots', 'pools', 'freeCasts', 'concStart', 'concEnd', 'turns', 'concTurns', 'picks', 'dprHist', 'script'] as const) addInto(a[k], b[k]);
  a.out = concat(a.out, b.out);
  a.R = concat(a.R, b.R);
  a.Dpc = concat(a.Dpc, b.Dpc);
  a.Dparty = concat(a.Dparty, b.Dparty);
  a.concT = concat(a.concT, b.concT);
  a.turnsPc = concat(a.turnsPc, b.turnsPc);
  a.foeHpLeft = concat(a.foeHpLeft, b.foeHpLeft);
  a.foeHpMax = concat(a.foeHpMax, b.foeHpMax);
  a.pcHpEnd = concat(a.pcHpEnd, b.pcHpEnd);
}

export interface Merged {
  readonly chunkSize: number;
  /** The next chunk mergeInto accepts. */
  nextChunk: number;
  /** Runs merged so far (every arm has the same). */
  n: number;
  readonly arms: ArmAcc[];
}

export function newMerged(arms: readonly ArmSpec[], chunkSize = CHUNK): Merged {
  return { chunkSize, nextChunk: 0, n: 0, arms: arms.map((a) => newArmAcc(a.label, buildCounterLayout(a.setup), a.policy?.script.length ?? 0, 0)) };
}

/** Merges the next chunk. Chunks must arrive in chunkIdx order; buffer them until they do. */
export function mergeInto(m: Merged, c: ChunkResult): void {
  if (c.chunkIdx !== m.nextChunk) throw new RangeError(`chunk ${c.chunkIdx} arrived when chunk ${m.nextChunk} was next`);
  if (c.start !== m.n || c.arms.length !== m.arms.length) throw new RangeError(`chunk ${c.chunkIdx} doesn't continue the merge (start ${c.start}, merged ${m.n})`);
  c.arms.forEach((a, k) => mergeArm(m.arms[k]!, a));
  m.n += c.count;
  m.nextChunk++;
}

/** The largest Wilson win-rate half-width over arms: what the adaptive stopping rule targets. */
export function maxWinHalfWidth(m: Merged): number {
  let h = 0;
  for (const a of m.arms) {
    const w = wilson(a.win, a.n);
    h = Math.max(h, (w.hi - w.lo) / 2);
  }
  return h;
}

export interface RunOptions {
  /** Exactly this many runs. Omitted: adaptive. */
  readonly n?: number;
  /** Adaptive target for the win-rate half-width (default 0.01) and run cap (default 100,000). */
  readonly untilCi?: number;
  readonly maxN?: number;
  readonly chunkSize?: number;
  /** Checkpoint spacing and the smallest n the adaptive rule may stop at; tests shrink them (defaults 1,000 and 1,000). */
  readonly checkpoint?: number;
  readonly minN?: number;
  /** Called after every merge (progress). */
  readonly onMerge?: (m: Merged) => void;
  /** Sees every finished fight (tests: the final state hash a replay must reach). */
  readonly onFight?: OnFight;
}

export interface RunResult {
  readonly merged: Merged;
  readonly adaptive: boolean;
  /** Adaptive: the checkpoint it stopped at (n / checkpoint spacing, rounded up), and whether it hit the cap instead of the target. */
  readonly checkpoint: number | null;
  readonly hitCap: boolean;
}

/** A run's checked options: what the stopping rule needs (docs/design/m2.md 2.1). Plain data. */
export interface RunSchedule {
  /** Runs per arm: n, or the adaptive cap. */
  readonly total: number;
  readonly adaptive: boolean;
  readonly chunkSize: number;
  /** Adaptive checkpoint spacing, the smallest n it may stop at, and the win half-width target. */
  readonly every: number;
  readonly minN: number;
  readonly target: number;
}

/** validateArms plus every range check on the options; throws what runArms throws. */
export function resolveSchedule(arms: readonly ArmSpec[], opts: RunOptions = {}): RunSchedule {
  const errors = validateArms(arms);
  if (errors.length) throw new Error(errors.join('\n'));
  const chunkSize = opts.chunkSize ?? CHUNK;
  if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new RangeError(`chunk size must be a positive integer, got ${chunkSize}`);
  const adaptive = opts.n === undefined;
  const total = opts.n ?? opts.maxN ?? DEFAULT_MAX_N;
  if (!Number.isInteger(total) || total < 1 || total > MAX_RUNS) throw new RangeError(`runs must be an integer in [1, ${MAX_RUNS}], got ${total}`);
  const every = opts.checkpoint ?? CHECKPOINT;
  const minN = opts.minN ?? MIN_ADAPTIVE_N;
  if (adaptive && every % chunkSize !== 0) throw new RangeError(`adaptive runs need a chunk size that divides the checkpoint spacing ${every}, got ${chunkSize}`);
  return { total, adaptive, chunkSize, every, minN, target: opts.untilCi ?? DEFAULT_UNTIL_CI };
}

/**
 * The stopping rule, written once (runArms and the worker pool both call it). Call it after
 * EACH mergeInto, never once after a batch, or a checkpoint can be skipped. A result means stop
 * now. Adaptive (design 4.3): the first checkpoint with n >= minN where every arm's Wilson win
 * half-width is <= the target; otherwise the cap. Every arm stops at the same n.
 */
export function afterMerge(s: RunSchedule, m: Merged): RunResult | null {
  if (s.adaptive && m.n % s.every === 0 && m.n >= s.minN && maxWinHalfWidth(m) <= s.target) return { merged: m, adaptive: true, checkpoint: m.n / s.every, hitCap: false };
  if (m.n >= s.total) return { merged: m, adaptive: s.adaptive, checkpoint: s.adaptive ? Math.ceil(m.n / s.every) : null, hitCap: s.adaptive };
  return null;
}

/** Runs the arms in one process: chunks in order, each merged and checked as it finishes. With `n`, exactly n runs. */
export function runArms(arms: readonly ArmSpec[], seed: number, opts: RunOptions = {}): RunResult {
  const s = resolveSchedule(arms, opts);
  const m = newMerged(arms, s.chunkSize);
  for (let k = 0; ; k++) {
    mergeInto(m, runChunk(arms, seed, k, s.total, s.chunkSize, opts.onFight ?? null));
    opts.onMerge?.(m);
    const r = afterMerge(s, m);
    if (r) return r;
  }
}

/** Paired win table of two arms over the same runs: a both win, b only x, c only y, d neither. */
export function pairCounts(x: ArmAcc, y: ArmAcc, bit = -1): { a: number; b: number; c: number; d: number } {
  if (x.n !== y.n) throw new RangeError(`arms ${x.label} and ${y.label} ran ${x.n} and ${y.n} runs`);
  const hit = (o: number) => (bit < 0 ? (o & OUT.mask) === OUT.win : (o & bit) !== 0);
  let a = 0;
  let b = 0;
  let c = 0;
  for (let i = 0; i < x.n; i++) {
    const p = hit(x.out[i]!);
    const q = hit(y.out[i]!);
    if (p && q) a++;
    else if (p) b++;
    else if (q) c++;
  }
  return { a, b, c, d: x.n - a - b - c };
}

export interface Exemplars {
  /** Run indices, or -1 when there's no such run. */
  readonly closestLoss: number;
  readonly typicalWin: number;
  readonly tpk: number;
  readonly pcDeath: number;
}

/**
 * Exemplar runs (design 4.4), each the minimum of a total-order key:
 * - closest loss: enemy HP left / enemy max HP (integers, cross-multiplied), then more rounds, then run index;
 * - typical win: |R - median R|, then |PC HP at the end - median|, then run index (nearest-rank medians over wins);
 * - TPK, PC death: the first such run.
 */
export function exemplars(acc: ArmAcc): Exemplars {
  let closestLoss = -1;
  let tpk = -1;
  let pcDeath = -1;
  const wins: number[] = [];
  for (let i = 0; i < acc.n; i++) {
    const o = acc.out[i]!;
    if (tpk < 0 && o & OUT.tpk) tpk = i;
    if (pcDeath < 0 && o & OUT.pcDied) pcDeath = i;
    if ((o & OUT.mask) === OUT.win) wins.push(i);
    if ((o & OUT.mask) !== OUT.loss) continue;
    if (closestLoss < 0) {
      closestLoss = i;
      continue;
    }
    const j = closestLoss;
    const lhs = acc.foeHpLeft[i]! * acc.foeHpMax[j]!;
    const rhs = acc.foeHpLeft[j]! * acc.foeHpMax[i]!;
    if (lhs < rhs || (lhs === rhs && acc.R[i]! > acc.R[j]!)) closestLoss = i;
  }
  let typicalWin = -1;
  if (wins.length > 0) {
    const medR = nearestRank(Int32Array.from(wins, (i) => acc.R[i]!).sort(), 50);
    const medHp = nearestRank(Int32Array.from(wins, (i) => acc.pcHpEnd[i]!).sort(), 50);
    let best = [0, 0];
    for (const i of wins) {
      const key = [Math.abs(acc.R[i]! - medR), Math.abs(acc.pcHpEnd[i]! - medHp)];
      if (typicalWin < 0 || key[0]! < best[0]! || (key[0] === best[0] && key[1]! < best[1]!)) {
        typicalWin = i;
        best = key;
      }
    }
  }
  return { closestLoss, typicalWin, tpk, pcDeath };
}
