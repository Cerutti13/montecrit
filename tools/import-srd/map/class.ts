// The class mapper (docs/design/m3.md 2.2, 4.3 advancement and spellcasting rows, 4.9; C2,
// C4, C16, C21). One classes24 class record becomes one `kind: class` item, plus a narrative
// stub feature for every class-table feature of the SRD 5.2.1 PDF that no kept Foundry record
// carries (Epic Boon, which Foundry grants by no advancement; Self-Restoration, which has no
// record at the pin). Where each field comes from:
//
//   hitDie          system.hd.denomination, checked against the PDF's hit die
//   saves           the level-1 Trait grants saves:<ability> (primary or unrestricted)
//   proficiencies   level-1 Trait grants armor:/weapon:/tool: (weapon:mar:<base> resolves to the
//                   kept equipment24 weapon with that base item)
//   skills          the level-1 skills Trait choice (also choice id `skills`)
//   subclassLevel   the Subclass advancement, checked against the PDF's "<Class> Subclass" row
//   asiLevels       AbilityScoreImprovement advancements with points, minus the PDF's Epic Boon
//                   level; must equal the PDF's Ability Score Improvement levels exactly
//   spellcasting    system.spellcasting (progression, ability), list srd:list/<class> (C2: the
//                   lists themselves come from the PDF spell headers, spellListFromIndex below;
//                   there is no list kind to emit them into yet), counts as qualified @scale (C16)
//   scale           ScaleValue advancements, ids as Foundry keys them (C16). A column the PDF
//                   class table also prints takes the PDF's values (PDF_COLUMNS); slots are the
//                   PDF's slot columns, never Foundry code (2.2)
//   extraAttacks    granted features named Extra Attack / Two / Three Extra Attacks
//   pools           uses of granted features at levels 1-10 (max as an expression, recovery 1:1)
//   acFormulas      a granted feature's ac.calc effect, by a closed table written from the PDF
//   features        ItemGrant advancements, only where the (class, level, name) tuple passed
//   choices         skills, expertise, Primal Knowledge-style skill picks, Fighting Style feats
//
// What the data kinds can't express yet becomes a templated line (weapon masteries, tool picks,
// class-feature options the gate can't tuple, granted spells, Foundry's cr scale column), so
// the class is partial until a later step takes them.

import { WEAPON_MASTERY } from '../../../packages/engine/src/content/character.ts';
import { advancementsOf, foreignIdOf, licenseDrop, normName, type Kept } from '../filter.ts';
import { identOf } from '../ids.ts';
import type { IndexClass, IndexFeature, SrdIndex } from '../pdf/build.ts';
import type { FoundryRecord } from '../read.ts';
import { U } from '../unimplemented.ts';
import { byString, getPath, isRecord } from '../util.ts';
import type { MapCtx, Mapper, MapOutput } from './types.ts';

export type Rec = Record<string, unknown>;

export const ABILITIES: readonly string[] = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

export const kebab = (s: string): string => identOf({}, s);

export const pageSource = (page: number): string => `SRD 5.2.1 p.${page}`;

/**
 * The parsed srd-index.json. Without it the class-side mappers map nothing (fail closed: the
 * records count as unmapped); main.ts always passes it.
 */
export function pdfOf(ctx: MapCtx): SrdIndex | undefined {
  return ctx.pdf;
}

/** The local id an owner's features nest under: a class's identifier, a subclass's kebab-case name. */
export function ownerIdent(rec: FoundryRecord): string {
  return rec.type === 'subclass' ? kebab(rec.name) : identOf(rec.doc, rec.name);
}

/** The Foundry class identifier a class or subclass record belongs to. */
export function classIdentOf(rec: FoundryRecord): string {
  const v = getPath(rec.doc, rec.type === 'subclass' ? 'system.classIdentifier' : 'system.identifier');
  if (typeof v !== 'string' || !v) throw new Error(`${rec.path}: no class identifier`);
  return v;
}

/** The first gate-passing owner's record (owners are sorted by level, then name). */
export function firstOwner(k: Kept, ctx: MapCtx): Kept {
  const o = k.owners[0];
  const ok = o ? ctx.lookup(o.foreignId) : undefined;
  if (!ok) throw new Error(`${k.rec.path}: a ${k.kind} needs a kept owner`);
  return ok;
}

/**
 * Our id for a class or subclass feature: srd:<owner>/<feature identifier>, the owner being the
 * class's identifier or the subclass's kebab-case name (srd:warrior-of-the-open-hand/...).
 */
export function featureIdOf(k: Kept, ctx: MapCtx): string {
  return `srd:${ownerIdent(firstOwner(k, ctx).rec)}/${identOf(k.rec.doc, k.rec.name)}`;
}

/** The level a feature is granted at: its lowest gate-passing owner's. */
export const featureLevel = (k: Kept): number => k.owners[0]?.level ?? 1;

const SKILL_CODES: Readonly<Record<string, string>> = {
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
const ALL_SKILLS: readonly string[] = Object.values(SKILL_CODES).sort(byString);

const ARMOR_CODES: Readonly<Record<string, string>> = { lgt: 'light', med: 'medium', hvy: 'heavy', shl: 'shield' };

/** Tool grants by Foundry key, named as the SRD names them (p.95-96). A key not here fails the import. */
const TOOL_CODES: Readonly<Record<string, string>> = { herb: 'Herbalism Kit', thief: "Thieves' Tools" };

/** Skills from a Trait pool: skills:<code> or skills:* (any). Undefined when the pool isn't skills. */
function skillPool(pool: readonly unknown[], where: string): string[] | undefined {
  if (!pool.every((p) => typeof p === 'string' && p.startsWith('skills:'))) return undefined;
  if (pool.includes('skills:*')) return [...ALL_SKILLS];
  return pool
    .map((p) => {
      const s = SKILL_CODES[(p as string).slice(7)];
      if (!s) throw new Error(`${where}: unknown skill key ${String(p)}`);
      return s;
    })
    .sort(byString);
}

/**
 * Unarmored Defense-style AC (Foundry's system.attributes.ac.calc override), written from the
 * PDF text: Barbarian p.29 (Shield allowed), Monk p.50 (no armor, no Shield), Draconic
 * Resilience p.69 (no armor). Closed: a calc id not here is a templated effect-key line.
 */
export const AC_CALCS: Readonly<Record<string, { readonly when: readonly string[]; readonly ac: string }>> = {
  unarmoredBarb: { when: ['unarmored'], ac: '10 + @mod.dex + @mod.con' },
  unarmoredMonk: { when: ['unarmored', 'noShield'], ac: '10 + @mod.dex + @mod.wis' },
  unarmoredBard: { when: ['unarmored'], ac: '10 + @mod.dex + @mod.cha' },
};

/** A record's effects as plain objects, and each effect's changes (Foundry keeps them under system.changes). */
export function effectsOf(doc: Readonly<Rec>): Rec[] {
  const e = doc.effects;
  return Array.isArray(e) ? e.filter(isRecord) : [];
}
export function changesOf(e: Rec): Rec[] {
  const c = getPath(e, 'system.changes') ?? e.changes;
  return Array.isArray(c) ? c.filter(isRecord) : [];
}

/** The acFormulas a feature's always-on effects give, through AC_CALCS. */
function acFormulasOf(doc: Readonly<Rec>): { when: string[]; ac: string }[] {
  const out: { when: string[]; ac: string }[] = [];
  for (const e of effectsOf(doc)) {
    if (e.transfer !== true || e.disabled === true) continue;
    for (const c of changesOf(e)) {
      if (c.key !== 'system.attributes.ac.calc' || c.type !== 'override' || typeof c.value !== 'string') continue;
      const f = AC_CALCS[c.value];
      if (f) out.push({ when: [...f.when], ac: f.ac });
    }
  }
  return out;
}

// ---- grants -------------------------------------------------------------------------

export interface GrantEntry {
  readonly level: number;
  readonly id: string;
  /** The kept feature record, or the quarantined one an override must stand in for. */
  readonly kept?: Kept | undefined;
}

/**
 * The features an owner (class or subclass) grants by ItemGrant, by level. A kept feature is
 * listed only at a level where its (owner, level, name) tuple passed the gate (C4). A granted
 * spell is a line (step 6); a quarantined record (license) is listed under the id an override
 * must provide (C21: fail closed if it doesn't) and is a line; a record the gate dropped is
 * not SRD as named and is left out; a pointer with no record at the pin is left out (the PDF
 * stubs cover SRD features).
 */
/** The PDF feature row (owner, level, name) of a class or subclass record, if the PDF prints one. */
export function pdfRowFor(ctx: Pick<MapCtx, 'pdf'>, owner: FoundryRecord, level: number, name: string): Pick<IndexFeature, 'level' | 'name' | 'page'> | undefined {
  const pdf = ctx.pdf;
  if (!pdf) return undefined;
  const rows = owner.type === 'subclass' ? pdf.subclasses[kebab(owner.name)]?.features : pdf.classes[classIdentOf(owner) as keyof SrdIndex['classes']]?.features;
  const n = normName(name);
  return (rows ?? []).find((f) => f.level === level && normName(f.name) === n);
}

/** A feature an owner already carries (kept or quarantined), for pdfStubs. */
export interface HaveFeature {
  readonly level: number;
  readonly name: string;
  readonly id: string;
}

export function readGrants(ctx: MapCtx, owner: FoundryRecord): { entries: GrantEntry[]; lines: string[]; quarantinedNames: HaveFeature[] } {
  const entries: GrantEntry[] = [];
  const lines: string[] = [];
  const quarantinedNames: HaveFeature[] = [];
  for (const adv of advancementsOf(owner)) {
    if (adv.type !== 'ItemGrant' || typeof adv.level !== 'number') continue;
    const level = adv.level;
    const items = getPath(adv, 'configuration.items');
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      const uuid = isRecord(it) ? it.uuid : undefined;
      if (typeof uuid !== 'string') continue;
      ctx.uuid(uuid, 'system.advancement.ItemGrant');
      if (!uuid.startsWith('Compendium.dnd5e.')) continue;
      const fid = foreignIdOf(uuid);
      const k = ctx.lookup(fid);
      if (k) {
        // A granted spell (kept now that spells are imported, M3 step 6) still has no place in
        // class data: the line stays until classes can grant spells.
        if (k.kind === 'spell') lines.push(U.spellGrants());
        else if (k.kind === 'feature' && k.owners.some((o) => o.foreignId === owner.id && o.level === level)) entries.push({ level, id: featureIdOf(k, ctx), kept: k });
        continue;
      }
      const d = ctx.dropped(fid);
      if (!d) continue;
      if (d.type === 'spell') {
        lines.push(U.spellGrants());
        continue;
      }
      if (licenseDrop(d)) {
        // A quarantined equipment grant (the generic Unarmed Strike weapon) isn't a feature.
        if (d.pack !== 'classes24') {
          lines.push(U.quarantinedGrant());
          continue;
        }
        // A quarantined class feature passes the same (owner, level, name) gate as a kept one
        // (C4): only a PDF table row is listed, under the id its override must provide. One
        // with no PDF row is not SRD as named and is left out, like a gate drop; its id is
        // never derived from the record.
        if (!pdfRowFor(ctx, owner, level, d.name)) continue;
        lines.push(U.quarantinedGrant());
        quarantinedNames.push({ level, name: d.name, id: `srd:${ownerIdent(owner)}/${identOf(d.doc, d.name)}` });
        entries.push({ level, id: `srd:${ownerIdent(owner)}/${identOf(d.doc, d.name)}` });
      }
    }
  }
  return { entries, lines, quarantinedNames };
}

/**
 * Narrative stubs for the PDF's feature rows that no kept record carries (C21). Skipped: Ability
 * Score Improvement (asiLevels), the "<Class> Subclass" rows (subclassLevel) and repeats with no
 * heading of their own. Rows are keyed on (level, name): a described row whose name a granted
 * record has at another level (Improved Brutal Strike at 13 and 17) lists that record's id at
 * the row's level too, so no described row goes missing.
 */
export function pdfStubs(
  ownerRec: FoundryRecord,
  rows: readonly (Pick<IndexFeature, 'level' | 'name' | 'page'> & { readonly described?: boolean })[],
  have: readonly HaveFeature[],
  skip: (name: string) => boolean,
): { outputs: MapOutput[]; entries: GrantEntry[] } {
  const byName = new Map<string, HaveFeature[]>();
  for (const h of have) {
    const n = normName(h.name);
    const list = byName.get(n) ?? [];
    list.push(h);
    byName.set(n, list);
  }
  const outputs: MapOutput[] = [];
  const entries: GrantEntry[] = [];
  const seen = new Set<string>();
  for (const f of rows) {
    if (f.described === false || skip(f.name)) continue;
    const had = byName.get(normName(f.name));
    if (had) {
      if (!had.some((h) => h.level === f.level)) {
        const ids = [...new Set(had.map((h) => h.id))];
        if (ids.length !== 1) throw new Error(`${ownerRec.path}: PDF row ${f.level} ${f.name} matches ${ids.length} granted features`);
        entries.push({ level: f.level, id: ids[0]! });
      }
      continue;
    }
    const name = f.name.replace(/[‘’]/g, "'");
    const id = `srd:${ownerIdent(ownerRec)}/${kebab(name)}`;
    entries.push({ level: f.level, id });
    if (seen.has(id)) continue;
    seen.add(id);
    outputs.push({
      kind: 'feature',
      item: { kind: 'feature', id, name, source: pageSource(f.page) },
      unimplemented: f.level > 10 ? [U.levelsAbove10()] : [],
      // shape 'data': the stub is built from the PDF row, so the owner's description trigger
      // words (main.ts adds them to program shapes) say nothing about it. Narrative either way.
      classify: { maps: false, shape: 'data', hasDuration: false },
      pdfPage: f.page,
    });
  }
  return { outputs, entries };
}

/** What an owner's grants already carry, by (level, name, id), for pdfStubs. */
export function haveOf(grants: ReturnType<typeof readGrants>): HaveFeature[] {
  return [...grants.entries.flatMap((e) => (e.kept ? [{ level: e.level, name: e.kept.rec.name, id: e.id }] : [])), ...grants.quarantinedNames];
}

/** Feature ids by level, each level's ids sorted and de-duplicated. */
export function byLevel(entries: readonly GrantEntry[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const e of entries) {
    const l = String(e.level);
    const list = out[l] ?? (out[l] = []);
    if (!list.includes(e.id)) list.push(e.id);
  }
  for (const l of Object.keys(out)) out[l]!.sort(byString);
  return out;
}

// ---- scale columns ------------------------------------------------------------------

/**
 * Class-table columns the PDF prints, by Foundry scale identifier -> PDF column id
 * (srd-index.json). Closed and reviewed: every PDF column other than the proficiency bonus and
 * the slot columns must be claimed here (scaleOf checks), so no printed number goes unread.
 */
export const PDF_COLUMNS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  barbarian: { rages: 'rages', 'rage-damage': 'rage-damage', mastery: 'weapon-mastery' },
  bard: { 'max-prepared': 'prepared-spells', 'cantrips-known': 'cantrips', inspiration: 'bardic-die' },
  cleric: { 'channel-divinity': 'channel-divinity', 'max-prepared': 'prepared-spells', 'cantrips-known': 'cantrips' },
  druid: { 'cantrips-known': 'cantrips', 'max-prepared': 'prepared-spells', 'wild-shape-uses': 'wild-shape' },
  fighter: { 'second-wind': 'second-wind', mastery: 'weapon-mastery' },
  monk: { die: 'martial-arts', focus: 'focus-points', 'unarmored-movement': 'unarmored-movement' },
  paladin: { 'channel-divinity': 'channel-divinity', 'max-prepared': 'prepared-spells' },
  ranger: { 'favored-enemy': 'favored-enemy', 'max-prepared': 'prepared-spells' },
  rogue: { 'sneak-attack': 'sneak-attack' },
  sorcerer: { 'max-prepared': 'prepared-spells', 'cantrips-known': 'cantrips', points: 'sorcery-points' },
  warlock: { 'invocations-known': 'eldritch-invocations', 'cantrips-known': 'cantrips', 'max-prepared': 'prepared-spells' },
  wizard: { 'max-prepared': 'prepared-spells', 'cantrips-known': 'cantrips' },
};

const NOT_SCALE_COLUMNS: readonly string[] = ['proficiency-bonus', 'spell-slots', 'slot-level'];

export type ScaleCol =
  | { type: 'dice'; at: Record<string, string> }
  | { type: 'number'; at: Record<string, number> }
  | { type: 'slots'; at: Record<string, number[]> };

/** One PDF cell sequence as breakpoints: a value from the level it first appears, leading dashes (0) skipped. */
function breakpoints<T>(values: readonly number[], conv: (v: number) => T, where: string): Record<string, T> {
  const at: Record<string, T> = {};
  let prev: number | undefined;
  values.forEach((v, i) => {
    if (v === 0) {
      if (prev !== undefined) throw new Error(`${where}: a dash after a value at level ${i + 1}`);
      return;
    }
    if (v !== prev) at[String(i + 1)] = conv(v);
    prev = v;
  });
  return at;
}

/** A column's value at each level 1-20 from its breakpoints (undefined before the first). */
function expand<T>(at: Readonly<Record<string, T>>): (T | undefined)[] {
  const out: (T | undefined)[] = [];
  let cur: T | undefined;
  for (let l = 1; l <= 20; l++) {
    if (Object.hasOwn(at, String(l))) cur = at[String(l)];
    out.push(cur);
  }
  return out;
}

export interface ScaleDisagreement {
  readonly column: string;
  readonly level: number;
  readonly foundry: string | number | undefined;
  readonly pdf: string | number | undefined;
}

/** A ScaleValue advancement's column id: its identifier, else its title kebab-cased (Foundry's own fallback). */
export function scaleIdOf(adv: Rec): string {
  const ident = getPath(adv, 'configuration.identifier');
  const id = typeof ident === 'string' && ident ? ident : typeof adv.title === 'string' ? kebab(adv.title) : '';
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id)) throw new Error(`a ScaleValue has no usable identifier (${JSON.stringify(adv.title)})`);
  return id;
}

/**
 * The scale columns of a class or subclass record. `pdf` (classes only) supplies the printed
 * columns, which win over Foundry's values; every disagreement is returned for the summary.
 */
export function scaleOf(rec: FoundryRecord, pdf: IndexClass | undefined, cls: string): { scale: Record<string, ScaleCol>; lines: string[]; disagreements: ScaleDisagreement[] } {
  const scale: Record<string, ScaleCol> = {};
  const lines: string[] = [];
  const disagreements: ScaleDisagreement[] = [];
  const claim = PDF_COLUMNS[cls] ?? {};
  const claimed = new Set<string>();
  for (const adv of advancementsOf(rec)) {
    if (adv.type !== 'ScaleValue') continue;
    const id = scaleIdOf(adv);
    if (Object.hasOwn(scale, id)) throw new Error(`${rec.path}: scale column ${id} twice`);
    const type = getPath(adv, 'configuration.type');
    const raw = getPath(adv, 'configuration.scale');
    if (!isRecord(raw)) throw new Error(`${rec.path}: scale column ${id} has no scale`);
    const levels = Object.keys(raw).sort((a, b) => Number(a) - Number(b));
    let col: ScaleCol;
    if (type === 'dice') {
      const at: Record<string, string> = {};
      for (const l of levels) {
        const v = raw[l] as Rec;
        if (typeof v.faces !== 'number' || !Number.isInteger(v.faces)) throw new Error(`${rec.path}: scale ${id} level ${l} has no die`);
        const n = typeof v.number === 'number' ? v.number : 1;
        at[l] = `${n}d${v.faces}`;
      }
      col = { type: 'dice', at };
    } else if (type === 'number' || type === 'distance') {
      const at: Record<string, number> = {};
      for (const l of levels) {
        const v = (raw[l] as Rec).value;
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new Error(`${rec.path}: scale ${id} level ${l} is not a whole number`);
        at[l] = v;
      }
      col = { type: 'number', at };
    } else {
      lines.push(U.scaleType(typeof type === 'string' && /^[a-z][a-zA-Z0-9_-]{0,40}$/.test(type) ? type : 'unknown'));
      continue;
    }
    const pdfCol = claim[id];
    if (pdfCol !== undefined && pdf) {
      const values = pdf.table.columns[pdfCol];
      if (!values) throw new Error(`${rec.path}: the PDF table has no column ${pdfCol} (PDF_COLUMNS)`);
      claimed.add(pdfCol);
      const unit = pdf.table.units[pdfCol];
      const where = `${cls} table column ${pdfCol}`;
      const fromPdf: ScaleCol =
        col.type === 'dice'
          ? { type: 'dice', at: breakpoints(values, (v) => (unit === 'd6' ? `${v}d6` : unit === 'die' ? `1d${v}` : thrower(where)), where) }
          : { type: 'number', at: breakpoints(values, (v) => v, where) };
      const a = expand<string | number>(col.at);
      const b = expand<string | number>(fromPdf.at);
      for (let l = 0; l < 20; l++) if (a[l] !== b[l]) disagreements.push({ column: id, level: l + 1, foundry: a[l], pdf: b[l] });
      col = fromPdf;
    }
    scale[id] = col;
  }
  if (pdf) {
    for (const c of pdf.table.columnOrder) {
      if (c.startsWith('slot-') || NOT_SCALE_COLUMNS.includes(c) || claimed.has(c)) continue;
      throw new Error(`${rec.path}: the PDF table column ${c} is claimed by no scale column (PDF_COLUMNS)`);
    }
    const slots = slotsOf(pdf, cls);
    if (slots) {
      if (Object.hasOwn(scale, 'slots')) throw new Error(`${rec.path}: a scale column is already named slots`);
      scale.slots = slots;
    }
  }
  return { scale, lines, disagreements };
}

const thrower = (where: string): never => {
  throw new Error(`${where}: a dice column needs a die unit`);
};

/**
 * Spell slots from the PDF table (2.2: class-table data, never Foundry code): slot-1..slot-9
 * for full and half casters, spell-slots at slot-level for Pact Magic. As a pc's slots: [4, 3]
 * is four 1st and three 2nd. Breakpoints where the row changes.
 */
export function slotsOf(pdf: IndexClass, cls: string): ScaleCol | undefined {
  const cols = pdf.table.columns;
  const rows: number[][] = [];
  if (cols['slot-1']) {
    for (let l = 0; l < 20; l++) {
      const row: number[] = [];
      for (let s = 1; s <= 9; s++) row.push(cols[`slot-${s}`]?.[l] ?? 0);
      while (row.length && row[row.length - 1] === 0) row.pop();
      rows.push(row);
    }
  } else if (cols['spell-slots'] && cols['slot-level']) {
    for (let l = 0; l < 20; l++) {
      const n = cols['spell-slots'][l]!;
      const at = cols['slot-level'][l]!;
      if (at < 1 || at > 9) throw new Error(`${cls}: slot level ${at} at level ${l + 1}`);
      const row = new Array<number>(at).fill(0);
      row[at - 1] = n;
      rows.push(row);
    }
  } else return undefined;
  const at: Record<string, number[]> = {};
  let prev = '';
  rows.forEach((r, i) => {
    const key = r.join(',');
    if (key !== prev && r.length) at[String(i + 1)] = r;
    prev = key;
  });
  return { type: 'slots', at };
}

// ---- spell lists (C2) -----------------------------------------------------------------

/**
 * A class's spell list from the PDF spell headers (C2: "Level N School (Class, ...)" names the
 * lists; the four known list-table gaps stay on the list because the headers decide). Names,
 * sorted. Not emitted in step 2: the schema has no list kind and spells are imported at step 6,
 * so the class only names its list (spellcasting.list srd:list/<class>).
 */
export function spellListFromIndex(pdf: SrdIndex, cls: string): { level: number; name: string }[] {
  return pdf.spells
    .filter((s) => s.classes.includes(cls as never))
    .map((s) => ({ level: s.level, name: s.name }))
    .sort((a, b) => a.level - b.level || byString(a.name, b.name));
}

// ---- pools --------------------------------------------------------------------------

const PERIODS: Readonly<Record<string, 'short' | 'long' | 'dawn'>> = { sr: 'short', lr: 'long', dawn: 'dawn' };

/**
 * A pool from a feature's uses (2.4): id the feature's identifier, max as an expression
 * (formula.ts), recovery mapped 1:1 (metadata only, hard rule 4). Undefined when the uses have
 * no max or no recovery; a max that doesn't convert gives its lines instead.
 */
export function poolOf(k: Kept, ctx: MapCtx, ownerClass: string): { pool?: Rec; lines: string[] } {
  const uses = getPath(k.rec.doc, 'system.uses');
  if (!isRecord(uses)) return { lines: [] };
  const max = uses.max;
  const rec = Array.isArray(uses.recovery) ? uses.recovery.filter(isRecord) : [];
  if ((typeof max !== 'string' && typeof max !== 'number') || max === '' || rec.length === 0) return { lines: [] };
  const f = ctx.formula(max, { ownerClass });
  if (!f.ok) return { lines: [...f.lines] };
  const recharge = rec.map((r) => {
    const period = typeof r.period === 'string' ? PERIODS[r.period] : undefined;
    if (!period) throw new Error(`${k.rec.path}: unknown recovery period ${String(r.period)}`);
    if (r.type === 'recoverAll') return { period, amount: 'all' };
    if (r.type === 'formula') {
      const a = ctx.formula(typeof r.formula === 'string' || typeof r.formula === 'number' ? r.formula : '', { ownerClass });
      if (!a.ok) throw new Error(`${k.rec.path}: recovery formula doesn't convert`);
      return { period, amount: /^\d+$/.test(a.expr) ? Number(a.expr) : a.expr };
    }
    throw new Error(`${k.rec.path}: unknown recovery type ${String(r.type)}`);
  });
  return {
    pool: { id: identOf(k.rec.doc, k.rec.name), name: k.rec.name, max: /^\d+$/.test(f.expr) ? Number(f.expr) : f.expr, recharge },
    lines: [],
  };
}

// ---- traits and choices -----------------------------------------------------------------

export interface TraitResult {
  saves: string[];
  armor: string[];
  weapons: string[];
  tools: string[];
  skills?: { choose: number; from: string[] };
  choices: Rec[];
  lines: string[];
  /** Weapon Mastery's mastery Trait advancements: kinds added at each level (M3 step 5b). */
  mastery: { level: number; count: number }[];
}

/** The base-item key of a kept equipment24 weapon record -> our id. */
function weaponIdByBase(ctx: MapCtx, base: string, where: string): string {
  const hits = ctx.allKept.filter((k) => k.kind === 'weapon' && getPath(k.rec.doc, 'system.type.baseItem') === base);
  if (hits.length !== 1) throw new Error(`${where}: weapon proficiency ${base} matches ${hits.length} kept weapon record(s)`);
  const id = ctx.idOf(hits[0]!.rec.id);
  if (!id) throw new Error(`${where}: no id for the ${base} weapon`);
  return id;
}

/**
 * Trait advancements. Multiclass (secondary) traits are skipped (single class in M3, C24);
 * languages aren't modeled; weapon masteries and tool picks are lines (5b and later).
 */
export function readTraits(ctx: MapCtx, rec: FoundryRecord): TraitResult {
  const out: TraitResult = { saves: [], armor: [], weapons: [], tools: [], choices: [], lines: [], mastery: [] };
  for (const adv of advancementsOf(rec)) {
    if (adv.type !== 'Trait' || adv.classRestriction === 'secondary') continue;
    const level = typeof adv.level === 'number' ? adv.level : 1;
    const mode = getPath(adv, 'configuration.mode') ?? 'default';
    const grants = (getPath(adv, 'configuration.grants') as unknown[] | undefined) ?? [];
    const choices = ((getPath(adv, 'configuration.choices') as unknown[] | undefined) ?? []).filter(isRecord);
    const where = `${rec.path} Trait at level ${level}`;
    if (mode === 'mastery') {
      out.lines.push(U.choiceNotMapped('weapon-mastery'));
      for (const ch of choices) if (typeof ch.count === 'number') out.mastery.push({ level, count: ch.count });
      continue;
    }
    if (mode === 'expertise') {
      for (const ch of choices) {
        const from = skillPool(Array.isArray(ch.pool) ? ch.pool : [], where);
        if (!from || typeof ch.count !== 'number') throw new Error(`${where}: an expertise choice that isn't skills`);
        out.choices.push({ id: `expertise-${level}`, level, choose: ch.count, from: { skills: from }, grants: 'expertise' });
      }
      continue;
    }
    if (mode !== 'default') throw new Error(`${where}: unknown Trait mode ${String(mode)}`);
    for (const g of grants) {
      if (typeof g !== 'string') continue;
      const [kind, a, b] = g.split(':');
      if (kind === 'languages') continue;
      if (level > 1) {
        // Later grants (a level-15 save proficiency) belong to features above the mapped levels.
        if (level <= 10) out.lines.push(U.choiceNotMapped(`grant-${kind}`));
        continue;
      }
      if (kind === 'saves' && a && ABILITIES.includes(a)) out.saves.push(a);
      else if (kind === 'armor' && a && ARMOR_CODES[a]) out.armor.push(ARMOR_CODES[a]);
      else if (kind === 'weapon' && (a === 'sim' || a === 'mar') && b === undefined) out.weapons.push(a === 'sim' ? 'simple' : 'martial');
      else if (kind === 'weapon' && a === 'mar' && b) out.weapons.push(weaponIdByBase(ctx, b, where));
      else if (kind === 'tool' && a && TOOL_CODES[a] && b === undefined) out.tools.push(TOOL_CODES[a]);
      else throw new Error(`${where}: unknown grant ${g}`);
    }
    for (const ch of choices) {
      const pool = Array.isArray(ch.pool) ? ch.pool : [];
      const count = ch.count;
      if (typeof count !== 'number' || count < 1) continue;
      const skills = skillPool(pool, where);
      if (skills) {
        if (level === 1 && out.skills === undefined) out.skills = { choose: count, from: skills };
        else out.choices.push({ id: `skills-${level}`, level, choose: count, from: { skills }, grants: 'proficiency' });
        continue;
      }
      const head = typeof pool[0] === 'string' ? pool[0].split(':')[0] : '';
      if (head === 'languages') continue;
      if (head === 'tool') out.lines.push(U.choiceNotMapped('tools'));
      else if (head === 'dr') out.lines.push(U.choiceNotMapped('damage-resistance'));
      else throw new Error(`${where}: unknown choice pool ${String(pool[0])}`);
    }
  }
  const order = (xs: string[], ref: readonly string[]): string[] => [...new Set(xs)].sort((x, y) => ref.indexOf(x) - ref.indexOf(y));
  out.saves = order(out.saves, ABILITIES);
  out.armor = order(out.armor, Object.values(ARMOR_CODES));
  const cats: string[] = out.weapons.filter((w) => w === 'simple' || w === 'martial');
  out.weapons = [...order(cats, ['simple', 'martial']), ...[...new Set(out.weapons.filter((w) => !cats.includes(w)))].sort(byString)];
  out.tools = [...new Set(out.tools)].sort(byString);
  return out;
}

/** Every level an ItemChoice picks at, with its count, in level order. */
function choiceLevels(adv: Rec): { level: number; count: number }[] {
  const c = getPath(adv, 'configuration.choices');
  if (!isRecord(c)) return [];
  return Object.keys(c)
    .filter((k) => isRecord(c[k]) && typeof (c[k] as Rec).count === 'number' && ((c[k] as Rec).count as number) > 0)
    .map((k) => ({ level: Number(k), count: (c[k] as Rec).count as number }))
    .filter((x) => Number.isInteger(x.level))
    .sort((a, b) => a.level - b.level);
}

/**
 * ItemChoice advancements -> choices. The pool's kept feats go to from.feats and its kept
 * features (options the PDF lists under the feature at that level, admitted by the gate's
 * featureOption tuples: Divine Order's Protector, the Metamagic options, Blessed Warrior) to
 * from.features. The id is the title in kebab case, " Choice" dropped (divine-order). A
 * choice that picks again at later levels (Metamagic 2/10/17, Eldritch Invocations) becomes
 * one choice per level, <id>-<level>, each over the whole pool [U: the options picked at an
 * earlier level aren't excluded; the pick lint sees only one choice at a time]. A pool entry
 * that was quarantined gives the quarantined-grant line; one the PDF doesn't list is left out
 * (non-SRD); a choice with nothing kept is a line.
 */
export function readItemChoices(ctx: MapCtx, rec: FoundryRecord): { choices: Rec[]; lines: string[] } {
  const choices: Rec[] = [];
  const lines: string[] = [];
  for (const adv of advancementsOf(rec)) {
    if (adv.type !== 'ItemChoice') continue;
    const title = typeof adv.title === 'string' && adv.title ? adv.title : 'choice';
    const id = kebab(title.replace(/ Choice$/, ''));
    const at = choiceLevels(adv);
    if (at.length === 0) continue;
    const pool = (getPath(adv, 'configuration.pool') as unknown[] | undefined) ?? [];
    const feats: string[] = [];
    const features: string[] = [];
    let quarantined = false;
    for (const p of pool) {
      const uuid = isRecord(p) ? p.uuid : undefined;
      if (typeof uuid !== 'string') continue;
      ctx.uuid(uuid, 'system.advancement.ItemChoice');
      const fid = foreignIdOf(uuid);
      const k = ctx.lookup(fid);
      if (k?.kind === 'feat') {
        const fidId = ctx.idOf(fid);
        if (fidId) feats.push(fidId);
      } else if (k?.kind === 'feature' && k.owners.some((o) => o.foreignId === rec.id)) features.push(featureIdOf(k, ctx));
      else if (!k && ctx.dropped(fid) && licenseDrop(ctx.dropped(fid)!)) quarantined = true;
    }
    if (quarantined) lines.push(U.quarantinedGrant());
    const n = new Set([...feats, ...features]).size;
    if (n === 0) {
      lines.push(U.choiceNotMapped(id));
      continue;
    }
    const from: Rec = {};
    if (features.length) from.features = [...new Set(features)].sort(byString);
    if (feats.length) from.feats = [...new Set(feats)].sort(byString);
    for (const a of at) choices.push({ id: at.length > 1 ? `${id}-${a.level}` : id, level: a.level, choose: Math.min(a.count, n), from });
  }
  return { choices, lines };
}

/** Choices sorted by level, then id; ids must be unique. */
export function sortChoices(choices: Rec[], where: string): Rec[] {
  const out = [...choices].sort((a, b) => (a.level as number) - (b.level as number) || byString(a.id as string, b.id as string));
  out.forEach((c, i) => {
    if (out.findIndex((x) => x.id === c.id) !== i) throw new Error(`${where}: choice id ${String(c.id)} twice`);
  });
  return out;
}

/** Pools and acFormulas from an owner's granted kept features (pools only at levels 1-10, 4.9). */
export function poolsAndAc(ctx: MapCtx, entries: readonly GrantEntry[], ownerClass: string): { pools: Rec[]; acFormulas: { when: string[]; ac: string }[]; lines: string[] } {
  const pools: Rec[] = [];
  const acFormulas: { when: string[]; ac: string }[] = [];
  const lines: string[] = [];
  const done = new Set<string>();
  for (const e of [...entries].sort((a, b) => a.level - b.level || byString(a.id, b.id))) {
    if (!e.kept || done.has(e.id)) continue;
    done.add(e.id);
    for (const f of acFormulasOf(e.kept.rec.doc)) if (!acFormulas.some((x) => x.ac === f.ac)) acFormulas.push(f);
    if (e.level > 10) continue;
    const p = poolOf(e.kept, ctx, ownerClass);
    lines.push(...p.lines);
    if (p.pool) {
      if (pools.some((x) => x.id === p.pool!.id)) throw new Error(`pool ${String(p.pool.id)} twice`);
      pools.push(p.pool);
    }
  }
  pools.sort((a, b) => byString(a.id as string, b.id as string));
  return { pools, acFormulas, lines };
}

const EXTRA_ATTACKS: Readonly<Record<string, number>> = { 'extra attack': 1, 'two extra attacks': 2, 'three extra attacks': 3 };

// ---- the class mapper -------------------------------------------------------------------

export const mapClass: Mapper = (ctx) => {
  const pdfAll = pdfOf(ctx);
  if (!pdfAll) return null;
  const rec = ctx.kept.rec;
  const doc = rec.doc as Rec;
  const cls = classIdentOf(rec);
  const pdf = pdfAll.classes[cls as keyof SrdIndex['classes']];
  if (!pdf) throw new Error(`${rec.path}: class ${cls} is not in srd-index.json`);
  const id = ctx.idOf(rec.id);
  if (id !== `srd:${cls}`) throw new Error(`${rec.path}: expected the id srd:${cls}, got ${String(id)}`);
  const lines: string[] = [];

  const denom = getPath(doc, 'system.hd.denomination');
  const hitDie = typeof denom === 'string' ? Number(denom.replace(/^d/, '')) : NaN;
  if (hitDie !== pdf.hitDie) throw new Error(`${rec.path}: hit die d${hitDie} but the PDF says d${pdf.hitDie}`);

  const subAdv = advancementsOf(rec).filter((a) => a.type === 'Subclass');
  const subclassLevel = subAdv.length === 1 && typeof subAdv[0]!.level === 'number' ? subAdv[0]!.level : undefined;
  if (subclassLevel === undefined || !pdf.features.some((f) => f.level === subclassLevel && f.name === `${pdf.name} Subclass`)) {
    throw new Error(`${rec.path}: the Subclass advancement's level ${String(subclassLevel)} is not the PDF's subclass row`);
  }

  const epic = pdf.features.filter((f) => f.name === 'Epic Boon').map((f) => f.level);
  const asiPdf = [...new Set(pdf.features.filter((f) => f.name === 'Ability Score Improvement').map((f) => f.level))].sort((a, b) => a - b);
  const asiFoundry = advancementsOf(rec)
    .filter((a) => a.type === 'AbilityScoreImprovement' && typeof a.level === 'number' && Number(getPath(a, 'configuration.points') ?? 0) > 0)
    .map((a) => a.level as number)
    .filter((l) => !epic.includes(l))
    .sort((a, b) => a - b);
  if (asiFoundry.join(',') !== asiPdf.join(',')) throw new Error(`${rec.path}: ASI levels ${asiFoundry.join(',')} but the PDF says ${asiPdf.join(',')}`);

  const traits = readTraits(ctx, rec);
  lines.push(...traits.lines);
  if (traits.saves.length !== 2) throw new Error(`${rec.path}: expected 2 saving throw proficiencies, got ${traits.saves.join(',')}`);
  if (!traits.skills) throw new Error(`${rec.path}: no level-1 skill choice`);

  const { scale, lines: scaleLines } = scaleOf(rec, pdf, cls);
  lines.push(...scaleLines);

  const grants = readGrants(ctx, rec);
  lines.push(...grants.lines);
  const stubs = pdfStubs(rec, pdf.features, haveOf(grants), (n) => n === 'Ability Score Improvement' || n === `${pdf.name} Subclass`);
  const entries = [...grants.entries, ...stubs.entries];

  // M3 step 5b: Weapon Mastery's choice is the character's <class>#weapon-mastery pick, read by
  // content/character.ts from its WEAPON_MASTERY table (the class text: how many kinds, which
  // kinds). Here Foundry's mastery advancements are a vote on the count, fail closed: their running
  // total must equal the table's number at every level 1-20 (the PDF's Weapon Mastery column, or
  // the fixed "two kinds"). When it holds, the choice is mapped and its line goes.
  const wm = masteryReading(cls, entries.map((e) => e.id), scale, traits.mastery);
  if (wm !== null) {
    if (wm !== 'ok') throw new Error(`${rec.path}: ${wm}; fail closed`);
    // One line per mastery advancement (Fighter has four): all of them go.
    for (let at = lines.indexOf(U.choiceNotMapped('weapon-mastery')); at >= 0; at = lines.indexOf(U.choiceNotMapped('weapon-mastery'))) lines.splice(at, 1);
  }

  const extraAttacks: Record<string, number> = {};
  for (const e of grants.entries) {
    const n = e.kept ? EXTRA_ATTACKS[normName(e.kept.rec.name)] : undefined;
    if (n !== undefined) extraAttacks[String(e.level)] = n;
  }

  const pa = poolsAndAc(ctx, grants.entries, cls);
  lines.push(...pa.lines);

  const choices = readItemChoices(ctx, rec);
  lines.push(...choices.lines);

  let spellcasting: Rec | undefined;
  const sc = getPath(doc, 'system.spellcasting');
  const prog = isRecord(sc) ? sc.progression : undefined;
  if (prog === 'full' || prog === 'half' || prog === 'pact') {
    const ability = (sc as Rec).ability;
    if (typeof ability !== 'string' || !ABILITIES.includes(ability)) throw new Error(`${rec.path}: spellcasting without an ability`);
    spellcasting = { progression: prog, ability, list: `srd:list/${cls}` };
    if (Object.hasOwn(scale, 'cantrips-known')) spellcasting.cantrips = `@scale.${cls}.cantrips-known`;
    const prep = getPath(sc, 'preparation.formula');
    if (typeof prep === 'string' && prep) {
      const f = ctx.formula(prep, { ownerClass: cls });
      if (f.ok) spellcasting.prepared = /^\d+$/.test(f.expr) ? Number(f.expr) : f.expr;
      else lines.push(...f.lines);
    }
    if (!Object.hasOwn(scale, 'slots')) throw new Error(`${rec.path}: a caster with no slot columns in the PDF table`);
  } else if (prog !== 'none' && prog !== undefined) throw new Error(`${rec.path}: unknown spellcasting progression ${String(prog)}`);

  const item: Rec = {
    kind: 'class',
    id,
    name: rec.name,
    source: pageSource(pdf.chapter.first),
    hitDie,
    saves: traits.saves,
    proficiencies: { armor: traits.armor, weapons: traits.weapons, tools: traits.tools },
    skills: traits.skills,
    subclassLevel,
    asiLevels: asiPdf,
    scale,
    features: byLevel(entries),
    choices: sortChoices([{ id: 'skills', level: 1, choose: traits.skills.choose, from: { skills: traits.skills.from }, grants: 'proficiency' }, ...traits.choices, ...choices.choices], rec.path),
  };
  if (spellcasting) item.spellcasting = spellcasting;
  if (Object.keys(extraAttacks).length) item.extraAttacks = extraAttacks;
  if (pa.pools.length) item.pools = pa.pools;
  if (pa.acFormulas.length) item.acFormulas = pa.acFormulas;

  const classOut: MapOutput = { kind: 'class', item, unimplemented: lines, classify: { maps: true, shape: 'data', hasDuration: false }, pdfPage: pdf.chapter.first };
  return [classOut, ...stubs.outputs];
};

/**
 * M3 step 5b: Weapon Mastery's count, Foundry's mastery advancements against the reading in
 * content/character.ts WEAPON_MASTERY (a vote, fail closed). null: no reading applies (the class
 * has no such feature, or the build doesn't grant it), so the choice stays a line. 'ok': the
 * running total equals the reading at every level 1-20 (a fixed number, or the class's Weapon
 * Mastery column, which scaleOf has already checked against the PDF table). Else the mismatch.
 */
export function masteryReading(cls: string, featureIds: readonly string[], scale: Readonly<Record<string, unknown>>, mastery: readonly { level: number; count: number }[]): 'ok' | string | null {
  const wm = WEAPON_MASTERY.find((m) => m.feature === `srd:${cls}/weapon-mastery`);
  if (!wm || !featureIds.includes(wm.feature)) return null;
  const colRec = scale.mastery;
  const col = isRecord(colRec) && isRecord(colRec.at) ? (colRec.at as Record<string, number>) : undefined;
  const want = (lvl: number): number | undefined => {
    if (typeof wm.count === 'number') return wm.count;
    if (wm.count !== `@scale.${cls}.mastery` || !col) return undefined;
    let v: number | undefined;
    for (const k of Object.keys(col).sort((a, b) => Number(a) - Number(b))) if (Number(k) <= lvl) v = col[k];
    return v;
  };
  for (let lvl = 1; lvl <= 20; lvl++) {
    const got = mastery.filter((m) => m.level <= lvl).reduce((n, m) => n + m.count, 0);
    const w = want(lvl);
    if (w === undefined || got !== w) return `Weapon Mastery at level ${lvl}: Foundry's advancements total ${got}, the reading (${wm.pdf}) says ${w ?? 'nothing'}`;
  }
  return 'ok';
}
