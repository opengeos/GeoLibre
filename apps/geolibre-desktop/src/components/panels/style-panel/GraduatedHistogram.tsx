import type { VectorStyleStop } from "@geolibre/core";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { computeGraduatedHistogram } from "./graduated-histogram";

interface GraduatedHistogramProps {
  values: readonly unknown[] | undefined;
  stops: readonly VectorStyleStop[];
  binCount?: number;
}

export function formatAxisNumber(value: number): string {
  if (!Number.isFinite(value)) return "";
  const abs = Math.abs(value);
  if (abs === 0) return "0";
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${(value / 1_000).toFixed(1)}k`;
  if (Number.isInteger(value)) return String(value);
  if (abs < 0.001) return value.toExponential(2);
  if (abs < 1) return Number(value.toPrecision(3)).toString();
  return abs >= 100 ? value.toFixed(1) : value.toFixed(2);
}

/**
 * Compact inline SVG distribution histogram for Graduated Symbology, colored
 * by the active stop ramp with vertical class-break markers.
 */
export function GraduatedHistogram({ values, stops, binCount = 20 }: GraduatedHistogramProps) {
  const { t } = useTranslation();
  const data = useMemo(
    () => computeGraduatedHistogram(values, stops, binCount),
    [values, stops, binCount],
  );
  const [activeIdx, setActiveIdx] = useState<number | null>(null);

  if (!data || data.maxCount === 0) return null;

  const width = 240;
  const height = 56;
  const barWidth = width / data.bins.length;
  const activeBin = activeIdx !== null ? data.bins[activeIdx] : null;

  return (
    <div className="space-y-1 rounded-md border bg-muted/20 p-2" data-testid="graduated-histogram">
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span>
          {activeBin
            ? `${formatAxisNumber(activeBin.min)} .. ${formatAxisNumber(activeBin.max)} (${activeBin.count})`
            : t("style.graduatedHistogram.sampleCount", { count: data.totalCount })}
        </span>
        <span>
          {formatAxisNumber(data.min)} .. {formatAxisNumber(data.max)}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-14 w-full overflow-visible"
        role="img"
        aria-label={t("style.graduatedHistogram.ariaLabel")}
        onMouseLeave={() => setActiveIdx(null)}
      >
        {data.bins.map((bin, idx) => {
          const barHeight =
            bin.count > 0 ? Math.max(2, (bin.count / data.maxCount) * (height - 4)) : 0;
          const x = idx * barWidth;
          const y = height - barHeight;
          const binLabel = t("style.graduatedHistogram.binSummary", {
            min: formatAxisNumber(bin.min),
            max: formatAxisNumber(bin.max),
            count: bin.count,
          });
          return (
            <rect
              key={idx}
              x={x + 0.5}
              y={y}
              width={Math.max(1, barWidth - 1)}
              height={barHeight}
              rx={1}
              fill={bin.color}
              fillOpacity={activeIdx === null || activeIdx === idx ? 0.88 : 0.45}
              tabIndex={bin.count > 0 ? 0 : undefined}
              role={bin.count > 0 ? "button" : undefined}
              aria-label={bin.count > 0 ? binLabel : undefined}
              className="focus:outline-none focus:stroke-foreground"
              onMouseEnter={() => setActiveIdx(idx)}
              onFocus={() => setActiveIdx(idx)}
              onBlur={() => setActiveIdx((prev) => (prev === idx ? null : prev))}
            >
              <title>{binLabel}</title>
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
