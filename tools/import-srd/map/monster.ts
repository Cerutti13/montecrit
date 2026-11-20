// Monsters: actors24 npc records that pass the license filter and the C4 gate (a stat-block
// header in the PDF), mapped to the engine's monster schema (content/schema.ts MonsterSchema).
//
// The PDF decides (docs/design/m3.md 4.3, C7): every number emitted is the stat block's printed
// one, read into srd-index.json monsterDetails by pdf/monsters.ts. The Foundry record is the
// licensed source the item stands for and a vote: its size, CR, ability scores, HP, AC, speeds,
// save proficiencies, skills, senses, damage and condition defenses, and the names of its attack
// items are compared field by field (foundryTokens/monsterDiffs, also used by the review); any
// disagreement is a "PDF header disagrees" line, so the item can't be full.
//
//   AC, Initiative, HP (average and formula), Speed  -> ac, initiative, hp, speed (walk; other
//        speeds as data, each with its line, as the engine models walking only)
//   ability rows (score, MOD, SAVE)                  -> abilities, saves (where SAVE != MOD)
//   Skills, Senses                                   -> skills, senses (data, not compiled)
//   Resistances / Vulnerabilities / Immunities       -> resist / vuln / immune; condition ids the
//        engine has (CONTENT_CONDS) -> conditionImmune, the rest lines
//   Gear                                             -> gear (a thrown weapon's entry counted)
//   CR (XP; PB)                                      -> cr, pb
//   Actions: "<Melee|Ranged|Melee or Ranged> Attack Roll: +n, reach/range. Hit: ..." -> attacks
//        (to-hit, reach, range, every damage part with its printed average, the goblins'
//        "if the attack roll had Advantage" riders); more Hit text is a line
//   Multiattack (pdf/monsters.ts parseMultiattack's exact forms) -> multiattack
//   Bonus Actions "takes the Dash or Disengage action" -> options (core:dash, core:disengage)
//   Coverage step 7.6: "<Ability> Saving Throw: DC n, each creature in a <Cone, Line or Sphere at
//        range>. Failure: ... damage. Success: Half damage." at will or Recharge X-Y -> actions
//        (monsterAreaAction); a rider, a per-day use or any other wording stays a line
//   traits, other actions (saves, spellcasting, Recharge, per-day uses), other bonus actions,
//   reactions, legendary actions, Large+ footprints -> closed-template lines (2.7)
// A stat block that didn't parse whole, or whose printed numbers the engine's lint would refuse
// (HP average not the formula's floor mean, a save neither MOD nor MOD + PB), is skipped with a
// closed reason; no number is ever corrected.

import { CONTENT_CONDS } from '../../../packages/engine/src/content/types.ts';
import { normName } from '../filter.ts';
import type { SrdIndex } from '../pdf/build.ts';
import type { MonsterDetail, MonsterEntry } from '../pdf/monsters.ts';
import { U } from '../unimplemented.ts';
import { getPath, isRecord } from '../util.ts';
import type { Mapper } from './types.ts';

export const kebabName = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
const SIZE_CODES: Readonly<Record<string, string>> = { tiny: 'tiny', sm: 'small', med: 'medium', lg: 'large', huge: 'huge', grg: 'gargantuan' };
const SKILL_CODES: Readonly<Record<string, string>> = {
  acrobatics: 'acr',
  'animal-handling': 'ani',
  arcana: 'arc',
  athletics: 'ath',
  deception: 'dec',
  history: 'his',
  insight: 'ins',
  intimidation: 'itm',
  investigation: 'inv',
  medicine: 'med',
  nature: 'nat',
  perception: 'prc',
  performance: 'prf',
  persuasion: 'per',
  religion: 'rel',
  'sleight-of-hand': 'slt',
  stealth: 'ste',
  survival: 'sur',
};
const SPEEDS = ['burrow', 'climb', 'fly', 'swim'] as const;
const BIG: readonly string[] = ['large', 'huge', 'gargantuan'];
/** The abilities a printed to-hit may come from besides STR and DEX (C0); order is the sheet's. */
const OTHER_TO_HIT = ['con', 'int', 'wis', 'cha'] as const;

/** "1/8" -> 0.125 */
export const crNumber = (cr: string): number => (cr.includes('/') ? Number(cr.split('/')[0]) / Number(cr.split('/')[1]) : Number(cr));

/** floor(mean) of "XdY", "XdY + Z", "XdY - Z" or a flat number; undefined when it isn't one of those. */
export function floorMean(dice: string): number | undefined {
  const flat = /^(\d+)$/.exec(dice);
  if (flat) return Number(flat[1]);
  const m = /^(\d+)d(\d+)(?: ([+-]) (\d+))?$/.exec(dice);
  if (!m) return undefined;
  const twice = Number(m[1]) * (Number(m[2]) + 1) + (m[3] === '-' ? -2 : 2) * Number(m[4] ?? 0);
  return Math.floor(twice / 2);
}

/** The comparable tokens of a Foundry npc record (fields it lacks are left out). */
export function foundryTokens(doc: Readonly<Record<string, unknown>>): Record<string, string> {
  const out: Record<string, string> = {};
  const s = isRecord(doc.system) ? doc.system : {};
  const size = getPath(s, 'traits.size');
  if (typeof size === 'string') out.size = SIZE_CODES[size] ?? size;
  const cr = getPath(s, 'details.cr');
  if (typeof cr === 'number') out.cr = String(cr);
  for (const a of ABILITIES) {
    const v = getPath(s, `abilities.${a}.value`);
    if (typeof v === 'number') out[a] = String(v);
    const p = getPath(s, `abilities.${a}.proficient`);
    if (typeof p === 'number') out[`save.${a}`] = p >= 1 ? 'proficient' : 'mod';
  }
  const hp = getPath(s, 'attributes.hp.max');
  if (typeof hp === 'number') out.hp = String(hp);
  const hf = getPath(s, 'attributes.hp.formula');
  if (typeof hf === 'string' && hf.trim()) out.hpFormula = hf.replace(/\s+/g, '').replace(/−/g, '-');
  const ac = getPath(s, 'attributes.ac.flat');
  if (typeof ac === 'number') out.ac = String(ac);
  for (const k of ['walk', ...SPEEDS]) {
    const v = getPath(s, `attributes.movement.${k}`);
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined;
    out[`speed.${k}`] = n === undefined || n === 0 ? '0' : String(n);
  }
  out.hover = getPath(s, 'attributes.movement.hover') === true ? 'true' : 'false';
  for (const [k, path] of [
    ['resist', 'traits.dr.value'],
    ['immune', 'traits.di.value'],
    ['vuln', 'traits.dv.value'],
    ['conditionImmune', 'traits.ci.value'],
  ] as const) {
    const v = getPath(s, path);
    if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === 'string').sort().join(',');
  }
  for (const sk of Object.keys(SKILL_CODES)) {
    const v = getPath(s, `skills.${SKILL_CODES[sk]}.value`);
    if (typeof v === 'number') out[`skill.${sk}`] = String(v);
  }
  for (const sense of ['blindsight', 'darkvision', 'tremorsense', 'truesight']) {
    const v = getPath(s, `attributes.senses.ranges.${sense}`);
    out[`sense.${sense}`] = typeof v === 'number' && v > 0 ? String(v) : '0';
  }
  const items = Array.isArray(doc.items) ? doc.items : [];
  const attacks: string[] = [];
  for (const it of items) {
    if (!isRecord(it) || typeof it.name !== 'string') continue;
    const acts = getPath(it, 'system.activities');
    if (isRecord(acts) && Object.values(acts).some((a) => isRecord(a) && a.type === 'attack')) attacks.push(normName(it.name));
  }
  out.attacks = [...new Set(attacks)].sort().join(',');
  return out;
}

/** The same tokens from the PDF stat block. */
export function pdfTokens(d: MonsterDetail): Record<string, string> {
  const out: Record<string, string> = { size: d.sizes[0]!, cr: String(crNumber(d.cr)), hp: String(d.hp.average), hpFormula: d.hp.formula.replace(/\s+/g, ''), ac: String(d.ac) };
  for (const a of ABILITIES) {
    out[a] = String(d.abilities[a].score);
    out[`save.${a}`] = d.abilities[a].save === d.abilities[a].mod ? 'mod' : 'proficient';
  }
  out['speed.walk'] = String(d.speed.walk);
  for (const k of SPEEDS) out[`speed.${k}`] = String(d.speed[k] ?? 0);
  out.hover = d.speed.hover ? 'true' : 'false';
  out.resist = [...d.resist].sort().join(',');
  out.immune = [...d.immune].sort().join(',');
  out.vuln = [...d.vuln].sort().join(',');
  out.conditionImmune = [...d.conditionImmune].sort().join(',');
  for (const sk of Object.keys(SKILL_CODES)) {
    const v = d.skills[sk];
    if (v === undefined) {
      out[`skill.${sk}`] = '0';
      continue;
    }
    const mod = d.abilities[skillAbility(sk)].mod;
    out[`skill.${sk}`] = v === mod + 2 * d.pb ? '2' : v === mod + d.pb ? '1' : v === mod ? '0' : `bonus:${v}`;
  }
  for (const sense of ['blindsight', 'darkvision', 'tremorsense', 'truesight'] as const) out[`sense.${sense}`] = String(d.senses[sense] ?? 0);
  out.attacks = d.actions
    .filter((e) => e.attack)
    .map((e) => normName(e.name))
    .sort()
    .join(',');
  return out;
}

const SKILL_ABILITY: Readonly<Record<string, (typeof ABILITIES)[number]>> = {
  acrobatics: 'dex',
  'animal-handling': 'wis',
  arcana: 'int',
  athletics: 'str',
  deception: 'cha',
  history: 'int',
  insight: 'wis',
  intimidation: 'cha',
  investigation: 'int',
  medicine: 'wis',
  nature: 'int',
  perception: 'wis',
  performance: 'cha',
  persuasion: 'cha',
  religion: 'int',
  'sleight-of-hand': 'dex',
  stealth: 'dex',
  survival: 'wis',
};
const skillAbility = (sk: string): (typeof ABILITIES)[number] => SKILL_ABILITY[sk]!;

/** Field-by-field disagreements, PDF against the record (fields the record lacks aren't compared), sorted by field. */
export function monsterDiffs(d: MonsterDetail, doc: Readonly<Record<string, unknown>>): { field: string; pdf: string; foundry: string }[] {
  const p = pdfTokens(d);
  const f = foundryTokens(doc);
  const out: { field: string; pdf: string; foundry: string }[] = [];
  for (const k of Object.keys(p).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (f[k] === undefined) continue;
    // An attack Foundry carries that the PDF prints as something else (a save, a usage-limited
    // entry) isn't a disagreement about attacks we emit; only ours missing from the record is.
    if (k === 'attacks') {
      const theirs = new Set(f[k]!.split(','));
      const missing = p[k]!.split(',').filter((x) => x !== '' && !theirs.has(x));
      if (missing.length) out.push({ field: k, pdf: `${missing.length} not in the record`, foundry: 'missing' });
      continue;
    }
    if (p[k] !== f[k]) out.push({ field: k, pdf: p[k]!, foundry: f[k]! });
  }
  return out;
}

/** A gear entry a thrown attack uses: the attack's name, or its plural. */
function gearFor(gear: readonly { name: string; count?: number }[], attack: string): number {
  return gear.findIndex((g) => g.name === attack || g.name === `${attack}s`);
}

function dmgParts(parts: NonNullable<MonsterEntry['attack']>['damage']): Record<string, unknown>[] | undefined {
  const out: Record<string, unknown>[] = [];
  for (const p of parts) {
    if (floorMean(p.dice) !== p.avg) return undefined;
    out.push({ roll: p.dice, type: p.type, avg: p.avg, ...(p.ifAdvantage ? { ifAdvantage: true } : {}) });
  }
  return out;
}

const RECHARGE = /^recharge-(\d)(?:-(\d))?$/;

/**
 * Coverage step 7.6: a stat block's area save as a monster action, or undefined when it isn't the
 * damage-only form the PDF prints whole, its usage is anything but Recharge or at will, a printed
 * average isn't the mean of its dice, or its DC isn't 8 + PB + one ability's modifier (no number is
 * corrected, as for attacks).
 */
export function monsterAreaAction(d: MonsterDetail, e: MonsterEntry): Record<string, unknown> | undefined {
  const a = e.saveArea;
  if (!a || !e.save) return undefined;
  const rc = e.usage === undefined ? undefined : RECHARGE.exec(e.usage);
  if (e.usage !== undefined && !rc) return undefined;
  if (a.damage.some((p) => floorMean(p.dice) !== p.avg)) return undefined;
  if (!ABILITIES.some((k) => 8 + d.pb + d.abilities[k].mod === e.save!.dc)) return undefined;
  const zone: Record<string, unknown> = a.shape === 'sphere' ? { shape: 'sphere', radius: a.size } : a.shape === 'line' ? { shape: 'line', size: a.size, width: a.width } : { shape: 'cone', size: a.size };
  return {
    id: kebabName(e.name),
    name: e.name,
    cost: 'action',
    ...(rc ? { uses: { recharge: rc[2] ? [Number(rc[1]), Number(rc[2])] : [Number(rc[1])] } } : {}),
    area: 'area',
    ...(a.rangeFt !== undefined ? { range: a.rangeFt } : {}),
    effects: [
      {
        id: 'area',
        name: e.name,
        zone,
        duration: { rounds: 1 },
        on: [{ when: ['appear'], do: [{ save: { ability: e.save.ability, dc: e.save.dc, half: true, damage: a.damage.map((p) => ({ roll: p.dice, type: p.type })) } }] }],
      },
    ],
    do: [{ apply: { effect: 'area', to: 'point' } }],
  };
}

/**
 * A monster's id: srd:<kebab name>, unless that name is also a class, spell, species,
 * background, feat, weapon, armor or magic item in the PDF index (the Druid stat block and the
 * Druid class): then srd:<kebab name>-monster. Decided from the PDF index alone, so the id never
 * depends on what else this run happened to emit.
 */
export function monsterId(name: string, pdf: SrdIndex | undefined): string {
  const k = kebabName(name);
  if (!pdf) return `srd:${k}`;
  const others = [
    ...Object.values(pdf.classes).map((c) => c.name),
    ...Object.values(pdf.subclasses).map((c) => c.name),
    ...pdf.spells.map((x) => x.name),
    ...pdf.species.map((x) => x.name),
    ...pdf.backgrounds.map((x) => x.name),
    ...pdf.feats.map((x) => x.name),
    ...pdf.weapons.map((x) => x.name),
    ...pdf.armor.map((x) => x.name),
    ...(pdf.magicItems ?? []).map((x) => x.name),
  ];
  return others.some((o) => kebabName(o) === k) ? `srd:${k}-monster` : `srd:${k}`;
}

export interface MonsterBuild {
  readonly item: Record<string, unknown>;
  readonly lines: string[];
}

/**
 * The item and its lines from a PDF stat block, or a closed skip reason. Pure: the mapper adds
 * the Foundry comparison.
 */
export function buildMonster(d: MonsterDetail, pdf?: SrdIndex): MonsterBuild | { skip: string; detail: string } {
  const lines: string[] = [];
  if (floorMean(d.hp.formula) !== d.hp.average) return { skip: 'pdf-hp-mean', detail: `${d.hp.average}` };
  const saves: Record<string, number> = {};
  for (const a of ABILITIES) {
    const x = d.abilities[a];
    if (x.mod !== Math.floor((x.score - 10) / 2)) return { skip: 'pdf-ability-mod', detail: a };
    if (x.save === x.mod) continue;
    if (x.save !== x.mod + d.pb) return { skip: 'pdf-save-odd', detail: a };
    saves[a] = x.save;
  }
  if (d.initiative.score !== 10 + d.initiative.mod) return { skip: 'pdf-initiative', detail: `${d.initiative.mod}` };

  const size = d.sizes[0]!;
  if (d.sizes.length > 1) lines.push(U.monsterSize(size, d.sizes[1]!));
  if (BIG.includes(size)) lines.push(U.footprint());
  const speed: Record<string, number> = { walk: d.speed.walk };
  for (const k of SPEEDS) {
    const v = d.speed[k];
    if (v !== undefined) {
      speed[k] = v;
      lines.push(U.monsterSpeed(k));
    }
  }
  if (d.speed.hover) lines.push(U.monsterSpeed('hover'));
  if (d.speed.formOnly) lines.push(U.monsterSpeedOther('form'));
  if (d.speed.choice) lines.push(U.monsterSpeedOther('choice'));
  const conds = d.conditionImmune.filter((c) => (CONTENT_CONDS as readonly string[]).includes(c));
  for (const c of d.conditionImmune) if (!conds.includes(c)) lines.push(U.monsterConditionImmunity(c));
  for (const f of d.unparsed) lines.push(U.monsterDefenseText(f as 'resistances' | 'vulnerabilities' | 'immunities'));
  for (const t of d.traits) lines.push(U.monsterEntry('trait', kebabName(t.name), t.usage));
  if (d.legendaryActions.length) lines.push(U.monsterLegendary());
  for (const r of d.reactions) lines.push(U.monsterEntry('reaction', kebabName(r.name), r.usage));

  const gear = d.gear.map((g) => ({ ...g }));
  const attacks: Record<string, unknown>[] = [];
  const emitted = new Map<string, string>(); // entry name -> attack id
  const otherForm = new Set<string>(); // entry names limited to forms without the humanoid one
  const pb = d.pb;
  const str = d.abilities.str.mod;
  const dex = d.abilities.dex.mod;
  const areaActions: Record<string, unknown>[] = [];
  for (const e of d.actions) {
    if (e.name === 'Multiattack') continue;
    const id = kebabName(e.name);
    const area = monsterAreaAction(d, e);
    if (area && !areaActions.some((x) => x.id === id)) {
      areaActions.push(area);
      continue;
    }
    const a = e.attack;
    // C0: an attack limited to forms that include the humanoid one is the printed block's own
    // (the lycanthropes: Speed 30 ft. is the true humanoid form's, the others' speeds are
    // "form only", srd-raw.txt:55669-55670, 55756, 55866, 55921), so it maps.
    const humanoidForm = e.usage !== undefined && e.usage.startsWith('form-') && e.usage.split('-').includes('humanoid');
    if (a && e.usage !== undefined && e.usage.startsWith('form-') && !humanoidForm) otherForm.add(e.name);
    if (!a || (e.usage !== undefined && !humanoidForm) || [...emitted.values()].includes(id)) {
      lines.push(U.monsterEntry('action', id, e.usage));
      continue;
    }
    // C0 (coverage.md section 4): a printed to-hit that isn't STR or DEX + PB is accepted when
    // exactly one other ability's modifier + PB equals it (a spell attack: the Druid's Vine Staff
    // and Verdant Wisp, WIS; the Mage's Arcane Burst, INT); toHitAbility names it, and the
    // engine's lint checks the sum. With none or two candidates (Barbed Devil and Oni: CHA and
    // WIS, CHA and INT) it isn't emitted: which one the block means isn't printed.
    let toHitAbility: string | undefined;
    if (a.toHit !== str + pb && a.toHit !== dex + pb) {
      const by = OTHER_TO_HIT.filter((k) => d.abilities[k].mod + pb === a.toHit);
      if (by.length !== 1) {
        lines.push(U.monsterAttackToHit(id));
        continue;
      }
      toHitAbility = by[0]!;
    }
    const damage = dmgParts(a.damage);
    if (!damage) {
      lines.push(U.monsterEntry('action', id));
      continue;
    }
    const out: Record<string, unknown> = { id, name: e.name, kind: a.kind, toHit: a.toHit, ...(toHitAbility ? { toHitAbility } : {}), damage };
    if (a.reach !== undefined) out.reach = a.reach;
    if (a.range) out.range = [...a.range];
    // A single range ("reach 5 ft. or range 120 ft.": the Mage's Arcane Burst) is a spell-like
    // attack, not a thrown weapon, so it uses nothing up.
    const single = a.range !== undefined && a.range[0] === a.range[1];
    if (a.kind === 'meleeOrRanged' && !single) {
      const gi = gearFor(gear, e.name);
      if (gi >= 0) {
        // A Gear line without a count names one (the Guard's Spear); throwing it uses it up.
        if (gear[gi]!.count === undefined) gear[gi]!.count = 1;
        out.thrownGear = gear[gi]!.name;
      } else lines.push(U.monsterThrown(id));
    }
    if (e.more) lines.push(U.monsterAttackMore(id));
    if (a.advantageIf) lines.push(U.monsterAttackAdvantageIf(id));
    attacks.push(out);
    emitted.set(e.name, id);
  }

  let multiattack: Record<string, unknown> | undefined;
  const ma = d.actions.find((e) => e.name === 'Multiattack');
  if (ma) {
    const t = ma.multiattack;
    // C0 review R4: an "in any combination" group (two or more names) keeps its count with the
    // names limited to another form left out, so the humanoid form attacks at its printed rate
    // (the Werebear's "two attacks, using Handaxe or Rend in any combination" is two Handaxe
    // attacks in humanoid form: srd-raw.txt:55728-55730, 55738-55742; the Wereboar's Javelin,
    // 55779-55780, 55788-55792). A group left with no name isn't mapped.
    const inForm = (g: { count: number; from: readonly string[] }) => (g.from.length >= 2 ? { count: g.count, from: g.from.filter((n) => !otherForm.has(n)) } : g);
    const alts = t ? [t.groups, ...(t.orGroups ?? [])].map((groups) => groups.map(inForm)) : [];
    // A use limit in the name ("Multiattack (Vampire Form Only)") isn't modeled, so neither is the Multiattack.
    if (ma.usage === undefined && alts.length && alts.every((groups) => groups.every((g) => g.from.length > 0 && g.from.every((n) => emitted.has(n))))) {
      multiattack = { alternatives: alts.map((groups) => groups.map((g) => ({ count: g.count, from: g.from.map((n) => emitted.get(n)!) }))) };
      if (ma.more) lines.push(U.monsterMultiattackMore());
      if (t!.sameAttack) lines.push(U.monsterMultiattackSameAttack());
    } else lines.push(U.monsterMultiattack());
  }

  const options: Record<string, unknown>[] = [];
  for (const b of d.bonusActions) {
    const id = kebabName(b.name);
    const cores = (b.takes ?? []).filter((t) => t === 'dash' || t === 'disengage');
    if (b.usage === undefined) {
      for (const c of cores) options.push({ id: `${id}-${c}`, name: `${b.name} (${c === 'dash' ? 'Dash' : 'Disengage'})`, cost: 'bonus', core: `core:${c}` });
    }
    if (b.usage !== undefined || b.more || cores.length === 0 || (b.takes ?? []).includes('hide')) lines.push(U.monsterEntry('bonus action', id, b.usage));
  }

  const senses: Record<string, number> = { passivePerception: d.senses.passivePerception };
  for (const k of ['blindsight', 'darkvision', 'tremorsense', 'truesight'] as const) if (d.senses[k] !== undefined) senses[k] = d.senses[k]!;
  const cr = d.cr.includes('/') ? d.cr : Number(d.cr);
  const item: Record<string, unknown> = {
    kind: 'monster',
    id: monsterId(d.name, pdf),
    name: d.name,
    source: `SRD 5.2.1 p.${d.page}`,
    size,
    cr,
    pb,
    ac: d.ac,
    hp: { average: d.hp.average, formula: d.hp.formula },
    speed,
    initiative: { mod: d.initiative.mod, score: d.initiative.score },
    abilities: Object.fromEntries(ABILITIES.map((a) => [a, d.abilities[a].score])),
    senses,
  };
  if (Object.keys(saves).length) item.saves = saves;
  if (Object.keys(d.skills).length) item.skills = { ...d.skills };
  if (d.resist.length) item.resist = [...d.resist];
  if (d.vuln.length) item.vuln = [...d.vuln];
  if (d.immune.length) item.immune = [...d.immune];
  if (conds.length) item.conditionImmune = conds;
  if (gear.length) item.gear = gear;
  if (attacks.length) item.attacks = attacks;
  if (multiattack) item.multiattack = multiattack;
  if (options.length) item.options = options;
  if (areaActions.length) item.actions = areaActions;
  return { item, lines };
}

export const mapMonster: Mapper = (ctx) => {
  const rec = ctx.kept.rec;
  const d = ctx.pdf?.monsterDetails?.find((m) => normName(m.name) === normName(rec.name));
  if (!d) {
    ctx.skip?.('pdf-block-unparsed', 'stat block not parsed whole');
    return null;
  }
  const b = buildMonster(d, ctx.pdf);
  if ('skip' in b) {
    ctx.skip?.(b.skip, b.detail);
    return null;
  }
  const lines = [...b.lines];
  if (monsterDiffs(d, ctx.doc).length) lines.push(U.pdfHeaderDisagrees());
  return { kind: 'monster', item: b.item, unimplemented: lines, classify: { maps: true, shape: 'data', hasDuration: false }, pdfPage: d.page };
};
