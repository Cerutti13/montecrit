// The Character screen renders on the bundled packs: the first character picked, its YAML in the
// pane, the derived sheet and the Download button (server render; effects don't run there).
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { FunctionComponent } from 'react';
import type { ContentSet } from '../src/content/select.ts';

// Imported by a computed path: this project (tsconfig.node.json) type-checks no JSX; tsc -p apps/web checks the screen.
const SCREEN = '../src/character/CharacterScreen.tsx';
const { CharacterScreen } = (await import(SCREEN)) as { CharacterScreen: FunctionComponent<{ set: ContentSet }> };

const ROOT = join(import.meta.dirname, '../../..');
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.ya?ml$/.test(e.name) ? [join(dir, e.name)] : []));
}
const packs = ['packs/srd-5.2.1', 'packs/test'].flatMap((d) => walk(join(ROOT, d))).map((p) => ({ path: `repo/${relative(ROOT, p)}`, text: readFileSync(p, 'utf8') }));

describe('CharacterScreen', () => {
  it('renders a bundled character with its sheet', () => {
    const html = renderToString(createElement(CharacterScreen, { set: { packs, scenarios: [], policies: [] } }));
    expect(html).toContain('Download YAML');
    expect(html).toContain('kind: character');
    expect(html).toContain('Features and their fidelity');
    expect(html).not.toContain('PRIVATE');
  });
  it('marks a home character PRIVATE', () => {
    const home = { path: 'home/packs/x/characters/h.yaml', text: 'kind: character\nid: test:h\nname: Aaa Home\n' };
    const html = renderToString(createElement(CharacterScreen, { set: { packs: [home, ...packs], scenarios: [], policies: [] } }));
    expect(html).toContain('from the home folder (home/packs/x/characters/h.yaml)');
    expect(html).toMatch(/selected="">PRIVATE · (<!-- -->)?Aaa Home/);
    expect(html).toContain('missing required key &quot;classes&quot;');
  });
});
