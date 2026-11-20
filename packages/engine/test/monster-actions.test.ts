// Coverage step 7.6: the monster-features seam. Recharge X-Y (srd-raw.txt:44017-44025), the book rule
// (43605-43615), a monster's printed DC, and its aim through every decider. The stat blocks here are
// synthetic except the pack's own White Dragon Wyrmling (56054-56056).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../src/content/load.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import type { Decider } from '../src/decide/decider.ts';
import { GreedyDecider, type ExplainRecord } from '../src/decide/greedy/greedy.ts';
import { JournalCursor, JournalDecider } from '../src/decide/journal.ts';
import { namedDecider } from '../src/decide/make.ts';
import { ArraySink, type GameEvent as LogEvent } from '../src/log/events.ts';
import { PURPOSES } from '../src/rng/stream.ts';
import { resolveScenario } from '../src/scenario/resolve.ts';
import { createContext, runFight } from '../src/sim/fight.ts';

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

const block = (id: string, more: string, opt: { walk?: number; pb?: number; multi?: boolean } = {}) => `kind: monster
id: test:${id}
name: ${id}
source: synthetic test fixture
size: medium
cr: 1
pb: ${opt.pb ?? 2}
ac: 12
hp: { average: 400, formula: '400' }
speed: { walk: ${opt.walk ?? 30} }
initiative: { mod: 0, score: 10 }
abilities: { str: 14, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }
attacks:
  - { id: claw, name: Claw, kind: melee, toHit: 4, damage: [{ roll: '1d6', type: slashing, avg: 3 }] }
${opt.multi === false ? '' : 'multiattack: { alternatives: [[{ count: 2, from: [claw] }]] }'}
${more}
`;
const breath = (uses: string, dc = 13) => `actions:
  - id: gust
    name: Gust
    cost: action
    ${uses ? `uses: ${uses}` : ''}
    area: blast
    effects:
      - id: blast
        name: Gust
        zone: { shape: cone, size: 15 }
        duration: { rounds: 1 }
        on: [{ when: [appear], do: [{ save: { ability: con, dc: ${dc}, half: true, damage: [{ roll: 4d6, type: cold }] } }] }]
    do: [{ apply: { effect: blast, to: point } }]
`;
const KIT: Record<string, string> = {
  'packs/test/monsters/ma-56.yaml': block('ma-56', breath('{ recharge: [5, 6] }')),
  'packs/test/monsters/ma-6.yaml': block('ma-6', breath('{ recharge: [6] }')),
  'packs/test/monsters/ma-46.yaml': block('ma-46', breath('{ recharge: [4, 6] }')),
  'packs/test/monsters/ma-day.yaml': block('ma-day', breath('{ perDay: 2 }')),
  'packs/test/monsters/ma-will.yaml': block('ma-will', breath('')),
  'packs/test/monsters/ma-still.yaml': block('ma-still', breath('{ recharge: [5, 6] }'), { walk: 0 }),
  'packs/test/monsters/ma-plain.yaml': block('ma-plain', ''),
  'packs/test/monsters/ma-post.yaml': block('ma-post', '', { walk: 0, multi: false }),
  'packs/test/features/ma-pc-blast.yaml': `kind: feature
id: test:ma-pc-blast
name: ma-pc-blast
source: synthetic test fixture
spellAbility: int
effects:
  - id: blast
    name: Blast
    zone: { shape: cone, size: 15 }
    duration: { rounds: 1 }
    on: [{ when: [appear], do: [{ save: { ability: con, half: true, damage: [{ roll: 4d6, type: cold }] } }] }]
activate: { id: blast-use, name: Blast, cost: action, pool: blasts, area: blast, do: [{ apply: { effect: blast, to: point } }] }
`,
  'packs/test/pcs/ma-pc.yaml': `kind: pc
id: test:ma-pc
name: MA PC
source: synthetic test fixture
rules: '2024'
level: 5
size: medium
speed: 30
abilities: { str: 8, dex: 12, con: 14, int: 18, wis: 10, cha: 8 }
hpMax: 44
ac: 14
armor: none
saveProficiencies: [int, wis]
weapons:
  - { id: club, name: Club, kind: melee, ability: str, category: simple, damage: [{ roll: 1d4 + @mod, type: bludgeoning }] }
pools: [{ id: blasts, name: Blasts, max: 3, recharge: longRest }]
features: [test:ma-pc-blast]
`,
};

class LoadFailed extends Error {}
const loads = new Map<string, ReturnType<typeof loadContent>>();
const contentOf = (extra: Record<string, string> = {}) => {
  const own = Object.entries({ ...KIT, ...extra }).map(([path, text]) => ({ path, text }));
  const k = JSON.stringify(own);
  const r = loads.get(k) ?? loadContent([...REPO, ...own]);
  loads.set(k, r);
  return r;
};
type U = { seat: string; team: 'party' | 'enemies'; use: string; at: string };
const setup = (units: U[], maxRounds = 12, flags: Record<string, unknown> = {}) => {
  const r = contentOf();
  if (!r.content) throw new LoadFailed(r.errors.map(formatDiag).join('\n'));
  const res = resolveScenario({ kind: 'scenario', id: 'ma', name: 'MA', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: { w: 16, h: 16 }, flags: { initiativeMode: 'static', ...flags }, knobs: { downEnds: false, maxRounds }, units: units.map((u) => ({ ...u, decider: 'greedy' })) }, 'ma.yaml', r.content);
  if (!res.setup) throw new Error(res.errors.map(formatDiag).join('\n'));
  return res.setup;
};
const compileErrors = (text: string) => {
  const r = contentOf({ 'packs/test/monsters/bad.yaml': text });
  return r.errors.map(formatDiag).join('\n');
};
const by = <K extends LogEvent['k']>(sink: ArraySink, k: K) => (sink.events as LogEvent[]).filter((e): e is Extract<LogEvent, { k: K }> => e.k === k);
const greedyAll = (s: ReturnType<typeof setup>) => s.seats.map(() => new GreedyDecider());
const post = (seat: string, at: string): U => ({ seat, team: 'party', use: 'test:ma-post', at });
const drake = (use: string, at: string): U => ({ seat: 'drake', team: 'enemies', use: `test:${use}`, at });
/** A monster's turns as the keys it took, round by round. */
const fight = (s: ReturnType<typeof setup>, seed: number) => {
  const sink = new ArraySink();
  const r = runFight(s, seed, 0, greedyAll(s), sink, { audit: true });
  return { sink, r };
};

describe('the seam compiles', () => {
  it('a monster with no actions keeps every field as today (C3)', () => {
    const t = setup([drake('ma-plain', 'A1'), post('p', 'P16')]).seats[0]!.tpl;
    expect(t.features).toEqual([]);
    expect(t.pools).toEqual([]);
    expect(t.effects).toEqual([]);
    expect(t.resMax).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect('rechargeUse' in t).toBe(false);
  });
  it('a recharge action: one pool, charged at fight start, and its printed DC', () => {
    const t = setup([drake('ma-56', 'A1'), post('p', 'P16')]).seats[0]!.tpl;
    expect(t.resMax.slice(9)).toEqual([1]);
    expect(t.rechargeUse).toEqual([{ pool: 9, min: 5, via: 'test:ma-56/gust', name: 'Gust' }]);
    const a = t.features[0]!.activate!;
    expect([a.cost, a.pool, a.recharge, a.book, a.area?.from]).toEqual(['action', 9, 5, true, 'aim']);
    const hook = t.effects[0]!.hooks[0]!.steps[0]!;
    // 13, printed: nothing here adds up to it (8 + PB 2 + no ability above +2 would be 12).
    expect(hook.k === 'save' && hook.dc).toBe(13);
  });
  it('the pack wyrmling: DC 12, 5d8, half, Recharge 5-6 (56054-56056)', () => {
    const t = setup([{ seat: 'drake', team: 'enemies', use: 'srd:white-dragon-wyrmling', at: 'A1' }, post('p', 'P16')]).seats[0]!.tpl;
    const h = t.effects[0]!.hooks[0]!.steps[0]!;
    expect(h.k === 'save' && [h.dc, h.half, h.ability]).toEqual([12, true, 2]);
    expect(t.features[0]!.activate!.recharge).toBe(5);
  });
  it('a monster save with no dc is refused, and so is a dc on a spell or feature', () => {
    expect(compileErrors(block('bad', breath('{ recharge: [5, 6] }').replace('dc: 13, ', '')))).toMatch(/needs its printed dc/);
    const r = contentOf({ 'packs/test/features/bad.yaml': KIT['packs/test/features/ma-pc-blast.yaml']!.replace('test:ma-pc-blast', 'test:bad-f').replace('ability: con,', 'ability: con, dc: 11,') });
    expect(r.errors.map(formatDiag).join('\n')).toMatch(/a printed dc is for a monster action/);
  });
  it('a recharge range must end at 6, and action ids are unique', () => {
    expect(compileErrors(block('bad', breath('{ recharge: [4, 5] }')))).toMatch(/recharge is \[X, 6\]/);
    const two = breath('').replace('actions:\n', '') ;
    expect(compileErrors(block('bad', `actions:\n${two}${two}`))).toMatch(/action id "gust" is used twice/);
  });
  it('a limited action that does no damage is not the book rule\'s', () => {
    const quiet = `actions:
  - id: mire
    name: Mire
    cost: action
    uses: { perDay: 1 }
    area: bog
    effects:
      - { id: bog, name: Mire, zone: { shape: cone, size: 15, difficult: true }, duration: { rounds: 1 } }
    do: [{ apply: { effect: bog, to: point } }]
`;
    const r = contentOf({ 'packs/test/monsters/quiet.yaml': block('quiet', quiet) });
    if (!r.content) throw new LoadFailed(r.errors.map(formatDiag).join('\n'));
    const res = resolveScenario({ kind: 'scenario', id: 'q', name: 'Q', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: { w: 8, h: 8 }, flags: {}, knobs: {}, units: [{ seat: 'drake', team: 'enemies', use: 'test:quiet', at: 'A1', decider: 'greedy' }, { seat: 'p', team: 'party', use: 'test:ma-post', at: 'H8', decider: 'greedy' }] }, 'q.yaml', r.content);
    expect(res.setup!.seats[0]!.tpl.features[0]!.activate!.book).toBeUndefined();
  });
  it('a PC\'s pool activation never carries the book', () => {
    const t = setup([{ seat: 'a-pc', team: 'party', use: 'test:ma-pc', at: 'A1' }, drake('ma-plain', 'P16')]).seats[0]!.tpl;
    const a = t.features[0]!.activate!;
    expect(a.pool).toBeGreaterThanOrEqual(9);
    expect(a.book).toBeUndefined();
    expect(a.recharge).toBeUndefined();
  });
});

describe('Recharge X-Y (srd-raw.txt:44017-44025)', () => {
  it.each([['ma-56', 5], ['ma-6', 6], ['ma-46', 4]] as const)('%s comes back on %i or more, and on nothing less', (use, min) => {
    const seen = new Set<number>();
    for (let seed = 1; seed <= 12; seed++) {
      const { sink } = fight(setup([drake(use, 'H8'), post('p', 'I8')], 14), seed);
      for (const e of by(sink, 'recharge')) {
        expect(e.back).toBe(e.roll >= min);
        expect(e.min).toBe(min);
        seen.add(e.roll);
      }
    }
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it('rolls only while spent: never before the first use, never while charged', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const { sink } = fight(setup([drake('ma-56', 'H8'), post('p', 'I8')], 14), seed);
      let charged = true;
      for (const e of sink.events as LogEvent[]) {
        if (e.k === 'recharge') {
          expect(charged).toBe(false);
          charged = e.back;
        }
        if (e.k === 'res' && e.pool === 'Gust') {
          expect(charged).toBe(true);
          charged = false;
        }
      }
    }
  });
  it('a charged monster with nothing to breathe on rolls nothing and keeps it', () => {
    const s = setup([drake('ma-still', 'A1'), post('p', 'P16')], 5);
    const { sink } = fight(s, 1);
    expect(by(sink, 'recharge')).toEqual([]);
    expect(by(sink, 'res')).toEqual([]);
  });
  it('no draw for a non-user: only the Recharge user has a roll', () => {
    const s = setup([drake('ma-56', 'H8'), { seat: 'grunt', team: 'enemies', use: 'test:ma-plain', at: 'G8' }, post('p', 'I8')], 14);
    const rolls = by(fight(s, 3).sink, 'recharge');
    expect(rolls.length).toBeGreaterThan(0);
    expect(new Set(rolls.map((e) => e.who))).toEqual(new Set([s.seats.findIndex((x) => x.seat === 'drake')]));
  });
  it('recharge is the last purpose: every other purpose keeps its index, so its address', () => {
    expect(PURPOSES.at(-1)).toBe('recharge');
    expect(PURPOSES.slice(0, 3)).toEqual(['init', 'attack', 'save']);
    expect(PURPOSES.indexOf('reaction')).toBe(PURPOSES.length - 2);
  });
  it('per day: n uses, never back, no recharge roll', () => {
    const { sink } = fight(setup([drake('ma-day', 'H8'), post('p', 'I8')], 12), 2);
    expect(by(sink, 'recharge')).toEqual([]);
    expect(by(sink, 'res').filter((e) => e.pool === 'Gust').map((e) => e.left)).toEqual([1, 0]);
    expect(by(sink, 'zone').length).toBe(2);
  });
  it('each fight starts charged', () => {
    const s = setup([drake('ma-56', 'H8'), post('p', 'I8')], 4);
    const first = fight(s, 1);
    expect(by(first.sink, 'zone').length).toBeGreaterThan(0);
    const cx = createContext(s, 2, 0, greedyAll(s), null);
    expect(cx.st.units[0]!.res[9]).toBe(1);
    const second = fight(s, 2);
    // Its first turn breathes again: the first event of the fight's first monster turn spends it.
    expect(by(second.sink, 'res').find((e) => e.pool === 'Gust')?.left).toBe(0);
  });
  it('a dead monster never rolls', () => {
    const s = setup([{ seat: 'drake', team: 'enemies', use: 'srd:white-dragon-wyrmling', at: 'H8' }, { seat: 'pc', team: 'party', use: 'test:sample-fighter', at: 'I8' }, { seat: 'pc2', team: 'party', use: 'test:sample-fighter', at: 'I9' }], 10);
    let deaths = 0;
    for (let seed = 1; seed <= 5; seed++) {
      const { sink } = fight(s, seed);
      let dead = false;
      for (const e of sink.events as LogEvent[]) {
        if (e.k === 'death' && e.who === 0) dead = true;
        if (e.k === 'recharge') expect(dead).toBe(false);
      }
      deaths += dead ? 1 : 0;
    }
    expect(deaths).toBeGreaterThan(0);
  });
});

describe('the book rule (srd-raw.txt:43605-43615)', () => {
  const rec = (use: string, at: string, posts: U[]) => {
    const s = setup([drake(use, at), ...posts], 1);
    const sink = new ArraySink();
    const ds = greedyAll(s);
    const records: ExplainRecord[] = [];
    ds[0]!.explainTo((x) => records.push(x));
    runFight(s, 1, 0, ds, sink);
    return { sink, records };
  };
  it('next to one enemy, with Multiattack ready, it breathes', () => {
    const { sink, records } = rec('ma-56', 'H8', [post('p', 'I8')]);
    expect(by(sink, 'zone').length).toBe(1);
    const parts = records[0]!.top[0]!.parts.map((p) => p.term);
    expect(parts).toContain('book: limited ability first');
  });
  it('the breath takes the action: no strike that turn', () => {
    const { sink } = rec('ma-56', 'H8', [post('p', 'I8')]);
    expect(by(sink, 'attack').filter((e) => e.att === 0)).toEqual([]);
    expect((sink.events as LogEvent[]).filter((e) => e.k === 'act' && e.who === 0 && e.name === 'Multiattack')).toEqual([]);
  });
  it('out of reach it walks into cone range and breathes', () => {
    const { sink } = rec('ma-56', 'C8', [post('p', 'I8')]);
    expect(by(sink, 'zone').length).toBe(1);
    expect(by(sink, 'step').filter((e) => e.who === 0).length).toBeGreaterThan(0);
  });
  it('40 and 45 ft away, past its claw\'s reach after moving but in the breath\'s, it walks and breathes: no Dash first', () => {
    for (const at of ['K8', 'L8']) {
      const { sink, records } = rec('ma-56', 'C8', [post('p', at)]);
      expect(by(sink, 'zone').length, at).toBe(1);
      expect(records.map((r) => r.chosen), at).not.toContain('opt:dash');
    }
  });
  it('a breath whose every aim at the enemy costs its own side more is no book play: no ally caught', () => {
    const own = (seat: string, at: string): U => ({ seat, team: 'enemies', use: 'test:ma-post', at });
    const { sink, records } = rec('ma-56', 'H8', [post('p', 'I8'), own('o1', 'I7'), own('o2', 'I9'), own('o3', 'J8'), own('o4', 'J7'), own('o5', 'J9'), own('o6', 'H7'), own('o7', 'H9')]);
    const allies = new Set([2, 3, 4, 5, 6, 7, 8]);
    expect(by(sink, 'save').filter((e) => e.purpose === 'save' && allies.has(e.who))).toEqual([]);
    for (const r of records) for (const o of r.top) if (o.key.startsWith('use:')) expect(o.parts.map((p) => p.term), o.key).not.toContain('book: limited ability first');
  });
  it('with no enemy it can cover this turn it keeps the breath', () => {
    const { sink, records } = rec('ma-56', 'A1', [post('p', 'P16')]);
    expect(by(sink, 'zone')).toEqual([]);
    expect(by(sink, 'res')).toEqual([]);
    for (const r of records) for (const o of r.top) expect(o.parts.map((p) => p.term)).not.toContain('book: limited ability first');
  });
  it('spent, it uses Multiattack', () => {
    const s = setup([drake('ma-day', 'H8'), post('p', 'I8')], 4);
    const { sink } = fight(s, 2);
    const moves = by(sink, 'attack').filter((e) => e.att === 0);
    expect(by(sink, 'zone').length).toBe(2);
    expect(moves.length).toBe(4); // rounds 3 and 4: two claws each
  });
  it('an at-will area action isn\'t limited: no book, no pool', () => {
    const t = setup([drake('ma-will', 'A1'), post('p', 'P16')]).seats[0]!.tpl;
    expect(t.features[0]!.activate!.book).toBeUndefined();
    expect(t.features[0]!.activate!.pool).toBe(-1);
    expect(t.resMax.length).toBe(9);
  });
  it('a PC\'s pool-spending area stays priced: no book term, and it pays for a point', () => {
    const s = setup([{ seat: 'a-pc', team: 'party', use: 'test:ma-pc', at: 'H8' }, { seat: 'foe', team: 'enemies', use: 'test:ma-post', at: 'I8' }], 1);
    const ds = greedyAll(s);
    const records: ExplainRecord[] = [];
    ds[0]!.explainTo((x) => records.push(x));
    runFight(s, 1, 0, ds, new ArraySink());
    const rows = records.flatMap((r) => r.top).filter((o) => o.key.startsWith('use:'));
    expect(rows.length).toBeGreaterThan(0);
    for (const o of rows) {
      expect(o.parts.map((p) => p.term)).not.toContain('book: limited ability first');
      expect(o.ev).toBeLessThan(500);
    }
  });
});

describe('a monster\'s aim', () => {
  const units = [drake('ma-56', 'H8'), post('p1', 'J8'), post('p2', 'J9')];
  const zones = (sink: ArraySink) => by(sink, 'zone').map((z) => z.anchor);
  it('greedy aims at both', () => {
    const { sink } = fight(setup(units, 1), 1);
    const first = sink.events as LogEvent[];
    expect(zones(sink).length).toBe(1);
    const saves = first.filter((e) => e.k === 'save');
    expect(saves.length).toBe(2);
  });
  it('one damage roll for the group (p.16): each failed save takes the same dice', () => {
    let both = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const { sink } = fight(setup(units, 1), seed);
      const parts = by(sink, 'damage').filter((e) => e.src === 0).map((e) => e.parts.map((p) => p.rolled));
      if (parts.length !== 2) continue;
      both++;
      expect(parts[0]).toEqual(parts[1]);
    }
    expect(both).toBeGreaterThan(0);
  });
  const J = (keys: string[], fb: Decider | null) => new JournalDecider(new JournalCursor(keys.map((key) => ({ seat: 'drake', key }))), fb);
  it('a journal names it, and that\'s the one stamped', () => {
    const s = setup(units, 1);
    const sink = new ArraySink();
    runFight(s, 1, 0, s.seats.map((_, i) => (i === 0 ? J(['use:gust', 'aim:SE'], new GreedyDecider()) : new GreedyDecider())), sink);
    expect(zones(sink)).toEqual(['H8>SE']);
  });
  it('a journal that stops mid-action hands the aim to its fallback', () => {
    const s = setup(units, 1);
    const sink = new ArraySink();
    runFight(s, 1, 0, s.seats.map((_, i) => (i === 0 ? J(['use:gust'], new GreedyDecider()) : new GreedyDecider())), sink);
    expect(zones(sink).length).toBe(1);
    expect(zones(sink)[0]).not.toBe('H8>N');
  });
  it('the baseline AI, handed the action by a journal, takes the first aim listed', () => {
    const s = setup(units, 1);
    const sink = new ArraySink();
    runFight(s, 1, 0, s.seats.map((_, i) => (i === 0 ? J(['use:gust'], namedDecider('baseline')) : new GreedyDecider())), sink);
    expect(zones(sink)).toEqual(['H8>N']);
  });
  it('the baseline AI left alone never uses it', () => {
    const s = setup(units, 2);
    const sink = new ArraySink();
    runFight(s, 1, 0, s.seats.map(() => namedDecider('baseline')), sink);
    expect(zones(sink)).toEqual([]);
  });
});

describe('the golden, read as the rules', () => {
  const log = readFileSync(join(ROOT, 'scenarios/golden/breath-cone.seed60.log'), 'utf8');
  const lines = log.split('\n');
  const idx = (re: RegExp) => lines.findIndex((l) => re.test(l));
  it('round 1 breath with no roll first; round 2 a failed roll and Multiattack; round 3 back and breath', () => {
    const r2 = idx(/== round 2 ==/);
    const r3 = idx(/== round 3 ==/);
    const firstRoll = idx(/rolls to recharge/);
    expect(idx(/chooses use:cold-breath/)).toBeLessThan(r2);
    expect(firstRoll).toBeGreaterThan(r2);
    expect(lines[firstRoll]).toMatch(/4 \(needs 5-6\): not yet/);
    expect(lines.slice(r2, r3).join('\n')).toMatch(/drake: Multiattack/);
    expect(lines.slice(r3).join('\n')).toMatch(/5 \(needs 5-6\): it comes back[\s\S]*chooses use:cold-breath/);
  });
  it('both caught by one roll: 16 cold each, 8 each at half', () => {
    expect(log).toMatch(/pc1 takes 8 \(16 cold, half\)[^\n]*\n[^\n]*pc2 takes 8 \(16 cold, half\)/);
  });
});
