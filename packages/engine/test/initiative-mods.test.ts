// Modifiers on d20.check.initiative (docs/design/m3.md section 3, RKEY): initiative stays on its
// own draw (openInit slot 0); a modifier folds into that draw's flat bonus and Advantage only,
// so no stream or slot moves. Fixtures: a passive effect on the sample fighter, vs a dummy.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../src/content/load.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import { makeDeciders } from '../src/decide/make.ts';
import { ArraySink, type GameEvent } from '../src/log/events.ts';
import { resolveScenario, type ScenarioOverrides } from '../src/scenario/resolve.ts';
import { runFight } from '../src/sim/fight.ts';
import type { FightSetup } from '../src/sim/setup.ts';
import { compileKeyPattern } from '../src/content/rollkeys.ts';
import type { CompiledMod, CompiledTemplate, Id } from '../src/content/types.ts';
import { effect, setup as buildSetup, template } from './helpers/build.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const walk = (d: string): string[] =>
  readdirSync(d)
    .flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.yaml') ? [p] : [];
    })
    .sort();
const readPack = (name: string): SourceFile[] => walk(join(ROOT, 'packs', name)).map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, 'utf8') }));
const REPO = [...readPack('srd-5.2.1'), ...readPack('test')];
const FIGHTER = 'packs/test/pcs/sample-fighter.yaml';
const FEATURE = 'packs/test/data/init-mod.yaml';

/** A passive feature whose one effect carries `mod` (YAML flow map). */
const feature = (mod: string) => `kind: feature
id: test:init-mod
name: Init Mod
source: synthetic test fixture
passive: { effects: [edge] }
effects:
  - id: edge
    name: Edge
    mods: [${mod}]
`;

/** The fighter vs a training dummy; with `mod`, the fighter has the passive feature. */
function duel(mod: string | null, overrides: ScenarioOverrides = {}): FightSetup {
  const extra: Record<string, string> = {};
  if (mod !== null) {
    extra[FEATURE] = feature(mod);
    extra[FIGHTER] = `${REPO.find((f) => f.path === FIGHTER)!.text}features: [test:init-mod]\n`;
  }
  const files = [...REPO.filter((f) => !Object.hasOwn(extra, f.path)), ...Object.entries(extra).map(([path, text]) => ({ path, text }))];
  const loaded = loadContent(files);
  if (!loaded.content) throw new Error(loaded.errors.map(formatDiag).join('\n'));
  const doc = {
    kind: 'scenario', id: 'duel', name: 'Duel', rules: '2024', packs: ['srd-5.2.1', 'test'],
    grid: { w: 6, h: 3 },
    units: [
      { seat: 'pc1', team: 'party', use: 'test:sample-fighter', at: 'B2', decider: 'random-legal' },
      { seat: 'dummy', team: 'enemies', use: 'test:training-dummy', at: 'E2' },
    ],
  };
  const r = resolveScenario(doc, 'duel.yaml', loaded.content, overrides);
  if (!r.setup) throw new Error(r.errors.map(formatDiag).join('\n'));
  return r.setup;
}

type Init = Extract<GameEvent, { k: 'initiative' }>;
/** The initiative events of one fight, by unit index, without seq (a passive effect's fxStart comes first). */
function inits(setup: FightSetup, seed: number): Omit<Init, 'seq'>[] {
  const sink = new ArraySink();
  runFight(setup, seed, 0, makeDeciders(setup), sink);
  return (sink.events.filter((e) => e.k === 'initiative') as Init[]).sort((a, b) => a.who - b.who).map(({ seq: _, ...rest }) => rest);
}

const SEEDS = Array.from({ length: 30 }, (_, i) => i + 1);
const BASE = duel(null);
const pc = BASE.seats.findIndex((s) => s.seat === 'pc1');
const dummy = 1 - pc;

describe('initiative modifiers (RKEY)', () => {
  it('a flat modifier on d20.check.initiative adds to the initiative total and leaves the natural roll where it was', () => {
    const plus = duel('{ on: [d20.check.initiative], op: flat, value: 3 }');
    for (const seed of SEEDS) {
      const [b, w] = [inits(BASE, seed), inits(plus, seed)];
      expect(w[pc]!.natural, `seed ${seed}`).toBe(b[pc]!.natural);
      expect(w[pc]!.total, `seed ${seed}`).toBe(b[pc]!.total + 3);
      expect(w[dummy], `seed ${seed}`).toEqual(b[dummy]); // nobody else's dice move
    }
  });

  it('Advantage on d20.check.initiative keeps the first die and adds a second on the same stream', () => {
    const adv = duel('{ on: [d20.check.initiative], op: adv }');
    let better = 0;
    for (const seed of SEEDS) {
      const [b, w] = [inits(BASE, seed), inits(adv, seed)];
      expect(w[pc]!.natural, `seed ${seed}`).toBeGreaterThanOrEqual(b[pc]!.natural);
      expect(w[pc]!.total - w[pc]!.natural).toBe(b[pc]!.total - b[pc]!.natural);
      if (w[pc]!.natural > b[pc]!.natural) better++;
      expect(w[dummy], `seed ${seed}`).toEqual(b[dummy]);
    }
    expect(better).toBeGreaterThan(0);
  });

  it('a modifier on a sibling check (DEX Stealth, a WIS check, a DEX save) leaves initiative unchanged', () => {
    for (const on of ['d20.check.dex.stealth', 'd20.check.wis', 'd20.save.dex']) {
      const sib = duel(`{ on: [${on}], op: flat, value: 5 }`);
      for (const seed of SEEDS.slice(0, 10)) expect(inits(sib, seed), `${on} seed ${seed}`).toEqual(inits(BASE, seed));
    }
  });

  it('a DEX check modifier covers initiative, which is a DEX check (SRD 5.2.1 p.13)', () => {
    const dex = duel('{ on: [d20.check.dex], op: flat, value: 2 }');
    for (const seed of SEEDS.slice(0, 10)) expect(inits(dex, seed)[pc]!.total).toBe(inits(BASE, seed)[pc]!.total + 2);
  });

  it('under static initiative a flat modifier adds to the score and Advantage counts +5', () => {
    const flags = { flags: { initiativeMode: 'static' as const } };
    const base = inits(duel(null, flags), 1)[pc]!.total;
    expect(inits(duel('{ on: [d20.check.initiative], op: flat, value: 3 }', flags), 1)[pc]!.total).toBe(base + 3);
    expect(inits(duel('{ on: [d20.check.initiative], op: adv }', flags), 1)[pc]!.total).toBe(base + 5);
  });

  it('a one-use rider (consume: nextRoll) is left out of initiative: no Advantage or bonus there, and it is not spent', () => {
    for (const mod of ['{ on: [d20.check.initiative], op: adv, consume: nextRoll }', '{ on: [d20.check], op: flat, value: 4, consume: nextRoll }']) {
      const rider = duel(mod);
      for (const seed of SEEDS) expect(inits(rider, seed), `${mod} seed ${seed}`).toEqual(inits(BASE, seed));
      const sink = new ArraySink();
      runFight(rider, 1, 0, makeDeciders(rider), sink);
      const firstRound = sink.events.findIndex((e) => e.k === 'roundStart');
      expect(sink.events.slice(0, firstRound).some((e) => e.k === 'fxEnd')).toBe(false);
    }
  });
});

describe('shared group initiative with modifiers', () => {
  const initMod = (value: number): CompiledMod => ({ on: [compileKeyPattern('d20.check.initiative')], side: 'self', op: 'flat', value, dice: null, consume: false, skillParam: false });
  const GOB = template({ id: 'gob', dex: 14, attacks: [{ local: 'stab', toHit: 4, damage: [['1d6', 'piercing']] }] });
  /** The same stat block (same template id) with a passive effect carrying `value` on initiative. */
  const edged = (value: number): CompiledTemplate => ({
    ...GOB,
    effects: [effect('edge', { mods: [initMod(value)] })],
    features: [{ id: 'test:edge' as Id, local: 'edge', name: 'Edge', activate: null, preRoll: null, passive: [0] }],
  });
  const PC = template({ id: 'pc', kind: 'pc', attacks: [{ local: 'club', toHit: 3, damage: [['1d4', 'bludgeoning']] }] });
  function groupInits(tpls: CompiledTemplate[], seed: number): Init[] {
    const s = buildSetup({
      w: 12, h: 3,
      units: [{ seat: 'a-pc', team: 0, tpl: PC, at: 'A1' }, ...tpls.map((tpl, i) => ({ seat: `g${i}`, team: 1 as const, tpl, at: `${String.fromCharCode(72 + i)}2` }))],
    });
    const sink = new ArraySink();
    runFight(s, seed, 0, makeDeciders(s), sink);
    return (sink.events.filter((e) => e.k === 'initiative') as Init[]).sort((a, b) => a.who - b.who);
  }

  it('a member whose own initiative modifiers differ from the leader\'s rolls on its own', () => {
    for (const seed of SEEDS.slice(0, 10)) {
      const [, lead, odd] = groupInits([GOB, edged(5)], seed);
      expect(lead!.leader, `seed ${seed}`).toBe(lead!.who);
      expect(odd!.leader, `seed ${seed}`).toBe(odd!.who);
      expect(odd!.total - odd!.natural, `seed ${seed}`).toBe(2 + 5); // its own DEX +2 and its own +5
    }
  });

  it('members with matching modifiers still share one roll, and so do members with none (grouping unchanged)', () => {
    for (const seed of SEEDS.slice(0, 10)) {
      for (const tpls of [[GOB, GOB, GOB], [edged(3), GOB, edged(3)]]) {
        const [, a, b, c] = groupInits(tpls, seed);
        const same = tpls[0] === tpls[1];
        expect(b!.leader, `seed ${seed}`).toBe(same ? a!.who : b!.who);
        expect(c!.leader, `seed ${seed}`).toBe(a!.who);
        expect(c!.total).toBe(a!.total);
      }
    }
  });
});
