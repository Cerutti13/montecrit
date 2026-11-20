// The report's tables as data (docs/design/m2.md 5.1): the rows renderReport used to compute
// inline for ROUNDS, the DPR histogram, DAMAGE PER ROUND and CONCENTRATION. renderReport formats
// these, and the browser's Results screen draws them, so neither re-derives a bin, a row or a
// mean. Same arithmetic in the same order as before, so the text is byte-identical.

import { FX_END_WHYS, type FxEndWhy } from '../log/events.ts';
import { buildCounterLayout, type CounterLayout } from '../sim/counters.ts';
import type { FightSetup } from '../sim/setup.ts';
import type { ArmAcc, ArmSpec, Merged } from './runner.ts';
import { ratio } from './stats.ts';

export interface DprBin {
  readonly lo: number;
  /** Inclusive upper edge; null for the open last bin. */
  readonly hi: number | null;
  readonly count: number;
  /** count / n (n at least 1). */
  readonly share: number;
}

/** A DAMAGE PER ROUND row: the PC's own sources, each ally and the enemies as one row each, then friendly fire per side that did any. */
export interface DamageRow {
  readonly label: string;
  readonly group: 'pc' | 'ally' | 'enemy' | 'ff';
}

/** One arm's values for one row: mean per fight, effective; a fight that ended counts 0. */
export interface DamageCells {
  /** Rounds 1..lastRound. */
  readonly perRound: readonly number[];
  /** Every later round, plus round 0 (precast). */
  readonly later: number;
  readonly total: number;
  /** Before the HP clamp. */
  readonly rolled: number;
}

export interface ArmModel {
  readonly label: string;
  /** [R]: fights that lasted R rounds. */
  readonly roundsHist: readonly number[];
  /** PC damage per round per fight, 5 HP/round bins (0-4 ... 60+). */
  readonly dprBins: readonly DprBin[];
  /** The same in 1 HP/round bins (0 ... 64+). */
  readonly dprFine: readonly DprBin[];
  /** Aligned with ReportModel.damageRows. */
  readonly damage: readonly DamageCells[];
  /** Share of fights that reached rounds 1..lastRound. */
  readonly reached: readonly number[];
  readonly concStartsPerFight: number;
  /** Concentration ends per fight by cause, causes with none left out (FX_END_WHYS order). */
  readonly concEnds: readonly { readonly why: FxEndWhy; readonly perFight: number }[];
}

export interface ReportModel {
  /** The last round at least 1% of fights reached (over every arm), at least 1. */
  readonly lastRound: number;
  readonly damageRows: readonly DamageRow[];
  readonly arms: readonly ArmModel[];
}

function sumOver(n: number, f: (i: number) => number): number {
  let s = 0;
  for (let i = 0; i < n; i++) s += f(i);
  return s;
}

export const pcSeats = (s: FightSetup) => s.seats.map((x, i) => i).filter((i) => s.seats[i]!.tpl.kind === 'pc');
export const allySeats = (s: FightSetup) => s.seats.map((x, i) => i).filter((i) => s.seats[i]!.team === 0 && s.seats[i]!.tpl.kind !== 'pc');

export function viaName(setup: FightSetup, owner: number, via: string, oa: boolean): string {
  const t = setup.seats[owner]!.tpl;
  const name = t.attacks.find((a) => a.id === via)?.name ?? t.spells.find((e) => e.spell.id === via)?.spell.name ?? t.effects.find((e) => e.id === via)?.name ?? t.features.find((f) => f.id === via)?.name ?? via;
  return oa ? `${name} (opportunity)` : name;
}

interface RowSpec {
  readonly src: number[];
  readonly row: DamageRow;
}

function damageRows(setup: FightSetup, layout: CounterLayout, accs: readonly ArmAcc[]): RowSpec[] {
  const S = layout.sources.length;
  const pcs = pcSeats(setup);
  const rows: RowSpec[] = [];
  const total = (a: ArmAcc, src: readonly number[], ff: boolean) => sumOver(layout.rounds, (r) => sumOver(src.length, (j) => (ff ? 0 : a.dmgEff[r * S + src[j]!]!) + (ff ? 1 : -1) * a.ffEff[r * S + src[j]!]!));
  for (const u of pcs) {
    const mine = layout.sources.map((x, i) => i).filter((i) => layout.sources[i]!.owner === u);
    mine.sort((x, y) => {
      const a = layout.sources[x]!;
      const b = layout.sources[y]!;
      return a.via < b.via ? -1 : a.via > b.via ? 1 : Number(a.oa) - Number(b.oa);
    });
    for (const s of mine) {
      if (!accs.some((a) => total(a, [s], false) !== 0)) continue;
      const src = layout.sources[s]!;
      rows.push({ src: [s], row: { label: `${setup.seats[u]!.seat} ${src.via === '(other)' ? '(other)' : viaName(setup, u, src.via, src.oa)}`, group: 'pc' } });
    }
  }
  const allies = allySeats(setup);
  const sides: { pick: (owner: number) => boolean; name: string; group: 'pc' | 'ally' | 'enemy' }[] = [
    ...pcs.map((u) => ({ pick: (o: number) => o === u, name: setup.seats[u]!.seat, group: 'pc' as const })),
    ...allies.map((u) => ({ pick: (o: number) => o === u, name: setup.seats[u]!.seat, group: 'ally' as const })),
    { pick: (o: number) => setup.seats[o]!.team === 1, name: 'enemies', group: 'enemy' as const },
  ];
  for (const side of sides.slice(pcs.length)) rows.push({ src: layout.sources.map((x, i) => i).filter((i) => side.pick(layout.sources[i]!.owner)), row: { label: `${side.name} (all sources)`, group: side.group } });
  for (const side of sides) {
    const src = layout.sources.map((x, i) => i).filter((i) => side.pick(layout.sources[i]!.owner));
    if (accs.some((a) => total(a, src, true) !== 0)) rows.push({ src, row: { label: `${side.name} friendly fire`, group: 'ff' } });
  }
  return rows;
}

/** The report's tables for these arms (the first arm's setup lays them out, as in the text). */
export function reportModel(arms: readonly ArmSpec[], merged: Merged): ReportModel {
  const setup = arms[0]!.setup;
  const layout = buildCounterLayout(setup);
  const S = layout.sources.length;
  const accs = merged.arms;
  const n = merged.n;
  const pcs = pcSeats(setup);

  // Damage per round: columns to the last round at least 1% of fights reached, then the rest.
  let last = 1;
  for (const a of accs) for (let r = 1; r < a.reached.length; r++) if (a.reached[r]! >= 0.01 * n) last = Math.max(last, r);
  const specs = damageRows(setup, layout, accs);

  const out = accs.map((a): ArmModel => {
    const dprBins: DprBin[] = [];
    const h = a.dprHist;
    for (let lo = 0; lo < 65; lo += 5) {
      const c = sumOver(Math.min(5, 65 - lo), (j) => h[lo + j]!);
      dprBins.push({ lo, hi: lo === 60 ? null : lo + 4, count: c, share: c / Math.max(1, n) });
    }
    const dprFine: DprBin[] = [];
    for (let b = 0; b < h.length; b++) dprFine.push({ lo: b, hi: b === h.length - 1 ? null : b, count: h[b]!, share: h[b]! / Math.max(1, n) });
    const damage = specs.map(({ src, row }): DamageCells => {
      const ff = row.group === 'ff';
      const cell = (r: number) => sumOver(src.length, (j) => (ff ? a.ffEff[r * S + src[j]!]! : a.dmgEff[r * S + src[j]!]! - a.ffEff[r * S + src[j]!]!)) / Math.max(1, n);
      const perRound: number[] = [];
      for (let r = 1; r <= last; r++) perRound.push(cell(r));
      let later = 0;
      for (let r = last + 1; r < layout.rounds; r++) later += cell(r);
      later += cell(0);
      const total = perRound.reduce((x, y) => x + y, 0) + later;
      const rolled = sumOver(layout.rounds, (r) => sumOver(src.length, (j) => (ff ? a.ffRolled[r * S + src[j]!]! : a.dmgRolled[r * S + src[j]!]! - a.ffRolled[r * S + src[j]!]!))) / Math.max(1, n);
      return { perRound, later, total, rolled };
    });
    const reached: number[] = [];
    for (let r = 1; r <= last; r++) reached.push(ratio(a.reached[r]!, n));
    const concEnds: { why: FxEndWhy; perFight: number }[] = [];
    FX_END_WHYS.forEach((why, i) => {
      const c = sumOver(pcs.length, (j) => a.concEnd[pcs[j]! * FX_END_WHYS.length + i]!);
      if (c > 0) concEnds.push({ why, perFight: c / Math.max(1, n) });
    });
    return {
      label: a.label,
      roundsHist: Array.from(a.roundsHist),
      dprBins,
      dprFine,
      damage,
      reached,
      concStartsPerFight: sumOver(pcs.length, (j) => a.concStart[pcs[j]!]!) / Math.max(1, n),
      concEnds,
    };
  });
  return { lastRound: last, damageRows: specs.map((s) => s.row), arms: out };
}
