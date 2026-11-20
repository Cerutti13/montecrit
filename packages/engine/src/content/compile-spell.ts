// Spells, features and their effects -> bound programs (M1b).
//
// A spell compiles once into a CompiledSpell (what it is) and its program is checked once,
// at its own file. Each caster then binds it per (casting source, cast level): @mod, the
// source's DC and to-hit, the cantrip tier and the upcast dice fold into Steps, and every
// effect the program reaches becomes a BoundEffect appended to the caster's tpl.effects,
// so Step.apply.fx, SpellEntry.instance and CompiledFeature.activate.root all index it.
// Features bind the same way with their spellAbility. Problems are reported once, at the
// spell or feature file; a caster's file only gets the problems that are its own (a pool
// or item it doesn't define, a spell it lists that doesn't exist yet).

import { evalConstant, isConstant, type ExprBinding, type ExprEnv, type ExprNode } from '../dice/expr.ts';
import { shapeKey } from '../grid/area.ts';
import { PC_VARS, compileRoll, critExtraAt, errorAt, exprMean, floorMean, foldExpr, pcEnv, standInEnv, warnAt, withMod, type ItemCtx, type PcBindings, type ScaleBindings } from './compile.ts';
import { RK, compileKeyPattern, saveKey, skillIndex } from './rollkeys.ts';
import type { ActivateSrc, ConditionSrc, DamageRollSrc, EffectSrc, FeatureSource, GateSrc, MonsterSource, PcSource, RiderSrc, SpellSource, StatSrc, StepSrc, WeaponAttackSrc } from './schema.ts';
import { COND } from '../sim/state.ts';
import {
  ABILITIES,
  DAMAGE_TYPES,
  END,
  HOOK,
  SUSTAIN,
  SIZES,
  damageBit,
  type AreaFrom,
  type BoundEffect,
  type CompiledActivation,
  type CompiledAttack,
  type CompiledDamage,
  type CompiledFeature,
  type CompiledGrant,
  type CompiledHook,
  type CompiledInitHook,
  type CompiledMod,
  type CompiledRider,
  type CompiledSpell,
  type CompiledStat,
  type CompiledTemplate,
  type Duration,
  type Gate,
  type Id,
  type ItemDef,
  type PoolDef,
  type RiderOpt,
  type SpellEntry,
  type Step,
} from './types.ts';
import type { YamlPath } from './yaml.ts';

/** A spell as loaded: its compiled facts, its validated source, and whether it checked out. */
export interface SpellDef {
  readonly src: SpellSource;
  readonly spell: CompiledSpell;
  readonly ok: boolean;
}

export interface FeatureDef {
  readonly src: FeatureSource;
  readonly ok: boolean;
}

/** Spells and features available to casters, plus every loaded id's kind (for wrong-kind errors). */
export interface Library {
  readonly spells: ReadonlyMap<string, SpellDef>;
  readonly features: ReadonlyMap<string, FeatureDef>;
  readonly kinds: ReadonlyMap<string, string>;
}

export const EMPTY_LIBRARY: Library = { spells: new Map(), features: new Map(), kinds: new Map() };

/** res index of the first pool: slots L1..L9 sit at 0..8. */
export const POOL_BASE = 9;

/** The local part of an id: 'srd:moonbeam' -> 'moonbeam'. */
export const localOf = (id: string): string => id.slice(id.indexOf(':') + 1);

const ZONE_HOOKS = HOOK.appear | HOOK.movedOnto | HOOK.enter | HOOK.travel | HOOK.turnEndIn;
const BEARER_HOOKS = HOOK.turnStart | HOOK.turnEnd | HOOK.damaged;
const INSTANCE_LOCAL = 'concentration';

/** Cantrip damage dice multiply by this at character levels 5, 11 and 17 (SRD 5.2.1 p.104). */
export function cantripTier(charLevel: number): number {
  return charLevel >= 17 ? 4 : charLevel >= 11 ? 3 : charLevel >= 5 ? 2 : 1;
}

/** Multiplies every dice count by k (cantrip tiers); constants stay. */
function scaleDice(node: ExprNode, k: number): ExprNode {
  switch (node.k) {
    case 'dice':
      if (node.keep) throw new RangeError('keep-dice can\'t scale by cantrip tier');
      return { k: 'dice', n: node.n * k, sides: node.sides };
    case 'const':
    case 'var':
      return node;
    case 'min':
    case 'max':
      if (isConstant(node)) return node;
      throw new RangeError(`${node.k}() with dice can't scale by cantrip tier`);
    case 'vdice':
      throw new RangeError('internal: an unbound dice count reached cantrip scaling');
    case 'neg':
      return { k: 'neg', a: scaleDice(node.a, k) };
    case 'add':
    case 'sub':
      return { k: node.k, a: scaleDice(node.a, k), b: scaleDice(node.b, k) };
    case 'mul':
      return isConstant(node.a) ? { k: 'mul', a: node.a, b: scaleDice(node.b, k) } : { k: 'mul', a: scaleDice(node.a, k), b: node.b };
  }
}

/** k copies of an expression (upcast dice per slot level above): dice counts and constants both scale. */
function scaleAll(node: ExprNode, k: number): ExprNode {
  switch (node.k) {
    case 'dice':
      if (node.keep) throw new RangeError('keep-dice can\'t be upcast');
      return { k: 'dice', n: node.n * k, sides: node.sides };
    case 'const':
      return { k: 'const', v: node.v * k };
    case 'var':
      return node;
    case 'min':
    case 'max':
      throw new RangeError(`${node.k}() can't be upcast`);
    case 'vdice':
      throw new RangeError('internal: an unbound dice count reached upcasting');
    case 'neg':
      return { k: 'neg', a: scaleAll(node.a, k) };
    case 'add':
    case 'sub':
      return { k: node.k, a: scaleAll(node.a, k), b: scaleAll(node.b, k) };
    case 'mul':
      return isConstant(node.a) ? { k: 'mul', a: node.a, b: scaleAll(node.b, k) } : { k: 'mul', a: scaleAll(node.a, k), b: node.b };
  }
}

interface Term {
  readonly sign: 1 | -1;
  readonly node: ExprNode;
}

function terms(node: ExprNode, sign: 1 | -1, out: Term[]): void {
  if (node.k === 'add') {
    terms(node.a, sign, out);
    terms(node.b, sign, out);
  } else if (node.k === 'sub') {
    terms(node.a, sign, out);
    terms(node.b, sign === 1 ? -1 : 1, out);
  } else if (node.k === 'neg') terms(node.a, sign === 1 ? -1 : 1, out);
  else out.push({ sign, node });
}

/** 2d10 + 1d10 -> 3d10 (plain added dice of one size merge at the first one); constants fold last. */
export function mergeDice(node: ExprNode): ExprNode {
  const ts: Term[] = [];
  terms(node, 1, ts);
  const out: Term[] = [];
  for (const t of ts) {
    const d = t.node;
    if (d.k === 'dice' && !d.keep && t.sign === 1) {
      const j = out.findIndex((o) => o.sign === 1 && o.node.k === 'dice' && !o.node.keep && o.node.sides === d.sides);
      if (j >= 0) {
        const o = out[j]!.node as { k: 'dice'; n: number; sides: number };
        out[j] = { sign: 1, node: { k: 'dice', n: o.n + d.n, sides: d.sides } };
        continue;
      }
    }
    out.push(t);
  }
  let acc: ExprNode | null = null;
  for (const t of out) {
    if (acc === null) acc = t.sign === 1 ? t.node : { k: 'neg', a: t.node };
    else acc = t.sign === 1 ? { k: 'add', a: acc, b: t.node } : { k: 'sub', a: acc, b: t.node };
  }
  return foldExpr(acc ?? { k: 'const', v: 0 }, {});
}

/** A zone's shape key. `width` and `includesOrigin` exist only on their own forms, so every other key is the number it always was. */
export function zoneShapeKey(z: NonNullable<EffectSrc['zone']>): number {
  switch (z.shape) {
    case 'sphere':
    case 'cylinder':
      return shapeKey(z.shape, z.radius);
    case 'line':
      return shapeKey('line', z.size, z.width);
    case 'emanation':
      return shapeKey('emanation', z.size, undefined, z.includesOrigin);
    default:
      return shapeKey(z.shape, z.size);
  }
}

/** The stated model limit on an aimed area (docs/design/step7-plan.md 7.1), printed where the spell or feature lists what isn't modeled. */
export const AIM_LIMIT = 'aimed in 8 directions at 45 degrees, where the text lets its creator choose any direction (a Cube from Self: 8 of its legal placements)';

/** A zone that starts from its creator: only at range self. Every other zone, at any range, stays on the lattice. */
function areaFromOf(z: NonNullable<EffectSrc['zone']>, range: unknown): AreaFrom | undefined {
  if (range !== 'self') return undefined;
  if (z.shape === 'emanation') return 'bearer';
  return z.shape === 'sphere' || z.shape === 'cylinder' ? undefined : 'aim';
}

/** The checks an area's zone needs for the range it's placed at. */
function checkAreaForm(c: ItemCtx, path: YamlPath, e: EffectSrc, z: NonNullable<EffectSrc['zone']>, range: unknown): void {
  if (range !== 'self' && (z.shape === 'cone' || z.shape === 'line' || z.shape === 'emanation')) errorAt(c, path, `a ${z.shape} starts from its creator: its range must be self (${e.id})`);
  // moveZone moves a lattice anchor; nothing in the SRD moves an aimed area or moves an Emanation any way but with its creator.
  if (areaFromOf(z, range) && JSON.stringify(e).includes('"moveZone"')) errorAt(c, path, `${e.id} starts from its creator, so moveZone can't move it`);
}

function duration(d: EffectSrc['duration']): Duration {
  if (d === 'parent') return { k: 'parent' };
  if ('rounds' in d) return { k: 'rounds', n: d.rounds };
  if ('minutes' in d) return { k: 'rounds', n: d.minutes * 10 };
  // W1 (P11): endOfThisTurn ends at the end of the current turn (Steady Aim); sim/steps.ts expiryOf anchors it.
  if (d.until === 'endOfThisTurn') return { k: 'untilTurn', edge: 'end', of: d.of === 'caster' ? 'owner' : 'bearer', thisTurn: true };
  return { k: 'untilTurn', edge: d.until === 'startOfNextTurn' ? 'start' : 'end', of: d.of === 'caster' ? 'owner' : 'bearer' };
}

/** A hook moves creatures or zones or applies effects: simultaneous handlers' order can matter. */
function interacts(steps: readonly Step[]): boolean {
  return steps.some((s) => {
    switch (s.k) {
      case 'forced':
      case 'moveZone':
      case 'apply':
      case 'condition':
      case 'condSave':
      case 'endSource':
      case 'extendSource':
      case 'endConditions':
        return true;
      case 'attack':
        return interacts(s.onHit) || interacts(s.onMiss);
      case 'save':
        return interacts(s.onFail) || interacts(s.onSuccess);
      case 'choose':
        return s.opts.some((o) => interacts(o.steps));
      default:
        return false;
    }
  });
}

/** What's being bound: a spell at one cast level, or a feature. */
interface Owner {
  readonly id: string;
  readonly what: 'spell' | 'feature';
  readonly effects: readonly EffectSrc[];
  readonly sid: number;
  /** Cast level (0 for cantrips and features). */
  readonly lvl: number;
  /** The spell's own level: upcast dice add per level above it. */
  readonly base: number;
  /** Which of its effects are areas that start from the creator (BoundEffect zone.from). */
  readonly areaFrom: (local: string) => AreaFrom | undefined;
}

/** The caster's numbers. mod is null for a feature without spellAbility. */
interface Nums {
  readonly mod: number | null;
  readonly pb: number;
  readonly charLevel: number;
  /** Every other variable a roll may name (PC_VARS): the caster's, or stand-ins at the item's own file. */
  readonly env: (name: string) => ExprBinding | undefined;
  /** M3 step 5a: the character's attacks and pools, for weaponAttack and pool steps; undefined at the item's own file (stand-ins). */
  readonly pc?: PcRefs;
  /** M3 step 5a (RIDER): the rider lists a spell attack bound here gets (its casting ability is `ability`); undefined when the PC has no riders. */
  readonly riders?: { readonly plan: readonly RiderPlanEntry[]; readonly ability: number };
  /** M3 step 5b: tpl.items index of the item this feature is (an item whose magic names it), for itemHeld gates; undefined = none. */
  readonly held?: number;
  /** Coverage step 7.6: a monster action's program: its saves carry their printed DC. */
  readonly monster?: true;
  /**
   * W1 (P3): binds a qualified selfHas id ('<feature id>#<effect>') to that feature's effect in this
   * PC's tpl.effects, or -1 when the PC doesn't have the feature. undefined at the item's own file,
   * where a qualified gate binds to -1 with no error.
   */
  readonly qual?: (q: string, p: YamlPath) => number;
}

/** What a PC's feature steps resolve against (M3 step 5a). */
export interface PcRefs {
  /** tpl.attacks of the PC, in order (the Unarmed Strike last). */
  readonly attacks: readonly CompiledAttack[];
  /** The same attacks with the ability modifier left out of their damage unless negative (noAbilityToDamage). */
  readonly noAbility: readonly CompiledAttack[];
  /** res index of a pool by its local id, or -1. */
  poolRes(local: string): number;
  /** M3 step 5b: the PC's items (a held weapon's Light property), for lightExtra strikes. */
  readonly items?: readonly ItemDef[];
}

/** What the steps at this point can rely on. */
interface Cx {
  /** The frame has targets (after a target step, inside a branch, or in a zone or bearer hook). */
  targets: boolean;
  /** The frame has a root effect, so duration: parent has something to end with. */
  root: boolean;
  /** Inside a grant or hook of a zone effect (moveZone moves it). */
  zone: boolean;
  /** A chooseSkill ran earlier (Fx.param is set). */
  skill: boolean;
  /** Names a spell attack takes here: the spell, the grant, the hook's effect, the activation. */
  label: { readonly id: string; readonly local: string; readonly name: string };
  /** Inside an attack's onHit/onMiss: one damage step, paired with the attack slot. */
  branch: boolean;
  /** The branch's damage-step count, shared with nested choose options (counted as the max over options). */
  dmg?: { n: number };
  /** A spell's own program, which runs after its area is placed: only here can apply to: point place a zone. */
  place?: boolean;
  /** W1 (P1): inside a grant or hook of an effect, so extendSource has an effect to extend. */
  source?: boolean;
  /** W1 (P4): the top level of an on: hit rider's option, where a damage part may take type: weapon. Never inherited by nested steps. */
  weaponType?: boolean;
}

type DamageStep = Extract<Step, { k: 'damage' }>;

class Binder {
  readonly #bound = new Map<string, number>();
  /** Effect locals the program reached. */
  readonly used = new Set<string>();
  readonly #c: ItemCtx;
  readonly #n: Nums;
  readonly #o: Owner;
  readonly #out: BoundEffect[];
  /** Condition steps seen per condition, for unique locals. */
  readonly #condN = new Map<string, number>();

  /** Where this binder reports (bindRider's option checks). */
  get ctx(): ItemCtx {
    return this.#c;
  }

  constructor(c: ItemCtx, n: Nums, o: Owner, out: BoundEffect[]) {
    this.#c = c;
    this.#n = n;
    this.#o = o;
    this.#out = out;
  }

  #vars(): ExprEnv {
    return withMod(this.#n.mod, this.#n.env);
  }

  #hint(): string {
    return this.#n.mod === null
      ? `a feature's rolls may use ${PC_VARS}, and @mod only when it sets spellAbility`
      : `spell rolls may use @mod (the spellcasting ability modifier) and ${PC_VARS}`;
  }

  #roll(p: YamlPath, src: string): ExprNode | null {
    return compileRoll(this.#c, p, src, this.#vars(), this.#hint())?.roll ?? null;
  }

  #toHit(p: YamlPath): number {
    if (this.#n.mod === null) {
      errorAt(this.#c, p, 'a spell attack needs a spellcasting ability: set spellAbility on the feature');
      return 0;
    }
    return this.#n.pb + this.#n.mod;
  }

  #dc(p: YamlPath): number {
    if (this.#n.monster) {
      errorAt(this.#c, p, 'a monster action\'s save needs its printed dc');
      return 0;
    }
    if (this.#n.mod === null) {
      errorAt(this.#c, p, 'a save DC needs a spellcasting ability: set spellAbility on the feature');
      return 0;
    }
    return 8 + this.#n.pb + this.#n.mod;
  }

  /** roll, times the cantrip tier when marked, plus upcast dice per slot level above. */
  #scaled(p: YamlPath, roll: string, upcast: string | undefined, cantrip: boolean): ExprNode | null {
    let node = this.#roll([...p, 'roll'], roll);
    const up = upcast === undefined ? null : this.#roll([...p, 'upcast'], upcast);
    if (!node) return null;
    try {
      if (cantrip) {
        if (this.#o.what !== 'spell' || this.#o.base !== 0) errorAt(this.#c, [...p, 'cantrip'], 'cantrip: true scales by character level, so it belongs only in a cantrip (a level 0 spell)');
        else node = scaleDice(node, cantripTier(this.#n.charLevel));
      }
      if (upcast !== undefined) {
        if (this.#o.what !== 'spell' || this.#o.base === 0) errorAt(this.#c, [...p, 'upcast'], 'upcast belongs only in a leveled spell');
        else if (up) {
          scaleAll(up, 1); // keep-dice check, even at the base level
          if (this.#o.lvl > this.#o.base) node = { k: 'add', a: node, b: scaleAll(up, this.#o.lvl - this.#o.base) };
        }
      }
      return mergeDice(node);
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      errorAt(this.#c, p, e.message);
      return null;
    }
  }

  #damage(p: YamlPath, parts: readonly DamageRollSrc[], weaponOk = false): CompiledDamage[] {
    const out: CompiledDamage[] = [];
    parts.forEach((d, j) => {
      const node = this.#scaled([...p, j], d.roll, d.upcast, d.cantrip);
      if (!node) return;
      const critExtra = critExtraAt(this.#c, [...p, j, 'roll'], node);
      if (d.type === 'weapon') {
        // W1 (P4): the attack's own type, resolved where the rider joins the hit (type -1 until then).
        if (!weaponOk) errorAt(this.#c, [...p, j, 'type'], 'type: weapon is the type of the attack a rider rides on: only the damage at the top of an on: hit rider (or of one of its options) can take it');
        out.push({ roll: node, critExtra, type: -1, avg: floorMean(exprMean(node)), ifAdvantage: false, asAttack: true });
        return;
      }
      out.push({ roll: node, critExtra, type: DAMAGE_TYPES.indexOf(d.type), avg: floorMean(exprMean(node)), ifAdvantage: false });
    });
    return out;
  }

  /**
   * A selfHas gate's effect: a local id is one of this owner's effects (bound here); a qualified
   * '<feature id>#<effect>' (W1, P3) binds through the PC (Nums.qual), or never holds without one.
   */
  gateFx(local: string, p: YamlPath): number {
    if (local.includes('#')) return this.#n.qual ? this.#n.qual(local, p) : -1;
    return this.effect(local, p);
  }

  #mod(p: YamlPath, m: EffectSrc['mods'][number]): CompiledMod {
    return {
      on: m.on.map((k) => compileKeyPattern(k)),
      side: m.side,
      op: m.op,
      value: typeof m.value === 'string' ? this.#modNum([...p, 'value'], m.value) : (m.value ?? 0),
      dice: m.dice === undefined ? null : this.#roll([...p, 'dice'], m.dice),
      consume: m.consume === 'nextRoll',
      skillParam: m.skill === 'chosen',
      ...(m.when ? { when: compileGates(m.when, this.#n.held, (l) => this.gateFx(l, [...p, 'when'])) } : {}),
      ...(m.from === 'owner' ? { ownerOnly: true as const } : {}),
    };
  }

  /** A modifier's number as a constant expression bound to this owner's numbers (`max(@mod, 1)`): an int by the time it folds. */
  #modNum(p: YamlPath, v: string): number {
    const node = this.#roll(p, v);
    if (!node) return 0;
    if (isConstant(node)) return evalConstant(node, {});
    errorAt(this.#c, p, 'a modifier\'s value is a number: it can\'t roll dice (preDice takes a die)');
    return 0;
  }

  /** A stat's number: an int, or a constant expression bound to this owner's numbers (@scale, @pb, @level...). */
  #statNum(p: YamlPath, v: number | string, field: string): number {
    let n = 0;
    if (typeof v === 'number') n = v;
    else {
      const node = this.#roll(p, v);
      if (!node) return 0;
      if (!isConstant(node)) {
        errorAt(this.#c, p, `a ${field} stat is a number: it can't roll dice`);
        return 0;
      }
      n = evalConstant(node, {});
    }
    // An expression checked at the item's own file folds stand-in numbers: only a real binding (or a literal) is range-checked.
    if (typeof v === 'string' && this.#n.env === standInEnv) return n;
    if (field === 'speed' && (n % 5 !== 0 || n === 0)) errorAt(this.#c, p, `a speed change is a nonzero multiple of 5 ft, got ${n}`);
    if (field === 'fly' && (n % 5 !== 0 || n <= 0)) errorAt(this.#c, p, `a Fly Speed is a positive multiple of 5 ft, got ${n}`);
    if (field === 'acFloor' && n < 1) errorAt(this.#c, p, `an AC floor is at least 1, got ${n}`);
    if (field === 'ac' && n === 0) errorAt(this.#c, p, 'an AC bonus of 0 does nothing');
    return n;
  }

  /**
   * A condition step's own effect (M3 step 4): the bits it imposes, its duration, its repeat
   * save (a turnEnd hook) and its escape (a grant to the bearer), bound like any effect so the
   * end cascade, expiry and the trigger queue handle it. Appended to the owner's effects.
   */
  #conditionEffect(p: YamlPath, c: ConditionSrc, cx: Cx): number {
    const n = (this.#condN.get(c.id) ?? 0) + 1;
    this.#condN.set(c.id, n);
    // Locals name the owner too: a grant's journal key is <seat>/<effect local>/<grant>, so two
    // features' escapes from the same condition must not share one.
    const own = this.#o.id.slice(Math.max(this.#o.id.lastIndexOf(':'), this.#o.id.lastIndexOf('/')) + 1);
    let local = `${own}-${c.id}${n > 1 ? `-${n}` : ''}`;
    while (this.#o.effects.some((e) => e.id === local)) local = `${local}-x`;
    const id = `${this.#o.id}/${local}`;
    const name = c.id.charAt(0).toUpperCase() + c.id.slice(1);
    if (c.until === 'parent' && !cx.root) {
      errorAt(this.#c, [...p, 'until'], 'until: parent needs something to end with (a concentration spell, a feature activation root, or the effect a hook or grant belongs to); give it a duration');
    }
    const dcOf = (dp: YamlPath, dc: number | undefined): number => (dc !== undefined ? dc : this.#dc(dp));
    const hooks: CompiledHook[] = [];
    let hookMask = 0;
    if (c.save) {
      const ability = ABILITIES.indexOf(c.save.ability);
      // A next stage runs under this condition's parent (sim/steps.ts condSave), so `cx.root` here is that one's.
      const onFail = c.save.onFail ? this.steps(c.save.onFail, [...p, 'save', 'onFail'], { ...cx, targets: true, branch: false, dmg: undefined, place: false }) : undefined;
      hooks.push({ on: HOOK.turnEnd, steps: [{ k: 'condSave', ability, key: saveKey(ability), dc: dcOf([...p, 'save'], c.save.dc), ...(onFail ? { onFail } : {}) }] });
      hookMask |= HOOK.turnEnd;
    }
    const grants: CompiledGrant[] = [];
    if (c.escape) {
      const ability = ABILITIES.indexOf(c.escape.check.ability);
      const skills = c.escape.check.skills.map((sk) => skillIndex(sk));
      const dc = dcOf([...p, 'escape'], c.escape.dc);
      grants.push({ local: 'escape', name: `Escape (${name})`, cost: 'action', laterTurns: false, to: 'bearer', steps: [{ k: 'check', ability, skills, dc, onSuccess: [{ k: 'endSource' }], onFail: [] }] });
    }
    // Stunned, Paralyzed and Unconscious each include the Incapacitated condition (srd-raw.txt:34374-34375, 33934-33935, 34525).
    let bits: number = COND[c.id];
    if (c.id === 'stunned' || c.id === 'paralyzed' || c.id === 'unconscious') bits |= COND.incapacitated;
    for (const a of c.also ?? []) bits |= COND[a];
    const idx = this.#out.length;
    this.#out.push({
      id: id as Id,
      local,
      name,
      sid: this.#o.sid,
      lvl: this.#o.lvl,
      zone: null,
      dur: duration(c.until),
      limit: 'none',
      endsOn: 0,
      inHand: false,
      group: null,
      mods: [],
      hooks,
      hookMask,
      grants,
      interacts: hooks.length > 0,
      conc: false,
      cond: bits,
      ...(c.endsOnDamage ? { endsOnDamage: true as const } : {}),
      ...(c.speed ? { stats: [{ k: 'speed' as const, mode: c.speed, n: 0 }] } : {}),
    });
    return idx;
  }

  /**
   * WATK (M3 step 5a): the attacks a weaponAttack step may use, resolved against the PC's own
   * tpl.attacks. At the item's own file (no PC) it compiles with none, so a feature checks alone.
   */
  #weaponAttack(p: YamlPath, w: WeaponAttackSrc): Step {
    const count = w.count ?? 1;
    const pc = this.#n.pc;
    // M3 step 5b: the Light extra attack and Cleave's second attack (undefined when not asked, C3).
    const extra = { ...(w.lightExtra ? { lightExtra: true as const } : {}), ...(w.near ? { near: true as const } : {}) };
    if (this.#o.what !== 'feature') errorAt(this.#c, p, 'weaponAttack makes the creature\'s own weapon attacks: it belongs in a feature');
    if (w.lightExtra && w.with === 'unarmed') errorAt(this.#c, [...p, 'lightExtra'], 'the Light property\'s extra attack is made with a Light weapon, not an Unarmed Strike');
    if (!pc) return { k: 'weaponAttack', from: [], count, noAbility: w.noAbilityToDamage ? [] : null, ...extra };
    // A Light weapon held as an item (heldWeapons): only those can make the Light extra attack.
    const light = (a: CompiledAttack): boolean => a.item !== undefined && pc.items?.[a.item]?.light === true;
    const from: number[] = [];
    pc.attacks.forEach((a, i) => {
      if (a.spell) return;
      // A weapon id names every mode of it: melee, thrown, and (M3 step 5b) a Versatile weapon's two-handed grip.
      const named = w.with === 'unarmed' ? a.unarmed : w.with === 'held' ? !a.unarmed : a.local === w.with || a.local === `${w.with}-thrown` || a.local === `${w.with}-two-handed`;
      if (!named) return;
      if (w.lightExtra && !light(a)) return;
      if (w.near && a.kind !== 'melee') return;
      from.push(i);
    });
    if (from.length === 0) {
      const what = w.lightExtra ? ' Light weapon' : w.near ? ' melee weapon' : '';
      errorAt(this.#c, [...p, 'with'], w.with === 'held' ? `this character has no${what || ' weapon'} attacks` : `this character has no${what} attack "${w.with}"`);
    }
    return { k: 'weaponAttack', from, count, noAbility: w.noAbilityToDamage ? from.map((i) => pc.noAbility[i]!) : null, ...extra };
  }

  /** POOLX (M3 step 5a): a pool change by a constant, or a refill. */
  #pool(p: YamlPath, src: { id: string; delta: number | string }): Step {
    const pc = this.#n.pc;
    let res = -1;
    if (pc) {
      res = pc.poolRes(src.id);
      if (res < 0) errorAt(this.#c, [...p, 'id'], `no pool "${src.id}" in this character's pools`);
    }
    if (src.delta === 'refill') return { k: 'pool', res, delta: 'refill' };
    let n = 0;
    if (typeof src.delta === 'number') n = src.delta;
    else {
      const node = this.#roll([...p, 'delta'], src.delta);
      if (node && !isConstant(node)) errorAt(this.#c, [...p, 'delta'], 'a pool change is a number: it can\'t roll dice');
      else if (node) n = evalConstant(node, {});
    }
    if (n === 0 && (pc || typeof src.delta === 'number')) errorAt(this.#c, [...p, 'delta'], 'a pool change of 0 does nothing');
    return { k: 'pool', res, delta: n };
  }

  /** Binds an effect (once per binder) and returns its index in the output list; -1 if unknown. */
  effect(local: string, p: YamlPath): number {
    const have = this.#bound.get(local);
    if (have !== undefined) return have;
    const i = this.#o.effects.findIndex((e) => e.id === local);
    if (i < 0) {
      errorAt(this.#c, p, `no effect "${local}" in this ${this.#o.what}'s effects`);
      return -1;
    }
    const e = this.#o.effects[i]!;
    const ep: YamlPath = ['effects', i];
    const idx = this.#out.length;
    this.#out.push(undefined as unknown as BoundEffect); // reserved: hooks may apply effects that apply this one
    this.#bound.set(local, idx);
    this.used.add(local);

    const zoneFrom = this.#o.areaFrom(e.id);
    const zone = e.zone ? { shapeKey: zoneShapeKey(e.zone), heightFt: 'height' in e.zone ? (e.zone.height ?? 0) : 0, difficult: e.zone.difficult, ...(zoneFrom ? { from: zoneFrom } : {}), ...(e.zone.affects !== undefined && e.zone.affects !== 'all' ? { affects: e.zone.affects } : {}), ...('offWhen' in e.zone && e.zone.offWhen ? { offWhenIncap: true as const } : {}) } : null;
    const label = { id: `${this.#o.id}/${e.id}`, local: e.id, name: e.name };
    const mods = e.mods.map((m, j) => this.#mod([...ep, 'mods', j], m));
    let hookMask = 0;
    const hooks: CompiledHook[] = e.on.map((h, j) => {
      const hp: YamlPath = [...ep, 'on', j];
      let on = 0;
      for (const w of h.when) on |= HOOK[w];
      hookMask |= on;
      if (on & ZONE_HOOKS && !zone) errorAt(this.#c, [...hp, 'when'], 'appear, movedOnto, enter, travel and turnEndIn are zone hooks: this effect has no zone');
      if (on & BEARER_HOOKS && zone) errorAt(this.#c, [...hp, 'when'], 'a zone sits on no creature: turnStart, turnEnd and damaged need an effect applied to a creature');
      if (on & HOOK.slotHeal && on !== HOOK.slotHeal) errorAt(this.#c, [...hp, 'when'], 'slotHeal fires for the owner, with no targets: give it its own entry');
      const steps = this.steps(h.do, [...hp, 'do'], { targets: (on & HOOK.slotHeal) === 0, root: true, zone: zone !== null, skill: false, label, branch: false, source: true });
      return { on, steps };
    });
    const grantIds = new Set<string>();
    const grants: CompiledGrant[] = e.grants.map((g, j) => {
      const gp: YamlPath = [...ep, 'grants', j];
      if (grantIds.has(g.id)) errorAt(this.#c, [...gp, 'id'], `grant id "${g.id}" is used twice in ${e.id}`);
      grantIds.add(g.id);
      const glabel = { id: `${this.#o.id}/${g.id}`, local: g.id, name: g.name };
      const steps = this.steps(g.do, [...gp, 'do'], { targets: false, root: true, zone: zone !== null, skill: false, label: glabel, branch: false, source: true });
      return { local: g.id, name: g.name, cost: g.cost, laterTurns: g.laterTurns, to: g.to, steps, ...(g.when ? { when: compileGates(g.when, this.#n.held, (l) => this.gateFx(l, [...gp, 'when'])) } : {}) };
    });
    let endsOn = 0;
    for (const x of e.endsOn) endsOn |= x === 'incapacitated' ? END.incap : END.dismiss;
    let sustain = 0;
    for (const x of e.sustain?.by ?? []) sustain |= SUSTAIN[x];
    this.#out[idx] = {
      id: label.id as Id,
      local: e.id,
      name: e.name,
      sid: this.#o.sid,
      lvl: this.#o.lvl,
      zone,
      dur: duration(e.duration),
      limit: e.oncePerTurn ?? 'none',
      endsOn,
      inHand: e.inHand,
      group: e.group === undefined ? null : `${this.#o.id}/${e.group}`,
      mods,
      hooks,
      hookMask,
      grants,
      interacts: hooks.some((h) => interacts(h.steps)),
      conc: false,
      ...(e.immune ? { condImmune: condMask(e.immune) } : {}),
      ...(e.stats ? { stats: e.stats.map((x, j) => compileStat(x, (field, v) => this.#statNum([...ep, 'stats', j, field], v, field), this.#n.held, (l) => this.gateFx(l, [...ep, 'stats', j, 'when']))) } : {}),
      ...(e.hidden ? { hiddenDc: this.#dc([...ep, 'hidden', 'dc']) } : {}),
      ...(sustain !== 0 ? { sustain } : {}),
    };
    if (e.stats && e.zone) errorAt(this.#c, [...ep, 'stats'], 'a zone sits on no creature: stats need an effect applied to a creature');
    if (e.immune && e.zone) errorAt(this.#c, [...ep, 'immune'], 'a zone sits on no creature: immune needs an effect applied to a creature');
    return idx;
  }

  steps(list: readonly StepSrc[], p: YamlPath, cx0: Cx): Step[] {
    // W1 (P4): type: weapon only at this level of an on: hit rider's option; nested steps never inherit it.
    const { weaponType: weaponOk = false, ...rest } = cx0;
    const cx: Cx = rest;
    const out: Step[] = [];
    let applied: EffectSrc | null = null;
    let appliedFx = -1;
    const c = this.#c;
    const needTargets = (sp: YamlPath, what: string) => {
      if (!cx.targets) errorAt(c, sp, `${what} needs targets: put a target step before it`);
    };
    list.forEach((s, i) => {
      const sp: YamlPath = [...p, i];
      if ('target' in s) {
        const t = s.target;
        cx.targets = true;
        out.push({ k: 'target', rangeFt: t.range === 'touch' ? 5 : t.range, who: t.who, self: t.self, maxSize: t.maxSize === undefined ? SIZES.length - 1 : SIZES.indexOf(t.maxSize) });
      } else if ('attack' in s) {
        const a = s.attack;
        const ap: YamlPath = [...sp, 'attack'];
        needTargets(ap, 'an attack');
        const toHit = this.#toHit(ap);
        const onHit = this.steps(a.onHit, [...ap, 'onHit'], { ...cx, targets: true, branch: true, dmg: { n: 0 } });
        const onMiss = this.steps(a.onMiss, [...ap, 'onMiss'], { ...cx, targets: true, branch: true, dmg: { n: 0 } });
        const dmg = onHit.find((x): x is DamageStep => x.k === 'damage');
        const atk: CompiledAttack = {
          id: cx.label.id as Id,
          local: cx.label.local,
          name: cx.label.name,
          kind: a.kind,
          rollKey: a.kind === 'melee' ? 'd20.attack.melee' : 'd20.attack.ranged',
          toHit,
          critMin: 20,
          reachFt: a.kind === 'melee' ? a.range : 0,
          normalFt: a.kind === 'ranged' ? a.range : 0,
          longFt: a.kind === 'ranged' ? a.range : 0,
          damage: dmg ? dmg.dmg : [],
          gear: -1,
          consumesGear: false,
          unarmed: false,
          spell: true,
          ...(this.#n.riders ? riderLists(this.#n.riders.plan, { kind: a.kind, unarmed: false, spell: true, abilities: 1 << this.#n.riders.ability, monkWeapon: false }) : {}),
        };
        out.push({ k: 'attack', atk, onHit, onMiss });
      } else if ('save' in s) {
        const v = s.save;
        const vp: YamlPath = [...sp, 'save'];
        needTargets(vp, 'a save');
        if (v.half && v.damage === undefined) errorAt(c, [...vp, 'half'], 'half halves damage: this save deals none');
        const ability = ABILITIES.indexOf(v.ability);
        if (v.dc !== undefined && !this.#n.monster) errorAt(c, [...vp, 'dc'], 'a printed dc is for a monster action; a spell or feature computes its DC from its ability');
        out.push({
          k: 'save',
          ability,
          key: saveKey(ability),
          dc: v.dc ?? this.#dc(vp),
          dmg: v.damage === undefined ? null : this.#damage([...vp, 'damage'], v.damage),
          half: v.half,
          onFail: this.steps(v.onFail, [...vp, 'onFail'], { ...cx, targets: true, branch: false, dmg: undefined }),
          onSuccess: this.steps(v.onSuccess, [...vp, 'onSuccess'], { ...cx, targets: true, branch: false, dmg: undefined }),
          ...(v.ignoresCover ? { ignoresCover: v.ignoresCover } : {}),
          ...(v.targetAdv ? { targetAdv: true as const } : {}),
        });
      } else if ('damage' in s) {
        needTargets(sp, 'damage');
        if (cx.branch && cx.dmg && ++cx.dmg.n > 1) errorAt(c, sp, 'one damage step per attack branch (it pairs with the attack roll\'s slot); put every part in one damage list');
        out.push({ k: 'damage', dmg: this.#damage([...sp, 'damage'], s.damage, weaponOk) });
      } else if ('heal' in s) {
        const hp: YamlPath = [...sp, 'heal'];
        needTargets(hp, 'heal');
        const roll = this.#scaled(hp, s.heal.roll, s.heal.upcast, false);
        out.push({ k: 'heal', roll: roll ?? { k: 'const', v: 0 } });
      } else if ('apply' in s) {
        const { effect, to } = s.apply;
        const ap: YamlPath = [...sp, 'apply'];
        const src = this.#o.effects.find((e) => e.id === effect);
        const fx = this.effect(effect, [...ap, 'effect']);
        if (src) {
          if (to === 'point' && !src.zone) errorAt(c, [...ap, 'to'], `apply to: point places a zone, and ${effect} has none`);
          if (to !== 'point' && src.zone) errorAt(c, [...ap, 'to'], `${effect} is a zone: apply it to: point`);
          if (to === 'target') needTargets(ap, 'apply to: target');
          if (src.duration === 'parent' && !cx.root) {
            errorAt(c, [...ap, 'effect'], `${effect} lasts duration: parent, but nothing here can be its parent (only a concentration spell, a feature activation root, or the effect a hook or grant belongs to); give it its own duration`);
          }
          if (src.mods.some((m) => m.skill === 'chosen') && !cx.skill) errorAt(c, [...ap, 'effect'], `${effect} has a skill: chosen modifier: put chooseSkill before applying it`);
        }
        if (to === 'point' && !cx.place) errorAt(c, [...ap, 'to'], 'apply to: point places an area, so it only works in a spell\'s own program or a feature activation with area (hooks and grants can\'t place zones)');
        applied = src ?? null;
        appliedFx = fx;
        // W1 (P3): gates on the owner as the step runs (Frenzy's arming needs Rage up, frenzyRageCheck).
        const when = s.apply.when ? { when: compileGates(s.apply.when, this.#n.held, (l) => this.gateFx(l, [...ap, 'when'])) } : {};
        out.push({ k: 'apply', fx, to, ...when });
      } else if ('moveZone' in s) {
        if (!cx.zone) errorAt(c, sp, 'moveZone moves the zone it belongs to: use it in a grant or hook of a zone effect');
        out.push({ k: 'moveZone', ft: s.moveZone.ft });
      } else if ('forcedMove' in s) {
        const f = s.forcedMove;
        needTargets([...sp, 'forcedMove'], 'forcedMove');
        out.push({ k: 'forced', mode: f.mode, maxFt: f.maxFt, maxSize: SIZES.indexOf(f.maxSize), ...(f.straight ? { straight: true as const } : {}), ...(f.exact ? { exact: true as const } : {}) });
      } else if ('choose' in s) {
        const ids = new Set<string>();
        // Options are exclusive: each counts its damage on top of what the branch had, and the branch keeps the most.
        const before = cx.dmg ? cx.dmg.n : 0;
        let most = before;
        const opts = s.choose.map((o, j) => {
          if (ids.has(o.id)) errorAt(c, [...sp, 'choose', j, 'id'], `option id "${o.id}" is used twice`);
          ids.add(o.id);
          const own = cx.dmg ? { n: before } : undefined;
          const steps = this.steps(o.do, [...sp, 'choose', j, 'do'], { ...cx, dmg: own });
          if (own) most = Math.max(most, own.n);
          return { local: o.id, name: o.name, steps };
        });
        if (cx.dmg) cx.dmg.n = most;
        out.push({ k: 'choose', opts });
      } else if ('chooseSkill' in s) {
        cx.skill = true;
        out.push({ k: 'chooseSkill' });
      } else if ('condition' in s) {
        const cp: YamlPath = [...sp, 'condition'];
        needTargets(cp, 'a condition');
        const cd = s.condition;
        if (cd.id === 'prone') out.push({ k: 'condition', fx: -1, bit: COND.prone });
        // Unconscious: "you drop whatever you're holding" (srd-raw.txt:34526).
        else out.push({ k: 'condition', fx: this.#conditionEffect(cp, cd, cx), bit: COND[cd.id], ...(cd.dropHeld || cd.id === 'unconscious' ? { dropHeld: true as const } : {}) });
      } else if ('tempHp' in s) {
        const tp: YamlPath = [...sp, 'tempHp'];
        needTargets(tp, 'tempHp');
        const roll = this.#roll(tp, s.tempHp);
        out.push({ k: 'tempHp', roll: roll ?? { k: 'const', v: 0 } });
      } else if ('weaponAttack' in s) {
        out.push(this.#weaponAttack([...sp, 'weaponAttack'], s.weaponAttack));
      } else if ('core' in s) {
        out.push({ k: 'core', act: s.core });
      } else if ('gainAction' in s) {
        out.push({ k: 'gainAction' });
      } else if ('pool' in s) {
        out.push(this.#pool([...sp, 'pool'], s.pool));
      } else if ('around' in s) {
        cx.targets = true;
        out.push({ k: 'around', key: shapeKey('emanation', s.around.size), sizeFt: s.around.size, who: s.around.who });
      } else if ('extendSource' in s) {
        // W1 (P1): it extends the effect whose grant or hook is running.
        if (!cx.source) errorAt(c, [...sp, 'extendSource'], 'extendSource extends the effect whose grant or hook is running: use it in an effect\'s grant (Rage\'s Bonus Action extension)');
        out.push({ k: 'extendSource' });
      } else if ('endConditions' in s) {
        out.push({ k: 'endConditions', bits: condMask(s.endConditions) });
      } else if ('move' in s) {
        if (this.#o.what !== 'feature') errorAt(c, [...sp, 'move'], 'move moves the creature using a feature: it belongs in a feature');
        out.push({ k: 'move', speed: 'half', noOpportunityAttacks: true });
      } else {
        const name = s.use;
        if (!applied) {
          errorAt(c, [...sp, 'use'], 'use fires a grant of the effect applied just before it: put an apply step first');
          return;
        }
        const gi = applied.grants.findIndex((g) => g.id === name);
        if (gi < 0) {
          errorAt(c, [...sp, 'use'], `${applied.id} grants no "${name}"`);
          return;
        }
        out.push({ k: 'use', fx: appliedFx, grant: gi });
      }
    });
    return out;
  }
}

function checkUniqueEffects(c: ItemCtx, effects: readonly EffectSrc[]): void {
  const seen = new Set<string>();
  effects.forEach((e, i) => {
    if (e.id === INSTANCE_LOCAL) errorAt(c, ['effects', i, 'id'], `effect id "${INSTANCE_LOCAL}" is reserved for the spell's concentration instance`);
    if (seen.has(e.id)) errorAt(c, ['effects', i, 'id'], `effect id "${e.id}" is used twice`);
    seen.add(e.id);
  });
}

function warnUnused(c: ItemCtx, effects: readonly EffectSrc[], used: ReadonlySet<string>): void {
  effects.forEach((e, i) => {
    if (!used.has(e.id)) warnAt(c, ['effects', i, 'id'], `effect ${e.id} is never applied`);
  });
}

function spellOwner(def: { src: SpellSource; spell: CompiledSpell }, lvl: number): Owner {
  return { id: def.spell.id, what: 'spell', effects: def.src.effects, sid: def.spell.sid, lvl, base: def.spell.level, areaFrom: (local) => (local === def.src.area ? def.spell.areaFrom : undefined) };
}

function spellCx(sp: CompiledSpell): Cx {
  return { targets: false, root: sp.conc, zone: false, skill: false, label: { id: sp.id, local: sp.local, name: sp.name }, branch: false, place: true };
}

function concRounds(src: SpellSource): number {
  const d = src.duration;
  if (typeof d === 'object' && 'minutes' in d) return d.minutes * 10;
  if (typeof d === 'object' && 'rounds' in d) return d.rounds;
  return 0;
}

/** Compiles a spell's facts with its interned sid and checks its program once, at its own file. */
export function compileSpellDef(src: SpellSource, sid: number, c: ItemCtx): SpellDef {
  const start = c.errors.length;
  const id = src.id as Id;
  if (src.components.m === 'costly') errorAt(c, ['components', 'm'], 'costly materials not modeled (a focus can\'t stand in for them)');
  if (src.duration === 'parent') errorAt(c, ['duration'], 'a spell\'s duration can\'t be parent');
  if (src.concentration && concRounds(src) === 0) errorAt(c, ['duration'], 'a concentration spell needs duration { minutes: N } or { rounds: N }');
  checkUniqueEffects(c, src.effects);

  let areaShape = -1;
  let areaFrom: AreaFrom | undefined;
  if (src.area !== undefined) {
    const e = src.effects.find((x) => x.id === src.area);
    if (!e) errorAt(c, ['area'], `area names "${src.area}", which isn't one of this spell's effects`);
    else if (!e.zone) errorAt(c, ['area'], `area ${src.area} has no zone`);
    else {
      areaShape = zoneShapeKey(e.zone);
      areaFrom = areaFromOf(e.zone, src.range);
      checkAreaForm(c, ['area'], e, e.zone, src.range);
    }
    if (!src.do.some((s) => 'apply' in s && s.apply.effect === src.area && s.apply.to === 'point')) {
      errorAt(c, ['area'], `the program never places ${src.area}: add { apply: { effect: ${src.area}, to: point } } to do`);
    }
  }
  src.do.forEach((s, i) => {
    if ('apply' in s && s.apply.to === 'point' && s.apply.effect !== src.area) {
      errorAt(c, ['do', i, 'apply', 'to'], `apply to: point places the spell's area: set area: ${s.apply.effect}`);
    }
  });

  const spell: CompiledSpell = {
    id,
    local: localOf(id),
    name: src.name,
    source: src.source,
    sid,
    level: src.level,
    cast: src.castingTime,
    v: src.components.v,
    s: src.components.s,
    m: src.components.m === 'costly' ? 'none' : src.components.m,
    conc: src.concentration,
    rangeFt: src.range === 'self' ? 0 : src.range === 'touch' ? 5 : src.range,
    areaShape,
    ...(areaFrom ? { areaFrom } : {}),
    recast: src.recast,
    createsInHand: src.effects.some((e) => e.inHand),
    fidelity: src.fidelity,
    unimplemented: areaFrom === 'aim' ? [...src.unimplemented, AIM_LIMIT] : [...src.unimplemented],
  };
  const b = new Binder(c, { mod: 0, pb: 2, charLevel: 1, env: standInEnv }, spellOwner({ src, spell }, src.level), []);
  b.steps(src.do, ['do'], spellCx(spell));
  warnUnused(c, src.effects, b.used);
  return { src, spell, ok: c.errors.length === start };
}

function featureOwner(src: FeatureSource): Owner {
  return {
    id: src.id, what: 'feature', effects: src.effects, sid: -1, lvl: 0, base: 0,
    areaFrom: (local) => {
      // A passive Emanation (coverage step 7.5) sits around its owner for the whole fight.
      if (src.passive?.effects.includes(local) && src.effects.find((e) => e.id === local)?.zone?.shape === 'emanation') return 'bearer';
      for (const { a } of activationsOf(src)) {
        const z = a.area === local ? src.effects.find((e) => e.id === local)?.zone : undefined;
        if (z) return areaFromOf(z, a.range ?? 'self');
      }
      return undefined;
    },
  };
}

/** An activation's area as compiled, when it has one with a zone. */
function activationArea(f: FeatureSource, a: ActivateSrc): NonNullable<CompiledActivation['area']> | undefined {
  const z = a.area === undefined ? undefined : f.effects.find((e) => e.id === a.area)?.zone;
  if (!z) return undefined;
  const range = a.range ?? 'self';
  const from = areaFromOf(z, range);
  return { shape: zoneShapeKey(z), ...(from ? { from } : {}), rangeFt: range === 'self' ? 0 : range };
}

/** A feature's activations, one or several (M3 step 5a), each with its YAML path. */
export function activationsOf(f: FeatureSource): { a: ActivateSrc; p: YamlPath }[] {
  const a = f.activate;
  if (!a) return [];
  return Array.isArray(a) ? a.map((x, i) => ({ a: x, p: ['activate', i] })) : [{ a, p: ['activate'] }];
}

/** An activation's range and area agree, and its program places the area. */
function checkActivationArea(c: ItemCtx, src: FeatureSource, a: ActivateSrc, ap: YamlPath): void {
  if (a.range !== undefined && a.area === undefined) errorAt(c, [...ap, 'range'], 'range is the range of an area: give area too');
  if (a.area !== undefined) {
    const e = src.effects.find((x) => x.id === a.area);
    if (!e) errorAt(c, [...ap, 'area'], `area names "${a.area}", which isn't one of this feature's effects`);
    else if (!e.zone) errorAt(c, [...ap, 'area'], `area ${a.area} has no zone`);
    else checkAreaForm(c, [...ap, 'area'], e, e.zone, a.range ?? 'self');
    if (!a.do.some((s) => 'apply' in s && s.apply.effect === a.area && s.apply.to === 'point')) errorAt(c, [...ap, 'area'], `the activation never places ${a.area}: add { apply: { effect: ${a.area}, to: point } } to do`);
  }
  a.do.forEach((s, i) => {
    if ('apply' in s && s.apply.to === 'point' && a.area !== undefined && s.apply.effect !== a.area) errorAt(c, [...ap, 'do', i, 'apply', 'to'], `apply to: point places the activation's area: set area: ${s.apply.effect}`);
  });
}

function bindActivate(b: Binder, f: FeatureSource, a: ActivateSrc, ap: YamlPath): { root: number; steps: Step[] } {
  const root = a.root === undefined ? -1 : b.effect(a.root, [...ap, 'root']);
  if (a.target === 'self') {
    const t = a.do.findIndex((s) => 'target' in s);
    if (t >= 0) errorAt(b.ctx, [...ap, 'do', t, 'target'], 'a target: self activation acts on its user only: drop this target step (or drop target: self)');
  }
  const steps = b.steps(a.do, [...ap, 'do'], {
    // target: self (M3 step 6): the frame starts with the user as its target, like an initiative hook.
    targets: a.target === 'self',
    root: root >= 0,
    zone: false,
    skill: false,
    label: { id: `${f.id}/${a.id}`, local: a.id, name: a.name },
    branch: false,
    ...(a.area !== undefined ? { place: true } : {}),
  });
  return { root, steps };
}

/** The pool an activation spends (pool, or uses: { pool }), if any. */
const activatePool = (a: ActivateSrc): string | undefined => a.pool ?? (a.uses && 'pool' in a.uses ? a.uses.pool : undefined);
/** Pool points one use spends: uses: { pool, cost }, else 1. */
const activateCost = (a: ActivateSrc): number => (a.uses && 'pool' in a.uses ? (a.uses.cost ?? 1) : 1);

/**
 * M3 step 8'a: a hitKnown or damageTaken reaction's steps. hitKnown's act on the bearer (Shield's
 * AC effect, apply to self); damageTaken's on the creature that dealt the damage (Hellish Rebuke's
 * save). Either way the frame starts with that one target, like an initiative hook.
 */
function bindReact(b: Binder, f: FeatureSource): Step[] {
  const r = f.reaction!;
  if (r.window !== 'hitKnown' && r.window !== 'damageTaken') return [];
  return b.steps(r.do, ['reaction', 'do'], { targets: true, root: false, zone: false, skill: false, label: { id: `${f.id}/reaction`, local: localOf(f.id), name: f.name }, branch: false });
}

/** The initiative hook's label (its steps' names) and context. */
function bindInit(b: Binder, f: FeatureSource): Step[] {
  const h = f.initiative!;
  // Its steps act on the bearer (the frame's target is the bearer: Uncanny Metabolism heals it).
  return b.steps(h.do, ['initiative', 'do'], { targets: true, root: false, zone: false, skill: false, label: { id: `${f.id}/${h.id}`, local: h.id, name: h.name }, branch: false });
}

// ---- M3 step 5a: RIDER filters (compile time) ----

/** One rider a PC has, in the order its features compile (tpl.riders order). */
export interface RiderPlanEntry {
  readonly feature: string;
  readonly rider: RiderSrc;
}

/**
 * A PC's riders in tpl.riders order: its features in file order (each once, loaded and checked
 * ones only, as compileCasting takes them), each feature's riders in order.
 */
export function riderPlan(src: PcSource, lib: Library): RiderPlanEntry[] {
  const out: RiderPlanEntry[] = [];
  const seen = new Set<string>();
  for (const fid of src.features) {
    if (seen.has(fid)) continue;
    seen.add(fid);
    const def = lib.features.get(fid);
    if (!def || !def.ok || !def.src.riders) continue;
    for (const rider of def.src.riders) out.push({ feature: fid, rider });
  }
  return out;
}

/** What a rider filter looks at in one attack, known at compile. abilities: bits (1 << ABILITIES index) it may use. */
export interface RiderAttackInfo {
  readonly kind: 'melee' | 'ranged';
  readonly unarmed: boolean;
  readonly spell: boolean;
  readonly abilities: number;
  /** A Monk weapon: a Simple Melee weapon, or a Martial Melee weapon with Light (srd-raw.txt:11076-11084). */
  readonly monkWeapon: boolean;
  /** M3 step 5b: the PC weapon's local id the attack is made with (any mode); undefined for an Unarmed Strike or a spell. */
  readonly weapon?: string;
  /** W1 (P6): the weapon has the Finesse property (any of its modes: a thrown Dagger keeps it). */
  readonly finesse?: boolean;
  /** W1 (P6): the weapon is a Ranged weapon (its kind, not the attack's: a thrown Handaxe isn't). */
  readonly rangedWeapon?: boolean;
}

/** Whether a rider's filter takes this attack (grantedBy is checked when the strike is made). */
export function riderMatches(r: RiderSrc, a: RiderAttackInfo): boolean {
  const f = r.filter;
  if (!f) return true;
  if (f.attack !== undefined) {
    const kinds = typeof f.attack === 'string' ? [f.attack] : f.attack;
    const weapon = !a.unarmed && !a.spell; // a stat block's attacks count as weapon attacks [U: 2024 stat blocks don't say]
    const ok = kinds.some((k) => (k === 'unarmed' ? a.unarmed : k === 'spell' ? a.spell : k === 'weapon' ? weapon : weapon && a.monkWeapon));
    if (!ok) return false;
  }
  if (f.range !== undefined && f.range !== a.kind) return false;
  if (f.ability !== undefined && (a.abilities & (1 << ABILITIES.indexOf(f.ability))) === 0) return false;
  if (f.weapon !== undefined && a.weapon !== f.weapon) return false;
  // W1 (P6): "a Finesse or a Ranged weapon" (Sneak Attack, srd-raw.txt:13738-13739).
  if (f.weaponProperty !== undefined && !f.weaponProperty.some((x) => (x === 'finesse' ? a.finesse === true : a.rangedWeapon === true))) return false;
  return true;
}

/** An attack's onHit/onMiss rider lists (tpl.riders indices), each left out when empty (C3). */
export function riderLists(plan: readonly RiderPlanEntry[], a: RiderAttackInfo): { onHit?: number[]; onMiss?: number[] } {
  const hit: number[] = [];
  const miss: number[] = [];
  plan.forEach((e, i) => {
    if (!riderMatches(e.rider, a)) return;
    (e.rider.on === 'miss' ? miss : hit).push(i);
  });
  return { ...(hit.length > 0 ? { onHit: hit } : {}), ...(miss.length > 0 ? { onMiss: miss } : {}) };
}

/**
 * Binds one rider's options. On a hit, damage steps at the top level of an option are extra
 * damage joined to the attack's own (one damage instance, rolled twice on a crit: "Critical
 * Hits", srd-raw.txt:2207-2211, Sneak Attack's dice); every other step runs after that damage.
 */
function bindRider(b: Binder, f: FeatureSource, r: RiderSrc, rp: YamlPath): RiderOpt[] {
  const label = { id: `${f.id}/${r.id}`, local: r.id, name: r.name };
  const one = (local: string, name: string, list: readonly StepSrc[], p: YamlPath): RiderOpt => riderOpt(b, label, r.on, local, name, list, p);
  if (r.choose) {
    const ids = new Set<string>();
    return r.choose.map((o, j) => {
      if (ids.has(o.id)) errorAt(b.ctx, [...rp, 'choose', j, 'id'], `option id "${o.id}" is used twice`);
      ids.add(o.id);
      return one(o.id, o.name, o.do, [...rp, 'choose', j, 'do']);
    });
  }
  return [one(r.id, r.name, r.do!, [...rp, 'do'])];
}

/** One rider option: on a hit, its top-level damage steps are the extra damage (W1 P4: they may take type: weapon), the rest runs after. */
function riderOpt(b: Binder, label: Cx['label'], on: RiderSrc['on'], local: string, name: string, list: readonly StepSrc[], p: YamlPath): RiderOpt {
  const all = b.steps(list, p, { targets: true, root: false, zone: false, skill: false, label, branch: false, ...(on === 'hit' ? { weaponType: true } : {}) });
  if (on !== 'hit') return { local, name, steps: all };
  const extra: CompiledDamage[] = [];
  const steps: Step[] = [];
  for (const st of all) {
    if (st.k === 'damage') extra.push(...st.dmg);
    else steps.push(st);
  }
  return { local, name, ...(extra.length > 0 ? { extra } : {}), steps };
}

/** W1 (P7): a feature's first-attack program: its steps act on its bearer (the frame's target, like an initiative hook). */
function bindFirstAttack(b: Binder, f: FeatureSource, list: readonly StepSrc[], p: YamlPath): Step[] {
  return b.steps(list, p, { targets: true, root: false, zone: false, skill: false, label: { id: `${f.id}/first-attack`, local: 'first-attack', name: f.name }, branch: false });
}

/** Checks a feature once, at its own file (with stand-in numbers; casters bind their own). */
export function checkFeature(src: FeatureSource, c: ItemCtx): FeatureDef {
  const start = c.errors.length;
  checkUniqueEffects(c, src.effects);
  // A narrative feature says so itself (fidelity: narrative, docs/design/m3.md 2.7): it loads and
  // shows on the sheet with nothing modeled, which is the point, so it isn't warned about.
  // A feature the class table or the character expansion mechanizes (mechanizedBy, coverage C0)
  // has nothing of its own to model, by design, so it isn't warned about either.
  if (!src.activate && !src.reaction && !src.passive && !src.initiative && !src.riders && !src.firstAttack && !src.dropToOne && !src.augments && src.resist.length === 0 && !src.hp && src.fidelity !== 'narrative' && src.mechanizedBy === undefined) {
    warnAt(c, ['id'], 'nothing here is modeled (no activate, reaction, passive, initiative, riders, firstAttack, dropToOne, augments, resist or hp): list it in the character\'s unimplemented instead');
  }
  const b = new Binder(c, { mod: src.spellAbility === undefined ? null : 0, pb: 2, charLevel: 1, env: standInEnv }, featureOwner(src), []);
  const ids = new Set<string>();
  for (const { a, p: ap } of activationsOf(src)) {
    if (ids.has(a.id)) errorAt(c, [...ap, 'id'], `activation id "${a.id}" is used twice`);
    ids.add(a.id);
    const re = a.root === undefined ? undefined : src.effects.find((e) => e.id === a.root);
    if (re && re.duration === 'parent') errorAt(c, [...ap, 'root'], `the root effect ${a.root} can't last duration: parent (nothing is above it)`);
    if (re?.zone) errorAt(c, [...ap, 'root'], `the root effect ${a.root} can't be a zone (it sits on the character)`);
    if (a.pool !== undefined && a.uses !== undefined) errorAt(c, [...ap, 'uses'], 'give pool or uses, not both (uses: { pool } is the same as pool)');
    if (a.cost === 'free' && a.pool === undefined && a.uses === undefined) {
      errorAt(c, [...ap, 'cost'], 'a free activation needs a limit: a pool, or uses: { perTurn: 1 }');
    }
    checkActivationArea(c, src, a, ap);
    bindActivate(b, src, a, ap);
  }
  if (src.initiative) bindInit(b, src);
  if (src.firstAttack) bindFirstAttack(b, src, src.firstAttack.do, ['firstAttack', 'do']);
  if (src.augments) {
    // W1 (P10): checked here with a permissive frame (targets and a root); each PC binds them in the frame of what they augment.
    const a = src.augments;
    if (a.feature === src.id) errorAt(c, ['augments', 'feature'], 'a feature can\'t augment itself');
    if (a.steps) b.steps(a.steps, ['augments', 'steps'], { targets: true, root: true, zone: false, skill: false, label: { id: `${src.id}/augment`, local: 'augment', name: src.name }, branch: false });
    a.options?.forEach((o, j) => riderOpt(b, { id: `${src.id}/${o.id}`, local: o.id, name: o.name }, 'hit', o.id, o.name, o.do, ['augments', 'options', j, 'do']));
  }
  src.passive?.effects.forEach((id, i) => {
    const p: YamlPath = ['passive', 'effects', i];
    if (src.passive!.effects.indexOf(id) !== i) errorAt(c, p, `${id} is listed twice`);
    const e = src.effects.find((x) => x.id === id);
    // Only an Emanation: it starts from its owner, so the fight's start can place it (coverage step 7.5). It appears before the fight, so no appear hook.
    if (e?.zone && e.zone.shape !== 'emanation') errorAt(c, p, `the passive effect ${id} can't be a ${e.zone.shape} (only an Emanation has an origin to start from)`);
    if (e?.zone && e.on.some((h) => h.when.includes('appear'))) errorAt(c, p, `the passive effect ${id} is up before the fight: it has no appear hook to fire`);
    if (e && e.duration !== 'parent') errorAt(c, p, `the passive effect ${id} lasts the whole fight: give it duration: parent`);
    b.effect(id, p);
  });
  if (src.reaction?.window === 'beforeD20Test') compileRoll(c, ['reaction', 'die'], src.reaction.die, {}, 'a reaction die is plain dice');
  if (src.reaction?.window === 'hitKnown' || src.reaction?.window === 'damageTaken') {
    const r = src.reaction;
    if (r.points !== undefined && r.pool === undefined) errorAt(c, ['reaction', 'points'], 'points are spent from a pool: give pool too');
    if (r.window === 'hitKnown' && r.ac === undefined && r.do.length === 0) errorAt(c, ['reaction'], 'a hitKnown reaction raises AC: give ac (against that attack), do (steps on the bearer, such as an AC effect), or both');
    bindReact(b, src);
  }
  if (src.reaction?.window === 'hitTaken') {
    const r = src.reaction;
    if (r.points !== undefined && r.pool === undefined) errorAt(c, ['reaction', 'points'], 'points are spent from a pool: give pool too');
    if (r.reduce !== 'halve') compileRoll(c, ['reaction', 'reduce'], r.reduce, withMod(src.spellAbility === undefined ? null : 0, standInEnv), `a reduction may use ${PC_VARS}`);
  }
  // Session S: a selfHas gate names one of this feature's own effects; checked here, at its own file.
  // A qualified one (W1, P3) names another feature's and binds only when a PC compiles.
  for (const { a, p: ap } of activationsOf(src)) if (a.when) compileGates(a.when, -1, (l) => b.gateFx(l, [...ap, 'when']));
  src.riders?.forEach((r, j) => {
    if (r.when) compileGates(r.when, -1, (l) => b.gateFx(l, ['riders', j, 'when']));
  });
  const rids = new Set<string>();
  src.riders?.forEach((r, j) => {
    const rp: YamlPath = ['riders', j];
    if (rids.has(r.id)) errorAt(c, [...rp, 'id'], `rider id "${r.id}" is used twice`);
    rids.add(r.id);
    if (r.cost?.points !== undefined && r.cost.points < 1) errorAt(c, [...rp, 'cost', 'points'], 'a cost is at least 1 point');
    bindRider(b, src, r, rp);
  });
  warnUnused(c, src.effects, b.used);
  return { src, ok: c.errors.length === start };
}

function instanceEffect(sp: CompiledSpell, rounds: number, lvl: number): BoundEffect {
  return {
    id: `${sp.id}/${INSTANCE_LOCAL}` as Id,
    local: INSTANCE_LOCAL,
    name: sp.name,
    sid: sp.sid,
    lvl,
    zone: null,
    dur: { k: 'rounds', n: rounds },
    limit: 'none',
    endsOn: 0,
    inHand: false,
    group: null,
    mods: [],
    hooks: [],
    hookMask: 0,
    grants: [],
    interacts: false,
    conc: true,
  };
}

export interface CasterNums extends PcBindings {
  readonly scale?: ScaleBindings | undefined;
  /** M3 step 5a: the PC's attacks (and their no-ability-modifier forms) for weaponAttack steps. */
  readonly attacks?: readonly CompiledAttack[];
  readonly noAbility?: readonly CompiledAttack[];
  readonly items: readonly ItemDef[];
  readonly pools: readonly PoolDef[];
  /** Slots L1..L9 at [0..8], then pools. */
  readonly resMax: readonly number[];
  /** M3 step 5a (RIDER): riderPlan(src, lib), when it has any. */
  readonly riderPlan?: readonly RiderPlanEntry[];
}

export interface CastingOut {
  readonly spells: SpellEntry[];
  readonly effects: BoundEffect[];
  readonly features: CompiledFeature[];
  /** damageBit mask of the resistances its features give. */
  readonly resist: number;
  readonly unimplemented: string[];
  /** M3 step 5a: its features' riders in riderPlan order; empty when none. */
  readonly riders: CompiledRider[];
}

type ListKey = 'cantrips' | 'prepared' | 'always' | 'free';

interface Plan {
  readonly id: string;
  readonly list: ListKey;
  readonly path: YamlPath;
  slotted: boolean;
  freePool: number;
}

/** A PC's spell entries, bound effects and features. */
export function compileCasting(src: PcSource, c: ItemCtx, lib: Library, k: CasterNums): CastingOut {
  const effects: BoundEffect[] = [];
  const spells: SpellEntry[] = [];
  const features: CompiledFeature[] = [];
  const unimplemented: string[] = [];
  const riders: CompiledRider[] = [];
  let resist = 0;
  // Spells and features were checked at their own files with stand-ins; binding them here reports
  // nothing new, except where this PC's own numbers break an expression (a dice-valued @scale
  // column inside a computed dice count, a constant, or a damage max()). That's reported at the
  // PC's line for the item, naming the PC, the item and the expression's path in the item.
  const sink: ItemCtx = { doc: c.doc, prefix: c.prefix, errors: [], warnings: [] };
  const bindErrors = (p: YamlPath, id: string): void => {
    const seen: string[] = [];
    for (const d of sink.errors) {
      if (seen.includes(d.message)) continue; // the same expression, bound once per cast level
      seen.push(d.message);
      errorAt(c, p, `${src.id} can't bind ${id}: ${d.message}`);
    }
    sink.errors.length = 0;
  };
  // A class variable this character can't bind is its own problem: reported once per item, at the item.
  const unbound = new Set<string>();
  const envAt = (p: YamlPath, id: string): ((name: string) => ExprBinding | undefined) =>
    pcEnv(k, (name, message) => {
      if (unbound.has(`${id} ${name}`)) return;
      unbound.add(`${id} ${name}`);
      errorAt(c, p, `${id}: ${message}`);
    });
  const poolRes = (local: string): number => {
    const i = k.pools.findIndex((p) => p.local === local);
    return i < 0 ? -1 : POOL_BASE + i;
  };
  const missing = (p: YamlPath, id: string, want: string, where: string): void => {
    const other = lib.kinds.get(id);
    if (other !== undefined) {
      errorAt(c, p, `${id} is a ${other}, not a ${want}`);
      return;
    }
    warnAt(c, p, `${want} ${id} isn't in the loaded content; it's listed as unimplemented`);
    unimplemented.push(`${want} ${id}${where}: not in the loaded content`);
  };

  const sources = new Set<string>();
  src.casting.forEach((cs, si) => {
    const cp: YamlPath = ['casting', si];
    if (sources.has(cs.source)) errorAt(c, [...cp, 'source'], `casting source "${cs.source}" is listed twice`);
    sources.add(cs.source);
    const ability = ABILITIES.indexOf(cs.ability);
    const mod = k.mods[ability]!;
    let whileHeld = -1;
    if (cs.whileHeld !== undefined) {
      whileHeld = k.items.findIndex((it) => it.local === cs.whileHeld);
      if (whileHeld < 0) errorAt(c, [...cp, 'whileHeld'], `no item "${cs.whileHeld}" in items`);
    }
    const plans: Plan[] = [];
    const lists: readonly [readonly string[], ListKey][] = [
      [cs.cantrips, 'cantrips'],
      [cs.prepared, 'prepared'],
      [cs.always, 'always'],
    ];
    for (const [list, key] of lists) {
      list.forEach((id, j) => {
        if (!plans.some((pl) => pl.id === id)) plans.push({ id, list: key, path: [...cp, key, j], slotted: true, freePool: -1 }); // duplicates: a lint warning
      });
    }
    cs.free.forEach((f, j) => {
      const fp: YamlPath = [...cp, 'free', j];
      const pool = poolRes(f.pool);
      if (pool < 0) errorAt(c, [...fp, 'pool'], `no pool "${f.pool}" in pools`);
      const pl = plans.find((x) => x.id === f.spell);
      if (pl) {
        if (pl.freePool < 0) pl.freePool = pool;
      } else plans.push({ id: f.spell, list: 'free', path: [...fp, 'spell'], slotted: false, freePool: pool });
    });

    for (const pl of plans) {
      const def = lib.spells.get(pl.id);
      if (!def) {
        missing(pl.path, pl.id, 'spell', ` (${cs.source})`);
        continue;
      }
      if (!def.ok) continue;
      const sp = def.spell;
      if (pl.list === 'cantrips' && sp.level !== 0) {
        errorAt(c, pl.path, `${sp.name} is a level ${sp.level} spell, not a cantrip: list it under prepared or always`);
        continue;
      }
      if (pl.list === 'prepared' && sp.level === 0) {
        errorAt(c, pl.path, `${sp.name} is a cantrip: list it under cantrips`);
        continue;
      }
      if (pl.freePool >= 0 && sp.level === 0) {
        errorAt(c, pl.path, `${sp.name} is a cantrip: cantrips need no free casts`);
        continue;
      }
      const prog: (readonly Step[] | null)[] = new Array<readonly Step[] | null>(10).fill(null);
      const instance: number[] = new Array<number>(10).fill(-1);
      for (let lvl = 0; lvl <= 9; lvl++) {
        const castable =
          sp.level === 0 ? lvl === 0 : lvl >= sp.level && ((pl.slotted && (k.resMax[lvl - 1] ?? 0) > 0) || (pl.freePool >= 0 && lvl === sp.level));
        if (!castable) continue;
        if (sp.conc) {
          instance[lvl] = effects.length;
          effects.push(instanceEffect(sp, concRounds(def.src), lvl));
        }
        const b = new Binder(sink, { mod, pb: k.pb, charLevel: k.level, env: envAt(pl.path, pl.id), ...(k.riderPlan ? { riders: { plan: k.riderPlan, ability } } : {}) }, spellOwner(def, lvl), effects);
        prog[lvl] = b.steps(def.src.do, ['do'], spellCx(sp));
      }
      bindErrors(pl.path, pl.id);
      if (prog.every((x) => x === null)) {
        warnAt(c, pl.path, `${sp.name} can't be cast: no spell slot of level ${sp.level} or higher${pl.freePool >= 0 ? '' : ' and no free casts'}`);
      }
      spells.push({
        spell: sp,
        source: cs.source,
        list: cs.list,
        ability,
        toHit: k.pb + mod,
        dc: 8 + k.pb + mod,
        whileHeld,
        freePool: pl.freePool,
        slotted: pl.slotted,
        prog,
        instance,
      });
    }
  });

  // W1 (P3, P10): each feature's binder is made once, on first need (its own turn below, or earlier
  // for a qualified selfHas gate another feature names, or later for its augment), so its effects
  // bind once into tpl.effects. Content without either binds exactly as before.
  interface FeatureBinder {
    readonly b: Binder;
    readonly heldIdx: number;
    readonly p: YamlPath;
  }
  const binders = new Map<string, FeatureBinder>();
  const qualWarned = new Set<string>();
  const binderFor = (fid: string): FeatureBinder | null => {
    const have = binders.get(fid);
    if (have) return have;
    const at = src.features.indexOf(fid);
    const def = lib.features.get(fid);
    if (at < 0 || !def || !def.ok) return null;
    const f = def.src;
    const p: YamlPath = ['features', at];
    const mod = f.spellAbility === undefined ? null : k.mods[ABILITIES.indexOf(f.spellAbility)]!;
    const pc: PcRefs | undefined = k.attacks ? { attacks: k.attacks, noAbility: k.noAbility ?? k.attacks, poolRes, items: k.items } : undefined;
    const spellRiders = k.riderPlan && f.spellAbility !== undefined ? { riders: { plan: k.riderPlan, ability: ABILITIES.indexOf(f.spellAbility) } } : {};
    // M3 step 5b (itemHeld): the item this feature is, when the PC binds one with `magic`.
    const heldIdx = k.items.findIndex((it) => it.magic === fid);
    const held = heldIdx >= 0 ? { held: heldIdx } : {};
    // W1 (P3): '<feature id>#<effect>' binds to that feature's effect on this character, or -1 (a warning) when it doesn't have it.
    const qual = (q: string): number => {
      const cut = q.indexOf('#');
      const qf = q.slice(0, cut);
      const local = q.slice(cut + 1);
      const other = binderFor(qf);
      if (!other) {
        if (!qualWarned.has(`${fid} ${q}`)) {
          qualWarned.add(`${fid} ${q}`);
          warnAt(c, p, `${fid}: selfHas ${q} names ${qf}, which this character doesn't have, so that gate never holds`);
        }
        return -1;
      }
      if (!lib.features.get(qf)!.src.effects.some((e) => e.id === local)) {
        errorAt(c, p, `${fid}: selfHas ${q}: ${qf} has no effect "${local}"`);
        return -1;
      }
      return other.b.effect(local, other.p);
    };
    const b = new Binder(sink, { mod, pb: k.pb, charLevel: k.level, env: envAt(p, fid), ...(pc ? { pc } : {}), ...spellRiders, ...held, qual }, featureOwner(f), effects);
    const out = { b, heldIdx, p };
    binders.set(fid, out);
    return out;
  };

  const seen = new Set<string>();
  src.features.forEach((fid, i) => {
    const p: YamlPath = ['features', i];
    if (seen.has(fid)) return; // a lint warning
    seen.add(fid);
    const def = lib.features.get(fid);
    if (!def) {
      missing(p, fid, 'feature', '');
      return;
    }
    if (!def.ok) return;
    const f = def.src;
    for (const t of f.resist) resist |= damageBit(DAMAGE_TYPES.indexOf(t));
    for (const u of f.unimplemented) unimplemented.push(`${f.name}: ${u}`);
    if (activationsOf(f).some(({ a }) => activationArea(f, a)?.from === 'aim')) unimplemented.push(`${f.name}: ${AIM_LIMIT}`);
    // Resistances or hp only; an augment alone (W1, P10) binds after every feature, below.
    if (!f.activate && !f.reaction && !f.passive && !f.initiative && !f.riders && !f.firstAttack && !f.dropToOne) return;
    const { b, heldIdx } = binderFor(fid)!;
    const mod = f.spellAbility === undefined ? null : k.mods[ABILITIES.indexOf(f.spellAbility)]!;
    const poolOf = (poolId: string | undefined): number => {
      if (poolId === undefined) return -1;
      const pool = poolRes(poolId);
      if (pool < 0) errorAt(c, p, `${f.name} spends pool "${poolId}", which this character's pools don't define`);
      return pool;
    };
    const acts: CompiledActivation[] = activationsOf(f).map(({ a, p: ap }) => {
      const pool = poolOf(activatePool(a));
      const cost = activateCost(a);
      const { root, steps } = bindActivate(b, f, a, ap);
      return { local: a.id, name: a.name, cost: a.cost, pool, ...(cost !== 1 ? { poolCost: cost } : {}), ...(a.uses && 'perTurn' in a.uses ? { perTurn: true as const } : {}), root, steps, ...(a.when ? { when: compileGates(a.when, heldIdx, (l) => b.gateFx(l, [...ap, 'when'])) } : {}), ...(a.target === 'self' ? { self: true as const } : {}), ...(activationArea(f, a) ? { area: activationArea(f, a)! } : {}) };
    });
    const activate: CompiledFeature['activate'] = acts[0] ?? null;
    let onInit: CompiledInitHook | undefined;
    if (f.initiative) {
      const h = f.initiative;
      const pool = poolOf(h.uses?.pool);
      const cost = h.uses?.cost ?? 1;
      onInit = { local: h.id, name: h.name, pool, ...(cost !== 1 ? { poolCost: cost } : {}), steps: bindInit(b, f) };
    }
    let preRoll: CompiledFeature['preRoll'] = null;
    let hitTaken: CompiledFeature['hitTaken'];
    let hitKnown: CompiledFeature['hitKnown'];
    let damageTaken: CompiledFeature['damageTaken'];
    if (f.reaction?.window === 'hitKnown') {
      const r = f.reaction;
      const cost = r.points ?? 1;
      let attacks = 0;
      for (const a of r.attacks) attacks |= a === 'melee' ? 1 : 2;
      hitKnown = { attacks, ac: r.ac ?? 0, pool: poolOf(r.pool), ...(cost !== 1 ? { poolCost: cost } : {}), steps: bindReact(b, f) };
    } else if (f.reaction?.window === 'damageTaken') {
      const r = f.reaction;
      const cost = r.points ?? 1;
      damageTaken = { rangeFt: r.range, pool: poolOf(r.pool), ...(cost !== 1 ? { poolCost: cost } : {}), steps: bindReact(b, f) };
    } else if (f.reaction?.window === 'hitTaken') {
      const r = f.reaction;
      const pool = poolOf(r.pool);
      const cost = r.points ?? 1;
      let reduce: ExprNode | 'halve' = 'halve';
      if (r.reduce !== 'halve') reduce = compileRoll(sink, ['reaction', 'reduce'], r.reduce, withMod(mod, envAt(p, fid)), `a reduction may use ${PC_VARS}`)?.roll ?? { k: 'const', v: 0 };
      let types = 0;
      for (const t of r.damageTypes ?? []) types |= damageBit(DAMAGE_TYPES.indexOf(t));
      hitTaken = { reduce, types, pool, ...(cost !== 1 ? { poolCost: cost } : {}), ...(r.sees ? { sees: true as const } : {}) };
    } else if (f.reaction) {
      const r = f.reaction;
      const pool = poolRes(r.pool);
      if (pool < 0) errorAt(c, p, `${f.name} spends pool "${r.pool}", which this character's pools don't define`);
      const die = compileRoll(sink, ['reaction', 'die'], r.die, {}, '')?.roll ?? { k: 'const', v: 0 };
      let kinds = 0;
      for (const kind of r.rolls) kinds |= 1 << RK[kind];
      preRoll = { rangeFt: r.range, self: r.self, pool, die, sign: r.sign === 'add' ? 1 : r.sign === 'subtract' ? -1 : 0, kinds };
    }
    const passive = f.passive?.effects.map((id, j) => b.effect(id, ['passive', 'effects', j]));
    const fi = features.length;
    f.riders?.forEach((r, j) => {
      const rp: YamlPath = ['riders', j];
      const pool = poolOf(r.cost?.pool);
      const cost = r.cost?.points ?? 1;
      riders.push({
        local: r.id, name: r.name, feature: fi, on: r.on,
        ...(r.filter?.grantedBy !== undefined ? { grantedBy: r.filter.grantedBy } : {}),
        ...(r.oncePerTurn ? { once: r.oncePerTurn } : {}),
        pool, ...(cost !== 1 ? { poolCost: cost } : {}),
        ...(r.when ? { when: compileGates(r.when, heldIdx, (l) => b.gateFx(l, [...rp, 'when'])) } : {}),
        chooses: r.choose !== undefined,
        opts: bindRider(b, f, r, rp),
        ...(r.auto ? { auto: true as const } : {}),
        ...(r.spellDamage ? { spellDamage: true as const } : {}),
      });
    });
    // W1 (P7, P8), each undefined when the feature has none (C3).
    const firstAttack = f.firstAttack ? { steps: bindFirstAttack(b, f, f.firstAttack.do, ['firstAttack', 'do']) } : undefined;
    const dropToOne = f.dropToOne ? { pool: poolOf(f.dropToOne.pool) } : undefined;
    bindErrors(p, fid);
    features.push({ id: f.id as Id, local: localOf(f.id), name: f.name, activate, preRoll, ...(passive ? { passive } : {}), ...(acts.length > 1 ? { more: acts.slice(1) } : {}), ...(onInit ? { onInit } : {}), ...(hitTaken ? { hitTaken } : {}), ...(hitKnown ? { hitKnown } : {}), ...(damageTaken ? { damageTaken } : {}), ...(firstAttack ? { firstAttack } : {}), ...(dropToOne ? { dropToOne } : {}) });
  });

  // W1 (P10): augments, once every feature has compiled: steps appended to another feature's
  // activation or firstAttack program (run in its frame, with this feature's effects), options to
  // its rider (one rider, one ledger, one decision). Only when the character has both features.
  const augSeen = new Set<string>();
  for (const fid of src.features) {
    if (augSeen.has(fid)) continue;
    augSeen.add(fid);
    const def = lib.features.get(fid);
    const aug = def?.ok ? def.src.augments : undefined;
    if (!def || !aug || !src.features.includes(aug.feature)) continue;
    const tdef = lib.features.get(aug.feature);
    if (!tdef || !tdef.ok) continue; // reported at its own line
    const bound = binderFor(fid)!;
    const p = bound.p;
    const ti = features.findIndex((x) => x.id === aug.feature);
    const tf = ti >= 0 ? features[ti]! : undefined;
    if (aug.rider !== undefined) {
      const ri = riders.findIndex((r) => r.feature === ti && r.local === aug.rider);
      const rsrc = tdef.src.riders?.find((r) => r.id === aug.rider);
      if (ri < 0 || !rsrc) {
        errorAt(c, p, `${fid} adds options to ${aug.feature}'s rider "${aug.rider}", which it doesn't have`);
        continue;
      }
      const r = riders[ri]!;
      if (r.auto) {
        errorAt(c, p, `${fid}: ${aug.feature}'s rider "${aug.rider}" is used without a decision (auto), so it can't take options`);
        continue;
      }
      const label = { id: `${aug.feature}/${rsrc.id}`, local: rsrc.id, name: rsrc.name };
      const opts = aug.options!.map((o, j) => riderOpt(bound.b, label, rsrc.on, o.id, o.name, o.do, ['augments', 'options', j, 'do']));
      for (const o of opts) if (r.opts.some((x) => x.local === o.local)) errorAt(c, p, `${fid}: option "${o.local}" is already one of ${aug.feature}'s rider "${aug.rider}" options`);
      riders[ri] = { ...r, chooses: true, opts: [...r.opts, ...opts] };
    } else if (aug.firstAttack) {
      if (!tf?.firstAttack) {
        errorAt(c, p, `${fid} adds to ${aug.feature}'s firstAttack, which it doesn't have`);
        continue;
      }
      const steps = bindFirstAttack(bound.b, def.src, aug.steps!, ['augments', 'steps']);
      features[ti] = { ...tf, firstAttack: { steps: [...tf.firstAttack.steps, ...steps] } };
    } else {
      const acts = tf?.activate ? [tf.activate, ...(tf.more ?? [])] : [];
      const ai = aug.activation === undefined ? (acts.length > 0 ? 0 : -1) : acts.findIndex((a) => a.local === aug.activation);
      const asrc = ai < 0 ? undefined : activationsOf(tdef.src).find((x) => x.a.id === acts[ai]!.local)?.a;
      if (!tf || !asrc) {
        errorAt(c, p, `${fid} adds to ${aug.feature}'s activation${aug.activation === undefined ? '' : ` "${aug.activation}"`}, which it doesn't have`);
        continue;
      }
      // The target's frame: its user as the target for target: self, its root for duration: parent.
      const steps = bound.b.steps(aug.steps!, ['augments', 'steps'], {
        targets: asrc.target === 'self',
        root: asrc.root !== undefined,
        zone: false,
        skill: false,
        label: { id: `${aug.feature}/${asrc.id}`, local: asrc.id, name: asrc.name },
        branch: false,
        ...(asrc.area !== undefined ? { place: true } : {}),
      });
      const act: CompiledActivation = { ...acts[ai]!, steps: [...acts[ai]!.steps, ...steps] };
      features[ti] = ai === 0 ? { ...tf, activate: act } : { ...tf, more: tf.more!.map((m, j) => (j === ai - 1 ? act : m)) };
    }
    bindErrors(p, fid);
  }

  // RIDER: riderPlan named these riders before the attacks were built; both walk the features the same way.
  const plan = k.riderPlan ?? [];
  if (plan.length !== riders.length || plan.some((e, i) => e.rider.id !== riders[i]!.local)) throw new Error(`internal: ${src.id}'s riders don't line up with its rider plan`);
  // grantedBy names an activation the character has (Open Hand Technique: Flurry of Blows).
  riders.forEach((r, i) => {
    if (r.grantedBy === undefined) return;
    const known = features.some((f) => (f.activate?.local === r.grantedBy) || (f.more?.some((a) => a.local === r.grantedBy) ?? false));
    if (!known) errorAt(c, ['features'], `${plan[i]!.feature}: rider ${r.local} is for strikes granted by "${r.grantedBy}", and none of this character's features has that activation`);
  });

  return { spells, effects, features, resist, unimplemented, riders };
}

/** What a monster's actions add to its template (coverage step 7.6). */
export interface MonsterActions {
  readonly features: readonly CompiledFeature[];
  readonly effects: readonly BoundEffect[];
  readonly pools: readonly PoolDef[];
  readonly rechargeUse: readonly NonNullable<CompiledTemplate['rechargeUse']>[number][];
  readonly unimplemented: readonly string[];
}

/** Does a program (and the hooks of the effects it applies) do damage? Limited actions that do are what the book rule means (srd-raw.txt:43608-43612). */
function programDamages(steps: readonly Step[], effects: readonly BoundEffect[]): boolean {
  return steps.some((s) => {
    if (s.k === 'damage') return true;
    if (s.k === 'save') return s.dmg !== null || programDamages(s.onFail, effects) || programDamages(s.onSuccess, effects);
    if (s.k === 'apply') return effects[s.fx]!.hooks.some((h) => programDamages(h.steps, effects));
    return false;
  });
}

/**
 * Coverage step 7.6: a stat block's actions as feature activations, one feature each, through the same
 * Binder with no ability modifier and plain dice. Their effects and pools follow the template's (none
 * today: a monster with no actions compiles exactly as before). Coverage step 9+: its traits (passive
 * effects) and Reactions after them, one feature each (a monster with neither compiles as before).
 */
export function compileMonsterActions(c: ItemCtx, src: MonsterSource): MonsterActions {
  const effects: BoundEffect[] = [];
  const features: CompiledFeature[] = [];
  const pools: PoolDef[] = [];
  const rechargeUse: { pool: number; min: number; via: Id; name: string }[] = [];
  const unimplemented: string[] = [];
  const noEnv = (): undefined => undefined;
  const ids = new Set<string>();
  (src.actions ?? []).forEach((act, i) => {
    const ap: YamlPath = ['actions', i];
    if (ids.has(act.id)) errorAt(c, [...ap, 'id'], `action id "${act.id}" is used twice`);
    ids.add(act.id);
    // The feature path's own checks and owner read a feature source: an action is one activation of one.
    const a = { id: act.id, name: act.name, cost: act.cost, do: act.do, ...(act.area !== undefined ? { area: act.area } : {}), ...(act.range !== undefined ? { range: act.range } : {}) } as ActivateSrc;
    const f = { kind: 'feature', id: `${src.id}/${act.id}`, name: act.name, source: src.source, effects: act.effects, activate: a, resist: [], unimplemented: [], fidelity: src.fidelity } as unknown as FeatureSource;
    checkActivationArea(c, f, a, ap);
    const b = new Binder(c, { mod: null, pb: src.pb, charLevel: 1, env: noEnv, monster: true }, featureOwner(f), effects);
    const { root, steps } = bindActivate(b, f, a, ap);
    warnUnused(c, act.effects, b.used);
    let pool = -1;
    let recharge: number | undefined;
    const uses = act.uses;
    if (uses) {
      pool = 9 + pools.length;
      let max = 1;
      if ('perDay' in uses) max = uses.perDay;
      else {
        const [lo, hi] = uses.recharge;
        if ((hi ?? 6) !== 6 || lo! > (hi ?? 6)) errorAt(c, [...ap, 'uses', 'recharge'], 'recharge is [X, 6], or [6] for Recharge 6 (the range ends at the top of the d6)');
        recharge = lo!;
        rechargeUse.push({ pool, min: lo!, via: f.id as Id, name: act.name });
      }
      pools.push({ local: act.id, name: act.name, max, recharge: 'none' });
    }
    const area = activationArea(f, a);
    if (area?.from === 'aim') unimplemented.push(`${act.name}: ${AIM_LIMIT}`);
    const activate: CompiledActivation = { local: act.id, name: act.name, cost: act.cost, pool, root, steps, ...(area ? { area } : {}), ...(recharge !== undefined ? { recharge } : {}), ...(pool >= 0 && programDamages(steps, effects) ? { book: true as const } : {}) };
    features.push({ id: f.id as Id, local: act.id, name: act.name, activate, preRoll: null });
  });
  // Coverage step 9+: traits (every effect passive, as a feature's passive list) and Reactions.
  (src.traits ?? []).forEach((tr, i) => {
    const tp: YamlPath = ['traits', i];
    if (ids.has(tr.id)) errorAt(c, [...tp, 'id'], `id "${tr.id}" is used twice among this stat block's actions, traits and reactions`);
    ids.add(tr.id);
    const passiveIds = tr.effects.map((e) => e.id);
    const f = { kind: 'feature', id: `${src.id}/${tr.id}`, name: tr.name, source: src.source, effects: tr.effects, passive: { effects: passiveIds }, resist: [], unimplemented: [], fidelity: src.fidelity } as unknown as FeatureSource;
    const b = new Binder(c, { mod: null, pb: src.pb, charLevel: 1, env: noEnv, monster: true }, featureOwner(f), effects);
    const passive = passiveIds.map((id, j) => b.effect(id, [...tp, 'effects', j, 'id']));
    for (const e of tr.effects) if (e.zone) errorAt(c, tp, `${tr.name}: a trait's effects sit on the monster; a zone (aura) trait isn't modeled`);
    features.push({ id: f.id as Id, local: tr.id, name: tr.name, activate: null, preRoll: null, passive });
  });
  (src.reactions ?? []).forEach((r, i) => {
    const rp: YamlPath = ['reactions', i];
    if (ids.has(r.id)) errorAt(c, [...rp, 'id'], `id "${r.id}" is used twice among this stat block's actions, traits and reactions`);
    ids.add(r.id);
    const id = `${src.id}/${r.id}` as Id;
    if (r.window === 'hitKnown') {
      // "while holding a weapon" (srd-raw.txt:50631-50633): its Gear must list a weapon it attacks with.
      if (r.whileHolding === 'weapon') {
        const gear = new Set(src.gear.map((g) => g.name.toLowerCase()));
        if (!src.attacks.some((a) => gear.has(a.name.toLowerCase()))) errorAt(c, [...rp, 'whileHolding'], `${r.name} needs a weapon in hand: no Gear entry is named like one of this stat block's attacks`);
      }
      let attacks = 0;
      for (const a of r.attacks) attacks |= a === 'melee' ? 1 : 2;
      features.push({ id, local: r.id, name: r.name, activate: null, preRoll: null, hitKnown: { attacks, ac: r.ac, pool: -1, steps: [] } });
    } else {
      features.push({ id, local: r.id, name: r.name, activate: null, preRoll: null, declared: { swapRangeFt: r.swap.range, swapMinSize: r.swap.minSize === undefined ? 0 : SIZES.indexOf(r.swap.minSize), swapMaxSize: SIZES.indexOf(r.swap.maxSize) } });
    }
  });
  return { features, effects, pools, rechargeUse, unimplemented };
}

/** A pool's max: a number, or a constant expression over the PC's variables (PC_VARS). */
export function poolMax(c: ItemCtx, p: YamlPath, max: number | string, k: PcBindings): number {
  if (typeof max === 'number') return max;
  const r = compileRoll(c, p, max, pcEnv(k), `a pool max may use ${PC_VARS}`);
  if (!r) return 0;
  if (!isConstant(r.roll)) {
    errorAt(c, p, 'a pool max can\'t roll dice');
    return 0;
  }
  const v = evalConstant(r.roll, {});
  if (v < 0) {
    errorAt(c, p, `pool max comes to ${v}, below 0`);
    return 0;
  }
  return v;
}

// ---- M3 step 4: gates, stats, condition masks ----

/** COND bits of a list of content condition names. */
export function condMask(names: readonly (keyof typeof COND)[]): number {
  let m = 0;
  for (const n of names) m |= COND[n];
  return m;
}

/**
 * `held`: tpl.items index of the item the owning feature is (itemHeld), -1 when none (the gate then never holds).
 * `fxOf` (session S): binds a selfHas gate's local effect id to its index in the owner's effects (it
 * reports an unknown id itself); without it a selfHas gate never holds.
 */
export function compileGates(src: readonly GateSrc[], held = -1, fxOf?: (local: string) => number): Gate[] {
  return src.map((g) => compileGate(g, held, fxOf));
}

function compileGate(g: GateSrc, held: number, fxOf: ((local: string) => number) | undefined): Gate {
  if (typeof g === 'string') return g === 'itemHeld' ? { g: 'holding', item: held } : { g };
  if ('targetHas' in g) return { g: 'targetHas', bit: COND[g.targetHas] };
  if ('selfHas' in g) return { g: 'selfHas', fx: fxOf ? fxOf(g.selfHas) : -1 };
  // W1 (P5): a disjunction of AND lists, one level deep (the schema allows no nesting).
  return { g: 'anyOf', any: g.anyOf.map((list) => list.map((x) => compileGate(x, held, fxOf))) };
}

function typeMask(types: readonly string[]): number {
  let m = 0;
  for (const t of types) m |= damageBit(DAMAGE_TYPES.indexOf(t as (typeof DAMAGE_TYPES)[number]));
  return m;
}

/** One stat; `num` folds a number field (an int or an expression over the owner's numbers). */
export function compileStat(src: StatSrc, num: (field: string, v: number | string) => number, held = -1, fxOf?: (local: string) => number): CompiledStat {
  if ('magicWeapon' in src) return { k: 'magicWeapon', n: src.magicWeapon };
  const when = src.when ? { when: compileGates(src.when, held, fxOf) } : {};
  if ('ac' in src) return { k: 'ac', n: num('ac', src.ac), ...when };
  if ('acFloor' in src) return { k: 'acFloor', n: num('acFloor', src.acFloor), ...when };
  if ('speed' in src) {
    const v = src.speed;
    const noStack = src.noStack !== undefined ? { noStack: src.noStack } : {};
    return v === 'half' || v === 'zero' ? { k: 'speed', mode: v, n: 0, ...noStack, ...when } : { k: 'speed', mode: 'add', n: num('speed', v), ...noStack, ...when };
  }
  if ('resist' in src) return { k: 'resist', mask: typeMask(src.resist), ...when };
  if ('vuln' in src) return { k: 'vuln', mask: typeMask(src.vuln), ...when };
  if ('immune' in src) return { k: 'immune', mask: typeMask(src.immune), ...when };
  if ('critMin' in src) return { k: 'critMin', n: src.critMin, ...when };
  if ('noOpportunityAttacks' in src) return { k: 'noOpportunityAttacks', ...when };
  if ('noCasting' in src) return { k: 'noCasting', ...when };
  if ('noConcentration' in src) return { k: 'noConcentration', ...when };
  if ('fly' in src) return { k: 'fly', n: num('fly', src.fly), ...when };
  return { k: 'damageType', type: DAMAGE_TYPES.indexOf(src.damageType), on: src.on, ...when };
}
