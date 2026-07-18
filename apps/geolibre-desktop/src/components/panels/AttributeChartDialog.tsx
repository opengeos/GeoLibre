import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Label,
  Select,
} from "@geolibre/ui";
import { Download } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { downloadChartPng, downloadChartSvg } from "../../lib/chart-export";
import { sanitizeExportFileName } from "../../lib/vector-export";
import {
  categoricalColumns,
  DEFAULT_HISTOGRAM_BINS,
  MAX_HISTOGRAM_BINS,
  MIN_HISTOGRAM_BINS,
  numericColumns,
  type BarAggregation,
  type ChartRow,
  type ChartType,
} from "../../lib/attribute-charts";
import {
  CHART_H,
  CHART_W,
  ChartView,
  chartResultHasData,
  computeChart,
  type ChartSpec,
} from "./charts/chart-view";

interface AttributeChartDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rows: ChartRow[];
  columns: string[];
  layerName: string;
}

export function AttributeChartDialog({
  open,
  onOpenChange,
  rows,
  columns,
  layerName,
}: AttributeChartDialogProps) {
  const { t } = useTranslation();
  const numericCols = useMemo(() => numericColumns(rows, columns), [rows, columns]);
  const categoryCols = useMemo(() => categoricalColumns(rows, columns), [rows, columns]);

  const [chartType, setChartType] = useState<ChartType>("histogram");
  const [field, setField] = useState("");
  const [xField, setXField] = useState("");
  const [yField, setYField] = useState("");
  const [bins, setBins] = useState(DEFAULT_HISTOGRAM_BINS);
  const [catField, setCatField] = useState("");
  const [barAgg, setBarAgg] = useState<BarAggregation>("count");
  const [barValueField, setBarValueField] = useState("");
  const [exportError, setExportError] = useState<string | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);

  // Seed the pickers when the dialog opens. Keyed on `open` only: `rows` and
  // `columns` are rebuilt with fresh identities on every parent render, so
  // depending on the derived column lists here would reset the user's
  // selections constantly. They are read from the render where `open` flipped.
  useEffect(() => {
    if (!open) return;
    // No numeric fields → default to bar (the only category-only type). When
    // there are no chartable fields at all the dialog shows an empty state, so
    // the chosen type is irrelevant.
    setChartType(numericCols.length > 0 ? "histogram" : "bar");
    setBins(DEFAULT_HISTOGRAM_BINS);
    setField(numericCols[0] ?? "");
    setXField(numericCols[0] ?? "");
    setYField(numericCols[1] ?? numericCols[0] ?? "");
    setCatField(categoryCols[0] ?? "");
    setBarAgg("count");
    setBarValueField(numericCols[0] ?? "");
    setExportError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const spec = useMemo<ChartSpec>(
    () => ({
      type: chartType,
      field,
      xField,
      yField,
      bins,
      category: catField,
      aggregation: barAgg,
      valueField: barValueField,
    }),
    [chartType, field, xField, yField, bins, catField, barAgg, barValueField],
  );
  const chartResult = useMemo(() => computeChart(rows, spec), [rows, spec]);

  const hasNumeric = numericCols.length > 0;
  const hasCategory = categoryCols.length > 0;
  const hasChartable = hasNumeric || hasCategory;
  // A chart is only downloadable when the active type produced a result (an SVG
  // is on screen); empty states render no <svg>.
  const chartRendered = chartResultHasData(chartResult);

  const downloadChart = (format: "svg" | "png") => {
    const svg = chartRef.current?.querySelector("svg");
    if (!svg) return;
    setExportError(null);
    const base = `${sanitizeExportFileName(layerName || "chart")}-${chartType}`;
    const onError = (error: unknown) =>
      setExportError(error instanceof Error ? error.message : "Could not export the chart.");
    if (format === "svg") {
      try {
        downloadChartSvg(svg, CHART_W, CHART_H, `${base}.svg`);
      } catch (error) {
        onError(error);
      }
    } else {
      // PNG rasterization is async (image load + canvas), so surface a
      // rejection rather than letting it become an unhandled promise.
      downloadChartPng(svg, CHART_W, CHART_H, `${base}.png`).catch(onError);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Charts</DialogTitle>
          <DialogDescription>{`Visualize fields in "${layerName}".`}</DialogDescription>
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
                  onChange={(event) => setChartType(event.target.value as ChartType)}
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
                  <option value="pie" disabled={!hasCategory}>
                    Pie
                  </option>
                </Select>
              </div>

              {(chartType === "histogram" || chartType === "line" || chartType === "box") && (
                <FieldSelect
                  id="chart-field"
                  label={t("attributeTable.chart.field")}
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
                    // 0 is the "empty" sentinel so the field can be cleared and
                    // retyped; computeHistogram treats it as 1, and onBlur snaps
                    // it back to the minimum.
                    value={bins === 0 ? "" : bins}
                    onChange={(event) => {
                      const raw = event.target.value;
                      if (raw === "") {
                        setBins(0);
                        return;
                      }
                      const next = Number(raw);
                      if (Number.isFinite(next)) {
                        setBins(
                          Math.max(
                            MIN_HISTOGRAM_BINS,
                            Math.min(MAX_HISTOGRAM_BINS, Math.trunc(next)),
                          ),
                        );
                      }
                    }}
                    onBlur={() => {
                      if (bins < MIN_HISTOGRAM_BINS) setBins(MIN_HISTOGRAM_BINS);
                    }}
                  />
                </div>
              )}

              {chartType === "scatter" && (
                <>
                  <FieldSelect
                    id="chart-x"
                    label={t("attributeTable.chart.xAxis")}
                    value={xField}
                    options={numericCols}
                    onChange={setXField}
                  />
                  <FieldSelect
                    id="chart-y"
                    label={t("attributeTable.chart.yAxis")}
                    value={yField}
                    options={numericCols}
                    onChange={setYField}
                  />
                </>
              )}

              {(chartType === "bar" || chartType === "pie") && (
                <>
                  <FieldSelect
                    id="chart-category"
                    label={t("attributeTable.chart.category")}
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
                      onChange={(event) => setBarAgg(event.target.value as BarAggregation)}
                    >
                      <option value="count">Count</option>
                      <option value="sum" disabled={!hasNumeric}>
                        Sum
                      </option>
                      {/* Averaging parts of a whole is meaningless for a pie. */}
                      {chartType !== "pie" && (
                        <option value="mean" disabled={!hasNumeric}>
                          Average
                        </option>
                      )}
                    </Select>
                  </div>
                  {barAgg !== "count" && (
                    <FieldSelect
                      id="chart-value"
                      label={t("attributeTable.chart.value")}
                      value={barValueField}
                      options={numericCols}
                      onChange={setBarValueField}
                    />
                  )}
                </>
              )}
            </div>

            <div ref={chartRef} className="rounded-md border bg-background p-2">
              <ChartView result={chartResult} />
            </div>
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          {exportError ? (
            <span className="me-auto truncate text-xs text-destructive">{exportError}</span>
          ) : null}
          {hasChartable ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" disabled={!chartRendered}>
                  <Download className="h-4 w-4" />
                  Download
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => downloadChart("png")}>PNG image</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => downloadChart("svg")}>
                  SVG vector
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
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
