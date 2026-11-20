// What the app can run: every scenario with its hashes (the same the CLI prints), and every
// policy, and every loaded character for the Run panel's seat picker. Computed once on the main
// thread from the content set's texts.

import { formatDiag, loadContent, peekKind, resolveScenario, type Content, type DerivedSheet, type SourceFile } from '@montecrit/engine';
import { pcSeats, policiesFrom, scenarioInput, type PcSeat } from '@montecrit/host';
import { characterOrigin, listCharacters } from '../character/validate.ts';
import { extendable, type ContentSet } from './select.ts';

export interface ScenarioEntry {
  readonly path: string;
  readonly origin: 'repo' | 'home';
  readonly id: string | null;
  readonly name: string | null;
  readonly scenarioHash: string | null;
  readonly contentHash: string | null;
  /** Its PC seats, in scenario order: the seats the Run panel offers a character for. */
  readonly pcSeats: readonly PcSeat[];
  readonly errors: readonly string[];
}

/** A loaded character (kind: character or kind: pc), as `run --pc seat=<id>` takes it. */
export interface CharacterEntry {
  readonly id: string;
  readonly name: string;
  /** characterOrigin's rule (the Character screen's too): 'home' when its file is under home/ or its pack is private. */
  readonly origin: 'repo' | 'home';
  readonly kind: 'character file' | 'kind: pc';
}

export interface PolicyEntry {
  readonly id: string;
  readonly name: string;
  readonly hash: string;
  readonly origin: 'repo' | 'home';
  /** The ids of its scripted rules, in order (none for a policy that only sets weights, holds or riders). */
  readonly rules: readonly string[];
}

export interface Catalog {
  readonly content: Content | null;
  readonly contentErrors: readonly string[];
  readonly scenarios: readonly ScenarioEntry[];
  /** Every loaded character, by id (ids sort with <). */
  readonly characters: readonly CharacterEntry[];
  /** The derived sheets (loadContent's), which the seating's notes read. */
  readonly sheets: readonly DerivedSheet[];
  readonly policies: readonly PolicyEntry[];
  readonly policyErrors: readonly string[];
}

/** One scenario file's entry: its hashes and PC seats, or why it can't run. */
export function scenarioEntry(set: ContentSet, f: SourceFile, content: Content | null): ScenarioEntry {
  const origin = f.path.startsWith('home/') ? 'home' : 'repo';
  const base = { path: f.path, origin, id: null, name: null, scenarioHash: null, contentHash: null, pcSeats: [] } as const;
  if (!content) return { ...base, errors: ['content has errors'] };
  const input = scenarioInput(extendable(set), f.path, 'repo/scenarios');
  if (input.errors.length) return { ...base, errors: input.errors.map(formatDiag) };
  const res = resolveScenario(input.input, f.path, content);
  if (!res.setup) return { ...base, errors: res.errors.map(formatDiag) };
  return { path: f.path, origin, id: res.setup.scenario, name: res.setup.scenario, scenarioHash: res.setup.scenarioHash, contentHash: res.setup.contentHash, pcSeats: pcSeats(input.input, f.path, content), errors: [] };
}

export function catalog(set: ContentSet): Catalog {
  const loaded = loadContent(set.packs);
  const content = loaded.content;
  // Only scenario files: a journal kept next to its scenario (kind: journal) isn't one to run.
  const scenarios = set.scenarios.filter((f) => peekKind(f.text) !== 'journal').map((f) => scenarioEntry(set, f, content));
  const pol = policiesFrom(set.policies);
  // A policy file's id, read off its own id line, says which file (and so which origin) it came from.
  const homePolicies = new Set(set.policies.filter((f) => f.path.startsWith('home/')).map((f) => /^id:\s*['"]?([^\s'"#]+)/m.exec(f.text)?.[1] ?? ''));
  const policies = [...pol.byId.values()].map((p) => ({ id: p.id, name: p.name, hash: p.hash, origin: homePolicies.has(p.id) ? ('home' as const) : ('repo' as const), rules: p.script.map((r) => r.id) })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const sheets = loaded.sheets ?? [];
  return { content, contentErrors: loaded.errors.map(formatDiag), scenarios, characters: content ? characters(content, sheets, set.packs) : [], sheets, policies, policyErrors: pol.errors.map(formatDiag) };
}

/**
 * Every kind: pc template, with where it came from and whether a character file built it. `files`
 * (the set's pack texts) gives each id its file path for the origin rule.
 */
export function characters(content: Content, sheets: readonly DerivedSheet[], files: readonly SourceFile[] = []): CharacterEntry[] {
  const ns = (id: string) => id.slice(0, id.indexOf(':'));
  const isPrivate = (id: string) => content.packs.some((p) => p.namespace === ns(id) && p.license === 'private');
  const pathOf = new Map<string, string>();
  for (const c of listCharacters(files)) if (!pathOf.has(c.id)) pathOf.set(c.id, c.path);
  return content.templates
    .filter((t) => t.kind === 'pc')
    .map((t) => ({ id: t.id, name: t.name, origin: characterOrigin(pathOf.get(t.id) ?? null, isPrivate(t.id) ? 'private' : undefined), kind: sheets.some((s) => s.id === t.id) ? 'character file' : 'kind: pc' }) as const);
}
