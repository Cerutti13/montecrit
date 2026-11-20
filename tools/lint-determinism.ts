// The engine must be a pure function of (scenario, seed, journal). This scans
// packages/engine/src for anything that would break that: ambient randomness, clocks,
// host locale, GC timing, host APIs. The engine's tsconfig already drops DOM and Node
// types; this catches what type-checking can't (Math.random, Date, Intl are plain ES).
//
//   node tools/lint-determinism.ts            engine files on disk (CI)
//   node tools/lint-determinism.ts --staged   staged engine files (pre-commit hook)
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(import.meta.dirname, '..');
const ENGINE_SRC = 'packages/engine/src/';
const HOST_SRC = 'packages/host/src/';
const WEB_SRC = 'apps/web/src/';

export const BANNED: [RegExp, string][] = [
  [/\brandom\b/, 'random: use a keyed Stream, never Math.random or an alias of it'],
  [/\bMath\s*\[/, "Math[...]: indexing Math by name hides what's called"],
  [/(?:[=(,:?]|\breturn)\s*Math\s*(?:[;,)\]}]|$)/, 'Math used as a value: aliasing hides Math.random'],
  [/\bDate\b/, 'Date: the engine has no clock'],
  [/\bperformance\b/, 'performance: the engine has no clock'],
  [/\bIntl\b/, 'Intl: output depends on the host locale and clock'],
  [/\blocaleCompare\b/, 'localeCompare: order depends on the host locale; compare with < and >'],
  [/\btoLocale\w*/, 'toLocale*: output depends on the host locale'],
  [/\b(WeakRef|FinalizationRegistry)\b/, 'WeakRef/FinalizationRegistry: GC timing is not deterministic'],
  [/\b(setTimeout|setInterval|setImmediate|queueMicrotask)\b/, 'timers: the engine is synchronous'],
  [/\bcrypto\b/, 'crypto: use a keyed Stream'],
  [/\bprocess\b/, 'process: no host APIs in the engine'],
  [/\brequire\s*\(/, 'require: ESM only'],
  [/\bawait\b|\basync\b|\bPromise\b/, 'async: decide() and resolution are synchronous'],
  // Engine-wide (and host-wide, through HOST_BANNED), not only on the simulation path: M2 compares
  // the browser's report with the CLI's (docs/design/m2.md 7.1), and odds/, rolls/ and dice/ feed
  // the AI's comparisons, so nothing may round differently across JS engines.
  [/\*\*/, '** exponentiation: may round differently across JS engines; multiply instead'],
  [/\bMath\s*\.\s*(pow|exp|expm1|log|log1p|log2|log10|sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|asinh|acosh|atanh|cbrt|hypot)\b/, 'transcendental Math (or Math.pow): may round differently across JS engines; use + - * / and Math.floor/min/max/abs/sqrt'],
];

/**
 * Blanks out comments and the contents of string and template literals, keeping line
 * structure, so prose and paths like 'scenarios/*.yaml' can't hide or fake code.
 * Template-literal ${...} expressions stay as code. Regex literals are blanked too, recognized
 * by what precedes the '/' (an operator, a bracket, a keyword like return); an unclosed comment
 * or template literal fails closed below.
 */
export function stripCode(text: string): { code: string; unterminated: boolean } {
  type Mode = 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl' | 're';
  let mode: Mode = 'code';
  let out = '';
  let depth = 0;
  const tplDepth: number[] = [];
  const blank = (ch: string | undefined) => (ch === '\n' ? '\n' : ' ');
  let inClass = false; // inside [...] of a regex literal
  // A '/' starts a regex literal when what precedes it can't end an expression.
  const regexAllowed = (): boolean => {
    const before = out.replace(/\s+$/, '');
    if (before === '') return true;
    if (/[(,=:[!&|?{};+\-*%<>~^]$/.test(before)) return true;
    return /\b(return|typeof|case|void|delete|in|of|new|yield|await)$/.test(before);
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const n = text[i + 1];
    switch (mode) {
      case 'code':
        if (c === '/' && n === '/') {
          mode = 'line';
          i++;
        } else if (c === '/' && n === '*') {
          mode = 'block';
          i++;
          out += '  ';
        } else if (c === "'" || c === '"' || c === '`') {
          mode = c === "'" ? 'sq' : c === '"' ? 'dq' : 'tpl';
          out += c;
        } else if (c === '/' && regexAllowed()) {
          mode = 're';
          inClass = false;
          out += c;
        } else if (c === '}' && tplDepth.length > 0 && tplDepth[tplDepth.length - 1] === depth) {
          tplDepth.pop();
          mode = 'tpl';
          out += c;
        } else {
          if (c === '{') depth++;
          if (c === '}') depth--;
          out += c;
        }
        break;
      case 'line':
        if (c === '\n') {
          mode = 'code';
          out += c;
        }
        break;
      case 'block':
        if (c === '*' && n === '/') {
          mode = 'code';
          i++;
          out += '  ';
        } else out += blank(c);
        break;
      case 'sq':
      case 'dq':
        if (c === '\\') {
          out += ' ' + blank(n);
          i++;
        } else if ((mode === 'sq' && c === "'") || (mode === 'dq' && c === '"')) {
          mode = 'code';
          out += c;
        } else if (c === '\n') {
          mode = 'code'; // unterminated string: recover at end of line
          out += c;
        } else out += ' ';
        break;
      case 're':
        if (c === '\\') {
          out += ' ' + blank(n);
          i++;
        } else if (c === '[') {
          inClass = true;
          out += ' ';
        } else if (c === ']') {
          inClass = false;
          out += ' ';
        } else if (c === '/' && !inClass) {
          mode = 'code';
          out += c;
        } else if (c === '\n') {
          mode = 'code'; // not a regex after all: recover at end of line
          out += c;
        } else out += ' ';
        break;
      case 'tpl':
        if (c === '\\') {
          out += ' ' + blank(n);
          i++;
        } else if (c === '`') {
          mode = 'code';
          out += c;
        } else if (c === '$' && n === '{') {
          tplDepth.push(depth);
          mode = 'code';
          i++;
          out += '${';
        } else out += blank(c);
        break;
    }
  }
  // An unclosed template literal blanks the rest of the file, like an unclosed comment: fail closed.
  return { code: out, unterminated: mode === 'block' || mode === 'tpl' || tplDepth.length > 0 };
}

// Extra rules for the simulator's hot, order-sensitive paths: iteration order of object keys,
// Maps and Sets is easy to depend on by accident. (Transcendental Math is banned everywhere in
// the engine and host: BANNED.)
// log/view.ts too: the replay viewer's frames must come out the same in Node and every browser.
const ORDER_SENSITIVE = ['packages/engine/src/sim/', 'packages/engine/src/grid/', 'packages/engine/src/decide/', 'packages/engine/src/query/', 'packages/engine/src/mc/', 'packages/engine/src/log/view.ts'];
export const BANNED_IN_SIM: [RegExp, string][] = [
  [/\bfor\s*\([^)]*\bin\b/, 'for...in: iteration order of object keys; loop over an array instead'],
  [/\bObject\s*\.\s*(keys|values|entries)\b/, 'Object.keys/values/entries: key order; loop over an array instead'],
];
const NO_COLLECTIONS: [RegExp, string][] = [[/\bnew\s+(Map|Set)\b/, 'Map/Set on the simulation path: iteration order hides in them; use arrays indexed by unit or cell']];
// Only these files may open streams: one door for every draw.
const STREAM_OPENERS = new Set(['packages/engine/src/rng/stream.ts', 'packages/engine/src/sim/dice.ts']);
const STREAM_OPEN = /\bopenStream(Into)?\s*\(/;
// ...and only sim/dice.ts draws from them on the simulation path, so no roll can draw after it
// closes or from someone else's stream. The bare names are banned, not just calls, so an alias
// (`import { sampleExpr as s }`), `.call` or a function reference can't slip past; so are
// namespace imports of the modules that draw.
const RAW_DRAW = /\b(sampleRoll|sampleExpr|drawRoll|rollDie|nextU32|uniformInt)\b/;
// Aux streams (the report's bootstrap) have a door of their own: only mc/boot.ts opens or draws
// from one, anywhere in the engine, so no fight can ever read from the bootstrap's key space.
const AUX_USERS = new Set(['packages/engine/src/rng/stream.ts', 'packages/engine/src/mc/boot.ts']);
const AUX = /\b(openAuxStream|auxU32|auxInt)\b/;
// Deciders and their queries read flags through readFlag/oddsFlags, which note what the AI
// consulted for the report (M1c critique resolution 16); a direct read would go unlisted.
const AI_DIRS = ['packages/engine/src/decide/', 'packages/engine/src/query/'];
const DIRECT_FLAGS = /\bsetup\s*\.\s*flags\b/;
const DRAW_NAMESPACE = /\bimport\s*\*\s*as\s+\w+\s+from\s*['"][^'"]*(rng\/stream|rolls\/rollspec|dice\/expr)\.ts['"]/;

/** Path-dependent rules on top of BANNED. `file` is repo-relative. */
export function scanPath(file: string, text: string): { line: number; why: string }[] {
  const hits = scan(text);
  const { code } = stripCode(text);
  const lines = code.split('\n');
  const raw = text.split('\n');
  const sim = ORDER_SENSITIVE.some((d) => file.startsWith(d));
  const collections = sim && !file.startsWith('packages/engine/src/decide/') && file !== 'packages/engine/src/sim/dice.ts';
  lines.forEach((line, i) => {
    if (sim) for (const [re, why] of BANNED_IN_SIM) if (re.test(line)) hits.push({ line: i + 1, why });
    if (collections) for (const [re, why] of NO_COLLECTIONS) if (re.test(line)) hits.push({ line: i + 1, why });
    if (!STREAM_OPENERS.has(file) && STREAM_OPEN.test(line)) hits.push({ line: i + 1, why: 'openStream: open rolls through sim/dice.ts (openRoll/openPaired/openInit)' });
    if (AI_DIRS.some((d) => file.startsWith(d)) && DIRECT_FLAGS.test(line)) hits.push({ line: i + 1, why: 'direct flag read in a decider or query: use readFlag(st, k) or oddsFlags(st), so the report lists what the AI consulted' });
    if (!AUX_USERS.has(file) && AUX.test(line)) hits.push({ line: i + 1, why: 'aux stream: only mc/boot.ts opens or draws from one' });
    if (sim && file !== 'packages/engine/src/sim/dice.ts' && RAW_DRAW.test(line)) hits.push({ line: i + 1, why: 'raw draw on the simulation path: use the sim/dice.ts helpers (drawExpr, drawDie, drawD20, ...)' });
    if (sim && file !== 'packages/engine/src/sim/dice.ts' && DRAW_NAMESPACE.test(raw[i] ?? '')) hits.push({ line: i + 1, why: 'namespace import of a drawing module on the simulation path: import the sim/dice.ts helpers instead' });
  });
  return hits.sort((a, b) => a.line - b.line);
}

// Module specifiers are strings, which stripCode blanks, so imports are checked on the raw
// line, but only where the stripped line shows a real import (not one in a comment).
const IMPORT_SITE = /\bfrom\s*['"]|\bimport\s*\(?\s*['"]|\bexport\s*\*?.*\bfrom\s*['"]/;
const HOST_MODULE = /['"](node:[^'"]*|fs|path|os|child_process|crypto|perf_hooks|worker_threads)['"]/;

export function scan(text: string): { line: number; why: string }[] {
  const { code, unterminated } = stripCode(text);
  const lines = code.split('\n');
  const raw = text.split('\n');
  const hits: { line: number; why: string }[] = [];
  lines.forEach((line, i) => {
    for (const [re, why] of BANNED) if (re.test(line)) hits.push({ line: i + 1, why });
    if (IMPORT_SITE.test(line) && HOST_MODULE.test(raw[i] ?? '')) {
      hits.push({ line: i + 1, why: 'host module import: the engine uses no Node or browser modules' });
    }
  });
  if (unterminated) hits.push({ line: lines.length, why: 'unterminated block comment or template literal: the rest of the file was not scanned' });
  return hits;
}

// @montecrit/host (docs/design/m2.md 8.4) runs in Node and in browser workers alike: every engine
// ban except async (the worker pool is Promise-based), no Node modules, no browser globals.
export const HOST_BANNED: [RegExp, string][] = BANNED.filter(([, why]) => !why.startsWith('async:'));
const BROWSER_GLOBAL = /\b(window|document|self|navigator|indexedDB|localStorage|sessionStorage|fetch|XMLHttpRequest|Worker)\b/;

export function scanHost(text: string): { line: number; why: string }[] {
  const { code, unterminated } = stripCode(text);
  const lines = code.split('\n');
  const raw = text.split('\n');
  const hits: { line: number; why: string }[] = [];
  lines.forEach((line, i) => {
    for (const [re, why] of HOST_BANNED) if (re.test(line)) hits.push({ line: i + 1, why });
    if (BROWSER_GLOBAL.test(line)) hits.push({ line: i + 1, why: 'browser global in @montecrit/host: it is platform-free; the apps own the DOM and their transports' });
    if (IMPORT_SITE.test(line) && HOST_MODULE.test(raw[i] ?? '')) hits.push({ line: i + 1, why: 'host module import in @montecrit/host: it is platform-free; Node code goes in apps/cli' });
  });
  if (unterminated) hits.push({ line: lines.length, why: 'unterminated block comment or template literal: the rest of the file was not scanned' });
  return hits;
}

// The browser app (docs/design/m2.md 8.4) computes no result, so it needs no determinism rules:
// these keep it a client of the engine and host, keep private text out of storage, URLs and the
// console, and keep Node and the CLI out of the bundle.
const WEB_RULES: [RegExp, string, (file: string) => boolean][] = [
  [/\bMath\s*\.\s*random\b/, 'Math.random in the app: every number comes from the engine', () => true],
  [/\blocation\s*\.\s*hash\s*=|\bhistory\s*\.\s*(pushState|replaceState)\b/, 'URL state: screens live in React state, and nothing private goes in a URL', () => true],
  [/\b(localStorage|sessionStorage)\b/, 'browser storage outside src/theme.ts: only the theme choice is remembered', (f) => f !== 'apps/web/src/theme.ts'],
  [/\bconsole\s*\./, 'console in src/content: content texts never go to the console', (f) => f.startsWith('apps/web/src/content/')],
  [/\b(indexedDB|showDirectoryPicker)\b/, 'nothing is cached in the browser in M2 (the dev server serves the home folder)', () => true],
];
const WEB_IMPORT = /['"](node:[^'"]*|@montecrit\/cli[^'"]*|[^'"]*\/cli\/src\/[^'"]*|[^'"]*\/tools\/[^'"]*|\.\.?\/(\.\.\/)*vite\/[^'"]*)['"]/;

export function scanWeb(file: string, text: string): { line: number; why: string }[] {
  const { code, unterminated } = stripCode(text);
  const lines = code.split('\n');
  const raw = text.split('\n');
  const hits: { line: number; why: string }[] = [];
  lines.forEach((line, i) => {
    for (const [re, why, applies] of WEB_RULES) if (applies(file) && re.test(line)) hits.push({ line: i + 1, why });
    if (IMPORT_SITE.test(line) && WEB_IMPORT.test(raw[i] ?? '')) hits.push({ line: i + 1, why: 'import from Node, the CLI, tools/ or the Vite plugins: the app imports only the engine, host and its own modules' });
  });
  if (unterminated) hits.push({ line: lines.length, why: 'unterminated block comment or template literal: the rest of the file was not scanned' });
  return hits;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') || p.endsWith('.tsx') ? [p] : [];
  });
}

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

if (import.meta.main) {
  const staged = process.argv[2] === '--staged';
  const files: [string, string][] = staged
    ? git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMRT'])
        .split('\0')
        .filter((f) => (f.startsWith(ENGINE_SRC) || f.startsWith(HOST_SRC) || f.startsWith(WEB_SRC)) && (f.endsWith('.ts') || f.endsWith('.tsx')))
        .map((f) => [f, git(['show', `:${f}`])])
    : [ENGINE_SRC, HOST_SRC, WEB_SRC].flatMap((d) => walk(join(root, d)).map((p): [string, string] => [relative(root, p), readFileSync(p, 'utf8')]));
  let bad = 0;
  for (const [file, text] of files) {
    for (const hit of file.startsWith(WEB_SRC) ? scanWeb(file, text) : file.startsWith(HOST_SRC) ? scanHost(text) : scanPath(file, text)) {
      console.error(`${file}:${hit.line}  ${hit.why}`);
      bad++;
    }
  }
  if (bad) {
    console.error(`lint-determinism: ${bad} problem(s)`);
    process.exitCode = 1;
  } else {
    console.log(`lint-determinism: ${files.length} engine, host and web file(s) clean${staged ? ' (staged)' : ''}`);
  }
}
