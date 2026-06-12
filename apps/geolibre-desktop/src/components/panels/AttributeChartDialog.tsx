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
  computeHistogram,
  computeScatter,
  DEFAULT_HISTOGRAM_BINS,
  formatAxisValue,
  MAX_HISTOGRAM_BINS,
  MIN_HISTOGRAM_BINS,
  numericColumns,
  numericValues,
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
const MARGIN = { top: 16, right: 16, bottom: 44, left: 52 };
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

  const [chartType, setChartType] = useState<ChartType>("histogram");
  const [field, setField] = useState("");
  const [xField, setXField] = useState("");
  const [yField, setYField] = useState("");
  const [bins, setBins] = useState(DEFAULT_HISTOGRAM_BINS);

  // Seed the field pickers when the dialog opens. Keyed on `open` only: `rows`
  // and `columns` are rebuilt with fresh identities on every parent render, so
  // depending on numericCols here would reset the user's selections constantly.
  // numericCols is read from the render in which `open` flipped true.
  useEffect(() => {
    if (!open) return;
    setChartType("histogram");
    setBins(DEFAULT_HISTOGRAM_BINS);
    setField(numericCols[0] ?? "");
    setXField(numericCols[0] ?? "");
    setYField(numericCols[1] ?? numericCols[0] ?? "");
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

  const hasNumeric = numericCols.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Charts</DialogTitle>
          <DialogDescription>
            {`Visualize numeric fields in "${layerName}".`}
          </DialogDescription>
        </DialogHeader>

        {!hasNumeric ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            This layer has no numeric fields to chart.
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
                  <option value="histogram">Histogram</option>
                  <option value="scatter">Scatter</option>
                </Select>
              </div>

              {chartType === "histogram" ? (
                <>
                  <div className="grid gap-1.5">
                    <Label htmlFor="chart-field">Field</Label>
                    <Select
                      id="chart-field"
                      className="w-44"
                      value={field}
                      onChange={(event) => setField(event.target.value)}
                    >
                      {numericCols.map((col) => (
                        <option key={col} value={col}>
                          {col}
                        </option>
                      ))}
                    </Select>
                  </div>
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
                </>
              ) : (
                <>
                  <div className="grid gap-1.5">
                    <Label htmlFor="chart-x">X axis</Label>
                    <Select
                      id="chart-x"
                      className="w-44"
                      value={xField}
                      onChange={(event) => setXField(event.target.value)}
                    >
                      {numericCols.map((col) => (
                        <option key={col} value={col}>
                          {col}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="chart-y">Y axis</Label>
                    <Select
                      id="chart-y"
                      className="w-44"
                      value={yField}
                      onChange={(event) => setYField(event.target.value)}
                    >
                      {numericCols.map((col) => (
                        <option key={col} value={col}>
                          {col}
                        </option>
                      ))}
                    </Select>
                  </div>
                </>
              )}
            </div>

            <div className="rounded-md border bg-background p-2">
              {chartType === "histogram" ? (
                <HistogramChart result={histogram} field={field} />
              ) : (
                <ScatterChart
                  result={scatter}
                  xField={xField}
                  yField={yField}
                />
              )}
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

function ChartFrame({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox={`0 0 ${CHART_W} ${CHART_H}`}
      width="100%"
      role="img"
      className="h-auto w-full"
      preserveAspectRatio="xMidYMid meet"
    >
      {/* Axes */}
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

function EmptyChart({ message }: { message: string }) {
  return (
    <p className="py-10 text-center text-sm text-muted-foreground">{message}</p>
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
        {/* y-axis ticks: 0 and the tallest bin count */}
        <text x={MARGIN.left - 6} y={MARGIN.top + INNER_H} textAnchor="end" dominantBaseline="middle" fontSize={10} fill={TICK}>
          0
        </text>
        <text x={MARGIN.left - 6} y={MARGIN.top} textAnchor="end" dominantBaseline="middle" fontSize={10} fill={TICK}>
          {maxCount}
        </text>
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
        {/* x-axis min/max */}
        <text x={MARGIN.left} y={MARGIN.top + INNER_H + 14} textAnchor="start" fontSize={10} fill={TICK}>
          {formatAxisValue(min)}
        </text>
        <text x={MARGIN.left + INNER_W} y={MARGIN.top + INNER_H + 14} textAnchor="end" fontSize={10} fill={TICK}>
          {formatAxisValue(max)}
        </text>
        <text x={MARGIN.left + INNER_W / 2} y={CHART_H - 4} textAnchor="middle" fontSize={11} fill={TICK}>
          {field}
        </text>
      </ChartFrame>
      <p className="mt-1 text-center text-xs text-muted-foreground">
        {total.toLocaleString()} value{total === 1 ? "" : "s"} · count on y
      </p>
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
        <text x={MARGIN.left - 6} y={MARGIN.top} textAnchor="end" dominantBaseline="middle" fontSize={10} fill={TICK}>
          {formatAxisValue(yMax)}
        </text>
        <text x={MARGIN.left - 6} y={MARGIN.top + INNER_H} textAnchor="end" dominantBaseline="middle" fontSize={10} fill={TICK}>
          {formatAxisValue(yMin)}
        </text>
        {points.map((point, index) => {
          const cx = MARGIN.left + fraction(point.x, xMin, xMax) * INNER_W;
          const cy = MARGIN.top + INNER_H - fraction(point.y, yMin, yMax) * INNER_H;
          return (
            <circle key={index} cx={cx} cy={cy} r={3} fill={SERIES} opacity={0.6}>
              <title>{`${xField}: ${formatAxisValue(point.x)}, ${yField}: ${formatAxisValue(point.y)}`}</title>
            </circle>
          );
        })}
        <text x={MARGIN.left} y={MARGIN.top + INNER_H + 14} textAnchor="start" fontSize={10} fill={TICK}>
          {formatAxisValue(xMin)}
        </text>
        <text x={MARGIN.left + INNER_W} y={MARGIN.top + INNER_H + 14} textAnchor="end" fontSize={10} fill={TICK}>
          {formatAxisValue(xMax)}
        </text>
        <text x={MARGIN.left + INNER_W / 2} y={CHART_H - 4} textAnchor="middle" fontSize={11} fill={TICK}>
          {xField}
        </text>
      </ChartFrame>
      <p className="mt-1 text-center text-xs text-muted-foreground">
        {points.length.toLocaleString()} point{points.length === 1 ? "" : "s"} ·{" "}
        {yField} vs {xField}
      </p>
    </>
  );
}
