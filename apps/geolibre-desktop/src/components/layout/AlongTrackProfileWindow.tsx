import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import { Button } from "@geolibre/ui";
import { Download, GripVertical, Image as ImageIcon, LineChart, RotateCcw, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { useFloatingPanelRect } from "../../hooks/useFloatingPanelRect";
import {
  buildProfilePoints,
  fieldSeries,
  nearestProfileIndex,
  profileBeams,
  profileCsv,
  profileFields,
  profileGapThreshold,
  profilePath,
  profilePresets,
  spaceborneLidarProduct,
  type ProfileSeriesDef,
} from "../../lib/along-track-profile";
import {
  closeAlongTrackProfile,
  getAlongTrackProfileLayerId,
  subscribeAlongTrackProfile,
} from "../../lib/along-track-profile-store";
import { downloadChartPng, triggerDownload } from "../../lib/chart-export";
import { niceTickValues } from "../../lib/netcdf-profile-series";
import { sanitizeExportFileName } from "../../lib/vector-export";
import { paletteColor } from "../panels/charts/chart-colors";

const PANEL_MIN_W = 420;
const PANEL_MIN_H = 300;
const PANEL_MARGIN = 12;
// Below the NetCDF profile window's top, so both headers stay grabbable.
const FALLBACK_RECT = { x: PANEL_MARGIN, y: 96, w: 640, h: 380 };
const MARGIN = { top: 12, right: 16, bottom: 34, left: 58 };
const AXIS = "hsl(var(--border))";
const TICK = "hsl(var(--muted-foreground))";
/** Ground in an earth tone and canopy in green, readable in light and dark. */
const PRESET_COLORS = ["#b45309", "#16a34a"];
/** How many fields "Fields" mode plots at once. */
const MAX_FIELDS = 3;
const MIN_SPAN_KM = 0.05;

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "";
  const abs = Math.abs(value);
  if (abs !== 0 && (abs >= 1e6 || abs < 1e-3)) return value.toExponential(2);
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: abs >= 100 ? 1 : 3 }).format(
    value,
  );
}

/**
 * The along-track profile of an ICESat-2 / GEDI footprint layer: distance along
 * one beam against ground and canopy height (or any numeric field), in a
 * movable window over the map.
 *
 * Linked to the map both ways: hovering the chart drops a marker on that
 * footprint, clicking selects it (the map highlights it), and selecting a
 * footprint on the map marks it on the chart, switching beams if needed.
 * Wheel to zoom along the track, drag to pan, double-click to reset.
 *
 * @param props.mapControllerRef The primary map engine, for the hover marker.
 * @returns The window, or null while no footprint layer is charted.
 */
export function AlongTrackProfileWindow({
  mapControllerRef,
}: {
  mapControllerRef: RefObject<MapEngine | null>;
}) {
  const layerId = useSyncExternalStore(
    subscribeAlongTrackProfile,
    getAlongTrackProfileLayerId,
    getAlongTrackProfileLayerId,
  );
  const layer = useAppStore((state) =>
    layerId ? state.layers.find((candidate) => candidate.id === layerId) : undefined,
  );

  // The layer was removed (or a project replaced it): close instead of
  // charting a stale id.
  useEffect(() => {
    if (layerId && !layer) closeAlongTrackProfile();
  }, [layerId, layer]);

  if (!layerId || !layer) return null;
  return <ProfileWindow key={layer.id} layer={layer} mapControllerRef={mapControllerRef} />;
}

function ProfileWindow({
  layer,
  mapControllerRef,
}: {
  layer: GeoLibreLayer;
  mapControllerRef: RefObject<MapEngine | null>;
}) {
  const { t } = useTranslation();
  const { panelRef, rect, handleDragStart, handleResizeStart } = useFloatingPanelRect({
    minWidth: PANEL_MIN_W,
    minHeight: PANEL_MIN_H,
    margin: PANEL_MARGIN,
    fallback: FALLBACK_RECT,
  });
  const selectLayer = useAppStore((state) => state.selectLayer);
  const selectFeature = useAppStore((state) => state.selectFeature);
  const selectedFeatureId = useAppStore((state) =>
    state.selectedLayerId === layer.id ? state.selectedFeatureId : null,
  );

  const product = spaceborneLidarProduct(layer);
  const beams = useMemo(() => profileBeams(layer), [layer]);
  const fields = useMemo(() => profileFields(layer), [layer]);
  const presets = useMemo(() => profilePresets(product, fields), [product, fields]);

  // Open on a strong / power beam when there is one: they hold the most
  // footprints and the cleanest returns.
  const [beam, setBeam] = useState(
    () => (beams.find((b) => b.type === "strong" || b.type === "power") ?? beams[0])?.name ?? "",
  );
  const [mode, setMode] = useState<string>(presets[0]?.id ?? "fields");
  const [chosenFields, setChosenFields] = useState<string[]>(() => fields.slice(0, 1));

  const series: ProfileSeriesDef[] = useMemo(() => {
    const preset = presets.find((candidate) => candidate.id === mode);
    if (preset) return preset.series;
    return chosenFields.filter((name) => fields.includes(name)).map(fieldSeries);
  }, [presets, mode, chosenFields, fields]);
  const colors = series.map((_, index) =>
    presets.some((candidate) => candidate.id === mode)
      ? (PRESET_COLORS[index] ?? paletteColor(index))
      : paletteColor(index),
  );
  const seriesLabel = (def: ProfileSeriesDef) =>
    def.labelKey ? t(`alongTrackProfile.series.${def.labelKey}`) : def.key;

  const points = useMemo(() => buildProfilePoints(layer, beam, series), [layer, beam, series]);
  const gap = useMemo(() => profileGapThreshold(points), [points]);
  const fullDomain = useMemo<[number, number]>(() => {
    if (points.length === 0) return [0, 1];
    const first = points[0].distance;
    const last = points[points.length - 1].distance;
    return last > first ? [first, last] : [first - 0.5, last + 0.5];
  }, [points]);
  const [xDomain, setXDomain] = useState<[number, number] | null>(null);
  // A new beam or field set starts zoomed out.
  useEffect(() => setXDomain(null), [beam, series]);
  const domain = xDomain ?? fullDomain;

  // Map selection → chart: follow a footprint selected on another beam.
  useEffect(() => {
    if (selectedFeatureId === null) return;
    const feature = layer.geojson?.features.find(
      (candidate, index) => String(candidate.id ?? index) === selectedFeatureId,
    );
    const selectedBeam = (feature?.properties as Record<string, unknown> | null)?.beam;
    if (typeof selectedBeam === "string" && selectedBeam !== beam) setBeam(selectedBeam);
  }, [selectedFeatureId, layer, beam]);

  // Chart size follows the window.
  const plotRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 600, height: 240 });
  useLayoutEffect(() => {
    const element = plotRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setSize({ width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const innerW = Math.max(10, size.width - MARGIN.left - MARGIN.right);
  const innerH = Math.max(10, size.height - MARGIN.top - MARGIN.bottom);

  // The points inside the x domain (sorted, so two binary searches).
  const visible = useMemo(() => {
    if (points.length === 0) return points;
    const start = Math.max(0, nearestProfileIndex(points, domain[0]) - 1);
    const end = Math.min(points.length, nearestProfileIndex(points, domain[1]) + 2);
    return points.slice(start, end);
  }, [points, domain]);

  const yDomain = useMemo<[number, number]>(() => {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    // Only footprints inside the window: the one beyond each edge is kept for
    // drawing the line into view, but must not stretch the y range.
    const inside = visible.filter((p) => p.distance >= domain[0] && p.distance <= domain[1]);
    for (const point of inside.length > 0 ? inside : visible) {
      for (const value of point.values) {
        if (value === null) continue;
        if (value < min) min = value;
        if (value > max) max = value;
      }
    }
    if (!Number.isFinite(min)) return [0, 1];
    const pad = (max - min) * 0.05 || 1;
    return [min - pad, max + pad];
  }, [visible, domain]);

  const x = useCallback(
    (distance: number) => MARGIN.left + ((distance - domain[0]) / (domain[1] - domain[0])) * innerW,
    [domain, innerW],
  );
  const y = useCallback(
    (value: number) =>
      MARGIN.top + innerH - ((value - yDomain[0]) / (yDomain[1] - yDomain[0])) * innerH,
    [yDomain, innerH],
  );
  const distanceAt = (px: number) =>
    domain[0] + ((px - MARGIN.left) / innerW) * (domain[1] - domain[0]);

  const paths = useMemo(
    () => series.map((_, index) => profilePath(visible, index, x, y, gap)),
    [series, visible, x, y, gap],
  );
  const xTicks = niceTickValues(domain[0], domain[1], Math.max(2, Math.floor(innerW / 90)));
  const yTicks = niceTickValues(yDomain[0], yDomain[1], Math.max(2, Math.floor(innerH / 45)));

  // Hover: a crosshair on the chart and a marker on the map.
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const hoverMarker = useRef<(() => void) | null>(null);
  const hoverFrame = useRef<number | null>(null);
  const clearHoverMarker = useCallback(() => {
    if (hoverFrame.current !== null) cancelAnimationFrame(hoverFrame.current);
    hoverFrame.current = null;
    hoverMarker.current?.();
    hoverMarker.current = null;
  }, []);
  useEffect(() => clearHoverMarker, [clearHoverMarker]);
  const hovered = hoverIndex !== null ? points[hoverIndex] : undefined;
  useEffect(() => {
    if (!hovered) {
      clearHoverMarker();
      return;
    }
    if (hoverFrame.current !== null) cancelAnimationFrame(hoverFrame.current);
    hoverFrame.current = requestAnimationFrame(() => {
      hoverFrame.current = null;
      hoverMarker.current?.();
      hoverMarker.current =
        mapControllerRef.current?.showSearchResult({
          type: "Point",
          coordinates: hovered.coordinates,
        }) ?? null;
    });
  }, [hovered, mapControllerRef, clearHoverMarker]);

  const selectedIndex = useMemo(
    () =>
      selectedFeatureId === null
        ? -1
        : points.findIndex((point) => point.featureId === selectedFeatureId),
    [points, selectedFeatureId],
  );

  // Wheel zoom around the cursor; drag to pan.
  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ startX: number; domain: [number, number]; moved: boolean } | null>(null);
  const localX = (clientX: number) => clientX - (svgRef.current?.getBoundingClientRect().left ?? 0);
  const clampDomain = (lo: number, hi: number): [number, number] => {
    const [fullLo, fullHi] = fullDomain;
    const span = Math.min(Math.max(hi - lo, MIN_SPAN_KM), fullHi - fullLo);
    let start = Math.max(fullLo, Math.min(lo, fullHi - span));
    if (start + span > fullHi) start = fullHi - span;
    return [start, start + span];
  };
  const onWheel = (event: ReactWheelEvent<SVGSVGElement>) => {
    if (points.length === 0) return;
    const px = localX(event.clientX);
    const factor = event.deltaY > 0 ? 1.25 : 0.8;
    // From the latest domain, not this render's: wheel events can arrive
    // faster than React re-renders, and each must zoom from the last.
    setXDomain((previous) => {
      const [lo, hi] = previous ?? fullDomain;
      const center = lo + ((px - MARGIN.left) / innerW) * (hi - lo);
      return clampDomain(center - (center - lo) * factor, center + (hi - center) * factor);
    });
  };
  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    drag.current = { startX: event.clientX, domain, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const active = drag.current;
    if (active && Math.abs(event.clientX - active.startX) > 3) {
      active.moved = true;
      const shift =
        ((event.clientX - active.startX) / innerW) * (active.domain[1] - active.domain[0]);
      setXDomain(clampDomain(active.domain[0] - shift, active.domain[1] - shift));
      setHoverIndex(null);
      return;
    }
    const px = localX(event.clientX);
    if (px < MARGIN.left || px > MARGIN.left + innerW || points.length === 0) {
      setHoverIndex(null);
      return;
    }
    const nearest = nearestProfileIndex(points, distanceAt(px));
    // In a gap, the nearest footprint may sit outside the view; show none.
    const inView =
      nearest >= 0 &&
      points[nearest].distance >= domain[0] &&
      points[nearest].distance <= domain[1];
    setHoverIndex(inView ? nearest : null);
  };
  const onPointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    const active = drag.current;
    drag.current = null;
    if (active && !active.moved && hoverIndex !== null) {
      // Click: select the footprint so the map highlights it.
      selectLayer(layer.id);
      selectFeature(points[hoverIndex].featureId);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const labels = series.map(seriesLabel);
  const exportBase = sanitizeExportFileName(`${layer.name}-${beam}-profile`);
  const [exportError, setExportError] = useState<string | null>(null);
  const downloadPng = () => {
    const svg = svgRef.current;
    if (!svg) return;
    setExportError(null);
    downloadChartPng(svg, size.width, size.height, `${exportBase}.png`).catch((error: unknown) =>
      setExportError(error instanceof Error ? error.message : t("alongTrackProfile.exportError")),
    );
  };
  const downloadCsv = () => {
    triggerDownload(
      new Blob([profileCsv(points, labels)], { type: "text/csv;charset=utf-8" }),
      `${exportBase}.csv`,
    );
  };

  const toggleField = (name: string) =>
    setChosenFields((current) =>
      current.includes(name)
        ? current.filter((existing) => existing !== name)
        : [...current, name].slice(-MAX_FIELDS),
    );

  const tooltipLeft = hovered
    ? Math.min(Math.max(x(hovered.distance), MARGIN.left), MARGIN.left + innerW)
    : 0;
  const tooltipOnLeft = tooltipLeft > size.width / 2;

  return (
    <div
      ref={panelRef}
      className={
        rect
          ? "pointer-events-auto absolute z-20 flex flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
          : "pointer-events-auto absolute start-3 top-24 z-20 flex h-[24rem] max-h-[calc(100%-9rem)] w-[min(40rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
      }
      style={rect ? { left: rect.x, top: rect.y, width: rect.w, height: rect.h } : undefined}
      role="region"
      aria-label={t("alongTrackProfile.heading")}
      data-testid="along-track-profile-window"
    >
      <div
        className="flex cursor-move touch-none select-none items-center justify-between gap-2 border-b px-3 py-2"
        onPointerDown={handleDragStart}
      >
        <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
          <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <LineChart className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <span className="truncate">
            {t("alongTrackProfile.heading")} · {layer.name}
          </span>
        </div>
        <button
          type="button"
          className="rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring"
          onClick={closeAlongTrackProfile}
          aria-label={t("alongTrackProfile.close")}
          title={t("alongTrackProfile.close")}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-xs">
        <label className="flex items-center gap-1">
          {t("alongTrackProfile.beam")}
          <select
            className="rounded border bg-background px-1 py-0.5"
            value={beam}
            onChange={(event) => setBeam(event.target.value)}
          >
            {beams.map((entry) => (
              <option key={entry.name} value={entry.name}>
                {entry.type ? `${entry.name} (${entry.type})` : entry.name} · {entry.count}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          {t("alongTrackProfile.show")}
          <select
            className="rounded border bg-background px-1 py-0.5"
            value={mode}
            onChange={(event) => setMode(event.target.value)}
          >
            {presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {t(`alongTrackProfile.preset.${preset.labelKey}`)}
              </option>
            ))}
            <option value="fields">{t("alongTrackProfile.preset.fields")}</option>
          </select>
        </label>
        {mode === "fields" && (
          <div
            className="flex flex-wrap items-center gap-1"
            role="group"
            aria-label={t("alongTrackProfile.fields")}
          >
            {fields.map((name) => (
              <button
                key={name}
                type="button"
                aria-pressed={chosenFields.includes(name)}
                className={
                  chosenFields.includes(name)
                    ? "rounded border border-primary bg-primary px-1.5 py-0.5 text-primary-foreground"
                    : "rounded border px-1.5 py-0.5"
                }
                onClick={() => toggleField(name)}
              >
                {name}
              </button>
            ))}
          </div>
        )}
        <div className="ms-auto flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setXDomain(null)}
            disabled={xDomain === null}
            title={t("alongTrackProfile.resetZoom")}
            aria-label={t("alongTrackProfile.resetZoom")}
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={downloadPng}
            title={t("alongTrackProfile.exportPng")}
            aria-label={t("alongTrackProfile.exportPng")}
          >
            <ImageIcon className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={downloadCsv}
            disabled={points.length === 0}
            title={t("alongTrackProfile.exportCsv")}
            aria-label={t("alongTrackProfile.exportCsv")}
          >
            <Download className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 p-2" dir="ltr">
        <div ref={plotRef} className="relative h-full w-full">
          {points.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">{t("alongTrackProfile.empty")}</p>
          ) : (
            <svg
              ref={svgRef}
              width={size.width}
              height={size.height}
              className="touch-none select-none"
              role="img"
              aria-label={t("alongTrackProfile.chartLabel", { beam })}
              onWheel={onWheel}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={() => {
                if (!drag.current) setHoverIndex(null);
              }}
              onDoubleClick={() => setXDomain(null)}
            >
              <defs>
                <clipPath id={`atp-clip-${layer.id}`}>
                  <rect x={MARGIN.left} y={MARGIN.top} width={innerW} height={innerH} />
                </clipPath>
              </defs>
              {yTicks.map((tick) => (
                <g key={`y${tick}`}>
                  <line
                    x1={MARGIN.left}
                    x2={MARGIN.left + innerW}
                    y1={y(tick)}
                    y2={y(tick)}
                    stroke={AXIS}
                    strokeOpacity={0.5}
                  />
                  <text
                    x={MARGIN.left - 6}
                    y={y(tick)}
                    textAnchor="end"
                    dominantBaseline="middle"
                    fontSize={10}
                    fill={TICK}
                  >
                    {formatNumber(tick)}
                  </text>
                </g>
              ))}
              {xTicks.map((tick) => (
                <text
                  key={`x${tick}`}
                  x={x(tick)}
                  y={MARGIN.top + innerH + 14}
                  textAnchor="middle"
                  fontSize={10}
                  fill={TICK}
                >
                  {formatNumber(tick)}
                </text>
              ))}
              <line
                x1={MARGIN.left}
                x2={MARGIN.left + innerW}
                y1={MARGIN.top + innerH}
                y2={MARGIN.top + innerH}
                stroke={AXIS}
              />
              <line
                x1={MARGIN.left}
                x2={MARGIN.left}
                y1={MARGIN.top}
                y2={MARGIN.top + innerH}
                stroke={AXIS}
              />
              <text
                x={MARGIN.left + innerW / 2}
                y={size.height - 4}
                textAnchor="middle"
                fontSize={11}
                fill={TICK}
              >
                {t("alongTrackProfile.distanceAxis")}
              </text>
              <text
                transform={`translate(12 ${MARGIN.top + innerH / 2}) rotate(-90)`}
                textAnchor="middle"
                fontSize={11}
                fill={TICK}
              >
                {mode === "fields" ? labels.join(", ") : t("alongTrackProfile.elevationAxis")}
              </text>
              <g clipPath={`url(#atp-clip-${layer.id})`}>
                {paths.map((d, index) => (
                  <path
                    key={series[index].key}
                    d={d}
                    fill="none"
                    stroke={colors[index]}
                    strokeWidth={1.5}
                    strokeLinejoin="round"
                  />
                ))}
                {selectedIndex >= 0 &&
                  points[selectedIndex].values.map((value, index) =>
                    value === null ? null : (
                      <circle
                        key={`sel${series[index]?.key}`}
                        cx={x(points[selectedIndex].distance)}
                        cy={y(value)}
                        r={5}
                        fill="none"
                        stroke="hsl(var(--foreground))"
                        strokeWidth={2}
                      />
                    ),
                  )}
                {hovered && (
                  <>
                    <line
                      x1={x(hovered.distance)}
                      x2={x(hovered.distance)}
                      y1={MARGIN.top}
                      y2={MARGIN.top + innerH}
                      stroke={TICK}
                      strokeDasharray="3 3"
                    />
                    {hovered.values.map((value, index) =>
                      value === null ? null : (
                        <circle
                          key={`hov${series[index]?.key}`}
                          cx={x(hovered.distance)}
                          cy={y(value)}
                          r={3.5}
                          fill={colors[index]}
                        />
                      ),
                    )}
                  </>
                )}
              </g>
            </svg>
          )}
          {hovered && (
            <div
              className="pointer-events-none absolute top-2 z-10 rounded border bg-popover px-2 py-1 text-xs text-popover-foreground shadow"
              style={
                tooltipOnLeft ? { right: size.width - tooltipLeft + 8 } : { left: tooltipLeft + 8 }
              }
            >
              <div>
                {t("alongTrackProfile.tooltipDistance", { value: formatNumber(hovered.distance) })}
              </div>
              {hovered.values.map((value, index) => (
                <div key={series[index]?.key} style={{ color: colors[index] }}>
                  {labels[index]}: {value === null ? "—" : formatNumber(value)}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t px-3 py-1.5 text-xs text-muted-foreground">
        {labels.map((label, index) => (
          <span key={series[index].key} className="flex items-center gap-1">
            <span className="inline-block h-0.5 w-4" style={{ backgroundColor: colors[index] }} />
            {label}
          </span>
        ))}
        <span className="ms-auto">{t("alongTrackProfile.hint")}</span>
        {exportError && <span className="text-destructive">{exportError}</span>}
      </div>

      {/* Physically bottom-right in every locale: useFloatingPanelRect grows
          the width with a rightward drag, so the grip must not mirror. */}
      <div
        className="absolute bottom-0 h-4 w-4 cursor-se-resize touch-none"
        style={{ right: 0 }}
        onPointerDown={handleResizeStart}
        role="presentation"
      >
        <svg viewBox="0 0 10 10" className="h-full w-full text-muted-foreground" aria-hidden="true">
          <path d="M9 1 L1 9 M9 5 L5 9" stroke="currentColor" strokeWidth={1} fill="none" />
        </svg>
      </div>
    </div>
  );
}
