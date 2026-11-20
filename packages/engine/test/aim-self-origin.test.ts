// Coverage step 7.2: aimed and self-origin areas, end to end through the compiler: the engine's aim
// decision (keys aim:N...), a group's one damage roll, an emanation around its caster, the shared aim
// search the AI values with and casts with, destination candidates and the next-turn credit, and
// the same seam on a feature activation. Spells are synthetic (test: ids) except the SRD kit a
// caster holds in the Wizard case.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../src/content/load.ts';
import { AIM_LIMIT } from '../src/content/compile-spell.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import type { Decider, DecisionPoint, Legal } from '../src/decide/decider.ts';
import { GreedyDecider, type ExplainRecord } from '../src/decide/greedy/greedy.ts';
import { JournalCursor, JournalDecider } from '../src/decide/journal.ts';
import { namedDecider } from '../src/decide/make.ts';
import { AIMS, areaCellsFrom, creatureMaskLookup, sizeFtOf } from '../src/grid/area.ts';
import { parseCell } from '../src/grid/cells.ts';
import { COVER } from '../src/grid/los.ts';
import { ArraySink, HashSink, type GameEvent as LogEvent } from '../src/log/events.ts';
import { aimCandidates as aimQuery, areaCandidates, type AimCand, type AreaCand } from '../src/query/area.ts';
import { resolveScenario } from '../src/scenario/resolve.ts';
import { resolveOption } from '../src/sim/act.ts';
import { copyLegal, legalKey, newLegal, releaseList, takeList } from '../src/sim/context.ts';
import { createContext, runFight } from '../src/sim/fight.ts';
import { listOptions } from '../src/sim/options.ts';
import { applyPassives } from '../src/sim/precast.ts';
import { stateHash, type Unit } from '../src/sim/state.ts';

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

const aimedSpell = (id: string, zone: string, roll = '3d6', duration = '{ rounds: 1 }') => `kind: spell
id: test:${id}
name: ${id}
source: synthetic test fixture
level: 1
castingTime: action
range: self
components: { v: true, s: true }
duration: instant
area: blast
effects:
  - id: blast
    name: ${id}
    zone: ${zone}
    duration: ${duration}
    on: [{ when: [appear], do: [{ save: { ability: dex, half: true, damage: [{ roll: ${roll}, type: fire }] } }] }]
do: [{ apply: { effect: blast, to: point } }]
`;
const SPELLS: Record<string, string> = {
  'packs/test/spells/aim-cone.yaml': aimedSpell('aim-cone', '{ shape: cone, size: 15 }'),
  'packs/test/spells/aim-wide.yaml': aimedSpell('aim-wide', '{ shape: cone, size: 30 }'),
  'packs/test/spells/aim-huge.yaml': aimedSpell('aim-huge', '{ shape: cone, size: 90 }'),
  'packs/test/spells/aim-line.yaml': aimedSpell('aim-line', '{ shape: line, size: 30, width: 5 }'),
  'packs/test/spells/aim-wave.yaml': aimedSpell('aim-wave', '{ shape: cube, size: 15 }'),
  'packs/test/spells/aim-aura.yaml': aimedSpell('aim-aura', '{ shape: emanation, size: 10 }').replace('duration: instant', 'duration: { minutes: 1 }').replace('components: { v: true, s: true }', 'components: { v: true, s: true }\nconcentration: true').replace('duration: { rounds: 1 }', 'duration: parent'),
};

const PC = (spells: string[], opt: { cantrips?: string[]; features?: string[]; slots?: number[] } = {}) => `kind: pc
id: test:aim-pc
name: Aim PC
source: synthetic test fixture
rules: '2024'
level: 5
size: medium
speed: 30
abilities: { str: 8, dex: 12, con: 14, int: 18, wis: 10, cha: 8 }
hpMax: 44
ac: 14
armor: none
saveProficiencies: [int, wis]
items:
  - { id: wand, name: Wand, kind: focus, focusFor: [wizard] }
hands: [wand, null]
weapons:
  - { id: club, name: Club, kind: melee, ability: str, category: simple, damage: [{ roll: 1d4 + @mod, type: bludgeoning }] }
features: [${(opt.features ?? []).map((f) => `test:${f}`).join(', ')}]
slots: [${(opt.slots ?? [4, 3, 2]).join(', ')}]
casting:
  - { source: wizard, ability: int, list: wizard, cantrips: [${(opt.cantrips ?? []).join(', ')}], prepared: [${spells.join(', ')}] }
`;
const monster = (id: string, hp: number, dex = 12, walk = 0) => `kind: monster
id: test:${id}
name: ${id}
source: synthetic test fixture
size: medium
cr: 1
pb: 2
ac: 12
hp: { average: ${hp}, formula: '${hp}' }
speed: { walk: ${walk} }
initiative: { mod: 0, score: 10 }
abilities: { str: 14, dex: ${dex}, con: 12, int: 10, wis: 10, cha: 10 }
attacks:
  - { id: claw, name: Claw, kind: melee, toHit: 0, damage: [{ roll: '1', type: slashing, avg: 1 }] }
`;
const KIT: Record<string, string> = {
  ...SPELLS,
  'packs/test/monsters/aim-foe.yaml': monster('aim-foe', 60),
  'packs/test/monsters/aim-frail.yaml': monster('aim-frail', 6, 1),
  'packs/test/monsters/aim-tank.yaml': monster('aim-tank', 500, 30),
  'packs/test/features/aim-breath.yaml': `kind: feature
id: test:aim-breath
name: aim-breath
source: synthetic test fixture
spellAbility: int
effects:
  - id: gust
    name: Gust
    zone: { shape: cone, size: 15 }
    duration: { rounds: 1 }
    on: [{ when: [appear], do: [{ save: { ability: dex, half: true, damage: [{ roll: 3d6, type: cold }] } }] }]
activate: { id: gust-use, name: Gust, cost: action, area: gust, do: [{ apply: { effect: gust, to: point } }] }
`,
  'packs/test/features/aim-pulse.yaml': `kind: feature
id: test:aim-pulse
name: aim-pulse
source: synthetic test fixture
spellAbility: int
effects:
  - id: pulse
    name: Pulse
    zone: { shape: sphere, radius: 10 }
    duration: { rounds: 1 }
    on: [{ when: [appear], do: [{ save: { ability: dex, half: true, damage: [{ roll: 3d6, type: cold }] } }] }]
activate: { id: pulse-use, name: Pulse, cost: action, area: pulse, range: 30, do: [{ apply: { effect: pulse, to: point } }] }
`,
};

type U = { seat: string; team: 'party' | 'enemies'; use: string; at: string };
const pc = (at: string, seat = 'pc'): U => ({ seat, team: 'party', use: 'test:aim-pc', at });
const foe = (seat: string, at: string, use = 'aim-foe'): U => ({ seat, team: 'enemies', use: `test:${use}`, at });

class LoadFailed extends Error {}
/** A pack load takes 150 ms: one per kit. */
const loads = new Map<string, ReturnType<typeof loadContent>>();

function setupOf(pcText: string, units: U[], opt: { flags?: Record<string, unknown>; terrain?: string[]; extra?: Record<string, string>; w?: number; h?: number; decider?: string; precast?: unknown } = {}) {
  const ownFiles = Object.entries({ ...KIT, ...opt.extra, 'packs/test/pcs/aim-pc.yaml': pcText }).map(([path, text]) => ({ path, text }));
  const memoKey = JSON.stringify(ownFiles);
  const r = loads.get(memoKey) ?? loadContent([...REPO, ...ownFiles]);
  loads.set(memoKey, r);
  if (!r.content) throw new LoadFailed(r.errors.map(formatDiag).join('\n'));
  const doc = {
    kind: 'scenario', id: 'aim', name: 'Aim', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: { w: opt.w ?? 16, h: opt.h ?? 16, ...(opt.terrain ? { terrain: opt.terrain } : {}) },
    flags: { initiativeMode: 'static', ...opt.flags }, knobs: { downEnds: false, maxRounds: 3 },
    units: units.map((u, i) => ({ ...u, decider: opt.decider ?? 'greedy', ...(i === 0 && opt.precast ? { precast: opt.precast } : {}) })),
  };
  const res = resolveScenario(doc, 'aim.yaml', r.content);
  return { res, content: r.content, loadErrors: r.errors };
}
function must(pcText: string, units: U[], opt: Parameters<typeof setupOf>[2] = {}) {
  const { res } = setupOf(pcText, units, opt);
  if (!res.setup) throw new Error(res.errors.map(formatDiag).join('\n'));
  return res.setup;
}

/** A constructed turn: every seat greedy, an explain sink, the test's own stepping. */
function scene(pcText: string, units: U[], opt: Parameters<typeof setupOf>[2] = {}) {
  const s = must(pcText, units, opt);
  const sink = new ArraySink();
  const ds = s.seats.map(() => new GreedyDecider());
  const cx = createContext(s, 1, 0, ds, sink);
  applyPassives(cx, -1);
  const records: ExplainRecord[] = [];
  for (const d of ds) d.explainTo((x) => records.push(x));
  const u = (seat: string): Unit => cx.st.units.find((x) => x.seat === seat)!;
  const begin = (who: Unit) => {
    cx.st.active = who.idx;
    cx.st.turnIdx++;
    who.turns++;
    Object.assign(who.b, { action: 1, bonus: 1, reaction: 1, freeObj: 1, moveFt: who.tpl.speedFt, atkActive: false, movedFt: 0 });
  };
  const options = (who: Unit) => {
    const list = listOptions(cx, who, takeList(cx));
    const items: Legal[] = [];
    const keys: string[] = [];
    for (let i = 0; i < list.n; i++) {
      keys.push(legalKey(cx.st, who.idx, list.items[i]!));
      items.push(copyLegal(list.items[i]!, newLegal()));
    }
    releaseList(cx, list);
    const dp: DecisionPoint = { k: 'turn', who: who.idx, at: 0, round: 1, cause: -1, legal: { n: items.length, items }, keyOf: (i) => keys[i]! };
    return { items, keys, dp };
  };
  const decide = (who: Unit) => {
    const { items, keys, dp } = options(who);
    records.length = 0;
    const i = ds[who.idx]!.decide(cx.views[who.idx]!, dp);
    return { key: keys[i]!, item: items[i]!, rec: records.at(-1)! };
  };
  /** One whole turn through the engine: the keys taken, pass last. */
  const turn = (who: Unit): string[] => {
    begin(who);
    const out: string[] = [];
    for (let k = 0; k < 12; k++) {
      const { item, key } = decide(who);
      out.push(key);
      if (item.k === 'pass') break;
      resolveOption(cx, who, item, -1);
    }
    return out;
  };
  return { s, cx, u, ds, begin, options, decide, turn, sink, records };
}
const cell = (s: { w: number; h: number }, name: string) => parseCell(name, s.w, s.h);
const zoneEvents = (sink: ArraySink) => (sink.events as LogEvent[]).filter((e): e is Extract<LogEvent, { k: 'zone' }> => e.k === 'zone');
const aimKey = (sink: ArraySink) => zoneEvents(sink).at(-1)!.anchor.split('>')[1];

/** Answers every sub-decision with `key`. */
const answering = (key: string): Decider => ({ name: 'answering', decide: (_v, dp) => { for (let i = 0; i < dp.legal.n; i++) if (dp.keyOf(i) === key) return i; return 0; } });

/** Seat 0 takes a fresh turn and casts or uses `key`, its sub-decisions going through its decider. */
function castAs(cx: ReturnType<typeof createContext>, key: string): void {
  const who = cx.st.units[0]!;
  cx.st.active = 0;
  cx.st.turnIdx++;
  who.turns++;
  Object.assign(who.b, { action: 1, bonus: 1, reaction: 1, freeObj: 1, moveFt: 30, atkActive: false, movedFt: 0 });
  const list = listOptions(cx, who, takeList(cx));
  let item: Legal | null = null;
  for (let i = 0; i < list.n; i++) if (legalKey(cx.st, 0, list.items[i]!) === key) item = copyLegal(list.items[i]!, newLegal());
  releaseList(cx, list);
  if (!item) throw new Error(`${key} isn't offered`);
  resolveOption(cx, who, item, -1);
}

describe('the compiler', () => {
  const errorsOf = (path: string, text: string): string => {
    try {
      return setupOf(PC([]), [pc('A1'), foe('x1', 'P16')], { extra: { [path]: text } }).loadErrors.map(formatDiag).join('\n');
    } catch (e) {
      if (e instanceof LoadFailed) return e.message;
      throw e;
    }
  };
  const load = (text: string) => errorsOf('packs/test/spells/bad.yaml', text);
  it('a Cone, a Line and a Cube from Self are aimed, an Emanation is around its caster, and they print the 8-aim limit', () => {
    const s = must(PC(['test:aim-cone', 'test:aim-line', 'test:aim-wave', 'test:aim-aura']), [pc('A1'), foe('x1', 'P16')]);
    const sp = s.seats[0]!.tpl.spells.map((e) => e.spell);
    expect(sp.map((x) => [x.local, x.areaFrom])).toEqual([['aim-cone', 'aim'], ['aim-line', 'aim'], ['aim-wave', 'aim'], ['aim-aura', 'bearer']]);
    expect(sp[0]!.unimplemented).toContain(AIM_LIMIT);
    expect(sp[3]!.unimplemented).not.toContain(AIM_LIMIT);
  });
  it('a Cone at a range is refused: it starts from its creator', () => {
    expect(load(aimedSpell('bad', '{ shape: cone, size: 15 }').replace('range: self', 'range: 60'))).toMatch(/a cone starts from its creator/);
    expect(load(aimedSpell('bad', '{ shape: emanation, size: 15 }').replace('range: self', 'range: 60'))).toMatch(/an? emanation starts from its creator/);
  });
  it('a Cube at a range stays on the lattice', () => {
    const s = must(PC(['test:far-cube']), [pc('A1'), foe('x1', 'P16')], { extra: { 'packs/test/spells/far-cube.yaml': aimedSpell('far-cube', '{ shape: cube, size: 20 }').replace('range: self', 'range: 60') } });
    expect(s.seats[0]!.tpl.spells[0]!.spell.areaFrom).toBeUndefined();
    expect(s.seats[0]!.tpl.effects.find((e) => e.zone)!.zone!.from).toBeUndefined();
  });
  it('a sphere from Self keeps its lattice form (range 0)', () => {
    const s = must(PC(['test:self-sphere']), [pc('A1'), foe('x1', 'P16')], { extra: { 'packs/test/spells/self-sphere.yaml': aimedSpell('self-sphere', '{ shape: sphere, radius: 10 }') } });
    expect(s.seats[0]!.tpl.spells[0]!.spell.areaFrom).toBeUndefined();
  });
  it('moveZone on an area that starts from its creator is refused', () => {
    const text = aimedSpell('bad', '{ shape: cone, size: 15 }').replace('duration: { rounds: 1 }', 'duration: { rounds: 1 }\n    grants: [{ id: m, name: Move, cost: action, do: [{ moveZone: { ft: 30 } }] }]');
    expect(load(text)).toMatch(/moveZone can't move it/);
  });
  it('an activation with `area` can place a zone; without it, it still can\'t', () => {
    expect(() => must(PC([], { features: ['aim-breath'] }), [pc('A1'), foe('x1', 'P16')])).not.toThrow();
    const text = (KIT['packs/test/features/aim-breath.yaml'] as string).replace(' area: gust,', '').replace('test:aim-breath', 'test:bad-breath');
    expect(errorsOf('packs/test/features/bad.yaml', text)).toMatch(/activation with area/);
  });
  it('an activation\'s `range` needs `area`, and a feature activation\'s area is compiled onto it', () => {
    const text = (KIT['packs/test/features/aim-pulse.yaml'] as string).replace(' area: pulse,', '').replace('test:aim-pulse', 'test:bad-pulse');
    expect(errorsOf('packs/test/features/bad.yaml', text)).toMatch(/range is the range of an area/);
    const s = must(PC([], { features: ['aim-breath', 'aim-pulse'] }), [pc('A1'), foe('x1', 'P16')]);
    const areas = s.seats[0]!.tpl.features.map((f) => f.activate?.area);
    expect(areas[0]!.from).toBe('aim');
    expect(areas[1]).toEqual({ shape: expect.any(Number), rangeFt: 30 });
  });
});

describe('the engine: aim, self-origin, one damage roll', () => {
  it('the cast asks 8 aims in a fixed order, unique, then every creature in the cone saves against one damage roll', () => {
    const asked: string[][] = [];
    const s = must(PC(['test:aim-cone']), [pc('H8'), foe('x1', 'I8'), foe('x2', 'J8'), foe('x3', 'I6')]);
    const recorder: Decider = { name: 'r', decide: (_v, dp) => { const k = Array.from({ length: dp.legal.n }, (_, i) => dp.keyOf(i)); asked.push(k); return k.indexOf('aim:E'); } };
    const sink = new ArraySink();
    const cx = createContext(s, 7, 0, s.seats.map((_, i) => (i === 0 ? recorder : new GreedyDecider())), sink);
    applyPassives(cx, -1);
    castAs(cx, 'cast:aim-cone@1');
    expect(asked).toEqual([AIMS.map((a) => `aim:${a}`)]);
    expect(new Set(asked[0]).size).toBe(8);
    const z = zoneEvents(sink)[0]!;
    expect(z.anchor).toBe('H8>E');
    const covered = z.area!;
    expect(covered).toContain(cell(s, 'I8'));
    expect(covered).toContain(cell(s, 'J8'));
    expect(covered).not.toContain(cell(s, 'I6'));
    expect(covered).not.toContain(cell(s, 'H8')); // a Cone's origin isn't included
    expect((sink.events as LogEvent[]).filter((e) => e.k === 'save').map((e) => (e as { who: number }).who).sort()).toEqual([1, 2]);
    // One roll for the group (srd p.16): whoever saved takes half of the same number.
    const dealt = (sink.events as LogEvent[]).filter((e) => e.k === 'damage').map((e) => (e as { dealt: number }).dealt);
    expect(dealt.length).toBeGreaterThan(0);
    const most = Math.max(...dealt);
    for (const d of dealt) expect([most, Math.floor(most / 2)]).toContain(d);
    expect(cx.st.fx.find((f) => f.zbit >= 0 || f.aim !== undefined)?.aim).toBe(AIMS.indexOf('E'));
  });
  it('Fx.aim holds the aim, and only on the aimed zone', () => {
    const at = (aim: string) => {
      const cx = createContext(must(PC(['test:aim-cone']), [pc('H8'), foe('x1', 'H2', 'aim-tank')]), 7, 0, [answering(aim), new GreedyDecider()], null);
      applyPassives(cx, -1);
      castAs(cx, 'cast:aim-cone@1');
      return cx.st.fx.map((f) => f.aim);
    };
    expect(at('aim:N')).toContain(0);
    expect(at('aim:NW')).toContain(7);
  });
  it('an aimed zone hashes differently from the same zone aimed elsewhere, with every square equal', () => {
    // Off the map to the north, N and NW both cover nothing: only `am` tells the two apart.
    const at = (aim: string) => {
      const s = must(PC(['test:aim-cone']), [pc('A1'), foe('x1', 'P16', 'aim-tank')]);
      const rec = answering(aim);
      const cx = createContext(s, 7, 0, [rec, new GreedyDecider()], null);
      applyPassives(cx, -1);
      castAs(cx, 'cast:aim-cone@1');
      return stateHash(cx.st);
    };
    expect(at('aim:N')).not.toBe(at('aim:NW'));
  });
  it('an emanation asks nothing and lands around its caster, name and squares both, under either areaOriginOnGrid', () => {
    for (const areaOriginOnGrid of ['squareCenter', 'gridIntersection']) {
      const s = must(PC(['test:aim-aura']), [pc('H8'), foe('x1', 'I8'), foe('x2', 'L8')], { flags: { areaOriginOnGrid } });
      const asked: string[] = [];
      const rec: Decider = { name: 'r', decide: (_v, dp) => { asked.push(dp.k); return 0; } };
      const sink = new ArraySink();
      const cx = createContext(s, 7, 0, [rec, new GreedyDecider(), new GreedyDecider()], sink);
      applyPassives(cx, -1);
      castAs(cx, 'cast:aim-aura@1');
      expect(asked).not.toContain('place');
      const z = zoneEvents(sink)[0]!;
      expect(z.anchor).toBe('H8');
      expect(z.area!).toContain(cell(s, 'I8'));
      expect(z.area!).not.toContain(cell(s, 'H8')); // origin not included
      expect(z.area!).not.toContain(cell(s, 'L8'));
      expect(z.cells).toBe(24); // a 10-ft Emanation is the 5 x 5 block less its origin, under gridDistance
      expect(cx.st.fx.some((f) => f.aim !== undefined)).toBe(false);
    }
  });
  it('an aimed zone lands on the same squares under either areaOriginOnGrid: it never reads the lattice', () => {
    const squares = (areaOriginOnGrid: string) => {
      const s = must(PC(['test:aim-cone']), [pc('H8'), foe('x1', 'I8')], { flags: { areaOriginOnGrid } });
      const rec = answering('aim:E');
      const sink = new ArraySink();
      const cx = createContext(s, 7, 0, [rec, new GreedyDecider()], sink);
      applyPassives(cx, -1);
      castAs(cx, 'cast:aim-cone@1');
      const out: number[] = [];
      areaCellsFrom(cx.st, s.seats[0]!.tpl.effects.find((e) => e.zone)!.zone!.shapeKey, cx.st.units[0]!.cell, AIMS.indexOf('E'), out);
      return { z: zoneEvents(sink)[0]!, out };
    };
    const a = squares('squareCenter');
    const b = squares('gridIntersection');
    expect(a.z.anchor).toBe('H8>E');
    expect(b.z.anchor).toBe('H8>E');
    expect(a.z.area).toEqual(a.out);
    expect(b.z.area).toEqual(a.out);
  });
  it('a Dexterity save\'s cover comes from the point of origin at the creature, under either areaOriginOnGrid', () => {
    // '+' on I9 stands between the caster on H9 and the foe on J9: Half Cover from that origin (srd-raw.txt:2006-2017).
    // Read as a corner lattice (17 wide), the number of H9 is a point far off to the east, on the foe's open side.
    const terrain = Array.from({ length: 12 }, (_, y) => (y === 8 ? '........+.......' : '................'));
    for (const areaOriginOnGrid of ['squareCenter', 'gridIntersection']) {
      const s = must(PC(['test:aim-line']), [pc('H9'), foe('x1', 'J9')], { terrain, w: 16, h: 12, flags: { areaOriginOnGrid } });
      const sink = new ArraySink();
      const cx = createContext(s, 7, 0, [answering('aim:E'), new GreedyDecider()], sink);
      applyPassives(cx, -1);
      castAs(cx, 'cast:aim-line@1');
      expect(zoneEvents(sink)[0]!.anchor).toBe('H9>E');
      expect((sink.events as LogEvent[]).filter((e) => e.k === 'save').map((e) => (e as { cover?: number }).cover)).toEqual([COVER.half]);
    }
  });
  it('the AI reads that cover too: with one foe in the open and one behind Half Cover, it aims at the open one', () => {
    const terrain = ['................', '................', '................', '................', '........+.......', '................', '................', '................'];
    for (const areaOriginOnGrid of ['squareCenter', 'gridIntersection']) {
      const t = scene(PC(['test:aim-line']), [pc('H5'), foe('x1', 'J5'), foe('x2', 'H3')], { terrain, w: 16, h: 8, flags: { areaOriginOnGrid } });
      castAs(t.cx, 'cast:aim-line@1');
      expect(zoneEvents(t.sink)[0]!.anchor).toBe('H5>N');
    }
  });
  it('a lattice Cube at a range still asks for an anchor', () => {
    const s = must(PC(['test:far-cube']), [pc('H8'), foe('x1', 'J8')], { extra: { 'packs/test/spells/far-cube.yaml': aimedSpell('far-cube', '{ shape: cube, size: 20 }').replace('range: self', 'range: 60') } });
    const asked: string[] = [];
    const rec: Decider = { name: 'r', decide: (_v, dp) => { asked.push(dp.keyOf(0)); return 0; } };
    const cx = createContext(s, 7, 0, [rec, new GreedyDecider()], null);
    applyPassives(cx, -1);
    castAs(cx, 'cast:far-cube@1');
    expect(asked[0]).toMatch(/^place:/);
  });
});

describe('stateHash', () => {
  it('a lattice zone hashes as it always did: `am` is only there for an aimed one', () => {
    // Pinned: the same hash with the `am` field deleted from sim/state.ts (checked when this was written). A real field written for every effect moves every report's runs hash.
    const s = must(PC(['test:conc-ward']), [pc('H8'), foe('x1', 'I8', 'aim-tank')], { flags: { focusHandSomatic: 'lenient' } });
    const cx = createContext(s, 7, 0, [answering('place:I8'), new GreedyDecider()], null);
    applyPassives(cx, -1);
    castAs(cx, 'cast:conc-ward@1');
    expect(cx.st.fx.some((f) => f.zbit >= 0)).toBe(true);
    expect(stateHash(cx.st)).toBe('693e7f3246cb3eea');
  });
});

describe('precast', () => {
  it('an aimed shape is refused with a clear error', () => {
    const { res } = setupOf(PC(['test:aim-cone']), [pc('H8'), foe('x1', 'I8')], { precast: [{ cast: 'test:aim-cone', level: 1 }] });
    expect(res.errors.map(formatDiag).join('\n')).toMatch(/aimed area can't be precast/);
  });
  it('an emanation needs no `at`, and refuses one', () => {
    const none = setupOf(PC(['test:aim-aura']), [pc('H8'), foe('x1', 'I8')], { precast: [{ cast: 'test:aim-aura', level: 1 }] });
    expect(none.res.errors.map(formatDiag).join('\n')).toBe('');
    const sink = new ArraySink();
    runFight(none.res.setup!, 3, 0, none.res.setup!.seats.map(() => new GreedyDecider()), sink);
    expect(zoneEvents(sink)[0]!.anchor).toBe('H8');
    const given = setupOf(PC(['test:aim-aura']), [pc('H8'), foe('x1', 'I8')], { precast: [{ cast: 'test:aim-aura', level: 1, at: 'H8' }] });
    expect(given.res.errors.map(formatDiag).join('\n')).toMatch(/no square to give/);
  });
});

describe('journals', () => {
  const J = (entries: { seat: string; key: string }[]) => new JournalCursor(entries.map((e) => ({ ...e })));
  const units = [pc('H8'), foe('x1', 'I8'), foe('x2', 'J8')];
  const fight = (keys: string[], fb: () => Decider | null, seed = 3) => {
    const s = must(PC(['test:aim-cone']), units);
    const cursor = J(keys.map((key) => ({ seat: 'pc', key })));
    const sink = new ArraySink();
    const journal = new JournalDecider(cursor, fb());
    const r = runFight(s, seed, 0, s.seats.map((_, i) => (i === 0 ? journal : new GreedyDecider())), sink);
    return { sink, r, journal };
  };
  it('aim: keys round trip: the journal\'s aim is the one stamped', () => {
    const { sink } = fight(['cast:aim-cone@1', 'aim:SW'], () => new GreedyDecider());
    expect(zoneEvents(sink)[0]!.anchor).toBe('H8>SW');
  });
  it('a recorded choice replays to the same state hash', () => {
    const a = fight(['cast:aim-cone@1', 'aim:E'], () => new GreedyDecider());
    const b = fight(['cast:aim-cone@1', 'aim:E'], () => new GreedyDecider());
    expect(a.r.stateHash).toBe(b.r.stateHash);
  });
  it('a journal ending mid-cast hands the aim to the AI, which values it the same way', () => {
    const { sink, journal } = fight(['cast:aim-cone@1'], () => new GreedyDecider());
    expect(zoneEvents(sink)[0]!.anchor).toBe('H8>E');
    expect(journal.lastBy).not.toBe('journal');
  });
});

describe('greedy: the aim', () => {
  it('picks the aim covering the most enemies', () => {
    const t = scene(PC(['test:aim-cone']), [pc('H8'), foe('x1', 'I8'), foe('x2', 'J8'), foe('x3', 'G8')]);
    const out = t.turn(t.u('pc'));
    expect(out).toContain('cast:aim-cone@1');
    expect(aimKey(t.sink)).toBe('E');
  });
  it('avoids an ally: friendly fire costs more than a second foe gives', () => {
    const t = scene(PC(['test:aim-cone']), [pc('H8'), { seat: 'qa', team: 'party', use: 'test:aim-foe', at: 'J8' }, foe('x1', 'I8'), foe('x2', 'G8')]);
    t.turn(t.u('pc'));
    expect(aimKey(t.sink)).toBe('W');
  });
  it('casts what it valued: place() and the option\'s value read the same search', () => {
    const t = scene(PC(['test:aim-cone']), [pc('H8'), foe('x1', 'H7'), foe('x2', 'H6')]);
    t.begin(t.u('pc'));
    const { rec, key } = t.decide(t.u('pc'));
    expect(key).toBe('cast:aim-cone@1');
    expect(rec.top.find((r) => r.key === key)!.parts.map((p) => p.term)).toContain('aim: 2 creatures');
    resolveOption(t.cx, t.u('pc'), t.decide(t.u('pc')).item, -1);
    expect(aimKey(t.sink)).toBe('N');
  });
  it('a duplicate set doesn\'t crowd out another: three aims hold one foe, a fourth the frail one it would kill', () => {
    // A 15-ft Cube from Self: I7 touches the N, NE and E placements; F10 only the SW one. Without
    // deduping, the three copies of {tank} fill the 3 kept sets and SW is never valued.
    const t = scene(PC(['test:aim-wave']), [pc('H8'), foe('xt', 'I7', 'aim-tank'), foe('xf', 'F10', 'aim-frail')]);
    const out = t.turn(t.u('pc'));
    expect(out).toContain('cast:aim-wave@1');
    expect(aimKey(t.sink)).toBe('SW');
  });
  it('allies count double against a set in the search: three sets with an ally don\'t crowd out the clean one', () => {
    // An ally on I7 is in the N, NE and E placements of a 15-ft Cube from H8, each with its own foe; a frail foe on F10 is alone in SW.
    const t = scene(PC(['test:aim-wave']), [pc('H8'), { seat: 'qa', team: 'party', use: 'test:aim-foe', at: 'I7' }, foe('x1', 'H6'), foe('x2', 'K5'), foe('x3', 'K8'), foe('xf', 'F10', 'aim-frail')]);
    t.turn(t.u('pc'));
    expect(aimKey(t.sink)).toBe('SW');
  });
  it('the zone cache keeps aims apart: two aims from one square aren\'t one value', () => {
    // Fixed: only the E aim covers anyone useful; with one key per origin, whichever aim is valued first wins.
    const t = scene(PC(['test:aim-cone']), [pc('H8'), foe('xt', 'H7', 'aim-tank'), foe('xf', 'I8', 'aim-frail')]);
    t.turn(t.u('pc'));
    expect(aimKey(t.sink)).toBe('E');
  });
  it('with only an ally coverable, no aim is worth trying: it takes the first one and spares the ally', () => {
    // The foe is 20 ft out: inside the distance exit (size + 5 ft), but in no 15-ft Cone at center origin. The ally is on the S aim.
    const t = scene(PC(['test:aim-cone']), [pc('H8'), { seat: 'qa', team: 'party', use: 'test:aim-foe', at: 'H9' }, foe('x1', 'L9')]);
    castAs(t.cx, 'cast:aim-cone@1');
    expect(aimKey(t.sink)).toBe('N');
    expect(zoneEvents(t.sink)[0]!.area!).not.toContain(cell(t.s, 'H9'));
  });
  it('the per-round half of the zone cache keeps aims apart too', () => {
    // Only a turn-end hook, so all the value is per-round: N (a tank, sorted first on the tie) mustn't lend its figure to E (the frail one).
    const lasting = aimedSpell('aim-last', '{ shape: cone, size: 15 }').replace('duration: instant', 'duration: { minutes: 1 }').replace('components: { v: true, s: true }', 'components: { v: true, s: true }\nconcentration: true').replace('duration: { rounds: 1 }', 'duration: parent').replace('[appear]', '[turnEndIn]');
    const t = scene(PC(['test:aim-last']), [pc('H8'), foe('xt', 'H7', 'aim-tank'), foe('xf', 'I8', 'aim-frail')], { extra: { 'packs/test/spells/aim-last.yaml': lasting } });
    castAs(t.cx, 'cast:aim-last@1');
    expect(aimKey(t.sink)).toBe('E');
  });
  it('at most 3 sets are valued per square: a fourth singleton, however good, isn\'t tried [U: the cap is a perf choice]', () => {
    const t = scene(PC(['test:aim-wave']), [pc('H8'), foe('x1', 'H6', 'aim-tank'), foe('x2', 'K5', 'aim-tank'), foe('x3', 'K8', 'aim-tank'), foe('xf', 'F10', 'aim-frail')]);
    castAs(t.cx, 'cast:aim-wave@1');
    expect(['N', 'NE', 'E']).toContain(aimKey(t.sink));
  });
  it('a lasting aimed zone\'s per-round value reads its own squares, not a lattice anchor', () => {
    const lasting = aimedSpell('aim-last', '{ shape: cone, size: 15 }').replace('duration: instant', 'duration: { minutes: 1 }').replace('components: { v: true, s: true }', 'components: { v: true, s: true }\nconcentration: true').replace('duration: { rounds: 1 }', 'duration: parent').replace('[appear]', '[appear, turnEndIn]');
    const t = scene(PC(['test:aim-last']), [pc('H8'), foe('x1', 'I8'), foe('x2', 'J8')], { extra: { 'packs/test/spells/aim-last.yaml': lasting }, flags: { areaOriginOnGrid: 'gridIntersection' } });
    t.turn(t.u('pc'));
    const z = zoneEvents(t.sink)[0]!;
    expect(z.anchor).toBe('H8>E');
    expect(z.area!).toContain(cell(t.s, 'J8'));
  });
  it('areaCandidates and zoneAnchors stay as they were for spheres', () => {
    const t = scene(PC(['srd:fireball']), [pc('A1'), foe('x1', 'H8'), foe('x2', 'I8')]);
    const out: AreaCand[] = [];
    const key = t.s.seats[0]!.tpl.effects.find((e) => e.zone)!.zone!.shapeKey;
    expect(areaCandidates(t.cx.st, t.u('pc'), key, 150, t.u('pc').cell, out)).toBeGreaterThan(0);
    t.turn(t.u('pc'));
    const z = zoneEvents(t.sink)[0]!;
    expect(z.anchor).not.toContain('>');
  });
});

describe('the aim search (query/area.ts)', () => {
  const keyOf = (t: ReturnType<typeof scene>) => t.s.seats[0]!.tpl.effects.find((e) => e.zone)!.zone!.shapeKey;
  it('a creature cut off by a wall isn\'t in a set (srd-raw.txt:32674-32678)', () => {
    const terrain = Array.from({ length: 16 }, (_, y) => (y === 7 ? '........#.......' : '................'));
    const t = scene(PC(['test:aim-line']), [pc('H8'), foe('x1', 'J8'), foe('x2', 'H6')], { terrain });
    const out: AimCand[] = [];
    aimQuery(t.cx.st, t.u('pc'), keyOf(t), t.u('pc').cell, out);
    expect(out.map((c) => AIMS[c.aim])).toEqual(['N']);
  });
  it('past the distance exit it finds nothing; one set per distinct cover, first aim kept; dead creatures don\'t count', () => {
    const far = scene(PC(['test:aim-cone']), [pc('A1'), foe('x1', 'P16')]);
    const out: AimCand[] = [];
    expect(aimQuery(far.cx.st, far.u('pc'), keyOf(far), far.u('pc').cell, out)).toBe(0);
    const t = scene(PC(['test:aim-wave']), [pc('H8'), foe('x1', 'I7'), foe('x2', 'F10')]);
    aimQuery(t.cx.st, t.u('pc'), keyOf(t), t.u('pc').cell, out);
    expect(out.map((c) => [AIMS[c.aim], c.nEnemies])).toEqual([['N', 1], ['SW', 1]]);
    t.u('x2').life = 'dead';
    aimQuery(t.cx.st, t.u('pc'), keyOf(t), t.u('pc').cell, out);
    expect(out.map((c) => AIMS[c.aim])).toEqual(['N']);
  });
  it('the exit reaches as far as the masks do: a 90-ft Cone under anyOverlap and squareEdge, a foe alone at a diagonal tip', () => {
    const t = scene(PC(['test:aim-huge']), [pc('B2'), foe('x1', 'C3')], { w: 48, h: 48, flags: { areaGridCoverage: 'anyOverlap', selfAreaOrigin: 'squareEdge' } });
    const st = t.cx.st;
    const key = keyOf(t);
    const w = st.setup.w;
    let tip: [number, number] | null = null;
    for (const aim of [1, 3, 5, 7]) {
      const { r, cover } = creatureMaskLookup(st, key, aim);
      if (r <= sizeFtOf(key) / 5 + 1) continue;
      const side = 2 * r + 1;
      for (let i = 0; i < cover.length && !tip; i++) {
        const dx = (i % side) - r;
        const dy = Math.floor(i / side) - r;
        if (cover[i] && Math.max(Math.abs(dx), Math.abs(dy)) === r) tip = [dx, dy];
      }
      if (tip) break;
    }
    expect(tip).not.toBeNull(); // the case exists: a mask reaches past size + 5 ft
    const [dx, dy] = tip!;
    const from = 24 + 24 * w; // the middle of the map: room in every direction
    t.u('x1').cell = from + dy * w + dx;
    const out: AimCand[] = [];
    expect(aimQuery(st, t.u('pc'), key, from, out)).toBeGreaterThan(0);
    expect(out.some((c) => c.nEnemies === 1)).toBe(true);
  });
  it('the exit counts squares, so a diagonal under diagonalCost=alternate still reaches', () => {
    const t = scene(PC(['test:aim-wide']), [pc('H8'), foe('x1', 'L4')], { flags: { diagonalCost: 'alternate' } });
    const out: AimCand[] = [];
    expect(aimQuery(t.cx.st, t.u('pc'), keyOf(t), t.u('pc').cell, out)).toBeGreaterThan(0);
  });
});

describe('greedy: Explain and destinations', () => {
  const NOFOES_NEAR = [pc('A8'), foe('x1', 'P1', 'aim-foe'), foe('x2', 'P2', 'aim-foe')];
  it('an area spell appears in Explain\'s top 3 when 2 foes fit', () => {
    const t = scene(PC(['test:aim-cone'], { cantrips: ['srd:fire-bolt'] }), [pc('H8'), foe('x1', 'I8'), foe('x2', 'J8')]);
    t.begin(t.u('pc'));
    const { rec } = t.decide(t.u('pc'));
    expect(rec.top.map((r) => r.key)).toContain('cast:aim-cone@1');
    const row = rec.top.find((r) => r.key === 'cast:aim-cone@1')!;
    expect(row.parts.map((p) => p.term)).toContain('aim: 2 creatures');
  });
  it('and it is absent at 0 foes in reach', () => {
    const t = scene(PC(['test:aim-cone'], { cantrips: ['srd:fire-bolt'] }), NOFOES_NEAR);
    t.begin(t.u('pc'));
    const { rec } = t.decide(t.u('pc'));
    expect(rec.top.map((r) => r.key)).not.toContain('cast:aim-cone@1');
  });
  it('explain changes nothing: the same fight with and without a sink ends on the same hash', () => {
    const fight = (explain: boolean) => {
      const s = must(PC(['test:aim-cone'], { cantrips: ['srd:fire-bolt'] }), [pc('H8'), foe('x1', 'L8'), foe('x2', 'M8')]);
      const ds = s.seats.map(() => new GreedyDecider());
      if (explain) for (const d of ds) d.explainTo(() => {});
      return runFight(s, 11, 0, ds, explain ? new ArraySink() : new HashSink()).stateHash;
    };
    expect(fight(true)).toBe(fight(false));
  });
  it('a Wizard with Fire Bolt, Shatter and Fireball, and only a 1st-level slot for its Cone, walks into cone reach and casts', () => {
    const t = scene(PC(['test:aim-cone', 'srd:shatter', 'srd:fireball'], { cantrips: ['srd:fire-bolt'] }), [pc('D8'), foe('x1', 'J8'), foe('x2', 'K8'), foe('x3', 'J7')]);
    const me = t.u('pc');
    me.res[1] = 0;
    me.res[2] = 0;
    me.res[0] = 2;
    t.begin(me);
    const here = t.options(me);
    expect(here.keys).toContain('cast:aim-cone@1');
    const out = t.turn(me);
    const first = out[0]!;
    expect(first.startsWith('move')).toBe(true);
    expect(out).toContain('cast:aim-cone@1');
    expect(zoneEvents(t.sink)[0]!.anchor).toContain('>');
  });
  it('with its slots up too, an aimed area worth 0 here is still re-valued from a destination, outside the three best options here', () => {
    const big = aimedSpell('aim-big', '{ shape: cone, size: 15 }', '14d6');
    const t = scene(PC(['test:aim-big', 'srd:shatter', 'srd:fireball'], { cantrips: ['srd:fire-bolt'] }), [pc('D8'), foe('x1', 'J8'), foe('x2', 'K8'), foe('x3', 'J7')], { extra: { 'packs/test/spells/aim-big.yaml': big } });
    const out = t.turn(t.u('pc'));
    expect(out[0]!.startsWith('move')).toBe(true);
    expect(out).toContain('cast:aim-big@1');
  });
  it('Explain names the walk: `from there: aim`', () => {
    const t = scene(PC(['test:aim-cone']), [pc('D8'), foe('x1', 'J8'), foe('x2', 'K8'), foe('x3', 'J7')]);
    t.begin(t.u('pc'));
    const { key, rec } = t.decide(t.u('pc'));
    expect(key.startsWith('move')).toBe(true);
    expect(rec.top.find((r) => r.key === key)!.parts.map((p) => p.term)).toContain('from there: aim');
  });
  it('a destination is ranked from its own square: the aim search isn\'t shared across squares', () => {
    // Two groups, only one in a walk's reach: a cache without `from` would read the first square valued for all.
    const t = scene(PC(['test:aim-cone']), [pc('D8'), foe('x1', 'J8'), foe('x2', 'K8')]);
    const out = t.turn(t.u('pc'));
    expect(out).toContain('cast:aim-cone@1');
    expect(t.ds[0]!.aimRanks).toBeGreaterThan(0);
  });
  it('the destination block doesn\'t run for a kit with no aimed option', () => {
    const t = scene(PC(['srd:fireball'], { cantrips: ['srd:fire-bolt'] }), [pc('D8'), foe('x1', 'J8'), foe('x2', 'K8')]);
    t.turn(t.u('pc'));
    expect(t.ds[0]!.aimRanks).toBe(0);
  });
  it('a Bonus Action Dash-free caster out of this turn\'s reach walks toward the Cone: next-turn credit, per destination', () => {
    // 50 ft out: no square this turn covers anyone; next turn's walk does.
    const t = scene(PC(['test:aim-cone']), [pc('A8'), foe('x1', 'K8'), foe('x2', 'L8')]);
    t.begin(t.u('pc'));
    const { key, rec } = t.decide(t.u('pc'));
    expect(key.startsWith('move') || key === 'option:core:dash' || key.includes('dash')).toBe(true);
    const row = rec.top.find((r) => r.key === key)!;
    expect(row.parts.map((p) => p.term).join('|')).toMatch(/aim/);
  });
});

describe('a feature activation with an area', () => {
  it('an aimed activation asks and stamps as a spell does', () => {
    const t = scene(PC([], { features: ['aim-breath'] }), [pc('H8'), foe('x1', 'I8'), foe('x2', 'J8')]);
    const out = t.turn(t.u('pc'));
    expect(out.join(' ')).toContain('use:');
    expect(zoneEvents(t.sink)[0]!.anchor).toBe('H8>E');
  });
  it('a ranged lattice activation asks an anchor', () => {
    const t = scene(PC([], { features: ['aim-pulse'] }), [pc('A8'), foe('x1', 'E8'), foe('x2', 'F8')]);
    t.turn(t.u('pc'));
    const z = zoneEvents(t.sink)[0]!;
    expect(z.anchor).not.toContain('>');
    expect(z.area!).toContain(cell(t.s, 'E8'));
  });
});

describe('every other decider and flag', () => {
  it('baseline and random-legal answer an aim without knowing it\'s one', () => {
    for (const name of ['baseline', 'random-legal'] as const) {
      const s = must(PC(['test:aim-cone']), [pc('H8'), foe('x1', 'I8'), foe('x2', 'J8')]);
      const sink = new ArraySink();
      const ds = s.seats.map(() => namedDecider(name));
      const cx = createContext(s, 5, 0, ds, sink);
      applyPassives(cx, -1);
      castAs(cx, 'cast:aim-cone@1');
      expect(zoneEvents(sink)[0]!.anchor).toMatch(/^H8>/);
    }
  });
  it('no combination of the area flags crashes an aimed zone or an emanation', () => {
    for (const areaOriginOnGrid of ['squareCenter', 'gridIntersection']) {
      for (const areaGridCoverage of ['atLeastHalfSquare', 'squareCenterInside', 'anyOverlap']) {
        for (const selfAreaOrigin of ['squareCenter', 'squareEdge']) {
          for (const emanationReach of ['gridDistance', 'radial']) {
            const s = must(PC(['test:aim-cone', 'test:aim-aura', 'test:aim-wave', 'test:aim-line']), [pc('H8'), foe('x1', 'I8'), foe('x2', 'J8')], { flags: { areaOriginOnGrid, areaGridCoverage, selfAreaOrigin, emanationReach } });
            expect(() => runFight(s, 5, 0, s.seats.map(() => new GreedyDecider()), new HashSink())).not.toThrow();
          }
        }
      }
    }
  });
});
