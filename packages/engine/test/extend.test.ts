// `extends` (docs/design/m1c.md 7.3): a scenario built from another by name.
import { describe, expect, it } from 'vitest';
import { extendScenario } from '../src/scenario/extend.ts';

const BASE = {
  kind: 'scenario', id: 'base', name: 'Base', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: { w: 6, h: 3 },
  flags: { initiativeMode: 'static' }, knobs: { downEnds: false, maxRounds: 5 },
  units: [
    { seat: 'pc1', team: 'party', use: 'test:sample-druid', at: 'A1', surprised: true, decider: 'journal' },
    { seat: 'gob1', team: 'enemies', use: 'srd:goblin-warrior', at: 'F3' },
  ],
};

describe('extendScenario', () => {
  it('takes the base, adds packs, merges flags and knobs, and replaces only the seat fields written', () => {
    const r = extendScenario({ kind: 'scenario', id: 'child', extends: 'base', packs: ['+shane', '+test'], flags: { diagonalCost: 'alternate' }, knobs: { maxRounds: 9 }, override: { units: { pc1: { use: 'test:sample-fighter' } } } }, BASE);
    expect(r.errors).toEqual([]);
    expect(r.value).toEqual({
      ...BASE, id: 'child',
      packs: ['srd-5.2.1', 'test', 'shane'],
      flags: { initiativeMode: 'static', diagonalCost: 'alternate' },
      knobs: { downEnds: false, maxRounds: 9 },
      // surprised and decider survive: the schema's defaults never overwrite the base
      units: [{ ...BASE.units[0], use: 'test:sample-fighter' }, BASE.units[1]],
    });
  });

  it('refuses an override for a seat the base lacks, a second level of extends, and a malformed child', () => {
    expect(extendScenario({ kind: 'scenario', id: 'c', extends: 'base', override: { units: { pc9: { at: 'B2' } } } }, BASE).errors).toEqual(['override.units.pc9: base has no seat "pc9"']);
    expect(extendScenario({ kind: 'scenario', id: 'c', extends: 'base' }, { ...BASE, extends: 'other' }).errors[0]).toMatch(/only one level/);
    expect(extendScenario({ kind: 'scenario', id: 'c', extends: 'base', packs: ['shane'] }, BASE).errors[0]).toMatch(/packs added here start with "\+"/);
    expect(extendScenario({ kind: 'scenario', id: 'c', extends: 'base', grid: { w: 1, h: 1 } }, BASE).value).toBeNull(); // the layout comes from the base
  });
});
