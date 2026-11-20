// Typed access to pins.json (docs/design/m3.md 4.1, C17): every input the importer reads is
// pinned by sha256 here, plus a tree hash over the extracted Foundry files, because GitHub
// archive tarballs aren't guaranteed byte-stable. A tarball mismatch warns; a tree mismatch
// fails closed.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IMPORT_DIR, isRecord } from './util.ts';

export interface PinnedFile {
  readonly remote: string;
  readonly sha256: string;
}

export interface Pins {
  readonly foundry: {
    readonly repo: string;
    readonly tag: string;
    readonly commit: string;
    readonly root: string;
    readonly tarballUrl: string;
    readonly tarballSha256: string;
    readonly treeSha256: string;
    readonly treeFiles: number;
    /** Repo-relative prefixes (ending in /) or exact files that extraction keeps. */
    readonly extract: readonly string[];
  };
  readonly pdf: { readonly url: string; readonly sha256: string; readonly pages: number };
  readonly open5e: { readonly base: string; readonly repoCommit: string; readonly files: Readonly<Record<string, PinnedFile>> };
  readonly bits: { readonly base: string; readonly commit: string; readonly files: Readonly<Record<string, PinnedFile>> };
}

export const PINS_FILE = join(IMPORT_DIR, 'pins.json');

const HEX64 = /^[0-9a-f]{64}$/;

function need(cond: boolean, what: string): void {
  if (!cond) throw new Error(`pins.json: ${what}`);
}

/** Parses and sanity-checks pins.json (JSON.parse only). */
export function parsePins(text: string): Pins {
  const p = JSON.parse(text) as unknown;
  need(isRecord(p), 'not an object');
  const pins = p as Pins;
  const f = pins.foundry;
  need(isRecord(f) && /^[0-9a-f]{40}$/.test(f.commit), 'foundry.commit must be a full sha');
  need(HEX64.test(f.tarballSha256) && HEX64.test(f.treeSha256), 'foundry hashes must be sha256 hex');
  need(f.root === `dnd5e-${f.commit}`, 'foundry.root must be dnd5e-<commit>');
  need(f.tarballUrl.includes(f.commit), 'foundry.tarballUrl must name the commit');
  need(Array.isArray(f.extract) && f.extract.length > 0, 'foundry.extract is empty');
  for (const e of f.extract) need(e.startsWith('packs/_source/') && !e.includes('..'), `bad extract entry ${e}`);
  need(isRecord(pins.pdf) && HEX64.test(pins.pdf.sha256), 'pdf.sha256');
  for (const group of [pins.open5e, pins.bits]) {
    need(isRecord(group) && isRecord(group.files), 'open5e/bits files');
    for (const [name, file] of Object.entries(group.files)) {
      need(/^[A-Za-z0-9_.-]+\.json$/.test(name) && HEX64.test(file.sha256), `bad pinned file ${name}`);
    }
  }
  return pins;
}

export function loadPins(file: string = PINS_FILE): Pins {
  return parsePins(readFileSync(file, 'utf8'));
}

/** The pins' hashes only: what IMPORT.json repeats and import:verify compares. */
export function pinSummary(p: Pins): Record<string, unknown> {
  const files = (g: Readonly<Record<string, PinnedFile>>) => Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.sha256]));
  return {
    foundry: { commit: p.foundry.commit, tag: p.foundry.tag, tarballSha256: p.foundry.tarballSha256, treeSha256: p.foundry.treeSha256, treeFiles: p.foundry.treeFiles },
    pdf: { sha256: p.pdf.sha256, url: p.pdf.url },
    open5e: { repoCommit: p.open5e.repoCommit, files: files(p.open5e.files) },
    bits: { commit: p.bits.commit, files: files(p.bits.files) },
  };
}
