// Zones (SRD 5.2.1 p.150-151 Moonbeam, p.164 Spike Growth, p.106 combining spell effects).
// Spells are hand-built stand-ins; the compiler makes the real ones from YAML.
import { describe, expect, it } from 'vitest';
import { compileKeyPattern, saveKey } from '../src/content/rollkeys.ts';
import { HOOK, type BoundEffect, type CompiledTemplate, type SpellEntry } from '../src/content/types.ts';
import type { Decider, DecisionPoint, UnitView } from '../src/decide/decider.ts';
import { areaMask, shapeKey } from '../src/grid/area.ts';
import { cellName, parseCell } from '../src/grid/cells.ts';
import { CELL, cellInfo, computeReach, forEachLabel, knownZones, newReachScratch, stepCost } from '../src/grid/reach.ts';
import { ArraySink, type GameEvent } from '../src/log/events.ts';
import { renderLog } from '../src/log/render.ts';
import { flagIndex, type RuleFlags } from '../src/rules/flags.ts';
import { resolveOption } from '../src/sim/act.ts';
import { copyLegal, legalKey, newLegal, releaseList, takeList } from '../src/sim/context.ts';
import { endConcentration, endFx } from '../src/sim/effects.ts';
import { createContext } from '../src/sim/fight.ts';
import { listOptions } from '../src/sim/options.ts';
import { drain, queueTrigger, TRIG } from '../src/sim/triggers.ts';
import { walkPath } from '../src/sim/walker.ts';
import type { Unit } from '../src/sim/state.ts';
import { caster, DUMMY, effect, entry, FIGHTER, S, setup, spell } from './helpers/build.ts';
import { ofKind } from './helpers/run.ts';

const BEAM_KEY = shapeKey('cylinder', 5);
const CON = 2;

// tpl.effects: 0 beam instance, 1 beam zone, 2 spikes instance, 3 spikes zone, 4 ward instance, 5 ward zone, 6 ward rider
const inst = (local: string, n: number): BoundEffect => effect(`${local}-c`, { conc: true, dur: { k: 'rounds', n } });
const BEAM = (lvl: number, sid = 1): BoundEffect =>
  effect('beam', {
    sid, lvl, zone: { shapeKey: BEAM_KEY, heightFt: 40, difficult: false }, limit: 'perCreature',
    hooks: [{ on: HOOK.appear | HOOK.movedOnto | HOOK.enter | HOOK.turnEndIn, steps: [S.save(CON, saveKey(CON), 15, '2d10', 'radiant', true)] }],
    hookMask: HOOK.appear | HOOK.movedOnto | HOOK.enter | HOOK.turnEndIn, interacts: false,
    grants: [{ local: 'move', name: 'Move the beam', cost: 'action', laterTurns: true, to: 'owner', steps: [{ k: 'moveZone', ft: 60 }] }],
  });
const SPIKES: BoundEffect = effect('spikes', {
  sid: 2, zone: { shapeKey: shapeKey('sphere', 20), heightFt: 0, difficult: true },
  hooks: [{ on: HOOK.travel, steps: [S.damage('2d4', 'piercing')] }], hookMask: HOOK.travel,
  hiddenDc: 13, // camouflaged, as Spike Growth (coverage step 9): sawCast tests below rely on it
});
const RIDER: BoundEffect = effect('marked', { mods: [{ on: [compileKeyPattern('d20.attack')], side: 'incoming', op: 'adv', value: 0, dice: null, consume: false, skillParam: false }] });
const WARD: BoundEffect = effect('ward', { sid: 3, zone: { shapeKey: shapeKey('sphere', 10), heightFt: 0, difficult: true }, hooks: [{ on: HOOK.appear, steps: [S.apply(6, 'target')] }], hookMask: HOOK.appear, interacts: true });

const zoneSpell = (local: string, sid: number, key: number, instIdx: number, zoneIdx: number, lvl = 2): SpellEntry => {
  const instance = new Array<number>(10).fill(-1);
  instance[lvl] = instIdx;
  return entry(spell(local, { level: lvl, conc: true, rangeFt: 150, areaShape: key, sid }), { [lvl]: [S.apply(zoneIdx, 'point')] }, { instance }); // V,S: the caster's hands are free
};

function zoneCaster(beam = BEAM(2)): CompiledTemplate {
  return caster({
    effects: [inst('beam', 10), beam, inst('spikes', 100), SPIKES, inst('ward', 10), WARD, RIDER],
    spells: [zoneSpell('beam', 1, BEAM_KEY, 0, 1), zoneSpell('spikes', 2, shapeKey('sphere', 20), 2, 3), zoneSpell('ward', 3, shapeKey('sphere', 10), 4, 5)],
  });
}

class Keys implements Decider {
  readonly name = 'keys';
  readonly queue: string[];
  constructor(queue: string[] = []) {
    this.queue = queue;
  }
  decide(_v: UnitView, dp: DecisionPoint): number {
    if (this.queue.length > 0) {
      const want = this.queue[0]!;
      const i = dp.indexOfKey ? dp.indexOfKey(want) : -1;
      const j = i >= 0 ? i : Array.from({ length: dp.legal.n }, (_, k) => k).find((k) => dp.keyOf(k) === want) ?? -1;
      if (j >= 0) {
        this.queue.shift();
        return j;
      }
    }
    return 0;
  }
}

function scene(opts: { units: Parameters<typeof setup>[0]['units']; flags?: Partial<RuleFlags>; keys?: string[]; w?: number; h?: number; terrain?: string[] }) {
  const sink = new ArraySink();
  const s = setup({ w: opts.w ?? 12, h: opts.h ?? 5, flags: opts.flags, terrain: opts.terrain, units: opts.units });
  const keys = new Keys(opts.keys);
  const cx = createContext(s, 11, 0, s.seats.map(() => keys), sink, { audit: true });
  const u = (seat: string): Unit => cx.st.units.find((x) => x.seat === seat)!;
  const begin = (who: Unit) => {
    cx.st.active = who.idx;
    cx.st.turnIdx++;
    who.turns++;
    Object.assign(who.b, { action: 1, bonus: 1, reaction: 1, freeObj: 1, moveFt: who.tpl.speedFt, atkActive: false });
  };
  const end = (who: Unit) => {
    queueTrigger(cx, TRIG.turnEnd, who.idx, who.cell, -1, 0, -1);
    drain(cx);
  };
  const choose = (who: Unit, key: string) => {
    const list = listOptions(cx, who, takeList(cx));
    let chosen = null;
    for (let i = 0; i < list.n; i++) if (legalKey(cx.st, who.idx, list.items[i]!) === key) chosen = copyLegal(list.items[i]!, newLegal());
    releaseList(cx, list);
    if (!chosen) throw new Error(`${key} isn't offered`);
    resolveOption(cx, who, chosen, -1);
  };
  const walk = (who: Unit, cells: string[], mode: 'voluntary' | 'forced' = 'voluntary') =>
    walkPath(cx, who, Int32Array.from(cells.map((c) => parseCell(c, s.w, s.h))), cells.length, mode, -1);
  const ev = <K extends GameEvent['k']>(k: K) => ofKind(sink.events, k);
  return { cx, s, u, begin, end, choose, walk, ev, sink, keys };
}

const PC = (tpl = zoneCaster()) => ({ seat: 'pc', team: 0 as const, tpl, at: 'A1' });
const GOB = (seat: string, at: string) => ({ seat, team: 1 as const, tpl: { ...DUMMY, speedFt: 30 }, at });

describe('masks on the grid (areaOriginOnGrid x areaGridCoverage)', () => {
  it('square-centered: a 5-ft radius covers 1/5/9 squares and a 20-ft radius 45/49/69 (half / center inside / any overlap)', () => {
    const n = (r: number, o: 'squareCenter' | 'gridIntersection', c: 'atLeastHalfSquare' | 'squareCenterInside' | 'anyOverlap') => areaMask(shapeKey('cylinder', r), o, c, 'uniform', 'squareCenter', 'gridDistance', -1).length / 2;
    expect([n(5, 'squareCenter', 'atLeastHalfSquare'), n(5, 'squareCenter', 'squareCenterInside'), n(5, 'squareCenter', 'anyOverlap')]).toEqual([1, 5, 9]);
    expect([n(20, 'squareCenter', 'atLeastHalfSquare'), n(20, 'squareCenter', 'squareCenterInside'), n(20, 'squareCenter', 'anyOverlap')]).toEqual([45, 49, 69]);
    expect([n(5, 'gridIntersection', 'atLeastHalfSquare'), n(20, 'gridIntersection', 'atLeastHalfSquare'), n(20, 'gridIntersection', 'anyOverlap')]).toEqual([4, 52, 60]);
  });
});

describe('Moonbeam-style zones (p.150-151)', () => {
  it('saves when it appears, and once per creature per turn across every trigger: twice over two turns, never twice in one', () => {
    const { u, begin, end, choose, walk, ev } = scene({ units: [PC(), GOB('gob', 'F1')], keys: ['place:F1'] });
    const pc = u('pc');
    const gob = u('gob');
    begin(pc);
    choose(pc, 'cast:beam@2');
    expect(ev('save')).toHaveLength(1); // it appeared on the goblin
    end(pc);
    begin(gob);
    walk(gob, ['G1', 'F1']); // out and back in: a new turn, so entering saves
    expect(ev('save')).toHaveLength(2);
    end(gob); // ends its turn there: already saved this turn
    expect(ev('save')).toHaveLength(2);
    begin(pc);
    end(pc);
    begin(gob);
    end(gob); // a later turn: ending the turn inside saves again
    expect(ev('save')).toHaveLength(3);
  });

  it('one damage roll covers every creature caught at once (p.16)', () => {
    const big = { ...BEAM(2), zone: { shapeKey: shapeKey('cylinder', 10), heightFt: 40, difficult: false } };
    const tpl = caster({ effects: [inst('beam', 10), big], spells: [zoneSpell('beam', 1, shapeKey('cylinder', 10), 0, 1)] });
    const { u, begin, choose, ev, sink, s } = scene({ units: [PC(tpl), GOB('g1', 'E2'), GOB('g2', 'F2'), GOB('g3', 'G2')], keys: ['place:F2'] });
    begin(u('pc'));
    choose(u('pc'), 'cast:beam@2');
    const dmgs = ev('damage');
    expect(dmgs).toHaveLength(3);
    expect(new Set(dmgs.map((e) => `${e.purpose}/${e.slot}`)).size).toBe(1);
    expect(renderLog(sink.events, s).join('\n')).toMatch(/Moonbeam|beam appears at F2: 9 squares/);
  });

  it('of two overlapping copies of one spell only the more potent applies, before its own once-per-turn check (p.106)', () => {
    const lo = caster({ effects: [inst('beam', 10), BEAM(2)], spells: [zoneSpell('beam', 1, BEAM_KEY, 0, 1)] });
    const hi = caster({ effects: [inst('beam', 10), { ...BEAM(3), name: 'beam-3', id: 'test:fx/beam-3' as never }], spells: [zoneSpell('beam', 1, BEAM_KEY, 0, 1, 3)] });
    const { u, begin, end, choose, ev } = scene({ units: [PC(lo), { seat: 'pc2', team: 0, tpl: { ...hi, resMax: [4, 3, 3, 0, 0, 0, 0, 0, 0] }, at: 'A2' }, GOB('gob', 'F1')], keys: ['place:F1', 'place:F1'] });
    begin(u('pc'));
    choose(u('pc'), 'cast:beam@2');
    end(u('pc'));
    begin(u('pc2'));
    choose(u('pc2'), 'cast:beam@3');
    end(u('pc2'));
    const before = ev('save').length;
    begin(u('gob'));
    end(u('gob'));
    const last = ev('save').slice(before);
    expect(last.map((e) => e.name)).toEqual(['beam-3']);
  });

  it('moving it onto a creature saves once; sweeping past a creature counts only under sweepPath', () => {
    for (const [mode, saved] of [['sweepPath', ['mid', 'far']], ['destinationOnly', ['far']]] as const) {
      const { u, begin, end, choose, ev, s: setupOf } = scene({ units: [PC(), GOB('mid', 'D2'), GOB('far', 'H2')], flags: { movedAreaTriggersAlongPath: mode }, keys: ['place:A2', 'place:H2'] });
      const pc = u('pc');
      begin(pc);
      choose(pc, 'cast:beam@2');
      expect(ev('save')).toHaveLength(0); // A2 is empty
      end(pc);
      begin(pc);
      choose(pc, 'use:pc/beam/move');
      expect(ev('zoneMove')[0]!.to).toBe('H2');
      expect(ev('save').map((e) => setupOf.seats[e.who]!.seat)).toEqual(saved);
    }
  });

  it('creatures caught by one move share one damage roll, or roll separately under perCreature', () => {
    const big = { ...BEAM(2), zone: { shapeKey: shapeKey('cylinder', 10), heightFt: 40, difficult: false } };
    const tpl = caster({ effects: [inst('beam', 10), big], spells: [zoneSpell('beam', 1, shapeKey('cylinder', 10), 0, 1)] });
    for (const [mode, rolls] of [['groupByEvent', 1], ['perCreature', 2]] as const) {
      const { u, begin, end, choose, ev } = scene({ units: [PC(tpl), GOB('g1', 'H2'), GOB('g2', 'I2')], flags: { areaSaveGroupingPerEvent: mode }, keys: ['place:B4', 'place:H2'] });
      const pc = u('pc');
      begin(pc);
      choose(pc, 'cast:beam@2');
      end(pc);
      begin(pc);
      choose(pc, 'use:pc/beam/move');
      expect(new Set(ev('damage').map((e) => e.slot)).size).toBe(rolls);
    }
  });

  it('a creature pulled into it saves under involuntaryMovementTriggersArea, and not otherwise', () => {
    for (const [flag, saves] of [[true, 1], [false, 0]] as const) {
      const { u, begin, end, choose, walk, ev } = scene({ units: [PC(), GOB('gob', 'F1'), GOB('two', 'H1')], flags: { involuntaryMovementTriggersArea: flag }, keys: ['place:G1'] });
      begin(u('pc'));
      choose(u('pc'), 'cast:beam@2');
      end(u('pc'));
      begin(u('two'));
      walk(u('gob'), ['G1'], 'forced');
      expect(ev('save')).toHaveLength(saves);
    }
  });
});

describe('Spike Growth-style zones (p.164)', () => {
  it('a voluntary step into it costs 10 ft and deals one 2d4; damage counts feet traveled, never movement spent', () => {
    const { u, begin, choose, walk, ev } = scene({ units: [PC(), GOB('gob', 'K1')], keys: ['place:F3'] });
    begin(u('pc'));
    choose(u('pc'), 'cast:spikes@2'); // E-row... B1..? the 20-ft sphere at F3 covers C1..I5 minus corners
    const gob = u('gob');
    begin(gob);
    const ft = gob.b.moveFt;
    walk(gob, ['J1', 'I1']); // K1 -> J1 is outside; J1 -> I1 steps in
    expect(ft - gob.b.moveFt).toBe(5 + 10);
    expect(ev('damage').map((e) => e.name)).toEqual(['spikes']);
  });

  it('per 5 ft traveled: two steps inside are two instances (perIncrement), or one at move end (perMove)', () => {
    for (const [mode, instances] of [['perIncrement', 2], ['perMove', 1]] as const) {
      const { u, begin, choose, walk, ev } = scene({ units: [PC(), GOB('gob', 'J1')], flags: { perDistanceDamageRolls: mode }, keys: ['place:F3'] });
      begin(u('pc'));
      choose(u('pc'), 'cast:spikes@2');
      begin(u('gob'));
      walk(u('gob'), ['I1', 'H1']);
      expect(ev('damage')).toHaveLength(instances);
    }
  });

  it('perMove still deals the feet traveled when the spikes end before the move does', () => {
    const { cx, s, u, begin, choose, ev } = scene({ units: [PC(), GOB('gob', 'J1')], flags: { perDistanceDamageRolls: 'perMove' }, keys: ['place:F3'] });
    const pc = u('pc');
    begin(pc);
    choose(pc, 'cast:spikes@2');
    const gob = u('gob');
    begin(gob);
    // two 5-ft steps inside (J1 -> I1 -> H1), then the concentration breaks before the move ends
    for (const [from, to] of [['J1', 'I1'], ['I1', 'H1']] as const) {
      gob.cell = parseCell(to, s.w, s.h);
      queueTrigger(cx, TRIG.move5ft, gob.idx, parseCell(from, s.w, s.h), gob.cell, 1 << 1, -1);
      drain(cx);
    }
    expect(ev('damage')).toEqual([]);
    endConcentration(cx, pc, 'concentration', -1);
    queueTrigger(cx, TRIG.moveEnd, gob.idx, -1, -1, 0, -1);
    drain(cx);
    expect(ev('damage').map((e) => e.name)).toEqual(['spikes']);
    expect(cx.st.accPending).toBe(0);
  });

  it('the step out of the area counts only under areaExitStepCounts', () => {
    for (const [flag, n] of [[false, 0], [true, 1]] as const) {
      const { u, begin, choose, walk, ev } = scene({ units: [PC(), GOB('gob', 'I1')], flags: { areaExitStepCounts: flag }, keys: ['place:F3'] });
      begin(u('pc'));
      choose(u('pc'), 'cast:spikes@2');
      begin(u('gob'));
      walk(u('gob'), ['J1']);
      expect(ev('damage')).toHaveLength(n);
    }
  });

  it('its Difficult Terrain is in the pathing, and never stacks with other Difficult Terrain', () => {
    const { cx, u, begin, choose } = scene({ units: [PC(), GOB('gob', 'K1')], keys: ['place:F3'], terrain: ['............', '.....:......', '............', '............', '............'] });
    begin(u('pc'));
    choose(u('pc'), 'cast:spikes@2');
    const gob = u('gob');
    expect(cellInfo(cx.st, gob, parseCell('I1', 12, 5)) & CELL.difficult).toBeTruthy();
    // F2 is terrain-difficult and inside the spikes: 10 ft to enter, not 20; G2 (spikes only) is 10 too
    const at = (c: string) => parseCell(c, 12, 5);
    expect(stepCost(cx.st, gob, at('G2'), at('F2'), 0, cellInfo(cx.st, gob, at('F2')))).toBe(10);
    expect(stepCost(cx.st, gob, at('H2'), at('G2'), 0, cellInfo(cx.st, gob, at('G2')))).toBe(10);
    expect(stepCost(cx.st, gob, at('L1'), at('K1'), 0, cellInfo(cx.st, gob, at('K1')))).toBe(5);
  });
});

describe('a zone that moves creatures', () => {
  it('a walk stops where a trigger pushed the walker, and never jumps back onto its path', () => {
    const GUST = effect('gust', {
      sid: 8, zone: { shapeKey: BEAM_KEY, heightFt: 0, difficult: false },
      hooks: [{ on: HOOK.enter, steps: [{ k: 'forced', mode: 'push', maxFt: 10, maxSize: 5 }] }], hookMask: HOOK.enter, interacts: true,
    });
    const tpl = caster({ effects: [inst('gust', 10), GUST], spells: [zoneSpell('gust', 8, BEAM_KEY, 0, 1)] });
    const { s, u, begin, choose, walk, ev } = scene({ units: [{ seat: 'pc', team: 0, tpl, at: 'A3' }, GOB('gob', 'H3')], keys: ['place:F3', 'pull:G2', 'pull:H1'] });
    begin(u('pc'));
    choose(u('pc'), 'cast:gust@2');
    const gob = u('gob');
    begin(gob);
    walk(gob, ['G3', 'F3', 'E3', 'D3']); // F3 is the gust's square
    expect(cellName(gob.cell, s.w)).toBe('H1');
    expect(ev('step').filter((e) => !e.forced).map((e) => cellName(e.to, s.w))).toEqual(['G3', 'F3']);
    expect(ev('moveEnd').filter((e) => !e.forced).map((e) => [e.why, e.steps])).toEqual([['displaced', 2]]);
  });
});

describe('a cast whose concentration ends mid-program', () => {
  it('stops: a later step never links a child effect to the ended spell', () => {
    const FLARE = effect('flare', { sid: 9, zone: { shapeKey: BEAM_KEY, heightFt: 0, difficult: false }, hooks: [{ on: HOOK.appear, steps: [S.damage('30', 'radiant')] }], hookMask: HOOK.appear });
    const GLOW = effect('glow', { dur: { k: 'parent' } });
    const instance = new Array<number>(10).fill(-1);
    instance[1] = 0;
    const sp = entry(spell('flare', { level: 1, conc: true, rangeFt: 60, areaShape: BEAM_KEY, sid: 9 }), { 1: [S.apply(1, 'point'), S.apply(2, 'self')] }, { instance });
    const tpl = { ...caster({ effects: [inst('flare', 10), FLARE, GLOW], spells: [sp] }), hpMax: 25 };
    // pc2 far off keeps the fight going once pc drops
    const { cx, u, begin, choose } = scene({ units: [{ seat: 'pc', team: 0, tpl, at: 'A1' }, GOB('gob', 'F1'), { seat: 'pc2', team: 0, tpl: FIGHTER, at: 'L5' }], keys: ['place:A1'] });
    const pc = u('pc');
    begin(pc);
    choose(pc, 'cast:flare@1'); // the flare drops its own caster: concentration ends with the zone
    expect(pc.life).toBe('down');
    expect(cx.st.fx.filter((f) => f.alive)).toEqual([]);
    expect(cx.st.fx.map((f) => cx.st.units[f.owner]!.tpl.effects[f.tpl]!.local)).toEqual(['flare-c', 'flare']); // no glow
  });
});

describe('zoneKnowledge (m1c 3.7, resolution 5)', () => {
  it('a mover counts its own zones, a hidden one only if it saw it appear (sawCast; a visible one by sight, coverage step 9), every zone (all), or only its own (none)', () => {
    const { cx, u, begin, choose } = scene({ units: [PC(), { seat: 'pc2', team: 0, tpl: zoneCaster(), at: 'A5' }, GOB('gob', 'L3')], keys: ['place:B1', 'place:F3'] });
    begin(u('pc'));
    choose(u('pc'), 'cast:beam@2'); // B1: the goblin sees it appear
    begin(u('pc2'));
    choose(u('pc2'), 'cast:spikes@2'); // F3
    const gob = u('gob');
    const [beam, spikes] = [cx.st.fx.find((f) => f.zbit >= 0 && f.owner === u('pc').idx)!, cx.st.fx.find((f) => f.zbit >= 0 && f.owner === u('pc2').idx)!];
    spikes.seen![gob.idx] = 0; // as if it hadn't seen the spikes go down
    const masks = (['sawCast', 'all', 'none'] as const).map((mode) => {
      (cx.st.setup.flags as { zoneKnowledge: string }).zoneKnowledge = mode;
      return knownZones(cx.st, gob);
    });
    expect(masks).toEqual([1 << beam.zbit, -1, 0]);
    expect(knownZones(cx.st, u('pc2')) & (1 << spikes.zbit)).not.toBe(0); // its own zone, under any value
  });

  it('what a mover is offered depends on it, and listing its moves marks the flag', () => {
    const keysUnder = (mode: 'sawCast' | 'all') => {
      const { cx, u, begin, choose } = scene({ units: [PC(), GOB('gob', 'K1')], flags: { zoneKnowledge: mode }, keys: ['place:F3'] });
      begin(u('pc'));
      choose(u('pc'), 'cast:spikes@2');
      const gob = u('gob');
      cx.st.fx.find((f) => f.zbit >= 0)!.seen![gob.idx] = 0;
      begin(gob);
      const list = listOptions(cx, gob, takeList(cx));
      const keys: string[] = [];
      for (let i = 0; i < list.n; i++) if (list.items[i]!.k === 'move') keys.push(legalKey(cx.st, gob.idx, list.items[i]!));
      releaseList(cx, list);
      expect(cx.st.flagsUsed[flagIndex('zoneKnowledge')]).toBe(1);
      return keys;
    };
    const unaware = keysUnder('sawCast');
    const aware = keysUnder('all');
    expect(unaware.some((k) => /\/h[1-9]/.test(k))).toBe(false); // it doesn't know the spikes are there
    expect(aware.some((k) => /\/h[1-9]/.test(k))).toBe(true);
  });
});

describe('hazard-aware routes', () => {
  it('hazard counts up to 7, so a route through 5 spiked squares stays on offer beside a cheaper one through 7 (m1c critique #4)', () => {
    // Two corridors through one 20-ft spike zone centered on F5: the top one (row 2) crosses
    // the zone's narrow edge row (5 squares) but is longer; the straight one (row 5) crosses 7.
    const terrain = ['###########', '...........', '.#########.', '.#########.', '...........', '###########', '.##########', '###########', '###########'];
    // The walls only shape corridors here: area line of effect (M3 step 8) would cut the zone at
    // them, so LOS is stubbed to count hazards alone (cover.test.ts checks line of effect).
    const { cx, s, u, begin, choose } = scene({ w: 11, h: 9, terrain, units: [{ seat: 'pc', team: 0, tpl: zoneCaster(), at: 'A7' }, GOB('gob', 'A5')], keys: ['place:F5'], flags: { losMethod: 'stubbed' } });
    begin(u('pc'));
    choose(u('pc'), 'cast:spikes@2');
    const gob = u('gob');
    const sc = newReachScratch(s.w * s.h);
    computeReach(cx.st, gob, 300, sc);
    const labels: [number, number][] = [];
    forEachLabel(cx.st, gob, sc, 300, (cell, ft, _p, _par, hz) => {
      if (cellName(cell, s.w) === 'K5') labels.push([hz, ft]);
    });
    expect(labels).toEqual([[5, 105], [7, 85]]);
  });

  it('a route through a zone and a longer one around it are both offered; the zone route is keyed /h1', () => {
    const terrain = ['...#.....', '.........', '...#.....', '...#.....', '...#.....', '...#.....', '.........'];
    // LOS stubbed: the wall shapes the route only (area line of effect would cut the beam at it, M3 step 8).
    const { cx, u, begin, choose } = scene({ w: 9, h: 7, terrain, units: [{ ...PC(), at: 'I7' }, GOB('gob', 'A2')], keys: ['place:D2'], flags: { losMethod: 'stubbed' } });
    const pc = u('pc');
    begin(pc);
    choose(pc, 'cast:beam@2');
    const gob = u('gob');
    begin(gob);
    gob.b.moveFt = 60;
    const list = listOptions(cx, gob, takeList(cx));
    const toG2: string[] = [];
    for (let i = 0; i < list.n; i++) {
      const k = legalKey(cx.st, gob.idx, list.items[i]!);
      if (k.startsWith('move:G2')) toG2.push(`${k}:${list.items[i]!.ft}`);
    }
    releaseList(cx, list);
    expect(toG2).toEqual(['move:G2/p0:60', 'move:G2/p0/h1:30']); // around: the wall corner rule forces C7-D7-E7
  });
});

describe('concentration zones', () => {
  it('a broken concentration removes the zone, its Difficult Terrain and the riders it put on creatures', () => {
    const { cx, u, begin, choose, ev } = scene({ units: [PC(), GOB('gob', 'F1')], keys: ['place:F1'] });
    const pc = u('pc');
    begin(pc);
    choose(pc, 'cast:ward@2');
    expect(u('gob').borne).toHaveLength(1);
    endFx(cx, pc.conc, 'concentration', -1);
    expect(ev('fxEnd').map((e) => `${e.name}:${e.why}`)).toEqual(['ward-c:concentration', 'ward:parent', 'marked:parent']);
    expect(cx.st.zoneMask.every((m) => m === 0)).toBe(true);
    expect(cellInfo(cx.st, u('gob'), parseCell('F1', 12, 5)) & CELL.difficult).toBe(0);
    expect(u('gob').borne).toEqual([]);
  });

  it('a new concentration spell ends the old one before the new zone appears', () => {
    const { cx, u, begin, choose, ev } = scene({ units: [PC(), GOB('gob', 'K5')], keys: ['place:F1', 'place:F3'] });
    const pc = u('pc');
    begin(pc);
    choose(pc, 'cast:ward@2');
    begin(pc);
    choose(pc, 'cast:spikes@2');
    const order = cxOrder(ev('fxEnd'), ev('zone'));
    expect(order).toEqual(['end:ward-c', 'end:ward', 'zone:spikes']);
    expect(cx.st.fx.filter((f) => f.alive).map((f) => f.tpl)).toEqual([2, 3]);
  });
});

function cxOrder(ends: ReturnType<typeof ofKind<'fxEnd'>>, zones: ReturnType<typeof ofKind<'zone'>>): string[] {
  return [...ends.map((e) => [e.seq, `end:${e.name}`] as const), ...zones.filter((z) => z.name === 'spikes').map((z) => [z.seq, `zone:${z.name}`] as const)].sort((a, b) => a[0] - b[0]).map(([, s]) => s);
}
