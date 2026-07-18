import { type GeoLibreLayer, useAppStore } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import { Button, Input, Label, Textarea } from "@geolibre/ui";
import {
  ChevronDown,
  ChevronRight,
  Crop,
  Download,
  GripVertical,
  Loader2,
  Scan,
  X,
} from "lucide-react";
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
import { clamp } from "../../lib/clamp";
import {
  extractRasterSubset,
  rasterSubsetKind,
  type RasterSubsetKind,
  saveRasterSubset,
} from "../../lib/raster-subset-export";
import { sanitizeExportFileName } from "../../lib/vector-export";

/** Default panel geometry (px); the user can drag it around the map area. */
const PANEL_DEFAULT_W = 320;
const PANEL_MARGIN = 12;

interface PanelPos {
  x: number;
  y: number;
}

interface ScreenPoint {
  x: number;
  y: number;
}

/** The four editable bounding-box fields, held as strings so partial edits
 * (a lone "-", an in-progress decimal) don't fight the controlled inputs. */
interface CoordFields {
  west: string;
  south: string;
  east: string;
  north: string;
}

const EMPTY_COORDS: CoordFields = { west: "", south: "", east: "", north: "" };

interface RasterSubsetPanelProps {
  /** The layer being extracted, or `null` when the panel is closed. */
  layer: GeoLibreLayer | null;
  onClose: () => void;
  mapControllerRef: RefObject<MapController | null>;
}

/** Round a coordinate to a readable-but-precise 6 decimal places. */
function fmtCoord(value: number): string {
  return Number(value.toFixed(6)).toString();
}

/** Order two corners into a `[west, south, east, north]` box. */
function orderBbox(a: [number, number], b: [number, number]): [number, number, number, number] {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}

/** Parse the four coordinate fields into an ordered box, or `null` if any are
 * missing, out of the valid lng/lat range, or the box is degenerate. */
function parseBbox(coords: CoordFields): [number, number, number, number] | null {
  const west = Number(coords.west);
  const south = Number(coords.south);
  const east = Number(coords.east);
  const north = Number(coords.north);
  if (
    coords.west === "" ||
    coords.south === "" ||
    coords.east === "" ||
    coords.north === "" ||
    !Number.isFinite(west) ||
    !Number.isFinite(south) ||
    !Number.isFinite(east) ||
    !Number.isFinite(north) ||
    west < -180 ||
    east > 180 ||
    south < -90 ||
    north > 90 ||
    west >= east ||
    south >= north
  ) {
    return null;
  }
  return [west, south, east, north];
}

/** Coordinate fields from an ordered box. */
function coordsFromBbox(bbox: [number, number, number, number]): CoordFields {
  return {
    west: fmtCoord(bbox[0]),
    south: fmtCoord(bbox[1]),
    east: fmtCoord(bbox[2]),
    north: fmtCoord(bbox[3]),
  };
}

/**
 * Extractor option keys whose values are numeric and so are coerced to a number.
 * Other keys (e.g. a WMS `layers`/`styles`/`format`) keep their string value, so
 * a numeric-looking id like `layers=001` isn't mangled into `1`.
 *
 * Deliberately excludes `resolution`/`outputCrs`/`nodata`/`zoom`: those have
 * dedicated, validated fields and the extractor is given the field value after
 * the `extra` spread, so an Additional-options line for them can't bypass the
 * field's range checks.
 */
const NUMERIC_EXTRA_KEYS = new Set([
  "level",
  "width",
  "height",
  "tileSize",
  "initialHeaderBytes",
  "maxHeaderBytes",
]);

/**
 * Parse the "Additional options" text (one `key=value` per line) into an options
 * object for the extractor, coercing only the known-numeric keys. Blank lines are
 * ignored; `null` signals a malformed line so the caller can surface an error
 * rather than silently dropping it.
 *
 * @param text - The raw textarea contents.
 * @returns The parsed options, or `null` if any non-blank line is malformed.
 */
function parseExtraArgs(text: string): Record<string, unknown> | null {
  const extra: Record<string, unknown> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) return null;
    const key = line.slice(0, eq).trim();
    if (!key) return null;
    const value = line.slice(eq + 1).trim();
    if (NUMERIC_EXTRA_KEYS.has(key)) {
      // A numeric key needs a finite number; a blank or non-numeric value (e.g.
      // `resolution=`) is malformed, not a silent empty-string override of the
      // form field.
      const num = Number(value);
      if (value === "" || !Number.isFinite(num)) return null;
      extra[key] = num;
    } else {
      extra[key] = value;
    }
  }
  return extra;
}

/**
 * A floating, draggable panel that extracts a bounding-box subset from a COG,
 * WMS, or XYZ layer entirely in the browser (via geolibre-wasm's Rust
 * extractors). The user activates a draw mode to rubber-band a box on the map
 * (drawn as an SVG overlay so it stays visible above the deck.gl COG overlay),
 * fine-tunes the confirmed coordinates, sets the output resolution/CRS/nodata
 * (or zoom for XYZ), then saves the clipped GeoTIFF. The map stays interactive,
 * matching the Pixel Time Series panel's non-blocking pattern.
 */
export function RasterSubsetPanel({ layer, onClose, mapControllerRef }: RasterSubsetPanelProps) {
  const { t } = useTranslation();
  const kind: RasterSubsetKind | null = useMemo(
    () => (layer ? rasterSubsetKind(layer) : null),
    [layer],
  );

  const [coords, setCoords] = useState<CoordFields>(EMPTY_COORDS);
  const [drawing, setDrawing] = useState(false);
  const [resolution, setResolution] = useState("");
  const [zoom, setZoom] = useState("");
  const [outputCrs, setOutputCrs] = useState("");
  const [nodata, setNodata] = useState("");
  const [extraArgs, setExtraArgs] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const bbox = useMemo(() => parseBbox(coords), [coords]);
  // All four coordinate fields are filled but don't form a valid box (out of
  // range, or west>=east / south>=north). "Use view" can produce this when the
  // map is panned across the antimeridian, since getBounds() isn't normalized.
  const bboxInvalid =
    bbox === null &&
    coords.west !== "" &&
    coords.south !== "" &&
    coords.east !== "" &&
    coords.north !== "";
  // The specific (and common, for Pacific XYZ layers) invalid case where the box
  // wraps the 180° meridian: everything is in range and south<north, but
  // west>=east. The extractors can't request a wrapping box, so we tell the user
  // to split it rather than showing the generic range hint.
  const bboxCrossesAntimeridian = useMemo(() => {
    if (!bboxInvalid) return false;
    const w = Number(coords.west);
    const e = Number(coords.east);
    const s = Number(coords.south);
    const n = Number(coords.north);
    return (
      Number.isFinite(w) &&
      Number.isFinite(e) &&
      Number.isFinite(s) &&
      Number.isFinite(n) &&
      w >= -180 &&
      e <= 180 &&
      s >= -90 &&
      n <= 90 &&
      s < n &&
      w >= e
    );
  }, [bboxInvalid, coords]);

  // Clear both status messages when the user edits any field, so a stale error
  // or success from a prior extraction doesn't linger while they retry.
  const clearStatus = useCallback(() => {
    setSuccess(null);
    setError(null);
  }, []);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<PanelPos | null>(null);
  // Projected screen positions of the box's four corners, for the SVG overlay.
  const [screenPoints, setScreenPoints] = useState<ScreenPoint[] | null>(null);

  // Cancels the in-flight extraction's network requests when the panel is closed
  // or a new extraction starts, so a stalled request never leaves the UI stuck
  // on "Extracting...".
  const abortRef = useRef<AbortController | null>(null);
  // Abort any in-flight extraction when the panel unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Reset every field whenever the panel opens for a (different) layer or is
  // closed, and seed the XYZ zoom from the current map zoom so the default
  // extract matches what the user is looking at. The resets run even when
  // `layer` is null (panel closed): clearing `drawing` there lets the rubber-band
  // effect's cleanup re-enable dragPan/boxZoom and restore the cursor if the
  // panel is closed mid-drag, instead of leaving the map stuck.
  useEffect(() => {
    // Cancel any extraction still running for the previous layer / closed panel.
    abortRef.current?.abort();
    abortRef.current = null;
    setCoords(EMPTY_COORDS);
    setDrawing(false);
    setResolution("");
    setOutputCrs("");
    setNodata("");
    setExtraArgs("");
    setShowAdvanced(false);
    setError(null);
    setSuccess(null);
    setRunning(false);
    setPos(null);
    if (!layer) return;
    const map = mapControllerRef.current?.getMap();
    const z = map ? clamp(Math.round(map.getZoom()), 0, 30) : 10;
    setZoom(String(z));
  }, [layer, mapControllerRef]);

  // Latest box, read inside the projection callback so the map listeners don't
  // need `bbox` as a dependency (which changes on every drag mousemove).
  const bboxRef = useRef(bbox);
  bboxRef.current = bbox;
  // The current projection function, so the bbox-change effect can trigger a
  // reproject without re-subscribing the map listeners.
  const reprojectRef = useRef<() => void>(() => {});

  // Keep the SVG overlay's corner positions in sync with the map's camera
  // (pan/zoom/rotate/pitch/resize). Subscribed once per layer/map (not per box
  // edit) to avoid tearing down and re-attaching listeners on every drag tick.
  // Projecting all four corners keeps the outline correct under rotation.
  // Rendered as an SVG (not a MapLibre layer) so it stays visible above the
  // interleaved deck.gl COG/raster overlay.
  useEffect(() => {
    const map = mapControllerRef.current?.getMap();
    if (!map || !layer) {
      setScreenPoints(null);
      return;
    }
    const reproject = () => {
      const b = bboxRef.current;
      if (!b) {
        setScreenPoints(null);
        return;
      }
      const [w, s, e, n] = b;
      const corners: [number, number][] = [
        [w, n],
        [e, n],
        [e, s],
        [w, s],
      ];
      setScreenPoints(
        corners.map((corner) => {
          const p = map.project(corner);
          return { x: p.x, y: p.y };
        }),
      );
    };
    reprojectRef.current = reproject;
    reproject();
    map.on("move", reproject);
    map.on("resize", reproject);
    return () => {
      map.off("move", reproject);
      map.off("resize", reproject);
    };
  }, [layer, mapControllerRef]);

  // Reproject when the box itself changes, reusing the already-subscribed
  // projection function rather than re-attaching map listeners.
  useEffect(() => {
    reprojectRef.current();
  }, [bbox]);

  // Rubber-band draw mode: drag a rectangle on the map. The draw starts on a
  // canvas mousedown, then tracking is driven by *window* mousemove/mouseup so a
  // drag that leaves the canvas (very common, since this panel sits over the map
  // and the box often extends to the edge) still updates and commits. dragPan/
  // boxZoom are suspended for the duration and only restored if they were on
  // before (another tool may have disabled them); Esc and window blur cancel.
  // Mirrors the box-draw handler in lib/print-extent.ts.
  useEffect(() => {
    if (!drawing) return;
    const map = mapControllerRef.current?.getMap();
    if (!map) {
      setDrawing(false);
      return;
    }
    const canvas = map.getCanvas();
    const prevCursor = canvas.style.cursor;
    canvas.style.cursor = "crosshair";
    const panWasEnabled = map.dragPan.isEnabled();
    const boxZoomWasEnabled = map.boxZoom.isEnabled();
    map.dragPan.disable();
    map.boxZoom.disable();

    // Convert a viewport (client) point to a lng/lat via the canvas rect, so a
    // release outside the canvas still maps to a map coordinate.
    const toLngLat = (clientX: number, clientY: number): [number, number] => {
      const rect = canvas.getBoundingClientRect();
      const ll = map.unproject([clientX - rect.left, clientY - rect.top]);
      return [ll.lng, ll.lat];
    };

    let start: [number, number] | null = null;
    const onDown = (e: {
      lngLat: { lng: number; lat: number };
      originalEvent?: { button?: number };
    }) => {
      // Only the primary (left) button draws, so a right/middle-button drag
      // doesn't rubber-band a box while draw mode is active.
      if (e.originalEvent && e.originalEvent.button !== 0) return;
      start = [e.lngLat.lng, e.lngLat.lat];
    };
    const onWindowMove = (e: MouseEvent) => {
      if (!start) return;
      setCoords(coordsFromBbox(orderBbox(start, toLngLat(e.clientX, e.clientY))));
    };
    const onWindowUp = (e: MouseEvent) => {
      // Only end the draw for a release that actually started one (a canvas
      // mousedown set `start`); a click elsewhere while armed (e.g. "Use view"
      // or a field) must not silently exit draw mode.
      if (e.button !== 0 || !start) return;
      setCoords(coordsFromBbox(orderBbox(start, toLngLat(e.clientX, e.clientY))));
      start = null;
      setDrawing(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) setDrawing(false);
    };
    // Cancel if the window loses focus mid-drag (Alt+Tab, a system dialog): the
    // mouseup would otherwise never arrive, leaving the draw armed.
    const onBlur = () => setDrawing(false);
    map.on("mousedown", onDown);
    window.addEventListener("mousemove", onWindowMove);
    window.addEventListener("mouseup", onWindowUp);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      map.off("mousedown", onDown);
      window.removeEventListener("mousemove", onWindowMove);
      window.removeEventListener("mouseup", onWindowUp);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
      canvas.style.cursor = prevCursor;
      if (panWasEnabled) map.dragPan.enable();
      if (boxZoomWasEnabled) map.boxZoom.enable();
    };
  }, [drawing, mapControllerRef]);

  const handleUseView = useCallback(() => {
    const map = mapControllerRef.current?.getMap();
    if (!map) return;
    const b = map.getBounds();
    setCoords(coordsFromBbox([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]));
    clearStatus();
  }, [mapControllerRef, clearStatus]);

  const setField = useCallback(
    (field: keyof CoordFields, value: string) => {
      setCoords((prev) => ({ ...prev, [field]: value }));
      clearStatus();
    },
    [clearStatus],
  );

  // Dragging the panel by its header. Mirrors the Pixel Time Series panel.
  const handleDragStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if ((event.target as HTMLElement).closest("button")) return;
      event.preventDefault();
      const el = panelRef.current;
      const parent = (el?.offsetParent as HTMLElement | null) ?? el?.parentElement ?? null;
      const pb = parent?.getBoundingClientRect();
      const eb = el?.getBoundingClientRect();
      const start: PanelPos = pos ?? {
        x: (eb?.left ?? 0) - (pb?.left ?? 0),
        y: (eb?.top ?? 0) - (pb?.top ?? 0),
      };
      if (!pos) setPos(start);
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const startY = event.clientY;
      const w = eb?.width ?? PANEL_DEFAULT_W;
      const h = eb?.height ?? 0;
      const move = (m: PointerEvent) => {
        if (!panelRef.current) return;
        const bounds = parent?.getBoundingClientRect();
        const maxX = bounds ? bounds.width - w - PANEL_MARGIN : Number.POSITIVE_INFINITY;
        const maxY = bounds ? bounds.height - h - PANEL_MARGIN : Number.POSITIVE_INFINITY;
        setPos({
          x: clamp(start.x + (m.clientX - startX), 0, Math.max(0, maxX)),
          y: clamp(start.y + (m.clientY - startY), 0, Math.max(0, maxY)),
        });
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
    [pos],
  );

  const zoomValue = Number(zoom);
  const zoomInvalid =
    kind === "xyz" &&
    (zoom === "" || !Number.isInteger(zoomValue) || zoomValue < 0 || zoomValue > 30);
  const canExtract = !running && bbox !== null && !zoomInvalid;

  const handleExtract = useCallback(async () => {
    if (!layer || !bbox) return;
    // Read the freshest copy of the layer from the store so a rename or source
    // edit made after the panel opened is reflected (the panel holds a snapshot).
    const liveLayer = useAppStore.getState().layers.find((l) => l.id === layer.id) ?? layer;
    // Abort a prior run (if any) and start a fresh cancellable one.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setError(null);
    setSuccess(null);
    try {
      const res = resolution.trim() === "" ? undefined : Number(resolution);
      if (res !== undefined && (!Number.isFinite(res) || res <= 0)) {
        throw new Error(t("rasterSubset.errorResolution"));
      }
      const crs = outputCrs.trim() === "" ? undefined : Number(outputCrs);
      if (crs !== undefined && (!Number.isInteger(crs) || crs <= 0)) {
        throw new Error(t("rasterSubset.errorOutputCrs"));
      }
      const nd = nodata.trim() === "" ? undefined : Number(nodata);
      if (nd !== undefined && !Number.isFinite(nd)) {
        throw new Error(t("rasterSubset.errorNodata"));
      }
      const extra = parseExtraArgs(extraArgs);
      if (extra === null) {
        throw new Error(t("rasterSubset.errorAdditionalArgs"));
      }
      const bytes = await extractRasterSubset(liveLayer, {
        bbox,
        resolution: res,
        zoom: kind === "xyz" ? Number(zoom) : undefined,
        outputCrs: crs,
        nodata: nd,
        extra,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const savedPath = await saveRasterSubset(bytes, sanitizeExportFileName(liveLayer.name));
      // A null path means the user cancelled the save dialog.
      if (savedPath !== null) setSuccess(t("rasterSubset.success"));
    } catch (err) {
      // A cancelled run (panel closed / superseded) is not an error to surface.
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      // Only clear the running state if this run is still the current one; a
      // newer run (or a close that aborted this one) owns the flag otherwise.
      if (abortRef.current === controller) {
        abortRef.current = null;
        setRunning(false);
      }
    }
  }, [layer, bbox, resolution, zoom, outputCrs, nodata, extraArgs, kind, t]);

  if (!layer || !kind) return null;

  return (
    <>
      {screenPoints ? (
        <svg className="pointer-events-none absolute inset-0 z-10 h-full w-full" aria-hidden="true">
          <polygon
            points={screenPoints.map((p) => `${p.x},${p.y}`).join(" ")}
            // Track the app's accent color so the box matches the theme.
            style={{ fill: "hsl(var(--primary))", stroke: "hsl(var(--primary))" }}
            fillOpacity={0.12}
            strokeWidth={2}
            strokeDasharray="6 3"
          />
        </svg>
      ) : null}

      <div
        ref={panelRef}
        className={
          pos
            ? "pointer-events-auto absolute z-20 flex w-80 flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
            : "pointer-events-auto absolute left-3 top-16 z-20 flex max-h-[calc(100%-6rem)] w-[min(20rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
        }
        style={pos ? { left: pos.x, top: pos.y } : undefined}
        role="region"
        aria-label={t("rasterSubset.title")}
        data-testid="raster-subset-panel"
      >
        <div
          className="flex cursor-move touch-none select-none items-center justify-between gap-2 border-b px-3 py-2"
          onPointerDown={handleDragStart}
        >
          <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
            <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <Crop className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            <span className="truncate">{t("rasterSubset.title")}</span>
          </div>
          <button
            type="button"
            className="rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-col gap-3 overflow-auto p-3 text-sm">
          <p className="truncate text-xs text-muted-foreground" title={layer.name}>
            {layer.name}
          </p>

          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant={drawing ? "secondary" : "default"}
              className="flex-1"
              onClick={() => setDrawing((d) => !d)}
              aria-pressed={drawing}
            >
              <Scan className="h-3.5 w-3.5" aria-hidden="true" />
              {drawing ? t("rasterSubset.drawing") : t("rasterSubset.drawBbox")}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={handleUseView}>
              {t("rasterSubset.useView")}
            </Button>
          </div>
          {drawing ? (
            <p className="text-xs text-muted-foreground">{t("rasterSubset.drawHint")}</p>
          ) : null}

          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ["north", t("rasterSubset.north")],
                ["south", t("rasterSubset.south")],
                ["west", t("rasterSubset.west")],
                ["east", t("rasterSubset.east")],
              ] as const
            ).map(([field, label]) => (
              <div key={field} className="space-y-1">
                <Label htmlFor={`subset-${field}`} className="text-xs">
                  {label}
                </Label>
                <Input
                  id={`subset-${field}`}
                  type="number"
                  step="any"
                  inputMode="decimal"
                  value={coords[field]}
                  onChange={(e) => setField(field, e.target.value)}
                />
              </div>
            ))}
          </div>
          {bboxInvalid ? (
            <p className="text-xs text-destructive">
              {bboxCrossesAntimeridian
                ? t("rasterSubset.bboxAntimeridianHint")
                : t("rasterSubset.bboxHint")}
            </p>
          ) : null}

          {kind === "xyz" ? (
            <div className="space-y-1">
              <Label htmlFor="subset-zoom" className="text-xs">
                {t("rasterSubset.zoom")}
              </Label>
              <Input
                id="subset-zoom"
                type="number"
                min={0}
                max={30}
                step={1}
                value={zoom}
                onChange={(e) => {
                  setZoom(e.target.value);
                  clearStatus();
                }}
              />
              {zoomInvalid ? (
                <p className="text-xs text-destructive">{t("rasterSubset.zoomHint")}</p>
              ) : null}
            </div>
          ) : (
            <div className="space-y-1">
              <Label htmlFor="subset-resolution" className="text-xs">
                {t("rasterSubset.resolution")}
              </Label>
              <Input
                id="subset-resolution"
                type="number"
                min={0}
                step="any"
                inputMode="decimal"
                placeholder={t("rasterSubset.resolutionPlaceholder")}
                value={resolution}
                onChange={(e) => {
                  setResolution(e.target.value);
                  clearStatus();
                }}
              />
              <p className="text-xs text-muted-foreground">{t("rasterSubset.resolutionHint")}</p>
            </div>
          )}

          <div className="space-y-3">
            <button
              type="button"
              className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              aria-expanded={showAdvanced}
              onClick={() => setShowAdvanced((v) => !v)}
            >
              {showAdvanced ? (
                <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 rtl:rotate-180" aria-hidden="true" />
              )}
              {t("rasterSubset.advanced")}
            </button>

            {showAdvanced ? (
              <div className="space-y-3 rounded-md border border-border p-3">
                <div className="space-y-1">
                  <Label htmlFor="subset-output-crs" className="text-xs">
                    {t("rasterSubset.outputCrs")}
                  </Label>
                  <Input
                    id="subset-output-crs"
                    type="number"
                    min={0}
                    step={1}
                    placeholder={t("rasterSubset.outputCrsPlaceholder")}
                    value={outputCrs}
                    onChange={(e) => {
                      setOutputCrs(e.target.value);
                      clearStatus();
                    }}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="subset-nodata" className="text-xs">
                    {t("rasterSubset.nodata")}
                  </Label>
                  <Input
                    id="subset-nodata"
                    type="number"
                    step="any"
                    inputMode="decimal"
                    placeholder={t("rasterSubset.nodataPlaceholder")}
                    value={nodata}
                    onChange={(e) => {
                      setNodata(e.target.value);
                      clearStatus();
                    }}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="subset-extra" className="text-xs">
                    {t("rasterSubset.additionalArgs")}
                  </Label>
                  <Textarea
                    id="subset-extra"
                    rows={3}
                    className="font-mono text-xs"
                    placeholder={t("rasterSubset.additionalArgsPlaceholder")}
                    value={extraArgs}
                    onChange={(e) => {
                      setExtraArgs(e.target.value);
                      clearStatus();
                    }}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("rasterSubset.additionalArgsHint")}
                  </p>
                </div>
              </div>
            ) : null}
          </div>

          {error ? (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          {success ? (
            <p className="text-xs text-emerald-600 dark:text-emerald-400">{success}</p>
          ) : null}

          <Button
            type="button"
            size="sm"
            disabled={!canExtract}
            onClick={() => void handleExtract()}
          >
            {running ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {running ? t("rasterSubset.extracting") : t("rasterSubset.extract")}
          </Button>
        </div>
      </div>
    </>
  );
}
