// The shared character-building logic (packages/host/src/character-picks.ts): the CLI's
// `new character` and the browser's Character screen both list picks through it, so the skeleton
// the CLI writes and the web form's YAML carry the same picks block. Repo packs only
// (packs/srd-5.2.1 and packs/test); the CLI runs with an empty temporary home.
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SourceFile } from '@montecrit/engine';
import { REPO_ROOT } from '../../../apps/cli/src/files.ts';
import { runNewCharacter } from '../../../apps/cli/src/character.ts';
import { defaultForm, formToYaml } from '../../../apps/web/src/character/form.ts';
import { buildNeeds, characterLib, equipmentComment, masteryNeed, needLines, picksBlock, type Need } from '../src/index.ts';

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.ya?ml$/.test(e.name) ? [join(dir, e.name)] : []));
}
const PACKS: SourceFile[] = ['packs/srd-5.2.1', 'packs/test'].flatMap((d) => walk(join(REPO_ROOT, d))).map((p) => ({ path: `repo/${relative(REPO_ROOT, p)}`, text: readFileSync(p, 'utf8') }));
const LIB = characterLib(PACKS);
const cls = (id: string) => LIB.classes.get(id)!;

describe('characterLib', () => {
  it('does not depend on the order of the texts, and the first definition by path wins', () => {
    const rev = characterLib([...PACKS].reverse());
    expect([...rev.classes.keys()]).toEqual([...LIB.classes.keys()]);
    const two = characterLib([
      { path: 'b/x.yaml', text: 'kind: weapon\nid: test:w\nname: Second\n' },
      { path: 'a/x.yaml', text: 'kind: feature\nid: test:w\nname: First\n' },
    ]);
    expect(two.kinds.get('test:w')).toBe('feature');
  });
});

describe('buildNeeds and masteryNeed', () => {
  it('a Barbarian 5 has its Weapon Mastery pick (3 melee weapons) right after the class choices, then its ASI', () => {
    const needs = buildNeeds(LIB, cls('srd:barbarian'), undefined, undefined, undefined, 5);
    const keys = needs.map((n) => n.key);
    expect(keys).toEqual(['srd:barbarian#skills', 'srd:barbarian#skills-3', 'srd:barbarian#weapon-mastery', 'srd:barbarian#asi-4']);
    const m = masteryNeed(LIB, cls('srd:barbarian'), 5)!;
    expect(m.choose).toBe(3);
    expect(m.options.every((o) => LIB.weapons.get(o.id)?.attack === 'melee')).toBe(true);
    expect(m.where).toBe('Barbarian level 1 (Weapon Mastery)');
  });
  it('a class with no Weapon Mastery has none', () => {
    expect(masteryNeed(LIB, cls('srd:wizard'), 10)).toBeNull();
  });
});

describe('picksBlock', () => {
  const choice: Need = { key: 'test:c#skills', where: 'Test level 1', kind: 'choice', choose: 1, what: 'skills', options: [{ id: 'athletics', name: null }, { id: 'test:f', name: 'Feat F' }] };
  it('no needs: an empty block that loads', () => {
    expect(picksBlock([])).toEqual(['picks: {}  # this build asks for no picks']);
  });
  it('nothing filled: one comment block; the CLI style leaves bare examples, the web style comments them again', () => {
    expect(picksBlock([choice])).toEqual([
      '# picks: fill in every list and uncomment this block (montecrit build shows what is still missing)',
      '# picks:',
      '#   # Test level 1: choose 1 (skills) from athletics, test:f (Feat F)',
      '#   test:c#skills: []',
    ]);
    expect(picksBlock([choice], new Map(), { hint: 'hint', bare: false })).toEqual(['# picks: hint', '# picks:', '#   # Test level 1: choose 1 (skills) from athletics, test:f (Feat F)', '#   # test:c#skills: []']);
  });
  it('something filled: a real block, the rest commented inside it', () => {
    const other: Need = { ...choice, key: 'test:c#other' };
    expect(picksBlock([choice, other], new Map([['test:c#skills', '[athletics]']]))).toEqual(['picks:', ...needLines(choice, '[athletics]'), ...needLines(other, null)]);
    expect(needLines(other, null).at(-1)).toBe('  # test:c#other: []');
  });
});

describe('the CLI skeleton and the web form share the block', () => {
  it('montecrit new character writes picksBlock and equipmentComment for a Monk 6', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'dnd-picks-')), 'monk.yaml');
    const r = runNewCharacter(['character', '--class', 'srd:monk', '--level', '6', '--subclass', 'srd:warrior-of-the-open-hand', '--species', 'srd:dwarf', '--background', 'srd:soldier', '--out', out], { MONTECRIT_HOME: mkdtempSync(join(tmpdir(), 'dnd-home-')) });
    expect(r.code).toBe(0);
    const text = readFileSync(out, 'utf8');
    const needs = buildNeeds(LIB, cls('srd:monk'), LIB.subclasses.get('srd:warrior-of-the-open-hand'), LIB.species.get('srd:dwarf'), LIB.backgrounds.get('srd:soldier'), 6);
    expect(text).toContain(`\n${picksBlock(needs).join('\n')}\n`);
    expect(text).toContain(`\n${equipmentComment(LIB, cls('srd:monk')).join('\n')}\n`);
  });
  it('the web form with nothing picked writes the same needs in its own style', () => {
    const form = { ...defaultForm(LIB, 'test:x'), cls: 'srd:barbarian', level: 5, species: 'srd:human', background: 'srd:soldier' };
    const needs = buildNeeds(LIB, cls('srd:barbarian'), undefined, LIB.species.get('srd:human'), LIB.backgrounds.get('srd:soldier'), 5);
    const yaml = formToYaml(LIB, form);
    expect(yaml).toContain(`\n${picksBlock(needs, new Map(), { hint: 'choose them in the form (an empty picks: block would not load)', bare: false }).join('\n')}\n`);
    expect(yaml).toContain(`\n${equipmentComment(LIB, cls('srd:barbarian')).join('\n')}\n`);
  });
});
