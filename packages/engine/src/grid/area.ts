// Areas of effect on the grid. A shape key names a shape and its size; which squares it
// covers from an anchor comes from an integer mask built under the two area flags:
//   areaOriginOnGrid   the anchor is a square (its center is the origin) or a grid corner
//   areaGridCoverage   a square counts if at least half of it is covered, if its center is
//                      inside (distance <= radius), or if any positive area overlaps
// SRD 5.2.1 has no grid rule for areas; Shane's table ruling (2026-11-01) is the default:
// areas land on a square. Under it a 5-ft radius covers its one square and a 20-ft radius a
// 7x7 block minus its corners. Spheres and Cylinders cover the same squares on a flat grid
// (no altitude is tracked).
//
// Exact integers: a square is 128 units, so radii (multiples of 5 ft) are whole numbers of
// units and "at least half" counts 64 x 64 sample points per square.
//
// Shape key, low bits to high: size in feet (a Sphere's or Cylinder's radius, a side, a length)
// in bits 0-11, the shape in bits 12-19, a Line's width in feet in bits 20-29, and bit 30 for an
// Emanation that includes its origin. A Sphere's or Cylinder's key is the same number it always
// was. A Square is the Cube's key: no altitude on a flat grid.
//
// Step 7 shapes. Cones, Lines and an aimed Cube start from a creature: they take the creature's
// square and one of 8 aims at 45 degrees, a stated model limit (the SRD lets the creator choose
// any direction; a Cube from Self gets 8 of its 4n+4 legal placements). They never read the
// lattice: areaCellsFrom is their only way onto the grid. An Emanation is the same with no aim.

import { cellName, colName } from './cells.ts';
import { markFlag, readFlag, type GameState, type QueryState } from '../sim/state.ts';
import { areaCutOff, losOf } from '../sim/cover.ts';
import type { RuleFlags } from '../rules/flags.ts';

export const SHAPE = { sphere: 1, cylinder: 2, cube: 3, square: 3, cone: 4, line: 5, emanation: 6 } as const;
export type ShapeName = keyof typeof SHAPE;

const WIDTH_SHIFT = 20;
const WIDTH_MAX = 1023;
const ORIGIN_IN = 1 << 30;

function checkFt(what: string, ft: number, max: number): void {
  if (!Number.isInteger(ft) || ft < 5 || ft > max || ft % 5 !== 0) throw new RangeError(`area ${what} must be a multiple of 5 ft, got ${ft}`);
}

/** `widthFt` only for a Line, `includesOrigin` only for an Emanation. */
export function shapeKey(shape: ShapeName, sizeFt: number, widthFt?: number, includesOrigin?: boolean): number {
  checkFt('size', sizeFt, 4095);
  if ((shape === 'line') !== (widthFt !== undefined)) throw new RangeError(shape === 'line' ? 'a line needs a width' : `a ${shape} has no width`);
  if (includesOrigin !== undefined && shape !== 'emanation') throw new RangeError(`a ${shape} has no includesOrigin`);
  let key = (SHAPE[shape] << 12) | sizeFt;
  if (widthFt !== undefined) {
    checkFt('width', widthFt, WIDTH_MAX);
    key |= widthFt << WIDTH_SHIFT;
  }
  return includesOrigin ? key | ORIGIN_IN : key;
}

export function shapeOf(key: number): number {
  return (key >> 12) & 255;
}

export function sizeFtOf(key: number): number {
  return key & 4095;
}

/** A Line's width in feet; 0 for every other shape. */
export function widthFtOf(key: number): number {
  return (key >> WIDTH_SHIFT) & WIDTH_MAX;
}

/** An Emanation whose creator decided to include its origin (srd-raw.txt:33385-33386). */
export function includesOriginOf(key: number): boolean {
  return (key & ORIGIN_IN) !== 0;
}

/** The 8 aims at 45 degrees, clockwise from north (row 1 is the top of the map). The index is the aim. */
export const AIMS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
export const NO_AIM = -1;
const AIM_DX = [0, 1, 1, 1, 0, -1, -1, -1] as const;
const AIM_DY = [-1, -1, 0, 1, 1, 1, 0, -1] as const;

/** A shape whose origin is a creature: its squares come from the creature's square, never a lattice anchor. */
function needsCreatureOrigin(shape: number): boolean {
  return shape === SHAPE.cone || shape === SHAPE.line || shape === SHAPE.emanation;
}

export type AreaOrigin = 'squareCenter' | 'gridIntersection';
export type AreaCoverage = 'atLeastHalfSquare' | 'squareCenterInside' | 'anyOverlap';

const U = 128; // units per square
const HALF = 32 * 64; // half of the 64 x 64 samples
/** Built once per input combination and shared by every fight: pure, so a plain memo is safe. */
const memo: { [k: string]: Int16Array } = {};
/** The same masks as a lookup by offset, built on first use (the AI's aim search). */
const lookups: { [k: string]: MaskLookup } = {};

/** A mask as a table: `cover[(dy + r) * (2r + 1) + dx + r]` is 1 for a covered offset. */
export interface MaskLookup {
  readonly r: number;
  readonly cover: Uint8Array;
}

/** Does the circle of radius^2 R2 around (0, 0) cover the square with corner (x0, y0)? */
function circleCovers(x0: number, y0: number, R2: number, coverage: AreaCoverage): boolean {
  if (coverage === 'squareCenterInside') {
    const cx = x0 + U / 2;
    const cy = y0 + U / 2;
    return cx * cx + cy * cy <= R2;
  }
  if (coverage === 'anyOverlap') {
    const nx = Math.min(Math.max(0, x0), x0 + U);
    const ny = Math.min(Math.max(0, y0), y0 + U);
    return nx * nx + ny * ny < R2;
  }
  let inside = 0;
  for (let j = 0; j < 64; j++) {
    const sy = y0 + 2 * j + 1;
    for (let i = 0; i < 64; i++) {
      const sx = x0 + 2 * i + 1;
      if (sx * sx + sy * sy <= R2) inside++;
    }
  }
  return inside >= HALF;
}

/**
 * Is (px, py), relative to the point of origin, inside a Cone or Line along the axis (ax, ay)?
 * Integers only: `along` and `across` are the dot and cross product with the axis, so on a
 * diagonal both carry a factor of sqrt 2, which cancels in the Cone's slope and squares away in
 * the length and the Line's width. Past the origin only. L and W in units.
 *   Cone: width at a point equals its distance from the origin, so half-width is t/2 (srd-raw.txt:33031-33036).
 *   Line: length and width from the origin (33770-33771).
 */
function inAimed(isCone: boolean, px: number, py: number, ax: number, ay: number, L: number, W: number): boolean {
  const along = px * ax + py * ay;
  if (along <= 0) return false;
  const diag = ax !== 0 && ay !== 0;
  if (diag ? along * along > 2 * L * L : along > L) return false;
  const across = Math.abs(px * ay - py * ax);
  if (isCone) return 2 * across <= along;
  return diag ? 2 * across * across <= W * W : 2 * across <= W;
}

/** A Cone or Line from the point (ox, oy) of the (0, 0) square, under a coverage flag. */
function aimedCovers(isCone: boolean, dx: number, dy: number, ox: number, oy: number, ax: number, ay: number, L: number, W: number, coverage: AreaCoverage): boolean {
  const x0 = dx * U - ox;
  const y0 = dy * U - oy;
  if (coverage === 'squareCenterInside') return inAimed(isCone, x0 + U / 2, y0 + U / 2, ax, ay, L, W);
  // anyOverlap is sampled here, unlike the circle's exact test: a hit on any of the 64 x 64 points [U: a sliver under about 1/4096 of a square reads as no overlap].
  const need = coverage === 'anyOverlap' ? 1 : HALF;
  let inside = 0;
  for (let j = 0; j < 64; j++) {
    const sy = y0 + 2 * j + 1;
    for (let i = 0; i < 64; i++) {
      if (inAimed(isCone, x0 + 2 * i + 1, sy, ax, ay, L, W) && ++inside >= need) return true;
    }
  }
  return false;
}

/** A side of an n-square block centered on 0; an even size is biased toward +x, +y. */
function blockLo(n: number): number {
  return -Math.floor((n - 1) / 2);
}

/** The squares of a Cube or Square: around a point (aim NO_AIM), or touching the creature's square. */
function cubeMask(n: number, origin: AreaOrigin, aim: number): number[] {
  let x0 = origin === 'squareCenter' ? blockLo(n) : 0;
  let y0 = x0;
  if (aim !== NO_AIM) {
    const ax = AIM_DX[aim]!;
    const ay = AIM_DY[aim]!;
    x0 = ax > 0 ? 1 : ax < 0 ? -n : blockLo(n);
    y0 = ay > 0 ? 1 : ay < 0 ? -n : blockLo(n);
  }
  const out: number[] = [];
  for (let dy = y0; dy < y0 + n; dy++) for (let dx = x0; dx < x0 + n; dx++) out.push(dx, dy);
  return out;
}

/** Feet between two squares `dx`, `dy` apart, under a diagonal rule. */
function gridFtBy(diagonal: RuleFlags['diagonalCost'], dx: number, dy: number): number {
  const hi = Math.max(dx, dy);
  const lo = Math.min(dx, dy);
  return diagonal === 'alternate' ? 5 * (hi + Math.floor(lo / 2)) : 5 * hi;
}

function areaId(key: number, origin: AreaOrigin, coverage: AreaCoverage, diagonal: RuleFlags['diagonalCost'], selfOrigin: RuleFlags['selfAreaOrigin'], reach: RuleFlags['emanationReach'], aim: number): string {
  return `${key}|${origin}|${coverage}|${diagonal}|${selfOrigin}|${reach}|${aim}`;
}

/**
 * Squares covered, as [dx, dy] pairs (row by row) relative to the anchor: under squareCenter
 * the anchor square itself is (0, 0); under gridIntersection (0, 0) is the square whose
 * top-left corner is the anchor. A creature-origin shape's (0, 0) is the creature's square, and
 * it reads `selfOrigin` (Cone, Line) or `reach` and `diagonal` (Emanation), never `origin`. Every
 * input is required, so a caller can't leave one out of the memo by accident.
 */
export function areaMask(key: number, origin: AreaOrigin, coverage: AreaCoverage, diagonal: RuleFlags['diagonalCost'], selfOrigin: RuleFlags['selfAreaOrigin'], reach: RuleFlags['emanationReach'], aim: number): Int16Array {
  const id = areaId(key, origin, coverage, diagonal, selfOrigin, reach, aim);
  const hit = memo[id];
  if (hit) return hit;
  const shape = shapeOf(key);
  const size = sizeFtOf(key);
  const R = (size * U) / 5;
  const aimed = shape === SHAPE.cone || shape === SHAPE.line;
  if (aim !== NO_AIM && (!Number.isInteger(aim) || aim < 0 || aim >= AIMS.length)) throw new RangeError(`unknown aim ${aim}`);
  if (aimed && aim === NO_AIM) throw new RangeError('a cone or line needs an aim');
  if (aim !== NO_AIM && !aimed && shape !== SHAPE.cube) throw new RangeError(`area shape ${shape} takes no aim`);
  const out: number[] = [];
  if (shape === SHAPE.cube) {
    out.push(...cubeMask(size / 5, origin, aim));
  } else if (aimed) {
    const ax = AIM_DX[aim]!;
    const ay = AIM_DY[aim]!;
    // The point of origin: the square's center, or the point of its edge (a corner on a diagonal) toward the aim.
    const ox = U / 2 + (selfOrigin === 'squareEdge' ? (ax * U) / 2 : 0);
    const oy = U / 2 + (selfOrigin === 'squareEdge' ? (ay * U) / 2 : 0);
    const W = (widthFtOf(key) * U) / 5;
    const n = Math.ceil(Math.max(size, widthFtOf(key)) / 5) + 2;
    for (let dy = -n; dy <= n; dy++) {
      for (let dx = -n; dx <= n; dx++) {
        // A Cone's or Line's origin isn't included (srd-raw.txt:33039-33040, 33772-33773).
        if (dx === 0 && dy === 0) continue;
        if (aimedCovers(shape === SHAPE.cone, dx, dy, ox, oy, ax, ay, R, W, coverage)) out.push(dx, dy);
      }
    }
  } else if (shape === SHAPE.emanation) {
    const n = Math.ceil(size / 5) + 1;
    for (let dy = -n; dy <= n; dy++) {
      for (let dx = -n; dx <= n; dx++) {
        // An Emanation's origin isn't included unless its creator decides otherwise (33385-33386).
        if (dx === 0 && dy === 0 && !includesOriginOf(key)) continue;
        const inside = reach === 'gridDistance' ? gridFtBy(diagonal, Math.abs(dx), Math.abs(dy)) <= size : circleCovers(dx * U - U / 2, dy * U - U / 2, R * R, coverage);
        if (inside) out.push(dx, dy);
      }
    }
  } else if (shape === SHAPE.sphere || shape === SHAPE.cylinder) {
    const o = origin === 'squareCenter' ? U / 2 : 0;
    const n = Math.ceil(size / 5) + 1;
    for (let dy = -n; dy <= n; dy++) {
      for (let dx = -n; dx <= n; dx++) {
        if (circleCovers(dx * U - o, dy * U - o, R * R, coverage)) out.push(dx, dy);
      }
    }
  } else {
    throw new RangeError(`unknown area shape ${shape}`);
  }
  const mask = Int16Array.from(out);
  memo[id] = mask;
  return mask;
}

/**
 * The mask of a shape placed on the lattice: reads the two area flags and nothing else (a new
 * read here would move every report that places an area). A creature-origin shape has no lattice
 * form: refused, so it can't land on the wrong squares silently.
 */
export function latticeMask(st: QueryState, key: number): Int16Array {
  if (needsCreatureOrigin(shapeOf(key))) throw new RangeError(`area shape ${shapeOf(key)} starts from a creature: use areaCellsFrom`);
  return areaMask(key, readFlag(st, 'areaOriginOnGrid'), readFlag(st, 'areaGridCoverage'), 'uniform', 'squareCenter', 'gridDistance', NO_AIM);
}

/** The setup's lattice: anchors are squares, or grid corners ((w+1) x (h+1) of them). */
export function anchorCount(st: QueryState): number {
  const { w, h } = st.setup;
  return readFlag(st, 'areaOriginOnGrid') === 'squareCenter' ? w * h : (w + 1) * (h + 1);
}

function anchorXY(st: QueryState, anchor: number): [number, number] {
  const { w } = st.setup;
  const lw = readFlag(st, 'areaOriginOnGrid') === 'squareCenter' ? w : w + 1;
  return [anchor % lw, Math.floor(anchor / lw)];
}

export function anchorName(st: QueryState, anchor: number): string {
  const [x, y] = anchorXY(st, anchor);
  return readFlag(st, 'areaOriginOnGrid') === 'squareCenter' ? cellName(anchor, st.setup.w) : `^${colName(x)}${y + 1}`;
}

/** Parses 'E4' or '^E4' back to an anchor index; -1 if it isn't one. */
export function parseAnchor(st: QueryState, name: string): number {
  const corner = readFlag(st, 'areaOriginOnGrid') === 'gridIntersection';
  const m = /^(\^?)([A-Z]{1,2})([0-9]{1,2})$/.exec(name);
  if (!m || (m[1] === '^') !== corner) return -1;
  const letters = m[2]!;
  const x = letters.length === 1 ? letters.charCodeAt(0) - 65 : (letters.charCodeAt(0) - 64) * 26 + letters.charCodeAt(1) - 65;
  const y = Number(m[3]) - 1;
  const lw = corner ? st.setup.w + 1 : st.setup.w;
  const lh = corner ? st.setup.h + 1 : st.setup.h;
  return x >= 0 && x < lw && y >= 0 && y < lh ? y * lw + x : -1;
}

/**
 * An anchor's point of origin in quadrupled square units ([x4, y4]) and the square holding it
 * (-1 for a grid corner): a square's center, or the corner itself (areaOriginOnGrid).
 */
export function originPoint(st: QueryState, anchor: number): [number, number, number] {
  const [ax, ay] = anchorXY(st, anchor);
  return readFlag(st, 'areaOriginOnGrid') === 'squareCenter' ? [4 * ax + 2, 4 * ay + 2, anchor] : [4 * ax, 4 * ay, -1];
}

/**
 * Squares an area covers from `anchor`, in bounds, row by row; returns how many. M3 step 8: a
 * square every line to which from the point of origin is blocked by Total Cover isn't in the
 * area (glossary "Area of Effect", srd-raw.txt:32672-32677; sim/cover.ts areaCutOff). `mark`
 * records the flag at a resolution site.
 */
export function areaCells(st: QueryState, key: number, anchor: number, out: number[], mark: GameState | null = null): number {
  const { w, h } = st.setup;
  const mask = latticeMask(st, key);
  const [ax, ay] = anchorXY(st, anchor);
  out.length = 0;
  for (let i = 0; i < mask.length; i += 2) {
    const x = ax + mask[i]!;
    const y = ay + mask[i + 1]!;
    if (x >= 0 && x < w && y >= 0 && y < h) out.push(y * w + x);
  }
  if (st.setup.flags.losMethod !== 'stubbed' && losOf(st.setup).walls) {
    const [x4, y4, oc] = originPoint(st, anchor);
    let k = 0;
    for (let i = 0; i < out.length; i++) if (!areaCutOff(st, x4, y4, oc, out[i]!, mark)) out[k++] = out[i]!;
    out.length = k;
  }
  return out.length;
}

/** The flags a creature-origin shape's squares depend on, and nothing else; `mark` records them at a resolution site. */
function fromInputs(st: QueryState, key: number, mark: GameState | null) {
  const read = <K extends keyof RuleFlags>(k: K): RuleFlags[K] => {
    if (mark) markFlag(mark, k);
    return readFlag(st, k);
  };
  const shape = shapeOf(key);
  let coverage: AreaCoverage = 'atLeastHalfSquare';
  let diagonal: RuleFlags['diagonalCost'] = 'uniform';
  let selfOrigin: RuleFlags['selfAreaOrigin'] = 'squareCenter';
  let reach: RuleFlags['emanationReach'] = 'gridDistance';
  if (shape === SHAPE.cone || shape === SHAPE.line) {
    selfOrigin = read('selfAreaOrigin');
    coverage = read('areaGridCoverage');
  } else if (shape === SHAPE.emanation) {
    reach = read('emanationReach');
    if (reach === 'gridDistance') diagonal = read('diagonalCost');
    else coverage = read('areaGridCoverage');
  } else if (shape !== SHAPE.cube) {
    coverage = read('areaGridCoverage');
  }
  return { coverage, diagonal, selfOrigin, reach };
}

/**
 * A creature-origin area's point of origin, as originPoint gives a lattice anchor's: the center of
 * the creature's square, or under selfAreaOrigin=squareEdge the edge point a Cone or Line starts from.
 */
export function creatureOriginPoint(st: QueryState, key: number, cell: number, aim: number): [number, number, number] {
  const w = st.setup.w;
  const shape = shapeOf(key);
  const aimed = aim !== NO_AIM && (shape === SHAPE.cone || shape === SHAPE.line);
  const edge = aimed && readFlag(st, 'selfAreaOrigin') === 'squareEdge' ? 2 : 0;
  return [4 * (cell % w) + 2 + (aim === NO_AIM ? 0 : edge * AIM_DX[aim]!), 4 * Math.floor(cell / w) + 2 + (aim === NO_AIM ? 0 : edge * AIM_DY[aim]!), cell];
}

/** The mask areaCellsFrom uses, as a lookup by offset, for scanning creatures against an aim without listing its squares. */
export function creatureMaskLookup(st: QueryState, key: number, aim: number): MaskLookup {
  const m = fromInputs(st, key, null);
  const id = areaId(key, 'squareCenter', m.coverage, m.diagonal, m.selfOrigin, m.reach, aim);
  const hit = lookups[id];
  if (hit) return hit;
  const mask = areaMask(key, 'squareCenter', m.coverage, m.diagonal, m.selfOrigin, m.reach, aim);
  let r = 0;
  for (let i = 0; i < mask.length; i++) r = Math.max(r, Math.abs(mask[i]!));
  const side = 2 * r + 1;
  const cover = new Uint8Array(side * side);
  for (let i = 0; i < mask.length; i += 2) cover[(mask[i + 1]! + r) * side + mask[i]! + r] = 1;
  const out = { r, cover };
  lookups[id] = out;
  return out;
}

/**
 * Squares an area covers from a creature on `cell`, in bounds, row by row; returns how many. The
 * way onto the grid for `bearer` and `aim` zones: `cell` is a square under either
 * areaOriginOnGrid value, so that flag is never read here. Reads only the flags this shape's
 * squares depend on; `mark` records them at a resolution site. The wall cut-off's origin is at the
 * creature: its square's center, or the edge point a Cone or Line starts from under squareEdge.
 */
export function areaCellsFrom(st: QueryState, key: number, cell: number, aim: number, out: number[], mark: GameState | null = null): number {
  const { w, h } = st.setup;
  const m = fromInputs(st, key, mark);
  const mask = areaMask(key, 'squareCenter', m.coverage, m.diagonal, m.selfOrigin, m.reach, aim);
  const cx = cell % w;
  const cy = Math.floor(cell / w);
  out.length = 0;
  for (let i = 0; i < mask.length; i += 2) {
    const x = cx + mask[i]!;
    const y = cy + mask[i + 1]!;
    if (x >= 0 && x < w && y >= 0 && y < h) out.push(y * w + x);
  }
  if (st.setup.flags.losMethod !== 'stubbed' && losOf(st.setup).walls) {
    const [x4, y4] = creatureOriginPoint(st, key, cell, aim);
    let k = 0;
    for (let i = 0; i < out.length; i++) if (!areaCutOff(st, x4, y4, cell, out[i]!, mark)) out[k++] = out[i]!;
    out.length = k;
  }
  return out.length;
}

/** A creature-origin area's name in a log: `F10`, or `F10>NE` with an aim. */
export function areaFromName(st: QueryState, cell: number, aim: number): string {
  const c = cellName(cell, st.setup.w);
  return aim === NO_AIM ? c : `${c}>${AIMS[aim]!}`;
}

function gridFt(st: QueryState, dx: number, dy: number): number {
  return gridFtBy(readFlag(st, 'diagonalCost'), dx, dy);
}

/** Feet from a creature's square to an anchor (to the nearest square touching a corner). */
export function anchorRangeFt(st: QueryState, cell: number, anchor: number): number {
  const w = st.setup.w;
  const cx = cell % w;
  const cy = Math.floor(cell / w);
  const [ax, ay] = anchorXY(st, anchor);
  if (readFlag(st, 'areaOriginOnGrid') === 'squareCenter') return gridFt(st, Math.abs(cx - ax), Math.abs(cy - ay));
  // A corner touches squares ax-1..ax by ay-1..ay.
  const dx = cx < ax - 1 ? ax - 1 - cx : cx > ax ? cx - ax : 0;
  const dy = cy < ay - 1 ? ay - 1 - cy : cy > ay ? cy - ay : 0;
  return gridFt(st, dx, dy);
}

/** Feet between two anchors (moving a zone). */
export function anchorDistFt(st: QueryState, a: number, b: number): number {
  const [ax, ay] = anchorXY(st, a);
  const [bx, by] = anchorXY(st, b);
  return gridFt(st, Math.abs(ax - bx), Math.abs(ay - by));
}

/** The anchors a zone passes through moving straight from a to b (Bresenham), both ends included. */
export function anchorLine(st: QueryState, a: number, b: number): number[] {
  const [x0, y0] = anchorXY(st, a);
  const [x1, y1] = anchorXY(st, b);
  const lw = readFlag(st, 'areaOriginOnGrid') === 'squareCenter' ? st.setup.w : st.setup.w + 1;
  const out: number[] = [];
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    out.push(y * lw + x);
    if (x === x1 && y === y1) return out;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}
