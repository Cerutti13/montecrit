// M9 fallback (1) (docs/design/coverage.md, Critique resolutions M9; coverage step 8'a): greedy
// memoizes cover per decision, strikes by (attacker, target, from square) with the target's square
// checked, threats against the decider by (foe, its square), generation-stamped in greedy.ts
// coverOf/coverVsMe. It is perf only, so with the memo on or switched off (every call goes straight
// to sim/cover.ts coverAgainst/coverAt, as before the memo) every fight's log and state hash are
// identical. The fights: every golden from its journal, stars-ambush (creature cover, no walls),
// monk-ambush, and cover-archer unscripted (walls, '+' cover, Total Cover). A poisoned memo (every
// stored degree raised one step) must change some fight, so the equality isn't vacuous.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../src/content/load.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import type { Decider } from '../src/decide/decider.ts';
import { GreedyDecider } from '../src/decide/greedy/greedy.ts';
import { makeDeciders } from '../src/decide/make.ts';
import { HashSink } from '../src/log/events.ts';
import type { JournalEntry } from '../src/replay.ts';
import { coverAgainst, coverAt } from '../src/sim/cover.ts';
import { runFight } from '../src/sim/fight.ts';
import type { FightSetup } from '../src/sim/setup.ts';
import type { QueryState, Unit } from '../src/sim/state.ts';
import { loadScenario } from './helpers/scenario.ts';
import { ARCHER, BRUTE, setup as buildSetup } from './helpers/build.ts';

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
interface CoverMemoInternals {
  los: 0 | 1 | 2;
  meIdx: number;
  coverOf(st: QueryState, a: Unit, from: number, t: Unit): number;
  coverVsMe(st: QueryState, u: Unit, cell: number): number;
}

/** Replaces the memoized lookups on `g`: off = the uncached calls; poisoned = the memo's answers one degree too high. */
function patch(g: GreedyDecider, memo: Memo, hits: { n: number }): void {
  const x = g as unknown as CoverMemoInternals;
  if (memo === 'on') {
    const of = x.coverOf.bind(x);
    const vs = x.coverVsMe.bind(x);
    // Count lookups so the test shows the memo is on a live path.
    x.coverOf = (st, a, from, t) => (hits.n++, of(st, a, from, t));
    x.coverVsMe = (st, u, cell) => (hits.n++, vs(st, u, cell));
    return;
  }
  if (memo === 'off') {
    x.coverOf = (st, a, from, t) => (x.los === 0 ? 0 : coverAgainst(st, a, from, t, null));
    x.coverVsMe = (st, u, cell) => coverAt(st, u, u.cell, cell, st.units[x.meIdx] ?? null, null);
    return;
  }
  const of = x.coverOf.bind(x);
  const vs = x.coverVsMe.bind(x);
  x.coverOf = (st, a, from, t) => Math.min(3, of(st, a, from, t) + 1);
  x.coverVsMe = (st, u, cell) => Math.min(3, vs(st, u, cell) + 1);
}

function fight(setup: FightSetup, seed: number, run: number, memo: Memo, journal: readonly JournalEntry[] = []): { log: string; state: string; hits: number } {
  const ds = makeDeciders(setup, journal);
  const hits = { n: 0 };
  for (const g of greedies(ds)) patch(g, memo, hits);
  const sink = new HashSink();
  const r = runFight(setup, seed, run, ds, sink, { journal });
  return { log: sink.hex(), state: r.stateHash, hits: hits.n };
}

const CASES: { name: string; setup: () => FightSetup; seed: number; runs: number }[] = [
  { name: 'stars-ambush (creature cover, no walls)', setup: () => loadScenario('scenarios/stars-ambush.yaml', CONTENT), seed: 42, runs: SLOW ? 100 : 4 },
  { name: 'monk-ambush', setup: () => loadScenario('scenarios/monk-ambush.yaml', CONTENT), seed: 42, runs: SLOW ? 50 : 2 },
  { name: 'cover-archer unscripted (walls, Half Cover cell, Total Cover)', setup: () => loadScenario('scenarios/golden/cover-archer.yaml', CONTENT), seed: 3, runs: SLOW ? 200 : 20 },
];

describe('M9 fallback (1): greedy\'s per-decision cover memo changes no decision', () => {
  it('every golden, replayed from its journal, gives the same log and state hash with the memo on or off', () => {
    const golden = join(ROOT, 'scenarios', 'golden');
    const files = readdirSync(golden).filter((f) => f.endsWith('.journal.yaml')).sort();
    expect(files).toContain('cover-archer.journal.yaml');
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
      let hits = 0;
      for (let run = 0; run < c.runs; run++) {
        const on = fight(setup, c.seed, run, 'on');
        const off = fight(setup, c.seed, run, 'off');
        expect(on.log, `run ${run}`).toBe(off.log);
        expect(on.state, `run ${run}`).toBe(off.state);
        hits += on.hits;
      }
      expect(hits).toBeGreaterThan(0);
    }, 120_000);
  }

  it('a poisoned memo (every degree one step too high) changes some fight, so the equality bites', () => {
    const setup = loadScenario('scenarios/golden/cover-archer.yaml', CONTENT);
    let changed = 0;
    for (let run = 0; run < 10; run++) if (fight(setup, 3, run, 'poisoned').log !== fight(setup, 3, run, 'off').log) changed++;
    expect(changed).toBeGreaterThan(0);
  }, 60_000);
});

describe('8\'a review G2: the cover memo is sized to the decision, not to units x units x cells', () => {
  it('20 greedy units on a 30 x 30 map: no decider\'s memo comes near the 3.2 MB a units^2 x cells table needs', () => {
    const units = Array.from({ length: 20 }, (_, i) => ({
      seat: `u${i}`, team: (i % 2) as 0 | 1, tpl: i % 4 < 2 ? ARCHER : BRUTE, decider: 'greedy' as const,
      at: `${String.fromCharCode(65 + ((i * 7) % 26))}${1 + ((i * 11) % 30)}`,
    }));
    const s = buildSetup({ w: 30, h: 30, units });
    const ds = makeDeciders(s);
    runFight(s, 7, 0, ds, null);
    const gs = greedies(ds);
    expect(gs.length).toBe(20);
    const table = 20 * 20 * 900 * 9;
    const most = Math.max(...gs.map((g) => g.coverMemoBytes()));
    expect(most).toBeGreaterThan(0);
    expect(most).toBeLessThan(table / 8);
  }, 60_000);
});
