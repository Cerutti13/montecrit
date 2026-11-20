// The Weapons and Armor tables, from `pdftotext -layout` text. Rows are aligned columns;
// category lines ("Simple Melee Weapons", "Light Armor (1 Minute to Don or Doff)") group
// them, and a Properties cell that wraps leaves a continuation line, appended to the row above.
// Only names, categories, numbers and the closed property and mastery names are kept (no rules
// text): SRD 5.2.1 p.91, srd-raw.txt:20470-20900 (the same table read as plain text).

export interface Weapon {
  readonly name: string;
  /** "simple-melee", "simple-ranged", "martial-melee", "martial-ranged". */
  readonly category: string;
  /** "1d8", "2d6", or "1" (Blowgun). */
  readonly damage: string;
  readonly damageType: string;
  readonly mastery: string;
  /**
   * M3 step 5b: the Properties cell as the closed property names (finesse, light, heavy,
   * two-handed, versatile, thrown, ammunition, loading, reach), in the order printed. The Lance's
   * "Two-Handed (unless mounted)" reads as two-handed (mounted combat isn't modeled).
   */
  readonly properties: readonly string[];
  /** Thrown or Ammunition's "(Range N/M ...)": [normal, long]. */
  readonly range?: readonly [number, number];
  /** Versatile's "(1d10)": the two-handed damage die. */
  readonly versatile?: string;
  /** Ammunition's kind: "(Range 80/320; Arrow)" -> arrow. */
  readonly ammunition?: string;
  readonly page: number;
}

export interface Armor {
  readonly name: string;
  /** "light", "medium", "heavy", "shield". */
  readonly category: string;
  /** Base AC; for the Shield, the bonus. */
  readonly ac: number;
  /** Light and Medium add Dex; dexMax is Medium's cap. */
  readonly addDex: boolean;
  readonly dexMax?: number;
  /** Strength score needed to avoid the speed penalty. */
  readonly strength?: number;
  readonly stealthDisadvantage: boolean;
  readonly page: number;
}

const WEAPON_CAT = /^\s*(Simple|Martial) (Melee|Ranged) Weapons\s*$/;
const WEAPON_ROW = /^\s+(\S.*?)\s+(\d+d\d+|1) (Bludgeoning|Piercing|Slashing)\s+(\S.*?)\s{2,}(Cleave|Graze|Nick|Push|Sap|Slow|Topple|Vex)\s+(?:[\d/]+ lb\.|—)\s+[\d,]+ [CSEGP]P\s*$/;
/** One Properties cell entry: a property name and its parenthesized detail. */
const PROPERTY = /^(Finesse|Light|Heavy|Two-Handed|Versatile|Thrown|Ammunition|Loading|Reach)(?: \((.*)\))?$/;

/** The Properties cell (already joined across a wrap) to the closed names and their details. */
export function parseWeaponProperties(cell: string, where: string): Pick<Weapon, 'properties' | 'range' | 'versatile' | 'ammunition'> {
  const out: { properties: string[]; range?: [number, number]; versatile?: string; ammunition?: string } = { properties: [] };
  if (cell.trim() === '—') return out;
  // Split on commas outside parentheses ("Ammunition (Range 80/320; Bolt), Loading, Two-Handed").
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of cell) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  parts.push(cur.trim());
  for (const part of parts) {
    const m = PROPERTY.exec(part);
    if (!m) throw new Error(`${where}: property "${part}" is not in the closed list`);
    const name = m[1]!.toLowerCase();
    const detail = m[2];
    if (out.properties.includes(name)) throw new Error(`${where}: ${name} is listed twice`);
    out.properties.push(name);
    if (name === 'thrown' || name === 'ammunition') {
      const r = detail === undefined ? null : /^Range (\d+)\/(\d+)(?:; (\w+))?$/.exec(detail);
      if (!r || (name === 'ammunition') !== (r[3] !== undefined)) throw new Error(`${where}: ${name} detail "${detail ?? ''}" is not "Range N/M${name === 'ammunition' ? '; Kind' : ''}"`);
      if (out.range) throw new Error(`${where}: two ranges`);
      out.range = [Number(r[1]), Number(r[2])];
      if (r[3] !== undefined) out.ammunition = r[3].toLowerCase();
    } else if (name === 'versatile') {
      if (detail === undefined || !/^\d+d\d+$/.test(detail)) throw new Error(`${where}: Versatile needs its die, got "${detail ?? ''}"`);
      out.versatile = detail;
    } else if (name === 'two-handed') {
      if (detail !== undefined && detail !== 'unless mounted') throw new Error(`${where}: Two-Handed detail "${detail}" is not known`);
    } else if (detail !== undefined) throw new Error(`${where}: ${name} has an unexpected detail "${detail}"`);
  }
  return out;
}
const ARMOR_CAT = /^\s*(Light|Medium|Heavy) Armor \(.*\)\s*$|^\s*(Shield) \(.*\)\s*$/;
const ARMOR_ROW = /^\s+(\S.*?)\s{2,}(\+?\d+)( \+ Dex modifier(?: \(max (\d)\))?)?\s{2,}(—|Str (\d+))\s{2,}(Disadvantage|—)\s+[\d.]+ lb\.\s+[\d,]+ GP\s*$/;

function findTable(pages: readonly string[], title: string, next: RegExp): { page: number; lines: string[]; at: number } {
  for (let p = 0; p < pages.length; p++) {
    const lines = pages[p]!.split('\n');
    for (let i = 0; i + 1 < lines.length; i++) {
      if (lines[i]!.trim() === title && next.test(lines[i + 1]!)) return { page: p + 1, lines, at: i + 2 };
    }
  }
  throw new Error(`no "${title}" table`);
}

export function parseWeapons(pages: readonly string[]): Weapon[] {
  const t = findTable(pages, 'Weapons', /^\s*Name\s+Damage\s+Properties\s+Mastery\s+Weight\s+Cost\s*$/);
  const out: Weapon[] = [];
  const rows: { name: string; category: string; damage: string; damageType: string; cell: string; mastery: string }[] = [];
  let category: string | undefined;
  for (let i = t.at; i < t.lines.length; i++) {
    const line = t.lines[i]!;
    if (line.trim() === '') break;
    const cat = WEAPON_CAT.exec(line);
    if (cat) {
      category = `${cat[1]!.toLowerCase()}-${cat[2]!.toLowerCase()}`;
      continue;
    }
    const m = WEAPON_ROW.exec(line);
    if (m && category) {
      rows.push({ name: m[1]!, category, damage: m[2]!, damageType: m[3]!.toLowerCase(), cell: m[4]!.trim(), mastery: m[5]!.toLowerCase() });
      continue;
    }
    // A wrapped Properties cell: deep indent, one cell, continuing the row above.
    if (/^\s{20,}\S/.test(line) && !/\S\s{2,}\S/.test(line.trim()) && rows.length > 0) {
      const last = rows[rows.length - 1]!;
      last.cell = `${last.cell} ${line.trim()}`;
      continue;
    }
    throw new Error(`Weapons table p.${t.page}: unparsed line "${line.trim()}"`);
  }
  for (const r of rows) {
    const p = parseWeaponProperties(r.cell, `Weapons table p.${t.page} ${r.name}`);
    out.push({
      name: r.name,
      category: r.category,
      damage: r.damage,
      damageType: r.damageType,
      mastery: r.mastery,
      properties: p.properties,
      ...(p.range ? { range: p.range } : {}),
      ...(p.versatile ? { versatile: p.versatile } : {}),
      ...(p.ammunition ? { ammunition: p.ammunition } : {}),
      page: t.page,
    });
  }
  return out;
}

export function parseArmor(pages: readonly string[]): Armor[] {
  const t = findTable(pages, 'Armor', /^\s*Armor\s+Armor Class \(AC\)\s+Strength\s+Stealth\s+Weight\s+Cost\s*$/);
  const out: Armor[] = [];
  let category: string | undefined;
  for (let i = t.at; i < t.lines.length; i++) {
    const line = t.lines[i]!;
    if (line.trim() === '') break;
    const cat = ARMOR_CAT.exec(line);
    if (cat) {
      category = (cat[1] ?? cat[2]!).toLowerCase();
      continue;
    }
    const m = ARMOR_ROW.exec(line);
    if (!m || !category) throw new Error(`Armor table p.${t.page}: unparsed line "${line.trim()}"`);
    out.push({
      name: m[1]!,
      category,
      ac: Number(m[2]!.replace('+', '')),
      addDex: m[3] !== undefined,
      ...(m[4] !== undefined ? { dexMax: Number(m[4]) } : {}),
      ...(m[6] !== undefined ? { strength: Number(m[6]) } : {}),
      stealthDisadvantage: m[7] === 'Disadvantage',
      page: t.page,
    });
  }
  return out;
}
