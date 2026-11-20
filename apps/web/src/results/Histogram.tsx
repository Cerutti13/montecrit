// A small histogram from the report model's bins (shares of fights); y is shared across the
// small multiples so arms compare by eye. It draws; it computes nothing.

import { fmt, type DprBin } from '@montecrit/engine';

export function Histogram({ bins, yMax, label, width = 240, height = 70 }: { bins: readonly DprBin[]; yMax: number; label: string; width?: number; height?: number }) {
  const bw = width / bins.length;
  const y = (s: number) => (yMax > 0 ? (s / yMax) * (height - 14) : 0);
  const name = (b: DprBin) => (b.hi === null ? `${b.lo}+` : b.hi === b.lo ? `${b.lo}` : `${b.lo}-${b.hi}`);
  return (
    <svg width={width} height={height} role="img" aria-label={`${label} PC damage per round per fight`}>
      {bins.map((b, i) => (
        <rect key={i} x={i * bw + 1} y={height - 12 - y(b.share)} width={Math.max(1, bw - 2)} height={y(b.share)} fill="var(--team0)">
          <title>
            {name(b)} HP/round: {fmt.pct(b.share)} of fights ({fmt.int(b.count)})
          </title>
        </rect>
      ))}
      <line x1={0} x2={width} y1={height - 12} y2={height - 12} stroke="var(--rule)" />
      <text x={0} y={height - 1} className="axis">
        {name(bins[0]!)}
      </text>
      <text x={width} y={height - 1} textAnchor="end" className="axis">
        {name(bins[bins.length - 1]!)}
      </text>
    </svg>
  );
}
