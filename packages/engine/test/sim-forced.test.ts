// Forced movement: a chosen-distance pull (the 2024 text: "up to 10 feet closer", no
// "straight"), through zones, around creatures, never provoking (SRD 5.2.1 p.15).
import { describe, expect, it } from 'vitest';
import { HOOK, SIZES, type BoundEffect, type CompiledTemplate, type SpellEntry } from '../src/content/types.ts';
import type { Decider, DecisionPoint, UnitView } from '../src/decide/decider.ts';
import { shapeKey } from '../src/grid/area.ts';
import { ArraySink, type GameEvent } from '../src/log/events.ts';
import { renderLog } from '../src/log/render.ts';
import { flagIndex, type RuleFlags } from '../src/rules/flags.ts';
import { resolveOption } from '../src/sim/act.ts';
import { copyLegal, legalKey, newLegal, releaseList, takeList } from '../src/sim/context.ts';
import { createContext } from '../src/sim/fight.ts';
import { listOptions } from '../src/sim/options.ts';
import type { Unit } from '../src/sim/state.ts';
import { caster, DUMMY, effect, entry, FIGHTER, S, SENTRY, setup, spell, spellAttack } from './helpers/build.ts';
import { ofKind } from './helpers/run.ts';

const LARGE = SIZES.indexOf('large');

const spikes = (roll = '2d4'): BoundEffect =>
  effect('spikes', { sid: 2, zone: { shapeKey: shapeKey('sphere', 20), heightFt: 0, difficult: true }, hooks: [{ on: HOOK.travel, steps: [S.damage(roll, 'piercing')] }], hookMask: HOOK.travel });

function puller(zone = spikes()): CompiledTemplate {
  const inst = new Array<number>(10).fill(-1);
  inst[2] = 0;
  const pull: SpellEntry = entry(spell('tether', { level: 0, sid: 1 }), {
    0: [S.target(30), S.attack(spellAttack('tether', 'melee', 100, 30, '1d6', 'piercing'), [S.damage('1d6', 'piercing'), { k: 'forced', mode: 'pull', maxFt: 10, maxSize: LARGE }])],
  });
  const grow: SpellEntry = entry(spell('spikes', { level: 2, conc: true, rangeFt: 150, areaShape: shapeKey('sphere', 20), sid: 2 }), { 2: [S.apply(1, 'point')] }, { instance: inst });
  return caster({ effects: [effect('spikes-c', { conc: true, dur: { k: 'rounds', n: 100 } }), zone], spells: [pull, grow] });
}

class Keys implements Decider {
  readonly name = 'keys';
  readonly queue: string[];
  readonly sizes: number[] = [];
  constructor(queue: string[] = []) {
    this.queue = queue;
  }
  decide(_v: UnitView, dp: DecisionPoint): number {
    if (dp.k === 'pull') this.sizes.push(dp.legal.n);
    if (this.queue.length > 0) {
      const want = this.queue[0]!;
      const i = dp.indexOfKey ? dp.indexOfKey(want) : Array.from({ length: dp.legal.n }, (_, k) => k).find((k) => dp.keyOf(k) === want) ?? -1;
      if (i >= 0) {
        this.queue.shift();
        return i;
      }
    }
    return 0;
  }
}

function scene(opts: { units: Parameters<typeof setup>[0]['units']; flags?: Partial<RuleFlags>; keys?: string[]; w?: number; h?: number }) {
  const sink = new ArraySink();
  const s = setup({ w: opts.w ?? 10, h: opts.h ?? 7, flags: opts.flags, units: opts.units });
  const keys = new Keys(opts.keys);
  const cx = createContext(s, 21, 0, s.seats.map(() => keys), sink, { audit: true });
  const u = (seat: string): Unit => cx.st.units.find((x) => x.seat === seat)!;
  const begin = (who: Unit) => {
    cx.st.active = who.idx;
    cx.st.turnIdx++;
    who.turns++;
    Object.assign(who.b, { action: 1, bonus: 1, reaction: 1, freeObj: 1, moveFt: who.tpl.speedFt, atkActive: false });
  };
  const choose = (who: Unit, key: string) => {
    const list = listOptions(cx, who, takeList(cx));
    let chosen = null;
    for (let i = 0; i < list.n; i++) if (legalKey(cx.st, who.idx, list.items[i]!) === key) chosen = copyLegal(list.items[i]!, newLegal());
    releaseList(cx, list);
    if (!chosen) throw new Error(`${key} isn't offered`);
    resolveOption(cx, who, chosen, -1);
  };
  const ev = <K extends GameEvent['k']>(k: K) => ofKind(sink.events, k);
  return { cx, s, u, begin, choose, ev, sink, keys };
}

const GOB = { ...DUMMY, speedFt: 30, hpMax: 40 };

describe('a chosen-distance pull', () => {
  it('through spikes: one damage instance per 5 ft, no opportunity attacks, none of the target\'s movement spent', () => {
    const { u, begin, choose, ev, sink, s } = scene({
      units: [{ seat: 'pc', team: 0, tpl: puller(), at: 'B1' }, { seat: 'gob', team: 1, tpl: GOB, at: 'H1' }, { seat: 'guard', team: 0, tpl: SENTRY, at: 'I1' }],
      keys: ['place:E4', 'pull:G1', 'pull:F1'],
    });
    const pc = u('pc');
    const gob = u('gob');
    begin(pc);
    choose(pc, 'cast:spikes@2');
    const moveFt = gob.b.moveFt;
    const parity = gob.b.diagParity;
    begin(pc);
    choose(pc, 'cast:tether@0');
    expect(gob.cell).toBe(5); // F1
    expect(ev('damage').map((e) => e.name ?? 'tether')).toEqual(['tether', 'spikes', 'spikes']);
    expect(ev('provoke')).toEqual([]);
    expect(u('guard').b.reaction).toBe(1);
    expect([gob.b.moveFt, gob.b.diagParity]).toEqual([moveFt, parity]);
    const log = renderLog(sink.events, s).join('\n');
    expect(log).toMatch(/gob is pulled H1 -> G1 \(5 ft, forced\)/);
    expect(log).toMatch(/gob's forced move ends at F1/);
  });

  it('a creature pulled into the spikes takes no damage when involuntaryMovementTriggersArea is false', () => {
    const { u, begin, choose, ev } = scene({
      units: [{ seat: 'pc', team: 0, tpl: puller(), at: 'B1' }, { seat: 'gob', team: 1, tpl: GOB, at: 'H1' }],
      flags: { involuntaryMovementTriggersArea: false },
      keys: ['place:E4', 'pull:G1', 'pull:F1'],
    });
    begin(u('pc'));
    choose(u('pc'), 'cast:spikes@2');
    begin(u('pc'));
    choose(u('pc'), 'cast:tether@0');
    expect(ev('damage').filter((e) => e.name === 'spikes')).toEqual([]);
  });

  it('each step closer offers every square that closes the distance (3 here); straightLineOnly offers the one on the line', () => {
    for (const [mode, items] of [['eachStepCloser', 4], ['straightLineOnly', 2]] as const) {
      const { u, begin, choose, keys } = scene({ units: [{ seat: 'pc', team: 0, tpl: puller(), at: 'A4' }, { seat: 'gob', team: 1, tpl: GOB, at: 'E4' }], flags: { forcedMovementPath: mode } });
      begin(u('pc'));
      choose(u('pc'), 'cast:tether@0');
      expect(keys.sizes[0]).toBe(items); // plus "stop here"
    }
  });

  it('stops before an occupied square, and records that the obstacle rule shaped the choice', () => {
    const { cx, u, begin, choose, keys } = scene({ units: [{ seat: 'pc', team: 0, tpl: puller(), at: 'A4' }, { seat: 'gob', team: 1, tpl: GOB, at: 'C4' }, { seat: 'block', team: 1, tpl: GOB, at: 'B4' }, { seat: 'b2', team: 1, tpl: GOB, at: 'B3' }, { seat: 'b3', team: 1, tpl: GOB, at: 'B5' }], keys: ['target:gob'] });
    begin(u('pc'));
    choose(u('pc'), 'cast:tether@0');
    expect(keys.sizes).toEqual([]); // every closer square is occupied: nothing to ask
    expect(cx.st.flagsUsed[flagIndex('forcedMovementObstacle')]).toBe(1);
  });

  it('a Huge target isn\'t moved', () => {
    const { u, begin, choose, keys } = scene({ units: [{ seat: 'pc', team: 0, tpl: puller(), at: 'A4' }, { seat: 'gob', team: 1, tpl: { ...GOB, size: SIZES.indexOf('huge') }, at: 'E4' }] });
    begin(u('pc'));
    choose(u('pc'), 'cast:tether@0');
    expect(keys.sizes).toEqual([]);
  });

  it('a creature knocked down mid-pull keeps being dragged; only death stops the pull', () => {
    const { u, begin, choose, ev } = scene({
      // a second enemy far off, so knocking the first one down doesn't end the fight
      units: [{ seat: 'pc', team: 0, tpl: puller(spikes('5')), at: 'B1' }, { seat: 'foe', team: 1, tpl: { ...FIGHTER, hpMax: 40 }, at: 'H1', hp: 6 }, { seat: 'other', team: 1, tpl: GOB, at: 'J7' }],
      keys: ['place:E4', 'pull:G1', 'pull:F1'],
    });
    begin(u('pc'));
    choose(u('pc'), 'cast:spikes@2');
    begin(u('pc'));
    choose(u('pc'), 'cast:tether@0');
    const end = ev('moveEnd').at(-1)!;
    expect([end.steps, u('foe').cell]).toEqual([2, 5]);
    expect(ev('down').length + ev('deathFail').length).toBeGreaterThan(0);
  });

  it('terrainShortens: the first step into Difficult Terrain costs 10 ft, so a 10-ft pull goes one square', () => {
    const { u, begin, choose, keys } = scene({
      units: [{ seat: 'pc', team: 0, tpl: puller(), at: 'B1' }, { seat: 'gob', team: 1, tpl: GOB, at: 'H1' }],
      flags: { forcedMovementTerrainCost: 'terrainShortens' },
      keys: ['place:E4', 'pull:G1'],
    });
    begin(u('pc'));
    choose(u('pc'), 'cast:spikes@2');
    begin(u('pc'));
    choose(u('pc'), 'cast:tether@0');
    expect(keys.sizes).toHaveLength(1); // after G1 (10 ft) there's no budget left: nothing more is asked
    expect(u('gob').cell).toBe(6);
  });
});
