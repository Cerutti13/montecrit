import { describe, expect, it } from 'vitest';
import { checkContent, checkText, decodeText, isAllowed, loadAllow, unescapeJs } from '../check-private.ts';
import { scan, scanHost, scanPath, scanWeb, stripCode } from '../lint-determinism.ts';

const whys = (file: string, text: string) => checkText(file, text).map((f) => f.why);

describe('check-private', () => {
  it('flags non-SRD names, private ids and private manifests anywhere in the repo', () => {
    expect(whys('packs/x/item.yaml', 'name: Thorn Whip')).toEqual(['non-SRD name "Thorn Whip"']);
    expect(whys('scenarios/a.yaml', 'pc: private:my-druid').join()).toMatch(/private content id/);
    expect(whys('my-notes.yaml', 'license: private\n').join()).toMatch(/license: private/);
    expect(whys('characters/x.yaml', 'class: druid').join()).toBe('');
    expect(whys('packages/engine/src/a.ts', "const s = 'Starry Form';")).toHaveLength(1);
  });

  it('catches ids in any case or separator, quoted licenses and character names', () => {
    expect(whys('scenarios/a.yaml', 'species: aasimar\nsubclass: circle-of-the-stars\ncantrips: [thorn_whip]').length).toBe(3);
    expect(whys('packs/x/manifest.yaml', 'license: "private"').join()).toMatch(/license: private/);
    expect(whys('packs/x/manifest.json', '{ "license": "private" }').join()).toMatch(/license: private/);
    expect(whys('scenarios/a.yaml', 'pc: Aasimar druid').join()).toMatch(/Aasimar/);
  });

  it('checks the file path too', () => {
    expect(whys('scenarios/aasimar.yaml', 'hp: 20').join()).toMatch(/in the file path/);
  });

  it('does not trip on ordinary words', () => {
    expect(whys('packages/engine/src/a.ts', 'see the style guide; it starts here; dance; private: true; "private": true')).toEqual([]);
  });

  it('exempt paths skip content checks but never the API-key check', () => {
    expect(checkText('docs/requirements.md', 'An Aasimar Circle of the Stars druid', true)).toEqual([]);
    expect(checkText('docs/x.md', `key=sk-ant-${'a'.repeat(30)}`, true).map((f) => f.why)).toEqual(['looks like an Anthropic API key']);
    expect(whys('docs/x.md', 'CI greps for sk-ant in dist/')).toEqual([]);
  });

  it('reads UTF-16 text and flags binary documents', () => {
    const utf16 = Buffer.from('﻿name: Thorn Whip', 'utf16le');
    expect(decodeText(utf16)).toBe('name: Thorn Whip');
    expect(checkContent('packs/x/a.yaml', utf16, false).map((f) => f.why)).toEqual(['non-SRD name "Thorn Whip"']);
    const noBom = Buffer.from('name: Thorn Whip', 'utf16le');
    expect(checkContent('packs/x/b.yaml', noBom, false)).toHaveLength(1);
    const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01, 0x02, 0x03, 0x00]);
    expect(checkContent('sheets/char.pdf', pdf, false).map((f) => f.why).join()).toMatch(/binary document/);
    expect(checkContent('assets/token.png', Buffer.from([0x89, 0x50, 0x00, 0x00, 0x0a]), false)).toEqual([]);
  });

  it('allowlist matches whole path segments and ignores comments', () => {
    const allow = loadAllow('# reason\ndocs/  # why\nCLAUDE.md\n\n');
    expect(allow).toEqual(['docs/', 'CLAUDE.md']);
    expect(isAllowed(allow, 'docs/x.md')).toBe(true);
    expect(isAllowed(allow, 'docs2/x.md')).toBe(false);
    expect(isAllowed(allow, 'CLAUDE.md')).toBe(true);
    expect(isAllowed(allow, 'CLAUDE.md.bak')).toBe(false);
  });
});

describe('lint-determinism', () => {
  it('catches ambient randomness, clocks and host APIs', () => {
    const src = ['const a = Math.random();', 'const t = Date.now();', "import fs from 'node:fs';", 'async function f() {}'].join('\n');
    expect(scan(src).map((h) => h.line)).toEqual([1, 2, 3, 4]);
  });

  it('ignores comments and strings that mention banned names', () => {
    const src = ['// Math.random is banned', '/* Date', '   still a comment */ const x = 1;', "const y = 'Date.now()'; // no Date here"].join('\n');
    expect(scan(src)).toEqual([]);
  });

  it("a '/*' inside a comment or string doesn't hide the code after it", () => {
    expect(scan('// files under scenarios/*.yaml\nexport const r = Math.random();').map((h) => h.line)).toEqual([2]);
    expect(scan("export const ALL = 'spell/*';\nexport const t = Date.now();").map((h) => h.line)).toEqual([2]);
  });

  it('sees code inside template-literal expressions', () => {
    expect(scan('const s = `roll ${Math.random()}`;').length).toBeGreaterThan(0);
    expect(scan('const s = `Math.random is ${1 + 1}`;')).toEqual([]);
  });

  it('fails closed on an unterminated block comment', () => {
    expect(scan('const a = 1;\n/* never closed\nconst b = Math.random();').map((h) => h.why).join()).toMatch(/unterminated/);
  });

  it('catches aliasing Math, locale-dependent built-ins and GC hooks', () => {
    for (const src of [
      'const { random, floor } = Math;',
      'const M = Math;',
      "const r = Math['random']();",
      'ids.sort((a, b) => a.localeCompare(b));',
      'const s = n.toLocaleString();',
      "const f = new Intl.NumberFormat('en');",
      'const w = new WeakRef(obj);',
    ]) {
      expect(scan(src), src).not.toEqual([]);
    }
    expect(scan('const m = Math.max(a, b) + Math.floor(c);')).toEqual([]);
  });

  it('keeps line numbers through blanked comments and strings', () => {
    const { code } = stripCode('/* a\nb */\nconst x = "c\\\nd";\nMath.random();');
    expect(code.split('\n')).toHaveLength(5);
    expect(scan('/* a\nb */\nconst x = 1;\nMath.random();').map((h) => h.line)).toEqual([4]);
  });
});

describe('lint-determinism: simulator path rules', () => {
  const sim = 'packages/engine/src/sim/x.ts';
  it('bans key-order iteration, Map/Set and transcendental Math on the simulation path', () => {
    for (const src of ['for (const k in obj) {}', 'Object.keys(o).forEach(f);', 'const m = new Map();', 'const s = new Set<number>();', 'const e = Math.exp(x);', 'const p = Math.pow(a, b);']) {
      expect(scanPath(sim, src), src).not.toEqual([]);
    }
    expect(scanPath(sim, 'for (const u of units) total += Math.floor(u.hp / 2) + Math.sqrt(d);')).toEqual([]);
  });

  it('leaves the rest of the engine alone, and lets the audit Set live in sim/dice.ts', () => {
    expect(scanPath('packages/engine/src/content/load.ts', 'const m = new Map(); Object.keys(o);')).toEqual([]);
    expect(scanPath('packages/engine/src/sim/dice.ts', 'const audit = new Set<string>();')).toEqual([]);
    expect(scanPath('packages/engine/src/decide/make.ts', 'const seats = new Set(names);')).toEqual([]);
  });

  it('only rng/stream.ts and sim/dice.ts may open streams', () => {
    expect(scanPath('packages/engine/src/sim/attack.ts', 'const s = openStream(seed, run, seat, "attack", 1);')).not.toEqual([]);
    expect(scanPath('packages/engine/src/sim/attack.ts', 'openStreamInto(s, 1, 0, 0, "attack", 1);')).not.toEqual([]);
    expect(scanPath('packages/engine/src/sim/dice.ts', 'return openStreamInto(s, 1, 0, 0, "attack", 1);')).toEqual([]);
  });

  it('deciders and queries read flags only through readFlag/oddsFlags', () => {
    for (const f of ['packages/engine/src/decide/greedy/value.ts', 'packages/engine/src/query/area.ts']) {
      expect(scanPath(f, "const alt = st.setup.flags.diagonalCost === 'alternate';"), f).not.toEqual([]);
      expect(scanPath(f, 'quickOdds(spec, v.st.setup.flags);'), f).not.toEqual([]);
      expect(scanPath(f, "const alt = readFlag(st, 'diagonalCost') === 'alternate'; quickOdds(spec, oddsFlags(st));"), f).toEqual([]);
    }
    expect(scanPath('packages/engine/src/sim/walker.ts', "if (st.setup.flags.diagonalCost === 'alternate') x();")).toEqual([]);
  });

  it('only mc/boot.ts opens or draws from aux streams; mc/ gets the simulator path rules', () => {
    for (const f of ['packages/engine/src/mc/runner.ts', 'packages/engine/src/sim/dice.ts', 'packages/engine/src/odds/pmf.ts']) {
      for (const src of ['const s = openAuxStream(seed, 0, b);', 'const j = auxInt(s, n);', 'const draw = auxU32;']) expect(scanPath(f, src), `${f}: ${src}`).not.toEqual([]);
    }
    expect(scanPath('packages/engine/src/mc/boot.ts', 'const s = openAuxStream(seed, 0, b); const j = auxInt(s, n);')).toEqual([]);
    expect(scanPath('packages/engine/src/mc/boot.ts', 'const s = openStream(seed, 0, 0, "ai", 1);')).not.toEqual([]);
    for (const src of ['const m = new Map();', 'Object.keys(o);', 'const e = Math.log(x);', 'const j = uniformInt(s, n);']) expect(scanPath('packages/engine/src/mc/stats.ts', src), src).not.toEqual([]);
  });
});

describe('review fixes: guards', () => {
  it('check-private catches names glued with _, digits or camelCase, but not inside longer words', () => {
    for (const [file, text] of [['packs/x/a.yaml', 'id: aasimar_sheet'], ['a.ts', 'const thornWhip2 = 1;'], ['a.ts', 'const starryFormArcher = 1;'], ['a.ts', 'const myAasimar = 1;'], ['scenarios/circle_of_the_stars_druid.yaml', 'x: 1']]) {
      expect(whys(file, text).length, text).toBeGreaterThan(0);
    }
    expect(whys('a.ts', 'const aasimarish = 1; // dance, style, guide')).toEqual([]);
  });

  it('lint-determinism: only sim/dice.ts draws from streams on the simulation path', () => {
    const why = (f: string, src: string) => scanPath(f, src).map((h) => h.why).join();
    expect(why('packages/engine/src/sim/attack.ts', 'const v = sampleExpr(e, {}, s);')).toMatch(/raw draw/);
    expect(why('packages/engine/src/grid/x.ts', 'const v = nextU32(s);')).toMatch(/raw draw/);
    expect(why('packages/engine/src/sim/dice.ts', 'return sampleExpr(e, {}, s);')).toBe('');
    expect(why('packages/engine/src/rolls/rollspec.ts', 'const a = rollDie(s, 20);')).toBe('');
    // no way around it: an alias, .call, a reference, or a namespace import
    expect(why('packages/engine/src/sim/x.ts', "import { sampleExpr as draw } from '../dice/expr.ts';")).toMatch(/raw draw/);
    expect(why('packages/engine/src/sim/x.ts', 'const v = sampleExpr.call(null, e, {}, s);')).toMatch(/raw draw/);
    expect(why('packages/engine/src/decide/x.ts', 'const f = nextU32;')).toMatch(/raw draw/);
    expect(why('packages/engine/src/sim/x.ts', "import * as R from '../rng/stream.ts';")).toMatch(/namespace import/);
    expect(why('packages/engine/src/sim/x.ts', "// sampleExpr in a comment\nconst label = 'nextU32';")).toBe('');
  });

  it('check-private knows the private kit feature names (checked absent from SRD 5.2.1)', () => {
    for (const name of ['Cosmic Omen', 'Celestial Resistance', 'Healing Hands', 'Light Bearer', 'Heavenly Wings', 'Inner Radiance', 'Necrotic Shroud']) {
      expect(whys('packs/x/a.yaml', `name: ${name}`).length, name).toBe(1);
    }
    expect(whys('a.ts', "journal: { key: 'react:cosmic-omen-woe' }").length).toBe(1);
    expect(whys('a.ts', 'healing handsome; light bearers; inner radiances; heavenly wingspan')).toEqual([]);
  });

  it('lint-determinism: a quote or backtick inside a regex literal no longer hides code', () => {
    expect(scan("const tick = /`/;\nconst a = Math.random();").map((h) => h.line)).toEqual([2]);
    expect(scan("const ok = /'/.test(s); const r = Math.random();")).toHaveLength(1);
    expect(scan('const half = a / 2; const r = Math.random();')).toHaveLength(1); // division isn't a regex
  });

  it('lint-determinism: an unclosed template literal fails closed; ** is banned on the sim path', () => {
    expect(scan('const s = `never closed\nconst r = 1;').map((h) => h.why).join()).toMatch(/unterminated/);
    expect(scanPath('packages/engine/src/sim/x.ts', 'const p = a ** 2;')).not.toEqual([]);
  });

  it('lint-determinism: the host profile allows Promises but no clock, no randomness, no Node modules and no browser globals', () => {
    expect(scanHost('export async function f(): Promise<void> { await g(); }')).toEqual([]);
    for (const bad of ['const t = Date.now();', 'const r = Math.random();', 'const l = Math.exp(x);', "import { readFileSync } from 'node:fs';", 'const w = new Worker(u);', 'window.x = 1;', 'const n = navigator.hardwareConcurrency;', 'setTimeout(f, 1);', 'process.exit(1);']) {
      expect(scanHost(bad), bad).not.toEqual([]);
    }
  });

  it('lint-determinism: the web scope keeps the app a client (no Node, CLI or plugin imports; no URL state, storage, console in content, cache)', () => {
    const f = 'apps/web/src/x.tsx';
    expect(scanWeb(f, "import { useState } from 'react';\nimport { runArms } from '@montecrit/engine';\nimport { openSession } from '@montecrit/host';\nimport { App } from './App.tsx';")).toEqual([]);
    for (const bad of ["import { readFileSync } from 'node:fs';", "import { runRun } from '../../cli/src/run.ts';", "import { checkText } from '../../../tools/check-private.ts';", "import { privateGuard } from '../vite/private-guard.ts';", 'history.pushState({}, "", "/x");', 'location.hash = "a";', 'localStorage.setItem("k", v);', 'const db = indexedDB.open("x");', 'const r = Math.random();']) {
      expect(scanWeb(f, bad), bad).not.toEqual([]);
    }
    expect(scanWeb('apps/web/src/theme.ts', 'localStorage.getItem("theme");')).toEqual([]);
    expect(scanWeb('apps/web/src/content/x.ts', 'console.log(text);')).not.toEqual([]);
    expect(scanWeb('apps/web/src/run/x.ts', 'console.log(n);')).toEqual([]);
  });

  it('check-private bundle scans see markers a bundler kept inside escaped string literals', () => {
    const P = 'priv' + 'ate';
    const quoted = `"manifest\\npack: p\\nlicense: ${P}\\nd"`; // as a minifier may keep a raw YAML import
    expect(checkText('a.js', quoted)).toEqual([]); // a source scan reads it as written
    expect(checkText('a.js', quoted, false, { bundle: true }).map((f) => f.why)).toEqual(['manifest says license: ' + P]);
    expect(checkText('a.js', `"x\\n${P}:foo"`, false, { bundle: true }).map((f) => f.why).join()).toMatch(/private content id/);
    expect(checkText('a.js', `"x\\tlicense: ${P}"`, false, { bundle: true })).not.toEqual([]);
    expect(unescapeJs('a\\nb\\u0041\\x42\\u{43}\\\\')).toBe('a\nbABC\\');
  });

  it('lint-determinism: ** and Math.pow are banned engine-wide, not only on the sim path (M2: browser report = CLI report)', () => {
    for (const file of ['packages/engine/src/odds/x.ts', 'packages/engine/src/log/x.ts', 'packages/engine/src/content/x.ts']) {
      expect(scanPath(file, 'const p = a ** 2;').map((h) => h.why).join()).toMatch(/\*\* exponentiation/);
      expect(scanPath(file, 'const p = Math.pow(a, 2);').map((h) => h.why).join()).toMatch(/Math\.pow/);
      expect(scanPath(file, 'const p = Math.log(a);').map((h) => h.why).join()).toMatch(/transcendental/);
      expect(scanPath(file, '/** a doc comment */ const p = a * a;')).toEqual([]);
    }
  });
});
