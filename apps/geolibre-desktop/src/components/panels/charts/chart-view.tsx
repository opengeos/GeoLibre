/**
 * Shared chart rendering for the attribute Charts dialog and the Dashboard
 * panel. A {@link ChartSpec} (chart type plus the field(s) it plots) is turned
 * into a typed {@link ChartResult} by {@link computeChart}, which {@link
 * ChartView} draws as an inline SVG. Kept dependency-free (no charting library)
 * and themed via CSS variables so both surfaces look the same.
 *
 * Two sizing modes: the Charts dialog draws at a fixed {@link CHART_W} ×
 * {@link CHART_H} viewBox scaled to its width (the size its SVG/PNG export
 * uses), while a Dashboard card passes `fill` and the chart is drawn at the
 * card's measured pixel size, so tick and category labels stay at
 * {@link CHART_LABEL_FONT_SIZE}px however small the card is.
 */
import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  type ReactNode,
  type SVGProps,
} from "react";
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
import {
  CHART_LABEL_FONT_SIZE,
  createTextMeasurer,
  truncateToWidth,
  type TextMeasurer,
} from "./chart-text";

export { chartResultHasData, computeChart, type ChartResult, type ChartSpec } from "./chart-spec";

/**
 * Render a computed {@link ChartResult} as an inline SVG with a caption.
 * `color` (a hex string) customizes the marks: it is the series color for
 * single-series charts (histogram/line/scatter/box) and the base of a
 * monochromatic ramp for categorical charts (bar/pie). When unset, single-series
 * charts use the theme primary and categorical charts use the multi-color
 * palette.
 *
 * `fill` draws the chart at the measured size of the flex column it sits in
 * (the Dashboard card) instead of scaling the fixed 560×300 frame to its width.
 */
export function ChartView({
  result,
  color,
  fill = false,
}: {
  result: ChartResult;
  color?: string;
  fill?: boolean;
}) {
  return (
    <ChartSizingContext.Provider value={fill ? "fill" : "fixed"}>
      <ChartBody result={result} color={color} />
    </ChartSizingContext.Provider>
  );
}

function ChartBody({ result, color }: { result: ChartResult; color?: string }) {
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

// Fixed geometry of the Charts dialog (and its SVG/PNG export): a 560×300
// viewBox scaled to the container's width.
export const CHART_W = 560;
export const CHART_H = 300;
const MARGIN: Margin = { top: 16, right: 16, bottom: 52, left: 52 };
const FIXED_SIZE: ChartSize = { width: CHART_W, height: CHART_H };

const AXIS = "hsl(var(--border))";
const TICK = "hsl(var(--muted-foreground))";
const SERIES = "hsl(var(--primary))";
const LABEL = CHART_LABEL_FONT_SIZE;
/** Baseline offset of an x-axis tick label below the plot. */
const X_TICK_OFFSET = 14;
// Rotated (-40°) category labels: their slope, and the smallest bar slot that
// keeps neighbouring labels from overlapping (label line height / sin 40°).
const ROTATE_SIN = Math.sin((40 * Math.PI) / 180);
const ROTATE_COS = Math.cos((40 * Math.PI) / 180);
const MIN_ROTATED_SLOT = 20;
/** Text width a fill-mode pie keeps free for its legend beside the pie. */
const PIE_LEGEND_MIN_TEXT = 72;

interface ChartSize {
  width: number;
  height: number;
}

interface Margin {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** The drawing area: the SVG size plus the inner plot rectangle. */
interface Plot {
  width: number;
  height: number;
  left: number;
  top: number;
  innerW: number;
  innerH: number;
}

type ChartSizing = "fixed" | "fill";
const ChartSizingContext = createContext<ChartSizing>("fixed");

/** What a chart needs to lay itself out: the sizing mode, a ref for the
 * element to measure, and the size to draw at (null until first measured). */
interface ChartFrameSize {
  sizing: ChartSizing;
  frameRef: (element: HTMLDivElement | null) => void;
  size: ChartSize | null;
}

/**
 * The size a chart draws at. In the dialog's fixed mode it is always the
 * 560×300 frame. In fill mode it is the measured size of the frame's wrapper,
 * taken in a layout effect (before paint, so the chart appears at its final
 * size without a jump) and kept current with a `ResizeObserver`.
 */
function useChartSize(): ChartFrameSize {
  const sizing = useContext(ChartSizingContext);
  // A callback ref held in state, so the effect re-runs if the wrapper first
  // mounts after the chart did (an empty state turning into data).
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [measured, setMeasured] = useState<ChartSize | null>(null);

  useLayoutEffect(() => {
    if (sizing !== "fill" || !element) return;
    const update = (width: number, height: number) => {
      const w = Math.floor(width);
      const h = Math.floor(height);
      setMeasured((prev) => {
        if (w <= 0 || h <= 0) return null;
        return prev && prev.width === w && prev.height === h ? prev : { width: w, height: h };
      });
    };
    update(element.clientWidth, element.clientHeight);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) update(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [sizing, element]);

  return { sizing, frameRef: setElement, size: sizing === "fill" ? measured : FIXED_SIZE };
}

let labelMeasurer: TextMeasurer | null = null;

/** Width in CSS px of `text` set as a chart label (canvas-measured when
 * possible, estimated otherwise). */
function measureLabel(text: string): number {
  labelMeasurer ??= createTextMeasurer(LABEL);
  return labelMeasurer(text);
}

/**
 * Margins around the plot. The fixed frame keeps its historical margins; a
 * measured chart sizes the left margin to its widest y tick label and the
 * bottom margin to the rows it actually draws, so a small card spends its
 * pixels on the plot.
 */
function axisMargin(
  sizing: ChartSizing,
  {
    yTicks = [],
    yTitle = false,
    xTicks = true,
    xTitle = true,
  }: { yTicks?: string[]; yTitle?: boolean; xTicks?: boolean; xTitle?: boolean },
): Margin {
  if (sizing === "fixed") return MARGIN;
  const tickWidth = Math.max(0, ...yTicks.map(measureLabel));
  return {
    // Half a label of headroom so a tick centered on the top edge isn't clipped.
    top: 8,
    right: 12,
    bottom: (xTicks ? 18 : 4) + (xTitle ? 14 : 0),
    left: Math.ceil(tickWidth) + (yTicks.length > 0 ? 8 : 4) + (yTitle ? 16 : 0),
  };
}

/** Resolve the plot rectangle for a size and margins (never below 1px). */
function plotArea(size: ChartSize | null, margin: Margin): Plot {
  const { width, height } = size ?? FIXED_SIZE;
  return {
    width,
    height,
    left: margin.left,
    top: margin.top,
    innerW: Math.max(1, width - margin.left - margin.right),
    innerH: Math.max(1, height - margin.top - margin.bottom),
  };
}

/** Map a value within [min, max] to a 0..1 fraction, centering a flat range. */
function fraction(value: number, min: number, max: number): number {
  if (max === min) return 0.5;
  return (value - min) / (max - min);
}

function ChartFrame({
  label,
  frame,
  plot,
  axes = true,
  children,
}: {
  label: string;
  frame: ChartFrameSize;
  plot: Plot;
  axes?: boolean;
  children: ReactNode;
}) {
  // The geometry is physical (y axis on the left) in every locale, so the SVG
  // pins `direction` to ltr: text-anchor start/end then mean left/right even
  // when the document is right-to-left. Labels still shape and order their own
  // script correctly through the bidi algorithm (see FittedText).
  const content = (
    <>
      {axes ? (
        <>
          <line
            x1={plot.left}
            y1={plot.top}
            x2={plot.left}
            y2={plot.top + plot.innerH}
            stroke={AXIS}
          />
          <line
            x1={plot.left}
            y1={plot.top + plot.innerH}
            x2={plot.left + plot.innerW}
            y2={plot.top + plot.innerH}
            stroke={AXIS}
          />
        </>
      ) : null}
      {children}
    </>
  );

  if (frame.sizing === "fixed") {
    return (
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        width="100%"
        role="img"
        aria-label={label}
        direction="ltr"
        className="h-auto w-full"
        preserveAspectRatio="xMidYMid meet"
      >
        {content}
      </svg>
    );
  }

  // Fill mode: the wrapper takes the space the card leaves after the caption
  // and is what gets measured; the SVG is positioned absolutely inside it so
  // its own size never feeds back into the measurement.
  return (
    <div ref={frame.frameRef} className="relative min-h-0 flex-1 overflow-hidden">
      {frame.size ? (
        <svg
          width={frame.size.width}
          height={frame.size.height}
          viewBox={`0 0 ${frame.size.width} ${frame.size.height}`}
          role="img"
          aria-label={label}
          direction="ltr"
          className="absolute inset-0"
        >
          {content}
        </svg>
      ) : null}
    </div>
  );
}

/**
 * A chart label shortened with an ellipsis to fit `maxWidth`; when shortened,
 * the full label is kept as a native `<title>` tooltip. `unicode-bidi:
 * plaintext` lets a right-to-left label (Arabic, Hebrew) take its own base
 * direction, so its ellipsis lands at its visual end.
 */
function FittedText({
  label,
  maxWidth,
  ...props
}: { label: string; maxWidth: number } & Omit<SVGProps<SVGTextElement>, "children">) {
  const fitted = truncateToWidth(label, Math.max(0, maxWidth), measureLabel);
  return (
    <text fontSize={LABEL} fill={TICK} style={{ unicodeBidi: "plaintext" }} {...props}>
      {fitted.text}
      {fitted.truncated ? <title>{label}</title> : null}
    </text>
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
    <text x={x} y={y} textAnchor={anchor} dominantBaseline={baseline} fontSize={LABEL} fill={TICK}>
      {text}
    </text>
  );
}

/**
 * Min/max labels under a numeric x axis, or a single centered label when the
 * range is flat. Drops the max label when the two would collide on a short axis.
 */
function xRangeTicks(plot: Plot, low: string, high: string, flat: boolean) {
  const y = plot.top + plot.innerH + X_TICK_OFFSET;
  if (flat) return tickText(plot.left + plot.innerW / 2, y, low, "middle");
  const fits = measureLabel(low) + measureLabel(high) + 8 <= plot.innerW;
  return (
    <>
      {tickText(plot.left, y, low, "start")}
      {fits ? tickText(plot.left + plot.innerW, y, high, "end") : null}
    </>
  );
}

function axisTitle(plot: Plot, text: string) {
  return (
    <FittedText
      label={text}
      maxWidth={plot.innerW}
      x={plot.left + plot.innerW / 2}
      y={plot.height - 4}
      textAnchor="middle"
    />
  );
}

function yAxisTitle(plot: Plot, text: string) {
  const cy = plot.top + plot.innerH / 2;
  return (
    <FittedText
      label={text}
      maxWidth={plot.innerH}
      x={12}
      y={cy}
      textAnchor="middle"
      transform={`rotate(-90 12 ${cy})`}
    />
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
  const frame = useChartSize();
  if (!result) return <EmptyChart message={t("dashboard.chart.emptyNumeric")} />;

  const { bins, maxCount, min, max, total } = result;
  const plot = plotArea(frame.size, axisMargin(frame.sizing, { yTicks: ["0", String(maxCount)] }));
  const slot = plot.innerW / bins.length;
  const gap = Math.min(4, slot * 0.15);

  return (
    <>
      <ChartFrame label={`Histogram of ${field}`} frame={frame} plot={plot}>
        {tickText(plot.left - 6, plot.top + plot.innerH, "0", "end", "middle")}
        {tickText(plot.left - 6, plot.top, String(maxCount), "end", "middle")}
        {bins.map((bin, index) => {
          const height = maxCount === 0 ? 0 : (bin.count / maxCount) * plot.innerH;
          return (
            <rect
              key={index}
              x={plot.left + index * slot + gap / 2}
              y={plot.top + plot.innerH - height}
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
        {xRangeTicks(plot, formatAxisValue(min), formatAxisValue(max), min === max)}
        {axisTitle(plot, field)}
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
  const frame = useChartSize();
  if (!result) {
    return <EmptyChart message={t("dashboard.chart.emptyScatter")} />;
  }

  const { points, total, xMin, xMax, yMin, yMax } = result;
  const sampled = total > points.length;
  const plot = plotArea(
    frame.size,
    axisMargin(frame.sizing, {
      yTicks: [formatAxisValue(yMin), formatAxisValue(yMax)],
      yTitle: true,
    }),
  );

  return (
    <>
      <ChartFrame label={`Scatter plot of ${yField} versus ${xField}`} frame={frame} plot={plot}>
        {/* Single centered tick when an axis is flat (all values identical),
            mirroring the histogram, rather than the same value at both ends. */}
        {yMin === yMax ? (
          tickText(
            plot.left - 6,
            plot.top + plot.innerH / 2,
            formatAxisValue(yMin),
            "end",
            "middle",
          )
        ) : (
          <>
            {tickText(plot.left - 6, plot.top, formatAxisValue(yMax), "end", "middle")}
            {tickText(
              plot.left - 6,
              plot.top + plot.innerH,
              formatAxisValue(yMin),
              "end",
              "middle",
            )}
          </>
        )}
        {points.map((point, index) => {
          const cx = plot.left + fraction(point.x, xMin, xMax) * plot.innerW;
          const cy = plot.top + plot.innerH - fraction(point.y, yMin, yMax) * plot.innerH;
          return (
            <circle key={index} cx={cx} cy={cy} r={3} fill={color} opacity={0.6}>
              <title>{`${xField}: ${formatAxisValue(point.x)}, ${yField}: ${formatAxisValue(point.y)}`}</title>
            </circle>
          );
        })}
        {xRangeTicks(plot, formatAxisValue(xMin), formatAxisValue(xMax), xMin === xMax)}
        {axisTitle(plot, xField)}
        {yAxisTitle(plot, yField)}
      </ChartFrame>
      <Caption>
        {total.toLocaleString()} point{total === 1 ? "" : "s"} · {yField} vs {xField}
        {sampled ? ` · showing ${points.length.toLocaleString()} sampled` : ""}
      </Caption>
    </>
  );
}

/**
 * Lay out the category labels under a bar chart and size the bottom margin to
 * them. Labels sit level when every one fits its bar's slot; otherwise they are
 * rotated -40° and the bottom margin grows to the longest label, up to a cap
 * (72px in the fixed frame, 45% of the height in a measured card), with longer
 * labels truncated to that space. When slots are too narrow for rotated labels
 * not to overlap, only every `step`-th label is drawn (each bar keeps its
 * tooltip).
 */
function layoutCategoryLabels(
  frame: ChartFrameSize,
  margin: Margin,
  labels: string[],
): { plot: Plot; rotated: boolean; maxWidth: number; offset: number; step: number } {
  const width = (frame.size ?? FIXED_SIZE).width;
  const height = (frame.size ?? FIXED_SIZE).height;
  const slot = Math.max(1, width - margin.left - margin.right) / Math.max(labels.length, 1);
  const widest = Math.max(0, ...labels.map(measureLabel));
  const fixed = frame.sizing === "fixed";

  if (widest <= slot - 4) {
    const bottom = fixed ? margin.bottom : X_TICK_OFFSET + 8;
    return {
      plot: plotArea(frame.size, { ...margin, bottom }),
      rotated: false,
      maxWidth: slot - 4,
      offset: X_TICK_OFFSET,
      step: 1,
    };
  }

  // A rotated label hangs down-left from its anchor, `offset` below the axis.
  const offset = 10;
  const cap = fixed ? 72 : Math.max(28, Math.round(height * 0.45));
  const bottom = Math.min(cap, Math.ceil(offset + widest * ROTATE_SIN + 4));
  return {
    plot: plotArea(frame.size, { ...margin, bottom }),
    rotated: true,
    maxWidth: Math.max(0, (bottom - offset - 4) / ROTATE_SIN),
    offset,
    step: Math.max(1, Math.ceil(MIN_ROTATED_SLOT / slot)),
  };
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
  const frame = useChartSize();
  if (!result) return <EmptyChart message={t("dashboard.chart.emptyBar")} />;

  const { bars, maxValue, minValue, truncated } = result;
  const colors = categoryColors(color, bars.length);
  const domainMin = Math.min(0, minValue);
  // Keep 0 as the top of the scale when every bar is <= 0 (possible for
  // sum/mean); only fall back to 1 when the domain would otherwise be zero-width
  // (all bars exactly 0). `Math.max(0, maxValue) || 1` wrongly made an
  // all-negative domain top out at 1.
  const domainMax = maxValue > 0 ? maxValue : minValue < 0 ? 0 : 1;
  const yTicks = [
    ...(domainMax > 0 ? [formatAxisValue(domainMax)] : []),
    "0",
    ...(minValue < 0 ? [formatAxisValue(domainMin)] : []),
  ];
  const labels = layoutCategoryLabels(
    frame,
    axisMargin(frame.sizing, { yTicks, xTicks: false, xTitle: false }),
    bars.map((datum) => datum.label),
  );
  const { plot } = labels;
  const slot = plot.innerW / bars.length;
  const gap = Math.min(6, slot * 0.2);
  const scaleY = (value: number) =>
    plot.top + plot.innerH - fraction(value, domainMin, domainMax) * plot.innerH;
  const baselineY = scaleY(0);

  return (
    <>
      <ChartFrame label={`Bar chart of ${aggregation} by ${category}`} frame={frame} plot={plot}>
        {/* Top tick only when the domain extends above 0; when all bars are
            <= 0 the domain tops at 0 and the baseline tick already labels it. */}
        {domainMax > 0
          ? tickText(plot.left - 6, plot.top, formatAxisValue(domainMax), "end", "middle")
          : null}
        {tickText(plot.left - 6, baselineY, "0", "end", "middle")}
        {/* Lower-bound tick when bars go negative (sum/mean of negative values). */}
        {minValue < 0
          ? tickText(
              plot.left - 6,
              plot.top + plot.innerH,
              formatAxisValue(domainMin),
              "end",
              "middle",
            )
          : null}
        {bars.map((datum, index) => {
          const top = Math.min(baselineY, scaleY(datum.value));
          const height = Math.abs(scaleY(datum.value) - baselineY);
          const cx = plot.left + index * slot + slot / 2;
          const labelY = plot.top + plot.innerH + labels.offset;
          return (
            <g key={datum.label}>
              <rect
                x={plot.left + index * slot + gap / 2}
                y={top}
                width={Math.max(1, slot - gap)}
                height={Math.max(0, height)}
                fill={colors[index]}
                opacity={0.9}
              >
                <title>{`${datum.label}: ${formatAxisValue(datum.value)} (${datum.count} row${datum.count === 1 ? "" : "s"})`}</title>
              </rect>
              {index % labels.step !== 0 ? null : labels.rotated ? (
                <FittedText
                  label={datum.label}
                  // Also keep the label's lower-left end inside the SVG.
                  maxWidth={Math.min(labels.maxWidth, (cx - 2) / ROTATE_COS)}
                  x={cx}
                  y={labelY}
                  textAnchor="end"
                  transform={`rotate(-40 ${cx} ${labelY})`}
                />
              ) : (
                <FittedText
                  label={datum.label}
                  maxWidth={labels.maxWidth}
                  x={cx}
                  y={labelY}
                  textAnchor="middle"
                />
              )}
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
  const frame = useChartSize();
  if (!result) return <EmptyChart message={t("dashboard.chart.emptyNumeric")} />;

  const { points, min, max, length } = result;
  const plot = plotArea(
    frame.size,
    axisMargin(frame.sizing, { yTicks: [formatAxisValue(min), formatAxisValue(max)] }),
  );
  const scaleX = (index: number) =>
    plot.left + (length > 1 ? index / (length - 1) : 0.5) * plot.innerW;
  const scaleY = (value: number) =>
    plot.top + plot.innerH - fraction(value, min, max) * plot.innerH;
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
      <ChartFrame label={`Line chart of ${field} by feature order`} frame={frame} plot={plot}>
        {tickText(plot.left - 6, plot.top, formatAxisValue(max), "end", "middle")}
        {tickText(plot.left - 6, plot.top + plot.innerH, formatAxisValue(min), "end", "middle")}
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
        {xRangeTicks(plot, "0", String(length - 1), length <= 1)}
        {axisTitle(plot, "feature order")}
      </ChartFrame>
      <Caption>
        {points.length.toLocaleString()} value{points.length === 1 ? "" : "s"} · {field} by feature
        order
      </Caption>
    </>
  );
}

/**
 * Nudge label positions (sorted top to bottom) at least one label line apart,
 * keeping them within [top, bottom] when there is room for all of them.
 */
function spreadLabels(ys: number[], top: number, bottom: number): number[] {
  const gap = LABEL + 2;
  const out = [...ys];
  for (let i = 1; i < out.length; i += 1) out[i] = Math.max(out[i], out[i - 1] + gap);
  const last = out.length - 1;
  if (last >= 0 && out[last] > bottom) {
    out[last] = bottom;
    for (let i = last - 1; i >= 0; i -= 1) out[i] = Math.min(out[i], out[i + 1] - gap);
  }
  if (out.length > 0 && out[0] < top) {
    // Not enough room for every label: start at the top and let the rest clip.
    out[0] = top;
    for (let i = 1; i < out.length; i += 1) out[i] = Math.max(out[i], out[i - 1] + gap);
  }
  return out;
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
  const frame = useChartSize();
  if (!result) return <EmptyChart message={t("dashboard.chart.emptyNumeric")} />;

  const { min, q1, median, q3, max, count } = result;
  const plot = plotArea(frame.size, axisMargin(frame.sizing, { xTicks: false }));
  const centerX = plot.left + plot.innerW / 2;
  const boxWidth = frame.sizing === "fixed" ? 96 : Math.min(96, Math.max(24, plot.innerW * 0.25));
  const scaleY = (value: number) =>
    plot.top + plot.innerH - fraction(value, min, max) * plot.innerH;
  // Stat labels sit to the right of the box; truncate rather than clip them.
  const statX = centerX + boxWidth / 2 + 8;
  const statWidth = plot.width - statX - 4;

  const stats: [string, number][] = [
    ["max", max],
    ["Q3", q3],
    ["median", median],
    ["Q1", q1],
    ["min", min],
  ];
  // Skewed data bunches the stats together; spread their labels a line apart.
  const statY = spreadLabels(
    stats.map(([, value]) => scaleY(value)),
    plot.top,
    plot.top + plot.innerH,
  );

  return (
    <>
      <ChartFrame label={`Box plot of ${field}`} frame={frame} plot={plot}>
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
        {min === max ? (
          <FittedText
            label={`all = ${formatAxisValue(median)}`}
            maxWidth={statWidth}
            x={statX}
            y={scaleY(median)}
            textAnchor="start"
            dominantBaseline="middle"
          />
        ) : (
          stats.map(([label, value], index) => (
            <FittedText
              key={label}
              label={`${label} ${formatAxisValue(value)}`}
              maxWidth={statWidth}
              x={statX}
              y={statY[index]}
              textAnchor="start"
              dominantBaseline="middle"
            />
          ))
        )}
        {axisTitle(plot, field)}
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
  const frame = useChartSize();
  if (!result) return <EmptyChart message={t("dashboard.chart.emptyPie")} />;

  const { slices, total } = result;
  const colors = categoryColors(color, slices.length);
  const fixed = frame.sizing === "fixed";
  const plot = plotArea(frame.size, fixed ? MARGIN : { top: 8, right: 8, bottom: 8, left: 8 });
  // In fill mode the legend sits right of the pie, starting 2r + 32px from the
  // plot's left edge and ending 4px short of the right: cap the radius so the
  // legend keeps PIE_LEGEND_MIN_TEXT px for its text.
  const legendRoom = (plot.width - plot.left - 36 - PIE_LEGEND_MIN_TEXT) / 2;
  const radius = fixed
    ? plot.innerH / 2 - 6
    : Math.max(4, Math.min(plot.innerH / 2 - 2, plot.innerW * 0.32, legendRoom));
  const cx = plot.left + radius;
  const cy = plot.top + plot.innerH / 2;
  const legendX = cx + radius + (fixed ? 24 : 16);
  // Legend rows: up to 22px apart, never closer than one label line; rows that
  // don't fit a short card are left off (every slice keeps its tooltip).
  const legendStep = fixed
    ? Math.min(22, plot.innerH / Math.max(slices.length, 1))
    : Math.max(LABEL + 3, Math.min(22, plot.innerH / Math.max(slices.length, 1)));
  const legendRows = fixed
    ? slices.length
    : Math.min(slices.length, Math.max(1, Math.floor(plot.innerH / legendStep)));
  const legendTop = fixed ? plot.top : cy - (legendRows * legendStep) / 2 + (legendStep - 10) / 2;

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
      <ChartFrame
        label={`Pie chart of ${aggregation} by ${category}`}
        frame={frame}
        plot={plot}
        axes={false}
      >
        {arcs.map(({ d, color: fill, slice }) => (
          <path key={slice.label} d={d} fill={fill} stroke="hsl(var(--background))" strokeWidth={1}>
            <title>{`${slice.label}: ${formatAxisValue(slice.value)} (${Math.round(
              (slice.value / total) * 100,
            )}%)`}</title>
          </path>
        ))}
        {arcs.slice(0, legendRows).map(({ color: fill, slice, share }, index) => {
          const y = legendTop + index * legendStep;
          const textX = legendX + 16;
          // Truncate the category, never the share, to the room left of the edge.
          const suffix = ` · ${Math.round(share * 100)}%`;
          const fitted = truncateToWidth(
            slice.label,
            plot.width - 4 - textX - measureLabel(suffix),
            measureLabel,
          );
          return (
            <g key={`legend-${slice.label}`}>
              <rect x={legendX} y={y} width={10} height={10} rx={2} fill={fill} />
              <text
                x={textX}
                y={y + 5}
                dominantBaseline="middle"
                fontSize={LABEL}
                fill={TICK}
                style={{ unicodeBidi: "plaintext" }}
              >
                {`${fitted.text}${suffix}`}
                {fitted.truncated ? <title>{slice.label}</title> : null}
              </text>
            </g>
          );
        })}
      </ChartFrame>
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
