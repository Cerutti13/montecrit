// The replay check (docs/design/m2.md 4.3, critique resolution 2): every exemplar of a public run
// replays, with a log attached, to the fight the runner counted (same final state, same per-run
// record), and a tampered record or state hash is named by field.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../src/content/load.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import { BUILTIN_POLICIES, compilePolicy } from '../src/decide/policy.ts';
import { playOne } from '../src/log/play.ts';
import { checkReplay, PER_RUN_FIELDS, runnerRun } from '../src/mc/exemplar.ts';
import { exemplars, runArms, type ArmSpec } from '../src/mc/runner.ts';
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
const AMBUSH = loadScenario('scenarios/stars-ambush.yaml', loaded.content);
const moonbeam = compilePolicy(parse(readFileSync(join(ROOT, 'policies', 'moonbeam-first.yaml'), 'utf8'))).policy!;
const arms: ArmSpec[] = [
  { label: 'greedy', setup: AMBUSH, policy: BUILTIN_POLICIES.find((p) => p.id === 'greedy')! },
  { label: 'moonbeam-first', setup: AMBUSH, policy: moonbeam },
];
const SEED = 5;
const run = runArms(arms, SEED, { n: 120, chunkSize: 40 });

describe('checkReplay', () => {
  it('passes for every exemplar of both arms (state hash and all 9 per-run fields)', { timeout: 60_000 }, () => {
    let checked = 0;
    arms.forEach((arm, a) => {
      const acc = run.merged.arms[a]!;
      const ex = exemplars(acc);
      for (const idx of [ex.closestLoss, ex.typicalWin, ex.tpk, ex.pcDeath]) {
        if (idx < 0) continue;
        const copy = runnerRun(arm, SEED, idx);
        const f = playOne(arm.setup, SEED, idx, arm.policy);
        expect(checkReplay(acc, idx, copy.acc, copy.stateHash, f.result.stateHash)).toBeNull();
        checked++;
      }
    });
    expect(checked).toBeGreaterThanOrEqual(4);
  });

  it('names a tampered per-run field, a mismatched state hash and an out-of-range run', () => {
    const acc = run.merged.arms[0]!;
    const idx = exemplars(acc).closestLoss >= 0 ? exemplars(acc).closestLoss : 0;
    const copy = runnerRun(arms[0]!, SEED, idx);
    expect(PER_RUN_FIELDS).toHaveLength(9);
    for (const f of ['R', 'foeHpLeft', 'pcHpEnd'] as const) {
      const bad = { ...copy.acc, [f]: copy.acc[f].slice() };
      bad[f][0] = bad[f][0]! + 1;
      expect(checkReplay(acc, idx, bad, copy.stateHash, copy.stateHash)).toMatch(new RegExp(`^${f}: `));
    }
    expect(checkReplay(acc, idx, copy.acc, copy.stateHash, '0000000000000000')).toMatch(/^state hash: /);
    expect(checkReplay(acc, acc.n, copy.acc, copy.stateHash, copy.stateHash)).toMatch(/outside/);
  });
});
