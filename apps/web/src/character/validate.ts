// The Character screen's live check (docs/design/m3.md 10, "Web"): a pane's YAML through the same
// stages as `montecrit build`. Pure: texts in, data out.
//  1. YAML: parse errors with their lines.
//  2. Schema: zod issues (CharacterSchema or PcSchema), each with its path and line.
//  3. Character lint and expansion: expandCharacter against the loaded CharacterLib; its issues
//     with their paths, and the derived sheet.
//  4. Compile check: the whole content set loaded with the pane's text in place of its file (or
//     as a draft inside a pack of its namespace), for what only compiling finds (the derived pc,
//     duplicate ids, namespaces) and the compiled fidelity. Slower, so the screen debounces it.

import { CharacterSchema, PcSchema, expandCharacter, loadContent, parseYaml, peekKind, type CharacterLib, type DerivedSheet, type SourceDoc, type SourceFile, type YamlPath } from '@montecrit/engine';
import { privateMarker } from '@montecrit/host';
import { byString } from './lib.ts';

export interface CharacterEntry {
  /** The file's path in the content set ('repo/packs/...', 'home/...'). */
  readonly path: string;
  readonly id: string;
  readonly name: string;
  readonly kind: 'character' | 'pc';
  /** characterOrigin's: 'home' for a home file or a private pack's; the screen marks them PRIVATE. */
  readonly origin: 'repo' | 'home';
  readonly text: string;
}

/**
 * The one rule for a character's origin, shared by this screen and the Run panel's catalog: Home
 * (marked PRIVATE) when its file comes from the home folder (a 'home/' path) or its pack's license
 * is private; else repo.
 */
export function characterOrigin(path: string | null, license: string | undefined): 'repo' | 'home' {
  return (path !== null && path.startsWith('home/')) || license === 'private' ? 'home' : 'repo';
}

/** The pack licenses by namespace, from the manifests in the set (any private one wins). */
export function packLicenses(packs: readonly SourceFile[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of packs) {
    if (!f.path.endsWith('/manifest.yaml')) continue;
    const { doc } = parseYaml(f.text, f.path);
    const v = doc?.value as Record<string, unknown> | null | undefined;
    if (typeof v?.namespace !== 'string' || typeof v.license !== 'string') continue;
    if (out.get(v.namespace) !== 'private') out.set(v.namespace, v.license);
  }
  return out;
}

const nsOf = (id: string): string => (id.includes(':') ? id.slice(0, id.indexOf(':')) : '');

/** Every kind: character or kind: pc file in the content set's packs, characters first, then by id. */
export function listCharacters(packs: readonly SourceFile[]): CharacterEntry[] {
  const out: CharacterEntry[] = [];
  const licenses = packLicenses(packs);
  for (const f of packs) {
    const kind = peekKind(f.text);
    if (kind !== 'character' && kind !== 'pc') continue;
    const { doc } = parseYaml(f.text, f.path);
    const v = doc?.value as Record<string, unknown> | null | undefined;
    if (!v || typeof v.id !== 'string') continue;
    out.push({ path: f.path, id: v.id, name: typeof v.name === 'string' ? v.name : v.id, kind, origin: characterOrigin(f.path, licenses.get(nsOf(v.id))), text: f.text });
  }
  return out.sort((a, b) => (a.kind !== b.kind ? (a.kind === 'character' ? -1 : 1) : byString(a.id, b.id)));
}

/** One problem at a place in the pane's text. */
export interface Issue {
  readonly severity: 'error' | 'warning';
  /** 'picks.srd:monk#skills', or '' for the whole file. */
  readonly path: string;
  /** 1-based; 0 when unknown. */
  readonly line: number;
  readonly message: string;
}

export interface CheckResult {
  readonly kind: 'character' | 'pc' | null;
  readonly id: string | null;
  /** The text carries a private license or a private id. */
  readonly privateText: boolean;
  readonly yaml: readonly Issue[];
  readonly schema: readonly Issue[];
  /** The character lint: expandCharacter's issues. */
  readonly lint: readonly Issue[];
  /** The derived sheet (expansion only; compileCheck's has the compiled fidelity). */
  readonly sheet: DerivedSheet | null;
}

/** 'picks.srd:monk#skills[0]' */
export function formatPath(p: readonly PropertyKey[]): string {
  let out = '';
  for (const seg of p) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out === '' ? String(seg) : `.${String(seg)}`;
  }
  return out;
}

interface ZodIssueLike {
  readonly code: string;
  readonly path: readonly PropertyKey[];
  readonly message: string;
  readonly keys?: readonly string[];
}

/** Whether a path reaches a value in the parsed document. */
function present(v: unknown, p: YamlPath): boolean {
  let cur = v;
  for (const seg of p) {
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, seg)) return false;
    cur = (cur as Record<string | number, unknown>)[seg];
  }
  return true;
}

const lineAt = (doc: SourceDoc, p: YamlPath): number => doc.at(p).line;

/** zod issues as path-and-line issues; an unknown key is reported at the key itself. */
export function schemaIssues(doc: SourceDoc, issues: readonly ZodIssueLike[]): Issue[] {
  const out: Issue[] = [];
  for (const is of issues) {
    const p = is.path.filter((s): s is string | number => typeof s !== 'symbol');
    if (is.code === 'unrecognized_keys' && is.keys) {
      for (const k of is.keys) out.push({ severity: 'error', path: formatPath([...p, k]), line: doc.keyAt(p, k).line, message: `unknown key "${k}"` });
      continue;
    }
    if ((is.code === 'invalid_type' || is.code === 'invalid_value') && p.length > 0 && !present(doc.value, p)) {
      const parent = formatPath(p.slice(0, -1));
      out.push({ severity: 'error', path: parent, line: lineAt(doc, p), message: `missing required key "${String(p[p.length - 1])}"` });
      continue;
    }
    out.push({ severity: 'error', path: formatPath(p), line: lineAt(doc, p), message: is.message });
  }
  return out;
}

/** An empty or whitespace-only pane: nothing to check, so no errors and no status count. */
export const isEmptyPane = (text: string): boolean => text.trim() === '';

/** The status line under the pane. */
export function paneStatus(text: string, errors: number, warnings: number, clean: boolean, compile: CompileResult | null): string {
  if (isEmptyPane(text)) return 'Empty.';
  const tail = clean ? (compile ? (compile.skipped !== null ? ` · compile check skipped: ${compile.skipped}` : ' · compile check done') : ' · compile check pending') : '';
  return `${errors} error(s), ${warnings} warning(s)${tail}`;
}

/** Stages 1-3: YAML, schema, character lint and expansion. Fast enough for every keystroke. */
export function checkCharacter(text: string, lib: CharacterLib, path = 'character.yaml'): CheckResult {
  const privateText = privateMarker(text) !== null;
  const empty = { kind: null, id: null, privateText, yaml: [], schema: [], lint: [], sheet: null } as const;
  if (isEmptyPane(text)) return empty;
  const { doc, errors } = parseYaml(text, path);
  if (!doc) return { ...empty, yaml: errors.map((d) => ({ severity: 'error', path: '', line: d.line, message: d.message })) };
  const v = doc.value as Record<string, unknown> | null;
  const kind = v && typeof v === 'object' && !Array.isArray(v) ? v.kind : undefined;
  const id = v && typeof v === 'object' && typeof v.id === 'string' ? v.id : null;
  if (kind !== 'character' && kind !== 'pc') {
    return { ...empty, id, schema: [{ severity: 'error', path: 'kind', line: lineAt(doc, ['kind']), message: `expected kind: character (or kind: pc)${typeof kind === 'string' ? `, got "${kind}"` : ''}` }] };
  }
  if (kind === 'pc') {
    const r = PcSchema.safeParse(v);
    return { ...empty, kind, id, schema: r.success ? [] : schemaIssues(doc, r.error.issues as readonly ZodIssueLike[]) };
  }
  const r = CharacterSchema.safeParse(v);
  if (!r.success) return { ...empty, kind, id, schema: schemaIssues(doc, r.error.issues as readonly ZodIssueLike[]) };
  const ex = expandCharacter(r.data, lib);
  const lint = ex.issues.map((is): Issue => ({ severity: is.severity, path: formatPath(is.path), line: lineAt(doc, is.path), message: is.message }));
  return { kind, id, privateText, yaml: [], schema: [], lint, sheet: ex.sheet };
}

export interface CompileResult {
  /** Null when the check ran; else why it couldn't (no pack for the id's namespace). */
  readonly skipped: string | null;
  /** Where the pane's text was loaded. */
  readonly path: string | null;
  /** Diagnostics on the pane's file that the lint above doesn't already show. */
  readonly issues: readonly Issue[];
  /** Errors in other files (the rest of the content). */
  readonly elsewhere: number;
  /** The loaded sheet: the expansion's, with the compiled template's not-modeled list and fidelity. */
  readonly sheet: DerivedSheet | null;
}

/** The pack folders by namespace, from the manifests in the set (first in path order wins). */
export function packDirs(packs: readonly SourceFile[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of [...packs].sort((a, b) => byString(a.path, b.path))) {
    if (!f.path.endsWith('/manifest.yaml')) continue;
    const { doc } = parseYaml(f.text, f.path);
    const ns = (doc?.value as Record<string, unknown> | null | undefined)?.namespace;
    if (typeof ns === 'string' && !out.has(ns)) out.set(ns, f.path.slice(0, -'/manifest.yaml'.length));
  }
  return out;
}

export const DRAFT_FILE = '__character-screen-draft__.yaml';

/**
 * Stage 4: the content set loaded with the pane's text at `path` (the picked file's), or, for a
 * draft, at <pack of the id's namespace>/characters/__character-screen-draft__.yaml. `lint` is
 * checkCharacter's, so its issues aren't repeated.
 */
export function compileCheck(text: string, id: string | null, packs: readonly SourceFile[], path: string | null, lint: readonly Issue[]): CompileResult {
  let at = path;
  if (at === null) {
    const ns = id !== null && id.includes(':') ? id.slice(0, id.indexOf(':')) : null;
    const dir = ns !== null ? packDirs(packs).get(ns) : undefined;
    if (dir === undefined) return { skipped: `no loaded pack has the namespace ${ns === null ? '(no id)' : `${ns}:`}, so the draft can't be compiled`, path: null, issues: [], elsewhere: 0, sheet: null };
    at = `${dir}/characters/${DRAFT_FILE}`;
  }
  const files = [...packs.filter((f) => f.path !== at), { path: at, text }];
  const res = loadContent(files);
  const shown = new Set(lint.map((is) => (is.path !== '' ? `${is.path}: ${is.message}` : is.message)));
  const issues: Issue[] = [];
  for (const [severity, list] of [['error', res.errors], ['warning', res.warnings]] as const) {
    for (const d of list) {
      if (d.path === at) {
        if (!shown.has(d.message)) issues.push({ severity, path: '', line: d.line, message: d.message });
      } else if (d.message.includes(at)) {
        // Another file's diagnostic about this one (a duplicate id first defined here).
        issues.push({ severity, path: '', line: 0, message: `${d.path}:${d.line}: ${d.message.split(at).join('this file')}` });
      }
    }
  }
  const elsewhere = res.errors.filter((d) => d.path !== at && !d.message.includes(at)).length;
  const sheet = id !== null ? ((res.sheets ?? []).find((s) => s.id === id) ?? null) : null;
  return { skipped: null, path: at, issues, elsewhere, sheet };
}

/** The download's file name: the id's local part, made safe ('test:sample-monk' -> 'sample-monk.yaml'). */
export function downloadName(id: string | null): string {
  const local = id === null ? '' : id.slice(id.indexOf(':') + 1);
  const safe = local.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${safe || 'character'}.yaml`;
}
