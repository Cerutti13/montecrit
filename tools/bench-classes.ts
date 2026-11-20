// The C0 class bench (docs/design/coverage.md section 6 as amended by M13; the build-order C0
// row): one curated build per class (tools/class-picks.ts) at levels 1, 3, 5, 6 and 10 in four
// scenarios on public content with fixed seeds, scored against thresholds frozen before C0.
//
//   dummy-melee  a target 5 ft away (AC by level band) that never acts: sim DPR rounds 2-5
//   dummy-range  the same target 60 ft away plus one harmless archer: rounds to first damage, Dodge
//   duel         one SRD monster sized by the XP table for one character at low difficulty
//   party        the class plus three fixed allies vs a stock group (moderate, four characters;
//                signed off by Shane 2026-11-09, M13 g)
//
// Metrics per class x level (each pass/FAIL with its reason; a miss is recorded, never tuned):
//   H  loop health: Dodge share of PC turns <= 20% on every bench; duel and party stalemates
//      <= 5%; the character attacks or casts at all; <= 1 item decision per fight
//   U  core-feature use (the per-class core table), on the party bench, read per the frozen rule
//      (CORE[cls].uRead: per fight, by round 2, uptime after round 1, per qualifying turn (W1: the
//      Rogue's Sneak Attack); a rate rule whose denominator isn't read yet is FAIL n/a, never the
//      per-fight reading under its label)
//   D  AI utilization: sim DPR rounds 2-5 on the class's dummy over the engine-exact value of its
//      written loop, >= 0.80 at L3+ (L1 reported); a cantrip loop is read on the rounds with no
//      leveled cast only; plus the hand-computed book-DPR table
//   F  feature matters: a paired party arm with the core feature removed (decision filter, or W1: a
//      rider feature's template compiled without it; common random numbers), n 2,000 fixed, foe HP
//      removed down by >= 5 points, Holm across classes
//   W  party win% (Wilson), reported only; flagged below half the class median at L1-5
//
//   npm run bench [-- --procs N (default: every core)] [--out FILE] [--json FILE] [--quick] [--class a,b] [--level 5]
//
// Tooling, not a golden. Reads only the repo's packs (never ~/.montecrit).

import { availableParallelism } from 'node:os';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Worker } from 'node:worker_threads';
import { holm, wilson } from '../packages/engine/src/index.ts';
import { CORE, CURATED, PICK_CLASSES, PICK_LEVELS, THRESHOLDS, type PickClass } from './class-picks.ts';
import { BENCH_CAUSES, causeText, noCauses, type BenchCause } from './bench-trace.ts';
import {
  benchSetup,
  benchWorld,
  BENCH_SEED,
  REPORTED_SPELLS,
  BENCHES,
  crOf,
  D_WINDOW_ROUNDS,
  DUEL_MONSTER,
  DUMMY_AC,
  engineLoop,
  hasUFeature,
  PARTY_GROUP,
  PARTY_PROVISIONAL,
  partyAllies,
  removalSet,
  runTask,
  XP_BUDGET,
  type Bench,
  type BenchWorld,
  type FightRow,
  type TaskResult,
  type TaskSpec,
} from './bench-core.ts';

export interface BenchOptions {
  readonly classes: readonly PickClass[];
  readonly levels: readonly number[];
  readonly benches: readonly Bench[];
  /** Fights per bench (party is the F arm's fixed n). */
  readonly n: Readonly<Record<Bench, number>>;
  /** Run the F arm (party bench only), at these levels (the accept gates are L3/5/6: coverage.md W1-W4). */
  readonly f: boolean;
  readonly fLevels: readonly number[];
  /** Party fights for a row with no F arm (W and U only). */
  readonly partyWOnly: number;
  readonly chunk: number;
}

/** A class has an F arm when some core entry is modeled (not marked notModeled in tools/class-picks.ts). */
export const hasFArm = (cls: PickClass): boolean => CORE[cls].core.some((c) => c.notModeled === undefined);

export const FULL_N: Readonly<Record<Bench, number>> = { 'dummy-melee': 100, 'dummy-range': 100, duel: 300, party: THRESHOLDS.fN };

export const FULL: BenchOptions = { classes: PICK_CLASSES, levels: PICK_LEVELS, benches: BENCHES, n: FULL_N, f: true, fLevels: [3, 5, 6], partyWOnly: 400, chunk: 200 };

/** The test:slow subset (m9): one class per wave at L5 (W1 fighter, W2 paladin, W3 wizard, W4 cleric), dummy and party only. */
export const QUICK: BenchOptions = {
  classes: ['fighter', 'paladin', 'wizard', 'cleric'],
  levels: [5],
  benches: ['dummy-melee', 'dummy-range', 'party'],
  n: { 'dummy-melee': 100, 'dummy-range': 100, duel: 0, party: 300 },
  f: true,
  fLevels: [5],
  partyWOnly: 300,
  chunk: 100,
};

/** Every task, in the order results merge. */
export function planTasks(o: BenchOptions): TaskSpec[] {
  const out: TaskSpec[] = [];
  for (const cls of o.classes) {
    for (const level of o.levels) {
      for (const bench of o.benches) {
        const fRow = bench === 'party' && o.f && o.fLevels.includes(level) && hasFArm(cls);
        const n = bench === 'party' && !fRow ? Math.min(o.n.party, o.partyWOnly) : o.n[bench];
        const arms = fRow ? (['base', 'removed'] as const) : (['base'] as const);
        for (const arm of arms) for (let from = 0; from < n; from += o.chunk) out.push({ bench, cls, level, arm, from, to: Math.min(n, from + o.chunk) });
      }
    }
  }
  return out;
}

/** Runs the tasks in this thread (tests, --procs 1). */
export function runInProcess(world: BenchWorld, tasks: readonly TaskSpec[]): TaskResult[] {
  return tasks.map((t) => runTask(world, t));
}

/**
 * Relative cost of a task, for dispatch order only (party fights at L5+ have 8-10 units and run
 * about 10x a dummy fight; measured once, [U] a rough weight). Never changes what's merged.
 */
export function taskCost(t: TaskSpec): number {
  const w = t.bench === 'party' ? (t.level >= 5 ? 10 : 4) : t.bench === 'duel' ? 1.5 : 1;
  return w * (t.to - t.from);
}

/**
 * Runs the tasks on `procs` worker threads, dispatching the costliest first (so no long task
 * starts last and idles the other threads); results come back in task order, so the report is
 * the same for any order and any thread count.
 */
export async function runOnWorkers(tasks: readonly TaskSpec[], procs: number): Promise<TaskResult[]> {
  const out: TaskResult[] = new Array(tasks.length);
  const order = tasks.map((t, i) => ({ i, c: taskCost(t) })).sort((a, b) => b.c - a.c || a.i - b.i).map((x) => x.i);
  let next = 0;
  const one = () =>
    new Promise<void>((resolve, reject) => {
      const w = new Worker(new URL('./bench-worker.ts', import.meta.url));
      const send = () => {
        if (next >= order.length) {
          w.postMessage('stop');
          return;
        }
        const id = order[next++]!;
        w.postMessage({ id, spec: tasks[id] });
      };
      w.on('message', (m: 'ready' | { id: number; result: TaskResult }) => {
        if (m !== 'ready') out[m.id] = m.result;
        send();
      });
      w.on('error', reject);
      w.on('exit', () => resolve());
    });
  await Promise.all(Array.from({ length: Math.max(1, Math.min(procs, tasks.length)) }, one));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Evaluation.

export interface Verdict {
  readonly pass: boolean | null; // null: reported only
  readonly value: string;
  readonly reason: string;
}

export interface BenchRow {
  readonly cls: PickClass;
  readonly level: number;
  readonly perBench: Partial<Record<Bench, BenchAgg>>;
  readonly H: Verdict;
  readonly U: Verdict;
  readonly D: Verdict;
  readonly F: Verdict;
  readonly W: Verdict;
  readonly errors: readonly string[];
  /** F's one-sided p before Holm (null when not tested). */
  readonly fP: number | null;
  readonly fDiff: number | null;
}

export interface BenchAgg {
  fights: number;
  /** Casts of each of REPORTED_SPELLS, in its order. */
  spellCasts: number[];
  wins: number;
  losses: number;
  stalemates: number;
  causes: Record<BenchCause, number>;
  turnsUp: number;
  dodges: number;
  attacks: number;
  casts: number;
  items: number;
  coreUsed: number;
  turnsAfterR1: number;
  upTurnsAfterR1: number;
  crits: number;
  hitTurns: number;
  cantripRounds: number;
  cantripRoundDmg: number;
  dummyDmg: number;
  firstDamageSum: number;
  firstDamageN: number;
  pcDamage: number;
  /** Base-arm turn decisions on which a removed item was legal (review C0-BENCH-M1), and (W1) offers of a removed rider. */
  coreLegalTurns: number;
  /** W1: qualifying turns for a perQualifyingTurn U, the ones taken, the PC's hit turns, and the dShare rider's damage to the dummy in rounds 2-5. */
  qualTurns: number;
  qualTaken: number;
  hitTurnsAll: number;
  shareDmg: number;
  /** Per-run foe HP removed (permille), base arm; and the removed arm's (party). */
  readonly foe: number[];
  readonly foeRemoved: number[];
}

function newAgg(): BenchAgg {
  return { fights: 0, wins: 0, losses: 0, stalemates: 0, causes: noCauses(), turnsUp: 0, dodges: 0, attacks: 0, casts: 0, items: 0, coreUsed: 0, turnsAfterR1: 0, upTurnsAfterR1: 0, crits: 0, hitTurns: 0, cantripRounds: 0, cantripRoundDmg: 0, dummyDmg: 0, firstDamageSum: 0, firstDamageN: 0, pcDamage: 0, coreLegalTurns: 0, qualTurns: 0, qualTaken: 0, hitTurnsAll: 0, shareDmg: 0, spellCasts: [], foe: [], foeRemoved: [] };
}

function fold(a: BenchAgg, r: FightRow): void {
  a.fights++;
  if (r.outcome === 'win') a.wins++;
  else if (r.outcome === 'loss') a.losses++;
  else a.stalemates++;
  if (r.cause) a.causes[r.cause]++;
  a.turnsUp += r.turnsUp;
  a.dodges += r.dodges;
  a.attacks += r.attacks;
  a.casts += r.casts;
  a.items += r.items;
  if (r.coreUsed) a.coreUsed++;
  a.turnsAfterR1 += r.turnsAfterR1;
  a.upTurnsAfterR1 += r.upTurnsAfterR1;
  a.crits += r.crits;
  a.hitTurns += r.hitTurns;
  a.cantripRounds += r.cantripRounds;
  a.cantripRoundDmg += r.cantripRoundDmg;
  a.dummyDmg += r.dummyDmg2to5;
  if (r.firstDamageRound > 0) {
    a.firstDamageSum += r.firstDamageRound;
    a.firstDamageN++;
  }
  a.pcDamage += r.pcDamage;
  a.coreLegalTurns += r.coreLegalTurns;
  a.qualTurns += r.qualTurns;
  a.qualTaken += r.qualTaken;
  a.hitTurnsAll += r.hitTurnsAll;
  a.shareDmg += r.shareDmg2to5;
  r.spellCasts.forEach((n, i) => {
    a.spellCasts[i] = (a.spellCasts[i] ?? 0) + n;
  });
  a.foe.push(r.foeHpRemovedPermille);
}

/** Normal upper tail, for the paired z test (erfc by Numerical Recipes' Chebyshev fit, |error| < 1.2e-7). */
export function normalUpper(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.5 * x);
  const y = t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  const upper = 0.5 * y; // P(Z > |z|)
  return z >= 0 ? upper : 1 - upper;
}

/** Paired difference base - removed in points (permille / 10): mean, SE and the one-sided p for H0: diff <= 0. */
export function pairedDiff(base: readonly number[], removed: readonly number[]): { diff: number; se: number; p: number } {
  const n = Math.min(base.length, removed.length);
  if (n < 2) return { diff: 0, se: Infinity, p: 1 };
  let s = 0;
  for (let i = 0; i < n; i++) s += (base[i]! - removed[i]!) / 10;
  const m = s / n;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const d = (base[i]! - removed[i]!) / 10 - m;
    ss += d * d;
  }
  const se = Math.sqrt(ss / (n - 1) / n);
  if (se === 0) return { diff: m, se, p: m > 0 ? 0 : 1 };
  return { diff: m, se, p: normalUpper(m / se) };
}

const pct = (x: number): string => `${(100 * x).toFixed(1)}%`;

export function evaluate(world: BenchWorld, o: BenchOptions, results: readonly TaskResult[]): BenchRow[] {
  const rows: BenchRow[] = [];
  const pending: { idx: number; level: number; p: number }[] = [];
  for (const cls of o.classes) {
    for (const level of o.levels) {
      const per: Partial<Record<Bench, BenchAgg>> = {};
      const errors: string[] = [];
      for (const r of results) {
        if (r.spec.cls !== cls || r.spec.level !== level) continue;
        if (r.error) errors.push(`${r.spec.bench}/${r.spec.arm} ${r.spec.from}-${r.spec.to}: ${r.error}`);
        const a = (per[r.spec.bench] ??= newAgg());
        if (r.spec.arm === 'base') for (const f of r.rows) fold(a, f);
        else for (const f of r.rows) a.foeRemoved.push(f.foeHpRemovedPermille);
      }
      const entry = CORE[cls];
      // H
      const hWhy: string[] = [];
      let hPass = true;
      let attacks = 0;
      let casts = 0;
      let items = 0;
      let fights = 0;
      const dodgeParts: string[] = [];
      for (const b of o.benches) {
        const a = per[b];
        if (!a || a.fights === 0) continue;
        attacks += a.attacks;
        casts += a.casts;
        items += a.items;
        fights += a.fights;
        const ds = a.turnsUp > 0 ? a.dodges / a.turnsUp : 0;
        dodgeParts.push(`${b} ${pct(ds)}`);
        if (ds > THRESHOLDS.dodgeShareMax) {
          hPass = false;
          hWhy.push(`Dodge ${pct(ds)} of turns on ${b} (max ${pct(THRESHOLDS.dodgeShareMax)})`);
        }
        if ((b === 'duel' || b === 'party') && a.stalemates / a.fights > THRESHOLDS.stalemateShareMax) {
          hPass = false;
          hWhy.push(`${b} stalemates ${pct(a.stalemates / a.fights)} (max ${pct(THRESHOLDS.stalemateShareMax)}; ${causeText(a.causes)})`);
        }
      }
      if (attacks + casts === 0) {
        hPass = false;
        hWhy.push('never attacks or casts on any bench');
      }
      const ipf = fights > 0 ? items / fights : 0;
      if (ipf > THRESHOLDS.itemDecisionsPerFightMax) {
        hPass = false;
        hWhy.push(`${ipf.toFixed(2)} item decisions per fight (max ${THRESHOLDS.itemDecisionsPerFightMax})`);
      }
      const H: Verdict = { pass: hPass, value: dodgeParts.join(', '), reason: hPass ? 'all loop-health gates hold' : hWhy.join('; ') };
      // U
      const uBench = per.party ? 'party' : per.duel ? 'duel' : null;
      const tpl = benchSetup(world, 'party', cls, level).seats.find((x) => x.seat === 'pc1')!.tpl;
      const rm = removalSet(cls, tpl);
      const unmodeled = entry.core.filter((c) => c.notModeled !== undefined && !c.features.some((f) => tpl.features.some((x) => x.id === f)) && !c.spells.some((s) => tpl.spells.some((e) => e.spell.id === s)));
      const allUnmodeled = unmodeled.length === entry.core.length;
      let U: Verdict;
      const auto = rm.auto.length ? `; automatic riders reported, not counted: ${rm.auto.join(', ')}` : '';
      if (allUnmodeled) U = { pass: false, value: 'n/a', reason: `not modeled: ${unmodeled.map((c) => c.notModeled).join('; ')}` };
      else if (entry.uRead === 'unmeasured') U = { pass: false, value: 'n/a', reason: `${entry.uRule} (${entry.uSource}): not measured: ${entry.uUnmeasured}` };
      else if (!hasUFeature(cls, tpl)) U = { pass: null, value: 'n/a', reason: `${entry.uRule}: not on the L${level} sheet${entry.uFrom ? ` (${entry.uFrom.cite})` : ''}${auto}` };
      else if (!uBench) U = { pass: null, value: '-', reason: 'no duel or party bench run' };
      else if (entry.uRead === 'perQualifyingTurn') {
        // W1 (w1-plan.md 4.1): turns the rider was offered (deduped per turn, any creature's turn),
        // the share taken; and, ungated, the share of the PC's hit turns that qualified.
        const a = per[uBench]!;
        const partial = unmodeled.length > 0 ? `; not modeled yet: ${unmodeled.map((c) => c.notModeled).join('; ')}` : '';
        const qualShare = `qualifying turns ${a.qualTurns} of ${a.hitTurnsAll} hit turns (${pct(a.hitTurnsAll > 0 ? a.qualTurns / a.hitTurnsAll : 0)}, reported: the AI's setup, Advantage or an ally next to the target)`;
        if (a.qualTurns === 0) U = { pass: false, value: 'n/a', reason: `${entry.uRule} (${entry.uSource}): no qualifying turn in ${a.fights} ${uBench} fights; ${qualShare}${partial}${auto}` };
        else {
          const rate = a.qualTaken / a.qualTurns;
          U = { pass: rate >= entry.uThreshold, value: pct(rate), reason: `${entry.uRule} (${entry.uSource}): ${pct(rate)} of ${a.qualTurns} ${uBench} turns it was offered on (taken on ${a.qualTaken}), counting ${entry.uIds.join(', ')}; ${qualShare}${partial}${auto}` };
        }
      } else {
        const a = per[uBench]!;
        const uptime = entry.uRead === 'uptimeAfterRound1';
        const rate = uptime ? (a.turnsAfterR1 > 0 ? a.upTurnsAfterR1 / a.turnsAfterR1 : 0) : a.fights > 0 ? a.coreUsed / a.fights : 0;
        const ok = rate >= entry.uThreshold;
        const partial = unmodeled.length > 0 ? `; not modeled yet: ${unmodeled.map((c) => c.notModeled).join('; ')}` : '';
        const of = uptime ? `of ${a.turnsAfterR1} ${uBench} turns after round 1` : `of ${uBench} fights${entry.uRead === 'byRound2' ? ' (by round 2)' : ''}`;
        U = { pass: ok, value: pct(rate), reason: `${entry.uRule} (${entry.uSource}): ${pct(rate)} ${of}, counting ${entry.uIds.join(', ')}${partial}${auto}` };
      }
      // D
      let D: Verdict;
      const dAgg = per[entry.dBench];
      if (!dAgg || dAgg.fights === 0) D = { pass: null, value: '-', reason: `${entry.dBench} not run` };
      else {
        const loop = engineLoop(cls, benchSetup(world, entry.dBench, cls, level));
        // Review R4: a cantrip loop is read on the cantrip rounds only (rounds 2-5 with no leveled
        // cast; leveled-spell damage left out), so spending slots can't carry D; a weapon loop on
        // all of rounds 2-5.
        const cantrip = loop.kind === 'cantrip';
        const sim = cantrip ? (dAgg.cantripRounds > 0 ? dAgg.cantripRoundDmg / dAgg.cantripRounds : 0) : dAgg.dummyDmg / dAgg.fights / D_WINDOW_ROUNDS;
        const reading = cantrip ? `cantrip reading: ${dAgg.cantripRounds} of ${dAgg.fights * D_WINDOW_ROUNDS} window rounds with no leveled cast, leveled-spell damage left out` : `weapon reading: every round 2-5 of ${dAgg.fights} fights`;
        const gated = level >= THRESHOLDS.aiUtilizationFromLevel;
        if (loop.total <= 0) D = { pass: false, value: 'n/a', reason: `no damaging loop the engine models (${loop.note})` };
        else if (cantrip && dAgg.cantripRounds === 0) D = { pass: gated ? false : null, value: 'n/a', reason: `every window round cast a leveled spell, so the cantrip loop wasn't played (${reading})` };
        else {
          const ratio = sim / loop.total;
          // W1 (w1-plan.md 4.1): a rider's share of the dummy damage, reported only (the Barbarian's
          // Rage Damage: D can't show whether it rages, since Reckless Attack is free on the dummy).
          const share = entry.dShare ? `; ${entry.dShare.label} share of the dummy damage rounds 2-5: ${pct(dAgg.dummyDmg > 0 ? dAgg.shareDmg / dAgg.dummyDmg : 0)} (reported; U, not D, carries the Rage check)` : '';
          D = {
            pass: gated ? ratio >= THRESHOLDS.aiUtilizationMin : null,
            value: ratio.toFixed(2),
            reason: `sim DPR ${sim.toFixed(2)} / loop ${loop.total.toFixed(2)} vs AC ${DUMMY_AC[level]} on ${entry.dBench} (${loop.note}; ${reading})${gated ? ` (min ${THRESHOLDS.aiUtilizationMin.toFixed(2)})` : ' (L1: reported)'}${share}`,
          };
        }
      }
      // F (Holm applied below)
      let F: Verdict = { pass: null, value: '-', reason: 'F arm not run' };
      let fP: number | null = null;
      let fDiff: number | null = null;
      if (o.f && per.party && !o.fLevels.includes(level)) F = { pass: null, value: '-', reason: `F runs at L${o.fLevels.join('/')} (the wave accept levels); L${level} reported without it` };
      else if (o.f && per.party) {
        if (rm.features.size === 0 && rm.spells.size === 0 && rm.riders.size === 0) F = { pass: false, value: 'n/a', reason: `nothing to remove: ${entry.core.map((c) => c.notModeled ?? `${c.label} not on the sheet`).join('; ')}` };
        // Review C0-BENCH-M1: a removed item never legal in the base arm means both arms played the
        // same fights; that is not a measured 0.0, so it reads n/a and stays out of the Holm family.
        else if (per.party.coreLegalTurns === 0) F = { pass: false, value: 'n/a', reason: `core never legal: removed ${rm.what.join(' + ')} was never a legal choice in ${per.party.fights} base-arm party fights, so the arms can't differ` };
        else {
          const d = pairedDiff(per.party.foe, per.party.foeRemoved);
          fP = d.p;
          fDiff = d.diff;
          pending.push({ idx: rows.length, level, p: d.p });
          const how = rm.riders.size > 0 ? ` (rider: the removed arm's template is compiled without ${[...rm.riders].join(', ')})` : '';
          F = { pass: null, value: `${d.diff >= 0 ? '+' : ''}${d.diff.toFixed(1)}`, reason: `removed ${rm.what.join(' + ')}${how}${rm.auto.length ? ` (automatic, not removable: ${rm.auto.join(', ')})` : ''}: foe HP removed ${d.diff.toFixed(1)} points lower without it (SE ${d.se.toFixed(2)}, n ${Math.min(per.party.foe.length, per.party.foeRemoved.length)} paired; legal on ${per.party.coreLegalTurns} base-arm turns)` };
        }
      }
      // W
      const pa = per.party;
      const W: Verdict = pa && pa.fights > 0 ? (() => {
        const ci = wilson(pa.wins, pa.fights);
        return { pass: null, value: pct(pa.wins / pa.fights), reason: `party win ${pct(pa.wins / pa.fights)} [${pct(ci.lo)}, ${pct(ci.hi)}]${PARTY_PROVISIONAL ? ' (party sizing provisional until Shane signs off, M13 g)' : ''}` };
      })() : { pass: null, value: '-', reason: 'party not run' };
      rows.push({ cls, level, perBench: per, H, U, D, F, W, errors, fP, fDiff });
    }
  }
  // Holm across classes, one family per level.
  for (const level of o.levels) {
    const fam = pending.filter((x) => x.level === level);
    const adj = holm(fam.map((x) => x.p));
    fam.forEach((x, i) => {
      const r = rows[x.idx]!;
      const ok = adj[i]! < THRESHOLDS.fAlpha && (r.fDiff ?? 0) >= THRESHOLDS.fMinEffectPoints;
      const F: Verdict = { pass: ok, value: r.F.value, reason: `${r.F.reason}; Holm p ${adj[i]!.toPrecision(3)} over ${fam.length} classes at L${level} (need < ${THRESHOLDS.fAlpha} and >= +${THRESHOLDS.fMinEffectPoints} points)` };
      rows[x.idx] = { ...r, F };
    });
  }
  // W flag: below half the class median at L1-5.
  for (const level of o.levels) {
    if (level > THRESHOLDS.wFlagBelowHalfMedianToLevel) continue;
    const ws = rows.filter((r) => r.level === level && r.perBench.party && r.perBench.party.fights > 0).map((r) => r.perBench.party!.wins / r.perBench.party!.fights);
    if (ws.length === 0) continue;
    const sorted = [...ws].sort((a, b) => a - b);
    const med = sorted.length % 2 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      if (r.level !== level || !r.perBench.party) continue;
      const w = r.perBench.party.wins / r.perBench.party.fights;
      if (w < med / 2) rows[i] = { ...r, W: { ...r.W, reason: `${r.W.reason}; FLAG: below half the L${level} class median (${pct(med)})` } };
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// The hand-computed book-DPR table (M13 a): the W1 classes at L5 against the L5 dummy (AC 15),
// every number from a PDF line (srd-raw.txt). `modeled` is the part the engine models today
// (tests check engineLoop equals it); `written` is the whole written loop.
//
// Common: standard array 15/14/13/12/10/8 (2802-2803); +2/+1 from the background, +2 at the L4
// ASI (4768) gives the primary 19 (+4); PB +3 at L5 (4778); to-hit = mod + PB (963-967) = +7; vs
// AC 15 a hit needs a natural 8+, a natural 20 always hits and crits, a natural 1 misses (991-994);
// a crit rolls the damage dice twice (2205-2211).

export interface BookDpr {
  readonly cls: PickClass;
  readonly level: 5;
  readonly ac: 15;
  readonly loop: string;
  readonly modeled: number;
  readonly written: number;
  readonly cites: readonly string[];
  readonly gap: string;
}

/** Per attack at +7 vs AC 15 with dice D and modifier 4: 12/20 x (E[D] + 4) + 1/20 x (2 E[D] + 4). */
const ev7 = (die: number, critFaces = 1): number => ((13 - critFaces) / 20) * (die + 4) + (critFaces / 20) * (2 * die + 4);

/** The sum of `n` d`faces` as a pmf: index i is P(sum = n + i). */
function dicePmf(n: number, faces: number): number[] {
  let p = [1];
  for (let k = 0; k < n; k++) {
    const q = new Array<number>(p.length + faces - 1).fill(0);
    for (let i = 0; i < p.length; i++) for (let f = 0; f < faces; f++) q[i + f]! += p[i]! / faces;
    p = q;
  }
  return p;
}

/** E[sum of n d`faces`]. */
export const diceMean = (n: number, faces: number): number => dicePmf(n, faces).reduce((a, pi, i) => a + (n + i) * pi, 0);

/** E[the better of two rolls of n d`faces`], exact (Savage Attacker: "roll the weapon's damage dice twice and use either roll"). */
export function bestOfTwoMean(n: number, faces: number): number {
  const p = dicePmf(n, faces);
  let cdf = 0;
  let e = 0;
  for (let i = 0; i < p.length; i++) {
    const below = cdf;
    cdf += p[i]!;
    e += (n + i) * (cdf * cdf - below * below);
  }
  return e;
}

/**
 * Savage Attacker's term per turn (review R1; srd-raw.txt:20063-20069: once per turn, on a weapon
 * hit, roll the weapon's damage dice twice and use either roll). It rides the first hit of the
 * turn's `attacks` attacks at +7 vs AC 15 with a 1d`faces` weapon: attack k is the first hit with
 * probability (1 - pHit)^(k-1). On a normal hit the gain is E[best of two 1dX] - E[1dX]; on a
 * crit [U] the crit's doubled dice (2205-2211) are what is rolled twice: E[best of two 2dX] - E[2dX].
 */
export function savageAttackerEv(faces: number, attacks: number, critFaces = 1): number {
  const pCrit = critFaces / 20;
  const pNormal = (13 - critFaces) / 20;
  const gain = pNormal * (bestOfTwoMean(1, faces) - diceMean(1, faces)) + pCrit * (bestOfTwoMean(2, faces) - diceMean(2, faces));
  let firstHit = 0;
  for (let k = 0; k < attacks; k++) firstHit += (1 - pNormal - pCrit) ** k;
  return firstHit * gain;
}

export const BOOK_DPR: readonly BookDpr[] = [
  {
    cls: 'barbarian',
    level: 5,
    ac: 15,
    loop: 'raging, Reckless Attack off: Greataxe 1d12+4 twice (Extra Attack), +2 Rage Damage per hit, Savage Attacker on the first hit (Soldier)',
    // W1: Rage Damage is modeled (written minus Savage Attacker): +2 on each of two hits at 13/20.
    modeled: 2 * ev7(6.5) + 2 * (13 / 20) * 2,
    written: 2 * ev7(6.5) + 2 * (13 / 20) * 2 + savageAttackerEv(12, 2),
    cites: ['Greataxe 1d12 Slashing, Heavy, Two-Handed: srd-raw.txt:20690', 'Extra Attack (Barbarian, level 5): 5060-5063', 'Rage Damage: 4972-4977; +2 at level 5: 4784', 'Soldier: Feat: Savage Attacker: 19489, 19494', 'Savage Attacker: 20063-20069'],
    gap: 'Savage Attacker (narrative feat)',
  },
  {
    cls: 'fighter',
    level: 5,
    ac: 15,
    loop: 'Longsword one-handed (Shield) 1d8+4 twice (Extra Attack), Champion crits on 19-20, Savage Attacker on the first hit (Soldier)',
    modeled: 2 * ev7(4.5, 2),
    written: 2 * ev7(4.5, 2) + savageAttackerEv(8, 2, 2),
    cites: ['Longsword 1d8 Slashing, Versatile (1d10): srd-raw.txt:20738', 'Extra Attack (Fighter, level 5): 10654-10657', 'Improved Critical: 10711-10715', 'Soldier: Feat: Savage Attacker: 19489, 19494', 'Savage Attacker: 20063-20069'],
    gap: 'Savage Attacker (narrative feat)',
  },
  {
    cls: 'monk',
    level: 5,
    ac: 15,
    loop: 'Shortsword with the Martial Arts die 1d8+4 twice (Extra Attack) + Flurry of Blows, two Unarmed Strikes 1d8+4 (1 Focus Point a round; 5 at L5)',
    modeled: 4 * ev7(4.5),
    written: 4 * ev7(4.5),
    cites: ['Shortsword 1d6 Piercing, Finesse, Light: srd-raw.txt:20810', 'Monk weapons and Martial Arts die: 11071-11095', 'Martial Arts die 1d8 at level 5: 10885', 'Extra Attack at Monk 5: 10883, 11196-11199', 'Flurry of Blows: 11126-11127', 'Focus Points = Monk level: 11112-11115, 5 at level 5: 10887'],
    gap: 'none (if the engine rolls the Martial Arts die for the Shortsword)',
  },
  {
    cls: 'rogue',
    level: 5,
    ac: 15,
    loop: 'Steady Aim (Advantage), Rapier 1d8+4 with Sneak Attack 3d6 on the hit',
    // W1: Steady Aim and Sneak Attack are modeled, so the engine's loop is the whole written loop.
    modeled: (1 - (7 / 20) ** 2 - (1 - (19 / 20) ** 2)) * (4.5 + 4 + 10.5) + (1 - (19 / 20) ** 2) * (9 + 4 + 21),
    written: (1 - (7 / 20) ** 2 - (1 - (19 / 20) ** 2)) * (4.5 + 4 + 10.5) + (1 - (19 / 20) ** 2) * (9 + 4 + 21),
    cites: ['Rapier 1d8 Piercing, Finesse: srd-raw.txt:20786', 'Sneak Attack: 13736-13747; 3d6 at level 5: 13616', 'Steady Aim: 13788-13793'],
    gap: 'none',
  },
];

// ---------------------------------------------------------------------------------------------
// Report.

const pad = (s: string | number, n: number): string => String(s).padEnd(n);
const mark = (v: Verdict): string => (v.pass === null ? `(${v.value})` : v.pass ? `pass ${v.value}` : `FAIL ${v.value}`);

/** Coverage step 7.3: casts per fight of each reported spell the row's PC holds. Reported only; no threshold reads it. */
export function renderSpellCasts(world: BenchWorld, o: BenchOptions, rows: readonly BenchRow[]): string[] {
  const out = ['Casts per fight of the step 7 spells (reported, no threshold; a row is listed if its PC holds the spell):'];
  for (const r of rows) {
    for (const b of o.benches) {
      const a = r.perBench[b];
      if (!a || a.fights === 0) continue;
      const seats = benchSetup(world, b, r.cls, r.level).seats;
      const tpl = seats.find((x) => x.seat === 'pc1')!.tpl;
      const bits = REPORTED_SPELLS.flatMap((id, i) => (tpl.spells.some((e) => e.spell.id === id) ? [`${id.slice(4)} ${((a.spellCasts[i] ?? 0) / a.fights).toFixed(2)}`] : []));
      if (bits.length) out.push(`  ${r.cls} ${r.level} ${b}: ${bits.join(', ')}`);
    }
  }
  return out;
}

export function renderBench(world: BenchWorld, o: BenchOptions, rows: readonly BenchRow[]): string {
  const out: string[] = [];
  out.push(`bench-classes: ${o.classes.length} classes x levels ${o.levels.join(', ')}, benches ${o.benches.join(', ')}; n ${o.benches.map((b) => `${b} ${o.n[b]}`).join(', ')}${o.f ? ` (+ the F arm at L${o.fLevels.join('/')}, party, n ${o.n.party} paired; party rows with no F arm run ${Math.min(o.n.party, o.partyWOnly)})` : ''}`);
  out.push(`seeds: ${o.benches.map((b) => `${b} ${BENCH_SEED[b]}`).join(', ')}; greedy everywhere but the dummies (a pass-only decider); maxRounds dummy-melee 5, party 15, others 10`);
  out.push(`thresholds (frozen in tools/class-picks.ts before any result was read): Dodge <= ${pct(THRESHOLDS.dodgeShareMax)}, stalemates <= ${pct(THRESHOLDS.stalemateShareMax)} (duel, party), never-acts ${THRESHOLDS.neverActsMax}, items/fight <= ${THRESHOLDS.itemDecisionsPerFightMax}; D >= ${THRESHOLDS.aiUtilizationMin} from L${THRESHOLDS.aiUtilizationFromLevel}; F n ${THRESHOLDS.fN}, >= +${THRESHOLDS.fMinEffectPoints} points, Holm at ${THRESHOLDS.fAlpha}`);
  out.push('');
  out.push('Scenarios:');
  out.push(`  dummy-melee: test:bench-dummy-acN 5 ft away, AC ${o.levels.map((l) => `L${l} ${DUMMY_AC[l]}`).join(', ')} [U: a convention]`);
  out.push('  dummy-range: the same dummy 60 ft away plus test:bench-archer 60 ft away (1 piercing per hit, AC 25, immune to all damage)');
  for (const l of o.levels) {
    const d = crOf(world, DUEL_MONSTER[l]!);
    out.push(`  duel L${l}: ${DUEL_MONSTER[l]} CR ${d.cr} (${d.xp} XP) within the one-character low budget ${XP_BUDGET[l]!.low} (${XP_BUDGET[l]!.cite}); sanity CR <= level: ${d.crValue <= l ? 'yes' : 'NO'}`);
  }
  for (const l of o.levels) {
    const g = PARTY_GROUP[l]!;
    const xp = g.reduce((a, m) => a + crOf(world, m).xp, 0);
    out.push(`  party L${l}: ${g.map((m) => m.slice(4)).join(' + ')} = ${xp} XP of the moderate budget ${4 * XP_BUDGET[l]!.moderate} (4 x ${XP_BUDGET[l]!.moderate}, ${XP_BUDGET[l]!.cite})${PARTY_PROVISIONAL ? ' PROVISIONAL (coverage.md M13 g proposal awaits Shane)' : ''}`);
  }
  out.push(`  party allies: ${partyAllies('-').join(', ')} (Rogue swaps in for the class under test), curated builds of the same level`);
  out.push('');
  out.push(`${pad('class', 10)} ${pad('lvl', 3)}  ${pad('H', 26)} ${pad('U', 14)} ${pad('D', 12)} ${pad('F', 12)} ${pad('W', 8)}`);
  for (const r of rows) {
    const h = r.H.pass ? 'pass' : 'FAIL';
    out.push(`${pad(r.cls, 10)} ${pad(r.level, 3)}  ${pad(h, 26)} ${pad(mark(r.U), 14)} ${pad(mark(r.D), 12)} ${pad(mark(r.F), 12)} ${pad(r.W.value, 8)}`);
  }
  out.push('');
  out.push(...renderSpellCasts(world, o, rows));
  out.push('');
  out.push('Reasons (H, U, D, F, W per row):');
  for (const r of rows) {
    out.push(`${r.cls} ${r.level}:`);
    out.push(`  H ${r.H.pass ? 'pass' : 'FAIL'}: ${r.H.reason} (Dodge: ${r.H.value})`);
    out.push(`  U ${r.U.pass === null ? '-' : r.U.pass ? 'pass' : 'FAIL'}: ${r.U.reason}`);
    out.push(`  D ${r.D.pass === null ? '-' : r.D.pass ? 'pass' : 'FAIL'}: ${r.D.reason}`);
    out.push(`  F ${r.F.pass === null ? '-' : r.F.pass ? 'pass' : 'FAIL'}: ${r.F.reason}`);
    out.push(`  W: ${r.W.reason}`);
    const bits: string[] = [];
    for (const b of o.benches) {
      const a = r.perBench[b];
      if (!a || a.fights === 0) continue;
      const first = a.firstDamageN > 0 ? (a.firstDamageSum / a.firstDamageN).toFixed(2) : '-';
      bits.push(`${b} W/L/S ${a.wins}/${a.losses}/${a.stalemates}${a.stalemates ? ` (${causeText(a.causes)})` : ''}${b.startsWith('dummy') ? ` first dmg round ${first} (${a.firstDamageN}/${a.fights})` : ''}`);
    }
    out.push(`  ${bits.join('; ')}`);
    for (const e of r.errors) out.push(`  ERROR ${e}`);
  }
  out.push('');
  out.push('Book DPR (hand-computed, W1 classes at L5 vs AC 15; M13 a):');
  for (const b of BOOK_DPR) out.push(`  ${pad(b.cls, 10)} written ${b.written.toFixed(3)}, engine-modeled part ${b.modeled.toFixed(3)}: ${b.loop}. Gap: ${b.gap}. Cites: ${b.cites.join('; ')}`);
  out.push('');
  const builds = o.classes.map((c) => `${c}: ${CURATED[c].note}`);
  out.push(`Curated builds (tools/class-picks.ts): ${builds.join('; ')}`);
  const tot = rows.reduce((a, r) => ({ h: a.h + (r.H.pass ? 1 : 0), u: a.u + (r.U.pass ? 1 : 0), d: a.d + (r.D.pass ? 1 : 0), f: a.f + (r.F.pass ? 1 : 0), e: a.e + r.errors.length }), { h: 0, u: 0, d: 0, f: 0, e: 0 });
  out.push(`passing rows: H ${tot.h}/${rows.length}, U ${tot.u}/${rows.length}, D ${tot.d}/${rows.length}, F ${tot.f}/${rows.length}; errors ${tot.e}`);
  out.push(`stalemate causes (the engine's, sim/state.ts stalemateCauseOf; every kind counts for H): ${BENCH_CAUSES.join(', ')} (dodge-loop: a PC still up on a trailing streak of ${THRESHOLDS.dodgeStreak}+ Dodged turns; downed-*: a party member left at 0 HP, split by whether an up party member still holds a heal (heals-spent: none does; fell-too-late: none of those has had a turn since the fall; rescue-missed: one has); no-damage: none either way in the last ${THRESHOLDS.noDamageRoundsK} rounds)`);
  return `${out.join('\n')}\n`;
}

/** Plain data for --json. */
export function benchJson(rows: readonly BenchRow[]): unknown {
  return rows.map((r) => ({
    cls: r.cls,
    level: r.level,
    H: r.H,
    U: r.U,
    D: r.D,
    F: r.F,
    W: r.W,
    errors: r.errors,
    benches: Object.fromEntries(Object.entries(r.perBench).map(([b, a]) => [b, { fights: a.fights, wins: a.wins, losses: a.losses, stalemates: a.stalemates, causes: a.causes, turnsUp: a.turnsUp, dodges: a.dodges, attacks: a.attacks, casts: a.casts, items: a.items, coreUsed: a.coreUsed, turnsAfterR1: a.turnsAfterR1, upTurnsAfterR1: a.upTurnsAfterR1, crits: a.crits, hitTurns: a.hitTurns, cantripRounds: a.cantripRounds, spellCasts: a.spellCasts, qualTurns: a.qualTurns, qualTaken: a.qualTaken, hitTurnsAll: a.hitTurnsAll, shareDmg: a.shareDmg }])),
  }));
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { procs: { type: 'string' }, out: { type: 'string' }, json: { type: 'string' }, quick: { type: 'boolean' }, class: { type: 'string' }, level: { type: 'string' } },
    strict: true,
  });
  let o: BenchOptions = values.quick ? QUICK : FULL;
  if (values.class) {
    const cs = values.class.split(',') as PickClass[];
    for (const c of cs) if (!PICK_CLASSES.includes(c)) throw new Error(`--class: unknown class ${c}`);
    o = { ...o, classes: cs };
  }
  if (values.level) {
    const ls = values.level.split(',').map(Number);
    for (const l of ls) if (!(PICK_LEVELS as readonly number[]).includes(l)) throw new Error(`--level: ${l} isn't one of ${PICK_LEVELS.join(', ')}`);
    o = { ...o, levels: ls };
  }
  const procs = values.procs ? Number(values.procs) : availableParallelism();
  const world = benchWorld();
  const tasks = planTasks(o);
  const results = procs <= 1 ? runInProcess(world, tasks) : await runOnWorkers(tasks, procs);
  const rows = evaluate(world, o, results);
  const text = renderBench(world, o, rows);
  if (values.out) writeFileSync(values.out, text);
  if (values.json) writeFileSync(values.json, `${JSON.stringify(benchJson(rows), null, 1)}\n`);
  process.stdout.write(text);
  process.exitCode = rows.some((r) => r.errors.length > 0) ? 1 : 0;
}

if (import.meta.main) await main();
