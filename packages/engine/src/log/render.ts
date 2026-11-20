// Text rendering of an event log: one line per event, indented by how far it sits down its
// cause chain, with roll addresses in brackets so any number can be re-derived. why() walks
// one event's causes back to the decision that started it.

import { COVER_BONUS, COVER_NAME } from '../grid/los.ts';
import { cellName } from '../grid/cells.ts';
import type { FightSetup } from '../sim/setup.ts';
import type { GameEvent } from './events.ts';

const title = (id: string): string => {
  const s = id.replace(/^core:/, '').replace(/-/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** One piece of a counted gear stack, named by its plural: 'Spears' -> 'a Spear', 'Light Hammers' -> 'a Light Hammer'. */
function onePiece(gear: string): string {
  const one = gear.endsWith('s') && !gear.endsWith('ss') ? gear.slice(0, -1) : gear;
  return `${/^[AEIOU]/i.test(one) ? 'an' : 'a'} ${one}`;
}

/** '[ally1 attack r1 p2.0]': roller, purpose, round, partition.n */
function rollTag(seat: string, purpose: string, round: number, slot: number): string {
  return `[${seat} ${purpose} r${round} p${slot >> 10}.${slot & 1023}]`;
}

export function describe(e: GameEvent, setup: FightSetup): string {
  const seat = (i: number) => setup.seats[i]!.seat;
  const sq = (c: number) => cellName(c, setup.w);
  switch (e.k) {
    case 'fightStart':
      return `fight ${e.key.scenario} seed ${e.key.seed} run ${e.key.run}`;
    case 'initiative':
      return e.natural === 0 && setup.flags.initiativeMode === 'static'
        ? `initiative ${seat(e.who)} ${e.total} (static)`
        : e.leader !== e.who
          ? `initiative ${seat(e.who)} ${e.total} (shares ${seat(e.leader)}'s roll)`
          : `initiative ${seat(e.who)} ${e.total} (d20 ${e.natural}${fmtMod(e.total - e.natural)})`;
    case 'roundStart':
      return `== round ${e.round} ==`;
    case 'turnStart': {
      const tpl = setup.seats[e.who]!.tpl;
      return `${seat(e.who)}'s turn (${sq(e.cell)}, ${e.hp} HP, ${e.moveFt} ft) [${tpl.name}]`;
    }
    case 'turnEnd':
      return `${seat(e.who)}'s turn ends`;
    case 'decided':
      return `${seat(e.who)} chooses ${e.key}  [${e.by} @${e.at}]`;
    case 'act':
      return `${seat(e.who)}: ${e.name}`;
    case 'provoke':
      return `${seat(e.mover)} leaves ${seat(e.by)}'s reach ${sq(e.from)} -> ${sq(e.to)}`;
    case 'step':
      if (e.forced) return `${seat(e.who)} is ${e.forced === 'pull' ? 'pulled' : 'pushed'} ${sq(e.from)} -> ${sq(e.to)} (${e.ft} ft, forced)`;
      return `${seat(e.who)} steps ${sq(e.from)} -> ${sq(e.to)} (${e.ft} ft, ${e.left} left)`;
    case 'moveEnd': {
      const what = e.forced ? 'forced move' : 'move';
      return e.why === 'arrived'
        ? `${seat(e.who)}'s ${what} ends at ${sq(e.cell)}`
        : `${seat(e.who)}'s ${what} ends at ${sq(e.cell)}: ${e.why}, ${e.steps} of ${e.planned} steps`;
    }
    case 'attack': {
      const d20 = e.adv === 'none' ? `d20 ${e.natural}` : `d20 ${e.d20[0]}/${e.d20[1]} ${e.adv} -> ${e.natural}`;
      const srcs = [...e.advSrc.map((s) => `+${s.replace('core:', '')}`), ...e.disSrc.map((s) => `-${s.replace('core:', '')}`)];
      const why = srcs.length ? ` (${srcs.join(' ')})` : '';
      const res = e.hit ? (e.crit ? 'CRITICAL HIT' : 'hit') : 'miss';
      const oa = e.opportunity ? ' [opportunity attack]' : '';
      const pre = e.pre ?? 0;
      const ext = e.ext ?? 0;
      const extra = (pre ? ` ${fmtMod(pre)}(dice)` : '') + (ext ? ` ${fmtMod(ext)}(reaction)` : '');
      const cov = (e.cover ? ` (${COVER_NAME[e.cover]} +${COVER_BONUS[e.cover]})` : '') + (e.acUp ? ` (+${e.acUp} after the hit)` : '');
      return `${seat(e.att)} ${e.name} -> ${seat(e.tgt)}: ${d20}${why} ${fmtMod(e.total - e.natural - pre - ext)}${extra} = ${e.total} vs AC ${e.ac}${cov}, ${res}${oa}  ${rollTag(seat(e.att), 'attack', e.round, e.slot)}`;
    }
    case 'damage': {
      const parts = e.parts.map((p) => `${p.rolled} ${p.type}`).join(' + ');
      const temp = e.tempAbsorbed ? `, ${e.tempAbsorbed} to temp HP` : '';
      const hp = e.hpBefore === e.hpAfter && e.hpAfter === 0 ? 'at 0 HP' : `HP ${e.hpBefore} -> ${e.hpAfter}`;
      const from = e.name ? ` from ${e.name}` : '';
      const half = e.half ? ', half' : '';
      return `${seat(e.tgt)} takes ${e.dealt} (${parts}${e.crit ? ', crit' : ''}${half}${temp})${from}, ${hp}  ${rollTag(seat(e.src), e.purpose ?? 'damage', e.round, e.slot)}`;
    }
    case 'cond':
      return `${seat(e.who)} ${e.on ? 'is' : 'is no longer'} ${title(e.cond)} (${e.via.replace('core:', '')})`;
    case 'gear':
      return e.ammo ? `${seat(e.who)} uses a piece of ${e.item} (${e.left} left)` : `${seat(e.who)} throws ${e.item} (${e.left} left)`;
    case 'down':
      return `${seat(e.who)} drops to 0 HP and falls Unconscious`;
    case 'revive':
      return `${seat(e.who)} regains ${e.hp ?? 1} HP and wakes (still Prone)`;
    case 'stable':
      return `${seat(e.who)} is Stable`;
    case 'deathSave':
      const react = e.total !== undefined ? e.total - e.natural - (e.mod ?? 0) : 0;
      const total = e.total !== undefined && e.total !== e.natural ? `${e.mod ? ` ${fmtMod(e.mod)}` : ''}${react ? ` ${fmtMod(react)}(reaction)` : ''} = ${e.total}` : '';
      return `${seat(e.who)} death save: d20 ${e.natural}${total} (successes ${e.ok}, failures ${e.fail})  ${rollTag(seat(e.who), 'death', e.round, e.slot)}`;
    case 'deathFail':
      return `${seat(e.who)} takes ${e.n} death save failure${e.n > 1 ? 's' : ''} (failures ${e.fail})`;
    case 'death':
      return `${seat(e.who)} dies (${e.why === 'zeroHp' ? '0 HP' : e.why === 'massive' ? 'massive damage' : 'three failed death saves'})`;
    case 'fightEnd':
      return `fight ends: ${e.outcome.k} in round ${e.outcome.round}${e.outcome.tpk ? ' (TPK)' : ''}`;
    case 'cast': {
      const how = e.lvl === 0 ? ' (cantrip)' : e.free ? ` (free: ${e.free}, ${e.left} left)` : ` with a level ${e.lvl} slot (${e.left} left)`;
      return `${seat(e.who)} casts ${e.name}${how}`;
    }
    case 'precast': {
      const how = e.lvl === 0 ? ' (cantrip)' : e.free ? ` (free: ${e.free}, ${e.left} left)` : ` with a level ${e.lvl} slot (${e.left} left)`;
      return `${seat(e.who)} cast ${e.name} before the fight${how}${e.elapsed > 0 ? `, ${e.elapsed} round${e.elapsed === 1 ? '' : 's'} ago` : ''}`;
    }
    case 'heal':
      return `${seat(e.tgt)} regains ${e.hpAfter - e.hpBefore} (${e.rolled} rolled) from ${e.name}, HP ${e.hpBefore} -> ${e.hpAfter}  ${rollTag(seat(e.src), 'heal', e.round, e.slot)}`;
    case 'tempHp':
      return `${seat(e.tgt)} gains ${e.rolled} Temporary Hit Points from ${e.name}${e.after === e.before ? ` (keeps ${e.before})` : `, temp HP ${e.before} -> ${e.after}`}  ${rollTag(seat(e.src), 'tempHp', e.round, e.slot)}`;
    case 'item':
      // A throw's own line is the attack's (and a stack's gear line, "throws X (n left)"); this one
      // only says the hand is empty now (M3 step 5b integration: it used to read "throws X" twice).
      if (e.act === 'throw') return `${seat(e.who)}'s hand is empty: ${e.item} was thrown`;
      // Step E: a monster picking a thrown piece back up carries `left`; its gear name is the
      // stack's plural ("Spears"), so the line names one piece and the count after it, continuing
      // the throws' "(n left)". A PC's pickup has no `left` and keeps its old line.
      if (e.act === 'pickup' && e.left !== undefined) return `${seat(e.who)} picks up ${onePiece(e.item)} (${e.left} left)`;
      return `${seat(e.who)} ${e.act === 'pickup' ? 'picks up' : e.act === 'drop' ? 'drops' : `${e.act}s`} ${e.item}`;
    case 'res':
      if (e.delta !== undefined) return `${seat(e.who)} ${e.delta < 0 ? 'spends' : 'regains'} ${Math.abs(e.delta)} ${e.pool} (${e.left} left)`;
      return `${seat(e.who)} spends ${e.pool} (${e.left} left)`;
    case 'reduce':
      return e.halve
        ? `${seat(e.who)} reacts to ${seat(e.att)}'s hit: ${e.name} halves the damage`
        : `${seat(e.who)} reacts to ${seat(e.att)}'s hit: ${e.name} reduces the damage by ${e.v}  ${rollTag(seat(e.who), 'hitTaken', e.round, e.slot)}`;
    case 'react':
      return `${seat(e.who)} reacts before ${seat(e.roller)}'s roll: ${e.name} ${fmtMod(e.v)} (${e.left} left)  ${rollTag(seat(e.who), 'react', e.round, e.slot)}`;
    case 'zone':
      return `${e.name} appears at ${e.anchor}: ${e.cells} square${e.cells === 1 ? '' : 's'}${e.difficult ? ', Difficult Terrain' : ''} (seen by ${e.seen.map(seat).join(', ') || 'no one'})`;
    case 'recharge':
      return `${seat(e.who)} rolls to recharge ${e.name}: ${e.roll} (needs ${e.min === 6 ? '6' : `${e.min}-6`}): ${e.back ? 'it comes back' : 'not yet'}`;
    case 'swap':
      return `${seat(e.who)} swaps places with ${seat(e.with)} (${e.name}): ${seat(e.who)} ${sq(e.from)} -> ${sq(e.to)}, ${seat(e.with)} ${sq(e.to)} -> ${sq(e.from)}`;
    case 'reveal':
      return `${seat(e.who)} recognizes ${e.name} as hazardous (${e.how === 'search' ? 'its Search' : 'its damage'})`;
    case 'zoneMove':
      return `${e.name} moves ${e.from} -> ${e.to}${e.caught.length ? `; caught ${e.caught.map(seat).join(', ')}` : ''}`;
    case 'save': {
      const d20 = e.adv === 'none' ? `d20 ${e.natural}` : `d20 ${e.d20[0]}/${e.d20[1]} ${e.adv} -> ${e.natural}`;
      const floor = e.face !== e.natural ? ` floor ${e.face}` : '';
      const srcs = [...e.advSrc.map((s) => `+${s.replace('core:', '')}`), ...e.disSrc.map((s) => `-${s.replace('core:', '')}`)];
      const why = srcs.length ? ` (${srcs.join(' ')})` : '';
      const extra = (e.pre ? ` ${fmtMod(e.pre)}(dice)` : '') + (e.ext ? ` ${fmtMod(e.ext)}(reaction)` : '');
      const cb = e.cover ? COVER_BONUS[e.cover]! : 0;
      const flat = e.total - e.face - e.pre - e.ext - cb;
      const cov = e.cover ? ` +${cb}(${COVER_NAME[e.cover]})` : '';
      const sum = `${d20}${floor}${why} ${fmtMod(flat)}${cov}${extra} = ${e.total} vs DC ${e.dc}`;
      if (e.purpose === 'conc') return `${seat(e.who)} concentration save (${e.name}): ${sum}, ${e.ok ? 'holds' : 'breaks'}  ${rollTag(seat(e.who), 'conc', e.round, e.slot)}`;
      if (e.purpose === 'check') {
        const parts = e.key.split('.');
        const what = `${parts[1]?.toUpperCase() ?? ''}${parts[2] ? ` (${title(parts[2])})` : ''}`;
        return `${seat(e.who)} ${what} check for ${e.name}: ${sum}, ${e.ok ? 'success' : 'fail'}  ${rollTag(seat(e.who), 'check', e.round, e.slot)}`;
      }
      if (e.purpose === 'condSave') {
        const ab = e.key.split('.')[1]?.toUpperCase() ?? '';
        return `${seat(e.who)} ${ab} save to end ${e.name}: ${sum}, ${e.ok ? 'success' : 'fail'}  ${rollTag(seat(e.who), 'condSave', e.round, e.slot)}`;
      }
      const ab = e.key.split('.')[1]?.toUpperCase() ?? '';
      return `${seat(e.who)} ${ab} save vs ${e.name}: ${sum}, ${e.ok ? 'success' : 'fail'}  ${rollTag(seat(e.who), e.purpose === 'rider' || e.purpose === 'reaction' ? e.purpose : 'save', e.round, e.slot)}`;
    }
    case 'fxStart':
      if (e.conc) return `${seat(e.owner)} is concentrating on ${e.name}`;
      return e.bearer >= 0 ? `${e.name} on ${seat(e.bearer)}` : `${e.name} begins`;
    case 'fxEnd': {
      const on = e.bearer >= 0 ? ` on ${seat(e.bearer)}` : e.why === 'concentration' || e.why === 'newConcentration' ? ` (${seat(e.owner)})` : '';
      return `${e.name}${on} ends (${FX_END[e.why]})`;
    }
  }
}

const FX_END: Readonly<Record<string, string>> = {
  expired: 'expired',
  concentration: 'concentration broken',
  newConcentration: 'concentrating on something else',
  dismissed: 'dismissed',
  replaced: 'replaced',
  incapacitated: 'Incapacitated',
  death: 'died',
  parent: 'its source ended',
  consumed: 'used',
  sourceLost: 'its source item was lost',
  anchorDied: 'its anchor died',
  saved: 'saved',
  escaped: 'escaped',
  damaged: 'took damage',
};

function fmtMod(m: number): string {
  return m >= 0 ? `+${m}` : `${m}`;
}

/** One line per event, '#seq' first, indented by cause depth within the turn. */
export function renderLog(events: readonly GameEvent[], setup: FightSetup): string[] {
  const depth = new Map<number, number>();
  const lines: string[] = [];
  for (const e of events) {
    if (e.k === 'fightStart') continue;
    const d = e.cause >= 0 && depth.has(e.cause) ? depth.get(e.cause)! + 1 : 0;
    depth.set(e.seq, d);
    const indent = e.k === 'roundStart' ? '' : '  '.repeat(Math.max(0, d - 1) + (e.k === 'turnStart' || e.k === 'fightEnd' ? 0 : 1));
    lines.push(`${String(`#${e.seq}`).padStart(5)} ${indent}${describe(e, setup)}`);
  }
  return lines;
}

/** The cause chain behind event `seq`, newest first: '#12 ... <- #11 ... <- #6 ...'. */
export function why(events: readonly GameEvent[], setup: FightSetup, seq: number): string {
  const bySeq = new Map<number, GameEvent>();
  for (const e of events) bySeq.set(e.seq, e);
  const chain: string[] = [];
  let e = bySeq.get(seq);
  if (!e) throw new RangeError(`no event #${seq} in this log`);
  for (let guard = 0; e && guard < 64; guard++) {
    chain.push(`#${e.seq} ${describe(e, setup)}`);
    e = e.cause >= 0 ? bySeq.get(e.cause) : undefined;
  }
  return chain.join('\n  <- ');
}
