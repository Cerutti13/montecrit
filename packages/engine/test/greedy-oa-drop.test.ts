// Greedy v8 (coverage.md, step 7 follow-up): a move that provokes opportunity attacks is worth its
// follow-up (the strike, cast or heal from there, next turn's action from there) only if those
// attacks leave the mover up: the follow-up's value is multiplied by 1 - P(drop), with P(drop)
// exact over the reactors' hit odds and damage distributions (decide/greedy/oa.ts). The HP cost of
// the attacks (moveCost's oaRisk) stays. Content is synthetic (test: ids) on the repo packs.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../src/content/load.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import type { DecisionPoint, Legal } from '../src/decide/decider.ts';
import { GreedyDecider, type ExplainRecord } from '../src/decide/greedy/greedy.ts';
import { afterDrop, dropLoss, oaDropChance } from '../src/decide/greedy/oa.ts';
import { convolve, die, shift } from '../src/odds/pmf.ts';
import { resolveScenario } from '../src/scenario/resolve.ts';
import { copyLegal, legalKey, newLegal, releaseList, takeList } from '../src/sim/context.ts';
import { createContext } from '../src/sim/fight.ts';
import { listOptions } from '../src/sim/options.ts';
import { applyPassives } from '../src/sim/precast.ts';
import type { BearerStat, Unit } from '../src/sim/state.ts';
import { DAMAGE_TYPES, damageBit } from '../src/content/types.ts';

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

const KIT: Record<string, string> = {
  // A 15-ft cone from Self (an aimed area, as Cone of Cold is): 8d6 fire, DEX half.
  'packs/test/spells/oad-cone.yaml': `kind: spell
id: test:oad-cone
name: oad-cone
source: synthetic test fixture
level: 1
castingTime: action
range: self
components: { v: true, s: true }
duration: instant
area: blast
effects:
  - id: blast
    name: oad-cone
    zone: { shape: cone, size: 15 }
    duration: { rounds: 1 }
    on: [{ when: [appear], do: [{ save: { ability: dex, half: true, damage: [{ roll: 8d6, type: fire }] } }] }]
do: [{ apply: { effect: blast, to: point } }]
`,
  'packs/test/pcs/oad-pc.yaml': `kind: pc
id: test:oad-pc
name: OA PC
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
features: []
slots: [4, 3, 2]
casting:
  - { source: wizard, ability: int, list: wizard, cantrips: [], prepared: [test:oad-cone] }
`,
  // The strong melee foe next to the caster: +8, 2d6 + 6 (8 at least: any hit drops a 6-HP caster).
  'packs/test/monsters/oad-brute.yaml': `kind: monster
id: test:oad-brute
name: oad-brute
source: synthetic test fixture
size: medium
cr: 3
pb: 2
ac: 12
hp: { average: 200, formula: '200' }
speed: { walk: 30 }
initiative: { mod: 0, score: 10 }
abilities: { str: 18, dex: 10, con: 14, int: 6, wis: 10, cha: 6 }
attacks:
  - { id: maul, name: Maul, kind: melee, toHit: 8, damage: [{ roll: '2d6 + 6', type: bludgeoning, avg: 13 }] }
`,
  // The cone's targets: rooted, 20 HP, they hit back at whoever stands next to them.
  'packs/test/monsters/oad-imp.yaml': `kind: monster
id: test:oad-imp
name: oad-imp
source: synthetic test fixture
size: medium
cr: 1
pb: 2
ac: 12
hp: { average: 20, formula: '20' }
speed: { walk: 0 }
initiative: { mod: 0, score: 10 }
abilities: { str: 12, dex: 8, con: 12, int: 6, wis: 10, cha: 6 }
attacks:
  - { id: bite, name: Bite, kind: melee, toHit: 5, damage: [{ roll: '1d8 + 3', type: piercing, avg: 7 }] }
`,
  // Review fixes (the follow-up sites). A rooted foe immune to weapons: nothing to strike here, any
  // hit (+8, 1d4 + 6: 7 at least) drops a 6-HP PC, and nothing threatens a square out of its reach.
  'packs/test/monsters/oad-golem.yaml': `kind: monster
id: test:oad-golem
name: oad-golem
source: synthetic test fixture
size: medium
cr: 3
pb: 2
ac: 12
hp: { average: 200, formula: '200' }
speed: { walk: 0 }
immune: [bludgeoning, piercing, slashing]
initiative: { mod: 0, score: 10 }
abilities: { str: 18, dex: 10, con: 14, int: 6, wis: 10, cha: 6 }
attacks:
  - { id: maul, name: Maul, kind: melee, toHit: 8, damage: [{ roll: '1d4 + 6', type: bludgeoning, avg: 8 }] }
`,
  // A frail foe: rooted, AC 10, 6 HP (a Longsword hit nearly always drops it).
  'packs/test/monsters/oad-frail.yaml': `kind: monster
id: test:oad-frail
name: oad-frail
source: synthetic test fixture
size: medium
cr: 1
pb: 2
ac: 10
hp: { average: 6, formula: '6' }
speed: { walk: 0 }
initiative: { mod: 0, score: 10 }
abilities: { str: 12, dex: 8, con: 12, int: 6, wis: 10, cha: 6 }
attacks:
  - { id: bite, name: Bite, kind: melee, toHit: 5, damage: [{ roll: '1d8 + 3', type: piercing, avg: 7 }] }
`,
  // The prize: rooted, AC 10, 6 HP (a Longsword hit nearly always drops it), and next to harmless (+0, 1).
  'packs/test/monsters/oad-prize.yaml': `kind: monster
id: test:oad-prize
name: oad-prize
source: synthetic test fixture
size: medium
cr: 1
pb: 2
ac: 10
hp: { average: 6, formula: '6' }
speed: { walk: 0 }
initiative: { mod: 0, score: 10 }
abilities: { str: 12, dex: 8, con: 12, int: 6, wis: 10, cha: 6 }
attacks:
  - { id: peck, name: Peck, kind: melee, toHit: 0, damage: [{ roll: '1', type: piercing, avg: 1 }] }
`,
  // A second reactor: +8, 2d4 + 4 slashing.
  'packs/test/monsters/oad-blade.yaml': `kind: monster
id: test:oad-blade
name: oad-blade
source: synthetic test fixture
size: medium
cr: 2
pb: 2
ac: 12
hp: { average: 100, formula: '100' }
speed: { walk: 0 }
initiative: { mod: 0, score: 10 }
abilities: { str: 16, dex: 10, con: 14, int: 6, wis: 10, cha: 6 }
attacks:
  - { id: blade, name: Blade, kind: melee, toHit: 8, damage: [{ roll: '2d4 + 4', type: slashing, avg: 9 }] }
`,
  // A bonus-action Disengage (a Cunning Action stand-in).
  'packs/test/features/oad-slip.yaml': `kind: feature
id: test:oad-slip
name: oad-slip
source: synthetic test fixture
activate: { id: slip, name: Slip Away, cost: bonus, do: [{ core: disengage }] }
`,
  // A party reactor holding a two-handed Maul with a Shield in the other hand: it can't swing the
  // Maul (Two-Handed), so its opportunity attack is an Unarmed Strike (1 + STR 4 = 5).
  'packs/test/pcs/oad-knight.yaml': `kind: pc
id: test:oad-knight
name: OA Knight
source: synthetic test fixture
rules: '2024'
level: 5
size: medium
speed: 30
abilities: { str: 18, dex: 10, con: 14, int: 10, wis: 10, cha: 8 }
hpMax: 44
ac: 18
armor: none
saveProficiencies: [str, con]
heldWeapons: true
weapons:
  - { id: maul, name: Maul, kind: melee, ability: str, twoHanded: true, damage: [{ roll: 2d6 + @mod, type: bludgeoning }] }
items: [{ id: shield, name: Shield, kind: shield, shieldAc: 2 }]
hands: [maul, shield]
features: []
`,
};

/** A Fighter-shaped PC (STR 18, Longsword 1d8 + 4, 44 HP), with `feats`, and Cure Wounds when `cure`. */
const fighter = (o: { feats?: string[]; cure?: boolean } = {}) => `kind: pc
id: test:oad-fighter
name: OA Fighter
source: synthetic test fixture
rules: '2024'
level: 5
size: medium
speed: 30
abilities: { str: 18, dex: 12, con: 14, int: 10, wis: 14, cha: 8 }
hpMax: 44
ac: 16
armor: none
saveProficiencies: [str, con]
weapons:
  - { id: longsword, name: Longsword, kind: melee, ability: str, category: martial, damage: [{ roll: 1d8 + @mod, type: slashing }] }
features: [${(o.feats ?? []).join(', ')}]
${o.cure ? "slots: [4, 3]\ncasting:\n  - { source: cleric, ability: wis, list: cleric, prepared: ['srd:cure-wounds'] }\n" : ''}`;

type U = { seat: string; team: 'party' | 'enemies'; use: string; at: string };

function scene(units: U[], o: { gw?: number; fighter?: Parameters<typeof fighter>[0] } = {}) {
  const kit = { ...KIT, 'packs/test/pcs/oad-fighter.yaml': fighter(o.fighter) };
  const r = loadContent([...REPO, ...Object.entries(kit).map(([path, text]) => ({ path, text }))]);
  if (!r.content) throw new Error(r.errors.map(formatDiag).join('\n'));
  const doc = {
    kind: 'scenario', id: 'oad', name: 'OA drop', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: { w: o.gw ?? 16, h: 9 },
    flags: { initiativeMode: 'static' }, knobs: { downEnds: false, maxRounds: 3 },
    units: units.map((u) => ({ ...u, decider: 'greedy' })),
  };
  const res = resolveScenario(doc, 'oad.yaml', r.content);
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
  const decide = (who: Unit) => {
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
    return { key: keys[i]!, item: items[i]!, items, keys, rec: records.at(-1)! };
  };
  return { s, cx, u, ds, begin, decide };
}

const UNITS: U[] = [
  { seat: 'pc', team: 'party', use: 'test:oad-pc', at: 'E5' },
  { seat: 'brute', team: 'enemies', use: 'test:oad-brute', at: 'D5' },
  { seat: 'i1', team: 'enemies', use: 'test:oad-imp', at: 'H2' },
  { seat: 'i2', team: 'enemies', use: 'test:oad-imp', at: 'I2' },
  { seat: 'i3', team: 'enemies', use: 'test:oad-imp', at: 'I3' },
  { seat: 'i4', team: 'enemies', use: 'test:oad-imp', at: 'H5' },
];

const OA_DROP = 'opportunity attacks on the way may drop me first: the follow-up x P(drop)';
const partsOf = (rec: ExplainRecord, key: string) => rec.top.find((t) => t.key === key)?.parts ?? [];
const C = (n: number) => ({ min: n, p: Float64Array.of(1) });

describe('greedy v8: a provoking move is worth its follow-up only if the opportunity attacks leave the mover up', () => {
  it('a 6-HP caster next to a +8 brute (any hit drops it) casts its cone from where it stands instead of walking out of reach to a better aim', () => {
    const w = scene(UNITS);
    const me = w.u('pc');
    me.hp = 6;
    w.begin(me);
    const r = w.decide(me);
    expect(r.key).toMatch(/^cast:oad-cone/);
    // Every provoking move it scored carries the discount line.
    for (const t of r.rec.top) if (/^move:.*\/p[1-9]/.test(t.key)) expect(partsOf(r.rec, t.key).some((p) => p.term === OA_DROP)).toBe(true);
  });

  it('the same caster at full HP (44: no single attack can drop it) still walks out to the aim that catches more', () => {
    const w = scene(UNITS);
    const me = w.u('pc');
    w.begin(me);
    const r = w.decide(me);
    expect(r.key).toMatch(/^move:.*\/p1$/);
    expect(partsOf(r.rec, r.key).some((p) => p.term === 'from there: aim')).toBe(true);
    expect(partsOf(r.rec, r.key).some((p) => p.term === OA_DROP)).toBe(false);
  });

  it('P(drop) reads the real reactors, strongest first, each once: the +8 brute hits AC 14 on 6-20 (0.75) for 8+; a second and third add the two imps 15 ft off, a fourth and fifth the two 20 ft off, their damage summed; a sixth (no sixth reactor) adds nothing; temp HP counts', () => {
    const w = scene(UNITS);
    const me = w.u('pc');
    me.hp = 6;
    w.begin(me);
    w.decide(me);
    const d = w.ds[me.idx]!;
    expect(d.oaDropP(w.cx.st, me, 1)).toBeCloseTo(0.75, 12);
    // The imp: +5 hits on 9-20 (0.55 plain, 0.05 crit); 1d8 + 3 >= 6 on 3-8 (6/8), 2d8 + 3 >= 6 on 63/64.
    const two = 1 - 0.25 * (1 - (0.55 * 0.75 + (0.05 * 63) / 64));
    expect(d.oaDropP(w.cx.st, me, 2)).toBeCloseTo(two, 12);
    // Three: up only if the brute misses (0.25) and the imps total under 6: both miss (0.4 x 0.4), or one
    // lands 4-5 (a plain hit, 2/8) or 5 (a crit, 2d8 = 2: 1/64) and the other misses; any two hits make 8+.
    const three = 1 - 0.25 * (0.4 * 0.4 + 2 * 0.4 * (0.55 * (2 / 8) + 0.05 / 64));
    expect(d.oaDropP(w.cx.st, me, 3)).toBeCloseTo(three, 12);
    // Four and five: the other two imps are 20 ft off, inside 5 ft of reach plus my 30 ft of movement
    // (the review fix: the old 15-ft pool left them out); up only if the brute misses and the imps
    // total under 6 (all miss, or one lands 4-5 and the rest miss). A sixth (no sixth reactor) adds nothing.
    const one = 0.55 * (2 / 8) + 0.05 / 64;
    expect(d.oaDropP(w.cx.st, me, 4)).toBeCloseTo(1 - 0.25 * (0.4 ** 3 + 3 * 0.4 ** 2 * one), 12);
    const five = 1 - 0.25 * (0.4 ** 4 + 4 * 0.4 ** 3 * one);
    expect(d.oaDropP(w.cx.st, me, 5)).toBeCloseTo(five, 12);
    expect(d.oaDropP(w.cx.st, me, 6)).toBeCloseTo(five, 12);
    // 6 HP + 12 temp HP: down at 18 or more: a plain hit (2d6 + 6) on 12 only, 1/36; a crit (4d6 + 6) on 4d6 >= 12, 986/1296.
    me.tempHp = 12;
    w.begin(me);
    w.decide(me);
    expect(d.oaDropP(w.cx.st, me, 1)).toBeCloseTo(0.7 * (1 / 36) + 0.05 * (986 / 1296), 12);
  });
});

const PC_AT = (at: string, use = 'test:oad-fighter'): U => ({ seat: 'pc', team: 'party', use, at });
const FOE = (seat: string, use: string, at: string): U => ({ seat, team: 'enemies', use: `test:${use}`, at });
type Scene = ReturnType<typeof scene>;
const decideAt = (w: Scene, hp: number) => {
  const me = w.u('pc');
  me.hp = hp;
  w.begin(me);
  return w.decide(me);
};

describe('greedy v8 review fixes: who reacts', () => {
  it('a reactor farther than 15 ft that my walk can pass counts: a 6-HP PC 20 ft from the +8 brute (any hit drops it) reads P(drop) 0.75, not 0', () => {
    // The old pool was moveCost's (15 ft): move:H5 provokes the brute at F5 and was priced P(drop) 0.
    const w = scene([PC_AT('B5', 'test:oad-pc'), FOE('brute', 'oad-brute', 'F5'), FOE('i1', 'oad-imp', 'O8')]);
    const me = w.u('pc');
    me.hp = 6;
    w.begin(me);
    const r = w.decide(me);
    expect(r.keys.some((k) => /\/p1$/.test(k))).toBe(true);
    expect(w.ds[me.idx]!.oaDropP(w.cx.st, me, 1)).toBeCloseTo(0.75, 12);
  });

  it('a reactor beyond its reach plus my movement left is not in the pool', () => {
    const w = scene([PC_AT('B5', 'test:oad-pc'), FOE('brute', 'oad-brute', 'I5'), FOE('i1', 'oad-imp', 'O8')]);
    const me = w.u('pc');
    me.hp = 6;
    w.begin(me);
    w.decide(me);
    // 35 ft off: 5 ft of reach + 30 ft of movement reaches it exactly; 40 ft does not.
    expect(w.ds[me.idx]!.oaDropP(w.cx.st, me, 1)).toBeCloseTo(0.75, 12);
    const w2 = scene([PC_AT('B5', 'test:oad-pc'), FOE('brute', 'oad-brute', 'J5'), FOE('i1', 'oad-imp', 'O8')]);
    const me2 = w2.u('pc');
    me2.hp = 6;
    w2.begin(me2);
    w2.decide(me2);
    expect(w2.ds[me2.idx]!.oaDropP(w2.cx.st, me2, 1)).toBe(0);
  });

  it("a reactor's attack is one it can make now: a Maul held with a Shield in the other hand can't swing, so its opportunity attack is the Unarmed Strike (5), which can't drop a 6-HP mover", () => {
    const w = scene([{ seat: 'kn', team: 'party', use: 'test:oad-knight', at: 'E5' }, FOE('brute', 'oad-brute', 'F5')]);
    const me = w.u('brute');
    me.hp = 6;
    w.begin(me);
    w.decide(me);
    expect(w.ds[me.idx]!.oaDropP(w.cx.st, me, 1)).toBe(0);
  });

  it("a reactor's critical range counts (critMinOf): the brute critting on 19-20 against 6 HP + 12 temp HP", () => {
    const w = scene(UNITS);
    const me = w.u('pc');
    me.hp = 6;
    me.tempHp = 12;
    (w.u('brute') as { stats: readonly BearerStat[] }).stats = [{ s: { k: 'critMin', n: 19 }, fx: -1 }];
    w.begin(me);
    w.decide(me);
    // AC 14, +8: hits on 6-20 (0.75), crits on 19-20 (0.10). Down at 18: 2d6 + 6 on 12 only, 4d6 + 6 on 4d6 >= 12.
    expect(w.ds[me.idx]!.oaDropP(w.cx.st, me, 1)).toBeCloseTo(0.65 * (1 / 36) + 0.1 * (986 / 1296), 12);
  });

  it('the k strongest are ranked by damage after my defenses: resisting bludgeoning, the slashing blade (2d4 + 4) outranks the brute (2d6 + 6, halved)', () => {
    const w = scene([PC_AT('E5', 'test:oad-pc'), FOE('brute', 'oad-brute', 'D5'), FOE('bl', 'oad-blade', 'F5')]);
    const me = w.u('pc');
    me.hp = 7;
    (me as { stats: readonly BearerStat[] }).stats = [{ s: { k: 'resist', mask: damageBit(DAMAGE_TYPES.indexOf('bludgeoning')) }, fx: -1 }];
    w.begin(me);
    w.decide(me);
    // The blade alone: a plain hit (0.70) drops 7 HP on 2d4 >= 3 (15/16), a crit (4d4 + 4) always.
    expect(w.ds[me.idx]!.oaDropP(w.cx.st, me, 1)).toBeCloseTo(0.7 * (15 / 16) + 0.05, 12);
  });
});

describe('greedy v8 review fixes: each follow-up site is discounted (a 6-HP PC whose provoking move faces a +8 hit that drops it, against the same PC at 44 HP)', () => {
  it('strike after a move: at 44 HP it walks past the golem (immune to its sword) to cut down the near-harmless prize; at 6 HP it takes the action Disengage instead', () => {
    const units = [PC_AT('C5'), FOE('g', 'oad-golem', 'B5'), FOE('f', 'oad-prize', 'G5')];
    const full = decideAt(scene(units), 44);
    expect(full.key).toMatch(/^move:F[456]\/p1$/);
    expect(partsOf(full.rec, full.key).some((p) => p.term.startsWith('1 strike(s) from there'))).toBe(true);
    const low = decideAt(scene(units), 6);
    expect(low.key).toBe('opt:disengage');
  });

  it('a bonus-action Disengage first reads the move-and-strike undiscounted: at 6 HP it Slips Away, valued at the strike from there with no opportunity attack', () => {
    const units = [PC_AT('C5'), FOE('g', 'oad-golem', 'B5'), FOE('f', 'oad-prize', 'G5')];
    const r = decideAt(scene(units, { fighter: { feats: ['test:oad-slip'] } }), 6);
    expect(r.key).toBe('use:oad-slip');
    const freed = partsOf(r.rec, r.key).find((p) => p.term.startsWith('the move it frees'))!;
    // The strike from F4-F6 less the walk's feet and the exposure there, with no 1 - P(drop) on it.
    expect(freed.ev).toBeGreaterThan(3);
  });

  it("next turn's strike from an approach square: at 44 HP it walks off toward the frail foes under the golem's attack; at 6 HP it takes the action Disengage", () => {
    const units = [PC_AT('C5'), FOE('g', 'oad-golem', 'B5'), FOE('f1', 'oad-frail', 'L5'), FOE('f2', 'oad-frail', 'L4')];
    const full = decideAt(scene(units), 44);
    expect(full.key).toMatch(/^move:.*\/p1$/);
    expect(partsOf(full.rec, full.key).some((p) => p.term.startsWith('next turn: the best strike'))).toBe(true);
    const low = decideAt(scene(units), 6);
    expect(low.key).toBe('opt:disengage');
    const mv = low.rec.top.find((t) => /^move:.*\/p1$/.test(t.key));
    if (mv) expect(partsOf(low.rec, mv.key).some((p) => p.term === OA_DROP)).toBe(true);
  });

  it('a Dash for a strike next turn: at 44 HP it Dashes toward the far frail foes; at 6 HP it takes the action Disengage', () => {
    const units = [PC_AT('C5'), FOE('g', 'oad-golem', 'B5'), FOE('f1', 'oad-frail', 'R5'), FOE('f2', 'oad-frail', 'R4')];
    expect(decideAt(scene(units, { gw: 24 }), 44).key).toBe('opt:dash');
    const low = decideAt(scene(units, { gw: 24 }), 6);
    expect(low.key).toBe('opt:disengage');
    expect(partsOf(low.rec, 'opt:dash').some((p) => p.term === OA_DROP)).toBe(true);
  });

  it('a heal after a walk (rescue now): at 44 HP it walks under the attack to Cure the downed ally; at 2 HP it Cures itself where it stands', () => {
    const units: U[] = [PC_AT('C5'), FOE('g', 'oad-golem', 'B5'), { seat: 'ally', team: 'party', use: 'test:oad-pc', at: 'G5' }];
    const mk = () => {
      const w = scene(units, { fighter: { cure: true } });
      Object.assign(w.u('ally'), { hp: 0, life: 'down' });
      return w;
    };
    const full = decideAt(mk(), 44);
    expect(full.key).toMatch(/^move:F[456]\/p1$/);
    expect(partsOf(full.rec, full.key).some((p) => p.term.startsWith('rescue this turn'))).toBe(true);
    const low = decideAt(mk(), 2);
    expect(low.key).toMatch(/^cast:cure-wounds/);
    const walk = low.rec.top.find((t) => partsOf(low.rec, t.key).some((p) => p.term.startsWith('rescue this turn')));
    if (walk) expect(partsOf(low.rec, walk.key).some((p) => p.term === OA_DROP)).toBe(true);
  });
});

describe('greedy v8 review fix: the action Disengage that only escapes goes stale (the kite loop)', () => {
  // Coverage step 7 follow-up: at 2 HP a Druid took the action Disengage and walked off every turn,
  // the Berserker Dashed after it, and neither dealt damage until the round cap. After
  // dodgeStaleAfter turns with no HP change on either side, the escape decays like a stale Dodge.
  const units = [PC_AT('C5'), FOE('g', 'oad-golem', 'B5'), FOE('f1', 'oad-frail', 'L5'), FOE('f2', 'oad-frail', 'L4')];
  const quietFor = (n: number) => {
    const w = scene(units);
    const me = w.u('pc');
    me.quietTurns = n;
    me.hpSeen = w.cx.st.hpTick;
    return decideAt(w, 6);
  };
  it('one quiet turn: the 6-HP PC still Disengages', () => {
    expect(quietFor(1).key).toBe('opt:disengage');
  });
  it('three quiet turns: the escape has decayed to a quarter, and it no longer takes the action Disengage', () => {
    const r = quietFor(3);
    expect(r.key).not.toBe('opt:disengage');
    const d = r.rec.top.find((t) => t.key === 'opt:disengage');
    if (d) expect(partsOf(r.rec, d.key).some((p) => p.term.startsWith('no progress: turns running'))).toBe(true);
  });
});

describe('afterDrop: only a gain is discounted', () => {
  it('a gain times 1 - P; a negative or zero follow-up kept whole, so a likelier drop never scores a move higher', () => {
    expect(afterDrop(10, 0.75)).toBeCloseTo(2.5, 12);
    expect(dropLoss(10, 0.75)).toBeCloseTo(7.5, 12);
    expect(afterDrop(-8, 0.75)).toBe(-8);
    expect(afterDrop(-8, 0.9)).toBe(afterDrop(-8, 0.1));
    expect(dropLoss(-8, 0.75)).toBe(0);
    expect(afterDrop(0, 0.5)).toBe(0);
    expect(afterDrop(10, 0)).toBe(10);
  });
});

describe('oaDropChance, pinned by hand', () => {
  it('one strike: P(hit, no crit) x P(2d6 + 6 >= 18) + P(crit) x P(4d6 + 6 >= 18) = 0.70 x 1/36 + 0.05 x 986/1296', () => {
    const hit = shift(convolve(die(6), die(6)), 6);
    const crit = shift(convolve(convolve(die(6), die(6)), convolve(die(6), die(6))), 6);
    expect(oaDropChance([{ pHit: 0.75, pCrit: 0.05, hit, crit }], 18)).toBeCloseTo(0.7 / 36 + (0.05 * 986) / 1296, 12);
  });
  it('two strikes of 5 at P(hit) 0.5: 10 HP needs both (0.25), 5 HP either (0.75); no strikes 0; already at 0 HP 1', () => {
    const s = { pHit: 0.5, pCrit: 0, hit: C(5), crit: C(5) };
    expect(oaDropChance([s, s], 10)).toBeCloseTo(0.25, 12);
    expect(oaDropChance([s, s], 5)).toBeCloseTo(0.75, 12);
    expect(oaDropChance([], 5)).toBe(0);
    expect(oaDropChance([s], 0)).toBe(1);
  });
});
