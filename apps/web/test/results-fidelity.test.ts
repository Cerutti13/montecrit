// Results' fidelity line per PC seat (apps/web/src/results/fidelity.ts, m3.md 10): the same
// items the report header's notes list (mc/report.ts: fidelity not full, or anything
// unimplemented), grouped by PC seat, read from the setup the page holds.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatDiag, loadContent, type FightSetup, type SourceFile } from '@montecrit/engine';
import { loadScenario } from '../../../packages/engine/test/helpers/scenario.ts';
import { fidelityLine, fidelitySummary, seatFidelity } from '../src/results/fidelity.ts';

const tpl = (kind: 'pc' | 'monster', id: string, fidelity: 'full' | 'partial' | 'narrative', unimplemented: string[], spells: { id: string; name: string; fidelity: 'full' | 'partial' | 'narrative'; unimplemented: string[] }[] = []) => ({
  kind,
  id,
  name: id.split(':')[1]!,
  fidelity,
  unimplemented,
  spells: spells.map((spell) => ({ spell })),
});
const fake = (seats: { seat: string; tpl: ReturnType<typeof tpl> }[]) => ({ seats }) as unknown as FightSetup;

describe('seat fidelity', () => {
  it('lists PC seats only, the template then its short spells, and says when everything is full', () => {
    const s = fake([
      { seat: 'pc1', tpl: tpl('pc', 'test:a', 'partial', ['Wild Shape: narrative, not modeled'], [{ id: 'srd:x', name: 'X', fidelity: 'full', unimplemented: [] }, { id: 'srd:y', name: 'Y', fidelity: 'partial', unimplemented: ['aim'] }, { id: 'srd:y', name: 'Y', fidelity: 'partial', unimplemented: ['aim'] }]) },
      { seat: 'pc2', tpl: tpl('pc', 'test:b', 'full', []) },
      { seat: 'g1', tpl: tpl('monster', 'srd:goblin', 'partial', ['Nimble']) },
    ]);
    const f = seatFidelity(s);
    expect(f.map((x) => x.seat)).toEqual(['pc1', 'pc2']);
    expect(f[0]!.items.map((i) => i.id)).toEqual(['test:a', 'srd:y']);
    expect(fidelitySummary(f[0]!)).toBe('a partial (1 unimplemented), Y partial (1 unimplemented)');
    expect(fidelityLine(f[0]!)).toBe('a (test:a) partial: unimplemented Wild Shape: narrative, not modeled | Y (srd:y) partial: unimplemented aim');
    expect(fidelitySummary(f[1]!)).toBe('everything modeled in full');
  });
  it('a full template with unimplemented lines still counts (the report header\'s test)', () => {
    const f = seatFidelity(fake([{ seat: 'pc1', tpl: tpl('pc', 'test:c', 'full', ['Fly Speed 30 ft.']) }]));
    expect(f[0]!.items).toHaveLength(1);
  });
  it('on the sample Monk (monk-ambush), lists exactly what the report header notes for its template', () => {
    const ROOT = join(import.meta.dirname, '..', '..', '..');
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : n.endsWith('.yaml') ? [join(d, n)] : [])).sort();
    const pack = (name: string): SourceFile[] => walk(join(ROOT, 'packs', name)).map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, 'utf8') }));
    const loaded = loadContent([...pack('srd-5.2.1'), ...pack('test')]);
    if (!loaded.content) throw new Error(loaded.errors.map(formatDiag).join('\n'));
    const setup = loadScenario('scenarios/monk-ambush.yaml', loaded.content);
    const f = seatFidelity(setup);
    // The Monk lists features M3 doesn't model, so this case isn't vacuous.
    expect(f.some((x) => x.items.length > 0)).toBe(true);
    const pcs = setup.seats.filter((s) => s.tpl.kind === 'pc');
    expect(f.map((x) => x.seat)).toEqual(pcs.map((s) => s.seat));
    for (const [k, s] of pcs.entries()) {
      const want = s.tpl.fidelity !== 'full' || s.tpl.unimplemented.length > 0;
      expect(f[k]!.items.some((i) => i.id === s.tpl.id)).toBe(want);
      if (want) expect(f[k]!.items[0]!.unimplemented).toEqual(s.tpl.unimplemented);
    }
  });
});
