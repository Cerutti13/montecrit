// Roll keys: which d20 test a roll is, as one integer, so a modifier's "applies to" check in
// the simulator is an AND and a compare. Content writes patterns as dotted strings
// ('d20.save.con.concentration', 'd20.attack.ranged', 'd20.check.wis.perception'); they
// compile once at load to {mask, val}, and a key matches when (key & mask) === val.
//
// Bits: kind (attack 1, save 2, check 3) | ability+1 << 2 | melee, ranged, spell |
//       concentration | skill+1 << 9 | death save | weapon, unarmed | opportunity | initiative.
//
// Bits 15-18 (M3a) are appended above the M1b layout, never inserted: patterns are compiled
// into templates, so every existing pattern must keep its {mask, val} (critique C3).
//
// Does "a shorter pattern covers every longer key" survive the new segments? Yes. Matching
// isn't string-prefix matching: a pattern masks only the bits its own segments name, so
// 'd20.attack' still matches 'attack.melee.str.unarmed.opportunity', and segment order in a
// pattern never mattered. It holds because (1) each new segment owns bits no older pattern
// masks, (2) a key only ever gains bits on top of what it had, and (3) the ability field is
// shared by attacks, saves and checks, but every pattern that masks it also masks the kind.
// The one intended widening: initiative is a DEX check (SRD 5.2.1 p.13), so 'd20.check' and
// 'd20.check.dex' match it too, while a skill pattern doesn't (its skill field is empty).

import { ABILITIES, type Ability } from './types.ts';

export const RK = {
  attack: 1,
  save: 2,
  check: 3,
  KIND: 3,
  AB_SHIFT: 2,
  AB: 7 << 2,
  melee: 1 << 5,
  ranged: 1 << 6,
  spell: 1 << 7,
  conc: 1 << 8,
  SK_SHIFT: 9,
  SK: 31 << 9,
  death: 1 << 14,
  weapon: 1 << 15,
  unarmed: 1 << 16,
  opportunity: 1 << 17,
  initiative: 1 << 18,
} as const;

/** The 18 skills and the ability each uses (SRD 5.2.1 p.9). Append only: indices are in keys. */
export const SKILLS: readonly (readonly [string, Ability])[] = [
  ['acrobatics', 'dex'],
  ['animal-handling', 'wis'],
  ['arcana', 'int'],
  ['athletics', 'str'],
  ['deception', 'cha'],
  ['history', 'int'],
  ['insight', 'wis'],
  ['intimidation', 'cha'],
  ['investigation', 'int'],
  ['medicine', 'wis'],
  ['nature', 'int'],
  ['perception', 'wis'],
  ['performance', 'cha'],
  ['persuasion', 'cha'],
  ['religion', 'int'],
  ['sleight-of-hand', 'dex'],
  ['stealth', 'dex'],
  ['survival', 'wis'],
];

export function skillIndex(name: string): number {
  return SKILLS.findIndex(([n]) => n === name);
}

/** What else an attack roll's key can say: the ability it uses, a weapon or Unarmed Strike source, an opportunity attack. */
export interface AttackKeyMore {
  readonly ability?: number;
  readonly source?: 'weapon' | 'unarmed';
  readonly opportunity?: boolean;
}

export function attackKey(kind: 'melee' | 'ranged', spell: boolean, more?: AttackKeyMore): number {
  let key = RK.attack | (kind === 'melee' ? RK.melee : RK.ranged) | (spell ? RK.spell : 0);
  if (more) {
    if (more.ability !== undefined && more.ability >= 0) key |= (more.ability + 1) << RK.AB_SHIFT;
    if (more.source === 'weapon') key |= RK.weapon;
    else if (more.source === 'unarmed') key |= RK.unarmed;
    if (more.opportunity) key |= RK.opportunity;
  }
  return key;
}

/** A saving throw; `conc` marks a save to keep concentration. */
export function saveKey(ability: number, conc = false): number {
  return RK.save | ((ability + 1) << RK.AB_SHIFT) | (conc ? RK.conc : 0);
}

export const DEATH_SAVE_KEY = RK.save | RK.death;

/** An ability check, with a skill (index into SKILLS) or -1. */
export function checkKey(ability: number, skill = -1): number {
  return RK.check | ((ability + 1) << RK.AB_SHIFT) | (skill >= 0 ? (skill + 1) << RK.SK_SHIFT : 0);
}

/** The Initiative roll: a DEX check (SRD 5.2.1 p.13) with its own bit. */
export const INITIATIVE_KEY = checkKey(1) | RK.initiative;

export interface KeyPattern {
  readonly mask: number;
  readonly val: number;
}

export function keyMatches(key: number, p: KeyPattern): boolean {
  return (key & p.mask) === p.val;
}

/**
 * Compiles 'd20', 'd20.attack[.melee|.ranged][.<ability>][.weapon|.spell|.unarmed][.opportunity]'
 * (attack segments in any order), 'd20.save[.<ability>[.concentration]|.death]',
 * 'd20.check[.<ability>][.<skill>]' and 'd20.check[.dex].initiative'. Throws on anything else.
 */
export function compileKeyPattern(src: string): KeyPattern {
  const seg = src.split('.');
  const bad = (why: string) => new RangeError(`roll key "${src}": ${why}`);
  if (seg[0] !== 'd20') throw bad('must start with d20');
  let mask = 0;
  let val = 0;
  if (seg.length === 1) return { mask, val };
  const kind = seg[1]!;
  mask |= RK.KIND;
  if (kind === 'attack') {
    val |= RK.attack;
    for (const s of seg.slice(2)) {
      if (s === 'melee' || s === 'ranged') {
        if (mask & RK.melee) throw bad('melee and ranged are exclusive');
        mask |= RK.melee | RK.ranged;
        val |= s === 'melee' ? RK.melee : RK.ranged;
      } else if (s === 'spell' || s === 'weapon' || s === 'unarmed') {
        // Exclusive sources. 'spell' masks only its own bit, as it did before M3a.
        if (mask & (RK.spell | RK.weapon | RK.unarmed)) throw bad('weapon, spell and unarmed are exclusive');
        const bit = s === 'spell' ? RK.spell : s === 'weapon' ? RK.weapon : RK.unarmed;
        mask |= bit;
        val |= bit;
      } else if (s === 'opportunity') {
        if (mask & RK.opportunity) throw bad('opportunity twice');
        mask |= RK.opportunity;
        val |= RK.opportunity;
      } else if (ABILITIES.includes(s as Ability)) {
        if (mask & RK.AB) throw bad('one ability at most');
        mask |= RK.AB;
        val |= (ABILITIES.indexOf(s as Ability) + 1) << RK.AB_SHIFT;
      } else throw bad(`unknown attack segment "${s}"`);
    }
    return { mask, val };
  }
  if (kind === 'save') {
    val |= RK.save;
    const rest = seg.slice(2);
    if (rest[0] === 'death') {
      if (rest.length > 1) throw bad('nothing follows death');
      return { mask: mask | RK.death, val: val | RK.death };
    }
    if (rest.length > 0) {
      const ab = ABILITIES.indexOf(rest[0] as Ability);
      if (ab < 0) throw bad(`unknown ability "${rest[0]}"`);
      mask |= RK.AB;
      val |= (ab + 1) << RK.AB_SHIFT;
    }
    if (rest.length > 1) {
      if (rest[1] !== 'concentration' || rest[0] !== 'con' || rest.length > 2) throw bad('only d20.save.con.concentration follows an ability');
      mask |= RK.conc;
      val |= RK.conc;
    }
    return { mask, val };
  }
  if (kind === 'check') {
    val |= RK.check;
    const rest = seg.slice(2);
    let i = 0;
    let ab = -1;
    if (rest[i] !== undefined && ABILITIES.includes(rest[i] as Ability)) {
      ab = ABILITIES.indexOf(rest[i++] as Ability);
      mask |= RK.AB;
      val |= (ab + 1) << RK.AB_SHIFT;
    }
    if (rest[i] === 'initiative') {
      if (ab >= 0 && ab !== 1) throw bad('initiative is a dex check');
      mask |= RK.AB | RK.initiative;
      val = (val & ~RK.AB) | (2 << RK.AB_SHIFT) | RK.initiative;
      i++;
    } else if (rest[i] !== undefined) {
      const sk = skillIndex(rest[i]!);
      if (sk < 0) throw bad(`unknown ability or skill "${rest[i]}"`);
      const skAb = ABILITIES.indexOf(SKILLS[sk]![1]);
      if (ab >= 0 && ab !== skAb) throw bad(`${rest[i]} is a ${SKILLS[sk]![1]} skill`);
      mask |= RK.AB | RK.SK;
      val = (val & ~RK.AB) | ((skAb + 1) << RK.AB_SHIFT) | ((sk + 1) << RK.SK_SHIFT);
      i++;
    }
    if (i < rest.length) throw bad(`unexpected "${rest[i]}"`);
    return { mask, val };
  }
  throw bad(`unknown kind "${kind}"`);
}

/** 'attack.ranged.spell', 'attack.melee.str.unarmed.opportunity', 'save.con.concentration', 'save.death', 'check.wis.perception', 'check.dex.initiative': for logs. */
export function keyName(key: number): string {
  const kind = key & RK.KIND;
  const ab = ((key & RK.AB) >> RK.AB_SHIFT) - 1;
  const parts: string[] = [];
  if (kind === RK.attack) {
    parts.push('attack');
    if (key & RK.melee) parts.push('melee');
    if (key & RK.ranged) parts.push('ranged');
    if (ab >= 0) parts.push(ABILITIES[ab]!);
    if (key & RK.weapon) parts.push('weapon');
    if (key & RK.spell) parts.push('spell');
    if (key & RK.unarmed) parts.push('unarmed');
    if (key & RK.opportunity) parts.push('opportunity');
  } else if (kind === RK.save) {
    parts.push('save');
    if (key & RK.death) parts.push('death');
    if (ab >= 0) parts.push(ABILITIES[ab]!);
    if (key & RK.conc) parts.push('concentration');
  } else {
    parts.push('check');
    if (ab >= 0) parts.push(ABILITIES[ab]!);
    const sk = ((key & RK.SK) >> RK.SK_SHIFT) - 1;
    if (sk >= 0) parts.push(SKILLS[sk]![0]);
    if (key & RK.initiative) parts.push('initiative');
  }
  return parts.join('.');
}
