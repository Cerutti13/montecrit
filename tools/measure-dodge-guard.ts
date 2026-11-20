// Coverage 8'b G4 (docs/design/coverage.md section 2, M7): the measurement behind Weights
// dodgeStaleAfter and dodgeDecay, measured once and then frozen, and G3's progress weight beside
// it. Reruns the bench's duel and party setups for all 12 classes at L3 and L5 under each setting
// and prints the watched PC's Dodge share, wins, and stalemates by cause, totalled.
//
//   MONTECRIT_HOME=$(mktemp -d) node tools/measure-dodge-guard.ts [--n 30]
//
// Tooling only: it overrides DEFAULT_WEIGHTS in this process and reads only the repo's packs.
import { parseArgs } from 'node:util';
import { DEFAULT_WEIGHTS } from '../packages/engine/src/decide/greedy/weights.ts';
import { ALL_CLASSES, benchWorld, runTask } from './bench-core.ts';
import { BENCH_CAUSES } from './bench-trace.ts';

const { values } = parseArgs({ options: { n: { type: 'string', default: '30' } } });
const N = Number(values.n);
const world = benchWorld(new URL('..', import.meta.url).pathname);
const set = (o: Record<string, unknown>): void => void Object.assign(DEFAULT_WEIGHTS, o);
const pc = DEFAULT_WEIGHTS.pc;

function measure(label: string): void {
  for (const bench of ['duel', 'party'] as const) {
    let turns = 0, dodges = 0, wins = 0, stale = 0, fights = 0;
    const cause: Record<string, number> = {};
    for (const level of [3, 5]) {
      for (const cls of ALL_CLASSES) {
        const r = runTask(world, { bench, cls, level, arm: 'base', from: 0, to: N });
        if (r.error) throw new Error(r.error);
        for (const x of r.rows) {
          fights++;
          turns += x.turnsUp;
          dodges += x.dodges;
          if (x.outcome === 'win') wins++;
          if (x.outcome === 'stalemate') stale++;
          if (x.cause) cause[x.cause] = (cause[x.cause] ?? 0) + 1;
        }
      }
    }
    const causes = BENCH_CAUSES.map((c) => `${c} ${cause[c] ?? 0}`).join(', ');
    console.log(`${label.padEnd(26)} ${bench.padEnd(6)} Dodge ${((100 * dodges) / turns).toFixed(1).padStart(5)}%  win ${((100 * wins) / fights).toFixed(1).padStart(5)}%  stalemate ${((100 * stale) / fights).toFixed(1).padStart(5)}%  ${causes}`);
  }
}

set({ dodgeStaleAfter: 1e9, dodgeDecay: 1 });
measure('no guard');
for (const after of [1, 2, 3]) {
  for (const decay of [0.25, 0.5, 0.75]) {
    set({ dodgeStaleAfter: after, dodgeDecay: decay });
    measure(`guard N ${after}, decay ${decay}`);
  }
}
set({ dodgeStaleAfter: 2, dodgeDecay: 0.5 });
for (const progress of [0, 0.5, 1, 2]) {
  set({ pc: { ...pc, progress } });
  measure(`progress ${progress}`);
}
