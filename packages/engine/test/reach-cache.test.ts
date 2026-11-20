// The pathfinding signature cache (docs/design/m1c.md 3.1, resolution 4): with it on or off,
// every fight offers byte-identical legal lists and logs. Over every golden with its journal;
// random-legal fights on the 10-unit perf probe (with walls added) under every value of the
// movement flags (diagonalCost, diagonalCorner, corpseSpace); random-legal fights on the precast
// variant of stars-ambush (a hazard zone up from the start, which only some seats saw cast) under
// every zoneKnowledge value, the pass that exercises the zone-knowledge part of the signature;
// and greedy fights on stars-ambush and its precast variant under the same flags. MONTECRIT_SLOW=1
// runs more fights.
// What these can catch: the cache hits only between listing a unit's options and resolving its
// chosen move, with nothing changed in between. Mutation testing (milestone review, 2026-11-02)
// showed dropping the units' cells from the signature is caught (the probe test), while dropping
// the zone bits or the known-zones mask is not: zones can't change inside that window, so those
// fields are safeguards for a wider hit pattern, and no fight here can tell them apart.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../src/content/load.ts';
import { parse } from 'yaml';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import type { Decider, DecisionPoint, UnitView } from '../src/decide/decider.ts';
import { makeDeciders } from '../src/decide/make.ts';
import { RandomLegalDecider } from '../src/decide/random-legal.ts';
import { parseCell, TERR } from '../src/grid/cells.ts';
import { computeReach, forEachLabel } from '../src/grid/reach.ts';
import { HashSink } from '../src/log/events.ts';
import type { JournalEntry } from '../src/replay.ts';
import type { RuleFlags } from '../src/rules/flags.ts';
import { resolveScenario } from '../src/scenario/resolve.ts';
import { newScratch } from '../src/sim/context.ts';
import { createContext, runFight } from '../src/sim/fight.ts';
import type { FightSetup } from '../src/sim/setup.ts';
import { SENTRY, setup, SKIRMISHER } from './helpers/build.ts';
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

const scenario = (file: string): FightSetup => loadScenario(file, CONTENT);

/** Records every decision's full legal list, then lets `inner` choose. */
class ListLog implements Decider {
  readonly name: string;
  readonly inner: Decider;
  readonly log: string[];
  constructor(inner: Decider, log: string[]) {
    this.inner = inner;
    this.name = inner.name;
    this.log = log;
  }
  decide(view: UnitView, dp: DecisionPoint): number {
    const keys: string[] = [];
    for (let i = 0; i < dp.legal.n; i++) keys.push(dp.keyOf(i));
    this.log.push(`${dp.at} ${dp.k} ${keys.join(' ')}`);
    return this.inner.decide(view, dp);
  }
}

function both(setup: FightSetup, run: number, deciders: () => Decider[], seed = 1, journal: readonly JournalEntry[] = []) {
  const one = (cache: boolean) => {
    const log: string[] = [];
    const sink = new HashSink();
    const r = runFight(setup, seed, run, deciders().map((d) => new ListLog(d, log)), sink, { scratch: newScratch(setup.w * setup.h, { reachCache: cache }), journal });
    return { log, hash: sink.hex(), state: r.stateHash };
  };
  return [one(true), one(false)] as const;
}

describe('the pathfinding cache changes nothing', () => {
  it('every golden, replayed from its journal, gives the same lists and log hash with the cache on or off', () => {
    const golden = join(ROOT, 'scenarios', 'golden');
    const files = readdirSync(golden).filter((f) => f.endsWith('.journal.yaml'));
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const f of files) {
      const doc = parse(readFileSync(join(golden, f), 'utf8')) as { seed: number; run: number; entries: JournalEntry[] };
      const setup = scenario(join('scenarios', 'golden', f.replace('.journal.yaml', '.yaml')));
      const [on, off] = both(setup, doc.run, () => makeDeciders(setup, doc.entries), doc.seed, doc.entries);
      expect(on.log, f).toEqual(off.log);
      expect([on.hash, on.state], f).toEqual([off.hash, off.state]);
    }
  });

  it('a reactor spending its Reaction changes what a move provokes, even with nothing else changed', () => {
    const s = setup({ w: 6, h: 3, units: [{ seat: 'gob', team: 1, tpl: SKIRMISHER, at: 'B2' }, { seat: 'guard', team: 0, tpl: SENTRY, at: 'C2' }] });
    const cx = createContext(s, 1, 0, makeDeciders(s), null);
    const gob = cx.st.units.find((x) => x.seat === 'gob')!;
    const provokesTo = (cell: string) => {
      computeReach(cx.st, gob, 30, cx.sc.reachEngine);
      const out: number[] = [];
      forEachLabel(cx.st, gob, cx.sc.reachEngine, 30, (c, _ft, p) => {
        if (c === parseCell(cell, s.w, s.h)) out.push(p);
      });
      return out;
    };
    expect(provokesTo('A2')).toEqual([1]); // leaves the guard's reach
    cx.st.units.find((x) => x.seat === 'guard')!.b.reaction = 0;
    expect(provokesTo('A2')).toEqual([0]);
    expect(cx.sc.reachEngine.hits).toBe(0);
  });

  it('random-legal fights on the 10-unit probe, with walls, under every value of every flag pathfinding reads', () => {
    const base = scenario('scenarios/perf/ambush-probe.yaml');
    const terrain = base.terrain.slice();
    for (const c of ['E8', 'F8', 'H8', 'C5', 'J6', 'E3']) terrain[parseCell(c, base.w, base.h)] = TERR.wall;
    const runs = SLOW ? 25 : 3;
    let decisions = 0;
    for (const diagonalCost of ['uniform', 'alternate'] as const) {
      for (const diagonalCorner of ['eitherBlocks', 'bothBlock'] as const) {
        for (const corpseSpace of ['clear', 'difficult'] as const) {
          const flags: RuleFlags = { ...base.flags, diagonalCost, diagonalCorner, corpseSpace };
          const setup: FightSetup = { ...base, terrain, flags };
          for (let run = 0; run < runs; run++) {
            const [on, off] = both(setup, run, () => setup.seats.map(() => new RandomLegalDecider()));
            expect(on.log).toEqual(off.log);
            expect([on.hash, on.state]).toEqual([off.hash, off.state]);
            decisions += on.log.length;
          }
        }
      }
    }
    expect(decisions).toBeGreaterThan(500); // the fights really ran
  }, SLOW ? 600_000 : 30_000);

  it('random-legal fights with a hazard zone up from the start, under every zoneKnowledge value and both diagonal costs', () => {
    const base = scenario('scenarios/stars-ambush-precast.yaml');
    const runs = SLOW ? 25 : 4;
    let decisions = 0;
    for (const zoneKnowledge of ['sawCast', 'all', 'none'] as const) {
      for (const diagonalCost of ['uniform', 'alternate'] as const) {
        const setup: FightSetup = { ...base, flags: { ...base.flags, zoneKnowledge, diagonalCost } };
        for (let run = 0; run < runs; run++) {
          const [on, off] = both(setup, run, () => setup.seats.map(() => new RandomLegalDecider()));
          expect(on.log, `${zoneKnowledge} ${diagonalCost} run ${run}`).toEqual(off.log);
          expect([on.hash, on.state]).toEqual([off.hash, off.state]);
          decisions += on.log.length;
        }
      }
    }
    expect(decisions).toBeGreaterThan(1000);
  }, SLOW ? 600_000 : 30_000);

  it('greedy fights on stars-ambush and its precast variant, under every zoneKnowledge value and both diagonal costs', () => {
    const runs = SLOW ? 25 : 2;
    let decisions = 0;
    for (const file of ['scenarios/stars-ambush.yaml', 'scenarios/stars-ambush-precast.yaml']) {
      const base = scenario(file);
      for (const zoneKnowledge of ['sawCast', 'all', 'none'] as const) {
        for (const diagonalCost of ['uniform', 'alternate'] as const) {
          const setup: FightSetup = { ...base, flags: { ...base.flags, zoneKnowledge, diagonalCost } };
          for (let run = 0; run < runs; run++) {
            const [on, off] = both(setup, run, () => makeDeciders(setup));
            expect(on.log, `${file} ${zoneKnowledge} ${diagonalCost} run ${run}`).toEqual(off.log);
            expect([on.hash, on.state]).toEqual([off.hash, off.state]);
            decisions += on.log.length;
          }
        }
      }
    }
    expect(decisions).toBeGreaterThan(1000);
  }, SLOW ? 600_000 : 30_000);
});
