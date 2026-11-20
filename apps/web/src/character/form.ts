// The Character screen's pick form (docs/design/m3.md 10, "Web"; PLAN.md UI screen 6): class,
// level, subclass, species, background, scores and every required pick, generated from the
// data's choices (buildNeeds), turned into a kind: character YAML text like `montecrit new
// character` writes (apps/cli/src/character.ts runNewCharacter), with the chosen picks filled in
// and the rest left as commented lists of legal options. Pure.

import { ABILITIES, MODELED_MAX_LEVEL, type Ability, type CharacterLib } from '@montecrit/engine';
import { buildNeeds, byString, equipmentComment, picksBlock, type BackgroundSrc, type ClassSrc, type Need, type SpeciesSrc, type SubclassSrc } from '@montecrit/host';

/** An ASI level: +2 to one score, +1 to two, or a General feat. A background's: +2/+1 or +1 to all three. */
export interface AsiPick {
  readonly mode: 'two' | 'oneone' | 'feat' | 'all';
  readonly a: string;
  readonly b: string;
  readonly feat: string;
}

export type PickInput = readonly string[] | AsiPick;

export interface CharacterForm {
  readonly id: string;
  readonly name: string;
  readonly cls: string;
  readonly level: number;
  readonly subclass: string;
  readonly species: string;
  readonly size: string;
  readonly background: string;
  readonly abilities: Readonly<Record<Ability, number>>;
  readonly hp: 'average' | 'max';
  /** By pick key; a choice holds one entry per option slot ('' when unset). */
  readonly picks: Readonly<Record<string, PickInput>>;
}

export const LEVELS: readonly number[] = Array.from({ length: MODELED_MAX_LEVEL }, (_, i) => i + 1);

const sorted = <T extends { readonly id: string; readonly name: string }>(m: ReadonlyMap<string, T>): T[] => [...m.values()].sort((a, b) => byString(a.name, b.name) || byString(a.id, b.id));

/** The form's lists, in name order. */
export function formOptions(lib: CharacterLib, form: Pick<CharacterForm, 'cls' | 'level' | 'species'>) {
  const cls = lib.classes.get(form.cls);
  const subclasses = cls ? sorted(lib.subclasses).filter((s) => s.parent === cls.id) : [];
  const species = lib.species.get(form.species);
  return {
    classes: sorted(lib.classes),
    subclasses,
    subclassOpen: cls !== undefined && form.level >= cls.subclassLevel,
    subclassLevel: cls?.subclassLevel ?? null,
    species: sorted(lib.species),
    sizes: species ? [...species.size] : [],
    backgrounds: sorted(lib.backgrounds),
  };
}

/** A starting form: the first class, species and background by name, scores 10. */
export function defaultForm(lib: CharacterLib, id: string): CharacterForm {
  const o = formOptions(lib, { cls: '', level: 1, species: '' });
  return {
    id,
    name: 'New Character',
    cls: o.classes[0]?.id ?? '',
    level: 1,
    subclass: '',
    species: o.species[0]?.id ?? '',
    size: '',
    background: o.backgrounds[0]?.id ?? '',
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    hp: 'average',
    picks: {},
  };
}

interface Resolved {
  readonly cls: ClassSrc | undefined;
  readonly sub: SubclassSrc | undefined;
  readonly species: SpeciesSrc | undefined;
  readonly bg: BackgroundSrc | undefined;
}

/** The form's ids as data; a subclass counts only from the class's subclass level, and only its own. */
export function resolveForm(lib: CharacterLib, form: CharacterForm): Resolved {
  const cls = lib.classes.get(form.cls);
  const sub0 = form.subclass !== '' ? lib.subclasses.get(form.subclass) : undefined;
  const sub = cls && sub0 && sub0.parent === cls.id && form.level >= cls.subclassLevel ? sub0 : undefined;
  return { cls, sub, species: lib.species.get(form.species), bg: lib.backgrounds.get(form.background) };
}

/** The picks the form's build asks for (empty without a class). */
export function formNeeds(lib: CharacterLib, form: CharacterForm): Need[] {
  const r = resolveForm(lib, form);
  return r.cls ? buildNeeds(lib, r.cls, r.sub, r.species, r.bg, form.level) : [];
}

const isAbility = (s: string): s is Ability => (ABILITIES as readonly string[]).includes(s);

/** One pick's YAML value, or null while it's unanswered. */
export function pickValue(n: Need, input: PickInput | undefined): string | null {
  if (input === undefined) return null;
  if (Array.isArray(input)) {
    const legal = new Set(n.options.map((o) => o.id));
    const chosen = (input as readonly string[]).filter((x) => x !== '' && legal.has(x));
    return chosen.length > 0 ? `[${chosen.map(scalar).join(', ')}]` : null;
  }
  const p = input as AsiPick;
  if (n.kind === 'asi') {
    if (p.mode === 'feat') return n.options.some((o) => o.id === p.feat) ? `{ feat: ${p.feat} }` : null;
    if (p.mode === 'two') return isAbility(p.a) ? `{ asi: { ${p.a}: 2 } }` : null;
    if (p.mode === 'oneone') return isAbility(p.a) && isAbility(p.b) && p.a !== p.b ? `{ asi: { ${ordered([p.a, p.b]).map((a) => `${a}: 1`).join(', ')} } }` : null;
    return null;
  }
  if (n.kind === 'abilities') {
    const among = n.options.map((o) => o.id).filter(isAbility);
    if (p.mode === 'all') return among.length > 0 ? `{ asi: { ${ordered(among).map((a) => `${a}: 1`).join(', ')} } }` : null;
    if (p.mode === 'two') {
      if (!among.includes(p.a as Ability) || !among.includes(p.b as Ability) || p.a === p.b) return null;
      return `{ asi: { ${ordered([p.a as Ability, p.b as Ability]).map((a) => `${a}: ${a === p.a ? 2 : 1}`).join(', ')} } }`;
    }
  }
  return null;
}

const ordered = (xs: readonly Ability[]): Ability[] => ABILITIES.filter((a) => xs.includes(a));

/** A YAML plain scalar where that's safe, else a quoted string (tool names like "Gaming Set (Dice)" are fine plain). */
const scalar = (s: string): string => (/^[A-Za-z0-9][A-Za-z0-9 _:/#().'-]*$/.test(s) && !/:\s|\s#|:$/.test(s) ? s : JSON.stringify(s));

/** The form as a kind: character text. Unanswered picks stay as commented lists of their options. */
export function formToYaml(lib: CharacterLib, form: CharacterForm): string {
  const r = resolveForm(lib, form);
  const needs = formNeeds(lib, form);
  const filled = new Map<string, string>();
  for (const n of needs) {
    const v = pickValue(n, form.picks[n.key]);
    if (v !== null) filled.set(n.key, v);
  }
  const lines: string[] = [
    '# Built with the Character screen (the same skeleton as montecrit new character); fill in every TODO and every pick.',
    'kind: character',
    `id: ${form.id}`,
    `name: ${JSON.stringify(form.name)}`,
    "rules: '2024'",
  ];
  if (r.cls) {
    if (!r.sub && form.level >= r.cls.subclassLevel) lines.push(`# TODO subclass: a level ${form.level} ${r.cls.name} has one (from level ${r.cls.subclassLevel})`);
    lines.push(`classes: [{ class: ${r.cls.id}, level: ${form.level}${r.sub ? `, subclass: ${r.sub.id}` : ''} }]`);
  } else lines.push('# TODO class', 'classes: [{ class: TODO, level: 1 }]');
  if (r.species) {
    lines.push(`species: ${r.species.id}`);
    if (r.species.size.length > 1) lines.push(r.species.size.includes(form.size as never) ? `size: ${form.size}` : `size: ${r.species.size[0]}  # TODO a ${r.species.name} can be ${r.species.size.join(' or ')}: choose one`);
  } else lines.push('species: TODO');
  lines.push(r.bg ? `background: ${r.bg.id}` : 'background: TODO');
  lines.push('# abilities: the final scores, increases included');
  lines.push(`abilities: { ${ABILITIES.map((a) => `${a}: ${form.abilities[a]}`).join(', ')} }`);
  lines.push(`hp: ${form.hp}`);
  // The CLI's picks block (@montecrit/host picksBlock); unfilled, its examples stay commented and the hint names the form.
  lines.push(...picksBlock(needs, filled, { hint: 'choose them in the form (an empty picks: block would not load)', bare: false }));
  if (needs.some((n) => n.options.some((o) => lib.feats.has(o.id)))) lines.push('# A feat picked above may ask for picks of its own (<feat id>#<choice>): the lint lists them.');
  if (r.cls) lines.push(...equipmentComment(lib, r.cls));
  lines.push('equipment: { armor: null, shield: false, weapons: [] }');
  const casting = [r.cls?.spellcasting ? r.cls.id : null, r.sub?.spellcasting ? r.sub.id : null].filter((x): x is string => x !== null);
  if (casting.length > 0) lines.push('# casting: the cantrips and prepared spells chosen per source (the sheet shows how many the table allows)', 'casting:', ...casting.map((s) => `  - { source: ${s}, cantrips: [], prepared: [] }`));
  return `${lines.join('\n')}\n`;
}
