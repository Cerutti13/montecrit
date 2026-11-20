// `montecrit build` and `montecrit new character` (docs/design/m3.md 10): a kind: character file
// expanded into its derived sheet (every number with its source, every feature with its fidelity),
// and a skeleton character file with every pick the build needs listed as a comment of its legal
// options. The expansion itself is the engine's (content/character.ts); this file only reads the
// character-building data back out of the loaded texts to list the choices, and prints.

import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { formatDiag, renderSheet as renderDerived, sheetJson as derivedJson, type CharacterLib, type DerivedSheet, type Diag } from '@montecrit/engine';
import { buildNeeds, byString, characterLib, equipmentComment, picksBlock, type BackgroundSrc, type ClassSrc, type SpeciesSrc, type SubclassSrc } from '@montecrit/host';
import { REPO_ROOT, displayPath, isFile, writeNewFile } from './files.ts';
import { itemOf, loadWithFiles, type Env, type FileTarget, type Loaded } from './home.ts';
import type { CommandOutput } from './lint.ts';
import { UsageError } from './odds.ts';

// The character-building data and the picks a build needs live in @montecrit/host
// (character-picks.ts), shared with the browser's Character screen; re-exported for migrate and
// tools/smoke-corpus.ts.
export { buildNeeds, characterLib, equipmentComment, masteryNeed, needLines, picksBlock, type BackgroundSrc, type ClassSrc, type Need, type SpeciesSrc, type SubclassSrc } from '@montecrit/host';

// ---- montecrit build ----

export const BUILD_USAGE = `usage: montecrit build <character file|id> [--json]

  Expands a kind: character file: the derived sheet with every number's source (the derivation
  trace), each feature's fidelity, and the character lint (picks, counts, training, hands).

  <character>  a kind: character file (loose files load under a test: or private: id), or a loaded character's id
  --json       machine-readable output: { file, id, compiled, sheet, errors, warnings }`;

const show = (d: Diag, level: string): string => formatDiag({ ...d, path: displayPath(d.path), message: `${level}: ${d.message}` });

/** Loads the known packs plus a character named by file or id: its sheet, its file and the diagnostics on that file. */
export function loadCharacter(arg: string, env: Env, repoRoot: string): { loaded: Loaded; target: FileTarget | null; id: string; file: string | null; sheet: DerivedSheet | null } {
  const asFile = isFile(resolve(arg));
  const { loaded, targets } = loadWithFiles(asFile ? [arg] : [], env, repoRoot);
  const target = asFile ? targets[0]! : null;
  const id = target ? (target.id ?? '') : arg;
  const sheet = (loaded.sheets ?? []).find((s) => s.id === id) ?? null;
  let file = target?.path ?? null;
  if (file === null) {
    // An id: find the file that defines it, for its diagnostics.
    const f = loaded.files.find((x) => x.text.includes(id) && itemOf(x.text, x.path).id === id);
    file = f?.path ?? null;
  }
  return { loaded, target, id, file, sheet };
}

export function runBuild(argv: readonly string[], env: Env = process.env, repoRoot: string = REPO_ROOT): CommandOutput {
  const { values, positionals } = parseArgs({ args: [...argv], options: { json: { type: 'boolean' }, help: { type: 'boolean' } }, allowPositionals: true, strict: true });
  if (values.help) return { out: BUILD_USAGE, err: '', code: 0 };
  if (positionals.length !== 1) throw new UsageError('build takes exactly one character file or id');
  const arg = positionals[0]!;
  const { loaded, target, id, file, sheet } = loadCharacter(arg, env, repoRoot);
  if (target && target.kind !== 'character') {
    const hint = target.kind === 'pc' ? `; montecrit migrate ${arg} --class <id> --species <id> --background <id> drafts a character from it` : '';
    return { out: '', err: `build: ${displayPath(target.path)} is ${target.kind ? `a kind: ${target.kind}` : 'not a content item'}, not a kind: character${hint}`, code: 1 };
  }
  const mine = (d: Diag) => file !== null && d.path === file;
  const errors = loaded.errors.filter(mine);
  const warnings = loaded.warnings.filter(mine);
  const elsewhere = loaded.errors.filter((d) => !mine(d));
  if (!sheet) {
    const tpl = loaded.content?.get(id);
    const why = tpl
      ? `${id} is a ${tpl.kind} with no character file behind it${tpl.kind === 'pc' ? ' (a kind: pc; montecrit migrate drafts a character from its file)' : ''}`
      : errors.length > 0
        ? `${id || arg} didn't expand`
        : `no character ${id || arg} is loaded (known: ${(loaded.sheets ?? []).map((s) => s.id).join(', ') || 'none'})`;
    const lines = [...errors.map((d) => show(d, 'error')), ...elsewhere.map((d) => show(d, 'error')), `build: ${why}`];
    return { out: '', err: lines.join('\n'), code: 1 };
  }
  if (values.json) {
    const out = {
      file: file ? displayPath(file) : null,
      id,
      compiled: errors.length === 0,
      sheet: derivedJson(sheet),
      errors: [...errors, ...elsewhere].map((d) => show(d, 'error')),
      warnings: warnings.map((d) => show(d, 'warning')),
    };
    return { out: JSON.stringify(out, null, 2), err: '', code: errors.length + elsewhere.length > 0 ? 1 : 0 };
  }
  const lines = [renderDerived(sheet).replace(/\n$/, '')];
  if (file) lines.push(`File: ${displayPath(file)}`);
  lines.push(`Character lint: ${errors.length} error(s), ${warnings.length} warning(s)`);
  for (const d of errors) lines.push(`  ${show(d, 'error')}`);
  for (const d of warnings) lines.push(`  ${show(d, 'warning')}`);
  if (errors.length > 0) lines.push('Not compiled: fix the errors above, then the character can play (montecrit run <scenario> --pc <seat>=<file>).');
  const err = elsewhere.length > 0 ? [...elsewhere.map((d) => show(d, 'error')), `build: other content has ${elsewhere.length} error(s); run montecrit lint`].join('\n') : '';
  return { out: lines.join('\n'), err, code: errors.length + elsewhere.length > 0 ? 1 : 0 };
}

// ---- montecrit new character ----

export const NEW_USAGE = `usage: montecrit new character --class <id> --level N --out <path> [options]

  Writes a skeleton kind: character file: every pick the build needs at that level as a commented
  list of its legal options. Never into the repo's packs/ folder, never over an existing file.

  --class ID        the class, e.g. srd:monk
  --level N         1-20 (levels 11-20 load, their features as narrative)
  --subclass ID     the subclass (from the class's subclass level)
  --species ID      the species (its picks are listed once it's named)
  --background ID   the background (its picks and its origin feat's are listed once it's named)
  --id ID           the character's id (default: private:<file name>; a file under the repo needs a test: id)
  --name NAME       its name (default: from the file name)
  --out PATH        where to write it (.yaml)`;

const quote = (s: string): string => JSON.stringify(s);
const titleOf = (file: string): string =>
  basename(file)
    .replace(/\.ya?ml$/i, '')
    .split(/[-_ ]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ') || 'New Character';
const kebabOf = (file: string): string =>
  basename(file)
    .replace(/\.ya?ml$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'character';

/** What a skeleton needs from the data, checked; a usage error names the known options. */
export function resolveBuild(lib: CharacterLib, opts: { class: string; subclass?: string; species?: string; background?: string; level: number }): { cls: ClassSrc; sub?: SubclassSrc; species?: SpeciesSrc; bg?: BackgroundSrc } {
  const known = (m: ReadonlyMap<string, unknown>) => [...m.keys()].sort(byString).join(', ');
  const cls = lib.classes.get(opts.class);
  if (!cls) throw new UsageError(`--class: no class ${opts.class} is loaded (known: ${known(lib.classes)})`);
  let sub: SubclassSrc | undefined;
  if (opts.subclass !== undefined) {
    sub = lib.subclasses.get(opts.subclass);
    const mine = [...lib.subclasses.values()].filter((s) => s.parent === cls.id).map((s) => s.id).sort(byString);
    if (!sub || sub.parent !== cls.id) throw new UsageError(`--subclass: ${opts.subclass} isn't a ${cls.name} subclass (known: ${mine.join(', ') || 'none'})`);
    if (opts.level < cls.subclassLevel) throw new UsageError(`--subclass: a ${cls.name} gains its subclass at level ${cls.subclassLevel}; this one is level ${opts.level}`);
  }
  let species: SpeciesSrc | undefined;
  if (opts.species !== undefined) {
    species = lib.species.get(opts.species);
    if (!species) throw new UsageError(`--species: no species ${opts.species} is loaded (known: ${known(lib.species)})`);
  }
  let bg: BackgroundSrc | undefined;
  if (opts.background !== undefined) {
    bg = lib.backgrounds.get(opts.background);
    if (!bg) throw new UsageError(`--background: no background ${opts.background} is loaded (known: ${known(lib.backgrounds)})`);
  }
  return { cls, ...(sub ? { sub } : {}), ...(species ? { species } : {}), ...(bg ? { bg } : {}) };
}

/** The class-entry, species, background, equipment and casting lines shared by new character and migrate. */
export function buildLines(lib: CharacterLib, b: { cls: ClassSrc; sub?: SubclassSrc; species?: SpeciesSrc; bg?: BackgroundSrc }, level: number): { classLine: string[]; speciesLines: string[]; backgroundLines: string[]; castingSources: string[] } {
  const { cls, sub, species, bg } = b;
  const classLine: string[] = [];
  if (!sub && level >= cls.subclassLevel) {
    const mine = [...lib.subclasses.values()].filter((s) => s.parent === cls.id).map((s) => s.id).sort(byString);
    classLine.push(`# TODO subclass: a level ${level} ${cls.name} has one (from level ${cls.subclassLevel}); add subclass: to the entry below. Loaded: ${mine.join(', ') || 'none'}`);
  }
  classLine.push(`classes: [{ class: ${cls.id}, level: ${level}${sub ? `, subclass: ${sub.id}` : ''} }]`);
  const speciesLines = species
    ? [`species: ${species.id}`, ...(species.size.length > 1 ? [`size: ${species.size[0]}  # TODO a ${species.name} can be ${species.size.join(' or ')}: choose one`] : [])]
    : [`# TODO species, one of: ${[...lib.species.keys()].sort(byString).join(', ')} (then rerun montecrit new character with --species to list its picks)`, 'species: TODO'];
  const backgroundLines = bg
    ? [`background: ${bg.id}`]
    : [`# TODO background, one of: ${[...lib.backgrounds.keys()].sort(byString).join(', ')} (then rerun with --background to list its picks)`, 'background: TODO'];
  const castingSources = [cls.spellcasting ? cls.id : null, sub?.spellcasting ? sub.id : null].filter((x): x is string => x !== null);
  return { classLine, speciesLines, backgroundLines, castingSources };
}

export function runNewCharacter(argv: readonly string[], env: Env = process.env, repoRoot: string = REPO_ROOT): CommandOutput {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      class: { type: 'string' },
      level: { type: 'string' },
      subclass: { type: 'string' },
      species: { type: 'string' },
      background: { type: 'string' },
      id: { type: 'string' },
      name: { type: 'string' },
      out: { type: 'string' },
      help: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help) return { out: NEW_USAGE, err: '', code: 0 };
  if (positionals.length !== 1 || positionals[0] !== 'character') throw new UsageError(`new makes one thing: montecrit new character ... (got "${positionals.join(' ')}")`);
  if (values.class === undefined) throw new UsageError('new character needs --class (e.g. --class srd:monk)');
  if (values.level === undefined || !/^\d+$/.test(values.level) || Number(values.level) < 1 || Number(values.level) > 20) throw new UsageError(`--level needs a level from 1 to 20${values.level === undefined ? '' : `, got "${values.level}"`}`);
  if (values.out === undefined) throw new UsageError('new character needs --out <path.yaml>');
  const level = Number(values.level);
  const out = resolve(values.out);
  const id = values.id ?? `${'priv' + 'ate'}:${kebabOf(out)}`;
  if (!/^(srd|test|private):[a-z0-9]/.test(id)) throw new UsageError(`--id needs a test:, srd: or private: id, got "${id}"`);

  const { loaded } = loadWithFiles([], env, repoRoot);
  if (!loaded.content) return { out: '', err: [...loaded.errors.map((d) => show(d, 'error')), `new character: content has ${loaded.errors.length} error(s); run montecrit lint`].join('\n'), code: 1 };
  const lib = characterLib(loaded.files);
  const b = resolveBuild(lib, { class: values.class, level, ...(values.subclass !== undefined ? { subclass: values.subclass } : {}), ...(values.species !== undefined ? { species: values.species } : {}), ...(values.background !== undefined ? { background: values.background } : {}) });
  const { classLine, speciesLines, backgroundLines, castingSources } = buildLines(lib, b, level);
  const needs = buildNeeds(lib, b.cls, b.sub, b.species, b.bg, level);
  const text = [
    `# Skeleton from: montecrit new character --class ${b.cls.id} --level ${level}${b.sub ? ` --subclass ${b.sub.id}` : ''}${b.species ? ` --species ${b.species.id}` : ''}${b.bg ? ` --background ${b.bg.id}` : ''}`,
    '# Fill in every TODO and every pick, then check it with: montecrit build <this file>',
    'kind: character',
    `id: ${id}`,
    `name: ${quote(values.name ?? titleOf(out))}`,
    "rules: '2024'",
    ...classLine,
    ...speciesLines,
    ...backgroundLines,
    '# TODO abilities: the final scores, increases included',
    'abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }',
    `hp: average  # or max, or { rolled: [${level > 1 ? `<${level - 1} rolls, levels 2-${level}>` : ''}] }`,
    ...picksBlock(needs),
    ...(needs.some((n) => n.options.some((o) => lib.feats.has(o.id)))
      ? ['# A feat picked above may ask for picks of its own (<feat id>#<choice>): montecrit build lists them.']
      : []),
    ...equipmentComment(lib, b.cls),
    'equipment: { armor: null, shield: false, weapons: [] }',
    ...(castingSources.length > 0
      ? ['# casting: the cantrips and prepared spells chosen per source (montecrit build shows how many the table allows)', 'casting:', ...castingSources.map((s) => `  - { source: ${s}, cantrips: [], prepared: [] }`)]
      : []),
    '',
  ].join('\n');
  const why = writeNewFile(out, text, repoRoot);
  if (why !== null) return { out: '', err: `new character: ${why}`, code: 2 };
  return { out: `wrote ${displayPath(out)}: ${needs.length} pick(s) to fill in\nnext: montecrit build ${displayPath(out)}`, err: '', code: 0 };
}
