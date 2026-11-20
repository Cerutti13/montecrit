// Monster stat blocks read from the PDF (M3 step 6, docs/design/m3.md 4.3, C4, C7): the gate's
// stat-block headers, and the printed numbers the monster mapper emits and checks Foundry
// against ("the PDF decides").
//
// What goes into srd-index.json is machine tokens only: numbers, dice ("2d6 + 5"), damage-type,
// ability, skill, sense and condition ids, and the names of the stat block's own entries (a
// trait or action name is a heading, like a spell or feature name). No sentence of rules text
// is copied: an entry keeps only what its first clause parses to, plus whether more text
// follows it (`more`), which the mapper turns into a closed-template line.
//
// Layout (bbox lines in reading order, SRD 5.2.1 pp.166-364): the stat block's name at 17.9 pt
// (MONSTER_STYLE.name), right under it the "Size Type, Alignment" line; then 10.7 pt field lines
// (AC with Initiative beside it, HP, Speed, then after the 11.6 pt ability rows Skills, Gear,
// Resistances, Vulnerabilities, Immunities, Senses, Languages, CR), each field's wrapped lines
// indented; then sections under 13.9 pt titles (Traits, Actions, Bonus Actions, Reactions,
// Legendary Actions) whose entries start on an 11.4 pt line "Name. ..." and wrap at 11.3 pt.
// A block ends at the next block or group title, or at the first line of any other style (the
// spell or magic item text around the few blocks printed outside "Monsters").

import { type Line } from './lines.ts';
import { joinBody } from './spell-details.ts';

/** Box heights (pt, rounded) of the stat-block styles. Measured on SRD 5.2.1. */
export const MONSTER_STYLE = {
  group: 21.5, // "Goblins", "Gold Dragons" (also h2 elsewhere)
  name: 17.9,
  field: 10.7,
  abilityHead: 6.9, // "MOD SAVE"
  ability: 11.6,
  section: 13.9,
  entry: 11.4,
  entryWrap: 11.3,
} as const;

const near = (h: number, want: number): boolean => Math.abs(h - want) < 0.05;
const BLOCK_STYLES: readonly number[] = [MONSTER_STYLE.field, MONSTER_STYLE.abilityHead, MONSTER_STYLE.ability, MONSTER_STYLE.section, MONSTER_STYLE.entry, MONSTER_STYLE.entryWrap];

export const SIZE_WORDS = ['Tiny', 'Small', 'Medium', 'Large', 'Huge', 'Gargantuan'] as const;
const SIZE_LINE = new RegExp(`^(${SIZE_WORDS.join('|')})(?: or (${SIZE_WORDS.join('|')}|Smaller))? (.+), (.+)$`);

const ABILITY_WORDS: Readonly<Record<string, string>> = { Strength: 'str', Dexterity: 'dex', Constitution: 'con', Intelligence: 'int', Wisdom: 'wis', Charisma: 'cha' };
const DAMAGE_WORDS = ['Acid', 'Bludgeoning', 'Cold', 'Fire', 'Force', 'Lightning', 'Necrotic', 'Piercing', 'Poison', 'Psychic', 'Radiant', 'Slashing', 'Thunder'] as const;
const CONDITION_WORDS = ['Blinded', 'Charmed', 'Deafened', 'Exhaustion', 'Frightened', 'Grappled', 'Incapacitated', 'Invisible', 'Paralyzed', 'Petrified', 'Poisoned', 'Prone', 'Restrained', 'Stunned', 'Unconscious'] as const;
const SKILL_WORDS: Readonly<Record<string, string>> = {
  Acrobatics: 'acrobatics',
  'Animal Handling': 'animal-handling',
  Arcana: 'arcana',
  Athletics: 'athletics',
  Deception: 'deception',
  History: 'history',
  Insight: 'insight',
  Intimidation: 'intimidation',
  Investigation: 'investigation',
  Medicine: 'medicine',
  Nature: 'nature',
  Perception: 'perception',
  Performance: 'performance',
  Persuasion: 'persuasion',
  Religion: 'religion',
  'Sleight of Hand': 'sleight-of-hand',
  Stealth: 'stealth',
  Survival: 'survival',
};
const SENSE_WORDS = ['Blindsight', 'Darkvision', 'Tremorsense', 'Truesight'] as const;
const NUMBER_WORDS: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };

export type SectionId = 'traits' | 'actions' | 'bonusActions' | 'reactions' | 'legendaryActions';
const SECTIONS: Readonly<Record<string, SectionId>> = { Traits: 'traits', Actions: 'actions', 'Bonus Actions': 'bonusActions', Reactions: 'reactions', 'Legendary Actions': 'legendaryActions' };

export interface DamagePart {
  /** The printed average (a flat "1 Piercing damage" has no dice). */
  readonly avg: number;
  /** Dice as printed ("2d6 + 5"), or the flat number. */
  readonly dice: string;
  readonly type: string;
  /** "... if the attack roll had Advantage" (the goblins' riders). */
  readonly ifAdvantage: boolean;
}

export interface AttackTokens {
  readonly kind: 'melee' | 'ranged' | 'meleeOrRanged';
  readonly toHit: number;
  readonly reach?: number;
  /**
   * [normal, long]; a single printed range ("range 120 ft.") is [n, n]: no long range, and no
   * attack beyond it (srd-raw.txt:2044-2049), the form the engine gives spell attacks.
   */
  readonly range?: readonly [number, number];
  /** "+5 (with Advantage if ...)": a condition on Advantage printed after the to-hit (C0). */
  readonly advantageIf?: true;
  readonly damage: readonly DamagePart[];
}

export interface MultiattackGroup {
  readonly count: number;
  readonly from: readonly string[];
}

export interface MultiattackTokens {
  /** Groups as the engine's Multiattack form takes them: count and the entry names it draws from. */
  readonly groups: readonly MultiattackGroup[];
  /** C0: further alternatives ("..., or it makes two Hurl Flame attacks"; "two A or B attacks"). */
  readonly orGroups?: readonly (readonly MultiattackGroup[])[];
  /** C0: "makes two A or B attacks", read as two of the same attack (alternatives), never mixed. */
  readonly sameAttack?: true;
}

export interface SaveArea {
  readonly shape: 'cone' | 'line' | 'sphere';
  /** Feet: a Cone's length, a Line's length, a Sphere's radius. */
  readonly size: number;
  /** A Line's width. */
  readonly width?: number;
  /** A Sphere's range ("centered on a point ... within n feet"). */
  readonly rangeFt?: number;
  readonly damage: readonly DamagePart[];
}

export interface MonsterEntry {
  readonly name: string;
  /**
   * A use limit in the name: "recharge-5-6", "recharge-6", "per-day-2", "per-day-3-each", "rest",
   * "form-<forms>" (C0: "Wolf or Hybrid Form Only" is form-wolf-hybrid), or "other".
   */
  readonly usage?: string;
  /** An attack whose "Attack Roll: ... Hit: ..." clause parsed. */
  readonly attack?: AttackTokens;
  /** A saving-throw action: "<Ability> Saving Throw: DC n". */
  readonly save?: { readonly ability: string; readonly dc: number };
  /** Coverage step 7.6: a save action whose whole text is an area and half damage (parseSaveArea). */
  readonly saveArea?: SaveArea;
  /** Multiattack whose first sentence parsed to groups. */
  readonly multiattack?: MultiattackTokens;
  /** "The <creature> takes the Disengage or Hide action." style: the core actions named. */
  readonly takes?: readonly string[];
  /** More text follows the part that parsed (a rider, a second sentence), or nothing parsed. */
  readonly more: boolean;
  /** C0 (X1): the entry prints an attack roll that didn't parse to `attack` (the inert-monster check). */
  readonly attackRoll?: true;
}

export interface MonsterDetail {
  readonly name: string;
  readonly page: number;
  /** Lower-case sizes as printed ("Medium or Small" -> ['medium', 'small']). */
  readonly sizes: readonly string[];
  readonly ac: number;
  readonly initiative: { readonly mod: number; readonly score: number };
  readonly hp: { readonly average: number; readonly formula: string };
  /**
   * walk always (0 when the line names no plain Speed); hover when "(hover)" is printed.
   * C0: formOnly when a speed is printed for another form only ("40 ft. (wolf form only)", the
   * lycanthropes); choice when a speed's kind is the GM's ("Climb or Fly 20 ft. (GM's choice)").
   * Neither is read as a speed.
   */
  readonly speed: { readonly walk: number; readonly burrow?: number; readonly climb?: number; readonly fly?: number; readonly swim?: number; readonly hover?: true; readonly formOnly?: true; readonly choice?: true };
  readonly abilities: Readonly<Record<'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha', { readonly score: number; readonly mod: number; readonly save: number }>>;
  readonly skills: Readonly<Record<string, number>>;
  readonly senses: { readonly blindsight?: number; readonly darkvision?: number; readonly tremorsense?: number; readonly truesight?: number; readonly passivePerception: number; readonly other?: true };
  /** Damage types, lower case; `unparsed` set when a field had words outside the type list. */
  readonly resist: readonly string[];
  readonly vuln: readonly string[];
  readonly immune: readonly string[];
  /** Condition ids, lower case. */
  readonly conditionImmune: readonly string[];
  /** Which defense fields had text the type lists don't cover ("Bludgeoning from nonmagical attacks"). */
  readonly unparsed: readonly string[];
  readonly gear: readonly { readonly name: string; readonly count?: number }[];
  /** "0", "1/8", "1/4", "1/2", "1".."30". */
  readonly cr: string;
  readonly xp: number;
  readonly pb: number;
  readonly traits: readonly MonsterEntry[];
  readonly actions: readonly MonsterEntry[];
  readonly bonusActions: readonly MonsterEntry[];
  readonly reactions: readonly MonsterEntry[];
  readonly legendaryActions: readonly MonsterEntry[];
}

const num = (s: string): number => Number(s.replace(/[−–]/g, '-').replace(/,/g, ''));
const minus = (s: string): string => s.replace(/[−–]/g, '-');

/** Is line i a stat-block name (17.9 pt, with the size line right under it)? */
export function isBlockStart(lines: readonly Line[], i: number): boolean {
  const l = lines[i];
  const nx = lines[i + 1];
  return l !== undefined && nx !== undefined && near(l.h, MONSTER_STYLE.name) && SIZE_LINE.test(nx.text);
}

/** "Recharge 5–6" and friends in an entry name, as a token. */
export function usageToken(paren: string): string {
  const p = minus(paren).trim();
  let m = /^Recharge (\d)(?:-(\d))?$/.exec(p);
  if (m) return m[2] ? `recharge-${m[1]}-${m[2]}` : `recharge-${m[1]}`;
  m = /^(\d)\/Day( Each)?$/.exec(p);
  if (m) return `per-day-${m[1]}${m[2] ? '-each' : ''}`;
  if (/Short or Long Rest|Long Rest/.test(p)) return 'rest';
  // C0: "Humanoid or Hybrid Form Only" -> form-humanoid-hybrid (the forms, lower case, in order).
  m = /^([A-Z][a-z]+(?:(?:, | or |, or )[A-Z][a-z]+)*) Form Only$/.exec(p);
  if (m) return `form-${m[1]!.split(/, or | or |, /).map((f) => f.toLowerCase()).join('-')}`;
  return 'other';
}

const DMG_TYPE = `(${DAMAGE_WORDS.join('|')})`;
const DICE = '(\\d+d\\d+(?: [+-] \\d+)?)';
/** "5 (1d6 + 2) Slashing damage" or "1 Piercing damage". */
const PART = new RegExp(`^(\\d+)(?: \\(${DICE}\\))? ${DMG_TYPE} damage`);

/**
 * Parses the text after "Hit: ": every damage part, then whether anything follows the sentence.
 * C0: "X damage—or Y damage if ...—plus Z damage" (Mimic, Swarm of Venomous Snakes) is X plus Z,
 * with the conditional alternative Y left as more text; before C0 the parts after the dashes
 * were dropped (the snakes' bites lost their 10 (3d6) Poison damage).
 */
export function parseHit(rest: string): { damage: DamagePart[]; more: boolean } | undefined {
  let s = rest;
  const damage: DamagePart[] = [];
  const first = PART.exec(s);
  if (!first) return undefined;
  damage.push({ avg: Number(first[1]), dice: first[2] ?? first[1]!, type: first[3]!.toLowerCase(), ifAdvantage: false });
  s = s.slice(first[0].length);
  let alternative = false;
  const dash = /^—or [^—]+—(?=plus )/.exec(s);
  if (dash) {
    alternative = true;
    s = ` ${s.slice(dash[0].length)}`;
  }
  for (;;) {
    const m = /^,? plus /.exec(s);
    if (!m) break;
    const p = PART.exec(s.slice(m[0].length));
    if (!p) return undefined;
    s = s.slice(m[0].length + p[0].length);
    const adv = / if the attack roll had Advantage/.exec(s);
    const ifAdvantage = adv !== null && adv.index === 0;
    if (ifAdvantage) s = s.slice(adv![0].length);
    damage.push({ avg: Number(p[1]), dice: p[2] ?? p[1]!, type: p[3]!.toLowerCase(), ifAdvantage });
  }
  if (!s.startsWith('.')) return { damage, more: true };
  return { damage, more: alternative || s.slice(1).trim() !== '' };
}

/**
 * "<kind> Attack Roll: +n, reach r ft. Hit: ..." and its printed variants (C0, X1):
 *   "+17 to hit" (Ancient Gold Dragon), "reach 5 feet." (Djinni, Eagle, Giant Rat), "reach 5 ft
 *   or range" (the Werebear’s Handaxe, srd-raw.txt:55739, the period missing), a single
 *   range "range 120 ft." (srd-raw.txt:2044-2049), and "+5 (with Advantage if ...)" after the
 *   to-hit (Ankheg, the bugbears, the sharks), whose condition is a line.
 */
const FT = '(?:ft\\.|feet\\.)';
const ATTACK = new RegExp(
  `^(Melee or Ranged|Melee|Ranged) Attack Roll: ([+-]\\d+)(?: to hit)?( \\(with Advantage [^()]*\\))?, (?:reach (\\d+) (?:${FT}|ft(?= or range))(?: or range (\\d+)(?:\\/(\\d+))? ${FT})?|range (\\d+)(?:\\/(\\d+))? ${FT}) Hit: (.*)$`,
);

/**
 * Coverage step 7.6: "each creature in a <shape>. Failure: avg (dice) Type damage. Success: Half
 * damage." and nothing else. Any other clause (a condition on a failure, "that can see", "and each
 * object", a text after Half damage) isn't this form: undefined, and the entry stays a line.
 * The line-break artifacts "5-foot- wide" and "5-footwide" are the PDF's.
 */
export function parseSaveArea(body: string): SaveArea | undefined {
  const m = /^[A-Z][a-z]+ Saving Throw: DC \d+, each creature in an? (.+?)\. Failure: (.+) Success: Half damage\.$/.exec(body);
  if (!m) return undefined;
  const hit = parseHit(m[2]!);
  if (!hit || hit.more || hit.damage.some((d) => d.ifAdvantage)) return undefined;
  const s = m[1]!;
  let a = /^(\d+)-foot Cone$/.exec(s);
  if (a) return { shape: 'cone', size: Number(a[1]), damage: hit.damage };
  a = /^(\d+)-foot-long, (\d+)-foot-? ?wide Line$/.exec(s);
  if (a) return { shape: 'line', size: Number(a[1]), width: Number(a[2]), damage: hit.damage };
  a = /^(\d+)-foot-radius Sphere centered on a point(?: the [a-z ]+ can see)? within (\d+) feet$/.exec(s);
  if (a) return { shape: 'sphere', size: Number(a[1]), rangeFt: Number(a[2]), damage: hit.damage };
  return undefined;
}

/** One entry's tokens from its joined text ("Name. rest"). */
export function parseEntry(text: string, siblings?: readonly string[]): MonsterEntry {
  const t = minus(text);
  const m = /^([A-Z][^.:]*?)\. (.*)$/.exec(t) ?? /^([A-Z][^.:]*?)\.$/.exec(t);
  if (!m) throw new Error(`entry "${text.slice(0, 40)}" has no name`);
  let name = m[1]!;
  const body = m[2] ?? '';
  let usage: string | undefined;
  const u = /^(.*?) \(([^()]*)\)$/.exec(name);
  if (u) {
    name = u[1]!;
    usage = usageToken(u[2]!);
  }
  const base = { name, ...(usage ? { usage } : {}) };
  const a = ATTACK.exec(body);
  if (a) {
    const kind = a[1] === 'Melee' ? 'melee' : a[1] === 'Ranged' ? 'ranged' : 'meleeOrRanged';
    const hit = parseHit(a[9]!);
    const reach = a[4] ? Number(a[4]) : undefined;
    const pair = (n: string, long: string | undefined): [number, number] => [Number(n), Number(long ?? n)];
    const range: [number, number] | undefined = a[5] ? pair(a[5], a[6]) : a[7] ? pair(a[7], a[8]) : undefined;
    const shapeOk = (kind === 'melee' && reach !== undefined && !range) || (kind === 'ranged' && range && reach === undefined) || (kind === 'meleeOrRanged' && reach !== undefined && range);
    if (hit && shapeOk) {
      const attack: AttackTokens = { kind, toHit: Number(a[2]), ...(reach !== undefined ? { reach } : {}), ...(range ? { range } : {}), ...(a[3] ? { advantageIf: true as const } : {}), damage: hit.damage };
      return { ...base, attack, more: hit.more };
    }
    return { ...base, more: true, attackRoll: true };
  }
  const rolls = /\bAttack Roll: /.test(body) ? { attackRoll: true as const } : {};
  const sv = /^(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma) Saving Throw: DC (\d+),/.exec(body);
  if (sv) {
    const saveArea = parseSaveArea(body);
    return { ...base, save: { ability: ABILITY_WORDS[sv[1]!]!, dc: Number(sv[2]) }, ...(saveArea ? { saveArea } : {}), more: saveArea === undefined, ...rolls };
  }
  if (name === 'Multiattack') {
    const ma = parseMultiattack(body, siblings ?? []);
    return ma ? { ...base, multiattack: ma.tokens, more: ma.more } : { ...base, more: true };
  }
  const tk = /^The [a-z][a-z ,'-]*? takes the (Dash|Disengage|Hide)(?:(?:, | or |, or )(Dash|Disengage|Hide))?(?:(?:, | or |, or )(Dash|Disengage|Hide))? action\.$/.exec(body);
  if (tk) return { ...base, takes: [tk[1]!, tk[2], tk[3]].filter((x): x is string => x !== undefined).map((x) => x.toLowerCase()), more: false };
  return { ...base, more: true, ...rolls };
}

/**
 * The Multiattack sentence forms the mapper maps, exactly:
 *   "makes <n> <A> attacks."                                 [{n, [A]}]
 *   "makes <n> attacks, using <A> or <B> in any combination." [{n, [A, B]}] (also "A, B, or C",
 *        and "A and B", the Bandit Captain and the Scout, C0)
 *   "makes <n> <A> attack(s) and <m> <B> attack(s)."          [{n, [A]}, {m, [B]}] (C0: any number
 *        of comma-listed groups, "one Bite attack, two Devilish Claw attacks, and one ...")
 *   C0: "makes <n> <A> or <B> attacks"                         alternatives [{n, [A]}] or [{n, [B]}]
 *        (sameAttack: read as n of the same attack, as the hand-written Warrior Veteran does,
 *        since blocks that allow mixing say "in any combination")
 *   C0: "<form>, or it makes <form>"                           one alternative per form
 *   C0: "<form> and uses <X>" / ", and it can use <X>"         the attacks, with more: true
 * Every name must be one of the block's own entries. Anything else is not parsed.
 */
export function parseMultiattack(body: string, entries: readonly string[]): { tokens: MultiattackTokens; more: boolean } | undefined {
  const m = /^The [^.]*? makes (one|two|three|four|five|six|seven|eight) ([^.]*?)\.(.*)$/.exec(body);
  if (!m) return undefined;
  let more = m[3]!.trim() !== '';
  let what = `${m[1]!} ${m[2]!}`;
  const uses = /,? and (?:it )?(?:can )?uses? \S.*$/.exec(what);
  if (uses) {
    what = what.slice(0, uses.index);
    more = true;
  }
  const known = (x: string): string | undefined => entries.find((e) => e === x);
  const NUM = '(one|two|three|four|five|six|seven|eight)';
  let sameAttack = false;
  const alternatives: MultiattackGroup[][] = [];
  for (const form of what.split(', or it makes ')) {
    let g = new RegExp(`^${NUM} attacks, using (.+) in any combination$`).exec(form);
    if (g) {
      const names = g[2]!.split(/, or |, and |, | or | and /).map((x) => x.trim());
      const from = names.map(known);
      if (names.length < 2 || from.some((x) => x === undefined) || new Set(from).size !== from.length) return undefined;
      alternatives.push([{ count: NUMBER_WORDS[g[1]!]!, from: from as string[] }]);
      continue;
    }
    g = new RegExp(`^${NUM} (.+?) or (.+?) attacks?$`).exec(form);
    if (g && known(g[2]!) && known(g[3]!) && g[2] !== g[3]) {
      const count = NUMBER_WORDS[g[1]!]!;
      if (count > 1) sameAttack = true;
      alternatives.push([{ count, from: [g[2]!] }], [{ count, from: [g[3]!] }]);
      continue;
    }
    const groups: MultiattackGroup[] = [];
    for (const item of form.split(/, and |, | and /)) {
      const it = new RegExp(`^${NUM} (.+?) attacks?$`).exec(item);
      const name = it ? known(it[2]!) : undefined;
      if (!it || !name || groups.some((x) => x.from[0] === name)) return undefined;
      groups.push({ count: NUMBER_WORDS[it[1]!]!, from: [name] });
    }
    alternatives.push(groups);
  }
  const [groups, ...orGroups] = alternatives;
  if (!groups) return undefined;
  return { tokens: { groups, ...(orGroups.length ? { orGroups } : {}), ...(sameAttack ? { sameAttack: true as const } : {}) }, more };
}

const FIELD_LABEL = /^(Skills|Gear|Resistances|Vulnerabilities|Immunities|Senses|Languages|CR) /;
const isAbilityText = (t: string): boolean => /^(Str|Dex|Con|Int|Wis|Cha) ?\d/.test(t) || /^[−+-]\d+ [−+-]\d+$/.test(t);

/** A Title Case entry name ("Fire Breath", "Legendary Resistance (3/Day, or 4/Day in Lair)") with its period and the next sentence. */
const ENTRY_NAME = /^[A-Z][A-Za-z'’-]*(?: (?:[A-Z][A-Za-z'’-]*|of|the|and|or|in|to|a|an|on|with|from))*(?: \([^()]*\))?\. [A-Z]/;

const ENTRY_NAME_ALONE = /^[A-Z][A-Za-z'’-]*(?: (?:[A-Z][A-Za-z'’-]*|of|the|and|or|in|to|a|an|on|with|from))*(?: \([^()]*\))?\.$/;
const ENTRY_OPENS = /^(?:(?:Melee or Ranged|Melee|Ranged) Attack Roll:|(?:Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma) Saving Throw:)/;

const LABELS = ['Skills', 'Gear', 'Resistances', 'Vulnerabilities', 'Immunities', 'Senses', 'Languages', 'CR'] as const;
type Label = (typeof LABELS)[number];

function splitDefense(v: string, unparsed: string[], field: string): { types: string[]; conds: string[] } {
  const types: string[] = [];
  const conds: string[] = [];
  const parts = v.split(';').map((p) => p.trim());
  for (const part of parts) {
    for (const w of part.split(/, | and |, and /).map((x) => x.trim()).filter(Boolean)) {
      if ((DAMAGE_WORDS as readonly string[]).includes(w)) types.push(w.toLowerCase());
      else if ((CONDITION_WORDS as readonly string[]).includes(w)) conds.push(w.toLowerCase());
      else if (!unparsed.includes(field)) unparsed.push(field);
    }
  }
  return { types, conds };
}

/** The 10.7 pt fields of a block, wrapped lines joined. */
function fieldsOf(lines: readonly Line[]): Partial<Record<Label | 'AC' | 'Initiative' | 'HP' | 'Speed', string>> {
  const out: Partial<Record<string, string>> = {};
  let cur: string | undefined;
  const texts = lines.flatMap((l) => {
    const m = /^(AC \S+) (Initiative .*)$/.exec(l.text);
    return m ? [m[1]!, m[2]!] : [l.text];
  });
  for (const t of texts) {
    const lab = /^(AC|Initiative|HP|Speed|Skills|Gear|Resistances|Vulnerabilities|Immunities|Senses|Languages|CR) (.*)$/.exec(t);
    if (lab && out[lab[1]!] === undefined) {
      cur = lab[1]!;
      out[cur] = lab[2]!;
    } else if (cur) out[cur] = `${out[cur]} ${t}`;
  }
  return out;
}

/** Parses one block (its lines from the name to the end). Throws on a field it can't read. */
export function parseBlock(block: readonly Line[]): MonsterDetail {
  const name = block[0]!.text;
  const where = `stat block "${name}" (p.${block[0]!.page})`;
  const sz = SIZE_LINE.exec(block[1]!.text);
  if (!sz) throw new Error(`${where}: no size line`);
  const sizes = [sz[1]!, sz[2]].filter((x): x is string => x !== undefined).map((x) => x.toLowerCase());
  let i = 2;
  const head: Line[] = [];
  const abil: Line[] = [];
  const tail: Line[] = [];
  for (; i < block.length && !near(block[i]!.h, MONSTER_STYLE.section); i++) {
    const l = block[i]!;
    if (near(l.h, MONSTER_STYLE.abilityHead)) continue;
    if (tail.length || FIELD_LABEL.test(l.text) || (abil.length === 0 && !isAbilityText(l.text))) {
      if (abil.length) tail.push(l);
      else head.push(l);
    } else abil.push(l);
  }
  const f = fieldsOf([...head, ...tail]);
  const need = (k: string): string => {
    const v = (f as Record<string, string | undefined>)[k];
    if (v === undefined) throw new Error(`${where}: no ${k}`);
    return minus(v).replace(/\s+/g, ' ').trim();
  };
  const ac = /^(\d+)$/.exec(need('AC'));
  if (!ac) throw new Error(`${where}: AC "${need('AC')}"`);
  const ini = /^([+-]\d+) \((\d+)\)$/.exec(need('Initiative'));
  if (!ini) throw new Error(`${where}: Initiative "${need('Initiative')}"`);
  const hp = /^(\d+) \((\d+d\d+(?: [+-] \d+)?)\)$/.exec(need('HP'));
  if (!hp) throw new Error(`${where}: HP "${need('HP')}"`);
  const speed = parseSpeed(need('Speed'), where);

  // The six ability cells sit in a 3 x 2 grid whose pieces pdftotext sometimes splits or merges
  // ("Str 5" with its "-3 -3" as a separate box, "Con22"): read them as one token stream in
  // row order (y bands of 6 pt), left to right.
  const stream = [...abil]
    .sort((a, b) => Math.round(a.y / 6) - Math.round(b.y / 6) || a.x - b.x)
    .map((l) => minus(l.text))
    .join(' ');
  const abilities = {} as Record<string, { score: number; mod: number; save: number }>;
  const cells = [...stream.matchAll(/(Str|Dex|Con|Int|Wis|Cha) ?(\d+) ([+-]?\d+) ([+-]?\d+)/g)];
  const rest = stream.replace(/(Str|Dex|Con|Int|Wis|Cha) ?(\d+) ([+-]?\d+) ([+-]?\d+)/g, '').trim();
  if (cells.length !== 6 || rest !== '') throw new Error(`${where}: ability cells "${stream}"`);
  for (const m of cells) {
    const k = m[1]!.toLowerCase();
    if (abilities[k]) throw new Error(`${where}: ${k} twice`);
    abilities[k] = { score: Number(m[2]), mod: Number(m[3]), save: Number(m[4]) };
  }
  for (const k of ['str', 'dex', 'con', 'int', 'wis', 'cha']) if (!abilities[k]) throw new Error(`${where}: no ${k} row`);

  const skills: Record<string, number> = {};
  if (f.Skills !== undefined) {
    for (const s of need('Skills').split(', ')) {
      const m = /^(.+) ([+-]\d+)$/.exec(s);
      const id = m ? SKILL_WORDS[m[1]!] : undefined;
      if (!m || !id) throw new Error(`${where}: skill "${s}"`);
      skills[id] = Number(m[2]);
    }
  }
  const senses = parseSenses(need('Senses'), where);
  const unparsed: string[] = [];
  const res = f.Resistances !== undefined ? splitDefense(need('Resistances'), unparsed, 'resistances') : { types: [], conds: [] };
  const vul = f.Vulnerabilities !== undefined ? splitDefense(need('Vulnerabilities'), unparsed, 'vulnerabilities') : { types: [], conds: [] };
  const imm = f.Immunities !== undefined ? splitDefense(need('Immunities'), unparsed, 'immunities') : { types: [], conds: [] };
  if (res.conds.length && !unparsed.includes('resistances')) unparsed.push('resistances');
  if (vul.conds.length && !unparsed.includes('vulnerabilities')) unparsed.push('vulnerabilities');
  const gear: { name: string; count?: number }[] = [];
  if (f.Gear !== undefined) {
    for (const g of need('Gear').split(', ')) {
      const m = /^(.+?)(?: \((\d+)\))?$/.exec(g)!;
      gear.push(m[2] ? { name: m[1]!, count: Number(m[2]) } : { name: m[1]! });
    }
  }
  const cr = /^(0|1\/8|1\/4|1\/2|\d+) \((?:XP )?([\d,]+)(?: XP)?(?:,? [^;]*)?; PB \+(\d)\)$/.exec(need('CR'));
  if (!cr) throw new Error(`${where}: CR "${need('CR')}"`);

  // Sections and their entries.
  const sections: Record<SectionId, string[][]> = { traits: [], actions: [], bonusActions: [], reactions: [], legendaryActions: [] };
  let sec: SectionId | undefined;
  for (; i < block.length; i++) {
    const l = block[i]!;
    if (near(l.h, MONSTER_STYLE.section)) {
      sec = SECTIONS[l.text];
      if (!sec) throw new Error(`${where}: unknown section "${l.text}"`);
      continue;
    }
    if (!sec) continue;
    const cur = sections[sec];
    const prev = cur.length ? cur[cur.length - 1]![cur[cur.length - 1]!.length - 1]! : undefined;
    // An entry starts on an 11.4 pt line (the bold run-in raises the box), or on an 11.3 pt one
    // when the run-in is short (pdftotext gives "Baleful Command (Recharge 5–6). Wisdom ..." the
    // wrap height): then only a Title Case name with its period, after a line that ended a sentence.
    // C0: or a name alone on its line ("Hand Crossbow (Humanoid or Hybrid Form Only).", the
    // Wererat, srd-raw.txt:55849-55851) whose next line opens an attack roll or a save; before
    // C0 it was read as the end of Scratch, which lost the Hand Crossbow.
    const next = block[i + 1] ? minus(block[i + 1]!.text) : '';
    const startsEntry =
      (near(l.h, MONSTER_STYLE.entry) && /^[A-Z][^.:]*?\.(?: |$)/.test(minus(l.text))) ||
      (near(l.h, MONSTER_STYLE.entryWrap) &&
        (prev === undefined || /[.)]$/.test(prev)) &&
        (ENTRY_NAME.test(minus(l.text)) || (ENTRY_NAME_ALONE.test(minus(l.text)) && ENTRY_OPENS.test(next))));
    if (startsEntry) cur.push([l.text]);
    else if (near(l.h, MONSTER_STYLE.field) && sec === 'legendaryActions') continue; // "Legendary Action Uses: ..." preamble
    else if (sections[sec].length) sections[sec][sections[sec].length - 1]!.push(l.text);
  }
  const names = (s: SectionId) => sections[s].map((e) => /^([A-Z][^.:]*?)\./.exec(minus(joinBody(e)))![1]!.replace(/ \([^()]*\)$/, ''));
  const entries = (s: SectionId) => {
    const own = names(s);
    return sections[s].map((e) => parseEntry(joinBody(e), own));
  };
  return {
    name,
    page: block[0]!.page,
    sizes,
    ac: Number(ac[1]),
    initiative: { mod: Number(ini[1]), score: Number(ini[2]) },
    hp: { average: Number(hp[1]), formula: hp[2]! },
    speed,
    abilities: abilities as MonsterDetail['abilities'],
    skills,
    senses,
    resist: res.types,
    vuln: vul.types,
    immune: imm.types,
    conditionImmune: imm.conds,
    unparsed,
    gear,
    cr: cr[1]!,
    xp: num(cr[2]!),
    pb: Number(cr[3]),
    traits: entries('traits'),
    actions: entries('actions'),
    bonusActions: entries('bonusActions'),
    reactions: entries('reactions'),
    legendaryActions: entries('legendaryActions'),
  };
}

function parseSpeed(v: string, where: string): MonsterDetail['speed'] {
  const out: { walk: number; burrow?: number; climb?: number; fly?: number; swim?: number; hover?: true; formOnly?: true; choice?: true } = { walk: 0 };
  const parts = v.split(', ');
  parts.forEach((p, k) => {
    // C0: a speed for another form only ("40 ft. (wolf form only)", "Climb 30 ft. (bear form
    // only)": the lycanthropes, srd-raw.txt:55669-55670, 55756, 55866, 55921) or of the GM's
    // kind ("Climb or Fly 20 ft. (GM's choice)": Swarm of Insects, 59742) isn't the printed
    // form's speed; it's recorded as a flag, not read as a number.
    if (k > 0 && /^(?:(?:Burrow|Climb|Fly|Swim) )?\d+ ft\. \([a-z]+ form only\)$/.test(p)) {
      out.formOnly = true;
      return;
    }
    if (k > 0 && /^(?:Burrow|Climb|Fly|Swim) or (?:Burrow|Climb|Fly|Swim) \d+ ft\. \(GM[’']s choice\)$/.test(p)) {
      out.choice = true;
      return;
    }
    const m = /^(?:(Burrow|Climb|Fly|Swim) )?(\d+) ft\.( \(hover\))?$/.exec(p);
    if (!m) throw new Error(`${where}: speed "${v}"`);
    if (m[1] === undefined) {
      if (k !== 0) throw new Error(`${where}: speed "${v}"`);
      out.walk = Number(m[2]);
    } else out[m[1].toLowerCase() as 'burrow' | 'climb' | 'fly' | 'swim'] = Number(m[2]);
    if (m[3]) out.hover = true;
  });
  return out;
}

function parseSenses(v: string, where: string): MonsterDetail['senses'] {
  const out: { blindsight?: number; darkvision?: number; tremorsense?: number; truesight?: number; passivePerception?: number; other?: true } = {};
  for (const part of v.split(/; |, /)) {
    const m = new RegExp(`^(${SENSE_WORDS.join('|')}) (\\d+) ft\\.(.*)$`).exec(part);
    if (m) {
      out[m[1]!.toLowerCase() as 'darkvision'] = Number(m[2]);
      if (m[3]!.trim() !== '') out.other = true;
      continue;
    }
    const pp = /^Passive Perception (\d+)$/.exec(part);
    if (pp) out.passivePerception = Number(pp[1]);
    else out.other = true;
  }
  if (out.passivePerception === undefined) throw new Error(`${where}: senses "${v}" has no Passive Perception`);
  return out as MonsterDetail['senses'];
}

export interface MonsterHeader {
  readonly name: string;
  readonly page: number;
}

/**
 * Every stat block in the PDF, in reading order: its header (the C4 gate), and its details when
 * the whole block parses. A block that doesn't (a spell's summon block with HP by size and no CR)
 * keeps its header and is listed in `failed` with the reason, so the mapper skips it.
 */
export function parseMonsters(lines: readonly Line[]): { heads: MonsterHeader[]; details: MonsterDetail[]; failed: { name: string; page: number; why: string }[] } {
  const heads: MonsterHeader[] = [];
  const details: MonsterDetail[] = [];
  const failed: { name: string; page: number; why: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isBlockStart(lines, i)) continue;
    const block: Line[] = [lines[i]!];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j]!;
      if (j > i + 1 && (isBlockStart(lines, j) || near(l.h, MONSTER_STYLE.group) || (!BLOCK_STYLES.some((h) => near(l.h, h)) && !isAbilityText(l.text)))) break;
      block.push(l);
    }
    heads.push({ name: lines[i]!.text, page: lines[i]!.page });
    try {
      details.push(parseBlock(block));
    } catch (e) {
      failed.push({ name: lines[i]!.text, page: lines[i]!.page, why: (e as Error).message });
    }
    i = j - 1;
  }
  return { heads, details, failed };
}
