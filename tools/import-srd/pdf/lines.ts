// Text lines of the SRD PDF with their positions, from `pdftotext -bbox-layout` (XHTML).
//
// The PDF is untagged, so the only structure we get is geometry. Two facts carry most of the
// parsing:
//   - a line's box height is a stable proxy for its font style (headings, spell header
//     italics, table cells and body text all differ; see STYLE below);
//   - every content page is two columns split at the page middle, so (page, column, y) is
//     reading order. Naive reading order (pdftotext without -bbox) misplaces names where a
//     column or page break falls between a heading and what follows it (research-sources 2.2).
// Parsed with a regex over the XHTML only: the input is untrusted data and is never executed.

export interface Line {
  /** 1-based physical page; equals the printed page number in SRD 5.2.1. */
  readonly page: number;
  /** 0 = left column, 1 = right column. */
  readonly col: number;
  readonly x: number;
  readonly y: number;
  /** Box height rounded to 0.1 pt: the style key. */
  readonly h: number;
  readonly text: string;
}

/** Box heights (pt, rounded) of the styles the index reads. Measured on SRD 5.2.1. */
export const STYLE = {
  h1: 31.0, // chapter title ("Classes", "Feats")
  h2: 21.5, // class name, "Character Backgrounds"
  h3: 16.7, // "Barbarian Class Features", "Bard Subclass:", "Species Descriptions"
  h4: 14.3, // "Level 3: Primal Knowledge", spell names, species/background/feat names
  h5: 12.5, // table titles ("Level 1 Hit Points by Class", "Level 1 Druid Spells")
  sub: 13.3, // italic line under a heading: spell "Level 3 Evocation (...)", feat "Origin Feat"
  cell: 10.8, // first-column table cells (spell list tables)
  row: 11.0, // origin table cells ("Elven Lineages")
  runIn: 35.1, // a body line led by a bold run-in heading ("Dwarven Toughness. ...")
} as const;

const ENTITY: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10));
    return ENTITY[e] ?? m;
  });
}

/** Soft hyphens and zero-width spaces never belong in a name. */
export function cleanText(s: string): string {
  return s.replace(/[­​]/g, '').replace(/\s+/g, ' ').trim();
}

/** Word gaps (pt) below this are one word; real spaces are about 2.2 pt at body size. */
const WORD_JOIN = 1.0;

/** Footer band (page number and "System Reference Document 5.2.1"). */
const FOOTER_Y = 740;

/** Parse `pdftotext -bbox-layout` output into lines in reading order (page, column, y, x). */
export function parseBboxLayout(xhtml: string): Line[] {
  const out: Line[] = [];
  const re = /<page width="([\d.]+)"|<line xMin="([\d.]+)" yMin="([\d.]+)" xMax="[\d.]+" yMax="([\d.]+)">|<word xMin="([\d.]+)" yMin="[\d.]+" xMax="([\d.]+)" yMax="[\d.]+">([^<]*)<\/word>|<\/line>/g;
  let page = 0;
  let mid = 297;
  let cur: { x: number; y: number; h: number; text: string; end: number } | undefined;
  for (let m = re.exec(xhtml); m; m = re.exec(xhtml)) {
    if (m[1] !== undefined) {
      page++;
      mid = Number(m[1]) / 2;
    } else if (m[2] !== undefined) {
      const y = Number(m[3]);
      cur = { x: Number(m[2]), y, h: Math.round((Number(m[4]) - y) * 10) / 10, text: '', end: Number.NEGATIVE_INFINITY };
    } else if (m[5] !== undefined) {
      if (cur) {
        // Styled initials come out as separate words that touch ("A" "cid" "S" "plash"):
        // a gap under WORD_JOIN pt is no space at all.
        const sep = cur.text === '' || Number(m[5]) - cur.end < WORD_JOIN ? '' : ' ';
        cur.text += sep + decodeEntities(m[7]!);
        cur.end = Number(m[6]);
      }
    } else if (cur) {
      const text = cleanText(cur.text);
      if (text !== '' && cur.y < FOOTER_Y) out.push({ page, col: cur.x < mid ? 0 : 1, x: cur.x, y: cur.y, h: cur.h, text });
      cur = undefined;
    }
  }
  return sortLines(out);
}

export function sortLines(lines: readonly Line[]): Line[] {
  return [...lines].sort((a, b) => a.page - b.page || a.col - b.col || a.y - b.y || a.x - b.x);
}

export const isStyle = (l: Line | undefined, h: number): boolean => l !== undefined && Math.abs(l.h - h) < 0.05;

/** Directly under `a` in the same column (a wrapped heading's next line). */
export function continues(a: Line, b: Line | undefined, maxGap = 18): b is Line {
  return b !== undefined && b.page === a.page && b.col === a.col && b.h === a.h && b.y > a.y && b.y - a.y < maxGap;
}

/** Split `pdftotext -layout` output into pages (1-based index = physical page). */
export function layoutPages(text: string): string[] {
  const pages = text.split('\f');
  if (pages.length > 0 && pages[pages.length - 1]!.trim() === '') pages.pop();
  return pages;
}
