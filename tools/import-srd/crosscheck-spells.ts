// The spell cross-check (M3 step 6, docs/design/m3.md C7, 4.2): for each of the 339 PDF spells,
// the PDF's stat lines and description tokens (srd-index.json spellDetails) against Foundry's
// record (the header fields C7 names) and against 5e-bits' 2024 Spells.json as a vote (level,
// school, concentration, ritual, range, components, duration, first damage dice and type).
// Open5e is a third vote when its data is in the cache (crosscheck-open5e.ts). The PDF decides;
// a vote never wins and never changes an emitted item. Foundry header disagreements keep a spell
// from being full (map/spell.ts pdfHeaderAgrees); vote disagreements are recorded only.
//
// Everything written is a machine token: an id, a field name, and values already normalized to
// the same tokens on every side ("feet:120", "minute:1", "VSM", "8d6 fire"). A vote's text that
// doesn't parse is recorded as the token "unparsed", never copied. 5e-bits has no save-ability
// field at the pin (its 2024 spells carry no dc), so save abilities are compared against Foundry only.

import { normName } from './filter.ts';
import { foundryHeader, pdfHeader, type FoundryHeader } from './map/spell.ts';
import type { SrdIndex } from './pdf/build.ts';
import { parseCastingTime, parseComponents, parseDuration, parseRange, type SpellDetail } from './pdf/spell-details.ts';
import type { FoundryRecord } from './read.ts';
import { identOf } from './ids.ts';
import { byString, getPath, isRecord } from './util.ts';

export const SPELL_FIELDS = ['castingTime', 'components', 'concentration', 'damage', 'duration', 'level', 'range', 'ritual', 'save', 'school'] as const;
export type SpellField = (typeof SPELL_FIELDS)[number];

export interface SpellRow {
  readonly spell: string;
  readonly field: SpellField;
  readonly pdf: string;
  /** Present when that source was compared on this field. */
  readonly foundry?: string;
  readonly bits?: string;
  readonly open5e?: string;
  /** The sources that differ from the PDF, joined with '+' (foundry, bits, open5e). */
  readonly against: string;
}

export interface SourceTally {
  /** Spells the source has a record for. */
  spells: number;
  /** (spell, field) pairs compared. */
  compared: number;
  agree: number;
}

export interface SpellReview {
  readonly spells: number;
  readonly foundry: SourceTally;
  readonly bits: SourceTally | { readonly available: false };
  readonly open5e: SourceTally | { readonly available: false };
  readonly byPattern: Record<string, number>;
  readonly disagreements: SpellRow[];
}

/** One source's tokens for a spell (any field may be absent: not compared). */
export type SpellTokens = Partial<Record<SpellField, string>>;

const SCHOOL = (s: string): string => s.toLowerCase();

/**
 * Every value written to review.json is a short machine token. A source value that isn't one
 * (Foundry's durations and ranges can be roll formulas, "@item.level * 48 - 72") is written as
 * the token "formula", never copied.
 */
export function asToken(v: string): string {
  return /^[a-z0-9]+(?::[0-9]+)?$|^[0-9]+d[0-9]+(?:\+[0-9]+)? [a-z]+$|^[VSM-]{3}$|^(?:true|false|none|unparsed)$/i.test(v) ? v : 'formula';
}
export const spellReviewId = (name: string): string => `srd:${identOf({}, normName(name))}`;

/** The PDF's tokens for a spell. */
export function pdfTokens(level: number, school: string, d: SpellDetail): SpellTokens {
  const h = pdfHeader(level, d.stat);
  const dmg = d.facts.damage[0];
  return {
    level: String(h.level),
    school: SCHOOL(school),
    castingTime: h.castingTime,
    range: h.range,
    components: h.components,
    duration: h.duration,
    concentration: String(h.concentration),
    ritual: String(h.ritual),
    damage: dmg ? `${dmg.dice.replace(/\s+/g, '')} ${dmg.type}` : 'none',
    save: d.facts.saves[0] ?? 'none',
  };
}

const FOUNDRY_SCHOOLS: Readonly<Record<string, string>> = { abj: 'abjuration', con: 'conjuration', div: 'divination', enc: 'enchantment', evo: 'evocation', ill: 'illusion', nec: 'necromancy', trs: 'transmutation' };

/** Foundry's tokens: the C7 header fields plus school and the first save activity's ability. */
export function foundryTokens(doc: Readonly<Record<string, unknown>>): SpellTokens {
  const h: FoundryHeader = foundryHeader(doc);
  const acts = getPath(doc, 'system.activities');
  let save = 'none';
  if (isRecord(acts)) {
    for (const k of Object.keys(acts).sort(byString)) {
      const a = acts[k];
      if (!isRecord(a) || a.type !== 'save') continue;
      const ab = getPath(a, 'save.ability');
      const first = Array.isArray(ab) ? ab[0] : ab;
      if (typeof first === 'string' && first !== '') {
        save = first;
        break;
      }
    }
  }
  const school = getPath(doc, 'system.school');
  return {
    level: String(h.level),
    school: typeof school === 'string' ? (FOUNDRY_SCHOOLS[school] ?? 'unparsed') : 'unparsed',
    castingTime: h.castingTime,
    range: h.range,
    components: h.components,
    duration: h.duration,
    concentration: String(h.concentration),
    ritual: String(h.ritual),
    save,
  };
}

/** 5e-bits' tokens for one Spells.json entry (its strings parsed with the PDF's own parsers). */
export function bitsTokens(e: Readonly<Record<string, unknown>>): SpellTokens {
  const tok = <T>(f: () => T, show: (v: T) => string): string => {
    try {
      return show(f());
    } catch {
      return 'unparsed';
    }
  };
  const ct = typeof e.casting_time === 'string' ? e.casting_time : '';
  const comps = Array.isArray(e.components) ? e.components.filter((c): c is string => typeof c === 'string') : [];
  const dur = typeof e.duration === 'string' ? e.duration : '';
  const conc = e.concentration === true;
  const lvl = typeof e.level === 'number' ? e.level : -1;
  const school = getPath(e, 'school.index');
  const dType = getPath(e, 'damage.damage_type.index');
  const atSlot = getPath(e, 'damage.damage_at_slot_level');
  const atChar = getPath(e, 'damage.damage_at_character_level');
  const table = isRecord(atSlot) ? atSlot : isRecord(atChar) ? atChar : undefined;
  const lowest = table ? Object.keys(table).map(Number).filter(Number.isInteger).sort((a, b) => a - b)[0] : undefined;
  const dice = lowest !== undefined ? table![String(lowest)] : undefined;
  return {
    level: String(lvl),
    school: typeof school === 'string' ? school : 'unparsed',
    castingTime: tok(
      () => parseCastingTime(ct.replace(/,.*$/, '').replace(/ \(.*$/, '')),
      (v) => (v.castingTime.unit === 'action' || v.castingTime.unit === 'bonus' || v.castingTime.unit === 'reaction' ? v.castingTime.unit : `${v.castingTime.unit}:${v.castingTime.n}`),
    ),
    range: tok(
      () => parseRange(typeof e.range === 'string' ? e.range : ''),
      (r) => (r.unit === 'feet' ? `feet:${r.n}` : r.unit === 'miles' ? `miles:${r.n}` : r.unit === 'unlimited' ? 'any' : r.unit === 'special' ? 'spec' : r.unit),
    ),
    components: tok(
      () => parseComponents(comps.join(', ')),
      (c) => `${c.v ? 'V' : '-'}${c.s ? 'S' : '-'}${c.m ? 'M' : '-'}`,
    ),
    duration: tok(
      () => parseDuration(dur.replace(/^up to /i, '')).duration,
      (d) => (d.unit === 'instant' || d.unit === 'dispelled' || d.unit === 'special' ? d.unit : `${d.unit}:${d.n}`),
    ),
    concentration: String(conc),
    ritual: String(e.ritual === true),
    damage: typeof dType === 'string' && typeof dice === 'string' ? `${dice.replace(/\s+/g, '')} ${dType}` : 'none',
  };
}

/** Which fields each source is compared on. */
const FOUNDRY_FIELDS: readonly SpellField[] = ['castingTime', 'components', 'concentration', 'duration', 'level', 'range', 'ritual', 'save', 'school'];
const BITS_FIELDS: readonly SpellField[] = ['castingTime', 'components', 'concentration', 'damage', 'duration', 'level', 'range', 'ritual', 'school'];

export interface SpellCrossInput {
  readonly pdf: SrdIndex;
  /** Kept (gate-passing) Foundry spell records. */
  readonly foundry: readonly FoundryRecord[];
  /** 5e-bits Spells.json entries, or undefined when not loaded. */
  readonly bits?: readonly Readonly<Record<string, unknown>>[] | undefined;
  /** Open5e's tokens by spell name (crosscheck-open5e.ts), or undefined when not available. */
  readonly open5e?: ReadonlyMap<string, SpellTokens> | undefined;
}

export function crosscheckSpells(x: SpellCrossInput): SpellReview {
  const details = new Map((x.pdf.spellDetails ?? []).map((d) => [normName(d.name), d]));
  const fBy = new Map(x.foundry.map((r) => [normName(r.name), r]));
  const bBy = new Map((x.bits ?? []).filter((e) => typeof e.name === 'string').map((e) => [normName(e.name as string), e]));
  const oBy = x.open5e ? new Map([...x.open5e].map(([n, t]) => [normName(n), t])) : undefined;
  const tf: SourceTally = { spells: 0, compared: 0, agree: 0 };
  const tb: SourceTally = { spells: 0, compared: 0, agree: 0 };
  const to: SourceTally = { spells: 0, compared: 0, agree: 0 };
  const rows: SpellRow[] = [];
  const byPattern: Record<string, number> = {};
  for (const h of [...x.pdf.spells].sort((a, b) => byString(a.name, b.name))) {
    const d = details.get(normName(h.name));
    if (!d) continue;
    const p = pdfTokens(h.level, h.school, d);
    const fr = fBy.get(normName(h.name));
    const f = fr ? foundryTokens(fr.doc) : undefined;
    const be = bBy.get(normName(h.name));
    const b = be ? bitsTokens(be) : undefined;
    const o = oBy?.get(normName(h.name));
    if (f) tf.spells++;
    if (b) tb.spells++;
    if (o) to.spells++;
    const clean = (t: SpellTokens | undefined): SpellTokens | undefined => (t ? Object.fromEntries(Object.entries(t).map(([k, v]) => [k, asToken(v!)])) : undefined);
    const [fc, bc, oc] = [clean(f), clean(b), clean(o)];
    for (const field of SPELL_FIELDS) {
      const row: { spell: string; field: SpellField; pdf: string; foundry?: string; bits?: string; open5e?: string } = { spell: spellReviewId(h.name), field, pdf: p[field]! };
      const against: string[] = [];
      if (fc && FOUNDRY_FIELDS.includes(field)) {
        tf.compared++;
        if (fc[field] === p[field]) tf.agree++;
        else against.push('foundry');
        row.foundry = fc[field]!;
      }
      if (bc && BITS_FIELDS.includes(field)) {
        tb.compared++;
        if (bc[field] === p[field]) tb.agree++;
        else against.push('bits');
        row.bits = bc[field]!;
      }
      if (oc && oc[field] !== undefined) {
        to.compared++;
        if (oc[field] === p[field]) to.agree++;
        else against.push('open5e');
        row.open5e = oc[field]!;
      }
      if (against.length) {
        const k = against.join('+');
        byPattern[k] = (byPattern[k] ?? 0) + 1;
        rows.push({ ...row, against: k });
      }
    }
  }
  rows.sort((a, b) => byString(a.spell, b.spell) || byString(a.field, b.field));
  return {
    spells: details.size,
    foundry: tf,
    bits: x.bits ? tb : { available: false },
    open5e: x.open5e ? to : { available: false },
    byPattern,
    disagreements: rows,
  };
}

/** The import summary's lines for the spell cross-check. */
export function spellReviewSummary(r: SpellReview): string[] {
  const t = (s: SourceTally | { available: false }, name: string) => ('available' in s ? `${name} not available` : `${name} ${s.agree}/${s.compared} agree over ${s.spells} spells`);
  const lines = [`spells vs PDF: ${r.spells} spells; ${t(r.foundry, 'foundry')}; ${t(r.bits, '5e-bits')}; ${t(r.open5e, 'open5e')}`];
  for (const k of Object.keys(r.byPattern).sort(byString)) lines.push(`  differs from the PDF: ${k}: ${r.byPattern[k]} field(s)`);
  return lines;
}
