// Keeps non-SRD content and API keys out of git.
//
// Shane's private pack (Circle of the Stars, Aasimar, his characters...) lives in
// ~/.montecrit/, outside the repo. This is the guard in case something drifts in anyway.
// Every file is checked for:
//   - anything shaped like an Anthropic API key (no exemptions, ever)
//   - a `license: private` manifest (YAML or JSON, quoted or not)
//   - a `private:` content id
//   - a non-SRD name, in the text or the file path, in any case or spacing
//     ("Circle of the Stars", "circle-of-the-stars", "circle_of_the_stars")
//   - a binary document (PDF, Word, ...) that can't be scanned
//   - under packs/: art or a pointer into Foundry's art and premium modules (image files,
//     .webp/.png/.svg, icons/, systems/dnd5e, modules/, tokens/, @UUID, Compendium., and the
//     three premium module names; docs/design/m3.md 4.7 point 5 and C5)
// The engine stays generic, so code and committed content never need those names; tests
// use synthetic stand-ins built from the same primitives. Paths in
// tools/check-private.allow (docs, this file, its test) are exempt from the content
// checks, never from the key check.
//
//   node tools/check-private.ts --staged   files staged for commit (pre-commit hook)
//   node tools/check-private.ts --all      every tracked or new file (CI)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';

const root = join(import.meta.dirname, '..');

export const NON_SRD_NAMES = [
  'Circle of the Stars',
  'Starry Form',
  'Star Map',
  'Thorn Whip',
  'Aasimar',
  'Celestial Revelation',
  'Celestial Resistance',
  'Healing Hands',
  'Light Bearer',
  'Heavenly Wings',
  'Inner Radiance',
  'Necrotic Shroud',
  'Cosmic Omen',
  'Changeling',
  'College of Dance',
  'Guide background',
];

// Case-insensitive letters, written as [Xx] classes so the boundaries below can stay case-
// sensitive. A name counts when it isn't glued to more lowercase letters: underscores, digits
// and camelCase joins all still match (aasimar_sheet, thornWhip2, starryFormArcher), while
// ordinary words don't (a word that merely contains a name).
const letters = (word: string) =>
  [...word].map((ch) => (/[a-z]/i.test(ch) ? `[${ch.toLowerCase()}${ch.toUpperCase()}]` : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('');
const NAME_PATTERNS = NON_SRD_NAMES.map(
  (name) => [name, new RegExp(`(?:(?<![A-Za-z])|(?<=[a-z])(?=[A-Z]))${name.split(/\s+/).map(letters).join('[\\s_-]*')}(?![a-z])`)] as const,
);
const KEY_PATTERN = /sk-ant-[A-Za-z0-9_-]{20,}/;
const PRIVATE_LICENSE = /(?:^|[{,\s])["']?license["']?\s*:\s*["']?private\b/im;
const PRIVATE_ID = /\bprivate:[a-z0-9][a-z0-9_-]*/i;
const BINARY_DOCS = new Set(['.pdf', '.doc', '.docx', '.odt', '.rtf', '.xls', '.xlsx', '.ods', '.ppt', '.pptx', '.key', '.pages', '.zip']);

/** Art and pointer tokens refused anywhere under packs/ (m3.md 4.7 point 5, C5). Case-insensitive. */
export const PACK_POINTER_TOKENS = [
  '.webp',
  '.png',
  '.svg',
  'icons/',
  'systems/dnd5e',
  'modules/',
  'tokens/',
  '@UUID',
  'Compendium.',
  'dnd-players-handbook',
  'dnd-monster-manual',
  'dnd-dungeon-masters-guide',
];
const PACK_ART_EXT = new Set(['.webp', '.png', '.svg', '.jpg', '.jpeg', '.gif', '.avif']);

export interface Finding {
  file: string;
  why: string;
}

/** Decodes UTF-8 or UTF-16 (BOM or NUL-interleaved); returns undefined for other binary data. */
export function decodeText(buf: Uint8Array): string | undefined {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString('utf16le');
  if (b[0] === 0xfe && b[1] === 0xff) return Buffer.from(b.subarray(2)).swap16().toString('utf16le');
  if (!b.includes(0)) return b.toString('utf8');
  if (b.length % 2 === 0) {
    let oddNuls = 0;
    let evenNuls = 0;
    for (let i = 0; i < b.length; i++) if (b[i] === 0) (i % 2 ? oddNuls++ : evenNuls++);
    const half = b.length / 2;
    if (oddNuls > half * 0.3 && evenNuls === 0) return b.toString('utf16le');
    if (evenNuls > half * 0.3 && oddNuls === 0) return Buffer.from(b).swap16().toString('utf16le');
  }
  return undefined;
}

/**
 * JS string escapes undone (\n \r \t \" \' \\ \xHH \uHHHH \u{...}): a bundler may keep a raw text
 * import as a quoted string, where a line start is the two characters \ and n. Bundle scans
 * (--dir, the web build's guard) check the text both ways.
 */
export function unescapeJs(text: string): string {
  return text.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[nrt"'\\`])/g, (_m, e: string) => {
    if (e === 'n') return '\n';
    if (e === 'r') return '\r';
    if (e === 't') return '\t';
    if (e[0] === 'u' || e[0] === 'x') return String.fromCodePoint(parseInt(e.replace(/[ux{}]/g, ''), 16));
    return e;
  });
}

export function checkContent(file: string, buf: Uint8Array, exempt: boolean, opts: { readonly bundle?: boolean } = {}): Finding[] {
  const out: Finding[] = [];
  const decoded = decodeText(buf);
  const text = decoded !== undefined && opts.bundle ? `${decoded}\n${unescapeJs(decoded)}` : decoded;
  if (text !== undefined && KEY_PATTERN.test(text)) out.push({ file, why: 'looks like an Anthropic API key' });
  if (exempt) return out;
  for (const [name, re] of NAME_PATTERNS) if (re.test(file)) out.push({ file, why: `non-SRD name "${name}" in the file path` });
  out.push(...packArtFindings(file, text));
  if (text === undefined) {
    if (BINARY_DOCS.has(extname(file).toLowerCase())) {
      out.push({ file, why: "binary document can't be scanned; allowlist it if it belongs in the repo" });
    }
    return out;
  }
  if (PRIVATE_LICENSE.test(text)) out.push({ file, why: 'manifest says license: private' });
  const id = PRIVATE_ID.exec(text);
  if (id) out.push({ file, why: `private content id "${id[0]}"` });
  for (const [name, re] of NAME_PATTERNS) if (re.test(text)) out.push({ file, why: `non-SRD name "${name}"` });
  return out;
}

/** True for a repo-relative path under packs/. */
export const isPackPath = (file: string): boolean => file.replace(/\\/g, '/').startsWith('packs/');

/**
 * The art and pointer lint for one packs/ file: an image file by its extension, or any
 * PACK_POINTER_TOKENS entry in its text. Returns [] for paths outside packs/.
 */
export function packArtFindings(file: string, text: string | undefined): Finding[] {
  if (!isPackPath(file)) return [];
  const out: Finding[] = [];
  if (PACK_ART_EXT.has(extname(file).toLowerCase())) out.push({ file, why: 'image file under packs/ (no art is shipped)' });
  if (text !== undefined) {
    const lower = text.toLowerCase();
    for (const t of PACK_POINTER_TOKENS) if (lower.includes(t.toLowerCase())) out.push({ file, why: `art or premium pointer "${t}" under packs/` });
  }
  return out;
}

/** Back-compat helper for plain strings. */
export function checkText(file: string, text: string, exempt = false, opts: { readonly bundle?: boolean } = {}): Finding[] {
  return checkContent(file, new TextEncoder().encode(text), exempt, opts);
}

/** Allowlist: one repo-relative path per line (a trailing / means a folder); # comments. */
export function loadAllow(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean);
}

/** Whole-segment match: "docs/" covers docs/x.md, "README.md" covers only that file. */
export function isAllowed(allow: readonly string[], file: string): boolean {
  return allow.some((a) => (a.endsWith('/') ? file.startsWith(a) : file === a || file.startsWith(`${a}/`)));
}

function git(args: string[]): Buffer {
  return execFileSync('git', args, { cwd: root, maxBuffer: 256 * 1024 * 1024 });
}

const paths = (raw: Buffer) => raw.toString('utf8').split('\0').filter(Boolean);

if (import.meta.main) {
  const mode = process.argv[2];
  if (mode === '--dir') {
    // Build output (apps/web/dist): every file under the folder, no git, no allowlist, and the
    // dev-only hook refused too (docs/design/m2.md 8.1).
    const dir = process.argv[3];
    if (!dir || !existsSync(dir)) {
      console.error('usage: node tools/check-private.ts --dir <folder>');
      process.exit(2);
    }
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    const files = walk(dir);
    const findings: Finding[] = [];
    for (const f of files) {
      const buf = readFileSync(f);
      findings.push(...checkContent(f, buf, false, { bundle: true }));
      if (buf.includes('__montecrit')) findings.push({ file: f, why: 'the dev-only hook __montecrit' });
    }
    if (findings.length) {
      for (const f of findings) console.error(`${f.file}: ${f.why}`);
      console.error(`check-private: ${findings.length} problem(s) in ${dir}`);
      process.exitCode = 1;
    } else console.log(`check-private: ${files.length} file(s) in ${dir} clean`);
  } else if (mode !== '--staged' && mode !== '--all') {
    console.error('usage: node tools/check-private.ts --staged | --all | --dir <folder>');
    process.exit(2);
  } else {
    const allowFile = join(root, 'tools', 'check-private.allow');
    const allow = existsSync(allowFile) ? loadAllow(readFileSync(allowFile, 'utf8')) : [];
    // -z keeps non-ASCII names intact (git would otherwise C-quote them).
    const files =
      mode === '--staged'
        ? paths(git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMRT']))
        : paths(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']));

    const findings: Finding[] = [];
    for (const file of files) {
      let buf: Buffer;
      try {
        if (mode === '--staged') buf = git(['show', `:${file}`]);
        else if (!existsSync(join(root, file))) continue; // tracked but deleted in the working tree
        else buf = readFileSync(join(root, file));
      } catch (e) {
        findings.push({ file, why: `could not read it (${(e as Error).message.split('\n')[0]}); fail closed` });
        continue;
      }
      findings.push(...checkContent(file, buf, isAllowed(allow, file)));
    }
    if (findings.length) {
      for (const f of findings) console.error(`${f.file}: ${f.why}`);
      console.error(`check-private: ${findings.length} problem(s). Private content belongs in ~/.montecrit/, not the repo.`);
      process.exitCode = 1;
    } else {
      console.log(`check-private: ${files.length} file(s) clean`);
    }
  }
}
