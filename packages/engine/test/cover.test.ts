// M3 step 8: cover and line of sight (docs/design/m3.md section 7). Rules: SRD 5.2.1 "Cover"
// (srd-raw.txt:1995-2032) and its glossary entry (33044-33050); "A Clear Path to the Target"
// (23778-23780); opportunity attacks need sight (2096-2097); area line of effect (32672-32677).
// Every scene is a constructed ASCII grid: '#' wall, '+' Half Cover object, '*' Three-Quarters.
import { describe, expect, it } from 'vitest';
import { saveKey } from '../src/content/rollkeys.ts';
import { HOOK, type CompiledTemplate, type Step } from '../src/content/types.ts';
import type { Decider, DecisionPoint, UnitView } from '../src/decide/decider.ts';
import { areaCells, shapeKey } from '../src/grid/area.ts';
import { cellName, parseCell, parseTerrain, TERR } from '../src/grid/cells.ts';
import { buildLos, clearLine, COVER, coverDegree, crossesCell, cutOff } from '../src/grid/los.ts';
import { ArraySink } from '../src/log/events.ts';
import { renderLog } from '../src/log/render.ts';
import { header } from '../src/log/header.ts';
import { threatSplitAt } from '../src/query/threat.ts';
import { DEFAULT_FLAGS, hashedFlags, type RuleFlags } from '../src/rules/flags.ts';
import { resolveOption } from '../src/sim/act.ts';
import { buildAttackSpec } from '../src/sim/attack.ts';
import { copyLegal, legalKey, newLegal, releaseList, takeList } from '../src/sim/context.ts';
import { createContext, runFight } from '../src/sim/fight.ts';
import { listOptions } from '../src/sim/options.ts';
import type { Unit } from '../src/sim/state.ts';
import { makeDeciders } from '../src/decide/make.ts';
import { GreedyDecider } from '../src/decide/greedy/greedy.ts';
import { zoneValue, type VCtx } from '../src/decide/greedy/value.ts';
import { loadContent } from '../src/content/load.ts';
import { formatDiag } from '../src/content/yaml.ts';
import { ARCHER, caster, DUMMY, effect, entry, feature, REACHER, S, setup, spell, template } from './helpers/build.ts';
import { ofKind } from './helpers/run.ts';

class Keys implements Decider {
  readonly name = 'keys';
  readonly queue: string[];
  /** Every target decision's legal keys, in order. */
  readonly targetLists: string[][] = [];
  constructor(queue: string[] = []) {
    this.queue = queue;
  }
  decide(_v: UnitView, dp: DecisionPoint): number {
    if (dp.k === 'target') this.targetLists.push(Array.from({ length: dp.legal.n }, (_, i) => dp.keyOf(i)));
    if (this.queue.length > 0) {
      const want = this.queue[0]!;
      for (let k = 0; k < dp.legal.n; k++) {
        if (dp.keyOf(k) !== want) continue;
        this.queue.shift();
        return k;
      }
    }
    return 0;
  }
}

type Units = Parameters<typeof setup>[0]['units'];

function scene(terrain: string[], units: Units, flags: Partial<RuleFlags> = {}, keys: string[] = []) {
  const w = terrain[0]!.length;
  const h = terrain.length;
  const s = setup({ w, h, terrain, units, flags });
  const sink = new ArraySink();
  const k = new Keys(keys);
  const cx = createContext(s, 5, 0, s.seats.map(() => k), sink, { audit: true });
  cx.st.order.set(s.seats.map((_, i) => i)); // no initiative rolled: seat order
  const u = (seat: string): Unit => cx.st.units.find((x) => x.seat === seat)!;
  const begin = (who: Unit) => {
    cx.st.active = who.idx;
    cx.st.turnIdx++;
    who.turns++;
    Object.assign(who.b, { action: 1, bonus: 1, reaction: 1, freeObj: 1, moveFt: who.tpl.speedFt, atkActive: false });
  };
  const keysOf = (who: Unit) => {
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
  /** The AC `a` would roll against attacking `t` with its first attack from where it stands. */
  const acVs = (a: Unit, t: Unit) => buildAttackSpec(cx.st, a, 0, t, a.cell, [], []).dc;
  return { s, cx, u, begin, keysOf, choose, acVs, sink, k };
}

/** A caster with one area spell (level 1, 150 ft): a zone of `shape` whose appear hook is a DC 15 Dexterity save for 2d6 fire, half on a success. */
function blaster(shape: number, saveStep: Step = S.save(1, saveKey(1), 15, '2d6', 'fire', true)): CompiledTemplate {
  const BLAST = effect('blast', { sid: 21, zone: { shapeKey: shape, heightFt: 0, difficult: false }, hooks: [{ on: HOOK.appear, steps: [saveStep] }], hookMask: HOOK.appear });
  const instance = new Array<number>(10).fill(-1);
  instance[1] = 0;
  const sp = entry(spell('blast', { level: 1, conc: true, rangeFt: 150, areaShape: shape, sid: 21, s: false }), { 1: [S.apply(1, 'point')] }, { instance });
  return caster({ effects: [effect('blast-c', { conc: true, dur: { k: 'rounds', n: 10 } }), BLAST], spells: [sp] });
}

const SHOOTER = (at: string) => ({ seat: 'archer', team: 1 as const, tpl: ARCHER, at });
const MARK = (at: string, ac = 10) => ({ seat: 'mark', team: 0 as const, tpl: template({ id: 'mark', kind: 'pc', ac, hp: 200, dex: 10, attacks: [] }), at });
const BYSTANDER = (at: string) => ({ seat: 'ally', team: 1 as const, tpl: { ...DUMMY, speedFt: 30 }, at });

describe('grid/los.ts geometry (exact, integer)', () => {
  it('a line through a square\'s open interior crosses it; one along its edge or through its corner point does not', () => {
    // Square (1, 0) spans [2, 4] x [0, 2] in doubled units.
    expect(crossesCell(0, 1, 6, 1, 1, 0, 2)).toBe(true); // straight through the middle
    expect(crossesCell(0, 0, 6, 0, 1, 0, 2)).toBe(false); // along the top edge
    expect(crossesCell(0, 2, 6, 2, 1, 0, 2)).toBe(false); // along the bottom edge
    expect(crossesCell(0, 0, 4, 4, 1, 0, 2)).toBe(false); // through its corner point (2, 2) only
    expect(crossesCell(0, 4, 4, 0, 1, 0, 2)).toBe(true); // through (2, 2) and on into it
    expect(crossesCell(1, 1, 3, 1, 1, 0, 2)).toBe(true); // ends inside
    expect(crossesCell(0, 1, 2, 1, 1, 0, 2)).toBe(false); // stops at its edge
  });

  it("'+' and '*' parse to cover objects that don't block movement; '.', '#' and ':' are unchanged", () => {
    const t = parseTerrain(['.+*#:'], 5, 1);
    expect([...t]).toEqual([0, TERR.halfCover, TERR.threeQuarterCover, TERR.wall, TERR.difficult]);
    expect(() => parseTerrain(['.x'], 2, 1)).toThrow(/use \. # : \+ \*/);
  });
});

describe('Half Cover: "+2 bonus to AC and Dexterity saving throws" (srd-raw.txt:2006-2017)', () => {
  const map = ['.......', '.......'];
  it("an object that covers at least half of the target ('+' between) gives +2 AC, under both methods", () => {
    for (const losMethod of ['corners', 'centers'] as const) {
      const { u, acVs } = scene(['..+....', '.......'], [SHOOTER('A1'), MARK('E1', 14)], { losMethod });
      expect(acVs(u('archer'), u('mark')), losMethod).toBe(16);
    }
  });

  it('the attack event carries the cover and the log prints it: "vs AC 16 (Half Cover +2)"', () => {
    const { u, begin, choose, sink, s } = scene(['..+....', '.......'], [SHOOTER('A1'), MARK('E1', 14)]);
    begin(u('archer'));
    choose(u('archer'), 'attack:longbow>mark');
    const atk = ofKind(sink.events, 'attack')[0]!;
    expect(atk.ac).toBe(16);
    expect(atk.cover).toBe(COVER.half);
    expect(renderLog(sink.events, s).join('\n')).toMatch(/vs AC 16 \(Half Cover \+2\)/);
  });

  it('"Another creature" gives Half Cover: a creature in the line is +2 AC; creatureCover=off removes it', () => {
    expect(scene(map, [SHOOTER('A1'), BYSTANDER('C1'), MARK('E1', 14)]).acVs).toBeTypeOf('function');
    const on = scene(map, [SHOOTER('A1'), BYSTANDER('C1'), MARK('E1', 14)]);
    expect(on.acVs(on.u('archer'), on.u('mark'))).toBe(16);
    const off = scene(map, [SHOOTER('A1'), BYSTANDER('C1'), MARK('E1', 14)], { creatureCover: 'off' });
    expect(off.acVs(off.u('archer'), off.u('mark'))).toBe(14);
    // Nobody in the line: no cover.
    const clear = scene(map, [SHOOTER('A1'), BYSTANDER('C2'), MARK('E1', 14)]);
    expect(clear.acVs(clear.u('archer'), clear.u('mark'))).toBe(14);
  });

  it('degrees aren\'t added together: a creature and a \'+\' in the same line still give only Half (srd-raw.txt:2000-2004)', () => {
    const { u, acVs } = scene(['..+....', '.......'], [SHOOTER('A1'), BYSTANDER('D1'), MARK('F1', 14)]);
    expect(acVs(u('archer'), u('mark'))).toBe(16);
  });

  it('a Dexterity save against a spell cast through Half Cover gets +2, and the log shows it as its own term', () => {
    const zap = entry(spell('zap', { level: 0, rangeFt: 60, s: false, sid: 7 }), { 0: [S.target(60), S.save(1, saveKey(1), 13, '1d6', 'fire', false)] });
    const units: Units = [{ seat: 'pc', team: 0, tpl: caster({ spells: [zap] }), at: 'A1' }, { seat: 'gob', team: 1, tpl: { ...DUMMY, saveMod: [0, 3, 0, 0, 0, 0] }, at: 'E1' }];
    const run = (terrain: string[]) => {
      const sc = scene(terrain, units, {}, ['target:gob']);
      sc.begin(sc.u('pc'));
      sc.choose(sc.u('pc'), 'cast:zap@0');
      return { save: ofKind(sc.sink.events, 'save')[0]!, text: renderLog(sc.sink.events, sc.s).join('\n') };
    };
    const open = run(['.......']);
    const covered = run(['..+....']);
    expect(open.save.cover).toBeUndefined();
    expect(covered.save.cover).toBe(COVER.half);
    expect(covered.save.natural).toBe(open.save.natural); // same dice
    expect(covered.save.total).toBe(open.save.total + 2);
    expect(covered.text).toMatch(/\+3 \+2\(Half Cover\) = /);
  });

  it('a Strength save gets nothing from cover (the bonus is to AC and Dexterity saves only)', () => {
    const shove = entry(spell('shove', { level: 0, rangeFt: 60, s: false, sid: 8 }), { 0: [S.target(60), S.save(0, saveKey(0), 13, '1d6', 'force', false)] });
    const sc = scene(['..+....'], [{ seat: 'pc', team: 0, tpl: caster({ spells: [shove] }), at: 'A1' }, { seat: 'gob', team: 1, tpl: DUMMY, at: 'E1' }], {}, ['target:gob']);
    sc.begin(sc.u('pc'));
    sc.choose(sc.u('pc'), 'cast:shove@0');
    expect(ofKind(sc.sink.events, 'save')[0]!.cover).toBeUndefined();
  });
});

describe('Three-Quarters Cover: "+5 bonus to AC and Dexterity saving throws" (srd-raw.txt:2019-2026)', () => {
  it("an object that covers three-quarters ('*' squares blocking 3 of the 4 lines from the attacker's best corner) gives +5 AC", () => {
    // B1 shoots D3 past '*' at A1 and C2: every corner of B1 has 3 of its 4 lines to D3 blocked.
    const { u, acVs } = scene(['*......', '..*....', '.......', '.......'], [SHOOTER('B1'), MARK('D3', 14)]);
    expect(acVs(u('archer'), u('mark'))).toBe(19);
  });

  it("a single '*' in a straight line blocks only 2 lines from each corner: Half under corners, Three-Quarters under centers", () => {
    const corners = scene(['.......', '..*....', '.......'], [SHOOTER('A2'), MARK('E2', 14)]);
    expect(corners.acVs(corners.u('archer'), corners.u('mark'))).toBe(16);
    const centers = scene(['.......', '..*....', '.......'], [SHOOTER('A2'), MARK('E2', 14)], { losMethod: 'centers' });
    expect(centers.acVs(centers.u('archer'), centers.u('mark'))).toBe(19);
  });
});

describe('Total Cover: "Can\'t be targeted directly" (srd-raw.txt:2028-2032)', () => {
  // A wall from B1 to B2: from A1, every corner's 4 lines to D3 cross it.
  const WALL = ['.#.....', '.#.....', '.......', '.......'];

  it('an attack at a target behind Total Cover is not offered', () => {
    const { u, begin, keysOf } = scene(WALL, [SHOOTER('A1'), MARK('D3')]);
    begin(u('archer'));
    expect(keysOf(u('archer')).filter((k) => k.startsWith('attack:'))).toEqual([]);
    // Step out from behind it (A3) and the shot is offered again.
    const b = scene(WALL, [SHOOTER('A3'), MARK('D3')]);
    b.begin(b.u('archer'));
    expect(b.keysOf(b.u('archer'))).toContain('attack:longbow>mark');
  });

  it('"A Clear Path to the Target": a spell can\'t target a creature behind Total Cover (srd-raw.txt:23778-23780)', () => {
    const zap = entry(spell('zap', { level: 0, rangeFt: 60, s: false, sid: 7 }), { 0: [S.target(60), S.save(1, saveKey(1), 13, '1d6', 'fire', false)] });
    const units: Units = [{ seat: 'pc', team: 0, tpl: caster({ spells: [zap] }), at: 'A1' }, { seat: 'gob', team: 1, tpl: DUMMY, at: 'D3' }];
    const walled = scene(WALL, units);
    walled.begin(walled.u('pc'));
    expect(walled.keysOf(walled.u('pc'))).not.toContain('cast:zap@0');
    const open = scene(['.......', '.......', '.......', '.......'], units);
    open.begin(open.u('pc'));
    expect(open.keysOf(open.u('pc'))).toContain('cast:zap@0');
  });

  it('a wall the full height of the map has no gap on its border rows (the map edge reads as solid)', () => {
    const wall = Array.from({ length: 6 }, () => '.....#..');
    for (const [from, to] of [['E1', 'G1'], ['E3', 'G3'], ['E6', 'G6']] as const) {
      const s = scene(wall, [SHOOTER(from), MARK(to, 14)]);
      s.begin(s.u('archer'));
      expect(s.keysOf(s.u('archer')).filter((k) => k.startsWith('attack:')), `${from} -> ${to}`).toEqual([]);
    }
  });

  it('a wall along a side edge has no gap on its border columns either', () => {
    for (const [from, to] of [['A1', 'A3'], ['B1', 'B3'], ['C1', 'C3']] as const) {
      const s = scene(['...', '###', '...'], [SHOOTER(from), MARK(to, 14)]);
      s.begin(s.u('archer'));
      expect(s.keysOf(s.u('archer')).filter((k) => k.startsWith('attack:')), `${from} -> ${to}`).toEqual([]);
    }
  });

  it('a line past the free end of an interior wall still passes (the rule the edge fix leaves alone)', () => {
    const s = scene(['.....#..', '.....#..', '.....#..', '.....#..', '.....#..', '........'], [SHOOTER('E5'), MARK('G5', 14)]);
    expect(s.acVs(s.u('archer'), s.u('mark'))).toBe(16);
  });

  it('corners vs centers: one wall square between two squares in a row is Half under corners (lines along its edges pass) and Total under centers', () => {
    const corners = scene(['.......', '.#.....', '.......'], [SHOOTER('A2'), MARK('C2', 14)]);
    corners.begin(corners.u('archer'));
    expect(corners.keysOf(corners.u('archer'))).toContain('attack:longbow>mark');
    expect(corners.acVs(corners.u('archer'), corners.u('mark'))).toBe(16);
    const centers = scene(['.......', '.#.....', '.......'], [SHOOTER('A2'), MARK('C2', 14)], { losMethod: 'centers' });
    centers.begin(centers.u('archer'));
    expect(centers.keysOf(centers.u('archer')).filter((k) => k.startsWith('attack:'))).toEqual([]);
  });

  it('a line along the seam between two wall squares is blocked: a wall three squares long is solid (Total), where a single wall square in a row is Half', () => {
    const wall = scene(['.#...', '.#...', '.#...'], [SHOOTER('A2'), MARK('C2', 14)]);
    wall.begin(wall.u('archer'));
    expect(wall.keysOf(wall.u('archer')).filter((k) => k.startsWith('attack:'))).toEqual([]);
    const post = scene(['.....', '.#...', '.....'], [SHOOTER('A2'), MARK('C2', 14)]);
    expect(post.acVs(post.u('archer'), post.u('mark'))).toBe(16);
  });

  it('creatures never give more than Half: three in a row still leave the target targetable at +2', () => {
    const terrain = ['.......'];
    const units: Units = [SHOOTER('A1'), BYSTANDER('B1'), { ...BYSTANDER('C1'), seat: 'ally2' }, { ...BYSTANDER('D1'), seat: 'ally3' }, MARK('F1', 14)];
    const sc = scene(terrain, units);
    expect(sc.acVs(sc.u('archer'), sc.u('mark'))).toBe(16);
  });
});

describe('line of sight and line of effect', () => {
  it('an opportunity attack needs a creature "that you can see" (srd-raw.txt:2096-2097): none through a wall (centers)', () => {
    // A 10-ft reach across the wall at B1; the mover leaves reach from C1 to D1.
    const units: Units = [{ seat: 'reacher', team: 0, tpl: REACHER, at: 'A1' }, { seat: 'gob', team: 1, tpl: { ...DUMMY, speedFt: 30 }, at: 'C1' }];
    const provokes = (flags: Partial<RuleFlags>) => {
      const sc = scene(['.#....'], units, flags);
      sc.begin(sc.u('gob'));
      const key = sc.keysOf(sc.u('gob')).find((k) => k.startsWith('move:E1/'))!;
      sc.choose(sc.u('gob'), key);
      return ofKind(sc.sink.events, 'provoke').length;
    };
    expect(provokes({ losMethod: 'centers' })).toBe(0);
    expect(provokes({ losMethod: 'stubbed' })).toBe(1);
  });

  it('a square every line to which from the point of origin crosses a wall is not in the area (glossary "Area of Effect", 32672-32677)', () => {
    const terrain = ['.......', '...#...', '.......', '.......'];
    const sc = scene(terrain, [MARK('A4')]);
    const cells: number[] = [];
    const anchor = parseCell('D1', 7, 4); // square-centered origin
    areaCells(sc.cx.st, shapeKey('sphere', 20), anchor, cells);
    const names = cells.map((c) => cellName(c, 7));
    expect(names).not.toContain('D3'); // straight behind the wall
    expect(names).not.toContain('C3'); // diagonally behind it: every line crosses it too
    expect(names).toContain('B3'); // a line past the wall's corner reaches it
    const stub = scene(terrain, [MARK('A4')], { losMethod: 'stubbed' });
    const all: number[] = [];
    areaCells(stub.cx.st, shapeKey('sphere', 20), anchor, all);
    expect(all.map((c) => cellName(c, 7))).toContain('D3');
  });
});

describe('losMethod=stubbed is the engine before cover, bit for bit', () => {
  it('no cover, no Total Cover, everyone sees everyone: the same fights and state hashes as the same walls with no cover objects', () => {
    const units: Units = [
      { ...SHOOTER('A1'), decider: 'greedy' },
      { ...MARK('E3', 14), decider: 'greedy', tpl: template({ id: 'mark', kind: 'pc', ac: 14, hp: 30, dex: 12, attacks: [{ local: 'sling', kind: 'ranged', toHit: 4, range: [30, 120], damage: [['1d4+1', 'bludgeoning']] }] }) },
      { ...BYSTANDER('C2'), decider: 'greedy' },
    ];
    // '+' and '*' never block movement, so under stubbed they must change nothing at all.
    const objects = setup({ w: 7, h: 4, terrain: ['.#.+...', '.#*....', '.......', '.......'], units, flags: { losMethod: 'stubbed' } });
    const plain = setup({ w: 7, h: 4, terrain: ['.#.....', '.#.....', '.......', '.......'], units, flags: { losMethod: 'stubbed' } });
    let differs = 0;
    for (let run = 0; run < 20; run++) {
      expect(runFight(objects, 3, run, makeDeciders(objects), null).stateHash, `run ${run}`).toBe(runFight(plain, 3, run, makeDeciders(plain), null).stateHash);
      // ...while under corners the same objects do change fights.
      const c1 = setup({ w: 7, h: 4, terrain: ['.#.+...', '.#*....', '.......', '.......'], units });
      const c2 = setup({ w: 7, h: 4, terrain: ['.#.....', '.#.....', '.......', '.......'], units });
      if (runFight(c1, 3, run, makeDeciders(c1), null).stateHash !== runFight(c2, 3, run, makeDeciders(c2), null).stateHash) differs++;
    }
    expect(differs).toBeGreaterThan(0);
  });

  it('under stubbed the LOS flags stay out of the scenario hash and are never read, and the header keeps "LOS: stubbed"', () => {
    const f: RuleFlags = { ...DEFAULT_FLAGS, losMethod: 'stubbed' };
    expect(Object.keys(hashedFlags(f))).not.toContain('losMethod');
    expect(Object.keys(hashedFlags(f))).not.toContain('creatureCover');
    expect(Object.keys(hashedFlags(DEFAULT_FLAGS))).toContain('losMethod');
    const sc = scene(['..+....'], [{ ...SHOOTER('A1') }, BYSTANDER('B1'), MARK('E1', 14)], { losMethod: 'stubbed' });
    sc.begin(sc.u('archer'));
    sc.choose(sc.u('archer'), 'attack:longbow>mark');
    expect(ofKind(sc.sink.events, 'attack')[0]!.ac).toBe(14);
    expect(sc.cx.st.flagsUsed.slice(38).every((x) => x === 0)).toBe(true);
    expect(header(sc.s, 5, 0, [], ['a', 'b', 'c'], sc.cx.st.flagsUsed)).toContain('notes    LOS: stubbed (everyone sees everyone)');
  });

  it('otherwise the header names the method: "LOS: grid (losMethod=corners, creatureCover=on)", and a fight that met cover reads both flags', () => {
    const sc = scene(['.......'], [SHOOTER('A1'), BYSTANDER('C1'), MARK('E1', 14)]);
    sc.begin(sc.u('archer'));
    sc.choose(sc.u('archer'), 'attack:longbow>mark');
    const h = header(sc.s, 5, 0, [], ['a', 'b', 'c'], sc.cx.st.flagsUsed);
    expect(h).toContain('notes    LOS: grid (losMethod=corners, creatureCover=on)');
    expect(h.some((l) => l.startsWith('  losMethod=corners'))).toBe(true);
    expect(h.some((l) => l.startsWith('  creatureCover=on'))).toBe(true);
  });
});

describe('the greedy AI reads cover', () => {
  it('threat: a ranged foe behind Total Cover from my square adds nothing; Half Cover lowers what it adds', () => {
    const terrain = ['.#.....', '.#.....', '.#.....', '.......'];
    const sc = scene(terrain, [SHOOTER('A2'), MARK('G4', 14)]);
    const me = sc.u('mark');
    const open = threatSplitAt(sc.cx.st, me, parseCell('A4', 7, 4)).ranged; // straight down from it: clear
    const behind = threatSplitAt(sc.cx.st, me, parseCell('C2', 7, 4)).ranged; // the wall B1-B3 is between
    expect(open).toBeGreaterThan(0);
    expect(behind).toBe(0);
    const half = scene(['.......', '.+.....', '.......', '.......'], [SHOOTER('A2'), MARK('G4', 14)]);
    const h = threatSplitAt(half.cx.st, half.u('mark'), parseCell('C2', 7, 4)).ranged;
    expect(h).toBeGreaterThan(0);
    expect(h).toBeLessThan(open);
  });

  it('cover is the strike cache\'s fourth fact: of two equal targets at equal range, greedy shoots the one with no creature in the line', () => {
    const still = (u: { seat: string; team: 0 | 1; tpl: ReturnType<typeof template>; at: string }) => ({ ...u, tpl: { ...u.tpl, speedFt: 0 }, decider: 'greedy' as const });
    const units: Units = [
      still({ seat: 'archer', team: 1, tpl: ARCHER, at: 'A2' }),
      still(MARK('E1', 14)),
      still({ ...MARK('E3', 14), seat: 'mark2' }),
      still({ seat: 'block', team: 1, tpl: DUMMY, at: 'C1' }), // the archer's ally, in the line A2 -> E1 only
    ];
    const s = setup({ w: 7, h: 3, units });
    const sink = new ArraySink();
    runFight(s, 5, 0, makeDeciders(s), sink);
    const archer = s.seats.findIndex((x) => x.seat === 'archer');
    const first = ofKind(sink.events, 'attack').find((e) => e.att === archer)!;
    expect(s.seats[first.tgt]!.seat).toBe('mark2');
    expect(first.cover).toBeUndefined();
    // And with creature cover off the two are equal: it takes the first in seat order.
    const off = setup({ w: 7, h: 3, units, flags: { creatureCover: 'off' } });
    const sink2 = new ArraySink();
    runFight(off, 5, 0, makeDeciders(off), sink2);
    expect(s.seats[ofKind(sink2.events, 'attack').find((e) => e.att === archer)!.tgt]!.seat).toBe('mark');
  });
});

describe('coverDegree against a direct reading of the corner rule (the packed-bit and offset-cache paths)', () => {
  /** The rule read directly: every line tested with crossesCell, levels by obstacle, the attacker's best corner. */
  function reference(terrain: string[], w: number, method: 'corners' | 'centers', a: number, t: number, creatures: number[]): number {
    const lvl = (c: number): number => {
      const ch = terrain[Math.floor(c / w)]![c % w]!;
      return ch === '#' ? 3 : ch === '*' ? 2 : ch === '+' ? 1 : creatures.includes(c) ? 1 : 0;
    };
    const cells = terrain.length * w;
    const h = terrain.length;
    const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 3 : y * w + x === a || y * w + x === t ? 0 : lvl(y * w + x));
    const lineLevel = (x0: number, y0: number, x1: number, y1: number, ownA = -1, ownB = -1) => {
      let l = 0;
      for (let c = 0; c < cells; c++) if (c !== a && c !== t && lvl(c) > l && crossesCell(x0, y0, x1, y1, c % w, Math.floor(c / w), 2)) l = lvl(c);
      // Along a grid line, the seam between two obstacles: the lower level (unit steps along it).
      if (x0 === x1 && x0 % 2 === 0) for (let y = Math.min(y0, y1); y < Math.max(y0, y1); y++) l = Math.max(l, Math.min(at(x0 / 2 - 1, Math.floor(y / 2)), at(x0 / 2, Math.floor(y / 2))));
      if (y0 === y1 && y0 % 2 === 0) for (let x = Math.min(x0, x1); x < Math.max(x0, x1); x++) l = Math.max(l, Math.min(at(Math.floor(x / 2), y0 / 2 - 1), at(Math.floor(x / 2), y0 / 2)));
      // Through a corner point two obstacles share diagonally (8'a review G1): every lattice point
      // on the segment, its ends included when the segment leaves (enters) its own square there.
      if (x0 !== x1 && y0 !== y1) {
        for (let X = 0; X <= w; X++) {
          for (let Y = 0; Y <= h; Y++) {
            const px = 2 * X;
            const py = 2 * Y;
            if ((px - x0) * (y1 - y0) !== (py - y0) * (x1 - x0)) continue; // not on the line
            const t = (px - x0) / (x1 - x0);
            if (t < 0 || t > 1) continue;
            const sx = Math.sign(x1 - x0);
            const sy = Math.sign(y1 - y0);
            const cellOf = (x: number, y: number) => y * w + x;
            if (t === 0 && cellOf(X + (sx > 0 ? -1 : 0), Y + (sy > 0 ? -1 : 0)) !== ownA) continue;
            if (t === 1 && cellOf(X + (sx > 0 ? 0 : -1), Y + (sy > 0 ? 0 : -1)) !== ownB) continue;
            const across = sx === sy ? [at(X, Y - 1), at(X - 1, Y)] : [at(X - 1, Y - 1), at(X, Y)];
            l = Math.max(l, Math.min(across[0]!, across[1]!));
          }
        }
      }
      return l;
    };
    const ax = 2 * (a % w);
    const ay = 2 * Math.floor(a / w);
    const tx = 2 * (t % w);
    const ty = 2 * Math.floor(t / w);
    if (method === 'centers') return lineLevel(ax + 1, ay + 1, tx + 1, ty + 1);
    const g = (n: number) => (n === 0 ? 0 : n <= 2 ? 1 : n === 3 ? 2 : 3);
    let best = 3;
    for (let i = 0; i < 4; i++) {
      const ls = [0, 1, 2, 3].map((j) => lineLevel(ax + (i & 1 ? 2 : 0), ay + (i & 2 ? 2 : 0), tx + (j & 1 ? 2 : 0), ty + (j & 2 ? 2 : 0), a, t));
      const d = Math.max(Math.min(1, g(ls.filter((l) => l >= 1).length)), Math.min(2, g(ls.filter((l) => l >= 2).length)), g(ls.filter((l) => l >= 3).length));
      best = Math.min(best, d);
    }
    return best;
  }

  it('equals the direct reading for every pair of squares on a mixed map, creatures included', () => {
    const terrain = ['.#..+.', '.#*...', '..*#..', '+..#..'];
    const w = 6;
    const los = buildLos(w, 4, parseTerrain(terrain, w, 4));
    const creatures = [parseCell('B2', w, 4), parseCell('E3', w, 4), parseCell('F1', w, 4)];
    for (let a = 0; a < 24; a++) {
      for (let t = 0; t < 24; t++) {
        if (a === t || terrain[Math.floor(a / w)]![a % w] === '#' || terrain[Math.floor(t / w)]![t % w] === '#') continue;
        const keep = creatures.filter((c) => c !== a && c !== t);
        for (const m of ['corners', 'centers'] as const) {
          expect(coverDegree(los, m, a, t, Int32Array.from(keep), keep.length), `${m} ${cellName(a, w)}->${cellName(t, w)}`).toBe(reference(terrain, w, m, a, t, keep));
        }
      }
    }
  });

  it('equals the direct reading on a map of diagonal staircases, creatures pinching corners too (8\'a review G1)', () => {
    const terrain = ['...#....', '..#..*..', '.#....+.', '......#.', '..+.....'];
    const w = 8;
    const h = 5;
    const los = buildLos(w, h, parseTerrain(terrain, w, h));
    const creatures = [parseCell('E3', w, h), parseCell('D4', w, h), parseCell('G2', w, h)];
    for (let a = 0; a < w * h; a++) {
      for (let t = 0; t < w * h; t++) {
        if (a === t || terrain[Math.floor(a / w)]![a % w] === '#' || terrain[Math.floor(t / w)]![t % w] === '#') continue;
        const keep = creatures.filter((c) => c !== a && c !== t);
        for (const m of ['corners', 'centers'] as const) {
          expect(coverDegree(los, m, a, t, Int32Array.from(keep), keep.length), `${m} ${cellName(a, w)}->${cellName(t, w)}`).toBe(reference(terrain, w, m, a, t, keep));
        }
      }
    }
  });
});

describe('a diagonal wall: two wall squares touching only at a corner close it (8\'a review G1) [U]', () => {
  // Walls on the anti-diagonal x + y = 6 of an 8 x 8 map: G1, F2, E3, D4, C5, B6, A7.
  const STAIR = Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => (x + y === 6 ? '#' : '.')).join(''));

  it('a staircase of \'#\' squares is a solid wall: Total Cover ("can\'t be targeted directly", srd-raw.txt:2028-2032) under both methods, as movement can\'t step past the corner either', () => {
    const los = buildLos(8, 8, parseTerrain(STAIR, 8, 8));
    const at = (n: string) => parseCell(n, 8, 8);
    const none = new Int32Array(0);
    for (const m of ['corners', 'centers'] as const) {
      for (const [a, t] of [['D3', 'F5'], ['B2', 'E5'], ['A1', 'G7']]) {
        expect(coverDegree(los, m, at(a!), at(t!), none, 0), `${m} ${a}->${t}`).toBe(COVER.total);
        expect(clearLine(los, m, at(a!), at(t!)), `${m} ${a}->${t}`).toBe(false);
      }
    }
    // The pinch from the attacker's own corner: D3's lower-right corner is the point E3 and D4 share.
    const sc = scene(STAIR, [SHOOTER('D3'), MARK('F5')]);
    sc.begin(sc.u('archer'));
    expect(sc.keysOf(sc.u('archer')).filter((k) => k.startsWith('attack:'))).toEqual([]);
  });

  it('creatures standing corner to corner pinch a line through their shared corner at Half, like a seam', () => {
    // B1 and A2 touch only at A1's lower-right corner: the archer's one clear corner shoots out through that point.
    const sc = scene(['.....', '.....', '.....', '.....'], [SHOOTER('A1'), BYSTANDER('B1'), { ...BYSTANDER('A2'), seat: 'ally2' }, MARK('C3', 14)]);
    expect(sc.acVs(sc.u('archer'), sc.u('mark'))).toBe(16);
    const one = scene(['.....', '.....', '.....', '.....'], [SHOOTER('A1'), BYSTANDER('B1'), MARK('C3', 14)]);
    expect(one.acVs(one.u('archer'), one.u('mark'))).toBe(14);
  });

  it('a Dexterity save against an area gets Half Cover (+2) through two creatures meeting at a corner on the line from the point of origin', () => {
    // centers: the blast is centered on A2; the line to B1's center passes through the corner
    // point that A1 and B2 share. One creature alone leaves the line clear.
    const run = (both: boolean) => {
      const units: Units = [
        { seat: 'pc', team: 0, tpl: blaster(shapeKey('sphere', 20)), at: 'F6' },
        { seat: 'gob', team: 1, tpl: { ...DUMMY, saveMod: [0, 3, 0, 0, 0, 0] }, at: 'B1' },
        BYSTANDER('A1'),
        ...(both ? [{ ...BYSTANDER('B2'), seat: 'ally2' }] : []),
      ];
      const sc = scene(Array.from({ length: 6 }, () => '......'), units, { losMethod: 'centers' }, ['place:A2']);
      sc.begin(sc.u('pc'));
      sc.choose(sc.u('pc'), 'cast:blast@1');
      const save = ofKind(sc.sink.events, 'save').find((e) => sc.cx.st.units[e.who]!.seat === 'gob')!;
      return { save, text: renderLog(sc.sink.events, sc.s).join('\n') };
    };
    const pinched = run(true);
    expect(pinched.save.cover).toBe(COVER.half);
    expect(pinched.text).toMatch(/\+3 \+2\(Half Cover\) = /);
    expect(run(false).save.cover).toBeUndefined();
  });

  it('an area doesn\'t pass the pinch: "a location is excluded ... if every straight line from the point of origin to it is blocked" (srd-raw.txt:32672-32677)', () => {
    const los = buildLos(8, 8, parseTerrain(STAIR, 8, 8));
    // From the center of C3, D5 is behind the walls D4 and C5, which touch only at a corner.
    expect(cutOff(los, 4 * 2 + 2, 4 * 2 + 2, parseCell('D5', 8, 8), parseCell('C3', 8, 8))).toBe(true);
    const sc = scene(STAIR, [MARK('H8')]);
    const cells: number[] = [];
    areaCells(sc.cx.st, shapeKey('sphere', 20), parseCell('C3', 8, 8), cells);
    const names = cells.map((c) => cellName(c, 8));
    expect(names).toContain('B4'); // the near side
    expect(names).not.toContain('D5'); // the far side, reached only through a pinch
    expect(names).not.toContain('E4');
  });
});

describe('a creature still in an area is not wholly covered from it (8\'a review R1) [U]', () => {
  // Total Cover: "can't be targeted directly" (srd-raw.txt:2028-2032); an area excludes a location
  // only when every line to it is blocked (32672-32677). The corner-line degree and the area's
  // sampled cut-off can disagree on a square; a creature the area reaches saves at +5, never +0.
  const cases = [
    { name: 'centers: wall B1, origin A2, target C1', terrain: ['.#....', '......', '......', '......'], origin: 'A2', target: 'C1', at: 'F4', losMethod: 'centers' as const },
    { name: 'corners: walls D1 and B2, origin F2, target A1', terrain: ['...#..', '.#....', '......', '......', '......', '......', '......', '......'], origin: 'F2', target: 'A1', at: 'A8', losMethod: 'corners' as const },
  ];
  for (const c of cases) {
    it(`${c.name}: the target is in the area and its Dexterity save gets Three-Quarters (+5), not Total's +0`, () => {
      const w = c.terrain[0]!.length;
      const h = c.terrain.length;
      const los = buildLos(w, h, parseTerrain(c.terrain, w, h));
      const o = parseCell(c.origin, w, h);
      const t = parseCell(c.target, w, h);
      expect(cutOff(los, 4 * (o % w) + 2, 4 * Math.floor(o / w) + 2, t, o)).toBe(false); // still in the area
      const units: Units = [{ seat: 'pc', team: 0, tpl: blaster(shapeKey('sphere', 30)), at: c.at }, { seat: 'gob', team: 1, tpl: { ...DUMMY, saveMod: [0, 3, 0, 0, 0, 0] }, at: c.target }];
      const sc = scene(c.terrain, units, { losMethod: c.losMethod }, [`place:${c.origin}`]);
      sc.begin(sc.u('pc'));
      sc.choose(sc.u('pc'), 'cast:blast@1');
      const save = ofKind(sc.sink.events, 'save').find((e) => sc.cx.st.units[e.who]!.seat === 'gob')!;
      expect(save.cover).toBe(COVER.threeQuarters);
      expect(renderLog(sc.sink.events, sc.s).join('\n')).toMatch(/\+3 \+5\(Three-Quarters Cover\) = /);
    });

    it(`${c.name}: the greedy AI values that save at Three-Quarters (+5) too, not Total's +0`, () => {
      // The blast at the origin, valued by greedy's zoneValue: behind the raw Total at +3, it must
      // equal the same blast on an open map at +3 +5 = +8, and be worth less than at a bare +3.
      // The maps are widened so the caster stands well outside the area.
      const value = (walls: boolean, dex: number): number => {
        const terrain = c.terrain.map((r) => (walls ? r : r.replace(/#/g, '.')) + '.'.repeat(12));
        const w = terrain[0]!.length;
        const h = terrain.length;
        const units: Units = [
          { seat: 'pc', team: 0, tpl: blaster(shapeKey('sphere', 30)), at: cellName(w * h - 1, w), decider: 'greedy' },
          { seat: 'gob', team: 1, tpl: { ...DUMMY, saveMod: [0, dex, 0, 0, 0, 0] }, at: c.target },
        ];
        const s = setup({ w, h, terrain, units, flags: { losMethod: c.losMethod } });
        const ds = makeDeciders(s);
        const g = ds[s.seats.findIndex((x) => x.seat === 'pc')] as GreedyDecider;
        const x = g as unknown as { vctxFor(st: UnitView['q'], me: Unit, view: UnitView): VCtx };
        let got: number | null = null;
        const decide = g.decide.bind(g);
        g.decide = (view: UnitView, dp: DecisionPoint) => {
          const me = view.q.units[view.me]!;
          if (got === null && me.seat === 'pc') {
            got = zoneValue(x.vctxFor(view.q, me, view), me.tpl.effects[1]!, parseCell(c.origin, w, h), 10);
            throw new Error('probed');
          }
          return decide(view, dp);
        };
        expect(() => runFight(s, 5, 0, ds, null)).toThrow('probed');
        return got!;
      };
      const behind = value(true, 3);
      expect(behind).toBeCloseTo(value(false, 8), 9);
      expect(behind).toBeLessThan(value(false, 3));
    });
  }
});

describe('Sacred Flame: "The target gains no benefit from Half Cover or Three-Quarters Cover for this save" (srd-raw.txt:30314-30315; 8\'a review R2)', () => {
  const flame = (ignores: boolean) => {
    const st = S.save(1, saveKey(1), 13, '1d8', 'radiant', false);
    const step: Step = ignores ? { ...st, ignoresCover: 'partial' } as Step : st;
    return entry(spell('flame', { level: 0, rangeFt: 60, s: false, sid: 9 }), { 0: [S.target(60), step] });
  };
  for (const terrain of [['..+....'], ['..*....']]) {
    it(`a save with ignoresCover: partial gets nothing from a '${terrain[0]![2]}' between; the same save without it does`, () => {
      const run = (ignores: boolean) => {
        const sc = scene(terrain, [{ seat: 'pc', team: 0, tpl: caster({ spells: [flame(ignores)] }), at: 'A1' }, { seat: 'gob', team: 1, tpl: DUMMY, at: 'E1' }], { losMethod: 'centers' }, ['target:gob']);
        sc.begin(sc.u('pc'));
        sc.choose(sc.u('pc'), 'cast:flame@0');
        return ofKind(sc.sink.events, 'save')[0]!;
      };
      expect(run(false).cover).toBeGreaterThan(0);
      const sf = run(true);
      expect(sf.cover).toBeUndefined();
      expect(sf.total).toBe(run(false).total - COVER_BONUS_OF(run(false).cover!));
    });
  }

  it('the SRD pack\'s spell files: only Sacred Flame\'s save step names ignoresCover, as partial', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { parse } = await import('yaml');
    const dir = join(import.meta.dirname, '..', '..', '..', 'packs', 'srd-5.2.1', 'spells');
    const withIt: string[] = [];
    for (const f of readdirSync(dir).sort()) {
      const doc = parse(readFileSync(join(dir, f), 'utf8')) as { id: string; do?: Record<string, { ignoresCover?: string }>[] };
      for (const s of doc.do ?? []) if (s.save?.ignoresCover !== undefined) withIt.push(`${doc.id}:${s.save.ignoresCover}`);
    }
    expect(withIt).toEqual(['srd:sacred-flame:partial']);
  });

  it('the SRD pack\'s Sacred Flame, compiled for a caster who knows it, carries ignoresCover: partial on its save step', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const { join, relative } = await import('node:path');
    const root = join(import.meta.dirname, '..', '..', '..');
    const walk = (d: string): string[] => readdirSync(d).sort().flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.yaml') ? [p] : [];
    });
    const files = walk(join(root, 'packs', 'srd-5.2.1')).map((p) => ({ path: relative(root, p), text: readFileSync(p, 'utf8') }));
    files.push(
      { path: 'fx/manifest.yaml', text: "kind: manifest\npack: fx\nversion: '1'\nrules: '2024'\nnamespace: test\nlicense: test\n" },
      {
        path: 'fx/pc.yaml',
        text: "kind: pc\nid: test:flame-caster\nname: Fixture Caster\nsource: synthetic test fixture\nrules: '2024'\nlevel: 1\nsize: medium\nspeed: 30\n" +
          'abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 16, cha: 10 }\nhpMax: 10\nac: 12\ncasting:\n  - source: x\n    ability: wis\n    list: cleric\n    cantrips: [\'srd:sacred-flame\']\n',
      },
    );
    const r = loadContent(files);
    if (!r.content) throw new Error(r.errors.map(formatDiag).join('\n'));
    const e = r.content.get('test:flame-caster')!.spells.find((x) => x.spell.id === 'srd:sacred-flame')!;
    const saves = e.prog[0]!.filter((s) => s.k === 'save');
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ k: 'save', ability: 1, ignoresCover: 'partial' });
  });
});

describe('Total Cover at resolution: every listing site leaves a hidden target out (8\'a review T1, T2)', () => {
  const WALL = ['.#.....', '.#.....', '.......', '.......'];

  it('"A Clear Path to the Target" (srd-raw.txt:23778-23780): with one enemy behind a wall and one clear, the spell\'s target step offers only the clear one', () => {
    const zap = entry(spell('zap', { level: 0, rangeFt: 60, s: false, sid: 7 }), { 0: [S.target(60), S.save(1, saveKey(1), 13, '1d6', 'fire', false)] });
    const units: Units = [{ seat: 'pc', team: 0, tpl: caster({ spells: [zap] }), at: 'A1' }, { seat: 'hidden', team: 1, tpl: DUMMY, at: 'D3' }, { seat: 'clear', team: 1, tpl: DUMMY, at: 'A4' }];
    // The decider asks for the hidden one first; it must not be offered at all.
    const run = (terrain: string[]) => {
      const sc = scene(terrain, units, {}, ['target:hidden']);
      sc.begin(sc.u('pc'));
      sc.choose(sc.u('pc'), 'cast:zap@0');
      return { lists: sc.k.targetLists.flat(), saved: ofKind(sc.sink.events, 'save').map((e) => sc.cx.st.units[e.who]!.seat) };
    };
    const walled = run(WALL);
    expect(walled.lists).not.toContain('target:hidden');
    expect(walled.saved).toEqual(['clear']);
    const open = run(['.......', '.......', '.......', '.......']);
    expect(open.lists.slice().sort()).toEqual(['target:clear', 'target:hidden']);
    expect(open.saved).toEqual(['hidden']);
  });

  it('Total Cover: "can\'t be targeted directly" (srd-raw.txt:2028-2032): a weaponAttack step from a feature makes no attack at an enemy behind a wall', () => {
    const volley = feature('volley', { local: 'volley', name: 'Volley', cost: 'bonus', pool: -1, root: -1, steps: [{ k: 'weaponAttack', from: [0], count: 1, noAbility: null }] });
    const tpl = { ...ARCHER, features: [volley] };
    const run = (terrain: string[]) => {
      const sc = scene(terrain, [{ seat: 'archer', team: 1, tpl, at: 'A1' }, MARK('D3')]);
      sc.begin(sc.u('archer'));
      sc.choose(sc.u('archer'), 'use:volley');
      return { attacks: ofKind(sc.sink.events, 'attack'), lists: sc.k.targetLists };
    };
    const open = run(['.......', '.......', '.......', '.......']);
    expect(open.attacks).toHaveLength(1);
    const walled = run(WALL);
    expect(walled.attacks).toEqual([]);
    expect(walled.lists).toEqual([]);
  });
});

describe('a Dexterity save against an area takes its cover from the point of origin (srd-raw.txt:32672-32677, 1999-2000; 8\'a review T3)', () => {
  // The blast lands centered on D1; the target is on G1; the caster stands on G6, straight below it.
  const run = (terrain: string[]) => {
    const units: Units = [{ seat: 'pc', team: 0, tpl: blaster(shapeKey('sphere', 20)), at: 'G6' }, { seat: 'gob', team: 1, tpl: { ...DUMMY, saveMod: [0, 3, 0, 0, 0, 0] }, at: 'G1' }];
    const sc = scene(terrain, units, {}, ['place:D1']);
    sc.begin(sc.u('pc'));
    sc.choose(sc.u('pc'), 'cast:blast@1');
    const save = ofKind(sc.sink.events, 'save').find((e) => sc.cx.st.units[e.who]!.seat === 'gob')!;
    if (!save) throw new Error(renderLog(sc.sink.events, sc.s).join('\n'));
    return { save, text: renderLog(sc.sink.events, sc.s).join('\n') };
  };
  const blank = Array.from({ length: 6 }, () => '.......');

  it('a \'+\' between the origin and the target gives Half (+2) though the caster\'s line is clear', () => {
    const r = run(['.....+.', ...blank.slice(1)]);
    expect(r.save.cover).toBe(COVER.half);
    expect(r.text).toMatch(/\+3 \+2\(Half Cover\) = /);
  });

  it('a \'+\' between the caster and the target, off the origin\'s lines, gives nothing', () => {
    const r = run(['.......', '.......', '......+', '.......', '.......', '.......']);
    expect(r.save.cover).toBeUndefined();
  });
});

describe('the strike cache keys on cover (8\'a review T4)', () => {
  it('cover is the strike cache\'s fourth fact: from two squares that differ only in the target\'s cover, the cached strike equals the exact one on each', () => {
    // From A3 the ally on C3 covers E3 (Half); from D1 nothing is in the line. Both squares are in
    // normal range, have no hostile adjacent and are over 5 ft from E3: only the cover differs.
    const units: Units = [
      { seat: 'archer', team: 1, tpl: ARCHER, at: 'A3', decider: 'greedy' },
      { seat: 'block', team: 1, tpl: DUMMY, at: 'C3', decider: 'greedy' },
      { ...MARK('E3', 14), decider: 'greedy' },
    ];
    // Nobody but the archer moves, so the squares are as drawn when its first turn is decided.
    const s = setup({ w: 7, h: 5, units: units.map((u) => (u.seat === 'archer' ? u : { ...u, tpl: { ...u.tpl, speedFt: 0 } })) });
    const ds = makeDeciders(s);
    const archer = s.seats.findIndex((x) => x.seat === 'archer');
    const g = ds[archer] as GreedyDecider; // greedy deciders may be shared across seats: the probe checks whose turn it is
    type Probe = { strike(v: UnitView, me: Unit, ai: number, t: Unit, from: number): number; strikeExact(v: UnitView, me: Unit, ai: number, t: Unit, from: number): number; pairOf: Int32Array };
    const x = g as unknown as Probe;
    const seen: { paired: boolean; cached: number[]; exact: number[] }[] = [];
    const decide = g.decide.bind(g);
    g.decide = (view: UnitView, dp: DecisionPoint) => {
      const r = decide(view, dp);
      const me = view.q.units[view.me]!;
      if (dp.k === 'turn' && seen.length === 0 && me.seat === 'archer') {
        const t = view.q.units.find((u) => u.seat === 'mark')!;
        const sq = [parseCell('A3', 7, 5), parseCell('D1', 7, 5)];
        seen.push({ paired: x.pairOf[t.idx]! >= 0, cached: sq.map((c) => x.strike(view, me, 0, t, c)), exact: sq.map((c) => x.strikeExact(view, me, 0, t, c)) });
      }
      return r;
    };
    runFight(s, 5, 0, ds, null);
    const p = seen[0]!;
    expect(p.paired).toBe(true); // the cached path, not the per-call fallback
    expect(p.exact[0]).toBeLessThan(p.exact[1]!); // Half Cover from A3 lowers the strike's value
    expect(p.cached).toEqual(p.exact);
  });

  it('creatureCover=off at resolution: the attack rolled past a creature is vs the plain AC with no cover on the event', () => {
    for (const creatureCover of ['on', 'off'] as const) {
      const sc = scene(['.......'], [SHOOTER('A1'), BYSTANDER('C1'), MARK('E1', 14)], { creatureCover });
      sc.begin(sc.u('archer'));
      sc.choose(sc.u('archer'), 'attack:longbow>mark');
      const atk = ofKind(sc.sink.events, 'attack')[0]!;
      expect(atk.ac, creatureCover).toBe(creatureCover === 'on' ? 16 : 14);
      expect(atk.cover, creatureCover).toBe(creatureCover === 'on' ? COVER.half : undefined);
    }
  });
});

function COVER_BONUS_OF(d: number): number {
  return [0, 2, 5, 0][d]!;
}
