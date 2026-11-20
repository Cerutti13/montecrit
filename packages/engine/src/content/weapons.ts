// M3 step 5b: the core weapon rules a PC's weapons bring with them, as features compiled by the
// ordinary feature compiler (riders, effects, gates, weaponAttack), so they need no machinery of
// their own. Load-time code: built per PC from its weapons, never stored in a pack.
//
// Rules, SRD 5.2.1 p.89-90 (line numbers in the PDF text, srd-raw.txt):
//   Light (20339-20349): "When you take the Attack action on your turn and attack with a Light
//     weapon, you can make one extra attack as a Bonus Action later on the same turn. That extra
//     attack must be made with a different Light weapon, and you don't add your ability modifier
//     to the extra attack's damage unless that modifier is negative."
//   Mastery Properties (20406-20410): "usable only by a character who has a feature, such as
//     Weapon Mastery, that unlocks the property". Weapon Mastery (Fighter, 10614-10619): "the
//     mastery properties of three kinds of Simple or Martial weapons of your choice" — the PC's
//     `masteries` lists the chosen kinds; a weapon uses its mastery when its `base` is listed.
//   Cleave (20360-20367), Graze (20424-20430), Nick (20432-20435), Push (20437-20440),
//   Sap (20442-20446), Slow (20448-20453), Topple (20455-20461), Vex (20463-20467): cited at
//   each rider below.
//
// Readings marked [U] (the text doesn't settle them; docs/design/m3.md build note 5b):
//   - Nick is read as a property of the weapon that makes the extra attack (the Nick weapon is
//     the off-hand one), and its extra attack may come any time later in the turn after the
//     Attack action's Light strike, like the Bonus Action one ("as part of the Attack action").
//   - Graze, Slow, Sap and Vex need no choice: Sap and Vex aren't "you can" at all; Graze and Slow
//     are, but using them never costs anything, so they're taken whenever they apply.
//   - A finesse weapon's mastery uses the higher of STR and DEX (the one its attack uses here).

import { FeatureSchema, type FeatureSource, type Mastery, type PcSource } from './schema.ts';

type PcWeaponSrc = PcSource['weapons'][number];

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** The id of a weapon's mastery feature: one per mastered weapon, so each has its own DC ability. */
export const masteryFeatureId = (w: { readonly id: string }): string => `core:mastery-${w.id}`;
export const LIGHT_FEATURE_ID = 'core:light-weapons';

/** Whether `w`'s mastery property is usable: it has one, and its kind is among the PC's chosen masteries. */
export function masteryActive(src: PcSource, w: PcWeaponSrc): Mastery | null {
  if (w.mastery === undefined || w.base === undefined || !src.masteries || !src.masteries.includes(w.base)) return null;
  return w.mastery;
}

/**
 * How many Light weapons `ws` holds for the Light property's extra attack (srd-raw.txt:20339-20345,
 * "a different Light weapon"): one per entry, and a counted Thrown stack of two or more (four
 * Daggers) counts as two, since its second piece is a different weapon it can draw as part of a
 * thrown attack (20387-20389; review R1). Enough for the extra attack at 2.
 */
export function lightWeaponCount(ws: readonly { readonly light?: true; readonly thrownRange?: unknown; readonly count?: number }[]): number {
  let n = 0;
  for (const w of ws) if (w.light === true) n += w.thrownRange !== undefined && (w.count ?? 0) >= 2 ? 2 : 1;
  return n;
}

/** The ability a weapon's attack uses: STR or DEX (finesse: the higher; STR on a tie, the same number). */
export function weaponAbility(w: PcWeaponSrc, mods: readonly number[]): 'str' | 'dex' {
  if (w.ability === 'finesse') return mods[1]! > mods[0]! ? 'dex' : 'str';
  return w.ability;
}

/**
 * The feature for one mastered weapon (Nick is the Light feature's), or null when the property
 * does nothing for this PC: Nick, and Graze at an ability modifier of 0 or less.
 */
export function masteryFeature(w: PcWeaponSrc, m: Mastery, ability: 'str' | 'dex', mod: number): FeatureSource | null {
  const id = `${m}-${w.id}`;
  const name = `${cap(m)} (${w.name})`;
  const on = { weapon: w.id };
  let rider: Record<string, unknown>;
  let effects: unknown[] = [];
  switch (m) {
    case 'nick':
      return null;
    case 'cleave':
      // "If you hit a creature with a melee attack roll using this weapon, you can make a melee
      // attack roll with the weapon against a second creature within 5 feet of the first that is
      // also within your reach. On a hit, the second creature takes the weapon's damage, but don't
      // add your ability modifier to that damage unless that modifier is negative. You can make
      // this extra attack only once per turn." (20360-20367)
      rider = { on: 'hit', filter: { ...on, range: 'melee' }, oncePerTurn: 'global', do: [{ weaponAttack: { with: w.id, noAbilityToDamage: true, near: true } }] };
      break;
    case 'graze':
      // "If your attack roll with this weapon misses a creature, you can deal damage to that
      // creature equal to the ability modifier you used to make the attack roll. This damage is the
      // same type dealt by the weapon, and the damage can be increased only by increasing the
      // ability modifier." (20424-20430)
      if (mod <= 0) return null;
      rider = { on: 'miss', filter: on, auto: true, do: [{ damage: [{ roll: '@mod', type: w.damage[0]!.type }] }] };
      break;
    case 'push':
      // "If you hit a creature with this weapon, you can push the creature up to 10 feet straight
      // away from yourself if it is Large or smaller." (20437-20440)
      rider = { on: 'hit', filter: on, do: [{ forcedMove: { mode: 'push', maxFt: 10, maxSize: 'large', straight: true } }] };
      break;
    case 'sap':
      // "If you hit a creature with this weapon, that creature has Disadvantage on its next attack
      // roll before the start of your next turn." (20442-20446)
      rider = { on: 'hit', filter: on, auto: true, do: [{ apply: { effect: 'sapped', to: 'target' } }] };
      effects = [{ id: 'sapped', name: 'Sapped', duration: { until: 'startOfNextTurn', of: 'caster' }, mods: [{ on: ['d20.attack'], op: 'dis', consume: 'nextRoll' }] }];
      break;
    case 'slow':
      // "If you hit a creature with this weapon and deal damage to it, you can reduce its Speed by
      // 10 feet until the start of your next turn. If the creature is hit more than once by weapons
      // that have this property, the Speed reduction doesn't exceed 10 feet." (20448-20453)
      rider = { on: 'dealtDamage', filter: on, auto: true, do: [{ apply: { effect: 'slowed', to: 'target' } }] };
      effects = [{ id: 'slowed', name: 'Slowed', duration: { until: 'startOfNextTurn', of: 'caster' }, stats: [{ speed: -10, noStack: 'mastery-slow' }] }];
      break;
    case 'topple':
      // "If you hit a creature with this weapon, you can force the creature to make a Constitution
      // saving throw (DC 8 plus the ability modifier used to make the attack roll and your
      // Proficiency Bonus). On a failed save, the creature has the Prone condition." (20455-20461)
      // The feature's spellAbility is the weapon's ability, so the save DC is 8 + PB + that modifier.
      rider = { on: 'hit', filter: on, do: [{ save: { ability: 'con', onFail: [{ condition: { id: 'prone' } }] } }] };
      break;
    case 'vex':
      // "If you hit a creature with this weapon and deal damage to the creature, you have Advantage
      // on your next attack roll against that creature before the end of your next turn." (20463-20467)
      rider = { on: 'dealtDamage', filter: on, auto: true, do: [{ apply: { effect: 'vexed', to: 'target' } }] };
      effects = [{ id: 'vexed', name: 'Vexed', duration: { until: 'endOfNextTurn', of: 'caster' }, mods: [{ on: ['d20.attack'], side: 'incoming', op: 'adv', consume: 'nextRoll', from: 'owner' }] }];
      break;
  }
  return FeatureSchema.parse({
    kind: 'feature',
    id: masteryFeatureId(w),
    name: `Weapon Mastery (${w.name})`,
    source: 'SRD 5.2.1 p.90 (Mastery Properties)',
    spellAbility: ability,
    riders: [{ id, name, ...rider }],
    effects,
  });
}

/**
 * The Light property's extra attack (a Bonus Action), plus one Nick form per mastered Light weapon
 * with Nick (no Bonus Action: "as part of the Attack action instead", once per turn, 20432-20435).
 * Both forms share the feature's once-per-turn use: the Light property gives "one extra attack".
 */
export function lightFeature(nick: readonly PcWeaponSrc[]): FeatureSource {
  const extra = { id: 'extra-attack', name: 'Light extra attack', cost: 'bonus', uses: { perTurn: 1 }, when: ['lightExtra'], do: [{ weaponAttack: { with: 'held', lightExtra: true, noAbilityToDamage: true } }] };
  const nicks = nick.map((w) => ({
    id: `nick-${w.id}`,
    name: `Nick (${w.name})`,
    cost: 'free',
    uses: { perTurn: 1 },
    when: ['lightExtra'],
    do: [{ weaponAttack: { with: w.id, lightExtra: true, noAbilityToDamage: true } }],
  }));
  return FeatureSchema.parse({
    kind: 'feature',
    id: LIGHT_FEATURE_ID,
    name: 'Light',
    source: 'SRD 5.2.1 p.90 (Weapon Properties: Light)',
    activate: nicks.length > 0 ? [extra, ...nicks] : extra,
  });
}
