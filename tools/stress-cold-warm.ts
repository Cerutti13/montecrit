// A fight's state hash cold, warm and with no sink, every bench class at L5, duel and party: 864 fights
// (coverage.md 8'b, determinism-1; run under load by tools/stress-determinism.sh). Exit 1 on a difference.
import { join } from 'node:path';
import { makeDeciders, runFight, HashSink } from '@montecrit/engine';
import { ALL_CLASSES, benchSetup, benchWorld } from './bench-core.ts';

const world = benchWorld(join(import.meta.dirname, '..'));
let bad = 0;
let n = 0;
for (const cls of ALL_CLASSES) {
  for (const bench of ['duel', 'party'] as const) {
    const setup = benchSetup(world, bench, cls, 5);
    const firsts: string[] = [];
    for (let pass = 0; pass < 3; pass++) {
      for (let run = 0; run < 12; run++) {
        const r = runFight(setup, 9, run, makeDeciders(setup), pass === 2 ? null : new HashSink());
        n++;
        if (pass === 0) firsts[run] = r.stateHash;
        else if (firsts[run] !== r.stateHash) {
          bad++;
          console.log('DIFF', cls, bench, run, pass);
        }
      }
    }
  }
}
console.log(`fights ${n}, differing ${bad}`);
process.exit(bad > 0 ? 1 : 0);
