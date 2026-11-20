// Coverage W1 (docs/design/w1-plan.md section 3): the reviewed overrides for Rage, Reckless Attack,
// Frenzy, Mindless Rage, Fast Movement, Sneak Attack, Cunning Action, Steady Aim, Cunning Strike,
// Uncanny Dodge, Tactical Shift, Alert, Gnomish Cunning, the Goliath's Giant Ancestry and Stone's
// Endurance, Adrenaline Rush and Relentless Endurance. Each override's provenance and cite, its
// fidelity and lines, its program, and that the pack it produces loads and compiles: every override
// is applied to the committed generated item exactly as the importer applies it (overrides.ts
// applyOverride), so this holds before W1.2 regenerates the pack and after. The curated characters
// built on that pack get the riders, activations and hooks section 3 names. Committed files only;
// no cache, no home dir. (The engine behaviour behind each field is tested in packages/engine.)

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { loadContent } from '../../../packages/engine/src/content/load.ts';
import type { CompiledTemplate, Step } from '../../../packages/engine/src/content/types.ts';
import { formatDiag } from '../../../packages/engine/src/content/yaml.ts';
import { bindExpr, formatExpr, parseExpr } from '../../../packages/engine/src/dice/expr.ts';
import { FLAG_INFO } from '../../../packages/engine/src/rules/flags.ts';
import { smokePackFiles } from '../../smoke-classes.ts';
import { smokeCorpus, smokeSpells } from '../../smoke-corpus.ts';
import { renderItem } from '../emit.ts';
import { applyOverride, loadOverrides, type Override } from '../overrides.ts';
import { PDF_READINGS, readingProblems } from '../pdf-gates.ts';
import { isTemplateLine } from '../unimplemented.ts';
import { REPO_ROOT } from '../util.ts';

type Item = Record<string, unknown>;

/** Section 3's items: kind, fidelity after W1 (null: the item's own, unchanged), PDF page, the srd-raw.txt lines its header cites. */
const W1: readonly { id: string; kind: Override['kind']; fidelity: 'full' | 'partial' | null; page: number; cite: string }[] = [
  { id: 'srd:barbarian/rage', kind: 'feature', fidelity: 'full', page: 28, cite: 'srd-raw.txt:4697-4702, 4970-4994' },
  { id: 'srd:barbarian/reckless-attack', kind: 'feature', fidelity: 'full', page: 29, cite: 'srd-raw.txt:5018-5029' },
  { id: 'srd:barbarian/fast-movement', kind: 'feature', fidelity: 'full', page: 29, cite: 'srd-raw.txt:5065-5068' },
  { id: 'srd:path-of-the-berserker/frenzy', kind: 'feature', fidelity: 'partial', page: 30, cite: 'srd-raw.txt:5171-5178' },
  { id: 'srd:path-of-the-berserker/mindless-rage', kind: 'feature', fidelity: 'full', page: 30, cite: 'srd-raw.txt:5180-5184' },
  { id: 'srd:rogue/sneak-attack', kind: 'feature', fidelity: 'full', page: 61, cite: 'srd-raw.txt:13564-13567, 13738-13746' },
  { id: 'srd:rogue/cunning-action', kind: 'feature', fidelity: 'partial', page: 62, cite: 'srd-raw.txt:13773-13777' },
  { id: 'srd:rogue/steady-aim', kind: 'feature', fidelity: 'partial', page: 62, cite: 'srd-raw.txt:13788-13794' },
  { id: 'srd:rogue/cunning-strike', kind: 'feature', fidelity: 'partial', page: 63, cite: 'srd-raw.txt:13809-13836' },
  { id: 'srd:rogue/uncanny-dodge', kind: 'feature', fidelity: 'partial', page: 63, cite: 'srd-raw.txt:13838-13841' },
  { id: 'srd:fighter/tactical-shift', kind: 'feature', fidelity: 'partial', page: 48, cite: 'srd-raw.txt:10659-10663' },
  { id: 'srd:alert', kind: 'feat', fidelity: 'partial', page: 87, cite: 'srd-raw.txt:20027-20036' },
  { id: 'srd:alert/alert', kind: 'feature', fidelity: 'partial', page: 87, cite: 'srd-raw.txt:20027-20036' },
  { id: 'srd:gnome/gnomish-cunning', kind: 'feature', fidelity: 'full', page: 85, cite: 'srd-raw.txt:19800' },
  { id: 'srd:goliath', kind: 'species', fidelity: null, page: 85, cite: 'srd-raw.txt:19841-19845' },
  { id: 'srd:goliath/stones-endurance', kind: 'feature', fidelity: 'partial', page: 85, cite: 'srd-raw.txt:19861-19864' },
  { id: 'srd:orc', kind: 'species', fidelity: null, page: 86, cite: 'srd-raw.txt:19919-19930' },
  { id: 'srd:orc/adrenaline-rush', kind: 'feature', fidelity: 'full', page: 86, cite: 'srd-raw.txt:19920-19925' },
  { id: 'srd:orc/relentless-endurance', kind: 'feature', fidelity: 'full', page: 86, cite: 'srd-raw.txt:19928-19931' },
];

const PACK = join(REPO_ROOT, 'packs/srd-5.2.1');
const COMMITTED = (() => {
  const out = new Map<string, { item: Item; rel: string }>();
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(p, r);
      else if (e.name.endsWith('.yaml') && e.name !== 'manifest.yaml') {
        const d = parse(readFileSync(p, 'utf8')) as Item;
        out.set(d.id as string, { item: d, rel: r });
      }
    }
  };
  walk(PACK, 'packs/srd-5.2.1');
  return out;
})();
const OVERRIDES = new Map(loadOverrides().map((o) => [o.id, o]));

/** A record's provenance as the importer recorded it, for a replace override that names it (foundryPath). */
const recordAt = (path: string) => {
  for (const { item } of COMMITTED.values()) {
    const p = item.provenance as Item;
    if (p.path === path && typeof p.foreignId === 'string' && typeof p.recordSha256 === 'string') return { path, foreignId: p.foreignId, sha256: p.recordSha256 };
    const rep = p.replaces as Item | undefined;
    if (rep?.path === path) return { path, foreignId: rep.foreignId as string, sha256: rep.recordSha256 as string };
  }
  return undefined;
};

/** Each W1 item as the importer will emit it: its override applied to the committed item (or, for a new one, alone). */
const PLANNED = new Map(
  W1.map(({ id }) => {
    const ov = OVERRIDES.get(id)!;
    const cur = COMMITTED.get(id)?.item;
    // A committed item that came from this override already (after W1.2) carries its provenance.overrides; drop it so the result is the same.
    const base = cur ? { ...cur, provenance: { ...(cur.provenance as Item), overrides: undefined } } : undefined;
    return [id, applyOverride(base, ov, { commit: '0'.repeat(40), importer: 1, recordAt })];
  }),
);

/**
 * The pack the importer will write, in memory: the W1 items in place of their committed files, plus
 * the curated smoke corpus on it (and an Orc Barbarian, since no curated build is an Orc).
 */
const WORLD = (() => {
  const pathOf = (id: string) => COMMITTED.get(id)?.rel ?? `packs/srd-5.2.1/features/${id.slice(4)}.yaml`;
  const planned = new Map([...PLANNED].map(([id, it]) => [pathOf(id), renderItem(it)]));
  const files = smokePackFiles(REPO_ROOT).map((f) => (planned.has(f.path) ? { path: f.path, text: planned.get(f.path)! } : f));
  for (const [path, text] of planned) if (!files.some((f) => f.path === path)) files.push({ path, text });
  const corpus = smokeCorpus(files, smokeSpells(readFileSync(join(REPO_ROOT, 'tools', 'import-srd', 'srd-index.json'), 'utf8')));
  const barb = corpus.find((c) => c.id === 'test:smoke-barbarian-3')!.text;
  const orc = barb
    .replace('id: test:smoke-barbarian-3', 'id: test:w1-orc-barbarian-3')
    .replace('species: srd:goliath', 'species: srd:orc')
    .replace(/^ {2}srd:goliath#giant-ancestry: .*\n/m, '');
  const all = [...files, ...corpus.map((c) => ({ path: c.path, text: c.text })), { path: 'packs/test/characters/w1-orc-barbarian-3.yaml', text: orc }];
  const r = loadContent(all);
  return { r, items: new Map<string, Item>([...[...COMMITTED].map(([id, v]): [string, Item] => [id, v.item]), ...PLANNED]) };
})();
const tpl = (id: string): CompiledTemplate => {
  const t = WORLD.r.content?.get(id);
  if (!t) throw new Error(`${id} didn't compile: ${WORLD.r.errors.slice(0, 5).map(formatDiag).join('; ')}`);
  return t;
};
const feature = (t: CompiledTemplate, id: string) => t.features.find((f) => f.id === id);
const kinds = (steps: readonly Step[]) => steps.map((s) => s.k);
const riderOf = (t: CompiledTemplate, featureId: string, local: string) => {
  const i = (t.riders ?? []).findIndex((r) => r.local === local && t.features[r.feature]!.id === featureId);
  return i < 0 ? null : { i, r: t.riders![i]! };
};
const effectId = (t: CompiledTemplate, fx: number) => t.effects[fx]!.id;
const planned = (id: string) => PLANNED.get(id)!;

describe('W1 overrides: each is a reviewed change with its PDF page and srd-raw.txt cite', () => {
  it('every section 3 item has an override in the kind folder of its id, and nothing else in W1\'s folders is unaccounted for', () => {
    for (const w of W1) {
      const ov = OVERRIDES.get(w.id);
      expect(ov, w.id).toBeDefined();
      expect(ov!.kind, w.id).toBe(w.kind);
    }
    // Archery, Roving, Divine Spark, Tireless, Colossus Slayer and the other Giant Ancestry options wait for W1b (w1-plan.md 11).
    for (const id of ['srd:archery/archery', 'srd:ranger/roving', 'srd:cleric/channel-divinity-cleric', 'srd:ranger/tireless', 'srd:hunter/hunters-prey', 'srd:goliath/fires-burn', 'srd:goliath/hills-tumble']) expect(OVERRIDES.has(id), id).toBe(false);
  });

  it('provenance is review: reviewed with the item\'s PDF page, and the header cites that page and the srd-raw.txt lines', () => {
    for (const w of W1) {
      const ov = OVERRIDES.get(w.id)!;
      const text = readFileSync(join(REPO_ROOT, ov.file), 'utf8');
      expect(ov.body.provenance, w.id).toEqual({ review: 'reviewed', pdfPage: w.page });
      const header = text.split('\n').filter((l) => l.startsWith('#')).join(' ');
      expect(header, w.id).toMatch(new RegExp(`SRD 5\\.2\\.1 p\\.${w.page}\\b`));
      expect(header.replace(/\s*#\s*/g, ' '), w.id).toContain(`(${w.cite.split(', ')[0]}`);
      for (const part of w.cite.slice('srd-raw.txt:'.length).split(', ')) expect(header, `${w.id} cites ${part}`).toContain(part);
      expect(header, w.id).toContain('w1-plan.md');
      // The PDF index's page for the item (the importer's own) is the page the review read.
      const cur = COMMITTED.get(w.id === 'srd:alert/alert' ? 'srd:alert' : w.id)!.item.provenance as Item;
      expect(cur.pdfPage, w.id).toBe(w.page);
    }
  });

  it('full clears every line; partial keeps at least one, each a closed template line (C5)', () => {
    for (const w of W1) {
      const it = planned(w.id);
      if (w.fidelity === null) continue;
      expect(it.fidelity, w.id).toBe(w.fidelity);
      if (w.fidelity === 'full') expect(it.unimplemented, w.id).toBeUndefined();
      else {
        const lines = it.unimplemented as string[];
        expect(lines.length, w.id).toBeGreaterThan(0);
        for (const l of lines) expect(isTemplateLine(l), `${w.id}: ${l}`).toBe(true);
      }
    }
  });

  it('the features on an unverified flag\'s path stay partial and say so (C7): Frenzy (frenzyRageCheck), Tactical Shift and Cunning Strike (freeMoveUsesMovement)', () => {
    expect(FLAG_INFO.frenzyRageCheck.verified).toBe(false);
    expect(FLAG_INFO.freeMoveUsesMovement.verified).toBe(false);
    expect(planned('srd:path-of-the-berserker/frenzy').unimplemented).toEqual(['part frenzy-rage-check-unverified not modeled']);
    expect(planned('srd:fighter/tactical-shift').unimplemented).toEqual(['part free-move-budget-unverified not modeled']);
    expect(planned('srd:rogue/cunning-strike').unimplemented).toEqual(['part free-move-budget-unverified not modeled', 'part poison not modeled', 'part trip not modeled']);
    expect(planned('srd:goliath/stones-endurance').unimplemented).toEqual(['part non-attack-damage not modeled']); // D2
    expect(planned('srd:rogue/cunning-action').unimplemented).toEqual(['part hide not modeled']);
    expect(planned('srd:alert/alert').unimplemented).toEqual(['part initiative-swap not modeled']);
  });

  it('Uncanny Dodge (per-type halving [U], reduceBeforeResistance) and Steady Aim (nextRollRiderConsumedWhenRedundant) stay partial and name what is on their path (C7)', () => {
    // Uncanny Dodge halves "the attack's damage" once (13840-13841); the engine's reduce: halve halves
    // per damage type (sim/damage.ts cutTypes) [U], and every cut reads reduceBeforeResistance.
    expect(FLAG_INFO.reduceBeforeResistance.verified).toBe(false);
    const ud = planned('srd:rogue/uncanny-dodge');
    expect(ud.fidelity).toBe('partial');
    expect(ud.unimplemented).toEqual(['part halve-per-type-unverified not modeled', 'part reduce-before-resistance-unverified not modeled']);
    // Steady Aim's Advantage is a consume-nextRoll rider: spent or kept on a redundant roll per the flag.
    expect(FLAG_INFO.nextRollRiderConsumedWhenRedundant.verified).toBe(false);
    const sa = planned('srd:rogue/steady-aim');
    expect(sa.fidelity).toBe('partial');
    expect(sa.unimplemented).toEqual(['part next-roll-rider-consumed-when-redundant not modeled']);
    for (const id of ['srd:rogue/uncanny-dodge', 'srd:rogue/steady-aim']) {
      const header = readFileSync(join(REPO_ROOT, OVERRIDES.get(id)!.file), 'utf8').split('\n').filter((l) => l.startsWith('#')).join(' ');
      expect(header, id).toMatch(id.endsWith('uncanny-dodge') ? /reduceBeforeResistance[\s\S]*\[U\]|\[U\][\s\S]*reduceBeforeResistance/ : /nextRollRiderConsumedWhenRedundant/);
    }
  });

  it('the PDF readings cover the planned items exactly (stats, gates, condition immunities)', () => {
    expect(PDF_READINGS['srd:barbarian/fast-movement']!.when).toEqual(['notHeavyArmor']);
    for (const id of ['srd:barbarian/rage', 'srd:path-of-the-berserker/mindless-rage', 'srd:rogue/steady-aim', 'srd:alert/alert']) expect(PDF_READINGS[id]!.when, id).toEqual([]);
    // Fast Movement's stat comes from the importer's own mapping under its reading, so only the rest is checked here.
    expect(readingProblems(WORLD.items).filter((p) => !p.startsWith('srd:barbarian/fast-movement:'))).toEqual([]);
  });
});

describe('W1 overrides: the programs section 3 names', () => {
  it('Rage: a bonus activation gated notHeavyArmor on the rage pool, rooted in a sustained Rage with its Bonus Action extension, the benefits as its child, and Rage Damage', () => {
    const it = planned('srd:barbarian/rage');
    expect(it.activate).toEqual({ id: 'rage', name: 'Rage', cost: 'bonus', uses: { pool: 'rage' }, when: ['notHeavyArmor'], target: 'self', root: 'raging', do: [{ apply: { effect: 'rage-benefits', to: 'self' } }] });
    const [raging, benefits] = it.effects as Item[];
    expect(raging).toMatchObject({ id: 'raging', duration: { until: 'endOfNextTurn', of: 'bearer' }, sustain: { by: ['attackRoll', 'enemySave'] }, endsOn: ['incapacitated'] });
    expect(raging!.grants).toEqual([{ id: 'extend', name: 'Extend Rage', cost: 'bonus', laterTurns: true, to: 'owner', do: [{ extendSource: true }] }]);
    expect(benefits!.duration).toBeUndefined(); // parent: it ends with the Rage
    expect(benefits!.stats).toEqual([{ resist: ['bludgeoning', 'piercing', 'slashing'] }, { noConcentration: true }, { noCasting: true }]);
    expect(benefits!.mods).toEqual([{ on: ['d20.check.str', 'd20.save.str'], op: 'adv' }]);
    expect(it.riders).toEqual([
      { id: 'rage-damage', name: 'Rage Damage', on: 'hit', filter: { attack: ['weapon', 'unarmed'], ability: 'str' }, auto: true, when: [{ selfHas: 'raging' }], do: [{ damage: [{ roll: '@scale.barbarian.rage-damage', type: 'weapon' }] }] },
    ]);
  });

  it('Reckless Attack, Frenzy and Mindless Rage: firstAttack, the augment armed by a qualified selfHas, the Frenzy rider, the Mindless Rage augment', () => {
    expect(planned('srd:barbarian/reckless-attack').firstAttack).toEqual({ do: [{ apply: { effect: 'reckless', to: 'self' } }] });
    expect((planned('srd:barbarian/reckless-attack').effects as Item[])[0]).toEqual({
      id: 'reckless',
      name: 'Reckless Attack',
      duration: { until: 'startOfNextTurn', of: 'bearer' },
      mods: [{ on: ['d20.attack.str'], op: 'adv' }, { on: ['d20.attack'], side: 'incoming', op: 'adv' }],
    });
    const fr = planned('srd:path-of-the-berserker/frenzy');
    expect(fr.augments).toEqual({ feature: 'srd:barbarian/reckless-attack', firstAttack: true, steps: [{ apply: { effect: 'armed', to: 'self', when: [{ selfHas: 'srd:barbarian/rage#raging' }] } }] });
    expect((fr.effects as Item[])[0]!.duration).toEqual({ until: 'endOfThisTurn', of: 'bearer' });
    expect((fr.riders as Item[])[0]).toMatchObject({ on: 'hit', oncePerTurn: 'ownTurn', auto: true, filter: { attack: ['weapon', 'unarmed'], ability: 'str' }, when: [{ selfHas: 'armed' }], do: [{ damage: [{ roll: '(@scale.barbarian.rage-damage)d6', type: 'weapon' }] }] });
    expect(planned('srd:path-of-the-berserker/mindless-rage').augments).toEqual({ feature: 'srd:barbarian/rage', steps: [{ apply: { effect: 'mindless', to: 'self' } }, { endConditions: ['charmed', 'frightened'] }] });
  });

  it('Sneak Attack: a non-automatic hit rider, once in any turn, Finesse or Ranged weapons, Advantage or an ally next to the target without Disadvantage, of the weapon\'s type', () => {
    expect(planned('srd:rogue/sneak-attack').riders).toEqual([
      {
        id: 'sneak-attack',
        name: 'Sneak Attack',
        on: 'hit',
        filter: { weaponProperty: ['finesse', 'ranged'] },
        oncePerTurn: 'global',
        when: [{ anyOf: [['rollAdv'], ['allyWithin5ftOfTarget', 'rollNotDis']] }],
        do: [{ damage: [{ roll: '@scale.rogue.sneak-attack', type: 'weapon' }] }],
      },
    ]);
  });

  it('Cunning Strike\'s Withdraw forgoes exactly one Sneak Attack die at every Rogue level (the class column), then moves half Speed without Opportunity Attacks', () => {
    const aug = planned('srd:rogue/cunning-strike').augments as Item;
    expect([aug.feature, aug.rider]).toEqual(['srd:rogue/sneak-attack', 'sneak-attack']);
    const [withdraw] = aug.options as Item[];
    const steps = withdraw!.do as Item[];
    expect(steps[1]).toEqual({ move: { speed: 'half', noOpportunityAttacks: true } });
    const dmg = (steps[0]!.damage as Item[])[0]!;
    expect(dmg.type).toBe('weapon');
    const col = ((COMMITTED.get('srd:rogue')!.item.scale as Item)['sneak-attack'] as { at: Record<string, string> }).at;
    const node = parseExpr(dmg.roll as string);
    let sneak = '';
    for (let level = 1; level <= 20; level++) {
      sneak = col[String(level)] ?? sneak;
      const n = Number(/^(\d+)d6$/.exec(sneak)![1]);
      expect(formatExpr(bindExpr(node, { classlevel: level })), `Rogue ${level}: ${sneak} less one die`).toBe(n === 1 ? '0' : `${n - 1}d6`);
    }
  });

  it('Steady Aim, Cunning Action, Uncanny Dodge, Tactical Shift', () => {
    const sa = planned('srd:rogue/steady-aim');
    expect(sa.activate).toEqual({ id: 'steady-aim', name: 'Steady Aim', cost: 'bonus', when: ['hasntMoved'], target: 'self', do: [{ apply: { effect: 'steady-aim', to: 'self' } }, { apply: { effect: 'steady-aim-anchored', to: 'self' } }] });
    expect((sa.effects as Item[]).map((e) => [e.id, e.duration, e.mods, e.stats])).toEqual([
      ['steady-aim', { until: 'endOfThisTurn', of: 'bearer' }, [{ on: ['d20.attack'], op: 'adv', consume: 'nextRoll' }], undefined],
      ['steady-aim-anchored', { until: 'endOfThisTurn', of: 'bearer' }, undefined, [{ speed: 'zero' }]],
    ]);
    expect((planned('srd:rogue/cunning-action').activate as Item[]).map((a) => [a.id, a.cost, a.do])).toEqual([
      ['dash', 'bonus', [{ core: 'dash' }]],
      ['disengage', 'bonus', [{ core: 'disengage' }]],
    ]);
    expect(planned('srd:rogue/uncanny-dodge').reaction).toEqual({ window: 'hitTaken', reduce: 'halve', sees: true });
    expect(planned('srd:fighter/tactical-shift').augments).toEqual({ feature: 'srd:fighter/second-wind', steps: [{ move: { speed: 'half', noOpportunityAttacks: true } }] });
  });

  it('Alert, Gnomish Cunning, the Goliath and the Orc', () => {
    expect(planned('srd:alert').features).toEqual(['srd:alert/alert']);
    const alert = planned('srd:alert/alert');
    expect([alert.effects, alert.passive]).toEqual([[{ id: 'alert', name: 'Alert (Initiative Proficiency)', mods: [{ on: ['d20.check.initiative'], op: 'flat', value: '@pb' }] }], { effects: ['alert'] }]);
    expect((alert.provenance as Item).source).toBe('srd-pdf'); // written from the PDF; the feat's record is named under replaces
    expect(((alert.provenance as Item).replaces as Item).path).toBe('packs/_source/feats24/origin-feats/alert.yml');
    expect(planned('srd:gnome/gnomish-cunning').effects).toEqual(COMMITTED.get('srd:gnome/gnomish-cunning')!.item.effects); // its mod was already exact
    expect(planned('srd:goliath').pools).toEqual([{ id: 'giant-ancestry', name: 'Giant Ancestry', max: '@pb', recharge: [{ period: 'long', amount: 'all' }] }]);
    expect(planned('srd:goliath/stones-endurance').reaction).toEqual({ window: 'hitTaken', reduce: '1d12 + @mod.con', pool: 'giant-ancestry' });
    expect(planned('srd:orc').pools).toEqual([
      { id: 'adrenaline-rush', name: 'Adrenaline Rush', max: '@pb', recharge: [{ period: 'short', amount: 'all' }, { period: 'long', amount: 'all' }] },
      { id: 'relentless-endurance', name: 'Relentless Endurance', max: 1, recharge: [{ period: 'long', amount: 'all' }] },
    ]);
    expect(planned('srd:orc/adrenaline-rush').activate).toEqual({ id: 'adrenaline-rush', name: 'Adrenaline Rush', cost: 'bonus', uses: { pool: 'adrenaline-rush' }, target: 'self', do: [{ core: 'dash' }, { tempHp: '@pb' }] });
    expect(planned('srd:orc/relentless-endurance').dropToOne).toEqual({ pool: 'relentless-endurance' });
  });
});

describe('W1 overrides: the pack they produce loads, and the curated characters compile with section 3\'s programs', () => {
  it('the whole pack plus the 60 curated characters and an Orc Barbarian load with no error', () => {
    expect(WORLD.r.errors.map(formatDiag)).toEqual([]);
  });

  it('the Barbarian: Rage (rooted, the extension grant on the root), its rider on Strength weapon and unarmed hits, Reckless from 2, Frenzy armed from 3, Mindless Rage from 6, Fast Movement from 5', () => {
    const b1 = tpl('test:smoke-barbarian-1');
    const rage = feature(b1, 'srd:barbarian/rage')!.activate!;
    expect([rage.cost, kinds(rage.steps), effectId(b1, rage.root), b1.pools[rage.pool - 9]!.local]).toEqual(['bonus', ['apply'], 'srd:barbarian/rage/raging', 'rage']);
    expect(b1.effects[rage.root]!.sustain).toBeGreaterThan(0);
    expect(b1.effects[rage.root]!.grants.map((g) => kinds(g.steps))).toEqual([['extendSource']]);
    const rd = riderOf(b1, 'srd:barbarian/rage', 'rage-damage')!;
    expect([rd.r.auto, rd.r.chooses, rd.r.once]).toEqual([true, false, undefined]);
    expect(rd.r.opts[0]!.extra!.map((d) => [formatExpr(d.roll), d.asAttack, d.type])).toEqual([['2', true, -1]]);
    for (const a of b1.attacks) expect((a.onHit ?? []).includes(rd.i), a.local).toBe(true); // Greataxe, Handaxe (thrown too: a Strength attack) and the Unarmed Strike
    expect(feature(b1, 'srd:barbarian/reckless-attack')).toBeUndefined();
    expect(feature(b1, 'srd:barbarian/fast-movement')).toBeUndefined();
    const b3 = tpl('test:smoke-barbarian-3');
    expect(kinds(feature(b3, 'srd:barbarian/reckless-attack')!.firstAttack!.steps)).toEqual(['apply', 'apply']); // reckless, then Frenzy's armed
    const armed = feature(b3, 'srd:barbarian/reckless-attack')!.firstAttack!.steps[1] as Extract<Step, { k: 'apply' }>;
    expect(effectId(b3, armed.fx)).toBe('srd:path-of-the-berserker/frenzy/armed');
    expect(armed.when).toEqual([{ g: 'selfHas', fx: feature(b3, 'srd:barbarian/rage')!.activate!.root }]);
    const fz = riderOf(b3, 'srd:path-of-the-berserker/frenzy', 'frenzy')!;
    expect([fz.r.once, fz.r.auto, formatExpr(fz.r.opts[0]!.extra![0]!.roll)]).toEqual(['ownTurn', true, '2d6']);
    expect(kinds(feature(tpl('test:smoke-barbarian-5'), 'srd:barbarian/rage')!.activate!.steps)).toEqual(['apply']);
    expect(kinds(feature(tpl('test:smoke-barbarian-6'), 'srd:barbarian/rage')!.activate!.steps)).toEqual(['apply', 'apply', 'endConditions']);
    expect(formatExpr(riderOf(tpl('test:smoke-barbarian-10'), 'srd:path-of-the-berserker/frenzy', 'frenzy')!.r.opts[0]!.extra![0]!.roll)).toBe('3d6'); // Rage Damage +3 at 9
  });

  it('the Goliath Barbarian\'s Stone\'s Endurance spends a giant-ancestry pool of PB uses', () => {
    for (const [level, pb] of [[1, 2], [5, 3], [10, 4]] as const) {
      const t = tpl(`test:smoke-barbarian-${level}`);
      const h = feature(t, 'srd:goliath/stones-endurance')!.hitTaken!;
      expect([t.pools[h.pool - 9]!.local, t.pools[h.pool - 9]!.max], `L${level}`).toEqual(['giant-ancestry', pb]);
      expect(h.reduce === 'halve' ? 'halve' : formatExpr(h.reduce), `L${level}`).toMatch(/^1d12 \+ \d$/);
    }
  });

  it('the Rogue: Sneak Attack on the Rapier and the Shortbow only, Cunning Action from 2, Steady Aim from 3, and at 5 Withdraw in the same decision and Uncanny Dodge', () => {
    const r1 = tpl('test:smoke-rogue-1');
    const sa = riderOf(r1, 'srd:rogue/sneak-attack', 'sneak-attack')!;
    expect([sa.r.once, sa.r.auto, sa.r.chooses, formatExpr(sa.r.opts[0]!.extra![0]!.roll)]).toEqual(['global', undefined, false, '1d6']);
    expect(r1.attacks.filter((a) => (a.onHit ?? []).includes(sa.i)).map((a) => a.local)).toEqual(['rapier', 'shortbow']);
    expect(feature(r1, 'srd:rogue/cunning-action')).toBeUndefined();
    expect(feature(tpl('test:smoke-rogue-3'), 'srd:rogue/cunning-action')!.more!.length + 1).toBe(2);
    const steady = feature(tpl('test:smoke-rogue-3'), 'srd:rogue/steady-aim')!.activate!;
    expect([steady.cost, steady.self, kinds(steady.steps), steady.when]).toEqual(['bonus', true, ['apply', 'apply'], [{ g: 'hasntMoved' }]]);
    const r5 = tpl('test:smoke-rogue-5');
    const sa5 = riderOf(r5, 'srd:rogue/sneak-attack', 'sneak-attack')!.r;
    expect([sa5.chooses, sa5.opts.map((o) => [o.local, formatExpr(o.extra![0]!.roll), kinds(o.steps)])]).toEqual([true, [['sneak-attack', '3d6', []], ['withdraw', '2d6', ['move']]]]);
    expect(feature(r5, 'srd:rogue/cunning-strike')).toBeUndefined(); // only an augment: no feature of its own
    expect(feature(r5, 'srd:rogue/uncanny-dodge')!.hitTaken).toMatchObject({ reduce: 'halve', sees: true });
    expect(feature(tpl('test:smoke-rogue-3'), 'srd:rogue/uncanny-dodge')).toBeUndefined();
  });

  it('the Fighter: Second Wind moves after the heal from 5 (Tactical Shift), not before', () => {
    expect(kinds(feature(tpl('test:smoke-fighter-3'), 'srd:fighter/second-wind')!.activate!.steps)).toEqual(['heal']);
    expect(kinds(feature(tpl('test:smoke-fighter-5'), 'srd:fighter/second-wind')!.activate!.steps)).toEqual(['heal', 'move']);
    expect(feature(tpl('test:smoke-fighter-5'), 'srd:fighter/tactical-shift')).toBeUndefined();
  });

  it('Alert gives its holders the Initiative feature (a Human Fighter by Versatile, a Criminal Rogue and Monk); Gnomish Cunning stays the Wizard\'s', () => {
    for (const id of ['test:smoke-fighter-1', 'test:smoke-rogue-1', 'test:smoke-monk-1', 'test:smoke-bard-1']) expect(feature(tpl(id), 'srd:alert/alert')?.passive?.length, id).toBe(1);
    for (const id of ['test:smoke-barbarian-1', 'test:smoke-wizard-1']) expect(feature(tpl(id), 'srd:alert/alert'), id).toBeUndefined();
    expect(feature(tpl('test:smoke-wizard-1'), 'srd:gnome/gnomish-cunning')!.passive!.length).toBe(1);
  });

  it('an Orc gets Adrenaline Rush (PB uses: Dash plus PB Temporary Hit Points) and Relentless Endurance (one use)', () => {
    const t = tpl('test:w1-orc-barbarian-3');
    const ar = feature(t, 'srd:orc/adrenaline-rush')!.activate!;
    expect([ar.cost, ar.self, kinds(ar.steps), t.pools[ar.pool - 9]!.local, t.pools[ar.pool - 9]!.max]).toEqual(['bonus', true, ['core', 'tempHp'], 'adrenaline-rush', 2]);
    const re = feature(t, 'srd:orc/relentless-endurance')!.dropToOne!;
    expect([t.pools[re.pool - 9]!.local, t.pools[re.pool - 9]!.max]).toEqual(['relentless-endurance', 1]);
  });
});
