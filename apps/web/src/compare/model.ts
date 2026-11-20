// Build comparison (PLAN.md M6): the same fight run once per variant on the same (seed, run)
// values, so run i of one variant and run i of another saw the same dice. Each variant's numbers
// are its report's (ArmStats); the paired difference against the reference (the first variant)
// uses the engine's own paired statistics on the per-run outcomes.

import { mcnemarExact, newcombePaired, pairCounts, type ArmAcc, type ArmStats } from '@montecrit/engine';
import type { CharacterEntry } from '../content/catalog.ts';

export interface VariantResult {
  /** The character's id. */
  readonly id: string;
  readonly name: string;
  readonly stats: ArmStats;
  /** The run's accumulator: its per-run outcomes pair it with the other variants. */
  readonly acc: ArmAcc;
  readonly wallMs: number;
  /** Under a script: how often each of its rules was played, as a share of this build's fights. */
  readonly rules?: readonly RuleUse[];
}

export interface RuleUse {
  readonly rule: string;
  /** Share of fights the rule was played in. */
  readonly taken: number;
  /** Share of fights it ran out of tries without being played. */
  readonly retired: number;
}

/** A run's per-rule counts (the engine's taken, retries, retired triples) as shares of its fights. */
export function ruleUse(ids: readonly string[], script: ArrayLike<number>, n: number): RuleUse[] {
  return ids.map((rule, k) => ({ rule, taken: n > 0 ? (script[k * 3] ?? 0) / n : 0, retired: n > 0 ? (script[k * 3 + 2] ?? 0) / n : 0 }));
}

/** The policy every build played, as the screen names it. */
export interface Played {
  readonly id: string;
  readonly name: string;
  /** It has scripted rules (the greedy AI on its own has none). */
  readonly scripted: boolean;
}

export interface Pair {
  /** Index into the variants; the reference is 0. */
  readonly other: number;
  /** Both win, only the other wins, only the reference wins, neither. */
  readonly both: number;
  readonly onlyOther: number;
  readonly onlyRef: number;
  readonly neither: number;
  /** Win rate of the other minus the reference's, with its 95% interval and exact p-value. */
  readonly diff: number;
  readonly lo: number;
  readonly hi: number;
  readonly p: number;
  /** The interval excludes zero. */
  readonly clear: boolean;
}

export interface Comparison {
  readonly n: number;
  readonly played: Played;
  readonly variants: readonly VariantResult[];
  readonly pairs: readonly Pair[];
  /** One sentence on what the numbers say. */
  readonly headline: string;
}

const pts = (x: number): string => `${Math.abs(x * 100).toFixed(1)} points`;

export const GREEDY: Played = { id: 'greedy', name: 'Greedy', scripted: false };

export function compare(variants: readonly VariantResult[], played: Played = GREEDY): Comparison {
  const ref = variants[0]!;
  const pairs: Pair[] = variants.slice(1).map((v, k) => {
    // pairCounts(x, y): a both, b only x, c only y. With x the other variant, diff is other - reference.
    const c = pairCounts(v.acc, ref.acc);
    const d = newcombePaired(c.a, c.b, c.c, c.d);
    return { other: k + 1, both: c.a, onlyOther: c.b, onlyRef: c.c, neither: c.d, diff: d.diff, lo: d.lo, hi: d.hi, p: mcnemarExact(c.b, c.c), clear: d.lo > 0 || d.hi < 0 };
  });
  let headline: string;
  if (pairs.length === 1) {
    const p = pairs[0]!;
    const v = variants[1]!;
    headline = !p.clear
      ? `No clear difference in win rate between ${ref.name} and ${v.name} at this many fights.`
      : p.diff > 0
        ? `${v.name} wins more often than ${ref.name}: ${pts(p.diff)} more.`
        : `${ref.name} wins more often than ${v.name}: ${pts(p.diff)} more.`;
  } else {
    const best = variants.reduce((b, v) => (v.stats.win.p > b.stats.win.p ? v : b), ref);
    const clear = pairs.filter((p) => p.clear);
    headline = clear.length === 0 ? `No variant is clearly different from ${ref.name} in win rate at this many fights.` : `${best.name} has the highest win rate; ${clear.length} of ${pairs.length} variants differ clearly from ${ref.name}.`;
  }
  return { n: ref.acc.n, played, variants, pairs, headline };
}

const HERO = /^test:hero-([a-z]+)-(\d+)$/;

/** The premade heroes by class then level, and everything else as loaded. */
export function grouped(characters: readonly CharacterEntry[]): { readonly heroes: readonly CharacterEntry[]; readonly others: readonly CharacterEntry[] } {
  const key = (c: CharacterEntry): [string, number] => {
    const m = HERO.exec(c.id)!;
    return [m[1]!, Number(m[2])];
  };
  const heroes = characters
    .filter((c) => HERO.test(c.id))
    .sort((a, b) => {
      const [ca, la] = key(a);
      const [cb, lb] = key(b);
      return ca < cb ? -1 : ca > cb ? 1 : la - lb;
    });
  return { heroes, others: characters.filter((c) => !HERO.test(c.id)) };
}

