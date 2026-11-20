// Practice mode (M5): play by rerun on the public scenario, and the quick encounter.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContent, resolveScenario, parseYaml, type FightSetup } from '@montecrit/engine';
import { scenarioInput } from '@montecrit/host';
import { askHelp, askTitle, cellChoices, endTurn, labelOf, sections, step, type Answer } from '../src/practice/play.ts';
import { QUICK_PATH, encounterFile, statBlocks } from '../src/practice/encounter.ts';

const ROOT = join(import.meta.dirname, '../../..');
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.ya?ml$/.test(e.name) ? [join(dir, e.name)] : []));
}
const file = (p: string) => ({ path: `repo/${relative(ROOT, p)}`, text: readFileSync(p, 'utf8') });
const packs = ['packs/srd-5.2.1', 'packs/test'].flatMap((d) => walk(join(ROOT, d))).map(file);
const content = loadContent(packs).content!;

function setupOf(path: string, scenarios: { path: string; text: string }[]): FightSetup {
  const input = scenarioInput(scenarios, path, 'repo/scenarios');
  expect(input.errors).toEqual([]);
  const res = resolveScenario(input.input, path, content);
  expect(res.errors).toEqual([]);
  return res.setup!;
}
const ambush = setupOf('repo/scenarios/stars-ambush.yaml', [file(join(ROOT, 'scenarios/stars-ambush.yaml'))]);
const pc = ambush.seats.findIndex((s) => s.seat === 'pc1');
const opts = { seed: 42, seat: pc, auto: [] as const };

/** Plays the AI's suggestion at every prompt. */
function playOut(setup: FightSetup, o: typeof opts, cap = 2000) {
  const answers: Answer[] = [];
  let s = step(setup, o, answers);
  let kinds = new Set<string>();
  while (s.ask && answers.length < cap) {
    kinds.add(s.ask.kind);
    const it = s.ask.items[Math.max(0, s.ask.suggest)]!;
    answers.push({ at: s.ask.at, key: it.key });
    s = step(setup, o, answers);
  }
  return { s, answers, kinds };
}

describe('practice: play by rerun', () => {
  it('stops at the player\'s first decision with a legal list and a suggestion', () => {
    const s = step(ambush, opts, []);
    expect(s.error).toBeNull();
    expect(s.outcome).toBeNull();
    expect(s.ask).not.toBeNull();
    expect(s.ask!.seat).toBe('pc1');
    expect(s.ask!.items.length).toBeGreaterThan(1);
    expect(s.ask!.suggest).toBeGreaterThanOrEqual(0);
    expect(s.view.frames.length).toBe(s.events.length + 1);
    expect(askTitle(s.ask!).length).toBeGreaterThan(0);
  });
  it('is deterministic: the same answers give the same events', () => {
    const a = step(ambush, opts, []);
    const first = a.ask!.items[a.ask!.suggest]!;
    const b1 = step(ambush, opts, [{ at: a.ask!.at, key: first.key }]);
    const b2 = step(ambush, opts, [{ at: a.ask!.at, key: first.key }]);
    expect(b1.events.length).toBeGreaterThan(a.events.length);
    expect(JSON.stringify(b1.events)).toBe(JSON.stringify(b2.events));
    // What happened before the answer is unchanged by it.
    expect(JSON.stringify(b1.events.slice(0, a.events.length - 0)).startsWith(JSON.stringify(a.events).slice(0, -1))).toBe(true);
  });
  it('playing the suggestion every time finishes the fight', () => {
    const { s, answers } = playOut(ambush, opts);
    expect(s.error).toBeNull();
    expect(s.ask).toBeNull();
    expect(s.outcome).not.toBeNull();
    expect(answers.length).toBeGreaterThan(3);
    expect(s.events[s.events.length - 1]!.k).toBe('fightEnd');
  });
  it('handing roll windows to the AI asks fewer questions and still finishes', () => {
    const all = playOut(ambush, opts);
    const fewer = playOut(ambush, { ...opts, auto: ['preRoll', 'orderTriggers'] as never });
    expect(fewer.s.outcome).not.toBeNull();
    expect(fewer.answers.length).toBeLessThanOrEqual(all.answers.length);
    expect(fewer.kinds.has('preRoll')).toBe(false);
  });
  it('an illegal answer is an error, not a crash', () => {
    const a = step(ambush, opts, []);
    const s = step(ambush, opts, [{ at: a.ask!.at, key: 'attack:nothing>nobody' }]);
    expect(s.error).toContain("isn't legal");
    expect(s.ask).toBeNull();
  });
  it('splits a turn into squares and buttons', () => {
    let s = step(ambush, opts, []);
    const answers: Answer[] = [];
    while (s.ask && s.ask.kind !== 'turn') {
      answers.push({ at: s.ask.at, key: s.ask.items[Math.max(0, s.ask.suggest)]!.key });
      s = step(ambush, opts, answers);
    }
    const ask = s.ask!;
    const cells = cellChoices(ask, ambush.w);
    expect(cells.length).toBeGreaterThan(0);
    expect(new Set(cells.map((c) => c.cell)).size).toBe(cells.length);
    const secs = sections(ask, (u) => ambush.seats[u]!.seat);
    const buttons = secs.flatMap((g) => g.rows).flatMap((r) => r.variants.map((v) => v.it));
    expect(buttons.every((b) => b.cell < 0 && b.key !== 'pass')).toBe(true);
    expect(endTurn(ask)?.key).toBe('pass');
    // Every choice lands in exactly one place: a square, a row's button, or End turn.
    expect(buttons.length + ask.items.filter((it) => it.cell >= 0).length + 1).toBe(ask.items.length);
    // Each option says what it spends and what it does.
    expect(secs.map((x) => x.title)).toContain('Action');
    const casts = ask.items.filter((it) => it.k === 'cast');
    expect(casts.length).toBeGreaterThan(0);
    for (const it of casts) expect(it.detail).toMatch(/range|self|touch/);
    for (const it of ask.items.filter((x) => x.k === 'attack')) {
      expect(it.detail).toMatch(/to hit/);
      expect(it.pHit).toBeGreaterThanOrEqual(0);
    }
    expect(ask.status.hpMax).toBeGreaterThan(0);
    expect(ask.status.slots.length).toBeGreaterThan(0);
  });
  it('labels', () => {
    expect(labelOf('pass', 'turn')).toBe('End turn');
    expect(labelOf('pass', 'reaction')).toBe('No, pass');
    expect(labelOf('attack:scimitar>boss1', 'turn')).toBe('Scimitar at boss1');
    expect(labelOf('cast:moonbeam@3', 'turn')).toBe('Moonbeam (level 3)');
    expect(labelOf('cast:produce-flame@0', 'turn')).toBe('Produce Flame');
    expect(labelOf('move:F3/p1', 'turn')).toBe('F3');
  });
});

describe('quick encounter', () => {
  const enc = { pc: 'test:sample-monk', ally: 'srd:guard', foes: [{ use: 'srd:goblin-warrior', count: 3 }, { use: 'srd:goblin-boss', count: 1 }], surprised: false };
  it('builds a scenario the engine resolves, with every unit on its own square', () => {
    const built = encounterFile(enc, content);
    expect(built.errors).toEqual([]);
    expect(built.file!.path).toBe(QUICK_PATH);
    expect(parseYaml(built.file!.text, QUICK_PATH).doc).not.toBeNull();
    const setup = setupOf(QUICK_PATH, [built.file!]);
    expect(setup.seats).toHaveLength(6);
    expect(setup.seats.map((s) => s.seat).sort()).toEqual(['ally1', 'gobli1', 'gobli2', 'gobli3', 'gobli4', 'pc1']);
    expect(new Set(setup.seats.map((s) => s.cell)).size).toBe(6);
    const s = step(setup, { seed: 1, seat: setup.seats.findIndex((x) => x.seat === 'pc1'), auto: [] }, []);
    expect(s.error).toBeNull();
    expect(s.ask?.seat ?? 'pc1').toBe('pc1');
  });
  it('a quick encounter plays to the end', () => {
    const setup = setupOf(QUICK_PATH, [encounterFile(enc, content).file!]);
    const { s } = playOut(setup, { seed: 3, seat: setup.seats.findIndex((x) => x.seat === 'pc1'), auto: [] as const });
    expect(s.error).toBeNull();
    expect(s.outcome).not.toBeNull();
  });
  it('a scene hand-off starts the character at its current hit points, capped at its maximum', () => {
    const start = (hp: number) => {
      const setup = setupOf(QUICK_PATH, [encounterFile({ ...enc, hp }, content).file!]);
      const seat = setup.seats.findIndex((x) => x.seat === 'pc1');
      return step(setup, { seed: 1, seat, auto: [] }, []).view.frames[0]!.units[seat]!;
    };
    expect(start(7).hp).toBe(7);
    const full = start(9999);
    expect(full.hp).toBe(full.hpMax);
    // The ally and the foes are untouched.
    expect(JSON.parse(encounterFile({ ...enc, hp: 7 }, content).file!.text).units.filter((u: { hp?: number }) => u.hp !== undefined)).toHaveLength(1);
  });
  it('a scene hand-off starts the character with the slots and feature uses it has left', () => {
    const druid = { pc: 'test:sample-kin-druid', ally: '', foes: [{ use: 'srd:guard', count: 1 }], surprised: false };
    const status = (resources?: { slots?: number[]; pools?: Record<string, number> }) => {
      const built = encounterFile({ ...druid, ...(resources ? { resources } : {}) }, content);
      expect(built.errors).toEqual([]);
      const setup = setupOf(QUICK_PATH, [built.file!]);
      const seat = setup.seats.findIndex((x) => x.seat === 'pc1');
      return step(setup, { seed: 1, seat, auto: [] }, []).ask!.status;
    };
    const full = status();
    expect(full.slots.map((x) => x.left)).toEqual([4, 3, 2]);
    const low = status({ slots: [1, 0, 2], pools: { 'wild-shape': 0, 'not-a-pool': 3 } });
    // A level with none left drops out of the strip; the others show what is left of the maximum.
    expect(low.slots).toEqual([{ lvl: 1, left: 1, max: 4 }, { lvl: 2, left: 0, max: 3 }, { lvl: 3, left: 2, max: 2 }]);
    expect(low.pools.find((p) => p.name === 'Wild Shape')!.left).toBe(0);
    expect(low.pools.find((p) => p.name === 'Mending Touch')!.left).toBe(full.pools.find((p) => p.name === 'Mending Touch')!.left);
    // Numbers above the maximum are capped before the engine sees them, so nothing warns.
    expect(status({ slots: [99] }).slots[0]).toEqual({ lvl: 1, left: 4, max: 4 });
  });
  it('an area that starts at the caster is aimed by clicking a square next to it, never a square from the direction index', () => {
    const setup = setupOf(QUICK_PATH, [encounterFile({ pc: 'test:sample-kin-druid', ally: '', foes: [{ use: 'srd:guard', count: 1 }], surprised: false }, content).file!]);
    const seat = setup.seats.findIndex((x) => x.seat === 'pc1');
    const answers: { at: number; key: string }[] = [];
    let s = step(setup, { seed: 1, seat, auto: [] }, answers);
    for (let i = 0; i < 6 && s.ask && s.ask.kind !== 'place'; i++) {
      const pick = s.ask.items.find((it) => it.key.startsWith('cast:thunderwave@1')) ?? s.ask.items.find((it) => it.key.startsWith('item:stow'));
      expect(pick, `no Thunderwave or stow among ${s.ask.items.map((it) => it.key).join(' ')}`).toBeDefined();
      answers.push({ at: s.ask.at, key: pick!.key });
      s = step(setup, { seed: 1, seat, auto: [] }, answers);
    }
    const ask = s.ask!;
    expect(ask.kind).toBe('place');
    expect(ask.aim, ask.items.map((it) => it.key + '=' + it.cell).join(' ')).toBe(true);
    expect(askHelp(ask)).toContain('next to you');
    const me = s.view.frames.at(-1)!.units[seat]!.cell;
    const w = setup.w;
    for (const it of ask.items) {
      expect(it.label).toMatch(/^Aim (north|south|east|west)/);
      if (it.cell < 0) continue;
      expect(Math.abs((it.cell % w) - (me % w))).toBeLessThanOrEqual(1);
      expect(Math.abs(Math.floor(it.cell / w) - Math.floor(me / w))).toBeLessThanOrEqual(1);
      expect(it.cell).not.toBe(me);
    }
    expect(cellChoices(ask, w).map((c) => c.title)).toContain('Aim north, catches no one');
    // Each aim carries the squares it would cover: north of the caster for north, and whoever stands in them.
    const north = ask.items.find((it) => it.label === 'Aim north')!;
    expect(north.area!.length).toBeGreaterThan(0);
    for (const c of north.area!) expect(Math.floor(c / w)).toBeLessThan(Math.floor(me / w));
    const south = ask.items.find((it) => it.label === 'Aim south')!;
    for (const c of south.area!) expect(Math.floor(c / w)).toBeGreaterThan(Math.floor(me / w));
    expect(north.caught).toEqual([]);
  });
  it('a placed area shows the squares it covers and who stands in them', () => {
    const setup = setupOf(QUICK_PATH, [encounterFile({ pc: 'test:sample-kin-druid', ally: '', foes: [{ use: 'srd:guard', count: 1 }], surprised: false }, content).file!]);
    const seat = setup.seats.findIndex((x) => x.seat === 'pc1');
    const answers: { at: number; key: string }[] = [];
    let s = step(setup, { seed: 1, seat, auto: [] }, answers);
    for (let i = 0; i < 6 && s.ask && s.ask.kind !== 'place'; i++) {
      const pick = s.ask.items.find((it) => it.key.startsWith('cast:entangle@1')) ?? s.ask.items.find((it) => it.key.startsWith('item:stow'));
      expect(pick, `no Entangle or stow among ${s.ask.items.map((it) => it.key).join(' ')}`).toBeDefined();
      answers.push({ at: s.ask.at, key: pick!.key });
      s = step(setup, { seed: 1, seat, auto: [] }, answers);
    }
    const ask = s.ask!;
    expect(ask.kind).toBe('place');
    expect(ask.aim).toBe(false);
    const units = s.view.frames.at(-1)!.units;
    const guard = setup.seats.findIndex((x) => x.seat !== 'pc1');
    const hits = ask.items.filter((it) => it.caught!.includes(setup.seats[guard]!.seat));
    expect(hits.length).toBeGreaterThan(0);
    for (const it of ask.items) {
      expect(it.area!.length).toBeGreaterThan(0);
      expect(it.caught!.includes(setup.seats[guard]!.seat)).toBe(it.area!.includes(units[guard]!.cell));
    }
    expect(cellChoices(ask, setup.w).some((c) => c.title.endsWith(`catches ${setup.seats[guard]!.seat}`))).toBe(true);
  });
  it('says what is missing', () => {
    expect(encounterFile({ ...enc, pc: '' }, content).errors).toContain('pick a character');
    expect(encounterFile({ ...enc, foes: [] }, content).errors).toContain('add at least one foe');
    expect(encounterFile({ ...enc, foes: [{ use: 'srd:goblin-warrior', count: 13 }] }, content).errors[0]).toContain('at most 12');
    expect(encounterFile(enc, null).errors).toEqual(['content has errors']);
  });
  it('lists stat blocks by name, no PCs', () => {
    const list = statBlocks(content);
    expect(list.length).toBeGreaterThan(100);
    expect(list.some((t) => t.id === 'srd:goblin-warrior')).toBe(true);
    expect(list.some((t) => t.id === 'test:sample-monk')).toBe(false);
  });
});

describe('PracticeScreen', () => {
  it('renders the first prompt of a bundled fight, and the quick encounter panel', async () => {
    const { createElement } = await import('react');
    const { renderToString } = await import('react-dom/server');
    const { catalog } = await import('../src/content/catalog.ts');
    // Imported by a computed path: this project (tsconfig.node.json) type-checks no JSX.
    const SCREEN = '../src/practice/PracticeScreen.tsx';
    const m = (await import(SCREEN)) as { PracticeScreen: (p: Record<string, unknown>) => unknown; INITIAL_PRACTICE: object; INITIAL_ENCOUNTER: object };
    const set = { packs, scenarios: [file(join(ROOT, 'scenarios/stars-ambush.yaml'))], policies: [] };
    const html = renderToString(createElement(m.PracticeScreen as never, { catalog: catalog(set), set, state: m.INITIAL_PRACTICE, setState: () => {}, enc: m.INITIAL_ENCOUNTER, setEnc: () => {}, encErrors: ['pick a character'], encText: null }));
    expect(html).toContain('Your turn');
    expect(html).toContain('End turn');
    expect(html).toContain('Quick encounter');
    expect(html).toContain('(you)');
    expect(html).not.toContain('PRIVATE');
  });
});
