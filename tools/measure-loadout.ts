// Coverage 8'b G7 (docs/design/coverage.md section 2): the measurement behind Weights loadoutSwitch,
// measured once and then frozen. Reruns the bench's dummy-melee, duel and party setups for all 12
// classes at L3 and L5 under each switch cost and prints item decisions per fight, the watched PC's
// Dodge share and wins, plus the Barbarian's dummy DPR in rounds 2-5 (Greataxe against Handaxes).
//
//   MONTECRIT_HOME=$(mktemp -d) node tools/measure-loadout.ts [--n 30]
//
// Tooling only: it overrides DEFAULT_WEIGHTS in this process and reads only the repo's packs.
import { parseArgs } from 'node:util';
import { DEFAULT_WEIGHTS } from '../packages/engine/src/decide/greedy/weights.ts';
import { ALL_CLASSES, benchWorld, runTask } from './bench-core.ts';

const { values } = parseArgs({ options: { n: { type: 'string', default: '30' } } });
const N = Number(values.n);
const world = benchWorld(new URL('..', import.meta.url).pathname);

for (const loadoutSwitch of [0, 0.25, 0.5, 0.75, 1, 1.5, 2, 3]) {
  Object.assign(DEFAULT_WEIGHTS, { loadoutSwitch });
  const cells: string[] = [];
  for (const bench of ['dummy-melee', 'duel', 'party'] as const) {
    let turns = 0, dodges = 0, items = 0, wins = 0, fights = 0;
    for (const level of [3, 5]) {
      for (const cls of ALL_CLASSES) {
        const r = runTask(world, { bench, cls, level, arm: 'base', from: 0, to: N });
        if (r.error) throw new Error(r.error);
        for (const x of r.rows) {
          fights++;
          turns += x.turnsUp;
          dodges += x.dodges;
          items += x.items;
          if (x.outcome === 'win') wins++;
        }
      }
    }
    cells.push(`${bench} items ${(items / fights).toFixed(2)} Dodge ${((100 * dodges) / turns).toFixed(1)}% win ${((100 * wins) / fights).toFixed(1)}%`);
  }
  const dpr = [1, 3, 5].map((level) => {
    const r = runTask(world, { bench: 'dummy-melee', cls: 'barbarian', level, arm: 'base', from: 0, to: 4 * N });
    if (r.error) throw new Error(r.error);
    let d = 0;
    for (const x of r.rows) d += x.dummyDmg2to5;
    return `L${level} ${(d / r.rows.length / 4).toFixed(2)}`;
  });
  console.log(`switch ${String(loadoutSwitch).padEnd(4)} ${cells.join(' | ')} | Barbarian DPR ${dpr.join(' ')}`);
}
