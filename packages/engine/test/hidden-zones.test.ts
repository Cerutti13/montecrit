// Coverage step 9 (docs/design/m3.md section 8): hidden zones and the Search action. Spike Growth is
// "camouflaged to look natural. Any creature that can't see the area when the spell is cast must take
// a Search action and succeed on a Wisdom (Perception or Survival) check against your spell save DC to
// recognize the terrain as hazardous" (SRD 5.2.1 p.164, srd-raw.txt:31015-31021); the Search action is
// one Wisdom check (34116-34118). Engine cases use hand-built stand-ins; the greedy and compile cases
// load the repo packs (srd:spike-growth, srd:moonbeam, srd:wolf, test:sample-druid).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../src/content/load.ts';
import { EffectSchema } from '../src/content/schema.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import { skillIndex } from '../src/content/rollkeys.ts';
import { HOOK, type BoundEffect, type CompiledTemplate, type SpellEntry } from '../src/content/types.ts';
import type { Decider, DecisionPoint, Legal, UnitView } from '../src/decide/decider.ts';
import { GreedyDecider, type ExplainRecord } from '../src/decide/greedy/greedy.ts';
import { searchValue } from '../src/decide/greedy/search.ts';
import { DEFAULT_WEIGHTS } from '../src/decide/greedy/weights.ts';
import { shapeKey } from '../src/grid/area.ts';
import { parseCell } from '../src/grid/cells.ts';
import { computeReach, forEachLabel, knownZones } from '../src/grid/reach.ts';
import { buildCounterLayout } from '../src/sim/counters.ts';
import { ArraySink, type GameEvent } from '../src/log/events.ts';
import { flagIndex, type RuleFlags } from '../src/rules/flags.ts';
import { resolveScenario } from '../src/scenario/resolve.ts';
import { resolveOption } from '../src/sim/act.ts';
import { copyLegal, legalKey, newLegal, releaseList, takeList } from '../src/sim/context.ts';
import { createContext, runFight } from '../src/sim/fight.ts';
import { listOptions } from '../src/sim/options.ts';
import { applyPassives, runPrecasts } from '../src/sim/precast.ts';
import { COND, stateHash, type Fx, type Unit } from '../src/sim/state.ts';
import { walkPath } from '../src/sim/walker.ts';
import { caster, DUMMY, effect, entry, S, setup, spell } from './helpers/build.ts';
import { ofKind } from './helpers/run.ts';

// ---- engine scenes: hand-built stand-ins (sim-zones.test.ts's shapes) ----

const BEAM_KEY = shapeKey('cylinder', 5);
const SPIKE_KEY = shapeKey('sphere', 20);
const inst = (local: string, n: number): BoundEffect => effect(`${local}-c`, { conc: true, dur: { k: 'rounds', n } });
/** A visible zone with an enter hook (Moonbeam's shape). */
const BEAM: BoundEffect = effect('beam', {
  sid: 1, lvl: 2, zone: { shapeKey: BEAM_KEY, heightFt: 40, difficult: false }, limit: 'perCreature',
  hooks: [{ on: HOOK.enter, steps: [S.damage('1', 'radiant')] }], hookMask: HOOK.enter,
});
/** A hidden per-distance zone (Spike Growth's shape) with its bound Search DC. */
const spikes = (dc: number): BoundEffect =>
  effect('spikes', {
    sid: 2, zone: { shapeKey: SPIKE_KEY, heightFt: 0, difficult: true },
    hooks: [{ on: HOOK.travel, steps: [S.damage('2d4', 'piercing')] }], hookMask: HOOK.travel, hiddenDc: dc,
  });
const zoneSpell = (local: string, sid: number, key: number, instIdx: number, zoneIdx: number): SpellEntry => {
  const instance = new Array<number>(10).fill(-1);
  instance[2] = instIdx;
  return entry(spell(local, { level: 2, conc: true, rangeFt: 150, areaShape: key, sid }), { 2: [S.apply(zoneIdx, 'point')] }, { instance });
};
function zoneCaster(dc = 13): CompiledTemplate {
  return caster({
    effects: [inst('beam', 10), BEAM, inst('spikes', 100), spikes(dc)],
    spells: [zoneSpell('beam', 1, BEAM_KEY, 0, 1), zoneSpell('spikes', 2, SPIKE_KEY, 2, 3)],
  });
}

class Keys implements Decider {
  readonly name = 'keys';
  readonly queue: string[];
  constructor(queue: string[] = []) {
    this.queue = queue;
  }
  decide(_v: UnitView, dp: DecisionPoint): number {
    const want = this.queue[0];
    if (want === undefined) return 0;
    for (let k = 0; k < dp.legal.n; k++) {
      if (dp.keyOf(k) === want) {
        this.queue.shift();
        return k;
      }
    }
    return 0;
  }
}

function scene(opts: { units: Parameters<typeof setup>[0]['units']; flags?: Partial<RuleFlags>; keys?: string[]; w?: number; h?: number; terrain?: string[] }) {
  const sink = new ArraySink();
  const s = setup({ w: opts.w ?? 14, h: opts.h ?? 7, flags: opts.flags, terrain: opts.terrain, units: opts.units });
  const keys = new Keys(opts.keys);
  const cx = createContext(s, 11, 0, s.seats.map(() => keys), sink, { audit: true });
  const u = (seat: string): Unit => cx.st.units.find((x) => x.seat === seat)!;
  const begin = (who: Unit) => {
    cx.st.active = who.idx;
    cx.st.turnIdx++;
    who.turns++;
    Object.assign(who.b, { action: 1, bonus: 1, reaction: 1, freeObj: 1, moveFt: who.tpl.speedFt, atkActive: false });
  };
  const keysOf = (who: Unit): string[] => {
    const list = listOptions(cx, who, takeList(cx));
    const out: string[] = [];
    for (let i = 0; i < list.n; i++) out.push(legalKey(cx.st, who.idx, list.items[i]!));
    releaseList(cx, list);
    return out;
  };
  const choose = (who: Unit, key: string) => {
    const list = listOptions(cx, who, takeList(cx));
    let chosen = null;
    for (let i = 0; i < list.n; i++) if (legalKey(cx.st, who.idx, list.items[i]!) === key) chosen = copyLegal(list.items[i]!, newLegal());
    releaseList(cx, list);
    if (!chosen) throw new Error(`${key} isn't offered`);
    resolveOption(cx, who, chosen, -1);
  };
  const walk = (who: Unit, cells: string[]) => walkPath(cx, who, Int32Array.from(cells.map((c) => parseCell(c, s.w, s.h))), cells.length, 'voluntary', -1);
  const ev = <K extends GameEvent['k']>(k: K) => ofKind(sink.events, k);
  const zoneOf = (local: string): Fx => cx.st.fx.find((f) => f.zbit >= 0 && cx.st.units[f.owner]!.tpl.effects[f.tpl]!.local === local)!;
  return { cx, s, u, begin, keysOf, choose, walk, ev, zoneOf };
}

const PC = (tpl = zoneCaster()) => ({ seat: 'pc', team: 0 as const, tpl, at: 'A4' });
const GOB = (seat: string, at: string, tpl: CompiledTemplate = { ...DUMMY, speedFt: 30 }) => ({ seat, team: 1 as const, tpl, at });
const hazardMoves = (keys: string[]) => keys.filter((k) => k.startsWith('move:') && /\/h[1-9]/.test(k));

describe('zoneKnowledge sawCast: hidden zones are unknown to non-witnesses, other zones are seen (coverage step 9)', () => {
  it('a non-witness walks into a hidden zone: no route of its counts the hazard, and walking it in deals the damage', () => {
    const w = scene({ units: [PC(), GOB('gob', 'M4')], keys: ['place:G4'] });
    w.begin(w.u('pc'));
    w.choose(w.u('pc'), 'cast:spikes@2');
    const gob = w.u('gob');
    const z = w.zoneOf('spikes');
    z.seen![gob.idx] = 0; // it didn't see it go down
    expect(knownZones(w.cx.st, gob) & (1 << z.zbit)).toBe(0);
    w.begin(gob);
    expect(hazardMoves(w.keysOf(gob))).toEqual([]); // nothing it's offered counts the spikes
    w.walk(gob, ['M4', 'L4', 'K4', 'J4']);
    expect(w.ev('damage').filter((e) => e.tgt === gob.idx).length).toBeGreaterThan(0); // damage applies whether or not it knows
  });

  it('a visible zone is known to a non-witness that can see a square of it, and only then', () => {
    // Open map: it sees the beam, so its routes through it count the hazard though it didn't see the cast.
    const open = scene({ units: [PC(), GOB('gob', 'M4')], keys: ['place:G4'] });
    open.begin(open.u('pc'));
    open.choose(open.u('pc'), 'cast:beam@2');
    const gob = open.u('gob');
    const beam = open.zoneOf('beam');
    beam.seen![gob.idx] = 0;
    expect(knownZones(open.cx.st, gob) & (1 << beam.zbit)).not.toBe(0);
    open.begin(gob);
    expect(hazardMoves(open.keysOf(gob)).length).toBeGreaterThan(0);
    // A wall between it and every square of the beam: unseen, so unknown (and an unseen cast).
    const terrain = ['..............', '..............', '..........#...', '..........#...', '..........#...', '..............', '..............'];
    const walled = scene({ units: [PC(), GOB('gob', 'M4')], keys: ['place:G4'], terrain });
    walled.begin(walled.u('pc'));
    walled.choose(walled.u('pc'), 'cast:beam@2');
    const g2 = walled.u('gob');
    const b2 = walled.zoneOf('beam');
    b2.seen![g2.idx] = 0;
    expect(knownZones(walled.cx.st, g2) & (1 << b2.zbit)).toBe(0);
  });

  it('its planning prices a hidden zone it does not know as plain ground; the walk still pays the real cost', () => {
    // gob (30 ft) at M4, the spikes on G4 (D..J on row 4). Unknowing, H4 is 25 ft away (L4..H4 plain to it);
    // knowing, J4 onward is Difficult Terrain and H4 is 40 ft away, out of reach.
    const w = scene({ units: [PC(), GOB('gob', 'M4')], keys: ['place:G4'] });
    w.begin(w.u('pc'));
    w.choose(w.u('pc'), 'cast:spikes@2');
    const gob = w.u('gob');
    const z = w.zoneOf('spikes');
    z.seen![gob.idx] = 0;
    w.begin(gob);
    const ftTo = (cell: string, extraKnown = 0) => {
      const sc = w.cx.views[gob.idx]!.scratch.reach;
      computeReach(w.cx.st, gob, 60, sc, extraKnown);
      let best = Infinity;
      forEachLabel(w.cx.st, gob, sc, 60, (c, ft) => {
        if (c === parseCell(cell, w.s.w, w.s.h) && ft < best) best = ft;
      });
      return best;
    };
    expect(ftTo('H4')).toBe(25);
    // The AI's "if it knew" route (search.ts, extraKnown) prices the Difficult Terrain too.
    expect(ftTo('H4', 1 << z.zbit)).toBe(40);
    expect(w.keysOf(gob).some((k) => k.startsWith('move:H4/'))).toBe(true);
    z.seen![gob.idx] = 1;
    expect(ftTo('H4')).toBe(40);
    expect(w.keysOf(gob).some((k) => k.startsWith('move:H4/'))).toBe(false);
    // Under all and none nothing is masked (their meaning predates step 9): the Difficult Terrain counts.
    for (const mode of ['all', 'none'] as const) {
      const v = scene({ units: [PC(), GOB('gob', 'M4')], keys: ['place:G4'], flags: { zoneKnowledge: mode } });
      v.begin(v.u('pc'));
      v.choose(v.u('pc'), 'cast:spikes@2');
      const g = v.u('gob');
      v.zoneOf('spikes').seen![g.idx] = 0;
      v.begin(g);
      expect(v.keysOf(g).some((k) => k.startsWith('move:H4/'))).toBe(false);
    }
    // The walk charges the real cost: J4 is a 10-ft step.
    z.seen![gob.idx] = 0;
    w.walk(gob, ['L4', 'K4', 'J4']);
    expect(w.ev('step').filter((e) => e.who === gob.idx).map((e) => e.ft)).toEqual([5, 5, 10]);
  });

  it('a walk stops when the mover learns of a hidden zone on the way, and hands its movement back', () => {
    for (const flag of [true, false]) {
      const w = scene({ units: [PC(), GOB('gob', 'M4', { ...DUMMY, speedFt: 60 })], keys: ['place:G4'], flags: { hiddenHazardRevealedByDamage: flag } });
      w.begin(w.u('pc'));
      w.choose(w.u('pc'), 'cast:spikes@2');
      const gob = w.u('gob');
      w.zoneOf('spikes').seen![gob.idx] = 0;
      w.begin(gob);
      w.walk(gob, ['L4', 'K4', 'J4', 'I4']);
      // J4 is the first spiked square: the damage there teaches it, and it stops on J4.
      expect(w.ev('moveEnd').at(-1)).toMatchObject({ who: gob.idx, why: 'learned', steps: 3, planned: 4 });
      expect(w.ev('damage').filter((e) => e.tgt === gob.idx).length).toBe(1);
      expect(gob.b.moveFt).toBe(40); // 5 + 5 + 10 spent, the rest is its decider's again
      // Nothing new to learn on the next walk: under false it is still hurt-only (seen 2), and walks on.
      w.walk(gob, ['I4', 'H4']);
      expect(w.ev('moveEnd').at(-1)).toMatchObject({ who: gob.idx, why: 'arrived' });
    }
  });

  it('a walk planned without a hidden zone steps into an ally only if it can still reach a free square; refused on the first step, that square leaves its routes (no endless re-pick)', () => {
    // gob (15 ft) at M4, allies on L4 and K4, the spikes on D..J of row 4. Unknowing, L4-K4-J4 is 15 ft;
    // truly J4 is a 10-ft step, so 20 ft: it can't get past the allies, and would end on K4.
    const w = scene({ units: [PC(), GOB('gob', 'M4', { ...DUMMY, speedFt: 15 }), GOB('a1', 'L4'), GOB('a2', 'K4')], keys: ['place:G4'] });
    w.begin(w.u('pc'));
    w.choose(w.u('pc'), 'cast:spikes@2');
    const gob = w.u('gob');
    w.zoneOf('spikes').seen![gob.idx] = 0;
    w.begin(gob);
    const at = gob.cell;
    w.walk(gob, ['L4', 'K4', 'J4']);
    expect(w.ev('moveEnd').at(-1)).toMatchObject({ who: gob.idx, why: 'blocked', steps: 0 });
    expect(gob.cell).toBe(at);
    // Its movement is kept and other moves stay open; only routes through L4 from here are gone
    // (else its decider picks the same move again forever: bench, 2026-11-10; walker review).
    expect(gob.b.moveFt).toBe(15);
    const moves = w.keysOf(gob).filter((k) => k.startsWith('move:'));
    expect(moves.length).toBeGreaterThan(0);
    expect(moves.some((k) => k.startsWith('move:L4/') || k.startsWith('move:K4/'))).toBe(false);
  });

  it('a first step onto a free square that truly costs more than planned does not leave the same move offered', () => {
    for (const flag of [true, false]) {
      const w = scene({ units: [PC(), GOB('gob', 'K4')], keys: ['place:G4'], flags: { hiddenHazardRevealedByDamage: flag } });
      w.begin(w.u('pc'));
      w.choose(w.u('pc'), 'cast:spikes@2');
      const gob = w.u('gob');
      w.zoneOf('spikes').seen![gob.idx] = 0;
      w.begin(gob);
      gob.b.moveFt = 5;
      w.walk(gob, ['J4']);
      expect(w.ev('moveEnd').at(-1)).toMatchObject({ why: 'blocked', steps: 0 });
      expect(w.keysOf(gob).filter((k) => k.startsWith('move:J4/'))).toEqual([]);
    }
  });

  it('a mover refused on its first step from a square it shares keeps every other move off it', () => {
    const w = scene({ units: [PC(), GOB('gob', 'M4', { ...DUMMY, speedFt: 15 }), GOB('a0', 'N6'), GOB('a1', 'L4'), GOB('a2', 'K4')], keys: ['place:G4'] });
    w.begin(w.u('pc'));
    w.choose(w.u('pc'), 'cast:spikes@2');
    const gob = w.u('gob');
    w.zoneOf('spikes').seen![gob.idx] = 0;
    w.begin(gob);
    w.u('a0').cell = gob.cell; // gob starts on a square it shares (it was downed there, say)
    const before = w.keysOf(gob).filter((k) => k.startsWith('move:')).length;
    w.walk(gob, ['L4', 'K4', 'J4']);
    expect(w.ev('moveEnd').at(-1)).toMatchObject({ why: 'blocked', steps: 0 });
    expect(gob.b.moveFt).toBe(15);
    expect(w.keysOf(gob).filter((k) => k.startsWith('move:')).length).toBeGreaterThan(0);
    expect(before).toBeGreaterThan(0);
  });

  it('the occupied-step lookahead advances diagonal parity past each occupied square (alternate diagonals)', () => {
    const w = scene({ w: 26, units: [PC(), GOB('gob', 'B2', { ...DUMMY, speedFt: 20 }), GOB('a1', 'C3'), GOB('a2', 'D4')], keys: ['place:W4'], flags: { diagonalCost: 'alternate' } });
    w.begin(w.u('pc'));
    w.choose(w.u('pc'), 'cast:spikes@2');
    const gob = w.u('gob');
    w.zoneOf('spikes').seen![gob.idx] = 0;
    w.begin(gob);
    gob.b.diagParity = 0;
    w.walk(gob, ['C3', 'D4', 'E5']);
    expect(w.ev('moveEnd').at(-1)).toMatchObject({ who: gob.idx, why: 'arrived', steps: 3 });
    expect(w.ev('step').filter((e) => e.who === gob.idx).map((e) => e.ft)).toEqual([5, 10, 5]);
  });

  it('a hidden zone that ends mid-walk teaches nothing: the walk goes on', () => {
    // The caster's own Spike Growth ends as it walks (it knew the zone from the start: seen 1).
    const w = scene({ units: [PC(), GOB('gob', 'M4')], keys: ['place:G4'] });
    w.begin(w.u('pc'));
    w.choose(w.u('pc'), 'cast:spikes@2');
    const pc = w.u('pc');
    const z = w.zoneOf('spikes');
    w.begin(pc);
    const steps = ['B4', 'C4', 'C5'];
    // End the zone once its first step lands (as a broken concentration would, mid-walk).
    const sink = w.cx.sink as ArraySink;
    const emit = sink.emit.bind(sink);
    let ended = false;
    sink.emit = (e: GameEvent) => {
      emit(e);
      if (!ended && e.k === 'step' && e.who === pc.idx && e.to === parseCell('B4', w.s.w, w.s.h)) {
        ended = true;
        z.alive = false;
        w.cx.st.zoneFx[z.zbit] = -1;
      }
    };
    w.walk(pc, steps);
    expect(ended).toBe(true);
    expect(w.ev('moveEnd').at(-1)).toMatchObject({ who: pc.idx, why: 'arrived', steps: 3 });
  });

  it('hurt but not recognized (hiddenHazardRevealedByDamage=false, seen 2) is not known for routing; a Search that finds it is', () => {
    const w = scene({ units: [PC(zoneCaster(1)), GOB('gob', 'M4')], keys: ['place:G4'], flags: { hiddenHazardRevealedByDamage: false } });
    w.begin(w.u('pc'));
    w.choose(w.u('pc'), 'cast:spikes@2');
    const gob = w.u('gob');
    const z = w.zoneOf('spikes');
    z.seen![gob.idx] = 2;
    w.begin(gob);
    expect(knownZones(w.cx.st, gob) & (1 << z.zbit)).toBe(0);
    expect(hazardMoves(w.keysOf(gob))).toEqual([]);
    w.choose(gob, 'search');
    expect(z.seen![gob.idx]).toBe(1);
    expect(hazardMoves(w.keysOf(gob)).length).toBeGreaterThan(0);
  });

  it('witnessing a hidden zone at cast: a dead, Incapacitated or Blinded creature with the area in sight did not see it', () => {
    const w = scene({ units: [PC(), GOB('up', 'M2'), GOB('dead', 'M4'), GOB('incap', 'M6'), GOB('blind', 'N4')], keys: ['place:G4'] });
    w.u('dead').life = 'dead';
    w.u('incap').condMask |= COND.incapacitated;
    w.u('blind').condMask |= COND.blinded;
    w.begin(w.u('pc'));
    w.choose(w.u('pc'), 'cast:spikes@2');
    const z = w.zoneOf('spikes');
    expect(['up', 'dead', 'incap', 'blind'].map((k) => z.seen![w.u(k).idx])).toEqual([1, 0, 0, 0]);
  });

  it('who saw it appear: sight of the area for a hidden zone, sight of the caster for any other', () => {
    // A wall down B with a gap on row 4: gob on C1 sees the squares round G4 but not the caster on A4.
    const terrain = ['.#............', '.#............', '.#............', '..............', '.#............', '.#............', '.#............'];
    const seenAt = (spell: string) => {
      const w = scene({ units: [PC(), GOB('gob', 'C1')], keys: ['place:G4'], terrain });
      w.begin(w.u('pc'));
      w.choose(w.u('pc'), `cast:${spell}@2`);
      return w.zoneOf(spell).seen![w.u('gob').idx];
    };
    expect(seenAt('spikes')).toBe(1);
    expect(seenAt('beam')).toBe(0);
  });

  it('a Blinded creature learns no visible zone by sight', () => {
    const w = scene({ units: [PC(), GOB('gob', 'M4')], keys: ['place:G4'] });
    w.begin(w.u('pc'));
    w.choose(w.u('pc'), 'cast:beam@2');
    const gob = w.u('gob');
    const beam = w.zoneOf('beam');
    beam.seen![gob.idx] = 0;
    expect(knownZones(w.cx.st, gob) & (1 << beam.zbit)).not.toBe(0);
    gob.condMask |= COND.blinded;
    expect(knownZones(w.cx.st, gob) & (1 << beam.zbit)).toBe(0);
  });

  it('all and none keep their meaning: every zone, or only its own, hidden or not', () => {
    const modes = (['all', 'none'] as const).map((mode) => {
      const w = scene({ units: [PC(), GOB('gob', 'M4')], keys: ['place:G4'], flags: { zoneKnowledge: mode } });
      w.begin(w.u('pc'));
      w.choose(w.u('pc'), 'cast:spikes@2');
      w.zoneOf('spikes').seen![w.u('gob').idx] = 0;
      return [knownZones(w.cx.st, w.u('gob')), knownZones(w.cx.st, w.u('pc')) & (1 << w.zoneOf('spikes').zbit)];
    });
    expect(modes[0]![0]).toBe(-1);
    expect(modes[1]![0]).toBe(0);
    expect(modes[1]![1]).not.toBe(0); // its own, under none
  });
});

describe('the Search action', () => {
  const searchScene = (dc: number) => {
    const w = scene({ units: [PC(zoneCaster(dc)), GOB('gob', 'M4')], keys: ['place:G4'] });
    w.begin(w.u('pc'));
    w.choose(w.u('pc'), 'cast:spikes@2');
    const gob = w.u('gob');
    w.zoneOf('spikes').seen![gob.idx] = 0;
    w.begin(gob);
    return { ...w, gob };
  };

  it('is offered only while a hidden zone it has not recognized is live', () => {
    const w = searchScene(13);
    expect(w.keysOf(w.gob)).toContain('search');
    expect(w.keysOf(w.u('pc'))).not.toContain('search'); // its own zone
    w.zoneOf('spikes').seen![w.gob.idx] = 1;
    expect(w.keysOf(w.gob)).not.toContain('search');
  });

  it('success sets seen (in stateHash), logs the reveal, and changes the routes it is offered', () => {
    const w = searchScene(1); // any roll meets it (WIS 10, no penalty)
    const before = hazardMoves(w.keysOf(w.gob));
    const h0 = stateHash(w.cx.st);
    w.choose(w.gob, 'search');
    expect(w.zoneOf('spikes').seen![w.gob.idx]).toBe(1);
    expect(w.ev('reveal')).toEqual([expect.objectContaining({ who: w.gob.idx, how: 'search' })]);
    // A monster's check is its plain WIS (a stat block's skills aren't modeled): logged as one, and searchSkill isn't read.
    expect(w.ev('save').at(-1)).toMatchObject({ via: 'core:search', purpose: 'check', dc: 1, ok: true, key: 'check.wis' });
    expect(w.gob.b.action).toBe(0);
    expect(stateHash(w.cx.st)).not.toBe(h0);
    expect(before).toEqual([]);
    expect(hazardMoves(w.keysOf(w.gob)).length).toBeGreaterThan(0); // its routes now count the spikes
    expect(w.cx.st.flagsUsed[flagIndex('searchSkill')]).toBe(0);
  });

  it('a failed check leaves it unknown', () => {
    const w = searchScene(99);
    w.choose(w.gob, 'search');
    expect(w.zoneOf('spikes').seen![w.gob.idx]).toBe(0);
    expect(w.ev('reveal')).toEqual([]);
  });

  it('the DC is bound into the zone at cast: a later change to its caster does not move it', () => {
    const w = searchScene(1);
    const z = w.zoneOf('spikes');
    expect(z.hdc).toBe(1);
    // The caster's DC changes after the cast (a new template, as a form or an item could give it).
    const pc = w.u('pc');
    const raised = { ...pc.tpl, effects: pc.tpl.effects.map((e) => (e.local === 'spikes' ? { ...e, hiddenDc: 99 } : e)) };
    (pc as { tpl: CompiledTemplate }).tpl = raised;
    w.choose(w.gob, 'search');
    expect(z.seen![w.gob.idx]).toBe(1);
    expect(w.ev('save').at(-1)!.dc).toBe(1); // the check is logged against the bound DC too
  });

  it('finds only what it can see: a hidden zone behind a wall stays hidden, and no check is rolled', () => {
    // A wall between gob (M4) and every square of the spikes on G4 (sim-zones' beam wall, extended).
    const terrain = ['..........#...', '..........#...', '..........#...', '..........#...', '..........#...', '..........#...', '..........#...'];
    const w = scene({ units: [PC(zoneCaster(1)), GOB('gob', 'M4')], keys: ['place:G4'], terrain });
    w.begin(w.u('pc'));
    w.choose(w.u('pc'), 'cast:spikes@2');
    const gob = w.u('gob');
    const z = w.zoneOf('spikes');
    expect(z.seen![gob.idx]).toBe(0); // it couldn't see the area appear
    w.begin(gob);
    w.choose(gob, 'search');
    expect(z.seen![gob.idx]).toBe(0);
    expect(w.ev('save').filter((e) => e.via === 'core:search')).toEqual([]);
    expect(gob.b.action).toBe(0); // the action is spent all the same
  });

  it('the bound DC is in stateHash', () => {
    const w = searchScene(13);
    const h0 = stateHash(w.cx.st);
    (w.zoneOf('spikes') as { hdc: number }).hdc = 14;
    expect(stateHash(w.cx.st)).not.toBe(h0);
  });

  it('searchSkill: best uses the better of Perception and Survival; perception only Perception', () => {
    const skillMod = new Array<number>(18).fill(0);
    skillMod[skillIndex('survival')] = 6;
    const scout: CompiledTemplate = { ...caster({}), id: 'test:scout' as CompiledTemplate['id'], speedFt: 30, skillMod };
    const keyUnder = (mode: 'best' | 'perception') => {
      const w = scene({ units: [PC(zoneCaster(1)), { seat: 'scout', team: 1 as const, tpl: scout, at: 'M4' }], keys: ['place:G4'], flags: { searchSkill: mode } });
      w.begin(w.u('pc'));
      w.choose(w.u('pc'), 'cast:spikes@2');
      const sc = w.u('scout');
      w.zoneOf('spikes').seen![sc.idx] = 0;
      w.begin(sc);
      w.choose(sc, 'search');
      return w.ev('save').at(-1)!.key;
    };
    expect(keyUnder('best')).toBe('check.wis.survival');
    expect(keyUnder('perception')).toBe('check.wis.perception');
  });

  it('the AI reads searchSkill too: a Survival-only searcher\'s odds fall under perception', () => {
    const skillMod = new Array<number>(18).fill(0);
    skillMod[skillIndex('survival')] = 6;
    const scout: CompiledTemplate = { ...caster({}), id: 'test:scout' as CompiledTemplate['id'], speedFt: 30, skillMod };
    const pOf = (mode: 'best' | 'perception') => {
      // The demo's shape: the caster on the spikes' near edge (D8, the spikes on G8), the scout 12 squares off.
      const units = [{ ...PC(zoneCaster(15)), at: 'D8' }, { seat: 'scout', team: 1 as const, tpl: scout, at: 'P8' }, GOB('ally', 'P10')];
      const w = scene({ units, w: 20, h: 15, keys: ['place:G8'], flags: { searchSkill: mode, hiddenHazardRevealedByDamage: false } });
      w.begin(w.u('pc'));
      w.choose(w.u('pc'), 'cast:spikes@2');
      const sc = w.u('scout');
      w.zoneOf('spikes').seen![sc.idx] = 0; // the ally saw it: a reason
      w.begin(sc);
      return searchValue(w.cx.st, sc, w.cx.views[sc.idx]!.scratch.reach, DEFAULT_WEIGHTS.perFoot)!.p;
    };
    expect(pOf('best')).toBeCloseTo(0.6, 10); // d20 + 6 >= 15
    expect(pOf('perception')).toBeCloseTo(0.3, 10); // d20 + 0 >= 15
  });

  it('two hidden zones with different DCs: one roll, each zone met against its own DC', () => {
    const twin = (dcA: number | null, dcB: number | null) => {
      const pcA = { seat: 'pa', team: 0 as const, tpl: zoneCaster(13), at: 'A2' };
      const pcB = { seat: 'pb', team: 0 as const, tpl: zoneCaster(13), at: 'A6' };
      const w = scene({ units: [pcA, pcB, GOB('gob', 'M4')], keys: ['place:G2', 'place:G6'] });
      w.begin(w.u('pa'));
      w.choose(w.u('pa'), 'cast:spikes@2');
      w.begin(w.u('pb'));
      w.choose(w.u('pb'), 'cast:spikes@2');
      const gob = w.u('gob');
      const zs = w.cx.st.fx.filter((f) => f.zbit >= 0).sort((a, b) => a.zbit - b.zbit);
      for (const z of zs) z.seen![gob.idx] = 0;
      if (dcA !== null) (zs[0] as { hdc: number }).hdc = dcA;
      if (dcB !== null) (zs[1] as { hdc: number }).hdc = dcB;
      w.begin(gob);
      w.choose(gob, 'search');
      return { total: w.ev('save').at(-1)!.total, seen: zs.map((z) => z.seen![gob.idx]) };
    };
    const t = twin(null, null).total; // the roll is the same whatever the DCs (same seed, same order)
    // The lower slot's DC is the roll's own: one zone just over the total, the other just met.
    expect(twin(t + 1, t).seen).toEqual([0, 1]);
    expect(twin(t, t + 1).seen).toEqual([1, 0]);
  });

  it('an Incapacitated creature is offered no Search', () => {
    const w = searchScene(13);
    w.gob.condMask |= COND.incapacitated;
    expect(w.keysOf(w.gob)).not.toContain('search');
  });

  it('a Blinded creature finds nothing: no roll, nothing recognized, the action spent', () => {
    const w = searchScene(1);
    w.gob.condMask |= COND.blinded;
    w.choose(w.gob, 'search');
    expect(w.zoneOf('spikes').seen![w.gob.idx]).toBe(0);
    expect(w.ev('save').filter((e) => e.via === 'core:search')).toEqual([]);
    expect(w.gob.b.action).toBe(0);
  });
});

describe('hiddenHazardRevealedByDamage and hiddenHazardPartialViewCountsAsSeen', () => {
  const hurt = (flag: boolean) => {
    const w = scene({ units: [PC(), GOB('gob', 'M4')], keys: ['place:G4'], flags: { hiddenHazardRevealedByDamage: flag } });
    w.begin(w.u('pc'));
    w.choose(w.u('pc'), 'cast:spikes@2');
    const gob = w.u('gob');
    const z = w.zoneOf('spikes');
    z.seen![gob.idx] = 0;
    w.begin(gob);
    w.walk(gob, ['M4', 'L4', 'K4', 'J4', 'I4']);
    return { seen: z.seen![gob.idx], reveals: w.ev('reveal'), read: w.cx.st.flagsUsed[flagIndex('hiddenHazardRevealedByDamage')] };
  };

  it('on: the damage reveals it; off (default): it only marks the zone as having hurt it (a reason to Search)', () => {
    const on = hurt(true);
    expect(on.seen).toBe(1);
    expect(on.reveals).toEqual([expect.objectContaining({ how: 'damage' })]);
    expect(on.read).toBe(1);
    const off = hurt(false);
    expect(off.seen).toBe(2);
    expect(off.reveals).toEqual([]);
  });

  it('a creature that saw part of the area at cast saw it under true, not under false; one that saw all or none never reads the flag', () => {
    // A wall that hides the zone's lower rows from gob (at M1) but not its upper rows.
    const terrain = ['..............', '..............', '..............', '..........####', '..............', '..............', '..............'];
    const witness = (flag: boolean) => {
      const w = scene({ units: [PC(), GOB('gob', 'M1'), GOB('far', 'M7')], keys: ['place:G4'], terrain, flags: { hiddenHazardPartialViewCountsAsSeen: flag } });
      w.begin(w.u('pc'));
      w.choose(w.u('pc'), 'cast:spikes@2');
      const z = w.zoneOf('spikes');
      return { gob: z.seen![w.u('gob').idx], pc: z.seen![w.u('pc').idx], read: w.cx.st.flagsUsed[flagIndex('hiddenHazardPartialViewCountsAsSeen')] };
    };
    const t = witness(true);
    const f = witness(false);
    expect([t.gob, f.gob]).toEqual([1, 0]);
    expect([t.pc, f.pc]).toEqual([1, 1]); // the caster always knows
    expect(t.read).toBe(1);
    // Open map: everyone sees every square, so nothing is read.
    const w = scene({ units: [PC(), GOB('gob', 'M4')], keys: ['place:G4'] });
    w.begin(w.u('pc'));
    w.choose(w.u('pc'), 'cast:spikes@2');
    expect(w.zoneOf('spikes').seen![w.u('gob').idx]).toBe(1);
    expect(w.cx.st.flagsUsed[flagIndex('hiddenHazardPartialViewCountsAsSeen')]).toBe(0);
  });
});

// ---- content and greedy: the repo packs ----

const ROOT = join(import.meta.dirname, '..', '..', '..');
const walkDir = (d: string): string[] =>
  readdirSync(d)
    .flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walkDir(p) : p.endsWith('.yaml') ? [p] : [];
    })
    .sort();
const readPack = (name: string): SourceFile[] => walkDir(join(ROOT, 'packs', name)).map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, 'utf8') }));
const CONTENT = (() => {
  const r = loadContent([...readPack('srd-5.2.1'), ...readPack('test')]);
  if (!r.content) throw new Error(r.errors.map(formatDiag).join('\n'));
  return r.content;
})();

/** The search-reveals-spikes map: open, 22 x 17. */
const OPEN = new Array<string>(17).fill('......................');
/** A wall down R (rows 1-16, a gap on row 17): wolf1 on T9 sees no square of the spikes. */
const WALL_R = [...new Array<string>(16).fill('.................#....'), '......................'];

function greedyScene(units: { seat: string; team: string; use: string; at: string; precast?: unknown[] }[], terrain = OPEN, flags: Partial<RuleFlags> = { hiddenHazardRevealedByDamage: false }) {
  const doc = {
    kind: 'scenario', id: 'hidden', name: 'Hidden', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: { w: terrain[0]!.length, h: terrain.length, terrain },
    flags: { initiativeMode: 'static', ...flags }, knobs: { downEnds: false }, units: units.map((u) => ({ ...u, decider: 'greedy' })),
  };
  const res = resolveScenario(doc, 'hidden.yaml', CONTENT);
  if (!res.setup) throw new Error(res.errors.map(formatDiag).join('\n'));
  const s = res.setup;
  const ds = s.seats.map(() => new GreedyDecider(DEFAULT_WEIGHTS));
  const sink = new ArraySink();
  const cx = createContext(s, 1, 0, ds, sink);
  applyPassives(cx, -1);
  runPrecasts(cx, -1);
  const records: ExplainRecord[] = [];
  for (const d of ds) d.explainTo((x) => records.push(x));
  const u = (seat: string): Unit => cx.st.units.find((x) => x.seat === seat)!;
  cx.st.round = 1;
  const begin = (who: Unit) => {
    cx.st.active = who.idx;
    cx.st.turnIdx++;
    who.turns++;
    Object.assign(who.b, { action: 1, bonus: 1, reaction: 1, freeObj: 1, moveFt: who.tpl.speedFt, atkActive: false, movedFt: 0 });
  };
  const decide = (who: Unit): { key: string; rec: ExplainRecord | undefined } => {
    const list = listOptions(cx, who, takeList(cx));
    const items: Legal[] = [];
    const keys: string[] = [];
    for (let i = 0; i < list.n; i++) {
      keys.push(legalKey(cx.st, who.idx, list.items[i]!));
      items.push(copyLegal(list.items[i]!, newLegal()));
    }
    releaseList(cx, list);
    const dp: DecisionPoint = { k: 'turn', who: who.idx, at: 0, round: 1, cause: -1, legal: { n: items.length, items }, keyOf: (i) => keys[i]! };
    records.length = 0;
    const i = ds[who.idx]!.decide(cx.views[who.idx]!, dp);
    if (keys[i] !== 'search') {
      // carry the choice out, so a test can read what it did
      resolveOption(cx, who, items[i]!, -1);
    }
    return { key: keys[i]!, rec: records.at(-1) };
  };
  return { cx, s, u, begin, decide, sink, ds };
}

/** The demo's setup: pc1 on G9 behind Spike Growth on K9 (DC 15), the wolves on T9 and T11. */
const SPIKES_AT_K9 = (seenBy: string[]) => [{ cast: 'srd:spike-growth', level: 2, at: 'K9', seenBy }];
const wolves = (seenBy: string[]) => [
  { seat: 'pc1', team: 'party', use: 'test:sample-druid', at: 'G9', precast: SPIKES_AT_K9(seenBy) },
  { seat: 'wolf1', team: 'enemies', use: 'srd:wolf', at: 'T9' },
  { seat: 'wolf2', team: 'enemies', use: 'srd:wolf', at: 'T11' },
];

describe('greedy fights with an unknown hidden zone never run a turn away (walker review, 2026-11-10)', () => {
  // A Guard 5 ft short of what its plan priced kept re-picking a refused first step until the
  // 256-decision guard; the refused square now leaves its routes for the turn (walker.ts refuseFirst).
  it('a Guard closing on a druid behind Spike Growth it did not see: no RunawayTurn, both flags, three starts', () => {
    const out: string[] = [];
    for (const flag of [true, false])
      for (const at of ['P3', 'P5', 'P7']) {
        const doc = {
          kind: 'scenario', id: 'runaway', name: 'Runaway', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: { w: 22, h: 17, terrain: OPEN },
          flags: { initiativeMode: 'static', hiddenHazardRevealedByDamage: flag }, knobs: { downEnds: false },
          units: [
            { seat: 'pc1', team: 'party', use: 'test:sample-druid', at: 'G9', precast: SPIKES_AT_K9(['pc1']), decider: 'greedy' },
            { seat: 'wolf1', team: 'enemies', use: 'srd:guard', at, decider: 'greedy' },
          ],
        };
        const res = resolveScenario(doc, 'runaway.yaml', CONTENT);
        if (!res.setup) throw new Error(res.errors.map(formatDiag).join('\n'));
        const ds = res.setup.seats.map(() => new GreedyDecider(DEFAULT_WEIGHTS));
        try {
          runFight(res.setup, 1, 0, ds, null);
        } catch (e) {
          out.push(`${flag} ${at}: ${(e as Error).message}`);
        }
      }
    expect(out).toEqual([]);
  });

  // The walker review's sweep (sim-props uses random-legal deciders, which never re-pick a refused
  // move, so only greedy fights can show a runaway): a druid and a fighter against 2-4 random wolves,
  // goblin warriors and guards behind Spike Growth they didn't see; both flag values, both diagonal
  // rules. 40 seeds each in the fast suite, 500 under MONTECRIT_SLOW (2,000 fights; 21 runaways before).
  it('a sweep of greedy fights behind unknown Spike Growth: no RunawayTurn', { timeout: 900_000 }, () => {
    const pool = ['srd:wolf', 'srd:goblin-warrior', 'srd:guard'];
    const n = process.env.MONTECRIT_SLOW ? 500 : 40;
    const bad: string[] = [];
    for (const flag of [true, false])
      for (const diag of ['uniform', 'alternate'] as const)
        for (let seed = 1; seed <= n; seed++) {
          let r = (seed * 2654435761) >>> 0;
          const rnd = (k: number) => {
            r = (r * 1103515245 + 12345) >>> 0;
            return (r >>> 8) % k;
          };
          const ne = 2 + rnd(3);
          const units: Record<string, unknown>[] = [
            { seat: 'pc1', team: 'party', use: 'test:sample-druid', at: 'G9', precast: SPIKES_AT_K9(['pc1']), decider: 'greedy' },
            { seat: 'pc2', team: 'party', use: 'test:sample-fighter', at: 'G7', decider: 'greedy' },
          ];
          for (let i = 0; i < ne; i++) units.push({ seat: `e${i}`, team: 'enemies', use: pool[rnd(3)], at: `${'PQRST'[rnd(5)]}${2 + i * 3 + rnd(2)}`, decider: 'greedy' });
          const doc = {
            kind: 'scenario', id: 'sweep', name: 'Sweep', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: { w: 22, h: 17, terrain: OPEN },
            flags: { initiativeMode: 'roll', hiddenHazardRevealedByDamage: flag, diagonalCost: diag }, knobs: { downEnds: false }, units,
          };
          const res = resolveScenario(doc, 'sweep.yaml', CONTENT);
          if (!res.setup) throw new Error(res.errors.map(formatDiag).join('\n'));
          const ds = res.setup.seats.map(() => new GreedyDecider(DEFAULT_WEIGHTS));
          try {
            runFight(res.setup, seed, 0, ds, null);
          } catch (e) {
            bad.push(`${flag} ${diag} ${seed}: ${(e as Error).message}`);
          }
        }
    expect(bad).toEqual([]);
  });
});

describe('content: hidden on Spike Growth', () => {
  it('srd:spike-growth compiles with its Search DC bound to the caster\'s spell save DC, and is full', () => {
    const w = greedyScene(wolves(['pc1']));
    const z = w.cx.st.fx.find((f) => f.zbit >= 0)!;
    const druid = w.u('pc1');
    const dc = druid.tpl.spells.find((e) => e.spell.id === 'srd:spike-growth')!.dc;
    expect(dc).toBe(15);
    expect(z.hdc).toBe(dc);
    const sp = druid.tpl.spells.find((e) => e.spell.id === 'srd:spike-growth')!.spell;
    expect([sp.fidelity, sp.unimplemented]).toEqual(['full', []]);
  });

  it('the schema takes hidden only on a zone', () => {
    expect(EffectSchema.safeParse({ id: 'x', name: 'X', hidden: { dc: 'caster' } }).success).toBe(false);
    expect(EffectSchema.safeParse({ id: 'x', name: 'X', zone: { shape: 'sphere', radius: 20 }, hidden: { dc: 'caster' } }).success).toBe(true);
  });
});

describe('greedy v9: Search is worth P(success) x the hazard its next path avoids, only with a reason it can know', () => {
  // These run under hiddenHazardRevealedByDamage=false (greedyScene's default here): not knowing then
  // costs the whole walk through. Under the default true it costs one hazard step (the walk stops there).
  const sv = (w: ReturnType<typeof greedyScene>, seat: string) => {
    const u = w.u(seat);
    return searchValue(w.cx.st, u, w.cx.views[u.idx]!.scratch.reach, DEFAULT_WEIGHTS.perFoot);
  };

  it('no reason (no witness ally, no damage taken): no value, and it Dashes instead', () => {
    const w = greedyScene(wolves(['pc1']));
    const wolf = w.u('wolf1');
    w.begin(wolf);
    expect(sv(w, 'wolf1')).toBeNull();
    expect(w.decide(wolf).key).toBe('opt:dash');
  });

  it('a witness ally: P(plain WIS +1 vs DC 15) 0.35 x what not knowing costs over the walk round, and it Searches, with its Explain line', () => {
    const w = greedyScene(wolves(['pc1', 'wolf2']));
    const wolf = w.u('wolf1');
    w.begin(wolf);
    const s = sv(w, 'wolf1')!;
    expect(s.why).toBe('ally');
    expect(s.p).toBeCloseTo(0.35, 10);
    // Unknowing it plans a 12-step line that crosses 3 spiked squares: 75 true feet x 0.01 + 3 x 5 = 15.75;
    // knowing, the cheapest route round costs 70 ft x 0.01 = 0.70. 15.75 - 0.70 = 15.05.
    expect(s.avoided).toBeCloseTo(15.05, 6);
    const r = w.decide(wolf);
    expect(r.key).toBe('search');
    expect(r.rec!.top[0]!.parts[0]!.term).toMatch(/^Search: P\(it recognizes the hidden zone\)/);
    expect(r.rec!.top[0]!.parts[0]!.ev).toBeCloseTo(0.35 * 15.05, 6);
  });

  it('under hiddenHazardRevealedByDamage=true not knowing costs at most one hazard step, so it Dashes', () => {
    const w = greedyScene(wolves(['pc1', 'wolf2']), OPEN, { hiddenHazardRevealedByDamage: true });
    const wolf = w.u('wolf1');
    w.begin(wolf);
    expect(sv(w, 'wolf1')!.avoided).toBe(5);
    expect(w.decide(wolf).key).toBe('opt:dash');
  });

  it('only under zoneKnowledge sawCast: under all or none a recognized zone changes no route', () => {
    for (const zk of ['all', 'none'] as const) {
      const w = greedyScene(wolves(['pc1', 'wolf2']), OPEN, { hiddenHazardRevealedByDamage: false, zoneKnowledge: zk });
      w.begin(w.u('wolf1'));
      expect(sv(w, 'wolf1')).toBeNull();
    }
    // A chokepoint (a wall down L, gaps at L1 under the spikes and L17): the line through the spikes is
    // the shortest route even counting their Difficult Terrain, so only the gate keeps none at null.
    const WALL_L = ['......................', ...new Array<string>(15).fill('...........#..........'), '......................'];
    const choke = [
      { seat: 'pc1', team: 'party', use: 'test:sample-druid', at: 'C1', precast: [{ cast: 'srd:spike-growth', level: 2, at: 'L1', seenBy: ['pc1', 'wolf2'] }] },
      { seat: 'wolf1', team: 'enemies', use: 'srd:wolf', at: 'T1' },
      { seat: 'wolf2', team: 'enemies', use: 'srd:wolf', at: 'T3' },
    ];
    const at = (zk: 'sawCast' | 'none') => {
      const w = greedyScene(choke, WALL_L, { hiddenHazardRevealedByDamage: false, zoneKnowledge: zk });
      w.begin(w.u('wolf1'));
      return sv(w, 'wolf1');
    };
    expect(at('sawCast')).not.toBeNull();
    expect(at('none')).toBeNull();
  });

  it('nothing in sight to find: a reason, but every square of the zone behind a wall, is no value', () => {
    const w = greedyScene(wolves(['pc1', 'wolf2']), WALL_R);
    w.begin(w.u('wolf1'));
    expect(sv(w, 'wolf1')).toBeNull();
  });

  it('a Blinded creature has no Search value', () => {
    const w = greedyScene(wolves(['pc1', 'wolf2']));
    const wolf = w.u('wolf1');
    w.begin(wolf);
    wolf.condMask |= COND.blinded;
    expect(sv(w, 'wolf1')).toBeNull();
  });

  it('its exposure where it stands counts against the Search: two archers in range tip it back to the Dash', () => {
    const archers = (n: number) => {
      const units = [...wolves(['pc1', 'wolf2'])];
      for (let i = 0; i < n; i++) units.push({ seat: `arch${i}`, team: 'party', use: 'test:sniper', at: `AH${9 + i}` });
      const w = greedyScene(units, new Array<string>(17).fill('.'.repeat(36)));
      const wolf = w.u('wolf1');
      w.begin(wolf);
      return { value: sv(w, 'wolf1')!.value, key: w.decide(wolf).key };
    };
    const one = archers(1);
    const two = archers(2);
    expect(one.value).toBeCloseTo(two.value, 10); // the same Search: only the exposure differs
    expect([one.key, two.key]).toEqual(['search', 'opt:dash']);
  });

  it('a PC Searches through the turn options too (not only a monster\'s Dash-first branch)', () => {
    const w = greedyScene(
      [
        { seat: 'pc1', team: 'party', use: 'test:sample-druid', at: 'A1', precast: [{ cast: 'srd:spike-growth', level: 2, at: 'F9', seenBy: ['pc1'] }] },
        { seat: 'pc2', team: 'party', use: 'test:sample-fighter', at: 'Z9' },
        { seat: 'wolf1', team: 'enemies', use: 'srd:wolf', at: 'B9' },
      ],
      new Array<string>(17).fill('.'.repeat(26)),
    );
    const pc2 = w.u('pc2');
    w.begin(pc2);
    expect(sv(w, 'pc2')?.why).toBe('ally'); // pc1 cast it
    expect(w.decide(pc2).key).toBe('search');
  });

  it('its own hurt (hiddenHazardRevealedByDamage=false): the damage is a reason; a witness that is down is not', () => {
    const w = greedyScene(wolves(['pc1']));
    const wolf = w.u('wolf1');
    const z = w.cx.st.fx.find((f) => f.zbit >= 0)!;
    z.seen![wolf.idx] = 2;
    w.begin(wolf);
    expect(sv(w, 'wolf1')?.why).toBe('hurt');
    z.seen![wolf.idx] = 0;
    z.seen![w.u('wolf2').idx] = 1;
    w.u('wolf2').life = 'dead';
    expect(sv(w, 'wolf1')).toBeNull();
  });

  it('a pick family for Search only on a setup with a hidden zone', () => {
    const withSpikes = greedyScene(wolves(['pc1']));
    const L = buildCounterLayout(withSpikes.s);
    expect(L.searchOff[withSpikes.u('wolf1').idx]).toBeGreaterThanOrEqual(0);
    const noSpikes = greedyScene([
      { seat: 'pc1', team: 'party', use: 'test:sample-fighter', at: 'G9' },
      { seat: 'wolf1', team: 'enemies', use: 'srd:wolf', at: 'T9' },
    ]);
    expect([...buildCounterLayout(noSpikes.s).searchOff]).toEqual([-1, -1]);
  });

  it('a visible zone a non-witness can see turns its walk: it goes round a Moonbeam it never saw cast', () => {
    // pc1 at A4, the beam on F4 (seen by pc1 only), the wolf at J4: its 40 ft walk west passes F4 unless it knows.
    const row = '..........';
    const terrain = [row, row, row, row, row, row, row];
    const units = [
      { seat: 'pc1', team: 'party', use: 'test:sample-druid', at: 'A4', precast: [{ cast: 'srd:moonbeam', level: 2, at: 'F4', seenBy: ['pc1'] }] },
      { seat: 'wolf1', team: 'enemies', use: 'srd:wolf', at: 'J4' },
    ];
    const doc = { kind: 'scenario', id: 'beam', name: 'Beam', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: { w: 10, h: 7, terrain }, flags: { initiativeMode: 'static' }, knobs: { downEnds: false }, units: units.map((u) => ({ ...u, decider: 'greedy' })) };
    const res = resolveScenario(doc, 'beam.yaml', CONTENT);
    if (!res.setup) throw new Error(res.errors.map(formatDiag).join('\n'));
    const sink = new ArraySink();
    const ds = res.setup.seats.map(() => new GreedyDecider(DEFAULT_WEIGHTS));
    const cx = createContext(res.setup, 1, 0, ds, sink);
    applyPassives(cx, -1);
    runPrecasts(cx, -1);
    const wolf = cx.st.units.find((x) => x.seat === 'wolf1')!;
    const z = cx.st.fx.find((f) => f.zbit >= 0)!;
    expect(z.seen![wolf.idx]).toBe(0); // it didn't see the cast
    expect(knownZones(cx.st, wolf) & (1 << z.zbit)).not.toBe(0); // but it sees the beam
    cx.st.active = wolf.idx;
    cx.st.turnIdx++;
    wolf.turns++;
    Object.assign(wolf.b, { action: 0, bonus: 0, reaction: 1, freeObj: 1, moveFt: 40, atkActive: false, movedFt: 0 });
    const list = listOptions(cx, wolf, takeList(cx));
    const keys: string[] = [];
    const items: Legal[] = [];
    for (let i = 0; i < list.n; i++) {
      keys.push(legalKey(cx.st, wolf.idx, list.items[i]!));
      items.push(copyLegal(list.items[i]!, newLegal()));
    }
    releaseList(cx, list);
    // Every 40-ft walk to B4 that crosses F4 is a hazard route; the hazard-free one goes round.
    expect(keys.filter((k) => k.startsWith('move:B4/'))).toEqual(['move:B4/p0']);
    resolveOption(cx, wolf, items[keys.indexOf('move:B4/p0')]!, -1);
    expect(wolf.cell).toBe(parseCell('B4', 10, 7));
    expect(ofKind(sink.events, 'step').some((e) => e.to === parseCell('F4', 10, 7))).toBe(false);
  });
});
