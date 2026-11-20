// Class and subclass feature headings ("Level 3: Primal Knowledge") from the class chapters.
//
// Each class chapter opens with an h2 class name. Its "Level N: Name" h4 headings are class
// features until the h3 "<Class> Subclass:" heading (which wraps: "Monk Subclass: Warrior of
// the" + "Open Hand"); from there to the next class (or the next h1) they are that
// subclass's features. Spell list pages sit between the two and use h5 titles, so they
// never look like features.

import { type Line, STYLE, continues, isStyle } from './lines.ts';
import { type ClassId, isClassId, kebab, titleCase } from './names.ts';

export interface Heading {
  readonly level: number;
  readonly name: string;
  readonly page: number;
}

export interface SubclassHeadings {
  readonly id: string;
  readonly class: ClassId;
  readonly name: string;
  readonly page: number;
  readonly features: Heading[];
}

/**
 * An option a class or subclass feature offers (M3 step 3: the options' C4 tuples). Two
 * shapes in the PDF: a run-in heading indented under a "Level N: Name" feature whose intro
 * offers a choice ("one of the following ... of your choice", "the option below"): Divine
 * Order's Protector, Fighting Style's Blessed Warrior, Hunter's Prey's Colossus Slayer; and
 * an h4 heading in a class's "<X> Options" section, an option of the class feature whose
 * name starts with X (Metamagic Options -> Metamagic, Eldritch Invocation Options ->
 * Eldritch Invocations).
 */
export interface FeatureOption {
  readonly class: ClassId;
  /** The subclass's id (kebab name) when the feature is a subclass's. */
  readonly subclass?: string;
  /** The feature's level and name, as in its "Level N: Name" heading. */
  readonly level: number;
  readonly feature: string;
  readonly name: string;
  readonly page: number;
}

export interface ChapterHeadings {
  readonly classFeatures: Partial<Record<ClassId, Heading[]>>;
  readonly subclasses: SubclassHeadings[];
  /** First and last page of each class chapter. */
  readonly chapters: Partial<Record<ClassId, { first: number; last: number }>>;
  readonly options: FeatureOption[];
}

const LEVEL = /^Level (\d{1,2}): (.+)$/;

/** A run-in heading's name (as origins.ts reads them): title-case words, then a period. */
const RUN_IN = /^([A-Z][A-Za-z’']*(?: (?:of|the|[A-Z][A-Za-z’'-]*))*)\.(?: |$)/;

/** A feature intro that offers its run-ins as options; one that points to an options section doesn't. */
const OFFERS = /of your choice|the option below/;
const ELSEWHERE = /later in this class/;

/** An "<X> Options" section heading (h3) inside a class chapter. */
const OPTIONS_SECTION = /^(.+) Options$/;

/** Join a heading with the lines directly under it in the same style. */
function joined(lines: readonly Line[], i: number): { text: string; next: number } {
  let text = lines[i]!.text;
  let j = i + 1;
  while (continues(lines[j - 1]!, lines[j]) && !LEVEL.test(lines[j]!.text)) text = `${text} ${lines[j++]!.text}`;
  return { text, next: j };
}

export function parseChapterHeadings(lines: readonly Line[]): ChapterHeadings {
  const classFeatures: Partial<Record<ClassId, Heading[]>> = {};
  const chapters: Partial<Record<ClassId, { first: number; last: number }>> = {};
  const subclasses: SubclassHeadings[] = [];
  const options: FeatureOption[] = [];
  // Each column's left edge (its leftmost line), so a run-in's indent survives column breaks.
  const left = new Map<string, number>();
  for (const l of lines) {
    const k = `${l.page}:${l.col}`;
    left.set(k, Math.min(left.get(k) ?? Number.POSITIVE_INFINITY, l.x));
  }
  let cls: ClassId | undefined;
  let sub: SubclassHeadings | undefined;
  let inClasses = false;
  /** The feature whose body is being read: its intro text until the first run-in. */
  let feat: { level: number; name: string; intro: string; runIns: boolean } | undefined;
  /** An "<X> Options" section: its h4 headings are options of the class feature `of`. */
  let section: { of: Heading } | undefined;
  const ownerOf = (): { class: ClassId; subclass?: string } => (sub ? { class: cls!, subclass: sub.id } : { class: cls! });
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (isStyle(l, STYLE.h1)) {
      inClasses = l.text === 'Classes';
      cls = undefined;
      sub = undefined;
      feat = undefined;
      section = undefined;
      continue;
    }
    if (!inClasses) continue;
    const id = l.text.toLowerCase();
    if (isStyle(l, STYLE.h2) && isClassId(id)) {
      if (classFeatures[id]) throw new Error(`class chapter "${l.text}" appears twice (p.${l.page})`);
      cls = id;
      sub = undefined;
      feat = undefined;
      section = undefined;
      classFeatures[id] = [];
      chapters[id] = { first: l.page, last: l.page };
      continue;
    }
    if (!cls) continue;
    chapters[cls]!.last = l.page;
    if (isStyle(l, STYLE.h2) || isStyle(l, STYLE.h3)) {
      feat = undefined;
      section = undefined;
    }
    if (isStyle(l, STYLE.h3) && l.text.startsWith(`${titleCase(cls)} Subclass:`)) {
      if (sub) throw new Error(`${cls}: a second subclass heading on p.${l.page}`);
      const j = joined(lines, i);
      const name = j.text.slice(`${titleCase(cls)} Subclass:`.length).trim();
      if (name === '') throw new Error(`${cls}: subclass heading without a name on p.${l.page}`);
      sub = { id: kebab(name), class: cls, name, page: l.page, features: [] };
      subclasses.push(sub);
      i = j.next - 1;
      continue;
    }
    const os = isStyle(l, STYLE.h3) && !sub ? OPTIONS_SECTION.exec(l.text) : null;
    if (os) {
      const prefix = os[1]!;
      const of = (classFeatures[cls] ?? []).filter((h) => h.name.startsWith(prefix));
      if (of.length !== 1) throw new Error(`${cls}: section "${l.text}" (p.${l.page}) matches ${of.length} class features`);
      section = { of: of[0]! };
      continue;
    }
    const m = isStyle(l, STYLE.h4) ? LEVEL.exec(l.text) : null;
    if (m) {
      const j = joined(lines, i);
      const name = LEVEL.exec(j.text)![2]!;
      const h = { level: Number(m[1]), name, page: l.page };
      (sub ? sub.features : classFeatures[cls]!).push(h);
      feat = { level: h.level, name, intro: '', runIns: false };
      section = undefined;
      i = j.next - 1;
      continue;
    }
    if (isStyle(l, STYLE.h4)) {
      feat = undefined;
      if (section) {
        const j = joined(lines, i);
        options.push({ ...ownerOf(), level: section.of.level, feature: section.of.name, name: j.text, page: l.page });
        i = j.next - 1;
      }
      continue;
    }
    if (!feat) continue;
    const r = isStyle(l, STYLE.runIn) && l.x - left.get(`${l.page}:${l.col}`)! >= 2 ? RUN_IN.exec(l.text) : null;
    if (r) {
      // Only an intro that offers a choice makes its run-ins options ("Spellcasting Focus." is a rule).
      if (!feat.runIns && !(OFFERS.test(feat.intro) && !ELSEWHERE.test(feat.intro))) feat = undefined;
      else {
        feat.runIns = true;
        options.push({ ...ownerOf(), level: feat.level, feature: feat.name, name: r[1]!, page: l.page });
      }
      continue;
    }
    if (!feat.runIns) feat.intro = `${feat.intro} ${l.text}`;
  }
  return { classFeatures, subclasses, chapters, options };
}
