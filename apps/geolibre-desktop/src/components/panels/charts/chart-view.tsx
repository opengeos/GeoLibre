/**
 * Shared chart rendering for the attribute Charts dialog and the Dashboard
 * panel. A {@link ChartSpec} (chart type plus the field(s) it plots) is turned
 * into a typed {@link ChartResult} by {@link computeChart}, which {@link
 * ChartView} draws as a self-scaling inline SVG. Kept dependency-free (no
 * charting library) and themed via CSS variables so both surfaces look the same.
 */
import { type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  formatAxisValue,
  type BarAggregation,
  type BarResult,
  type BoxResult,
  type HistogramResult,
  type LineResult,
  type PieResult,
  type ScatterResult,
} from "../../../lib/attribute-charts";
import { type ChartResult } from "./chart-spec";
import { categoryColors, isHexColor } from "./chart-colors";

export { chartResultHasData, computeChart, type ChartResult, type ChartSpec } from "./chart-spec";

/**
 * Render a computed {@link ChartResult} as an inline SVG with a caption.
 * `color` (a hex string) customizes the marks: it is the series color for
 * single-series charts (histogram/line/scatter/box) and the base of a
 * monochromatic ramp for categorical charts (bar/pie). When unset, single-series
 * charts use the theme primary and categorical charts use the multi-color
 * palette.
 */
export function ChartView({ result, color }: { result: ChartResult; color?: string }) {
  // Effective single-series color: the chosen hex, else the theme primary.
  const series = isHexColor(color) ? color : SERIES;
  switch (result.type) {
    case "histogram":
      return <HistogramChart result={result.result} field={result.field} color={series} />;
    case "scatter":
      return (
        <ScatterChart
          result={result.result}
          xField={result.xField}
          yField={result.yField}
          color={series}
        />
      );
    case "bar":
      return (
        <BarChart
          result={result.result}
          aggregation={result.aggregation}
          category={result.category}
          color={color}
        />
      );
    case "line":
      return <LineChart result={result.result} field={result.field} color={series} />;
    case "box":
      return <BoxChart result={result.result} field={result.field} color={series} />;
    case "pie":
      return (
        <PieChart
          result={result.result}
          aggregation={result.aggregation}
          category={result.category}
          color={color}
        />
      );
  }
}

// SVG geometry. The chart scales to its container via viewBox/width=100%.
export const CHART_W = 560;
export const CHART_H = 300;
const MARGIN = { top: 16, right: 16, bottom: 52, left: 52 };
const INNER_W = CHART_W - MARGIN.left - MARGIN.right;
const INNER_H = CHART_H - MARGIN.top - MARGIN.bottom;

const AXIS = "hsl(var(--border))";
const TICK = "hsl(var(--muted-foreground))";
const SERIES = "hsl(var(--primary))";

/** Map a value within [min, max] to a 0..1 fraction, centering a flat range. */
function fraction(value: number, min: number, max: number): number {
  if (max === min) return 0.5;
  return (value - min) / (max - min);
}

function truncateLabel(label: string, max = 14): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

function ChartFrame({ label, children }: { label: string; children: ReactNode }) {
  return (
    <svg
      viewBox={`0 0 ${CHART_W} ${CHART_H}`}
      width="100%"
      role="img"
      aria-label={label}
      className="h-auto w-full"
      preserveAspectRatio="xMidYMid meet"
    >
      <line
        x1={MARGIN.left}
        y1={MARGIN.top}
        x2={MARGIN.left}
        y2={MARGIN.top + INNER_H}
        stroke={AXIS}
      />
      <line
        x1={MARGIN.left}
        y1={MARGIN.top + INNER_H}
        x2={MARGIN.left + INNER_W}
        y2={MARGIN.top + INNER_H}
        stroke={AXIS}
      />
      {children}
    </svg>
  );
}

function tickText(
  x: number,
  y: number,
  text: string,
  anchor: "start" | "middle" | "end",
  baseline: "middle" | "auto" = "auto",
) {
  return (
    <text x={x} y={y} textAnchor={anchor} dominantBaseline={baseline} fontSize={10} fill={TICK}>
      {text}
    </text>
  );
}

function axisTitle(text: string) {
  return (
    <text
      x={MARGIN.left + INNER_W / 2}
      y={CHART_H - 4}
      textAnchor="middle"
      fontSize={11}
      fill={TICK}
    >
      {text}
    </text>
  );
}

function yAxisTitle(text: string) {
  const cy = MARGIN.top + INNER_H / 2;
  return (
    <text
      x={12}
      y={cy}
      textAnchor="middle"
      fontSize={11}
      fill={TICK}
      transform={`rotate(-90 12 ${cy})`}
    >
      {text}
    </text>
  );
}

function EmptyChart({ message }: { message: string }) {
  // flex-1 only acts when the element grows (in the Dashboard's flexed card),
  // where it centers the message like the panel's own no-data state; in the
  // Charts dialog the <p> is simply a flex box around a single text node.
  return (
    <p className="flex flex-1 items-center justify-center py-10 text-center text-sm text-muted-foreground">
      {message}
    </p>
  );
}

function Caption({ children }: { children: ReactNode }) {
  // shrink-0 keeps the caption legible when the Dashboard flexes the chart SVG
  // to fill a short panel; it is a no-op in the non-flex Charts dialog.
  return <p className="mt-1 shrink-0 text-center text-xs text-muted-foreground">{children}</p>;
}

function HistogramChart({
  result,
  field,
  color,
}: {
  result: HistogramResult | null;
  field: string;
  color: string;
}) {
  const { t } = useTranslation();
  if (!result) return <EmptyChart message={t("dashboard.chart.emptyNumeric")} />;

  const { bins, maxCount, min, max, total } = result;
  const slot = INNER_W / bins.length;
  const gap = Math.min(4, slot * 0.15);

  return (
    <>
      <ChartFrame label={`Histogram of ${field}`}>
        {tickText(MARGIN.left - 6, MARGIN.top + INNER_H, "0", "end", "middle")}
        {tickText(MARGIN.left - 6, MARGIN.top, String(maxCount), "end", "middle")}
        {bins.map((bin, index) => {
          const height = maxCount === 0 ? 0 : (bin.count / maxCount) * INNER_H;
          return (
            <rect
              key={index}
              x={MARGIN.left + index * slot + gap / 2}
              y={MARGIN.top + INNER_H - height}
              width={Math.max(1, slot - gap)}
              height={height}
              fill={color}
              opacity={0.85}
            >
              <title>{`[${formatAxisValue(bin.x0)}, ${formatAxisValue(bin.x1)}${
                index === bins.length - 1 ? "]" : ")"
              }: ${bin.count}`}</title>
            </rect>
          );
        })}
        {/* A collapsed (min === max) histogram spans the full width, so show a
            single centered label instead of identical min/max labels. */}
        {min === max ? (
          tickText(
            MARGIN.left + INNER_W / 2,
            MARGIN.top + INNER_H + 14,
            formatAxisValue(min),
            "middle",
          )
        ) : (
          <>
            {tickText(MARGIN.left, MARGIN.top + INNER_H + 14, formatAxisValue(min), "start")}
            {tickText(
              MARGIN.left + INNER_W,
              MARGIN.top + INNER_H + 14,
              formatAxisValue(max),
              "end",
            )}
          </>
        )}
        {axisTitle(field)}
      </ChartFrame>
      <Caption>
        {total.toLocaleString()} value{total === 1 ? "" : "s"} · count on y
      </Caption>
    </>
  );
}

function ScatterChart({
  result,
  xField,
  yField,
  color,
}: {
  result: ScatterResult | null;
  xField: string;
  yField: string;
  color: string;
}) {
  const { t } = useTranslation();
  if (!result) {
    return <EmptyChart message={t("dashboard.chart.emptyScatter")} />;
  }

  const { points, total, xMin, xMax, yMin, yMax } = result;
  const sampled = total > points.length;

  return (
    <>
      <ChartFrame label={`Scatter plot of ${yField} versus ${xField}`}>
        {/* Single centered tick when an axis is flat (all values identical),
            mirroring the histogram, rather than the same value at both ends. */}
        {yMin === yMax ? (
          tickText(
            MARGIN.left - 6,
            MARGIN.top + INNER_H / 2,
            formatAxisValue(yMin),
            "end",
            "middle",
          )
        ) : (
          <>
            {tickText(MARGIN.left - 6, MARGIN.top, formatAxisValue(yMax), "end", "middle")}
            {tickText(
              MARGIN.left - 6,
              MARGIN.top + INNER_H,
              formatAxisValue(yMin),
              "end",
              "middle",
            )}
          </>
        )}
        {points.map((point, index) => {
          const cx = MARGIN.left + fraction(point.x, xMin, xMax) * INNER_W;
          const cy = MARGIN.top + INNER_H - fraction(point.y, yMin, yMax) * INNER_H;
          return (
            <circle key={index} cx={cx} cy={cy} r={3} fill={color} opacity={0.6}>
              <title>{`${xField}: ${formatAxisValue(point.x)}, ${yField}: ${formatAxisValue(point.y)}`}</title>
            </circle>
          );
        })}
        {xMin === xMax ? (
          tickText(
            MARGIN.left + INNER_W / 2,
            MARGIN.top + INNER_H + 14,
            formatAxisValue(xMin),
            "middle",
          )
        ) : (
          <>
            {tickText(MARGIN.left, MARGIN.top + INNER_H + 14, formatAxisValue(xMin), "start")}
            {tickText(
              MARGIN.left + INNER_W,
              MARGIN.top + INNER_H + 14,
              formatAxisValue(xMax),
              "end",
            )}
          </>
        )}
        {axisTitle(xField)}
        {yAxisTitle(yField)}
      </ChartFrame>
      <Caption>
        {total.toLocaleString()} point{total === 1 ? "" : "s"} · {yField} vs {xField}
        {sampled ? ` · showing ${points.length.toLocaleString()} sampled` : ""}
      </Caption>
    </>
  );
}

function BarChart({
  result,
  aggregation,
  category,
  color,
}: {
  result: BarResult | null;
  aggregation: BarAggregation;
  category: string;
  color?: string;
}) {
  const { t } = useTranslation();
  if (!result) return <EmptyChart message={t("dashboard.chart.emptyBar")} />;

  const { bars, maxValue, minValue, truncated } = result;
  const colors = categoryColors(color, bars.length);
  const domainMin = Math.min(0, minValue);
  // Keep 0 as the top of the scale when every bar is <= 0 (possible for
  // sum/mean); only fall back to 1 when the domain would otherwise be zero-width
  // (all bars exactly 0). `Math.max(0, maxValue) || 1` wrongly made an
  // all-negative domain top out at 1.
  const domainMax = maxValue > 0 ? maxValue : minValue < 0 ? 0 : 1;
  const slot = INNER_W / bars.length;
  const gap = Math.min(6, slot * 0.2);
  const scaleY = (value: number) =>
    MARGIN.top + INNER_H - fraction(value, domainMin, domainMax) * INNER_H;
  const baselineY = scaleY(0);

  return (
    <>
      <ChartFrame label={`Bar chart of ${aggregation} by ${category}`}>
        {/* Top tick only when the domain extends above 0; when all bars are
            <= 0 the domain tops at 0 and the baseline tick already labels it. */}
        {domainMax > 0
          ? tickText(MARGIN.left - 6, MARGIN.top, formatAxisValue(domainMax), "end", "middle")
          : null}
        {tickText(MARGIN.left - 6, baselineY, "0", "end", "middle")}
        {/* Lower-bound tick when bars go negative (sum/mean of negative values). */}
        {minValue < 0
          ? tickText(
              MARGIN.left - 6,
              MARGIN.top + INNER_H,
              formatAxisValue(domainMin),
              "end",
              "middle",
            )
          : null}
        {bars.map((datum, index) => {
          const top = Math.min(baselineY, scaleY(datum.value));
          const height = Math.abs(scaleY(datum.value) - baselineY);
          const cx = MARGIN.left + index * slot + slot / 2;
          return (
            <g key={datum.label}>
              <rect
                x={MARGIN.left + index * slot + gap / 2}
                y={top}
                width={Math.max(1, slot - gap)}
                height={Math.max(0, height)}
                fill={colors[index]}
                opacity={0.9}
              >
                <title>{`${datum.label}: ${formatAxisValue(datum.value)} (${datum.count} row${datum.count === 1 ? "" : "s"})`}</title>
              </rect>
              <text
                x={cx}
                y={MARGIN.top + INNER_H + 12}
                textAnchor="end"
                fontSize={9}
                fill={TICK}
                transform={`rotate(-40 ${cx} ${MARGIN.top + INNER_H + 12})`}
              >
                {truncateLabel(datum.label)}
              </text>
            </g>
          );
        })}
      </ChartFrame>
      <Caption>
        {aggregation === "count"
          ? "row count"
          : aggregation === "sum"
            ? "sum on y"
            : "average on y"}
        {truncated > 0 ? ` · top ${bars.length} (${truncated} more hidden)` : ""}
      </Caption>
    </>
  );
}

function LineChart({
  result,
  field,
  color,
}: {
  result: LineResult | null;
  field: string;
  color: string;
}) {
  const { t } = useTranslation();
  if (!result) return <EmptyChart message={t("dashboard.chart.emptyNumeric")} />;

  const { points, min, max, length } = result;
  const scaleX = (index: number) =>
    MARGIN.left + (length > 1 ? index / (length - 1) : 0.5) * INNER_W;
  const scaleY = (value: number) => MARGIN.top + INNER_H - fraction(value, min, max) * INNER_H;
  const path = points
    .map((p, i) => {
      // Break the line (start a new subpath) when rows are non-consecutive, so
      // a gap from skipped (non-numeric) rows shows as a gap rather than a
      // straight segment across it.
      const command = i === 0 || p.index !== points[i - 1].index + 1 ? "M" : "L";
      return `${command}${scaleX(p.index)} ${scaleY(p.value)}`;
    })
    .join(" ");

  return (
    <>
      <ChartFrame label={`Line chart of ${field} by feature order`}>
        {tickText(MARGIN.left - 6, MARGIN.top, formatAxisValue(max), "end", "middle")}
        {tickText(MARGIN.left - 6, MARGIN.top + INNER_H, formatAxisValue(min), "end", "middle")}
        <path d={path} fill="none" stroke={color} strokeWidth={1.5} />
        {points.length <= 80
          ? points.map((p) => (
              <circle key={p.index} cx={scaleX(p.index)} cy={scaleY(p.value)} r={2} fill={color}>
                <title>{`#${p.index}: ${formatAxisValue(p.value)}`}</title>
              </circle>
            ))
          : null}
        {/* A single-feature layer has only index 0; show one centered label
            instead of "0" at both ends. */}
        {length <= 1 ? (
          tickText(MARGIN.left + INNER_W / 2, MARGIN.top + INNER_H + 14, "0", "middle")
        ) : (
          <>
            {tickText(MARGIN.left, MARGIN.top + INNER_H + 14, "0", "start")}
            {tickText(MARGIN.left + INNER_W, MARGIN.top + INNER_H + 14, String(length - 1), "end")}
          </>
        )}
        {axisTitle("feature order")}
      </ChartFrame>
      <Caption>
        {points.length.toLocaleString()} value{points.length === 1 ? "" : "s"} · {field} by feature
        order
      </Caption>
    </>
  );
}

function BoxChart({
  result,
  field,
  color,
}: {
  result: BoxResult | null;
  field: string;
  color: string;
}) {
  const { t } = useTranslation();
  if (!result) return <EmptyChart message={t("dashboard.chart.emptyNumeric")} />;

  const { min, q1, median, q3, max, count } = result;
  const centerX = MARGIN.left + INNER_W / 2;
  const boxWidth = 96;
  const scaleY = (value: number) => MARGIN.top + INNER_H - fraction(value, min, max) * INNER_H;

  const stats: [string, number][] = [
    ["max", max],
    ["Q3", q3],
    ["median", median],
    ["Q1", q1],
    ["min", min],
  ];

  return (
    <>
      <ChartFrame label={`Box plot of ${field}`}>
        {/* whisker */}
        <line x1={centerX} y1={scaleY(min)} x2={centerX} y2={scaleY(max)} stroke={AXIS} />
        <line x1={centerX - 20} y1={scaleY(max)} x2={centerX + 20} y2={scaleY(max)} stroke={AXIS} />
        <line x1={centerX - 20} y1={scaleY(min)} x2={centerX + 20} y2={scaleY(min)} stroke={AXIS} />
        {/* box */}
        <rect
          x={centerX - boxWidth / 2}
          y={scaleY(q3)}
          width={boxWidth}
          height={Math.max(1, scaleY(q1) - scaleY(q3))}
          fill={color}
          opacity={0.25}
          stroke={color}
        />
        <line
          x1={centerX - boxWidth / 2}
          y1={scaleY(median)}
          x2={centerX + boxWidth / 2}
          y2={scaleY(median)}
          stroke={color}
          strokeWidth={2}
        />
        {/* When every value is identical the five stats share one y position;
            show a single label instead of five overlapping ones. */}
        {min === max
          ? tickText(
              centerX + boxWidth / 2 + 8,
              scaleY(median),
              `all = ${formatAxisValue(median)}`,
              "start",
              "middle",
            )
          : stats.map(([label, value]) => (
              <text
                key={label}
                x={centerX + boxWidth / 2 + 8}
                y={scaleY(value)}
                textAnchor="start"
                dominantBaseline="middle"
                fontSize={10}
                fill={TICK}
              >
                {`${label} ${formatAxisValue(value)}`}
              </text>
            ))}
        {axisTitle(field)}
      </ChartFrame>
      <Caption>
        {count.toLocaleString()} value{count === 1 ? "" : "s"} · five-number summary
      </Caption>
    </>
  );
}

function PieChart({
  result,
  aggregation,
  category,
  color,
}: {
  result: PieResult | null;
  aggregation: BarAggregation;
  category: string;
  color?: string;
}) {
  const { t } = useTranslation();
  if (!result) return <EmptyChart message={t("dashboard.chart.emptyPie")} />;

  const { slices, total } = result;
  const colors = categoryColors(color, slices.length);
  const radius = INNER_H / 2 - 6;
  const cx = MARGIN.left + radius;
  const cy = MARGIN.top + INNER_H / 2;
  const legendX = cx + radius + 24;
  const legendStep = Math.min(22, INNER_H / Math.max(slices.length, 1));

  // Slice angles run from the top (12 o'clock) clockwise. Each start angle is
  // derived from the prefix sum of prior slice values, so the map stays pure
  // (no mutation of an outer accumulator). Slice counts are tiny (<= 8).
  const START = -Math.PI / 2;
  const arcs = slices.map((slice, index) => {
    // `share` (not `fraction`) so it doesn't shadow the module-level helper.
    const share = slice.value / total;
    const prior = slices.slice(0, index).reduce((sum, s) => sum + s.value, 0);
    const start = START + (prior / total) * Math.PI * 2;
    const end = start + share * Math.PI * 2;
    const x0 = cx + radius * Math.cos(start);
    const y0 = cy + radius * Math.sin(start);
    const x1 = cx + radius * Math.cos(end);
    const y1 = cy + radius * Math.sin(end);
    const largeArc = end - start > Math.PI ? 1 : 0;
    // A lone slice is a full circle, which a single arc cannot express; draw it
    // as two half-circle arcs instead.
    const d =
      slices.length === 1
        ? `M ${cx - radius} ${cy} A ${radius} ${radius} 0 1 1 ${cx + radius} ${cy} A ${radius} ${radius} 0 1 1 ${cx - radius} ${cy} Z`
        : `M ${cx} ${cy} L ${x0} ${y0} A ${radius} ${radius} 0 ${largeArc} 1 ${x1} ${y1} Z`;
    return { d, color: colors[index], slice, share };
  });

  return (
    <>
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        width="100%"
        role="img"
        aria-label={`Pie chart of ${aggregation} by ${category}`}
        className="h-auto w-full"
        preserveAspectRatio="xMidYMid meet"
      >
        {arcs.map(({ d, color: fill, slice }) => (
          <path key={slice.label} d={d} fill={fill} stroke="hsl(var(--background))" strokeWidth={1}>
            <title>{`${slice.label}: ${formatAxisValue(slice.value)} (${Math.round(
              (slice.value / total) * 100,
            )}%)`}</title>
          </path>
        ))}
        {arcs.map(({ color: fill, slice, share }, index) => {
          const y = MARGIN.top + index * legendStep;
          return (
            <g key={`legend-${slice.label}`}>
              <rect x={legendX} y={y} width={10} height={10} rx={2} fill={fill} />
              <text x={legendX + 16} y={y + 5} dominantBaseline="middle" fontSize={11} fill={TICK}>
                {`${truncateLabel(slice.label, 18)} · ${Math.round(share * 100)}%`}
              </text>
            </g>
          );
        })}
      </svg>
      <Caption>
        {t(
          aggregation === "count"
            ? "dashboard.chart.pieCaptionCount"
            : "dashboard.chart.pieCaptionSum",
          { count: slices.length },
        )}
      </Caption>
    </>
  );
}
