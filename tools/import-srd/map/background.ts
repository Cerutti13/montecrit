// Backgrounds: origins24 background records (docs/design/m3.md 2.3).
//   abilities  the three an AbilityScoreImprovement leaves unlocked
//   skills     the Trait advancement's skills:* grants
//   tools      the Trait advancement's tool:* grants (closed name table below)
//   choices    a Trait tool choice (Soldier's gaming set)
//   feat       the ItemGrant into feats24 (must be a kept origin feat)
// Languages and equipment have no field and carry no combat rules; they are left out.

import { ABILITIES } from '../../../packages/engine/src/content/types.ts';
import { U } from '../unimplemented.ts';
import { getPath } from '../util.ts';
import { advancements, advLevel, byString, bySkillOrder, choiceLevel, grantedIds, kebab, pdfEntry, skillOf, sourceOf, traitCodes } from './origin-util.ts';
import type { Mapper } from './types.ts';

/** Foundry tool codes the SRD backgrounds use, to the PDF's names (Backgrounds p.83, Tools p.93-94). */
export const TOOL_NAMES: Readonly<Record<string, string>> = {
  'art:calligrapher': "Calligrapher's Supplies",
  thief: "Thieves' Tools",
};

/** "One kind of Gaming Set": the PDF's four Gaming Set variants (Tools, p.94). */
export const GAMING_SETS: readonly string[] = ['Gaming Set (Dice)', 'Gaming Set (Dragonchess)', 'Gaming Set (Playing Cards)', 'Gaming Set (Three-Dragon Ante)'];

function toolsOf(code: string, where: string): string[] {
  if (code === 'game:*') return [...GAMING_SETS];
  const n = TOOL_NAMES[code];
  if (n === undefined) throw new Error(`${where}: unknown Foundry tool code tool:${code}`);
  return [n];
}

export const mapBackground: Mapper = (ctx) => {
  const rec = ctx.kept.rec;
  const where = rec.path;
  const lines: string[] = [];
  const page = pdfEntry(ctx.pdf?.backgrounds, rec.name)?.page;
  let abilities: string[] | undefined;
  const skills: string[] = [];
  const tools: string[] = [];
  const choices: Record<string, unknown>[] = [];
  let feat: string | undefined;
  for (const a of advancements(ctx.doc)) {
    if (a.type === 'AbilityScoreImprovement') {
      const locked = getPath(a, 'configuration.locked');
      const lk = Array.isArray(locked) ? locked.map(String) : [];
      abilities = ABILITIES.filter((x) => !lk.includes(x));
    } else if (a.type === 'Trait') {
      const t = traitCodes(a);
      for (const g of t.grants) {
        if (g.startsWith('skills:')) skills.push(skillOf(g.slice(7), where));
        else if (g.startsWith('tool:')) tools.push(...toolsOf(g.slice(5), where));
        else if (!g.startsWith('languages:')) lines.push(U.choiceNotMapped('trait-grant'));
      }
      for (const ch of t.choices) {
        if (ch.pool.every((p) => p.startsWith('tool:'))) {
          const from = [...new Set(ch.pool.flatMap((p) => toolsOf(p.slice(5), where)))].sort(byString);
          choices.push({ id: 'tools', level: choiceLevel(advLevel(a)), choose: ch.count, from: { tools: from } });
        } else if (!ch.pool.every((p) => p.startsWith('languages:'))) lines.push(U.choiceNotMapped('trait-choice'));
      }
    } else if (a.type === 'ItemGrant') {
      const ids = grantedIds(a, 'feats24');
      if (ids.length !== 1 || grantedIds(a).length !== 1) throw new Error(`${where}: expected one feat grant, got ${grantedIds(a).length}`);
      const k = ctx.lookup(ids[0]!);
      if (!k) throw new Error(`${where}: its feat ${ids[0]} was not kept`);
      feat = ctx.idOf(k.rec.id);
      // A feat whose spell choice spans several class lists (Magic Initiate): the PDF fixes one
      // per background ("Magic Initiate (Cleric)"), which the data doesn't carry.
      const lists = advancements(k.rec.doc).filter((x) => x.type === 'ItemChoice' && ((getPath(x, 'configuration.restriction.list') as unknown[] | undefined)?.length ?? 0) > 1);
      if (lists.length) lines.push(U.choiceNotMapped('feat-spell-list'));
    }
  }
  if (!abilities || abilities.length !== 3) throw new Error(`${where}: expected three unlocked abilities, got ${abilities?.length ?? 0}`);
  if (skills.length !== 2) throw new Error(`${where}: expected two skills, got ${skills.length}`);
  if (feat === undefined) throw new Error(`${where}: no feat`);
  const item: Record<string, unknown> = {
    kind: 'background',
    id: ctx.idOf(rec.id) ?? `srd:${kebab(rec.name)}`,
    name: rec.name,
    source: sourceOf(page),
    abilities,
    skills: skills.sort(bySkillOrder),
    feat,
  };
  if (tools.length) item.tools = [...new Set(tools)].sort(byString);
  if (choices.length) item.choices = choices;
  return { kind: 'background', item, unimplemented: lines, classify: { maps: true, shape: 'data', hasDuration: false }, pdfPage: page };
};
