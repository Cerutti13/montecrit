// Coverage W1.1, builder B1 (docs/design/w1-plan.md section 7, "B1 effects"): the effect-side
// primitives, called directly on constructed states.
//   P1  sustain(): a sustained effect lasts until the end of its bearer's next turn, is re-anchored
//       only on the bearer's own turn, and ends early on Incapacitated (Rage, srd-raw.txt:4982-4993).
//   P2  noCasting and noConcentration (4980-4981).
//   P5  the roll-state gates rollAdv, rollNotDis and anyOf (Sneak Attack, 13738-13743; 1056-1060).
//   P8  dropToOne (Relentless Endurance, 19928-19931; Massive Damage, 2320-2322), with a counters
//       recount from the log.
//   P11 notHeavyArmor (5067-5068), hasntMoved with a free move, endConditions (5183-5184).
// The fixtures are synthetic stand-ins (test: ids, in memory) built from the same primitives the
// SRD items use; none is the item itself. End-to-end tests through attacks and steps are B2's
// (test/w1-attack.test.ts).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../src/content/load.ts';
import { DAMAGE_TYPES, SUSTAIN, type CompiledDamage, type CompiledTemplate, type Content, type Gate } from '../src/content/types.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import { BaselineDecider } from '../src/decide/baseline.ts';
import type { LegalList } from '../src/decide/decider.ts';
import { RandomLegalDecider } from '../src/decide/random-legal.ts';
import { ArraySink, FX_END_WHYS, type GameEvent } from '../src/log/events.ts';
import { resolveAdvantage } from '../src/rolls/rollspec.ts';
import { activate, listCasts } from '../src/sim/cast.ts';
import { endConditions } from '../src/sim/conditions.ts';
import { MAX_POOLS } from '../src/sim/counters.ts';
import { dealDamage } from '../src/sim/damage.ts';
import { boundary, newFx, onIncapacitated, reanchor, sustain } from '../src/sim/effects.ts';
import { createContext, runFight } from '../src/sim/fight.ts';
import { applyPassives } from '../src/sim/precast.ts';
import { gateOk, gatesOk, noCasting, noConcentration, speedOf } from '../src/sim/stats.ts';
import { addCond, COND, has, stateHash, type Unit } from '../src/sim/state.ts';
import { expiryOf } from '../src/sim/steps.ts';
import { MULTI, setup } from './helpers/build.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const walk = (d: string): string[] =>
  readdirSync(d)
    .flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.yaml') ? [p] : [];
    })
    .sort();
const readPack = (name: string): SourceFile[] => walk(join(ROOT, 'packs', name)).map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, 'utf8') }));

const SRC = 'source: synthetic W1.1 B1 fixture';
const UNTIL = '{ until: endOfNextTurn, of: caster }';
const FEATURES: Record<string, string> = {
  // P1, P2, P11: a Rage-shaped form (a sustained root, Resistance, no casting, no concentration), with a plain child.
  'w1b1-rage': `kind: feature
id: test:w1b1-rage
name: W1B1 Rage
${SRC}
activate:
  - { id: rage, name: Rage, cost: bonus, pool: w1b1-rage, root: raging, when: [notHeavyArmor], target: self, do: [{ apply: { effect: steady, to: self } }] }
  # Only so the other effects compile (an effect nothing applies isn't in the template); the tests make them with newFx.
  - { id: others, name: Others, cost: action, root: plain, target: self, do: [{ apply: { effect: partial, to: self } }, { apply: { effect: tough, to: self } }, { apply: { effect: calm, to: self } }] }
effects:
  - id: raging
    name: Raging
    duration: { until: endOfNextTurn, of: bearer }
    sustain: { by: [attackRoll, enemySave] }
    endsOn: [incapacitated]
    stats: [{ resist: [slashing] }, { noCasting: true }, { noConcentration: true }]
  - { id: steady, name: Steady }
  - { id: partial, name: Partial, duration: { until: endOfNextTurn, of: bearer }, sustain: { by: [attackRoll] } }
  - { id: plain, name: Plain, duration: { until: endOfNextTurn, of: bearer } }
  - { id: tough, name: Tough, stats: [{ resist: [piercing] }] }
  - { id: calm, name: Calm, immune: [charmed, frightened] }
`,
  // P8: a Relentless-shaped drop to 1.
  'w1b1-endure': `kind: feature
id: test:w1b1-endure
name: W1B1 Endure
${SRC}
dropToOne: { pool: w1b1-endure }
`,
  // P11 (endConditions): conditions on the user, each a condition step's own effect.
  'w1b1-scare': `kind: feature
id: test:w1b1-scare
name: W1B1 Scare
${SRC}
activate:
  - { id: fear, name: Fear, cost: action, target: self, do: [{ condition: { id: frightened, save: { ability: wis, dc: 30, at: turnEnd }, until: ${UNTIL} } }] }
  - { id: dread, name: Dread, cost: action, target: self, do: [{ condition: { id: frightened, also: [poisoned], until: ${UNTIL} } }] }
  - { id: daze, name: Daze, cost: action, target: self, do: [{ condition: { id: stunned, until: ${UNTIL} } }] }
  - { id: woo, name: Woo, cost: action, target: self, do: [{ condition: { id: charmed, until: ${UNTIL} } }] }
`,
  // P11 (notHeavyArmor): a Fast Movement-shaped passive.
  'w1b1-quick': `kind: feature
id: test:w1b1-quick
name: W1B1 Quick
${SRC}
effects:
  - { id: quick, name: Quick, stats: [{ speed: 10, when: [notHeavyArmor] }] }
passive: { effects: [quick] }
`,
  // P5: a Sneak Attack-shaped gate list (the rider itself is B2's to run).
  'w1b1-sneak': `kind: feature
id: test:w1b1-sneak
name: W1B1 Sneak
${SRC}
riders:
  - { id: sneak, name: Sneak, on: hit, oncePerTurn: global, filter: { weaponProperty: [finesse, ranged] }, when: [{ anyOf: [[rollAdv], [allyWithin5ftOfTarget, rollNotDis]] }], do: [{ damage: [{ roll: 1d6, type: weapon }] }] }
`,
};

const pcText = (id: string, armor: string | null, features: readonly string[], extra = '') => `kind: pc
id: test:${id}
name: ${id}
${SRC}
rules: '2024'
level: 5
size: medium
speed: 30
abilities: { str: 16, dex: 14, con: 14, int: 10, wis: 14, cha: 10 }
hpMax: 40
ac: 14
${armor === null ? '' : `armor: ${armor}\n`}saveProficiencies: [str, con]
weapons:
  - { id: greataxe, name: Greataxe, kind: melee, ability: str, damage: [{ roll: 1d12 + @mod, type: slashing }] }
pools:
  - { id: w1b1-rage, name: Rage, max: 3, recharge: longRest }
  - { id: w1b1-endure, name: Endure, max: 1, recharge: longRest }
features: [${features.join(', ')}]
${extra}`;

const CASTING = `items:
  - { id: charm, name: Charm, kind: focus, focusFor: [druid] }
hands: [charm, null]
slots: [4, 3]
casting:
  - { source: druid, ability: wis, list: druid, cantrips: [test:tether], prepared: [srd:moonbeam] }
`;
const KIT = ['test:w1b1-rage', 'test:w1b1-endure', 'test:w1b1-scare', 'test:w1b1-quick', 'test:w1b1-sneak'];
const PCS: Record<string, string> = {
  'w1b1-rager': pcText('w1b1-rager', 'none', KIT, CASTING),
  'w1b1-medium': pcText('w1b1-medium', 'medium', KIT),
  'w1b1-light': pcText('w1b1-light', 'light', KIT),
  'w1b1-heavy': pcText('w1b1-heavy', 'heavy', KIT),
  'w1b1-unknown': pcText('w1b1-unknown', null, KIT),
  'w1b1-orc': pcText('w1b1-orc', 'light', ['test:w1b1-endure']),
};

const loaded = loadContent([
  ...readPack('srd-5.2.1'),
  ...readPack('test'),
  ...Object.entries(FEATURES).map(([n, text]) => ({ path: `packs/test/features/${n}.yaml`, text })),
  ...Object.entries(PCS).map(([n, text]) => ({ path: `packs/test/pcs/${n}.yaml`, text })),
]);
const C: Content = (() => {
  if (!loaded.content) throw new Error(loaded.errors.map(formatDiag).join('\n'));
  return loaded.content;
})();
const tpl = (id: string): CompiledTemplate => C.get(`test:${id}`)!;
const fxIdx = (t: CompiledTemplate, local: string): number => {
  const i = t.effects.findIndex((e) => e.id === `test:w1b1-rage/${local}`);
  if (i < 0) throw new Error(`no effect ${local}`);
  return i;
};
const featIdx = (t: CompiledTemplate, id: string): number => t.features.findIndex((f) => f.id === id);

/** A context with the PC at C3, an ally at C5 and a foe (MULTI, 40 HP) at C4: the foe's square is within 5 ft of both. */
function ctx(pc = 'w1b1-rager', sink: ArraySink | null = null) {
  const s = setup({
    w: 8,
    h: 8,
    units: [
      { seat: 'pc', team: 0, tpl: tpl(pc), at: 'C3' },
      { seat: 'pc2', team: 0, tpl: tpl('w1b1-orc'), at: 'C5' },
      { seat: 'zfoe', team: 1, tpl: MULTI, at: 'C4' },
    ],
  });
  const cx = createContext(s, 1, 0, s.seats.map(() => new BaselineDecider()), sink);
  const by = (seat: string): Unit => cx.st.units[s.seats.findIndex((x) => x.seat === seat)]!;
  return { cx, st: cx.st, pc: by('pc'), ally: by('pc2'), foe: by('zfoe') };
}

/** `u`'s turn `n` starts (its turn number is n, and it's the active creature), with a fresh action economy. */
function startTurn(c: ReturnType<typeof ctx>, u: Unit, n: number): void {
  u.turns = n;
  c.st.active = u.idx;
  u.b.action = 1;
  u.b.bonus = 1;
  boundary(c.cx, 'start', u, -1);
}

function endTurn(c: ReturnType<typeof ctx>, u: Unit): void {
  boundary(c.cx, 'end', u, -1);
}

/** Uses the Rage stand-in (activation 0) and returns its root Fx. */
function rage(c: ReturnType<typeof ctx>) {
  const fi = featIdx(c.pc.tpl, 'test:w1b1-rage');
  activate(c.cx, c.pc, fi, 0, -1);
  return c.st.fx.find((f) => f.alive && f.tpl === fxIdx(c.pc.tpl, 'raging'))!;
}

describe('W1 P1: a sustained effect (B1, sim/effects.ts sustain)', () => {
  it('the Rage lasts until the end of your next turn (4982-4983)', () => {
    const c = ctx();
    startTurn(c, c.pc, 1);
    const f = rage(c);
    expect(f.until).toEqual({ k: 'turnEnd', unit: c.pc.idx, after: 1 });
    endTurn(c, c.pc);
    expect(f.alive).toBe(true);
    startTurn(c, c.foe, 1);
    endTurn(c, c.foe);
    startTurn(c, c.pc, 2);
    expect(f.alive).toBe(true);
    endTurn(c, c.pc); // nothing extended it on this, its next turn
    expect(f.alive).toBe(false);
  });

  it('sustain re-anchors only on the bearer\'s own turn (4985-4986)', () => {
    const c = ctx();
    startTurn(c, c.pc, 1);
    const f = rage(c);
    endTurn(c, c.pc);
    // Someone else's turn: an opportunity attack or a save there doesn't extend it.
    startTurn(c, c.foe, 1);
    sustain(c.cx, c.pc, SUSTAIN.attackRoll);
    sustain(c.cx, c.pc, SUSTAIN.enemySave);
    expect(f.until).toEqual({ k: 'turnEnd', unit: c.pc.idx, after: 1 });
    // Between its own turns a re-anchor would land on the same turn number, so the guard is checked
    // on its own: with the bearer's turn count moved on, an off-turn call still changes nothing.
    c.pc.turns = 2;
    sustain(c.cx, c.pc, SUSTAIN.attackRoll);
    expect(f.until).toEqual({ k: 'turnEnd', unit: c.pc.idx, after: 1 });
    c.pc.turns = 1;
    endTurn(c, c.foe);
    // Its own next turn: an attack roll against an enemy extends it to the end of the turn after.
    startTurn(c, c.pc, 2);
    sustain(c.cx, c.pc, SUSTAIN.attackRoll);
    expect(f.until).toEqual({ k: 'turnEnd', unit: c.pc.idx, after: 2 });
    endTurn(c, c.pc);
    expect(f.alive).toBe(true);
    startTurn(c, c.pc, 3);
    sustain(c.cx, c.pc, SUSTAIN.enemySave); // forcing an enemy to save does it too
    endTurn(c, c.pc);
    expect(f.alive).toBe(true);
    startTurn(c, c.pc, 4);
    endTurn(c, c.pc);
    expect(f.alive).toBe(false);
  });

  it('sustain touches only live effects the creature owns and bears whose sustain bits match', () => {
    const c = ctx();
    startTurn(c, c.pc, 1);
    const mk = (local: string, bearer: Unit) => {
      const te = c.pc.tpl.effects[fxIdx(c.pc.tpl, local)]!;
      return newFx(c.cx, { tpl: fxIdx(c.pc.tpl, local), owner: c.pc.idx, bearer: bearer.idx, parent: -1, param: -1, srcItem: -1, until: expiryOf(te, c.pc, bearer), cause: -1 });
    };
    const partial = mk('partial', c.pc); // sustained by attack rolls only
    const plain = mk('plain', c.pc); // no sustain field
    const onAlly = mk('partial', c.ally); // the PC owns it, the ally bears it
    endTurn(c, c.pc);
    startTurn(c, c.pc, 2);
    c.ally.turns = 2;
    sustain(c.cx, c.pc, SUSTAIN.enemySave);
    expect(partial.until).toEqual({ k: 'turnEnd', unit: c.pc.idx, after: 1 }); // a save doesn't extend an attackRoll-only effect
    sustain(c.cx, c.pc, SUSTAIN.attackRoll);
    expect(partial.until).toEqual({ k: 'turnEnd', unit: c.pc.idx, after: 2 });
    expect(plain.until).toEqual({ k: 'turnEnd', unit: c.pc.idx, after: 1 });
    c.st.active = c.ally.idx;
    sustain(c.cx, c.ally, SUSTAIN.attackRoll); // the ally's own turn, but it doesn't own the effect
    expect(onAlly.until).toEqual({ k: 'turnEnd', unit: c.ally.idx, after: 0 }); // as made on the ally's turn 0
  });

  it('reanchor (the extendSource helper) moves only the turn number, and moves the state hash only for that effect', () => {
    const c = ctx();
    startTurn(c, c.pc, 1);
    const f = rage(c);
    const h0 = stateHash(c.st);
    reanchor(f, c.pc); // same turn: no change, no new object
    expect(stateHash(c.st)).toBe(h0);
    c.pc.turns = 2;
    const h1 = stateHash(c.st);
    reanchor(f, c.pc);
    expect(f.until).toEqual({ k: 'turnEnd', unit: c.pc.idx, after: 2 });
    expect(stateHash(c.st)).not.toBe(h1);
  });

  it('it ends early on the Incapacitated condition (4983-4984), and its children with it', () => {
    const c = ctx();
    startTurn(c, c.pc, 1);
    const f = rage(c);
    const child = c.st.fx.find((x) => x.alive && x.parent === f.id)!;
    expect(child).toBeDefined();
    onIncapacitated(c.cx, c.pc, -1);
    expect([f.alive, child.alive]).toEqual([false, false]);
  });

  it('dropping to 0 Hit Points ends it (Unconscious includes Incapacitated)', () => {
    const c = ctx('w1b1-rager');
    startTurn(c, c.pc, 1);
    const f = rage(c);
    c.pc.res[c.pc.tpl.features[featIdx(c.pc.tpl, 'test:w1b1-endure')]!.dropToOne!.pool] = 0; // no drop to 1 here
    c.pc.hp = 5;
    hit(c, c.pc, 6, 'bludgeoning');
    expect([c.pc.life, f.alive]).toEqual(['down', false]);
  });
});

describe('W1 P2: noCasting and noConcentration (B1)', () => {
  it('a raging creature can\'t cast spells (4981)', () => {
    const c = ctx();
    startTurn(c, c.pc, 1);
    const casts = () => {
      const out: LegalList = { n: 0, items: [] };
      listCasts(c.cx, c.pc, out);
      return out.n;
    };
    expect(casts()).toBeGreaterThan(0);
    rage(c);
    c.pc.b.action = 1;
    c.pc.b.bonus = 1;
    expect([noCasting(c.st, c.pc), casts()]).toEqual([true, 0]);
  });

  it('entering Rage ends Concentration (4980), logged after the Rage and counted', () => {
    const sink = new ArraySink();
    const c = ctx('w1b1-rager', sink);
    startTurn(c, c.pc, 1);
    const e = c.pc.tpl.spells.find((x) => x.spell.id === 'srd:moonbeam')!;
    const inst = e.instance[2]!;
    const conc = newFx(c.cx, { tpl: inst, owner: c.pc.idx, bearer: -1, parent: -1, param: -1, srcItem: -1, until: expiryOf(c.pc.tpl.effects[inst]!, c.pc, c.pc), cause: -1 });
    c.pc.conc = conc.id;
    c.st.ctr.concStart[c.pc.idx]!++;
    const f = rage(c);
    expect([conc.alive, c.pc.conc, noConcentration(c.st, c.pc)]).toEqual([false, -1, true]);
    expect(c.st.ctr.concEnd[c.pc.idx * FX_END_WHYS.length + FX_END_WHYS.indexOf('concentration')]).toBe(1);
    const start = sink.events.find((x) => x.k === 'fxStart' && x.fx === f.id)!;
    const end = sink.events.find((x) => x.k === 'fxEnd' && x.fx === conc.id)!;
    expect(end).toMatchObject({ why: 'concentration', cause: start.seq });
    expect(end.seq).toBeGreaterThan(start.seq);
  });

  it('an effect with other stats leaves Concentration alone', () => {
    const c = ctx();
    startTurn(c, c.pc, 1);
    const e = c.pc.tpl.spells.find((x) => x.spell.id === 'srd:moonbeam')!;
    const inst = e.instance[2]!;
    const conc = newFx(c.cx, { tpl: inst, owner: c.pc.idx, bearer: -1, parent: -1, param: -1, srcItem: -1, until: { k: 'never' }, cause: -1 });
    c.pc.conc = conc.id;
    newFx(c.cx, { tpl: fxIdx(c.pc.tpl, 'tough'), owner: c.pc.idx, bearer: c.pc.idx, parent: -1, param: -1, srcItem: -1, until: { k: 'never' }, cause: -1 });
    expect([conc.alive, c.pc.conc]).toEqual([true, conc.id]);
  });

  it('a Rage that ends gives casting back', () => {
    const c = ctx();
    startTurn(c, c.pc, 1);
    rage(c);
    onIncapacitated(c.cx, c.pc, -1);
    expect(noCasting(c.st, c.pc)).toBe(false);
  });
});

describe('W1 P5: roll-state gates (B1, sim/stats.ts gateOk)', () => {
  const sneakWhen = (t: CompiledTemplate): readonly Gate[] => t.riders!.find((r) => r.local === 'sneak')!.when!;

  it('the compiled Sneak Attack gate is one anyOf of [rollAdv] and [allyWithin5ftOfTarget, rollNotDis]', () => {
    expect(sneakWhen(tpl('w1b1-rager'))).toEqual([{ g: 'anyOf', any: [[{ g: 'rollAdv' }], [{ g: 'allyWithin5ftOfTarget' }, { g: 'rollNotDis' }]] }]);
  });

  it('Sneak Attack with Advantage (13738)', () => {
    const c = ctx();
    c.ally.cell = c.ally.cell + 3; // far from the foe
    expect(gatesOk(c.st, c.pc, sneakWhen(c.pc.tpl), c.foe, 'adv')).toBe(true);
    expect(gatesOk(c.st, c.pc, sneakWhen(c.pc.tpl), c.foe, 'none')).toBe(false);
  });

  it('without Advantage when an ally is within 5 feet of the target (13741-13742)', () => {
    const c = ctx();
    expect(gatesOk(c.st, c.pc, sneakWhen(c.pc.tpl), c.foe, 'none')).toBe(true);
  });

  it('not when that ally is Incapacitated (13742)', () => {
    const c = ctx();
    addCond(c.ally, COND.incapacitated, 'test:stun', -1, -1, { k: 'never' });
    expect(gatesOk(c.st, c.pc, sneakWhen(c.pc.tpl), c.foe, 'none')).toBe(false);
  });

  it('not with Disadvantage, even with the ally (13743)', () => {
    const c = ctx();
    expect(gatesOk(c.st, c.pc, sneakWhen(c.pc.tpl), c.foe, 'dis')).toBe(false);
  });

  it('Advantage and Disadvantage cancel, so the ally clause applies (1056-1060)', () => {
    const c = ctx();
    const both = resolveAdvantage(['core:target-restrained'], ['core:attacker-poisoned']);
    expect(both).toBe('none');
    expect(gatesOk(c.st, c.pc, sneakWhen(c.pc.tpl), c.foe, both)).toBe(true);
    c.ally.cell = c.ally.cell + 3;
    expect(gatesOk(c.st, c.pc, sneakWhen(c.pc.tpl), c.foe, both)).toBe(false); // and only it: the cancelled Advantage doesn't count
  });

  it('every roll-state gate fails closed with no roll (a decider\'s read, an effect\'s when)', () => {
    const c = ctx();
    expect(gateOk(c.st, c.pc, { g: 'rollAdv' }, c.foe)).toBe(false);
    expect(gateOk(c.st, c.pc, { g: 'rollNotDis' }, c.foe)).toBe(false);
    expect(gatesOk(c.st, c.pc, sneakWhen(c.pc.tpl), c.foe)).toBe(false);
    expect(gateOk(c.st, c.pc, { g: 'rollNotDis' }, c.foe, 'adv')).toBe(true);
    expect(gateOk(c.st, c.pc, { g: 'rollNotDis' }, c.foe, 'none')).toBe(true);
    expect(gateOk(c.st, c.pc, { g: 'rollAdv' }, c.foe, 'none')).toBe(false);
  });

  it('anyOf holds when any one list holds in full, and needs every gate of that list', () => {
    const c = ctx();
    const g: Gate = { g: 'anyOf', any: [[{ g: 'ownTurn' }, { g: 'rollAdv' }], [{ g: 'notHeavyArmor' }, { g: 'rollNotDis' }]] };
    c.st.active = c.foe.idx;
    expect(gateOk(c.st, c.pc, g, null, 'adv')).toBe(true); // second list
    expect(gateOk(c.st, c.pc, g, null, 'dis')).toBe(false); // neither
    c.st.active = c.pc.idx;
    expect(gateOk(c.st, c.pc, g, null, 'adv')).toBe(true); // first list
  });
});

/** One damage instance of `n` of `type` from the foe to `t`. */
function hit(c: ReturnType<typeof ctx>, t: Unit, n: number, type: string): void {
  const part: CompiledDamage = { roll: { k: 'const', v: n }, critExtra: null, type: DAMAGE_TYPES.indexOf(type as never), avg: n, ifAdvantage: false };
  dealDamage(c.cx, { unit: c.foe.idx, via: MULTI.attacks[0]!.id, slot: 0, cause: -1 }, [part], Int32Array.of(n), () => true, false, [t.idx]);
}

describe('W1 P8: drop to 1 (B1, sim/damage.ts)', () => {
  const pool = (u: Unit) => u.tpl.features.find((f) => f.dropToOne)!.dropToOne!.pool;

  it('reduced to 0 but not killed outright, you drop to 1 instead (19928-19930)', () => {
    const sink = new ArraySink();
    const c = ctx('w1b1-orc', sink);
    c.pc.hp = 10;
    hit(c, c.pc, 25, 'slashing');
    expect([c.pc.hp, c.pc.life, has(c.pc, COND.unconscious), c.pc.res[pool(c.pc)]]).toEqual([1, 'up', false, 0]);
    expect([c.st.ctr.drops[c.pc.idx], c.st.ctr.dmgTaken[c.pc.idx]]).toEqual([0, 9]); // no drop counted; it lost 10 - 1
    const evs = sink.events.filter((e) => e.k === 'damage' || e.k === 'act' || e.k === 'res' || e.k === 'down');
    expect(evs.map((e) => e.k)).toEqual(['damage', 'act', 'res']);
    expect(evs[0]).toMatchObject({ hpBefore: 10, hpAfter: 1 });
    expect(evs[1]).toMatchObject({ who: c.pc.idx, via: 'test:w1b1-endure', name: 'W1B1 Endure', cause: evs[0]!.seq });
    expect(evs[2]).toMatchObject({ who: c.pc.idx, left: 0, cause: evs[1]!.seq });
  });

  it('only once (19930-19931)', () => {
    const c = ctx('w1b1-orc');
    c.pc.hp = 10;
    hit(c, c.pc, 12, 'slashing');
    expect(c.pc.hp).toBe(1);
    hit(c, c.pc, 3, 'slashing');
    expect([c.pc.hp, c.pc.life, c.st.ctr.drops[c.pc.idx]]).toEqual([0, 'down', 1]);
  });

  it('massive damage still kills (2320-2322)', () => {
    const c = ctx('w1b1-orc');
    c.pc.hp = 10;
    hit(c, c.pc, 50, 'slashing'); // 40 left over, equal to its Hit Point maximum
    expect([c.pc.life, c.pc.res[pool(c.pc)]]).toEqual(['dead', 1]);
    const d = ctx('w1b1-orc');
    d.pc.hp = 10;
    hit(d, d.pc, 49, 'slashing'); // 39 left over: not killed outright
    expect([d.pc.hp, d.pc.life]).toEqual([1, 'up']);
  });

  it('a creature already at 0 doesn\'t use it, and neither does a stat block', () => {
    const c = ctx('w1b1-orc');
    c.pc.hp = 10;
    c.pc.res[pool(c.pc)] = 0;
    hit(c, c.pc, 12, 'slashing');
    expect(c.pc.life).toBe('down');
    c.pc.res[pool(c.pc)] = 1;
    hit(c, c.pc, 1, 'slashing'); // a death-save failure, not a drop
    expect([c.pc.hp, c.pc.life, c.pc.res[pool(c.pc)], c.pc.deathFail]).toEqual([0, 'down', 1, 1]);
    const m = ctx('w1b1-orc');
    const asMonster = { ...m.pc.tpl, kind: 'monster' as const };
    const s = setup({ w: 6, h: 6, units: [{ seat: 'm', team: 0, tpl: asMonster, at: 'A1', atZero: 'deathSaves' }, { seat: 'z', team: 1, tpl: MULTI, at: 'A2' }] });
    const mc = createContext(s, 1, 0, [new BaselineDecider(), new BaselineDecider()], null);
    const u = mc.st.units[0]!;
    u.hp = 5;
    dealDamage(mc, { unit: 1, via: MULTI.attacks[0]!.id, slot: 0, cause: -1 }, [{ roll: { k: 'const', v: 9 }, critExtra: null, type: 0, avg: 9, ifAdvantage: false }], Int32Array.of(9), () => true, false, [0]);
    expect([u.hp, u.life]).toEqual([0, 'down']);
  });

  it('the counters match a recount of the log with a drop to 1, with and without a sink (random-legal fights)', () => {
    const s = setup({
      w: 8,
      h: 8,
      units: [
        { seat: 'pc', team: 0, tpl: tpl('w1b1-orc'), at: 'C3', hp: 14, decider: 'random-legal' },
        { seat: 'za', team: 1, tpl: MULTI, at: 'C4' },
        { seat: 'zb', team: 1, tpl: MULTI, at: 'D4' },
      ],
    });
    let used = 0;
    for (let run = 0; run < 40; run++) {
      const mk = () => s.seats.map(() => new RandomLegalDecider());
      const sink = new ArraySink();
      const logged = runFight(s, 7, run, mk(), sink);
      const silent = runFight(s, 7, run, mk(), null);
      expect(silent.counters).toEqual(logged.counters);
      expect(silent.stateHash).toBe(logged.stateHash);
      const r = recount(sink.events, logged.counters.layout.units);
      const c = logged.counters;
      expect([...c.drops]).toEqual([...r.drops]);
      expect([...c.dmgTaken]).toEqual([...r.dmgTaken]);
      expect([...c.death]).toEqual([...r.death]);
      const pools = Array.from({ length: r.units }, (_, u) => c.pools.slice(u * MAX_POOLS, (u + 1) * MAX_POOLS).reduce((a, b) => a + b, 0));
      expect(pools).toEqual([...r.poolTotal]);
      used += sink.events.filter((e) => e.k === 'act' && e.via === 'test:w1b1-endure').length;
    }
    expect(used).toBeGreaterThan(0); // the fights exercised it
  });
});

/** The subset of test/counters.test.ts's recount that a drop to 1 touches. */
function recount(events: readonly GameEvent[], units: number) {
  const drops = new Uint8Array(units);
  const dmgTaken = new Int32Array(units);
  const death = new Uint8Array(units);
  const poolTotal = new Int16Array(units);
  for (const e of events) {
    if (e.k === 'damage') {
      dmgTaken[e.tgt]! += e.tempAbsorbed + e.hpBefore - e.hpAfter;
      if (e.hpBefore > 0 && e.hpAfter === 0) drops[e.tgt]!++;
    } else if (e.k === 'death') death[e.who] = e.why === 'zeroHp' ? 1 : e.why === 'massive' ? 2 : 3;
    else if (e.k === 'res') poolTotal[e.who]! += e.delta === undefined ? 1 : e.delta < 0 ? -e.delta : 0;
    else if (e.k === 'react' || (e.k === 'cast' && e.free)) poolTotal[e.who]!++;
  }
  return { units, drops, dmgTaken, death, poolTotal };
}

describe('W1 P11: small gates and ending a condition (B1)', () => {
  it('Fast Movement: +10 ft unless in Heavy armor (5067-5068)', () => {
    const speeds: Record<string, number> = {};
    for (const pc of ['w1b1-rager', 'w1b1-light', 'w1b1-medium', 'w1b1-heavy']) {
      const c = ctx(pc);
      applyPassives(c.cx, -1);
      speeds[pc] = speedOf(c.st, c.pc);
      expect(gateOk(c.st, c.pc, { g: 'notHeavyArmor' }, null), pc).toBe(pc !== 'w1b1-heavy');
    }
    expect(speeds).toEqual({ 'w1b1-rager': 40, 'w1b1-light': 40, 'w1b1-medium': 40, 'w1b1-heavy': 30 });
  });

  it('no armor field: no Fast Movement (fails closed, like unarmored and armored)', () => {
    const c = ctx('w1b1-unknown');
    expect(c.pc.tpl.armor).toBeUndefined();
    applyPassives(c.cx, -1);
    expect([gateOk(c.st, c.pc, { g: 'notHeavyArmor' }, null), speedOf(c.st, c.pc)]).toEqual([false, 30]);
  });

  it('notHeavyArmor gates the Rage stand-in\'s activation the same way (4701-4702)', () => {
    for (const [pc, ok] of [['w1b1-rager', true], ['w1b1-heavy', false], ['w1b1-unknown', false]] as const) {
      const c = ctx(pc);
      const a = c.pc.tpl.features[featIdx(c.pc.tpl, 'test:w1b1-rage')]!.activate!;
      expect(gatesOk(c.st, c.pc, a.when), pc).toBe(ok);
    }
  });

  it('a free move counts as moving for hasntMoved (Steady Aim, 13792-13793)', () => {
    const c = ctx();
    startTurn(c, c.pc, 1);
    c.pc.b.movedFt = 0;
    c.pc.b.freeFt = 0;
    expect(gateOk(c.st, c.pc, { g: 'hasntMoved' }, null)).toBe(true);
    c.pc.b.freeFt = 15;
    expect(gateOk(c.st, c.pc, { g: 'hasntMoved' }, null)).toBe(false);
    c.st.active = c.foe.idx; // off its turn it hasn't moved this turn
    expect(gateOk(c.st, c.pc, { g: 'hasntMoved' }, null)).toBe(true);
  });

  /** Uses activation `aux` of the scare stand-in on the PC itself. */
  const scare = (c: ReturnType<typeof ctx>, aux: number) => {
    c.pc.b.action = 1;
    activate(c.cx, c.pc, featIdx(c.pc.tpl, 'test:w1b1-scare'), aux, -1);
  };
  const condFx = (c: ReturnType<typeof ctx>, name: string) => c.st.fx.filter((f) => f.bearer === c.pc.idx && c.pc.tpl.effects[f.tpl]!.name === name);

  it('Mindless Rage: Charmed or Frightened ends on entering Rage (5183-5184)', () => {
    const sink = new ArraySink();
    const c = ctx('w1b1-rager', sink);
    startTurn(c, c.pc, 1);
    scare(c, 0); // Frightened, its own effect with a repeat save
    scare(c, 3); // Charmed, its own effect
    addCond(c.pc, COND.frightened, 'test:plain-fear', c.foe.idx, -1, { k: 'never' }); // a plain instance too
    const [fear] = condFx(c, 'Frightened');
    const [charm] = condFx(c, 'Charmed');
    expect([has(c.pc, COND.frightened), has(c.pc, COND.charmed)]).toEqual([true, true]);
    const f = rage(c);
    // The augment's child (immune) and then the step: what a Mindless Rage augment does under the root.
    newFx(c.cx, { tpl: fxIdx(c.pc.tpl, 'calm'), owner: c.pc.idx, bearer: c.pc.idx, parent: f.id, param: -1, srcItem: -1, until: { k: 'never' }, cause: -1 });
    const before = sink.events.length;
    endConditions(c.cx, c.pc, COND.charmed | COND.frightened, 'test:w1b1-rage', -1);
    expect([has(c.pc, COND.frightened), has(c.pc, COND.charmed), fear!.alive, charm!.alive]).toEqual([false, false, false, false]);
    const evs = sink.events.slice(before);
    expect(evs.filter((e) => e.k === 'fxEnd').map((e) => [e.k === 'fxEnd' && e.fx, e.k === 'fxEnd' && e.why])).toEqual([[fear!.id, 'dismissed'], [charm!.id, 'dismissed']]);
    expect(evs.filter((e) => e.k === 'cond').map((e) => e.k === 'cond' && [e.cond, e.on, e.via])).toEqual([
      ['core:charmed', false, charm && c.pc.tpl.effects[charm.tpl]!.id], // the Fear effect's end leaves the plain Frightened instance, so its line comes last
      ['core:frightened', false, 'test:w1b1-rage'],
    ]);
    // While the immunity lasts, it can't be Frightened again.
    scare(c, 0);
    expect(has(c.pc, COND.frightened)).toBe(false);
  });

  it('a condition carried with another one loses only that condition; other conditions stay', () => {
    const c = ctx();
    startTurn(c, c.pc, 1);
    scare(c, 1); // Frightened and Poisoned in one effect
    scare(c, 2); // Stunned (and Incapacitated)
    addCond(c.pc, COND.prone, 'core:fell-prone', -1, -1, { k: 'never' });
    const [dread] = condFx(c, 'Frightened');
    const [daze] = condFx(c, 'Stunned');
    endConditions(c.cx, c.pc, COND.charmed | COND.frightened, 'test:w1b1-rage', -1);
    expect([dread!.alive, has(c.pc, COND.frightened), has(c.pc, COND.poisoned)]).toEqual([true, false, true]);
    expect([daze!.alive, has(c.pc, COND.stunned), has(c.pc, COND.incapacitated), has(c.pc, COND.prone)]).toEqual([true, true, true, true]);
    // When the carrying effect ends later, the rest of it goes as usual.
    onIncapacitated(c.cx, c.pc, -1);
  });

  it('nothing to end: no seq, no event, no state change', () => {
    const sink = new ArraySink();
    const c = ctx('w1b1-rager', sink);
    const before = [sink.events.length, stateHash(c.st)];
    endConditions(c.cx, c.pc, COND.charmed | COND.frightened, 'test:w1b1-rage', -1);
    expect([sink.events.length, stateHash(c.st)]).toEqual(before);
  });
});
