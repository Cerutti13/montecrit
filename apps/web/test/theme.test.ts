// Theme contrast (docs/design/m2.md 6): parsed from theme.css, both themes. Text at least 4.5:1 on
// the page and on surfaces; team colors, zone outlines and the warning/error colors at least 3:1
// (WCAG non-text contrast); text drawn on those fills at least 4.5:1. The two dark blocks
// (system dark, chosen dark) must agree.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(import.meta.dirname, '..', 'src', 'theme.css'), 'utf8');

function block(selector: string): Record<string, string> {
  const at = css.indexOf(selector);
  if (at < 0) throw new Error(`no ${selector} block`);
  const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
  const vars: Record<string, string> = {};
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) vars[m[1]!] = m[2]!.trim();
  return vars;
}

function lum(hex: string): number {
  const h = hex.replace('#', '');
  const ch = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

const light = block(':root {');
const dark = block(":root:not([data-theme='light']) {");
const chosenDark = block(":root[data-theme='dark'] {");

describe('theme contrast', () => {
  it('the system-dark and chosen-dark blocks set the same values', () => {
    expect(chosenDark).toEqual(dark);
    expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort());
  });
  for (const [name, t] of [['light', light], ['dark', dark]] as const) {
    it(`${name}: text 4.5:1, marks 3:1, on the page and on surfaces`, () => {
      for (const bg of ['bg', 'surface']) {
        for (const fg of ['fg', 'muted']) expect(ratio(t[fg]!, t[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        for (const mark of ['team0', 'team1', 'zone-1', 'zone-2', 'zone-3', 'zone-4', 'warn', 'bad', 'ci', 'wall']) expect(ratio(t[mark]!, t[bg]!), `${mark} on ${bg}`).toBeGreaterThanOrEqual(3);
      }
      // Text drawn on a fill: seat labels on tokens (and on a dead token's muted fill), the
      // private-home bar, the current log line.
      for (const fill of ['team0', 'team1', 'muted', 'warn', 'accent']) expect(ratio(t.bg!, t[fill]!), `bg text on ${fill}`).toBeGreaterThanOrEqual(4.5);
      // Team colors tell sides apart by hue and shape; they must not be the same color.
      expect(t.team0).not.toBe(t.team1);
    });
  }
});
