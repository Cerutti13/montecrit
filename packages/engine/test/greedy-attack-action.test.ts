// Greedy v13 (docs/design/stepE-plan.md 5, G1a and G1b): with step E's plain Attack action (E1) a
// Multiattack monster's alternatives differ in size and in the attacks they hold, so greedy counts each
// attack's own strikes and takes later strikes only from attacks that share its alternative.
// G1a: a strike counts the strikes of the largest live alternative that holds it (strikesFor), at every
// site that multiplies by a strike count (attack items, destinations, Dash, one more action, the cast
// margin, the loadout switch, strikesAfter).
// G1b: a routine is s(ai) + (strikesFor(ai) - 1) x the best strike over attacks that still fit an
// alternative of that size after it; a destination's value is the best of those over attacks.
// Content is synthetic (test: ids) with the plain Attack action appended through helpers/build.ts's
// opt-in `plainAttack`, as compileMonster now does (E1); the stand-ins mirror the SRD shapes the plan
// names (the Gladiator, the Ghoul, the Warrior Veteran) without naming their numbers.
import { describe, expect, it } from 'vitest';
import type { DecisionPoint, UnitView } from '../src/decide/decider.ts';
import { GreedyDecider, type ExplainRecord } from '../src/decide/greedy/greedy.ts';
import { GREEDY_VERSION } from '../src/decide/greedy/weights.ts';
import { resolveOption } from '../src/sim/act.ts';
import { copyLegal, legalKey, newLegal, releaseList, takeList } from '../src/sim/context.ts';
import { createContext } from '../src/sim/fight.ts';
import { listOptions } from '../src/sim/options.ts';
import { COND, type QueryState, type Unit } from '../src/sim/state.ts';
import { FIGHTER, setup, template, type TplSpec, type UnitSpec } from './helpers/build.ts';

/** The decider internals these tests read (TypeScript-private only). */
interface Peek {
  curAi: number;
  tc: { hereCost: number; strikes: Int8Array } | null;
  strike(view: UnitView, me: Unit, ai: number, t: Unit, from: number): number;
  bestStrike(view: UnitView, me: Unit, from: number): [number, number, number];
  dashValue(st: QueryState, me: Unit): number;
  extraActionValue(st: QueryState, me: Unit): number;
  endCost(st: QueryState, me: Unit, cell: number): number;
  strikesAfter(me: Unit): number;
  strikePlan(me: Unit, fresh?: boolean): { n: Int8Array; later: readonly (Uint8Array | null)[]; masked: boolean };
  routine(st: QueryState, u: Unit, ac: number): { melee: number; ranged: number; reachFt: number; rangeFt: number };
  foeRoutine(st: QueryState, u: Unit, d: Unit, ac: number): { melee: number; ranged: number; reachFt: number; rangeFt: number };
  attackEV(st: QueryState, atk: Unit['tpl']['attacks'][number], ac: number): number;
  upInReach(st: QueryState, me: Unit): boolean;
}
const peek = (d: GreedyDecider) => d as unknown as Peek;

function scene(units: UnitSpec[], over: { w?: number; h?: number } = {}) {
  const s = setup({ w: over.w ?? 20, h: over.h ?? 5, units });
  const ds = s.seats.map(() => new GreedyDecider());
  const cx = createContext(s, 1, 0, ds, null);
  const records: ExplainRecord[] = [];
  for (const d of ds) d.explainTo((r) => records.push(r));
  const u = (seat: string): Unit => cx.st.units.find((x) => x.seat === seat)!;
  const dOf = (who: Unit) => ds[who.idx]!;
  const view = (who: Unit) => cx.views[who.idx]!;
  const begin = (who: Unit) => {
    cx.st.active = who.idx;
    cx.st.turnIdx++;
    who.turns++;
    Object.assign(who.b, { action: 1, bonus: 1, reaction: 1, freeObj: 1, moveFt: who.tpl.speedFt, atkActive: false });
  };
  /** The turn choice's key, its explain record and the legal keys it chose among; resolves it when `act`. */
  const decide = (who: Unit, act = false): { key: string; rec: ExplainRecord; legal: string[] } => {
    const list = listOptions(cx, who, takeList(cx));
    const legal: string[] = [];
    for (let i = 0; i < list.n; i++) legal.push(legalKey(cx.st, who.idx, list.items[i]!));
    const dp: DecisionPoint = { k: 'turn', who: who.idx, at: 0, round: 1, cause: -1, legal: list, keyOf: (i) => legalKey(cx.st, who.idx, list.items[i]!) };
    records.length = 0;
    const i = dOf(who).decide(cx.views[who.idx]!, dp);
    const key = dp.keyOf(i);
    const chosen = copyLegal(list.items[i]!, newLegal());
    releaseList(cx, list);
    if (act) resolveOption(cx, who, chosen, -1);
    return { key, rec: records[records.length - 1]!, legal };
  };
  return { cx, u, begin, decide, dOf, view };
}

const ai = (who: Unit, local: string) => who.tpl.attacks.findIndex((a) => a.local === local);
/** The explain row of legal key `key` (it must be among the top three). */
const row = (rec: ExplainRecord, key: string) => {
  const r = rec.top.find((t) => t.key === key);
  expect(r, `${key} among the top three: ${rec.top.map((t) => t.key).join(', ')}`).toBeDefined();
  return r!;
};
const part = (r: { parts: readonly { term: string; ev: number }[] }, re: RegExp) => {
  const p = r.parts.filter((x) => re.test(x.term));
  expect(p.length, `one part matching ${re}: ${r.parts.map((x) => x.term).join(' | ')}`).toBe(1);
  return p[0]!;
};
const allTerms = (rec: ExplainRecord) => rec.top.flatMap((t) => t.parts.map((p) => p.term));

/** A Gladiator stand-in: Spear (melee) and the same Spear thrown, from 3 counted Spears; Multiattack 3 x spear; the plain Attack action (E1). */
const GLAD_SPEC: TplSpec = {
  id: 'glad-e1', ac: 16, hp: 112, str: 18, speed: 30,
  attacks: [
    { local: 'spear', toHit: 7, damage: [['2d6+4', 'piercing']], gear: 0 },
    { local: 'spear-thrown', kind: 'ranged', toHit: 7, range: [20, 60], damage: [['2d6+4', 'piercing']], gear: 0, consumesGear: true },
  ],
  multi: [[[3, ['spear', 'spear-thrown']]]],
  gear: [{ name: 'Spears', count: 3 }],
  plainAttack: true,
};
const GLAD = template(GLAD_SPEC);
/** The same block before E1 (HEAD's shape: one alternative of one group). */
const GLAD_HEAD = template({ ...GLAD_SPEC, id: 'glad-head', plainAttack: undefined });
/** A Ghoul stand-in: Multiattack 2 x bite; the claw is outside every Multiattack line, so only the plain Attack action holds it. */
const ghoul = (claw: string) =>
  template({
    id: `ghoul-${claw}`, ac: 12, hp: 60, str: 14, speed: 30,
    attacks: [
      { local: 'bite', toHit: 4, damage: [['1d6+2', 'piercing']] },
      { local: 'claw', toHit: 4, damage: [[claw, 'slashing']] },
    ],
    multi: [[[2, ['bite']]]],
    plainAttack: true,
  });
/** A Warrior Veteran stand-in: 2 x greatsword or 2 x heavy crossbow (disjoint alternatives), at HEAD's shape (no plain Attack action) unless `plain`. */
const veteran = (plain: boolean) =>
  template({
    id: plain ? 'veteran-e1' : 'veteran-head', ac: 17, hp: 65, str: 16, dex: 13, speed: 30,
    attacks: [
      { local: 'greatsword', toHit: 5, damage: [['2d6+3', 'slashing']] },
      { local: 'crossbow', kind: 'ranged', toHit: 5, range: [100, 400], damage: [['4d10+5', 'piercing']] },
    ],
    multi: [[[2, ['greatsword']]], [[2, ['crossbow']]]],
    ...(plain ? { plainAttack: true as const } : {}),
  });
const TANK = { ...FIGHTER, hpMax: 500 };
/** A PC that barely hits back, so a monster's end cost beside it stays small. */
const DUMMY = template({ id: 'dummy-pc', kind: 'pc', ac: 10, hp: 500, attacks: [{ local: 'stick', toHit: 0, damage: [['1', 'bludgeoning']] }] });

describe('greedy v13 G1a: a strike counts its own alternative\'s strikes', () => {
  it('GREEDY_VERSION is 13', () => {
    expect(GREEDY_VERSION).toBe(13);
  });

  it('a strike counts the strikes of the largest live alternative that holds it: a disarmed Gladiator\'s punch scores one strike, not three', () => {
    const sc = scene([{ seat: 'glad', team: 1, tpl: GLAD, at: 'B3' }, { seat: 'pc', team: 0, tpl: TANK, at: 'C3' }]);
    const g = sc.u('glad');
    const pc = sc.u('pc');
    sc.begin(g);
    // Armed: the Spear routine is 3 strikes, and the punch (only the plain Attack action holds it) one.
    const armed = sc.decide(g);
    expect([...peek(sc.dOf(g)).strikePlan(g).n]).toEqual([3, 3, 1]);
    expect(part(row(armed.rec, 'attack:spear>pc'), /more strike\(s\)$/).term).toBe('2 more strike(s)');
    // Disarmed: the punch is the only strike, valued as one.
    g.gear[0] = 0;
    const bare = sc.decide(g);
    expect(bare.legal).toContain('attack:unarmed-strike>pc');
    const r = row(bare.rec, 'attack:unarmed-strike>pc');
    const s1 = peek(sc.dOf(g)).strike(sc.view(g), g, ai(g, 'unarmed-strike'), pc, g.cell);
    expect(part(r, /^this strike$/).ev).toBe(s1);
    expect(part(r, /more strike\(s\)$/)).toEqual({ term: '0 more strike(s)', ev: 0 });
  });

  it('a disarmed Gladiator next to a PC punches instead of Dashing and passing', () => {
    const sc = scene([{ seat: 'glad', team: 1, tpl: GLAD, at: 'B3' }, { seat: 'pc', team: 0, tpl: TANK, at: 'C3' }]);
    const g = sc.u('glad');
    g.gear[0] = 0;
    sc.begin(g);
    const r = sc.decide(g);
    expect(r.key).toBe('attack:unarmed-strike>pc');
    expect(r.rec.chosen).toBe('attack:unarmed-strike>pc');
    expect(r.rec.top[0]!.key).toBe('attack:unarmed-strike>pc');
    expect(r.rec.top[0]!.parts.map((p) => p.term)).toEqual(['this strike', '0 more strike(s)', 'exposure here']);
  });

  it('"N strike(s) from there" names the valued attack\'s count', () => {
    // 10 ft off: the punch needs a step; the thrown Spear needs none, so give the Gladiator no Spears to show the punch's count.
    const sc = scene([{ seat: 'glad', team: 1, tpl: GLAD, at: 'B3' }, { seat: 'pc', team: 0, tpl: TANK, at: 'D3' }]);
    const g = sc.u('glad');
    g.gear[0] = 0;
    sc.begin(g);
    const bare = sc.decide(g);
    const fromThere = allTerms(bare.rec).filter((t) => /strike\(s\) from there/.test(t));
    expect(fromThere.length).toBeGreaterThan(0);
    for (const t of fromThere) expect(t).toBe('1 strike(s) from there');
    // Armed, the destinations count the Spear routine's 3.
    g.gear[0] = 3;
    const armed = sc.decide(g);
    const armedThere = allTerms(armed.rec).filter((t) => /strike\(s\) from there/.test(t));
    expect(armedThere.length).toBeGreaterThan(0);
    for (const t of armedThere) expect(t).toBe('3 strike(s) from there');
  });

  it('a far-off disarmed Gladiator\'s Dash is worth one punch (dashValue)', () => {
    const sc = scene([{ seat: 'glad', team: 1, tpl: GLAD, at: 'B3' }, { seat: 'pc', team: 0, tpl: DUMMY, at: 'J3' }]);
    const g = sc.u('glad');
    const pc = sc.u('pc');
    g.gear[0] = 0;
    sc.begin(g);
    expect(sc.cx.views[0]!.queries.distFt(g.cell, pc.cell)).toBe(40); // beyond Speed + 5 ft, within twice the Speed + 5 ft
    const r = sc.decide(g);
    expect(r.key).toBe('opt:dash');
    const p = peek(sc.dOf(g));
    const punch = ai(g, 'unarmed-strike');
    expect(p.tc!.strikes[punch]).toBe(1);
    const one = p.strike(sc.view(g), g, punch, pc, g.cell) - (p.endCost(sc.cx.st, g, pc.cell) - p.tc!.hereCost);
    expect(one).toBeGreaterThan(0);
    expect(p.dashValue(sc.cx.st, g)).toBe(one);
  });

  it('one more action (extraActionValue) counts a fresh action\'s strikes per attack: a disarmed Gladiator\'s is one punch', () => {
    const sc = scene([{ seat: 'glad', team: 1, tpl: GLAD, at: 'A1' }, { seat: 'pc', team: 0, tpl: DUMMY, at: 'B1' }], { w: 2, h: 1 });
    const g = sc.u('glad');
    const pc = sc.u('pc');
    g.gear[0] = 0;
    sc.begin(g);
    sc.decide(g);
    const p = peek(sc.dOf(g));
    const punch = p.strike(sc.view(g), g, ai(g, 'unarmed-strike'), pc, g.cell);
    expect(punch).toBeGreaterThan(0);
    expect(p.extraActionValue(sc.cx.st, g)).toBe(punch);
    // Armed: the Spear routine's three strikes.
    g.gear[0] = 3;
    sc.decide(g);
    const spear = p.strike(sc.view(g), g, ai(g, 'spear'), pc, g.cell);
    expect(p.extraActionValue(sc.cx.st, g)).toBeCloseTo(3 * spear, 9);
  });

  it('strikesAfter counts the valued attack\'s alternative', () => {
    const sc = scene([{ seat: 'glad', team: 1, tpl: GLAD, at: 'B3' }, { seat: 'pc', team: 0, tpl: TANK, at: 'C3' }]);
    const g = sc.u('glad');
    sc.begin(g);
    sc.decide(g);
    const p = peek(sc.dOf(g));
    p.curAi = ai(g, 'spear');
    expect(p.strikesAfter(g)).toBe(2);
    p.curAi = ai(g, 'unarmed-strike');
    expect(p.strikesAfter(g)).toBe(0);
    p.curAi = -1;
    expect(p.strikesAfter(g)).toBe(2); // no attack being valued: the largest live alternative, as v12
  });

  it('a monster whose alternatives are all one size and one attack set is valued exactly as under v12', () => {
    const sc = scene([{ seat: 'glad', team: 1, tpl: GLAD_HEAD, at: 'B3' }, { seat: 'pc', team: 0, tpl: TANK, at: 'C3' }]);
    const g = sc.u('glad');
    sc.begin(g);
    const r = sc.decide(g);
    const p = peek(sc.dOf(g));
    const plan = p.strikePlan(g);
    expect(plan.masked).toBe(false);
    expect([...plan.n]).toEqual([3, 3, 3]); // the injected Unarmed Strike no alternative holds keeps v12's count
    expect(plan.later.every((x) => x === null)).toBe(true);
    // v12's formula: this strike + 2 x the best strike from here.
    const here = p.bestStrike(sc.view(g), g, g.cell)[0];
    const sp = row(r.rec, 'attack:spear>pc');
    expect(part(sp, /more strike\(s\)$/)).toEqual({ term: '2 more strike(s)', ev: 2 * here });
    // Two alternatives with one size and one attack set read as v12 too.
    const same = template({
      id: 'same-set', ac: 13, hp: 60, str: 16,
      attacks: [{ local: 'claw', toHit: 5, damage: [['1d6+3', 'slashing']] }, { local: 'bite', toHit: 5, damage: [['1d8+3', 'piercing']] }],
      multi: [[[2, ['claw', 'bite']]], [[1, ['bite']], [1, ['claw', 'bite']]]],
    });
    const sc2 = scene([{ seat: 'm', team: 1, tpl: same, at: 'B3' }, { seat: 'pc', team: 0, tpl: TANK, at: 'C3' }]);
    sc2.begin(sc2.u('m'));
    sc2.decide(sc2.u('m'));
    expect(peek(sc2.dOf(sc2.u('m'))).strikePlan(sc2.u('m')).masked).toBe(false);
  });
});

describe('greedy v13 G1b: later strikes come only from attacks that fit the same alternative', () => {
  it('a Ghoul whose Claw out-values a Bite values the Bite routine as Bite x2, and the Claw as one strike', () => {
    // A two-square corridor: no move to score, so both attacks are among the top three.
    const sc = scene([{ seat: 'ghoul', team: 1, tpl: ghoul('2d6+5'), at: 'A1' }, { seat: 'pc', team: 0, tpl: DUMMY, at: 'B1' }], { w: 2, h: 1 });
    const m = sc.u('ghoul');
    const pc = sc.u('pc');
    sc.begin(m);
    const r = sc.decide(m);
    const p = peek(sc.dOf(m));
    const bite = p.strike(sc.view(m), m, ai(m, 'bite'), pc, m.cell);
    const claw = p.strike(sc.view(m), m, ai(m, 'claw'), pc, m.cell);
    expect(claw).toBeGreaterThan(bite);
    expect(claw).toBeGreaterThan(2 * bite); // so the claw is the honest pick
    expect(part(row(r.rec, 'attack:bite>pc'), /more strike\(s\)$/)).toEqual({ term: '1 more strike(s)', ev: bite });
    expect(part(row(r.rec, 'attack:claw>pc'), /more strike\(s\)$/)).toEqual({ term: '0 more strike(s)', ev: 0 });
    expect(r.key).toBe('attack:claw>pc');
  });

  it('a destination\'s value is the best routine over attacks: a Ghoul one step off values Bite x2 over one Claw', () => {
    // A weaker claw: one Claw (about 8.5) is worth less than two Bites (about 11), though it out-values one Bite.
    // A corridor: the one square in reach is B1 (cell 1).
    const sc = scene([{ seat: 'ghoul', team: 1, tpl: ghoul('1d6+5'), at: 'A1' }, { seat: 'pc', team: 0, tpl: DUMMY, at: 'C1' }], { w: 4, h: 1 });
    const m = sc.u('ghoul');
    const pc = sc.u('pc');
    sc.begin(m);
    const r = sc.decide(m);
    expect(r.key).toMatch(/^move:B1\//);
    const to = 1;
    const p = peek(sc.dOf(m));
    const bite = p.strike(sc.view(m), m, ai(m, 'bite'), pc, to);
    const claw = p.strike(sc.view(m), m, ai(m, 'claw'), pc, to);
    expect(claw).toBeGreaterThan(bite);
    expect(2 * bite).toBeGreaterThan(claw);
    const there = part(r.rec.top[0]!, /strike\(s\) from there$/);
    expect(there.term).toBe('2 strike(s) from there');
    expect(there.ev).toBe(bite + bite);
  });

  it('the same holds for a Veteran mixing Greatsword and Crossbow (HEAD\'s shape, and with the plain Attack action)', () => {
    for (const plain of [false, true]) {
      const sc = scene([{ seat: 'vet', team: 1, tpl: veteran(plain), at: 'A1' }, { seat: 'pc', team: 0, tpl: DUMMY, at: 'B1' }], { w: 2, h: 1 });
      const v = sc.u('vet');
      const pc = sc.u('pc');
      sc.begin(v);
      const r = sc.decide(v);
      const p = peek(sc.dOf(v));
      expect(p.strikePlan(v).masked).toBe(true);
      const gs = p.strike(sc.view(v), v, ai(v, 'greatsword'), pc, v.cell);
      const xb = p.strike(sc.view(v), v, ai(v, 'crossbow'), pc, v.cell);
      expect(xb).toBeGreaterThan(gs); // the crossbow out-values the greatsword even adjacent (Disadvantage)
      expect(part(row(r.rec, 'attack:greatsword>pc'), /more strike\(s\)$/)).toEqual({ term: '1 more strike(s)', ev: gs });
      expect(part(row(r.rec, 'attack:crossbow>pc'), /more strike\(s\)$/)).toEqual({ term: '1 more strike(s)', ev: xb });
      // The plan: each attack's later strikes are its own alternative's attack.
      const plan = p.strikePlan(v);
      const [g, c] = [ai(v, 'greatsword'), ai(v, 'crossbow')];
      expect(plan.later[g]![g]).toBe(1);
      expect(plan.later[g]![c]).toBe(0);
      expect(plan.later[c]![c]).toBe(1);
      expect(plan.later[c]![g]).toBe(0);
    }
  });

  it('mid-action, the later strikes follow the alternative already chosen; a fresh action reads them from the start', () => {
    const sc = scene([{ seat: 'vet', team: 1, tpl: veteran(true), at: 'B3' }, { seat: 'pc', team: 0, tpl: TANK, at: 'C3' }]);
    const v = sc.u('vet');
    sc.begin(v);
    sc.decide(v, false);
    const p = peek(sc.dOf(v));
    const [g, c, u] = [ai(v, 'greatsword'), ai(v, 'crossbow'), ai(v, 'unarmed-strike')];
    expect([p.strikePlan(v).n[g], p.strikePlan(v).n[c], p.strikePlan(v).n[u]]).toEqual([2, 2, 1]);
    // One greatsword made: only the greatsword alternative is live, with one strike left.
    v.b.atkActive = true;
    v.b.atkCounts[g] = 1;
    v.b.atkLive = 1 << 0;
    v.b.action = 0;
    sc.decide(v);
    const mid = p.strikePlan(v);
    expect(mid.n[g]).toBe(1);
    expect(mid.n[c]).toBe(1); // no live alternative holds it: v12's count (strikesLeft)
    const fresh = p.strikePlan(v, true);
    expect([fresh.n[g], fresh.n[c], fresh.n[u]]).toEqual([2, 2, 1]);
    expect(fresh.later[g]![c]).toBe(0);
  });
});

// Greedy v13's E2 term (stepE-plan 5, "E2 sites"): a monster's thrown piece lying on the ground is a
// strike only from its own square, where the strike's equip picks it up (srd-raw.txt:32707-32712,
// 43947-43953); pairs and upInReach admit gear it has none of while a piece is down; a monster on its
// piece threatens with it. Pieces are placed by hand here (u.landed): E's thrown-pickup.test.ts pins
// where the engine lands them.
describe('greedy v13 E2: picking thrown gear back up', () => {
  /** The cell `dx` squares right of `u` on the same row. */
  const right = (u: Unit, dx: number) => u.cell + dx;

  it('a disarmed Gladiator walks onto its free Spear\'s square when the Spear routine beats a punch, and says so', () => {
    // B3 Gladiator, E3 PC; its one thrown Spear lies on D3, beside the PC (the PC stepped off it).
    const sc = scene([{ seat: 'glad', team: 1, tpl: GLAD, at: 'B3' }, { seat: 'pc', team: 0, tpl: DUMMY, at: 'E3' }]);
    const g = sc.u('glad');
    const pc = sc.u('pc');
    g.gear[0] = 0;
    g.landed[0] = right(g, 2);
    sc.begin(g);
    const r = sc.decide(g);
    expect(r.key).toBe('move:D3/p0');
    const there = part(row(r.rec, 'move:D3/p0'), /strike\(s\) from there/);
    expect(there.term).toBe('3 strike(s) from there, picks up its Spear there');
    // Every other square beside the PC only has the punch.
    for (const t of allTerms(r.rec).filter((x) => /strike\(s\) from there/.test(x) && x !== there.term)) expect(t).toBe('1 strike(s) from there');
    // Walk there: the Spear is legal from that square, and greedy takes the Spear routine (this strike + 2 more).
    sc.decide(g, true);
    expect(g.cell).toBe(right(pc, -1));
    const s = sc.decide(g);
    expect(s.legal).toContain('attack:spear>pc');
    expect(s.key).toBe('attack:spear>pc');
    const spear = peek(sc.dOf(g)).strike(sc.view(g), g, ai(g, 'spear'), pc, g.cell);
    const more = part(row(s.rec, 'attack:spear>pc'), /more strike\(s\)$/);
    expect(more.term).toBe('2 more strike(s)');
    expect(more.ev).toBeCloseTo(2 * spear, 9);
  });

  it('a Gladiator on its Spear threatens with it; a piece elsewhere isn\'t counted (a written miss)', () => {
    const sc = scene([{ seat: 'glad', team: 1, tpl: GLAD, at: 'B3' }, { seat: 'pc', team: 0, tpl: DUMMY, at: 'C3' }]);
    const g = sc.u('glad');
    const pc = sc.u('pc');
    g.gear[0] = 0;
    sc.begin(g);
    sc.decide(g);
    const p = peek(sc.dOf(g));
    const ac = 10;
    const punch = p.attackEV(sc.cx.st, g.tpl.attacks[ai(g, 'unarmed-strike')]!, ac);
    const spear = p.attackEV(sc.cx.st, g.tpl.attacks[ai(g, 'spear')]!, ac);
    expect(spear).toBeGreaterThan(punch);
    // Nothing underfoot: the punch.
    expect(p.routine(sc.cx.st, g, ac).melee).toBeCloseTo(punch, 9);
    // Its Spear on the next square: still the punch.
    g.landed[0] = right(g, -1);
    sc.decide(g);
    expect(p.routine(sc.cx.st, g, ac).melee).toBeCloseTo(punch, 9);
    // Standing on it: the Spear routine.
    g.landed[0] = g.cell;
    sc.decide(g);
    expect(p.routine(sc.cx.st, g, ac).melee).toBeCloseTo(3 * spear, 9);
    // A what-if copy of it standing on the next square reads the punch (and isn't served the cached Spear).
    expect(p.routine(sc.cx.st, { ...g, cell: right(g, -1) }, ac).melee).toBeCloseTo(punch, 9);
    // Against a target whose condition sends it through routineX (Dodging: Disadvantage), the Spear too.
    pc.condMask |= COND.dodging;
    const vsDodger = p.foeRoutine(sc.cx.st, g, pc, pc.tpl.ac).melee;
    g.landed[0] = right(g, -1);
    sc.decide(g);
    expect(vsDodger).toBeGreaterThan(p.foeRoutine(sc.cx.st, g, pc, pc.tpl.ac).melee * 1.5);
    pc.condMask &= ~COND.dodging;
    g.landed[0] = g.cell;
    // As the PC sees it: the threat it ranks the Gladiator by.
    sc.begin(pc);
    sc.decide(pc);
    expect(peek(sc.dOf(pc)).routine(sc.cx.st, g, pc.tpl.ac).melee).toBeCloseTo(3 * p.attackEV(sc.cx.st, g.tpl.attacks[ai(g, 'spear')]!, pc.tpl.ac), 9);
  });

  it('a piece under a creature is no strike from where I stand: a far-off disarmed Gladiator still Dashes for one punch', () => {
    // The Spear landed under the PC it was thrown at (40 ft off; within the thrown Spear's long range).
    const sc = scene([{ seat: 'glad', team: 1, tpl: GLAD, at: 'B3' }, { seat: 'pc', team: 0, tpl: DUMMY, at: 'J3' }]);
    const g = sc.u('glad');
    const pc = sc.u('pc');
    g.gear[0] = 0;
    g.landed[0] = pc.cell;
    sc.begin(g);
    const r = sc.decide(g);
    expect(r.key).toBe('opt:dash');
    expect(allTerms(r.rec).some((t) => /strike\(s\) from there/.test(t))).toBe(false);
    const p = peek(sc.dOf(g));
    expect(p.bestStrike(sc.view(g), g, g.cell)[0]).toBe(0);
    const punch = ai(g, 'unarmed-strike');
    const one = p.strike(sc.view(g), g, punch, pc, g.cell) - (p.endCost(sc.cx.st, g, pc.cell) - p.tc!.hereCost);
    expect(p.dashValue(sc.cx.st, g)).toBe(one);
  });

  it('upInReach counts a piece within my move, from its square', () => {
    const sc = scene([{ seat: 'glad', team: 1, tpl: GLAD, at: 'B3' }, { seat: 'pc', team: 0, tpl: DUMMY, at: 'J3' }]);
    const g = sc.u('glad');
    g.gear[0] = 0;
    sc.begin(g);
    const p = peek(sc.dOf(g));
    // 40 ft: beyond the move plus a punch.
    expect(p.upInReach(sc.cx.st, g)).toBe(false);
    // A Spear 20 ft off, within the move, and the PC within the thrown Spear's range from it.
    g.landed[0] = right(g, 4);
    expect(p.upInReach(sc.cx.st, g)).toBe(true);
    // A Spear beyond the move.
    g.landed[0] = right(g, 17);
    expect(p.upInReach(sc.cx.st, g)).toBe(false);
  });

  it('a unit with nothing on the ground and nothing to pick up values exactly as before (no pickup, no new pair)', () => {
    const sc = scene([{ seat: 'glad', team: 1, tpl: GLAD, at: 'B3' }, { seat: 'pc', team: 0, tpl: DUMMY, at: 'C3' }]);
    const g = sc.u('glad');
    g.gear[0] = 0;
    sc.begin(g);
    const r = sc.decide(g);
    expect(r.legal).not.toContain('attack:spear>pc');
    expect(r.key).toBe('attack:unarmed-strike>pc');
    expect(allTerms(r.rec).some((t) => /picks up/.test(t))).toBe(false);
  });
});
