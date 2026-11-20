// The quick encounter: a fight described by a few picks (who you play, an optional ally, up to
// three groups of foes) instead of a scenario file. It becomes an ordinary scenario text that the
// app adds to its content set, so the Run tab and Practice both see it. JSON is YAML, so the
// text needs no writer.

import { cellName, type Content } from '@montecrit/engine';
import type { SourceFile } from '@montecrit/engine';

export const QUICK_PATH = 'quick/encounter.yaml';
export const QUICK_ID = 'quick-encounter';

export interface FoeGroup {
  readonly use: string;
  readonly count: number;
}

export interface StartResources {
  readonly slots?: readonly number[];
  readonly pools?: Readonly<Record<string, number>>;
}

export interface Encounter {
  /** A loaded character's id. */
  readonly pc: string;
  /** A stat block fighting beside the PC, or ''. */
  readonly ally: string;
  readonly foes: readonly FoeGroup[];
  readonly surprised: boolean;
  /** The character's starting hit points when a scene hands the fight over; absent: full. */
  readonly hp?: number;
  /** Its starting spell slots (level 1 first) and pool uses (by pool id); absent: full. */
  readonly resources?: StartResources;
  /** The character starts Prone. */
  readonly prone?: boolean;
  /** A spell the character already has running (a scene's concentration). */
  readonly precast?: StartSpell;
}

export interface StartSpell {
  readonly cast: string;
  /** The slot level it was cast with; absent for a cantrip. */
  readonly level?: number;
  /** It targets the caster. */
  readonly self: boolean;
  /** Rounds since it was cast. */
  readonly elapsed: number;
}

const W = 12;
const H = 12;
export const MAX_FOES = 12;

/** Foe squares, front row first: spread across the top third, centered. */
function foeCells(n: number): number[] {
  const rows = [3, 1, 2, 0];
  const cols = [5, 6, 3, 8, 1, 10, 4, 7, 2, 9, 0, 11];
  const out: number[] = [];
  for (const y of rows) {
    for (const x of cols) {
      if (out.length >= n) return out;
      if ((x + y) % 2 === 0 || n > 24) out.push(y * W + x);
    }
  }
  return out;
}

const namespace = (id: string) => id.slice(0, id.indexOf(':'));

export interface BuiltEncounter {
  readonly file: SourceFile | null;
  readonly errors: readonly string[];
}

/** A fight as the Encounter check describes it: a whole party against groups of foes. */
export interface Fight {
  /** Party members' ids, loaded characters or stat blocks; '' entries are skipped. */
  readonly party: readonly string[];
  readonly foes: readonly FoeGroup[];
  readonly surprised: boolean;
  /** Starting hit points of the first party member; absent: full. */
  readonly hp?: number;
  /** Its starting slots and pool uses; absent: full. */
  readonly resources?: StartResources;
  /** The first party member starts Prone, or with a spell running. */
  readonly prone?: boolean;
  readonly precast?: StartSpell;
}

export const MAX_PARTY = 6;
export const CHECK_PATH = 'quick/fight-check.yaml';
export const CHECK_ID = 'fight-check';

/** Party squares, in pick order: two staggered rows at the bottom, centered. */
const PARTY_CELLS: readonly number[] = [9 * W + 5, 8 * W + 6, 9 * W + 7, 8 * W + 4, 9 * W + 3, 8 * W + 8];

/** Starting resources the engine will take: slots capped at the template's, and only pools it has. */
function startResources(r: StartResources, tpl: { readonly resMax: readonly number[]; readonly pools: readonly { readonly local: string }[] }): { slots: number[]; pools: Record<string, number> } {
  const slots = (r.slots ?? []).slice(0, 9).map((n, k) => Math.max(0, Math.min(Math.trunc(n), tpl.resMax[k] ?? 0)));
  const pools: Record<string, number> = {};
  tpl.pools.forEach((p, k) => {
    const n = r.pools?.[p.local];
    if (n !== undefined) pools[p.local] = Math.max(0, Math.min(Math.trunc(n), tpl.resMax[9 + k] ?? 0));
  });
  return { slots, pools };
}

/** The scenario text for a party against foe groups, or why it can't be built. */
export function fightFile(f: Fight, content: Content | null, path: string, id: string, label: string): BuiltEncounter {
  if (!content) return { file: null, errors: ['content has errors'] };
  const errors: string[] = [];
  const known = (x: string) => content.get(x) !== undefined;
  const party = f.party.filter((x) => x !== '');
  if (party.length === 0) errors.push('pick a character');
  if (party.length > MAX_PARTY) errors.push(`at most ${MAX_PARTY} in the party`);
  for (const x of party) if (!known(x)) errors.push(`${x} isn't loaded`);
  const foes = f.foes.filter((g) => g.use !== '' && g.count > 0);
  if (foes.length === 0) errors.push('add at least one foe');
  for (const g of foes) if (!known(g.use)) errors.push(`${g.use} isn't loaded`);
  const total = foes.reduce((n, g) => n + g.count, 0);
  if (total > MAX_FOES) errors.push(`at most ${MAX_FOES} foes fit this map (${total} picked)`);
  if (errors.length) return { file: null, errors };

  const units: Record<string, unknown>[] = [];
  let pcs = 0;
  let allies = 0;
  party.forEach((use, i) => {
    const isPc = content.get(use)!.kind === 'pc';
    units.push({ seat: isPc ? `pc${++pcs}` : `ally${++allies}`, team: 'party', use, at: cellName(PARTY_CELLS[i]!, W), ...(f.surprised ? { surprised: true } : {}), ...(i === 0 && f.hp !== undefined ? { hp: Math.max(1, Math.min(f.hp, content.get(use)!.hpMax)) } : {}), ...(i === 0 && f.resources ? { resources: startResources(f.resources, content.get(use)!) } : {}), ...(i === 0 && f.prone ? { prone: true } : {}), ...(i === 0 && f.precast ? { precast: [{ cast: f.precast.cast, ...(f.precast.level !== undefined ? { level: f.precast.level } : {}), ...(f.precast.self ? { target: 'pc1' } : {}), elapsed: f.precast.elapsed, seenBy: 'none' }] } : {}), decider: 'greedy' });
  });
  const cells = foeCells(total);
  let k = 0;
  // Seats are a short prefix of the stat block's id plus a running number: gobli1, gobli2, knigh1.
  const seen = new Map<string, number>();
  for (const g of foes) {
    const prefix = g.use.slice(g.use.indexOf(':') + 1).replace(/[^a-z]/g, '').slice(0, 5) || 'foe';
    for (let j = 0; j < g.count; j++) {
      const n = (seen.get(prefix) ?? 0) + 1;
      seen.set(prefix, n);
      units.push({ seat: `${prefix}${n}`, team: 'enemies', use: g.use, at: cellName(cells[k++]!, W), decider: 'greedy' });
    }
  }
  const used = new Set(units.map((u) => namespace(u.use as string)));
  const packs = content.packs.filter((p) => used.has(p.namespace)).map((p) => p.pack);
  const name = `${foes.map((g) => `${g.count} x ${content.get(g.use)!.name}`).join(' + ')}`;
  // With no PC in the party (stat blocks only), the party loses when every member is down.
  const doc = { kind: 'scenario', id, name: `${label}: ${name}`, rules: '2024', packs, grid: { w: W, h: H }, knobs: { downEnds: false, lossCounts: pcs > 0 ? 'pcs' : 'party', maxRounds: 20 }, units };
  return { file: { path, text: JSON.stringify(doc, null, 2) }, errors: [] };
}

/** The scenario text for a quick encounter (one character, an optional ally), or why it can't be built. */
export function encounterFile(e: Encounter, content: Content | null): BuiltEncounter {
  const built = fightFile({ party: [e.pc, e.ally], foes: e.foes, surprised: e.surprised, ...(e.hp !== undefined ? { hp: e.hp } : {}), ...(e.resources ? { resources: e.resources } : {}), ...(e.prone ? { prone: true } : {}), ...(e.precast ? { precast: e.precast } : {}) }, content, QUICK_PATH, QUICK_ID, 'Quick encounter');
  // Practice needs a character to play: an ally alone isn't a quick encounter.
  return content && e.pc === '' ? { file: null, errors: ['pick a character', ...built.errors.filter((x) => x !== 'pick a character')] } : built;
}

/** Stat blocks a quick encounter can use: everything loaded that isn't a PC, by name. */
export function statBlocks(content: Content | null): { readonly id: string; readonly name: string }[] {
  if (!content) return [];
  return content.templates
    .filter((t) => t.kind !== 'pc')
    .map((t) => ({ id: t.id, name: t.name }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1));
}
