// Cover and line of sight on the grid (M3 step 8; docs/design/m3.md section 7). Pure: no RNG,
// no state, integer arithmetic only (exact on every machine), under grid/'s determinism bans.
//
// The rules (SRD 5.2.1 "Cover", srd-raw.txt:1995-2032, glossary 33044-33050): Half Cover +2 to
// AC and Dexterity saves, Three-Quarters +5, Total "can't be targeted directly"; another creature
// gives Half; only the most protective degree applies, never a sum; cover counts only when the
// effect "originates on the opposite side of the cover". The SRD has no grid procedure, so the
// method is the flag losMethod (rules/flags.ts):
//
//   corners: the DMG's procedure (known secondhand [U]): from the attacker's best corner, lines
//            to the 4 corners of the target's square; 1-2 blocked Half, 3 Three-Quarters, all 4
//            Total. An obstacle blocks a line when the line passes through its open interior: a
//            line along a square's edge or through its corner point isn't blocked [U], except
//            along the seam between two obstacles (seamLevel) or through a corner point two
//            obstacles share diagonally (pinchLevel), blocked at the lower level of the two. Each
//            obstacle caps the degree it can give at its own: a creature or '+' at Half, a '*'
//            at Three-Quarters, a wall ('#') at Total. So for each level L, n_L lines blocked by
//            something of level >= L give min(L, degree(n_L)), and a corner's degree is the most
//            protective of those (the rules' "most protective degree applies").
//   centers: one line between the two squares' centers; the degree is the highest level it
//            crosses (a wall: Total).
//
// From a point (an area's point of origin, glossary "Area of Effect", srd-raw.txt:32672-32677)
// the corners method uses that one point instead of the attacker's 4 corners; a location in an
// area is out of it when every line from the origin to it is blocked by Total Cover (a wall).
//
// The attacker's and the target's own squares never block (a creature standing in a '+'
// square isn't covered by its own square [U]). Walls never move, so each (from, to) pair's
// static line levels are computed once per setup and cached; creatures are added per query.

import { TERR } from './cells.ts';

/** Cover degrees. */
export const COVER = { none: 0, half: 1, threeQuarters: 2, total: 3 } as const;
/** AC and Dexterity save bonus by degree (Total has none: it can't be targeted). */
export const COVER_BONUS: readonly number[] = [0, 2, 5, 0];
export const COVER_NAME: readonly string[] = ['none', 'Half Cover', 'Three-Quarters Cover', 'Total Cover'];

/** Pairs cached per setup up to this many cells (12 x 12 is 144; 1,024 cells is 5 MB of cache). */
const CACHE_MAX_CELLS = 1024;

export interface LosTable {
  readonly w: number;
  readonly h: number;
  /** Per cell: 0 open, 1 a Half Cover object, 2 a Three-Quarters object, 3 a wall. */
  readonly level: Uint8Array;
  /** Cells with level > 0, ascending. */
  readonly obstacles: Int32Array;
  /** Any wall: only walls give Total Cover or block sight. */
  readonly walls: boolean;
  /** Any two static obstacles touching only at a corner (a pinch point, pinchLevel). */
  readonly pinch: boolean;
  /** Per (from * cells + to): the 16 corner lines' static levels, 2 bits each (line i * 4 + j: from corner i to target corner j). Filled lazily. */
  lines: Uint32Array | null;
  /** Per pair: 1 + the center line's static level; 0 until computed. Also marks `lines` filled. */
  center: Uint8Array | null;
  /** Lines a creature's square blocks, by (target offset, creature offset) (blockMask); bit 31 marks computed. */
  masks: Uint32Array | null;
}

export function cellLevel(terr: number): number {
  return terr & TERR.wall ? 3 : terr & TERR.threeQuarterCover ? 2 : terr & TERR.halfCover ? 1 : 0;
}

export function buildLos(w: number, h: number, terrain: Uint8Array): LosTable {
  const n = w * h;
  const level = new Uint8Array(n);
  const obs: number[] = [];
  let walls = false;
  for (let c = 0; c < n; c++) {
    const l = cellLevel(terrain[c]!);
    level[c] = l;
    if (l > 0) obs.push(c);
    if (l === 3) walls = true;
  }
  let pinch = false;
  for (const c of obs) {
    const x = c % w;
    const y = (c - x) / w;
    if (y + 1 < h && ((x > 0 && level[c + w - 1]! > 0) || (x + 1 < w && level[c + w + 1]! > 0))) pinch = true;
  }
  return { w, h, level, obstacles: Int32Array.from(obs), walls, pinch, lines: null, center: null, masks: null };
}

/**
 * Does the segment (x0, y0) -> (x1, y1) pass through the open interior of square (cx, cy)? All
 * coordinates are in units of 1/S of a square (a square spans [S * cx, S * cx + S]). Exact:
 * Liang-Barsky clipping on fractions compared by cross-multiplication.
 */
export function crossesCell(x0: number, y0: number, x1: number, y1: number, cx: number, cy: number, S: number): boolean {
  // t interval [lo, hi] as fractions ln/ld, hn/hd with positive denominators.
  let ln = 0;
  let ld = 1;
  let hn = 1;
  let hd = 1;
  for (let axis = 0; axis < 2; axis++) {
    const p0 = axis === 0 ? x0 : y0;
    const d = axis === 0 ? x1 - x0 : y1 - y0;
    const a = (axis === 0 ? cx : cy) * S;
    const b = a + S;
    if (d === 0) {
      if (!(a < p0 && p0 < b)) return false;
      continue;
    }
    // Entry and exit on this axis, as fractions with a positive denominator.
    let en: number;
    let xn: number;
    let dd: number;
    if (d > 0) {
      en = a - p0;
      xn = b - p0;
      dd = d;
    } else {
      en = p0 - b;
      xn = p0 - a;
      dd = -d;
    }
    if (en * ld > ln * dd) {
      ln = en;
      ld = dd;
    }
    if (xn * hd < hn * dd) {
      hn = xn;
      hd = dd;
    }
    if (!(ln * hd < hn * ld)) return false;
  }
  return ln * hd < hn * ld;
}

/** degree(n): 0 lines blocked none, 1-2 Half, 3 Three-Quarters, 4 Total. */
function byCount(n: number): number {
  return n === 0 ? 0 : n <= 2 ? 1 : n === 3 ? 2 : 3;
}

/** The degree 4 lines give (levels packed 2 bits each at `shift`). */
function fourLines(packed: number, shift: number): number {
  let n1 = 0;
  let n2 = 0;
  let n3 = 0;
  for (let j = 0; j < 4; j++) {
    const l = (packed >>> (shift + j * 2)) & 3;
    if (l >= 1) n1++;
    if (l >= 2) n2++;
    if (l >= 3) n3++;
  }
  let d = byCount(n1) < 1 ? byCount(n1) : 1;
  const d2 = byCount(n2) < 2 ? byCount(n2) : 2;
  if (d2 > d) d = d2;
  const d3 = byCount(n3);
  if (d3 > d) d = d3;
  return d;
}

/** Corners: the attacker's best corner (the least cover) over 16 packed line levels. */
export function cornersDegree(packed: number): number {
  if (packed === 0) return 0;
  let best = 3;
  for (let i = 0; i < 4 && best > 0; i++) {
    const d = fourLines(packed, i * 8);
    if (d < best) best = d;
  }
  return best;
}

function cornerX(cell: number, w: number, k: number): number {
  return 2 * (cell % w) + (k & 1 ? 2 : 0);
}
function cornerY(cell: number, w: number, k: number): number {
  return 2 * Math.floor(cell / w) + (k & 2 ? 2 : 0);
}

/**
 * A square's level for seams: its static level, or 1 for a listed creature's; 0 for `skipA`/`skipB`.
 * Off the grid reads as solid (3), so a line along the map's border is closed by an obstacle beside
 * it, as a line along an interior seam between two obstacles is: a full-height wall has no gap on
 * the border rows.
 */
function levelAt(los: LosTable, x: number, y: number, occ: Int32Array | null, nOcc: number, skipA: number, skipB: number): number {
  if (x < 0 || y < 0 || x >= los.w || y >= los.h) return 3;
  const c = y * los.w + x;
  if (c === skipA || c === skipB) return 0;
  let l = los.level[c]!;
  if (l === 0 && occ) for (let k = 0; k < nOcc; k++) if (occ[k] === c) return 1;
  return l;
}

/**
 * A segment lying exactly along a grid line (doubled coordinates, the fixed one even) passes no
 * square's open interior, but where it runs along the seam between two obstacle squares it runs
 * inside their union: blocked at the lower of the two levels (so a wall two squares long is
 * solid, not seen through along its seam) [U: the procedure is secondhand]. 0 for any other segment.
 */
export function seamLevel(los: LosTable, x0: number, y0: number, x1: number, y1: number, occ: Int32Array | null, nOcc: number, skipA: number, skipB: number): number {
  let best = 0;
  if (x0 === x1 && (x0 & 1) === 0 && y0 !== y1) {
    const X = x0 / 2;
    const lo = y0 < y1 ? y0 : y1;
    const hi = y0 < y1 ? y1 : y0;
    for (let r = Math.max(0, Math.floor(lo / 2)); 2 * r < hi && r < los.h; r++) {
      if (2 * r + 2 <= lo) continue;
      const a = levelAt(los, X - 1, r, occ, nOcc, skipA, skipB);
      const b = levelAt(los, X, r, occ, nOcc, skipA, skipB);
      const m = a < b ? a : b;
      if (m > best) best = m;
    }
  } else if (y0 === y1 && (y0 & 1) === 0 && x0 !== x1) {
    const Y = y0 / 2;
    const lo = x0 < x1 ? x0 : x1;
    const hi = x0 < x1 ? x1 : x0;
    for (let q = Math.max(0, Math.floor(lo / 2)); 2 * q < hi && q < los.w; q++) {
      if (2 * q + 2 <= lo) continue;
      const a = levelAt(los, q, Y - 1, occ, nOcc, skipA, skipB);
      const b = levelAt(los, q, Y, occ, nOcc, skipA, skipB);
      const m = a < b ? a : b;
      if (m > best) best = m;
    }
  }
  return best;
}

/**
 * Two obstacle squares that touch only at a corner close that corner point (8'a review G1): a
 * segment that passes through the point between them, from one of the other two squares to the
 * other, is blocked at the lower of their levels, as at a seam, so a staircase of '#' squares is
 * a solid diagonal wall, matching movement (grid/reach.ts: no diagonal step past a wall corner)
 * [U: the procedure is secondhand]. A segment that starts (ends) at the point counts when it
 * leaves (enters) the square `ownStart` (`ownEnd`) there: a corner line from an attacker's corner
 * that sits on the pinch goes from its square through the pinch. Coordinates in units of 1/S of
 * a square; levels as levelAt. 0 for an axis-aligned segment (seamLevel handles those).
 */
export function pinchLevel(los: LosTable, x0: number, y0: number, x1: number, y1: number, S: number, occ: Int32Array | null, nOcc: number, skipA: number, skipB: number, ownStart = -1, ownEnd = -1): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  if (dx === 0 || dy === 0) return 0;
  let a = dx < 0 ? -dx : dx;
  let b = dy < 0 ? -dy : dy;
  while (b !== 0) {
    const r = a % b;
    a = b;
    b = r;
  }
  const sx = dx / a;
  const sy = dy / a;
  // Going down-right or up-left, the squares across the point are up-right and down-left; else up-left and down-right.
  const main = sx * sy > 0;
  const w = los.w;
  let best = 0;
  for (let k = ownStart >= 0 ? 0 : 1; k <= (ownEnd >= 0 ? a : a - 1); k++) {
    const px = x0 + k * sx;
    const py = y0 + k * sy;
    if (px % S !== 0 || py % S !== 0) continue;
    const X = px / S;
    const Y = py / S;
    // At an end, the segment must come from (go on into) its own square at the point.
    if (k === 0 && (Y + (sy > 0 ? -1 : 0)) * w + X + (sx > 0 ? -1 : 0) !== ownStart) continue;
    if (k === a && (Y + (sy > 0 ? 0 : -1)) * w + X + (sx > 0 ? 0 : -1) !== ownEnd) continue;
    const l1 = main ? levelAt(los, X, Y - 1, occ, nOcc, skipA, skipB) : levelAt(los, X - 1, Y - 1, occ, nOcc, skipA, skipB);
    if (l1 <= best) continue;
    const l2 = main ? levelAt(los, X - 1, Y, occ, nOcc, skipA, skipB) : levelAt(los, X, Y, occ, nOcc, skipA, skipB);
    const m = l1 < l2 ? l1 : l2;
    if (m > best) best = m;
  }
  return best;
}

/** Static levels of the 16 corner lines and the center line between two squares (doubled coordinates). */
function computeStatic(los: LosTable, from: number, to: number): { lines: number; center: number } {
  const w = los.w;
  const fx = from % w;
  const fy = Math.floor(from / w);
  const tx = to % w;
  const ty = Math.floor(to / w);
  const x0 = fx < tx ? fx : tx;
  const x1 = fx < tx ? tx : fx;
  const y0 = fy < ty ? fy : ty;
  const y1 = fy < ty ? ty : fy;
  let lines = 0;
  let center = 0;
  const obs = los.obstacles;
  for (let k = 0; k < obs.length; k++) {
    const c = obs[k]!;
    if (c === from || c === to) continue;
    const cx = c % w;
    const cy = Math.floor(c / w);
    if (cx < x0 || cx > x1 || cy < y0 || cy > y1) continue;
    const l = los.level[c]!;
    for (let i = 0; i < 4; i++) {
      const ax = cornerX(from, w, i);
      const ay = cornerY(from, w, i);
      for (let j = 0; j < 4; j++) {
        const sh = (i * 4 + j) * 2;
        if (((lines >>> sh) & 3) >= l) continue;
        if (crossesCell(ax, ay, cornerX(to, w, j), cornerY(to, w, j), cx, cy, 2)) lines = ((lines & ~(3 << sh)) | (l << sh)) >>> 0;
      }
    }
    if (l > center && crossesCell(2 * fx + 1, 2 * fy + 1, 2 * tx + 1, 2 * ty + 1, cx, cy, 2)) center = l;
  }
  // Lines along a grid line: the seams between static obstacles.
  for (let i = 0; i < 4; i++) {
    const ax = cornerX(from, w, i);
    const ay = cornerY(from, w, i);
    for (let j = 0; j < 4; j++) {
      const bx = cornerX(to, w, j);
      const by = cornerY(to, w, j);
      if (ax !== bx && ay !== by) continue;
      const sh = (i * 4 + j) * 2;
      const l = seamLevel(los, ax, ay, bx, by, null, 0, from, to);
      if (l > ((lines >>> sh) & 3)) lines = ((lines & ~(3 << sh)) | (l << sh)) >>> 0;
    }
  }
  // Lines through a corner point two static obstacles share (pinchLevel).
  if (los.pinch) {
    for (let i = 0; i < 4; i++) {
      const ax = cornerX(from, w, i);
      const ay = cornerY(from, w, i);
      for (let j = 0; j < 4; j++) {
        const sh = (i * 4 + j) * 2;
        if (((lines >>> sh) & 3) === 3) continue;
        const l = pinchLevel(los, ax, ay, cornerX(to, w, j), cornerY(to, w, j), 2, null, 0, from, to, from, to);
        if (l > ((lines >>> sh) & 3)) lines = ((lines & ~(3 << sh)) | (l << sh)) >>> 0;
      }
    }
    if (center < 3) {
      const l = pinchLevel(los, 2 * fx + 1, 2 * fy + 1, 2 * tx + 1, 2 * ty + 1, 2, null, 0, from, to);
      if (l > center) center = l;
    }
  }
  return { lines, center };
}

/** The pair's static corner-line levels and center level, cached per setup on small grids. */
function staticPair(los: LosTable, from: number, to: number, out: Int32Array): void {
  if (los.obstacles.length === 0) {
    out[0] = 0;
    out[1] = 0;
    return;
  }
  const n = los.w * los.h;
  if (n > CACHE_MAX_CELLS) {
    const s = computeStatic(los, from, to);
    out[0] = s.lines | 0;
    out[1] = s.center;
    return;
  }
  if (!los.center) {
    los.center = new Uint8Array(n * n);
    los.lines = new Uint32Array(n * n);
  }
  const k = from * n + to;
  const c = los.center[k]!;
  if (c !== 0) {
    out[0] = los.lines![k]! | 0;
    out[1] = c - 1;
    return;
  }
  const s = computeStatic(los, from, to);
  los.lines![k] = s.lines;
  los.center[k] = s.center + 1;
  out[0] = s.lines | 0;
  out[1] = s.center;
}

const pairScratch = new Int32Array(2);

/** Is any static obstacle inside the bounding box of the two squares (other than the squares themselves)? */
export function obstacleBetween(los: LosTable, from: number, to: number): boolean {
  const w = los.w;
  const fx = from % w;
  const fy = Math.floor(from / w);
  const tx = to % w;
  const ty = Math.floor(to / w);
  const obs = los.obstacles;
  for (let k = 0; k < obs.length; k++) {
    const c = obs[k]!;
    if (c === from || c === to) continue;
    const cx = c % w;
    const cy = Math.floor(c / w);
    if ((cx - fx) * (cx - tx) <= 0 && (cy - fy) * (cy - ty) <= 0) return true;
  }
  return false;
}

/** Is `cell` inside the bounding box of `from` and `to`? (Only those squares can cross a line between them.) */
export function inBox(w: number, from: number, to: number, cell: number): boolean {
  const cx = cell % w;
  const cy = Math.floor(cell / w);
  return (cx - (from % w)) * (cx - (to % w)) <= 0 && (cy - Math.floor(from / w)) * (cy - Math.floor(to / w)) <= 0;
}

/** Even bits of a 2-bit-per-line word (one bit per line, in line i * 4 + j order at bit 2 * (i * 4 + j)). */
const EVEN = 0x55555555;
/** Lines set among the 4 even-bit positions of a byte. */
const POP4 = new Uint8Array(256);
for (let b = 0; b < 256; b++) POP4[b] = (b & 1) + ((b >> 2) & 1) + ((b >> 4) & 1) + ((b >> 6) & 1);

/** Creature-mask cache per grid size: translation-invariant, so keyed by offsets (grids up to this side). */
const MASK_MAX_SIDE = 16;

/**
 * The lines a square at offset (cx, cy) from the attacker's square blocks between the attacker's
 * square and a target at offset (tx, ty): bit 2 * (i * 4 + j) per corner line, bit 1 the center
 * line. Translation-invariant, so cached per offsets on grids up to MASK_MAX_SIDE a side.
 */
function blockMask(los: LosTable, tx: number, ty: number, cx: number, cy: number): number {
  const w = los.w;
  const h = los.h;
  let k = -1;
  if (w <= MASK_MAX_SIDE && h <= MASK_MAX_SIDE) {
    const W = 2 * w - 1;
    const H = 2 * h - 1;
    if (!los.masks) los.masks = new Uint32Array(W * H * W * H);
    k = ((ty + h - 1) * W + (tx + w - 1)) * (W * H) + (cy + h - 1) * W + (cx + w - 1);
    const m = los.masks[k]!;
    if (m !== 0) return m & 0x7fffffff;
  }
  // From square (0, 0) to square (tx, ty), in doubled coordinates, the blocker at (cx, cy); a
  // translation never changes which lines cross which square.
  const ox = tx < 0 ? -tx : 0;
  const oy = ty < 0 ? -ty : 0;
  const fx = ox;
  const fy = oy;
  const gx = tx + ox;
  const gy = ty + oy;
  const bx = cx + ox;
  const by = cy + oy;
  let m = 0;
  for (let i = 0; i < 4; i++) {
    const ax = 2 * fx + (i & 1 ? 2 : 0);
    const ay = 2 * fy + (i & 2 ? 2 : 0);
    for (let j = 0; j < 4; j++) if (crossesCell(ax, ay, 2 * gx + (j & 1 ? 2 : 0), 2 * gy + (j & 2 ? 2 : 0), bx, by, 2)) m |= 1 << (2 * (i * 4 + j));
  }
  if (crossesCell(2 * fx + 1, 2 * fy + 1, 2 * gx + 1, 2 * gy + 1, bx, by, 2)) m |= 2;
  if (k >= 0) los.masks![k] = (m | 0x80000000) >>> 0;
  return m;
}

/** Could a creature's square share a seam with another obstacle (an orthogonal neighbour that is one)? Cheap, and almost always no. */
function seamPossible(los: LosTable, occ: Int32Array, nOcc: number, from: number, to: number): boolean {
  const w = los.w;
  for (let k = 0; k < nOcc; k++) {
    const c = occ[k]!;
    const x = c % w;
    const y = (c - x) / w;
    if (levelAt(los, x - 1, y, occ, nOcc, from, to) > 0 || levelAt(los, x + 1, y, occ, nOcc, from, to) > 0) return true;
    if (levelAt(los, x, y - 1, occ, nOcc, from, to) > 0 || levelAt(los, x, y + 1, occ, nOcc, from, to) > 0) return true;
  }
  return false;
}

/** Scratch for creature pinch points (creaturePinches): x, y (doubled), orientation per point. */
const pinchPts = new Int32Array(3 * 256);

/**
 * The corner points where a creature's square touches another obstacle (a creature or a static
 * one) only diagonally (pinchLevel): each blocks at Half, a creature's level. Fills pinchPts with
 * (x, y, main) per point, main 1 when the pair is up-right/down-left (it closes lines running
 * down-right or up-left), and returns how many. `from` and `to` never count. Almost always 0.
 */
function creaturePinches(los: LosTable, occ: Int32Array, nOcc: number, from: number, to: number): number {
  const w = los.w;
  const h = los.h;
  const lv = los.level;
  const statics = los.obstacles.length > 0;
  let n = 0;
  const push = (x: number, y: number, main: number): void => {
    if (n < 256) {
      pinchPts[3 * n] = 2 * x;
      pinchPts[3 * n + 1] = 2 * y;
      pinchPts[3 * n + 2] = main;
      n++;
    }
  };
  for (let k = 0; k < nOcc; k++) {
    const c = occ[k]!;
    const x = c % w;
    const y = (c - x) / w;
    // Another creature diagonal to it (each pair once).
    for (let m = k + 1; m < nOcc; m++) {
      const d = occ[m]!;
      const dx = (d % w) - x;
      const dy = (d - (d % w)) / w - y;
      if ((dx !== 1 && dx !== -1) || (dy !== 1 && dy !== -1)) continue;
      // The shared corner is at (max x, max y); a down-right pair closes lines running up-right or down-left.
      push(dx > 0 ? x + 1 : x, dy > 0 ? y + 1 : y, dx === dy ? 0 : 1);
    }
    if (!statics) continue;
    for (let dy = -1; dy <= 1; dy += 2) {
      for (let dx = -1; dx <= 1; dx += 2) {
        const ox = x + dx;
        const oy = y + dy;
        if (ox < 0 || oy < 0 || ox >= w || oy >= h) continue;
        const o = oy * w + ox;
        if (o === from || o === to || lv[o] === 0) continue;
        push(dx > 0 ? x + 1 : x, dy > 0 ? y + 1 : y, dx === dy ? 0 : 1);
      }
    }
  }
  return n;
}

/**
 * Does the segment (x0, y0) -> (x1, y1) (doubled coordinates) pass through one of the first `n`
 * pinch points the way pinchLevel counts it: through the point, crossing between the pair, its
 * ends counting only when it leaves `ownStart` (enters `ownEnd`) there?
 */
function hitsPinch(n: number, x0: number, y0: number, x1: number, y1: number, ownStart: number, ownEnd: number, w: number): boolean {
  const dx = x1 - x0;
  const dy = y1 - y0;
  if (dx === 0 || dy === 0) return false;
  const main = (dx > 0) === (dy > 0) ? 1 : 0;
  const sx = dx > 0 ? 1 : -1;
  const sy = dy > 0 ? 1 : -1;
  for (let k = 0; k < n; k++) {
    if (pinchPts[3 * k + 2] !== main) continue;
    const px = pinchPts[3 * k]!;
    const py = pinchPts[3 * k + 1]!;
    if ((px - x0) * dy !== (py - y0) * dx) continue; // not on the line
    const along = (px - x0) * sx; // 0 at the start, |dx| at the end
    const len = dx * sx;
    if (along < 0 || along > len) continue;
    const X = px / 2;
    const Y = py / 2;
    if (along === 0 && (ownStart < 0 || (Y + (sy > 0 ? -1 : 0)) * w + X + (sx > 0 ? -1 : 0) !== ownStart)) continue;
    if (along === len && (ownEnd < 0 || (Y + (sy > 0 ? 0 : -1)) * w + X + (sx > 0 ? 0 : -1) !== ownEnd)) continue;
    return true;
  }
  return false;
}

/**
 * The cover a target on `to` has against an attack or effect from the square `from`. `occ`
 * holds the squares of creatures that may give cover (the caller leaves out the attacker, the
 * target, and anyone off the box), `nOcc` of them; each gives Half.
 */
export function coverDegree(los: LosTable, method: 'corners' | 'centers', from: number, to: number, occ: Int32Array, nOcc: number): number {
  if (from === to) return 0;
  staticPair(los, from, to, pairScratch);
  const w = los.w;
  const fx = from % w;
  const fy = (from - fx) / w;
  const tx = (to % w) - fx;
  const ty = (to - (to % w)) / w - fy;
  let c = 0;
  for (let k = 0; k < nOcc; k++) {
    const o = occ[k]!;
    const ox = o % w;
    c |= blockMask(los, tx, ty, ox - fx, (o - ox) / w - fy);
  }
  if (method === 'centers') {
    const l = pairScratch[1]!;
    if (l >= 1) return l;
    if (c & 2) return 1;
    // A creature's square at a corner point it shares with another obstacle (pinchLevel): Half.
    if (nOcc === 0) return 0;
    const pinches = creaturePinches(los, occ, nOcc, from, to);
    return pinches > 0 && hitsPinch(pinches, 2 * fx + 1, 2 * fy + 1, 2 * (fx + tx) + 1, 2 * (fy + ty) + 1, -1, -1, w) ? 1 : 0;
  }
  const p = pairScratch[0]! >>> 0;
  // A creature's square along a grid line: a seam with another obstacle (static or creature) blocks at Half.
  if (nOcc > 0 && ((tx >= -1 && tx <= 1) || (ty >= -1 && ty <= 1)) && seamPossible(los, occ, nOcc, from, to)) {
    for (let i = 0; i < 4; i++) {
      const ax = cornerX(from, w, i);
      const ay = cornerY(from, w, i);
      for (let j = 0; j < 4; j++) {
        const bx = cornerX(to, w, j);
        const by = cornerY(to, w, j);
        if (ax !== bx && ay !== by) continue;
        const bit = 1 << (2 * (i * 4 + j));
        if ((c | p | (p >>> 1)) & bit) continue;
        if (seamLevel(los, ax, ay, bx, by, occ, nOcc, from, to) >= 1) c |= bit;
      }
    }
  }
  const best = packedDegree(p, c);
  // A creature's square at a corner point it shares with another obstacle blocks a line through
  // that point at Half (pinchLevel). Creatures give only Half, so this can only lift a corner with
  // no line blocked at all: checked only then.
  if (best !== 0 || nOcc === 0) return best;
  const pinches = creaturePinches(los, occ, nOcc, from, to);
  if (pinches === 0) return 0;
  for (let i = 0; i < 4; i++) {
    const ax = cornerX(from, w, i);
    const ay = cornerY(from, w, i);
    for (let j = 0; j < 4; j++) {
      const bit = 1 << (2 * (i * 4 + j));
      if ((c | p | (p >>> 1)) & bit) continue;
      if (hitsPinch(pinches, ax, ay, cornerX(to, w, j), cornerY(to, w, j), from, to, w)) c |= bit;
    }
  }
  return packedDegree(p, c);
}

/** The attacker's best corner over static levels `p` (2 bits per line) and creature-blocked lines `c` (even bits). */
function packedDegree(p: number, c: number): number {
  if (p === 0 && (c & EVEN) === 0) return 0;
  const l1 = ((p | (p >>> 1)) & EVEN) | (c & EVEN);
  const l2 = (p >>> 1) & EVEN;
  const l3 = p & (p >>> 1) & EVEN;
  let best = 3;
  for (let i = 0; i < 4 && best > 0; i++) {
    const sh = i * 8;
    const n1 = POP4[(l1 >>> sh) & 0xff]!;
    const n2 = POP4[(l2 >>> sh) & 0xff]!;
    const n3 = POP4[(l3 >>> sh) & 0xff]!;
    let d = n1 === 0 ? 0 : 1;
    const d2 = n2 === 0 ? 0 : n2 <= 2 ? 1 : 2;
    if (d2 > d) d = d2;
    const d3 = byCount(n3);
    if (d3 > d) d = d3;
    if (d < best) best = d;
  }
  return best;
}

/** The degree from a point (x2, y2) in doubled coordinates (an area's origin) to a target on `to`. */
export function coverFromPoint(los: LosTable, method: 'corners' | 'centers', x2: number, y2: number, to: number, occ: Int32Array, nOcc: number, skipCell: number): number {
  const w = los.w;
  const tx = to % w;
  const ty = Math.floor(to / w);
  const block = (c: number, lv: number, cur: number[]): void => {
    const cx = c % w;
    const cy = Math.floor(c / w);
    if (method === 'centers') {
      if (lv > cur[0]! && crossesCell(x2, y2, 2 * tx + 1, 2 * ty + 1, cx, cy, 2)) cur[0] = lv;
      return;
    }
    for (let j = 0; j < 4; j++) if (lv > cur[j]! && crossesCell(x2, y2, 2 * tx + (j & 1 ? 2 : 0), 2 * ty + (j & 2 ? 2 : 0), cx, cy, 2)) cur[j] = lv;
  };
  const cur = [0, 0, 0, 0];
  const obs = los.obstacles;
  for (let k = 0; k < obs.length; k++) {
    const c = obs[k]!;
    if (c === to || c === skipCell) continue;
    block(c, los.level[c]!, cur);
  }
  for (let k = 0; k < nOcc; k++) block(occ[k]!, 1, cur);
  // Corner points two obstacles share (pinchLevel); skipped when nothing could pinch.
  const pinch = los.pinch || (nOcc > 0 && creaturePinches(los, occ, nOcc, to, skipCell) > 0);
  if (method === 'centers') {
    if (pinch && cur[0]! < 3) {
      const l = pinchLevel(los, x2, y2, 2 * tx + 1, 2 * ty + 1, 2, occ, nOcc, to, skipCell);
      if (l > cur[0]!) cur[0] = l;
    }
    return cur[0]!;
  }
  for (let j = 0; j < 4; j++) {
    const bx = 2 * tx + (j & 1 ? 2 : 0);
    const by = 2 * ty + (j & 2 ? 2 : 0);
    if (x2 !== bx && y2 !== by) {
      if (pinch && cur[j]! < 3) {
        const l = pinchLevel(los, x2, y2, bx, by, 2, occ, nOcc, to, skipCell, -1, to);
        if (l > cur[j]!) cur[j] = l;
      }
      continue;
    }
    const l = seamLevel(los, x2, y2, bx, by, occ, nOcc, to, skipCell);
    if (l > cur[j]!) cur[j] = l;
  }
  return fourLines(cur[0]! | (cur[1]! << 2) | (cur[2]! << 4) | (cur[3]! << 6), 0);
}

/**
 * Line of sight from `from` to `to` (walls only: '+' and '*' block sight partly, never
 * wholly): false when the target square is behind Total Cover from walls.
 */
export function clearLine(los: LosTable, method: 'corners' | 'centers', from: number, to: number): boolean {
  if (!los.walls || from === to) return true;
  staticPair(los, from, to, pairScratch);
  return method === 'centers' ? pairScratch[1]! < 3 : cornersDegree(pairScratch[0]! >>> 0) < 3;
}

/**
 * Area line of effect (glossary "Area of Effect", srd-raw.txt:32672-32677): is the square `cell`
 * cut off from the origin (x4, y4) in quadrupled coordinates, every straight line to it blocked
 * by Total Cover? Tested on lines to the square's center and four points just inside its
 * corners [U: a finite sample of "all straight lines"]. Only walls block. `originCell` (the
 * square holding a square-centered origin, or -1) never blocks.
 */
export function cutOff(los: LosTable, x4: number, y4: number, cell: number, originCell: number): boolean {
  if (!los.walls || cell === originCell) return false;
  const w = los.w;
  const cx = cell % w;
  const cy = Math.floor(cell / w);
  const px = [4 * cx + 2, 4 * cx + 1, 4 * cx + 3, 4 * cx + 1, 4 * cx + 3];
  const py = [4 * cy + 2, 4 * cy + 1, 4 * cy + 1, 4 * cy + 3, 4 * cy + 3];
  const obs = los.obstacles;
  for (let p = 0; p < 5; p++) {
    let blocked = false;
    for (let k = 0; k < obs.length && !blocked; k++) {
      const c = obs[k]!;
      if (c === cell || c === originCell || los.level[c]! < 3) continue;
      if (crossesCell(x4, y4, px[p]!, py[p]!, c % w, Math.floor(c / w), 4)) blocked = true;
    }
    // Two walls meeting at a corner close it (pinchLevel): Total only between two walls.
    if (!blocked && los.pinch && pinchLevel(los, x4, y4, px[p]!, py[p]!, 4, null, 0, cell, originCell) === 3) blocked = true;
    if (!blocked) return false;
  }
  return true;
}
