// Assemble srd-index.json from the two pdftotext outputs, then validate it hard.
// Names and numbers only: no rules prose is ever copied into the index.

import { type ClassTable, type Unit, parseAllClassTables } from './class-tables.ts';
import { type Armor, type Weapon, parseArmor, parseWeapons } from './equipment.ts';
import { type FeatureOption, parseChapterHeadings } from './headings.ts';
import { parseHitDice, parseHpTable } from './hit-points.ts';
import { type Line, layoutPages, parseBboxLayout } from './lines.ts';
import { type ClassId, CLASSES, byString } from './names.ts';
import { type Feat, type Named, type SpeciesTrait, parseOrigins } from './origins.ts';
import { type HeaderAt, type SpellDetail, parseSpellDetails } from './spell-details.ts';
import { type SpellHeader, parseSpellHeaders, parseSpellListTables } from './spells.ts';
import { type MagicItemDetail, parseMagicItems } from './magic-items.ts';
import { type MonsterDetail, type MonsterHeader, parseMonsters } from './monsters.ts';

export interface IndexFeature {
  readonly level: number;
  readonly name: string;
  readonly detail?: string;
  /** The page of its "Level N: Name" description, else the table's page. */
  readonly page: number;
  /** False for a repeat with no heading of its own (a second Ability Score Improvement, "Indomitable (two uses)"). */
  readonly described: boolean;
}

export interface IndexClass {
  readonly name: string;
  readonly hitDie: number;
  readonly chapter: { first: number; last: number };
  readonly table: {
    readonly page: number;
    readonly columnOrder: string[];
    readonly units: Record<string, Unit>;
    readonly columns: Record<string, number[]>;
  };
  readonly features: IndexFeature[];
  readonly subclassLevels: number[];
}

export interface IndexSubclass {
  readonly class: ClassId;
  readonly name: string;
  readonly page: number;
  readonly features: { level: number; name: string; page: number }[];
}

export interface SrdIndex {
  readonly source: { readonly pdfSha256: string; readonly pages: number };
  readonly counts: Record<string, number>;
  readonly classes: Record<ClassId, IndexClass>;
  readonly subclasses: Record<string, IndexSubclass>;
  readonly hitPoints: {
    readonly level1: { page: number; values: Record<ClassId, number> };
    readonly fixedPerLevel: { page: number; values: Record<ClassId, number> };
  };
  readonly species: Named[];
  /** Species traits and their options (lineages, Giant Ancestry): the (species, trait) gate tuples. */
  readonly speciesTraits: SpeciesTrait[];
  readonly backgrounds: Named[];
  readonly feats: Feat[];
  readonly spells: SpellHeader[];
  /**
   * M3 step 6 (C7): each spell's stat lines (casting time, range, components, duration,
   * concentration) and the machine tokens of its description (dice, damage types, saves,
   * attack kind, areas, conditions), sorted by name. Optional so step-2 fixtures still type-check.
   */
  readonly spellDetails?: SpellDetail[];
  readonly weapons: Weapon[];
  readonly armor: Armor[];
  /**
   * M3 step 6 (C4): every stat-block header in the PDF (the monster gate's names), sorted by name.
   * Optional so step-2 fixtures still type-check.
   */
  readonly monsters?: MonsterHeader[];
  /** M3 step 6: the printed numbers of every stat block that parses whole (pdf/monsters.ts), sorted by name. */
  readonly monsterDetails?: MonsterDetail[];
  /** M3 step 6 (C4, C9b): every magic item header with its category tokens (pdf/magic-items.ts), sorted by name. */
  readonly magicItems?: MagicItemDetail[];
  /**
   * Options a class or subclass feature offers (Divine Order's Protector, the Metamagic
   * options, the Eldritch Invocations): the gate's (owner, level, option) tuples (C4).
   */
  readonly featureOptions: FeatureOption[];
  /** Header list entries the class chapter's spell list table leaves out (KNOWN_LIST_TABLE_GAPS). */
  readonly spellListTableGaps: { class: ClassId; level: number; name: string }[];
}

/** What the SRD 5.2.1 PDF is known to hold; a parse that disagrees fails. */
export const EXPECT = { pages: 364, spells: 339, species: 9, speciesTraits: 47, backgrounds: 4, feats: 17, subclasses: 12, weapons: 38, armor: 13, featureOptions: 54, monsters: 336, monsterDetails: 331, magicItems: 258 } as const;

const byName = <T extends { name: string }>(a: T, b: T) => byString(a.name, b.name);
const byLevelName = <T extends { level: number; name: string }>(a: T, b: T) => a.level - b.level || byString(a.name, b.name);

export function buildIndex(layoutText: string, bboxXhtml: string, pdfSha256: string): SrdIndex {
  const pages = layoutPages(layoutText);
  const lines: Line[] = parseBboxLayout(bboxXhtml);
  const tables = parseAllClassTables(pages);
  const heads = parseChapterHeadings(lines);
  const dice = parseHitDice(pages);
  const origins = parseOrigins(lines);
  const spellAt: HeaderAt[] = [];
  const spells = parseSpellHeaders(lines, spellAt).sort(byName);
  const spellDetails = parseSpellDetails(lines, spellAt).sort(byName);
  const blocks = parseMonsters(lines);

  const problems: string[] = [];
  const classes = {} as Record<ClassId, IndexClass>;
  for (const cls of CLASSES) classes[cls] = assembleClass(cls, tables[cls], heads.classFeatures[cls] ?? [], heads.chapters[cls], dice[cls].die, problems);

  const subclasses: Record<string, IndexSubclass> = {};
  for (const s of heads.subclasses) {
    subclasses[s.id] = { class: s.class, name: s.name, page: s.page, features: [...s.features].sort(byLevelName) };
  }

  const index: SrdIndex = {
    source: { pdfSha256, pages: pages.length },
    counts: {},
    classes,
    subclasses,
    hitPoints: {
      level1: parseHpTable(lines, 'Level 1 Hit Points by Class'),
      fixedPerLevel: parseHpTable(lines, 'Fixed Hit Points by Class'),
    },
    species: [...origins.species].sort(byName),
    speciesTraits: [...origins.speciesTraits].sort((a, b) => byString(a.species, b.species) || byString(a.of ?? '', b.of ?? '') || byString(a.name, b.name)),
    backgrounds: [...origins.backgrounds].sort(byName),
    feats: [...origins.feats].sort(byName),
    spells,
    spellDetails,
    weapons: parseWeapons(pages).sort(byName),
    armor: parseArmor(pages).sort(byName),
    monsters: [...blocks.heads].sort(byName),
    monsterDetails: [...blocks.details].sort(byName),
    magicItems: parseMagicItems(lines).sort(byName),
    featureOptions: [...heads.options].sort(
      (a, b) => byString(a.class, b.class) || byString(a.subclass ?? '', b.subclass ?? '') || a.level - b.level || byString(a.feature, b.feature) || byString(a.name, b.name),
    ),
    spellListTableGaps: [],
  };
  Object.assign(index.counts, {
    armor: index.armor.length,
    backgrounds: index.backgrounds.length,
    classFeatures: CLASSES.reduce((n, c) => n + classes[c].features.length, 0),
    classes: CLASSES.length,
    featureOptions: index.featureOptions.length,
    feats: index.feats.length,
    species: index.species.length,
    speciesTraits: index.speciesTraits.length,
    spells: index.spells.length,
    subclassFeatures: Object.values(subclasses).reduce((n, s) => n + s.features.length, 0),
    subclasses: Object.keys(subclasses).length,
    weapons: index.weapons.length,
    monsters: index.monsters!.length,
    monsterDetails: index.monsterDetails!.length,
    magicItems: index.magicItems!.length,
  });
  problems.push(...validateIndex(index));
  const lists = crossCheckSpellLists(spells, parseSpellListTables(lines));
  problems.push(...lists.problems);
  index.spellListTableGaps.push(...lists.gaps);
  if (problems.length) throw new Error(`srd-index failed validation:\n  ${problems.join('\n  ')}`);
  return index;
}

function assembleClass(
  cls: ClassId,
  t: ClassTable,
  headings: readonly { level: number; name: string; page: number }[],
  chapter: { first: number; last: number } | undefined,
  hitDie: number,
  problems: string[],
): IndexClass {
  if (!chapter) problems.push(`${cls}: no class chapter heading`);
  const key = (level: number, name: string) => `${level}\u0000${name}`;
  const described = new Map(headings.map((h) => [key(h.level, h.name), h.page]));
  const inTable = new Set(t.features.map((f) => key(f.level, f.name)));
  for (const h of headings) {
    if (!inTable.has(key(h.level, h.name))) problems.push(`${cls}: heading "Level ${h.level}: ${h.name}" (p.${h.page}) is not in the ${cls} Features table`);
  }
  const features: IndexFeature[] = t.features
    .map((f) => {
      const page = described.get(key(f.level, f.name));
      return { ...f, page: page ?? t.page, described: page !== undefined };
    })
    .sort(byLevelName);
  for (const f of features) {
    // A feature without a heading must be a repeat of one that has one.
    if (!f.described && !features.some((g) => g.described && g.name === f.name && g.level < f.level)) {
      problems.push(`${cls}: table feature "${f.name}" (level ${f.level}) has no description heading`);
    }
  }
  return {
    name: cls[0]!.toUpperCase() + cls.slice(1),
    hitDie,
    chapter: chapter ?? { first: 0, last: 0 },
    table: { page: t.page, columnOrder: t.columnOrder, units: t.units, columns: t.columns },
    features,
    subclassLevels: t.subclassLevels,
  };
}

const nonDecreasing = (xs: readonly number[]) => xs.every((x, i) => i === 0 || x >= xs[i - 1]!);

export function validateIndex(ix: SrdIndex): string[] {
  const p: string[] = [];
  const count = (what: string, got: number, want: number) => {
    if (got !== want) p.push(`${what}: ${got}, expected ${want}`);
  };
  count('pages', ix.source.pages, EXPECT.pages);
  count('spells', ix.spells.length, EXPECT.spells);
  if (ix.spellDetails) {
    count('spell details', ix.spellDetails.length, EXPECT.spells);
    ix.spellDetails.forEach((d, i) => {
      const h = ix.spells[i];
      if (!h || h.name !== d.name || h.page !== d.page) p.push(`spell details ${d.name} (p.${d.page}) don't line up with the header ${h?.name} (p.${h?.page})`);
    });
  }
  if (ix.monsters) {
    count('stat blocks', ix.monsters.length, EXPECT.monsters);
    count('stat blocks that parse whole', ix.monsterDetails?.length ?? 0, EXPECT.monsterDetails);
    const heads = new Set(ix.monsters.map((m) => `${m.name}|${m.page}`));
    for (const d of ix.monsterDetails ?? []) if (!heads.has(`${d.name}|${d.page}`)) p.push(`stat block details ${d.name} (p.${d.page}) have no header`);
  }
  if (ix.magicItems) count('magic items', ix.magicItems.length, EXPECT.magicItems);
  count('species', ix.species.length, EXPECT.species);
  count('species traits', ix.speciesTraits.length, EXPECT.speciesTraits);
  for (const sp of ix.species) if (!ix.speciesTraits.some((t) => t.species === sp.name)) p.push(`species ${sp.name}: no traits`);
  const traitKeys = new Set<string>();
  for (const t of ix.speciesTraits) {
    const k = `${t.species}|${t.of ?? ''}|${t.name}`;
    if (traitKeys.has(k)) p.push(`species trait ${k} appears twice`);
    traitKeys.add(k);
    if (!ix.species.some((sp) => sp.name === t.species)) p.push(`species trait ${t.name}: no species ${t.species}`);
    if (t.of !== undefined && !ix.speciesTraits.some((o) => o.species === t.species && o.of === undefined && o.name === t.of)) p.push(`species trait option ${t.name}: no trait ${t.of}`);
  }
  count('backgrounds', ix.backgrounds.length, EXPECT.backgrounds);
  count('feats', ix.feats.length, EXPECT.feats);
  count('subclasses', Object.keys(ix.subclasses).length, EXPECT.subclasses);
  count('weapons', ix.weapons.length, EXPECT.weapons);
  count('armor', ix.armor.length, EXPECT.armor);
  count('feature options', ix.featureOptions.length, EXPECT.featureOptions);
  const optKeys = new Set<string>();
  for (const o of ix.featureOptions) {
    const k = `${o.class}|${o.subclass ?? ''}|${o.level}|${o.feature}|${o.name}`;
    if (optKeys.has(k)) p.push(`feature option ${k} appears twice`);
    optKeys.add(k);
    const feats = o.subclass === undefined ? ix.classes[o.class]?.features : ix.subclasses[o.subclass]?.features;
    if (!feats?.some((f) => f.level === o.level && f.name === o.feature)) p.push(`feature option ${o.name}: no ${o.subclass ?? o.class} feature "Level ${o.level}: ${o.feature}"`);
    if (!/^[A-Z][A-Za-z’' -]+$/.test(o.name)) p.push(`feature option name "${o.name}" (p.${o.page}) looks misparsed`);
  }
  for (const t of ix.speciesTraits) if (t.level !== undefined && (t.of !== undefined || t.level < 2 || t.level > 20)) p.push(`species trait ${t.name}: level ${t.level}`);
  for (const [kind, list] of [
    ['spell', ix.spells],
    ['species', ix.species],
    ['background', ix.backgrounds],
    ['feat', ix.feats],
    ['weapon', ix.weapons],
    ['armor', ix.armor],
    ['stat block', ix.monsters ?? []],
    ['magic item', ix.magicItems ?? []],
  ] as const) {
    const seen = new Set<string>();
    for (const e of list as readonly { name: string }[]) {
      if (seen.has(e.name)) p.push(`${kind} "${e.name}" appears twice`);
      seen.add(e.name);
    }
  }

  const slotGrid = (cls: ClassId, n: number) =>
    Array.from({ length: n }, (_, k) => ix.classes[cls].table.columns[`slot-${k + 1}`]!.join(',')).join('|');
  for (const cls of CLASSES) {
    const c = ix.classes[cls];
    const cols = c.table.columns;
    for (const id of c.table.columnOrder) {
      const col = cols[id];
      if (!col || col.length !== 20) {
        p.push(`${cls}.${id}: ${col?.length ?? 0} rows, expected 20`);
        continue;
      }
      // Every column of every 2024 class table only grows with level.
      if (!nonDecreasing(col)) p.push(`${cls}.${id} decreases: ${col.join(',')}`);
    }
    const pb = cols['proficiency-bonus'] ?? [];
    pb.forEach((v, i) => {
      if (v !== 2 + Math.floor(i / 4)) p.push(`${cls} level ${i + 1}: proficiency bonus +${v}`);
    });
    // A slot level opens only once the one below it is open.
    for (let n = 2; cols[`slot-${n}`]; n++) {
      cols[`slot-${n}`]!.forEach((v, i) => {
        if (v > 0 && cols[`slot-${n - 1}`]![i] === 0) p.push(`${cls} level ${i + 1}: slot ${n} without slot ${n - 1}`);
      });
    }
    if (ix.hitPoints.level1.values[cls] !== c.hitDie) p.push(`${cls}: level 1 HP ${ix.hitPoints.level1.values[cls]} vs hit die d${c.hitDie}`);
    if (ix.hitPoints.fixedPerLevel.values[cls] !== c.hitDie / 2 + 1) p.push(`${cls}: fixed HP ${ix.hitPoints.fixedPerLevel.values[cls]} vs hit die d${c.hitDie}`);

    const subs = Object.values(ix.subclasses).filter((s) => s.class === cls);
    if (subs.length !== 1) p.push(`${cls}: ${subs.length} subclasses, expected 1`);
    for (const s of subs) {
      const got = [...new Set(s.features.map((f) => f.level))].join(',');
      const want = [...new Set([3, ...c.subclassLevels])].sort((a, b) => a - b).join(',');
      if (got !== want) p.push(`${s.name}: feature levels ${got}, but the ${cls} table has subclass levels ${want}`);
    }
    if (!c.features.some((f) => f.level === 3 && f.name === `${c.name} Subclass`)) p.push(`${cls}: no "${c.name} Subclass" at level 3`);
  }
  // Full casters share one slot grid, half casters another.
  const full = slotGrid('wizard', 9);
  for (const cls of ['bard', 'cleric', 'druid', 'sorcerer'] as const) if (slotGrid(cls, 9) !== full) p.push(`${cls}: slot grid differs from the wizard's`);
  if (slotGrid('paladin', 5) !== slotGrid('ranger', 5)) p.push('paladin and ranger slot grids differ');

  for (const s of ix.spells) {
    if (s.classes.length === 0) p.push(`spell "${s.name}" is on no class list`);
    if (!/^[A-Z][A-Za-z’'/ -]+$/.test(s.name)) p.push(`spell name "${s.name}" (p.${s.page}) looks misparsed`);
  }
  const named = [...ix.species, ...ix.speciesTraits, ...ix.backgrounds, ...ix.feats, ...ix.weapons, ...ix.armor];
  for (const e of named) if (!/^[A-Z][A-Za-z’'() -]+$/.test(e.name)) p.push(`name "${e.name}" (p.${e.page}) looks misparsed`);
  return p;
}

/**
 * Entries in a spell's header list that the class chapter's spell list table omits, checked
 * by hand in SRD 5.2.1 (2026-11-03): the spells' own headers name these classes, the tables
 * skip them. The headers decide (C2), so these stay on the class lists; any other
 * disagreement fails the build.
 */
export const KNOWN_LIST_TABLE_GAPS: readonly string[] = [
  'bard|2|Phantasmal Force',
  'sorcerer|2|Mind Spike',
  'sorcerer|2|Phantasmal Force',
  'wizard|2|Phantasmal Force',
];

/** Header class lists (C2) against the class chapters' spell list tables. */
export function crossCheckSpellLists(
  spells: readonly SpellHeader[],
  lists: readonly { class: ClassId; level: number; name: string; page: number }[],
): { problems: string[]; gaps: { class: ClassId; level: number; name: string }[] } {
  const p: string[] = [];
  const gaps: { class: ClassId; level: number; name: string }[] = [];
  const fromHeaders = new Set(spells.flatMap((s) => s.classes.map((c) => `${c}|${s.level}|${s.name}`)));
  const fromTables = new Set<string>();
  for (const e of lists) {
    const k = `${e.class}|${e.level}|${e.name}`;
    if (fromTables.has(k)) p.push(`${e.class} spell list lists "${e.name}" twice (p.${e.page})`);
    fromTables.add(k);
  }
  for (const k of [...fromTables].sort(byString)) if (!fromHeaders.has(k)) p.push(`spell list table has ${k}, the spell headers don't`);
  for (const k of [...fromHeaders].sort(byString)) {
    if (fromTables.has(k)) continue;
    if (!KNOWN_LIST_TABLE_GAPS.includes(k)) {
      p.push(`spell headers have ${k}, the class's spell list table doesn't`);
      continue;
    }
    const [cls, level, name] = k.split('|') as [ClassId, string, string];
    gaps.push({ class: cls, level: Number(level), name });
  }
  for (const k of KNOWN_LIST_TABLE_GAPS) if (!fromHeaders.has(k) || fromTables.has(k)) p.push(`known spell list gap ${k} no longer holds; update KNOWN_LIST_TABLE_GAPS`);
  return { problems: p, gaps };
}
