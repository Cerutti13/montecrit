// Practice mode's model (PLAN.md M5): the player answers one seat's decisions and the AI plays
// everyone else. The engine stays synchronous (hard rule: no Promise in the resolution path), so
// this is play by rerun: the fight is replayed from its seed with the answers given so far, and
// stops at the first decision the player hasn't answered. One rerun is a few milliseconds.

import {
  ArraySink,
  areaCells,
  areaCellsFrom,
  GreedyDecider,
  buildFrames,
  cellName,
  makeDeciders,
  renderLog,
  runFight,
  type Decider,
  type DecisionKind,
  type DecisionPoint,
  type FightSetup,
  type GameEvent,
  type LegalKind,
  type Outcome,
  type UnitView,
  type ViewFrames,
} from '@montecrit/engine';
import { describe, statusOf, type Cost, type Status } from './describe.ts';

/** One answer: the decision's index in the fight and the legal key chosen. */
export interface Answer {
  readonly at: number;
  readonly key: string;
}

export interface AskItem {
  readonly i: number;
  readonly k: LegalKind;
  readonly key: string;
  readonly label: string;
  /** Unit index for an attack or a target; -1 otherwise. */
  readonly target: number;
  /** Cell for a move or a placement; -1 otherwise. */
  readonly cell: number;
  readonly ft: number;
  readonly provokes: number;
  readonly hazard: number;
  /** What it spends, its name without a target or level, and one line on what it does. */
  readonly cost: Cost;
  readonly name: string;
  readonly detail: string;
  /** Attacks: the chance to hit, 0..1; -1 otherwise. */
  readonly pHit: number;
  /** A spell's area placed or aimed this way: the squares it covers and the seats standing in them. */
  readonly area?: readonly number[];
  readonly caught?: readonly string[];
}

/** A decision waiting for the player. */
export interface Ask {
  readonly at: number;
  readonly kind: DecisionKind;
  readonly who: number;
  readonly seat: string;
  readonly round: number;
  readonly items: readonly AskItem[];
  /** The AI's pick for this decision (an index into items), or -1. */
  readonly suggest: number;
  /** What's asking (a spell or feature id), when the engine says. */
  readonly via: string | null;
  /** A placement that is a direction from the character (a cone, a line, a cube from itself), not a square. */
  readonly aim: boolean;
  /** What the player's character has left right now. */
  readonly status: Status;
}

class Pending extends Error {
  readonly ask: Ask;
  constructor(ask: Ask) {
    super('waiting for the player');
    this.ask = ask;
  }
}

const title = (local: string): string =>
  local
    .split(/[-_]/)
    .filter((w) => w !== '')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

/** A legal key in plain words ("attack:scimitar>boss1" -> "Scimitar at boss1"). */
export function labelOf(key: string, kind: DecisionKind): string {
  if (key === 'pass') return kind === 'turn' ? 'End turn' : 'No, pass';
  if (key === 'dodge') return 'Dodge';
  if (key === 'search') return 'Search';
  if (key === 'stand') return 'Stand up';
  const colon = key.indexOf(':');
  if (colon < 0) return title(key);
  const head = key.slice(0, colon);
  const rest = key.slice(colon + 1);
  if (head === 'attack') {
    const [atk, tgt] = rest.split('>');
    return `${title(atk ?? '')} at ${tgt ?? '?'}`;
  }
  if (head === 'cast') {
    const m = /^([^@#]+)@(\d+)(\/free)?/.exec(rest);
    if (!m) return `Cast ${title(rest)}`;
    const lvl = Number(m[2]);
    return `${title(m[1]!)}${lvl > 0 ? ` (level ${lvl}${m[3] ? ', no slot' : ''})` : ''}`;
  }
  if (head === 'move' || head === 'moveTo' || head === 'place' || head === 'pull') return rest === '-' ? 'Stop here' : rest.split('/')[0]!;
  if (head === 'target') return rest;
  if (head === 'oa') return `Opportunity attack: ${title(rest)}`;
  if (head === 'end') return `End ${title(rest)}`;
  if (head === 'item') return title(rest.replace('/', ' '));
  if (head === 'use' || head === 'opt' || head === 'first') return title(rest.split('/').slice(-2).join(' '));
  return title(rest.replace(/[/>]/g, ' '));
}

/** The eight directions an area that starts at its caster can face: the step to the next square, and the word. */
const AIM_STEPS: Readonly<Record<string, readonly [number, number, string]>> = {
  N: [0, -1, 'north'],
  NE: [1, -1, 'north-east'],
  E: [1, 0, 'east'],
  SE: [1, 1, 'south-east'],
  S: [0, 1, 'south'],
  SW: [-1, 1, 'south-west'],
  W: [-1, 0, 'west'],
  NW: [-1, -1, 'north-west'],
};

/**
 * A direction choice ("aim:NW") as a square to click: the one next to the character that way,
 * or -1 when that square is off the map (the choice is then a button). The engine's own `cell`
 * for such a choice is the direction's index, not a square.
 */
function aimOf(key: string, from: number, w: number, h: number): { cell: number; label: string } | null {
  const step = key.startsWith('aim:') ? AIM_STEPS[key.slice(4)] : undefined;
  if (!step) return null;
  const x = (from % w) + step[0];
  const y = Math.floor(from / w) + step[1];
  return { cell: x >= 0 && x < w && y >= 0 && y < h ? y * w + x : -1, label: `Aim ${step[2]}` };
}

function snapshot(view: UnitView, dp: DecisionPoint, suggest: number): Ask {
  const items: AskItem[] = [];
  const { w, h } = view.q.setup;
  const from = view.q.units[dp.who]!.cell;
  let aimed = false;
  // The area a placement would cover: the asking spell's shape, from the engine's own masks.
  const shape = dp.k === 'place' && dp.src ? (view.q.units[dp.who]!.tpl.spells.find((e) => e.spell.id === dp.src!.via)?.spell.areaShape ?? -1) : -1;
  const areaOf = (key: string, at: number): { area: number[]; caught: string[] } | null => {
    if (shape < 0) return null;
    const area: number[] = [];
    if (key.startsWith('aim:')) areaCellsFrom(view.q, shape, from, at, area);
    else if (key.startsWith('place:')) areaCells(view.q, shape, at, area);
    else return null;
    return { area, caught: view.q.units.filter((u) => u.life !== 'dead' && area.includes(u.cell)).map((u) => u.seat) };
  };
  for (let i = 0; i < dp.legal.n; i++) {
    const l = dp.legal.items[i]!;
    const key = dp.keyOf(i);
    const aim = aimOf(key, from, w, h);
    if (aim) aimed = true;
    const label = aim ? aim.label : labelOf(key, dp.k);
    const d = describe(view, dp, l, label);
    items.push({ i, k: l.k, key, label, cost: d.cost, name: d.name, detail: d.detail, pHit: d.pHit, target: l.k === 'attack' || l.k === 'target' || l.k === 'react' ? l.target : -1, cell: aim ? aim.cell : l.k === 'move' || l.k === 'place' || l.k === 'pull' ? l.cell : -1, ft: l.ft, provokes: l.provokes, hazard: l.hazard, ...(l.k === 'place' ? (areaOf(key, l.cell) ?? {}) : {}) });
  }
  return { at: dp.at, kind: dp.k, who: dp.who, seat: view.q.units[dp.who]!.seat, round: dp.round, items, suggest, via: dp.src?.via ?? dp.rollVia ?? dp.hit?.via ?? null, aim: aimed, status: statusOf(view, dp.who) };
}

/** Decision kinds the player may hand to the AI (they open at almost every roll nearby). */
export const ROLL_WINDOWS: readonly DecisionKind[] = ['preRoll', 'orderTriggers'];

class HumanDecider implements Decider {
  readonly name = 'human';
  lastBy = 'human';
  private readonly answers: ReadonlyMap<number, string>;
  private readonly helper: Decider;
  private readonly auto: ReadonlySet<DecisionKind>;
  constructor(answers: readonly Answer[], helper: Decider, auto: readonly DecisionKind[]) {
    this.answers = new Map(answers.map((a) => [a.at, a.key]));
    this.helper = helper;
    this.auto = new Set(auto);
  }
  decide(view: UnitView, dp: DecisionPoint): number {
    const key = this.answers.get(dp.at);
    if (key !== undefined) {
      const i = dp.indexOfKey ? dp.indexOfKey(key) : indexOf(dp, key);
      if (i < 0) throw new RangeError(`"${key}" isn't legal at decision ${dp.at}`);
      this.lastBy = 'human';
      return i;
    }
    if (this.auto.has(dp.k)) {
      this.lastBy = this.helper.name;
      return this.helper.decide(view, dp);
    }
    let suggest = -1;
    try {
      suggest = this.helper.decide(view, dp);
    } catch {
      suggest = -1;
    }
    throw new Pending(snapshot(view, dp, suggest));
  }
}

function indexOf(dp: DecisionPoint, key: string): number {
  for (let i = 0; i < dp.legal.n; i++) if (dp.keyOf(i) === key) return i;
  return -1;
}

export interface PracticeOptions {
  readonly seed: number;
  /** The seat the player plays (an index into setup.seats). */
  readonly seat: number;
  /** Decision kinds the AI answers for the player. */
  readonly auto: readonly DecisionKind[];
}

export interface Step {
  readonly events: readonly GameEvent[];
  readonly view: ViewFrames;
  readonly lines: readonly string[];
  /** The decision waiting for the player, or null when the fight is over (or failed). */
  readonly ask: Ask | null;
  readonly outcome: Outcome | null;
  readonly error: string | null;
}

/** Replays the fight with the player's answers so far, up to the next unanswered decision. */
export function step(setup: FightSetup, o: PracticeOptions, answers: readonly Answer[]): Step {
  const deciders = makeDeciders(setup).map((d, i) => (i === o.seat ? new HumanDecider(answers, new GreedyDecider(), o.auto) : d));
  const sink = new ArraySink();
  let ask: Ask | null = null;
  let outcome: Outcome | null = null;
  let error: string | null = null;
  try {
    outcome = runFight(setup, o.seed, 0, deciders, sink, { policy: deciders.map((d) => d.name) }).outcome;
  } catch (e) {
    if (e instanceof Pending) ask = e.ask;
    else error = e instanceof Error ? e.message : String(e);
  }
  const events = sink.events;
  return { events, view: buildFrames(setup, events, null), lines: renderLog(events, setup), ask, outcome, error };
}

export interface CellChoice {
  readonly cell: number;
  /** The item a click on this cell picks. */
  readonly i: number;
  readonly risky: boolean;
  readonly title: string;
}

/**
 * The cells a click can choose: one per destination or anchor. A move that reaches the same
 * square several ways offers the safest (fewest opportunity attacks, then least hazard, then
 * shortest).
 */
export function cellChoices(ask: Ask, w: number): CellChoice[] {
  const best = new Map<number, AskItem>();
  for (const it of ask.items) {
    if (it.cell < 0) continue;
    const cur = best.get(it.cell);
    if (!cur || it.provokes < cur.provokes || (it.provokes === cur.provokes && (it.hazard < cur.hazard || (it.hazard === cur.hazard && it.ft < cur.ft)))) best.set(it.cell, it);
  }
  return [...best.values()].map((it) => {
    const parts = [ask.aim ? it.label : cellName(it.cell, w)];
    if (it.k === 'move') {
      if (it.ft >= 0) parts.push(`${it.ft} ft`);
      if (it.provokes > 0) parts.push(`provokes ${it.provokes} opportunity attack${it.provokes > 1 ? 's' : ''}`);
      if (it.hazard > 0) parts.push('crosses a hazard');
    }
    if (it.caught) parts.push(it.caught.length > 0 ? `catches ${it.caught.join(', ')}` : 'catches no one');
    return { cell: it.cell, i: it.i, risky: it.provokes > 0 || it.hazard > 0, title: parts.join(', ') };
  });
}

/** One way to take a choice: a target of an attack, a level of a spell, or the choice itself. */
export interface Variant {
  readonly it: AskItem;
  /** The button's text: a seat with its hit chance, "L2", or '' when the row has one way. */
  readonly tag: string;
}

/** One choice as the panel shows it: a name, what it does, and the ways to take it. */
export interface Row {
  readonly name: string;
  readonly detail: string;
  readonly variants: readonly Variant[];
}

export interface Section {
  readonly title: string;
  readonly rows: readonly Row[];
}

const SECTIONS: readonly Cost[] = ['Action', 'Bonus action', 'Reaction', 'Free', ''];

/**
 * The choices that aren't squares on the map, grouped by what they spend. An attack is one row
 * with a button per target; a spell is one row with a button per slot level. End turn is left
 * out: the panel gives it its own button.
 */
export function sections(ask: Ask, seatOf: (unit: number) => string): Section[] {
  const by = new Map<Cost, Row[]>();
  for (const it of ask.items) {
    if (it.cell >= 0) continue;
    if (ask.kind === 'turn' && it.k === 'pass') continue;
    const rows = by.get(it.cost) ?? [];
    by.set(it.cost, rows);
    let tag = '';
    if (it.k === 'attack' || it.k === 'oa') tag = `${it.target >= 0 ? seatOf(it.target) : '?'}${it.pHit >= 0 ? ` ${Math.round(it.pHit * 100)}%` : ''}`;
    else if (it.k === 'cast') {
      const m = /@(\d+)(\/free)?/.exec(it.key);
      tag = m && Number(m[1]) > 0 ? `L${m[1]}${m[2] ? ' free' : ''}` : '';
    }
    const row = tag !== '' ? rows.find((r) => r.name === it.name && r.variants[0]!.it.k === it.k) : undefined;
    if (row) (row.variants as Variant[]).push({ it, tag });
    else rows.push({ name: it.name, detail: it.detail.replace(/^free cast, no slot · /, ''), variants: [{ it, tag }] });
  }
  const title = (c: Cost): string => (c !== '' ? c : ask.kind === 'turn' ? 'Other' : 'Your choices');
  return SECTIONS.filter((c) => by.has(c)).map((c) => ({ title: title(c), rows: by.get(c)! }));
}

/** The End turn item of a turn decision, or null. */
export const endTurn = (ask: Ask): AskItem | null => (ask.kind === 'turn' ? (ask.items.find((it) => it.k === 'pass') ?? null) : null);

/** What the engine is asking, in plain words. */
export function askTitle(ask: Ask): string {
  const via = ask.via ? title(ask.via.slice(ask.via.indexOf(':') + 1).split('/')[0]!) : '';
  switch (ask.kind) {
    case 'turn':
      return 'Your turn';
    case 'reaction':
      return 'Opportunity attack?';
    case 'target':
      return `Pick a target${via ? ` for ${via}` : ''}`;
    case 'place':
      return ask.aim ? `Pick which way ${via || 'it'} faces` : `Pick where ${via || 'it'} goes`;
    case 'pick':
      return `Choose${via ? ` for ${via}` : ''}`;
    case 'pull':
      return 'Pick where it gets pulled';
    case 'preRoll':
      return `React before this roll${via ? ` (${via})` : ''}?`;
    case 'rider':
      return `Add ${via || 'a rider'} to this attack?`;
    case 'hitTaken':
    case 'hitKnown':
    case 'damageTaken':
    case 'attackDeclared':
      return 'React to this attack?';
    case 'firstAttack':
      return 'Use this on your first attack?';
    case 'moveTo':
      return 'Take the free move?';
    case 'orderTriggers':
      return 'Which effect resolves first?';
  }
}

/** A line under the title on what to do, for the prompts that aren't a plain turn. */
export function askHelp(ask: Ask): string {
  switch (ask.kind) {
    case 'turn':
      return 'You get one Action, one Bonus action and your movement each turn, in any order.';
    case 'reaction':
      return 'A foe is leaving your reach. Attacking spends your Reaction for the round.';
    case 'target':
      return 'Click a ringed token on the map, or pick below.';
    case 'place':
      return ask.aim ? 'Click a highlighted square next to you to aim that way: the area starts at you and spreads in that direction.' : 'Click a highlighted square on the map.';
    case 'preRoll':
    case 'hitTaken':
    case 'hitKnown':
    case 'damageTaken':
    case 'attackDeclared':
      return 'Using it spends your Reaction for the round.';
    default:
      return '';
  }
}
