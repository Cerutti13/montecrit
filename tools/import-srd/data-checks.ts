// Checks over the whole generated item set, run by buildImport after mapping and overrides
// (M3 step 3: the data a kind: character file builds from). Each fails the import closed.
//
//   checkScaleRefs   every @scale reference in the emitted data resolves under the engine's
//                    rules (data-kinds.ts resolveScale, C16): a class's expressions see its own
//                    columns; a subclass's see its own (by local id or scaleOwner) then its
//                    parent's; a class or subclass feature sees the scopes of every class or
//                    subclass that grants it (in its features lists or a choice's options) and
//                    must resolve in each; species, backgrounds, feats, their features,
//                    weapons and armor have no @scale scope at all. A slots column can't be
//                    referenced, and a scale column id must start with a letter.
//   checkHpGrants    every feature hp grant (C9a) equals the PDF reading recorded in HP_GRANTS,
//                    and every HP_GRANTS entry whose owner is emitted is emitted with that grant.
//   checkPoolLevels  every class or subclass pool is named after a feature its owner grants by
//                    level, so the engine can gate the pool on that feature's level (review R1:
//                    content/character.ts keeps a pool with no such feature from level 1).

import { ExprError } from '../../packages/engine/src/dice/expr.ts';
import { localOf } from '../../packages/engine/src/content/compile-spell.ts';
import { resolveScale, subclassScopes, type ScaleScope } from '../../packages/engine/src/content/data-kinds.ts';
import type { ClassSource, SubclassSource } from '../../packages/engine/src/content/schema.ts';
import { byString, isRecord } from './util.ts';

type Item = Readonly<Record<string, unknown>>;

/** @scale references as the engine's grammar reads them (hyphens only inside @scale segments). */
const SCALE_REF = /@scale(?:\.[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)+/g;

/** Every string in an item (provenance and prose fields aside), with its path. */
function strings(v: unknown, path: string, out: { path: string; text: string }[]): void {
  if (typeof v === 'string') out.push({ path, text: v });
  else if (Array.isArray(v)) v.forEach((x, i) => strings(x, `${path}[${i}]`, out));
  else if (isRecord(v)) {
    for (const k of Object.keys(v).sort(byString)) {
      if (k === 'provenance' || k === 'unimplemented' || k === 'name' || k === 'source') continue;
      strings(v[k], path ? `${path}.${k}` : k, out);
    }
  }
}

/** The scopes an owner's own expressions reach. */
function scopesOf(item: Item, classes: ReadonlyMap<string, Item>): ScaleScope[] {
  if (item.kind === 'class') return [{ names: [localOf(item.id as string)], columns: (item.scale ?? {}) as ClassSource['scale'] }];
  const sub = { ...item, scale: item.scale ?? {} } as unknown as SubclassSource;
  const parent = classes.get(item.parent as string) as unknown as ClassSource | undefined;
  return subclassScopes(sub, parent ? ({ ...parent, scale: parent.scale ?? {} } as ClassSource) : undefined);
}

/** Feature ids an owner grants: its features by level and its choices' feature options. */
function grantedFeatures(item: Item): string[] {
  const out: string[] = [];
  const f = item.features;
  if (isRecord(f)) for (const lvl of Object.keys(f)) for (const id of (f[lvl] as unknown[]) ?? []) if (typeof id === 'string') out.push(id);
  for (const c of Array.isArray(item.choices) ? item.choices : []) {
    const fr = isRecord(c) && isRecord(c.from) ? c.from.features : undefined;
    if (Array.isArray(fr)) for (const id of fr) if (typeof id === 'string') out.push(id);
  }
  return out;
}

/** One problem per @scale reference that wouldn't resolve (empty = all resolve). */
export function scaleProblems(items: ReadonlyMap<string, Item>): string[] {
  const problems: string[] = [];
  const classes = new Map<string, Item>();
  for (const [id, it] of items) if (it.kind === 'class') classes.set(id, it);
  const ownerScopes = new Map<string, ScaleScope[]>();
  const grantors = new Map<string, string[]>();
  for (const id of [...items.keys()].sort(byString)) {
    const it = items.get(id)!;
    if (it.kind !== 'class' && it.kind !== 'subclass') continue;
    const scopes = scopesOf(it, classes);
    ownerScopes.set(id, scopes);
    for (const col of Object.keys(scopes[0]!.columns).sort(byString)) {
      if (!/^[a-z]/.test(col)) problems.push(`${id}: scale column id "${col}" doesn't start with a letter, so no @scale can name it`);
    }
    for (const f of grantedFeatures(it)) grantors.set(f, [...(grantors.get(f) ?? []), id]);
  }
  for (const id of [...items.keys()].sort(byString)) {
    const it = items.get(id)!;
    const found: { path: string; text: string }[] = [];
    strings(it, '', found);
    const refs = found.flatMap((s) => [...s.text.matchAll(SCALE_REF)].map((m) => ({ path: s.path, ref: m[0] })));
    if (refs.length === 0) continue;
    const reach: { owner: string; scopes: ScaleScope[] }[] =
      it.kind === 'class' || it.kind === 'subclass'
        ? [{ owner: id, scopes: ownerScopes.get(id)! }]
        : it.kind === 'feature'
          ? (grantors.get(id) ?? []).map((o) => ({ owner: o, scopes: ownerScopes.get(o)! }))
          : [];
    for (const r of refs) {
      if (reach.length === 0) {
        problems.push(`${id} ${r.path}: ${r.ref} has no scale scope (a ${String(it.kind)}${it.kind === 'feature' ? ' no class or subclass grants' : ''} can't read @scale)`);
        continue;
      }
      for (const { owner, scopes } of reach) {
        try {
          const got = resolveScale(r.ref.slice(1), scopes);
          if (got === undefined) problems.push(`${id} ${r.path}: ${r.ref} names no column ${owner} can reach`);
          else if (scopes[got.scope]!.columns[got.column]!.type === 'slots') problems.push(`${id} ${r.path}: ${r.ref} is a slots column, which no expression can read`);
        } catch (e) {
          if (!(e instanceof ExprError)) throw e;
          problems.push(`${id} ${r.path}: ${e.message} (granted by ${owner})`);
        }
      }
    }
  }
  return problems;
}

export function checkScaleRefs(items: ReadonlyMap<string, Item>): void {
  const p = scaleProblems(items);
  if (p.length) throw new Error(`@scale references that would not resolve; fail closed:\n  ${p.join('\n  ')}`);
}

/**
 * Feature hp grants as the SRD 5.2.1 PDF prints them, read by hand (srd-raw.txt), with how the
 * engine's sum (content/character.ts: perLevel x levels + flat; a class or subclass feature
 * counts that class's levels, a species trait or feat character levels) reproduces the text.
 * A grant a record carries that isn't here, or differs, fails the import: the PDF decides.
 * The PDF's other "Hit Point maximum increases" texts are the Berserker Axe (a magic item,
 * step 6) and the CON-modifier rule (p.25, part of the HP rule itself, not a grant). Tough and
 * Boon of Fortitude are not in SRD 5.2.1.
 */
export const HP_GRANTS: Readonly<Record<string, { readonly owner: string; readonly hp: { readonly perLevel?: number; readonly flat?: number }; readonly pdf: string }>> = {
  // "Your Hit Point maximum increases by 3, and it increases by 1 whenever you gain another
  // Sorcerer level" (gained at Sorcerer 3): 3 + (L - 3) = L, so 1 per Sorcerer level.
  'srd:draconic-sorcery/draconic-resilience': { owner: 'srd:draconic-sorcery', hp: { perLevel: 1 }, pdf: 'p.69' },
  // "Your Hit Point maximum increases by 1, and it increases by 1 again whenever you gain a
  // level" (from character level 1): 1 + (L - 1) = L, so 1 per character level.
  'srd:dwarf/dwarven-toughness': { owner: 'srd:dwarf', hp: { perLevel: 1 }, pdf: 'p.84' },
};

const hpKey = (hp: unknown): string => (isRecord(hp) ? `perLevel=${String(hp.perLevel ?? '-')} flat=${String(hp.flat ?? '-')}` : 'none');

export function hpProblems(items: ReadonlyMap<string, Item>, table = HP_GRANTS): string[] {
  const p: string[] = [];
  for (const id of [...items.keys()].sort(byString)) {
    const hp = items.get(id)!.hp;
    if (hp === undefined || items.get(id)!.kind !== 'feature') continue;
    const want = table[id];
    if (!want) p.push(`${id}: hp ${hpKey(hp)} has no PDF reading in HP_GRANTS`);
    else if (hpKey(hp) !== hpKey(want.hp)) p.push(`${id}: hp ${hpKey(hp)}, the PDF (${want.pdf}) reads ${hpKey(want.hp)}`);
  }
  for (const id of Object.keys(table).sort(byString)) {
    if (!items.has(table[id]!.owner)) continue; // a partial import (tests) without the owner
    if (!items.has(id)) p.push(`${id}: in HP_GRANTS but not emitted`);
    else if (items.get(id)!.hp === undefined) p.push(`${id}: emitted without its hp grant (${table[id]!.pdf})`);
  }
  return p;
}

export function checkHpGrants(items: ReadonlyMap<string, Item>): void {
  const p = hpProblems(items);
  if (p.length) throw new Error(`feature hp grants that disagree with the PDF; fail closed:\n  ${p.join('\n  ')}`);
}

/** One problem per class or subclass pool whose id names no feature in its owner's features by level. */
export function poolProblems(items: ReadonlyMap<string, Item>): string[] {
  const p: string[] = [];
  for (const id of [...items.keys()].sort(byString)) {
    const it = items.get(id)!;
    if (it.kind !== 'class' && it.kind !== 'subclass') continue;
    const locals: string[] = [];
    const f = it.features;
    if (isRecord(f)) for (const lvl of Object.keys(f)) for (const fid of (f[lvl] as unknown[]) ?? []) if (typeof fid === 'string') locals.push(fid.slice(fid.lastIndexOf('/') + 1));
    for (const pool of Array.isArray(it.pools) ? it.pools : []) {
      const pid = isRecord(pool) ? pool.id : undefined;
      if (typeof pid !== 'string' || !locals.includes(pid)) p.push(`${id}: pool ${String(pid)} names no feature in its features by level, so no level gates it`);
    }
  }
  return p;
}

export function checkPoolLevels(items: ReadonlyMap<string, Item>): void {
  const p = poolProblems(items);
  if (p.length) throw new Error(`pools with no granting feature to gate their level; fail closed:\n  ${p.join('\n  ')}`);
}
