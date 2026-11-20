// Lint: compares the numbers a file states with the numbers its own stats imply, and
// reports any mismatch as a warning. It never corrects anything; the stated number is what
// compiles. Expression errors are compile's job, so lint skips anything that won't parse.

import { ExprError, parseExpr } from '../dice/expr.ts';
import { FLAG_INFO, type FlagInfo, type RuleFlags } from '../rules/flags.ts';
import { ABILITIES } from './types.ts';
import type { FeatureSource, MonsterSource, PcSource, SpellSource } from './schema.ts';
import { abilityMod, exprMean, floorMean, foldExpr, proficiencyBonus, warnAt, weaponMod, type ItemCtx } from './compile.ts';
import { EMPTY_LIBRARY, type Library } from './compile-spell.ts';
import { formatPath, type YamlPath } from './yaml.ts';

const signed = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);

/** floor(mean) of an expression, or undefined if it doesn't compile (compile reports that). */
function meanFloor(src: string, vars: Readonly<Record<string, number>>): number | undefined {
  try {
    return floorMean(exprMean(foldExpr(parseExpr(src), vars)));
  } catch (e) {
    if (e instanceof ExprError || e instanceof RangeError) return undefined;
    throw e;
  }
}

interface DamageLike {
  readonly roll: string;
  readonly avg?: number | undefined;
}

function lintDamage(c: ItemCtx, p: YamlPath, parts: readonly DamageLike[], vars: Readonly<Record<string, number>>): void {
  parts.forEach((d, j) => {
    if (d.avg === undefined) return;
    const m = meanFloor(d.roll, vars);
    if (m !== undefined && m !== d.avg) {
      warnAt(c, [...p, j, 'avg'], `printed average ${d.avg} doesn't match ${d.roll} (floor of the mean is ${m})`);
    }
  });
}

function lintFidelity(c: ItemCtx, fidelity: string, unimplemented: readonly string[], autoListed: number): void {
  const listed = unimplemented.length + autoListed;
  if (fidelity === 'full' && listed > 0) {
    warnAt(c, ['fidelity'], `fidelity is full but ${listed} thing(s) aren't modeled; use fidelity: partial`);
  }
  if (fidelity === 'partial' && listed === 0) {
    warnAt(c, ['fidelity'], 'fidelity is partial but unimplemented is empty; list what the engine leaves out');
  }
}

/** Proficiency bonus by challenge rating (SRD 5.2.1 p.256). */
export function pbForCr(cr: number | string): number {
  const n = typeof cr === 'number' ? cr : cr.includes('/') ? 0 : Number(cr);
  if (n <= 4) return 2;
  return 2 + Math.ceil((n - 4) / 4);
}

export function lintMonster(src: MonsterSource, c: ItemCtx): void {
  const mods = ABILITIES.map((a) => abilityMod(src.abilities[a]));
  const [str, dex] = [mods[0]!, mods[1]!];

  const hpMean = meanFloor(src.hp.formula, {});
  if (hpMean !== undefined && hpMean !== src.hp.average) {
    warnAt(c, ['hp', 'average'], `HP ${src.hp.average} doesn't match ${src.hp.formula} (floor of the mean is ${hpMean})`);
  }
  if (src.initiative.score !== 10 + src.initiative.mod) {
    warnAt(c, ['initiative', 'score'], `initiative score ${src.initiative.score} should be 10 + mod = ${10 + src.initiative.mod}`);
  }
  const crPb = pbForCr(src.cr);
  if (src.pb !== crPb) warnAt(c, ['pb'], `PB +${src.pb} doesn't match CR ${String(src.cr)} (expected +${crPb})`);

  ABILITIES.forEach((a, i) => {
    const save = src.saves[a];
    if (save !== undefined && save !== mods[i] && save !== mods[i]! + src.pb) {
      warnAt(c, ['saves', a], `${a.toUpperCase()} save ${signed(save)} is neither the modifier (${signed(mods[i]!)}) nor modifier + PB (${signed(mods[i]! + src.pb)})`);
    }
  });

  src.attacks.forEach((a, i) => {
    const viaStr = str + src.pb;
    const viaDex = dex + src.pb;
    if (a.toHitAbility !== undefined) {
      const via = mods[ABILITIES.indexOf(a.toHitAbility)]! + src.pb;
      if (a.toHit !== via) warnAt(c, ['attacks', i, 'toHit'], `to-hit ${signed(a.toHit)} doesn't match ${a.toHitAbility.toUpperCase()} mod + PB (${signed(via)})`);
    } else if (a.toHit !== viaStr && a.toHit !== viaDex) {
      warnAt(c, ['attacks', i, 'toHit'], `to-hit ${signed(a.toHit)} matches neither STR mod + PB (${signed(viaStr)}) nor DEX mod + PB (${signed(viaDex)})`);
    }
    lintDamage(c, ['attacks', i, 'damage'], a.damage, {});
  });

  const otherSpeeds = (['burrow', 'climb', 'fly', 'swim'] as const).filter((k) => src.speed[k] !== undefined).length;
  lintFidelity(c, src.fidelity, src.unimplemented, otherSpeeds);
}

/**
 * The character linter. Counts come from the file's own expect block and are never inferred
 * from a class table; unresolved spells and features are warned about where they're compiled
 * (compile-spell.ts) and counted here toward the fidelity check.
 */
export function lintPc(src: PcSource, c: ItemCtx, lib: Library = EMPTY_LIBRARY): void {
  const mods = ABILITIES.map((a) => abilityMod(src.abilities[a]));
  src.weapons.forEach((w, i) => lintDamage(c, ['weapons', i, 'damage'], w.damage, { mod: weaponMod(w.ability, mods) }));

  const derived = proficiencyBonus(src.level);
  if (src.pb !== undefined && src.pb !== derived) warnAt(c, ['pb'], `PB +${src.pb} doesn't match level ${src.level} (expected +${derived})`);
  src.skills.expertise.forEach((s, i) => {
    if (src.skills.proficient.includes(s)) warnAt(c, ['skills', 'expertise', i], `${s} is under both proficient and expertise; expertise already includes proficiency`);
  });

  if (src.expect) {
    const listed = (key: 'cantrips' | 'prepared') => src.casting.reduce((n, cs) => n + cs[key].length, 0);
    for (const key of ['cantrips', 'prepared'] as const) {
      const want = src.expect[key];
      const have = listed(key);
      if (want !== undefined && want !== have) {
        warnAt(c, ['expect', key], `expect.${key} is ${want}, but the casting lists name ${have} ${key === 'cantrips' ? 'cantrip(s)' : 'prepared spell(s)'}`);
      }
    }
  }

  // A cantrip granted twice (anywhere), or a spell listed twice in one source.
  const cantripAt = new Map<string, string>();
  src.casting.forEach((cs, si) => {
    const inSource = new Set<string>();
    for (const key of ['cantrips', 'prepared', 'always'] as const) {
      cs[key].forEach((id, j) => {
        const p: YamlPath = ['casting', si, key, j];
        const isCantrip = key === 'cantrips' || lib.spells.get(id)?.spell.level === 0;
        if (isCantrip) {
          const prev = cantripAt.get(id);
          if (prev !== undefined) warnAt(c, p, `cantrip ${id} is granted twice (also at ${prev})`);
          else cantripAt.set(id, formatPath(p));
        } else if (inSource.has(id)) warnAt(c, p, `${id} is listed twice in casting source ${cs.source}`);
        inSource.add(id);
      });
    }
  });
  const features = new Set<string>();
  src.features.forEach((id, i) => {
    if (features.has(id)) warnAt(c, ['features', i], `feature ${id} is listed twice`);
    features.add(id);
  });

  const ids = new Set<string>();
  for (const cs of src.casting) for (const id of [...cs.cantrips, ...cs.prepared, ...cs.always, ...cs.free.map((f) => f.spell)]) ids.add(id);
  let unresolved = 0;
  for (const id of ids) if (!lib.kinds.has(id)) unresolved++;
  for (const id of features) if (!lib.kinds.has(id)) unresolved++;
  // Compile folds each feature's own unimplemented items into the character's, so they count here too.
  for (const id of features) unresolved += lib.features.get(id)?.src.unimplemented.length ?? 0;
  lintFidelity(c, src.fidelity, src.unimplemented, unresolved);

  const flagKeys = Object.keys(src.flags).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) as (keyof RuleFlags)[];
  for (const k of flagKeys) {
    const info: FlagInfo<unknown> = FLAG_INFO[k];
    const v = src.flags[k];
    if (info.unimplemented?.includes(v)) {
      warnAt(c, ['flags', k], `flag ${k}=${String(v)} isn't implemented yet: scenarios using this character won't resolve until it is (a scenario or --flag override wins)`);
    }
  }
}

export function lintSpell(src: SpellSource, c: ItemCtx): void {
  lintFidelity(c, src.fidelity, src.unimplemented, 0);
}

export function lintFeature(src: FeatureSource, c: ItemCtx): void {
  lintFidelity(c, src.fidelity, src.unimplemented, 0);
}
