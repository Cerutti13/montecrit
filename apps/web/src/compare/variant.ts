// Compare's variants (PLAN.md M6: "a variant is a patch over the base sheet"): a copy of a loaded
// character with a few choices changed, held as a character text with its own id and added to
// the content set next to its base. Nothing is written to disk. The structured edits here change
// one line of the text each (a pick written on one line, the subclass in the classes line);
// anything else is edited in the YAML pane. Pure.

import { parseYaml, type SourceFile } from '@montecrit/engine';
import type { Need } from '@montecrit/host';
import type { AsiPick } from '../character/form.ts';
import type { ContentSet } from '../content/select.ts';

export const MAX_VARIANTS = 3;

export interface Variant {
  /** 1 to MAX_VARIANTS: its slot, which names its id and file. */
  readonly n: number;
  /** The id of the character it was copied from. */
  readonly base: string;
  /** The base's file path: the variant's file sits next to it, so it keeps the base's origin. */
  readonly basePath: string;
  readonly text: string;
}

export const variantId = (baseId: string, n: number): string => `${baseId}-variant-${n}`;
export const variantPath = (basePath: string, n: number): string => `${basePath.slice(0, basePath.lastIndexOf('/') + 1)}__compare-variant-${n}__.yaml`;
export const variantFile = (v: Variant): SourceFile => ({ path: variantPath(v.basePath, v.n), text: v.text });

/** The first free slot, or null when all are taken. */
export function freeSlot(variants: readonly Variant[]): number | null {
  for (let n = 1; n <= MAX_VARIANTS; n++) if (!variants.some((v) => v.n === n)) return n;
  return null;
}

const TOP = (key: string): RegExp => new RegExp(`^${key}:[^\\n]*$`, 'm');

/** A top-level scalar's line replaced; null when the text has no such line. */
function setTop(text: string, key: string, value: string): string | null {
  return TOP(key).test(text) ? text.replace(TOP(key), () => `${key}: ${value}`) : null;
}

/** The base's text as a variant's: its own id and name, everything else as written. Null when the text has no id line. */
export function startText(baseText: string, baseId: string, baseName: string, n: number): string | null {
  const withId = setTop(baseText, 'id', variantId(baseId, n));
  if (withId === null) return null;
  return setTop(withId, 'name', JSON.stringify(`${baseName} (variant ${n})`)) ?? withId;
}

/** The variant's display name as its text has it. */
export function nameOf(text: string): string | null {
  const v = parseYaml(text, 'variant.yaml').doc?.value as Record<string, unknown> | null | undefined;
  return v && typeof v.name === 'string' ? v.name : null;
}

export const setName = (text: string, name: string): string | null => setTop(text, 'name', JSON.stringify(name));

/** What the structured editor reads from a character text. */
export interface Read {
  readonly cls: string;
  readonly level: number;
  readonly subclass: string;
  readonly species: string;
  readonly background: string;
  /** The picks that are plain lists of ids, by key. */
  readonly picks: Readonly<Record<string, readonly string[]>>;
  /** The picks that are maps (an Ability Score Improvement or a feat, a background's increases), by key. */
  readonly maps: Readonly<Record<string, AsiValue>>;
  /** The cantrips and prepared spells chosen, per casting source. */
  readonly casting: readonly { readonly source: string; readonly cantrips: readonly string[]; readonly prepared: readonly string[] }[];
}

/** A map pick as the file has it: { asi: { str: 2 } } or { feat: <id> }. */
export interface AsiValue {
  readonly asi: Readonly<Record<string, number>> | null;
  readonly feat: string | null;
}

/** The first class, the species, the background and the list picks; null when the text isn't a readable kind: character. */
export function readCharacter(text: string): Read | null {
  const v = parseYaml(text, 'variant.yaml').doc?.value as Record<string, unknown> | null | undefined;
  if (!v || v.kind !== 'character' || !Array.isArray(v.classes)) return null;
  const c = v.classes[0] as Record<string, unknown> | undefined;
  if (!c || typeof c.class !== 'string' || typeof c.level !== 'number') return null;
  const picks: Record<string, readonly string[]> = {};
  const maps: Record<string, AsiValue> = {};
  const raw = v.picks;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, val] of Object.entries(raw as Record<string, unknown>)) {
      if (ids(val)) picks[k] = val;
      else if (val && typeof val === 'object' && !Array.isArray(val)) {
        const m = val as Record<string, unknown>;
        const asi = m.asi && typeof m.asi === 'object' && !Array.isArray(m.asi) && Object.values(m.asi).every((x) => typeof x === 'number') ? (m.asi as Record<string, number>) : null;
        maps[k] = { asi, feat: typeof m.feat === 'string' ? m.feat : null };
      }
    }
  }
  const casting: { source: string; cantrips: readonly string[]; prepared: readonly string[] }[] = [];
  if (Array.isArray(v.casting)) {
    for (const e of v.casting as unknown[]) {
      const m = e as Record<string, unknown> | null;
      if (m && typeof m === 'object' && typeof m.source === 'string') casting.push({ source: m.source, cantrips: ids(m.cantrips) ? m.cantrips : [], prepared: ids(m.prepared) ? m.prepared : [] });
    }
  }
  const str = (x: unknown): string => (typeof x === 'string' ? x : '');
  return { cls: c.class, level: c.level, subclass: str(c.subclass), species: str(v.species), background: str(v.background), picks, maps, casting };
}

const ids = (x: unknown): x is string[] => Array.isArray(x) && x.every((y) => typeof y === 'string');

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A YAML plain scalar where that's safe, else a quoted string. */
const scalar = (s: string): string => (/^[A-Za-z0-9][A-Za-z0-9 _:/#().'-]*$/.test(s) && !/:\s|\s#|:$/.test(s) ? s : JSON.stringify(s));
const flow = (ids: readonly string[]): string => `[${ids.map(scalar).join(', ')}]`;

/** A pick's one line: indent, key as written, a flow list or flow map, an optional trailing comment. */
const pickLine = (key: string): RegExp => new RegExp(`^([ \\t]+)(["']?)${esc(key)}\\2:[ \\t]*(\\[[^\\]\\n]*\\]|\\{[^#\\n]*\\})[ \\t]*(#[^\\n]*)?$`, 'm');

/**
 * A pick set to a flow value (`[a, b]` or `{ asi: { str: 2 } }`): its line rewritten, or a new
 * line added under `picks:`. Null when the pick is written some other way (over several lines) or
 * the text has no picks block: the YAML pane is the way to change it then.
 */
export function setPickValue(text: string, key: string, value: string): string | null {
  const re = pickLine(key);
  if (re.test(text)) return text.replace(re, (_m, indent: string) => `${indent}${key}: ${value}`);
  // Written some other way already: don't add a second key.
  if (new RegExp(`^[ \\t]+(["']?)${esc(key)}\\1:`, 'm').test(text)) return null;
  if (!/^picks:[ \t]*(#[^\n]*)?$/m.test(text)) return null;
  return text.replace(/^picks:[ \t]*(#[^\n]*)?$/m, (m) => `${m}\n  ${key}: ${value}`);
}

/** A list pick set to `ids` (setPickValue's rules). */
export const setPick = (text: string, key: string, ids: readonly string[]): string | null => setPickValue(text, key, flow(ids));

/**
 * A casting source's cantrips or prepared spells set to `ids`, when its entry is the one-line
 * `- { source: ..., cantrips: [...], prepared: [...] }` form; null otherwise.
 */
export function setCasting(text: string, source: string, field: 'cantrips' | 'prepared', ids: readonly string[]): string | null {
  const line = new RegExp(`^[ \\t]*-[ \\t]*\\{[^\\n]*\\bsource:[ \\t]*(["']?)${esc(source)}\\1[ \\t]*[,}][^\\n]*$`, 'm').exec(text)?.[0];
  if (line === undefined) return null;
  const has = new RegExp(`\\b${field}:[ \\t]*\\[[^\\]\\n]*\\]`);
  const next = has.test(line) ? line.replace(has, () => `${field}: ${flow(ids)}`) : line.replace(/[ \t]*\}([ \t]*(#.*)?)$/, (_m, tail: string) => `, ${field}: ${flow(ids)} }${tail}`);
  return next === line && !has.test(line) ? null : text.replace(line, () => next);
}

/** Every loaded spell: id, name and level (0 for a cantrip), by name. */
export function spellList(packs: readonly SourceFile[]): { readonly id: string; readonly name: string; readonly level: number }[] {
  const out: { id: string; name: string; level: number }[] = [];
  for (const f of packs) {
    if (!/^kind:[ \t]*spell[ \t]*$/m.test(f.text)) continue;
    const v = parseYaml(f.text, f.path).doc?.value as Record<string, unknown> | null | undefined;
    if (v && v.kind === 'spell' && typeof v.id === 'string' && typeof v.level === 'number') out.push({ id: v.id, name: typeof v.name === 'string' ? v.name : v.id, level: v.level });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1));
}

/** The first class's subclass set (or added); null when the classes line isn't the one-line form. */
export function setSubclass(text: string, sub: string): string | null {
  const line = /^classes:[ \t]*\[\{[^}\n]*\}[^\n]*$/m.exec(text)?.[0];
  if (line === undefined) return null;
  const next = /subclass:[ \t]*[^,}\s]+/.test(line) ? line.replace(/subclass:[ \t]*[^,}\s]+/, () => `subclass: ${sub}`) : line.replace(/[ \t]*\}/, () => `, subclass: ${sub} }`);
  return text.replace(line, () => next);
}

/** The content set with each variant's text added as a pack file (replacing a file already at its path). */
export function withVariants(set: ContentSet, variants: readonly Variant[]): ContentSet {
  if (variants.length === 0) return set;
  const files = variants.map(variantFile);
  const paths = new Set(files.map((f) => f.path));
  return { ...set, packs: [...set.packs.filter((f) => !paths.has(f.path)), ...files] };
}

export const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

/** What differs from the base, in words: the subclass and each list pick. */
export function differences(base: Read | null, cur: Read | null, needs: readonly Need[], nameFor: (id: string) => string): string[] {
  if (!base || !cur) return [];
  const out: string[] = [];
  if (base.subclass !== cur.subclass) out.push(`subclass: ${nameFor(base.subclass) || 'none'} to ${nameFor(cur.subclass) || 'none'}`);
  const keys = new Set([...Object.keys(base.picks), ...Object.keys(cur.picks)]);
  for (const k of [...keys].sort()) {
    const a = base.picks[k] ?? [];
    const b = cur.picks[k] ?? [];
    if (same(a, b)) continue;
    const n = needs.find((x) => x.key === k);
    const show = (ids: readonly string[]) => (ids.length === 0 ? 'none' : ids.map((id) => n?.options.find((o) => o.id === id)?.name ?? id).join(', '));
    out.push(`${n ? n.where : k}: ${show(a)} to ${show(b)}`);
  }
  for (const k of [...new Set([...Object.keys(base.maps), ...Object.keys(cur.maps)])].sort()) {
    const a = JSON.stringify(base.maps[k] ?? null);
    const b = JSON.stringify(cur.maps[k] ?? null);
    if (a !== b) out.push(`${needs.find((x) => x.key === k)?.where ?? k}: ${asiText(base.maps[k])} to ${asiText(cur.maps[k])}`);
  }
  for (const c of cur.casting) {
    const b0 = base.casting.find((x) => x.source === c.source);
    for (const f of ['cantrips', 'prepared'] as const) {
      const was = b0?.[f] ?? [];
      const gone = was.filter((x) => !c[f].includes(x));
      const added = c[f].filter((x) => !was.includes(x));
      if (gone.length + added.length > 0) out.push(`${f === 'cantrips' ? 'cantrips' : 'prepared spells'}: ${[gone.length > 0 ? `dropped ${gone.map(nameFor).join(', ')}` : '', added.length > 0 ? `added ${added.map(nameFor).join(', ')}` : ''].filter((x) => x !== '').join(', ')}`);
    }
  }
  return out;
}

/** A map pick in words: "+2 STR", "+1 DEX, +1 CON", or the feat's id. */
export function asiText(v: AsiValue | undefined): string {
  if (!v) return 'none';
  if (v.feat !== null) return v.feat;
  if (v.asi === null) return 'none';
  return Object.entries(v.asi).map(([a, n]) => `+${n} ${a.toUpperCase()}`).join(', ') || 'none';
}

/** A map pick as the pick form holds it; `bg` for a background's increases (+2 and +1, or +1 to all three). */
export function asiPick(v: AsiValue | undefined, bg: boolean): AsiPick {
  const none: AsiPick = { mode: 'two', a: '', b: '', feat: '' };
  if (!v) return none;
  if (v.feat !== null) return { ...none, mode: 'feat', feat: v.feat };
  const e = Object.entries(v.asi ?? {});
  const two = e.find(([, n]) => n === 2)?.[0];
  const ones = e.filter(([, n]) => n === 1).map(([a]) => a);
  if (bg) return two !== undefined ? { ...none, a: two, b: ones[0] ?? '' } : ones.length >= 3 ? { ...none, mode: 'all' } : none;
  if (two !== undefined) return { ...none, a: two };
  return ones.length >= 2 ? { ...none, mode: 'oneone', a: ones[0]!, b: ones[1]! } : none;
}

/**
 * The final ability scores moved from one increase to another: a character file states its scores
 * with every increase already in, so swapping an Ability Score Improvement means taking the old
 * one out of the scores and putting the new one in. Null when the abilities line isn't the
 * one-line `abilities: { str: 15, ... }` form.
 */
export function shiftAbilities(text: string, from: AsiValue | undefined, to: AsiValue | undefined): string | null {
  const line = /^abilities:[ \t]*\{[^}\n]*\}[ \t]*(#[^\n]*)?$/m.exec(text)?.[0];
  if (line === undefined) return null;
  const delta: Record<string, number> = {};
  for (const [a, n] of Object.entries(from?.asi ?? {})) delta[a] = (delta[a] ?? 0) - n;
  for (const [a, n] of Object.entries(to?.asi ?? {})) delta[a] = (delta[a] ?? 0) + n;
  let next = line;
  for (const [a, d] of Object.entries(delta)) {
    if (d === 0) continue;
    const re = new RegExp(`\\b${a}:[ \\t]*(\\d+)`);
    if (!re.test(next)) return null;
    next = next.replace(re, (_m, v: string) => `${a}: ${Number(v) + d}`);
  }
  return text.replace(line, () => next);
}

/** A map pick's value as data, from the YAML the pick form writes ("{ asi: { str: 2 } }", "{ feat: srd:x }"). */
export function asiValue(yaml: string): AsiValue | undefined {
  const v = parseYaml(`x: ${yaml}\n`, 'pick.yaml').doc?.value as { x?: Record<string, unknown> } | null | undefined;
  const m = v?.x;
  if (!m || typeof m !== 'object') return undefined;
  return { asi: m.asi && typeof m.asi === 'object' ? (m.asi as Record<string, number>) : null, feat: typeof m.feat === 'string' ? m.feat : null };
}
