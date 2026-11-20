// M1b content: the spell and feature schemas, the bound-program compiler, the character
// linter, the six SRD spells and the synthetic stand-ins, and character-file flag precedence.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkContent } from '../../../tools/check-private.ts';
import { formatExpr, type ExprNode } from '../src/dice/expr.ts';
import { shapeKey } from '../src/grid/area.ts';
import { cantripTier, mergeDice } from '../src/content/compile-spell.ts';
import { loadContent, type LoadResult } from '../src/content/load.ts';
import { RK, SKILLS, compileKeyPattern, saveKey } from '../src/content/rollkeys.ts';
import { RESERVED_HOOKS } from '../src/content/schema.ts';
import { DAMAGE_TYPES, END, HOOK, SIZES, damageBit, type BoundEffect, type CompiledTemplate, type Content, type SpellEntry, type Step } from '../src/content/types.ts';
import { formatDiag, type SourceFile } from '../src/content/yaml.ts';
import { makeDeciders } from '../src/decide/make.ts';
import { resolveScenario } from '../src/scenario/resolve.ts';
import { buildAttackSpecFor } from '../src/sim/attack.ts';
import { createContext } from '../src/sim/fight.ts';
import { parseExpr } from '../src/dice/expr.ts';
import { FLAG_INFO, FLAG_KEYS, type FlagInfo } from '../src/rules/flags.ts';
import { fnv1a32 } from '../src/util/hash.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');

/** A flag value the engine doesn't implement yet, found at run time so these tests outlive any one flag landing. */
const UNIMPL: { key: string; value: string } | null = (() => {
  for (const k of FLAG_KEYS) {
    const info: FlagInfo<unknown> = FLAG_INFO[k];
    const v = info.unimplemented?.[0];
    if (v !== undefined) return { key: k, value: String(v) };
  }
  return null;
})();

function walk(d: string): string[] {
  return readdirSync(d)
    .flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.yaml') ? [p] : [];
    })
    .sort();
}
const readPack = (name: string): SourceFile[] => walk(join(ROOT, 'packs', name)).map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, 'utf8') }));
const repoFiles = (): SourceFile[] => [...readPack('srd-5.2.1'), ...readPack('test')];

const repo = loadContent(repoFiles());
const content = (): Content => {
  if (!repo.content) throw new Error(repo.errors.map(formatDiag).join('\n'));
  return repo.content;
};
const tpl = (id: string): CompiledTemplate => {
  const t = content().get(id);
  if (!t) throw new Error(`missing ${id}`);
  return t;
};
const druid = () => tpl('test:sample-druid');
const entry = (t: CompiledTemplate, spell: string, source?: string): SpellEntry => {
  const e = t.spells.find((x) => x.spell.id === spell && (source === undefined || x.source === source));
  if (!e) throw new Error(`no entry ${spell}`);
  return e;
};
const fx = (t: CompiledTemplate, i: number): BoundEffect => {
  const e = t.effects[i];
  if (!e) throw new Error(`no effect ${i}`);
  return e;
};
const ex = (n: ExprNode | null): string | null => (n === null ? null : formatExpr(n));
const kind = <K extends Step['k']>(s: Step | undefined, k: K): Extract<Step, { k: K }> => {
  if (!s || s.k !== k) throw new Error(`expected a ${k} step, got ${s?.k}`);
  return s as Extract<Step, { k: K }>;
};
const type = (t: string) => DAMAGE_TYPES.indexOf(t as (typeof DAMAGE_TYPES)[number]);

// Built at runtime so tools/check-private.ts never sees the literal marker in this file.
const PRIV = 'priv' + 'ate';

const TEST_MANIFEST = "kind: manifest\npack: fx\nversion: '1'\nrules: '2024'\nnamespace: test\nlicense: test\n";
const load = (files: Record<string, string>, withRepo = true): LoadResult =>
  loadContent([...(withRepo ? repoFiles() : []), ...Object.entries(files).map(([path, text]) => ({ path, text }))]);
const errs = (r: LoadResult) => r.errors.map(formatDiag);
const warns = (r: LoadResult) => r.warnings.map(formatDiag);

const spellFile = (id: string, body: string, head = 'level: 1\ncastingTime: action\nrange: 60\ncomponents: { v: true, s: true }\nduration: instant\n') =>
  `kind: spell\nid: ${id}\nname: Fixture Spell\nsource: synthetic test fixture\n${head}${body}`;

const pcFile = (id: string, extra = '') => `kind: pc
id: ${id}
name: Fixture Caster
source: synthetic test fixture
rules: '2024'
level: 6
size: medium
speed: 30
abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 16, cha: 10 }
hpMax: 30
ac: 12
${extra}`;

describe('the SRD 5.2.1 spells and the test stand-ins', () => {
  it('load with zero errors and zero warnings', () => {
    expect(errs(repo)).toEqual([]);
    expect(warns(repo)).toEqual([]);
  });

  it('every spell file cites its SRD page', () => {
    const pages: Record<string, string> = {
      moonbeam: 'p.150-151',
      'spike-growth': 'p.164',
      'healing-word': 'p.139',
      'produce-flame': 'p.156',
      guidance: 'p.138',
      'guiding-bolt': 'p.138',
    };
    for (const [name, page] of Object.entries(pages)) {
      const text = readFileSync(join(ROOT, 'packs/srd-5.2.1/spells', `${name}.yaml`), 'utf8');
      expect(text).toContain(`source: SRD 5.2.1 ${page}`);
      expect(entryById(`srd:${name}`).source).toBe(`SRD 5.2.1 ${page}`);
    }
  });

  it('a spell\'s sid is a hash of its id, so what else is loaded never changes it', () => {
    const ids = ['srd:guidance', 'srd:guiding-bolt', 'srd:healing-word', 'srd:moonbeam', 'srd:produce-flame', 'srd:spike-growth', 'test:conc-ward', 'test:tether'];
    const lists = `cantrips: ['srd:guidance', 'srd:produce-flame', 'test:tether']\n    prepared: ['srd:guiding-bolt', 'srd:healing-word', 'srd:moonbeam', 'srd:spike-growth', 'test:conc-ward']`;
    const r = load({ 'fx/manifest.yaml': TEST_MANIFEST, 'fx/pc.yaml': pcFile('test:all', `slots: [1, 1]\ncasting:\n  - source: x\n    ability: wis\n    list: druid\n    ${lists}\n`) });
    expect(errs(r)).toEqual([]);
    const t = r.content!.get('test:all')!;
    const sids = ids.map((id) => entry(t, id).spell.sid);
    expect(sids).toEqual(ids.map((id) => fnv1a32(id) >>> 1));
    expect(new Set(sids).size).toBe(ids.length);
    const alone = load({ 'fx/manifest.yaml': TEST_MANIFEST, 'fx/pc.yaml': pcFile('test:one', `slots: [1, 1]\ncasting:\n  - source: x\n    ability: wis\n    list: druid\n    prepared: ['srd:moonbeam']\n`) });
    expect(entry(alone.content!.get('test:one')!, 'srd:moonbeam').spell.sid).toBe(sids[3]);
  });

  it('spell facts: level, casting time, range, components, concentration, area, recast, in-hand', () => {
    const f = (id: string) => {
      const s = entryById(id);
      return [s.level, s.cast, s.rangeFt, `${s.v ? 'V' : ''}${s.s ? 'S' : ''}${s.m === 'focus' ? 'M' : ''}`, s.conc, s.areaShape, s.recast, s.createsInHand, s.fidelity];
    };
    expect(f('srd:moonbeam')).toEqual([2, 'action', 120, 'VSM', true, shapeKey('cylinder', 5), 'stack', false, 'partial']);
    expect(f('srd:spike-growth')).toEqual([2, 'action', 150, 'VSM', true, shapeKey('sphere', 20), 'stack', false, 'full']); // full since coverage step 9 (camouflage and Search)
    expect(f('srd:healing-word')).toEqual([1, 'bonus', 60, 'V', false, -1, 'stack', false, 'full']);
    expect(f('srd:produce-flame')).toEqual([0, 'bonus', 0, 'VS', false, -1, 'replace', true, 'partial']);
    expect(f('srd:guidance')).toEqual([0, 'action', 5, 'VS', true, -1, 'stack', false, 'full']);
    expect(f('srd:guiding-bolt')).toEqual([1, 'action', 120, 'VS', false, -1, 'stack', false, 'full']);
    expect(f('test:tether')).toEqual([0, 'action', 30, 'VSM', false, -1, 'stack', false, 'full']);
    expect(entryById('srd:moonbeam').unimplemented).toEqual(['Dim Light in the Cylinder', 'a failed save reverts a shape-shifted creature']);
    expect(entryById('srd:spike-growth').unimplemented).toEqual([]); // camouflage built in coverage step 9 (hidden, Search)
    expect(entryById('srd:produce-flame').unimplemented[0]).toMatch(/Bright Light/);
  });
});

/** The CompiledSpell shared by every caster. */
function entryById(id: string) {
  for (const t of content().templates) for (const e of t.spells) if (e.spell.id === id) return e.spell;
  throw new Error(`no caster has ${id}`);
}

describe('bound programs per cast level', () => {
  it('Moonbeam: 2d10 radiant at level 2, 3d10 at level 3; a concentration instance per level; a 60-ft move grant on later turns', () => {
    const t = druid();
    const e = entry(t, 'srd:moonbeam');
    expect(e.prog.map((p) => p !== null)).toEqual([false, false, true, true, false, false, false, false, false, false]);
    for (const [lvl, dice] of [[2, '2d10'], [3, '3d10']] as const) {
      const apply = kind(e.prog[lvl]![0], 'apply');
      expect(apply.to).toBe('point');
      const beam = fx(t, apply.fx);
      expect([beam.id, beam.lvl, beam.sid, beam.zone, beam.limit, beam.dur]).toEqual([
        'srd:moonbeam/beam', lvl, entryById('srd:moonbeam').sid, { shapeKey: shapeKey('cylinder', 5), heightFt: 40, difficult: false }, 'perCreature', { k: 'parent' },
      ]);
      expect(beam.hookMask).toBe(HOOK.appear | HOOK.movedOnto | HOOK.enter | HOOK.turnEndIn);
      const save = kind(beam.hooks[0]!.steps[0], 'save');
      expect([save.ability, save.key, save.dc, save.half, save.dmg!.map((d) => [ex(d.roll), d.type])]).toEqual([2, saveKey(2), 15, true, [[dice, type('radiant')]]]);
      expect(beam.grants).toEqual([{ local: 'move', name: 'Move Moonbeam', cost: 'action', laterTurns: true, to: 'owner', steps: [{ k: 'moveZone', ft: 60 }] }]);
      const inst = fx(t, e.instance[lvl]!);
      expect([inst.id, inst.conc, inst.lvl, inst.dur, inst.hooks.length]).toEqual(['srd:moonbeam/concentration', true, lvl, { k: 'rounds', n: 10 }, 0]);
    }
    expect(e.instance.filter((i) => i >= 0)).toHaveLength(2);
  });

  it('Spike Growth: a 20-ft Difficult Sphere dealing 2d4 per 5 ft traveled; 10 minutes = 100 rounds of concentration', () => {
    const t = druid();
    const e = entry(t, 'srd:spike-growth');
    const spikes = fx(t, kind(e.prog[2]![0], 'apply').fx);
    expect(spikes.zone).toEqual({ shapeKey: shapeKey('sphere', 20), heightFt: 0, difficult: true });
    expect(spikes.hookMask).toBe(HOOK.travel);
    expect(kind(spikes.hooks[0]!.steps[0], 'damage').dmg.map((d) => ex(d.roll))).toEqual(['2d4']);
    expect(fx(t, e.instance[2]!).dur).toEqual({ k: 'rounds', n: 100 });
    // No upcast: level 3 deals the same.
    expect(kind(fx(t, kind(e.prog[3]![0], 'apply').fx).hooks[0]!.steps[0], 'damage').dmg.map((d) => ex(d.roll))).toEqual(['2d4']);
  });

  it('Healing Word: 2d4 + 4 at level 1, 4d4 + 4 at 2, 6d4 + 4 at 3; any creature within 60 ft, the caster included', () => {
    const e = entry(druid(), 'srd:healing-word');
    expect(kind(e.prog[1]![0], 'target')).toEqual({ k: 'target', rangeFt: 60, who: 'any', self: 'yes', maxSize: SIZES.length - 1 });
    expect([1, 2, 3].map((l) => ex(kind(e.prog[l]![1], 'heal').roll))).toEqual(['2d4 + 4', '4d4 + 4', '6d4 + 4']);
    expect(e.instance.every((i) => i === -1)).toBe(true);
  });

  it('the tether cantrip deals 2d6 at character level 6 and pulls 0 to 10 ft; its melee spell attack reaches 30 ft', () => {
    const e = entry(druid(), 'test:tether');
    expect(e.prog.map((p) => p !== null)).toEqual([true, false, false, false, false, false, false, false, false, false]);
    const atk = kind(e.prog[0]![1], 'attack');
    expect([atk.atk.kind, atk.atk.rollKey, atk.atk.toHit, atk.atk.reachFt, atk.atk.normalFt, atk.atk.spell, atk.atk.id]).toEqual(['melee', 'd20.attack.melee', 7, 30, 0, true, 'test:tether']);
    expect(kind(atk.onHit[0], 'damage').dmg.map((d) => [ex(d.roll), ex(d.critExtra)])).toEqual([['2d6', '2d6']]);
    expect(atk.onHit[1]).toEqual({ k: 'forced', mode: 'pull', maxFt: 10, maxSize: SIZES.indexOf('large') });
    expect(atk.atk.damage.map((d) => ex(d.roll))).toEqual(['2d6']);
  });

  it('the tether cantrip at 30 ft with a hostile adjacent has no Disadvantage source; a ranged spell attack in the same setup has one (critique resolution 15)', () => {
    const r = resolveScenario(
      {
        kind: 'scenario', id: 'reach', name: 'Reach', rules: '2024', packs: ['srd-5.2.1', 'test'], grid: { w: 8, h: 2 },
        units: [
          { seat: 'pc1', team: 'party', use: 'test:sample-druid', at: 'A1' },
          { seat: 'near', team: 'enemies', use: 'srd:goblin-warrior', at: 'B1' },
          { seat: 'far', team: 'enemies', use: 'srd:goblin-warrior', at: 'G1' },
        ],
      },
      'reach.yaml',
      repo.content!,
    );
    const s = r.setup!;
    const cx = createContext(s, 1, 0, makeDeciders(s), null);
    const u = (seat: string) => cx.st.units.find((x) => x.seat === seat)!;
    const pc = u('pc1');
    const tether = kind(pc.tpl.spells.find((e) => e.spell.id === 'test:tether')!.prog[0]![1], 'attack').atk;
    const hurl = kind(pc.tpl.effects.flatMap((t) => t.grants).find((g) => g.local === 'hurl')!.steps.find((x) => x.k === 'attack'), 'attack').atk;
    expect([tether.kind, tether.reachFt, hurl.kind]).toEqual(['melee', 30, 'ranged']);
    const adv: string[] = [];
    const dis: string[] = [];
    buildAttackSpecFor(cx.st, pc, tether, u('far'), pc.cell, adv, dis);
    expect(dis).toEqual([]);
    buildAttackSpecFor(cx.st, pc, hurl, u('far'), pc.cell, adv, dis);
    expect(dis).toEqual(['core:ranged-adjacent']);
  });

  it('Produce Flame: a Bonus Action flame in hand for 100 rounds whose hurl is a Magic action (not laterTurns), a 60-ft ranged spell attack for 2d8 fire at level 6', () => {
    const t = druid();
    const e = entry(t, 'srd:produce-flame');
    const apply = kind(e.prog[0]![0], 'apply');
    expect(apply.to).toBe('self');
    const flame = fx(t, apply.fx);
    expect([flame.dur, flame.inHand, flame.conc, flame.grants.length]).toEqual([{ k: 'rounds', n: 100 }, true, false, 1]);
    const hurl = flame.grants[0]!;
    expect([hurl.local, hurl.cost, hurl.laterTurns, hurl.to]).toEqual(['hurl', 'action', false, 'owner']);
    expect(kind(hurl.steps[0], 'target')).toMatchObject({ rangeFt: 60, self: 'no' });
    const atk = kind(hurl.steps[1], 'attack');
    expect([atk.atk.id, atk.atk.kind, atk.atk.normalFt, atk.atk.longFt, atk.atk.toHit, atk.atk.spell]).toEqual(['srd:produce-flame/hurl', 'ranged', 60, 60, 7, true]);
    expect(kind(atk.onHit[0], 'damage').dmg.map((d) => [ex(d.roll), d.type])).toEqual([['2d8', type('fire')]]);
  });

  it('Guidance: touch a willing creature (self textSilent), choose a skill, then a child adds 1d4 to checks with that skill', () => {
    const t = druid();
    const e = entry(t, 'srd:guidance');
    expect(e.source).toBe('charm');
    const [target, choose, apply] = e.prog[0]!;
    expect(kind(target, 'target')).toMatchObject({ rangeFt: 5, self: 'textSilent' });
    expect(choose).toEqual({ k: 'chooseSkill' });
    const guided = fx(t, kind(apply, 'apply').fx);
    expect(guided.dur).toEqual({ k: 'parent' });
    expect(guided.mods).toEqual([{ on: [compileKeyPattern('d20.check')], side: 'self', op: 'preDice', value: 0, dice: parseExpr('1d4'), consume: false, skillParam: true }]);
    expect(fx(t, e.instance[0]!)).toMatchObject({ id: 'srd:guidance/concentration', conc: true, dur: { k: 'rounds', n: 10 } });
  });

  it('Guiding Bolt: 4d6/5d6/6d6 radiant and a one-use incoming-Advantage rider lasting to the end of the caster\'s next turn; held-item gate and free pool resolve', () => {
    const t = druid();
    const e = entry(t, 'srd:guiding-bolt');
    expect([e.source, e.list, e.whileHeld, t.items[e.whileHeld]!.local, e.freePool, t.pools[e.freePool - 9]!.local, e.slotted]).toEqual(['charm', 'druid', 1, 'charm', 10, 'charm-bolts', true]);
    expect([1, 2, 3].map((l) => ex(kind(kind(e.prog[l]![1], 'attack').onHit[0], 'damage').dmg[0]!.roll))).toEqual(['4d6', '5d6', '6d6']);
    const lit = fx(t, kind(kind(e.prog[1]![1], 'attack').onHit[1], 'apply').fx);
    expect([lit.dur, lit.mods]).toEqual([
      { k: 'untilTurn', edge: 'end', of: 'owner' },
      [{ on: [compileKeyPattern('d20.attack')], side: 'incoming', op: 'adv', value: 0, dice: null, consume: true, skillParam: false }],
    ]);
  });

  it('every effect a level-L program reaches is bound at level L, and every apply index is in range', () => {
    for (const t of content().templates) {
      const visit = (steps: readonly Step[], lvl: number, seen: Set<number>): void => {
        for (const s of steps) {
          if (s.k === 'apply') {
            const e = fx(t, s.fx);
            expect(e.lvl).toBe(lvl);
            if (!seen.has(s.fx)) {
              seen.add(s.fx);
              for (const h of e.hooks) visit(h.steps, lvl, seen);
              for (const g of e.grants) visit(g.steps, lvl, seen);
            }
          } else if (s.k === 'attack') {
            visit(s.onHit, lvl, seen);
            visit(s.onMiss, lvl, seen);
          } else if (s.k === 'save') {
            visit(s.onFail, lvl, seen);
            visit(s.onSuccess, lvl, seen);
          } else if (s.k === 'choose') for (const o of s.opts) visit(o.steps, lvl, seen);
        }
      };
      for (const e of t.spells) e.prog.forEach((p, lvl) => p && visit(p, lvl, new Set()));
    }
  });

  it('critique #22: spell attacks are bound inside programs and never land in tpl.attacks', () => {
    let found = 0;
    const visit = (steps: readonly Step[], t: CompiledTemplate): void => {
      for (const s of steps) {
        if (s.k === 'attack') {
          found++;
          expect(s.atk.spell).toBe(true);
          expect(t.attacks.some((a) => a.id === s.atk.id)).toBe(false);
          visit(s.onHit, t);
        } else if (s.k === 'choose') for (const o of s.opts) visit(o.steps, t);
        else if (s.k === 'apply') for (const g of fx(t, s.fx).grants) visit(g.steps, t);
      }
    };
    for (const t of content().templates) {
      expect(t.attacks.every((a) => !a.spell)).toBe(true);
      for (const e of t.spells) for (const p of e.prog) if (p) visit(p, t);
      for (const f of t.features) if (f.activate) visit(f.activate.steps, t);
    }
    expect(found).toBeGreaterThanOrEqual(5); // tether, hurl, guiding bolt x3, the form's shot
  });
});

describe('the synthetic stand-ins', () => {
  it('the form: Bonus Action, spends forms, a 100-round root in group stance that ends on Incapacitated and dismissal, then a choice of three', () => {
    const t = druid();
    const f = t.features.find((x) => x.id === 'test:stance')!;
    const a = f.activate!;
    expect([a.local, a.cost, a.pool, t.pools[a.pool - 9]!.local]).toEqual(['stance', 'bonus', 9, 'forms']);
    const root = fx(t, a.root);
    expect([root.id, root.dur, root.endsOn, root.group, root.sid, root.lvl, root.conc]).toEqual(['test:stance/form', { k: 'rounds', n: 100 }, END.incap | END.dismiss, 'test:stance/stance', -1, 0, false]);
    const choose = kind(a.steps[0], 'choose');
    expect(choose.opts.map((o) => o.local)).toEqual(['volley', 'mending', 'steady']);
    expect(f.preRoll).toBeNull();
  });

  it('volley: a child granting a laterTurns Bonus Action 60-ft ranged spell attack for 1d8 + 4 radiant, fired once on activation by use', () => {
    const t = druid();
    const [apply, use] = kind(t.features[0]!.activate!.steps[0], 'choose').opts[0]!.steps;
    const volley = fx(t, kind(apply, 'apply').fx);
    expect(use).toEqual(expect.objectContaining({ k: 'use', grant: 0 }));
    expect(volley.dur).toEqual({ k: 'parent' });
    const shot = volley.grants[0]!;
    expect([shot.local, shot.cost, shot.laterTurns]).toEqual(['shot', 'bonus', true]);
    const atk = kind(shot.steps[1], 'attack');
    expect([atk.atk.id, atk.atk.kind, atk.atk.normalFt, atk.atk.toHit]).toEqual(['test:stance/shot', 'ranged', 60, 7]);
    expect(kind(atk.onHit[0], 'damage').dmg.map((d) => [ex(d.roll), ex(d.critExtra), d.type])).toEqual([['1d8 + 4', '1d8', type('radiant')]]);
  });

  it('mending: a slotHeal hook that targets anyone within 30 ft (self yes) and heals 1d8 + 4', () => {
    const t = druid();
    const mending = fx(t, kind(kind(t.features[0]!.activate!.steps[0], 'choose').opts[1]!.steps[0], 'apply').fx);
    expect(mending.hookMask).toBe(HOOK.slotHeal);
    expect(mending.hooks[0]!.steps[0]).toEqual({ k: 'target', rangeFt: 30, who: 'any', self: 'yes', maxSize: SIZES.length - 1 });
    expect(ex(kind(mending.hooks[0]!.steps[1], 'heal').roll)).toBe('1d8 + 4');
  });

  it('steady: a floor of 10 on INT and WIS checks and on CON saves to keep concentration, and nothing else', () => {
    const t = druid();
    const steady = fx(t, kind(kind(t.features[0]!.activate!.steps[0], 'choose').opts[2]!.steps[0], 'apply').fx);
    const m = steady.mods[0]!;
    expect([m.op, m.value, m.side]).toEqual(['floor', 10, 'self']);
    const hits = (key: number) => m.on.some((p) => (key & p.mask) === p.val);
    expect(hits(RK.check | (4 << RK.AB_SHIFT))).toBe(true); // INT check
    expect(hits(RK.check | (5 << RK.AB_SHIFT) | (12 << RK.SK_SHIFT))).toBe(true); // WIS (Perception) check
    expect(hits(saveKey(2, true))).toBe(true);
    expect(hits(saveKey(2))).toBe(false); // a plain CON save
    expect(hits(RK.check | (2 << RK.AB_SHIFT))).toBe(false); // a DEX check
  });

  it('the pre-roll reactions: 30 ft, self textSilent, 1d6 from the twist pool, subtract or add, on every D20 Test kind', () => {
    const seer = tpl('test:sample-seer');
    const r = seer.features[0]!.preRoll!;
    expect([r.rangeFt, r.self, r.pool, seer.pools[r.pool - 9]!.local, ex(r.die), r.sign, r.kinds]).toEqual([30, 'textSilent', 9, 'twist', '1d6', -1, (1 << RK.attack) | (1 << RK.save) | (1 << RK.check)]);
    const boon = load({ 'fx/manifest.yaml': TEST_MANIFEST, 'fx/pc.yaml': pcFile('test:boon-user', "pools: [{ id: twist, name: Twist, max: 2, recharge: longRest }]\nfeatures: ['test:fate-twist-boon']\n") });
    expect(errs(boon)).toEqual([]);
    expect(boon.content!.get('test:boon-user')!.features[0]!.preRoll!.sign).toBe(1);
  });

  it('the concentration ward: its appear hook applies a child rider (incoming Advantage) to each covered creature', () => {
    const r = load({ 'fx/manifest.yaml': TEST_MANIFEST, 'fx/pc.yaml': pcFile('test:warder', "slots: [2]\ncasting: [{ source: x, ability: wis, list: druid, prepared: ['test:conc-ward'] }]\n") });
    expect(errs(r)).toEqual([]);
    const t = r.content!.get('test:warder')!;
    const e = entry(t, 'test:conc-ward');
    const ward = fx(t, kind(e.prog[1]![0], 'apply').fx);
    expect([ward.zone, ward.hookMask, ward.interacts]).toEqual([{ shapeKey: shapeKey('sphere', 10), heightFt: 0, difficult: false }, HOOK.appear, true]);
    const rider = fx(t, kind(ward.hooks[0]!.steps[0], 'apply').fx);
    expect([kind(ward.hooks[0]!.steps[0], 'apply').to, rider.dur, rider.mods[0]!.side, rider.mods[0]!.op]).toEqual(['target', { k: 'parent' }, 'incoming', 'adv']);
    expect(fx(t, e.instance[1]!).conc).toBe(true);
  });

  it('the sample druid: AC without the shield, hands, slots then pools, resistance, skills, entries in file order', () => {
    const t = druid();
    expect([t.ac, t.hpMax, t.pb, t.startHands, t.items.map((i) => [i.local, i.kind, i.shieldAc, i.focusFor])]).toEqual([
      13, 45, 3, [0, 1], [['shield', 'shield', 2, []], ['charm', 'focus', 0, ['druid']]],
    ]);
    expect(t.resMax).toEqual([4, 3, 3, 0, 0, 0, 0, 0, 0, 3, 4]);
    expect(t.pools.map((p) => [p.local, p.max, p.recharge])).toEqual([['forms', 3, 'longRest'], ['charm-bolts', 4, 'longRest']]);
    expect(t.resist).toBe(damageBit(type('necrotic')));
    const skill = (n: string) => t.skillMod[SKILLS.findIndex(([s]) => s === n)];
    expect([skill('perception'), skill('nature'), skill('stealth'), skill('athletics')]).toEqual([7, 3, 2, -1]);
    expect(t.spells.map((e) => `${e.source}:${e.spell.local}`)).toEqual([
      'druid:tether', 'druid:produce-flame', 'druid:healing-word', 'druid:moonbeam', 'druid:spike-growth', 'charm:guidance', 'charm:guiding-bolt',
    ]);
    expect(t.spells.every((e) => e.toHit === 7 && e.dc === 15)).toBe(true);
    expect(t.flags).toEqual({});
  });
});

describe('expression folding', () => {
  it('cantrip tiers are x1, x2 at 5, x3 at 11, x4 at 17', () => {
    expect([1, 4, 5, 10, 11, 16, 17, 20].map(cantripTier)).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
  });

  it('merges added dice of one size and folds constants last', () => {
    expect(formatExpr(mergeDice(parseExpr('2d4 + 4 + 2d4 + 1d6 + 2d4')))).toBe('6d4 + 1d6 + 4');
    expect(formatExpr(mergeDice(parseExpr('1d8 - 1d8')))).toBe('1d8 - 1d8');
  });
});

describe('schema and compile rejections', () => {
  const one = (body: string, head?: string) => load({ 'fx/manifest.yaml': TEST_MANIFEST, 'fx/s.yaml': spellFile('test:s', body, head) }, false);

  it.each(Object.entries(RESERVED_HOOKS))('rejects the reserved hook name %s and names the milestone that adds it (%s)', (name, ms) => {
    const r = one(`effects:\n  - id: e\n    name: E\n    duration: { rounds: 1 }\n    on: [{ when: [${name}], do: [{ damage: [{ roll: 1d4, type: fire }] }] }]\ndo:\n  - target: { range: 60, self: no }\n  - apply: { effect: e, to: target }\n`);
    expect(errs(r)).toEqual([expect.stringMatching(new RegExp(`effects\\[0\\]\\.on\\[0\\]\\.when\\[0\\]: hook "${name}" is reserved and not modeled yet \\(${ms} adds it\\)`))]);
  });

  it('costly materials are a compile error', () => {
    const r = one('do: [{ target: { range: 60, self: no } }]\n', 'level: 1\ncastingTime: action\nrange: 60\ncomponents: { v: true, s: true, m: costly }\nduration: instant\n');
    expect(errs(r)).toEqual([expect.stringMatching(/components\.m: costly materials not modeled/)]);
  });

  it('duration: parent needs a root: an error in a non-concentration spell\'s program, fine under concentration or inside a hook', () => {
    const child = "effects:\n  - { id: kid, name: Kid, mods: [{ on: [d20.attack], op: adv }] }\n";
    const noRoot = one(`${child}do:\n  - target: { range: 60, self: no }\n  - apply: { effect: kid, to: target }\n`);
    expect(errs(noRoot)).toEqual([expect.stringMatching(/do\[1\]\.apply\.effect: kid lasts duration: parent, but nothing here can be its parent/)]);
    const conc = one(`${child}do:\n  - target: { range: 60, self: no }\n  - apply: { effect: kid, to: target }\n`, 'level: 1\ncastingTime: action\nrange: 60\ncomponents: { v: true, s: true }\nconcentration: true\nduration: { minutes: 1 }\n');
    expect(errs(conc)).toEqual([]);
    const feature = (root: string) =>
      load({ 'fx/manifest.yaml': TEST_MANIFEST, 'fx/f.yaml': `kind: feature\nid: test:f\nname: F\nsource: synthetic test fixture\nactivate:\n  id: go\n  name: Go\n  cost: bonus\n${root}  do: [{ apply: { effect: kid, to: self } }]\neffects:\n  - { id: top, name: Top, duration: { rounds: 10 } }\n  - { id: kid, name: Kid, mods: [{ on: [d20.attack], op: adv }] }\n` }, false);
    expect(errs(feature(''))).toEqual([expect.stringMatching(/activate\.do\[0\]\.apply\.effect: kid lasts duration: parent/)]);
    expect(errs(feature('  root: top\n'))).toEqual([]);
  });

  it('one damage step per attack branch', () => {
    const r = one('do:\n  - target: { range: 60, self: no }\n  - attack: { kind: ranged, range: 60, onHit: [{ damage: [{ roll: 1d4, type: fire }] }, { damage: [{ roll: 1d4, type: cold }] }] }\n');
    expect(errs(r)).toEqual([expect.stringMatching(/do\[1\]\.attack\.onHit\[1\]: one damage step per attack branch/)]);
  });

  it('placement checks: targets before attacks, use after apply, moveZone only in a zone, cantrip and upcast where they belong', () => {
    expect(errs(one('do: [{ attack: { kind: ranged, range: 60 } }]\n'))[0]).toMatch(/do\[0\]\.attack: an attack needs targets: put a target step before it/);
    expect(errs(one("effects:\n  - { id: e, name: E, duration: { rounds: 1 }, grants: [{ id: g, name: G, cost: bonus, do: [{ moveZone: { ft: 30 } }] }] }\ndo:\n  - use: g\n  - apply: { effect: e, to: self }\n"))).toEqual([
      expect.stringMatching(/effects\[0\]\.grants\[0\]\.do\[0\]: moveZone moves the zone it belongs to/),
      expect.stringMatching(/do\[0\]\.use: use fires a grant of the effect applied just before it/),
    ]);
    expect(errs(one('do:\n  - target: { range: 60, self: no }\n  - damage: [{ roll: 1d4, type: fire, cantrip: true }]\n'))[0]).toMatch(/cantrip: true scales by character level/);
    const cantripHead = 'level: 0\ncastingTime: action\nrange: 60\ncomponents: { v: true, s: true }\nduration: instant\n';
    expect(errs(one('do:\n  - target: { range: 60, self: no }\n  - damage: [{ roll: 1d4, type: fire, upcast: 1d4 }]\n', cantripHead))[0]).toMatch(/upcast belongs only in a leveled spell/);
  });

  it('an unknown step names the step kinds; a typo inside a step points at that key', () => {
    expect(errs(one('do: [{ attak: { kind: ranged, range: 60 } }]\n'))[0]).toMatch(/do\[0\]: expected exactly one step: target, attack, save/);
    expect(errs(one('do:\n  - target: { range: 60, self: no }\n  - attack: { kind: ranged, range: 60, onHit: [{ damage: [{ roll: 1d4, tpye: fire }] }] }\n'))).toEqual([
      expect.stringMatching(/s\.yaml:12:\d+: do\[1\]\.attack\.onHit\[0\]\.damage\[0\]: missing required key "type"/),
      expect.stringMatching(/s\.yaml:12:\d+: do\[1\]\.attack\.onHit\[0\]\.damage\[0\]: unknown key "tpye"/),
    ]);
  });

  it('roll keys are checked against the key grammar', () => {
    const r = one("effects:\n  - { id: e, name: E, duration: { rounds: 1 }, mods: [{ on: [d20.check.str.perception], op: adv }] }\ndo: [{ apply: { effect: e, to: self } }]\n");
    expect(errs(r)).toEqual([expect.stringMatching(/mods\[0\]\.on\[0\]: roll key "d20\.check\.str\.perception": perception is a wis skill/)]);
  });

  it('an area must name a zone effect the program places', () => {
    const r = one("area: e\neffects:\n  - { id: e, name: E, duration: { rounds: 1 } }\ndo: [{ apply: { effect: e, to: self } }]\n");
    expect(errs(r)).toEqual([expect.stringMatching(/area: area e has no zone/), expect.stringMatching(/area: the program never places e/)]);
  });

  it('an effect nothing applies is a warning', () => {
    const r = one("effects:\n  - { id: e, name: E, duration: { rounds: 1 } }\ndo: [{ target: { range: 60, self: no } }]\n");
    expect(errs(r)).toEqual([]);
    expect(warns(r)).toEqual([expect.stringMatching(/effects\[0\]\.id: effect e is never applied/)]);
  });
});

describe('the character linter', () => {
  const pc = (extra: string) => load({ 'fx/manifest.yaml': TEST_MANIFEST, 'fx/pc.yaml': pcFile('test:c', extra) });

  it('compares expect with the listed counts, never with a class table', () => {
    const r = pc("slots: [2, 2]\ncasting: [{ source: d, ability: wis, list: druid, cantrips: ['test:tether'], prepared: ['srd:healing-word', 'srd:moonbeam'] }]\nexpect: { cantrips: 2, prepared: 2 }\n");
    expect(errs(r)).toEqual([]);
    expect(warns(r)).toEqual([expect.stringMatching(/expect\.cantrips: expect\.cantrips is 2, but the casting lists name 1 cantrip\(s\)/)]);
  });

  it('flags a cantrip granted twice, across sources (an always-prepared cantrip counts)', () => {
    const r = pc("casting:\n  - { source: a, ability: wis, list: druid, cantrips: ['srd:guidance'] }\n  - { source: b, ability: wis, list: druid, always: ['srd:guidance'] }\n");
    expect(warns(r)).toEqual([expect.stringMatching(/casting\[1\]\.always\[0\]: cantrip srd:guidance is granted twice \(also at casting\[0\]\.cantrips\[0\]\)/)]);
  });

  it('an unresolved spell or feature loads with a warning and lands in unimplemented (so lint --strict fails on it)', () => {
    const r = pc("slots: [2]\ncasting: [{ source: d, ability: wis, list: druid, prepared: ['srd:web', 'srd:healing-word'] }]\nfeatures: ['test:wild-thing']\nfidelity: partial\nunimplemented: [later]\n");
    expect(errs(r)).toEqual([]);
    expect(warns(r)).toEqual([
      expect.stringMatching(/casting\[0\]\.prepared\[0\]: spell srd:web isn't in the loaded content; it's listed as unimplemented/),
      expect.stringMatching(/features\[0\]: feature test:wild-thing isn't in the loaded content/),
    ]);
    const t = r.content!.get('test:c')!;
    expect(t.unimplemented).toEqual(['later', 'spell srd:web (d): not in the loaded content', 'feature test:wild-thing: not in the loaded content']);
    expect(t.spells.map((e) => e.spell.id)).toEqual(['srd:healing-word']);
  });

  it('fidelity: full with unresolved spells is a warning too', () => {
    const r = pc("casting: [{ source: d, ability: wis, list: druid, cantrips: ['srd:nope'] }]\n");
    expect(warns(r).some((w) => /fidelity is full but 1 thing\(s\) aren't modeled/.test(w))).toBe(true);
  });

  it('errors: a wrong kind, a cantrip under prepared, a leveled spell under cantrips, unknown pools, items and hands', () => {
    const r = pc(
      [
        'items: [{ id: rod, name: Rod, kind: focus, focusFor: [druid] }]',
        'hands: [rod, wand]',
        'slots: [2]',
        'casting:',
        "  - { source: d, ability: wis, list: druid, whileHeld: orb, cantrips: ['srd:healing-word'], prepared: ['srd:guidance', 'srd:goblin-warrior'], free: [{ spell: 'srd:guiding-bolt', pool: nope }] }",
        "features: ['test:stance']",
        '',
      ].join('\n'),
    );
    expect(errs(r).map((e) => e.replace(/^fx\/pc\.yaml:\d+:\d+: /, ''))).toEqual([
      'hands[1]: no item "wand" in items',
      'casting[0].whileHeld: no item "orb" in items',
      'casting[0].cantrips[0]: Healing Word is a level 1 spell, not a cantrip: list it under prepared or always',
      'casting[0].prepared[0]: Guidance is a cantrip: list it under cantrips',
      'casting[0].prepared[1]: srd:goblin-warrior is a monster, not a spell',
      'casting[0].free[0].pool: no pool "nope" in pools',
      'features[0]: Stance spends pool "forms", which this character\'s pools don\'t define',
    ]);
  });

  it('a stated PB that disagrees with the level is a warning; character flags compile onto the template', () => {
    const r = pc('pb: 4\nflags: { diagonalCost: alternate }\n');
    expect(errs(r)).toEqual([]);
    expect(warns(r)).toEqual([expect.stringMatching(/pb: PB \+4 doesn't match level 6 \(expected \+3\)/)]);
    expect(r.content!.get('test:c')!.flags).toEqual({ diagonalCost: 'alternate' });
  });

  it.runIf(UNIMPL !== null)('a flag value the engine hasn\'t implemented yet is a warning (the file still loads)', () => {
    const r = pc(`flags: { ${UNIMPL!.key}: ${UNIMPL!.value} }\n`);
    expect(errs(r)).toEqual([]);
    expect(warns(r)).toEqual([expect.stringMatching(new RegExp(`flags\\.${UNIMPL!.key}: flag ${UNIMPL!.key}=${UNIMPL!.value} isn't implemented yet`))]);
  });

  it('a spell with no castable level warns', () => {
    const r = pc("slots: [2]\ncasting: [{ source: d, ability: wis, list: druid, prepared: ['srd:moonbeam'] }]\n");
    expect(warns(r)).toEqual([expect.stringMatching(/Moonbeam can't be cast: no spell slot of level 2 or higher and no free casts/)]);
  });
});

describe('character-file flags in scenarios (CLI > scenario > character file > default)', () => {
  const withFlags = (id: string, flags: string) => pcFile(id, `flags: ${flags}\n`);
  const files = {
    'fx/manifest.yaml': TEST_MANIFEST,
    'fx/a.yaml': withFlags('test:a', '{ initiativeMode: static, diagonalCost: alternate }'),
    'fx/b.yaml': withFlags('test:b', '{ initiativeMode: roll }'),
    'fx/c.yaml': withFlags('test:c', UNIMPL ? `{ ${UNIMPL.key}: ${UNIMPL.value} }` : '{}'),
  };
  const c = load(files).content!;
  const scenario = (units: string[], flags = '') =>
    `kind: scenario\nid: s\nname: S\nrules: '2024'\npacks: [fx, srd-5.2.1]\ngrid: { w: 6, h: 6 }\n${flags}units:\n${units.map((u, i) => `  - { seat: u${i}, team: ${i === 0 ? 'party' : 'enemies'}, use: '${u}', at: ${'ABCDEF'[i]}1 }`).join('\n')}\n`;

  it('a character file\'s flag applies when the scenario is silent, and the scenario and CLI win over it', () => {
    const r = resolveScenario(scenario(['test:a', 'srd:goblin-warrior']), 's.yaml', c);
    expect(r.errors).toEqual([]);
    expect([r.setup!.flags.initiativeMode, r.setup!.flags.diagonalCost]).toEqual(['static', 'alternate']);
    const sc = resolveScenario(scenario(['test:a', 'srd:goblin-warrior'], 'flags: { initiativeMode: roll }\n'), 's.yaml', c);
    expect(sc.setup!.flags.initiativeMode).toBe('roll');
    const cli = resolveScenario(scenario(['test:a', 'srd:goblin-warrior'], 'flags: { initiativeMode: roll }\n'), 's.yaml', c, { flags: { diagonalCost: 'uniform' } });
    expect(cli.setup!.flags.diagonalCost).toBe('uniform');
  });

  it('two characters that disagree are an error unless the scenario settles it', () => {
    const r = resolveScenario(scenario(['test:a', 'test:b']), 's.yaml', c);
    expect(r.errors.map(formatDiag)).toEqual([expect.stringMatching(/units\[1\]\.use: test:b's character file sets initiativeMode=roll but test:a's sets static; settle it in the scenario's flags/)]);
    expect(resolveScenario(scenario(['test:a', 'test:b'], 'flags: { initiativeMode: static }\n'), 's.yaml', c).errors).toEqual([]);
  });

  it.runIf(UNIMPL !== null)('an unimplemented value from a character file names the file; a scenario setting wins', () => {
    const { key, value } = UNIMPL!;
    const r = resolveScenario(scenario(['test:c', 'srd:goblin-warrior']), 's.yaml', c);
    expect(r.errors.map(formatDiag)).toEqual([expect.stringMatching(new RegExp(`units\\[0\\]\\.use: flag ${key}=${value} \\(from test:c's character file\\) isn't implemented yet`))]);
    const dflt = String(FLAG_INFO[key as keyof typeof FLAG_INFO].default);
    expect(resolveScenario(scenario(['test:c', 'srd:goblin-warrior'], `flags: { ${key}: ${dflt} }\n`), 's.yaml', c).errors).toEqual([]);
  });
});

describe('check-private stays clean on the M1b content', () => {
  it('no private marker or non-SRD name in the new packs, schemas or content code', () => {
    const files = [
      ...walk(join(ROOT, 'packs')),
      ...readdirSync(join(ROOT, 'schemas')).map((n) => join(ROOT, 'schemas', n)),
      ...readdirSync(join(ROOT, 'packages/engine/src/content')).map((n) => join(ROOT, 'packages/engine/src/content', n)),
      join(ROOT, 'packages/engine/src/scenario/resolve.ts'),
    ];
    const findings = files.flatMap((p) => checkContent(relative(ROOT, p), readFileSync(p), false));
    expect(findings).toEqual([]);
    expect(PRIV).toBe('private'); // the marker the guard looks for, assembled at runtime
  });
});
