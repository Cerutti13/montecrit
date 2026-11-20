// Distances, step costs and reachability on the 5-ft grid (SRD 5.2.1 p.13-14).
//
// - Entering any adjacent square costs 5 ft, diagonals included (diagonalCost=uniform), or
//   5/10 alternating under the DMG option. Difficult Terrain adds 5 ft per square; crawling
//   (Prone) adds another 5, so crawling through Difficult Terrain costs 15.
// - You can pass through an ally, an Incapacitated creature, a Tiny creature, or one at least
//   two sizes different; any other creature blocks you. A creature's space is Difficult
//   Terrain unless it's your ally or Tiny. You can't end a move in an occupied square.
// - A diagonal can't cut the corner of a wall (diagonalCorner says which squares count).
//
// reach() runs Dijkstra over states (cell, provokes, hazard, parity), where provokes counts how
// many hostile reactors' reach the path leaves (capped at 3; an upper bound on opportunity
// attacks, since each reactor has one reaction). Destinations come out as Pareto labels: for
// each square, the cheapest route at each provoke count that's strictly cheaper than every
// route provoking less. So a decider sees the safe long way beside the short way that
// provokes. Queries only: no dice, no state writes.
//
// A scratch remembers a signature of every input its last computeReach read (the mover, its
// budget, conditions and parity, the zones it knows, every unit's square and the states that
// decide passing and reacting, the zone masks and corpses). A call whose signature matches reuses the result: the
// common case is listing a turn's moves and then resolving the chosen one. The comparison is
// element by element, so it can't collide.

import { losOf, seesCell } from '../sim/cover.ts';
import { SIZES } from '../content/types.ts';
import { MAX_H, MAX_W, TERR } from './cells.ts';
import { canWield, COND, has, readFlag, zoneSpares, type QueryState, type Unit } from '../sim/state.ts';
import { boundOf } from '../sim/effects.ts';
import { charmedBy, fearCells, noOpportunityAttacks } from '../sim/stats.ts';

export const INF = 0x3fffffff;
const TINY = SIZES.indexOf('tiny');
/** N, E, S, W, NE, SE, SW, NW: fixed, so ties always break the same way. */
export const DX = [0, 1, 0, -1, 1, 1, -1, -1];
export const DY = [-1, 0, 1, 0, -1, 1, 1, -1];
export const MAX_PROVOKES = 3;

/** Distance in feet between two cells, by the active diagonal rule. Used for reach and range too. */
export function distFt(st: QueryState, a: number, b: number): number {
  const w = st.setup.w;
  const dx = Math.abs((a % w) - (b % w));
  const dy = Math.abs(Math.floor(a / w) - Math.floor(b / w));
  const hi = Math.max(dx, dy);
  const lo = Math.min(dx, dy);
  // Counting a long diagonal range at one square per step is an inference from the movement rule (p.13).
  return readFlag(st, 'diagonalCost') === 'alternate' ? 5 * (hi + Math.floor(lo / 2)) : 5 * hi;
}

export function hostile(a: Unit, b: Unit): boolean {
  return a.team !== b.team;
}

/** Whether `mover` may pass through `o`'s space during a move. */
export function canPass(mover: Unit, o: Unit): boolean {
  if (mover.team === o.team) return true;
  if (has(o, COND.incapacitated)) return true;
  if (o.tpl.size === TINY) return true;
  return Math.abs(mover.tpl.size - o.tpl.size) >= 2;
}

/** Whether `o`'s space is Difficult Terrain for `mover`. */
export function spaceIsDifficult(mover: Unit, o: Unit): boolean {
  return mover.team !== o.team && o.tpl.size !== TINY;
}

/** Bits describing one cell for one mover, from live state. */
export const CELL = { occupied: 1, blocked: 2, difficult: 4 } as const;

/** `skip`: a unit to treat as absent (a decider planning around where a creature will have moved from). */
export function cellInfo(st: QueryState, mover: Unit, cell: number, skip: Unit | null = null): number {
  let bits = 0;
  if (st.setup.terrain[cell]! & TERR.difficult) bits |= CELL.difficult;
  if (readFlag(st, 'corpseSpace') === 'difficult' && st.corpses[cell]! > 0) bits |= CELL.difficult;
  if (st.zoneMask[cell]! & st.diffBits) bits |= CELL.difficult; // a zone's Difficult Terrain (never stacks)
  for (const o of st.units) {
    if (o === mover || o === skip || o.life === 'dead' || o.cell !== cell) continue;
    bits |= CELL.occupied;
    if (!canPass(mover, o)) bits |= CELL.blocked;
    if (spaceIsDifficult(mover, o)) bits |= CELL.difficult;
  }
  return bits;
}

/** Cost in feet of stepping from `from` to the adjacent `to`, or INF. `info` is cellInfo(to). */
export function stepCost(st: QueryState, mover: Unit, from: number, to: number, parity: number, info: number): number {
  const { w, h, terrain } = st.setup;
  const fx = from % w;
  const fy = Math.floor(from / w);
  const tx = to % w;
  const ty = Math.floor(to / w);
  if (tx < 0 || tx >= w || ty < 0 || ty >= h) return INF;
  if (terrain[to]! & TERR.wall) return INF;
  if (info & CELL.blocked) return INF;
  const diagonal = fx !== tx && fy !== ty;
  if (diagonal) {
    const wallA = (terrain[fy * w + tx]! & TERR.wall) !== 0;
    const wallB = (terrain[ty * w + fx]! & TERR.wall) !== 0;
    const blocked = readFlag(st, 'diagonalCorner') === 'eitherBlocks' ? wallA || wallB : wallA && wallB;
    if (blocked) return INF;
  }
  const base = diagonal && readFlag(st, 'diagonalCost') === 'alternate' && parity === 1 ? 10 : 5;
  const difficult = (info & CELL.difficult) !== 0 ? 1 : 0;
  const crawl = has(mover, COND.prone) ? 1 : 0;
  return base * (1 + difficult + crawl);
}

/** terrainFieldFt's figure for a square no walk reaches: past any budget. */
export const FIELD_NONE = 0x3fffffff;

/**
 * Coverage 8'b review (ai-logic-3): feet of walking from every square to `to` (or to the nearest of
 * several), round walls and paying for Difficult Terrain, with no creature or zone in the way (those
 * move; the AI's read of next turn). The corner and diagonal rules are stepCost's. Unreachable:
 * FIELD_NONE. Queries only.
 */
export function terrainFieldFt(st: QueryState, to: number | readonly number[]): Int32Array {
  const { w, h, terrain } = st.setup;
  const cells = w * h;
  const alt = readFlag(st, 'diagonalCost') === 'alternate';
  const eitherBlocks = readFlag(st, 'diagonalCorner') === 'eitherBlocks';
  // Per square and diagonal parity: a walk starts at parity 0, and the field runs from the target end,
  // so a square's figure is the better parity's [U: read from the target's end under the alternating rule].
  const d = new Int32Array(cells * 2).fill(FIELD_NONE);
  const queue: number[] = [];
  for (const c of typeof to === 'number' ? [to] : to) {
    d[c * 2] = 0;
    queue.push(c * 2);
  }
  for (let q = 0; q < queue.length; q++) {
    const s = queue[q]!;
    const c = s >> 1;
    const par = s & 1;
    const cx = c % w;
    const cy = Math.floor(c / w);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const n = ny * w + nx;
        if (terrain[n]! & TERR.wall) continue;
        const diagonal = dx !== 0 && dy !== 0;
        if (diagonal) {
          const wallA = (terrain[cy * w + nx]! & TERR.wall) !== 0;
          const wallB = (terrain[ny * w + cx]! & TERR.wall) !== 0;
          if (eitherBlocks ? wallA || wallB : wallA && wallB) continue;
        }
        const base = diagonal && alt && par === 1 ? 10 : 5;
        // Entering `c` from `n` is what's paid walking towards the target.
        const cost = base * ((terrain[c]! & TERR.difficult) !== 0 ? 2 : 1);
        const np = diagonal && alt ? par ^ 1 : par;
        const key = n * 2 + np;
        const nd = d[s]! + cost;
        if (nd < d[key]!) {
          d[key] = nd;
          queue.push(key);
        }
      }
    }
  }
  const out = new Int32Array(cells);
  for (let c = 0; c < cells; c++) out[c] = Math.min(d[c * 2]!, d[c * 2 + 1]!);
  return out;
}

export function nextParity(st: QueryState, from: number, to: number, parity: number): number {
  const w = st.setup.w;
  const diagonal = from % w !== to % w && Math.floor(from / w) !== Math.floor(to / w);
  return diagonal && readFlag(st, 'diagonalCost') === 'alternate' ? parity ^ 1 : parity;
}

/** Unit's longest usable melee reach (gear that ran out doesn't count); 0 if none. */
export function oaReach(st: QueryState, u: Unit): number {
  let best = 0;
  for (const a of u.tpl.attacks) {
    if (a.kind !== 'melee' || !gearOk(st, u, a.gear) || !canWield(u, a)) continue;
    if (a.reachFt > best) best = a.reachFt;
  }
  return best;
}

export function gearOk(st: QueryState, u: Unit, gear: number): boolean {
  if (gear < 0) return true;
  const n = u.gear[gear]!;
  if (n < 0) return true;
  if (!u.isPc && readFlag(st, 'monsterThrownWeapons') === 'unlimited') return true;
  return n > 0;
}

/** Step E (E2): whether one of `u`'s own thrown pieces of gear `gear` lies on `cell`. */
export function pieceAt(u: Unit, gear: number, cell: number): boolean {
  for (let i = 0; i < u.landed.length; i++) if (u.landGear[i] === gear && u.landed[i] === cell) return true;
  return false;
}

/** Step E (E2): how many of `u`'s own thrown pieces of gear `gear` are on the ground. */
export function piecesOf(u: Unit, gear: number): number {
  let n = 0;
  for (let i = 0; i < u.landed.length; i++) if (u.landGear[i] === gear && u.landed[i]! >= 0) n++;
  return n;
}

/**
 * Step E (E2): whether an Attack-action strike from `cell` could use gear `gear`: carried
 * (gearOk), or, for a monster, one of its own landed pieces on that square, which the strike's
 * equip picks up (srd-raw.txt:32707-32712). Not for opportunity attacks: they aren't the Attack
 * action, so they carry no equip (those sites keep gearOk).
 */
export function gearReady(st: QueryState, u: Unit, gear: number, cell: number): boolean {
  return gearOk(st, u, gear) || (!u.isPc && gear >= 0 && pieceAt(u, gear, cell));
}

/** A unit that could make an opportunity attack against `mover` right now (line of sight is checked where the reach is: walker.ts, computeReach). */
export function canReactAgainst(st: QueryState, r: Unit, mover: Unit): boolean {
  if (!(r !== mover && hostile(r, mover) && r.life === 'up' && !has(r, COND.incapacitated) && r.b.reaction > 0 && oaReach(st, r) > 0)) return false;
  // M3 step 4: a noOpportunityAttacks stat; Charmed can't attack the charmer (SRD 5.2.1 Charmed, srd-raw.txt:32957-32958).
  if (r.stats.length > 0 && noOpportunityAttacks(st, r)) return false;
  return !charmedBy(r, mover);
}

export interface ReachScratch {
  cells: number;
  par: number;
  readonly ft: Int32Array;
  readonly prev: Int32Array;
  readonly heap: Int32Array;
  heapN: number;
  readonly info: Uint8Array;
  readonly threatLo: Uint32Array;
  readonly threatHi: Uint32Array;
  /** Unit this scratch was last computed for (-1 none). */
  unit: number;
  readonly path: Int32Array;
  /** computeReach calls and how many the signature cache answered (perf counters; never read by the engine). */
  calls: number;
  hits: number;
  /** Hazard levels in use: 1 while no hazard zone is live, else MAX_HAZARD + 1. */
  hzN: number;
  /** States the last computeReach wrote; only these are reset next time (every other state stays INF / -1). */
  readonly touched: Int32Array;
  nTouched: number;
  /** Cells the last computeReach reached, ascending (forEachLabel scans only these). */
  readonly reached: Int32Array;
  nReached: number;
  readonly cellMark: Uint8Array;
  /** forEachLabel's running minimum over dominated states. */
  readonly dom: Int32Array;
  /** false turns the signature cache off (tests compare both ways). */
  readonly cache: boolean;
  sig: Int32Array;
  /** Length of the cached signature; -1 when nothing is cached. */
  sigN: number;
  sigK: number;
  sigSame: boolean;
  /** Cells of the mover's living sources of fear (Frightened: no willing step closer). */
  readonly fear: number[];
}

export function newReachScratch(cells: number, cache = true): ReachScratch {
  const states = cells * (MAX_PROVOKES + 1) * (MAX_HAZARD + 1) * 2;
  return {
    cells,
    par: 1,
    ft: new Int32Array(states).fill(INF),
    prev: new Int32Array(states).fill(-1),
    heap: new Int32Array(states * 8 + 8),
    heapN: 0,
    info: new Uint8Array(cells),
    threatLo: new Uint32Array(cells),
    threatHi: new Uint32Array(cells),
    unit: -1,
    path: new Int32Array(cells * 4),
    calls: 0,
    hits: 0,
    hzN: 1,
    touched: new Int32Array(states),
    nTouched: 0,
    reached: new Int32Array(cells),
    nReached: 0,
    cellMark: new Uint8Array(cells),
    dom: new Int32Array((MAX_PROVOKES + 1) * (MAX_HAZARD + 1)),
    cache,
    sig: new Int32Array(16 + cells),
    sigN: -1,
    sigK: 0,
    sigSame: false,
    fear: [],
  };
}

/** Forgets the cached result (a new fight). */
export function resetReachCache(sc: ReachScratch): void {
  sc.sigN = -1;
  sc.unit = -1;
}

/**
 * Known zone hazards a route crosses, capped: each zone with an enter trigger it enters, plus
 * each 5-ft step inside a per-distance damage zone. A Pareto dimension like provokes, so a
 * longer route around Moonbeam or through less of Spike Growth stays on offer. The cap is 7:
 * under the default area flags a 20-ft sphere is a 7x7 block minus its corners, so a crossing
 * takes at most 7 squares and a 4-square route never merges with an 8-square one (m1c
 * critique #4). Only zones the mover knows count (knownZones).
 */
export const MAX_HAZARD = 7;

const PH = (MAX_PROVOKES + 1) * (MAX_HAZARD + 1) * 2;
const stateOf = (cell: number, p: number, hz: number, parity: number) => ((cell * (MAX_PROVOKES + 1) + p) * (MAX_HAZARD + 1) + hz) * 2 + parity;
const cellOfState = (s: number) => Math.floor(s / PH);
const provokesOfState = (s: number) => Math.floor(s / ((MAX_HAZARD + 1) * 2)) % (MAX_PROVOKES + 1);
const hazardOfState = (s: number) => Math.floor(s / 2) % (MAX_HAZARD + 1);

function popcount(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24) & 0xff;
}

// Heap entries are immutable keys ft * KEY + state, so a later improvement never reorders an
// entry already queued; stale entries are skipped when popped (lazy deletion).
const KEY = 1 << 18;
if (MAX_W * MAX_H * PH > KEY) throw new Error('reach: KEY must exceed the state count');

function heapPush(sc: ReachScratch, key: number): void {
  let i = sc.heapN++;
  if (i >= sc.heap.length) throw new RangeError('reach heap overflow');
  sc.heap[i] = key;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (sc.heap[p]! <= sc.heap[i]!) break;
    const t = sc.heap[p]!;
    sc.heap[p] = sc.heap[i]!;
    sc.heap[i] = t;
    i = p;
  }
}

function heapPop(sc: ReachScratch): number {
  const top = sc.heap[0]!;
  const last = sc.heap[--sc.heapN]!;
  if (sc.heapN > 0) {
    sc.heap[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < sc.heapN && sc.heap[l]! < sc.heap[m]!) m = l;
      if (r < sc.heapN && sc.heap[r]! < sc.heap[m]!) m = r;
      if (m === i) break;
      const t = sc.heap[m]!;
      sc.heap[m] = sc.heap[i]!;
      sc.heap[i] = t;
      i = m;
    }
  }
  return top;
}

/**
 * Fills `sc` with every state reachable by `u` within `budgetFt`, honoring live state.
 * The heap is sized for one entry per relaxation that improves a state.
 */
function sigPut(sc: ReachScratch, v: number): void {
  if (sc.sigSame && sc.sig[sc.sigK] !== v) sc.sigSame = false;
  sc.sig[sc.sigK++] = v;
}

/** Writes the signature of computeReach's inputs; true if it equals the cached one. Flags and terrain are fixed for a fight. */
function sameInputs(st: QueryState, u: Unit, budgetFt: number, sc: ReachScratch, corpseDiff: boolean, known: number, diffBits: number): boolean {
  const units = st.units;
  const n = st.setup.w * st.setup.h;
  const need = 10 + units.length * 4 + n * (corpseDiff ? 2 : 1);
  if (sc.sig.length < need) {
    sc.sig = new Int32Array(need);
    sc.sigN = -1;
  }
  sc.sigK = 0;
  sc.sigSame = sc.sigN >= 0;
  sigPut(sc, u.idx);
  sigPut(sc, budgetFt);
  sigPut(sc, u.b.diagParity);
  sigPut(sc, st.active === u.idx && u.b.refusedFrom === u.cell ? u.b.refused : 0);
  sigPut(sc, (has(u, COND.disengaged) ? 1 : 0) | (has(u, COND.prone) ? 2 : 0) | (has(u, COND.frightened) ? 4 : 0));
  if (has(u, COND.frightened)) for (const c of fearCells(st, u, sc.fear)) sigPut(sc, c);
  sigPut(sc, st.enterBits);
  sigPut(sc, st.travelBits);
  sigPut(sc, diffBits);
  sigPut(sc, known);
  for (const o of units) {
    sigPut(sc, o.cell);
    sigPut(sc, (o.life === 'dead' ? 1 : 0) | (has(o, COND.incapacitated) ? 2 : 0));
    sigPut(sc, canReactAgainst(st, o, u) ? oaReach(st, o) : -1);
  }
  const zm = st.zoneMask;
  for (let c = 0; c < n; c++) sigPut(sc, zm[c]!);
  if (corpseDiff) for (let c = 0; c < n; c++) sigPut(sc, st.corpses[c]!);
  const same = sc.sigSame && sc.sigK === sc.sigN;
  sc.sigN = sc.sigK;
  return same;
}

/**
 * Zone slots `u` counts as hazards when it plans a move, under zoneKnowledge: sawCast, a hidden
 * zone it saw appear or recognized and any other zone it can see a square of (coverage step 9; its
 * own always); every zone; or only its own. A zone whose `affects` spares `u` is no
 * hazard to it (coverage step 7.3), and neither is a zone around `u` itself, which moves with it (7.5). A query: it reads the flag without marking it; listOptions
 * marks it where it can change the list.
 */
export function knownZones(st: QueryState, u: Unit): number {
  const mode = readFlag(st, 'zoneKnowledge');
  let m = mode === 'all' ? -1 : 0;
  for (let z = 0; z < 32; z++) {
    const id = st.zoneFx[z]!;
    if (id < 0) continue;
    const fx = st.fx[id]!;
    const zone = boundOf(st, fx).zone!;
    if ((zone.from === 'bearer' && fx.owner === u.idx) || (zone.affects !== undefined && zoneSpares(zone.affects, st.units[fx.owner]!, u))) {
      m &= ~(1 << z);
      continue;
    }
    if (mode === 'all') continue;
    // A Blinded creature can't see (srd-raw.txt:32740-32742), so it learns no zone by sight.
    if (fx.owner === u.idx || (mode === 'sawCast' && ((fx.seen !== null && fx.seen[u.idx] === 1) || (fx.hdc < 0 && !has(u, COND.blinded) && seesZone(st, u.cell, z))))) m |= 1 << z;
  }
  return m;
}

/**
 * Coverage step 9 review: zone slots of hidden zones `u` doesn't know under zoneKnowledge sawCast
 * (not its own, not seen appear, not recognized). Their Difficult Terrain is camouflaged too, so
 * the planner (computeReach) prices those squares as plain ground; the walker (cellInfo, stepCost)
 * still charges the real cost, so a walk planned through them ends short. Under all and none
 * nothing is masked (their meaning predates step 9). A query: the flag is read, not marked.
 */
export function hiddenUnknownZones(st: QueryState, u: Unit): number {
  if (st.diffBits === 0 || readFlag(st, 'zoneKnowledge') !== 'sawCast') return 0;
  let m = 0;
  for (let z = 0; z < 32; z++) {
    const id = st.zoneFx[z]!;
    if (id < 0) continue;
    const fx = st.fx[id]!;
    if (fx.hdc >= 0 && fx.owner !== u.idx && (fx.seen === null || fx.seen[u.idx] !== 1)) m |= 1 << z;
  }
  return m;
}

/**
 * Coverage step 9, zoneKnowledge sawCast: a zone that isn't hidden is plain to see, so anyone with
 * line of sight to one of its squares knows it (always true on a map with no walls, or under
 * losMethod=stubbed). A hidden one is known only to whoever saw it appear or recognized it (fx.seen).
 */
export function seesZone(st: QueryState, from: number, z: number): boolean {
  if (st.setup.flags.losMethod === 'stubbed' || !losOf(st.setup).walls) return true; // seesCell's own answer for every square
  const zm = st.zoneMask;
  const bit = 1 << z;
  const n = st.setup.w * st.setup.h;
  for (let c = 0; c < n; c++) if (zm[c]! & bit && seesCell(st, from, c, null)) return true;
  return false;
}

/** `extraKnown` (coverage step 9, the greedy AI's Search value): zone slots to count as known on top of knownZones; 0 everywhere else. */
export function computeReach(st: QueryState, u: Unit, budgetFt: number, sc: ReachScratch, extraKnown = 0): void {
  sc.calls++;
  const corpseDiff = readFlag(st, 'corpseSpace') === 'difficult';
  const known = (st.enterBits | st.travelBits) === 0 ? 0 : knownZones(st, u) | extraKnown;
  // Coverage step 9 review: a hidden zone it doesn't know is no Difficult Terrain to its planning.
  const db = st.diffBits & ~(hiddenUnknownZones(st, u) & ~extraKnown);
  if (sc.cache) {
    if (sameInputs(st, u, budgetFt, sc, corpseDiff, known, db) && sc.unit === u.idx) {
      sc.hits++;
      return;
    }
  } else sc.sigN = -1;
  const n = st.setup.w * st.setup.h;
  const w = st.setup.w;
  const h = st.setup.h;
  const terr = st.setup.terrain;
  const zm = st.zoneMask;
  sc.cells = n;
  const alt = readFlag(st, 'diagonalCost') === 'alternate';
  sc.par = alt ? 2 : 1;
  sc.unit = u.idx;
  for (let i = 0; i < sc.nTouched; i++) {
    const t = sc.touched[i]!;
    sc.ft[t] = INF;
    sc.prev[t] = -1;
  }
  sc.nTouched = 0;
  sc.heapN = 0;
  // cellInfo for every square, in O(cells + units) (with db, the zones' Difficult Terrain it knows of).
  for (let c = 0; c < n; c++) {
    let bits = 0;
    if (terr[c]! & TERR.difficult) bits |= CELL.difficult;
    if (corpseDiff && st.corpses[c]! > 0) bits |= CELL.difficult;
    if (zm[c]! & db) bits |= CELL.difficult; // a zone's Difficult Terrain (never stacks)
    sc.info[c] = bits;
  }
  for (const o of st.units) {
    if (o === u || o.life === 'dead') continue;
    let bits = CELL.occupied;
    if (!canPass(u, o)) bits |= CELL.blocked;
    if (spaceIsDifficult(u, o)) bits |= CELL.difficult;
    sc.info[o.cell] = sc.info[o.cell]! | bits;
  }
  if (u.b.refused !== 0 && st.active === u.idx && u.b.refusedFrom === u.cell) {
    // walker.ts refuseFirst: first steps from here its walks were refused this turn.
    const ux = u.cell % w;
    const uy = Math.floor(u.cell / w);
    for (let k = 0; k < 9; k++) {
      if (!(u.b.refused & (1 << k))) continue;
      const x = ux + (k % 3) - 1;
      const y = uy + Math.floor(k / 3) - 1;
      if (x >= 0 && x < w && y >= 0 && y < st.setup.h) sc.info[y * w + x] = sc.info[y * w + x]! | CELL.blocked;
    }
  }
  sc.threatLo.fill(0, 0, n);
  sc.threatHi.fill(0, 0, n);
  if (!has(u, COND.disengaged)) {
    // M3 step 8: a reactor threatens only the squares it can see (opportunity attacks, srd-raw.txt:2096-2097).
    const walls = st.setup.flags.losMethod !== 'stubbed' && losOf(st.setup).walls;
    for (const r of st.units) {
      if (!canReactAgainst(st, r, u)) continue;
      const reachFt = oaReach(st, r);
      // distFt >= 5 * max(dx, dy) under both diagonal rules, so nothing outside this box is in reach.
      const rad = Math.floor(reachFt / 5);
      const rx = r.cell % w;
      const ry = Math.floor(r.cell / w);
      for (let y = Math.max(0, ry - rad); y <= Math.min(h - 1, ry + rad); y++) {
        for (let x = Math.max(0, rx - rad); x <= Math.min(w - 1, rx + rad); x++) {
          const c = y * w + x;
          if (distFt(st, r.cell, c) > reachFt || (walls && !seesCell(st, r.cell, c, null))) continue;
          if (r.idx < 32) sc.threatLo[c]! |= 1 << r.idx;
          else sc.threatHi[c]! |= 1 << (r.idx - 32);
        }
      }
    }
  }
  // stepCost and nextParity inlined, with their flags read once.
  const eitherBlocks = readFlag(st, 'diagonalCorner') === 'eitherBlocks';
  const crawl = has(u, COND.prone) ? 1 : 0;
  // Frightened: "You can't willingly move closer to the source of fear" (SRD 5.2.1, srd-raw.txt:33478-33479), step by step.
  const fear = fearCells(st, u, sc.fear);
  const start = stateOf(u.cell, 0, 0, alt ? u.b.diagParity : 0);
  const enter = st.enterBits & known;
  const travel = st.travelBits & known;
  sc.hzN = enter === 0 && travel === 0 ? 1 : MAX_HAZARD + 1;
  const H1 = MAX_HAZARD + 1;
  sc.ft[start] = 0;
  sc.touched[sc.nTouched++] = start;
  heapPush(sc, start);
  while (sc.heapN > 0) {
    const key = heapPop(sc);
    const s = key % KEY;
    if (Math.floor(key / KEY) > sc.ft[s]!) continue; // stale
    const c = cellOfState(s);
    const p = provokesOfState(s);
    const hz = hazardOfState(s);
    const parity = s % 2;
    const f = sc.ft[s]!;
    const x = c % w;
    const y = Math.floor(c / w);
    for (let d = 0; d < 8; d++) {
      const nx = x + DX[d]!;
      const ny = y + DY[d]!;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const to = ny * w + nx;
      const info = sc.info[to]!;
      if (terr[to]! & TERR.wall || info & CELL.blocked) continue;
      const diagonal = d >= 4; // DX/DY list the four diagonals last
      if (diagonal) {
        const wallA = (terr[y * w + nx]! & TERR.wall) !== 0;
        const wallB = (terr[ny * w + x]! & TERR.wall) !== 0;
        if (eitherBlocks ? wallA || wallB : wallA && wallB) continue;
      }
      if (fear.length > 0 && closerTo(st, fear, c, to)) continue;
      const cost = (diagonal && alt && parity === 1 ? 10 : 5) * (1 + ((info & CELL.difficult) !== 0 ? 1 : 0) + crawl);
      const nf = f + cost;
      if (nf > budgetFt) continue;
      const left = popcount(sc.threatLo[c]! & ~sc.threatLo[to]!) + popcount(sc.threatHi[c]! & ~sc.threatHi[to]!);
      const np = Math.min(MAX_PROVOKES, p + left);
      const nh = enter === 0 && travel === 0 ? 0 : Math.min(MAX_HAZARD, hz + popcount(zm[to]! & ~zm[c]! & enter) + popcount(zm[to]! & travel));
      const ns = ((to * (MAX_PROVOKES + 1) + np) * H1 + nh) * 2 + (alt ? (diagonal ? parity ^ 1 : parity) : 0); // stateOf, inlined
      if (nf < sc.ft[ns]!) {
        if (sc.ft[ns] === INF) sc.touched[sc.nTouched++] = ns;
        sc.ft[ns] = nf;
        sc.prev[ns] = s;
        heapPush(sc, nf * KEY + ns);
      }
    }
  }
  // The cells reached, ascending (a counting pass over the marks keeps it allocation-free).
  for (let i = 0; i < sc.nTouched; i++) sc.cellMark[cellOfState(sc.touched[i]!)] = 1;
  sc.nReached = 0;
  for (let c = 0; c < n; c++) {
    if (!sc.cellMark[c]) continue;
    sc.cellMark[c] = 0;
    sc.reached[sc.nReached++] = c;
  }
}

/** Would a step from `from` to `to` end closer to any of `cells`? */
export function closerTo(st: QueryState, cells: readonly number[], from: number, to: number): boolean {
  for (const c of cells) if (distFt(st, to, c) < distFt(st, from, c)) return true;
  return false;
}

export interface MoveLabel {
  cell: number;
  ft: number;
  provokes: number;
  parity: number;
  hazard: number;
}

/**
 * Calls `out` for each destination label in canonical order: cell ascending, then parity,
 * then provokes, then hazard ascending. A label is offered only if no other label to the same
 * square is at least as good on provokes, hazard and feet (Pareto). Only unoccupied squares
 * other than the start are destinations. With no zones every hazard is 0 and this is M1a's
 * (provokes, feet) frontier exactly.
 */
export function forEachLabel(st: QueryState, u: Unit, sc: ReachScratch, budgetFt: number, out: (cell: number, ft: number, provokes: number, parity: number, hazard: number) => void): void {
  const H1 = MAX_HAZARD + 1;
  const m = sc.dom;
  for (let r = 0; r < sc.nReached; r++) {
    const c = sc.reached[r]!;
    if (c === u.cell || (sc.info[c]! & CELL.occupied) !== 0) continue;
    if (st.setup.terrain[c]! & TERR.wall) continue;
    const base = c * PH;
    for (let parity = 0; parity < sc.par; parity++) {
      // m[p][hz] = the cheapest route with at most p provokes and hz hazard. A label is
      // dominated when a route that's no worse on both (and better on one) is no dearer.
      for (let p = 0; p <= MAX_PROVOKES; p++) {
        for (let hz = 0; hz < sc.hzN; hz++) {
          const f = sc.ft[base + (p * H1 + hz) * 2 + parity]!;
          const up = p > 0 ? m[(p - 1) * H1 + hz]! : INF;
          const left = hz > 0 ? m[p * H1 + hz - 1]! : INF;
          const dom = up < left ? up : left;
          m[p * H1 + hz] = f < dom ? f : dom;
          if (f > budgetFt || dom <= f) continue;
          out(c, f, p, parity, hz);
        }
      }
    }
  }
}

/** Rebuilds the path to a label into sc.path; returns its length (cells after the start). */
export function rebuildPath(sc: ReachScratch, cell: number, provokes: number, parity: number, hazard = 0): number {
  let s = stateOf(cell, provokes, Math.max(0, hazard), sc.par === 2 ? parity : 0);
  if (sc.ft[s]! >= INF) throw new Error('rebuildPath: label is not reachable');
  let n = 0;
  while (sc.prev[s]! >= 0) {
    sc.path[n++] = cellOfState(s);
    s = sc.prev[s]!;
  }
  // Reverse in place: it was collected destination-first.
  for (let i = 0, j = n - 1; i < j; i++, j--) {
    const t = sc.path[i]!;
    sc.path[i] = sc.path[j]!;
    sc.path[j] = t;
  }
  return n;
}
