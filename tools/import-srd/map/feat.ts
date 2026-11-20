// Feats: feats24 records (docs/design/m3.md 2.3, C9c).
//   category    from the PDF index ("Origin Feat" -> origin, "Fighting Style Feat" ->
//               fightingStyle...): a background's feat must be an origin feat (data-kinds.ts)
//   repeatable  system.prerequisites.repeatable
//   choices     Trait skill choices (Skilled)
//   features    a feat whose effects map (featureBody in species.ts, with its PDF reading
//               from pdf-gates.ts) gets one feature item, srd:<feat>/<feat>, and lists it
//               (M3 step 4: Defense's +1 AC while armored, p.88). The feature carries its own
//               fidelity (shape 'other': full only by a reviewed override); the feat is data.
//               Every other feat's effects and activities stay templated lines (Archery's
//               ranged-weapon bonus needs the weapon roll-key bit that attacks don't set yet;
//               the rest are prose or activities), and the feat is narrative unless a choice maps.
// An Ability Score Improvement advancement has no field (FeatSchema has no ability increase).

import { ABILITIES } from '../../../packages/engine/src/content/types.ts';
import { U } from '../unimplemented.ts';
import { getPath } from '../util.ts';
import { ALL_SKILLS, advancements, advLevel, bySkillOrder, choiceLevel, grantsSpells, kebab, pdfEntry, skillOf, sourceOf, traitCodes } from './origin-util.ts';
import { featureBody } from './species.ts';
import type { Mapper, MapOutput } from './types.ts';

/**
 * A feat's "increase one of these scores by 1" (Grappler: Strength or Dexterity; the Epic
 * Boons: any score), from an AbilityScoreImprovement with 1 point, cap 1 and nothing fixed:
 * choose 1 from the unlocked abilities, id ability-scores. Recorded only (the scores in a
 * character file are final); the score maximum (20, or 30 for a boon) has no field. Any other
 * shape (the Ability Score Improvement feat's +2 or +1/+1) stays a line: choose-N-from can't
 * say "+2 to one or +1 to two".
 */
export function abilityChoice(a: Readonly<Record<string, unknown>>): Record<string, unknown> | undefined {
  const points = getPath(a, 'configuration.points');
  const cap = getPath(a, 'configuration.cap');
  const fixed = getPath(a, 'configuration.fixed');
  const locked = getPath(a, 'configuration.locked');
  if (points !== 1 || cap !== 1) return undefined;
  if (fixed !== undefined && (typeof fixed !== 'object' || fixed === null || Object.values(fixed).some((v) => v !== 0))) return undefined;
  const lock = Array.isArray(locked) ? locked : [];
  const from = ABILITIES.filter((ab) => !lock.includes(ab));
  if (from.length === 0) return undefined;
  return { id: 'ability-scores', level: choiceLevel(advLevel(a)), choose: 1, from: { abilities: from } };
}

const CATEGORY: Readonly<Record<string, string>> = { origin: 'origin', general: 'general', 'fighting-style': 'fightingStyle', 'epic-boon': 'epicBoon' };

export const mapFeat: Mapper = (ctx) => {
  const rec = ctx.kept.rec;
  const where = rec.path;
  const entry = pdfEntry(ctx.pdf?.feats, rec.name);
  const category = entry ? CATEGORY[entry.category] : undefined;
  if (category === undefined) throw new Error(`${where}: no PDF feat category for ${rec.name}`);
  const lines: string[] = [];
  const sub = getPath(ctx.doc, 'system.type.subtype');
  if (typeof sub === 'string' && sub !== '' && sub !== category) lines.push(U.pdfHeaderDisagrees());
  const choices: Record<string, unknown>[] = [];
  for (const a of advancements(ctx.doc)) {
    if (a.type === 'AbilityScoreImprovement') {
      const c = abilityChoice(a);
      if (c) choices.push(c);
      else lines.push(U.choiceNotMapped('ability-scores'));
    }
    else if (a.type === 'ItemChoice' || a.type === 'ItemGrant') {
      if (grantsSpells(a)) lines.push(U.spellGrants());
      else lines.push(U.choiceNotMapped('granted-item'));
    } else if (a.type === 'Trait') {
      for (const ch of traitCodes(a).choices) {
        const skills = ch.pool.filter((p) => p.startsWith('skills:'));
        if (skills.length) {
          const from = skills.includes('skills:*') ? [...ALL_SKILLS] : skills.map((p) => skillOf(p.slice(7), where)).sort(bySkillOrder);
          choices.push({ id: kebab(String(a.title || 'skills')) || 'skills', level: choiceLevel(advLevel(a)), choose: ch.count, from: { skills: from }, grants: 'proficiency' });
        }
        if (ch.pool.some((p) => p.startsWith('tool:'))) lines.push(U.choiceNotMapped('tools'));
        if (ch.pool.some((p) => !p.startsWith('skills:') && !p.startsWith('tool:') && !p.startsWith('languages:'))) lines.push(U.choiceNotMapped('trait-choice'));
      }
      if (traitCodes(a).grants.length) lines.push(U.choiceNotMapped('trait-grant'));
    }
  }
  const id = ctx.idOf(rec.id) ?? `srd:${kebab(rec.name)}`;
  const local = id.slice(id.indexOf(':') + 1);
  const featureId = `${id}/${local}`;
  // Effects and activities (see the header). A body maps only with a PDF reading or the step-2
  // shapes (hp per level, save advantage); then the feature item carries it and its lines.
  const { body, lines: fxLines } = featureBody(ctx.doc, local, rec.name, featureId);
  const hasFeature = body.hp !== undefined || body.passive !== undefined;
  if (!hasFeature) lines.push(...fxLines);
  const item: Record<string, unknown> = { kind: 'feat', id, name: rec.name, source: sourceOf(entry?.page), category };
  if (getPath(ctx.doc, 'system.prerequisites.repeatable') === true) item.repeatable = true;
  if (hasFeature) item.features = [featureId];
  if (choices.length) item.choices = choices;
  // An ability choice records the feat's score increase only; the feat's other benefits are
  // what make it mapped (classify), so it alone never lifts a feat above narrative.
  const featOut: MapOutput = {
    kind: 'feat',
    item,
    unimplemented: lines,
    classify: { maps: hasFeature || choices.some((c) => c.id !== 'ability-scores'), shape: 'data', hasDuration: false },
    pdfPage: entry?.page,
  };
  if (!hasFeature) return featOut;
  const feature: MapOutput = {
    kind: 'feature',
    item: { kind: 'feature', id: featureId, name: rec.name, source: sourceOf(entry?.page), ...body },
    unimplemented: fxLines,
    classify: { maps: true, shape: 'other', hasDuration: false },
    pdfPage: entry?.page,
  };
  return [featOut, feature];
};
