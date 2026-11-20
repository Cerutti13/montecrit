// Step E (owner C): the CLI's view of a Multiattack monster's plain Attack action. compileMonster
// appends it as the last alternative (plainAlt); the sheet, its --json and migrate's template
// diff print it apart from the Multiattack choices (docs/design/stepE-plan.md sections 3 and 9).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { describeEvent, type FightSetup, type GameEvent } from '@montecrit/engine';
import { loadKnown } from '../src/home.ts';
import { templateFields } from '../src/migrate.ts';
import { runSheet } from '../src/sheet.ts';

const root = mkdtempSync(join(tmpdir(), 'montecrit-attack-action-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
// Never the real ~/.montecrit: every run gets an empty home of its own.
const emptyHome = () => ({ MONTECRIT_HOME: mkdtempSync(join(root, `home${n++}-`)) });
const block = (out: string): string => out.slice(out.search(/^(Multiattack|Attack)\b/m), out.indexOf('\nOptions:'));

describe('the sheet lists the Attack action apart from Multiattack (43908-43910, 32705-32706)', () => {
  it('text: the Multiattack routine, then the Attack action on its own line', () => {
    const r = runSheet(['srd:goblin-boss'], emptyHome());
    expect(r.code).toBe(0);
    expect(block(r.out)).toBe('Multiattack:\n  2 x [Scimitar | Shortbow]\nAttack action: one of [Scimitar | Shortbow | Unarmed Strike]\n');
  });

  it('text: two Multiattack choices stay "choose one", the Attack action is not a third (the Warrior Veteran)', () => {
    const r = runSheet(['srd:warrior-veteran'], emptyHome());
    expect(block(r.out)).toBe(
      'Multiattack, choose one:\n  2 x [Greatsword]\n  2 x [Heavy Crossbow]\nAttack action: one of [Greatsword | Heavy Crossbow | Unarmed Strike]\n',
    );
  });

  it('text: an attack outside every Multiattack line is in the Attack action (the Ghoul\'s Claw, 43416-43417)', () => {
    const r = runSheet(['srd:ghoul'], emptyHome());
    expect(block(r.out)).toBe('Multiattack:\n  2 x [Bite]\nAttack action: one of [Bite | Claw | Unarmed Strike]\n');
  });

  it('--json: alts are the Multiattack choices only, attackAction holds the plain alternative', () => {
    const j = JSON.parse(runSheet(['srd:ghoul', '--json'], emptyHome()).out);
    expect(j.attackAct).toEqual({
      name: 'Multiattack',
      multi: true,
      extraAttack: false,
      alts: [[{ count: 2, from: ['srd:ghoul/bite'] }]],
      attackAction: [{ count: 1, from: ['srd:ghoul/bite', 'srd:ghoul/claw', 'core:unarmed-strike'] }],
    });
  });
});

describe('sheet for a non-Multiattack monster is unchanged', () => {
  it('--json: attackAct has no attackAction key and keeps its one alternative', () => {
    const j = JSON.parse(runSheet(['srd:goblin-warrior', '--json'], emptyHome()).out);
    expect(Object.keys(j.attackAct)).toEqual(['name', 'multi', 'extraAttack', 'alts']);
    expect(j.attackAct).toEqual({
      name: 'Attack',
      multi: false,
      extraAttack: false,
      alts: [[{ count: 1, from: ['srd:goblin-warrior/scimitar', 'srd:goblin-warrior/shortbow', 'core:unarmed-strike'] }]],
    });
  });

  it('text: no "Attack action" line', () => {
    const r = runSheet(['srd:goblin-warrior'], emptyHome());
    expect(block(r.out)).toBe('Attack:\n  1 x [Scimitar | Shortbow | Unarmed Strike]\n');
    expect(r.out).not.toContain('Attack action');
  });
});

describe("migrate's template diff prints the Attack action on its own key", () => {
  const loaded = loadKnown(emptyHome());
  const tpl = (id: string) => {
    const t = loaded.content!.templates.find((x) => x.id === id);
    if (!t) throw new Error(`no template ${id}`);
    return t;
  };

  it('a Multiattack template: attackAct has no "or 1 x [...]", attackAction lists the plain alternative', () => {
    const m = templateFields(tpl('srd:goblin-boss'), []);
    expect(m.get('attackAct')).toBe('Multiattack: 2 x [scimitar | shortbow]');
    expect(m.get('attackAction')).toBe('one of [scimitar | shortbow | core:unarmed-strike]');
    const vet = templateFields(tpl('srd:warrior-veteran'), []);
    expect(vet.get('attackAct')).toBe('Multiattack: 2 x [greatsword] or 2 x [heavy-crossbow]');
  });

  it('a template without Multiattack has no attackAction key', () => {
    const m = templateFields(tpl('srd:goblin-warrior'), []);
    expect(m.get('attackAct')).toBe('Attack: 1 x [scimitar | shortbow | core:unarmed-strike]');
    expect(m.has('attackAction')).toBe(false);
  });
});

describe('the pickup line names one piece and its count (step E, an item event with left)', () => {
  // describe() reads only the seat names for an item line.
  const setup = { seats: [{ seat: 'gladiator1' }, { seat: 'pc1' }], w: 10 } as unknown as FightSetup;
  const item = (who: number, name: string, extra: Partial<{ left: number }>): GameEvent =>
    ({ seq: 1, round: 1, turnOf: who, cause: -1, k: 'item', who, item: name, act: 'pickup', ...extra }) as GameEvent;

  it("a monster's pickup: one piece of the plural gear name, then the count it now carries", () => {
    expect(describeEvent(item(0, 'Spears', { left: 1 }), setup)).toBe('gladiator1 picks up a Spear (1 left)');
    expect(describeEvent(item(0, 'Javelins', { left: 2 }), setup)).toBe('gladiator1 picks up a Javelin (2 left)');
    expect(describeEvent(item(0, 'Light Hammers', { left: 3 }), setup)).toBe('gladiator1 picks up a Light Hammer (3 left)');
    expect(describeEvent(item(0, 'Spear', { left: 1 }), setup)).toBe('gladiator1 picks up a Spear (1 left)');
  });

  it("a PC's pickup (no left) keeps its old line", () => {
    expect(describeEvent(item(1, 'Javelin', {}), setup)).toBe('pc1 picks up Javelin');
  });
});
