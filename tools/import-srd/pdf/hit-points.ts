// "Level 1 Hit Points by Class" and "Fixed Hit Points by Class" (Character Creation), plus
// each class's "Hit Point Die  D12 per Barbarian level" row from its Core Traits table.
//
// The two HP tables are small two-column tables under an h5 title: a class-list cell that
// can wrap ("Bard, Cleric, Druid, Monk," + "Rogue, or Warlock") and a value cell
// "12 + Con. modifier" on the cell's first line.

import { type Line, STYLE, isStyle } from './lines.ts';
import { type ClassId, CLASSES, isClassId } from './names.ts';

export interface HpTable {
  readonly page: number;
  /** Class -> the number before "+ Con. modifier". */
  readonly values: Record<ClassId, number>;
}

const VALUE = /^(\d+) \+ Con\. modifier$/;

export function parseHpTable(lines: readonly Line[], title: string): HpTable {
  const at = lines.findIndex((l) => isStyle(l, STYLE.h5) && l.text === title);
  if (at < 0) throw new Error(`no "${title}" table`);
  const head = lines[at]!;
  const rows: { y: number; value: number; label: string[] }[] = [];
  const labels: { y: number; text: string }[] = [];
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.page !== head.page || l.col !== head.col || l.y - head.y > 160) break;
    if (l.h > 12) break; // past the table: a heading or body text
    const v = VALUE.exec(l.text);
    if (v) rows.push({ y: l.y, value: Number(v[1]), label: [] });
    else if (l.text !== 'Class' && !/^Hit Point/.test(l.text)) labels.push({ y: l.y, text: l.text });
  }
  rows.sort((a, b) => a.y - b.y);
  for (const lab of labels) {
    let row: (typeof rows)[number] | undefined;
    for (const r of rows) if (r.y <= lab.y + 0.5) row = r;
    if (!row) throw new Error(`"${title}": label "${lab.text}" above every value`);
    row.label.push(lab.text);
  }
  const values = {} as Record<ClassId, number>;
  for (const r of rows) {
    for (const name of r.label.join(' ').split(/,\s*|\s+or\s+/)) {
      const id = name.replace(/^or\s+/, '').trim().toLowerCase();
      if (id === '') continue;
      if (!isClassId(id)) throw new Error(`"${title}": unknown class "${name}"`);
      if (values[id] !== undefined) throw new Error(`"${title}": ${id} listed twice`);
      values[id] = r.value;
    }
  }
  const missing = CLASSES.filter((c) => values[c] === undefined);
  if (missing.length) throw new Error(`"${title}": no value for ${missing.join(', ')}`);
  return { page: head.page, values };
}

/** "Hit Point Die  D12 per Barbarian level" for every class, from the layout text. */
export function parseHitDice(pages: readonly string[]): Record<ClassId, { die: number; page: number }> {
  const out = {} as Record<ClassId, { die: number; page: number }>;
  pages.forEach((text, p) => {
    for (const m of text.matchAll(/Hit Point Die\s+D(\d+) per ([A-Z][a-z]+) level/g)) {
      const id = m[2]!.toLowerCase();
      if (!isClassId(id)) throw new Error(`Hit Point Die row for unknown class "${m[2]}"`);
      if (out[id]) throw new Error(`two Hit Point Die rows for ${id}`);
      out[id] = { die: Number(m[1]), page: p + 1 };
    }
  });
  const missing = CLASSES.filter((c) => !out[c]);
  if (missing.length) throw new Error(`no Hit Point Die row for ${missing.join(', ')}`);
  return out;
}
