// PDF readings for always-on effects (M3 step 4: STAT and GATE; docs/design/m3.md section 3).
//
// Foundry applies a transfer effect unconditionally and leaves its conditions to the player:
// Unarmored Movement's speed bonus, Defense's +1 AC and Danger Sense's Advantage are all
// always-on in the record, while the SRD 5.2.1 text puts a condition on each. So an always-on
// effect is not, by itself, an exact reading. The importer emits a STAT (ac, speed, critMin,
// immune, vuln, condition immunity) or gates an effect only for a feature listed here, with the
// gates the PDF states, read by hand from the PDF text (srd-raw.txt, line numbers cited). A
// feature that isn't listed keeps its effect-key lines; one whose condition has no gate yet is
// not listed and stays partial (Fast Movement waited for notHeavyArmor until coverage W1). The
// table is closed: adding a row is a reviewed change here.
//
// readingProblems (run by buildImport, fail closed) checks both directions: every emitted stat,
// condition immunity or gate on a feature's effect has a row here, with exactly these gates,
// and every row whose owner is emitted is emitted with its reading.

import type { GateSrc } from '../../packages/engine/src/content/schema.ts';
import { MAGIC_READINGS, variantIds } from './map/magic-item.ts';
import { kebabName } from './map/monster.ts';
import { byString, isRecord } from './util.ts';

export interface PdfReading {
  /** The item that grants the feature (a class, subclass, species or feat): rows whose owner isn't emitted are skipped (tests that import a subset). */
  readonly owner: string;
  /** The gates the PDF puts on the effect; [] when the text states none. */
  readonly when: readonly Extract<GateSrc, string>[];
  /** Where: the PDF page and the srd-raw.txt lines read. */
  readonly pdf: string;
}

export const PDF_READINGS: Readonly<Record<string, PdfReading>> = {
  // "Your speed increases by 10 feet while you aren't wearing armor or wielding a Shield. This
  // bonus increases when you reach certain Monk levels, as shown on the Monk Features table."
  // The record's change is + @scale.monk.unarmored-movement (the table column, 10/15/20 at 2/6/10).
  'srd:monk/unarmored-movement': { owner: 'srd:monk', when: ['unarmored', 'noShield'], pdf: 'p.51, srd-raw.txt:11139-11144' },
  // "You have Advantage on Dexterity saving throws unless you have the Incapacitated condition."
  'srd:barbarian/danger-sense': { owner: 'srd:barbarian', when: ['notIncapacitated'], pdf: 'p.29, srd-raw.txt:5012-5017' },
  // "Your attack rolls with weapons and Unarmed Strikes can score a Critical Hit on a roll of 19
  // or 20 on the d20." The engine's critMin stat covers exactly weapon attacks and Unarmed Strikes
  // (sim/stats.ts critMinOf); no gate.
  'srd:champion/improved-critical': { owner: 'srd:champion', when: [], pdf: 'p.49, srd-raw.txt:10711-10715' },
  // Defense (Fighting Style Feat): "While you're wearing Light, Medium, or Heavy armor, you gain
  // a +1 bonus to Armor Class." The armored gate is exactly light, medium or heavy (sim/stats.ts).
  'srd:defense/defense': { owner: 'srd:defense', when: ['armored'], pdf: 'p.88, srd-raw.txt:20117-20121' },
  // Elven Lineages table, Wood Elf: "Your Speed increases to 35 feet." The record has no effect;
  // the stat ({speed: 5} over the Elf's 30) comes from the hand override
  // overrides/feature/elf/elven-lineage-wood-elf.yaml. No gate.
  'srd:elf/elven-lineage-wood-elf': { owner: 'srd:elf', when: [], pdf: 'p.84, srd-raw.txt:19771-19774' },
  // M3 step 5a. These two carry effects a rider applies to the creature hit (not always-on
  // effects); the stats come from their hand overrides, and the text puts no gate on them.
  // Stunning Strike, success: "the target's Speed is halved until the start of your next turn,
  // and the next attack roll made against the target before then has Advantage."
  'srd:monk/stunning-strike': { owner: 'srd:monk', when: [], pdf: 'p.51, srd-raw.txt:11201-11210' },
  // Open Hand Technique, Addle: "The target can't make Opportunity Attacks until the start of its
  // next turn."
  'srd:warrior-of-the-open-hand/open-hand-technique': { owner: 'srd:warrior-of-the-open-hand', when: [], pdf: 'p.52, srd-raw.txt:11315-11316' },
  // Coverage W1 (docs/design/w1-plan.md section 3). The effects and their stats come from the hand
  // overrides (an effect Foundry applies through an activity maps nothing here); these rows say
  // which gates the text puts on them.
  // Fast Movement: "Your speed increases by 10 feet while you aren't wearing Heavy armor." The
  // record's always-on change is the +10; notHeavyArmor is exactly armor none, light or medium
  // (sim/stats.ts; unknown armor fails closed).
  'srd:barbarian/fast-movement': { owner: 'srd:barbarian', when: ['notHeavyArmor'], pdf: 'p.29, srd-raw.txt:5065-5068' },
  // Rage, while it lasts (the effect itself is the gate): "You have Resistance to Bludgeoning,
  // Piercing, and Slashing damage", "Advantage on Strength checks and Strength saving throws", "You
  // can't maintain Concentration, and you can't cast spells." No further condition.
  'srd:barbarian/rage': { owner: 'srd:barbarian', when: [], pdf: 'p.28, srd-raw.txt:4970-4981' },
  // Mindless Rage: "You have Immunity to the Charmed and Frightened conditions while your Rage is
  // active": a child effect of the Rage (it ends with it), no further gate.
  'srd:path-of-the-berserker/mindless-rage': { owner: 'srd:path-of-the-berserker', when: [], pdf: 'p.30, srd-raw.txt:5180-5184' },
  // Steady Aim: "your Speed is 0 until the end of the current turn" (the effect's duration), no gate.
  'srd:rogue/steady-aim': { owner: 'srd:rogue', when: [], pdf: 'p.62, srd-raw.txt:13788-13794' },
  // Alert, Initiative Proficiency: "When you roll Initiative, you can add your Proficiency Bonus to
  // the roll." The feat's own feature (overrides/feature/alert/alert.yaml, written from the PDF:
  // Foundry's Initiative flag has no mapping), as Defense's; no gate.
  'srd:alert/alert': { owner: 'srd:alert', when: [], pdf: 'p.87, srd-raw.txt:20032-20033' },
  // M3 step 6 (C9b): the simple magic items, one row per emitted item, from map/magic-item.ts
  // MAGIC_READINGS (each its own owner: a magic item is carried, not granted).
  ...magicRows(),
};

function magicRows(): Record<string, PdfReading> {
  const out: Record<string, PdfReading> = {};
  for (const name of Object.keys(MAGIC_READINGS).sort(byString)) {
    const r = MAGIC_READINGS[name]!;
    const locals = r.variants ? variantIds(name).map((v) => v.local) : [kebabName(name)];
    for (const l of locals) out[`srd:${l}`] = { owner: `srd:${l}`, when: [...(r.when ?? [])], pdf: r.pdf };
  }
  return out;
}

type Item = Readonly<Record<string, unknown>>;

const gateKey = (when: unknown): string => (Array.isArray(when) ? when.map((g) => (typeof g === 'string' ? g : JSON.stringify(g))).join(',') : '');

/** Mods and stats of an item's effects, plus whether any effect carries a condition immunity. */
function readingParts(it: Item): { parts: Record<string, unknown>[]; condImmune: boolean } {
  const parts: Record<string, unknown>[] = [];
  let condImmune = false;
  for (const e of Array.isArray(it.effects) ? it.effects : []) {
    if (!isRecord(e)) continue;
    for (const m of Array.isArray(e.mods) ? e.mods : []) if (isRecord(m)) parts.push(m);
    for (const s of Array.isArray(e.stats) ? e.stats : []) if (isRecord(s)) parts.push(s);
    if (Array.isArray(e.immune) && e.immune.length) condImmune = true;
  }
  return { parts, condImmune };
}

/** One problem per emitted reading that isn't in `table`, differs from it, or is missing. */
export function readingProblems(items: ReadonlyMap<string, Item>, table: Readonly<Record<string, PdfReading>> = PDF_READINGS): string[] {
  const p: string[] = [];
  for (const id of [...items.keys()].sort(byString)) {
    const it = items.get(id)!;
    if (it.kind !== 'feature') continue;
    const { parts, condImmune } = readingParts(it);
    const needs = condImmune || parts.some((x) => 'when' in x || !('on' in x));
    if (!needs) continue;
    const want = table[id];
    if (!want) {
      p.push(`${id}: a stat, condition immunity or gate with no PDF reading in PDF_READINGS`);
      continue;
    }
    for (const x of parts) {
      if (gateKey(x.when) !== gateKey(want.when)) p.push(`${id}: gates [${gateKey(x.when)}], the PDF (${want.pdf}) reads [${gateKey(want.when)}]`);
    }
  }
  for (const id of Object.keys(table).sort(byString)) {
    const want = table[id]!;
    if (!items.has(want.owner)) continue;
    const it = items.get(id);
    if (!it) p.push(`${id}: in PDF_READINGS but not emitted`);
    else {
      // A condition immunity is a reading too (coverage W1: Mindless Rage carries only one).
      const r = readingParts(it);
      if (r.parts.length === 0 && !r.condImmune) p.push(`${id}: emitted without its reading (${want.pdf})`);
    }
  }
  return p;
}

export function checkReadings(items: ReadonlyMap<string, Item>): void {
  const p = readingProblems(items);
  if (p.length) throw new Error(`stats and gates that disagree with the PDF readings; fail closed:\n  ${p.join('\n  ')}`);
}
