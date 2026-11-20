// Attack rolls, damage, 0 HP and death saves: SRD 5.2.1 p.6-7, p.15-18 and the conditions.
import { describe, expect, it } from 'vitest';
import { parseExpr } from '../src/dice/expr.ts';
import { DAMAGE_TYPES, type CompiledDamage } from '../src/content/types.ts';
import { makeDeciders } from '../src/decide/make.ts';
import { ArraySink } from '../src/log/events.ts';
import { rollOdds, sampleRoll } from '../src/rolls/rollspec.ts';
import { openStream } from '../src/rng/stream.ts';
import { buildAttackSpec, rollDamage } from '../src/sim/attack.ts';
import { dealDamage, deathSave, knockOut } from '../src/sim/damage.ts';
import { createContext } from '../src/sim/fight.ts';
import { COND, has } from '../src/sim/state.ts';
import { ARCHER, DUMMY, FIGHTER, SENTRY, SKIRMISHER, WARDED, setup, template } from './helpers/build.ts';
import { d20At, findSeed, ofKind, run } from './helpers/run.ts';

const part = (roll: string, type: string, ifAdvantage = false): CompiledDamage => {
  const node = parseExpr(roll);
  return { roll: node, critExtra: null, type: DAMAGE_TYPES.indexOf(type as never), avg: 0, ifAdvantage };
};

/** A context for poking at one fight's pieces directly. */
function ctx(units: Parameters<typeof setup>[0]['units'], flags = {}, seed = 1, w = 8, h = 4) {
  const s = setup({ w, h, units, flags });
  const sink = new ArraySink();
  const cx = createContext(s, seed, 0, makeDeciders(s), sink, { audit: true });
  const u = (seat: string) => cx.st.units.find((x) => x.seat === seat)!;
  return { s, cx, sink, u };
}

describe('attack roll modifiers (built from position, listed by source)', () => {
  it('a ranged attack has Disadvantage with an able enemy within 5 ft, not with an Incapacitated one', () => {
    const { cx, u } = ctx([{ seat: 'arc', team: 0, tpl: ARCHER, at: 'B2' }, { seat: 'g1', team: 1, tpl: SKIRMISHER, at: 'C2' }, { seat: 'g2', team: 1, tpl: SKIRMISHER, at: 'H2' }]);
    const adv: string[] = [];
    const dis: string[] = [];
    expect(buildAttackSpec(cx.st, u('arc'), 0, u('g2'), u('arc').cell, adv, dis).adv).toBe('dis');
    expect(dis).toEqual(['core:ranged-adjacent']);
    knockOut(cx, u('g1'), -1);
    expect(buildAttackSpec(cx.st, u('arc'), 0, u('g2'), u('arc').cell, adv, dis).adv).toBe('none');
  });

  it('beyond normal range is Disadvantage; a hypothetical position changes the answer', () => {
    const { cx, u } = ctx([{ seat: 'g1', team: 1, tpl: SKIRMISHER, at: 'A1' }, { seat: 'pc', team: 0, tpl: FIGHTER, at: 'A1' }], {}, 1, 52, 64);
    const g = u('g1');
    const adv: string[] = [];
    const dis: string[] = [];
    u('pc').cell = 63 * 52; // A64: 315 ft away, beyond the bow's 80
    expect(buildAttackSpec(cx.st, g, 1, u('pc'), g.cell, adv, dis).adv).toBe('dis');
    expect(dis).toContain('core:long-range');
    expect(buildAttackSpec(cx.st, g, 1, u('pc'), 50 * 52, adv, dis).adv).toBe('none'); // from A51: 65 ft
  });

  it('Prone target: Advantage within 5 ft, Disadvantage beyond; a Prone attacker has Disadvantage', () => {
    const { cx, u } = ctx([{ seat: 'g1', team: 1, tpl: SKIRMISHER, at: 'B2' }, { seat: 'pc', team: 0, tpl: FIGHTER, at: 'C2', prone: true }]);
    const adv: string[] = [];
    const dis: string[] = [];
    expect(buildAttackSpec(cx.st, u('g1'), 0, u('pc'), u('g1').cell, adv, dis).adv).toBe('adv');
    expect(buildAttackSpec(cx.st, u('g1'), 1, u('pc'), u('g1').cell - 1, adv, dis).adv).toBe('dis'); // bow from A2, 10 ft from the Prone target
    expect(dis).toContain('core:target-prone');
    expect(buildAttackSpec(cx.st, u('pc'), 0, u('g1'), u('pc').cell, adv, dis).adv).toBe('dis');
    expect(dis).toEqual(['core:attacker-prone']);
  });

  it('Unconscious target: Advantage and an automatic crit on a hit within 5 ft; a straight roll from farther', () => {
    const { cx, u } = ctx([{ seat: 'g1', team: 1, tpl: SKIRMISHER, at: 'B2' }, { seat: 'pc', team: 0, tpl: FIGHTER, at: 'C2' }]);
    knockOut(cx, u('pc'), -1);
    const adv: string[] = [];
    const dis: string[] = [];
    const near = buildAttackSpec(cx.st, u('g1'), 0, u('pc'), u('g1').cell, adv, dis);
    expect(near.adv).toBe('adv');
    expect(near.autoCritOnHit).toBe(true);
    const o = rollOdds(near);
    expect(o.pCrit).toBeCloseTo(o.pSuccess, 12);
    const far = buildAttackSpec(cx.st, u('g1'), 1, u('pc'), u('g1').cell - 1, adv, dis);
    expect(far.adv).toBe('none');
    expect(far.autoCritOnHit).toBe(false);
  });

  it('autoCritOnHit: sampled agrees with exact', () => {
    const spec = { kind: 'attack' as const, adv: 'adv' as const, flat: 4, preDice: [], dc: 14, autoCritOnHit: true };
    const exact = rollOdds(spec);
    let crits = 0;
    const N = 40000;
    for (let i = 0; i < N; i++) if (sampleRoll(spec, openStream(9, i, 0, 'attack', 0)).crit) crits++;
    const sd = Math.sqrt((exact.pCrit * (1 - exact.pCrit)) / N);
    expect(Math.abs(crits / N - exact.pCrit)).toBeLessThan(4 * sd);
  });
});

describe('damage dice', () => {
  it('a crit rolls every base die first, then the crit extras, so base dice never move', () => {
    const parts = [part('1d6+2', 'slashing'), part('1d8', 'fire')].map((p) => ({ ...p, critExtra: { k: 'dice' as const, n: p.roll.k === 'add' ? 1 : 1, sides: p.roll.k === 'add' ? 6 : 8 } }));
    const plain = new Int32Array(4);
    const crit = new Int32Array(4);
    rollDamage(parts, false, false, openStream(3, 0, 1, 'damage', 1, 5), plain);
    rollDamage(parts, true, false, openStream(3, 0, 1, 'damage', 1, 5), crit);
    expect(crit[0]! - plain[0]!).toBeGreaterThanOrEqual(1);
    expect(crit[0]! - plain[0]!).toBeLessThanOrEqual(6);
    expect(crit[1]! - plain[1]!).toBeGreaterThanOrEqual(1);
    expect(crit[1]! - plain[1]!).toBeLessThanOrEqual(8);
  });

  it('an "if the roll had Advantage" rider only applies with Advantage', () => {
    const parts = [part('3', 'slashing'), part('4', 'slashing', true)];
    const r = new Int32Array(4);
    rollDamage(parts, false, false, openStream(1, 0, 1, 'damage', 1, 0), r);
    expect([r[0], r[1]]).toEqual([3, 0]);
    rollDamage(parts, false, true, openStream(1, 0, 1, 'damage', 1, 0), r);
    expect([r[0], r[1]]).toEqual([3, 4]);
  });
});

describe('damage and hit points (p.16-17)', () => {
  const deal = (c: ReturnType<typeof ctx>, seat: string, parts: CompiledDamage[], crit = false) => {
    const rolled = new Int32Array(parts.map((p) => (p.roll.k === 'const' ? p.roll.v : 0)));
    dealDamage(c.cx, { unit: 0, via: 'core:test', slot: 0, cause: -1 }, parts, rolled, () => true, crit, [c.u(seat).idx]);
  };

  it('Resistance halves the per-type total (rounding down once), Vulnerability doubles, Immunity zeroes', () => {
    const c = ctx([{ seat: 'w', team: 1, tpl: WARDED, at: 'A1' }, { seat: 'pc', team: 0, tpl: FIGHTER, at: 'H4' }]);
    deal(c, 'w', [part('3', 'fire'), part('4', 'fire')]); // 7 fire -> 3, not 1 + 2
    expect(c.u('w').hp).toBe(97);
    deal(c, 'w', [part('5', 'cold'), part('9', 'poison')]); // 10 cold, 0 poison
    expect(c.u('w').hp).toBe(87);
  });

  it('temporary HP absorb damage first and are spent', () => {
    const c = ctx([{ seat: 'w', team: 1, tpl: DUMMY, at: 'A1' }, { seat: 'pc', team: 0, tpl: FIGHTER, at: 'H4' }]);
    c.u('w').tempHp = 5;
    deal(c, 'w', [part('7', 'slashing')]);
    expect([c.u('w').tempHp, c.u('w').hp]).toEqual([0, 498]);
  });

  it('a monster dies at 0 HP and its square opens up', () => {
    const c = ctx([{ seat: 'g', team: 1, tpl: SKIRMISHER, at: 'A1' }, { seat: 'pc', team: 0, tpl: FIGHTER, at: 'H4' }]);
    deal(c, 'g', [part('10', 'slashing')]);
    expect(c.u('g').life).toBe('dead');
    expect(c.cx.st.corpses[c.u('g').cell]).toBe(1);
  });

  it('statBlockAtZeroHp=deathSaves: the monster falls Unconscious instead', () => {
    const c = ctx([{ seat: 'g', team: 1, tpl: SKIRMISHER, at: 'A1' }, { seat: 'pc', team: 0, tpl: FIGHTER, at: 'H4' }], { statBlockAtZeroHp: 'deathSaves' });
    deal(c, 'g', [part('10', 'slashing')]);
    expect(c.u('g').life).toBe('down');
    expect(c.cx.st.flagsUsed.some((x) => x === 1)).toBe(true);
  });

  it('a PC at 0 HP falls Unconscious, Incapacitated and Prone', () => {
    const c = ctx([{ seat: 'pc', team: 0, tpl: FIGHTER, at: 'A1' }, { seat: 'g', team: 1, tpl: SKIRMISHER, at: 'H4' }]);
    deal(c, 'pc', [part('44', 'slashing')]);
    const pc = c.u('pc');
    expect(pc.life).toBe('down');
    expect([has(pc, COND.unconscious), has(pc, COND.incapacitated), has(pc, COND.prone)]).toEqual([true, true, true]);
  });

  it('massive damage: leftover damage at least the HP max kills outright', () => {
    const c = ctx([{ seat: 'pc', team: 0, tpl: FIGHTER, at: 'A1', hp: 6 }, { seat: 'g', team: 1, tpl: SKIRMISHER, at: 'H4' }]);
    deal(c, 'pc', [part('49', 'slashing')]); // 6 to 0, 43 left < 44: down
    expect(c.u('pc').life).toBe('down');
    const d = ctx([{ seat: 'pc', team: 0, tpl: FIGHTER, at: 'A1', hp: 6 }, { seat: 'g', team: 1, tpl: SKIRMISHER, at: 'H4' }]);
    deal(d, 'pc', [part('50', 'slashing')]); // 44 left: dead
    expect(d.u('pc').life).toBe('dead');
  });

  it('damage at 0 HP is one death save failure, a crit two; enough damage kills', () => {
    const c = ctx([{ seat: 'pc', team: 0, tpl: FIGHTER, at: 'A1' }, { seat: 'g', team: 1, tpl: SKIRMISHER, at: 'H4' }]);
    deal(c, 'pc', [part('44', 'slashing')]);
    deal(c, 'pc', [part('1', 'slashing')]);
    expect(c.u('pc').deathFail).toBe(1);
    deal(c, 'pc', [part('1', 'slashing')], true);
    expect(c.u('pc').life).toBe('dead');
  });

  it('a Stable creature that takes damage is dying again with one failure', () => {
    const c = ctx([{ seat: 'pc', team: 0, tpl: FIGHTER, at: 'A1' }, { seat: 'g', team: 1, tpl: SKIRMISHER, at: 'H4' }]);
    deal(c, 'pc', [part('44', 'slashing')]);
    c.u('pc').life = 'stable';
    deal(c, 'pc', [part('1', 'slashing')]);
    expect([c.u('pc').life, c.u('pc').deathFail]).toEqual(['down', 1]);
  });

  it('tempHpSoakAtZeroIsDamage: temp HP soaking a hit at 0 HP still costs a failure (default), or not', () => {
    for (const [flag, fails] of [[true, 1], [false, 0]] as const) {
      const c = ctx([{ seat: 'pc', team: 0, tpl: FIGHTER, at: 'A1' }, { seat: 'g', team: 1, tpl: SKIRMISHER, at: 'H4' }], { tempHpSoakAtZeroIsDamage: flag });
      deal(c, 'pc', [part('44', 'slashing')]);
      c.u('pc').tempHp = 10;
      deal(c, 'pc', [part('3', 'slashing')]);
      expect(c.u('pc').deathFail).toBe(fails);
    }
  });
});

describe('death saves (p.17)', () => {
  const downed = (seed: number) => {
    const c = ctx([{ seat: 'pc', team: 0, tpl: FIGHTER, at: 'A1' }, { seat: 'g', team: 1, tpl: SKIRMISHER, at: 'H4' }], {}, seed);
    knockOut(c.cx, c.u('pc'), -1);
    return c;
  };
  const natural = (seed: number, c = downed(seed)) => d20At(seed, c.u('pc').seatKey, 'death', 0, 0);

  it('a natural 20 regains 1 HP: Unconscious and Incapacitated end, Prone stays', () => {
    const seed = findSeed((s) => natural(s) === 20);
    const c = downed(seed);
    expect(deathSave(c.cx, c.u('pc'), -1)).toBe(true);
    const pc = c.u('pc');
    expect([pc.life, pc.hp, has(pc, COND.unconscious), has(pc, COND.incapacitated), has(pc, COND.prone)]).toEqual(['up', 1, false, false, true]);
  });

  it('a natural 1 is two failures', () => {
    const seed = findSeed((s) => natural(s) === 1);
    const c = downed(seed);
    deathSave(c.cx, c.u('pc'), -1);
    expect(c.u('pc').deathFail).toBe(2);
  });

  it('three successes make you Stable and reset both counts; three failures kill', () => {
    const seed = findSeed((s) => natural(s) >= 10 && natural(s) < 20);
    const c = downed(seed);
    c.u('pc').deathOk = 2;
    c.u('pc').deathFail = 2;
    deathSave(c.cx, c.u('pc'), -1);
    expect([c.u('pc').life, c.u('pc').deathOk, c.u('pc').deathFail]).toEqual(['stable', 0, 0]);
    const bad = findSeed((s) => natural(s) > 1 && natural(s) < 10);
    const d = downed(bad);
    d.u('pc').deathFail = 2;
    deathSave(d.cx, d.u('pc'), -1);
    expect(d.u('pc').life).toBe('dead');
  });

  it('death saves ignore natOnChecksAndSaves: only their own 1/20 rule applies', () => {
    const seed = findSeed((s) => natural(s) === 20);
    const c = ctx([{ seat: 'pc', team: 0, tpl: FIGHTER, at: 'A1' }, { seat: 'g', team: 1, tpl: SKIRMISHER, at: 'H4' }], { natOnChecksAndSaves: 'autoPassFail' }, seed);
    knockOut(c.cx, c.u('pc'), -1);
    expect(deathSave(c.cx, c.u('pc'), -1)).toBe(true);
    expect(c.u('pc').hp).toBe(1);
  });

  it('a dying creature still gets its turn and saves at the start of it; downEnds=false keeps the fight going', () => {
    const thug = template({ id: 'thug', ac: 12, hp: 40, attacks: [{ local: 'club', toHit: 100, damage: [['6', 'bludgeoning']] }] });
    const s = setup({
      w: 8, h: 4, flags: { initiativeMode: 'static' }, knobs: { downEnds: false },
      units: [
        { seat: 'pc', team: 0, tpl: FIGHTER, at: 'B2', hp: 1, surprised: true }, // static 11 - 5 = 6
        { seat: 'thug', team: 1, tpl: thug, at: 'C2' }, // static 10
        { seat: 'ally', team: 0, tpl: SENTRY, at: 'H4', surprised: true }, // static 6
      ],
    });
    const seed = findSeed((sd) => d20At(sd, s.seats.find((x) => x.seat === 'thug')!.seatKey, 'attack', 1, 0) !== 1);
    const r = run(s, seed);
    const pc = s.seats.findIndex((x) => x.seat === 'pc');
    const r1 = r.events.filter((e) => e.round === 1);
    expect(ofKind(r1, 'down').map((e) => e.who)).toContain(pc);
    expect(ofKind(r1, 'deathSave').map((e) => e.who)).toContain(pc);
    expect(r.result.outcome.round).toBeGreaterThan(1);
  });
});

describe('review fixes: damage dice alignment', () => {
  it("an Advantage-only rider draws its dice either way, so a later part's dice never move", () => {
    const d = (roll: string, ifAdvantage = false): CompiledDamage => {
      const node = parseExpr(roll);
      return { roll: node, critExtra: node.k === 'dice' ? node : null, type: 0, avg: 0, ifAdvantage };
    };
    const parts = [d('1d4', true), d('1d6')];
    const a = new Int32Array(4);
    const b = new Int32Array(4);
    rollDamage(parts, true, false, openStream(5, 0, 1, 'damage', 1, 3), a);
    rollDamage(parts, true, true, openStream(5, 0, 1, 'damage', 1, 3), b);
    expect(a[0]).toBe(0);
    expect(b[0]).toBeGreaterThan(0);
    expect(a[1]).toBe(b[1]);
  });
});
