// Each spell's stat lines and the numbers in its description, read from the PDF (M3 step 6,
// docs/design/m3.md C7): the classifier needs the header fields (casting time, range,
// components, duration, concentration) from the PDF itself, and the spell mapper checks the
// dice, damage types, save abilities, attack kind, areas and conditions it maps against the
// PDF's own text.
//
// What goes into srd-index.json is machine tokens only: units, numbers, dice ("8d6"), damage
// type, ability and condition ids, shape names. No sentence of rules text is copied.
//
// Layout (bbox lines in reading order): the h4 name, the italic "Level N School (...)" line,
// then the stat lines "Casting Time: ...", "Range: ...", "Components: ...", "Duration: ...",
// which can wrap and whose box height varies by page, then the description until the next
// spell's name. The PDF prints "Component:" for a single component on a few spells.

import { type Line, STYLE, isStyle } from './lines.ts';

export interface SpellStat {
  /** action, bonus, reaction, or a timed cast in minutes or hours. */
  readonly castingTime: { readonly unit: 'action' | 'bonus' | 'reaction' | 'minute' | 'hour'; readonly n: number };
  readonly ritual: boolean;
  /** self, touch, sight, unlimited, special, or a distance in feet or miles. */
  readonly range: { readonly unit: 'self' | 'touch' | 'sight' | 'unlimited' | 'special' | 'feet' | 'miles'; readonly n?: number };
  readonly components: {
    readonly v: boolean;
    readonly s: boolean;
    readonly m: boolean;
    /** The material names a price ("worth 50+ GP"): a focus can't stand in for it. */
    readonly cost: boolean;
    /** The spell consumes the material. */
    readonly consumed: boolean;
  };
  /** instant, a timed duration, until dispelled, or special. */
  readonly duration: { readonly unit: 'instant' | 'round' | 'minute' | 'hour' | 'day' | 'dispelled' | 'special'; readonly n?: number; readonly upTo?: boolean };
  readonly concentration: boolean;
}

export const DAMAGE_WORDS = ['Acid', 'Bludgeoning', 'Cold', 'Fire', 'Force', 'Lightning', 'Necrotic', 'Piercing', 'Poison', 'Psychic', 'Radiant', 'Slashing', 'Thunder'] as const;
const ABILITY_WORDS: Readonly<Record<string, string>> = { Strength: 'str', Dexterity: 'dex', Constitution: 'con', Intelligence: 'int', Wisdom: 'wis', Charisma: 'cha' };
const CONDITION_WORDS = ['Blinded', 'Charmed', 'Deafened', 'Frightened', 'Grappled', 'Incapacitated', 'Invisible', 'Paralyzed', 'Petrified', 'Poisoned', 'Prone', 'Restrained', 'Stunned', 'Unconscious'] as const;

export interface SpellFacts {
  /** "melee" / "ranged" when the text makes a spell attack. */
  readonly attack: readonly ('melee' | 'ranged')[];
  /** Abilities of the saving throws the text names, in order of first mention. */
  readonly saves: readonly string[];
  /** Every "<dice> <Type> damage" in the text (dice as printed, e.g. "8d6", "2d8 + 4"; type lower case), in order. */
  readonly damage: readonly { readonly dice: string; readonly type: string }[];
  /** Dice of "regains Hit Points equal to <dice>" (heals), in order. */
  readonly heal: readonly string[];
  /** The Cantrip Upgrade line's dice at levels 5, 11 and 17, in order (empty for a leveled spell). */
  readonly cantripUpgrade: readonly string[];
  /** Dice of every "increases by <dice> for each spell slot level above" (Using a Higher-Level Spell Slot). */
  readonly upcast: readonly string[];
  /** Areas the text names: shape (sphere, cube, cone, line, cylinder, emanation), size in feet, height for a cylinder. */
  readonly areas: readonly { readonly shape: string; readonly ft: number; readonly height?: number }[];
  /** Conditions the text names ("the Paralyzed condition"), lower case, in order of first mention. */
  readonly conditions: readonly string[];
  /** The text has a turn-end repeat of the save by the target ("At the end of each of its turns, the target repeats the save"). */
  readonly repeatSaveTurnEnd: boolean;
  /** The text has a "Cantrip Upgrade." paragraph (with or without dice: Eldritch Blast adds beams). */
  readonly cantripUpgradeLine: boolean;
  /** The text has a "Using a Higher-Level Spell Slot." paragraph. */
  readonly higherLevelLine: boolean;
  /** The text makes several attacks or hits with counted projectiles ("three rays", "two beams", "three glowing darts"). */
  readonly multiAttack: boolean;
  /** The target is "a creature of your choice" (p.106: the caster may choose itself). */
  readonly ofYourChoice: boolean;
  /** The target is "a willing creature". */
  readonly willing: boolean;
  /** A successful save halves the damage ("half as much damage", Vitriolic Sphere's "half the initial damage"). */
  readonly half: boolean;
}

export interface SpellDetail {
  readonly name: string;
  readonly page: number;
  readonly stat: SpellStat;
  readonly facts: SpellFacts;
}

const LABELS = ['Casting Time', 'Range', 'Components', 'Duration'] as const;
const LABEL_RE = /(Casting Time|Range|Components?|Duration):\s*/g;

/** Splits the joined stat lines into the four labeled values. */
export function splitStat(text: string): Record<(typeof LABELS)[number], string> {
  const out: Record<string, string> = {};
  const marks = [...text.matchAll(LABEL_RE)];
  marks.forEach((m, i) => {
    const label = m[1] === 'Component' ? 'Components' : m[1]!;
    const end = i + 1 < marks.length ? marks[i + 1]!.index : text.length;
    if (label in out) throw new Error(`stat line "${label}" appears twice in "${text}"`);
    out[label] = text.slice(m.index + m[0].length, end).trim();
  });
  for (const l of LABELS) if (!(l in out)) throw new Error(`stat line "${l}" missing in "${text}"`);
  return out as Record<(typeof LABELS)[number], string>;
}

const NUM = (s: string): number => Number(s.replace(/,/g, ''));

export function parseCastingTime(v: string): { castingTime: SpellStat['castingTime']; ritual: boolean } {
  const ritual = /\bor Ritual$/.test(v);
  const t = v.replace(/\s*or Ritual$/, '');
  if (/^Action\b/.test(t)) return { castingTime: { unit: 'action', n: 1 }, ritual };
  if (/^Bonus Action\b/.test(t)) return { castingTime: { unit: 'bonus', n: 1 }, ritual };
  if (/^Reaction\b/.test(t)) return { castingTime: { unit: 'reaction', n: 1 }, ritual };
  const m = /^(\d+) (minute|minutes|hour|hours)$/.exec(t);
  if (m) return { castingTime: { unit: m[2]!.startsWith('minute') ? 'minute' : 'hour', n: NUM(m[1]!) }, ritual };
  throw new Error(`casting time "${v}" not understood`);
}

export function parseRange(v: string): SpellStat['range'] {
  if (/^Self\b/.test(v)) return { unit: 'self' };
  if (v === 'Touch') return { unit: 'touch' };
  if (v === 'Sight') return { unit: 'sight' };
  if (v === 'Unlimited') return { unit: 'unlimited' };
  if (v === 'Special') return { unit: 'special' };
  const m = /^([\d,]+) (feet|foot|mile|miles)$/.exec(v);
  if (m) return { unit: m[2]!.startsWith('f') ? 'feet' : 'miles', n: NUM(m[1]!) };
  throw new Error(`range "${v}" not understood`);
}

export function parseComponents(v: string): SpellStat['components'] {
  const head = v.replace(/\s*\(.*$/, '');
  const parts = head.split(',').map((s) => s.trim());
  for (const p of parts) if (p !== 'V' && p !== 'S' && p !== 'M') throw new Error(`components "${v}" not understood`);
  const paren = /\((.*)\)\s*$/.exec(v)?.[1] ?? '';
  return {
    v: parts.includes('V'),
    s: parts.includes('S'),
    m: parts.includes('M'),
    cost: /\bworth\b|\bGP\b/.test(paren),
    consumed: /\bconsumes?\b/.test(paren),
  };
}

export function parseDuration(v: string): { duration: SpellStat['duration']; concentration: boolean } {
  const concentration = /^Concentration,? /.test(v); // p.157 prints "Concentration up to 10 minutes" without the comma
  const t = v.replace(/^Concentration,? /, '');
  if (t === 'Instantaneous') return { duration: { unit: 'instant' }, concentration };
  if (t === 'Until dispelled' || t === 'Until dispelled or triggered') return { duration: { unit: 'dispelled' }, concentration };
  if (t === 'Special') return { duration: { unit: 'special' }, concentration };
  const m = /^(up to |Up to )?(\d+) (round|rounds|minute|minutes|hour|hours|day|days)$/.exec(t);
  if (m) {
    const unit = m[3]!.replace(/s$/, '') as 'round' | 'minute' | 'hour' | 'day';
    return { duration: m[1] ? { unit, n: NUM(m[2]!), upTo: true } : { unit, n: NUM(m[2]!) }, concentration };
  }
  throw new Error(`duration "${v}" not understood`);
}

export function parseStat(text: string): SpellStat {
  const s = splitStat(text);
  const ct = parseCastingTime(s['Casting Time']);
  const d = parseDuration(s.Duration);
  return { castingTime: ct.castingTime, ritual: ct.ritual, range: parseRange(s.Range), components: parseComponents(s.Components), duration: d.duration, concentration: d.concentration };
}

/** Joins description lines, undoing end-of-line hyphenation ("re-" + "gain"). */
export function joinBody(texts: readonly string[]): string {
  let out = '';
  for (const t of texts) {
    if (out.endsWith('-') && /^[a-z]/.test(t)) out = out.slice(0, -1) + t;
    else out = out === '' ? t : `${out} ${t}`;
  }
  return out.replace(/[’]/g, "'").replace(/\s+/g, ' ');
}

const firsts = <T>(xs: readonly T[]): T[] => xs.filter((x, i) => xs.indexOf(x) === i);

export function parseFacts(body: string): SpellFacts {
  const DMG = new RegExp(`(\\d+d\\d+(?: ?\\+ ?\\d+)?) (${DAMAGE_WORDS.join('|')}) damage`, 'g');
  const damage = [...body.matchAll(DMG)].map((m) => ({ dice: m[1]!.replace(/ ?\+ ?/, ' + '), type: m[2]!.toLowerCase() }));
  const saves = firsts([...body.matchAll(/\b(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma) saving throw/g)].map((m) => ABILITY_WORDS[m[1]!]!));
  const attack = firsts([...body.matchAll(/\b(melee|ranged) spell attack/gi)].map((m) => m[1]!.toLowerCase() as 'melee' | 'ranged'));
  const heal = [...body.matchAll(/regains? (?:a number of )?Hit Points equal to (\d+d\d+)/g)].map((m) => m[1]!);
  const cu = /Cantrip Upgrade\.(.*)$/.exec(body)?.[1] ?? '';
  const cantripUpgrade = cu ? [...cu.matchAll(/levels? (?:5|11|17) \((\d+d\d+)\)|(?:11|17) \((\d+d\d+)\)/g)].map((m) => (m[1] ?? m[2])!) : [];
  const upcast = [...body.matchAll(/increases by (\d+d\d+) for each spell slot level above/g)].map((m) => m[1]!);
  const areas: { shape: string; ft: number; height?: number }[] = [];
  // Phrasings in SRD 5.2.1 (every one seen): "20-foot-radius Sphere"; "10-foot-radius,
  // 40-foot-high Cylinder" (also "-tall", "40foot high", "40-foothigh"); "30-foot-tall,
  // 10-foot-radius Cylinder"; "15-foot Cube" ("15-foot-Cube" once); "15-foot Cone"; "10-foot
  // Emanation"; lines by length and width in either order (recorded by length); "20-foot
  // square" (a ground area: Entangle, Grease).
  const A = /(\d+)-foot-radius Sphere|(\d+)-foot-radius, (\d+)-?foot[- ]?(?:high|tall) Cylinder|(\d+)-foot-tall, (\d+)-foot-radius Cylinder|(\d+)-foot[- ](Cube|Cone|Emanation)\b|(\d+)-foot-long, \d+-foot-wide Line|\d+-foot-wide, (\d+)-foot-long Line|(\d+)-foot-wide Line|(\d+)-foot[- ]square (?:on ground|within range|area)/g;
  for (const m of body.matchAll(A)) {
    if (m[1]) areas.push({ shape: 'sphere', ft: NUM(m[1]) });
    else if (m[2]) areas.push({ shape: 'cylinder', ft: NUM(m[2]), height: NUM(m[3]!) });
    else if (m[4]) areas.push({ shape: 'cylinder', ft: NUM(m[5]!), height: NUM(m[4]) });
    else if (m[6]) areas.push({ shape: m[7]!.toLowerCase(), ft: NUM(m[6]) });
    else if (m[8] ?? m[9]) areas.push({ shape: 'line', ft: NUM((m[8] ?? m[9])!) });
    else if (m[11]) areas.push({ shape: 'square', ft: NUM(m[11]) });
    else if (m[10]) areas.push({ shape: 'line', ft: 0 }); // "N-foot-wide Line": the length is printed elsewhere (0 = not read)
  }
  const conditions = firsts([...body.matchAll(new RegExp(`\\b(${CONDITION_WORDS.join('|')}) condition`, 'g'))].map((m) => m[1]!.toLowerCase()));
  const repeatSaveTurnEnd = /At the end of each of its turns, the target repeats the save/.test(body);
  const NUMS = 'two|three|four|five|six|seven|eight|nine|ten';
  const multiAttack = new RegExp(`\\b(?:${NUMS}) (?:[a-z]+ )?(?:rays|beams|darts|bolts|motes|globes|missiles)\\b`, 'i').test(body);
  return {
    attack,
    saves,
    damage,
    heal,
    cantripUpgrade,
    upcast,
    areas,
    conditions,
    repeatSaveTurnEnd,
    cantripUpgradeLine: /Cantrip Upgrade\./.test(body),
    higherLevelLine: /Using a Higher-Level Spell Slot\./.test(body),
    multiAttack,
    ofYourChoice: /\bcreature of your choice\b/.test(body),
    willing: /\bwilling creature\b/.test(body),
    half: /\bhalf (?:as much|the initial) damage\b/.test(body),
  };
}

export interface HeaderAt {
  readonly name: string;
  readonly page: number;
  /** Index of the italic header line's last line (the stat lines start after it). */
  readonly end: number;
  /** Index of the name's first line. */
  readonly start: number;
}

const isStatLine = (t: string): boolean => /^(Casting Time|Range|Components?|Duration):/.test(t);

/**
 * Stat and facts for each header, in the order given. `heads` must be in reading order; a
 * spell's description runs to the next one's name (the last to the next h1-h3 heading).
 */
export function parseSpellDetails(lines: readonly Line[], heads: readonly HeaderAt[]): SpellDetail[] {
  return heads.map((h, n) => {
    let i = h.end + 1;
    if (!isStatLine(lines[i]?.text ?? '')) throw new Error(`spell "${h.name}" (p.${h.page}): no stat lines after its header`);
    const stat: string[] = [];
    let seenDuration = false;
    let durH = -1;
    for (; i < lines.length; i++) {
      const t = lines[i]!.text;
      if (isStatLine(t)) {
        stat.push(t);
        if (/Duration:/.test(t)) {
          seenDuration = true;
          durH = lines[i]!.h;
        }
        continue;
      }
      // A wrapped stat value: same box height as the stat lines, before the description starts.
      if (!seenDuration && stat.length) {
        stat.push(t);
        continue;
      }
      if (seenDuration && lines[i]!.h === durH && !/[.!?]$/.test(stat[stat.length - 1]!) && /^[a-z(]/.test(t)) {
        stat.push(t);
        continue;
      }
      break;
    }
    const next = heads[n + 1];
    const body: string[] = [];
    for (; i < lines.length && (next === undefined || i < next.start); i++) {
      const l = lines[i]!;
      if (next === undefined && (isStyle(l, STYLE.h1) || isStyle(l, STYLE.h2) || isStyle(l, STYLE.h3))) break;
      body.push(l.text);
    }
    let parsed: SpellStat;
    try {
      parsed = parseStat(stat.join(' ').replace(/\s+/g, ' '));
    } catch (e) {
      throw new Error(`spell "${h.name}" (p.${h.page}): ${(e as Error).message}`);
    }
    return { name: h.name, page: h.page, stat: parsed, facts: parseFacts(joinBody(body)) };
  });
}
