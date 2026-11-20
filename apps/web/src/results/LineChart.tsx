// Damage per round for one arm: a line per row of the report model (mean per fight; a fight that
// ended counts 0), with a legend (lines end near 0, so labels at their ends would collide);
// friendly fire dashed. It draws; it computes nothing.

import { fmt, type DamageCells, type DamageRow } from '@montecrit/engine';

const COLORS = ['var(--team0)', 'var(--zone-1)', 'var(--zone-2)', 'var(--zone-4)', 'var(--zone-3)'];

export function LineChart({ rows, cells, lastRound, yMax, width = 600, height = 200 }: { rows: readonly DamageRow[]; cells: readonly DamageCells[]; lastRound: number; yMax: number; width?: number; height?: number }) {
  const left = 34;
  const right = 12;
  const top = 8;
  const bottom = 20;
  const pw = width - left - right;
  const ph = height - top - bottom;
  const x = (r: number) => left + (lastRound > 1 ? ((r - 1) / (lastRound - 1)) * pw : pw / 2);
  const y = (v: number) => top + ph - (yMax > 0 ? (v / yMax) * ph : 0);
  const ticks = [0, yMax / 2, yMax];
  let pc = 0;
  const color = (row: DamageRow) => (row.group === 'enemy' ? 'var(--team1)' : row.group === 'ally' ? 'var(--muted)' : row.group === 'ff' ? 'var(--bad)' : COLORS[pc++ % COLORS.length]!);
  const styled = rows.map((row) => ({ row, c: color(row) }));
  return (
    <div className="linechart">
    <svg width={width} height={height} role="img" aria-label="Damage per round by source">
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={left} x2={left + pw} y1={y(t)} y2={y(t)} stroke="var(--grid)" />
          <text x={left - 4} y={y(t) + 4} textAnchor="end" className="axis">
            {fmt.fx(t, 1)}
          </text>
        </g>
      ))}
      {Array.from({ length: lastRound }, (_, i) => (
        <text key={i} x={x(i + 1)} y={height - 4} textAnchor="middle" className="axis">
          r{i + 1}
        </text>
      ))}
      {styled.map(({ row, c }, j) => {
        const pts = cells[j]!.perRound.map((v, i) => `${x(i + 1)},${y(v)}`).join(' ');
        return (
          <g key={row.label}>
            <title>
              {row.label}: {cells[j]!.perRound.map((v) => fmt.fx(v)).join(', ')}; total {fmt.fx(cells[j]!.total)}
            </title>
            <polyline points={pts} fill="none" stroke={c} strokeWidth={2} strokeDasharray={row.group === 'ff' ? '5 3' : undefined} />
          </g>
        );
      })}
    </svg>
    <ul className="legend">
      {styled.map(({ row, c }, j) => (
        <li key={row.label}>
          <svg width={22} height={10} aria-hidden="true">
            <line x1={0} x2={22} y1={5} y2={5} stroke={c} strokeWidth={2} strokeDasharray={row.group === 'ff' ? '5 3' : undefined} />
          </svg>{' '}
          {row.label} <span className="muted num">{fmt.fx(cells[j]!.total)}/fight</span>
        </li>
      ))}
    </ul>
    </div>
  );
}
