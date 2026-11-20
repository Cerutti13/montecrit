// The Monte Carlo report (docs/design/m1c.md 5): statistics over merged arms, then a text
// rendering. Pure: (arms, merged, meta) -> numbers -> lines, so the same runs print the same
// report whatever produced them (one process or one per arm). Formulas live in stats.ts and
// boot.ts; this file decides what is printed and with which denominators (the defs line says).
//
// Every win/loss/PC rate has a Wilson CI over all runs (stalemates included). Arms are compared
// with the paired Newcombe interval, exact McNemar and Holm, printed as 95% per comparison. Ratio
// statistics (DPR, uptime, damage per PC turn) get a percentile bootstrap that shares its index
// vectors across arms, so their paired differences are descriptive bootstrap CIs.

import { losNote } from '../sim/cover.ts';
import { DEFAULT_WEIGHTS, GREEDY_VERSION, weightsHash } from '../decide/greedy/weights.ts';
import { ANCHORS } from '../decide/greedy/value.ts';
import { playsSeat } from '../decide/policy.ts';
import { FLAG_INFO, FLAG_KEYS, type RuleFlags } from '../rules/flags.ts';
import { buildCounterLayout, MAX_POOLS, pickFamilyNames, type CounterLayout } from '../sim/counters.ts';
import type { FightSetup } from '../sim/setup.ts';
import { STALEMATE_CAUSES, STALEMATE_DODGE_STREAK, STALEMATE_NO_DAMAGE_ROUNDS } from '../sim/state.ts';
import { ENGINE_VERSION } from '../version.ts';
import { bootstrapRatios, diffReps, percentileCI } from './boot.ts';
import { allySeats, pcSeats, reportModel, type ReportModel } from './model.ts';
import { DEATH_CAUSES, exemplars, pairCounts, type ArmSpec, type Exemplars, type Merged } from './runner.ts';
import { holm, mcnemarExact, nearestRank, newcombePaired, P_FLOOR, ratio, wilson } from './stats.ts';

export interface ReportMeta {
  readonly seed: number;
  /** The command that replays one of these runs, before --run and --policy: the scenario's path and every flag and knob override. */
  readonly replay: string;
  /** Where the scenario file came from, when it's outside the repo or extends another. */
  readonly fileNote: string | null;
  readonly adaptive: boolean;
  readonly checkpoint: number | null;
  readonly hitCap: boolean;
  readonly untilCi: number;
  readonly pairs: 'ref' | 'all';
  readonly verbose: boolean;
}

export interface Rate {
  readonly x: number;
  readonly n: number;
  readonly p: number;
  readonly lo: number;
  readonly hi: number;
}

export interface Estimate {
  readonly value: number;
  readonly lo: number;
  readonly hi: number;
}

export interface ArmStats {
  readonly label: string;
  readonly n: number;
  readonly win: Rate;
  readonly loss: Rate;
  readonly stalemate: Rate;
  readonly tpk: Rate;
  readonly allPcsDown: Rate;
  readonly pcDrop: Rate;
  readonly pcDied: Rate;
  readonly winPcDown: Rate;
  /** Wins among decisive fights, when stalemates pass 1% (conditional; never paired). */
  readonly decisive: Rate | null;
  /** Stalemates by cause (STALEMATE_CAUSES order); absent with none. */
  readonly stalemateBy?: readonly number[];
  /** Runs where some PC died, by cause (DEATH_CAUSES order); a run counts once per cause. */
  readonly pcDeaths: readonly number[];
  readonly allyDied: readonly { readonly seat: string; readonly rate: Rate }[];
  readonly rounds: { readonly mean: number; readonly p10: number; readonly p50: number; readonly p90: number };
  readonly dprPc: Estimate;
  readonly dprParty: Estimate;
  /** PC damage per PC turn taken while up (critique resolution 10). */
  readonly pcPerTurn: Estimate;
  readonly dprPerFight: { readonly p10: number; readonly p50: number; readonly p90: number };
  /** PC turns that started up with concentration live, over PC turns that started up. */
  readonly uptime: Estimate;
  readonly exemplars: Exemplars;
}

export interface PairStats {
  /** Arm indices: `other` minus `ref`. */
  readonly ref: number;
  readonly other: number;
  /** a both win, b only other, c only ref, d neither. */
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly diff: number;
  readonly lo: number;
  readonly hi: number;
  readonly p: number;
  readonly holm: number;
  /** Paired bootstrap of the PC DPR difference (descriptive, not adjusted). */
  readonly dprDiff: Estimate;
}

export interface ReportStats {
  readonly arms: readonly ArmStats[];
  readonly pairs: readonly PairStats[];
}

const rate = (x: number, n: number): Rate => {
  const w = wilson(x, n);
  return { x, n, p: ratio(x, n), lo: w.lo, hi: w.hi };
};

function sumOver(n: number, f: (i: number) => number): number {
  let s = 0;
  for (let i = 0; i < n; i++) s += f(i);
  return s;
}


/** Every number the report prints. Bootstraps over all arms at once, so their replicates pair. */
export function computeReport(arms: readonly ArmSpec[], merged: Merged, meta: ReportMeta): ReportStats {
  const accs = merged.arms;
  const n = merged.n;
  const series = accs.flatMap((a) => [
    { num: a.Dpc, den: a.R },
    { num: a.Dparty, den: a.R },
    { num: a.Dpc, den: a.turnsPc },
    { num: a.concT, den: a.turnsPc },
  ]);
  const reps = n > 0 ? bootstrapRatios(meta.seed, series) : series.map(() => new Float64Array(0));
  const est = (num: ArrayLike<number>, den: ArrayLike<number>, r: Float64Array): Estimate => {
    const ci = percentileCI(r);
    return { value: ratio(sumOver(num.length, (i) => num[i]!), sumOver(den.length, (i) => den[i]!)), lo: ci.lo, hi: ci.hi };
  };
  const stats = accs.map((a, k): ArmStats => {
    const setup = arms[k]!.setup;
    const pcs = pcSeats(setup);
    const pcDeaths = DEATH_CAUSES.map((_, c) => a.pcDeathRuns[c]!);
    const R = a.R.slice().sort();
    const per = Float64Array.from(a.Dpc, (d, i) => ratio(d, a.R[i]!)).sort();
    const decisive = a.stalemate > 0.01 * a.n ? rate(a.win, a.win + a.loss) : null;
    return {
      label: a.label,
      n: a.n,
      win: rate(a.win, a.n),
      loss: rate(a.loss, a.n),
      stalemate: rate(a.stalemate, a.n),
      tpk: rate(a.tpk, a.n),
      allPcsDown: rate(a.allPcsDown, a.n),
      pcDrop: rate(a.pcDrop, a.n),
      pcDied: rate(a.pcDied, a.n),
      winPcDown: rate(a.winPcDown, a.n),
      decisive,
      ...(a.stalemateBy ? { stalemateBy: a.stalemateBy } : {}),
      pcDeaths,
      allyDied: allySeats(setup).map((u) => ({ seat: setup.seats[u]!.seat, rate: rate(sumOver(DEATH_CAUSES.length, (c) => a.deathRuns[u * DEATH_CAUSES.length + c]!), a.n) })),
      rounds: { mean: ratio(a.sumR, a.n), p10: nearestRank(R, 10), p50: nearestRank(R, 50), p90: nearestRank(R, 90) },
      dprPc: est(a.Dpc, a.R, reps[k * 4]!),
      dprParty: est(a.Dparty, a.R, reps[k * 4 + 1]!),
      pcPerTurn: est(a.Dpc, a.turnsPc, reps[k * 4 + 2]!),
      dprPerFight: { p10: nearestRank(per, 10), p50: nearestRank(per, 50), p90: nearestRank(per, 90) },
      uptime: est(a.concT, a.turnsPc, reps[k * 4 + 3]!),
      exemplars: exemplars(a),
    };
  });
  const comps: [number, number][] = [];
  if (meta.pairs === 'all') for (let i = 0; i < accs.length; i++) for (let j = i + 1; j < accs.length; j++) comps.push([i, j]);
  else for (let j = 1; j < accs.length; j++) comps.push([0, j]);
  const raw = comps.map(([i, j]) => {
    const t = pairCounts(accs[j]!, accs[i]!);
    const nc = newcombePaired(t.a, t.b, t.c, t.d);
    const dd = percentileCI(diffReps(reps[j * 4]!, reps[i * 4]!));
    return { ref: i, other: j, ...t, diff: nc.diff, lo: nc.lo, hi: nc.hi, p: mcnemarExact(t.b, t.c), dprDiff: { value: stats[j]!.dprPc.value - stats[i]!.dprPc.value, lo: dd.lo, hi: dd.hi } };
  });
  const adj = holm(raw.map((r) => r.p));
  return { arms: stats, pairs: raw.map((r, k) => ({ ...r, holm: adj[k]! })) };
}

// Formatting. toFixed and toExponential are exactly specified, so the text is too.
const pct = (p: number) => `${(100 * p).toFixed(1)}%`;
const ci = (lo: number, hi: number, scale = 100, d = 1) => `[${(scale * lo).toFixed(d)}, ${(scale * hi).toFixed(d)}]`;
const pp = (x: number) => `${x >= 0 ? '+' : ''}${(100 * x).toFixed(1)}`;
const sgn = (x: number, d = 2) => `${x >= 0 ? '+' : ''}${x.toFixed(d)}`;
const pval = (p: number) => (p < P_FLOOR ? '<1e-300' : p < 0.001 ? p.toExponential(1) : p.toFixed(3));
const fx = (x: number, d = 2) => x.toFixed(d);
function int(x: number): string {
  const s = String(Math.round(x));
  let out = '';
  for (let i = 0; i < s.length; i++) out += (i > 0 && (s.length - i) % 3 === 0 && s[i - 1] !== '-' ? ',' : '') + s[i];
  return out;
}
/** The text's number formats, for the browser's Results screen (docs/design/m2.md 5.1): one wording, one rounding. */
export const fmt = { pct, ci, pp, pval, fx, int } as const;
const CAUSE_NAMES = ['at 0 HP', 'massive damage', 'death saves'] as const satisfies { length: (typeof DEATH_CAUSES)['length'] };
const rateCi = (r: Rate) => `${pct(r.p)} ${ci(r.lo, r.hi)}`;
const est = (e: Estimate, d = 2) => `${fx(e.value, d)} ${ci(e.lo, e.hi, 1, d)}`;

/** Wraps `items` after `head` at about `width` columns, continuation lines indented. */
function wrap(head: string, items: readonly string[], width = 110): string[] {
  const lines: string[] = [];
  let line = head;
  for (const it of items) {
    if (line.length + 1 + it.length > width && line.trim() !== head.trim()) {
      lines.push(line);
      line = ' '.repeat(head.length) + it;
    } else line += (line.endsWith(' ') ? '' : ' ') + it;
  }
  lines.push(line);
  return lines;
}

function flagList(flags: RuleFlags, used: Uint8Array): string[] {
  const out: string[] = [];
  FLAG_KEYS.forEach((k, i) => {
    if (used[i]) out.push(`${k}=${String(flags[k])}${FLAG_INFO[k].verified ? '' : '*'}`);
  });
  return out;
}

function armDeciders(spec: ArmSpec): string[] {
  return spec.setup.seats.map((s, i) => (spec.policy && playsSeat(spec.policy, spec.setup, i) ? `<${spec.label}>` : s.decider === 'journal' ? `journal>${s.fallback ?? 'none'}` : s.decider));
}

/** The report text (docs/design/m1c.md 5.2); its tables come from reportModel (docs/design/m2.md 5.1). */
export function renderReport(arms: readonly ArmSpec[], merged: Merged, meta: ReportMeta, stats: ReportStats = computeReport(arms, merged, meta), model: ReportModel = reportModel(arms, merged)): string[] {
  const ref = arms[0]!;
  const setup = ref.setup;
  const n = merged.n;
  const layout: CounterLayout = buildCounterLayout(setup);
  const accs = merged.arms;
  const pcs = pcSeats(setup);
  const L: string[] = [];
  const label = (k: number) => accs[k]!.label;
  const width = Math.max(10, ...accs.map((a) => a.label.length)) + 2;
  const col = (k: number) => label(k).padEnd(width);

  // Header: what the numbers rest on.
  const mode = meta.adaptive ? `adaptive: ${meta.hitCap ? `hit the cap before ±${pct(meta.untilCi)}` : `stopped at checkpoint ${meta.checkpoint} (every arm's win CI within ±${pct(meta.untilCi)})`}` : 'fixed';
  L.push(`montecrit ${ENGINE_VERSION} | content ${setup.contentHash} | scenario ${setup.scenario} ${setup.scenarioHash} | seed ${meta.seed} | n ${int(n)} (${mode}) | chunks ${merged.nextChunk}x${merged.chunkSize}`);
  L.push(...wrap('arms     ', arms.map((a, k) => `${a.label}${a.policy && a.policy.id !== a.label ? ` (${a.policy.id})` : ''}${a.policy && a.policy.script.length + a.policy.hold.length + a.policy.riders.length > 0 ? `@${a.policy.hash}` : ''}${k === 0 ? ' [reference]' : ''}`)));
  const dec = armDeciders(ref);
  const groups: { label: string; seats: string[] }[] = [];
  dec.forEach((d, i) => {
    const g = groups.find((x) => x.label === d);
    if (g) g.seats.push(setup.seats[i]!.seat);
    else groups.push({ label: d, seats: [setup.seats[i]!.seat] });
  });
  L.push(...wrap('seats    ', groups.map((g, i) => `${g.seats.join(' ')} ${g.label.startsWith('<') ? 'the arm' : g.label}${i < groups.length - 1 ? ' |' : ''}`)));
  if (arms.some((a) => a.setup.seats.some((s) => s.decider === 'greedy') || a.policy?.base === 'greedy')) {
    L.push(`ai       greedy v${GREEDY_VERSION}: one ply per decision, horizon ${DEFAULT_WEIGHTS.horizon} rounds, gamma ${DEFAULT_WEIGHTS.gamma}, ${ANCHORS} zone anchors, simultaneous triggers in engine order (not scored); default weights ${weightsHash(DEFAULT_WEIGHTS)}${arms.some((a) => a.policy && weightsHash(a.policy.weights) !== weightsHash(DEFAULT_WEIGHTS)) ? `; overridden in ${arms.filter((a) => a.policy && weightsHash(a.policy.weights) !== weightsHash(DEFAULT_WEIGHTS)).map((a) => `${a.label} (${weightsHash(a.policy!.weights)})`).join(', ')}` : ''}`);
  }
  const scripts: string[] = [];
  arms.forEach((a, k) => {
    a.policy?.script.forEach((r, j) => {
      const s = accs[k]!.script;
      scripts.push(`${a.label} ${r.id}: taken ${pct(ratio(s[j * 3]!, n))} of fights, retired ${pct(ratio(s[j * 3 + 2]!, n))}, ${fx(ratio(s[j * 3 + 1]!, n))} retries/fight`);
    });
  });
  if (scripts.length) L.push(...wrap('script   ', scripts.map((x, i) => (i < scripts.length - 1 ? `${x};` : x))));
  const k0 = setup.knobs;
  L.push(`knobs    maxRounds=${k0.maxRounds} attackDowned=${k0.attackDowned} lossCounts=${k0.lossCounts} downEnds=${k0.downEnds}`);
  const who = k0.lossCounts === 'pcs' ? 'PC' : 'party member';
  L.push(
    ...wrap('defs     ', [
      'win = no enemy up;',
      `loss = every ${who} ${k0.downEnds ? 'down or dead' : 'dead or stable'};`,
      `stalemate = round ${k0.maxRounds} ends;`,
      'TPK = every party member dead;',
      'rates are over all runs, stalemates included;',
      'damage = HP and temp HP removed from the other side (overkill clamped); damage to its own side (itself included) is friendly fire, shown on its own rows;',
      'DPR = total damage / total rounds (a stalemate counts every round);',
      'PC per fight = each fight\'s PC damage / its rounds, quantiles over fights;',
      'per PC turn = PC damage / PC turns that started up;',
      'uptime = PC turns that started up concentrating / PC turns that started up;',
      'all PCs out = every PC dead, dying or stable when the fight ends;',
      'win with PC down = wins where a PC dropped at least once;',
      `PC deaths by cause count runs where some PC died that way;`,
      'per-fight figures (resources, picks, concentration, retries) are means over all runs',
    ]),
  );
  const read = new Uint8Array(FLAG_KEYS.length);
  const ai = new Uint8Array(FLAG_KEYS.length);
  for (const a of accs) {
    for (let i = 0; i < read.length; i++) {
      read[i] = read[i]! | a.flagsRead[i]!;
      ai[i] = ai[i]! | a.aiFlags[i]!;
    }
  }
  L.push('flags read by the fights (union over arms; * = unverified):', ...wrap('  ', flagList(setup.flags, read)));
  L.push('flags consulted by the AI while deciding (union over arms; * = unverified):', ...wrap('  ', flagList(setup.flags, ai)));
  const notes: string[] = [losNote(setup)];
  if (meta.fileNote) notes.push(meta.fileNote);
  const cal = setup.calibrated;
  if (cal) {
    const stale = cal.engine !== ENGINE_VERSION || cal.weights !== weightsHash(DEFAULT_WEIGHTS) || cal.ai !== GREEDY_VERSION;
    const elsewhere = cal.scenarioHash !== setup.scenarioHash || cal.contentHash !== setup.contentHash;
    notes.push(
      `calibrated: engine ${cal.engine}, greedy v${cal.ai}, weights ${cal.weights}, ${cal.policy}, ${int(cal.runs)} runs at seed ${cal.seed}: win ${pct(cal.win)}${cal.note ? ` (${cal.note})` : ''}` +
        (stale ? ' -- STALE: the engine, the greedy AI or its default weights changed since' : '') +
        (elsewhere ? ` -- measured on a different setup (scenario ${cal.scenarioHash}, content ${cal.contentHash}), not this one` : ''),
    );
  } else notes.push('calibrated: no');
  // Coverage 8'b G5 (M6): the target priority the greedy seats played under, right under the calibration record.
  if (arms.some((a) => a.setup.seats.some((s) => s.decider === 'greedy') || a.policy?.base === 'greedy')) {
    const other = arms.filter((a) => a.policy?.base === 'greedy' && a.policy.weights.targetStyle !== DEFAULT_WEIGHTS.targetStyle);
    notes.push(`target priority: ${DEFAULT_WEIGHTS.targetStyle}${other.map((a) => `, ${a.policy!.weights.targetStyle} (arm ${a.label})`).join('')}`);
    // Coverage step 7.6: printed only where a stat block has such an action.
    if (setup.seats.some((s) => s.tpl.features.some((f) => f.activate?.book))) notes.push('monsters use limited high-damage abilities first (srd-raw.txt:43605-43612)');
  }
  for (const nt of setup.reportNotes ?? []) notes.push(nt);
  const ph = setup.seats.filter((s) => s.tpl.placeholder).map((s) => s.seat);
  notes.push(`placeholder stats: ${ph.length ? ph.join(', ') : 'none'}`);
  for (const s of setup.seats) {
    for (const p of s.precast ?? []) notes.push(`precast: ${s.seat} ${s.tpl.spells[p.entry]!.spell.name}${p.lvl > 0 ? ` (level ${p.lvl}${p.free ? ', free' : ''})` : ''}${p.elapsed ? `, ${p.elapsed} rounds elapsed` : ''}`);
  }
  if (setup.seats.some((s) => s.tpl.spells.length > 0 || s.tpl.features.length > 0)) notes.push('ending concentration or dismissing an effect: offered only on your own turn');
  const done: string[] = [];
  for (const s of setup.seats) {
    if (done.includes(s.tpl.id)) continue;
    done.push(s.tpl.id);
    if (s.tpl.fidelity !== 'full' || s.tpl.unimplemented.length) notes.push(`${s.tpl.id} ${s.tpl.fidelity}: unimplemented ${s.tpl.unimplemented.join('; ') || '(none listed)'}`);
    for (const e of s.tpl.spells) {
      const sp = e.spell;
      if (done.includes(sp.id)) continue;
      done.push(sp.id);
      if (sp.fidelity !== 'full' || sp.unimplemented.length) notes.push(`${sp.id} ${sp.fidelity}: unimplemented ${sp.unimplemented.join('; ') || '(none listed)'}`);
    }
  }
  for (const u of pcs) {
    const names = pickFamilyNames(layout, u);
    const chosen = (nm: string) => names.some((x, f) => x === nm && accs.some((a) => a.picks[layout.pickBase[u]! + f]! > 0));
    // An Escape is offered only while someone else's effect holds the unit: not a choice of its own kit.
    const never = names.filter((nm, f) => nm !== '' && f >= 5 && f !== layout.foreignOff[u] && names.indexOf(nm) === f && !chosen(nm));
    if (never.length) notes.push(`${setup.seats[u]!.seat} options never chosen: ${never.join(', ')}`);
  }
  for (const nt of notes) L.push(...wrap('notes    ', [nt]));

  // Outcomes.
  L.push('', `OUTCOMES (95% Wilson CIs, %)`);
  for (let k = 0; k < accs.length; k++) {
    const s = stats.arms[k]!;
    const pad = ' '.repeat(width);
    const deaths = DEATH_CAUSES.map((c, i) => `${CAUSE_NAMES[i]} ${rateCi(rate(s.pcDeaths[i]!, s.n))}`).join(', ');
    L.push(`  ${col(k)}win ${rateCi(s.win)}  loss ${rateCi(s.loss)}  stalemate ${rateCi(s.stalemate)}`);
    L.push(`  ${pad}TPK ${rateCi(s.tpk)}  all PCs out at end ${rateCi(s.allPcsDown)}  PC drops ${rateCi(s.pcDrop)}  win with PC down ${rateCi(s.winPcDown)}`);
    L.push(`  ${pad}PC dies ${rateCi(s.pcDied)}; by cause: ${deaths}`);
    if (s.allyDied.length) L.push(`  ${pad}${s.allyDied.map((x) => `${x.seat} dies ${rateCi(x.rate)}`).join('  ')}`);
    if (s.stalemateBy) L.push(`  ${pad}stalemates by cause: ${STALEMATE_CAUSES.map((c, i) => [c, s.stalemateBy![i]!] as const).filter((x) => x[1] > 0).map(([c, x]) => `${c} ${x}`).join(', ')} (dodge-loop: a PC's last ${STALEMATE_DODGE_STREAK}+ turns Dodged; downed-unrescued: a party member at 0 HP, not stable; no-damage: none in the last ${STALEMATE_NO_DAMAGE_ROUNDS} rounds)`);
    if (s.decisive) L.push(`  ${pad}decisive-only win ${rateCi(s.decisive)} (conditional on no stalemate; not paired)`);
  }

  if (stats.pairs.length) {
    const m = stats.pairs.length;
    L.push('', `PAIRED (other - reference, same runs; 95% per comparison, not simultaneous; Holm over ${m} comparison${m === 1 ? '' : 's'}${m > 10 ? '; EXPLORATORY' : ''})`);
    for (const p of stats.pairs) {
      L.push(`  ${label(p.other)} - ${label(p.ref)}`);
      L.push(`    win ${pp(p.diff)} pts ${ci(p.lo, p.hi)}  only ${label(p.other)} won ${int(p.b)}, only ${label(p.ref)} won ${int(p.c)}  McNemar p ${pval(p.p)}  Holm p ${pval(p.holm)} ${p.holm <= 0.05 ? 'SIG' : 'ns'}`);
      L.push(`    PC DPR ${sgn(p.dprDiff.value)} ${ci(p.dprDiff.lo, p.dprDiff.hi, 1, 2)} (paired bootstrap; descriptive, not adjusted)`);
    }
  }

  L.push('', 'ROUNDS');
  for (let k = 0; k < accs.length; k++) {
    const s = stats.arms[k]!.rounds;
    const h = model.arms[k]!.roundsHist;
    const bins: string[] = [];
    for (let r = 0; r < h.length; r++) if (h[r]! > 0) bins.push(`${r}:${int(h[r]!)}`);
    L.push(`  ${col(k)}mean ${fx(s.mean)}  p10/p50/p90 ${s.p10}/${s.p50}/${s.p90}  fights by length ${bins.join(' ')}`);
  }

  L.push('', 'DPR (effective; percentile bootstrap 95% CIs)');
  for (let k = 0; k < accs.length; k++) {
    const s = stats.arms[k]!;
    L.push(`  ${col(k)}PC ${est(s.dprPc)}  party ${est(s.dprParty)}  PC per PC turn ${est(s.pcPerTurn)}  PC per fight p10/p50/p90 ${fx(s.dprPerFight.p10)}/${fx(s.dprPerFight.p50)}/${fx(s.dprPerFight.p90)}`);
  }
  L.push(meta.verbose ? 'PC DPR HISTOGRAM (fights per 1 HP/round bin; 64+ is the last)' : 'PC DPR HISTOGRAM (% of fights per 5 HP/round; --verbose for 1 HP/round bins)');
  for (let k = 0; k < accs.length; k++) {
    const m = model.arms[k]!;
    const parts: string[] = [];
    if (meta.verbose) {
      for (const b of m.dprFine) if (b.count > 0) parts.push(`${b.hi === null ? '64+' : b.lo}:${int(b.count)}`);
    } else {
      for (const b of m.dprBins) if (b.count > 0) parts.push(`${b.hi === null ? '60+' : `${b.lo}-${b.hi}`}:${pct(b.share)}`);
    }
    L.push(...wrap(`  ${col(k)}`, parts));
  }

  // Damage per round: unconditional means (an ended fight counts 0), columns to the last round
  // at least 1% of fights reached, then the rest (rows and values: reportModel).
  const last = model.lastRound;
  const nameW = Math.max(16, ...model.damageRows.map((r) => r.label.length)) + 2;
  const cols = [...Array.from({ length: last }, (_, i) => `r${i + 1}`), 'later', 'total', 'rolled'];
  L.push('', 'DAMAGE PER ROUND (mean per fight, effective, to the other side unless marked friendly fire; a fight that ended counts 0; rolled = before the HP clamp)');
  for (let k = 0; k < accs.length; k++) {
    const m = model.arms[k]!;
    L.push(`  ${label(k).padEnd(nameW)}${cols.map((c) => c.padStart(7)).join('')}`);
    model.damageRows.forEach((row, j) => {
      const d = m.damage[j]!;
      L.push(`    ${row.label.padEnd(nameW - 2)}${[...d.perRound, d.later, d.total, d.rolled].map((v) => fx(v).padStart(7)).join('')}`);
    });
    L.push(`    ${'reached'.padEnd(nameW - 2)}${m.reached.map((x) => pct(x).padStart(7)).join('')}`);
  }

  L.push('', 'CONCENTRATION (PC)');
  for (let k = 0; k < accs.length; k++) {
    const m = model.arms[k]!;
    const ends = m.concEnds.map((e) => `${e.why} ${fx(e.perFight)}`);
    L.push(`  ${col(k)}uptime ${est(stats.arms[k]!.uptime, 3)}  starts ${fx(m.concStartsPerFight)}/fight  ends/fight: ${ends.join(', ') || 'none'}`);
  }

  const anyPre = setup.seats.some((s) => (s.precast ?? []).length > 0);
  L.push('', `RESOURCES (PC, per fight${anyPre ? ': in-fight | precast' : ''})`);
  for (let k = 0; k < accs.length; k++) {
    const a = accs[k]!;
    const parts: string[] = [];
    for (const u of pcs) {
      const t = setup.seats[u]!.tpl;
      for (let l = 0; l < 9; l++) if (t.resMax[l]! > 0) parts.push(`L${l + 1} ${fx(a.slots[u * 9 + l]! / Math.max(1, n))}${anyPre ? ` | ${fx(a.preSlots[u * 9 + l]! / Math.max(1, n))}` : ''}`);
      t.pools.forEach((p, i) => {
        if (i < MAX_POOLS) parts.push(`${p.name} ${fx(a.pools[u * MAX_POOLS + i]! / Math.max(1, n))}`);
      });
      parts.push(`free casts ${fx(a.freeCasts[u]! / Math.max(1, n))}`);
    }
    L.push(...wrap(`  ${col(k)}`, parts.map((p, i) => (i < parts.length - 1 ? `${p},` : p))));
  }

  L.push('', `OPTION PICKS (PC, chosen per fight${meta.verbose ? '' : '; top 8'})`);
  for (let k = 0; k < accs.length; k++) {
    const a = accs[k]!;
    const picks: { name: string; c: number }[] = [];
    for (const u of pcs) {
      const names = pickFamilyNames(layout, u);
      names.forEach((nm, f) => {
        const c = a.picks[layout.pickBase[u]! + f]!;
        if (c === 0 || nm === '') return;
        const same = picks.find((x) => x.name === nm); // one grant bound per cast level shares a name
        if (same) same.c += c;
        else picks.push({ name: nm, c });
      });
    }
    picks.sort((x, y) => y.c - x.c || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
    const shown = meta.verbose ? picks : picks.slice(0, 8);
    L.push(...wrap(`  ${col(k)}`, shown.map((p, i) => `${p.name} ${fx(p.c / Math.max(1, n))}${i < shown.length - 1 ? ',' : ''}`)));
  }

  L.push('', 'EXEMPLARS (run indices; replay one with the command below)');
  for (let k = 0; k < accs.length; k++) {
    const a = accs[k]!;
    const e = stats.arms[k]!.exemplars;
    const cl = e.closestLoss >= 0 ? `run ${e.closestLoss} (enemies ${a.foeHpLeft[e.closestLoss]}/${a.foeHpMax[e.closestLoss]} HP left, ${a.R[e.closestLoss]} rounds)` : 'none';
    const tw = e.typicalWin >= 0 ? `run ${e.typicalWin} (${a.R[e.typicalWin]} rounds, PC HP ${a.pcHpEnd[e.typicalWin]})` : 'none';
    L.push(`  ${col(k)}closest loss ${cl} | typical win ${tw} | TPK ${e.tpk >= 0 ? `run ${e.tpk}` : 'none'} | PC death ${e.pcDeath >= 0 ? `run ${e.pcDeath}` : 'none'}`);
  }
  for (let k = 0; k < accs.length; k++) {
    const e = stats.arms[k]!.exemplars;
    const r = e.closestLoss >= 0 ? e.closestLoss : e.typicalWin;
    if (r < 0) continue;
    const pol = arms[k]!.policy ? ` --policy ${arms[k]!.policy!.id}` : '';
    L.push(`replay   ${label(k)} ${e.closestLoss >= 0 ? 'closest loss' : 'typical win'}: ${meta.replay} --run ${r}${pol}`);
  }
  return L;
}
