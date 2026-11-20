// Coverage W1.2 (docs/design/w1-plan.md section 7, "W1.2 Integration"): the W1 primitives end to end
// on the real SRD items, through the reviewed overrides in tools/import-srd/overrides/ and the
// regenerated pack. Characters are inline YAML built through content/character.ts's expandCharacter
// (loadContent); packs/test/characters/sample-barbarian.yaml is only read. The monsters that aren't
// SRD stat blocks are synthetic (test: ids). Tests are named for the rule text, with its line in the
// SRD 5.2.1 PDF text (srd-raw.txt).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../src/content/load.ts';
import type { Content } from '../src/content/types.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import type { Decider, DecisionPoint, Legal, UnitView } from '../src/decide/decider.ts';
import { GreedyDecider, type ExplainRecord } from '../src/decide/greedy/greedy.ts';
import { ArraySink, type GameEvent } from '../src/log/events.ts';
import type { RuleFlags } from '../src/rules/flags.ts';
import { resolveScenario } from '../src/scenario/resolve.ts';
import { copyLegal, legalKey, newLegal, releaseList, takeList } from '../src/sim/context.ts';
import { resolveOption } from '../src/sim/act.ts';
import { createContext, runFight } from '../src/sim/fight.ts';
import { listOptions } from '../src/sim/options.ts';
import { applyPassives } from '../src/sim/precast.ts';
import type { FightSetup } from '../src/sim/setup.ts';
import { condImmunity } from '../src/sim/conditions.ts';
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
const REPO = [...readPack('srd-5.2.1'), ...readPack('test').filter((f) => !f.path.startsWith('packs/test/characters/'))];

// ---- Characters (inline; the Barbarian is the committed step-10 sample, read and renamed) ----

const SAMPLE_BARB = readFileSync(join(ROOT, 'packs', 'test', 'characters', 'sample-barbarian.yaml'), 'utf8');
/** Barbarian 5 (Path of the Berserker), Goliath (Stone's Endurance), Greataxe and two Handaxes. */
const BARB = SAMPLE_BARB.replace('id: test:sample-barbarian', 'id: test:w1c-barbarian').replace('name: Sample Barbarian', 'name: W1 Barbarian');
/** The same at level 6: Mindless Rage (5182-5184). */
const BARB6 = BARB.replace('id: test:w1c-barbarian', 'id: test:w1c-barbarian-6').replace('name: W1 Barbarian', 'name: W1 Barbarian 6').replace('level: 5,', 'level: 6,');

/** Rogue 5 (Thief), Halfling, Criminal (Alert): the curated Rogue (tools/class-picks.ts), Rapier and Shortbow. */
const ROGUE = `kind: character
id: test:w1c-rogue
name: W1 Rogue
source: synthetic test fixture
rules: '2024'
classes: [{ class: srd:rogue, level: 5, subclass: srd:thief }]
species: srd:halfling
background: srd:criminal
abilities: { str: 8, dex: 19, con: 15, int: 13, wis: 12, cha: 10 }
hp: average
picks:
  srd:rogue#skills: [acrobatics, athletics, deception, insight]
  srd:rogue#weapon-mastery: [srd:rapier, srd:shortbow]
  srd:rogue#asi-4: { asi: { dex: 2 } }
  srd:criminal#abilities: { asi: { con: 1, dex: 2 } }
  srd:rogue#expertise-1: [acrobatics, athletics]
equipment: { armor: srd:leather-armor, shield: false, weapons: [srd:rapier, { id: srd:shortbow, count: 20 }] }
`;

/** Fighter 5 (Champion), Human, Soldier: the curated Fighter (Tactical Shift at 5). */
const FIGHTER = `kind: character
id: test:w1c-fighter
name: W1 Fighter
source: synthetic test fixture
rules: '2024'
classes: [{ class: srd:fighter, level: 5, subclass: srd:champion }]
species: srd:human
size: medium
background: srd:soldier
abilities: { str: 19, dex: 13, con: 15, int: 10, wis: 12, cha: 8 }
hp: average
picks:
  srd:fighter#fighting-style: [srd:defense]
  srd:fighter#skills: [acrobatics, animal-handling]
  srd:fighter#weapon-mastery: [srd:longsword, srd:handaxe, srd:greatsword, srd:longbow]
  srd:fighter#asi-4: { asi: { str: 2 } }
  srd:human#skillful: [arcana]
  srd:human#versatile: [srd:alert]
  srd:soldier#tools: ["Gaming Set (Dice)"]
  srd:soldier#abilities: { asi: { con: 1, str: 2 } }
equipment: { armor: srd:chain-mail, shield: true, weapons: [srd:longsword, { id: srd:handaxe, count: 2 }] }
`;
/** The Fighter as an Orc: Relentless Endurance (19928-19931). */
const ORC = FIGHTER.replace('id: test:w1c-fighter', 'id: test:w1c-orc')
  .replace('name: W1 Fighter', 'name: W1 Orc')
  .replace('species: srd:human', 'species: srd:orc')
  .replace('  srd:human#skillful: [arcana]\n  srd:human#versatile: [srd:alert]\n', '');

// ---- Monsters (synthetic) ----

/** A hard hitter: +9 to hit, two 2d12 + 5 Force strikes (Rage's Resistance doesn't halve Force). */
const BRUTE = `kind: monster
id: test:w1c-brute
name: W1 Brute
source: synthetic test fixture
size: medium
cr: 5
pb: 3
ac: 12
hp: { average: 300, formula: 40d10 + 80 }
speed: { walk: 40 }
initiative: { mod: -5, score: 5 }
abilities: { str: 20, dex: 10, con: 14, int: 6, wis: 10, cha: 6 }
multiattack: { alternatives: [[{ count: 2, from: [smash] }]] }
attacks:
  - { id: smash, name: Smash, kind: melee, toHit: 9, damage: [{ roll: 2d12 + 5, type: force, avg: 18 }] }
`;

/** The same, rooted to its square (Speed 0): a square out of its reach is safe. */
const POST = BRUTE.replace('id: test:w1c-brute', 'id: test:w1c-post').replace('name: W1 Brute', 'name: W1 Post').replace('speed: { walk: 40 }', 'speed: { walk: 0 }');

/** The same, slow (Speed 10): it threatens a square within 15 ft next turn, and nothing farther. */
const SLOW = BRUTE.replace('id: test:w1c-brute', 'id: test:w1c-slow').replace('name: W1 Brute', 'name: W1 Slow').replace('speed: { walk: 40 }', 'speed: { walk: 10 }');

const FILES: Record<string, string> = {
  'packs/test/characters/w1c-barbarian.yaml': BARB,
  'packs/test/characters/w1c-barbarian-6.yaml': BARB6,
  'packs/test/characters/w1c-rogue.yaml': ROGUE,
  'packs/test/characters/w1c-fighter.yaml': FIGHTER,
  'packs/test/characters/w1c-orc.yaml': ORC,
  'packs/test/monsters/w1c-brute.yaml': BRUTE,
  'packs/test/monsters/w1c-post.yaml': POST,
  'packs/test/monsters/w1c-slow.yaml': SLOW,
};
/** Chebyshev distance in squares between two cells of a w-wide grid. */
const dist = (w: number, a: number, b: number) => Math.max(Math.abs((a % w) - (b % w)), Math.abs(Math.floor(a / w) - Math.floor(b / w)));
const cellOf = (w: number, name: string) => name.charCodeAt(0) - 65 + (Number(name.slice(1)) - 1) * w;

function load(): Content {
  const r = loadContent([...REPO, ...Object.entries(FILES).map(([path, text]) => ({ path, text }))]);
  if (!r.content) throw new Error(r.errors.map(formatDiag).join('\n'));
  return r.content;
}
const CONTENT = load();

// ---- Fights ----

interface U {
  seat: string;
  team: 'party' | 'enemies';
  use: string;
  at: string;
  hp?: number;
}
interface SetupOpt {
  flags?: Partial<RuleFlags>;
  grid?: { w: number; h: number };
  rounds?: number;
}
function setupOf(units: readonly U[], o: SetupOpt = {}): FightSetup {
  const doc = {
    kind: 'scenario', id: 'w1c', name: 'W1 content', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: o.grid ?? { w: 10, h: 6 },
    flags: { initiativeMode: 'static', ...o.flags }, knobs: { downEnds: false, maxRounds: o.rounds ?? 4 },
    units: units.map((u) => ({ ...u, decider: 'greedy' })),
  };
  const r = resolveScenario(doc, 'w1c.yaml', CONTENT);
  if (!r.setup) throw new Error(r.errors.map(formatDiag).join('\n'));
  return r.setup;
}

/** Steers a seat: return a key to answer with (it must be listed), or undefined to let greedy answer. */
type Steer = (dp: DecisionPoint, keys: readonly string[], view: UnitView) => string | undefined;
class Steered implements Decider {
  readonly name = 'greedy';
  readonly g = new GreedyDecider();
  readonly steer: Steer;
  constructor(steer: Steer) {
    this.steer = steer;
  }
  decide(view: UnitView, dp: DecisionPoint): number {
    const keys: string[] = [];
    for (let i = 0; i < dp.legal.n; i++) keys.push(dp.keyOf(i));
    const want = this.steer(dp, keys, view);
    if (want !== undefined) {
      const i = keys.indexOf(want);
      if (i < 0) throw new Error(`steer: ${want} isn't listed (${keys.join(', ')})`);
      return i;
    }
    return this.g.decide(view, dp);
  }
  explainTo(sink: ((r: unknown) => void) | null): void {
    this.g.explainTo(sink as ((r: ExplainRecord) => void) | null);
  }
}

interface Fought {
  readonly es: readonly GameEvent[];
  readonly recs: readonly ExplainRecord[];
  readonly setup: FightSetup;
  /** idx of a seat's unit. */
  readonly idx: (seat: string) => number;
}
function fight(units: readonly U[], seed: number, o: SetupOpt & { steer?: Record<string, Steer> } = {}): Fought {
  const setup = setupOf(units, o);
  const ds: Decider[] = setup.seats.map((s) => (o.steer?.[s.seat] ? new Steered(o.steer[s.seat]!) : new GreedyDecider()));
  const recs: ExplainRecord[] = [];
  for (const d of ds) d.explainTo!((x) => recs.push(x as ExplainRecord));
  const sink = new ArraySink();
  runFight(setup, seed, 0, ds, sink);
  return { es: sink.events, recs, setup, idx: (seat) => setup.seats.findIndex((s) => s.seat === seat) };
}

type Ev<K extends GameEvent['k']> = Extract<GameEvent, { k: K }>;
const of = <K extends GameEvent['k']>(es: readonly GameEvent[], k: K): Ev<K>[] => es.filter((e): e is Ev<K> => e.k === k);
/** The events of each of `who`'s turns, from its turnStart to its turnEnd. */
function turnsOf(es: readonly GameEvent[], who: number): GameEvent[][] {
  const out: GameEvent[][] = [];
  let cur: GameEvent[] | null = null;
  for (const e of es) {
    if (e.k === 'turnStart' && e.who === who) cur = [];
    if (cur) cur.push(e);
    if (e.k === 'turnEnd' && e.who === who && cur) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}
const acts = (es: readonly GameEvent[], who: number, name: string) => of(es, 'act').filter((e) => e.who === who && e.name === name);
const decided = (es: readonly GameEvent[], who: number, dk: string) => of(es, 'decided').filter((e) => e.who === who && e.dk === dk);
const flagsUsed = (es: readonly GameEvent[]) => of(es, 'fightEnd')[0]!.flagsUsed;

const RAGING = 'srd:barbarian/rage/raging';
const ARMED = 'srd:path-of-the-berserker/frenzy/armed';
const SEEDS = [1, 2, 3, 4, 5];

// ---- P1, P7, P3/P10: Rage, Reckless Attack and Frenzy ----

describe('the Barbarian 5 (Rage 4970-4993, Reckless Attack 5021-5029, Frenzy 5173-5178)', () => {
  // Adjacent to a training dummy that can't move and barely hurts: every turn has a target.
  const vsDummy = (seed: number, o: { steer?: Record<string, Steer> } = {}) =>
    fight([{ seat: 'pc1', team: 'party', use: 'test:w1c-barbarian', at: 'B2' }, { seat: 'dummy', team: 'enemies', use: 'test:training-dummy', at: 'C2' }], seed, { rounds: 5, ...o });

  it('rages on its first turn and keeps the Rage up by attacking: one use, no Bonus Action extension, live to the end (4982-4988)', () => {
    for (const seed of SEEDS) {
      const f = vsDummy(seed);
      const pc = f.idx('pc1');
      const turns = turnsOf(f.es, pc);
      expect(turns.length, `seed ${seed}`).toBe(5);
      const starts = of(f.es, 'fxStart').filter((e) => e.via === RAGING && e.bearer === pc);
      expect(starts, `seed ${seed}: one Rage`).toHaveLength(1);
      expect(turns[0]!.includes(starts[0]!), `seed ${seed}: on turn 1`).toBe(true);
      expect(of(f.es, 'fxEnd').filter((e) => e.fx === starts[0]!.fx), `seed ${seed}: never ends`).toEqual([]);
      for (const t of turns) expect(of(t, 'attack').filter((e) => e.att === pc).length, `seed ${seed}: attacks every turn`).toBeGreaterThan(0);
      // An attack roll against an enemy extends it, so the Bonus Action extension is never spent (W1.2 fix).
      expect(acts(f.es, pc, 'Extend Rage'), `seed ${seed}`).toEqual([]);
    }
  });

  it('Frenzy fires once per turn, with Rage and Reckless Attack, on the first Strength hit after the declaration (5173-5175)', () => {
    let fired = 0;
    for (const seed of SEEDS) {
      const f = vsDummy(seed);
      const pc = f.idx('pc1');
      for (const t of turnsOf(f.es, pc)) {
        const frenzy = acts(t, pc, 'Frenzy');
        expect(frenzy.length).toBeLessThanOrEqual(1);
        if (frenzy.length === 0) continue;
        fired++;
        // Reckless Attack was declared this turn while raging: the armed effect started.
        expect(acts(t, pc, 'Reckless Attack')).toHaveLength(1);
        expect(of(t, 'fxStart').some((e) => e.via === ARMED)).toBe(true);
        // It rides the first hit of the turn: no attack between that hit and the Frenzy line.
        const at = t.indexOf(frenzy[0]!);
        const hits = t.filter((e): e is Ev<'attack'> => e.k === 'attack' && e.att === pc && e.hit);
        expect(hits.length).toBeGreaterThan(0);
        const first = t.indexOf(hits[0]!);
        expect(first).toBeLessThan(at);
        expect(t.slice(first + 1, at).some((e) => e.k === 'attack')).toBe(false);
      }
    }
    expect(fired).toBeGreaterThan(5);
  });

  it('Reckless Attack gives Advantage on its Strength attack rolls this turn, and attack rolls against it have Advantage (5022, 5028-5029)', () => {
    let declared = 0;
    for (const seed of SEEDS) {
      const f = vsDummy(seed);
      const pc = f.idx('pc1');
      const dummy = f.idx('dummy');
      const turns = turnsOf(f.es, pc);
      for (const t of turns) {
        if (acts(t, pc, 'Reckless Attack').length === 0) continue;
        declared++;
        // Every Strength attack after the declaration (all of this build's are) rolls with Advantage
        // unless something else cancels it; the dummy imposes nothing.
        const at = t.indexOf(acts(t, pc, 'Reckless Attack')[0]!);
        for (const a of of(t.slice(at), 'attack').filter((e) => e.att === pc)) expect(a.advSrc).toContain('srd:barbarian/reckless-attack/reckless');
        // The dummy's next attack roll against it has Advantage too.
        const next = f.es.slice(f.es.indexOf(t.at(-1)!)).find((e): e is Ev<'attack'> => e.k === 'attack' && e.att === dummy);
        if (next) expect(next.advSrc).toContain('srd:barbarian/reckless-attack/reckless');
      }
    }
    expect(declared).toBeGreaterThan(5);
  });

  it("Frenzy doesn't fire when Rage starts after Reckless Attack is declared (frenzyRageCheck: declaration)", () => {
    // Turn 1, steered: attack and declare Reckless Attack, then Rage as the Bonus Action.
    const steer: Steer = (dp, keys, view) => {
      const me = view.q.units[view.me]!;
      if (me.turns !== 1) return undefined;
      if (dp.k === 'firstAttack') return keys.find((k) => k.startsWith('first:'));
      if (dp.k !== 'turn') return undefined;
      if (me.b.action > 0) return keys.find((k) => k.startsWith('attack:greataxe>'));
      return keys.includes('use:barbarian/rage') ? 'use:barbarian/rage' : undefined;
    };
    for (const seed of SEEDS) {
      const f = vsDummy(seed, { steer: { pc1: steer } });
      const pc = f.idx('pc1');
      const t1 = turnsOf(f.es, pc)[0]!;
      expect(acts(t1, pc, 'Reckless Attack')).toHaveLength(1);
      expect(of(t1, 'fxStart').some((e) => e.via === RAGING)).toBe(true);
      expect(acts(t1, pc, 'Frenzy'), `seed ${seed}`).toEqual([]);
      expect(of(t1, 'fxStart').some((e) => e.via === ARMED)).toBe(false);
      expect(flagsUsed(f.es)).toContain('frenzyRageCheck');
    }
  });

  it('greedy declines Reckless Attack against heavy hitters, and takes it against the dummy (5022, 5028-5029)', () => {
    const vsBrutes = fight(
      [
        { seat: 'pc1', team: 'party', use: 'test:w1c-barbarian', at: 'C3' },
        { seat: 'b1', team: 'enemies', use: 'test:w1c-brute', at: 'B3' },
        { seat: 'b2', team: 'enemies', use: 'test:w1c-brute', at: 'D3' },
        { seat: 'b3', team: 'enemies', use: 'test:w1c-brute', at: 'C2' },
      ],
      1,
      { rounds: 2 },
    );
    const pc = vsBrutes.idx('pc1');
    const asked = decided(vsBrutes.es, pc, 'firstAttack');
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.map((e) => e.key)).toEqual(asked.map(() => 'pass'));
    const easy = vsDummy(1);
    expect(decided(easy.es, easy.idx('pc1'), 'firstAttack').some((e) => e.key === 'first:barbarian/reckless-attack')).toBe(true);
  });
});

// ---- P5, P6, P10, P9: Sneak Attack and Cunning Strike's Withdraw ----

describe('the Rogue 5 (Sneak Attack 13736-13743, Cunning Strike 13811-13817, Withdraw 13835-13836)', () => {
  /** The Rogue must step up to the Ogre (so no Steady Aim); a Guard may stand by the Ogre. */
  const units = (ally: boolean): U[] => [
    { seat: 'pc1', team: 'party', use: 'test:w1c-rogue', at: 'B2' },
    ...(ally ? [{ seat: 'al', team: 'party' as const, use: 'srd:guard', at: 'E3', hp: 200 }] : []),
    { seat: 'm1', team: 'enemies', use: 'srd:ogre', at: 'D2' },
  ];
  /** Each of pc's hits with its roll state and whether a Sneak Attack rider was asked and taken right after it. */
  function hits(f: Fought) {
    const pc = f.idx('pc1');
    const out: { adv: string; asked: boolean; taken: boolean }[] = [];
    f.es.forEach((e, i) => {
      if (e.k !== 'attack' || e.att !== pc || !e.hit) return;
      const next = f.es.slice(i + 1).find((x) => x.k === 'attack' || (x.k === 'decided' && x.who === pc && x.dk === 'rider'));
      const d = next?.k === 'decided' ? next : null;
      out.push({ adv: e.adv, asked: d !== null && d.key.startsWith('rider:sneak-attack'), taken: d !== null && d.key.startsWith('rider:sneak-attack') && d.key !== 'pass' });
    });
    return out;
  }

  it('without Advantage, greedy takes Sneak Attack when an ally is within 5 feet of the target (13741-13742)', () => {
    const plain = SEEDS.flatMap((seed) => hits(fight(units(true), seed, { rounds: 2 }))).filter((h) => h.adv === 'none');
    expect(plain.length).toBeGreaterThan(0);
    for (const h of plain) expect(h).toEqual({ adv: 'none', asked: true, taken: true });
  });

  it('with Advantage from Steady Aim and no ally, greedy takes Sneak Attack (13738, 13790-13791)', () => {
    let saw = 0;
    for (const seed of SEEDS) {
      const f = fight([{ seat: 'pc1', team: 'party', use: 'test:w1c-rogue', at: 'B2' }, { seat: 'dummy', team: 'enemies', use: 'test:training-dummy', at: 'C2' }], seed, { rounds: 1 });
      const pc = f.idx('pc1');
      const t1 = turnsOf(f.es, pc)[0]!;
      expect(acts(t1, pc, 'Steady Aim')).toHaveLength(1);
      const first = of(t1, 'attack').find((e) => e.att === pc)!;
      expect(first.adv).toBe('adv');
      if (!first.hit) continue;
      saw++;
      expect(hits(f)[0]).toEqual({ adv: 'adv', asked: true, taken: true });
    }
    expect(saw).toBeGreaterThan(2);
  });

  it('without Advantage and with no ally by the target, it isn\'t offered (13738-13743)', () => {
    const plain = SEEDS.flatMap((seed) => hits(fight(units(false), seed, { rounds: 2 }))).filter((h) => h.adv === 'none');
    expect(plain.length).toBeGreaterThan(0);
    for (const h of plain) expect(h.asked).toBe(false);
  });

  it('Withdraw: one die fewer, then a half-Speed move that provokes nothing, even after the hit kills (13811-13817, 13835-13836)', () => {
    // The Rogue stands between a Goblin Warrior at 1 HP and a rooted brute; the Guard is by the goblin.
    const steer: Steer = (dp, keys, view) => {
      const me = view.q.units[view.me]!;
      if (me.turns !== 1) return undefined;
      if (dp.k === 'turn' && me.b.action > 0) return keys.find((k) => k.startsWith('attack:rapier>gob'));
      if (dp.k === 'rider') return keys.find((k) => k.endsWith('/withdraw'));
      if (dp.k === 'turn' && me.b.freeFt > 0) after.push(keys.includes('use:rogue/steady-aim'));
      return undefined;
    };
    const after: boolean[] = [];
    let seen = 0;
    for (const seed of SEEDS) {
      const f = fight(
        [
          { seat: 'pc1', team: 'party', use: 'test:w1c-rogue', at: 'C3' },
          { seat: 'al', team: 'party', use: 'srd:guard', at: 'B2', hp: 200 },
          { seat: 'gob', team: 'enemies', use: 'srd:goblin-warrior', at: 'B3', hp: 1 },
          { seat: 'm1', team: 'enemies', use: 'test:w1c-post', at: 'D3' },
        ],
        seed,
        { rounds: 1, steer: { pc1: steer } },
      );
      const pc = f.idx('pc1');
      const t1 = turnsOf(f.es, pc)[0]!;
      const hit = of(t1, 'attack').find((e) => e.att === pc && e.hit);
      if (!hit) continue;
      seen++;
      const rider = decided(t1, pc, 'rider')[0]!;
      expect(rider.key).toMatch(/\/withdraw$/);
      // The extra damage is the weapon's type (13739): the Rapier's Piercing.
      const dmg = of(t1, 'damage').find((e) => e.src === pc)!;
      expect(dmg.parts.length).toBe(2);
      expect(dmg.parts.map((x) => x.type)).toEqual(['piercing', 'piercing']);
      // The goblin dies, and the Rogue still moves: a moveTo decision, steps, no opportunity attack.
      expect(of(t1, 'death').some((e) => e.who === f.idx('gob'))).toBe(true);
      const moveTo = decided(t1, pc, 'moveTo');
      expect(moveTo).toHaveLength(1);
      expect(moveTo[0]!.key).toMatch(/^moveTo:/);
      expect(of(t1, 'step').filter((e) => e.who === pc).length).toBeGreaterThan(0);
      expect(of(t1, 'provoke').filter((e) => e.mover === pc)).toEqual([]);
      // Greedy takes it out of the brute's reach (no square within 5 ft of D3).
      const end = of(t1, 'moveEnd').filter((e) => e.who === pc).at(-1)!;
      expect(dist(f.setup.w, end.cell, cellOf(f.setup.w, 'D3'))).toBeGreaterThan(1);
    }
    expect(seen).toBeGreaterThan(1);
    // The free move is moving: Steady Aim ("if you haven't moved during this turn", 13792-13793) isn't offered after it.
    expect(after.length).toBeGreaterThan(0);
    expect(after).not.toContain(true);
  });

  it('Cunning Strike is an option of Sneak Attack\'s one rider: Withdraw forgoes one of the Rogue 5\'s 3d6 (13811-13816)', () => {
    const r = CONTENT.get('test:w1c-rogue')!.riders!.find((x) => x.local === 'sneak-attack')!;
    expect(r.opts.map((o) => [o.local, JSON.stringify((o.extra ?? []).map((x) => x.roll)), o.steps.map((x) => x.k)])).toEqual([
      ['sneak-attack', JSON.stringify([{ k: 'dice', n: 3, sides: 6 }]), []],
      ['withdraw', JSON.stringify([{ k: 'dice', n: 2, sides: 6 }]), ['move']],
    ]);
    expect(r.once).toBe('global');
  });
});

// ---- P9: Tactical Shift ----

describe('the Fighter 5 (Tactical Shift 10661-10663)', () => {
  it('after its attacks, a Bonus Action Second Wind moves it half its Speed out of reach without provoking; its Speed stays whole (freeMoveUsesMovement: false)', () => {
    const left: { moveFt: number; movedFt: number }[] = [];
    let winded = false;
    const steer: Steer = (dp, keys, view) => {
      const me = view.q.units[view.me]!;
      if (me.turns !== 1 || dp.k !== 'turn') return undefined;
      if (winded) {
        left.push({ moveFt: me.b.moveFt, movedFt: me.b.movedFt });
        return 'pass';
      }
      const atk = keys.find((k) => k.startsWith('attack:longsword>'));
      if (atk) return atk;
      winded = true;
      return 'use:fighter/second-wind';
    };
    for (const seed of SEEDS) {
      left.length = 0;
      winded = false;
      const f = fight(
        [
          { seat: 'pc1', team: 'party', use: 'test:w1c-fighter', at: 'C3', hp: 10 },
          { seat: 'm1', team: 'enemies', use: 'test:w1c-post', at: 'D3' },
        ],
        seed,
        { rounds: 1, steer: { pc1: steer } },
      );
      const pc = f.idx('pc1');
      const t1 = turnsOf(f.es, pc)[0]!;
      expect(acts(t1, pc, 'Second Wind')).toHaveLength(1);
      const moveTo = decided(t1, pc, 'moveTo');
      expect(moveTo).toHaveLength(1);
      expect(moveTo[0]!.key).toMatch(/^moveTo:/);
      const steps = of(t1, 'step').filter((e) => e.who === pc);
      expect(steps.length).toBeGreaterThan(0);
      expect(steps.reduce((n, e) => n + e.ft, 0)).toBeLessThanOrEqual(15);
      expect(of(t1, 'provoke').filter((e) => e.mover === pc)).toEqual([]);
      // Normal movement is whole after the free move.
      expect(left[0], `seed ${seed}`).toEqual({ moveFt: 30, movedFt: 0 });
      expect(flagsUsed(f.es)).toContain('freeMoveUsesMovement');
      // Greedy ends it out of the brute's reach.
      const end = of(t1, 'moveEnd').filter((e) => e.who === pc).at(-1)!;
      expect(dist(f.setup.w, end.cell, cellOf(f.setup.w, 'D3'))).toBeGreaterThan(1);
    }
  });
});

// ---- P8: Relentless Endurance ----

describe('the Orc (Relentless Endurance 19928-19931)', () => {
  it('reduced to 0 but not killed outright, it drops to 1 instead, once (19928-19931)', () => {
    let saw = 0;
    for (const seed of SEEDS) {
      const f = fight(
        [
          { seat: 'pc1', team: 'party', use: 'test:w1c-orc', at: 'C3', hp: 20 },
          { seat: 'b1', team: 'enemies', use: 'test:w1c-brute', at: 'D3' },
        ],
        seed,
        { rounds: 3 },
      );
      const pc = f.idx('pc1');
      const used = acts(f.es, pc, 'Relentless Endurance');
      expect(used.length).toBeLessThanOrEqual(1);
      if (used.length === 0) continue;
      saw++;
      // The damage event before it left the Orc at 1 HP, not 0, and no drop came with it.
      const i = f.es.indexOf(used[0]!);
      const dmg = f.es.slice(0, i).filter((e): e is Ev<'damage'> => e.k === 'damage' && e.tgt === pc).at(-1)!;
      expect(dmg.hpAfter).toBe(1);
      expect(f.es.slice(f.es.indexOf(dmg), i).some((e) => e.k === 'down' && e.who === pc)).toBe(false);
      // Its one use is spent: a later drop to 0 is a real drop.
      const later = f.es.slice(i).filter((e): e is Ev<'damage'> => e.k === 'damage' && e.tgt === pc && e.hpAfter === 0);
      if (later.length > 0) expect(of(f.es.slice(i), 'down').some((e) => e.who === pc) || of(f.es.slice(i), 'death').some((e) => e.who === pc)).toBe(true);
    }
    expect(saw).toBeGreaterThan(2);
  });
});

// ---- Explain: every new greedy term's line, read from real decisions ----

/** A constructed turn on real content: greedy decides `who`'s turn with only the listed keys offered, so each makes Explain's top 3. */
function scene(units: readonly U[], o: SetupOpt = {}) {
  const setup = setupOf(units, o);
  const ds = setup.seats.map(() => new GreedyDecider());
  const sink = new ArraySink();
  const cx = createContext(setup, 1, 0, ds, sink);
  applyPassives(cx, -1);
  const recs: ExplainRecord[] = [];
  for (const d of ds) d.explainTo((x) => recs.push(x));
  const u = (seat: string): Unit => cx.st.units.find((x) => x.seat === seat)!;
  units.forEach((x, i) => (cx.st.order[i] = u(x.seat).idx));
  cx.st.round = 1;
  const begin = (who: Unit, patch: Partial<Unit['b']> = {}) => {
    cx.st.active = who.idx;
    cx.st.turnIdx++;
    who.turns++;
    Object.assign(who.b, { action: 1, bonus: 1, reaction: 1, freeObj: 1, moveFt: who.tpl.speedFt, atkActive: false, movedFt: 0, rolls: 0, freeFt: 0, ...patch });
  };
  const listed = (who: Unit) => {
    const list = listOptions(cx, who, takeList(cx));
    const out: { key: string; l: Legal }[] = [];
    for (let i = 0; i < list.n; i++) out.push({ key: legalKey(cx.st, who.idx, list.items[i]!), l: copyLegal(list.items[i]!, newLegal()) });
    releaseList(cx, list);
    return out;
  };
  const decide = (who: Unit, keep: readonly string[]): ExplainRecord => {
    const items = listed(who).filter((x) => keep.includes(x.key));
    expect(items.map((x) => x.key).sort()).toEqual([...keep].sort());
    const dp: DecisionPoint = { k: 'turn', who: who.idx, at: 0, round: cx.st.round, cause: -1, legal: { n: items.length, items: items.map((x) => x.l) }, keyOf: (i) => items[i]!.key };
    recs.length = 0;
    ds[who.idx]!.decide(cx.views[who.idx]!, dp);
    return recs.at(-1)!;
  };
  const take = (who: Unit, key: string) => {
    const l = listed(who).find((x) => x.key === key);
    if (!l) throw new Error(`${key} isn't listed`);
    resolveOption(cx, who, l.l, -1);
  };
  /** Every key listed for `who` now. */
  const keysOf = (who: Unit) => listed(who).map((x) => x.key);
  return { cx, u, begin, decide, take, keysOf, es: sink.events };
}
const terms = (rec: ExplainRecord, key: string): string[] => rec.top.find((t) => t.key === key)!.parts.map((p) => p.term);

describe('Explain lines of the W1 greedy terms on real decisions (C6)', () => {
  it('Rage: sustained, and Rage Damage per expected hit (P1, P3)', () => {
    const s = scene([{ seat: 'pc1', team: 'party', use: 'test:w1c-barbarian', at: 'B2' }, { seat: 'dummy', team: 'enemies', use: 'test:training-dummy', at: 'C2' }]);
    s.begin(s.u('pc1'));
    const rec = s.decide(s.u('pc1'), ['use:barbarian/rage', 'pass']);
    expect(rec.chosen).toBe('use:barbarian/rage');
    const t = terms(rec, 'use:barbarian/rage');
    expect(t).toContain('sustained: its expected rounds past this one (kept up by an attack roll, a save or a Bonus Action)');
    expect(t).toContain('riders it switches on, per expected hit (strikes x P(hit)) over once a round');
  });

  it('Extend Rage: keeps it a round when no attack roll is coming this turn, and is worth nothing when one is (P1, 4990)', () => {
    const far = scene(
      [{ seat: 'pc1', team: 'party', use: 'test:w1c-barbarian', at: 'A1' }, { seat: 'dummy', team: 'enemies', use: 'test:training-dummy', at: 'T6' }],
      { grid: { w: 20, h: 6 } },
    );
    const pc = far.u('pc1');
    far.begin(pc);
    far.take(pc, 'use:barbarian/rage');
    far.begin(pc); // the next turn: it ends at this turn's end unless extended
    const ext = 'use:pc1/raging/extend';
    const rec = far.decide(pc, [ext, 'pass']);
    expect(rec.chosen).toBe(ext);
    expect(terms(rec, ext)).toContain('extend: keeps it a round (it would end at the end of this turn)');
    const near = scene([{ seat: 'pc1', team: 'party', use: 'test:w1c-barbarian', at: 'B2' }, { seat: 'dummy', team: 'enemies', use: 'test:training-dummy', at: 'C2' }]);
    const p2 = near.u('pc1');
    near.begin(p2);
    near.take(p2, 'use:barbarian/rage');
    near.begin(p2);
    const r2 = near.decide(p2, [ext, 'pass', 'attack:greataxe>dummy']);
    expect(r2.chosen).toBe('attack:greataxe>dummy');
    expect(r2.top.some((t) => t.key === ext)).toBe(false); // worth nothing, so not offered on a tie with pass
  });

  it('Mindless Rage: entering Rage ends Frightened on me, and I stay immune while it lasts (5182-5184)', () => {
    const s = scene([{ seat: 'pc1', team: 'party', use: 'test:w1c-barbarian-6', at: 'B2' }, { seat: 'dummy', team: 'enemies', use: 'test:training-dummy', at: 'C2' }]);
    const pc = s.u('pc1');
    addCond(pc, COND.frightened, 'test:fear', s.u('dummy').idx, -1, { k: 'never' });
    s.begin(pc);
    const rec = s.decide(pc, ['use:barbarian/rage', 'pass']);
    expect(terms(rec, 'use:barbarian/rage').some((t) => /^ends .*Frightened.* on me$/.test(t))).toBe(true);
    s.take(pc, 'use:barbarian/rage');
    expect(pc.condMask & COND.frightened).toBe(0);
    expect(of(s.es, 'cond').filter((e) => e.who === pc.idx).map((e) => [e.cond, e.on])).toEqual([['core:frightened', false]]);
    expect(condImmunity(s.cx.st, pc) & (COND.frightened | COND.charmed)).toBe(COND.frightened | COND.charmed);
    expect(of(s.es, 'fxStart').some((e) => e.via.startsWith('srd:path-of-the-berserker/mindless-rage/'))).toBe(true);
  });

  it('Steady Aim: Advantage on my next attack roll, with the Sneak Attack it unlocks (P11, 13790-13791)', () => {
    const s = scene([{ seat: 'pc1', team: 'party', use: 'test:w1c-rogue', at: 'B2' }, { seat: 'dummy', team: 'enemies', use: 'test:training-dummy', at: 'C2' }]);
    s.begin(s.u('pc1'));
    const rec = s.decide(s.u('pc1'), ['use:rogue/steady-aim', 'pass']);
    expect(rec.chosen).toBe('use:rogue/steady-aim');
    expect(terms(rec, 'use:rogue/steady-aim')).toContain('Advantage on my next attack roll (the riders it unlocks included)');
    // After the Attack action is spent it's worth nothing (W1.2 fix), so it isn't taken.
    s.begin(s.u('pc1'), { action: 0 });
    expect(s.decide(s.u('pc1'), ['use:rogue/steady-aim', 'pass']).chosen).toBe('pass');
  });

  it('Second Wind with Tactical Shift: the free move it brings (P9)', () => {
    const s = scene([{ seat: 'pc1', team: 'party', use: 'test:w1c-fighter', at: 'C3', hp: 10 }, { seat: 'm1', team: 'enemies', use: 'test:w1c-post', at: 'D3' }]);
    s.begin(s.u('pc1'), { action: 0 });
    const rec = s.decide(s.u('pc1'), ['use:fighter/second-wind', 'pass']);
    expect(terms(rec, 'use:fighter/second-wind')).toContain('free move (no opportunity attacks): the exposure it takes off');
  });

  it('Relentless Endurance: the drop risk it takes off, on the pass row (P8)', () => {
    const s = scene([{ seat: 'pc1', team: 'party', use: 'test:w1c-orc', at: 'C3', hp: 10 }, { seat: 'm1', team: 'enemies', use: 'test:w1c-post', at: 'D3' }]);
    s.begin(s.u('pc1'), { action: 0, bonus: 0 });
    const rec = s.decide(s.u('pc1'), ['pass']);
    expect(terms(rec, 'pass').some((t) => /^drops to 1 instead \(once\): its drop risk here, \d+\.\d\d, isn't counted$/.test(t))).toBe(true);
  });

  it('Reckless Attack and the free move, from the fights above: their decision rows (P7, P9)', () => {
    const brutes = fight(
      [
        { seat: 'pc1', team: 'party', use: 'test:w1c-barbarian', at: 'C3' },
        { seat: 'b1', team: 'enemies', use: 'test:w1c-brute', at: 'B3' },
        { seat: 'b2', team: 'enemies', use: 'test:w1c-brute', at: 'D3' },
      ],
      1,
      { rounds: 1 },
    );
    const first = brutes.recs.find((r) => r.top.some((t) => t.key === 'first:barbarian/reckless-attack'))!;
    expect(terms(first, 'first:barbarian/reckless-attack')[0]).toMatch(/^Reckless Attack: my Advantage \+\d+\.\d\d, theirs -\d+\.\d\d$/);
    const shift = fight(
      [
        { seat: 'pc1', team: 'party', use: 'test:w1c-fighter', at: 'C3', hp: 10 },
        { seat: 'm1', team: 'enemies', use: 'test:w1c-post', at: 'D3' },
      ],
      1,
      { rounds: 1, steer: { pc1: (dp, keys, view) => (dp.k === 'turn' && view.q.units[view.me]!.b.action === 0 && keys.includes('use:fighter/second-wind') ? 'use:fighter/second-wind' : undefined) } },
    );
    const move = shift.recs.find((r) => r.top.some((t) => t.key.startsWith('moveTo:')))!;
    expect(move.chosen).toMatch(/^moveTo:/);
    expect(terms(move, move.chosen)[0]).toMatch(/^free move to [A-Z]\d+: [-+]\d+\.\d\d exposure \(exposure there\)$/);
  });
});

// ---- W1 review fixes (findings 5, 6, 7 of the W1.3 review) ----

describe('W1 review: greedy turn order around Rage, Steady Aim and Extend Rage', () => {
  const vsDummy = (seed: number) =>
    fight([{ seat: 'pc1', team: 'party', use: 'test:w1c-barbarian', at: 'B2' }, { seat: 'dummy', team: 'enemies', use: 'test:training-dummy', at: 'C2' }], seed, { rounds: 2 });

  it('Rage comes before the first attack roll on turn 1, so its Rage Damage counts and Reckless Attack arms Frenzy that turn (4972-4977, 5173-5175)', () => {
    let fired = 0;
    for (const seed of SEEDS) {
      const f = vsDummy(seed);
      const pc = f.idx('pc1');
      const t1 = turnsOf(f.es, pc)[0]!;
      const rage = t1.findIndex((e) => e.k === 'fxStart' && e.via === RAGING && e.bearer === pc);
      const first = t1.findIndex((e) => e.k === 'attack' && e.att === pc);
      expect(rage, `seed ${seed}: rages on turn 1`).toBeGreaterThanOrEqual(0);
      expect(first, `seed ${seed}: attacks on turn 1`).toBeGreaterThanOrEqual(0);
      expect(rage, `seed ${seed}: before the first attack roll`).toBeLessThan(first);
      // Reckless Attack is declared while raging: Frenzy is armed this turn (frenzyRageCheck: declaration).
      expect(acts(t1, pc, 'Reckless Attack'), `seed ${seed}`).toHaveLength(1);
      expect(of(t1, 'fxStart').some((e) => e.via === ARMED), `seed ${seed}: Frenzy armed on turn 1`).toBe(true);
      if (of(t1, 'attack').some((e) => e.att === pc && e.hit)) {
        expect(acts(t1, pc, 'Frenzy'), `seed ${seed}`).toHaveLength(1);
        fired++;
      }
    }
    expect(fired).toBeGreaterThan(0);
  });

  it('the Rage row on the turn decision: its value, then the strike routine it comes before (Explain)', () => {
    const s = scene([{ seat: 'pc1', team: 'party', use: 'test:w1c-barbarian', at: 'B2' }, { seat: 'dummy', team: 'enemies', use: 'test:training-dummy', at: 'C2' }]);
    s.begin(s.u('pc1'));
    const rec = s.decide(s.u('pc1'), ['use:barbarian/rage', 'attack:greataxe>dummy', 'pass']);
    expect(rec.chosen).toBe('use:barbarian/rage');
    expect(terms(rec, 'use:barbarian/rage')).toContain('before my first attack roll: then my best strike routine this turn (or staying), with it on');
  });

  it('a Rogue that can Steady Aim where it stands never credits a move with Steady Aim, which moving makes illegal (13792-13793)', () => {
    // The slow brute 10 ft away can reach it here next turn, not on the A column 20 ft away, which a
    // step around the dummy reaches without leaving the dummy's reach (no opportunity attack).
    const units: U[] = [
      { seat: 'pc1', team: 'party', use: 'test:w1c-rogue', at: 'C3' },
      { seat: 'dummy', team: 'enemies', use: 'test:training-dummy', at: 'B3' },
      { seat: 'm1', team: 'enemies', use: 'test:w1c-slow', at: 'E3' },
    ];
    const s = scene(units, { grid: { w: 12, h: 6 } });
    const pc = s.u('pc1');
    s.begin(pc);
    const keys = s.keysOf(pc).filter((k) => k === 'use:rogue/steady-aim' || k === 'pass' || k.startsWith('move:'));
    expect(keys).toContain('use:rogue/steady-aim');
    expect(keys.some((k) => k.startsWith('move:'))).toBe(true);
    const rec = s.decide(pc, keys);
    for (const t of rec.top) if (t.key.startsWith('move:')) expect(t.parts.map((p) => p.term), t.key).not.toContain('best program from there');
    // So the step it takes, if any, is for the strike from there, and Steady Aim isn't left behind for a plain shot.
    if (rec.chosen.startsWith('move:')) expect(terms(rec, rec.chosen).some((x) => / strike\(s\) from there/.test(x))).toBe(true);
  });

  it('a raging Barbarian with no attack roll this turn keeps Rage up with its Bonus Action: one Rage use over the fight (4990)', () => {
    // 125 ft apart: Rage on turn 1 (steered, then it holds still); turn 2 can't reach the dummy even with a Dash.
    const steer: Steer = (dp, keys, view) => {
      const me = view.q.units[view.me]!;
      if (me.turns !== 1 || dp.k !== 'turn') return undefined;
      return keys.includes('use:barbarian/rage') ? 'use:barbarian/rage' : 'pass';
    };
    for (const seed of SEEDS.slice(0, 3)) {
      const f = fight(
        [{ seat: 'pc1', team: 'party', use: 'test:w1c-barbarian', at: 'A1' }, { seat: 'dummy', team: 'enemies', use: 'test:training-dummy', at: 'Z26' }],
        seed,
        { grid: { w: 26, h: 26 }, rounds: 4, steer: { pc1: steer } },
      );
      const pc = f.idx('pc1');
      const turns = turnsOf(f.es, pc);
      expect(of(turns[1]!, 'attack').filter((e) => e.att === pc), `seed ${seed}: turn 2 is out of reach`).toEqual([]);
      expect(acts(turns[1]!, pc, 'Extend Rage'), `seed ${seed}: extended on turn 2`).toHaveLength(1);
      expect(of(f.es, 'fxStart').filter((e) => e.via === RAGING && e.bearer === pc), `seed ${seed}: one Rage use`).toHaveLength(1);
    }
  });
});
