// Content schemas (zod 4). Every object is strict, so a misspelled key is an error with a
// file:line:col, never a silently ignored field. Cross-field checks that need positions or
// other items (Multiattack refs, thrown gear, namespaces) live in load.ts and compile.ts;
// the refinements here only see one object. Refinements don't reach the JSON Schemas.

import { z } from 'zod';
import { MAX_H, MAX_W } from '../grid/cells.ts';
import { FLAG_INFO, FLAG_KEYS, type RuleFlags } from '../rules/flags.ts';
import { DEFAULT_KNOBS } from '../sim/setup.ts';
import { SKILLS, compileKeyPattern } from './rollkeys.ts';
import { ABILITIES, CONTENT_CONDS, DAMAGE_TYPES, HOOK_NAMES, SIZES, type Ability, type Size } from './types.ts';

const SEG = '[a-z0-9]+(?:-[a-z0-9]+)*';
/** A kebab-case name: pack names, scenario ids, local ids. */
export const KEBAB = new RegExp(`^${SEG}$`);
/** A pack name: kebab-case, dots allowed for versions ('srd-5.2.1'). */
export const PACK_NAME = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/;
/** A namespaced id with optional '/' children: 'srd:guard', 'srd:guard/spear'. */
export const ID_PATTERN = new RegExp(`^(core|srd|private|test):${SEG}(?:/${SEG})*$`);

export const IdSchema = z.string().regex(ID_PATTERN, 'expected an id like srd:goblin-warrior');
const LocalId = z.string().regex(KEBAB, 'expected a kebab-case id like short-sword');
const Name = z.string().min(1);
const AbilitySchema = z.enum(ABILITIES);
const DamageTypeSchema = z.enum(DAMAGE_TYPES);
const SizeSchema = z.enum(SIZES);
const Ft = z.int().min(0).multipleOf(5);
const ReachFt = z.int().min(5).multipleOf(5);
const RangeFt = z.int().min(5).multipleOf(5);
/** [normal, long] in feet. */
const RangePair = z
  .tuple([RangeFt, RangeFt])
  .refine(([normal, long]) => normal <= long, 'range is [normal, long] and normal must not exceed long');
const Score = z.int().min(1).max(30);
const Abilities = z.strictObject({ str: Score, dex: Score, con: Score, int: Score, wis: Score, cha: Score });
/** A dice expression ('1d6 + 2'); parsed at compile so errors carry a position. */
const Expr = z.string().min(1);

const Damage = z.strictObject({
  roll: Expr,
  type: DamageTypeSchema,
  /** The stat block's printed average; lint checks it against floor(mean). */
  avg: z.int().optional(),
  /** Rider that applies only if the attack roll had Advantage (goblin weapons). */
  ifAdvantage: z.boolean().default(false),
});

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'expected a sha256 in lower-case hex');

/**
 * Where an imported item came from (docs/design/m3.md 2.1). Only the importer writes it.
 * Metadata: in the content hash (it's part of the item) but never compiled into a template,
 * so it never moves a closure hash.
 */
const ProvenanceOverride = z.strictObject({ file: z.string().min(1), sha256: Sha256 });
const CommitRef = z.string().regex(/^[0-9a-f]{40}$/, 'expected a full 40-character commit sha');

const FoundryProvenance = z.strictObject({
  source: z.literal('foundry-dnd5e'),
  /** The pinned commit of the source repository. */
  ref: CommitRef,
  /** The record's path inside that repository. */
  path: z.string().min(1),
  /** The record's own id there. */
  foreignId: z.string().min(1),
  recordSha256: Sha256,
  /** The importer's version. */
  importer: z.int().min(1),
  /** Hand fixes applied on top of the record, by file and content hash. */
  overrides: z.array(ProvenanceOverride).optional(),
  pdfPage: z.int().min(1).optional(),
  crossCheck: z.strictObject({ open5e: z.enum(['agree', 'disagree', 'missing']) }).optional(),
  review: z.enum(['auto', 'reviewed']),
});

/**
 * An item hand-authored from the SRD 5.2.1 PDF that stands in for a Foundry record the
 * importer quarantined (license, C21): its source is the PDF page, never the record. `replaces`
 * names the quarantined record only so a later pin can tell the stand-in is still needed.
 */
const SrdPdfProvenance = z.strictObject({
  source: z.literal('srd-pdf'),
  pdfPage: z.int().min(1),
  importer: z.int().min(1),
  overrides: z.array(ProvenanceOverride).min(1),
  replaces: z.strictObject({ ref: CommitRef, path: z.string().min(1), foreignId: z.string().min(1), recordSha256: Sha256 }).optional(),
  /** hand: written from the PDF by whoever wrote the override; reviewed: checked against it since. */
  review: z.enum(['hand', 'reviewed']),
});

const ProvenanceSchema = z.discriminatedUnion('source', [FoundryProvenance, SrdPdfProvenance]);

const common = {
  id: IdSchema,
  name: Name,
  /** 'SRD 5.2.1 p.290', or where a fixture came from. Never guessed. */
  source: z.string().min(1),
  fidelity: z.enum(['full', 'partial', 'narrative']).default('full'),
  /** A stamp printed on every report that uses this item. */
  placeholder: z.boolean().default(false),
  /** Traits, reactions and options the engine doesn't model; printed, never approximated. */
  unimplemented: z.array(z.string().min(1)).default([]),
  provenance: ProvenanceSchema.optional(),
};

export const ManifestSchema = z
  .strictObject({
    kind: z.literal('manifest'),
    pack: z.string().regex(PACK_NAME, 'pack names are kebab-case (dots allowed, like srd-5.2.1)'),
    version: z.string().min(1),
    rules: z.literal('2024'),
    namespace: z.enum(['srd', 'private', 'test']),
    license: z.enum(['CC-BY-4.0', 'private', 'test']),
    attribution: z.string().min(1).optional(),
    /** Other packs (by name) this pack's content needs loaded. */
    requires: z.array(z.string().regex(PACK_NAME)).default([]),
  })
  .superRefine((m, ctx) => {
    if ((m.namespace === 'private') !== (m.license === 'private')) {
      ctx.addIssue({ code: 'custom', path: ['license'], message: 'namespace private requires license private, and the reverse' });
    }
    if ((m.namespace === 'test') !== (m.license === 'test')) {
      ctx.addIssue({ code: 'custom', path: ['license'], message: 'namespace test requires license test, and the reverse' });
    }
    if (m.license === 'CC-BY-4.0' && m.attribution === undefined) {
      ctx.addIssue({ code: 'custom', path: ['license'], message: 'CC-BY-4.0 packs need an attribution statement' });
    }
  });

const MonsterAttack = z
  .strictObject({
    id: LocalId,
    name: Name,
    /** meleeOrRanged compiles to two attacks: <id> (melee) and <id>-thrown (ranged). */
    kind: z.enum(['melee', 'ranged', 'meleeOrRanged']),
    toHit: z.int(),
    /**
     * Coverage C0: the ability a printed to-hit uses when it's neither STR nor DEX mod + PB (a
     * stat block's spell attack, e.g. the SRD Druid's Vine Staff, WIS). Lint data only: the
     * engine uses toHit as printed, and the lint checks toHit = that mod + PB. Never compiled.
     */
    toHitAbility: z.enum(['con', 'int', 'wis', 'cha']).optional(),
    /** Melee reach in feet; default 5. */
    reach: ReachFt.optional(),
    range: RangePair.optional(),
    /** meleeOrRanged only: the gear entry (by name) that each throw uses up. */
    thrownGear: z.string().min(1).optional(),
    damage: z.array(Damage).min(1),
  })
  .superRefine((a, ctx) => {
    if (a.kind === 'melee' && a.range !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['range'], message: 'a melee attack has no range (use kind: meleeOrRanged for a thrown weapon)' });
    }
    if (a.kind === 'ranged' && a.reach !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['reach'], message: 'a ranged attack has no reach' });
    }
    if (a.kind !== 'melee' && a.range === undefined) {
      ctx.addIssue({ code: 'custom', path: ['kind'], message: `a ${a.kind} attack needs range: [normal, long]` });
    }
    if (a.thrownGear !== undefined && a.kind !== 'meleeOrRanged') {
      ctx.addIssue({ code: 'custom', path: ['thrownGear'], message: 'thrownGear is only for meleeOrRanged attacks' });
    }
  });

const AttackGroup = z.strictObject({
  count: z.int().min(1).max(8),
  /** Attack ids; a meleeOrRanged id stands for both of its modes. */
  from: z.array(LocalId).min(1),
});

const MonsterOption = z.strictObject({
  id: LocalId,
  name: Name,
  cost: z.enum(['action', 'bonus']),
  core: z.enum(['core:dash', 'core:disengage']),
});

/**
 * Coverage step 7.6, the monster-features seam: an action printed in a stat block, inline (no closure
 * change). uses: Recharge X-Y as [X, Y] ([6] for Recharge 6; srd-raw.txt:44017-44025), or n per day
 * (never returns: no rest recovery). Without uses it's at will. area and range are a feature
 * activation's; effects and do are its program, compiled with plain dice, the printed DC on each save.
 */
const MonsterAction = z.strictObject({
  id: LocalId,
  name: Name,
  cost: z.literal('action'),
  uses: z.union([z.strictObject({ recharge: z.array(z.int().min(1).max(6)).min(1).max(2) }), z.strictObject({ perDay: z.int().min(1).max(9) })]).optional(),
  area: LocalId.optional(),
  range: z.union([z.literal('self'), RangeFt]).optional(),
  effects: z.lazy(() => z.array(EffectSchema)).default([]),
  do: z.lazy(() => z.array(StepSchema).min(1)),
});

/**
 * Coverage step 9+: a stat block's trait whose effects sit on the monster from fight start, as a
 * feature's passive (Pack Tactics: an attack-roll Advantage gated by allyWithin5ftOfTarget,
 * srd-raw.txt:54928-54931, 55578-55580). Every listed effect is passive.
 */
const MonsterTrait = z.strictObject({
  id: LocalId,
  name: Name,
  effects: z.lazy(() => z.array(EffectSchema).min(1)),
});

/**
 * Coverage step 9+: a stat block's Reaction.
 *   hitKnown: Parry's shape, "Trigger: The knight is hit by a melee attack roll while holding a
 *   weapon. Response: The knight adds 2 to its AC against that attack, possibly causing it to miss"
 *   (srd-raw.txt:50631-50633, 55655-55657), in the hit-known window (sim/d20.ts). whileHolding:
 *   weapon needs a Gear entry named like one of its attacks; a stat block has no hand model, so it
 *   holds that weapon throughout [U].
 *   attackDeclared: Redirect Attack's shape, "Trigger: A creature the goblin can see makes an attack
 *   roll against it. Response: The goblin chooses a Small or Medium ally within 5 feet of itself. The
 *   goblin and that ally swap places, and the ally becomes the target of the attack instead"
 *   (srd-raw.txt:48831-48834), in the declare-time window (sim/d20.ts declaredWindow), before the
 *   attack roll is built.
 */
const MonsterReaction = z.discriminatedUnion('window', [
  z.strictObject({
    id: LocalId,
    name: Name,
    window: z.literal('hitKnown'),
    attacks: z.array(z.enum(['melee', 'ranged'])).min(1),
    ac: z.int().min(1).max(10),
    whileHolding: z.literal('weapon').optional(),
  }),
  z.strictObject({
    id: LocalId,
    name: Name,
    window: z.literal('attackDeclared'),
    swap: z.strictObject({ range: RangeFt, minSize: SizeSchema.optional(), maxSize: SizeSchema }),
  }),
]);

const GearEntry = z.strictObject({
  name: Name,
  /** How many it carries; omit for items that aren't counted. */
  count: z.int().min(0).optional(),
});

const Cr = z.union([
  z.int().min(0).max(30),
  z.string().regex(/^(?:0|1\/8|1\/4|1\/2|[1-9]|[12][0-9]|30)$/, 'expected a challenge rating like 1/4 or 3'),
]);

const Saves = z.strictObject({
  str: z.int().optional(),
  dex: z.int().optional(),
  con: z.int().optional(),
  int: z.int().optional(),
  wis: z.int().optional(),
  cha: z.int().optional(),
});

export const MonsterSchema = z.strictObject({
  kind: z.literal('monster'),
  ...common,
  size: SizeSchema,
  cr: Cr,
  pb: z.int().min(2).max(9),
  ac: z.int().min(1),
  hp: z.strictObject({ average: z.int().min(1), formula: Expr }),
  speed: z.strictObject({ walk: Ft, burrow: Ft.optional(), climb: Ft.optional(), fly: Ft.optional(), swim: Ft.optional() }),
  initiative: z.strictObject({ mod: z.int(), score: z.int() }),
  abilities: Abilities,
  /** Save modifiers that differ from the ability modifier. */
  saves: Saves.default({}),
  resist: z.array(DamageTypeSchema).default([]),
  vuln: z.array(DamageTypeSchema).default([]),
  immune: z.array(DamageTypeSchema).default([]),
  /** Condition Immunities (M3 step 4); omitted when none. */
  conditionImmune: z.array(z.enum(CONTENT_CONDS)).min(1).optional(),
  /**
   * M3 step 6: the stat block's Skills line, as data. Not compiled (no template field moves, C3):
   * monster checks still use the ability modifier (step 4).
   */
  skills: z.partialRecord(z.enum(SKILLS.map(([s]) => s) as [string, ...string[]]), z.int()).optional(),
  /** M3 step 6: the stat block's Senses line, as data. Not compiled: line of sight is stubbed. */
  senses: z
    .strictObject({ blindsight: Ft.optional(), darkvision: Ft.optional(), tremorsense: Ft.optional(), truesight: Ft.optional(), passivePerception: z.int().min(0) })
    .optional(),
  gear: z.array(GearEntry).default([]),
  attacks: z.array(MonsterAttack).default([]),
  multiattack: z
    .strictObject({
      name: Name.default('Multiattack'),
      alternatives: z.array(z.array(AttackGroup).min(1).max(4)).min(1).max(8),
    })
    .optional(),
  options: z.array(MonsterOption).default([]),
  /** Coverage step 7.6: limited or area actions; omitted when none. */
  actions: z.array(MonsterAction).min(1).optional(),
  /** Coverage step 9+: traits with passive effects (Pack Tactics); omitted when none. */
  traits: z.array(MonsterTrait).min(1).optional(),
  /** Coverage step 9+: Reactions (Parry, Redirect Attack); omitted when none. */
  reactions: z.array(MonsterReaction).min(1).max(4).optional(),
});

/** The Mastery Properties (SRD 5.2.1 p.90, srd-raw.txt:20406-20467). */
export const MASTERIES = ['cleave', 'graze', 'nick', 'push', 'sap', 'slow', 'topple', 'vex'] as const;
export type Mastery = (typeof MASTERIES)[number];

const PcWeapon = z
  .strictObject({
    id: LocalId,
    name: Name,
    kind: z.enum(['melee', 'ranged']),
    /** finesse uses the higher of STR and DEX. */
    ability: z.enum(['str', 'dex', 'finesse']),
    proficient: z.boolean().default(true),
    /** Flat to-hit bonus (a +1 weapon); damage bonuses go in the roll. */
    bonus: z.int().default(0),
    reach: ReachFt.optional(),
    range: RangePair.optional(),
    /** A melee weapon with the Thrown property: adds a ranged mode <id>-thrown. */
    thrownRange: RangePair.optional(),
    /** How many the PC carries of a thrown weapon: a melee weapon with thrownRange, or a ranged one thrown whole (darts). */
    count: z.int().min(0).optional(),
    /** roll may use @mod, the weapon's ability modifier. */
    damage: z.array(Damage).min(1),
    /**
     * M3 step 5a (RIDER filters): the weapon's category and its Light property, for the Monk
     * weapon filter (Simple Melee, or Martial Melee with Light, srd-raw.txt:11076-11084). Omitted,
     * a weapon is never a Monk weapon (fail closed). Compile-time only: nothing is stored (C3).
     */
    category: z.enum(['simple', 'martial']).optional(),
    light: z.literal(true).optional(),
    // ---- M3 step 5b (weapon properties, SRD 5.2.1 p.89-90, srd-raw.txt:20312-20404). Each is
    // read only under heldWeapons, except mastery/base (riders work on any PC) and magic. ----
    /** Two-Handed: attacking with it needs the other hand empty (20394-20397). */
    twoHanded: z.literal(true).optional(),
    /** Versatile: the damage roll used two-handed for a melee attack (20399-20404), e.g. 1d10 + @mod; adds a mode <id>-two-handed. */
    versatile: Expr.optional(),
    /** Heavy: Disadvantage below STR 13 (melee) or DEX 13 (ranged) (20332-20337). */
    heavy: z.literal(true).optional(),
    /** Loading: one piece of ammunition per action, Bonus Action or Reaction (20351-20358). */
    loading: z.literal(true).optional(),
    /** Ammunition: pieces carried; each attack expends one, loading needs a free hand (20312-20323). */
    ammunition: z.int().min(0).optional(),
    /** The weapon's mastery property (20406-20467); used only when `base` is among the PC's masteries. */
    mastery: z.enum(MASTERIES).optional(),
    /** The kind of weapon (its content id, srd:longsword): what Weapon Mastery chooses. */
    base: IdSchema.optional(),
    /** A magic weapon: the feature (a Weapon +N magic item) it is. Its magicWeapon stat is folded into this weapon's attacks. */
    magic: IdSchema.optional(),
  })
  .superRefine((w, ctx) => {
    if (w.versatile !== undefined && (w.kind !== 'melee' || w.twoHanded)) ctx.addIssue({ code: 'custom', path: ['versatile'], message: 'versatile is a one-handed melee weapon\'s two-handed damage' });
    if (w.ammunition !== undefined && w.kind !== 'ranged') ctx.addIssue({ code: 'custom', path: ['ammunition'], message: 'ammunition is a ranged weapon property' });
    if (w.ammunition !== undefined && w.count !== undefined) ctx.addIssue({ code: 'custom', path: ['ammunition'], message: 'a weapon is fired with ammunition or thrown whole (count), not both' });
    if (w.loading && w.kind !== 'ranged') ctx.addIssue({ code: 'custom', path: ['loading'], message: 'loading is a ranged weapon property' });
    if (w.kind === 'melee' && w.range !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['range'], message: 'a melee weapon has no range (use thrownRange for the Thrown property)' });
    }
    if (w.kind === 'ranged') {
      if (w.range === undefined) ctx.addIssue({ code: 'custom', path: ['kind'], message: 'a ranged weapon needs range: [normal, long]' });
      if (w.reach !== undefined) ctx.addIssue({ code: 'custom', path: ['reach'], message: 'a ranged weapon has no reach' });
      if (w.thrownRange !== undefined) ctx.addIssue({ code: 'custom', path: ['thrownRange'], message: 'a ranged weapon\'s range already is its thrown range; use range (and count for darts)' });
    }
    if (w.count !== undefined && w.kind === 'melee' && w.thrownRange === undefined) {
      ctx.addIssue({ code: 'custom', path: ['count'], message: 'count is for thrown weapons (set thrownRange on a melee weapon)' });
    }
  });

/** Partial rule flags, generated from FLAG_INFO so every option is an enum. */
const flagShape: Record<string, z.ZodType> = {};
for (const k of FLAG_KEYS) {
  const options = FLAG_INFO[k].options as readonly (string | boolean)[];
  flagShape[k] = z.literal(options as (string | boolean)[]).optional();
}
export const FlagsSchema = z.strictObject(flagShape) as unknown as z.ZodType<Partial<RuleFlags>>;

// ---- Effects, steps, spells and features (M1b) ----

/** Hook names the schema rejects until the milestone that adds them. */
export const RESERVED_HOOKS: Readonly<Record<string, string>> = { exit: 'M3', dealtDamage: 'M3', d20After: 'M8', d20Failed: 'M8', d20Succeeded: 'M8' };

const HookNameSchema = z.enum(HOOK_NAMES, {
  error: (iss) => {
    const v = iss.input;
    if (typeof v === 'string' && Object.hasOwn(RESERVED_HOOKS, v)) return `hook "${v}" is reserved and not modeled yet (${RESERVED_HOOKS[v]} adds it)`;
    return undefined;
  },
});

const SKILL_NAMES = SKILLS.map(([n]) => n);
const SkillSchema = z.enum(SKILL_NAMES);

/** A roll-key pattern like d20.save.con.concentration; compiled with compileKeyPattern. */
const RollKeyPat = z
  .string()
  .regex(/^d20(?:\.[a-z]+(?:-[a-z]+)*)*$/, 'expected a roll key like d20.save.con or d20.check.wis.perception')
  .superRefine((s, ctx) => {
    try {
      compileKeyPattern(s);
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      ctx.addIssue({ code: 'custom', message: e.message });
    }
  });

const SelfSchema = z.enum(['yes', 'no', 'textSilent']);

const DamageRoll = z
  .strictObject({
    roll: Expr,
    /**
     * W1 (P4): weapon, in an on: hit rider's own damage only, is the type of the attack it rides on
     * (Sneak Attack: "the same as the weapon's type", srd-raw.txt:13739; Frenzy, 5177-5178).
     */
    type: z.enum([...DAMAGE_TYPES, 'weapon']),
    /** Added once per slot level above the spell's level. */
    upcast: Expr.optional(),
    /** Cantrip damage: the dice multiply by the character-level tier (x2 at 5, x3 at 11, x4 at 17). */
    cantrip: z.boolean().default(false),
  })
  .superRefine((d, ctx) => {
    if (d.cantrip && d.upcast !== undefined) ctx.addIssue({ code: 'custom', path: ['upcast'], message: 'a cantrip-scaled part has no upcast' });
  });

const DurationSchema = z.union(
  [
    z.literal('parent'),
    z.strictObject({ rounds: z.int().min(1) }),
    z.strictObject({ minutes: z.int().min(1) }),
    /** W1 (P11): endOfThisTurn, "until the end of the current turn" (Steady Aim, srd-raw.txt:13793-13794). */
    z.strictObject({ until: z.enum(['startOfNextTurn', 'endOfNextTurn', 'endOfThisTurn']), of: z.enum(['caster', 'bearer']) }),
  ],
  { error: 'expected a duration: parent, { rounds: N }, { minutes: N } or { until: startOfNextTurn|endOfNextTurn|endOfThisTurn, of: caster|bearer }' },
);
export type DurationSrc = z.output<typeof DurationSchema>;

// ---- M3 step 4: conditions, gates, stats ----

/** A condition content can impose or be immune to. Grappled is deferred (docs/design/m3.md section 3). */
const CondSchema = z.enum(CONTENT_CONDS, {
  error: (iss) => (iss.input === 'grappled' ? 'grappled is deferred (docs/design/m3.md section 3, COND): not modeled yet' : undefined),
});

/** GATE: pure predicates (no dice), on mods, stats, grants and feature activations. */
/**
 * Coverage step 9+ adds allyWithin5ftOfTarget: at least one of the bearer's allies (not the bearer)
 * is within 5 ft of the roll's target and doesn't have the Incapacitated condition (Pack Tactics,
 * srd-raw.txt:54928-54931, 55578-55580; Sneak Attack's ally clause in W1).
 *
 * M3 step 5b adds shieldHeld (a Shield in either hand: Shield +N), itemHeld (the item this
 * feature is, bound by an item's or weapon's `magic`, in either hand) and lightExtra (the Light
 * property's extra attack is open this turn).
 */
/**
 * Session S (repo half): { selfHas: <effect id> }, the minimal form of coverage.md's S3 `selfHas`
 * seam: the bearer has a live effect, by local id, from the item that declares the gate (a feature's
 * own effects), owned by itself. A rider or activation that works only while a form is up names the
 * form's effect. Only a feature's or a spell's own effects resolve (compile error otherwise).
 */
/**
 * W1 (docs/design/w1-plan.md P3): a selfHas gate may name another feature's effect, qualified as
 * `<feature id>#<local effect id>` ('srd:barbarian/rage#raging'). It binds when the PC compiles, to
 * that feature's effect on this character, or never holds when the character doesn't have it.
 */
const QualifiedFx = z.string().regex(new RegExp(`^(core|srd|private|test):${SEG}(?:/${SEG})*#${SEG}$`), 'expected <feature id>#<effect id>');
/**
 * W1 adds notHeavyArmor (P11: armor none, light or medium; unknown armor fails closed, Fast
 * Movement and Rage, srd-raw.txt:5067-5068, 4701-4702), and the roll-state gates rollAdv (the
 * attack roll as resolved has Advantage) and rollNotDis (it doesn't have Disadvantage), read only
 * where a roll is known (P5, Sneak Attack, srd-raw.txt:13738-13743; Advantage and Disadvantage
 * together cancel, 1056-1060).
 */
const BaseGateSchema = z.union(
  [
    z.enum(['unarmored', 'noShield', 'armored', 'notIncapacitated', 'ownTurn', 'hasntMoved', 'shieldHeld', 'itemHeld', 'lightExtra', 'allyWithin5ftOfTarget', 'notHeavyArmor', 'rollAdv', 'rollNotDis']),
    z.strictObject({ targetHas: CondSchema }),
    z.strictObject({ selfHas: z.union([LocalId, QualifiedFx]) }),
  ],
  { error: 'expected a gate: unarmored, noShield, armored, notIncapacitated, ownTurn, hasntMoved, shieldHeld, itemHeld, lightExtra, allyWithin5ftOfTarget, notHeavyArmor, rollAdv, rollNotDis, { targetHas: <condition> }, { selfHas: <effect id> } or { anyOf: [[gates], [gates]] }' },
);
/** W1 (P5): { anyOf: [[gates], [gates], ...] } holds when every gate of at least one list holds; one level deep. */
const GateSchema = z
  .union([BaseGateSchema, z.strictObject({ anyOf: z.array(z.array(BaseGateSchema).min(1)).min(2) })], {
    error: 'expected a gate: unarmored, noShield, armored, notIncapacitated, ownTurn, hasntMoved, shieldHeld, itemHeld, lightExtra, allyWithin5ftOfTarget, notHeavyArmor, rollAdv, rollNotDis, { targetHas: <condition> }, { selfHas: <effect id> } or { anyOf: [[gates], [gates]] }',
  })
  // One definition in the generated JSON schemas ($defs.gate), not a copy at every `when`.
  .meta({ id: 'gate' });
const Gates = z.array(GateSchema).min(1);

const DamageTypes = z.array(DamageTypeSchema).min(1);
/** A whole number, or a constant expression over the character's variables ('@scale.monk.unarmored-movement'), folded when the character compiles. */
const StatNum = z.union([z.int(), Expr]);

/** STAT: one stat per entry, each with an optional when. */
const StatSchema = z.union(
  [
    z.strictObject({ ac: StatNum, when: Gates.optional() }),
    /** The bearer's AC can't be less than this (an AC floor, the census's ac.min shape). */
    z.strictObject({ acFloor: StatNum, when: Gates.optional() }),
    /** half, zero, or a bonus or penalty in feet (a multiple of 5; an expression is checked when it folds). */
    /** noStack (M3 step 5b): speed changes sharing the key don't add up (Slow's "doesn't exceed 10 feet"). */
    z.strictObject({ speed: z.union([z.enum(['half', 'zero']), StatNum]), noStack: LocalId.optional(), when: Gates.optional() }),
    z.strictObject({ resist: DamageTypes, when: Gates.optional() }),
    z.strictObject({ vuln: DamageTypes, when: Gates.optional() }),
    z.strictObject({ immune: DamageTypes, when: Gates.optional() }),
    /** The bearer's weapon attacks and Unarmed Strikes score a Critical Hit on this or higher. */
    z.strictObject({ critMin: z.int().min(2).max(19), when: Gates.optional() }),
    /** The bearer can't make Opportunity Attacks. */
    z.strictObject({ noOpportunityAttacks: z.literal(true), when: Gates.optional() }),
    /** The bearer's Unarmed Strikes may deal this type instead of their own (C13: the type the target defends against least). */
    z.strictObject({ damageType: DamageTypeSchema, on: z.literal('unarmed'), when: Gates.optional() }),
    /**
     * M3 step 5a: a Fly Speed in feet (a multiple of 5). The grid has no altitude, so a flier
     * moves over the ground like a walker (the flyingAvoidsGroundZones flag), with the larger of
     * its Speed and Fly Speed to spend (srd-raw.txt:34218-34228).
     */
    z.strictObject({ fly: StatNum, when: Gates.optional() }),
    /** M3 step 5b: a magic Weapon +N's bonus to attack and damage rolls with the weapon whose `magic` names this feature. */
    z.strictObject({ magicWeapon: z.int().min(1).max(10) }),
    /** W1 (P2): the bearer can't cast spells (Rage, srd-raw.txt:4981). */
    z.strictObject({ noCasting: z.literal(true), when: Gates.optional() }),
    /** W1 (P2): the bearer can't maintain Concentration: gaining it ends the bearer's concentration (Rage, srd-raw.txt:4980). */
    z.strictObject({ noConcentration: z.literal(true), when: Gates.optional() }),
  ],
  {
    error: 'expected one stat: ac, acFloor, speed, resist, vuln, immune, critMin, noOpportunityAttacks, damageType, fly, magicWeapon, noCasting or noConcentration (each with an optional when)',
  },
);

export type StatSrc = z.output<typeof StatSchema>;
export type GateSrc = z.output<typeof GateSchema>;

const ModSchema = z
  .strictObject({
    on: z.array(RollKeyPat).min(1),
    side: z.enum(['self', 'incoming']).default('self'),
    op: z.enum(['adv', 'dis', 'flat', 'preDice', 'floor']),
    /** flat: the bonus; floor: the lowest d20 face that counts. An int, or (coverage step 7.5) a constant expression folded at compile: `max(@mod, 1)`. */
    value: z.union([z.int(), Expr]).optional(),
    /** preDice: the die rolled and added before the d20 (Guidance's 1d4). */
    dice: Expr.optional(),
    /** A one-use rider: the first roll it applies to ends the effect. */
    consume: z.literal('nextRoll').optional(),
    /** Checks only: only the skill chosen when the effect was applied. */
    skill: z.literal('chosen').optional(),
    /** Gates (M3 step 4): it folds only while every one holds. */
    when: Gates.optional(),
    /** M3 step 5b: an incoming mod for the effect owner's rolls only (Vex). */
    from: z.literal('owner').optional(),
  })
  .superRefine((m, ctx) => {
    if (m.from !== undefined && m.side !== 'incoming') ctx.addIssue({ code: 'custom', path: ['from'], message: 'from: owner limits an incoming mod to the owner\'s rolls; a self mod is the bearer\'s own' });
    const wantsValue = m.op === 'flat' || m.op === 'floor';
    if (wantsValue && m.value === undefined) ctx.addIssue({ code: 'custom', path: ['value'], message: `op ${m.op} needs a value` });
    if (!wantsValue && m.value !== undefined) ctx.addIssue({ code: 'custom', path: ['value'], message: `op ${m.op} takes no value` });
    if (m.op === 'floor' && typeof m.value === 'string') ctx.addIssue({ code: 'custom', path: ['value'], message: 'a d20 floor is a number, 2 to 20' });
    if (m.op === 'floor' && typeof m.value === 'number' && (m.value < 2 || m.value > 20)) ctx.addIssue({ code: 'custom', path: ['value'], message: 'a d20 floor is 2 to 20' });
    if (m.op === 'preDice' && m.dice === undefined) ctx.addIssue({ code: 'custom', path: ['dice'], message: 'op preDice needs dice' });
    if (m.op !== 'preDice' && m.dice !== undefined) ctx.addIssue({ code: 'custom', path: ['dice'], message: `op ${m.op} takes no dice` });
    if (m.skill !== undefined && !m.on.every((p) => p === 'd20.check' || p.startsWith('d20.check.'))) {
      ctx.addIssue({ code: 'custom', path: ['skill'], message: 'skill: chosen applies only to ability checks (d20.check...)' });
    }
  });

const TargetSchema = z.strictObject({
  range: z.union([RangeFt, z.literal('touch')]),
  who: z.enum(['any', 'ally', 'enemy']).default('any'),
  /** Can the caster pick itself: yes, no, or textSilent (the selfTargetWhenTextSilent flag decides). */
  self: SelfSchema,
  maxSize: SizeSchema.optional(),
});

export type TargetSrc = z.output<typeof TargetSchema>;
export type DamageRollSrc = z.output<typeof DamageRoll>;

/** One step of a spell, feature, hook or grant program (validated source form). */
export type StepSrc =
  | { target: TargetSrc }
  | { attack: { kind: 'melee' | 'ranged'; range: number; onHit: StepSrc[]; onMiss: StepSrc[] } }
  | { save: { ability: Ability; damage?: DamageRollSrc[] | undefined; half: boolean; onFail: StepSrc[]; onSuccess: StepSrc[]; ignoresCover?: 'partial' | undefined; targetAdv?: true | undefined; dc?: number | undefined } }
  | { damage: DamageRollSrc[] }
  | { heal: { roll: string; upcast?: string | undefined } }
  | { apply: { effect: string; to: 'self' | 'target' | 'point'; when?: GateSrc[] | undefined } }
  | { moveZone: { ft: number } }
  | { forcedMove: { mode: 'pull' | 'push'; maxFt: number; maxSize: Size; straight?: true | undefined; exact?: true | undefined } }
  | { choose: { id: string; name: string; do: StepSrc[] }[] }
  | { chooseSkill: Record<string, never> }
  | { use: string }
  | { condition: ConditionSrc }
  | { tempHp: string }
  | { weaponAttack: WeaponAttackSrc }
  | { core: 'dash' | 'disengage' | 'dodge' }
  | { gainAction: 'action' }
  | { pool: { id: string; delta: number | string } }
  | { around: { size: number; who: 'any' | 'ally' | 'enemy' } }
  // W1 (docs/design/w1-plan.md P1, P11, P9)
  | { extendSource: true }
  | { endConditions: (typeof CONTENT_CONDS)[number][] }
  | { move: { speed: 'half'; noOpportunityAttacks: true } };

/** M3 step 5a (WATK): strikes with the creature's own attacks, each at a target picked then. */
export interface WeaponAttackSrc {
  /** held: any weapon attack it has (a weapon it can wield now); unarmed: its Unarmed Strike; or one weapon's id. */
  with: string;
  /** Leave the ability modifier out of the damage, unless it's negative (the Light property's extra attack, step 5b). */
  noAbilityToDamage?: true | undefined;
  /** How many strikes (Flurry of Blows: 2). */
  count?: number | undefined;
  /** M3 step 5b: the Light property's extra attack: with held, only Light weapons; always a Light weapon other than the one the Attack action used. */
  lightExtra?: true | undefined;
  /** M3 step 5b (Cleave): a melee attack at a creature within 5 ft of the creature the frame targets (not that one). */
  near?: true | undefined;
}

/** M3 step 4: a condition step (validated source form). */
export interface ConditionSrc {
  id: (typeof CONTENT_CONDS)[number];
  until: DurationSrc;
  save?: { ability: Ability; dc?: number | undefined; at: 'turnEnd'; onFail?: StepSrc[] | undefined } | undefined;
  endsOnDamage?: true | undefined;
  also?: (typeof CONTENT_CONDS)[number][] | undefined;
  speed?: 'zero' | undefined;
  dropHeld?: true | undefined;
  escape?: { check: { ability: Ability; skills: string[] }; dc?: number | undefined; cost: 'action' } | undefined;
}

export const STEP_KINDS = ['target', 'attack', 'save', 'damage', 'heal', 'apply', 'moveZone', 'forcedMove', 'choose', 'chooseSkill', 'use', 'condition', 'tempHp', 'weaponAttack', 'core', 'gainAction', 'pool', 'around', 'extendSource', 'endConditions', 'move'] as const;

/**
 * A condition (M3 step 4). until: how long it lasts (parent: as long as what imposed it); it
 * also always ends with the frame's root when there is one (a concentration spell, a form, the
 * zone whose hook imposed it), so it never outlives its source. save: the bearer repeats the
 * save at the end of each of its turns, ending it on a success. escape: the bearer's action, an
 * ability check. dc defaults to the owner's save DC. Prone takes none of these: it lasts until
 * the creature rights itself (SRD 5.2.1 Prone, srd-raw.txt:34014-34016).
 *
 * Coverage step 7.4. save.onFail: a next stage on a failed repeat save, run under this condition's
 * parent, so `until: parent` there ends with what imposed the first stage (Sleep, 30829-30833).
 * also, speed: while it has this condition it also has those conditions and that Speed (Hypnotic
 * Pattern, 28141-28142); a creature immune to `id` gets none of them. dropHeld: gaining it drops
 * what the creature holds (Fear, 26750-26751).
 */
const ConditionStepSchema = z
  .strictObject({
    id: CondSchema,
    until: DurationSchema.default('parent'),
    save: z.strictObject({ ability: AbilitySchema, dc: z.int().min(1).max(40).optional(), at: z.literal('turnEnd'), onFail: z.lazy(() => z.array(StepSchema).min(1)).optional() }).optional(),
    endsOnDamage: z.literal(true).optional(),
    also: z.array(CondSchema).min(1).optional(),
    speed: z.literal('zero').optional(),
    dropHeld: z.literal(true).optional(),
    escape: z
      .strictObject({
        check: z.strictObject({ ability: AbilitySchema, skills: z.array(SkillSchema).default([]) }),
        dc: z.int().min(1).max(40).optional(),
        cost: z.literal('action'),
      })
      .optional(),
  })
  .superRefine((c, ctx) => {
    if (c.id === 'prone' && (c.until !== 'parent' || c.save || c.endsOnDamage || c.escape || c.also || c.speed || c.dropHeld)) {
      ctx.addIssue({ code: 'custom', path: ['id'], message: 'Prone lasts until the creature rights itself (SRD 5.2.1 p.191): it takes no until, save, endsOnDamage, escape, also, speed or dropHeld' });
    }
    // Prone is a plain instance that outlasts what imposed it, and Unconscious brings it and a drop: neither fits inside another condition's instance.
    c.also?.forEach((a, i) => {
      if (a === 'prone' || a === 'unconscious') ctx.addIssue({ code: 'custom', path: ['also', i], message: `${a} can't be part of another condition's instance: use its own condition step` });
    });
    if (c.escape) {
      const ab = c.escape.check.ability;
      c.escape.check.skills.forEach((sk, i) => {
        const own = SKILLS.find(([n]) => n === sk)![1];
        if (own !== ab) ctx.addIssue({ code: 'custom', path: ['escape', 'check', 'skills', i], message: `${sk} is a ${own} skill, not ${ab}` });
      });
    }
  });

export const StepSchema: z.ZodType<StepSrc> = z.lazy(() =>
  z.union(
    [
      z.strictObject({ target: TargetSchema }),
      z.strictObject({
        attack: z.strictObject({
          kind: z.enum(['melee', 'ranged']),
          /** A melee spell attack's reach is its range (melee or ranged comes from the text, p.105). */
          range: RangeFt,
          onHit: z.array(StepSchema).default([]),
          onMiss: z.array(StepSchema).default([]),
        }),
      }),
      z.strictObject({
        save: z.strictObject({
          ability: AbilitySchema,
          damage: z.array(DamageRoll).min(1).optional(),
          half: z.boolean().default(false),
          onFail: z.array(StepSchema).default([]),
          onSuccess: z.array(StepSchema).default([]),
          /** 8'a review R2: the text says the target "gains no benefit from Half Cover or Three-Quarters Cover for this save" (Sacred Flame, p.159). */
          ignoresCover: z.literal('partial').optional(),
          /** Coverage step 7.4: the text gives the target Advantage on this save (Charm Person, "if you or your allies are fighting it", srd-raw.txt:24863-24864). */
          targetAdv: z.literal(true).optional(),
          /** Coverage step 7.6: the stat block's printed DC. Required in a monster action's program (a monster has no spellcasting ability), refused anywhere else. */
          dc: z.int().min(1).max(40).optional(),
        }),
      }),
      z.strictObject({ damage: z.array(DamageRoll).min(1) }),
      z.strictObject({ heal: z.strictObject({ roll: Expr, upcast: Expr.optional() }) }),
      /** W1 (P3, Frenzy): when, gates checked on the program's owner as the step runs; it does nothing unless every one holds. */
      z.strictObject({ apply: z.strictObject({ effect: LocalId, to: z.enum(['self', 'target', 'point']), when: Gates.optional() }) }),
      z.strictObject({ moveZone: z.strictObject({ ft: RangeFt }) }),
      /** straight (M3 step 5b): the text says "straight" (Push: "straight away from yourself"), whatever forcedMovementPath says. */
      /** exact (coverage step 7.3): the text states the distance ("pushed 10 feet", Thunderwave, srd-raw.txt:31632-31634), so no stopping while squares remain. */
      z.strictObject({ forcedMove: z.strictObject({ mode: z.enum(['pull', 'push']), maxFt: RangeFt, maxSize: SizeSchema, straight: z.literal(true).optional(), exact: z.literal(true).optional() }) }),
      z.strictObject({ choose: z.array(z.strictObject({ id: LocalId, name: Name, do: z.array(StepSchema).min(1) })).min(2) }),
      z.strictObject({ chooseSkill: z.strictObject({}) }),
      z.strictObject({ use: LocalId }),
      z.strictObject({ condition: ConditionStepSchema }),
      /** Temporary Hit Points (M3 step 4): they don't stack, the higher is kept. */
      z.strictObject({ tempHp: Expr }),
      // ---- M3 step 5a ----
      /**
       * WATK: strikes with the acting creature's own attacks (the existing to-hit, reach, damage
       * and crit rules), each at a target it picks then: with: unarmed (its Unarmed Strike), held
       * (any weapon it can wield now) or a weapon id. count: 1 to 4 strikes.
       */
      z.strictObject({
        weaponAttack: z.strictObject({
          with: z.union([z.enum(['held', 'unarmed']), LocalId]),
          noAbilityToDamage: z.literal(true).optional(),
          count: z.int().min(1).max(4).optional(),
          lightExtra: z.literal(true).optional(),
          near: z.literal(true).optional(),
        }),
      }),
      /** ECON: a core action's effect, paid for by the activation running it (Patient Defense: Disengage and Dodge as one Bonus Action). */
      z.strictObject({ core: z.enum(['dash', 'disengage', 'dodge']) }),
      /** ECON: one more action this turn (Action Surge). */
      z.strictObject({ gainAction: z.literal('action') }),
      /** POOLX: change one of the character's pools by a constant (an int or a constant expression) or refill it; never below 0 or above its max. */
      z.strictObject({ pool: z.strictObject({ id: LocalId, delta: z.union([z.literal('refill'), z.int(), Expr]) }) }),
      /**
       * Session S (repo half): the targets become every living creature in an Emanation of `size` ft
       * around the program's owner (its square's center; the owner never included, srd-raw.txt:33385-33386),
       * through the same area mask and wall cut-off as a creature's Emanation zone (grid/area.ts
       * areaCellsFrom), with no decision: who any (allies too), ally (the owner's side) or enemy (hostile).
       * An effect's turnEnd hook with this step is a pulse at the end of each of the bearer's turns.
       */
      z.strictObject({ around: z.strictObject({ size: RangeFt, who: z.enum(['any', 'ally', 'enemy']).default('any') }) }),
      // ---- W1 (docs/design/w1-plan.md) ----
      /**
       * P1: the counterpart of endSource, in a grant of a sustained effect: the effect whose grant is
       * running lasts until the end of its bearer's next turn again (Rage's Bonus Action extension,
       * srd-raw.txt:4990-4993).
       */
      z.strictObject({ extendSource: z.literal(true) }),
      /** P11: these conditions end on the program's owner (Mindless Rage, "the condition ends on you", srd-raw.txt:5183-5184). */
      z.strictObject({ endConditions: z.array(CondSchema).min(1) }),
      /**
       * P9: the program's owner may move up to half its Speed (rounded down to 5 ft) without provoking
       * Opportunity Attacks, a moveTo decision (Tactical Shift, srd-raw.txt:10661-10663; Withdraw,
       * 13835-13836). Whose movement it spends is the freeMoveUsesMovement flag.
       */
      z.strictObject({ move: z.strictObject({ speed: z.literal('half'), noOpportunityAttacks: z.literal(true) }) }),
    ],
    { error: `expected exactly one step: ${STEP_KINDS.join(', ')}` },
  ),
).meta({ id: 'step', description: `One step: ${STEP_KINDS.join(', ')}` });

/**
 * Coverage step 7.3: who a zone's hooks fire on. all (the default): everyone in it. notOwner: "other
 * than you" (Entangle, srd-raw.txt:26555). foes: "creatures of your choice" and "designate" [U: the
 * caster always spares every ally and hits every foe, no decision]. allies: "you and your allies".
 * Separate from includesOrigin: "you and your allies" needs both. Difficult Terrain isn't filtered.
 */
const ZoneAffects = z.enum(['all', 'notOwner', 'foes', 'allies']).optional();

export const EffectSchema = z
  .strictObject({
    id: LocalId,
    name: Name,
    zone: z
      .discriminatedUnion('shape', [
        z.strictObject({
          shape: z.enum(['sphere', 'cylinder']),
          radius: RangeFt,
          height: RangeFt.optional(),
          /** The area is Difficult Terrain. */
          difficult: z.boolean().default(false),
          affects: ZoneAffects,
        }),
        /** A Square is a Cube on a flat grid. */
        z.strictObject({ shape: z.enum(['cube', 'square']), size: RangeFt, difficult: z.boolean().default(false), affects: ZoneAffects }),
        z.strictObject({ shape: z.literal('cone'), size: RangeFt, difficult: z.boolean().default(false), affects: ZoneAffects }),
        z.strictObject({ shape: z.literal('line'), size: RangeFt, width: RangeFt, difficult: z.boolean().default(false), affects: ZoneAffects }),
        /** includesOrigin: its creator decided the origin is in the area (srd-raw.txt:33385-33386). */
        /** offWhen: it stays up but does nothing while its owner has the condition (Aura of Protection, "inactive", srd-raw.txt:11995). */
        z.strictObject({ shape: z.literal('emanation'), size: RangeFt, includesOrigin: z.boolean().optional(), offWhen: z.array(z.literal('incapacitated')).min(1).optional(), difficult: z.boolean().default(false), affects: ZoneAffects }),
      ])
      .optional(),
    /**
     * Coverage step 9: a zone camouflaged at cast (Spike Growth, srd-raw.txt:31015-31021): a creature
     * that didn't see it appear must Search (a WIS check against `dc`) to know it's there.
     * `dc: caster`: the caster's spell save DC, bound into the zone when it's cast.
     */
    hidden: z.strictObject({ dc: z.literal('caster') }).optional(),
    /** 'parent': ends with whatever it was created under (a concentration instance, a form). */
    duration: DurationSchema.default('parent'),
    /** At most one firing per creature per turn, on anyone's turn. */
    oncePerTurn: z
      .enum(['perCreature'], {
        error: (iss) => (iss.input === 'global' || iss.input === 'ownTurn' ? `oncePerTurn ${String(iss.input)} isn't modeled yet (M3 adds it)` : undefined),
      })
      .optional(),
    endsOn: z.array(z.enum(['incapacitated', 'dismiss'])).default([]),
    /** It sits in the owner's hand (the conjuredHandEffectBlocksHand flag decides whether it fills one). */
    inHand: z.boolean().default(false),
    /** Applying the source again ends the owner's live effects in the same group. */
    group: LocalId.optional(),
    mods: z.array(ModSchema).default([]),
    /** M3 step 4: conditions its bearer is immune to while it lasts (an immunity blocks the condition being applied). */
    immune: z.array(CondSchema).min(1).optional(),
    /** M3 step 4: stats it gives its bearer while it lasts. */
    stats: z.array(StatSchema).min(1).optional(),
    on: z.array(z.strictObject({ when: z.array(HookNameSchema).min(1), do: z.array(StepSchema).min(1) })).default([]),
    /**
     * W1 (P1): a sustained effect (Rage, srd-raw.txt:4982-4993): on its bearer's own turn, an attack
     * roll against an enemy (attackRoll) or forcing an enemy to make a saving throw (enemySave) makes
     * it last until the end of the bearer's next turn again. Only with duration { until:
     * endOfNextTurn, of: bearer }.
     */
    sustain: z.strictObject({ by: z.array(z.enum(['attackRoll', 'enemySave'])).min(1) }).optional(),
    grants: z
      .array(
        z.strictObject({
          id: LocalId,
          name: Name,
          cost: z.enum(['action', 'bonus']),
          /** Only on the owner's turns after the one the effect was created on. */
          laterTurns: z.boolean().default(false),
          /** Who gets the option: the effect's owner, or the creature bearing it. */
          to: z.enum(['owner', 'bearer']).default('owner'),
          /** Gates (M3 step 4): offered only while every one holds (checked on whoever gets it). */
          when: Gates.optional(),
          do: z.array(StepSchema).min(1),
        }),
      )
      .default([]),
  })
  .superRefine((e, ctx) => {
    if (e.zone?.shape === 'cylinder' && e.zone.height === undefined) ctx.addIssue({ code: 'custom', path: ['zone', 'height'], message: 'a cylinder needs a height' });
    if (e.zone?.shape === 'sphere' && e.zone.height !== undefined) ctx.addIssue({ code: 'custom', path: ['zone', 'height'], message: 'a sphere has no height (its radius sets it)' });
    if (e.hidden && !e.zone) ctx.addIssue({ code: 'custom', path: ['hidden'], message: 'only a zone can be hidden' });
    if (e.sustain) {
      const d = e.duration;
      if (d === 'parent' || !('until' in d) || d.until !== 'endOfNextTurn' || d.of !== 'bearer') {
        ctx.addIssue({ code: 'custom', path: ['sustain'], message: 'a sustained effect lasts until the end of its bearer\'s next turn: give it duration { until: endOfNextTurn, of: bearer }' });
      }
      if (new Set(e.sustain.by).size !== e.sustain.by.length) ctx.addIssue({ code: 'custom', path: ['sustain', 'by'], message: 'each way to sustain it is listed once' });
    }
  });

export type EffectSrc = z.output<typeof EffectSchema>;

export const SpellSchema = z.strictObject({
  kind: z.literal('spell'),
  ...common,
  level: z.int().min(0).max(9),
  castingTime: z.enum(['action', 'bonus']),
  range: z.union([RangeFt, z.enum(['self', 'touch'])]),
  /** m: focus means a Material component a focus or pouch can stand in for; costly isn't modeled (a compile error). */
  components: z.strictObject({ v: z.boolean(), s: z.boolean(), m: z.enum(['none', 'focus', 'costly']).default('none') }),
  concentration: z.boolean().default(false),
  duration: z.union([z.literal('instant'), DurationSchema]),
  /** The zone effect the cast places (askPlace before the program runs). */
  area: LocalId.optional(),
  /** replace: casting it again ends the caster's live copy (Produce Flame). */
  recast: z.enum(['stack', 'replace']).default('stack'),
  effects: z.array(EffectSchema).default([]),
  do: z.array(StepSchema).min(1),
});

/** How often an activation can be used: one use of a pool, or once per turn (docs/design/m3.md 2.4). */
const UsesSchema = z.union([z.strictObject({ pool: LocalId, cost: z.int().min(1).max(20).optional() }), z.strictObject({ perTurn: z.literal(1) })], {
  error: 'expected uses: { pool: <pool id>, cost?: <points> } or { perTurn: 1 }',
});

/**
 * RIDER (M3 step 5a, docs/design/m3.md section 3 and C1): something its bearer may add when one
 * of its attacks hits, misses or deals damage. A 'rider' decision point when it can be used
 * (auto-skipped when it can't). filter: which attacks (attack: weapon, unarmed, spell or
 * monkWeapon, one or a list; range: the attack roll's kind; grantedBy: the activation that made
 * the strike; ability: the attack's ability). oncePerTurn (C1): perCreature = once per target
 * per turn, global = once in each turn (anyone's), ownTurn = once, only on the bearer's turn.
 * cost: Focus-style pool points. On a hit, damage steps at the top level of do (or of an option)
 * are extra damage joined to the attack's own damage (rolled twice on a Critical Hit,
 * riderDiceCritDouble); the rest runs after that damage is dealt.
 */
const RiderAttackKind = z.enum(['weapon', 'unarmed', 'spell', 'monkWeapon']);
const RiderSchema = z
  .strictObject({
    id: LocalId,
    name: Name,
    on: z.enum(['hit', 'miss', 'dealtDamage']),
    filter: z
      .strictObject({
        attack: z.union([RiderAttackKind, z.array(RiderAttackKind).min(1).max(4)]).optional(),
        range: z.enum(['melee', 'ranged']).optional(),
        grantedBy: LocalId.optional(),
        ability: AbilitySchema.optional(),
        /** M3 step 5b: only attacks made with this weapon (its local id; any of its modes). */
        weapon: LocalId.optional(),
        /**
         * W1 (P6): only attacks made with a weapon that has one of these: the Finesse property, or a
         * Ranged weapon (the weapon's kind, not the attack's: a thrown Handaxe is a Melee weapon).
         * Sneak Attack, srd-raw.txt:13738-13739. Decided at compile.
         */
        weaponProperty: z.array(z.enum(['finesse', 'ranged'])).min(1).optional(),
      })
      .optional(),
    oncePerTurn: z.enum(['perCreature', 'global', 'ownTurn']).optional(),
    cost: z.strictObject({ pool: LocalId, points: z.int().min(1).max(20).optional() }).optional(),
    /** Gates on the bearer (targetHas looks at the creature attacked). */
    when: Gates.optional(),
    /** Named options, one chosen when it's used (Open Hand Technique: Addle, Push, Topple). */
    choose: z.array(z.strictObject({ id: LocalId, name: Name, do: z.array(StepSchema).min(1) })).min(2).max(8).optional(),
    do: z.array(StepSchema).min(1).optional(),
    /** M3 step 5b: used with no decision whenever it can be (a rule that isn't "you can": Sap, Vex). */
    auto: z.literal(true).optional(),
    /**
     * Session S (repo half), on: dealtDamage only: it also fires when a spell its bearer cast deals
     * damage without an attack roll (a save's damage, a damage step, the hook of an effect or zone
     * the spell created), once per creature damaged, after that damage. Attacks still need `filter`.
     */
    spellDamage: z.literal(true).optional(),
  })
  .superRefine((r, ctx) => {
    if (r.spellDamage && r.on !== 'dealtDamage') ctx.addIssue({ code: 'custom', path: ['spellDamage'], message: 'spellDamage is a dealtDamage rider\'s: give on: dealtDamage' });
    if ((r.do === undefined) === (r.choose === undefined)) ctx.addIssue({ code: 'custom', path: ['do'], message: 'a rider has do or choose (not both)' });
    if (r.auto && (r.choose !== undefined || r.cost !== undefined)) ctx.addIssue({ code: 'custom', path: ['auto'], message: 'an auto rider has one option and no cost (nothing to decide)' });
  });
export type RiderSrc = z.output<typeof RiderSchema>;

/** One activation (an option on the bearer's turn; reaction-cost ones only through a reaction window). */
const ActivateSchema = z.strictObject({
  id: LocalId,
  name: Name,
  /** free: no action economy cost (it needs a limit: a pool or uses). reaction: spends the Reaction (M3 step 5a). */
  cost: z.enum(['action', 'bonus', 'free', 'reaction']),
  /** The character's pool it spends one use of; omit for a free activation. Same as uses: { pool }. */
  pool: LocalId.optional(),
  uses: UsesSchema.optional(),
  /** The effect created first, which the steps run under (duration: parent children end with it). */
  root: LocalId.optional(),
  /** Gates (M3 step 4): offered only while every one holds. */
  when: Gates.optional(),
  /**
   * M3 step 6: self, the steps act on the user only (the frame's target is the user, as in an
   * initiative hook), with no target decision: Second Wind, Wholeness of Body ("you regain Hit
   * Points"). Omit for an activation that picks its targets with a target step.
   */
  target: z.literal('self').optional(),
  /** Coverage step 7.2: the effect whose zone it places, as a spell's `area` (apply to: point in `do`). */
  area: LocalId.optional(),
  /** The area's range, as a spell's: self (the default) for a shape that starts from the user. Only with `area`. */
  range: z.union([z.literal('self'), RangeFt]).optional(),
  do: z.array(StepSchema).min(1),
});
export type ActivateSrc = z.output<typeof ActivateSchema>;

/**
 * Coverage C0 (X1): what already mechanizes a feature whose own record carries no program: the
 * class table and the character expansion (extra attacks, an AC formula, mastery picks, spell
 * slots and lists, a feat choice). Set only by a reviewed importer override with a PDF cite,
 * with fidelity full or partial; it exempts the feature from the "nothing here is modeled"
 * warning. Never compiled.
 */
export const MECHANIZED_BY = ['extraAttack', 'unarmoredDefense', 'weaponMastery', 'spellcasting', 'pactMagic', 'fightingStyle'] as const;

export const FeatureSchema = z.strictObject({
  kind: z.literal('feature'),
  ...common,
  mechanizedBy: z.enum(MECHANIZED_BY).optional(),
  /** The ability behind @mod, spell attacks and save DCs in this feature's steps. */
  spellAbility: AbilitySchema.optional(),
  /** One activation, or (M3 step 5a) several, each with its own id (Monk's Focus: Flurry of Blows, Patient Defense, Step of the Wind). */
  activate: z.union([ActivateSchema, z.array(ActivateSchema).min(2).max(8)]).optional(),
  /**
   * M3 step 5a (HOOKX): what the character may do when it rolls Initiative, offered as an
   * optional decision then (Uncanny Metabolism). uses: the pool one use spends (once per Long
   * Rest is a pool of 1 with recharge long). Its dice come from its own initiative stream slot.
   */
  initiative: z
    .strictObject({
      id: LocalId,
      name: Name,
      uses: z.strictObject({ pool: LocalId, cost: z.int().min(1).max(20).optional() }).optional(),
      do: z.array(StepSchema).min(1),
    })
    .optional(),
  reaction: z
    .discriminatedUnion('window', [
      z.strictObject({
        window: z.literal('beforeD20Test'),
        range: RangeFt,
        self: SelfSchema,
        pool: LocalId,
        die: Expr,
        sign: z.enum(['add', 'subtract', 'choose']),
        rolls: z.array(z.enum(['attack', 'save', 'check'])).min(1).default(['attack', 'save', 'check']),
      }),
      /**
       * M3 step 5a (REACT hitTaken): when an attack roll hits the bearer, after the damage is
       * rolled, it may take its Reaction to reduce that attack's damage against it (Deflect
       * Attacks, srd-raw.txt:11154-11158): by an expression (rolled when used) or by half.
       * damageTypes: only when the damage includes one of them (C12). pool: points it spends.
       */
      z.strictObject({
        window: z.literal('hitTaken'),
        reduce: z.union([z.literal('halve'), Expr]),
        /** W1 (P11): only against an attacker the bearer can see (Uncanny Dodge, srd-raw.txt:13840). */
        sees: z.literal(true).optional(),
        damageTypes: DamageTypes.optional(),
        pool: LocalId.optional(),
        points: z.int().min(1).max(20).optional(),
      }),
      /**
       * M3 step 8'a (the hit-known window, sim/d20.ts): when an attack roll hits the bearer, once
       * the hit is known and before any damage is rolled, it may take its Reaction to raise its AC
       * against that attack, possibly turning the hit into a miss (Shield: "+5 bonus to AC, including
       * against the triggering attack", srd-raw.txt:30659-30670; Parry: "adds 2 to its AC against
       * that attack, possibly causing it to miss", 50631-50633). ac: added against the triggering
       * attack only (Parry). do: steps run on the bearer first, before the attack is checked again
       * (Shield's lasting AC effect: apply to self). attacks: which attack rolls it answers.
       */
      z.strictObject({
        window: z.literal('hitKnown'),
        attacks: z.array(z.enum(['melee', 'ranged'])).min(1).default(['melee', 'ranged']),
        ac: z.int().min(1).max(10).optional(),
        do: z.array(StepSchema).default([]),
        pool: LocalId.optional(),
        points: z.int().min(1).max(20).optional(),
      }),
      /**
       * M3 step 8'a (the damage-taken window): after the bearer takes damage from another creature
       * it can see within range, it may take its Reaction to run `do` with that creature as the
       * target (Hellish Rebuke: "in response to taking damage from a creature that you can see
       * within 60 feet of yourself ... The creature that damaged you ... makes a Dexterity saving
       * throw", srd-raw.txt:27953-27961).
       */
      z.strictObject({
        window: z.literal('damageTaken'),
        range: RangeFt,
        do: z.array(StepSchema).min(1),
        pool: LocalId.optional(),
        points: z.int().min(1).max(20).optional(),
      }),
    ])
    .optional(),
  /** M3 step 5a (RIDER): what it adds to its bearer's attacks. */
  riders: z.array(RiderSchema).min(1).max(8).optional(),
  /**
   * W1 (P7): offered when its bearer makes its first attack roll on its turn, before that roll (a
   * firstAttack decision: pass, or use it); `do` runs on the bearer (Reckless Attack,
   * srd-raw.txt:5021-5022).
   */
  firstAttack: z.strictObject({ do: z.array(StepSchema).min(1) }).optional(),
  /**
   * W1 (P8): when its bearer, a character, is reduced to 0 Hit Points but not killed outright, it
   * drops to 1 Hit Point instead, spending one use of `pool` (Relentless Endurance,
   * srd-raw.txt:19928-19931).
   */
  dropToOne: z.strictObject({ pool: LocalId }).optional(),
  /**
   * W1 (P10): adds to another feature the character has, when it compiles: `steps` appended to that
   * feature's activation (`activation`, default its first) or its firstAttack program, or `options`
   * appended to its rider `rider` (one rider, one decision). Nothing happens when the character
   * doesn't have that feature. The steps run in that program's frame and may use this feature's effects.
   */
  augments: z
    .strictObject({
      feature: IdSchema,
      activation: LocalId.optional(),
      rider: LocalId.optional(),
      firstAttack: z.literal(true).optional(),
      steps: z.array(StepSchema).min(1).optional(),
      options: z.array(z.strictObject({ id: LocalId, name: Name, do: z.array(StepSchema).min(1) })).min(1).max(7).optional(),
    })
    .superRefine((a, ctx) => {
      const where = (a.activation !== undefined ? 1 : 0) + (a.rider !== undefined ? 1 : 0) + (a.firstAttack ? 1 : 0);
      if (where > 1) ctx.addIssue({ code: 'custom', path: ['feature'], message: 'augment one of an activation, a rider or firstAttack' });
      if (a.rider !== undefined) {
        if (a.options === undefined) ctx.addIssue({ code: 'custom', path: ['options'], message: 'augmenting a rider adds options to it: give options' });
        if (a.steps !== undefined) ctx.addIssue({ code: 'custom', path: ['steps'], message: 'a rider is augmented with options, not steps' });
      } else {
        if (a.steps === undefined) ctx.addIssue({ code: 'custom', path: ['steps'], message: 'augmenting an activation or firstAttack appends steps: give steps' });
        if (a.options !== undefined) ctx.addIssue({ code: 'custom', path: ['options'], message: 'options are for augmenting a rider (give rider)' });
      }
    })
    .optional(),
  /** Damage resistances it gives the character (a species trait). */
  resist: z.array(DamageTypeSchema).default([]),
  /** Effects (from effects, by id) on the character from the start of every fight until it ends. */
  passive: z.strictObject({ effects: z.array(LocalId).min(1) }).optional(),
  /**
   * Hit points it adds (C9a: the Tough feat, a species' or subclass's per-level bonus): summed
   * into a character file's hpMax with its source. A kind: pc states hpMax itself, so there it's data only.
   */
  hp: z
    .strictObject({ perLevel: z.int().min(1).optional(), flat: z.int().min(1).optional() })
    .refine((h) => h.perLevel !== undefined || h.flat !== undefined, 'give perLevel, flat or both')
    .optional(),
  effects: z.array(EffectSchema).default([]),
});

const ItemSchema = z
  .strictObject({
    id: LocalId,
    name: Name,
    kind: z.enum(['shield', 'focus', 'pouch', 'object']),
    /** Spell lists it works as a focus for. */
    focusFor: z.array(LocalId).default([]),
    /** AC it adds while held. */
    shieldAc: z.int().min(0).default(0),
    /** M3 step 5b: the feature (a magic item) this item is; that feature's itemHeld gates look at it. */
    magic: IdSchema.optional(),
  })
  .superRefine((it, ctx) => {
    if (it.kind === 'shield' && it.shieldAc < 1) ctx.addIssue({ code: 'custom', path: ['shieldAc'], message: 'a shield needs shieldAc (the AC it adds while held)' });
    if (it.kind !== 'shield' && it.shieldAc !== 0) ctx.addIssue({ code: 'custom', path: ['shieldAc'], message: 'only a shield adds AC' });
    if (it.kind === 'focus' && it.focusFor.length === 0) ctx.addIssue({ code: 'custom', path: ['focusFor'], message: 'a focus needs focusFor: the spell lists it works for' });
    if (it.kind !== 'focus' && it.focusFor.length > 0) ctx.addIssue({ code: 'custom', path: ['focusFor'], message: 'only a focus has focusFor' });
  });

/**
 * One recovery rule, mapped 1:1 from the importer's source (docs/design/m3.md 2.4): when, and
 * how much (all, or an expression like 1 or @mod.wis). Metadata only, like the short form.
 */
const RechargeRule = z.strictObject({
  period: z.enum(['short', 'long', 'turn', 'dawn']),
  amount: z.union([z.literal('all'), z.int().min(1), Expr]),
});
export type RechargeRuleSrc = z.output<typeof RechargeRule>;

const PoolSchema = z.strictObject({
  id: LocalId,
  name: Name,
  /** A number, or an expression over @pb, @level and @mod.<ability> (no dice). */
  max: z.union([z.int().min(0), Expr]),
  /** Metadata only: no rest recovery is modeled (hard rule 4). The short form, or a list of rules. */
  recharge: z.union([z.enum(['shortRest', 'longRest', 'none']), z.array(RechargeRule).min(1)]),
});

const CastingSchema = z.strictObject({
  /** A local name for this source ('druid', 'charm'): the sheet groups by it and journal keys use it. */
  source: LocalId,
  ability: AbilitySchema,
  /** The spell list these count as, for which focus works. */
  list: LocalId,
  /** An item that must be held for these spells to be prepared (and their free casts usable). */
  whileHeld: LocalId.optional(),
  cantrips: z.array(IdSchema).default([]),
  /** Leveled spells prepared from the class list (counted against expect.prepared). */
  prepared: z.array(IdSchema).default([]),
  /** Always prepared: not counted against expect. */
  always: z.array(IdSchema).default([]),
  /** Free casts at the spell's lowest level, spending one use of a pool. */
  free: z.array(z.strictObject({ spell: IdSchema, pool: LocalId })).default([]),
});

export const PcSchema = z.strictObject({
  kind: z.literal('pc'),
  ...common,
  rules: z.literal('2024'),
  level: z.int().min(1).max(20),
  /** Defaults to 2 + floor((level - 1) / 4). */
  pb: z.int().min(2).max(9).optional(),
  size: SizeSchema,
  speed: Ft,
  abilities: Abilities,
  hpMax: z.int().min(1),
  /** AC without a held shield; a held shield item adds its shieldAc. */
  ac: z.int().min(1),
  /**
   * M3 step 4: the armor it wears (none or a category), for the unarmored and armored gates.
   * Omitted means unknown, and both gates then fail closed. expandCharacter fills it.
   */
  armor: z.enum(['none', 'light', 'medium', 'heavy']).optional(),
  saveProficiencies: z.array(AbilitySchema).default([]),
  skills: z
    .strictObject({
      proficient: z.array(SkillSchema).default([]),
      expertise: z.array(SkillSchema).default([]),
      bonus: z.array(z.strictObject({ skill: SkillSchema, add: z.int() })).default([]),
    })
    .prefault({}),
  /** The total initiative modifier; defaults to the DEX modifier. */
  initiativeBonus: z.int().optional(),
  extraAttacks: z.int().min(0).max(3).default(0),
  weapons: z.array(PcWeapon).default([]),
  /**
   * M3 step 5b: the weapons are hand items. Each is an item a hand holds (hands may name its id);
   * attacking needs it in hand (drawn as part of an Attack action's strike or a throw), Two-Handed
   * and Versatile grips, Thrown weapons leaving the hand, Ammunition and Loading, and the Light
   * property's extra attack (with Nick). Omitted: weapons are always ready, as before.
   */
  heldWeapons: z.literal(true).optional(),
  /** M3 step 5b: the weapon kinds (content ids) whose mastery properties a Weapon Mastery feature lets it use. */
  masteries: z.array(IdSchema).min(1).optional(),
  /**
   * M3 step 5a: the Unarmed Strike as a feature makes it (Martial Arts: the Martial Arts die and
   * DEX for attack and damage). Omitted: the glossary's STR + PB to hit, 1 + STR Bludgeoning.
   * damage may use @mod (the chosen ability's modifier); the type stays Bludgeoning.
   */
  unarmedStrike: z.strictObject({ ability: z.enum(['str', 'dex', 'finesse']), damage: Expr }).optional(),
  resist: z.array(DamageTypeSchema).default([]),
  vuln: z.array(DamageTypeSchema).default([]),
  immune: z.array(DamageTypeSchema).default([]),
  items: z.array(ItemSchema).default([]),
  /** What each hand holds when a fight starts: item ids or null. */
  hands: z.tuple([LocalId.nullable(), LocalId.nullable()]).default([null, null]),
  /** Spell slots by level: [4, 3, 3] is four 1st, three 2nd, three 3rd. */
  slots: z.array(z.int().min(0).max(9)).max(9).default([]),
  pools: z.array(PoolSchema).default([]),
  casting: z.array(CastingSchema).default([]),
  /** Feature ids (spell abilities, forms, reactions, species traits). */
  features: z.array(IdSchema).default([]),
  /** Counts the linter checks the casting lists against; it never infers them. */
  expect: z.strictObject({ cantrips: z.int().min(0).optional(), prepared: z.int().min(0).optional() }).optional(),
  /** Table rulings: below a scenario's flags and CLI overrides, above the defaults. */
  flags: FlagsSchema.default({}),
});

// ---- Character-building data (M3 step 1: docs/design/m3.md 2.2-2.3) ----
// Loaded, validated and cross-checked (content/data-kinds.ts) but compiled into nothing yet:
// no template, so no closure hash moves. kind: character (step 3) is what will read them.

/** A character level, as a map key ('1' to '20'; YAML's 1: reads as the string "1"). */
const LevelKey = z.string().regex(/^(?:[1-9]|1[0-9]|20)$/, 'expected a level from 1 to 20');
const Level = z.int().min(1).max(20);
/** Feature ids gained at each level. */
const LevelFeatures = z.record(LevelKey, z.array(IdSchema).min(1));

/** One class-table column as level breakpoints (the value holds from its level until the next breakpoint). */
const ScaleColumn = z.union(
  [
    z.strictObject({ type: z.literal('dice'), at: z.record(LevelKey, Expr) }),
    z.strictObject({ type: z.literal('number'), at: z.record(LevelKey, z.int().min(0)) }),
    /** Spell slots by level, as in a pc's slots: [4, 3] is four 1st and three 2nd. */
    z.strictObject({ type: z.literal('slots'), at: z.record(LevelKey, z.array(z.int().min(0).max(9)).max(9)) }),
  ],
  { error: 'expected a scale column: { type: dice|number|slots, at: { <level>: <value> } }' },
);

const SpellcastingSchema = z.strictObject({
  progression: z.enum(['full', 'half', 'pact']),
  ability: AbilitySchema,
  /** The spell list's id (lists aren't a content kind yet: not resolved). */
  list: IdSchema,
  /** Counts: a number, or an expression over @scale columns. */
  cantrips: z.union([z.int().min(0), Expr]).optional(),
  prepared: z.union([z.int().min(0), Expr]).optional(),
});

const AcFormula = z.strictObject({
  when: z.array(z.enum(['unarmored', 'noShield'])).default([]),
  /** An expression over @mod.<ability> (no dice). */
  ac: Expr,
});

/** A build-time pick (choose N from a list); a character file answers it by id. */
const ChoiceSchema = z
  .strictObject({
    id: LocalId,
    level: Level,
    choose: z.int().min(1),
    from: z.strictObject({
      skills: z.array(SkillSchema).min(1).optional(),
      features: z.array(IdSchema).min(1).optional(),
      feats: z.array(IdSchema).min(1).optional(),
      abilities: z.array(AbilitySchema).min(1).optional(),
      tools: z.array(Name).min(1).optional(),
    }),
    /**
     * What a skills choice gives: proficiency, or Expertise in skills the character is already
     * proficient in. Omitted, it is read from the id: a choice whose id starts with "expertise"
     * gives Expertise (the importer's ids: rogue expertise-1, bard expertise-2), anything else
     * proficiency. Only a skills list reads it.
     */
    grants: z.enum(['proficiency', 'expertise']).optional(),
  })
  .superRefine((ch, ctx) => {
    const lists = Object.values(ch.from).filter((v) => v !== undefined);
    if (lists.length === 0) ctx.addIssue({ code: 'custom', path: ['from'], message: 'from needs one list: skills, features, feats, abilities or tools' });
  });

const ARMOR_CATEGORIES = ['light', 'medium', 'heavy', 'shield'] as const;

export const ClassSchema = z.strictObject({
  kind: z.literal('class'),
  ...common,
  hitDie: z.union([z.literal(6), z.literal(8), z.literal(10), z.literal(12)]),
  saves: z.array(AbilitySchema).length(2),
  proficiencies: z
    .strictObject({
      armor: z.array(z.enum(ARMOR_CATEGORIES)).default([]),
      /** Weapon categories (simple, martial) or weapon ids. */
      weapons: z.array(z.union([z.enum(['simple', 'martial']), IdSchema])).default([]),
      tools: z.array(Name).default([]),
    })
    .prefault({}),
  skills: z.strictObject({ choose: z.int().min(1), from: z.array(SkillSchema).min(1) }),
  subclassLevel: Level,
  asiLevels: z.array(Level).default([]),
  spellcasting: SpellcastingSchema.nullable().default(null),
  scale: z.record(LocalId, ScaleColumn).default({}),
  /** Extra Attack: attacks added from a level on. */
  extraAttacks: z.record(LevelKey, z.int().min(1).max(3)).default({}),
  pools: z.array(PoolSchema).default([]),
  acFormulas: z.array(AcFormula).default([]),
  features: LevelFeatures.default({}),
  choices: z.array(ChoiceSchema).default([]),
});

export const SubclassSchema = z.strictObject({
  kind: z.literal('subclass'),
  ...common,
  parent: IdSchema,
  /**
   * The owner name its own @scale columns are also known by, when it differs from the local id
   * (critique resolution C16): Foundry keys a subclass's scale values by the subclass's own
   * identifier (Circle of the Land: @scale.land.lands-aid), not the parent class's. Its columns
   * resolve as @scale.<local id>.<column>, as @scale.<scaleOwner>.<column>, and in the short form.
   */
  scaleOwner: z.string().regex(KEBAB, 'expected a kebab-case owner name like land').optional(),
  spellcasting: SpellcastingSchema.optional(),
  scale: z.record(LocalId, ScaleColumn).default({}),
  extraAttacks: z.record(LevelKey, z.int().min(1).max(3)).default({}),
  pools: z.array(PoolSchema).default([]),
  acFormulas: z.array(AcFormula).default([]),
  features: LevelFeatures.default({}),
  /** Spells always prepared from a level on. */
  alwaysPrepared: z.record(LevelKey, z.array(IdSchema).min(1)).default({}),
  choices: z.array(ChoiceSchema).default([]),
});

export const SpeciesSchema = z.strictObject({
  kind: z.literal('species'),
  ...common,
  /** The sizes a character of this species can be (one for most). */
  size: z.array(SizeSchema).min(1),
  speed: Ft,
  /**
   * Feature ids, gained at character level 1; or { id, level } for a trait gained later
   * (Draconic Flight and Large Form at character level 5).
   */
  features: z.array(z.union([IdSchema, z.strictObject({ id: IdSchema, level: Level })], { error: 'expected a feature id, or { id, level } for one gained at a later character level' })).default([]),
  resist: z.array(DamageTypeSchema).default([]),
  choices: z.array(ChoiceSchema).default([]),
  /**
   * Session S (repo half): the uses of the species' own limited traits (once per Long Rest), as a
   * class's pools. A pool named like one of its features (the feature id's last segment) exists
   * from the character level that feature is gained; any other from level 1. Omitted when none.
   */
  pools: z.array(PoolSchema).min(1).optional(),
});

export const BackgroundSchema = z.strictObject({
  kind: z.literal('background'),
  ...common,
  /** The three abilities its score increases can go to. */
  abilities: z.array(AbilitySchema).length(3),
  skills: z.array(SkillSchema).length(2),
  tools: z.array(Name).default([]),
  /** Its origin feat. */
  feat: IdSchema,
  choices: z.array(ChoiceSchema).default([]),
});

export const FeatSchema = z.strictObject({
  kind: z.literal('feat'),
  ...common,
  category: z.enum(['origin', 'general', 'fightingStyle', 'epicBoon']),
  repeatable: z.boolean().default(false),
  features: z.array(IdSchema).default([]),
  choices: z.array(ChoiceSchema).default([]),
});

const WEAPON_PROPERTIES = ['finesse', 'light', 'heavy', 'two-handed', 'versatile', 'thrown', 'ammunition', 'loading', 'reach'] as const;

export const WeaponSchema = z
  .strictObject({
    kind: z.literal('weapon'),
    ...common,
    category: z.enum(['simple', 'martial']),
    /** A melee or ranged weapon (kind names the content kind; a thrown melee weapon is melee with the thrown property). */
    attack: z.enum(['melee', 'ranged']),
    /** The weapon's damage die, without the ability modifier. */
    damage: z.strictObject({ roll: Expr, type: DamageTypeSchema }),
    properties: z.array(z.enum(WEAPON_PROPERTIES)).default([]),
    /** [normal, long]: a ranged weapon's range, or a thrown weapon's. */
    range: RangePair.optional(),
    /** Damage used two-handed, for a versatile weapon. */
    versatile: Expr.optional(),
    mastery: z.enum(MASTERIES),
  })
  .superRefine((w, ctx) => {
    const has = (p: (typeof WEAPON_PROPERTIES)[number]) => w.properties.includes(p);
    const ranged = w.attack === 'ranged' || has('thrown');
    if (ranged && w.range === undefined) ctx.addIssue({ code: 'custom', path: ['range'], message: 'a ranged or thrown weapon needs range: [normal, long]' });
    if (!ranged && w.range !== undefined) ctx.addIssue({ code: 'custom', path: ['range'], message: 'only a ranged or thrown weapon has a range' });
    if (has('versatile') !== (w.versatile !== undefined)) ctx.addIssue({ code: 'custom', path: ['versatile'], message: 'versatile damage goes with the versatile property, and the reverse' });
    if (has('ammunition') && w.attack !== 'ranged') ctx.addIssue({ code: 'custom', path: ['properties'], message: 'ammunition is a ranged weapon property' });
    if (new Set(w.properties).size !== w.properties.length) ctx.addIssue({ code: 'custom', path: ['properties'], message: 'a property is listed twice' });
  });

export const ArmorSchema = z
  .strictObject({
    kind: z.literal('armor'),
    ...common,
    category: z.enum(ARMOR_CATEGORIES),
    /** Base AC, or what a shield adds. */
    ac: z.int().min(1),
    /** The most DEX modifier it allows; omit for no cap (light armor) and for heavy armor and shields, which add none. */
    dexCap: z.int().min(0).optional(),
    /** The Strength score it needs, or Speed drops by 10 ft. */
    strength: Score.optional(),
    stealthDis: z.boolean().default(false),
  })
  .superRefine((a, ctx) => {
    if (a.category === 'medium' && a.dexCap === undefined) ctx.addIssue({ code: 'custom', path: ['dexCap'], message: 'medium armor needs dexCap (the most DEX modifier it allows)' });
    if (a.dexCap !== undefined && a.category !== 'medium') ctx.addIssue({ code: 'custom', path: ['dexCap'], message: 'only medium armor caps DEX (light adds it all; heavy armor and shields add none)' });
    if (a.category === 'shield' && (a.strength !== undefined || a.stealthDis)) ctx.addIssue({ code: 'custom', path: ['category'], message: 'a shield has no Strength requirement or Stealth disadvantage' });
  });

// ---- kind: character (M3 step 3: docs/design/m3.md 2.6, critique resolutions C9a, C10, C15, C24) ----
// Class + level + picks; content/character.ts expands it into a PcSource (expandCharacter) that
// compiles exactly like a kind: pc. Only the numbers a sheet can't derive are written here.

/**
 * A pick's key: the id of the item that declares the choice, '#', and the choice's id
 * (srd:fighter#fighting-style, srd:human#skillful, srd:skilled#skills). Two synthetic choices
 * exist besides the ones the data declares: <class id>#asi-<level> for each of the class's
 * asiLevels, and <background id>#abilities for the background's score increases.
 */
export const PICK_KEY = new RegExp(`^(core|srd|private|test):${SEG}(?:/${SEG})*#${SEG}$`);

const Increase = z.int().min(1).max(2);
/** Score increases, recorded (the scores in abilities are already final). */
const AbilityIncreases = z.strictObject({ str: Increase.optional(), dex: Increase.optional(), con: Increase.optional(), int: Increase.optional(), wis: Increase.optional(), cha: Increase.optional() });

const PickValue = z.union(
  [
    /** The options chosen for a data choice: skills, feature ids, feat ids, abilities or tools. */
    z.array(z.string().min(1)).min(1),
    /** An ASI level or the background's increases: which scores went up, and by how much. */
    z.strictObject({ asi: AbilityIncreases }),
    /** An ASI level taken as a feat instead. */
    z.strictObject({ feat: IdSchema }),
  ],
  { error: 'expected a list of chosen options, { asi: { <ability>: 1|2 } } or { feat: <feat id> }' },
);
export type PickValueSrc = z.output<typeof PickValue>;

/** Character fields an override may set (closed): the number it sets and why the table differs. */
export const OVERRIDABLE = ['pb', 'hpMax', 'ac', 'speed', 'initiativeBonus', 'extraAttacks'] as const;
const Override = z.strictObject({ value: z.int(), why: z.string().min(1) });

const CharacterWeapon = z.union([IdSchema, z.strictObject({ id: IdSchema, count: z.int().min(0).optional() })], {
  error: 'expected a weapon id, or { id, count } for a thrown weapon carried in a stack',
});

export const CharacterSchema = z.strictObject({
  kind: z.literal('character'),
  id: IdSchema,
  name: Name,
  /** Where the character comes from; printed like any item's source. */
  source: z.string().min(1).default('character file'),
  placeholder: z.boolean().default(false),
  /** Lines the author knows the engine leaves out, besides the ones the expansion finds. */
  unimplemented: z.array(z.string().min(1)).default([]),
  rules: z.literal('2024'),
  /** Exactly one class in M3 (C24: single-class, levels 1-10 modeled, 11-20 load as narrative). */
  classes: z
    .array(z.strictObject({ class: IdSchema, level: Level, subclass: IdSchema.optional() }))
    .length(1, 'exactly one class in M3 (multiclassing comes later; the list keeps the file shape)'),
  species: IdSchema,
  /** One of the species' sizes; needed only when it has more than one. */
  size: SizeSchema.optional(),
  background: IdSchema,
  /** Final scores, as on the sheet (increases are already in them; picks only record them). */
  abilities: Abilities,
  /**
   * Hit points after level 1 (SRD 5.2.1 p.22-23): average is the Fixed Hit Points by Class value
   * per level; max is the full Hit Die per level (a table variant); rolled lists the rolls for
   * levels 2 and up, each with the minimum of 1 after the CON modifier.
   */
  hp: z.union([z.enum(['average', 'max']), z.strictObject({ rolled: z.array(z.int().min(1).max(12)) })]).default('average'),
  picks: z.record(z.string().regex(PICK_KEY, 'expected a pick key like srd:fighter#skills (<owner id>#<choice id>)'), PickValue).default({}),
  equipment: z
    .strictObject({
      /** Worn armor (a light, medium or heavy armor id), or null. */
      armor: IdSchema.nullable().default(null),
      /** A Shield: true for the loaded shield armor (when exactly one is loaded), or its id. */
      shield: z.union([z.boolean(), IdSchema]).default(false),
      weapons: z.array(CharacterWeapon).default([]),
      /** Other items that matter to the rules (a focus, a pouch); the shield goes in shield. */
      items: z.array(ItemSchema).default([]),
      /** What each hand holds when a fight starts: a weapon's or item's local id, 'shield', or null. */
      hands: z.tuple([LocalId.nullable(), LocalId.nullable()]).optional(),
    })
    .prefault({}),
  /** Which AC calculation to use instead of the best legal one: armor, unarmored, or a class or subclass id (its acFormulas). */
  acSource: z.union([z.enum(['armor', 'unarmored']), IdSchema]).optional(),
  /** Per spellcasting class or subclass: the cantrips and prepared spells chosen (always-prepared ones come from the data). */
  casting: z.array(z.strictObject({ source: IdSchema, cantrips: z.array(IdSchema).default([]), prepared: z.array(IdSchema).default([]) })).default([]),
  /** Extra feature ids nothing in the build grants (rare; linted). */
  features: z.array(IdSchema).default([]),
  overrides: z
    .strictObject({
      pb: Override.optional(),
      hpMax: Override.optional(),
      ac: Override.optional(),
      speed: Override.optional(),
      initiativeBonus: Override.optional(),
      extraAttacks: Override.optional(),
    })
    .default({}),
  flags: FlagsSchema.default({}),
});

export const KnobsSchema = z.strictObject({
  maxRounds: z.int().min(1).max(1000).default(DEFAULT_KNOBS.maxRounds),
  attackDowned: z.enum(['never', 'ifNoOtherTarget', 'always']).default(DEFAULT_KNOBS.attackDowned),
  lossCounts: z.enum(['pcs', 'party']).default(DEFAULT_KNOBS.lossCounts),
  downEnds: z.boolean().default(DEFAULT_KNOBS.downEnds),
});

/**
 * A spell already running when the fight starts (docs/design/m1c.md 7.4). Resolved before
 * initiative, rolling no dice; scenario resolution checks the rest (sim/precast.ts). The
 * `feature` form is in the schema for later; M1c resolves spells only.
 */
const PrecastSchema = z
  .strictObject({
    cast: IdSchema.optional(),
    feature: IdSchema.optional(),
    /** Slot level spent; omit for a cantrip or with `pool`. */
    level: z.int().min(1).max(9).optional(),
    /** A free-cast pool (its local id) spent instead of a slot. */
    pool: z.string().optional(),
    /** Area origin, for a spell with an area. */
    at: z.string().regex(/^[A-Z]{1,2}[1-9][0-9]?$/, 'expected a square like C4').optional(),
    /** Target seat, for a spell that targets. */
    target: z.string().optional(),
    /** The option a choice in the spell takes (its local id), or a skill. */
    choose: z.string().nullable().default(null),
    /** Rounds already gone by: the effect ends that many rounds sooner. */
    elapsed: z.int().min(0).default(0),
    /**
     * Who saw it cast (feeds zoneKnowledge: sawCast); the caster always knows. `side`: the
     * caster's own side (the default); `party`: the party's side, whoever cast it; `all`;
     * `none`; or a list of seats.
     */
    seenBy: z.union([z.enum(['side', 'party', 'all', 'none']), z.array(z.string())]).default('side'),
  })
  .refine((p) => (p.cast === undefined) !== (p.feature === undefined), 'give exactly one of cast or feature')
  .refine((p) => p.level === undefined || p.pool === undefined, 'give level or pool, not both');

/**
 * When and how a scenario's encounter was calibrated (docs/design/m1c.md 7.2): reports print it,
 * flag it stale when the engine, the greedy AI or its default weights have changed since, and
 * say so when it was measured on a different setup (another scenario file, or the same file
 * after its units or content changed). Metadata only: not in the scenario hash, and never
 * inherited by a scenario that extends this one.
 */
export const CalibrationSchema = z.strictObject({
  engine: z.string(),
  /** weightsHash(DEFAULT_WEIGHTS) and GREEDY_VERSION at the time. */
  weights: z.string().regex(/^[0-9a-f]{8}$/),
  ai: z.int().min(1),
  /** The scenario and content hashes of the setup it was measured on (a report's replay line prints both). */
  scenarioHash: z.string().regex(/^[0-9a-f]{16}$/),
  contentHash: z.string().regex(/^[0-9a-f]{16}$/),
  policy: z.string(),
  seed: z.int().min(0),
  runs: z.int().min(1),
  win: z.number().min(0).max(1),
  note: z.string().optional(),
});

const UnitSchema = z.strictObject({
  /** Scenario slot id; units are ordered by seat. */
  seat: z.string().regex(/^[a-z][a-z0-9-]*$/, 'seats are lower-case like pc1 or gob-3'),
  team: z.enum(['party', 'enemies']),
  use: IdSchema,
  at: z.string().regex(/^[A-Z]{1,2}[1-9][0-9]?$/, 'expected a square like C4'),
  decider: z.enum(['baseline', 'journal', 'random-legal', 'greedy']).default('baseline'),
  /** Decider to hand over to when a journal runs out. */
  fallback: z.enum(['baseline', 'random-legal', 'greedy']).optional(),
  /** Starting HP; defaults to the template's. */
  hp: z.int().min(1).optional(),
  /**
   * Starting spell slots and pool uses, for a fight that starts with some already spent (a scene
   * hands one over). slots: level 1 first; pools: by the pool's id. Anything left out starts full,
   * and a number above the template's maximum is capped at it.
   */
  resources: z.strictObject({ slots: z.array(z.int().min(0)).max(9).optional(), pools: z.record(z.string().min(1), z.int().min(0)).optional() }).optional(),
  prone: z.boolean().default(false),
  surprised: z.boolean().default(false),
  /** Spells already up when the fight starts, resolved in this order. */
  precast: z.array(PrecastSchema).default([]),
  /** What 0 HP means for this unit; defaults by kind and the statBlockAtZeroHp flag. */
  atZero: z.enum(['dies', 'deathSaves']).optional(),
});

export const ScenarioSchema = z.strictObject({
  kind: z.literal('scenario'),
  id: z.string().regex(KEBAB, 'scenario ids are kebab-case'),
  name: Name,
  description: z.string().optional(),
  rules: z.literal('2024'),
  /** Pack names the units come from. */
  packs: z.array(z.string().regex(PACK_NAME)).min(1),
  grid: z.strictObject({
    w: z.int().min(1).max(MAX_W),
    h: z.int().min(1).max(MAX_H),
    /** h rows of w characters: '.' open, '#' wall, ':' difficult. */
    terrain: z.array(z.string()).optional(),
  }),
  flags: FlagsSchema.default({}),
  knobs: KnobsSchema.prefault({}),
  units: z.array(UnitSchema).min(2).max(55),
  calibrated: CalibrationSchema.optional(),
  /** Lines every report on this scenario prints: the encounter budget, which way unmodeled features bias the result. Not hashed. */
  reportNotes: z.array(z.string().min(1)).optional(),
});

/**
 * A scenario that extends another by name (docs/design/m1c.md 7.3): the base's fields, plus
 * packs added with a leading "+", flags and knobs merged over the base's, and per-seat field
 * replacements. Nested objects are replaced, not merged. scenario/extend.ts applies it.
 */
export const ExtendingScenarioSchema = z.strictObject({
  kind: z.literal('scenario'),
  id: z.string().regex(KEBAB, 'scenario ids are kebab-case'),
  name: Name.optional(),
  description: z.string().optional(),
  extends: z.string().regex(KEBAB, 'extends names a scenario by its file name'),
  packs: z.array(z.string().regex(/^\+[a-z0-9]+(?:[-.][a-z0-9]+)*$/, 'packs added here start with "+"')).optional(),
  flags: FlagsSchema.optional(),
  knobs: KnobsSchema.partial().optional(),
  override: z.strictObject({ units: z.record(z.string(), UnitSchema.omit({ seat: true }).partial()) }).optional(),
  calibrated: CalibrationSchema.optional(),
  reportNotes: z.array(z.string().min(1)).optional(),
});
export type ExtendingScenarioSource = z.infer<typeof ExtendingScenarioSchema>;

/**
 * A play policy (docs/design/m1c.md 2): a base decider plus scripted directives that fire when
 * their condition holds, and concentration it never gives up. Policies reference content by
 * resolved id; repo policies use SRD and test ids only (private ones live in ~/.montecrit/policies/).
 */
const PolicyDirective = z.union([
  z.strictObject({ cast: IdSchema, level: z.union([z.literal('lowest'), z.int().min(0).max(9)]).default('lowest') }),
  z.strictObject({ use: IdSchema }),
  z.strictObject({ attack: z.string().min(1) }),
  z.strictObject({ option: IdSchema }),
]);
export const PolicySchema = z.strictObject({
  kind: z.literal('policy'),
  id: z.string().regex(KEBAB, 'policy ids are kebab-case'),
  name: Name,
  description: z.string().optional(),
  /** Which seats it plays: every PC, the whole party, or listed seats. Other seats keep their scenario decider. */
  seats: z.union([z.enum(['pcs', 'party']), z.array(z.string().min(1)).min(1)]).default('pcs'),
  base: z.enum(['greedy', 'baseline', 'random-legal']).default('greedy'),
  /** Overrides of the greedy AI's top-level numeric weights and its target priority (decide/greedy/weights.ts). */
  weights: z
    .strictObject({
      horizon: z.int().min(1).max(20).optional(),
      gamma: z.number().min(0).max(1).optional(),
      perFoot: z.number().min(0).optional(),
      throwAway: z.number().min(0).optional(),
      approach: z.number().min(0).optional(),
      retreatMin: z.number().min(0).optional(),
      slotPerLevel: z.number().min(0).optional(),
      freeCast: z.number().min(0).optional(),
      poolUse: z.number().min(0).optional(),
      reactMin: z.number().min(0).optional(),
      targetStyle: z.enum(['ev', 'nearest', 'threat']).optional(),
    })
    .default({}),
  script: z
    .array(
      z.strictObject({
        id: z.string().regex(KEBAB),
        /** All given conditions must hold: from the creature's Nth own turn on, from round N on, whether it's concentrating. */
        when: z.strictObject({ myTurn: z.int().min(1).optional(), round: z.int().min(1).optional(), concentrating: z.boolean().optional() }).default({}),
        do: PolicyDirective,
        /** The option to pick when the directive's program asks (a form's constellation, say). */
        pick: z.string().min(1).nullable().default(null),
        /** Own turns to keep trying when the directive isn't legal, before giving up on it. */
        retry: z.int().min(0).max(20).default(2),
      }),
    )
    .default([]),
  /** Concentration it never replaces while it's live. */
  hold: z.array(z.strictObject({ concentration: IdSchema })).default([]),
  /**
   * M3 step 5a: riders it always takes when the engine offers them (Stunning Strike on every
   * eligible hit). `rider` is the rider's id (its journal key is rider:<id>); `pick` names the
   * option of a choose rider (Open Hand Technique's topple), else the base decider picks one.
   * Every other rider decision is the base decider's.
   */
  riders: z.array(z.strictObject({ rider: z.string().regex(KEBAB), pick: z.string().regex(KEBAB).optional() })).default([]),
});
export type PolicySource = z.infer<typeof PolicySchema>;

export const JournalSchema = z.strictObject({
  kind: z.literal('journal'),
  scenario: z.string().regex(KEBAB),
  seed: z.int().min(0),
  run: z.int().min(0).default(0),
  engine: z.string().min(1),
  contentHash: z.string().min(1),
  scenarioHash: z.string().min(1).optional(),
  entries: z.array(
    z.strictObject({
      seat: z.string().min(1),
      key: z.string().min(1),
      at: z.int().min(0).optional(),
    }),
  ),
});

export type ManifestSource = z.output<typeof ManifestSchema>;
export type MonsterSource = z.output<typeof MonsterSchema>;
export type PcSource = z.output<typeof PcSchema>;
export type CharacterSource = z.output<typeof CharacterSchema>;
export type SpellSource = z.output<typeof SpellSchema>;
export type FeatureSource = z.output<typeof FeatureSchema>;
export type ClassSource = z.output<typeof ClassSchema>;
export type SubclassSource = z.output<typeof SubclassSchema>;
export type SpeciesSource = z.output<typeof SpeciesSchema>;
export type BackgroundSource = z.output<typeof BackgroundSchema>;
export type FeatSource = z.output<typeof FeatSchema>;
export type WeaponSource = z.output<typeof WeaponSchema>;
export type ArmorSource = z.output<typeof ArmorSchema>;
export type ScenarioSource = z.output<typeof ScenarioSchema>;
export type JournalFile = z.output<typeof JournalSchema>;

/** Schemas by content kind, in a fixed order. */
export const CONTENT_SCHEMAS = [
  ['manifest', ManifestSchema],
  ['monster', MonsterSchema],
  ['pc', PcSchema],
  ['character', CharacterSchema],
  ['spell', SpellSchema],
  ['feature', FeatureSchema],
  ['class', ClassSchema],
  ['subclass', SubclassSchema],
  ['species', SpeciesSchema],
  ['background', BackgroundSchema],
  ['feat', FeatSchema],
  ['weapon', WeaponSchema],
  ['armor', ArmorSchema],
  ['scenario', ScenarioSchema],
  ['journal', JournalSchema],
] as const;

/** JSON Schemas for editors, one per file kind (input shape: defaulted keys are optional). */
export function contentJsonSchemas(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, schema] of CONTENT_SCHEMAS) {
    out[name] = { title: `montecrit ${name}`, ...z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' }) };
  }
  return out;
}
