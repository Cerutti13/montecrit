// The character-building data and the picks a build asks for (docs/design/m3.md 10), shared by the
// CLI's `build`, `new character` and `migrate` (apps/cli/src/character.ts) and the browser's
// Character screen (apps/web/src/character/). Pure: texts in, data and comment lines out. The
// expansion itself is the engine's (content/character.ts); this reads the character-building data
// back out of the loaded texts to list the choices.

import { CONTENT_SCHEMAS, WEAPON_MASTERY, parseYaml, type CharacterLib, type SourceFile } from '@montecrit/engine';

export type ClassSrc = CharacterLib['classes'] extends ReadonlyMap<string, infer T> ? T : never;
export type SubclassSrc = CharacterLib['subclasses'] extends ReadonlyMap<string, infer T> ? T : never;
export type SpeciesSrc = CharacterLib['species'] extends ReadonlyMap<string, infer T> ? T : never;
export type BackgroundSrc = CharacterLib['backgrounds'] extends ReadonlyMap<string, infer T> ? T : never;
type Choice = ClassSrc['choices'][number];

/** String order with < and > (no locale). */
export const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const LIB_KINDS: Readonly<Record<string, keyof CharacterLib>> = {
  class: 'classes',
  subclass: 'subclasses',
  species: 'species',
  background: 'backgrounds',
  feat: 'feats',
  weapon: 'weapons',
  armor: 'armor',
  feature: 'features',
};

/**
 * The character-building data in a set of loaded texts, parsed with the engine's own schemas
 * (defaults applied). Call it only on texts that loaded without errors: an item that doesn't
 * parse is skipped here because the load has already reported it. The first definition of an id
 * wins, in path order.
 */
export function characterLib(files: readonly SourceFile[]): CharacterLib {
  const maps: Record<string, Map<string, unknown>> = {};
  for (const k of Object.values(LIB_KINDS)) maps[k] = new Map();
  const kinds = new Map<string, string>();
  for (const f of [...files].sort((a, b) => byString(a.path, b.path))) {
    if (!/\.ya?ml$/i.test(f.path) || f.path.endsWith('/manifest.yaml')) continue;
    const { doc } = parseYaml(f.text, f.path);
    if (!doc) continue;
    const entries = Array.isArray(doc.value) ? (doc.value as unknown[]) : [doc.value];
    for (const v of entries) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      const rec = v as Record<string, unknown>;
      if (typeof rec.kind !== 'string' || typeof rec.id !== 'string') continue;
      if (!kinds.has(rec.id)) kinds.set(rec.id, rec.kind);
      const target = Object.hasOwn(LIB_KINDS, rec.kind) ? LIB_KINDS[rec.kind]! : undefined;
      if (target === undefined) continue;
      const schema = CONTENT_SCHEMAS.find(([name]) => name === rec.kind)![1] as { safeParse: (x: unknown) => { success: boolean; data?: unknown } };
      const r = schema.safeParse(v);
      if (r.success && !maps[target]!.has(rec.id)) maps[target]!.set(rec.id, r.data);
    }
  }
  return { kinds, ...(maps as unknown as Omit<CharacterLib, 'kinds'>) };
}

// ---- The picks a build needs ----

/** One choice the character file answers under picks. */
export interface Need {
  readonly key: string;
  /** 'Monk level 1', 'Dwarf', 'Soldier'. */
  readonly where: string;
  readonly kind: 'choice' | 'asi' | 'abilities';
  readonly choose: number;
  /** What the options are: skills, features, feats, abilities, tools or weapons. */
  readonly what: string;
  /** Option ids, each with its name when it has one. */
  readonly options: readonly { readonly id: string; readonly name: string | null }[];
}

/**
 * Every pick a build asks for at a level, in the order the engine answers them
 * (content/character.ts: class skills and choices, Weapon Mastery, ASI levels, subclass, species,
 * background, the background's increases, then the background's origin feat). A feat taken
 * through a pick adds its own choices, which only the expansion can list (it knows the pick).
 */
export function buildNeeds(lib: CharacterLib, cls: ClassSrc, sub: SubclassSrc | undefined, species: SpeciesSrc | undefined, bg: BackgroundSrc | undefined, level: number): Need[] {
  const out: Need[] = [];
  const nameOf = (id: string): string | null => lib.features.get(id)?.name ?? lib.feats.get(id)?.name ?? null;
  const add = (ownerId: string, where: (ch: Choice) => string, choices: readonly Choice[]) => {
    for (const ch of choices) {
      if (ch.level > level) continue;
      const lists = (['skills', 'features', 'feats', 'abilities', 'tools'] as const).filter((k) => ch.from[k] !== undefined);
      const options: { id: string; name: string | null }[] = [];
      for (const k of lists) for (const o of ch.from[k] ?? []) options.push({ id: o, name: k === 'features' || k === 'feats' ? nameOf(o) : null });
      out.push({ key: `${ownerId}#${ch.id}`, where: where(ch), kind: 'choice', choose: ch.choose, what: lists.join(' or '), options });
    }
  };
  const clsChoices: Choice[] = cls.choices.some((ch) => ch.id === 'skills') ? [...cls.choices] : [{ id: 'skills', level: 1, choose: cls.skills.choose, from: { skills: [...cls.skills.from] } }, ...cls.choices];
  add(cls.id, (ch) => `${cls.name} level ${ch.level}`, clsChoices);
  // M3 step 5b: Weapon Mastery's weapon kinds, the engine's synthetic pick <class>#weapon-mastery
  // (content/character.ts WEAPON_MASTERY), right after the class's own choices as the engine asks it.
  const mastery = masteryNeed(lib, cls, level);
  if (mastery) out.push(mastery);
  const general = [...lib.feats.values()].filter((f) => f.category === 'general').sort((a, b) => byString(a.id, b.id));
  for (const l of cls.asiLevels) {
    if (l > level) continue;
    out.push({ key: `${cls.id}#asi-${l}`, where: `${cls.name} level ${l}`, kind: 'asi', choose: 1, what: 'an Ability Score Improvement or a General feat', options: general.map((f) => ({ id: f.id, name: f.name })) });
  }
  if (sub) add(sub.id, (ch) => `${sub.name} level ${ch.level}`, sub.choices);
  if (species) add(species.id, () => species.name, species.choices);
  if (bg) {
    add(bg.id, () => bg.name, bg.choices);
    out.push({ key: `${bg.id}#abilities`, where: bg.name, kind: 'abilities', choose: 1, what: 'abilities', options: bg.abilities.map((a) => ({ id: a, name: null })) });
    const feat = lib.feats.get(bg.feat);
    if (feat) add(feat.id, () => `${feat.name} (${bg.name}'s origin feat)`, feat.choices);
  }
  return out;
}

/**
 * M3 step 5b: the Weapon Mastery pick a class grants by `level`, or null. The count is the rule's
 * number or its `@scale.<class>.<name>` column at the level (the Fighter and Barbarian tables'
 * Weapon Mastery column); the options are the loaded weapons the rule allows (melee only, the
 * class's proficiencies, or any), by id.
 */
export function masteryNeed(lib: CharacterLib, cls: ClassSrc, level: number): Need | null {
  let grantLevel = 0;
  let rule: (typeof WEAPON_MASTERY)[number] | undefined;
  for (let l = 1; l <= level && !rule; l++) {
    const ids = cls.features[String(l)] ?? [];
    rule = WEAPON_MASTERY.find((m) => ids.includes(m.feature));
    if (rule) grantLevel = l;
  }
  if (!rule) return null;
  let choose = 0;
  if (typeof rule.count === 'number') choose = rule.count;
  else {
    const col = cls.scale[rule.count.slice(rule.count.lastIndexOf('.') + 1)];
    const v = col ? col.at[String(maxKey(col.at, level))] : undefined;
    if (typeof v === 'number') choose = v;
  }
  if (choose <= 0) return null;
  const weapons = [...lib.weapons.values()]
    .filter((w) => (rule.kinds === 'melee' ? w.attack === 'melee' : rule.kinds === 'proficient' ? cls.proficiencies.weapons.includes(w.category) || cls.proficiencies.weapons.includes(w.id) : true))
    .sort((a, b) => byString(a.id, b.id));
  const name = lib.features.get(rule.feature)?.name ?? 'Weapon Mastery';
  return { key: `${cls.id}#weapon-mastery`, where: `${cls.name} level ${grantLevel} (${name})`, kind: 'choice', choose, what: 'weapons', options: weapons.map((w) => ({ id: w.id, name: w.name })) };
}

/** The largest table level at or below `level`. */
function maxKey(at: Readonly<Record<string, unknown>>, level: number): number {
  let best = 0;
  for (const k of Object.keys(at)) if (Number(k) <= level && Number(k) > best) best = Number(k);
  return best;
}

// ---- The picks block's text ----

const optionList = (n: Need): string => n.options.map((o) => (o.name ? `${o.id} (${o.name})` : o.id)).join(', ');

/** The comment lines that explain one need, then its line: filled, an empty example (commented unless bare). */
export function needLines(n: Need, filled: string | null, bare = false): string[] {
  const lines: string[] = [];
  const example = (v: string) => (filled !== null ? `  ${n.key}: ${filled}` : bare ? `  ${n.key}: ${v}` : `  # ${n.key}: ${v}`);
  if (n.kind === 'asi') {
    lines.push(`  # ${n.where}, Ability Score Improvement: { asi: { <ability>: 2 } } or { asi: { <a>: 1, <b>: 1 } }, or { feat: <id> } for a feat instead`);
    if (n.options.length > 0) lines.push(`  #   General feats: ${optionList(n)}`);
    lines.push(example('{ asi: { } }'));
  } else if (n.kind === 'abilities') {
    lines.push(`  # ${n.where}, score increases (optional; the scores above are final): +2 and +1, or +1 to all three, among ${optionList(n)}`);
    lines.push(example('{ asi: { } }'));
  } else {
    lines.push(`  # ${n.where}: choose ${n.choose} (${n.what}) from ${optionList(n)}`);
    lines.push(example('[]'));
  }
  return lines;
}

/** How a picks block with nothing filled reads (the CLI's by default). */
export interface PicksBlockStyle {
  /** The comment that opens the all-commented block, after "# picks: ". */
  readonly hint?: string;
  /** Whether each empty example is a bare line inside the commented block (uncomment once) or commented again. */
  readonly bare?: boolean;
}

/**
 * A picks block. With any pick filled it's a real block, the unfilled picks commented out inside
 * it; with none, the whole block is one comment to fill in and uncomment (an empty picks: would
 * not load).
 */
export function picksBlock(needs: readonly Need[], filled: ReadonlyMap<string, string> = new Map(), style: PicksBlockStyle = {}): string[] {
  if (needs.length === 0) return ['picks: {}  # this build asks for no picks'];
  if (needs.some((n) => filled.has(n.key))) return ['picks:', ...needs.flatMap((n) => needLines(n, filled.get(n.key) ?? null))];
  const hint = style.hint ?? 'fill in every list and uncomment this block (montecrit build shows what is still missing)';
  return [`# picks: ${hint}`, '# picks:', ...needs.flatMap((n) => needLines(n, null, style.bare ?? true)).map((l) => `# ${l}`)];
}

/** The equipment block's comment: what the class is trained with, and the loaded armor and weapon ids. */
export function equipmentComment(lib: CharacterLib, cls: ClassSrc): string[] {
  const armor = [...lib.armor.values()].sort((a, b) => byString(a.id, b.id));
  const weapons = [...lib.weapons.values()].sort((a, b) => byString(a.id, b.id));
  return [
    `# equipment: ${cls.name} training: armor ${cls.proficiencies.armor.join(', ') || 'none'}; weapons ${cls.proficiencies.weapons.join(', ') || 'none'}`,
    `#   armor ids: ${armor.filter((a) => a.category !== 'shield').map((a) => `${a.id} (${a.category})`).join(', ')}`,
    `#   shield: true (or ${armor.filter((a) => a.category === 'shield').map((a) => a.id).join(', ') || 'none loaded'}); weapons: ids, or { id, count } for a thrown stack`,
    `#   weapon ids: ${weapons.map((w) => w.id).join(', ')}`,
  ];
}
