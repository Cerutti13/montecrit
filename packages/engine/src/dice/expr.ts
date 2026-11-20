// Dice expressions: a small, closed grammar shared by the sampler and the exact-odds code.
//
//   expr  := term (('+' | '-') term)*
//   term  := unary ('*' unary)*
//   unary := '-' unary | atom
//   atom  := INT | dice | VAR | call | '(' expr ')' | '(' expr ')' 'd' INT keep?
//   call  := ('min' | 'max') '(' expr ',' expr ')'
//   dice  := INT? 'd' INT keep?                      e.g. 1d4, d20, 2d20kh1, 4d6kh3
//   keep  := ('kh' | 'kl') INT
//   VAR   := '@' word ('.' word)*                    e.g. @pb, @mod.wis, @slot
//          | '@scale' ('.' name)+                     e.g. @scale.martial-arts, @scale.monk.martial-arts
//   word  := [a-z][a-z0-9]*                           no hyphen: @pb-d4 is @pb minus 1d4, @mod-1 is @mod minus 1
//   name  := word ('-' word)*                         only a @scale segment (a class or column id) takes hyphens;
//                                                     there a hyphen joins letters, so write @scale.x - d4 with spaces
//
// '(' expr ')' 'd' INT is a computed dice count, e.g. (@pb)d4: the count must come to a
// number (0..100; 0 rolls nothing) once its variables are bound. min and max take two
// arguments and may hold dice (max(1, 1d8 - 2)); their exact distribution is the
// independent max/min of the two sides, and the sampler draws the left side first.
//
// Variables are resolved from a context at evaluation time (the character's numbers), or
// bound once at compile time by bindExpr: a PC's class variables (@level, @classLevel,
// @scale.<column>) fold to numbers or plain dice there, so compiled nodes never carry a
// computed count and the hot path sees only const, dice, add, sub, mul, neg, min and max.

import { constant, convolve, keepDice, maxOf, minOf, negate, scale, sumOf, type Pmf } from '../odds/pmf.ts';
import { rollDie, type Stream } from '../rng/stream.ts';

export type ExprNode =
  | { k: 'const'; v: number }
  | { k: 'dice'; n: number; sides: number; keep?: { mode: 'h' | 'l'; count: number } }
  /** A computed dice count, (@pb)d4. Only the parser makes it; bindExpr turns it into dice. */
  | { k: 'vdice'; n: ExprNode; sides: number; keep?: { mode: 'h' | 'l'; count: number } }
  | { k: 'var'; name: string }
  | { k: 'add'; a: ExprNode; b: ExprNode }
  | { k: 'sub'; a: ExprNode; b: ExprNode }
  | { k: 'mul'; a: ExprNode; b: ExprNode }
  | { k: 'min'; a: ExprNode; b: ExprNode }
  | { k: 'max'; a: ExprNode; b: ExprNode }
  | { k: 'neg'; a: ExprNode };

export type ExprVars = Readonly<Record<string, number>>;

/** What a variable binds to at compile time: a number, or dice (a dice-valued class column such as 1d8). */
export type ExprBinding = number | ExprNode;

/**
 * Compile-time bindings: a table, or a function that returns undefined for an unknown name
 * (or throws an ExprError of its own, to say why a known name has no value here).
 */
export type ExprEnv = Readonly<Record<string, ExprBinding>> | ((name: string) => ExprBinding | undefined);

export class ExprError extends Error {}

const MAX_DICE = 100;
const MAX_SIDES = 1000;

export function parseExpr(src: string): ExprNode {
  let i = 0;
  const fail = (msg: string): never => {
    throw new ExprError(`${msg} at position ${i} in "${src}"`);
  };
  const skip = () => {
    while (i < src.length && /\s/.test(src[i]!)) i++;
  };
  const peek = () => {
    skip();
    return src[i];
  };
  const int = (): number | undefined => {
    skip();
    const m = /^\d+/.exec(src.slice(i));
    if (!m) return undefined;
    i += m[0].length;
    return Number(m[0]);
  };

  /** An optional kh/kl suffix after a die size; `count` is the dice count when it's known. */
  const keepSuffix = (count: number | undefined): { mode: 'h' | 'l'; count: number } | undefined => {
    const km = /^k([hl])/i.exec(src.slice(i));
    if (!km) return undefined;
    i += 2;
    const keep = int();
    if (keep === undefined) fail('expected keep count after kh/kl');
    if (keep! < 1 || (count !== undefined && keep! > count)) fail(`keep count must be 1..${count ?? 'the dice count'}`);
    return { mode: km[1]!.toLowerCase() as 'h' | 'l', count: keep! };
  };

  const dieSize = (): number => {
    const sides = int();
    if (sides === undefined) fail('expected die size after d');
    if (sides! < 1 || sides! > MAX_SIDES) fail(`die size must be 1..${MAX_SIDES}`);
    return sides!;
  };

  function atom(): ExprNode {
    const c = peek();
    if (c === '(') {
      i++;
      const e = expr();
      if (peek() !== ')') fail('expected )');
      i++;
      if (src[i] === 'd' || src[i] === 'D') {
        i++;
        const sides = dieSize();
        const node: Extract<ExprNode, { k: 'vdice' }> = { k: 'vdice', n: e, sides };
        const keep = keepSuffix(undefined);
        if (keep) node.keep = keep;
        return node;
      }
      return e;
    }
    if (c === '@') {
      i++;
      const head = /^[a-z][a-z0-9]*/i.exec(src.slice(i));
      if (!head) fail('expected a variable name after @');
      i += head![0].length;
      // Hyphens only inside @scale's class and column ids, so '@pb-d4' stays @pb minus 1d4.
      const rest = (head![0].toLowerCase() === 'scale' ? /^(\.[a-z][a-z0-9]*(-[a-z][a-z0-9]*)*)*/i : /^(\.[a-z][a-z0-9]*)*/i).exec(src.slice(i))!;
      i += rest[0].length;
      return { k: 'var', name: (head![0] + rest[0]).toLowerCase() };
    }
    const fn = /^(min|max)\s*\(/i.exec(src.slice(i));
    if (fn) {
      i += fn[0].length;
      const a = expr();
      if (peek() !== ',') fail(`expected , in ${fn[1]!.toLowerCase()}(a, b)`);
      i++;
      const b = expr();
      if (peek() !== ')') fail(`expected ) after ${fn[1]!.toLowerCase()}(a, b)`);
      i++;
      return { k: fn[1]!.toLowerCase() as 'min' | 'max', a, b };
    }
    const n = int();
    if (src[i] === 'd' || src[i] === 'D') {
      i++;
      const count = n ?? 1;
      const sides = int();
      if (sides === undefined) fail('expected die size after d');
      if (count < 1 || count > MAX_DICE) fail(`dice count must be 1..${MAX_DICE}`);
      if (sides! < 1 || sides! > MAX_SIDES) fail(`die size must be 1..${MAX_SIDES}`);
      const node: Extract<ExprNode, { k: 'dice' }> = { k: 'dice', n: count, sides: sides! };
      const keep = keepSuffix(count);
      if (keep) node.keep = keep;
      return node;
    }
    if (n === undefined) fail('expected a number, die, variable, min, max or (');
    return { k: 'const', v: n! };
  }

  function unary(): ExprNode {
    if (peek() === '-') {
      i++;
      return { k: 'neg', a: unary() };
    }
    return atom();
  }

  function term(): ExprNode {
    let left = unary();
    while (peek() === '*') {
      i++;
      left = { k: 'mul', a: left, b: unary() };
    }
    return left;
  }

  function expr(): ExprNode {
    let left = term();
    for (;;) {
      const c = peek();
      if (c === '+') {
        i++;
        left = { k: 'add', a: left, b: term() };
      } else if (c === '-') {
        i++;
        left = { k: 'sub', a: left, b: term() };
      } else return left;
    }
  }

  const root = expr();
  skip();
  if (i < src.length) fail(`unexpected "${src[i]}"`);
  return root;
}

function lookup(vars: ExprVars, name: string): number {
  const v = vars[name];
  if (v === undefined) throw new ExprError(`unknown variable @${name}`);
  if (!Number.isInteger(v)) throw new ExprError(`@${name} must be an integer, got ${v}`);
  return v;
}

/** True when the expression contains no dice (its value is fixed once vars are known). */
export function isConstant(node: ExprNode): boolean {
  switch (node.k) {
    case 'const':
    case 'var':
      return true;
    case 'dice':
    case 'vdice':
      return false;
    case 'neg':
      return isConstant(node.a);
    default:
      return isConstant(node.a) && isConstant(node.b);
  }
}

export function evalConstant(node: ExprNode, vars: ExprVars): number {
  switch (node.k) {
    case 'const':
      return node.v;
    case 'var':
      return lookup(vars, node.name);
    case 'dice':
    case 'vdice':
      throw new ExprError('expression contains dice; it has no single value');
    case 'neg':
      return -evalConstant(node.a, vars);
    case 'add':
      return evalConstant(node.a, vars) + evalConstant(node.b, vars);
    case 'sub':
      return evalConstant(node.a, vars) - evalConstant(node.b, vars);
    case 'mul':
      return evalConstant(node.a, vars) * evalConstant(node.b, vars);
    case 'min':
      return Math.min(evalConstant(node.a, vars), evalConstant(node.b, vars));
    case 'max':
      return Math.max(evalConstant(node.a, vars), evalConstant(node.b, vars));
  }
}

/**
 * The plain dice a computed count comes to: (@pb)d4 at PB 3 is 3d4. A count of 0 rolls
 * nothing (the constant 0); a keep count above the dice count is an error.
 */
function countedDice(node: Extract<ExprNode, { k: 'vdice' }>, count: number): ExprNode {
  const what = `(${formatExpr(node.n)})d${node.sides}`;
  if (!Number.isInteger(count) || count < 0 || count > MAX_DICE) throw new ExprError(`the dice count of ${what} comes to ${count}; it must be 0..${MAX_DICE}`);
  if (node.keep && node.keep.count > count) throw new ExprError(`the dice count of ${what} comes to ${count}, below its keep count ${node.keep.count}`);
  if (count === 0) return { k: 'const', v: 0 };
  return node.keep ? { k: 'dice', n: count, sides: node.sides, keep: node.keep } : { k: 'dice', n: count, sides: node.sides };
}

function vdiceCount(node: Extract<ExprNode, { k: 'vdice' }>, vars: ExprVars): number {
  if (!isConstant(node.n)) throw new ExprError(`a dice count must be a number, not dice: (${formatExpr(node.n)})d${node.sides}`);
  return evalConstant(node.n, vars);
}

/**
 * Binds every variable once (compile time): a number becomes a constant, a dice binding is
 * spliced in, a computed count becomes plain dice, and a min or max of two constants folds.
 * The result has no var and no vdice node. Unknown names are ExprErrors.
 */
export function bindExpr(node: ExprNode, env: ExprEnv): ExprNode {
  switch (node.k) {
    case 'const':
    case 'dice':
      return node;
    case 'var': {
      const v = typeof env === 'function' ? env(node.name) : env[node.name];
      if (v === undefined) throw new ExprError(`unknown variable @${node.name}`);
      if (typeof v !== 'number') return bindExpr(v, {});
      if (!Number.isInteger(v)) throw new ExprError(`@${node.name} must be an integer, got ${v}`);
      return { k: 'const', v };
    }
    case 'vdice': {
      const n = bindExpr(node.n, env);
      if (!isConstant(n)) throw new ExprError(`a dice count must be a number, not dice: (${formatExpr(node.n)})d${node.sides}`);
      return countedDice(node, evalConstant(n, {}));
    }
    case 'neg':
      return { k: 'neg', a: bindExpr(node.a, env) };
    case 'min':
    case 'max': {
      const a = bindExpr(node.a, env);
      const b = bindExpr(node.b, env);
      if (isConstant(a) && isConstant(b)) return { k: 'const', v: evalConstant({ k: node.k, a, b }, {}) };
      return { k: node.k, a, b };
    }
    default:
      return { k: node.k, a: bindExpr(node.a, env), b: bindExpr(node.b, env) };
  }
}

function dicePmf(node: Extract<ExprNode, { k: 'dice' }>): Pmf {
  if (node.keep) return keepDice(node.n, node.sides, node.keep.mode, node.keep.count);
  return keepDice(node.n, node.sides, 'h', node.n);
}

/**
 * Exact distribution. Products are allowed only when one side has no dice. min and max
 * combine their sides' distributions as independent variables, which they are: each side
 * rolls its own dice.
 */
export function exprPmf(node: ExprNode, vars: ExprVars = {}): Pmf {
  switch (node.k) {
    case 'const':
      return constant(node.v);
    case 'var':
      return constant(lookup(vars, node.name));
    case 'dice':
      return dicePmf(node);
    case 'vdice':
      return exprPmf(countedDice(node, vdiceCount(node, vars)));
    case 'neg':
      return negate(exprPmf(node.a, vars));
    case 'add':
      return convolve(exprPmf(node.a, vars), exprPmf(node.b, vars));
    case 'sub':
      return convolve(exprPmf(node.a, vars), negate(exprPmf(node.b, vars)));
    case 'mul':
      if (isConstant(node.a)) return scale(exprPmf(node.b, vars), evalConstant(node.a, vars));
      if (isConstant(node.b)) return scale(exprPmf(node.a, vars), evalConstant(node.b, vars));
      throw new ExprError('a product of two dice terms has no exact distribution here');
    case 'min':
      return minOf(exprPmf(node.a, vars), exprPmf(node.b, vars));
    case 'max':
      return maxOf(exprPmf(node.a, vars), exprPmf(node.b, vars));
  }
}

export function exprsPmf(nodes: readonly ExprNode[], vars: ExprVars = {}): Pmf {
  return sumOf(nodes.map((n) => exprPmf(n, vars)));
}

function sampleDice(node: Extract<ExprNode, { k: 'dice' }>, s: Stream): number {
  if (!node.keep || node.keep.count === node.n) {
    let sum = 0;
    for (let i = 0; i < node.n; i++) sum += rollDie(s, node.sides);
    return sum;
  }
  const rolls: number[] = [];
  for (let i = 0; i < node.n; i++) rolls.push(rollDie(s, node.sides));
  rolls.sort((x, y) => (node.keep!.mode === 'h' ? y - x : x - y));
  let sum = 0;
  for (let i = 0; i < node.keep.count; i++) sum += rolls[i]!;
  return sum;
}

/** One sample. min and max draw both sides, left first, whichever wins. */
export function sampleExpr(node: ExprNode, vars: ExprVars, s: Stream): number {
  switch (node.k) {
    case 'const':
      return node.v;
    case 'var':
      return lookup(vars, node.name);
    case 'dice':
      return sampleDice(node, s);
    case 'vdice':
      return sampleExpr(countedDice(node, vdiceCount(node, vars)), vars, s);
    case 'neg':
      return -sampleExpr(node.a, vars, s);
    case 'add':
      return sampleExpr(node.a, vars, s) + sampleExpr(node.b, vars, s);
    case 'sub':
      return sampleExpr(node.a, vars, s) - sampleExpr(node.b, vars, s);
    case 'mul':
      return sampleExpr(node.a, vars, s) * sampleExpr(node.b, vars, s);
    case 'min': {
      const a = sampleExpr(node.a, vars, s);
      return Math.min(a, sampleExpr(node.b, vars, s));
    }
    case 'max': {
      const a = sampleExpr(node.a, vars, s);
      return Math.max(a, sampleExpr(node.b, vars, s));
    }
  }
}

/**
 * The dice terms of an expression, signs kept, constants and variables dropped: what a
 * critical hit rolls a second time ("1d6 + 2" -> "1d6"). Null when there are no dice.
 * A product or a min/max containing dice has no clean crit reading, so it's rejected.
 */
export function diceOnly(node: ExprNode): ExprNode | null {
  switch (node.k) {
    case 'const':
    case 'var':
      return null;
    case 'dice':
    case 'vdice':
      return node;
    case 'neg': {
      const a = diceOnly(node.a);
      return a && { k: 'neg', a };
    }
    case 'add':
    case 'sub': {
      const a = diceOnly(node.a);
      const b = diceOnly(node.b);
      if (!a) return b && (node.k === 'sub' ? { k: 'neg', a: b } : b);
      if (!b) return a;
      return { k: node.k, a, b };
    }
    case 'mul':
      if (isConstant(node)) return null;
      throw new ExprError(`can't double the dice of a product for a critical hit: ${formatExpr(node)}`);
    case 'min':
    case 'max':
      if (isConstant(node)) return null;
      throw new ExprError(`can't double the dice inside ${node.k}() for a critical hit: ${formatExpr(node)}`);
  }
}

const keepText = (keep: { mode: 'h' | 'l'; count: number } | undefined): string => (keep ? `k${keep.mode}${keep.count}` : '');

export function formatExpr(node: ExprNode): string {
  switch (node.k) {
    case 'const':
      return String(node.v);
    case 'var':
      return `@${node.name}`;
    case 'dice':
      return `${node.n}d${node.sides}${keepText(node.keep)}`;
    case 'vdice':
      return `(${formatExpr(node.n)})d${node.sides}${keepText(node.keep)}`;
    case 'neg':
      return `-${wrap(node.a)}`;
    case 'add':
      return `${formatExpr(node.a)} + ${formatExpr(node.b)}`;
    case 'sub':
      return `${formatExpr(node.a)} - ${wrap(node.b)}`;
    case 'mul':
      return `${wrap(node.a)} * ${wrap(node.b)}`;
    case 'min':
    case 'max':
      return `${node.k}(${formatExpr(node.a)}, ${formatExpr(node.b)})`;
  }
}

function wrap(node: ExprNode): string {
  return node.k === 'add' || node.k === 'sub' ? `(${formatExpr(node)})` : formatExpr(node);
}
