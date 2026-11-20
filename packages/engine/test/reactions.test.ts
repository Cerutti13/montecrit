// M3 step 8'a, engine side (docs/design/coverage.md section 2 "Same step, engine side"): the
// hit-known reaction window (sim/d20.ts: a Reaction once a hit is known that raises AC against
// that attack, Shield's and Parry's shape), the damage-taken reaction window (Hellish Rebuke's
// shape, a trigger-queue handler), and the splitActions RuleFlag [U]. Content is synthetic
// (test: ids, packs/test/features/shield-like.yaml and rebuke-like.yaml, plus inline variants);
// no SRD content uses either window until step 9 (m6). Tests are named for the rule text they
// check, with its line in the SRD 5.2.1 PDF text (srd-raw.txt).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContent, type LoadResult } from '../src/content/load.ts';
import type { CompiledTemplate, Content } from '../src/content/types.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import type { Decider, DecisionKind, DecisionPoint, UnitView } from '../src/decide/decider.ts';
import { GreedyDecider, type ExplainRecord } from '../src/decide/greedy/greedy.ts';
import { programValue } from '../src/decide/greedy/value.ts';
import { DEFAULT_WEIGHTS } from '../src/decide/greedy/weights.ts';
import { ArraySink, type GameEvent } from '../src/log/events.ts';
import { header } from '../src/log/header.ts';
import { renderLog } from '../src/log/render.ts';
import { flagIndex, type RuleFlags } from '../src/rules/flags.ts';
import { resolveScenario } from '../src/scenario/resolve.ts';
import { resolveAttack } from '../src/sim/attack.ts';
import { resolveOption } from '../src/sim/act.ts';
import { legalKey, newLegal, releaseList, takeList, type Ctx } from '../src/sim/context.ts';
import { dealDamage } from '../src/sim/damage.ts';
import { boundary } from '../src/sim/effects.ts';
import { createContext } from '../src/sim/fight.ts';
import { acNow } from '../src/sim/hands.ts';
import { listOptions } from '../src/sim/options.ts';
import { applyPassives } from '../src/sim/precast.ts';
import type { FightSetup } from '../src/sim/setup.ts';
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
const withFiles = (extra: Record<string, string>): SourceFile[] => [...REPO.filter((f) => !Object.hasOwn(extra, f.path)), ...Object.entries(extra).map(([path, text]) => ({ path, text }))];
const messages = (r: LoadResult) => r.errors.map(formatDiag).join('\n');
function loadOk(files: readonly SourceFile[]): Content {
  const r = loadContent(files);
  if (!r.content) throw new Error(messages(r));
  return r.content;
}

const feature = (id: string, body: string) => `kind: feature\nid: test:${id}\nname: ${id}\nsource: synthetic test fixture\n${body}`;

/** A level-5 fighter-shaped PC: AC 16, 60 HP, one Extra Attack, a 3-use "wards" pool, CHA 16 (save DC 8 + 3 + 3 = 14). */
const PC_DOC = (features: string[]) => `kind: pc
id: test:react-pc
name: React PC
source: synthetic test fixture
rules: '2024'
level: 5
size: medium
speed: 30
abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 16 }
hpMax: 60
ac: 16
armor: none
saveProficiencies: [str, con]
extraAttacks: 1
weapons:
  - { id: longsword, name: Longsword, kind: melee, ability: str, category: martial, damage: [{ roll: 1d8 + @mod, type: slashing }] }
pools:
  - { id: wards, name: Wards, max: 3, recharge: longRest }
features: [${features.join(', ')}]
`;

const monster = (id: string, toHit: number, dmg: string, kind: 'melee' | 'ranged' = 'melee', hp = 300) => `kind: monster
id: test:${id}
name: ${id}
source: synthetic test fixture
size: medium
cr: 0
pb: 2
ac: 12
hp: { average: ${hp}, formula: '${hp}' }
speed: { walk: 30 }
initiative: { mod: 0, score: 10 }
abilities: { str: 10, dex: 12, con: 10, int: 10, wis: 10, cha: 10 }
attacks:
  - { id: hit, name: Hit, kind: ${kind}, toHit: ${toHit},${kind === 'ranged' ? ' range: [80, 320],' : ''} damage: [{ roll: '${dmg}', type: slashing, avg: 1 }] }
`;

const KIT: Record<string, string> = {
  'packs/test/monsters/react-brute.yaml': monster('react-brute', 5, '5'),
  'packs/test/monsters/react-sure.yaml': monster('react-sure', 40, '5'),
  'packs/test/monsters/react-never.yaml': monster('react-never', -40, '5'),
  'packs/test/monsters/react-archer.yaml': monster('react-archer', 40, '5', 'ranged'),
  'packs/test/monsters/react-maul.yaml': monster('react-maul', 40, '70'),
  'packs/test/monsters/react-flea.yaml': monster('react-flea', 40, '1'),
  'packs/test/monsters/react-titan.yaml': monster('react-titan', 8, '100'),
  // Two strikes a turn, for the reserve's "one attack's own AC over a routine".
  'packs/test/monsters/react-twin.yaml': monster('react-twin', 8, '20').replace('attacks:', 'multiattack: { alternatives: [[{ count: 2, from: [hit] }]] }\nattacks:'),
  // Shield's shape with no pool; and +5 against one attack only, for the same AC gain.
  'packs/test/features/free-ward.yaml': feature('free-ward', 'reaction: { window: hitKnown, do: [{ apply: { effect: wardup, to: self } }] }\neffects:\n  - { id: wardup, name: Ward, duration: { until: startOfNextTurn, of: bearer }, stats: [{ ac: 5 }] }\n'),
  'packs/test/data/react-parry5.yaml': feature('react-parry5', 'reaction: { window: hitKnown, ac: 5 }\n'),
  // Parry's shape (srd-raw.txt:50631-50633): "hit by a melee attack roll ... adds 2 to its AC against that attack".
  'packs/test/data/react-parry.yaml': feature('react-parry', 'reaction: { window: hitKnown, attacks: [melee], ac: 2 }\n'),
};
const PC_PATH = 'packs/test/pcs/react-pc.yaml';

type UnitDoc = { seat: string; team: 'party' | 'enemies'; use: string; at: string };
const PC: UnitDoc = { seat: 'pc1', team: 'party', use: 'test:react-pc', at: 'B2' };
const foe = (seat: string, use: string, cell: string): UnitDoc => ({ seat, team: 'enemies', use: `test:${use}`, at: cell });

interface Opts {
  features: string[];
  units?: UnitDoc[];
  flags?: Partial<RuleFlags>;
  grid?: { w: number; h: number; terrain?: string[] };
}
const SETUPS = new Map<string, FightSetup>();
function setupOf(o: Opts): FightSetup {
  const key = JSON.stringify(o);
  let s = SETUPS.get(key);
  if (!s) {
    const content = loadOk(withFiles({ ...KIT, [PC_PATH]: PC_DOC(o.features.map((f) => `test:${f}`)) }));
    const doc = { kind: 'scenario', id: 'react-lab', name: 'Reaction lab', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: o.grid ?? { w: 8, h: 5 }, units: o.units ?? [PC, foe('foe', 'react-brute', 'C2')] };
    const r = resolveScenario(doc, 'react-lab.yaml', content, o.flags ? { flags: o.flags } : {});
    if (!r.setup) throw new Error(r.errors.map(formatDiag).join('\n'));
    SETUPS.set(key, (s = r.setup));
  }
  return s;
}

/** Takes (react) or passes the two new windows; everything else the first item. Records every decision. */
class Scripted implements Decider {
  readonly name = 'scripted';
  readonly seen: { k: DecisionKind; keys: string[]; dp: DecisionPoint }[] = [];
  react = true;
  decide(_v: UnitView, dp: DecisionPoint): number {
    const keys = Array.from({ length: dp.legal.n }, (_, i) => dp.keyOf(i));
    this.seen.push({ k: dp.k, keys, dp });
    if (dp.k === 'hitKnown' || dp.k === 'damageTaken') return this.react ? 1 : 0;
    return 0;
  }
  kinds(k: DecisionKind): string[][] {
    return this.seen.filter((s) => s.k === k).map((s) => s.keys);
  }
}

interface World {
  readonly cx: Ctx;
  readonly setup: FightSetup;
  readonly d: Decider & { seen?: Scripted['seen']; kinds?: Scripted['kinds']; react?: boolean };
  readonly sink: ArraySink;
  u(seat: string): Unit;
}
function world(o: Opts, seed = 1, d: Decider = new Scripted()): World {
  const setup = setupOf(o);
  const sink = new ArraySink();
  const cx = createContext(setup, seed, 0, setup.seats.map(() => d), sink, { audit: true });
  applyPassives(cx, -1);
  return { cx, setup, d, sink, u: (seat) => cx.st.units.find((x) => x.seat === seat)! };
}
const scripted = (w: World): Scripted => w.d as Scripted;
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
function endTurn(w: World, who: Unit): void {
  boundary(w.cx, 'end', who, -1);
  w.cx.st.active = -1;
}
const evs = <K extends GameEvent['k']>(w: World, k: K) => w.sink.events.filter((e): e is Extract<GameEvent, { k: K }> => e.k === k);
const tplOf = (setup: FightSetup, id: string): CompiledTemplate => setup.seats.find((s) => s.tpl.id === id)!.tpl;
const hit = (w: World, seat: string) => resolveAttack(w.cx, w.u(seat), 0, w.u('pc1'), false, -1);

describe("hit-known window: compile (C3, coverage.md section 2)", () => {
  it('C3: a feature with no hitKnown or damageTaken reaction compiles neither field (templates keep their hashes)', () => {
    const tpl = tplOf(setupOf({ features: ['react-parry'] }), 'test:react-pc');
    const parry = tpl.features.find((f) => f.id === 'test:react-parry')!;
    expect(parry.hitKnown).toEqual({ attacks: 1, ac: 2, pool: -1, steps: [] });
    expect('damageTaken' in parry).toBe(false);
    const plain = tplOf(setupOf({ features: [] }), 'test:react-pc');
    for (const f of plain.features) {
      expect('hitKnown' in f).toBe(false);
      expect('damageTaken' in f).toBe(false);
    }
    const s = setupOf({ features: [] });
    const cx = createContext(s, 1, 0, s.seats.map(() => new Scripted()), null);
    expect([cx.st.watchHitKnown, cx.st.watchDamaged]).toEqual([0, 0]);
  });

  it('a hitKnown reaction must raise AC: ac, do, or both; points need a pool', () => {
    const bad = loadContent(withFiles({ ...KIT, 'packs/test/data/react-parry.yaml': feature('react-parry', 'reaction: { window: hitKnown }\n'), [PC_PATH]: PC_DOC(['test:react-parry']) }));
    expect(messages(bad)).toMatch(/a hitKnown reaction raises AC/);
    const pts = loadContent(withFiles({ ...KIT, 'packs/test/data/react-parry.yaml': feature('react-parry', 'reaction: { window: hitKnown, ac: 2, points: 2 }\n'), [PC_PATH]: PC_DOC(['test:react-parry']) }));
    expect(messages(pts)).toMatch(/points are spent from a pool/);
  });
});

describe('hit-known window: Shield\'s shape (srd-raw.txt:30659-30670)', () => {
  it('"Reaction, which you take when you are hit by an attack roll" (30659-30660): offered on a hit, never on a miss', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const miss = world({ features: ['shield-like'], units: [PC, foe('foe', 'react-never', 'C2')] }, seed);
      startTurn(miss, miss.u('foe'));
      hit(miss, 'foe');
      // toHit -40: only a natural 20 hits ("the attack hits regardless", 991-993)
      expect(scripted(miss).kinds('hitKnown')).toHaveLength(evs(miss, 'attack')[0]!.natural === 20 ? 1 : 0);
    }
    const sure = world({ features: ['shield-like'], units: [PC, foe('foe', 'react-sure', 'C2')] });
    startTurn(sure, sure.u('foe'));
    hit(sure, 'foe');
    expect(scripted(sure).kinds('hitKnown')).toEqual([['pass', 'react:shield-like']]);
  });

  it('"a +5 bonus to AC, including against the triggering attack" (30668-30669): a total below the new AC misses and deals no damage; a natural 20 still hits (991-993)', () => {
    const seen = { flipped: 0, held: 0, nat20: 0 };
    for (let seed = 1; seed <= 60; seed++) {
      const w = world({ features: ['shield-like'] }, seed);
      const pc = w.u('pc1');
      startTurn(w, w.u('foe'));
      hit(w, 'foe');
      const a = evs(w, 'attack')[0]!;
      if (scripted(w).kinds('hitKnown').length === 0) {
        expect(a.hit).toBe(false); // never hit: no window
        continue;
      }
      expect(a.ac).toBe(21);
      expect(a.acUp).toBe(5);
      expect(pc.res[9]).toBe(2); // one use of wards
      expect(pc.b.reaction).toBe(0);
      const dealt = evs(w, 'damage').length;
      if (a.natural === 20) {
        seen.nat20++;
        expect(a.hit && a.crit).toBe(true);
      } else if (a.total < 21) {
        seen.flipped++;
        expect(a.hit).toBe(false);
        expect(dealt).toBe(0);
      } else {
        seen.held++;
        expect(a.hit).toBe(true);
        expect(dealt).toBe(1);
      }
    }
    expect(seen.flipped).toBeGreaterThan(0);
    expect(seen.held).toBeGreaterThan(0);
  });

  it('"Until the start of your next turn" (30668): a second attack that round is against AC 21 with no window (one Reaction, 1438-1439); the bonus ends when the bearer\'s turn starts', () => {
    const w = world({ features: ['shield-like'], units: [PC, foe('foe', 'react-sure', 'C2'), foe('foe2', 'react-brute', 'B3')] });
    const pc = w.u('pc1');
    startTurn(w, w.u('foe'));
    hit(w, 'foe');
    hit(w, 'foe2');
    expect(scripted(w).kinds('hitKnown')).toHaveLength(1);
    expect(evs(w, 'attack').map((a) => a.ac)).toEqual([21, 21]);
    expect(evs(w, 'attack')[1]!.acUp).toBeUndefined(); // already in its AC, not added after the hit
    expect(acNow(pc, w.cx.st)).toBe(21);
    endTurn(w, w.u('foe'));
    startTurn(w, pc);
    expect(acNow(pc, w.cx.st)).toBe(16);
  });

  it('the log shows the reaction before the attack line, with the AC it added: "vs AC 21 (+5 after the hit)"', () => {
    const w = world({ features: ['shield-like'], units: [PC, foe('foe', 'react-sure', 'C2')] });
    startTurn(w, w.u('foe'));
    hit(w, 'foe');
    const text = renderLog(w.sink.events, w.setup).join('\n');
    expect(text).toMatch(/pc1: Shield-like Ward[\s\S]*vs AC 21 \(\+5 after the hit\), (hit|CRITICAL HIT)/);
  });

  it('a pool reaction needs its use: with "wards" spent there is no window; declining keeps the Reaction and the use; an Incapacitated creature can\'t react', () => {
    const w = world({ features: ['shield-like'], units: [PC, foe('foe', 'react-sure', 'C2'), foe('foe2', 'react-sure', 'B3')] });
    const pc = w.u('pc1');
    scripted(w).react = false;
    startTurn(w, w.u('foe'));
    hit(w, 'foe');
    expect(pc.b.reaction).toBe(1);
    expect(pc.res[9]).toBe(3);
    pc.res[9] = 0;
    scripted(w).react = true;
    hit(w, 'foe2');
    expect(scripted(w).kinds('hitKnown')).toHaveLength(1);
    pc.res[9] = 3;
    addCond(pc, COND.incapacitated, 'core:test', -1, -1, { k: 'never' });
    hit(w, 'foe');
    expect(scripted(w).kinds('hitKnown')).toHaveLength(1);
  });
});

describe('hit-known window: Parry\'s shape (srd-raw.txt:50631-50633)', () => {
  it('"hit by a melee attack roll ... adds 2 to its AC against that attack": melee only, and only that attack', () => {
    const w = world({ features: ['react-parry'], units: [PC, foe('foe', 'react-archer', 'E2'), foe('foe2', 'react-sure', 'C2'), foe('foe3', 'react-sure', 'B3')] });
    const pc = w.u('pc1');
    startTurn(w, w.u('foe'));
    hit(w, 'foe'); // ranged: no window
    expect(scripted(w).kinds('hitKnown')).toHaveLength(0);
    hit(w, 'foe2');
    expect(scripted(w).kinds('hitKnown')).toEqual([['pass', 'react:react-parry']]);
    const [, melee] = evs(w, 'attack');
    expect([melee!.ac, melee!.acUp]).toEqual([18, 2]);
    expect(acNow(pc, w.cx.st)).toBe(16); // nothing lasts past that attack
    pc.b.reaction = 1;
    scripted(w).react = false;
    hit(w, 'foe3');
    expect(evs(w, 'attack')[2]!.ac).toBe(16);
  });
});

describe('hit-known window: greedy values it (coverage 8\'b)', () => {
  /** Asks greedy `who`'s hitKnown decision over its reaction, as sim/d20.ts would, with the attack roll's total. */
  const askHit = (w: World, total: number, crit = false) => {
    const pc = w.u('pc1');
    const f = w.u('foe');
    const fi = pc.tpl.features.findIndex((x) => x.hitKnown);
    const pass = newLegal();
    pass.k = 'pass';
    const react = newLegal();
    react.k = 'react';
    react.opt = fi;
    const keys = ['pass', 'react'];
    const dp: DecisionPoint = {
      k: 'hitKnown', who: pc.idx, at: 5, round: 1, cause: -1, legal: { n: 2, items: [pass, react] }, keyOf: (i) => keys[i]!,
      roll: { kind: 'attack', adv: 'none', flat: 5, preDice: [], dc: acNow(pc, w.cx.st) }, roller: f.idx, rollTarget: pc.idx, rollVia: f.tpl.attacks[0]!.id,
      hit: { attacker: f.idx, target: pc.idx, via: f.tpl.attacks[0]!.id, crit, total, types: 0 },
    };
    const d = new GreedyDecider();
    const recs: ExplainRecord[] = [];
    d.explainTo((r) => recs.push(r));
    return { key: keys[d.decide(w.cx.views[pc.idx]!, dp)]!, rec: recs.at(-1) };
  };
  // E2: out of the PC's reach, so no opportunity attack is at stake in what the Reaction is kept for.
  const started = (use: string) => {
    const w = world({ features: ['shield-like'], units: [PC, foe('foe', use, 'E2')] }, 1, new GreedyDecider());
    const f = w.u('foe');
    startTurn(w, f);
    f.b.action = 0; // its Attack action is done: this hit is the last strike coming
    return w;
  };

  it('its value is the damage it stops, not a yes: a 1-damage hit is worth one of three Ward uses but not the last; a 70-damage hit is worth the last; Explain names the terms', () => {
    const plenty = started('react-flea');
    expect(askHit(plenty, 18).key).toBe('react');
    const last = started('react-flea');
    last.u('pc1').res[last.u('pc1').tpl.features.find((x) => x.hitKnown)!.hitKnown!.pool] = 1;
    const flea = askHit(last, 18);
    expect(flea.key).toBe('pass');
    expect(flea.rec!.top.find((t) => t.key === 'react')!.parts.find((p) => p.term.startsWith('points spent'))!.ev).toBeCloseTo(-2, 9);
    const heavyW = started('react-maul');
    heavyW.u('pc1').res[heavyW.u('pc1').tpl.features.find((x) => x.hitKnown)!.hitKnown!.pool] = 1;
    const heavy = askHit(heavyW, 18);
    expect(heavy.key).toBe('react');
    const parts = heavy.rec!.top.find((t) => t.key === 'react')!.parts;
    expect(parts.find((p) => p.term.startsWith('the hit it turns into a miss'))!.ev).toBeGreaterThan(0);
    expect(parts.find((p) => p.term === 'the drop it prevents')!.ev).toBeGreaterThan(0);
  });

  it('a hit the gain cannot turn into a miss, or a critical hit, buys nothing when no strike is left to come: pass', () => {
    expect(askHit(started('react-maul'), 40).key).toBe('pass');
    expect(askHit(started('react-maul'), 18, true).key).toBe('pass');
  });

  it("Shield's shape lasts: with the attacker's routine still to come, even a hit it can't turn counts what those strikes would land", () => {
    const later = world({ features: ['shield-like'], units: [PC, foe('foe', 'react-titan', 'C2')] }, 1, new GreedyDecider());
    startTurn(later, later.u('foe')); // its action unspent: its routine is still to come
    const r = askHit(later, 40);
    const parts = r.rec!.top.find((t) => t.key === 'react')!.parts;
    expect(parts.find((p) => p.term.startsWith('its AC until my next turn'))!.ev).toBeGreaterThan(0);
    expect(parts.find((p) => p.term.startsWith('the hit it turns'))!.ev).toBe(0); // +5 can't turn a 40: the row is all in the next line
  });

  const row = (r: { rec?: ExplainRecord }, term: string) => r.rec!.top.find((t) => t.key === 'react')!.parts.find((p) => p.term.startsWith(term))?.ev;

  it('the hit it turns is capped at what the hit could take from me: 70 damage at 5 HP counts 5 HP', () => {
    const w = started('react-maul');
    w.u('pc1').hp = 5;
    expect(row(askHit(w, 18), 'the hit it turns')).toBeCloseTo(DEFAULT_WEIGHTS.pc.exposure * 5, 9);
  });

  it('concentration kept can decide alone: a 1-damage hit on the last Ward use is passed on, and taken once a save is at stake on a live spell', () => {
    const go = (concLeft: number) => {
      const w = started('react-flea');
      const pc = w.u('pc1');
      pc.res[pc.tpl.features.find((x) => x.hitKnown)!.hitKnown!.pool] = 1;
      if (concLeft > 0) pc.conc = 0;
      const real = GreedyDecider.prototype as unknown as { concLeft(st: unknown, me: Unit): number };
      const was = real.concLeft;
      real.concLeft = () => concLeft;
      const fx = w.cx.st.fx;
      if (concLeft > 0) fx.push({ alive: true, owner: pc.idx, bearer: pc.idx, tpl: 0, sid: -1, until: { k: 'never' } } as never);
      try {
        return askHit(w, 18);
      } finally {
        real.concLeft = was;
        if (concLeft > 0) {
          fx.pop();
          pc.conc = -1;
        }
      }
    };
    const none = go(0);
    expect(none.key).toBe('pass');
    expect(row(none, 'concentration kept')).toBeUndefined();
    const held = go(40);
    expect(held.key).toBe('react');
    expect(row(held, 'concentration kept')).toBeGreaterThan(0);
  });

  it('what the Reaction is kept for is the larger of an opportunity attack and a later strike: a foe in my reach sets the first, the attacker\'s remaining routine the second', () => {
    const oa = world({ features: ['shield-like'], units: [PC, foe('foe', 'react-maul', 'E2'), foe('near', 'react-brute', 'C2')] }, 1, new GreedyDecider());
    startTurn(oa, oa.u('foe'));
    oa.u('foe').b.action = 0;
    expect(row(askHit(oa, 18), 'Reaction kept')).toBeLessThan(0);
    const clear = started('react-maul');
    expect(row(askHit(clear, 18), 'Reaction kept')).toBeCloseTo(0, 9);
    const later = world({ features: ['shield-like'], units: [PC, foe('foe', 'react-titan', 'E2')] }, 1, new GreedyDecider());
    startTurn(later, later.u('foe')); // its action unspent: its routine still to come, nothing in my reach
    expect(row(askHit(later, 18), 'Reaction kept')).toBeLessThan(0);
  });

  /** reactionReserve's own figure for a PC with `features`, at a foe of `use` adjacent, read through the private method. */
  const reserve = (features: string[], use: string, patch?: (pc: Unit) => void) => {
    const w = world({ features, units: [PC, foe('foe', use, 'C2')] }, 1, new GreedyDecider());
    const pc = w.u('pc1');
    startTurn(w, w.u('foe'));
    patch?.(pc);
    const d = new GreedyDecider() as unknown as { decide(v: unknown, dp: DecisionPoint): number; reactionReserve(view: unknown, me: Unit): number; reactionCost(st: unknown, me: Unit, f: unknown): number; exposure(st: unknown, me: Unit, cell: number): number; vctxFor(st: unknown, me: Unit, v: unknown): never };
    const pass = newLegal();
    pass.k = 'pass';
    d.decide(w.cx.views[pc.idx]!, { k: 'reaction', who: pc.idx, at: 5, round: 1, cause: -1, legal: { n: 1, items: [pass] }, keyOf: () => 'pass' });
    return { w, pc, d, res: d.reactionReserve(w.cx.views[pc.idx]!, pc) };
  };

  it('the reserve for an AC reaction: a lasting one in full, one attack\'s own over a two-strike routine in half', () => {
    const lasting = reserve(['free-ward'], 'react-twin');
    const once = reserve(['react-parry5'], 'react-twin');
    expect(lasting.res).toBeGreaterThan(0);
    expect(once.res).toBeCloseTo(lasting.res / 2, 6);
  });

  it('the reserve is net of the points: the same Ward with a pool cost holds less by half what they could buy, and with the pool empty holds nothing', () => {
    const free = reserve(['free-ward'], 'react-titan');
    const paid = reserve(['shield-like'], 'react-titan');
    const hk = paid.pc.tpl.features.find((x) => x.hitKnown)!.hitKnown!;
    const cost = paid.d.reactionCost(paid.w.cx.st, paid.pc, hk);
    expect(cost).toBeGreaterThan(0);
    expect(free.res - paid.res).toBeCloseTo(0.5 * cost, 6);
    expect(reserve(['shield-like'], 'react-titan', (pc) => { pc.res[hk.pool] = 0; }).res).toBe(0);
  });

  it('the reserve for a damage-taken reaction: its program at the worst foe in range, net of its points, scaled by how likely I am to be hit; nothing with the pool empty', () => {
    const w = reserve(['rebuke-like'], 'react-flea');
    const dt = w.pc.tpl.features.find((x) => x.damageTaken)!.damageTaken!;
    const v = w.d.vctxFor(w.w.cx.st, w.pc, w.w.cx.views[w.pc.idx]!);
    const best = programValue(v, dt.steps, w.pc.cell, { targets: [w.w.u('foe')], parentRounds: 10 });
    const cost = w.d.reactionCost(w.w.cx.st, w.pc, dt);
    const e = w.d.exposure(w.w.cx.st, w.pc, w.pc.cell);
    expect(cost).toBeGreaterThan(0);
    expect(e / 6).toBeLessThan(1); // a flea: the scale bites
    expect(w.res).toBeCloseTo(0.5 * (e / 6) * (best - cost), 6);
    expect(reserve(['rebuke-like'], 'react-flea', (pc) => { pc.res[dt.pool] = 0; }).res).toBe(0);
  });

  it('the Reaction is held for it in the opportunity-attack decision: a weak strike at a passing foe is declined, without the reaction it is taken', () => {
    const decide = (features: string[]) => {
      const w = world({ features, units: [PC, foe('foe', 'react-titan', 'C2')] }, 1, new GreedyDecider());
      const pc = w.u('pc1');
      const f = w.u('foe');
      startTurn(w, f);
      const pass = newLegal();
      pass.k = 'pass';
      const oa = newLegal();
      oa.k = 'oa';
      oa.atk = 0;
      oa.target = f.idx;
      const dp: DecisionPoint = { k: 'reaction', who: pc.idx, at: 5, round: 1, cause: -1, legal: { n: 2, items: [pass, oa] }, keyOf: (i) => ['pass', 'oa'][i]! };
      return new GreedyDecider().decide(w.cx.views[pc.idx]!, dp);
    };
    expect(decide([])).toBe(1);
    expect(decide(['shield-like'])).toBe(0);
  });

  it('a free reaction: taken exactly when its AC gain turns the hit into a miss, never on a critical hit with nothing else coming', () => {
    let took = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const w = world({ features: ['shield-like'] }, seed, new GreedyDecider());
      startTurn(w, w.u('foe'));
      hit(w, 'foe');
      const a = evs(w, 'attack')[0]!;
      const decided = evs(w, 'decided').filter((e) => e.dk === 'hitKnown');
      if (decided.length === 0) continue;
      const pre = a.total; // the attack's total; it hit AC 16
      const wants = a.natural !== 20 && pre < 21;
      expect(decided[0]!.key).toBe(wants ? 'react:shield-like' : 'pass');
      if (wants) {
        took++;
        expect(a.hit).toBe(false);
      }
    }
    expect(took).toBeGreaterThan(0);
  });
});

describe('damage-taken window: Hellish Rebuke\'s shape (srd-raw.txt:27953-27961)', () => {
  it('"in response to taking damage from a creature" (27953-27954): after the damage, the creature that dealt it saves (DEX, DC 14) for 2d10 Fire, half on a success', () => {
    const w = world({ features: ['rebuke-like'], units: [PC, foe('foe', 'react-sure', 'C2')] });
    const pc = w.u('pc1');
    const brute = w.u('foe');
    startTurn(w, brute);
    hit(w, 'foe');
    expect(scripted(w).kinds('damageTaken')).toEqual([['pass', 'react:rebuke-like']]);
    const [took, back] = evs(w, 'damage');
    expect(took!.tgt).toBe(pc.idx);
    const save = evs(w, 'save')[0]!;
    expect([save.who, save.key, save.purpose]).toEqual([brute.idx, 'save.dex', 'reaction']);
    expect(back!.tgt).toBe(brute.idx);
    expect(back!.src).toBe(pc.idx);
    expect(back!.parts[0]!.type).toBe('fire');
    expect(back!.dealt).toBe(save.ok ? Math.floor(back!.parts[0]!.rolled / 2) : back!.parts[0]!.rolled);
    expect([pc.b.reaction, pc.res[9]]).toEqual([0, 2]);
    const seqs = w.sink.events.map((e) => e.k);
    expect(seqs.indexOf('damage')).toBeLessThan(seqs.indexOf('save'));
    expect(renderLog(w.sink.events, w.setup).join('\n')).toMatch(/save vs Rebuke-like Flames: .*\[foe save|\[foe reaction r0/);
  });

  it('"within 60 feet of yourself" (27955): 60 ft opens the window, 70 ft does not', () => {
    const grid = { w: 20, h: 3 };
    const at60 = world({ features: ['rebuke-like'], grid, units: [{ ...PC, at: 'A1' }, foe('foe', 'react-archer', 'M1')] });
    startTurn(at60, at60.u('foe'));
    hit(at60, 'foe');
    expect(scripted(at60).kinds('damageTaken')).toHaveLength(1);
    const at70 = world({ features: ['rebuke-like'], grid, units: [{ ...PC, at: 'A1' }, foe('foe', 'react-archer', 'O1')] });
    startTurn(at70, at70.u('foe'));
    hit(at70, 'foe');
    expect(evs(at70, 'damage')).toHaveLength(1);
    expect(scripted(at70).kinds('damageTaken')).toHaveLength(0);
  });

  it('"a creature that you can see" (27954): a wall between them closes the window (losMethod=corners); under stubbed everyone sees everyone', () => {
    const grid = { w: 8, h: 3, terrain: ['..#.....', '..#.....', '..#.....'] };
    const damage = (flags: Partial<RuleFlags>) => {
      const w = world({ features: ['rebuke-like'], grid, flags, units: [{ ...PC, at: 'B2' }, foe('foe', 'react-sure', 'D2')] });
      startTurn(w, w.u('foe'));
      // Damage dealt directly (the wall also blocks the attack): 5 slashing from foe.
      dealDamage(w.cx, { unit: w.u('foe').idx, via: 'test:react-sure' as never, slot: -1, cause: -1 }, w.u('foe').tpl.attacks[0]!.damage, Int32Array.of(5), () => true, false, [w.u('pc1').idx]);
      return scripted(w).kinds('damageTaken').length;
    };
    expect(damage({})).toBe(0);
    expect(damage({ losMethod: 'stubbed' })).toBe(1);
  });

  it('dropped to 0 HP (Unconscious, so Incapacitated: no Reactions, 1438 and p.191) there is no window; a creature\'s own damage to itself opens none', () => {
    const w = world({ features: ['rebuke-like'], units: [PC, foe('foe', 'react-maul', 'C2')] });
    startTurn(w, w.u('foe'));
    hit(w, 'foe');
    expect(w.u('pc1').life).toBe('down');
    expect(scripted(w).kinds('damageTaken')).toHaveLength(0);
    const self = world({ features: ['rebuke-like'] });
    const pc = self.u('pc1');
    dealDamage(self.cx, { unit: pc.idx, via: 'test:react-pc' as never, slot: -1, cause: -1 }, pc.tpl.attacks[0]!.damage, Int32Array.of(3), () => true, false, [pc.idx]);
    expect(scripted(self).kinds('damageTaken')).toHaveLength(0);
  });

  const askRebuke = (w: World, attacker: Unit) => {
    const pc = w.u('pc1');
    const pass = newLegal();
    pass.k = 'pass';
    const react = newLegal();
    react.k = 'react';
    react.opt = pc.tpl.features.findIndex((x) => x.damageTaken);
    const keys = ['pass', 'react'];
    const dp: DecisionPoint = { k: 'damageTaken', who: pc.idx, at: 5, round: 1, cause: -1, legal: { n: 2, items: [pass, react] }, keyOf: (i) => keys[i]!, src: { via: '', target: attacker.idx }, hit: { attacker: attacker.idx, target: pc.idx, via: '', crit: false, total: 5, types: 0 } };
    const d = new GreedyDecider();
    const recs: ExplainRecord[] = [];
    d.explainTo((r) => recs.push(r));
    return { key: keys[d.decide(w.cx.views[pc.idx]!, dp)]!, rec: recs.at(-1) };
  };

  it('never answers an ally: the same reaction on my side is worth less than nothing', () => {
    const ally: UnitDoc = { seat: 'pal', team: 'party', use: 'test:react-sure', at: 'C2' };
    const w = world({ features: ['rebuke-like'], units: [PC, ally, foe('foe', 'react-sure', 'E2')] }, 1, new GreedyDecider());
    startTurn(w, w.u('foe'));
    const r = askRebuke(w, w.u('pal'));
    expect(r.key).toBe('pass');
    expect(r.rec!.top.find((t) => t.key === 'react')!.parts[0]!.ev).toBeLessThan(0);
  });

  it('a Reaction with a good opportunity attack in reach is worth keeping against a poor answer: Explain nets what it does, its points and the Reaction kept', () => {
    const w = world({ features: ['rebuke-like'], units: [PC, foe('foe', 'react-sure', 'C2')] }, 1, new GreedyDecider());
    startTurn(w, w.u('foe'));
    const r = askRebuke(w, w.u('foe'));
    const row = r.rec!.top.find((t) => t.key === 'react')!;
    expect(row.parts.find((p) => p.term === 'what it does to the creature that damaged me')!.ev).toBeGreaterThan(0);
    expect(row.parts.find((p) => p.term === 'points spent: what else they could buy')!.ev).toBeCloseTo(-(0.5 * 4) / 3, 9);
    expect(row.parts.find((p) => p.term === 'Reaction kept for an opportunity attack')!.ev).toBeLessThan(0);
    expect(row.ev).toBeCloseTo(row.parts.reduce((a, p) => a + p.ev, 0), 9);
  });

  it('greedy answers an enemy that damaged it, for what the reaction does to it', () => {
    const w = world({ features: ['rebuke-like'], units: [PC, foe('foe', 'react-sure', 'C2')] }, 1, new GreedyDecider());
    startTurn(w, w.u('foe'));
    hit(w, 'foe');
    expect(evs(w, 'decided').filter((e) => e.dk === 'damageTaken').map((e) => e.key)).toEqual(['react:rebuke-like']);
  });
});

describe('splitActions [U] (srd-raw.txt:1878-1883, 32713-32717)', () => {
  /** pc1 starts its Attack action (one strike of two), then takes the Dodge action with a second Action (as after Action Surge). */
  function splitTurn(flags: Partial<RuleFlags>) {
    const w = world({ features: [], flags, units: [PC, foe('foe', 'react-never', 'C2')] });
    const pc = w.u('pc1');
    startTurn(w, pc);
    pc.b.action = 2;
    const pick = (key: string) => {
      const list = listOptions(w.cx, pc, takeList(w.cx));
      const items = list.items.slice(0, list.n).map((l) => ({ l: { ...l }, key: legalKey(w.cx.st, pc.idx, l) }));
      releaseList(w.cx, list);
      return items.find((x) => x.key.startsWith(key))?.l;
    };
    resolveOption(w.cx, pc, pick('attack:')!, -1);
    expect(pc.b.atkActive).toBe(true);
    resolveOption(w.cx, pc, pick('dodge')!, -1);
    return { w, pc, attackAfter: pick('attack:') !== undefined, read: w.cx.st.flagsUsed[flagIndex('splitActions')] };
  }

  it('allowed (the default, the engine before the flag): the Attack action carries on after the Dodge, and the flag is read', () => {
    const r = splitTurn({});
    expect(r.pc.b.atkActive).toBe(true);
    expect(r.attackAfter).toBe(true);
    expect(r.read).toBe(1);
    const lines = header(r.w.setup, 1, 0, [], ['scripted', 'scripted'], r.w.cx.st.flagsUsed);
    expect(lines.join('\n')).toMatch(/splitActions=allowed \[UNVERIFIED: /);
  });

  it('notAllowed: taking another action ends the unfinished Attack action, its unused attack lost', () => {
    const r = splitTurn({ splitActions: 'notAllowed' });
    expect(r.pc.b.atkActive).toBe(false);
    expect(r.attackAfter).toBe(false);
    expect(r.read).toBe(1);
  });

  it('not read when no Attack action is unfinished', () => {
    const w = world({ features: [], units: [PC, foe('foe', 'react-never', 'C2')] });
    const pc = w.u('pc1');
    startTurn(w, pc);
    const list = listOptions(w.cx, pc, takeList(w.cx));
    const dodge = list.items.slice(0, list.n).find((l) => l.k === 'dodge')!;
    releaseList(w.cx, list);
    resolveOption(w.cx, pc, { ...dodge }, -1);
    expect(w.cx.st.flagsUsed[flagIndex('splitActions')]).toBe(0);
  });
});
