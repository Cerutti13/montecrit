// loadContent: {path, text}[] -> Content. Parse -> validate -> resolve -> lint -> compile.
// The engine never touches the filesystem; apps read files and hand over text. Inputs are
// sorted by path here, so the caller's order can never change the result, and the content
// hash covers only validated items (never paths, comments, key order or file order).

import { canonicalJson } from '../util/canon.ts';
import { fnv1a32, hash64 } from '../util/hash.ts';
import { expandCharacter, type CharacterLib, type DerivedSheet } from './character.ts';
import { compileMonster, compilePc, errorAt, type ItemCtx } from './compile.ts';
import { checkFeature, compileSpellDef, type FeatureDef, type Library, type SpellDef } from './compile-spell.ts';
import { DATA_KINDS, checkDataItem, type DataItem } from './data-kinds.ts';
import { lintFeature, lintMonster, lintPc, lintSpell } from './lint.ts';
import {
  ArmorSchema,
  BackgroundSchema,
  CharacterSchema,
  ClassSchema,
  FeatSchema,
  FeatureSchema,
  ManifestSchema,
  MonsterSchema,
  PcSchema,
  SpeciesSchema,
  SpellSchema,
  SubclassSchema,
  WeaponSchema,
  type ArmorSource,
  type BackgroundSource,
  type CharacterSource,
  type ClassSource,
  type FeatSource,
  type FeatureSource,
  type ManifestSource,
  type MonsterSource,
  type PcSource,
  type SpeciesSource,
  type SpellSource,
  type SubclassSource,
  type WeaponSource,
} from './schema.ts';
import type { CompiledTemplate, Content, PackInfo } from './types.ts';
import { compareDiags, diagAt, formatPath, parseYaml, zodDiags, type Diag, type SourceDoc, type SourceFile, type YamlPath } from './yaml.ts';

export interface LoadResult {
  /** Null when there is any error. */
  readonly content: Content | null;
  readonly errors: readonly Diag[];
  readonly warnings: readonly Diag[];
  /**
   * The derived sheet of every kind: character item that expanded, sorted by id (docs/design/m3.md
   * 2.6). Present even when the load has errors elsewhere; it enters no hash. Always set by
   * loadContent (optional only so callers that build a LoadResult of their own still type-check).
   */
  readonly sheets?: readonly DerivedSheet[];
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

class LoadedContent implements Content {
  readonly templates: readonly CompiledTemplate[];
  readonly packs: readonly PackInfo[];
  readonly hash: string;
  readonly #index: ReadonlyMap<string, CompiledTemplate>;

  constructor(templates: readonly CompiledTemplate[], packs: readonly PackInfo[], hash: string) {
    this.templates = templates;
    this.packs = packs;
    this.hash = hash;
    this.#index = new Map(templates.map((t) => [t.id, t]));
  }

  get(id: string): CompiledTemplate | undefined {
    return this.#index.get(id);
  }
}

interface Pack {
  readonly dir: string;
  readonly doc: SourceDoc;
  readonly src: ManifestSource;
  readonly info: PackInfo;
}

type ItemSource =
  | { kind: 'monster'; src: MonsterSource }
  | { kind: 'pc'; src: PcSource }
  | { kind: 'spell'; src: SpellSource }
  | { kind: 'feature'; src: FeatureSource }
  | { kind: 'character'; src: CharacterSource }
  | DataItem;

const ITEM_SCHEMAS = {
  monster: MonsterSchema,
  pc: PcSchema,
  character: CharacterSchema,
  spell: SpellSchema,
  feature: FeatureSchema,
  class: ClassSchema,
  subclass: SubclassSchema,
  species: SpeciesSchema,
  background: BackgroundSchema,
  feat: FeatSchema,
  weapon: WeaponSchema,
  armor: ArmorSchema,
} as const;
type ItemKind = keyof typeof ITEM_SCHEMAS;
const isItemKind = (k: unknown): k is ItemKind => typeof k === 'string' && Object.hasOwn(ITEM_SCHEMAS, k);
const isDataKind = (k: string): k is DataItem['kind'] => (DATA_KINDS as readonly string[]).includes(k);

interface Item {
  readonly doc: SourceDoc;
  readonly prefix: YamlPath;
  readonly item: ItemSource;
  pack?: Pack;
}

const dirOf = (path: string): string => {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
};
const baseOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** The pack whose manifest sits in the nearest ancestor folder of path. */
function packFor(path: string, packsByDir: ReadonlyMap<string, Pack>): Pack | undefined {
  let dir = dirOf(path);
  for (;;) {
    const p = packsByDir.get(dir);
    if (p) return p;
    if (dir === '') return undefined;
    dir = dirOf(dir);
  }
}

const PRIVATE_REF = /\bprivate:[a-z0-9]/;

/** Every string under value that mentions a private id, with its path. */
function privateRefs(value: unknown, p: (string | number)[], out: (string | number)[][]): void {
  if (typeof value === 'string') {
    if (PRIVATE_REF.test(value)) out.push([...p]);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => privateRefs(v, [...p, i], out));
  } else if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort(byString);
    for (const k of keys) privateRefs((value as Record<string, unknown>)[k], [...p, k], out);
  }
}

function rawItem(value: unknown, prefix: YamlPath): unknown {
  let v = value;
  for (const seg of prefix) v = (v as Record<string | number, unknown>)[seg];
  return v;
}

export function loadContent(files: readonly SourceFile[]): LoadResult {
  const errors: Diag[] = [];
  const warnings: Diag[] = [];
  const sorted = [...files].sort((a, b) => byString(a.path, b.path));

  // 1. Parse and validate.
  const manifests: { doc: SourceDoc; src: ManifestSource }[] = [];
  const items: Item[] = [];
  for (let f = 0; f < sorted.length; f++) {
    const file = sorted[f]!;
    if (f > 0 && sorted[f - 1]!.path === file.path) {
      errors.push({ path: file.path, line: 0, col: 0, message: 'the same path was passed twice' });
      continue;
    }
    const { doc, errors: yamlErrors } = parseYaml(file.text, file.path);
    errors.push(...yamlErrors);
    if (!doc) continue;
    if (doc.value === null || doc.value === undefined) {
      errors.push(diagAt(doc, [], 'empty file'));
      continue;
    }
    const isManifestFile = baseOf(file.path) === 'manifest.yaml';
    const entries: { value: unknown; prefix: YamlPath }[] = Array.isArray(doc.value)
      ? doc.value.map((value, i) => ({ value, prefix: [i] }))
      : [{ value: doc.value, prefix: [] }];
    for (const { value, prefix } of entries) {
      const kind = value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>).kind : undefined;
      if (kind === 'manifest') {
        if (!isManifestFile || prefix.length > 0) {
          errors.push(diagAt(doc, [...prefix, 'kind'], 'a pack manifest must be the only item in a file named manifest.yaml'));
          continue;
        }
        const r = ManifestSchema.safeParse(value);
        if (r.success) manifests.push({ doc, src: r.data });
        else errors.push(...zodDiags(doc, prefix, r.error));
      } else if (isItemKind(kind)) {
        if (isManifestFile) {
          errors.push(diagAt(doc, [...prefix, 'kind'], 'manifest.yaml holds only the pack manifest'));
          continue;
        }
        const r = ITEM_SCHEMAS[kind].safeParse(value);
        if (r.success) items.push({ doc, prefix, item: { kind, src: r.data } as ItemSource });
        else errors.push(...zodDiags(doc, prefix, r.error));
      } else if (kind === 'scenario' || kind === 'journal') {
        errors.push(diagAt(doc, [...prefix, 'kind'], `a ${kind} isn't pack content; it's checked against loaded content separately`));
      } else {
        errors.push(diagAt(doc, [...prefix, 'kind'], `unknown or missing kind${typeof kind === 'string' ? ` "${kind}"` : ''} (expected manifest, monster, pc, character, spell, feature, ${DATA_KINDS.slice(0, -1).join(', ')} or ${DATA_KINDS[DATA_KINDS.length - 1]})`));
      }
    }
  }

  // 2. Packs.
  const packsByDir = new Map<string, Pack>();
  const packsByName = new Map<string, Pack>();
  for (const { doc, src } of manifests) {
    const dir = dirOf(doc.path);
    const prev = packsByName.get(src.pack);
    if (prev) {
      errors.push(diagAt(doc, ['pack'], `pack "${src.pack}" is already defined by ${prev.doc.path}`));
      continue;
    }
    const pack: Pack = {
      dir,
      doc,
      src,
      info: { pack: src.pack, namespace: src.namespace, license: src.license, attribution: src.attribution ?? null },
    };
    packsByDir.set(dir, pack);
    packsByName.set(src.pack, pack);
  }
  for (const pack of packsByName.values()) {
    pack.src.requires.forEach((name, i) => {
      const req = packsByName.get(name);
      if (!req) errors.push(diagAt(pack.doc, ['requires', i], `requires pack "${name}", which isn't loaded`));
      else if (pack.src.namespace !== 'private' && req.src.namespace === 'private') {
        errors.push(diagAt(pack.doc, ['requires', i], `${pack.src.namespace} packs may not depend on private content (pack "${name}")`));
      }
    });
    if (pack.src.namespace !== 'private') {
      const refs: (string | number)[][] = [];
      privateRefs(pack.doc.value, [], refs);
      for (const r of refs) errors.push(diagAt(pack.doc, r, `${pack.src.namespace} packs may not reference private content`));
    }
  }

  // 3. Resolve ids.
  const seen = new Map<string, Item>();
  for (const it of items) {
    const { src } = it.item;
    const id = src.id;
    const ns = id.slice(0, id.indexOf(':'));
    const pack = packFor(it.doc.path, packsByDir);
    if (!pack) {
      errors.push(diagAt(it.doc, [...it.prefix, 'id'], 'not inside a pack (no manifest.yaml in any parent folder)'));
      continue;
    }
    it.pack = pack;
    if (ns === 'core') {
      errors.push(diagAt(it.doc, [...it.prefix, 'id'], `${id}: core ids are engine primitives; packs can't define them`));
      continue;
    }
    if (ns === 'test' && pack.src.license !== 'test') {
      errors.push(diagAt(it.doc, [...it.prefix, 'id'], `${id}: test ids load only from license: test packs (pack "${pack.src.pack}" is ${pack.src.license})`));
      continue;
    }
    if (ns !== pack.src.namespace) {
      errors.push(diagAt(it.doc, [...it.prefix, 'id'], `${id} is outside pack "${pack.src.pack}"'s namespace (${pack.src.namespace}:)`));
      continue;
    }
    const prev = seen.get(id);
    if (prev) {
      const at = prev.doc.at([...prev.prefix, 'id']);
      errors.push(diagAt(it.doc, [...it.prefix, 'id'], `duplicate id ${id} (first defined at ${prev.doc.path}:${at.line}:${at.col})`));
      continue;
    }
    seen.set(id, it);
    if (pack.src.namespace !== 'private') {
      const refs: (string | number)[][] = [];
      privateRefs(rawItem(it.doc.value, it.prefix), [...it.prefix], refs);
      for (const r of refs) errors.push(diagAt(it.doc, r, `${pack.src.namespace} packs may not reference private content`));
    }
  }

  // 4. Lint and compile, in id order: spells and features first, then creatures, which bind
  // the spells and features they list.
  const resolved = [...seen.values()].sort((a, b) => byString(a.item.src.id, b.item.src.id));
  const ctxOf = (it: Item): ItemCtx => ({ doc: it.doc, prefix: it.prefix, errors, warnings });
  const kinds = new Map<string, string>(resolved.map((it) => [it.item.src.id, it.item.kind]));
  const spells = new Map<string, SpellDef>();
  const features = new Map<string, FeatureDef>();
  for (const it of resolved) {
    if (it.item.kind === 'spell') {
      lintSpell(it.item.src, ctxOf(it));
      // The spell id's hash, not a load-order index: what else is loaded must never change a scenario's content hash.
      spells.set(it.item.src.id, compileSpellDef(it.item.src, fnv1a32(it.item.src.id) >>> 1, ctxOf(it)));
    } else if (it.item.kind === 'feature') {
      lintFeature(it.item.src, ctxOf(it));
      features.set(it.item.src.id, checkFeature(it.item.src, ctxOf(it)));
    }
  }
  const lib: Library = { spells, features, kinds };
  // Character-building data: checked, compiled into nothing yet (data-kinds.ts).
  const classes = new Map<string, ClassSource>();
  const feats = new Map<string, FeatSource>();
  for (const it of resolved) {
    if (it.item.kind === 'class') classes.set(it.item.src.id, it.item.src);
    else if (it.item.kind === 'feat') feats.set(it.item.src.id, it.item.src);
  }
  for (const it of resolved) if (isDataKind(it.item.kind)) checkDataItem(it.item as DataItem, ctxOf(it), { kinds, classes, feats });
  const charLib: CharacterLib = {
    kinds,
    classes,
    feats,
    subclasses: byKind<SubclassSource>(resolved, 'subclass'),
    species: byKind<SpeciesSource>(resolved, 'species'),
    backgrounds: byKind<BackgroundSource>(resolved, 'background'),
    weapons: byKind<WeaponSource>(resolved, 'weapon'),
    armor: byKind<ArmorSource>(resolved, 'armor'),
    features: byKind<FeatureSource>(resolved, 'feature'),
  };
  const templates: CompiledTemplate[] = [];
  const sheets: DerivedSheet[] = [];
  for (const it of resolved) {
    const ctx = ctxOf(it);
    let tpl: CompiledTemplate | null;
    if (it.item.kind === 'monster') {
      lintMonster(it.item.src, ctx);
      tpl = compileMonster(it.item.src, ctx);
    } else if (it.item.kind === 'pc') {
      lintPc(it.item.src, ctx, lib);
      tpl = compilePc(it.item.src, ctx, lib);
    } else if (it.item.kind === 'character') {
      // A character expands to a PcSource (character.ts) and compiles exactly like a kind: pc.
      const ex = expandCharacter(it.item.src, charLib);
      for (const is of ex.issues) (is.severity === 'error' ? errors : warnings).push(diagAt(it.doc, [...it.prefix, ...is.path], is.path.length > 0 ? `${formatPath(is.path)}: ${is.message}` : is.message));
      if (!ex.pc || ex.issues.some((is) => is.severity === 'error')) {
        if (ex.sheet) sheets.push(ex.sheet);
        continue;
      }
      // Diagnostics about the derived pc point at the character-file node it came from.
      const derived: ItemCtx = { doc: derivedDoc(it.doc, it.prefix, ex.pathOf), prefix: it.prefix, errors: [], warnings: [] };
      tpl = compilePc(ex.pc, derived, lib, ex.scale, ex.scaleAmbiguous);
      for (const d of derived.errors) errors.push({ ...d, message: `derived pc: ${d.message}` });
      for (const d of derived.warnings) warnings.push({ ...d, message: `derived pc: ${d.message}` });
      if (ex.sheet) sheets.push(tpl ? { ...ex.sheet, unimplemented: [...tpl.unimplemented], fidelity: tpl.unimplemented.length > 0 ? 'partial' : 'full' } : ex.sheet);
      if (!tpl) continue;
    } else continue;
    if (tpl) templates.push(tpl);
    else if (errors.length === 0) errorAt(ctx, ['id'], 'failed to compile');
  }

  errors.sort(compareDiags);
  warnings.sort(compareDiags);
  sheets.sort((a, b) => byString(a.id, b.id));
  if (errors.length > 0) return { content: null, errors, warnings, sheets };

  const packs = [...packsByName.values()].sort((a, b) => byString(a.src.pack, b.src.pack));
  const hash = hash64(
    canonicalJson({
      packs: packs.map((p) => p.src),
      items: resolved.map((it) => it.item.src),
    }),
  );
  return {
    content: new LoadedContent(templates, packs.map((p) => p.info), hash),
    errors,
    warnings,
    sheets,
  };
}

/** The validated sources of one kind, by id. */
function byKind<T>(resolved: readonly Item[], kind: string): Map<string, T> {
  const m = new Map<string, T>();
  for (const it of resolved) if (it.item.kind === kind) m.set(it.item.src.id, it.item.src as T);
  return m;
}

/** A character file's doc, seen through the derived pc's paths (CharacterExpansion.pathOf). */
function derivedDoc(doc: SourceDoc, prefix: YamlPath, pathOf: (p: YamlPath) => YamlPath): SourceDoc {
  const map = (p: YamlPath): YamlPath => [...prefix, ...pathOf(p.slice(prefix.length))];
  return { path: doc.path, value: doc.value, at: (p) => doc.at(map(p)), keyAt: (p, key) => doc.keyAt(map(p), key) };
}

/** hash64 over the compiled templates with these ids (sorted, deduplicated): what a scenario reaches. */
export function closureHash(content: Content, ids: readonly string[]): string {
  const unique = [...new Set(ids)].sort(byString);
  return hash64(canonicalJson(unique.map((id) => content.get(id) ?? null)));
}
