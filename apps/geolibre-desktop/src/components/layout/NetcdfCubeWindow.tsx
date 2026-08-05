import { useAppStore } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import { gridPixelAt, type LocalNetcdfGrid, type LocalNetcdfWindow } from "@geolibre/plugins";
import { Button, ColorRampSelect, Label } from "@geolibre/ui";
import { Boxes, GripVertical, Settings2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useColormapRamps } from "../../hooks/useColormapRamps";
import { bandLabel, defaultRgbBands, MAX_AXIS_OPTIONS } from "../../lib/netcdf-band-axis";
import { useFloatingPanelRect } from "../../hooks/useFloatingPanelRect";
import {
  CubeError,
  CubeReadAbortedError,
  intersectRect,
  type CubeErrorCode,
  readNetcdfCube,
  recomposeCubeRgb,
  validDataRect,
  type CellRect,
  type NetcdfCube,
} from "../../lib/netcdf-cube";
import {
  closeNetcdfCube,
  getNetcdfCubeState,
  reopenNetcdfCubeSetup,
  subscribeNetcdfCube,
  type NetcdfCubeSettings,
} from "../../lib/netcdf-cube-store";
import {
  getNetcdfLayerState,
  netcdfImageSymbology,
  rampRgb,
  warmNetcdfColormap,
} from "../../lib/netcdf-image-symbology";
import { NetcdfCubeView } from "../panels/NetcdfCubeView";

/** Panel geometry (px). */
const PANEL_MIN_W = 360;
const PANEL_MIN_H = 320;
const PANEL_MARGIN = 12;
/**
 * Vertical offset from the top inset. The Time Slider's pixel chart and the
 * popped-out spectral profile both open at this corner; cascading this one
 * further down leaves their drag headers grabbable underneath.
 */
const PANEL_TOP = 116;
// 640x520 is the CSS default below (40rem x 32.5rem at a 16px root) in px, so a
// drag that starts from the untouched default does not jump.
const FALLBACK_RECT = { x: PANEL_MARGIN, y: PANEL_TOP, w: 640, h: 520 };

/**
 * How tall the band axis is drawn, relative to the cube's shorter spatial edge.
 * 1 matches HyperCoast's auto-scale, which spreads the spectrum across the full
 * width of the scene; the slider covers a flatter map-like slab up to a tower.
 */
const DEFAULT_Z_SCALE = 1;

interface NetcdfCubeWindowProps {
  /** The live map, for reading the view to window the cube against. */
  mapControllerRef: React.RefObject<MapController | null>;
}

/**
 * The 3-D image cube, in a movable window over the map.
 *
 * Reads the extent the setup dialog chose, decimated to a few hundred cells a
 * side, and draws its six exterior faces. Windowing is not a nicety: an EMIT L3
 * reflectance variable is 5.2 GB, and a chunked HDF5 read costs what it touches,
 * so reading a view rather than the whole grid is the difference between a cube
 * arriving in seconds and in minutes.
 *
 * Everything here changes how the cube is *drawn* — colormap, height, the slice
 * plane — and so costs nothing but a repaint. Everything that changes what is
 * *read* lives in the setup dialog, behind the Settings button.
 *
 * @param props.mapControllerRef - The map whose view bounds the read.
 * @returns The window, or null when no layer's cube is being shown.
 */
export function NetcdfCubeWindow({ mapControllerRef }: NetcdfCubeWindowProps) {
  const { t } = useTranslation();
  const rampOptions = useColormapRamps();
  const state = useSyncExternalStore(subscribeNetcdfCube, getNetcdfCubeState, getNetcdfCubeState);
  // Mounted for both phases, so a trip to the settings dialog and back does not
  // throw away the decoded cube; the modal simply sits over it. `readToken` is
  // what says a *new* read was asked for.
  const layerId = state.layerId;
  const { readToken, settings } = state;
  const layer = useAppStore((store) => store.layers.find((item) => item.id === layerId) ?? null);

  const [cube, setCube] = useState<NetcdfCube | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zScale, setZScale] = useState(DEFAULT_Z_SCALE);
  // Bands kept, counted up from the first: the cut plane, as a fraction so it
  // survives a re-read that changes the band count.
  const [sliceFraction, setSliceFraction] = useState(1);
  const [colormap, setColormap] = useState("viridis");
  const [reversed, setReversed] = useState(false);
  const [showRgb, setShowRgb] = useState(true);
  const [colors, setColors] = useState(() => rampRgb("viridis", false));
  // The read in flight, so a re-read or a close abandons it rather than letting
  // two reads race to set the cube.
  const abortRef = useRef<AbortController | null>(null);
  // Set while the overlay's own three planes are being re-read, which is far
  // cheaper than a cube and so gets a quiet inline note rather than the
  // full-panel progress bar.
  const [recomposing, setRecomposing] = useState(false);
  const rgbAbortRef = useRef<AbortController | null>(null);

  /**
   * Re-read just the overlay's three planes.
   *
   * The cube itself does not change, so this costs three reads instead of the
   * tens a rebuild would — which is why the band pickers live out here with the
   * drawing controls rather than back in the setup dialog.
   */
  const changeRgb = useCallback(
    async (bands: [number, number, number]) => {
      const source = layerId ? getNetcdfLayerState(layerId)?.cube : null;
      if (!source || !cube?.readWindow) return;
      rgbAbortRef.current?.abort();
      const controller = new AbortController();
      rgbAbortRef.current = controller;
      // A failed overlay read leaves its message over the canvas; without this
      // the next successful pick would swap the image in underneath a stale
      // error that never clears.
      setError(null);
      setRecomposing(true);
      try {
        const next = await recomposeCubeRgb(cube, source.readBand, bands, controller.signal);
        if (!controller.signal.aborted) setCube(next);
      } catch (err) {
        if (err instanceof CubeReadAbortedError || controller.signal.aborted) return;
        setError(describeError(err, t));
      } finally {
        if (rgbAbortRef.current === controller) {
          rgbAbortRef.current = null;
          setRecomposing(false);
        }
      }
    },
    [cube, layerId, t],
  );

  // The layer's own limits, so the cube and the map agree; falling back to the
  // cube's robust range means a layer that records none still gets a stretch
  // computed from the window actually being drawn.
  const clim: [number, number] = layer
    ? netcdfImageSymbology(layer, cube?.dataClim ?? [0, 1]).clim
    : (cube?.dataClim ?? [0, 1]);

  const read = useCallback(
    async (id: string, settings: NetcdfCubeSettings) => {
      const layerState = getNetcdfLayerState(id);
      const source = layerState?.cube;
      if (!layerState || !source) {
        setError(t("netcdfCube.errorNoCube"));
        return;
      }
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setError(null);
      setProgress({ done: 0, total: 0 });
      try {
        // Not named `window`: that would shadow the browser global for the
        // whole function body, so a later edit reaching for `window.setTimeout`
        // above this line would throw rather than resolve the global.
        const readWindow = cubeWindow(mapControllerRef.current, layerState.grid, settings);
        const next = await readNetcdfCube({
          readBand: (bandIndex) => source.readBand(bandIndex, readWindow),
          readWindow,
          variable: layerState.variable,
          ...(layerState.units ? { units: layerState.units } : {}),
          axis: source.axis,
          maxBands: settings.maxBands,
          ...(settings.rgbBands ? { rgbBands: settings.rgbBands } : {}),
          onProgress: (done, total) => setProgress({ done, total }),
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setCube(next);
        // A fresh cube opens whole: a slice carried over from the previous one
        // would hide most of what the user just waited for.
        setSliceFraction(1);
      } catch (err) {
        if (err instanceof CubeReadAbortedError || controller.signal.aborted) return;
        setError(describeError(err, t));
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          setProgress(null);
        }
      }
    },
    [mapControllerRef, t],
  );

  // Read when the setup dialog hands over, and seed the colormap from what the
  // layer is already drawn with so the cube and the map agree on sight. Keyed on
  // `readToken`, not the phase: reopening and cancelling the dialog must not
  // spend another half-minute rebuilding a cube that is already in memory. The
  // store resets the token when the layer changes, so a switch cannot inherit
  // the previous layer's token and start a read nobody asked for.
  useEffect(() => {
    if (!layerId || readToken === 0) {
      setCube(null);
      return;
    }
    const current = useAppStore.getState().layers.find((item) => item.id === layerId);
    if (current) {
      const symbology = netcdfImageSymbology(current, [0, 1]);
      setColormap(symbology.colormap);
      setReversed(symbology.reversed);
    }
    setCube(null);
    void read(layerId, settings);
    return () => {
      abortRef.current?.abort();
      rgbAbortRef.current?.abort();
    };
    // `settings` is read at the moment a token lands, so it is deliberately not
    // a dependency: editing it without pressing Create must not start a read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layerId, readToken, read]);

  // A sprite-sampled ramp resolves asynchronously; painting before it lands
  // would silently draw viridis under the chosen name, and nothing repaints
  // when the sample arrives.
  useEffect(() => {
    let live = true;
    void warmNetcdfColormap(colormap).then(() => {
      if (live) setColors(rampRgb(colormap, reversed));
    });
    return () => {
      live = false;
    };
  }, [colormap, reversed]);

  const { panelRef, rect, handleDragStart, handleResizeStart } = useFloatingPanelRect({
    minWidth: PANEL_MIN_W,
    minHeight: PANEL_MIN_H,
    margin: PANEL_MARGIN,
    fallback: FALLBACK_RECT,
  });

  // Nothing to show until the first read has been asked for; until then the
  // setup dialog is the whole interface.
  if (!layerId || readToken === 0) return null;

  const reading = progress !== null;
  const percent = progress && progress.total > 0 ? (progress.done / progress.total) * 100 : 0;
  const sliceBands = cube ? Math.max(1, Math.round(cube.nz * sliceFraction)) : 1;
  // The band axis behind the layer, for labelling the overlay pickers with
  // wavelengths rather than indices.
  const rgbAxis = getNetcdfLayerState(layerId)?.cube?.axis ?? null;
  const activeRgb = cube?.rgbBands ?? (rgbAxis ? defaultRgbBands(rgbAxis) : [0, 0, 0]);
  const topBand = cube?.bands[sliceBands - 1];

  return (
    <div
      ref={panelRef}
      className={
        rect
          ? "pointer-events-auto absolute z-20 flex flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
          : "pointer-events-auto absolute start-3 top-28 z-20 flex h-[32.5rem] max-h-[calc(100%-9rem)] w-[min(40rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
      }
      style={rect ? { left: rect.x, top: rect.y, width: rect.w, height: rect.h } : undefined}
      role="region"
      aria-label={t("netcdfCube.heading")}
      data-testid="netcdf-cube-window"
    >
      <div
        className="flex cursor-move touch-none select-none items-center justify-between gap-2 border-b px-3 py-2"
        onPointerDown={handleDragStart}
      >
        <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
          <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <Boxes className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <span className="truncate">{layer?.name ?? t("netcdfCube.heading")}</span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={reading}
            onClick={reopenNetcdfCubeSetup}
            title={t("netcdfCube.settings")}
          >
            <Settings2 className="me-1.5 h-4 w-4" aria-hidden="true" />
            {t("netcdfCube.settings")}
          </Button>
          <button
            type="button"
            className="rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring"
            onClick={closeNetcdfCube}
            aria-label={t("netcdfCube.close")}
            title={t("netcdfCube.close")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 bg-muted/30">
        {cube ? (
          <NetcdfCubeView
            cube={cube}
            colors={colors}
            clim={clim}
            zScale={zScale}
            sliceBands={sliceBands}
            showRgb={showRgb}
          />
        ) : null}
        {reading ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/70 text-xs">
            <p>
              {t("netcdfCube.reading", {
                done: progress?.done ?? 0,
                total: progress?.total ?? 0,
              })}
            </p>
            <div
              className="h-1.5 w-40 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuenow={Math.round(percent)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="h-full bg-primary transition-all" style={{ width: `${percent}%` }} />
            </div>
          </div>
        ) : null}
        {error ? (
          <div className="absolute inset-0 flex items-center justify-center p-4">
            <p className="text-center text-xs text-destructive">{error}</p>
          </div>
        ) : null}
      </div>

      <div className="space-y-2 border-t px-3 py-2 text-xs">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-40 flex-1 space-y-1">
            <Label htmlFor="netcdfCubeRamp">{t("netcdfCube.colorRampLabel")}</Label>
            <ColorRampSelect
              id="netcdfCubeRamp"
              aria-label={t("netcdfCube.colorRampLabel")}
              value={colormap}
              reversed={reversed}
              ramps={rampOptions}
              onValueChange={setColormap}
            />
          </div>
          <label className="flex items-center gap-1.5 pb-2">
            <input
              type="checkbox"
              checked={reversed}
              onChange={(event) => setReversed(event.target.checked)}
            />
            {t("netcdfCube.reverse")}
          </label>
          {cube?.rgb ? (
            <label className="flex items-center gap-1.5 pb-2">
              <input
                type="checkbox"
                checked={showRgb}
                onChange={(event) => setShowRgb(event.target.checked)}
              />
              {t("netcdfCube.showRgb")}
            </label>
          ) : null}
        </div>

        {/* The overlay's bands, live: three plane reads rather than a rebuild,
            so this belongs with the drawing controls and not behind Settings. */}
        {cube?.readWindow && rgbAxis ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">{t("netcdfCube.rgbBands")}</span>
            {([0, 1, 2] as const).map((channel) => {
              const label = t(`netcdfCube.${(["red", "green", "blue"] as const)[channel]}`);
              const pick = (index: number): void => {
                if (!Number.isFinite(index)) return;
                const next: [number, number, number] = [...activeRgb];
                next[channel] = Math.min(rgbAxis.size - 1, Math.max(0, Math.trunc(index)));
                void changeRgb(next);
              };
              // An axis with no coordinate values, or one too long to list, gets
              // a number box instead of a dropdown — the same fallback the Add
              // NetCDF dialog's band pickers use. A single-option select would
              // leave the channel with nothing to pick.
              return rgbAxis.values && rgbAxis.size <= MAX_AXIS_OPTIONS ? (
                <select
                  key={channel}
                  className="max-w-40 rounded-md border bg-background px-1.5 py-1"
                  value={String(activeRgb[channel])}
                  disabled={recomposing}
                  aria-label={label}
                  onChange={(event) => pick(Number(event.target.value))}
                >
                  {rgbAxis.values.map((_, index) => (
                    <option key={index} value={String(index)}>
                      {bandLabel(rgbAxis, index)}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  key={channel}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={rgbAxis.size - 1}
                  className="w-24 rounded-md border bg-background px-1.5 py-1"
                  value={activeRgb[channel]}
                  disabled={recomposing}
                  aria-label={label}
                  onChange={(event) => pick(Number(event.target.value))}
                />
              );
            })}
            {recomposing ? (
              <span className="text-muted-foreground">{t("netcdfCube.recomposing")}</span>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-1.5">
            {t("netcdfCube.zScale")}
            <input
              type="range"
              min={0.25}
              max={3}
              step={0.25}
              value={zScale}
              onChange={(event) => setZScale(Number(event.target.value))}
              className="w-24"
              aria-label={t("netcdfCube.zScale")}
            />
          </label>
          <label className="flex items-center gap-1.5">
            {t("netcdfCube.slice")}
            <input
              type="range"
              min={0}
              max={1}
              step={0.005}
              value={sliceFraction}
              onChange={(event) => setSliceFraction(Number(event.target.value))}
              className="w-28"
              aria-label={t("netcdfCube.slice")}
              disabled={!cube}
            />
          </label>
          {cube && sliceBands < cube.nz ? (
            <span className="text-muted-foreground">
              {t("netcdfCube.sliceAt", {
                band: topBand?.value !== undefined ? formatBand(topBand.value) : sliceBands,
                units: topBand?.value !== undefined ? (cube.axis.units ?? "") : "",
              })}
            </span>
          ) : null}
        </div>

        {cube ? (
          <p className="text-muted-foreground">
            {t("netcdfCube.summary", {
              nx: cube.nx,
              ny: cube.ny,
              nz: cube.nz,
              axis: cube.axis.name,
            })}
          </p>
        ) : null}
      </div>

      {/* Resize grip (bottom-right); mouse/touch-only, so presentational. */}
      <div
        className="absolute bottom-0 right-0 h-4 w-4 cursor-se-resize touch-none"
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

/**
 * A failure, in the user's language where the reader named the reason.
 *
 * The cube module is a plain library with no `t()` of its own, so it raises a
 * {@link CubeError} carrying a code and this maps it to the catalog. Anything
 * else falls back to its own message, which is better than a blank panel even
 * when it is untranslated.
 *
 * @param error - Whatever was thrown.
 * @param t - The translator from the calling component.
 * @returns A message to show over the canvas.
 */
function describeError(
  error: unknown,
  t: (key: (typeof CUBE_ERROR_KEYS)[CubeErrorCode]) => string,
): string {
  if (error instanceof CubeError) return t(CUBE_ERROR_KEYS[error.code]);
  return error instanceof Error ? error.message : String(error);
}

/**
 * Catalog key per reader failure. Spelled out rather than built from the code
 * with a template literal, so the typed catalog checks every one of them and a
 * renamed key fails the build instead of showing the raw key to a user.
 */
const CUBE_ERROR_KEYS = {
  shapeMismatch: "netcdfCube.error.shapeMismatch",
  rgbShapeMismatch: "netcdfCube.error.rgbShapeMismatch",
  noBands: "netcdfCube.error.noBands",
  noReadWindow: "netcdfCube.error.noReadWindow",
} as const satisfies Record<CubeErrorCode, string>;

/** A band coordinate, short enough to sit inline next to the slider. */
function formatBand(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/**
 * The read window: the chosen extent, clipped to where the grid holds data.
 *
 * The data clip matters as much as the extent. A satellite scene is a rotated
 * footprint inside an axis-aligned lat/lon grid, so the grid's outer rows and
 * columns are pure nodata — and those are precisely the cells the cube's four
 * side faces are drawn from. This is the automatic form of HyperCoast's `crop=`.
 *
 * Falls back to the data extent when the map is unavailable or nothing
 * overlaps: a slow, correct cube beats an empty one.
 *
 * @param controller - The map controller, or null.
 * @param grid - The layer's displayed slice, whose coordinates locate the extent.
 * @param settings - The extent mode, drawn bbox, and decimation target.
 * @returns The window to read every band plane with.
 */
function cubeWindow(
  controller: MapController | null,
  grid: LocalNetcdfGrid,
  settings: NetcdfCubeSettings,
): LocalNetcdfWindow {
  const whole: CellRect = { row: 0, column: 0, rows: grid.ny, columns: grid.nx };
  const data = validDataRect(grid) ?? whole;
  const chosen = extentRect(controller, grid, settings);
  const rect = (chosen ? intersectRect(chosen, data) : null) ?? data;
  return { ...rect, maxSize: settings.maxSize };
}

/** The cells under the chosen extent, or null for the whole grid. */
function extentRect(
  controller: MapController | null,
  grid: LocalNetcdfGrid,
  settings: NetcdfCubeSettings,
): CellRect | null {
  if (settings.extent === "full") return null;
  if (settings.extent === "draw") {
    return settings.bbox ? rectFromBounds(grid, settings.bbox) : null;
  }
  const map = controller?.getMap();
  if (!map) return null;
  const bounds = map.getBounds();
  return rectFromBounds(grid, [
    bounds.getWest(),
    bounds.getSouth(),
    bounds.getEast(),
    bounds.getNorth(),
  ]);
}

/** The cells a geographic rectangle covers, clamped into the grid. */
function rectFromBounds(
  grid: LocalNetcdfGrid,
  [west, south, east, north]: [number, number, number, number],
): CellRect | null {
  // `gridPixelAt` returns null past half a cell outside the grid, which is the
  // common case here (an extent usually overhangs the scene), so clamp the
  // corners into the grid before asking rather than giving up on the window.
  const topLeft = gridPixelAt(grid, clamp(west, grid.lon), clamp(north, grid.lat));
  const bottomRight = gridPixelAt(grid, clamp(east, grid.lon), clamp(south, grid.lat));
  if (!topLeft || !bottomRight) return null;
  return {
    row: Math.min(topLeft.row, bottomRight.row),
    column: Math.min(topLeft.column, bottomRight.column),
    rows: Math.abs(bottomRight.row - topLeft.row) + 1,
    columns: Math.abs(bottomRight.column - topLeft.column) + 1,
  };
}

/** A coordinate clamped into an axis' range, whichever way the axis runs. */
function clamp(value: number, axis: ArrayLike<number>): number {
  const first = Number(axis[0]);
  const last = Number(axis[axis.length - 1]);
  const min = Math.min(first, last);
  const max = Math.max(first, last);
  return Math.min(Math.max(value, min), max);
}
