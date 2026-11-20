// The marker row's layout (apps/web/src/replay/MapSvg.tsx markerLayout): at every cell size the
// Replay screen uses (26 to 44), the most decisive badge always shows, "+N" accounts for the rest
// when there's room, and the row never runs past the square.
import { describe, expect, it } from 'vitest';
// Imported by a computed path: this project (tsconfig.node.json) type-checks no JSX; tsc -p apps/web checks the map.
const MAP = '../src/replay/MapSvg.tsx';
const { markerLayout } = (await import(MAP)) as { markerLayout: (cell: number, count: number) => { shown: number; more: number; moreW: number } };

const BADGE_W = 13;

describe('markerLayout', () => {
  it('draws nothing for no markers', () => {
    expect(markerLayout(26, 0)).toEqual({ shown: 0, more: 0, moreW: 0 });
  });
  for (const cell of [26, 27, 28, 44]) {
    for (let count = 1; count <= 5; count++) {
      it(`cell ${cell}, ${count} marker(s)`, () => {
        const l = markerLayout(cell, count);
        expect(l.shown).toBeGreaterThanOrEqual(1);
        expect(l.shown + l.more).toBe(count);
        expect(l.shown * BADGE_W + l.moreW).toBeLessThanOrEqual(cell - 2);
        if (l.more === 0) expect(l.moreW).toBe(0);
      });
    }
  }
  it('narrow cells: the first badge plus a shrunk "+N"', () => {
    expect(markerLayout(26, 2)).toEqual({ shown: 1, more: 1, moreW: 11 });
    expect(markerLayout(27, 5)).toEqual({ shown: 1, more: 4, moreW: 12 });
    expect(markerLayout(26, 1)).toEqual({ shown: 1, more: 0, moreW: 0 });
  });
  it('wider cells: all that fit, else all but one and a full "+N"', () => {
    expect(markerLayout(28, 2)).toEqual({ shown: 2, more: 0, moreW: 0 });
    expect(markerLayout(28, 3)).toEqual({ shown: 1, more: 2, moreW: 13 });
    expect(markerLayout(44, 3)).toEqual({ shown: 3, more: 0, moreW: 0 });
    expect(markerLayout(44, 5)).toEqual({ shown: 2, more: 3, moreW: 13 });
  });
  it('drops "+N" rather than overflow when even a shrunk one will not fit', () => {
    expect(markerLayout(20, 3)).toEqual({ shown: 1, more: 2, moreW: 0 });
  });
});
