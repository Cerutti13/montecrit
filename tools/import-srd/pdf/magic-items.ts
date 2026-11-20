// Magic item headers read from the PDF (M3 step 6, C4, C9b): the gate's names, and a few
// machine tokens the magic-item mapper checks its closed readings against.
//
// Layout (bbox lines in reading order, SRD 5.2.1 "Magic Items A–Z", pp.209-253): the item's
// name at h4 (14.3 pt, sometimes wrapped onto a second h4 line), then its italic category line
// at 13.3 pt ("Armor (Shield), Uncommon (+1), Rare (+2), or Very Rare (+3)", "Ring, Rare
// (Requires Attunement)"), which can wrap, then the description until the next name. The
// chapter runs from its "Magic Items A–Z" title to the next h1 ("Monsters").
//
// Only tokens enter srd-index.json: the category word, the attunement flag, the +N variants a
// rarity list names, and `facts` from a closed list of phrases (FACT_PATTERNS). No sentence of
// rules text is copied.

import { type Line, STYLE, isStyle } from './lines.ts';
import { joinBody } from './spell-details.ts';

export interface MagicItemDetail {
  readonly name: string;
  readonly page: number;
  /** The category's first word(s), lower case: armor, weapon, wondrous item, ring, potion, rod, scroll, staff, wand. */
  readonly category: string;
  readonly attunement: boolean;
  /** The +N variants the rarity list names ("Uncommon (+1), Rare (+2), or Very Rare (+3)" -> [1, 2, 3]). */
  readonly plus: readonly number[];
  /** Closed-list tokens found in the description (FACT_PATTERNS), sorted. */
  readonly facts: readonly string[];
}

/**
 * The phrases the mapper's readings need, each to a fixed token. Anything not listed here is
 * simply not recorded; a reading that needs a token the text doesn't have fails closed.
 */
export const FACT_PATTERNS: readonly (readonly [RegExp, (m: RegExpMatchArray) => string])[] = [
  [/\+(\d) bonus to Armor Class and saving throws/, (m) => `ac+${m[1]}`],
  [/\+(\d) bonus to Armor Class and saving throws/, (m) => `save+${m[1]}`],
  [/\+(\d) bonus to ability checks and saving throws/, (m) => `check+${m[1]}`],
  [/\+(\d) bonus to ability checks and saving throws/, (m) => `save+${m[1]}`],
  [/\+(\d) bonus to Armor Class(?! and)/, (m) => `ac+${m[1]}`],
  [/bonus to Armor Class while wearing this armor\. The bonus is determined by its rarity/, () => 'ac-by-rarity-while-worn'],
  [/While holding this Shield, you have a bonus to Armor Class determined by the Shield's rarity/, () => 'ac-by-rarity-while-holding'],
  [/bonus to attack rolls and damage rolls made with this magic weapon\. The bonus is determined by the weapon's rarity/, () => 'attack-damage-by-rarity'],
  [/if you are wearing no armor and using no Shield/, () => 'if-no-armor-no-shield'],
];

export function factsOf(body: string): string[] {
  const out = new Set<string>();
  for (const [re, tok] of FACT_PATTERNS) {
    const m = re.exec(body);
    if (m) out.add(tok(m));
  }
  return [...out].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Category line tokens. */
export function parseCategory(text: string): { category: string; attunement: boolean; plus: number[] } {
  const m = /^(Armor|Weapon|Wondrous Item|Ring|Potion|Rod|Scroll|Staff|Wand)\b/.exec(text);
  if (!m) throw new Error(`magic item category "${text.slice(0, 40)}" not recognized`);
  const plus = [...text.matchAll(/\(\+(\d)\)/g)].map((x) => Number(x[1]));
  return { category: m[1]!.toLowerCase(), attunement: /Requires Attunement/.test(text), plus };
}

/** Every magic item header in the "Magic Items A–Z" chapter, in reading order. */
export function parseMagicItems(lines: readonly Line[]): MagicItemDetail[] {
  const start = lines.findIndex((l) => l.text === 'Magic Items A–Z' && isStyle(l, STYLE.h2));
  if (start < 0) throw new Error('no "Magic Items A–Z" chapter title');
  let end = lines.findIndex((l, i) => i > start && isStyle(l, STYLE.h1));
  if (end < 0) end = lines.length;
  const heads: { name: string; page: number; at: number; body: number }[] = [];
  for (let i = start + 1; i < end; i++) {
    const l = lines[i]!;
    if (!isStyle(l, STYLE.h4)) continue;
    let name = l.text;
    let j = i + 1;
    while (j < end && isStyle(lines[j], STYLE.h4) && lines[j]!.page === l.page && lines[j]!.col === l.col) name = `${name} ${lines[j++]!.text}`;
    if (!isStyle(lines[j], STYLE.sub)) continue; // an h4 that isn't an item (none at the pin; kept fail-safe)
    heads.push({ name, page: l.page, at: i, body: j });
    i = j - 1;
  }
  return heads.map((h, n) => {
    let j = h.body;
    const cat: string[] = [];
    while (j < end && isStyle(lines[j], STYLE.sub)) cat.push(lines[j++]!.text);
    const stop = n + 1 < heads.length ? heads[n + 1]!.at : end;
    const body: string[] = [];
    for (; j < stop; j++) body.push(lines[j]!.text);
    const c = parseCategory(joinBody(cat));
    return { name: h.name, page: h.page, ...c, facts: factsOf(joinBody(body)) };
  });
}
