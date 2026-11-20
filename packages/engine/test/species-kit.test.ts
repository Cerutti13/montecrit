// Session S (the repo half, docs/design/coverage.md "Session S repo half"): the generic primitives a
// private species kit needs, each through a synthetic stand-in in packs/test and named for the rule
// it checks. test:radiant-shift: a Bonus Action, its own pool, 1 minute, dismissible, three options
// (a Fly Speed; a pulse at the end of each of the bearer's turns on every other creature within 10 ft;
// a CHA save or Frightened on activation) and a once-per-own-turn extra-damage rider gated on the
// option being up (selfHas), on attacks and on spell damage (spellDamage). test:mending-touch: the
// Magic action, its own pool, touch range with self allowed, (PB)d4 healing. Fights are scripted seat
// by seat, so each test states exactly what was chosen.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../src/content/load.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import type { Decider, DecisionPoint } from '../src/decide/decider.ts';
import { GreedyDecider, type ExplainRecord } from '../src/decide/greedy/greedy.ts';
import { ArraySink, type GameEvent as LogEvent } from '../src/log/events.ts';
import { resolveScenario } from '../src/scenario/resolve.ts';
import { createContext, runFight } from '../src/sim/fight.ts';
import { applyPassives } from '../src/sim/precast.ts';
import { gateOk, speedOf } from '../src/sim/stats.ts';
import { COND, has, type Unit } from '../src/sim/state.ts';

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

/** A level-5 PC (PB 3), CHA 16 (+3): the shift's DC is 8 + 3 + 3 = 14 and its extra damage 3. */
const pcText = (id: string, opt: { features?: string[]; hp?: number; cantrips?: string[]; prepared?: string[] } = {}) => `kind: pc
id: test:${id}
name: ${id}
source: synthetic test fixture
rules: '2024'
level: 5
size: medium
speed: 30
abilities: { str: 14, dex: 10, con: 14, int: 10, wis: 16, cha: 16 }
hpMax: ${opt.hp ?? 40}
ac: 14
armor: none
saveProficiencies: [wis, cha]
items:
  - { id: charm, name: Charm, kind: focus, focusFor: [kit] }
hands: [charm, null]
extraAttacks: 1
weapons:
  - { id: club, name: Club, kind: melee, ability: str, category: simple, bonus: 20, damage: [{ roll: 1d4 + @mod, type: bludgeoning }] }
pools:
  - { id: radiant-shift, name: Radiant Shift, max: 1, recharge: longRest }
  - { id: mending-touch, name: Mending Touch, max: 1, recharge: longRest }
slots: [4, 3, 2]
casting:
  - { source: kit, ability: wis, list: kit, cantrips: [${(opt.cantrips ?? []).join(', ')}], prepared: [${(opt.prepared ?? []).join(', ')}] }
features: [${(opt.features ?? ['test:radiant-shift', 'test:mending-touch']).join(', ')}]
`;
/** A tough foe: 200 HP, AC 5 (the club hits), CHA 1 (-5) and DEX 1 so most saves fail. */
const monster = (id: string, walkFt = 30) => `kind: monster
id: test:${id}
name: ${id}
source: synthetic test fixture
size: medium
cr: 1
pb: 2
ac: 5
hp: { average: 200, formula: '200' }
speed: { walk: ${walkFt} }
initiative: { mod: -5, score: 1 }
abilities: { str: 14, dex: 1, con: 1, int: 10, wis: 10, cha: 1 }
attacks:
  - { id: claw, name: Claw, kind: melee, toHit: 0, damage: [{ roll: '1', type: slashing, avg: 1 }] }
`;
const KIT: Record<string, string> = {
  'packs/test/pcs/kit-bearer.yaml': pcText('kit-bearer', { cantrips: ['srd:sacred-flame'], prepared: ['srd:guiding-bolt', 'srd:moonbeam'] }),
  // kit-bearer that can't walk: it values the shift on the square it starts on.
  'packs/test/pcs/kit-rooted.yaml': pcText('kit-rooted', { cantrips: ['srd:sacred-flame'], prepared: ['srd:guiding-bolt', 'srd:moonbeam'] }).replace('speed: 30', 'speed: 0'),
  'packs/test/pcs/kit-plain.yaml': pcText('kit-plain', { features: [] }),
  'packs/test/pcs/kit-hurt.yaml': pcText('kit-hurt', { features: [], hp: 60 }),
  'packs/test/pcs/kit-flame.yaml': pcText('kit-flame', { cantrips: ['srd:sacred-flame'], features: ['test:radiant-shift'] }),
  'packs/test/pcs/kit-shifter.yaml': pcText('kit-shifter', { features: ['test:radiant-shift'] }),
  'packs/test/pcs/kit-healer.yaml': pcText('kit-healer', { features: ['test:mending-touch'] }),
  // selfHas reads the bearer's own effect: a mark another creature (same template) puts on it doesn't count.
  'packs/test/features/kit-gift.yaml': `kind: feature
id: test:kit-gift
name: Kit Gift
source: synthetic test fixture
activate:
  id: gift
  name: Gift
  cost: bonus
  do: [{ target: { range: 30, who: ally, self: no } }, { apply: { effect: mark, to: target } }]
effects:
  - { id: mark, name: Mark, duration: { minutes: 1 }, stats: [{ ac: 1 }] }
riders:
  - { id: marked-strike, name: Marked Strike, on: dealtDamage, oncePerTurn: ownTurn, when: [{ selfHas: mark }], do: [{ damage: [{ roll: '1', type: fire }] }] }
`,
  'packs/test/pcs/kit-giver.yaml': pcText('kit-giver', { features: ['test:kit-gift'] }),
  'packs/test/monsters/kit-foe.yaml': monster('kit-foe'),
  'packs/test/monsters/kit-brute.yaml': monster('kit-brute').replace("toHit: 0, damage: [{ roll: '1', type: slashing, avg: 1 }]", "toHit: 8, damage: [{ roll: '2d6 + 4', type: slashing, avg: 11 }]"),
  'packs/test/monsters/kit-post.yaml': monster('kit-post', 0),
  'packs/test/monsters/kit-shell.yaml': monster('kit-shell', 0).replace('attacks:', 'immune: [bludgeoning]\nattacks:'),
  'packs/test/monsters/kit-dim.yaml': monster('kit-dim', 0).replace('attacks:', 'immune: [radiant]\nattacks:'),
  // Acts first and hits anything in range: drops a 1-HP ally before the PC's turn.
  'packs/test/monsters/kit-sniper.yaml': monster('kit-sniper', 0)
    .replace('initiative: { mod: -5, score: 1 }', 'initiative: { mod: 10, score: 30 }')
    .replace("kind: melee, toHit: 0, damage: [{ roll: '1', type: slashing, avg: 1 }]", "kind: ranged, range: [150, 600], toHit: 30, damage: [{ roll: '5', type: piercing, avg: 5 }]"),
  // Greedy v11 guards (each test below names the one it pins).
  // kit-shifter that can't walk, and a far foe the shift's riders can't hurt: every option is worth nothing.
  'packs/test/pcs/kit-shift-rooted.yaml': pcText('kit-shift-rooted', { features: ['test:radiant-shift'] }).replace('speed: 30', 'speed: 0'),
  'packs/test/monsters/kit-pale.yaml': monster('kit-pale', 0).replace('attacks:', 'immune: [radiant, necrotic]\nattacks:'),
  // kit-brute that can't walk: an opportunity attack that drops a 6-HP PC on any hit.
  'packs/test/monsters/kit-brute-post.yaml': monster('kit-brute-post', 0).replace("toHit: 0, damage: [{ roll: '1', type: slashing, avg: 1 }]", "toHit: 8, damage: [{ roll: '2d6 + 4', type: slashing, avg: 11 }]"),
  // Walks 20 ft (threatens 25 ft), hits hard, and the club can't hurt it.
  'packs/test/monsters/kit-hulk.yaml': monster('kit-hulk', 20).replace('attacks:', 'immune: [bludgeoning]\nattacks:').replace("toHit: 0, damage: [{ roll: '1', type: slashing, avg: 1 }]", "toHit: 8, damage: [{ roll: '2d6 + 4', type: slashing, avg: 11 }]"),
  // kit-shifter at Speed 10: next turn it strikes only within 15 ft.
  'packs/test/pcs/kit-slow.yaml': pcText('kit-slow', { features: ['test:radiant-shift'] }).replace('speed: 30', 'speed: 10'),
  // Incapacitated until the end of the target's next turn, no save.
  'packs/test/features/kit-daze.yaml': `kind: feature
id: test:kit-daze
name: Kit Daze
source: synthetic test fixture
activate:
  id: daze
  name: Daze
  cost: action
  do: [{ target: { range: 60, who: enemy, self: no } }, { condition: { id: incapacitated, until: { until: endOfNextTurn, of: bearer } } }]
`,
  'packs/test/pcs/kit-dazer.yaml': pcText('kit-dazer', { features: ['test:kit-daze'] }),
  // The same turn-end 10-ft pulse, put on an ally (kit-beacon) or on oneself (kit-beacon-self).
  ...Object.fromEntries(
    [['kit-beacon', '[{ target: { range: 30, who: ally, self: no } }, { apply: { effect: glow, to: target } }]'], ['kit-beacon-self', '[{ apply: { effect: glow, to: self } }]']].map(([id, steps]) => [
      `packs/test/features/${id}.yaml`,
      `kind: feature
id: test:${id}
name: ${id}
source: synthetic test fixture
activate:
  id: ${id}
  name: ${id}
  cost: bonus
  do: ${steps}
effects:
  - id: glow
    name: Glow
    duration: { minutes: 1 }
    on:
      - when: [turnEnd]
        do:
          - around: { size: 10, who: any }
          - damage: [{ roll: '3', type: radiant }]
`,
    ]),
  ),
  'packs/test/pcs/kit-beaconer.yaml': pcText('kit-beaconer', { features: ['test:kit-beacon'] }).replace('speed: 30', 'speed: 0'),
  'packs/test/pcs/kit-beaconer-self.yaml': pcText('kit-beaconer-self', { features: ['test:kit-beacon-self'] }).replace('speed: 30', 'speed: 0'),
};

const load = (() => {
  let r: ReturnType<typeof loadContent> | null = null;
  return () => {
    r ??= loadContent([...REPO, ...Object.entries(KIT).map(([path, text]) => ({ path, text }))]);
    if (!r.content) throw new Error(r.errors.map(formatDiag).join('\n'));
    return r.content;
  };
})();

type Seat = { seat: string; team: 'party' | 'enemies'; use: string; at: string; hp?: number };
const party = (seat: string, use: string, at: string, hp?: number): Seat => ({ seat, team: 'party', use: `test:${use}`, at, ...(hp ? { hp } : {}) });
const enemy = (seat: string, use: string, at: string): Seat => ({ seat, team: 'enemies', use: `test:${use}`, at });

function setupOf(units: readonly Seat[], opt: { rounds?: number; terrain?: string[]; greedy?: boolean } = {}) {
  const doc = {
    kind: 'scenario', id: 'kit', name: 'Kit', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: { w: 16, h: 9, ...(opt.terrain ? { terrain: opt.terrain } : {}) },
    flags: { initiativeMode: 'static' }, knobs: { downEnds: false, maxRounds: opt.rounds ?? 1 },
    units: units.map((u) => ({ ...u, decider: 'greedy' })),
  };
  const res = resolveScenario(doc, 'kit.yaml', load());
  if (!res.setup) throw new Error(res.errors.map(formatDiag).join('\n'));
  return res.setup;
}

/**
 * Plays `turn` keys in order on its turn decisions (a key ending in / matches by prefix), then passes;
 * any other decision takes the next key queued for its kind, else its first item (pass, where there is one).
 */
const script = (turn: readonly string[], other: Record<string, string[]> = {}): Decider => {
  const left = [...turn];
  const q: Record<string, string[]> = Object.fromEntries(Object.entries(other).map(([k, v]) => [k, [...v]]));
  return {
    name: 'script',
    decide: (_v, dp: DecisionPoint) => {
      const find = (want: string) => {
        for (let i = 0; i < dp.legal.n; i++) if (want.endsWith('/') ? dp.keyOf(i).startsWith(want) : dp.keyOf(i) === want) return i;
        return -1;
      };
      const keys = () => Array.from({ length: dp.legal.n }, (_, j) => dp.keyOf(j)).join(' ');
      if (dp.k === 'turn') {
        const want = left.shift();
        if (want === undefined) return find('pass');
        const i = find(want);
        if (i < 0) throw new Error(`${want} isn't offered: ${keys()}`);
        return i;
      }
      const want = q[dp.k]?.shift();
      if (want === undefined) return 0;
      const i = find(want);
      if (i < 0) throw new Error(`${dp.k} ${want} isn't offered: ${keys()}`);
      return i;
    },
  };
};

type Keys = Record<string, string[] | { turn: string[]; other?: Record<string, string[]> }>;
function fight(units: readonly Seat[], keys: Keys, opt: Parameters<typeof setupOf>[1] = {}, seed = 1) {
  const s = setupOf(units, opt);
  const sink = new ArraySink();
  const deciders = s.seats.map((seat): Decider => {
    const k = keys[seat.seat];
    if (k === undefined) return script([]);
    return Array.isArray(k) ? script(k) : script(k.turn, k.other ?? {});
  });
  const r = runFight(s, seed, 0, deciders, sink);
  const ev = sink.events as LogEvent[];
  const idx = (seat: string) => s.seats.findIndex((x) => x.seat === seat);
  const of = <K extends LogEvent['k']>(k: K) => ev.filter((e): e is Extract<LogEvent, { k: K }> => e.k === k);
  const dmgTo = (seat: string) => of('damage').filter((e) => e.tgt === idx(seat));
  return { s, r, ev, idx, of, dmgTo };
}

const SHIFT = 'use:radiant-shift';
const pick = (opt: string) => ({ pick: [`pick:${opt}`] });

describe('the transformation: a Bonus Action, its own pool, 1 minute, ended early at will', () => {
  it('"a Bonus Action": the shift spends the Bonus Action and the one use of its pool, and isn\'t offered again', () => {
    const f = fight([party('pc', 'kit-bearer', 'E5'), enemy('gob', 'kit-post', 'O5')], { pc: { turn: [SHIFT], other: pick('wings') } }, { rounds: 1 });
    expect(f.of('res').filter((e) => e.who === f.idx('pc'))).toEqual([expect.objectContaining({ pool: 'Radiant Shift', left: 0 })]);
    const decided = f.of('decided').filter((e) => e.who === f.idx('pc') && e.dk === 'turn').map((e) => e.key);
    expect(decided[0]).toBe(SHIFT);
  });

  it('"ending early at will": dismissing it ends the option\'s effect, and the shift can\'t be used again', () => {
    const f = fight([party('pc', 'kit-bearer', 'E5'), enemy('gob', 'kit-post', 'O5')], { pc: { turn: [SHIFT, 'end:wings'], other: pick('wings') } }, { rounds: 2 });
    const ends = f.of('fxEnd').filter((e) => e.via === 'test:radiant-shift/wings');
    expect(ends.map((e) => e.why)).toEqual(['dismissed']);
    expect(f.of('decided').filter((e) => e.key === SHIFT)).toHaveLength(1);
  });

  it('"1 minute": each option lasts 10 rounds from the turn it was used', () => {
    const f = fight([party('pc', 'kit-bearer', 'E5'), enemy('gob', 'kit-post', 'O5')], { pc: { turn: [SHIFT], other: pick('wings') } }, { rounds: 12 });
    const end = f.of('fxEnd').find((e) => e.via === 'test:radiant-shift/wings');
    expect(end?.why).toBe('expired');
    expect(end?.round).toBe(11);
  });
});

describe('wings: "a Fly Speed equal to your Speed" (srd-raw.txt:33450-33462, 34218-34236)', () => {
  function bearer(opt: 'wings' | 'radiance') {
    const s = setupOf([party('pc', 'kit-bearer', 'E5'), enemy('gob', 'kit-post', 'O5')]);
    const sink = new ArraySink();
    const cx = createContext(s, 1, 0, s.seats.map(() => script([])), sink);
    applyPassives(cx, -1);
    const pc = cx.st.units.find((x) => x.seat === 'pc')!;
    return { cx, pc, s, opt };
  }
  it('the stat is a Fly Speed of 30 on the bearer while wings are up, and nothing on a flat grid moves faster for it', () => {
    const f = fight([party('pc', 'kit-bearer', 'E5'), enemy('gob', 'kit-post', 'O5')], { pc: { turn: [SHIFT, 'move:J5/'], other: pick('wings') } }, { rounds: 1 });
    // 30 ft of movement: E5 to J5 is 25 ft, and the walk had the same budget a walker has.
    const end = f.of('moveEnd').find((e) => e.who === f.idx('pc'))!;
    expect(end.why).toBe('arrived');
    const b = bearer('wings');
    expect(speedOf(b.cx.st, b.pc)).toBe(30);
  });
});

describe('radiance: "at the end of each of your turns, each other creature within 10 feet takes damage equal to your Proficiency Bonus"', () => {
  const units = [party('pc', 'kit-bearer', 'E5'), party('friend', 'kit-plain', 'F5'), enemy('near', 'kit-post', 'G5'), enemy('diag', 'kit-post', 'G7'), enemy('far', 'kit-post', 'H5')];

  it('each other creature within 10 ft, allies included, no save: PB radiant once per bearer turn end; none farther, none on itself', () => {
    const f = fight(units, { pc: { turn: [SHIFT], other: pick('radiance') } }, { rounds: 2 });
    const pulse = (seat: string) => f.dmgTo(seat).filter((e) => e.via === 'test:radiant-shift/radiance');
    for (const seat of ['friend', 'near', 'diag']) {
      expect(pulse(seat).map((e) => [e.round, e.turnOf, e.parts[0]!.type, e.dealt])).toEqual([[1, f.idx('pc'), 'radiant', 3], [2, f.idx('pc'), 'radiant', 3]]);
    }
    expect(pulse('far')).toHaveLength(0);
    expect(pulse('pc')).toHaveLength(0);
    expect(f.of('save')).toHaveLength(0);
  });

  it('on another creature\'s turn end it does nothing', () => {
    const f = fight(units, { pc: { turn: [SHIFT], other: pick('radiance') } }, { rounds: 2 });
    expect(f.of('damage').filter((e) => e.via === 'test:radiant-shift/radiance' && e.turnOf !== f.idx('pc'))).toHaveLength(0);
  });

  it('the Emanation goes with its bearer: after a walk it reaches who is within 10 ft of where the turn ends', () => {
    const f = fight(units, { pc: { turn: [SHIFT, 'move:E2/'], other: pick('radiance') } }, { rounds: 1 });
    expect(f.of('damage').filter((e) => e.via === 'test:radiant-shift/radiance')).toHaveLength(0);
  });

  it('a wall between: an Emanation "extends in straight lines" (srd-raw.txt:33379-33380), so a creature cut off by a wall is not in it', () => {
    const terrain = ['................', '................', '................', '................', '.....#..........', '................', '................', '................', '................'];
    const f = fight([party('pc', 'kit-bearer', 'E5'), enemy('near', 'kit-post', 'G5'), enemy('far', 'kit-post', 'O5')], { pc: { turn: [SHIFT], other: pick('radiance') } }, { rounds: 1, terrain });
    expect(f.dmgTo('near').filter((e) => e.via === 'test:radiant-shift/radiance')).toHaveLength(0);
  });
});

describe('shroud: "each creature other than your allies within 10 feet ... Charisma saving throw ... or have the Frightened condition until the end of your next turn"', () => {
  const units = [party('pc', 'kit-bearer', 'E5'), party('friend', 'kit-plain', 'F5'), enemy('near', 'kit-post', 'G5'), enemy('diag', 'kit-post', 'G7'), enemy('far', 'kit-post', 'H5')];

  it('on activation only: a CHA save at DC 8 + CHA + PB (14) for each non-ally within 10 ft; none for allies, the far foe or itself', () => {
    const f = fight(units, { pc: { turn: [SHIFT], other: pick('shroud') } }, { rounds: 3 });
    const saves = f.of('save');
    expect(saves.map((e) => [f.s.seats[e.who]!.seat, e.key, e.dc, e.round, e.turnOf]).sort()).toEqual([
      ['diag', 'save.cha', 14, 1, f.idx('pc')],
      ['near', 'save.cha', 14, 1, f.idx('pc')],
    ]);
  });

  it('a failed save is Frightened (of the bearer) until the end of the bearer\'s next turn; a success is nothing', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const f = fight(units, { pc: { turn: [SHIFT], other: pick('shroud') } }, { rounds: 3 }, seed);
      for (const sv of f.of('save')) {
        const on = f.of('cond').filter((e) => e.who === sv.who && e.cond.endsWith('frightened'));
        if (sv.ok) {
          expect(on).toHaveLength(0);
          continue;
        }
        expect(on.map((e) => [e.on, e.round, e.turnOf])).toEqual([[true, 1, f.idx('pc')], [false, 2, f.idx('pc')]]);
        // It lasts through the bearer's round-2 turn and ends as that turn ends.
        const t2 = f.of('turnStart').find((e) => e.who === f.idx('pc') && e.round === 2)!;
        expect(on[1]!.seq).toBeGreaterThan(t2.seq);
      }
    }
  });

  it('the source of fear is the bearer: Frightened attacks have Disadvantage while it is in sight', () => {
    // Over seeds, find a fight where `near` fails, then is scripted to attack the bearer on its turn.
    let checked = 0;
    for (let seed = 1; seed <= 12 && checked === 0; seed++) {
      const f = fight([party('pc', 'kit-bearer', 'E5'), enemy('near', 'kit-post', 'F5')], { pc: { turn: [SHIFT], other: pick('shroud') }, near: ['attack:claw>pc'] }, { rounds: 1 }, seed);
      const sv = f.of('save').find((e) => e.who === f.idx('near'));
      if (!sv || sv.ok) continue;
      const atk = f.of('attack').find((e) => e.att === f.idx('near'))!;
      expect(atk.adv).toBe('dis');
      checked++;
    }
    expect(checked).toBe(1);
  });
});

describe('the rider: "once on each of your turns ... when you deal damage to a target with an attack or a spell, extra damage equal to your Proficiency Bonus"', () => {
  const units = [party('pc', 'kit-bearer', 'E5'), enemy('gob', 'kit-post', 'F5'), enemy('gob2', 'kit-post', 'F6')];
  const rider = (f: ReturnType<typeof fight>, local: string) => f.dmgTo('gob').concat(f.dmgTo('gob2')).filter((e) => e.via === 'test:radiant-shift' && e.purpose === 'rider' && e.name?.startsWith(`Radiant Shift (${local})`));

  it('with an attack: after the club deals damage, PB radiant extra (wings), one rider decision', () => {
    const f = fight(units, { pc: { turn: [SHIFT, 'attack:club>gob'], other: { ...pick('wings'), rider: ['rider:wings-strike'] } } });
    const extra = rider(f, 'Wings');
    expect(extra.map((e) => [e.parts[0]!.type, e.dealt, e.purpose])).toEqual([['radiant', 3, 'rider']]);
    expect(f.of('decided').filter((e) => e.dk === 'rider').map((e) => e.key)).toEqual(['rider:wings-strike']);
  });

  it('shroud\'s is necrotic', () => {
    const f = fight(units, { pc: { turn: [SHIFT, 'attack:club>gob'], other: { ...pick('shroud'), rider: ['rider:shroud-strike'] } } });
    expect(rider(f, 'Shroud').map((e) => [e.parts[0]!.type, e.dealt])).toEqual([['necrotic', 3]]);
  });

  it('"once on each of your turns": a second damaging hit the same turn is not offered it; the next turn it is again', () => {
    const f = fight([party('pc', 'kit-bearer', 'E5'), enemy('gob', 'kit-post', 'F5')], {
      pc: { turn: [SHIFT, 'attack:club>gob', 'attack:club>gob', 'pass', 'attack:club>gob'], other: { ...pick('wings'), rider: ['rider:wings-strike', 'rider:wings-strike'] } },
    }, { rounds: 2 });
    const offered = f.of('decided').filter((e) => e.dk === 'rider');
    expect(offered.map((e) => e.round)).toEqual([1, 2]);
  });

  it('"on each of your turns": never on another creature\'s turn (an opportunity attack it makes)', () => {
    const f = fight([party('pc', 'kit-bearer', 'E5'), enemy('gob', 'kit-foe', 'F5')], { pc: { turn: [SHIFT], other: { ...pick('wings'), reaction: ['oa:club'] } }, gob: ['move:J5/'] }, { rounds: 1 });
    const oa = f.of('attack').filter((e) => e.att === f.idx('pc') && e.opportunity);
    expect(oa.length).toBe(1);
    expect(f.of('decided').filter((e) => e.dk === 'rider')).toHaveLength(0);
  });

  it('with a spell\'s save damage (spellDamage): Sacred Flame\'s failed save is damage, so the rider follows it; a passed save deals none and offers nothing', () => {
    let failed = 0;
    let passed = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const f = fight([party('pc', 'kit-bearer', 'E5'), enemy('gob', 'kit-post', 'H5')], {
        pc: { turn: [SHIFT, 'cast:sacred-flame@0'], other: { ...pick('radiance'), target: ['target:gob'], rider: ['rider:radiance-strike'] } },
      }, { rounds: 1 }, seed);
      const sv = f.of('save').find((e) => e.who === f.idx('gob'))!;
      const offered = f.of('decided').filter((e) => e.dk === 'rider');
      if (sv.ok) {
        passed++;
        expect(offered).toHaveLength(0);
      } else {
        failed++;
        expect(offered.map((e) => e.key)).toEqual(['rider:radiance-strike']);
        const extra = f.dmgTo('gob').filter((e) => e.via === 'test:radiant-shift' && e.purpose === 'rider');
        expect(extra.map((e) => e.dealt)).toEqual([3]);
        const flame = f.dmgTo('gob').find((e) => e.via.startsWith('srd:sacred-flame'))!;
        expect(extra[0]!.seq).toBeGreaterThan(flame.seq);
      }
    }
    expect(failed).toBeGreaterThan(0);
    expect(passed).toBeGreaterThan(0);
  });

  it('with a spell attack (Guiding Bolt): through the attack\'s own dealtDamage riders', () => {
    const f = fight([party('pc', 'kit-bearer', 'E5'), enemy('gob', 'kit-post', 'H5')], {
      pc: { turn: [SHIFT, 'cast:guiding-bolt@1'], other: { ...pick('wings'), target: ['target:gob'], rider: ['rider:wings-strike'] } },
    }, { rounds: 1 });
    const hit = f.of('attack').find((e) => e.att === f.idx('pc'))!;
    const offered = f.of('decided').filter((e) => e.dk === 'rider');
    expect(offered).toHaveLength(hit.hit ? 1 : 0);
  });

  it('a spell\'s zone on the bearer\'s own turn (Moonbeam\'s damage) counts; the pulse (a trait, not a spell) never does', () => {
    let saw = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const f = fight([party('pc', 'kit-bearer', 'E5'), enemy('gob', 'kit-post', 'H5')], {
        pc: { turn: [SHIFT, 'cast:moonbeam@2'], other: { ...pick('radiance'), place: ['place:H5'], rider: ['rider:radiance-strike'] } },
      }, { rounds: 1 }, seed);
      const beam = f.dmgTo('gob').filter((e) => e.via.startsWith('srd:moonbeam') && e.turnOf === f.idx('pc') && e.dealt > 0);
      const offered = f.of('decided').filter((e) => e.dk === 'rider');
      expect(offered).toHaveLength(beam.length > 0 ? 1 : 0);
      saw += beam.length;
    }
    // Some seed must actually damage gob with the beam, or the equality above checks nothing.
    expect(saw).toBeGreaterThan(0);
  });

  it('selfHas is the bearer\'s own effect: the same effect put on it by another creature doesn\'t switch its rider on', () => {
    const f = fight([party('a', 'kit-giver', 'E5'), party('b', 'kit-giver', 'E6'), enemy('gob', 'kit-post', 'F6')], { a: { turn: ['use:kit-gift'], other: { target: ['target:b'] } }, b: ['attack:club>gob'] });
    expect(f.of('fxStart').filter((e) => e.via === 'test:kit-gift/mark').map((e) => [e.owner, e.bearer])).toEqual([[f.idx('a'), f.idx('b')]]);
    expect(f.of('attack').filter((e) => e.att === f.idx('b') && e.hit)).toHaveLength(1);
    expect(f.of('decided').filter((e) => e.dk === 'rider')).toHaveLength(0);
  });

  it('"with an attack or a spell": the pulse is the trait\'s own damage, so it never offers the rider', () => {
    const f = fight([party('pc', 'kit-bearer', 'E5'), enemy('gob', 'kit-post', 'F5')], { pc: { turn: [SHIFT], other: pick('radiance') } }, { rounds: 2 });
    expect(f.dmgTo('gob').filter((e) => e.via === 'test:radiant-shift/radiance')).toHaveLength(2);
    expect(f.of('decided').filter((e) => e.dk === 'rider')).toHaveLength(0);
  });

  it('selfHas: with no option up the rider is never offered; once the option is dismissed it stops', () => {
    const none = fight(units, { pc: { turn: ['attack:club>gob'] } });
    expect(none.of('decided').filter((e) => e.dk === 'rider')).toHaveLength(0);
    const ended = fight(units, { pc: { turn: [SHIFT, 'end:wings', 'attack:club>gob'], other: pick('wings') } });
    expect(ended.of('decided').filter((e) => e.dk === 'rider')).toHaveLength(0);
  });
});

describe('the healing touch: "a Magic action ... touch a creature ... regains (PB)d4 Hit Points"', () => {
  it('touch range with itself allowed: the bearer and a creature within 5 ft are offered, one 10 ft away is not', () => {
    const f = fight([party('pc', 'kit-bearer', 'E5', 20), party('friend', 'kit-plain', 'F5', 5), party('away', 'kit-plain', 'G5', 5), enemy('gob', 'kit-post', 'O5')], {
      pc: { turn: ['use:mending-touch'], other: { target: ['target:friend'] } },
    });
    const heal = f.of('heal');
    expect(heal.map((e) => [f.s.seats[e.tgt]!.seat, e.via])).toEqual([['friend', 'test:mending-touch']]);
    expect(heal[0]!.rolled).toBeGreaterThanOrEqual(3);
    expect(heal[0]!.rolled).toBeLessThanOrEqual(12);
    expect(f.of('res').find((e) => e.pool === 'Mending Touch')?.left).toBe(0);
    const targetKeys = f.ev.filter((e) => e.k === 'decided' && e.dk === 'target');
    expect(targetKeys).toHaveLength(1);
  });

  it('(PB)d4: the heal is 3d4 at PB 3 (its mean over many seeds sits at 7.5)', () => {
    let sum = 0;
    const n = 60;
    for (let seed = 1; seed <= n; seed++) {
      const f = fight([party('pc', 'kit-bearer', 'E5', 1), enemy('gob', 'kit-post', 'O5')], { pc: { turn: ['use:mending-touch'], other: { target: ['target:pc'] } } }, { rounds: 1 }, seed);
      sum += f.of('heal')[0]!.rolled;
    }
    expect(sum / n).toBeGreaterThan(6.5);
    expect(sum / n).toBeLessThan(8.5);
  });
});

describe('the greedy AI values each piece (C6)', () => {
  /** Greedy for the PC, with an Explain sink; everyone else scripted. */
  function greedyFight(units: readonly Seat[], keys: Keys, opt: Parameters<typeof setupOf>[1] = {}, seed = 1) {
    const s = setupOf(units, opt);
    const sink = new ArraySink();
    const explain: ExplainRecord[] = [];
    const deciders = s.seats.map((seat): Decider => {
      if (seat.seat === 'pc') {
        const g = new GreedyDecider();
        g.explainTo((r) => explain.push(r));
        return g;
      }
      const k = keys[seat.seat];
      return k === undefined ? script([]) : Array.isArray(k) ? script(k) : script(k.turn, k.other ?? {});
    });
    const r = runFight(s, seed, 0, deciders, sink);
    const ev = sink.events as LogEvent[];
    const idx = (seat: string) => s.seats.findIndex((x) => x.seat === seat);
    return { s, r, ev, idx, explain };
  }
  /**
   * The PC scripted by `turnKeys` on its first turn decisions (on every decision of round 1 when
   * `firstRound`, `other` keys included), greedy everywhere else; everyone else passes.
   */
  function mixFight(units: readonly Seat[], turnKeys: readonly string[], other: Record<string, string[]>, opt: Parameters<typeof setupOf>[1] = {}, firstRound = false, seed = 1) {
    const s = setupOf(units, opt);
    const sink = new ArraySink();
    const explain: ExplainRecord[] = [];
    const g = new GreedyDecider();
    g.explainTo((r) => explain.push(r));
    const sc = script(turnKeys, other);
    let left = turnKeys.length;
    const scripted = (dp: DecisionPoint) => (firstRound ? dp.round === 1 : dp.k === 'turn' && left-- > 0);
    const pc: Decider = { name: 'mix', decide: (v, dp) => (scripted(dp) ? sc.decide(v, dp) : g.decide(v, dp)) };
    runFight(s, seed, 0, s.seats.map((seat) => (seat.seat === 'pc' ? pc : script([]))), sink);
    const ev = sink.events as LogEvent[];
    const idx = (seat: string) => s.seats.findIndex((x) => x.seat === seat);
    return { s, ev, idx, explain };
  }
  const picked = (ev: LogEvent[], who: number) => ev.filter((e): e is Extract<LogEvent, { k: 'decided' }> => e.k === 'decided' && e.who === who).map((e) => `${e.dk}:${e.key}`);

  it('radiance with foes all around and no ally near: greedy shifts and picks radiance', () => {
    const g = greedyFight([party('pc', 'kit-bearer', 'E5'), enemy('a', 'kit-post', 'D5'), enemy('b', 'kit-post', 'F5'), enemy('c', 'kit-post', 'E4'), enemy('d', 'kit-post', 'E6')], {});
    expect(picked(g.ev, g.idx('pc'))).toContain('pick:pick:radiance');
  });

  // Greedy v11: these two script the shift and leave the option to greedy. A greedy turn takes its action
  // first here (the cast is worth more), and after it the shift's rider can't fire this turn (selfRider
  // counts r - 1 rounds), so in a 1-round fight the shift is rightly not worth its use any more.
  it('friendly fire: with three allies around it and one foe, radiance is not the option it picks', () => {
    const g = mixFight([party('pc', 'kit-bearer', 'E5'), party('x', 'kit-plain', 'D5'), party('y', 'kit-plain', 'E4'), party('z', 'kit-plain', 'E6'), enemy('b', 'kit-post', 'F5')], [SHIFT], {});
    const p = picked(g.ev, g.idx('pc'));
    expect(p).toContain('turn:use:radiant-shift');
    expect(p.filter((x) => x.startsWith('pick:'))).toHaveLength(1);
    expect(p).not.toContain('pick:pick:radiance');
  });

  it('shroud\'s save counts foes only (who: enemy): three allies within 10 ft don\'t count as targets, so with one foe near it still picks shroud', () => {
    for (let seed = 1; seed <= 3; seed++) {
      const g = mixFight([party('pc', 'kit-bearer', 'E5'), party('x', 'kit-plain', 'D5'), party('y', 'kit-plain', 'E4'), party('z', 'kit-plain', 'E6'), enemy('b', 'kit-post', 'F5')], [SHIFT], {}, {}, false, seed);
      expect(picked(g.ev, g.idx('pc'))).toContain('pick:pick:shroud');
    }
  });

  it('the rider is taken when offered (its value is the extra damage)', () => {
    const g = greedyFight([party('pc', 'kit-bearer', 'E5'), enemy('b', 'kit-post', 'F5')], {}, { rounds: 2 });
    const rid = g.ev.filter((e): e is Extract<LogEvent, { k: 'decided' }> => e.k === 'decided' && e.dk === 'rider');
    expect(rid.length).toBeGreaterThan(0);
    expect(rid.every((e) => e.key !== 'pass')).toBe(true);
  });

  const RIDERS_TERM = 'riders it switches on (selfHas): P(I deal damage) x the extra, per round';
  const shiftRow = (r: ExplainRecord) => r.top.find((t) => t.key === SHIFT);
  const termOf = (r: ExplainRecord, term: string) => shiftRow(r)?.parts.find((x) => x.term === term)?.ev;

  it('selfHas riders count at activation: with no creature within 10 ft (no pulse or fear to gain) the shift is valued for the extra damage', () => {
    const g = greedyFight([party('pc', 'kit-flame', 'E5'), enemy('b', 'kit-post', 'L5')], {});
    const first = g.explain.find((r) => shiftRow(r) !== undefined)!;
    expect(termOf(first, RIDERS_TERM)).toBeGreaterThan(0);
  });

  it('greedy v11: a once-per-turn rider counts no round already spent: after the action, the shift\'s rider term drops by one round', () => {
    // Nothing to strike this turn (the foe is 55 ft off), so the shift is weighed before any action.
    const units = [party('pc', 'kit-shifter', 'E5'), enemy('b', 'kit-post', 'P5')];
    const fresh = greedyFight(units, {}, { rounds: 3 });
    const before = fresh.explain.find((r) => termOf(r, RIDERS_TERM) !== undefined)!;
    const spent = mixFight(units, ['dodge'], {}, { rounds: 3 }, false);
    const after = spent.explain.find((r) => termOf(r, RIDERS_TERM) !== undefined)!;
    expect(fresh.explain.find((r) => r.chosen === SHIFT)).toBe(before); // weighed (and taken) before any action
    // Same square, same foe, same horizon: only the spent action differs (r rounds before, r - 1 after).
    expect(termOf(after, RIDERS_TERM)!).toBeLessThan(termOf(before, RIDERS_TERM)! * 0.75);
    expect(termOf(after, RIDERS_TERM)!).toBeGreaterThan(0);
  });

  it('greedy v11: the shift is as good next turn, so its value nets out what waiting keeps; in the last round it doesn\'t', () => {
    const DEFER = 'using it next turn instead: gamma x P(I am up then) x its value';
    const many = greedyFight([party('pc', 'kit-bearer', 'E5'), enemy('a', 'kit-post', 'D5'), enemy('b', 'kit-post', 'F5'), enemy('c', 'kit-post', 'E4'), enemy('d', 'kit-post', 'E6')], {}, { rounds: 3 });
    const r1 = many.explain.find((r) => termOf(r, DEFER) !== undefined);
    expect(termOf(r1!, DEFER)).toBeLessThan(0);
    const last = greedyFight([party('pc', 'kit-bearer', 'E5'), enemy('a', 'kit-post', 'D5'), enemy('b', 'kit-post', 'F5'), enemy('c', 'kit-post', 'E4'), enemy('d', 'kit-post', 'E6')], {});
    expect(last.explain.some((r) => termOf(r, DEFER) !== undefined)).toBe(false);
    expect(picked(last.ev, last.idx('pc'))).toContain('pick:pick:radiance');
  });

  it('greedy v11: a pulse\'s later rounds count its damage without the kill and progress credit (a foe drops once)', () => {
    const LATER = "my pulse's later rounds: no kill or progress credit (a foe drops once)";
    const g = greedyFight([party('pc', 'kit-bearer', 'E5'), enemy('a', 'kit-post', 'D5'), enemy('b', 'kit-post', 'F5'), enemy('c', 'kit-post', 'E4'), enemy('d', 'kit-post', 'E6')], {}, { rounds: 3 });
    const r = g.explain.find((x) => termOf(x, LATER) !== undefined);
    expect(termOf(r!, LATER)).toBeLessThan(0);
  });

  it('greedy v11: a pulse\'s later rounds keep the harm to a downed ally in reach (each round is another failed death save)', () => {
    // The sniper (first in initiative) drops the 1-HP ally before the PC's turn; the rooted PC values the shift
    // where it starts, with the downed ally inside the 10 ft radiance or far off.
    const fight = (allyAt: string) =>
      greedyFight([party('pc', 'kit-rooted', 'E5'), enemy('a', 'kit-post', 'D5'), enemy('b', 'kit-post', 'F5'), enemy('c', 'kit-post', 'E4'), party('down', 'kit-plain', allyAt, 1), enemy('s', 'kit-sniper', 'P9')], { s: ['attack:claw>down'] }, { rounds: 3 });
    const near = fight('E6');
    const far = fight('O1');
    for (const g of [near, far]) expect(g.ev.some((e) => e.k === 'down' && e.who === g.idx('down'))).toBe(true);
    // Far off, radiance is the pick; next to the downed ally it isn't. Before the fix the later rounds
    // dropped the ally's loss with the foes' kill credit (+2.47 on this term) and radiance was picked here too.
    expect(picked(far.ev, far.idx('pc'))).toContain('pick:pick:radiance');
    expect(picked(near.ev, near.idx('pc'))).not.toContain('pick:pick:radiance');
  });

  it('spellDamage counts at cast time: with the option up, a damaging spell\'s value carries the rider term', () => {
    const g = mixFight([party('pc', 'kit-flame', 'E5'), enemy('b', 'kit-post', 'L5')], [SHIFT], pick('wings'), { rounds: 2 }, true);
    const cast = g.explain.find((r) => r.chosen.startsWith('cast:sacred-flame') && r.top[0]!.parts.some((x) => x.term.startsWith('a rider on this spell')));
    expect(cast).toBeDefined();
  });

  it('a live pulse walks off an ally: the move term prices who the pulse reaches where the turn ends', () => {
    const s = setupOf([party('pc', 'kit-flame', 'E5'), party('friend', 'kit-plain', 'F5'), enemy('b', 'kit-post', 'O1')], { rounds: 2 });
    const sink = new ArraySink();
    const explain: ExplainRecord[] = [];
    const g = new GreedyDecider();
    g.explainTo((r) => explain.push(r));
    const first = script([SHIFT], pick('radiance'));
    // Round 1 scripted (shift to radiance next to the ally), greedy from round 2.
    const pc: Decider = { name: 'mix', decide: (v, dp) => (dp.round === 1 ? first.decide(v, dp) : g.decide(v, dp)) };
    runFight(s, 1, 0, s.seats.map((seat) => (seat.seat === 'pc' ? pc : script([]))), sink);
    const ev = sink.events as LogEvent[];
    const friend = s.seats.findIndex((x) => x.seat === 'friend');
    const pulses = ev.filter((e): e is Extract<LogEvent, { k: 'damage' }> => e.k === 'damage' && e.via === 'test:radiant-shift/radiance' && e.tgt === friend);
    expect(pulses.map((e) => e.round)).toEqual([1]);
    expect(explain.some((r) => r.top.some((t) => t.parts.some((x) => x.term.startsWith('my turn-end pulse there'))))).toBe(true);
  });

  it('greedy v11: every move offer carries the pulse it gives up, so a step off the foes reads the loss', () => {
    // Round 1 scripted (shift to radiance among two dangerous foes), greedy from round 2.
    // The pulse reaches the shell (immune to the club: no strike is worth making on it); the strike target 25 ft off is immune to radiant (the pulse gains nothing there).
    const g = mixFight([party('pc', 'kit-flame', 'E5'), enemy('shell', 'kit-shell', 'E7'), enemy('b', 'kit-dim', 'J5')], [SHIFT], pick('radiance'), { rounds: 2 }, true);
    const parts = g.explain.flatMap((r) => r.top.filter((t) => t.key.startsWith('move:')).flatMap((t) => t.parts));
    const pulse = parts.filter((x) => x.term.startsWith('my turn-end pulse there'));
    expect(pulse.some((x) => x.ev < -1)).toBe(true);
    // Not checked here: walking back to a square left that turn (the PC makes no move in this fight,
    // before or after the fix); that was measured on stars-ambush explain runs, not unit-tested.
  });

  // Greedy v11 guards. Each test fails with its guard removed (mutant-checked); the fights are scripted
  // seat by seat, the PC greedy where stated.
  describe('greedy v11 guards', () => {
    /**
     * The PC scripted on its first `pcTurn.length` turn decisions and on every pick (`pcOther`), or on all of
     * round 1 (`round1`); greedy otherwise. Other seats play `keys`, else pass.
     */
    function seatFight(units: readonly Seat[], pcTurn: string[], pcOther: Record<string, string[]>, keys: Keys, opt: Parameters<typeof setupOf>[1], round1: boolean) {
      const s = setupOf(units, opt);
      const sink = new ArraySink();
      const explain: ExplainRecord[] = [];
      const g = new GreedyDecider();
      g.explainTo((r) => explain.push(r));
      const sc = script(pcTurn, pcOther);
      let left = pcTurn.length;
      const scripted = (dp: DecisionPoint) => (round1 ? dp.round === 1 : (dp.k === 'turn' && left-- > 0) || dp.k === 'pick');
      const pc: Decider = { name: 'mix', decide: (v, dp) => (scripted(dp) ? sc.decide(v, dp) : g.decide(v, dp)) };
      const others = (seat: string): Decider => {
        const k = keys[seat];
        return k === undefined ? script([]) : Array.isArray(k) ? script(k) : script(k.turn, k.other ?? {});
      };
      runFight(s, 1, 0, s.seats.map((seat) => (seat.seat === 'pc' ? pc : others(seat.seat))), sink);
      const ev = sink.events as LogEvent[];
      const idx = (seat: string) => s.seats.findIndex((x) => x.seat === seat);
      const decided = (round: number) => ev.filter((e): e is Extract<LogEvent, { k: 'decided' }> => e.k === 'decided' && e.who === idx('pc') && e.round === round).map((e) => `${e.dk}:${e.key}`);
      return { s, ev, idx, explain, decided };
    }
    /** Feet between two squares named like `E5` (5-ft squares, a diagonal is 5 ft). */
    const ft = (a: string, b: string) => 5 * Math.max(Math.abs(a.charCodeAt(0) - b.charCodeAt(0)), Math.abs(Number(a.slice(1)) - Number(b.slice(1))));
    /** The square a picked move key ends on (`turn:move:F3/p0` is F3). */
    const dest = (key: string) => /^turn:move:([A-P]\d+)\//.exec(key)?.[1];
    const PULSE = 'my turn-end pulse there';
    const LATER = "my pulse's later rounds: no kill or progress credit (a foe drops once)";
    const DEFER = 'using it next turn instead: gamma x P(I am up then) x its value';
    const PROG = 'program value, net of its cost';
    const part = (r: ExplainRecord | undefined, key: string, term: string) => r?.top.find((t) => t.key === key)?.parts.find((x) => x.term === term)?.ev;

    it('G2 (useValue: val > 0): a shift worth less than its cost isn\'t netted against waiting: the same value in round 1 of 3 as in the last round', () => {
      // Rooted, nobody within 10 ft, and the one foe is immune to the riders' radiant and necrotic: every
      // option is worth nothing, so the shift is worth minus its cost however many rounds are left.
      const units = [party('pc', 'kit-shift-rooted', 'E5'), enemy('b', 'kit-pale', 'O5')];
      const many = seatFight(units, [], {}, {}, { rounds: 3 }, false);
      const last = seatFight(units, [], {}, {}, { rounds: 1 }, false);
      const first = (g: typeof many) => g.explain.find((r) => r.top.some((t) => t.key === SHIFT));
      const vMany = part(first(many), SHIFT, PROG)!;
      const vLast = part(first(last), SHIFT, PROG)!;
      expect(vLast).toBeLessThan(-1);
      // With the guard gone, round 1 of 3 reads -cost x (1 - gamma x P(up)): -0.9 against -3 here.
      expect(vMany).toBeCloseTo(vLast, 6);
      expect(part(first(many), SHIFT, DEFER)).toBeUndefined();
      expect(many.decided(1)).not.toContain(`turn:${SHIFT}`);
    });

    it('G4 (pulseLive while incapacitated): the pulse still fires at the end of an incapacitated bearer\'s turn and it can still walk, so it walks its radiance onto the foes', () => {
      // Round 1: the PC shifts to radiance. Round 2: the dazer (acting first) incapacitates it until the end of
      // its turn; it can still walk. Three shells (the club can't hurt them) stand 20 ft east, out of the pulse.
      const g = seatFight([party('pc', 'kit-flame', 'H5'), enemy('s1', 'kit-shell', 'L4'), enemy('s2', 'kit-shell', 'L5'), enemy('s3', 'kit-shell', 'L6'), enemy('dz', 'kit-dazer', 'A9')], [SHIFT], pick('radiance'), { dz: { turn: ['pass', 'use:kit-daze'] } }, { rounds: 2 }, true);
      const incap = g.ev.filter((e): e is Extract<LogEvent, { k: 'cond' }> => e.k === 'cond' && e.who === g.idx('pc') && e.cond === 'core:incapacitated');
      expect(incap.map((e) => [e.round, e.on])).toEqual([[2, true], [2, false]]);
      const moves = g.decided(2).map(dest).filter((c): c is string => c !== undefined);
      expect(moves.length).toBeGreaterThan(0);
      // An incapacitated-guarded greedy (v11 as first built) ignored the pulse and stayed more than 10 ft from every shell.
      const last = moves[moves.length - 1]!;
      expect(['L4', 'L5', 'L6'].some((s) => ft(last, s) <= 10)).toBe(true);
      expect(g.explain.some((r) => r.top.some((t) => t.parts.some((x) => x.term.startsWith(PULSE))))).toBe(true);
      // ...and the pulse lands on the shells while it's incapacitated.
      // (round 1's pulse at H5 reaches none of them, so any radiance hit on a shell is round 2's)
      const shells = [g.idx('s1'), g.idx('s2'), g.idx('s3')];
      const hits = g.ev.filter((e): e is Extract<LogEvent, { k: 'damage' }> => e.k === 'damage' && e.via === 'test:radiant-shift/radiance' && shells.includes(e.tgt));
      expect(hits.length).toBeGreaterThan(0);
    });

    it('G5 (pz = afterDrop): a pulse gained by a walk that may drop me counts only if I stay up, so the 6-HP PC disengages before walking onto the foes', () => {
      // Round 1: shift to radiance next to a rooted brute (any hit drops the 6-HP PC). Round 2: four posts
      // 15-20 ft east are the pulse's targets if it walks; leaving the brute provokes.
      const g = seatFight([party('pc', 'kit-shifter', 'E5', 6), enemy('a', 'kit-brute-post', 'D5'), enemy('p1', 'kit-post', 'H4'), enemy('p2', 'kit-post', 'H5'), enemy('p3', 'kit-post', 'H6'), enemy('p4', 'kit-post', 'I5')], [SHIFT], pick('radiance'), {}, { rounds: 3 }, true);
      // With the guard gone the pulse it may not live to see is counted whole and it walks out
      // provoking (move:F4/p1 first).
      expect(g.decided(2)[0]).toBe('turn:opt:disengage');
    });

    it('G7 (the move-only fallback skips moves that gain no pulse): after a Dodge, the slow PC doesn\'t walk out of the hulk\'s reach and give up its next-turn strike', () => {
      // Speed 10: from H5 it strikes the post (J5, 10 ft, in the pulse) next turn; every square that leaves the
      // hulk's 25-ft threat (L5) is 20 ft or more from the post, so next turn's strike and the pulse both go.
      const g = seatFight([party('pc', 'kit-slow', 'H5'), enemy('p', 'kit-post', 'J5'), enemy('hk', 'kit-hulk', 'L5')], [SHIFT, 'dodge'], pick('radiance'), {}, { rounds: 3 }, false);
      const r1 = g.decided(1);
      expect(r1.slice(0, 3)).toEqual([`turn:${SHIFT}`, 'pick:pick:radiance', 'turn:dodge']);
      const to = dest(r1[3]!);
      expect(to).toBeDefined();
      // With the guard gone the fallback offers the escape at its exposure alone and it walks to F3, 20 ft off.
      expect(ft(to!, 'J5')).toBeLessThanOrEqual(10);
    });

    it('G9 (pulseLater: bearer === me): a pulse on an ally keeps every round\'s kill and progress credit; on me its later rounds drop it', () => {
      // The same pulse effect, put on an ally 15 ft off (kit-beacon) or on myself (kit-beacon-self), valued from
      // my square among three foes; three rounds, so it has later rounds.
      const units = (pc: string) => [party('pc', pc, 'E5'), party('ally', 'kit-plain', 'H5'), enemy('a', 'kit-post', 'D5'), enemy('b', 'kit-post', 'F5'), enemy('c', 'kit-post', 'E4')];
      const row = (pc: string, key: string) => seatFight(units(pc), [], {}, {}, { rounds: 3 }, false).explain.find((r) => r.top.some((t) => t.key === key));
      const ally = row('kit-beaconer', 'use:kit-beacon');
      const self = row('kit-beaconer-self', 'use:kit-beacon-self');
      const selfLater = part(self, 'use:kit-beacon-self', LATER)!;
      expect(selfLater).toBeLessThan(-0.02);
      expect(part(ally, 'use:kit-beacon', LATER)).toBeUndefined();
      // Everything else is the same, so the ally's version is worth exactly the later-round credit more.
      expect(part(ally, 'use:kit-beacon', PROG)! - part(self, 'use:kit-beacon-self', PROG)!).toBeCloseTo(-selfLater, 3);
    });
  });

  it('a hurt ally in touch range: greedy heals it with the touch', () => {
    const g = greedyFight([party('pc', 'kit-healer', 'E5'), party('friend', 'kit-hurt', 'F5', 4), enemy('b', 'kit-brute', 'G5')], {});
    expect(picked(g.ev, g.idx('pc'))).toContain('turn:use:mending-touch');
  });
});

describe('gates and inertness', () => {
  it('selfHas fails closed without fight state and for an effect index that is none (-1)', () => {
    const s = setupOf([party('pc', 'kit-bearer', 'E5'), enemy('gob', 'kit-post', 'O5')]);
    const cx = createContext(s, 1, 0, s.seats.map(() => script([])), new ArraySink());
    const pc = cx.st.units[0]! as Unit;
    expect(gateOk(null, pc, { g: 'selfHas', fx: 0 }, null)).toBe(false);
    expect(gateOk(cx.st, pc, { g: 'selfHas', fx: -1 }, null)).toBe(false);
    expect(has(pc, COND.frightened)).toBe(false);
  });

  it('a selfHas gate naming no effect of the feature is a compile error at its own file; spellDamage needs on: dealtDamage', () => {
    const bad = `kind: feature
id: test:bad-gate
name: Bad Gate
source: synthetic test fixture
riders:
  - { id: r, name: R, on: hit, when: [{ selfHas: nowhere }], do: [{ damage: [{ roll: '1', type: fire }] }] }
`;
    const r = loadContent([...REPO, { path: 'packs/test/features/bad-gate.yaml', text: bad }]);
    expect(r.errors.map((d) => d.message).join('\n')).toMatch(/no effect "nowhere" in this feature's effects/);
    const bad2 = bad.replace('id: test:bad-gate', 'id: test:bad-gate-2').replace('when: [{ selfHas: nowhere }], ', 'spellDamage: true, ');
    const r2 = loadContent([...REPO, { path: 'packs/test/features/bad-gate-2.yaml', text: bad2 }]);
    expect(r2.errors.map((d) => d.message).join('\n')).toMatch(/spellDamage is a dealtDamage rider's/);
  });

  it('the around step: everyone around the owner, no decision, owner never; who: enemy spares allies', () => {
    const f = fight([party('pc', 'kit-bearer', 'E5'), party('friend', 'kit-plain', 'D5'), enemy('near', 'kit-post', 'F5'), enemy('far', 'kit-post', 'M5')], { pc: { turn: [SHIFT], other: pick('shroud') } });
    expect(f.of('save').map((e) => f.s.seats[e.who]!.seat)).toEqual(['near']);
    expect(f.of('decided').filter((e) => e.dk === 'target')).toHaveLength(0);
  });
});


describe('a species\' own pools (the uses of its once-per-Long-Rest traits)', () => {
  const charText = readFileSync(join(ROOT, 'packs/test/characters/sample-kin-druid.yaml'), 'utf8');
  const at = (level: number) =>
    loadContent([...REPO, { path: 'packs/test/characters/kin-l.yaml', text: charText.replace('id: test:sample-kin-druid', `id: test:kin-l${level}`).replace('level: 5, subclass: test:sample-path', level >= 3 ? `level: ${level}, subclass: test:sample-path` : `level: ${level}`).replace(/  srd:druid#asi-4: .*\n/, level >= 4 ? '$&' : '') }]);
  const pools = (level: number) => {
    const r = at(level);
    if (!r.content) throw new Error(r.errors.map(formatDiag).join('\n'));
    return r.content.get(`test:kin-l${level}` as never)!.pools.map((p) => `${p.local} ${p.max}`);
  };

  it('a pool named like a species feature exists from the level that feature is gained; at level 5 both', () => {
    expect(pools(5)).toEqual(expect.arrayContaining(['mending-touch 1', 'radiant-shift 1']));
    // Radiant Shift is gained at character level 3 (the species lists { id, level: 3 }).
    expect(pools(2)).toContain('mending-touch 1');
    expect(pools(2)).not.toContain('radiant-shift 1');
  });

  it('a pool id used twice in a species is an error at its own file', () => {
    const sp = readFileSync(join(ROOT, 'packs/test/species/sample-kin.yaml'), 'utf8').replace('id: test:sample-kin', 'id: test:kin-dup').replace('{ id: radiant-shift, name: Radiant Shift', '{ id: mending-touch, name: Radiant Shift');
    const r = loadContent([...REPO, { path: 'packs/test/species/kin-dup.yaml', text: sp }]);
    expect(r.errors.map((d) => d.message).join('\n')).toMatch(/pool id "mending-touch" is used twice/);
  });
});
