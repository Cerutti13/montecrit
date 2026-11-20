// Precast (docs/design/m1c.md 7.4, build step 11): spells already up when the fight starts,
// resolved before initiative with no dice, no appear hook, the slot counted as a precast slot,
// durations shortened by `elapsed`, and seenBy feeding fx.seen. Then the scenario checks.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../src/content/load.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import { makeDeciders } from '../src/decide/make.ts';
import { ArraySink, type GameEvent } from '../src/log/events.ts';
import { renderLog } from '../src/log/render.ts';
import { runChunk } from '../src/mc/runner.ts';
import { resolveScenario } from '../src/scenario/resolve.ts';
import { runFight } from '../src/sim/fight.ts';
import type { FightSetup } from '../src/sim/setup.ts';
import type { GameState } from '../src/sim/state.ts';
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
const CONTENT = loaded.content;
const BASE = parse(readFileSync(join(ROOT, 'scenarios', 'stars-ambush.yaml'), 'utf8')) as { units: Record<string, unknown>[] };

/** stars-ambush with pc1's fields replaced (precast, surprised), resolved. */
function withPc1(over: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const doc = { ...BASE, ...extra, units: BASE.units.map((u) => (u.seat === 'pc1' ? { ...u, surprised: false, ...over } : u)) };
  return resolveScenario(doc, 'test.yaml', CONTENT);
}
function setupOf(over: Record<string, unknown>): FightSetup {
  const r = withPc1(over);
  if (!r.setup) throw new Error(r.errors.map(formatDiag).join('\n'));
  return r.setup;
}
const errorsOf = (over: Record<string, unknown>) => withPc1(over).errors.map((d) => d.message).join('\n');

function fight(setup: FightSetup, seed = 1) {
  const sink = new ArraySink();
  let end: GameState | null = null;
  const r = runFight(setup, seed, 0, makeDeciders(setup), sink, { inspect: (st) => (end = st) });
  return { r, events: sink.events, log: renderLog(sink.events, setup).join('\n'), end: end! as GameState };
}
const before = (events: readonly GameEvent[]) => events.slice(0, events.findIndex((e) => e.k === 'roundStart'));

describe('precast: resolution', () => {
  const AMBUSH = loadScenario('scenarios/stars-ambush-precast.yaml', CONTENT);
  const pc = AMBUSH.seats.findIndex((s) => s.seat === 'pc1');

  it('casts before initiative, caused by the fight start: a precast slot, concentration, the zone, and no dice', () => {
    const { r, events, end } = fight(AMBUSH);
    const pre = before(events);
    const cast = pre.find((e) => e.k === 'precast')!;
    expect(cast).toMatchObject({ round: 0, who: pc, via: 'srd:spike-growth', lvl: 2, free: null, left: 2, elapsed: 0, cause: events[0]!.seq });
    expect(pre.findIndex((e) => e.k === 'precast')).toBeLessThan(pre.findIndex((e) => e.k === 'initiative'));
    // Nothing before initiative rolls: no save, damage or attack (initiative is the first roll).
    expect(pre.filter((e) => e.k === 'save' || e.k === 'damage' || e.k === 'attack')).toEqual([]);
    expect(r.counters.preSlots[pc * 9 + 1]).toBe(1);
    // In-fight slot counts are exactly the in-fight slot casts: the precast slot isn't among them.
    const casts = events.filter((e) => e.k === 'cast' && e.who === pc && e.lvl > 0 && e.free === null);
    for (let l = 1; l <= 9; l++) expect(r.counters.slots[pc * 9 + l - 1], `level ${l}`).toBe(casts.filter((e) => e.k === 'cast' && e.lvl === l).length);
    expect(r.counters.concStart[pc]).toBeGreaterThanOrEqual(1);
    const zone = pre.find((e) => e.k === 'zone')!;
    // seenBy: party. The caster and the ally saw it; no goblin did.
    expect(zone.k === 'zone' && zone.seen.map((i) => AMBUSH.seats[i]!.seat)).toEqual(['ally1', 'pc1']);
    expect(end.fx[zone.k === 'zone' ? zone.fx : -1]!.seen![pc]).toBe(1);
  });

  it('a precast zone fires no appear hook: Moonbeam over a goblin rolls no save at the start', () => {
    const s = setupOf({ precast: [{ cast: 'srd:moonbeam', level: 2, at: 'F5', seenBy: 'all' }] });
    for (const seed of [1, 2, 3, 4]) {
      const { events, log } = fight(s, seed);
      expect(log).toMatch(/pc1 cast Moonbeam before the fight with a level 2 slot/);
      expect(before(events).some((e) => e.k === 'save' || e.k === 'damage'), `seed ${seed}`).toBe(false);
    }
    // The same Moonbeam cast on a turn does save on appearing (the hook is there; only the precast skips it).
    expect(fight(s, 2).log).toMatch(/pc1 casts Moonbeam[\s\S]*Moonbeam appears[^\n]*\n[^\n]*CON save vs Moonbeam/);
  });

  it('elapsed shortens the duration: the concentration ends on the caster\'s turn (duration - elapsed)', () => {
    const inst = (elapsed: number) => {
      const s = setupOf({ precast: [{ cast: 'srd:moonbeam', level: 2, at: 'F5', elapsed }] });
      let st: GameState | null = null;
      runFight(s, 1, 0, makeDeciders(s), null, { inspect: (x) => (st = x) });
      return (st! as GameState).fx[0]!;
    };
    const pcIdx = AMBUSH.seats.findIndex((x) => x.seat === 'pc1');
    expect(inst(0).until).toEqual({ k: 'timed', unit: pcIdx, turn: 10 });
    expect(inst(3).until).toEqual({ k: 'timed', unit: pcIdx, turn: 7 });
    expect(inst(3).born).toBe(-3);
  });

  it('seenBy sets who saw it appear; the caster always did', () => {
    const seen = (seenBy: unknown) => {
      const s = setupOf({ precast: [{ cast: 'srd:spike-growth', level: 2, at: 'G5', seenBy }] });
      const { events, end } = fight(s);
      const z = events.find((e) => e.k === 'zone')!;
      const fx = end.fx[z.k === 'zone' ? z.fx : -1]!;
      return s.seats.filter((_, i) => fx.seen![i] === 1).map((x) => x.seat);
    };
    expect(seen('none')).toEqual(['pc1']);
    expect(seen(['gob2', 'boss1'])).toEqual(['boss1', 'gob2', 'pc1']);
    expect(seen('all')).toHaveLength(AMBUSH.seats.length);
  });

  it('seenBy defaults to the caster\'s own side, so an enemy precaster\'s allies know its zone and the party doesn\'t', () => {
    const seenFor = (seenBy?: string) => {
      const units = BASE.units.map((u) => (u.seat === 'gob1' ? { ...u, use: 'test:sample-druid', precast: [{ cast: 'srd:spike-growth', level: 2, at: 'F9', ...(seenBy ? { seenBy } : {}) }] } : u));
      // Coverage step 9: damage from the hidden zone would reveal it (hiddenHazardRevealedByDamage); off, so seen is who saw it appear.
      const r = resolveScenario({ ...BASE, units, flags: { ...(BASE as { flags?: Record<string, unknown> }).flags, hiddenHazardRevealedByDamage: false } }, 'test.yaml', CONTENT);
      if (!r.setup) throw new Error(r.errors.map(formatDiag).join('\n'));
      const { events, end } = fight(r.setup);
      const z = events.find((e) => e.k === 'zone')!;
      const fx = end.fx[z.k === 'zone' ? z.fx : -1]!;
      return r.setup.seats.filter((_, i) => fx.seen![i] === 1).map((x) => x.seat);
    };
    const enemies = BASE.units.filter((u) => u.team === 'enemies').map((u) => u.seat as string).sort();
    expect(seenFor()).toEqual(enemies);
    expect(seenFor('side')).toEqual(enemies);
    expect(seenFor('party')).toEqual(['ally1', 'gob1', 'pc1']); // the party's side, plus the caster
  });

  it('is deterministic and runs through the Monte Carlo runner', () => {
    expect(fight(AMBUSH, 9).r.stateHash).toBe(fight(AMBUSH, 9).r.stateHash);
    const c = runChunk([{ label: 'g', setup: AMBUSH, policy: null }], 3, 0, 4, 4);
    expect(c.arms[0]!.preSlots[pc * 9 + 1]).toBe(4);
  });
});

describe('precast: scenario checks', () => {
  it('a precast changes the scenario hash; a scenario without one keeps its hash', () => {
    const plain = withPc1({}).setup!;
    const empty = withPc1({ precast: [] }).setup!;
    const spikes = setupOf({ precast: [{ cast: 'srd:spike-growth', level: 2, at: 'G5' }] });
    const elsewhere = setupOf({ precast: [{ cast: 'srd:spike-growth', level: 2, at: 'G6' }] });
    expect(empty.scenarioHash).toBe(plain.scenarioHash);
    expect(spikes.scenarioHash).not.toBe(plain.scenarioHash);
    expect(elsewhere.scenarioHash).not.toBe(spikes.scenarioHash);
  });

  it('rejects anything that would roll dice, naming the step', () => {
    expect(errorsOf({ precast: [{ cast: 'srd:guiding-bolt', level: 1, target: 'gob2' }] })).toMatch(/srd:guiding-bolt: its attack step would roll dice before the fight/);
    expect(errorsOf({ precast: [{ cast: 'srd:healing-word', level: 1, target: 'ally1' }] })).toMatch(/its heal step would roll dice/);
  });

  it('checks level, pool, area, target, elapsed, and one concentration per caster', () => {
    expect(errorsOf({ precast: [{ cast: 'srd:moonbeam', at: 'F5' }] })).toMatch(/level 2 spell: give the slot level/);
    expect(errorsOf({ precast: [{ cast: 'srd:moonbeam', level: 2 }] })).toMatch(/has an area: give its origin square/);
    expect(errorsOf({ precast: [{ cast: 'srd:moonbeam', level: 2, at: 'F5', target: 'gob2' }] })).toMatch(/doesn't target a creature/);
    expect(errorsOf({ precast: [{ cast: 'srd:moonbeam', level: 2, at: 'F5', elapsed: 10 }] })).toMatch(/elapsed 10 isn't less than its concentration's 10-round duration/);
    expect(errorsOf({ precast: [{ cast: 'srd:moonbeam', level: 2, at: 'F5' }, { cast: 'srd:spike-growth', level: 2, at: 'G5' }] })).toMatch(/second concentration precast/);
    expect(errorsOf({ precast: [{ cast: 'srd:fireball', level: 3, at: 'F5' }] })).toMatch(/has no spell srd:fireball/);
    expect(errorsOf({ precast: [{ cast: 'srd:guiding-bolt', pool: 'forms', target: 'gob2' }] })).toMatch(/no free casts from a pool "forms"/);
    expect(errorsOf({ precast: [{ feature: 'test:stance' }] })).toMatch(/precasting a feature isn't supported yet/);
    expect(errorsOf({ precast: [{ cast: 'srd:moonbeam', level: 2, pool: 'x', at: 'F5' }] })).toMatch(/level or pool, not both/);
  });

  it('dry-runs the rest at the start: levels it has slots for, the origin, components; the engine refuses a slot it doesn\'t have', () => {
    expect(errorsOf({ precast: [{ cast: 'srd:moonbeam', level: 4, at: 'F5' }] })).toMatch(/can't cast srd:moonbeam at level 4/);
    expect(errorsOf({ precast: [{ cast: 'srd:spike-growth', level: 2, at: 'Z9' }] })).toMatch(/Z9 isn't a place it can be centered/);
    // Four level-2 precasts for three level-2 slots, handed straight to the engine (resolution would refuse the second concentration).
    const ok = setupOf({ precast: [{ cast: 'srd:spike-growth', level: 2, at: 'G5' }] });
    const pcIdx = ok.seats.findIndex((x) => x.seat === 'pc1');
    const four = { ...ok, seats: ok.seats.map((x, i) => (i === pcIdx ? { ...x, precast: [0, 1, 2, 3].map(() => x.precast![0]!) } : x)) };
    expect(() => runFight(four, 1, 0, makeDeciders(four), null)).toThrow(/pc1's precast srd:spike-growth: no level 2 slot left/);
    // Produce Flame (V, S, no Material) with a shield and a focus held: under the strict focus-hand rule, no hand for the gestures.
    expect(errorsOf({ precast: [{ cast: 'srd:produce-flame' }] })).toMatch(/components can't be supplied/);
    expect(withPc1({ precast: [{ cast: 'srd:produce-flame' }] }, { flags: { focusHandSomatic: 'lenient' } }).errors).toEqual([]);
  });

  it('warns when a surprised creature has a precast', () => {
    const r = withPc1({ surprised: true, precast: [{ cast: 'srd:spike-growth', level: 2, at: 'G5' }] });
    expect(r.errors).toEqual([]);
    expect(r.warnings.map((d) => d.message).join()).toMatch(/surprised creature that cast a spell before the fight/);
  });
});
