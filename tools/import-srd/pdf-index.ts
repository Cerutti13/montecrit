// Builds tools/import-srd/srd-index.json from the SRD 5.2.1 PDF (docs/design/m3.md 4.2, C2, C4).
//
//   node tools/import-srd/pdf-index.ts            [--pdf FILE]   rebuild srd-index.json
//   node tools/import-srd/pdf-index.ts --check    [--pdf FILE]   exit 1 if it would change
//
// The PDF defaults to the import cache (<cache>/pdf/srd.pdf, where fetch.ts puts it) and must
// match the pinned sha256. pdftotext (poppler; $PDFTOTEXT overrides the binary) writes its
// text dumps under <cache>/pdf-text/, outside the repo; only the index is committed: names,
// pages and numbers, never rules prose. The PDF itself never enters the repo.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkText } from '../check-private.ts';
import { type SrdIndex, buildIndex } from './pdf/build.ts';
import { IMPORT_DIR, cachePaths, sha256, stableJson } from './util.ts';

/** sha256 of SRD_CC_v5.2.1.pdf (C17). */
export const PDF_SHA256 = '8974902d109d6e63672d7c490bde9ccf052410503d9cfa768237154fbc5e3d87';
export const INDEX_PATH = join(IMPORT_DIR, 'srd-index.json');

export function loadIndex(path: string = INDEX_PATH): SrdIndex {
  return JSON.parse(readFileSync(path, 'utf8')) as SrdIndex;
}

/** Run pdftotext twice (-layout for tables, -bbox-layout for headings) into `dir`. */
export function extractText(pdf: string, dir: string, bin: string = process.env.PDFTOTEXT ?? 'pdftotext'): { layout: string; bbox: string } {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const layout = join(dir, 'layout.txt');
  const bbox = join(dir, 'bbox.html');
  execFileSync(bin, ['-enc', 'UTF-8', '-layout', pdf, layout], { stdio: ['ignore', 'ignore', 'inherit'] });
  execFileSync(bin, ['-enc', 'UTF-8', '-bbox-layout', pdf, bbox], { stdio: ['ignore', 'ignore', 'inherit'] });
  return { layout: readFileSync(layout, 'utf8'), bbox: readFileSync(bbox, 'utf8') };
}

export function renderIndex(pdf: string, textDir: string): string {
  const bytes = readFileSync(pdf);
  const got = sha256(bytes);
  if (got !== PDF_SHA256) throw new Error(`${pdf}: sha256 ${got}, pinned ${PDF_SHA256}; refusing to index a different PDF`);
  const { layout, bbox } = extractText(pdf, textDir);
  const json = stableJson(buildIndex(layout, bbox, got));
  const hits = checkText('tools/import-srd/srd-index.json', json);
  if (hits.length) throw new Error(`srd-index.json would carry non-SRD content: ${hits.map((h) => h.why).join('; ')}`);
  return json;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const at = args.indexOf('--pdf');
  const paths = cachePaths();
  const pdf = at >= 0 ? args[at + 1]! : paths.pdf;
  if (!existsSync(pdf)) {
    console.error(`no PDF at ${pdf}; run fetch.ts first or pass --pdf FILE`);
    process.exit(2);
  }
  try {
    const json = renderIndex(pdf, join(paths.root, 'pdf-text'));
    const old = existsSync(INDEX_PATH) ? readFileSync(INDEX_PATH, 'utf8') : '';
    if (check) {
      if (json !== old) {
        console.error('srd-index.json is out of date; rerun node tools/import-srd/pdf-index.ts');
        process.exit(1);
      }
      console.log('srd-index.json is up to date');
    } else {
      if (json !== old) writeFileSync(INDEX_PATH, json);
      const counts = (JSON.parse(json) as SrdIndex).counts;
      console.log(`srd-index.json ${json === old ? 'unchanged' : 'written'}: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
