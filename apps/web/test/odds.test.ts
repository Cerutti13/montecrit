// The Odds screen (M4): its model against the CLI's known answers, and a server render on the
// bundled packs (effects don't run there).
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { FunctionComponent } from 'react';
import { SKILLS, loadContent } from '@montecrit/engine';
import { DEFAULT_OPTIONS, chance, customRow, groupOdds, inTwenty, ladder, parseDice, passive, rowsFor, skillLabel } from '../src/odds/model.ts';

// Imported by a computed path: this project (tsconfig.node.json) type-checks no JSX; tsc -p apps/web checks the screen.
const SCREEN = '../src/odds/OddsScreen.tsx';
const { OddsScreen, INITIAL_ODDS } = (await import(SCREEN)) as { OddsScreen: FunctionComponent<Record<string, unknown>>; INITIAL_ODDS: Record<string, unknown> };

const ROOT = join(import.meta.dirname, '../../..');
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.ya?ml$/.test(e.name) ? [join(dir, e.name)] : []));
}
const packs = ['packs/srd-5.2.1', 'packs/test'].flatMap((d) => walk(join(ROOT, d))).map((p) => ({ path: `repo/${relative(ROOT, p)}`, text: readFileSync(p, 'utf8') }));
const sheets = loadContent(packs).sheets ?? [];
const monk = sheets.find((s) => s.id === 'test:sample-monk')!;

describe('odds model', () => {
  it('matches the CLI demo: +5 with Guidance against DC 15 is 67.50%', () => {
    const c = chance(customRow(5), { ...DEFAULT_OPTIONS, guidance: true });
    expect(c.p).toBeCloseTo(0.675, 12);
    expect(c.plain).toBeCloseTo(0.55, 12);
  });
  it('Help is Advantage; Disadvantage squares the chance', () => {
    expect(chance(customRow(5), { ...DEFAULT_OPTIONS, adv: 'adv' }).p).toBeCloseTo(1 - 0.45 * 0.45, 12);
    expect(chance(customRow(5), { ...DEFAULT_OPTIONS, adv: 'dis' }).p).toBeCloseTo(0.55 * 0.55, 12);
  });
  it('Guidance adds to skill checks only, extra dice to everything', () => {
    const rows = rowsFor(monk);
    const save = rows.find((r) => r.group === 'save')!;
    const plain = chance(save, DEFAULT_OPTIONS).p;
    expect(chance(save, { ...DEFAULT_OPTIONS, guidance: true }).p).toBe(plain);
    expect(chance(save, { ...DEFAULT_OPTIONS, extraDice: '1d4' }).p).toBeGreaterThan(plain);
    const ability = rows.find((r) => r.group === 'ability')!;
    expect(chance(ability, { ...DEFAULT_OPTIONS, guidance: true }).p).toBe(chance(ability, DEFAULT_OPTIONS).p);
  });
  it('an after-failure die raises the chance and reports how often it is spent', () => {
    const c = chance(customRow(5), { ...DEFAULT_OPTIONS, afterFail: '1d6' });
    expect(c.p).toBeGreaterThan(0.55);
    expect(c.pAfterFailUsed).toBeCloseTo(0.45, 12);
  });
  it('a sheet gives all 18 skills, 6 saves and 6 ability checks, with the sheet modifiers', () => {
    const rows = rowsFor(monk);
    expect(rows.filter((r) => r.group === 'skill')).toHaveLength(SKILLS.length);
    expect(rows.filter((r) => r.group === 'save')).toHaveLength(6);
    expect(rows.filter((r) => r.group === 'ability')).toHaveLength(6);
    for (const s of monk.skills) expect(rows.find((r) => r.key === `skill:${s.skill}`)!.mod).toBe(s.mod);
    for (const s of monk.saves) expect(rows.find((r) => r.key === `save:${s.ability}`)!.mod).toBe(s.mod);
  });
  it('the ladder falls as the DC rises and agrees with chance()', () => {
    const l = ladder(customRow(3), DEFAULT_OPTIONS);
    expect(l).toHaveLength(30);
    for (let i = 1; i < l.length; i++) expect(l[i]!.p).toBeLessThanOrEqual(l[i - 1]!.p);
    expect(l[14]!.p).toBe(chance(customRow(3), DEFAULT_OPTIONS).p);
  });
  it('passive scores: 10 + mod, +5 or -5', () => {
    expect(passive(4, 'none')).toBe(14);
    expect(passive(4, 'adv')).toBe(19);
    expect(passive(4, 'dis')).toBe(9);
  });
  it('group checks: at least half pass', () => {
    const m = { name: 'a', mod: 5, adv: 'none' as const, guidance: false };
    expect(groupOdds([], 15)).toBeNull();
    const g = groupOdds([m, m], 15)!;
    expect(g.each).toHaveLength(2);
    expect(g.each[0]).toBeCloseTo(0.55, 12);
    expect(g.group.pPass).toBeCloseTo(1 - 0.45 * 0.45, 12);
  });
  it('dice fields: empty, shorthand, errors', () => {
    expect(parseDice('').node).toBeNull();
    expect(parseDice('d6').node).not.toBeNull();
    expect(parseDice('nonsense').error).not.toBeNull();
    expect(parseDice('1d4-6', true).error).toContain("can't go negative");
  });
  it('labels', () => {
    expect(skillLabel('sleight-of-hand')).toBe('Sleight of Hand');
    expect(inTwenty(0.675)).toBe('about 14 in 20');
    expect(inTwenty(0)).toBe('never');
    expect(inTwenty(1)).toBe('always');
  });
});

describe('OddsScreen', () => {
  it('renders a bundled character with every skill and the headline chance', () => {
    const html = renderToString(createElement(OddsScreen, { sheets, characters: [], state: { ...INITIAL_ODDS, who: 'test:sample-monk' }, setState: () => {} }));
    expect(html).toContain('Perception');
    expect(html).toContain('Sleight of Hand');
    expect(html).toContain('Saving throws');
    expect(html).toContain('Passive Perception');
    expect(html).toContain('Group check');
    expect(html).not.toContain('PRIVATE');
  });
  it('works with no character: one typed modifier', () => {
    const html = renderToString(createElement(OddsScreen, { sheets: [], characters: [], state: { ...INITIAL_ODDS, who: '', customMod: 5, opts: { ...DEFAULT_OPTIONS, guidance: true } }, setState: () => {} }));
    expect(html).toContain('67.5%');
    expect(html).not.toContain('Passive Perception');
  });
});
