// Foundry roll formulas to our expression grammar, at import time (docs/design/m3.md 4.4, C16).
//
//   @mod                          -> @mod
//   @item.level                   -> @slot
//   @scale.<owner>.<column>       -> kept as is: qualified, as Foundry stores it (C16); the
//                                    short form is resolved relative to the owner at compile
//   @classes.<class>.levels       -> @classLevel (only for the owning class; another class's
//                                    level is a multiclass read and stays unimplemented)
//   @prof                         -> @pb
//   @abilities.<ability>.mod      -> @mod.<ability>
//   min(a, b), max(a, b)          -> the same
//
// Anything else (another @ path, another function, syntax our parser refuses) makes the
// item partial with one templated unimplemented line per problem (unimplemented.ts); the
// formula itself is then not emitted. The result always parses with the engine's parser.

import { ExprError, parseExpr } from '../../packages/engine/src/dice/expr.ts';
import { U } from './unimplemented.ts';

export type FormulaResult = { readonly ok: true; readonly expr: string } | { readonly ok: false; readonly lines: readonly string[] };

export interface FormulaCtx {
  /** The owning class's Foundry identifier (e.g. fighter), for @classes.<class>.levels. */
  readonly ownerClass?: string;
}

/** A Foundry roll-data path: hyphens only inside @scale segments (identifiers like sneak-attack). */
const PATH = /@(?:scale(?:\.[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)+|[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)/g;
const SCALE = /^@scale\.([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\.([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/;
const CLASS_LEVELS = /^@classes\.([a-z][a-z0-9-]*)\.levels$/;
const ABILITY_MOD = /^@abilities\.(str|dex|con|int|wis|cha)\.mod$/;
const ALLOWED_FNS: readonly string[] = ['max', 'min'];

function mapPath(path: string, ctx: FormulaCtx): string | undefined {
  if (path === '@mod') return '@mod';
  if (path === '@item.level') return '@slot';
  if (path === '@prof') return '@pb';
  const am = ABILITY_MOD.exec(path);
  if (am) return `@mod.${am[1]}`;
  if (SCALE.test(path)) return path;
  const cl = CLASS_LEVELS.exec(path);
  if (cl && (ctx.ownerClass === undefined || ctx.ownerClass === cl[1])) return '@classLevel';
  return undefined;
}

/** Converts one formula. Numbers come back as their decimal text. */
export function convertFormula(src: string | number, ctx: FormulaCtx = {}): FormulaResult {
  if (typeof src === 'number') {
    if (!Number.isInteger(src)) return { ok: false, lines: [U.formulaSyntax()] };
    return { ok: true, expr: String(src) };
  }
  const text = src.trim();
  if (text === '') return { ok: false, lines: [U.formulaSyntax()] };
  const lines: string[] = [];
  const out = text.replace(PATH, (path) => {
    const mapped = mapPath(path, ctx);
    if (mapped === undefined) {
      lines.push(PATH_SAFE.test(path) ? U.formulaPath(path) : U.formulaSyntax());
      return '0';
    }
    return mapped;
  });
  // Function names, read after the paths are replaced (so @scale.x.max isn't a call).
  const placeheld = out.replace(PATH, '0');
  for (const m of placeheld.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    const fn = m[1]!;
    if (!ALLOWED_FNS.includes(fn)) lines.push(/^[A-Za-z][A-Za-z0-9_]{0,30}$/.test(fn) ? U.formulaFunction(fn) : U.formulaSyntax());
  }
  if (lines.length) return { ok: false, lines: [...new Set(lines)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) };
  try {
    parseExpr(out);
  } catch (e) {
    if (e instanceof ExprError) return { ok: false, lines: [U.formulaSyntax()] };
    throw e;
  }
  return { ok: true, expr: out };
}

const PATH_SAFE = /^@[A-Za-z][A-Za-z0-9_.-]{0,80}$/;
