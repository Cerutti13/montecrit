// The effect core: when effects end (riders, timed durations, dead anchors), the end
// cascade, the once-per-turn ledger, same-spell potency, roll modifiers and riders, and the
// concentration save. Effects here are hand-built; the compiler makes the real ones.
import { describe, expect, it } from 'vitest';
import { attackKey, checkKey, compileKeyPattern, saveKey, SKILLS } from '../src/content/rollkeys.ts';
import { END, HOOK, type BoundEffect, type CompiledMod } from '../src/content/types.ts';
import { makeDeciders } from '../src/decide/make.ts';
import { parseExpr } from '../src/dice/expr.ts';
import { ArraySink } from '../src/log/events.ts';
import { renderLog } from '../src/log/render.ts';
import { flagIndex, type RuleFlags } from '../src/rules/flags.ts';
import { resolveAttack } from '../src/sim/attack.ts';
import { acNow } from '../src/sim/hands.ts';
import { dealDamage, kill } from '../src/sim/damage.ts';
import { boundary, endFx, foldMods, ghostTurn, ledgerMark, ledgerOk, newFx, newModFold, onIncapacitated } from '../src/sim/effects.ts';
import { createContext } from '../src/sim/fight.ts';
import { drain, queueTrigger, TRIG } from '../src/sim/triggers.ts';
import { addCond, COND, has, type Expiry, type Fx, type Unit } from '../src/sim/state.ts';
import { DUMMY, dmg, effect, FIGHTER, S, setup, template, withEffects } from './helpers/build.ts';
import { ofKind } from './helpers/run.ts';

const skill = (name: string) => SKILLS.findIndex(([n]) => n === name);

const adv = (local: string, over: Partial<BoundEffect> = {}) =>
  effect(local, { mods: [mod('adv', 'd20.attack', { side: 'incoming', consume: true })], ...over });

function mod(op: CompiledMod['op'], on: string, over: Partial<CompiledMod> = {}): CompiledMod {
  return { on: [compileKeyPattern(on)], side: 'self', op, value: 0, dice: null, consume: false, skillParam: false, ...over };
}

/** pc (owner of every effect) at A1, g (a dummy) at B1, ally at C1. */
function scene(effects: BoundEffect[], flags: Partial<RuleFlags> = {}, sink: ArraySink | null = null) {
  const pcTpl = withEffects(FIGHTER, effects);
  const s = setup({
    w: 6, h: 2, flags,
    units: [{ seat: 'pc', team: 0, tpl: pcTpl, at: 'A1' }, { seat: 'g', team: 1, tpl: DUMMY, at: 'B1' }, { seat: 'ally', team: 0, tpl: FIGHTER, at: 'C1' }],
  });
  const cx = createContext(s, 1, 0, makeDeciders(s), sink, { audit: true });
  const u = (seat: string): Unit => cx.st.units.find((x) => x.seat === seat)!;
  const fx = (tpl: number, owner: Unit, bearer: Unit | null, until: Expiry, parent = -1): Fx =>
    newFx(cx, { tpl, owner: owner.idx, bearer: bearer ? bearer.idx : -1, parent, param: -1, srcItem: -1, until, cause: -1 });
  const turn = (who: Unit, body?: () => void) => {
    cx.st.active = who.idx;
    cx.st.turnIdx++;
    who.turns++;
    boundary(cx, 'start', who, -1);
    body?.();
    boundary(cx, 'end', who, -1);
    cx.st.active = -1;
  };
  return { cx, u, fx, turn, s };
}

describe('when effects end', () => {
  it('"until the end of your next turn" survives the turn it lands on and ends at the end of the next (p.29 reading)', () => {
    const { u, fx, turn } = scene([adv('lit')]);
    const pc = u('pc');
    let f!: Fx;
    turn(pc, () => (f = fx(0, pc, u('g'), { k: 'turnEnd', unit: pc.idx, after: pc.turns })));
    expect(f.alive).toBe(true);
    turn(u('g'));
    expect(f.alive).toBe(true);
    turn(pc);
    expect(f.alive).toBe(false);
  });

  it('applied on someone else\'s turn, it still lasts to the end of the anchor\'s next turn', () => {
    const { u, fx, turn } = scene([adv('lit')]);
    const pc = u('pc');
    turn(pc);
    let f!: Fx;
    turn(u('g'), () => (f = fx(0, pc, u('g'), { k: 'turnEnd', unit: pc.idx, after: pc.turns })));
    expect(f.alive).toBe(true);
    turn(pc);
    expect(f.alive).toBe(false);
  });

  it('Disengage-style "this turn" (after = turns - 1) ends at the end of the current turn', () => {
    const { u, turn } = scene([]);
    const pc = u('pc');
    turn(pc, () => addCond(pc, COND.disengaged, 'core:disengage', pc.idx, -1, { k: 'turnEnd', unit: pc.idx, after: pc.turns - 1 }));
    expect(has(pc, COND.disengaged)).toBe(false);
  });

  it('a 10-round duration from the creator\'s turn #k ends at the start (default) or the end of turn #k+10', () => {
    for (const [point, endsAtStart] of [['startOfCreatorTurn', true], ['endOfCreatorTurn', false]] as const) {
      const { cx, u, fx, turn } = scene([effect('spell')], { timedDurationExpiryPoint: point });
      const pc = u('pc');
      let f!: Fx;
      turn(pc, () => (f = fx(0, pc, null, { k: 'timed', unit: pc.idx, turn: pc.turns + 10 })));
      for (let k = 2; k <= 10; k++) turn(pc);
      expect(f.alive).toBe(true);
      cx.st.active = pc.idx;
      pc.turns++;
      boundary(cx, 'start', pc, -1);
      expect(f.alive).toBe(!endsAtStart);
      boundary(cx, 'end', pc, -1);
      expect(f.alive).toBe(false);
      expect(cx.st.flagsUsed[flagIndex('timedDurationExpiryPoint')]).toBe(1);
    }
  });
});

describe('the end cascade', () => {
  it('ending a parent ends its children in creation order, and conditions tied to them', () => {
    const sink = new ArraySink();
    const { cx, u, fx, s } = scene([effect('root'), effect('child-a'), effect('child-b'), effect('grand')], {}, sink);
    const pc = u('pc');
    const g = u('g');
    const root = fx(0, pc, null, { k: 'never' });
    const a = fx(1, pc, g, { k: 'never' }, root.id);
    const grand = fx(3, pc, g, { k: 'never' }, a.id);
    const b = fx(2, pc, g, { k: 'never' }, root.id);
    addCond(g, COND.prone, 'test:fx/child-b', pc.idx, -1, { k: 'effect', effect: b.id });
    endFx(cx, root.id, 'concentration', -1);
    expect([root, a, grand, b].map((f) => f.alive)).toEqual([false, false, false, false]);
    expect(has(g, COND.prone)).toBe(false);
    const ends: string[] = [];
    for (const e of sink.events) {
      if (e.k === 'fxEnd') ends.push(`${e.name}:${e.why}`);
      else if (e.k === 'cond' && !e.on) ends.push(`cond:${e.cond}`);
    }
    expect(ends).toEqual([
      'root:concentration', 'child-a:parent', 'grand:parent', 'child-b:parent', 'cond:core:prone',
    ]);
    expect(g.borne).toEqual([]);
    expect(cx.st.liveFx).toBe(0);
    expect(renderLog(sink.events, s).join('\n')).toMatch(/child-a on g ends \(its source ended\)/);
  });
});

describe('death and dead anchors', () => {
  const conc = effect('beam', { conc: true });
  it('a creature\'s own concentration ends at death; effects it bears keep running (p.179, p.180)', () => {
    const { cx, u, fx } = scene([conc, adv('lit')]);
    const pc = u('pc');
    const c = fx(0, pc, null, { k: 'never' });
    pc.conc = c.id;
    const borne = fx(1, pc, pc, { k: 'never' }); // pc bears its own rider here
    kill(cx, pc, 'zeroHp', -1);
    expect(c.alive).toBe(false);
    expect(pc.conc).toBe(-1);
    expect(borne.alive).toBe(true);
  });

  it('keepInitiativeSlot: an effect anchored to a dead creature\'s next turn ends when its slot comes up (a ghost turn)', () => {
    const { cx, u, fx, turn } = scene([adv('lit')]);
    const pc = u('pc');
    const g = u('g');
    turn(pc);
    let f!: Fx;
    turn(g, () => {
      f = fx(0, pc, g, { k: 'turnEnd', unit: pc.idx, after: pc.turns });
      kill(cx, pc, 'zeroHp', -1);
    });
    expect(f.alive).toBe(true);
    expect(cx.st.flagsUsed[flagIndex('deadAnchorTurnBoundary')]).toBe(1);
    ghostTurn(cx, pc);
    expect(f.alive).toBe(false);
  });

  it('fireOnDeath: it ends the moment its anchor dies', () => {
    const { cx, u, fx, turn } = scene([adv('lit')], { deadAnchorTurnBoundary: 'fireOnDeath' });
    const pc = u('pc');
    const g = u('g');
    let f!: Fx;
    turn(g, () => {
      f = fx(0, pc, g, { k: 'turnEnd', unit: pc.idx, after: pc.turns });
      kill(cx, pc, 'zeroHp', -1);
    });
    expect(f.alive).toBe(false);
  });

  it('a Disengage ending at the end of the dying creature\'s own turn is not a pending anchor (no flag read)', () => {
    const { cx, u, turn } = scene([]);
    const pc = u('pc');
    turn(pc, () => {
      addCond(pc, COND.disengaged, 'core:disengage', pc.idx, -1, { k: 'turnEnd', unit: pc.idx, after: pc.turns - 1 });
      kill(cx, pc, 'zeroHp', -1);
    });
    expect(cx.st.flagsUsed[flagIndex('deadAnchorTurnBoundary')]).toBe(0);
  });
});

describe('once per turn and same-spell potency', () => {
  it('the ledger is keyed by turn, not round', () => {
    const { cx, u, fx } = scene([effect('beam', { limit: 'perCreature' })]);
    const f = fx(0, u('pc'), null, { k: 'never' });
    const g = u('g').idx;
    cx.st.turnIdx = 3;
    expect(ledgerOk(cx.st, f, g)).toBe(true);
    ledgerMark(cx.st, f, g);
    expect(ledgerOk(cx.st, f, g)).toBe(false);
    cx.st.turnIdx = 4; // the next creature's turn, same round
    expect(ledgerOk(cx.st, f, g)).toBe(true);
  });

  it('of two copies of one spell on a creature only the more potent folds; features never compete (p.106)', () => {
    const { cx, u, fx } = scene([adv('bolt', { sid: 7, lvl: 1, id: 'test:fx/bolt-1' }), adv('bolt', { sid: 7, lvl: 2, id: 'test:fx/bolt-2' }), adv('feat-a'), adv('feat-b')]);
    const pc = u('pc');
    const g = u('g');
    fx(1, pc, g, { k: 'never' });
    fx(0, pc, g, { k: 'never' });
    fx(2, pc, g, { k: 'never' });
    fx(3, pc, g, { k: 'never' });
    const a: string[] = [];
    const d: string[] = [];
    foldMods(cx.st, u('ally'), g, attackKey('melee', false), a, d, newModFold());
    expect(a).toEqual(['test:fx/bolt-2', 'test:fx/feat-a', 'test:fx/feat-b']);
  });

  it('of two copies of one spell\'s AC stat on a creature only the more potent counts; when it ends the other applies (p.106)', () => {
    const ward = (lvl: number, n: number) => effect('ward', { sid: 7, lvl, id: `test:fx/ward-${lvl}`, stats: [{ k: 'ac', n }] });
    const { cx, u, fx } = scene([ward(1, 2), ward(2, 3)]);
    const g = u('g');
    const base = acNow(g, cx.st);
    fx(0, u('pc'), g, { k: 'never' });
    const strong = fx(1, u('pc'), g, { k: 'never' }); // a second casting at a higher level (the scene's effects all live on pc's template)
    expect(acNow(g, cx.st)).toBe(base + 3); // not base + 5
    endFx(cx, strong.id, 'parent', -1);
    expect(acNow(g, cx.st)).toBe(base + 2);
  });

  it('two different effects from one casting both apply: potency compares copies of the same effect', () => {
    const shaken = effect('shaken', { sid: 7, mods: [mod('flat', 'd20.save', { value: -2 })] });
    const { cx, u, fx } = scene([adv('exposed', { sid: 7 }), shaken]);
    const g = u('g');
    fx(0, u('pc'), g, { k: 'never' });
    fx(1, u('pc'), g, { k: 'never' });
    const a: string[] = [];
    foldMods(cx.st, u('ally'), g, attackKey('melee', false), a, [], newModFold());
    expect(a).toEqual(['test:fx/exposed']);
    const f = newModFold();
    foldMods(cx.st, g, null, saveKey(1), [], [], f);
    expect(f.flat).toBe(-2);
  });

  it('two copies of one rider with a turn-start hook: only the more potent fires', () => {
    const burn = (lvl: number) => effect('burn', { sid: 7, lvl, id: `test:fx/burn-${lvl}`, hooks: [{ on: HOOK.turnStart, steps: [S.damage(String(lvl), 'fire')] }], hookMask: HOOK.turnStart });
    const sink = new ArraySink();
    const { cx, u, fx } = scene([burn(1), burn(2)], {}, sink);
    const g = u('g');
    fx(1, u('pc'), g, { k: 'never' });
    fx(0, u('pc'), g, { k: 'never' });
    queueTrigger(cx, TRIG.turnStart, g.idx, -1, -1, 0, -1);
    drain(cx);
    expect(ofKind(sink.events, 'damage').map((e) => [e.via, e.dealt])).toEqual([['test:fx/burn-2', 2]]);
  });
});

describe('roll modifiers and one-use riders', () => {
  it('a d20 floor, a flat bonus and a d4 fold into the right rolls only', () => {
    const steady = effect('steady', { mods: [mod('floor', 'd20.save.con.concentration', { value: 10 }), mod('flat', 'd20.check.wis', { value: 2 })] });
    const { cx, u, fx } = scene([steady]);
    const pc = u('pc');
    fx(0, pc, pc, { k: 'never' });
    const f = newModFold();
    foldMods(cx.st, pc, null, saveKey(2, true), [], [], f); // CON save to keep concentration
    expect(f.floor).toBe(10);
    const g = newModFold();
    foldMods(cx.st, pc, null, saveKey(2), [], [], g); // any other CON save
    expect(g.floor).toBe(0);
    expect([f.flat, g.flat]).toEqual([0, 0]); // the flat bonus is for WIS checks only
    const h = newModFold();
    foldMods(cx.st, pc, null, checkKey(4, skill('perception')), [], [], h);
    expect([h.flat, h.floor]).toEqual([2, 0]);
  });

  it('a chosen-skill d4 (Guidance-style) folds into checks with that skill only', () => {
    const guided = effect('guided', { mods: [mod('preDice', 'd20.check', { dice: parseExpr('1d4'), skillParam: true })] });
    const { cx, u } = scene([guided]);
    const pc = u('pc');
    newFx(cx, { tpl: 0, owner: pc.idx, bearer: pc.idx, parent: -1, param: skill('perception'), srcItem: -1, until: { k: 'never' }, cause: -1 });
    const pre = (key: number) => {
      const f = newModFold();
      foldMods(cx.st, pc, null, key, [], [], f);
      return f.pre.length;
    };
    expect(pre(checkKey(4, skill('perception')))).toBe(1);
    expect(pre(checkKey(4, skill('insight')))).toBe(0); // another WIS skill
    expect(pre(checkKey(4))).toBe(0); // a plain WIS check
    expect(pre(saveKey(4))).toBe(0);
  });

  it('the next attack roll against the bearer, by anyone, spends the rider (hit or miss)', () => {
    const { cx, u, fx } = scene([adv('lit')]);
    const g = u('g');
    const f = fx(0, u('pc'), g, { k: 'never' });
    resolveAttack(cx, u('ally'), 0, g, false, -1);
    expect(f.alive).toBe(false);
  });

  it('a redundant rider (the roll already had Advantage) is spent by default, kept under notConsumed', () => {
    for (const [flag, alive] of [['consumed', false], ['notConsumed', true]] as const) {
      const { cx, u, fx } = scene([adv('lit')], { nextRollRiderConsumedWhenRedundant: flag });
      const g = u('g');
      addCond(g, COND.prone, 'core:prone', -1, -1, { k: 'never' }); // ally at C1 is within 5 ft: Advantage already
      const f = fx(0, u('pc'), g, { k: 'never' });
      resolveAttack(cx, u('ally'), 0, g, false, -1);
      expect(f.alive).toBe(alive);
    }
  });
});

describe('concentration (p.179)', () => {
  const conc = effect('beam', { conc: true });
  function concScene(over: Parameters<typeof template>[0] | null = null, flags: Partial<RuleFlags> = {}) {
    const sink = new ArraySink();
    const tpl = over ? withEffects(template(over), [conc]) : withEffects(FIGHTER, [conc]);
    const s = setup({ w: 4, h: 1, flags, units: [{ seat: 'pc', team: 0, tpl: { ...tpl, kind: 'pc' }, at: 'A1', hp: 200 }, { seat: 'g', team: 1, tpl: DUMMY, at: 'B1' }] });
    const cx = createContext(s, 3, 0, makeDeciders(s), sink, { audit: true });
    const pc = cx.st.units.find((x) => x.seat === 'pc')!;
    const c = newFx(cx, { tpl: 0, owner: pc.idx, bearer: -1, parent: -1, param: -1, srcItem: -1, until: { k: 'never' }, cause: -1 });
    pc.conc = c.id;
    const hit = (parts: ReturnType<typeof dmg>[]) => dealDamage(cx, { unit: 1, via: 'test:hit', slot: 0, cause: -1 }, parts, Int32Array.from(parts.map((p) => (p.roll as { v: number }).v)), () => true, false, [pc.idx]);
    const saves = () => ofKind(sink.events, 'save');
    return { cx, pc, c, hit, saves };
  }

  it('DC is max(10, half the damage), capped at 30', () => {
    for (const [amount, dc] of [[23, 11], [70, 30], [8, 10]] as const) {
      const { hit, saves } = concScene();
      hit([dmg(amount, 'slashing')]);
      expect(saves().map((e) => e.dc)).toEqual([dc]);
    }
  });

  it('damage soaked by temp HP still forces the save at full DC; Immune damage forces none', () => {
    const a = concScene();
    a.pc.tempHp = 50;
    a.hit([dmg(30, 'slashing')]);
    expect(a.saves().map((e) => e.dc)).toEqual([15]);
    const b = concScene({ id: 'immune-pc', kind: 'pc', hp: 200, attacks: [], immune: ['poison'] });
    b.hit([dmg(30, 'poison')]);
    expect(b.saves()).toEqual([]);
  });

  it('Resistance to 0: no save by default, a DC 10 save under concentrationSaveOnZeroDamage=save', () => {
    for (const [flag, n] of [['noSave', 0], ['save', 1]] as const) {
      const { hit, saves } = concScene({ id: 'resist-pc', kind: 'pc', hp: 200, attacks: [], resist: ['fire'] }, { concentrationSaveOnZeroDamage: flag });
      hit([dmg(1, 'fire')]);
      expect(saves()).toHaveLength(n);
    }
  });

  it('two damage types: one save on the total, or one per type', () => {
    const a = concScene();
    a.hit([dmg(10, 'fire'), dmg(30, 'cold')]);
    expect(a.saves().map((e) => e.dc)).toEqual([20]);
    const b = concScene(null, { concentrationSaveGrouping: 'perDamageType' });
    b.hit([dmg(10, 'fire'), dmg(30, 'cold')]);
    expect(b.saves().map((e) => e.dc)).toEqual([15, 10]);
  });

  it('dropping to 0 HP ends it with no save, and the queued save does nothing', () => {
    const { cx, pc, c, hit, saves } = concScene();
    pc.hp = 5;
    hit([dmg(9, 'slashing')]);
    expect(c.alive).toBe(false);
    expect(saves()).toEqual([]);
    expect(cx.st.fx[c.id]!.alive).toBe(false);
  });

  it('a failed save ends it; a made one keeps it', () => {
    const fail = concScene();
    fail.hit([dmg(60, 'slashing')]); // DC 30: a +0 CON save can't make it
    expect(fail.saves()[0]!.ok).toBe(false);
    expect([fail.c.alive, fail.pc.conc]).toEqual([false, -1]);
    const steady = effect('steady', { mods: [mod('floor', 'd20.save.con.concentration', { value: 10 })] });
    const s = setup({ w: 4, h: 1, units: [{ seat: 'pc', team: 0, tpl: withEffects(FIGHTER, [conc, steady]), at: 'A1', hp: 200 }, { seat: 'g', team: 1, tpl: DUMMY, at: 'B1' }] });
    const sink = new ArraySink();
    const cx = createContext(s, 3, 0, makeDeciders(s), sink, { audit: true });
    const pc = cx.st.units.find((x) => x.seat === 'pc')!;
    const c = newFx(cx, { tpl: 0, owner: pc.idx, bearer: -1, parent: -1, param: -1, srcItem: -1, until: { k: 'never' }, cause: -1 });
    pc.conc = c.id;
    newFx(cx, { tpl: 1, owner: pc.idx, bearer: pc.idx, parent: -1, param: -1, srcItem: -1, until: { k: 'never' }, cause: -1 });
    dealDamage(cx, { unit: 1, via: 'test:hit', slot: 0, cause: -1 }, [dmg(10, 'slashing')], Int32Array.from([10]), () => true, false, [pc.idx]);
    const save = ofKind(sink.events, 'save')[0]!; // DC 10 with a floor of 10 always holds
    expect([save.face >= 10, save.ok, c.alive]).toEqual([true, true, true]);
  });

  it('Incapacitated ends concentration and effects that end on it, and nothing else', () => {
    const { cx, u, fx } = scene([conc, effect('form', { endsOn: END.incap }), effect('other')]);
    const pc = u('pc');
    const c = fx(0, pc, null, { k: 'never' });
    pc.conc = c.id;
    const form = fx(1, pc, pc, { k: 'never' });
    const other = fx(2, pc, pc, { k: 'never' });
    onIncapacitated(cx, pc, -1);
    expect([c.alive, form.alive, other.alive]).toEqual([false, false, true]);
  });
});

