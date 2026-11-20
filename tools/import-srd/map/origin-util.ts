// Helpers the origin and equipment mappers share (species, species traits, backgrounds,
// feats, weapons, armor; docs/design/m3.md 2.3, 4.3). Closed code tables only: a Foundry
// code outside them is a loud error, never a guess.

import { DAMAGE_TYPES, SIZES } from '../../../packages/engine/src/content/types.ts';
import { SKILLS } from '../../../packages/engine/src/content/rollkeys.ts';
import { normName } from '../filter.ts';
import type { SrdIndex } from '../pdf/build.ts';
import { getPath, isRecord } from '../util.ts';

export const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** kebab-case, ASCII only (the same folding as ids.ts). */
export const kebab = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[^\x00-\x7f]/g, '')
    .replace(/['’]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** Foundry skill codes (CONFIG.DND5E.skills keys) to our skill names. */
export const SKILL_CODES: Readonly<Record<string, string>> = {
  acr: 'acrobatics',
  ani: 'animal-handling',
  arc: 'arcana',
  ath: 'athletics',
  dec: 'deception',
  his: 'history',
  ins: 'insight',
  itm: 'intimidation',
  inv: 'investigation',
  med: 'medicine',
  nat: 'nature',
  prc: 'perception',
  prf: 'performance',
  per: 'persuasion',
  rel: 'religion',
  slt: 'sleight-of-hand',
  ste: 'stealth',
  sur: 'survival',
};

/** Every skill in our order (SKILLS), for a "skills:*" pool. */
export const ALL_SKILLS: readonly string[] = SKILLS.map(([n]) => n);

export function skillOf(code: string, where: string): string {
  const s = SKILL_CODES[code];
  if (s === undefined) throw new Error(`${where}: unknown Foundry skill code ${code}`);
  return s;
}

/** Skills in our (SKILLS) order. */
export const bySkillOrder = (a: string, b: string): number => ALL_SKILLS.indexOf(a) - ALL_SKILLS.indexOf(b);

const SIZE_CODES: Readonly<Record<string, (typeof SIZES)[number]>> = { tiny: 'tiny', sm: 'small', med: 'medium', lg: 'large', huge: 'huge', grg: 'gargantuan' };

export function sizeOf(code: string, where: string): (typeof SIZES)[number] {
  const s = SIZE_CODES[code];
  if (s === undefined) throw new Error(`${where}: unknown Foundry size code ${code}`);
  return s;
}

export function damageTypeOf(t: string, where: string): (typeof DAMAGE_TYPES)[number] {
  if (!(DAMAGE_TYPES as readonly string[]).includes(t)) throw new Error(`${where}: unknown damage type ${t}`);
  return t as (typeof DAMAGE_TYPES)[number];
}

/** A stripped doc's advancements (a list in most records, a map keyed by id in some), in stored or key order. */
export function advancements(doc: Readonly<Record<string, unknown>>): Record<string, unknown>[] {
  const adv = getPath(doc, 'system.advancement');
  if (Array.isArray(adv)) return adv.filter(isRecord);
  if (isRecord(adv)) {
    return Object.keys(adv)
      .sort(byString)
      .map((k) => adv[k])
      .filter(isRecord);
  }
  return [];
}

/** The level an advancement applies at: its level, else the lowest key of its choices map, else 0. */
export function advLevel(a: Record<string, unknown>): number {
  if (typeof a.level === 'number') return a.level;
  const ch = getPath(a, 'configuration.choices');
  if (isRecord(ch)) {
    const lv = Object.keys(ch)
      .map(Number)
      .filter(Number.isInteger)
      .sort((x, y) => x - y);
    if (lv.length) return lv[0]!;
  }
  return 0;
}

/** A ChoiceSchema level: Foundry's species/background level 0 is character level 1. */
export const choiceLevel = (lv: number): number => Math.max(1, lv);

/** The foreign ids an ItemGrant (items) or ItemChoice (pool) points at, Compendium.dnd5e.<pack> only. */
export function grantedIds(a: Record<string, unknown>, pack?: string): string[] {
  const list = a.type === 'ItemGrant' ? getPath(a, 'configuration.items') : a.type === 'ItemChoice' ? getPath(a, 'configuration.pool') : undefined;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const e of list) {
    const uuid = isRecord(e) ? e.uuid : undefined;
    if (typeof uuid !== 'string' || !uuid.startsWith('Compendium.dnd5e.')) continue;
    if (pack !== undefined && !uuid.startsWith(`Compendium.dnd5e.${pack}.`)) continue;
    out.push(uuid.slice(uuid.lastIndexOf('.') + 1));
  }
  return out;
}

/** True when an ItemGrant or ItemChoice points at spells (spells24), or an ItemChoice is a spell choice. */
export function grantsSpells(a: Record<string, unknown>): boolean {
  if (a.type === 'ItemChoice' && getPath(a, 'configuration.type') === 'spell') return true;
  return grantedIds(a, 'spells24').length > 0;
}

/** A Trait advancement's fixed grants and its choices ({count, pool}). */
export function traitCodes(a: Record<string, unknown>): { grants: string[]; choices: { count: number; pool: string[] }[] } {
  const g = getPath(a, 'configuration.grants');
  const c = getPath(a, 'configuration.choices');
  const grants = Array.isArray(g) ? g.filter((x): x is string => typeof x === 'string') : [];
  const choices: { count: number; pool: string[] }[] = [];
  if (Array.isArray(c)) {
    for (const ch of c) {
      if (!isRecord(ch) || typeof ch.count !== 'number' || !Array.isArray(ch.pool)) continue;
      const pool = ch.pool.filter((x): x is string => typeof x === 'string');
      if (pool.length) choices.push({ count: ch.count, pool }); // an empty pool chooses nothing
    }
  }
  return { grants, choices };
}

/** The pdf index entry with this name (typography-normalized, exact otherwise). */
export function pdfEntry<T extends { name: string }>(list: readonly T[] | undefined, name: string): T | undefined {
  if (!list) return undefined;
  const n = normName(name);
  return list.find((e) => normName(e.name) === n);
}

export type PdfIndex = SrdIndex | undefined;

/** 'SRD 5.2.1 p.N' when the page is known, else the plain document name (never a guessed page). */
export const sourceOf = (page: number | undefined): string => (page === undefined ? 'SRD 5.2.1' : `SRD 5.2.1 p.${page}`);
