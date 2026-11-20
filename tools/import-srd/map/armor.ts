// Mundane armor and the Shield: equipment24 equipment records of type light, medium, heavy or
// shield that pass the name gate (docs/design/m3.md 2.3; magic armor waits for step 6, C9b).
//   system.type.value -> category; system.armor.value -> ac (a shield's is what it adds)
//   system.armor.dex  -> dexCap, medium armor only (heavy stores 0 = adds none; light null = no cap)
//   system.strength   -> strength; properties stealthDisadvantage -> stealthDis
// Checked against the PDF index row (category, AC, Dex cap, Strength, Stealth); a
// disagreement is a "PDF header disagrees" line.

import { U } from '../unimplemented.ts';
import { getPath, isRecord } from '../util.ts';
import { kebab, pdfEntry, sourceOf } from './origin-util.ts';
import type { Mapper } from './types.ts';

const CATEGORIES: readonly string[] = ['light', 'medium', 'heavy', 'shield'];

export const mapArmor: Mapper = (ctx) => {
  const rec = ctx.kept.rec;
  const where = rec.path;
  const s = ctx.doc.system;
  if (!isRecord(s)) throw new Error(`${where}: no system`);
  const category = String(getPath(s, 'type.value'));
  if (!CATEGORIES.includes(category)) throw new Error(`${where}: armor type ${category}`);
  const ac = getPath(s, 'armor.value');
  if (typeof ac !== 'number' || !Number.isInteger(ac) || ac < 1) throw new Error(`${where}: no armor value`);
  const dex = getPath(s, 'armor.dex');
  const str = s.strength;
  const props = Array.isArray(s.properties) ? s.properties.map(String) : [];
  const item: Record<string, unknown> = { kind: 'armor', id: ctx.idOf(rec.id) ?? `srd:${kebab(rec.name)}`, name: rec.name, category, ac };
  if (category === 'medium') {
    if (typeof dex !== 'number' || !Number.isInteger(dex) || dex < 0) throw new Error(`${where}: medium armor without a Dex cap`);
    item.dexCap = dex;
  } else if (category === 'light' && dex !== null && dex !== undefined) throw new Error(`${where}: light armor with a Dex cap`);
  if (typeof str === 'number' && str > 0) item.strength = str;
  const stealthDis = props.includes('stealthDisadvantage');
  if (stealthDis) item.stealthDis = true;

  const lines: string[] = [];
  const entry = pdfEntry(ctx.pdf?.armor, rec.name);
  if (entry) {
    const agree =
      entry.category === category &&
      entry.ac === ac &&
      entry.addDex === (category === 'light' || category === 'medium') &&
      entry.dexMax === item.dexCap &&
      entry.strength === item.strength &&
      entry.stealthDisadvantage === stealthDis;
    if (!agree) lines.push(U.pdfHeaderDisagrees());
  }
  item.source = sourceOf(entry?.page);
  return { kind: 'armor', item, unimplemented: lines, classify: { maps: true, shape: 'data', hasDuration: false }, pdfPage: entry?.page };
};
