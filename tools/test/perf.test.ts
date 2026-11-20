// tools/perf.ts (coverage.md M9): the monk-ambush case (budget 70 alone), the martial
// fighter-masteries case (G8's rider valuations) and barbarian-5 (perf/barbarian-5) exist and run.
// Speed itself is local only; this checks the cases resolve and print a line. HOME and
// MONTECRIT_HOME are fresh temp dirs: perf.ts reads ~/.montecrit/perf.jsonl for its deltas, and the
// CLI home loader would read ~/.montecrit.
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');

function perf(name: string): string {
  const env = { ...process.env, HOME: mkdtempSync(join(tmpdir(), 'perf-home-')), MONTECRIT_HOME: mkdtempSync(join(tmpdir(), 'perf-dnd-')) };
  return execFileSync(process.execPath, ['tools/perf.ts', '--case', name, '--n', '1', '--no-record'], { cwd: ROOT, env, encoding: 'utf8' });
}

describe('tools/perf.ts cases', () => {
  it('monk-ambush is a perf case and runs (M9)', () => {
    expect(perf('monk-ambush')).toMatch(/^monk-ambush\s+\d+ fights\/s\s+[\d.]+ us\/decision/m);
  }, 60_000);

  it('fighter-masteries seats test:sample-fighter-masteries in pc1 and runs (G8)', () => {
    expect(perf('fighter-masteries')).toMatch(/^fighter-masteries\s+\d+ fights\/s/m);
  }, 60_000);

  it('barbarian-5 seats test:sample-barbarian in pc1 and runs (coverage.md perf/barbarian-5)', () => {
    expect(perf('barbarian-5')).toMatch(/^barbarian-5\s+\d+ fights\/s\s+[\d.]+ us\/decision/m);
  }, 60_000);
});
