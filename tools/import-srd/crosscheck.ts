// The class-table cross-check (docs/design/m3.md step 2 demo, 4.1, C2): for every class, every
// column of its PDF table and every level 1-20, our emitted class data against the PDF table
// in srd-index.json, with Open5e and 5e-bits as votes. The PDF decides; a vote never wins
// (research-sources §4). Our output must equal the PDF on every cell, or the import fails.
//
// It also lays the class spell lists (built from the PDF spell headers, C2) beside Foundry's
// content24 lists as a vote, and carries the PDF's own list-table gaps.
//
// The result is tools/import-srd/review.json: ids and numbers only, no prose and no name a
// vote source alone supplies (a Foundry-only spell is a count, never a name).
//
// "Ours" is read back from the emitted YAML, not from the mapper's internals: the scale
// column a PDF column lives in comes from map/class.ts PDF_COLUMNS, proficiency bonus from
// the engine's proficiencyBonus, slots from the `slots` scale column (Pact Magic: the one
// non-zero entry is the slot count, its index + 1 the slot level).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { proficiencyBonus } from '../../packages/engine/src/content/compile.ts';
import { normName } from './filter.ts';
import { identOf } from './ids.ts';
import { PDF_COLUMNS } from './map/class.ts';
import type { SrdIndex } from './pdf/build.ts';
import type { Pins } from './pins.ts';
import { spellReviewSummary, type SpellReview } from './crosscheck-spells.ts';
import { monsterReviewSummary, type MonsterReview } from './crosscheck-monsters.ts';
import type { FoundryRecord } from './read.ts';
import { byString, isRecord, sha256, stableJson } from './util.ts';

export const REVIEW_REL = 'tools/import-srd/review.json';

type Rec = Record<string, unknown>;
/** One source's value per level (index 0 = level 1); null = the source has no such column. */
export type Column = (number | null)[];
export type ClassTables = Record<string, Record<string, Column>>;

export interface Votes {
  /** Open5e class responses by class id (c-<class>.json). */
  readonly open5e: Readonly<Record<string, unknown>>;
  /** 5e-bits Levels.json. */
  readonly bitsLevels: unknown;
}

export interface Cell {
  readonly class: string;
  readonly column: string;
  readonly level: number;
  readonly pdf: number;
  readonly ours: number | null;
  readonly open5e: number | null;
  readonly bits: number | null;
  /** The sources that differ from the PDF, joined with '+' (ours, open5e, bits). */
  readonly against: string;
}

export interface VoteTally {
  compared: number;
  agree: number;
  disagree: number;
  absent: number;
}

export interface TableReview {
  readonly classes: number;
  readonly cells: number;
  readonly oursVsPdf: { readonly agree: number; readonly mismatches: number };
  readonly votes: { readonly open5e: VoteTally; readonly bits: VoteTally };
  /** Disagreeing cells by which sources differ from the PDF. */
  readonly byPattern: Record<string, number>;
  readonly disagreements: Cell[];
}

const LEVELS = 20;
const parseYaml = (text: string): unknown => parse(text, { uniqueKeys: true, maxAliasCount: 100, customTags: [], merge: false, version: '1.2' });

/** A breakpoint map ({ '1': v, '5': w }) expanded to levels 1-20; levels before the first are undefined. */
function expand(at: unknown): unknown[] {
  const out: unknown[] = [];
  let cur: unknown;
  for (let l = 1; l <= LEVELS; l++) {
    if (isRecord(at) && Object.hasOwn(at, String(l))) cur = at[String(l)];
    out.push(cur);
  }
  return out;
}

/** A dice string's (count, faces), or undefined. */
function dice(v: unknown): { n: number; f: number } | undefined {
  const m = typeof v === 'string' ? /^(\d*)d(\d+)$/i.exec(v.trim()) : null;
  return m ? { n: m[1] ? Number(m[1]) : 1, f: Number(m[2]) } : undefined;
}

/** A value in the PDF index's units: die -> faces, d6 -> count of d6, bonus/feet/count -> the number. */
function inUnits(v: unknown, unit: string | undefined, where: string): number {
  if (v === undefined || v === null) return 0;
  if (typeof v === 'number') return v;
  const d = dice(v);
  if (d && unit === 'die' && d.n === 1) return d.f;
  if (d && unit === 'd6' && d.f === 6) return d.n;
  throw new Error(`${where}: value ${JSON.stringify(v)} does not fit unit ${unit ?? 'count'}`);
}

/** Pact Magic's (slot count, slot level) from one slots row: the single non-zero entry. */
function pact(row: unknown, where: string): { count: number; level: number } {
  if (row === undefined) return { count: 0, level: 0 };
  if (!Array.isArray(row)) throw new Error(`${where}: slots row is not a list`);
  const nz = row.map((n, i) => ({ n: Number(n), i })).filter((x) => x.n !== 0);
  if (nz.length > 1) throw new Error(`${where}: pact slots at more than one level`);
  return nz.length ? { count: nz[0]!.n, level: nz[0]!.i + 1 } : { count: 0, level: 0 };
}

/** Our table for one class, read from its emitted item, in the PDF table's columns. */
export function oursTable(doc: unknown, cls: string, pdf: SrdIndex): Record<string, Column> {
  const t = pdf.classes[cls as keyof SrdIndex['classes']]?.table;
  if (!t) throw new Error(`crosscheck: no PDF table for ${cls}`);
  if (!isRecord(doc)) throw new Error(`crosscheck: class ${cls} is not an item`);
  const scale = isRecord(doc.scale) ? doc.scale : {};
  const byPdf = new Map<string, string>();
  for (const [sid, col] of Object.entries(PDF_COLUMNS[cls] ?? {})) byPdf.set(col, sid);
  const slots = isRecord(scale.slots) ? expand(scale.slots.at) : undefined;
  // Slot rows may not reach past the PDF's columns: slot-N columns bound a standard caster's row
  // length; Pact Magic's highest printed slot level bounds the warlock's (pact() checks it holds
  // one non-zero entry). An extra entry the table has no cell for is a mismatch, not ignored.
  if (slots) {
    const slotCols = t.columnOrder.map((c) => /^slot-(\d)$/.exec(c)).filter((m) => m !== null).map((m) => Number(m[1]));
    const pactLevels = t.columns['slot-level'];
    const width = slotCols.length ? Math.max(...slotCols) : pactLevels ? Math.max(0, ...pactLevels) : 0;
    slots.forEach((row, i) => {
      if (Array.isArray(row) && row.length > width) throw new Error(`crosscheck: ${cls} slots row at level ${i + 1} has ${row.length} entries, the PDF table has ${width} slot level(s)`);
    });
  }
  const out: Record<string, Column> = {};
  for (const col of t.columnOrder) {
    const where = `${cls} ${col}`;
    const unit = t.units[col];
    let vals: Column;
    const slotN = /^slot-(\d)$/.exec(col);
    if (col === 'proficiency-bonus') vals = Array.from({ length: LEVELS }, (_, i) => proficiencyBonus(i + 1));
    else if (slotN) vals = slots ? slots.map((row) => (Array.isArray(row) ? Number(row[Number(slotN[1]) - 1] ?? 0) : 0)) : Array(LEVELS).fill(null);
    else if (col === 'spell-slots' || col === 'slot-level') {
      vals = slots ? slots.map((row, i) => pact(row, `${where} level ${i + 1}`)[col === 'spell-slots' ? 'count' : 'level']) : Array(LEVELS).fill(null);
    } else {
      const sid = byPdf.get(col);
      const sc = sid !== undefined ? scale[sid] : undefined;
      vals = isRecord(sc) ? expand(sc.at).map((v, i) => inUnits(v, unit, `${where} level ${i + 1}`)) : Array(LEVELS).fill(null);
    }
    out[col] = vals;
  }
  return out;
}

/** Open5e's table-data keys (srd-2024_<class>_<key>) to PDF column ids: a closed table. */
const OPEN5E_COLUMNS: Readonly<Record<string, string>> = {
  'proficiency-bonus': 'proficiency-bonus',
  cantrips: 'cantrips',
  'prepared-spells': 'prepared-spells',
  'slots-1st': 'slot-1',
  'slots-2nd': 'slot-2',
  'slots-3rd': 'slot-3',
  'slots-4th': 'slot-4',
  'slots-5th': 'slot-5',
  'slots-6th': 'slot-6',
  'slots-7th': 'slot-7',
  'slots-8th': 'slot-8',
  'slots-9th': 'slot-9',
  rages: 'rages',
  'rage-damage': 'rage-damage',
  'weapon-mastery-count': 'weapon-mastery',
  'bardic-die': 'bardic-die',
  'channel-divinity-uses': 'channel-divinity',
  'wild-shape-uses': 'wild-shape',
  'second-wind-uses': 'second-wind',
  'focus-points': 'focus-points',
  'martial-arts-dice': 'martial-arts',
  'unarmored-movement': 'unarmored-movement',
  'favored-enemy-uses': 'favored-enemy',
  'sneak-attack-column-data': 'sneak-attack',
  'sorcery-points': 'sorcery-points',
  'eldritch-invocation-count': 'eldritch-invocations',
  'spell-slots': 'spell-slots',
  'slot-level': 'slot-level',
};

/** One Open5e cell string in the PDF's units ("+2", "1d6", "D8", "+10 ft.", "3rd", "—"). */
function open5eValue(s: unknown, unit: string | undefined, where: string): number {
  if (typeof s !== 'string') throw new Error(`${where}: Open5e value is not a string`);
  const v = s.trim();
  if (v === '' || v === '—' || v === '-' || v === '–') return 0;
  const n = /^\+?(\d+)(?: ?ft\.?)?$/.exec(v) ?? /^(\d+)(?:st|nd|rd|th)$/.exec(v);
  if (n) return Number(n[1]);
  return inUnits(v, unit, where);
}

/** Open5e's table for one class in the PDF's columns; a column Open5e lacks is all null. */
export function open5eTable(json: unknown, cls: string, pdf: SrdIndex): Record<string, Column> {
  const t = pdf.classes[cls as keyof SrdIndex['classes']]!.table;
  const feats = isRecord(json) && Array.isArray(json.features) ? json.features : [];
  const out: Record<string, Column> = {};
  for (const f of feats) {
    if (!isRecord(f) || !Array.isArray(f.data_for_class_table) || !f.data_for_class_table.length) continue;
    const key = typeof f.key === 'string' ? f.key.replace(`srd-2024_${cls}_`, '') : '';
    const col = OPEN5E_COLUMNS[key];
    if (col === undefined) throw new Error(`crosscheck: Open5e ${cls} table key ${JSON.stringify(key)} is not in the closed table`);
    if (!t.columnOrder.includes(col)) continue;
    const vals: Column = Array(LEVELS).fill(0);
    const seen = new Set<number>();
    for (const c of f.data_for_class_table) {
      const lvl = isRecord(c) ? Number(c.level) : NaN;
      if (!Number.isInteger(lvl) || lvl < 1 || lvl > LEVELS) throw new Error(`crosscheck: Open5e ${cls} ${key} has a bad level`);
      const v = open5eValue(isRecord(c) ? c.column_value : undefined, t.units[col], `Open5e ${cls} ${key} level ${lvl}`);
      if (seen.has(lvl) && vals[lvl - 1] !== v) throw new Error(`crosscheck: Open5e ${cls} ${key} gives level ${lvl} two values`);
      seen.add(lvl);
      vals[lvl - 1] = v;
    }
    out[col] = vals;
  }
  for (const col of t.columnOrder) out[col] ??= Array(LEVELS).fill(null);
  return out;
}

/** 5e-bits class_specific keys to PDF column ids: a closed table (values are numbers already). */
const BITS_COLUMNS: Readonly<Record<string, string>> = {
  rage_count: 'rages',
  rage_damage_bonus: 'rage-damage',
  weapon_mastery: 'weapon-mastery',
  bardic_inspiration_die: 'bardic-die',
  channel_divinity_charges: 'channel-divinity',
  wild_shape_uses: 'wild-shape',
  second_wind_uses: 'second-wind',
  martial_arts_die: 'martial-arts',
  focus_points: 'focus-points',
  unarmored_movement_bonus: 'unarmored-movement',
  favored_enemies: 'favored-enemy',
  sneak_attack: 'sneak-attack',
  sorcery_points: 'sorcery-points',
  eldritch_invocations: 'eldritch-invocations',
};

/** 5e-bits' table for one class (its class rows only, not subclass rows). */
export function bitsTable(levels: unknown, cls: string, pdf: SrdIndex): Record<string, Column> {
  const t = pdf.classes[cls as keyof SrdIndex['classes']]!.table;
  const rows = (Array.isArray(levels) ? levels : []).filter((l): l is Rec => isRecord(l) && !l.subclass && isRecord(l.class) && l.class.index === cls);
  const out: Record<string, Column> = {};
  for (const col of t.columnOrder) out[col] = Array(LEVELS).fill(null);
  const set = (col: string, lvl: number, v: number) => {
    if (out[col]) out[col]![lvl - 1] = v;
  };
  for (const r of rows) {
    const lvl = Number(r.level);
    if (!Number.isInteger(lvl) || lvl < 1 || lvl > LEVELS) throw new Error(`crosscheck: 5e-bits ${cls} has a bad level`);
    if (typeof r.prof_bonus === 'number') set('proficiency-bonus', lvl, r.prof_bonus);
    const sc = isRecord(r.spellcasting) ? r.spellcasting : undefined;
    if (sc) {
      if (typeof sc.cantrips_known === 'number') set('cantrips', lvl, sc.cantrips_known);
      if (typeof sc.prepared_spells === 'number') set('prepared-spells', lvl, sc.prepared_spells);
      const row: number[] = [];
      for (let n = 1; n <= 9; n++) {
        const v = sc[`spell_slots_level_${n}`];
        row.push(typeof v === 'number' ? v : 0);
        set(`slot-${n}`, lvl, typeof v === 'number' ? v : 0);
      }
      if (t.columnOrder.includes('spell-slots')) {
        const p = pact(row, `5e-bits ${cls} level ${lvl}`);
        set('spell-slots', lvl, p.count);
        set('slot-level', lvl, p.level);
      }
    }
    const cs = isRecord(r.class_specific) ? r.class_specific : {};
    for (const [k, v] of Object.entries(cs)) {
      const col = BITS_COLUMNS[k];
      if (col === undefined) throw new Error(`crosscheck: 5e-bits ${cls} key ${k} is not in the closed table`);
      const n = typeof v === 'number' ? v : isRecord(v) && typeof v.dice_count === 'number' && v.dice_value === 6 ? v.dice_count : NaN;
      if (!Number.isFinite(n)) throw new Error(`crosscheck: 5e-bits ${cls} ${k} level ${lvl} is not a number`);
      set(col, lvl, n);
    }
  }
  return out;
}

const tally = (): VoteTally => ({ compared: 0, agree: 0, disagree: 0, absent: 0 });

/** Every cell of every PDF class table, ours and the two votes against the PDF. */
export function crosscheckTables(classDocs: Readonly<Record<string, unknown>>, pdf: SrdIndex, votes: Votes | undefined): TableReview {
  const classes = Object.keys(pdf.classes).sort(byString);
  const v = { open5e: tally(), bits: tally() };
  const disagreements: Cell[] = [];
  const byPattern: Record<string, number> = {};
  let cells = 0;
  let agree = 0;
  for (const cls of classes) {
    const t = pdf.classes[cls as keyof SrdIndex['classes']]!.table;
    const ours = oursTable(classDocs[cls], cls, pdf);
    const o5 = votes ? open5eTable(votes.open5e[cls], cls, pdf) : undefined;
    const bits = votes ? bitsTable(votes.bitsLevels, cls, pdf) : undefined;
    for (const col of t.columnOrder) {
      const p = t.columns[col]!;
      for (let i = 0; i < LEVELS; i++) {
        cells++;
        const cell = { ours: ours[col]![i]!, open5e: o5 ? o5[col]![i]! : null, bits: bits ? bits[col]![i]! : null };
        const against: string[] = [];
        if (cell.ours === p[i]) agree++;
        else against.push('ours');
        for (const src of ['open5e', 'bits'] as const) {
          if (!votes) continue;
          const x = cell[src];
          if (x === null) v[src].absent++;
          else {
            v[src].compared++;
            if (x === p[i]) v[src].agree++;
            else {
              v[src].disagree++;
              against.push(src);
            }
          }
        }
        if (against.length) {
          const key = against.join('+');
          byPattern[key] = (byPattern[key] ?? 0) + 1;
          disagreements.push({ class: cls, column: col, level: i + 1, pdf: p[i]!, ...cell, against: key });
        }
      }
    }
  }
  return { classes: classes.length, cells, oursVsPdf: { agree, mismatches: cells - agree }, votes: v, byPattern, disagreements };
}

export interface SpellListReview {
  readonly pdf: number;
  readonly foundry: number;
  readonly agree: number;
  /** PDF spell ids on this class's PDF list that Foundry's list leaves out. */
  readonly pdfOnly: string[];
  /** PDF spell ids Foundry lists for this class that the PDF headers don't. */
  readonly foundryOnly: string[];
  /** Foundry list entries that are no PDF spell (counted, never named). */
  readonly foundryNotInPdf: number;
}

const spellId = (name: string): string => `srd:${identOf({}, normName(name))}`;

/** The PDF-header class lists (C2) beside Foundry's content24 lists, by class id. */
export function crosscheckSpellLists(pdf: SrdIndex, foundryLists: Readonly<Record<string, readonly string[]>> | undefined, records: readonly FoundryRecord[]): Record<string, SpellListReview> {
  const pdfByName = new Map(pdf.spells.map((s) => [normName(s.name), s]));
  const recById = new Map(records.map((r) => [r.id, r]));
  const out: Record<string, SpellListReview> = {};
  const listClasses = [...new Set(pdf.spells.flatMap((s) => s.classes))].sort(byString);
  for (const cls of listClasses) {
    const mine = new Set(pdf.spells.filter((s) => (s.classes as string[]).includes(cls)).map((s) => spellId(s.name)));
    const page = foundryLists ? Object.entries(foundryLists).find(([name]) => normName(name).toLowerCase() === `${cls} spell list`) : undefined;
    const theirs = new Set<string>();
    let notInPdf = 0;
    for (const fid of page?.[1] ?? []) {
      const r = recById.get(fid);
      const s = r ? pdfByName.get(normName(r.name)) : undefined;
      if (s) theirs.add(spellId(s.name));
      else notInPdf++;
    }
    out[cls] = {
      pdf: mine.size,
      foundry: page ? page[1].length : 0,
      agree: [...mine].filter((x) => theirs.has(x)).length,
      pdfOnly: [...mine].filter((x) => !theirs.has(x)).sort(byString),
      foundryOnly: [...theirs].filter((x) => !mine.has(x)).sort(byString),
      foundryNotInPdf: notInPdf,
    };
  }
  return out;
}

export interface Review {
  readonly tool: 'tools/import-srd';
  readonly inputs: { readonly srdIndexSha256: string; readonly packOutputSha256: string; readonly votes: Record<string, string> };
  readonly classTables: TableReview;
  readonly spellLists: Record<string, SpellListReview>;
  readonly spellListTableGaps: { class: string; level: number; spell: string }[];
  /** M3 step 6: the spell cross-check (crosscheck-spells.ts), when spells were imported. */
  readonly spells?: SpellReview;
  /** M3 step 6: the monster cross-check (crosscheck-monsters.ts), when monsters were imported. */
  readonly monsters?: MonsterReview;
}

export function buildReview(args: {
  classDocs: Readonly<Record<string, unknown>>;
  pdf: SrdIndex;
  votes: Votes | undefined;
  foundryLists: Readonly<Record<string, readonly string[]>> | undefined;
  records: readonly FoundryRecord[];
  srdIndexSha256: string;
  packOutputSha256: string;
  pins: Pins;
  spells?: SpellReview | undefined;
  monsters?: MonsterReview | undefined;
}): Review {
  const voteShas: Record<string, string> = {};
  for (const [f, p] of Object.entries(args.pins.open5e.files)) voteShas[`open5e/${f}`] = p.sha256;
  if (args.pins.bits.files['Levels.json']) voteShas['bits/Levels.json'] = args.pins.bits.files['Levels.json'].sha256;
  if (args.spells && !('available' in args.spells.bits) && args.pins.bits.files['Spells.json']) voteShas['bits/Spells.json'] = args.pins.bits.files['Spells.json'].sha256;
  if (args.monsters && !('available' in args.monsters.bits) && args.pins.bits.files['Monsters.json']) voteShas['bits/Monsters.json'] = args.pins.bits.files['Monsters.json'].sha256;
  return {
    tool: 'tools/import-srd',
    inputs: { srdIndexSha256: args.srdIndexSha256, packOutputSha256: args.packOutputSha256, votes: voteShas },
    classTables: crosscheckTables(args.classDocs, args.pdf, args.votes),
    spellLists: crosscheckSpellLists(args.pdf, args.foundryLists, args.records),
    spellListTableGaps: args.pdf.spellListTableGaps.map((g) => ({ class: g.class, level: g.level, spell: spellId(g.name) })).sort((a, b) => byString(`${a.class} ${a.spell}`, `${b.class} ${b.spell}`)),
    ...(args.spells ? { spells: args.spells } : {}),
    ...(args.monsters ? { monsters: args.monsters } : {}),
  };
}

export const renderReview = (r: Review): string => stableJson(r);

/** The class items of a plan or a pack on disk, by class id (their srd id without the prefix). */
export function classDocsOf(files: ReadonlyMap<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [rel, text] of [...files].sort((a, b) => byString(a[0], b[0]))) {
    if (!rel.startsWith('packs/srd-5.2.1/classes/')) continue;
    const doc = parseYaml(text);
    if (isRecord(doc) && doc.kind === 'class' && typeof doc.id === 'string') out[doc.id.replace(/^srd:/, '')] = doc;
  }
  return out;
}

/** The vote files from the cache, each checked against its pin before it is parsed (fail closed). */
export function loadVotes(open5eDir: string, bitsDir: string, pins: Pins): Votes {
  const read = (dir: string, name: string, want: string): unknown => {
    const abs = join(dir, name);
    if (!existsSync(abs)) throw new Error(`${abs} is missing; run node tools/import-srd/fetch.ts`);
    const bytes = readFileSync(abs);
    if (sha256(bytes) !== want) throw new Error(`${abs} does not match its pin; fail closed (rerun fetch.ts)`);
    return JSON.parse(bytes.toString('utf8')) as unknown;
  };
  const open5e: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(pins.open5e.files).sort((a, b) => byString(a[0], b[0]))) {
    const m = /^c-([a-z]+)\.json$/.exec(name);
    if (m) open5e[m[1]!] = read(open5eDir, name, p.sha256);
  }
  const lv = pins.bits.files['Levels.json'];
  if (!lv) throw new Error('pins.json has no 5e-bits Levels.json');
  return { open5e, bitsLevels: read(bitsDir, 'Levels.json', lv.sha256) };
}

/** One line per pattern for the import summary. */
export function reviewSummary(r: Review): string[] {
  const t = r.classTables;
  const lines = [
    `class tables: ${t.classes} classes, ${t.cells} cells; ours vs PDF ${t.oursVsPdf.mismatches} mismatch(es)`,
    `  votes: open5e ${t.votes.open5e.agree}/${t.votes.open5e.compared} agree (${t.votes.open5e.absent} absent), 5e-bits ${t.votes.bits.agree}/${t.votes.bits.compared} agree (${t.votes.bits.absent} absent)`,
  ];
  for (const k of Object.keys(t.byPattern).sort(byString)) lines.push(`  differs from the PDF: ${k} only: ${t.byPattern[k]} cell(s)`);
  for (const d of t.disagreements) lines.push(`    ${d.class} ${d.column} level ${d.level}: pdf ${d.pdf}, ours ${d.ours}, open5e ${d.open5e}, 5e-bits ${d.bits}`);
  const sl = Object.entries(r.spellLists).filter(([, s]) => s.pdfOnly.length || s.foundryOnly.length || s.foundryNotInPdf);
  lines.push(`spell lists (PDF headers vs Foundry content24): ${Object.keys(r.spellLists).length} lists, ${sl.length} differ; PDF list-table gaps ${r.spellListTableGaps.length}`);
  for (const [c, s] of sl) lines.push(`  ${c}: pdf ${s.pdf}, foundry ${s.foundry}, pdf-only ${s.pdfOnly.length}, foundry-only ${s.foundryOnly.length}, foundry not in PDF ${s.foundryNotInPdf}`);
  if (r.spells) lines.push(...spellReviewSummary(r.spells));
  if (r.monsters) lines.push(...monsterReviewSummary(r.monsters));
  return lines;
}
