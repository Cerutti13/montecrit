// M13 g (docs/design/coverage.md, 8'b build note): the party-bench groups tried at the end of 8'.
// Each candidate replaces PARTY_GROUP[level] in this process only and plays the party bench for all
// 12 classes with the bench's seed; the reference is the median class win%, the band 50-80% (section
// 6). Tooling, not a golden; it never writes PARTY_GROUP, whose sizing Shane signs off.
//
//   MONTECRIT_HOME=$(mktemp -d) node tools/measure-party-size.ts [--n 200] [--level 1,3,10] [--procs 6]

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { PICK_CLASSES } from './class-picks.ts';
import { benchWorld, crOf, PARTY_GROUP, runTask } from './bench-core.ts';

const run = promisify(execFile);

const CANDIDATES: Readonly<Record<number, readonly (readonly string[])[]>> = {
  1: [['goblin-boss', 'goblin-warrior', 'goblin-warrior']],
  3: [
    ['knight', 'goblin-boss'],
    // At exactly the 900 XP moderate budget, more bodies (integration-1): the choice isn't only knight + boss.
    ['goblin-boss', 'goblin-boss', 'goblin-boss', 'goblin-boss', 'tough'],
    ['goblin-boss', 'goblin-boss', 'goblin-boss', 'tough', 'tough', 'tough'],
    ['warrior-veteran', 'goblin-boss'],
    ['knight', 'goblin-boss', 'tough'],
    ['knight', 'goblin-boss', 'goblin-boss'],
    ['knight', 'goblin-boss', 'goblin-boss', 'goblin-warrior'],
    ['knight', 'goblin-boss', 'tough', 'tough'],
    ['knight', 'goblin-boss', 'goblin-boss', 'tough'],
    ['knight', 'goblin-boss', 'goblin-boss', 'goblin-boss'],
    ['knight', 'knight'],
    ['warrior-veteran', 'knight'],
    ['knight', 'knight', 'goblin-boss'],
  ],
  10: [
    ['gladiator', 'gladiator', 'gladiator', 'gladiator', 'gladiator', 'goblin-boss'],
    ['gladiator', 'gladiator', 'gladiator', 'gladiator', 'knight', 'knight'],
  ],
};

const { values } = parseArgs({ options: { n: { type: 'string', default: '200' }, level: { type: 'string', default: '1,3,10' }, one: { type: 'string' }, procs: { type: 'string', default: '6' } }, strict: true });
const n = Number(values.n);

/** One candidate in this process ('LEVEL:a,b,c'): bench-core caches a setup per class and level, so one group per process. */
function measureOne(one: string): void {
  const [lv, names] = one.split(':') as [string, string];
  const level = Number(lv);
  const short = names.split(',');
  const group = short.map((m) => `srd:${m}`);
  (PARTY_GROUP as Record<number, readonly string[]>)[level] = group;
  const world = benchWorld(join(import.meta.dirname, '..'));
  const wins: number[] = [];
  let w = 0;
  let l = 0;
  let s = 0;
  for (const cls of PICK_CLASSES) {
    const r = runTask(world, { bench: 'party', cls, level, arm: 'base', from: 0, to: n });
    if (r.error) throw new Error(`${cls} ${level}: ${r.error}`);
    const won = r.rows.filter((f) => f.outcome === 'win').length;
    wins.push((100 * won) / n);
    w += won;
    l += r.rows.filter((f) => f.outcome === 'loss').length;
    s += r.rows.filter((f) => f.outcome === 'stalemate').length;
  }
  const sorted = [...wins].sort((a, b) => a - b);
  const xp = group.reduce((a, m) => a + crOf(world, m).xp, 0);
  const all = w + l + s;
  console.log(`L${level} ${short.join(' + ')} = ${xp} XP: median win ${((sorted[5]! + sorted[6]!) / 2).toFixed(1)}%, class range ${sorted[0]!.toFixed(0)}-${sorted[11]!.toFixed(0)}%; W/L/S ${((100 * w) / all).toFixed(1)}/${((100 * l) / all).toFixed(1)}/${((100 * s) / all).toFixed(1)}%`);
}

if (values.one) measureOne(values.one);
else {
  const queue = values.level.split(',').flatMap((lv) => (CANDIDATES[Number(lv)] ?? []).map((g) => `${lv}:${g.join(',')}`));
  const results = new Map<string, string>();
  const order = [...queue];
  const worker = async (): Promise<void> => {
    for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
      const { stdout } = await run(process.execPath, [import.meta.filename, '--n', String(n), '--one', job], { maxBuffer: 1 << 20 });
      results.set(job, stdout.trim());
    }
  };
  await Promise.all(Array.from({ length: Number(values.procs) }, worker));
  for (const job of order) console.log(results.get(job));
}
