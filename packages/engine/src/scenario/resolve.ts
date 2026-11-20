// Scenario file + loaded Content + flag/knob overrides -> FightSetup. Units are ordered by
// seat (compared with <), each seat's stream word is fnv1a32(seat), and both hashes are
// computed here: scenarioHash over the resolved fight (deciders excluded, so a recorded
// fight and its journal replay share it) and contentHash over just the templates it uses.

import { buildLos } from '../grid/los.ts';
import { closureHash } from '../content/load.ts';
import { JournalSchema, KnobsSchema, ScenarioSchema, type JournalFile, type ScenarioSource } from '../content/schema.ts';
import { SKILLS } from '../content/rollkeys.ts';
import type { CompiledTemplate, Content, Step } from '../content/types.ts';
import { compareDiags, diagAt, formatPath, parseYaml, plainDoc, zodDiags, type Diag, type SourceDoc } from '../content/yaml.ts';
import { TERR, parseCell, parseTerrain } from '../grid/cells.ts';
import { DEFAULT_FLAGS, FLAG_INFO, FLAG_KEYS, assertImplemented, hashedFlags, type FlagInfo, type RuleFlags } from '../rules/flags.ts';
import type { Decider } from '../decide/decider.ts';
import { createContext } from '../sim/fight.ts';
import { PrecastError, applyPassives, precastProgramErrors, runPrecasts } from '../sim/precast.ts';
import type { FightSetup, Knobs, PrecastSetup, SeatSetup } from '../sim/setup.ts';
import { canonicalJson } from '../util/canon.ts';
import { fnv1a32, hash64 } from '../util/hash.ts';

export interface ScenarioOverrides {
  readonly flags?: Partial<RuleFlags>;
  readonly knobs?: Partial<Knobs>;
}

export interface ResolveResult {
  readonly setup: FightSetup | null;
  readonly errors: readonly Diag[];
  readonly warnings: readonly Diag[];
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const KNOB_KEYS: readonly (keyof Knobs)[] = ['maxRounds', 'attackDowned', 'lossCounts', 'downEnds'];

/** Parses one KEY=VALUE knob override (for --knob); throws RangeError with the allowed values. */
export function parseKnobValue(key: string, raw: string): Partial<Knobs> {
  if (!(KNOB_KEYS as readonly string[]).includes(key)) throw new RangeError(`unknown knob "${key}" (known: ${KNOB_KEYS.join(', ')})`);
  let value: unknown = raw;
  if (key === 'maxRounds') value = /^\d+$/.test(raw) ? Number(raw) : raw;
  if (key === 'downEnds') value = raw === 'true' ? true : raw === 'false' ? false : raw;
  const r = KnobsSchema.shape[key as keyof Knobs].safeParse(value);
  if (!r.success) throw new RangeError(`knob ${key}: ${r.error.issues[0]?.message ?? 'invalid value'}`);
  return { [key]: r.data } as Partial<Knobs>;
}

function toDoc(input: unknown, path: string, errors: Diag[]): SourceDoc | null {
  if (typeof input !== 'string') return plainDoc(path, input);
  const { doc, errors: yamlErrors } = parseYaml(input, path);
  errors.push(...yamlErrors);
  return doc;
}

/** Resolves a scenario (YAML text, or an already-parsed object) against loaded content. */
export function resolveScenario(input: unknown, path: string, content: Content, overrides: ScenarioOverrides = {}): ResolveResult {
  const errors: Diag[] = [];
  const warnings: Diag[] = [];
  const done = (setup: FightSetup | null): ResolveResult => {
    errors.sort(compareDiags);
    warnings.sort(compareDiags);
    return { setup: errors.length > 0 ? null : setup, errors, warnings };
  };

  const doc = toDoc(input, path, errors);
  if (!doc) return done(null);
  const parsed = ScenarioSchema.safeParse(doc.value);
  if (!parsed.success) {
    errors.push(...zodDiags(doc, [], parsed.error));
    return done(null);
  }
  const sc: ScenarioSource = parsed.data;
  const lead = (p: readonly (string | number)[]) => (p.length > 0 ? `${formatPath(p)}: ` : '');
  const err = (p: readonly (string | number)[], message: string) => errors.push(diagAt(doc, p, `${lead(p)}${message}`));
  const warn = (p: readonly (string | number)[], message: string) => warnings.push(diagAt(doc, p, `${lead(p)}${message}`));

  // Packs: each must be loaded; units may only use their namespaces.
  const namespaces = new Set<string>();
  sc.packs.forEach((name, i) => {
    const info = content.packs.find((p) => p.pack === name);
    if (!info) err(['packs', i], `pack "${name}" isn't loaded`);
    else namespaces.add(info.namespace);
  });

  const { w, h } = sc.grid;
  let terrain: Uint8Array;
  try {
    terrain = parseTerrain(sc.grid.terrain, w, h);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    err(['grid', 'terrain'], e.message);
    terrain = new Uint8Array(w * h);
  }

  // Flags: defaults, then character files, then the scenario's, then overrides (CLI > scenario >
  // character file > default); every value must be implemented. Two characters that set one flag
  // differently are an error unless the scenario or an override settles it.
  const overrideFlags = overrides.flags ?? {};
  const charFlags: Record<string, unknown> = {};
  const charFrom = new Map<string, { unit: number; use: string }>();
  sc.units.forEach((u, i) => {
    const t = content.get(u.use);
    if (!t || t.kind !== 'pc') return;
    const keys = Object.keys(t.flags).sort(byString) as (keyof RuleFlags)[];
    for (const k of keys) {
      const v = t.flags[k];
      const prev = charFrom.get(k);
      if (prev && charFlags[k] !== v) {
        if (!Object.hasOwn(sc.flags, k) && !Object.hasOwn(overrideFlags, k)) {
          err(['units', i, 'use'], `${u.use}'s character file sets ${k}=${String(v)} but ${prev.use}'s sets ${String(charFlags[k])}; settle it in the scenario's flags`);
        }
        continue;
      }
      if (!prev) {
        charFlags[k] = v;
        charFrom.set(k, { unit: i, use: u.use });
      }
    }
  });
  const flags: RuleFlags = { ...DEFAULT_FLAGS, ...(charFlags as Partial<RuleFlags>), ...sc.flags };
  for (const k of Object.keys(overrideFlags).sort(byString)) {
    if (!Object.hasOwn(FLAG_INFO, k)) {
      err([], `override: unknown rule flag "${k}"`);
      continue;
    }
    const key = k as keyof RuleFlags;
    const info: FlagInfo<unknown> = FLAG_INFO[key];
    const v = overrideFlags[key];
    if (!info.options.includes(v)) err([], `override: flag ${key} must be one of ${info.options.join(', ')}`);
    else (flags as unknown as Record<string, unknown>)[key] = v;
  }
  for (const k of FLAG_KEYS) {
    const info: FlagInfo<unknown> = FLAG_INFO[k];
    if (info.unimplemented?.includes(flags[k])) {
      const fromOverride = Object.hasOwn(overrideFlags, k);
      const fromChar = !fromOverride && !Object.hasOwn(sc.flags, k) ? charFrom.get(k) : undefined;
      if (fromChar) err(['units', fromChar.unit, 'use'], `flag ${k}=${String(flags[k])} (from ${fromChar.use}'s character file) isn't implemented yet`);
      else err(fromOverride ? [] : ['flags', k], `${fromOverride ? 'override: ' : ''}flag ${k}=${String(flags[k])} isn't implemented yet`);
    }
  }
  if (errors.length === 0) {
    try {
      assertImplemented(flags);
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      err([], e.message);
    }
  }

  // Knobs: the scenario's (defaults filled), then overrides.
  const knobsParsed = KnobsSchema.safeParse({ ...sc.knobs, ...(overrides.knobs ?? {}) });
  let knobs: Knobs = sc.knobs;
  if (knobsParsed.success) knobs = knobsParsed.data;
  else for (const issue of knobsParsed.error.issues) err([], `override: knob ${issue.path.map(String).join('.')}: ${issue.message}`);

  // Units, ordered by seat.
  const order = sc.units.map((_, i) => i).sort((a, b) => byString(sc.units[a]!.seat, sc.units[b]!.seat));
  const seats: SeatSetup[] = [];
  const bySeatKey = new Map<number, string>();
  const byCell = new Map<number, string>();
  const used: string[] = [];
  const srcIdx: number[] = []; // per seat, its index in the file's units
  for (let n = 0; n < order.length; n++) {
    const i = order[n]!;
    const u = sc.units[i]!;
    if (n > 0 && sc.units[order[n - 1]!]!.seat === u.seat) {
      err(['units', i, 'seat'], `seat "${u.seat}" is used twice`);
      continue;
    }
    const seatKey = fnv1a32(u.seat);
    const clash = bySeatKey.get(seatKey);
    if (clash !== undefined) {
      err(['units', i, 'seat'], `seats "${clash}" and "${u.seat}" hash to the same stream key; rename one`);
      continue;
    }
    bySeatKey.set(seatKey, u.seat);

    let tpl: CompiledTemplate | undefined;
    if (u.use.startsWith('core:')) err(['units', i, 'use'], `${u.use} is an engine primitive, not a creature`);
    else {
      tpl = content.get(u.use);
      if (!tpl) err(['units', i, 'use'], `no creature ${u.use} in the loaded content`);
      else if (!namespaces.has(u.use.slice(0, u.use.indexOf(':')))) {
        err(['units', i, 'use'], `${u.use} isn't from any of this scenario's packs (${sc.packs.join(', ')})`);
      }
    }

    let cell = -1;
    try {
      cell = parseCell(u.at, w, h);
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      err(['units', i, 'at'], e.message);
    }
    if (cell >= 0) {
      if ((terrain[cell]! & TERR.wall) !== 0) err(['units', i, 'at'], `${u.at} is a wall`);
      const other = byCell.get(cell);
      if (other !== undefined) err(['units', i, 'at'], `${u.at} is already taken by ${other}`);
      else byCell.set(cell, u.seat);
    }

    if (tpl && u.hp !== undefined && u.hp > tpl.hpMax) warn(['units', i, 'hp'], `starting HP ${u.hp} is above ${tpl.name}'s maximum (${tpl.hpMax})`);
    if (u.fallback !== undefined && u.decider !== 'journal') warn(['units', i, 'fallback'], 'fallback only applies to the journal decider');
    // Starting slots and pool uses: the template's, with the scenario's numbers over them, capped.
    let res: number[] | undefined;
    if (tpl && u.resources) {
      const start = [...tpl.resMax];
      (u.resources.slots ?? []).forEach((n, k) => {
        const max = tpl.resMax[k] ?? 0;
        if (n > max) warn(['units', i, 'resources', 'slots', k], `${n} level ${k + 1} slots is above ${tpl.name}'s ${max}`);
        if (k < 9 && k < start.length) start[k] = Math.min(n, max);
      });
      for (const [id, n] of Object.entries(u.resources.pools ?? {})) {
        const p = tpl.pools.findIndex((x) => x.local === id);
        if (p < 0) err(['units', i, 'resources', 'pools', id], `${tpl.name} has no pool "${id}" (it has: ${tpl.pools.map((x) => x.local).join(', ') || 'none'})`);
        else start[9 + p] = Math.min(n, tpl.resMax[9 + p] ?? 0);
      }
      res = start;
    }
    if (!tpl || cell < 0) continue;

    used.push(tpl.id);
    srcIdx.push(i);
    seats.push({
      seat: u.seat,
      seatKey,
      team: u.team === 'party' ? 0 : 1,
      tpl,
      cell,
      hp: u.hp ?? null,
      ...(res ? { res } : {}),
      prone: u.prone,
      surprised: u.surprised,
      atZero: u.atZero ?? null,
      decider: u.decider,
      fallback: u.fallback ?? null,
    });
  }
  if (errors.length > 0) return done(null);

  // Precasts, once every seat has its index (docs/design/m1c.md 7.4).
  for (let n = 0; n < seats.length; n++) {
    const i = srcIdx[n]!;
    const u = sc.units[i]!;
    if (u.precast.length === 0) continue;
    if (u.surprised) warn(['units', i, 'precast'], 'a surprised creature that cast a spell before the fight: was it really caught unawares?');
    const list: PrecastSetup[] = [];
    let concs = 0;
    u.precast.forEach((pc, j) => {
      const at = (f: string) => ['units', i, 'precast', j, f];
      const r = resolvePrecast(seats, n, pc, (f, m) => err(at(f), m));
      if (!r) return;
      if (seats[n]!.tpl.spells[r.entry]!.spell.conc && ++concs === 2) err(at('cast'), 'a creature concentrates on one spell at a time; this is its second concentration precast');
      list.push(r);
    });
    seats[n] = { ...seats[n]!, precast: list };
  }
  if (errors.length > 0) return done(null);

  const scenarioHash = hash64(
    canonicalJson({
      id: sc.id,
      w,
      h,
      terrain,
      flags: hashedFlags(flags),
      knobs,
      units: seats.map((s) => ({
        seat: s.seat,
        team: s.team,
        use: s.tpl.id,
        cell: s.cell,
        hp: s.hp,
        // Only when present, so scenarios without it keep their hashes.
        ...(s.res ? { res: s.res } : {}),
        prone: s.prone,
        surprised: s.surprised,
        atZero: s.atZero,
        // Only when present, so scenarios without precasts keep their hashes.
        ...(s.precast && s.precast.length > 0
          ? { precast: s.precast.map((p) => ({ cast: s.tpl.spells[p.entry]!.spell.id, lvl: p.lvl, free: p.free, at: p.at, target: p.target < 0 ? null : seats[p.target]!.seat, choose: p.choose, elapsed: p.elapsed, seen: p.seen.map((k) => seats[k]!.seat) })) }
          : {}),
      })),
    }),
  );
  const setup: FightSetup = { scenario: sc.id, scenarioHash, contentHash: closureHash(content, used), flags, knobs, w, h, terrain, los: buildLos(w, h, terrain), seats, ...(sc.calibrated ? { calibrated: sc.calibrated } : {}), ...(sc.reportNotes ? { reportNotes: sc.reportNotes } : {}) };
  // The dynamic half of the precast checks: resolve them once on a throwaway fight (they roll no
  // dice, so seed 0 stands for every seed): slots, pools, hands, ranges, targets.
  if (seats.some((x) => x.precast && x.precast.length > 0)) {
    try {
      const pcx = createContext(setup, 0, 0, seats.map(() => NO_DECIDER), null);
      applyPassives(pcx, 0); // as runFight does: passives are up before precasts
      runPrecasts(pcx, 0);
    } catch (e) {
      if (!(e instanceof PrecastError)) throw e;
      err(['units', srcIdx[e.seat]!, 'precast', e.index], e.message);
      return done(null);
    }
  }
  return done(setup);
}

const NO_DECIDER: Decider = {
  name: 'none',
  decide: () => {
    throw new Error('a precast asked a decider');
  },
};

type PrecastSource = ScenarioSource['units'][number]['precast'][number];

/** Maps one precast entry to its resolved form, or reports what's wrong with it (`bad(field, message)`). */
function resolvePrecast(seats: readonly SeatSetup[], n: number, pc: PrecastSource, bad: (field: string, message: string) => void): PrecastSetup | null {
  const tpl = seats[n]!.tpl;
  if (pc.feature !== undefined) {
    bad('feature', "precasting a feature isn't supported yet (M1c resolves spells only)");
    return null;
  }
  const id = pc.cast!;
  const entries = tpl.spells.map((e, k) => ({ e, k })).filter((x) => x.e.spell.id === id);
  if (entries.length === 0) {
    bad('cast', `${tpl.name} has no spell ${id} prepared or granted`);
    return null;
  }
  const sp = entries[0]!.e.spell;
  let entry: number;
  let lvl: number;
  let free = false;
  if (pc.pool !== undefined) {
    const hit = entries.find((x) => x.e.freePool >= 0 && tpl.pools[x.e.freePool - 9]!.local === pc.pool);
    if (!hit) {
      bad('pool', `${id} has no free casts from a pool "${pc.pool}"`);
      return null;
    }
    entry = hit.k;
    lvl = sp.level;
    free = true;
  } else {
    const hit = entries.find((x) => x.e.slotted);
    if (!hit) {
      bad('cast', `${tpl.name} can cast ${id} only from its pool; give pool`);
      return null;
    }
    entry = hit.k;
    if (sp.level === 0) {
      if (pc.level !== undefined) bad('level', 'a cantrip spends no slot');
      lvl = 0;
    } else if (pc.level === undefined) {
      bad('level', `${id} is a level ${sp.level} spell: give the slot level (or pool)`);
      return null;
    } else if (pc.level < sp.level) {
      bad('level', `${id} can't be cast below level ${sp.level}`);
      return null;
    } else lvl = pc.level;
  }
  const e = tpl.spells[entry]!;
  const prog = e.prog[lvl];
  if (!prog) {
    bad('level', `${tpl.name} can't cast ${id} at level ${lvl}`);
    return null;
  }
  // An aimed area is refused by the dry run (sim/precast.ts).
  if (sp.areaFrom === 'bearer') {
    if (pc.at !== undefined) bad('at', `${id} is around its caster: it has no square to give`);
  } else if (sp.areaFrom === undefined) {
    if (sp.areaShape >= 0 && pc.at === undefined) bad('at', `${id} has an area: give its origin square`);
    if (sp.areaShape < 0 && pc.at !== undefined) bad('at', `${id} has no area to place`);
  }
  let target = -1;
  const targets = prog[0]?.k === 'target';
  if (targets && pc.target === undefined) bad('target', `${id} targets: give the target's seat`);
  if (!targets && pc.target !== undefined) bad('target', `${id} doesn't target a creature`);
  if (targets && pc.target !== undefined) {
    target = seats.findIndex((x) => x.seat === pc.target);
    if (target < 0) bad('target', `no seat "${pc.target}"`);
  }
  const choices = (steps: readonly Step[]): string[] =>
    steps.flatMap((x) => (x.k === 'choose' ? [...x.opts.map((o) => o.local), ...x.opts.flatMap((o) => choices(o.steps))] : x.k === 'chooseSkill' ? SKILLS.map((k) => k[0]) : []));
  const options = choices(prog);
  if (options.length > 0 && pc.choose === null) bad('choose', `${id} has a choice: give one of ${options.join(', ')}`);
  else if (options.length === 0 && pc.choose !== null) bad('choose', `${id} has no choice to make`);
  else if (pc.choose !== null && !options.includes(pc.choose)) bad('choose', `"${pc.choose}" isn't one of ${options.join(', ')}`);
  for (const m of precastProgramErrors(tpl, prog, sp.conc ? e.instance[lvl]! : -1, pc.choose, pc.elapsed)) bad('cast', `${id}: ${m}`);
  const seen: number[] = [];
  if (pc.seenBy === 'all') seats.forEach((_, k) => seen.push(k));
  else if (pc.seenBy === 'party') seats.forEach((x, k) => x.team === 0 && seen.push(k));
  else if (pc.seenBy === 'side') seats.forEach((x, k) => x.team === seats[n]!.team && seen.push(k));
  else if (Array.isArray(pc.seenBy)) {
    for (const name of pc.seenBy) {
      const k = seats.findIndex((x) => x.seat === name);
      if (k < 0) bad('seenBy', `no seat "${name}"`);
      else if (!seen.includes(k)) seen.push(k);
    }
    seen.sort((a, b) => a - b);
  }
  return { entry, lvl, free, at: pc.at ?? null, target, choose: pc.choose, elapsed: pc.elapsed, seen };
}

/** Parses and validates a journal file. */
export function parseJournal(text: string, path: string): { journal: JournalFile | null; errors: Diag[] } {
  const errors: Diag[] = [];
  const doc = toDoc(text, path, errors);
  if (!doc) return { journal: null, errors };
  const r = JournalSchema.safeParse(doc.value);
  if (!r.success) {
    errors.push(...zodDiags(doc, [], r.error));
    errors.sort(compareDiags);
    return { journal: null, errors };
  }
  return { journal: r.data, errors };
}
