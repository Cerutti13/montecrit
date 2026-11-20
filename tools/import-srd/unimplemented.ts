// The closed set of `unimplemented` lines the importer may write (docs/design/m3.md 2.7, C5).
// Every line comes from one of these templates, filled only with machine tokens (a formula
// path, an activity type, an effect key, a status id) checked against a strict pattern, or
// with a phrase from the fixed TRIGGER_WORDS list. A line is never a substring of a
// record's description, so no rules text and no non-SRD name can leave through it.

/** Foundry activity types (module/data/activity/*.mjs at the pin; research-foundry §4.1). */
export const ACTIVITY_TYPES = ['attack', 'cast', 'check', 'damage', 'enchant', 'forward', 'heal', 'order', 'save', 'summon', 'teleport', 'transform', 'utility'] as const;

/**
 * Description phrases that mark a lifecycle the data doesn't carry (m3.md 2.7). Each maps to
 * a fixed gloss; the scan reports which phrases occur, never the text around them.
 */
export const TRIGGER_WORDS: Readonly<Record<string, string>> = {
  'each time': 'repeating trigger',
  'ends its turn': 'zone lifecycle',
  enters: 'zone lifecycle',
  'for every 5 feet': 'movement damage',
  'once per turn': 'once-per-turn limit',
  'repeat the save': 'repeat save',
};

const TOKEN = {
  /** @path tokens: letters, digits, dots, hyphens, underscores. */
  formulaPath: /^@[A-Za-z][A-Za-z0-9_.-]{0,80}$/,
  /** a bare function name */
  fn: /^[A-Za-z][A-Za-z0-9_]{0,30}$/,
  /** a Foundry actor-data key, e.g. system.attributes.ac.bonus, activities[attack].attack.bonus */
  effectKey: /^[A-Za-z][A-Za-z0-9_.[\]-]{0,120}$/,
  effectMode: /^(add|override|multiply|upgrade|downgrade|subtract|custom|[0-9])$/,
  id: /^[a-z][a-zA-Z0-9_-]{0,40}$/,
} as const;

function token(kind: keyof typeof TOKEN, v: string): string {
  if (!TOKEN[kind].test(v)) throw new Error(`unimplemented: "${v}" is not a ${kind} token; lines are templates, never free text`);
  // The premium-module names never travel in a line, even as a token (C5).
  if (/dnd-players-handbook|dnd-monster-manual|dnd-dungeon-masters-guide/i.test(v)) throw new Error(`unimplemented: a premium-module name can't appear in a line`);
  return v;
}

/** The templates. Each returns one line. */
export const U = {
  formulaPath: (path: string) => `formula path ${token('formulaPath', path)}`,
  formulaFunction: (fn: string) => `formula function ${token('fn', fn)}`,
  formulaSyntax: () => 'formula syntax not supported',
  activityType: (t: string) => {
    if (!(ACTIVITY_TYPES as readonly string[]).includes(t)) throw new Error(`unimplemented: unknown activity type ${t}`);
    return `activity type ${t}`;
  },
  activityUnknownType: () => 'activity of an unknown type',
  effectKey: (key: string, mode: string) => `effect key ${token('effectKey', key)} (${token('effectMode', mode)})`,
  effectKeyMalformed: () => 'effect key malformed',
  effectNoChanges: () => 'effect with no changes (rules in prose only)',
  effectStatus: (status: string) => `effect status ${token('id', status)}`,
  trigger: (word: string) => {
    const gloss = TRIGGER_WORDS[word];
    if (gloss === undefined) throw new Error(`unimplemented: "${word}" is not a trigger word`);
    return `trigger: "${word}" (${gloss})`;
  },
  quarantinedGrant: () => 'grants an item that was quarantined',
  premiumPointer: () => 'points at a premium module (dropped)',
  activation: (t: string) => `activation ${token('id', t)} not modeled`,
  durationReview: () => 'has a duration (needs a reviewed override to be full)',
  shapeReview: () => 'not a bucket-A shape (needs a reviewed override to be full)',
  /** C7: a bucket-A shape the importer read from the record alone (M3 step 6 spells). */
  bucketHeuristic: () => 'bucket-A by the importer\'s reading only (needs a reviewed override to be full)',
  activationReview: (t: 'reaction' | 'special') => `${t} activation (needs a reviewed override to be full)`,
  pdfHeaderDisagrees: () => 'PDF header disagrees (see review.json)',
  open5eDisagrees: () => 'Open5e disagrees (see review.json)',
  footprint: () => 'footprint not modeled',
  levelsAbove10: () => 'levels 11-20 not mapped',
  /** A class or subclass grants spells (always prepared, or a free spell); spells are imported at step 6. */
  spellGrants: () => 'grants spells (spells are imported at step 6)',
  /** A build-time choice the data kinds can't express yet (weapon masteries, tools, feature options...). */
  choiceNotMapped: (what: string) => `choice ${token('id', what)} not mapped`,
  /** A PDF species trait no trait record, choice or other line carries (Darkvision lives in Foundry's senses). */
  speciesTrait: (id: string) => `species trait ${token('id', id)} not mapped`,
  /**
   * A trait that changes the creature's Speed, which no feature field carries yet and the
   * character sheet would otherwise leave silently at the species' base (review R2: the Wood
   * Elf's 35 ft, SRD 5.2.1 p.84). Written by a hand override only.
   */
  speedChange: (feet: number) => {
    if (!Number.isInteger(feet) || feet < 0 || feet > 999) throw new Error(`unimplemented: speed ${feet} is not a whole number of feet`);
    return `speed change to ${feet} ft not applied (set overrides.speed)`;
  },
  /**
   * Advantage on saving throws "to avoid or end" a condition (Dwarven Resilience, Fey Ancestry,
   * SRD 5.2.1 p.84): a save roll key carries no condition bit yet (census: a condition bit on
   * save keys), so no mod can name those saves. Written by a hand override only.
   */
  conditionSaveAdvantage: (cond: string) => `advantage on saves against the ${token('id', cond)} condition not modeled`,
  /**
   * One named part of a feature's or spell's text that isn't modeled (M3 step 5a: Step of the
   * Wind's doubled jump, Deflect Attacks' redirect, by hand overrides; M3 step 6: the spell
   * mapper's fixed tokens, map/spell.ts). The id is always a fixed kebab token from code or a
   * reviewer, never description text.
   */
  part: (id: string) => `part ${token('id', id)} not modeled`,
  /**
   * A reviewed override that can't be written yet because the engine has no primitive for one
   * piece of it (M3 step 5a: an activation that heals only its user has no self-only target).
   * Written by a hand override only; the item stays at its importer fidelity.
   */
  engineGap: (id: string) => `needs engine support: ${token('id', id)}`,
  /**
   * M3 step 6 monsters (2.7: any trait, reaction, spellcasting, Recharge or Large+ footprint is a
   * line). The id is the kebab form of the stat block's own entry name, read from the PDF index
   * (a heading, never description text); usage is a token from pdf/monsters.ts usageToken.
   */
  monsterEntry: (section: 'trait' | 'action' | 'bonus action' | 'reaction', id: string, usage?: string) =>
    `monster ${section} ${token('id', id)} not modeled${usage === undefined ? '' : ` (${token('id', usage)})`}`,
  monsterLegendary: () => 'monster legendary actions not modeled',
  /** An attack that maps, but its Hit text goes on past the damage (a condition, a push, a versatile grip). */
  monsterAttackMore: (id: string) => `monster attack ${token('id', id)}: text after the damage not modeled`,
  /** An attack whose to-hit is neither STR nor DEX modifier + PB: the engine's stat-block lint reads only those, so it isn't emitted. */
  monsterAttackToHit: (id: string) => `monster attack ${token('id', id)}: to-hit from another ability (not emitted)`,
  /** A thrown attack whose weapon the Gear line doesn't count. */
  monsterThrown: (id: string) => `monster attack ${token('id', id)}: thrown uses not counted`,
  /** C0: "+5 (with Advantage if the target is Grappled ...)": the attack maps; its Advantage condition doesn't. */
  monsterAttackAdvantageIf: (id: string) => `monster attack ${token('id', id)}: conditional Advantage not modeled`,
  monsterMultiattack: () => 'monster multiattack not mapped',
  /** C0: "makes two A or B attacks" mapped as two alternatives (two of the same attack), never a mix. */
  monsterMultiattackSameAttack: () => 'monster multiattack: "A or B attacks" read as the same attack each time',
  /** C0: a speed printed for another form only, or whose kind is the GM's choice (pdf/monsters.ts parseSpeed). */
  monsterSpeedOther: (what: 'form' | 'choice') => (what === 'form' ? 'monster speed for another form not modeled' : "monster speed of the GM's choice not modeled"),
  monsterMultiattackMore: () => 'monster multiattack: text after its attacks not modeled',
  monsterSpeed: (kind: 'burrow' | 'climb' | 'fly' | 'swim' | 'hover') => `monster speed ${kind} not modeled`,
  /** "Medium or Small": the first size is modeled. */
  monsterSize: (a: string, b: string) => `monster size ${token('id', a)} or ${token('id', b)}: modeled ${token('id', a)}`,
  monsterConditionImmunity: (cond: string) => `monster condition immunity ${token('id', cond)} not modeled`,
  /** A Resistances, Vulnerabilities or Immunities field with words outside the type and condition lists. */
  monsterDefenseText: (field: 'resistances' | 'vulnerabilities' | 'immunities') => `monster ${field} text not mapped`,
  /** C9b: a magic item that requires attunement; attunement isn't modeled (the bonus applies). */
  attunement: () => 'attunement not modeled',
  /** A class-table column of a type the scale schema has no form for (Foundry's cr). */
  scaleType: (type: string) => `scale column type ${token('id', type)} not mapped`,
} as const;

const PATTERNS: readonly RegExp[] = [
  /^formula path @[A-Za-z][A-Za-z0-9_.-]{0,80}$/,
  /^formula function [A-Za-z][A-Za-z0-9_]{0,30}$/,
  /^formula syntax not supported$/,
  new RegExp(`^activity type (${ACTIVITY_TYPES.join('|')})$`),
  /^activity of an unknown type$/,
  /^effect key [A-Za-z][A-Za-z0-9_.[\]-]{0,120} \((add|override|multiply|upgrade|downgrade|subtract|custom|[0-9])\)$/,
  /^effect key malformed$/,
  /^effect with no changes \(rules in prose only\)$/,
  /^effect status [a-z][a-zA-Z0-9_-]{0,40}$/,
  new RegExp(`^trigger: "(${Object.keys(TRIGGER_WORDS).join('|')})" \\((${[...new Set(Object.values(TRIGGER_WORDS))].join('|')})\\)$`),
  /^grants an item that was quarantined$/,
  /^points at a premium module \(dropped\)$/,
  /^activation [a-z][a-zA-Z0-9_-]{0,40} not modeled$/,
  /^has a duration \(needs a reviewed override to be full\)$/,
  /^not a bucket-A shape \(needs a reviewed override to be full\)$/,
  /^bucket-A by the importer's reading only \(needs a reviewed override to be full\)$/,
  /^(reaction|special) activation \(needs a reviewed override to be full\)$/,
  /^PDF header disagrees \(see review\.json\)$/,
  /^Open5e disagrees \(see review\.json\)$/,
  /^footprint not modeled$/,
  /^levels 11-20 not mapped$/,
  /^grants spells \(spells are imported at step 6\)$/,
  /^choice [a-z][a-zA-Z0-9_-]{0,40} not mapped$/,
  /^scale column type [a-z][a-zA-Z0-9_-]{0,40} not mapped$/,
  /^species trait [a-z][a-zA-Z0-9_-]{0,40} not mapped$/,
  /^speed change to \d{1,3} ft not applied \(set overrides\.speed\)$/,
  /^advantage on saves against the [a-z][a-zA-Z0-9_-]{0,40} condition not modeled$/,
  /^part [a-z][a-zA-Z0-9_-]{0,40} not modeled$/,
  /^needs engine support: [a-z][a-zA-Z0-9_-]{0,40}$/,
  /^monster (trait|action|bonus action|reaction) [a-z][a-zA-Z0-9_-]{0,40} not modeled(?: \([a-z][a-zA-Z0-9_-]{0,40}\))?$/,
  /^monster legendary actions not modeled$/,
  /^monster attack [a-z][a-zA-Z0-9_-]{0,40}: (text after the damage not modeled|to-hit from another ability \(not emitted\)|thrown uses not counted|conditional Advantage not modeled)$/,
  /^monster multiattack not mapped$/,
  /^monster multiattack: "A or B attacks" read as the same attack each time$/,
  /^monster speed (for another form|of the GM's choice) not modeled$/,
  /^monster multiattack: text after its attacks not modeled$/,
  /^monster speed (burrow|climb|fly|swim|hover) not modeled$/,
  /^monster size [a-z][a-zA-Z0-9_-]{0,40} or [a-z][a-zA-Z0-9_-]{0,40}: modeled [a-z][a-zA-Z0-9_-]{0,40}$/,
  /^monster condition immunity [a-z][a-zA-Z0-9_-]{0,40} not modeled$/,
  /^monster (resistances|vulnerabilities|immunities) text not mapped$/,
  /^attunement not modeled$/,
];

/** True when `line` is one the templates can produce (verify.ts and the tests use it). */
export function isTemplateLine(line: string): boolean {
  return PATTERNS.some((p) => p.test(line)) && !/dnd-players-handbook|dnd-monster-manual|dnd-dungeon-masters-guide/i.test(line);
}

/** Which trigger words occur in a description (case-insensitive, HTML tags removed first). Sorted. */
export function triggerWordsIn(html: string): string[] {
  const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').toLowerCase();
  return Object.keys(TRIGGER_WORDS)
    .filter((w) => new RegExp(`\\b${w.replace(/ /g, '\\s+')}\\b`).test(text))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Sorted, de-duplicated lines (the form an item stores). */
export function normalizeLines(lines: readonly string[]): string[] {
  for (const l of lines) if (!isTemplateLine(l)) throw new Error(`unimplemented line "${l}" matches no template`);
  return [...new Set(lines)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
