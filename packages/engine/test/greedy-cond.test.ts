// Greedy valuation of M3 step 4's primitives (docs/design/m3.md critique C6; decide/greedy/cond.ts):
// for each primitive a constructed state where greedy picks it over a plausible alternative (and
// a twin state where the alternative wins), each condition's terms named for the rule effect they
// count (SRD 5.2.1 Rules Glossary, srd-raw.txt lines), and Explain listing every new term by name.
// Content is synthetic (test: ids) on the sample fighter, compiled from YAML with the repo packs.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../src/content/load.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import type { DecisionPoint, Legal } from '../src/decide/decider.ts';
import { GreedyDecider, type ExplainRecord } from '../src/decide/greedy/greedy.ts';
import { parseCell } from '../src/grid/cells.ts';
import { resolveScenario } from '../src/scenario/resolve.ts';
import { copyLegal, legalKey, newLegal, releaseList, takeList } from '../src/sim/context.ts';
import { newFx } from '../src/sim/effects.ts';
import { createContext } from '../src/sim/fight.ts';
import { listOptions } from '../src/sim/options.ts';
import { COND, has, type Unit } from '../src/sim/state.ts';
import { newFrame, runSteps } from '../src/sim/steps.ts';

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
const FIGHTER = 'packs/test/pcs/sample-fighter.yaml';
const FIGHTER_TEXT = REPO.find((f) => f.path === FIGHTER)!.text;

/** An action (or `cost`) activation: a target step, then `steps`, under a root effect `hold` (10 rounds). */
const act = (id: string, target: string, steps: string, extra = '', cost = 'action') => `kind: feature
id: test:${id}
name: ${id}
source: synthetic test fixture
spellAbility: wis
activate:
  id: go
  name: ${id}
  cost: ${cost}
  root: hold
  do:
    - ${target}
${steps}
effects:
  - id: hold
    name: Hold
    duration: { rounds: 10 }
${extra}`;
const ON_FOE = '{ target: { range: 5, who: enemy, self: no } }';
const ON_SELF = '{ target: { range: 5, who: any, self: yes } }';
const cond = (c: string, more = '') => `    - { condition: { id: ${c}${more} } }`;
/** A self-applied effect `b` with `fields`, lasting `rounds`. */
const selfFx = (id: string, fields: string, rounds = 1) => act(id, ON_SELF, '    - { apply: { effect: b, to: self } }', `  - id: b\n    name: ${id}\n    duration: { rounds: ${rounds} }\n${fields}\n`);

const KNIGHT_IMMUNE = `kind: monster
id: test:stun-proof-knight
name: Stun-proof Knight
source: synthetic test fixture
size: medium
cr: 3
pb: 2
ac: 18
hp: { average: 52, formula: 8d8 + 16 }
speed: { walk: 30 }
initiative: { mod: 0, score: 10 }
abilities: { str: 16, dex: 11, con: 14, int: 11, wis: 11, cha: 15 }
conditionImmune: [stunned, incapacitated]
attacks:
  - id: greatsword
    name: Greatsword
    kind: melee
    toHit: 5
    reach: 5
    damage:
      - { roll: 2d6 + 3, type: slashing, avg: 10 }
multiattack:
  alternatives:
    - [{ count: 2, from: [greatsword] }]
`;

const CONDS = ['blinded', 'charmed', 'frightened', 'paralyzed', 'poisoned', 'prone', 'restrained', 'stunned'] as const;
const FEATURES: Record<string, string> = {
  ...Object.fromEntries(CONDS.map((c) => [`packs/test/data/g-${c}.yaml`, act(`g-${c}`, ON_FOE, cond(c))])),
  'packs/test/data/g-stun.yaml': act('g-stun', ON_FOE, cond('stunned', ', save: { ability: con, dc: 40, at: turnEnd }')),
  'packs/test/data/g-stun-easy.yaml': act('g-stun-easy', ON_FOE, cond('stunned', ', save: { ability: con, dc: 1, at: turnEnd }')),
  'packs/test/data/g-brace.yaml': selfFx('g-brace', '    stats: [{ ac: 5 }]'),
  'packs/test/data/g-brace-own.yaml': selfFx('g-brace-own', '    stats: [{ ac: 5, when: [ownTurn] }]'),
  'packs/test/data/g-ward-slash.yaml': selfFx('g-ward-slash', '    stats: [{ resist: [slashing] }]', 3),
  'packs/test/data/g-ward-fire.yaml': selfFx('g-ward-fire', '    stats: [{ resist: [fire] }]', 3),
  'packs/test/data/g-hobble.yaml': act('g-hobble', '{ target: { range: 60, who: enemy, self: no } }', '    - { apply: { effect: h, to: target } }', '  - id: h\n    name: Hobble\n    duration: { rounds: 10 }\n    stats: [{ speed: zero }]\n'),
  'packs/test/data/g-shore.yaml': act('g-shore', ON_SELF, `    - { tempHp: '10' }`),
  'packs/test/data/g-net.yaml': act('g-net', '{ target: { range: 60, who: enemy, self: no } }', cond('restrained', ', escape: { check: { ability: str, skills: [athletics] }, dc: 1, cost: action }')),
  'packs/test/data/g-net-hard.yaml': act('g-net-hard', '{ target: { range: 60, who: enemy, self: no } }', cond('restrained', ', escape: { check: { ability: str, skills: [athletics] }, dc: 40, cost: action }')),
  'packs/test/monsters/stun-proof-knight.yaml': KNIGHT_IMMUNE,
  // Restrained imposed by a bearer hook at the end of each of the target's turns (for as long as the effect lasts).
  'packs/test/data/g-hook-restrain.yaml': act('g-hook-restrain', ON_FOE, '    - { apply: { effect: z, to: target } }', '  - id: z\n    name: Clinging\n    on: [{ when: [turnEnd], do: [{ condition: { id: restrained } }] }]\n'),
};

type U = { seat: string; team: 'party' | 'enemies'; use: string; at: string; hp?: number };

/** A fight where pc1 (the sample fighter) has `features`; every seat is greedy, with an explain sink. */
function scene(features: string[], units: U[]) {
  const pc = `${FIGHTER_TEXT}features: [${features.map((f) => `test:${f}`).join(', ')}]\n`;
  const files = [...REPO.filter((f) => f.path !== FIGHTER), ...Object.entries(FEATURES).map(([path, text]) => ({ path, text })), { path: FIGHTER, text: pc }];
  const r = loadContent(files);
  if (!r.content) throw new Error(r.errors.map(formatDiag).join('\n'));
  const doc = {
    kind: 'scenario', id: 'gcond', name: 'Greedy conditions', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: { w: 12, h: 6 },
    flags: { initiativeMode: 'static' }, knobs: { downEnds: false },
    units: units.map((u) => ({ ...u, decider: 'greedy' })),
  };
  const res = resolveScenario(doc, 'gcond.yaml', r.content);
  if (!res.setup) throw new Error(res.errors.map(formatDiag).join('\n'));
  const s = res.setup;
  const ds = s.seats.map(() => new GreedyDecider());
  const cx = createContext(s, 1, 0, ds, null);
  const records: ExplainRecord[] = [];
  for (const d of ds) d.explainTo((x) => records.push(x));
  const u = (seat: string): Unit => cx.st.units.find((x) => x.seat === seat)!;
  const begin = (who: Unit) => {
    cx.st.active = who.idx;
    cx.st.turnIdx++;
    who.turns++;
    Object.assign(who.b, { action: 1, bonus: 1, reaction: 1, freeObj: 1, moveFt: who.tpl.speedFt, atkActive: false, movedFt: 0 });
  };
  /**
   * Greedy's turn choice for `who` over the legal items `keep` accepts (all but the core Dodge
   * action by default: these states weigh step 4's terms against attacking; greedy-econ.test.ts
   * covers Dodge); its explain record.
   */
  const decide = (who: Unit, keep: (key: string, l: Legal) => boolean = (k) => k !== 'dodge'): ExplainRecord => {
    const list = listOptions(cx, who, takeList(cx));
    const items: Legal[] = [];
    const keys: string[] = [];
    for (let i = 0; i < list.n; i++) {
      const key = legalKey(cx.st, who.idx, list.items[i]!);
      if (key === 'pass' || keep(key, list.items[i]!)) {
        items.push(copyLegal(list.items[i]!, newLegal()));
        keys.push(key);
      }
    }
    releaseList(cx, list);
    const dp: DecisionPoint = { k: 'turn', who: who.idx, at: 0, round: 1, cause: -1, legal: { n: items.length, items }, keyOf: (i) => keys[i]! };
    records.length = 0;
    ds[who.idx]!.decide(cx.views[who.idx]!, dp);
    return records.at(-1)!;
  };
  /** The value greedy gives the one option `key` (offered alone with pass), and its explain parts. */
  const score = (who: Unit, key: string) => {
    const r = decide(who, (k) => k === key);
    const t = r.top.find((x) => x.key === key);
    if (!t) throw new Error(`${key} not scored: ${JSON.stringify(r)}`);
    return t;
  };
  /** Runs feature `id`'s steps after its target step, owned by `by`, on `target` (under a fresh root). */
  const impose = (id: string, by: Unit, target: Unit) => {
    const f = by.tpl.features.find((x) => x.id === `test:${id}`)!;
    const a = f.activate!;
    const root = newFx(cx, { tpl: a.root, owner: by.idx, bearer: by.idx, parent: -1, param: -1, srcItem: -1, until: { k: 'never' }, cause: -1 }).id;
    const fr = newFrame(by, { via: f.id, name: id, cause: -1, root, lastFx: root });
    fr.targets = [target.idx];
    runSteps(cx, fr, a.steps.slice(1));
  };
  return { cx, s, u, begin, decide, score, impose };
}

const DUEL: U[] = [
  { seat: 'pc1', team: 'party', use: 'test:sample-fighter', at: 'B2' },
  { seat: 'k1', team: 'enemies', use: 'srd:knight', at: 'C2' },
];
const ev = (t: { parts: readonly { term: string; ev: number }[] }, term: string) => t.parts.find((p) => p.term === term)?.ev ?? 0;

describe('COND: greedy values a condition by the rule effects it has on the target', () => {
  it('greedy stuns an adjacent Knight instead of attacking it; once it is Stunned it attacks', () => {
    const w = scene(['g-stun'], DUEL);
    const pc = w.u('pc1');
    w.begin(pc);
    const r = w.decide(pc);
    expect(r.chosen).toBe('use:g-stun');
    // Already Stunned (by the same feature): no new rule effect, so the attack wins.
    w.impose('g-stun', pc, w.u('k1'));
    expect(has(w.u('k1'), COND.stunned)).toBe(true);
    w.begin(pc);
    expect(w.decide(pc).chosen).toMatch(/^attack:/);
  });

  it('the repeat save is read with its exact odds: a save it always makes leaves one turn, a save it never makes leaves the horizon', () => {
    const w = scene(['g-stun', 'g-stun-easy'], DUEL);
    const pc = w.u('pc1');
    w.begin(pc);
    const hard = w.score(pc, 'use:g-stun');
    const easy = w.score(pc, 'use:g-stun-easy');
    const lost = (t: typeof hard) => ev(t, 'stunned: its lost actions');
    expect(lost(easy)).toBeGreaterThan(0);
    // DC 40 is never made: 1 + 0.7 + 0.49 of its turns (horizon 3, gamma 0.7); DC 1 always: 1 turn.
    expect(lost(hard) / lost(easy)).toBeCloseTo(2.19, 6);
  });

  it('each condition gets the terms its Rules Glossary entry implies, and immunity (2271-2276) makes it worth nothing', () => {
    const w = scene(CONDS.map((c) => `g-${c}`), [
      { seat: 'pc1', team: 'party', use: 'test:sample-fighter', at: 'B2' },
      { seat: 'k1', team: 'enemies', use: 'srd:knight', at: 'C2' },
      { seat: 'k2', team: 'enemies', use: 'test:stun-proof-knight', at: 'C3' },
    ]);
    const pc = w.u('pc1');
    w.begin(pc);
    const terms: Record<string, { out: number; inn: number }> = {};
    // Score each against k1 alone: k2 steps out of the 5-ft target range.
    const k2 = w.u('k2');
    const k2cell = k2.cell;
    k2.cell = parseCell('L6', w.s.w, w.s.h);
    for (const c of CONDS) {
      const t = w.score(pc, `use:g-${c}`);
      terms[c] = { out: ev(t, `${c}: its lost actions`), inn: ev(t, `${c}: attacks against it`) };
    }
    // Incapacitated (33650-33660), so its whole Attack action is lost: Stunned and Paralyzed lose the most.
    expect(terms.stunned!.out).toBeGreaterThan(terms.restrained!.out);
    expect(terms.paralyzed!.out).toBeCloseTo(terms.stunned!.out, 9);
    // Disadvantage on its attack rolls: Blinded (32742-32743), Poisoned (33946-33947), Restrained (34076-34077).
    for (const c of ['blinded', 'poisoned', 'restrained'] as const) expect(terms[c]!.out, c).toBeGreaterThan(0);
    // The SRD Knight is immune to Frightened ("Immunities Frightened", srd-raw.txt:50602), so it's worth nothing on k1;
    // Frightened of a living source (33475-33477) is checked on the stun-proof knight below.
    expect(terms.frightened!.out).toBe(0);
    expect(terms.blinded!.out).toBeCloseTo(terms.poisoned!.out, 9);
    // Charmed (32957-32958): it can't attack me, its only foe here, so it loses its whole routine, like Stunned.
    expect(terms.charmed!.out).toBeCloseTo(terms.stunned!.out, 9);
    expect(terms.charmed!.inn).toBe(0);
    // Advantage on attack rolls against it: Blinded, Paralyzed, Restrained, Stunned; none for Poisoned, Frightened, Charmed.
    for (const c of ['blinded', 'restrained', 'stunned'] as const) expect(terms[c]!.inn, c).toBeGreaterThan(0);
    for (const c of ['poisoned', 'frightened', 'charmed'] as const) expect(terms[c]!.inn, c).toBe(0);
    // Paralyzed: my hits from within 5 ft are Critical Hits too (33941-33943).
    expect(terms.paralyzed!.inn).toBeGreaterThan(terms.stunned!.inn);
    // Prone (34017-34018): Advantage within 5 ft for my melee; it stands first on its turn, so it loses nothing it uses here.
    expect(terms.prone!.inn).toBeGreaterThan(0);
    expect(terms.prone!.out).toBe(0);
    // The stun-proof knight: immune to Stunned, the condition does nothing.
    k2.cell = k2cell;
    const k1 = w.u('k1');
    k1.cell = parseCell('L6', w.s.w, w.s.h);
    expect(w.score(pc, 'use:g-stunned').parts.some((p) => p.term.startsWith('stunned'))).toBe(false);
    // Not immune to Frightened: Disadvantage on its attack rolls while its source is alive (33475-33477).
    expect(ev(w.score(pc, 'use:g-frightened'), 'frightened: its lost actions')).toBeGreaterThan(0);
  });
});

describe('COND: review fixes (each value stays within what the rule effect can deliver)', () => {
  it('a condition on a foe at 1 HP is worth what it gets before the foe drops: greedy attacks a 1-HP Knight rather than Blind it', () => {
    const healthy = scene(['g-blinded'], DUEL);
    healthy.begin(healthy.u('pc1'));
    const full = healthy.score(healthy.u('pc1'), 'use:g-blinded');
    const w = scene(['g-blinded'], [DUEL[0]!, { ...DUEL[1]!, hp: 1 }]);
    const pc = w.u('pc1');
    w.begin(pc);
    const low = w.score(pc, 'use:g-blinded');
    // Extra damage past its 1 HP is overkill, and it loses its attacks only for the turns it lives through.
    expect(ev(low, 'blinded: attacks against it')).toBeLessThanOrEqual(1);
    expect(ev(low, 'blinded: its lost actions')).toBeLessThan(ev(full, 'blinded: its lost actions') / 4);
    expect(w.decide(pc).chosen).toMatch(/^attack:/);
  });

  it('a condition a turn-end hook imposes each turn is worth no more than imposing it directly, and Explain names it', () => {
    const w = scene(['g-hook-restrain', 'g-restrained'], DUEL);
    const pc = w.u('pc1');
    w.begin(pc);
    const hook = w.score(pc, 'use:g-hook-restrain');
    const direct = w.score(pc, 'use:g-restrained');
    expect(ev(hook, 'restrained: its lost actions')).toBeGreaterThan(0); // the label walks into the effect's hooks
    expect(hook.ev).toBeLessThanOrEqual(direct.ev); // its first turn is free of it
    expect(ev(hook, 'restrained: its lost actions')).toBeLessThan(ev(direct, 'restrained: its lost actions'));
  });

  it('Paralyzed, srd-raw.txt:33941-33943: a hit from within 5 ft is a Critical Hit even when the attacker has Disadvantage (Poisoned)', () => {
    const w = scene(['g-paralyzed', 'g-stunned', 'g-poisoned'], [...DUEL, { seat: 'netter', team: 'enemies', use: 'test:sample-fighter', at: 'L6' }]);
    const pc = w.u('pc1');
    w.impose('g-poisoned', w.u('netter'), pc);
    expect(has(pc, COND.poisoned)).toBe(true);
    w.begin(pc);
    // Both give Advantage, cancelled by pc1's Disadvantage; only Paralyzed's hits all crit.
    expect(ev(w.score(pc, 'use:g-paralyzed'), 'paralyzed: attacks against it')).toBeGreaterThan(ev(w.score(pc, 'use:g-stunned'), 'stunned: attacks against it') + 1);
  });
});

describe('STAT: stats through AC, speed and resistance in the exposure terms', () => {
  const MOB: U[] = [
    { seat: 'pc1', team: 'party', use: 'test:sample-fighter', at: 'B2' },
    { seat: 'k1', team: 'enemies', use: 'srd:knight', at: 'C2' },
    { seat: 'k2', team: 'enemies', use: 'srd:knight', at: 'C3' },
    { seat: 'k3', team: 'enemies', use: 'srd:knight', at: 'B3' },
  ];

  it('surrounded by three Knights, greedy braces (+5 AC) instead of attacking', () => {
    const w = scene(['g-brace'], MOB);
    const pc = w.u('pc1');
    w.begin(pc);
    const r = w.decide(pc);
    expect(r.chosen).toBe('use:g-brace');
    expect(ev(r.top.find((t) => t.key === 'use:g-brace')!, 'stats (ac)')).toBeGreaterThan(5);
  });

  it('GATE: the same +5 AC gated on ownTurn helps on no foe\'s turn, so greedy attacks', () => {
    const w = scene(['g-brace-own'], MOB);
    const pc = w.u('pc1');
    w.begin(pc);
    expect(w.decide(pc).chosen).toMatch(/^attack:/);
    expect(w.score(pc, 'use:g-brace-own').parts.some((p) => p.term.startsWith('stats'))).toBe(false);
  });

  it('resistance is worth what it saves: against slashing Knights, the slashing ward over the fire ward (worth nothing)', () => {
    const w = scene(['g-ward-slash', 'g-ward-fire'], MOB);
    const pc = w.u('pc1');
    w.begin(pc);
    const r = w.decide(pc, (k) => k.startsWith('use:'));
    expect(r.chosen).toBe('use:g-ward-slash');
    expect(ev(w.score(pc, 'use:g-ward-fire'), 'stats (resist)')).toBe(0);
    expect(ev(w.score(pc, 'use:g-ward-slash'), 'stats (resist)')).toBeGreaterThan(0);
  });

  it('speed: Speed 0 on a Knight walking up is worth its whole routine; on a Knight already adjacent, nothing', () => {
    const w = scene(['g-hobble'], [
      { seat: 'pc1', team: 'party', use: 'test:sample-fighter', at: 'B2' },
      { seat: 'k1', team: 'enemies', use: 'srd:knight', at: 'F2' }, // 15 ft: it walks up and attacks
    ]);
    const pc = w.u('pc1');
    w.begin(pc);
    const far = ev(w.score(pc, 'use:g-hobble'), 'stats (speed)');
    expect(far).toBeGreaterThan(0);
    // Coverage 8'b G3: walking up and attacking now outranks it at full HP (a strike's progress credit).
    // With no move left it isn't on offer, and the Speed 0 still beats standing there.
    pc.b.moveFt = 0;
    expect(w.decide(pc).chosen).toBe('use:g-hobble');
    w.u('k1').cell = parseCell('C2', w.s.w, w.s.h);
    w.begin(pc);
    // Adjacent it doesn't need to move; its heavy crossbow still reaches too.
    expect(ev(w.score(pc, 'use:g-hobble'), 'stats (speed)')).toBe(0);
  });
});

describe('THP: temp HP valued like a heal capped by danger', () => {
  const PAIR: U[] = [
    { seat: 'pc1', team: 'party', use: 'test:sample-fighter', at: 'B2', hp: 6 },
    { seat: 'k1', team: 'enemies', use: 'srd:knight', at: 'C2' },
    { seat: 'k2', team: 'enemies', use: 'srd:knight', at: 'C3' },
  ];

  it('at 6 HP between two Knights greedy takes 10 temp HP instead of attacking', () => {
    const w = scene(['g-shore'], PAIR);
    const pc = w.u('pc1');
    w.begin(pc);
    const r = w.decide(pc);
    expect(r.chosen).toBe('use:g-shore');
    expect(ev(r.top.find((t) => t.key === 'use:g-shore')!, 'temp HP')).toBeGreaterThan(0);
  });

  it('at full HP next to one Knight it attacks; with 10 temp HP already the step adds nothing (they don\'t stack, srd-raw.txt:2400-2404)', () => {
    const w = scene(['g-shore'], [{ ...PAIR[0]!, hp: 44 }, PAIR[1]!]);
    const pc = w.u('pc1');
    w.begin(pc);
    expect(w.decide(pc).chosen).toMatch(/^attack:/);
    pc.tempHp = 10;
    expect(ev(w.score(pc, 'use:g-shore'), 'temp HP')).toBe(0);
  });
});

describe('check: the escape', () => {
  const NET: U[] = [
    { seat: 'pc1', team: 'party', use: 'test:sample-fighter', at: 'B2' },
    { seat: 'k1', team: 'enemies', use: 'srd:knight', at: 'C2' },
    { seat: 'netter', team: 'enemies', use: 'test:sample-fighter', at: 'L6' },
  ];

  it('restrained next to a Knight, greedy escapes an easy net (DC 1) rather than attack at Disadvantage; a net it can\'t escape (DC 40) it fights in', () => {
    for (const [id, want] of [['g-net', /escape$/], ['g-net-hard', /^attack:/]] as const) {
      const w = scene([id], NET);
      const pc = w.u('pc1');
      w.impose(id, w.u('netter'), pc);
      expect(has(pc, COND.restrained)).toBe(true);
      w.begin(pc);
      // pc1 shares the netter's template: leave out its own net (it would net the Knight, a fine move, but not this test's).
      const r = w.decide(pc, (k) => !k.startsWith('use:g-net') || k.endsWith('/escape'));
      expect(r.chosen, id).toMatch(want);
      if (id === 'g-net') expect(ev(r.top.find((t) => t.key === r.chosen)!, 'escape: the condition it ends')).toBeGreaterThan(0);
    }
  });
});
