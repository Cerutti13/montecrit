// Validated source -> CompiledTemplate. Expressions are parsed and folded here, crit
// extras derived, damage types turned into indices and masks, the core options and the
// Unarmed Strike injected, and the attack act built. Anything that can't compile is an
// error at the offending node; numbers that merely disagree with the stat block are lint
// warnings (lint.ts), never silently corrected.

import { ExprError, bindExpr, diceOnly, evalConstant, exprPmf, isConstant, formatExpr, parseExpr, type ExprBinding, type ExprEnv, type ExprNode } from '../dice/expr.ts';
import { mean } from '../odds/pmf.ts';
import { EMPTY_LIBRARY, checkFeature, compileCasting, compileMonsterActions, condMask, poolMax, riderLists, riderPlan, type FeatureDef, type Library, type RiderAttackInfo } from './compile-spell.ts';
import { lightFeature, lightWeaponCount, masteryActive, masteryFeature, weaponAbility } from './weapons.ts';
import { RK, SKILLS, compileKeyPattern } from './rollkeys.ts';
import type { FeatureSource, MonsterSource, PcSource } from './schema.ts';
import {
  ABILITIES,
  DAMAGE_TYPES,
  SIZES,
  damageBit,
  type AttackAct,
  type AttackGroup,
  type CompiledAttack,
  type CompiledDamage,
  type CompiledOption,
  type CompiledTemplate,
  type DamageType,
  type GearItem,
  type Id,
  type ItemDef,
  type PoolDef,
} from './types.ts';
import { diagAt, formatPath, type Diag, type SourceDoc, type YamlPath } from './yaml.ts';

export const abilityMod = (score: number): number => Math.floor((score - 10) / 2);
export const proficiencyBonus = (level: number): number => 2 + Math.floor((level - 1) / 4);

/** A class table's columns at one character's level, by column name: a number, or dice (martial-arts 1d8 at level 5). */
export type ScaleBindings = Readonly<Record<string, ExprBinding>>;

/** The numbers a PC's rolls bind besides a roll's own @mod. */
export interface PcBindings {
  readonly pb: number;
  readonly level: number;
  /** Ability modifiers, ABILITIES order. */
  readonly mods: readonly number[];
  /** Scale columns, supplied by the caller (from class data); none when undefined. */
  readonly scale?: ScaleBindings | undefined;
  /**
   * Short @scale.<column> names more than one of the character's owners define (a class and its
   * subclass both with a cantrips column), with those owners: a PC's features compile with one
   * scope, so the short form there must be unique and these need @scale.<owner>.<column>.
   */
  readonly scaleAmbiguous?: Readonly<Record<string, readonly string[]>> | undefined;
}

export const PC_VARS = '@pb, @mod.<ability>, @level, @classLevel and @scale.<column>';

const scaleMissing = (name: string): string =>
  `no binding for @${name}: scale columns come from the character's class, and this character has no "${name.slice(6)}" column`;

/**
 * A PC's variables, folded when it compiles: @pb, @mod.<ability>, @level, @classLevel
 * (the PC's level: one class until multiclassing) and @scale.<column> (from k.scale).
 * A @scale name with no binding throws an ExprError naming it; with onMissing it's
 * reported there instead and stands in as 0, so the rest still binds.
 */
export function pcEnv(k: PcBindings, onMissing?: (name: string, message: string) => void): (name: string) => ExprBinding | undefined {
  return (name) => {
    if (name === 'pb') return k.pb;
    if (name === 'level' || name === 'classlevel') return k.level;
    if (name.startsWith('mod.')) {
      const i = ABILITIES.indexOf(name.slice(4) as (typeof ABILITIES)[number]);
      return i < 0 ? undefined : k.mods[i];
    }
    if (name.startsWith('scale.')) {
      const col = name.slice(6);
      if (k.scale !== undefined && Object.hasOwn(k.scale, col)) return k.scale[col];
      const owners = k.scaleAmbiguous !== undefined && Object.hasOwn(k.scaleAmbiguous, col) ? k.scaleAmbiguous[col]! : undefined;
      const message = owners
        ? `@${name} is ambiguous here: ${owners.join(' and ')} each have a "${col}" column (write ${owners.map((o) => `@scale.${o}.${col}`).join(' or ')})`
        : scaleMissing(name);
      if (!onMissing) throw new ExprError(message);
      onMissing(name, message);
      return 0;
    }
    return undefined;
  };
}

/**
 * Stand-ins for checking a spell or feature at its own file, before any caster: every
 * PC variable is known (any @scale column too, since its class isn't known here), so only
 * names no character could bind are errors at load.
 */
export function standInEnv(name: string): ExprBinding | undefined {
  if (name === 'pb') return 2;
  if (name === 'level' || name === 'classlevel') return 1;
  if (name.startsWith('mod.')) return ABILITIES.includes(name.slice(4) as (typeof ABILITIES)[number]) ? 0 : undefined;
  if (name.startsWith('scale.')) return 1;
  return undefined;
}

/** env, plus @mod bound to one roll's ability modifier (null: no @mod here). */
export const withMod = (mod: number | null, env: (name: string) => ExprBinding | undefined): ExprEnv => (name) => (name === 'mod' ? (mod ?? undefined) : env(name));

/** Where an item sits (file plus path prefix) and where its diagnostics go. */
export interface ItemCtx {
  readonly doc: SourceDoc;
  readonly prefix: YamlPath;
  readonly errors: Diag[];
  readonly warnings: Diag[];
}

const lead = (p: YamlPath): string => (p.length > 0 ? `${formatPath(p)}: ` : '');

export const errorAt = (c: ItemCtx, p: YamlPath, message: string): void => {
  c.errors.push(diagAt(c.doc, [...c.prefix, ...p], `${lead(p)}${message}`));
};
export const warnAt = (c: ItemCtx, p: YamlPath, message: string): void => {
  c.warnings.push(diagAt(c.doc, [...c.prefix, ...p], `${lead(p)}${message}`));
};

interface Term {
  readonly sign: 1 | -1;
  readonly node: ExprNode;
}

/** Flattens a sum into signed terms: 1d6 + @mod - 1 -> [+1d6, +@mod, -1]. */
function sumTerms(node: ExprNode, sign: 1 | -1, out: Term[]): void {
  if (node.k === 'add') {
    sumTerms(node.a, sign, out);
    sumTerms(node.b, sign, out);
  } else if (node.k === 'sub') {
    sumTerms(node.a, sign, out);
    sumTerms(node.b, sign === 1 ? -1 : 1, out);
  } else if (node.k === 'neg') {
    sumTerms(node.a, sign === 1 ? -1 : 1, out);
  } else out.push({ sign, node });
}

/**
 * Replaces @vars with their values (bindExpr: class variables, computed dice counts and
 * dice-valued columns included) and folds every constant in a sum into one trailing
 * constant: '1d6 + @mod + 1' with mod 4 -> '1d6 + 5'. Dice terms keep their order, so the
 * sampler draws them in the same sequence. min and max with dice fold inside each side.
 */
export function foldExpr(node: ExprNode, vars: ExprEnv): ExprNode {
  return foldBound(bindExpr(node, vars));
}

function foldBound(node: ExprNode): ExprNode {
  if (isConstant(node)) return { k: 'const', v: evalConstant(node, {}) };
  const terms: Term[] = [];
  sumTerms(node, 1, terms);
  let c = 0;
  let out: ExprNode | null = null;
  for (const t of terms) {
    if (isConstant(t.node)) {
      c += t.sign * evalConstant(t.node, {});
      continue;
    }
    const k = t.node.k;
    const n: ExprNode = k === 'mul' || k === 'min' || k === 'max' ? { k, a: foldBound(t.node.a), b: foldBound(t.node.b) } : t.node;
    if (out === null) out = t.sign === 1 ? n : { k: 'neg', a: n };
    else out = t.sign === 1 ? { k: 'add', a: out, b: n } : { k: 'sub', a: out, b: n };
  }
  if (out === null) return { k: 'const', v: c };
  if (c > 0) return { k: 'add', a: out, b: { k: 'const', v: c } };
  if (c < 0) return { k: 'sub', a: out, b: { k: 'const', v: -c } };
  return out;
}

/** Exact mean of a folded expression. Plain dice sums are exact halves; keep-dice use the PMF. */
export function exprMean(node: ExprNode): number {
  switch (node.k) {
    case 'const':
      return node.v;
    case 'dice':
      return node.keep && node.keep.count < node.n ? mean(exprPmf(node)) : (node.n * (node.sides + 1)) / 2;
    case 'neg':
      return -exprMean(node.a);
    case 'add':
      return exprMean(node.a) + exprMean(node.b);
    case 'sub':
      return exprMean(node.a) - exprMean(node.b);
    case 'mul':
      return isConstant(node.a) ? evalConstant(node.a, {}) * exprMean(node.b) : exprMean(node.a) * evalConstant(node.b, {});
    case 'min':
    case 'max':
      return mean(exprPmf(node));
    case 'vdice':
      throw new ExprError(`unfolded dice count in ${formatExpr(node)}`);
    case 'var':
      throw new ExprError(`unfolded variable @${node.name}`);
  }
}

/** floor of a mean, tolerant of float noise from keep-dice PMFs. */
export const floorMean = (m: number): number => Math.floor(m + 1e-9);

export interface CompiledRoll {
  readonly roll: ExprNode;
  readonly critExtra: ExprNode | null;
  /** Why the roll has no crit reading (dice inside min/max); only a damage roll needs one. */
  readonly critError: string | null;
  readonly mean: number;
}

/** A damage roll's crit extra dice, or an error at p when it has no crit reading. */
export function critExtraAt(c: ItemCtx, p: YamlPath, roll: ExprNode): ExprNode | null {
  try {
    return diceOnly(roll);
  } catch (e) {
    if (!(e instanceof ExprError)) throw e;
    errorAt(c, p, e.message);
    return null;
  }
}

/** Parses, folds and checks one expression; reports an error at p and returns null on failure. */
export function compileRoll(c: ItemCtx, p: YamlPath, src: string, vars: ExprEnv, varsHint: string): CompiledRoll | null {
  try {
    const roll = foldExpr(parseExpr(src), vars);
    exprPmf(roll); // proves it has an exact distribution (rejects dice times dice)
    let critExtra: ExprNode | null = null;
    let critError: string | null = null;
    try {
      critExtra = diceOnly(roll);
    } catch (e) {
      if (!(e instanceof ExprError)) throw e;
      critError = e.message;
    }
    return { roll, critExtra, critError, mean: exprMean(roll) };
  } catch (e) {
    if (e instanceof ExprError || e instanceof RangeError) {
      const hint = /unknown variable/.test(e.message) ? ` (${varsHint})` : '';
      errorAt(c, p, `${e.message}${hint}`);
      return null;
    }
    throw e;
  }
}

const typeIndex = (t: DamageType): number => DAMAGE_TYPES.indexOf(t);

const mask = (types: readonly DamageType[]): number => types.reduce((m, t) => m | damageBit(typeIndex(t)), 0);

interface DamageSrc {
  readonly roll: string;
  readonly type: DamageType;
  readonly avg?: number | undefined;
  readonly ifAdvantage: boolean;
}

function compileDamage(c: ItemCtx, p: YamlPath, parts: readonly DamageSrc[], vars: ExprEnv, varsHint: string): CompiledDamage[] | null {
  const out: CompiledDamage[] = [];
  let ok = true;
  parts.forEach((d, j) => {
    const r = compileRoll(c, [...p, j, 'roll'], d.roll, vars, varsHint);
    if (r?.critError) errorAt(c, [...p, j, 'roll'], r.critError);
    if (!r || r.critError) {
      ok = false;
      return;
    }
    out.push({
      roll: r.roll,
      critExtra: r.critExtra,
      type: typeIndex(d.type),
      avg: d.avg ?? floorMean(r.mean),
      ifAdvantage: d.ifAdvantage,
    });
  });
  return ok ? out : null;
}

interface Mode {
  local: string;
  name: string;
  kind: 'melee' | 'ranged';
  reachFt: number;
  normalFt: number;
  longFt: number;
  gear: number;
  consumesGear: boolean;
}

/** M3 step 5b: what a held weapon's mode adds to its attack (each field only when set, C3). */
type Held = Pick<CompiledAttack, 'item' | 'twoHands' | 'throws' | 'loading' | 'heavyDis'>;

function attack(tplId: Id, m: Mode, toHit: number, damage: readonly CompiledDamage[], held: Held = {}): CompiledAttack {
  return {
    ...attackCore(tplId, m, toHit, damage),
    ...held,
  };
}

function attackCore(tplId: Id, m: Mode, toHit: number, damage: readonly CompiledDamage[]): CompiledAttack {
  return {
    id: `${tplId}/${m.local}` as Id,
    local: m.local,
    name: m.name,
    kind: m.kind,
    rollKey: m.kind === 'melee' ? 'd20.attack.melee' : 'd20.attack.ranged',
    toHit,
    critMin: 20,
    reachFt: m.reachFt,
    normalFt: m.normalFt,
    longFt: m.longFt,
    damage,
    gear: m.gear,
    consumesGear: m.consumesGear,
    unarmed: false,
    spell: false,
  };
}

/** Melee mode then thrown mode for a weapon usable both ways. Both share the gear index. */
function bothModes(local: string, name: string, reach: number, range: readonly [number, number], gear: number, consumes: boolean): Mode[] {
  return [
    { local, name, kind: 'melee', reachFt: reach, normalFt: 0, longFt: 0, gear, consumesGear: false },
    { local: `${local}-thrown`, name: `${name} (thrown)`, kind: 'ranged', reachFt: 0, normalFt: range[0], longFt: range[1], gear, consumesGear: consumes },
  ];
}

export const UNARMED_LOCAL = 'unarmed-strike';

/** core:unarmed-strike: STR + PB to hit, 1 + STR bludgeoning (never below 0), reach 5. */
export function unarmedStrike(strMod: number, pb: number): CompiledAttack {
  const dmg = Math.max(0, 1 + strMod);
  return {
    id: 'core:unarmed-strike',
    local: UNARMED_LOCAL,
    name: 'Unarmed Strike',
    kind: 'melee',
    rollKey: 'd20.attack.melee',
    toHit: strMod + pb,
    critMin: 20,
    reachFt: 5,
    normalFt: 0,
    longFt: 0,
    damage: [{ roll: { k: 'const', v: dmg }, critExtra: null, type: typeIndex('bludgeoning'), avg: dmg, ifAdvantage: false }],
    gear: -1,
    consumesGear: false,
    unarmed: true,
    spell: false,
  };
}

export const CORE_OPTIONS: readonly CompiledOption[] = Object.freeze([
  Object.freeze({ id: 'core:dash', local: 'dash', name: 'Dash', cost: 'action', core: 'core:dash' } as const),
  Object.freeze({ id: 'core:disengage', local: 'disengage', name: 'Disengage', cost: 'action', core: 'core:disengage' } as const),
]);

const allIndices = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

function oaReach(attacks: readonly CompiledAttack[]): number {
  return attacks.reduce((m, a) => (a.kind === 'melee' && a.reachFt > m ? a.reachFt : m), 0);
}

function checkUniqueLocals(c: ItemCtx, attacks: readonly CompiledAttack[], listKey: string, authoredIndex: readonly number[]): void {
  const seen = new Map<string, number>();
  attacks.forEach((a, i) => {
    const prev = seen.get(a.local);
    if (prev !== undefined) {
      const at = authoredIndex[i];
      errorAt(c, at === undefined ? [listKey] : [listKey, at, 'id'], `attack id "${a.local}" is used twice (${attacks[prev]!.name} and ${a.name})`);
    } else seen.set(a.local, i);
  });
}

/** Critique #22: spell attacks live in spell programs, never in tpl.attacks (no opportunity attacks with them). */
function assertNoSpellAttacks(attacks: readonly CompiledAttack[]): void {
  const bad = attacks.find((a) => a.spell);
  if (bad) throw new Error(`internal: spell attack ${bad.id} reached tpl.attacks`);
}

/** Freezes the template and everything in it, so the simulator can't write to shared content. */
function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

/** Nine empty spell-slot levels and no pools. */
const NO_RES: readonly number[] = Object.freeze([0, 0, 0, 0, 0, 0, 0, 0, 0]);
const NO_SKILLS: readonly number[] = Object.freeze(new Array<number>(18).fill(0));

export function compileMonster(src: MonsterSource, c: ItemCtx): CompiledTemplate | null {
  const startErrors = c.errors.length;
  const tplId = src.id as Id;
  const mods = ABILITIES.map((a) => abilityMod(src.abilities[a]));
  const noVars = 'monster rolls are plain dice and numbers';

  const gear: GearItem[] = src.gear.map((g) => ({ name: g.name, count: g.count ?? -1 }));
  const gearIndex = new Map<string, number>();
  src.gear.forEach((g, i) => {
    if (gearIndex.has(g.name)) errorAt(c, ['gear', i, 'name'], `gear "${g.name}" is listed twice`);
    else gearIndex.set(g.name, i);
  });

  const attacks: CompiledAttack[] = [];
  const authoredIndex: number[] = []; // compiled attack -> authored attack index
  const byAuthoredId = new Map<string, number[]>();
  src.attacks.forEach((a, i) => {
    const damage = compileDamage(c, ['attacks', i, 'damage'], a.damage, {}, noVars);
    let g = -1;
    if (a.thrownGear !== undefined) {
      const gi = gearIndex.get(a.thrownGear);
      if (gi === undefined) errorAt(c, ['attacks', i, 'thrownGear'], `thrownGear "${a.thrownGear}" isn't in this creature's gear`);
      else if (gear[gi]!.count < 0) errorAt(c, ['attacks', i, 'thrownGear'], `gear "${a.thrownGear}" needs a count to be thrown`);
      else g = gi;
    }
    if (!damage) {
      byAuthoredId.set(a.id, []); // its own error is already reported; Multiattack refs to it stay quiet
      return;
    }
    const modes: Mode[] =
      a.kind === 'melee'
        ? [{ local: a.id, name: a.name, kind: 'melee', reachFt: a.reach ?? 5, normalFt: 0, longFt: 0, gear: -1, consumesGear: false }]
        : a.kind === 'ranged'
          ? [{ local: a.id, name: a.name, kind: 'ranged', reachFt: 0, normalFt: a.range![0], longFt: a.range![1], gear: -1, consumesGear: false }]
          : bothModes(a.id, a.name, a.reach ?? 5, a.range!, g, a.thrownGear !== undefined && g >= 0);
    const idx: number[] = [];
    for (const m of modes) {
      idx.push(attacks.length);
      authoredIndex.push(i);
      attacks.push(attack(tplId, m, a.toHit, damage));
    }
    byAuthoredId.set(a.id, idx);
  });
  attacks.push(unarmedStrike(mods[0]!, src.pb));
  checkUniqueLocals(c, attacks, 'attacks', authoredIndex);

  let attackAct: AttackAct;
  if (src.multiattack) {
    const byLocal = new Map<string, number>();
    attacks.forEach((a, i) => byLocal.set(a.local, i));
    const alts = src.multiattack.alternatives.map((alt, ai) =>
      alt.map((grp, gi): AttackGroup => {
        const from: number[] = [];
        grp.from.forEach((ref, k) => {
          const hit = byAuthoredId.has(ref) ? byAuthoredId.get(ref)! : byLocal.has(ref) ? [byLocal.get(ref)!] : undefined;
          if (!hit) {
            errorAt(c, ['multiattack', 'alternatives', ai, gi, 'from', k], `Multiattack names "${ref}", which isn't one of this creature's attacks`);
            return;
          }
          for (const h of hit) {
            if (from.includes(h)) errorAt(c, ['multiattack', 'alternatives', ai, gi, 'from', k], `"${ref}" is listed twice in one group`);
            else from.push(h);
          }
        });
        from.sort((x, y) => x - y);
        return { count: grp.count, from };
      }),
    );
    // Step E (E1): the plain Attack action, one strike with any attack, the Unarmed Strike and
    // attacks outside every Multiattack line included (srd-raw.txt:43416-43417, 43908-43910,
    // 32705-32706). Appended last, so every Multiattack alternative keeps its bit (plainAlt).
    alts.push([{ count: 1, from: allIndices(attacks.length) }]);
    attackAct = { name: src.multiattack.name, multi: true, extraAttack: false, alts };
  } else {
    attackAct = { name: 'Attack', multi: false, extraAttack: false, alts: [[{ count: 1, from: allIndices(attacks.length) }]] };
  }

  const options: CompiledOption[] = [...CORE_OPTIONS];
  src.options.forEach((o, i) => {
    if (options.some((x) => x.local === o.id)) {
      errorAt(c, ['options', i, 'id'], `option id "${o.id}" is already taken`);
      return;
    }
    options.push({ id: `${tplId}/${o.id}` as Id, local: o.id, name: o.name, cost: o.cost, core: o.core });
  });

  const hp = compileRoll(c, ['hp', 'formula'], src.hp.formula, {}, noVars);

  const unimplemented = [...src.unimplemented];
  for (const [key, label] of [['burrow', 'Burrow'], ['climb', 'Climb'], ['fly', 'Fly'], ['swim', 'Swim']] as const) {
    const ft = src.speed[key];
    if (ft !== undefined) unimplemented.push(`${label} Speed ${ft} ft.`);
  }

  // Coverage step 7.6: actions (none on most monsters: every field below stays today's constant); step 9+: traits and reactions.
  const acts = src.actions || src.traits || src.reactions ? compileMonsterActions(c, src) : null;
  if (acts) unimplemented.push(...acts.unimplemented);

  if (c.errors.length > startErrors || !hp) return null;
  assertNoSpellAttacks(attacks);
  return deepFreeze({
    id: tplId,
    kind: 'monster',
    name: src.name,
    source: src.source,
    size: SIZES.indexOf(src.size),
    ac: src.ac,
    hpMax: src.hp.average,
    hpFormula: hp.roll,
    speedFt: src.speed.walk,
    scores: ABILITIES.map((a) => src.abilities[a]),
    saveMod: ABILITIES.map((a, i) => src.saves[a] ?? mods[i]!),
    initMod: src.initiative.mod,
    initScore: src.initiative.score,
    pb: src.pb,
    attacks,
    attackAct,
    options,
    gear,
    oaReachFt: oaReach(attacks),
    resist: mask(src.resist),
    vuln: mask(src.vuln),
    immune: mask(src.immune),
    placeholder: src.placeholder,
    fidelity: src.fidelity,
    unimplemented,
    items: [],
    startHands: [-1, -1],
    resMax: acts && acts.pools.length > 0 ? [...NO_RES, ...acts.pools.map((p) => p.max)] : NO_RES,
    effects: acts ? [...acts.effects] : [],
    spells: [],
    features: acts ? [...acts.features] : [],
    pools: acts ? [...acts.pools] : [],
    skillMod: NO_SKILLS,
    flags: {},
    ...(src.conditionImmune ? { condImmune: condMask(src.conditionImmune) } : {}),
    ...(acts && acts.rechargeUse.length > 0 ? { rechargeUse: [...acts.rechargeUse] } : {}),
  });
}

/**
 * W1 (docs/design/w1-plan.md P7, key bits): does a feature or spell this PC has carry a roll-key
 * pattern that names an attack's ability or its weapon or unarmed source (d20.attack.str,
 * d20.attack.weapon)? Only then do its weapon attacks carry their ability and source
 * (CompiledAttack.ab, src) for their roll keys, so every other template keeps its hash and its
 * keys (C3). Read from the sources: the attacks are bound into programs before the effects are.
 * [U] An incoming mod on another creature that names an attacker's ability isn't scanned; nothing
 * in W1 needs it.
 */
function namesAttackKeyBits(src: PcSource, lib: Library): boolean {
  const pats: string[] = [];
  const scan = (effects: readonly { readonly mods: readonly { readonly on: readonly string[] }[] }[]): void => {
    for (const e of effects) for (const m of e.mods) pats.push(...m.on);
  };
  for (const fid of src.features) {
    const d = lib.features.get(fid);
    if (d?.ok) scan(d.src.effects);
  }
  for (const cs of src.casting) {
    for (const id of [...cs.cantrips, ...cs.prepared, ...cs.always, ...cs.free.map((f) => f.spell)]) {
      const d = lib.spells.get(id);
      if (d?.ok) scan(d.src.effects);
    }
  }
  return pats.some((p) => {
    let k: { mask: number; val: number };
    try {
      k = compileKeyPattern(p);
    } catch {
      return false; // reported at the item's own file
    }
    return (k.mask & RK.KIND) === RK.KIND && (k.val & RK.KIND) === RK.attack && (k.mask & (RK.AB | RK.weapon | RK.unarmed)) !== 0;
  });
}

/** A PC weapon's ability modifier: finesse takes the higher of STR and DEX. */
export function weaponMod(ability: 'str' | 'dex' | 'finesse', mods: readonly number[]): number {
  if (ability === 'str') return mods[0]!;
  if (ability === 'dex') return mods[1]!;
  return Math.max(mods[0]!, mods[1]!);
}

/**
 * scale: the class table's columns at this PC's level (@scale.<column> and @scale.<owner>.<column>);
 * none for a kind: pc. scaleAmbiguous: short names a character's owners share (PcBindings).
 */
export function compilePc(
  src: PcSource,
  c: ItemCtx,
  lib: Library = EMPTY_LIBRARY,
  scale?: ScaleBindings,
  scaleAmbiguous?: Readonly<Record<string, readonly string[]>>,
): CompiledTemplate | null {
  const startErrors = c.errors.length;
  const tplId = src.id as Id;
  const mods = ABILITIES.map((a) => abilityMod(src.abilities[a]));
  const pb = src.pb ?? proficiencyBonus(src.level);
  const bind: PcBindings = { pb, level: src.level, mods, scale, scaleAmbiguous };

  const gear: GearItem[] = [];
  const attacks: CompiledAttack[] = [];
  const authoredIndex: number[] = [];
  // M3 step 5a (WATK noAbilityToDamage): each attack's damage with the ability modifier left out
  // unless it's negative, aligned with `attacks`. Kept beside the template, never in it (C3).
  const noAbilityDamage: (readonly CompiledDamage[])[] = [];
  // M3 step 5a (RIDER): what each attack's rider filters look at, aligned with `attacks` (compile-time only).
  const info: RiderAttackInfo[] = [];
  const abilityBits = (ab: 'str' | 'dex' | 'finesse'): number =>
    ab === 'str' ? 1 : ab === 'dex' ? 2 : (mods[0]! >= mods[1]! ? 1 : 0) | (mods[1]! >= mods[0]! ? 2 : 0); // finesse: the higher (either on a tie)
  const quiet = (): ItemCtx => ({ doc: c.doc, prefix: c.prefix, errors: [], warnings: [] });
  // M3 step 5b: under heldWeapons each weapon is a hand item after the authored items (so their
  // indices don't move) and its attacks need it in hand; the properties below apply only then.
  const heldMode = src.heldWeapons === true;
  const weaponItem = (i: number): number => src.items.length + i;
  // Weapon +N (magicWeapon stat on a listed feature): +N to attack and damage rolls with that weapon.
  const magicBonus = (w: PcSource['weapons'][number], i: number): number => {
    if (w.magic === undefined) return 0;
    if (!src.features.includes(w.magic)) {
      errorAt(c, ['weapons', i, 'magic'], `${w.magic} isn't among this character's features: list the magic item there too`);
      return 0;
    }
    const def = lib.features.get(w.magic);
    if (!def) return 0; // reported as a missing feature by compileCasting
    let n = 0;
    for (const id of def.src.passive?.effects ?? []) {
      const e = def.src.effects.find((x) => x.id === id);
      for (const st of e?.stats ?? []) if ('magicWeapon' in st) n += st.magicWeapon;
    }
    if (n === 0) errorAt(c, ['weapons', i, 'magic'], `${w.magic} has no passive magicWeapon stat: it isn't a magic weapon's bonus`);
    return n;
  };
  src.weapons.forEach((w, i) => {
    const am = weaponMod(w.ability, mods);
    // Monk weapons: Simple Melee weapons, and Martial Melee weapons with the Light property (srd-raw.txt:11076-11084).
    const monkWeapon = w.kind === 'melee' && (w.category === 'simple' || (w.category === 'martial' && w.light === true));
    const plus = magicBonus(w, i);
    const toHit = am + (w.proficient ? pb : 0) + w.bonus + plus;
    const withPlus = (parts: typeof w.damage): typeof w.damage => (plus === 0 ? parts : parts.map((d, j) => (j === 0 ? { ...d, roll: `${d.roll} + ${plus}` } : d)));
    const dmgSrc = withPlus(w.damage);
    const damage = compileDamage(c, ['weapons', i, 'damage'], dmgSrc, { mod: am }, 'PC weapon rolls may use @mod');
    if (!damage) return;
    const bare = compileDamage(quiet(), ['weapons', i, 'damage'], dmgSrc, { mod: Math.min(0, am) }, '') ?? damage;
    let modes: Mode[];
    if (w.kind === 'ranged') {
      // A counted ranged weapon is thrown whole (darts): each attack uses one up. Under heldWeapons,
      // Ammunition is counted the same way: "Each attack expends one piece of ammunition" (srd-raw.txt:20317-20318).
      let g = -1;
      if (w.count !== undefined || (heldMode && w.ammunition !== undefined)) {
        g = gear.length;
        gear.push(w.count !== undefined ? { name: w.name, count: w.count } : { name: `${w.name} ammunition`, count: w.ammunition! });
      }
      modes = [{ local: w.id, name: w.name, kind: 'ranged', reachFt: 0, normalFt: w.range![0], longFt: w.range![1], gear: g, consumesGear: g >= 0 }];
    } else if (w.thrownRange !== undefined) {
      let g = -1;
      if (w.count !== undefined) {
        g = gear.length;
        gear.push({ name: w.name, count: w.count });
      }
      modes = bothModes(w.id, w.name, w.reach ?? 5, w.thrownRange, g, g >= 0);
    } else {
      modes = [{ local: w.id, name: w.name, kind: 'melee', reachFt: w.reach ?? 5, normalFt: 0, longFt: 0, gear: -1, consumesGear: false }];
    }
    // W1 (P6): the weapon's Finesse property and whether it's a Ranged weapon (its kind, so a thrown Handaxe isn't), compile-time only.
    const info0: RiderAttackInfo = { kind: 'melee', unarmed: false, spell: false, abilities: abilityBits(w.ability), monkWeapon, weapon: w.id, ...(w.ability === 'finesse' ? { finesse: true } : {}), ...(w.kind === 'ranged' ? { rangedWeapon: true } : {}) };
    if (!heldMode) {
      for (const m of modes) {
        authoredIndex.push(i);
        attacks.push(attack(tplId, m, toHit, damage));
        noAbilityDamage.push(bare);
        info.push({ ...info0, kind: m.kind });
      }
      return;
    }
    // SRD 5.2.1 Weapon Properties (srd-raw.txt): Heavy, "Disadvantage on attack rolls with a Heavy
    // weapon if it's a Melee weapon and your Strength score isn't at least 13 or if it's a Ranged
    // weapon and your Dexterity score isn't at least 13" (20334-20337); Two-Handed, "requires two
    // hands when you attack with it" (20396-20397); Ammunition, "you need a free hand to load a
    // one-handed weapon" (20319-20320); Thrown, "you can draw that weapon as part of the attack"
    // (20387-20389), and a thrown weapon leaves the hand; Loading (20355-20358).
    const heavyDis = w.heavy === true && (w.kind === 'ranged' ? src.abilities.dex : src.abilities.str) < 13;
    const base: Held = {
      item: weaponItem(i),
      ...(w.twoHanded || w.ammunition !== undefined ? { twoHands: true as const } : {}),
      ...(w.loading ? { loading: true as const } : {}),
      ...(heavyDis ? { heavyDis: true as const } : {}),
    };
    for (const m of modes) {
      const throws = m.kind === 'ranged' && (w.kind === 'melee' || w.count !== undefined);
      authoredIndex.push(i);
      attacks.push(attack(tplId, m, toHit, damage, { ...base, ...(throws ? { throws: true as const } : {}) }));
      noAbilityDamage.push(bare);
      info.push({ ...info0, kind: m.kind });
    }
    if (w.versatile !== undefined) {
      // Versatile: "The weapon deals that damage when used with two hands to make a melee attack" (20401-20404).
      const vSrc = withPlus([{ ...w.damage[0]!, roll: w.versatile }, ...w.damage.slice(1)]);
      const vDmg = compileDamage(c, ['weapons', i, 'versatile'], vSrc, { mod: am }, 'PC weapon rolls may use @mod');
      if (!vDmg) return;
      const vBare = compileDamage(quiet(), ['weapons', i, 'versatile'], vSrc, { mod: Math.min(0, am) }, '') ?? vDmg;
      const m: Mode = { local: `${w.id}-two-handed`, name: `${w.name} (two-handed)`, kind: 'melee', reachFt: w.reach ?? 5, normalFt: 0, longFt: 0, gear: -1, consumesGear: false };
      authoredIndex.push(i);
      attacks.push(attack(tplId, m, toHit, vDmg, { ...base, twoHands: true }));
      noAbilityDamage.push(vBare);
      info.push({ ...info0, kind: 'melee' });
    }
  });
  if (src.unarmedStrike) {
    // A feature's Unarmed Strike (Martial Arts): the chosen ability for attack and damage, its own die.
    const u = src.unarmedStrike;
    const am = weaponMod(u.ability, mods);
    const parts = [{ roll: u.damage, type: 'bludgeoning' as const, ifAdvantage: false }];
    const damage = compileDamage(c, ['unarmedStrike', 'damage'], parts, { mod: am }, 'an Unarmed Strike roll may use @mod');
    const bare = compileDamage(quiet(), ['unarmedStrike', 'damage'], parts, { mod: Math.min(0, am) }, '');
    if (damage) {
      attacks.push({ ...unarmedStrike(am, pb), damage });
      noAbilityDamage.push(bare ?? damage);
      info.push({ kind: 'melee', unarmed: true, spell: false, abilities: abilityBits(u.ability), monkWeapon: false });
    }
  } else {
    attacks.push(unarmedStrike(mods[0]!, pb));
    // The glossary's 1 + STR (srd-raw.txt:34505-34507) without a positive STR is 1, at least 0.
    noAbilityDamage.push(unarmedStrike(Math.min(0, mods[0]!), pb).damage);
    info.push({ kind: 'melee', unarmed: true, spell: false, abilities: 1, monkWeapon: false });
  }
  checkUniqueLocals(c, attacks, 'weapons', authoredIndex);

  // M3 step 5b: the core weapon rules as features (content/weapons.ts), appended after the PC's
  // own (so their riders and families come after every existing one): a mastery feature per
  // mastered weapon, and the Light property's extra attack when it holds two Light weapons.
  const synth: FeatureSource[] = [];
  if (src.masteries) {
    src.weapons.forEach((w) => {
      const m = masteryActive(src, w);
      if (m === null) return;
      const ab = weaponAbility(w, mods);
      const f = masteryFeature(w, m, ab, mods[ABILITIES.indexOf(ab)]!);
      if (f) synth.push(f);
    });
  }
  if (heldMode && lightWeaponCount(src.weapons) >= 2) {
    synth.push(lightFeature(src.weapons.filter((w) => w.light === true && masteryActive(src, w) === 'nick')));
  }
  let csrc = src;
  let clib = lib;
  if (synth.length > 0) {
    const features = new Map<string, FeatureDef>(lib.features);
    for (const f of synth) {
      const qc = quiet();
      const def = checkFeature(f, qc);
      if (!def.ok) throw new Error(`internal: ${src.id}'s ${f.id} doesn't compile: ${qc.errors.map((d) => d.message).join('; ')}`);
      features.set(f.id, def);
    }
    clib = { ...lib, features };
    csrc = { ...src, features: [...src.features, ...synth.map((f) => f.id)] };
  }
  // RIDER: each attack names the riders its filter takes (only when the PC has riders, C3).
  const plan = riderPlan(csrc, clib);
  if (plan.length > 0) {
    for (let i = 0; i < attacks.length; i++) {
      const lists = riderLists(plan, info[i]!);
      if (lists.onHit || lists.onMiss) attacks[i] = { ...attacks[i]!, ...lists };
    }
  }
  // W1 (P7, key bits): a weapon attack's ability (finesse: the higher, STR on a tie) and its weapon
  // source, only when this PC's content names one in a roll-key pattern. The authored attacks come
  // first, aligned with authoredIndex; the Unarmed Strike's bits come from its own flag (attackKeyOf).
  if (namesAttackKeyBits(csrc, clib)) {
    for (let i = 0; i < authoredIndex.length; i++) attacks[i] = { ...attacks[i]!, ab: ABILITIES.indexOf(weaponAbility(src.weapons[authoredIndex[i]!]!, mods)), src: 'weapon' };
  }

  // Items and what each hand starts with.
  const items: ItemDef[] = [];
  src.items.forEach((it, i) => {
    if (items.some((x) => x.local === it.id)) errorAt(c, ['items', i, 'id'], `item id "${it.id}" is used twice`);
    items.push({ local: it.id, name: it.name, kind: it.kind, focusFor: it.focusFor, shieldAc: it.shieldAc, ...(it.magic !== undefined ? { magic: it.magic } : {}) });
  });
  if (heldMode) {
    src.weapons.forEach((w, i) => {
      if (items.some((x) => x.local === w.id)) errorAt(c, ['weapons', i, 'id'], `weapon id "${w.id}" is also an item's id: a hand names one or the other`);
      items.push({ local: w.id, name: w.name, kind: 'weapon', focusFor: [], shieldAc: 0, ...(w.light ? { light: true as const } : {}), ...(w.magic !== undefined ? { magic: w.magic } : {}) });
    });
  }
  const hands = src.hands.map((h, i) => {
    if (h === null) return -1;
    const j = items.findIndex((x) => x.local === h);
    if (j < 0) errorAt(c, ['hands', i], heldMode ? `no item or weapon "${h}"` : `no item "${h}" in items`);
    return j;
  }) as [number, number];
  if (hands[0] >= 0 && hands[0] === hands[1]) errorAt(c, ['hands', 1], `one item can't be in both hands`);

  // Resources: slots L1..L9, then pools.
  const pools: PoolDef[] = [];
  src.pools.forEach((pl, i) => {
    if (pools.some((x) => x.local === pl.id)) errorAt(c, ['pools', i, 'id'], `pool id "${pl.id}" is used twice`);
    pools.push({ local: pl.id, name: pl.name, max: poolMax(c, ['pools', i, 'max'], pl.max, bind), recharge: pl.recharge });
    // Recovery is metadata (hard rule 4); an amount expression is still checked against the PC's variables.
    if (typeof pl.recharge !== 'string') {
      pl.recharge.forEach((r, j) => {
        if (typeof r.amount === 'string' && r.amount !== 'all') poolMax(c, ['pools', i, 'recharge', j, 'amount'], r.amount, bind);
      });
    }
  });
  const slots = [...src.slots, ...NO_RES].slice(0, 9);
  const resMax = [...slots, ...pools.map((pl) => pl.max)];

  const skillMod = SKILLS.map(([name, ab]) => {
    const prof = src.skills.expertise.includes(name) ? 2 * pb : src.skills.proficient.includes(name) ? pb : 0;
    const bonus = src.skills.bonus.reduce((n, b) => (b.skill === name ? n + b.add : n), 0);
    return mods[ABILITIES.indexOf(ab)]! + prof + bonus;
  });

  const noAbility = attacks.map((a, i): CompiledAttack => ({ ...a, damage: noAbilityDamage[i] ?? a.damage }));
  const cast = compileCasting(csrc, c, clib, { pb, level: src.level, mods, scale, scaleAmbiguous, items, pools, resMax, attacks, noAbility, ...(plan.length > 0 ? { riderPlan: plan } : {}) });

  if (c.errors.length > startErrors) return null;
  assertNoSpellAttacks(attacks);
  const initMod = src.initiativeBonus ?? mods[1]!;
  return deepFreeze({
    id: tplId,
    kind: 'pc',
    name: src.name,
    source: src.source,
    size: SIZES.indexOf(src.size),
    ac: src.ac,
    hpMax: src.hpMax,
    hpFormula: null,
    speedFt: src.speed,
    scores: ABILITIES.map((a) => src.abilities[a]),
    saveMod: ABILITIES.map((a, i) => mods[i]! + (src.saveProficiencies.includes(a) ? pb : 0)),
    initMod,
    initScore: 10 + initMod,
    pb,
    attacks,
    attackAct: {
      name: 'Attack',
      multi: false,
      extraAttack: src.extraAttacks > 0,
      alts: [[{ count: 1 + src.extraAttacks, from: allIndices(attacks.length) }]],
    },
    options: [...CORE_OPTIONS],
    gear,
    oaReachFt: oaReach(attacks),
    resist: mask(src.resist) | cast.resist,
    vuln: mask(src.vuln),
    immune: mask(src.immune),
    placeholder: src.placeholder,
    fidelity: src.fidelity,
    unimplemented: [...src.unimplemented, ...cast.unimplemented],
    items,
    startHands: hands,
    resMax,
    effects: cast.effects,
    spells: cast.spells,
    features: cast.features,
    pools,
    skillMod,
    flags: { ...src.flags },
    ...(src.armor !== undefined ? { armor: src.armor } : {}),
    ...(cast.riders.length > 0 ? { riders: cast.riders } : {}),
  });
}
