// Simple magic items (M3 step 6, C9b): equipment24 records with the 'mgc' property that pass the
// license filter and the C4 gate (a "Magic Items A–Z" header). The engine has no magic-item kind,
// so an item is emitted as a passive feature: a character carries it by listing its id under
// `features:` (CharacterSchema), and its effect applies from the start of every fight, which is
// what wearing or carrying it means. Attunement isn't modeled (C9b): an item that requires it gets
// the closed line "attunement not modeled", so it stays partial. As with features (C7), a mapped
// item is partial until a reviewed override makes it full (overrides/feature/armor-plus-N.yaml).
//
// Only the closed MAGIC_READINGS table maps, each row read by hand from the PDF (srd-raw.txt
// lines cited) and checked at import both ways: the PDF tokens (pdf/magic-items.ts FACT_PATTERNS,
// the +N variants, the attunement flag) and the Foundry record's changes must say exactly what
// the row says, or the import fails closed. Foundry's always-on effects drop the text's
// conditions (Bracers of Defense's +2 is unconditional in the record), so the gates come from
// the reading, as for features (pdf-gates.ts). Everything else is narrative; the rows in
// ENGINE_GAPS name the primitive +N ammunition or a wand would need (Shield +N and Weapon +N map
// since M3 step 5b's itemHeld gate and magicWeapon stat).

import { classifyChange } from '../effect-keys.ts';
import { normName } from '../filter.ts';
import type { MagicItemDetail } from '../pdf/magic-items.ts';
import { U } from '../unimplemented.ts';
import { getPath, isRecord } from '../util.ts';
import { kebabName } from './monster.ts';
import type { Mapper, MapOutput } from './types.ts';

type Gate = 'armored' | 'unarmored' | 'noShield' | 'itemHeld';

export interface MagicReading {
  /** The PDF tokens the text must carry (pdf/magic-items.ts FACT_PATTERNS), exactly. */
  readonly facts: readonly string[];
  /** Where: the PDF page and the srd-raw.txt lines read. */
  readonly pdf: string;
  /** +N variants: one item per bonus (Armor, +1 / +2 / +3), from the rarity list. */
  readonly variants?: true;
  readonly ac?: number;
  readonly save?: number;
  readonly check?: number;
  readonly when?: readonly Gate[];
  /** M3 step 5b: the +N is a magic weapon's bonus to attack and damage rolls (the magicWeapon stat), not AC. */
  readonly weapon?: true;
}

export const MAGIC_READINGS: Readonly<Record<string, MagicReading>> = {
  // "Armor (Any Light, Medium, or Heavy), Rare (+1), Very Rare (+2), or Legendary (+3)" / "You have
  // a bonus to Armor Class while wearing this armor. The bonus is determined by its rarity."
  // armored = Light, Medium or Heavy armor worn (sim/stats.ts), the armor this is.
  'Armor, +1, +2, or +3': { facts: ['ac-by-rarity-while-worn'], pdf: 'p.210, srd-raw.txt:37067-37072', variants: true, when: ['armored'] },
  // "You gain a +1 bonus to Armor Class and saving throws while wearing this ring."
  'Ring of Protection': { facts: ['ac+1', 'save+1'], pdf: 'p.238, srd-raw.txt:41230-41239', ac: 1, save: 1 },
  // "You gain a +1 bonus to Armor Class and saving throws while you wear this cloak."
  'Cloak of Protection': { facts: ['ac+1', 'save+1'], pdf: 'p.216, srd-raw.txt:38045-38050', ac: 1, save: 1 },
  // "While this polished agate is on your person, you gain a +1 bonus to ability checks and saving throws."
  'Stone of Good Luck (Luckstone)': { facts: ['check+1', 'save+1'], pdf: 'p.248, srd-raw.txt:42766-42771', check: 1, save: 1 },
  // M3 step 5b. "Armor (Shield), Uncommon (+1), Rare (+2), or Very Rare (+3)" / "While holding this
  // Shield, you have a bonus to Armor Class determined by the Shield's rarity, in addition to the
  // Shield's normal bonus to AC." itemHeld = the item whose magic names this feature (the Shield
  // itself) is in a hand: "this Shield", not any Shield.
  'Shield, +1, +2, or +3': { facts: ['ac-by-rarity-while-holding'], pdf: 'p.243, srd-raw.txt:41978-41983', variants: true, when: ['itemHeld'] },
  // M3 step 5b. "Weapon (Any Simple or Martial), Uncommon (+1), Rare (+2), or Very Rare (+3)" / "You
  // have a bonus to attack rolls and damage rolls made with this magic weapon. The bonus is
  // determined by the weapon's rarity." magicWeapon = that bonus on the attack and damage rolls of
  // the weapon whose magic names this feature (content/compile.ts), every mode of it.
  'Weapon, +1, +2, or +3': { facts: ['attack-damage-by-rarity'], pdf: 'p.253, srd-raw.txt:43329-43334, 43342-43343', variants: true, weapon: true },
  // "While wearing these bracers, you gain a +2 bonus to Armor Class if you are wearing no armor
  // and using no Shield." unarmored = no armor worn; noShield = no Shield in hand.
  'Bracers of Defense': { facts: ['ac+2', 'if-no-armor-no-shield'], pdf: 'p.214, srd-raw.txt:37725-37737', ac: 2, when: ['unarmored', 'noShield'] },
};

/** +N items that need an engine primitive to be exact: narrative, with the gap named. */
export const ENGINE_GAPS: Readonly<Record<string, string>> = {
  // "a bonus to attack rolls and damage rolls made with this piece of magic ammunition ... Once it
  // hits a target, the ammunition is no longer magical" (srd-raw.txt:36913-36920): no per-piece
  // bonus (the engine counts ammunition as one stack; the magicWeapon stat is per weapon).
  'Ammunition, +1, +2, or +3': 'magic-weapon-bonus',
  // a bonus to spell attack rolls while holding it
  'Wand of the War Mage, +1, +2, or +3': 'held-item-gate',
};

/** The transfer-effect changes of a record as "<key> <mode> <value>" tokens, sorted (enchantments left out). */
function baseChanges(doc: Readonly<Record<string, unknown>>): string[] {
  const out: string[] = [];
  for (const e of Array.isArray(doc.effects) ? doc.effects : []) {
    if (!isRecord(e) || e.type === 'enchantment' || e.transfer !== true || e.disabled === true) continue;
    const ch = getPath(e, 'system.changes') ?? e.changes;
    for (const c of Array.isArray(ch) ? ch : []) {
      if (!isRecord(c) || typeof c.key !== 'string') continue;
      const mode = typeof c.type === 'string' ? c.type : String(c.mode);
      if (classifyChange(c.key, mode).status === 'ignored') continue;
      out.push(`${c.key} ${mode} ${String(c.value).replace(/^\+/, '')}`);
    }
  }
  return out.sort();
}

/** The enchantment effects' magicalBonus values, in order (the +N variants). */
function enchantBonuses(doc: Readonly<Record<string, unknown>>): number[] {
  const out: number[] = [];
  for (const e of Array.isArray(doc.effects) ? doc.effects : []) {
    if (!isRecord(e) || e.type !== 'enchantment') continue;
    const ch = getPath(e, 'system.changes') ?? e.changes;
    for (const c of Array.isArray(ch) ? ch : []) {
      if (isRecord(c) && /^system\.(armor\.)?magicalBonus$/.test(String(c.key))) out.push(Number(c.value));
    }
  }
  return out;
}

/** Why a reading doesn't hold for this record and PDF entry, or undefined when it does. */
export function readingProblem(r: MagicReading, pdf: MagicItemDetail, doc: Readonly<Record<string, unknown>>): string | undefined {
  if (pdf.facts.join(',') !== [...r.facts].sort().join(',')) return `PDF tokens [${pdf.facts.join(',')}], the reading [${r.facts.join(',')}]`;
  if (r.variants) {
    if (pdf.plus.join(',') !== '1,2,3') return `PDF variants [${pdf.plus.join(',')}]`;
    if (enchantBonuses(doc).join(',') !== '1,2,3') return `record variants [${enchantBonuses(doc).join(',')}]`;
    return undefined;
  }
  const want = [
    ...(r.ac ? [`system.attributes.ac.bonus add ${r.ac}`] : []),
    ...(r.check ? [`system.bonuses.abilities.check add ${r.check}`] : []),
    ...(r.save ? [`system.bonuses.abilities.save add ${r.save}`] : []),
  ].sort();
  const got = baseChanges(doc);
  if (got.join('|') !== want.join('|')) return `record changes [${got.join('; ')}], the reading [${want.join('; ')}]`;
  return undefined;
}

function effectOf(id: string, name: string, r: MagicReading, n?: number): Record<string, unknown> {
  const when = r.when?.length ? { when: [...r.when] } : {};
  if (r.weapon) return { id, name, stats: [{ magicWeapon: n ?? 0, ...when }] };
  const ac = n ?? r.ac;
  const stats = ac ? [{ ac, ...when }] : [];
  const mods = [
    ...(r.check ? [{ on: ['d20.check'], op: 'flat', value: r.check, ...when }] : []),
    ...(r.save ? [{ on: ['d20.save'], op: 'flat', value: r.save, ...when }] : []),
  ];
  return { id, name, ...(stats.length ? { stats } : {}), ...(mods.length ? { mods } : {}) };
}

/** The item ids and names a magic item record becomes ("Armor, +1, +2, or +3" -> armor-plus-1..3). */
export function variantIds(name: string): { local: string; name: string; n: number }[] {
  const m = /^(.+), \+1, \+2, or \+3$/.exec(name);
  if (!m) return [];
  return [1, 2, 3].map((n) => ({ local: `${kebabName(m[1]!)}-plus-${n}`, name: `${m[1]}, +${n}`, n }));
}

export const mapMagicItem: Mapper = (ctx) => {
  const rec = ctx.kept.rec;
  const pdf = ctx.pdf?.magicItems?.find((m) => normName(m.name) === normName(rec.name));
  if (!pdf) throw new Error(`${rec.path}: passed the magic-item gate but has no PDF entry`);
  const source = `SRD 5.2.1 p.${pdf.page}`;
  const r = MAGIC_READINGS[pdf.name];
  const att = pdf.attunement ? [U.attunement()] : [];
  if (r) {
    const why = readingProblem(r, pdf, ctx.doc);
    if (why) throw new Error(`${rec.path}: MAGIC_READINGS["${pdf.name}"] (${r.pdf}) doesn't hold: ${why}; fail closed`);
    const one = (local: string, name: string, n?: number): MapOutput => ({
      kind: 'feature',
      item: { kind: 'feature', id: `srd:${local}`, name, source, effects: [effectOf(local, name, r, n)], passive: { effects: [local] } },
      unimplemented: att,
      // C7: the importer alone never makes a program or stat item full; the reading is the
      // importer's, so an item becomes full only through a reviewed override.
      classify: { maps: true, shape: 'bucketA', heuristicShape: true, hasDuration: false },
      pdfPage: pdf.page,
    });
    return r.variants ? variantIds(pdf.name).map((v) => one(v.local, v.name, v.n)) : one(kebabName(pdf.name), pdf.name);
  }
  const gap = ENGINE_GAPS[pdf.name];
  return {
    kind: 'feature',
    item: { kind: 'feature', id: `srd:${kebabName(pdf.name)}`, name: pdf.name, source },
    unimplemented: [...att, ...(gap ? [U.engineGap(gap)] : [])],
    classify: { maps: false, shape: 'data', hasDuration: false },
    pdfPage: pdf.page,
  };
};
