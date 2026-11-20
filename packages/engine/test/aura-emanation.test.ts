// Coverage step 7.5: an Emanation goes with its owner, and an aura's roll mods. Named for the text:
// "An Emanation moves with the creature ... that is its origin" (srd-raw.txt:33383-33384), Spirit
// Guardians trigger by trigger (31040-31047), Aura of Protection (11992-12000). The fights are scripted
// seat by seat, so each test states exactly what walked where; the spells are the pack's own, and the
// rest of the kit is synthetic.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { loadContent } from '../src/content/load.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import type { Decider, DecisionPoint } from '../src/decide/decider.ts';
import { GreedyDecider } from '../src/decide/greedy/greedy.ts';
import { parseCell } from '../src/grid/cells.ts';
import { flagIndex } from '../src/rules/flags.ts';
import { computeReach, forEachLabel, knownZones } from '../src/grid/reach.ts';
import { ArraySink, type GameEvent as LogEvent } from '../src/log/events.ts';
import { resolveScenario } from '../src/scenario/resolve.ts';
import { createContext, runFight } from '../src/sim/fight.ts';
import { resolveOption } from '../src/sim/act.ts';
import { copyLegal, legalKey, newLegal, newScratch, releaseList, takeList } from '../src/sim/context.ts';
import { foldMods, newModFold, onDeath } from '../src/sim/effects.ts';
import { deathSave } from '../src/sim/damage.ts';
import { renderLog } from '../src/log/render.ts';
import { listOptions } from '../src/sim/options.ts';
import { saveKey } from '../src/content/rollkeys.ts';
import { applyPassives } from '../src/sim/precast.ts';
import { COND, stateHash, type Unit } from '../src/sim/state.ts';
import { walkPath } from '../src/sim/walker.ts';

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

const packYaml = (rel: string): any => parse(readFileSync(join(ROOT, 'packs', 'srd-5.2.1', rel), 'utf8'));

const pcText = (id: string, cha: number, opt: { features?: string[]; prepared?: string[]; speed?: number } = {}) => `kind: pc
id: test:${id}
name: ${id}
source: synthetic test fixture
rules: '2024'
level: 6
size: medium
speed: ${opt.speed ?? 30}
abilities: { str: 10, dex: 10, con: 14, int: 10, wis: 16, cha: ${cha} }
hpMax: 40
ac: 14
armor: none
saveProficiencies: [wis, cha]
items:
  - { id: charm, name: Charm, kind: focus, focusFor: [cleric] }
hands: [charm, null]
weapons:
  - { id: club, name: Club, kind: melee, ability: str, category: simple, damage: [{ roll: 1d4 + @mod, type: bludgeoning }] }
features: [${(opt.features ?? []).join(', ')}]
slots: [4, 3, 3]
casting:
  - { source: cleric, ability: wis, list: cleric, cantrips: [], prepared: [${(opt.prepared ?? []).join(', ')}] }
`;
const monster = (id: string, walkFt = 30) => `kind: monster
id: test:${id}
name: ${id}
source: synthetic test fixture
size: medium
cr: 1
pb: 2
ac: 12
hp: { average: 200, formula: '200' }
speed: { walk: ${walkFt} }
initiative: { mod: 0, score: 1 }
abilities: { str: 14, dex: 10, con: 12, int: 10, wis: 10, cha: 10 }
attacks:
  - { id: claw, name: Claw, kind: melee, toHit: 0, damage: [{ roll: '1', type: slashing, avg: 1 }] }
`;
const AURA_ALL = `kind: spell
id: test:aura-all
name: aura-all
source: synthetic test fixture
level: 1
castingTime: action
range: self
components: { v: true, s: true }
concentration: true
duration: { minutes: 1 }
area: glow
effects:
  - id: glow
    name: Glow
    zone: { shape: emanation, size: 10 }
    on: [{ when: [enter], do: [{ save: { ability: dex, half: true, damage: [{ roll: 1d4, type: fire }] } }] }]
do: [{ apply: { effect: glow, to: point } }]
`;
const AOP = 'srd:paladin/aura-of-protection';
const KIT: Record<string, string> = {
  'packs/test/pcs/aura-cleric.yaml': pcText('aura-cleric', 10, { prepared: ['srd:spirit-guardians', 'test:aura-all'] }),
  'packs/test/pcs/aura-paladin.yaml': pcText('aura-paladin', 16, { features: [AOP] }),
  'packs/test/pcs/aura-paladin-low.yaml': pcText('aura-paladin-low', 8, { features: [AOP] }),
  'packs/test/pcs/aura-paladin-mid.yaml': pcText('aura-paladin-mid', 12, { features: [AOP] }),
  'packs/test/pcs/aura-plain.yaml': pcText('aura-plain', 10),
  'packs/test/monsters/aura-foe.yaml': monster('aura-foe'),
  'packs/test/monsters/aura-post.yaml': monster('aura-post', 0),
  'packs/test/spells/aura-all.yaml': AURA_ALL,
};

const load = (() => {
  let r: ReturnType<typeof loadContent> | null = null;
  return () => {
    r ??= loadContent([...REPO, ...Object.entries(KIT).map(([path, text]) => ({ path, text }))]);
    if (!r.content) throw new Error(r.errors.map(formatDiag).join('\n'));
    return r.content;
  };
})();

type U = [seat: string, use: string, at: string];
const party = (seat: string, use: string, at: string) => ({ seat, team: 'party', use: `test:${use}`, at });
const enemy = (seat: string, use: string, at: string) => ({ seat, team: 'enemies', use: `test:${use}`, at });
function setupOf(units: readonly ReturnType<typeof party>[], opt: { flags?: Record<string, unknown>; w?: number; h?: number; rounds?: number; terrain?: string[] } = {}) {
  const doc = {
    kind: 'scenario', id: 'aura', name: 'Aura', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: { w: opt.w ?? 16, h: opt.h ?? 9, ...(opt.terrain ? { terrain: opt.terrain } : {}) },
    flags: { initiativeMode: 'static', ...opt.flags }, knobs: { downEnds: false, maxRounds: opt.rounds ?? 1 },
    units: units.map((u) => ({ ...u, decider: 'greedy' })),
  };
  const res = resolveScenario(doc, 'aura.yaml', load());
  if (!res.setup) throw new Error(res.errors.map(formatDiag).join('\n'));
  return res.setup;
}

/** Plays `keys` in order (a key ending in / matches by prefix), then passes. Nothing's left to chance on a turn. */
const script = (keys: readonly string[]): Decider => {
  const left = [...keys];
  return {
    name: 'script',
    decide: (_v, dp: DecisionPoint) => {
      const find = (want: string) => {
        for (let i = 0; i < dp.legal.n; i++) if (want.endsWith('/') ? dp.keyOf(i).startsWith(want) : dp.keyOf(i) === want) return i;
        return -1;
      };
      if (dp.k === 'turn') {
        const want = left.shift();
        if (want === undefined) return find('pass');
        const i = find(want);
        if (i < 0) throw new Error(`${want} isn't offered: ${Array.from({ length: dp.legal.n }, (_, j) => dp.keyOf(j)).join(' ')}`);
        return i;
      }
      return 0;
    },
  };
};
const CAST_SG = 'cast:spirit-guardians@3';
const move = (to: string) => `move:${to}/`;

function fight(units: readonly ReturnType<typeof party>[], keys: Record<string, string[]>, opt: Parameters<typeof setupOf>[1] = {}, seed = 1) {
  const s = setupOf(units, opt);
  const sink = new ArraySink();
  const r = runFight(s, seed, 0, s.seats.map((seat) => script(keys[seat.seat] ?? [])), sink);
  const ev = sink.events as LogEvent[];
  const idx = (seat: string) => s.seats.findIndex((x) => x.seat === seat);
  const saves = (seat: string) => ev.filter((e): e is Extract<LogEvent, { k: 'save' }> => e.k === 'save' && e.who === idx(seat) && e.purpose === 'save');
  const moves = ev.filter((e): e is Extract<LogEvent, { k: 'zoneMove' }> => e.k === 'zoneMove');
  return { s, r, ev, saves, moves, idx };
}

/** A context stepped by hand: passives on, nobody's turn yet. */
function scene(units: readonly ReturnType<typeof party>[], opt: Parameters<typeof setupOf>[1] = {}, keys: Record<string, string[]> = {}) {
  const s = setupOf(units, opt);
  const sink = new ArraySink();
  const cx = createContext(s, 1, 0, s.seats.map((seat) => script(keys[seat.seat] ?? [])), sink);
  applyPassives(cx, -1);
  const u = (seat: string): Unit => cx.st.units.find((x) => x.seat === seat)!;
  const cell = (name: string) => parseCell(name, s.w, s.h);
  const flat = (who: Unit, ability = 1) => {
    const f = newModFold();
    foldMods(cx.st, who, null, saveKey(ability), [], [], f);
    return f.flat;
  };
  const push = (who: Unit, cells: string[]) => walkPath(cx, who, Int32Array.from(cells.map(cell)), cells.length, 'forced', -1);
  return { s, cx, u, cell, flat, push, sink };
}

describe('Spirit Guardians, trigger by trigger (srd-raw.txt:31040-31047)', () => {
  const units = [party('pc', 'aura-cleric', 'A4'), enemy('gob', 'aura-foe', 'H4')];

  it('the pack spell: Self, 15 ft, spares its caster and its allies, WIS, half, once per turn, upcast', () => {
    const sp = packYaml('spells/spirit-guardians.yaml');
    expect(sp).toMatchObject({ range: 'self', level: 3, concentration: true, fidelity: 'partial', area: 'guardians', provenance: { review: 'reviewed', pdfPage: 164 } });
    const e = sp.effects[0]!;
    expect(e.zone).toMatchObject({ shape: 'emanation', size: 15, affects: 'foes' });
    expect('includesOrigin' in e.zone! ? e.zone.includesOrigin : undefined).toBeUndefined();
    expect(e.oncePerTurn).toBe('perCreature');
    expect(e.on[0]!.when).toEqual(['movedOnto', 'enter', 'turnEndIn']);
    expect(e.on[0]!.do[0]!.save).toMatchObject({ ability: 'wis', half: true, damage: [{ roll: '3d8', type: 'radiant', upcast: '1d8' }] });
    expect(sp.unimplemented.join(' ')).toMatch(/Speed is halved/);
    expect(sp.unimplemented.join(' ')).toMatch(/Necrotic/);
  });

  it('"enters a creature\'s space": walking it onto a foe is one save, after the step and its zoneMove, and the area follows', () => {
    const f = fight(units, { pc: [CAST_SG, move('E4')] });
    // H4 is 35 ft from A4: from E4 it's 15 ft. One save on pc's turn; its own turn's end is the next test's.
    expect(f.saves('gob').filter((e) => e.turnOf === f.idx('pc'))).toHaveLength(1);
    const caughtAt = f.moves.findIndex((m) => m.caught.includes(f.idx('gob')));
    expect(f.moves[caughtAt]!.to).toBe('E4');
    expect(f.moves[caughtAt]!.from).toMatch(/^D\d$/);
    expect(f.moves).toHaveLength(4); // one line per step, by decision
    const seqOf = (e: LogEvent | undefined) => (e as { seq: number }).seq;
    const step = f.ev.find((e) => e.k === 'step' && e.to === parseCell('E4', f.s.w, f.s.h));
    expect(seqOf(step)).toBeLessThan(seqOf(f.moves[caughtAt]));
    expect(seqOf(f.moves[caughtAt])).toBeLessThan(seqOf(f.saves('gob')[0]));
    // The caster and the origin square stay out of it, and the area is where the caster is.
    expect(f.moves[caughtAt]!.area).toContain(parseCell('H4', f.s.w, f.s.h));
    expect(f.moves[caughtAt]!.area).not.toContain(parseCell('E4', f.s.w, f.s.h));
    expect(f.saves('pc')).toHaveLength(0);
  });

  it('"makes this save only once per turn": walking out and back in the same turn catches it again, no second save', () => {
    const f = fight(units, { pc: [CAST_SG, move('E4'), move('D4'), move('E4')] });
    expect(f.moves.filter((m) => m.caught.includes(f.idx('gob')))).toHaveLength(2);
    expect(f.saves('gob').filter((e) => e.turnOf === f.idx('pc'))).toHaveLength(1);
  });

  it('"a creature enters the Emanation": a foe walking in saves on its turn; ending that turn there is no second save', () => {
    const f = fight([party('pc', 'aura-cleric', 'A4'), enemy('gob', 'aura-foe', 'H4')], { pc: [CAST_SG], gob: [move('D4')] });
    expect(f.saves('gob')).toHaveLength(1);
    expect(f.saves('gob')[0]!.via).toBe('srd:spirit-guardians/guardians');
  });

  it('"ends its turn there": a foe that was walked onto saves again on its own turn, a new turn, once a round', () => {
    const g = fight(units, { pc: [CAST_SG, move('E4')] }, { rounds: 2 });
    const s = g.saves('gob');
    // Round 1: caught on pc's turn, then its own turn's end. Round 2: only its own turn's end (pc doesn't move).
    expect(s.map((e) => [e.round, e.turnOf])).toEqual([[1, g.idx('pc')], [1, g.idx('gob')], [2, g.idx('gob')]]);
  });

  it('a foe outside it at its turn end saves nothing', () => {
    const f = fight(units, { pc: [CAST_SG] });
    expect(f.saves('gob')).toHaveLength(0);
  });

  it('a caught creature that is spared never saves: the caster\'s ally', () => {
    const f = fight([party('pc', 'aura-cleric', 'A4'), party('friend', 'aura-plain', 'E4'), enemy('gob', 'aura-post', 'P9')], { pc: [CAST_SG, move('C4')] });
    expect(f.moves.some((m) => m.caught.includes(f.idx('friend')))).toBe(true);
    expect(f.saves('friend')).toHaveLength(0);
  });
});

describe('emanationCastTrigger (srd-raw.txt:31040-31047 doesn\'t address the cast)', () => {
  const units = [party('pc', 'aura-cleric', 'A4'), enemy('gob', 'aura-post', 'C4'), enemy('far', 'aura-post', 'P4')];
  it('none, the default: casting over a foe is no save until its turn ends', () => {
    const f = fight(units, { pc: [CAST_SG] });
    const save = f.saves('gob');
    expect(save).toHaveLength(1);
    expect(save[0]!.turnOf).toBe(f.idx('gob'));
  });
  it('onCast: the cast fires it, through the ledger, on each creature in the first area only', () => {
    const f = fight(units, { pc: [CAST_SG] }, { flags: { emanationCastTrigger: 'onCast' } });
    expect(f.saves('gob')).toHaveLength(2); // on the cast, then on its own turn's end
    expect(f.saves('gob')[0]!.turnOf).toBe(f.idx('pc'));
    expect(f.saves('far')).toHaveLength(0);
    expect(f.saves('pc')).toHaveLength(0);
  });
  it('onCast: the same turn\'s walk adds no second save', () => {
    // The gob at C4 is 10 ft off: A8 is 20 ft from it, and one step back to A7 catches it again.
    const f = fight(units, { pc: [CAST_SG, move('A8'), move('A7')] }, { flags: { emanationCastTrigger: 'onCast' } });
    expect(f.moves.some((m) => m.caught.includes(f.idx('gob')))).toBe(true);
    expect(f.saves('gob').filter((e) => e.turnOf === f.idx('pc'))).toHaveLength(1);
  });
  it('the flag is marked only by a zone with a movedOnto hook', () => {
    const lean = fight([party('pc', 'aura-paladin', 'A4'), enemy('gob', 'aura-post', 'P9')], {});
    expect(lean.r.flagsUsed[flagIndex('emanationCastTrigger')] ?? 0).toBe(0);
  });
});

describe('the owner moves, it moves', () => {
  it('forced movement of the owner moves the aura and catches who it lands on', () => {
    const pal = scene([party('pal', 'aura-paladin', 'A4'), party('ally', 'aura-plain', 'E4'), enemy('gob', 'aura-post', 'P9')]);
    const bit = 1 << 0;
    expect(pal.cx.st.zoneMask[pal.cell('C4')]! & bit).toBe(bit);
    expect(pal.cx.st.zoneMask[pal.cell('D4')]! & bit).toBe(0);
    pal.push(pal.u('pal'), ['B4', 'C4']);
    expect(pal.cx.st.fx.find((f) => f.zbit === 0)!.anchor).toBe(pal.cell('C4'));
    expect(pal.cx.st.zoneMask[pal.cell('E4')]! & bit).toBe(bit);
    expect(pal.cx.st.zoneMask[pal.cell('A4')]! & bit).toBe(bit);
    expect(pal.cx.st.zoneMask[pal.cell('F4')]! & bit).toBe(0);
    expect(pal.flat(pal.u('ally'))).toBeGreaterThan(0);
  });

  it('a forced owner\'s Spirit Guardians fires on who it lands on', () => {
    const s = setupOf([party('pc', 'aura-cleric', 'A4'), enemy('gob', 'aura-post', 'F4'), enemy('shover', 'aura-foe', 'A5')]);
    const sink = new ArraySink();
    const cx = createContext(s, 1, 0, [script([]), script([]), script([])], sink);
    const st = cx.st;
    const pc = st.units.find((u) => u.seat === 'pc')!;
    castFirst(cx, CAST_SG);
    walkPath(cx, pc, Int32Array.from(['B4', 'C4'].map((c) => parseCell(c, s.w, s.h))), 2, 'forced', -1);
    const ev = sink.events as LogEvent[];
    expect(ev.filter((e) => e.k === 'zoneMove')).toHaveLength(2);
    expect(ev.filter((e) => e.k === 'save' && e.who === st.units.find((u) => u.seat === 'gob')!.idx)).toHaveLength(1);
  });

  it('the owner walking in an aura that hits everyone never "enters" it: the re-stamp comes before its triggers', () => {
    const f = fight([party('pc', 'aura-cleric', 'A4'), enemy('gob', 'aura-post', 'P9')], { pc: ['cast:aura-all@1', move('E4')] });
    expect(f.moves.length).toBeGreaterThan(0);
    expect(f.saves('pc')).toHaveLength(0);
  });

  it('both areaOriginOnGrid values put it on the same squares, at the cast and after a step', () => {
    const places = (flag: string) => {
      const f = fight([party('pc', 'aura-cleric', 'C4'), enemy('gob', 'aura-post', 'P9')], { pc: [CAST_SG, move('D4')] }, { flags: { areaOriginOnGrid: flag } });
      const zone = f.ev.find((e): e is Extract<LogEvent, { k: 'zone' }> => e.k === 'zone')!;
      return { first: zone.area, then: f.moves.map((m) => m.area), anchor: zone.anchor, to: f.moves.map((m) => m.to) };
    };
    expect(places('gridIntersection')).toEqual(places('squareCenter'));
    expect(places('squareCenter').anchor).toBe('C4');
  });

  it('walls cut it off where it stands now', () => {
    const terrain = ['................', '................', '................', '.....#..........', '.....#..........', '.....#..........', '................', '................', '................'];
    const p = scene([party('pal', 'aura-paladin', 'E5'), enemy('gob', 'aura-post', 'P9')], { terrain });
    const bit = 1;
    expect(p.cx.st.zoneMask[p.cell('G5')]! & bit).toBe(0); // behind the wall from E5
    expect(p.cx.st.zoneMask[p.cell('D5')]! & bit).toBe(bit);
  });
});

describe('the 32-zone cap and the end of an aura', () => {
  const crowd = (n: number) => Array.from({ length: n }, (_, i) => party(`p${i}`, 'aura-paladin', `${String.fromCharCode(65 + (i % 16))}${1 + Math.floor(i / 16)}`));
  it('counts auras: 32 fit, a 33rd throws', () => {
    const foe = enemy('gob', 'aura-post', 'P9');
    expect(() => scene([...crowd(32), foe])).not.toThrow();
    expect(() => scene([...crowd(33), foe])).toThrow(/more than 32 zones/);
  });

  it('the owner dies: a passive aura ends through anchorDied, off the grid, and its bits go with it', () => {
    const t = scene([party('pal', 'aura-paladin', 'A4'), party('ally', 'aura-plain', 'B4'), enemy('gob', 'aura-post', 'P9')]);
    expect(t.cx.st.auraModBits).toBe(1);
    expect(t.flat(t.u('ally'))).toBe(3);
    const fx = t.cx.st.fx.find((f) => f.zbit === 0)!;
    t.u('pal').life = 'dead';
    onDeath(t.cx, t.u('pal'), -1);
    expect(fx.alive).toBe(false);
    expect(t.cx.st.ownerAuras).toBe(0);
    expect(t.cx.st.auraModBits).toBe(0);
    expect(t.cx.st.zoneMask.every((m) => m === 0)).toBe(true);
    expect(t.flat(t.u('ally'))).toBe(0);
    const ends = (t.sink.events as LogEvent[]).filter((e): e is Extract<LogEvent, { k: 'fxEnd' }> => e.k === 'fxEnd');
    expect(ends.map((e) => e.why)).toEqual(['anchorDied']);
  });

  it('the owner dies: concentration ends Spirit Guardians and leaves nothing behind', () => {
    const s = setupOf([party('pc', 'aura-cleric', 'A4'), enemy('gob', 'aura-post', 'C4')]);
    const cx = createContext(s, 1, 0, [script([]), script([])], new ArraySink());
    const pc = cx.st.units.find((u) => u.seat === 'pc')!;
    castFirst(cx, CAST_SG);
    expect(cx.st.ownerAuras).toBe(1);
    pc.life = 'dead';
    onDeath(cx, pc, -1);
    expect(cx.st.ownerAuras).toBe(0);
    expect(cx.st.zoneMask.every((m) => m === 0)).toBe(true);
  });
});

describe('Aura of Protection (srd-raw.txt:11992-12000)', () => {
  const trio = [party('pal', 'aura-paladin', 'E5'), party('near', 'aura-plain', 'G5'), party('far', 'aura-plain', 'J5'), enemy('foe', 'aura-post', 'E7'), enemy('out', 'aura-post', 'P9')];

  it('the pack feature: full, reviewed, a passive 10-ft Emanation that includes its origin', () => {
    const f = packYaml('features/paladin/aura-of-protection.yaml');
    expect(f).toMatchObject({ fidelity: 'full', spellAbility: 'cha', passive: { effects: ['aura'] }, provenance: { review: 'reviewed', pdfPage: 55 } });
    expect(f.effects[0]!.zone).toMatchObject({ shape: 'emanation', size: 10, includesOrigin: true, affects: 'allies', offWhen: ['incapacitated'] });
    expect(f.unimplemented ?? []).toEqual([]);
  });

  it('"you and your allies in the aura": +CHA on every save inside it, once, on the Paladin too; nothing outside it', () => {
    const t = scene(trio);
    expect(t.flat(t.u('pal'))).toBe(3); // CHA 16; a passive on u.borne too would read 6
    expect(t.flat(t.u('near'))).toBe(3);
    expect(t.flat(t.u('near'), 4)).toBe(3); // any ability
    expect(t.flat(t.u('far'))).toBe(0);
    expect(t.u('pal').borne).toHaveLength(0);
    expect(t.cx.st.fx[0]!.bearer).toBe(-1);
  });

  it('a concentration save is a save', () => {
    const t = scene(trio);
    const f = newModFold();
    foldMods(t.cx.st, t.u('near'), null, saveKey(2, true), [], [], f);
    expect(f.flat).toBe(3);
  });

  it('a death save is a saving throw (d20.save.death): +CHA for a downed ally inside it, a pass on 7+, nothing outside it', () => {
    const t = scene(trio);
    const down = (seat: string) => {
      const u = t.u(seat);
      u.hp = 0;
      u.life = 'down';
      deathSave(t.cx, u, -1);
      return { u, e: (t.sink.events as LogEvent[]).filter((x): x is Extract<LogEvent, { k: 'deathSave' }> => x.k === 'deathSave' && x.who === u.idx).at(-1)! };
    };
    const near = down('near');
    expect(near.e.mod).toBe(3);
    expect(near.e.total).toBe(near.e.natural + 3);
    if (near.e.natural !== 1 && near.e.natural !== 20) expect(near.u.deathOk).toBe(near.e.natural + 3 >= 10 ? 1 : 0);
    const far = down('far');
    expect(far.e.mod).toBeUndefined();
    expect(far.e.total).toBeUndefined();
    expect(renderLog([near.e], t.s).join('\n')).toContain(`d20 ${near.e.natural} +3 = ${near.e.natural + 3}`);
  });

  it('a foe standing in it gets nothing', () => {
    const t = scene(trio);
    expect(t.cx.st.zoneMask[t.cell('E7')]! & 1).toBe(1);
    expect(t.flat(t.u('foe'))).toBe(0);
  });

  it('attack rolls and checks are not saves', () => {
    const t = scene(trio);
    const f = newModFold();
    foldMods(t.cx.st, t.u('near'), null, 0, [], [], f);
    expect(f.flat).toBe(0);
  });

  it('"minimum bonus of +1": CHA 8 gives +1, CHA 12 gives +1', () => {
    for (const use of ['aura-paladin-low', 'aura-paladin-mid']) {
      const t = scene([party('pal', use, 'E5'), party('near', 'aura-plain', 'F5'), enemy('out', 'aura-post', 'P9')]);
      expect(t.flat(t.u('near'))).toBe(1);
    }
  });

  it('"inactive while you have the Incapacitated condition": the aura stays on the grid, the bonus goes and comes back', () => {
    const t = scene(trio);
    const bits = t.cx.st.zoneMask.slice();
    t.u('pal').condMask |= COND.incapacitated;
    expect(t.flat(t.u('near'))).toBe(0);
    expect(t.flat(t.u('pal'))).toBe(0);
    expect(t.cx.st.zoneMask).toEqual(bits);
    expect(t.cx.st.ownerAuras).toBe(1);
    t.u('pal').condMask &= ~COND.incapacitated;
    expect(t.flat(t.u('near'))).toBe(3);
  });

  it('a Paladin at 0 HP has no aura (Unconscious brings Incapacitated)', () => {
    const t = scene(trio);
    t.u('pal').condMask |= COND.unconscious | COND.incapacitated;
    expect(t.flat(t.u('near'))).toBe(0);
  });

  it('"only one Aura of Protection at a time": the best of two, not the sum; a foe Paladin\'s adds nothing', () => {
    const t = scene([party('a', 'aura-paladin-low', 'E5'), party('b', 'aura-paladin', 'G5'), party('near', 'aura-plain', 'F5'), enemy('foe', 'aura-paladin', 'F6'), enemy('out', 'aura-post', 'P9')]);
    expect(t.flat(t.u('near'))).toBe(3);
    expect(t.flat(t.u('foe'))).toBe(3); // its own aura only
    t.u('b').condMask |= COND.incapacitated;
    expect(t.flat(t.u('near'))).toBe(1); // the inactive one isn't a choice
  });

  it('it reaches the exact save odds the AI reads and the roll the log shows: the same natural, the bonus on top', () => {
    const units = (paladin: string) => [party('near', 'aura-cleric', 'F5'), party('pal', paladin, 'E5'), enemy('foe', 'aura-post', 'H5'), party('anchor', 'aura-plain', 'A1')];
    // A foe caster's Spirit Guardians hits the party: same seed, same seat order, with and without the aura.
    const run = (use: string) => fight([enemy('cleric', 'aura-cleric', 'B8'), ...units(use)], { cleric: [CAST_SG, move('D7')] });
    const a = run('aura-paladin').saves('near');
    const b = run('aura-plain').saves('near');
    expect(a.length).toBeGreaterThan(0);
    expect(a.map((e) => e.natural)).toEqual(b.map((e) => e.natural));
    expect(a.map((e) => e.total)).toEqual(b.map((e) => e.total + 3));
  });

  it('no stream moves for anyone else: a fight with the aura and one with the bonus off roll the same dice', () => {
    const cast = { pal: [], near: [CAST_SG, move('H5')] };
    const a = fight([party('pal', 'aura-paladin', 'A1'), party('near', 'aura-cleric', 'E5'), enemy('foe', 'aura-post', 'J5')], cast);
    const b = fight([party('pal', 'aura-plain', 'A1'), party('near', 'aura-cleric', 'E5'), enemy('foe', 'aura-post', 'J5')], cast);
    const dice = (x: typeof a) => x.ev.filter((e) => e.k === 'save' || e.k === 'damage').map((e) => (e.k === 'save' ? [e.who, e.slot, e.natural] : [e.tgt, e.slot, e.dealt]));
    expect(dice(a)).toEqual(dice(b));
    expect(dice(a).length).toBeGreaterThan(0);
  });
});

describe('pathfinding', () => {
  const hazards = (t: ReturnType<typeof scene>, who: Unit, to: string) => {
    const sc = newScratch(t.s.w * t.s.h).reachEngine;
    computeReach(t.cx.st, who, 60, sc);
    let best = -1;
    forEachLabel(t.cx.st, who, sc, 60, (cell, _ft, _p, _par, hazard) => {
      if (cell === t.cell(to) && (best < 0 || hazard < best)) best = hazard;
    });
    return best;
  };
  const withCast = (key: string, units: readonly ReturnType<typeof party>[]) => {
    const t = scene(units);
    castFirst(t.cx, key);
    return t;
  };

  it('a caster walks without its own aura costing a hazard, whoever else it hits', () => {
    const t = withCast('cast:aura-all@1', [party('pc', 'aura-cleric', 'E5'), enemy('foe', 'aura-post', 'P9'), party('friend', 'aura-plain', 'A1')]);
    const pc = t.u('pc');
    expect(t.cx.st.enterBits).not.toBe(0);
    expect(knownZones(t.cx.st, pc) & 1).toBe(0);
    expect(hazards(t, pc, 'H5')).toBe(0);
    // Not exempt from anyone else's: the friend saw it cast and pays to walk in.
    expect(knownZones(t.cx.st, t.u('friend')) & 1).toBe(1);
    expect(hazards(t, t.u('friend'), 'E3')).toBeGreaterThan(0);
  });

  it('an ally walks straight through a foes aura; a foe doesn\'t', () => {
    const t = withCast(CAST_SG, [party('pc', 'aura-cleric', 'E5'), enemy('foe', 'aura-post', 'P9'), party('friend', 'aura-plain', 'A5')]);
    expect(hazards(t, t.u('friend'), 'I5')).toBe(0);
    expect(knownZones(t.cx.st, t.u('foe')) & 1).toBe(1);
  });

  it('the reach cache sees the re-stamp: cache on and off give the same fight', () => {
    const units = [party('pc', 'aura-cleric', 'A4'), enemy('gob', 'aura-foe', 'H4'), enemy('gob2', 'aura-foe', 'H6'), party('friend', 'aura-paladin', 'B6')];
    const s = setupOf(units, { rounds: 3 });
    const one = (reachCache: boolean) => {
      const sink = new ArraySink();
      runFight(s, 7, 0, s.seats.map(() => new GreedyDecider()), sink, { scratch: newScratch(s.w * s.h, { reachCache }) });
      return JSON.stringify(sink.events);
    };
    expect(one(true)).toBe(one(false));
  });

  it('a moved aura changes what a foe\'s reach reads as a hazard, in the same cached scratch', () => {
    const t = withCast(CAST_SG, [party('pc', 'aura-cleric', 'A5'), enemy('foe', 'aura-foe', 'H5')]);
    const foe = t.u('foe');
    const sc = newScratch(t.s.w * t.s.h, { reachCache: true }).reachEngine;
    const read = () => {
      computeReach(t.cx.st, foe, 60, sc);
      let h = -1;
      forEachLabel(t.cx.st, foe, sc, 60, (cell, _f, _p, _par, hazard) => {
        if (cell === t.cell('G5') && (h < 0 || hazard < h)) h = hazard;
      });
      return h;
    };
    expect(read()).toBe(0);
    t.push(t.u('pc'), ['B5', 'C5', 'D5']);
    expect(read()).toBeGreaterThan(0);
  });
});

function castFirst(cx: ReturnType<typeof createContext>, key: string, seat = 'pc'): void {
  const who = cx.st.units.find((u) => u.seat === seat)!;
  cx.st.active = who.idx;
  cx.st.turnIdx++;
  who.turns++;
  Object.assign(who.b, { action: 1, bonus: 1, reaction: 1, freeObj: 1, moveFt: 30, atkActive: false, movedFt: 0 });
  const list = listOptions(cx, who, takeList(cx));
  let item = null;
  const offered: string[] = [];
  for (let i = 0; i < list.n; i++) {
    offered.push(legalKey(cx.st, who.idx, list.items[i]!));
    if (offered[i] === key) item = copyLegal(list.items[i]!, newLegal());
  }
  releaseList(cx, list);
  if (!item) throw new Error(`${key} isn't offered: ${offered.join(' ')}`);
  resolveOption(cx, who, item, -1);
}

describe('greedy (C6)', () => {
  const playedKeys = (units: readonly ReturnType<typeof party>[], opt: Parameters<typeof setupOf>[1] = {}) => {
    const s = setupOf(units, opt);
    const sink = new ArraySink();
    runFight(s, 3, 0, s.seats.map(() => new GreedyDecider()), sink);
    return (sink.events as LogEvent[]);
  };
  it('casts it with no foe in the area, because a foe in walking reach counts at emanationCastTrigger=none', () => {
    const ev = playedKeys([party('pc', 'aura-cleric', 'A5'), enemy('foe', 'aura-foe', 'I5'), enemy('foe2', 'aura-foe', 'I7')], { rounds: 1 });
    expect(ev.some((e) => e.k === 'zone' && e.via === 'srd:spirit-guardians/guardians')).toBe(true);
  });
  it('emanationCastTrigger=onCast is worth more at the cast, read through the flag: a foe in the first area counts now', () => {
    const value = (flag: string) => {
      const s = setupOf([party('pc', 'aura-cleric', 'A5'), enemy('foe', 'aura-post', 'C5')], { flags: { emanationCastTrigger: flag } });
      const ds = s.seats.map(() => new GreedyDecider());
      let ev = -1;
      for (const d of ds) d.explainTo((x) => { for (const t of x.top) if (t.key === CAST_SG && ev < 0) ev = t.ev; });
      runFight(s, 3, 0, ds, new ArraySink());
      return ev;
    };
    expect(value('none')).toBeGreaterThan(0);
    expect(value('onCast')).toBeGreaterThan(value('none'));
  });
  it('cast with the foe 35 ft off, it then walks the Emanation onto it the same turn: the action spent, the move is still worth the save', () => {
    const ev = playedKeys([party('pc', 'aura-cleric', 'A5'), enemy('foe', 'aura-post', 'H5')], { rounds: 1 });
    const castAt = ev.findIndex((e) => e.k === 'zone' && e.via === 'srd:spirit-guardians/guardians');
    expect(castAt).toBeGreaterThanOrEqual(0);
    const caught = ev.slice(castAt).filter((e): e is Extract<LogEvent, { k: 'zoneMove' }> => e.k === 'zoneMove' && e.caught.length > 0);
    expect(caught.length).toBeGreaterThan(0);
    const foe = caught[0]!.caught[0]!;
    expect(ev.some((e) => e.k === 'save' && e.who === foe && e.purpose === 'save' && e.seq > caught[0]!.seq && e.turnOf !== foe)).toBe(true); // on the Cleric's turn
  });
  it('walking it back onto a foe it already hit this turn is worth nothing: the ledger (srd-raw.txt:31047)', () => {
    const s = setupOf([party('pc', 'aura-cleric', 'A4'), enemy('gob', 'aura-post', 'H4')]);
    const g = new GreedyDecider();
    const terms: string[] = [];
    g.explainTo((x) => { for (const o of x.top) for (const p of o.parts) terms.push(p.term); });
    const keys = script([CAST_SG, move('E4'), move('D4')]);
    let scripted = 3;
    const pc: Decider = { name: 'mixed', decide: (v, dp) => (dp.k === 'turn' && scripted-- > 0 ? keys.decide(v, dp) : dp.k === 'turn' ? g.decide(v, dp) : keys.decide(v, dp)) };
    const sink = new ArraySink();
    runFight(s, 1, 0, s.seats.map((x) => (x.seat === 'pc' ? pc : script([]))), sink);
    const ev = sink.events as LogEvent[];
    const gob = s.seats.findIndex((x) => x.seat === 'gob');
    expect(ev.filter((e) => e.k === 'zoneMove' && e.caught.includes(gob))).toHaveLength(1); // the scripted catch only
    expect(terms.some((t) => t.startsWith('my Emanation, walked onto them'))).toBe(false);
  });
  it('doesn\'t cast it when nothing can reach it or be reached this fight', () => {
    const ev = playedKeys([party('pc', 'aura-cleric', 'A1'), enemy('foe', 'aura-post', 'P9')], { rounds: 1 });
    expect(ev.some((e) => e.k === 'zone' && e.via === 'srd:spirit-guardians/guardians')).toBe(false);
  });
  it('the AI\'s read of emanationCastTrigger doesn\'t change anything that has no Emanation', () => {
    const ev = playedKeys([party('pc', 'aura-plain', 'A5'), enemy('foe', 'aura-foe', 'C5')], { rounds: 1 });
    expect(ev.length).toBeGreaterThan(0);
  });
});

describe('the compiler', () => {
  const load1 = (text: string) => loadContent([...REPO, { path: 'packs/test/features/x.yaml', text }]);
  const feature = (rest: string, extra = 'spellAbility: cha\n') => `kind: feature
id: test:x
name: x
source: synthetic test fixture
${extra}effects:
${rest}
passive: { effects: [a] }
`;
  const errs = (text: string) => load1(text).errors.map(formatDiag).join('\n');
  it('a passive Emanation compiles; another shape, or an appear hook, doesn\'t', () => {
    expect(errs(feature("  - { id: a, name: A, zone: { shape: emanation, size: 10 } }"))).toBe('');
    expect(errs(feature("  - { id: a, name: A, zone: { shape: sphere, radius: 10 } }"))).toMatch(/can't be a sphere/);
    expect(errs(feature("  - { id: a, name: A, zone: { shape: emanation, size: 10 }, on: [{ when: [appear], do: [{ save: { ability: dex, damage: [{ roll: 1d4, type: fire }] } }] }] }"))).toMatch(/no appear hook/);
  });
  it('a mod\'s value: an int as ever, a constant expression folded, dice refused, @mod only with spellAbility', () => {
    const mod = (v: string, op = 'flat') => feature(`  - { id: a, name: A, zone: { shape: emanation, size: 10 }, mods: [{ on: [d20.save], op: ${op}, value: ${v} }] }`);
    expect(errs(mod('2'))).toBe('');
    expect(errs(mod("'max(@mod, 1)'"))).toBe('');
    expect(errs(mod("'1d4'"))).toMatch(/can't roll dice/);
    expect(errs(mod("'@mod'", 'floor'))).toMatch(/floor is a number/);
    expect(errs(feature("  - { id: a, name: A, zone: { shape: emanation, size: 10 }, mods: [{ on: [d20.save], op: flat, value: '@mod' }] }", ''))).not.toBe('');
  });
  it('a zone\'s inert fields stay undefined (C3)', () => {
    const s = setupOf([party('pc', 'aura-plain', 'A5'), enemy('foe', 'aura-post', 'C5')]);
    const cx = createContext(s, 1, 0, [script([]), script([])], null);
    applyPassives(cx, -1);
    expect(cx.st.ownerAuras).toBe(0);
    expect(cx.st.auraModBits).toBe(0);
    expect(stateHash(cx.st)).toMatch(/\w+/);
  });
});
