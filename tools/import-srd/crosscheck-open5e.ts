// Open5e as a vote on spells and monsters (docs/design/m3.md 4.2 crosscheck-open5e.ts, C7;
// M3 step 6). Open5e's spell and creature data is not in the import cache at the pin (only its
// 12 class responses are, for the class-table check), and the importer has no network, so this
// runs only when the files are there:
//
//   <cache>/open5e/spells.json     Open5e v2 spells for the srd-2024 document
//   <cache>/open5e/monsters.json   Open5e v2 creatures for the srd-2024 document
//
// A file is read only when tools/import-srd/pins.json pins it by sha256 (open5e.files), so an
// unpinned download is never trusted; with no file, or no pin, the vote is "not available" and
// the import logs that and carries on. The PDF decides either way; a vote never changes an item.
//
// The v2 field names below are Open5e's documented ones as best known, not checked against a
// live response at the pin [U]: name, level, school (string or {name}), casting_time,
// range_text (or range), verbal, somatic, material, concentration, ritual, duration,
// damage_roll, damage_types[], saving_throw_ability; creatures: name, armor_class, hit_points,
// challenge_rating_decimal (or challenge_rating). A record missing a field is compared on the
// rest. Both a bare list and a paged { results: [...] } body are accepted. Values become the
// same machine tokens as crosscheck-spells.ts; text that doesn't parse is the token "unparsed".

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normName } from './filter.ts';
import type { SpellTokens } from './crosscheck-spells.ts';
import { parseCastingTime, parseDuration, parseRange } from './pdf/spell-details.ts';
import type { Pins } from './pins.ts';
import { byString, getPath, isRecord, sha256 } from './util.ts';

export const OPEN5E_SPELLS = 'spells.json';
export const OPEN5E_MONSTERS = 'monsters.json';

export type Open5eLoad<T> = { readonly available: true; readonly data: T } | { readonly available: false; readonly why: 'no-file' | 'no-pin' };

/** Reads one optional Open5e file: absent or unpinned is "not available"; present, pinned and changed fails closed. */
export function readOpen5e(dir: string, name: string, pins: Pins): Open5eLoad<unknown[]> {
  const abs = join(dir, name);
  if (!existsSync(abs)) return { available: false, why: 'no-file' };
  const pin = pins.open5e.files[name];
  if (!pin) return { available: false, why: 'no-pin' };
  const bytes = readFileSync(abs);
  if (sha256(bytes) !== pin.sha256) throw new Error(`${abs} does not match its pin; fail closed (rerun fetch.ts)`);
  const j = JSON.parse(bytes.toString('utf8')) as unknown;
  const list = Array.isArray(j) ? j : isRecord(j) && Array.isArray(j.results) ? j.results : undefined;
  if (!list) throw new Error(`${abs}: expected a list or { results: [...] }`);
  return { available: true, data: list };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const ABILITY: Readonly<Record<string, string>> = { strength: 'str', dexterity: 'dex', constitution: 'con', intelligence: 'int', wisdom: 'wis', charisma: 'cha' };

/** Open5e's tokens for one spell record (fields it lacks are left out, so they aren't compared). */
export function open5eSpellTokens(e: Readonly<Record<string, unknown>>): SpellTokens {
  const out: SpellTokens = {};
  const tok = (f: () => string): string => {
    try {
      return f();
    } catch {
      return 'unparsed';
    }
  };
  if (typeof e.level === 'number') out.level = String(e.level);
  const school = str(e.school) ?? str(getPath(e, 'school.name')) ?? str(getPath(e, 'school.key'));
  if (school) out.school = school.toLowerCase();
  const ct = str(e.casting_time);
  if (ct) {
    // Open5e writes "action", "bonus_action", "reaction", "1minute"-style keys or words [U]: both are tried.
    const words = ct.replace(/_/g, ' ').replace(/^(\d+)(minute|minutes|hour|hours)$/, '$1 $2');
    out.castingTime = tok(() => {
      const w = words.replace(/^action$/i, 'Action').replace(/^bonus action$/i, 'Bonus Action').replace(/^reaction$/i, 'Reaction');
      const c = parseCastingTime(w).castingTime;
      return c.unit === 'action' || c.unit === 'bonus' || c.unit === 'reaction' ? c.unit : `${c.unit}:${c.n}`;
    });
  }
  const rt = str(e.range_text) ?? str(e.range);
  if (rt) {
    out.range = tok(() => {
      const r = parseRange(rt.replace(/^self$/i, 'Self').replace(/^touch$/i, 'Touch'));
      return r.unit === 'feet' ? `feet:${r.n}` : r.unit === 'miles' ? `miles:${r.n}` : r.unit === 'unlimited' ? 'any' : r.unit === 'special' ? 'spec' : r.unit;
    });
  }
  if (typeof e.verbal === 'boolean' && typeof e.somatic === 'boolean' && typeof e.material === 'boolean') out.components = `${e.verbal ? 'V' : '-'}${e.somatic ? 'S' : '-'}${e.material ? 'M' : '-'}`;
  const dur = str(e.duration);
  if (dur) {
    out.duration = tok(() => {
      const d = parseDuration(dur.replace(/^instantaneous$/i, 'Instantaneous').replace(/^up to /i, '')).duration;
      return d.unit === 'instant' || d.unit === 'dispelled' || d.unit === 'special' ? d.unit : `${d.unit}:${d.n}`;
    });
  }
  if (typeof e.concentration === 'boolean') out.concentration = String(e.concentration);
  if (typeof e.ritual === 'boolean') out.ritual = String(e.ritual);
  const roll = str(e.damage_roll);
  const types = Array.isArray(e.damage_types) ? e.damage_types.filter((t): t is string => typeof t === 'string') : [];
  if (roll !== undefined) out.damage = roll && types[0] ? `${roll.replace(/\s+/g, '')} ${types[0].toLowerCase()}` : 'none';
  const sv = str(e.saving_throw_ability);
  if (sv !== undefined) out.save = sv === '' ? 'none' : (ABILITY[sv.toLowerCase()] ?? sv.toLowerCase().slice(0, 3));
  return out;
}

/** Open5e spell tokens by name, from a loaded spells.json. */
export function open5eSpells(list: readonly unknown[]): Map<string, SpellTokens> {
  const out = new Map<string, SpellTokens>();
  for (const e of list) if (isRecord(e) && typeof e.name === 'string') out.set(e.name, open5eSpellTokens(e));
  return out;
}

// ---- monsters ------------------------------------------------------------------------

export interface MonsterTokens {
  readonly ac?: string;
  readonly hp?: string;
  readonly cr?: string;
}

/** Open5e's tokens for one creature record. */
export function open5eMonsterTokens(e: Readonly<Record<string, unknown>>): MonsterTokens {
  const out: { ac?: string; hp?: string; cr?: string } = {};
  if (typeof e.armor_class === 'number') out.ac = String(e.armor_class);
  if (typeof e.hit_points === 'number') out.hp = String(e.hit_points);
  const cr = e.challenge_rating_decimal ?? e.challenge_rating;
  if (typeof cr === 'number' || typeof cr === 'string') out.cr = String(Number(cr));
  return out;
}

export interface MonsterRow {
  readonly monster: string;
  readonly field: 'ac' | 'cr' | 'hp';
  readonly ours: string;
  readonly open5e: string;
}

/**
 * Our monsters (id, name, AC, HP, CR as numbers) against Open5e's creatures, by name. For the
 * monster mapper to call with what it emits; rows only for disagreements, sorted.
 */
export function crosscheckMonsters(ours: readonly { id: string; name: string; ac: number; hp: number; cr: number }[], list: readonly unknown[]): { compared: number; agree: number; missing: number; disagreements: MonsterRow[] } {
  const by = new Map<string, MonsterTokens>();
  for (const e of list) if (isRecord(e) && typeof e.name === 'string') by.set(normName(e.name), open5eMonsterTokens(e));
  let compared = 0;
  let agree = 0;
  let missing = 0;
  const rows: MonsterRow[] = [];
  for (const m of [...ours].sort((a, b) => byString(a.id, b.id))) {
    const t = by.get(normName(m.name));
    if (!t) {
      missing++;
      continue;
    }
    for (const [field, mine] of [
      ['ac', String(m.ac)],
      ['cr', String(m.cr)],
      ['hp', String(m.hp)],
    ] as const) {
      const theirs = t[field];
      if (theirs === undefined) continue;
      compared++;
      if (theirs === mine) agree++;
      else rows.push({ monster: m.id, field, ours: mine, open5e: theirs });
    }
  }
  return { compared, agree, missing, disagreements: rows };
}

/** The import's log line for an Open5e vote that didn't run. */
export const notAvailable = (what: 'spells' | 'monsters', why: 'no-file' | 'no-pin'): string =>
  `open5e ${what}: not available (${why === 'no-file' ? `no ${what === 'spells' ? OPEN5E_SPELLS : OPEN5E_MONSTERS} in the import cache` : 'the cached file has no pin in pins.json'}); the PDF and the other votes stand`;
