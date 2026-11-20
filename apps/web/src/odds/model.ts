// The Odds screen's model (PLAN.md "Check-odds calculator", M4): rows for every skill, save and
// plain ability check on a derived sheet, each one's exact chance through the engine's RollSpec
// (hard rule 6: the same model the simulator samples), the DC ladder, and group checks.

import { DEFAULT_FLAGS, SKILLS, exprPmf, groupCheckOdds, parseExpr, rollOdds, type AdvState, type DerivedSheet, type ExprNode, type GroupOdds, type RollSpec } from '@montecrit/engine';

export type RowGroup = 'skill' | 'save' | 'ability';

export interface OddsRow {
  readonly key: string;
  readonly group: RowGroup;
  readonly label: string;
  /** The ability behind it, upper case ("WIS"). */
  readonly ability: string;
  readonly mod: number;
  /** 'expertise', 'proficient' or '' (no proficiency). */
  readonly rank: string;
  /** Where the modifier came from (the derived sheet's source line), or ''. */
  readonly why: string;
}

export interface OddsOptions {
  readonly dc: number;
  readonly adv: AdvState;
  /** Guidance's 1d4: skill checks only. */
  readonly guidance: boolean;
  /** Dice added to every roll ("1d4" for Bless); '' for none. */
  readonly extraDice: string;
  /** A die rolled only after a failure ("1d6" for Bardic Inspiration); '' for none. */
  readonly afterFail: string;
}

export const DEFAULT_OPTIONS: OddsOptions = { dc: 15, adv: 'none', guidance: false, extraDice: '', afterFail: '' };

/** Typical DCs (SRD 5.2.1, "Ability Checks"). */
export const TYPICAL_DCS: readonly (readonly [number, string])[] = [
  [5, 'Very easy'],
  [10, 'Easy'],
  [15, 'Medium'],
  [20, 'Hard'],
  [25, 'Very hard'],
  [30, 'Nearly impossible'],
];

const ABILITY_NAMES: Readonly<Record<string, string>> = { str: 'Strength', dex: 'Dexterity', con: 'Constitution', int: 'Intelligence', wis: 'Wisdom', cha: 'Charisma' };

/** "sleight-of-hand" -> "Sleight of Hand". */
export function skillLabel(id: string): string {
  return id
    .split('-')
    .map((w) => (w === 'of' ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/** Every skill (all 18, proficient or not), save and plain ability check on a sheet. */
export function rowsFor(sheet: DerivedSheet): OddsRow[] {
  const abilityMod = (a: string) => sheet.abilities.find((x) => x.ability === a)?.mod ?? 0;
  const rows: OddsRow[] = [];
  for (const [skill, ability] of SKILLS) {
    const s = sheet.skills.find((x) => x.skill === skill);
    rows.push({ key: `skill:${skill}`, group: 'skill', label: skillLabel(skill), ability: ability.toUpperCase(), mod: s?.mod ?? abilityMod(ability), rank: s && s.rank !== 'none' ? s.rank : '', why: s?.why ?? '' });
  }
  for (const s of sheet.saves) {
    rows.push({ key: `save:${s.ability}`, group: 'save', label: `${ABILITY_NAMES[s.ability] ?? s.ability} save`, ability: s.ability.toUpperCase(), mod: s.mod, rank: s.proficient ? 'proficient' : '', why: s.why });
  }
  for (const a of sheet.abilities) {
    rows.push({ key: `ability:${a.ability}`, group: 'ability', label: `${ABILITY_NAMES[a.ability] ?? a.ability} check`, ability: a.ability.toUpperCase(), mod: a.mod, rank: '', why: '' });
  }
  return rows;
}

/** One typed-in modifier, for a character that isn't loaded. */
export function customRow(mod: number): OddsRow {
  return { key: 'skill:custom', group: 'skill', label: 'Check', ability: '', mod, rank: '', why: '' };
}

export interface ParsedDice {
  readonly node: ExprNode | null;
  readonly error: string | null;
}

/** Parses a dice field; '' is no dice. "d6" reads as "1d6". An after-failure die can't go negative. */
export function parseDice(src: string, afterFail = false): ParsedDice {
  const t = src.trim();
  if (t === '') return { node: null, error: null };
  try {
    const node = parseExpr(/^d\d+$/i.test(t) ? `1${t}` : t);
    const pmf = exprPmf(node);
    if (afterFail && pmf.min < 0) return { node: null, error: `an after-failure die can't go negative ("${t}" can reach ${pmf.min})` };
    return { node, error: null };
  } catch (e) {
    return { node: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface Chance {
  /** Chance to pass with everything switched on. */
  readonly p: number;
  /** The plain roll: no advantage, Guidance, extra dice or after-failure die. */
  readonly plain: number;
  /** Chance the after-failure die gets spent (0 without one). */
  readonly pAfterFailUsed: number;
}

function spec(row: OddsRow, o: OddsOptions, dc: number, plain: boolean): RollSpec {
  const preDice: ExprNode[] = [];
  let afterFail: ExprNode | null = null;
  if (!plain) {
    if (o.guidance && row.group === 'skill') preDice.push(parseExpr('1d4'));
    const extra = parseDice(o.extraDice).node;
    if (extra) preDice.push(extra);
    afterFail = parseDice(o.afterFail, true).node;
  }
  return { kind: row.group === 'save' ? 'save' : 'check', adv: plain ? 'none' : o.adv, flat: row.mod, preDice, dc, ...(afterFail ? { afterFail } : {}) };
}

/** A row's exact chance at a DC (the options' DC unless one is given). */
export function chance(row: OddsRow, o: OddsOptions, dc: number = o.dc): Chance {
  const full = rollOdds(spec(row, o, dc, false), DEFAULT_FLAGS);
  const plain = rollOdds(spec(row, o, dc, true), DEFAULT_FLAGS);
  return { p: full.pSuccess, plain: plain.pSuccess, pAfterFailUsed: full.pAfterFailUsed };
}

/** The chance at every DC from 1 to 30. */
export function ladder(row: OddsRow, o: OddsOptions): { readonly dc: number; readonly p: number }[] {
  const out: { dc: number; p: number }[] = [];
  for (let dc = 1; dc <= 30; dc++) out.push({ dc, p: chance(row, o, dc).p });
  return out;
}

/**
 * A passive score: 10 + the check's modifier, +5 with Advantage, -5 with Disadvantage
 * (SRD 5.2.1 rules glossary, "Passive Perception").
 */
export function passive(mod: number, adv: AdvState): number {
  return 10 + mod + (adv === 'adv' ? 5 : adv === 'dis' ? -5 : 0);
}

export interface GroupMember {
  readonly name: string;
  readonly mod: number;
  readonly adv: AdvState;
  readonly guidance: boolean;
}

/** A group check at one DC: each member's own chance, and the chance at least half pass. */
export function groupOdds(members: readonly GroupMember[], dc: number): { readonly each: readonly number[]; readonly group: GroupOdds } | null {
  if (members.length === 0) return null;
  const each = members.map((m) => chance(customRow(m.mod), { dc, adv: m.adv, guidance: m.guidance, extraDice: '', afterFail: '' }).p);
  return { each, group: groupCheckOdds(each) };
}

export const pct = (p: number): string => `${(p * 100).toFixed(1)}%`;
export const signed = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);

/** "about 14 in 20": the chance in d20 faces, which is how the table thinks about it. */
export function inTwenty(p: number): string {
  if (p <= 0) return 'never';
  if (p >= 1) return 'always';
  const n = Math.min(19, Math.max(1, Math.round(p * 20)));
  return `about ${n} in 20`;
}
