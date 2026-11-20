// kind: character -> kind: pc (M3 step 3, docs/design/m3.md 2.6 and critique resolutions C9a,
// C10, C15, C16, C24). A character file names a class, a level, a species, a background, final
// ability scores and the picks the data's choices ask for; expandCharacter derives everything a
// kind: pc states by hand (PB, HP, AC, saves, skills, extra attacks, weapons, slots, pools,
// casting, features) and records where each number came from in a DerivedSheet. The PcSource it
// returns goes through compilePc unchanged, so a character compiles exactly like a pc and adds
// no compiled field (C3). Pure: no clock, no randomness, every list sorted with < and >.
//
// Pick keys are <owner id>#<choice id>: the class, subclass, species, background or feat that
// declares the choice, then the choice's id in that item (srd:fighter#fighting-style,
// srd:human#versatile, srd:skilled#skills). Two synthetic choices exist besides the declared
// ones: <class id>#asi-<level> for each ASI level (an { asi } record or a { feat }), and
// <background id>#abilities (the background's score increases, recorded).
//
// Scope (C24): one class, levels 1-20 load; features gained above level 10 are narrative (on the
// sheet, never compiled). Table numbers (PB, HP, slots, extra attacks, scale columns) are derived
// at any level.

import { ExprError, evalConstant, isConstant, parseExpr, type ExprBinding, type ExprNode } from '../dice/expr.ts';
import { abilityMod, foldExpr, proficiencyBonus, unarmedStrike, withMod, type ScaleBindings } from './compile.ts';
import { localOf } from './compile-spell.ts';
import { resolveScale, speciesFeatureId, speciesFeatureLevel, subclassScopes, type ScaleScope } from './data-kinds.ts';
import { SKILLS } from './rollkeys.ts';
import type {
  ArmorSource,
  BackgroundSource,
  CharacterSource,
  ClassSource,
  FeatSource,
  FeatureSource,
  GateSrc,
  PcSource,
  PickValueSrc,
  SpeciesSource,
  SubclassSource,
  WeaponSource,
} from './schema.ts';
import { ABILITIES, type Ability } from './types.ts';
import { lightFeature, lightWeaponCount, masteryActive, masteryFeature, weaponAbility } from './weapons.ts';
import type { YamlPath } from './yaml.ts';

/** A gate as the sheet words it. */
const gateWord = (w: GateSrc): string =>
  typeof w === 'string' ? w : 'targetHas' in w ? `target has ${w.targetHas}` : 'selfHas' in w ? `its ${w.selfHas} is up` : `either ${w.anyOf.map((l) => l.map(gateWord).join(' and ')).join(', or ')}`; // anyOf: W1 (P5)

/**
 * Features that change the Unarmed Strike and Monk weapons the way Martial Arts does (SRD 5.2.1
 * p.50, srd-raw.txt:11071-11100), with the class column holding the die. A table here, not a
 * feature field: the feature schema has no field for it yet (expandCharacter applies it to
 * PcSource.unarmedStrike and the weapons; see the Martial Arts block below).
 */
const MARTIAL_ARTS: readonly { readonly feature: string; readonly die: string }[] = [{ feature: 'srd:monk/martial-arts', die: '@scale.monk.die' }];

/**
 * M3 step 5b: the Weapon Mastery class feature (SRD 5.2.1), read by hand from each class's text: how
 * many kinds of weapons, and which kinds qualify. A table here, like MARTIAL_ARTS: the feature
 * schema has no field for "choose N weapon kinds" (its activation-less feature stays narrative in
 * the data). A character answers it with the synthetic pick <class id>#weapon-mastery (a list of
 * weapon ids); the expansion emits them as PcSource.masteries, and the engine's mastery riders
 * (content/weapons.ts) do the rest. The importer checks Foundry's mastery Trait advancements
 * against this table, fail closed (tools/import-srd/map/class.ts). "Whenever you finish a Long
 * Rest ... change": rest recovery is metadata only (CLAUDE.md rule 4), so a fight has one set.
 *   - count: a number, or the class column that holds it (the "Weapon Mastery" column).
 *   - kinds: melee = "Simple or Martial Melee weapons"; any = "Simple or Martial weapons";
 *     proficient = "weapons ... with which you have proficiency".
 */
export const WEAPON_MASTERY: readonly { readonly feature: string; readonly count: number | string; readonly kinds: 'melee' | 'any' | 'proficient'; readonly pdf: string }[] = [
  // "the mastery properties of two kinds of Simple or Martial Melee weapons of your choice ... more
  // kinds of weapons, as shown in the Weapon Mastery column of the Barbarian Features table."
  { feature: 'srd:barbarian/weapon-mastery', count: '@scale.barbarian.mastery', kinds: 'melee', pdf: 'p.29, srd-raw.txt:5001-5010' },
  // "three kinds of Simple or Martial weapons of your choice ... as shown in the Weapon Mastery
  // column of the Fighter Features table."
  { feature: 'srd:fighter/weapon-mastery', count: '@scale.fighter.mastery', kinds: 'any', pdf: 'p.48, srd-raw.txt:10614-10623' },
  // "two kinds of weapons of your choice with which you have proficiency" (Paladin, Ranger, Rogue).
  { feature: 'srd:paladin/weapon-mastery', count: 2, kinds: 'proficient', pdf: 'p.54, srd-raw.txt:11893-11902' },
  { feature: 'srd:ranger/weapon-mastery', count: 2, kinds: 'proficient', pdf: 'p.58, srd-raw.txt:12978-12987' },
  { feature: 'srd:rogue/weapon-mastery', count: 2, kinds: 'proficient', pdf: 'p.62, srd-raw.txt:13755-13765' },
];
const MASTERY_KINDS_TEXT: Readonly<Record<string, string>> = { melee: 'Simple or Martial Melee weapons', any: 'Simple or Martial weapons', proficient: 'weapons it is proficient with' };

/** The highest level M3 models (C24); features gained above it are narrative. */
export const MODELED_MAX_LEVEL = 10;

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byLevelKey = (a: string, b: string): number => Number(a) - Number(b);
const signed = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);
const ABILITY_NAME: Readonly<Record<Ability, string>> = { str: 'STR', dex: 'DEX', con: 'CON', int: 'INT', wis: 'WIS', cha: 'CHA' };

/** What expandCharacter can see of the load: every id's kind and the character-building data by id. */
export interface CharacterLib {
  readonly kinds: ReadonlyMap<string, string>;
  readonly classes: ReadonlyMap<string, ClassSource>;
  readonly subclasses: ReadonlyMap<string, SubclassSource>;
  readonly species: ReadonlyMap<string, SpeciesSource>;
  readonly backgrounds: ReadonlyMap<string, BackgroundSource>;
  readonly feats: ReadonlyMap<string, FeatSource>;
  readonly weapons: ReadonlyMap<string, WeaponSource>;
  readonly armor: ReadonlyMap<string, ArmorSource>;
  readonly features: ReadonlyMap<string, FeatureSource>;
}

/** A diagnostic at a path in the character file. Errors stop the load; warnings are the character lint. */
export interface CharIssue {
  readonly severity: 'error' | 'warning';
  readonly path: YamlPath;
  readonly message: string;
}

/** One derived number: its value and how it was reached (sources and page cites inline). */
export interface SheetNumber {
  readonly value: number;
  readonly why: string;
  /** Set when the file's overrides replaced the derived value. */
  readonly override?: { readonly derived: number; readonly derivedWhy: string; readonly why: string };
}

export interface SheetFeature {
  readonly id: string;
  readonly name: string;
  /** What grants it: 'Monk 5', 'Human', 'srd:human#versatile', 'file'. */
  readonly from: string;
  /** Class level for a class or subclass feature, character level otherwise. */
  readonly level: number;
  readonly fidelity: 'full' | 'partial' | 'narrative' | 'missing';
  /** False when it's on the sheet only (above level 10, C24). */
  readonly compiled: boolean;
  readonly unimplemented: readonly string[];
}

export interface SheetOption {
  readonly name: string;
  /** activation, initiative, reaction or rider. */
  readonly kind: 'activation' | 'initiative' | 'reaction' | 'rider';
  /** When and at what cost, e.g. "bonus action, 1 Monk's Focus, while unarmored and noShield". */
  readonly when: string;
  /** The granting feature's name and where it comes from ("Monk's Focus (Monk 2)"). */
  readonly from: string;
}

export interface SheetAttack {
  readonly id: string;
  readonly name: string;
  readonly toHit: SheetNumber;
  readonly damage: string;
  readonly reach: string;
  readonly notes: readonly string[];
}

/**
 * Every number a character file derives, with its sources, per-feature fidelity and the lines
 * the engine leaves out. Plain data (renderSheet prints it; JSON.stringify gives the JSON form).
 * It enters no hash.
 */
export interface DerivedSheet {
  readonly id: string;
  readonly name: string;
  readonly source: string;
  readonly placeholder: boolean;
  readonly classes: readonly { readonly id: string; readonly name: string; readonly level: number; readonly subclass: { readonly id: string; readonly name: string } | null }[];
  readonly level: number;
  readonly species: { readonly id: string; readonly name: string };
  readonly size: string;
  readonly background: { readonly id: string; readonly name: string };
  readonly abilities: readonly { readonly ability: Ability; readonly score: number; readonly mod: number }[];
  readonly pb: SheetNumber;
  readonly hpMax: SheetNumber;
  readonly ac: SheetNumber;
  readonly speed: SheetNumber;
  readonly initiative: SheetNumber;
  readonly extraAttacks: SheetNumber;
  readonly saves: readonly { readonly ability: Ability; readonly mod: number; readonly proficient: boolean; readonly why: string }[];
  readonly skills: readonly { readonly skill: string; readonly mod: number; readonly rank: 'none' | 'proficient' | 'expertise'; readonly why: string }[];
  readonly attacks: readonly SheetAttack[];
  readonly slots: { readonly levels: readonly number[]; readonly why: string };
  readonly pools: readonly { readonly id: string; readonly name: string; readonly max: number; readonly why: string; readonly spentBy: readonly string[] }[];
  /**
   * M3 step 5a: what the compiled features let the character do in a fight (activations, the
   * initiative hook, reactions, riders), in feature-id order, each with its cost and source.
   * Narrative features and those above level 10 are left out: deciders never see them.
   */
  readonly options: readonly SheetOption[];
  readonly casting: readonly {
    readonly source: string;
    readonly ability: Ability;
    readonly cantrips: readonly string[];
    readonly prepared: readonly string[];
    readonly always: readonly string[];
    readonly cantripsExpected: number | null;
    readonly preparedExpected: number | null;
  }[];
  readonly feats: readonly { readonly id: string; readonly name: string; readonly from: string; readonly fidelity: string }[];
  readonly features: readonly SheetFeature[];
  readonly picks: readonly { readonly key: string; readonly value: string }[];
  /** What the character carries that the engine doesn't model (the compiled template's list, once compiled). */
  readonly unimplemented: readonly string[];
  /** The compiled template's fidelity: partial whenever anything is unimplemented. */
  readonly fidelity: 'full' | 'partial';
}

export interface CharacterExpansion {
  /** Null when an error stops the expansion (a missing class, species or background). */
  readonly pc: PcSource | null;
  readonly sheet: DerivedSheet | null;
  /** The scale columns at this level for compilePc: @scale.<owner>.<column>, and the short form where it's unique. */
  readonly scale: ScaleBindings;
  /** Short column names more than one owner has (compilePc's scaleAmbiguous). */
  readonly scaleAmbiguous: Readonly<Record<string, readonly string[]>>;
  readonly issues: readonly CharIssue[];
  /** Maps a path in the derived PcSource to the character-file path it came from (for compile diagnostics). */
  readonly pathOf: (pcPath: YamlPath) => YamlPath;
}

type Choice = ClassSource['choices'][number];

interface OwnerScope {
  /** The owning item's id, and how it's printed. */
  readonly id: string;
  readonly label: string;
  /** True for a class or subclass: hp grants and feature levels count that class's levels. */
  readonly classScoped: boolean;
  /** @scale scopes its expressions reach (empty: none). */
  readonly scopes: readonly ScaleScope[];
}

interface Grant {
  readonly id: string;
  readonly owner: OwnerScope;
  readonly level: number;
  readonly from: string;
  readonly path: YamlPath;
}

interface PendingChoice {
  readonly key: string;
  readonly owner: OwnerScope;
  readonly choice: Choice | null;
  /** asi: an ASI level; abilities: the background's increases; mastery: Weapon Mastery's weapon kinds (5b). */
  readonly synthetic: 'asi' | 'abilities' | 'mastery' | null;
  readonly level: number;
}

/** The value a scale column holds at a level: its highest breakpoint at or below it. */
function columnAt<T>(at: Readonly<Record<string, T>>, level: number): { value: T; from: number } | undefined {
  let best: { value: T; from: number } | undefined;
  for (const k of Object.keys(at).sort(byLevelKey)) if (Number(k) <= level) best = { value: at[k]!, from: Number(k) };
  return best;
}

/** A level-keyed number map's value at a level (extra attacks). */
function levelValue(m: Readonly<Record<string, number>>, level: number): { value: number; from: number } | undefined {
  return columnAt(m, level);
}

/** The spell list's local name for focus matching: srd:list/druid -> druid. */
const listLocal = (id: string): string => id.slice(Math.max(id.lastIndexOf('/'), id.indexOf(':')) + 1);

/**
 * Hit points (SRD 5.2.1, critique resolution C10): "Level 1 Hit Points by Class" (p.22) is the
 * class's full Hit Die + CON modifier; each later level adds the "Fixed Hit Points by Class"
 * value (p.23: half the Hit Die + 1, i.e. 7/6/5/4 for d12/d10/d8/d6) + CON, or a Hit Die roll
 * + CON with "the total (minimum of 1)". hp: max (the full die every level) is a table variant
 * with no SRD rule. The pages are srd-index.json's (tools/import-srd), checked in the tests.
 * [U] The minimum of 1 is printed for the rolled total only; it's applied to the fixed value and
 * to the max variant too (it matters only with a CON modifier of -4 or lower), and flagged.
 * [U] Level 1 has no printed minimum; a total below 1 is floored at 1 (a kind: pc needs hpMax >= 1) and flagged.
 */
export function hitPoints(hitDie: number, level: number, con: number, mode: CharacterSource['hp']): { total: number; why: string; clamped: boolean; error: string | null } {
  const fixed = hitDie / 2 + 1;
  const l1 = hitDie + con;
  let clamped = l1 < 1;
  let total = Math.max(1, l1);
  const later = level - 1;
  // The why string adds up to the total: a level whose die + CON is raised to 1 is shown as its
  // own clamped total ("1 + -2 -> 1") and left out of the "n x CON" term (review R3).
  let conLevels = l1 < 1 ? 0 : 1;
  const l1Text = l1 < 1 ? `(${hitDie} + ${con} -> 1) (L1 max d${hitDie}, p.22, floored at 1, U)` : `${hitDie} (L1 max d${hitDie}, p.22)`;
  const conText = (): string => (conLevels > 0 ? ` + ${conLevels} x ${con} (CON)` : '');
  if (typeof mode === 'object') {
    if (mode.rolled.length !== later) {
      return { total, why: '', clamped, error: `hp.rolled lists ${mode.rolled.length} roll(s); a level ${level} character needs ${later} (levels 2 to ${level})` };
    }
    const bad = mode.rolled.findIndex((r) => r > hitDie);
    if (bad >= 0) return { total, why: '', clamped, error: `hp.rolled[${bad}] is ${mode.rolled[bad]}, above the d${hitDie} Hit Die` };
    const parts: string[] = [];
    for (const r of mode.rolled) {
      const v = r + con;
      if (v < 1) clamped = true;
      else conLevels++;
      total += Math.max(1, v);
      parts.push(v < 1 ? `${r} + ${con} -> 1` : String(r));
    }
    const rolls = later > 0 ? ` + rolls [${parts.join(', ')}] (p.23: d${hitDie} + CON per level, minimum 1)` : '';
    return { total, why: `${l1Text}${rolls}${conText()}${clamped ? ' [minimum 1 applied]' : ''}`, clamped, error: null };
  }
  const per = mode === 'max' ? hitDie : fixed;
  const perTotal = per + con;
  const laterClamped = later > 0 && perTotal < 1;
  if (laterClamped) clamped = true;
  else conLevels += later;
  total += later * Math.max(1, perTotal);
  const label = mode === 'max' ? `max d${hitDie}, table variant` : `fixed d${hitDie}, p.23`;
  const laterText = later === 0 ? '' : laterClamped ? ` + ${later} x (${per} + ${con} -> 1) (${label}, minimum 1, U)` : ` + ${later} x ${per} (${label})`;
  const why = `${l1Text}${laterText}${conText()}${clamped ? ' [minimum 1 per level applied, U]' : ''}`;
  return { total, why, clamped, error: null };
}

/** An item reference: present and of the right kind, or an issue. */
function lookup<T>(map: ReadonlyMap<string, T>, kinds: ReadonlyMap<string, string>, id: string, want: string, err: (m: string) => void): T | undefined {
  const v = map.get(id);
  if (v !== undefined) return v;
  const k = kinds.get(id);
  err(k === undefined ? `no ${want} ${id} is loaded` : `${id} is a ${k}, not a ${want}`);
  return undefined;
}

export function expandCharacter(src: CharacterSource, lib: CharacterLib): CharacterExpansion {
  const issues: CharIssue[] = [];
  const error = (path: YamlPath, message: string): void => void issues.push({ severity: 'error', path, message });
  const warn = (path: YamlPath, message: string): void => void issues.push({ severity: 'warning', path, message });
  const pathMap: { weapons: number[]; items: YamlPath[]; features: YamlPath[]; casting: YamlPath[] } = { weapons: [], items: [], features: [], casting: [] };
  const pathOf = (p: YamlPath): YamlPath => {
    const [head, i] = p;
    if (head === 'weapons' && typeof i === 'number') return ['equipment', 'weapons', pathMap.weapons[i] ?? 0];
    if (head === 'items' && typeof i === 'number') return pathMap.items[i] ?? ['equipment', 'items'];
    if (head === 'features' && typeof i === 'number') return pathMap.features[i] ?? ['classes', 0];
    if (head === 'casting' && typeof i === 'number') return pathMap.casting[i] ?? ['casting'];
    if (head === 'hands') return ['equipment', 'hands'];
    if (head === 'pools' || head === 'slots') return ['classes', 0];
    return [];
  };
  const fail = (): CharacterExpansion => ({ pc: null, sheet: null, scale: {}, scaleAmbiguous: {}, issues, pathOf });

  // ---- The build: class, subclass, species, background ----
  const entry = src.classes[0]!;
  const level = entry.level;
  const cls = lookup(lib.classes, lib.kinds, entry.class, 'class', (m) => error(['classes', 0, 'class'], m));
  const species = lookup(lib.species, lib.kinds, src.species, 'species', (m) => error(['species'], m));
  const background = lookup(lib.backgrounds, lib.kinds, src.background, 'background', (m) => error(['background'], m));
  let sub: SubclassSource | undefined;
  if (entry.subclass !== undefined) {
    sub = lookup(lib.subclasses, lib.kinds, entry.subclass, 'subclass', (m) => error(['classes', 0, 'subclass'], m));
    if (sub && cls && sub.parent !== cls.id) {
      error(['classes', 0, 'subclass'], `${sub.id} is a ${sub.parent} subclass, not a ${cls.id} one`);
      sub = undefined;
    } else if (sub && cls && level < cls.subclassLevel) {
      error(['classes', 0, 'subclass'], `${cls.name} gains its subclass at level ${cls.subclassLevel}; this character is level ${level}`);
      sub = undefined;
    }
  } else if (cls && level >= cls.subclassLevel) {
    warn(['classes', 0], `a level ${level} ${cls.name} has a subclass (from level ${cls.subclassLevel}): name it in classes[0].subclass`);
  }
  if (!cls || !species || !background) return fail();

  const mods = ABILITIES.map((a) => abilityMod(src.abilities[a]));
  const modOf = (a: Ability): number => mods[ABILITIES.indexOf(a)]!;

  // PB (the Character Advancement table: +2 at levels 1-4, +1 every 4 levels after).
  const pbDerived = proficiencyBonus(level);
  const pbNum = overridden('pb', pbDerived, `level ${level} (Character Advancement table: 2 + floor((level - 1) / 4))`);
  const pb = pbNum.value;

  function overridden(field: keyof CharacterSource['overrides'], derived: number, derivedWhy: string): SheetNumber {
    const o = src.overrides[field];
    if (o === undefined) return { value: derived, why: derivedWhy };
    return { value: o.value, why: `override: ${o.why}`, override: { derived, derivedWhy, why: o.why } };
  }

  // ---- @scale: the columns at this level (C16) ----
  const clsLocal = localOf(cls.id);
  const clsScopes: ScaleScope[] = [{ names: [clsLocal], columns: cls.scale }];
  const subScopes: ScaleScope[] = sub ? subclassScopes(sub, cls) : [];
  const allScopes: ScaleScope[] = sub ? subScopes : clsScopes;
  const scopeBinding = (s: ScaleScope, col: string): ExprBinding | undefined => {
    const column = s.columns[col]!;
    if (column.type === 'number') return columnAt(column.at, level)?.value ?? 0; // [U] no value below the first breakpoint: 0 (the column has no entry yet)
    if (column.type === 'dice') {
      const v = columnAt(column.at, level);
      return v === undefined ? undefined : parseExpr(v.value);
    }
    return undefined; // slots: never an expression
  };
  const scale: Record<string, ExprBinding> = {};
  const shortOwners = new Map<string, string[]>();
  for (const s of allScopes) {
    for (const col of Object.keys(s.columns).sort(byString)) {
      const b = scopeBinding(s, col);
      if (b === undefined) continue;
      for (const n of s.names) scale[`${n}.${col}`] = b;
      const owners = shortOwners.get(col) ?? [];
      owners.push(s.names[0]!);
      shortOwners.set(col, owners);
    }
  }
  const scaleAmbiguous: Record<string, string[]> = {};
  for (const col of [...shortOwners.keys()].sort(byString)) {
    const owners = shortOwners.get(col)!;
    if (owners.length === 1) scale[col] = scale[`${owners[0]}.${col}`]!;
    else scaleAmbiguous[col] = owners;
  }

  /** A constant expression in an item's own scope (pool max, AC formula, spell counts). */
  const evalIn = (scopes: readonly ScaleScope[], expr: string): { value: number } | { error: string } => {
    const env = (name: string): ExprBinding | undefined => {
      if (name === 'pb') return pb;
      if (name === 'level' || name === 'classlevel') return level;
      if (name.startsWith('mod.')) {
        const i = ABILITIES.indexOf(name.slice(4) as Ability);
        return i < 0 ? undefined : mods[i];
      }
      if (name.startsWith('scale.')) {
        const r = resolveScale(name, scopes);
        return r === undefined ? undefined : scopeBinding(scopes[r.scope]!, r.column);
      }
      return undefined;
    };
    try {
      const node: ExprNode = foldExpr(parseExpr(expr), withMod(null, env));
      if (!isConstant(node)) return { error: `${expr} rolls dice here` };
      return { value: evalConstant(node, {}) };
    } catch (e) {
      if (e instanceof ExprError || e instanceof RangeError) return { error: e.message };
      throw e;
    }
  };

  const clsOwner: OwnerScope = { id: cls.id, label: cls.name, classScoped: true, scopes: clsScopes };
  const subOwner: OwnerScope | null = sub ? { id: sub.id, label: sub.name, classScoped: true, scopes: subScopes } : null;
  const speciesOwner: OwnerScope = { id: species.id, label: species.name, classScoped: false, scopes: [] };
  const bgOwner: OwnerScope = { id: background.id, label: background.name, classScoped: false, scopes: [] };

  // ---- Features, feats and choices ----
  const grants: Grant[] = [];
  for (const lvl of Object.keys(cls.features).sort(byLevelKey)) {
    if (Number(lvl) > level) continue;
    cls.features[lvl]!.forEach((id) => grants.push({ id, owner: clsOwner, level: Number(lvl), from: `${cls.name} ${lvl}`, path: ['classes', 0, 'class'] }));
  }
  if (sub && subOwner) {
    for (const lvl of Object.keys(sub.features).sort(byLevelKey)) {
      if (Number(lvl) > level) continue;
      sub.features[lvl]!.forEach((id) => grants.push({ id, owner: subOwner, level: Number(lvl), from: `${sub.name} ${lvl}`, path: ['classes', 0, 'subclass'] }));
    }
  }
  for (const f of species.features) {
    const lvl = speciesFeatureLevel(f);
    if (lvl <= level) grants.push({ id: speciesFeatureId(f), owner: speciesOwner, level: lvl, from: lvl > 1 ? `${species.name} (level ${lvl})` : species.name, path: ['species'] });
  }

  const feats: { feat: FeatSource; from: string; owner: OwnerScope; path: YamlPath }[] = [];
  const pending: PendingChoice[] = [];
  /** Every choice key the build's items declare, at any level (for the unknown-pick message). */
  const declared = new Map<string, number>();
  const addChoices = (owner: OwnerScope, choices: readonly Choice[], levelOf: number) => {
    for (const ch of choices) {
      declared.set(`${owner.id}#${ch.id}`, ch.level);
      if (ch.level <= levelOf) pending.push({ key: `${owner.id}#${ch.id}`, owner, choice: ch, synthetic: null, level: ch.level });
    }
  };
  const addFeat = (id: string, from: string, path: YamlPath, gained: number) => {
    const feat = lookup(lib.feats, lib.kinds, id, 'feat', (m) => error(path, m));
    if (!feat) return;
    if (feats.some((f) => f.feat.id === id)) {
      error(path, feat.repeatable ? `${feat.name} is taken twice: a repeatable feat taken more than once isn't supported yet (its picks would share keys)` : `${feat.name} is taken twice and isn't repeatable`);
      return;
    }
    const owner: OwnerScope = { id: feat.id, label: feat.name, classScoped: false, scopes: [] };
    feats.push({ feat, from, owner, path });
    feat.features.forEach((fid) => grants.push({ id: fid, owner, level: gained, from: feat.name, path }));
    addChoices(owner, feat.choices, level);
  };

  // Class skills: the declared choice, or the class's skills block when the data declares none.
  const clsChoices: Choice[] = cls.choices.some((ch) => ch.id === 'skills') ? [...cls.choices] : [{ id: 'skills', level: 1, choose: cls.skills.choose, from: { skills: [...cls.skills.from] } }, ...cls.choices];
  addChoices(clsOwner, clsChoices, level);
  for (const lvl of cls.asiLevels) {
    declared.set(`${cls.id}#asi-${lvl}`, lvl);
    if (lvl <= level) pending.push({ key: `${cls.id}#asi-${lvl}`, owner: clsOwner, choice: null, synthetic: 'asi', level: lvl });
  }
  // M3 step 5b: Weapon Mastery's weapon kinds, a synthetic choice like the ASI levels (WEAPON_MASTERY).
  const masteryGrant = grants.find((g) => g.owner.id === cls.id && WEAPON_MASTERY.some((m) => m.feature === g.id));
  const masteryRule = masteryGrant ? WEAPON_MASTERY.find((m) => m.feature === masteryGrant.id)! : undefined;
  let masteryCount = 0;
  if (masteryGrant && masteryRule) {
    if (typeof masteryRule.count === 'number') masteryCount = masteryRule.count;
    else {
      const v = evalIn(clsOwner.scopes, masteryRule.count);
      if ('error' in v) error(['classes', 0, 'class'], `${masteryRule.feature}: ${masteryRule.count}: ${v.error}`);
      else masteryCount = v.value;
    }
    declared.set(`${cls.id}#weapon-mastery`, masteryGrant.level);
    if (masteryCount > 0) pending.push({ key: `${cls.id}#weapon-mastery`, owner: clsOwner, choice: null, synthetic: 'mastery', level: masteryGrant.level });
  }
  /** The weapon kinds (content ids) chosen through Weapon Mastery, in the file's order. */
  const masteryPicks: string[] = [];
  if (sub && subOwner) addChoices(subOwner, sub.choices, level);
  addChoices(speciesOwner, species.choices, level);
  addChoices(bgOwner, background.choices, level);
  pending.push({ key: `${background.id}#abilities`, owner: bgOwner, choice: null, synthetic: 'abilities', level: 1 });
  addFeat(background.feat, background.name, ['background'], 1);

  const proficient = new Map<string, string>(); // skill -> where from
  const expertise = new Map<string, string>();
  const pickLines: { key: string; value: string }[] = [];
  const answered = new Set<string>();
  const grantProficiency = (skill: string, from: string, path: YamlPath) => {
    const prev = proficient.get(skill);
    if (prev !== undefined) warn(path, `${skill} is already proficient from ${prev}; a second proficiency adds nothing`);
    else proficient.set(skill, from);
  };
  background.skills.forEach((s) => grantProficiency(s, background.name, ['background']));

  const expertiseChecks: { skill: string; path: YamlPath }[] = [];
  // Choices are answered in discovery order; a feat picked here adds its own choices to the end.
  for (let q = 0; q < pending.length; q++) {
    const pc = pending[q]!;
    const p: YamlPath = ['picks', pc.key];
    if (answered.has(pc.key)) {
      error(p, `two choices share the key ${pc.key}`);
      continue;
    }
    answered.add(pc.key);
    const value: PickValueSrc | undefined = Object.hasOwn(src.picks, pc.key) ? src.picks[pc.key] : undefined;
    if (pc.synthetic === 'asi') {
      if (value === undefined) {
        warn(['picks'], `${pc.key} isn't recorded: the level ${pc.level} Ability Score Improvement (record { asi: { <ability>: 1|2 } }, or { feat: <id> } for a feat taken instead)`);
        continue;
      }
      if (Array.isArray(value)) {
        error(p, `${pc.key} is an ASI level: give { asi: { <ability>: 1|2 } } or { feat: <feat id> }`);
        continue;
      }
      if ('asi' in value) {
        const total = Object.values(value.asi).reduce((n: number, v) => n + (v ?? 0), 0);
        if (total !== 2) error(p, `an Ability Score Improvement is +2 to one score or +1 to two (this adds ${total})`);
        pickLines.push({ key: pc.key, value: `ASI ${formatIncreases(value.asi)}` });
        continue;
      }
      const feat = lib.feats.get(value.feat);
      if (feat && feat.category !== 'general' && feat.category !== 'origin') {
        if (feat.category === 'epicBoon' && pc.level < 19) error(p, `${feat.name} is an Epic Boon feat (level 19)`);
        else warn(p, `${feat.name} is a ${feat.category} feat; an ASI level takes a General feat [U: whether other categories qualify]`);
      }
      pickLines.push({ key: pc.key, value: `feat ${value.feat}` });
      addFeat(value.feat, `${cls.name} ${pc.level} (ASI)`, p, pc.level);
      continue;
    }
    if (pc.synthetic === 'mastery') {
      const rule = masteryRule!;
      const kindsText = MASTERY_KINDS_TEXT[rule.kinds]!;
      if (value === undefined) {
        warn(['picks'], `pick needed: ${pc.key} (${lib.features.get(rule.feature)?.name ?? 'Weapon Mastery'}, ${cls.name} level ${pc.level}): choose ${masteryCount} kinds of weapons (weapon ids) among ${kindsText} (${rule.pdf})`);
        continue;
      }
      if (!Array.isArray(value)) {
        error(p, `${pc.key} is Weapon Mastery's choice: give the chosen weapon ids as a list`);
        continue;
      }
      value.forEach((v, i) => {
        const w = lib.weapons.get(v);
        if (!w) {
          const k = lib.kinds.get(v);
          error([...p, i], k === undefined ? `no weapon ${v} is loaded (Weapon Mastery chooses kinds of weapons by id)` : `${v} is a ${k}, not a weapon`);
          return;
        }
        const ok = rule.kinds === 'melee' ? w.attack === 'melee' : rule.kinds === 'proficient' ? cls.proficiencies.weapons.includes(w.category) || cls.proficiencies.weapons.includes(w.id) : true;
        if (!ok) error([...p, i], `${w.name} isn't among ${kindsText} (${rule.pdf})`);
        else if (masteryPicks.includes(v)) error([...p, i], `${v} is picked twice`);
        else masteryPicks.push(v);
      });
      if (value.length > masteryCount) error(p, `${pc.key} chooses ${masteryCount} at level ${level}, but ${value.length} are picked`);
      else if (value.length < masteryCount) warn(p, `${pc.key} chooses ${masteryCount} at level ${level}; only ${value.length} picked`);
      pickLines.push({ key: pc.key, value: masteryPicks.join(', ') });
      continue;
    }
    if (pc.synthetic === 'abilities') {
      if (value === undefined) continue; // the scores are final: recording the increases is optional
      if (Array.isArray(value) || !('asi' in value)) {
        error(p, `${pc.key} records the background's increases: { asi: { <ability>: 1|2 } }`);
        continue;
      }
      const used = (Object.keys(value.asi) as Ability[]).filter((a) => value.asi[a] !== undefined).sort(byString);
      const off = used.filter((a) => !background.abilities.includes(a));
      const total = used.reduce((n, a) => n + value.asi[a]!, 0);
      if (off.length > 0) error(p, `${background.name} raises only ${background.abilities.join(', ')} (not ${off.join(', ')})`);
      else if (total !== 3) error(p, `background increases are +2 and +1, or +1 to all three (this adds ${total})`);
      pickLines.push({ key: pc.key, value: `increases ${formatIncreases(value.asi)}` });
      continue;
    }
    const ch = pc.choice!;
    const options: string[] = [];
    for (const k of ['skills', 'features', 'feats', 'abilities', 'tools'] as const) for (const o of ch.from[k] ?? []) options.push(o);
    if (value === undefined) {
      warn(['picks'], `pick needed: ${pc.key} (${pc.owner.label} level ${pc.level}): choose ${ch.choose} from ${options.join(', ')}`);
      continue;
    }
    if (!Array.isArray(value)) {
      error(p, `${pc.key} is a choice: give the chosen option(s) as a list`);
      continue;
    }
    const chosen: string[] = [];
    value.forEach((v, i) => {
      if (!options.includes(v)) error([...p, i], `${v} isn't an option for ${pc.key} (choose from ${options.join(', ')})`);
      else if (chosen.includes(v)) error([...p, i], `${v} is picked twice`);
      else chosen.push(v);
    });
    if (value.length > ch.choose) error(p, `${pc.key} chooses ${ch.choose}, but ${value.length} are picked`);
    else if (value.length < ch.choose) warn(p, `${pc.key} chooses ${ch.choose}; only ${value.length} picked`);
    pickLines.push({ key: pc.key, value: chosen.join(', ') });
    const grantsExpertise = (ch.grants ?? (ch.id.startsWith('expertise') ? 'expertise' : 'proficiency')) === 'expertise';
    for (const v of chosen) {
      const i = value.indexOf(v);
      if ((ch.from.skills ?? []).includes(v)) {
        if (grantsExpertise) {
          if (expertise.has(v)) warn([...p, i], `${v} already has Expertise from ${expertise.get(v)!}`);
          else expertise.set(v, pc.key);
          expertiseChecks.push({ skill: v, path: [...p, i] });
        } else grantProficiency(v, pc.key, [...p, i]);
      } else if ((ch.from.features ?? []).includes(v)) {
        grants.push({ id: v, owner: pc.owner, level: pc.level, from: pc.key, path: [...p, i] });
      } else if ((ch.from.feats ?? []).includes(v)) {
        addFeat(v, pc.key, [...p, i], pc.level);
      } // abilities and tools: recorded only
    }
  }
  for (const key of Object.keys(src.picks).sort(byString)) {
    if (answered.has(key)) continue;
    const owner = key.slice(0, key.indexOf('#'));
    const at = declared.get(key);
    const owned = pending.filter((x) => x.owner.id === owner).map((x) => x.key);
    if (at !== undefined) error(['picks', key], `${key} is a level ${at} choice; this character is level ${level}`);
    else if (owned.length > 0) error(['picks', key], `no choice ${key} (${owner}'s choices at level ${level} are ${owned.join(', ')})`);
    else if ([...declared.keys()].some((k) => k.startsWith(`${owner}#`))) error(['picks', key], `no choice ${key}: ${owner} declares no choice with that id`);
    else error(['picks', key], `no choice ${key} in this build: ${owner} isn't part of it at level ${level}, or declares no choices`);
  }
  for (const e of expertiseChecks) if (!proficient.has(e.skill)) warn(e.path, `Expertise in ${e.skill} needs proficiency in it first`);
  src.features.forEach((id, i) => grants.push({ id, owner: { id: 'file', label: 'file', classScoped: false, scopes: [] }, level: 1, from: 'file', path: ['features', i] }));

  // ---- Features: compiled at levels 1-10, narrative above (C24); one entry per id ----
  const sheetFeatures: SheetFeature[] = [];
  const compiledFeatures: Grant[] = [];
  const unimplemented: string[] = [];
  const featureLines: string[] = [];
  const seenFeature = new Map<string, Grant>();
  for (const g of grants) {
    const prev = seenFeature.get(g.id);
    if (prev) {
      warn(g.path, `feature ${g.id} is granted twice (${prev.from} and ${g.from})`);
      continue;
    }
    seenFeature.set(g.id, g);
  }
  const ordered = [...seenFeature.values()].sort((a, b) => byString(a.id, b.id));
  for (const g of ordered) {
    const f = lib.features.get(g.id);
    const compiled = g.level <= MODELED_MAX_LEVEL;
    const lines = f ? [...f.unimplemented] : [];
    if (!f) {
      const k = lib.kinds.get(g.id);
      if (k !== undefined) error(g.path, `${g.id} is a ${k}, not a feature`);
    }
    // M3 step 5b: Weapon Mastery is applied by this expansion (WEAPON_MASTERY: the picks become
    // PcSource.masteries), so its sheet row says what the build does with it, not the data's
    // narrative: full once every kind is chosen, partial while picks are missing.
    const byBuild = f !== undefined && compiled && masteryRule !== undefined && g.id === masteryRule.feature && lines.length === 0;
    // The line is the expansion's (the data item has none), so it goes into the PC's own list, which the template keeps.
    const masteryGap = `${masteryPicks.length} of ${masteryCount} weapon kinds chosen (pick ${cls.id}#weapon-mastery)`;
    if (byBuild && masteryPicks.length < masteryCount) {
      lines.push(masteryGap);
      unimplemented.push(`${f!.name}: ${masteryGap}`);
    }
    const shownFidelity = byBuild ? (lines.length === 0 ? 'full' : 'partial') : f ? f.fidelity : 'missing';
    sheetFeatures.push({ id: g.id, name: f?.name ?? g.id, from: g.from, level: g.level, fidelity: shownFidelity, compiled, unimplemented: lines });
    if (compiled) {
      compiledFeatures.push(g);
      if (f) {
        for (const u of lines) if (!byBuild) featureLines.push(`${f.name}: ${u}`);
        // compilePc lists a feature's own lines; one that is narrative with none gets this one.
        if (f.fidelity === 'narrative' && lines.length === 0 && !byBuild) unimplemented.push(`${f.name}: narrative, not modeled`);
      }
    } else {
      unimplemented.push(`${f?.name ?? g.id} (${g.from}): gained above level ${MODELED_MAX_LEVEL}, narrative in M3 (C24)`);
    }
  }
  for (const it of [cls, ...(sub ? [sub] : []), species, background]) for (const u of it.unimplemented) unimplemented.push(`${it.name}: ${u}`);
  for (const f of feats) {
    for (const u of f.feat.unimplemented) unimplemented.push(`${f.feat.name}: ${u}`);
    if (f.feat.fidelity === 'narrative' && f.feat.unimplemented.length === 0) unimplemented.push(`${f.feat.name}: narrative, not modeled`);
  }

  // ---- Size and speed ----
  let size = species.size[0]!;
  if (src.size !== undefined) {
    if (!species.size.includes(src.size)) error(['size'], `a ${species.name} is ${species.size.join(' or ')}, not ${src.size}`);
    else size = src.size;
  } else if (species.size.length > 1) {
    error(['species'], `a ${species.name} can be ${species.size.join(' or ')}: choose one with size`);
  }

  // ---- Equipment: armor, shield, weapons, items, hands ----
  const eq = src.equipment;
  const armorTraining = cls.proficiencies.armor;
  let armor: ArmorSource | undefined;
  if (eq.armor !== null) {
    armor = lookup(lib.armor, lib.kinds, eq.armor, 'armor', (m) => error(['equipment', 'armor'], m));
    if (armor && armor.category === 'shield') {
      error(['equipment', 'armor'], `${armor.name} is a shield: put it in equipment.shield`);
      armor = undefined;
    }
  }
  let shield: ArmorSource | undefined;
  if (eq.shield === true) {
    const all = [...lib.armor.values()].filter((a) => a.category === 'shield').sort((a, b) => byString(a.id, b.id));
    if (all.length === 1) shield = all[0];
    else error(['equipment', 'shield'], all.length === 0 ? 'no shield armor is loaded' : `more than one shield is loaded (${all.map((a) => a.id).join(', ')}): name it`);
  } else if (typeof eq.shield === 'string') {
    shield = lookup(lib.armor, lib.kinds, eq.shield, 'armor', (m) => error(['equipment', 'shield'], m));
    if (shield && shield.category !== 'shield') {
      error(['equipment', 'shield'], `${shield.name} is ${shield.category} armor, not a shield`);
      shield = undefined;
    }
  }
  // SRD 5.2.1 Equipment, Armor Training: untrained armor gives Disadvantage on STR and DEX d20
  // tests and no spellcasting (not modeled: listed); a Shield's AC needs training.
  if (armor && !armorTraining.includes(armor.category)) {
    warn(['equipment', 'armor'], `${cls.name} has no ${armor.category} armor training: Disadvantage on STR and DEX tests and no spellcasting while wearing ${armor.name} (not modeled)`);
    unimplemented.push(`${armor.name} without armor training (Disadvantage on STR/DEX d20 tests, no spellcasting): not modeled`);
  }
  const shieldTrained = shield !== undefined && armorTraining.includes('shield');
  if (shield && !shieldTrained) warn(['equipment', 'shield'], `${cls.name} has no Shield training: the shield adds no AC (SRD 5.2.1 Equipment, Shield)`);

  // M3 step 5b: a listed magic Shield (Shield, +N: an ac stat gated on itemHeld, "While holding
  // this Shield", srd-raw.txt:41978-41983) is the equipped shield, the only one a character has.
  const heldAcFeatures = compiledFeatures.filter((g) => {
    const f = lib.features.get(g.id);
    return (f?.passive?.effects ?? []).some((eid) => (f!.effects.find((x) => x.id === eid)?.stats ?? []).some((st) => 'ac' in st && (st.when ?? []).includes('itemHeld')));
  });
  let shieldMagic: string | undefined;
  if (heldAcFeatures.length > 1) error(heldAcFeatures[1]!.path, `${heldAcFeatures.map((g) => g.id).join(' and ')} are both a held item's AC bonus; a character holds one shield`);
  else if (heldAcFeatures.length === 1) {
    if (shield) shieldMagic = heldAcFeatures[0]!.id;
    else warn(heldAcFeatures[0]!.path, `${lib.features.get(heldAcFeatures[0]!.id)!.name} is a magic Shield, but no shield is equipped (equipment.shield): it adds nothing`);
  }
  const items: PcSource['items'] = [];
  eq.items.forEach((it, i) => {
    if (it.kind === 'shield') {
      error(['equipment', 'items', i, 'kind'], 'put a shield in equipment.shield, not items');
      return;
    }
    if (it.id === 'shield' && shield) {
      error(['equipment', 'items', i, 'id'], 'item id "shield" is taken by the equipped shield');
      return;
    }
    pathMap.items.push(['equipment', 'items', i]);
    items.push(it);
  });
  if (shield) {
    pathMap.items.push(['equipment', 'shield']);
    // An untrained shield is still a shield: it fills a hand, is donned and doffed with the Utilize
    // action and is "wielding a Shield" for noShield gates (Unarmored Movement, p.51), but adds no
    // AC (SRD 5.2.1 Equipment, Shield: the AC bonus needs Shield training). Built here, not parsed,
    // so ItemSchema's "a shield needs shieldAc" check (hand-written pc files) doesn't apply.
    items.push({ id: 'shield', name: shield.name, kind: 'shield', focusFor: [], shieldAc: shieldTrained ? shield.ac : 0, ...(shieldMagic !== undefined ? { magic: shieldMagic } : {}) });
  }

  // M3 step 5b: weapons are hand items (PcSource.heldWeapons; SRD 5.2.1 Weapon Properties,
  // srd-raw.txt:20310-20404, and the Attack action's equip, 32707-32712): an attack needs its
  // weapon in hand, Two-Handed and a Versatile two-handed grip need the other hand empty,
  // Ammunition is counted and loading a one-handed weapon needs a free hand, Loading allows one
  // shot per action, Heavy gives Disadvantage below 13, a thrown weapon leaves the hand, and two
  // Light weapons give the Light property's extra attack. Mastery properties apply to the kinds
  // picked through Weapon Mastery (WEAPON_MASTERY; masteries below).
  const mastered = (id: string): boolean => masteryPicks.includes(id);
  const weapons: PcSource['weapons'] = [];
  const sheetAttacks: SheetAttack[] = [];
  const weaponLocals: string[] = [];
  const weaponSrc: WeaponSource[] = [];
  const twoHanded: string[] = [];
  /** One-handed Ammunition weapons: loading one needs the other hand free (20319-20320). */
  const loadHand: string[] = [];
  eq.weapons.forEach((wEntry, i) => {
    const wp: YamlPath = ['equipment', 'weapons', i];
    const id = typeof wEntry === 'string' ? wEntry : wEntry.id;
    const count = typeof wEntry === 'string' ? undefined : wEntry.count;
    const w = lookup(lib.weapons, lib.kinds, id, 'weapon', (m) => error(wp, m));
    if (!w) return;
    // A second weapon of the same kind (two daggers for the Light property) is its own item: dagger, dagger-2.
    const baseLocal = localOf(id).slice(localOf(id).lastIndexOf('/') + 1);
    let local = baseLocal;
    for (let k = 2; weaponLocals.includes(local); k++) local = `${baseLocal}-${k}`;
    const copy = local === baseLocal ? '' : ` (${local.slice(baseLocal.length + 1)})`;
    const has = (prop: string) => (w.properties as readonly string[]).includes(prop);
    const thrown = has('thrown');
    const ammo = has('ammunition');
    if (count !== undefined && !thrown && !ammo) {
      error([...wp, 'count'], `${w.name} isn't a thrown or Ammunition weapon: count is a stack you throw, or the ammunition you carry`);
      return;
    }
    const profFrom = cls.proficiencies.weapons.includes(w.category) ? `${w.category} weapons` : cls.proficiencies.weapons.includes(w.id) ? w.id : null;
    if (profFrom === null) warn(wp, `${cls.name} isn't proficient with ${w.name}: no PB on its attacks`);
    // To-hit ability (SRD 5.2.1 Equipment, Weapon Properties): a melee weapon uses STR, a ranged
    // one DEX, Finesse the better of the two; a thrown melee weapon keeps its melee ability.
    const ability: 'str' | 'dex' | 'finesse' = has('finesse') ? 'finesse' : w.attack === 'ranged' ? 'dex' : 'str';
    const am = ability === 'str' ? mods[0]! : ability === 'dex' ? mods[1]! : Math.max(mods[0]!, mods[1]!);
    const abilityText = ability === 'finesse' ? `${mods[1]! > mods[0]! ? 'DEX' : 'STR'} mod, finesse` : `${ability.toUpperCase()} mod`;
    // Versatile with a Shield: the two-handed grip needs the Shield doffed, the Utilize action
    // (Armor table, "Shield (Utilize Action to Don or Doff)"), which the engine doesn't model as an
    // action, so a Shield bearer's weapon has no two-handed mode (listed below).
    const versatileMode = has('versatile') && w.versatile !== undefined && !shield;
    const pw: PcSource['weapons'][number] = {
      id: local,
      name: `${w.name}${copy}`,
      kind: w.attack,
      ability,
      proficient: profFrom !== null,
      bonus: 0,
      ...(has('reach') ? { reach: 10 } : {}),
      ...(w.attack === 'ranged' ? { range: w.range } : {}),
      ...(w.attack === 'melee' && thrown ? { thrownRange: w.range } : {}),
      ...(count !== undefined && !ammo ? { count } : {}),
      damage: [{ roll: `${w.damage.roll} + @mod`, type: w.damage.type, ifAdvantage: false }],
      // M3 step 5a: the category and Light property, for the monkWeapon rider filter (Stunning
      // Strike, srd-raw.txt:11076-11085). Compile-time only; nothing enters the template.
      category: w.category,
      ...(has('light') ? { light: true as const } : {}),
      // M3 step 5b: the properties the engine reads under heldWeapons, the weapon's kind and its mastery.
      ...(has('two-handed') ? { twoHanded: true as const } : {}),
      ...(versatileMode ? { versatile: `${w.versatile!} + @mod` } : {}),
      ...(has('heavy') ? { heavy: true as const } : {}),
      ...(has('loading') ? { loading: true as const } : {}),
      ...(ammo && count !== undefined ? { ammunition: count } : {}),
      mastery: w.mastery,
      base: w.id,
    };
    pathMap.weapons.push(i);
    weaponLocals.push(local);
    weaponSrc.push(w);
    weapons.push(pw);
    if (has('two-handed')) twoHanded.push(local);
    else if (ammo) loadHand.push(local);
    const notes: string[] = [];
    const props = w.properties.map((x) => (x === 'versatile' ? `versatile (${w.versatile!})` : x));
    notes.push(`properties: ${props.length ? props.join(', ') : 'none'}`);
    if (masteryRule) notes.push(`mastery ${w.mastery}: ${mastered(w.id) ? 'mastered (Weapon Mastery)' : `not mastered (not among ${cls.id}#weapon-mastery)`}`);
    else notes.push(`mastery ${w.mastery}: not usable (no Weapon Mastery feature)`);
    if (versatileMode) notes.push(`two-handed: ${w.versatile!} damage (Versatile, with the other hand empty)`);
    else if (has('versatile')) {
      notes.push(`two-handed ${w.versatile!}: not with a Shield equipped (doffing it is the Utilize action, not modeled)`);
      unimplemented.push(`${pw.name}: Versatile two-handed damage with a Shield equipped (doffing the Shield, the Utilize action) not modeled`);
    }
    // SRD 5.2.1 Weapon Properties, Heavy: Disadvantage below STR 13 (melee) or DEX 13 (ranged); the engine applies it.
    const heavyScore = w.attack === 'ranged' ? src.abilities.dex : src.abilities.str;
    if (has('heavy') && heavyScore < 13) notes.push(`Heavy with ${w.attack === 'ranged' ? 'DEX' : 'STR'} ${heavyScore}: Disadvantage on its attack rolls`);
    if (ammo) {
      if (count !== undefined) notes.push(`ammunition: ${count} ${count === 1 ? 'piece' : 'pieces'}, one per attack`);
      else {
        notes.push('ammunition not counted (give { id, count })');
        warn(wp, `${w.name} uses ammunition: give { id: ${w.id}, count: <pieces> } to count it (uncounted, it never runs out${has('two-handed') ? '' : ' and loading needs no free hand'})`);
        unimplemented.push(`${pw.name}: ammunition not counted`);
      }
    }
    if (has('loading')) notes.push('Loading: one shot per action, Bonus Action or Reaction');
    const toHit = am + (profFrom !== null ? pb : 0);
    const reach = w.attack === 'ranged' ? `range ${w.range![0]}/${w.range![1]} ft` : `reach ${has('reach') ? 10 : 5} ft${thrown ? `, thrown ${w.range![0]}/${w.range![1]} ft${count !== undefined ? ` (${count})` : ''}` : ''}`;
    sheetAttacks.push({
      id: local,
      name: pw.name,
      toHit: { value: toHit, why: `${am} (${abilityText})${profFrom !== null ? ` + ${pb} (PB, proficient: ${profFrom})` : ' (not proficient)'}` },
      damage: `${w.damage.roll} ${am >= 0 ? '+' : '-'} ${Math.abs(am)} ${w.damage.type}`,
      reach,
      notes,
    });
  });
  const lightCount = lightWeaponCount(weapons); // a counted Thrown stack of 2+ counts twice (review R1)
  if (lightCount === 1) {
    const i = weapons.findIndex((pw) => pw.light === true);
    sheetAttacks[i] = { ...sheetAttacks[i]!, notes: [...sheetAttacks[i]!.notes, 'Light: no second Light weapon, so no extra attack'] };
  } else if (lightCount >= 2) {
    weapons.forEach((pw, i) => {
      if (pw.light !== true) return;
      const nick = pw.mastery === 'nick' && mastered(pw.base!);
      const stackOnly = weapons.filter((x) => x.light === true).length === 1; // its own second piece, thrown (review R1)
      sheetAttacks[i] = { ...sheetAttacks[i]!, notes: [...sheetAttacks[i]!.notes, `Light: an extra attack with a different Light weapon${stackOnly ? ' (another piece of this stack, thrown)' : ''} after an Attack action's Light strike (${nick ? 'Nick: as part of the Attack action, no Bonus Action' : 'a Bonus Action'}; no ability modifier to its damage unless negative)`] };
    });
  }
  const notCarried = masteryPicks.filter((id) => !weaponSrc.some((w) => w.id === id));
  const mLine = pickLines.find((x) => x.key === `${cls.id}#weapon-mastery`);
  if (mLine && notCarried.length) mLine.value += ` (not carried: ${notCarried.join(', ')})`;
  // Weapon +N (a magicWeapon stat): a character file has no field yet that names which weapon it is.
  for (const g of compiledFeatures) {
    const f = lib.features.get(g.id);
    if (!f?.passive) continue;
    const plus = f.passive.effects.some((eid) => (f.effects.find((x) => x.id === eid)?.stats ?? []).some((st) => 'magicWeapon' in st));
    if (plus) {
      warn(g.path, `${f.name} is a magic weapon's bonus, but a character file can't yet say which weapon it is: not applied`);
      unimplemented.push(`${f.name}: not bound to a weapon (a character file has no field for it yet)`);
    }
  }
  // Every PC also gets the injected core Unarmed Strike (compile.ts unarmedStrike, the same
  // numbers): SRD 5.2.1 p.190 Rules Glossary, Unarmed Strike: STR mod + PB to hit, 1 + STR mod
  // Bludgeoning. Class features that change it (Martial Arts) are not applied until step 5a.

  // Hands: what each hand holds when the fight starts (weapons are hand items from step 5b). With
  // no hands given, [U] the first listed weapon is in hand (both hands' worth if it's Two-Handed
  // or an Ammunition weapon), then the Shield, else a second Light weapon beside a Light first
  // one, else nothing: the order of equipment.weapons is the order the character readies them.
  const defaultHands = (): [string | null, string | null] => {
    const first = weaponLocals[0] ?? null;
    if (first === null) return [null, shield ? 'shield' : null];
    const firstNeedsBoth = twoHanded.includes(first) || loadHand.includes(first);
    if (shield) return [firstNeedsBoth ? (weaponLocals.find((l) => !twoHanded.includes(l) && !loadHand.includes(l)) ?? null) : first, 'shield'];
    if (firstNeedsBoth) return [first, null];
    const second = weapons[0]!.light === true ? weaponLocals.find((l, j) => j > 0 && weapons[j]!.light === true && !twoHanded.includes(l)) : undefined;
    return [first, second ?? null];
  };
  const handsIn: readonly [string | null, string | null] = eq.hands ?? defaultHands();
  const pcHands = handsIn.map((h, i): string | null => {
    if (h === null) return null;
    if (h === 'shield') {
      if (!shield) error(['equipment', 'hands', i], 'no shield is equipped (equipment.shield)');
      return shield ? 'shield' : null;
    }
    if (items.some((it) => it.id === h)) return h;
    if (weaponLocals.includes(h)) return h;
    error(['equipment', 'hands', i], `no weapon or item "${h}" is equipped (a hand holds a weapon's or item's local id, shield, or null)`);
    return null;
  }) as [string | null, string | null];
  if (shield && !handsIn.includes('shield')) warn(['equipment', 'hands'], `${shield.name} is equipped but in neither hand: it adds no AC`);
  handsIn.forEach((h, i) => {
    const other = handsIn[1 - i];
    if (h !== null && twoHanded.includes(h) && other !== null && other !== h) warn(['equipment', 'hands', i], `${h} is two-handed: the other hand holds ${other}, so it can't attack with it`);
    if (h !== null && loadHand.includes(h) && other !== null) warn(['equipment', 'hands', i], `${h} needs a free hand to load its ammunition: the other hand holds ${other}`);
  });
  if (handsIn[0] !== null && handsIn[0] === handsIn[1] && !twoHanded.includes(handsIn[0])) error(['equipment', 'hands', 1], `one ${handsIn[0]} can't be in both hands`);
  // A Two-Handed weapon named in both hands is one item: the engine holds it in one hand and needs the other empty.
  if (pcHands[0] !== null && pcHands[0] === pcHands[1]) pcHands[1] = null;
  // Wielding a shield (trained or not) blocks a noShield formula; only a trained one adds AC.
  const shieldInHand = shield !== undefined && pcHands.includes('shield');
  const shieldHeld = shieldInHand && shieldTrained;

  // ---- Martial Arts (M3 step 5a; SRD 5.2.1 p.50, srd-raw.txt:11071-11100) ----
  // "While you are unarmed or wielding only Monk weapons and you aren't wearing armor or wielding
  // a Shield" (11087): the Martial Arts die "in place of the normal damage of your Unarmed Strike
  // or Monk weapons" (11089-11093) and DEX "instead of your Strength modifier for the attack and
  // damage rolls" (11094-11097). Monk weapons: Simple Melee weapons, and Martial Melee weapons
  // with the Light property (11075-11085). Both are choices ("can"): the better ability is
  // taken (finesse), and the die with the larger average, the weapon's own on a tie. Read from
  // the build: weapons aren't hand items in a fight until step 5b, so the hands a fight starts
  // with are its hands throughout; [U] a Shield or armor donned mid-fight isn't seen (the bonus
  // strike's own unarmored/noShield gates still are). The Bonus Unarmed Strike is the feature's
  // activation (tools/import-srd/overrides/feature/monk/martial-arts.yaml).
  const isMonkWeapon = (w: WeaponSource): boolean => w.attack === 'melee' && (w.category === 'simple' || (w.category === 'martial' && (w.properties as readonly string[]).includes('light')));
  const maGrant = compiledFeatures.find((g) => MARTIAL_ARTS.some((m) => m.feature === g.id) && lib.features.get(g.id)?.fidelity !== 'narrative');
  let maDie: string | null = null;
  let maFrom = '';
  if (maGrant) {
    const ma = MARTIAL_ARTS.find((m) => m.feature === maGrant.id)!;
    const r = resolveScale(ma.die.slice(1), maGrant.owner.scopes);
    const col = r === undefined ? undefined : maGrant.owner.scopes[r.scope]!.columns[r.column];
    const v = col?.type === 'dice' ? columnAt(col.at, level) : undefined;
    if (!v) error(maGrant.path, `${maGrant.id}: ${ma.die} has no dice at level ${level}`);
    else {
      const name = lib.features.get(maGrant.id)!.name;
      const held = handsIn.filter((h): h is string => h !== null && weaponLocals.includes(h));
      const nonMonk = held.filter((h) => !isMonkWeapon(weaponSrc[weaponLocals.indexOf(h)]!));
      const off: string[] = [];
      if (armor) off.push(`wearing ${armor.name}`);
      if (shieldInHand) off.push('wielding a Shield');
      if (nonMonk.length) off.push(`wielding ${nonMonk.map((h) => weaponSrc[weaponLocals.indexOf(h)]!.name).join(' and ')} (not a Monk weapon)`);
      if (off.length) {
        warn(['equipment'], `${name} gives no benefits while ${off.join(', ')} (SRD 5.2.1 p.50)`);
        if (nonMonk.length && !armor && !shieldInHand) unimplemented.push(`${name}: its Bonus Unarmed Strike is still offered while a non-Monk weapon is held (not modeled)`);
      } else {
        maDie = v.value;
        maFrom = `${name}, ${ma.die} at level ${level}`;
      }
    }
  }
  /** The mean of NdM (null for anything else: such a weapon keeps its own die). */
  const diceMean = (e: string): number | null => {
    const m = /^(\d*)d(\d+)$/.exec(e.replace(/\s+/g, ''));
    return m ? (Number(m[1] || '1') * (Number(m[2]) + 1)) / 2 : null;
  };
  if (maDie !== null) {
    weapons.forEach((pw, i) => {
      const w = weaponSrc[i]!;
      if (!isMonkWeapon(w)) return;
      const a = sheetAttacks[i]!;
      const notes = [...a.notes];
      let ability = pw.ability;
      let toHit = a.toHit;
      if (ability !== 'finesse') {
        ability = 'finesse';
        const amNew = Math.max(mods[0]!, mods[1]!);
        toHit = { value: amNew + (pw.proficient ? pb : 0), why: `${amNew} (${mods[1]! > mods[0]! ? 'DEX' : 'STR'} mod, ${maFrom})${pw.proficient ? a.toHit.why.slice(a.toHit.why.indexOf(' + ')) : ' (not proficient)'}` };
        notes.push(`DEX for attack and damage (${maFrom})`);
      }
      const am = Math.max(mods[0]!, mods[1]!);
      const own = diceMean(w.damage.roll);
      const mine = diceMean(maDie!);
      const useDie = own !== null && mine !== null && mine > own;
      if (useDie) notes.push(`${maDie} Martial Arts die in place of ${w.damage.roll} (${maFrom})`);
      const roll = useDie ? maDie! : w.damage.roll;
      // A Versatile Monk weapon's two-handed die gets the same choice (5b): the larger average.
      const vOwn = pw.versatile !== undefined && w.versatile !== undefined ? diceMean(w.versatile) : null;
      const vUse = vOwn !== null && mine !== null && mine > vOwn;
      if (vUse) notes.push(`two-handed: ${maDie} Martial Arts die in place of ${w.versatile!} (${maFrom})`);
      const versatile = pw.versatile === undefined ? {} : { versatile: `${vUse ? maDie! : w.versatile!} + @mod` };
      weapons[i] = { ...pw, ability, damage: [{ roll: `${roll} + @mod`, type: w.damage.type, ifAdvantage: false }], ...versatile };
      sheetAttacks[i] = { ...a, toHit, damage: `${roll} ${am >= 0 ? '+' : '-'} ${Math.abs(am)} ${w.damage.type}`, notes };
    });
  }
  // Every PC also gets the injected core Unarmed Strike (compile.ts unarmedStrike): SRD 5.2.1
  // p.190 Rules Glossary, Unarmed Strike: STR mod + PB to hit, 1 + STR mod Bludgeoning; with
  // Martial Arts, the die + the better of STR and DEX (PcSource.unarmedStrike).
  const unarmedNotes: string[] = [];
  for (const g of compiledFeatures) {
    const f = lib.features.get(g.id);
    if (!f?.passive) continue;
    for (const eid of f.passive.effects) {
      for (const st of f.effects.find((x) => x.id === eid)?.stats ?? []) {
        if ('damageType' in st) unarmedNotes.push(`can deal ${st.damageType} damage instead (${f.name}; the type the target defends against least, its own on a tie)`);
      }
    }
  }
  if (maDie !== null) {
    const am = Math.max(mods[0]!, mods[1]!);
    sheetAttacks.push({
      id: 'unarmed-strike',
      name: 'Unarmed Strike',
      toHit: { value: am + pb, why: `${am} (${mods[1]! > mods[0]! ? 'DEX' : 'STR'} mod, ${maFrom}) + ${pb} (PB; every creature, SRD 5.2.1 p.190)` },
      damage: `${maDie} ${am >= 0 ? '+' : '-'} ${Math.abs(am)} bludgeoning (${maFrom})`,
      reach: 'reach 5 ft',
      notes: unarmedNotes,
    });
  } else {
    const u = unarmedStrike(mods[0]!, pb);
    sheetAttacks.push({
      id: u.local,
      name: u.name,
      toHit: { value: u.toHit, why: `${mods[0]!} (STR mod) + ${pb} (PB; every creature, SRD 5.2.1 p.190)` },
      damage: `${u.damage[0]!.avg} bludgeoning (1 + STR mod, minimum 0)`,
      reach: 'reach 5 ft',
      notes: unarmedNotes,
    });
  }

  // ---- Passive stats (M3 step 4): what a compiled feature's passive effects add to sheet numbers ----
  // The fight applies the same stats from the feature itself (applyPassives), so the PcSource
  // keeps the numbers without them (pcAc and the speed below), the way it leaves a held shield
  // out of its AC: the sheet shows the total, the fight adds the stat once. A gate is read from
  // the build: unarmored = no armor worn, armored = light, medium or heavy armor worn, noShield =
  // no shield in hand, notIncapacitated holds (a sheet is the creature at rest). A stat behind a
  // situational gate (ownTurn, hasntMoved, targetHas) or a speed half/zero isn't a sheet number:
  // it's listed as not counted.
  interface SheetStat {
    readonly n: number;
    readonly text: string;
  }
  const acAdds: SheetStat[] = [];
  const acFloors: SheetStat[] = [];
  const speedAdds: SheetStat[] = [];
  const notCounted: { readonly on: 'ac' | 'speed'; readonly text: string }[] = [];
  for (const g of compiledFeatures) {
    const f = lib.features.get(g.id);
    if (!f?.passive) continue;
    for (const eid of f.passive.effects) {
      const e = f.effects.find((x) => x.id === eid);
      for (const st of e?.stats ?? []) {
        let on: 'ac' | 'acFloor' | 'speed';
        let raw: number | string;
        if ('ac' in st) [on, raw] = ['ac', st.ac];
        else if ('acFloor' in st) [on, raw] = ['acFloor', st.acFloor];
        else if ('speed' in st) [on, raw] = ['speed', st.speed];
        else continue; // resist, critMin, damageType...: no sheet number here
        const when = st.when ?? [];
        const whenText = when.length ? `, while ${when.map(gateWord).join(' and ')}` : '';
        const sheetOn = on === 'speed' ? 'speed' : 'ac';
        if (raw === 'half' || raw === 'zero') {
          notCounted.push({ on: sheetOn, text: `${f.name} speed ${raw} (situational)` });
          continue;
        }
        const situational = when.filter((w) => typeof w !== 'string' || w === 'ownTurn' || w === 'hasntMoved');
        let n: number;
        if (typeof raw === 'number') n = raw;
        else {
          const v = evalIn(g.owner.scopes, raw);
          if ('error' in v) {
            error(g.path, `${g.id} ${on} stat: ${v.error}`);
            continue;
          }
          n = v.value;
        }
        const exprText = typeof raw === 'string' ? `: ${raw} at level ${level}` : '';
        const label = on === 'acFloor' ? `${f.name}: AC at least ${n}${whenText}` : `${f.name}: ${signed(n)}${on === 'speed' ? ' ft' : ''}${whenText}`;
        if (situational.length) {
          notCounted.push({ on: sheetOn, text: `${label} (situational)` });
          continue;
        }
        const fails = when.filter(
          (w) =>
            (w === 'unarmored' && armor !== undefined) ||
            (w === 'armored' && armor === undefined) ||
            (w === 'noShield' && shieldInHand) ||
            (w === 'shieldHeld' && !shieldInHand) ||
            (w === 'itemHeld' && !items.some((it) => it.magic === g.id && pcHands.includes(it.id))) ||
            w === 'lightExtra',
        );
        if (fails.length) {
          notCounted.push({ on: sheetOn, text: `${label} (not ${fails.join(', not ')} in this build)` });
          continue;
        }
        if (on === 'acFloor') acFloors.push({ n, text: `AC at least ${n} (${f.name}${whenText})` });
        else (on === 'ac' ? acAdds : speedAdds).push({ n, text: `${n >= 0 ? '+' : '-'} ${Math.abs(n)} (${f.name}${exprText}${whenText})` });
      }
    }
  }
  const sum = (xs: readonly SheetStat[]): number => xs.reduce((a, x) => a + x.n, 0);
  const statText = (xs: readonly SheetStat[]): string => xs.map((x) => ` ${x.text}`).join('');
  const notText = (on: 'ac' | 'speed'): string => {
    const xs = notCounted.filter((x) => x.on === on).map((x) => x.text);
    return xs.length ? `; not counted: ${xs.join('; ')}` : '';
  };

  // ---- AC (SRD 5.2.1: base 10 + DEX unarmored; armor by category; class formulas; only one at a time) ----
  interface AcCandidate {
    readonly key: string;
    readonly base: number;
    readonly why: string;
  }
  const dex = modOf('dex');
  const candidates: AcCandidate[] = [];
  if (armor) {
    const add = armor.category === 'light' ? dex : armor.category === 'medium' ? Math.min(dex, armor.dexCap ?? dex) : 0;
    const addText = armor.category === 'light' ? ` + ${dex} (DEX)` : armor.category === 'medium' ? ` + ${add} (DEX, max ${armor.dexCap ?? 0})` : '';
    candidates.push({ key: 'armor', base: armor.ac + add, why: `${armor.ac} (${armor.name}, ${armor.category})${addText}` });
  } else {
    candidates.push({ key: 'unarmored', base: 10 + dex, why: `10 + ${dex} (DEX, unarmored)` });
  }
  const formulaSets: [OwnerScope, ClassSource['acFormulas']][] = [[clsOwner, cls.acFormulas], ...(sub && subOwner ? [[subOwner, sub.acFormulas] as [OwnerScope, ClassSource['acFormulas']]] : [])];
  for (const [owner, formulas] of formulaSets) {
    formulas.forEach((f, j) => {
      const blocked = (f.when.includes('unarmored') && armor !== undefined) || (f.when.includes('noShield') && shieldInHand);
      if (blocked) return;
      const v = evalIn(owner.scopes, f.ac);
      if ('error' in v) {
        error(['classes', 0], `${owner.id} acFormulas[${j}]: ${v.error}`);
        return;
      }
      const shown = f.ac.replace(/@mod\.(str|dex|con|int|wis|cha)\b/g, (_, a: string) => `${modOf(a as Ability)} (${ABILITY_NAME[a as Ability]})`);
      candidates.push({ key: owner.id, base: v.value, why: `${shown} = ${v.value} (${owner.label}${f.when.length > 0 ? `, while ${f.when.join(' and ')}` : ''})` });
    });
  }
  let chosen = candidates.reduce((best, c) => (c.base > best.base ? c : best), candidates[0]!);
  if (src.acSource !== undefined) {
    const named = candidates.find((c) => c.key === src.acSource);
    if (named) chosen = named;
    else error(['acSource'], `no legal AC calculation ${src.acSource} for this character (legal: ${candidates.map((c) => c.key).join(', ')})`);
  }
  const shieldAc = shieldHeld ? shield!.ac : 0;
  const acAdd = sum(acAdds);
  const acFloor = acFloors.reduce((m, x) => (x.n > m.n ? x : m), { n: 0, text: '' });
  const acBeforeFloor = chosen.base + shieldAc + acAdd;
  const acWhy = `${chosen.why}${shieldHeld ? ` + ${shieldAc} (${shield!.name}, held)` : ''}${statText(acAdds)}${acFloor.n > acBeforeFloor ? `, raised to ${acFloor.text}` : ''}${candidates.length > 1 ? `; best of ${candidates.map((c) => `${c.key} ${c.base}`).join(', ')}` : ''}${notText('ac')}`;
  const acNum = overridden('ac', Math.max(acBeforeFloor, acFloor.n), acWhy);
  // The fight adds the shield and the passive stats to the template's AC (sim/stats.ts statAc).
  const pcAc = acNum.value - shieldAc - acAdd;
  if (pcAc < 1) error(['overrides', 'ac'], acAdd !== 0 ? `AC ${acNum.value} is below the held shield's ${shieldAc} plus the passive stats' ${acAdd}` : `AC ${acNum.value} is below the held shield's ${shieldAc}`);

  // Speed: the species', less 10 ft in armor whose Strength requirement isn't met (SRD 5.2.1 Armor, Strength).
  let speedDerived = species.speed;
  let speedWhy = `${species.speed} (${species.name})`;
  if (armor?.strength !== undefined && src.abilities.str < armor.strength) {
    speedDerived -= 10;
    speedWhy += ` - 10 (${armor.name} needs STR ${armor.strength})`;
  }
  const speedAdd = sum(speedAdds);
  speedDerived += speedAdd;
  speedWhy += `${statText(speedAdds)}${notText('speed')}`;
  const speedNum = overridden('speed', speedDerived, speedWhy);
  // The fight adds the passive speed stats to the template's speed (sim/stats.ts speedOf).
  const pcSpeed = speedNum.value - speedAdd;
  if (pcSpeed < 0) error(['overrides', 'speed'], `speed ${speedNum.value} is below the passive stats' ${speedAdd} ft`);

  const initNum = overridden('initiativeBonus', dex, `${dex} (DEX mod)`);

  // Extra attacks: the class's (or subclass's) table at its level.
  let extra = 0;
  let extraWhy = 'none';
  for (const [owner, table] of [[clsOwner, cls.extraAttacks], ...(sub && subOwner ? [[subOwner, sub.extraAttacks]] : [])] as [OwnerScope, Record<string, number>][]) {
    const v = levelValue(table, level);
    if (v && v.value > extra) {
      extra = v.value;
      extraWhy = `${v.value} (${owner.label} ${v.from})`;
    }
  }
  const extraNum = overridden('extraAttacks', extra, extraWhy);
  if (extraNum.value < 0 || extraNum.value > 3) error(['overrides', 'extraAttacks'], 'extra attacks are 0 to 3');

  // ---- Resources: slots and pools ----
  let slots: number[] = [];
  let slotsWhy = 'none';
  for (const [owner, columns] of [[clsOwner, cls.scale], ...(sub && subOwner ? [[subOwner, sub.scale]] : [])] as [OwnerScope, ClassSource['scale']][]) {
    for (const col of Object.keys(columns).sort(byString)) {
      const column = columns[col]!;
      if (column.type !== 'slots') continue;
      const v = columnAt(column.at, level);
      if (slots.length > 0) {
        error(['classes', 0], `two spell-slot columns (${owner.id} ${col} and an earlier one): only one is supported`);
        continue;
      }
      slots = v ? [...v.value] : [];
      slotsWhy = `${owner.label} ${col} at level ${level}${v ? ` (from ${v.from})` : ''}`;
    }
  }
  const pools: PcSource['pools'] = [];
  const sheetPools: { id: string; name: string; max: number; why: string; spentBy: readonly string[] }[] = [];
  // A pool is the uses of the feature it is named after (tools/import-srd poolOf: the pool id is
  // the granting feature's identifier), so it exists from the level the owner gains that feature:
  // no Divine Intervention before Cleric 10, no Wholeness of Body before Open Hand 6 (SRD 5.2.1
  // class tables). The import fails closed on an SRD pool with no same-named feature in its owner
  // (data-checks.ts poolProblems). [U] A pool with no such feature (synthetic or hand-written
  // content) has no level to gate on and is kept from level 1, as before.
  const poolFeatureLevel = (features: ClassSource['features'], poolId: string): number | undefined => {
    for (const lvl of Object.keys(features).sort(byLevelKey)) {
      for (const fid of features[lvl]!) if (localOf(fid).slice(localOf(fid).lastIndexOf('/') + 1) === poolId) return Number(lvl);
    }
    return undefined;
  };
  for (const [owner, list, ownerFeatures] of [[clsOwner, cls.pools, cls.features], ...(sub && subOwner ? [[subOwner, sub.pools, sub.features]] : [])] as [OwnerScope, ClassSource['pools'], ClassSource['features']][]) {
    for (const pl of list) {
      const gained = poolFeatureLevel(ownerFeatures, pl.id);
      if (gained !== undefined && gained > level) continue;
      if (pools.some((x) => x.id === pl.id)) {
        error(['classes', 0], `pool ${pl.id} is defined by both the class and the subclass`);
        continue;
      }
      let max = 0;
      if (typeof pl.max === 'number') max = pl.max;
      else {
        const v = evalIn(owner.scopes, pl.max);
        if ('error' in v) error(['classes', 0], `${owner.id} pool ${pl.id}: ${v.error}`);
        else max = Math.max(0, v.value);
      }
      pools.push({ id: pl.id, name: pl.name, max, recharge: pl.recharge });
      sheetPools.push({ id: pl.id, name: pl.name, max, why: typeof pl.max === 'number' ? `${pl.max} (${owner.label})` : `${pl.max} at level ${level} (${owner.label})`, spentBy: [] });
    }
  }
  // Session S: the species' own pools (a trait's uses per Long Rest). One named like a species
  // feature exists from the character level that feature is gained; any other from level 1.
  for (const pl of species.pools ?? []) {
    const f = species.features.find((x) => localOf(speciesFeatureId(x)).split('/').pop() === pl.id);
    if (f !== undefined && speciesFeatureLevel(f) > level) continue;
    if (pools.some((x) => x.id === pl.id)) {
      error(['species'], `pool ${pl.id} is defined by both ${species.name} and the class or subclass`);
      continue;
    }
    let max = 0;
    if (typeof pl.max === 'number') max = pl.max;
    else {
      const v = evalIn([], pl.max);
      if ('error' in v) error(['species'], `${species.id} pool ${pl.id}: ${v.error}`);
      else max = Math.max(0, v.value);
    }
    pools.push({ id: pl.id, name: pl.name, max, recharge: pl.recharge });
    sheetPools.push({ id: pl.id, name: pl.name, max, why: typeof pl.max === 'number' ? `${pl.max} (${species.name})` : `${pl.max} at level ${level} (${species.name})`, spentBy: [] });
  }

  // ---- Options (M3 step 5a): each compiled, non-narrative feature's activations, initiative
  // hook, reaction and riders, and which of them spend each pool ----
  const sheetOptions: SheetOption[] = [];
  const spenders = new Map<string, string[]>();
  const poolName = (id: string): string => pools.find((x) => x.id === id)?.name ?? id;
  const spend = (pool: string, n: number | undefined, who: string): string => {
    const list = spenders.get(pool) ?? [];
    if (!list.includes(who)) list.push(who);
    spenders.set(pool, list);
    return `${n ?? 1} ${poolName(pool)}`;
  };
  const gateText = (when: readonly GateSrc[] | undefined): string => (when && when.length ? `while ${when.map(gateWord).join(' and ')}` : '');
  const COST_TEXT: Readonly<Record<string, string>> = { action: 'action', bonus: 'bonus action', free: 'no action', reaction: 'reaction' };
  // M3 step 5b: the weapon rules the compiler adds (content/weapons.ts, the same functions): a
  // mastery feature per mastered weapon, and the Light property's extra attack with two Light weapons.
  const optionFeatures: { f: FeatureSource; from: string }[] = [];
  for (const g of compiledFeatures) {
    const f = lib.features.get(g.id);
    if (f && f.fidelity !== 'narrative') optionFeatures.push({ f, from: `${f.name} (${g.from})` });
  }
  const masterySrc = { masteries: masteryPicks.length > 0 ? [...masteryPicks] : undefined } as PcSource;
  for (const pw of weapons) {
    const m = masteryActive(masterySrc, pw);
    if (m === null) continue;
    const ab = weaponAbility(pw, mods);
    const f = masteryFeature(pw, m, ab, modOf(ab));
    if (f) optionFeatures.push({ f, from: `${pw.name}'s mastery property (Weapon Mastery)` });
  }
  if (lightWeaponCount(weapons) >= 2) {
    const f = lightFeature(weapons.filter((pw) => pw.light === true && masteryActive(masterySrc, pw) === 'nick'));
    optionFeatures.push({ f, from: weapons.filter((pw) => pw.light === true).length >= 2 ? 'Light property (two Light weapons)' : 'Light property (two Light weapons: a counted Thrown stack, thrown)' });
  }
  for (const { f, from } of optionFeatures) {
    const acts = f.activate === undefined ? [] : Array.isArray(f.activate) ? f.activate : [f.activate];
    for (const a of acts) {
      const parts = [COST_TEXT[a.cost]!];
      if (a.uses && 'pool' in a.uses) parts.push(spend(a.uses.pool, a.uses.cost, a.name));
      else if (a.uses) parts.push('once per turn');
      else if (a.pool !== undefined) parts.push(spend(a.pool, 1, a.name));
      const gt = gateText(a.when);
      if (gt) parts.push(gt);
      sheetOptions.push({ name: a.name, kind: 'activation', when: parts.join(', '), from });
    }
    if (f.initiative) {
      const parts = ['when you roll Initiative (optional)'];
      if (f.initiative.uses) parts.push(spend(f.initiative.uses.pool, f.initiative.uses.cost, f.initiative.name));
      sheetOptions.push({ name: f.initiative.name, kind: 'initiative', when: parts.join(', '), from });
    }
    if (f.reaction) {
      const r = f.reaction;
      const parts: string[] = [];
      // The expression with this build's numbers in it (@mod.dex -> 3 (DEX), @classLevel -> 6 (Monk level)).
      const shown = (e: string): string =>
        e
          .replace(/@mod\.(str|dex|con|int|wis|cha)\b/g, (_, a: string) => `${modOf(a as Ability)} (${ABILITY_NAME[a as Ability]})`)
          .replace(/@classLevel\b/g, `${level} (${cls.name} level)`)
          .replace(/@level\b/g, `${level} (level)`)
          .replace(/@pb\b/g, `${pb} (PB)`);
      if (r.window === 'hitTaken') {
        parts.push(`when an attack roll hits you${r.damageTypes ? ` with ${r.damageTypes.join(', ')} damage` : ''}, reduce its damage by ${r.reduce === 'halve' ? 'half' : shown(r.reduce)}`);
        if (r.pool !== undefined) parts.push(spend(r.pool, r.points, f.name));
      } else if (r.window === 'hitKnown') {
        parts.push(`when ${r.attacks.length === 2 ? 'an' : `a ${r.attacks[0]}`} attack roll hits you, before damage${r.ac !== undefined ? `, +${r.ac} AC against that attack` : ''}${r.do.length > 0 ? `, ${r.do.length} step${r.do.length > 1 ? 's' : ''} on you` : ''}`);
        if (r.pool !== undefined) parts.push(spend(r.pool, r.points, f.name));
      } else if (r.window === 'damageTaken') {
        parts.push(`after you take damage from a creature you can see within ${r.range} ft, ${r.do.length} step${r.do.length > 1 ? 's' : ''} on it`);
        if (r.pool !== undefined) parts.push(spend(r.pool, r.points, f.name));
      } else {
        parts.push(`before a d20 test (${r.rolls.join(', ')}) within ${r.range} ft, ${r.sign} ${shown(r.die)}`, spend(r.pool, 1, f.name));
      }
      sheetOptions.push({ name: f.name, kind: 'reaction', when: parts.join(', '), from });
    }
    for (const r of f.riders ?? []) {
      const parts = [`on ${r.on === 'dealtDamage' ? 'dealing damage' : r.on}`];
      const flt = r.filter;
      if (flt?.attack !== undefined) parts.push(`with ${(Array.isArray(flt.attack) ? flt.attack : [flt.attack]).join(' or ')}`);
      if (flt?.range !== undefined) parts.push(`${flt.range} only`);
      if (flt?.ability !== undefined) parts.push(`using ${ABILITY_NAME[flt.ability]}`);
      if (flt?.grantedBy !== undefined) parts.push(`granted by ${flt.grantedBy}`);
      if (flt?.weapon !== undefined) parts.push(`with ${weapons.find((x) => x.id === flt.weapon)?.name ?? flt.weapon}`);
      if (r.auto) parts.push('always (no choice)');
      if (r.oncePerTurn !== undefined) parts.push(`once per turn (${r.oncePerTurn})`);
      if (r.cost) parts.push(spend(r.cost.pool, r.cost.points, r.name));
      const gt = gateText(r.when);
      if (gt) parts.push(gt);
      if (r.choose) parts.push(`choose ${r.choose.map((c) => c.name).join(', ')}`);
      sheetOptions.push({ name: r.name, kind: 'rider', when: parts.join(', '), from });
    }
  }
  for (const p of sheetPools) p.spentBy = spenders.get(p.id) ?? [];

  // ---- Casting: per spellcasting class or subclass, the chosen lists plus always-prepared ----
  const casters: { owner: OwnerScope; sc: NonNullable<ClassSource['spellcasting']> }[] = [];
  if (cls.spellcasting) casters.push({ owner: clsOwner, sc: cls.spellcasting });
  if (sub?.spellcasting && subOwner) casters.push({ owner: subOwner, sc: sub.spellcasting });
  const always: string[] = [];
  if (sub) for (const lvl of Object.keys(sub.alwaysPrepared).sort(byLevelKey)) if (Number(lvl) <= level) for (const id of sub.alwaysPrepared[lvl]!) if (!always.includes(id)) always.push(id);
  const usedCasting = new Set<number>();
  src.casting.forEach((cs, i) => {
    if (!casters.some((x) => x.owner.id === cs.source)) error(['casting', i, 'source'], `${cs.source} isn't a spellcasting class or subclass of this character (${casters.length > 0 ? casters.map((x) => x.owner.id).join(', ') : 'it has none'})`);
    else if (src.casting.findIndex((x) => x.source === cs.source) !== i) error(['casting', i, 'source'], `${cs.source} is listed twice`);
  });
  if (always.length > 0 && casters.length === 0) unimplemented.push(`${sub!.name}: always-prepared spells with no spellcasting class to cast them`);
  const casting: PcSource['casting'] = [];
  const sheetCasting: DerivedSheet['casting'][number][] = [];
  const cantripSeen = new Map<string, string>();
  casters.forEach((x, ci) => {
    const idx = src.casting.findIndex((cs) => cs.source === x.owner.id);
    const cs = idx >= 0 ? src.casting[idx]! : { source: x.owner.id, cantrips: [], prepared: [] };
    if (idx >= 0) usedCasting.add(idx);
    const cp: YamlPath = idx >= 0 ? ['casting', idx] : ['classes', 0];
    const mine = ci === 0 ? always.filter((id) => !cs.prepared.includes(id) && !cs.cantrips.includes(id)) : [];
    if (ci === 0) {
      for (const id of always) {
        if (cs.cantrips.includes(id) || cs.prepared.includes(id)) warn(cp, `${id} is always prepared (${sub!.name}); choosing it too wastes a pick (it's granted twice)`);
      }
    }
    cs.cantrips.forEach((id, j) => {
      const prev = cantripSeen.get(id);
      if (prev !== undefined) warn([...cp, 'cantrips', j], `cantrip ${id} is granted twice (also ${prev})`);
      else cantripSeen.set(id, x.owner.id);
    });
    const expected = (v: number | string | undefined, what: string): number | null => {
      if (v === undefined) return null;
      if (typeof v === 'number') return v;
      const r = evalIn(x.owner.scopes, v);
      if ('error' in r) {
        error(cp, `${x.owner.id} spellcasting.${what}: ${r.error}`);
        return null;
      }
      return r.value;
    };
    const wantC = expected(x.sc.cantrips, 'cantrips');
    const wantP = expected(x.sc.prepared, 'prepared');
    if (wantC !== null && cs.cantrips.length !== wantC) warn(idx >= 0 ? [...cp, 'cantrips'] : cp, `${x.owner.label} ${level} knows ${wantC} cantrip(s) (${String(x.sc.cantrips)}); ${cs.cantrips.length} chosen`);
    if (wantC === null && cs.cantrips.length > 0) warn([...cp, 'cantrips'], `${x.owner.label} gets no cantrips from its table; ${cs.cantrips.length} chosen`);
    if (wantP !== null && cs.prepared.length !== wantP) warn(idx >= 0 ? [...cp, 'prepared'] : cp, `${x.owner.label} ${level} prepares ${wantP} spell(s) (${String(x.sc.prepared)}); ${cs.prepared.length} chosen`);
    pathMap.casting.push(cp);
    casting.push({
      source: localOf(x.owner.id).replace(/\//g, '-'),
      ability: x.sc.ability,
      list: listLocal(x.sc.list),
      cantrips: [...cs.cantrips],
      prepared: [...cs.prepared],
      always: mine,
      free: [],
    });
    sheetCasting.push({ source: x.owner.id, ability: x.sc.ability, cantrips: [...cs.cantrips], prepared: [...cs.prepared], always: mine, cantripsExpected: wantC, preparedExpected: wantP });
  });

  // ---- HP (C10) plus feature grants (C9a) ----
  /** A class's (or its subclass's) level: the one class entry until multiclassing. */
  const classLevelOf = (ownerId: string): number => (ownerId === cls.id || ownerId === sub?.id ? entry.level : level);
  const con = modOf('con');
  const hp = hitPoints(cls.hitDie, level, con, src.hp);
  if (hp.error !== null) error(['hp'], hp.error);
  if (hp.clamped) warn(['hp'], 'a level\'s hit points came to less than 1 and were raised to 1 [U: the SRD prints the minimum for rolled hit points only]');
  let hpTotal = hp.total;
  let hpWhy = hp.why;
  for (const g of compiledFeatures) {
    const f = lib.features.get(g.id);
    if (!f?.hp) continue;
    // A class or subclass feature counts that class's levels (Draconic Resilience: Sorcerer
    // levels); a species trait or feat counts character levels (Dwarven Toughness, Tough).
    // One class in M3, so both are the same number today; the sheet names which.
    const levels = g.owner.classScoped ? classLevelOf(g.owner.id) : level;
    const per = f.hp.perLevel ?? 0;
    if (per > 0) {
      hpTotal += per * levels;
      hpWhy += ` + ${levels} x ${per} (${f.name}, ${g.owner.classScoped ? `${cls.name} levels` : 'character levels'})`;
    }
    if (f.hp.flat !== undefined) {
      hpTotal += f.hp.flat;
      hpWhy += ` + ${f.hp.flat} (${f.name})`;
    }
  }
  const hpNum = overridden('hpMax', hpTotal, hpWhy);
  if (hpNum.value < 1) error(['overrides', 'hpMax'], 'hpMax must be at least 1');

  // ---- Saves and skills ----
  const saveProficiencies = [...cls.saves];
  const saves = ABILITIES.map((a) => {
    const prof = saveProficiencies.includes(a);
    return { ability: a, mod: modOf(a) + (prof ? pb : 0), proficient: prof, why: `${modOf(a)} (${ABILITY_NAME[a]} mod)${prof ? ` + ${pb} (PB, ${cls.name} save)` : ''}` };
  });
  const skills = SKILLS.map(([name, ab]) => {
    const ex = expertise.has(name) && proficient.has(name);
    const pr = proficient.has(name);
    const add = ex ? 2 * pb : pr ? pb : 0;
    const why = `${modOf(ab)} (${ABILITY_NAME[ab]} mod)${ex ? ` + 2 x ${pb} (Expertise: ${expertise.get(name)!}; proficient: ${proficient.get(name)!})` : pr ? ` + ${pb} (proficient: ${proficient.get(name)!})` : ''}`;
    return { skill: name, mod: modOf(ab) + add, rank: (ex ? 'expertise' : pr ? 'proficient' : 'none') as 'none' | 'proficient' | 'expertise', why };
  });
  const proficientList = SKILLS.map(([n]) => n).filter((n) => proficient.has(n));
  const expertiseList = SKILLS.map(([n]) => n).filter((n) => expertise.has(n) && proficient.has(n));

  // ---- The PcSource ----
  const resist = [...species.resist].sort(byString);
  const featureIds = compiledFeatures.map((g) => g.id);
  compiledFeatures.forEach((g) => pathMap.features.push(g.path));
  const allLines = [...unimplemented, ...src.unimplemented];
  const fidelity: 'full' | 'partial' = allLines.length + featureLines.length > 0 ? 'partial' : 'full';
  const pc: PcSource = {
    kind: 'pc',
    id: src.id,
    name: src.name,
    source: src.source,
    fidelity,
    placeholder: src.placeholder,
    unimplemented: allLines,
    rules: '2024',
    level,
    pb,
    size,
    speed: Math.max(0, pcSpeed),
    // M3 step 4: the armor worn, for the unarmored and armored gates (sim/stats.ts gateOk).
    armor: armor ? (armor.category as 'light' | 'medium' | 'heavy') : 'none',
    abilities: { ...src.abilities },
    hpMax: Math.max(1, hpNum.value),
    ac: Math.max(1, pcAc),
    saveProficiencies,
    skills: { proficient: proficientList, expertise: expertiseList, bonus: [] },
    ...(src.overrides.initiativeBonus !== undefined ? { initiativeBonus: initNum.value } : {}),
    extraAttacks: Math.min(3, Math.max(0, extraNum.value)),
    weapons,
    // M3 step 5b: a character's weapons are hand items, and its Weapon Mastery picks are its masteries.
    heldWeapons: true,
    ...(masteryPicks.length > 0 ? { masteries: [...masteryPicks] } : {}),
    ...(maDie !== null ? { unarmedStrike: { ability: 'finesse' as const, damage: `${maDie} + @mod` } } : {}),
    resist,
    vuln: [],
    immune: [],
    items,
    hands: pcHands,
    slots,
    pools,
    casting,
    features: featureIds,
    flags: { ...src.flags },
  };

  const sheet: DerivedSheet = {
    id: src.id,
    name: src.name,
    source: src.source,
    placeholder: src.placeholder,
    classes: [{ id: cls.id, name: cls.name, level, subclass: sub ? { id: sub.id, name: sub.name } : null }],
    level,
    species: { id: species.id, name: species.name },
    size,
    background: { id: background.id, name: background.name },
    abilities: ABILITIES.map((a) => ({ ability: a, score: src.abilities[a], mod: modOf(a) })),
    pb: pbNum,
    hpMax: hpNum,
    ac: acNum,
    speed: speedNum,
    initiative: initNum,
    extraAttacks: extraNum,
    saves,
    skills,
    attacks: sheetAttacks,
    slots: { levels: slots, why: slotsWhy },
    pools: sheetPools,
    options: sheetOptions,
    casting: sheetCasting,
    feats: feats.map((f) => ({ id: f.feat.id, name: f.feat.name, from: f.from, fidelity: f.feat.fidelity })).sort((a, b) => byString(a.id, b.id)),
    features: sheetFeatures,
    picks: pickLines.sort((a, b) => byString(a.key, b.key)),
    unimplemented: [...allLines, ...featureLines],
    fidelity,
  };
  return { pc, sheet, scale, scaleAmbiguous, issues, pathOf };
}

function formatIncreases(asi: Readonly<Partial<Record<Ability, number | undefined>>>): string {
  return ABILITIES.filter((a) => asi[a] !== undefined)
    .map((a) => `${ABILITY_NAME[a]} +${asi[a]!}`)
    .join(', ');
}

/** The character lint (docs/design/m3.md 10): the expansion's warnings and errors, for a caller that wants only those. */
export function lintCharacter(src: CharacterSource, lib: CharacterLib): readonly CharIssue[] {
  return expandCharacter(src, lib).issues;
}

/** The sheet as JSON-ready data (it is plain data already; this fixes the key order for printing). */
export function sheetJson(sheet: DerivedSheet): unknown {
  return JSON.parse(JSON.stringify(sheet)) as unknown;
}

const num = (label: string, n: SheetNumber, sign = false): string => {
  const v = sign ? signed(n.value) : String(n.value);
  const o = n.override ? `   (derived ${sign ? signed(n.override.derived) : n.override.derived}: ${n.override.derivedWhy})` : '';
  return `${label.padEnd(13)}${v.padStart(4)}   ${n.why}${o}`;
};

/** The sheet as text, for `montecrit build` and `sheet`: every number with its derivation, every feature with its fidelity. */
export function renderSheet(sheet: DerivedSheet): string {
  const out: string[] = [];
  const c = sheet.classes[0]!;
  out.push(`${sheet.name} (${sheet.id})${sheet.placeholder ? '  [placeholder]' : ''}`);
  out.push(`${c.name} ${c.level}${c.subclass ? ` (${c.subclass.name})` : ''}, ${sheet.species.name} (${sheet.size}), ${sheet.background.name}   source: ${sheet.source}   fidelity: ${sheet.fidelity}`);
  out.push(`Abilities    ${sheet.abilities.map((a) => `${ABILITY_NAME[a.ability]} ${a.score} (${signed(a.mod)})`).join('  ')}`);
  out.push(num('PB', sheet.pb, true));
  out.push(num('HP max', sheet.hpMax));
  out.push(num('AC', sheet.ac));
  out.push(num('Speed', sheet.speed));
  out.push(num('Initiative', sheet.initiative, true));
  out.push(num('Extra attacks', sheet.extraAttacks));
  out.push('Saves');
  for (const s of sheet.saves) out.push(`  ${ABILITY_NAME[s.ability]} ${signed(s.mod).padStart(3)}${s.proficient ? '*' : ' '}  ${s.why}`);
  out.push('Skills (proficient or better)');
  const ranked = sheet.skills.filter((s) => s.rank !== 'none');
  if (ranked.length === 0) out.push('  none');
  for (const s of ranked) out.push(`  ${s.skill.padEnd(16)}${signed(s.mod).padStart(3)}  ${s.why}`);
  out.push('Attacks');
  if (sheet.attacks.length === 0) out.push('  none (Unarmed Strike only)');
  for (const a of sheet.attacks) {
    out.push(`  ${a.name}: ${signed(a.toHit.value)} to hit (${a.toHit.why}), ${a.damage}, ${a.reach}`);
    for (const n of a.notes) out.push(`    - ${n}`);
  }
  out.push(`Spell slots  ${sheet.slots.levels.length > 0 ? sheet.slots.levels.map((n, i) => `L${i + 1} ${n}`).join(', ') : 'none'}   (${sheet.slots.why})`);
  out.push('Pools');
  if (sheet.pools.length === 0) out.push('  none');
  for (const p of sheet.pools) out.push(`  ${p.name} ${p.max}   (${p.why})${p.spentBy.length ? `; spent by ${p.spentBy.join(', ')}` : ''}`);
  out.push('Options (what the compiled features offer in a fight)');
  if (sheet.options.length === 0) out.push('  none');
  const ow = sheet.options.reduce((w, o) => (o.name.length > w ? o.name.length : w), 0);
  for (const o of sheet.options) out.push(`  ${o.name.padEnd(ow)}  ${o.kind}: ${o.when}   (${o.from})`);
  if (sheet.casting.length > 0) {
    out.push('Casting');
    for (const k of sheet.casting) {
      out.push(`  ${k.source} (${ABILITY_NAME[k.ability]}): cantrips ${k.cantrips.length}${k.cantripsExpected !== null ? `/${k.cantripsExpected}` : ''} [${k.cantrips.join(', ')}], prepared ${k.prepared.length}${k.preparedExpected !== null ? `/${k.preparedExpected}` : ''} [${k.prepared.join(', ')}]${k.always.length > 0 ? `, always [${k.always.join(', ')}]` : ''}`);
    }
  }
  if (sheet.feats.length > 0) {
    out.push('Feats');
    const tw = sheet.feats.reduce((w, f) => (f.id.length > w ? f.id.length : w), 0);
    for (const f of sheet.feats) out.push(`  ${f.id.padEnd(tw)} ${f.name} (${f.from})  ${f.fidelity}`);
  }
  out.push('Features');
  const fw = sheet.features.reduce((w, f) => (f.id.length > w ? f.id.length : w), 0);
  for (const f of sheet.features) out.push(`  ${f.id.padEnd(fw)} ${f.name} (${f.from})  ${f.compiled ? f.fidelity : 'narrative (above level 10)'}`);
  if (sheet.picks.length > 0) {
    out.push('Picks');
    for (const p of sheet.picks) out.push(`  ${p.key}: ${p.value}`);
  }
  out.push(`Not modeled (${sheet.unimplemented.length})`);
  for (const u of sheet.unimplemented) out.push(`  - ${u}`);
  return `${out.join('\n')}\n`;
}
