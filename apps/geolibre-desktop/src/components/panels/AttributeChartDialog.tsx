import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
} from "@geolibre/ui";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  categoricalColumns,
  computeBar,
  computeBox,
  computeHistogram,
  computeLine,
  computeScatter,
  DEFAULT_HISTOGRAM_BINS,
  formatAxisValue,
  MAX_HISTOGRAM_BINS,
  MIN_HISTOGRAM_BINS,
  numericColumns,
  numericValues,
  type BarAggregation,
  type ChartRow,
  type ChartType,
} from "../../lib/attribute-charts";

interface AttributeChartDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rows: ChartRow[];
  columns: string[];
  layerName: string;
}

// SVG geometry. The chart scales to its container via viewBox/width=100%.
const CHART_W = 560;
const CHART_H = 300;
const MARGIN = { top: 16, right: 16, bottom: 52, left: 52 };
const INNER_W = CHART_W - MARGIN.left - MARGIN.right;
const INNER_H = CHART_H - MARGIN.top - MARGIN.bottom;

const AXIS = "hsl(var(--border))";
const TICK = "hsl(var(--muted-foreground))";
const SERIES = "hsl(var(--primary))";

/** Chart types that plot one or more numeric fields. */
const NUMERIC_TYPES: ReadonlySet<ChartType> = new Set([
  "histogram",
  "scatter",
  "line",
  "box",
]);

/** Map a value within [min, max] to a 0..1 fraction, centering a flat range. */
function fraction(value: number, min: number, max: number): number {
  if (max === min) return 0.5;
  return (value - min) / (max - min);
}

function truncateLabel(label: string, max = 14): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

export function AttributeChartDialog({
  open,
  onOpenChange,
  rows,
  columns,
  layerName,
}: AttributeChartDialogProps) {
  const numericCols = useMemo(
    () => numericColumns(rows, columns),
    [rows, columns],
  );
  const categoryCols = useMemo(
    () => categoricalColumns(rows, columns),
    [rows, columns],
  );

  const [chartType, setChartType] = useState<ChartType>("histogram");
  const [field, setField] = useState("");
  const [xField, setXField] = useState("");
  const [yField, setYField] = useState("");
  const [bins, setBins] = useState(DEFAULT_HISTOGRAM_BINS);
  const [catField, setCatField] = useState("");
  const [barAgg, setBarAgg] = useState<BarAggregation>("count");
  const [barValueField, setBarValueField] = useState("");

  // Seed the pickers when the dialog opens. Keyed on `open` only: `rows` and
  // `columns` are rebuilt with fresh identities on every parent render, so
  // depending on the derived column lists here would reset the user's
  // selections constantly. They are read from the render where `open` flipped.
  useEffect(() => {
    if (!open) return;
    setChartType(
      numericCols.length > 0
        ? "histogram"
        : categoryCols.length > 0
          ? "bar"
          : "histogram",
    );
    setBins(DEFAULT_HISTOGRAM_BINS);
    setField(numericCols[0] ?? "");
    setXField(numericCols[0] ?? "");
    setYField(numericCols[1] ?? numericCols[0] ?? "");
    setCatField(categoryCols[0] ?? "");
    setBarAgg("count");
    setBarValueField(numericCols[0] ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const histogram = useMemo(() => {
    if (chartType !== "histogram" || !field) return null;
    return computeHistogram(numericValues(rows, field), bins);
  }, [chartType, field, rows, bins]);

  const scatter = useMemo(() => {
    if (chartType !== "scatter" || !xField || !yField) return null;
    return computeScatter(rows, xField, yField);
  }, [chartType, xField, yField, rows]);

  const bar = useMemo(() => {
    if (chartType !== "bar" || !catField) return null;
    return computeBar(
      rows,
      catField,
      barAgg,
      barAgg === "count" ? null : barValueField,
    );
  }, [chartType, catField, barAgg, barValueField, rows]);

  const line = useMemo(() => {
    if (chartType !== "line" || !field) return null;
    return computeLine(rows, field);
  }, [chartType, field, rows]);

  const box = useMemo(() => {
    if (chartType !== "box" || !field) return null;
    return computeBox(numericValues(rows, field));
  }, [chartType, field, rows]);

  const hasNumeric = numericCols.length > 0;
  const hasCategory = categoryCols.length > 0;
  const hasChartable = hasNumeric || hasCategory;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Charts</DialogTitle>
          <DialogDescription>
            {`Visualize fields in "${layerName}".`}
          </DialogDescription>
        </DialogHeader>

        {!hasChartable ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            This layer has no numeric or categorical fields to chart.
          </p>
        ) : (
          <div className="grid gap-3 py-1">
            <div className="flex flex-wrap items-end gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="chart-type">Chart type</Label>
                <Select
                  id="chart-type"
                  className="w-36"
                  value={chartType}
                  onChange={(event) =>
                    setChartType(event.target.value as ChartType)
                  }
                >
                  <option value="histogram" disabled={!hasNumeric}>
                    Histogram
                  </option>
                  <option value="scatter" disabled={!hasNumeric}>
                    Scatter
                  </option>
                  <option value="bar" disabled={!hasCategory}>
                    Bar
                  </option>
                  <option value="line" disabled={!hasNumeric}>
                    Line
                  </option>
                  <option value="box" disabled={!hasNumeric}>
                    Box plot
                  </option>
                </Select>
              </div>

              {(chartType === "histogram" ||
                chartType === "line" ||
                chartType === "box") && (
                <FieldSelect
                  id="chart-field"
                  label="Field"
                  value={field}
                  options={numericCols}
                  onChange={setField}
                />
              )}

              {chartType === "histogram" && (
                <div className="grid gap-1.5">
                  <Label htmlFor="chart-bins">Bins</Label>
                  <Input
                    id="chart-bins"
                    type="number"
                    className="w-24"
                    min={MIN_HISTOGRAM_BINS}
                    max={MAX_HISTOGRAM_BINS}
                    value={bins}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      if (Number.isFinite(next)) {
                        setBins(
                          Math.max(
                            MIN_HISTOGRAM_BINS,
                            Math.min(MAX_HISTOGRAM_BINS, Math.trunc(next)),
                          ),
                        );
                      }
                    }}
                  />
                </div>
              )}

              {chartType === "scatter" && (
                <>
                  <FieldSelect
                    id="chart-x"
                    label="X axis"
                    value={xField}
                    options={numericCols}
                    onChange={setXField}
                  />
                  <FieldSelect
                    id="chart-y"
                    label="Y axis"
                    value={yField}
                    options={numericCols}
                    onChange={setYField}
                  />
                </>
              )}

              {chartType === "bar" && (
                <>
                  <FieldSelect
                    id="chart-category"
                    label="Category"
                    value={catField}
                    options={categoryCols}
                    onChange={setCatField}
                  />
                  <div className="grid gap-1.5">
                    <Label htmlFor="chart-agg">Aggregate</Label>
                    <Select
                      id="chart-agg"
                      className="w-32"
                      value={barAgg}
                      onChange={(event) =>
                        setBarAgg(event.target.value as BarAggregation)
                      }
                    >
                      <option value="count">Count</option>
                      <option value="sum" disabled={!hasNumeric}>
                        Sum
                      </option>
                      <option value="mean" disabled={!hasNumeric}>
                        Average
                      </option>
                    </Select>
                  </div>
                  {barAgg !== "count" && (
                    <FieldSelect
                      id="chart-value"
                      label="Value"
                      value={barValueField}
                      options={numericCols}
                      onChange={setBarValueField}
                    />
                  )}
                </>
              )}
            </div>

            <div className="rounded-md border bg-background p-2">
              {chartType === "histogram" && (
                <HistogramChart result={histogram} field={field} />
              )}
              {chartType === "scatter" && (
                <ScatterChart result={scatter} xField={xField} yField={yField} />
              )}
              {chartType === "bar" && (
                <BarChart result={bar} aggregation={barAgg} />
              )}
              {chartType === "line" && (
                <LineChart result={line} field={field} />
              )}
              {chartType === "box" && <BoxChart result={box} field={field} />}
            </div>
          </div>
        )}

        <div className="flex justify-end">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function FieldSelect({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: string[];
  onChange: (next: string) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select
        id={id}
        className="w-44"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((col) => (
          <option key={col} value={col}>
            {col}
          </option>
        ))}
      </Select>
    </div>
  );
}

function ChartFrame({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox={`0 0 ${CHART_W} ${CHART_H}`}
      width="100%"
      role="img"
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
    <text
      x={x}
      y={y}
      textAnchor={anchor}
      dominantBaseline={baseline}
      fontSize={10}
      fill={TICK}
    >
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

function EmptyChart({ message }: { message: string }) {
  return (
    <p className="py-10 text-center text-sm text-muted-foreground">{message}</p>
  );
}

function Caption({ children }: { children: ReactNode }) {
  return (
    <p className="mt-1 text-center text-xs text-muted-foreground">{children}</p>
  );
}

function HistogramChart({
  result,
  field,
}: {
  result: ReturnType<typeof computeHistogram>;
  field: string;
}) {
  if (!result) return <EmptyChart message="No numeric values to plot." />;

  const { bins, maxCount, min, max, total } = result;
  const slot = INNER_W / bins.length;
  const gap = Math.min(4, slot * 0.15);

  return (
    <>
      <ChartFrame>
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
              fill={SERIES}
              opacity={0.85}
            >
              <title>{`[${formatAxisValue(bin.x0)}, ${formatAxisValue(bin.x1)}${
                index === bins.length - 1 ? "]" : ")"
              }: ${bin.count}`}</title>
            </rect>
          );
        })}
        {tickText(MARGIN.left, MARGIN.top + INNER_H + 14, formatAxisValue(min), "start")}
        {tickText(MARGIN.left + INNER_W, MARGIN.top + INNER_H + 14, formatAxisValue(max), "end")}
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
}: {
  result: ReturnType<typeof computeScatter>;
  xField: string;
  yField: string;
}) {
  if (!result) {
    return <EmptyChart message="No rows have both fields set to a number." />;
  }

  const { points, xMin, xMax, yMin, yMax } = result;

  return (
    <>
      <ChartFrame>
        {tickText(MARGIN.left - 6, MARGIN.top, formatAxisValue(yMax), "end", "middle")}
        {tickText(MARGIN.left - 6, MARGIN.top + INNER_H, formatAxisValue(yMin), "end", "middle")}
        {points.map((point, index) => {
          const cx = MARGIN.left + fraction(point.x, xMin, xMax) * INNER_W;
          const cy =
            MARGIN.top + INNER_H - fraction(point.y, yMin, yMax) * INNER_H;
          return (
            <circle key={index} cx={cx} cy={cy} r={3} fill={SERIES} opacity={0.6}>
              <title>{`${xField}: ${formatAxisValue(point.x)}, ${yField}: ${formatAxisValue(point.y)}`}</title>
            </circle>
          );
        })}
        {tickText(MARGIN.left, MARGIN.top + INNER_H + 14, formatAxisValue(xMin), "start")}
        {tickText(MARGIN.left + INNER_W, MARGIN.top + INNER_H + 14, formatAxisValue(xMax), "end")}
        {axisTitle(xField)}
      </ChartFrame>
      <Caption>
        {points.length.toLocaleString()} point{points.length === 1 ? "" : "s"} ·{" "}
        {yField} vs {xField}
      </Caption>
    </>
  );
}

function BarChart({
  result,
  aggregation,
}: {
  result: ReturnType<typeof computeBar>;
  aggregation: BarAggregation;
}) {
  if (!result) return <EmptyChart message="No rows to group." />;

  const { bars, maxValue, minValue, truncated } = result;
  const domainMin = Math.min(0, minValue);
  const domainMax = Math.max(0, maxValue) || 1;
  const slot = INNER_W / bars.length;
  const gap = Math.min(6, slot * 0.2);
  const scaleY = (value: number) =>
    MARGIN.top + INNER_H - fraction(value, domainMin, domainMax) * INNER_H;
  const baselineY = scaleY(0);

  return (
    <>
      <ChartFrame>
        {tickText(MARGIN.left - 6, MARGIN.top, formatAxisValue(domainMax), "end", "middle")}
        {tickText(MARGIN.left - 6, baselineY, "0", "end", "middle")}
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
                fill={SERIES}
                opacity={0.85}
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
}: {
  result: ReturnType<typeof computeLine>;
  field: string;
}) {
  if (!result) return <EmptyChart message="No numeric values to plot." />;

  const { points, min, max, length } = result;
  const scaleX = (index: number) =>
    MARGIN.left + (length > 1 ? index / (length - 1) : 0.5) * INNER_W;
  const scaleY = (value: number) =>
    MARGIN.top + INNER_H - fraction(value, min, max) * INNER_H;
  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${scaleX(p.index)} ${scaleY(p.value)}`)
    .join(" ");

  return (
    <>
      <ChartFrame>
        {tickText(MARGIN.left - 6, MARGIN.top, formatAxisValue(max), "end", "middle")}
        {tickText(MARGIN.left - 6, MARGIN.top + INNER_H, formatAxisValue(min), "end", "middle")}
        <path d={path} fill="none" stroke={SERIES} strokeWidth={1.5} />
        {points.length <= 80
          ? points.map((p) => (
              <circle
                key={p.index}
                cx={scaleX(p.index)}
                cy={scaleY(p.value)}
                r={2}
                fill={SERIES}
              >
                <title>{`#${p.index}: ${formatAxisValue(p.value)}`}</title>
              </circle>
            ))
          : null}
        {tickText(MARGIN.left, MARGIN.top + INNER_H + 14, "0", "start")}
        {tickText(MARGIN.left + INNER_W, MARGIN.top + INNER_H + 14, String(length - 1), "end")}
        {axisTitle("feature order")}
      </ChartFrame>
      <Caption>
        {points.length.toLocaleString()} value{points.length === 1 ? "" : "s"} ·{" "}
        {field} by feature order
      </Caption>
    </>
  );
}

function BoxChart({
  result,
  field,
}: {
  result: ReturnType<typeof computeBox>;
  field: string;
}) {
  if (!result) return <EmptyChart message="No numeric values to plot." />;

  const { min, q1, median, q3, max, count } = result;
  const centerX = MARGIN.left + INNER_W / 2;
  const boxWidth = 96;
  const scaleY = (value: number) =>
    MARGIN.top + INNER_H - fraction(value, min, max) * INNER_H;

  const stats: [string, number][] = [
    ["max", max],
    ["Q3", q3],
    ["median", median],
    ["Q1", q1],
    ["min", min],
  ];

  return (
    <>
      <ChartFrame>
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
          fill={SERIES}
          opacity={0.25}
          stroke={SERIES}
        />
        <line
          x1={centerX - boxWidth / 2}
          y1={scaleY(median)}
          x2={centerX + boxWidth / 2}
          y2={scaleY(median)}
          stroke={SERIES}
          strokeWidth={2}
        />
        {stats.map(([label, value]) => (
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
        {count.toLocaleString()} value{count === 1 ? "" : "s"} · five-number
        summary
      </Caption>
    </>
  );
}
