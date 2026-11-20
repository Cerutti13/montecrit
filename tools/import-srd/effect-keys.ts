// The closed effect-key table (docs/design/m3.md 4.5), seeded from the step 1 census
// (docs/research/m3-foundry-census.md section 3). A Foundry ActiveEffect change is
// { key, value, type } where key is a Foundry actor-data path. Each (key, mode) is one of:
//   mapped   our side has a target for it (a STAT, a d20 mod, a build-time proficiency...)
//   ignored  cosmetic or bookkeeping (names, prices, rarity, art): no mechanics lost
//   dropped  named after a premium module (C5): never emitted, not even in a line
//   unknown  anything else: the item becomes partial with a templated line
// The table is closed: adding a row is a reviewed change here, never inferred at run time.

import { U } from './unimplemented.ts';

export type EffectTarget =
  | { readonly to: 'stat.ac' }
  | { readonly to: 'stat.critMin' }
  | { readonly to: 'stat.speed'; readonly mode: string }
  | { readonly to: 'd20.attack'; readonly range: 'melee' | 'ranged'; readonly attack: 'weapon' | 'spell' }
  | { readonly to: 'd20.save' }
  | { readonly to: 'd20.check' }
  | { readonly to: 'd20.save.mode'; readonly ability: string }
  | { readonly to: 'd20.check.mode'; readonly ability: string }
  | { readonly to: 'initiative' }
  | { readonly to: 'proficiency'; readonly what: 'armor' | 'weapon' }
  | { readonly to: 'scaleDelta'; readonly owner: string; readonly column: string }
  | { readonly to: 'resist' }
  | { readonly to: 'immune.damage' }
  | { readonly to: 'immune.condition' }
  | { readonly to: 'vulnerable' }
  | { readonly to: 'hp.perLevel' };

export type ChangeClass =
  | { readonly status: 'mapped'; readonly target: EffectTarget }
  | { readonly status: 'ignored' }
  | { readonly status: 'dropped'; readonly line: string }
  | { readonly status: 'unknown'; readonly line: string };

const ABL = '(str|dex|con|int|wis|cha)';
const PREMIUM = /dnd-players-handbook|dnd-monster-manual|dnd-dungeon-masters-guide/i;

interface Row {
  readonly key: RegExp;
  readonly modes: readonly string[];
  readonly target: (m: RegExpExecArray) => EffectTarget;
}

/** Rows that map (census counts in comments: n over all passing records). */
export const MAPPED_ROWS: readonly Row[] = [
  { key: /^system\.attributes\.ac\.bonus$/, modes: ['add'], target: () => ({ to: 'stat.ac' }) }, // 27; Shield
  { key: /^system\.bonuses\.mwak\.attack$/, modes: ['add'], target: () => ({ to: 'd20.attack', range: 'melee', attack: 'weapon' }) }, // 31
  { key: /^system\.bonuses\.rwak\.attack$/, modes: ['add'], target: () => ({ to: 'd20.attack', range: 'ranged', attack: 'weapon' }) }, // 29
  { key: /^system\.bonuses\.msak\.attack$/, modes: ['add'], target: () => ({ to: 'd20.attack', range: 'melee', attack: 'spell' }) }, // 37
  { key: /^system\.bonuses\.rsak\.attack$/, modes: ['add'], target: () => ({ to: 'd20.attack', range: 'ranged', attack: 'spell' }) }, // 37
  { key: /^system\.bonuses\.abilities\.save$/, modes: ['add'], target: () => ({ to: 'd20.save' }) }, // 36; Bless
  { key: /^system\.bonuses\.abilities\.check$/, modes: ['add'], target: () => ({ to: 'd20.check' }) }, // 23
  { key: new RegExp(`^system\\.abilities\\.${ABL}\\.save\\.roll\\.mode$`), modes: ['add'], target: (m) => ({ to: 'd20.save.mode', ability: m[1]! }) }, // 32
  { key: new RegExp(`^system\\.abilities\\.${ABL}\\.check\\.roll\\.mode$`), modes: ['add'], target: (m) => ({ to: 'd20.check.mode', ability: m[1]! }) }, // 27
  { key: /^system\.attributes\.init\.bonus$/, modes: ['add'], target: () => ({ to: 'initiative' }) }, // 20
  { key: /^system\.traits\.armorProf\.value$/, modes: ['add'], target: () => ({ to: 'proficiency', what: 'armor' }) }, // 2; Primal Order: Warden
  { key: /^system\.traits\.weaponProf\.value$/, modes: ['add'], target: () => ({ to: 'proficiency', what: 'weapon' }) }, // 4
  {
    key: /^system\.scale\.([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\.([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\.value$/,
    modes: ['add'],
    target: (m) => ({ to: 'scaleDelta', owner: m[1]!, column: m[2]! }), // 2; Primal Order: Magician
  },
  { key: /^system\.traits\.dr\.value$/, modes: ['add'], target: () => ({ to: 'resist' }) }, // 199
  { key: /^system\.traits\.di\.value$/, modes: ['add'], target: () => ({ to: 'immune.damage' }) }, // 7
  { key: /^system\.traits\.ci\.value$/, modes: ['add'], target: () => ({ to: 'immune.condition' }) }, // 35
  { key: /^system\.traits\.dv\.value$/, modes: ['add'], target: () => ({ to: 'vulnerable' }) }, // 6
  { key: /^system\.attributes\.movement\.(walk|fly|climb|swim|burrow)$/, modes: ['add', 'override', 'upgrade'], target: (m) => ({ to: 'stat.speed', mode: m[1]! }) },
  { key: /^flags\.dnd5e\.weaponCriticalThreshold$/, modes: ['downgrade', 'override'], target: () => ({ to: 'stat.critMin' }) }, // 2; Improved Critical
  { key: /^system\.attributes\.hp\.bonuses\.level$/, modes: ['add'], target: () => ({ to: 'hp.perLevel' }) }, // 2; C9a
];

/** Keys with no mechanical content for a combat sim. */
export const IGNORED_KEYS: readonly RegExp[] = [
  /^$/, // the census's junk empty key
  /^name$/,
  /^img$/,
  /^system\.description\.value$/,
  /^system\.unidentified\.(name|description)$/,
  /^system\.rarity$/,
  /^system\.price\.(value|denomination)$/,
  /^system\.attunement$/,
  /^system\.traits\.languages\.(value|custom)$/,
  /^activities\[[a-z]+\]\.description\.chatFlavor$/,
];

/** Classifies one change. `mode` is Foundry's change type (add, override, ...). */
export function classifyChange(key: string, mode: string): ChangeClass {
  if (PREMIUM.test(key) || PREMIUM.test(mode)) return { status: 'dropped', line: U.premiumPointer() };
  if (IGNORED_KEYS.some((r) => r.test(key))) return { status: 'ignored' };
  for (const row of MAPPED_ROWS) {
    const m = row.key.exec(key);
    if (m && row.modes.includes(mode)) return { status: 'mapped', target: row.target(m) };
  }
  const safeMode = /^(add|override|multiply|upgrade|downgrade|subtract|custom|[0-9])$/.test(mode) ? mode : 'custom';
  const safeKey = /^[A-Za-z][A-Za-z0-9_.[\]-]{0,120}$/.test(key);
  return { status: 'unknown', line: safeKey ? U.effectKey(key, safeMode) : U.effectKeyMalformed() };
}
