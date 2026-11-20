// Compare's "checks side by side" (PLAN.md M6): the skill checks, saves and ability checks whose
// modifier differs between the builds, with each build's exact chance at one DC. Pure.

import type { DerivedSheet } from '@montecrit/engine';
import { DEFAULT_OPTIONS, chance, rowsFor } from '../odds/model.ts';

export interface OddsLine {
  readonly key: string;
  readonly label: string;
  /** Per build, in the builds' order. */
  readonly mods: readonly number[];
  readonly ps: readonly number[];
}

export interface OddsCompare {
  /** The checks where at least one build differs from the first. */
  readonly lines: readonly OddsLine[];
  /** How many checks every build makes at the same modifier. */
  readonly same: number;
}

export function oddsCompare(sheets: readonly DerivedSheet[], dc: number): OddsCompare {
  if (sheets.length < 2) return { lines: [], same: 0 };
  const rows = sheets.map(rowsFor);
  const lines: OddsLine[] = [];
  let same = 0;
  for (const r of rows[0]!) {
    const each = rows.map((rs) => rs.find((x) => x.key === r.key) ?? r);
    if (each.every((x) => x.mod === r.mod)) {
      same++;
      continue;
    }
    lines.push({ key: r.key, label: r.label, mods: each.map((x) => x.mod), ps: each.map((x) => chance(x, { ...DEFAULT_OPTIONS, dc }).p) });
  }
  return { lines, same };
}
