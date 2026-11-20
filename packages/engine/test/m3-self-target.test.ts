// M3 step 6 (carried from 5a): a feature activation that acts on its user only, `target: self`.
// Second Wind ("you can use a Bonus Action to regain Hit Points equal to 1d10 plus your Fighter
// level", srd-raw.txt Fighter) and Wholeness of Body ("roll your Martial Arts die. You regain a
// number of Hit Points equal to the number rolled plus your Wisdom modifier (minimum of 1 Hit
// Point regained)", srd-raw.txt:11321-11330) heal the user with no target to pick. The source
// form: `activate: { ..., target: self, do: [{ heal: { roll: ... } }] }`; compiled, the
// activation carries `self: true` and its frame starts with the user as its target, as an
// initiative hook's does. Inert when unused (C3): no `self` key on any other activation.
// Content is synthetic (test: ids).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContent, type LoadResult } from '../src/content/load.ts';
import type { CompiledTemplate } from '../src/content/types.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import type { Decider, DecisionPoint, Legal } from '../src/decide/decider.ts';
import { GreedyDecider } from '../src/decide/greedy/greedy.ts';
import { ArraySink } from '../src/log/events.ts';
import { resolveScenario } from '../src/scenario/resolve.ts';
import { resolveOption } from '../src/sim/act.ts';
import { copyLegal, legalKey, newLegal, releaseList, takeList } from '../src/sim/context.ts';
import { createContext } from '../src/sim/fight.ts';
import { listOptions } from '../src/sim/options.ts';
import { applyPassives } from '../src/sim/precast.ts';
import type { FightSetup } from '../src/sim/setup.ts';
import type { Unit } from '../src/sim/state.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const walk = (d: string): string[] =>
  readdirSync(d)
    .flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.yaml') ? [p] : [];
    })
    .sort();
const readPack = (name: string): SourceFile[] => walk(join(ROOT, 'packs', name)).map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, 'utf8') }));
const REPO = [...readPack('srd-5.2.1'), ...readPack('test')];
const messages = (r: LoadResult) => r.errors.map(formatDiag).join('\n');

const feature = (id: string, body: string) => `kind: feature\nid: test:${id}\nname: ${id}\nsource: synthetic test fixture\n${body}`;
const PC = (features: string[]) => `kind: pc
id: test:lab-mender
name: Lab Mender
source: synthetic test fixture
rules: '2024'
level: 6
size: medium
speed: 30
abilities: { str: 10, dex: 14, con: 14, int: 10, wis: 16, cha: 8 }
hpMax: 45
ac: 14
armor: none
saveProficiencies: [str, dex]
weapons:
  - { id: club, name: Club, kind: melee, ability: str, damage: [{ roll: 1d4 + @mod, type: bludgeoning }] }
pools:
  - { id: mend, name: Mend, max: 3, recharge: longRest }
features: [${features.join(', ')}]
`;
const BRUTE = `kind: monster
id: test:self-brute
name: Self Brute
source: synthetic test fixture
size: medium
cr: 0
pb: 2
ac: 12
hp: { average: 300, formula: 30d10 + 135 }
speed: { walk: 30 }
initiative: { mod: 0, score: 10 }
abilities: { str: 10, dex: 12, con: 10, int: 10, wis: 10, cha: 10 }
attacks:
  - { id: maul, name: Maul, kind: melee, toHit: 8, damage: [{ roll: 2d6 + 6, type: bludgeoning, avg: 13 }] }
`;
// Wholeness-of-Body shaped: a bonus action, a pool use, the die plus a modifier with a minimum of 1.
const MEND = feature('lab-mend', "activate: { id: mend, name: Mend, cost: bonus, uses: { pool: mend }, target: self, do: [{ heal: { roll: 'max(1, 1d8 - 2)' } }] }\n");
// Second-Wind shaped: a flat part plus a die.
const RALLY = feature('lab-rally-self', "activate: { id: rally, name: Rally, cost: bonus, uses: { pool: mend }, target: self, do: [{ heal: { roll: '1d10 + 6' } }] }\n");
const KIT: Record<string, string> = {
  'packs/test/monsters/self-brute.yaml': BRUTE,
  'packs/test/data/lab-mend.yaml': MEND,
  'packs/test/data/lab-rally-self.yaml': RALLY,
};

function load(extra: Record<string, string>, features: string[]): LoadResult {
  const files = [...REPO, ...Object.entries({ ...KIT, ...extra, 'packs/test/pcs/lab-mender.yaml': PC(features) }).map(([path, text]) => ({ path, text }))];
  return loadContent(files);
}

function setupOf(features: string[], hp: number, foeAt = 'C2'): FightSetup {
  const r = load({}, features);
  if (!r.content) throw new Error(messages(r));
  const doc = {
    kind: 'scenario', id: 'self-lab', name: 'Self lab', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: { w: 10, h: 4 },
    flags: { initiativeMode: 'static' }, knobs: { downEnds: false },
    units: [
      { seat: 'pc1', team: 'party', use: 'test:lab-mender', at: 'B2', hp },
      { seat: 'b1', team: 'enemies', use: 'test:self-brute', at: foeAt },
    ],
  };
  const res = resolveScenario(doc, 'self-lab.yaml', r.content);
  if (!res.setup) throw new Error(res.errors.map(formatDiag).join('\n'));
  return res.setup;
}

const tplOf = (s: FightSetup, id: string): CompiledTemplate => s.seats.find((x) => x.tpl.id === id)!.tpl;

function turnOptions(s: FightSetup, deciders: Decider[], sink: ArraySink | null = null) {
  const cx = createContext(s, 1, 0, deciders, sink, { audit: true });
  applyPassives(cx, -1);
  const u = (seat: string): Unit => cx.st.units.find((x) => x.seat === seat)!;
  const begin = (who: Unit) => {
    cx.st.active = who.idx;
    cx.st.turnIdx++;
    who.turns++;
    Object.assign(who.b, { action: 1, bonus: 1, reaction: 1, freeObj: 1, moveFt: who.tpl.speedFt, atkActive: false, movedFt: 0 });
  };
  const options = (who: Unit): { l: Legal; key: string }[] => {
    const list = listOptions(cx, who, takeList(cx));
    const out = list.items.slice(0, list.n).map((l) => ({ l: copyLegal(l, newLegal()), key: legalKey(cx.st, who.idx, l) }));
    releaseList(cx, list);
    return out;
  };
  return { cx, u, begin, options };
}

describe('target: self compiles to a self activation, and nothing else changes (C3)', () => {
  it('a target: self activation compiles with self: true; an activation without it has no self key (Second Wind and Wholeness of Body are the committed self activations)', () => {
    const s = setupOf(['test:lab-mend'], 45);
    const f = tplOf(s, 'test:lab-mender').features.find((x) => x.id === 'test:lab-mend')!;
    expect(f.activate!.self).toBe(true);
    const r = loadContent(REPO);
    if (!r.content) throw new Error(messages(r));
    // Second Wind (step 6) and Wholeness of Body (flipped after step 6) are the committed features mapped
    // with target: self (their overrides in tools/import-srd/overrides/feature/), and W1 adds Rage, Steady
    // Aim and Adrenaline Rush (docs/design/w1-plan.md section 3); every other activation has no self key.
    const SELF = ['srd:fighter/second-wind', 'srd:warrior-of-the-open-hand/wholeness-of-body', 'srd:barbarian/rage', 'srd:rogue/steady-aim', 'srd:orc/adrenaline-rush'];
    for (const t of r.content.templates) for (const ft of t.features) for (const a of [ft.activate, ...(ft.more ?? [])]) if (a) expect(Object.hasOwn(a, 'self'), `${t.id} ${ft.id}`).toBe(SELF.includes(ft.id));
  });

  it('without target: self a heal with no target step is a load error (the gap 5a left: "needs engine support: self-target")', () => {
    const r = load({ 'packs/test/data/lab-mend.yaml': feature('lab-mend', "activate: { id: mend, name: Mend, cost: bonus, uses: { pool: mend }, do: [{ heal: { roll: '1d8' } }] }\n") }, ['test:lab-mend']);
    expect(r.content).toBeNull();
    expect(messages(r)).toMatch(/heal needs targets/);
  });

  it('target: self with a target step of its own is a load error (it acts on its user only)', () => {
    const r = load(
      { 'packs/test/data/lab-mend.yaml': feature('lab-mend', "activate: { id: mend, name: Mend, cost: bonus, target: self, do: [{ target: { range: 30, who: ally, self: 'yes' } }, { heal: { roll: '1d8' } }] }\n") },
      ['test:lab-mend'],
    );
    expect(r.content).toBeNull();
    expect(messages(r)).toMatch(/acts on its user only/);
  });

  it('target accepts only self', () => {
    const r = load({ 'packs/test/data/lab-mend.yaml': feature('lab-mend', "activate: { id: mend, name: Mend, cost: bonus, target: ally, do: [{ heal: { roll: '1d8' } }] }\n") }, ['test:lab-mend']);
    expect(r.content).toBeNull();
  });
});

describe('a self activation heals its user, with no target decision (Second Wind, Wholeness of Body)', () => {
  it('"you regain Hit Points": the user regains them, one pool use and the Bonus Action are spent, and nobody is asked for a target', () => {
    for (const id of ['test:lab-mend', 'test:lab-rally-self']) {
      const s = setupOf([id], 10);
      const asked: string[] = [];
      const d: Decider = { name: 'rec', decide: (_v, dp) => (asked.push(dp.k), 0) };
      const sink = new ArraySink();
      const w = turnOptions(s, s.seats.map(() => d), sink);
      const pc = w.u('pc1');
      w.begin(pc);
      const o = w.options(pc).find((x) => x.key === `use:${id.slice(5)}`);
      expect(o, `use:${id} offered`).toBeDefined();
      const pool = pc.tpl.pools.findIndex((p) => p.local === 'mend') + 9;
      resolveOption(w.cx, pc, o!.l, -1);
      const heal = sink.events.find((e) => e.k === 'heal');
      expect(heal && heal.k === 'heal' && heal.tgt).toBe(pc.idx);
      expect(pc.hp).toBeGreaterThan(10);
      expect(pc.res[pool]).toBe(2);
      expect(pc.b.bonus).toBe(0);
      expect(asked).toEqual([]);
    }
  });

  it('Wholeness of Body\'s "minimum of 1 Hit Point regained" (11321-11330): max(1, 1d8 - 2) never heals less than 1 over many seeds', () => {
    const s = setupOf(['test:lab-mend'], 10);
    const seen = new Set<number>();
    for (let seed = 1; seed <= 60; seed++) {
      const cx = createContext(s, seed, 0, s.seats.map(() => ({ name: 'f', decide: () => 0 })), null, { audit: true });
      applyPassives(cx, -1);
      const pc = cx.st.units.find((x) => x.seat === 'pc1')!;
      cx.st.active = pc.idx;
      cx.st.turnIdx++;
      pc.turns++;
      Object.assign(pc.b, { action: 1, bonus: 1, reaction: 1 });
      const list = listOptions(cx, pc, takeList(cx));
      let l: Legal | null = null;
      for (let i = 0; i < list.n; i++) if (legalKey(cx.st, pc.idx, list.items[i]!) === 'use:lab-mend') l = copyLegal(list.items[i]!, newLegal());
      releaseList(cx, list);
      resolveOption(cx, pc, l!, -1);
      const got = pc.hp - 10;
      expect(got).toBeGreaterThanOrEqual(1);
      expect(got).toBeLessThanOrEqual(6);
      seen.add(got);
    }
    expect(seen.has(1)).toBe(true); // 1d8 of 1, 2 or 3 all clamp to 1
  });
});

describe('greedy values a self activation on its user', () => {
  const pick = (hp: number) => {
    const s = setupOf(['test:lab-rally-self'], hp);
    const ds = s.seats.map(() => new GreedyDecider());
    const w = turnOptions(s, ds);
    const pc = w.u('pc1');
    w.begin(pc);
    pc.b.action = 0; // the Attack action spent: what's left is the bonus action, moves and ending the turn
    const opts = w.options(pc);
    const dp: DecisionPoint = { k: 'turn', who: pc.idx, at: 0, round: 1, cause: -1, legal: { n: opts.length, items: opts.map((o) => o.l) }, keyOf: (i) => opts[i]!.key };
    return opts[ds[pc.idx]!.decide(w.cx.views[pc.idx]!, dp)]!.key;
  };

  it('at 4 HP next to a brute (2d6 + 6) it heals itself (1d10 + 6) with the bonus action: the heal is valued on its user', () => {
    expect(pick(4)).toBe('use:lab-rally-self');
  });

  it('at full HP it doesn\'t spend a use on a heal that restores nothing', () => {
    expect(pick(45)).not.toBe('use:lab-rally-self');
  });

  // The pool-spend valuation (altPerPoint, read by pointBase for every pool cost on the step-5a
  // model): "the best other use of a point" walks each activation's program, and a self
  // activation's must be valued on its user (targets: [me]), as the turn decision values it.
  it('what else a pool point could buy counts a self heal on its user: worth points at 4 HP, nothing at full HP', () => {
    const alt = (hp: number) => {
      const s = setupOf(['test:lab-rally-self'], hp);
      const ds = s.seats.map(() => new GreedyDecider());
      const w = turnOptions(s, ds);
      const pc = w.u('pc1');
      w.begin(pc);
      const opts = w.options(pc);
      const dp: DecisionPoint = { k: 'turn', who: pc.idx, at: 0, round: 1, cause: -1, legal: { n: opts.length, items: opts.map((o) => o.l) }, keyOf: (i) => opts[i]!.key };
      const d = ds[pc.idx]!;
      d.decide(w.cx.views[pc.idx]!, dp); // binds the decider to this view, as a real decision does
      const pool = pc.tpl.pools.findIndex((p) => p.local === 'mend') + 9;
      const inner = d as unknown as { altCache: unknown[]; altPerPoint(st: unknown, me: Unit, res: number, ex: unknown): number };
      inner.altCache.length = 0;
      return inner.altPerPoint(w.cx.views[pc.idx]!.q, pc, pool, null);
    };
    expect(alt(4)).toBeGreaterThan(1);
    expect(alt(45)).toBe(0);
  });
});

describe('step 6 integration: the imported Second Wind on the class-built Fighter (SRD 5.2.1 p.48, srd-raw.txt:10592-10607)', () => {
  it('test:sample-fighter-built (Fighter 5) is offered use:fighter/second-wind and regains 1d10 + 5 Hit Points itself, one use spent', () => {
    const r = loadContent(REPO);
    if (!r.content) throw new Error(messages(r));
    const doc = {
      kind: 'scenario', id: 'sw-lab', name: 'Second Wind lab', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: { w: 10, h: 4 },
      flags: { initiativeMode: 'static' }, knobs: { downEnds: false },
      units: [
        { seat: 'pc1', team: 'party', use: 'test:sample-fighter-built', at: 'B2', hp: 10 },
        { seat: 'b1', team: 'enemies', use: 'srd:goblin-warrior', at: 'H2' },
      ],
    };
    const res = resolveScenario(doc, 'sw-lab.yaml', r.content);
    if (!res.setup) throw new Error(res.errors.map(formatDiag).join('\n'));
    const s = res.setup;
    const tpl = tplOf(s, 'test:sample-fighter-built');
    const ft = tpl.features.find((x) => x.id === 'srd:fighter/second-wind')!;
    expect(ft.activate!.self).toBe(true);
    const pool = tpl.pools.findIndex((p) => p.local === 'second-wind');
    expect(pool).toBeGreaterThanOrEqual(0);
    const seen = new Set<number>();
    for (let seed = 1; seed <= 40; seed++) {
      const sink = new ArraySink();
      const asked: string[] = [];
      const d: Decider = { name: 'rec', decide: (_v, dp) => (asked.push(dp.k), 0) };
      const cx = createContext(s, seed, 0, s.seats.map(() => d), sink, { audit: true });
      applyPassives(cx, -1);
      const pc = cx.st.units.find((x) => x.seat === 'pc1')!;
      cx.st.active = pc.idx;
      cx.st.turnIdx++;
      pc.turns++;
      Object.assign(pc.b, { action: 1, bonus: 1, reaction: 1, freeObj: 1, moveFt: pc.tpl.speedFt, atkActive: false, movedFt: 0 });
      const before = pc.res[pool + 9]!;
      const list = listOptions(cx, pc, takeList(cx));
      let l: Legal | null = null;
      const keys: string[] = [];
      for (let i = 0; i < list.n; i++) {
        const k = legalKey(cx.st, pc.idx, list.items[i]!);
        keys.push(k);
        if (k === 'use:fighter/second-wind') l = copyLegal(list.items[i]!, newLegal());
      }
      releaseList(cx, list);
      expect(l, `use:fighter/second-wind offered among ${keys.join(' ')}`).not.toBeNull();
      resolveOption(cx, pc, l!, -1);
      const heal = sink.events.find((e) => e.k === 'heal');
      expect(heal && heal.k === 'heal' && heal.tgt).toBe(pc.idx);
      const got = pc.hp - 10;
      expect(got).toBeGreaterThanOrEqual(6);
      expect(got).toBeLessThanOrEqual(15);
      seen.add(got);
      expect(pc.res[pool + 9]).toBe(before - 1);
      expect(pc.b.bonus).toBe(0);
      // W1: Tactical Shift (Fighter 5) augments it with a free move, its one decision (P9).
      expect(asked).toEqual(['moveTo']);
    }
    expect(seen.size).toBeGreaterThan(4);
  });
});
