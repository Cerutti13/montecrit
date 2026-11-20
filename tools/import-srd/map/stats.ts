// STAT mapping (M3 step 4): one mapped effect change -> the engine's stat source form
// (content/schema.ts StatSchema) or a condition immunity. Used by the class-feature mapper
// (feature.ts mapEffects) and the trait/feat mapper (species.ts featureBody), and only for a
// feature with a PDF reading (pdf-gates.ts): Foundry's always-on effects drop the conditions
// the text puts on them, so without a reading these changes keep their effect-key lines.
//
//   system.attributes.ac.bonus add <int>                 -> { ac: n }
//   system.attributes.movement.walk add <int|@scale...>  -> { speed: n | '@scale.<owner>.<col>' }
//                (walk only: the engine models walking speed alone; fly is rejected by the schema)
//   flags.dnd5e.weaponCriticalThreshold downgrade|override <2..19> -> { critMin: n }
//                [U] Foundry's threshold applies to weapon items, which in dnd5e include the
//                Unarmed Strike; the engine's critMin covers weapon attacks and Unarmed Strikes.
//                Each use is checked against its PDF text by its reading.
//   system.traits.di.value add <damage type>             -> { immune: [type] }
//   system.traits.dv.value add <damage type>             -> { vuln: [type] }
//   system.traits.dr.value add <damage type>             -> { resist: [type] } (gated readings only;
//                an ungated resistance stays the feature's plain resist field, as in step 2)
//   system.traits.ci.value add <condition>               -> effect immune: [cond] (exact condition
//                ids only: Nature's Ward's value "poison" is a damage-type word, not a condition id,
//                so it keeps its line)

import { CONTENT_CONDS } from '../../../packages/engine/src/content/types.ts';
import type { EffectTarget } from '../effect-keys.ts';

export const DAMAGE_TYPES: readonly string[] = ['acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning', 'necrotic', 'piercing', 'poison', 'psychic', 'radiant', 'slashing', 'thunder'];

/** A qualified @scale reference, the only expression a stat takes from the data. */
const SCALE = /^@scale\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const intOf = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^[+-]?\d+$/.test(v.trim())) return Number(v.trim());
  return undefined;
};

export type StatPart =
  | { readonly stat: Record<string, unknown> }
  | { readonly immuneCond: string }
  | { readonly resist: string };

/** The stat part for one mapped change, or undefined when this change isn't a stat (or its value doesn't fit). */
export function statPart(t: EffectTarget, mode: string, value: unknown): StatPart | undefined {
  const n = intOf(value);
  const s = typeof value === 'string' ? value.trim() : undefined;
  switch (t.to) {
    case 'stat.ac':
      return mode === 'add' && n !== undefined && n !== 0 ? { stat: { ac: n } } : undefined;
    case 'stat.speed':
      if (t.mode !== 'walk' || mode !== 'add') return undefined;
      if (n !== undefined && n !== 0 && n % 5 === 0) return { stat: { speed: n } };
      return s !== undefined && SCALE.test(s) ? { stat: { speed: s } } : undefined;
    case 'stat.critMin':
      return (mode === 'downgrade' || mode === 'override') && n !== undefined && n >= 2 && n <= 19 ? { stat: { critMin: n } } : undefined;
    case 'immune.damage':
      return mode === 'add' && s !== undefined && DAMAGE_TYPES.includes(s) ? { stat: { immune: [s] } } : undefined;
    case 'vulnerable':
      return mode === 'add' && s !== undefined && DAMAGE_TYPES.includes(s) ? { stat: { vuln: [s] } } : undefined;
    case 'resist':
      return mode === 'add' && s !== undefined && DAMAGE_TYPES.includes(s) ? { resist: s } : undefined;
    case 'immune.condition':
      return mode === 'add' && s !== undefined && (CONTENT_CONDS as readonly string[]).includes(s) ? { immuneCond: s } : undefined;
    default:
      return undefined;
  }
}

/** Stats with resist folded into one { resist: [...] } stat, each with `when` when the reading gates it. */
export function finishStats(stats: readonly Record<string, unknown>[], resist: readonly string[], when: readonly string[]): Record<string, unknown>[] {
  const out = [...stats];
  if (resist.length) out.push({ resist: [...new Set(resist)].sort((a, b) => DAMAGE_TYPES.indexOf(a) - DAMAGE_TYPES.indexOf(b)) });
  return when.length ? out.map((x) => ({ ...x, when: [...when] })) : out;
}
