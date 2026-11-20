// Coverage 8'b G1, m10 and M9 fallback (2) (docs/design/coverage.md section 2 and its critique
// resolutions): a PC with nothing in reach closes in for next turn, exposure-aware, and takes the
// core Dash when no move alone brings anything in reach by next turn; the approach also counts a
// rescue (a heal on a downed ally, v4's RESCUE) reachable next turn; monsters keep their
// closing-in term and their Dash first. Each case is a constructed state named for what it checks.
// Content is synthetic (test: ids), compiled with the repo packs.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../src/content/load.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import type { DecisionPoint, Legal } from '../src/decide/decider.ts';
import { APPROACH_TOP_K, CLOSE_TIE, GreedyDecider, type ExplainRecord } from '../src/decide/greedy/greedy.ts';
import { healReach } from '../src/decide/greedy/value.ts';
import type { Step } from '../src/content/types.ts';
import { terrainFieldFt } from '../src/grid/reach.ts';
import { targetable } from '../src/sim/cover.ts';
import { resolveOption } from '../src/sim/act.ts';
import type { Decider } from '../src/decide/decider.ts';
import { resolveScenario } from '../src/scenario/resolve.ts';
import { copyLegal, legalKey, newLegal, releaseList, takeList } from '../src/sim/context.ts';
import { createContext, runFight } from '../src/sim/fight.ts';
import { HashSink } from '../src/log/events.ts';
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

interface PcOpt {
  /** INT 18, Fire Bolt (120 ft). */
  caster?: boolean;
  /** Cure Wounds prepared, with slots. */
  cure?: boolean;
  /** SRD Healing Word prepared (a Bonus Action, 60 ft), with slots. */
  word?: boolean;
  /** Scenario flags over the default. */
  flags?: Record<string, string>;
  /** A lone heavy Dagger (3d4) held (a throw leaves the hand) instead of the Longsword. */
  dagger?: boolean;
  /** Map rows ('#' a wall, ':' Difficult); default open, 26 x 6. */
  terrain?: string[];
  hp?: number;
}
/** A Fighter-shaped PC: STR 16, Speed 30, a Longsword (1d8 + STR), and `features`. */
const PC = (features: string[], { caster = false, cure = false, word = false, dagger = false, hp = 44 }: PcOpt = {}) => `kind: pc
id: test:appr-pc
name: Approach PC
source: synthetic test fixture
rules: '2024'
level: 5
size: medium
speed: 30
abilities: { str: ${caster ? 8 : 16}, dex: 12, con: 14, int: ${caster ? 18 : 10}, wis: 14, cha: 8 }
hpMax: ${hp}
ac: 16
armor: none
saveProficiencies: [str, con]
${dagger ? 'heldWeapons: true\nhands: [dagger, null]\n' : ''}weapons:
  - ${dagger ? '{ id: dagger, name: Dagger, kind: melee, ability: str, light: true, thrownRange: [20, 60], damage: [{ roll: 3d4 + @mod, type: piercing }] }' : '{ id: longsword, name: Longsword, kind: melee, ability: str, category: martial, damage: [{ roll: 1d8 + @mod, type: slashing }] }'}
features: [${features.map((f) => `test:${f}`).join(', ')}]
${caster ? 'casting:\n  - { source: wizard, ability: int, list: wizard, cantrips: [srd:fire-bolt] }\n' : ''}${cure ? "slots: [4, 3]\ncasting:\n  - { source: cleric, ability: wis, list: cleric, prepared: ['srd:cure-wounds'] }\n" : ''}${word ? "slots: [4, 3]\ncasting:\n  - { source: cleric, ability: wis, list: cleric, prepared: ['srd:healing-word'] }\n" : ''}`;

const monster = (id: string, hp: number, toHit: number, dmg: string, avg: number) => `kind: monster
id: test:${id}
name: ${id}
source: synthetic test fixture
size: medium
cr: 1
pb: 2
ac: 12
hp: { average: ${hp}, formula: '${hp}' }
speed: { walk: 30 }
initiative: { mod: 0, score: 10 }
abilities: { str: 14, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }
attacks:
  - { id: claw, name: Claw, kind: melee, toHit: ${toHit}, damage: [{ roll: '${dmg}', type: slashing, avg: ${avg} }] }
`;

const KIT: Record<string, string> = {
  'packs/test/monsters/appr-brute.yaml': monster('appr-brute', 30, 6, '2d8 + 4', 13),
  'packs/test/monsters/appr-dummy.yaml': monster('appr-dummy', 500, 0, '1', 1),
  'packs/test/monsters/appr-wall.yaml': monster('appr-dummy', 500, 0, '1', 1).replace('test:appr-dummy', 'test:appr-wall').replace('ac: 12', 'ac: 22'),
  // Walks 100 ft: its reach (105 ft) lies inside what a closing PC would walk through.
  'packs/test/monsters/appr-fast.yaml': monster('appr-fast', 30, 6, '2d8 + 4', 13).replace('walk: 30', 'walk: 100'),
  // Walks 60 ft: exposure 65 ft out.
  'packs/test/monsters/appr-runner.yaml': monster('appr-runner', 30, 6, '2d8 + 4', 13).replace('walk: 30', 'walk: 60'),
  // Rooted to its square, harmless: nothing but the PC's own closing can end the fight.
  'packs/test/monsters/appr-still.yaml': monster('appr-still', 12, 0, '1', 1).replace('walk: 30', 'walk: 0'),
  // Rooted, and shoots: a Longbow's reach covers the whole map.
  'packs/test/monsters/appr-still-archer.yaml': monster('appr-still-archer', 30, 5, '1d8 + 3', 8)
    .replace('walk: 30', 'walk: 0')
    .replace("{ id: claw, name: Claw, kind: melee, toHit: 5, damage: [{ roll: '1d8 + 3', type: slashing, avg: 8 }] }", "{ id: bow, name: Longbow, kind: ranged, toHit: 5, range: [150, 600], damage: [{ roll: '1d8 + 3', type: piercing, avg: 8 }] }"),
  // Rooted and dangerous: only the squares next to it are exposed.
  'packs/test/monsters/appr-rooted-brute.yaml': monster('appr-rooted-brute', 30, 6, '2d8 + 4', 13).replace('walk: 30', 'walk: 0'),
  'packs/test/features/appr-far-heal.yaml': `kind: feature
id: test:appr-far-heal
name: appr-far-heal
source: synthetic test fixture
activate: { id: farmend, name: Far Mend, cost: action, do: [{ target: { range: 60, who: ally, self: 'no' } }, { heal: { roll: 2d8 + 3 } }] }
`,
  'packs/test/features/appr-bonus-heal.yaml': `kind: feature
id: test:appr-bonus-heal
name: appr-bonus-heal
source: synthetic test fixture
activate: { id: quickmend, name: Quick Mend, cost: bonus, do: [{ target: { range: touch, who: ally, self: 'no' } }, { heal: { roll: 2d8 + 3 } }] }
`,
  'packs/test/features/appr-touch-heal.yaml': `kind: feature
id: test:appr-touch-heal
name: appr-touch-heal
source: synthetic test fixture
activate: { id: mend, name: Mend, cost: action, do: [{ target: { range: touch, who: ally, self: 'no' } }, { heal: { roll: 2d8 + 3 } }] }
`,
};

type U = { seat: string; team: 'party' | 'enemies'; use: string; at: string };
const pc = (at: string, seat = 'pc1'): U => ({ seat, team: 'party', use: 'test:appr-pc', at });
const foe = (seat: string, use: string, at: string): U => ({ seat, team: 'enemies', use: `test:${use}`, at });

/** A fight on a 26 x 6 grid (5 ft squares: A2 to I2 is 40 ft); every seat greedy, with an explain sink. */
function scene(features: string[], units: U[], opt: PcOpt = {}) {
  const files = [...REPO, ...Object.entries({ ...KIT, 'packs/test/pcs/appr-pc.yaml': PC(features, opt) }).map(([path, text]) => ({ path, text }))];
  const r = loadContent(files);
  if (!r.content) throw new Error(r.errors.map(formatDiag).join('\n'));
  const doc = {
    kind: 'scenario', id: 'gappr', name: 'Greedy approach', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: { w: 26, h: 6, ...(opt.terrain ? { terrain: opt.terrain } : {}) },
    flags: { initiativeMode: 'static', ...opt.flags }, knobs: { downEnds: false },
    units: units.map((u) => ({ ...u, decider: 'greedy' })),
  };
  const res = resolveScenario(doc, 'gappr.yaml', r.content);
  if (!res.setup) throw new Error(res.errors.map(formatDiag).join('\n'));
  const s = res.setup;
  const ds = s.seats.map(() => new GreedyDecider());
  const cx = createContext(s, 1, 0, ds, null);
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
  const decide = (who: Unit): { key: string; rec: ExplainRecord } => {
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
    return { key: keys[i]!, rec: records.at(-1)! };
  };
  const col = (who: Unit) => who.cell % s.w;
  /** One whole turn played through the engine: the keys taken, pass last. */
  const turn = (who: Unit): string[] => {
    begin(who);
    const out: string[] = [];
    for (let k = 0; k < 12; k++) {
      const list = listOptions(cx, who, takeList(cx));
      const items: Legal[] = [];
      const keys: string[] = [];
      for (let i = 0; i < list.n; i++) {
        keys.push(legalKey(cx.st, who.idx, list.items[i]!));
        items.push(copyLegal(list.items[i]!, newLegal()));
      }
      releaseList(cx, list);
      const dp: DecisionPoint = { k: 'turn', who: who.idx, at: 0, round: 1, cause: -1, legal: { n: items.length, items }, keyOf: (i) => keys[i]! };
      const i = ds[who.idx]!.decide(cx.views[who.idx]!, dp);
      out.push(keys[i]!);
      if (items[i]!.k === 'pass') break;
      resolveOption(cx, who, items[i]!, -1);
    }
    return out;
  };
  return { cx, s, u, ds, begin, decide, col, turn };
}
const parts = (rec: ExplainRecord, key: string) => rec.top.find((t) => t.key === key)?.parts ?? [];
const part = (rec: ExplainRecord, key: string, term: string) => parts(rec, key).find((p) => p.term === term)?.ev;
const NEXT = 'next turn: the best strike or rescue from there, x gamma, over staying';
const RISE = 'rise in exposure there';
const RESCUE_TERM = '  of which a rescue: a heal on a downed ally (RESCUE)';
const CLOSING = 'closing in: nothing in reach by next turn from any square, so the nearest foe';
const RESCUE_NOW = 'rescue this turn: walk in range, then the heal on a downed ally (RESCUE)';
const isMove = (k: string) => k.startsWith('move');

describe('G1: a PC with nothing in reach closes in for next turn (coverage.md section 2)', () => {
  it('40 ft from a harmless dummy (out of this turn\'s 35 ft), the PC moves into next turn\'s reach, and Explain names the next-turn term', () => {
    const w = scene([], [pc('A2'), foe('d1', 'appr-dummy', 'I2')]);
    const me = w.u('pc1');
    w.begin(me);
    const r = w.decide(me);
    expect(isMove(r.key), r.key).toBe(true);
    expect(part(r.rec, r.key, NEXT)).toBeGreaterThan(0);
    expect(part(r.rec, r.key, 'move risk')).toBeLessThanOrEqual(0);
    expect(part(r.rec, r.key, RISE)).toBeDefined();
  });

  it('exposure-aware: 40 ft from a brute that would reach it, the PC at 20 HP does not walk into the brute\'s reach (the rise outweighs gamma x its strike)', () => {
    const w = scene([], [pc('A2'), foe('b1', 'appr-brute', 'I2')]);
    const me = w.u('pc1');
    me.hp = 20;
    w.begin(me);
    const r = w.decide(me);
    // Every square that brings the brute in reach next turn is within its 35 ft: none is taken.
    expect(isMove(r.key), r.key).toBe(false);
  });

  it('a caster with a ranged option doesn\'t charge: its action spent, 40 ft from the dummy, a PC with Fire Bolt (120 ft) stays; the twin without it walks up for its Longsword', () => {
    const c = scene([], [pc('A2'), foe('d1', 'appr-dummy', 'I2')], { caster: true });
    const me = c.u('pc1');
    c.begin(me);
    me.b.action = 0;
    expect(isMove(c.decide(me).key)).toBe(false);
    const w = scene([], [pc('A2'), foe('d1', 'appr-dummy', 'I2')]);
    const me2 = w.u('pc1');
    w.begin(me2);
    me2.b.action = 0;
    expect(isMove(w.decide(me2).key)).toBe(true);
  });

  it('the same 40 ft with the core Dash legal: no Dash is taken when a plain move already brings the dummy in reach by next turn', () => {
    const w = scene([], [pc('A2'), foe('d1', 'appr-dummy', 'I2')]);
    const me = w.u('pc1');
    w.begin(me);
    expect(w.decide(me).key).not.toMatch(/dash/);
  });
});

describe('G1: a strike worth nothing is not engagement', () => {
  it('a lone Dagger thrown from 60 ft at AC 22 is worth less than the Dagger, so the PC closes in for its melee (a warlock that stood and Dodged on dummy-range)', () => {
    const w = scene([], [pc('A2'), foe('d1', 'appr-wall', 'M2')], { dagger: true });
    const me = w.u('pc1');
    w.begin(me);
    const r = w.decide(me);
    expect(isMove(r.key), r.key).toBe(true);
    expect(part(r.rec, r.key, NEXT)).toBeGreaterThan(0);
  });

  it('the twin at AC 12: the same throw is worth something, so the PC throws it', () => {
    const w = scene([], [pc('A2'), foe('d1', 'appr-dummy', 'M2')], { dagger: true });
    const me = w.u('pc1');
    w.begin(me);
    expect(w.decide(me).key).toMatch(/^attack:dagger-thrown/);
  });
});

describe('G1: the PC takes the core Dash (srd-raw.txt:33242-33248) when no move alone brings anything in reach by next turn', () => {
  it('80 ft from the dummy (beyond 30 + 30 + 5 ft) the PC Dashes, and Explain names the Dash term', () => {
    const w = scene([], [pc('A2'), foe('d1', 'appr-dummy', 'Q2')]);
    const me = w.u('pc1');
    w.begin(me);
    const r = w.decide(me);
    expect(r.key).toMatch(/dash/);
    expect(parts(r.rec, r.key).some((p) => p.term.startsWith('Dash: the strike it brings in reach by next turn') && p.ev > 0)).toBe(true);
  });

  it('after the Dash (60 ft of movement, no action left) it moves into next turn\'s reach of the dummy', () => {
    const w = scene([], [pc('A2'), foe('d1', 'appr-dummy', 'Q2')]);
    const me = w.u('pc1');
    w.begin(me);
    Object.assign(me.b, { action: 0, moveFt: 60 });
    const r = w.decide(me);
    expect(isMove(r.key), r.key).toBe(true);
    expect(part(r.rec, r.key, NEXT)).toBeGreaterThan(0);
  });

  it('125 ft from the dummy (out of reach even after a Dash and next turn\'s move) the PC still closes: a Dash for the extra ground, and Explain names it', () => {
    const w = scene([], [pc('A2'), foe('d1', 'appr-dummy', 'Z2')]);
    const me = w.u('pc1');
    w.begin(me);
    const r = w.decide(me);
    expect(r.key).toMatch(/dash/);
    expect(parts(r.rec, r.key).find((p) => p.term.startsWith('Dash: closing in'))?.ev).toBeCloseTo((CLOSE_TIE * 60) / 5, 9);
  });

  it('the same 125 ft with the action spent: it walks the 30 ft on the closing term alone, the row adding up', () => {
    const w = scene([], [pc('A2'), foe('d1', 'appr-dummy', 'Z2')]);
    const me = w.u('pc1');
    w.begin(me);
    me.b.action = 0;
    const r = w.decide(me);
    expect(isMove(r.key), r.key).toBe(true);
    expect(part(r.rec, r.key, CLOSING)).toBeCloseTo((CLOSE_TIE * 30) / 5, 9);
    expect(part(r.rec, r.key, NEXT)).toBe(0);
    const row = r.rec.top.find((t) => t.key === r.key)!;
    expect(parts(r.rec, r.key).reduce((a, p) => a + p.ev, 0)).toBeCloseTo(row.ev, 9);
  });

  it('closing is exposure-aware: 125 ft from a foe whose reach is 105 ft, it walks only as far as stays out of that reach', () => {
    const w = scene([], [pc('A2'), foe('f1', 'appr-fast', 'Z2')]);
    const me = w.u('pc1');
    w.begin(me);
    me.b.action = 0;
    const r = w.decide(me);
    expect(isMove(r.key), r.key).toBe(true);
    expect(part(r.rec, r.key, RISE)).toBeCloseTo(0, 9);
    const dest = /^move:([A-Z])/.exec(r.key)![1]!.charCodeAt(0) - 65;
    expect((25 - dest) * 5).toBeGreaterThan(105);
  });

  it('a caster whose Fire Bolt reaches next turn from here has something to do: no closing term (100 ft, 120 ft range)', () => {
    const w = scene([], [pc('A2'), foe('d1', 'appr-still', 'U2')], { caster: true });
    const me = w.u('pc1');
    w.begin(me);
    me.b.action = 0;
    const r = w.decide(me);
    expect(isMove(r.key), r.key).toBe(false);
    expect(r.rec.top.flatMap((t) => t.parts).some((p) => p.term === CLOSING)).toBe(false);
  });

  /** Outcomes of 10 whole fights. */
  const fights = (w: ReturnType<typeof scene>) => {
    const c: Record<string, number> = {};
    for (let run = 0; run < 10; run++) {
      const r = runFight(w.s, 7, run, w.s.seats.map(() => new GreedyDecider()), null);
      c[r.outcome!.k] = (c[r.outcome!.k] ?? 0) + 1;
    }
    return c;
  };

  it('whole fights: a rooted foe at 125 ft is walked up to and beaten, and a rooted archer there no longer shoots a PC that never closes (both were stalemates)', () => {
    expect(fights(scene([], [pc('A2'), foe('d1', 'appr-still', 'Z2')]))).toEqual({ win: 10 });
    const archer = fights(scene([], [pc('A2'), foe('a1', 'appr-still-archer', 'Z2')]));
    expect(archer.stalemate ?? 0).toBe(0);
    expect(archer.win).toBeGreaterThan(5);
  }, 30000);
});

describe('G1 next-turn reach is the walk, not the straight line (a wall or Difficult Terrain in the way)', () => {
  // Column F is a wall from row 1 to row 5; the gap is at F6. Foe on G1, PC on E1: 10 ft in a line, 60 ft on foot.
  const WALL = ['.....#....................', '.....#....................', '.....#....................', '.....#....................', '.....#....................', '..........................'];
  const fights = (w: ReturnType<typeof scene>) => {
    const c: Record<string, number> = {};
    for (let run = 0; run < 10; run++) {
      const r = runFight(w.s, 7, run, w.s.seats.map(() => new GreedyDecider()), null);
      c[r.outcome!.k] = (c[r.outcome!.k] ?? 0) + 1;
    }
    return c;
  };

  it('a foe behind a wall is not "reachable next turn" from here: the PC walks for the gap, and Explain credits the walk', () => {
    const w = scene([], [pc('E1'), foe('d1', 'appr-still', 'G1')], { terrain: WALL });
    const me = w.u('pc1');
    w.begin(me);
    const r = w.decide(me);
    expect(isMove(r.key), r.key).toBe(true);
    expect(part(r.rec, r.key, NEXT)).toBeGreaterThan(0);
    expect(Number(/^move:[A-Z](\d)/.exec(r.key)![1])).toBeGreaterThan(1);
  });

  it('whole fights: rooted foe, rooted archer and a walking brute behind the wall all end (each stood still for all 10 rounds before); the open-map twin too', () => {
    expect(fights(scene([], [pc('E1'), foe('d1', 'appr-still', 'G1')], { terrain: WALL }))).toEqual({ win: 10 });
    expect(fights(scene([], [pc('E1'), foe('a1', 'appr-still-archer', 'G1')], { terrain: WALL })).stalemate ?? 0).toBe(0);
    expect(fights(scene([], [pc('E1'), foe('b1', 'appr-brute', 'G1')], { terrain: WALL })).stalemate ?? 0).toBe(0);
    expect(fights(scene([], [pc('M1'), foe('d1', 'appr-still', 'G1')]))).toEqual({ win: 10 });
  }, 60000);

  it('Difficult Terrain counts: 30 ft in a line across it is 60 ft on foot, so a rooted foe there is worked up to, not stood off from', () => {
    const rows = Array(6).fill('....' + ':'.repeat(6) + '.'.repeat(16)); // no way round it
    const w = scene([], [pc('D2'), foe('d1', 'appr-still', 'K2')], { terrain: rows });
    expect(fights(w)).toEqual({ win: 10 });
  }, 30000);

  it('terrainFieldFt: the walk round a wall; a corner it may not cut; a Difficult square costs double to enter; open ground is the grid distance', () => {
    const w = scene([], [pc('E1'), foe('d1', 'appr-still', 'G1')], { terrain: WALL });
    const st = w.cx.st;
    const at = (name: string) => (name.charCodeAt(0) - 65) + (Number(name.slice(1)) - 1) * 26;
    const f = terrainFieldFt(st, at('G1'));
    expect(f[at('H1')]).toBe(5);
    expect(f[at('E1')]).toBe(60); // down to E6 (25), across to G6 (10), up to G1 (25): the corners of F5 can't be cut (diagonalCorner's default)
    expect(f[at('F1')]).toBeGreaterThan(1000); // a wall square: no walk reaches it
    const open = scene([], [pc('E1'), foe('d1', 'appr-still', 'G1')]);
    expect(terrainFieldFt(open.cx.st, at('G1'))[at('A6')]).toBe(30);
    const hard = scene([], [pc('E1'), foe('d1', 'appr-still', 'G1')], { terrain: ['.......:..................', ...Array(5).fill('.'.repeat(26))] });
    // Into H1 from I1 costs 10, then into G1 costs 5; round it through H2 is the same 10 by a diagonal each way.
    expect(terrainFieldFt(hard.cx.st, at('H1'))[at('G1')]).toBe(10);
    expect(terrainFieldFt(hard.cx.st, at('G1'))[at('H1')]).toBe(5);
  });
});

describe('G1 reach and Dash details', () => {
  it('a thrown weapon\'s reach is its long range: 90 ft from a dummy, action spent, a step brings it inside Speed + 60 ft, and Explain credits the strike (not the closing tie)', () => {
    const w = scene([], [pc('A2'), foe('d1', 'appr-still', 'V2')], { dagger: true });
    const me = w.u('pc1');
    w.begin(me);
    me.b.action = 0;
    const r = w.decide(me);
    expect(isMove(r.key), r.key).toBe(true);
    expect(part(r.rec, r.key, NEXT)).toBeGreaterThan(0);
    expect(part(r.rec, r.key, CLOSING)).toBeUndefined();
  });

  it('no Dash is even on the list when a plain move already brings the dummy in reach: with 5 ft of move left, the two squares that do it fill Explain, and the third row is not a Dash', () => {
    const w = scene([], [pc('A1'), foe('d1', 'appr-still', 'I1')]);
    const me = w.u('pc1');
    w.begin(me);
    me.b.moveFt = 5;
    const r = w.decide(me);
    expect(isMove(r.key), r.key).toBe(true);
    expect(r.rec.top.map((t) => t.key).some((k) => /dash/.test(k))).toBe(false);
  });

  it('a Dash pays the rise in exposure: 80 ft from a runner whose reach is 65 ft, the rise outweighs gamma x its strike and the PC stays; the same 80 ft from a harmless rooted foe it goes', () => {
    const go = (use: string) => {
      const w = scene([], [pc('A2'), foe('r1', use, 'Q2')]);
      const me = w.u('pc1');
      w.begin(me);
      return w.decide(me).key;
    };
    expect(go('appr-runner')).not.toMatch(/dash/);
    expect(go('appr-still')).toMatch(/dash/);
  });
});

describe('healReach (m10): how far a program can heal someone else', () => {
  const target = (who: string, rangeFt: number) => ({ k: 'target', who, rangeFt, self: 'no', maxSize: 9 }) as unknown as Step;
  const heal = { k: 'heal', roll: null } as unknown as Step;
  it('a target step open to allies followed by a heal: its range', () => {
    expect(healReach([target('ally', 30), heal])).toBe(30);
  });
  it('a self-only program (no target step) heals no one else: -1, whatever its heal', () => {
    expect(healReach([heal])).toBe(-1);
  });
  it('a target step with no heal after it, or aimed at enemies only: -1', () => {
    expect(healReach([target('ally', 30)])).toBe(-1);
    expect(healReach([target('enemy', 30), heal])).toBe(-1);
    expect(healReach([heal, target('ally', 30)])).toBe(-1);
  });
  it('a choose: the longest heal among its options', () => {
    const choose = { k: 'choose', opts: [{ local: 'a', steps: [target('ally', 10), heal] }, { local: 'b', steps: [target('ally', 60), heal] }, { local: 'c', steps: [target('ally', 90)] }] } as unknown as Step;
    expect(healReach([choose])).toBe(60);
  });
});

describe('m10: the approach counts the best rescue reachable next turn (v4\'s RESCUE value)', () => {
  it('a downed ally 50 ft away and a touch heal: the PC closes in on the ally, and Explain names the rescue', () => {
    const w = scene(['appr-touch-heal'], [pc('A2'), pc('K2', 'pc2'), foe('d1', 'appr-dummy', 'Z5')]);
    const me = w.u('pc1');
    const ally = w.u('pc2');
    Object.assign(ally, { hp: 0, life: 'down' });
    w.begin(me);
    const r = w.decide(me);
    expect(isMove(r.key), r.key).toBe(true);
    expect(part(r.rec, r.key, RESCUE_TERM)).toBeGreaterThan(0);
  });

  it('the twin with the ally standing at full HP: no rescue in any row, only the far foe to close on', () => {
    const w = scene(['appr-touch-heal'], [pc('A2'), pc('K2', 'pc2'), foe('d1', 'appr-dummy', 'Z5')]);
    const me = w.u('pc1');
    w.begin(me);
    const r = w.decide(me);
    expect(r.rec.top.flatMap((t) => t.parts).some((p) => p.term === RESCUE_TERM || p.term === RESCUE_NOW || p.term.includes('rescue it brings'))).toBe(false);
    expect(parts(r.rec, r.key).some((p) => p.term.includes(CLOSING))).toBe(true);
  });

  it('a spell heals too: Cure Wounds (touch) and slots close in on the downed ally; with no slot left it is no reason to move', () => {
    const units = [pc('A2'), pc('K2', 'pc2'), foe('d1', 'appr-dummy', 'Z5')];
    const w = scene([], units, { cure: true });
    Object.assign(w.u('pc2'), { hp: 0, life: 'down' });
    const me = w.u('pc1');
    w.begin(me);
    const r = w.decide(me);
    expect(isMove(r.key), r.key).toBe(true);
    expect(part(r.rec, r.key, RESCUE_TERM)).toBeGreaterThan(0);
    const dry = scene([], units, { cure: true });
    Object.assign(dry.u('pc2'), { hp: 0, life: 'down' });
    const me2 = dry.u('pc1');
    dry.begin(me2);
    me2.res.fill(0);
    const dr = dry.decide(me2);
    expect(dr.rec.top.flatMap((t) => t.parts).some((p) => p.term === RESCUE_TERM || p.term === RESCUE_NOW)).toBe(false);
    expect(parts(dr.rec, dr.key).some((p) => p.term.includes(CLOSING))).toBe(true);
  });

  it('a downed ally beyond a move and next turn\'s move (130 ft) is worth a Dash, and Explain names the rescue', () => {
    const w = scene(['appr-touch-heal'], [pc('A2'), pc('O2', 'pc2'), foe('d1', 'appr-dummy', 'Z5')]);
    Object.assign(w.u('pc2'), { hp: 0, life: 'down' });
    const me = w.u('pc1');
    w.begin(me);
    const r = w.decide(me);
    expect(r.key).toMatch(/dash/);
    expect(parts(r.rec, r.key).some((p) => p.term.startsWith('Dash: the rescue it brings in reach by next turn') && p.ev > 0)).toBe(true);
  });

  it('without a heal, a downed ally is no reason to move: only the far foe is', () => {
    const w = scene([], [pc('A2'), pc('K2', 'pc2'), foe('d1', 'appr-dummy', 'Z5')]);
    Object.assign(w.u('pc2'), { hp: 0, life: 'down' });
    const me = w.u('pc1');
    w.begin(me);
    const r = w.decide(me);
    expect(r.rec.top.flatMap((t) => t.parts).some((p) => p.term === RESCUE_TERM || p.term === RESCUE_NOW)).toBe(false);
    expect(parts(r.rec, r.key).some((p) => p.term.includes(CLOSING))).toBe(true);
  });
});

describe('m10 across turns: the downed ally actually gets up (ai-logic-1: it used to stand 35 ft off for good)', () => {
  const down = (w: ReturnType<typeof scene>) => Object.assign(w.u('pc2'), { hp: 0, life: 'down' });

  it('20 ft off, a touch heal, a harmless foe far away: walk and heal in the one turn; Explain names the rescue on the move, at its full value (no gamma)', () => {
    const w = scene(['appr-touch-heal'], [pc('A2'), pc('E2', 'pc2'), foe('d1', 'appr-dummy', 'Z5')]);
    down(w);
    const me = w.u('pc1');
    w.begin(me);
    const r = w.decide(me);
    expect(isMove(r.key), r.key).toBe(true);
    expect(part(r.rec, r.key, RESCUE_NOW)).toBeGreaterThan(0);
    const row = r.rec.top.find((t) => t.key === r.key)!;
    expect(parts(r.rec, r.key).reduce((a, p) => a + p.ev, 0)).toBeCloseTo(row.ev, 9);
    const keys = scene(['appr-touch-heal'], [pc('A2'), pc('E2', 'pc2'), foe('d1', 'appr-dummy', 'Z5')]);
    down(keys);
    keys.turn(keys.u('pc1'));
    expect(keys.u('pc2').life).toBe('up');
  });

  it('50 ft off: up by its second turn (the first turn walks closer, the second walks and heals), not 35 ft off for good', () => {
    const w = scene(['appr-touch-heal'], [pc('A2'), pc('K2', 'pc2'), foe('d1', 'appr-dummy', 'Z5')]);
    down(w);
    const me = w.u('pc1');
    w.turn(me);
    expect(w.u('pc2').life).toBe('down');
    w.turn(me);
    expect(w.u('pc2').life).toBe('up');
  });

  it('70 ft off: a Dash on the first turn, up by the second', () => {
    const w = scene(['appr-touch-heal'], [pc('A2'), pc('O2', 'pc2'), foe('d1', 'appr-dummy', 'Z5')]);
    down(w);
    const me = w.u('pc1');
    expect(w.turn(me)[0]).toMatch(/dash/);
    w.turn(me);
    expect(w.u('pc2').life).toBe('up');
  });

  it('Cure Wounds with slots does the same at 20 ft and at 50 ft', () => {
    for (const [at, turns] of [['E2', 1], ['K2', 2]] as const) {
      const w = scene([], [pc('A2'), pc(at, 'pc2'), foe('d1', 'appr-dummy', 'Z5')], { cure: true });
      down(w);
      for (let k = 0; k < turns; k++) w.turn(w.u('pc1'));
      expect(w.u('pc2').life, at).toBe('up');
    }
  });

  it('a brute adjacent to the healer (the engaged branch): the rescue is on the list, net of the opportunity attack, and it beats the strike', () => {
    const w = scene(['appr-touch-heal'], [pc('A2'), pc('E2', 'pc2'), foe('b1', 'appr-brute', 'A3')]);
    down(w);
    const me = w.u('pc1');
    w.begin(me);
    const r = w.decide(me);
    expect(isMove(r.key), r.key).toBe(true);
    expect(part(r.rec, r.key, RESCUE_NOW)).toBeGreaterThan(0);
    expect(part(r.rec, r.key, 'move risk')).toBeLessThan(0);
    const g = scene(['appr-touch-heal'], [pc('A2'), pc('E2', 'pc2'), foe('b1', 'appr-brute', 'A3')]);
    down(g);
    g.turn(g.u('pc1'));
    expect(g.u('pc2').life).toBe('up');
  });

  it('this turn\'s budget decides: with the action spent an action heal isn\'t this turn\'s, so it walks into range for next turn on the discounted credit; a bonus-action heal still goes now', () => {
    const w = scene(['appr-touch-heal'], [pc('A2'), pc('E2', 'pc2'), foe('d1', 'appr-dummy', 'Z5')]);
    down(w);
    const me = w.u('pc1');
    w.begin(me);
    me.b.action = 0;
    const r = w.decide(me);
    expect(isMove(r.key), r.key).toBe(true);
    expect(part(r.rec, r.key, RESCUE_NOW)).toBeUndefined();
    expect(part(r.rec, r.key, RESCUE_TERM)).toBeGreaterThan(0);
    const dest = /^move:([A-Z])(\d)/.exec(r.key)!;
    expect(Math.max(Math.abs(dest[1]!.charCodeAt(0) - 69), Math.abs(Number(dest[2]) - 2))).toBeLessThanOrEqual(1); // inside the touch: next to E2
    const b = scene(['appr-bonus-heal'], [pc('A2'), pc('E2', 'pc2'), foe('d1', 'appr-dummy', 'Z5')]);
    down(b);
    const me2 = b.u('pc1');
    b.begin(me2);
    me2.b.action = 0;
    const r2 = b.decide(me2);
    expect(part(r2.rec, r2.key, RESCUE_NOW)).toBeGreaterThan(0);
    me2.b.bonus = 0;
    const r3 = b.decide(me2);
    expect(part(r3.rec, r3.key, RESCUE_NOW)).toBeUndefined();
    const c = scene([], [pc('A2'), pc('E2', 'pc2'), foe('d1', 'appr-dummy', 'Z5')], { cure: true });
    down(c);
    const me3 = c.u('pc1');
    c.begin(me3);
    me3.b.action = 0;
    const r4 = c.decide(me3);
    expect(part(r4.rec, r4.key, RESCUE_NOW)).toBeUndefined(); // Cure Wounds is an action too
  });

  it('a slot already spent this turn: no second levelled cast, so no rescue this turn with Cure Wounds', () => {
    const w = scene([], [pc('A2'), pc('E2', 'pc2'), foe('d1', 'appr-dummy', 'Z5')], { cure: true });
    down(w);
    const me = w.u('pc1');
    w.begin(me);
    me.slotTurn = w.cx.st.turnIdx;
    const r = w.decide(me);
    expect(part(r.rec, r.key, RESCUE_NOW)).toBeUndefined();
  });

  it('the credit falls with the walk still to do: in range is worth more than one move off, one move off more than two, gamma a turn', () => {
    const w = scene(['appr-touch-heal'], [pc('A2'), pc('M2', 'pc2'), foe('d1', 'appr-dummy', 'Z5')]);
    down(w);
    const me = w.u('pc1');
    w.begin(me);
    w.decide(me); // primes the decision's caches
    const d = w.ds[me.idx]! as unknown as { rescueAt(st: unknown, cell: number, e: { cell: number; reach: number; v: number }, spd: number): number; w: { gamma: number } };
    const e = { cell: w.u('pc2').cell, reach: 5, v: 8 };
    const at = (n: number) => w.s.w + n;
    const g = d.w.gamma;
    expect(d.rescueAt(w.cx.st, at(11), e, 30)).toBeCloseTo(8, 9); // next to it
    expect(d.rescueAt(w.cx.st, at(6), e, 30)).toBeCloseTo(8 * g, 9); // 30 ft: 25 ft short, one turn of walking
    expect(d.rescueAt(w.cx.st, at(0), e, 30)).toBeCloseTo(8 * g * g, 9); // 60 ft: 55 ft short, two
    expect(d.rescueAt(w.cx.st, at(0), e, 0)).toBe(0); // Speed 0: never
  });

  it('whole fights: a soft ally dropped by a rooted archer past the old horizon is healed in fights where it used to get none (20 ft off, a Longbow on it)', () => {
    const w = scene(['appr-touch-heal'], [pc('A2', 'pc1'), pc('E2', 'pc2'), foe('a1', 'appr-still-archer', 'Z2')], { hp: 14 });
    let heals = 0;
    for (let run = 0; run < 12; run++) {
      const ds = w.s.seats.map((): Decider => {
        const g = new GreedyDecider();
        return { name: g.name, decide(view, dp) { const i = g.decide(view, dp); if (dp.k === 'turn' && dp.keyOf(i).startsWith('use:appr-touch-heal')) heals++; return i; } };
      });
      runFight(w.s, 7, run, ds, null);
    }
    expect(heals).toBeGreaterThan(0);
  }, 30000);
});

describe('m10 behind a wall: full credit only from a square with a line to the ally (a heal can\'t target through Total Cover, sim/cast.ts anyTarget)', () => {
  // Column F is a wall from row 1 to row 5, the gap at F6. PC on E3, downed ally on G3: 10 ft in a line, no line from E3.
  const COLUMN = [...Array(5).fill('.....#' + '.'.repeat(20)), '.'.repeat(26)];
  const units = (at = 'E3', ally = 'G3') => [pc(at), pc(ally, 'pc2'), foe('d1', 'appr-still', 'Z6')];
  const at = (name: string) => name.charCodeAt(0) - 65 + (Number(name.slice(1)) - 1) * 26;
  const down = (w: ReturnType<typeof scene>) => Object.assign(w.u('pc2'), { hp: 0, life: 'down' });
  const dest = (key: string) => at(/^move:([A-Z]\d)/.exec(key)![1]!);
  /** The turn (1-based) the ally is up, within `n`; 0 for never; and the first turn's keys. */
  const play = (w: ReturnType<typeof scene>, n: number) => {
    let first: string[] = [];
    for (let k = 1; k <= n; k++) {
      const keys = w.turn(w.u('pc1'));
      if (k === 1) first = keys;
      if (w.u('pc2').life === 'up') return { up: k, first };
    }
    return { up: 0, first };
  };

  for (const [name, features, opt] of [['SRD Healing Word', [], { word: true }], ['a 60 ft action heal', ['appr-far-heal'], {}]] as const) {
    it(`${name}, the open twin heals from where it stands on turn 1; behind the wall it walks to the first square with a line and heals on turn 1 (it used to pass every turn)`, () => {
      const open = scene([...features], units(), opt);
      down(open);
      const o = play(open, 1);
      expect(o.up).toBe(1);
      expect(isMove(o.first[0]!), o.first[0]).toBe(false);

      const w = scene([...features], units(), { ...opt, terrain: COLUMN });
      down(w);
      const me = w.u('pc1');
      w.begin(me);
      const r = w.decide(me);
      expect(isMove(r.key), r.key).toBe(true);
      expect(part(r.rec, r.key, RESCUE_NOW)).toBeGreaterThan(0);
      expect(targetable(w.cx.st, dest(r.key), w.u('pc2').cell, null)).toBe(true);
      const g = scene([...features], units(), { ...opt, terrain: COLUMN });
      down(g);
      const p = play(g, 1);
      expect(p.up).toBe(1);
      expect(p.first[0]).toMatch(/^move:F6/);
    });
  }

  it('a touch heal still walks round and heals on turn 2; the wall changes nothing it already had', () => {
    const w = scene(['appr-touch-heal'], units(), { terrain: COLUMN });
    down(w);
    expect(play(w, 3).up).toBe(2);
  });

  it('no action or Bonus Action left: it walks to a square with a line for next turn at the full credit, and the heal lands on the next turn', () => {
    const w = scene(['appr-far-heal'], units(), { terrain: COLUMN });
    down(w);
    const me = w.u('pc1');
    w.begin(me);
    me.b.action = 0;
    const r = w.decide(me);
    expect(isMove(r.key), r.key).toBe(true);
    expect(part(r.rec, r.key, RESCUE_NOW)).toBeUndefined();
    expect(part(r.rec, r.key, RESCUE_TERM)).toBeGreaterThan(0);
    expect(targetable(w.cx.st, dest(r.key), w.u('pc2').cell, null)).toBe(true);
    const list = listOptions(w.cx, me, takeList(w.cx));
    let mv: Legal | null = null;
    for (let i = 0; i < list.n; i++) if (legalKey(w.cx.st, me.idx, list.items[i]!) === r.key) mv = copyLegal(list.items[i]!, newLegal());
    releaseList(w.cx, list);
    resolveOption(w.cx, me, mv!, -1);
    w.turn(me);
    expect(w.u('pc2').life).toBe('up');
  });

  it('rescueAt counts the walk to the line, not the walk to the ally less the range: from E3, 20 ft short of F6, it is one gamma off (the old read gave it all)', () => {
    const w = scene(['appr-far-heal'], units(), { terrain: COLUMN });
    down(w);
    const me = w.u('pc1');
    w.begin(me);
    w.decide(me);
    const d = w.ds[me.idx]! as unknown as { rescueAt(st: unknown, cell: number, e: { cell: number; reach: number; v: number }, spd: number): number; w: { gamma: number } };
    const e = { cell: at('G3'), reach: 60, v: 8 };
    expect(d.rescueAt(w.cx.st, at('E3'), e, 30)).toBeCloseTo(8 * d.w.gamma, 9);
    expect(d.rescueAt(w.cx.st, at('F6'), e, 30)).toBeCloseTo(8, 9);
    expect(d.rescueAt(w.cx.st, at('H3'), e, 30)).toBeCloseTo(8, 9); // the ally's side
    expect(d.rescueAt(w.cx.st, at('E3'), e, 10)).toBeCloseTo(8 * d.w.gamma * d.w.gamma, 9); // 20 ft at 10 ft a turn: the loop's own steps
    expect(d.rescueAt(w.cx.st, at('E3'), e, 0)).toBe(0);
  });

  // Row 3 walled from A to V, the gap at W3. PC on E2, ally on U4: the old read took 95 ft on foot less 60 ft of range, 35 ft short; the first square with a line is 90 ft on foot.
  const LONG = ['.'.repeat(26), '.'.repeat(26), '#'.repeat(22) + '.'.repeat(4), ...Array(3).fill('.'.repeat(26))];

  it('the Dash reads the walk to the line: 90 ft on foot, so a Dash now and the heal next turn; the open twin walks 20 ft and heals', () => {
    const w = scene(['appr-far-heal'], [pc('E2'), pc('U4', 'pc2'), foe('d1', 'appr-still', 'Z6')], { terrain: LONG });
    down(w);
    const me = w.u('pc1');
    w.begin(me);
    const r = w.decide(me);
    expect(r.key).toMatch(/dash/);
    expect(parts(r.rec, r.key).some((p) => p.term.startsWith('Dash: the rescue it brings in reach by next turn') && p.ev > 0)).toBe(true);
    const g = scene(['appr-far-heal'], [pc('E2'), pc('U4', 'pc2'), foe('d1', 'appr-still', 'Z6')], { terrain: LONG });
    down(g);
    expect(play(g, 3).up).toBe(2);
    const open = scene(['appr-far-heal'], [pc('E2'), pc('U4', 'pc2'), foe('d1', 'appr-still', 'Z6')]);
    down(open);
    const o = play(open, 2);
    expect(o.up).toBe(1);
    expect(isMove(o.first[0]!), o.first[0]).toBe(true);
  });

  it('the Dash credit counts every turn of the walk to the line: 110 ft on foot, gamma twice (the old read, 60 ft short, gave once), over staying at gamma four times', () => {
    const w = scene(['appr-far-heal'], [pc('A2'), pc('U4', 'pc2'), foe('d1', 'appr-still', 'Z6')], { terrain: LONG });
    down(w);
    const me = w.u('pc1');
    w.begin(me);
    const d = w.ds[me.idx]! as unknown as { healsNext: (...a: unknown[]) => void; w: { gamma: number } };
    const real = d.healsNext;
    const vals: number[] = [];
    d.healsNext = function (this: unknown, ...a: unknown[]) {
      real.apply(this, a);
      for (const e of a[3] as { v: number; rescue: boolean }[]) if (e.rescue && !a[4]) vals.push(e.v);
    };
    const r = w.decide(me);
    expect(r.key).toMatch(/dash/);
    const g = d.w.gamma;
    const v = vals[0]!;
    expect(v).toBeGreaterThan(0);
    const ev = parts(r.rec, r.key).find((p) => p.term.startsWith('Dash: the rescue it brings in reach by next turn'))!.ev;
    expect(ev).toBeCloseTo(g * (v * g ** 2 - v * g ** 4), 6);
  });

  /** G2's pending heal for a PC beside a brute, read from the Dodge's own term. */
  const pending = (terrain: string[]) => {
    const w = scene(['appr-far-heal'], [pc('E2'), pc('E4', 'pc2'), foe('b1', 'appr-brute', 'D2')], { terrain });
    down(w);
    const me = w.u('pc1');
    w.begin(me);
    me.b.action = 1;
    const d = w.ds[me.idx]! as unknown as { dodgeTerm: (...a: unknown[]) => { heal: number } };
    const real = d.dodgeTerm;
    let seen = -1;
    d.dodgeTerm = function (this: unknown, ...a: unknown[]) {
      const o = real.apply(this, a);
      seen = o.heal;
      return o;
    };
    w.decide(me);
    return seen;
  };

  it('G2\'s pending heal needs a square with a line inside next turn\'s move: a gap at G3 buys time, a gap at L3 (35 ft) does not, though the ally is within Speed + range on foot (70 ft) by the old read', () => {
    const near = ['.'.repeat(26), '.'.repeat(26), '######' + '.'.repeat(20), ...Array(3).fill('.'.repeat(26))];
    const far = ['.'.repeat(26), '.'.repeat(26), '#'.repeat(11) + '.'.repeat(15), ...Array(3).fill('.'.repeat(26))];
    expect(pending(near)).toBeGreaterThan(0);
    expect(pending(far)).toBe(0);
  });

  it('a wall with no gap: no walk reaches a line, so no rescue is credited and the PC goes for the foe on its own side instead of standing', () => {
    const sealed = Array(6).fill('.'.repeat(19) + '#' + '.'.repeat(6));
    const w = scene(['appr-far-heal'], [pc('A3'), pc('U3', 'pc2'), foe('d1', 'appr-still', 'S6')], { terrain: sealed });
    down(w);
    const me = w.u('pc1');
    w.begin(me);
    const r = w.decide(me);
    expect(r.key).toMatch(/dash/);
    expect(r.rec.top.flatMap((t) => t.parts).some((p) => p.term === RESCUE_TERM || p.term === RESCUE_NOW || p.term.includes('the rescue it brings'))).toBe(false);
  });

  it('a PC with no heal in that same walled scene isn\'t stuck: it Dashes for the far foe, and the closing term names it; a walled scene changes nothing here', () => {
    for (const terrain of [COLUMN, undefined]) {
      const w = scene([], units(), terrain ? { terrain } : {});
      down(w);
      const me = w.u('pc1');
      w.begin(me);
      const r = w.decide(me);
      expect(r.key).toMatch(/dash/);
      expect(parts(r.rec, r.key).some((p) => p.term.startsWith('Dash: closing in') && p.ev > 0)).toBe(true);
    }
  });

  it('losMethod=stubbed reads no wall as cover: the same layout heals from E3 with no move, and no line field is built', () => {
    const w = scene(['appr-far-heal'], units(), { terrain: COLUMN, flags: { losMethod: 'stubbed' } });
    down(w);
    expect(play(w, 1).first[0]).toMatch(/^use:appr-far-heal/);
    expect((w.ds[w.u('pc1').idx]! as unknown as { lineFields: Map<number, Int32Array> }).lineFields.size).toBe(0);
  });

  it('losMethod=stubbed with no walk to the ally: no credit, read as out of reach rather than as a huge distance (it spun about 10 s a fight)', () => {
    const sealed = Array(6).fill('.'.repeat(19) + '#' + '.'.repeat(6));
    const w = scene(['appr-far-heal'], [pc('A3'), pc('U3', 'pc2'), foe('d1', 'appr-still', 'S6')], { terrain: sealed, flags: { losMethod: 'stubbed' } });
    down(w);
    const me = w.u('pc1');
    w.begin(me);
    const r = w.decide(me);
    const d = w.ds[me.idx]! as unknown as { rescueShort(st: unknown, cell: number, e: { cell: number; reach: number }): number };
    expect(d.rescueShort(w.cx.st, me.cell, { cell: w.u('pc2').cell, reach: 60 })).toBe(Infinity);
    expect(r.rec.top.flatMap((t) => t.parts).some((p) => p.term === RESCUE_TERM || p.term === RESCUE_NOW || p.term.includes('the rescue it brings'))).toBe(false);
  });

  it('on a walled map a touch heal counts only squares in its range: an ally 50 ft off along a clear line is walked to and healed on turn 2 (a line alone must not read as in range)', () => {
    const FAR_WALL = [...Array(5).fill('.'.repeat(24) + '#.'), '.'.repeat(26)];
    const w = scene(['appr-touch-heal'], [pc('A3'), pc('K3', 'pc2'), foe('d1', 'appr-still', 'Z6')], { terrain: FAR_WALL });
    down(w);
    expect(play(w, 3).up).toBe(2);
  });

  it('a stable ally counts for next turn too: 60 ft one way with a foe the other, the PC walks to the ally and heals on turn 2', () => {
    const FAR_WALL = [...Array(5).fill('.'.repeat(24) + '#.'), '.'.repeat(26)];
    const w = scene(['appr-touch-heal'], [pc('M3'), pc('A3', 'pc2'), foe('d1', 'appr-still', 'Z6')], { terrain: FAR_WALL });
    Object.assign(w.u('pc2'), { hp: 0, life: 'stable' });
    expect(play(w, 3).up).toBe(2);
  });

  it('an open map pays nothing: no line field is built, and a wall that is there builds one per (target, range)', () => {
    const fields = (terrain?: string[]) => {
      const w = scene(['appr-far-heal'], units('A1', 'S1'), terrain ? { terrain } : {});
      down(w);
      const me = w.u('pc1');
      w.begin(me);
      me.b.action = 0;
      w.decide(me);
      return (w.ds[me.idx]! as unknown as { lineFields: Map<number, Int32Array> }).lineFields.size;
    };
    expect(fields()).toBe(0);
    expect(fields(COLUMN)).toBe(1);
  });
});

describe('m10\'s walk and the rescue this turn: the details', () => {
  const at = (name: string) => name.charCodeAt(0) - 65 + (Number(name.slice(1)) - 1) * 26;
  const down = (w: ReturnType<typeof scene>, life = 'down') => Object.assign(w.u('pc2'), { hp: 0, life });

  it('the rescue credit on an open map reads the walk: Difficult Terrain makes 35 ft in a line 65 ft on foot (the straight line would say one gamma, the walk two)', () => {
    const rows = Array(6).fill('....' + ':'.repeat(6) + '.'.repeat(16));
    const w = scene(['appr-touch-heal'], [pc('D2'), pc('K2', 'pc2'), foe('d1', 'appr-dummy', 'Z5')], { terrain: rows });
    down(w);
    const me = w.u('pc1');
    w.begin(me);
    w.decide(me);
    const d = w.ds[me.idx]! as unknown as { rescueAt(st: unknown, cell: number, e: { cell: number; reach: number; v: number }, spd: number): number; w: { gamma: number } };
    expect(d.rescueAt(w.cx.st, at('D2'), { cell: at('K2'), reach: 5, v: 8 }, 30)).toBeCloseTo(8 * d.w.gamma ** 2, 9);
  });

  it('the Dash reads the walk for a strike: three walls make 130 ft on foot of 30 ft in a line, so no Dash is credited with that strike, only the closing', () => {
    const row = (gap: boolean[]) => {
      const r = Array(26).fill('.');
      if (gap[0]) r[5] = '#';
      if (gap[1]) r[7] = '#';
      if (gap[2]) r[9] = '#';
      return r.join('');
    };
    const rows = [row([true, false, true]), ...Array(4).fill(row([true, true, true])), row([false, true, false])];
    const w = scene([], [pc('E1'), foe('d1', 'appr-still', 'K1')], { terrain: rows });
    const f = terrainFieldFt(w.cx.st, at('K1'));
    expect(f[at('E1')]).toBe(130);
    const me = w.u('pc1');
    w.begin(me);
    const r = w.decide(me);
    expect(r.key).toMatch(/dash/);
    expect(parts(r.rec, r.key).some((p) => p.term.startsWith('Dash: closing in'))).toBe(true);
    expect(parts(r.rec, r.key).some((p) => p.term.startsWith('Dash: the strike'))).toBe(false);
  });

  it('terrainFieldFt under diagonalCost=alternate: 5, 10, 5 ft for three diagonal steps, 15 ft under the default', () => {
    const alt = scene([], [pc('A1'), foe('d1', 'appr-still', 'Z6')], { flags: { diagonalCost: 'alternate' } });
    expect(terrainFieldFt(alt.cx.st, at('D4'))[at('A1')]).toBe(20);
    const def = scene([], [pc('A1'), foe('d1', 'appr-still', 'Z6')]);
    expect(terrainFieldFt(def.cx.st, at('D4'))[at('A1')]).toBe(15);
  });

  it('terrainFieldFt to several squares is the walk to the nearest of them', () => {
    const w = scene([], [pc('A1'), foe('d1', 'appr-still', 'Z6')]);
    const f = terrainFieldFt(w.cx.st, [at('D1'), at('M1')]);
    expect(f[at('A1')]).toBe(15);
    expect(f[at('K1')]).toBe(10);
    expect(f[at('D1')]).toBe(0);
  });

  it('the rescue this turn takes the cheapest square in range, not the first: beside a rooted brute on E1 the squares of row 1 and 2 are exposed, so it stops on row 3', () => {
    const w = scene(['appr-touch-heal'], [pc('A2'), pc('E2', 'pc2'), foe('b1', 'appr-rooted-brute', 'E1')]);
    down(w);
    const me = w.u('pc1');
    w.begin(me);
    const r = w.decide(me);
    expect(isMove(r.key), r.key).toBe(true);
    expect(part(r.rec, r.key, RESCUE_NOW)).toBeGreaterThan(0);
    expect(part(r.rec, r.key, 'exposure there')).toBeCloseTo(0, 9);
    expect(r.key).toMatch(/^move:[A-Z]3/);
  });

  it('a stable ally is rescued this turn too (0 HP and out of the fight until healed), the same term as a dying one', () => {
    const w = scene(['appr-touch-heal'], [pc('A2'), pc('E2', 'pc2'), foe('d1', 'appr-dummy', 'Z5')]);
    down(w, 'stable');
    const me = w.u('pc1');
    w.begin(me);
    const r = w.decide(me);
    expect(isMove(r.key), r.key).toBe(true);
    expect(part(r.rec, r.key, RESCUE_NOW)).toBeGreaterThan(0);
  });

  it('the rescue this turn is a PC\'s: the same state with a non-PC seat has no such term', () => {
    // A brute beside it, so the non-PC doesn't take its Dash first: on a PC this very scene rescues (the test above, "a brute adjacent").
    const w = scene(['appr-touch-heal'], [pc('A2'), pc('E2', 'pc2'), foe('b1', 'appr-brute', 'A3')]);
    down(w);
    const me = w.u('pc1');
    Object.assign(me, { isPc: false });
    w.begin(me);
    const r = w.decide(me);
    expect(r.rec.top.flatMap((t) => t.parts).some((p) => p.term === RESCUE_NOW)).toBe(false);
  });
});

describe('G1 leaves monsters on today\'s term', () => {
  it('a monster with nothing in reach even after moving still Dashes first', () => {
    const w = scene([], [pc('A2'), foe('b1', 'appr-brute', 'Q2')]);
    const b = w.u('b1');
    w.begin(b);
    const r = w.decide(b);
    expect(r.rec.note).toBe('nothing in reach even after moving: Dash first');
  });

  it('a monster closing in still uses the closing-in term (exposure ignored)', () => {
    const w = scene([], [pc('A2'), foe('b1', 'appr-brute', 'Q2')]);
    const b = w.u('b1');
    w.begin(b);
    Object.assign(b.b, { action: 0, moveFt: 60 });
    const r = w.decide(b);
    expect(isMove(r.key)).toBe(true);
    expect(part(r.rec, r.key, 'closing in')).toBeGreaterThan(0);
  });
});

describe('M9 fallback (2): the exact next-turn strike only on the top-k destinations', () => {
  it('k is frozen at the measured value', () => {
    expect(APPROACH_TOP_K).toBe(16);
    expect(new GreedyDecider().approachTopK).toBe(APPROACH_TOP_K);
  });

  /** The squares `bestStrike` is asked about in one decision of the PC 40 ft from the dummy, at k. */
  const asked = (k: number) => {
    const w = scene([], [pc('A2'), foe('d1', 'appr-dummy', 'I2')]);
    const me = w.u('pc1');
    w.begin(me);
    const d = w.ds[me.idx]! as unknown as { approachTopK: number; bestStrike: (v: unknown, m: Unit, from: number) => [number, number, number] };
    d.approachTopK = k;
    const real = d.bestStrike;
    const from: number[] = [];
    d.bestStrike = function (this: unknown, v, m, c) {
      from.push(c);
      return real.call(this, v, m, c);
    };
    w.decide(me);
    return { from, w };
  };

  it('the exact strike is asked for on k more destinations, and only as far as there are destinations', () => {
    const base = asked(0).from.length;
    expect(asked(16).from.length - base).toBe(16);
    const all = asked(Infinity).from.length - base;
    expect(all).toBeGreaterThan(16);
    expect(asked(all + 50).from.length - base).toBe(all);
  });

  it('the top-k are the destinations nearest the target: with k = 1 the one extra square is the full 30 ft closer in', () => {
    const before = asked(0).from.slice();
    const { from, w } = asked(1);
    const extra = from.filter((c, i) => c !== before[i]);
    expect(extra[0]! % w.s.w).toBe(6);
  });

  it('a destination inside k gets its own square\'s strike: an ally between the PC and the dummy gives cover from here, none from the square next to the dummy; at k the PC steps up for that, at 0 it sees no gain', () => {
    const next = (k: number) => {
      const w = scene([], [pc('A2'), pc('D2', 'pc2'), foe('d1', 'appr-dummy', 'H2')]);
      const me = w.u('pc1');
      w.begin(me);
      me.b.action = 0;
      w.ds[me.idx]!.approachTopK = k;
      return w.decide(me);
    };
    const at = next(APPROACH_TOP_K);
    expect(isMove(at.key), at.key).toBe(true);
    expect(part(at.rec, at.key, NEXT)).toBeGreaterThan(0);
    expect(isMove(next(0).key)).toBe(false);
  });

  it('frozen k against every destination scored: whole fights on an open map hash the same', () => {
    const fight = (k: number, run: number) => {
      const w = scene([], [pc('A2'), pc('C4', 'pc2'), foe('b1', 'appr-brute', 'S2'), foe('b2', 'appr-brute', 'S5')]);
      const ds = w.s.seats.map(() => {
        const g = new GreedyDecider();
        g.approachTopK = k;
        return g;
      });
      const hs = new HashSink();
      runFight(w.s, 7, run, ds, hs);
      return hs.hex();
    };
    for (let run = 0; run < 6; run++) expect(fight(APPROACH_TOP_K, run)).toBe(fight(Infinity, run));
  }, 30000); // whole fights: over the default 5 s on a loaded machine
});
