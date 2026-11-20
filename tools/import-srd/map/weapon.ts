// Mundane weapons: equipment24 weapon records that pass the name gate (docs/design/m3.md 2.3,
// 4.9; magic items wait for step 6, C9b). Foundry -> ours:
//   system.type.value simpleM|simpleR|martialM|martialR -> category simple|martial, attack melee|ranged
//   system.damage.base {number, denomination, bonus, types[0]} -> damage {roll, type}
//   system.properties codes -> properties (closed table; anything else fails the import)
//   system.range {value, long} -> range, for a ranged or thrown weapon
//   system.damage.versatile -> versatile: its own die when Foundry stores one, else the base
//     die one size up (Foundry leaves most versatile dice empty; every result is pinned to the
//     PDF's Weapons table in the tests)
//   system.mastery -> mastery
// M3 step 5b: the PDF decides. The index row (pdf/equipment.ts: the Weapons table, SRD 5.2.1 p.91,
// srd-raw.txt:20470-20900) carries category, damage, damage type, properties, range, versatile die
// and mastery; Foundry's record is a vote. When the row exists its properties, range, versatile die
// and mastery are what's emitted; any field where Foundry disagrees is a "PDF header disagrees"
// line, so the item can't be full until a reviewed override settles it.

import { U } from '../unimplemented.ts';
import { getPath, isRecord } from '../util.ts';
import { damageTypeOf, kebab, pdfEntry, sourceOf } from './origin-util.ts';
import type { Mapper } from './types.ts';

const PROPERTY_CODES: Readonly<Record<string, string>> = {
  fin: 'finesse',
  lgt: 'light',
  hvy: 'heavy',
  two: 'two-handed',
  ver: 'versatile',
  thr: 'thrown',
  amm: 'ammunition',
  lod: 'loading',
  rch: 'reach',
};
const PROPERTY_ORDER: readonly string[] = ['finesse', 'light', 'heavy', 'two-handed', 'versatile', 'thrown', 'ammunition', 'loading', 'reach'];
const MASTERIES: readonly string[] = ['cleave', 'graze', 'nick', 'push', 'sap', 'slow', 'topple', 'vex'];
const DIE_UP: Readonly<Record<number, number>> = { 4: 6, 6: 8, 8: 10, 10: 12 };

const TYPES: Readonly<Record<string, { category: 'simple' | 'martial'; attack: 'melee' | 'ranged' }>> = {
  simpleM: { category: 'simple', attack: 'melee' },
  simpleR: { category: 'simple', attack: 'ranged' },
  martialM: { category: 'martial', attack: 'melee' },
  martialR: { category: 'martial', attack: 'ranged' },
};

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined);

/** A Foundry damage part's dice ("1d8", or a flat "1" for the Blowgun). */
function rollOf(part: Record<string, unknown>, where: string): string {
  const n = num(part.number);
  const d = num(part.denomination);
  const bonus = typeof part.bonus === 'string' ? part.bonus.trim() : '';
  if (n !== undefined && d !== undefined) {
    if (bonus !== '') throw new Error(`${where}: dice with a bonus (${bonus}) aren't expected on a mundane weapon`);
    return `${n}d${d}`;
  }
  if (/^[1-9][0-9]*$/.test(bonus)) return bonus;
  throw new Error(`${where}: no damage dice`);
}

export const mapWeapon: Mapper = (ctx) => {
  const rec = ctx.kept.rec;
  const where = rec.path;
  const s = ctx.doc.system;
  if (!isRecord(s)) throw new Error(`${where}: no system`);
  const t = TYPES[String(getPath(s, 'type.value'))];
  if (!t) throw new Error(`${where}: weapon type ${String(getPath(s, 'type.value'))} is not simple/martial melee/ranged`);
  const base = getPath(s, 'damage.base');
  if (!isRecord(base)) throw new Error(`${where}: no base damage`);
  const types = Array.isArray(base.types) ? base.types.map(String) : [];
  if (types.length !== 1) throw new Error(`${where}: expected one damage type, got ${types.length}`);
  const roll = rollOf(base, where);
  const type = damageTypeOf(types[0]!, where);

  const props: string[] = [];
  for (const p of Array.isArray(s.properties) ? s.properties.map(String) : []) {
    const name = PROPERTY_CODES[p];
    if (name === undefined) throw new Error(`${where}: weapon property ${p} is not in the closed table`);
    props.push(name);
  }
  props.sort((a, b) => PROPERTY_ORDER.indexOf(a) - PROPERTY_ORDER.indexOf(b));
  const mastery = String(s.mastery ?? '');
  if (!MASTERIES.includes(mastery)) throw new Error(`${where}: mastery ${mastery} is not one of the eight`);

  const item: Record<string, unknown> = {
    kind: 'weapon',
    id: ctx.idOf(rec.id) ?? `srd:${kebab(rec.name)}`,
    name: rec.name,
    category: t.category,
    attack: t.attack,
    damage: { roll, type },
  };
  if (props.length) item.properties = props;
  if (t.attack === 'ranged' || props.includes('thrown')) {
    const near = num(getPath(s, 'range.value'));
    const far = num(getPath(s, 'range.long'));
    if (near === undefined || far === undefined) throw new Error(`${where}: a ranged or thrown weapon without a range`);
    item.range = [near, far];
  }
  if (props.includes('versatile')) {
    const v = getPath(s, 'damage.versatile');
    const vn = isRecord(v) ? num(v.number) : undefined;
    const vd = isRecord(v) ? num(v.denomination) : undefined;
    const bn = num(base.number);
    const up = DIE_UP[num(base.denomination) ?? 0];
    if (vn !== undefined && vd !== undefined) item.versatile = `${vn}d${vd}`;
    else if (bn !== undefined && up !== undefined) item.versatile = `${bn}d${up}`;
    else throw new Error(`${where}: a versatile weapon whose two-handed die can't be read`);
  }
  item.mastery = mastery;

  const lines: string[] = [];
  const entry = pdfEntry(ctx.pdf?.weapons, rec.name);
  if (entry) {
    const pdfProps = [...entry.properties].sort((a, b) => PROPERTY_ORDER.indexOf(a) - PROPERTY_ORDER.indexOf(b));
    const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
    const agree =
      entry.category === `${t.category}-${t.attack}` &&
      entry.damage === roll &&
      entry.damageType === type &&
      entry.mastery === mastery &&
      same(pdfProps, props) &&
      same(entry.range ?? null, item.range ?? null) &&
      same(entry.versatile ?? null, item.versatile ?? null);
    if (!agree) lines.push(U.pdfHeaderDisagrees());
    // The PDF's values stand (category, damage and type stay Foundry's: a disagreement there is the line).
    for (const p of pdfProps) if (!PROPERTY_ORDER.includes(p)) throw new Error(`${where}: PDF property ${p} is not in the closed table`);
    if (!MASTERIES.includes(entry.mastery)) throw new Error(`${where}: PDF mastery ${entry.mastery} is not one of the eight`);
    delete item.properties;
    delete item.range;
    delete item.versatile;
    delete item.mastery;
    if (pdfProps.length) item.properties = pdfProps;
    if (entry.range) item.range = [entry.range[0], entry.range[1]];
    if (entry.versatile) item.versatile = entry.versatile;
    item.mastery = entry.mastery;
  }
  item.source = sourceOf(entry?.page);
  return { kind: 'weapon', item, unimplemented: lines, classify: { maps: true, shape: 'data', hasDuration: false }, pdfPage: entry?.page };
};
