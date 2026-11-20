// M3 step 5a: the Monk's features (and Action Surge) raised through reviewed overrides (C7),
// each mapping checked against the committed pack it produces: the program, the fidelity, the
// one line left where something isn't modeled, and the closed line templates that say so.
// Committed files only; no cache, no home dir.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { loadOverrides } from '../overrides.ts';
import { PDF_READINGS, readingProblems } from '../pdf-gates.ts';
import { isTemplateLine, U } from '../unimplemented.ts';
import { REPO_ROOT } from '../util.ts';

type Item = Record<string, unknown>;
const PACK = join(REPO_ROOT, 'packs/srd-5.2.1');
const ITEMS = (() => {
  const out = new Map<string, Item>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.yaml') && e.name !== 'manifest.yaml') {
        const d = parse(readFileSync(p, 'utf8')) as Item;
        out.set(d.id as string, d);
      }
    }
  };
  walk(PACK);
  return out;
})();
const item = (id: string): Item => {
  const it = ITEMS.get(id);
  if (!it) throw new Error(`${id} is not in the pack`);
  return it;
};
const prov = (id: string) => item(id).provenance as Item;

describe('closed line templates for hand overrides (C5)', () => {
  it('part <id> not modeled and needs engine support: <id> are template lines; free text is not', () => {
    expect(U.part('deflect-redirect')).toBe('part deflect-redirect not modeled');
    expect(U.engineGap('self-target')).toBe('needs engine support: self-target');
    expect(isTemplateLine('part step-of-the-wind-jump not modeled')).toBe(true);
    expect(isTemplateLine('needs engine support: self-target')).toBe(true);
    expect(isTemplateLine('part the redirect when reduced to 0 not modeled')).toBe(false);
    expect(() => U.part('Redirect Attack')).toThrow();
  });
});

describe('the Monk features (docs/design/m3.md section 5), each a reviewed override with its PDF page', () => {
  const REVIEWED: [string, string, number][] = [
    ['srd:monk/martial-arts', 'partial', 50],
    ['srd:monk/monks-focus', 'partial', 50],
    ['srd:monk/uncanny-metabolism', 'full', 51],
    ['srd:monk/deflect-attacks', 'partial', 51],
    ['srd:monk/stunning-strike', 'full', 51],
    ['srd:monk/empowered-strikes', 'full', 51],
    ['srd:warrior-of-the-open-hand/open-hand-technique', 'full', 52],
    ['srd:fighter/action-surge', 'partial', 48],
  ];
  it.each(REVIEWED)('%s is %s, review reviewed, pdfPage %i, and its override is recorded', (id, fidelity, page) => {
    expect(item(id).fidelity).toBe(fidelity);
    expect(prov(id).review).toBe('reviewed');
    expect(prov(id).pdfPage).toBe(page);
    expect((prov(id).overrides as Item[]).map((o) => o.file)).toEqual([`tools/import-srd/overrides/feature/${id.slice(4)}.yaml`]);
    const lines = (item(id).unimplemented as string[] | undefined) ?? [];
    expect(fidelity === 'full' ? lines.length === 0 : lines.length > 0).toBe(true);
    for (const l of lines) expect(isTemplateLine(l)).toBe(true);
  });

  it('Martial Arts, srd-raw.txt:11088: the Bonus Unarmed Strike, gated unarmored and noShield; the Grapple/Shove DEX DC is the line left', () => {
    const a = item('srd:monk/martial-arts').activate as Item;
    expect(a).toMatchObject({ id: 'bonus-strike', cost: 'bonus', when: ['unarmored', 'noShield'], do: [{ weaponAttack: { with: 'unarmed' } }] });
    expect(item('srd:monk/martial-arts').unimplemented).toEqual(['part grapple-shove-dex-dc not modeled']);
  });

  it("Monk's Focus, 11126-11137: five Bonus Action activations, the three Focus forms spending monks-focus; the jump is the line left", () => {
    const acts = item('srd:monk/monks-focus').activate as Item[];
    expect(acts.map((a) => [a.id, a.cost, (a.uses as Item | undefined)?.pool ?? null])).toEqual([
      ['flurry', 'bonus', 'monks-focus'],
      ['patient', 'bonus', null],
      ['patient-focus', 'bonus', 'monks-focus'],
      ['wind', 'bonus', null],
      ['wind-focus', 'bonus', 'monks-focus'],
    ]);
    expect(acts[0]!.do).toEqual([{ weaponAttack: { with: 'unarmed', count: 2 } }]);
    expect(acts[2]!.do).toEqual([{ core: 'disengage' }, { core: 'dodge' }]);
    expect(acts[4]!.do).toEqual([{ core: 'disengage' }, { core: 'dash' }]);
    expect(item('srd:monk/monks-focus').unimplemented).toEqual(['part step-of-the-wind-jump not modeled']);
    // The pool it spends is the class's.
    expect((item('srd:monk').pools as Item[]).map((p) => p.id)).toContain('monks-focus');
  });

  it('Uncanny Metabolism, 11146-11152: optional at initiative, its own once-per-Long-Rest pool, refill Focus, heal Monk level + the Martial Arts die', () => {
    expect(item('srd:monk/uncanny-metabolism').initiative).toEqual({
      id: 'uncanny-metabolism',
      name: 'Uncanny Metabolism',
      uses: { pool: 'uncanny-metabolism' },
      do: [{ pool: { id: 'monks-focus', delta: 'refill' } }, { heal: { roll: '@classLevel + @scale.monk.die' } }],
    });
    // @scale.monk.die is the Martial Arts column: 1d6/1d8/1d10/1d12 at Monk 1/5/11/17 (PDF table p.50).
    expect(((item('srd:monk').scale as Item).die as Item).at).toEqual({ '1': '1d6', '5': '1d8', '11': '1d10', '17': '1d12' });
  });

  it('Deflect Attacks, 11156-11159 and C12: hitTaken, B/P/S only, 1d10 + DEX + Monk level; the redirect is the line left', () => {
    expect(item('srd:monk/deflect-attacks').reaction).toEqual({ window: 'hitTaken', reduce: '1d10 + @mod.dex + @classLevel', damageTypes: ['bludgeoning', 'piercing', 'slashing'] });
    expect(item('srd:monk/deflect-attacks').unimplemented).toEqual(['part deflect-redirect not modeled']);
  });

  it('Stunning Strike, 11203-11210: once per turn (global, C1), 1 Focus, CON save; fail Stunned to the start of your next turn; success Speed halved and the next attack has Advantage', () => {
    const it = item('srd:monk/stunning-strike');
    expect(it.spellAbility).toBe('wis');
    const r = (it.riders as Item[])[0]!;
    expect(r).toMatchObject({ on: 'hit', filter: { attack: ['unarmed', 'monkWeapon'] }, oncePerTurn: 'global', cost: { pool: 'monks-focus' } });
    const save = ((r.do as Item[])[0]!.save as Item);
    expect(save.ability).toBe('con');
    expect(save.onFail).toEqual([{ condition: { id: 'stunned', until: { until: 'startOfNextTurn', of: 'caster' } } }]);
    expect((save.onSuccess as Item[]).map((s) => (s.apply as Item).effect)).toEqual(['stunning-strike-slowed', 'stunning-strike-opened']);
    const fx = it.effects as Item[];
    expect(fx.map((e) => e.duration)).toEqual([{ until: 'startOfNextTurn', of: 'caster' }, { until: 'startOfNextTurn', of: 'caster' }]);
    expect(fx[0]!.stats).toEqual([{ speed: 'half' }]);
    expect(fx[1]!.mods).toEqual([{ on: ['d20.attack'], side: 'incoming', op: 'adv', consume: 'nextRoll' }]);
  });

  it('Open Hand Technique, 11312-11319: on a Flurry hit, Addle (no OAs to its next turn) / Push (STR save, 15 ft) / Topple (DEX save, Prone)', () => {
    const it = item('srd:warrior-of-the-open-hand/open-hand-technique');
    const r = (it.riders as Item[])[0]!;
    expect(r.filter).toEqual({ grantedBy: 'flurry' });
    expect(r.oncePerTurn).toBeUndefined();
    expect((r.choose as Item[]).map((c) => c.id)).toEqual(['addle', 'push', 'topple']);
    expect((it.effects as Item[])[0]).toMatchObject({ id: 'addled', duration: { until: 'startOfNextTurn', of: 'bearer' }, stats: [{ noOpportunityAttacks: true }] });
    const push = ((r.choose as Item[])[1]!.do as Item[])[0]!.save as Item;
    expect(push).toMatchObject({ ability: 'str', onFail: [{ forcedMove: { mode: 'push', maxFt: 15, maxSize: 'gargantuan' } }] });
    const topple = ((r.choose as Item[])[2]!.do as Item[])[0]!.save as Item;
    expect(topple).toMatchObject({ ability: 'dex', onFail: [{ condition: { id: 'prone' } }] });
  });

  it('Empowered Strikes, 11214-11216: a passive unarmed force damage type (C13)', () => {
    const it = item('srd:monk/empowered-strikes');
    expect(it.passive).toEqual({ effects: ['empowered-strikes'] });
    expect((it.effects as Item[])[0]!.stats).toEqual([{ damageType: 'force', on: 'unarmed' }]);
  });

  it('Second Wind, 10592-10607: a bonus self activation on the second-wind pool healing 1d10 + Fighter level, full (step 6)', () => {
    const sw = item('srd:fighter/second-wind');
    expect(sw.activate).toEqual({ id: 'second-wind', name: 'Second Wind', cost: 'bonus', uses: { pool: 'second-wind' }, target: 'self', do: [{ heal: { roll: '1d10 + @classLevel' } }] });
    expect([sw.fidelity, sw.unimplemented, (sw.provenance as Item).review, (sw.provenance as Item).pdfPage]).toEqual(['full', undefined, 'reviewed', 48]);
  });

  it('Wholeness of Body, 11321-11330: a bonus action on its user only, healing the Martial Arts die + WIS, minimum 1 (C11)', () => {
    const wb = item('srd:warrior-of-the-open-hand/wholeness-of-body');
    expect(wb.fidelity).toBe('full');
    expect(wb.activate).toEqual({ id: 'wholeness-of-body', name: 'Wholeness of Body', cost: 'bonus', uses: { pool: 'wholeness-of-body' }, target: 'self', do: [{ heal: { roll: 'max(1, @scale.monk.die + @mod.wis)' } }] });
    expect(wb.unimplemented ?? []).toEqual([]);
  });

  it('Action Surge, 10625-10632: a free activation on the action-surge pool gaining one action; the Magic-action exception is the line left', () => {
    expect(item('srd:fighter/action-surge').activate).toEqual({ id: 'action-surge', name: 'Action Surge', cost: 'free', uses: { pool: 'action-surge' }, do: [{ gainAction: 'action' }] });
    expect(item('srd:fighter/action-surge').unimplemented).toEqual(['part magic-action-exception not modeled']);
  });

  it('the rider effects have PDF readings (no gates), and the readings check passes on the committed pack', () => {
    expect(PDF_READINGS['srd:monk/stunning-strike']!.when).toEqual([]);
    expect(PDF_READINGS['srd:warrior-of-the-open-hand/open-hand-technique']!.when).toEqual([]);
    expect(readingProblems(ITEMS)).toEqual([]);
  });

  it('every step-5a override parses and targets an emitted item', () => {
    // Coverage C0's relabels (mechanizedBy) in these folders are checked in c0-coverage.test.ts.
    const mine = loadOverrides().filter((o) => /feature\/(monk|warrior-of-the-open-hand|fighter)\//.test(o.file) && o.body.mechanizedBy === undefined);
    expect(mine.map((o) => o.id).sort()).toEqual(
      [
        'srd:fighter/action-surge',
        'srd:fighter/second-wind',
        'srd:fighter/tactical-shift', // coverage W1 (w1-overrides.test.ts)
        'srd:monk/deflect-attacks',
        'srd:monk/empowered-strikes',
        'srd:monk/martial-arts',
        'srd:monk/monks-focus',
        'srd:monk/stunning-strike',
        'srd:monk/unarmed-strike',
        'srd:monk/unarmored-movement',
        'srd:monk/uncanny-metabolism',
        'srd:warrior-of-the-open-hand/open-hand-technique',
        'srd:warrior-of-the-open-hand/wholeness-of-body',
      ].sort(),
    );
    for (const o of mine) expect(ITEMS.has(o.id)).toBe(true);
  });
});
