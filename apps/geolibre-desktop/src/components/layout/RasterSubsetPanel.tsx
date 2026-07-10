import type { GeoLibreLayer } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import { Button, Input, Label } from "@geolibre/ui";
import type { FeatureCollection } from "geojson";
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import { Crop, Download, GripVertical, Loader2, Scan, X } from "lucide-react";
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

/** Map source/layer ids for the drawn bounding-box preview. */
const BBOX_SOURCE = "geolibre-raster-subset-bbox";
const BBOX_FILL = "geolibre-raster-subset-bbox-fill";
const BBOX_LINE = "geolibre-raster-subset-bbox-line";

/** Default panel geometry (px); the user can drag it around the map area. */
const PANEL_DEFAULT_W = 320;
const PANEL_MARGIN = 12;

const EMPTY_FC: FeatureCollection = { type: "FeatureCollection", features: [] };

interface PanelPos {
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

/** Build a rectangle polygon FeatureCollection for the preview overlay. */
function bboxToFeatureCollection(
  bbox: [number, number, number, number],
): FeatureCollection {
  const [w, s, e, n] = bbox;
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [w, s],
              [e, s],
              [e, n],
              [w, n],
              [w, s],
            ],
          ],
        },
      },
    ],
  };
}

/** Order two corners into a `[west, south, east, north]` box. */
function orderBbox(
  a: [number, number],
  b: [number, number],
): [number, number, number, number] {
  return [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
  ];
}

/** Parse the four coordinate fields into an ordered box, or `null` if any are
 * missing/invalid or the box is degenerate. */
function parseBbox(
  coords: CoordFields,
): [number, number, number, number] | null {
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
 * A floating, draggable panel that extracts a bounding-box subset from a COG,
 * WMS, or XYZ layer entirely in the browser (via geolibre-wasm's Rust
 * extractors). The user activates a draw mode to rubber-band a box on the map,
 * fine-tunes the confirmed coordinates, sets the output resolution (COG/WMS) or
 * zoom (XYZ), then saves the clipped GeoTIFF to disk. The map stays interactive,
 * matching the Pixel Time Series panel's non-blocking pattern.
 */
export function RasterSubsetPanel({
  layer,
  onClose,
  mapControllerRef,
}: RasterSubsetPanelProps) {
  const { t } = useTranslation();
  const kind: RasterSubsetKind | null = useMemo(
    () => (layer ? rasterSubsetKind(layer) : null),
    [layer],
  );

  const [coords, setCoords] = useState<CoordFields>(EMPTY_COORDS);
  const [drawing, setDrawing] = useState(false);
  const [resolution, setResolution] = useState("");
  const [zoom, setZoom] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const bbox = useMemo(() => parseBbox(coords), [coords]);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<PanelPos | null>(null);

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
    setError(null);
    setSuccess(null);
    setRunning(false);
    setPos(null);
    if (!layer) return;
    const map = mapControllerRef.current?.getMap();
    const z = map ? clamp(Math.round(map.getZoom()), 0, 30) : 10;
    setZoom(String(z));
  }, [layer, mapControllerRef]);

  // Add the bounding-box preview source/layers while the panel is open, and tear
  // them down on close. A separate effect keeps their data in sync with `bbox`.
  useEffect(() => {
    const map = mapControllerRef.current?.getMap();
    if (!layer || !map) return;
    const add = (m: MapLibreMap) => {
      if (!m.getSource(BBOX_SOURCE)) {
        m.addSource(BBOX_SOURCE, { type: "geojson", data: EMPTY_FC });
      }
      if (!m.getLayer(BBOX_FILL)) {
        m.addLayer({
          id: BBOX_FILL,
          type: "fill",
          source: BBOX_SOURCE,
          paint: { "fill-color": "#2563eb", "fill-opacity": 0.12 },
        });
      }
      if (!m.getLayer(BBOX_LINE)) {
        m.addLayer({
          id: BBOX_LINE,
          type: "line",
          source: BBOX_SOURCE,
          paint: {
            "line-color": "#2563eb",
            "line-width": 2,
            "line-dasharray": [2, 1],
          },
        });
      }
    };
    add(map);
    return () => {
      const m = mapControllerRef.current?.getMap();
      if (!m) return;
      if (m.getLayer(BBOX_LINE)) m.removeLayer(BBOX_LINE);
      if (m.getLayer(BBOX_FILL)) m.removeLayer(BBOX_FILL);
      if (m.getSource(BBOX_SOURCE)) m.removeSource(BBOX_SOURCE);
    };
  }, [layer, mapControllerRef]);

  // Reflect the current box into the preview overlay.
  useEffect(() => {
    const map = mapControllerRef.current?.getMap();
    const source = map?.getSource(BBOX_SOURCE) as GeoJSONSource | undefined;
    if (!source) return;
    source.setData(bbox ? bboxToFeatureCollection(bbox) : EMPTY_FC);
  }, [bbox, layer, mapControllerRef]);

  // Rubber-band draw mode: drag a rectangle on the map. dragPan/boxZoom are
  // disabled for the duration so the drag draws instead of panning; Esc cancels.
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
    map.dragPan.disable();
    map.boxZoom.disable();
    let start: [number, number] | null = null;
    const onDown = (e: { lngLat: { lng: number; lat: number } }) => {
      start = [e.lngLat.lng, e.lngLat.lat];
    };
    const onMove = (e: { lngLat: { lng: number; lat: number } }) => {
      if (!start) return;
      setCoords(
        coordsFromBbox(orderBbox(start, [e.lngLat.lng, e.lngLat.lat])),
      );
    };
    const onUp = (e: { lngLat: { lng: number; lat: number } }) => {
      if (start) {
        setCoords(
          coordsFromBbox(orderBbox(start, [e.lngLat.lng, e.lngLat.lat])),
        );
      }
      start = null;
      setDrawing(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) setDrawing(false);
    };
    map.on("mousedown", onDown);
    map.on("mousemove", onMove);
    map.on("mouseup", onUp);
    window.addEventListener("keydown", onKey);
    return () => {
      map.off("mousedown", onDown);
      map.off("mousemove", onMove);
      map.off("mouseup", onUp);
      window.removeEventListener("keydown", onKey);
      canvas.style.cursor = prevCursor;
      map.dragPan.enable();
      map.boxZoom.enable();
    };
  }, [drawing, mapControllerRef]);

  const handleUseView = useCallback(() => {
    const map = mapControllerRef.current?.getMap();
    if (!map) return;
    const b = map.getBounds();
    setCoords(
      coordsFromBbox([
        b.getWest(),
        b.getSouth(),
        b.getEast(),
        b.getNorth(),
      ]),
    );
    setSuccess(null);
    setError(null);
  }, [mapControllerRef]);

  const setField = useCallback((field: keyof CoordFields, value: string) => {
    setCoords((prev) => ({ ...prev, [field]: value }));
    setSuccess(null);
  }, []);

  // Dragging the panel by its header. Mirrors the Pixel Time Series panel.
  const handleDragStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if ((event.target as HTMLElement).closest("button")) return;
      event.preventDefault();
      const el = panelRef.current;
      const parent =
        (el?.offsetParent as HTMLElement | null) ?? el?.parentElement ?? null;
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
        const maxX = bounds
          ? bounds.width - w - PANEL_MARGIN
          : Number.POSITIVE_INFINITY;
        const maxY = bounds
          ? bounds.height - h - PANEL_MARGIN
          : Number.POSITIVE_INFINITY;
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
    (zoom === "" ||
      !Number.isInteger(zoomValue) ||
      zoomValue < 0 ||
      zoomValue > 30);
  const canExtract = !running && bbox !== null && !zoomInvalid;

  const handleExtract = useCallback(async () => {
    if (!layer || !bbox) return;
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
      const bytes = await extractRasterSubset(layer, {
        bbox,
        resolution: res,
        zoom: kind === "xyz" ? Number(zoom) : undefined,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const savedPath = await saveRasterSubset(
        bytes,
        sanitizeExportFileName(layer.name),
      );
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
  }, [layer, bbox, resolution, zoom, kind, t]);

  if (!layer || !kind) return null;

  return (
    <div
      ref={panelRef}
      className={
        pos
          ? "pointer-events-auto absolute z-20 flex w-80 flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
          : "pointer-events-auto absolute right-3 top-16 z-20 flex w-[min(20rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
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
          <GripVertical
            className="h-4 w-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
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

      <div className="flex flex-col gap-3 p-3 text-sm">
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
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handleUseView}
          >
            {t("rasterSubset.useView")}
          </Button>
        </div>
        {drawing ? (
          <p className="text-xs text-muted-foreground">
            {t("rasterSubset.drawHint")}
          </p>
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
                setSuccess(null);
              }}
            />
            {zoomInvalid ? (
              <p className="text-xs text-destructive">
                {t("rasterSubset.zoomHint")}
              </p>
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
                setSuccess(null);
              }}
            />
            <p className="text-xs text-muted-foreground">
              {t("rasterSubset.resolutionHint")}
            </p>
          </div>
        )}

        {error ? (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        {success ? (
          <p className="text-xs text-emerald-600 dark:text-emerald-400">
            {success}
          </p>
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
  );
}
