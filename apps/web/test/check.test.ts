// The Encounter check: a party-sized generated fight and the verdict read from a report's numbers.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContent, makeDeciders, resolveScenario, runFight, type ArmStats, type Rate } from '@montecrit/engine';
import { scenarioInput } from '@montecrit/host';
import { CHECK_ID, CHECK_PATH, MAX_PARTY, fightFile } from '../src/practice/encounter.ts';
import { verdictOf } from '../src/check/verdict.ts';

const ROOT = join(import.meta.dirname, '../../..');
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.ya?ml$/.test(e.name) ? [join(dir, e.name)] : []));
}
const packs = ['packs/srd-5.2.1', 'packs/test'].flatMap((d) => walk(join(ROOT, d))).map((p) => ({ path: `repo/${relative(ROOT, p)}`, text: readFileSync(p, 'utf8') }));
const content = loadContent(packs).content!;
const build = (party: string[], foes = [{ use: 'srd:goblin-warrior', count: 4 }]) => fightFile({ party, foes, surprised: false }, content, CHECK_PATH, CHECK_ID, 'Encounter check');

function setupOf(text: string) {
  const input = scenarioInput([{ path: CHECK_PATH, text }], CHECK_PATH, 'repo/scenarios');
  expect(input.errors).toEqual([]);
  const res = resolveScenario(input.input, CHECK_PATH, content);
  expect(res.errors).toEqual([]);
  return res.setup!;
}

describe('a party-sized fight', () => {
  it('seats characters as PCs and stat blocks as allies, each on its own square, and plays to an end', () => {
    const built = build(['test:sample-monk', 'srd:guard', 'test:sample-barbarian', '', 'srd:priest']);
    expect(built.errors).toEqual([]);
    const setup = setupOf(built.file!.text);
    expect(setup.seats.map((s) => s.seat).sort()).toEqual(['ally1', 'ally2', 'gobli1', 'gobli2', 'gobli3', 'gobli4', 'pc1', 'pc2']);
    expect(new Set(setup.seats.map((s) => s.cell)).size).toBe(8);
    expect(JSON.parse(built.file!.text).knobs.lossCounts).toBe('pcs');
    const deciders = makeDeciders(setup);
    const out = runFight(setup, 7, 0, deciders, null, { policy: deciders.map((d) => d.name) }).outcome;
    expect(['win', 'loss', 'stalemate']).toContain(out.k);
  });
  it('a party of stat blocks alone loses when every member is down', () => {
    const built = build(['srd:guard', 'srd:guard']);
    expect(built.errors).toEqual([]);
    expect(JSON.parse(built.file!.text).knobs.lossCounts).toBe('party');
    setupOf(built.file!.text);
  });
  it('says what is missing', () => {
    expect(build([]).errors).toContain('pick a character');
    expect(build(Array.from({ length: MAX_PARTY + 1 }, () => 'srd:guard')).errors[0]).toContain(`at most ${MAX_PARTY}`);
    expect(build(['srd:guard'], []).errors).toContain('add at least one foe');
  });
});

describe('the verdict', () => {
  const r = (p: number): Rate => ({ x: Math.round(p * 1000), n: 1000, p, lo: p, hi: p });
  const arm = (win: number, drop: number, died: number): ArmStats =>
    ({ label: 'greedy', n: 1000, win: r(win), loss: r(1 - win), stalemate: r(0), tpk: r(0), allPcsDown: r(1 - win), pcDrop: r(drop), pcDied: r(died), allyDied: [], rounds: { mean: 4, p10: 3, p50: 4, p90: 6 } }) as unknown as ArmStats;
  it('reads a difficulty from the win rate, drops and deaths', () => {
    expect(verdictOf(arm(0.99, 0.05, 0), true).difficulty).toBe('Easy');
    expect(verdictOf(arm(0.99, 0.2, 0), true).difficulty).toBe('Moderate');
    expect(verdictOf(arm(0.97, 0.6, 0.05), true).difficulty).toBe('Hard');
    expect(verdictOf(arm(0.9, 0.3, 0.05), true).difficulty).toBe('Hard');
    expect(verdictOf(arm(0.7, 0.8, 0.2), true).difficulty).toBe('Dangerous');
    expect(verdictOf(arm(0.97, 0.9, 0.3), true).difficulty).toBe('Dangerous');
    expect(verdictOf(arm(0.3, 0.9, 0.6), true).difficulty).toBe('Deadly');
  });
  it('leaves the character numbers out for a party with no character', () => {
    const v = verdictOf(arm(0.99, 0, 0), false);
    expect(v.pcDrop).toBeNull();
    expect(v.wiped).toBeNull();
    expect(v.difficulty).toBe('Easy');
  });
});

describe('CheckScreen', () => {
  it('renders the party and foe pickers', async () => {
    const { createElement } = await import('react');
    const { renderToString } = await import('react-dom/server');
    const { catalog } = await import('../src/content/catalog.ts');
    const SCREEN = '../src/check/CheckScreen.tsx';
    const m = (await import(SCREEN)) as { CheckScreen: unknown; INITIAL_CHECK: object };
    const set = { packs, scenarios: [], policies: [] };
    const html = renderToString(createElement(m.CheckScreen as never, { catalog: catalog(set), set, state: m.INITIAL_CHECK, setState: () => {}, errors: ['pick a character'], text: null, runs: { state: { k: 'idle' }, start: () => {}, cancel: () => {}, fail: () => {} }, last: null, onReport: () => {}, onPractice: () => {} }));
    expect(html).toContain('Encounter check');
    expect(html).toContain('Check this fight');
    expect(html).toContain('Goblin Warrior');
    expect(html).not.toContain('PRIVATE');
  });
});
