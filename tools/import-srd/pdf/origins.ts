// Backgrounds, species and feats: the h4 headings of their description sections, each
// recognized by the line that must follow it, so a stray h4 (a "Parts of a Species" topic
// like "Size") can't pass for an entry:
//   background  h4 name, then "Ability Scores: ..."  (under h3 "Background Descriptions")
//   species     h4 name, then "Creature Type: ..."   (under h3 "Species Descriptions")
//   feat        h4 name, then an italic "<Category> Feat" line (in the h1 "Feats" chapter)
//
// Species traits (the gate's (species, trait) tuples, C4): each trait is a run-in heading
// ("Dwarven Toughness. Your Hit Point...") whose bold lead makes the line box 35.1 pt tall
// (STYLE.runIn). A run-in indented past the species heading is a trait; one at the heading's
// column's left edge is an option of the trait before it (Goliath's "Cloud's Jaunt (Cloud Giant).", the
// "Forest Gnome." lineage). A lineage table's first-column cells ("Elven Lineages": Drow,
// High Elf, Wood Elf) are options of the trait the title names in the plural ("Elven
// Lineage"); a table can float into the previous species' column, so tables are matched by
// that name, not by position.

import { type Line, STYLE, isStyle } from './lines.ts';
import { kebab } from './names.ts';

export interface Named {
  readonly name: string;
  readonly page: number;
}

export interface Feat extends Named {
  /** "origin", "general", "fighting-style", "epic-boon". */
  readonly category: string;
}

/** A species trait, or with `of` an option of one (a Giant Ancestry, a lineage). */
export interface SpeciesTrait extends Named {
  readonly species: string;
  readonly of?: string;
  /**
   * The character level a trait starts at, when its text opens with "When you reach character
   * level N" or "Starting at character level N" (Draconic Flight, Large Form: 5); absent = 1.
   */
  readonly level?: number;
}

export interface Origins {
  readonly backgrounds: Named[];
  readonly species: Named[];
  readonly feats: Feat[];
  readonly speciesTraits: SpeciesTrait[];
}

/** A run-in heading's name: title-case words, an optional parenthetical, then a period. */
const RUN_IN = /^([A-Z][A-Za-z’']*(?: (?:of|the|[A-Z][A-Za-z’'-]*))*)(?: \([^)]*\))?\.(?: |$)/;

/** "Elven Lineages" -> "Elven Lineage", "Fiendish Legacies" -> "Fiendish Legacy". */
const singular = (s: string): string => (s.endsWith('ies') ? `${s.slice(0, -3)}y` : s.endsWith('s') ? s.slice(0, -1) : s);

/** A trait's opening words that gate it on a character level (read across one line break). */
const STARTS_AT = /^(?:When you reach|Starting at) character level (\d{1,2})\b/;

const FEAT_LINE = /^(Origin|General|Fighting Style|Epic Boon) Feat(?: \(Prerequisite: .*)?$/;

export function parseOrigins(lines: readonly Line[]): Origins {
  const backgrounds: Named[] = [];
  const species: Named[] = [];
  const feats: Feat[] = [];
  const speciesTraits: SpeciesTrait[] = [];
  const tables: { title: string; page: number; rows: string[] }[] = [];
  let curSpecies: Line | undefined;
  let lastTrait: string | undefined;
  // Each column's left edge (its leftmost line), so indentation survives column breaks.
  const left = new Map<string, number>();
  for (const l of lines) {
    const k = `${l.page}:${l.col}`;
    left.set(k, Math.min(left.get(k) ?? Number.POSITIVE_INFINITY, l.x));
  }
  let section: 'backgrounds' | 'species' | 'feats' | undefined;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (section === 'species' && curSpecies && isStyle(l, STYLE.runIn)) {
      const m = RUN_IN.exec(l.text);
      if (m) {
        const option = l.x - left.get(`${l.page}:${l.col}`)! < 2 && lastTrait !== undefined;
        const rest = `${l.text.slice(m[0].length)} ${lines[i + 1]?.text ?? ''}`.trim();
        const at = option ? null : STARTS_AT.exec(rest);
        speciesTraits.push({ species: curSpecies.text, name: m[1]!, page: l.page, ...(option ? { of: lastTrait } : {}), ...(at ? { level: Number(at[1]) } : {}) });
        if (!option) lastTrait = m[1]!;
      }
    }
    if (section === 'species' && curSpecies && isStyle(l, STYLE.h5)) {
      // First-column cells: the leftmost cell x, header row excluded (it sits 0.4 pt right).
      const cells: Line[] = [];
      for (let j = i + 1; j < lines.length && isStyle(lines[j], STYLE.row); j++) cells.push(lines[j]!);
      const minX = Math.min(...cells.map((c) => c.x));
      tables.push({ title: l.text, page: l.page, rows: cells.filter((c) => Math.abs(c.x - minX) < 0.2).map((c) => c.text) });
    }
    if (isStyle(l, STYLE.h1)) section = l.text === 'Feats' ? 'feats' : undefined;
    else if (isStyle(l, STYLE.h2) && section !== 'feats') section = undefined;
    else if (isStyle(l, STYLE.h3) && l.text === 'Background Descriptions') section = 'backgrounds';
    else if (isStyle(l, STYLE.h3) && l.text === 'Species Descriptions') section = 'species';
    if (!section || !isStyle(l, STYLE.h4)) continue;
    const next = lines[i + 1];
    if (section === 'backgrounds' && next?.text.startsWith('Ability Scores:')) backgrounds.push({ name: l.text, page: l.page });
    if (section === 'species' && next?.text.startsWith('Creature Type:')) {
      species.push({ name: l.text, page: l.page });
      curSpecies = l;
      lastTrait = undefined;
    }
    const f = section === 'feats' && isStyle(next, STYLE.sub) ? FEAT_LINE.exec(next!.text) : null;
    if (f) feats.push({ name: l.text, category: kebab(f[1]!), page: l.page });
  }
  // Lineage tables: options of the trait the title names, wherever that trait is.
  for (const t of tables) {
    const owners = speciesTraits.filter((tr) => tr.of === undefined && tr.name === singular(t.title));
    if (owners.length !== 1) continue; // not a lineage table (Draconic Ancestors lists dragons)
    for (const row of t.rows) speciesTraits.push({ species: owners[0]!.species, name: row, page: t.page, of: owners[0]!.name });
  }
  return { backgrounds, species, feats, speciesTraits };
}
