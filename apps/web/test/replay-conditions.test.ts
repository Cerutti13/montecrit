// Replay condition markers (apps/web/src/replay/controller.ts condMarkers, m3.md 10): every
// condition the engine carries gets a distinct two-letter badge and its full name, in a fixed
// most-decisive-first order; unknown ids are named from the id, never guessed; concentration
// last, named after its effect. And on a real Monk fight, the markers at each frame are exactly
// the conditions the event fold holds there.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArraySink, buildFrames, formatDiag, loadContent, makeDeciders, runFight, type GameEvent, type SourceFile } from '@montecrit/engine';
import { COND_IDS } from '../../../packages/engine/src/sim/state.ts';
import { loadScenario } from '../../../packages/engine/test/helpers/scenario.ts';
import { condMarkers } from '../src/replay/controller.ts';

describe('condition markers', () => {
  it('every engine condition has its own two-letter badge and a full name', () => {
    const ms = condMarkers(COND_IDS.map(([, id]) => id as string), -1);
    expect(ms.length).toBe(COND_IDS.length);
    expect(new Set(ms.map((m) => m.abbr)).size).toBe(ms.length);
    for (const m of ms) {
      expect(m.abbr).toMatch(/^[A-Z][a-z]$/);
      expect(m.name.toLowerCase()).toBe(m.id.split(':')[1]);
    }
  });
  it('orders known conditions most decisive first, whatever order they come in', () => {
    expect(condMarkers(['core:poisoned', 'core:prone', 'core:stunned', 'core:incapacitated'], -1).map((m) => m.abbr)).toEqual(['St', 'In', 'Pr', 'Po']);
    expect(condMarkers(['core:prone', 'core:unconscious'], -1).map((m) => m.name)).toEqual(['Unconscious', 'Prone']);
  });
  it('names an unknown id from the id, after the known ones; drops duplicates', () => {
    expect(condMarkers(['test:held-fast', 'core:prone', 'core:prone'], -1)).toEqual([
      { id: 'core:prone', abbr: 'Pr', name: 'Prone' },
      { id: 'test:held-fast', abbr: 'He', name: 'Held fast' },
    ]);
    expect(condMarkers(['core:grappled'], -1)).toEqual([{ id: 'core:grappled', abbr: 'Gr', name: 'Grappled' }]);
  });
  it('adds concentration last, named after the effect when known', () => {
    expect(condMarkers([], -1)).toEqual([]);
    expect(condMarkers([], 3)).toEqual([{ id: 'conc', abbr: 'C', name: 'Concentrating' }]);
    expect(condMarkers(['core:prone'], 3, 'Moonbeam').map((m) => m.name)).toEqual(['Prone', 'Concentrating on Moonbeam']);
  });
});

const ROOT = join(import.meta.dirname, '..', '..', '..');
const walk = (d: string): string[] =>
  readdirSync(d)
    .flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.yaml') ? [p] : [];
    })
    .sort();
const readPack = (name: string): SourceFile[] => walk(join(ROOT, 'packs', name)).map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, 'utf8') }));

describe('condition markers on a replayed fight', () => {
  it('match the folded conditions and concentration at every frame of Monk fights, Stunned and Prone included', { timeout: 120_000 }, () => {
    const loaded = loadContent([...readPack('srd-5.2.1'), ...readPack('test')]);
    if (!loaded.content) throw new Error(loaded.errors.map(formatDiag).join('\n'));
    const setup = loadScenario('scenarios/monk-ambush.yaml', loaded.content);
    const seen = new Set<string>();
    for (let run = 0; run < 12; run++) {
      const sink = new ArraySink();
      runFight(setup, 23, run, makeDeciders(setup, []), sink);
      const events = sink.events as readonly GameEvent[];
      const view = buildFrames(setup, events, null);
      for (const f of view.frames) {
        for (const u of f.units) {
          const ms = condMarkers(u.conds, u.conc);
          expect(ms.filter((m) => m.id !== 'conc').map((m) => m.id).sort()).toEqual([...u.conds].sort());
          expect(ms.some((m) => m.id === 'conc')).toBe(u.conc >= 0);
          for (const m of ms) seen.add(m.id);
        }
      }
    }
    expect(seen.has('core:prone')).toBe(true);
  });
});
