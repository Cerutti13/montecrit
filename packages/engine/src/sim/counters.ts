// Per-fight counters for the Monte Carlo reducers (docs/design/m1c.md 3.6, M1b critique #25).
// Integers in typed arrays, laid out once per setup and written at the resolution sites, so a
// run with no event sink counts exactly what a logged run would. They're derived data, so
// stateHash leaves them out.
//
// A damage source is (owner, via id, opportunity attack or not). Every via a damage event can
// carry is an id in the owner's template: a weapon or the Unarmed Strike, a spell (its attacks
// and damage steps), or an effect template (zones, grants such as a hurled flame). Anything
// else lands in the owner's "other" source, which tests keep empty.
//
// Pick families group a turn's chosen options: pass, move, stand, item, end, then one per core
// option, attack, spell entry, feature, and effect grant (effect index * 4 + grant), then the
// core Dodge action. M3 step 5a appends, after Dodge and only for units that have them (so no
// existing layout moves): one family per further activation of a multi-activation feature
// (Monk's Focus: Patient Defense, Step of the Wind, ...; the first activation keeps the feature's
// family), one per rider option (Stunning Strike; Open Hand Technique: Addle/Push/Topple), and
// one per hitTaken reaction (Deflect Attacks; M3 step 8'a: or hitKnown, damageTaken). Rider and reaction uses aren't turn options, so
// they sit past `turnN`.

import type { CompiledTemplate } from '../content/types.ts';
import type { Legal } from '../decide/decider.ts';
import { FX_END_WHYS, type ConcEndWhy } from '../log/events.ts';
import type { FightSetup } from './setup.ts';

export const MAX_POOLS = 8;
const GRANTS_PER_EFFECT = 4;
const FIXED_FAMILIES = 5; // pass, move, stand, item, end

export interface CounterSource {
  readonly owner: number;
  readonly via: string;
  readonly oa: boolean;
}

export interface CounterLayout {
  readonly setup: FightSetup;
  readonly units: number;
  /** Round slots: 0 (before initiative) through maxRounds. */
  readonly rounds: number;
  readonly sources: readonly CounterSource[];
  /** Per unit: its via ids sorted with <, the source for each, the opportunity-attack source (or -1), and its "other" source. */
  readonly vias: readonly (readonly string[])[];
  readonly act: readonly Int32Array[];
  readonly oaSrc: readonly Int32Array[];
  readonly other: Int32Array;
  /** Per unit: first pick family and the offsets of each kind within it. */
  readonly pickBase: Int32Array;
  readonly pickN: Int32Array;
  readonly optOff: Int32Array;
  readonly atkOff: Int32Array;
  readonly castOff: Int32Array;
  readonly featOff: Int32Array;
  readonly grantOff: Int32Array;
  /** Per unit: the core Dodge action's family. */
  readonly dodgeOff: Int32Array;
  /** Coverage step 9: the core Search action's family, right after Dodge, only when some template has a hidden zone (-1 otherwise, so no other layout moves). */
  readonly searchOff: Int32Array;
  /** Per unit: the turn-option families (through Dodge and the further activations); rider and reaction families follow. */
  readonly turnN: Int32Array;
  /** Per unit: first family of each feature's further activations (-1 when it has none). */
  readonly moreOff: readonly Int32Array[];
  /** Per unit: first family of each rider's options. */
  readonly riderOff: readonly Int32Array[];
  /** Per unit: the family of each feature's hitTaken, hitKnown or damageTaken reaction (-1 when it has none). */
  readonly reactOff: readonly Int32Array[];
  /**
   * Per unit: the family of an option another creature's effect grants its bearer (an Escape, coverage
   * step 7.3), after every other family; -1 when no template in the fight has such a grant, so a
   * fight without one has the layout it always had.
   */
  readonly foreignOff: Int32Array;
  readonly picks: number;
}

export interface Counters {
  readonly layout: CounterLayout;
  /** [round * S + source]: HP and temp HP removed (overkill clamped). */
  readonly dmgEff: Int32Array;
  /** [round * S + source]: after Resistance, Vulnerability and Immunity, before the clamp. */
  readonly dmgRolled: Int32Array;
  /** [round * S + source]: the part of dmgEff and dmgRolled that hit the source's own side (itself included). */
  readonly ffEff: Int32Array;
  readonly ffRolled: Int32Array;
  /** Per unit: HP and temp HP it lost. */
  readonly dmgTaken: Int32Array;
  /** Per unit: times reduced from above 0 HP to 0. */
  readonly drops: Uint8Array;
  /** Per unit: round of its first drop, 0 if never. */
  readonly firstDrop: Uint16Array;
  /** Per unit: 0 alive, 1 died at 0 HP (no death saves), 2 massive damage, 3 failed death saves. */
  readonly death: Uint8Array;
  /** [unit * 9 + level - 1]: slots spent in the fight. */
  readonly slots: Int16Array;
  /** [unit * 9 + level - 1]: slots spent before initiative (precast). */
  readonly preSlots: Int16Array;
  /** [unit * MAX_POOLS + pool]: pool uses spent (free casts, activations, reactions). */
  readonly pools: Int16Array;
  /** Per unit: spells cast without a slot. */
  readonly freeCasts: Int16Array;
  /** Per unit: concentration effects started. */
  readonly concStart: Int16Array;
  /** [unit * FX_END_WHYS.length + why]: how its concentration ended. */
  readonly concEnd: Int16Array;
  /** Per unit: turns whose decisions started with it up, and how many of those with concentration live. */
  readonly turns: Uint16Array;
  readonly concTurns: Uint16Array;
  /** [pickBase[unit] + family]: options chosen on its turns (a lone option isn't a choice, so it isn't counted), then rider and reaction uses. */
  readonly picks: Int32Array;
}

function sortedUnique(ids: string[]): string[] {
  ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return ids.filter((x, i) => i === 0 || x !== ids[i - 1]);
}

function viasOf(t: CompiledTemplate): string[] {
  const ids: string[] = [];
  for (const a of t.attacks) ids.push(a.id);
  for (const e of t.spells) ids.push(e.spell.id);
  for (const e of t.effects) ids.push(e.id);
  for (const f of t.features) ids.push(f.id);
  return sortedUnique(ids);
}

export function buildCounterLayout(setup: FightSetup): CounterLayout {
  const n = setup.seats.length;
  const sources: CounterSource[] = [];
  const vias: string[][] = [];
  const act: Int32Array[] = [];
  const oaSrc: Int32Array[] = [];
  const other = new Int32Array(n);
  const z = () => new Int32Array(n);
  const [pickBase, pickN, optOff, atkOff, castOff, featOff, grantOff, turnN, dodgeOff, foreignOff] = [z(), z(), z(), z(), z(), z(), z(), z(), z(), z()];
  const searchOff = z().fill(-1);
  const hiddenZones = setup.seats.some((s) => s.tpl.effects.some((e) => e.hiddenDc !== undefined));
  const bearerGrants = setup.seats.some((s) => s.tpl.effects.some((e) => e.grants.some((g) => g.to === 'bearer')));
  const moreOff: Int32Array[] = [];
  const riderOff: Int32Array[] = [];
  const reactOff: Int32Array[] = [];
  let picks = 0;
  for (let u = 0; u < n; u++) {
    const t = setup.seats[u]!.tpl;
    if (t.pools.length > MAX_POOLS) throw new RangeError(`${t.id} has ${t.pools.length} pools; counters hold ${MAX_POOLS}`);
    const v = viasOf(t);
    const a = new Int32Array(v.length);
    const o = new Int32Array(v.length).fill(-1);
    v.forEach((via, i) => {
      a[i] = sources.push({ owner: u, via, oa: false }) - 1;
      if (t.attacks.some((x) => x.kind === 'melee' && x.id === via)) o[i] = sources.push({ owner: u, via, oa: true }) - 1;
    });
    other[u] = sources.push({ owner: u, via: '(other)', oa: false }) - 1;
    vias.push(v);
    act.push(a);
    oaSrc.push(o);
    optOff[u] = FIXED_FAMILIES;
    atkOff[u] = optOff[u]! + t.options.length;
    castOff[u] = atkOff[u]! + t.attacks.length;
    featOff[u] = castOff[u]! + t.spells.length;
    grantOff[u] = featOff[u]! + t.features.length;
    // + 1: the core Dodge action (M3 step 5a), each unit's last family, so no earlier family moves within a unit.
    dodgeOff[u] = grantOff[u]! + t.effects.length * GRANTS_PER_EFFECT;
    let k = dodgeOff[u]! + 1;
    if (hiddenZones) searchOff[u] = k++;
    const mo = new Int32Array(t.features.length).fill(-1);
    t.features.forEach((f, i) => {
      if (f.more) {
        mo[i] = k;
        k += f.more.length;
      }
    });
    turnN[u] = k;
    const rs = t.riders ?? [];
    const ro = new Int32Array(rs.length);
    rs.forEach((r, i) => {
      ro[i] = k;
      k += r.opts.length;
    });
    const xo = new Int32Array(t.features.length).fill(-1);
    t.features.forEach((f, i) => {
      if (f.hitTaken || f.hitKnown || f.damageTaken || f.declared) xo[i] = k++; // M3 step 8'a: one feature has one reaction (coverage step 9+: or a declared one)
    });
    moreOff.push(mo);
    riderOff.push(ro);
    reactOff.push(xo);
    foreignOff[u] = bearerGrants ? k++ : -1;
    pickN[u] = k;
    pickBase[u] = picks;
    picks += pickN[u]!;
  }
  return { setup, units: n, rounds: setup.knobs.maxRounds + 1, sources, vias, act, oaSrc, other, pickBase, pickN, optOff, atkOff, castOff, featOff, grantOff, dodgeOff, searchOff, turnN, moreOff, riderOff, reactOff, foreignOff, picks };
}

export function newCounters(layout: CounterLayout): Counters {
  const n = layout.units;
  const rs = layout.rounds * layout.sources.length;
  return {
    layout,
    dmgEff: new Int32Array(rs),
    dmgRolled: new Int32Array(rs),
    ffEff: new Int32Array(rs),
    ffRolled: new Int32Array(rs),
    dmgTaken: new Int32Array(n),
    drops: new Uint8Array(n),
    firstDrop: new Uint16Array(n),
    death: new Uint8Array(n),
    slots: new Int16Array(n * 9),
    preSlots: new Int16Array(n * 9),
    pools: new Int16Array(n * MAX_POOLS),
    freeCasts: new Int16Array(n),
    concStart: new Int16Array(n),
    concEnd: new Int16Array(n * FX_END_WHYS.length),
    turns: new Uint16Array(n),
    concTurns: new Uint16Array(n),
    picks: new Int32Array(layout.picks),
  };
}

/** The source index for damage `owner` dealt through `via` (binary search over its sorted ids). */
export function sourceOf(layout: CounterLayout, owner: number, via: string, oa: boolean): number {
  const v = layout.vias[owner]!;
  let lo = 0;
  let hi = v.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const x = v[mid]!;
    if (x === via) {
      const o = oa ? layout.oaSrc[owner]![mid]! : -1;
      return o >= 0 ? o : layout.act[owner]![mid]!;
    }
    if (x < via) lo = mid + 1;
    else hi = mid - 1;
  }
  return layout.other[owner]!;
}

export function countDamage(c: Counters, round: number, owner: number, via: string, oa: boolean, target: number, effective: number, rolled: number): void {
  const L = c.layout;
  const i = Math.min(round, L.rounds - 1) * L.sources.length + sourceOf(L, owner, via, oa);
  c.dmgEff[i]! += effective;
  c.dmgRolled[i]! += rolled;
  c.dmgTaken[target]! += effective;
  if (L.setup.seats[owner]!.team === L.setup.seats[target]!.team) {
    c.ffEff[i]! += effective;
    c.ffRolled[i]! += rolled;
  }
}

export function countDrop(c: Counters, unit: number, round: number): void {
  if (c.drops[unit]! < 255) c.drops[unit]!++;
  if (c.firstDrop[unit] === 0) c.firstDrop[unit] = Math.max(1, round);
}

export function countDeath(c: Counters, unit: number, why: 'zeroHp' | 'massive' | 'deathSaves'): void {
  c.death[unit] = why === 'zeroHp' ? 1 : why === 'massive' ? 2 : 3;
}

/** A resource spent: a slot level 1-9 (resIdx 0-8, `pre` before initiative) or a pool use (resIdx 9+). */
export function countRes(c: Counters, unit: number, resIdx: number, pre = false): void {
  if (resIdx < 9) (pre ? c.preSlots : c.slots)[unit * 9 + resIdx]!++;
  else c.pools[unit * MAX_POOLS + resIdx - 9]!++;
}

export function countConcEnd(c: Counters, unit: number, why: ConcEndWhy): void {
  c.concEnd[unit * FX_END_WHYS.length + FX_END_WHYS.indexOf(why)]!++;
}

/** Counts a chosen turn option under its family (kinds that aren't one are skipped). `grantFx`: for a grant, its effect's index in the chooser's own template, or -1: a bearer's grant from someone else's effect (an Escape), counted in the unit's foreignOff family. */
export function countPick(c: Counters, unit: number, l: Legal, grantFx: number): void {
  const L = c.layout;
  let f = -1;
  switch (l.k) {
    case 'pass':
      f = 0;
      break;
    case 'move':
      f = 1;
      break;
    case 'stand':
      f = 2;
      break;
    case 'item':
      f = 3;
      break;
    case 'end':
      f = 4;
      break;
    case 'option':
      f = L.optOff[unit]! + l.opt;
      break;
    case 'attack':
      f = L.atkOff[unit]! + l.atk;
      break;
    case 'cast':
      f = L.castOff[unit]! + l.opt;
      break;
    case 'use':
      f = l.fx < 0 ? (l.aux > 0 && L.moreOff[unit]![l.opt]! >= 0 ? L.moreOff[unit]![l.opt]! + l.aux - 1 : L.featOff[unit]! + l.opt) : grantFx >= 0 ? (l.opt < GRANTS_PER_EFFECT ? L.grantOff[unit]! + grantFx * GRANTS_PER_EFFECT + l.opt : -1) : L.foreignOff[unit]!;
      break;
    case 'dodge':
      f = L.dodgeOff[unit]!;
      break;
    case 'search':
      f = L.searchOff[unit]!;
      break;
  }
  if (f >= 0 && f < L.pickN[unit]!) c.picks[L.pickBase[unit]! + f]!++;
}

/** A rider option used (riders.ts useRider): tpl.riders index and option index. */
export function countRiderPick(c: Counters, unit: number, ri: number, oi: number): void {
  const L = c.layout;
  c.picks[L.pickBase[unit]! + L.riderOff[unit]![ri]! + oi]!++;
}

/** A hitTaken, hitKnown, damageTaken or (coverage step 9+) declared reaction taken (riders.ts hitTakenWindow, d20.ts): tpl.features index. */
export function countReactPick(c: Counters, unit: number, fi: number): void {
  const L = c.layout;
  const f = L.reactOff[unit]![fi]!;
  if (f >= 0) c.picks[L.pickBase[unit]! + f]!++;
}

/** Readable names for a unit's pick families, in family order (for reports). */
export function pickFamilyNames(layout: CounterLayout, unit: number): string[] {
  const t = layout.setup.seats[unit]!.tpl;
  const names = ['pass', 'move', 'stand up', 'items', 'end an effect'];
  for (const o of t.options) names.push(o.name);
  for (const a of t.attacks) names.push(a.name);
  for (const e of t.spells) names.push(t.spells.filter((x) => x.spell.id === e.spell.id).length > 1 ? `${e.spell.name} (${e.source})` : e.spell.name);
  // A passive-only feature (M3 step 4: no activation, no pre-roll reaction) is never an option,
  // so it has no name here and "options never chosen" leaves it out.
  // A multi-activation feature's first family is its first activation (Flurry of Blows).
  for (const f of t.features) names.push(f.more && f.activate ? f.activate.name : f.activate || f.preRoll ? f.name : '');
  for (const e of t.effects) for (let g = 0; g < GRANTS_PER_EFFECT; g++) names.push(e.grants[g] ? `${e.grants[g]!.name} (${e.name})` : '');
  names.push('Dodge');
  if (layout.searchOff[unit]! >= 0) names.push('Search');
  for (const f of t.features) if (f.more) for (const a of f.more) names.push(a.name);
  for (const r of t.riders ?? []) for (const o of r.opts) names.push(r.chooses ? `${r.name}: ${o.name} (rider)` : `${r.name} (rider)`);
  for (const f of t.features) if (f.hitTaken || f.hitKnown || f.damageTaken || f.declared) names.push(`${f.name} (reaction)`);
  if (layout.foreignOff[unit]! >= 0) names.push("Escape (another creature's effect)");
  return names;
}
