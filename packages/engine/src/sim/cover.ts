// Cover and line of sight in a fight (M3 step 8; docs/design/m3.md section 7): the state-aware
// half of grid/los.ts. Queries take a QueryState; resolution sites pass the GameState as `mark`
// so the flags the result depended on are recorded.
//
// Flags: losMethod (corners | centers | stubbed) and creatureCover (on | off). Under stubbed
// nothing here reads or marks a flag and every answer is today's: no cover, everyone sees
// everyone, so a stubbed run is the pre-step-8 engine bit for bit. Otherwise losMethod is
// marked only when something could have changed the answer (a static obstacle or a creature
// inside the two squares' bounding box) and creatureCover only when a creature was there.
//
// Creatures that give cover (SRD 5.2.1 Cover table, srd-raw.txt:2006-2017: "Another creature"):
// every creature that isn't dead [U: a creature at 0 HP still counts], except the attacker or
// source, anyone standing on the source square, and the target.

import { buildLos, clearLine, COVER, coverDegree, coverFromPoint, cutOff, obstacleBetween, type LosTable } from '../grid/los.ts';
import type { FightSetup } from './setup.ts';
import { flagIndex } from '../rules/flags.ts';
import { markFlag, type GameState, type QueryState, type Unit } from './state.ts';

const LOS_I = flagIndex('losMethod');
const CC_I = flagIndex('creatureCover');

/** readFlag (sim/state.ts) for the two LOS flags, by index: these sit on the AI's hottest path. */
function readLos(st: QueryState): void {
  if (st.deciding > 0) st.aiFlags[LOS_I] = 1;
}
function readCc(st: QueryState): 'on' | 'off' {
  if (st.deciding > 0) st.aiFlags[CC_I] = 1;
  return st.setup.flags.creatureCover;
}

/** The setup's LOS table; built and kept on first use for a setup made without one. */
export function losOf(setup: FightSetup): LosTable {
  const own = setup.los;
  if (own) return own;
  const los = buildLos(setup.w, setup.h, setup.terrain);
  (setup as { los?: LosTable }).los = los;
  return los;
}

/** Scratch for creature squares (at most 55 units). Not reentrant: filled and read inside one call. */
const occ = new Int32Array(64);

/** How many of the squares gather last wrote are inside the strict box (the rest are its one-square ring). */
const strict = new Int32Array(1);

/**
 * Fills `occ` with the squares of creatures that may give cover: inside the box of the two
 * squares first, then (near a row or column only) its one-square ring, where a creature just
 * outside can close a seam along the box's own edge (grid/los.ts seamLevel). Returns how many.
 */
function gather(st: QueryState, w: number, from: number, to: number, src: Unit | null, t: Unit | null): number {
  const fx = from % w;
  const fy = (from - fx) / w;
  const tx = to % w;
  const ty = (to - tx) / w;
  const lx = fx < tx ? fx : tx;
  const hx = fx < tx ? tx : fx;
  const ly = fy < ty ? fy : ty;
  const hy = fy < ty ? ty : fy;
  const ring = hx - lx <= 1 || hy - ly <= 1 ? 1 : 0;
  let n = 0;
  let r = 64;
  const units = st.units;
  for (let i = 0; i < units.length; i++) {
    const u = units[i]!;
    const c = u.cell;
    if (u === src || u === t || c === from || c === to || u.life === 'dead') continue;
    const cx = c % w;
    if (cx < lx - ring || cx > hx + ring) continue;
    const cy = (c - cx) / w;
    if (cy < ly - ring || cy > hy + ring) continue;
    if (cx >= lx && cx <= hx && cy >= ly && cy <= hy) occ[n++] = c;
    else occ[--r] = c; // ring squares fill from the top, then move down after the box's
  }
  strict[0] = n;
  for (let k = 63; k >= r; k--) occ[n++] = occ[k]!;
  return n;
}

/**
 * The cover (grid/los.ts COVER) target `t` on `to` has against an attack or effect from the
 * square `from`, made by `src` (the attacker or caster; null for none). Total only from walls.
 */
export function coverAt(st: QueryState, src: Unit | null, from: number, to: number, t: Unit | null, mark: GameState | null): number {
  const m = st.setup.flags.losMethod;
  if (m === 'stubbed' || from === to) return COVER.none;
  readLos(st);
  const los = losOf(st.setup);
  const w = st.setup.w;
  let n = 0;
  if (!mark && st.setup.flags.creatureCover === 'off') readCc(st); // a query under off: no creature counts
  else {
    n = gather(st, w, from, to, src, t);
    if (n > 0) {
      // A resolution site records the flags only where a creature could matter: inside the box,
      // or a ring creature that actually changed the answer (a seam).
      const matters = !mark || strict[0]! > 0 || coverDegree(los, m, from, to, occ, n) !== coverDegree(los, m, from, to, occ, strict[0]!);
      if (mark && matters) markFlag(mark, 'creatureCover');
      if (readCc(st) === 'off') n = 0;
      else if (!matters) n = strict[0]!;
    }
  }
  if (mark && (n > 0 || obstacleBetween(los, from, to))) markFlag(mark, 'losMethod');
  return coverDegree(los, m, from, to, occ, n);
}

/** The cover `t` has against `a` attacking from `from`. */
export function coverAgainst(st: QueryState, a: Unit, from: number, t: Unit, mark: GameState | null): number {
  return coverAt(st, a, from, t.cell, t, mark);
}

/**
 * The cover `t` has from an area's point of origin (x2, y2) in doubled coordinates
 * (`originCell`: the square a square-centered origin sits in, or -1).
 */
export function coverFromOrigin(st: QueryState, x2: number, y2: number, originCell: number, t: Unit, mark: GameState | null): number {
  const m = st.setup.flags.losMethod;
  if (m === 'stubbed') return COVER.none;
  readLos(st);
  const los = losOf(st.setup);
  const w = st.setup.w;
  // For the flag mark only: the origin's square (a corner origin: the square below-right of it).
  const from = Math.min(st.setup.h - 1, Math.floor(y2 / 2)) * w + Math.min(w - 1, Math.floor(x2 / 2));
  // Lines from the point to the target square's corners stay inside this box (doubled units).
  const tx = 2 * (t.cell % w);
  const ty = 2 * Math.floor(t.cell / w);
  const lx = Math.min(x2, tx);
  const hx = Math.max(x2, tx + 2);
  const ly = Math.min(y2, ty);
  const hy = Math.max(y2, ty + 2);
  let n = 0;
  for (const u of st.units) {
    if (u === t || u.life === 'dead' || u.cell === originCell) continue;
    const cx = 2 * (u.cell % w);
    const cy = 2 * Math.floor(u.cell / w);
    if (cx + 2 > lx && cx < hx && cy + 2 > ly && cy < hy) occ[n++] = u.cell;
  }
  if (n > 0) {
    if (mark) markFlag(mark, 'creatureCover');
    if (readCc(st) === 'off') n = 0;
  }
  if (mark && (n > 0 || obstacleBetween(los, from, t.cell))) markFlag(mark, 'losMethod');
  return coverFromPoint(los, m, x2, y2, t.cell, occ, n, originCell);
}

/**
 * The degree a Dexterity save gets from its source's raw cover `raw` (8'a review R1, R2). A
 * creature making the save is subject to the effect, so it isn't wholly covered from it: Total
 * Cover means it "can't be targeted directly" (srd-raw.txt:2028-2032) and an area leaves out a
 * location only when every line to it is blocked (32672-32677); the square-sampled area test
 * (cutOff) and the corner-line cover test can disagree on a square, so a raw Total is read as
 * Three-Quarters, +5 [U]. `ignoresCover: 'partial'` (Sacred Flame: "no benefit from Half Cover
 * or Three-Quarters Cover for this save", 30314-30315) leaves none.
 */
export function saveCoverDegree(raw: number, ignoresCover: 'partial' | undefined): number {
  if (ignoresCover === 'partial') return COVER.none;
  return raw === COVER.total ? COVER.threeQuarters : raw;
}

/**
 * Line of sight from the square `from` to the square `to` (walls only). Always true under
 * stubbed and on maps with no walls.
 */
export function seesCell(st: QueryState, from: number, to: number, mark: GameState | null): boolean {
  const m = st.setup.flags.losMethod;
  if (m === 'stubbed') return true;
  const los = losOf(st.setup);
  if (!los.walls) return true;
  readLos(st);
  if (mark && obstacleBetween(los, from, to)) markFlag(mark, 'losMethod');
  return clearLine(los, m, from, to);
}

/** Can a target on `to` be targeted directly from `from` (not behind Total Cover, srd-raw.txt:2028-2032, 23778-23780)? */
export function targetable(st: QueryState, from: number, to: number, mark: GameState | null): boolean {
  return seesCell(st, from, to, mark);
}

/** Area line of effect: is `cell` cut off from the origin (x4, y4) in quadrupled coordinates by Total Cover? */
export function areaCutOff(st: QueryState, x4: number, y4: number, originCell: number, cell: number, mark: GameState | null): boolean {
  const m = st.setup.flags.losMethod;
  if (m === 'stubbed') return false;
  const los = losOf(st.setup);
  if (!los.walls) return false;
  readLos(st);
  const cut = cutOff(los, x4, y4, cell, originCell);
  if (mark && cut) markFlag(mark, 'losMethod');
  return cut;
}

/** The LOS line every log header and report prints (docs/design/m3.md section 7). */
export function losNote(setup: FightSetup): string {
  const f = setup.flags;
  return f.losMethod === 'stubbed' ? 'LOS: stubbed (everyone sees everyone)' : `LOS: grid (losMethod=${f.losMethod}, creatureCover=${f.creatureCover})`;
}

/**
 * For deciders (decide/ and query/ may not read flags directly): 0 under stubbed (no cover,
 * nothing read), 1 when cover is on but the map has no walls (creatures and objects only:
 * nothing is ever Total), 2 with walls. Reads losMethod (an AI flag) only when it isn't stubbed.
 */
export function losMode(st: QueryState): 0 | 1 | 2 {
  if (st.setup.flags.losMethod === 'stubbed') return 0;
  readLos(st);
  return losOf(st.setup).walls ? 2 : 1;
}
