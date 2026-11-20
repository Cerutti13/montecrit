// View-only event fields (docs/design/m2.md 4.2): zone and zoneMove events carry the zone's exact
// cells as `area` for the replay viewer; HashSink drops it, so every log hash (and every golden's
// logHash line) is what it was before the field existed.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../src/content/load.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import { makeDeciders } from '../src/decide/make.ts';
import { ArraySink, HashSink, VIEW_ONLY_KEYS, type GameEvent } from '../src/log/events.ts';
import { runFight } from '../src/sim/fight.ts';
import { canonicalJson } from '../src/util/canon.ts';
import { Hash64 } from '../src/util/hash.ts';
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
const content = loaded.content;

/** The pre-M2 hash: the same rules as HashSink, with nothing view-only to strip. */
function hashWithout(events: readonly GameEvent[]): string {
  const h = new Hash64();
  for (const e of events) {
    const c: Record<string, unknown> = { ...e };
    for (const k of VIEW_ONLY_KEYS) delete c[k];
    if (e.k === 'decided') delete c.by;
    if (e.k === 'fightStart') {
      const { journal: _j, policy: _p, ...key } = e.key;
      c.key = key;
    }
    h.update(canonicalJson(c)).update('\n');
  }
  return h.hex();
}

describe('view-only area on zone events', () => {
  it('every zone and zoneMove event carries its cells; HashSink ignores them', { timeout: 60_000 }, () => {
    let zones = 0;
    let moves = 0;
    for (const file of ['scenarios/stars-ambush.yaml', 'scenarios/stars-ambush-precast.yaml', 'scenarios/golden/pull-into-spikes.yaml']) {
      const setup = loadScenario(file, content);
      for (let run = 0; run < 12; run++) {
        const arr = new ArraySink();
        const hs = new HashSink();
        runFight(setup, 9, run, makeDeciders(setup, []), { emit: (e) => (arr.emit(e), hs.emit(e)) });
        for (const e of arr.events) {
          if (e.k === 'zone') {
            zones++;
            expect(e.area?.length).toBe(e.cells);
            expect(new Set(e.area).size).toBe(e.cells);
          } else if (e.k === 'zoneMove') {
            moves++;
            expect(e.area?.length).toBeGreaterThan(0);
          }
        }
        expect(hs.hex()).toBe(hashWithout(arr.events));
      }
    }
    expect(zones).toBeGreaterThan(0);
    expect(moves).toBeGreaterThan(0);
  });
});
