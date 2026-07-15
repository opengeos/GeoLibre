import {
  DEFAULT_LAYER_STYLE,
  type GeoLibreLayer,
  useAppStore,
} from "@geolibre/core";
import {
  type MapController,
  pmtilesNativeLayerIds,
  readPMTilesArchiveInfo,
  registerPMTilesArchive,
} from "@geolibre/map";
import {
  extractPmtiles,
  type PmtilesExtractProgress,
} from "@geolibre/processing";
import { Button, Input, Label } from "@geolibre/ui";
import {
  CheckCircle2,
  Download,
  GripVertical,
  Loader2,
  Map as MapIcon,
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
import { formatBytes } from "../../lib/offline-regions";
import { saveBinaryFileWithFallback } from "../../lib/tauri-io";
import { sanitizeExportFileName } from "../../lib/vector-export";

/** Default panel geometry (px); the user can drag it around the map area. */
const PANEL_DEFAULT_W = 320;
const PANEL_MARGIN = 12;

/** Remembered across sessions so repeat extracts don't retype the archive URL. */
const URL_STORAGE_KEY = "geolibre.basemapExtract.url";

/** Above this planned size the user must explicitly confirm the download. */
const CONFIRM_BYTES = 150 * 1024 * 1024;

type Phase = "idle" | "running" | "done";

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

interface BasemapExtractPanelProps {
  open: boolean;
  onClose: () => void;
  mapControllerRef: RefObject<MapController | null>;
}

/** Round a coordinate to a readable-but-precise 6 decimal places. */
function fmtCoord(value: number): string {
  return Number(value.toFixed(6)).toString();
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
 * missing, out of the valid lng/lat range, or the box is degenerate. */
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

/** Coordinate fields from an ordered box, clamped to the valid lng/lat range so
 * a low-zoom "use view" that reads past ±180/±90 still forms a valid box. */
function coordsFromBbox(bbox: [number, number, number, number]): CoordFields {
  return {
    west: fmtCoord(Math.max(bbox[0], -180)),
    south: fmtCoord(Math.max(bbox[1], -90)),
    east: fmtCoord(Math.min(bbox[2], 180)),
    north: fmtCoord(Math.min(bbox[3], 90)),
  };
}

/** A layer/file base name from the archive URL, e.g. "planet" for
 * `https://host/planet.pmtiles`. */
function baseNameFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    const base = path.split("/").filter(Boolean).pop() ?? "basemap";
    return base.replace(/\.pmtiles$/i, "") || "basemap";
  } catch {
    return "basemap";
  }
}

/**
 * A floating, draggable panel that extracts a bbox/zoom subset of a remote
 * PMTiles archive (e.g. a Protomaps planet build mirror) into a portable
 * offline `.pmtiles` file, entirely in the browser via geolibre-wasm range
 * requests. The user draws a box on the map (or uses the current view), sets a
 * zoom range, and the result is saved to disk and added to the map. The panel
 * is non-modal so the map stays interactive for drawing, mirroring the Raster
 * Subset panel.
 */
export function BasemapExtractPanel({
  open,
  onClose,
  mapControllerRef,
}: BasemapExtractPanelProps) {
  const { t } = useTranslation();
  const addLayer = useAppStore((state) => state.addLayer);

  const [coords, setCoords] = useState<CoordFields>(EMPTY_COORDS);
  const [drawing, setDrawing] = useState(false);
  const [url, setUrl] = useState("");
  const [minZoom, setMinZoom] = useState("0");
  const [maxZoom, setMaxZoom] = useState("15");
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<PmtilesExtractProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  // A planned download awaiting the user's size confirmation. Resolving the
  // stored promise resumes (true) or cancels (false) the paused extraction.
  const [pendingPlan, setPendingPlan] = useState<{
    progress: PmtilesExtractProgress;
    resolve: (go: boolean) => void;
  } | null>(null);

  const bbox = useMemo(() => parseBbox(coords), [coords]);
  const bboxInvalid =
    bbox === null &&
    coords.west !== "" &&
    coords.south !== "" &&
    coords.east !== "" &&
    coords.north !== "";

  const clearStatus = useCallback(() => {
    setSuccess(null);
    setError(null);
  }, []);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<PanelPos | null>(null);
  const [screenPoints, setScreenPoints] = useState<ScreenPoint[] | null>(null);

  // Cancels an in-flight extraction when the panel closes or a new run starts.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const seedFromView = useCallback(() => {
    const map = mapControllerRef.current?.getMap();
    if (!map) return;
    const b = map.getBounds();
    setCoords(
      coordsFromBbox([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]),
    );
  }, [mapControllerRef]);

  // Reset every field whenever the panel opens (seeding the bbox from the
  // current view and the URL from the last session), and abort on close. The
  // resets also run when closed so a draw left armed is disarmed, letting the
  // draw effect's cleanup restore dragPan/boxZoom and the cursor.
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setDrawing(false);
    setPhase("idle");
    setProgress(null);
    setError(null);
    setSuccess(null);
    setPendingPlan((pending) => {
      pending?.resolve(false);
      return null;
    });
    setPos(null);
    if (!open) {
      setCoords(EMPTY_COORDS);
      return;
    }
    try {
      setUrl(localStorage.getItem(URL_STORAGE_KEY) ?? "");
    } catch {
      // Storage may be unavailable (private mode); keep the empty default.
    }
    seedFromView();
  }, [open, seedFromView]);

  // Latest box, read inside the projection callback so the map listeners don't
  // need `bbox` as a dependency (which changes on every drag mousemove).
  const bboxRef = useRef(bbox);
  bboxRef.current = bbox;
  const reprojectRef = useRef<() => void>(() => {});

  // Keep the SVG overlay's corner positions in sync with the camera. Subscribed
  // once per open (not per box edit) to avoid re-attaching listeners on every
  // drag tick. Rendered as an SVG so it sits above any deck.gl overlay.
  useEffect(() => {
    const map = mapControllerRef.current?.getMap();
    if (!map || !open) {
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
  }, [open, mapControllerRef]);

  useEffect(() => {
    reprojectRef.current();
  }, [bbox]);

  // Rubber-band draw mode: drag a rectangle on the map. Mirrors the Raster
  // Subset panel and lib/print-extent.ts: draw starts on a canvas mousedown,
  // then tracking is driven by window mousemove/mouseup so a drag leaving the
  // canvas still commits. dragPan/boxZoom are suspended for the duration.
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
      if (e.originalEvent && e.originalEvent.button !== 0) return;
      start = [e.lngLat.lng, e.lngLat.lat];
    };
    const onWindowMove = (e: MouseEvent) => {
      if (!start) return;
      setCoords(coordsFromBbox(orderBbox(start, toLngLat(e.clientX, e.clientY))));
      clearStatus();
    };
    const onWindowUp = (e: MouseEvent) => {
      if (e.button !== 0 || !start) return;
      setCoords(coordsFromBbox(orderBbox(start, toLngLat(e.clientX, e.clientY))));
      start = null;
      setDrawing(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) setDrawing(false);
    };
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
  }, [drawing, mapControllerRef, clearStatus]);

  const handleUseView = useCallback(() => {
    seedFromView();
    clearStatus();
  }, [seedFromView, clearStatus]);

  const setField = useCallback(
    (field: keyof CoordFields, value: string) => {
      setCoords((prev) => ({ ...prev, [field]: value }));
      clearStatus();
    },
    [clearStatus],
  );

  // Dragging the panel by its header. Mirrors the Raster Subset panel.
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

  const minZoomValue = Number(minZoom);
  const maxZoomValue = Number(maxZoom);
  const zoomInvalid =
    minZoom === "" ||
    maxZoom === "" ||
    !Number.isInteger(minZoomValue) ||
    !Number.isInteger(maxZoomValue) ||
    minZoomValue < 0 ||
    maxZoomValue > 30 ||
    minZoomValue > maxZoomValue;

  const urlValue = url.trim();
  const running = phase === "running";
  const canExtract = !running && urlValue !== "" && bbox !== null && !zoomInvalid;

  const handleExtract = useCallback(async () => {
    if (!bbox || zoomInvalid || urlValue === "") return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("running");
    setProgress(null);
    setError(null);
    setSuccess(null);
    try {
      localStorage.setItem(URL_STORAGE_KEY, urlValue);
    } catch {
      // Best-effort persistence only.
    }
    try {
      const { archive } = await extractPmtiles(urlValue, {
        bbox,
        minZoom: minZoomValue,
        maxZoom: maxZoomValue,
        signal: controller.signal,
        onProgress: setProgress,
        confirmDownload: (plan) => {
          if (plan.estimatedOutputBytes < CONFIRM_BYTES) return true;
          return new Promise<boolean>((resolve) => {
            setPendingPlan({ progress: plan, resolve });
          });
        },
      });
      if (controller.signal.aborted) return;

      const base = sanitizeExportFileName(baseNameFromUrl(urlValue));
      const info = await readPMTilesArchiveInfo(archive);
      const effectiveMax = Math.min(maxZoomValue, info.maxZoom);
      const fileName = `${base}-z${Math.max(minZoomValue, info.minZoom)}-${effectiveMax}`;

      // A vector archive whose metadata has no `vector_layers` gives no source
      // layers to render, which would add a silent placeholder while reporting
      // success. Surface it as an error instead. (Raster archives have none.)
      if (info.tileType === "vector" && info.sourceLayers.length === 0) {
        setPhase("idle");
        setError(t("basemapExtract.errorNoSourceLayers"));
        return;
      }

      // Render the extract from memory first so a disk-write failure below can't
      // discard a successful in-memory extraction.
      const layerId = `basemap-extract-${Date.now().toString(36)}`;
      const layerUrl = registerPMTilesArchive(`${layerId}.pmtiles`, archive);
      const fillColor = DEFAULT_LAYER_STYLE.fillColor;
      const layer: GeoLibreLayer = {
        id: layerId,
        name: fileName,
        type: "pmtiles",
        source: {
          sourceId: layerId,
          sourceLayers: info.sourceLayers,
          tileType: info.tileType,
          type: info.tileType === "raster" ? "raster" : "vector",
          url: layerUrl,
        },
        visible: true,
        // Raster basemaps render dimmed (raster-opacity reads the layer-level
        // `opacity`, not style.fillOpacity); vector renders fully opaque.
        opacity: info.tileType === "raster" ? 0.6 : 1,
        style: {
          ...DEFAULT_LAYER_STYLE,
          fillColor,
          strokeColor: fillColor,
        },
        metadata: {
          externalNativeLayer: true,
          nativeLayerIds: pmtilesNativeLayerIds(
            layerId,
            info.tileType,
            info.sourceLayers,
          ),
          pickable: true,
          sourceId: layerId,
          sourceKind: "pmtiles-url",
          sourceLayers: info.sourceLayers,
          tileType: info.tileType,
        },
        sourcePath: layerUrl,
      };
      addLayer(layer);
      setPhase("done");

      // Persisting to disk is best-effort and independent of the layer that is
      // now on the map: a cancel returns null, a write error is reported but
      // does not undo the extraction.
      try {
        const savedPath = await saveBinaryFileWithFallback(archive, {
          defaultName: `${fileName}.pmtiles`,
          filters: [{ name: "PMTiles", extensions: ["pmtiles"] }],
          browserTypes: [
            {
              description: "PMTiles",
              accept: { "application/octet-stream": [".pmtiles"] },
            },
          ],
          mimeType: "application/octet-stream",
        });
        setSuccess(
          savedPath !== null
            ? t("basemapExtract.successSaved", { path: savedPath })
            : t("basemapExtract.successAdded"),
        );
      } catch (saveErr) {
        setSuccess(
          t("basemapExtract.successAddedSaveFailed", {
            error: saveErr instanceof Error ? saveErr.message : String(saveErr),
          }),
        );
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      if (err instanceof DOMException && err.name === "AbortError") {
        setPhase("idle");
        setProgress(null);
        return;
      }
      setPhase("idle");
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingPlan(null);
      if (abortRef.current === controller) {
        abortRef.current = null;
        setPhase((current) => (current === "running" ? "idle" : current));
      }
    }
  }, [bbox, zoomInvalid, urlValue, minZoomValue, maxZoomValue, addLayer, t]);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setPendingPlan((pending) => {
      pending?.resolve(false);
      return null;
    });
    setPhase("idle");
    setProgress(null);
  }, []);

  const percent =
    progress && progress.dataBytesTotal > 0
      ? Math.round((progress.dataBytesReceived / progress.dataBytesTotal) * 100)
      : 0;
  const phaseLabel =
    progress?.phase === "data"
      ? t("basemapExtract.phaseData")
      : t("basemapExtract.phaseDirectories");

  if (!open) return null;

  return (
    <>
      {screenPoints ? (
        <svg
          className="pointer-events-none absolute inset-0 z-10 h-full w-full"
          aria-hidden="true"
        >
          <polygon
            points={screenPoints.map((p) => `${p.x},${p.y}`).join(" ")}
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
            : "pointer-events-auto absolute start-3 top-16 z-20 flex max-h-[calc(100%-6rem)] w-[min(20rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
        }
        style={pos ? { left: pos.x, top: pos.y } : undefined}
        role="region"
        aria-label={t("basemapExtract.title")}
        data-testid="basemap-extract-panel"
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
            <Download className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            <span className="truncate">{t("basemapExtract.title")}</span>
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
          <div className="space-y-1">
            <Label htmlFor="basemap-extract-url" className="text-xs">
              {t("basemapExtract.url")}
            </Label>
            <Input
              id="basemap-extract-url"
              type="url"
              placeholder={t("basemapExtract.urlPlaceholder")}
              value={url}
              disabled={running}
              onChange={(e) => {
                setUrl(e.target.value);
                clearStatus();
              }}
            />
            <p className="text-xs text-muted-foreground">
              {t("basemapExtract.urlHint")}
            </p>
          </div>

          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant={drawing ? "secondary" : "default"}
              className="flex-1"
              disabled={running}
              onClick={() => setDrawing((d) => !d)}
              aria-pressed={drawing}
            >
              <Scan className="h-3.5 w-3.5" aria-hidden="true" />
              {drawing ? t("basemapExtract.drawing") : t("basemapExtract.drawBbox")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={running}
              onClick={handleUseView}
            >
              <MapIcon className="h-3.5 w-3.5" aria-hidden="true" />
              {t("basemapExtract.useView")}
            </Button>
          </div>
          {drawing ? (
            <p className="text-xs text-muted-foreground">
              {t("basemapExtract.drawHint")}
            </p>
          ) : null}

          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ["north", t("basemapExtract.north")],
                ["south", t("basemapExtract.south")],
                ["west", t("basemapExtract.west")],
                ["east", t("basemapExtract.east")],
              ] as const
            ).map(([field, label]) => (
              <div key={field} className="space-y-1">
                <Label htmlFor={`basemap-extract-${field}`} className="text-xs">
                  {label}
                </Label>
                <Input
                  id={`basemap-extract-${field}`}
                  type="number"
                  step="any"
                  inputMode="decimal"
                  value={coords[field]}
                  disabled={running}
                  onChange={(e) => setField(field, e.target.value)}
                />
              </div>
            ))}
          </div>
          {bboxInvalid ? (
            <p className="text-xs text-destructive">
              {t("basemapExtract.bboxHint")}
            </p>
          ) : null}

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="basemap-extract-minzoom" className="text-xs">
                {t("basemapExtract.minZoom")}
              </Label>
              <Input
                id="basemap-extract-minzoom"
                type="number"
                min={0}
                max={30}
                step={1}
                value={minZoom}
                disabled={running}
                onChange={(e) => {
                  setMinZoom(e.target.value);
                  clearStatus();
                }}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="basemap-extract-maxzoom" className="text-xs">
                {t("basemapExtract.maxZoom")}
              </Label>
              <Input
                id="basemap-extract-maxzoom"
                type="number"
                min={0}
                max={30}
                step={1}
                value={maxZoom}
                disabled={running}
                onChange={(e) => {
                  setMaxZoom(e.target.value);
                  clearStatus();
                }}
              />
            </div>
          </div>
          {zoomInvalid && minZoom !== "" && maxZoom !== "" ? (
            <p className="text-xs text-destructive">
              {t("basemapExtract.zoomHint")}
            </p>
          ) : null}

          {pendingPlan ? (
            <div className="space-y-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3">
              <p className="text-xs">
                {t("basemapExtract.planWarning", {
                  size: formatBytes(pendingPlan.progress.estimatedOutputBytes),
                  tiles: pendingPlan.progress.tilesSelected.toLocaleString(),
                })}
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    pendingPlan.resolve(true);
                    setPendingPlan(null);
                  }}
                >
                  {t("basemapExtract.planContinue")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    pendingPlan.resolve(false);
                    setPendingPlan(null);
                  }}
                >
                  {t("common.cancel")}
                </Button>
              </div>
            </div>
          ) : null}

          {running && !pendingPlan ? (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{phaseLabel}</span>
                {progress && progress.dataBytesTotal > 0 ? (
                  <span>
                    {formatBytes(progress.dataBytesReceived)} /{" "}
                    {formatBytes(progress.dataBytesTotal)}
                  </span>
                ) : null}
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-primary/20">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${percent}%` }}
                />
              </div>
            </div>
          ) : null}

          {error ? (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          {success ? (
            <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
              {success}
            </p>
          ) : null}

          <div className="flex flex-wrap justify-end gap-2">
            {running && !pendingPlan ? (
              <Button type="button" size="sm" variant="outline" onClick={handleCancel}>
                {t("common.cancel")}
              </Button>
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
              {running ? t("basemapExtract.extracting") : t("basemapExtract.extract")}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}
