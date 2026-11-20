// An inline confidence-interval bar on a shared axis: track, interval, point. Numbers it draws
// come from the report's statistics; it computes none.

export interface CiBarProps {
  readonly value: number;
  readonly lo: number;
  readonly hi: number;
  /** Axis range (rates: 0..1; differences: symmetric around 0). */
  readonly min: number;
  readonly max: number;
  readonly title: string;
  /** Draws a zero line (differences). */
  readonly zero?: boolean;
  readonly width?: number;
}

export function CiBar({ value, lo, hi, min, max, title, zero = false, width = 140 }: CiBarProps) {
  const h = 12;
  const x = (v: number) => ((Math.min(max, Math.max(min, v)) - min) / (max - min || 1)) * width;
  return (
    <svg width={width} height={h} role="img" aria-label={title} style={{ verticalAlign: 'middle' }}>
      <title>{title}</title>
      <line x1={0} x2={width} y1={h / 2} y2={h / 2} stroke="var(--rule)" strokeWidth={1} />
      {zero && <line x1={x(0)} x2={x(0)} y1={0} y2={h} stroke="var(--zero)" strokeWidth={1} />}
      <line x1={x(lo)} x2={x(hi)} y1={h / 2} y2={h / 2} stroke="var(--ci)" strokeWidth={3} />
      <circle cx={x(value)} cy={h / 2} r={3} fill="var(--fg)" />
    </svg>
  );
}
