// Which Foundry records may become SRD content (docs/design/m3.md 4.2, 4.7; C4, C5, C21).
// Fail closed, in this order:
//   1. license: system.source.license must be exactly 'CC-BY-4.0', system.source.book
//      empty and system.source.rules '2024' (every record, so the quarantine is complete).
//   2. kind: a record the step's scope doesn't import is dropped (kind-out-of-scope).
//   3. the PDF tuple gate (C4): an exact tuple from srd-index.json, per kind. Class and
//      subclass features: (owner, level, name), owner being the class or subclass name and
//      level the one its ItemGrant or ItemChoice gives; species traits: (species, name);
//      subclasses: (class, name); everything else: its name. Foundry splits a species with
//      lineages into one record per lineage ("Elf, Drow", "Gnome, Rock") and names the
//      lineage traits "Elven Lineage, Drow": both pass only when the part after the comma
//      is an option the PDF lists under that species (lineageMatch).
// A record that fails any step is a drop, with one reason from DROP_REASONS. Drops carry
// names, so they are written to the import cache only (logs/drops.json, C5); IMPORT.json
// commits counts by reason, never names.

import { existsSync, readFileSync } from 'node:fs';
import { getPath, isRecord } from './util.ts';
import type { FoundryRecord } from './read.ts';

/** What the importer produces. 'feature' covers class and subclass features; 'speciesTrait' becomes a feature too. */
export const IMPORT_KINDS = ['armor', 'background', 'class', 'feat', 'feature', 'magicItem', 'monster', 'species', 'speciesTrait', 'spell', 'subclass', 'weapon'] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

/** Step 2's scope (m3.md 4.9): spells and monsters wait for step 6. */
export const STEP2_KINDS: readonly ImportKind[] = ['armor', 'background', 'class', 'feat', 'feature', 'species', 'speciesTrait', 'subclass', 'weapon'];

/** What the importer imports now (m3.md 4.9): step 2's kinds plus step 6's spells, monsters and magic items (C9b). */
export const IMPORT_SCOPE: readonly ImportKind[] = [...STEP2_KINDS, 'spell', 'monster', 'magicItem'];

export const DROP_REASONS = [
  'book-set',
  'kind-out-of-scope',
  'license-empty',
  'license-missing',
  'license-other',
  'no-owner',
  'not-in-srd-pdf',
  'rules-not-2024',
] as const;
export type DropReason = (typeof DROP_REASONS)[number];

export interface Drop {
  readonly path: string;
  readonly foreignId: string;
  readonly name: string;
  readonly kind: ImportKind | 'other';
  readonly reason: DropReason;
}

const ARMOR_TYPES: readonly string[] = ['heavy', 'light', 'medium', 'shield'];

/** The import kind of a record, from Foundry's type and system.type.value; 'other' when none. */
export function kindOf(rec: FoundryRecord): ImportKind | 'other' {
  const sub = getPath(rec.doc, 'system.type.value');
  // M3 step 6 (C9b): every magic item in equipment24 carries the 'mgc' property (352 at the pin,
  // weapons, armor, wondrous items and consumables alike); no mundane weapon or armor does.
  const props = getPath(rec.doc, 'system.properties');
  if (rec.pack === 'equipment24' && Array.isArray(props) && props.includes('mgc')) return 'magicItem';
  switch (rec.type) {
    case 'class':
      return 'class';
    case 'subclass':
      return 'subclass';
    case 'race':
      return 'species';
    case 'background':
      return 'background';
    case 'spell':
      return 'spell';
    case 'npc':
      return 'monster';
    case 'weapon':
      return rec.pack === 'equipment24' && sub !== 'natural' ? 'weapon' : 'other';
    case 'equipment':
      return typeof sub === 'string' && ARMOR_TYPES.includes(sub) ? 'armor' : 'other';
    case 'feat':
      // feats24 holds only feats (one, Ability Score Improvement, has an empty subtype).
      if (rec.pack === 'feats24') return 'feat';
      if (sub === 'class' || sub === 'subclass') return 'feature';
      if (sub === 'race') return 'speciesTrait';
      if (sub === 'feat') return 'feat';
      return 'other';
    default:
      return 'other';
  }
}

/** The license test (m3.md 4.2 filter.ts), or undefined when the record passes it. */
export function licenseDrop(rec: FoundryRecord): DropReason | undefined {
  const src = getPath(rec.doc, 'system.source');
  if (!isRecord(src) || !('license' in src)) return 'license-missing';
  if (src.license === '' || src.license === null) return 'license-empty';
  if (src.license !== 'CC-BY-4.0') return 'license-other';
  if (src.book !== undefined && src.book !== null && src.book !== '') return 'book-set';
  if (src.rules !== '2024') return 'rules-not-2024';
  return undefined;
}

// ---- the PDF tuple gate -------------------------------------------------------------

export type GateKind = 'armor' | 'background' | 'class' | 'feat' | 'feature' | 'featureOption' | 'magicItem' | 'monster' | 'species' | 'speciesOption' | 'speciesTrait' | 'spell' | 'subclass' | 'weapon';
export type GateTuple = readonly (string | number)[];

/**
 * What the gate needs from srd-index.json (written by tools/import-srd/pdf-index.ts). Tuples:
 *   class, species, background, feat, weapon, armor, spell, monster, magicItem: [name]
 *     (monster: a stat-block header, C4; magicItem: a "Magic Items A–Z" header)
 *   subclass: [class name, subclass name]
 *   feature: [owner (class or subclass name), level, feature name]
 *   featureOption: [owner, level, option name] and [owner, level, "<feature>: <option>"]
 *     (an option a feature at that level offers: Foundry names Divine Order's Protector
 *     "Divine Order: Protector" and Blessed Warrior just "Blessed Warrior")
 *   speciesTrait: [species name, trait name]
 *   speciesOption: [species name, trait name, option name] and [species name, option name]
 *     (a trait's options: a lineage, a Giant Ancestry)
 */
export interface SrdNameIndex {
  has(kind: GateKind, tuple: GateTuple): boolean;
}

/**
 * Names compare after normalizing typography only: Unicode NFKC, curly quotes and dashes to
 * ASCII, whitespace collapsed, case folded. Nothing fuzzier: a near miss is a drop.
 */
export function normName(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[‘’ʼ′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const tupleKey = (kind: GateKind, t: GateTuple): string => `${kind}\u0000${t.map((x) => (typeof x === 'number' ? String(x) : normName(x))).join('\u0000')}`;

/** An index from explicit tuples (tests, and the srd-index.json adapter below). */
export function indexFromTuples(entries: Readonly<Partial<Record<GateKind, readonly GateTuple[]>>>): SrdNameIndex {
  const keys = new Set<string>();
  for (const kind of Object.keys(entries) as GateKind[]) for (const t of entries[kind] ?? []) keys.add(tupleKey(kind, t));
  return { has: (kind, tuple) => keys.has(tupleKey(kind, tuple)) };
}

/**
 * The gate's view of srd-index.json (pdf-index.ts, pdf/build.ts SrdIndex). Read structurally,
 * so this file doesn't depend on the PDF parser:
 *   classes.<id>.name, classes.<id>.features[] {level, name}        -> class, feature tuples
 *   subclasses.<id> {class (a classes key), name, features[] {level, name}}
 *                                                                   -> subclass, feature tuples
 *   species[], backgrounds[], feats[], spells[], weapons[], armor[] {name}
 *   monsters[], magicItems[] {name}  (M3 step 6: stat-block and magic item headers)
 * A kind whose list is absent admits nothing (fail closed).
 */
export function indexFromJson(json: unknown): SrdNameIndex {
  if (!isRecord(json) || !isRecord(json.classes) || !isRecord(json.subclasses)) throw new Error('srd-index.json: expected classes and subclasses maps');
  const str = (v: unknown, what: string): string => {
    if (typeof v !== 'string' || !v) throw new Error(`srd-index.json: ${what} must be a non-empty string`);
    return v;
  };
  const int = (v: unknown, what: string): number => {
    if (typeof v !== 'number' || !Number.isInteger(v)) throw new Error(`srd-index.json: ${what} must be an integer`);
    return v;
  };
  const list = (v: unknown, what: string): Record<string, unknown>[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || !v.every(isRecord)) throw new Error(`srd-index.json: ${what} must be a list of objects`);
    return v as Record<string, unknown>[];
  };
  const out: Record<GateKind, GateTuple[]> = { armor: [], background: [], class: [], feat: [], feature: [], featureOption: [], magicItem: [], monster: [], species: [], speciesOption: [], speciesTrait: [], spell: [], subclass: [], weapon: [] };
  const classNames = new Map<string, string>();
  for (const id of Object.keys(json.classes).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const c = json.classes[id];
    if (!isRecord(c)) throw new Error(`srd-index.json: classes.${id} must be an object`);
    const name = str(c.name, `classes.${id}.name`);
    classNames.set(id, name);
    out.class.push([name]);
    list(c.features, `classes.${id}.features`).forEach((f, i) => out.feature.push([name, int(f.level, `classes.${id}.features[${i}].level`), str(f.name, `classes.${id}.features[${i}].name`)]));
  }
  for (const id of Object.keys(json.subclasses).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const s = json.subclasses[id];
    if (!isRecord(s)) throw new Error(`srd-index.json: subclasses.${id} must be an object`);
    const cls = str(s.class, `subclasses.${id}.class`);
    const parent = classNames.get(cls);
    if (parent === undefined) throw new Error(`srd-index.json: subclasses.${id}.class ${cls} is not in classes`);
    const name = str(s.name, `subclasses.${id}.name`);
    out.subclass.push([parent, name]);
    list(s.features, `subclasses.${id}.features`).forEach((f, i) => out.feature.push([name, int(f.level, `subclasses.${id}.features[${i}].level`), str(f.name, `subclasses.${id}.features[${i}].name`)]));
  }
  const subclassNames = new Map<string, string>();
  for (const id of Object.keys(json.subclasses)) subclassNames.set(id, str((json.subclasses[id] as Record<string, unknown>).name, `subclasses.${id}.name`));
  list(json.featureOptions, 'featureOptions').forEach((e, i) => {
    const w = `featureOptions[${i}]`;
    const owner = e.subclass === undefined ? classNames.get(str(e.class, `${w}.class`)) : subclassNames.get(str(e.subclass, `${w}.subclass`));
    if (owner === undefined) throw new Error(`srd-index.json: ${w} names no indexed class or subclass`);
    const level = int(e.level, `${w}.level`);
    const name = str(e.name, `${w}.name`);
    out.featureOption.push([owner, level, name], [owner, level, `${str(e.feature, `${w}.feature`)}: ${name}`]);
  });
  const names = (key: string, kind: GateKind) => list(json[key], key).forEach((e, i) => out[kind].push([str(e.name, `${key}[${i}].name`)]));
  names('species', 'species');
  names('backgrounds', 'background');
  names('feats', 'feat');
  names('spells', 'spell');
  names('weapons', 'weapon');
  names('armor', 'armor');
  names('monsters', 'monster');
  names('magicItems', 'magicItem');
  list(json.speciesTraits, 'speciesTraits').forEach((e, i) => {
    const sp = str(e.species, `speciesTraits[${i}].species`);
    const name = str(e.name, `speciesTraits[${i}].name`);
    if (e.of === undefined) out.speciesTrait.push([sp, name]);
    else {
      const of = str(e.of, `speciesTraits[${i}].of`);
      out.speciesTrait.push([sp, name]);
      out.speciesOption.push([sp, of, name], [sp, name]);
    }
  });
  return indexFromTuples(out);
}

/** Loads srd-index.json; undefined when the file doesn't exist yet (the caller decides: main fails closed). */
export function loadSrdIndex(file: string): SrdNameIndex | undefined {
  if (!existsSync(file)) return undefined;
  return indexFromJson(JSON.parse(readFileSync(file, 'utf8')) as unknown);
}

/**
 * A Foundry lineage name ("Elf, High", "Elven Lineage, Drow") split at its comma: the part
 * before, and the part after; undefined for a plain name.
 */
export function splitLineage(name: string): { head: string; option: string } | undefined {
  const m = /^([^,]+), ([^,]+)$/.exec(name);
  return m ? { head: m[1]!, option: m[2]! } : undefined;
}

/**
 * Does `option` name one of the PDF options of `species` (under `trait` when given)? Exactly,
 * or with the species name after it ("Rock" -> "Rock Gnome", "High" -> "High Elf"): the only
 * two spellings Foundry uses at the pin. Nothing fuzzier.
 */
export function lineageMatch(index: SrdNameIndex, species: string, option: string, trait?: string): boolean {
  const pre = trait === undefined ? [species] : [species, trait];
  return index.has('speciesOption', [...pre, option]) || index.has('speciesOption', [...pre, `${option} ${species}`]);
}

/** The gate for a species record: its name, or "<species>, <lineage>" with a PDF lineage. */
export function speciesPasses(index: SrdNameIndex, name: string): boolean {
  if (index.has('species', [name])) return true;
  const l = splitLineage(name);
  return l !== undefined && index.has('species', [l.head]) && lineageMatch(index, l.head, l.option);
}

/** The PDF species a (gate-passing) species record belongs to: "Elf, Drow" -> "Elf". */
export function baseSpecies(index: SrdNameIndex, name: string): string {
  if (index.has('species', [name])) return name;
  return splitLineage(name)?.head ?? name;
}

/** The gate for a species trait owned by `species` (a gate-passing species record's name). */
export function speciesTraitPasses(index: SrdNameIndex, species: string, name: string): boolean {
  const sp = baseSpecies(index, species);
  if (index.has('speciesTrait', [sp, name])) return true;
  const l = splitLineage(name);
  return l !== undefined && index.has('speciesTrait', [sp, l.head]) && lineageMatch(index, sp, l.option, l.head);
}

// ---- ownership: which class, subclass or species grants a feature, and at what level ----

export interface Owner {
  /** The owning record's name (a class, subclass or species name). */
  readonly name: string;
  readonly foreignId: string;
  readonly kind: 'class' | 'subclass' | 'species';
  /** The level it is granted at (species traits: 0, unused by the gate). */
  readonly level: number;
}

/** The last segment of a Foundry UUID ("Compendium.dnd5e.classes24.Item.phbftrSecondWind" -> "phbftrSecondWind"). */
export const foreignIdOf = (uuid: string): string => uuid.slice(uuid.lastIndexOf('.') + 1);

/** The lowest level an ItemChoice offers picks at (its choices map), else its own level. */
function choiceLevel(adv: Record<string, unknown>): number | undefined {
  const choices = getPath(adv, 'configuration.choices');
  if (isRecord(choices)) {
    const lv = Object.keys(choices)
      .filter((k) => {
        const c = choices[k];
        return isRecord(c) && typeof c.count === 'number' && c.count > 0;
      })
      .map(Number)
      .filter(Number.isInteger)
      .sort((a, b) => a - b);
    if (lv.length) return lv[0];
  }
  return typeof adv.level === 'number' ? adv.level : undefined;
}

/**
 * A record's advancements. Foundry stores system.advancement as a list in most records and
 * as a map keyed by advancement id in some (the Ranger at the pin); maps are read in key order.
 */
export function advancementsOf(rec: FoundryRecord): Record<string, unknown>[] {
  const adv = getPath(rec.doc, 'system.advancement');
  if (Array.isArray(adv)) return adv.filter(isRecord);
  if (isRecord(adv)) {
    return Object.keys(adv)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((k) => adv[k])
      .filter(isRecord);
  }
  return [];
}

/**
 * Owners by foreign id, read from the ItemGrant and ItemChoice advancements of the given
 * class, subclass and species records. Only Compendium.dnd5e.* UUIDs count: a pointer into a
 * premium module grants nothing here (remap.ts logs it).
 */
export function ownersFrom(records: readonly FoundryRecord[]): Map<string, Owner[]> {
  const out = new Map<string, Owner[]>();
  for (const rec of records) {
    const k = kindOf(rec);
    if (k !== 'class' && k !== 'subclass' && k !== 'species') continue;
    for (const a of advancementsOf(rec)) {
      let level: number | undefined;
      let list: unknown;
      if (a.type === 'ItemGrant') {
        level = typeof a.level === 'number' ? a.level : undefined;
        list = getPath(a, 'configuration.items');
      } else if (a.type === 'ItemChoice') {
        level = choiceLevel(a);
        list = getPath(a, 'configuration.pool');
      } else continue;
      if (level === undefined || !Array.isArray(list)) continue;
      for (const e of list) {
        const uuid = isRecord(e) ? e.uuid : undefined;
        if (typeof uuid !== 'string' || !uuid.startsWith('Compendium.dnd5e.')) continue;
        const fid = foreignIdOf(uuid);
        const owners = out.get(fid) ?? [];
        if (!owners.some((o) => o.foreignId === rec.id && o.level === level)) owners.push({ name: rec.name, foreignId: rec.id, kind: k, level });
        out.set(fid, owners);
      }
    }
  }
  for (const owners of out.values()) owners.sort((a, b) => a.level - b.level || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

export interface Kept {
  readonly rec: FoundryRecord;
  readonly kind: ImportKind;
  /** The owners whose tuple passed the gate (features and species traits only). */
  readonly owners: readonly Owner[];
}

export interface FilterResult {
  readonly kept: readonly Kept[];
  readonly drops: readonly Drop[];
}

/** The class name a subclass record belongs to, through system.classIdentifier. */
function parentClassName(rec: FoundryRecord, classes: ReadonlyMap<string, string>): string | undefined {
  const ident = getPath(rec.doc, 'system.classIdentifier');
  return typeof ident === 'string' ? classes.get(ident) : undefined;
}

/**
 * Runs the whole filter. Ownership is read only from records that themselves pass the
 * license test and the gate, so a feature granted by a dropped class has no owner.
 */
export function filterRecords(records: readonly FoundryRecord[], index: SrdNameIndex, scope: readonly ImportKind[] = STEP2_KINDS): FilterResult {
  const drops: Drop[] = [];
  const kept: Kept[] = [];
  const drop = (rec: FoundryRecord, kind: ImportKind | 'other', reason: DropReason) => drops.push({ path: rec.path, foreignId: rec.id, name: rec.name, kind, reason });

  // Pass 1: owners (class, subclass, species), so their features can be gated by tuple.
  const classIdent = new Map<string, string>();
  for (const rec of records) {
    if (kindOf(rec) !== 'class' || licenseDrop(rec)) continue;
    const ident = getPath(rec.doc, 'system.identifier');
    if (typeof ident === 'string') classIdent.set(ident, rec.name);
  }
  const ownerRecs: FoundryRecord[] = [];
  const gateOwner = (rec: FoundryRecord, kind: ImportKind): boolean => {
    if (kind === 'class') return index.has(kind, [rec.name]);
    if (kind === 'species') return speciesPasses(index, rec.name);
    if (kind === 'subclass') {
      const parent = parentClassName(rec, classIdent);
      return parent !== undefined && index.has('subclass', [parent, rec.name]);
    }
    return false;
  };
  for (const rec of records) {
    const k = kindOf(rec);
    if ((k === 'class' || k === 'subclass' || k === 'species') && !licenseDrop(rec) && gateOwner(rec, k)) ownerRecs.push(rec);
  }
  const owners = ownersFrom(ownerRecs);

  for (const rec of records) {
    const kind = kindOf(rec);
    // License first, for every record: the summary lists every quarantined one (C21).
    const lic = licenseDrop(rec);
    if (lic) {
      drop(rec, kind, lic);
      continue;
    }
    if (kind === 'other' || !scope.includes(kind)) {
      drop(rec, kind, 'kind-out-of-scope');
      continue;
    }
    if (kind === 'feature' || kind === 'speciesTrait') {
      const mine = (owners.get(rec.id) ?? []).filter((o) => (kind === 'feature' ? o.kind !== 'species' : o.kind === 'species'));
      if (mine.length === 0) {
        drop(rec, kind, 'no-owner');
        continue;
      }
      // A feature passes as a feature its owner's table lists at that level, or as an option a
      // feature at that level offers (granted through an ItemChoice: Divine Order: Protector).
      const pass = mine.filter((o) =>
        kind === 'feature' ? index.has('feature', [o.name, o.level, rec.name]) || index.has('featureOption', [o.name, o.level, rec.name]) : speciesTraitPasses(index, o.name, rec.name),
      );
      if (pass.length === 0) drop(rec, kind, 'not-in-srd-pdf');
      else kept.push({ rec, kind, owners: pass });
      continue;
    }
    const ok = kind === 'class' || kind === 'subclass' || kind === 'species' ? gateOwner(rec, kind) : index.has(kind, [rec.name]);
    if (ok) kept.push({ rec, kind, owners: [] });
    else drop(rec, kind, 'not-in-srd-pdf');
  }
  return { kept, drops };
}

/** Drop counts by reason, every reason present (0 included), keys in < order: IMPORT.json's form. */
export function dropCounts(drops: readonly Drop[]): Record<DropReason, number> {
  const out = Object.fromEntries(DROP_REASONS.map((r) => [r, 0])) as Record<DropReason, number>;
  for (const d of drops) out[d.reason]++;
  return out;
}
