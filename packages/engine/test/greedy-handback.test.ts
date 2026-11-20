// Coverage 8'b review (determinism-2, docs/design/coverage.md M7): a cast's level travels on its
// sub-decisions (DecisionPoint.src.lvl), so a journal that ends between a turn decision and that
// cast's target hands over to an AI that values the same program. Content is synthetic (test: ids).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../src/content/load.ts';
import type { Decider } from '../src/decide/decider.ts';
import { formatDiag } from '../src/content/yaml.ts';
import { makeDeciders } from '../src/decide/make.ts';
import { resolveScenario } from '../src/scenario/resolve.ts';
import { runFight } from '../src/sim/fight.ts';
const ROOT = join(import.meta.dirname, '..', '..', '..');
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.yaml') ? [p] : []; }).sort();
const readPack = (name: string) => walk(join(ROOT, 'packs', name)).map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, 'utf8') }));
const REPO = [...readPack('srd-5.2.1'), ...readPack('test')];
const pcy = `kind: pc
id: test:hb-pc
name: Handback PC
source: synthetic test fixture
rules: '2024'
level: 5
size: medium
speed: 30
abilities: { str: 10, dex: 12, con: 14, int: 10, wis: 18, cha: 8 }
hpMax: 40
ac: 16
armor: none
saveProficiencies: [wis, cha]
weapons:
  - { id: club, name: Club, kind: melee, ability: str, category: simple, damage: [{ roll: 1d4 + @mod, type: bludgeoning }] }
features: []
slots: [4, 3, 2]
casting:
  - { source: cleric, ability: wis, list: cleric, cantrips: [srd:sacred-flame], prepared: ['srd:guiding-bolt', 'srd:cure-wounds', 'srd:healing-word'] }
`;
const mon = (id: string, hp: number, th: number, d: string, a: number) => `kind: monster
id: test:${id}
name: ${id}
source: synthetic test fixture
size: medium
cr: 1
pb: 2
ac: 13
hp: { average: ${hp}, formula: '${hp}' }
speed: { walk: 30 }
initiative: { mod: 0, score: 10 }
abilities: { str: 14, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }
attacks:
  - { id: claw, name: Claw, kind: melee, toHit: ${th}, damage: [{ roll: '${d}', type: slashing, avg: ${a} }] }
`;
const files = [...REPO, { path: 'packs/test/pcs/hb.yaml', text: pcy }, { path: 'packs/test/monsters/hb-a.yaml', text: mon('hb-a', 18, 6, '2d6 + 4', 11) }, { path: 'packs/test/monsters/hb-b.yaml', text: mon('hb-b', 30, 6, '2d6 + 4', 11) }, { path: 'packs/test/monsters/hb-c.yaml', text: mon('hb-c', 12, 6, '1d6 + 2', 5) }];
const setup = () => {
  const r = loadContent(files);
  if (!r.content) throw new Error(r.errors.map(formatDiag).join('\n'));
  const doc = {
    kind: 'scenario', id: 'hb', name: 'hb', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: { w: 12, h: 6 }, flags: { initiativeMode: 'static' }, knobs: { downEnds: false, maxRounds: 8 },
    units: [['pc1', 'party', 'test:hb-pc', 'B2'], ['pc2', 'party', 'test:hb-pc', 'B4'], ['a', 'enemies', 'test:hb-a', 'H2'], ['b', 'enemies', 'test:hb-b', 'H4'], ['c', 'enemies', 'test:hb-c', 'H5']].map(([seat, team, use, at]) => ({ seat, team, use, at, decider: 'greedy' })),
  };
  const res = resolveScenario(doc, 'hb.yaml', r.content);
  if (!res.setup) throw new Error(res.errors.map(formatDiag).join('\n'));
  return res.setup;
};

/** The fight played by the AI, with every decision recorded. */
function record(s: ReturnType<typeof setup>, run: number) {
  const entries: { seat: string; key: string; at: number }[] = [];
  const ds = makeDeciders(s).map((d): Decider => ({
    name: d.name,
    decide(view, dp) {
      const i = d.decide(view, dp);
      entries.push({ seat: view.q.units[dp.who]!.seat, key: dp.keyOf(i), at: dp.at });
      return i;
    },
  }));
  return { entries, hash: runFight(s, 3, run, ds, null).stateHash };
}

describe('--journal hand-back (M7: greedy holds no memory between decisions)', () => {
  it('a recorded caster fight, cut at every decision and handed to fresh AI deciders, ends in the same state: an upcast cut between the cast and its target included', () => {
    const s = setup();
    // Runs where the chosen level changes the target: a fallback that valued the lowest level picked differently.
    for (const run of [5, 32]) {
      const f = record(s, run);
      expect(f.entries.some((e) => /^cast:guiding-bolt@3/.test(e.key))).toBe(true);
      for (let cut = 1; cut < f.entries.length; cut++) {
        const r = runFight(s, 3, run, makeDeciders(s, f.entries.slice(0, cut)), null);
        expect(r.stateHash, `run ${run} cut ${cut}: ${f.entries[cut - 1]!.key} -> ${f.entries[cut]!.key}`).toBe(f.hash);
      }
    }
  }, 60000);

  it('the upcasts of other runs, at just the cut between cast and target', () => {
    const s = setup();
    let cuts = 0;
    for (let run = 0; run < 40; run++) {
      const f = record(s, run);
      for (let cut = 1; cut < f.entries.length; cut++) {
        if (!/^cast:.*@[23]/.test(f.entries[cut - 1]!.key)) continue;
        cuts++;
        expect(runFight(s, 3, run, makeDeciders(s, f.entries.slice(0, cut)), null).stateHash, `run ${run} cut ${cut}`).toBe(f.hash);
      }
    }
    expect(cuts).toBeGreaterThan(50);
  }, 120000);
});
