// The report's per-flag arrays keep their old length until a step 7 flag is read, so old report
// hashes hold (docs/design/step7-plan.md section 1 item 3).
import { FLAG_KEYS, PRE_E_FLAG_COUNT, flagIndex, type ArmSpec, type ReportStats, type RunResult } from '@montecrit/engine';
import { describe, expect, it } from 'vitest';
import { accHash, reportJson } from '../src/report-json.ts';

const fake = (flagsRead: Uint8Array, aiFlags: Uint8Array, other: Uint8Array) => {
  const arms = [{ label: 'a', policy: null, setup: { scenario: 's', scenarioHash: 'h', contentHash: 'c' } }] as unknown as ArmSpec[];
  const run = { adaptive: false, checkpoint: 0, hitCap: false, merged: { n: 1, chunkSize: 1, arms: [{ flagsRead, aiFlags, other }] } } as unknown as RunResult;
  return { arms, run };
};
const parsed = (f: ReturnType<typeof fake>) => JSON.parse(reportJson(f.arms, f.run, 1, {} as ReportStats)) as { arms: { acc: { flagsRead: number[]; aiFlags: number[]; other: number[] } }[] };
const N = FLAG_KEYS.length;

describe('reportJson and accHash', () => {
  it('flagsRead and aiFlags are written at 41 entries while no step 7 flag was read; other typed arrays are untouched', () => {
    const f = fake(new Uint8Array(N), new Uint8Array(N), new Uint8Array(N));
    const { acc } = parsed(f).arms[0]!;
    expect([acc.flagsRead.length, acc.aiFlags.length, acc.other.length]).toEqual([41, 41, N]);
    const old = fake(new Uint8Array(41), new Uint8Array(41), new Uint8Array(N));
    expect(accHash(f.arms, f.run, 1)).toBe(accHash(old.arms, old.run, 1));
  });

  it('each keeps its pre-W1 length (48), on its own, once a step 7 flag was read, and its full length once a W1 flag was', () => {
    const read = new Uint8Array(N);
    read[flagIndex('selfAreaOrigin')] = 1;
    const a = parsed(fake(read, new Uint8Array(N), new Uint8Array(0))).arms[0]!.acc;
    expect([a.flagsRead.length, a.aiFlags.length]).toEqual([48, 41]);
    const ai = new Uint8Array(N);
    ai[flagIndex('emanationReach')] = 1;
    const b = parsed(fake(new Uint8Array(N), ai, new Uint8Array(0))).arms[0]!.acc;
    expect([b.flagsRead.length, b.aiFlags.length]).toEqual([41, 48]);
    const w1 = new Uint8Array(N);
    w1[flagIndex('freeMoveUsesMovement')] = 1;
    const c = parsed(fake(w1, new Uint8Array(N), new Uint8Array(0))).arms[0]!.acc;
    // Step E: a W1 read trims to the pre-E count; reading thrownWeaponLands keeps all N.
    expect([c.flagsRead.length, c.aiFlags.length]).toEqual([PRE_E_FLAG_COUNT, 41]);
    const e = new Uint8Array(N);
    e[flagIndex('thrownWeaponLands')] = 1;
    const d = parsed(fake(e, new Uint8Array(N), new Uint8Array(0))).arms[0]!.acc;
    expect([d.flagsRead.length, d.aiFlags.length]).toEqual([N, 41]);
  });
});
