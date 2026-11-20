// YAML in, positioned diagnostics out. Files are parsed with the YAML 1.2 core schema (no
// Date objects, no merge keys), duplicate keys are errors, and every warning the parser
// records is treated as an error too. Diagnostics carry file:line:col, 1-based; zod issue
// paths map back to the node they name (or the nearest node that exists).

import { LineCounter, isAlias, isMap, isScalar, isSeq, parseDocument, type Document } from 'yaml';
import type { z } from 'zod';

export interface Diag {
  readonly path: string;
  /** 1-based; 0 when the input had no positions (an already-parsed object). */
  readonly line: number;
  readonly col: number;
  readonly message: string;
}

export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

export type YamlPath = readonly (string | number)[];

interface Pos {
  line: number;
  col: number;
}

/** A parsed file: its plain value plus position lookups for diagnostics. */
export interface SourceDoc {
  readonly path: string;
  readonly value: unknown;
  /** Position of the node a path reaches, or of the deepest node on the way. */
  at(p: YamlPath): Pos;
  /** Position of a key inside the map at p (for unknown keys). */
  keyAt(p: YamlPath, key: string): Pos;
}

export function formatDiag(d: Diag): string {
  return d.line > 0 ? `${d.path}:${d.line}:${d.col}: ${d.message}` : `${d.path}: ${d.message}`;
}

/** Orders diagnostics by file, then position, then text, comparing with < only. */
export function compareDiags(a: Diag, b: Diag): number {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  if (a.line !== b.line) return a.line - b.line;
  if (a.col !== b.col) return a.col - b.col;
  return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
}

export function diagAt(doc: SourceDoc, p: YamlPath, message: string): Diag {
  const { line, col } = doc.at(p);
  return { path: doc.path, line, col, message };
}

/** 'attacks[0].damage[1].roll' */
export function formatPath(p: readonly PropertyKey[]): string {
  let out = '';
  for (const seg of p) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out === '' ? String(seg) : `.${String(seg)}`;
  }
  return out;
}

const firstLine = (s: string) => s.split('\n')[0]!.trim();

export function parseYaml(text: string, path: string): { doc: SourceDoc | null; errors: Diag[] } {
  const lc = new LineCounter();
  const d = parseDocument(text, {
    lineCounter: lc,
    uniqueKeys: true,
    prettyErrors: false,
    schema: 'core',
    merge: false,
  });
  const problems = [...d.errors, ...d.warnings];
  if (problems.length > 0) {
    const errors = problems.map((e) => {
      const { line, col } = lc.linePos(e.pos[0]);
      return { path, line, col, message: `YAML: ${firstLine(e.message)}` };
    });
    return { doc: null, errors };
  }
  let value: unknown;
  try {
    value = d.toJS({ maxAliasCount: 100 });
  } catch (e) {
    return { doc: null, errors: [{ path, line: 1, col: 1, message: `YAML: ${firstLine((e as Error).message)}` }] };
  }
  return { doc: yamlDoc(path, value, d, lc), errors: [] };
}

interface Ranged {
  range?: readonly number[] | null;
}

function yamlDoc(path: string, value: unknown, d: Document, lc: LineCounter): SourceDoc {
  const posOf = (n: unknown): Pos => {
    const r = (n as Ranged | null | undefined)?.range;
    return r ? lc.linePos(r[0]!) : { line: 1, col: 1 };
  };
  const pairOf = (node: unknown, seg: string | number) => {
    if (!isMap(node)) return undefined;
    return node.items.find((it) => isScalar(it.key) && String(it.key.value) === String(seg));
  };
  // Walks as far as the path goes; returns the deepest node reached.
  const walk = (p: YamlPath): unknown => {
    let node: unknown = d.contents;
    for (const seg of p) {
      if (isAlias(node)) node = node.resolve(d);
      if (isMap(node)) {
        const pair = pairOf(node, seg);
        if (!pair) return node;
        if (pair.value === null || pair.value === undefined) return pair.key;
        node = pair.value;
      } else if (isSeq(node) && typeof seg === 'number' && seg < node.items.length) {
        node = node.items[seg];
      } else return node;
    }
    return node;
  };
  return {
    path,
    value,
    at: (p) => posOf(walk(p)),
    keyAt: (p, key) => {
      let node = walk(p);
      if (isAlias(node)) node = node.resolve(d);
      const pair = pairOf(node, key);
      return posOf(pair ? pair.key : node);
    },
  };
}

/** A SourceDoc for an object that was never YAML: diagnostics carry no position. */
export function plainDoc(path: string, value: unknown): SourceDoc {
  return { path, value, at: () => ({ line: 0, col: 0 }), keyAt: () => ({ line: 0, col: 0 }) };
}

function rawAt(value: unknown, p: YamlPath): { found: boolean; v: unknown } {
  let v = value;
  for (const seg of p) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, seg)) return { found: false, v: undefined };
    v = (v as Record<string | number, unknown>)[seg];
  }
  return { found: true, v };
}

type Issue = z.core.$ZodIssue;

const depth = (issues: readonly Issue[]): number => issues.reduce((m, i) => Math.min(m, i.path.length), Infinity);

/**
 * A union that matched no branch reports every branch's issues. For one-key objects (steps,
 * durations) the branch that got furthest is the one the author meant, so its issues are
 * reported instead of a bare "no branch matched". When no branch got past the top level
 * (an unknown step name), the union's own message stands.
 */
function flattenIssues(issues: readonly Issue[], prefix: readonly PropertyKey[], out: Issue[]): void {
  for (const issue of issues) {
    const path = [...prefix, ...issue.path];
    if (issue.code === 'invalid_union' && issue.errors.length > 0) {
      let best = -1;
      let bestDepth = 0;
      issue.errors.forEach((branch, i) => {
        const d = depth(branch);
        if (d > bestDepth || (d === bestDepth && best >= 0 && branch.length < issue.errors[best]!.length)) {
          best = i;
          bestDepth = d;
        }
      });
      if (best >= 0 && bestDepth > 0) {
        flattenIssues(issue.errors[best]!, path, out);
        continue;
      }
    }
    out.push({ ...issue, path } as Issue);
  }
}

/** Maps zod issues to positioned diagnostics. prefix locates the item inside the file. */
export function zodDiags(doc: SourceDoc, prefix: YamlPath, error: z.ZodError): Diag[] {
  const out: Diag[] = [];
  const issues: Issue[] = [];
  flattenIssues(error.issues as readonly Issue[], [], issues);
  for (const issue of issues) {
    const rel = issue.path.filter((s): s is string | number => typeof s !== 'symbol');
    const full = [...prefix, ...rel];
    const where = formatPath(rel);
    const lead = where === '' ? '' : `${where}: `;
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        const { line, col } = doc.keyAt(full, key);
        out.push({ path: doc.path, line, col, message: `${lead}unknown key "${key}"` });
      }
      continue;
    }
    let message = `${lead}${issue.message}`;
    if ((issue.code === 'invalid_type' || issue.code === 'invalid_value') && rel.length > 0 && !rawAt(doc.value, full).found) {
      const parent = formatPath(rel.slice(0, -1));
      message = `${parent === '' ? '' : `${parent}: `}missing required key "${String(rel[rel.length - 1])}"`;
    }
    out.push(diagAt(doc, full, message));
  }
  return out;
}

/** The `kind` of a YAML file's top-level map, without validating anything else. */
export function peekKind(text: string): string | undefined {
  const d = parseDocument(text, { schema: 'core', merge: false });
  if (d.errors.length > 0) return undefined;
  const contents = d.contents;
  if (!isMap(contents)) return undefined;
  const pair = contents.items.find((it) => isScalar(it.key) && it.key.value === 'kind');
  return pair && isScalar(pair.value) && typeof pair.value.value === 'string' ? pair.value.value : undefined;
}
