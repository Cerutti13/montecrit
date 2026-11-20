// Greedy v12 (docs/design/stalemate-plan.md 4.1 and 8): two general AI fixes that name no class.
// B: a strike counts only if some alternative of the unit's Attack action holds it (a static mask per
// template, read in buildPairs and upInReach), so a Multiattack monster with its thrown gear spent
// doesn't count its injected Unarmed Strike, which the legal list never offers.
// C: for a non-PC under attackDowned ifNoOtherTarget, a downed body in reach doesn't make it engaged
// while some hostile is up anywhere: it closes on (or Dashes toward) the standing one.
// Each case is a constructed state named for what it checks; content is synthetic (test: ids), except
// the PC-mask sweep, which reads every PC and character in the repo packs.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../src/content/load.ts';
import type { CompiledTemplate } from '../src/content/types.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import type { DecisionPoint, UnitView } from '../src/decide/decider.ts';
import { DOWNED_FREE_TERM, GreedyDecider, type ExplainRecord } from '../src/decide/greedy/greedy.ts';
import { resolveOption } from '../src/sim/act.ts';
import { copyLegal, legalKey, newLegal, releaseList, takeList } from '../src/sim/context.ts';
import { createContext } from '../src/sim/fight.ts';
import { listOptions } from '../src/sim/options.ts';
import type { FightSetup } from '../src/sim/setup.ts';
import { addCond, COND, type QueryState, type Unit } from '../src/sim/state.ts';
import { FIGHTER, setup, template, type UnitSpec } from './helpers/build.ts';

/** The decider internals these tests read (TypeScript-private only). */
interface Peek {
  pairAi: number[];
  pairT: number[];
  inAttackAct(tpl: CompiledTemplate): Uint8Array;
  upInReach(st: QueryState, me: Unit): boolean;
  bestStrike(view: UnitView, me: Unit, from: number): [number, number, number];
  tc: { engaged: boolean } | null;
}
const peek = (d: GreedyDecider) => d as unknown as Peek;

function scene(units: UnitSpec[], over: { w?: number; h?: number; knobs?: Partial<FightSetup['knobs']> } = {}) {
  const s = setup({ w: over.w ?? 20, h: over.h ?? 5, units, knobs: over.knobs });
  const ds = s.seats.map(() => new GreedyDecider());
  const cx = createContext(s, 1, 0, ds, null);
  const records: ExplainRecord[] = [];
  for (const d of ds) d.explainTo((r) => records.push(r));
  const u = (seat: string): Unit => cx.st.units.find((x) => x.seat === seat)!;
  const dOf = (who: Unit) => ds[who.idx]!;
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
  /** Resolves the legal option with key `key` for `who`. */
  const take = (who: Unit, key: string) => {
    const list = listOptions(cx, who, takeList(cx));
    let at = -1;
    for (let i = 0; i < list.n; i++) if (legalKey(cx.st, who.idx, list.items[i]!) === key) at = i;
    expect(at, `${key} is legal`).toBeGreaterThanOrEqual(0);
    const chosen = copyLegal(list.items[at]!, newLegal());
    releaseList(cx, list);
    resolveOption(cx, who, chosen, -1);
  };
  /** This decision's pairs as legal-style keys (attack local > target seat). */
  const pairs = (who: Unit) => {
    const p = peek(dOf(who));
    return p.pairAi.map((ai, k) => `attack:${who.tpl.attacks[ai]!.local}>${cx.st.units[p.pairT[k]!]!.seat}`);
  };
  return { cx, u, begin, decide, take, pairs, dOf };
}

/** Puts `pc` at 0 HP: down (death saves) or stable. */
function fell(pc: Unit, life: 'down' | 'stable' = 'stable') {
  pc.hp = 0;
  pc.life = life;
  addCond(pc, COND.unconscious, 'core:downed', -1, -1, { k: 'never' });
  addCond(pc, COND.incapacitated, 'core:downed', -1, -1, { k: 'never' });
}

const terms = (rec: ExplainRecord) => rec.top.flatMap((t) => t.parts.map((p) => p.term));

/** A Gladiator stand-in: Spear (melee) and the same Spear thrown, both from 3 counted Spears; Multiattack 3 x spear. */
const GLADIATOR = template({
  id: 'gladiator-standin', ac: 16, hp: 112, str: 18, speed: 30,
  attacks: [
    { local: 'spear', toHit: 7, damage: [['2d6+4', 'piercing']], gear: 0 },
    { local: 'spear-thrown', kind: 'ranged', toHit: 7, range: [20, 60], damage: [['2d6+4', 'piercing']], gear: 0, consumesGear: true },
  ],
  multi: [[[3, ['spear', 'spear-thrown']]]],
  gear: [{ name: 'Spears', count: 3 }],
});
/** Two alternatives: 2 x (claw or bite), or bite + tail (reach 10). */
const TWO_WAY = template({
  id: 'two-way', ac: 13, hp: 60, str: 16, speed: 30,
  attacks: [
    { local: 'claw', toHit: 5, damage: [['1d6+3', 'slashing']] },
    { local: 'bite', toHit: 5, damage: [['1d8+3', 'piercing']] },
    { local: 'tail', toHit: 5, reach: 10, damage: [['1d4+3', 'bludgeoning']] },
  ],
  multi: [[[2, ['claw', 'bite']]], [[1, ['bite']], [1, ['tail']]]],
});
const BRUTE = { ...FIGHTER, kind: 'monster' as const };
const TANK = { ...FIGHTER, hpMax: 500 };

describe('greedy v12 B: a strike counts only if the unit\'s Attack action can hold it', () => {
  it('a Multiattack monster with its thrown gear spent counts no strike its Multiattack can\'t hold', () => {
    const { u, begin, decide, pairs } = scene([{ seat: 'glad', team: 1, tpl: GLADIATOR, at: 'B3' }, { seat: 'pc', team: 0, tpl: TANK, at: 'C3' }]);
    const g = u('glad');
    begin(g);
    // Spears in hand: every pair is a strike the legal list offers.
    const armed = decide(g);
    expect(pairs(g).length).toBeGreaterThan(0);
    for (const k of pairs(g)) expect(armed.legal, k).toContain(k);
    // All three thrown: the legal list has no attack, and neither have greedy's pairs (no phantom Unarmed Strike).
    g.gear[0] = 0;
    const bare = decide(g);
    expect(bare.legal.filter((k) => k.startsWith('attack:'))).toEqual([]);
    expect(pairs(g)).toEqual([]);
    expect(terms(bare.rec).filter((t) => /strike\(s\) from there/.test(t))).toEqual([]);
    expect(bare.key).toBe('opt:dash'); // no attack it can make anywhere (this hand-built template has no plain Attack action; compiled ones do since step E)
  });

  it('mid-Multiattack, a destination\'s next-turn value still counts every attack some alternative holds', () => {
    const { u, cx, begin, decide, take, pairs, dOf } = scene([{ seat: 'm', team: 1, tpl: TWO_WAY, at: 'B3' }, { seat: 'pc', team: 0, tpl: TANK, at: 'C3' }]);
    const m = u('m');
    const pc = u('pc');
    begin(m);
    decide(m);
    const fresh = pairs(m);
    const from = pc.cell + 2; // E3: 10 ft from the PC, where only the tail reaches
    expect(cx.views[0]!.queries.distFt(from, pc.cell)).toBe(10);
    const freshV = peek(dOf(m)).bestStrike(cx.views[m.idx]!, m, from)[0];
    expect(freshV).toBeGreaterThan(0);
    // One claw: only the first alternative is still live this action, so the tail can't follow now,
    // but a fresh action next turn can make it: the pairs (which feed next-turn values) keep it.
    take(m, 'attack:claw>pc');
    expect(m.b.atkActive).toBe(true);
    decide(m);
    expect(pairs(m)).toEqual(fresh);
    expect(pairs(m)).toContain('attack:tail>pc');
    expect(peek(dOf(m)).bestStrike(cx.views[m.idx]!, m, from)[0]).toBe(freshV);
  });

  it('upInReach ignores an attack no alternative holds', () => {
    const { u, cx, begin, dOf } = scene([{ seat: 'glad', team: 1, tpl: GLADIATOR, at: 'B3' }, { seat: 'body', team: 0, tpl: FIGHTER, at: 'C3' }, { seat: 'pc', team: 0, tpl: TANK, at: 'H3' }]);
    const g = u('glad');
    fell(u('body'), 'down');
    begin(g);
    expect(cx.views[0]!.queries.distFt(g.cell, u('pc').cell)).toBe(30); // within Speed + 5 ft
    const p = peek(dOf(g));
    expect(p.upInReach(cx.st, g)).toBe(true); // Spears in hand
    g.gear[0] = 0;
    expect(p.upInReach(cx.st, g)).toBe(false); // only the Unarmed Strike would reach, and no alternative holds it
  });

  it('a PC\'s pairs are unchanged: every attack of every PC and character in the repo packs is in its mask', () => {
    const ROOT = join(import.meta.dirname, '..', '..', '..');
    const walk = (d: string): string[] =>
      readdirSync(d)
        .flatMap((n) => {
          const p = join(d, n);
          return statSync(p).isDirectory() ? walk(p) : p.endsWith('.yaml') ? [p] : [];
        })
        .sort();
    const files: SourceFile[] = ['srd-5.2.1', 'test'].flatMap((name) => walk(join(ROOT, 'packs', name)).map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, 'utf8') })));
    const r = loadContent(files);
    if (!r.content) throw new Error(r.errors.map(formatDiag).join('\n'));
    const d = peek(new GreedyDecider());
    const pcs = r.content.templates.filter((t) => t.kind === 'pc');
    expect(pcs.length).toBeGreaterThan(10);
    for (const t of pcs) expect([...d.inAttackAct(t)], t.id).toEqual(t.attacks.map(() => 1));
    // The real Gladiator (step E, E1): its Multiattack holds the Spear, not the injected Unarmed Strike;
    // the plain Attack action, appended last, holds every attack, so the mask is all 1s and B is vacuous
    // for compiled content (it stays as the guard for hand-built templates: the first test above).
    const glad = r.content.get('srd:gladiator')!;
    const alts = glad.attackAct.alts;
    const unarmedAt = glad.attacks.findIndex((a) => a.unarmed);
    expect(unarmedAt).toBeGreaterThanOrEqual(0);
    expect(alts.slice(0, -1).every((alt) => alt.every((g) => !g.from.includes(unarmedAt)))).toBe(true);
    expect(alts.at(-1)).toEqual([{ count: 1, from: glad.attacks.map((_, i) => i) }]);
    expect(glad.attacks.map((a, i) => `${a.local}:${d.inAttackAct(glad)[i]}`)).toEqual(glad.attacks.map((a) => `${a.local}:1`));
    // Every compiled Multiattack monster: the mask is all 1s.
    for (const t of r.content.templates.filter((x) => x.kind === 'monster' && x.attackAct.multi)) expect([...d.inAttackAct(t)], t.id).toEqual(t.attacks.map(() => 1));
    // And in a decision: a PC's Unarmed Strike is still one of its pairs.
    const { u, begin, decide, pairs } = scene([{ seat: 'pc', team: 0, tpl: FIGHTER, at: 'B3' }, { seat: 'brute', team: 1, tpl: BRUTE, at: 'C3' }]);
    begin(u('pc'));
    decide(u('pc'));
    expect(pairs(u('pc'))).toEqual(['attack:longsword>brute', 'attack:unarmed-strike>brute']);
  });
});

describe('greedy v12 C: a downed body doesn\'t hold a non-PC while a hostile is still up', () => {
  /** A monster with a stable PC adjacent and a standing fighter 40 ft away (beyond Speed + reach). */
  const held = (knob: FightSetup['knobs']['attackDowned']) => {
    const sc = scene([{ seat: 'brute', team: 1, tpl: BRUTE, at: 'B3' }, { seat: 'body', team: 0, tpl: FIGHTER, at: 'C3' }, { seat: 'fighter', team: 0, tpl: FIGHTER, at: 'J3' }], { knobs: { attackDowned: knob } });
    fell(sc.u('body'));
    sc.begin(sc.u('brute'));
    return sc;
  };

  it('a downed PC in reach doesn\'t stop a monster closing on a standing PC (ifNoOtherTarget)', () => {
    const sc = held('ifNoOtherTarget');
    const b = sc.u('brute');
    expect(sc.cx.views[0]!.queries.distFt(b.cell, sc.u('fighter').cell)).toBe(40);
    const r = sc.decide(b);
    expect(r.key).toBe('opt:dash');
    expect(r.rec.note).toBe(`nothing in reach even after moving: Dash first; ${DOWNED_FREE_TERM}`);
    expect(DOWNED_FREE_TERM).toBe("a downed body in reach doesn't hold me while a standing hostile is up (attackDowned ifNoOtherTarget)");
    // With the action spent, it walks toward the fighter (closing in), and says why.
    b.b.action = 0;
    const w = sc.decide(b);
    expect(w.key).toMatch(/^move:/);
    expect(w.rec.top[0]!.parts.map((p) => p.term)).toContain(DOWNED_FREE_TERM);
    sc.take(b, w.key);
    expect(sc.cx.views[0]!.queries.distFt(b.cell, sc.u('fighter').cell)).toBeLessThan(40);
  });

  it('with no hostile up anywhere, a downed PC in reach still holds the monster (ifNoOtherTarget)', () => {
    const sc = held('ifNoOtherTarget');
    fell(sc.u('fighter'), 'down');
    const r = sc.decide(sc.u('brute'));
    expect(r.key).toBe('attack:longsword>body');
    expect(r.rec.note).not.toContain(DOWNED_FREE_TERM);
  });

  it('under attackDowned: always, a downed PC in reach still holds the monster', () => {
    const sc = held('always');
    const r = sc.decide(sc.u('brute'));
    expect(r.key).toBe('attack:longsword>body');
    expect(r.rec.note).not.toContain(DOWNED_FREE_TERM);
  });

  it('under never, unchanged: the body isn\'t a target, so the monster Dashes with no C line', () => {
    const sc = held('never');
    const r = sc.decide(sc.u('brute'));
    expect(r.key).toBe('opt:dash');
    expect(r.rec.note).toBe('nothing in reach even after moving: Dash first');
  });

  it('a non-PC party ally closes on a standing foe past a downed one', () => {
    const sc = scene([{ seat: 'guard', team: 0, tpl: BRUTE, at: 'B3' }, { seat: 'foe-down', team: 1, tpl: FIGHTER, at: 'C3' }, { seat: 'foe', team: 1, tpl: BRUTE, at: 'J3' }]);
    fell(sc.u('foe-down'));
    const g = sc.u('guard');
    sc.begin(g);
    const r = sc.decide(g);
    expect(r.key).toBe('opt:dash');
    expect(r.rec.note).toContain(DOWNED_FREE_TERM);
  });

  it('C leaves PC decisions alone: the same state from a PC seat gives an unchanged choice', () => {
    const sc = scene([{ seat: 'pc', team: 0, tpl: FIGHTER, at: 'B3' }, { seat: 'foe-down', team: 1, tpl: FIGHTER, at: 'C3' }, { seat: 'foe', team: 1, tpl: BRUTE, at: 'J3' }]);
    fell(sc.u('foe-down'));
    const p = sc.u('pc');
    sc.begin(p);
    const r = sc.decide(p);
    // HEAD (greedy v11) chooses this too: the body engages the PC, so it strikes it.
    expect(r.key).toBe('attack:longsword>foe-down');
    expect(r.rec.note).not.toContain(DOWNED_FREE_TERM);
    expect(peek(sc.dOf(p)).tc!.engaged).toBe(true);
    // With its action spent, the body still holds it (HEAD's choice): it doesn't walk off toward the far foe.
    p.b.action = 0;
    p.b.bonus = 0;
    const later = sc.decide(p);
    expect(later.key).not.toMatch(/^move:/);
    expect(peek(sc.dOf(p)).tc!.engaged).toBe(true);
  });
});
