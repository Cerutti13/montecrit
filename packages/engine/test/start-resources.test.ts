// A scenario unit's `resources`: starting spell slots and pool uses below the template's (a scene
// hands a fight over with some already spent). Absent, nothing about the fight or its hash changes.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../src/content/load.ts';
import { GreedyDecider } from '../src/decide/greedy/greedy.ts';
import { resolveScenario } from '../src/scenario/resolve.ts';
import { createContext } from '../src/sim/fight.ts';

const ROOT = join(import.meta.dirname, '../../..');
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.ya?ml$/.test(e.name) ? [join(dir, e.name)] : []));
}
const content = loadContent(['packs/srd-5.2.1', 'packs/test'].flatMap((d) => walk(join(ROOT, d))).map((p) => ({ path: p, text: readFileSync(p, 'utf8') }))).content!;

function resolve(resources?: unknown) {
  const doc = {
    kind: 'scenario', id: 'start-res', name: 'Starting resources', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: { w: 8, h: 8 },
    units: [
      { seat: 'pc1', team: 'party', use: 'test:sample-kin-druid', at: 'B2', decider: 'greedy', ...(resources === undefined ? {} : { resources }) },
      { seat: 'gob1', team: 'enemies', use: 'srd:goblin-warrior', at: 'G7', decider: 'greedy' },
    ],
  };
  return resolveScenario(doc, 'start-res.yaml', content);
}

describe('starting resources', () => {
  const plain = resolve();
  const tpl = plain.setup!.seats[1]!.tpl.id === 'test:sample-kin-druid' ? plain.setup!.seats[1]!.tpl : plain.setup!.seats.find((s) => s.seat === 'pc1')!.tpl;
  const wild = 9 + tpl.pools.findIndex((p) => p.local === 'wild-shape');

  it('absent: the seat has no override and the unit starts at the template\'s numbers', () => {
    const seat = plain.setup!.seats.find((s) => s.seat === 'pc1')!;
    expect(seat.res).toBeUndefined();
    expect(Object.keys(seat)).not.toContain('res');
    const cx = createContext(plain.setup!, 1, 0, plain.setup!.seats.map(() => new GreedyDecider()), null);
    expect([...cx.st.units.find((u) => u.seat === 'pc1')!.res]).toEqual([...tpl.resMax]);
  });

  it('slots and pools start where the scenario says; what it leaves out starts full', () => {
    const r = resolve({ slots: [1, 0], pools: { 'wild-shape': 0 } });
    expect(r.errors).toEqual([]);
    const seat = r.setup!.seats.find((s) => s.seat === 'pc1')!;
    const want = [...tpl.resMax];
    want[0] = 1;
    want[1] = 0;
    want[wild] = 0;
    expect(seat.res).toEqual(want);
    const cx = createContext(r.setup!, 1, 0, r.setup!.seats.map(() => new GreedyDecider()), null);
    expect([...cx.st.units.find((u) => u.seat === 'pc1')!.res]).toEqual(want);
    expect(r.setup!.scenarioHash).not.toBe(plain.setup!.scenarioHash);
    // The same numbers as the template's still count as an override, and hash as one.
    expect(resolve({ slots: [] }).setup!.scenarioHash).not.toBe(plain.setup!.scenarioHash);
  });

  it('a number above the maximum is capped with a warning; an unknown pool is an error', () => {
    const over = resolve({ slots: [99], pools: { 'wild-shape': 99 } });
    expect(over.setup!.seats.find((s) => s.seat === 'pc1')!.res).toEqual([...tpl.resMax]);
    expect(over.warnings.some((w) => w.message.includes('99 level 1 slots is above'))).toBe(true);
    const bad = resolve({ pools: { nope: 1 } });
    expect(bad.setup).toBeNull();
    expect(bad.errors[0]!.message).toContain('has no pool "nope"');
    expect(resolve({ slots: [-1] }).setup).toBeNull();
  });
});
