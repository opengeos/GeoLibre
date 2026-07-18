import { useAppStore } from "@geolibre/core";
import {
  bandOptionsFromResults,
  hasTimeSliderRasterStack,
  type LabeledPixelTimeSeries,
  type PixelTimeSeriesResult,
  queryPixelTimeSeries,
  seriesToFeatureCollection,
  TIME_SLIDER_PLUGIN_ID,
  valueAtBand,
} from "@geolibre/plugins";
import { Button, Select } from "@geolibre/ui";
import { Crosshair, Download, GripVertical, LineChart, Loader2, Trash2, X } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { MapController } from "@geolibre/map";
import { clamp } from "../../lib/clamp";
import { usePluginRegistry } from "../../hooks/usePlugins";
import { exportVectorLayer } from "../../lib/vector-export";

/** Default panel geometry (px). The panel opens top-right, clear of the
 * Time Slider timeline at the bottom, then the user can drag/resize it. */
const PANEL_DEFAULT_W = 448;
const PANEL_MIN_W = 320;
const PANEL_MIN_H = 240;
const PANEL_MARGIN = 12;
const PANEL_TOP = 64;

/** A movable/resizable panel rect, in px relative to the map area. */
interface PanelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Theme primary first, then a small fixed palette for additional points. Kept
// above the component so its use inside the component does not rely on hoisting.
const SERIES_COLORS = [
  "hsl(var(--primary))",
  "hsl(12 76% 61%)",
  "hsl(173 58% 39%)",
  "hsl(262 52% 56%)",
  "hsl(43 74% 49%)",
];

// Dash pattern per source index within a point: source 0 is solid, extra
// sources (rare multi-COG stacks) get distinct dashes so they stay readable
// while sharing the point's color. The last entry covers any further sources.
const SOURCE_DASHES: (string | undefined)[] = [undefined, "4 3", "2 2", "8 3"];

interface PixelTimeSeriesControlProps {
  mapControllerRef: RefObject<MapController | null>;
}

/** A single clicked location and the state of its time-series query. */
interface ClickedPoint {
  /** Stable id, also used as the "Point N" label number. */
  id: number;
  /** Display label, e.g. "Point 1". */
  label: string;
  /** Clicked location, `[lng, lat]` in WGS84. */
  lngLat: [number, number];
  /** Index into the color palette for this point's chart line and swatch. */
  colorIndex: number;
  /** The query result once it resolves. */
  result: PixelTimeSeriesResult | null;
  /** Query error message, if the read failed. */
  error: string | null;
  /** Whether the query is still running. */
  loading: boolean;
}

/**
 * Lets users click pixels on the Time Slider's raster stack and chart their
 * values over time (e.g. an annual Landsat COG series). Surfaces a trigger
 * button whenever the Time Slider is active with a COG stack, drives a
 * pick-a-pixel map mode, and opens a *non-blocking* floating panel so the map
 * stays interactive: each click adds another point to the same chart, a band
 * picker switches which band is plotted across every point, and the underlying
 * table exports to CSV / GeoParquet.
 *
 * The pixel reads happen client-side via HTTP range reads (the same reader as
 * the single-COG Identify tool), so no Python sidecar is required.
 */
export function PixelTimeSeriesControl({ mapControllerRef }: PixelTimeSeriesControlProps) {
  const { t } = useTranslation();
  const { isActive } = usePluginRegistry();
  const timeSliderActive = isActive(TIME_SLIDER_PLUGIN_ID);
  // The Time Slider mirrors each raster source into a store layer, so this
  // reacts when a source is added or removed without polling the control. The
  // mirror cannot tell COG from XYZ/WMS, so it only re-renders this component;
  // hasTimeSliderRasterStack() (read live below) is what gates the trigger on a
  // pixel-readable COG stack, since the query engine only supports COG sources.
  const hasTimeSliderRasterMirror = useAppStore((s) =>
    s.layers.some(
      (layer) => layer.metadata.sourceKind === "time-slider" && layer.type === "raster",
    ),
  );
  const hasRasterStack = hasTimeSliderRasterMirror && hasTimeSliderRasterStack();

  const [picking, setPicking] = useState(false);
  const [open, setOpen] = useState(false);
  const [points, setPoints] = useState<ClickedPoint[]>([]);
  // Per-point read progress, kept out of `points` so the many sub-second
  // onProgress ticks during a query don't change the `points` reference and
  // invalidate chartSeries/loadedResults/bandOptions memos.
  const [progressById, setProgressById] = useState<Record<number, { done: number; total: number }>>(
    {},
  );
  const [selectedBand, setSelectedBand] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  // Export failures are kept separate from query errors so a failed export
  // shows an inline message beside the buttons instead of replacing the chart.
  const [exportError, setExportError] = useState<string | null>(null);

  // One AbortController per in-flight point query, so removing or re-querying a
  // single point cancels just that read. A monotonic counter gives each point a
  // stable id/label; it resets when the panel is emptied so labels restart at 1.
  const abortControllers = useRef<Map<number, AbortController>>(new Map());
  const idCounter = useRef(0);

  // Panel geometry. Null means "use the default top-right placement (CSS)"; once
  // the user drags or resizes, we switch to absolute px so the panel is fully
  // movable and resizable within the map area.
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [rect, setRect] = useState<PanelRect | null>(null);

  // The current panel rect relative to its positioned ancestor (the map area),
  // measured from the DOM so a drag/resize can begin from the CSS default.
  const measureRect = useCallback((): PanelRect => {
    const el = panelRef.current;
    if (!el) return { x: PANEL_MARGIN, y: PANEL_TOP, w: PANEL_DEFAULT_W, h: 400 };
    const parent = (el.offsetParent as HTMLElement | null) ?? el.parentElement;
    const pb = parent?.getBoundingClientRect();
    const eb = el.getBoundingClientRect();
    return {
      x: eb.left - (pb?.left ?? 0),
      y: eb.top - (pb?.top ?? 0),
      w: eb.width,
      h: eb.height,
    };
  }, []);

  // Shared pointer-capture drag loop: `onMove` receives the px delta from the
  // gesture start and the rect captured when it began.
  const startPointerGesture = useCallback(
    (
      event: ReactPointerEvent<HTMLElement>,
      onMove: (dx: number, dy: number, start: PanelRect, bounds?: DOMRect) => void,
    ) => {
      event.preventDefault();
      const start = rect ?? measureRect();
      if (!rect) setRect(start);
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const startY = event.clientY;
      const parent =
        (panelRef.current?.offsetParent as HTMLElement | null) ??
        panelRef.current?.parentElement ??
        null;
      const move = (m: PointerEvent) => {
        // Bail if the panel unmounted mid-gesture (e.g. reset() on Time Slider
        // deactivation) so we don't setState for a panel that is gone.
        if (!panelRef.current) return;
        onMove(m.clientX - startX, m.clientY - startY, start, parent?.getBoundingClientRect());
      };
      const end = () => {
        if (handle.hasPointerCapture(event.pointerId))
          handle.releasePointerCapture(event.pointerId);
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", end);
        handle.removeEventListener("pointercancel", end);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", end);
      handle.addEventListener("pointercancel", end);
    },
    [rect, measureRect],
  );

  const handleDragStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      // Let header buttons (close) work without starting a drag.
      if ((event.target as HTMLElement).closest("button")) return;
      startPointerGesture(event, (dx, dy, start, b) => {
        const maxX = b ? b.width - start.w - PANEL_MARGIN : Number.POSITIVE_INFINITY;
        const maxY = b ? b.height - start.h - PANEL_MARGIN : Number.POSITIVE_INFINITY;
        setRect({
          ...start,
          x: clamp(start.x + dx, 0, Math.max(0, maxX)),
          y: clamp(start.y + dy, 0, Math.max(0, maxY)),
        });
      });
    },
    [startPointerGesture],
  );

  const handleResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.stopPropagation();
      startPointerGesture(event, (dx, dy, start, b) => {
        const maxW = b ? b.width - start.x - PANEL_MARGIN : Number.POSITIVE_INFINITY;
        const maxH = b ? b.height - start.y - PANEL_MARGIN : Number.POSITIVE_INFINITY;
        setRect({
          ...start,
          w: clamp(start.w + dx, PANEL_MIN_W, Math.max(PANEL_MIN_W, maxW)),
          h: clamp(start.h + dy, PANEL_MIN_H, Math.max(PANEL_MIN_H, maxH)),
        });
      });
    },
    [startPointerGesture],
  );

  const abortAll = useCallback(() => {
    for (const ac of abortControllers.current.values()) ac.abort();
    abortControllers.current.clear();
  }, []);

  // Abort every in-flight query when the component unmounts so none can call
  // setState afterwards.
  useEffect(() => () => abortAll(), [abortAll]);

  const runQueryForPoint = useCallback((id: number, lngLat: [number, number]) => {
    abortControllers.current.get(id)?.abort();
    const ac = new AbortController();
    abortControllers.current.set(id, ac);
    const clearProgress = () =>
      setProgressById((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
    queryPixelTimeSeries(lngLat, {
      signal: ac.signal,
      onProgress: (done, total) => {
        if (ac.signal.aborted) return;
        setProgressById((prev) => ({ ...prev, [id]: { done, total } }));
      },
    })
      .then((res) => {
        if (ac.signal.aborted) return;
        setPoints((prev) =>
          prev.map((p) => (p.id === id ? { ...p, result: res, loading: false } : p)),
        );
        clearProgress();
        // First loaded point seeds the charted band; later points keep it.
        setSelectedBand((prev) => (prev == null ? res.defaultBandIndex : prev));
      })
      .catch((err) => {
        if (ac.signal.aborted) return;
        setPoints((prev) =>
          prev.map((p) =>
            p.id === id
              ? {
                  ...p,
                  error: err instanceof Error ? err.message : String(err),
                  loading: false,
                }
              : p,
          ),
        );
        clearProgress();
      })
      .finally(() => {
        if (abortControllers.current.get(id) === ac) abortControllers.current.delete(id);
      });
  }, []);

  // While picking, swap the cursor to a crosshair and capture each map click as
  // another point (the mode stays active so consecutive clicks accumulate).
  // Esc stops picking.
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
      const id = (idCounter.current += 1);
      const lngLat: [number, number] = [event.lngLat.lng, event.lngLat.lat];
      setPoints((prev) => [
        ...prev,
        {
          id,
          label: t("pixelTimeSeries.pointLabel", { number: id }),
          lngLat,
          colorIndex: (id - 1) % SERIES_COLORS.length,
          result: null,
          error: null,
          loading: true,
        },
      ]);
      setProgressById((prev) => ({ ...prev, [id]: { done: 0, total: 0 } }));
      runQueryForPoint(id, lngLat);
    };
    const onKey = (event: KeyboardEvent) => {
      // Skip if another overlay already handled this Escape (e.g. a dialog or
      // autocomplete closing), so picking isn't cancelled out from under it.
      if (event.key === "Escape" && !event.defaultPrevented) setPicking(false);
    };
    map.on("click", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      map.off("click", onClick);
      window.removeEventListener("keydown", onKey);
      canvas.style.cursor = prevCursor;
    };
  }, [picking, runQueryForPoint, mapControllerRef, t]);

  // Leaving the time-slider stack (dock closed or stack removed) tears the tool
  // down so the crosshair, panel, and click handler do not linger.
  const reset = useCallback(() => {
    abortAll();
    setPoints([]);
    setProgressById({});
    setSelectedBand(null);
    setExportError(null);
    setPicking(false);
    setOpen(false);
    setRect(null);
    idCounter.current = 0;
  }, [abortAll]);

  useEffect(() => {
    if (!timeSliderActive || !hasRasterStack) reset();
  }, [timeSliderActive, hasRasterStack, reset]);

  // The header X only hides the panel (and stops picking); the collected points
  // and their results survive so reopening restores them. "Clear all" is the
  // explicit wipe.
  const hidePanel = useCallback(() => {
    setPicking(false);
    setOpen(false);
  }, []);

  const removePoint = useCallback((id: number) => {
    abortControllers.current.get(id)?.abort();
    abortControllers.current.delete(id);
    setPoints((prev) => {
      const next = prev.filter((p) => p.id !== id);
      // Removing the last point empties the panel, so restart labels at 1 —
      // matching "Clear all" and the idCounter "resets when emptied" contract.
      if (next.length === 0) idCounter.current = 0;
      return next;
    });
    setProgressById((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const clearAll = useCallback(() => {
    abortAll();
    setPoints([]);
    setProgressById({});
    setSelectedBand(null);
    setExportError(null);
    idCounter.current = 0;
  }, [abortAll]);

  const loadedResults = useMemo(
    () => points.map((p) => p.result).filter((r): r is PixelTimeSeriesResult => r != null),
    [points],
  );
  const bandOptions = useMemo(() => bandOptionsFromResults(loadedResults), [loadedResults]);

  // One chart line per (point, source) for the selected band. Single-source
  // stacks (the common case) show one line per point; the legend disambiguates
  // by source name only when a point has more than one source. Memoized because
  // onProgress re-renders rapidly during a query and this scales with
  // points × sources × steps.
  const chartSeries = useMemo<ChartSeries[]>(
    () =>
      selectedBand == null
        ? []
        : points.flatMap((point) => {
            if (!point.result) return [];
            const multiSource = point.result.series.length > 1;
            return point.result.series.map((series, si) => ({
              key: `${point.id}:${series.sourceId}`,
              label: multiSource ? `${point.label} · ${series.sourceName}` : point.label,
              color: SERIES_COLORS[point.colorIndex],
              // Distinct dash per extra source so 3+ sources of one point stay
              // distinguishable (they share the point's color).
              dash: SOURCE_DASHES[Math.min(si, SOURCE_DASHES.length - 1)],
              points: series.points.map((pt) => ({
                date: pt.date,
                value: valueAtBand(pt, selectedBand),
              })),
            }));
          }),
    [points, selectedBand],
  );

  // Keep the selected band valid as points come and go.
  useEffect(() => {
    if (bandOptions.length === 0) return;
    if (selectedBand == null || !bandOptions.some((b) => b.index === selectedBand))
      setSelectedBand(bandOptions[0].index);
  }, [bandOptions, selectedBand]);

  // Show the most-downsampled truncated result (fewest kept steps), so when
  // points were queried against different timelines the notice reflects the
  // most aggressive downsampling rather than whichever happened to be first.
  const truncatedResult = loadedResults
    .filter((r) => r.truncated)
    .reduce<PixelTimeSeriesResult | null>(
      (worst, r) => (worst == null || r.stepCount < worst.stepCount ? r : worst),
      null,
    );
  const truncated = truncatedResult != null;
  const truncatedKept = truncatedResult?.stepCount ?? 0;
  const truncatedTotal = truncatedResult?.originalStepCount ?? 0;

  const handleExport = useCallback(
    async (format: "csv" | "geoparquet") => {
      const items: LabeledPixelTimeSeries[] = points
        .filter((p) => p.result)
        .map((p) => ({ label: p.label, result: p.result as PixelTimeSeriesResult }));
      if (items.length === 0) return;
      setExporting(true);
      setExportError(null);
      try {
        const collection = seriesToFeatureCollection(items);
        const baseName =
          items.length === 1
            ? `pixel-time-series_${items[0].result.lngLat[1].toFixed(4)}_${items[0].result.lngLat[0].toFixed(4)}`
            : `pixel-time-series_${items.length}-points`;
        await exportVectorLayer(collection, format, baseName);
      } catch (err) {
        setExportError(err instanceof Error ? err.message : String(err));
      } finally {
        setExporting(false);
      }
    },
    [points],
  );

  const startPicking = useCallback(() => {
    setOpen(true);
    setPicking(true);
  }, []);

  if (!timeSliderActive || !hasRasterStack) return null;

  const hasLoaded = loadedResults.length > 0;
  // Block export while any point is still querying: handleExport only includes
  // points that already resolved, so exporting mid-load would silently omit
  // them. Errored points (no result) are also excluded, so surface their count
  // below rather than dropping them without notice.
  const hasLoading = points.some((p) => p.loading);
  const erroredCount = points.filter((p) => p.error).length;
  return (
    <>
      <div className="pointer-events-none absolute left-1/2 top-3 z-20 flex -translate-x-1/2 flex-col items-center gap-2">
        {!open ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="pointer-events-auto shadow-lg"
            onClick={startPicking}
            data-testid="pixel-time-series-trigger"
          >
            <LineChart className="h-3.5 w-3.5" aria-hidden="true" />
            {t("map.pixelTimeSeriesMode.start")}
          </Button>
        ) : picking ? (
          <div
            className="pointer-events-auto flex items-center gap-2 rounded-md border bg-background/95 px-3 py-2 text-sm shadow-lg backdrop-blur-sm"
            role="region"
            aria-label={t("map.pixelTimeSeriesMode.title")}
            data-testid="pixel-time-series-mode-banner"
          >
            <Crosshair className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            <div className="min-w-0">
              <p className="font-medium">{t("map.pixelTimeSeriesMode.title")}</p>
              <p className="text-xs text-muted-foreground">{t("map.pixelTimeSeriesMode.hint")}</p>
            </div>
            <Button type="button" size="sm" variant="secondary" onClick={() => setPicking(false)}>
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              {t("map.pixelTimeSeriesMode.exit")}
            </Button>
          </div>
        ) : null}
      </div>

      {open ? (
        <div
          ref={panelRef}
          className={
            rect
              ? "pointer-events-auto absolute z-20 flex flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
              : "pointer-events-auto absolute right-3 top-16 z-20 flex max-h-[calc(100%-8rem)] w-[min(28rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
          }
          style={rect ? { left: rect.x, top: rect.y, width: rect.w, height: rect.h } : undefined}
          role="region"
          aria-label={t("pixelTimeSeries.title")}
          data-testid="pixel-time-series-panel"
        >
          <div
            className="flex cursor-move touch-none select-none items-center justify-between gap-2 border-b px-3 py-2"
            onPointerDown={handleDragStart}
          >
            <div className="flex items-center gap-2 text-sm font-semibold">
              <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <LineChart className="h-4 w-4 text-primary" aria-hidden="true" />
              {t("pixelTimeSeries.title")}
            </div>
            <button
              type="button"
              className="rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring"
              onClick={hidePanel}
              aria-label={t("pixelTimeSeries.close")}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
            {bandOptions.length > 0 ? (
              <label className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">{t("pixelTimeSeries.band")}</span>
                <Select
                  className="w-44"
                  value={selectedBand ?? ""}
                  onChange={(e) => setSelectedBand(Number(e.target.value))}
                >
                  {bandOptions.map((band) => (
                    <option key={band.index} value={band.index}>
                      {band.name ?? t("pixelTimeSeries.bandOption", { index: band.index })}
                    </option>
                  ))}
                </Select>
              </label>
            ) : null}

            {hasLoaded ? (
              <PixelTimeSeriesChart series={chartSeries} />
            ) : (
              <div className="flex items-center gap-2 rounded-md border border-dashed px-3 py-8 text-sm text-muted-foreground">
                {points.some((p) => p.loading) ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    {t("pixelTimeSeries.querying")}
                  </>
                ) : (
                  <>
                    <Crosshair className="h-4 w-4 shrink-0" aria-hidden="true" />
                    {t("pixelTimeSeries.empty")}
                  </>
                )}
              </div>
            )}

            {truncated ? (
              <p className="text-xs text-muted-foreground">
                {t("pixelTimeSeries.truncated", {
                  kept: truncatedKept,
                  total: truncatedTotal,
                })}
              </p>
            ) : null}

            {points.length > 0 ? (
              <ul className="flex flex-col gap-1" data-testid="pixel-time-series-points">
                {points.map((point) => {
                  const prog = progressById[point.id];
                  return (
                    <li
                      key={point.id}
                      className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm"
                    >
                      <span
                        className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                        style={{
                          backgroundColor: SERIES_COLORS[point.colorIndex],
                        }}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="font-medium">{point.label}</span>{" "}
                        <span className="text-xs text-muted-foreground">
                          {point.lngLat[1].toFixed(4)}, {point.lngLat[0].toFixed(4)}
                        </span>
                        {point.loading ? (
                          <span className="flex items-center gap-1 text-xs text-muted-foreground">
                            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                            {prog && prog.total > 0
                              ? t("pixelTimeSeries.progress", {
                                  done: prog.done,
                                  total: prog.total,
                                })
                              : t("pixelTimeSeries.querying")}
                          </span>
                        ) : point.error ? (
                          <span className="block text-xs text-destructive">{point.error}</span>
                        ) : null}
                      </span>
                      <button
                        type="button"
                        className="rounded-sm p-1 opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring"
                        onClick={() => removePoint(point.id)}
                        aria-label={t("pixelTimeSeries.removePoint", {
                          label: point.label,
                        })}
                      >
                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2">
            <Button
              type="button"
              size="sm"
              variant={picking ? "secondary" : "default"}
              onClick={() => setPicking((p) => !p)}
              aria-pressed={picking}
            >
              <Crosshair className="h-3.5 w-3.5" aria-hidden="true" />
              {picking ? t("pixelTimeSeries.stopPicking") : t("pixelTimeSeries.pickPoints")}
            </Button>
            {points.length > 0 ? (
              <Button type="button" size="sm" variant="ghost" onClick={clearAll}>
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                {t("pixelTimeSeries.clearAll")}
              </Button>
            ) : null}
            {exportError ? (
              <p className="w-full text-xs text-destructive" role="alert">
                {exportError}
              </p>
            ) : erroredCount > 0 ? (
              <p className="w-full text-xs text-muted-foreground">
                {t("pixelTimeSeries.erroredExcluded", { n: erroredCount })}
              </p>
            ) : null}
            <div className="ms-auto flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!hasLoaded || hasLoading || exporting}
                onClick={() => handleExport("csv")}
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                {t("pixelTimeSeries.exportCsv")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!hasLoaded || hasLoading || exporting}
                onClick={() => handleExport("geoparquet")}
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                {t("pixelTimeSeries.exportGeoParquet")}
              </Button>
            </div>
          </div>

          {/* Resize grip (bottom-right). The diagonal lines hint the affordance.
              Mouse/touch-only, so it is presentational — there is no keyboard
              resize to expose to assistive tech. */}
          <div
            className="absolute bottom-0 right-0 h-4 w-4 cursor-se-resize touch-none"
            onPointerDown={handleResizeStart}
            role="presentation"
          >
            <svg
              viewBox="0 0 10 10"
              className="h-full w-full text-muted-foreground"
              aria-hidden="true"
            >
              <path d="M9 1 L1 9 M9 5 L5 9" stroke="currentColor" strokeWidth={1} fill="none" />
            </svg>
          </div>
        </div>
      ) : null}
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

/** A single chartable line: a point's value-over-time for the selected band. */
interface ChartSeries {
  key: string;
  label: string;
  color: string;
  /** SVG dash pattern, for distinguishing extra sources of the same point. */
  dash?: string;
  points: { date: string; value: number | null }[];
}

/** Format an axis value compactly, dropping noise digits on large magnitudes. */
function formatValue(value: number): string {
  if (!Number.isFinite(value)) return "";
  const abs = Math.abs(value);
  if (abs !== 0 && (abs >= 1e6 || abs <= 1e-3)) return value.toExponential(1);
  return Number(value.toFixed(abs >= 100 ? 0 : 2)).toString();
}

/** Shorten an ISO date to its year when the stack steps on Jan 1 (annual COGs). */
function axisDateLabel(date: string, annual: boolean): string {
  return annual ? date.slice(0, 4) : date;
}

/**
 * Dependency-free SVG line chart of pixel value over time, one polyline per
 * clicked point (for the selected band). Matches the attribute-table Charts
 * panel's look (CSS-variable colors, gap-on-missing lines) but labels the
 * x-axis with timeline dates rather than feature order.
 */
function PixelTimeSeriesChart({ series }: { series: ChartSeries[] }) {
  const { t } = useTranslation();

  const values: number[] = [];
  for (const line of series)
    for (const point of line.points) if (point.value != null) values.push(point.value);

  if (values.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center rounded-md border text-sm text-muted-foreground">
        {t("pixelTimeSeries.noValues")}
      </div>
    );
  }

  // Reduce instead of Math.min/max(...values) so a large multi-point series
  // cannot blow the argument-spread stack limit.
  let min = values[0];
  let max = values[0];
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === max) {
    // Pad a flat series so the single value sits mid-axis with room to read.
    min -= 1;
    max += 1;
  }

  // Align every line on a shared, sorted union of dates so points queried
  // against different timelines (e.g. the user changed the step range between
  // clicks) line up by calendar date rather than by raw index.
  const allDates = [...new Set(series.flatMap((line) => line.points.map((p) => p.date)))].sort();
  const length = allDates.length;
  const annual = allDates.every((date) => date.endsWith("-01-01"));

  // Each line's value at every shared date (null where it has no reading).
  const alignedSeries = series.map((line) => {
    const byDate = new Map(line.points.map((p) => [p.date, p.value]));
    return {
      ...line,
      values: allDates.map((date) => byDate.get(date) ?? null),
    };
  });

  const scaleX = (index: number) =>
    MARGIN.left + (length > 1 ? index / (length - 1) : 0.5) * INNER_W;
  const scaleY = (value: number) => MARGIN.top + INNER_H - ((value - min) / (max - min)) * INNER_H;

  // First, middle, and last x-axis ticks, deduped for short series.
  const tickIndexes = Array.from(
    new Set(length <= 1 ? [0] : [0, Math.floor((length - 1) / 2), length - 1]),
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
            textAnchor={index === 0 ? "start" : index === length - 1 ? "end" : "middle"}
            fontSize={10}
            fill={TICK}
          >
            {axisDateLabel(allDates[index] ?? "", annual)}
          </text>
        ))}
        {/* One polyline per point, breaking on missing values. */}
        {alignedSeries.map((line) => {
          let path = "";
          let penDown = false;
          line.values.forEach((value, index) => {
            if (value == null) {
              penDown = false;
              return;
            }
            const command = penDown ? "L" : "M";
            path += `${command}${scaleX(index)} ${scaleY(value)} `;
            penDown = true;
          });
          return (
            <g key={line.key}>
              <path
                d={path.trim()}
                fill="none"
                stroke={line.color}
                strokeWidth={1.5}
                strokeDasharray={line.dash}
              />
              {length <= 60
                ? line.values.map((value, index) =>
                    value == null ? null : (
                      <circle
                        key={index}
                        cx={scaleX(index)}
                        cy={scaleY(value)}
                        r={2.5}
                        fill={line.color}
                      >
                        <title>{`${allDates[index]}: ${formatValue(value)}`}</title>
                      </circle>
                    ),
                  )
                : null}
            </g>
          );
        })}
      </svg>
      {series.length > 1 ? (
        <figcaption className="flex flex-wrap gap-3 text-xs text-muted-foreground">
          {series.map((line) => (
            <span key={line.key} className="flex items-center gap-1.5">
              <span
                className="inline-block h-2.5 w-2.5 rounded-sm"
                style={{ backgroundColor: line.color }}
                aria-hidden="true"
              />
              {line.label}
            </span>
          ))}
        </figcaption>
      ) : null}
    </figure>
  );
}
