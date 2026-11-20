// The pack files a scenario reaches (docs/design/m3.md section 11 and C19): what a worker needs to
// rebuild its run, instead of every pack. Load-time code over texts, like loadContent.
//
// From the root ids, every file that defines a reached id is taken, and every id its text names
// (in any string or map key: `srd:monk`, `srd:monk/martial-arts`, a pick key `srd:monk#skills`,
// each '/' prefix of a longer id) is reached in turn. The packs those files sit in come along by
// their manifest.yaml, and the packs those require; so do the packs the scenario lists by name
// (a listed pack its units never reach costs only its manifest). Over-reaching is harmless (a file more is
// loaded); under-reaching is caught by the caller, which loads the closure and compares the
// scenario and content hashes with the full load's (packages/host job.ts closureJob).

import { parseYaml, type SourceFile } from './yaml.ts';

const SEG = '[a-z0-9]+(?:-[a-z0-9]+)*';
const ID_IN_TEXT = new RegExp(`(?:srd|private|test):${SEG}(?:/${SEG})*`, 'g');

const dirOf = (path: string): string => {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
};
const baseOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** Every namespaced id named anywhere in `text`, with each '/' prefix of a longer one. */
export function idsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(ID_IN_TEXT)) {
    const id = m[0];
    out.add(id);
    for (let i = id.indexOf('/'); i >= 0; i = id.indexOf('/', i + 1)) out.add(id.slice(0, i));
  }
  return [...out].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

interface FileInfo {
  readonly file: SourceFile;
  /** The ids this file defines. */
  readonly defines: readonly string[];
  /** A manifest's pack name and the packs it requires; null for an item file. */
  readonly manifest: { readonly pack: string; readonly requires: readonly string[] } | null;
  readonly parsed: boolean;
}

function info(file: SourceFile): FileInfo {
  const { doc } = parseYaml(file.text, file.path);
  const value = doc?.value;
  const entries = Array.isArray(value) ? value : [value];
  const defines: string[] = [];
  let manifest: FileInfo['manifest'] = null;
  for (const e of entries) {
    if (e === null || typeof e !== 'object' || Array.isArray(e)) continue;
    const r = e as Record<string, unknown>;
    if (r.kind === 'manifest' && typeof r.pack === 'string') {
      const req = Array.isArray(r.requires) ? r.requires.filter((x): x is string => typeof x === 'string') : [];
      manifest = { pack: r.pack, requires: req };
    } else if (typeof r.id === 'string') defines.push(r.id);
  }
  return { file, defines, manifest, parsed: doc !== null };
}

/**
 * The files of `files` a fight over `roots` (template ids, and every id the scenario names) can
 * reach, in their input order. `packs`: pack names the scenario lists (its `packs:`), whose
 * manifests are kept even when no root reaches them (scenario resolution refuses a listed pack
 * that isn't loaded), with the packs they require. A file that doesn't parse is kept: the full
 * load would have failed on it too, and the closure must not hide that.
 */
export function contentClosure(files: readonly SourceFile[], roots: readonly string[], packs: readonly string[] = []): SourceFile[] {
  const infos = files.map(info);
  const byId = new Map<string, number[]>();
  const manifestByDir = new Map<string, number>();
  const manifestByPack = new Map<string, number>();
  const keep = new Uint8Array(infos.length);
  infos.forEach((fi, i) => {
    if (fi.manifest) {
      if (baseOf(fi.file.path) === 'manifest.yaml') manifestByDir.set(dirOf(fi.file.path), i);
      manifestByPack.set(fi.manifest.pack, i);
    }
    if (!fi.parsed) keep[i] = 1;
    for (const id of fi.defines) {
      const l = byId.get(id);
      if (l) l.push(i);
      else byId.set(id, [i]);
    }
  });
  const seen = new Set<string>();
  const queue: string[] = [];
  const reach = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    queue.push(id);
  };
  for (const r of roots) for (const id of idsIn(r)) reach(id);
  while (queue.length > 0) {
    const id = queue.pop()!;
    for (const i of byId.get(id) ?? []) {
      if (keep[i]) continue;
      keep[i] = 1;
      for (const next of idsIn(infos[i]!.file.text)) reach(next);
    }
  }
  // The packs the kept files sit in (nearest ancestor manifest), and the packs those require.
  const taken: number[] = [];
  const takePack = (m: number | undefined): void => {
    if (m === undefined || keep[m]) return;
    keep[m] = 1;
    taken.push(m);
  };
  for (const name of packs) takePack(manifestByPack.get(name));
  infos.forEach((fi, i) => {
    if (!keep[i] || fi.manifest) return;
    for (let dir = dirOf(fi.file.path); ; dir = dirOf(dir)) {
      const m = manifestByDir.get(dir);
      if (m !== undefined) {
        takePack(m);
        break;
      }
      if (dir === '') break;
    }
  });
  while (taken.length > 0) for (const name of infos[taken.pop()!]!.manifest!.requires) takePack(manifestByPack.get(name));
  return files.filter((_, i) => keep[i] === 1);
}
