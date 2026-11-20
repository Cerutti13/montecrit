// Species and species traits (docs/design/m3.md 2.3, 4.3, C9c).
//
// Species: origins24 race records. Foundry splits a species with lineages into one record per
// lineage ("Elf, Drow", "Elf, High", "Elf, Wood"); the SRD has one Elf with a lineage choice.
// Those siblings merge into one species item: the alphabetically first record (by path) emits
// it and the others return [] (folded, not unmapped). Siblings are found through the traits
// they share (each shared trait's gate-passing owners), so no record listing is needed.
//   size      union of the siblings' Size advancements
//   speed     the lowest sibling walk speed (a lineage's faster speed belongs to its lineage)
//   features  the traits every sibling grants (ItemGrant); a trait granted above character
//             level 1 is { id, level } (Draconic Flight, Large Form: 5), its level checked
//             against the PDF's "When you reach / Starting at character level N" (fail closed)
//   choices   Trait skill choices, ItemChoice pools of traits or feats, and the lineage pick
//   resist    fixed Trait dr grants that belong to no trait (see homeOf)
// Species traits: origins24 feat records with system.type.value race, emitted as features at
// srd:<species>/<trait>. What maps today: resist (from the owning race's Trait advancement),
// hp.perLevel (an hp.bonuses.level effect) and advantage/disadvantage on saves (a
// save.roll.mode effect) as a passive effect, and only for a record with no activities and
// only from transfer effects. Everything else is a templated line. A trait is never `full`
// from the importer (shape 'other' adds the review line); one that maps nothing is narrative.

import { classifyChange } from '../effect-keys.ts';
import { PDF_READINGS } from '../pdf-gates.ts';
import { finishStats, statPart } from './stats.ts';
import { splitLineage } from '../filter.ts';
import type { Kept } from '../filter.ts';
import { identOf } from '../ids.ts';
import { U } from '../unimplemented.ts';
import { getPath, isRecord } from '../util.ts';
import {
  ALL_SKILLS,
  advancements,
  advLevel,
  byString,
  bySkillOrder,
  choiceLevel,
  damageTypeOf,
  grantedIds,
  grantsSpells,
  kebab,
  pdfEntry,
  sizeOf,
  skillOf,
  sourceOf,
  traitCodes,
  type PdfIndex,
} from './origin-util.ts';
import type { MapCtx, Mapper, MapOutput } from './types.ts';
import { SIZES } from '../../../packages/engine/src/content/types.ts';

/** The PDF species a species record belongs to ("Elf, Drow" -> "Elf"). */
export function speciesBase(pdf: PdfIndex, name: string): string {
  if (pdfEntry(pdf?.species, name)) return name;
  return splitLineage(name)?.head ?? name;
}

/** Our id for a species trait: srd:<species>/<trait identifier>. */
export function traitId(pdf: PdfIndex, k: Kept): string {
  const owner = k.owners[0];
  if (!owner) throw new Error(`${k.rec.path}: a species trait needs an owner`);
  return `srd:${kebab(speciesBase(pdf, owner.name))}/${identOf(k.rec.doc, k.rec.name)}`;
}

/** The trait records (kept or not) a race record grants with ItemGrant, by foreign id. */
const grantedTraits = (doc: Readonly<Record<string, unknown>>): string[] =>
  advancements(doc)
    .filter((a) => a.type === 'ItemGrant')
    .flatMap((a) => grantedIds(a, 'origins24'));

/**
 * Where a race record's Trait grant or spell grant belongs: the granted trait whose name is
 * the advancement's title ("Dwarven Resilience"), else for a lineage record its lineage trait
 * (the one granted trait named "<trait>, <option>"), else the species itself.
 */
export function homeOf(ctx: Pick<MapCtx, 'lookup'>, race: Kept, adv: Record<string, unknown>): string | 'species' {
  const traits = grantedTraits(race.rec.doc)
    .map((fid) => ctx.lookup(fid))
    .filter((t): t is Kept => t !== undefined);
  const byTitle = traits.find((t) => t.rec.name === adv.title);
  if (byTitle) return byTitle.rec.id;
  if (splitLineage(race.rec.name)) {
    const lineage = traits.filter((t) => splitLineage(t.rec.name) !== undefined);
    if (lineage.length === 1) return lineage[0]!.rec.id;
  }
  return 'species';
}

/** The race records that are one PDF species with this one (itself included), sorted by path. */
function siblings(ctx: MapCtx, base: string): Kept[] {
  const me = ctx.kept;
  const out = new Map<string, Kept>([[me.rec.id, me]]);
  if (base !== me.rec.name) {
    for (const fid of grantedTraits(me.rec.doc)) {
      for (const o of ctx.lookup(fid)?.owners ?? []) {
        if (o.kind !== 'species' || speciesBase(ctx.pdf, o.name) !== base) continue;
        const k = ctx.lookup(o.foreignId);
        if (k) out.set(k.rec.id, k);
      }
    }
  }
  return [...out.values()].sort((a, b) => byString(a.rec.path, b.rec.path));
}

const SIZE_ORDER: readonly string[] = SIZES;

export const mapSpecies: Mapper = (ctx) => {
  const where = ctx.kept.rec.path;
  const base = speciesBase(ctx.pdf, ctx.kept.rec.name);
  const sibs = siblings(ctx, base);
  if (sibs[0]!.rec.id !== ctx.kept.rec.id) return []; // folded into the first sibling's item
  const lines: string[] = [];
  const page = pdfEntry(ctx.pdf?.species, base)?.page;

  const sizes = new Set<string>();
  let speed: number | undefined;
  const grantSets: Set<string>[] = [];
  /** The character level each granted trait comes at (Foundry ItemGrant level; 0 and 1 are 1). */
  const grantLevel = new Map<string, number>();
  const resist = new Set<string>();
  const choices: Record<string, unknown>[] = [];
  const choiceIds = new Set<string>();
  const addChoice = (c: Record<string, unknown>) => {
    if (choiceIds.has(c.id as string)) return; // the same choice on every sibling
    choiceIds.add(c.id as string);
    choices.push(c);
  };

  for (const s of sibs) {
    const doc = s.rec.doc;
    const walk = getPath(doc, 'system.movement.walk');
    if (typeof walk !== 'number') throw new Error(`${s.rec.path}: no walk speed`);
    speed = speed === undefined ? walk : Math.min(speed, walk);
    const grants = new Set<string>();
    for (const a of advancements(doc)) {
      if (a.type === 'Size') {
        const list = getPath(a, 'configuration.sizes');
        if (!Array.isArray(list) || list.length === 0) throw new Error(`${s.rec.path}: a Size advancement with no sizes`);
        for (const c of list) sizes.add(sizeOf(String(c), s.rec.path));
      } else if (a.type === 'ItemGrant') {
        if (grantsSpells(a)) {
          if (homeOf(ctx, s, a) === 'species') lines.push(U.spellGrants());
          continue;
        }
        for (const fid of grantedIds(a, 'origins24')) {
          grants.add(fid);
          const lv = Math.max(1, advLevel(a));
          const prev = grantLevel.get(fid);
          if (prev !== undefined && prev !== lv) throw new Error(`${s.rec.path}: trait ${fid} is granted at levels ${prev} and ${lv}`);
          grantLevel.set(fid, lv);
        }
        if (grantedIds(a).length !== grantedIds(a, 'origins24').length) lines.push(U.choiceNotMapped('granted-item'));
      } else if (a.type === 'ItemChoice') {
        const pool = grantedIds(a);
        const n = Number(getPath(a, `configuration.choices.${advLevel(a)}.count`) ?? 1);
        const id = kebab(String(a.title ?? 'choice'));
        const feats = pool.filter((fid) => ctx.lookup(fid)?.kind === 'feat');
        const traits = pool.filter((fid) => ctx.lookup(fid)?.kind === 'speciesTrait');
        if (pool.some((fid) => ctx.dropped(fid))) lines.push(U.quarantinedGrant());
        if (traits.length) addChoice({ id, level: choiceLevel(advLevel(a)), choose: n, from: { features: traits.map((fid) => traitId(ctx.pdf, ctx.lookup(fid)!)).sort(byString) } });
        else if (feats.length) addChoice({ id, level: choiceLevel(advLevel(a)), choose: n, from: { feats: feats.map((fid) => ctx.idOf(fid)!).sort(byString) } });
        else lines.push(U.choiceNotMapped(id || 'choice'));
      } else if (a.type === 'Trait') {
        const t = traitCodes(a);
        const home = homeOf(ctx, s, a);
        for (const g of t.grants) {
          if (g.startsWith('dr:') && home === 'species') resist.add(damageTypeOf(g.slice(3), s.rec.path));
          else if (!g.startsWith('dr:') && !g.startsWith('languages:')) lines.push(U.choiceNotMapped('trait-grant'));
        }
        for (const ch of t.choices) {
          if (ch.pool.every((p) => p.startsWith('skills:'))) {
            const skills = ch.pool.includes('skills:*') ? [...ALL_SKILLS] : ch.pool.map((p) => skillOf(p.slice(7), s.rec.path)).sort(bySkillOrder);
            addChoice({ id: kebab(String(a.title ?? 'skills')), level: choiceLevel(advLevel(a)), choose: ch.count, from: { skills }, grants: 'proficiency' });
          } else if (ch.pool.every((p) => p.startsWith('dr:'))) lines.push(U.choiceNotMapped('damage-resistance'));
          else if (!ch.pool.every((p) => p.startsWith('languages:'))) lines.push(U.choiceNotMapped('trait-choice'));
        }
      }
      // ScaleValue (a trait's scaling die) has no species field; the trait that reads it says so.
    }
    grantSets.push(grants);
  }

  // Traits every sibling grants are the species'; each sibling's own trait is its lineage.
  const common = [...grantSets[0]!].filter((fid) => grantSets.every((g) => g.has(fid)));
  const features: string[] = [];
  const levelOf = new Map<string, number>();
  for (const fid of common) {
    const t = ctx.lookup(fid);
    if (t?.kind === 'speciesTrait') {
      const tid = traitId(ctx.pdf, t);
      features.push(tid);
      const lv = grantLevel.get(fid) ?? 1;
      const pdfLv = pdfTraitLevel(ctx.pdf, base, t.rec.name);
      if (pdfLv !== undefined && pdfLv !== lv) throw new Error(`${where}: ${t.rec.name} is granted at character level ${lv}, the PDF says ${pdfLv}; fail closed`);
      if (lv > 1) levelOf.set(tid, lv);
    } else if (ctx.dropped(fid)) lines.push(U.quarantinedGrant());
  }
  if (sibs.length > 1) {
    const lineage: string[] = [];
    let head: string | undefined;
    grantSets.forEach((g, i) => {
      const own = [...g].filter((fid) => !common.includes(fid));
      const t = own.length === 1 ? ctx.lookup(own[0]!) : undefined;
      const l = t ? splitLineage(t.rec.name) : undefined;
      if (!t || !l) throw new Error(`${sibs[i]!.rec.path}: expected exactly one lineage trait of its own, found ${own.length}`);
      if (head !== undefined && head !== l.head) throw new Error(`${sibs[i]!.rec.path}: lineage traits ${head} and ${l.head} differ`);
      head = l.head;
      lineage.push(traitId(ctx.pdf, t));
    });
    addChoice({ id: kebab(head!), level: 1, choose: 1, from: { features: lineage.sort(byString) } });
  }

  // Every PDF trait of the species (lineage options aside: the lineage choice holds them) must
  // be carried by a trait feature, a choice or a line naming it. One that isn't (Darkvision,
  // which Foundry keeps in system.senses; Draconic Ancestry) becomes a narrative stub feature
  // plus a line, the way the class mapper's pdfStubs does, so the species is not `full`.
  const stubs = traitStubs(ctx.pdf, base, features, choices, lines);
  for (const o of stubs) {
    const lv = pdfTraitLevel(ctx.pdf, base, o.item.name as string);
    if (lv !== undefined && lv > 1) levelOf.set(o.item.id as string, lv);
  }
  features.push(...stubs.map((o) => o.item.id as string));
  // Every PDF trait that starts above level 1 must be emitted with that level (fail closed).
  for (const t of ctx.pdf?.speciesTraits ?? []) {
    if (t.species !== base || t.of !== undefined || t.level === undefined) continue;
    const id = features.find((f) => f.slice(f.lastIndexOf('/') + 1) === kebab(t.name.replace(/[‘’]/g, "'")));
    if (id === undefined || levelOf.get(id) !== t.level) throw new Error(`${where}: the PDF's ${t.name} starts at character level ${t.level}, but the species doesn't grant it at that level; fail closed`);
  }

  const item: Record<string, unknown> = {
    kind: 'species',
    id: `srd:${kebab(base)}`,
    name: base,
    source: sourceOf(page),
    size: [...sizes].sort((a, b) => SIZE_ORDER.indexOf(a) - SIZE_ORDER.indexOf(b)),
    speed,
  };
  if (features.length) item.features = features.sort(byString).map((id) => (levelOf.has(id) ? { id, level: levelOf.get(id)! } : id));
  if (resist.size) item.resist = [...resist].sort(byString);
  if (choices.length) item.choices = choices.sort((a, b) => byString(a.id as string, b.id as string));
  return [{ kind: 'species', item, unimplemented: lines, classify: { maps: true, shape: 'data', hasDuration: false }, pdfPage: page }, ...stubs];
};

/**
 * Narrative stubs (and a line each, pushed onto `lines`) for the PDF traits of `base` that no
 * emitted feature, choice or "choice <id> not mapped" line carries, matched by kebab-case id.
 * Throws if the PDF lists traits for the species and a stub id would collide.
 */
export function traitStubs(pdf: PdfIndex, base: string, features: readonly string[], choices: readonly Record<string, unknown>[], lines: string[]): MapOutput[] {
  const rows = (pdf?.speciesTraits ?? []).filter((t) => t.species === base && t.of === undefined);
  const carried = new Set<string>([
    ...features.map((f) => f.slice(f.lastIndexOf('/') + 1)),
    ...choices.map((c) => String(c.id)),
    ...lines.flatMap((l) => /^choice ([a-z][a-zA-Z0-9_-]*) not mapped$/.exec(l)?.[1] ?? []),
  ]);
  const out: MapOutput[] = [];
  for (const t of [...rows].sort((a, b) => byString(a.name, b.name))) {
    const name = t.name.replace(/[‘’]/g, "'");
    const local = kebab(name);
    if (carried.has(local)) continue;
    carried.add(local);
    lines.push(U.speciesTrait(local));
    out.push({
      kind: 'feature',
      item: { kind: 'feature', id: `srd:${kebab(base)}/${local}`, name, source: sourceOf(t.page) },
      unimplemented: [],
      classify: { maps: false, shape: 'data', hasDuration: false },
      pdfPage: t.page,
    });
  }
  return out;
}

/** The PDF's start level for a species trait (by name, curly quotes folded), if it gives one. */
export function pdfTraitLevel(pdf: PdfIndex, base: string, name: string): number | undefined {
  const n = name.replace(/[‘’]/g, "'");
  return pdf?.speciesTraits?.find((t) => t.species === base && t.of === undefined && t.name.replace(/[‘’]/g, "'") === n)?.level;
}

/** Save-mode changes as a mod: value 1 advantage, -1 disadvantage. */
const SAVE_MODE = /^system\.abilities\.(str|dex|con|int|wis|cha)\.save\.roll\.mode$/;

/**
 * The part of a trait or feat record that maps onto a feature today (resist from outside,
 * hp.perLevel and save advantage from transfer effects), plus lines for the rest. With a PDF
 * reading for `featureId` (pdf-gates.ts, M3 step 4), stat changes map too (map/stats.ts), and
 * the effect's mods and stats get the reading's gates.
 */
export function featureBody(doc: Readonly<Record<string, unknown>>, localId: string, name: string, featureId?: string): { body: Record<string, unknown>; lines: string[] } {
  const reading = featureId !== undefined ? PDF_READINGS[featureId] : undefined;
  const gates: readonly string[] = reading?.when ?? [];
  const stats: Record<string, unknown>[] = [];
  const gatedResist: string[] = [];
  const immune: string[] = [];
  const lines: string[] = [];
  const body: Record<string, unknown> = {};
  const acts = getPath(doc, 'system.activities');
  const actList = isRecord(acts) ? Object.keys(acts).sort(byString).map((k) => acts[k]) : [];
  for (const a of actList) {
    const t = isRecord(a) ? a.type : undefined;
    lines.push(typeof t === 'string' && ['attack', 'cast', 'check', 'damage', 'enchant', 'forward', 'heal', 'order', 'save', 'summon', 'teleport', 'transform', 'utility'].includes(t) ? U.activityType(t) : U.activityUnknownType());
  }
  const effects = Array.isArray(doc.effects) ? doc.effects.filter(isRecord) : [];
  const adv: string[] = [];
  const dis: string[] = [];
  for (const e of effects) {
    const changes = getPath(e, 'system.changes') ?? e.changes;
    const list = Array.isArray(changes) ? changes.filter(isRecord) : [];
    // Effects an activity applies (transfer false) belong to that activity's line.
    if (e.transfer !== true) continue;
    for (const ch of list) {
      const key = String(ch.key ?? '');
      const mode = String(ch.type ?? ch.mode ?? '');
      const cls = classifyChange(key, mode);
      if (cls.status === 'ignored') continue;
      if (cls.status !== 'mapped') {
        lines.push(cls.line);
        continue;
      }
      const usable = actList.length === 0; // a record with activities: its effects may be conditional on them
      const value = Number(ch.value);
      const m = SAVE_MODE.exec(key);
      const sp = usable && reading ? statPart(cls.target, mode, ch.value) : undefined;
      if (sp && 'stat' in sp) stats.push(sp.stat);
      else if (sp && 'immuneCond' in sp) immune.push(sp.immuneCond);
      else if (sp && 'resist' in sp && gates.length) gatedResist.push(sp.resist);
      else if (usable && cls.target.to === 'hp.perLevel' && Number.isInteger(value) && value >= 1 && body.hp === undefined) body.hp = { perLevel: value };
      else if (usable && m && (value === 1 || value === -1)) (value === 1 ? adv : dis).push(`d20.save.${m[1]}`);
      else lines.push(U.effectKey(key, /^(add|override|multiply|upgrade|downgrade|subtract|custom|[0-9])$/.test(mode) ? mode : 'custom'));
    }
  }
  const mods: Record<string, unknown>[] = [];
  const w = gates.length ? { when: [...gates] } : {};
  if (adv.length) mods.push({ on: [...new Set(adv)].sort(byString), op: 'adv', ...w });
  if (dis.length) mods.push({ on: [...new Set(dis)].sort(byString), op: 'dis', ...w });
  const allStats = finishStats(stats, gatedResist, gates);
  if (mods.length || allStats.length || immune.length) {
    const fx: Record<string, unknown> = { id: localId, name };
    if (mods.length) fx.mods = mods;
    if (allStats.length) fx.stats = allStats;
    if (immune.length) fx.immune = [...new Set(immune)].sort(byString);
    body.effects = [fx];
    body.passive = { effects: [localId] };
  }
  return { body, lines };
}

export const mapSpeciesTrait: Mapper = (ctx): MapOutput => {
  const k = ctx.kept;
  const id = traitId(ctx.pdf, k);
  const local = id.slice(id.lastIndexOf('/') + 1);
  const { body, lines } = featureBody(ctx.doc, local, k.rec.name, id);
  // Resistances and spells the owning race grants under this trait's name (homeOf).
  const resist = new Set<string>();
  for (const o of k.owners) {
    const race = ctx.lookup(o.foreignId);
    if (!race) continue;
    for (const a of advancements(race.rec.doc)) {
      if (homeOf(ctx, race, a) !== k.rec.id) continue;
      if (a.type === 'Trait') for (const g of traitCodes(a).grants) if (g.startsWith('dr:')) resist.add(damageTypeOf(g.slice(3), race.rec.path));
      if (a.type === 'ItemGrant' && grantsSpells(a)) lines.push(U.spellGrants());
    }
  }
  if (resist.size) body.resist = [...resist].sort(byString);
  const base = speciesBase(ctx.pdf, k.owners[0]!.name);
  const page = ctx.pdf?.speciesTraits?.find((t) => t.species === base && (t.name === k.rec.name || t.name.replace(/’/g, "'") === k.rec.name))?.page ?? pdfEntry(ctx.pdf?.species, base)?.page;
  const maps = body.resist !== undefined || body.hp !== undefined || body.passive !== undefined;
  return {
    kind: 'feature',
    item: { kind: 'feature', id, name: k.rec.name, source: sourceOf(page), ...body },
    unimplemented: lines,
    classify: { maps, shape: 'other', hasDuration: false },
    pdfPage: page,
  };
};
