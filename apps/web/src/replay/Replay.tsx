// The replay viewer (docs/design/m2.md 4): one exemplar fight from the last report, played in a
// worker (the runner's own path plus a logged copy), checked to be the fight the report counted,
// folded into frames on this thread, and shown as a map, a scrubber, the CLI's log lines, the
// cause chain of any line, and the fight's key moments. A replay that fails the check is not
// shown: a viewer showing a different fight than the one counted is the worse failure.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { buildFrames, checkReplay, renderLog, whyChains, why, type FightSetup, type ViewFrames } from '@montecrit/engine';
import type { PlayReply } from '@montecrit/host';
import type { ReplayTarget } from '../App.tsx';
import { condMarkers, delayFor, initial, reduce, type ReplayAction, type ReplayState, type Tables } from './controller.ts';
import { LogPane } from './LogPane.tsx';
import { MapSvg } from './MapSvg.tsx';
import { Scrubber } from './Scrubber.tsx';

const NAMES = { 'closest-loss': 'closest loss', 'typical-win': 'typical win', tpk: 'TPK', 'pc-death': 'PC death' } as const;

interface Loaded {
  readonly reply: PlayReply;
  readonly view: ViewFrames;
  readonly lines: readonly string[];
  readonly chains: readonly string[];
  readonly tables: Tables;
  readonly seqToFrame: ReadonlyMap<number, number>;
  readonly zoneStyle: ReadonlyMap<number, number>;
  readonly fxName: ReadonlyMap<number, string>;
}

function load(setup: FightSetup, reply: PlayReply): Loaded {
  const view = buildFrames(setup, reply.events, reply.end);
  const seqToFrame = new Map<number, number>();
  view.frames.forEach((f, i) => seqToFrame.set(f.seq, i));
  const zoneStyle = new Map<number, number>();
  const fxName = new Map<number, string>();
  for (const e of reply.events) {
    if (e.k === 'zone' && !zoneStyle.has(e.fx)) zoneStyle.set(e.fx, zoneStyle.size);
    if (e.k === 'fxStart') fxName.set(e.fx, e.name);
  }
  const skip = view.frames.map((_, i) => i > 0 && reply.events[i - 1]!.k === 'decided');
  return { reply, view, lines: renderLog(reply.events, setup), chains: whyChains(reply.events, setup), tables: { last: view.frames.length - 1, turnStarts: view.turnStarts, roundStarts: view.roundStarts, skip }, seqToFrame, zoneStyle, fxName };
}

export function Replay({ target, latest }: { target: ReplayTarget; latest: boolean }) {
  const f = target.last.f;
  const arm = f.session.arms[target.arm]!;
  const acc = f.run.merged.arms[target.arm]!;
  const [data, setData] = useState<Loaded | { error: string } | null>(null);
  useEffect(() => {
    let live = true;
    setData(null);
    f.session.call({ op: 'play', arm: target.arm, run: target.run, explain: null, fileNotes: f.meta.fileNote ? [f.meta.fileNote] : [] }).then(
      (r) => {
        if (!live) return;
        const reply = r as PlayReply;
        const bad = checkReplay(acc, target.run, reply.oneRun, reply.oneRunStateHash, reply.end.stateHash);
        setData(bad ? { error: `determinism error: the replayed fight is not the one the report counted (${bad})` } : load(arm.setup, reply));
      },
      (e: unknown) => live && setData({ error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [f, target.arm, target.run, acc, arm.setup]);

  const R = acc.R[target.run]!;
  const detail =
    target.kind === 'closest-loss'
      ? `enemies ${acc.foeHpLeft[target.run]}/${acc.foeHpMax[target.run]} HP left after ${R} rounds`
      : target.kind === 'typical-win'
        ? `won in ${R} rounds with PC HP ${acc.pcHpEnd[target.run]}, the run nearest the median win`
        : target.kind === 'tpk'
          ? `the first TPK, after ${R} rounds`
          : `the first fight a PC died, after ${R} rounds`;
  const cli = `${f.meta.replay} --run ${target.run}${arm.policy ? ` --policy ${arm.policy.id}` : ''}`;
  return (
    <section className="replay">
      <div className="strip mono">
        <div>
          <strong>
            {NAMES[target.kind]} · {arm.label} · run {target.run} of {acc.n}
          </strong>{' '}
          ({detail})
        </div>
        <div>
          the same fight from the CLI: {cli}{' '}
          <button type="button" onClick={() => void navigator.clipboard.writeText(cli)}>
            copy
          </button>
        </div>
      </div>
      {!latest && <p className="note">A newer run has finished; this replay is from the earlier one (its results are no longer on the Run screen).</p>}
      {data === null && <p className="muted">Playing the fight in a worker...</p>}
      {data && 'error' in data && <div className="banner">{data.error}</div>}
      {data && !('error' in data) && <Viewer setup={arm.setup} d={data} />}
    </section>
  );
}

function Viewer({ setup, d }: { setup: FightSetup; d: Loaded }) {
  const [s, dispatch] = useReducer((st: ReplayState, a: ReplayAction) => reduce(d.tables, st, a), initial);
  const frame = d.view.frames[s.i]!;
  const events = d.reply.events;
  const cell = Math.max(26, Math.min(44, Math.floor(560 / setup.w)));

  // Play: one frame per tick, slower on non-move events.
  const timer = useRef(0);
  useEffect(() => {
    if (!s.playing) return;
    timer.current = window.setTimeout(() => dispatch({ t: 'tick' }), delayFor(events[s.i]?.k, s.speed));
    return () => window.clearTimeout(timer.current);
  }, [s.playing, s.i, s.speed, events]);

  // Keys: arrows step events (with Shift, turns), [ and ] step rounds, Space plays, Home and End jump.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Browser and OS shortcuts (Cmd+[ is Back) and typing in a field are left alone; Space and
      // Enter on a focused button, link or log line activate it rather than play.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target instanceof HTMLElement ? e.target : null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA')) return;
      const control = el !== null && (el.tagName === 'BUTTON' || el.tagName === 'SUMMARY' || el.tagName === 'A' || el.getAttribute('role') === 'button');
      if (control && (e.key === ' ' || e.key === 'Enter')) return;
      if (e.key === 'w') {
        e.preventDefault();
        whyNow.current();
        return;
      }
      const a: ReplayAction | null =
        e.key === 'ArrowRight' ? { t: e.shiftKey ? 'stepTurn' : 'stepEvent', d: 1 } : e.key === 'ArrowLeft' ? { t: e.shiftKey ? 'stepTurn' : 'stepEvent', d: -1 } : e.key === ']' ? { t: 'stepRound', d: 1 } : e.key === '[' ? { t: 'stepRound', d: -1 } : e.key === ' ' ? { t: 'toggle' } : e.key === 'Home' ? { t: 'home' } : e.key === 'End' ? { t: 'end' } : null;
      if (!a) return;
      e.preventDefault();
      dispatch(a);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const turn = d.tables.turnStarts.filter((t) => t <= s.i).length;
  // Stable for one opened fight, so the memoized log lines don't re-render every frame.
  const seek = useCallback(
    (seq: number) => {
      const i = d.seqToFrame.get(seq);
      if (i !== undefined) dispatch({ t: 'seek', i });
      dispatch({ t: 'select', seq });
    },
    [d],
  );
  const pick = useCallback((j: number) => seek(events[j + 1]!.seq), [seek, events]);
  // The WHY of the event the cursor is on (the button and the w key).
  const whyNow = useRef(() => {});
  whyNow.current = () => {
    if (frame.seq >= 0) dispatch({ t: 'select', seq: frame.seq });
  };
  const chain = useMemo(() => (s.selected === null ? null : why(events, setup, s.selected).split('\n  <- ')), [s.selected, events, setup]);
  const drops = useMemo(() => events.flatMap((e, j) => ((e.k === 'down' || e.k === 'death') && setup.seats[e.who]!.tpl.kind === 'pc' ? [j + 1] : [])), [events, setup]);

  return (
    <>
      {d.view.problems.length > 0 && <div className="banner">The view disagrees with the fight: {d.view.problems.join('; ')}</div>}
      <div className="replaygrid">
        <div>
          <MapSvg setup={setup} frame={frame} zoneStyle={d.zoneStyle} cell={cell} fxName={d.fxName} />
          <Scrubber tables={d.tables} s={s} dispatch={dispatch} drops={drops} turn={turn} round={frame.round} seq={frame.seq} total={events.length} />
          <button type="button" onClick={() => whyNow.current()} disabled={frame.seq < 0} title="Open the cause chain of the event at the cursor (w)">
            WHY of this event
          </button>
          <SideTable frame={frame} fxName={d.fxName} />
        </div>
        <LogPane lines={d.lines} current={s.i - 2} onPick={pick} />
      </div>
      <div className="whygrid">
        <div>
          <h2>Key moments</h2>
          <KeyMoments lines={d.chains} onSeq={seek} />
        </div>
        <div>
          <h2>WHY {s.selected !== null ? `#${s.selected}` : ''}</h2>
          {chain === null ? (
            <p className="muted">Click a log line or a key moment to see its cause chain.</p>
          ) : (
            <ol className="chain mono">
              {chain.map((link, k) => {
                const seq = Number(/^#(\d+)/.exec(link)?.[1] ?? -1);
                return (
                  <li key={k}>
                    <button type="button" className="linkish" onClick={() => seek(seq)}>
                      {link}
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </div>
      <details>
        <summary>Fight header (replay key, policies, flags read)</summary>
        <pre>{d.reply.header.join('\n')}</pre>
        <pre className="muted">
          logHash {d.reply.logHash} | stateHash {d.reply.end.stateHash}
        </pre>
      </details>
    </>
  );
}

function SideTable({ frame, fxName }: { frame: ViewFrames['frames'][number]; fxName: ReadonlyMap<number, string> }) {
  return (
    <table className="side">
      <thead>
        <tr>
          <th>Seat</th>
          <th>Name</th>
          <th className="num">HP</th>
          <th>State</th>
          <th>Conditions</th>
          <th>Concentrating on</th>
        </tr>
      </thead>
      <tbody>
        {frame.units.map((u, i) => (
          <tr key={u.seat} className={i === frame.turnOf ? 'activerow' : undefined}>
            <td className="mono" style={{ color: `var(--team${u.team})` }}>
              {u.seat}
            </td>
            <td>{u.name}</td>
            <td className="num">
              {u.hp}/{u.hpMax}
            </td>
            <td>{u.life}</td>
            <td>{condMarkers(u.conds, -1).map((m) => m.name).join(', ')}</td>
            <td>{u.conc >= 0 ? (fxName.get(u.conc) ?? `effect ${u.conc}`) : ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function KeyMoments({ lines, onSeq }: { lines: readonly string[]; onSeq: (seq: number) => void }) {
  return (
    <div className="mono keymoments">
      {lines.slice(1).map((l, k) => {
        const m = /\(#(\d+)\)/.exec(l) ?? /^\s*#(\d+)/.exec(l);
        return m ? (
          <div key={k}>
            <button type="button" className="linkish" onClick={() => onSeq(Number(m[1]))}>
              {l}
            </button>
          </div>
        ) : (
          <div key={k}>{l}</div>
        );
      })}
    </div>
  );
}

