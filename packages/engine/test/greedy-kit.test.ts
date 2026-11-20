// The greedy AI with a caster's kit (docs/design/m1c.md 1.6-1.7, build step 6), on the test
// pack's sample druid and seer: zone placement, the form's option by situation, heals, pulls
// through a hazard, the pre-roll reaction, and replay safety with casters in the fight.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../src/content/load.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import type { Decider, DecisionPoint } from '../src/decide/decider.ts';
import { GreedyDecider } from '../src/decide/greedy/greedy.ts';
import { makeDeciders } from '../src/decide/make.ts';
import { areaCells, parseAnchor } from '../src/grid/area.ts';
import { cellName, parseCell } from '../src/grid/cells.ts';
import { ArraySink, HashSink } from '../src/log/events.ts';
import { renderLog } from '../src/log/render.ts';
import { resolveScenario } from '../src/scenario/resolve.ts';
import { resolveOption } from '../src/sim/act.ts';
import { copyLegal, legalKey, newLegal, releaseList, takeList, type Ctx } from '../src/sim/context.ts';
import { createContext, runFight } from '../src/sim/fight.ts';
import { listOptions } from '../src/sim/options.ts';
import type { FightSetup } from '../src/sim/setup.ts';
import type { Unit } from '../src/sim/state.ts';
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

type U = { seat: string; team: 'party' | 'enemies'; use: string; at: string; hp?: number };
function make(units: U[], opts: { w?: number; h?: number; flags?: Record<string, unknown>; decider?: string } = {}): FightSetup {
  const doc = {
    kind: 'scenario', id: 'kit', name: 'Kit', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: { w: opts.w ?? 12, h: opts.h ?? 8 },
    flags: { focusHandSomatic: 'lenient', initiativeMode: 'static', ...opts.flags }, knobs: { downEnds: false },
    units: units.map((u) => ({ ...u, decider: opts.decider ?? 'greedy' })),
  };
  const r = resolveScenario(doc, 'kit.yaml', CONTENT);
  if (!r.setup) throw new Error(r.errors.map(formatDiag).join('\n'));
  return r.setup;
}

function scene(units: U[], opts: Parameters<typeof make>[1] = {}) {
  const s = make(units, opts);
  const sink = new ArraySink();
  const ds: Decider[] = s.seats.map(() => new GreedyDecider());
  const cx = createContext(s, 1, 0, ds, sink);
  const u = (seat: string): Unit => cx.st.units.find((x) => x.seat === seat)!;
  const begin = (who: Unit) => {
    cx.st.active = who.idx;
    cx.st.turnIdx++;
    who.turns++;
    Object.assign(who.b, { action: 1, bonus: 1, reaction: 1, freeObj: 1, moveFt: who.tpl.speedFt, atkActive: false });
  };
  /** The greedy turn choice for `who` now; resolved (sub-decisions go to the same deciders) unless `dry`. `noDodge`: the core Dodge action (M3 step 5a, last in the list) left out. */
  const turn = (who: Unit, dry = false, noDodge = false): string => {
    const list = listOptions(cx, who, takeList(cx));
    const full = list.n;
    if (noDodge && list.n > 0 && list.items[list.n - 1]!.k === 'dodge') list.n--;
    const dp: DecisionPoint = { k: 'turn', who: who.idx, at: 0, round: 1, cause: -1, legal: list, keyOf: (i) => legalKey(cx.st, who.idx, list.items[i]!) };
    const i = ds[who.idx]!.decide(cx.views[who.idx]!, dp);
    const key = dp.keyOf(i);
    const chosen = copyLegal(list.items[i]!, newLegal());
    list.n = full;
    releaseList(cx, list);
    if (!dry && chosen.k !== 'pass') resolveOption(cx, who, chosen, -1);
    return key;
  };
  /** Resolves the turn option with this key (its sub-decisions still go to the greedy deciders). */
  const take = (who: Unit, key: string) => {
    const list = listOptions(cx, who, takeList(cx));
    let chosen = null;
    for (let i = 0; i < list.n; i++) if (legalKey(cx.st, who.idx, list.items[i]!) === key) chosen = copyLegal(list.items[i]!, newLegal());
    releaseList(cx, list);
    if (!chosen) throw new Error(`${key} isn't offered`);
    resolveOption(cx, who, chosen, -1);
  };
  const log = () => renderLog(sink.events, s).join('\n');
  return { cx, s, u, begin, turn, take, log, sink, ds };
}

describe('greedy with a caster\'s kit', () => {
  it('a zone goes over the pair of enemies, not over a lone one next to an ally', () => {
    // Under gridIntersection a 5-ft-radius beam covers the four squares around a corner.
    const { cx, s, u, begin, take, sink } = scene(
      [
        { seat: 'pc1', team: 'party', use: 'test:sample-druid', at: 'A8' },
        { seat: 'ally', team: 'party', use: 'srd:guard', at: 'H2' },
        { seat: 'lone', team: 'enemies', use: 'srd:goblin-warrior', at: 'I2' },
        { seat: 'g1', team: 'enemies', use: 'srd:goblin-warrior', at: 'D3' },
        { seat: 'g2', team: 'enemies', use: 'srd:goblin-warrior', at: 'E3' },
      ],
      { flags: { areaOriginOnGrid: 'gridIntersection' } },
    );
    const pc = u('pc1');
    begin(pc);
    take(pc, 'cast:moonbeam@2'); // the greedy places it
    const zone = sink.events.find((e) => e.k === 'zone');
    expect(zone, 'it placed a zone').toBeDefined();
    const cells: number[] = [];
    areaCells(cx.st, zone!.k === 'zone' ? (cx.st.units[pc.idx]!.tpl.effects.find((t) => t.id === zone!.via)!.zone!.shapeKey) : 0, parseAnchor(cx.st, zone!.k === 'zone' ? zone!.anchor : ''), cells);
    const covered = cells.map((c) => cellName(c, s.w));
    expect(covered).toEqual(expect.arrayContaining(['D3', 'E3']));
    expect(covered).not.toContain('H2');
  });

  it('moving the beam: under sweepPath it won\'t sweep through the ally on the way; under destinationOnly only the landing counts', () => {
    for (const sweep of ['sweepPath', 'destinationOnly'] as const) {
      const { cx, s, u, begin, take, sink } = scene(
        [
          { seat: 'pc1', team: 'party', use: 'test:sample-druid', at: 'A8' },
          { seat: 'ally', team: 'party', use: 'srd:guard', at: 'L1' },
          { seat: 'g0', team: 'enemies', use: 'srd:goblin-warrior', at: 'A2' },
          { seat: 'g1', team: 'enemies', use: 'srd:goblin-warrior', at: 'L3' },
          { seat: 'g2', team: 'enemies', use: 'srd:goblin-warrior', at: 'L5' },
        ],
        { flags: { movedAreaTriggersAlongPath: sweep } },
      );
      const pc = u('pc1');
      begin(pc);
      take(pc, 'cast:moonbeam@2'); // lands on A2, the only goblin in sight
      const zone = sink.events.find((e) => e.k === 'zone');
      expect(zone?.k === 'zone' && zone.anchor).toBe('A2');
      // Now: the ally stands between the beam and one goblin (A2 -> A6 passes A4); the other goblin's line is clear.
      Object.assign(u('g0'), { cell: parseCell('L8', s.w, s.h) });
      Object.assign(u('ally'), { cell: parseCell('A4', s.w, s.h) });
      Object.assign(u('g1'), { cell: parseCell('A6', s.w, s.h) });
      Object.assign(u('g2'), { cell: parseCell('E2', s.w, s.h) });
      begin(pc);
      take(pc, 'use:pc1/beam/move');
      const moved = sink.events.filter((e) => e.k === 'zoneMove').at(-1)!;
      const caught = moved.k === 'zoneMove' ? moved.caught.map((i) => cx.st.units[i]!.seat) : [];
      expect(caught, sweep).not.toContain('ally');
      // It still catches a goblin: g2 on a clear line (E2 itself, or a longer move that sweeps E2), never g1 behind the ally.
      if (sweep === 'sweepPath') expect(caught, 'the clear line').toEqual(['g2']);
    }
  });

  it('moving the beam under either anchor rule: it moves onto an enemy instead of recasting (grid corners measured anchor to anchor)', () => {
    for (const rule of ['squareCenter', 'gridIntersection'] as const) {
      const { s, u, begin, turn, take, sink } = scene(
        [
          { seat: 'pc1', team: 'party', use: 'test:sample-druid', at: 'A8' },
          { seat: 'g0', team: 'enemies', use: 'srd:goblin-warrior', at: 'A2' },
          { seat: 'g1', team: 'enemies', use: 'srd:goblin-warrior', at: 'L8' },
        ],
        { flags: { areaOriginOnGrid: rule } },
      );
      const pc = u('pc1');
      begin(pc);
      take(pc, 'cast:moonbeam@3'); // at 3rd level, so recasting gains nothing over moving it
      // g0 walks off; g1 comes within 60 ft of the beam.
      Object.assign(u('g0'), { cell: parseCell('L1', s.w, s.h) });
      Object.assign(u('g1'), { cell: parseCell('E4', s.w, s.h) });
      begin(pc);
      expect(turn(pc), rule).toBe('use:pc1/beam/move');
      const moved = sink.events.filter((e) => e.k === 'zoneMove').at(-1)!;
      expect(moved.k === 'zoneMove' && moved.caught.map((i) => s.seats[i]!.seat), rule).toEqual(['g1']);
    }
  });

  it('a revived caster picks its dropped focus back up (the free interaction), then casts with the action', () => {
    const { u, begin, turn } = scene([
      { seat: 'pc1', team: 'party', use: 'test:sample-druid', at: 'C4' },
      { seat: 'g1', team: 'enemies', use: 'srd:goblin-warrior', at: 'H4' },
      { seat: 'g2', team: 'enemies', use: 'srd:goblin-warrior', at: 'I5' },
    ]);
    const pc = u('pc1');
    const charm = pc.tpl.items.findIndex((it) => it.kind === 'focus');
    const shield = pc.tpl.items.findIndex((it) => it.kind === 'shield');
    // Both dropped where it fell: hands empty, the items on its square.
    pc.hands[0] = -1;
    pc.hands[1] = -1;
    pc.dropped[charm] = pc.cell;
    pc.dropped[shield] = pc.cell;
    begin(pc);
    expect(turn(pc)).toBe('item:pickup/charm');
    expect(pc.dropped[charm]).toBe(-1);
    expect(turn(pc)).toMatch(/^cast:moonbeam@/);
  });

  it('a dropped shield under threat is picked up with the action when nothing castable beats it; a focus out of reach is never offered', () => {
    const { s, u, begin, turn } = scene([
      { seat: 'pc1', team: 'party', use: 'test:sample-druid', at: 'C4' },
      { seat: 'g1', team: 'enemies', use: 'srd:goblin-boss', at: 'C3' },
      { seat: 'g2', team: 'enemies', use: 'srd:goblin-boss', at: 'D3' },
    ]);
    const pc = u('pc1');
    const charm = pc.tpl.items.findIndex((it) => it.kind === 'focus');
    const shield = pc.tpl.items.findIndex((it) => it.kind === 'shield');
    pc.hands[0] = -1;
    pc.hands[1] = -1;
    pc.dropped[charm] = parseCell('L8', s.w, s.h); // across the map: not pickable from here
    pc.dropped[shield] = pc.cell;
    for (let i = 0; i < pc.res.length; i++) pc.res[i] = 0; // no slots: only cantrips, and the focus ones need the charm
    begin(pc);
    pc.b.bonus = 0;
    // Against casting (the Dodge action, one round of Disadvantage, is weighed in greedy-econ.test.ts).
    expect(turn(pc, false, true)).toBe('item:pickup/shield');
    expect(pc.dropped[shield]).toBe(-1);
  });

  it('the form: its concentration floor while holding a spell under threat, its extra attack otherwise', () => {
    const pickOf = (concentrating: boolean) => {
      const { cx, u, begin, turn, log } = scene([
        { seat: 'pc1', team: 'party', use: 'test:sample-druid', at: 'C4' },
        { seat: 'g1', team: 'enemies', use: 'srd:goblin-boss', at: 'C3' },
        { seat: 'g2', team: 'enemies', use: 'srd:goblin-boss', at: 'D3' },
        { seat: 'g3', team: 'enemies', use: 'srd:goblin-warrior', at: 'J7' },
      ]);
      const pc = u('pc1');
      if (concentrating) {
        begin(pc);
        while (pc.conc < 0 && pc.b.action > 0) if (turn(pc) === 'pass') break;
        expect(pc.conc, log()).toBeGreaterThanOrEqual(0);
      }
      begin(pc);
      pc.b.action = 0; // only the bonus action left: the form or a bonus spell
      for (let k = 0; k < 3; k++) {
        const key = turn(pc);
        if (key === 'use:stance' || key === 'pass') break;
      }
      void cx;
      return /chooses pick:(\w+)/.exec(log().split('\n').reverse().find((l) => /pick:(volley|mending|steady)/.test(l)) ?? '')?.[1];
    };
    expect(pickOf(true)).toBe('steady');
    expect(pickOf(false)).toBe('volley');
  });

  it('heals the ally in danger, not the one out of reach of anything', () => {
    const { u, begin, turn, log } = scene([
      { seat: 'pc1', team: 'party', use: 'test:sample-druid', at: 'A4' },
      { seat: 'hurt', team: 'party', use: 'srd:warrior-veteran', at: 'F4', hp: 9 },
      { seat: 'safe', team: 'party', use: 'srd:warrior-veteran', at: 'A1', hp: 9 },
      { seat: 'g1', team: 'enemies', use: 'srd:goblin-boss', at: 'G4' },
      { seat: 'g2', team: 'enemies', use: 'srd:goblin-boss', at: 'G5' },
    ]);
    const pc = u('pc1');
    begin(pc);
    pc.b.action = 0;
    expect(turn(pc)).toMatch(/^cast:healing-word@/);
    expect(log()).toMatch(/chooses target:hurt/);
  });

  it('at very low HP next to two foes it heals itself first (greedy v4: the post-heal end cost counts)', () => {
    const { u, begin, turn, log } = scene([
      { seat: 'pc1', team: 'party', use: 'test:sample-druid', at: 'D4', hp: 3 },
      { seat: 'g1', team: 'enemies', use: 'srd:goblin-boss', at: 'E4' },
      { seat: 'g2', team: 'enemies', use: 'srd:goblin-boss', at: 'D5' },
    ]);
    const pc = u('pc1');
    begin(pc);
    expect(turn(pc)).toMatch(/^cast:healing-word@/);
    expect(log()).toMatch(/chooses target:pc1/);
  });

  it('a heal scripted without greedy\'s turn decision (a policy rule, a journal) still targets the 3-HP caster, not a safe ally', () => {
    const { u, begin, take, log } = scene([
      { seat: 'pc1', team: 'party', use: 'test:sample-druid', at: 'D4', hp: 3 },
      { seat: 'safe', team: 'party', use: 'srd:warrior-veteran', at: 'A1', hp: 30 },
      { seat: 'g1', team: 'enemies', use: 'srd:goblin-boss', at: 'E4' },
      { seat: 'g2', team: 'enemies', use: 'srd:goblin-boss', at: 'D5' },
    ]);
    const pc = u('pc1');
    begin(pc);
    take(pc, 'cast:healing-word@1'); // greedy never scored this turn: its exposure must be built for the target choice
    expect(log()).toMatch(/chooses target:pc1/);
  });

  it('at full HP a self-heal never outranks the turn\'s best option, wherever the foes stand', () => {
    const cells = ['B2', 'C5', 'E4', 'F6', 'H2', 'J7', 'D1', 'G4'];
    for (let a = 0; a < cells.length; a++)
      for (let b = a + 1; b < cells.length; b++) {
        const { u, begin, turn } = scene([
          { seat: 'pc1', team: 'party', use: 'test:sample-druid', at: 'D4' },
          { seat: 'g1', team: 'enemies', use: 'srd:goblin-boss', at: cells[a]! },
          { seat: 'g2', team: 'enemies', use: 'srd:goblin-warrior', at: cells[b]! },
        ]);
        const pc = u('pc1');
        begin(pc);
        expect(turn(pc, true), `foes at ${cells[a]} and ${cells[b]}`).not.toMatch(/^cast:healing-word@/);
      }
  });

  it('keeps a standing ally up: heals the ally about to drop before it drops, over an attack', () => {
    const { u, begin, turn, log } = scene([
      { seat: 'pc1', team: 'party', use: 'test:sample-druid', at: 'A4' },
      { seat: 'hurt', team: 'party', use: 'srd:warrior-veteran', at: 'F4', hp: 4 },
      { seat: 'g1', team: 'enemies', use: 'srd:goblin-boss', at: 'G4' },
      { seat: 'g2', team: 'enemies', use: 'srd:goblin-boss', at: 'G5' },
    ]);
    const pc = u('pc1');
    begin(pc);
    expect(turn(pc)).toMatch(/^cast:healing-word@/);
    expect(log()).toMatch(/chooses target:hurt/);
  });

  it('pulls a spear-thrower through its own spikes', () => {
    const { u, begin, turn, take, log, ds } = scene([
      { seat: 'pc1', team: 'party', use: 'test:sample-druid', at: 'A4' },
      { seat: 'gob', team: 'enemies', use: 'srd:warrior-infantry', at: 'F4' },
      { seat: 'far', team: 'enemies', use: 'srd:warrior-infantry', at: 'L8' },
    ]);
    const pc = u('pc1');
    // Spear-throwers (20 ft normal range) have to walk to the caster, so the spikes are worth keeping.
    // Grow the spikes centered on G4 (a scripted placement), then let the greedy play the turn.
    const greedy = ds[pc.idx]!;
    ds[pc.idx] = { name: 'script', decide: (_v, dp) => (dp.k === 'place' ? Array.from({ length: dp.legal.n }, (_, i) => i).find((i) => dp.keyOf(i) === 'place:G4')! : 0) };
    begin(pc);
    take(pc, 'cast:spike-growth@2');
    ds[pc.idx] = greedy;
    begin(pc);
    let key = '';
    for (let k = 0; k < 4; k++) if ((key = turn(pc)).startsWith('cast:tether') || key === 'pass') break;
    expect(key, log()).toMatch(/^cast:tether/);
    const after = log().split('casts Tether')[1] ?? '';
    if (/-> gob: .* hit/.test(after)) expect(after).toMatch(/gob takes \d+ \(\d+ piercing\) from Spike Growth/);
  });

  it('spends a pre-roll reaction on a hit that\'s in doubt, not on a sure miss', () => {
    const reactOn = (ac: number) => {
      const s = make([
        { seat: 'seer', team: 'party', use: 'test:sample-seer', at: 'B2' },
        { seat: 'ally', team: 'party', use: 'srd:warrior-veteran', at: 'D2' },
        { seat: 'gob', team: 'enemies', use: 'srd:goblin-warrior', at: 'E2' },
      ]);
      const cx = createContext(s, 1, 0, s.seats.map(() => new GreedyDecider()), null);
      const seer = cx.st.units.find((x) => x.seat === 'seer')!;
      const gob = cx.st.units.find((x) => x.seat === 'gob')!;
      const ally = cx.st.units.find((x) => x.seat === 'ally')!;
      const atk = gob.tpl.attacks.find((a) => a.local === 'scimitar')!;
      const list = takeList(cx);
      list.n = 0;
      const items = [{ k: 'pass' }, ...seer.tpl.features.flatMap((f, opt) => (f.preRoll ? [{ k: 'react', opt, aux: f.preRoll.sign === 0 ? -1 : f.preRoll.sign }] : []))];
      for (const it of items) {
        if (!list.items[list.n]) list.items.push(newLegal());
        Object.assign(list.items[list.n++]!, newLegal(), it);
      }
      const dp: DecisionPoint = {
        k: 'preRoll', who: seer.idx, at: 0, round: 1, cause: -1, legal: list, keyOf: (i) => String(i),
        roll: { kind: 'attack', adv: 'none', flat: atk.toHit, preDice: [], dc: ac }, roller: gob.idx, rollTarget: ally.idx, rollVia: atk.id,
      };
      const i = new GreedyDecider().decide(cx.views[seer.idx]!, dp);
      return list.items[i]!.k;
    };
    expect(reactOn(15)).toBe('react');
    expect(reactOn(30)).toBe('pass'); // only a natural 20 hits: the die changes nothing
  });

  it('explain records change nothing: the same logs with and without a sink (resolution 8)', () => {
    const s = loadScenario('scenarios/stars-ambush.yaml', CONTENT);
    let records = 0;
    for (let run = 0; run < 12; run++) {
      const plain = new HashSink();
      const told = new HashSink();
      runFight(s, 3, run, makeDeciders(s), plain);
      const ds = makeDeciders(s);
      for (const d of ds) d.explainTo?.(() => records++);
      runFight(s, 3, run, ds, told);
      expect(told.hex(), `run ${run}`).toBe(plain.hex());
    }
    expect(records).toBeGreaterThan(100);
  });

  it('fights with casters replay identically, and one decider reused across fights decides like fresh ones', () => {
    const s = make([
      { seat: 'pc1', team: 'party', use: 'test:sample-druid', at: 'B6' },
      { seat: 'pc2', team: 'party', use: 'test:sample-seer', at: 'C7' },
      { seat: 'g1', team: 'enemies', use: 'srd:goblin-boss', at: 'J2' },
      { seat: 'g2', team: 'enemies', use: 'srd:goblin-warrior', at: 'K3' },
      { seat: 'g3', team: 'enemies', use: 'srd:goblin-warrior', at: 'I4' },
    ]);
    const shared = makeDeciders(s);
    for (let run = 0; run < 6; run++) {
      const a = new HashSink();
      const b = new HashSink();
      const c = new HashSink();
      runFight(s, 4, run, makeDeciders(s), a);
      runFight(s, 4, run, makeDeciders(s), b);
      runFight(s, 4, run, shared, c);
      expect([b.hex(), c.hex()], `run ${run}`).toEqual([a.hex(), a.hex()]);
    }
  });
});
