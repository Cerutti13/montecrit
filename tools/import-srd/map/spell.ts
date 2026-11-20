// The spell mapper (docs/design/m3.md 2.7, 4.3-4.5, C7; M3 step 6). A spells24 record that
// passed the filter (license, book, rules, and the C4 gate on the 339 PDF spell headers)
// becomes a `kind: spell` item, or nothing.
//
// The header fields come from the PDF (pdf/spell-details.ts, in srd-index.json): the PDF
// decides. Foundry's own header fields are compared with them (C7): any difference is a
// review.json row (crosscheck-spells.ts) and keeps the spell from being full.
//
// What today's spell schema can carry (content/schema.ts SpellSchema), and so what is emitted:
//   casting time Action or Bonus Action; range Self, Touch or feet; duration instantaneous,
//   rounds, minutes or hours (as minutes); components without a priced material; and a
//   program: one cast activity of type attack, save, damage or heal, or a buff whose every
//   change maps. Anything else (Reaction and timed casts, miles, until dispelled, priced
//   materials, cones, cubes, lines and emanations outside AREA_READINGS, several targets,
//   alternative activities, utility-only spells) cannot be written as a spell item without inventing a program, so the
//   mapper emits nothing for it and says why (SPELL_SKIPS, counted in the summary; the names
//   go to the cache log only). Those are engine gaps, listed in the step-6 build note.
//
// Foundry's activity inheritance, read in module/data/activity/base-activity.mjs at the pin
// (prepareFinalData and _setOverride): an activity's activation, duration, range and target
// come from the item unless the activity's own `override` is true. Cantrip scaling
// (module/data/item/spell.mjs scalingIncrease, data/shared/damage-field.mjs scaledFormula):
// floor((cantrip level + 1) / 6) steps at character levels 5, 11 and 17, each adding
// `scaling.number` (default 1) dice to the first part. Our `cantrip: true` multiplies the dice
// by the tier (compile-spell.ts), which equals Foundry's only when the base count equals
// `scaling.number`; the mapper requires that and the PDF "Cantrip Upgrade." dice to agree.
//
// Every number the mapper writes is checked against the PDF description's tokens (dice and
// damage type, save ability, attack kind, heal dice, upcast dice, area shape and size,
// conditions). A disagreement means the Foundry record can't be trusted for that spell: it
// is skipped with reason pdf-text-disagrees (and a review.json row), never emitted with
// either side's numbers guessed.

import { CONTENT_CONDS } from '../../../packages/engine/src/content/types.ts';
import { classifyChange } from '../effect-keys.ts';
import { normName } from '../filter.ts';
import { U } from '../unimplemented.ts';
import { getPath, isRecord } from '../util.ts';
import type { SpellDetail, SpellStat } from '../pdf/spell-details.ts';
import { effectsOf, changesOf, kebab, pageSource, type Rec } from './class.ts';
import { statPart } from './stats.ts';
import type { MapCtx, MapOutput, Mapper } from './types.ts';

/** Why a gate-passing spell record yields no item (counts in the summary; names in the cache log only). */
export const SPELL_SKIPS = [
  'area-shape',
  'casting-time',
  'costly-material',
  'duration',
  'multiple-activities',
  'multiple-targets',
  'no-pdf-details',
  'no-program',
  'pdf-text-disagrees',
  'range',
] as const;
export type SpellSkip = (typeof SPELL_SKIPS)[number];

/** A skip: the mapper reports it through ctx.skip and returns null. */
export interface SkippedSpell {
  readonly skip: SpellSkip;
  /** Machine detail (a shape name, a field), never text from the record. */
  readonly detail: string;
}

const MAPPABLE = ['attack', 'damage', 'heal', 'save'] as const;

/**
 * Conditions from a spell, read against its PDF text by hand (M3 step 6). Foundry puts a
 * status on the effect a failed save applies, but how long the condition lasts, what ends it
 * and what it turns into are prose (Sleep's Incapacitated becomes Unconscious, Charm Person
 * ends when the charmer's side deals damage, Banishment removes the target). So a status
 * becomes a condition step only for a spell listed here, whose text was read and whose every
 * remaining difference is a closed `part` line; any other status stays an `effect status` line
 * and is not applied. `save: turnEnd` is the text's "At the end of each of its turns, the
 * target repeats the save"; the mapper also requires the PDF tokens to say so. A reading that
 * needs an area, a second stage or a compound condition (coverage step 7.4: Sleep, Color Spray,
 * Grease, Hypnotic Pattern, Fear, Charm Person) is a reviewed override instead of a row here.
 */
export const CONDITION_READINGS: Readonly<Record<string, { readonly cond: string; readonly save?: 'turnEnd'; readonly parts: readonly string[]; readonly cite: string }>> = {
  // "Choose a Humanoid ... Wisdom saving throw or have the Paralyzed condition for the duration.
  // At the end of each of its turns, the target repeats the save, ending the spell on itself on a
  // success." Upcast: one more Humanoid per slot level above 2.
  'srd:hold-person': { cond: 'paralyzed', save: 'turnEnd', parts: ['creature-type-limit', 'spell-ends-on-save'], cite: 'srd-raw.txt:28078-28085' },
  // The same text for "a creature" (no type limit); upcast: one more creature per slot level above 5.
  'srd:hold-monster': { cond: 'paralyzed', save: 'turnEnd', parts: ['spell-ends-on-save'], cite: 'srd-raw.txt:28060-28067' },
};
const ABILITY = /^(str|dex|con|int|wis|cha)$/;

/**
 * Coverage step 7.3: the only spells with a Cone, Line or Cube the mapper may write, each read
 * against its PDF text by hand. Widening the shape gate outright gets three of six wrong: Web's 2d4
 * is its burn clause (srd-raw.txt:32232-32235), Disintegrate's "10-foot-Cube" is a portion of an
 * object and it's single-target (26076), Thunderwave silently loses its push (31632-31634). So this
 * is a closed allowlist and fails closed: anything else stays `area-shape`. `width` is here because
 * pdf/spell-details.ts keeps a Line's length only.
 */
export const AREA_READINGS: Readonly<Record<string, { readonly shape: 'cone' | 'line'; readonly ft: number; readonly width?: number; readonly cite: string }>> = {
  'srd:burning-hands': { shape: 'cone', ft: 15, cite: 'srd-raw.txt:24750-24753' },
  'srd:cone-of-cold': { shape: 'cone', ft: 60, cite: 'srd-raw.txt:25149-25158' },
  // "A stroke of lightning forming a 100-foot-long, 5-foot-wide Line" (srd-raw.txt:28526-28527).
  'srd:lightning-bolt': { shape: 'line', ft: 100, width: 5, cite: 'srd-raw.txt:28526-28529' },
};

/**
 * What an emitted spell's PDF text has that its program leaves out, read by hand against the
 * text (M3 step 6, srd-index.json pages): one closed `part` token each. The mapper adds these
 * lines on top of the ones it finds itself (activity types, statuses, effect keys, trigger
 * words, the C7 review lines). A spell that's emitted and has no row here was read and has
 * nothing more to list. import:verify and the tests check that every row names an emitted spell.
 */
export const SPELL_PARTS: Readonly<Record<string, readonly string[]>> = {
  'srd:befuddlement': ['no-spellcasting-after-fail'], // p.112: can't cast spells or take the Magic action
  'srd:blight': ['plant-autofail'], // p.113: a Plant creature automatically fails the save
  'srd:burning-hands': ['ignites-flammable-objects'], // p.114
  'srd:cloudkill': ['heavily-obscured', 'zone-moves-each-turn'], // p.116
  'srd:cone-of-cold': ['frozen-statue'], // p.117: a creature it kills becomes a statue until it thaws
  'srd:dissonant-whispers': ['forced-reaction-move'], // p.124: must use its Reaction to move away
  'srd:harm': ['hp-max-reduction'], // p.139
  'srd:incendiary-cloud': ['heavily-obscured', 'zone-moves-each-turn'], // p.142
  'srd:insect-plague': ['lightly-obscured'], // p.143
  'srd:power-word-kill': ['dies-at-100-hp'], // p.154: dies at 100 Hit Points or fewer; the 12d12 is the otherwise
  'srd:shatter': ['construct-disadvantage'], // p.161
};

/**
 * Saves whose text denies cover's benefit, read by hand (8'a review R2): the save step carries
 * `ignoresCover`, which the engine reads (sim/cover.ts saveCoverDegree), so it is modeled and
 * not a `part` line. Sacred Flame, p.159: "The target gains no benefit from Half Cover or
 * Three-Quarters Cover for this save" (srd-raw.txt:30314-30315).
 */
export const SAVE_IGNORES_COVER: Readonly<Record<string, 'partial'>> = {
  'srd:sacred-flame': 'partial',
};

/** The PDF details of a spell by name (normalized), or undefined. */
export function detailsOf(ctx: Pick<MapCtx, 'pdf'>, name: string): SpellDetail | undefined {
  const n = normName(name);
  return ctx.pdf?.spellDetails?.find((d) => normName(d.name) === n);
}

// ---- header fields ----------------------------------------------------------------

type Header = { castingTime: 'action' | 'bonus'; range: number | 'self' | 'touch'; components: { v: boolean; s: boolean; m: 'none' | 'focus' }; concentration: boolean; duration: 'instant' | { rounds: number } | { minutes: number } };

/** Our header from the PDF stat lines, or the skip reason. */
export function headerFromPdf(st: SpellStat): Header | SkippedSpell {
  const ct = st.castingTime.unit;
  if (ct !== 'action' && ct !== 'bonus') return { skip: 'casting-time', detail: ct };
  let range: Header['range'];
  if (st.range.unit === 'self' || st.range.unit === 'touch') range = st.range.unit;
  else if (st.range.unit === 'feet' && st.range.n !== undefined && st.range.n >= 5 && st.range.n % 5 === 0) range = st.range.n;
  else return { skip: 'range', detail: st.range.unit };
  if (st.components.cost) return { skip: 'costly-material', detail: 'cost' };
  const d = st.duration;
  let duration: Header['duration'];
  if (d.unit === 'instant') duration = 'instant';
  else if (d.unit === 'round' && d.n) duration = { rounds: d.n };
  else if (d.unit === 'minute' && d.n) duration = { minutes: d.n };
  else if (d.unit === 'hour' && d.n) duration = { minutes: d.n * 60 };
  else return { skip: 'duration', detail: d.unit };
  return { castingTime: ct, range, components: { v: st.components.v, s: st.components.s, m: st.components.m ? 'focus' : 'none' }, concentration: st.concentration, duration };
}

/** Foundry's header fields, as the same machine tokens (for the C7 comparison). */
export interface FoundryHeader {
  readonly level: number | undefined;
  readonly castingTime: string;
  readonly range: string;
  readonly components: string;
  readonly duration: string;
  readonly concentration: boolean;
  readonly ritual: boolean;
}

const UNIT_OF: Readonly<Record<string, string>> = { inst: 'instant', round: 'round', minute: 'minute', hour: 'hour', day: 'day', disp: 'dispelled', dstr: 'dispelled', spec: 'special', perm: 'dispelled' };

export function foundryHeader(doc: Readonly<Rec>): FoundryHeader {
  const props = getPath(doc, 'system.properties');
  const p = Array.isArray(props) ? props.filter((x): x is string => typeof x === 'string') : [];
  const act = String(getPath(doc, 'system.activation.type') ?? '');
  const actN = Number(getPath(doc, 'system.activation.value') ?? 1) || 1;
  const ru = String(getPath(doc, 'system.range.units') ?? '');
  const rv = getPath(doc, 'system.range.value');
  const du = String(getPath(doc, 'system.duration.units') ?? '');
  const dv = getPath(doc, 'system.duration.value');
  const lvl = getPath(doc, 'system.level');
  return {
    level: typeof lvl === 'number' ? lvl : undefined,
    castingTime: act === 'action' || act === 'bonus' || act === 'reaction' ? act : `${act}:${actN}`,
    range: ru === 'ft' ? `feet:${String(rv)}` : ru === 'mi' ? `miles:${String(rv)}` : ru,
    components: ['vocal', 'somatic', 'material'].map((k) => (p.includes(k) ? k[0]!.toUpperCase() : '-')).join(''),
    duration: du === 'inst' || du === 'disp' || du === 'dstr' || du === 'spec' || du === 'perm' ? UNIT_OF[du]! : `${UNIT_OF[du] ?? du}:${String(dv)}`,
    concentration: p.includes('concentration'),
    ritual: p.includes('ritual'),
  };
}

/** The PDF's header as the same tokens. */
export function pdfHeader(level: number, st: SpellStat): FoundryHeader {
  const ct = st.castingTime.unit;
  const r = st.range;
  const d = st.duration;
  return {
    level,
    castingTime: ct === 'action' || ct === 'bonus' || ct === 'reaction' ? ct : `${ct}:${st.castingTime.n}`,
    range: r.unit === 'feet' ? `feet:${r.n}` : r.unit === 'miles' ? `miles:${r.n}` : r.unit === 'unlimited' ? 'any' : r.unit === 'special' ? 'spec' : r.unit,
    components: `${st.components.v ? 'V' : '-'}${st.components.s ? 'S' : '-'}${st.components.m ? 'M' : '-'}`,
    duration: d.unit === 'instant' || d.unit === 'dispelled' || d.unit === 'special' ? d.unit : `${d.unit}:${d.n}`,
    concentration: st.concentration,
    ritual: st.ritual,
  };
}

/** Header fields where Foundry and the PDF differ (C7), sorted. Foundry's "sight" range and "self" read the same as the PDF's. */
export function headerDiffs(f: FoundryHeader, p: FoundryHeader): string[] {
  const out: string[] = [];
  for (const k of ['level', 'castingTime', 'range', 'components', 'duration', 'concentration', 'ritual'] as const) {
    if (String(f[k]) !== String(p[k])) out.push(k);
  }
  return out.sort();
}

// ---- activities ---------------------------------------------------------------------

/** The activities of a record, in key order (Foundry's sort field is stripped). */
export function activitiesOf(doc: Readonly<Rec>): Rec[] {
  const a = getPath(doc, 'system.activities');
  if (!isRecord(a)) return [];
  return Object.keys(a)
    .sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))
    .map((k) => a[k])
    .filter(isRecord);
}

/** An activity's own field when it overrides the item's, else the item's (base-activity.mjs _setOverride). */
export function inherited(doc: Readonly<Rec>, act: Rec, key: 'activation' | 'duration' | 'range' | 'target'): unknown {
  const own = act[key];
  if (isRecord(own) && own.override === true) return own;
  return getPath(doc, `system.${key}`);
}

const dieOf = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : undefined;
};

export interface PartOut {
  readonly roll: string;
  readonly type: string;
  readonly upcast?: string;
  readonly cantrip?: true;
  /** The base dice "NdM" (for the PDF check). */
  readonly dice: string;
  readonly upcastDice?: string;
}

/**
 * One Foundry damage part (number, denomination, bonus, types, scaling) to our roll, or lines.
 * `level` 0 is a cantrip: whole scaling becomes `cantrip: true` when it equals our tier rule.
 */
export function partOf(part: Rec, level: number, ctx: Pick<MapCtx, 'formula'>, healing = false): { part?: PartOut; lines: string[] } {
  const lines: string[] = [];
  if (getPath(part, 'custom.enabled') === true) return { lines: [U.part('custom-damage-formula')] };
  const n = dieOf(part.number);
  const d = dieOf(part.denomination);
  if (n === undefined || d === undefined) return { lines: [U.part('damage-without-dice')] };
  const types = Array.isArray(part.types) ? part.types.filter((t): t is string => typeof t === 'string') : [];
  if (!healing && types.length !== 1) return { lines: [U.choiceNotMapped('damage-type')] };
  const type = healing ? 'healing' : types[0]!;
  let roll = `${n}d${d}`;
  const bonus = typeof part.bonus === 'string' ? part.bonus.trim() : part.bonus;
  if (bonus !== '' && bonus !== undefined && bonus !== null) {
    const f = ctx.formula(bonus as string | number);
    if (!f.ok) return { lines: [...f.lines] };
    roll = `${roll} + ${f.expr}`;
  }
  const mode = getPath(part, 'scaling.mode');
  const sn = getPath(part, 'scaling.number');
  const sf = getPath(part, 'scaling.formula');
  const step = sn === undefined || sn === null ? 1 : dieOf(sn);
  const out: { roll: string; type: string; dice: string; upcast?: string; cantrip?: true; upcastDice?: string } = { roll, type, dice: `${n}d${d}` };
  if (mode === 'whole') {
    if (typeof sf === 'string' && sf.trim() !== '') return { lines: [U.part('custom-scaling-formula')] };
    if (step === undefined) return { lines: [U.part('damage-scaling')] };
    if (level === 0) {
      // Foundry adds `step` dice per tier; ours multiplies the base dice by the tier.
      if (step !== n) return { lines: [U.part('cantrip-scaling')] };
      out.cantrip = true;
    } else {
      out.upcast = `${step}d${d}`;
      out.upcastDice = out.upcast;
    }
  } else if (mode !== '' && mode !== undefined && mode !== null && mode !== 'none') return { lines: [U.part('damage-scaling')] };
  return { part: out, lines };
}

// ---- the PDF text check ----------------------------------------------------------------

const sameDice = (a: string, b: string) => a.replace(/\s+/g, '') === b.replace(/\s+/g, '');

/** The parts' dice and types appear in the PDF's damage tokens, in order (cantrips: and their upgrade dice). */
function damageAgrees(parts: readonly PartOut[], det: SpellDetail): boolean {
  const pdf = det.facts.damage;
  return parts.every((p, i) => {
    const want = pdf[i];
    if (!want || want.type !== p.type) return false;
    const base = p.roll.replace(/ \+ @mod$/, ''); // a printed "+ your spellcasting modifier" isn't a dice token
    if (!sameDice(want.dice, base) && !sameDice(want.dice, p.dice)) return false;
    if (p.cantrip) {
      const m = /^(\d+)d(\d+)$/.exec(p.dice)!;
      const n = Number(m[1]);
      const tiers = [2, 3, 4].map((t) => `${n * t}d${m[2]}`);
      if (det.facts.cantripUpgrade.join(',') !== tiers.join(',')) return false;
    }
    if (p.upcastDice !== undefined && !det.facts.upcast.some((u) => sameDice(u, p.upcastDice!))) return false;
    if (p.upcastDice === undefined && !p.cantrip && det.facts.upcast.length && i === 0) return false; // the PDF scales it, Foundry doesn't
    return true;
  });
}

// ---- the mapper ---------------------------------------------------------------------------

interface Built {
  item: Record<string, unknown>;
  lines: string[];
  shape: 'bucketA' | 'other';
  handled: string[];
}

/** Conditions an activity applies on a failed save or a hit (its effects whose statuses map). */
function conditionsOf(doc: Readonly<Rec>, act: Rec, onSave: boolean): { ids: string[]; lines: string[] } {
  // ids is reassigned by the caller (prone and duration filtering), so it's a plain array.
  const refs = Array.isArray(act.effects) ? act.effects.filter(isRecord) : [];
  const ids: string[] = [];
  const lines: string[] = [];
  for (const r of refs) {
    if (onSave && r.onSave === true) {
      lines.push(U.part('effect-on-successful-save'));
      continue;
    }
    const e = effectsOf(doc).find((x) => x._id === r._id);
    if (!e) continue;
    const st = Array.isArray(e.statuses) ? e.statuses.filter((s): s is string => typeof s === 'string') : [];
    for (const s of st) {
      if ((CONTENT_CONDS as readonly string[]).includes(s)) ids.push(s);
      else lines.push(U.effectStatus(s));
    }
    const ch = changesOf(e);
    if (ch.length) for (const c of ch) lines.push(effectKeyLine(c));
    if (!st.length && !ch.length) lines.push(U.effectNoChanges());
  }
  return { ids: [...new Set(ids)].sort(), lines };
}

function effectKeyLine(c: Rec): string {
  const key = typeof c.key === 'string' ? c.key : '';
  const mode = typeof c.type === 'string' && /^(add|override|multiply|upgrade|downgrade|subtract|custom|[0-9])$/.test(c.type) ? c.type : 'custom';
  const k = classifyChange(key, mode);
  return k.status === 'ignored' ? U.effectKey(key || 'unknown', mode) : k.status === 'mapped' ? U.effectKey(key, mode) : k.line;
}

/** The condition step for a reviewed status: until the spell ends (concentration) or its own duration. */
function conditionStep(id: string, h: Header, save: string | undefined): Rec {
  const until: unknown = h.concentration ? 'parent' : h.duration === 'instant' ? undefined : h.duration;
  const c: Rec = { id };
  if (until !== undefined) c.until = until;
  if (save !== undefined) c.save = { ability: save, at: 'turnEnd' };
  return { condition: c };
}

/** Area from Foundry's template, checked against the PDF's shape and size (the PDF decides; a silent Foundry field takes the PDF's value). */
function areaOf(doc: Readonly<Rec>, act: Rec, det: SpellDetail, range: Header['range'], id: string): { zone?: Rec; skip?: SkippedSpell; lines: string[] } {
  const target = inherited(doc, act, 'target');
  const tpl = isRecord(target) && isRecord(target.template) ? target.template : undefined;
  const type = tpl && typeof tpl.type === 'string' ? tpl.type : '';
  const pdfArea = det.facts.areas[0];
  if (type === '' && pdfArea === undefined) return { lines: [] };
  const fShape = type === 'radius' ? 'sphere' : type;
  const shape = pdfArea?.shape ?? fShape;
  // Any other shape only through a reviewed reading (AREA_READINGS): anything else names its skip.
  if (shape !== 'sphere' && shape !== 'cylinder') {
    const r = Object.hasOwn(AREA_READINGS, id) ? AREA_READINGS[id]! : undefined;
    if (!r || r.shape !== shape || pdfArea?.ft !== r.ft || range !== 'self') return { skip: { skip: 'area-shape', detail: shape }, lines: [] };
    if (type !== '' && fShape !== r.shape) return { skip: { skip: 'pdf-text-disagrees', detail: 'area' }, lines: [] };
    if (tpl && tpl.count !== undefined && tpl.count !== '' && Number(tpl.count) !== 1) return { skip: { skip: 'area-shape', detail: 'several-areas' }, lines: [] };
    if (tpl && tpl.size !== undefined && tpl.size !== '' && Number(tpl.size) !== r.ft) return { skip: { skip: 'pdf-text-disagrees', detail: 'area-size' }, lines: [] };
    if (r.width === undefined) return { zone: { shape: r.shape, size: r.ft }, lines: [] };
    if (tpl && tpl.width !== undefined && tpl.width !== '' && Number(tpl.width) !== r.width) return { skip: { skip: 'pdf-text-disagrees', detail: 'area-width' }, lines: [] };
    return { zone: { shape: r.shape, size: r.ft, width: r.width }, lines: [] };
  }
  if (pdfArea === undefined || (type !== '' && fShape !== pdfArea.shape)) return { skip: { skip: 'pdf-text-disagrees', detail: 'area' }, lines: [] };
  if (range === 'self') return { skip: { skip: 'area-shape', detail: 'self-centered' }, lines: [] };
  if (tpl && (tpl.count !== undefined && tpl.count !== '' && Number(tpl.count) !== 1)) return { skip: { skip: 'area-shape', detail: 'several-areas' }, lines: [] };
  const fSize = tpl && tpl.size !== undefined && tpl.size !== '' ? Number(tpl.size) : undefined;
  if (fSize !== undefined && fSize !== pdfArea.ft) return { skip: { skip: 'pdf-text-disagrees', detail: 'area-size' }, lines: [] };
  if (pdfArea.shape === 'cylinder') {
    const fh = tpl && tpl.height !== undefined && tpl.height !== '' ? Number(tpl.height) : undefined;
    if (fh !== undefined && fh !== pdfArea.height) return { skip: { skip: 'pdf-text-disagrees', detail: 'area-height' }, lines: [] };
    return { zone: { shape: 'cylinder', radius: pdfArea.ft, height: pdfArea.height }, lines: [] };
  }
  return { zone: { shape: 'sphere', radius: pdfArea.ft }, lines: [] };
}

/**
 * Foundry's target count at the spell's own level: '', '1', or a formula over @item.level that
 * gives 1 there ("@item.level - 1" on a level-2 spell: one target, one more per slot level).
 * Returns the base count, or undefined when it isn't a plain number or such a formula.
 */
export function baseCount(count: unknown, level: number): number | undefined {
  if (count === undefined || count === null || count === '') return 1;
  const t = String(count).replace(/\s+/g, '');
  if (/^\d+$/.test(t)) return Number(t);
  const m = /^(?:(\d+)\+)?@item\.level(?:([+-])(\d+))?$/.exec(t);
  if (!m) return undefined;
  return (m[1] ? Number(m[1]) : 0) + level + (m[2] === '-' ? -Number(m[3]) : m[2] === '+' ? Number(m[3]) : 0);
}

/** Which creatures a single-target activity may take: creatures only (objects aren't units). */
const CREATURE_TYPES: readonly string[] = ['', 'creature', 'creatureOrObject', 'ally', 'enemy', 'willing'];

/**
 * The target step for a single-creature spell. An attack or a harmful save never aims at the
 * caster. A heal or a buff: "a creature of your choice" may be the caster (SRD 5.2.1 p.106,
 * "Targeting Yourself"); "a willing creature" is an ally, and whether the caster counts is the
 * selfTargetWhenTextSilent flag's call, as for any other wording.
 */
function targetStep(range: Header['range'], kind: 'attack' | 'save' | 'heal' | 'buff', det: SpellDetail): Rec {
  const r = range === 'touch' ? 'touch' : range;
  if (kind === 'attack' || kind === 'save') return { target: { range: r, self: 'no' } };
  if (det.facts.willing) return { target: { range: r, who: 'ally', self: 'textSilent' } };
  return { target: { range: r, self: det.facts.ofYourChoice ? 'yes' : 'textSilent' } };
}

/** Builds the item, or the skip. */
function build(ctx: MapCtx, det: SpellDetail, level: number): Built | SkippedSpell {
  const doc = ctx.doc;
  const hd = headerFromPdf(det.stat);
  if ('skip' in hd) return hd;
  const acts = activitiesOf(doc);
  const lines: string[] = [];
  const handled: string[] = [];
  const cast = String(getPath(doc, 'system.activation.type') ?? '');
  const mine = acts.filter((a) => {
    const act = inherited(doc, a, 'activation');
    return isRecord(act) && String(act.type ?? '') === cast;
  });
  const progs = mine.filter((a) => (MAPPABLE as readonly string[]).includes(String(a.type)));
  if (progs.length > 1) return { skip: 'multiple-activities', detail: String(progs.length) };
  // With no attack, save, damage or heal, a single utility cast activity is the buff's own
  // application (buff() maps its effect), so it isn't a line of its own.
  const buffCast = progs.length === 0 && mine.length === 1 && String(mine[0]!.type) === 'utility';
  for (const a of acts) {
    const t = String(a.type);
    if ((MAPPABLE as readonly string[]).includes(t)) {
      if (!mine.includes(a)) lines.push(U.part('later-turn-activity'));
    } else if (t === 'utility' && (effectsOf(doc).length === 0 || (buffCast && a === mine[0]))) {
      // a utility activity with no effects is a roll card or a reminder; the buff's cast is mapped
    } else lines.push(U.activityType(t));
  }

  const base: Record<string, unknown> = {
    level,
    castingTime: hd.castingTime,
    range: hd.range,
    components: hd.components,
    duration: hd.duration,
  };
  if (hd.concentration) base.concentration = true;
  const act = progs[0];
  if (!act) return buff(ctx, det, hd, base, acts, lines);

  const target = inherited(doc, act, 'target');
  const area = areaOf(doc, act, det, hd.range, `srd:${kebab(ctx.kept.rec.name)}`);
  if (!area.zone && !area.skip) {
    const count = isRecord(target) ? getPath(target, 'affects.count') : undefined;
    const n = baseCount(count, level);
    if (n !== 1) return { skip: 'multiple-targets', detail: n === undefined ? 'formula' : String(n) };
    if (/@item\.level/.test(String(count ?? ''))) lines.push(U.part('upcast-extra-targets'));
    const who = isRecord(target) ? getPath(target, 'affects.type') : undefined;
    if (!CREATURE_TYPES.includes(typeof who === 'string' ? who : '')) return { skip: 'no-program', detail: 'target-type' };
  }
  if (area.skip) return area.skip;
  lines.push(...area.lines);
  const behaviors = Array.isArray(act.behaviors) ? act.behaviors.filter(isRecord) : [];
  const difficult = behaviors.some((b) => b.type === 'difficultTerrain');
  for (const b of behaviors) if (b.type !== 'difficultTerrain') lines.push(U.part('region-behavior'));
  if (difficult && !area.zone) lines.push(U.part('difficult-terrain'));

  const type = String(act.type);
  if (!area.zone && hd.range === 'self' && type !== 'attack') return { skip: 'range', detail: 'self-single-target' };
  const parts: PartOut[] = [];
  const dmgParts = type === 'heal' ? [] : Array.isArray(getPath(act, 'damage.parts')) ? (getPath(act, 'damage.parts') as unknown[]).filter(isRecord) : [];
  for (const p of dmgParts) {
    const r = partOf(p, level, ctx);
    lines.push(...r.lines);
    if (r.part) parts.push(r.part);
    else return { skip: 'no-program', detail: 'damage-part' };
  }
  if (parts.length && !damageAgrees(parts, det)) return { skip: 'pdf-text-disagrees', detail: 'damage' };
  if (det.facts.multiAttack) return { skip: 'multiple-targets', detail: 'several-attacks' };
  // A cantrip's upgrade must be the dice our tier rule rolls (Eldritch Blast's extra beams are not).
  if (level === 0 && det.facts.cantripUpgradeLine && !parts.some((p) => p.cantrip)) return { skip: 'pdf-text-disagrees', detail: 'cantrip-upgrade' };
  if (level === 0 && !det.facts.cantripUpgradeLine && parts.some((p) => p.cantrip)) return { skip: 'pdf-text-disagrees', detail: 'cantrip-upgrade' };
  const roll = (p: PartOut): Rec => ({ roll: p.roll, type: p.type, ...(p.upcast ? { upcast: p.upcast } : {}), ...(p.cantrip ? { cantrip: true } : {}) });
  const steps: Rec[] = [];
  let shape: Built['shape'] = 'bucketA';

  if (type === 'attack') {
    const kind = getPath(act, 'attack.type.value');
    if (kind !== 'melee' && kind !== 'ranged') return { skip: 'no-program', detail: 'attack-kind' };
    if (!det.facts.attack.includes(kind)) return { skip: 'pdf-text-disagrees', detail: 'attack-kind' };
    if (area.zone) return { skip: 'no-program', detail: 'attack-area' };
    if (!parts.length) return { skip: 'no-program', detail: 'attack-without-damage' };
    const cond = conditionsOf(doc, act, false);
    lines.push(...cond.lines);
    if (cond.ids.length) return { skip: 'no-program', detail: 'attack-condition' };
    const reach = hd.range === 'touch' ? 5 : hd.range === 'self' ? undefined : hd.range;
    if (reach === undefined) return { skip: 'range', detail: 'self-attack' };
    steps.push(targetStep(hd.range === 'touch' ? 'touch' : reach, 'attack', det), { attack: { kind, range: reach, onHit: [{ damage: parts.map(roll) }] } });
  } else if (type === 'save') {
    const ab = getPath(act, 'save.ability');
    const abl = Array.isArray(ab) ? ab : [ab];
    if (abl.length !== 1 || typeof abl[0] !== 'string' || !ABILITY.test(abl[0])) return { skip: 'no-program', detail: 'save-ability' };
    const ability = abl[0];
    if (det.facts.saves[0] !== ability) return { skip: 'pdf-text-disagrees', detail: 'save-ability' };
    if (getPath(act, 'save.dc.calculation') !== 'spellcasting') lines.push(U.part('save-dc'));
    const cond = conditionsOf(doc, act, true);
    lines.push(...cond.lines);
    for (const c of cond.ids) if (!det.facts.conditions.includes(c)) return { skip: 'pdf-text-disagrees', detail: 'condition' };
    // Only a reviewed reading turns a status into a condition step (CONDITION_READINGS).
    const reading = CONDITION_READINGS[`srd:${kebab(ctx.kept.rec.name)}`];
    let repeat: string | undefined;
    if (reading && !area.zone && cond.ids.length === 1 && cond.ids[0] === reading.cond && (reading.save !== 'turnEnd' || det.facts.repeatSaveTurnEnd)) {
      lines.push(...reading.parts.map((x) => U.part(x)));
      if (reading.save === 'turnEnd') {
        repeat = ability;
        handled.push('repeat the save');
      }
    } else {
      for (const c of cond.ids) lines.push(U.effectStatus(c));
      cond.ids = [];
    }
    if (!parts.length && !cond.ids.length) return { skip: 'no-program', detail: 'save-without-effect' };
    const save: Rec = { ability };
    const ignoresCover = SAVE_IGNORES_COVER[`srd:${kebab(ctx.kept.rec.name)}`];
    if (ignoresCover) save.ignoresCover = ignoresCover;
    if (parts.length) {
      save.damage = parts.map(roll);
      // Half on a success only where Foundry and the PDF text both say so.
      const half = getPath(act, 'damage.onSave') === 'half';
      if (half !== det.facts.half) return { skip: 'pdf-text-disagrees', detail: 'save-half' };
      if (half) save.half = true;
    }
    if (cond.ids.length) {
      save.onFail = cond.ids.map((c) => conditionStep(c, hd, repeat));
      shape = 'other';
    }
    if (area.zone) steps.push({ save });
    else steps.push(targetStep(hd.range, 'save', det), { save });
  } else if (type === 'damage') {
    if (!parts.length) return { skip: 'no-program', detail: 'damage-without-parts' };
    if (det.facts.saves.length || det.facts.attack.length) return { skip: 'pdf-text-disagrees', detail: 'damage-has-roll' };
    if (area.zone) steps.push({ damage: parts.map(roll) });
    else steps.push(targetStep(hd.range, 'save', det), { damage: parts.map(roll) });
  } else {
    // heal
    const h = getPath(act, 'healing');
    if (!isRecord(h)) return { skip: 'no-program', detail: 'heal' };
    const r = partOf(h, level, ctx, true);
    lines.push(...r.lines);
    if (!r.part) return { skip: 'no-program', detail: 'heal' };
    if (!det.facts.heal.some((x) => sameDice(x, r.part!.dice))) return { skip: 'pdf-text-disagrees', detail: 'heal' };
    if (r.part.upcastDice !== undefined ? !det.facts.upcast.some((u) => sameDice(u, r.part!.upcastDice!)) : det.facts.upcast.length > 0) {
      return { skip: 'pdf-text-disagrees', detail: 'heal-upcast' };
    }
    if (area.zone) return { skip: 'no-program', detail: 'heal-area' };
    if (r.part.cantrip) return { skip: 'no-program', detail: 'heal-cantrip' };
    const heal: Rec = { roll: r.part.roll };
    if (r.part.upcast) heal.upcast = r.part.upcast;
    steps.push(targetStep(hd.range, 'heal', det), { heal });
  }

  const item: Record<string, unknown> = { ...base };
  if (area.zone) {
    // A zone effect that does its work when it appears. An instantaneous area lasts one round
    // so the zone has a duration of its own; a concentration area ends with the spell.
    const zone: Rec = { ...area.zone };
    // "Each creature of your choice in" the area (Weird, p.174): a zone hits every creature in
    // it, allies included, and has no side filter yet, so the choice is a line.
    if (det.facts.ofYourChoice) lines.push(U.part('creatures-of-your-choice'));
    // Difficult Terrain from an instantaneous spell lasts a time the text states (Ice Storm: to
    // the end of your next turn, p.141), not the one-round zone's: a line.
    if (difficult && hd.duration === 'instant') lines.push(U.part('difficult-terrain'));
    else if (difficult) zone.difficult = true;
    const eff: Rec = { id: 'area', name: String(ctx.kept.rec.name), zone, on: [{ when: ['appear'], do: steps }] };
    if (!hd.concentration) eff.duration = hd.duration === 'instant' ? { rounds: 1 } : hd.duration;
    item.area = 'area';
    item.effects = [eff];
    item.do = [{ apply: { effect: 'area', to: 'point' } }];
    shape = 'other';
  } else {
    if (hd.duration !== 'instant' && !(steps.some((s) => 'save' in s && isRecord(s.save) && Array.isArray(s.save.onFail)))) {
      // An instantaneous program on a spell with a duration: whatever lasts is prose only.
      lines.push(U.part('lasting-effect'));
    }
    item.do = steps;
  }
  // The PDF scales it with a higher slot, and nothing here does: a line, never a guess.
  if (det.facts.higherLevelLine && !JSON.stringify(steps).includes('"upcast"') && !lines.includes(U.part('upcast-extra-targets'))) lines.push(U.part('upcast'));
  return { item, lines, shape, handled };
}

/** A spell with no attack, save, damage or heal activity: a buff whose every change maps, or nothing. */
function buff(ctx: MapCtx, det: SpellDetail, hd: Header, base: Record<string, unknown>, acts: readonly Rec[], lines: string[]): Built | SkippedSpell {
  const doc = ctx.doc;
  const effects = effectsOf(doc).filter((e) => e.transfer !== true);
  if (effects.length !== 1) return { skip: 'no-program', detail: effects.length ? 'several-effects' : 'no-effect' };
  const e = effects[0]!;
  const st = Array.isArray(e.statuses) ? e.statuses : [];
  if (st.length) return { skip: 'no-program', detail: 'buff-status' };
  const stats: Rec[] = [];
  for (const c of changesOf(e)) {
    const key = typeof c.key === 'string' ? c.key : '';
    const mode = typeof c.type === 'string' ? c.type : 'custom';
    const k = classifyChange(key, mode);
    const part = k.status === 'mapped' ? statPart(k.target, mode, c.value) : undefined;
    if (!part || !('stat' in part)) return { skip: 'no-program', detail: 'buff-change' };
    stats.push(part.stat);
  }
  if (!stats.length) return { skip: 'no-program', detail: 'buff-without-changes' };
  const target = acts.length === 1 ? inherited(doc, acts[0]!, 'target') : getPath(doc, 'system.target');
  const count = isRecord(target) ? getPath(target, 'affects.count') : undefined;
  const n = baseCount(count, hd === undefined ? 0 : Number(base.level));
  if (n !== 1) return { skip: 'multiple-targets', detail: n === undefined ? 'formula' : String(n) };
  if (/@item\.level/.test(String(count ?? ''))) lines.push(U.part('upcast-extra-targets'));
  if (det.facts.areas.length) return { skip: 'area-shape', detail: det.facts.areas[0]!.shape };
  const eff: Rec = { id: 'buff', name: String(ctx.kept.rec.name), stats };
  if (!hd.concentration) {
    if (hd.duration === 'instant') return { skip: 'no-program', detail: 'instant-buff' };
    eff.duration = hd.duration;
  }
  if (det.facts.higherLevelLine && !lines.includes(U.part('upcast-extra-targets'))) lines.push(U.part('upcast'));
  const item: Record<string, unknown> = { ...base, effects: [eff] };
  item.do = hd.range === 'self' ? [{ apply: { effect: 'buff', to: 'self' } }] : [targetStep(hd.range, 'buff', det), { apply: { effect: 'buff', to: 'target' } }];
  return { item, lines, shape: 'other', handled: [] };
}

export const mapSpell: Mapper = (ctx) => {
  const rec = ctx.kept.rec;
  const det = detailsOf(ctx, rec.name);
  const hdr = ctx.pdf?.spells.find((s) => normName(s.name) === normName(rec.name));
  if (!det || !hdr) {
    ctx.skip?.('no-pdf-details', '');
    return null;
  }
  const b = build(ctx, det, hdr.level);
  if ('skip' in b) {
    ctx.skip?.(b.skip, b.detail);
    return null;
  }
  const diffs = headerDiffs(foundryHeader(ctx.doc), pdfHeader(hdr.level, det.stat));
  const activation = String(getPath(ctx.doc, 'system.activation.type') ?? '');
  const out: MapOutput = {
    kind: 'spell',
    item: { kind: 'spell', id: `srd:${kebab(rec.name)}`, name: hdr.name, source: pageSource(hdr.page), ...b.item },
    unimplemented: [...new Set([...b.lines, ...(SPELL_PARTS[`srd:${kebab(rec.name)}`] ?? []).map((x) => U.part(x))])].sort(),
    classify: {
      maps: true,
      shape: b.shape,
      hasDuration: det.stat.duration.unit !== 'instant',
      activation: activation === 'reaction' || activation === 'special' ? activation : undefined,
      pdfHeaderAgrees: diffs.length === 0,
      heuristicShape: true,
    },
    pdfPage: hdr.page,
    handledTriggers: b.handled,
  };
  return out;
};
