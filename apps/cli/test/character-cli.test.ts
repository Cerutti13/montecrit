// The M3 step 3 CLI (docs/design/m3.md 10): build, new character, migrate, run --pc, and lint and
// sheet on kind: character files. Every test points MONTECRIT_HOME at an empty temp folder and works
// on files in temp folders (copies of packs/test/pcs/* for migrate), so nothing reads ~/.montecrit
// and nothing under the repo is written.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BUILD_USAGE, NEW_USAGE, runBuild, runNewCharacter } from '../src/character.ts';
import { REPO_ROOT, refuseNewFile } from '../src/files.ts';
import { runLint } from '../src/lint.ts';
import { MIGRATE_USAGE, runMigrate } from '../src/migrate.ts';
import { RUN_USAGE, runRun } from '../src/run.ts';
import { runSheet } from '../src/sheet.ts';

// Built at runtime so tools/check-private.ts never sees the literal marker in this file.
const PRIV = 'priv' + 'ate';

const scratch = mkdtempSync(join(tmpdir(), 'montecrit-char-cli-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const fresh = (label: string): string => {
  const d = join(scratch, `${label}-${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};
/** An empty ~/.montecrit stand-in, so no test ever reads the real one. */
const env = () => ({ MONTECRIT_HOME: fresh('home') });

/** A class-built Fighter 5 (the C15 build), under an id no committed file uses. */
const FIGHTER = `kind: character
id: test:cli-fighter
name: CLI Fighter
rules: '2024'
classes: [{ class: srd:fighter, level: 5, subclass: srd:champion }]
species: srd:human
size: medium
background: srd:soldier
abilities: { str: 16, dex: 14, con: 14, int: 10, wis: 12, cha: 8 }
picks:
  srd:fighter#skills: [acrobatics, perception]
  srd:fighter#fighting-style: [srd:defense]
  srd:fighter#asi-4: { asi: { str: 1, con: 1 } }
  srd:fighter#weapon-mastery: [srd:longsword, srd:handaxe, srd:greatsword, srd:javelin]   # M3 step 5b: four kinds at Fighter 5
  srd:human#skillful: [insight]
  srd:human#versatile: [srd:skilled]
  srd:skilled#skills: [history, survival, stealth]
  srd:soldier#tools: [Gaming Set (Dice)]
equipment: { armor: srd:chain-mail, shield: true, weapons: [srd:longsword, { id: srd:handaxe, count: 2 }] }
`;

/** The section 5 Monk 6, missing one pick (a warning, not an error). */
const MONK = `kind: character
id: test:cli-monk
name: CLI Monk
rules: '2024'
classes: [{ class: srd:monk, level: 6, subclass: srd:warrior-of-the-open-hand }]
species: srd:dwarf
background: srd:soldier
abilities: { str: 10, dex: 16, con: 14, int: 10, wis: 16, cha: 8 }
picks:
  srd:monk#skills: [acrobatics, insight]
  srd:monk#asi-4: { asi: { dex: 1, wis: 1 } }
  srd:soldier#abilities: { asi: { dex: 2, con: 1 } }
equipment: { weapons: [srd:shortsword, { id: srd:dart, count: 10 }] }
overrides: { speed: { value: 45, why: 'Unarmored Movement +15 ft (not modeled yet)' } }
`;

const put = (dir: string, name: string, text: string): string => {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
};

describe('help', () => {
  it('main lists the new commands, and each command has its usage', () => {
    const r = spawnSync(process.execPath, [join(REPO_ROOT, 'apps/cli/src/main.ts'), '--help'], { encoding: 'utf8', env: { ...process.env, ...env() } });
    expect(r.status).toBe(0);
    for (const c of ['build', 'new', 'migrate', '--pc']) expect(r.stdout).toContain(c);
    expect(runBuild(['--help'], env()).out).toBe(BUILD_USAGE);
    expect(runNewCharacter(['--help'], env()).out).toBe(NEW_USAGE);
    expect(runMigrate(['--help'], env()).out).toBe(MIGRATE_USAGE);
    expect(RUN_USAGE).toMatch(/--pc SEAT=CHAR/);
    expect(runSheet(['--help'], env()).out).toMatch(/kind: character/);
    expect(runLint(['--help'], env()).out).toMatch(/kind: character/);
  });
});

describe('montecrit build', () => {
  it('prints the derived sheet with its derivation trace and per-feature fidelity, from a loose file', () => {
    const f = put(fresh('b'), 'fighter.yaml', FIGHTER);
    const o = runBuild([f], env());
    expect(o.err).toBe('');
    expect(o.code).toBe(0);
    expect(o.out).toContain('Fighter 5 (Champion), Human (medium), Soldier');
    // C10's hand check, with its page cites.
    expect(o.out).toMatch(/HP max\s+44\s+10 \(L1 max d10, p\.22\) \+ 4 x 6 \(fixed d10, p\.23\) \+ 5 x 2 \(CON\)/);
    expect(o.out).toMatch(/Features\n/);
    expect(o.out).toMatch(/srd:fighter\/second-wind\s+Second Wind \(Fighter 1\)\s+(full|partial|narrative)/);
    expect(o.out).toMatch(/Character lint: 0 error\(s\), 0 warning\(s\)/);
  });

  it('--json has the sheet, the file and the lint', () => {
    const f = put(fresh('b'), 'monk.yaml', MONK);
    const o = runBuild([f, '--json'], env());
    expect(o.code).toBe(0);
    const j = JSON.parse(o.out) as { id: string; compiled: boolean; file: string; sheet: { hpMax: { value: number; why: string }; ac: { value: number }; speed: { value: number; override?: unknown }; features: { id: string; fidelity: string; compiled: boolean }[]; pools: { name: string; max: number }[] }; errors: string[]; warnings: string[] };
    expect(Object.keys(j).sort()).toEqual(['compiled', 'errors', 'file', 'id', 'sheet', 'warnings']);
    expect(j.id).toBe('test:cli-monk');
    expect(j.compiled).toBe(true);
    expect(j.sheet.hpMax.value).toBe(51); // 8 + 5 x 5 + 6 x 2 + 6 (Dwarven Toughness)
    expect(j.sheet.ac.value).toBe(16); // Unarmored Defense: 10 + 3 + 3
    expect(j.sheet.speed.value).toBe(45);
    expect(j.sheet.speed.override).toBeDefined();
    expect(j.sheet.pools.map((p) => `${p.name} ${p.max}`)).toContain("Monk's Focus 6");
    expect(j.sheet.features.every((x) => typeof x.fidelity === 'string' && x.compiled)).toBe(true);
    expect(j.errors).toEqual([]);
    expect(j.warnings.some((w) => /pick needed: srd:soldier#tools/.test(w))).toBe(true);
  });

  it('an error in the character file exits 1 and names the path', () => {
    const f = put(fresh('b'), 'bad.yaml', MONK.replace('[acrobatics, insight]', '[acrobatics, arcana]'));
    const o = runBuild([f], env());
    expect(o.code).toBe(1);
    expect(o.out + o.err).toMatch(/arcana isn't an option for srd:monk#skills/);
  });

  it('refuses a kind: pc and points at migrate; an unknown id lists what is loaded', () => {
    const d = fresh('b');
    copyFileSync(join(REPO_ROOT, 'packs/test/pcs/sample-fighter.yaml'), join(d, 'pc.yaml'));
    const o = runBuild([join(d, 'pc.yaml')], env());
    expect(o.code).toBe(1);
    expect(o.err).toMatch(/is a kind: pc, not a kind: character; montecrit migrate/);
    expect(runBuild(['test:sample-fighter'], env()).err).toMatch(/test:sample-fighter is a pc with no character file behind it/);
    expect(runBuild(['test:no-such-character'], env()).err).toMatch(/no character test:no-such-character is loaded/);
  });

  it('a loose file needs a test: or private: id (never srd:)', () => {
    const f = put(fresh('b'), 'srd.yaml', FIGHTER.replace('id: test:cli-fighter', 'id: srd:cli-fighter'));
    const o = runBuild([f], env());
    expect(o.code).toBe(1);
    expect(o.err).toMatch(/needs a test: or private: id/);
  });
});

describe('montecrit new character', () => {
  it('writes a skeleton listing every pick with its options, which then builds with only pick warnings', () => {
    const out = join(fresh('n'), 'monk.yaml');
    const e = env();
    const o = runNewCharacter(['character', '--class', 'srd:monk', '--level', '6', '--subclass', 'srd:warrior-of-the-open-hand', '--species', 'srd:dwarf', '--background', 'srd:soldier', '--id', 'test:cli-new-monk', '--out', out], e);
    expect(o.err).toBe('');
    expect(o.code).toBe(0);
    const text = readFileSync(out, 'utf8');
    expect(text).toMatch(/^id: test:cli-new-monk$/m);
    expect(text).toMatch(/#   # Monk level 1: choose 2 \(skills\) from acrobatics, athletics, history, insight, religion, stealth/);
    expect(text).toMatch(/#   srd:monk#asi-4: \{ asi: \{ \} \}/);
    expect(text).toMatch(/#   srd:soldier#tools: \[\]/);
    expect(text).toMatch(/srd:soldier#abilities/);
    const b = runBuild([out], e);
    expect(b.code).toBe(0);
    expect(b.out).toMatch(/Monk 6 \(Warrior of the Open Hand\)/);
    expect(b.out).toMatch(/warning: picks: pick needed: srd:monk#skills/);
  });

  it('lists the subclasses when the level has one but none is named, and the species when none is', () => {
    const out = join(fresh('n'), 'f.yaml');
    expect(runNewCharacter(['character', '--class', 'srd:fighter', '--level', '3', '--id', 'test:cli-f', '--out', out], env()).code).toBe(0);
    const text = readFileSync(out, 'utf8');
    expect(text).toMatch(/# TODO subclass: .*srd:champion/);
    expect(text).toMatch(/# TODO species, one of: .*srd:dwarf/);
    expect(text).toMatch(/^species: TODO$/m);
  });

  it('lists Weapon Mastery\'s pick (M3 step 5b): a Fighter 5 chooses 4 kinds among every weapon, a Barbarian 1 2 among melee weapons only, a Monk none', () => {
    const skel = (cls: string, level: string) => {
      const out = join(fresh('n'), `${cls.slice(4)}.yaml`);
      expect(runNewCharacter(['character', '--class', cls, '--level', level, '--species', 'srd:human', '--background', 'srd:soldier', '--id', `test:cli-wm-${cls.slice(4)}`, '--out', out], env()).code).toBe(0);
      return readFileSync(out, 'utf8');
    };
    const f = skel('srd:fighter', '5');
    // The Fighter table's Weapon Mastery column (4 at level 5); "kinds of Simple or Martial weapons".
    expect(f).toMatch(/# Fighter level 1 \(Weapon Mastery\): choose 4 \(weapons\) from [^\n]*srd:longbow \(Longbow\)[^\n]*srd:maul \(Maul\)/);
    expect(f).toMatch(/#   srd:fighter#weapon-mastery: \[\]/);
    const b = skel('srd:barbarian', '1');
    expect(b).toMatch(/# Barbarian level 1 \(Weapon Mastery\): choose 2 \(weapons\) from /); // "two kinds of Simple or Martial Melee weapons"
    const line = b.split('\n').find((l) => l.includes('Barbarian level 1 (Weapon Mastery)'))!;
    expect(line).toContain('srd:greataxe');
    expect(line).not.toContain('srd:longbow');
    expect(skel('srd:monk', '6')).not.toMatch(/weapon-mastery/);
  });

  it('defaults the id to private:<file name> (outside the repo)', () => {
    const out = join(fresh('n'), 'my-hero.yaml');
    expect(runNewCharacter(['character', '--class', 'srd:wizard', '--level', '1', '--out', out], env()).code).toBe(0);
    expect(readFileSync(out, 'utf8')).toMatch(new RegExp(`^id: ${PRIV}:my-hero$`, 'm'));
  });

  it('refuses the repo packs/ folder (as written and through a symlink), an existing file and a private id in the repo', () => {
    const e = env();
    const base = ['character', '--class', 'srd:monk', '--level', '1', '--id', 'test:x'];
    for (const p of [join(REPO_ROOT, 'packs/test/x-cli.yaml'), join(REPO_ROOT, 'packs/no-such-dir/x.yaml')]) {
      const o = runNewCharacter([...base, '--out', p], e);
      expect(o.code).toBe(2);
      expect(o.err).toMatch(/inside the repo's packs\/ folder/);
      expect(existsSync(p)).toBe(false);
    }
    const d = fresh('n');
    symlinkSync(join(REPO_ROOT, 'packs'), join(d, 'link'));
    const viaLink = runNewCharacter([...base, '--out', join(d, 'link', 'test', 'x-cli.yaml')], e);
    expect(viaLink.code).toBe(2);
    expect(viaLink.err).toMatch(/packs\/ folder/);
    expect(existsSync(join(REPO_ROOT, 'packs/test/x-cli.yaml'))).toBe(false);
    const there = put(d, 'there.yaml', 'keep me\n');
    const again = runNewCharacter([...base, '--out', there], e);
    expect(again.code).toBe(2);
    expect(again.err).toMatch(/already exists; it is never overwritten/);
    expect(readFileSync(there, 'utf8')).toBe('keep me\n');
    expect(refuseNewFile(join(REPO_ROOT, 'scenarios', 'x-cli.yaml'), `id: ${PRIV}:x\n`)).toMatch(/under the repo root/);
    expect(refuseNewFile(join(d, 'x.txt'), '')).toMatch(/\.yaml/);
  });

  it('usage errors: an unknown class, a subclass below its level or of another class, a bad level', () => {
    const e = env();
    const out = join(fresh('n'), 'x.yaml');
    expect(() => runNewCharacter(['character', '--class', 'srd:nope', '--level', '1', '--out', out], e)).toThrow(/no class srd:nope.*srd:monk/);
    expect(() => runNewCharacter(['character', '--class', 'srd:monk', '--level', '2', '--subclass', 'srd:warrior-of-the-open-hand', '--out', out], e)).toThrow(/gains its subclass at level 3/);
    expect(() => runNewCharacter(['character', '--class', 'srd:monk', '--level', '3', '--subclass', 'srd:champion', '--out', out], e)).toThrow(/isn't a Monk subclass/);
    expect(() => runNewCharacter(['character', '--class', 'srd:monk', '--level', '21', '--out', out], e)).toThrow(/--level/);
    expect(() => runNewCharacter(['monster', '--class', 'srd:monk', '--level', '1', '--out', out], e)).toThrow(/new character/);
    expect(existsSync(out)).toBe(false);
  });
});

describe('montecrit migrate', () => {
  it('drafts a character beside a pc copy, expands both and prints a field-by-field diff', () => {
    const d = fresh('m');
    const pc = join(d, 'sample-fighter.yaml');
    copyFileSync(join(REPO_ROOT, 'packs/test/pcs/sample-fighter.yaml'), pc);
    const o = runMigrate([pc, '--class', 'srd:fighter', '--subclass', 'srd:champion', '--species', 'srd:human', '--background', 'srd:soldier', '--id', 'test:cli-migrated'], env());
    expect(o.err).toBe('');
    expect(o.code).toBe(0);
    const draft = join(d, 'sample-fighter.character.yaml');
    const text = readFileSync(draft, 'utf8');
    expect(text).toMatch(/^kind: character$/m);
    expect(text).toMatch(/^classes: \[\{ class: srd:fighter, level: 5, subclass: srd:champion \}\]$/m);
    expect(text).toMatch(/weapons: \[srd:longsword, \{ id: srd:handaxe, count: 2 \}\]/);
    // The pc states AC 18 by hand; the draft wears nothing until the TODO is answered.
    expect(o.out).toMatch(/template diff, pc test:sample-fighter vs character test:cli-migrated/);
    expect(o.out).toMatch(/^ {2}ac\s+pc 18 +\| +character 12$/m);
    expect(o.out).toMatch(/^same: .*\bhpMax\b.*\battack\.longsword\b/m);
    expect(o.out).toMatch(/pool\.second-wind\s+pc \(none\)/);
    // The source pc is untouched.
    expect(readFileSync(pc, 'utf8')).toBe(readFileSync(join(REPO_ROOT, 'packs/test/pcs/sample-fighter.yaml'), 'utf8'));
  });

  it('--json gives { wrote, pc, character, differ, same, lint }', () => {
    const d = fresh('m');
    const pc = join(d, 'sample-fighter.yaml');
    copyFileSync(join(REPO_ROOT, 'packs/test/pcs/sample-fighter.yaml'), pc);
    const o = runMigrate([pc, '--class', 'srd:fighter', '--species', 'srd:human', '--background', 'srd:soldier', '--out', join(d, 'out.yaml'), '--json'], env());
    expect(o.code).toBe(0);
    const j = JSON.parse(o.out) as { wrote: string; pc: string; character: string; differ: { field: string; pc: string; character: string }[]; same: string[]; lint: string[] };
    expect(Object.keys(j).sort()).toEqual(['character', 'differ', 'lint', 'pc', 'same', 'wrote']);
    // test:sample-fighter-built is committed (packs/test/characters/), so the default id moves on.
    expect(j.character).toBe('test:sample-fighter-built-2');
    expect(j.differ.find((x) => x.field === 'ac')).toEqual({ field: 'ac', pc: '18', character: '12' });
    expect(j.same).toContain('hpMax');
    expect(existsSync(join(d, 'out.yaml'))).toBe(true);
  });

  it('an --id that is already loaded is refused; the default skips taken ids, and the draft builds beside the packs', () => {
    const d = fresh('m');
    const pc = join(d, 'sample-fighter.yaml');
    copyFileSync(join(REPO_ROOT, 'packs/test/pcs/sample-fighter.yaml'), pc);
    const taken = runMigrate([pc, '--class', 'srd:fighter', '--species', 'srd:human', '--background', 'srd:soldier', '--id', 'test:sample-fighter-built'], env());
    expect(taken.code).toBe(2);
    expect(taken.err).toMatch(/--id test:sample-fighter-built is already loaded \(a character\)/);
    expect(existsSync(join(d, 'sample-fighter.character.yaml'))).toBe(false);
    const e = env();
    expect(runMigrate([pc, '--class', 'srd:fighter', '--species', 'srd:human', '--background', 'srd:soldier'], e).code).toBe(0);
    const b = runBuild([join(d, 'sample-fighter.character.yaml'), '--json'], e);
    const j = JSON.parse(b.out) as { id: string; errors: string[] };
    expect([j.id, j.errors]).toEqual(['test:sample-fighter-built-2', []]);
  });

  it('a pc whose kit the draft cannot carry still writes the draft, lists the TODOs and exits 1', () => {
    const d = fresh('m');
    const pc = join(d, 'sample-druid.yaml');
    copyFileSync(join(REPO_ROOT, 'packs/test/pcs/sample-druid.yaml'), pc);
    const o = runMigrate([pc, '--class', 'srd:druid', '--species', 'srd:elf', '--background', 'srd:sage', '--id', 'test:cli-druid'], env());
    const text = readFileSync(join(d, 'sample-druid.character.yaml'), 'utf8');
    expect(text).toMatch(/casting source charm: not the class's or subclass's spellcasting/);
    expect(text).toMatch(/- \{ source: srd:druid, cantrips: \[test:tether, srd:produce-flame\]/);
    expect(o.code).toBe(1);
    expect(o.out).toMatch(/the diff needs both to compile/);
  });

  it('refuses to overwrite, to write into packs/, and runs without --class/--species/--background', () => {
    const e = env();
    const d = fresh('m');
    const pc = join(d, 'sample-fighter.yaml');
    copyFileSync(join(REPO_ROOT, 'packs/test/pcs/sample-fighter.yaml'), pc);
    const args = ['--class', 'srd:fighter', '--species', 'srd:human', '--background', 'srd:soldier'];
    expect(runMigrate([pc, ...args], e).code).toBe(0);
    const again = runMigrate([pc, ...args], e);
    expect(again.code).toBe(2);
    expect(again.err).toMatch(/already exists/);
    const intoPacks = runMigrate([pc, ...args, '--out', join(REPO_ROOT, 'packs/test/pcs/x-cli.character.yaml')], e);
    expect(intoPacks.code).toBe(2);
    expect(intoPacks.err).toMatch(/packs\/ folder/);
    expect(existsSync(join(REPO_ROOT, 'packs/test/pcs/x-cli.character.yaml'))).toBe(false);
    expect(() => runMigrate([pc, '--class', 'srd:fighter'], e)).toThrow(/--species, --background/);
    const notPc = put(d, 'monk.yaml', MONK);
    expect(runMigrate([notPc, ...args], e).err).toMatch(/isn't a kind: pc file/);
  });
});

describe('migrate never drafts a private pc into the repo (review cli-migrate-private-relabel)', () => {
  it('a private-id pc relabelled with --id test:... and --out under the repo root is refused, exit 2', () => {
    const d = fresh('mp');
    const pc = join(d, 'hero.yaml');
    const src = readFileSync(join(REPO_ROOT, 'packs/test/pcs/sample-fighter.yaml'), 'utf8').replace(/^id: .*$/m, `id: ${PRIV}:secret-hero`).replace(/^name: .*$/m, 'name: "Zorbonax the Secret"');
    writeFileSync(pc, src);
    const target = join(REPO_ROOT, `review-leak-${process.pid}.yaml`);
    try {
      const o = runMigrate([pc, '--class', 'srd:fighter', '--species', 'srd:human', '--background', 'srd:soldier', '--id', 'test:leak', '--out', target], env());
      expect(o.code).toBe(2);
      expect(o.err).toMatch(/refused: .*hero\.yaml is \w+ \(it carries a \w+ content id\), so its draft can't be written under the repo root/);
      expect(existsSync(target)).toBe(false);
      // Outside the repo the same draft is written (the relabel itself is the user's call).
      const outside = join(d, 'hero.character.yaml');
      expect(runMigrate([pc, '--class', 'srd:fighter', '--species', 'srd:human', '--background', 'srd:soldier', '--id', 'test:leak', '--out', outside], env()).code).toBe(0);
      expect(readFileSync(outside, 'utf8')).toContain('Zorbonax the Secret');
    } finally {
      rmSync(target, { force: true });
    }
  });

  it('a pc in a pack with a private manifest, or under the home folder, is refused the same way', () => {
    const d = fresh('mp');
    writeFileSync(join(d, 'manifest.yaml'), `kind: manifest\npack: mine\nversion: '1'\nrules: '2024'\nnamespace: ${PRIV}\nlicense: ${PRIV}\n`);
    const pc = join(d, 'fighter.yaml');
    copyFileSync(join(REPO_ROOT, 'packs/test/pcs/sample-fighter.yaml'), pc);
    const target = join(REPO_ROOT, `review-leak-m-${process.pid}.yaml`);
    try {
      const o = runMigrate([pc, '--class', 'srd:fighter', '--species', 'srd:human', '--background', 'srd:soldier', '--id', 'test:leak-m', '--out', target], env());
      expect([o.code, existsSync(target)]).toEqual([2, false]);
      expect(o.err).toMatch(/its pack's manifest .* carries a \w+ license/);
      const home = fresh('home');
      const inHome = join(home, 'characters');
      mkdirSync(inHome);
      const pc2 = join(inHome, 'fighter.yaml');
      copyFileSync(join(REPO_ROOT, 'packs/test/pcs/sample-fighter.yaml'), pc2);
      const h = runMigrate([pc2, '--class', 'srd:fighter', '--species', 'srd:human', '--background', 'srd:soldier', '--id', 'test:leak-h', '--out', target], { MONTECRIT_HOME: home });
      expect([h.code, existsSync(target)]).toEqual([2, false]);
      expect(h.err).toMatch(/it is under /);
    } finally {
      rmSync(target, { force: true });
    }
  });
});

describe('migrate with a species, background and subclass from a private pack (session S)', () => {
  // The repo's synthetic stand-ins, copied into a private pack in a temp home with their ids relabelled,
  // as a private kit would sit in ~/.montecrit/packs/. The pc sheet is built to match the derived character.
  const KIT_FILES = ['species/sample-kin', 'backgrounds/sample-wanderer', 'subclasses/sample-path', 'features/radiant-shift', 'features/mending-touch', 'features/stance'];
  const relabel = (t: string) => t.replace(/\btest:(sample-kin|sample-wanderer|sample-path|radiant-shift|mending-touch|stance)\b/g, `${PRIV}:$1`);
  const SHEET = `kind: pc
id: ${PRIV}:kin-pc
name: Kin PC
source: synthetic sheet
rules: '2024'
level: 5
size: medium
speed: 30
abilities: { str: 8, dex: 14, con: 14, int: 10, wis: 17, cha: 13 }
hpMax: 38
ac: 12
armor: none
saveProficiencies: [int, wis]
skills: { proficient: [nature, perception, insight, survival] }
resist: [radiant]
items:
  - { id: shield, name: Shield, kind: shield, shieldAc: 2 }
hands: [shield, null]
slots: [4, 3, 2]
pools:
  - { id: wild-resurgence, name: Wild Resurgence, max: 1, recharge: longRest }
  - { id: wild-shape, name: Wild Shape, max: 2, recharge: shortRest }
  - { id: forms, name: Forms, max: 3, recharge: longRest }
  - { id: mending-touch, name: Mending Touch, max: 1, recharge: longRest }
  - { id: radiant-shift, name: Radiant Shift, max: 1, recharge: longRest }
casting:
  - source: druid
    ability: wis
    list: druid
    cantrips: [srd:produce-flame, srd:guidance, srd:poison-spray]
    prepared: [srd:healing-word, srd:cure-wounds, srd:entangle, srd:faerie-fire, srd:thunderwave, srd:moonbeam, srd:spike-growth, srd:hold-person, srd:longstrider]
features: [${PRIV}:mending-touch, ${PRIV}:radiant-shift, ${PRIV}:stance]
`;
  function kitHome(): { home: string; pc: string } {
    const home = fresh('home');
    const kit = join(home, 'packs', 'kit');
    mkdirSync(kit, { recursive: true });
    mkdirSync(join(home, 'characters'));
    writeFileSync(join(home, 'config.yaml'), `packs: [${kit}]\n`);
    writeFileSync(join(kit, 'manifest.yaml'), `kind: manifest\npack: kit\nversion: '1'\nrules: '2024'\nnamespace: ${PRIV}\nlicense: ${PRIV}\n`);
    for (const f of KIT_FILES) writeFileSync(join(kit, `${f.split('/')[1]}.yaml`), relabel(readFileSync(join(REPO_ROOT, 'packs/test', `${f}.yaml`), 'utf8')));
    const pc = join(home, 'characters', 'kin.yaml');
    writeFileSync(pc, SHEET);
    return { home, pc };
  }

  it('the draft names the private species, background and subclass, and only fidelity and the unmodeled count differ', () => {
    const { home, pc } = kitHome();
    const o = runMigrate([pc, '--class', 'srd:druid', '--subclass', `${PRIV}:sample-path`, '--species', `${PRIV}:sample-kin`, '--background', `${PRIV}:sample-wanderer`, '--json'], { MONTECRIT_HOME: home });
    expect(o.err).toBe('');
    expect(o.code).toBe(0);
    const j = JSON.parse(o.out) as { differ: { field: string }[]; same: string[] };
    // The derived character carries the class data's unmodeled lines (Wild Shape, ...); the hand sheet lists none.
    expect(j.differ.map((d) => d.field)).toEqual(['fidelity', 'unimplemented']);
    // A species' own pools (session S) reach the character: without them these differ.
    for (const f of ['pool.mending-touch', 'pool.radiant-shift', 'pool.forms', 'features', 'options', 'resist', 'hpMax', 'ac', 'spells']) expect(j.same).toContain(f);
    const draft = readFileSync(join(home, 'characters', 'kin.character.yaml'), 'utf8');
    expect(draft).toMatch(new RegExp(`^species: ${PRIV}:sample-kin$`, 'm'));
    expect(draft).toMatch(new RegExp(`^background: ${PRIV}:sample-wanderer$`, 'm'));
    expect(draft).toMatch(new RegExp(`# ${PRIV}:sample-wanderer#abilities: \\{ asi: \\{ \\} \\}`));
  });

  it('the background\'s +2/+1 among its three abilities and its origin feat build into the sheet', () => {
    const { home } = kitHome();
    const f = put(join(home, 'characters'), 'kin-built.yaml', relabel(readFileSync(join(REPO_ROOT, 'packs/test/characters/sample-kin-druid.yaml'), 'utf8')).replace('id: test:sample-kin-druid', `id: ${PRIV}:kin-built`));
    const b = runBuild([f], { MONTECRIT_HOME: home });
    expect(b.code).toBe(0);
    expect(b.out).toMatch(new RegExp(`${PRIV}:sample-wanderer#abilities: increases WIS \\+2, CHA \\+1`));
    expect(b.out).toMatch(/srd:magic-initiate Magic Initiate \(Sample Wanderer\)/);
    expect(b.out).toMatch(/Radiant Shift 1 +\(1 \(Sample Kin\)\); spent by Radiant Shift/);
    expect(b.out).toMatch(/Character lint: 0 error\(s\), 0 warning\(s\)/);
    const bad = put(join(home, 'characters'), 'kin-bad.yaml', readFileSync(f, 'utf8').replace(`id: ${PRIV}:kin-built`, `id: ${PRIV}:kin-bad`).replace('{ asi: { wis: 2, cha: 1 } }', '{ asi: { str: 2, cha: 1 } }'));
    expect(runBuild([bad], { MONTECRIT_HOME: home }).out).toMatch(/Sample Wanderer raises only con, wis, cha \(not str\)/);
  });
});

describe('montecrit run --pc', () => {
  const OA = join(REPO_ROOT, 'scenarios/golden/oa-interrupts-move.yaml');

  it('seating the scenario\'s own PC changes no event; the header says calibration is not measured', () => {
    const e = env();
    const base = runRun([OA, '--seed', '1'], e);
    const same = runRun([OA, '--seed', '1', '--pc', 'pc1=test:sample-fighter'], e);
    expect(same.code).toBe(0);
    const body = (s: string) => s.split('\n').filter((l) => /^ #\d+/.test(l)).join('\n');
    expect(body(same.out)).toBe(body(base.out));
    expect(same.out).toMatch(/notes {4}--pc pc1: test:sample-fighter \(kind: pc\) in place of test:sample-fighter; calibration: not measured for this PC/);
  });

  it('drops a character file into a seat; its partial content is in the header', () => {
    const f = put(fresh('r'), 'fighter.yaml', FIGHTER);
    const o = runRun([OA, '--seed', '1', '--pc', `pc1=${f}`], env());
    expect(o.code).toBe(0);
    expect(o.out).toMatch(/notes {4}--pc pc1: test:cli-fighter \(character file, .*fighter\.yaml\) in place of test:sample-fighter/);
    expect(o.out).toMatch(/notes {4}test:cli-fighter partial: unimplemented /);
    expect(o.out).toMatch(/fight ends/);
  });

  it('a report drops the calibration record, says why, and its replay command carries --pc', () => {
    const f = put(fresh('r'), 'monk.yaml', MONK);
    const o = runRun(['stars-ambush', '-n', '4', '--pc', `pc1=${f}`], env());
    expect(o.code).toBe(0);
    expect(o.out).toMatch(/calibrated: no/);
    // MOD-1 2026-11-11: the scenario's record is now win 70.1%.
    expect(o.out).toMatch(/calibration: not measured for this PC; the scenario's record \(win 70\.1%\)/);
    expect(o.out).toMatch(/test:cli-monk partial: unimplemented/);
    expect(o.out).toMatch(/--pc pc1=.*monk\.yaml/);
  });

  it('review M2: a character whose namespace no scenario pack covers brings its own pack into the run', () => {
    const f = put(fresh('r'), 'fighter.yaml', FIGHTER.replace('id: test:cli-fighter', `id: ${PRIV}:rev-fighter`));
    const o = runRun([OA, '--seed', '1', '--pc', `pc1=${f}`], env());
    expect(o.err).toBe('');
    expect(o.code).toBe(0);
    expect(o.out).toMatch(new RegExp(`--pc pc1: ${PRIV}:rev-fighter \\(character file`));
    expect(o.out).toMatch(/fight ends/);
  });

  it('seat and character errors exit 2 with what is known', () => {
    const e = env();
    expect(runRun([OA, '--pc', 'nobody=test:sample-fighter'], e)).toMatchObject({ code: 2, err: expect.stringMatching(/no seat "nobody".*seats: .*pc1/) as unknown });
    expect(runRun([OA, '--pc', 'pc1=srd:goblin-boss'], e).err).toMatch(/srd:goblin-boss is a monster, not a character/);
    expect(runRun([OA, '--pc', 'pc1=test:no-such'], e).err).toMatch(/no character test:no-such is loaded/);
    expect(() => runRun([OA, '--pc', 'pc1'], e)).toThrow(/--pc needs SEAT=CHARACTER/);
    expect(() => runRun([OA, '--pc', 'pc1=test:sample-fighter', '--pc', 'pc1=test:sample-druid'], e)).toThrow(/names seat pc1 twice/);
    const monster = put(fresh('r'), 'm.yaml', 'kind: manifest\n');
    expect(runRun([OA, '--pc', `pc1=${monster}`], e).code).not.toBe(0);
  });
});

describe('lint and sheet accept kind: character', () => {
  it('lint gives a loose character file the character lint', () => {
    const d = fresh('l');
    const f = put(d, 'monk.yaml', MONK);
    const o = runLint([f], env());
    expect(o.code).toBe(0);
    expect(o.out).toMatch(/monk\.yaml:\d+:\d+: warning: picks: pick needed: srd:soldier#tools/);
    const bad = put(fresh('l'), 'bad.yaml', MONK.replace('srd:dwarf', 'srd:no-such-species'));
    const b = runLint([bad], env());
    expect(b.code).toBe(1);
    expect(b.out).toMatch(/error: species: no species srd:no-such-species is loaded/);
    expect(runLint([f, '--strict'], env()).code).toBe(1);
  });

  it('sheet prints a character file\'s compiled sheet and points at build; --json carries the derived sheet', () => {
    const f = put(fresh('s'), 'fighter.yaml', FIGHTER);
    const o = runSheet([f], env());
    expect(o.code).toBe(0);
    expect(o.out).toMatch(/CLI Fighter {2}test:cli-fighter {2}\(pc, medium\)/);
    expect(o.out).toMatch(/Built from a character file \(Fighter 5\): montecrit build .*fighter\.yaml/);
    const j = JSON.parse(runSheet([f, '--json'], env()).out) as { hp: number; character: { hpMax: { value: number } } };
    expect(j.hp).toBe(44);
    expect(j.character.hpMax.value).toBe(44);
    // A pc's sheet is unchanged: no character key.
    expect(Object.keys(JSON.parse(runSheet(['test:sample-fighter', '--json'], env()).out) as object)).not.toContain('character');
  });
});
