import type { VectorStyleStop } from "@geolibre/core";
import { useMemo, useState } from "react";
import { computeGraduatedHistogram } from "./graduated-histogram";

interface GraduatedHistogramProps {
  values: readonly unknown[] | undefined;
  stops: readonly VectorStyleStop[];
  binCount?: number;
}

function formatAxisNumber(value: number): string {
  if (!Number.isFinite(value)) return "";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${(value / 1_000).toFixed(1)}k`;
  if (Number.isInteger(value)) return String(value);
  return abs >= 100 ? value.toFixed(1) : value.toFixed(2);
}

/**
 * Compact inline SVG distribution histogram for Graduated Symbology, colored
 * by the active stop ramp with vertical class-break markers.
 */
export function GraduatedHistogram({ values, stops, binCount = 20 }: GraduatedHistogramProps) {
  const data = useMemo(
    () => computeGraduatedHistogram(values, stops, binCount),
    [values, stops, binCount],
  );
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  if (!data || data.maxCount === 0) return null;

  const width = 240;
  const height = 56;
  const barWidth = width / data.bins.length;
  const hovered = hoveredIdx !== null ? data.bins[hoveredIdx] : null;

  return (
    <div className="space-y-1 rounded-md border bg-muted/20 p-2" data-testid="graduated-histogram">
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span>
          {hovered
            ? `${formatAxisNumber(hovered.min)} .. ${formatAxisNumber(hovered.max)} (${hovered.count})`
            : `n = ${data.totalCount}`}
        </span>
        <span>
          {formatAxisNumber(data.min)} .. {formatAxisNumber(data.max)}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-14 w-full overflow-visible"
        role="img"
        aria-label="Attribute value distribution histogram"
        onMouseLeave={() => setHoveredIdx(null)}
      >
        {data.bins.map((bin, idx) => {
          const barHeight = bin.count > 0 ? Math.max(2, (bin.count / data.maxCount) * (height - 4)) : 0;
          const x = idx * barWidth;
          const y = height - barHeight;
          return (
            <rect
              key={idx}
              x={x + 0.5}
              y={y}
              width={Math.max(1, barWidth - 1)}
              height={barHeight}
              rx={1}
              fill={bin.color}
              fillOpacity={hoveredIdx === null || hoveredIdx === idx ? 0.88 : 0.45}
              onMouseEnter={() => setHoveredIdx(idx)}
            >
              <title>{`${formatAxisNumber(bin.min)} to ${formatAxisNumber(bin.max)}: ${bin.count}`}</title>
            </rect>
          );
        })}
        {data.breakPositions.map((brk, idx) => {
          const x = Math.max(1, Math.min(width - 1, brk.position * width));
          return (
            <line
              key={`brk-${idx}`}
              x1={x}
              x2={x}
              y1={0}
              y2={height}
              stroke="currentColor"
              strokeOpacity={0.55}
              strokeWidth={1}
              strokeDasharray="2 2"
              className="pointer-events-none text-foreground"
            />
          );
        })}
      </svg>
    </div>
  );
}
