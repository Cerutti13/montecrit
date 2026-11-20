// Coverage 8'b, M9 fallback (2): the measurement behind greedy.ts APPROACH_TOP_K. Every greedy seat
// plays at k against every destination scored (identical log hashes; ms per fight): the bench's
// dummy-range and party setups for all 12 classes at L3 and L5, then the perf cases. Public content only.
//
//   MONTECRIT_HOME=$(mktemp -d) node tools/measure-approach-k.ts [--n 20] [--cases-n 200]

import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { readScenarioInput } from '../apps/cli/src/files.ts';
import { loadKnown } from '../apps/cli/src/home.ts';
import { GreedyDecider } from '../packages/engine/src/decide/greedy/greedy.ts';
import { makeDeciders, resolveScenario, runFight, type Decider, type FightSetup } from '../packages/engine/src/index.ts';
import { HashSink } from '../packages/engine/src/log/events.ts';
import { ALL_CLASSES, BENCH_SEED, benchSetup, benchWorld, PassDecider } from './bench-core.ts';

const ROOT = join(import.meta.dirname, '..');
const KS = [0, 1, 2, 4, 8, 16, 32];

interface Fight {
  setup: FightSetup;
  seed: number;
  run: number;
}

function play(f: Fight, k: number, sink: HashSink | null): void {
  const ds: Decider[] = makeDeciders(f.setup);
  const dummy = f.setup.seats.findIndex((x) => x.seat === 'dummy');
  if (dummy >= 0) ds[dummy] = new PassDecider();
  for (const d of ds) if (d instanceof GreedyDecider) d.approachTopK = k;
  runFight(f.setup, f.seed, f.run, ds, sink);
}

function report(name: string, fights: readonly Fight[]): void {
  const hash = (f: Fight, k: number) => {
    const h = new HashSink();
    play(f, k, h);
    return h.hex();
  };
  const all = fights.map((f) => hash(f, Infinity));
  for (const k of KS) {
    const same = fights.filter((f, i) => hash(f, k) === all[i]).length;
    const t0 = performance.now();
    for (const f of fights) play(f, k, null);
    console.log(`${name} k=${k}: ${same}/${fights.length} identical, ${((performance.now() - t0) / fights.length).toFixed(2)} ms/fight`);
  }
}

const { values } = parseArgs({ options: { n: { type: 'string' }, 'cases-n': { type: 'string' } } });
const n = Number(values.n ?? 20);
const casesN = Number(values['cases-n'] ?? 200);
const world = benchWorld(ROOT);
const bench: Fight[] = [];
for (const cls of ALL_CLASSES) {
  for (const level of [3, 5]) {
    for (const b of ['dummy-range', 'party'] as const) {
      const setup = benchSetup(world, b, cls, level);
      for (let run = 0; run < n; run++) bench.push({ setup, seed: BENCH_SEED[b], run });
    }
  }
}
report('bench', bench);
const loaded = loadKnown(process.env);
if (!loaded.content) throw new Error('content did not load');
for (const f of ['scenarios/stars-ambush.yaml', 'scenarios/monk-ambush.yaml', 'scenarios/perf/ambush-probe.yaml']) {
  const path = join(ROOT, f);
  const setup = resolveScenario(readScenarioInput(path).input, path, loaded.content).setup;
  if (!setup) throw new Error(f);
  report(f, Array.from({ length: casesN }, (_, run) => ({ setup, seed: 42, run })));
}
