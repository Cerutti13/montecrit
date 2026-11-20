// The battle map (docs/design/m2.md 4.4), SVG, layered bottom to top: the static grid (memoized
// once per setup), zones, bodies, the move trail and forced path, the strike line, tokens.
// Colors are theme tokens; zones are styled by order of appearance, never by content id. Team is
// shape as well as color (party circles, foes rounded squares), so it reads without color.

import { memo, useMemo, type ReactElement } from 'react';
import { colName, TERR, type FightSetup, type TokenView, type ViewFrame } from '@montecrit/engine';
import { condMarkers } from './controller.ts';

const LABEL = 18;

export interface MapProps {
  readonly setup: FightSetup;
  readonly frame: ViewFrame;
  /** Zone fx id -> style index (order of first appearance in the fight). */
  readonly zoneStyle: ReadonlyMap<number, number>;
  readonly cell: number;
  readonly onToken?: (unit: number) => void;
  /** Effect fx id -> name, so the concentration marker can say what it holds. */
  readonly fxName?: ReadonlyMap<number, string>;
  /** Practice mode: squares a click can choose (a move's destination, an area's anchor), drawn above the tokens. */
  readonly cells?: readonly { readonly cell: number; readonly risky: boolean; readonly title: string; readonly hint?: boolean }[];
  readonly onCell?: (cell: number) => void;
  /** Practice mode: the pointer is over a choosable square (null: it left). */
  readonly onCellHover?: (cell: number | null) => void;
  /** Practice mode: the squares an area would cover if placed where the pointer is, drawn under the choices. */
  readonly preview?: readonly number[];
  /** Practice mode: units a click can choose, ringed. */
  readonly pickable?: ReadonlySet<number>;
}

const StaticLayer = memo(function StaticLayer({ setup, cell }: { setup: FightSetup; cell: number }) {
  const { w, h, terrain } = setup;
  const out: ReactElement[] = [];
  for (let x = 0; x < w; x++) {
    out.push(
      <text key={`c${x}`} x={LABEL + x * cell + cell / 2} y={LABEL - 5} textAnchor="middle" className="maplabel">
        {colName(x)}
      </text>,
    );
  }
  for (let y = 0; y < h; y++) {
    out.push(
      <text key={`r${y}`} x={LABEL - 4} y={LABEL + y * cell + cell / 2 + 4} textAnchor="end" className="maplabel">
        {y + 1}
      </text>,
    );
  }
  for (let c = 0; c < w * h; c++) {
    const x = LABEL + (c % w) * cell;
    const y = LABEL + Math.floor(c / w) * cell;
    const t = terrain[c]!;
    out.push(<rect key={`g${c}`} x={x} y={y} width={cell} height={cell} fill={t & TERR.wall ? 'var(--wall)' : t & TERR.difficult ? 'url(#hatch-difficult)' : 'none'} stroke="var(--grid)" strokeWidth={1} />);
    // M3 step 8: cover objects ('+' Half, '*' Three-Quarters) as a block filling that share of the square.
    const share = t & TERR.threeQuarterCover ? 0.75 : t & TERR.halfCover ? 0.5 : 0;
    if (share > 0) {
      out.push(
        <rect key={`v${c}`} x={x + 2} y={y + cell * (1 - share)} width={cell - 4} height={cell * share - 2} fill="var(--wall)" fillOpacity={0.55} className="cover">
          <title>{share === 0.75 ? 'Three-Quarters Cover' : 'Half Cover'}</title>
        </rect>,
      );
    }
  }
  return <g>{out}</g>;
});

function zoneEdges(cells: readonly number[], w: number, cell: number): string {
  const inZone = new Set(cells);
  const d: string[] = [];
  for (const c of cells) {
    const x = LABEL + (c % w) * cell;
    const y = LABEL + Math.floor(c / w) * cell;
    const cx = c % w;
    if (!inZone.has(c - w)) d.push(`M${x} ${y}h${cell}`);
    if (!inZone.has(c + w)) d.push(`M${x} ${y + cell}h${cell}`);
    if (cx === 0 || !inZone.has(c - 1)) d.push(`M${x} ${y}v${cell}`);
    if (cx === w - 1 || !inZone.has(c + 1)) d.push(`M${x + cell} ${y}v${cell}`);
  }
  return d.join('');
}

const BADGE_W = 13;
const BADGE_H = 10;

/** The narrowest "+N" badge worth drawing: two 8px characters. */
const MORE_MIN_W = 10;

export interface MarkerLayout {
  /** How many badges to draw, the most decisive first; at least 1 when there are any markers. */
  readonly shown: number;
  /** How many markers the badges leave out (named in the "+N" title and the aria label). */
  readonly more: number;
  /** The "+N" badge's width, or 0 when there's no room for it (or nothing more to say). */
  readonly moreW: number;
}

/**
 * How a row of `count` badges fits a `cell`-wide square: all of them when they fit; otherwise all
 * but one plus a "+N" badge, never fewer than the first (most decisive) badge. On the narrowest
 * cells only one badge fits, so the "+N" shrinks into what's left of the row, or is dropped when
 * even that won't fit. The row never runs past the square.
 */
export function markerLayout(cell: number, count: number): MarkerLayout {
  if (count <= 0) return { shown: 0, more: 0, moreW: 0 };
  const row = cell - 2;
  const fit = Math.max(1, Math.floor(row / BADGE_W));
  if (count <= fit) return { shown: count, more: 0, moreW: 0 };
  const shown = Math.max(1, fit - 1);
  const room = row - shown * BADGE_W;
  return { shown, more: count - shown, moreW: room >= MORE_MIN_W ? Math.min(BADGE_W, room) : 0 };
}

/**
 * M3 (m3.md 10): a token's condition and concentration markers at this frame, a row of
 * two-letter badges along the top of its square, each with its full name as a title; when the
 * row is full the last badge says how many more (see markerLayout). The group's aria label lists
 * them all.
 */
function Markers({ u, x, y, cell, fxName }: { u: TokenView; x: number; y: number; cell: number; fxName?: ReadonlyMap<number, string> }) {
  const ms = condMarkers(u.conds, u.conc, u.conc >= 0 ? fxName?.get(u.conc) : undefined);
  if (ms.length === 0) return null;
  const lay = markerLayout(cell, ms.length);
  const shown = ms.slice(0, lay.shown);
  const rest = ms.slice(lay.shown);
  const x0 = x - cell / 2 + 1;
  const y0 = y - cell / 2 + 1;
  const badge = (k: number, text: string, title: string, conc: boolean, bw = BADGE_W) => (
    <g key={k}>
      <title>{title}</title>
      <rect x={x0 + k * BADGE_W} y={y0} width={bw - 1} height={BADGE_H} rx={2} fill="var(--surface)" stroke={conc ? 'var(--accent)' : 'var(--fg)'} strokeWidth={0.75} />
      <text x={x0 + k * BADGE_W + (bw - 1) / 2} y={y0 + BADGE_H - 2} textAnchor="middle" className="badge">
        {text}
      </text>
    </g>
  );
  return (
    <g role="img" aria-label={`${u.seat}: ${ms.map((m) => m.name).join(', ')}`}>
      {/* With no room for "+N", the last badge's title carries the ones left out. */}
      {shown.map((m, k) => badge(k, m.abbr, rest.length > 0 && lay.moreW === 0 && k === shown.length - 1 ? [m, ...rest].map((r) => r.name).join(', ') : m.name, m.id === 'conc'))}
      {lay.moreW > 0 && badge(shown.length, `+${rest.length}`, rest.map((m) => m.name).join(', '), false, lay.moreW)}
    </g>
  );
}

export function MapSvg({ setup, frame, zoneStyle, cell, onToken, fxName, cells, onCell, onCellHover, preview, pickable }: MapProps) {
  const { w, h } = setup;
  const center = (c: number): [number, number] => [LABEL + (c % w) * cell + cell / 2, LABEL + Math.floor(c / w) * cell + cell / 2];
  const width = LABEL + w * cell + 2;
  const height = LABEL + h * cell + 2;
  const m = frame.marks;
  const active = frame.turnOf;
  const pts = (cs: readonly number[]) => cs.map((c) => center(c).join(',')).join(' ');
  const tokens = useMemo(() => frame.units.map((u, i) => ({ u, i })), [frame.units]);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="map" role="img" aria-label={`Round ${frame.round} map`}>
      <defs>
        <pattern id="hatch-difficult" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" stroke="var(--difficult)" strokeWidth="1.5" />
        </pattern>
        {[1, 2, 3, 4].map((k) => (
          <pattern key={k} id={`zone-${k}`} width="8" height="8" patternUnits="userSpaceOnUse" patternTransform={`rotate(${[0, 45, 90, 135][k - 1]})`}>
            <rect width="8" height="8" fill={`var(--zone-${k})`} fillOpacity="var(--zone-alpha)" />
            <line x1="0" y1="0" x2="0" y2="8" stroke={`var(--zone-${k})`} strokeWidth="1" strokeOpacity="0.5" />
          </pattern>
        ))}
        <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0 0L10 5L0 10z" fill="var(--fg)" />
        </marker>
      </defs>
      <StaticLayer setup={setup} cell={cell} />
      {frame.zones.map((z) => {
        const k = ((zoneStyle.get(z.fx) ?? 0) % 4) + 1;
        return (
          <g key={z.fx}>
            {z.cells.map((c) => (
              <rect key={c} x={LABEL + (c % w) * cell} y={LABEL + Math.floor(c / w) * cell} width={cell} height={cell} fill={`url(#zone-${k})`} />
            ))}
          </g>
        );
      })}
      {frame.bodies.map((c, j) => {
        const [x, y] = center(c);
        const r = cell * 0.18;
        return <path key={`b${j}`} d={`M${x - r} ${y - r}L${x + r} ${y + r}M${x + r} ${y - r}L${x - r} ${y + r}`} stroke="var(--muted)" strokeWidth={2} />;
      })}
      {m.trail.length > 1 && <polyline points={pts(m.trail)} fill="none" stroke={active >= 0 ? `var(--team${frame.units[active]!.team})` : 'var(--fg)'} strokeWidth={2} strokeDasharray="1 5" strokeLinecap="round" />}
      {m.forced && <polyline points={pts(m.forced.path)} fill="none" stroke="var(--fg)" strokeWidth={2} strokeDasharray="4 3" markerEnd="url(#arrow)" />}
      {m.strike &&
        (() => {
          const [x1, y1] = center(frame.units[m.strike.att]!.cell);
          const [x2, y2] = center(frame.units[m.strike.tgt]!.cell);
          return (
            <g>
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--bad)" strokeWidth={m.strike.crit ? 4 : 2} strokeDasharray={m.strike.hit ? undefined : '5 4'} markerEnd="url(#arrow)" />
              {m.strike.opportunity && (
                <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 4} textAnchor="middle" className="tag">
                  OA
                </text>
              )}
            </g>
          );
        })()}
      {tokens.map(({ u, i }) => {
        const [x, y] = center(u.cell);
        const r = cell * 0.34;
        const color = u.life === 'dead' ? 'var(--muted)' : `var(--team${u.team})`;
        const hollow = u.life === 'down' || u.life === 'stable';
        const frac = u.hpMax > 0 ? Math.max(0, Math.min(1, u.hp / u.hpMax)) : 0;
        const shape =
          u.team === 0 ? <circle cx={x} cy={y} r={r} fill={hollow ? 'var(--bg)' : color} stroke={color} strokeWidth={2} /> : <rect x={x - r} y={y - r} width={2 * r} height={2 * r} rx={4} fill={hollow ? 'var(--bg)' : color} stroke={color} strokeWidth={2} />;
        return (
          <g key={u.seat} onClick={() => onToken?.(i)} style={{ cursor: onToken ? 'pointer' : undefined }}>
            <title>
              {u.seat} {u.name}: {u.hp}/{u.hpMax} HP, {u.life}
              {condMarkers(u.conds, u.conc, u.conc >= 0 ? fxName?.get(u.conc) : undefined)
                .map((m) => `, ${m.name}`)
                .join('')}
            </title>
            {i === active && <circle cx={x} cy={y} r={r + 5} fill="none" stroke="var(--fg)" strokeWidth={2} />}
            {pickable?.has(i) && <circle cx={x} cy={y} r={r + 8} fill="none" stroke="var(--accent)" strokeWidth={2.5} strokeDasharray="4 3" />}
            {shape}
            {u.life === 'dead' && <path d={`M${x - r * 0.6} ${y - r * 0.6}L${x + r * 0.6} ${y + r * 0.6}M${x + r * 0.6} ${y - r * 0.6}L${x - r * 0.6} ${y + r * 0.6}`} stroke="var(--bg)" strokeWidth={2} />}
            <text x={x} y={y + 4} textAnchor="middle" className={hollow ? 'seat hollow' : 'seat'}>
              {u.seat}
            </text>
            <rect x={x - r} y={y + r + 3} width={2 * r} height={4} fill="var(--rule)" />
            <rect x={x - r} y={y + r + 3} width={2 * r * frac} height={4} fill={color} />
            <Markers u={u} x={x} y={y} cell={cell} fxName={fxName} />
          </g>
        );
      })}
      {/* Zone outlines and names above the tokens: a creature standing in a zone mustn't hide it. */}
      {frame.zones.map((z) => {
        const k = ((zoneStyle.get(z.fx) ?? 0) % 4) + 1;
        const [ax, ay] = z.cells.length ? center(z.cells[0]!) : [0, 0];
        return (
          <g key={`o${z.fx}`} pointerEvents="none">
            <path d={zoneEdges(z.cells, w, cell)} stroke={`var(--zone-${k})`} strokeWidth={2.5} fill="none" />
            <text x={ax} y={ay - cell / 2 - 3} textAnchor="middle" className="zonelabel" fill={`var(--zone-${k})`}>
              {z.name}
            </text>
          </g>
        );
      })}
      {preview?.map((c) => (
        <rect key={`area${c}`} x={LABEL + (c % w) * cell} y={LABEL + Math.floor(c / w) * cell} width={cell} height={cell} className="areapreview" />
      ))}
      {cells?.map((c) => (
        <rect key={`pick${c.cell}`} x={LABEL + (c.cell % w) * cell + 2} y={LABEL + Math.floor(c.cell / w) * cell + 2} width={cell - 4} height={cell - 4} rx={3} className={`pickcell${c.risky ? ' risky' : ''}${c.hint ? ' hint' : ''}`} onClick={() => onCell?.(c.cell)} onMouseEnter={() => onCellHover?.(c.cell)} onMouseLeave={() => onCellHover?.(null)}>
          <title>{c.title}</title>
        </rect>
      ))}
      {m.delta &&
        (() => {
          const [x, y] = center(frame.units[m.delta.tgt]!.cell);
          return (
            <text x={x + cell * 0.42} y={y - cell * 0.42} className="delta" fill={m.delta.hp < 0 ? 'var(--bad)' : 'var(--accent)'}>
              {m.delta.hp > 0 ? `+${m.delta.hp}` : m.delta.hp}
            </text>
          );
        })()}
      <rect x={LABEL} y={LABEL} width={w * cell} height={h * cell} fill="none" stroke="var(--rule)" />
    </svg>
  );
}
