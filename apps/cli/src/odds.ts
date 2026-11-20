// `montecrit odds`: exact chance to pass a d20 test, with an optional Monte Carlo cross-check.

import { parseArgs } from 'node:util';
import {
  DEFAULT_FLAGS,
  FLAG_INFO,
  describeFlags,
  exprPmf,
  formatExpr,
  openStream,
  parseExpr,
  resolveAdvantage,
  rollOdds,
  sampleRoll,
  type ExprNode,
  type RollOdds,
  type RollSpec,
  type RuleFlags,
} from '@montecrit/engine';

export const ODDS_USAGE = `usage: montecrit odds --dc N [options]
       montecrit odds --attack --ac N [options]

  --mod N            total fixed modifier (ability + proficiency + flat bonuses), default 0
  --dc N             DC for a check or save
  --save             roll is a saving throw (default: ability check)
  --attack           roll is an attack roll; use --ac instead of --dc
  --ac N             target's Armor Class (attacks)
  --adv, --dis       advantage / disadvantage (both together cancel to a straight roll)
  --guidance         add 1d4 to the check
  --dice EXPR        add dice to the roll, e.g. --dice 1d4 (repeatable)
  --bardic DIE       add a die only after seeing a failure, e.g. --bardic d6
  --after-fail EXPR  same as --bardic, any expression
  --floor N          treat any d20 below N as N
  --crit N           attacks: lowest natural roll that crits (default 20)
  --flag K=V         override a rule flag, e.g. --flag natOnChecksAndSaves=autoPassFail
  --verify N         also roll it N times and compare to the exact answer
  --seed N           seed for --verify (default 42)
  --json             machine-readable output`;

export interface OddsRequest {
  spec: RollSpec;
  flags: RuleFlags;
  labels: string[];
  notes: string[];
  verify?: number;
  seed: number;
  json: boolean;
}

export class UsageError extends Error {}

const MAX_VERIFY = 100_000_000;

function int(name: string, v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (!/^-?\d+$/.test(v) || !Number.isSafeInteger(Number(v))) {
    throw new UsageError(`--${name} needs a whole number (up to 2^53), got "${v}"`);
  }
  return Number(v);
}

/** Parses an expression and checks it has an exact distribution, as a usage error. */
function checkedExpr(src: string, what: string): ExprNode {
  const node = parseExpr(src);
  try {
    const pmf = exprPmf(node);
    if (what === 'after-fail' && pmf.min < 0) {
      throw new UsageError(`an after-failure die can't go negative ("${src}" can reach ${pmf.min})`);
    }
  } catch (e) {
    if (e instanceof RangeError) throw new UsageError(e.message);
    throw e;
  }
  return node;
}

/** "d6" is shorthand for "1d6". */
function dieSrc(v: string): string {
  return /^d\d+$/i.test(v) ? `1${v}` : v;
}

function parseFlag(flags: RuleFlags, kv: string): RuleFlags {
  const m = /^([A-Za-z]+)=(.+)$/.exec(kv);
  if (!m) throw new UsageError(`--flag needs KEY=VALUE, got "${kv}"`);
  if (!Object.hasOwn(FLAG_INFO, m[1]!)) {
    throw new UsageError(`unknown rule flag "${m[1]}" (known: ${Object.keys(FLAG_INFO).join(', ')})`);
  }
  const key = m[1] as keyof RuleFlags;
  const info = FLAG_INFO[key];
  const raw = m[2]!;
  const value = (info.options as readonly unknown[]).find((o) => String(o) === raw);
  if (value === undefined) throw new UsageError(`flag ${key} must be one of ${info.options.join(', ')}`);
  return { ...flags, [key]: value };
}

const VALUE_OPTIONS = new Set(['mod', 'dc', 'ac', 'dice', 'bardic', 'after-fail', 'floor', 'crit', 'flag', 'verify', 'seed']);

/** node's parseArgs reads "--mod -2" as two options; join a negative value onto its option. */
function joinNegativeValues(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = argv[i + 1];
    if (a.startsWith('--') && VALUE_OPTIONS.has(a.slice(2)) && next !== undefined && /^-\d/.test(next)) {
      out.push(`${a}=${next}`);
      i++;
    } else out.push(a);
  }
  return out;
}

export function parseOddsArgs(argv: readonly string[]): OddsRequest {
  const { values } = parseArgs({
    args: joinNegativeValues(argv),
    options: {
      mod: { type: 'string' },
      dc: { type: 'string' },
      ac: { type: 'string' },
      save: { type: 'boolean' },
      attack: { type: 'boolean' },
      adv: { type: 'boolean' },
      dis: { type: 'boolean' },
      guidance: { type: 'boolean' },
      dice: { type: 'string', multiple: true },
      bardic: { type: 'string' },
      'after-fail': { type: 'string' },
      floor: { type: 'string' },
      crit: { type: 'string' },
      flag: { type: 'string', multiple: true },
      verify: { type: 'string' },
      seed: { type: 'string' },
      json: { type: 'boolean' },
    },
    strict: true,
  });

  if (values.save && values.attack) throw new UsageError('pick one of --save and --attack');
  const kind = values.attack ? 'attack' : values.save ? 'save' : 'check';
  const dc = kind === 'attack' ? int('ac', values.ac) : int('dc', values.dc);
  if (dc === undefined) throw new UsageError(kind === 'attack' ? 'attacks need --ac' : 'need --dc');
  if (kind === 'attack' && values.dc !== undefined) throw new UsageError('attacks use --ac, not --dc');
  if (kind !== 'attack' && values.ac !== undefined) throw new UsageError('--ac is for attacks; use --dc');
  if (values.bardic && values['after-fail']) throw new UsageError('pick one of --bardic and --after-fail');

  const labels: string[] = [];
  const notes: string[] = [];
  const preDice: ExprNode[] = [];
  if (values.guidance) {
    if (kind !== 'check') {
      throw new UsageError('Guidance only adds to ability checks, not saves or attacks (use --dice 1d4 for a table ruling)');
    }
    preDice.push(parseExpr('1d4'));
    labels.push('1d4 (Guidance)');
    notes.push('Guidance (SRD 5.2.1): +1d4 to ability checks that use the chosen skill. It does not apply to checks with no skill, such as initiative.');
  }
  for (const e of values.dice ?? []) {
    const node = checkedExpr(e, 'dice');
    preDice.push(node);
    labels.push(formatExpr(node));
  }

  const afterSrc = values.bardic ?? values['after-fail'];
  const afterFail = afterSrc !== undefined ? checkedExpr(dieSrc(afterSrc), 'after-fail') : undefined;

  const floor = int('floor', values.floor);
  const critMin = int('crit', values.crit);
  if (critMin !== undefined && kind !== 'attack') throw new UsageError('--crit only applies to attacks');
  if (critMin !== undefined && (critMin < 2 || critMin > 20)) throw new UsageError('--crit must be between 2 and 20');

  let flags = DEFAULT_FLAGS;
  for (const kv of values.flag ?? []) flags = parseFlag(flags, kv);

  const verify = int('verify', values.verify);
  if (verify !== undefined && (verify < 1 || verify > MAX_VERIFY)) {
    throw new UsageError(`--verify must be between 1 and ${MAX_VERIFY.toLocaleString('en-US')}`);
  }
  const seed = int('seed', values.seed) ?? 42;
  if (seed < 0) throw new UsageError('--seed must be non-negative');

  const spec: RollSpec = {
    kind,
    adv: resolveAdvantage(values.adv ? ['--adv'] : [], values.dis ? ['--dis'] : []),
    flat: int('mod', values.mod) ?? 0,
    preDice,
    dc,
    ...(afterFail ? { afterFail } : {}),
    ...(floor !== undefined ? { floor } : {}),
    ...(critMin !== undefined ? { critMin } : {}),
  };
  return { spec, flags, labels, notes, ...(verify !== undefined ? { verify } : {}), seed, json: !!values.json };
}

export interface VerifyResult {
  n: number;
  seed: number;
  pSuccess: number;
  z: number;
}

export function verifyOdds(spec: RollSpec, flags: RuleFlags, exact: RollOdds, n: number, seed: number): VerifyResult {
  let hits = 0;
  for (let run = 0; run < n; run++) {
    if (sampleRoll(spec, openStream(seed, run, 0, 'check', 0), flags).success) hits++;
  }
  const p = Math.min(1, Math.max(0, exact.pSuccess));
  const phat = hits / n;
  // A certain outcome has no spread: the sample either matches it exactly or it's a bug.
  if (p < 1e-12 || p > 1 - 1e-12) return { n, seed, pSuccess: phat, z: phat === Math.round(p) ? 0 : Infinity };
  return { n, seed, pSuccess: phat, z: (phat - p) / Math.sqrt((p * (1 - p)) / n) };
}

const pct = (p: number) => `${(p * 100).toFixed(2)}%`;
const signed = (n: number) => (n >= 0 ? `+ ${n}` : `- ${-n}`);

function describeRoll(req: OddsRequest): string {
  const { spec } = req;
  const parts = [`d20 ${signed(spec.flat)}`, ...req.labels.map((l) => `+ ${l}`)];
  const target = spec.kind === 'attack' ? `AC ${spec.dc}` : `DC ${spec.dc}`;
  const roll = spec.adv === 'adv' ? 'advantage' : spec.adv === 'dis' ? 'disadvantage' : 'straight roll';
  const kind = spec.kind === 'attack' ? 'Attack' : spec.kind === 'save' ? 'Save' : 'Check';
  return `${kind}: ${parts.join(' ')} vs ${target}, ${roll}`;
}

export interface OddsOutput {
  text: string;
  /** False when --verify's sampled rate disagrees with the exact answer beyond 4 sigma. */
  agrees: boolean;
}

export function runOdds(argv: readonly string[]): OddsOutput {
  const req = parseOddsArgs(argv);
  const exact = rollOdds(req.spec, req.flags);
  const verify = req.verify !== undefined ? verifyOdds(req.spec, req.flags, exact, req.verify, req.seed) : undefined;
  const flagKeys: (keyof RuleFlags)[] = [req.spec.kind === 'attack' ? 'expandedCritAutoHits' : 'natOnChecksAndSaves'];
  const agrees = !verify || Math.abs(verify.z) < 4;

  if (req.json) {
    const text = JSON.stringify(
      {
        spec: { ...req.spec, preDice: req.spec.preDice.map(formatExpr), afterFail: req.spec.afterFail && formatExpr(req.spec.afterFail) },
        pSuccess: exact.pSuccess,
        pBaseSuccess: exact.pBaseSuccess,
        pAfterFailUsed: exact.pAfterFailUsed,
        pCrit: exact.pCrit,
        flags: describeFlags(req.flags, flagKeys),
        notes: req.notes,
        ...(verify ? { verify: { ...verify, agrees } } : {}),
      },
      null,
      2,
    );
    return { text, agrees };
  }

  const lines = [describeRoll(req)];
  if (req.spec.floor !== undefined) lines.push(`  (any d20 below ${req.spec.floor} counts as ${req.spec.floor})`);
  const label = req.spec.kind === 'attack' ? 'P(hit)' : 'P(success)';
  lines.push(`  ${label.padEnd(20)}${pct(exact.pSuccess)}`);
  if (req.spec.kind === 'attack') lines.push(`  ${'P(crit)'.padEnd(20)}${pct(exact.pCrit)}`);
  if (req.spec.afterFail) {
    lines.push(`  ${'without the die'.padEnd(20)}${pct(exact.pBaseSuccess)}`);
    lines.push(`  ${`${formatExpr(req.spec.afterFail)} gets spent`.padEnd(20)}${pct(exact.pAfterFailUsed)}`);
  }
  if (verify) {
    const ok = agrees ? 'agrees within 4 sigma' : 'DISAGREES: investigate';
    lines.push(
      `  sampled ${verify.n.toLocaleString('en-US')} rolls (seed ${verify.seed}): ${pct(verify.pSuccess)}, z = ${verify.z.toFixed(2)}, ${ok}`,
    );
  }
  lines.push('Rule flags:', ...describeFlags(req.flags, flagKeys).map((l) => `  ${l}`));
  if (req.notes.length) lines.push('Notes:', ...req.notes.map((n) => `  ${n}`));
  return { text: lines.join('\n'), agrees };
}
