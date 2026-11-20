// Coverage step 7.3: `zone.affects` (triggers, pathfinding, valuation), `forcedMove.exact`, and the
// first area spells from the SRD pack: Thunderwave (srd-raw.txt:31621-31643), Entangle (26542-26567)
// and Faerie Fire (26688-26702). `affects` fixtures are synthetic (test: ids).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../src/content/load.ts';
import { HOOK } from '../src/content/types.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import type { Decider, DecisionPoint } from '../src/decide/decider.ts';
import { GreedyDecider } from '../src/decide/greedy/greedy.ts';
import { parseCell } from '../src/grid/cells.ts';
import { CELL, cellInfo, computeReach, forEachLabel, knownZones, newReachScratch } from '../src/grid/reach.ts';
import { ArraySink, type GameEvent } from '../src/log/events.ts';
import { aimCandidates, areaCandidates, type AimCand, type AreaCand } from '../src/query/area.ts';
import { forcedPaths, type ForcedPath } from '../src/query/forced.ts';
import { resolveScenario } from '../src/scenario/resolve.ts';
import { createContext, runFight } from '../src/sim/fight.ts';
import { resolveOption } from '../src/sim/act.ts';
import { copyLegal, legalKey, newLegal, releaseList, takeList } from '../src/sim/context.ts';
import { listOptions } from '../src/sim/options.ts';
import { applyPassives } from '../src/sim/precast.ts';
import type { Unit } from '../src/sim/state.ts';

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

/** A range-60 area: `when` hooks deal 1 damage, so who it fired on reads straight off the log. */
const ZONE = (id: string, affects: string, when: string, radius = 10) => `kind: spell
id: test:${id}
name: ${id}
source: synthetic test fixture
level: 1
castingTime: action
range: 60
components: { v: true, s: true }
duration: { minutes: 1 }
area: patch
effects:
  - id: patch
    name: ${id}
    zone: { shape: sphere, radius: ${radius}${affects === 'none' ? '' : `, affects: ${affects}`} }
    duration: { minutes: 1 }
    on: [{ when: [${when}], do: [{ damage: [{ roll: '1', type: fire }] }] }]
do: [{ apply: { effect: patch, to: point } }]
`;
const AIMED = (id: string, affects: string) => `kind: spell
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
    zone: { shape: cone, size: 15${affects === 'none' ? '' : `, affects: ${affects}`} }
    duration: { rounds: 1 }
    on: [{ when: [appear], do: [{ save: { ability: dex, half: true, damage: [{ roll: 4d6, type: fire }] } }] }]
do: [{ apply: { effect: blast, to: point } }]
`;
const VALUES = ['none', 'all', 'notOwner', 'foes', 'allies'] as const;
const FIXTURES: Record<string, string> = {};
for (const a of VALUES) {
  const l = a.toLowerCase();
  FIXTURES[`packs/test/spells/aff-appear-${l}.yaml`] = ZONE(`aff-appear-${l}`, a, 'appear');
  FIXTURES[`packs/test/spells/aff-walk-${l}.yaml`] = ZONE(`aff-walk-${l}`, a, 'enter, turnEndIn');
  FIXTURES[`packs/test/spells/aff-cross-${l}.yaml`] = ZONE(`aff-cross-${l}`, a, 'travel', 5);
  FIXTURES[`packs/test/spells/aff-burst-${l}.yaml`] = ZONE(`aff-burst-${l}`, a, 'appear', 10).replace("[{ damage: [{ roll: '1', type: fire }] }]", '[{ save: { ability: dex, half: true, damage: [{ roll: 4d6, type: fire }] } }]');
  FIXTURES[`packs/test/spells/aff-cone-${l}.yaml`] = AIMED(`aff-cone-${l}`, a);
}
const spellIds = Object.keys(FIXTURES).map((p) => `test:${p.slice(p.lastIndexOf('/') + 1, -5)}`);

const CASTER = `kind: pc
id: test:aff-pc
name: Aff PC
source: synthetic test fixture
rules: '2024'
level: 5
size: medium
speed: 30
abilities: { str: 8, dex: 16, con: 14, int: 18, wis: 10, cha: 8 }
hpMax: 44
ac: 14
armor: none
saveProficiencies: [int, wis]
items:
  - { id: wand, name: Wand, kind: focus, focusFor: [wizard] }
hands: [wand, null]
slots: [9, 3, 2]
casting:
  - { source: wizard, ability: int, list: wizard, prepared: [${[...spellIds, 'srd:thunderwave', 'srd:entangle', 'srd:faerie-fire'].join(', ')}] }
`;
const ALLY = CASTER.replace('id: test:aff-pc', 'id: test:aff-ally').replace('dex: 16', 'dex: 8');
const MONSTER = (id: string, hp: number, abilities: string, walk: number) => `kind: monster
id: test:${id}
name: ${id}
source: synthetic test fixture
size: medium
cr: 1
pb: 2
ac: 5
hp: { average: ${hp}, formula: '${hp}' }
speed: { walk: ${walk} }
initiative: { mod: 0, score: 5 }
abilities: { ${abilities} }
attacks:
  - { id: claw, name: Claw, kind: melee, toHit: 0, damage: [{ roll: '1', type: slashing, avg: 1 }] }
`;
const ALL = {
  ...FIXTURES,
  'packs/test/pcs/aff-pc.yaml': CASTER,
  'packs/test/pcs/aff-ally.yaml': ALLY,
  // Bad saves and good saves; tests find a seed with the result they need (saved()).
  'packs/test/monsters/aff-foe.yaml': MONSTER('aff-foe', 200, 'str: 1, dex: 1, con: 1, int: 10, wis: 10, cha: 10', 30),
  'packs/test/monsters/aff-sure.yaml': MONSTER('aff-sure', 200, 'str: 30, dex: 30, con: 30, int: 10, wis: 10, cha: 10', 30),
  'packs/test/monsters/aff-still.yaml': MONSTER('aff-still', 200, 'str: 1, dex: 1, con: 1, int: 10, wis: 10, cha: 10', 0),
  'packs/test/monsters/aff-big.yaml': MONSTER('aff-big', 200, 'str: 1, dex: 1, con: 1, int: 10, wis: 10, cha: 10', 0).replace('size: medium', 'size: gargantuan'),
};
const LOADED = loadContent([...REPO, ...Object.entries(ALL).map(([path, text]) => ({ path, text }))]);
if (!LOADED.content) throw new Error(LOADED.errors.map(formatDiag).join('\n'));
const CONTENT = LOADED.content;

type Seat = { seat: string; team: 'party' | 'enemies'; use: string; at: string };
const pc = (at: string, seat = 'pc'): Seat => ({ seat, team: 'party', use: 'test:aff-pc', at });
const ally = (at: string, seat = 'ally'): Seat => ({ seat, team: 'party', use: 'test:aff-ally', at });
const guard = (at: string, seat: string): Seat => ({ seat, team: 'party', use: 'srd:guard', at });
const foe = (at: string, seat = 'foe', use = 'aff-foe'): Seat => ({ seat, team: 'enemies', use: `test:${use}`, at });

function setup(units: Seat[], o: { terrain?: string[]; flags?: Record<string, unknown>; rounds?: number; decider?: string } = {}) {
  const doc = { kind: 'scenario', id: 'aff', name: 'Aff', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: { w: 16, h: 10, ...(o.terrain ? { terrain: o.terrain } : {}) }, flags: { initiativeMode: 'static', ...o.flags }, knobs: { downEnds: false, maxRounds: o.rounds ?? 2 }, units: units.map((u) => ({ ...u, decider: o.decider ?? 'greedy' })) };
  const r = resolveScenario(doc, 'aff.yaml', CONTENT);
  if (!r.setup) throw new Error(r.errors.map(formatDiag).join('\n'));
  return r.setup;
}

/** Takes the next key of its script when it's legal; otherwise passes a turn, or the first item of anything else. */
class Keys implements Decider {
  readonly name = 'keys';
  readonly seen: { k: string; keys: string[] }[] = [];
  private readonly queue: string[];
  constructor(queue: readonly string[] = []) {
    this.queue = [...queue];
  }
  decide(_v: unknown, dp: DecisionPoint): number {
    const keys = Array.from({ length: dp.legal.n }, (_, i) => dp.keyOf(i));
    this.seen.push({ k: dp.k, keys });
    const next = this.queue[0];
    const i = next === undefined ? -1 : keys.findIndex((k) => k === next || k.startsWith(`${next}#`) || k.startsWith(`${next}/`));
    if (i >= 0) {
      this.queue.shift();
      return i;
    }
    const pass = keys.indexOf('pass');
    return pass >= 0 ? pass : 0;
  }
}

function fight(units: Seat[], scripts: Record<string, string[]>, o: Parameters<typeof setup>[1] & { seed?: number } = {}) {
  const s = setup(units, o);
  const ds = s.seats.map((x) => new Keys(scripts[x.seat] ?? []));
  const sink = new ArraySink();
  const res = runFight(s, o.seed ?? 1, 0, ds as unknown as Parameters<typeof runFight>[3], sink);
  const events = sink.events as GameEvent[];
  const idx = (seat: string) => s.seats.findIndex((x) => x.seat === seat);
  const dealt = (seat: string) => events.filter((e): e is Extract<GameEvent, { k: 'damage' }> => e.k === 'damage' && e.tgt === idx(seat)).length;
  const saves = (seat: string) => events.filter((e): e is Extract<GameEvent, { k: 'save' }> => e.k === 'save' && e.who === idx(seat));
  /** Where it ended up, read from its last step. */
  const at = (seat: string) => events.filter((e): e is Extract<GameEvent, { k: 'step' }> => e.k === 'step' && e.who === idx(seat)).at(-1)?.to ?? parseCell(units.find((u) => u.seat === seat)!.at, s.w, s.h);
  const pulls = (seat: string) => ds[idx(seat)]!.seen.filter((x) => x.k === 'pull');
  return { s, ds, res, events, idx, dealt, saves, at, pulls };
}

/** The first seed whose fight has `seat`'s first save come out `ok`. */
function saved(seat: string, ok: boolean, run: (seed: number) => ReturnType<typeof fight>) {
  for (let seed = 1; seed < 200; seed++) {
    const f = run(seed);
    if (f.saves(seat)[0]?.ok === ok) return f;
  }
  throw new Error(`no seed has ${seat}'s save ${ok}`);
}

/** A constructed turn: the AI, or a seat's script. */
function scene(units: Seat[], o: Parameters<typeof setup>[1] = {}, scripts: Record<string, string[]> = {}) {
  const s = setup(units, o);
  const sink = new ArraySink();
  const ds = s.seats.map((x) => (scripts[x.seat] ? new Keys(scripts[x.seat]!) : new GreedyDecider())) as unknown as Parameters<typeof createContext>[3];
  const cx = createContext(s, 1, 0, ds, sink);
  applyPassives(cx, -1);
  const u = (seat: string): Unit => cx.st.units.find((x) => x.seat === seat)!;
  const begin = (who: Unit) => {
    cx.st.active = who.idx;
    cx.st.turnIdx++;
    who.turns++;
    Object.assign(who.b, { action: 1, bonus: 1, reaction: 1, freeObj: 1, moveFt: who.tpl.speedFt, atkActive: false, movedFt: 0 });
  };
  const cast = (who: Unit, key: string) => {
    const list = listOptions(cx, who, takeList(cx));
    for (let i = 0; i < list.n; i++) {
      if (legalKey(cx.st, who.idx, list.items[i]!) !== key) continue;
      const item = copyLegal(list.items[i]!, newLegal());
      releaseList(cx, list);
      resolveOption(cx, who, item, -1);
      return;
    }
    throw new Error(`no option ${key}`);
  };
  return { s, cx, u, begin, cast, sink };
}

const hitBy = (f: ReturnType<typeof fight>) => ['pc', 'ally', 'foe'].filter((x) => f.dealt(x) > 0);

describe('zone.affects in the triggers', () => {
  const units = [pc('C3'), ally('D3'), foe('E3')];
  const want: Record<(typeof VALUES)[number], string[]> = { none: ['pc', 'ally', 'foe'], all: ['pc', 'ally', 'foe'], notOwner: ['ally', 'foe'], foes: ['foe'], allies: ['pc', 'ally'] };

  for (const a of VALUES) {
    it(`gate(): affects ${a} on an appear hook fires on ${want[a].join(', ')}`, () => {
      const f = fight(units, { pc: [`cast:aff-appear-${a.toLowerCase()}@1`, 'place:D3'] }, { rounds: 1 });
      expect(hitBy(f)).toEqual(want[a]);
    });
  }

  it('runEffectHook: enter hooks spare the same creatures', () => {
    // pc casts well away from everyone; the ally and the foe each walk in on their turns and stop there.
    const walkers = [pc('A1'), ally('L3'), foe('L5')];
    const run = (a: string) => fight(walkers, { pc: [`cast:aff-walk-${a}@1`, 'place:H4'], ally: ['move:H3/p0'], foe: ['move:H5/p0'] }, { rounds: 1 });
    const all = run('none');
    expect([all.dealt('ally') > 0, all.dealt('foe') > 0]).toEqual([true, true]);
    const foes = run('foes');
    expect([foes.dealt('ally'), foes.dealt('foe') > 0]).toEqual([0, true]);
    const allies = run('allies');
    expect([allies.dealt('ally') > 0, allies.dealt('foe')]).toEqual([true, 0]);
    const notOwner = run('notowner');
    expect([notOwner.dealt('ally') > 0, notOwner.dealt('foe') > 0]).toEqual([true, true]);
  });

  it('runEffectHook: a turn-end hook spares its owner under notOwner', () => {
    const f = (a: string) => fight([pc('C3'), foe('N9')], { pc: [`cast:aff-walk-${a}@1`, 'place:C3'] }, { rounds: 1 });
    expect(f('none').dealt('pc')).toBeGreaterThan(0);
    expect(f('notowner').dealt('pc')).toBe(0);
  });
});

describe('zone.affects in pathfinding (grid/reach.ts knownZones)', () => {
  const hazardTo = (t: ReturnType<typeof scene>, who: Unit, cell: string) => {
    const sc = newReachScratch(t.s.w * t.s.h);
    computeReach(t.cx.st, who, 60, sc);
    const c = parseCell(cell, t.s.w, t.s.h);
    let best = Infinity;
    forEachLabel(t.cx.st, who, sc, 60, (x, _ft, _p, _par, hazard) => {
      if (x === c) best = Math.min(best, hazard);
    });
    return best;
  };
  /** A pay-to-cross square at H4 in a one-row corridor, so nobody goes round. */
  const corridor = ['................', '................', '################', '................', '################', '................', '................', '................', '................', '................'];
  const placed = (spell: string, flags: Record<string, unknown> = {}) => {
    const t = scene([pc('A4'), ally('D4'), foe('L4')], { terrain: corridor, flags }, { pc: ['place:H4'] });
    t.begin(t.u('pc'));
    t.cast(t.u('pc'), `cast:${spell}@1`);
    expect(t.cx.st.zoneMask[parseCell('H4', 16, 10)]).not.toBe(0);
    return t;
  };

  for (const mode of ['sawCast', 'all'] as const) {
    it(`an ally walks straight through a fixed foes zone, and a foe counts it (zoneKnowledge ${mode})`, () => {
      const flags = { zoneKnowledge: mode };
      const none = placed('aff-cross-none', flags);
      expect(hazardTo(none, none.u('ally'), 'J4')).toBeGreaterThan(0);
      expect(hazardTo(none, none.u('foe'), 'F4')).toBeGreaterThan(0);
      const foes = placed('aff-cross-foes', flags);
      expect(hazardTo(foes, foes.u('ally'), 'J4')).toBe(0);
      expect(hazardTo(foes, foes.u('foe'), 'F4')).toBeGreaterThan(0);
      const allies = placed('aff-cross-allies', flags);
      expect(hazardTo(allies, allies.u('ally'), 'J4')).toBeGreaterThan(0);
      expect(hazardTo(allies, allies.u('foe'), 'F4')).toBe(0);
    });
  }

  it('the owner of a notOwner zone counts no hazard in it, and an ally does', () => {
    const t = placed('aff-cross-notowner');
    const zone = t.cx.st.fx.find((f) => f.zbit >= 0)!;
    expect(knownZones(t.cx.st, t.u('pc')) & (1 << zone.zbit)).toBe(0);
    expect(knownZones(t.cx.st, t.u('ally')) & (1 << zone.zbit)).not.toBe(0);
    expect(hazardTo(t, t.u('pc'), 'J4')).toBe(0);
  });
});

describe('zone.affects in valuation', () => {
  const keyOf = (u: Unit, suffix: string) => u.tpl.effects.find((e) => e.id.endsWith(suffix))!.zone!.shapeKey;

  it('areaCandidates: a foes zone counts no ally; an all zone does; allies mirrors it', () => {
    const t = scene([pc('A1'), ally('H4'), foe('I4')]);
    const run = (affects: 'foes' | 'allies' | undefined) => {
      const out: AreaCand[] = [];
      areaCandidates(t.cx.st, t.u('pc'), keyOf(t.u('pc'), 'aff-appear-none/patch'), 150, t.u('pc').cell, out, affects);
      return out;
    };
    expect(run(undefined).some((c) => c.nEnemies === 1 && c.nAllies === 1)).toBe(true);
    expect(run('foes').length).toBeGreaterThan(0);
    expect(run('foes').every((c) => c.nAllies === 0 && c.nEnemies === 1)).toBe(true);
    expect(run('allies').every((c) => c.nEnemies === 0)).toBe(true);
  });

  it('aimCandidates: a foes cone counts no ally, and its set signature leaves the ally out', () => {
    const t = scene([pc('H4'), ally('I4'), foe('J4')]);
    const run = (affects: 'foes' | undefined) => {
      const out: AimCand[] = [];
      aimCandidates(t.cx.st, t.u('pc'), keyOf(t.u('pc'), 'aff-cone-none/blast'), t.u('pc').cell, out, affects);
      return out;
    };
    expect(run(undefined).some((c) => c.nEnemies === 1 && c.nAllies === 1)).toBe(true);
    expect(run('foes').length).toBeGreaterThan(0);
    const bit = t.u('ally').idx;
    expect(run('foes').every((c) => c.nAllies === 0 && ((c.sigLo >>> bit) & 1) === 0)).toBe(true);
  });

  it('the AI: `foes` isn\'t friendly fire (zoneAppear, zoneAnchors), so it takes the set with the ally in it', () => {
    // Any area on both foes covers the ally between them.
    const landed = (spell: string) => {
      const t = scene([pc('A1'), ally('H4'), foe('G4', 'foe'), foe('I4', 'foe2')]);
      t.begin(t.u('pc'));
      t.cast(t.u('pc'), `cast:${spell}@1`);
      const z = (t.sink.events as GameEvent[]).find((e) => e.k === 'zone') as Extract<GameEvent, { k: 'zone' }>;
      return { cells: z.area, ally: t.u('ally').cell, foes: [t.u('foe').cell, t.u('foe2').cell] };
    };
    const foes = landed('aff-burst-foes');
    expect(foes.foes.every((c) => foes.cells!.includes(c))).toBe(true);
    const all = landed('aff-burst-none');
    expect(all.cells).not.toContain(all.ally);
  });

  const landedAt = (units: Seat[], spell: string) => {
    const t = scene(units);
    t.begin(t.u('pc'));
    t.cast(t.u('pc'), `cast:${spell}@1`);
    const z = (t.sink.events as GameEvent[]).find((e) => e.k === 'zone') as Extract<GameEvent, { k: 'zone' }>;
    return { z, cell: (seat: string) => t.u(seat).cell };
  };

  it('zoneAnchors: a spared ally doesn\'t push the best set past the cap of 6', () => {
    // Six lone foes score 1 each; the pair scores 2, or 0 if the ally between them counted against it.
    const units = [pc('H8'), ally('H4'), foe('G4', 'f1'), foe('I4', 'f2'), foe('A1', 'l1'), foe('A5', 'l2'), foe('A9', 'l3'), foe('O1', 'l4'), foe('O5', 'l5'), foe('O9', 'l6')];
    const { z, cell } = landedAt(units, 'aff-burst-foes');
    expect(z.area).toContain(cell('f1'));
    expect(z.area).toContain(cell('f2'));
  });

  it('the per-round value spares the same creatures (zoneHookValue): the zone lands on both foes and the ally', () => {
    const { z, cell } = landedAt([pc('A1'), ally('H4'), foe('G4', 'f1'), foe('I4', 'f2')], 'aff-walk-foes');
    expect(z.area).toContain(cell('f1'));
    expect(z.area).toContain(cell('f2'));
  });

  it('aimCandidates in the AI: a spared ally doesn\'t push the best aim past the cap of 3', () => {
    // Three lone foes score 1 each; the pair east scores 2, or 0 if the ally in front of it counted.
    const units = [pc('H4'), ally('I4'), foe('J4', 'f1'), foe('K4', 'f2'), foe('F4', 'w'), foe('H2', 'n'), foe('H6', 's')];
    expect(landedAt(units, 'aff-cone-foes').z.anchor.split('>')[1]).toBe('E');
  });

  it('an aimed cone: the same, through aimCandidates and the cast', () => {
    const landed = (spell: string) => {
      const t = scene([pc('H4'), ally('I4'), foe('J4', 'foe'), foe('K4', 'foe2'), foe('F4', 'other')]);
      t.begin(t.u('pc'));
      t.cast(t.u('pc'), `cast:${spell}@1`);
      return (t.sink.events as GameEvent[]).find((e) => e.k === 'zone') as Extract<GameEvent, { k: 'zone' }>;
    };
    expect(landed('aff-cone-foes').anchor.split('>')[1]).toBe('E');
    expect(landed('aff-cone-none').anchor.split('>')[1]).toBe('W');
  });
});

describe('forcedMove.exact (Thunderwave, srd-raw.txt:31632-31634)', () => {
  const units = (use: string) => [pc('C3'), foe('D3', 'foe', use)];
  const cast = { pc: ['cast:thunderwave@1', 'aim:E'] };

  it('forcedPaths under exact lists only paths that can\'t go on', () => {
    const t = scene([pc('C3'), foe('E3')]);
    const out: ForcedPath[] = [];
    const qs = t.cx.views[0]!.scratch;
    const step = { mode: 'push' as const, maxFt: 10, maxSize: 5, straight: true as const };
    forcedPaths(t.cx.st, qs, t.u('pc'), t.u('pc').cell, t.u('foe'), step, out);
    expect(out.map((p) => p.cells.length)).toEqual([0, 1, 2]);
    forcedPaths(t.cx.st, qs, t.u('pc'), t.u('pc').cell, t.u('foe'), { ...step, exact: true }, out);
    expect(out.map((p) => p.cells.length)).toEqual([2]);
  });

  it('a failed save: damage, then the full 10 ft straight away, with no stop offered', () => {
    const f = saved('foe', false, (seed) => fight(units('aff-still'), cast, { rounds: 1, seed }));
    expect(f.dealt('foe')).toBe(1);
    // One square each time and no stop, so the engine doesn't ask. A stop option would make the puller decide (and Keys stops).
    expect(f.pulls('pc')).toHaveLength(0);
    expect(f.at('foe')).toBe(parseCell('F3', 16, 10));
  });

  it('a wall stops it short, with no decision for a square that isn\'t there', () => {
    const terrain = ['................', '................', '.....#..........', '................', '................', '................', '................', '................', '................', '................'];
    const f = saved('foe', false, (seed) => fight(units('aff-still'), cast, { rounds: 1, terrain, seed }));
    expect(f.at('foe')).toBe(parseCell('E3', 16, 10));
  });

  it('a successful save takes half and isn\'t pushed', () => {
    const f = saved('foe', true, (seed) => fight(units('aff-sure'), cast, { rounds: 1, seed }));
    expect(f.dealt('foe')).toBe(1);
    const dmg = f.events.find((e) => e.k === 'damage') as Extract<GameEvent, { k: 'damage' }>;
    expect(dmg.half).toBe(true);
    expect(f.pulls('pc')).toHaveLength(0);
    expect(f.at('foe')).toBe(parseCell('D3', 16, 10));
  });

  it('no size limit in the text: a Gargantuan creature is pushed too', () => {
    const f = saved('foe', false, (seed) => fight(units('aff-big'), cast, { rounds: 1, seed }));
    expect(f.at('foe')).toBe(parseCell('F3', 16, 10));
  });

  it('upcast: 1d8 per slot level above 1', () => {
    const f = (lvl: number) => {
      const dice = new Set<number>();
      for (let seed = 1; seed < 40; seed++) {
        const x = fight(units('aff-still'), { pc: [`cast:thunderwave@${lvl}`, 'aim:E'] }, { rounds: 1, seed });
        const d = x.events.find((e) => e.k === 'damage') as Extract<GameEvent, { k: 'damage' }>;
        if (x.saves('foe')[0]!.ok === false) dice.add(d.dealt);
      }
      return Math.max(...dice);
    };
    expect(f(1)).toBeLessThanOrEqual(16);
    expect(f(3)).toBeGreaterThan(16); // 4d8 reaches past 2d8's top
  });
});

describe('Entangle (srd-raw.txt:26542-26567)', () => {
  const cast = ['cast:entangle@1', 'place:E3'];

  it('its creator makes no save, an ally in it does; a failure Restrains, and the check is against the caster\'s DC', () => {
    const f = saved('foe', false, (seed) => fight([pc('D3'), ally('E3'), foe('F3')], { pc: cast, foe: ['use:pc/entangle-restrained/escape'] }, { rounds: 1, seed }));
    expect(f.saves('pc')).toHaveLength(0);
    expect(f.saves('ally').length).toBeGreaterThan(0);
    const [save, check] = f.saves('foe');
    // 8 + 3 (PB) + 4 (INT 18): the caster's spell save DC, for the save and for the Escape.
    expect(save!.dc).toBe(15);
    expect(check!.dc).toBe(15);
    expect(check!.purpose).toBe('check');
    expect(check!.key).toContain('athletics');
    expect(check!.key).toContain('str');
  });

  it('a success on the check ends Restrained only: the plants stay Difficult Terrain until the spell ends', () => {
    const go = (seed: number) => fight([pc('D3'), foe('F3')], { pc: cast, foe: ['use:pc/entangle-restrained/escape', 'move:G4/p0'] }, { rounds: 1, seed });
    let f: ReturnType<typeof fight> | null = null;
    for (let seed = 1; seed < 400 && !f; seed++) {
      const x = go(seed);
      if (x.saves('foe')[1]?.ok === true) f = x;
    }
    if (!f) throw new Error('no seed escaped');
    const z = f.events.find((e) => e.k === 'zone') as Extract<GameEvent, { k: 'zone' }>;
    expect(z.difficult).toBe(true);
    const step = f.events.find((e) => e.k === 'step' && e.who === f!.idx('foe')) as Extract<GameEvent, { k: 'step' }>;
    expect(step.ft).toBe(10);
    expect(f.events.some((e) => e.k === 'fxEnd' && (e as { why?: string }).why === 'escaped')).toBe(true);
  });

  it('the square reads as difficult to every creature, the spared caster included', () => {
    const t = scene([pc('D3'), foe('F3')], {}, { pc: ['place:E3'] });
    t.begin(t.u('pc'));
    t.cast(t.u('pc'), 'cast:entangle@1');
    const c = parseCell('E3', 16, 10);
    expect(cellInfo(t.cx.st, t.u('foe'), c, null) & CELL.difficult).not.toBe(0);
    expect(cellInfo(t.cx.st, t.u('pc'), c, null) & CELL.difficult).not.toBe(0);
  });

  it('a 20-foot square is 16 squares in the open', () => {
    const f = fight([pc('D3'), foe('F3')], { pc: ['cast:entangle@1', 'place:H5'] }, { rounds: 1 });
    expect((f.events.find((e) => e.k === 'zone') as Extract<GameEvent, { k: 'zone' }>).cells).toBe(16);
  });
});

describe('Faerie Fire (srd-raw.txt:26688-26702)', () => {
  const attackOn = (seat: string, f: ReturnType<typeof fight>) => f.events.filter((e): e is Extract<GameEvent, { k: 'attack' }> => e.k === 'attack' && e.tgt === f.idx(seat));
  const go = (seed: number) => fight(
    [pc('A1'), guard('G4', 'a1'), guard('G3', 'a2'), foe('H4', 'failer'), foe('H3', 'saver', 'aff-sure')],
    { pc: ['cast:faerie-fire@1', 'place:I4'], a1: ['attack:spear>failer'], a2: ['attack:spear>saver'] },
    { rounds: 1, seed },
  );

  it('attacks against the creature that failed have Advantage, against the one that saved none', () => {
    let f: ReturnType<typeof fight> | null = null;
    for (let seed = 1; seed < 200 && !f; seed++) {
      const x = go(seed);
      if (x.saves('failer')[0]?.ok === false && x.saves('saver')[0]?.ok === true) f = x;
    }
    if (!f) throw new Error('no seed split the saves');
    expect(f.saves('pc')).toHaveLength(0);
    expect(attackOn('failer', f)[0]!.adv).toBe('adv');
    expect(attackOn('failer', f)[0]!.advSrc.join(' ')).toContain('outlined');
    expect(attackOn('saver', f)[0]!.adv).not.toBe('adv');
  });

  it('the Advantage is on attacks against it (incoming), borne by the creature, and ends with the spell', () => {
    const t = scene([pc('A1'), foe('H4')]);
    const ef = t.u('pc').tpl.effects.find((e) => e.id === 'srd:faerie-fire/outlined')!;
    expect(ef.mods.length).toBe(1);
    expect(ef.dur.k).toBe('parent');
    const lights = t.u('pc').tpl.effects.find((e) => e.id === 'srd:faerie-fire/lights')!;
    expect(lights.hookMask & HOOK.appear).not.toBe(0);
    const outlined = t.u('pc').tpl.effects.findIndex((e) => e.id === 'srd:faerie-fire/outlined');
    const hook = JSON.stringify(lights.hooks[0]!.steps);
    expect(hook).toContain(`"to":"target"`);
    expect(hook).toContain(`"fx":${outlined}`);
  });
});
