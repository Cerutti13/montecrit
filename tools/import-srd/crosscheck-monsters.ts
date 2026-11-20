// The monster cross-check (M3 step 6, docs/design/m3.md 4.2, C7): every PDF stat block that
// parses whole (srd-index.json monsterDetails) against Foundry's record (map/monster.ts
// monsterDiffs: size, CR, scores, HP, AC, speeds, save proficiencies, skills, senses, defenses,
// attack names) and against 5e-bits' 2024 Monsters.json as a vote (AC, HP and its roll, CR, walking
// speed, the six scores, and each attack's to-hit and first damage dice). Open5e is a third vote
// when its pinned data is in the cache (crosscheck-open5e.ts crosscheckMonsters: AC, HP, CR). The
// PDF decides; a vote never changes an emitted item (a Foundry disagreement keeps the item from
// being full, in the mapper).
//
// Everything written is a machine token: a monster id, a field name, numbers, dice ("2d6+3"),
// size and type ids. A vote value that isn't one is the token "unparsed", never copied.

import { normName } from './filter.ts';
import { buildMonster, crNumber, foundryTokens, kebabName, monsterAreaAction, monsterDiffs, monsterId, pdfTokens } from './map/monster.ts';
import type { SrdIndex } from './pdf/build.ts';
import type { MonsterDetail } from './pdf/monsters.ts';
import type { FoundryRecord } from './read.ts';
import { byString, getPath, isRecord } from './util.ts';

export interface MonsterRow {
  readonly monster: string;
  readonly field: string;
  readonly pdf: string;
  readonly foundry?: string;
  readonly bits?: string;
  readonly open5e?: string;
  /** The sources that differ from the PDF, joined with '+' (foundry, bits, open5e). */
  readonly against: string;
}

export interface MonsterTally {
  /** Stat blocks the source has a record for. */
  monsters: number;
  compared: number;
  agree: number;
}

export interface MonsterReview {
  /** PDF stat blocks that parse whole. */
  readonly monsters: number;
  readonly foundry: MonsterTally;
  readonly bits: MonsterTally | { readonly available: false };
  readonly open5e: MonsterTally | { readonly available: false };
  readonly byPattern: Record<string, number>;
  readonly disagreements: MonsterRow[];
  /** Coverage step 7.6: every area save the pack carries as an action, as the PDF prints it (the PDF is the truth; the votes above read dc and dice). */
  readonly areaActions: readonly { readonly monster: string; readonly action: string; readonly usage: string; readonly shape: string; readonly size: number; readonly dc: number; readonly dice: string; readonly type: string }[];
}

const TOKEN = /^(?:-?[0-9]+(?:\.[0-9]+)?|[0-9]+d[0-9]+(?:[+-][0-9]+)?|[a-z][a-z0-9,-]*|bonus:-?[0-9]+|[0-9]+ not in the record)$/;
/** A field the source leaves empty is "none"; anything that isn't a token is "unparsed". */
export const asMonsterToken = (v: string): string => (v === '' ? 'none' : TOKEN.test(v) ? v : 'unparsed');

const dice = (s: string): string => s.replace(/\s+/g, '').replace(/−/g, '-');

/** The PDF's vote-comparable tokens. */
export function pdfVoteTokens(d: MonsterDetail): Record<string, string> {
  const out: Record<string, string> = {
    ac: String(d.ac),
    hp: String(d.hp.average),
    hpFormula: dice(d.hp.formula),
    cr: String(crNumber(d.cr)),
    'speed.walk': String(d.speed.walk),
  };
  for (const a of ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const) out[a] = String(d.abilities[a].score);
  for (const e of d.actions) {
    if (!e.attack) continue;
    const k = kebabName(e.name);
    out[`attack.${k}.toHit`] = String(e.attack.toHit);
    out[`attack.${k}.dice`] = dice(e.attack.damage[0]!.dice);
  }
  // Coverage step 7.6: the area saves that map, for the vote.
  for (const e of d.actions) {
    if (!monsterAreaAction(d, e)) continue;
    const k = kebabName(e.name);
    out[`save.${k}.dc`] = String(e.save!.dc);
    out[`save.${k}.dice`] = dice(e.saveArea!.damage[0]!.dice);
  }
  return out;
}

const BITS_ABILITY: Readonly<Record<string, string>> = { str: 'strength', dex: 'dexterity', con: 'constitution', int: 'intelligence', wis: 'wisdom', cha: 'charisma' };

/** 5e-bits' tokens for one Monsters.json record (fields it lacks are left out). */
export function bitsMonsterTokens(e: Readonly<Record<string, unknown>>): Record<string, string> {
  const out: Record<string, string> = {};
  const ac = getPath(e, 'armor_class');
  const ac0 = Array.isArray(ac) && isRecord(ac[0]) ? ac[0].value : undefined;
  if (typeof ac0 === 'number') out.ac = String(ac0);
  if (typeof e.hit_points === 'number') out.hp = String(e.hit_points);
  if (typeof e.hit_points_roll === 'string') out.hpFormula = asMonsterToken(dice(e.hit_points_roll));
  if (typeof e.challenge_rating === 'number') out.cr = String(e.challenge_rating);
  const walk = getPath(e, 'speed.walk');
  if (typeof walk === 'string') {
    const m = /^(\d+) ft\.$/.exec(walk);
    out['speed.walk'] = m ? m[1]! : 'unparsed';
  }
  for (const a of Object.keys(BITS_ABILITY)) {
    const v = e[BITS_ABILITY[a]!];
    if (typeof v === 'number') out[a] = String(v);
  }
  for (const act of Array.isArray(e.actions) ? e.actions : []) {
    if (isRecord(act) && typeof act.name === 'string' && typeof getPath(act, 'dc.dc_value') === 'number') {
      const k = kebabName(act.name.replace(/ \(.*\)$/, ''));
      out[`save.${k}.dc`] = String(getPath(act, 'dc.dc_value'));
      const d0 = Array.isArray(act.damage) && isRecord(act.damage[0]) ? act.damage[0].damage_dice : undefined;
      if (typeof d0 === 'string') out[`save.${k}.dice`] = asMonsterToken(dice(d0));
    }
    if (!isRecord(act) || typeof act.name !== 'string' || typeof act.attack_bonus !== 'number') continue;
    const k = kebabName(act.name);
    out[`attack.${k}.toHit`] = String(act.attack_bonus);
    const d0 = Array.isArray(act.damage) && isRecord(act.damage[0]) ? act.damage[0].damage_dice : undefined;
    if (typeof d0 === 'string') out[`attack.${k}.dice`] = asMonsterToken(dice(d0));
  }
  return out;
}

/**
 * The review section. `foundry` are the kept npc records (by name); `bits` the 5e-bits list when
 * its pinned file is in the cache; `open5e` Open5e's (id, field) rows when its file is.
 */
export function crosscheckMonsters(args: {
  details: readonly MonsterDetail[];
  /** For the ids (map/monster.ts monsterId). */
  pdf?: SrdIndex | undefined;
  foundry: readonly FoundryRecord[];
  bits: readonly Record<string, unknown>[] | undefined;
  open5e?: { compared: number; agree: number; missing: number; disagreements: readonly { monster: string; field: string; ours: string; open5e: string }[] } | undefined;
}): MonsterReview {
  const rows = new Map<string, { monster: string; field: string; pdf: string; foundry?: string; bits?: string; open5e?: string }>();
  const row = (monster: string, field: string, pdf: string) => {
    const k = `${monster}\u0000${field}`;
    let r = rows.get(k);
    if (!r) rows.set(k, (r = { monster, field, pdf }));
    return r;
  };
  const fBy = new Map(args.foundry.map((r) => [normName(r.name), r]));
  const bBy = new Map((args.bits ?? []).filter((e) => typeof e.name === 'string').map((e) => [normName(e.name as string), e]));
  const foundry: MonsterTally = { monsters: 0, compared: 0, agree: 0 };
  const bits: MonsterTally = { monsters: 0, compared: 0, agree: 0 };
  for (const d of [...args.details].sort((a, b) => byString(a.name, b.name))) {
    const id = monsterId(d.name, args.pdf);
    const rec = fBy.get(normName(d.name));
    if (rec) {
      foundry.monsters++;
      const diffs = monsterDiffs(d, rec.doc);
      // Every field both sides carry counts once; monsterDiffs returns only the differing ones.
      const n = comparedFields(d, rec.doc);
      foundry.compared += n;
      foundry.agree += n - diffs.length;
      for (const x of diffs) row(id, x.field, asMonsterToken(x.pdf)).foundry = asMonsterToken(x.foundry);
    }
    const b = bBy.get(normName(d.name));
    if (b && args.bits) {
      bits.monsters++;
      const p = pdfVoteTokens(d);
      const t = bitsMonsterTokens(b);
      for (const k of Object.keys(p).sort(byString)) {
        if (t[k] === undefined) continue;
        bits.compared++;
        if (t[k] === p[k]) bits.agree++;
        else row(id, k, asMonsterToken(p[k]!)).bits = t[k];
      }
    }
  }
  if (args.open5e) for (const r of args.open5e.disagreements) row(r.monster, r.field, asMonsterToken(r.ours)).open5e = asMonsterToken(r.open5e);
  const disagreements: MonsterRow[] = [...rows.values()]
    .map((r) => ({ ...r, against: ['foundry', 'bits', 'open5e'].filter((s) => (r as Record<string, unknown>)[s] !== undefined).join('+') }))
    .sort((a, b) => byString(a.monster, b.monster) || byString(a.field, b.field));
  const byPattern: Record<string, number> = {};
  for (const r of disagreements) {
    const k = `${r.field.replace(/^(attack|save)\.[^.]+\./, '$1.')} (${r.against})`;
    byPattern[k] = (byPattern[k] ?? 0) + 1;
  }
  const sortedPattern = Object.fromEntries(Object.keys(byPattern).sort(byString).map((k) => [k, byPattern[k]!]));
  return {
    monsters: args.details.length,
    foundry,
    bits: args.bits ? bits : { available: false },
    open5e: args.open5e ? { monsters: args.open5e.compared === 0 ? 0 : args.details.length - args.open5e.missing, compared: args.open5e.compared, agree: args.open5e.agree } : { available: false },
    byPattern: sortedPattern,
    disagreements,
    areaActions: [...args.details]
      .sort((a, b) => byString(a.name, b.name))
      .filter((d) => fBy.has(normName(d.name)) && 'item' in buildMonster(d, args.pdf)) // a block the mapper skips emits nothing
      .flatMap((d) =>
        d.actions
          .filter((e) => monsterAreaAction(d, e))
          .map((e) => ({ monster: monsterId(d.name, args.pdf), action: kebabName(e.name), usage: e.usage ?? 'at-will', shape: e.saveArea!.shape, size: e.saveArea!.size, dc: e.save!.dc, dice: e.saveArea!.damage.map((p) => dice(p.dice)).join('+'), type: e.saveArea!.damage.map((p) => p.type).join('+') })),
      ),
  };
}

/** How many fields monsterDiffs compares for this pair: the PDF's token keys the record also carries. */
function comparedFields(d: MonsterDetail, doc: Readonly<Record<string, unknown>>): number {
  const f = foundryTokens(doc);
  return Object.keys(pdfTokens(d)).filter((k) => f[k] !== undefined).length;
}

export function monsterReviewSummary(r: MonsterReview): string[] {
  const t = (s: MonsterTally | { available: false }, name: string) => ('available' in s ? `${name} not available` : `${name} ${s.agree}/${s.compared} agree over ${s.monsters} monsters`);
  const lines = [`monsters vs PDF: ${r.monsters} stat blocks; ${t(r.foundry, 'foundry')}; ${t(r.bits, '5e-bits')}; ${t(r.open5e, 'open5e')}`];
  for (const k of Object.keys(r.byPattern).sort(byString)) lines.push(`  differs from the PDF: ${k}: ${r.byPattern[k]} field(s)`);
  return lines;
}
