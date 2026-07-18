import {
  DEFAULT_BASEMAP,
  DEFAULT_LAYER_STYLE,
  type GeoLibreLayer,
  useAppStore,
} from "@geolibre/core";
import {
  buildProtomapsBasemapStyle,
  evictOfflineBasemapStyle,
  hasPMTilesArchive,
  type MapController,
  OFFLINE_BASEMAP_SENTINEL_PREFIX,
  pmtilesNativeLayerIds,
  PROTOMAPS_FLAVORS,
  type ProtomapsFlavor,
  readPMTilesArchiveInfo,
  registerOfflineBasemapStyle,
  registerPMTilesArchive,
  unregisterPMTilesArchive,
} from "@geolibre/map";
import { extractPmtiles, type PmtilesExtractProgress } from "@geolibre/processing";
import { Button, Input, Label, Select } from "@geolibre/ui";
import {
  Check,
  CheckCircle2,
  Download,
  Eraser,
  FolderOpen,
  GripVertical,
  Layers,
  Loader2,
  Map as MapIcon,
  Pencil,
  Scan,
  Trash2,
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
  deleteOfflineBasemap,
  loadOfflineBasemaps,
  type OfflineBasemap,
  renameOfflineBasemap,
  setOfflineBasemapFlavor,
  subscribeOfflineBasemaps,
  upsertOfflineBasemap,
} from "../../lib/offline-basemaps";
import { formatBytes } from "../../lib/offline-regions";
import { layerNameFromPath } from "./add-data/helpers";
import {
  isTauri,
  openLocalDataFileWithFallback,
  readLocalFileBytes,
  saveBinaryFileWithFallback,
} from "../../lib/tauri-io";
import { sanitizeExportFileName } from "../../lib/vector-export";

/** Default panel geometry (px); the user can drag it around the map area. */
const PANEL_DEFAULT_W = 320;
const PANEL_MARGIN = 12;
/** Smallest the panel can be resized to, so the form stays usable. */
const PANEL_MIN_W = 260;
const PANEL_MIN_H = 240;

/** Remembered across sessions so repeat extracts don't retype the archive URL. */
const URL_STORAGE_KEY = "geolibre.basemapExtract.url";

/** GeoLibre's Cloudflare Worker (workers/tiles) range-proxies the Protomaps
 * daily planet builds with CORS. */
const PLANET_PROXY_PREFIX = "https://tiles.geolibre.app/pmtiles/";

/**
 * Default archive URL: the latest Protomaps planet build through the proxy. The
 * Worker resolves `latest` to the newest daily build, so this URL is always
 * current (no client-side date to go stale) and works from any origin —
 * build.protomaps.com itself only allowlists a few and has no `latest` alias.
 */
const DEFAULT_ARCHIVE_URL = `${PLANET_PROXY_PREFIX}latest.pmtiles`;

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

/** Source layers a Protomaps basemap style targets; if an archive exposes some
 * of these it can render with the Protomaps flavors (styled as a basemap)
 * rather than a flat overlay. */
const PROTOMAPS_SCHEMA_LAYERS = ["earth", "water", "roads", "places", "landcover"];

/** `earth`/`water` are distinctively Protomaps-schema; `roads`/`places` are
 * generic names other vector schemas also use. Requiring one of the former
 * (plus two schema layers overall) keeps a non-Protomaps archive that merely
 * has a `roads`/`places` layer from being styled with Protomaps-specific
 * expressions and rendering blank. */
function isProtomapsCompatible(sourceLayers: string[]): boolean {
  const set = new Set(sourceLayers);
  if (!set.has("earth") && !set.has("water")) return false;
  return PROTOMAPS_SCHEMA_LAYERS.filter((l) => set.has(l)).length >= 2;
}

/** Bundled Protomaps glyphs/sprites live under the app's public dir. Resolve
 * them against the deployment base (BASE_URL — "/", "/geolibre/", or a relative
 * "./" for the embed/demo build) AND to a fully-qualified absolute URL:
 * MapLibre rejects non-absolute sprite/glyph URLs ("must be absolute"), so a
 * bare "./basemaps-assets" from a relative base would break labels and icons,
 * while a bare "/basemaps-assets" would 404 under a sub-path. `document.baseURI`
 * turns the base-relative path into an absolute one that honours both. */
const BASEMAP_ASSETS_BASE = new URL(`${import.meta.env.BASE_URL}basemaps-assets`, document.baseURI)
  .href;

// Tracks the in-memory archive (and style-registry id) backing the currently
// applied styled offline basemap. A styled basemap is not a GeoLibreLayer, so
// removeLayerFromMap never frees its archive; we free the previous one here
// when a different basemap is applied, deleted, or the panel supersedes it.
//
// Kept on globalThis (like the style registry and archive-key set this feature
// adds) so it survives a Vite HMR reload of this module — a plain module `let`
// would reset to null on reload and then fail to free the archive the live
// PMTiles protocol still holds.
type ActiveStyledBasemap = { archiveKey: string; id: string } | null;
const ACTIVE_STYLED_BASEMAP_KEY = "__geolibreActiveStyledBasemap";

function activeStyledBasemap(): ActiveStyledBasemap {
  const scope = globalThis as typeof globalThis & {
    [ACTIVE_STYLED_BASEMAP_KEY]?: ActiveStyledBasemap;
  };
  return scope[ACTIVE_STYLED_BASEMAP_KEY] ?? null;
}

function setActiveStyledBasemap(value: ActiveStyledBasemap): void {
  (
    globalThis as typeof globalThis & {
      [ACTIVE_STYLED_BASEMAP_KEY]?: ActiveStyledBasemap;
    }
  )[ACTIVE_STYLED_BASEMAP_KEY] = value;
}

/** Records the archive/id now backing the styled basemap, freeing the one it
 * replaces (a different id) so archives don't accumulate for the session. */
function trackStyledBasemap(id: string, archiveKey: string): void {
  const active = activeStyledBasemap();
  if (active && active.id !== id) {
    unregisterPMTilesArchive(active.archiveKey);
    evictOfflineBasemapStyle(active.id);
  }
  setActiveStyledBasemap({ id, archiveKey });
}

/** Frees a styled basemap's archive/style if it is the active one (e.g. on
 * delete), so nothing keeps its bytes resident after it's gone. */
function forgetStyledBasemap(id: string): void {
  const active = activeStyledBasemap();
  if (active?.id !== id) return;
  unregisterPMTilesArchive(active.archiveKey);
  evictOfflineBasemapStyle(id);
  setActiveStyledBasemap(null);
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
export function BasemapExtractPanel({ open, onClose, mapControllerRef }: BasemapExtractPanelProps) {
  const { t } = useTranslation();
  const addLayer = useAppStore((state) => state.addLayer);
  const setBasemapStyleUrl = useAppStore((state) => state.setBasemapStyleUrl);
  // The live basemap URL from the store — the source of truth for "is this saved
  // entry the one currently on the map". The module-level tracker only sees
  // applies made from this panel, so it goes stale once the user switches the
  // basemap via the picker/New Project dialogs; comparing the store's sentinel
  // avoids acting on a basemap this entry no longer controls.
  const basemapStyleUrl = useAppStore((state) => state.basemapStyleUrl);
  const isLiveOfflineBasemap = useCallback(
    (id: string) =>
      basemapStyleUrl?.startsWith(`${OFFLINE_BASEMAP_SENTINEL_PREFIX}${id}/`) ?? false,
    [basemapStyleUrl],
  );

  const [coords, setCoords] = useState<CoordFields>(EMPTY_COORDS);
  const [drawing, setDrawing] = useState(false);
  const [url, setUrl] = useState("");
  const [minZoom, setMinZoom] = useState("0");
  const [maxZoom, setMaxZoom] = useState("15");
  // When set, apply the extract as a styled Protomaps basemap in this flavor
  // instead of adding it as a flat overlay layer.
  const [flavor, setFlavor] = useState<ProtomapsFlavor | "">("light");
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

  // The device-local catalogue of extracted basemaps, kept in sync so a new
  // extract (or a rename/delete elsewhere) refreshes the "Saved basemaps" list.
  const [savedBasemaps, setSavedBasemaps] = useState<OfflineBasemap[]>(() => loadOfflineBasemaps());
  useEffect(() => subscribeOfflineBasemaps(() => setSavedBasemaps(loadOfflineBasemaps())), []);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

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
  // Explicit size, null until first resized (the responsive default applies).
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const resizeStart = useRef<{
    x: number;
    y: number;
    w: number;
    h: number;
    // Parent-relative top-start corner (the panel is absolute within MapGrid),
    // matching the drag coordinate system so pinning doesn't jump.
    left: number;
    top: number;
    parentW: number;
    parentH: number;
  } | null>(null);
  const [screenPoints, setScreenPoints] = useState<ScreenPoint[] | null>(null);

  // Cancels an in-flight extraction when the panel closes or a new run starts.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const seedFromView = useCallback(() => {
    const map = mapControllerRef.current?.getMap();
    if (!map) return;
    const b = map.getBounds();
    setCoords(coordsFromBbox([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]));
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
    setRenamingId(null);
    setConfirmDeleteId(null);
    setPendingPlan((pending) => {
      pending?.resolve(false);
      return null;
    });
    setPos(null);
    setSize(null);
    // Start with no bounding box: the user draws one or clicks "Use view". Auto-
    // seeding the whole view would, at a globe/world zoom, produce a near-global
    // box whose projected overlay degenerates into a stray line across the map.
    setCoords(EMPTY_COORDS);
    if (!open) return;
    // Seed with the latest Protomaps planet build (via the proxy), or a
    // remembered *custom* URL. A remembered proxy URL — including an old dated
    // one saved before the `latest` default — defers to `latest` so the default
    // never pins a stale date; only a different host is restored.
    let seededUrl = DEFAULT_ARCHIVE_URL;
    try {
      const stored = localStorage.getItem(URL_STORAGE_KEY);
      if (stored && !stored.startsWith(PLANET_PROXY_PREFIX)) seededUrl = stored;
    } catch {
      // Storage may be unavailable (private mode); keep the default.
    }
    setUrl(seededUrl);
  }, [open]);

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
      // A near-global box (e.g. "Use view" at a world/globe zoom) has corners
      // that project to the same pole or wrap around, so the four-corner polygon
      // degenerates into a stray diagonal line. Skip the overlay for such boxes;
      // the extraction still works, there's just no meaningful rectangle to draw.
      if (e - w > 170 || n - s > 170) {
        setScreenPoints(null);
        return;
      }
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

  // Resize from the bottom-end grip. Pins the top-start corner so the panel
  // grows toward the grip, clamped to a usable minimum and the room to the
  // viewport edge. Mirrors the Processing dialog's resize.
  const handleResizeStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    const el = panelRef.current;
    if (!el) return;
    const parent = (el.offsetParent as HTMLElement | null) ?? el.parentElement ?? null;
    const pb = parent?.getBoundingClientRect();
    const eb = el.getBoundingClientRect();
    const left = eb.left - (pb?.left ?? 0);
    const top = eb.top - (pb?.top ?? 0);
    // Pin the top-start corner (parent-relative) so the panel grows toward the
    // grip without jumping.
    setPos({ x: left, y: top });
    resizeStart.current = {
      x: event.clientX,
      y: event.clientY,
      w: eb.width,
      h: eb.height,
      left,
      top,
      parentW: pb?.width ?? window.innerWidth,
      parentH: pb?.height ?? window.innerHeight,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const handleResizeMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const start = resizeStart.current;
    if (!start) return;
    // In an RTL layout the grip renders on the physical left, so the drag
    // delta is inverted and the room to the edge is measured to the left. Pin
    // the physical right edge by shifting `pos.x` as the width changes.
    const isRtl = document.documentElement.dir === "rtl";
    const availW = isRtl
      ? start.left + start.w - PANEL_MARGIN
      : start.parentW - start.left - PANEL_MARGIN;
    const availH = start.parentH - start.top - PANEL_MARGIN;
    const deltaX = event.clientX - start.x;
    const newW = clamp(
      start.w + (isRtl ? -deltaX : deltaX),
      Math.min(PANEL_MIN_W, availW),
      Math.max(PANEL_MIN_W, availW),
    );
    if (isRtl) setPos({ x: start.left + start.w - newW, y: start.top });
    setSize({
      w: newW,
      h: clamp(
        start.h + (event.clientY - start.y),
        Math.min(PANEL_MIN_H, availH),
        Math.max(PANEL_MIN_H, availH),
      ),
    });
  }, []);

  const handleResizeEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    resizeStart.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }, []);

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

      // Register the archive in the shared pmtiles protocol (used by both the
      // styled-basemap style and the flat-overlay layer). Done before saving so
      // a disk-write failure below can't discard a successful extraction.
      const layerId = `basemap-extract-${Date.now().toString(36)}`;
      const layerUrl = registerPMTilesArchive(`${layerId}.pmtiles`, archive);

      // A Protomaps-schema vector archive can render as a proper styled basemap
      // (roads/water/labels) in the chosen flavor; anything else is added as a
      // flat single-symbology overlay layer.
      const asStyledBasemap =
        flavor !== "" && info.tileType === "vector" && isProtomapsCompatible(info.sourceLayers);

      if (asStyledBasemap) {
        const style = buildProtomapsBasemapStyle({
          sourceUrl: layerUrl,
          flavor,
          assetsBaseUrl: BASEMAP_ASSETS_BASE,
        });
        setBasemapStyleUrl(registerOfflineBasemapStyle(layerId, style));
        trackStyledBasemap(layerId, `${layerId}.pmtiles`);
      } else {
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
            nativeLayerIds: pmtilesNativeLayerIds(layerId, info.tileType, info.sourceLayers),
            pickable: true,
            sourceId: layerId,
            sourceKind: "pmtiles-url",
            sourceLayers: info.sourceLayers,
            tileType: info.tileType,
          },
          sourcePath: layerUrl,
        };
        addLayer(layer);
      }
      setPhase("done");

      // Persisting to disk is best-effort and independent of the layer that is
      // now on the map: a cancel returns null, a write error is reported but
      // does not undo the extraction.
      let savedPath: string | null = null;
      try {
        savedPath = await saveBinaryFileWithFallback(archive, {
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
        if (savedPath !== null) {
          setSuccess(
            t(
              asStyledBasemap
                ? "basemapExtract.successBasemapSaved"
                : "basemapExtract.successSaved",
              { path: savedPath },
            ),
          );
        } else {
          setSuccess(
            t(
              asStyledBasemap
                ? "basemapExtract.successBasemapApplied"
                : "basemapExtract.successAdded",
            ),
          );
        }
      } catch (saveErr) {
        setSuccess(
          t(
            asStyledBasemap
              ? "basemapExtract.successBasemapSaveFailed"
              : "basemapExtract.successAddedSaveFailed",
            {
              error: saveErr instanceof Error ? saveErr.message : String(saveErr),
            },
          ),
        );
      }

      // Record it in the device-local catalogue so the Saved basemaps list can
      // rename, delete, and re-apply it.
      upsertOfflineBasemap({
        id: layerId,
        name: fileName,
        bbox,
        minZoom: Math.max(minZoomValue, info.minZoom),
        maxZoom: effectiveMax,
        flavor: asStyledBasemap ? flavor : null,
        tileType: info.tileType,
        bytes: archive.byteLength,
        savedPath,
        createdAt: Date.now(),
      });
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
  }, [
    bbox,
    zoomInvalid,
    urlValue,
    minZoomValue,
    maxZoomValue,
    flavor,
    addLayer,
    setBasemapStyleUrl,
    t,
  ]);

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

  // Re-apply a saved basemap as the styled Protomaps basemap. If its archive is
  // still registered this session, reuse it. Otherwise reload the bytes: from
  // the remembered saved path on desktop, or by asking the user to locate the
  // .pmtiles file (works on web, where there is no stable path).
  const applySaved = useCallback(
    async (entry: OfflineBasemap) => {
      // Only styled vector entries can be re-applied as a basemap. Entries saved
      // as overlays (user picked "None", or the archive failed the Protomaps
      // schema check) have `flavor === null` — forcing them through
      // buildProtomapsBasemapStyle would render a blank/broken basemap.
      if (entry.tileType !== "vector" || entry.flavor == null) return;
      setApplyingId(entry.id);
      setError(null);
      setSuccess(null);
      try {
        const key = `${entry.id}.pmtiles`;
        if (!hasPMTilesArchive(key)) {
          let bytes: Uint8Array | null = null;
          if (entry.savedPath && isTauri()) {
            bytes = await readLocalFileBytes(entry.savedPath);
          } else {
            const picked = await openLocalDataFileWithFallback({
              filters: [{ name: "PMTiles", extensions: ["pmtiles"] }],
              accept: ".pmtiles",
              readBinary: true,
            });
            // Cancelled the picker: nothing to apply, no error.
            if (!picked?.data) return;
            bytes = new Uint8Array(picked.data);
          }
          registerPMTilesArchive(key, bytes);
        }
        const style = buildProtomapsBasemapStyle({
          sourceUrl: `pmtiles://${key}`,
          flavor: (entry.flavor as ProtomapsFlavor) || "light",
          assetsBaseUrl: BASEMAP_ASSETS_BASE,
        });
        setBasemapStyleUrl(registerOfflineBasemapStyle(entry.id, style));
        trackStyledBasemap(entry.id, key);
        setSuccess(t("basemapExtract.successBasemapApplied"));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setApplyingId(null);
      }
    },
    [setBasemapStyleUrl, t],
  );

  // Change a saved basemap's flavor. Persists it, and re-styles live if the
  // archive is already loaded (an instant restyle); otherwise it takes effect
  // the next time "Use as basemap" loads it.
  const handleSavedFlavorChange = useCallback(
    (entry: OfflineBasemap, next: ProtomapsFlavor) => {
      // A flavor only applies to a styled basemap. Overlay-saved entries
      // (flavor === null) can't be re-styled, so leave them untouched — forcing
      // a flavor here would push an incompatible archive through applySaved.
      if (entry.flavor == null) return;
      setOfflineBasemapFlavor(entry.id, next);
      // Re-style live only when this entry is the basemap currently on the map;
      // otherwise just persist the flavor (it applies next "Use as basemap").
      // Without the live check, tweaking a non-displayed entry's flavor would
      // silently swap it in as the active basemap.
      if (isLiveOfflineBasemap(entry.id) && hasPMTilesArchive(`${entry.id}.pmtiles`)) {
        void applySaved({ ...entry, flavor: next });
      }
    },
    [applySaved, isLiveOfflineBasemap],
  );

  const startRename = useCallback((entry: OfflineBasemap) => {
    setRenamingId(entry.id);
    setRenameValue(entry.name);
  }, []);

  const commitRename = useCallback(() => {
    setRenamingId((id) => {
      if (id) renameOfflineBasemap(id, renameValue);
      return null;
    });
  }, [renameValue]);

  // Open a local .pmtiles file directly as a styled basemap — no download/
  // extract needed. Applies it in the current flavor and records it under
  // "Saved basemaps".
  const [opening, setOpening] = useState(false);
  const openPmtilesAsBasemap = useCallback(async () => {
    setOpening(true);
    setError(null);
    setSuccess(null);
    try {
      const picked = await openLocalDataFileWithFallback({
        filters: [{ name: "PMTiles", extensions: ["pmtiles"] }],
        accept: ".pmtiles",
        readBinary: true,
      });
      if (!picked?.data) return;
      const bytes = new Uint8Array(picked.data);
      const info = await readPMTilesArchiveInfo(bytes);
      // Only a Protomaps-schema vector archive can be styled as a basemap; a
      // non-Protomaps archive (or a raster one) would render blank through
      // buildProtomapsBasemapStyle, so refuse it here the same way handleExtract
      // falls back to a flat overlay.
      if (
        info.tileType !== "vector" ||
        info.sourceLayers.length === 0 ||
        !isProtomapsCompatible(info.sourceLayers)
      ) {
        setError(t("basemapExtract.errorNotBasemap"));
        return;
      }
      const id = `basemap-open-${Date.now().toString(36)}`;
      const key = `${id}.pmtiles`;
      registerPMTilesArchive(key, bytes);
      const useFlavor: ProtomapsFlavor = flavor !== "" ? flavor : "light";
      const style = buildProtomapsBasemapStyle({
        sourceUrl: `pmtiles://${key}`,
        flavor: useFlavor,
        assetsBaseUrl: BASEMAP_ASSETS_BASE,
      });
      setBasemapStyleUrl(registerOfflineBasemapStyle(id, style));
      trackStyledBasemap(id, key);
      upsertOfflineBasemap({
        id,
        // `picked.path` is a full absolute path on desktop; take just the file's
        // base name so the saved entry reads "tuscany", not "home-alice-…".
        name: layerNameFromPath(picked.path || "", "basemap"),
        bbox: info.bounds,
        minZoom: info.minZoom,
        maxZoom: info.maxZoom,
        flavor: useFlavor,
        tileType: "vector",
        bytes: bytes.length,
        // A Tauri path is reloadable across sessions; a browser file name is not.
        savedPath: isTauri() ? picked.path || null : null,
        createdAt: Date.now(),
      });
      setSuccess(t("basemapExtract.successBasemapApplied"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpening(false);
    }
  }, [flavor, setBasemapStyleUrl, t]);

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
        <svg className="pointer-events-none absolute inset-0 z-10 h-full w-full" aria-hidden="true">
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
            ? "pointer-events-auto absolute z-20 flex w-[26rem] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
            : "pointer-events-auto absolute start-3 top-3 z-20 flex max-h-[calc(100%-1.5rem)] w-[min(26rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
        }
        style={{
          ...(pos ? { left: pos.x, top: pos.y } : {}),
          ...(size ? { width: size.w, height: size.h } : {}),
        }}
        role="region"
        aria-label={t("basemapExtract.title")}
        data-testid="basemap-extract-panel"
      >
        <div
          className="flex cursor-move touch-none select-none items-center justify-between gap-2 border-b px-3 py-2"
          onPointerDown={handleDragStart}
        >
          <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
            <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
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

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3 text-sm">
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
              className="flex-1"
              disabled={running}
              onClick={handleUseView}
            >
              <MapIcon className="h-3.5 w-3.5" aria-hidden="true" />
              {t("basemapExtract.useView")}
            </Button>
            {bbox || bboxInvalid ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={running}
                onClick={() => {
                  setDrawing(false);
                  setCoords(EMPTY_COORDS);
                  clearStatus();
                }}
                title={t("basemapExtract.clearBbox")}
                aria-label={t("basemapExtract.clearBbox")}
              >
                <Eraser className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            ) : null}
          </div>
          {drawing ? (
            <p className="text-xs text-muted-foreground">{t("basemapExtract.drawHint")}</p>
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
            <p className="text-xs text-destructive">{t("basemapExtract.bboxHint")}</p>
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
            <p className="text-xs text-destructive">{t("basemapExtract.zoomHint")}</p>
          ) : null}

          <div className="space-y-1">
            <Label htmlFor="basemap-extract-style" className="text-xs">
              {t("basemapExtract.style")}
            </Label>
            <Select
              id="basemap-extract-style"
              value={flavor}
              disabled={running}
              onChange={(e) => {
                setFlavor(e.target.value as ProtomapsFlavor | "");
                clearStatus();
              }}
            >
              {PROTOMAPS_FLAVORS.map((f) => (
                <option key={f} value={f}>
                  {t(`basemapExtract.flavor.${f}`)}
                </option>
              ))}
              <option value="">{t("basemapExtract.flavorOverlay")}</option>
            </Select>
            <p className="text-xs text-muted-foreground">
              {flavor === ""
                ? t("basemapExtract.styleHintOverlay")
                : t("basemapExtract.styleHintBasemap")}
            </p>
          </div>

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
              {progress && progress.estimatedOutputBytes > 0 ? (
                <p
                  className={
                    progress.estimatedOutputBytes >= CONFIRM_BYTES
                      ? "text-xs font-medium text-amber-600 dark:text-amber-400"
                      : "text-xs text-muted-foreground"
                  }
                >
                  {progress.estimatedOutputBytes >= CONFIRM_BYTES
                    ? t("basemapExtract.estimatedSizeLarge", {
                        size: formatBytes(progress.estimatedOutputBytes),
                        tiles: progress.tilesSelected.toLocaleString(),
                      })
                    : t("basemapExtract.estimatedSize", {
                        size: formatBytes(progress.estimatedOutputBytes),
                        tiles: progress.tilesSelected.toLocaleString(),
                      })}
                </p>
              ) : null}
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

          <div className="space-y-1.5 border-t pt-3">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-xs">{t("basemapExtract.savedTitle")}</Label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                disabled={opening}
                onClick={() => void openPmtilesAsBasemap()}
              >
                {opening ? (
                  <Loader2 className="me-1 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <FolderOpen className="me-1 h-3.5 w-3.5" aria-hidden="true" />
                )}
                {t("basemapExtract.openFile")}
              </Button>
            </div>
            {savedBasemaps.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("basemapExtract.savedEmpty")}</p>
            ) : (
              <div className="max-h-48 space-y-1 overflow-auto">
                {savedBasemaps.map((entry) => (
                  <div
                    key={entry.id}
                    className="flex items-center gap-1 rounded-md border px-2 py-1.5"
                  >
                    {renamingId === entry.id ? (
                      <>
                        <Input
                          autoFocus
                          className="h-7 flex-1 text-xs"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitRename();
                            if (e.key === "Escape") setRenamingId(null);
                          }}
                          onBlur={commitRename}
                        />
                        <button
                          type="button"
                          className="rounded p-1 text-muted-foreground hover:text-foreground"
                          onClick={commitRename}
                          aria-label={t("common.save")}
                        >
                          <Check className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      </>
                    ) : (
                      <>
                        <div className="min-w-0 flex-1 space-y-0.5">
                          <p className="truncate text-xs font-medium" title={entry.name}>
                            {entry.name}
                          </p>
                          <div className="flex items-center gap-1.5">
                            {entry.tileType === "vector" && entry.flavor != null ? (
                              <select
                                className="h-6 rounded border border-input bg-background px-1 text-[11px] text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                value={(entry.flavor as ProtomapsFlavor) || "light"}
                                onChange={(e) =>
                                  handleSavedFlavorChange(entry, e.target.value as ProtomapsFlavor)
                                }
                                aria-label={t("basemapExtract.style")}
                              >
                                {PROTOMAPS_FLAVORS.map((f) => (
                                  <option key={f} value={f}>
                                    {t(`basemapExtract.flavor.${f}`)}
                                  </option>
                                ))}
                              </select>
                            ) : null}
                            <span className="truncate text-[11px] text-muted-foreground">
                              {formatBytes(entry.bytes)} · z{entry.minZoom}–{entry.maxZoom}
                            </span>
                          </div>
                        </div>
                        {confirmDeleteId === entry.id ? (
                          <>
                            <span className="text-[11px] text-muted-foreground">
                              {t("basemapExtract.confirmDelete")}
                            </span>
                            <button
                              type="button"
                              className="rounded p-1 text-destructive hover:bg-destructive/10"
                              onClick={() => {
                                deleteOfflineBasemap(entry.id);
                                // If this entry is the live basemap, switch back
                                // to the default first — otherwise the applied
                                // MapLibre style is left pointing at a pmtiles://
                                // source whose archive we're about to free, and
                                // pans into unfetched tiles would silently 404.
                                // Check the store (not the panel-local tracker,
                                // which can be stale) so we never clobber a
                                // basemap the user switched to elsewhere.
                                if (isLiveOfflineBasemap(entry.id)) {
                                  setBasemapStyleUrl(DEFAULT_BASEMAP);
                                }
                                // Free its in-memory archive/style if it's the
                                // one currently applied, so nothing lingers.
                                forgetStyledBasemap(entry.id);
                                setConfirmDeleteId(null);
                              }}
                              title={t("basemapExtract.delete")}
                              aria-label={t("basemapExtract.delete")}
                            >
                              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              className="rounded p-1 text-muted-foreground hover:text-foreground"
                              onClick={() => setConfirmDeleteId(null)}
                              title={t("common.cancel")}
                              aria-label={t("common.cancel")}
                            >
                              <X className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-40"
                              disabled={
                                entry.tileType !== "vector" ||
                                entry.flavor == null ||
                                applyingId === entry.id
                              }
                              onClick={() => void applySaved(entry)}
                              title={t("basemapExtract.apply")}
                              aria-label={t("basemapExtract.apply")}
                            >
                              {applyingId === entry.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                              ) : (
                                <Layers className="h-3.5 w-3.5" aria-hidden="true" />
                              )}
                            </button>
                            <button
                              type="button"
                              className="rounded p-1 text-muted-foreground hover:text-foreground"
                              onClick={() => startRename(entry)}
                              title={t("basemapExtract.rename")}
                              aria-label={t("basemapExtract.rename")}
                            >
                              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              className="rounded p-1 text-muted-foreground hover:text-destructive"
                              onClick={() => setConfirmDeleteId(entry.id)}
                              title={t("basemapExtract.delete")}
                              aria-label={t("basemapExtract.delete")}
                            >
                              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                          </>
                        )}
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div
          className="absolute bottom-0 end-0 h-4 w-4 cursor-se-resize touch-none rtl:cursor-sw-resize"
          onPointerDown={handleResizeStart}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeEnd}
          onPointerCancel={handleResizeEnd}
          role="separator"
          aria-label={t("basemapExtract.resize")}
        />
      </div>
    </>
  );
}
