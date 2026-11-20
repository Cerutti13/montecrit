// The Character screen's pure logic (apps/web/src/character/): the CharacterLib assembled from the
// bundled pack texts, the live check's stages and result shape, the pick form's YAML and the
// download name. Repo packs only (packs/srd-5.2.1 and packs/test).
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderSheet, type SourceFile } from '@montecrit/engine';
import { characterLib, buildNeeds } from '../src/character/lib.ts';
import { checkCharacter, compileCheck, downloadName, listCharacters, packDirs, DRAFT_FILE } from '../src/character/validate.ts';
import { defaultForm, formNeeds, formOptions, formToYaml, pickValue, LEVELS, type CharacterForm } from '../src/character/form.ts';

const ROOT = join(import.meta.dirname, '../../..');
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.ya?ml$/.test(e.name) ? [join(dir, e.name)] : []));
}
const PACKS: SourceFile[] = ['packs/srd-5.2.1', 'packs/test'].flatMap((d) => walk(join(ROOT, d))).map((p) => ({ path: `repo/${relative(ROOT, p)}`, text: readFileSync(p, 'utf8') }));
const LIB = characterLib(PACKS);
const MONK_PATH = 'repo/packs/test/characters/sample-monk.yaml';
const MONK = PACKS.find((f) => f.path === MONK_PATH)!.text;

describe('characterLib', () => {
  it('holds the SRD classes, subclasses, species, backgrounds, feats, weapons and armor, parsed with defaults', () => {
    expect(LIB.classes.get('srd:monk')?.name).toBe('Monk');
    expect(LIB.subclasses.get('srd:warrior-of-the-open-hand')?.parent).toBe('srd:monk');
    expect(LIB.species.has('srd:dwarf')).toBe(true);
    expect(LIB.backgrounds.has('srd:soldier')).toBe(true);
    expect(LIB.weapons.has('srd:shortsword')).toBe(true);
    expect(LIB.classes.size).toBe(12);
    expect(LIB.kinds.get('test:sample-monk')).toBe('character');
  });
  it('lists the same picks the CLI lists for the sample Monk 6', () => {
    const needs = buildNeeds(LIB, LIB.classes.get('srd:monk')!, LIB.subclasses.get('srd:warrior-of-the-open-hand'), LIB.species.get('srd:dwarf'), LIB.backgrounds.get('srd:soldier'), 6);
    const keys = needs.map((n) => n.key);
    expect(keys).toContain('srd:monk#skills');
    expect(keys).toContain('srd:monk#asi-4');
    expect(keys).toContain('srd:soldier#abilities');
    expect(keys.indexOf('srd:monk#skills')).toBeLessThan(keys.indexOf('srd:monk#asi-4'));
  });
  it('skips files that are not YAML, manifests and items that do not parse', () => {
    const lib = characterLib([
      { path: 'x/manifest.yaml', text: 'kind: manifest\n' },
      { path: 'x/notes.md', text: 'kind: class\nid: test:nope\n' },
      { path: 'x/bad.yaml', text: 'kind: class\nid: test:broken\n' },
    ]);
    expect(lib.classes.size).toBe(0);
    expect(lib.kinds.get('test:broken')).toBe('class');
  });
});

describe('listCharacters', () => {
  it('lists characters before pcs, marks home files', () => {
    const list = listCharacters([...PACKS, { path: 'home/characters/x.yaml', text: 'kind: character\nid: test:home-one\nname: Home One\n' }]);
    expect(list.find((c) => c.id === 'test:sample-monk')).toMatchObject({ kind: 'character', origin: 'repo', name: 'Sample Monk', path: MONK_PATH });
    expect(list.find((c) => c.id === 'test:home-one')?.origin).toBe('home');
    const firstPc = list.findIndex((c) => c.kind === 'pc');
    expect(firstPc === -1 || list.slice(firstPc).every((c) => c.kind === 'pc')).toBe(true);
  });
});

describe('checkCharacter', () => {
  it('passes the sample Monk: no schema issues, a derived sheet with sources and fidelity', () => {
    const r = checkCharacter(MONK, LIB, MONK_PATH);
    expect(r.kind).toBe('character');
    expect(r.id).toBe('test:sample-monk');
    expect(r.yaml).toEqual([]);
    expect(r.schema).toEqual([]);
    expect(r.lint.filter((i) => i.severity === 'error')).toEqual([]);
    expect(r.sheet?.hpMax.value).toBe(51);
    expect(r.sheet?.ac.value).toBe(16);
    expect(r.sheet?.hpMax.why).not.toBe('');
    expect(r.sheet?.features.every((f) => ['full', 'partial', 'narrative', 'missing'].includes(f.fidelity))).toBe(true);
    expect(renderSheet(r.sheet!)).toMatch(/^Sample Monk \(test:sample-monk\)/);
  });
  it('reports a YAML error with its line', () => {
    const r = checkCharacter('kind: character\nid: [unclosed\n', LIB);
    expect(r.yaml.length).toBeGreaterThan(0);
    expect(r.yaml[0]!.line).toBeGreaterThan(0);
    expect(r.sheet).toBeNull();
  });
  it('reports zod issues with their paths and lines, unknown keys at the key', () => {
    const text = MONK.replace('hp: average', 'hp: lots').replace('casting: []', 'casting: []\nmystery: 1');
    const r = checkCharacter(text, LIB);
    const hp = r.schema.find((i) => i.path === 'hp');
    expect(hp?.line).toBe(text.split('\n').findIndex((l) => l.startsWith('hp:')) + 1);
    const unk = r.schema.find((i) => i.path === 'mystery');
    expect(unk?.message).toBe('unknown key "mystery"');
    expect(unk?.line).toBe(text.split('\n').findIndex((l) => l.startsWith('mystery:')) + 1);
    expect(r.sheet).toBeNull();
  });
  it('reports the character lint with paths when a pick is illegal', () => {
    const text = MONK.replace('[acrobatics, insight]', '[acrobatics, arcana]');
    const r = checkCharacter(text, LIB);
    expect(r.schema).toEqual([]);
    const bad = r.lint.find((i) => i.path.startsWith('picks'));
    expect(bad).toBeDefined();
    expect(bad!.line).toBeGreaterThan(0);
  });
  it('names a wrong kind and validates a kind: pc with its own schema', () => {
    expect(checkCharacter('kind: monster\nid: test:x\n', LIB).schema[0]!.message).toMatch(/expected kind: character/);
    const pc = listCharacters(PACKS).find((c) => c.kind === 'pc');
    if (pc) {
      const r = checkCharacter(pc.text, LIB, pc.path);
      expect(r.kind).toBe('pc');
      expect(r.schema).toEqual([]);
      expect(r.sheet).toBeNull();
    }
  });
  it('flags private text', () => {
    expect(checkCharacter(`kind: character\nid: ${'priv' + 'ate'}:x\n`, LIB).privateText).toBe(true);
    expect(checkCharacter(MONK, LIB).privateText).toBe(false);
  });
});

describe('compileCheck', () => {
  it('loads the edited file in place: no new issues, the compiled sheet', () => {
    const r = checkCharacter(MONK, LIB, MONK_PATH);
    const c = compileCheck(MONK, r.id, PACKS, MONK_PATH, r.lint);
    expect(c.skipped).toBeNull();
    expect(c.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(c.elsewhere).toBe(0);
    expect(c.sheet?.id).toBe('test:sample-monk');
  });
  it('drops a draft into the pack of its namespace and reports what only the load finds', () => {
    expect(packDirs(PACKS).get('test')).toBe('repo/packs/test');
    const dup = compileCheck(MONK, 'test:sample-monk', PACKS, null, []);
    expect(dup.path).toBe(`repo/packs/test/characters/${DRAFT_FILE}`);
    expect(dup.issues.some((i) => /duplicate id/.test(i.message))).toBe(true);
    const skip = compileCheck(MONK, 'nowhere:x', PACKS, null, []);
    expect(skip.skipped).toMatch(/no loaded pack has the namespace nowhere:/);
  });
});

describe('the pick form', () => {
  const base = (over: Partial<CharacterForm>): CharacterForm => ({ ...defaultForm(LIB, 'test:form-monk'), cls: 'srd:monk', species: 'srd:dwarf', background: 'srd:soldier', ...over });
  it('offers levels 1..MODELED_MAX_LEVEL and the subclass only from its level', () => {
    expect(LEVELS[0]).toBe(1);
    expect(LEVELS[LEVELS.length - 1]).toBe(10);
    expect(formOptions(LIB, { cls: 'srd:monk', level: 2, species: '' }).subclassOpen).toBe(false);
    const o = formOptions(LIB, { cls: 'srd:monk', level: 3, species: '' });
    expect(o.subclassOpen).toBe(true);
    expect(o.subclasses.map((s) => s.id)).toContain('srd:warrior-of-the-open-hand');
  });
  it('writes a skeleton whose unanswered picks are commented, and which loads', () => {
    const text = formToYaml(LIB, base({ level: 1 }));
    expect(text).toMatch(/^# picks:$/m);
    const r = checkCharacter(text, LIB);
    expect(r.schema).toEqual([]);
    expect(r.sheet).not.toBeNull();
  });
  it('fills picks chosen in the form, and the sample Monk 6 build matches the sample file', () => {
    const form = base({
      level: 6,
      subclass: 'srd:warrior-of-the-open-hand',
      abilities: { str: 10, dex: 16, con: 14, int: 10, wis: 16, cha: 8 },
      picks: {
        'srd:monk#skills': ['acrobatics', 'insight'],
        'srd:monk#asi-4': { mode: 'oneone', a: 'wis', b: 'dex', feat: '' },
        'srd:soldier#abilities': { mode: 'two', a: 'dex', b: 'con', feat: '' },
        'srd:soldier#tools': ['Gaming Set (Dice)'],
      },
    });
    const text = formToYaml(LIB, form);
    expect(text).toContain('  srd:monk#skills: [acrobatics, insight]');
    expect(text).toContain('  srd:monk#asi-4: { asi: { dex: 1, wis: 1 } }');
    expect(text).toContain('  srd:soldier#abilities: { asi: { dex: 2, con: 1 } }');
    expect(text).toContain('classes: [{ class: srd:monk, level: 6, subclass: srd:warrior-of-the-open-hand }]');
    const r = checkCharacter(text, LIB);
    expect(r.schema).toEqual([]);
    expect(r.sheet?.hpMax.value).toBe(51);
    const monk = checkCharacter(MONK, LIB);
    expect(r.sheet?.picks).toEqual(monk.sheet?.picks);
  });
  it('drops a subclass that is not the class own or below its level, and illegal pick values', () => {
    const text = formToYaml(LIB, base({ level: 2, subclass: 'srd:warrior-of-the-open-hand' }));
    expect(text).toContain('classes: [{ class: srd:monk, level: 2 }]');
    const need = formNeeds(LIB, base({ level: 1 })).find((n) => n.key === 'srd:monk#skills')!;
    expect(pickValue(need, ['', 'not-a-skill'])).toBeNull();
    expect(pickValue(need, ['insight', ''])).toBe('[insight]');
    const asi = { key: 'k', where: '', kind: 'asi', choose: 1, what: '', options: [{ id: 'srd:alert', name: 'Alert' }] } as const;
    expect(pickValue(asi, { mode: 'oneone', a: 'str', b: 'str', feat: '' })).toBeNull();
    expect(pickValue(asi, { mode: 'two', a: 'con', b: '', feat: '' })).toBe('{ asi: { con: 2 } }');
    expect(pickValue(asi, { mode: 'feat', a: '', b: '', feat: 'srd:alert' })).toBe('{ feat: srd:alert }');
  });
  it('asks a species with two sizes for one', () => {
    const two = [...LIB.species.values()].find((s) => s.size.length > 1);
    if (!two) return;
    const text = formToYaml(LIB, base({ species: two.id, size: two.size[1]! }));
    expect(text).toContain(`size: ${two.size[1]}`);
  });
});

describe('downloadName', () => {
  it('names the file from the id local part', () => {
    expect(downloadName('test:sample-monk')).toBe('sample-monk.yaml');
    expect(downloadName('srd:a/b')).toBe('a-b.yaml');
    expect(downloadName(null)).toBe('character.yaml');
  });
});
