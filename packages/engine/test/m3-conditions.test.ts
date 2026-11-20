// M3 step 4 (docs/design/m3.md section 3: COND, STAT, THP, GATE, check). Each condition and
// stat has a test named for the rule text it checks, with its line in the SRD 5.2.1 PDF text
// (srd-raw.txt, the Rules Glossary). Content is synthetic (test: ids), compiled from YAML with
// the repo packs, so the schema and compiler paths run too. Property tests (fast-check): no
// condition outlives its source, immunity blocks, temp HP never stacks, HP never exceeds max;
// determinism: the same seed gives the same log, with the dice audit on.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { loadContent, type LoadResult } from '../src/content/load.ts';
import { RK, saveKey } from '../src/content/rollkeys.ts';
import type { CompiledDamage, Content, Step } from '../src/content/types.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import type { Decider } from '../src/decide/decider.ts';
import { makeDeciders } from '../src/decide/make.ts';
import { computeReach, distFt, forEachLabel, canReactAgainst } from '../src/grid/reach.ts';
import { ArraySink, type GameEvent } from '../src/log/events.ts';
import { renderLog } from '../src/log/render.ts';
import { damagePmf } from '../src/query/odds.ts';
import { resolveScenario } from '../src/scenario/resolve.ts';
import { buildAttackSpec, resolveAttack } from '../src/sim/attack.ts';
import { resolveOption } from '../src/sim/act.ts';
import { resolveUse } from '../src/sim/cast.ts';
import { newLegal, releaseList, takeList, type Ctx } from '../src/sim/context.ts';
import { checkMod, checkSpec, saveSpec } from '../src/sim/d20.ts';
import { dealDamage, knockOut, speedNow } from '../src/sim/damage.ts';
import { boundary, endFx, newFx, newModFold } from '../src/sim/effects.ts';
import { createContext, runFight } from '../src/sim/fight.ts';
import { acNow } from '../src/sim/hands.ts';
import { applyPassives } from '../src/sim/precast.ts';
import { listOptions } from '../src/sim/options.ts';
import type { FightSetup } from '../src/sim/setup.ts';
import { COND, has, type Unit } from '../src/sim/state.ts';
import { critMinOf, gateOk, unarmedTypeFor } from '../src/sim/stats.ts';
import { newFrame, runSteps } from '../src/sim/steps.ts';
import { walkPath } from '../src/sim/walker.ts';
import { drain, queueTrigger, TRIG } from '../src/sim/triggers.ts';
import { canonicalJson } from '../src/util/canon.ts';

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

const withFiles = (extra: Record<string, string>): SourceFile[] => [...REPO.filter((f) => !Object.hasOwn(extra, f.path)), ...Object.entries(extra).map(([path, text]) => ({ path, text }))];
const messages = (r: LoadResult) => r.errors.map(formatDiag).join('\n');
function loadOk(files: readonly SourceFile[]): Content {
  const r = loadContent(files);
  if (!r.content) throw new Error(messages(r));
  return r.content;
}

/** A synthetic feature: spellAbility wis (the fighter's DC is 8 + 3 + 1 = 12). */
const feature = (id: string, body: string) => `kind: feature\nid: test:${id}\nname: ${id}\nsource: synthetic test fixture\nspellAbility: wis\n${body}`;

/** An activation (free, once per turn) whose steps after the target step impose something, under a root effect `hold`. */
const imposer = (id: string, steps: string, extraEffects = '') =>
  feature(
    id,
    `activate:
  id: go
  name: Go
  cost: free
  uses: { perTurn: 1 }
  root: hold
  do:
    - { target: { range: 60, who: any, self: yes } }
${steps}
effects:
  - id: hold
    name: Hold
    duration: { rounds: 10 }
${extraEffects}`,
  );

/** A passive feature with one effect carrying `fields` (stats, immune, mods). */
const passive = (id: string, fields: string) => feature(id, `passive: { effects: [p] }\neffects:\n  - id: p\n    name: ${id}\n${fields}`);

const STONE = `kind: monster
id: test:stone-target
name: Stone Target
source: synthetic test fixture
size: medium
cr: 0
pb: 2
ac: 10
hp: { average: 200, formula: 20d10 + 90 }
speed: { walk: 30 }
initiative: { mod: 0, score: 10 }
abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }
resist: [bludgeoning]
conditionImmune: [blinded, charmed, frightened, incapacitated, paralyzed, poisoned, prone, restrained, stunned]
attacks:
  - id: slam
    name: Slam
    kind: melee
    toHit: 2
    damage:
      - { roll: 1d4, type: bludgeoning, avg: 2 }
`;

const CONDS = ['blinded', 'charmed', 'frightened', 'incapacitated', 'paralyzed', 'poisoned', 'restrained', 'stunned'] as const;

/** The standard kit: one imposer per condition (until parent), plus the variants the tests name. */
const KIT: Record<string, string> = {
  'packs/test/monsters/stone-target.yaml': STONE,
  ...Object.fromEntries(CONDS.map((c) => [`packs/test/data/give-${c}.yaml`, imposer(`give-${c}`, `    - { condition: { id: ${c} } }`)])),
  'packs/test/data/give-prone.yaml': imposer('give-prone', '    - { condition: { id: prone } }'),
  'packs/test/data/stun-save.yaml': imposer('stun-save', '    - { condition: { id: stunned, save: { ability: con, dc: 1, at: turnEnd } } }'),
  'packs/test/data/stun-hard.yaml': imposer('stun-hard', '    - { condition: { id: stunned, save: { ability: con, dc: 40, at: turnEnd } } }'),
  'packs/test/data/net.yaml': imposer('net', '    - { condition: { id: restrained, escape: { check: { ability: str, skills: [athletics] }, dc: 1, cost: action } } }'),
  'packs/test/data/net-hard.yaml': imposer('net-hard', '    - { condition: { id: restrained, escape: { check: { ability: str, skills: [athletics] }, dc: 40, cost: action } } }'),
  'packs/test/data/charm-fragile.yaml': imposer('charm-fragile', '    - { condition: { id: charmed, endsOnDamage: true } }'),
  'packs/test/data/blind-brief.yaml': imposer('blind-brief', '    - { condition: { id: blinded, until: { until: endOfNextTurn, of: bearer } } }'),
  'packs/test/data/shore-up.yaml': imposer('shore-up', '    - { tempHp: 1d4 + 4 }'),
  'packs/test/data/ward-poison.yaml': passive('ward-poison', '    immune: [poisoned, stunned]'),
  'packs/test/data/sturdy.yaml': passive('sturdy', '    stats: [{ ac: 2 }, { resist: [fire] }, { vuln: [cold] }, { immune: [poison] }]'),
  'packs/test/data/brittle.yaml': passive('brittle', '    stats: [{ resist: [fire] }, { vuln: [fire] }]'),
  'packs/test/data/hasted5.yaml': passive('hasted5', '    stats: [{ speed: 5 }]'),
  'packs/test/data/ward-bare.yaml': passive('ward-bare', '    stats: [{ resist: [fire], when: [unarmored] }]'),
  'packs/test/data/ward-incap.yaml': passive('ward-incap', '    immune: [incapacitated]'),
  'packs/test/data/bark.yaml': passive('bark', '    stats: [{ acFloor: 20 }]'),
  'packs/test/data/slowed.yaml': passive('slowed', '    stats: [{ speed: half }]'),
  'packs/test/data/rooted.yaml': passive('rooted', '    stats: [{ speed: zero }]'),
  'packs/test/data/swift.yaml': passive('swift', '    stats: [{ speed: 10, when: [unarmored, noShield] }]'),
  'packs/test/data/keen.yaml': passive('keen', '    stats: [{ critMin: 19 }]'),
  'packs/test/data/addled.yaml': passive('addled', '    stats: [{ noOpportunityAttacks: true }]'),
  'packs/test/data/empowered.yaml': passive('empowered', '    stats: [{ damageType: force, on: unarmed }]'),
  'packs/test/data/defense.yaml': passive('defense', '    stats: [{ ac: 1, when: [armored] }]'),
  'packs/test/data/opportunist.yaml': passive('opportunist', '    mods: [{ on: [d20.attack], op: adv, when: [{ targetHas: prone }] }]'),
  'packs/test/data/poised.yaml': feature('poised', `activate:\n  id: go\n  name: Poised\n  cost: bonus\n  when: [hasntMoved]\n  do: [{ apply: { effect: p, to: self } }]\neffects:\n  - id: p\n    name: Poised\n    duration: { rounds: 1 }\n`),
};

interface World {
  readonly cx: Ctx;
  readonly setup: FightSetup;
  u(seat: string): Unit;
  /** Runs feature `id`'s activation steps after its target step on `target`, under a fresh root (or `root`). Returns the root fx id. */
  impose(id: string, target: Unit, by?: Unit, root?: number): number;
  /** One turn of `who`: start boundary, body, turn-end triggers, end boundary. */
  turn(who: Unit, body?: () => void): void;
}

function world(opts: { pc?: string; features?: string[]; files?: Record<string, string>; units?: { seat: string; team: 'party' | 'enemies'; use: string; at: string }[]; flags?: Record<string, unknown>; sink?: ArraySink } = {}): World {
  // By default the PC has every imposer (no passives: each stat test names its own).
  const feats = Object.entries(KIT)
    .filter(([p, text]) => p.startsWith('packs/test/data/') && text.includes('\nactivate:') && text.includes('root: hold'))
    .map(([p]) => `test:${p.slice('packs/test/data/'.length, -'.yaml'.length)}`);
  const fighter = `${opts.pc ?? FIGHTER_TEXT}features: [${(opts.features ?? feats).join(', ')}]\n`;
  const content = loadOk(withFiles({ ...KIT, ...(opts.files ?? {}), [FIGHTER]: fighter }));
  const doc = {
    kind: 'scenario', id: 'cond-lab', name: 'Condition lab', rules: '2024', packs: ['srd-5.2.1', 'test'],
    grid: { w: 8, h: 4 }, flags: opts.flags ?? {},
    units: opts.units ?? [
      { seat: 'pc1', team: 'party', use: 'test:sample-fighter', at: 'B2' },
      { seat: 'dummy', team: 'enemies', use: 'test:training-dummy', at: 'C2' },
      { seat: 'rival', team: 'enemies', use: 'test:sample-fighter', at: 'F2' },
      { seat: 'stone', team: 'enemies', use: 'test:stone-target', at: 'H4' },
    ],
  };
  const r = resolveScenario(doc, 'cond-lab.yaml', content);
  if (!r.setup) throw new Error(r.errors.map(formatDiag).join('\n'));
  const setup = r.setup;
  const cx = createContext(setup, 1, 0, makeDeciders(setup), opts.sink ?? null, { audit: true });
  applyPassives(cx, -1); // as runFight does at fight start
  const u = (seat: string): Unit => cx.st.units.find((x) => x.seat === seat)!;
  const impose = (id: string, target: Unit, by = u('pc1'), root?: number): number => {
    const fi = by.tpl.features.findIndex((f) => f.id === `test:${id}`);
    if (fi < 0) throw new Error(`no feature test:${id}`);
    const a = by.tpl.features[fi]!.activate!;
    const r0 = root ?? newFx(cx, { tpl: a.root, owner: by.idx, bearer: by.idx, parent: -1, param: -1, srcItem: -1, until: { k: 'never' }, cause: -1 }).id;
    const fr = newFrame(by, { via: by.tpl.features[fi]!.id, name: id, cause: -1, root: r0, lastFx: r0 });
    fr.targets = [target.idx];
    runSteps(cx, fr, a.steps.slice(1));
    return r0;
  };
  const turn = (who: Unit, body?: () => void): void => {
    const st = cx.st;
    st.turnIdx++;
    st.active = who.idx;
    who.turns++;
    who.b.action = 1;
    who.b.bonus = 1;
    who.b.movedFt = 0;
    boundary(cx, 'start', who, -1);
    body?.();
    // sim/fight.ts takeTurn: end-of-turn triggers, then expiries.
    queueTrigger(cx, TRIG.turnEnd, who.idx, who.cell, -1, 0, -1);
    drain(cx);
    boundary(cx, 'end', who, -1);
    st.active = -1;
  };
  return { cx, setup, u, impose, turn };
}

const attackSpec = (w: World, a: Unit, t: Unit, ai = 0) => {
  const adv: string[] = [];
  const dis: string[] = [];
  const spec = buildAttackSpec(w.cx.st, a, ai, t, a.cell, adv, dis);
  return { spec, adv, dis };
};
const save = (w: World, u: Unit, ability: number) => {
  const adv: string[] = [];
  const dis: string[] = [];
  return { spec: saveSpec(w.cx.st, u, saveKey(ability), 10, adv, dis, newModFold()), adv, dis };
};
const check = (w: World, u: Unit, ability: number, skills: number[] = []) => {
  const adv: string[] = [];
  const dis: string[] = [];
  return { ...checkSpec(w.cx.st, u, ability, skills, 10, adv, dis, newModFold()), adv, dis };
};
const options = (w: World, u: Unit) => {
  const list = listOptions(w.cx, u, takeList(w.cx));
  const items = list.items.slice(0, list.n).map((l) => ({ ...l }));
  releaseList(w.cx, list);
  return items;
};
const damage = (w: World, from: Unit, t: Unit, amount: number, type: string) => {
  const part: CompiledDamage = { roll: { k: 'const', v: amount }, critExtra: null, type: ['acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning', 'necrotic', 'piercing', 'poison', 'psychic', 'radiant', 'slashing', 'thunder'].indexOf(type), avg: amount, ifAdvantage: false };
  dealDamage(w.cx, { unit: from.idx, via: 'test:hit', slot: 0, cause: -1 }, [part], Int32Array.from([amount]), () => true, false, [t.idx]);
};

describe('COND: each condition does what its Rules Glossary entry says', () => {
  it('Blinded, srd-raw.txt:32742-32743: "Attack rolls against you have Advantage, and your attack rolls have Disadvantage"', () => {
    const w = world();
    w.impose('give-blinded', w.u('dummy'));
    expect(attackSpec(w, w.u('pc1'), w.u('dummy')).adv).toContain('core:target-blinded');
    const v = world();
    v.impose('give-blinded', v.u('pc1'));
    expect(attackSpec(v, v.u('pc1'), v.u('dummy')).dis).toContain('core:attacker-blinded');
  });

  it('Charmed, srd-raw.txt:32957-32959: "You can\'t attack the charmer or target the charmer with damaging abilities"', () => {
    const w = world();
    const pc = w.u('pc1');
    const rival = w.u('rival');
    w.impose('give-charmed', pc, rival); // the rival is the charmer
    pc.b.action = 1;
    const targets = options(w, pc).filter((l) => l.k === 'attack').map((l) => l.target);
    expect(targets).toContain(w.u('dummy').idx);
    expect(targets).not.toContain(rival.idx); // the thrown handaxe reaches it at 20 ft, but it's the charmer
    expect(canReactAgainst(w.cx.st, pc, rival)).toBe(false); // an Opportunity Attack is an attack
    expect(canReactAgainst(w.cx.st, pc, w.u('dummy'))).toBe(true);
    // A damaging program can't target the charmer either: a feature whose only target would be the rival.
    const fr = newFrame(pc, { via: 'test:x', name: 'x', cause: -1 });
    const ok = runSteps(w.cx, fr, [{ k: 'target', rangeFt: 60, who: 'enemy', self: 'no', maxSize: 5 }, { k: 'damage', dmg: [] }]);
    expect(ok).toBe(true); // the dummy is still a legal target
    expect(fr.targets).toEqual([w.u('dummy').idx]);
    // With the dummy and the stone gone, the charmer is the only enemy in range: the program has no target.
    w.u('dummy').life = 'dead';
    w.u('stone').life = 'dead';
    const fr2 = newFrame(pc, { via: 'test:x', name: 'x', cause: -1 });
    expect(runSteps(w.cx, fr2, [{ k: 'target', rangeFt: 60, who: 'enemy', self: 'no', maxSize: 5 }, { k: 'damage', dmg: [] }])).toBe(false);
    expect(fr2.targets).toEqual([]);
    // A program that deals no damage can still target it.
    const fr3 = newFrame(pc, { via: 'test:x', name: 'x', cause: -1 });
    expect(runSteps(w.cx, fr3, [{ k: 'target', rangeFt: 60, who: 'enemy', self: 'no', maxSize: 5 }])).toBe(true);
    expect(fr3.targets).toEqual([rival.idx]);
  });

  it('Frightened, srd-raw.txt:33475-33479: Disadvantage on attack rolls and ability checks while the source is in sight, and "You can\'t willingly move closer to the source of fear"', () => {
    const w = world();
    const pc = w.u('pc1');
    const far = w.u('rival');
    w.impose('give-frightened', pc, far);
    expect(attackSpec(w, pc, w.u('dummy')).dis).toContain('core:attacker-frightened');
    expect(check(w, pc, 0).dis).toContain('core:frightened');
    pc.b.moveFt = 30;
    const sc = w.cx.sc.reachEngine;
    computeReach(w.cx.st, pc, 30, sc);
    const start = distFt(w.cx.st, pc.cell, far.cell);
    let closer = 0;
    let any = 0;
    forEachLabel(w.cx.st, pc, sc, 30, (cell) => {
      any++;
      if (distFt(w.cx.st, cell, far.cell) < start) closer++;
    });
    expect(any).toBeGreaterThan(0);
    expect(closer).toBe(0);
    far.life = 'dead'; // no living source: the limits lift
    expect(attackSpec(w, pc, w.u('dummy')).dis).not.toContain('core:attacker-frightened');
  });

  it('Incapacitated, srd-raw.txt:33655-33657: "You can\'t take any action, Bonus Action, or Reaction" and "Your Concentration is broken"', () => {
    const w = world();
    const pc = w.u('pc1');
    const conc = newFx(w.cx, { tpl: pc.tpl.features.find((f) => f.id === 'test:give-poisoned')!.activate!.root, owner: pc.idx, bearer: -1, parent: -1, param: -1, srcItem: -1, until: { k: 'never' }, cause: -1 });
    pc.conc = conc.id;
    w.impose('give-incapacitated', pc, w.u('rival'));
    expect(has(pc, COND.incapacitated)).toBe(true);
    expect(conc.alive).toBe(false);
    pc.b.action = 1;
    pc.b.bonus = 1;
    expect(options(w, pc).filter((l) => l.k === 'attack' || l.k === 'use' || l.k === 'option').length).toBe(0);
    expect(canReactAgainst(w.cx.st, pc, w.u('dummy'))).toBe(false);
  });

  it('Paralyzed, srd-raw.txt:33933-33943: Incapacitated, Speed 0, fails STR and DEX saves, attacks against it have Advantage, a hit from within 5 ft is a Critical Hit', () => {
    const w = world();
    const d = w.u('dummy');
    w.impose('give-paralyzed', d);
    expect(has(d, COND.incapacitated)).toBe(true);
    const pc = w.u('pc1');
    w.impose('give-paralyzed', pc, pc);
    expect(speedNow(pc, w.cx.st)).toBe(0);
    expect(save(w, pc, 0).spec.autoFail).toBe(true);
    expect(save(w, pc, 1).spec.autoFail).toBe(true);
    expect(save(w, pc, 2).spec.autoFail).toBeUndefined();
    const melee = attackSpec(w, w.u('pc1'), d);
    expect(melee.adv).toContain('core:target-paralyzed');
    expect(melee.spec.autoCritOnHit).toBe(true);
    const far = w.u('rival');
    w.impose('give-paralyzed', far);
    const thrown = w.u('pc1').tpl.attacks.findIndex((a) => a.kind === 'ranged');
    expect(attackSpec(w, w.u('pc1'), far, thrown).spec.autoCritOnHit).toBe(false); // 20 ft away
  });

  it('Poisoned, srd-raw.txt:33946-33947: "You have Disadvantage on attack rolls and ability checks"', () => {
    const w = world();
    const pc = w.u('pc1');
    w.impose('give-poisoned', pc, pc);
    expect(attackSpec(w, pc, w.u('dummy')).dis).toContain('core:attacker-poisoned');
    expect(check(w, pc, 3).dis).toContain('core:poisoned');
    expect(save(w, pc, 2).dis).not.toContain('core:poisoned'); // saves aren't affected
  });

  it('Prone by content, srd-raw.txt:34014-34016: it lasts until the creature rights itself (half its Speed)', () => {
    const w = world();
    const pc = w.u('pc1');
    const root = w.impose('give-prone', pc, pc);
    expect(has(pc, COND.prone)).toBe(true);
    endFx(w.cx, root, 'dismissed', -1); // Prone doesn't end with what knocked it down
    expect(has(pc, COND.prone)).toBe(true);
    pc.b.moveFt = 30;
    expect(options(w, pc).some((l) => l.k === 'stand')).toBe(true);
  });

  it('Restrained, srd-raw.txt:34075-34079: Speed 0, attacks against it have Advantage, its attacks have Disadvantage, Disadvantage on DEX saves', () => {
    const w = world();
    const pc = w.u('pc1');
    w.impose('give-restrained', pc, pc);
    expect(speedNow(pc, w.cx.st)).toBe(0);
    expect(attackSpec(w, pc, w.u('dummy')).dis).toContain('core:attacker-restrained');
    expect(save(w, pc, 1).dis).toContain('core:restrained');
    expect(save(w, pc, 0).dis).not.toContain('core:restrained');
    w.impose('give-restrained', w.u('dummy'));
    expect(attackSpec(w, pc, w.u('dummy')).adv).toContain('core:target-restrained');
  });

  it('Stunned, srd-raw.txt:34373-34379: Incapacitated, fails STR and DEX saves, attacks against it have Advantage, and the 2024 text gives it no Speed rule', () => {
    const w = world();
    const pc = w.u('pc1');
    w.impose('give-stunned', pc, pc);
    expect(has(pc, COND.incapacitated)).toBe(true);
    expect(save(w, pc, 1).spec.autoFail).toBe(true);
    expect(speedNow(pc, w.cx.st)).toBe(30);
    w.impose('give-stunned', w.u('dummy'));
    expect(attackSpec(w, pc, w.u('dummy')).adv).toEqual(['core:target-stunned']);
    expect(attackSpec(w, pc, w.u('dummy')).spec.autoCritOnHit).toBe(false);
  });

  it('Grappled is deferred: the schema says so', () => {
    const r = loadContent(withFiles({ ...KIT, 'packs/test/data/grab.yaml': imposer('grab', '    - { condition: { id: grappled } }') }));
    expect(messages(r)).toMatch(/grappled is deferred/);
  });
});

describe('COND: a condition never outlives its source', () => {
  it('until parent: it ends with the root that imposed it (the concentration, form or zone)', () => {
    const w = world();
    const d = w.u('dummy');
    const root = w.impose('give-restrained', d);
    expect(has(d, COND.restrained)).toBe(true);
    endFx(w.cx, root, 'concentration', -1);
    expect(has(d, COND.restrained)).toBe(false);
    expect(d.conds.length).toBe(0);
  });

  it('until endOfNextTurn of the bearer: imposed on its own turn, it survives that turn and ends at the end of the next', () => {
    const w = world();
    const d = w.u('dummy');
    w.turn(d, () => w.impose('blind-brief', d));
    expect(has(d, COND.blinded)).toBe(true);
    w.turn(w.u('pc1'));
    expect(has(d, COND.blinded)).toBe(true);
    w.turn(d);
    expect(has(d, COND.blinded)).toBe(false);
    expect(d.conds.length).toBe(0);
  });

  it('a repeat save at the end of each of its turns ends it on a success, on its own condSave stream', () => {
    const sink = new ArraySink();
    const w = world({ sink });
    const d = w.u('dummy');
    w.impose('stun-save', d);
    expect(has(d, COND.stunned)).toBe(true);
    w.turn(d);
    expect(has(d, COND.stunned)).toBe(false);
    expect(has(d, COND.incapacitated)).toBe(false);
    const saves = sink.events.filter((e) => e.k === 'save');
    expect(saves).toMatchObject([{ purpose: 'condSave', key: 'save.con', dc: 1, ok: true }]);
    expect(sink.events.some((e) => e.k === 'fxEnd' && e.why === 'saved')).toBe(true);
    const hard = world();
    hard.impose('stun-hard', hard.u('dummy'));
    hard.turn(hard.u('dummy'));
    expect(has(hard.u('dummy'), COND.stunned)).toBe(true);
  });

  it('escape: the bearer\'s action, a STR (Athletics) check against the DC; a success ends it', () => {
    const sink = new ArraySink();
    const w = world({ sink });
    const pc = w.u('pc1');
    w.impose('net', pc, pc);
    pc.b.action = 1;
    const esc = options(w, pc).find((l) => l.k === 'use' && l.fx >= 0);
    expect(esc).toBeDefined();
    resolveUse(w.cx, pc, { ...newLegal(), ...esc! }, -1);
    expect(has(pc, COND.restrained)).toBe(false);
    expect(pc.b.action).toBe(0);
    expect(sink.events.find((e) => e.k === 'save')).toMatchObject({ purpose: 'check', key: 'check.str.athletics' });
    expect(sink.events.some((e) => e.k === 'fxEnd' && e.why === 'escaped')).toBe(true);
    const hard = world();
    const p2 = hard.u('pc1');
    hard.impose('net-hard', p2, p2);
    p2.b.action = 1;
    const e2 = options(hard, p2).find((l) => l.k === 'use' && l.fx >= 0)!;
    resolveUse(hard.cx, p2, { ...newLegal(), ...e2 }, -1);
    expect(has(p2, COND.restrained)).toBe(true);
  });

  it('endsOnDamage: it ends when its bearer takes damage, not when the damage is 0', () => {
    const w = world();
    const d = w.u('dummy');
    w.impose('charm-fragile', d);
    damage(w, w.u('pc1'), w.u('stone'), 3, 'bludgeoning'); // someone else
    expect(has(d, COND.charmed)).toBe(true);
    damage(w, w.u('pc1'), d, 1, 'slashing');
    expect(has(d, COND.charmed)).toBe(false);
    // A hit on the bearer itself that comes to 0 (poison, which it's immune to) doesn't end it.
    const v = world({ features: ['test:sturdy', 'test:charm-fragile'] });
    const pc = v.u('pc1');
    v.impose('charm-fragile', pc, pc);
    const hp = pc.hp;
    damage(v, v.u('dummy'), pc, 7, 'poison');
    expect(pc.hp).toBe(hp);
    expect(has(pc, COND.charmed)).toBe(true);
    damage(v, v.u('dummy'), pc, 1, 'slashing');
    expect(has(pc, COND.charmed)).toBe(false);
  });
});

describe('movement budget: Speed that changes on your own turn', () => {
  it('escaping Restrained on your turn leaves your full Speed to move (srd-raw.txt:1852-1862, 34072-34075)', () => {
    const w = world();
    const pcIdx = w.u('pc1').idx;
    const rivalIdx = w.u('rival').idx;
    let seen: { moveFt: number; moves: number } | null = null;
    let netted = false;
    class Done extends Error {}
    // Scripted seats through runFight's own turn loop: the rival nets pc1 (DC 1 escape), pc1
    // spends its action escaping, then we read what its next decision offers.
    const decider: Decider = {
      name: 'script',
      decide(view, dp) {
        const st = view.q;
        const items = dp.legal.items.slice(0, dp.legal.n);
        const pc = st.units[pcIdx]!;
        if (dp.k === 'target') return Math.max(0, items.findIndex((l) => l.target === pcIdx));
        if (dp.k !== 'turn') return 0;
        if (dp.who === rivalIdx && !netted) {
          const i = items.findIndex((l, j) => l.k === 'use' && l.fx < 0 && dp.keyOf(j) === 'use:net');
          if (i >= 0) {
            netted = true;
            return i;
          }
        }
        if (dp.who === pcIdx && st.active === pcIdx) {
          if (has(pc, COND.restrained)) {
            const i = items.findIndex((l) => l.k === 'use' && l.fx >= 0);
            if (i >= 0) return i;
          } else if (pc.b.action === 0) {
            seen = { moveFt: pc.b.moveFt, moves: items.filter((l) => l.k === 'move').length };
            throw new Done();
          }
        }
        return items.findIndex((l) => l.k === 'pass');
      },
    };
    expect(() => runFight(w.setup, 1, 0, w.setup.seats.map(() => decider), null)).toThrow(Done);
    expect(seen).not.toBeNull();
    expect(seen!.moveFt).toBe(30); // the sample fighter's Speed, none of it spent
    expect(seen!.moves).toBeGreaterThan(0);
  });
});

describe('COND: immunity, srd-raw.txt:2273-2276: "Immunity to a condition means you aren\'t affected by it"', () => {
  it('a stat block\'s Condition Immunities block every condition step', () => {
    const w = world();
    const s = w.u('stone');
    for (const c of [...CONDS, 'prone']) w.impose(`give-${c}`, s);
    expect(s.condMask).toBe(0);
  });

  it('an effect\'s immune list blocks those conditions only, and Stunned keeps nothing when Stunned is blocked', () => {
    const w = world({ features: ['test:ward-poison', 'test:give-poisoned', 'test:give-stunned', 'test:give-blinded'] });
    const pc = w.u('pc1');
    w.impose('give-poisoned', pc, pc);
    w.impose('give-stunned', pc, pc);
    w.impose('give-blinded', pc, pc);
    expect(has(pc, COND.poisoned) || has(pc, COND.stunned) || has(pc, COND.incapacitated)).toBe(false);
    expect(has(pc, COND.blinded)).toBe(true);
  });

  it('immune to Incapacitated but not Stunned: Stunned lands without its Incapacitated part [U], so Concentration holds', () => {
    const w = world({ features: ['test:ward-incap', 'test:give-stunned'] });
    const pc = w.u('pc1');
    const conc = newFx(w.cx, { tpl: pc.tpl.features.find((f) => f.id === 'test:give-stunned')!.activate!.root, owner: pc.idx, bearer: pc.idx, parent: -1, param: -1, srcItem: -1, until: { k: 'never' }, cause: -1 });
    pc.conc = conc.id;
    w.impose('give-stunned', pc, pc);
    expect(has(pc, COND.stunned)).toBe(true);
    expect(has(pc, COND.incapacitated)).toBe(false);
    expect(pc.conc).toBe(conc.id);
  });
});

describe('STAT: each stat does what it says', () => {
  it('ac: a bonus adds to AC; acFloor: "AC can\'t be less than" (the census ac.min shape)', () => {
    const w = world({ features: ['test:sturdy'] });
    expect(acNow(w.u('pc1'), w.cx.st)).toBe(20); // 18 + 2
    const f = world({ features: ['test:bark'] });
    expect(acNow(f.u('pc1'), f.cx.st)).toBe(20); // 18 floored to 20
    const g = world({ features: ['test:bark', 'test:sturdy'] });
    expect(acNow(g.u('pc1'), g.cx.st)).toBe(20); // 20 from the bonus, and the floor is 20
  });

  it('speed: half (round down), zero, +N; Speed 0 from a condition "can\'t increase" (srd-raw.txt:34075)', () => {
    expect(speedNow(world({ features: ['test:slowed'] }).u('pc1'))).toBe(15);
    expect(speedNow(world({ features: ['test:rooted'] }).u('pc1'))).toBe(0);
    // An odd Speed rounds down: 30 + 5 = 35, halved to 17 [U: the bonus before the halving is the code's order].
    expect(speedNow(world({ features: ['test:slowed', 'test:hasted5'] }).u('pc1'))).toBe(17);
    const w = world({ pc: FIGHTER_TEXT.replace('ac: 18', 'ac: 18\narmor: none'), features: ['test:swift', 'test:give-restrained'] });
    expect(speedNow(w.u('pc1'))).toBe(40);
    w.impose('give-restrained', w.u('pc1'));
    expect(speedNow(w.u('pc1'))).toBe(0);
  });

  it('resist, vuln, immune, srd-raw.txt:2240-2276: halve (round down), double, none; the damage odds agree', () => {
    const w = world({ features: ['test:sturdy'] });
    const pc = w.u('pc1');
    const hp = pc.hp;
    damage(w, w.u('dummy'), pc, 9, 'fire');
    expect(hp - pc.hp).toBe(4);
    damage(w, w.u('dummy'), pc, 3, 'cold');
    expect(hp - pc.hp).toBe(10);
    damage(w, w.u('dummy'), pc, 7, 'poison');
    expect(hp - pc.hp).toBe(10);
    const fire: CompiledDamage = { roll: { k: 'const', v: 9 }, critExtra: null, type: 3, avg: 9, ifAdvantage: false };
    expect(damagePmf([fire], pc, false, false)).toMatchObject({ min: 4 });
  });

  it('srd-raw.txt:2260-2269 order of application: "Resistance is applied second; and Vulnerability is applied third" (23 fire halves to 11, then doubles to 22)', () => {
    const w = world({ features: ['test:brittle'] });
    const pc = w.u('pc1');
    const hp = pc.hp;
    damage(w, w.u('dummy'), pc, 23, 'fire');
    expect(hp - pc.hp).toBe(22); // vulnerability first would give 46 / 2 = 23
    const fire: CompiledDamage = { roll: { k: 'const', v: 23 }, critExtra: null, type: 3, avg: 23, ifAdvantage: false };
    expect(damagePmf([fire], pc, false, false)).toMatchObject({ min: 22, p: Float64Array.of(1) });
  });

  it('a gated resist stat applies only while its gate holds (unarmored), in the damage and in the damage odds', () => {
    const fire: CompiledDamage = { roll: { k: 'const', v: 9 }, critExtra: null, type: 3, avg: 9, ifAdvantage: false };
    const armored = world({ features: ['test:ward-bare'] });
    const a = armored.u('pc1');
    const ahp = a.hp;
    damage(armored, armored.u('dummy'), a, 9, 'fire');
    expect(ahp - a.hp).toBe(9); // the sample fighter wears armor: the gate fails
    expect(damagePmf([fire], a, false, false)).toMatchObject({ min: 9 });
    const bare = world({ pc: FIGHTER_TEXT.replace('ac: 18', 'ac: 18\narmor: none'), features: ['test:ward-bare'] });
    const b = bare.u('pc1');
    const bhp = b.hp;
    damage(bare, bare.u('dummy'), b, 9, 'fire');
    expect(bhp - b.hp).toBe(4);
    expect(damagePmf([fire], b, false, false)).toMatchObject({ min: 4 });
  });

  it('critMin: weapon attacks and Unarmed Strikes crit on 19-20, spell attacks don\'t', () => {
    const w = world({ features: ['test:keen'] });
    const pc = w.u('pc1');
    expect(attackSpec(w, pc, w.u('dummy')).spec.critMin).toBe(19);
    const spellAtk = { ...pc.tpl.attacks[0]!, spell: true };
    expect(critMinOf(w.cx.st, pc, spellAtk, null)).toBe(20);
  });

  it('noOpportunityAttacks: the bearer can\'t make Opportunity Attacks', () => {
    const w = world({ features: ['test:addled'] });
    expect(canReactAgainst(w.cx.st, w.u('pc1'), w.u('dummy'))).toBe(false);
    const v = world({ features: [] });
    expect(canReactAgainst(v.cx.st, v.u('pc1'), v.u('dummy'))).toBe(true);
  });

  it('damageType on unarmed (C13, srd-raw.txt:11212-11215): Force when the target resists the normal type, the normal type on a tie', () => {
    const w = world({ features: ['test:empowered'] });
    const pc = w.u('pc1');
    const scratch = { resist: 0, vuln: 0, immune: 0 };
    expect(unarmedTypeFor(w.cx.st, pc, w.u('stone'), 1, scratch)).toBe(4); // bludgeoning resisted -> force
    expect(unarmedTypeFor(w.cx.st, pc, w.u('dummy'), 1, scratch)).toBe(1); // tie keeps bludgeoning
    // In a strike: the damage event names force.
    const sink = new ArraySink();
    for (let seed = 1; seed < 40; seed++) {
      const s = world({ features: ['test:empowered'], sink: new ArraySink(), units: [
        { seat: 'pc1', team: 'party', use: 'test:sample-fighter', at: 'B2' },
        { seat: 'stone', team: 'enemies', use: 'test:stone-target', at: 'C2' },
      ] });
      const sk = new ArraySink();
      const cx = createContext(s.setup, seed, 0, makeDeciders(s.setup), sk, { audit: true });
      applyPassives(cx, -1);
      const p = cx.st.units.find((x) => x.seat === 'pc1')!;
      const st = cx.st.units.find((x) => x.seat === 'stone')!;
      resolveAttack(cx, p, p.tpl.attacks.findIndex((a) => a.unarmed), st, false, -1);
      const hit = sk.events.find((e) => e.k === 'damage');
      if (!hit || hit.k !== 'damage') continue;
      expect(hit.parts[0]!.type).toBe('force');
      sink.emit(hit);
      break;
    }
    expect(sink.events.length).toBe(1);
  });

  it('fly (M3 step 5a): a Fly Speed loads; srd-raw.txt:34218-34228 lets a creature spend the larger of its speeds', () => {
    const r = loadContent(withFiles({ ...KIT, 'packs/test/data/wings.yaml': passive('wings', '    stats: [{ fly: 40 }]') }));
    expect(messages(r)).toBe('');
    const w = world({ features: ['test:wings'], files: { 'packs/test/data/wings.yaml': passive('wings', '    stats: [{ fly: 40 }]') } });
    expect(speedNow(w.u('pc1'), w.cx.st)).toBe(40); // Speed 30, Fly Speed 40
    const bad = loadContent(withFiles({ ...KIT, 'packs/test/data/wings.yaml': passive('wings', '    stats: [{ fly: 0 }]') }));
    expect(messages(bad)).toMatch(/a Fly Speed is a positive multiple of 5 ft/);
  });
});

describe('THP, srd-raw.txt:2398-2414: Temporary Hit Points "can\'t be added together", aren\'t healing, and don\'t wake a creature at 0 HP', () => {
  it('a grant keeps the higher amount', () => {
    const w = world();
    const pc = w.u('pc1');
    const grant = (v: number) => {
      const fr = newFrame(pc, { via: 'test:shore-up', name: 'Shore Up', cause: -1 });
      fr.targets = [pc.idx];
      runSteps(w.cx, fr, [{ k: 'tempHp', roll: { k: 'const', v } }]);
      expect(fr.healed).toBe(false);
    };
    grant(5);
    expect(pc.tempHp).toBe(5);
    grant(3);
    expect(pc.tempHp).toBe(5);
    grant(8);
    expect(pc.tempHp).toBe(8);
    knockOut(w.cx, pc, -1);
    pc.hp = 0;
    grant(9);
    expect(pc.life).toBe('down');
    expect(pc.tempHp).toBe(9);
  });

  it('the compiled step rolls its expression under tempHp', () => {
    const sink = new ArraySink();
    const w = world({ sink });
    const pc = w.u('pc1');
    w.impose('shore-up', pc, pc);
    expect(pc.tempHp).toBeGreaterThanOrEqual(5);
    expect(pc.tempHp).toBeLessThanOrEqual(8);
    expect(renderLog(sink.events, w.setup).join('\n')).toMatch(/Temporary Hit Points .*tempHp r0/);
  });
});

describe('GATE: pure predicates', () => {
  it('unarmored and armored read the armor worn; unknown armor fails both closed', () => {
    const none = world({ pc: FIGHTER_TEXT.replace('ac: 18', 'ac: 18\narmor: none'), features: [] }).u('pc1');
    const heavy = world({ pc: FIGHTER_TEXT.replace('ac: 18', 'ac: 18\narmor: heavy'), features: [] }).u('pc1');
    const unknown = world({ features: [] }).u('pc1');
    expect([gateOk(null, none, { g: 'unarmored' }, null), gateOk(null, none, { g: 'armored' }, null)]).toEqual([true, false]);
    expect([gateOk(null, heavy, { g: 'unarmored' }, null), gateOk(null, heavy, { g: 'armored' }, null)]).toEqual([false, true]);
    expect([gateOk(null, unknown, { g: 'unarmored' }, null), gateOk(null, unknown, { g: 'armored' }, null)]).toEqual([false, false]);
    const def = world({ pc: FIGHTER_TEXT.replace('ac: 18', 'ac: 18\narmor: heavy'), features: ['test:defense'] });
    expect(acNow(def.u('pc1'), def.cx.st)).toBe(19);
  });

  it('noShield, notIncapacitated, ownTurn, hasntMoved, targetHas', () => {
    const w = world();
    const pc = w.u('pc1');
    expect(gateOk(w.cx.st, pc, { g: 'noShield' }, null)).toBe(true);
    expect(gateOk(w.cx.st, pc, { g: 'notIncapacitated' }, null)).toBe(true);
    expect(gateOk(w.cx.st, pc, { g: 'ownTurn' }, null)).toBe(false);
    w.cx.st.active = pc.idx;
    expect(gateOk(w.cx.st, pc, { g: 'ownTurn' }, null)).toBe(true);
    expect(gateOk(w.cx.st, pc, { g: 'hasntMoved' }, null)).toBe(true);
    pc.b.movedFt = 5;
    expect(gateOk(w.cx.st, pc, { g: 'hasntMoved' }, null)).toBe(false);
    expect(gateOk(w.cx.st, pc, { g: 'targetHas', bit: COND.prone }, w.u('dummy'))).toBe(false);
    w.impose('give-prone', w.u('dummy'));
    expect(gateOk(w.cx.st, pc, { g: 'targetHas', bit: COND.prone }, w.u('dummy'))).toBe(true);
  });

  it('a gated mod folds only while its gate holds (targetHas prone)', () => {
    const w = world({ features: ['test:opportunist', 'test:give-prone'] });
    const pc = w.u('pc1');
    expect(attackSpec(w, pc, w.u('dummy')).adv).toEqual([]);
    w.impose('give-prone', w.u('dummy'));
    expect(attackSpec(w, pc, w.u('dummy')).adv).toEqual(['core:target-prone', 'test:opportunist/p']);
  });

  it('a gated feature activation is offered only while its gate holds (hasntMoved)', () => {
    const w = world({ features: ['test:poised'] });
    const pc = w.u('pc1');
    w.cx.st.active = pc.idx;
    pc.b.bonus = 1;
    expect(options(w, pc).some((l) => l.k === 'use' && l.fx < 0)).toBe(true);
    pc.b.movedFt = 5;
    expect(options(w, pc).some((l) => l.k === 'use' && l.fx < 0)).toBe(false);
  });

  it('hasntMoved counts the feet the walker spends: a forced push doesn\'t, one voluntary step does', () => {
    const w = world({ features: ['test:poised'] });
    const pc = w.u('pc1');
    const st = w.cx.st;
    st.active = pc.idx;
    pc.b.bonus = 1;
    pc.b.moveFt = 30;
    const poised = () => options(w, pc).some((l) => l.k === 'use' && l.fx < 0);
    walkPath(w.cx, pc, Int32Array.of(pc.cell - st.setup.w), 1, 'forced', -1, 'push'); // B2 -> B1, shoved
    expect(pc.b.movedFt).toBe(0);
    expect(poised()).toBe(true);
    const step = options(w, pc).find((l) => l.k === 'move' && l.ft === 5 && !l.provokes)!; // staying in the dummy's reach: no Opportunity Attack
    resolveOption(w.cx, pc, { ...newLegal(), ...step }, -1);
    expect(pc.b.movedFt).toBe(5);
    expect(poised()).toBe(false);
  });
});

describe('check: checkSpec through rollD20 kind check', () => {
  it('a PC adds its skill proficiency, doubled with Expertise (srd-raw.txt:33434-33437); the plain check is the ability modifier', () => {
    const prof = world({ pc: FIGHTER_TEXT.replace('saveProficiencies', 'skills: { proficient: [athletics] }\nsaveProficiencies'), features: [] }).u('pc1');
    const exp = world({ pc: FIGHTER_TEXT.replace('saveProficiencies', 'skills: { expertise: [athletics] }\nsaveProficiencies'), features: [] }).u('pc1');
    expect(checkMod(prof, 0, [3])).toEqual({ mod: 6, skill: 3 });
    expect(checkMod(exp, 0, [3])).toEqual({ mod: 9, skill: 3 });
    expect(checkMod(prof, 0, [])).toEqual({ mod: 3, skill: -1 });
    const w = world({ features: [] });
    const c = check(w, w.u('pc1'), 0, [3]);
    expect(c.spec).toMatchObject({ kind: 'check', flat: 3, dc: 10 });
    expect(c.key & RK.KIND).toBe(RK.check);
  });

  it('a stat block checks with its ability modifier (its skill bonuses aren\'t modeled) [U]', () => {
    const w = world({ features: [] });
    expect(checkMod(w.u('stone'), 0, [3])).toEqual({ mod: 0, skill: 3 });
  });
});

describe('passive features apply their stats at fight start (the Unarmored Movement shape)', () => {
  it('a passive speed stat gated on unarmored and noShield is in the first turn\'s budget', () => {
    const w = world({ pc: FIGHTER_TEXT.replace('ac: 18', 'ac: 18\narmor: none'), features: ['test:swift'] });
    const sink = new ArraySink();
    runFight(w.setup, 3, 0, makeDeciders(w.setup), sink);
    const pc = w.setup.seats.findIndex((s) => s.seat === 'pc1');
    expect(sink.events.find((e) => e.k === 'turnStart' && e.who === pc)).toMatchObject({ moveFt: 40 });
  });
});

describe('the importer\'s passive form for Unarmored Movement (a scale column folded into a speed stat)', () => {
  const UM = 'packs/srd-5.2.1/features/monk/unarmored-movement.yaml';
  const umWith = (stat: string) => `kind: feature
id: srd:monk/unarmored-movement
name: Unarmored Movement
source: SRD 5.2.1 p.51
passive: { effects: [movement] }
effects:
  - id: movement
    name: Unarmored Movement
    stats: [${stat}]
`;
  const monkSpeed = (stat: string): number => {
    const content = loadOk(withFiles({ [UM]: umWith(stat) }));
    const doc = { kind: 'scenario', id: 'um', name: 'UM', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: { w: 6, h: 3 }, units: [
      { seat: 'pc1', team: 'party', use: 'test:sample-monk', at: 'B2' },
      { seat: 'dummy', team: 'enemies', use: 'test:training-dummy', at: 'E2' },
    ] };
    const r = resolveScenario(doc, 'um.yaml', content);
    if (!r.setup) throw new Error(r.errors.map(formatDiag).join('\n'));
    const cx = createContext(r.setup, 1, 0, makeDeciders(r.setup), null);
    applyPassives(cx, -1);
    return speedNow(cx.st.units.find((x) => x.seat === 'pc1')!, cx.st);
  };

  // Since the importer step of M3 step 4, content/character.ts puts the passive speed on the sheet
  // (30 + 15 = 45) and leaves the template at 30, so the fight adds the stat exactly once.
  it('"Your speed increases" by the Monk table column (p.51), folded at Monk 6 to +15: 30 in the template, 45 in the fight', () => {
    expect(monkSpeed("{ speed: '@scale.monk.unarmored-movement' }")).toBe(45);
  });

  it('with its gates (unarmored, noShield): the character says it wears no armor (armor: none), so the gates hold', () => {
    expect(monkSpeed("{ speed: '@scale.monk.unarmored-movement', when: [unarmored, noShield] }")).toBe(45);
  });

  it('a stat expression can\'t roll dice', () => {
    const r = loadContent(withFiles({ [UM]: umWith("{ speed: '1d4' }") }));
    expect(messages(r)).toMatch(/a speed stat is a number: it can't roll dice/);
  });
});

describe('C3: new fields are undefined when inert', () => {
  it('a legacy effect, step and template carry none of the step-4 fields', () => {
    const content = loadOk(REPO);
    // kind: character templates are new since step 3 and carry the step-4 fields by design
    // (content/character.ts sets armor; their features' passive stats); the C3 hash test skips them too.
    const characters = new Set(REPO.flatMap((f) => (/^kind: character$/m.test(f.text) ? [/^id: (\S+)$/m.exec(f.text)![1]!] : [])));
    // Monsters the importer emits from step 6 on carry conditionImmune from their stat blocks by design.
    const imported = new Set(REPO.flatMap((f) => (f.text.startsWith('# GENERATED by tools/import-srd') && /^kind: monster$/m.test(f.text) && !f.text.includes('tools/import-srd/overrides/monster/') ? [/^id: (\S+)$/m.exec(f.text)![1]!] : [])));
    for (const t of content.templates) {
      // Coverage step 7.3's test:sample-grove prepares Entangle, whose Restrained is a step-4 field by design.
      if (characters.has(t.id) || imported.has(t.id) || t.id === 'test:sample-grove' || t.id === 'test:sample-adept') continue;
      expect(t.armor).toBeUndefined();
      // The hand-written Knight's Frightened immunity became data after step 6 (srd-raw.txt:50602).
      if (t.id !== 'srd:knight') expect(t.condImmune).toBeUndefined();
      // Coverage step 9+: the Tough's and the Warrior Infantry's Pack Tactics is a gated mod by design (srd-raw.txt:54928-54931, 55578-55580).
      const packTactics = t.id === 'srd:tough' || t.id === 'srd:warrior-infantry';
      for (const e of t.effects) {
        expect([e.cond, e.condImmune, e.stats, e.endsOnDamage]).toEqual([undefined, undefined, undefined, undefined]);
        for (const m of e.mods) expect(m.when).toEqual(packTactics ? [{ g: 'allyWithin5ftOfTarget' }] : undefined);
        for (const g of e.grants) expect(g.when).toBeUndefined();
      }
    }
  });
});

// ---- property tests ----

const RUNS = process.env.MONTECRIT_SLOW ? 300 : 40;
// Each run builds a world and plays up to 25 ops (about 2 s for 40 runs alone, more beside the rest of
// the suite), so the default 5 s timeout flaked under load; scale it with the run count.
const PROP_TIMEOUT = process.env.MONTECRIT_SLOW ? 600_000 : 60_000;

/** Every CondInstance tied to an effect names a live one; every live condition effect's parent lives; condMask is the OR of conds. */
function invariants(w: World): void {
  const st = w.cx.st;
  for (const u of st.units) {
    let m = 0;
    for (const c of u.conds) {
      m |= c.bit;
      if (c.until.k === 'effect') expect(st.fx[c.until.effect]!.alive, `${u.seat} keeps ${c.via} after its effect ended`).toBe(true);
    }
    expect(u.condMask).toBe(m);
  }
  for (const f of st.fx) {
    const te = st.units[f.owner]!.tpl.effects[f.tpl]!;
    if (!f.alive || te.cond === undefined) continue;
    if (f.parent >= 0) expect(st.fx[f.parent]!.alive, `${te.id} outlived its parent`).toBe(true);
  }
}

describe('properties', () => {
  const OPS = fc.oneof(
    fc.record({ k: fc.constant('impose' as const), c: fc.constantFrom(...CONDS, 'stun-save', 'stun-hard', 'net', 'charm-fragile', 'blind-brief'), on: fc.constantFrom('pc1', 'dummy', 'rival', 'stone'), by: fc.constantFrom('pc1', 'rival') }),
    fc.record({ k: fc.constant('endRoot' as const), i: fc.nat(20) }),
    fc.record({ k: fc.constant('turn' as const), who: fc.constantFrom('pc1', 'dummy', 'rival') }),
    fc.record({ k: fc.constant('hit' as const), on: fc.constantFrom('pc1', 'dummy', 'rival'), n: fc.integer({ min: 0, max: 4 }) }),
  );

  it('no condition outlives its source, and immunity blocks (random impose, end, turn and damage sequences)', { timeout: PROP_TIMEOUT }, () => {
    fc.assert(
      fc.property(fc.array(OPS, { maxLength: 25 }), (ops) => {
        const w = world();
        const roots: number[] = [];
        for (const op of ops) {
          if (op.k === 'impose') roots.push(w.impose(CONDS.includes(op.c as (typeof CONDS)[number]) ? `give-${op.c}` : op.c, w.u(op.on), w.u(op.by)));
          else if (op.k === 'endRoot') {
            if (roots.length > 0) endFx(w.cx, roots[op.i % roots.length]!, 'concentration', -1);
          } else if (op.k === 'turn') w.turn(w.u(op.who));
          else damage(w, w.u('stone'), w.u(op.on), op.n, 'slashing');
          invariants(w);
          expect(w.u('stone').condMask).toBe(0);
        }
      }),
      { numRuns: RUNS, seed: 41 },
    );
  });

  it('temp HP never stacks and HP never exceeds its max (random grants, heals and damage)', { timeout: PROP_TIMEOUT }, () => {
    const w0 = world({ features: [] });
    const steps = fc.array(fc.oneof(
      fc.record({ k: fc.constant('temp' as const), v: fc.integer({ min: 0, max: 20 }) }),
      fc.record({ k: fc.constant('heal' as const), v: fc.integer({ min: 0, max: 30 }) }),
      fc.record({ k: fc.constant('hit' as const), v: fc.integer({ min: 0, max: 25 }) }),
    ), { maxLength: 30 });
    fc.assert(
      fc.property(steps, (ops) => {
        const cx = createContext(w0.setup, 1, 0, makeDeciders(w0.setup), null, { audit: true });
        const pc = cx.st.units.find((x) => x.seat === 'pc1')!;
        const foe = cx.st.units.find((x) => x.seat === 'dummy')!;
        for (const op of ops) {
          // A drop that ends the fight (the lone PC down) stops every program (runSteps checks st.outcome).
          if (pc.life === 'dead' || cx.st.outcome) break;
          const before = pc.tempHp;
          if (op.k === 'hit') {
            const part: CompiledDamage = { roll: { k: 'const', v: op.v }, critExtra: null, type: 11, avg: op.v, ifAdvantage: false };
            dealDamage(cx, { unit: foe.idx, via: 'test:hit', slot: 0, cause: -1 }, [part], Int32Array.from([op.v]), () => true, false, [pc.idx]);
          } else {
            const fr = newFrame(pc, { via: 'test:x', name: 'x', cause: -1 });
            fr.targets = [pc.idx];
            const step: Step = op.k === 'temp' ? { k: 'tempHp', roll: { k: 'const', v: op.v } } : { k: 'heal', roll: { k: 'const', v: op.v } };
            runSteps(cx, fr, [step]);
            if (op.k === 'temp') expect(pc.tempHp).toBe(Math.max(before, op.v));
            else expect(pc.tempHp).toBe(before); // healing never restores temp HP
          }
          expect(pc.hp).toBeLessThanOrEqual(pc.hpMax);
          expect(pc.hp).toBeGreaterThanOrEqual(0);
          expect(pc.tempHp).toBeGreaterThanOrEqual(0);
        }
      }),
      { numRuns: RUNS, seed: 42 },
    );
  });

  it('determinism: a fight with every condition primitive in play gives the same log for the same seed, with the dice audit on', { timeout: PROP_TIMEOUT }, () => {
    const w = world({ units: [
      { seat: 'pc1', team: 'party', use: 'test:sample-fighter', at: 'B2' },
      { seat: 'gob1', team: 'enemies', use: 'srd:goblin-warrior', at: 'D2' },
      { seat: 'gob2', team: 'enemies', use: 'srd:goblin-warrior', at: 'E3' },
    ] });
    const setup = { ...w.setup, seats: w.setup.seats.map((s) => ({ ...s, decider: 'random-legal' as const })) };
    const play = (seed: number) => {
      const sink = new ArraySink();
      const res = runFight(setup, seed, 0, makeDeciders(setup), sink, { audit: true });
      return { log: canonicalJson(sink.events), hash: res.stateHash, events: sink.events };
    };
    let conds = 0;
    for (let seed = 1; seed <= (process.env.MONTECRIT_SLOW ? 60 : 12); seed++) {
      const a = play(seed);
      const b = play(seed);
      expect(a.log).toBe(b.log);
      expect(a.hash).toBe(b.hash);
      conds += a.events.filter((e: GameEvent) => e.k === 'cond' && e.on && e.cond !== 'core:prone' && e.cond !== 'core:unconscious').length;
    }
    expect(conds).toBeGreaterThan(0); // the random-legal PC did impose conditions
  });
});

