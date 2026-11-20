// Coverage step 7.1: Cube, Square, Cone, Line and Emanation masks (docs/design/step7-plan.md).
// Rules: SRD 5.2.1 Cone (srd-raw.txt:33029-33040), Cube (33097-33101), Emanation (33380-33386),
// Line (33768-33773), Area of Effect's cut-off by Total Cover (32672-32677). The SRD has no
// grid rule for areas: what these pin is the model, under its flags.
import { describe, expect, it } from 'vitest';
import { EffectSchema } from '../src/content/schema.ts';
import { zoneShapeKey } from '../src/content/compile-spell.ts';
import { makeDeciders } from '../src/decide/make.ts';
import { AIMS, anchorCount, areaCells, areaCellsFrom, areaFromName, areaMask, includesOriginOf, latticeMask, NO_AIM, shapeKey, shapeOf, sizeFtOf, widthFtOf, type AreaCoverage, type AreaOrigin } from '../src/grid/area.ts';
import { cellName, parseCell } from '../src/grid/cells.ts';
import { areaCandidates } from '../src/query/area.ts';
import { DEFAULT_FLAGS, flagIndex, type RuleFlags } from '../src/rules/flags.ts';
import { createContext } from '../src/sim/fight.ts';
import { DUMMY, setup } from './helpers/build.ts';

const COVERAGES: readonly AreaCoverage[] = ['atLeastHalfSquare', 'squareCenterInside', 'anyOverlap'];
const ORIGINS: readonly AreaOrigin[] = ['squareCenter', 'gridIntersection'];
const SELF = ['squareCenter', 'squareEdge'] as const;
const [N, NE, E, SE, S, SW, W, NW] = [0, 1, 2, 3, 4, 5, 6, 7] as const;

type SelfOrigin = RuleFlags['selfAreaOrigin'];
const aimed = (key: number, aim: number, coverage: AreaCoverage = 'atLeastHalfSquare', self: SelfOrigin = 'squareCenter', origin: AreaOrigin = 'squareCenter') =>
  areaMask(key, origin, coverage, 'uniform', self, 'gridDistance', aim);
const placed = (key: number, origin: AreaOrigin = 'squareCenter', coverage: AreaCoverage = 'atLeastHalfSquare') => areaMask(key, origin, coverage, 'uniform', 'squareCenter', 'gridDistance', NO_AIM);
const eman = (key: number, reach: RuleFlags['emanationReach'] = 'gridDistance', diagonal: RuleFlags['diagonalCost'] = 'uniform', coverage: AreaCoverage = 'atLeastHalfSquare', origin: AreaOrigin = 'squareCenter') =>
  areaMask(key, origin, coverage, diagonal, 'squareCenter', reach, NO_AIM);

/** A mask as a set of "dx,dy" strings. */
const set = (m: Int16Array): Set<string> => {
  const out = new Set<string>();
  for (let i = 0; i < m.length; i += 2) out.add(`${m[i]},${m[i + 1]}`);
  return out;
};
const moved = (m: Int16Array, f: (x: number, y: number) => [number, number]): Set<string> => {
  const out = new Set<string>();
  for (let i = 0; i < m.length; i += 2) {
    const [x, y] = f(m[i]!, m[i + 1]!);
    out.add(`${x},${y}`);
  }
  return out;
};
const size = (m: Int16Array) => m.length / 2;

function scene(flags: Partial<RuleFlags> = {}, terrain?: string[], w = 12, h = 12) {
  const s = setup({ w, h, ...(terrain ? { terrain } : {}), flags, units: [{ seat: 'pc', team: 0, tpl: DUMMY, at: 'A1' }, { seat: 'mark', team: 1, tpl: DUMMY, at: `${String.fromCharCode(64 + w)}${h}` }] });
  return createContext(s, 1, 0, makeDeciders(s), null).st;
}
const from = (st: ReturnType<typeof scene>, key: number, at: string, aim: number) => {
  const out: number[] = [];
  areaCellsFrom(st, key, parseCell(at, st.setup.w, st.setup.h), aim, out);
  return out.map((c) => cellName(c, st.setup.w));
};

describe('shape keys: existing keys stay identical, new fields sit above them', () => {
  it('a Sphere and a Cylinder keep their numbers; size, width and the origin bit read back without leaking into the shape', () => {
    expect(shapeKey('sphere', 20)).toBe((1 << 12) | 20);
    expect(shapeKey('cylinder', 5)).toBe((2 << 12) | 5);
    const line = shapeKey('line', 100, 5);
    expect([shapeOf(line), sizeFtOf(line), widthFtOf(line)]).toEqual([5, 100, 5]);
    expect(shapeOf(shapeKey('line', 60, 1000))).toBe(5);
    const em = shapeKey('emanation', 10, undefined, true);
    expect([shapeOf(em), sizeFtOf(em), widthFtOf(em), includesOriginOf(em)]).toEqual([6, 10, 0, true]);
    expect(includesOriginOf(shapeKey('emanation', 10))).toBe(false);
    expect(shapeKey('emanation', 10, undefined, false)).toBe(shapeKey('emanation', 10));
  });

  it('a Square is the Cube\'s key (no altitude on a flat grid); width only on a Line, includesOrigin only on an Emanation', () => {
    expect(shapeKey('square', 15)).toBe(shapeKey('cube', 15));
    expect(() => shapeKey('line', 30)).toThrow(/needs a width/);
    expect(() => shapeKey('cone', 30, 5)).toThrow(/no width/);
    expect(() => shapeKey('cone', 30, undefined, true)).toThrow(/no includesOrigin/);
    expect(() => shapeKey('line', 30, 7)).toThrow(/multiple of 5/);
    expect(() => shapeKey('line', 30, 1025)).toThrow(/multiple of 5/);
  });

  it('the zone forms compile to those keys and refuse each other\'s fields', () => {
    const zone = (z: object) => {
      const r = EffectSchema.safeParse({ id: 'a', name: 'A', zone: z });
      return r.success ? zoneShapeKey(r.data.zone!) : 'refused';
    };
    expect(zone({ shape: 'sphere', radius: 20 })).toBe(shapeKey('sphere', 20));
    expect(zone({ shape: 'cylinder', radius: 5, height: 40 })).toBe(shapeKey('cylinder', 5));
    expect(zone({ shape: 'cube', size: 15 })).toBe(shapeKey('cube', 15));
    expect(zone({ shape: 'square', size: 15 })).toBe(shapeKey('cube', 15));
    expect(zone({ shape: 'cone', size: 15 })).toBe(shapeKey('cone', 15));
    expect(zone({ shape: 'line', size: 100, width: 5 })).toBe(shapeKey('line', 100, 5));
    expect(zone({ shape: 'emanation', size: 10, includesOrigin: true })).toBe(shapeKey('emanation', 10, undefined, true));
    expect(zone({ shape: 'emanation', size: 15 })).toBe(shapeKey('emanation', 15));
    for (const bad of [{ shape: 'line', size: 100 }, { shape: 'cone', size: 15, width: 5 }, { shape: 'cone', radius: 15 }, { shape: 'sphere', size: 15 }, { shape: 'cube', size: 15, includesOrigin: true }, { shape: 'wall', size: 15 }]) expect(zone(bad), JSON.stringify(bad)).toBe('refused');
    // The compiled form of a zone that has neither field carries neither (C3).
    const parsed = EffectSchema.parse({ id: 'a', name: 'A', zone: { shape: 'emanation', size: 15 } });
    expect(parsed.zone).toEqual({ shape: 'emanation', size: 15, difficult: false });
  });
});

describe('a Sphere and a Cylinder: the masks before step 7, byte for byte', () => {
  // The pre-step-7 builder, kept here as the reference.
  const old = (key: number, origin: AreaOrigin, coverage: AreaCoverage): number[] => {
    const U = 128;
    const R = ((key & 4095) * U) / 5;
    const R2 = R * R;
    const o = origin === 'squareCenter' ? U / 2 : 0;
    const n = Math.ceil((key & 4095) / 5) + 1;
    const out: number[] = [];
    for (let dy = -n; dy <= n; dy++) {
      for (let dx = -n; dx <= n; dx++) {
        const x0 = dx * U - o;
        const y0 = dy * U - o;
        let covered: boolean;
        if (coverage === 'squareCenterInside') {
          const cx = x0 + U / 2;
          const cy = y0 + U / 2;
          covered = cx * cx + cy * cy <= R2;
        } else if (coverage === 'anyOverlap') {
          const nx = Math.min(Math.max(0, x0), x0 + U);
          const ny = Math.min(Math.max(0, y0), y0 + U);
          covered = nx * nx + ny * ny < R2;
        } else {
          let inside = 0;
          for (let j = 0; j < 64; j++) {
            const sy = y0 + 2 * j + 1;
            for (let i = 0; i < 64; i++) {
              const sx = x0 + 2 * i + 1;
              if (sx * sx + sy * sy <= R2) inside++;
            }
          }
          covered = inside >= 32 * 64;
        }
        if (covered) out.push(dx, dy);
      }
    }
    return out;
  };

  it('every size in use, under all three coverages and both origins', () => {
    for (const shape of ['sphere', 'cylinder'] as const) {
      for (const r of [5, 10, 15, 20, 30, 40]) {
        for (const o of ORIGINS) for (const c of COVERAGES) expect(Array.from(placed(shapeKey(shape, r), o, c)), `${shape} ${r} ${o} ${c}`).toEqual(old(shapeKey(shape, r), o, c));
      }
    }
  });
});

describe('Cube [Area of Effect]: from a point, and from a creature', () => {
  it('from a point: an n x n block around the anchor, an even size biased toward +x, +y', () => {
    expect(Array.from(placed(shapeKey('cube', 5)))).toEqual([0, 0]);
    expect(Array.from(placed(shapeKey('cube', 10)))).toEqual([0, 0, 1, 0, 0, 1, 1, 1]);
    expect(Array.from(placed(shapeKey('cube', 15)))).toEqual([-1, -1, 0, -1, 1, -1, -1, 0, 0, 0, 1, 0, -1, 1, 0, 1, 1, 1]);
    const c20 = placed(shapeKey('cube', 20));
    expect(size(c20)).toBe(16);
    expect([Array.from(c20).filter((_, i) => i % 2 === 0).reduce((a, b) => Math.min(a, b)), Array.from(c20).filter((_, i) => i % 2 === 0).reduce((a, b) => Math.max(a, b))]).toEqual([-1, 2]);
  });

  it('from a point under gridIntersection: the anchor is the block\'s corner', () => {
    expect(Array.from(placed(shapeKey('cube', 10), 'gridIntersection'))).toEqual([0, 0, 1, 0, 0, 1, 1, 1]);
    expect(Array.from(placed(shapeKey('cube', 15), 'gridIntersection')).slice(0, 2)).toEqual([0, 0]);
    expect(size(placed(shapeKey('cube', 15), 'gridIntersection'))).toBe(9);
  });

  it('a block is whole squares, so all three coverages agree', () => {
    for (const o of ORIGINS) for (const c of COVERAGES) expect(Array.from(placed(shapeKey('cube', 15), o, c))).toEqual(Array.from(placed(shapeKey('cube', 15), o, 'atLeastHalfSquare')));
    for (let aim = 0; aim < 8; aim++) for (const c of COVERAGES) expect(Array.from(aimed(shapeKey('cube', 15), aim, c))).toEqual(Array.from(aimed(shapeKey('cube', 15), aim)));
  });

  it('from a creature: 4 face-centered and 4 corner-touching placements, none on its own square (33097-33101)', () => {
    const c15 = shapeKey('cube', 15);
    expect(set(aimed(c15, E))).toEqual(new Set(['1,-1', '2,-1', '3,-1', '1,0', '2,0', '3,0', '1,1', '2,1', '3,1']));
    expect(set(aimed(c15, N))).toEqual(new Set(['-1,-3', '0,-3', '1,-3', '-1,-2', '0,-2', '1,-2', '-1,-1', '0,-1', '1,-1']));
    expect(set(aimed(c15, NE))).toEqual(new Set(['1,-3', '2,-3', '3,-3', '1,-2', '2,-2', '3,-2', '1,-1', '2,-1', '3,-1']));
    expect(set(aimed(c15, SW))).toEqual(new Set(['-3,1', '-2,1', '-1,1', '-3,2', '-2,2', '-1,2', '-3,3', '-2,3', '-1,3']));
    for (let aim = 0; aim < 8; aim++) {
      expect(size(aimed(c15, aim))).toBe(9);
      expect(set(aimed(c15, aim)).has('0,0')).toBe(false);
    }
    // An even size keeps the +x, +y bias across the aim.
    expect(set(aimed(shapeKey('cube', 10), E))).toEqual(new Set(['1,0', '2,0', '1,1', '2,1']));
    expect(set(aimed(shapeKey('cube', 10), N))).toEqual(new Set(['0,-2', '1,-2', '0,-1', '1,-1']));
    // A Cube touches the square whichever point on it the origin is.
    for (let aim = 0; aim < 8; aim++) expect(set(aimed(c15, aim, 'atLeastHalfSquare', 'squareEdge'))).toEqual(set(aimed(c15, aim)));
  });
});

describe('Cone and Line: pinned sizes from the integer port', () => {
  // [shape, E center, SE center, E edge, SE edge] under atLeastHalfSquare.
  const half: [string, number, number, number, number, number][] = [
    ['15-ft cone', shapeKey('cone', 15), 5, 4, 5, 6],
    ['30-ft cone', shapeKey('cone', 30), 22, 18, 18, 20],
    ['60-ft cone', shapeKey('cone', 60), 82, 72, 72, 72],
    ['30x5 line', shapeKey('line', 30, 5), 6, 4, 6, 4],
    ['100x5 line', shapeKey('line', 100, 5), 20, 14, 20, 14],
    ['60x10 line', shapeKey('line', 60, 10), 34, 24, 36, 24],
  ];
  it.each(half)('%s at least half of a square', (_n, key, eC, seC, eE, seE) => {
    expect([size(aimed(key, E)), size(aimed(key, SE)), size(aimed(key, E, 'atLeastHalfSquare', 'squareEdge')), size(aimed(key, SE, 'atLeastHalfSquare', 'squareEdge'))]).toEqual([eC, seC, eE, seE]);
  });

  it('the coverage flag applies: center inside and any overlap give their own squares', () => {
    const n = (key: number, aim: number, c: AreaCoverage, s: SelfOrigin = 'squareCenter') => size(aimed(key, aim, c, s));
    const c15 = shapeKey('cone', 15);
    const c30 = shapeKey('cone', 30);
    expect([n(c15, E, 'squareCenterInside'), n(c15, SE, 'squareCenterInside'), n(c15, E, 'anyOverlap'), n(c15, SE, 'anyOverlap')]).toEqual([7, 6, 9, 10]);
    expect([n(c15, E, 'anyOverlap', 'squareEdge'), n(c15, SE, 'anyOverlap', 'squareEdge')]).toEqual([7, 11]);
    expect([n(c30, E, 'squareCenterInside'), n(c30, SE, 'squareCenterInside'), n(c30, E, 'anyOverlap'), n(c30, SE, 'anyOverlap')]).toEqual([24, 20, 30, 28]);
    const l = shapeKey('line', 60, 10);
    expect([n(l, E, 'squareCenterInside'), n(l, SE, 'squareCenterInside'), n(l, E, 'anyOverlap'), n(l, SE, 'anyOverlap')]).toEqual([36, 24, 38, 44]);
  });

  it('a Cone\'s width at a point equals its distance from the point of origin: a 15-ft Cone east, square by square', () => {
    expect(set(aimed(shapeKey('cone', 15), E))).toEqual(new Set(['2,-1', '1,0', '2,0', '3,0', '2,1']));
    expect(set(aimed(shapeKey('cone', 15), E, 'atLeastHalfSquare', 'squareEdge'))).toEqual(new Set(['3,-1', '1,0', '2,0', '3,0', '3,1']));
    expect(set(aimed(shapeKey('cone', 15), SE))).toEqual(new Set(['1,1', '2,1', '1,2', '2,2']));
    expect(set(aimed(shapeKey('cone', 15), SE, 'atLeastHalfSquare', 'squareEdge'))).toEqual(new Set(['1,1', '2,1', '3,2', '1,2', '2,2', '2,3']));
  });

  it('a Line covers its length and its width: 5 wide is one row, 10 wide from a center adds half-covered rows, a diagonal is 4 squares per 30 ft', () => {
    const row = Array.from({ length: 20 }, (_, i) => `${i + 1},0`);
    expect(set(aimed(shapeKey('line', 100, 5), E))).toEqual(new Set(row));
    expect(set(aimed(shapeKey('line', 30, 5), SE))).toEqual(new Set(['1,1', '2,2', '3,3', '4,4']));
    const wide = set(aimed(shapeKey('line', 60, 10), E));
    expect(wide.has('12,0') && wide.has('11,1') && wide.has('11,-1')).toBe(true);
    expect(wide.has('12,1') || wide.has('12,-1') || wide.has('13,0') || wide.has('1,2')).toBe(false);
  });

  it('the aims are compass points: north is up the map and east is across it', () => {
    expect(AIMS).toEqual(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']);
    const line = shapeKey('line', 5, 5);
    expect([N, NE, E, SE, S, SW, W, NW].map((a) => Array.from(aimed(line, a, 'anyOverlap', 'squareEdge')).join(',')).filter((_, i) => i % 2 === 0)).toEqual(['0,-1', '1,0', '0,1', '-1,0']);
    const adjacent = (a: number) => set(aimed(shapeKey('line', 10, 5), a)).has(['0,-1', '1,-1', '1,0', '1,1', '0,1', '-1,1', '-1,0', '-1,-1'][a]!);
    expect([N, NE, E, SE, S, SW, W, NW].map(adjacent)).toEqual(Array(8).fill(true));
    expect(set(aimed(shapeKey('line', 10, 5), N)).has('0,1')).toBe(false);
    expect(set(aimed(shapeKey('line', 10, 5), NE)).has('-1,1')).toBe(false);
  });

  it('each rotated direction equals its reflection, at every coverage and both self origins', () => {
    const keys = [shapeKey('cone', 15), shapeKey('cone', 30), shapeKey('line', 30, 5), shapeKey('line', 60, 10), shapeKey('cube', 15), shapeKey('cube', 10)];
    const transpose = (x: number, y: number): [number, number] => [y, x];
    const flipX = (x: number, y: number): [number, number] => [-x, y];
    const flipY = (x: number, y: number): [number, number] => [x, -y];
    for (const k of keys) {
      for (const c of COVERAGES) {
        for (const so of SELF) {
          const m = (a: number) => aimed(k, a, c, so);
          expect(moved(m(E), flipX)).toEqual(set(m(W)));
          expect(moved(m(N), flipY)).toEqual(set(m(S)));
          expect(moved(m(E), transpose)).toEqual(set(m(S)));
          expect(moved(m(NE), flipX)).toEqual(set(m(NW)));
          expect(moved(m(NE), flipY)).toEqual(set(m(SE)));
          expect(moved(m(SE), flipX)).toEqual(set(m(SW)));
          expect(moved(m(SE), transpose)).toEqual(set(m(SE)));
        }
      }
    }
  });

  it('a Cone\'s and Line\'s point of origin isn\'t included (33039-33040, 33772-33773), under any coverage', () => {
    for (const k of [shapeKey('cone', 15), shapeKey('cone', 60), shapeKey('line', 30, 5), shapeKey('line', 60, 10)]) {
      for (let aim = 0; aim < 8; aim++) for (const c of COVERAGES) for (const so of SELF) expect(set(aimed(k, aim, c, so)).has('0,0')).toBe(false);
    }
  });

  it('they need an aim, and shapes with no direction refuse one', () => {
    expect(() => placed(shapeKey('cone', 15))).toThrow(/needs an aim/);
    expect(() => placed(shapeKey('line', 30, 5))).toThrow(/needs an aim/);
    expect(() => aimed(shapeKey('sphere', 20), E)).toThrow(/takes no aim/);
    expect(() => aimed(shapeKey('emanation', 10), E)).toThrow(/takes no aim/);
    expect(() => aimed(shapeKey('cone', 15), 8)).toThrow(/unknown aim/);
    expect(() => aimed((9 << 12) | 5, NO_AIM)).toThrow(/unknown area shape/);
  });
});

describe('Emanation: extends from a creature in all directions (33380-33386)', () => {
  it('gridDistance: a 10-ft Emanation is the 5x5 block by the p.13 grid rule, its origin left out', () => {
    expect(size(eman(shapeKey('emanation', 10)))).toBe(24);
    expect(size(eman(shapeKey('emanation', 15)))).toBe(48);
    expect(size(eman(shapeKey('emanation', 5)))).toBe(8);
    const m = set(eman(shapeKey('emanation', 10)));
    expect(m.has('0,0')).toBe(false);
    expect(m.has('2,2') && m.has('-2,-2') && m.has('2,0')).toBe(true);
    expect(m.has('3,0')).toBe(false);
  });

  it('gridDistance reads the diagonal rule: alternate 5/10 rounds the block', () => {
    expect(size(eman(shapeKey('emanation', 10), 'gridDistance', 'alternate'))).toBe(20);
    expect(set(eman(shapeKey('emanation', 10), 'gridDistance', 'alternate')).has('2,2')).toBe(false);
    expect(size(eman(shapeKey('emanation', 15), 'gridDistance', 'alternate'))).toBe(36);
  });

  it('radial: a Sphere of that radius around the creature, under the coverage flag, its origin left out', () => {
    const n = (ft: number, c: AreaCoverage) => size(eman(shapeKey('emanation', ft), 'radial', 'uniform', c));
    expect([n(10, 'atLeastHalfSquare'), n(10, 'squareCenterInside'), n(10, 'anyOverlap')]).toEqual([8, 12, 20]);
    expect([n(15, 'atLeastHalfSquare'), n(15, 'squareCenterInside'), n(15, 'anyOverlap')]).toEqual([24, 28, 44]);
    expect(n(5, 'atLeastHalfSquare')).toBe(0); // a Sphere's 5-ft radius covers only its own square
    for (const ft of [10, 15, 20]) for (const c of COVERAGES) {
      const sphere = set(placed(shapeKey('sphere', ft), 'squareCenter', c));
      sphere.delete('0,0');
      expect(set(eman(shapeKey('emanation', ft), 'radial', 'uniform', c))).toEqual(sphere);
    }
  });

  it('its origin is in the area only if its creator decides so', () => {
    for (const reach of ['gridDistance', 'radial'] as const) {
      const out = set(eman(shapeKey('emanation', 10), reach));
      const inc = set(eman(shapeKey('emanation', 10, undefined, true), reach));
      expect(out.has('0,0')).toBe(false);
      expect(inc.has('0,0')).toBe(true);
      expect(inc.size).toBe(out.size + 1);
    }
  });

  it('gridDistance doesn\'t depend on coverage', () => {
    for (const c of COVERAGES) expect(Array.from(eman(shapeKey('emanation', 15), 'gridDistance', 'uniform', c))).toEqual(Array.from(eman(shapeKey('emanation', 15))));
  });
});

describe('every shape is defined under all three coverages and both areaOriginOnGrid values', () => {
  it('a Cone\'s, Line\'s, creature-Cube\'s and Emanation\'s squares don\'t change with areaOriginOnGrid', () => {
    for (const c of COVERAGES) {
      for (const k of [shapeKey('cone', 15), shapeKey('cone', 60), shapeKey('line', 100, 5), shapeKey('cube', 15)]) {
        for (let aim = 0; aim < 8; aim++) expect(Array.from(aimed(k, aim, c, 'squareCenter', 'gridIntersection'))).toEqual(Array.from(aimed(k, aim, c)));
      }
      for (const reach of ['gridDistance', 'radial'] as const) expect(Array.from(eman(shapeKey('emanation', 10), reach, 'uniform', c, 'gridIntersection'))).toEqual(Array.from(eman(shapeKey('emanation', 10), reach, 'uniform', c)));
    }
  });

  it('areaCellsFrom gives every shape, flag and aim combination a result, on the same squares under both areaOriginOnGrid values', () => {
    const shapes = [shapeKey('sphere', 10), shapeKey('cylinder', 10), shapeKey('cube', 10), shapeKey('cube', 15), shapeKey('cone', 15), shapeKey('line', 30, 5), shapeKey('emanation', 10), shapeKey('emanation', 10, undefined, true)];
    for (const coverage of COVERAGES) {
      for (const so of SELF) {
        for (const reach of ['gridDistance', 'radial'] as const) {
          const flags = { areaGridCoverage: coverage, selfAreaOrigin: so, emanationReach: reach };
          const a = scene({ ...flags, areaOriginOnGrid: 'squareCenter' });
          const b = scene({ ...flags, areaOriginOnGrid: 'gridIntersection' });
          for (const k of shapes) {
            const shape = shapeOf(k);
            const aims = shape === 4 || shape === 5 ? [0, 1, 2, 3, 4, 5, 6, 7] : shape === 3 ? [NO_AIM, 0, 1, 2, 3, 4, 5, 6, 7] : [NO_AIM];
            for (const aim of aims) expect(from(b, k, 'F6', aim), `${k} ${aim}`).toEqual(from(a, k, 'F6', aim));
          }
        }
      }
    }
  });

  it('a Cube on the lattice follows areaOriginOnGrid; the creature-origin shapes have no lattice form and refuse it', () => {
    const a = scene();
    const b = scene({ areaOriginOnGrid: 'gridIntersection' });
    const cells: number[] = [];
    areaCells(a, shapeKey('cube', 15), parseCell('F6', 12, 12), cells);
    expect(cells.map((c) => cellName(c, 12))).toEqual(['E5', 'F5', 'G5', 'E6', 'F6', 'G6', 'E7', 'F7', 'G7']);
    expect(anchorCount(b)).toBe(13 * 13);
    areaCells(b, shapeKey('cube', 15), 5 * 13 + 5, cells); // the corner at the top left of F6
    expect(cells.map((c) => cellName(c, 12))).toEqual(['F6', 'G6', 'H6', 'F7', 'G7', 'H7', 'F8', 'G8', 'H8']);
    for (const k of [shapeKey('cone', 15), shapeKey('line', 30, 5), shapeKey('emanation', 10)]) {
      expect(() => areaCells(a, k, 0, cells)).toThrow(/starts from a creature/);
      expect(() => latticeMask(b, k)).toThrow(/starts from a creature/);
      expect(() => areaCandidates(a, a.units[0]!, k, 60, 0, [])).toThrow(/starts from a creature/);
    }
  });
});

describe('areaCellsFrom: the cell-based way onto the grid', () => {
  it('its cell is a square, never a lattice index: F6 lands on F6\'s neighbors under gridIntersection', () => {
    const st = scene({ areaOriginOnGrid: 'gridIntersection' });
    expect(from(st, shapeKey('cone', 15), 'F6', E)).toEqual(['H5', 'G6', 'H6', 'I6', 'H7']);
    expect(from(st, shapeKey('emanation', 5), 'F6', NO_AIM)).toEqual(['E5', 'F5', 'G5', 'E6', 'G6', 'E7', 'F7', 'G7']);
  });

  it('squares off the map are dropped', () => {
    const st = scene();
    expect(from(st, shapeKey('emanation', 5), 'A1', NO_AIM)).toEqual(['B1', 'A2', 'B2']);
    expect(from(st, shapeKey('line', 100, 5), 'J1', E)).toEqual(['K1', 'L1']);
    expect(from(st, shapeKey('cone', 15), 'A1', N)).toEqual([]);
  });

  it('reads selfAreaOrigin and the coverage for a Cone, emanationReach and the diagonal rule for an Emanation', () => {
    expect(from(scene({ selfAreaOrigin: 'squareEdge' }), shapeKey('cone', 15), 'F6', E)).toEqual(['I5', 'G6', 'H6', 'I6', 'I7']);
    expect(from(scene({ areaGridCoverage: 'anyOverlap' }), shapeKey('cone', 15), 'F6', E)).toHaveLength(9);
    expect(from(scene({ emanationReach: 'radial' }), shapeKey('emanation', 10), 'F6', NO_AIM)).toHaveLength(8);
    expect(from(scene({ diagonalCost: 'alternate' }), shapeKey('emanation', 10), 'F6', NO_AIM)).toHaveLength(20);
    // A radial Emanation doesn't count squares, so the diagonal rule doesn't reach it.
    expect(from(scene({ emanationReach: 'radial', diagonalCost: 'alternate' }), shapeKey('emanation', 10), 'F6', NO_AIM)).toHaveLength(8);
    expect(from(scene({ areaGridCoverage: 'anyOverlap' }), shapeKey('emanation', 10), 'F6', NO_AIM)).toHaveLength(24);
    expect(from(scene({ areaGridCoverage: 'anyOverlap', emanationReach: 'radial' }), shapeKey('emanation', 10), 'F6', NO_AIM)).toHaveLength(20);
    expect(from(scene({ areaGridCoverage: 'squareCenterInside' }), shapeKey('sphere', 10), 'F6', NO_AIM)).toHaveLength(13);
  });

  it('`mark` records exactly the flags the shape\'s squares depend on, and never areaOriginOnGrid', () => {
    const used = (key: number, aim: number, flags: Partial<RuleFlags> = {}) => {
      const st = scene(flags);
      areaCellsFrom(st, key, parseCell('F6', 12, 12), aim, [], st);
      return (Object.keys(DEFAULT_FLAGS) as (keyof RuleFlags)[]).filter((k) => st.flagsUsed[flagIndex(k)] === 1).sort();
    };
    expect(used(shapeKey('cone', 15), E)).toEqual(['areaGridCoverage', 'selfAreaOrigin']);
    expect(used(shapeKey('line', 30, 5), E)).toEqual(['areaGridCoverage', 'selfAreaOrigin']);
    expect(used(shapeKey('emanation', 10), NO_AIM)).toEqual(['diagonalCost', 'emanationReach']);
    expect(used(shapeKey('emanation', 10), NO_AIM, { emanationReach: 'radial' })).toEqual(['areaGridCoverage', 'emanationReach']);
    expect(used(shapeKey('cube', 15), E)).toEqual([]);
    expect(used(shapeKey('sphere', 10), NO_AIM)).toEqual(['areaGridCoverage']);
    // No mark, no flagsUsed.
    const st = scene();
    areaCellsFrom(st, shapeKey('cone', 15), 0, E, []);
    expect(st.flagsUsed.every((v) => v === 0)).toBe(true);
  });

  it('a decider reading it records its flags as AI flags; the lattice path never touches the new flags (old reports hold)', () => {
    const st = scene();
    st.deciding = 1;
    areaCellsFrom(st, shapeKey('cone', 15), 0, E, []);
    expect(st.aiFlags[flagIndex('selfAreaOrigin')]).toBe(1);
    const lat = scene();
    lat.deciding = 1;
    areaCells(lat, shapeKey('sphere', 20), 0, []);
    areaCells(lat, shapeKey('cube', 15), 0, []);
    for (const k of ['selfAreaOrigin', 'emanationReach', 'emanationCastTrigger', 'diagonalCost'] as const) expect(lat.aiFlags[flagIndex(k)], k).toBe(0);
  });

  it('names read `F6` and `F6>NE`', () => {
    const st = scene();
    expect(areaFromName(st, parseCell('F6', 12, 12), NO_AIM)).toBe('F6');
    expect(areaFromName(st, parseCell('F6', 12, 12), NE)).toBe('F6>NE');
  });

  describe('a location every line from the point of origin is blocked from isn\'t in the area (32672-32677)', () => {
    const T = ['.........', '.........', '....#....', '.........', '.........'];
    const on = (flags: Partial<RuleFlags>, key: number, at: string, aim: number) => from(scene(flags, T, 9, 5), key, at, aim);

    it('a Line stops at a wall, from a creature origin', () => {
      const all = from(scene({ losMethod: 'stubbed' }, T, 9, 5), shapeKey('line', 30, 5), 'B3', E);
      expect(all).toEqual(['C3', 'D3', 'E3', 'F3', 'G3', 'H3']);
      // The wall's own square stays in (cutOff never lets a wall block itself; nothing stands there). What's behind it is out.
      expect(on({}, shapeKey('line', 30, 5), 'B3', E)).toEqual(['C3', 'D3', 'E3']);
      // Under squareEdge the origin moves but the wall still stands in the way.
      expect(on({ selfAreaOrigin: 'squareEdge' }, shapeKey('line', 30, 5), 'B3', E)).toEqual(['C3', 'D3', 'E3']);
    });

    it('an Emanation is cut off behind a wall, from its creature\'s square, under both areaOriginOnGrid values', () => {
      const key = shapeKey('emanation', 15);
      for (const areaOriginOnGrid of ORIGINS) {
        const got = on({ areaOriginOnGrid }, key, 'C3', NO_AIM);
        expect(got).toContain('D3');
        expect(got).toContain('E3');
        expect(got).not.toContain('F3');
        expect(got).toContain('F1');
      }
      // Its own square stays in when it's included, wall or no wall.
      expect(on({}, shapeKey('emanation', 15, undefined, true), 'C3', NO_AIM)).toContain('C3');
    });

    it('a Cube from a creature, with a wall inside it', () => {
      const got = on({}, shapeKey('cube', 15), 'D3', E);
      expect(got).toEqual(['E2', 'E3', 'E4']);
      const stub = from(scene({ losMethod: 'stubbed' }, T, 9, 5), shapeKey('cube', 15), 'D3', E);
      expect(stub).toEqual(['E2', 'F2', 'G2', 'E3', 'F3', 'G3', 'E4', 'F4', 'G4']);
    });

    it('squareEdge starts the cut-off from the edge: from the corner touching a wall, all of a Cone behind it is out', () => {
      const W2 = ['.......', '..#....', '.......', '.......'];
      const stubbed = from(scene({ selfAreaOrigin: 'squareEdge', losMethod: 'stubbed' }, W2, 7, 4), shapeKey('cone', 15), 'B3', NE);
      expect(stubbed.length).toBeGreaterThan(1);
      expect(from(scene({ selfAreaOrigin: 'squareEdge' }, W2, 7, 4), shapeKey('cone', 15), 'B3', NE)).toEqual(['C2']);
      // From the square's center the same wall leaves lines past its corners.
      expect(from(scene({}, W2, 7, 4), shapeKey('cone', 15), 'B3', NE)).toEqual(['C1', 'C2', 'D2']);
    });

    it('a marked cut-off records losMethod', () => {
      const st = scene({}, T, 9, 5);
      areaCellsFrom(st, shapeKey('line', 30, 5), parseCell('B3', 9, 5), E, [], st);
      expect(st.flagsUsed[flagIndex('losMethod')]).toBe(1);
    });
  });
});

describe('the mask memo is keyed by every input', () => {
  it('no input shares another\'s entry, in either order of first use', () => {
    const k = shapeKey('emanation', 25);
    // diagonalCost: first one value, then the other.
    const u = size(eman(k, 'gridDistance', 'uniform'));
    const a = size(eman(k, 'gridDistance', 'alternate'));
    expect([u, a]).toEqual([120, 88]);
    // selfAreaOrigin.
    const c = shapeKey('cone', 25);
    expect(set(aimed(c, E, 'atLeastHalfSquare', 'squareCenter'))).not.toEqual(set(aimed(c, E, 'atLeastHalfSquare', 'squareEdge')));
    // emanationReach.
    expect(size(eman(k, 'radial'))).not.toBe(size(eman(k, 'gridDistance')));
    // The aim.
    expect(set(aimed(c, E))).not.toEqual(set(aimed(c, W)));
    // Coverage and origin, as before.
    expect(size(aimed(c, E, 'anyOverlap'))).not.toBe(size(aimed(c, E, 'atLeastHalfSquare')));
    expect(set(placed(shapeKey('cube', 25), 'gridIntersection'))).not.toEqual(set(placed(shapeKey('cube', 25), 'squareCenter')));
  });

  it('the same inputs hand back the same array', () => {
    const k = shapeKey('line', 45, 5);
    expect(aimed(k, SE)).toBe(aimed(k, SE));
    expect(eman(shapeKey('emanation', 35))).toBe(eman(shapeKey('emanation', 35)));
  });
});
