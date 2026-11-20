// The premade heroes (tools/gen-heroes.ts): 12 classes x levels 1-10 for the browser app's party
// pickers. The committed files are a fresh generation; every hero loads and fights.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatDiag, loadContent, makeDeciders, resolveScenario, runFight } from '../../packages/engine/src/index.ts';
import { HERO_DIR, HERO_LEVELS, heroes } from '../gen-heroes.ts';
import { PICK_CLASSES } from '../class-picks.ts';
import { smokePackFiles } from '../smoke-classes.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const MADE = heroes(ROOT);
const FILES = [...smokePackFiles(ROOT), ...MADE.map((h) => ({ path: `packs/test/characters/heroes/${h.file}`, text: h.text }))];
const LOADED = loadContent(FILES);

describe('premade heroes', () => {
  it('is one per class and level, and the committed files are a fresh generation', () => {
    expect(MADE).toHaveLength(PICK_CLASSES.length * HERO_LEVELS.length);
    const dir = join(ROOT, HERO_DIR);
    expect(readdirSync(dir).sort()).toEqual(MADE.map((h) => h.file).sort());
    for (const h of MADE) expect(readFileSync(join(dir, h.file), 'utf8'), h.file).toBe(h.text);
  });
  it('every hero loads with no error and names only srd: content', () => {
    expect(LOADED.errors.map(formatDiag)).toEqual([]);
    for (const h of MADE) {
      expect(LOADED.content!.get(h.id as never)?.kind, h.id).toBe('pc');
      const ids = [...h.text.matchAll(/\b((?:srd|test|private):[a-z0-9/-]+)/g)].map((m) => m[1]!);
      for (const id of ids) if (id !== h.id) expect(id.startsWith('srd:'), `${h.id} names ${id}`).toBe(true);
    }
  });
  it('every hero plays a fight to an end with no engine error', () => {
    for (const h of MADE) {
      const doc = { kind: 'scenario', id: 'hero-check', name: 'hero check', rules: '2024', packs: LOADED.content!.packs.map((p) => p.pack), grid: { w: 12, h: 12 }, knobs: { downEnds: false, lossCounts: 'pcs', maxRounds: 20 }, units: [{ seat: 'pc1', team: 'party', use: h.id, at: 'F10', decider: 'greedy' }, { seat: 'foe1', team: 'enemies', use: 'srd:goblin-warrior', at: 'F4', decider: 'greedy' }, { seat: 'foe2', team: 'enemies', use: 'srd:goblin-warrior', at: 'H4', decider: 'greedy' }] };
      const res = resolveScenario(doc, 'hero-check.yaml', LOADED.content!);
      expect(res.errors.map(formatDiag), h.id).toEqual([]);
      const deciders = makeDeciders(res.setup!);
      const out = runFight(res.setup!, 3, 0, deciders, null, { policy: deciders.map((d) => d.name) }).outcome;
      expect(['win', 'loss', 'stalemate'], h.id).toContain(out.k);
    }
  });
});
