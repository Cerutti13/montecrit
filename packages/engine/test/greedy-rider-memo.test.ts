// G8, the rider-token cache (docs/design/coverage.md, the G8 row and build step C0): greedy keeps a
// rider's valuation per (rider effect, target, decision) in cond.ts RiderMemo (Slow's stats
// figures, Sap's and Vex's one-roll tokens). It is perf only, so with the memo on or switched off
// every fight's log and state hash are identical. The fights: every golden from its journal (its
// unscripted seats are greedy), stars-ambush with test:sample-fighter-masteries in pc1 (Sap, Vex, Slow, Topple, the
// Light attack and Nick), monk-ambush (riders that aren't tokens) and stars-ambush itself. A
// poisoned memo (every stored value nudged) must change some fight, so the equality isn't vacuous.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../src/content/load.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import type { Decider } from '../src/decide/decider.ts';
import type { ChangeFigures, RiderMemo } from '../src/decide/greedy/cond.ts';
import { GreedyDecider } from '../src/decide/greedy/greedy.ts';
import { makeDeciders } from '../src/decide/make.ts';
import { HashSink } from '../src/log/events.ts';
import type { JournalEntry } from '../src/replay.ts';
import { extendScenario } from '../src/scenario/extend.ts';
import { resolveScenario } from '../src/scenario/resolve.ts';
import { runFight } from '../src/sim/fight.ts';
import type { FightSetup } from '../src/sim/setup.ts';
import { loadScenario } from './helpers/scenario.ts';

const SLOW = !!process.env.MONTECRIT_SLOW;
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

/** stars-ambush with `id` in seat pc1 (as monk-ambush.yaml seats the Monk). */
function seated(id: string): FightSetup {
  const base = parse(readFileSync(join(ROOT, 'scenarios', 'stars-ambush.yaml'), 'utf8')) as unknown;
  const merged = extendScenario({ kind: 'scenario', id: 'g8-check', name: 'G8 check', extends: 'stars-ambush', override: { units: { pc1: { use: id } } } }, base);
  if (merged.value === null) throw new Error(merged.errors.join('\n'));
  const res = resolveScenario(merged.value, 'g8-check.yaml', CONTENT);
  if (!res.setup) throw new Error(res.errors.map(formatDiag).join('\n'));
  return res.setup;
}

/** An array whose push stores nothing: the memo then never hits (the uncached path everywhere). */
function inert<T>(): T[] {
  const a: T[] = [];
  a.push = () => 0;
  return a;
}

const OFF = (): RiderMemo => ({ kind: inert(), te: inert(), bearer: inert(), me: inert(), meIdx: inert(), val: inert(), figs: inert(), bUnit: inert(), bIn: inert(), bOut: inert() });

/** A memo that stores every value and figure slightly wrong: a hit then returns what the uncached call would not. */
function poisoned(): RiderMemo {
  const val: number[] = [];
  val.push = (...xs: number[]) => Array.prototype.push.apply(val, xs.map((x) => (x === x ? x + 0.75 : x)));
  const figs: (ChangeFigures | null)[] = [];
  figs.push = (...xs: (ChangeFigures | null)[]) => Array.prototype.push.apply(figs, xs.map((f) => (f ? { ...f, inA: f.inA + 2, outA: f.outA - 2 } : f)));
  const bIn: number[] = [];
  bIn.push = (...xs: number[]) => Array.prototype.push.apply(bIn, xs.map((x) => x + 2));
  return { kind: [], te: [], bearer: [], me: [], meIdx: [], val, figs, bUnit: [], bIn, bOut: [] };
}

/** Every greedy decider in `ds` (a policy wraps one as `base`). */
function greedies(ds: readonly Decider[]): GreedyDecider[] {
  const out: GreedyDecider[] = [];
  for (const d of ds) {
    if (d instanceof GreedyDecider) out.push(d);
    else {
      const b = (d as { base?: unknown }).base;
      if (b instanceof GreedyDecider) out.push(b);
    }
  }
  return out;
}

type Memo = 'on' | 'off' | 'poisoned';

/** A fight's log hash and state hash, plus how many memo entries the deciders stored (on only). */
function fight(setup: FightSetup, seed: number, run: number, memo: Memo, journal: readonly JournalEntry[] = []): { log: string; state: string; stored: number } {
  const ds = makeDeciders(setup, journal);
  const gs = greedies(ds);
  const memos: RiderMemo[] = [];
  for (const g of gs) {
    if (memo === 'on') memos.push((g as unknown as { riderMemo: RiderMemo }).riderMemo);
    else (g as unknown as { riderMemo: RiderMemo }).riderMemo = memo === 'off' ? OFF() : poisoned();
  }
  // Count what the real memo stores (its kind array's push still stores).
  let stored = 0;
  for (const m of memos) {
    const push = m.kind.push.bind(m.kind);
    m.kind.push = (...xs: number[]) => {
      stored += xs.length;
      return push(...xs);
    };
  }
  const sink = new HashSink();
  const r = runFight(setup, seed, run, ds, sink, { journal });
  return { log: sink.hex(), state: r.stateHash, stored };
}

const CASES: { name: string; setup: () => FightSetup; seed: number; runs: number }[] = [
  { name: 'stars-ambush with test:sample-fighter-masteries', setup: () => seated('test:sample-fighter-masteries'), seed: 42, runs: SLOW ? 200 : 6 },
  { name: 'stars-ambush with test:sample-fighter-built (Sap, Vex)', setup: () => seated('test:sample-fighter-built'), seed: 42, runs: SLOW ? 200 : 3 },
  { name: 'monk-ambush', setup: () => loadScenario('scenarios/monk-ambush.yaml', CONTENT), seed: 42, runs: SLOW ? 100 : 3 },
  { name: 'stars-ambush', setup: () => loadScenario('scenarios/stars-ambush.yaml', CONTENT), seed: 42, runs: SLOW ? 100 : 3 },
];

describe('G8: the rider-token cache changes no decision', () => {
  it('every golden, replayed from its journal, gives the same log and state hash with the memo on or off', () => {
    const golden = join(ROOT, 'scenarios', 'golden');
    const files = readdirSync(golden).filter((f) => f.endsWith('.journal.yaml')).sort();
    expect(files.length).toBeGreaterThanOrEqual(10);
    for (const f of files) {
      const doc = parse(readFileSync(join(golden, f), 'utf8')) as { seed: number; run: number; entries: JournalEntry[] };
      const setup = loadScenario(join('scenarios', 'golden', f.replace('.journal.yaml', '.yaml')), CONTENT);
      const on = fight(setup, doc.seed, doc.run, 'on', doc.entries);
      const off = fight(setup, doc.seed, doc.run, 'off', doc.entries);
      expect([on.log, on.state], f).toEqual([off.log, off.state]);
    }
  }, 60_000);

  for (const c of CASES) {
    it(`${c.name}: every fight's log and state hash are equal with the memo on or off`, () => {
      const setup = c.setup();
      let stored = 0;
      for (let run = 0; run < c.runs; run++) {
        const on = fight(setup, c.seed, run, 'on');
        const off = fight(setup, c.seed, run, 'off');
        expect(on.log, `run ${run}`).toBe(off.log);
        expect(on.state, `run ${run}`).toBe(off.state);
        stored += on.stored;
      }
      // The mastery Fighters' riders go through the memo (it is in use, so the equality checks something).
      if (c.name.includes('fighter')) expect(stored).toBeGreaterThan(0);
    }, 60_000);
  }

  it('a poisoned memo (stored values nudged) changes a masteries fight: the equality above has teeth', () => {
    const setup = seated('test:sample-fighter-masteries');
    let first = -1;
    for (let run = 0; run < 12 && first < 0; run++) if (fight(setup, 42, run, 'poisoned').log !== fight(setup, 42, run, 'off').log) first = run;
    expect(first).toBeGreaterThanOrEqual(0);
  }, 60_000);
});
