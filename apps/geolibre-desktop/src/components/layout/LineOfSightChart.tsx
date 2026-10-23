import type { LineOfSightResult } from "@geolibre/processing";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CHART_HEIGHT,
  CHART_PADDING,
  CHART_WIDTH,
  lineOfSightChartModel,
  type UnitFormatter,
} from "../../lib/line-of-sight-chart";
import {
  LOS_HIDDEN_COLOR,
  LOS_OBSERVER_COLOR,
  LOS_OBSTRUCTION_COLOR,
  LOS_TARGET_COLOR,
  LOS_VISIBLE_COLOR,
} from "../../lib/line-of-sight-layer";

/**
 * The elevation profile under the line, drawn with the elevation-profile
 * plugin's chart geometry: the ground coloured by visibility, the sight line
 * from the observer's eye to the target's top dashed over it, and the first
 * obstruction marked.
 */
export function LineOfSightChart({
  result,
  units,
}: {
  result: LineOfSightResult;
  units: UnitFormatter;
}) {
  const { t } = useTranslation();
  const [hover, setHover] = useState<number | null>(null);

  const chart = useMemo(() => lineOfSightChartModel(result), [result]);

  const { geometry, samples } = chart;
  const hovered = hover !== null ? samples[hover] : null;
  const first = result.samples[0];
  const last = result.samples[result.samples.length - 1];
  const obstruction = result.firstObstruction;

  return (
    <svg
      role="img"
      aria-label={t("lineOfSight.chartLabel")}
      viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
      className="w-full select-none"
      onPointerMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const x = ((event.clientX - rect.left) / rect.width) * CHART_WIDTH;
        setHover(geometry.indexForX(x));
      }}
      onPointerLeave={() => setHover(null)}
    >
      <path d={geometry.areaPath} style={{ fill: "hsl(var(--muted-foreground) / 0.15)" }} />
      {chart.runs.map((run, index) => (
        <polyline
          key={index}
          points={run.points}
          fill="none"
          stroke={run.visible ? LOS_VISIBLE_COLOR : LOS_HIDDEN_COLOR}
          strokeWidth={2}
          strokeLinejoin="round"
        />
      ))}
      <polyline
        points={chart.sightline}
        fill="none"
        strokeWidth={1.25}
        strokeDasharray="4 3"
        style={{ stroke: "hsl(var(--foreground))" }}
      />
      <circle
        cx={geometry.xScale(first.distance)}
        cy={geometry.yScale(result.observer.eyeMeters)}
        r={3.5}
        fill={LOS_OBSERVER_COLOR}
      />
      <circle
        cx={geometry.xScale(last.distance)}
        cy={geometry.yScale(result.target.topMeters)}
        r={3.5}
        fill={LOS_TARGET_COLOR}
      />
      {obstruction && (
        <circle
          cx={geometry.xScale(obstruction.distance)}
          cy={geometry.yScale(obstruction.elevation)}
          r={3.5}
          fill={LOS_OBSTRUCTION_COLOR}
          stroke="#ffffff"
          strokeWidth={1}
        />
      )}
      <text
        x={CHART_PADDING.left - 4}
        y={CHART_PADDING.top + 8}
        textAnchor="end"
        fontSize={9}
        style={{ fill: "hsl(var(--muted-foreground))" }}
      >
        {units.elevation(geometry.maxElevation)}
      </text>
      <text
        x={CHART_PADDING.left - 4}
        y={CHART_HEIGHT - CHART_PADDING.bottom}
        textAnchor="end"
        fontSize={9}
        style={{ fill: "hsl(var(--muted-foreground))" }}
      >
        {units.elevation(geometry.minElevation)}
      </text>
      <text
        x={CHART_WIDTH - CHART_PADDING.right}
        y={CHART_HEIGHT - 3}
        textAnchor="end"
        fontSize={9}
        style={{ fill: "hsl(var(--muted-foreground))" }}
      >
        {units.distance(result.totalDistance)}
      </text>
      {hovered && (
        <g pointerEvents="none">
          <line
            x1={geometry.xScale(hovered.distance)}
            x2={geometry.xScale(hovered.distance)}
            y1={CHART_PADDING.top}
            y2={CHART_HEIGHT - CHART_PADDING.bottom}
            strokeWidth={1}
            style={{ stroke: "hsl(var(--muted-foreground))" }}
          />
          <text
            x={CHART_PADDING.left + 4}
            y={CHART_HEIGHT - 3}
            fontSize={9}
            style={{ fill: "hsl(var(--foreground))" }}
          >
            {`${units.distance(hovered.distance)} · ${units.elevation(hovered.elevation)}`}
          </text>
        </g>
      )}
    </svg>
  );
}
