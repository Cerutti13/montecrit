// The Character screen's kept state (screen-state.ts) and the fixes around it: per-file drafts that
// survive picking another character, the pick form and a tab switch; a picked file that a home
// reload drops keeps its pane (no fallback to another character); an empty pane says "Empty."; one
// origin rule (home/ path or private license) in the screen and the Run panel's catalog.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { FunctionComponent } from 'react';
import type { SourceFile } from '@montecrit/engine';
import { catalog } from '../src/content/catalog.ts';
import type { ContentSet } from '../src/content/select.ts';
import { characterLib } from '../src/character/lib.ts';
import { defaultForm, formToYaml } from '../src/character/form.ts';
import { FORM_KEY, initialScreen, paneView, reduceScreen, type ScreenState } from '../src/character/screen-state.ts';
import { characterOrigin, checkCharacter, listCharacters, paneStatus } from '../src/character/validate.ts';

// Imported by a computed path: this project (tsconfig.node.json) type-checks no JSX; tsc -p apps/web checks the screen.
const SCREEN = '../src/character/CharacterScreen.tsx';
interface Props { set: ContentSet; homeLoading?: boolean; state?: ScreenState | null; setState?: (s: unknown) => void }
const { CharacterScreen } = (await import(SCREEN)) as { CharacterScreen: FunctionComponent<Props> };

const ROOT = join(import.meta.dirname, '../../..');
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.ya?ml$/.test(e.name) ? [join(dir, e.name)] : []));
}
const PACKS: SourceFile[] = ['packs/srd-5.2.1', 'packs/test'].flatMap((d) => walk(join(ROOT, d))).map((p) => ({ path: `repo/${relative(ROOT, p)}`, text: readFileSync(p, 'utf8') }));
const SET: ContentSet = { packs: PACKS, scenarios: [], policies: [] };
const MONK = 'repo/packs/test/characters/sample-monk.yaml';
const MONK_TEXT = PACKS.find((f) => f.path === MONK)!.text;
const OTHER = listCharacters(PACKS).find((c) => c.kind === 'character' && c.path !== MONK)!;
const render = (p: Omit<Props, 'set'> & { set?: ContentSet }) => renderToString(createElement(CharacterScreen, { set: SET, setState: () => undefined, ...p }));
const unescape = (h: string) => h.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

describe('drafts (finding 2)', () => {
  it('keeps each file\'s edits across picks and restores them on return', () => {
    let s = reduceScreen(initialScreen(null, ''), { t: 'pick', path: MONK, text: MONK_TEXT });
    s = reduceScreen(s, { t: 'edit', text: MONK_TEXT + '# mine\n', file: MONK_TEXT });
    s = reduceScreen(s, { t: 'pick', path: OTHER.path, text: OTHER.text });
    expect(paneView(s, OTHER.text, null)).toMatchObject({ text: OTHER.text, edited: false });
    s = reduceScreen(s, { t: 'pick', path: MONK, text: MONK_TEXT });
    expect(paneView(s, MONK_TEXT, null)).toEqual({ text: MONK_TEXT + '# mine\n', base: MONK_TEXT, edited: true, missing: false });
    s = reduceScreen(s, { t: 'revert' });
    expect(paneView(s, MONK_TEXT, null)).toMatchObject({ text: MONK_TEXT, edited: false });
    expect(Object.hasOwn(s.drafts, MONK)).toBe(false);
  });

  it('an edit back to the file\'s text is no draft', () => {
    let s = reduceScreen(initialScreen(MONK, MONK_TEXT), { t: 'edit', text: 'x', file: MONK_TEXT });
    s = reduceScreen(s, { t: 'edit', text: MONK_TEXT, file: MONK_TEXT });
    expect(s.drafts).toEqual({});
  });

  it('choosing "New, from the pick form" again keeps the edited form draft', () => {
    const lib = characterLib(PACKS);
    const f = defaultForm(lib, 'test:new-character');
    const y = formToYaml(lib, f);
    let s = reduceScreen(initialScreen(MONK, MONK_TEXT), { t: 'new', form: f, text: y });
    s = reduceScreen(s, { t: 'edit', text: y + '# typed\n', file: null });
    s = reduceScreen(s, { t: 'pick', path: MONK, text: MONK_TEXT });
    s = reduceScreen(s, { t: 'new', form: f, text: y });
    expect(paneView(s, null, y)).toEqual({ text: y + '# typed\n', base: y, edited: true, missing: false });
    // "Revert to the form" is the form action with the same form.
    s = reduceScreen(s, { t: 'form', form: f, text: y });
    expect(paneView(s, null, y).edited).toBe(false);
    expect(s.drafts[FORM_KEY]).toBe(y);
  });

  it('a tab switch keeps the edits: the screen renders the kept state', () => {
    const s = reduceScreen(initialScreen(MONK, MONK_TEXT), { t: 'edit', text: MONK_TEXT.replace('Sample Monk', 'Renamed Monk'), file: MONK_TEXT });
    const html = unescape(render({ state: s }));
    expect(html).toContain('name: Renamed Monk');
    expect(html).toContain('edited (not saved)');
    expect(html).toContain('Revert to the file');
    expect(html.replace(/<!-- -->/g, '')).toContain('Sample Monk (test:sample-monk) · edited');
  });
});

describe('a picked file that goes away (finding 1)', () => {
  const GONE = 'home/packs/x/characters/gone.yaml';
  const GONE_TEXT = 'kind: character\nid: test:gone\nname: Gone Home\n';

  it('keeps the path and the last text seen, or the edits; never another character', () => {
    let s = reduceScreen(initialScreen(null, ''), { t: 'pick', path: GONE, text: GONE_TEXT });
    expect(paneView(s, null, null)).toEqual({ text: GONE_TEXT, base: GONE_TEXT, edited: false, missing: true });
    s = reduceScreen(s, { t: 'edit', text: GONE_TEXT + '# edit\n', file: null });
    expect(paneView(s, null, null)).toMatchObject({ text: GONE_TEXT + '# edit\n', edited: true, missing: true });
    expect(s.path).toBe(GONE);
    // Back after the reload: the edits are still there.
    expect(paneView(s, GONE_TEXT, null)).toMatchObject({ text: GONE_TEXT + '# edit\n', edited: true, missing: false });
  });

  it('the screen shows the note (reloading or gone), keeps the text and marks it PRIVATE', () => {
    const s = reduceScreen(reduceScreen(initialScreen(null, ''), { t: 'pick', path: GONE, text: GONE_TEXT }), { t: 'edit', text: GONE_TEXT + '# edit\n', file: null });
    const loading = unescape(render({ state: s, homeLoading: true }));
    expect(loading).toContain(`${GONE} isn't loaded while the home folder reloads`);
    expect(loading).toContain('# edit');
    expect(loading).toContain(`from the home folder (${GONE})`);
    expect(loading.replace(/<!-- -->/g, '')).toContain(`selected="">(not loaded) ${GONE} · edited`);
    expect(loading).not.toContain('name: Sample Monk');
    const gone = unescape(render({ state: s, homeLoading: false }));
    expect(gone).toContain(`${GONE} is no longer loaded; the pane keeps its text`);
    expect(gone).toContain('# edit');
  });
});

describe('an empty pane (finding 3)', () => {
  it('checks to nothing and says "Empty." with no count and aria-invalid false', () => {
    for (const t of ['', '  \n\t\n']) {
      const c = checkCharacter(t, characterLib(PACKS));
      expect(c).toMatchObject({ kind: null, yaml: [], schema: [], lint: [] });
      expect(paneStatus(t, 0, 0, false, null)).toBe('Empty.');
    }
    expect(paneStatus('kind: x', 1, 0, false, null)).toBe('1 error(s), 0 warning(s)');
    const s: ScreenState = { path: null, form: null, drafts: { [FORM_KEY]: '   \n' }, seen: {} };
    const html = render({ state: s });
    expect(html).toContain('>Empty.</p>');
    expect(html).toContain('aria-invalid="false"');
    expect(html).not.toMatch(/error\(s\)/);
  });
});

describe('one origin rule (finding 4)', () => {
  it('characterOrigin: home/ path or private license', () => {
    expect(characterOrigin('home/packs/x/c.yaml', 'test')).toBe('home');
    expect(characterOrigin('repo/packs/x/c.yaml', 'private')).toBe('home');
    expect(characterOrigin(null, 'private')).toBe('home');
    expect(characterOrigin('repo/packs/test/c.yaml', 'test')).toBe('repo');
    expect(characterOrigin(null, undefined)).toBe('repo');
  });

  it('a home/ character in a test: namespace is Home in both the catalog and the screen list', () => {
    const home: SourceFile[] = [
      { path: 'home/packs/home-test/manifest.yaml', text: "kind: manifest\npack: home-test\nversion: '1'\nrules: '2024'\nnamespace: test\nlicense: test\n" },
      { path: 'home/packs/home-test/characters/home-monk.yaml', text: MONK_TEXT.replace('id: test:sample-monk', 'id: test:home-monk').replace('name: Sample Monk', 'name: Home Monk') },
    ];
    const set: ContentSet = { packs: [...PACKS, ...home], scenarios: [], policies: [] };
    const cat = catalog(set);
    expect(cat.contentErrors).toEqual([]);
    expect(cat.characters.find((c) => c.id === 'test:home-monk')).toMatchObject({ origin: 'home', kind: 'character file' });
    expect(cat.characters.find((c) => c.id === 'test:sample-monk')).toMatchObject({ origin: 'repo' });
    expect(listCharacters(set.packs).find((c) => c.id === 'test:home-monk')).toMatchObject({ origin: 'home' });
    expect(listCharacters(set.packs).find((c) => c.id === 'test:sample-monk')).toMatchObject({ origin: 'repo' });
  });

  it('a repo path in a private-licensed pack is Home in the screen list too', () => {
    const priv: SourceFile[] = [
      { path: 'repo/x/manifest.yaml', text: "kind: manifest\npack: p\nversion: '1'\nrules: '2024'\nnamespace: " + 'priv' + "ate\nlicense: " + 'priv' + 'ate\n' },
      { path: 'repo/x/characters/c.yaml', text: 'kind: pc\nid: ' + 'priv' + 'ate:someone\nname: Someone\n' },
    ];
    expect(listCharacters(priv)[0]).toMatchObject({ origin: 'home' });
  });
});
