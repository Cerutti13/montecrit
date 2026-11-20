// Coverage step 9: hidden zones and the Search action (docs/design/m3.md section 8).
//
// A zone whose effect is `hidden` (Spike Growth: "camouflaged to look natural. Any creature that
// can't see the area when the spell is cast must take a Search action and succeed on a Wisdom
// (Perception or Survival) check against your spell save DC to recognize the terrain as
// hazardous", srd-raw.txt:31015-31021) is known only to the creatures that saw it appear or later
// recognized it (fx.seen[u] === 1, read by grid/reach.ts knownZones under zoneKnowledge sawCast).
// Its damage applies whether or not a creature knows. The engine never names a spell here: it
// reads `hidden` (BoundEffect.hiddenDc, bound into the zone as fx.hdc at cast).

import { ABILITIES } from '../content/types.ts';
import { keyName as keyNameOf, skillIndex } from '../content/rollkeys.ts';
import { seesZone } from '../grid/reach.ts';
import { seesCell } from './cover.ts';
import { checkSpec, rollD20 } from './d20.ts';
import { boundOf } from './effects.ts';
import { emit, evBase, nextSeq, releaseFold, takeFold, type Ctx } from './context.ts';
import { COND, has, useFlag, type Fx, type GameState, type QueryState, type Unit } from './state.ts';

const WIS = ABILITIES.indexOf('wis');
const PERCEPTION = skillIndex('perception');
const SURVIVAL = skillIndex('survival');
const SEARCH_BEST: readonly number[] = [PERCEPTION, SURVIVAL];
const SEARCH_PERCEPTION: readonly number[] = [PERCEPTION];

/**
 * Who saw a hidden zone appear: its caster, and every creature not dead or Incapacitated that can
 * see its area (srd-raw.txt:31016-31017 turns on seeing the area, not the caster). Seeing only part
 * of the area counts under hiddenHazardPartialViewCountsAsSeen, read only when someone saw part
 * and not all of it. On a map with no walls everyone sees every square, so nothing is read.
 */
export function hiddenWitness(st: GameState, u: Unit, owner: Unit, cells: readonly number[]): boolean {
  if (u === owner) return true;
  // Blinded: it can't see (srd-raw.txt:32740-32742), so it can't see the area.
  if (u.life === 'dead' || has(u, COND.incapacitated) || has(u, COND.blinded)) return false;
  let saw = 0;
  for (const c of cells) if (seesCell(st, u.cell, c, st)) saw++;
  if (saw === cells.length) return cells.length > 0;
  if (saw === 0) return false;
  return useFlag(st, 'hiddenHazardPartialViewCountsAsSeen');
}

/** A hidden zone `u` hasn't recognized (not its own, not seen appear, not found by a Search). */
export function unrecognized(fx: Fx, u: Unit): boolean {
  return fx.alive && fx.hdc >= 0 && fx.zbit >= 0 && fx.owner !== u.idx && fx.seen !== null && fx.seen[u.idx] !== 1;
}

/**
 * Coverage step 9 review: hidden zone slots whose fx.seen for `u` is `v` (1 recognized, 2 hurt by
 * it unrecognized); 0 when no hidden zone is live. The walker compares these before and after each
 * step so a mover that learns of a hidden zone mid-walk stops and plans again.
 */
export function hiddenSeenMask(st: QueryState, u: Unit, v: 1 | 2): number {
  let m = 0;
  for (let z = 0; z < 32; z++) {
    const id = st.zoneFx[z]!;
    if (id < 0) continue;
    const fx = st.fx[id]!;
    if (fx.hdc >= 0 && fx.seen !== null && fx.seen[u.idx] === v) m |= 1 << z;
  }
  return m;
}

/** Whether any hidden zone is live. */
export function hiddenLive(st: QueryState): boolean {
  for (let z = 0; z < 32; z++) {
    const id = st.zoneFx[z]!;
    if (id >= 0 && st.fx[id]!.hdc >= 0) return true;
  }
  return false;
}

/** Whether the Search action is on `u`'s list: some live hidden zone it hasn't recognized exists (sim/options.ts). */
export function searchOffered(st: QueryState, u: Unit): boolean {
  for (let z = 0; z < 32; z++) {
    const id = st.zoneFx[z]!;
    if (id >= 0 && unrecognized(st.fx[id]!, u)) return true;
  }
  return false;
}

/**
 * A hidden zone's hook damaged `targets` (sim/steps.ts after its damage step). Under
 * hiddenHazardRevealedByDamage a creature that hadn't recognized it does now; otherwise it only
 * learns that something there hurt it (seen 2: a reason to Search the AI may read).
 */
export function hiddenZoneHurt(cx: Ctx, fx: Fx, targets: readonly number[], cause: number): void {
  const st = cx.st;
  for (const t of targets) {
    const u = st.units[t]!;
    if (u.life === 'dead' || !unrecognized(fx, u)) continue;
    if (useFlag(st, 'hiddenHazardRevealedByDamage')) reveal(cx, fx, u, 'damage', cause);
    else fx.seen![t] = 2;
  }
}

function reveal(cx: Ctx, fx: Fx, u: Unit, how: 'search' | 'damage', cause: number): void {
  fx.seen![u.idx] = 1;
  const seq = nextSeq(cx);
  if (cx.sink) {
    const te = boundOf(cx.st, fx);
    emit(cx, { ...evBase(cx, seq, cause), k: 'reveal', who: u.idx, fx: fx.id, via: te.id, name: te.name, how });
  }
}

/** The skills a Search uses under searchSkill (a query: the AI reads it with readFlag through `skills`). */
export function searchSkills(mode: 'best' | 'perception'): readonly number[] {
  return mode === 'best' ? SEARCH_BEST : SEARCH_PERCEPTION;
}

const NO_SKILLS: readonly number[] = [];

/**
 * The skills `u`'s Search check names. Coverage step 9 review: a stat block's skill bonuses aren't
 * modeled (sim/d20.ts checkMod: a monster's check is its plain ability modifier [U]), so a monster's
 * Search is a plain WIS check, logged as one, and searchSkill decides nothing for it (not read).
 * `mode` is called only for a PC, so the caller reads or marks the flag only where it counts.
 */
export function searchSkillsOf(u: Unit, mode: () => 'best' | 'perception'): readonly number[] {
  return u.tpl.kind === 'pc' ? searchSkills(mode()) : NO_SKILLS;
}

/** Whether `u` can look for a hidden zone at all: a Blinded creature can't see (srd-raw.txt:32740-32742) [U: a Search for camouflaged ground taken as needing sight]. */
export function canSearchBySight(u: Unit): boolean {
  return !has(u, COND.blinded);
}

export const SEARCH_ABILITY = WIS;

/**
 * The Search action (srd-raw.txt:34116-34118: one Wisdom check): one roll against every hidden zone
 * `u` hasn't recognized and can see a square of, each against its own bound DC; each one it meets
 * is recognized. Logged as one check event (against the lowest-slot zone's DC) and a reveal per zone found.
 */
export function resolveSearch(cx: Ctx, u: Unit, cause: number): void {
  const st = cx.st;
  u.b.action--;
  const seq = nextSeq(cx);
  if (cx.sink) emit(cx, { ...evBase(cx, seq, cause), k: 'act', who: u.idx, via: 'core:search', name: 'Search' });
  const found: Fx[] = [];
  for (let z = 0; z < 32; z++) {
    const id = st.zoneFx[z]!;
    if (id >= 0 && unrecognized(st.fx[id]!, u) && canSearchBySight(u) && seesZone(st, u.cell, z)) found.push(st.fx[id]!);
  }
  if (found.length === 0) return; // nothing in sight to find (or Blinded); no roll
  const skills = searchSkillsOf(u, () => useFlag(st, 'searchSkill'));
  const fd = takeFold(cx);
  const dc0 = found[0]!.hdc;
  const { spec, key } = checkSpec(st, u, WIS, skills, dc0, fd.adv, fd.dis, fd.f);
  const r = rollD20(cx, u, spec, key, 'check', st.setup.flags, seq, fd, { target: -1, via: 'core:search' });
  const c = nextSeq(cx);
  if (cx.sink) {
    emit(cx, {
      ...evBase(cx, c, seq), k: 'save', who: u.idx, via: 'core:search', name: 'Search', key: keyNameOf(key), purpose: 'check', slot: r.slot,
      d20: r.d20, natural: r.natural, face: r.face, pre: r.pre, ext: r.ext, total: r.total, dc: dc0, adv: spec.adv, advSrc: fd.adv.slice(), disSrc: fd.dis.slice(), ok: r.success,
    });
  }
  releaseFold(cx, fd);
  // The first zone's DC is the roll's own; any other is met when the total reaches its DC (the
  // same automatic-success rules as the first: r.success decides it when the DCs are equal).
  for (const fx of found) if (fx.hdc === dc0 ? r.success : r.total >= fx.hdc) reveal(cx, fx, u, 'search', c);
}
