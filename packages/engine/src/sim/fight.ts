// runFight: one fight, start to finish, as a single synchronous pure call. Its log is a
// function of (engine version, content, scenario, seed, run, journal) and nothing else.
//
// Before initiative: rolled HP, then precasts (spells already up). Round loop: initiative once (SRD 5.2.1 p.13), then each round every creature that isn't
// dead takes its turn in order. A turn: Reaction back, budget reset, start-of-turn triggers,
// a death save if dying, then decisions until the unit passes; end-of-turn triggers, then
// expiries (Disengage, effects), the shared-square Prone rule, end check. A dead creature's
// slot still passes while something is anchored to its turns (ghost turns). After maxRounds
// the fight is a stalemate.

import type { Decider } from '../decide/decider.ts';
import { RunawayTurn } from '../decide/decider.ts';
import type { EventSink } from '../log/events.ts';
import { ENGINE_VERSION } from '../version.ts';
import type { ReplayKey } from '../replay.ts';
import { assertImplemented } from '../rules/flags.ts';
import { SIZES } from '../content/types.ts';
import { resetReachCache } from '../grid/reach.ts';
import { buildCounterLayout, countPick, countRes, type Counters } from './counters.ts';
import { resolveOption } from './act.ts';
import { buildAttackSpec } from './attack.ts';
import { ask, buildViews, copyLegal, emit, evBase, newScratch, nextSeq, pushLegal, releaseFold, releaseList, takeFold, takeList, type Ctx, type Scratch } from './context.ts';
import { newFrame, runSteps } from './steps.ts';
import { checkEnd, deathSave, speedNow } from './damage.ts';
import { closeRoll, drawDie, drawExpr, drawWholeRoll, drawWord, newDice, openInit, openRoll, resetRoundCounts } from './dice.ts';
import { listOptions } from './options.ts';
import { syncBudget } from './walker.ts';
import { applyPassives, runPrecasts } from './precast.ts';
import type { FightSetup } from './setup.ts';
import { addCond, COND, condId, flagsUsedKeys, has, initState, markFlag, stalemateCauseOf, stateHash, useFlag, type GameState, type Life, type Outcome, type StalemateCause, type Unit } from './state.ts';
import { boundary, foldMods, ghostTurn, hasPendingAnchors } from './effects.ts';
import { INITIATIVE_KEY } from '../content/rollkeys.ts';
import { resolveAdvantage } from '../rolls/rollspec.ts';
import { drain, newTriggerQueue, queueTrigger, TRIG } from './triggers.ts';

/** Decisions one turn may take before the engine calls it a runaway decider. */
const MAX_TURN_DECISIONS = 256;

export interface FightResult {
  readonly outcome: Outcome;
  /** Per-fight counters (sim/counters.ts), fresh arrays for this fight. */
  readonly counters: Counters;
  readonly hp: readonly number[];
  readonly hpMax: readonly number[];
  readonly life: readonly Life[];
  readonly flagsUsed: Uint8Array;
  /** Flags the deciders read while deciding (critique resolution 16). */
  readonly aiFlags: Uint8Array;
  readonly seq: number;
  readonly decisionSeq: number;
  readonly stateHash: string;
  /** A stalemate's cause (sim/state.ts stalemateCauseOf); undefined for a win or a loss. */
  readonly stalemateCause?: StalemateCause;
}

export interface FightOptions {
  /** Throw if any roll address opens twice (tests). */
  readonly audit?: boolean;
  /** Reused across fights from the same setup; fully reinitialized here. */
  readonly scratch?: Scratch;
  /** Journal recorded in the replay key printed by fightStart. */
  readonly journal?: ReplayKey['journal'];
  /** Policy per seat for the replay key; defaults to each decider's name. */
  readonly policy?: readonly string[];
  /** Called with the finished state (tests, reports). */
  readonly inspect?: (st: GameState) => void;
}

export function replayKey(setup: FightSetup, seed: number, run: number, journal: ReplayKey['journal'], policy: readonly string[]): ReplayKey {
  return { engineVersion: ENGINE_VERSION, contentHash: setup.contentHash, scenario: setup.scenario, scenarioHash: setup.scenarioHash, seed, run, journal, policy };
}

/** Builds a fight's context without running it (runFight's first step; tests drive pieces with it). */
export function createContext(setup: FightSetup, seed: number, run: number, deciders: readonly Decider[], sink: EventSink | null, opts: FightOptions = {}): Ctx {
  assertImplemented(setup.flags);
  if (deciders.length !== setup.seats.length) throw new RangeError(`${setup.seats.length} seats but ${deciders.length} deciders`);
  const sc = opts.scratch ?? newScratch(setup.w * setup.h);
  if (!sc.ctrLayout || sc.ctrLayout.setup !== setup) sc.ctrLayout = buildCounterLayout(setup);
  const st = initState(setup, seed, run, sc.ctrLayout);
  const dice = newDice(st.units.length, opts.audit === true);
  sc.depth = 0; // a reused scratch may come from a fight that stopped mid-decision (NeedInput)
  sc.foldTop = 0;
  resetReachCache(sc.reachEngine);
  resetReachCache(sc.reachQuery);
  const views = buildViews(st, dice, sc, buildAttackSpec);
  return { st, dice, sc, deciders, sink, views, deathFlags: { ...setup.flags, natOnChecksAndSaves: 'none' }, lastDecided: -1, q: newTriggerQueue(), pre: null };
}

export function runFight(setup: FightSetup, seed: number, run: number, deciders: readonly Decider[], sink: EventSink | null, opts: FightOptions = {}): FightResult {
  const cx = createContext(setup, seed, run, deciders, sink, opts);
  const { st, dice } = cx;

  const start = nextSeq(cx);
  if (sink) emit(cx, { ...evBase(cx, start, -1), k: 'fightStart', key: replayKey(setup, seed, run, opts.journal ?? [], opts.policy ?? cx.deciders.map((d) => d.name)) });
  resetRoundCounts(dice);
  rollHp(cx);
  applyPassives(cx, start);
  runPrecasts(cx, start);
  rollInitiative(cx, start);
  initiativeHooks(cx, start);
  checkEnd(cx);

  for (let round = 1; round <= setup.knobs.maxRounds && !st.outcome; round++) {
    st.round = round;
    resetRoundCounts(dice);
    const rs = nextSeq(cx);
    if (sink) emit(cx, { ...evBase(cx, rs, -1), k: 'roundStart' });
    for (let pos = 0; pos < st.order.length && !st.outcome; pos++) {
      st.orderPos = pos;
      const u = st.units[st.order[pos]!]!;
      if (u.life !== 'dead') takeTurn(cx, u);
      else if (hasPendingAnchors(st, u)) ghostTurn(cx, u); // deadAnchorTurnBoundary=keepInitiativeSlot
    }
  }
  if (!st.outcome) {
    const tpk = st.units.every((u) => u.team !== 0 || u.life === 'dead') && st.units.some((u) => u.team === 0);
    st.outcome = { k: 'stalemate', round: setup.knobs.maxRounds, tpk };
  }
  const end = nextSeq(cx);
  if (sink) emit(cx, { ...evBase(cx, end, -1), k: 'fightEnd', outcome: st.outcome, flagsUsed: flagsUsedKeys(st.flagsUsed) });
  opts.inspect?.(st);
  return {
    outcome: st.outcome,
    counters: st.ctr,
    hp: st.units.map((u) => u.hp),
    hpMax: st.units.map((u) => u.hpMax),
    life: st.units.map((u) => u.life),
    flagsUsed: st.flagsUsed.slice(),
    aiFlags: st.aiFlags.slice(),
    seq: st.seq,
    decisionSeq: st.decisionSeq,
    stateHash: stateHash(st),
    stalemateCause: stalemateCauseOf(st),
  };
}

/** monsterHp=rolled: each stat-block creature without an HP override rolls its HP dice (round 0). */
function rollHp(cx: Ctx): void {
  const st = cx.st;
  for (const u of st.units) {
    if (u.isPc || st.setup.seats[u.idx]!.hp !== null || !u.tpl.hpFormula) continue;
    if (useFlag(st, 'monsterHp') !== 'rolled') continue;
    const s = openRoll(st, cx.dice, u.idx, 'effect');
    const hp = Math.max(1, drawExpr(s, u.tpl.hpFormula));
    closeRoll(cx.dice, s);
    u.hp = hp;
    u.hpMax = hp;
  }
}

/**
 * Initiative (p.13): a DEX check, or the static score. Identical stat-block creatures on one
 * side share one roll (groupInitiative). Every unit draws a tiebreak word whether or not
 * there's a tie, so a tie in one build variant doesn't shift anyone's dice.
 */
function rollInitiative(cx: Ctx, cause: number): void {
  const st = cx.st;
  const units = st.units;
  const shared = useFlag(st, 'groupInitiative') === 'shared';
  const mode = useFlag(st, 'initiativeMode');
  const leader = new Int16Array(units.length);
  const natural = new Int16Array(units.length);
  // Modifiers on d20.check.initiative (and on any DEX or plain check) fold into this draw's
  // flat bonus and Advantage only, so the roll stays on its own stream and slot. Dice, floors,
  // and one-use riders (consume: nextRoll, kept for the next real roll) don't apply here.
  // Folded for every unit first: a unit shares a group's roll only when its own fold matches.
  const advOf = new Int8Array(units.length); // 0 straight, 1 Advantage, 2 Disadvantage
  const flatOf = new Int32Array(units.length);
  for (const u of units) {
    const fd = takeFold(cx);
    if (u.surprised) fd.dis.push('core:surprised');
    foldMods(st, u, null, INITIATIVE_KEY, fd.adv, fd.dis, fd.f, true);
    const adv = resolveAdvantage(fd.adv, fd.dis);
    advOf[u.idx] = adv === 'adv' ? 1 : adv === 'dis' ? 2 : 0;
    flatOf[u.idx] = fd.f.flat;
    releaseFold(cx, fd);
  }
  for (const u of units) {
    let lead = u.idx;
    if (shared && !u.isPc) {
      for (const o of units) {
        if (o.idx >= u.idx) break;
        if (
          !o.isPc && o.team === u.team && o.tpl.id === u.tpl.id && o.surprised === u.surprised &&
          leader[o.idx] === o.idx && advOf[o.idx] === advOf[u.idx] && flatOf[o.idx] === flatOf[u.idx]
        ) {
          lead = o.idx;
          break;
        }
      }
    }
    leader[u.idx] = lead;
    if (lead !== u.idx) {
      u.init = units[lead]!.init;
      u.initTie = units[lead]!.initTie;
      natural[u.idx] = natural[lead]!;
      continue;
    }
    const adv = advOf[u.idx] === 1 ? 'adv' : advOf[u.idx] === 2 ? 'dis' : 'none';
    const flat = flatOf[u.idx]!;
    if (mode === 'static') {
      // A static score takes Advantage as +5 and Disadvantage as -5 (surprise was -5 before M3a).
      u.init = u.tpl.initScore + flat + (adv === 'adv' ? 5 : adv === 'dis' ? -5 : 0);
      natural[u.idx] = 0;
    } else {
      const s = openInit(st, cx.dice, u.idx, 0);
      const r = drawWholeRoll({ kind: 'check', adv, flat: u.tpl.initMod + flat, preDice: [], dc: 0 }, s, st.setup.flags);
      closeRoll(cx.dice, s);
      u.init = r.total;
      natural[u.idx] = r.natural;
    }
    const t = openInit(st, cx.dice, u.idx, 1);
    u.initTie = drawWord(t);
    closeRoll(cx.dice, t);
  }
  const ties = st.setup.flags.initiativeTies;
  const tieGroup = (u: Unit) => (ties === 'pcsFirst' ? (u.isPc ? 0 : 1) : ties === 'monstersFirst' ? (u.isPc ? 1 : 0) : 0);
  const idxs = units.map((u) => u.idx);
  idxs.sort((a, b) => {
    const ua = units[a]!;
    const ub = units[b]!;
    if (ua.init !== ub.init) return ub.init - ua.init;
    const ga = tieGroup(ua);
    const gb = tieGroup(ub);
    if (ga !== gb) return ga - gb;
    if (ua.initTie !== ub.initTie) return ub.initTie - ua.initTie;
    return a - b; // same roll group: seat order
  });
  for (let i = 1; i < idxs.length; i++) {
    const a = units[idxs[i - 1]!]!;
    const b = units[idxs[i]!]!;
    if (a.init === b.init && leader[a.idx] !== leader[b.idx]) markFlag(st, 'initiativeTies');
  }
  idxs.forEach((idx, pos) => (st.order[pos] = idx));
  for (const idx of idxs) {
    const u = units[idx]!;
    const seq = nextSeq(cx);
    if (cx.sink) emit(cx, { ...evBase(cx, seq, cause), k: 'initiative', who: idx, natural: natural[idx]!, total: u.init, leader: leader[idx]! });
  }
}

/**
 * HOOKX (M3 step 5a): features that act "when you roll Initiative" (Uncanny Metabolism,
 * srd-raw.txt:11146-11151: "you can regain all expended Focus Points", once per Long Rest).
 * After every initiative is rolled, in initiative order, each living creature with such a
 * feature and the pool points for it decides whether to use it (an optional decision, C14:
 * 'pick:pass' first, 'pick:<hook id>'). Its dice come from initiative slot 2 (2 + the hook's
 * ordinal on that creature), so slots 0-1 and every round's dice stay where they were.
 * [U: under initiativeMode=static nobody rolls; the hook is still offered.]
 */
function initiativeHooks(cx: Ctx, cause: number): void {
  const st = cx.st;
  for (let pos = 0; pos < st.order.length; pos++) {
    const u = st.units[st.order[pos]!]!;
    let ordinal = 0;
    for (const f of u.tpl.features) {
      const h = f.onInit;
      if (!h) continue;
      const slot = 2 + ordinal++;
      if (u.life !== 'up' || st.outcome) continue;
      const cost = h.poolCost ?? 1;
      if (h.pool >= 0 && u.res[h.pool]! < cost) continue;
      const list = takeList(cx);
      pushLegal(list, 'pick').opt = 0;
      pushLegal(list, 'pick').opt = 1;
      const i = ask(cx, u.idx, 'pick', list, cause, (l) => (l.opt === 0 ? 'pick:pass' : `pick:${h.local}`), undefined, { src: { via: f.id } });
      const use = list.items[i]!.opt === 1;
      releaseList(cx, list);
      if (!use) continue;
      const seq = nextSeq(cx);
      if (cx.sink) emit(cx, { ...evBase(cx, seq, cx.lastDecided), k: 'act', who: u.idx, via: f.id, name: h.name });
      if (h.pool >= 0) {
        u.res[h.pool]! -= cost;
        for (let k = 0; k < cost; k++) countRes(st.ctr, u.idx, h.pool);
        const r = nextSeq(cx);
        if (cx.sink) emit(cx, { ...evBase(cx, r, seq), k: 'res', who: u.idx, pool: u.tpl.pools[h.pool - 9]!.name, left: u.res[h.pool]!, ...(cost !== 1 ? { delta: -cost } : {}) });
      }
      const s = openInit(st, cx.dice, u.idx, slot);
      const fr = newFrame(u, { via: f.id, name: h.name, cause: seq, targets: [u.idx], stream: s });
      runSteps(cx, fr, h.steps);
      closeRoll(cx.dice, s);
    }
  }
}

function resetBudget(st: GameState, u: Unit): void {
  const b = u.b;
  b.action = 1;
  b.bonus = 1;
  b.reaction = 1;
  b.moveFt = speedNow(u, st);
  b.speedAt = b.moveFt;
  b.dashes = 0;
  b.standFt = 0;
  b.diagParity = 0;
  b.movedFt = 0;
  b.refused = 0;
  b.refusedFrom = -1;
  b.atkActive = false;
  b.atkCounts.fill(0);
  b.atkLive = 0;
  b.freeObj = 1;
  b.lightMask = 0;
  b.atkEquip = 0;
  // W1 (docs/design/w1-plan.md P7, P9): attack rolls made and free-move feet taken this turn.
  b.rolls = 0;
  b.freeFt = 0;
}

/**
 * Coverage step 7.6, Recharge X-Y (srd-raw.txt:44017-44025): at the start of its turn a monster with
 * a spent use rolls 1d6 and regains it on X or more. A charged use draws nothing; each roll has its
 * own address under purpose `recharge`, so no other die shifts.
 */
function rollRecharges(cx: Ctx, u: Unit): void {
  for (const r of u.tpl.rechargeUse!) {
    if (u.res[r.pool]! > 0) continue;
    const s = openRoll(cx.st, cx.dice, u.idx, 'recharge');
    const roll = drawDie(s, 6);
    closeRoll(cx.dice, s);
    const back = roll >= r.min;
    if (back) u.res[r.pool] = u.tpl.resMax[r.pool]!;
    const seq = nextSeq(cx);
    if (cx.sink) emit(cx, { ...evBase(cx, seq, -1), k: 'recharge', who: u.idx, via: r.via, name: r.name, roll, min: r.min, back });
  }
}

function takeTurn(cx: Ctx, u: Unit): void {
  const st = cx.st;
  st.turnIdx++;
  st.active = u.idx;
  u.turns++;
  u.b.reaction = 1; // a Reaction comes back at the start of its owner's turn
  boundary(cx, 'start', u, -1);
  if (u.tpl.rechargeUse && u.life === 'up') rollRecharges(cx, u);
  const t0 = nextSeq(cx);
  if (cx.sink) emit(cx, { ...evBase(cx, t0, -1), k: 'turnStart', who: u.idx, cell: u.cell, hp: u.hp, moveFt: speedNow(u, st) });
  queueTrigger(cx, TRIG.turnStart, u.idx, -1, -1, 0, t0);
  drain(cx);
  if (u.life === 'down') deathSave(cx, u, t0);
  resetBudget(st, u);
  if (u.life === 'up') {
    st.ctr.turns[u.idx]!++;
    if (u.conc >= 0) st.ctr.concTurns[u.idx]!++;
  }
  const upAtStart = u.life === 'up';
  let decisions = 0;
  while (u.life === 'up' && !st.outcome) {
    if (++decisions > MAX_TURN_DECISIONS) throw new RunawayTurn(`${u.seat} took ${MAX_TURN_DECISIONS} decisions in one turn`);
    syncBudget(st, u); // its Speed may have changed since the last decision (an escape from Restrained)
    const list = listOptions(cx, u, takeList(cx));
    if (u.b.atkActive && u.tpl.attackAct.multi) markFlag(st, 'moveBetweenAttacks'); // it decided what moving now costs
    const i = ask(cx, u.idx, 'turn', list, t0);
    const chosen = copyLegal(list.items[i]!, cx.sc.chosen);
    const choice = list.n > 1; // a lone option (a forced pass) isn't a choice
    releaseList(cx, list);
    if (choice) countPick(st.ctr, u.idx, chosen, chosen.k === 'use' && chosen.fx >= 0 && st.fx[chosen.fx]!.owner === u.idx ? st.fx[chosen.fx]!.tpl : -1);
    if (chosen.k === 'pass') break;
    resolveOption(cx, u, chosen, cx.lastDecided);
  }
  u.b.atkActive = false; // unused strikes are lost
  // Coverage 8'b G4, M7: the no-progress streak, kept as fight state. A turn begun down leaves dodgeRun alone.
  if (upAtStart) u.dodgeRun = u.dodgedTurn === u.turns ? u.dodgeRun + 1 : 0;
  u.quietTurns = st.hpTick === u.hpSeen ? u.quietTurns + 1 : 0;
  u.hpSeen = st.hpTick;
  queueTrigger(cx, TRIG.turnEnd, u.idx, u.cell, -1, 0, t0);
  drain(cx);
  boundary(cx, 'end', u, t0);
  sharedSquareProne(cx, t0);
  const te = nextSeq(cx);
  if (cx.sink) emit(cx, { ...evBase(cx, te, t0), k: 'turnEnd', who: u.idx });
  st.active = -1;
  checkEnd(cx);
}

/**
 * Ending a turn in another creature's space leaves you Prone unless you're Tiny or larger
 * than it (p.14). Checked for every living creature at the end of every turn.
 */
function sharedSquareProne(cx: Ctx, cause: number): void {
  const st = cx.st;
  const tiny = SIZES.indexOf('tiny');
  for (const u of st.units) {
    if (u.life === 'dead' || u.tpl.size === tiny) continue;
    let mustDrop = false;
    for (const o of st.units) {
      if (o === u || o.life === 'dead' || o.cell !== u.cell) continue;
      if (u.tpl.size <= o.tpl.size) mustDrop = true;
    }
    if (mustDrop && !has(u, COND.prone)) {
      addCond(u, COND.prone, 'core:shared-space', -1, cause, { k: 'never' });
      const seq = nextSeq(cx);
      if (cx.sink) emit(cx, { ...evBase(cx, seq, cause), k: 'cond', who: u.idx, cond: condId(COND.prone), on: true, via: 'core:shared-space' });
    }
  }
}
