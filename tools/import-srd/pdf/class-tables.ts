// The 12 "<Class> Features" tables, from `pdftotext -layout` text (clean, aligned rows).
//
// Each row is: level, proficiency bonus, the Class Features cell, then the class's value
// columns. Value cells are single tokens ("2", "+2", "D6", "1d8", "3d6", "—") except
// Unarmored Movement ("+10 ft."), so a row is parsed from the right: the last N tokens are
// the N value columns and what's left is the features cell. A features cell that wraps puts
// a continuation line under its row (Druid 1 "Primal Order", Sorcerer 4 "Improvement").
// Headers are stacked over two lines, so column ids come from COLUMNS below and the parser
// only checks that every word of every label appears in the header.

import { type ClassId, CLASSES, titleCase } from './names.ts';

export type Unit = 'count' | 'bonus' | 'die' | 'd6' | 'feet';

interface ColumnSpec {
  readonly label: string;
  readonly unit: Unit;
}

/** Value columns per class, left to right after Class Features. `slots` appends slot-1..slot-N. */
export const COLUMNS: Readonly<Record<ClassId, { readonly cols: readonly ColumnSpec[]; readonly slots?: 5 | 9 }>> = {
  barbarian: { cols: [c('Rages'), c('Rage Damage', 'bonus'), c('Weapon Mastery')] },
  bard: { cols: [c('Bardic Die', 'die'), c('Cantrips'), c('Prepared Spells')], slots: 9 },
  cleric: { cols: [c('Channel Divinity'), c('Cantrips'), c('Prepared Spells')], slots: 9 },
  druid: { cols: [c('Wild Shape'), c('Cantrips'), c('Prepared Spells')], slots: 9 },
  fighter: { cols: [c('Second Wind'), c('Weapon Mastery')] },
  monk: { cols: [c('Martial Arts', 'die'), c('Focus Points'), c('Unarmored Movement', 'feet')] },
  paladin: { cols: [c('Channel Divinity'), c('Prepared Spells')], slots: 5 },
  ranger: { cols: [c('Favored Enemy'), c('Prepared Spells')], slots: 5 },
  rogue: { cols: [c('Sneak Attack', 'd6')] },
  sorcerer: { cols: [c('Sorcery Points'), c('Cantrips'), c('Prepared Spells')], slots: 9 },
  warlock: { cols: [c('Eldritch Invocations'), c('Cantrips'), c('Prepared Spells'), c('Spell Slots'), c('Slot Level')] },
  wizard: { cols: [c('Cantrips'), c('Prepared Spells')], slots: 9 },
};

function c(label: string, unit: Unit = 'count'): ColumnSpec {
  return { label, unit };
}

export const columnId = (label: string): string => label.toLowerCase().replace(/ /g, '-');

/** Column ids and units in table order, slot columns included. */
export function columnsOf(cls: ClassId): { id: string; unit: Unit }[] {
  const spec = COLUMNS[cls];
  const out = spec.cols.map((col) => ({ id: columnId(col.label), unit: col.unit }));
  for (let n = 1; n <= (spec.slots ?? 0); n++) out.push({ id: `slot-${n}`, unit: 'count' });
  return out;
}

export interface TableFeature {
  readonly level: number;
  /** As printed, minus a trailing parenthetical: "Action Surge (one use)" -> "Action Surge". */
  readonly name: string;
  /** The parenthetical, when there was one ("one use", "level 6 spell"). */
  readonly detail?: string;
}

export interface ClassTable {
  readonly page: number;
  readonly columnOrder: string[];
  readonly units: Record<string, Unit>;
  /** Column id -> 20 values (index 0 = level 1). "—" is 0. */
  readonly columns: Record<string, number[]>;
  readonly features: TableFeature[];
  /** Levels whose features cell says "Subclass feature". */
  readonly subclassLevels: number[];
}

const ROW = /^(\s*)(\d{1,2})\s+\+(\d)\s+(\S.*?)\s*$/;

export function parseValue(tok: string, unit: Unit): number | undefined {
  if (tok === '—') return unit === 'bonus' || unit === 'die' || unit === 'd6' ? undefined : 0;
  let m: RegExpExecArray | null;
  switch (unit) {
    case 'count':
      return /^\d+$/.test(tok) ? Number(tok) : undefined;
    case 'bonus':
      return (m = /^\+(\d+)$/.exec(tok)) ? Number(m[1]) : undefined;
    case 'die':
      return (m = /^(?:D|1d)(4|6|8|10|12)$/.exec(tok)) ? Number(m[1]) : undefined;
    case 'd6':
      return (m = /^(\d+)d6$/.exec(tok)) ? Number(m[1]) : undefined;
    case 'feet':
      return (m = /^\+(\d+) ft\.$/.exec(tok)) ? Number(m[1]) : undefined;
  }
}

/** Split a features cell into names. "—" (no features) gives none. */
export function splitFeatures(cell: string, level: number): { features: TableFeature[]; subclass: boolean } {
  const features: TableFeature[] = [];
  let subclass = false;
  for (const raw of cell.split(',')) {
    const part = raw.trim();
    if (part === '' || part === '—') continue;
    if (part === 'Subclass feature') {
      subclass = true;
      continue;
    }
    const m = /^(.*?) \(([^()]+)\)$/.exec(part);
    features.push(m ? { level, name: m[1]!, detail: m[2]! } : { level, name: part });
  }
  return { features, subclass };
}

/** Find and parse one class's Features table in the layout pages. Throws with the reason. */
export function parseClassTable(pages: readonly string[], cls: ClassId): ClassTable {
  const title = new RegExp(`^\\s*${titleCase(cls)} Features\\s*$`);
  let page = -1;
  let lines: string[] = [];
  let start = -1;
  for (let p = 0; p < pages.length && page < 0; p++) {
    lines = pages[p]!.split('\n');
    start = lines.findIndex((l) => title.test(l));
    if (start >= 0) page = p + 1;
  }
  if (page < 0) throw new Error(`${cls}: no "${titleCase(cls)} Features" table title`);
  const cols = columnsOf(cls);
  const n = cols.length;

  let i = start + 1;
  const header: string[] = [];
  for (; i < lines.length && !ROW.test(lines[i]!); i++) header.push(lines[i]!);
  if (header.length > 4) throw new Error(`${cls}: ${header.length} header lines before row 1 (expected 2-3)`);
  checkHeader(cls, header.join(' '));

  const columns: Record<string, number[]> = {};
  for (const col of cols) columns[col.id] = [];
  const pb: number[] = [];
  const features: TableFeature[] = [];
  const subclassLevels: number[] = [];
  let cells: { level: number; cell: string; col: number }[] = [];
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const m = ROW.exec(line);
    if (m && cells.length < 20) {
      const level = Number(m[2]);
      if (level !== cells.length + 1) throw new Error(`${cls}: row for level ${level} where ${cells.length + 1} was expected`);
      pb.push(Number(m[3]));
      const toks = m[4]!.split(/\s+/);
      for (let t = toks.length - 1; t > 0; t--) {
        if (toks[t] === 'ft.') toks.splice(t - 1, 2, `${toks[t - 1]} ft.`);
      }
      if (toks.length < n + 1) throw new Error(`${cls} level ${level}: ${toks.length} cells, expected features + ${n}`);
      const vals = toks.slice(toks.length - n);
      vals.forEach((tok, k) => {
        const v = parseValue(tok, cols[k]!.unit);
        if (v === undefined) throw new Error(`${cls} level ${level}: column ${cols[k]!.id} has "${tok}", not a ${cols[k]!.unit}`);
        columns[cols[k]!.id]!.push(v);
      });
      const cell = toks.slice(0, toks.length - n).join(' ');
      const col = line.indexOf(toks[0]!, m[1]!.length + m[2]!.length + 2 + m[3]!.length);
      cells.push({ level, cell, col });
      continue;
    }
    // A continuation line: one cell, starting under the previous row's features cell.
    const last = cells[cells.length - 1];
    const text = line.trim();
    const at = line.search(/\S/);
    if (last && text !== '' && !/\s{2,}/.test(text) && Math.abs(at - last.col) <= 4) {
      last.cell = `${last.cell} ${text}`;
      continue;
    }
    if (cells.length === 20) break;
    if (text === '' && cells.length > 0) throw new Error(`${cls}: table ends after level ${cells.length}`);
    if (cells.length > 0) throw new Error(`${cls}: unexpected line inside the table after level ${cells.length}: "${text}"`);
  }
  if (cells.length !== 20) throw new Error(`${cls}: ${cells.length} rows, expected 20`);
  for (const { level, cell } of cells) {
    const s = splitFeatures(cell, level);
    features.push(...s.features);
    if (s.subclass) subclassLevels.push(level);
  }
  const units: Record<string, Unit> = {};
  for (const col of cols) if (col.unit !== 'count') units[col.id] = col.unit;
  return { page, columnOrder: ['proficiency-bonus', ...cols.map((col) => col.id)], units: { ...units, 'proficiency-bonus': 'bonus' }, columns: { ...columns, 'proficiency-bonus': pb }, features, subclassLevels };
}

function checkHeader(cls: ClassId, header: string): void {
  const words = new Set(header.replace(/—+/g, ' ').split(/\s+/));
  const want = ['Level', 'Proficiency', 'Bonus', 'Class', 'Features', ...COLUMNS[cls].cols.flatMap((col) => col.label.split(' '))];
  if (COLUMNS[cls].slots) want.push('Spell', 'Slots', 'per', 'Level');
  const missing = want.filter((w) => !words.has(w));
  if (missing.length) throw new Error(`${cls}: header lacks ${missing.join(', ')}: "${header.replace(/\s+/g, ' ').trim()}"`);
  if (COLUMNS[cls].slots) {
    const digits = header.replace(/[^\d ]/g, ' ').trim().split(/\s+/).join(' ');
    const expect = Array.from({ length: COLUMNS[cls].slots! }, (_, k) => k + 1).join(' ');
    if (!digits.endsWith(expect)) throw new Error(`${cls}: slot header digits "${digits}", expected "${expect}"`);
  }
}

export function parseAllClassTables(pages: readonly string[]): Record<ClassId, ClassTable> {
  const out = {} as Record<ClassId, ClassTable>;
  for (const cls of CLASSES) out[cls] = parseClassTable(pages, cls);
  return out;
}
