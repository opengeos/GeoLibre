import { useAppStore } from "@geolibre/core";
import {
  type PixelTimeSeriesResult,
  queryPixelTimeSeries,
  seriesToFeatureCollection,
  TIME_SLIDER_PLUGIN_ID,
} from "@geolibre/plugins";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@geolibre/ui";
import { Crosshair, Download, LineChart, Loader2, X } from "lucide-react";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MapController } from "@geolibre/map";
import { usePluginRegistry } from "../../hooks/usePlugins";
import { exportVectorLayer } from "../../lib/vector-export";

interface PixelTimeSeriesControlProps {
  mapControllerRef: RefObject<MapController | null>;
}

/**
 * Lets users click a single pixel on the Time Slider's raster stack and chart
 * its value over time (e.g. an annual Landsat COG series). Surfaces a trigger
 * button whenever the Time Slider is active with a raster source, drives a
 * pick-a-pixel map mode, then opens a dialog with the value-over-time line chart
 * and CSV / GeoParquet export of the underlying table.
 *
 * The pixel reads happen client-side via HTTP range reads (the same reader as
 * the single-COG Identify tool), so no Python sidecar is required.
 */
export function PixelTimeSeriesControl({
  mapControllerRef,
}: PixelTimeSeriesControlProps) {
  const { t } = useTranslation();
  const { isActive } = usePluginRegistry();
  const timeSliderActive = isActive(TIME_SLIDER_PLUGIN_ID);
  // The Time Slider mirrors each raster source into a store layer, so this
  // reacts when a COG stack is added or removed without polling the control.
  const hasRasterStack = useAppStore((s) =>
    s.layers.some(
      (layer) =>
        layer.metadata.sourceKind === "time-slider" && layer.type === "raster",
    ),
  );

  const [picking, setPicking] = useState(false);
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<PixelTimeSeriesResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [exporting, setExporting] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Leaving the time-slider stack (dock closed or stack removed) cancels an
  // in-progress pick so the crosshair cursor and click handler do not linger.
  useEffect(() => {
    if (!timeSliderActive || !hasRasterStack) setPicking(false);
  }, [timeSliderActive, hasRasterStack]);

  const runQuery = useCallback(async (lngLat: [number, number]) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setError(null);
    setResult(null);
    setProgress({ done: 0, total: 0 });
    setOpen(true);
    try {
      const res = await queryPixelTimeSeries(lngLat, {
        signal: ac.signal,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      if (ac.signal.aborted) return;
      setResult(res);
    } catch (err) {
      if (ac.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (abortRef.current === ac) setProgress(null);
    }
  }, []);

  // While picking, swap the cursor to a crosshair and capture the next map click
  // as the query location. Esc cancels.
  useEffect(() => {
    if (!picking) return;
    const map = mapControllerRef.current?.getMap();
    if (!map) {
      setPicking(false);
      return;
    }
    const canvas = map.getCanvas();
    const prevCursor = canvas.style.cursor;
    canvas.style.cursor = "crosshair";
    const onClick = (event: { lngLat: { lng: number; lat: number } }) => {
      setPicking(false);
      void runQuery([event.lngLat.lng, event.lngLat.lat]);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPicking(false);
    };
    map.on("click", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      map.off("click", onClick);
      window.removeEventListener("keydown", onKey);
      canvas.style.cursor = prevCursor;
    };
  }, [picking, runQuery, mapControllerRef]);

  const handleExport = useCallback(
    async (format: "csv" | "geoparquet") => {
      if (!result) return;
      setExporting(true);
      try {
        const collection = seriesToFeatureCollection(result);
        const [lng, lat] = result.lngLat;
        const baseName = `pixel-time-series_${lat.toFixed(4)}_${lng.toFixed(4)}`;
        await exportVectorLayer(collection, format, baseName);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setExporting(false);
      }
    },
    [result],
  );

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) abortRef.current?.abort();
  }, []);

  if (!timeSliderActive || !hasRasterStack) return null;

  return (
    <>
      <div className="pointer-events-none absolute left-1/2 top-3 z-20 flex -translate-x-1/2 flex-col items-center gap-2">
        {picking ? (
          <div
            className="pointer-events-auto flex items-center gap-2 rounded-md border bg-background/95 px-3 py-2 text-sm shadow-lg backdrop-blur-sm"
            role="region"
            aria-label={t("map.pixelTimeSeriesMode.title")}
            data-testid="pixel-time-series-mode-banner"
          >
            <Crosshair
              className="h-4 w-4 shrink-0 text-primary"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <p className="font-medium">{t("map.pixelTimeSeriesMode.title")}</p>
              <p className="text-xs text-muted-foreground">
                {t("map.pixelTimeSeriesMode.hint")}
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => setPicking(false)}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              {t("map.pixelTimeSeriesMode.exit")}
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="pointer-events-auto shadow-lg"
            onClick={() => setPicking(true)}
            data-testid="pixel-time-series-trigger"
          >
            <LineChart className="h-3.5 w-3.5" aria-hidden="true" />
            {t("map.pixelTimeSeriesMode.start")}
          </Button>
        )}
      </div>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("pixelTimeSeries.title")}</DialogTitle>
            <DialogDescription>
              {result
                ? t("pixelTimeSeries.subtitle", {
                    lat: result.lngLat[1].toFixed(5),
                    lng: result.lngLat[0].toFixed(5),
                  })
                : t("pixelTimeSeries.querying")}
            </DialogDescription>
          </DialogHeader>

          {error ? (
            <p
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              role="alert"
            >
              {error}
            </p>
          ) : !result ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              {progress && progress.total > 0
                ? t("pixelTimeSeries.progress", {
                    done: progress.done,
                    total: progress.total,
                  })
                : t("pixelTimeSeries.querying")}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <PixelTimeSeriesChart result={result} />
              {result.truncated ? (
                <p className="text-xs text-muted-foreground">
                  {t("pixelTimeSeries.truncated", { count: result.stepCount })}
                </p>
              ) : null}
              <div className="flex items-center justify-end gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={exporting}
                  onClick={() => handleExport("csv")}
                >
                  <Download className="h-3.5 w-3.5" aria-hidden="true" />
                  {t("pixelTimeSeries.exportCsv")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={exporting}
                  onClick={() => handleExport("geoparquet")}
                >
                  <Download className="h-3.5 w-3.5" aria-hidden="true" />
                  {t("pixelTimeSeries.exportGeoParquet")}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

// Chart geometry. Scales to its container via viewBox/width=100%.
const CHART_W = 580;
const CHART_H = 280;
const MARGIN = { top: 16, right: 16, bottom: 44, left: 56 };
const INNER_W = CHART_W - MARGIN.left - MARGIN.right;
const INNER_H = CHART_H - MARGIN.top - MARGIN.bottom;
const AXIS = "hsl(var(--border))";
const TICK = "hsl(var(--muted-foreground))";
// Theme primary first, then a small fixed palette for additional sources.
const SERIES_COLORS = [
  "hsl(var(--primary))",
  "hsl(12 76% 61%)",
  "hsl(173 58% 39%)",
  "hsl(262 52% 56%)",
  "hsl(43 74% 49%)",
];

/** Format an axis value compactly, dropping noise digits on large magnitudes. */
function formatValue(value: number): string {
  if (!Number.isFinite(value)) return "";
  const abs = Math.abs(value);
  if (abs !== 0 && (abs >= 1e6 || abs < 1e-3)) return value.toExponential(1);
  return Number(value.toFixed(abs >= 100 ? 0 : 2)).toString();
}

/** Shorten an ISO date to its year when the stack steps on Jan 1 (annual COGs). */
function axisDateLabel(date: string, annual: boolean): string {
  return annual ? date.slice(0, 4) : date;
}

/**
 * Dependency-free SVG line chart of pixel value over time, one polyline per
 * source. Matches the attribute-table Charts panel's look (CSS-variable colors,
 * gap-on-missing lines) but labels the x-axis with timeline dates rather than
 * feature order.
 */
function PixelTimeSeriesChart({ result }: { result: PixelTimeSeriesResult }) {
  const { t } = useTranslation();
  const steps = result.series[0]?.points ?? [];
  const length = steps.length;

  const values: number[] = [];
  for (const series of result.series) {
    for (const point of series.points) {
      if (point.value != null) values.push(point.value);
    }
  }
  if (values.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center rounded-md border text-sm text-muted-foreground">
        {t("pixelTimeSeries.noValues")}
      </div>
    );
  }

  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    // Pad a flat series so the single value sits mid-axis with room to read.
    min -= 1;
    max += 1;
  }

  const annual = steps.every((point) => point.date.endsWith("-01-01"));
  const scaleX = (index: number) =>
    MARGIN.left + (length > 1 ? index / (length - 1) : 0.5) * INNER_W;
  const scaleY = (value: number) =>
    MARGIN.top + INNER_H - ((value - min) / (max - min)) * INNER_H;

  // First, middle, and last x-axis ticks, deduped for short series.
  const tickIndexes = Array.from(
    new Set(
      length <= 1
        ? [0]
        : [0, Math.floor((length - 1) / 2), length - 1],
    ),
  );

  return (
    <figure className="flex flex-col gap-2">
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        width="100%"
        role="img"
        aria-label={t("pixelTimeSeries.chartAria")}
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
        {/* Y bounds */}
        <text
          x={MARGIN.left - 6}
          y={MARGIN.top}
          textAnchor="end"
          dominantBaseline="middle"
          fontSize={10}
          fill={TICK}
        >
          {formatValue(max)}
        </text>
        <text
          x={MARGIN.left - 6}
          y={MARGIN.top + INNER_H}
          textAnchor="end"
          dominantBaseline="middle"
          fontSize={10}
          fill={TICK}
        >
          {formatValue(min)}
        </text>
        {/* X ticks (dates) */}
        {tickIndexes.map((index) => (
          <text
            key={index}
            x={scaleX(index)}
            y={MARGIN.top + INNER_H + 16}
            textAnchor={
              index === 0 ? "start" : index === length - 1 ? "end" : "middle"
            }
            fontSize={10}
            fill={TICK}
          >
            {axisDateLabel(steps[index]?.date ?? "", annual)}
          </text>
        ))}
        {/* One polyline per source, breaking on missing values. */}
        {result.series.map((series, seriesIndex) => {
          const color = SERIES_COLORS[seriesIndex % SERIES_COLORS.length];
          let path = "";
          let penDown = false;
          series.points.forEach((point, index) => {
            if (point.value == null) {
              penDown = false;
              return;
            }
            const command = penDown ? "L" : "M";
            path += `${command}${scaleX(index)} ${scaleY(point.value)} `;
            penDown = true;
          });
          return (
            <g key={series.sourceId}>
              <path d={path.trim()} fill="none" stroke={color} strokeWidth={1.5} />
              {length <= 60
                ? series.points.map((point, index) =>
                    point.value == null ? null : (
                      <circle
                        key={index}
                        cx={scaleX(index)}
                        cy={scaleY(point.value)}
                        r={2.5}
                        fill={color}
                      >
                        <title>{`${point.date}: ${formatValue(point.value)}`}</title>
                      </circle>
                    ),
                  )
                : null}
            </g>
          );
        })}
      </svg>
      {result.series.length > 1 ? (
        <figcaption className="flex flex-wrap gap-3 text-xs text-muted-foreground">
          {result.series.map((series, seriesIndex) => (
            <span key={series.sourceId} className="flex items-center gap-1.5">
              <span
                className="inline-block h-2.5 w-2.5 rounded-sm"
                style={{
                  backgroundColor:
                    SERIES_COLORS[seriesIndex % SERIES_COLORS.length],
                }}
                aria-hidden="true"
              />
              {series.sourceName}
            </span>
          ))}
        </figcaption>
      ) : null}
    </figure>
  );
}
