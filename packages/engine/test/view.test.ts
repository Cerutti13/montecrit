// The replay view (docs/design/m2.md 4.1, 9.1): folding a fight's events over its setup gives
// frames whose cross-checks are clean on every golden and on random fights (greedy, random-legal
// and a scripted policy; a precast; a pull into a zone; rolled monster HP next to an HP override),
// whose last frame matches the real final state (cells, HP, life, conditions, concentration and
// every live zone's cells), and whose every prefix folds to the same frames.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../src/content/load.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import { makeDeciders } from '../src/decide/make.ts';
import { BUILTIN_POLICIES, compilePolicy, type CompiledPolicy } from '../src/decide/policy.ts';
import { ArraySink, type GameEvent } from '../src/log/events.ts';
import { buildFrames, type ViewFrame } from '../src/log/view.ts';
import type { JournalEntry } from '../src/replay.ts';
import { resolveScenario } from '../src/scenario/resolve.ts';
import { runFight } from '../src/sim/fight.ts';
import type { FightSetup } from '../src/sim/setup.ts';
import { COND_IDS, type GameState } from '../src/sim/state.ts';
import { loadScenario } from './helpers/scenario.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const walk = (d: string): string[] =>
  readdirSync(d)
    .flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.yaml') ? [p] : [];
    })
    .sort();
const readPack = (name: string): SourceFile[] => walk(join(ROOT, 'packs', name)).map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, 'utf8') }));
const loaded = loadContent([...readPack('srd-5.2.1'), ...readPack('test')]);
if (!loaded.content) throw new Error(loaded.errors.map(formatDiag).join('\n'));
const CONTENT = loaded.content;
const scenario = (file: string): FightSetup => loadScenario(file, CONTENT);
const builtin = (id: string): CompiledPolicy => BUILTIN_POLICIES.find((p) => p.id === id)!;
const repoPolicy = (id: string): CompiledPolicy => compilePolicy(parse(readFileSync(join(ROOT, 'policies', `${id}.yaml`), 'utf8'))).policy!;

/** What the real final state says, in the view's terms. */
interface Truth {
  readonly cell: number[];
  readonly conds: string[][];
  readonly conc: number[];
  readonly zones: { fx: number; cells: number[] }[];
}

function truthOf(st: GameState): Truth {
  const zones: { fx: number; cells: number[] }[] = [];
  for (const f of st.fx) {
    if (!f.alive || f.zbit < 0) continue;
    const bit = 1 << f.zbit;
    const cells: number[] = [];
    for (let c = 0; c < st.zoneMask.length; c++) if (st.zoneMask[c]! & bit) cells.push(c);
    zones.push({ fx: f.id, cells });
  }
  return {
    cell: st.units.map((u) => u.cell),
    conds: st.units.map((u) => COND_IDS.filter(([b]) => (u.condMask & b) !== 0).map(([, id]) => id as string).sort()),
    conc: st.units.map((u) => u.conc),
    zones,
  };
}

function check(setup: FightSetup, seed: number, run: number, policy: CompiledPolicy | null, journal: readonly JournalEntry[] = []) {
  const sink = new ArraySink();
  let truth: Truth | null = null;
  const r = runFight(setup, seed, run, makeDeciders(setup, journal, undefined, policy), sink, { journal, inspect: (st) => (truth = truthOf(st)) });
  const end = { hp: r.hp, hpMax: r.hpMax, life: r.life };
  const v = buildFrames(setup, sink.events, end);
  expect(v.problems).toEqual([]);
  expect(v.frames).toHaveLength(sink.events.length + 1);
  const last = v.frames[v.frames.length - 1]!;
  const t = truth as unknown as Truth;
  expect(last.units.map((u) => u.cell)).toEqual(t.cell);
  expect(last.units.map((u) => [...u.conds])).toEqual(t.conds);
  expect(last.units.map((u) => u.conc)).toEqual(t.conc);
  expect(last.zones.map((z) => ({ fx: z.fx, cells: [...z.cells].sort((a, b) => a - b) })).sort((a, b) => a.fx - b.fx)).toEqual(t.zones.sort((a, b) => a.fx - b.fx));
  expect(last.outcome).toEqual(r.outcome);
  // Every death leaves a body where the unit died.
  sink.events.forEach((e, i) => {
    if (e.k === 'death') expect(v.frames[i + 1]!.bodies).toContain(v.frames[i + 1]!.units[e.who]!.cell);
  });
  return { setup, events: sink.events, frames: v.frames, end };
}

describe('replay view: buildFrames', () => {
  it('is exact on every golden (journal replays, the HP-override golden included)', () => {
    const golden = join(ROOT, 'scenarios', 'golden');
    const files = readdirSync(golden).filter((x) => x.endsWith('.journal.yaml'));
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const f of files) {
      const doc = parse(readFileSync(join(golden, f), 'utf8')) as { seed: number; run: number; entries: JournalEntry[] };
      check(scenario(join('scenarios', 'golden', f.replace('.journal.yaml', '.yaml'))), doc.seed, doc.run, null, doc.entries);
    }
  });

  it('is exact on 200 random fights: greedy, random-legal and moonbeam-first ambushes, the precast ambush, a pull into spikes', { timeout: 120_000 }, () => {
    const ambush = scenario('scenarios/stars-ambush.yaml');
    const cases: [FightSetup, CompiledPolicy | null, number][] = [
      [ambush, null, 50],
      [ambush, builtin('random-legal'), 40],
      [ambush, repoPolicy('moonbeam-first'), 40],
      [scenario('scenarios/stars-ambush-precast.yaml'), null, 40],
      [scenario('scenarios/golden/pull-into-spikes.yaml'), builtin('random-legal'), 30],
    ];
    let zoneEvents = 0;
    for (const [setup, policy, runs] of cases) {
      for (let run = 0; run < runs; run++) zoneEvents += check(setup, 17, run, policy).events.filter((e) => e.k === 'zone' || e.k === 'zoneMove').length;
    }
    expect(zoneEvents).toBeGreaterThan(50);
  });

  it('M3 step 5a: folds the Monk\'s fights (riders, Deflect, Dodge, Stunned and Prone markers) exactly, and shows Stunned on and off at the right events', { timeout: 120_000 }, () => {
    const monk = scenario('scenarios/monk-ambush.yaml');
    const kinds = new Set<string>();
    const conds = new Set<string>();
    for (const [policy, runs] of [[null, 30], [repoPolicy('stun-first'), 20], [builtin('random-legal'), 20]] as const) {
      for (let run = 0; run < runs; run++) {
        for (const e of check(monk, 23, run, policy).events) {
          kinds.add(e.k === 'decided' ? `decided:${e.dk}` : e.k);
          if (e.k === 'cond' && e.on) conds.add(e.cond);
        }
      }
    }
    for (const k of ['decided:rider', 'decided:hitTaken', 'reduce', 'res', 'act']) expect(kinds.has(k), k).toBe(true);
    for (const c of ['core:stunned', 'core:incapacitated', 'core:prone', 'core:dodging']) expect(conds.has(c), c).toBe(true);
    // The golden: the Boss shows Stunned from the failed save until the Monk's round-2 turn starts.
    const doc = parse(readFileSync(join(ROOT, 'scenarios', 'golden', 'monk-stunning-strike.journal.yaml'), 'utf8')) as { seed: number; run: number; entries: JournalEntry[] };
    const { setup, events, frames } = check(scenario('scenarios/golden/monk-stunning-strike.yaml'), doc.seed, doc.run, null, doc.entries);
    const boss = setup.seats.findIndex((x) => x.seat === 'boss1');
    const on = events.findIndex((e) => e.k === 'cond' && e.who === boss && e.cond === 'core:stunned' && e.on);
    const off = events.findIndex((e) => e.k === 'cond' && e.who === boss && e.cond === 'core:stunned' && !e.on);
    const monkTurn2 = events.findIndex((e, i) => i > off && e.k === 'turnStart' && setup.seats[e.who]!.seat === 'pc1');
    expect([on > 0, off > on, monkTurn2 > off]).toEqual([true, true, true]);
    expect(frames[on]!.units[boss]!.conds).not.toContain('core:stunned');
    for (let i = on + 1; i <= off; i++) expect(frames[i]!.units[boss]!.conds).toContain('core:stunned');
    expect(frames[off + 1]!.units[boss]!.conds).not.toContain('core:stunned');
  });

  it('takes rolled monster HP from the fight end and keeps an HP override (critique resolution 7)', () => {
    const text = readFileSync(join(ROOT, 'scenarios', 'golden', 'oa-interrupts-move.yaml'), 'utf8');
    const res = resolveScenario(text, 'oa-interrupts-move.yaml', CONTENT, { flags: { monsterHp: 'rolled' } });
    if (!res.setup) throw new Error(res.errors.map(formatDiag).join('\n'));
    const setup = res.setup;
    const over = setup.seats.findIndex((s) => s.hp !== null);
    expect(over).toBeGreaterThanOrEqual(0);
    for (let run = 0; run < 10; run++) {
      const { frames } = check(setup, 3, run, null);
      expect(frames[0]!.units[over]!.hp).toBe(setup.seats[over]!.hp);
    }
    // Without the end, the fold says it can't know rolled HP rather than guess silently.
    expect(buildFrames(setup, [], null).problems.join()).toMatch(/rolled monster HP/);
  });

  it('a Stable creature that takes damage shows as dying again (the engine emits only deathFail)', () => {
    const setup = scenario('scenarios/golden/oa-interrupts-move.yaml');
    const base = { round: 1, turnOf: 0, cause: -1 } as const;
    const u = 0;
    const hp = setup.seats[u]!.hp ?? setup.seats[u]!.tpl.hpMax;
    const events = [
      { ...base, seq: 0, k: 'damage', src: 1, tgt: u, via: 'srd:x', slot: 0, crit: false, parts: [], dealt: hp, tempAbsorbed: 0, hpBefore: hp, hpAfter: 0 },
      { ...base, seq: 1, k: 'down', who: u },
      { ...base, seq: 2, k: 'stable', who: u },
      { ...base, seq: 3, k: 'damage', src: 1, tgt: u, via: 'srd:x', slot: 1, crit: false, parts: [], dealt: 3, tempAbsorbed: 0, hpBefore: 0, hpAfter: 0 },
      { ...base, seq: 4, k: 'deathFail', who: u, n: 1, fail: 1 },
    ] as unknown as GameEvent[];
    const v = buildFrames(setup, events, null);
    expect(v.frames.map((f) => f.units[u]!.life)).toEqual(['up', 'up', 'down', 'stable', 'stable', 'down']);
  });

  it('every prefix folds to the same frames', { timeout: 60_000 }, () => {
    const ambush = scenario('scenarios/stars-ambush.yaml');
    for (let run = 0; run < 6; run++) {
      const { setup, events, frames, end } = check(ambush, 29, run, null);
      for (const cut of [0, 1, Math.floor(events.length / 3), Math.floor(events.length / 2), events.length - 1]) {
        const part = buildFrames(setup, events.slice(0, cut), end);
        expect(part.frames.map((f: ViewFrame) => f)).toEqual(frames.slice(0, cut + 1));
      }
    }
  });

  it('marks: the trail starts at the turn cell, a forced move is its own path, a strike clears on the next decision, a delta lasts one frame', () => {
    const doc = parse(readFileSync(join(ROOT, 'scenarios', 'golden', 'pull-into-spikes.journal.yaml'), 'utf8')) as { seed: number; run: number; entries: JournalEntry[] };
    const { events, frames } = check(scenario('scenarios/golden/pull-into-spikes.yaml'), doc.seed, doc.run, null, doc.entries);
    const forced = events.findIndex((e) => e.k === 'step' && e.forced !== undefined);
    expect(forced).toBeGreaterThanOrEqual(0);
    const f = frames[forced + 1]!.marks.forced!;
    const e = events[forced]! as Extract<(typeof events)[number], { k: 'step' }>;
    expect([f.who, f.path[0], f.path[f.path.length - 1], f.how]).toEqual([e.who, e.from, e.to, e.forced]);
    const ts = events.findIndex((x) => x.k === 'turnStart');
    const t = events[ts]! as Extract<(typeof events)[number], { k: 'turnStart' }>;
    expect(frames[ts + 1]!.marks.trail).toEqual([t.cell]);
    const dmg = events.findIndex((x) => x.k === 'damage');
    const d = events[dmg]! as Extract<(typeof events)[number], { k: 'damage' }>;
    expect(frames[dmg + 1]!.marks.delta).toEqual({ tgt: d.tgt, hp: d.hpAfter - d.hpBefore });
    if (dmg + 2 < frames.length && events[dmg + 1]!.k !== 'damage' && events[dmg + 1]!.k !== 'heal') expect(frames[dmg + 2]!.marks.delta).toBeNull();
    const atk = events.findIndex((x) => x.k === 'attack');
    if (atk >= 0) {
      expect(frames[atk + 1]!.marks.strike).not.toBeNull();
      const next = events.findIndex((x, i) => i > atk && x.k === 'decided');
      if (next > atk) expect(frames[next + 1]!.marks.strike).toBeNull();
    }
  });
});
