// The scrubber (docs/design/m2.md 4.4): step buttons, play and speed, a slider with round
// ticks (major), turn ticks (minor) and PC drops marked, and where the cursor is.

import type { Dispatch } from 'react';
import type { ReplayAction, ReplayState, Speed, Tables } from './controller.ts';

export function Scrubber({ tables, s, dispatch, drops, turn, round, seq, total }: { tables: Tables; s: ReplayState; dispatch: Dispatch<ReplayAction>; drops: readonly number[]; turn: number; round: number; seq: number; total: number }) {
  const W = 560;
  const x = (i: number) => (tables.last > 0 ? (i / tables.last) * W : 0);
  const b = (label: string, a: ReplayAction, title: string) => (
    <button type="button" title={title} onClick={() => dispatch(a)}>
      {label}
    </button>
  );
  return (
    <div className="scrubber">
      <div className="buttons">
        {b('|<', { t: 'home' }, 'Start (Home)')}
        {b('R<', { t: 'stepRound', d: -1 }, 'Previous round ([)')}
        {b('T<', { t: 'stepTurn', d: -1 }, 'Previous turn (Shift+Left)')}
        {b('E<', { t: 'stepEvent', d: -1 }, 'Previous event (Left)')}
        <button type="button" title="Play or pause (Space)" onClick={() => dispatch({ t: 'toggle' })}>
          {s.playing ? 'Pause' : 'Play'}
        </button>
        {b('>E', { t: 'stepEvent', d: 1 }, 'Next event (Right)')}
        {b('>T', { t: 'stepTurn', d: 1 }, 'Next turn (Shift+Right)')}
        {b('>R', { t: 'stepRound', d: 1 }, 'Next round (])')}
        {b('>|', { t: 'end' }, 'End (End)')}
        <select value={s.speed} onChange={(e) => dispatch({ t: 'speed', speed: Number(e.target.value) as Speed })} aria-label="Play speed">
          <option value={1}>1x</option>
          <option value={4}>4x</option>
          <option value={16}>16x</option>
        </select>
        <span className="mono muted">
          R{round} · T{turn} · {seq >= 0 ? `#${seq}` : 'start'} · frame {s.i}/{tables.last} ({total} events)
        </span>
      </div>
      <svg width={W} height={14} className="ticks" aria-hidden="true">
        {tables.turnStarts.map((t) => (
          <line key={`t${t}`} x1={x(t)} x2={x(t)} y1={8} y2={14} stroke="var(--rule)" />
        ))}
        {tables.roundStarts.map((t) => (
          <line key={`r${t}`} x1={x(t)} x2={x(t)} y1={2} y2={14} stroke="var(--muted)" />
        ))}
        {drops.map((t) => (
          <rect key={`d${t}`} x={x(t) - 2} y={0} width={4} height={6} fill="var(--bad)" />
        ))}
      </svg>
      <input type="range" min={0} max={tables.last} value={s.i} onChange={(e) => dispatch({ t: 'seek', i: Number(e.target.value) })} style={{ width: W }} aria-label="Frame" />
    </div>
  );
}
