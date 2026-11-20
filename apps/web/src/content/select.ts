// The committed content the app bundles, chosen by the CLI's own rules (@montecrit/host
// selectKnown) from Vite's glob keys. Pure, so it's tested without Vite.

import type { SourceFile } from '@montecrit/engine';
import { privateMarker, selectKnown } from '@montecrit/host';

export interface ContentSet {
  /** What loadContent gets. */
  readonly packs: readonly SourceFile[];
  readonly scenarios: readonly SourceFile[];
  readonly policies: readonly SourceFile[];
  /** Golden scenarios a top-level one extends: found by `extends`, never listed to run. */
  readonly bases?: readonly SourceFile[];
}

/** Every text `extends` may name: the scenarios on offer, plus the bases that aren't. */
export const extendable = (set: ContentSet): readonly SourceFile[] => [...set.scenarios, ...(set.bases ?? [])];

/** A glob key ('../../../../packs/x.yaml') as a repo-relative path ('packs/x.yaml'). */
export const repoPath = (key: string): string => key.replace(/^(\.\.\/)+/, '');

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The bundled texts under 'repo/' paths. Any text with a private marker throws: the guard plugin
 * and the dist scan should already have stopped it, so reaching here is a bug worth a crash.
 */
export function bundledSet(raw: Readonly<Record<string, string>>, bases: Readonly<Record<string, string>> = {}): ContentSet {
  const byPath = new Map<string, string>();
  for (const key of Object.keys(raw).sort(byString)) byPath.set(repoPath(key), raw[key]!);
  const basePaths = Object.keys(bases).sort(byString).map(repoPath);
  for (const key of Object.keys(bases)) byPath.set(repoPath(key), bases[key]!);
  for (const [path, text] of byPath) {
    const m = privateMarker(text);
    if (m) throw new Error(`bundled ${path} carries ${m.what} (line ${m.line}); private content never goes into the app`);
  }
  const sel = selectKnown([...byPath.keys()]);
  const files = (paths: readonly string[]) => paths.map((p) => ({ path: `repo/${p}`, text: byPath.get(p)! }));
  return { packs: files(sel.packs), scenarios: files(sel.scenarios), policies: files(sel.policies), ...(basePaths.length > 0 ? { bases: files(basePaths) } : {}) };
}
