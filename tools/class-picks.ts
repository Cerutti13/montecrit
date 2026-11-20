// The curated per-class pick table and the per-class core-feature table (docs/design/coverage.md
// section 4 "Curated smoke and bench picks", M13 (c) and (e), L1). One build per class, used at
// levels 1, 3, 5, 6 and 10 by both the smoke corpus (tools/smoke-corpus.ts) and the class bench
// (tools/bench-classes.ts): typical SRD-only picks (no Archery with a Longsword, no Agonizing
// Blast without Eldritch Blast, casters prepare from a typical list rather than alphabetically).
// Picks the table doesn't name are filled by the corpus's deterministic first-legal rule.
//
// Spells come only from the emitted SRD spells (packs/srd-5.2.1/spells); a preference the build
// can't take at a level (too high, not on the list, not emitted) is skipped, and the counts are
// filled by the old rule (highest level first, then id). The judgment calls are marked [U].
//
// Also here: the frozen "plays well" thresholds (coverage.md section 6 as amended by M13; frozen
// before C0, never tuned to results) and the fail-closed NON_SRD_NAMES scan (L1).

import { checkText } from './check-private.ts';

export const PICK_LEVELS = [1, 3, 5, 6, 10] as const;
export const PICK_CLASSES = ['barbarian', 'bard', 'cleric', 'druid', 'fighter', 'monk', 'paladin', 'ranger', 'rogue', 'sorcerer', 'warlock', 'wizard'] as const;
export type PickClass = (typeof PICK_CLASSES)[number];
export type Ability = 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';

export type GearWeapon = string | { readonly id: string; readonly count: number };

/**
 * A spellcasting focus the build carries (review C0-BENCH-M1): an inline character item
 * (equipment.items), since no SRD pack file defines adventuring gear. `cite` is the PDF line of
 * the class's starting equipment, its Spellcasting Focus line and the item's form.
 */
export interface GearFocus {
  readonly id: string;
  readonly name: string;
  /** The spell lists it is a focus for (the class's own list: its Spellcasting Focus line). */
  readonly focusFor: readonly string[];
  readonly cite: string;
}

export interface ClassBuild {
  /** Standard array order (SRD 5.2.1 p.20-21 "Standard Array"), primary ability first. */
  readonly priority: readonly Ability[];
  readonly species: string;
  /** For a species with two sizes. */
  readonly size?: 'small' | 'medium';
  readonly background: string;
  readonly armor: string | null;
  readonly shield: boolean;
  readonly weapons: readonly GearWeapon[];
  /** Its PDF kit's spellcasting focus, if any (carried; held only when `hands` names it). */
  readonly focus?: GearFocus;
  /** What each hand holds when a fight starts (equipment.hands); omitted: the character default. */
  readonly hands?: readonly [string | null, string | null];
  /** Choice key -> ids in preference order (fighting styles, masteries, invocations, lineages, origin feats). */
  readonly prefer: Readonly<Record<string, readonly string[]>>;
  /** Spell preferences per casting source, in order; filtered to what the level can take. */
  readonly cantrips?: readonly string[];
  readonly prepared?: readonly string[];
  /** Why the build looks like this, for the bench's printed assumptions. */
  readonly note: string;
}

/**
 * One typical SRD build per class. Every id is srd:. The one subclass per class in SRD 5.2.1 is
 * taken from level 3 (the corpus resolves it from the pack). [U] the choices are judgment calls
 * of "typical", reviewed once; changing one moves every bench baseline (coverage.md risk 11).
 */
export const CURATED: Readonly<Record<PickClass, ClassBuild>> = {
  barbarian: {
    priority: ['str', 'con', 'dex', 'wis', 'cha', 'int'],
    species: 'srd:goliath',
    background: 'srd:soldier',
    armor: null,
    shield: false,
    weapons: ['srd:greataxe', { id: 'srd:handaxe', count: 2 }],
    prefer: { 'srd:barbarian#weapon-mastery': ['srd:greataxe', 'srd:handaxe', 'srd:greatsword', 'srd:maul'], 'srd:goliath#giant-ancestry': ['srd:goliath/stones-endurance'] },
    note: 'Greataxe two-handed, two Handaxes to throw; Unarmored Defense',
  },
  bard: {
    priority: ['cha', 'dex', 'con', 'wis', 'int', 'str'],
    species: 'srd:human',
    size: 'medium',
    background: 'srd:acolyte',
    armor: 'srd:leather-armor',
    shield: false,
    weapons: ['srd:dagger'],
    // Review C0-BENCH-M1: the kit's Musical Instrument is its focus (srd-raw.txt:5246-5249, 5852;
    // lute 21392), held with a hand free for Somatic components; the Dagger is carried.
    focus: { id: 'lute', name: 'Lute', focusFor: ['bard'], cite: 'srd-raw.txt:5246-5249 (kit), 5852 (focus), 21392 (lute)' },
    hands: ['lute', null],
    prefer: { 'srd:human#versatile': ['srd:alert'] },
    cantrips: ['srd:vicious-mockery', 'srd:starry-wisp'],
    // Coverage steps 7.3, 7.4: the reviewed area picks after the heals [U which classes take them: judgment, step7-plan.md section 5].
    // Thunderwave ahead of Sleep: at the default areaGridCoverage Sleep covers one square and the bench casts it 0.00 per fight,
    // so it waits for L5. Hypnotic Pattern (cast on the party bench) then Longstrider and Faerie Fire are named so the
    // first-legal fill doesn't put Fear in ahead of them [U: judgment, read from per-spell casts per fight].
    prepared: ['srd:dissonant-whispers', 'srd:healing-word', 'srd:shatter', 'srd:hold-person', 'srd:cure-wounds', 'srd:thunderwave', 'srd:sleep', 'srd:hypnotic-pattern', 'srd:hold-monster', 'srd:longstrider', 'srd:faerie-fire'],
    note: 'Lore support caster: Vicious Mockery, Dissonant Whispers, Shatter, Healing Word',
  },
  cleric: {
    priority: ['wis', 'con', 'str', 'dex', 'cha', 'int'],
    species: 'srd:dwarf',
    background: 'srd:acolyte',
    armor: 'srd:scale-mail',
    shield: true,
    weapons: ['srd:mace'],
    // Review C0-BENCH-M1: the kit's Holy Symbol (srd-raw.txt:6897-6898, focus 7484-7485), as a
    // reliquary (held, 22284). [U] An emblem borne on the Shield (22246) isn't modeled, so it is
    // carried: Mace and Shield in hand as before, the symbol drawn when a hand is free.
    focus: { id: 'holy-symbol', name: 'Holy Symbol (reliquary)', focusFor: ['cleric'], cite: 'srd-raw.txt:6897-6898 (kit), 7484-7485 (focus), 22284 (reliquary, held)' },
    prefer: { 'srd:cleric#divine-order': ['srd:cleric/divine-order-protector'], 'srd:cleric#blessed-strikes': ['srd:cleric/blessed-strikes-potent-spellcasting'] },
    cantrips: ['srd:sacred-flame', 'srd:guidance'],
    prepared: ['srd:guiding-bolt', 'srd:healing-word', 'srd:cure-wounds', 'srd:shield-of-faith', 'srd:inflict-wounds', 'srd:spirit-guardians', 'srd:hold-person', 'srd:insect-plague'], // Spirit Guardians: coverage step 7.5, Cleric L5+ [U: judgment]
    note: 'Life Domain, Scale Mail and Shield: Guiding Bolt, Sacred Flame, healing',
  },
  druid: {
    priority: ['wis', 'con', 'dex', 'int', 'cha', 'str'],
    species: 'srd:elf',
    background: 'srd:sage',
    armor: 'srd:leather-armor',
    // Review C0-BENCH-M1: kit A (srd-raw.txt:8484-8485) is Leather Armor, Shield, Sickle and a
    // Druidic Focus (focus 9078-9079). [U] The bench build leaves the Shield out: a focus hand makes
    // Somatic components only for a spell with a Material one (2024 SAC, focusHandSomatic strict)
    // and greedy never stows a focus, so Shield plus focus would bar Produce Flame for good. It
    // holds the focus with a hand free; the Sickle is carried. [U] The kit's Quarterstaff focus
    // can't be both (no weapon is a focus in the engine): a sprig of mistletoe (22271).
    shield: false,
    weapons: ['srd:sickle'],
    focus: { id: 'druidic-focus', name: 'Druidic Focus (sprig of mistletoe)', focusFor: ['druid'], cite: 'srd-raw.txt:8484-8485 (kit), 9078-9079 (focus), 22271 (sprig of mistletoe)' },
    hands: ['druidic-focus', null],
    prefer: { 'srd:elf#elven-lineage': ['srd:elf/elven-lineage-wood-elf'], 'srd:druid#primal-order': ['srd:druid/primal-order-magician'], 'srd:druid#elemental-fury': ['srd:druid/elemental-fury-potent-spellcasting'] },
    cantrips: ['srd:produce-flame', 'srd:starry-wisp', 'srd:poison-spray', 'srd:guidance'],
    // Coverage step 7.3: the reviewed area picks after the core spell and the heals [U: judgment].
    // Faerie Fire named last so the L5 kit's fill slot isn't Charm Person (a Druid 6 or 10 prepares every emitted spell anyway).
    prepared: ['srd:moonbeam', 'srd:healing-word', 'srd:cure-wounds', 'srd:spike-growth', 'srd:entangle', 'srd:thunderwave', 'srd:ice-storm', 'srd:insect-plague', 'srd:blight', 'srd:hold-person', 'srd:longstrider', 'srd:faerie-fire'],
    note: 'Circle of the Land caster: Moonbeam, Produce Flame, Spike Growth; Druidic Focus in hand, no Shield',
  },
  fighter: {
    priority: ['str', 'con', 'dex', 'wis', 'int', 'cha'],
    species: 'srd:human',
    size: 'medium',
    background: 'srd:soldier',
    armor: 'srd:chain-mail',
    shield: true,
    weapons: ['srd:longsword', { id: 'srd:handaxe', count: 2 }],
    // Sword and board: Defense. The Champion's second style (level 7, so only the L10 build): [U] Two-Weapon Fighting (harmless; no Archery with a Longsword).
    prefer: { 'srd:fighter#fighting-style': ['srd:defense'], 'srd:champion#fighting-style': ['srd:two-weapon-fighting'], 'srd:fighter#weapon-mastery': ['srd:longsword', 'srd:handaxe', 'srd:greatsword', 'srd:longbow', 'srd:battleaxe'], 'srd:human#versatile': ['srd:alert'] },
    note: 'Champion, Longsword and Shield, Defense style, two Handaxes to throw',
  },
  monk: {
    priority: ['dex', 'wis', 'con', 'str', 'int', 'cha'],
    species: 'srd:elf',
    background: 'srd:criminal',
    armor: null,
    shield: false,
    weapons: ['srd:shortsword', { id: 'srd:dart', count: 10 }],
    prefer: { 'srd:elf#elven-lineage': ['srd:elf/elven-lineage-wood-elf'] },
    note: 'Open Hand, Shortsword and Darts, Unarmored Defense',
  },
  paladin: {
    priority: ['str', 'cha', 'con', 'wis', 'dex', 'int'],
    species: 'srd:dragonborn',
    background: 'srd:soldier',
    armor: 'srd:chain-mail',
    shield: true,
    weapons: ['srd:longsword', { id: 'srd:javelin', count: 2 }],
    // Review C0-BENCH-M1: the kit's Holy Symbol (srd-raw.txt:11383-11385, focus 11890-11891), a
    // reliquary (22284), carried: Longsword and Shield in hand as before.
    focus: { id: 'holy-symbol', name: 'Holy Symbol (reliquary)', focusFor: ['paladin'], cite: 'srd-raw.txt:11383-11385 (kit), 11890-11891 (focus), 22284 (reliquary, held)' },
    prefer: { 'srd:paladin#fighting-style': ['srd:defense'], 'srd:paladin#weapon-mastery': ['srd:longsword', 'srd:javelin'] },
    prepared: ['srd:shield-of-faith', 'srd:cure-wounds'],
    note: 'Devotion, Longsword and Shield, Defense style, two Javelins',
  },
  ranger: {
    priority: ['dex', 'wis', 'con', 'str', 'int', 'cha'],
    species: 'srd:elf',
    background: 'srd:soldier',
    armor: 'srd:studded-leather-armor',
    shield: false,
    weapons: [{ id: 'srd:longbow', count: 20 }, 'srd:shortsword'], // 20 arrows (M3 step 5b counts ammunition)
    // Review C0-BENCH-M1: the kit's Druidic Focus (sprig of mistletoe, srd-raw.txt:12467-12470; focus
    // 12966-12967), carried: the Longbow fills both hands.
    focus: { id: 'druidic-focus', name: 'Druidic Focus (sprig of mistletoe)', focusFor: ['ranger'], cite: 'srd-raw.txt:12467-12470 (kit), 12966-12967 (focus)' },
    prefer: { 'srd:elf#elven-lineage': ['srd:elf/elven-lineage-wood-elf'], 'srd:ranger#fighting-style': ['srd:archery'], 'srd:ranger#weapon-mastery': ['srd:longbow', 'srd:shortsword'] },
    prepared: ['srd:spike-growth', 'srd:cure-wounds', 'srd:entangle', 'srd:longstrider'], // Entangle: coverage step 7.3 [U: judgment]
    note: 'Hunter archer: Longbow with Archery, Shortsword backup',
  },
  rogue: {
    priority: ['dex', 'con', 'int', 'wis', 'cha', 'str'],
    species: 'srd:halfling',
    background: 'srd:criminal',
    armor: 'srd:leather-armor',
    shield: false,
    weapons: ['srd:rapier', { id: 'srd:shortbow', count: 20 }], // 20 arrows
    prefer: { 'srd:rogue#weapon-mastery': ['srd:rapier', 'srd:shortbow'] },
    note: 'Thief, Rapier and Shortbow',
  },
  sorcerer: {
    priority: ['cha', 'con', 'dex', 'wis', 'int', 'str'],
    species: 'srd:tiefling',
    size: 'medium',
    background: 'srd:acolyte',
    armor: null,
    shield: false,
    weapons: ['srd:dagger'],
    // Review C0-BENCH-M1: the kit's Arcane Focus (crystal) (srd-raw.txt:13992-13994; focus
    // 14593-14594; crystal 22022), held with a hand free; the Dagger is carried.
    focus: { id: 'arcane-focus', name: 'Arcane Focus (crystal)', focusFor: ['sorcerer'], cite: 'srd-raw.txt:13992-13994 (kit), 14593-14594 (focus), 22022 (crystal)' },
    hands: ['arcane-focus', null],
    prefer: { 'srd:tiefling#fiendish-legacy': ['srd:tiefling/fiendish-legacy-infernal'], 'srd:sorcerer#metamagic-2': ['srd:sorcerer/quickened-spell', 'srd:sorcerer/twinned-spell'], 'srd:sorcerer#metamagic-10': ['srd:sorcerer/empowered-spell', 'srd:sorcerer/heightened-spell'] },
    cantrips: ['srd:fire-bolt', 'srd:ray-of-frost', 'srd:shocking-grasp', 'srd:acid-splash', 'srd:poison-spray'],
    // Coverage steps 7.3, 7.4: the reviewed area picks after the core spells; Sleep ahead of Thunderwave, or a Sorcerer's two L1 spells never reach it [U: judgment].
    prepared: ['srd:fireball', 'srd:shatter', 'srd:burning-hands', 'srd:sleep', 'srd:thunderwave', 'srd:hold-person', 'srd:mind-spike', 'srd:ice-storm', 'srd:vitriolic-sphere', 'srd:cloudkill', 'srd:hold-monster', 'srd:blight', 'srd:insect-plague'],
    note: 'Draconic blaster: Fire Bolt, Shatter, Fireball',
  },
  warlock: {
    priority: ['cha', 'con', 'dex', 'wis', 'int', 'str'],
    species: 'srd:tiefling',
    size: 'medium',
    background: 'srd:acolyte',
    armor: 'srd:leather-armor',
    shield: false,
    weapons: ['srd:dagger'],
    // Review C0-BENCH-M1: the kit's Arcane Focus (orb) (srd-raw.txt:15883-15884; focus 16322-16323;
    // orb 22028), held with a hand free; the Dagger is carried.
    focus: { id: 'arcane-focus', name: 'Arcane Focus (orb)', focusFor: ['warlock'], cite: 'srd-raw.txt:15883-15884 (kit), 16322-16323 (focus), 22028 (orb)' },
    hands: ['arcane-focus', null],
    // Eldritch Blast isn't emitted yet (coverage.md census 3), so no Agonizing Blast or Repelling Blast: [U] defensive and utility invocations instead.
    // No Armor of Shadows with the Leather Armor (review R2): Mage Armor needs a target "who isn't
    // wearing armor" and ends "if the target dons armor" (srd-raw.txt:28619-28621), so it would be
    // dead; Eldritch Mind (16434-16437, no prerequisite) works in armor. Every slot is named, so the
    // first-legal fill never brings Armor of Shadows back (prerequisites: 16420-16421, 16467-16468, 16579-16580,
    // 16585-16587, 16491-16493, 16565-16567; Mask of Many Faces is Disguise Self at will, so non-combat).
    prefer: {
      'srd:tiefling#fiendish-legacy': ['srd:tiefling/fiendish-legacy-infernal'],
      'srd:warlock#eldritch-invocations-1': ['srd:warlock/eldritch-mind'],
      'srd:warlock#eldritch-invocations-2': ['srd:warlock/devils-sight', 'srd:warlock/misty-visions'],
      'srd:warlock#eldritch-invocations-5': ['srd:warlock/fiendish-vigor', 'srd:warlock/one-with-shadows'],
      'srd:warlock#eldritch-invocations-7': ['srd:warlock/gift-of-the-depths'],
      'srd:warlock#eldritch-invocations-9': ['srd:warlock/mask-of-many-faces'],
    },
    cantrips: ['srd:poison-spray'],
    prepared: ['srd:hold-person', 'srd:mind-spike', 'srd:blight', 'srd:hold-monster'],
    note: 'Fiend Patron; Eldritch Blast not emitted, so Poison Spray and Pact Magic slots',
  },
  wizard: {
    priority: ['int', 'con', 'dex', 'wis', 'cha', 'str'],
    species: 'srd:gnome',
    background: 'srd:sage',
    armor: null,
    shield: false,
    weapons: ['srd:quarterstaff'],
    // Review C0-BENCH-M1: the kit's Arcane Focus (srd-raw.txt:17346; focus 17894-17896). [U] The
    // kit's focus is the Quarterstaff, but no weapon is a focus in the engine: a crystal (22022)
    // held with a hand free, the Quarterstaff carried.
    focus: { id: 'arcane-focus', name: 'Arcane Focus (crystal)', focusFor: ['wizard'], cite: 'srd-raw.txt:17345-17346 (kit), 17894-17896 (focus), 22022 (crystal)' },
    hands: ['arcane-focus', null],
    prefer: { 'srd:gnome#gnomish-lineage': ['srd:gnome/gnomish-lineage-rock'] },
    cantrips: ['srd:fire-bolt', 'srd:ray-of-frost', 'srd:shocking-grasp', 'srd:acid-splash', 'srd:poison-spray'],
    // Coverage steps 7.3, 7.4: the reviewed area picks after the core spells [U: judgment].
    prepared: ['srd:fireball', 'srd:shatter', 'srd:burning-hands', 'srd:sleep', 'srd:thunderwave', 'srd:mind-spike', 'srd:hold-person', 'srd:ice-storm', 'srd:vitriolic-sphere', 'srd:cloudkill', 'srd:hold-monster', 'srd:blight', 'srd:longstrider'],
    note: 'Evoker blaster: Fire Bolt, Shatter, Fireball',
  },
};

/** Every srd: id the table names (tests check each is defined by the SRD pack). */
export function curatedIds(): string[] {
  const ids = new Set<string>();
  for (const c of PICK_CLASSES) {
    const b = CURATED[c];
    ids.add(b.species);
    ids.add(b.background);
    if (b.armor) ids.add(b.armor);
    for (const w of b.weapons) ids.add(typeof w === 'string' ? w : w.id);
    for (const k of Object.keys(b.prefer).sort()) for (const v of b.prefer[k]!) ids.add(v);
    for (const s of [...(b.cantrips ?? []), ...(b.prepared ?? [])]) ids.add(s);
  }
  return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// ---------------------------------------------------------------------------------------------
// The per-class core-feature table (coverage.md M13 (e)), for U (core use) and F (feature matters).

/**
 * How the bench sees a core feature in a fight's events (tools/bench-trace.ts):
 * - act: an `act` event with one of these vias (a feature's activation or an automatic rider)
 * - cast: a `cast` event of a spell in `spells` ('*leveled-or-damaging' means any leveled spell or a damaging cantrip)
 * Removal (the F arm) filters the PC's decisions: `use` items of `features` and `cast` items of `spells`.
 */
export interface CoreFeature {
  readonly label: string;
  /** Feature ids whose presence in the compiled template's `features` means it's modeled; empty for spell cores. */
  readonly features: readonly string[];
  /** Spell ids in preference order (the first the PC has is "its best"); '*' = every spell it has. */
  readonly spells: readonly string[];
  /** Feature ids of automatic riders that count as a use but can't be removed by a decision filter. */
  readonly autoActs: readonly string[];
  /** Not modeled at all yet: the feature, and the wave that brings it. */
  readonly notModeled?: string;
}

export interface CoreEntry {
  readonly cls: PickClass;
  readonly core: readonly CoreFeature[];
  /** The U rule in words and its frozen threshold (a fraction). */
  readonly uRule: string;
  readonly uThreshold: number;
  /** Where the threshold comes from: a coverage.md section-6 line, or [U] proposed here (not in the doc). */
  readonly uSource: string;
  /**
   * How U reads the rule (review R1, R2), never a looser reading under the rule's label:
   * - perFight: a fight counts when one of `uIds` is used in it (an `act` via or a `cast` spell id;
   *   the casters' rule reads any leveled cast or damaging cantrip)
   * - byRound2: a fight counts when one of `uIds` is first cast or used in round 1 or 2
   * - uptimeAfterRound1: the PC's up turns from round 2 on, the share that start with an effect
   *   from one of `uIds` on it ([U] "Rage up" read as the Rage effect borne at the start of its turn)
   * - perQualifyingTurn (W1, w1-plan.md 4.1): the turns on which one of `uIds`' riders was offered
   *   (a 'rider' decision whose src.via is the feature: the hit qualified), deduped per turn, any
   *   creature's turn (an Opportunity Attack's turn is its own); the share of them on which it was
   *   taken. Close to a tautology for a free rider, so the bench also prints, ungated, the share of
   *   the PC's hit turns that qualified (where the AI's setup shows)
   * - unmeasured: a per-turn or per-crit rate whose denominator the trace can't read yet; the row
   *   reads FAIL n/a with this reason even once the feature is modeled
   */
  readonly uRead: 'perFight' | 'byRound2' | 'uptimeAfterRound1' | 'perQualifyingTurn' | 'unmeasured';
  /** The ids U reads (automatic riders and the other cores are reported, never counted). */
  readonly uIds: readonly string[];
  /** Why `unmeasured`. */
  readonly uUnmeasured?: string;
  /** Below this class level the U feature isn't on the sheet: U is reported n/a (with the PDF line). */
  readonly uFrom?: { readonly level: number; readonly cite: string };
  /** Which dummy bench D reads. */
  readonly dBench: 'dummy-melee' | 'dummy-range';
  /**
   * W1 (w1-plan.md 4.1): a rider whose share of the PC's damage to the D dummy (rounds 2-5) the
   * bench prints, reported only: `rider` is the rider's local id in the feature `feature`.
   */
  readonly dShare?: { readonly label: string; readonly feature: string; readonly rider: string };
}

const CASTER_RULE = 'casts a leveled or damaging spell in >= 90% of fights';
const CASTER_SRC = 'coverage.md section 6, U: "casters cast a leveled or damaging spell in >= 90% of fights"';
const LEVELED_OR_DAMAGING = '*leveled-or-damaging';

export const CORE: Readonly<Record<PickClass, CoreEntry>> = {
  barbarian: {
    cls: 'barbarian',
    core: [{ label: 'Rage', features: ['srd:barbarian/rage'], spells: [], autoActs: [] }],
    uRule: 'Rage up >= 80% of rounds after round 1',
    uThreshold: 0.8,
    uSource: 'coverage.md section 6, U',
    uRead: 'uptimeAfterRound1',
    uIds: ['srd:barbarian/rage'],
    dBench: 'dummy-melee',
    // W1 (w1-plan.md 4.1): D can't show whether the Barbarian rages (Reckless Attack is free on the
    // damage-free dummy), so the bench prints this rider's share of the dummy damage, ungated.
    dShare: { label: 'Rage Damage', feature: 'srd:barbarian/rage', rider: 'rage-damage' },
  },
  bard: {
    cls: 'bard',
    core: [{ label: 'spells (Bardic Inspiration exempt until M8)', features: [], spells: ['*'], autoActs: [] }],
    uRule: CASTER_RULE,
    uThreshold: 0.9,
    uSource: CASTER_SRC,
    uRead: 'perFight',
    uIds: [LEVELED_OR_DAMAGING],
    dBench: 'dummy-range',
  },
  cleric: {
    cls: 'cleric',
    core: [
      { label: 'Channel Divinity (Divine Spark)', features: ['srd:cleric/channel-divinity-cleric'], spells: [], autoActs: [], notModeled: 'Divine Spark is narrative until W1b (moved out of W1, folded into W2 planning: w1-plan.md D4)' },
      { label: 'best damaging or healing spell', features: [], spells: ['srd:guiding-bolt', 'srd:sacred-flame', 'srd:healing-word'], autoActs: [] },
    ],
    uRule: CASTER_RULE,
    uThreshold: 0.9,
    uSource: CASTER_SRC,
    uRead: 'perFight',
    uIds: [LEVELED_OR_DAMAGING],
    dBench: 'dummy-range',
  },
  druid: {
    cls: 'druid',
    core: [{ label: 'best damaging or control spell (Wild Shape out of scope)', features: [], spells: ['srd:moonbeam', 'srd:produce-flame'], autoActs: [] }],
    uRule: CASTER_RULE,
    uThreshold: 0.9,
    uSource: CASTER_SRC,
    uRead: 'perFight',
    uIds: [LEVELED_OR_DAMAGING],
    dBench: 'dummy-range',
  },
  fighter: {
    cls: 'fighter',
    core: [
      { label: 'Action Surge', features: ['srd:fighter/action-surge'], spells: [], autoActs: [] },
      { label: 'Weapon Mastery', features: [], spells: [], autoActs: ['core:mastery-longsword', 'core:mastery-handaxe'] },
    ],
    uRule: 'uses Action Surge in >= 90% of fights',
    uThreshold: 0.9,
    uSource: '[U] proposed here: section 6 names no Fighter threshold; the casters\' 90%-of-fights form',
    uRead: 'perFight',
    uIds: ['srd:fighter/action-surge'],
    uFrom: { level: 2, cite: 'Action Surge at Fighter level 2, srd-raw.txt:10624-10627' },
    dBench: 'dummy-melee',
  },
  monk: {
    cls: 'monk',
    core: [
      { label: 'Martial Arts bonus attack', features: ['srd:monk/martial-arts'], spells: [], autoActs: [] },
      { label: 'Focus spend', features: ['srd:monk/monks-focus'], spells: [], autoActs: [] },
    ],
    uRule: 'uses Martial Arts or spends Focus in >= 90% of fights',
    uThreshold: 0.9,
    uSource: '[U] proposed here: section 6 names no Monk threshold; the casters\' 90%-of-fights form',
    uRead: 'perFight',
    uIds: ['srd:monk/martial-arts', 'srd:monk/monks-focus'],
    dBench: 'dummy-melee',
  },
  paladin: {
    cls: 'paladin',
    core: [{ label: 'Divine Smite', features: ['srd:paladin/paladins-smite'], spells: [], autoActs: [], notModeled: "Paladin's Smite / Divine Smite is narrative until W2 (S5)" }],
    uRule: 'Smite on the first melee hit while slots remain and on >= 50% of crits',
    uThreshold: 0.5,
    uSource: 'coverage.md section 6, U',
    uRead: 'unmeasured',
    uIds: ['srd:paladin/paladins-smite'],
    uUnmeasured: 'per crit and per first melee hit: the trace counts crits but not which hit a Smite rides on',
    dBench: 'dummy-melee',
  },
  ranger: {
    cls: 'ranger',
    core: [{ label: "Hunter's Mark", features: [], spells: ['srd:hunters-mark'], autoActs: [], notModeled: "Hunter's Mark is not emitted until W2 (S6)" }],
    uRule: "Hunter's Mark up by round 2 in >= 80% of fights",
    uThreshold: 0.8,
    uSource: 'coverage.md section 6, U',
    uRead: 'byRound2',
    uIds: ['srd:hunters-mark'],
    dBench: 'dummy-range',
  },
  rogue: {
    cls: 'rogue',
    core: [{ label: 'Sneak Attack', features: ['srd:rogue/sneak-attack'], spells: [], autoActs: [] }],
    uRule: 'Sneak Attack on >= 60% of turns with a qualifying hit',
    uThreshold: 0.6,
    uSource: 'coverage.md section 6, U',
    uRead: 'perQualifyingTurn',
    uIds: ['srd:rogue/sneak-attack'],
    dBench: 'dummy-melee',
  },
  sorcerer: {
    cls: 'sorcerer',
    core: [{ label: 'best damaging spell', features: [], spells: ['srd:fireball', 'srd:shatter', 'srd:fire-bolt'], autoActs: [] }],
    uRule: CASTER_RULE,
    uThreshold: 0.9,
    uSource: CASTER_SRC,
    uRead: 'perFight',
    uIds: [LEVELED_OR_DAMAGING],
    dBench: 'dummy-range',
  },
  warlock: {
    cls: 'warlock',
    core: [{ label: 'Eldritch Blast (with Agonizing Blast where picked)', features: [], spells: ['srd:eldritch-blast'], autoActs: [], notModeled: 'Eldritch Blast is not emitted until W3 (S7)' }],
    uRule: 'Eldritch Blast as the Action on >= 70% of turns with no better slot spell',
    uThreshold: 0.7,
    uSource: 'coverage.md section 6, U',
    uRead: 'unmeasured',
    uIds: ['srd:eldritch-blast'],
    uUnmeasured: 'per turn with no better slot spell: which turns had a better slot spell is not read',
    dBench: 'dummy-range',
  },
  wizard: {
    cls: 'wizard',
    core: [{ label: 'best damaging spell', features: [], spells: ['srd:fireball', 'srd:shatter', 'srd:fire-bolt'], autoActs: [] }],
    uRule: CASTER_RULE,
    uThreshold: 0.9,
    uSource: CASTER_SRC,
    uRead: 'perFight',
    uIds: [LEVELED_OR_DAMAGING],
    dBench: 'dummy-range',
  },
};

export const LEVELED_OR_DAMAGING_SPELLS = LEVELED_OR_DAMAGING;

// ---------------------------------------------------------------------------------------------
// Frozen thresholds (coverage.md section 6 as amended by M13 (c), (d), (f) and m9). Written here
// before any bench result was read; a miss is recorded with its reason, never tuned.

export const THRESHOLDS = {
  /** H: Dodge share of PC rounds, benches and solo smoke L1-5 (M13 f: solo L10 reported, not gated). */
  dodgeShareMax: 0.2,
  /** H: bench stalemates. */
  stalemateShareMax: 0.05,
  /** H: characters that never attack or cast. */
  neverActsMax: 0,
  /** H: item decisions per fight, on average. */
  itemDecisionsPerFightMax: 1,
  /** D: AI utilization (sim DPR rounds 2-5 over the exact value of the written loop), L3+. */
  aiUtilizationMin: 0.8,
  aiUtilizationFromLevel: 3,
  /** F: fixed paired n, minimum effect in points of foe HP removed, Holm across classes at this alpha. */
  fN: 2000,
  fMinEffectPoints: 5,
  fAlpha: 0.05,
  /** W: flag a class below half the class median party win%, L1-5 (reported only). */
  wFlagBelowHalfMedianToLevel: 5,
  /** Stalemate-by-cause: K rounds with no damage either way ([U] coverage.md G4: K reviewed once, then frozen). */
  noDamageRoundsK: 3,
  /** Stalemate-by-cause: a Dodge streak this long at the end. */
  dodgeStreak: 3,
} as const;

// ---------------------------------------------------------------------------------------------
// L1: the NON_SRD_NAMES scan over every generated character text, fail closed.

/** Throws when any generated text (or its in-memory path) trips the private-content check. */
export function assertNoPrivate(texts: readonly { readonly path: string; readonly text: string }[], what: string): void {
  const bad: string[] = [];
  for (const t of texts) for (const f of checkText(t.path, t.text)) bad.push(`${f.file}: ${f.why}`);
  if (bad.length > 0) throw new Error(`${what}: private-content scan failed closed (L1): ${bad.join('; ')}`);
}

/** The pick table itself as text, for the same scan. */
export function curatedText(): string {
  return JSON.stringify({ CURATED, CORE }, null, 1);
}

// ---------------------------------------------------------------------------------------------
// M14: the gate on combat-relevant unmodeled feature ids per fixed character (raw line counts are
// reported, not gated). Two closed lists: every feature a corpus character carries below `full`
// must be in exactly one (a test enforces it, so a new feature gets classified, not ignored).
// Feats count too (review R2: Savage Attacker, Archery, Alert change damage, attack or initiative).
// Combat-relevant: actions, bonus actions, reactions, riders, and passives that change attack,
// damage, AC, saves, HP, movement, initiative or the castable kit. [U] the split is a judgment
// call, reviewed once.

export const COMBAT_RELEVANT: readonly string[] = [
  'srd:barbarian/brutal-strike', 'srd:barbarian/fast-movement', 'srd:barbarian/feral-instinct', 'srd:barbarian/instinctive-pounce', 'srd:barbarian/rage', 'srd:barbarian/reckless-attack',
  'srd:bard/bardic-inspiration', 'srd:bard/countercharm', 'srd:bard/magical-secrets',
  'srd:champion/heroic-warrior', 'srd:champion/remarkable-athlete',
  'srd:circle-of-the-land/circle-of-the-land-spells', 'srd:circle-of-the-land/lands-aid', 'srd:circle-of-the-land/natures-ward',
  'srd:cleric/blessed-strikes-divine-strike', 'srd:cleric/blessed-strikes-potent-spellcasting', 'srd:cleric/channel-divinity-cleric', 'srd:cleric/divine-intervention', 'srd:cleric/sear-undead',
  'srd:college-of-lore/cutting-words', 'srd:college-of-lore/magical-discoveries',
  'srd:draconic-sorcery/draconic-resilience', 'srd:draconic-sorcery/draconic-spells', 'srd:draconic-sorcery/elemental-affinity',
  'srd:dragonborn/breath-weapon', 'srd:dragonborn/draconic-ancestry', 'srd:dragonborn/draconic-flight',
  'srd:druid/elemental-fury-potent-spellcasting', 'srd:druid/elemental-fury-primal-strike', 'srd:druid/wild-shape',
  'srd:dwarf/dwarven-resilience', 'srd:dwarf/dwarven-toughness',
  'srd:elf/elven-lineage-wood-elf', 'srd:elf/elven-lineage-drow', 'srd:elf/elven-lineage-high-elf', 'srd:elf/fey-ancestry',
  'srd:evoker/empowered-evocation', 'srd:evoker/potent-cantrip', 'srd:evoker/sculpt-spells',
  'srd:fiend-patron/dark-ones-blessing', 'srd:fiend-patron/dark-ones-own-luck', 'srd:fiend-patron/fiend-spells', 'srd:fiend-patron/fiendish-resilience',
  'srd:fighter/action-surge', 'srd:fighter/indomitable', 'srd:fighter/tactical-master', 'srd:fighter/tactical-shift',
  'srd:gnome/gnomish-cunning',
  'srd:goliath/giant-ancestry', 'srd:goliath/large-form', 'srd:goliath/stones-endurance',
  'srd:halfling/brave', 'srd:halfling/halfling-nimbleness', 'srd:halfling/luck',
  'srd:human/resourceful',
  'srd:hunter/defensive-tactics', 'srd:hunter/hunters-prey',
  'srd:life-domain/blessed-healer', 'srd:life-domain/disciple-of-life', 'srd:life-domain/life-domain-spells', 'srd:life-domain/preserve-life',
  'srd:monk/acrobatic-movement', 'srd:monk/deflect-attacks', 'srd:monk/evasion', 'srd:monk/heightened-focus', 'srd:monk/martial-arts', 'srd:monk/monks-focus', 'srd:monk/self-restoration', 'srd:monk/slow-fall',
  'srd:oath-of-devotion/aura-of-devotion', 'srd:oath-of-devotion/oath-of-devotion-spells', 'srd:oath-of-devotion/sacred-weapon',
  'srd:paladin/abjure-foes', 'srd:paladin/aura-of-courage', 'srd:paladin/aura-of-protection', 'srd:paladin/channel-divinity-paladin', 'srd:paladin/faithful-steed', 'srd:paladin/lay-on-hands', 'srd:paladin/paladins-smite',
  'srd:path-of-the-berserker/frenzy', 'srd:path-of-the-berserker/mindless-rage', 'srd:path-of-the-berserker/retaliation',
  'srd:ranger/favored-enemy', 'srd:ranger/roving', 'srd:ranger/tireless',
  'srd:rogue/cunning-action', 'srd:rogue/cunning-strike', 'srd:rogue/evasion', 'srd:rogue/sneak-attack', 'srd:rogue/steady-aim', 'srd:rogue/uncanny-dodge',
  'srd:sorcerer/empowered-spell', 'srd:sorcerer/font-of-magic', 'srd:sorcerer/heightened-spell', 'srd:sorcerer/innate-sorcery', 'srd:sorcerer/quickened-spell', 'srd:sorcerer/sorcery-incarnate', 'srd:sorcerer/twinned-spell',
  'srd:tiefling/fiendish-legacy-infernal', 'srd:tiefling/fiendish-legacy-abyssal', 'srd:tiefling/fiendish-legacy-chthonic',
  'srd:warlock/armor-of-shadows', 'srd:warlock/eldritch-mind', 'srd:warlock/fiendish-vigor',
  'srd:wizard/spellcasting',
  // Review R3: they add spells to the castable kit (Find Steed always prepared plus a free cast,
  // srd-raw.txt:11985-11990; two spells from other lists, 6834-6840; Magical Secrets, 5900).
  // Review R2, feats: Savage Attacker (damage, srd-raw.txt:20063-20069), Archery (+2 ranged
  // attack, 20110), Alert (initiative, 20028), Two-Weapon Fighting (damage, 20133), Magic Initiate
  // (two cantrips and a level 1 spell, 20038).
  'srd:alert', 'srd:archery', 'srd:magic-initiate', 'srd:savage-attacker', 'srd:two-weapon-fighting',
  // Coverage W1: Alert's own feature item (initiative, srd-raw.txt:20032-20033), partial for
  // Initiative Swap; the feat's id is classified above.
  'srd:alert/alert',
];

/** Features below `full` that don't change a fight (senses with LOS stubbed, skills, rests, lists, containers). */
export const NON_COMBAT: readonly string[] = [
  'srd:barbarian/primal-knowledge',
  'srd:bard/expertise', 'srd:bard/font-of-inspiration', 'srd:bard/jack-of-all-trades',
  'srd:circle-of-the-land/natural-recovery',
  'srd:cleric/blessed-strikes', 'srd:cleric/divine-order', 'srd:cleric/divine-order-protector',
  'srd:college-of-lore/bonus-proficiencies',
  'srd:dragonborn/darkvision', 'srd:druid/druidic', 'srd:druid/elemental-fury', 'srd:druid/primal-order', 'srd:druid/primal-order-magician', 'srd:druid/wild-companion', 'srd:druid/wild-resurgence',
  'srd:dwarf/darkvision', 'srd:dwarf/stonecunning',
  'srd:elf/darkvision', 'srd:elf/keen-senses', 'srd:elf/trance',
  'srd:evoker/evocation-savant',
  'srd:fighter/tactical-mind',
  'srd:gnome/darkvision', 'srd:gnome/gnomish-lineage-rock',
  'srd:goliath/powerful-build',
  'srd:halfling/naturally-stealthy',
  'srd:human/skillful', 'srd:human/versatile',
  'srd:hunter/hunters-lore',
  'srd:ranger/deft-explorer', 'srd:ranger/expertise',
  'srd:rogue/expertise', 'srd:rogue/reliable-talent', 'srd:rogue/thieves-cant',
  'srd:sorcerer/metamagic', 'srd:sorcerer/sorcerous-restoration',
  'srd:thief/fast-hands', 'srd:thief/second-story-work', 'srd:thief/supreme-sneak',
  'srd:tiefling/darkvision', 'srd:tiefling/otherworldly-presence',
  'srd:warlock/contact-patron', 'srd:warlock/devils-sight', 'srd:warlock/eldritch-invocations', 'srd:warlock/gift-of-the-depths', 'srd:warlock/magical-cunning', 'srd:warlock/mask-of-many-faces', 'srd:warlock/misty-visions', 'srd:warlock/one-with-shadows',
  'srd:wizard/arcane-recovery', 'srd:wizard/memorize-spell', 'srd:wizard/ritual-adept', 'srd:wizard/scholar',
  // Review R2, feats: Skilled (three skill or tool proficiencies).
  'srd:skilled',
];
