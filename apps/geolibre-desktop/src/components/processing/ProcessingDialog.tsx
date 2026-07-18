import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import {
  clearRemoteWhiteboxCatalogSnapshotCache,
  fetchWhiteboxJob,
  fetchWhiteboxJsonOutput,
  fetchRemoteWhiteboxCatalogSnapshot,
  fetchWhiteboxStatus,
  fetchWhiteboxTools,
  listWasmToolManifests,
  mergeWasmToolManifests,
  normalizeVectorOutputFormat,
  runWhiteboxTool,
  runWhiteboxToolWasm,
  outputBaseName,
  fileOutputTargetExtension,
  outputTextFormatHint,
  type WhiteboxJob,
  type WhiteboxLayerInput,
  type WhiteboxTool,
  type WhiteboxToolParameter,
} from "@geolibre/processing";
import { Button, Input, Label, ScrollArea, Select, cn } from "@geolibre/ui";
import type { FeatureCollection } from "geojson";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  FolderOpen,
  GripHorizontal,
  Loader2,
  Play,
  RefreshCw,
  Save,
  Scan,
  Search,
  Server,
  ServerOff,
  SquareDashed,
  X,
} from "lucide-react";
import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  isTauri,
  openLocalDataFileWithFallback,
  pickLocalPathWithFallback,
  pickSavePathWithFallback,
  type FileDialogFilter,
} from "../../lib/tauri-io";
import { clamp } from "../../lib/clamp";
import { fetchableUrl } from "../../lib/url-utils";
import {
  layersForSubsetUrl,
  subsetUrlFieldValues,
  subsetUrlToolKind,
} from "../../lib/subset-tool-url";
import { clearPrintExtent, drawPrintExtent } from "../../lib/print-extent";
import { startGeoLibreSidecar, stopGeoLibreSidecar } from "../../lib/sidecar";
import {
  beginProcessingRun,
  MAX_TRACKED_HISTORY_JOBS,
  type ProcessingRunTracker,
} from "../../lib/processing-history";
import { SidecarHelpBanner } from "./SidecarHelpBanner";

interface ProcessingDialogProps {
  mapControllerRef: React.RefObject<MapController | null>;
  // Renders a raster tool output (a Cloud Optimized GeoTIFF, from the WASM
  // runner) as a new map layer. Wired by the desktop shell, which owns the
  // raster control / app API.
  onAddRaster?: (bytes: Uint8Array, name: string, fileName?: string) => Promise<void> | void;
}

type ParameterValues = Record<string, unknown>;

const LAYER_TOKEN_PREFIX = "layer:";
const RUNNING_JOB_STATUSES = new Set(["pending", "running"]);

// Smallest the floating panel can be resized to, so the two-column tool browser
// stays usable (left list + a readable parameter form).
const PANEL_MIN_W = 560;
const PANEL_MIN_H = 400;

function toolLabel(tool: WhiteboxTool): string {
  return tool.display_name || humanize(tool.id);
}

function humanize(value: string): string {
  return (
    value
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Tool"
  );
}

function parameterLabel(param: WhiteboxToolParameter): string {
  return param.description || humanize(param.name);
}

function parameterKind(param: WhiteboxToolParameter): string {
  if (param.kind) return param.kind;
  const schema = param.schema;
  const schemaObject =
    schema && typeof schema === "object" ? (schema as Record<string, unknown>) : {};
  const dataset =
    schemaObject.dataset && typeof schemaObject.dataset === "object"
      ? (schemaObject.dataset as Record<string, unknown>)
      : {};
  const dataKind = String(
    param.data_kind ?? schemaObject.data_kind ?? dataset.kind ?? param.type ?? "",
  ).toLowerCase();
  const role = String(param.io_role ?? schemaObject.kind ?? "").toLowerCase();
  if (role === "input") return datasetParameterKind(dataKind, "in");
  if (role === "output") return datasetParameterKind(dataKind, "out");
  if (dataKind === "bool" || schemaObject.kind === "bool") return "bool";
  if (schemaObject.kind === "enum" || param.options?.length) return "enum";
  if (dataKind === "number" || schemaObject.kind === "scalar") {
    const scalar = String(schemaObject.scalar ?? "").toLowerCase();
    return scalar.includes("int") ? "int" : "double";
  }
  return "string";
}

function datasetParameterKind(dataKind: string, suffix: "in" | "out"): string {
  if (["raster", "vector", "lidar", "file"].includes(dataKind)) {
    return `${dataKind}_${suffix}`;
  }
  return `file_${suffix}`;
}

function isOutputParameter(param: WhiteboxToolParameter): boolean {
  return parameterKind(param).endsWith("_out");
}

/**
 * Best-effort extension for a binary tool output, sniffed from its magic bytes.
 * Covers the formats GeoLibre `file_out` and (CRS-preserving) `vector_out` tools
 * emit today (GeoParquet, FlatGeobuf, zipped Shapefile, PNG, PMTiles); a
 * genuinely opaque output falls back to `.bin`. Extend the sniff here if a
 * future tool writes a recognizable format.
 */
function fileOutputExtension(bytes: Uint8Array): string {
  const matches = (sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (matches([0x50, 0x41, 0x52, 0x31])) return "parquet"; // "PAR1"
  if (matches([0x66, 0x67, 0x62, 0x03])) return "fgb"; // FlatGeobuf "fgb\x03"
  if (matches([0x50, 0x4b, 0x03, 0x04])) return "zip"; // Shapefile bundle "PK\x03\x04"
  if (matches([0x89, 0x50, 0x4e, 0x47])) return "png";
  // "PMTiles"
  if (matches([0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73])) return "pmtiles";
  return "bin";
}

/** Save bytes to the user's downloads via a transient object URL. */
function downloadBytes(bytes: Uint8Array, filename: string): void {
  // Cast required: TS types Uint8Array as Uint8Array<ArrayBufferLike>, which is
  // not directly assignable to BlobPart under this lib (mirrors DesktopShell).
  const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Defer revoke so the browser can fetch the blob first (Firefox races and
  // silently drops the download if the URL is revoked synchronously).
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function isDataInputParameter(param: WhiteboxToolParameter): boolean {
  return ["raster_in", "vector_in", "lidar_in", "file_in"].includes(parameterKind(param));
}

// A `bbox` string param paired with a `bbox_crs` param is the geographic extent
// of a subset tool, so the field can offer a "Use map extent" shortcut that
// fills both from the current map view (GeoLibre#1213). Matching on the pair
// covers every COG/WMS/XYZ (and future) extractor without hard-coding tool ids.
function isMapExtentParameter(tool: WhiteboxTool, param: WhiteboxToolParameter): boolean {
  return (
    param.name === "bbox" &&
    parameterKind(param) === "string" &&
    Boolean(tool.params?.some((other) => other.name === "bbox_crs"))
  );
}

// The `url` string param of a COG/WMS/XYZ subset extractor, whose value can be
// filled from a compatible layer already loaded in the map (GeoLibre#1271). The
// tool-kind lookup keeps this to the subset extractors without hard-coding each
// id here; layer eligibility and the derived field values live in
// `subset-tool-url.ts`.
function isSubsetUrlParameter(tool: WhiteboxTool, param: WhiteboxToolParameter): boolean {
  return (
    param.name === "url" && parameterKind(param) === "string" && subsetUrlToolKind(tool.id) !== null
  );
}

function isPathParameter(param: WhiteboxToolParameter): boolean {
  const kind = parameterKind(param);
  if (isDataInputParameter(param) || isOutputParameter(param)) return true;
  const text = `${param.name} ${param.description ?? ""} ${param.type ?? ""}`.toLowerCase();
  return /\b(path|file|folder|directory)\b/.test(text);
}

function isDirectoryParameter(param: WhiteboxToolParameter): boolean {
  const text = `${param.name} ${param.description ?? ""} ${param.type ?? ""}`.toLowerCase();
  return /\b(folder|directory|dir)\b/.test(text);
}

function pathFiltersForParameter(param: WhiteboxToolParameter): FileDialogFilter[] {
  const kind = parameterKind(param);
  if (kind.startsWith("raster")) {
    return [
      {
        name: "Raster",
        extensions: ["tif", "tiff", "img", "bil", "flt", "sdat", "rdc", "asc"],
      },
    ];
  }
  if (kind.startsWith("vector")) {
    return [
      {
        name: "Vector",
        extensions: ["geojson", "json", "shp", "gpkg", "fgb", "sqlite", "gml", "kml"],
      },
    ];
  }
  if (kind.startsWith("lidar")) {
    return [
      {
        name: "LiDAR",
        extensions: ["las", "laz", "zlidar", "copc", "e57", "ply"],
      },
    ];
  }
  if (/\b(csv|json|html|txt|xml)\b/i.test(`${param.name} ${param.type ?? ""}`)) {
    return [
      {
        name: "Files",
        extensions: ["csv", "json", "geojson", "html", "txt", "xml"],
      },
    ];
  }
  return [];
}

function acceptForParameter(param: WhiteboxToolParameter): string {
  return pathFiltersForParameter(param)
    .flatMap((filter) => filter.extensions)
    .map((extension) => `.${extension}`)
    .join(",");
}

function outputExtensionForParameter(param: WhiteboxToolParameter): string {
  const kind = parameterKind(param);
  if (kind === "raster_out") return ".tif";
  if (kind === "vector_out") return ".shp";
  if (kind === "lidar_out") return ".laz";
  // Sniff the intended text format from the parameter's name/description/type
  // via the same shared helper the WASM runner uses (e.g.
  // vector_summary_statistics' output is an "Output CSV path"). Only the
  // fallback differs: a friendly `.txt` here for a default filename suggestion,
  // vs the opaque `.dat` the runner writes.
  const hint = outputTextFormatHint(param);
  return hint ? `.${hint}` : ".txt";
}

function defaultOutputName(toolId: string, param: WhiteboxToolParameter): string {
  const stem = `${toolId || "whitebox"}_${param.name || "output"}`
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${stem || "whitebox_output"}${outputExtensionForParameter(param)}`;
}

function isFeatureCollection(value: unknown): value is FeatureCollection {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "FeatureCollection" &&
    Array.isArray((value as { features?: unknown }).features)
  );
}

function layerPath(layer: GeoLibreLayer): string {
  if (layer.sourcePath) return layer.sourcePath;
  const url = layer.source.url;
  if (typeof url === "string") return url;
  const tiles = layer.source.tiles;
  if (Array.isArray(tiles) && typeof tiles[0] === "string") return tiles[0];
  return "";
}

// Fetch a raster/LiDAR layer's underlying bytes for the in-browser WASM runner.
// Returns null when the data is not directly fetchable (e.g. a desktop file
// path or a tile template), in which case the caller falls back to the sidecar.
async function fetchLayerBytes(layer: GeoLibreLayer): Promise<Uint8Array | null> {
  const src = layer.source as Record<string, unknown>;
  const tiles = Array.isArray(src.tiles) ? src.tiles : [];
  // localBytesUrl is a blob URL retaining a File-loaded raster's bytes (the
  // raster control's source.objectUrl, surfaced by the raster store sync);
  // prefer it so locally loaded rasters are WASM-runnable.
  const candidates = [layer.metadata.localBytesUrl, src.url, tiles[0], layer.sourcePath];
  for (const candidate of candidates) {
    const url = fetchableUrl(candidate);
    if (!url) continue;
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length === 0 || bytes[0] === 0x3c) continue; // 0x3c '<' = HTML
      return bytes;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function canUseLayerForParameter(layer: GeoLibreLayer, param: WhiteboxToolParameter): boolean {
  const kind = parameterKind(param);
  if (kind === "vector_in") {
    return Boolean(layer.geojson || layerPath(layer));
  }
  if (kind === "raster_in") {
    return ["raster", "cog", "wms", "wmts", "xyz", "zarr"].includes(layer.type);
  }
  if (kind === "lidar_in") return layer.type === "lidar";
  return Boolean(layerPath(layer));
}

function defaultParameterValue(param: WhiteboxToolParameter): unknown {
  if (isOutputParameter(param)) return "";
  if (param.default !== undefined && param.default !== null) return param.default;
  if (parameterKind(param) === "bool") return false;
  return "";
}

function createDefaultValues(tool: WhiteboxTool | null): ParameterValues {
  const values: ParameterValues = {};
  for (const param of tool?.params ?? []) {
    values[param.name] = defaultParameterValue(param);
  }
  return values;
}

function mergeCatalogParameterFallbacks(
  liveTools: WhiteboxTool[],
  snapshotTools: WhiteboxTool[],
): WhiteboxTool[] {
  const snapshotById = new Map(snapshotTools.map((tool) => [tool.id, tool] as const));
  return liveTools.map((tool) => {
    if (tool.params?.length) return tool;
    const snapshot = snapshotById.get(tool.id);
    if (!snapshot?.params?.length) return tool;
    return {
      ...tool,
      params: snapshot.params,
      return_type: tool.return_type ?? snapshot.return_type,
    };
  });
}

function outputPath(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object") {
    const path = (value as { path?: unknown }).path;
    if (typeof path === "string" && path.trim()) return path.trim();
  }
  return null;
}

function outputEntries(outputs: Record<string, unknown>): [string, string][] {
  return Object.entries(outputs)
    .map(([name, value]) => [name, outputPath(value)] as const)
    .filter((entry): entry is [string, string] => Boolean(entry[1]));
}

function isJsonOutputPath(path: string): boolean {
  return /\.(geojson|json)$/i.test(path);
}

function jobStatusTone(job: WhiteboxJob | null): string {
  if (!job) return "text-muted-foreground";
  if (job.status === "succeeded") return "text-emerald-700";
  if (job.status === "failed") return "text-destructive";
  return "text-primary";
}

export function ProcessingDialog({ mapControllerRef, onAddRaster }: ProcessingDialogProps) {
  const { t } = useTranslation();
  const open = useAppStore((s) => s.ui.processingOpen);
  const setProcessingOpen = useAppStore((s) => s.setProcessingOpen);
  const processingInitialTool = useAppStore((s) => s.ui.processingInitialTool);
  const setProcessingInitialTool = useAppStore((s) => s.setProcessingInitialTool);
  const layers = useAppStore((s) => s.layers);
  const addGeoJsonLayer = useAppStore((s) => s.addGeoJsonLayer);
  const rerun = useAppStore((s) => s.ui.processingRerun);
  const setProcessingRerun = useAppStore((s) => s.setProcessingRerun);

  const [tools, setTools] = useState<WhiteboxTool[]>([]);
  const [selectedToolId, setSelectedToolId] = useState("");
  const [values, setValues] = useState<ParameterValues>({});
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  // Tool provenance filter: "All" | "geolibre" | "whitebox". Only meaningful in
  // WASM mode, where GeoLibre-authored tools are mixed into the catalog.
  const [source, setSource] = useState("All");
  const [loadingTools, setLoadingTools] = useState(false);
  const [runtimeMessage, setRuntimeMessage] = useState("");
  const [runtimeAvailable, setRuntimeAvailable] = useState<boolean | null>(null);
  // Cache the desktop check once, matching the sibling processing dialogs
  // (ConversionDialog, RasterToolsDialog).
  const desktop = isTauri();
  // Run tools locally in WebAssembly (no Python sidecar). Default on in the
  // browser, where there is no sidecar; off under Tauri, where the sidecar is
  // available and can read native file paths that the WASM runner cannot fetch.
  const [runLocal, setRunLocal] = useState(!desktop);
  const [error, setError] = useState<string | null>(null);
  const [startingServer, setStartingServer] = useState(false);
  const [stoppingServer, setStoppingServer] = useState(false);
  const [job, setJob] = useState<WhiteboxJob | null>(null);
  // True while a run is in flight. The WASM runner resolves straight to a
  // terminal job (never "pending"/"running"), so without this flag the Run
  // button would stay enabled mid-execution and allow concurrent runs.
  const [runningLocal, setRunningLocal] = useState(false);

  // Floating, non-modal panel (GH: whitebox modal -> floating panel). Rendered
  // as a draggable `fixed` window instead of a Radix modal so the map stays
  // interactive while a tool is open (e.g. to pan/zoom and use "Use map extent"
  // for the subset tools). Mirrors RecordVideoDialog's drag pattern. `pos` is
  // null until first dragged, when the default corner placement (CSS) applies;
  // afterwards it pins to explicit coords.
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragOffset = useRef<{ x: number; y: number } | null>(null);
  // Explicit size, null until first resized (the default responsive CSS size
  // applies). A drag from the bottom-right grip grows the panel from its pinned
  // top-left corner.
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const resizeStart = useRef<{
    x: number;
    y: number;
    w: number;
    h: number;
    left: number;
    top: number;
  } | null>(null);
  // True while a "Draw on map" rubber-band is in progress.
  const [drawing, setDrawing] = useState(false);
  const drawAbortRef = useRef<AbortController | null>(null);
  // Viewport-space corners of the in-progress draw box, drawn as an SVG overlay
  // (not a MapLibre layer) so the rubber-band sits above an interleaved deck.gl
  // raster, which occludes MapLibre layers.
  const [drawPoints, setDrawPoints] = useState<{ x: number; y: number }[] | null>(null);

  const onDragStart = (event: React.PointerEvent) => {
    // Never begin a drag from an interactive control: the pointer capture would
    // swallow the ensuing click (e.g. the close button).
    if ((event.target as Element).closest("button, a, input, [role='button']")) return;
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragOffset.current = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    setPos({ x: rect.left, y: rect.top });
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onDragMove = (event: React.PointerEvent) => {
    if (!dragOffset.current) return;
    const width = panelRef.current?.offsetWidth ?? 0;
    const height = panelRef.current?.offsetHeight ?? 0;
    // Keep the panel within the viewport so it can't be dragged off-screen.
    const x = Math.max(
      0,
      Math.min(event.clientX - dragOffset.current.x, window.innerWidth - width),
    );
    const y = Math.max(
      0,
      Math.min(event.clientY - dragOffset.current.y, window.innerHeight - height),
    );
    setPos({ x, y });
  };

  const onDragEnd = (event: React.PointerEvent) => {
    dragOffset.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const onResizeStart = (event: React.PointerEvent) => {
    // Don't also start a header drag; the grip lives outside the header but stop
    // propagation defensively.
    event.stopPropagation();
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Pin the top-left so the panel grows toward the grip instead of staying
    // centered (the default placement uses a translate to center it).
    setPos({ x: rect.left, y: rect.top });
    resizeStart.current = {
      x: event.clientX,
      y: event.clientY,
      w: rect.width,
      h: rect.height,
      left: rect.left,
      top: rect.top,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onResizeMove = (event: React.PointerEvent) => {
    const start = resizeStart.current;
    if (!start) return;
    // Grow from the pinned top-left, clamped to a usable minimum and the room
    // available to the viewport edge. The minimum is itself capped to that room,
    // so a panel pinned near the edge (or a viewport smaller than the minimum)
    // shrinks to fit rather than being forced off-screen past the grip.
    const availW = window.innerWidth - start.left;
    const availH = window.innerHeight - start.top;
    const w = clamp(start.w + (event.clientX - start.x), Math.min(PANEL_MIN_W, availW), availW);
    const h = clamp(start.h + (event.clientY - start.y), Math.min(PANEL_MIN_H, availH), availH);
    setSize({ w, h });
  };

  const onResizeEnd = (event: React.PointerEvent) => {
    resizeStart.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  // Escape closes the panel, mirroring the affordance the Radix modal provided.
  // Since the panel is non-modal, only act when focus is inside it, so pressing
  // Escape to cancel an unrelated map/panel interaction doesn't also close this
  // one. Suppressed while drawing so Escape cancels the in-progress rubber-band
  // (the draw helper's own Escape handler) instead of closing the whole panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !drawing &&
        panelRef.current?.contains(document.activeElement)
      ) {
        setProcessingOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, drawing, setProcessingOpen]);

  // Re-clamp an explicit size and dragged position to the viewport, so a
  // resized/moved panel can't be left oversized or partly off-screen. Runs once
  // on open (position/size persist across opens, so the window may have shrunk
  // while the panel was closed) and on every subsequent resize. Functional
  // updates read the latest values, so the listener isn't re-subscribed on every
  // drag/resize frame; a never-moved/never-resized panel (null) keeps its
  // responsive CSS placement. The size minimum is capped to the viewport so a
  // window smaller than the minimum shrinks the panel to fit.
  useEffect(() => {
    if (!open) return;
    const clampToViewport = () => {
      setSize((current) =>
        current
          ? {
              w: clamp(current.w, Math.min(PANEL_MIN_W, window.innerWidth), window.innerWidth),
              h: clamp(current.h, Math.min(PANEL_MIN_H, window.innerHeight), window.innerHeight),
            }
          : null,
      );
      const panel = panelRef.current;
      if (!panel) return;
      setPos((current) =>
        current
          ? {
              x: Math.max(0, Math.min(current.x, window.innerWidth - panel.offsetWidth)),
              y: Math.max(0, Math.min(current.y, window.innerHeight - panel.offsetHeight)),
            }
          : null,
      );
    };
    // Coalesce the flurry of `resize` events during a live OS window-resize drag
    // into one clamp per frame (matching the rAF pattern used by the pointer
    // drag/resize handlers), so the tool browser doesn't re-render every tick.
    let raf = 0;
    const onResize = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        clampToViewport();
      });
    };
    clampToViewport();
    window.addEventListener("resize", onResize);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  // The non-modal panel no longer gets Radix's focus management, so move focus
  // into it on open (it carries role="dialog", so a screen reader announces it),
  // and best-effort restore focus to the opener on close. The focus is deferred
  // two frames: the panel is opened from a Radix menu that restores focus to its
  // trigger as it closes, so a single frame would be stolen back.
  const previousFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => panelRef.current?.focus());
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
      // Only if the opener is still around; otherwise focus falls to the document.
      const prev = previousFocusRef.current;
      if (prev?.isConnected) prev.focus();
    };
  }, [open]);
  const importedJobIdRef = useRef<string | null>(null);
  // The selected tool's row in the left list, so a preselection arriving from the
  // Processing menu can be scrolled into view (it may sit far down the catalog).
  const selectedButtonRef = useRef<HTMLButtonElement>(null);
  // A tool id queued from the Processing menu, applied once the catalog finishes
  // loading (see the apply effect below). `wasLoadingRef` tracks whether a load
  // has actually started, so the apply only fires on a true -> false transition.
  const pendingInitialToolRef = useRef<string | null>(null);
  const wasLoadingRef = useRef(false);
  // History trackers per dispatched job id (#1292). Entries stay after finish
  // (finish is idempotent) so async output imports can still report layers;
  // the map is capped (oldest evicted, Map preserves insertion order) so a
  // long batch session cannot grow it without bound.
  const historyTrackersRef = useRef<Map<string, ProcessingRunTracker>>(new Map());
  // Bytes of input files the user browsed from disk (web build, where the
  // browser cannot expose a real path). Keyed by parameter name; consumed by
  // the in-browser WASM runner. GeoJSON files are parsed up front so vector
  // tools receive a FeatureCollection, matching the layer-input path.
  const browsedInputsRef = useRef<
    Map<string, { name: string; bytes: Uint8Array; geojson?: FeatureCollection }>
  >(new Map());
  // Parameters passed to each run, keyed by the resulting job id, so output
  // naming can honor the output path the user actually typed (which the finished
  // job does not carry). Keyed per job (not a single slot) so a rapid re-run
  // cannot overwrite the entry a still-draining previous job is reading; the
  // entry is deleted once its outputs are imported.
  const runParametersByJobRef = useRef<Map<string, Record<string, unknown>>>(new Map());

  const selectedTool = useMemo(() => {
    const tool = tools.find((item) => item.id === selectedToolId) ?? tools[0] ?? null;
    // Drop `*args`/`**kwargs` params defensively: some upstream tools expose
    // Python varargs that render as unusable inputs. The bundled catalog already
    // strips these, but the live sidecar catalog may not.
    if (!tool?.params?.some((param) => param.name?.startsWith("*"))) return tool;
    return {
      ...tool,
      params: tool.params.filter((param) => !param.name?.startsWith("*")),
    };
  }, [selectedToolId, tools]);

  // Whether any GeoLibre-authored tools are present (WASM mode), gating the
  // source filter — pointless when every tool is from Whitebox.
  const hasGeolibreTools = useMemo(() => tools.some((tool) => tool.source === "geolibre"), [tools]);

  // Ignore the source filter when no GeoLibre tools are present (e.g. sidecar
  // mode), so a stale "geolibre" selection can't empty the whole list.
  const matchesSource = useCallback(
    (tool: WhiteboxTool) => {
      if (source === "All" || !hasGeolibreTools) return true;
      return (tool.source === "geolibre" ? "geolibre" : "whitebox") === source;
    },
    [source, hasGeolibreTools],
  );

  // Total tool count per source, for the source-filter labels.
  const sourceCounts = useMemo(() => {
    const geolibre = tools.filter((tool) => tool.source === "geolibre").length;
    return { all: tools.length, geolibre, whitebox: tools.length - geolibre };
  }, [tools]);

  // Category options labelled with the number of tools in each (within the
  // active source filter), e.g. "Conversion (37)".
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    let total = 0;
    for (const tool of tools) {
      if (!matchesSource(tool)) continue;
      total += 1;
      const name = tool.category || "General";
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const sorted = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    return [
      { value: "All", label: `All (${total})` },
      ...sorted.map(([name, count]) => ({
        value: name,
        label: `${name} (${count})`,
      })),
    ];
  }, [tools, matchesSource]);

  const filteredTools = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return tools.filter((tool) => {
      if (category !== "All" && (tool.category || "General") !== category) {
        return false;
      }
      if (!matchesSource(tool)) return false;
      if (!normalizedQuery) return true;
      return [tool.id, toolLabel(tool), tool.category || "", tool.summary || ""]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery);
    });
  }, [category, matchesSource, query, tools]);

  const loadWhitebox = useCallback(async () => {
    setLoadingTools(true);
    setError(null);
    // Reset the source filter so a stale "geolibre" selection from a previous
    // mode doesn't silently hide tools after a reload / mode switch.
    setSource("All");
    // Drop the in-memory snapshot so a fresh load reflects upstream catalog
    // changes; calls within this load still dedup once it is repopulated.
    clearRemoteWhiteboxCatalogSnapshotCache();

    const applyRemoteCatalogSnapshot = async (message: string, available: boolean) => {
      try {
        // Hide locked ("pro"-tier) tools: they cannot run, so omit them from the
        // catalog entirely rather than show them as disabled rows.
        const snapshotTools = (await fetchRemoteWhiteboxCatalogSnapshot()).filter(
          (tool) => !tool.locked,
        );
        setRuntimeAvailable(available);
        setRuntimeMessage(message);
        setTools(snapshotTools);
        setSelectedToolId((current) =>
          snapshotTools.some((tool) => tool.id === current)
            ? current
            : (snapshotTools[0]?.id ?? ""),
        );
      } catch (err) {
        setRuntimeAvailable(available);
        setRuntimeMessage(message);
        setTools([]);
        setSelectedToolId("");
        setError(err instanceof Error ? err.message : "Could not load Whitebox catalog snapshot.");
      }
    };

    // In WASM mode the tools run in-browser, so skip the Python sidecar probe
    // entirely (on the web build that request 404s to the SPA index.html, which
    // is the "Unexpected token '<'" JSON error). Load the catalog for the tool
    // list + display metadata, then let the WASM binary's own manifests be
    // authoritative for parameters: the local tools can expose a different
    // parameter set than the sidecar (e.g. reproject_vector validates `epsg`,
    // not the catalog's `dst_epsg`, #1047), and they add the GeoLibre-authored
    // tools (write_geoparquet, delineate_depressions, …) absent from the catalog.
    if (runLocal) {
      setRuntimeAvailable(false);
      setRuntimeMessage(t("processing.whitebox.runningLocally"));
      // The catalog snapshot (HTTP/bundled asset) and the WASM manifest
      // enumeration (loads + queries the WASM module) are independent, so fetch
      // them concurrently rather than serially.
      const [catalogResult, wasmResult] = await Promise.allSettled([
        fetchRemoteWhiteboxCatalogSnapshot(),
        listWasmToolManifests(),
      ]);
      // Hide locked ("pro"-tier) tools: they cannot run, so omit them from the
      // catalog entirely rather than show them as disabled rows.
      const catalogTools =
        catalogResult.status === "fulfilled"
          ? catalogResult.value.filter((tool) => !tool.locked)
          : [];
      const catalogError = catalogResult.status === "rejected" ? catalogResult.reason : null;
      // A snapshot that resolves to an empty list (malformed/empty JSON that
      // doesn't throw) silently drops the ~700 Whitebox tools. Detect it from
      // the raw result, not `catalogTools`, so a fetch that returned only locked
      // tools isn't mistaken for a load failure.
      const catalogEmpty = catalogResult.status === "fulfilled" && catalogResult.value.length === 0;
      const wasmTools = wasmResult.status === "fulfilled" ? wasmResult.value : [];
      const wasmError = wasmResult.status === "rejected" ? wasmResult.reason : null;
      if (wasmError) {
        console.warn("[GeoLibre] Could not enumerate WASM tool manifests:", wasmError);
      }
      if (catalogError) {
        console.warn("[GeoLibre] Could not load Whitebox catalog snapshot:", catalogError);
      }
      const nextTools = mergeWasmToolManifests(catalogTools, wasmTools);
      setTools(nextTools);
      setSelectedToolId((current) =>
        nextTools.some((tool) => tool.id === current) ? current : (nextTools[0]?.id ?? ""),
      );
      // In local mode the WASM runner is what actually executes tools, so its
      // failure is the most important to report: without it every tool keeps the
      // catalog's parameter names and would fail on run (exactly #1047). Failing
      // that, surface a catalog-fetch failure even when the WASM manifests still
      // yielded a few GeoLibre-authored tools, so the user is not silently left
      // without the ~700 Whitebox catalog tools.
      if (wasmError) {
        setError(t("processing.whitebox.localRunnerError"));
      } else if (catalogError) {
        setError(
          catalogError instanceof Error
            ? catalogError.message
            : t("processing.whitebox.catalogSnapshotError"),
        );
      } else if (catalogEmpty || nextTools.length === 0) {
        setError(t("processing.whitebox.catalogSnapshotError"));
      }
      setLoadingTools(false);
      return;
    }

    try {
      const status = await fetchWhiteboxStatus();
      setRuntimeAvailable(status.available);
      setRuntimeMessage(status.message);
      if (!status.available) {
        await applyRemoteCatalogSnapshot(`${status.message} Showing GitHub catalog only.`, false);
        return;
      }
      let nextTools: WhiteboxTool[];
      try {
        nextTools = await fetchWhiteboxTools();
      } catch (err) {
        await applyRemoteCatalogSnapshot(
          `${
            err instanceof Error ? err.message : "Could not load live catalog."
          } Showing GitHub catalog only.`,
          true,
        );
        return;
      }
      if (nextTools.length === 0) {
        await applyRemoteCatalogSnapshot(
          "Live catalog is empty. Showing GitHub catalog only.",
          true,
        );
        return;
      }
      try {
        const snapshotTools = await fetchRemoteWhiteboxCatalogSnapshot();
        nextTools = mergeCatalogParameterFallbacks(nextTools, snapshotTools);
      } catch {
        // Keep the live catalog when the optional parameter fallback is unavailable.
      }
      // Hide locked ("pro"-tier) tools: they cannot run, so omit them entirely.
      const freeTools = nextTools.filter((tool) => !tool.locked);
      setTools(freeTools);
      setSelectedToolId((current) =>
        freeTools.some((tool) => tool.id === current) ? current : (freeTools[0]?.id ?? ""),
      );
    } catch (err) {
      setRuntimeAvailable(false);
      await applyRemoteCatalogSnapshot(
        `${
          err instanceof Error ? err.message : "Could not connect to sidecar."
        } Showing GitHub catalog only.`,
        false,
      );
    } finally {
      setLoadingTools(false);
    }
  }, [runLocal, t]);

  useEffect(() => {
    if (!open) return;
    void loadWhitebox();
  }, [loadWhitebox, open]);

  // When the dialog is opened from a Processing-menu category submenu, the store
  // carries the chosen tool id. Stash it in a ref and clear the filters that
  // could hide it; the apply effect below selects it once the catalog is loaded.
  // We can't select eagerly here: the catalog loads async, and a GeoLibre WASM
  // tool is appended only after the Whitebox snapshot, whose loader resets the
  // selection to its first tool whenever the pending id is not (yet) present.
  useEffect(() => {
    if (!open || !processingInitialTool) return;
    pendingInitialToolRef.current = processingInitialTool;
    setProcessingInitialTool(null);
    setCategory("All");
    setSource("All");
    setQuery("");
  }, [open, processingInitialTool, setProcessingInitialTool]);

  // Apply the pending preselection once a catalog load completes (loadingTools
  // goes true -> false), when `tools` is final and includes the async GeoLibre
  // WASM tools. Keying on the transition avoids firing on the first render, when
  // loadingTools is still false only because the load has not started yet.
  useEffect(() => {
    if (loadingTools) {
      wasLoadingRef.current = true;
      return;
    }
    if (!wasLoadingRef.current) return;
    wasLoadingRef.current = false;
    const pending = pendingInitialToolRef.current;
    if (!pending) return;
    pendingInitialToolRef.current = null;
    if (tools.some((tool) => tool.id === pending)) {
      setSelectedToolId(pending);
    }
  }, [loadingTools, tools]);

  // Keep the highlighted row visible: when the selection changes (e.g. a tool
  // preselected from the menu lands deep in the catalog), scroll its list row
  // into view. "nearest" leaves an already-visible row untouched.
  useEffect(() => {
    if (loadingTools) return;
    selectedButtonRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedToolId, loadingTools, filteredTools]);

  useEffect(() => {
    setValues(createDefaultValues(selectedTool));
    // Drop any browsed input bytes from the previous tool so they cannot be
    // silently reused by a same-named parameter on the new tool.
    browsedInputsRef.current.clear();
    setJob(null);
    importedJobIdRef.current = null;
  }, [selectedTool?.id]);

  // Pre-fill from a pending History re-run (#1292). If the requested tool is
  // not selected yet, select it once the catalog holds it (the initial-tool
  // stash above covers the not-yet-loaded case); once selected, overlay the
  // recorded values on the tool's defaults. Declared after the values-reset
  // effect above so the recorded values win when both fire in the same commit.
  useEffect(() => {
    if (!open || !rerun || rerun.kind !== "whitebox") return;
    if (selectedTool?.id !== rerun.toolId) {
      if (!loadingTools && tools.length > 0) {
        if (tools.some((tool) => tool.id === rerun.toolId)) {
          setSelectedToolId(rerun.toolId);
        } else {
          // A saved-project history entry can reference a tool the current
          // Whitebox catalog no longer ships (e.g. after a geolibre-wasm
          // rename); drop the request instead of leaving it pending forever.
          setError(t("processing.history.toolUnavailable", { toolId: rerun.toolId }));
          setProcessingRerun(null);
        }
      }
      return;
    }
    setValues({
      ...createDefaultValues(selectedTool),
      ...(rerun.parameters as ParameterValues),
    });
    setProcessingRerun(null);
  }, [open, rerun, selectedTool, loadingTools, tools, setProcessingRerun, t]);

  // Drop an unconsumed whitebox re-run when the dialog closes (e.g. the
  // catalog failed to load, so the effect above never matched), so a stale
  // pre-fill cannot suddenly apply on a later open.
  useEffect(() => {
    if (open) return;
    if (useAppStore.getState().ui.processingRerun?.kind === "whitebox") {
      setProcessingRerun(null);
    }
  }, [open, setProcessingRerun]);

  useEffect(() => {
    if (!job || !RUNNING_JOB_STATUSES.has(job.status)) return;
    // Schedule the next poll only after the current request resolves so a slow
    // sidecar cannot accumulate overlapping, out-of-order in-flight requests.
    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      try {
        const next = await fetchWhiteboxJob(job.id);
        if (cancelled) return;
        setJob(next);
        if (RUNNING_JOB_STATUSES.has(next.status)) {
          window.setTimeout(poll, 1000);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not poll job.");
        }
      }
    };
    const timer = window.setTimeout(poll, 1000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [job]);

  // Record a History entry once a job reaches a terminal status (#1292). WASM
  // jobs arrive terminal on dispatch; sidecar jobs get here via polling.
  // `finish` is idempotent, so re-renders with the same terminal job are no-ops.
  useEffect(() => {
    if (!job || RUNNING_JOB_STATUSES.has(job.status)) return;
    historyTrackersRef.current
      .get(job.id)
      ?.finish(job.status === "succeeded" ? "success" : "error", job.error ?? undefined);
  }, [job]);

  const updateValue = (name: string, value: unknown) => {
    // Any manual change (typing a path, picking a layer) invalidates a
    // previously browsed file's bytes for this parameter.
    browsedInputsRef.current.delete(name);
    setValues((prev) => ({ ...prev, [name]: value }));
  };

  // Fill a subset extractor's `url` (and the companion fields it needs to run:
  // WMS layers/styles, XYZ tile_size/subdomains) from a loaded raster layer
  // (GeoLibre#1271), so a COG/WMS/XYZ added to the map can be subset without
  // retyping its url. A COG's local `input` is cleared in the same gesture since
  // the extractor takes exactly one source, and a url makes it a byte-range read
  // instead of a full download.
  const handlePopulateSubsetUrl = (layer: GeoLibreLayer) => {
    if (!selectedTool) return;
    const fields = subsetUrlFieldValues(selectedTool.id, layer);
    if (!fields) return;
    // Reset every companion field this populate can set back to the tool
    // default first, so a previously picked layer's optional values (a WMS
    // `styles`, an XYZ `subdomains`/`tile_size`) don't linger when the new layer
    // omits them and skew the extraction. `fields` is spread after, so the new
    // layer's present values win.
    const defaults = createDefaultValues(selectedTool);
    const kind = subsetUrlToolKind(selectedTool.id);
    const companionReset: ParameterValues =
      kind === "wms"
        ? { styles: defaults.styles }
        : kind === "xyz"
          ? { tile_size: defaults.tile_size, subdomains: defaults.subdomains }
          : {};
    const hasInput = selectedTool.params?.some((param) => param.name === "input");
    setValues((prev) => ({
      ...prev,
      ...(hasInput ? { input: "" } : {}),
      ...companionReset,
      ...fields,
    }));
    for (const name of Object.keys(companionReset)) {
      browsedInputsRef.current.delete(name);
    }
    for (const name of Object.keys(fields)) browsedInputsRef.current.delete(name);
    if (hasInput) browsedInputsRef.current.delete("input");
    setError(null);
  };

  // Fill a subset tool's `bbox` (and companion `bbox_crs`) from the current map
  // view (GeoLibre#1213). The map reads in EPSG:4326, so the bbox is written as
  // WGS84 `west,south,east,north` and the CRS is set to 4326 in the same gesture
  // to keep the pair consistent (a stale `bbox_crs` would misread the extent).
  // Validate a WGS84 box and write it into the `bbox`/`bbox_crs` fields. Shared
  // by "Use map extent" (current view) and "Draw on map" (rubber-band). Rejects
  // an unnormalized box - a view/box wrapping 180° yields west >= east, and at
  // low zoom (multiple world copies) getBounds() corners can fall outside
  // ±180°/±90° while still ordered - which the subset extractors mis-clip or
  // reject, matching RasterSubsetPanel.parseBbox's ordering + range checks.
  const applyBboxExtent = (bounds: [number, number, number, number] | undefined): void => {
    setError(null);
    if (!bounds) {
      setError(t("processing.whitebox.mapExtentUnavailable"));
      return;
    }
    const [west, south, east, north] = bounds;
    if (
      !(west < east) ||
      !(south < north) ||
      west < -180 ||
      east > 180 ||
      south < -90 ||
      north > 90
    ) {
      setError(t("processing.whitebox.mapExtentInvalid"));
      return;
    }
    const fmt = (value: number) => Number(value.toFixed(6)).toString();
    updateValue("bbox", bounds.map(fmt).join(","));
    // Store as a string to match the file's convention that every int/double
    // field value is a string (NumberStepperInput always emits one).
    updateValue("bbox_crs", String(4326));
  };

  const handleUseMapExtent = () => {
    // Cancel any in-flight draw so its late-resolving box can't overwrite the
    // extent the user just asked for from the current view.
    drawAbortRef.current?.abort();
    applyBboxExtent(mapControllerRef.current?.readView().bbox);
  };

  // Rubber-band a box on the map to fill the bbox (only workable because the
  // panel is now non-modal). Reuses the print-extent draw helper, which suspends
  // pan/zoom during the drag and handles Escape/blur. We draw our own SVG preview
  // (drawBox: false + onPreview) so the box sits above an interleaved deck.gl
  // raster instead of being occluded by it. Toggling the button (or closing the
  // panel) aborts an in-flight draw.
  const handleDrawBbox = async () => {
    const map = mapControllerRef.current?.getMap();
    if (!map) {
      setError(t("processing.whitebox.mapExtentUnavailable"));
      return;
    }
    if (drawing) {
      drawAbortRef.current?.abort();
      return;
    }
    setError(null);
    const controller = new AbortController();
    drawAbortRef.current = controller;
    setDrawing(true);
    try {
      const extent = await drawPrintExtent(map, {
        signal: controller.signal,
        drawBox: false,
        // Project the box corners to viewport space (map.project is canvas-
        // relative, so add the canvas offset). The map is pan/zoom-locked during
        // the draw, so corners only move as the box is dragged.
        onPreview: (box) => {
          if (!box) {
            setDrawPoints(null);
            return;
          }
          const rect = map.getCanvas().getBoundingClientRect();
          const [w, s, e, n] = box;
          const corners: [number, number][] = [
            [w, n],
            [e, n],
            [e, s],
            [w, s],
          ];
          setDrawPoints(
            corners.map(([lng, lat]) => {
              const p = map.project([lng, lat]);
              return { x: p.x + rect.left, y: p.y + rect.top };
            }),
          );
        },
      });
      if (controller.signal.aborted) return;
      if (extent) applyBboxExtent(extent);
    } finally {
      clearPrintExtent(map);
      setDrawPoints(null);
      if (drawAbortRef.current === controller) {
        drawAbortRef.current = null;
        setDrawing(false);
      }
    }
  };

  // Abort an in-flight draw when the panel closes or the component unmounts, so
  // the map isn't left in draw mode after the panel is gone.
  useEffect(() => {
    if (open) return;
    drawAbortRef.current?.abort();
  }, [open]);
  useEffect(() => () => drawAbortRef.current?.abort(), []);
  // Abort an in-flight draw when the selected tool changes: `values` is reset to
  // the new tool's defaults on that change, so a box that resolves after the
  // switch would otherwise fill the wrong tool's bbox field.
  useEffect(() => {
    drawAbortRef.current?.abort();
  }, [selectedToolId]);

  const handleRunLocalChange = (nextRunLocal: boolean) => {
    setRunLocal(nextRunLocal);
    // A `vector_out` param holds an output-format string in WASM mode but a
    // free-text path in sidecar mode, and the form only resets on tool change.
    // Turning WASM mode off would otherwise leave a format like "geoparquet" as
    // the sidecar output path, so reset any such param to its default.
    if (nextRunLocal || !selectedTool) return;
    const defaults = createDefaultValues(selectedTool);
    setValues((prev) => {
      const next = { ...prev };
      for (const param of selectedTool.params ?? []) {
        const current = prev[param.name];
        if (
          parameterKind(param) === "vector_out" &&
          typeof current === "string" &&
          normalizeVectorOutputFormat(current) === current
        ) {
          next[param.name] = defaults[param.name];
        }
      }
      return next;
    });
  };

  // Stash a browsed input file's bytes and show its name in the field. Used by
  // the path-browse button in the web build, where the WASM runner reads bytes
  // directly instead of a (non-existent in the browser) filesystem path.
  const handlePickInputFile = useCallback(
    (paramName: string, fileName: string, bytes: Uint8Array) => {
      let geojson: FeatureCollection | undefined;
      if (/\.(geojson|json)$/i.test(fileName)) {
        try {
          const parsed = JSON.parse(new TextDecoder().decode(bytes));
          if (isFeatureCollection(parsed)) geojson = parsed;
        } catch {
          // not valid JSON; fall back to raw bytes
        }
      }
      browsedInputsRef.current.set(paramName, { name: fileName, bytes, geojson });
      setValues((prev) => ({ ...prev, [paramName]: fileName }));
    },
    [],
  );

  const importGeoJsonOutputs = useCallback(
    async (nextJob: WhiteboxJob) => {
      if (importedJobIdRef.current === nextJob.id) return;
      importedJobIdRef.current = nextJob.id;
      // The sidecar returns output paths (fetched over HTTP); the WASM runner
      // returns the GeoJSON inline. Handle both: keep inline FeatureCollections,
      // else keep JSON output paths to fetch.
      const entries = Object.entries(nextJob.outputs).filter(([, value]) => {
        if (isFeatureCollection(value)) return true;
        const path = outputPath(value);
        return Boolean(path && isJsonOutputPath(path));
      });
      // Resolve the producing tool from the job itself, not the live
      // `selectedTool`, so switching tools while a job finishes does not
      // mislabel the imported layer.
      const jobTool = tools.find((item) => item.id === nextJob.tool_id);
      const jobToolLabel = jobTool ? toolLabel(jobTool) : humanize(nextJob.tool_id);
      // This job's own run parameters (not a shared slot), consumed once here so a
      // concurrent re-run cannot repoint the output-path lookup below.
      const runParameters = runParametersByJobRef.current.get(nextJob.id) ?? {};
      runParametersByJobRef.current.delete(nextJob.id);
      for (const [name, value] of entries) {
        const path = isFeatureCollection(value) ? "" : (outputPath(value) ?? "");
        const data = isFeatureCollection(value) ? value : await fetchWhiteboxJsonOutput(path);
        if (!isFeatureCollection(data)) continue;
        const layerName = `${jobToolLabel} ${humanize(name)}`;
        const layerId = addGeoJsonLayer(layerName, data, path || undefined);
        historyTrackersRef.current.get(nextJob.id)?.addOutputLayer(layerName);
        const layer = useAppStore.getState().layers.find((item) => item.id === layerId);
        if (layer) mapControllerRef.current?.fitLayer(layer);
      }

      // Binary outputs come back from the WASM runner inline. Raster (COG) bytes
      // become a new raster layer; a `file_out` (e.g. write_geoparquet .parquet,
      // a rendered .png, a .pmtiles) or a CRS-preserving `vector_out`
      // (GeoParquet/FlatGeobuf/zipped Shapefile, chosen to keep a reprojection's
      // target CRS) is not a GeoTIFF, so download it instead of handing it to the
      // raster loader.
      for (const [name, value] of Object.entries(nextJob.outputs)) {
        if (!(value instanceof Uint8Array)) continue;
        const param = jobTool?.params?.find((item) => item.name === name);
        const outKind = param ? parameterKind(param) : "";
        if (outKind === "file_out" || outKind === "vector_out") {
          const label = `${jobToolLabel} ${humanize(name)}`.replace(/\s+/g, "_");
          // Prefer the content signature: a `vector_out` and most binary
          // `file_out` formats (GeoParquet/FlatGeobuf/zipped Shapefile/PNG/
          // PMTiles) are identifiable from their magic bytes. Only signature-less
          // text formats (CSV/JSON/HTML) return `bin`; for those, fall back to
          // the extension the tool was actually told to write — the user's typed
          // output path, else the param's declared format (shared with the WASM
          // runner via `fileOutputTargetExtension`).
          const sniffed = fileOutputExtension(value);
          const extension =
            sniffed !== "bin" || outKind !== "file_out" || !param
              ? sniffed
              : fileOutputTargetExtension(param, runParameters[name]);
          downloadBytes(value, `${label}.${extension}`);
        } else if (onAddRaster) {
          // Display name stays human-readable; the file name matches the actual
          // WASM output path (e.g. fill_depressions_wang_and_liu_output.tif), so
          // the layer's sourcePath lines up with the path shown in the panel.
          const rasterName = `${jobToolLabel} ${humanize(name)}`;
          await onAddRaster(value, rasterName, `${outputBaseName(nextJob.tool_id, name)}.tif`);
          historyTrackersRef.current.get(nextJob.id)?.addOutputLayer(rasterName);
        }
      }
    },
    [addGeoJsonLayer, mapControllerRef, onAddRaster, tools],
  );

  useEffect(() => {
    if (job?.status !== "succeeded") return;
    void importGeoJsonOutputs(job).catch((err) => {
      setError(err instanceof Error ? err.message : "Could not import Whitebox output.");
    });
  }, [importGeoJsonOutputs, job]);

  const runSelectedTool = async () => {
    if (!selectedTool || selectedTool.locked) return;
    setError(null);
    importedJobIdRef.current = null;
    // Flag "running" before any prep so the Run button shows its busy state
    // immediately (input fetching can take a moment, and the local WASM run then
    // blocks the main thread).
    setRunningLocal(true);
    const parameters: Record<string, unknown> = {};
    const layerInputs: Record<string, WhiteboxLayerInput> = {};

    for (const param of selectedTool.params ?? []) {
      const value = values[param.name];
      if (
        param.required &&
        !isOutputParameter(param) &&
        (value === undefined || value === null || value === "")
      ) {
        setError(`Missing required parameter: ${parameterLabel(param)}`);
        setRunningLocal(false);
        return;
      }

      // A file browsed from disk in the web build: feed its bytes (or parsed
      // GeoJSON) straight to the WASM runner instead of an unresolvable path.
      const browsed = browsedInputsRef.current.get(param.name);
      if (browsed && isDataInputParameter(param)) {
        const kind = parameterKind(param);
        layerInputs[param.name] = browsed.geojson
          ? { name: browsed.name, kind, geojson: browsed.geojson }
          : { name: browsed.name, kind, bytes: browsed.bytes };
        continue;
      }

      if (typeof value === "string" && value.startsWith(LAYER_TOKEN_PREFIX)) {
        const layerId = value.slice(LAYER_TOKEN_PREFIX.length);
        const layer = layers.find((item) => item.id === layerId);
        if (!layer) continue;
        const kind = parameterKind(param);
        if (layer.geojson && kind === "vector_in") {
          layerInputs[param.name] = {
            name: layer.name,
            kind,
            geojson: layer.geojson,
          };
        } else if (runLocal && (kind === "raster_in" || kind === "lidar_in")) {
          // WASM runs in-browser: pass the layer's actual bytes (fetched here),
          // not a path. When the bytes are not fetchable in the browser (e.g. a
          // desktop file path), fall back to the path: the WASM runner tries to
          // fetch it as a URL and, failing that, surfaces a clear "data is not
          // fetchable here; turn off Run locally" error (see wasm-client.ts).
          const bytes = await fetchLayerBytes(layer);
          if (bytes) {
            layerInputs[param.name] = { name: layer.name, kind, bytes };
          } else {
            parameters[param.name] = layerPath(layer);
          }
        } else {
          parameters[param.name] = layerPath(layer);
        }
      } else {
        parameters[param.name] = value;
      }
    }

    // In WASM mode a vector_out param carries the chosen output format (its value
    // is otherwise unused by the runner). A CRS-preserving format keeps a
    // reprojection's target CRS and comes back as a downloadable file.
    const vectorOut = runLocal
      ? (selectedTool.params ?? []).find((item) => parameterKind(item) === "vector_out")
      : undefined;
    const vectorOutValue = vectorOut ? values[vectorOut.name] : undefined;
    // Validate against the known formats: a stale sidecar-mode output path left
    // in the form state (the form only resets on tool change) would otherwise be
    // cast to a bogus format and produce a `..._output.undefined` filename.
    const vectorOutputFormat = normalizeVectorOutputFormat(vectorOutValue);

    // Track the run for the Processing History panel (#1292). The raw form
    // values (with `layer:` tokens) are recorded, not the resolved request
    // parameters, so Edit & re-run can restore the form exactly.
    const tracker = beginProcessingRun({
      kind: "whitebox",
      toolId: selectedTool.id,
      toolName: toolLabel(selectedTool),
      engine: runLocal ? "wasm" : "sidecar",
      parameters: { ...values },
    });
    try {
      const request = {
        tool_id: selectedTool.id,
        parameters,
        tool: selectedTool,
        layer_inputs: layerInputs,
        include_pro: false,
        tier: "open",
        vector_output_format: vectorOutputFormat,
      };
      // The local WASM runner executes synchronously on the main thread, so yield
      // twice to the browser first: this lets React commit and paint the Run
      // button's busy state before the run blocks rendering.
      if (runLocal) {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }
      const nextJob = await (runLocal ? runWhiteboxToolWasm(request) : runWhiteboxTool(request));
      // Record this run's parameters against its job id so output-download naming
      // can later recover the output path the user typed (the job omits it). Only
      // the WASM runner returns inline binary outputs that need this; the sidecar
      // returns fetchable paths. `succeeded` is terminal for WASM, so a failed run
      // adds nothing to clean up.
      if (runLocal && nextJob.status === "succeeded") {
        runParametersByJobRef.current.set(nextJob.id, parameters);
      }
      historyTrackersRef.current.set(nextJob.id, tracker);
      while (historyTrackersRef.current.size > MAX_TRACKED_HISTORY_JOBS) {
        const oldest = historyTrackersRef.current.keys().next().value;
        if (oldest === undefined) break;
        historyTrackersRef.current.delete(oldest);
      }
      setJob(nextJob);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not start Whitebox tool.";
      tracker.finish("error", message);
      setError(message);
    } finally {
      setRunningLocal(false);
    }
  };

  const startServer = async () => {
    setStartingServer(true);
    setError(null);
    try {
      await startGeoLibreSidecar();
      await loadWhitebox();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start GeoLibre sidecar.");
    } finally {
      setStartingServer(false);
    }
  };

  const stopServer = async () => {
    setStoppingServer(true);
    setError(null);
    try {
      await stopGeoLibreSidecar();
      setRuntimeAvailable(false);
      setRuntimeMessage("GeoLibre sidecar is stopped. Showing GitHub catalog only.");
      setJob(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not stop GeoLibre sidecar.");
    } finally {
      setStoppingServer(false);
    }
  };

  const running = runningLocal || Boolean(job && RUNNING_JOB_STATUSES.has(job.status));
  const serverBusy = loadingTools || startingServer || stoppingServer;

  if (!open) return null;

  return (
    <div
      ref={panelRef}
      role="dialog"
      tabIndex={-1}
      aria-labelledby="whitebox-toolbox-title"
      aria-modal={false}
      style={{
        // Inline width/height (once resized) override the responsive w-/h- classes.
        ...(pos ? { left: pos.x, top: pos.y } : null),
        ...(size ? { width: size.w, height: size.h } : null),
      }}
      className={cn(
        // Height leaves room for the top offset (top-16) plus a bottom margin so
        // the whole panel - including the bottom-right resize grip - stays on
        // screen at small viewport heights.
        "fixed z-40 flex h-[min(760px,calc(100vh-6rem))] w-[min(72rem,95vw)] flex-col overflow-hidden rounded-lg border bg-background shadow-xl",
        pos ? "" : "left-1/2 top-16 -translate-x-1/2",
      )}
    >
      {/* Draw-bbox preview, portaled to <body> as a viewport-space SVG overlay
          so it sits above an interleaved deck.gl raster (which occludes MapLibre
          layers) and escapes the panel's own transform/overflow. Non-interactive
          so it never blocks the drag on the map below. */}
      {drawPoints
        ? createPortal(
            <svg
              className="pointer-events-none fixed inset-0 z-30 h-full w-full"
              aria-hidden="true"
            >
              <polygon
                points={drawPoints.map((p) => `${p.x},${p.y}`).join(" ")}
                style={{
                  fill: "hsl(var(--primary))",
                  stroke: "hsl(var(--primary))",
                }}
                fillOpacity={0.12}
                strokeWidth={2}
                strokeDasharray="6 3"
              />
            </svg>,
            document.body,
          )
        : null}
      {/* Draggable title bar (replaces the Radix modal header) so the map stays
          interactive underneath the panel. */}
      <div
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        className="flex cursor-move touch-none select-none items-start justify-between gap-3 border-b px-5 py-3"
      >
        <div className="flex min-w-0 items-start gap-2">
          <GripHorizontal
            className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <h2
              id="whitebox-toolbox-title"
              className="text-lg font-semibold leading-none tracking-tight"
            >
              {t("processing.whitebox.toolbox")}
            </h2>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {runtimeAvailable === null
                ? t("processing.whitebox.checkingRuntime")
                : runtimeAvailable
                  ? runtimeMessage ||
                    t("processing.whitebox.toolsAvailable", {
                      count: tools.length,
                    })
                  : runtimeMessage || t("processing.whitebox.runtimeUnavailable")}
            </p>
          </div>
        </div>
        <button
          type="button"
          aria-label={t("common.close")}
          onClick={() => setProcessingOpen(false)}
          className="rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(260px,320px)_minmax(0,1fr)] gap-4 overflow-hidden p-5">
        <div className="flex min-h-0 flex-col gap-3 border-e pe-4">
          <div className="flex gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="ps-9"
                placeholder={t("processing.searchTools")}
              />
            </div>
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={loadWhitebox}
              disabled={serverBusy}
              title={t("processing.refreshCatalog")}
            >
              <RefreshCw className={cn("h-4 w-4", loadingTools && "animate-spin")} />
            </Button>
          </div>

          {/* The processing server is a local Python process that only the
              desktop app can spawn or stop. In the browser these buttons
              would always fail, and a same-origin sidecar (when deployed) is
              auto-detected without them, so gate both on the desktop build. */}
          {desktop && runtimeAvailable !== true && (
            <Button type="button" variant="outline" onClick={startServer} disabled={serverBusy}>
              {startingServer ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Server className="h-4 w-4" />
              )}
              Start server
            </Button>
          )}

          {desktop && runtimeAvailable === true && (
            <Button
              type="button"
              variant="outline"
              onClick={stopServer}
              disabled={serverBusy || running}
            >
              {stoppingServer ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ServerOff className="h-4 w-4" />
              )}
              Stop server
            </Button>
          )}

          <Select value={category} onChange={(e) => setCategory(e.target.value)}>
            {categories.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </Select>

          {hasGeolibreTools && (
            <Select
              value={source}
              // Reset the category too: a category with no tools in the newly
              // chosen source would otherwise leave the list empty.
              onChange={(e) => {
                setSource(e.target.value);
                setCategory("All");
              }}
              aria-label={t("processing.whitebox.filterBySource")}
            >
              <option value="All">
                {t("processing.whitebox.allSources")} ({sourceCounts.all})
              </option>
              <option value="geolibre">
                {t("processing.whitebox.geolibreTools")} ({sourceCounts.geolibre})
              </option>
              <option value="whitebox">
                {t("processing.whitebox.whiteboxTools")} ({sourceCounts.whitebox})
              </option>
            </Select>
          )}

          <ScrollArea className="min-h-0 flex-1 rounded-md border">
            <div className="divide-y">
              {loadingTools ? (
                <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading
                </div>
              ) : filteredTools.length === 0 ? (
                <div className="p-3 text-sm text-muted-foreground">No tools found.</div>
              ) : (
                filteredTools.map((tool) => (
                  <button
                    key={tool.id}
                    type="button"
                    ref={selectedTool?.id === tool.id ? selectedButtonRef : undefined}
                    className={cn(
                      "block w-full px-3 py-2 text-start text-sm transition-colors hover:bg-accent",
                      selectedTool?.id === tool.id && "bg-accent",
                      tool.locked && "opacity-60",
                    )}
                    onClick={() => setSelectedToolId(tool.id)}
                  >
                    <span className="block truncate font-medium">
                      {tool.locked ? "[Locked] " : ""}
                      {toolLabel(tool)}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {tool.category || "General"}
                    </span>
                  </button>
                ))
              )}
            </div>
          </ScrollArea>
        </div>

        <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-3">
          <div className="min-w-0 border-b pb-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="truncate text-base font-semibold">
                  {selectedTool ? toolLabel(selectedTool) : "No tool selected"}
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {selectedTool?.id}
                  {selectedTool?.license_tier ? ` | ${selectedTool.license_tier}` : ""}
                </p>
              </div>
              <label
                className="flex items-center gap-1.5 text-xs text-muted-foreground"
                title={t("processing.whitebox.runLocalHint")}
              >
                <input
                  type="checkbox"
                  data-testid="whitebox-run-local"
                  checked={runLocal}
                  onChange={(e) => handleRunLocalChange(e.target.checked)}
                />
                {t("processing.whitebox.runLocal")}
              </label>
              <Button
                type="button"
                onClick={runSelectedTool}
                disabled={
                  !selectedTool ||
                  selectedTool.locked ||
                  running ||
                  (!runLocal && runtimeAvailable !== true)
                }
              >
                {running ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
                {running ? t("processing.whitebox.running") : t("processing.whitebox.run")}
              </Button>
            </div>
            {selectedTool?.summary && (
              <p className="mt-2 max-w-3xl text-sm text-muted-foreground">{selectedTool.summary}</p>
            )}
            {selectedTool?.locked && (
              <p className="mt-2 flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" />
                {selectedTool.locked_reason || "This tool is locked."}
              </p>
            )}
          </div>

          <ScrollArea className="min-h-0">
            <div className="grid gap-4 pb-2 pe-5">
              {(selectedTool?.params ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">This tool has no parameters.</p>
              ) : (
                selectedTool?.params?.map((param) => (
                  <ParameterField
                    key={param.name}
                    param={param}
                    layers={layers}
                    toolId={selectedTool.id}
                    runLocal={runLocal}
                    value={values[param.name]}
                    onChange={(value) => updateValue(param.name, value)}
                    onPickFile={(fileName, bytes) =>
                      handlePickInputFile(param.name, fileName, bytes)
                    }
                    onUseMapExtent={
                      isMapExtentParameter(selectedTool, param) ? handleUseMapExtent : undefined
                    }
                    onDrawMapExtent={
                      isMapExtentParameter(selectedTool, param) ? handleDrawBbox : undefined
                    }
                    drawingMapExtent={drawing}
                    onPopulateFromLayer={
                      isSubsetUrlParameter(selectedTool, param)
                        ? handlePopulateSubsetUrl
                        : undefined
                    }
                  />
                ))
              )}
            </div>
          </ScrollArea>

          <div className="grid gap-2 border-t pt-3">
            {/* Sidecar mode but the server is unreachable: show interactive
                troubleshooting with a one-click switch to the WASM runner.
                Otherwise fall back to a plain error line (e.g. a parameter or
                tool-run error that has nothing to do with the sidecar). */}
            {!runLocal && runtimeAvailable === false ? (
              <SidecarHelpBanner
                isDesktop={desktop}
                error={error}
                onRunLocally={() => {
                  // Clear the stale sidecar error in the same batch as the
                  // mode switch, so it cannot flash as a plain error line on
                  // the render before loadWhitebox resets it.
                  setError(null);
                  setRunLocal(true);
                }}
              />
            ) : (
              error && (
                <p className="flex items-center gap-2 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4" />
                  {error}
                </p>
              )
            )}
            {job && <JobOutputPanel job={job} />}
          </div>
        </div>
      </div>

      {/* Resize grip (bottom-right). The diagonal lines hint the affordance.
          Pointer-only, so it is presentational - there is no keyboard resize to
          expose to assistive tech. */}
      <div
        role="presentation"
        className="absolute bottom-0 right-0 h-4 w-4 cursor-se-resize touch-none"
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
      >
        <svg viewBox="0 0 10 10" className="h-full w-full text-muted-foreground" aria-hidden="true">
          <path d="M9 1 L1 9 M9 5 L5 9" stroke="currentColor" strokeWidth={1} fill="none" />
        </svg>
      </div>
    </div>
  );
}

function JobOutputPanel({ job }: { job: WhiteboxJob }) {
  const outputs = outputEntries(job.outputs);
  const hasMessages = job.messages.length > 0;
  const hasOutputs = outputs.length > 0;

  return (
    <div className="grid gap-2">
      <p className={cn("flex items-center gap-2 text-sm font-medium", jobStatusTone(job))}>
        {job.status === "succeeded" ? (
          <CheckCircle2 className="h-4 w-4" />
        ) : job.status === "failed" ? (
          <AlertCircle className="h-4 w-4" />
        ) : (
          <Loader2 className="h-4 w-4 animate-spin" />
        )}
        {job.status}
        {job.error ? `: ${job.error}` : ""}
      </p>
      <ScrollArea className="h-24 rounded-md border bg-muted/30 p-2 font-mono text-xs">
        {!hasMessages && !hasOutputs ? (
          <span className="text-muted-foreground">No output yet.</span>
        ) : null}
        {job.messages.map((line, index) => (
          <div key={`${index}-${line}`}>{line}</div>
        ))}
        {outputs.map(([name, path]) => (
          <div key={name}>{`${name}: ${path}`}</div>
        ))}
      </ScrollArea>
    </div>
  );
}

interface ParameterFieldProps {
  param: WhiteboxToolParameter;
  layers: GeoLibreLayer[];
  onChange: (value: unknown) => void;
  onPickFile?: (fileName: string, bytes: Uint8Array) => void;
  /** When set, renders a "Use map extent" button that fills this bbox field
   * (and its companion CRS) from the current map view. */
  onUseMapExtent?: () => void;
  /** When set, renders a "Draw on map" button that fills this bbox field by
   * rubber-banding a box on the map. */
  onDrawMapExtent?: () => void;
  /** Whether a draw is currently in progress (toggles the button's label/state). */
  drawingMapExtent?: boolean;
  /** When set, renders a "From layer" picker on this (`url`) field that fills it
   * (and any companion fields) from a compatible loaded raster layer. */
  onPopulateFromLayer?: (layer: GeoLibreLayer) => void;
  toolId: string;
  runLocal: boolean;
  value: unknown;
}

function ParameterField({
  param,
  layers,
  onChange,
  onPickFile,
  onUseMapExtent,
  onDrawMapExtent,
  drawingMapExtent,
  onPopulateFromLayer,
  toolId,
  runLocal,
  value,
}: ParameterFieldProps) {
  const { t } = useTranslation();
  const kind = parameterKind(param);
  const availableLayers = layers.filter((layer) => canUseLayerForParameter(layer, param));
  // Loaded layers that can fill this subset `url` field, only computed for the
  // url param the dialog wired `onPopulateFromLayer` to.
  const subsetUrlLayers = onPopulateFromLayer ? layersForSubsetUrl(toolId, layers) : [];
  const label = parameterLabel(param);
  const valueText = value === undefined || value === null ? "" : String(value);

  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={`whitebox-${param.name}`}>{label}</Label>
        <span className="shrink-0 text-xs text-muted-foreground">
          {kind}
          {param.required && !isOutputParameter(param) ? " | required" : ""}
        </span>
      </div>

      {kind === "bool" ? (
        <label className="flex h-9 items-center gap-2 rounded-md border px-3 text-sm">
          <input
            id={`whitebox-${param.name}`}
            type="checkbox"
            checked={Boolean(value)}
            onChange={(event) => onChange(event.target.checked)}
          />
          Enabled
        </label>
      ) : param.options?.length ? (
        <Select
          id={`whitebox-${param.name}`}
          value={valueText}
          onChange={(event) => onChange(event.target.value)}
        >
          {!param.required && <option value="">Default</option>}
          {param.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      ) : onUseMapExtent ? (
        // Checked before the path/data-input branches: once isMapExtentParameter
        // has identified this bbox field, the "Use map extent" affordance should
        // always win, even if the param's description happens to contain a word
        // (path/file/…) that isPathParameter's heuristic would otherwise match.
        <div className="grid gap-1.5">
          <Input
            id={`whitebox-${param.name}`}
            type="text"
            value={valueText}
            placeholder={t("processing.whitebox.mapExtentPlaceholder")}
            onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onUseMapExtent}>
              <Scan className="h-3.5 w-3.5" aria-hidden="true" />
              {t("processing.whitebox.useMapExtent")}
            </Button>
            {onDrawMapExtent ? (
              <Button
                type="button"
                variant={drawingMapExtent ? "secondary" : "outline"}
                size="sm"
                aria-pressed={drawingMapExtent}
                onClick={onDrawMapExtent}
              >
                <SquareDashed className="h-3.5 w-3.5" aria-hidden="true" />
                {drawingMapExtent
                  ? t("processing.whitebox.drawingBbox")
                  : t("processing.whitebox.drawBbox")}
              </Button>
            ) : null}
          </div>
          {drawingMapExtent ? (
            <p className="text-xs text-muted-foreground">{t("processing.whitebox.drawBboxHint")}</p>
          ) : null}
        </div>
      ) : onPopulateFromLayer && subsetUrlLayers.length > 0 ? (
        // A subset extractor's `url`, with loaded layers that can supply it: a
        // "From layer" picker fills the url (and companion fields) from a
        // COG/WMS/XYZ layer, while the field stays freely typeable. Placed
        // before the path/data-input branches (like the "Use map extent" one
        // above) so a `url` description that happens to contain a word
        // isPathParameter matches (path/file/…) can't shadow this picker into a
        // local file-browse control.
        <div className="grid grid-cols-[minmax(150px,200px)_minmax(0,1fr)] gap-2">
          <Select
            aria-label={t("processing.whitebox.fromLayer")}
            value=""
            onChange={(event) => {
              const layer = subsetUrlLayers.find((item) => item.id === event.target.value);
              if (layer) onPopulateFromLayer(layer);
            }}
          >
            <option value="">{t("processing.whitebox.fromLayer")}</option>
            {subsetUrlLayers.map((layer) => (
              <option key={layer.id} value={layer.id}>
                {layer.name}
              </option>
            ))}
          </Select>
          <Input
            id={`whitebox-${param.name}`}
            type="text"
            value={valueText}
            onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
          />
        </div>
      ) : isDataInputParameter(param) && availableLayers.length > 0 ? (
        <LayerOrPathInput
          id={`whitebox-${param.name}`}
          layers={availableLayers}
          param={param}
          value={valueText}
          onChange={onChange}
          onPickFile={onPickFile}
        />
      ) : kind === "vector_out" && runLocal ? (
        // In WASM mode a vector output is either a WGS84 map layer (GeoJSON) or a
        // downloaded file in a CRS-preserving format that keeps a reprojection's
        // target CRS (which the map, being EPSG:4326, cannot show). Normalize the
        // value so a stale sidecar-mode output path doesn't leak into the Select.
        <div className="grid gap-1.5">
          <Select
            id={`whitebox-${param.name}`}
            value={normalizeVectorOutputFormat(valueText)}
            onChange={(event) => onChange(event.target.value)}
          >
            <option value="geojson">{t("processing.whitebox.output.geojson")}</option>
            <option value="geoparquet">{t("processing.whitebox.output.geoparquet")}</option>
            <option value="flatgeobuf">{t("processing.whitebox.output.flatgeobuf")}</option>
            <option value="shapefile">{t("processing.whitebox.output.shapefile")}</option>
          </Select>
          {normalizeVectorOutputFormat(valueText) !== "geojson" && (
            <p className="text-xs text-muted-foreground">
              {t("processing.whitebox.output.projectedHint")}
            </p>
          )}
        </div>
      ) : isPathParameter(param) ? (
        <PathPickerInput
          id={`whitebox-${param.name}`}
          param={param}
          toolId={toolId}
          value={valueText}
          onChange={onChange}
          onPickFile={onPickFile}
        />
      ) : kind === "int" || kind === "double" ? (
        <NumberStepperInput
          id={`whitebox-${param.name}`}
          integer={kind === "int"}
          value={valueText}
          onChange={onChange}
        />
      ) : (
        <Input
          id={`whitebox-${param.name}`}
          type="text"
          value={valueText}
          placeholder={isOutputParameter(param) ? "Auto" : undefined}
          onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
        />
      )}

      {param.type && <p className="text-xs text-muted-foreground">{param.type}</p>}
    </div>
  );
}

interface NumberStepperInputProps {
  id: string;
  integer: boolean;
  onChange: (value: unknown) => void;
  value: string;
}

function NumberStepperInput({ id, integer, onChange, value }: NumberStepperInputProps) {
  const { t } = useTranslation();
  const step = integer ? 1 : 0.1;
  const updateByStep = (direction: 1 | -1) => {
    const parsed = Number.parseFloat(value);
    const base = Number.isFinite(parsed) ? parsed : 0;
    const next = base + direction * step;
    onChange(integer ? String(Math.trunc(next)) : Number(next.toFixed(6)).toString());
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_2.25rem] overflow-hidden rounded-md border border-input bg-background shadow-xs focus-within:border-2 focus-within:border-ring">
      <input
        id={id}
        inputMode={integer ? "numeric" : "decimal"}
        className="h-9 min-w-0 border-0 bg-transparent px-3 py-1 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-50"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="grid h-9 border-s">
        <button
          type="button"
          aria-label={t("processing.increaseValue")}
          className="flex h-[18px] items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => updateByStep(1)}
        >
          <ChevronUp className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label={t("processing.decreaseValue")}
          className="flex h-[18px] items-center justify-center border-t text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => updateByStep(-1)}
        >
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

interface LayerOrPathInputProps {
  id: string;
  layers: GeoLibreLayer[];
  onChange: (value: unknown) => void;
  onPickFile?: (fileName: string, bytes: Uint8Array) => void;
  param: WhiteboxToolParameter;
  value: string;
}

function LayerOrPathInput({
  id,
  layers,
  onChange,
  onPickFile,
  param,
  value,
}: LayerOrPathInputProps) {
  const usingLayer = value.startsWith(LAYER_TOKEN_PREFIX);
  return (
    <div className="grid grid-cols-[minmax(150px,200px)_minmax(0,1fr)_2.25rem] gap-2">
      <Select value={usingLayer ? value : ""} onChange={(event) => onChange(event.target.value)}>
        <option value="">Path</option>
        {layers.map((layer) => (
          <option key={layer.id} value={`${LAYER_TOKEN_PREFIX}${layer.id}`}>
            {layer.name}
          </option>
        ))}
      </Select>
      <Input
        id={id}
        value={usingLayer ? "" : value}
        placeholder={usingLayer ? "Selected layer" : "File path"}
        disabled={usingLayer}
        onChange={(event) => onChange(event.target.value)}
      />
      <PathBrowseButton
        disabled={usingLayer}
        mode="open"
        param={param}
        onPick={(path) => onChange(path)}
        onPickFile={onPickFile}
      />
    </div>
  );
}

interface PathPickerInputProps {
  id: string;
  onChange: (value: unknown) => void;
  onPickFile?: (fileName: string, bytes: Uint8Array) => void;
  param: WhiteboxToolParameter;
  toolId: string;
  value: string;
}

function PathPickerInput({ id, onChange, onPickFile, param, toolId, value }: PathPickerInputProps) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_2.25rem] gap-2">
      <Input
        id={id}
        value={value}
        placeholder={isOutputParameter(param) ? "Auto" : "File path"}
        onChange={(event) => onChange(event.target.value)}
      />
      <PathBrowseButton
        mode={isOutputParameter(param) ? "save" : "open"}
        param={param}
        toolId={toolId}
        onPick={(path) => onChange(path)}
        onPickFile={onPickFile}
      />
    </div>
  );
}

interface PathBrowseButtonProps {
  disabled?: boolean;
  mode: "open" | "save";
  onPick: (path: string) => void;
  onPickFile?: (fileName: string, bytes: Uint8Array) => void;
  param: WhiteboxToolParameter;
  toolId?: string;
}

function PathBrowseButton({
  disabled = false,
  mode,
  onPick,
  onPickFile,
  param,
  toolId = "whitebox",
}: PathBrowseButtonProps) {
  const pickPath = async () => {
    const filters = pathFiltersForParameter(param);
    if (mode === "save") {
      const path = await pickSavePathWithFallback({
        defaultName: defaultOutputName(toolId, param),
        filters,
      });
      if (path) onPick(path);
      return;
    }

    const path = await pickLocalPathWithFallback({
      accept: acceptForParameter(param),
      directory: isDirectoryParameter(param),
      filters,
    });
    if (path) {
      onPick(path);
      return;
    }

    // The browser cannot expose a real filesystem path, so pickLocalPath returns
    // null there. Fall back to reading the chosen file's bytes for the in-browser
    // WASM runner. (Skipped under Tauri, where null just means the user
    // cancelled the native dialog, and for directory parameters.)
    if (!isTauri() && onPickFile && !isDirectoryParameter(param)) {
      const picked = await openLocalDataFileWithFallback({
        accept: acceptForParameter(param),
        filters,
        readBinary: true,
      });
      if (picked?.data) {
        onPickFile(picked.path, new Uint8Array(picked.data));
      }
    }
  };

  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      disabled={disabled}
      title={mode === "save" ? "Choose output path" : "Choose input path"}
      onClick={() => void pickPath()}
    >
      {mode === "save" ? <Save className="h-4 w-4" /> : <FolderOpen className="h-4 w-4" />}
    </Button>
  );
}
