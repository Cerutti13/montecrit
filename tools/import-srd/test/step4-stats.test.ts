// M3 step 4: the importer emits the STAT, GATE and condition-immunity forms where the reading is
// exact (docs/design/m3.md section 3, C6, C7). Each block is a regression test for one mapping:
// the change table (map/stats.ts), the PDF readings that supply the gates Foundry leaves out
// (pdf-gates.ts), the class-feature and feat mappers, the reviewed overrides that raise fidelity,
// and the disclosed gaps. Synthetic records plus the committed pack; no cache, no home dir.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { classifyChange } from '../effect-keys.ts';
import { mapEffects } from '../map/feature.ts';
import { featureBody } from '../map/species.ts';
import { statPart } from '../map/stats.ts';
import { applyOverride, loadOverrides, parseOverride } from '../overrides.ts';
import { PDF_READINGS, readingProblems } from '../pdf-gates.ts';
import { isTemplateLine, U } from '../unimplemented.ts';
import { REPO_ROOT } from '../util.ts';

type Item = Record<string, unknown>;
const PACK = join(REPO_ROOT, 'packs/srd-5.2.1');
const packItems = (): Map<string, Item> => {
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
};
const ITEMS = packItems();

const target = (key: string, mode: string) => {
  const c = classifyChange(key, mode);
  if (c.status !== 'mapped') throw new Error(`${key} is ${c.status}`);
  return c.target;
};

/** A Foundry-shaped record with one always-on effect. */
const rec = (changes: { key: string; type: string; value: unknown }[], extra: Item = {}): Item => ({
  effects: [{ name: 'Fx', transfer: true, disabled: false, statuses: [], system: { changes } }],
  ...extra,
});

describe('map/stats.ts: one effect change -> one stat, exactly or not at all', () => {
  it('ac.bonus add 1 -> { ac: 1 }; a zero or a formula is not a stat', () => {
    expect(statPart(target('system.attributes.ac.bonus', 'add'), 'add', 1)).toEqual({ stat: { ac: 1 } });
    expect(statPart(target('system.attributes.ac.bonus', 'add'), 'add', '+1')).toEqual({ stat: { ac: 1 } });
    expect(statPart(target('system.attributes.ac.bonus', 'add'), 'add', 0)).toBeUndefined();
    expect(statPart(target('system.attributes.ac.bonus', 'add'), 'add', '@abilities.dex.mod')).toBeUndefined();
  });
  it('movement.walk add: a multiple of 5 or a qualified @scale; other speeds and modes are not walking-speed bonuses', () => {
    expect(statPart(target('system.attributes.movement.walk', 'add'), 'add', 10)).toEqual({ stat: { speed: 10 } });
    expect(statPart(target('system.attributes.movement.walk', 'add'), 'add', '@scale.monk.unarmored-movement')).toEqual({ stat: { speed: '@scale.monk.unarmored-movement' } });
    expect(statPart(target('system.attributes.movement.walk', 'add'), 'add', 7)).toBeUndefined();
    expect(statPart(target('system.attributes.movement.walk', 'upgrade'), 'upgrade', 35)).toBeUndefined();
    expect(statPart(target('system.attributes.movement.fly', 'upgrade'), 'upgrade', 30)).toBeUndefined();
    expect(statPart(target('system.attributes.movement.swim', 'add'), 'add', 10)).toBeUndefined();
  });
  it('weaponCriticalThreshold downgrade 19 -> { critMin: 19 }', () => {
    expect(statPart(target('flags.dnd5e.weaponCriticalThreshold', 'downgrade'), 'downgrade', 19)).toEqual({ stat: { critMin: 19 } });
    expect(statPart(target('flags.dnd5e.weaponCriticalThreshold', 'downgrade'), 'downgrade', 20)).toBeUndefined();
  });
  it('di and dv to immune and vuln stats; ci only for an exact condition id ("poison" is a damage word, not Poisoned)', () => {
    expect(statPart(target('system.traits.di.value', 'add'), 'add', 'fire')).toEqual({ stat: { immune: ['fire'] } });
    expect(statPart(target('system.traits.dv.value', 'add'), 'add', 'cold')).toEqual({ stat: { vuln: ['cold'] } });
    expect(statPart(target('system.traits.ci.value', 'add'), 'add', 'frightened')).toEqual({ immuneCond: 'frightened' });
    expect(statPart(target('system.traits.ci.value', 'add'), 'add', 'poison')).toBeUndefined();
    expect(statPart(target('system.traits.ci.value', 'add'), 'add', 'grappled')).toBeUndefined();
  });
});

describe('pdf-gates.ts: Foundry applies an always-on effect unconditionally; the PDF reading supplies its gates', () => {
  const UM = rec([{ key: 'system.attributes.movement.walk', type: 'add', value: '@scale.monk.unarmored-movement' }]);

  it('Unarmored Movement: "while you aren\'t wearing armor or wielding a Shield" (srd-raw.txt:11141-11142) -> gates unarmored, noShield', () => {
    const m = mapEffects(UM, 'monk', 'srd:monk/unarmored-movement');
    expect(m.lines).toEqual([]);
    expect(m.effects).toEqual([{ id: 'fx', name: 'Fx', stats: [{ speed: '@scale.monk.unarmored-movement', when: ['unarmored', 'noShield'] }] }]);
    expect(m.passive).toEqual(['fx']);
  });

  it('the same change on a feature with no reading keeps its effect-key line (Roving: its gate waits for W1b)', () => {
    const m = mapEffects(rec([{ key: 'system.attributes.movement.walk', type: 'add', value: 10 }]), 'ranger', 'srd:ranger/roving');
    expect(m.effects).toEqual([]);
    expect(m.lines).toEqual([U.effectKey('system.attributes.movement.walk', 'add')]);
  });

  it('coverage W1, Fast Movement: "while you aren\'t wearing Heavy armor" (srd-raw.txt:5067-5068) -> speed 10 when notHeavyArmor', () => {
    const m = mapEffects(rec([{ key: 'system.attributes.movement.walk', type: 'add', value: 10 }]), 'barbarian', 'srd:barbarian/fast-movement');
    expect(m.lines).toEqual([]);
    expect(m.effects).toEqual([{ id: 'fx', name: 'Fx', stats: [{ speed: 10, when: ['notHeavyArmor'] }] }]);
    expect(m.passive).toEqual(['fx']);
  });

  it('coverage W1: a row whose feature carries only a condition immunity is emitted with its reading (Mindless Rage)', () => {
    const items = new Map<string, Item>([
      ['srd:path-of-the-berserker', { kind: 'subclass' }],
      ['srd:path-of-the-berserker/mindless-rage', { kind: 'feature', effects: [{ id: 'mindless', immune: ['charmed', 'frightened'] }] }],
    ]);
    const row = { 'srd:path-of-the-berserker/mindless-rage': PDF_READINGS['srd:path-of-the-berserker/mindless-rage']! };
    expect(readingProblems(items, row)).toEqual([]);
    items.set('srd:path-of-the-berserker/mindless-rage', { kind: 'feature', effects: [{ id: 'mindless' }] });
    expect(readingProblems(items, row)).toEqual(['srd:path-of-the-berserker/mindless-rage: emitted without its reading (p.30, srd-raw.txt:5180-5184)']);
  });

  it('Danger Sense: "unless you have the Incapacitated condition" (srd-raw.txt:5016-5017) gates the save Advantage on notIncapacitated', () => {
    const m = mapEffects(rec([{ key: 'system.abilities.dex.save.roll.mode', type: 'add', value: 1 }]), 'barbarian', 'srd:barbarian/danger-sense');
    expect(m.effects[0]!.mods).toEqual([{ on: ['d20.save.dex'], op: 'adv', when: ['notIncapacitated'] }]);
    // Without its reading the step-2 mapping is unchanged: an ungated mod.
    expect(mapEffects(rec([{ key: 'system.abilities.dex.save.roll.mode', type: 'add', value: 1 }]), 'barbarian', 'srd:x/y').effects[0]!.mods).toEqual([{ on: ['d20.save.dex'], op: 'adv' }]);
  });

  it('Improved Critical: "a Critical Hit on a roll of 19 or 20" for weapons and Unarmed Strikes (srd-raw.txt:10713-10715) -> critMin 19, no gate', () => {
    const m = mapEffects(rec([{ key: 'flags.dnd5e.weaponCriticalThreshold', type: 'downgrade', value: 19 }]), 'fighter', 'srd:champion/improved-critical');
    expect(m.effects[0]!.stats).toEqual([{ critMin: 19 }]);
  });

  it('Defense: "While you\'re wearing Light, Medium, or Heavy armor, you gain a +1 bonus to Armor Class" (srd-raw.txt:20121) -> ac 1 when armored', () => {
    const { body, lines } = featureBody(rec([{ key: 'system.attributes.ac.bonus', type: 'add', value: 1 }]), 'defense', 'Defense', 'srd:defense/defense');
    expect(lines).toEqual([]);
    expect(body).toEqual({ effects: [{ id: 'defense', name: 'Defense', stats: [{ ac: 1, when: ['armored'] }] }], passive: { effects: ['defense'] } });
    // A feat record with activities: its effects may hang on them, so nothing maps.
    expect(featureBody(rec([{ key: 'system.attributes.ac.bonus', type: 'add', value: 1 }], { system: { activities: { a: { type: 'utility' } } } }), 'defense', 'Defense', 'srd:defense/defense').body).toEqual({});
  });

  it('readingProblems: a stat with no row, gates that differ from the row, and a row emitted without its reading all fail closed', () => {
    const items = new Map<string, Item>([
      ['srd:monk', { kind: 'class' }],
      ['srd:monk/unarmored-movement', { kind: 'feature', effects: [{ id: 'm', stats: [{ speed: 10 }] }] }],
      ['srd:x/y', { kind: 'feature', effects: [{ id: 'e', stats: [{ ac: 1 }] }] }],
    ]);
    const table = { 'srd:monk/unarmored-movement': PDF_READINGS['srd:monk/unarmored-movement']!, 'srd:monk/other': { owner: 'srd:monk', when: [], pdf: 'p.1' } };
    expect(readingProblems(items, table)).toEqual([
      'srd:monk/unarmored-movement: gates [], the PDF (p.51, srd-raw.txt:11139-11144) reads [unarmored,noShield]',
      'srd:x/y: a stat, condition immunity or gate with no PDF reading in PDF_READINGS',
      'srd:monk/other: in PDF_READINGS but not emitted',
    ]);
  });

  it('the committed pack carries exactly the PDF readings', () => {
    expect(readingProblems(ITEMS)).toEqual([]);
    expect(Object.keys(PDF_READINGS).sort()).toEqual([
      'srd:alert/alert', // coverage W1: the feat's feature, written from the PDF
      'srd:armor-plus-1', // step 6: simple magic items (map/magic-item.ts MAGIC_READINGS)
      'srd:armor-plus-2',
      'srd:armor-plus-3',
      'srd:barbarian/danger-sense',
      'srd:barbarian/fast-movement', // coverage W1: notHeavyArmor
      'srd:barbarian/rage', // coverage W1: Rage's effects (no gate)
      'srd:bracers-of-defense',
      'srd:champion/improved-critical',
      'srd:cloak-of-protection',
      'srd:defense/defense',
      'srd:elf/elven-lineage-wood-elf',
      'srd:monk/stunning-strike', // step 5a: rider effects, no gates
      'srd:monk/unarmored-movement',
      'srd:path-of-the-berserker/mindless-rage', // coverage W1: condition immunity under Rage
      'srd:ring-of-protection',
      'srd:rogue/steady-aim', // coverage W1: Speed 0 until the end of the turn
      'srd:shield-plus-1', // step 5b: itemHeld (map/magic-item.ts MAGIC_READINGS)
      'srd:shield-plus-2',
      'srd:shield-plus-3',
      'srd:stone-of-good-luck-luckstone',
      'srd:warrior-of-the-open-hand/open-hand-technique', // step 5a
      'srd:weapon-plus-1', // step 5b: magicWeapon
      'srd:weapon-plus-2',
      'srd:weapon-plus-3',
    ]);
  });
});

describe('the committed pack: what step 4 flips', () => {
  it('Unarmored Movement is a full passive speed stat from the Monk table column, gated unarmored and noShield', () => {
    const f = ITEMS.get('srd:monk/unarmored-movement')!;
    expect(f.fidelity).toBe('full');
    expect(f.unimplemented).toBeUndefined();
    expect(f.passive).toEqual({ effects: ['unarmored-movement'] });
    expect(f.effects).toEqual([{ id: 'unarmored-movement', name: 'Unarmored Movement', stats: [{ speed: '@scale.monk.unarmored-movement', when: ['unarmored', 'noShield'] }] }]);
    // The column it reads: +10 at 2, +15 at 6, +20 at 10 (cross-checked against the PDF table).
    expect((ITEMS.get('srd:monk')!.scale as Record<string, { at: Record<string, number> }>)['unarmored-movement']!.at).toMatchObject({ 2: 10, 6: 15, 10: 20 });
  });

  it('the Defense feat is data that grants its full feature (+1 AC while armored)', () => {
    const feat = ITEMS.get('srd:defense')!;
    expect([feat.fidelity, feat.features, feat.unimplemented]).toEqual(['full', ['srd:defense/defense'], undefined]);
    const f = ITEMS.get('srd:defense/defense')!;
    expect([f.fidelity, f.source, f.unimplemented]).toEqual(['full', 'SRD 5.2.1 p.88', undefined]);
    expect(f.effects).toEqual([{ id: 'defense', name: 'Defense', stats: [{ ac: 1, when: ['armored'] }] }]);
  });

  it('Danger Sense and Improved Critical are full; Fast Movement is full since coverage W1, gated notHeavyArmor', () => {
    expect(ITEMS.get('srd:barbarian/danger-sense')!.fidelity).toBe('full');
    expect(ITEMS.get('srd:champion/improved-critical')!.fidelity).toBe('full');
    const fm = ITEMS.get('srd:barbarian/fast-movement')!;
    expect([fm.fidelity, fm.unimplemented]).toEqual(['full', undefined]);
    expect(fm.effects).toEqual([{ id: 'fast-movement', name: 'Fast Movement', stats: [{ speed: 10, when: ['notHeavyArmor'] }] }]);
    expect(fm.passive).toEqual({ effects: ['fast-movement'] });
  });

  it('every full raise is a reviewed override with the PDF page, and leaves no line', () => {
    const raised = ['srd:monk/unarmored-movement', 'srd:barbarian/danger-sense', 'srd:champion/improved-critical', 'srd:defense/defense'];
    const pages: Record<string, number> = { 'srd:monk/unarmored-movement': 51, 'srd:barbarian/danger-sense': 29, 'srd:champion/improved-critical': 49, 'srd:defense/defense': 88 };
    for (const id of raised) {
      const p = ITEMS.get(id)!.provenance as Item;
      expect([id, p.review, p.pdfPage, Array.isArray(p.overrides)]).toEqual([id, 'reviewed', pages[id], true]);
      expect(PDF_READINGS[id]!.pdf.startsWith(`p.${pages[id]},`)).toBe(true);
    }
    // No feature is full from the importer alone (C7): every full feature came through an
    // override, reviewed with its PDF page (step 5a's raises are checked in step5a-monk.test.ts).
    const step5a = ['srd:monk/empowered-strikes', 'srd:monk/stunning-strike', 'srd:monk/uncanny-metabolism', 'srd:warrior-of-the-open-hand/open-hand-technique'];
    // Step 6's simple magic items (C9b): Armor, +1/+2/+3, raised in step6-monsters.test.ts.
    step5a.push('srd:armor-plus-1', 'srd:armor-plus-2', 'srd:armor-plus-3');
    // Step 6 integration: Second Wind through target: self (step5a-monk.test.ts checks its program).
    step5a.push('srd:fighter/second-wind');
    // After step 6: Wholeness of Body through target: self (step5a-monk.test.ts checks its program).
    step5a.push('srd:warrior-of-the-open-hand/wholeness-of-body');
    // Step 5b: Shield, +1/+2/+3 (itemHeld) and Weapon, +1/+2/+3 (magicWeapon), raised in step5b-weapons.test.ts.
    for (const n of [1, 2, 3]) step5a.push(`srd:shield-plus-${n}`, `srd:weapon-plus-${n}`);
    // Coverage step 7.5: Aura of Protection, a passive Emanation (engine test aura-emanation.test.ts).
    step5a.push('srd:paladin/aura-of-protection');
    // Coverage W1: the full ones of section 3 (w1-overrides.test.ts checks each override).
    step5a.push(
      'srd:barbarian/fast-movement',
      'srd:barbarian/rage',
      'srd:barbarian/reckless-attack',
      'srd:gnome/gnomish-cunning',
      'srd:orc/adrenaline-rush',
      'srd:orc/relentless-endurance',
      'srd:path-of-the-berserker/mindless-rage',
      'srd:rogue/sneak-attack',
      'srd:rogue/steady-aim',
      'srd:rogue/uncanny-dodge',
    );
    for (const [id, it] of ITEMS) {
      if (it.kind !== 'feature' || it.fidelity !== 'full') continue;
      // Coverage C0's T relabel (mechanizedBy, the class table's features) is checked in c0-coverage.test.ts.
      if (it.mechanizedBy !== undefined) continue;
      expect([...raised, ...step5a], id).toContain(id);
      const p = it.provenance as Item;
      expect([id, p.review, typeof p.pdfPage, Array.isArray(p.overrides)]).toEqual([id, 'reviewed', 'number', true]);
    }
  });

  it('the Wood Elf\'s "Your Speed increases to 35 feet" (p.84) is a +5 speed stat over the Elf\'s 30; the trait stays partial for its spells', () => {
    const f = ITEMS.get('srd:elf/elven-lineage-wood-elf')!;
    expect(ITEMS.get('srd:elf')!.speed).toBe(30);
    expect(f.effects).toEqual([{ id: 'wood-elf-speed', name: 'Wood Elf Speed', stats: [{ speed: 5 }] }]);
    expect([f.fidelity, f.unimplemented]).toEqual(['partial', ['grants spells (spells are imported at step 6)']]);
  });

  it('"Advantage on saving throws ... to avoid or end the Poisoned / Charmed condition" (p.84) has no primitive and says so', () => {
    expect(ITEMS.get('srd:dwarf/dwarven-resilience')!.unimplemented).toContain('advantage on saves against the poisoned condition not modeled');
    expect(ITEMS.get('srd:elf/fey-ancestry')!.unimplemented).toEqual(['advantage on saves against the charmed condition not modeled']);
    expect(isTemplateLine(U.conditionSaveAdvantage('poisoned'))).toBe(true);
    expect(() => U.conditionSaveAdvantage('Poisoned condition, and more')).toThrow(/not a id token/);
  });

  it('every committed override parses, and a full override clears every line (full means zero lines)', () => {
    for (const ov of loadOverrides()) {
      if (ov.body.fidelity === 'full') expect(ov.body.unimplemented ?? null, ov.file).toBeNull(); // a replace: true item simply has none
    }
    const ov = parseOverride('feature/x/y.yaml', 'fidelity: full\nprovenance: { review: reviewed, pdfPage: 1 }\n', 'f');
    const item = { kind: 'feature', id: 'srd:x/y', name: 'Y', fidelity: 'partial', unimplemented: ['effect key system.attributes.movement.walk (add)'], provenance: { source: 'foundry-dnd5e', review: 'auto' } };
    expect(() => applyOverride(item, ov, { commit: 'c', importer: 1, recordAt: () => undefined })).toThrow(/is full but still lists 1 unimplemented line/);
  });
});
