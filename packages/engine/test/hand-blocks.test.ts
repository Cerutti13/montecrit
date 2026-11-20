// Coverage step 9+ (docs/design/coverage.md, decision 3, critique M4 and M5): the hand-written SRD
// stat blocks brought up to the book, except the goblins' Hide.
//   - the ally-adjacent gate (allyWithin5ftOfTarget) and Pack Tactics on the Tough and the Warrior
//     Infantry (srd-raw.txt:54928-54931, 55578-55580);
//   - Parry on the Knight and the Warrior Veteran, in the hit-known window (50631-50633, 55655-55657);
//   - Redirect Attack on the Goblin Boss: the declare-time window, the swap and the retarget
//     (48831-48834), with the swapProvokesOpportunityAttacks flag (critique M4) and the Opportunity
//     Attack exemption for a creature moved without its own movement (2091-2093).
// Tests are named for the rule text they check. The SRD blocks are the committed pack's; the
// attackers and odd allies are synthetic test: monsters written inline.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../src/content/load.ts';
import type { CompiledTemplate, Content } from '../src/content/types.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import type { Decider, DecisionKind, DecisionPoint, UnitView } from '../src/decide/decider.ts';
import { GreedyDecider, type ExplainRecord } from '../src/decide/greedy/greedy.ts';
import { ArraySink, type GameEvent } from '../src/log/events.ts';
import { renderLog } from '../src/log/render.ts';
import { buildFrames } from '../src/log/view.ts';
import { makeDeciders } from '../src/decide/make.ts';
import { runFight } from '../src/sim/fight.ts';
import { parse } from 'yaml';
import { flagIndex, type RuleFlags } from '../src/rules/flags.ts';
import { resolveScenario } from '../src/scenario/resolve.ts';
import { buildAttackSpec, resolveAttack } from '../src/sim/attack.ts';
import { legalKey, releaseList, takeList, type Ctx } from '../src/sim/context.ts';
import { newModFold } from '../src/sim/effects.ts';
import { boundary } from '../src/sim/effects.ts';
import { createContext } from '../src/sim/fight.ts';
import { resolveOption } from '../src/sim/act.ts';
import { listOptions } from '../src/sim/options.ts';
import { applyPassives, runPrecasts } from '../src/sim/precast.ts';
import type { FightSetup } from '../src/sim/setup.ts';
import { gateOk } from '../src/sim/stats.ts';
import { addCond, COND, type Unit } from '../src/sim/state.ts';

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

const monster = (id: string, o: { toHit?: number; dmg?: string; kind?: 'melee' | 'ranged'; hp?: number; ac?: number; size?: string; extra?: string }) => `kind: monster
id: test:${id}
name: ${id}
source: synthetic test fixture
size: ${o.size ?? 'medium'}
cr: 0
pb: 2
ac: ${o.ac ?? 12}
hp: { average: ${o.hp ?? 300}, formula: '${o.hp ?? 300}' }
speed: { walk: 30 }
initiative: { mod: 0, score: 10 }
abilities: { str: 10, dex: 12, con: 10, int: 10, wis: 10, cha: 10 }
attacks:
  - { id: hit, name: Hit, kind: ${o.kind ?? 'melee'}, toHit: ${o.toHit ?? 40},${o.kind === 'ranged' ? ' range: [80, 320],' : ''} damage: [{ roll: '${o.dmg ?? '5'}', type: slashing, avg: 1 }] }
${o.extra ?? ''}`;

const KIT: Record<string, string> = {
  'packs/test/monsters/hb-sure.yaml': monster('hb-sure', {}),
  'packs/test/monsters/hb-archer.yaml': monster('hb-archer', { kind: 'ranged' }),
  'packs/test/monsters/hb-even.yaml': monster('hb-even', { toHit: 8 }),
  'packs/test/monsters/hb-giant.yaml': monster('hb-giant', { size: 'large' }),
  'packs/test/monsters/hb-frail.yaml': monster('hb-frail', { hp: 1, ac: 5 }),
  'packs/test/monsters/hb-tiny.yaml': monster('hb-tiny', { size: 'tiny' }),
};
const CONTENT: Content = (() => {
  const r = loadContent([...REPO, ...Object.entries(KIT).map(([path, text]) => ({ path, text }))]);
  if (!r.content) throw new Error(r.errors.map(formatDiag).join('\n'));
  return r.content;
})();

type UnitDoc = { seat: string; team: 'party' | 'enemies'; use: string; at: string; hp?: number; precast?: unknown[] };
const party = (seat: string, use: string, at: string, more: Partial<UnitDoc> = {}): UnitDoc => ({ seat, team: 'party', use, at, ...more });
const enemy = (seat: string, use: string, at: string, more: Partial<UnitDoc> = {}): UnitDoc => ({ seat, team: 'enemies', use, at, ...more });

function setupOf(units: UnitDoc[], flags: Partial<RuleFlags> = {}, grid: { w: number; h: number; terrain?: string[] } = { w: 8, h: 6 }): FightSetup {
  const doc = { kind: 'scenario', id: 'hand-blocks', name: 'Hand blocks', rules: '2024', packs: ['srd-5.2.1', 'test'], grid, units };
  const r = resolveScenario(doc, 'hand-blocks.yaml', CONTENT, { flags });
  if (!r.setup) throw new Error(r.errors.map(formatDiag).join('\n'));
  return r.setup;
}

/** Answers declared and hit-known windows by `choose` (default: the first react, else pass); everything else the first item. */
class Scripted implements Decider {
  readonly name = 'scripted';
  readonly seen: { k: DecisionKind; keys: string[] }[] = [];
  /** A target decision picks this seat when it can. */
  target = '';
  choose: (keys: string[], dp: DecisionPoint) => number = (keys) => Math.max(0, keys.findIndex((k) => k.startsWith('react')));
  decide(_v: UnitView, dp: DecisionPoint): number {
    const keys = Array.from({ length: dp.legal.n }, (_, i) => dp.keyOf(i));
    this.seen.push({ k: dp.k, keys });
    if (dp.k === 'attackDeclared' || dp.k === 'hitKnown') return this.choose(keys, dp);
    if (dp.k === 'target' && this.target) return Math.max(0, keys.indexOf(`target:${this.target}`));
    return 0;
  }
  kinds(k: DecisionKind): string[][] {
    return this.seen.filter((s) => s.k === k).map((s) => s.keys);
  }
}

interface World {
  readonly cx: Ctx;
  readonly setup: FightSetup;
  readonly sink: ArraySink;
  u(seat: string): Unit;
}
function world(setup: FightSetup, d: Decider, seed = 1): World {
  const sink = new ArraySink();
  const cx = createContext(setup, seed, 0, setup.seats.map(() => d), sink, { audit: true });
  applyPassives(cx, -1);
  runPrecasts(cx, -1);
  cx.st.order.forEach((_, i) => (cx.st.order[i] = i)); // initiative in seat order
  return { cx, setup, sink, u: (seat) => cx.st.units.find((x) => x.seat === seat)! };
}
function startTurn(w: World, who: Unit): void {
  const st = w.cx.st;
  st.turnIdx++;
  st.active = who.idx;
  who.turns++;
  who.b.reaction = 1;
  boundary(w.cx, 'start', who, -1);
  who.b.action = 1;
  who.b.bonus = 1;
  who.b.moveFt = 30;
  who.b.speedAt = 30;
}
const evs = <K extends GameEvent['k']>(w: World, k: K) => w.sink.events.filter((e): e is Extract<GameEvent, { k: K }> => e.k === k);
const tplOf = (id: string): CompiledTemplate => CONTENT.get(id)!;
const advOf = (w: World, a: string, t: string) => {
  const adv: string[] = [];
  const dis: string[] = [];
  buildAttackSpec(w.cx.st, w.u(a), 0, w.u(t), w.u(a).cell, adv, dis, newModFold());
  return adv;
};
const PACK = 'srd:tough/pack-tactics/pack-tactics';

// ---- the ally-adjacent gate and Pack Tactics ----

describe('Pack Tactics: "Advantage on an attack roll against a creature if at least one of the tough\'s allies is within 5 feet of the creature and the ally doesn\'t have the Incapacitated condition" (srd-raw.txt:54928-54931)', () => {
  const base = [enemy('tough', 'srd:tough', 'B2'), party('dummy', 'test:training-dummy', 'C2')];

  it('an ally within 5 feet of the creature: Advantage, its source named', () => {
    const w = world(setupOf([...base, enemy('ally', 'srd:goblin-warrior', 'D3')]), new Scripted());
    expect(advOf(w, 'tough', 'dummy')).toEqual([PACK]);
  });

  it('no ally within 5 feet (one 10 feet away): no Advantage', () => {
    const w = world(setupOf([...base, enemy('ally', 'srd:goblin-warrior', 'E2')]), new Scripted());
    expect(advOf(w, 'tough', 'dummy')).toEqual([]);
  });

  it('"one of the tough\'s allies": the tough beside the creature isn\'t its own ally, and the creature\'s own ally isn\'t the tough\'s', () => {
    const w = world(setupOf([...base, party('friend', 'srd:guard', 'D2')]), new Scripted());
    expect(advOf(w, 'tough', 'dummy')).toEqual([]);
  });

  it('"the ally doesn\'t have the Incapacitated condition": an Incapacitated ally gives none; a dead one gives none', () => {
    const w = world(setupOf([...base, enemy('ally', 'srd:goblin-warrior', 'D3')]), new Scripted());
    addCond(w.u('ally'), COND.incapacitated, 'core:incapacitated', -1, -1, { k: 'never' });
    expect(advOf(w, 'tough', 'dummy')).toEqual([]);
    const w2 = world(setupOf([...base, enemy('ally', 'srd:goblin-warrior', 'D3')]), new Scripted());
    w2.u('ally').life = 'dead';
    expect(advOf(w2, 'tough', 'dummy')).toEqual([]);
  });

  it('the Warrior Infantry\'s Pack Tactics (srd-raw.txt:55578-55580) reads the same gate, and a rolled attack shows the Advantage', () => {
    const w = world(setupOf([enemy('inf', 'srd:warrior-infantry', 'B2'), party('dummy', 'test:training-dummy', 'C2'), enemy('ally', 'srd:goblin-warrior', 'C3')]), new Scripted());
    startTurn(w, w.u('inf'));
    resolveAttack(w.cx, w.u('inf'), 0, w.u('dummy'), false, -1);
    const a = evs(w, 'attack')[0]!;
    expect([a.adv, a.advSrc]).toEqual(['adv', ['srd:warrior-infantry/pack-tactics/pack-tactics']]);
  });

  it('inert when unused: without the fight state the gate fails closed, and no other committed template carries it', () => {
    const w = world(setupOf([...base, enemy('ally', 'srd:goblin-warrior', 'D3')]), new Scripted());
    expect(gateOk(null, w.u('tough'), { g: 'allyWithin5ftOfTarget' }, w.u('dummy'))).toBe(false);
    expect(gateOk(w.cx.st, w.u('tough'), { g: 'allyWithin5ftOfTarget' }, w.u('dummy'))).toBe(true);
    const carriers = CONTENT.templates.filter((t) => t.effects.some((e) => e.mods.some((m) => m.when?.some((g) => g.g === 'allyWithin5ftOfTarget')))).map((t) => t.id);
    expect(carriers.sort()).toEqual(['srd:tough', 'srd:warrior-infantry']);
  });

  it('greedy reads the Advantage through the exact odds: between two equal targets it strikes the one an ally stands beside', () => {
    // dummy1 is listed first, so a gate that never (or always) holds leaves the tie with dummy1.
    const s = setupOf([enemy('tough', 'srd:tough', 'C3'), party('dummy1', 'test:training-dummy', 'B3'), party('dummy2', 'test:training-dummy', 'D3'), enemy('ally', 'srd:goblin-warrior', 'E3')]);
    const d = new GreedyDecider();
    const w = world(s, d);
    startTurn(w, w.u('tough'));
    const list = listOptions(w.cx, w.u('tough'), takeList(w.cx));
    const keys = list.items.slice(0, list.n).map((l) => legalKey(w.cx.st, w.u('tough').idx, l));
    const recs: ExplainRecord[] = [];
    d.explainTo((r) => recs.push(r as ExplainRecord));
    const dp: DecisionPoint = { k: 'turn', who: w.u('tough').idx, at: 0, round: 1, cause: -1, legal: list, keyOf: (i) => keys[i]! };
    const i = d.decide(w.cx.views[w.u('tough').idx]!, dp);
    releaseList(w.cx, list);
    expect(keys[i]).toBe('attack:mace>dummy2');
  });
});

// ---- Parry ----

describe('Parry: "Trigger: The knight is hit by a melee attack roll while holding a weapon. Response: The knight adds 2 to its AC against that attack, possibly causing it to miss" (srd-raw.txt:50631-50633)', () => {
  /** An attack by `use` on the knight with a d20 total landing in [lo, hi]; the first seed that does. */
  function hitAt(use: string, lo: number, hi: number, d: Decider, blockUse = 'srd:knight') {
    for (let seed = 1; seed < 400; seed++) {
      const w = world(setupOf([enemy('att', use, 'B2'), party('knight', blockUse, 'C2')]), d, seed);
      startTurn(w, w.u('att'));
      resolveAttack(w.cx, w.u('att'), 0, w.u('knight'), false, -1);
      const a = evs(w, 'attack')[0]!;
      if (a.natural !== 20 && a.total >= lo && a.total <= hi) return { w, a };
    }
    throw new Error('no seed');
  }

  it('a melee hit at exactly AC 18: the knight adds 2 against that attack and it misses; its Reaction is spent', () => {
    const { w, a } = hitAt('test:hb-even', 18, 19, new Scripted());
    expect([a.hit, a.ac, a.acUp]).toEqual([false, 20, 2]);
    expect(evs(w, 'act').map((e) => e.name)).toEqual(['Parry']);
    expect(w.u('knight').b.reaction).toBe(0);
    expect(evs(w, 'damage')).toEqual([]);
  });

  it('a hit by more than 2 still hits ("possibly causing it to miss"); the Reaction is spent all the same', () => {
    const { w, a } = hitAt('test:hb-even', 20, 26, new Scripted());
    expect([a.hit, a.acUp]).toEqual([true, 2]);
    expect(evs(w, 'damage')).toHaveLength(1);
  });

  it('"a melee attack roll": a ranged hit opens no Parry', () => {
    const d = new Scripted();
    const w = world(setupOf([enemy('att', 'test:hb-archer', 'E2'), party('knight', 'srd:knight', 'B2')]), d);
    startTurn(w, w.u('att'));
    resolveAttack(w.cx, w.u('att'), 0, w.u('knight'), false, -1);
    expect(evs(w, 'attack')[0]!.hit).toBe(true);
    expect(d.kinds('hitKnown')).toEqual([]);
  });

  it('the Warrior Veteran has the same Parry (srd-raw.txt:55655-55657)', () => {
    const { a } = hitAt('test:hb-even', 17, 18, new Scripted(), 'srd:warrior-veteran');
    expect([a.hit, a.acUp]).toEqual([false, 2]);
  });

  it('"while holding a weapon": a stat block whose Gear names none of its attacks can\'t have Parry', () => {
    const bad = monster('hb-bare-parry', { extra: 'reactions:\n  - { id: parry, name: Parry, window: hitKnown, attacks: [melee], ac: 2, whileHolding: weapon }\n' });
    const r = loadContent([...REPO, { path: 'packs/test/monsters/hb-bare-parry.yaml', text: bad }]);
    expect(r.content).toBeFalsy();
    expect(r.errors.map(formatDiag).join('\n')).toMatch(/Parry needs a weapon in hand/);
  });

  it('greedy Parries a hit it turns into a miss and keeps its Reaction for one it can\'t', () => {
    const turned = hitAt('test:hb-even', 18, 19, new GreedyDecider());
    expect(evs(turned.w, 'decided').filter((e) => e.dk === 'hitKnown').map((e) => e.key)).toEqual(['react:parry']);
    const beyond = hitAt('test:hb-even', 21, 26, new GreedyDecider());
    expect(evs(beyond.w, 'decided').filter((e) => e.dk === 'hitKnown').map((e) => e.key)).toEqual(['pass']);
  });
});

// ---- Redirect Attack ----

describe('Redirect Attack: "Trigger: A creature the goblin can see makes an attack roll against it. Response: The goblin chooses a Small or Medium ally within 5 feet of itself. The goblin and that ally swap places, and the ally becomes the target of the attack instead" (srd-raw.txt:48831-48834)', () => {
  const swapWorld = (extra: UnitDoc[] = [enemy('ally', 'srd:goblin-warrior', 'C3')], flags: Partial<RuleFlags> = {}, d: Decider = new Scripted(), att: UnitDoc = party('att', 'test:hb-sure', 'B2')) =>
    world(setupOf([att, enemy('boss', 'srd:goblin-boss', 'C2'), ...extra], flags), d);
  const strike = (w: World, a = 'att', t = 'boss') => {
    startTurn(w, w.u(a));
    resolveAttack(w.cx, w.u(a), 0, w.u(t), false, -1);
  };

  it('before the roll the goblin swaps places with its ally, and the attack is rolled against the ally where the goblin stood (the ally\'s AC)', () => {
    const d = new Scripted();
    const w = swapWorld(undefined, {}, d);
    strike(w);
    expect(d.kinds('attackDeclared')).toEqual([['pass', 'react:redirect-attack>ally']]);
    const ks = w.sink.events.map((e) => e.k);
    expect(ks.indexOf('swap')).toBeLessThan(ks.indexOf('attack'));
    const sw = evs(w, 'swap')[0]!;
    expect([sw.who, sw.with, sw.from, sw.to]).toEqual([w.u('boss').idx, w.u('ally').idx, w.u('ally').cell, w.u('boss').cell]);
    expect([w.u('boss').cell, w.u('ally').cell]).toEqual([2 * 8 + 2, 1 * 8 + 2]); // boss on C3, ally on C2
    const a = evs(w, 'attack')[0]!;
    expect([a.tgt, a.ac]).toEqual([w.u('ally').idx, 15]);
    expect(evs(w, 'damage').map((e) => e.tgt)).toEqual([w.u('ally').idx]);
    expect(w.u('boss').b.reaction).toBe(0);
    expect(renderLog(w.sink.events, w.setup).join('\n')).toMatch(/boss swaps places with ally \(Redirect Attack\): boss C2 -> C3, ally C3 -> C2/);
  });

  it('a swap spends no movement and walks no path: no step events, budgets unchanged', () => {
    const w = swapWorld();
    const before = [w.u('boss').b.moveFt, w.u('ally').b.moveFt];
    strike(w);
    expect(evs(w, 'step')).toEqual([]);
    expect([w.u('boss').b.moveFt, w.u('ally').b.moveFt]).toEqual(before);
  });

  it('passing the reaction leaves the goblin the target', () => {
    const d = new Scripted();
    d.choose = () => 0;
    const w = swapWorld(undefined, {}, d);
    strike(w);
    expect(evs(w, 'swap')).toEqual([]);
    expect(evs(w, 'attack')[0]!.tgt).toBe(w.u('boss').idx);
    expect(w.u('boss').b.reaction).toBe(1);
  });

  it('"a Small or Medium ally": a Large ally isn\'t offered; "within 5 feet": an ally 10 feet away isn\'t either; with neither, no decision', () => {
    const d = new Scripted();
    const w = swapWorld([enemy('big', 'test:hb-giant', 'C3'), enemy('far', 'srd:goblin-warrior', 'C4')], {}, d);
    strike(w);
    expect(d.kinds('attackDeclared')).toEqual([]);
    expect(evs(w, 'attack')[0]!.tgt).toBe(w.u('boss').idx);
  });

  it('"a Small or Medium ally": a Tiny ally isn\'t offered (a synthetic one, or the SRD cat), and the opportunity-attack reserve doesn\'t count one', () => {
    for (const use of ['test:hb-tiny', 'srd:cat']) {
      const d = new Scripted();
      const w = swapWorld([enemy('wee', use, 'C3')], {}, d);
      expect(w.u('wee').tpl.size).toBe(0);
      strike(w);
      expect(d.kinds('attackDeclared')).toEqual([]);
      expect(evs(w, 'attack')[0]!.tgt).toBe(w.u('boss').idx);
    }
    expect(tplOf('srd:goblin-boss').features.find((f) => f.declared)!.declared).toEqual({ swapRangeFt: 5, swapMinSize: 1, swapMaxSize: 2 });
    // The reserve: an 8-HP boss with only a Tiny 300-HP ally beside it has nothing to hold its Reaction
    // for, so it takes the opportunity attack on a hard-hitting AC 30 foe leaving its reach (a Medium
    // one would hold it, as in the reserve test below).
    const tank = monster('hb-tank', { ac: 30, toHit: 10, dmg: '12' });
    const content = loadContent([...REPO, ...Object.entries(KIT).map(([path, text]) => ({ path, text })), { path: 'packs/test/monsters/hb-tank.yaml', text: tank }]).content!;
    const oaKeys = (allyUse: string) => {
      const units = [party('foe', 'test:hb-tank', 'B2'), enemy('boss', 'srd:goblin-boss', 'C2', { hp: 8 }), enemy('wee', allyUse, 'C3')];
      const doc = { kind: 'scenario', id: 'hand-blocks', name: 'Hand blocks', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: { w: 8, h: 6 }, units };
      const w = world(resolveScenario(doc, 'hb.yaml', content, {}).setup!, new GreedyDecider());
      const f = w.u('foe');
      startTurn(w, f);
      const list = listOptions(w.cx, f, takeList(w.cx));
      const items = list.items.slice(0, list.n).map((l) => ({ l: { ...l }, key: legalKey(w.cx.st, f.idx, l) }));
      releaseList(w.cx, list);
      resolveOption(w.cx, f, items.find((x) => x.key.startsWith('move:A2'))!.l, -1);
      return evs(w, 'decided').filter((e) => e.dk === 'reaction' && e.who === w.u('boss').idx).map((e) => e.key);
    };
    expect(oaKeys('test:hb-sure')).toEqual(['pass']);
    expect(oaKeys('test:hb-tiny')).toEqual(['oa:scimitar']);
  });

  it('"a creature the goblin can see": a Blinded goblin can\'t answer', () => {
    const d = new Scripted();
    const w = swapWorld(undefined, {}, d);
    addCond(w.u('boss'), COND.blinded, 'core:blinded', -1, -1, { k: 'never' });
    strike(w);
    expect(d.kinds('attackDeclared')).toEqual([]);
  });

  it('one Reaction: the second attack the same round finds it spent', () => {
    const d = new Scripted();
    const w = swapWorld([enemy('ally', 'srd:goblin-warrior', 'C3'), enemy('ally2', 'srd:goblin-warrior', 'D3')], {}, d);
    strike(w);
    resolveAttack(w.cx, w.u('att'), 0, w.u('boss'), false, -1);
    expect(d.kinds('attackDeclared')).toHaveLength(1);
    expect(evs(w, 'swap')).toHaveLength(1);
  });

  it('[U] each square holds only the two that swap: none from a square the goblin shares mid-move, none onto an ally that shares one (SRD 5.2.1 p.14: no move ends in another creature\'s space)', () => {
    const d = new Scripted();
    const w = swapWorld([enemy('passer', 'srd:goblin-warrior', 'D4'), enemy('ally', 'srd:goblin-warrior', 'C3')], {}, d);
    w.u('passer').cell = w.u('boss').cell; // the goblin is passing through its ally's space
    strike(w);
    expect(d.kinds('attackDeclared')).toEqual([]);
    const d2 = new Scripted();
    const w2 = swapWorld([enemy('ally', 'srd:goblin-warrior', 'C3'), enemy('passer', 'srd:goblin-warrior', 'D4'), enemy('ally2', 'srd:goblin-warrior', 'D2')], {}, d2);
    w2.u('passer').cell = w2.u('ally').cell; // the ally's square is shared
    strike(w2);
    expect(d2.kinds('attackDeclared')).toEqual([['pass', 'react:redirect-attack>ally2']]);
  });

  it('the attacker can\'t be the ally swapped in (an ally attacking the goblin) [U]', () => {
    const d = new Scripted();
    const w = world(setupOf([enemy('att', 'test:hb-sure', 'B2'), enemy('boss', 'srd:goblin-boss', 'C2')]), d);
    strike(w);
    expect(d.kinds('attackDeclared')).toEqual([]);
  });

  it('a spell attack against the goblin is redirected too, and its effects land on the ally', () => {
    const d = new Scripted();
    const w = world(setupOf([party('pc1', 'test:sample-druid', 'A2'), enemy('boss', 'srd:goblin-boss', 'C2'), enemy('ally', 'srd:goblin-warrior', 'C3')]), d);
    const pc = w.u('pc1');
    startTurn(w, pc);
    const list = listOptions(w.cx, pc, takeList(w.cx));
    const items = list.items.slice(0, list.n).map((l) => ({ l: { ...l }, key: legalKey(w.cx.st, pc.idx, l) }));
    releaseList(w.cx, list);
    // Tether (a test stand-in: a ranged spell attack that pulls on a hit), aimed at the goblin.
    d.target = 'boss';
    resolveOption(w.cx, pc, items.find((x) => x.key.startsWith('cast:tether'))!.l, -1);
    const sw = evs(w, 'swap');
    expect(sw).toHaveLength(1);
    expect(evs(w, 'attack')[0]!.tgt).toBe(w.u('ally').idx);
    expect(evs(w, 'attack')[0]!.hit).toBe(true);
    expect(evs(w, 'damage').map((e) => e.tgt)).toEqual([w.u('ally').idx]);
  });

  it('an opportunity attack on the goblin\'s own move: it swaps, the walk stops (displaced) with its movement left, and the attack lands on the ally', () => {
    const d = new Scripted();
    const s = setupOf([party('guard', 'test:hb-sure', 'B2'), enemy('boss', 'srd:goblin-boss', 'C2'), enemy('ally', 'srd:goblin-warrior', 'C3')]);
    const w = world(s, d);
    const boss = w.u('boss');
    startTurn(w, boss);
    const list = listOptions(w.cx, boss, takeList(w.cx));
    const items = list.items.slice(0, list.n).map((l) => ({ l: { ...l }, key: legalKey(w.cx.st, boss.idx, l) }));
    releaseList(w.cx, list);
    // Scripted's OA decision takes the first item: make it the opportunity attack by answering 'reaction' with it.
    const sd = d as Scripted & { decide: Decider['decide'] };
    const inner = sd.decide.bind(sd);
    sd.decide = (v, dp) => (dp.k === 'reaction' ? Array.from({ length: dp.legal.n }, (_, i) => dp.keyOf(i)).findIndex((k) => k.startsWith('oa')) : inner(v, dp));
    resolveOption(w.cx, boss, items.find((x) => x.key.startsWith('move:E2'))!.l, -1);
    const end = evs(w, 'moveEnd')[0]!;
    expect(end.why).toBe('displaced');
    const a = evs(w, 'attack')[0]!;
    expect([a.opportunity, a.tgt]).toEqual([true, w.u('ally').idx]);
    expect(boss.cell).toBe(2 * 8 + 2); // C3
    expect(w.u('ally').cell).toBe(1 * 8 + 2); // C2, where the goblin was
    expect(boss.b.moveFt).toBe(30);
  });

  it('"when a creature that you can see leaves your reach ... right before it leaves your reach" (srd-raw.txt:2096-2100): once a swap cancels the step, a second foe whose reach it would have left gets no opportunity attack', () => {
    const d = new Scripted();
    const s = setupOf([party('g1', 'test:hb-sure', 'B2'), party('g2', 'test:hb-sure', 'B1'), enemy('boss', 'srd:goblin-boss', 'C2'), enemy('ally', 'srd:goblin-warrior', 'C3')]);
    const w = world(s, d);
    const boss = w.u('boss');
    startTurn(w, boss);
    const list = listOptions(w.cx, boss, takeList(w.cx));
    const items = list.items.slice(0, list.n).map((l) => ({ l: { ...l }, key: legalKey(w.cx.st, boss.idx, l) }));
    releaseList(w.cx, list);
    const sd = d as Scripted & { decide: Decider['decide'] };
    const inner = sd.decide.bind(sd);
    sd.decide = (v, dp) => (dp.k === 'reaction' ? Math.max(0, Array.from({ length: dp.legal.n }, (_, i) => dp.keyOf(i)).findIndex((k) => k.startsWith('oa'))) : inner(v, dp));
    // The step C2 -> D2 leaves both g1's and g2's reach; g1 is asked first (seat order).
    resolveOption(w.cx, boss, items.find((x) => x.key.startsWith('move:E2'))!.l, -1);
    expect(evs(w, 'swap')).toHaveLength(1);
    expect(evs(w, 'moveEnd').map((e) => e.why)).toEqual(['displaced']);
    const oas = evs(w, 'attack').filter((a) => a.opportunity);
    expect(oas.map((a) => [w.cx.st.units[a.att]!.seat, w.cx.st.units[a.tgt]!.seat])).toEqual([['g1', 'ally']]);
    expect(evs(w, 'provoke').map((e) => w.cx.st.units[e.by]!.seat)).toEqual(['g1']);
    expect(w.u('g2').b.reaction).toBe(1);
  });

  it('swapProvokesOpportunityAttacks: read when the swap takes the goblin out of a foe\'s reach (not otherwise); the ally never provokes (srd-raw.txt:2091-2093)', () => {
    // The attacker at B2 is a foe with reach 5: from C2 to C3 the goblin stays within its reach (diagonal), so no read.
    const w1 = swapWorld();
    strike(w1);
    expect(w1.cx.st.flagsUsed[flagIndex('swapProvokesOpportunityAttacks')]).toBe(0);
    // A foe on D1 has the goblin (C2) in reach, not on C3 after the swap: read, and nothing is attacked but the redirected roll.
    const w2 = swapWorld([enemy('ally', 'srd:goblin-warrior', 'C3'), party('watcher', 'test:hb-sure', 'D1')]);
    strike(w2);
    expect(w2.cx.st.flagsUsed[flagIndex('swapProvokesOpportunityAttacks')]).toBe(1);
    expect(evs(w2, 'attack').filter((a) => a.opportunity)).toEqual([]);
    expect(evs(w2, 'provoke')).toEqual([]);
  });

  it('a zone the ally is swapped into: its enter hook fires under involuntaryMovementTriggersArea true, not under false', () => {
    // Moonbeam (an enter hook) precast on C2, the goblin's square: the ally lands in it involuntarily.
    const mk = (involuntary: boolean) => {
      const s = setupOf([party('pc1', 'test:sample-druid', 'A5', { precast: [{ cast: 'srd:moonbeam', level: 2, at: 'C2' }] }), party('att', 'test:hb-sure', 'B2'), enemy('boss', 'srd:goblin-boss', 'D2'), enemy('ally', 'srd:goblin-warrior', 'D3')], { involuntaryMovementTriggersArea: involuntary });
      return world(s, new Scripted());
    };
    for (const inv of [true, false]) {
      const w = mk(inv);
      // Move the goblin onto the moonbeam's edge? It's on D2; the ally on D3. Put the goblin in the beam: C2.
      w.u('boss').cell = 1 * 8 + 2; // C2
      w.u('ally').cell = 2 * 8 + 2; // C3
      strike(w);
      const saves = evs(w, 'save').filter((e) => e.who === w.u('ally').idx);
      expect(saves.length, `involuntaryMovementTriggersArea ${inv}`).toBe(inv ? 1 : 0);
      expect(w.cx.st.flagsUsed[flagIndex('involuntaryMovementTriggersArea')]).toBe(1);
    }
  });

  it('[U] what the swap set off leaves the ally dead: the attack is never rolled', () => {
    const s = setupOf([party('pc1', 'test:sample-druid', 'A5', { precast: [{ cast: 'srd:moonbeam', level: 2, at: 'C2' }] }), party('att', 'test:hb-sure', 'B2'), enemy('boss', 'srd:goblin-boss', 'C3'), enemy('ally', 'test:hb-frail', 'D3')]);
    const w = world(s, new Scripted());
    w.u('boss').cell = 1 * 8 + 2; // C2, in the beam
    w.u('ally').cell = 2 * 8 + 2; // C3
    strike(w);
    expect(evs(w, 'swap')).toHaveLength(1);
    expect(w.u('ally').life).toBe('dead');
    expect(evs(w, 'attack')).toEqual([]);
  });
});

describe('Redirect Attack, greedy (GREEDY_VERSION 10): the attack moved off me against the same attack on the ally, the squares, and the Reaction kept', () => {
  const run = (bossHp: number, allyUse: string, allyHp?: number) => {
    const d = new GreedyDecider();
    const recs: ExplainRecord[] = [];
    d.explainTo((r) => recs.push(r as ExplainRecord));
    const s = setupOf([party('att', 'test:hb-sure', 'B2'), enemy('boss', 'srd:goblin-boss', 'C2', { hp: bossHp }), enemy('ally', allyUse, 'C3', allyHp !== undefined ? { hp: allyHp } : {})]);
    const w = world(s, d);
    startTurn(w, w.u('att'));
    resolveAttack(w.cx, w.u('att'), 0, w.u('boss'), false, -1);
    return { w, rec: recs.find((r) => r.top.some((t) => t.key.startsWith('react:'))), keys: evs(w, 'decided').filter((e) => e.dk === 'attackDeclared').map((e) => e.key) };
  };

  it('a goblin at 4 HP swaps a full-HP boss in to take a 5-damage hit it would drop to', () => {
    const r = run(4, 'srd:goblin-boss');
    expect(r.keys).toEqual(['react:redirect-attack>ally']);
    const row = r.rec!.top.find((t) => t.key === 'react:redirect-attack>ally')!;
    expect(row.parts.map((p) => p.term)).toEqual([
      'Redirect: the attack I no longer take (its expected damage and the drop it spares me)',
      'Redirect: the same attack on ally where I stand (its AC and HP)',
      'Redirect: my end cost on its square against mine',
      "Redirect: ally's exposure on my square against its own",
      'Reaction kept for an opportunity attack or a later swap',
    ]);
    expect(row.ev).toBeCloseTo(row.parts.reduce((a, p) => a + p.ev, 0), 9);
    expect(row.parts[0]!.ev).toBeGreaterThan(-row.parts[1]!.ev);
  });

  it('a full-HP boss keeps the hit rather than hand it to a 1-HP goblin it would drop', () => {
    const r = run(21, 'srd:goblin-warrior', 1);
    expect(r.keys).toEqual(['pass']);
  });

  // Two equal Goblin Bosses and an archer far off: the shot costs each the same where the boss stands
  // (5 damage, not enough to drop the 6-HP boss), so only the squares and the Reaction kept differ.
  // Two slow foes 10 ft from the boss's square and 15 ft from the ally's threaten only the first.
  // hb-slow walks 5 ft: it threatens a square only within 10 ft, so two squares 5 ft apart can differ.
  const slow = monster('hb-slow', {}).replace('speed: { walk: 30 }', 'speed: { walk: 5 }');
  const slowContent = loadContent([...REPO, ...Object.entries(KIT).map(([path, text]) => ({ path, text })), { path: 'packs/test/monsters/hb-slow.yaml', text: slow }]).content!;
  const squares = (extra: UnitDoc[]) => {
    const d = new GreedyDecider();
    const recs: ExplainRecord[] = [];
    d.explainTo((r) => recs.push(r as ExplainRecord));
    const units = [party('att', 'test:hb-archer', 'H3'), party('s1', 'test:hb-slow', 'C1'), party('s2', 'test:hb-slow', 'B1'), ...extra, enemy('boss', 'srd:goblin-boss', 'C3', { hp: 6 }), enemy('ally', 'srd:goblin-boss', 'C4')];
    const doc = { kind: 'scenario', id: 'hand-blocks', name: 'Hand blocks', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: { w: 8, h: 6 }, units };
    const w = world(resolveScenario(doc, 'hb.yaml', slowContent, {}).setup!, d);
    startTurn(w, w.u('att'));
    resolveAttack(w.cx, w.u('att'), 0, w.u('boss'), false, -1);
    const row = recs.find((r) => r.top.some((t) => t.key.startsWith('react:')))!.top.find((t) => t.key === 'react:redirect-attack>ally')!;
    return { keys: evs(w, 'decided').filter((e) => e.dk === 'attackDeclared').map((e) => e.key), ev: row.ev, parts: row.parts.map((p) => p.ev) };
  };

  it('the squares alone decide it: the boss swaps off the square two foes can reach onto one they can\'t, though the ally takes the same hit', () => {
    const r = squares([]);
    expect(r.parts[0]).toBeCloseTo(-r.parts[1]!, 9); // the same attack on either
    expect(r.parts[3]).toBeLessThan(0); // the ally moves onto the square the slow foes reach
    expect(r.parts[2]! + r.parts[3]!).toBeGreaterThan(0); // my end cost saved outweighs the ally's exposure
    expect(r.parts[4]).toBeCloseTo(0, 9); // nothing in reach for an opportunity attack, no share of a later strike to keep
    expect(r.ev).toBeCloseTo(r.parts.reduce((a, p) => a + p, 0), 9);
    expect(r.keys).toEqual(['react:redirect-attack>ally']);
  });

  it('the Reaction kept alone decides it: with a 1-HP foe in reach for an opportunity attack, the same swap is passed', () => {
    const r = squares([party('fr', 'test:hb-frail', 'D3')]);
    expect(r.parts[0]! + r.parts[1]! + r.parts[2]! + r.parts[3]!).toBeGreaterThan(0); // the swap alone is worth taking
    expect(r.parts[4]).toBeLessThan(-(r.parts[0]! + r.parts[1]! + r.parts[2]! + r.parts[3]!));
    expect(r.ev).toBeCloseTo(r.parts.reduce((a, p) => a + p, 0), 9);
    expect(r.keys).toEqual(['pass']);
  });

  it('the opportunity-attack decision holds the Reaction for Redirect Attack while an eligible ally is beside it', () => {
    const d = new GreedyDecider();
    // A foe with AC 30 leaves the boss's reach: an opportunity attack on it is worth little; a heavy hitter still has to swing at the boss.
    const tank = monster('hb-tank', { ac: 30, toHit: 10, dmg: '12' });
    const r = loadContent([...REPO, ...Object.entries(KIT).map(([path, text]) => ({ path, text })), { path: 'packs/test/monsters/hb-tank.yaml', text: tank }]);
    const content = r.content!;
    const mk = (withAlly: boolean) => {
      const units = [party('tank', 'test:hb-tank', 'B2'), enemy('boss', 'srd:goblin-boss', 'C2', { hp: 8 }), ...(withAlly ? [enemy('ally', 'srd:goblin-boss', 'C3')] : [])];
      const doc = { kind: 'scenario', id: 'hand-blocks', name: 'Hand blocks', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: { w: 8, h: 6 }, units };
      const s = resolveScenario(doc, 'hb.yaml', content, {}).setup!;
      const w = world(s, d);
      const tk = w.u('tank');
      startTurn(w, tk);
      const list = listOptions(w.cx, tk, takeList(w.cx));
      const items = list.items.slice(0, list.n).map((l) => ({ l: { ...l }, key: legalKey(w.cx.st, tk.idx, l) }));
      releaseList(w.cx, list);
      resolveOption(w.cx, tk, items.find((x) => x.key.startsWith('move:A2'))!.l, -1);
      return evs(w, 'decided').filter((e) => e.dk === 'reaction').map((e) => e.key);
    };
    expect(mk(false)).toEqual(['oa:scimitar']);
    // The 8-HP boss holds it (a full-HP boss beside it would take the hit); that full-HP boss, with only
    // the 8-HP one to swap in, swings.
    expect(mk(true)).toEqual(['pass', 'oa:scimitar']);
  });
});

describe('Redirect Attack in whole fights (stars-ambush: five Goblin Bosses, greedy everywhere)', () => {
  const doc = parse(readFileSync(join(ROOT, 'scenarios/stars-ambush.yaml'), 'utf8')) as Record<string, unknown>;
  const s = (() => {
    const r = resolveScenario(doc, 'stars-ambush.yaml', CONTENT, {});
    if (!r.setup) throw new Error(r.errors.map(formatDiag).join('\n'));
    return r.setup;
  })();

  it('the replay view folds the swap: every frame agrees with the fight, and the last with its final state', () => {
    let swaps = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const sink = new ArraySink();
      let cells: number[] = [];
      const r = runFight(s, seed, 0, makeDeciders(s), sink, { inspect: (st) => (cells = st.units.map((u) => u.cell)) });
      swaps += sink.events.filter((e) => e.k === 'swap').length;
      const v = buildFrames(s, sink.events, { hp: r.hp, hpMax: r.hpMax, life: r.life });
      expect(v.problems, `seed ${seed}`).toEqual([]);
      expect(v.frames[v.frames.length - 1]!.units.map((u) => u.cell), `seed ${seed}`).toEqual(cells);
    }
    expect(swaps).toBeGreaterThan(0);
  });
});
