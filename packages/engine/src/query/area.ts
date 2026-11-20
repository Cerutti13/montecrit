// Where an area could go (docs/design/m1c.md 3.3): every legal anchor, grouped by the set of
// creatures it would cover, one representative per set. Mirrors askPlace's range rule, so
// every candidate is an anchor the engine offers.

import { AIMS, anchorRangeFt, creatureMaskLookup, creatureOriginPoint, latticeMask, originPoint, sizeFtOf } from '../grid/area.ts';
import { areaCutOff, losMode } from '../sim/cover.ts';
import type { ZoneAffects } from '../content/types.ts';
import { readFlag, zoneSpares, type QueryState, type Unit } from '../sim/state.ts';

export interface AreaCand {
  readonly anchor: number;
  /** Bits of the unit indexes it covers: 0-31 in lo, 32-63 in hi. */
  readonly sigLo: number;
  readonly sigHi: number;
  /** Living creatures covered that are hostile to the caster, and on its side (itself included). */
  readonly nEnemies: number;
  readonly nAllies: number;
}

/**
 * Anchors for an area (shape key `shapeKey`) that `caster` could place from `fromCell` within
 * `rangeFt`, one per distinct set of covered creatures: the nearest to `fromCell`, then the
 * lowest anchor index. Sorted by (sigHi, sigLo, anchor). Sets covering nobody are left out. A creature
 * the zone's `affects` spares isn't covered: it's neither a target nor friendly fire (step 7.3).
 */
export function areaCandidates(st: QueryState, caster: Unit, shapeKey: number, rangeFt: number, fromCell: number, out: AreaCand[], affects?: ZoneAffects): number {
  out.length = 0;
  const { w, h } = st.setup;
  const corner = readFlag(st, 'areaOriginOnGrid') === 'gridIntersection';
  const lw = corner ? w + 1 : w;
  const lh = corner ? h + 1 : h;
  const mask = latticeMask(st, shapeKey);
  const n = lw * lh;
  const lo = new Int32Array(n);
  const hi = new Int32Array(n);
  // M3 step 8: a square cut off from the origin by walls isn't in the area (grid/area.ts areaCells).
  const walls = losMode(st) === 2;
  // Inverse mask: a unit on (cx, cy) is covered from anchor (cx - dx, cy - dy) for each offset.
  for (const u of st.units) {
    if (u.life === 'dead' || (affects !== undefined && zoneSpares(affects, caster, u))) continue;
    const cx = u.cell % w;
    const cy = Math.floor(u.cell / w);
    for (let i = 0; i < mask.length; i += 2) {
      const ax = cx - mask[i]!;
      const ay = cy - mask[i + 1]!;
      if (ax < 0 || ax >= lw || ay < 0 || ay >= lh) continue;
      const a = ay * lw + ax;
      if (walls) {
        const [x4, y4, oc] = originPoint(st, a);
        if (areaCutOff(st, x4, y4, oc, u.cell, null)) continue;
      }
      if (u.idx < 32) lo[a]! |= 1 << u.idx;
      else hi[a]! |= 1 << (u.idx - 32);
    }
  }
  const best: { anchor: number; sigLo: number; sigHi: number; d: number }[] = [];
  for (let a = 0; a < n; a++) {
    if ((lo[a]! | hi[a]!) === 0) continue;
    const d = anchorRangeFt(st, fromCell, a);
    if (d > rangeFt) continue;
    let j = 0;
    while (j < best.length && (best[j]!.sigLo !== lo[a] || best[j]!.sigHi !== hi[a])) j++;
    if (j === best.length) best.push({ anchor: a, sigLo: lo[a]!, sigHi: hi[a]!, d });
    else if (d < best[j]!.d) best[j] = { anchor: a, sigLo: lo[a]!, sigHi: hi[a]!, d };
  }
  best.sort((x, y) => (x.sigHi !== y.sigHi ? (x.sigHi >>> 0) - (y.sigHi >>> 0) : x.sigLo !== y.sigLo ? (x.sigLo >>> 0) - (y.sigLo >>> 0) : x.anchor - y.anchor));
  for (const b of best) {
    let nEnemies = 0;
    let nAllies = 0;
    for (const u of st.units) {
      const on = u.idx < 32 ? (b.sigLo >>> u.idx) & 1 : (b.sigHi >>> (u.idx - 32)) & 1;
      if (!on || u.life === 'dead') continue;
      if (u.team === caster.team) nAllies++;
      else nEnemies++;
    }
    out.push({ anchor: b.anchor, sigLo: b.sigLo, sigHi: b.sigHi, nEnemies, nAllies });
  }
  return out.length;
}

export interface AimCand {
  readonly aim: number;
  /** Bits of the unit indexes it covers, as AreaCand's. */
  readonly sigLo: number;
  readonly sigHi: number;
  readonly nEnemies: number;
  readonly nAllies: number;
}

/**
 * The aims of an area starting from a creature on `fromCell` (shape key `shapeKey`), one per distinct
 * set of covered creatures: the first aim giving that set. Sets covering nobody are left out. Empty,
 * at the cost of a distance scan, when no enemy is within the shape's size + 5 ft or the farthest
 * square any aim's mask reaches, whichever is more (counted in squares, so it holds under any diagonal
 * rule and any coverage). A creature the zone's `affects` spares isn't covered.
 */
export function aimCandidates(st: QueryState, caster: Unit, shapeKey: number, fromCell: number, out: AimCand[], affects?: ZoneAffects): number {
  out.length = 0;
  const w = st.setup.w;
  const fx = fromCell % w;
  const fy = Math.floor(fromCell / w);
  // The squares the masks reach, at least size + 5 ft: under anyOverlap with selfAreaOrigin=squareEdge a
  // 90-ft or longer Cone's diagonal aims reach one square past that, so the exit reads the masks too.
  let reach = sizeFtOf(shapeKey) / 5 + 1;
  for (let aim = 0; aim < AIMS.length; aim++) reach = Math.max(reach, creatureMaskLookup(st, shapeKey, aim).r);
  let near = false;
  for (const u of st.units) {
    if (u.life === 'dead' || u.team === caster.team) continue;
    if (Math.max(Math.abs((u.cell % w) - fx), Math.abs(Math.floor(u.cell / w) - fy)) <= reach) {
      near = true;
      break;
    }
  }
  if (!near) return 0;
  const walls = losMode(st) === 2;
  for (let aim = 0; aim < AIMS.length; aim++) {
    const { r, cover } = creatureMaskLookup(st, shapeKey, aim);
    const side = 2 * r + 1;
    let sigLo = 0;
    let sigHi = 0;
    let nEnemies = 0;
    let nAllies = 0;
    for (const u of st.units) {
      if (u.life === 'dead' || (affects !== undefined && zoneSpares(affects, caster, u))) continue;
      const dx = (u.cell % w) - fx;
      const dy = Math.floor(u.cell / w) - fy;
      if (dx < -r || dx > r || dy < -r || dy > r || cover[(dy + r) * side + dx + r] === 0) continue;
      if (walls) {
        const [x4, y4, oc] = creatureOriginPoint(st, shapeKey, fromCell, aim);
        if (areaCutOff(st, x4, y4, oc, u.cell, null)) continue;
      }
      if (u.idx < 32) sigLo |= 1 << u.idx;
      else sigHi |= 1 << (u.idx - 32);
      if (u.team === caster.team) nAllies++;
      else nEnemies++;
    }
    if (nEnemies + nAllies === 0) continue;
    let dup = false;
    for (let j = 0; j < out.length && !dup; j++) dup = out[j]!.sigLo === sigLo && out[j]!.sigHi === sigHi;
    if (!dup) out.push({ aim, sigLo, sigHi, nEnemies, nAllies });
  }
  return out.length;
}
