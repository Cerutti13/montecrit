// M3 step 1 (design 2.5): class variables in content. @level, @classLevel and @scale.<column>
// fold to constants, or to plain dice for a dice-valued column, when a PC compiles, so the
// compiled template carries only ordinary dice. A spell or feature file is checked with
// stand-ins (its class isn't known there); a character that can't bind a name gets the error.

import { describe, expect, it } from 'vitest';
import { formatExpr, parseExpr, type ExprNode } from '../src/dice/expr.ts';
import { compilePc, foldExpr, pcEnv, standInEnv, type ScaleBindings } from '../src/content/compile.ts';
import { checkFeature, poolMax, type FeatureDef, type Library } from '../src/content/compile-spell.ts';
import { loadContent, type LoadResult } from '../src/content/load.ts';
import { FeatureSchema, PcSchema } from '../src/content/schema.ts';
import type { CompiledTemplate, Step } from '../src/content/types.ts';
import { formatDiag, parseYaml, type Diag } from '../src/content/yaml.ts';
import type { ItemCtx } from '../src/content/compile.ts';

const MANIFEST = "kind: manifest\npack: fx\nversion: '1'\nrules: '2024'\nnamespace: test\nlicense: test\n";

/** A synthetic feature whose activation heals with class variables (the shapes Wholeness of Body and similar need). */
const FEATURE = `kind: feature
id: test:class-vars
name: Class Vars
source: synthetic test fixture (class variables in rolls)
spellAbility: wis
activate:
  id: go
  name: Go
  cost: bonus
  do:
    - target: { range: 5, self: yes }
    - heal: { roll: 'max(1, @scale.martial-arts + @mod)' }
    - heal: { roll: '(@pb)d4' }
    - heal: { roll: '@classLevel + @level + max(1, @mod.str)' }
`;

const PC = (features: string) => `kind: pc
id: test:class-pc
name: Class PC
source: synthetic test fixture
rules: '2024'
level: 5
size: medium
speed: 30
abilities: { str: 8, dex: 16, con: 12, int: 10, wis: 16, cha: 10 }
hpMax: 30
ac: 15
pools:
  - { id: focus, name: Focus, max: '@scale.focus', recharge: shortRest }
features: [${features}]
`;

const load = (files: Record<string, string>): LoadResult => loadContent(Object.entries(files).map(([path, text]) => ({ path, text })));
const messages = (diags: readonly Diag[]) => diags.map(formatDiag);

function compileWith(scale: ScaleBindings | undefined, feature = FEATURE): { tpl: CompiledTemplate | null; errors: string[] } {
  const errors: Diag[] = [];
  const ctx = (path: string, text: string): { c: ItemCtx; value: unknown } => {
    const { doc } = parseYaml(text, path);
    return { c: { doc: doc!, prefix: [], errors, warnings: [] }, value: doc!.value };
  };
  const f = ctx('fx/f.yaml', feature);
  const def: FeatureDef = checkFeature(FeatureSchema.parse(f.value), f.c);
  const lib: Library = { spells: new Map(), features: new Map([['test:class-vars', def]]), kinds: new Map([['test:class-vars', 'feature']]) };
  const p = ctx('fx/pc.yaml', PC('test:class-vars'));
  const tpl = compilePc(PcSchema.parse(p.value), p.c, lib, scale);
  return { tpl, errors: messages(errors) };
}

const heals = (t: CompiledTemplate): ExprNode[] =>
  t.features[0]!.activate!.steps.filter((s): s is Extract<Step, { k: 'heal' }> => s.k === 'heal').map((s) => s.roll);

describe('class variables at load', () => {
  it('a feature file may name @level, @classLevel, @pb, @mod.<ability> and any @scale column', () => {
    const r = load({ 'fx/manifest.yaml': MANIFEST, 'fx/f.yaml': FEATURE });
    expect(messages(r.errors)).toEqual([]);
  });

  it('an unknown variable is still an error at load, at the feature file', () => {
    const r = load({ 'fx/manifest.yaml': MANIFEST, 'fx/f.yaml': FEATURE.replace('@classLevel', '@classLvl') });
    expect(messages(r.errors)).toEqual([expect.stringMatching(/^fx\/f\.yaml:.*unknown variable @classlvl/)]);
  });

  it('@scale alone, or @mod.<not an ability>, is unknown', () => {
    expect(standInEnv('scale')).toBeUndefined();
    expect(standInEnv('mod.luck')).toBeUndefined();
    expect(standInEnv('scale.anything')).toBe(1);
  });

  it('a character with no binding for a @scale column gets an error naming the variable, at its own file', () => {
    const r = load({ 'fx/manifest.yaml': MANIFEST, 'fx/f.yaml': FEATURE, 'fx/pc.yaml': PC('test:class-vars').replace("'@scale.focus'", '3') });
    expect(messages(r.errors)).toEqual([expect.stringMatching(/^fx\/pc\.yaml:.*features\[0\]: test:class-vars: no binding for @scale\.martial-arts: .*"martial-arts" column/)]);
  });

  it('a pool max with no binding for its @scale column is an error naming it', () => {
    const r = load({ 'fx/manifest.yaml': MANIFEST, 'fx/pc.yaml': PC('') });
    expect(messages(r.errors)).toEqual([expect.stringMatching(/^fx\/pc\.yaml:.*pools\[0\]\.max: no binding for @scale\.focus/)]);
  });

  it('dice inside max() in a damage roll are an error: a critical hit has no reading for them', () => {
    const f = FEATURE.replace("- heal: { roll: '(@pb)d4' }", "- damage: [{ roll: 'max(1, 1d8 - 2)', type: fire }]");
    const r = load({ 'fx/manifest.yaml': MANIFEST, 'fx/f.yaml': f });
    expect(messages(r.errors)).toEqual([expect.stringMatching(/can't double the dice inside max\(\) for a critical hit/)]);
  });
});

describe('class variables fold when a PC compiles', () => {
  const scale: ScaleBindings = { 'martial-arts': parseExpr('1d8'), focus: 5 };

  it('a dice-valued @scale column folds to plain dice: martial-arts 1d8 at level 5', () => {
    const { tpl, errors } = compileWith(scale);
    expect(errors).toEqual([]);
    const [clamped] = heals(tpl!);
    expect(formatExpr(clamped!)).toBe('max(1, 1d8 + 3)'); // WIS 16
    expect(clamped).toEqual({ k: 'max', a: { k: 'const', v: 1 }, b: { k: 'add', a: { k: 'dice', n: 1, sides: 8 }, b: { k: 'const', v: 3 } } });
  });

  it('(@pb)d4 compiles to plain 3d4 at level 5 (PB 3)', () => {
    expect(heals(compileWith(scale).tpl!)[1]).toEqual({ k: 'dice', n: 3, sides: 4 });
  });

  it('@level and @classLevel are the PC\'s level, and max(1, @mod.str) floors a negative modifier', () => {
    expect(heals(compileWith(scale).tpl!)[2]).toEqual({ k: 'const', v: 11 }); // 5 + 5 + max(1, -1)
  });

  it('a number-valued @scale column sets a pool max', () => {
    expect(compileWith(scale).tpl!.pools[0]!.max).toBe(5);
  });

  it('no compiled roll keeps a variable or a computed dice count', () => {
    const walk = (n: ExprNode): boolean => n.k !== 'var' && n.k !== 'vdice' && (!('a' in n) || walk(n.a)) && (!('b' in n) || walk(n.b));
    for (const h of heals(compileWith(scale).tpl!)) expect(walk(h), formatExpr(h)).toBe(true);
  });

  it('pcEnv: a missing column throws an ExprError naming it, or is reported through onMissing', () => {
    const k = { pb: 3, level: 5, mods: [0, 3, 1, 0, 3, 0] };
    expect(() => foldExpr(parseExpr('@scale.ki'), pcEnv(k))).toThrow(/no binding for @scale\.ki/);
    const seen: string[] = [];
    expect(foldExpr(parseExpr('@scale.ki + 2'), pcEnv(k, (name) => seen.push(name)))).toEqual({ k: 'const', v: 2 });
    expect(seen).toEqual(['scale.ki']);
    expect(foldExpr(parseExpr('@classLevel'), pcEnv(k))).toEqual({ k: 'const', v: 5 });
  });

  it('a dice-valued column that breaks an expression only at the PC is a diagnostic naming the PC, the feature and the expression, at the PC\'s line for it', () => {
    // Both pass at the feature's own file, where @scale stands in as 1.
    const cases: [string, RegExp][] = [
      ["- heal: { roll: '(@scale.martial-arts)d4' }", /activate\.do\[2\]\.heal\.roll: a dice count must be a number, not dice/],
      ["- damage: [{ roll: 'max(1, @scale.martial-arts)', type: fire }]", /activate\.do\[2\]\.damage\[0\]\.roll: .*max\(\)/],
    ];
    for (const [step, why] of cases) {
      const feature = FEATURE.replace("- heal: { roll: '(@pb)d4' }", step);
      expect(compileWith(undefined, feature).errors.filter((e) => !/no binding/.test(e))).toEqual([]);
      const { errors } = compileWith(scale, feature);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/^fx\/pc\.yaml:(\d+):\d+: features\[0\]: test:class-pc can't bind test:class-vars: /);
      expect(errors[0]).toMatch(why);
      expect(errors[0]).not.toMatch(/internal|:1:1:/);
    }
  });

  it('poolMax refuses dice from a dice-valued column', () => {
    const errors: Diag[] = [];
    const c: ItemCtx = { doc: parseYaml('a: 1', 'x.yaml').doc!, prefix: [], errors, warnings: [] };
    expect(poolMax(c, ['max'], '@scale.martial-arts', { pb: 3, level: 5, mods: [0, 0, 0, 0, 0, 0], scale })).toBe(0);
    expect(messages(errors)).toEqual([expect.stringMatching(/a pool max can't roll dice/)]);
  });
});
