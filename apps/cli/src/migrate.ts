// `montecrit migrate <pc file>` (docs/design/m3.md 10): drafts a kind: character file from a
// hand-filled kind: pc, writes it beside the pc (never into packs/, never over a file), expands
// both, and prints a field-by-field diff of the two compiled templates. A pc names no class,
// species or background, so those come from the command line; everything the pc states by hand
// that the character derives (HP, AC, saves, pools, slots) is left to the derivation, and the
// diff shows where the two disagree. Nothing is guessed: a weapon, item, casting source or
// feature the draft can't place is listed as a TODO comment in the draft.

import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  ABILITIES,
  DAMAGE_TYPES,
  SIZES,
  formatDiag,
  formatExpr,
  loadContent,
  parseYaml,
  plainAlt,
  type CharacterLib,
  type CompiledTemplate,
  type Diag,
  type PcSource,
  type SourceFile,
} from '@montecrit/engine';
import { buildLines, buildNeeds, characterLib, equipmentComment, picksBlock, resolveBuild } from './character.ts';
import { REPO_ROOT, displayPath, enclosingPack, landsInRepo, privateSource, readYamlFiles, writeNewFile } from './files.ts';
import { homeDir, packDirs, readHomeConfig, readKnown, type Env } from './home.ts';
import type { CommandOutput } from './lint.ts';
import { UsageError } from './odds.ts';

export const MIGRATE_USAGE = `usage: montecrit migrate <pc file> --class <id> --species <id> --background <id> [options]

  Drafts a kind: character file from a kind: pc file, writes it beside the pc (or to --out; never
  into the repo's packs/ folder, never over a file), expands both and prints a field-by-field diff
  of their compiled templates. A pc names no class, species or background: give them.

  --class ID        the class, e.g. srd:fighter (the level is the pc's)
  --subclass ID     the subclass
  --species ID      the species
  --background ID   the background
  --id ID           the draft's id (default: the pc's id + -built, or -built-2, -built-3... when
                    that id is already loaded; an --id that is already loaded is refused)
  --out PATH        where to write the draft (default: <pc file>.character.yaml beside it)
  --json            the diff as JSON: { wrote, pc, character, differ: [{ field, pc, character }], same: [fields] }`;

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const signed = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);
const flow = (v: unknown): string => JSON.stringify(v).replace(/"([a-z][a-zA-Z0-9]*)":/g, '$1: ');
const types = (mask: number): string => DAMAGE_TYPES.filter((_, i) => mask & (1 << i)).join(', ') || 'none';

/**
 * A compiled template as named fields, for the diff: the numbers a sheet shows, then attacks,
 * resources, items, spells and features by id. Skill names come from the caller (the engine's
 * SKILLS order, as the derived sheet lists them).
 */
export function templateFields(t: CompiledTemplate, skillNames: readonly string[]): Map<string, string> {
  const m = new Map<string, string>();
  // Attack ids carry the template's id (<id>/<local>); compare by the local part.
  const local = (id: string): string => (id.startsWith(`${t.id}/`) ? id.slice(t.id.length + 1) : id);
  m.set('size', SIZES[t.size]!);
  m.set('ac', String(t.ac));
  m.set('hpMax', String(t.hpMax));
  m.set('speedFt', String(t.speedFt));
  m.set('pb', signed(t.pb));
  m.set('initiative', `${signed(t.initMod)} (score ${t.initScore})`);
  ABILITIES.forEach((a, i) => {
    m.set(`score.${a}`, String(t.scores[i]));
    m.set(`save.${a}`, signed(t.saveMod[i]!));
  });
  t.skillMod.forEach((v, i) => m.set(`skill.${skillNames[i] ?? i}`, signed(v)));
  for (const a of t.attacks) {
    const dmg = a.damage.map((d) => `${formatExpr(d.roll)} ${DAMAGE_TYPES[d.type]}${d.ifAdvantage ? ' (if Advantage)' : ''}`).join(' + ');
    const where = a.kind === 'melee' ? `reach ${a.reachFt}` : `range ${a.normalFt}/${a.longFt}`;
    const g = a.gear >= 0 ? t.gear[a.gear] : undefined;
    m.set(`attack.${local(a.id)}`, `${a.kind} ${signed(a.toHit)}, ${dmg}, ${where}${a.consumesGear && g ? `, uses ${g.name} (${g.count})` : ''}`);
  }
  // A Multiattack's plain Attack action (its last alternative, step E) is its own key, so it
  // doesn't read as one more Multiattack choice ("or 1 x [...]"); absent when there is none.
  const plain = plainAlt(t.attackAct);
  const names = (from: readonly number[]): string => from.map((i) => local(t.attacks[i]!.id)).join(' | ');
  const alts = t.attackAct.alts.filter((_, k) => k !== plain);
  m.set('attackAct', `${t.attackAct.name}${t.attackAct.extraAttack ? ' (Extra Attack)' : ''}: ${alts.map((alt) => alt.map((g) => `${g.count} x [${names(g.from)}]`).join(' + ')).join(' or ')}`);
  if (plain >= 0) m.set('attackAction', `one of [${names(t.attackAct.alts[plain]!.flatMap((g) => g.from))}]`);
  m.set('slots', t.resMax.slice(0, 9).join('/'));
  for (const p of t.pools) m.set(`pool.${p.local}`, `${p.name} ${p.max}`);
  for (const it of t.items) m.set(`item.${it.local}`, `${it.name} (${it.kind}${it.kind === 'shield' ? ` +${it.shieldAc}` : ''}${it.kind === 'focus' ? `: ${it.focusFor.join(', ')}` : ''})`);
  m.set('hands', t.startHands.map((i) => (i < 0 ? 'empty' : t.items[i]!.local)).join(' | '));
  m.set('spells', t.spells.map((e) => `${e.source}/${e.spell.id}`).sort(byString).join(', ') || 'none');
  m.set('features', t.features.map((f) => f.id).sort(byString).join(', ') || 'none');
  m.set('options', t.options.map((o) => o.id).join(', '));
  m.set('resist', types(t.resist));
  m.set('vuln', types(t.vuln));
  m.set('immune', types(t.immune));
  m.set('fidelity', t.fidelity);
  m.set('unimplemented', `${t.unimplemented.length}`);
  m.set('flags', flow(Object.fromEntries(Object.keys(t.flags).sort(byString).map((k) => [k, (t.flags as Record<string, unknown>)[k]]))));
  return m;
}

export interface FieldDiff {
  readonly differ: { readonly field: string; readonly pc: string; readonly character: string }[];
  readonly same: string[];
}

/** Every field either side has, in a stable order: the sheet fields first, then by name. */
export function diffFields(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): FieldDiff {
  const order = [...a.keys()];
  for (const k of b.keys()) if (!order.includes(k)) order.push(k);
  const differ: FieldDiff['differ'][number][] = [];
  const same: string[] = [];
  for (const k of order) {
    const x = a.get(k) ?? '(none)';
    const y = b.get(k) ?? '(none)';
    if (x === y) same.push(k);
    else differ.push({ field: k, pc: x, character: y });
  }
  return { differ, same };
}

type PcRaw = Partial<PcSource> & Record<string, unknown>;

/** The draft's text, mapped field by field from the pc; what can't be placed becomes a TODO comment. */
export function draftText(pc: PcRaw, pcPath: string, lib: CharacterLib, opts: { class: string; subclass?: string; species: string; background: string; id: string }): string {
  const level = typeof pc.level === 'number' ? pc.level : 1;
  const b = resolveBuild(lib, { ...opts, level });
  const { cls, sub, species, bg } = b;
  const { classLine, speciesLines, backgroundLines, castingSources } = buildLines(lib, b, level);
  const todo: string[] = [];
  const localOf = (id: string): string => id.slice(id.indexOf(':') + 1).split('/').pop()!;

  // Skills: the pc's proficiencies the class choice offers (the background's own come free).
  const filled = new Map<string, string>();
  const skills = (pc.skills ?? {}) as { proficient?: string[]; expertise?: string[] };
  const proficient = [...(skills.proficient ?? [])];
  const fromBg = new Set(bg!.skills);
  const clsSkillChoice = cls.choices.find((c) => c.id === 'skills');
  const offered = clsSkillChoice?.from.skills ?? cls.skills.from;
  const choose = clsSkillChoice?.choose ?? cls.skills.choose;
  const take = proficient.filter((s) => !fromBg.has(s) && (offered as readonly string[]).includes(s)).slice(0, choose);
  if (take.length > 0) filled.set(`${cls.id}#skills`, `[${take.join(', ')}]`);
  const placed = new Set([...take, ...fromBg]);
  const unplaced = proficient.filter((s) => !placed.has(s));
  if (unplaced.length > 0) todo.push(`skill proficiencies the class choice and background don't give: ${unplaced.join(', ')} (from a species or feat pick?)`);
  if ((skills.expertise ?? []).length > 0) todo.push(`expertise: ${(skills.expertise ?? []).join(', ')} (place it in an expertise pick)`);

  // Weapons by local id; a stack keeps its count when the weapon is thrown.
  const weapons: string[] = [];
  for (const w of (pc.weapons ?? []) as { id: string; name: string; count?: number }[]) {
    const matches = [...lib.weapons.values()].filter((x) => localOf(x.id) === w.id).sort((a, c) => byString(a.id, c.id));
    if (matches.length !== 1) {
      todo.push(`weapon ${w.id} (${w.name}): ${matches.length === 0 ? 'no loaded weapon has that id' : `several match (${matches.map((x) => x.id).join(', ')})`}`);
      continue;
    }
    const thrown = (matches[0]!.properties as readonly string[]).includes('thrown');
    weapons.push(w.count !== undefined && thrown ? `{ id: ${matches[0]!.id}, count: ${w.count} }` : matches[0]!.id);
  }
  // Items: a shield becomes equipment.shield; others carry over as they are.
  const rawItems = (pc.items ?? []) as { id: string; kind: string }[];
  const shieldItem = rawItems.find((it) => it.kind === 'shield');
  const items = rawItems.filter((it) => it.kind !== 'shield');
  const hands = (pc.hands ?? null) as (string | null)[] | null;
  const handLine = hands && hands.some((h) => h !== null) ? `  hands: [${hands.map((h) => (h === null ? 'null' : h === shieldItem?.id ? 'shield' : h)).join(', ')}]` : null;

  // Casting: the class's (or subclass's) own source carries over; item sources don't.
  const castingLines: string[] = [];
  for (const c of (pc.casting ?? []) as { source: string; cantrips?: string[]; prepared?: string[]; always?: string[]; whileHeld?: string; free?: unknown[] }[]) {
    const src = castingSources.find((s) => localOf(s) === c.source);
    if (src === undefined) {
      todo.push(`casting source ${c.source}: not the class's or subclass's spellcasting (an item's or feature's spells): add them by hand`);
      continue;
    }
    castingLines.push(`  - { source: ${src}, cantrips: [${(c.cantrips ?? []).join(', ')}], prepared: [${(c.prepared ?? []).join(', ')}] }`);
    if ((c.always ?? []).length > 0 || c.whileHeld !== undefined || (c.free ?? []).length > 0) todo.push(`casting ${c.source}: always, whileHeld and free don't carry over (always-prepared spells come from the subclass data)`);
  }
  for (const s of castingSources) if (!castingLines.some((l) => l.includes(`source: ${s},`))) castingLines.push(`  - { source: ${s}, cantrips: [], prepared: [] }`);
  for (const p of (pc.pools ?? []) as { id: string; name: string }[]) todo.push(`pool ${p.id} (${p.name}): pools come from the class, subclass and species data; check it's there`);
  if ((pc.resist ?? []).length > 0) todo.push(`resist ${(pc.resist ?? []).join(', ')}: resistances come from the species`);
  if (pc.initiativeBonus !== undefined) todo.push(`initiativeBonus ${String(pc.initiativeBonus)}: add an overrides.initiativeBonus with its reason if it still applies`);

  const needs = buildNeeds(lib, cls, sub, species, bg, level);
  const featureIds = ((pc.features ?? []) as string[]).filter((id) => typeof id === 'string');
  const ab = pc.abilities as Record<string, number> | undefined;
  const lines = [
    `# Drafted by montecrit migrate from ${basename(pcPath)} (kind: pc). Check every TODO, then: montecrit build <this file>`,
    `# The pc stated hpMax ${String(pc.hpMax)}, AC ${String(pc.ac)} and speed ${String(pc.speed)} by hand; here they are derived (the migrate diff shows any difference).`,
    'kind: character',
    `id: ${opts.id}`,
    `name: ${JSON.stringify(String(pc.name ?? opts.id))}`,
    `source: ${JSON.stringify(String(pc.source ?? 'character file'))}`,
    ...(pc.placeholder === true ? ['placeholder: true'] : []),
    ...(Array.isArray(pc.unimplemented) && pc.unimplemented.length > 0 ? ['unimplemented:', ...(pc.unimplemented as string[]).map((u) => `  - ${JSON.stringify(u)}`)] : []),
    "rules: '2024'",
    ...classLine,
    ...speciesLines.map((l) => (l.startsWith('size: ') && typeof pc.size === 'string' ? `size: ${pc.size}` : l)),
    ...backgroundLines,
    `abilities: { ${ABILITIES.map((a) => `${a}: ${ab?.[a] ?? 10}`).join(', ')} }`,
    'hp: average',
    ...picksBlock(needs, filled),
    ...equipmentComment(lib, cls),
    '# TODO armor: the pc states its AC by hand; name the worn armor (or keep null for none)',
    'equipment:',
    '  armor: null',
    `  shield: ${shieldItem ? 'true' : 'false'}`,
    `  weapons: [${weapons.join(', ')}]`,
    ...(items.length > 0 ? ['  items:', ...items.map((it) => `    - ${flow(it)}`)] : []),
    ...(handLine ? [handLine] : []),
    ...(castingLines.length > 0 ? ['casting:', ...castingLines] : []),
    ...(featureIds.length > 0 ? [`# features the pc lists; any the build already grants is reported as granted twice, so delete those`, `features: [${featureIds.join(', ')}]`] : []),
    ...(pc.flags && Object.keys(pc.flags).length > 0 ? [`flags: ${flow(pc.flags)}`] : []),
    ...(todo.length > 0 ? ['# TODO, not carried over:', ...todo.map((t) => `#   - ${t}`)] : []),
    '',
  ];
  return lines.join('\n');
}

const show = (d: Diag): string => formatDiag({ ...d, path: displayPath(d.path) });

export function runMigrate(argv: readonly string[], env: Env = process.env, repoRoot: string = REPO_ROOT): CommandOutput {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      class: { type: 'string' },
      subclass: { type: 'string' },
      species: { type: 'string' },
      background: { type: 'string' },
      id: { type: 'string' },
      out: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help) return { out: MIGRATE_USAGE, err: '', code: 0 };
  if (positionals.length !== 1) throw new UsageError('migrate takes exactly one pc file');
  const pcPath = resolve(positionals[0]!);
  const missing = (['class', 'species', 'background'] as const).filter((k) => values[k] === undefined);
  if (missing.length > 0) throw new UsageError(`migrate needs ${missing.map((m) => `--${m}`).join(', ')}: a kind: pc names no class, species or background`);

  const read = readYamlFiles([pcPath], repoRoot);
  if (read.errors.length > 0 || read.files.length !== 1) return { out: '', err: [...read.errors.map(show), `migrate: can't read ${positionals[0]}`].join('\n'), code: 1 };
  const pcFile = read.files[0]!;
  const parsed = parseYaml(pcFile.text, pcFile.path);
  const pc = parsed.doc?.value as PcRaw | null | undefined;
  if (!pc || typeof pc !== 'object' || Array.isArray(pc) || pc.kind !== 'pc' || typeof pc.id !== 'string') {
    return { out: '', err: [...parsed.errors.map(show), `migrate: ${displayPath(pcPath)} isn't a kind: pc file with an id`].join('\n'), code: 1 };
  }
  const ns = pc.id.slice(0, pc.id.indexOf(':'));
  const out = resolve(values.out ?? join(dirname(pcPath), `${basename(pcPath).replace(/\.ya?ml$/i, '')}.character.yaml`));
  // The draft carries the pc's name, kit and TODO details whatever --id says, so a private pc
  // never drafts into the repo, even relabelled with a test: id (rule 2; review finding
  // cli-migrate-private-relabel).
  const cfg = readHomeConfig(env);
  const homeDirs = [homeDir(env), cfg.characters, ...cfg.packs];
  const priv = privateSource(pcPath, pcFile.text, homeDirs);
  if (priv !== null && landsInRepo(out, repoRoot)) {
    return { out: '', err: `migrate: refused: ${displayPath(pcPath)} is private (${priv}), so its draft can't be written under the repo root (${displayPath(out)}); write it into ~/.montecrit/ instead`, code: 2 };
  }

  // The content the pc can reach: the known packs, plus its own pack when that isn't one of them.
  const known = readKnown(env, [], repoRoot);
  const files: SourceFile[] = [...known.files];
  const errors: Diag[] = [...known.errors];
  const packDir = enclosingPack(pcPath);
  if (packDir !== undefined && !packDirs(env, repoRoot).dirs.some((d) => resolve(d) === resolve(packDir))) {
    const own = readYamlFiles([packDir], repoRoot);
    errors.push(...own.errors);
    for (const f of own.files) if (!files.some((x) => x.path === f.path)) files.push(f);
  }
  const base = loadContent(files);
  if (!base.content || errors.length > 0) return { out: '', err: [...errors, ...base.errors].map(show).concat(`migrate: content has errors; run montecrit lint`).join('\n'), code: 1 };
  const lib = characterLib(files);
  // The draft must be loadable beside everything already loaded, so its id must be free
  // (a committed test:sample-fighter-built would otherwise shadow the default draft).
  if (values.id !== undefined && lib.kinds.has(values.id)) return { out: '', err: `migrate: --id ${values.id} is already loaded (a ${lib.kinds.get(values.id)!}); pick another id`, code: 2 };
  let id = values.id ?? `${pc.id}-built`;
  for (let k = 2; lib.kinds.has(id); k++) id = `${pc.id}-built-${k}`;

  const text = draftText(pc, pcPath, lib, { class: values.class!, ...(values.subclass !== undefined ? { subclass: values.subclass } : {}), species: values.species!, background: values.background!, id });
  const why = writeNewFile(out, text, repoRoot);
  if (why !== null) return { out: '', err: `migrate: ${why}`, code: 2 };

  // Both, expanded in memory under scratch ids in a scratch pack (never written), so neither
  // collides with a loaded copy of itself.
  const scratchDir = join(dirname(pcPath), '__montecrit-migrate__');
  const scratchPc = `${ns}:migrate-scratch-pc`;
  const scratchChar = `${ns}:migrate-scratch-character`;
  const draftDoc = parseYaml(text, out).doc?.value as Record<string, unknown>;
  const license = ns === 'srd' ? "license: CC-BY-4.0\nattribution: 'in-memory scratch copy for montecrit migrate'" : `license: ${ns}`;
  const scratch: SourceFile[] = [
    { path: join(scratchDir, 'manifest.yaml'), text: `kind: manifest\npack: migrate-scratch\nversion: '1'\nrules: '2024'\nnamespace: ${ns}\n${license}\n` },
    { path: join(scratchDir, 'pc.yaml'), text: JSON.stringify({ ...pc, id: scratchPc }) },
    { path: join(scratchDir, 'character.yaml'), text: JSON.stringify({ ...draftDoc, id: scratchChar }) },
  ];
  const r = loadContent([...files, ...scratch]);
  const inScratch = (d: Diag) => d.path.startsWith(scratchDir);
  const notes = [...r.errors.filter(inScratch).map((d) => `error: ${d.message}`), ...r.warnings.filter((d) => d.path === join(scratchDir, 'character.yaml')).map((d) => `warning: ${d.message}`)];
  const pcTpl = r.content?.get(scratchPc);
  const charTpl = r.content?.get(scratchChar);
  const sheet = (r.sheets ?? []).find((s) => s.id === scratchChar);
  const wrote = `wrote ${displayPath(out)} (draft character ${id} from ${displayPath(pcPath)})`;
  if (!pcTpl || !charTpl) {
    const lines = [wrote, 'the diff needs both to compile:', ...notes.map((n) => `  ${n}`), ...r.errors.filter((d) => !inScratch(d)).map((d) => `  ${show(d)}`)];
    return { out: lines.join('\n'), err: '', code: 1 };
  }
  const skillNames = sheet ? sheet.skills.map((s) => s.skill) : [];
  const fields = (t: CompiledTemplate) => templateFields(t, skillNames);
  const diff = diffFields(fields(pcTpl), fields(charTpl));
  if (values.json) {
    return { out: JSON.stringify({ wrote: displayPath(out), pc: pc.id, character: id, differ: diff.differ, same: diff.same, lint: notes }, null, 2), err: '', code: 0 };
  }
  const w = Math.max(5, ...diff.differ.map((d) => d.field.length));
  const lines = [
    wrote,
    `template diff, pc ${pc.id} vs character ${id} (${diff.differ.length} field(s) differ, ${diff.same.length} the same):`,
    ...diff.differ.map((d) => `  ${d.field.padEnd(w)}  pc ${d.pc}  |  character ${d.character}`),
    `same: ${diff.same.join(', ')}`,
    `draft lint (${notes.length}):`,
    ...notes.map((n) => `  ${n}`),
    `next: edit the draft's TODOs, then montecrit build ${displayPath(out)}`,
  ];
  return { out: lines.join('\n'), err: '', code: 0 };
}
