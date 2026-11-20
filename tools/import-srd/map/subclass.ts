// The subclass mapper (docs/design/m3.md 2.2; C4, C16, C21). One classes24 subclass record
// becomes one `kind: subclass` item (id srd:<kebab-case name>, e.g. srd:warrior-of-the-open-hand)
// plus narrative stubs for the PDF subclass section's features no kept record carries. Same
// sources as the class mapper (map/class.ts): ScaleValue columns kept qualified by Foundry's
// own owner (C16), features from ItemGrant where the (subclass, level, name) tuple passed,
// pools from uses at levels 1-10, acFormulas from the closed AC table, skill and feat choices.
// alwaysPrepared needs spell ids, which arrive at step 6: the spell grants are a line until then.

import { U } from '../unimplemented.ts';
import { getPath } from '../util.ts';
import type { FoundryRecord } from '../read.ts';
import type { SrdIndex } from '../pdf/build.ts';
import {
  byLevel,
  classIdentOf,
  haveOf,
  kebab,
  pdfOf,
  pageSource,
  pdfStubs,
  poolsAndAc,
  readGrants,
  readItemChoices,
  readTraits,
  scaleOf,
  sortChoices,
  type Rec,
} from './class.ts';
import type { MapCtx, Mapper, MapOutput } from './types.ts';

/** The kept class record a subclass belongs to (system.classIdentifier). */
function parentOf(ctx: MapCtx, rec: FoundryRecord, cls: string): FoundryRecord {
  const hits = ctx.allKept.filter((k) => k.kind === 'class' && getPath(k.rec.doc, 'system.identifier') === cls);
  if (hits.length !== 1) throw new Error(`${rec.path}: parent class ${cls} matches ${hits.length} kept class record(s)`);
  return hits[0]!.rec;
}

export const mapSubclass: Mapper = (ctx) => {
  const pdfAll: SrdIndex | undefined = pdfOf(ctx);
  if (!pdfAll) return null;
  const rec = ctx.kept.rec;
  const cls = classIdentOf(rec);
  const parent = parentOf(ctx, rec, cls);
  const parentId = ctx.idOf(parent.id);
  if (!parentId) throw new Error(`${rec.path}: no id for the parent class`);
  const key = kebab(rec.name);
  const pdf = pdfAll.subclasses[key];
  if (!pdf || pdf.class !== cls) throw new Error(`${rec.path}: subclass ${key} of ${cls} is not in srd-index.json`);
  const lines: string[] = [];

  const traits = readTraits(ctx, rec);
  // Subclass traits sit at level 3 or later: readTraits turns their skill picks into choices
  // (skills-<level>) and their flat grants into lines (a subclass has no proficiency fields).
  lines.push(...traits.lines);
  if (traits.saves.length || traits.armor.length || traits.weapons.length || traits.tools.length || traits.skills) {
    throw new Error(`${rec.path}: a subclass Trait at level 1`);
  }

  const { scale, lines: scaleLines } = scaleOf(rec, undefined, cls);
  lines.push(...scaleLines);

  const grants = readGrants(ctx, rec);
  lines.push(...grants.lines);
  const stubs = pdfStubs(rec, pdf.features, haveOf(grants), () => false);
  // A subclass that grants spells by its "<Subclass> Spells" feature (Life Domain Spells, Fiend
  // Spells, Circle of the Land Spells...) grants them whether Foundry carries an ItemGrant of
  // spells or only a table in the description: the PDF row decides (alwaysPrepared is step 6).
  const first = pdf.name.split(' ')[0]!;
  if (pdf.features.some((f) => f.name === `${pdf.name} Spells` || f.name === `${first} Spells`)) lines.push(U.spellGrants());
  const pa = poolsAndAc(ctx, grants.entries, cls);
  lines.push(...pa.lines);
  const choices = readItemChoices(ctx, rec);
  lines.push(...choices.lines);

  const item: Rec = {
    kind: 'subclass',
    id: `srd:${key}`,
    name: rec.name,
    source: pageSource(pdf.page),
    parent: parentId,
    features: byLevel([...grants.entries, ...stubs.entries]),
  };
  // Foundry keys this subclass's scale values (and @scale references to them) by its own
  // identifier (Circle of the Land: land, so @scale.land.lands-aid); the engine resolves that
  // qualified form through scaleOwner (C16). Emitted whenever it differs from our local id.
  const ident = getPath(rec.doc, 'system.identifier');
  if (typeof ident !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(ident)) throw new Error(`${rec.path}: subclass identifier ${String(ident)} is not kebab-case`);
  if (ident !== key) item.scaleOwner = ident;
  if (Object.keys(scale).length) item.scale = scale;
  if (pa.pools.length) item.pools = pa.pools;
  if (pa.acFormulas.length) item.acFormulas = pa.acFormulas;
  const allChoices = sortChoices([...traits.choices, ...choices.choices], rec.path);
  if (allChoices.length) item.choices = allChoices;

  const out: MapOutput = { kind: 'subclass', item, unimplemented: lines, classify: { maps: true, shape: 'data', hasDuration: false }, pdfPage: pdf.page };
  return [out, ...stubs.outputs];
};
