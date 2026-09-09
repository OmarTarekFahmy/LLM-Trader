/**
 * Minimal NAV sparkline built from real equity-curve points. Not decorative:
 * it is a chart of the strategy's value over time. No library.
 */
export default function Sparkline({
  values,
  width = 96,
  height = 26,
  color,
}: {
  values: number[];
  width?: number;
  height?: number;
  color: string;
}) {
  const pts = values.filter((v) => Number.isFinite(v));
  const min = pts.length ? Math.min(...pts) : 0;
  const max = pts.length ? Math.max(...pts) : 0;
  const span = max - min;

  // Hide until there's a real curve to show (enough points AND some movement).
  if (pts.length < 5 || span / (max || 1) < 0.0005) {
    return <svg className="spark" width={width} height={height} aria-hidden />;
  }
  const pad = 2;

  const d = pts
    .map((v, i) => {
      const x = pad + (i / (pts.length - 1)) * (width - pad * 2);
      const y = pad + (1 - (v - min) / span) * (height - pad * 2);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg
      className="spark"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="NAV over time"
    >
      <path d={d} stroke={color} />
    </svg>
  );
}
