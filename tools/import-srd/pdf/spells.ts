// Spell headers (the C2 / C4 source of truth) and the class spell list tables.
//
// A spell starts with an h4 name and an italic line under it:
//   "Level 3 Evocation (Sorcerer, Wizard)"  or  "Evocation Cantrip (Sorcerer, Wizard)".
// The italic line can wrap ("(Cleric, Druid, Paladin, Ranger," + "Wizard)"), and the name
// is the line before it in reading order, which is what fixes the names naive extraction
// misplaced (Animate Dead, Goodberry, Wall of Force ...: the header sits at the top of a
// column and its name at the bottom of the previous one).
//
// The class chapters also print each class's list as tables under h5 titles
// ("Cantrips (Level 0 Druid Spells)", "Level 1 Druid Spells"), first-column cells in the
// cell style. Those are a second, independent source for the class lists; the index keeps
// the header lists and validate.ts requires the two to agree.

import { type Line, STYLE, continues, isStyle } from './lines.ts';
import { type ClassId, SCHOOLS, isClassId } from './names.ts';
import type { HeaderAt } from './spell-details.ts';

export interface SpellHeader {
  readonly name: string;
  readonly level: number;
  readonly school: string;
  readonly classes: ClassId[];
  readonly page: number;
}

const SCHOOL = SCHOOLS.join('|');
export const SPELL_LINE = new RegExp(`^(?:Level ([1-9]) (${SCHOOL})|(${SCHOOL}) Cantrip) \\((.*)$`);

/** `at`, when given, receives each header's line positions in reading order (spell-details.ts). */
export function parseSpellHeaders(lines: readonly Line[], at?: HeaderAt[]): SpellHeader[] {
  const out: SpellHeader[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (!isStyle(l, STYLE.sub)) continue;
    const m = SPELL_LINE.exec(l.text);
    if (!m) continue;
    let rest = m[4]!;
    let j = i;
    while (!rest.includes(')')) {
      if (!continues(lines[j]!, lines[j + 1])) throw new Error(`spell header on p.${l.page} never closes its class list: "${l.text}"`);
      rest = `${rest} ${lines[++j]!.text}`;
    }
    const close = rest.indexOf(')');
    if (rest.slice(close + 1).trim() !== '') throw new Error(`spell header on p.${l.page} has text after the class list: "${rest}"`);
    const classes = rest
      .slice(0, close)
      .split(',')
      .map((s) => s.trim().toLowerCase());
    for (const c of classes) if (!isClassId(c)) throw new Error(`spell header on p.${l.page} names an unknown class "${c}"`);

    // The name: the h4 line(s) right before the header in reading order.
    let k = i - 1;
    if (!isStyle(lines[k], STYLE.h4)) throw new Error(`spell header on p.${l.page} ("${l.text}") has no h4 name before it (found "${lines[k]?.text}")`);
    let name = lines[k]!.text;
    while (k > 0 && isStyle(lines[k - 1], STYLE.h4) && continues(lines[k - 1]!, lines[k])) name = `${lines[--k]!.text} ${name}`;
    out.push({
      name,
      level: m[1] ? Number(m[1]) : 0,
      school: m[2] ?? m[3]!,
      classes: (classes as ClassId[]).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      page: lines[k]!.page,
    });
    at?.push({ name, page: lines[k]!.page, start: k, end: j });
    i = j;
  }
  return out;
}

export interface ListEntry {
  readonly class: ClassId;
  readonly level: number;
  readonly name: string;
  readonly page: number;
}

const LIST_TITLE = /^(?:Cantrips \(Level 0 ([A-Z][a-z]+) Spells\)|Level ([1-9]) ([A-Z][a-z]+) Spells)$/;

/** The class chapters' spell list tables: (class, level, name) per row. */
export function parseSpellListTables(lines: readonly Line[]): ListEntry[] {
  const out: ListEntry[] = [];
  let cur: { cls: ClassId; level: number } | undefined;
  for (const l of lines) {
    if (isStyle(l, STYLE.h1) || isStyle(l, STYLE.h2) || isStyle(l, STYLE.h3) || isStyle(l, STYLE.h4) || isStyle(l, STYLE.h5)) {
      cur = undefined;
      const m = isStyle(l, STYLE.h5) ? LIST_TITLE.exec(l.text) : null;
      const cls = m ? (m[1] ?? m[3]!).toLowerCase() : '';
      if (m && isClassId(cls)) cur = { cls, level: m[1] ? 0 : Number(m[2]) };
      continue;
    }
    // Only the Spell column uses the cell style (School and Special are body-size), and a
    // table that runs into the next column or page simply keeps going until the next heading.
    if (!cur || !isStyle(l, STYLE.cell)) continue;
    out.push({ class: cur.cls, level: cur.level, name: l.text, page: l.page });
  }
  return out;
}
