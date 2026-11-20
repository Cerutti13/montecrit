// Compiled content: what the loader hands the simulator. Content files (YAML, validated by
// content/schema.ts) compile into these plain, read-only shapes once at load time; the
// simulator never sees YAML, zod, or expression source text.
//
// Ids are namespaced:
//   core:     engine primitives defined in code (actions, conditions, adv/dis sources)
//   srd:      the committed SRD 5.2.1 pack
//   private:  Shane's pack under ~/.montecrit/, never in the repo
//   test:     committed synthetic fixtures for tests
// Children of an item use '/': 'srd:guard/spear', 'srd:guard/spear-thrown'.

import type { ExprNode } from '../dice/expr.ts';
import type { RuleFlags } from '../rules/flags.ts';
import type { KeyPattern } from './rollkeys.ts';

export type Namespace = 'core' | 'srd' | 'private' | 'test';
export type Id = `${Namespace}:${string}`;

export const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
export type Ability = (typeof ABILITIES)[number];

export const DAMAGE_TYPES = [
  'acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning', 'necrotic',
  'piercing', 'poison', 'psychic', 'radiant', 'slashing', 'thunder',
] as const;
export type DamageType = (typeof DAMAGE_TYPES)[number];

/** The conditions content can impose or be immune to (M3 step 4); Grappled is deferred. sim/state.ts COND has their bits. */
export const CONTENT_CONDS = ['blinded', 'charmed', 'frightened', 'incapacitated', 'paralyzed', 'poisoned', 'prone', 'restrained', 'stunned', 'unconscious'] as const;
export type ContentCond = (typeof CONTENT_CONDS)[number];

export const SIZES = ['tiny', 'small', 'medium', 'large', 'huge', 'gargantuan'] as const;
export type Size = (typeof SIZES)[number];

/** Bit for a damage type in resist/vuln/immune masks. */
export const damageBit = (type: number): number => 1 << type;

export interface CompiledDamage {
  /** Full expression with @vars folded to constants, e.g. 1d6 + 2. */
  readonly roll: ExprNode;
  /** The dice a critical hit rolls again (diceOnly(roll)); null if the part has no dice. */
  readonly critExtra: ExprNode | null;
  /** Index into DAMAGE_TYPES. */
  readonly type: number;
  /** The stat block's printed average, or floor(mean) when none is printed. Display only. */
  readonly avg: number;
  /** Rider that applies only if the attack roll had Advantage (goblin weapons). */
  readonly ifAdvantage: boolean;
  /**
   * W1 (P4): an on: hit rider's extra part whose type is the attack's (content type: weapon): the
   * type of the attack's first part after unarmedTypeFor, resolved where the rider joins the hit.
   * `type` is -1 until then. undefined for every other part (C3).
   */
  readonly asAttack?: true;
}

export interface CompiledAttack {
  readonly id: Id; // 'srd:guard/spear', 'srd:guard/spear-thrown'
  readonly local: string; // 'spear', 'spear-thrown': the journal key segment
  readonly name: string; // 'Spear', 'Spear (thrown)'
  readonly kind: 'melee' | 'ranged';
  readonly rollKey: 'd20.attack.melee' | 'd20.attack.ranged'; // M1b modifiers match on this prefix
  readonly toHit: number;
  readonly critMin: number; // 20 unless a feature widens it
  readonly reachFt: number; // melee only; 0 for ranged
  readonly normalFt: number; // ranged only; 0 for melee
  readonly longFt: number; // ranged only; 0 for melee
  readonly damage: readonly CompiledDamage[];
  /** Index into CompiledTemplate.gear for a thrown weapon that can run out; -1 otherwise. */
  readonly gear: number;
  /** Set when this attack throws the gear item (decrements it under monsterThrownWeapons=gearCount). */
  readonly consumesGear: boolean;
  /** The injected core:unarmed-strike. */
  readonly unarmed: boolean;
  /** A spell attack (bound into a spell's program, never in tpl.attacks: it can't be an opportunity attack). */
  readonly spell: boolean;
  /**
   * M3 step 5a (RIDER): indices into the owner's tpl.riders whose filter this attack matches
   * (attack kind, range, ability, Monk weapon: decided at compile), for a hit (on: hit and
   * dealtDamage) and for a miss. undefined when none (C3: legacy attacks hash as before).
   */
  readonly onHit?: readonly number[];
  readonly onMiss?: readonly number[];
  // M3 step 5b (weapons as hand items, a PcSource with heldWeapons). Each field is undefined
  // when inert (C3): a kind: pc without heldWeapons, and every stat block, hash as before.
  /** tpl.items index of the weapon this attack is made with: it must be in a hand (or drawn as part of the attack). */
  readonly item?: number;
  /** Needs the other hand empty: a Two-Handed weapon, a Versatile weapon's two-handed grip, or loading an Ammunition weapon. */
  readonly twoHands?: true;
  /** The weapon leaves the hand when the attack is made (a Thrown weapon thrown). */
  readonly throws?: true;
  /** A Loading weapon: one shot per action, Bonus Action or Reaction. */
  readonly loading?: true;
  /** A Heavy weapon below the score it needs (STR 13 melee, DEX 13 ranged): Disadvantage on its attack rolls. */
  readonly heavyDis?: true;
  /**
   * W1 (P7, key bits): the ability index this weapon attack uses (finesse: the higher, STR on a tie)
   * and its weapon source, for its roll key (sim/attack.ts attackKeyOf). Emitted only when the
   * owner's content carries a roll-key pattern that names an attack ability or the weapon/unarmed
   * source (content/compile.ts), so every other template keeps its hash and its keys (C3).
   */
  readonly ab?: number;
  readonly src?: 'weapon';
}

/** One way to use a rider: its extra damage (on a hit, joined to the attack's damage) and the steps that run after the damage. */
export interface RiderOpt {
  readonly local: string;
  readonly name: string;
  /** Extra damage parts (an on: hit rider's top-level damage steps); undefined when none. */
  readonly extra?: readonly CompiledDamage[];
  readonly steps: readonly Step[];
}

/** RIDER (M3 step 5a): what a feature adds to its bearer's matching attacks. */
export interface CompiledRider {
  readonly local: string;
  readonly name: string;
  /** tpl.features index of the feature it comes from (its id is the rider's via). */
  readonly feature: number;
  readonly on: 'hit' | 'miss' | 'dealtDamage';
  /** Only strikes made by this activation (its local id: 'flurry'); undefined = any. */
  readonly grantedBy?: string;
  /** C1 scopes; undefined = no limit. */
  readonly once?: 'perCreature' | 'global' | 'ownTurn';
  /** res index of the pool it spends; -1 = none. */
  readonly pool: number;
  /** Points one use spends; undefined = 1. */
  readonly poolCost?: number;
  readonly when?: readonly Gate[];
  /** A choose rider names its options in keys (rider:<local>/<option>). */
  readonly chooses: boolean;
  /** One option (do), or the choose options. */
  readonly opts: readonly RiderOpt[];
  /** M3 step 5b: used without a decision whenever it can be (a mastery whose text isn't "you can": Sap, Vex). undefined otherwise (C3). */
  readonly auto?: true;
  /** Session S (repo half): a dealtDamage rider that also fires on its bearer's spells' damage without an attack roll (sim/riders.ts askSpellRiders). undefined otherwise (C3). */
  readonly spellDamage?: true;
}

/** count strikes, each made with one of the listed attack indices. */
export interface AttackGroup {
  readonly count: number;
  readonly from: readonly number[];
}

/**
 * A unit's Attack action. Each alternative is a list of groups; a turn's strikes must fit
 * one alternative (any order). PC: [[{1 + extraAttacks, every attack}]]. A monster with no
 * Multiattack: [[{1, every attack}]]. A Multiattack: its listed alternatives.
 */
export interface AttackAct {
  readonly name: string; // 'Attack' or 'Multiattack'
  readonly multi: boolean; // true for Multiattack (moveBetweenAttacks=extraAttackOnly blocks moving)
  readonly extraAttack: boolean; // true when a PC has Extra Attack
  readonly alts: readonly (readonly AttackGroup[])[];
}

/**
 * Step E (E1): a Multiattack monster may take the plain Attack action instead, "one attack roll
 * with a weapon or an Unarmed Strike" (srd-raw.txt:32705-32706; a monster may "take one of the
 * actions available to all creatures", 43908-43910). compileMonster appends it as the last
 * alternative, one strike from every attack, so no field is added to any template: its index is
 * alts.length - 1 whenever `multi` is true, else -1 (a plain monster's or a PC's only alternative
 * is already the Attack action).
 */
export function plainAlt(act: AttackAct): number {
  return act.multi ? act.alts.length - 1 : -1;
}

export interface CompiledOption {
  readonly id: Id; // 'core:dash', 'srd:goblin-warrior/nimble-escape-disengage'
  readonly local: string; // journal key segment
  readonly name: string;
  readonly cost: 'action' | 'bonus';
  readonly core: 'core:dash' | 'core:disengage';
}

export interface GearItem {
  readonly name: string;
  /** How many the creature starts with; -1 means not counted. */
  readonly count: number;
}

export interface CompiledTemplate {
  readonly id: Id;
  readonly kind: 'monster' | 'pc';
  readonly name: string;
  /** 'SRD 5.2.1 p.290', or where a test fixture came from. Never guessed. */
  readonly source: string;
  readonly size: number; // index into SIZES
  readonly ac: number;
  readonly hpMax: number; // listed average for monsters, stated max for PCs
  /** Monster HP dice (with the CON part), for monsterHp=rolled; null for PCs. */
  readonly hpFormula: ExprNode | null;
  readonly speedFt: number; // walking speed
  readonly scores: readonly number[]; // 6, ABILITIES order
  readonly saveMod: readonly number[]; // 6, ABILITIES order
  readonly initMod: number;
  /** Static initiative score: a monster's listed score, or 10 + initMod for a PC. */
  readonly initScore: number;
  readonly pb: number;
  /** Ordered: authored attacks in file order (a melee-or-ranged entry gives the melee mode then the thrown mode), then core:unarmed-strike last. */
  readonly attacks: readonly CompiledAttack[];
  readonly attackAct: AttackAct;
  /** Ordered: core:dash, core:disengage (both actions), then authored options in file order. */
  readonly options: readonly CompiledOption[];
  readonly gear: readonly GearItem[];
  /** Longest melee reach among its attacks (at least 5 from the Unarmed Strike). */
  readonly oaReachFt: number;
  readonly resist: number; // damageBit masks
  readonly vuln: number;
  readonly immune: number;
  readonly placeholder: boolean;
  readonly fidelity: 'full' | 'partial' | 'narrative';
  /** Traits, reactions, speeds and options the engine doesn't model yet; printed in reports, never approximated. */
  readonly unimplemented: readonly string[];
  /** Held or carried items that matter to the rules (a shield, a focus). */
  readonly items: readonly ItemDef[];
  /** What each hand holds at the start of a fight: an items index or -1. */
  readonly startHands: readonly [number, number];
  /** Starting resources: spell slots L1..L9 at [0..8], then pools. */
  readonly resMax: readonly number[];
  /** Effects this creature can create, each bound to it (and to a cast level): Fx.tpl indexes this. */
  readonly effects: readonly BoundEffect[];
  /** Spells it can cast, one entry per (spell, source), in character-file order. */
  readonly spells: readonly SpellEntry[];
  /** Features with an activation or a reaction (stat blocks and PCs alike). */
  readonly features: readonly CompiledFeature[];
  /** Names of the pools at res[9..]: per-rest uses (recharge is metadata only, never restored). */
  readonly pools: readonly PoolDef[];
  /** Coverage step 7.6: a monster's Recharge actions, rolled for at the start of its turn while spent; undefined when none (C3). */
  readonly rechargeUse?: readonly { readonly pool: number; readonly min: number; readonly via: Id; readonly name: string }[];
  /** Total modifier per skill (SKILLS order): ability + proficiency/expertise + flat bonuses. */
  readonly skillMod: readonly number[];
  /** Table rulings from a character file (precedence: CLI > scenario > character file > default); {} for monsters. */
  readonly flags: Readonly<Partial<RuleFlags>>;
  /**
   * M3 step 4, undefined when the source doesn't say (C3: legacy templates keep their hashes).
   * The armor it wears, for the unarmored/armored gates: 'none' or a category. Unknown (a stat
   * block, a kind: pc without the field) fails both gates closed.
   */
  readonly armor?: 'none' | 'light' | 'medium' | 'heavy';
  /** COND bits it's immune to (a stat block's Condition Immunities); undefined when none. */
  readonly condImmune?: number;
  /** M3 step 5a (RIDER): its features' riders, in feature order; undefined when none (C3). */
  readonly riders?: readonly CompiledRider[];
}

export interface PoolDef {
  readonly local: string;
  readonly name: string;
  readonly max: number;
  /** Metadata only: no rest recovery is modeled. The short form, or the source's rules as written. */
  readonly recharge: 'shortRest' | 'longRest' | 'none' | readonly RechargeRule[];
}

/** One recovery rule (metadata): when, and how much (all, a number, or the source's expression). */
export interface RechargeRule {
  readonly period: 'short' | 'long' | 'turn' | 'dawn';
  readonly amount: 'all' | number | string;
}

/** A shape that starts from its creator: `aim` asks which way (a Cone, a Line, a Cube from Self), `bearer` is around it (an Emanation). */
export type AreaFrom = 'aim' | 'bearer';
/** Coverage step 7.3: who a zone's hooks fire on; undefined is everyone in it (C3). */
export type ZoneAffects = 'notOwner' | 'foes' | 'allies';

/** A spell as content defines it, shared by every caster. */
export interface CompiledSpell {
  readonly id: Id;
  readonly local: string;
  readonly name: string;
  readonly source: string;
  /** Interned per content load, for same-spell potency (p.106). */
  readonly sid: number;
  /** 0 = cantrip. */
  readonly level: number;
  readonly cast: 'action' | 'bonus';
  readonly v: boolean;
  readonly s: boolean;
  /** 'focus': a Material component a focus can stand in for. Costly materials don't compile. */
  readonly m: 'none' | 'focus';
  readonly conc: boolean;
  /** Feet; 0 = self, 5 = touch. */
  readonly rangeFt: number;
  /** shapeKey of the area it places (see grid/area.ts), -1 if none. */
  readonly areaShape: number;
  /** Where its area starts when that's the caster, not a lattice anchor: an aim decision, or no decision at all. undefined otherwise (C3). */
  readonly areaFrom?: AreaFrom;
  /** Casting it again ends the caster's live copy first (Produce Flame), or copies stack. */
  readonly recast: 'replace' | 'stack';
  /** It puts an effect "in your hand" (conjuredHandEffectBlocksHand). */
  readonly createsInHand: boolean;
  readonly fidelity: 'full' | 'partial' | 'narrative';
  readonly unimplemented: readonly string[];
}

/** One spell as one caster has it, from one source (class list, a held item, a feat...). */
export interface SpellEntry {
  readonly spell: CompiledSpell;
  /** The casting source's local id in the character file ('druid', 'charm'). */
  readonly source: string;
  /** Spell list it counts as, for which focus works ('druid'). */
  readonly list: string;
  readonly ability: number;
  readonly toHit: number;
  readonly dc: number;
  /** tpl.items index that must be held for it to be prepared (and its free casts usable); -1. */
  readonly whileHeld: number;
  /** res index of a pool of free (slotless) casts; -1. */
  readonly freePool: number;
  /** Castable with spell slots (prepared, or a cantrip). False for free-only grants. */
  readonly slotted: boolean;
  /** The program per cast level 0..9, with that level's dice, DC and to-hit folded in; null where it can't be cast. */
  readonly prog: readonly (readonly Step[] | null)[];
  /** tpl.effects index of the concentration instance per cast level; -1 when not concentration. */
  readonly instance: readonly number[];
}

/** One activation a feature gives (an option on the bearer's turn). */
export interface CompiledActivation {
  readonly local: string;
  readonly name: string;
  /**
   * free: no action economy cost (always limited by a pool or perTurn). reaction (M3 step 5a,
   * ECON): spends the Reaction; never offered as a turn option, only by a reaction window.
   */
  readonly cost: 'action' | 'bonus' | 'free' | 'reaction';
  /** res index; -1 = free. */
  readonly pool: number;
  /** Pool points one use spends (M3 step 5a, POOLX: uses: { pool, cost }); undefined means 1 (C3). */
  readonly poolCost?: number;
  /** Usable once per turn (uses: { perTurn: 1 }); undefined when not limited that way. */
  readonly perTurn?: true;
  /** tpl.effects index of the root effect (the form itself); -1 for none. */
  readonly root: number;
  readonly steps: readonly Step[];
  /** Gates (M3 step 4): offered only while every one holds; undefined when ungated. */
  readonly when?: readonly Gate[];
  /** M3 step 6 (source target: self): the steps' frame targets the user, with no target decision; undefined otherwise (C3). */
  readonly self?: true;
  /** Coverage step 7.2: the area it places, asked for the way a spell's is (sim/zones.ts placeArea); undefined when none (C3). */
  readonly area?: { readonly shape: number; readonly from?: AreaFrom; readonly rangeFt: number };
  /** Coverage step 7.6: the lowest d6 face that recharges it (Recharge X-6; srd-raw.txt:44017-44025); undefined otherwise (C3). */
  readonly recharge?: number;
  /** Coverage step 7.6: a monster's limited action that does damage, used first (srd-raw.txt:43605-43612); undefined otherwise (C3). */
  readonly book?: true;
}

/** W1 (P7): a feature's first-attack program (Reckless Attack), run on its bearer when it takes it at a firstAttack decision. */
export interface CompiledFirstAttack {
  readonly steps: readonly Step[];
}

/** A feature's initiative hook (M3 step 5a, HOOKX): offered as an optional decision when its bearer rolls Initiative. */
export interface CompiledInitHook {
  readonly local: string;
  readonly name: string;
  /** res index of the pool a use spends; -1 = none. */
  readonly pool: number;
  readonly poolCost?: number;
  readonly steps: readonly Step[];
}

export interface CompiledFeature {
  readonly id: Id;
  readonly local: string;
  readonly name: string;
  /** An option it gives (assume a form): its cost, the pool it spends, and the root effect its steps run under. */
  readonly activate: CompiledActivation | null;
  /**
   * M3 step 5a: the feature's further activations when its source lists several (Monk's Focus:
   * Flurry of Blows, Patient Defense, Step of the Wind and their Focus forms). undefined when it
   * has one (C3). Legal 'use' items carry the activation in `aux` (0 = activate, k = more[k-1]).
   */
  readonly more?: readonly CompiledActivation[];
  /** M3 step 5a (HOOKX): what it may do when its bearer rolls Initiative; undefined when nothing. */
  readonly onInit?: CompiledInitHook;
  /** A Reaction in the window before another creature's D20 Test. */
  readonly preRoll: {
    readonly rangeFt: number;
    readonly self: 'yes' | 'no' | 'textSilent';
    /** res index. */
    readonly pool: number;
    readonly die: ExprNode;
    /** +1 adds, -1 subtracts, 0 = chosen when used. */
    readonly sign: 1 | -1 | 0;
    /** Bits 1 << RK.attack | 1 << RK.save | 1 << RK.check for the roll kinds it covers. */
    readonly kinds: number;
  } | null;
  /** tpl.effects indexes of the effects on the bearer from fight start (passive); undefined when it has none. */
  readonly passive?: readonly number[];
  /**
   * M3 step 5a (REACT hitTaken): a Reaction when an attack roll hits the bearer, taken after the
   * damage is rolled, reducing that attack's damage against it (Deflect Attacks,
   * srd-raw.txt:11154-11158). undefined when it has none (C3).
   */
  readonly hitTaken?: {
    /** The reduction, rolled when used; 'halve' halves the damage instead. */
    readonly reduce: ExprNode | 'halve';
    /** damageBit mask: only when the damage includes one of these types; 0 = any damage. */
    readonly types: number;
    /** res index of the pool it spends; -1 = none. */
    readonly pool: number;
    readonly poolCost?: number;
    /** W1 (P11): only against an attacker the bearer can see (Uncanny Dodge, srd-raw.txt:13840); undefined otherwise (C3). */
    readonly sees?: true;
  };
  /**
   * M3 step 8'a (the hit-known window, sim/d20.ts): a Reaction when an attack roll hits the
   * bearer, after the hit is known and before damage, that raises its AC against that attack
   * (Shield, srd-raw.txt:30659-30670; Parry, 50631-50633). undefined when it has none (C3).
   */
  readonly hitKnown?: {
    /** Bits: 1 melee attack rolls, 2 ranged ones. */
    readonly attacks: number;
    /** AC added against the triggering attack only (Parry's +2); 0 = none. */
    readonly ac: number;
    /** res index of the pool it spends; -1 = none. */
    readonly pool: number;
    readonly poolCost?: number;
    /** Run on the bearer before the attack is checked again (Shield's AC effect until its next turn). */
    readonly steps: readonly Step[];
  };
  /**
   * M3 step 8'a (the damage-taken window): a Reaction after the bearer takes damage from a
   * creature it can see within rangeFt, its steps run with that creature as the target (Hellish
   * Rebuke, srd-raw.txt:27953-27961). undefined when it has none (C3).
   */
  readonly damageTaken?: {
    readonly rangeFt: number;
    /** res index of the pool it spends; -1 = none. */
    readonly pool: number;
    readonly poolCost?: number;
    readonly steps: readonly Step[];
  };
  /**
   * Coverage step 9+ (the declare-time window, sim/d20.ts declaredWindow): a Reaction when a creature
   * the bearer can see makes an attack roll against it, before the roll: the bearer swaps places with
   * an ally of a size from minSize to maxSize within rangeFt, and the ally becomes the target
   * (Redirect Attack: "a Small or Medium ally", srd-raw.txt:48831-48834). undefined when it has none (C3).
   */
  readonly declared?: {
    readonly swapRangeFt: number;
    /** SIZES index (0, Tiny, when the content names no minimum). */
    readonly swapMinSize: number;
    /** SIZES index. */
    readonly swapMaxSize: number;
  };
  /**
   * W1 (P7): offered at its bearer's first attack roll on its turn (a firstAttack decision), run on
   * the bearer before that roll (Reckless Attack, srd-raw.txt:5021-5022). After P10, also any steps
   * other features append to it (Frenzy). undefined when it has none (C3).
   */
  readonly firstAttack?: CompiledFirstAttack;
  /**
   * W1 (P8): reduced to 0 Hit Points but not killed outright, the bearer drops to 1 instead, spending
   * one use of res index `pool` (Relentless Endurance, srd-raw.txt:19928-19931). undefined when it has none (C3).
   */
  readonly dropToOne?: { readonly pool: number };
}

// ---- Effects (M1b). Compiled once per (template, spell or feature, cast level), with every
// @var folded to a number, so a hook that fires turns later already has its cast level's dice.

/** A roll modifier an effect carries. `side`: on the bearer's own rolls, or on rolls against it. */
export interface CompiledMod {
  readonly on: readonly KeyPattern[];
  readonly side: 'self' | 'incoming';
  readonly op: 'adv' | 'dis' | 'flat' | 'preDice' | 'floor';
  /** flat: the bonus; floor: the lowest d20 face. */
  readonly value: number;
  /** preDice: the die (Guidance's 1d4). */
  readonly dice: ExprNode | null;
  /** A one-use rider: the first roll it applies to ends its effect. */
  readonly consume: boolean;
  /** Checks only: applies only when the check's skill is the one chosen at cast (Fx.param). */
  readonly skillParam: boolean;
  /** Gates (M3 step 4): folds only while every one holds; undefined when ungated. */
  readonly when?: readonly Gate[];
  /** M3 step 5b: an incoming mod that applies only to the effect owner's rolls (Vex: "your next attack roll against that creature"); undefined = anyone's. */
  readonly ownerOnly?: true;
}

/**
 * A pure predicate over live state (M3 step 4, GATE): no dice. `bearer` is the creature the
 * effect sits on (or the activating creature); targetHas looks at the roll's target (the
 * creature attacked; for an incoming mod that is the bearer itself).
 */
export type Gate =
  | { readonly g: 'unarmored' | 'noShield' | 'armored' | 'notIncapacitated' | 'ownTurn' | 'hasntMoved' }
  // Coverage step 9+: an ally of the bearer (not the bearer) within 5 ft of the roll's target, not Incapacitated (Pack Tactics).
  | { readonly g: 'allyWithin5ftOfTarget' }
  | { readonly g: 'targetHas'; readonly bit: number }
  // M3 step 5b (held-item gates): a Shield in either hand; the item this feature belongs to (bound
  // at compile: the PC's item or weapon whose `magic` names the feature; -1 = none, always false)
  // in either hand; the Light property's extra attack is open (sim/stats.ts).
  | { readonly g: 'shieldHeld' | 'lightExtra' }
  | { readonly g: 'holding'; readonly item: number }
  // Session S (repo half), coverage S3's minimal form: the bearer has a live effect it owns whose
  // template is units[bearer].tpl.effects[fx] (bound at compile from a local effect id; -1 never holds).
  // W1 (P3): a qualified '<feature id>#<effect>' binds at PC compile to that feature's effect, or -1.
  | { readonly g: 'selfHas'; readonly fx: number }
  // W1 (P11): armor none, light or medium (unknown armor fails closed, like unarmored and armored).
  | { readonly g: 'notHeavyArmor' }
  // W1 (P5): the roll as resolved has Advantage; it doesn't have Disadvantage. Fail closed with no roll.
  | { readonly g: 'rollAdv' | 'rollNotDis' }
  // W1 (P5): every gate of at least one list holds (one level deep).
  | { readonly g: 'anyOf'; readonly any: readonly (readonly Gate[])[] };

/**
 * One stat an effect gives its bearer (M3 step 4, STAT). Read live by the AC, speed, damage,
 * crit and opportunity-attack sites (sim/stats.ts), each gated by `when`.
 */
export type CompiledStat = (
  | { readonly k: 'ac'; readonly n: number }
  | { readonly k: 'acFloor'; readonly n: number }
  /** noStack (M3 step 5b): bonuses or penalties with the same key don't add up; the largest penalty (or bonus) counts once (Slow). */
  | { readonly k: 'speed'; readonly mode: 'half' | 'zero' | 'add'; readonly n: number; readonly noStack?: string }
  | { readonly k: 'resist' | 'vuln' | 'immune'; readonly mask: number }
  | { readonly k: 'critMin'; readonly n: number }
  | { readonly k: 'noOpportunityAttacks' }
  | { readonly k: 'damageType'; readonly type: number; readonly on: 'unarmed' }
  /** M3 step 5a: a Fly Speed in feet. The grid has no altitude: a flier moves on the ground (flyingAvoidsGroundZones). */
  | { readonly k: 'fly'; readonly n: number }
  /**
   * M3 step 5b: +N to attack and damage rolls made with the weapon this feature belongs to (a
   * magic Weapon +N). Folded into that weapon's attacks when the PC compiles (PcSource weapon
   * `magic: <feature id>`); nothing reads it live.
   */
  | { readonly k: 'magicWeapon'; readonly n: number }
  /** W1 (P2): the bearer can't cast spells (srd-raw.txt:4981). */
  | { readonly k: 'noCasting' }
  /** W1 (P2): the bearer can't maintain Concentration (srd-raw.txt:4980). */
  | { readonly k: 'noConcentration' }
) & { readonly when?: readonly Gate[] };

/** When an effect's hook fires. Zone hooks are looked up by cell, bearer hooks by unit, owner hooks by caster. */
export const HOOK = {
  appear: 1, // a zone appears over a creature
  movedOnto: 2, // a zone moves into a creature's space
  enter: 4, // a creature enters a zone
  travel: 8, // per 5 ft a creature travels in a zone
  turnEndIn: 16, // a creature ends its turn in a zone
  turnStart: 32, // the bearer starts its turn
  turnEnd: 64, // the bearer ends its turn
  damaged: 128, // the bearer takes damage
  slotHeal: 256, // the owner casts a spell with a slot whose heal step resolves on a creature
} as const;
export const HOOK_NAMES = ['appear', 'movedOnto', 'enter', 'travel', 'turnEndIn', 'turnStart', 'turnEnd', 'damaged', 'slotHeal'] as const;
export type HookName = (typeof HOOK_NAMES)[number];

export interface CompiledHook {
  readonly on: number; // HOOK bits
  readonly steps: readonly Step[];
}

/** An option an effect grants while it lasts (move the zone, hurl the flame, the form's shot). */
export interface CompiledGrant {
  readonly local: string;
  readonly name: string;
  readonly cost: 'action' | 'bonus';
  /** Only on the owner's turns after the one it was created on ("on later turns"). */
  readonly laterTurns: boolean;
  /** Who gets the option: the effect's owner, or the creature bearing it (M3: escaping Entangle). */
  readonly to: 'owner' | 'bearer';
  readonly steps: readonly Step[];
  /** Gates (M3 step 4): offered only while every one holds; undefined when ungated. */
  readonly when?: readonly Gate[];
}

/** How long an effect lasts when it isn't simply tied to its parent. */
export type Duration =
  | { readonly k: 'parent' }
  | { readonly k: 'rounds'; readonly n: number }
  /** thisTurn (W1, P11): the end of the current turn, not the next one (endOfThisTurn: Steady Aim, srd-raw.txt:13793-13794); undefined otherwise (C3). */
  | { readonly k: 'untilTurn'; readonly edge: 'start' | 'end'; readonly of: 'owner' | 'bearer'; readonly thisTurn?: true };

/** W1 (P1): BoundEffect.sustain bits, what extends a sustained effect on its bearer's turn. */
export const SUSTAIN = { attackRoll: 1, enemySave: 2 } as const;

/** What ends an effect besides its duration and its parent. */
export const END = { incap: 1, dismiss: 2 } as const;

export interface BoundEffect {
  readonly id: Id; // 'srd:moonbeam/beam', 'srd:guiding-bolt/lit', 'srd:moonbeam/concentration'
  readonly local: string;
  readonly name: string;
  /** Interned spell id for same-spell potency (p.106); -1 for features. */
  readonly sid: number;
  /** Cast level (0 for cantrips and features): the potency rank between copies of one spell. */
  readonly lvl: number;
  /** `from`: its anchor is a creature's square (with an aim, or none), not a lattice point; undefined for a lattice zone (C3). */
  readonly zone: { readonly shapeKey: number; readonly heightFt: number; readonly difficult: boolean; readonly from?: AreaFrom; readonly affects?: ZoneAffects; readonly offWhenIncap?: true } | null;
  readonly dur: Duration;
  /** At most one firing per creature per turn (any creature's turn), or none. */
  readonly limit: 'none' | 'perCreature';
  readonly endsOn: number; // END bits
  /** Held in the owner's hand (a conjured flame): conjuredHandEffectBlocksHand decides whether it fills one. */
  readonly inHand: boolean;
  /** Using the source again ends the owner's live effects in the same group (recasting, re-activating). */
  readonly group: string | null;
  readonly mods: readonly CompiledMod[];
  readonly hooks: readonly CompiledHook[];
  readonly hookMask: number;
  readonly grants: readonly CompiledGrant[];
  /** A hook moves creatures or zones or applies or ends effects: the order of simultaneous handlers can matter. */
  readonly interacts: boolean;
  /** A concentration instance (the spell itself while concentrated on). */
  readonly conc: boolean;
  // M3 step 4. Every field below is undefined when inert (critique C3), so effects that don't
  // use them serialize, and hash, exactly as before.
  /** COND bits it imposes on its bearer while it lasts (a condition step's effect). */
  readonly cond?: number;
  /** It ends when its bearer takes damage (a condition's endsOnDamage). */
  readonly endsOnDamage?: true;
  /** COND bits its bearer is immune to while it lasts. */
  readonly condImmune?: number;
  /** Stats it gives its bearer. */
  readonly stats?: readonly CompiledStat[];
  /** Coverage step 9: a hidden zone's Search DC (the caster's spell save DC); undefined for every other effect. */
  readonly hiddenDc?: number;
  /** W1 (P1): a sustained effect's SUSTAIN bits (Rage); undefined for every other effect (C3). */
  readonly sustain?: number;
}

/** One step of an effect program, bound to its caster and cast level. */
export type Step =
  | { readonly k: 'target'; readonly rangeFt: number; readonly who: 'any' | 'ally' | 'enemy'; readonly self: 'yes' | 'no' | 'textSilent'; readonly maxSize: number }
  | { readonly k: 'attack'; readonly atk: CompiledAttack; readonly onHit: readonly Step[]; readonly onMiss: readonly Step[] }
  | {
      readonly k: 'save';
      readonly ability: number;
      readonly key: number;
      readonly dc: number;
      readonly dmg: readonly CompiledDamage[] | null;
      readonly half: boolean;
      readonly onFail: readonly Step[];
      readonly onSuccess: readonly Step[];
      /** 8'a review R2, omitted when inert (C3): 'partial' = no benefit from Half or Three-Quarters Cover for this save (Sacred Flame, srd-raw.txt:30314-30315). */
      readonly ignoresCover?: 'partial';
      /** Coverage step 7.4: the text gives the target Advantage on this save (sim/d20.ts saveSpec). */
      readonly targetAdv?: true;
    }
  | { readonly k: 'damage'; readonly dmg: readonly CompiledDamage[] }
  | { readonly k: 'heal'; readonly roll: ExprNode }
  /** when (W1, P3): gates on the program's owner, checked as the step runs; undefined when ungated (C3). */
  | { readonly k: 'apply'; readonly fx: number; readonly to: 'self' | 'target' | 'point'; readonly when?: readonly Gate[] }
  | { readonly k: 'moveZone'; readonly ft: number }
  | { readonly k: 'forced'; readonly mode: 'pull' | 'push'; readonly maxFt: number; readonly maxSize: number; readonly straight?: true; readonly exact?: true }
  | { readonly k: 'choose'; readonly opts: readonly { readonly local: string; readonly name: string; readonly steps: readonly Step[] }[] }
  | { readonly k: 'chooseSkill' }
  /** Fires grant `grant` of the effect the step before applied (`fx`, a tpl.effects index), at no cost. */
  | { readonly k: 'use'; readonly fx: number; readonly grant: number }
  // M3 step 4.
  /**
   * Imposes a condition on the targets: `fx` is the condition's own effect (tpl.effects index;
   * it carries the bits, the repeat save, the escape and endsOnDamage), or -1 for Prone, which
   * content imposes as a plain instance that lasts until the creature rights itself. dropHeld
   * (coverage step 7.4): gaining it drops what the creature holds (Fear; always for Unconscious).
   */
  | { readonly k: 'condition'; readonly fx: number; readonly bit: number; readonly dropHeld?: true }
  /**
   * A condition's repeat save (its effect's turnEnd hook): success ends the effect the hook belongs
   * to. onFail (coverage step 7.4, Sleep's second stage): runs on a failure, under the first stage's
   * parent, so what it imposes outlives the first stage.
   */
  | { readonly k: 'condSave'; readonly ability: number; readonly key: number; readonly dc: number; readonly onFail?: readonly Step[] }
  /** An ability check by the acting creature (an escape): the best of `skills` (SKILLS indices) or the plain ability. */
  | { readonly k: 'check'; readonly ability: number; readonly skills: readonly number[]; readonly dc: number; readonly onSuccess: readonly Step[]; readonly onFail: readonly Step[] }
  /** Ends the effect whose grant or hook is running (a successful escape). */
  | { readonly k: 'endSource' }
  /** Temporary Hit Points: one roll for the group; each target keeps the higher (they don't stack). */
  | { readonly k: 'tempHp'; readonly roll: ExprNode }
  // M3 step 5a.
  /**
   * WATK: `count` strikes, each with one of the acting creature's own attacks (`from`, tpl.attacks
   * indices: the Unarmed Strike, one weapon, or every weapon it has for `held`), each at a target
   * it picks then. `noAbility`, when set, is `from`'s attacks with the ability modifier left out
   * of the damage unless negative (aligned with `from`).
   */
  | {
      readonly k: 'weaponAttack';
      readonly from: readonly number[];
      readonly count: number;
      readonly noAbility: readonly CompiledAttack[] | null;
      /** M3 step 5b: the Light property's extra attack: only a Light weapon other than the one the Attack action used (sim/steps.ts). */
      readonly lightExtra?: true;
      /** M3 step 5b (Cleave): only a creature within 5 ft of the frame's target (the creature hit), not that one, and only melee attacks. */
      readonly near?: true;
    }
  /** ECON: a core action's effect at no further cost (the activation paid for it): Dash, Disengage or Dodge. */
  | { readonly k: 'core'; readonly act: 'dash' | 'disengage' | 'dodge' }
  /** ECON: the acting creature gains one more action this turn. */
  | { readonly k: 'gainAction' }
  /** POOLX: change a pool (res index) by a constant, or refill it; clamped to [0, max]. */
  | { readonly k: 'pool'; readonly res: number; readonly delta: number | 'refill' }
  /**
   * Session S (repo half): the targets become every living creature in an Emanation of `sizeFt`
   * around the program's owner (grid/area.ts shape key `key`), the owner excluded; `who` filters
   * the owner's side (ally), its hostiles (enemy) or neither (any).
   */
  | { readonly k: 'around'; readonly key: number; readonly sizeFt: number; readonly who: 'any' | 'ally' | 'enemy' }
  // W1 (docs/design/w1-plan.md).
  /** P1: the effect whose grant is running (a sustained one) lasts until the end of its bearer's next turn again. */
  | { readonly k: 'extendSource' }
  /** P11: the conditions in `bits` (COND) end on the program's owner. */
  | { readonly k: 'endConditions'; readonly bits: number }
  /** P9: the owner may move up to half its Speed without provoking Opportunity Attacks (a moveTo decision). */
  | { readonly k: 'move'; readonly speed: 'half'; readonly noOpportunityAttacks: true };

export interface ItemDef {
  readonly local: string;
  readonly name: string;
  /** M3 step 5b: 'weapon', a PcSource weapon held in a hand (heldWeapons). */
  readonly kind: 'shield' | 'focus' | 'pouch' | 'object' | 'weapon';
  /** Spell lists it works as a focus for ('druid'). */
  readonly focusFor: readonly string[];
  /** AC it adds while held (a shield). */
  readonly shieldAc: number;
  /** M3 step 5b: a weapon with the Light property; undefined otherwise (C3). */
  readonly light?: true;
  /** M3 step 5b: the feature (a magic item) this item is: its itemHeld gates look at this item. undefined when none. */
  readonly magic?: string;
}

export interface PackInfo {
  readonly pack: string;
  readonly namespace: Exclude<Namespace, 'core'>;
  readonly license: 'CC-BY-4.0' | 'private' | 'test';
  readonly attribution: string | null;
}

export interface Content {
  /** Sorted by id with <. */
  readonly templates: readonly CompiledTemplate[];
  readonly packs: readonly PackInfo[];
  /** hash64 over the canonical form of every loaded item, independent of file order, comments and key order. */
  readonly hash: string;
  get(id: string): CompiledTemplate | undefined;
}
