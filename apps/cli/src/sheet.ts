// `montecrit sheet <id> [--vs-ac N] [--json]`: one creature's derived numbers, each attack's
// exact hit and crit odds against an AC (rollOdds, rule flags at their defaults), expected
// damage per attack, its attack action, options, and the stamps that say how far to trust it.
// Casters also get hands and items, slots and pools, spells grouped by casting source (to-hit,
// DC and the dice at each castable level), and features.

import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  ABILITIES,
  DAMAGE_TYPES,
  DEFAULT_FLAGS,
  HOOK,
  SIZES,
  describeFlags,
  exprMean,
  formatDiag,
  formatExpr,
  keyName,
  plainAlt,
  rollOdds,
  sheetJson as derivedJson,
  type CompiledAttack,
  type CompiledDamage,
  type CompiledFeature,
  type CompiledTemplate,
  type KeyPattern,
  type PoolDef,
  type SpellEntry,
  type Step,
} from '@montecrit/engine';
import { REPO_ROOT, displayPath, isFile } from './files.ts';
import { loadWithFiles, type Env } from './home.ts';
import type { CommandOutput } from './lint.ts';
import { UsageError } from './odds.ts';

export const SHEET_USAGE = `usage: montecrit sheet <id|file> [--vs-ac N] [--json]

  <id>        a creature id, e.g. srd:goblin-warrior, or a character's (kind: character compiles like a pc)
  <file>      a content file: a kind: character outside every pack loads on its own (test: or private: id)
  --vs-ac N   target AC for hit odds and expected damage (default 15)
  --json      machine-readable output`;

const signed = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);
const pct = (p: number): string => `${(p * 100).toFixed(2)}%`;
const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

export interface AttackStats {
  readonly pHit: number;
  readonly pCrit: number;
  /** Mean damage of a normal hit, riders that need Advantage left out. */
  readonly meanDamage: number;
  /** Mean of the extra crit dice, same riders left out. */
  readonly meanCritExtra: number;
  /** P(hit, not crit) * E[dmg] + P(crit) * (E[dmg] + E[crit extra]). */
  readonly expectedDamage: number;
}

/** Exact odds on a straight roll vs ac, with rule flags at their defaults. */
export function attackStats(a: CompiledAttack, ac: number): AttackStats {
  const odds = rollOdds({ kind: 'attack', adv: 'none', flat: a.toHit, preDice: [], dc: ac, critMin: a.critMin }, DEFAULT_FLAGS);
  const parts = a.damage.filter((d) => !d.ifAdvantage);
  const meanDamage = sum(parts.map((d) => exprMean(d.roll)));
  const meanCritExtra = sum(parts.map((d) => (d.critExtra ? exprMean(d.critExtra) : 0)));
  const expectedDamage = (odds.pSuccess - odds.pCrit) * meanDamage + odds.pCrit * (meanDamage + meanCritExtra);
  return { pHit: odds.pSuccess, pCrit: odds.pCrit, meanDamage, meanCritExtra, expectedDamage };
}

function damageText(d: CompiledDamage): string {
  const base = `${formatExpr(d.roll)} ${DAMAGE_TYPES[d.type]} (avg ${d.avg})`;
  return d.ifAdvantage ? `${base} if the roll had Advantage` : base;
}

function reachText(a: CompiledAttack, tpl: CompiledTemplate): string {
  const where = a.kind === 'melee' ? `reach ${a.reachFt} ft.` : `range ${a.normalFt}/${a.longFt} ft.`;
  const g = a.gear >= 0 ? tpl.gear[a.gear] : undefined;
  return a.consumesGear && g ? `${where}, uses up ${g.name} (${g.count})` : where;
}

function gearText(tpl: CompiledTemplate): string {
  if (tpl.gear.length === 0) return 'none listed';
  return tpl.gear.map((g) => (g.count >= 0 ? `${g.name} (${g.count})` : g.name)).join(', ');
}

/**
 * The attack action's lines. A Multiattack monster's last alternative is the plain Attack action
 * (step E: one strike with any of its attacks, `plainAlt`); it prints on its own line, not as a
 * Multiattack choice.
 */
function actLines(tpl: CompiledTemplate): string[] {
  const act = tpl.attackAct;
  const plain = plainAlt(act);
  const names = (from: readonly number[]): string => from.map((i) => tpl.attacks[i]!.name).join(' | ');
  const alts = act.alts.filter((_, k) => k !== plain).map((alt) => alt.map((g) => `${g.count} x [${names(g.from)}]`).join(' + '));
  const head = `${act.name}${act.extraAttack ? ' (Extra Attack)' : ''}${alts.length > 1 ? ', choose one' : ''}:`;
  const lines = [head, ...alts.map((a) => `  ${a}`)];
  if (plain >= 0) lines.push(`Attack action: one of [${names(act.alts[plain]!.flatMap((g) => g.from))}]`);
  return lines;
}

function optionText(o: CompiledTemplate['options'][number]): string {
  const cost = o.cost === 'bonus' ? 'bonus action' : 'action';
  const core = o.core === 'core:dash' ? 'Dash' : 'Disengage';
  return o.id === o.core ? `${o.name} (${cost})` : `${o.name} (${cost}; works as ${core})`;
}

const ABIL = (i: number): string => ABILITIES[i]!.toUpperCase();
const partsText = (dmg: readonly CompiledDamage[]): string => dmg.map((d) => `${formatExpr(d.roll)} ${DAMAGE_TYPES[d.type]}`).join(' + ');

/** What a program does at one cast level, as short phrases: dice, DCs and to-hits, following applied effects. */
export function programPhrases(tpl: CompiledTemplate, steps: readonly Step[], seen: Set<number> = new Set()): string[] {
  const out: string[] = [];
  for (const s of steps) {
    switch (s.k) {
      case 'attack': {
        const dmg = s.onHit.find((x) => x.k === 'damage');
        const head = `${s.atk.kind} spell attack ${signed(s.atk.toHit)}${s.atk.kind === 'melee' && s.atk.reachFt > 5 ? ` (reach ${s.atk.reachFt} ft)` : ''}`;
        out.push(dmg && dmg.k === 'damage' ? `${head}, ${partsText(dmg.dmg)}` : head);
        out.push(...programPhrases(tpl, s.onHit.filter((x) => x.k !== 'damage'), seen), ...programPhrases(tpl, s.onMiss, seen));
        break;
      }
      case 'save':
        out.push(`${ABIL(s.ability)} save DC ${s.dc}${s.dmg ? `, ${partsText(s.dmg)}${s.half ? ', half on a success' : ''}` : ''}`);
        out.push(...programPhrases(tpl, s.onFail, seen), ...programPhrases(tpl, s.onSuccess, seen));
        break;
      case 'damage':
        out.push(partsText(s.dmg));
        break;
      case 'heal':
        out.push(`heal ${formatExpr(s.roll)}`);
        break;
      case 'forced':
        out.push(`${s.mode} up to ${s.maxFt} ft (${SIZES[s.maxSize]} or smaller)`);
        break;
      case 'choose':
        for (const o of s.opts) {
          const inner = programPhrases(tpl, o.steps, seen);
          out.push(inner.length > 0 ? `${o.name}: ${inner.join(', ')}` : o.name);
        }
        break;
      case 'apply': {
        if (seen.has(s.fx)) break;
        seen.add(s.fx);
        const e = tpl.effects[s.fx];
        if (!e) break;
        for (const m of e.mods) {
          const on = m.on.map(patternText).join(', ');
          if (m.op === 'preDice' && m.dice) out.push(`+${formatExpr(m.dice)} ${m.skillParam ? 'to checks with the chosen skill' : `on ${on}`}`);
          else if (m.op === 'floor') out.push(`a d20 below ${m.value} counts as ${m.value} on ${on}`);
          else if (m.op === 'adv' || m.op === 'dis') out.push(`${m.side === 'incoming' ? `${on} against it have` : `its ${on} have`} ${m.op === 'adv' ? 'Advantage' : 'Disadvantage'}${m.consume ? ' (the next one only)' : ''}`);
          else if (m.op === 'flat') out.push(`${signed(m.value)} on ${on}`);
        }
        for (const h of e.hooks) {
          const inner = programPhrases(tpl, h.steps, seen);
          if (inner.length > 0) out.push(`${hookText(h.on)}: ${inner.join(', ')}`);
        }
        for (const g of e.grants) {
          const inner = programPhrases(tpl, g.steps, seen);
          out.push(inner.length > 0 ? `${g.name}: ${inner.join(', ')}` : g.name);
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** 'INT checks', 'CON saves to keep concentration', 'attack rolls', 'd20 tests'. */
function patternText(p: KeyPattern): string {
  if (p.mask === 0) return 'd20 tests';
  const name = keyName(p.val);
  const parts = name.split('.');
  const kind = parts[0] === 'attack' ? 'attack rolls' : parts[0] === 'save' ? 'saves' : 'checks';
  if (parts.includes('concentration')) return 'CON saves to keep concentration';
  const ab = parts.find((x) => ['str', 'dex', 'con', 'int', 'wis', 'cha'].includes(x));
  const rest = parts.slice(1).filter((x) => x !== ab);
  return [ab ? ab.toUpperCase() : '', ...rest, kind].filter(Boolean).join(' ');
}

const HOOK_TEXT: readonly [number, string][] = [
  [HOOK.appear, 'when it appears'], [HOOK.movedOnto, 'when moved onto a creature'], [HOOK.enter, 'when a creature enters'],
  [HOOK.travel, 'per 5 ft a creature travels in it'], [HOOK.turnEndIn, 'when a creature ends its turn in it'], [HOOK.turnStart, 'at the start of its bearer\'s turn'],
  [HOOK.turnEnd, 'at the end of its bearer\'s turn'], [HOOK.damaged, 'when its bearer takes damage'], [HOOK.slotHeal, 'after a spell cast with a slot heals'],
];

function hookText(on: number): string {
  return HOOK_TEXT.filter(([bit]) => on & bit).map(([, t]) => t).join(' or ');
}

function spellHead(e: SpellEntry): string {
  const sp = e.spell;
  const range = sp.rangeFt === 0 ? 'self' : sp.rangeFt === 5 ? 'touch' : `${sp.rangeFt} ft`;
  const comps = [sp.v ? 'V' : '', sp.s ? 'S' : '', sp.m === 'focus' ? 'M' : ''].filter(Boolean).join(' ');
  const bits = [sp.level === 0 ? 'cantrip' : `level ${sp.level}`, sp.cast === 'bonus' ? 'bonus action' : 'action', range];
  if (sp.conc) bits.push('concentration');
  bits.push(comps || 'no components');
  return `${sp.name} (${bits.join(', ')})`;
}

function spellLines(tpl: CompiledTemplate): string[] {
  if (tpl.spells.length === 0) return [];
  const lines = ['Spells:'];
  const sources: string[] = [];
  for (const e of tpl.spells) if (!sources.includes(e.source)) sources.push(e.source);
  for (const src of sources) {
    const entries = tpl.spells.filter((e) => e.source === src);
    const first = entries[0]!;
    const held = first.whileHeld >= 0 ? `, only while holding ${tpl.items[first.whileHeld]!.name}` : '';
    lines.push(`  ${src} (${ABIL(first.ability)}, ${first.list} list${held}): spell attack ${signed(first.toHit)}, save DC ${first.dc}`);
    for (const e of entries) {
      const free = e.freePool >= 0 ? ` [free: ${tpl.pools[e.freePool - 9]!.name}, ${tpl.resMax[e.freePool]}${e.slotted ? '' : '; no slots'}]` : '';
      lines.push(`    ${spellHead(e)}${free}`);
      e.prog.forEach((steps, lvl) => {
        if (!steps) return;
        const what = programPhrases(tpl, steps);
        lines.push(`      ${lvl === 0 ? 'cantrip' : `L${lvl}`}: ${what.length > 0 ? what.join('; ') : '(no dice)'}`);
      });
      if (e.prog.every((x) => x === null)) lines.push('      (no castable level)');
    }
  }
  return lines;
}

function resourceLines(tpl: CompiledTemplate): string[] {
  const lines: string[] = [];
  const slots = tpl.resMax.slice(0, 9);
  if (slots.some((n) => n > 0)) lines.push(`Slots: ${slots.map((n, i) => (n > 0 ? `L${i + 1} ${n}` : '')).filter(Boolean).join(', ')}`);
  if (tpl.pools.length > 0) {
    const rech = { shortRest: 'short rest', longRest: 'long rest', none: 'no recharge' } as const;
    const period = { short: 'short rest', long: 'long rest', turn: 'each turn', dawn: 'dawn' } as const;
    const recharge = (r: PoolDef['recharge']): string => (typeof r === 'string' ? rech[r] : r.map((x) => `${x.amount === 'all' ? 'all' : x.amount} on ${period[x.period]}`).join('; '));
    // Coverage step 7.6: a monster's Recharge use comes back on its d6; a monster's per-day use is n per day.
    const rechargeOf = (pl: PoolDef, i: number): string => {
      if (tpl.kind !== 'monster') return recharge(pl.recharge);
      const r = tpl.rechargeUse?.find((x) => x.pool === 9 + i);
      return r ? `recharge ${r.min === 6 ? '6' : `${r.min}-6`}` : 'per day, never back in a fight';
    };
    lines.push(`Pools: ${tpl.pools.map((pl, i) => `${pl.name} ${pl.max} (${rechargeOf(pl, i)})`).join(', ')}`);
  }
  return lines;
}

function handLines(tpl: CompiledTemplate): string[] {
  if (tpl.items.length === 0) return [];
  const itemText = (i: number) => {
    const it = tpl.items[i]!;
    return it.kind === 'shield' ? `${it.name} (shield, +${it.shieldAc} AC)` : it.kind === 'focus' ? `${it.name} (focus: ${it.focusFor.join(', ')})` : `${it.name} (${it.kind})`;
  };
  const hand = (i: number) => (i < 0 ? 'empty' : itemText(i));
  const lines = [`Hands: ${hand(tpl.startHands[0])} | ${hand(tpl.startHands[1])}`];
  const stowed = tpl.items.map((_, i) => i).filter((i) => !tpl.startHands.includes(i));
  if (stowed.length > 0) lines.push(`Stowed: ${stowed.map(itemText).join(', ')}`);
  return lines;
}

function featureText(tpl: CompiledTemplate, f: CompiledFeature): string[] {
  const lines: string[] = [];
  const pool = (i: number) => (i >= 9 ? tpl.pools[i - 9]!.name : 'free');
  if (f.activate) {
    const a = f.activate;
    const what = programPhrases(tpl, a.steps);
    const cost = a.cost === 'bonus' ? 'bonus action' : a.cost === 'free' ? 'no action' : 'action';
    lines.push(`  ${f.name}: ${a.name} (${cost}, spends ${pool(a.pool)}${a.perTurn ? ', once per turn' : ''}${a.recharge !== undefined ? `, recharge ${a.recharge === 6 ? '6' : `${a.recharge}-6`}` : a.pool >= 9 && tpl.kind === 'monster' ? `, ${tpl.resMax[a.pool]}/day` : ''})${what.length > 0 ? `: ${what.join('; ')}` : ''}`);
  }
  if (f.preRoll) {
    const r = f.preRoll;
    const sign = r.sign === 1 ? '+' : r.sign === -1 ? '-' : '+/-';
    const kinds = (['attack', 'save', 'check'] as const).filter((_, i) => r.kinds & (1 << (i + 1))).join(', ');
    lines.push(`  ${f.name}: reaction before a D20 Test (${kinds}) within ${r.rangeFt} ft, ${sign}${formatExpr(r.die)} (spends ${pool(r.pool)})`);
  }
  // Coverage step 9+: a stat block's traits and Reactions (a PC's sheet is unchanged).
  if (tpl.kind === 'monster') {
    if (f.passive) lines.push(`  ${f.name}: trait, always on`);
    if (f.hitKnown) {
      const kinds = [f.hitKnown.attacks & 1 ? 'melee' : '', f.hitKnown.attacks & 2 ? 'ranged' : ''].filter((x) => x).join(' or ');
      lines.push(`  ${f.name}: reaction when hit by a ${kinds} attack roll, +${f.hitKnown.ac} AC against that attack`);
    }
    if (f.declared) lines.push(`  ${f.name}: reaction when an attack roll is made against it, swaps places with a ${f.declared.swapMinSize === f.declared.swapMaxSize ? SIZES[f.declared.swapMaxSize] : `${SIZES[f.declared.swapMinSize]} to ${SIZES[f.declared.swapMaxSize]}`} ally within ${f.declared.swapRangeFt} ft, who becomes the target`);
  }
  return lines;
}

export function renderSheet(tpl: CompiledTemplate, ac: number): string {
  const mods = tpl.scores.map((s) => Math.floor((s - 10) / 2));
  const col = (xs: readonly string[]) => xs.map((x) => x.padStart(5)).join('');
  const lines = [
    `${tpl.name}  ${tpl.id}  (${tpl.kind}, ${SIZES[tpl.size]})`,
    `Source: ${tpl.source}`,
    `Fidelity: ${tpl.fidelity}    Placeholder: ${tpl.placeholder ? 'YES (stats are stand-ins)' : 'no'}`,
  ];
  if (tpl.unimplemented.length > 0) lines.push('Not modeled:', ...tpl.unimplemented.map((u) => `  - ${u}`));
  const hp = tpl.hpFormula ? `${tpl.hpMax} (${formatExpr(tpl.hpFormula)})` : `${tpl.hpMax}`;
  const shield = tpl.startHands.find((i) => i >= 0 && tpl.items[i]!.kind === 'shield');
  const acText = shield === undefined ? `${tpl.ac}` : `${tpl.ac + tpl.items[shield]!.shieldAc} (${tpl.ac} without the ${tpl.items[shield]!.name})`;
  lines.push(
    '',
    `AC ${acText}    HP ${hp}    Speed ${tpl.speedFt} ft.    PB ${signed(tpl.pb)}    Initiative ${signed(tpl.initMod)} (score ${tpl.initScore})`,
    '',
    `      ${col(ABILITIES.map((a) => a.toUpperCase()))}`,
    `Score ${col(tpl.scores.map(String))}`,
    `Mod   ${col(mods.map(signed))}`,
    `Save  ${col(tpl.saveMod.map(signed))}`,
    '',
    `Gear: ${gearText(tpl)}`,
    '',
    `Attacks vs AC ${ac} (straight roll):`,
  );
  for (const a of tpl.attacks) {
    const s = attackStats(a, ac);
    lines.push(
      `  ${a.name.padEnd(24)} ${a.kind} ${signed(a.toHit)}, ${reachText(a, tpl)}`,
      `      damage: ${a.damage.map(damageText).join('; ')}`,
      `      P(hit) ${pct(s.pHit)}   P(crit) ${pct(s.pCrit)}   E[damage] ${s.expectedDamage.toFixed(3)}`,
    );
  }
  lines.push('', ...actLines(tpl), '', 'Options:', ...tpl.options.map((o) => `  ${optionText(o)}`), '');
  const caster = [...handLines(tpl), ...resourceLines(tpl)];
  if (caster.length > 0) lines.push(...caster, '');
  const spells = spellLines(tpl);
  if (spells.length > 0) lines.push(...spells, '');
  if (tpl.features.length > 0) lines.push('Features:', ...tpl.features.flatMap((f) => featureText(tpl, f)), '');
  if (tpl.resist | tpl.vuln | tpl.immune) {
    const types = (m: number) => DAMAGE_TYPES.filter((_, i) => m & (1 << i)).join(', ');
    const parts = [tpl.resist ? `resist ${types(tpl.resist)}` : '', tpl.vuln ? `vulnerable ${types(tpl.vuln)}` : '', tpl.immune ? `immune ${types(tpl.immune)}` : ''];
    lines.push(`Damage: ${parts.filter(Boolean).join('; ')}`, '');
  }
  if (tpl.attacks.some((a) => a.damage.some((d) => d.ifAdvantage))) {
    lines.push('E[damage] leaves out riders that need Advantage (a straight roll never has it).');
  }
  lines.push('Rule flags:', ...describeFlags(DEFAULT_FLAGS, ['expandedCritAutoHits']).map((l) => `  ${l}`));
  return lines.join('\n');
}

/**
 * `attackAct` for `--json`: `alts` are the Multiattack choices only; a Multiattack monster's plain
 * Attack action (its last alternative, `plainAlt`) is the `attackAction` key, present only when
 * `multi`, so a non-Multiattack template's JSON is unchanged.
 */
function attackActJson(tpl: CompiledTemplate): unknown {
  const act = tpl.attackAct;
  const plain = plainAlt(act);
  const alt = (a: (typeof act.alts)[number]) => a.map((g) => ({ count: g.count, from: g.from.map((i) => tpl.attacks[i]!.id) }));
  return {
    name: act.name,
    multi: act.multi,
    extraAttack: act.extraAttack,
    alts: act.alts.filter((_, k) => k !== plain).map(alt),
    ...(plain >= 0 ? { attackAction: alt(act.alts[plain]!) } : {}),
  };
}

export function sheetJson(tpl: CompiledTemplate, ac: number): unknown {
  return {
    id: tpl.id,
    name: tpl.name,
    kind: tpl.kind,
    size: SIZES[tpl.size],
    source: tpl.source,
    fidelity: tpl.fidelity,
    placeholder: tpl.placeholder,
    unimplemented: tpl.unimplemented,
    ac: tpl.ac,
    hp: tpl.hpMax,
    hpFormula: tpl.hpFormula ? formatExpr(tpl.hpFormula) : null,
    speedFt: tpl.speedFt,
    pb: tpl.pb,
    initiative: { mod: tpl.initMod, score: tpl.initScore },
    abilities: ABILITIES.map((a, i) => ({ ability: a, score: tpl.scores[i], mod: Math.floor((tpl.scores[i]! - 10) / 2), save: tpl.saveMod[i] })),
    gear: tpl.gear,
    vsAc: ac,
    attacks: tpl.attacks.map((a) => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      toHit: a.toHit,
      critMin: a.critMin,
      reachFt: a.reachFt,
      normalFt: a.normalFt,
      longFt: a.longFt,
      gear: a.gear,
      consumesGear: a.consumesGear,
      unarmed: a.unarmed,
      damage: a.damage.map((d) => ({
        roll: formatExpr(d.roll),
        critExtra: d.critExtra ? formatExpr(d.critExtra) : null,
        type: DAMAGE_TYPES[d.type],
        avg: d.avg,
        ifAdvantage: d.ifAdvantage,
      })),
      ...attackStats(a, ac),
    })),
    attackAct: attackActJson(tpl),
    options: tpl.options,
    items: tpl.items,
    startHands: tpl.startHands.map((i) => (i < 0 ? null : tpl.items[i]!.local)),
    slots: tpl.resMax.slice(0, 9),
    pools: tpl.pools.map((pl, i) => ({ ...pl, res: 9 + i })),
    spells: tpl.spells.map((e) => ({
      id: e.spell.id,
      name: e.spell.name,
      level: e.spell.level,
      source: e.source,
      list: e.list,
      ability: ABILITIES[e.ability],
      toHit: e.toHit,
      dc: e.dc,
      whileHeld: e.whileHeld < 0 ? null : tpl.items[e.whileHeld]!.local,
      freePool: e.freePool < 0 ? null : tpl.pools[e.freePool - 9]!.local,
      slotted: e.slotted,
      levels: Object.fromEntries(e.prog.flatMap((steps, lvl) => (steps ? [[String(lvl), programPhrases(tpl, steps)]] : []))),
    })),
    features: tpl.features.map((f) => ({ id: f.id, name: f.name, activate: f.activate !== null, preRoll: f.preRoll !== null })),
    flags: describeFlags(DEFAULT_FLAGS, ['expandedCritAutoHits']),
  };
}

export function runSheet(argv: readonly string[], env: Env = process.env, repoRoot: string = REPO_ROOT): CommandOutput {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { 'vs-ac': { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean' } },
    allowPositionals: true,
    strict: true,
  });
  if (values.help) return { out: SHEET_USAGE, err: '', code: 0 };
  if (positionals.length !== 1) throw new UsageError('sheet takes exactly one creature id');
  const raw = values['vs-ac'] ?? '15';
  if (!/^\d+$/.test(raw) || Number(raw) > 99) throw new UsageError(`--vs-ac needs a whole number from 0 to 99, got "${raw}"`);
  const ac = Number(raw);
  const arg = positionals[0]!;
  const asFile = isFile(resolve(arg));
  const { loaded, targets } = loadWithFiles(asFile ? [arg] : [], env, repoRoot);
  const id = asFile ? (targets[0]!.id ?? arg) : arg;
  if (!loaded.content) {
    const lines = loaded.errors.map((d) => formatDiag({ ...d, path: displayPath(d.path) }));
    return { out: '', err: [...lines, `sheet: content has ${loaded.errors.length} error(s); run montecrit lint`].join('\n'), code: 1 };
  }
  const tpl = loaded.content.get(id);
  if (!tpl) {
    const known = loaded.content.templates.map((t) => t.id).join(', ');
    return { out: '', err: `sheet: no creature "${id}" (known: ${known})`, code: 1 };
  }
  // A character file's template is a pc's; its derived sheet (every number's source) is montecrit build's.
  const derived = (loaded.sheets ?? []).find((x) => x.id === tpl.id);
  if (values.json) {
    const j = sheetJson(tpl, ac) as Record<string, unknown>;
    return { out: JSON.stringify(derived ? { ...j, character: derivedJson(derived) } : j, null, 2), err: '', code: 0 };
  }
  const text = renderSheet(tpl, ac);
  const note = derived ? `\nBuilt from a character file (${derived.classes.map((c) => `${c.name} ${c.level}`).join(', ')}): montecrit build ${asFile ? displayPath(resolve(arg)) : tpl.id} prints every number's source.` : '';
  return { out: text + note, err: '', code: 0 };
}
