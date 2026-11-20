// Tiny synthetic pdftotext outputs for the pdf-* tests. Not real SRD text.

export interface FixLine {
  readonly x: number;
  readonly y: number;
  readonly h: number;
  readonly text: string;
}

/** A `pdftotext -bbox-layout` document: one entry per page, each a list of lines. */
export function bbox(pages: readonly (readonly FixLine[])[]): string {
  const out = ['<!DOCTYPE html><html><body><doc>'];
  for (const lines of pages) {
    out.push('<page width="594.000000" height="783.000000"><flow><block xMin="0" yMin="0" xMax="1" yMax="1">');
    for (const l of lines) {
      out.push(`<line xMin="${l.x.toFixed(6)}" yMin="${l.y.toFixed(6)}" xMax="${(l.x + 200).toFixed(6)}" yMax="${(l.y + l.h).toFixed(6)}">`);
      let x = l.x;
      for (const w of l.text.split(' ')) {
        const width = w.length * 5;
        out.push(`<word xMin="${x.toFixed(6)}" yMin="${l.y.toFixed(6)}" xMax="${(x + width).toFixed(6)}" yMax="${(l.y + l.h).toFixed(6)}">${w}</word>`);
        x += width + 2.2;
      }
      out.push('</line>');
    }
    out.push('</block></flow></page>');
  }
  out.push('</doc></body></html>');
  return out.join('\n');
}

export const L = (x: number, y: number, h: number, text: string): FixLine => ({ x, y, h, text });

/** A 20-row layout table: `row(level)` gives everything after the proficiency bonus. */
export function layoutTable(title: string, header: readonly string[], row: (level: number) => string, extra: Readonly<Record<number, string>> = {}): string {
  const lines = ['     some body text in the left column          and the right column', '', `     ${title}`, ...header];
  for (let level = 1; level <= 20; level++) {
    const pb = 2 + Math.floor((level - 1) / 4);
    lines.push(`      ${String(level).padStart(2)}         +${pb}        ${row(level)}`);
    if (extra[level]) lines.push(`                          ${extra[level]}`);
  }
  lines.push('', '', '28   System Reference Document 5.2.1');
  return lines.join('\n');
}
