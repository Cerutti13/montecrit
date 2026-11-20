// Character-building data kinds (M3 step 1, docs/design/m3.md 2.2-2.3): class, subclass,
// species, background, feat, weapon and armor. They load, validate and cross-check here, and
// compile into nothing yet: no template, so no closure hash moves (critique resolution C3).
// kind: character (step 3) is what will read them. Checks are the cheap ones: every id they
// name is loaded and of the right kind, and every expression parses with the variables it
// may use at that spot.

import { ExprError, isConstant, type ExprBinding, type ExprNode } from '../dice/expr.ts';
import { localOf } from './compile-spell.ts';
import { compileRoll, errorAt, standInEnv, withMod, type ItemCtx } from './compile.ts';
import type {
  ArmorSource,
  BackgroundSource,
  ClassSource,
  FeatSource,
  RechargeRuleSrc,
  SpeciesSource,
  SubclassSource,
  WeaponSource,
} from './schema.ts';
import type { YamlPath } from './yaml.ts';

export type DataItem =
  | { kind: 'class'; src: ClassSource }
  | { kind: 'subclass'; src: SubclassSource }
  | { kind: 'species'; src: SpeciesSource }
  | { kind: 'background'; src: BackgroundSource }
  | { kind: 'feat'; src: FeatSource }
  | { kind: 'weapon'; src: WeaponSource }
  | { kind: 'armor'; src: ArmorSource };

export const DATA_KINDS = ['class', 'subclass', 'species', 'background', 'feat', 'weapon', 'armor'] as const;

/** What the checks can see of the rest of the load: every id's kind, the classes (for a subclass's parent) and the feats (a background's origin feat). */
export interface DataLib {
  readonly kinds: ReadonlyMap<string, string>;
  readonly classes: ReadonlyMap<string, ClassSource>;
  readonly feats: ReadonlyMap<string, FeatSource>;
}

const byLevelKey = (a: string, b: string): number => Number(a) - Number(b);
const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** An error unless id is loaded as kind `want`. */
function ref(c: ItemCtx, p: YamlPath, id: string, want: string, lib: DataLib): void {
  const k = lib.kinds.get(id);
  if (k === undefined) errorAt(c, p, `no ${want} ${id} is loaded`);
  else if (k !== want) errorAt(c, p, `${id} is a ${k}, not a ${want}`);
}

/** An error at every entry of `list` that repeats an earlier one. */
function noDupes(c: ItemCtx, p: YamlPath, list: readonly string[]): void {
  list.forEach((x, i) => {
    if (list.indexOf(x) !== i) errorAt(c, [...p, i], `${x} is listed twice`);
  });
}

/** ids by level: each loaded as `want`, none twice in one level's list. */
function levelRefs(c: ItemCtx, p: YamlPath, byLevel: Readonly<Record<string, readonly string[]>>, want: string, lib: DataLib): void {
  for (const lvl of Object.keys(byLevel).sort(byLevelKey)) {
    byLevel[lvl]!.forEach((id, i) => ref(c, [...p, lvl, i], id, want, lib));
    noDupes(c, [...p, lvl], byLevel[lvl]!);
  }
}

/** A list of ids: each loaded as `want`, none twice. */
function listRefs(c: ItemCtx, p: YamlPath, ids: readonly string[], want: string, lib: DataLib): void {
  ids.forEach((id, i) => ref(c, [...p, i], id, want, lib));
  noDupes(c, p, ids);
}

const WEAPON_CATEGORIES: readonly string[] = ['simple', 'martial'];

function checkProficiencies(c: ItemCtx, pr: ClassSource['proficiencies'], lib: DataLib): void {
  noDupes(c, ['proficiencies', 'armor'], pr.armor);
  noDupes(c, ['proficiencies', 'weapons'], pr.weapons);
  noDupes(c, ['proficiencies', 'tools'], pr.tools);
  pr.weapons.forEach((w, i) => {
    if (!WEAPON_CATEGORIES.includes(w)) ref(c, ['proficiencies', 'weapons', i], w, 'weapon', lib);
  });
}


type Env = (name: string) => ExprBinding | undefined;

type ScaleColumns = ClassSource['scale'];

/** A species feature entry's id (a bare id, or { id, level }). */
export const speciesFeatureId = (f: SpeciesSource['features'][number]): string => (typeof f === 'string' ? f : f.id);
/** The character level a species feature entry is gained at (1 for a bare id). */
export const speciesFeatureLevel = (f: SpeciesSource['features'][number]): number => (typeof f === 'string' ? 1 : f.level);

/** The @scale scopes a subclass's expressions reach: its own columns, then its parent class's. */
export function subclassScopes(s: SubclassSource, parent: ClassSource | undefined): ScaleScope[] {
  const own: ScaleScope = { names: s.scaleOwner !== undefined && s.scaleOwner !== localOf(s.id) ? [localOf(s.id), s.scaleOwner] : [localOf(s.id)], columns: s.scale };
  return parent ? [own, { names: [localOf(parent.id)], columns: parent.scale }] : [own];
}

/** A dice-valued column's stand-in: dice, so a spot that needs a constant (a pool max, an AC) refuses it. */
const DICE_STAND_IN: ExprNode = { k: 'dice', n: 1, sides: 6 };

/** One owner of @scale columns in an expression's reach: the names it's known by and its columns. */
export interface ScaleScope {
  /** Owner names for the qualified form: a class's local id; a subclass's local id and its scaleOwner. */
  readonly names: readonly string[];
  readonly columns: ScaleColumns;
}

/**
 * Resolves one @scale name against the scopes an item's expression can reach (critique
 * resolution C16), nearest first: a class sees its own columns; a subclass sees its own, then
 * its parent class's. The stored qualified form @scale.<owner>.<column> must name one of the
 * scopes' owners and a column that owner has; the short form @scale.<column> is the nearest
 * scope's column of that name (so a subclass's own column wins over its parent's). Returns the
 * scope index and column, undefined for a column nobody here has (the caller's "unknown
 * variable"), or throws an ExprError that says whose columns these are.
 */
export function resolveScale(name: string, scopes: readonly ScaleScope[]): { scope: number; column: string } | undefined {
  const parts = name.slice(6).split('.');
  if (parts.length > 2) return undefined;
  const col = parts[parts.length - 1]!;
  const has = (i: number): boolean => Object.hasOwn(scopes[i]!.columns, col);
  if (parts.length === 1) {
    for (let i = 0; i < scopes.length; i++) if (has(i)) return { scope: i, column: col };
    return undefined;
  }
  const owner = parts[0]!;
  const at = scopes.findIndex((s) => s.names.includes(owner));
  if (at < 0) {
    const first = scopes[0]?.names[0] ?? 'nobody';
    const others = scopes.slice(1).map((s) => s.names[0]!);
    const whose = others.length === 0 ? first : `${first} or ${others.join(' or ')}`;
    throw new ExprError(`@${name}: a scale column here belongs to ${whose} (write @scale.${first}.${col} or @scale.${col})`);
  }
  if (has(at)) return { scope: at, column: col };
  const holder = scopes.findIndex((_, i) => has(i));
  if (holder >= 0) {
    const h = scopes[holder]!.names[0]!;
    throw new ExprError(`@${name}: ${col} belongs to ${h}, not ${owner} (write @scale.${h}.${col} or @scale.${col})`);
  }
  return undefined;
}

/**
 * Stand-ins for a class's own expressions: every PC variable, but only @scale columns in the
 * scopes it reaches (resolveScale), each bound by its type.
 */
function classEnv(scopes: readonly ScaleScope[]): Env {
  return (name) => {
    if (!name.startsWith('scale.')) return standInEnv(name);
    const r = resolveScale(name, scopes);
    if (r === undefined) return undefined;
    const t = scopes[r.scope]!.columns[r.column]!.type;
    if (t === 'number') return 1;
    if (t === 'dice') return DICE_STAND_IN;
    throw new ExprError(`@${name} is a slots column: spell slots can't be used in an expression`);
  };
}

function constantAt(c: ItemCtx, p: YamlPath, src: string, env: Env, hint: string): void {
  const r = compileRoll(c, p, src, withMod(null, env), hint);
  if (r && !isConstant(r.roll)) errorAt(c, p, `${src} can't roll dice here`);
}

/** Plain dice with no variables: a scale column's dice, a weapon's damage. */
function diceAt(c: ItemCtx, p: YamlPath, src: string): void {
  compileRoll(c, p, src, {}, 'these are plain dice like 1d8, with no variables');
}

const CLASS_VARS = '@pb, @mod.<ability>, @level, @classLevel and this class\'s (or subclass\'s) @scale.<column> or @scale.<owner>.<column>';

interface ClassLike {
  readonly scale: ClassSource['scale'];
  readonly pools: ClassSource['pools'];
  readonly acFormulas: ClassSource['acFormulas'];
  readonly features: ClassSource['features'];
  readonly choices: ClassSource['choices'];
  readonly spellcasting?: ClassSource['spellcasting'] | undefined;
}

function checkRecharge(c: ItemCtx, p: YamlPath, r: string | readonly RechargeRuleSrc[], env: Env): void {
  if (typeof r === 'string') return;
  r.forEach((rule, j) => {
    if (typeof rule.amount === 'string' && rule.amount !== 'all') constantAt(c, [...p, j, 'amount'], rule.amount, env, CLASS_VARS);
  });
}

function checkClassLike(c: ItemCtx, src: ClassLike, scopes: readonly ScaleScope[], lib: DataLib): void {
  const env = classEnv(scopes);
  for (const col of Object.keys(src.scale).sort(byString)) {
    const s = src.scale[col]!;
    // The expression grammar's @scale segments start with a letter (dice/expr.ts), so a column id
    // starting with a digit could never be referenced. No SRD column does (checked at step 3).
    if (/^[0-9]/.test(col)) errorAt(c, ['scale', col], `scale column id "${col}" starts with a digit, so no @scale expression can name it; start it with a letter`);
    if (s.type === 'dice') for (const lvl of Object.keys(s.at).sort(byLevelKey)) diceAt(c, ['scale', col, 'at', lvl], s.at[lvl]!);
  }
  src.pools.forEach((pl, i) => {
    if (src.pools.findIndex((x) => x.id === pl.id) !== i) errorAt(c, ['pools', i, 'id'], `pool id "${pl.id}" is used twice`);
    if (typeof pl.max === 'string') constantAt(c, ['pools', i, 'max'], pl.max, env, CLASS_VARS);
    checkRecharge(c, ['pools', i, 'recharge'], pl.recharge, env);
  });
  src.acFormulas.forEach((f, i) => constantAt(c, ['acFormulas', i, 'ac'], f.ac, env, CLASS_VARS));
  const sc = src.spellcasting;
  if (sc) {
    for (const key of ['cantrips', 'prepared'] as const) {
      const v = sc[key];
      if (typeof v === 'string') constantAt(c, ['spellcasting', key], v, env, CLASS_VARS);
    }
  }
  levelRefs(c, ['features'], src.features, 'feature', lib);
  checkChoices(c, src.choices, lib);
}

function checkChoices(c: ItemCtx, choices: ClassSource['choices'], lib: DataLib): void {
  choices.forEach((ch, i) => {
    const p: YamlPath = ['choices', i];
    if (choices.findIndex((x) => x.id === ch.id) !== i) errorAt(c, [...p, 'id'], `choice id "${ch.id}" is used twice`);
    if (ch.from.features) listRefs(c, [...p, 'from', 'features'], ch.from.features, 'feature', lib);
    if (ch.from.feats) listRefs(c, [...p, 'from', 'feats'], ch.from.feats, 'feat', lib);
    for (const key of ['skills', 'abilities', 'tools'] as const) {
      const list = ch.from[key];
      if (list) noDupes(c, [...p, 'from', key], list);
    }
    const n = Object.values(ch.from).reduce((m, v) => m + (v?.length ?? 0), 0);
    if (ch.choose > n) errorAt(c, [...p, 'choose'], `choose ${ch.choose} from ${n} option(s)`);
  });
}

/** Cross-checks one data item; the schema already checked its shape. */
export function checkDataItem(item: DataItem, c: ItemCtx, lib: DataLib): void {
  switch (item.kind) {
    case 'class': {
      const s = item.src;
      if (s.saves[0] === s.saves[1]) errorAt(c, ['saves', 1], `${s.saves[1]} is listed twice`);
      if (s.skills.choose > s.skills.from.length) errorAt(c, ['skills', 'choose'], `choose ${s.skills.choose} from ${s.skills.from.length} skill(s)`);
      noDupes(c, ['skills', 'from'], s.skills.from);
      checkProficiencies(c, s.proficiencies, lib);
      checkClassLike(c, s, [{ names: [localOf(s.id)], columns: s.scale }], lib);
      return;
    }
    case 'subclass': {
      const s = item.src;
      ref(c, ['parent'], s.parent, 'class', lib);
      const parent = lib.classes.get(s.parent);
      // Its own columns are owned by the subclass (its local id, and the scaleOwner Foundry keys
      // them by); the parent's by the parent. The short form finds its own first.
      checkClassLike(c, s, subclassScopes(s, parent), lib);
      if (parent) {
        for (const lvl of Object.keys(s.features).sort(byLevelKey)) {
          if (Number(lvl) < parent.subclassLevel) errorAt(c, ['features', lvl], `${parent.name} gains its subclass at level ${parent.subclassLevel}, after ${lvl}`);
        }
      }
      levelRefs(c, ['alwaysPrepared'], s.alwaysPrepared, 'spell', lib);
      return;
    }
    case 'species': {
      listRefs(c, ['features'], item.src.features.map(speciesFeatureId), 'feature', lib);
      checkChoices(c, item.src.choices, lib);
      // Session S: a species' own pools, checked as a class's (no @scale: a species has no columns).
      const pools = item.src.pools ?? [];
      const env = classEnv([]);
      pools.forEach((pl, i) => {
        if (pools.findIndex((x) => x.id === pl.id) !== i) errorAt(c, ['pools', i, 'id'], `pool id "${pl.id}" is used twice`);
        if (typeof pl.max === 'string') constantAt(c, ['pools', i, 'max'], pl.max, env, '@pb, @mod.<ability> and @level');
        checkRecharge(c, ['pools', i, 'recharge'], pl.recharge, env);
      });
      return;
    }
    case 'background': {
      const s = item.src;
      ref(c, ['feat'], s.feat, 'feat', lib);
      const feat = lib.feats.get(s.feat);
      if (feat && feat.category !== 'origin') errorAt(c, ['feat'], `${s.feat} is a ${feat.category} feat; a background grants an origin feat`);
      noDupes(c, ['abilities'], s.abilities);
      noDupes(c, ['skills'], s.skills);
      noDupes(c, ['tools'], s.tools);
      checkChoices(c, s.choices, lib);
      return;
    }
    case 'feat':
      listRefs(c, ['features'], item.src.features, 'feature', lib);
      checkChoices(c, item.src.choices, lib);
      return;
    case 'weapon':
      diceAt(c, ['damage', 'roll'], item.src.damage.roll);
      if (item.src.versatile !== undefined) diceAt(c, ['versatile'], item.src.versatile);
      return;
    case 'armor':
      return;
  }
}
