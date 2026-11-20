// Grid cells. A cell is one 5-ft square, numbered y * w + x. Squares are named like a
// chessboard: column letters left to right (A..Z, then AA..AZ), row numbers top to bottom
// from 1. 'C4' is x = 2, y = 3.

export const MAX_W = 52;
export const MAX_H = 64;

/**
 * Terrain bits per cell. halfCover and threeQuarterCover (M3 step 8) are objects that block
 * lines partly (a low wall, a thick trunk), never movement: they give cover (grid/los.ts).
 */
export const TERR = { wall: 1, difficult: 2, halfCover: 4, threeQuarterCover: 8 } as const;

/** A, ..., Z, AA, ..., AZ, BA, ...: grid corners reach one column past the last square (BA on a 52-wide grid). */
export function colName(x: number): string {
  if (x < 26) return String.fromCharCode(65 + x);
  return String.fromCharCode(64 + Math.floor(x / 26)) + String.fromCharCode(65 + (x % 26));
}

export function cellName(cell: number, w: number): string {
  return `${colName(cell % w)}${Math.floor(cell / w) + 1}`;
}

/** Parses 'C4' on a w x h grid; throws on a malformed or out-of-bounds name. */
export function parseCell(name: string, w: number, h: number): number {
  const m = /^([A-Z]{1,2})([1-9][0-9]?)$/.exec(name);
  if (!m) throw new RangeError(`bad square "${name}" (expected like C4)`);
  const letters = m[1]!;
  let x: number;
  if (letters.length === 1) x = letters.charCodeAt(0) - 65;
  else if (letters[0] === 'A') x = 26 + letters.charCodeAt(1) - 65;
  else throw new RangeError(`bad square "${name}": columns run A..Z then AA..AZ`);
  const y = Number(m[2]) - 1;
  if (x >= w || y >= h) throw new RangeError(`square ${name} is outside the ${w}x${h} grid`);
  return y * w + x;
}

/**
 * Parses terrain rows: h strings of w characters, '.' open, '#' wall, ':' difficult, '+' an
 * object giving Half Cover, '*' one giving Three-Quarters Cover (SRD 5.2.1 Cover table,
 * srd-raw.txt:2006-2032; they block sight partly, not movement). Omitted terrain is all open.
 */
export function parseTerrain(rows: readonly string[] | undefined, w: number, h: number): Uint8Array {
  const t = new Uint8Array(w * h);
  if (rows === undefined) return t;
  if (rows.length !== h) throw new RangeError(`terrain has ${rows.length} rows; the grid has ${h}`);
  rows.forEach((row, y) => {
    if (row.length !== w) throw new RangeError(`terrain row ${y + 1} has ${row.length} squares; the grid is ${w} wide`);
    for (let x = 0; x < w; x++) {
      const c = row[x];
      if (c === '#') t[y * w + x] = TERR.wall;
      else if (c === ':') t[y * w + x] = TERR.difficult;
      else if (c === '+') t[y * w + x] = TERR.halfCover;
      else if (c === '*') t[y * w + x] = TERR.threeQuarterCover;
      else if (c !== '.') throw new RangeError(`terrain row ${y + 1}: unknown square "${c}" (use . # : + *)`);
    }
  });
  return t;
}
