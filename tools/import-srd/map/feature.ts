// The feature mapper (docs/design/m3.md 2.4, 2.7, 4.3-4.5, 4.9). Class and subclass features
// (classes24 feat records) become `kind: feature` items. Ids: srd:<class>/<identifier> and
// srd:<subclass name>/<identifier> (map/class.ts featureIdOf). Species traits go through
// species.ts mapSpeciesTrait.
//
// Step 2 maps what today's primitives express exactly, and nothing else:
//   - an always-on effect (transfer, enabled, no statuses) whose every change maps to a d20
//     mod (advantage or disadvantage on a save or check, a flat whole-number bonus), a damage
//     resistance, or HP per level  -> passive effect, resist or hp
//   - Unarmored Defense-style ac.calc changes are carried by the class or subclass acFormulas
//     (map/class.ts AC_CALCS), so they add nothing here and no line
// M3 step 4 adds, for a feature with a PDF reading (pdf-gates.ts) only: stats (ac, speed,
// critMin, immune, vuln, a gated resist) and condition immunities (map/stats.ts), and the
// reading's gates on the effect's mods and stats. Foundry leaves the text's conditions out of
// its always-on effects, so without a reading these keep their lines.
// Everything else is a templated line: each activity's type (no activity maps to a program
// until the M3 primitives land: no self-only target, rider, condition, stat or weapon attack
// yet), each status, each change that doesn't map, each effect with no changes. A feature
// with nothing mapped is narrative; with something mapped it's partial at best (shape 'other':
// nothing auto-promotes to full, C7). Features above level 10 are narrative stubs (4.9).

import { classifyChange } from '../effect-keys.ts';
import { PDF_READINGS } from '../pdf-gates.ts';
import { normName } from '../filter.ts';
import { ACTIVITY_TYPES, U } from '../unimplemented.ts';
import { getPath, isRecord } from '../util.ts';
import type { SrdIndex } from '../pdf/build.ts';
import { AC_CALCS, changesOf, classIdentOf, effectsOf, featureIdOf, featureLevel, firstOwner, kebab, pdfOf, pageSource, type Rec } from './class.ts';
import { DAMAGE_TYPES, finishStats, statPart } from './stats.ts';
import type { MapCtx, Mapper } from './types.ts';

const MODE_TOKEN = /^(add|override|multiply|upgrade|downgrade|subtract|custom|[0-9])$/;

/** The PDF page of a feature: its row in the owner's table or section, else the owner's first page. */
function pageOf(pdf: SrdIndex, ctx: MapCtx, level: number): number {
  const k = ctx.kept;
  const name = normName(k.rec.name);
  const owner = firstOwner(k, ctx).rec;
  if (owner.type === 'subclass') {
    const sc = pdf.subclasses[kebab(owner.name)];
    if (!sc) throw new Error(`${k.rec.path}: subclass ${owner.name} is not in srd-index.json`);
    return sc.features.find((f) => f.level === level && normName(f.name) === name)?.page ?? optionPage(pdf, kebab(owner.name), level, name) ?? sc.page;
  }
  const c = pdf.classes[classIdentOf(owner) as keyof SrdIndex['classes']];
  if (!c) throw new Error(`${k.rec.path}: class ${owner.name} is not in srd-index.json`);
  return c.features.find((f) => f.level === level && normName(f.name) === name)?.page ?? optionPage(pdf, undefined, level, name, classIdentOf(owner)) ?? c.chapter.first;
}

/** The page of a feature option ("Divine Order: Protector" or "Blessed Warrior") at that level. */
function optionPage(pdf: SrdIndex, subclass: string | undefined, level: number, name: string, cls?: string): number | undefined {
  return (pdf.featureOptions ?? []).find(
    (o) => (subclass !== undefined ? o.subclass === subclass : o.subclass === undefined && o.class === cls) && o.level === level && (normName(o.name) === name || normName(`${o.feature}: ${o.name}`) === name),
  )?.page;
}

interface Mapped {
  effects: Rec[];
  passive: string[];
  resist: string[];
  hpPerLevel?: number;
  lines: string[];
}

/** A whole-number change value ("1", 2, "+1"); undefined otherwise. */
function intValue(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^[+-]?\d+$/.test(v.trim())) return Number(v.trim());
  return undefined;
}

/** The line for a change that has a target on our side but can't be applied here. */
function keyLine(key: string, mode: unknown): string {
  const m = typeof mode === 'string' && MODE_TOKEN.test(mode) ? mode : 'custom';
  const c = classifyChange(key, m);
  return c.status === 'mapped' ? U.effectKey(key, m) : c.status === 'ignored' ? '' : c.line;
}

/**
 * Effects -> passive effects, resistances and HP, plus a line for everything that doesn't map
 * (see the header). With a PDF reading for `featureId` (pdf-gates.ts, M3 step 4) the effect may
 * also carry stats and condition immunities, and its mods and stats get the reading's gates.
 */
export function mapEffects(doc: Readonly<Rec>, ownerClass: string | undefined, featureId?: string): Mapped {
  const out: Mapped = { effects: [], passive: [], resist: [], lines: [] };
  const reading = featureId !== undefined ? PDF_READINGS[featureId] : undefined;
  const gates: readonly string[] = reading?.when ?? [];
  const usedIds = new Set<string>();
  for (const e of effectsOf(doc)) {
    const statuses = (Array.isArray(e.statuses) ? e.statuses : []).filter((s): s is string => typeof s === 'string');
    const changes = changesOf(e);
    for (const s of statuses) out.lines.push(/^[a-z][a-zA-Z0-9_-]{0,40}$/.test(s) ? U.effectStatus(s) : U.effectKeyMalformed());
    if (changes.length === 0) {
      if (statuses.length === 0) out.lines.push(U.effectNoChanges());
      continue;
    }
    const always = e.transfer === true && e.disabled !== true && statuses.length === 0;
    const mods: Rec[] = [];
    const resist: string[] = [];
    const stats: Rec[] = [];
    const gatedResist: string[] = [];
    const immune: string[] = [];
    let hp: number | undefined;
    const pending: string[] = [];
    let whole = always;
    for (const c of changes) {
      const key = typeof c.key === 'string' ? c.key : '';
      const mode = c.type;
      const value = c.value;
      if (key === 'system.attributes.ac.calc' && mode === 'override' && typeof value === 'string' && AC_CALCS[value] && always) continue; // the class's acFormulas carry it
      if (
        key === 'system.attributes.hp.bonuses.overall' &&
        mode === 'add' &&
        ownerClass !== undefined &&
        typeof value === 'string' &&
        value.replace(/\s+/g, '') === `@classes.${ownerClass}.levels`
      ) {
        hp = (hp ?? 0) + 1; // + class level = 1 HP per level (Draconic Resilience: 3 at 3, +1 per level, p.69)
        continue;
      }
      const cls = classifyChange(key, typeof mode === 'string' && MODE_TOKEN.test(mode) ? mode : 'custom');
      if (cls.status === 'ignored') continue;
      if (cls.status !== 'mapped') {
        pending.push(cls.line);
        whole = false;
        continue;
      }
      const t = cls.target;
      const n = intValue(value);
      // M3 step 4: a stat, or a resistance under a gating reading, only with a PDF reading.
      const sp = reading && typeof mode === 'string' ? statPart(t, mode, value) : undefined;
      if (sp && 'stat' in sp) {
        stats.push(sp.stat);
        continue;
      }
      if (sp && 'immuneCond' in sp) {
        immune.push(sp.immuneCond);
        continue;
      }
      if (sp && 'resist' in sp && gates.length) {
        gatedResist.push(sp.resist);
        continue;
      }
      if ((t.to === 'd20.save.mode' || t.to === 'd20.check.mode') && (n === 1 || n === -1)) {
        mods.push({ on: [`d20.${t.to === 'd20.save.mode' ? 'save' : 'check'}.${t.ability}`], op: n === 1 ? 'adv' : 'dis' });
      } else if ((t.to === 'd20.save' || t.to === 'd20.check') && n !== undefined && n !== 0) {
        mods.push({ on: [t.to], op: 'flat', value: n });
      } else if (t.to === 'resist' && typeof value === 'string' && DAMAGE_TYPES.includes(value)) {
        resist.push(value);
      } else if (t.to === 'hp.perLevel' && n !== undefined && n > 0) {
        hp = (hp ?? 0) + n;
      } else {
        pending.push(keyLine(key, mode));
        whole = false;
      }
    }
    if (!whole) {
      // Mapped whole or not at all: every non-cosmetic change of an effect we can't apply gets a line.
      for (const c of changes) {
        const key = typeof c.key === 'string' ? c.key : '';
        const l = /^[A-Za-z][A-Za-z0-9_.[\]-]{0,120}$/.test(key) ? keyLine(key, c.type) : U.effectKeyMalformed();
        if (l) out.lines.push(l);
      }
      continue;
    }
    const allStats = finishStats(stats, gatedResist, gates);
    if (mods.length || allStats.length || immune.length) {
      let id = kebab(typeof e.name === 'string' && e.name ? e.name : 'effect') || 'effect';
      while (usedIds.has(id)) id = `${id}-2`;
      usedIds.add(id);
      const fx: Rec = { id, name: typeof e.name === 'string' && e.name ? e.name : 'Effect' };
      if (mods.length) fx.mods = gates.length ? mods.map((m) => ({ ...m, when: [...gates] })) : mods;
      if (allStats.length) fx.stats = allStats;
      if (immune.length) fx.immune = [...new Set(immune)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      out.effects.push(fx);
      out.passive.push(id);
    }
    out.resist.push(...resist);
    if (hp !== undefined) out.hpPerLevel = (out.hpPerLevel ?? 0) + hp;
  }
  out.resist = [...new Set(out.resist)].sort((a, b) => DAMAGE_TYPES.indexOf(a) - DAMAGE_TYPES.indexOf(b));
  return out;
}

/** One line per activity, by type (none maps to a program in step 2). Sorted by activity id. */
export function activityLines(doc: Readonly<Rec>): string[] {
  const acts = getPath(doc, 'system.activities');
  if (!isRecord(acts)) return [];
  return Object.keys(acts)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((k) => {
      const t = isRecord(acts[k]) ? (acts[k] as Rec).type : undefined;
      return typeof t === 'string' && (ACTIVITY_TYPES as readonly string[]).includes(t) ? U.activityType(t) : U.activityUnknownType();
    });
}

export const mapFeature: Mapper = (ctx) => {
  const pdf = pdfOf(ctx);
  if (!pdf) return null;
  const k = ctx.kept;
  const doc = ctx.doc as Rec;
  const id = featureIdOf(k, ctx);
  const level = featureLevel(k);
  const page = pageOf(pdf, ctx, level);
  const item: Rec = { kind: 'feature', id, name: k.rec.name, source: pageSource(page) };
  if (level > 10) {
    return { kind: 'feature', item, unimplemented: [U.levelsAbove10()], classify: { maps: false, shape: 'other', hasDuration: false }, pdfPage: page };
  }
  const ownerClass = classIdentOf(firstOwner(k, ctx).rec);
  const fx = mapEffects(doc, ownerClass, id);
  const lines = [...activityLines(doc), ...fx.lines];
  if (fx.effects.length) {
    item.effects = fx.effects;
    item.passive = { effects: fx.passive };
  }
  if (fx.resist.length) item.resist = fx.resist;
  if (fx.hpPerLevel !== undefined) item.hp = { perLevel: fx.hpPerLevel };
  const maps = fx.effects.length > 0 || fx.resist.length > 0 || fx.hpPerLevel !== undefined;
  return { kind: 'feature', item, unimplemented: lines, classify: { maps, shape: 'other', hasDuration: false }, pdfPage: page };
};
