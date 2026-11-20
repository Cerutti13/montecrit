// The committed packs, scenarios and policies, bundled at build time (docs/design/m2.md 3.2).
// Top-level scenarios only (no golden/ or perf/), plus the golden bases a top-level one extends,
// which are never listed to run. The private home never comes through here.
// The packs (the SRD pack is most of the app's text) sit in their own lazy chunk (packs.ts,
// docs/design/m3.md section 11, C19): the index chunk holds the scenarios, policies and the
// attribution, and the page loads the packs with loadBundledPacks once it has started.

import type { SourceFile } from '@montecrit/engine';
import { bundledSet, type ContentSet } from './select.ts';

const raw: Record<string, string> = {
  ...import.meta.glob<string>('../../../../scenarios/*.yaml', { query: '?raw', import: 'default', eager: true }),
  ...import.meta.glob<string>('../../../../policies/**/*.{yaml,yml}', { query: '?raw', import: 'default', eager: true }),
};

/** The bundled scenarios and policies; packs stay empty until loadBundledPacks resolves (withPacks). */
export const BUNDLED = bundledSet(raw, import.meta.glob<string>('../../../../scenarios/golden/cover-archer.yaml', { query: '?raw', import: 'default', eager: true }));

/** The committed pack files, from their lazy chunk. */
export const loadBundledPacks = (): Promise<readonly SourceFile[]> => import('./packs.ts').then((m) => m.PACKS);

/** The bundled set with its packs. */
export const withPacks = (set: ContentSet, packs: readonly SourceFile[]): ContentSet => ({ ...set, packs });

const attribution = import.meta.glob<string>('../../../../packs/srd-5.2.1/ATTRIBUTION.md', { query: '?raw', import: 'default', eager: true });
/** The SRD 5.2.1 attribution, verbatim (packs/srd-5.2.1/ATTRIBUTION.md), for About. */
export const ATTRIBUTION: string = Object.values(attribution)[0] ?? '';
