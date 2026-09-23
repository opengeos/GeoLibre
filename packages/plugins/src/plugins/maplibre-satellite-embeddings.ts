import { DEFAULT_LAYER_STYLE, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import type { Feature, FeatureCollection, Polygon } from "geojson";
import type {
  GeoJSONSource,
  LngLat,
  Map as MapLibreMap,
  MapLayerMouseEvent,
  MapMouseEvent,
} from "maplibre-gl";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";
import {
  AEF_BAND_COUNT,
  AEF_DEFAULT_RGB_BANDS,
  AEF_DEFAULT_STRETCH,
  AEF_NODATA,
  type AefTile,
  type AefTileReader,
  aefBandName,
  aefVrtUrl,
  dequantizeBand,
  flipRows,
  lonLatBboxToUtm,
  openAefTile,
  planAefWindow,
  renderAefRgba,
  searchAefTiles,
  utmBoundsToCorners,
} from "./satellite-embeddings-aef";
import {
  type SatelliteEmbeddingDataset,
  type SatelliteEmbeddingDatasetId,
  SATELLITE_EMBEDDING_DATASETS,
  getSatelliteEmbeddingDataset,
} from "./satellite-embeddings-catalog";
import {
  EARTH_INDEX_YEAR,
  EarthIndexTooLargeError,
  earthIndexFileUrl,
  loadEarthIndexPoints,
  probeFileSize,
} from "./satellite-embeddings-earth-index";
import { encodeGeoTiff } from "./satellite-embeddings-geotiff";
import {
  type LonLatBbox,
  bboxRing,
  intersectBboxes,
  mgrsTilesForBbox,
  polygonFeature,
  ringBbox,
  sentinel2TileRing,
  tesseraTilesForBbox,
  tesseraTileUrls,
} from "./satellite-embeddings-grids";
import { getStyleMap } from "./style-map";

export const SATELLITE_EMBEDDINGS_PLUGIN_ID = "geolibre-satellite-embeddings";
const PANEL_ID = SATELLITE_EMBEDDINGS_PLUGIN_ID;

/** Longest side, in pixels, of a rendered AlphaEarth composite. */
const MAX_RENDER_DIMENSION = 1024;
/** Largest clipped GeoTIFF the panel builds in memory. */
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
/** Bands read per request while building a download. */
const DOWNLOAD_BAND_BATCH = 8;
/** Band batches read at once while building a download. */
const DOWNLOAD_CONCURRENCY = 4;
/** Concurrent HEAD requests while checking which tiles exist. */
const PROBE_CONCURRENCY = 8;
/** Opened COGs kept for reuse (opening one reads ~14 image headers). */
const READER_CACHE_SIZE = 6;

/** `metadata.sourceKind` of the layers this plugin adds. */
const IMAGE_SOURCE_KIND = "satellite-embeddings-image";
const POINTS_SOURCE_KIND = "satellite-embeddings-points";
const FOOTPRINT_SOURCE_KIND = "satellite-embeddings-footprints";

// Footprints are a Layers-panel entry (hide/restyle/remove like any layer);
// the hover outline and the drawn search box are plugin-private chrome.
const FOOTPRINT_SOURCE_ID = "geolibre-satellite-embeddings-footprints";
const FOOTPRINT_FILL_LAYER_ID = "geolibre-satellite-embeddings-footprints-fill";
const FOOTPRINT_LINE_LAYER_ID = "geolibre-satellite-embeddings-footprints-line";
const FOOTPRINT_STORE_LAYER_ID = "geolibre-satellite-embeddings-footprints-layer";
const HOVER_SOURCE_ID = "geolibre-satellite-embeddings-hover";
const HOVER_LINE_LAYER_ID = "geolibre-satellite-embeddings-hover-line";
const DRAW_SOURCE_ID = "geolibre-satellite-embeddings-draw";
const DRAW_FILL_LAYER_ID = "geolibre-satellite-embeddings-draw-fill";
const DRAW_LINE_LAYER_ID = "geolibre-satellite-embeddings-draw-line";
const INTERNAL_METADATA = { "geolibre:internal": true } as const;
const FOOTPRINT_COLOR = "#7c3aed";
const HIGHLIGHT_COLOR = "#f5a623";

/**
 * Saves a generated file. The plugins package cannot reach the app's Tauri
 * file dialogs, so the host injects a saver (a native dialog on desktop, a
 * browser download on the web); without one the panel falls back to a plain
 * anchor download.
 */
export type SatelliteEmbeddingsFileSaver = (
  blob: Blob,
  options: { defaultName: string; extension: string; mimeType: string; description: string },
) => Promise<unknown>;

let fileSaver: SatelliteEmbeddingsFileSaver | null = null;

/** Injects the host's file saver (see {@link SatelliteEmbeddingsFileSaver}). */
export function setSatelliteEmbeddingsFileSaver(saver: SatelliteEmbeddingsFileSaver | null): void {
  fileSaver = saver;
}

const CSS = {
  panel:
    "display:flex;flex-direction:column;gap:10px;padding:10px;height:100%;" +
    "box-sizing:border-box;overflow-y:auto;color:hsl(var(--foreground));font-size:12px;",
  hint: "margin:0;color:hsl(var(--muted-foreground));line-height:1.45;",
  label: "display:flex;flex-direction:column;gap:4px;font-size:11px;font-weight:600;",
  input:
    "width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid hsl(var(--border));" +
    "border-radius:6px;background:hsl(var(--background));color:hsl(var(--foreground));",
  info:
    "display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:6px;" +
    "border:1px solid hsl(var(--border));background:hsl(var(--muted));",
  infoGrid: "display:grid;grid-template-columns:auto 1fr;gap:3px 10px;font-size:11px;",
  infoKey: "color:hsl(var(--muted-foreground));",
  links: "display:flex;gap:12px;flex-wrap:wrap;font-size:11px;",
  link: "color:hsl(var(--primary));text-decoration:underline;",
  attribution: "margin:0;font-size:10px;color:hsl(var(--muted-foreground));line-height:1.4;",
  modeBar:
    "display:flex;gap:2px;padding:2px;border-radius:6px;" +
    "border:1px solid hsl(var(--border));background:hsl(var(--muted));",
  modeButton:
    "flex:1 1 0;padding:4px 6px;font-size:11px;border-radius:4px;border:none;" +
    "background:transparent;color:hsl(var(--muted-foreground));cursor:pointer;",
  modeButtonActive:
    "flex:1 1 0;padding:4px 6px;font-size:11px;border-radius:4px;border:none;" +
    "background:hsl(var(--background));color:hsl(var(--foreground));" +
    "cursor:pointer;font-weight:600;",
  grid3: "display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;",
  grid2: "display:grid;grid-template-columns:1fr 1fr;gap:6px;",
  primary:
    "padding:7px 10px;border:1px solid hsl(var(--primary));border-radius:6px;" +
    "background:hsl(var(--primary));color:hsl(var(--primary-foreground));cursor:pointer;font-weight:600;",
  secondary:
    "padding:6px 10px;border:1px solid hsl(var(--border));border-radius:6px;" +
    "background:hsl(var(--background));color:hsl(var(--foreground));cursor:pointer;",
  status:
    "box-sizing:border-box;width:100%;padding:8px;border-radius:6px;background:hsl(var(--muted));" +
    "color:hsl(var(--muted-foreground));line-height:1.45;",
  list: "display:flex;flex-direction:column;gap:6px;",
  row:
    "box-sizing:border-box;width:100%;display:flex;flex-direction:column;gap:6px;" +
    "padding:6px 8px;border:1px solid hsl(var(--border));border-radius:6px;",
  rowTitle: "font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
  rowSubtitle:
    "color:hsl(var(--muted-foreground));font-size:11px;overflow:hidden;" +
    "text-overflow:ellipsis;white-space:nowrap;",
  rowActions: "display:flex;gap:4px;flex-wrap:wrap;",
  action:
    "padding:2px 8px;font-size:11px;border-radius:4px;cursor:pointer;" +
    "border:1px solid hsl(var(--border));background:hsl(var(--background));" +
    "color:hsl(var(--foreground));",
  section: "display:flex;flex-direction:column;gap:6px;",
  sectionTitle:
    "font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;" +
    "color:hsl(var(--muted-foreground));",
} as const;

type SearchMode = "view" | "draw";

/** One search hit: a file or tile of the selected dataset. */
interface ResultRow {
  id: string;
  title: string;
  subtitle: string;
  ring: [number, number][];
  bbox: LonLatBbox;
  aef?: AefTile;
  tessera?: { embeddings: string; scales: string };
  earthIndex?: { url: string; tileId: string };
}

/**
 * Panel state. Kept at module scope so a rebuild (a language change) restores
 * the search instead of wiping it; reset when the plugin deactivates.
 */
interface PanelState {
  datasetId: SatelliteEmbeddingDatasetId;
  mode: SearchMode;
  /** Selected year, or null for every year. */
  year: number | null;
  drawnBbox: LonLatBbox | null;
  /** The box the current results were searched with. */
  searchBbox: LonLatBbox | null;
  results: ResultRow[];
  total: number;
  status: { text: string; error: boolean } | null;
  busy: boolean;
  rgbBands: [number, number, number];
  stretch: number;
  downloadFloat: boolean;
}

function initialState(): PanelState {
  return {
    datasetId: "alphaearth",
    mode: "view",
    year: 2025,
    drawnBbox: null,
    searchBbox: null,
    results: [],
    total: 0,
    status: null,
    busy: false,
    rgbBands: [...AEF_DEFAULT_RGB_BANDS],
    stretch: AEF_DEFAULT_STRETCH,
    downloadFloat: true,
  };
}

let state: PanelState = initialState();
let appRef: GeoLibreAppAPI | null = null;
let unregisterPanel: (() => void) | null = null;
let unsubscribeLocale: (() => void) | null = null;
let panelContainer: HTMLElement | null = null;
let disposePanel: (() => void) | null = null;
let footprintsRegistered = false;
let footprintHandlersBound = false;
let onFootprintClick: ((id: string) => void) | null = null;
const readerCache = new Map<string, Promise<AefTileReader>>();

/** Resolves a plugin-namespaced translation key, falling back to English text. */
function tr(key: string, fallback: string, params?: Record<string, string | number>): string {
  return (
    appRef?.translate?.(`plugin.${SATELLITE_EMBEDDINGS_PLUGIN_ID}.${key}`, fallback, params) ??
    fallback.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(params?.[name] ?? ""))
  );
}

/** Creates an element with inline CSS. */
function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (style) node.style.cssText = style;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(
  text: string,
  style: string,
  onClick: () => void,
  title?: string,
): HTMLButtonElement {
  const node = element("button", style, text);
  node.type = "button";
  if (title) node.title = title;
  node.addEventListener("click", onClick);
  return node;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** Normalizes a longitude into [-180, 180]. */
function normalizeLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** The current map view as a [w, s, e, n] box (whole longitude range if it wraps). */
function viewBbox(): LonLatBbox | null {
  const map = getStyleMap(appRef);
  if (!map) return null;
  const bounds = map.getBounds();
  const clampLat = (value: number): number => Math.max(-90, Math.min(90, value));
  let west = normalizeLon(bounds.getWest());
  let east = normalizeLon(bounds.getEast());
  if (bounds.getEast() - bounds.getWest() >= 360 || west > east) {
    west = -180;
    east = 180;
  }
  return [west, clampLat(bounds.getSouth()), east, clampLat(bounds.getNorth())];
}

/** Opens (or reuses) a COG reader, keeping a small LRU of them. */
function getReader(url: string): Promise<AefTileReader> {
  const cached = readerCache.get(url);
  if (cached) {
    readerCache.delete(url);
    readerCache.set(url, cached);
    return cached;
  }
  const reader = openAefTile(url).catch((error: unknown) => {
    readerCache.delete(url);
    throw error;
  });
  readerCache.set(url, reader);
  while (readerCache.size > READER_CACHE_SIZE) {
    const oldest = readerCache.keys().next().value;
    if (oldest === undefined) break;
    readerCache.delete(oldest);
  }
  return reader;
}

/** Saves a generated blob through the host saver, or an anchor download. */
async function saveBlob(
  blob: Blob,
  options: { defaultName: string; extension: string; mimeType: string; description: string },
): Promise<void> {
  if (fileSaver) {
    await fileSaver(blob, options);
    return;
  }
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = options.defaultName;
    anchor.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/** Opens a remote file for download without leaving the app. */
function downloadUrl(url: string): void {
  if (!/^https:\/\//i.test(url)) return;
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = url.split("/").pop()?.split("?")[0] ?? "";
  // A cross-origin `download` hint may be ignored, so fall back to a new tab
  // rather than navigating the app away.
  anchor.target = "_blank";
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/** Runs async tasks with a concurrency limit, preserving input order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// Map overlays
// ---------------------------------------------------------------------------

function emptyCollection(): FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

function handleFootprintClick(event: MapLayerMouseEvent): void {
  const id = event.features?.[0]?.properties?.id;
  if (typeof id === "string") onFootprintClick?.(id);
}

function handleFootprintEnter(event: MapLayerMouseEvent): void {
  event.target.getCanvas().style.cursor = "pointer";
}

function handleFootprintLeave(event: MapLayerMouseEvent): void {
  event.target.getCanvas().style.cursor = "";
}

/** Shows the result footprints, registered as one Layers-panel entry. */
function setFootprints(map: MapLibreMap, rows: ResultRow[]): void {
  if (!map.isStyleLoaded()) return;
  const features = rows.map((row) =>
    polygonFeature(row.ring, { id: row.id, title: row.title, subtitle: row.subtitle }),
  );
  if (features.length === 0) {
    removeFootprints(map);
    return;
  }
  if (!map.getSource(FOOTPRINT_SOURCE_ID)) {
    map.addSource(FOOTPRINT_SOURCE_ID, { type: "geojson", data: emptyCollection() });
  }
  if (!map.getLayer(FOOTPRINT_FILL_LAYER_ID)) {
    map.addLayer({
      id: FOOTPRINT_FILL_LAYER_ID,
      type: "fill",
      source: FOOTPRINT_SOURCE_ID,
      paint: { "fill-color": FOOTPRINT_COLOR, "fill-opacity": 0.06 },
    });
  }
  if (!map.getLayer(FOOTPRINT_LINE_LAYER_ID)) {
    map.addLayer({
      id: FOOTPRINT_LINE_LAYER_ID,
      type: "line",
      source: FOOTPRINT_SOURCE_ID,
      paint: { "line-color": FOOTPRINT_COLOR, "line-width": 1.5 },
    });
  }
  if (!footprintHandlersBound) {
    footprintHandlersBound = true;
    map.on("click", FOOTPRINT_FILL_LAYER_ID, handleFootprintClick);
    map.on("mouseenter", FOOTPRINT_FILL_LAYER_ID, handleFootprintEnter);
    map.on("mouseleave", FOOTPRINT_FILL_LAYER_ID, handleFootprintLeave);
  }
  (map.getSource(FOOTPRINT_SOURCE_ID) as GeoJSONSource).setData({
    type: "FeatureCollection",
    features,
  });
  appRef?.registerExternalNativeLayer?.({
    id: FOOTPRINT_STORE_LAYER_ID,
    name: tr("footprintsLayer", "Embedding footprints"),
    type: "geojson",
    nativeLayerIds: [FOOTPRINT_FILL_LAYER_ID, FOOTPRINT_LINE_LAYER_ID],
    sourceIds: [FOOTPRINT_SOURCE_ID],
    geojson: { type: "FeatureCollection", features } as FeatureCollection,
    metadata: { sourceKind: FOOTPRINT_SOURCE_KIND },
    // Seed the look once; after that the Style panel owns it, and re-sending
    // would reset the user's edits on every new search.
    ...(footprintsRegistered
      ? {}
      : {
          opacity: 1,
          style: {
            fillColor: FOOTPRINT_COLOR,
            fillOpacity: 0.06,
            strokeColor: FOOTPRINT_COLOR,
            strokeWidth: 1.5,
          },
        }),
  });
  footprintsRegistered = true;
}

function removeFootprints(map: MapLibreMap | null): void {
  if (map && footprintHandlersBound) {
    map.off("click", FOOTPRINT_FILL_LAYER_ID, handleFootprintClick);
    map.off("mouseenter", FOOTPRINT_FILL_LAYER_ID, handleFootprintEnter);
    map.off("mouseleave", FOOTPRINT_FILL_LAYER_ID, handleFootprintLeave);
  }
  footprintHandlersBound = false;
  if (footprintsRegistered) {
    footprintsRegistered = false;
    appRef?.unregisterExternalNativeLayer?.(FOOTPRINT_STORE_LAYER_ID);
  }
  if (!map) return;
  for (const id of [FOOTPRINT_LINE_LAYER_ID, FOOTPRINT_FILL_LAYER_ID]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (map.getSource(FOOTPRINT_SOURCE_ID)) map.removeSource(FOOTPRINT_SOURCE_ID);
}

/** Outlines one result (or clears the outline when `ring` is null). */
function setHover(map: MapLibreMap, ring: [number, number][] | null): void {
  if (!map.isStyleLoaded()) return;
  if (!map.getSource(HOVER_SOURCE_ID)) {
    map.addSource(HOVER_SOURCE_ID, { type: "geojson", data: emptyCollection() });
  }
  if (!map.getLayer(HOVER_LINE_LAYER_ID)) {
    map.addLayer({
      id: HOVER_LINE_LAYER_ID,
      type: "line",
      source: HOVER_SOURCE_ID,
      metadata: INTERNAL_METADATA,
      paint: { "line-color": HIGHLIGHT_COLOR, "line-width": 3 },
    });
  }
  (map.getSource(HOVER_SOURCE_ID) as GeoJSONSource).setData(
    ring ? { type: "FeatureCollection", features: [polygonFeature(ring, {})] } : emptyCollection(),
  );
}

function setDrawBox(map: MapLibreMap, bbox: LonLatBbox | null): void {
  if (!map.isStyleLoaded()) return;
  if (!map.getSource(DRAW_SOURCE_ID)) {
    map.addSource(DRAW_SOURCE_ID, { type: "geojson", data: emptyCollection() });
  }
  if (!map.getLayer(DRAW_FILL_LAYER_ID)) {
    map.addLayer({
      id: DRAW_FILL_LAYER_ID,
      type: "fill",
      source: DRAW_SOURCE_ID,
      metadata: INTERNAL_METADATA,
      paint: { "fill-color": HIGHLIGHT_COLOR, "fill-opacity": 0.08 },
    });
  }
  if (!map.getLayer(DRAW_LINE_LAYER_ID)) {
    map.addLayer({
      id: DRAW_LINE_LAYER_ID,
      type: "line",
      source: DRAW_SOURCE_ID,
      metadata: INTERNAL_METADATA,
      paint: { "line-color": HIGHLIGHT_COLOR, "line-width": 2, "line-dasharray": [2, 1] },
    });
  }
  const features: Feature<Polygon>[] = bbox ? [polygonFeature(bboxRing(bbox), {})] : [];
  (map.getSource(DRAW_SOURCE_ID) as GeoJSONSource).setData({ type: "FeatureCollection", features });
}

/** Removes the plugin-private overlays (hover outline, drawn box). */
function removeChrome(map: MapLibreMap | null): void {
  if (!map) return;
  for (const id of [HOVER_LINE_LAYER_ID, DRAW_LINE_LAYER_ID, DRAW_FILL_LAYER_ID]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  for (const id of [HOVER_SOURCE_ID, DRAW_SOURCE_ID]) {
    if (map.getSource(id)) map.removeSource(id);
  }
}

/**
 * Starts a click-and-drag box draw. Pan and box-zoom are disabled until the
 * box is done or the returned cancel function runs.
 */
function startDraw(map: MapLibreMap, onComplete: (bbox: LonLatBbox) => void): () => void {
  const canvas = map.getCanvas();
  canvas.style.cursor = "crosshair";
  map.dragPan.disable();
  map.boxZoom.disable();
  let start: LngLat | null = null;
  const boxFrom = (a: LngLat, b: LngLat): LonLatBbox => [
    Math.min(a.lng, b.lng),
    Math.min(a.lat, b.lat),
    Math.max(a.lng, b.lng),
    Math.max(a.lat, b.lat),
  ];
  const onDown = (event: MapMouseEvent): void => {
    start = event.lngLat;
  };
  const onMove = (event: MapMouseEvent): void => {
    if (start) setDrawBox(map, boxFrom(start, event.lngLat));
  };
  const cleanup = (): void => {
    map.off("mousedown", onDown);
    map.off("mousemove", onMove);
    map.off("mouseup", onUp);
    canvas.style.cursor = "";
    map.dragPan.enable();
    map.boxZoom.enable();
  };
  function onUp(event: MapMouseEvent): void {
    if (!start) return;
    const bbox = boxFrom(start, event.lngLat);
    start = null;
    if (bbox[0] === bbox[2] || bbox[1] === bbox[3]) return; // a click, not a drag
    cleanup();
    setDrawBox(map, bbox);
    onComplete(bbox);
  }
  map.on("mousedown", onDown);
  map.on("mousemove", onMove);
  map.on("mouseup", onUp);
  return cleanup;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

async function searchAlphaEarth(bbox: LonLatBbox): Promise<{ rows: ResultRow[]; total: number }> {
  const { tiles, total } = await searchAefTiles(bbox, state.year === null ? [] : [state.year]);
  const rows = tiles.map((tile) => ({
    id: tile.id,
    title: tr("aefRowTitle", "{{year}} · UTM {{zone}}", { year: tile.year, zone: tile.utmZone }),
    subtitle: tile.id.split("/").pop() ?? tile.id,
    ring: bboxRing(tile.bbox),
    bbox: tile.bbox,
    aef: tile,
  }));
  return { rows, total };
}

async function searchTessera(bbox: LonLatBbox, signal: AbortSignal): Promise<ResultRow[]> {
  const year = state.year ?? getSatelliteEmbeddingDataset("tessera").years.at(-1)!;
  const tiles = tesseraTilesForBbox(bbox);
  if (!tiles)
    throw new Error(
      tr("tooManyTiles", "The area covers too many tiles. Zoom in or draw a smaller box."),
    );
  const sizes = await mapWithConcurrency(tiles, PROBE_CONCURRENCY, (tile) =>
    probeFileSize(tesseraTileUrls(tile.name, year).embeddings, signal),
  );
  return tiles.flatMap((tile, index) => {
    const size = sizes[index];
    if (size === null) return [];
    return [
      {
        id: `${year}/${tile.name}`,
        title: tile.name,
        subtitle: `${year} · ${formatBytes(size)}`,
        ring: bboxRing(tile.bbox),
        bbox: tile.bbox,
        tessera: tesseraTileUrls(tile.name, year),
      },
    ];
  });
}

async function searchEarthIndex(bbox: LonLatBbox, signal: AbortSignal): Promise<ResultRow[]> {
  const tileIds = mgrsTilesForBbox(bbox);
  if (!tileIds)
    throw new Error(
      tr("tooManyTiles", "The area covers too many tiles. Zoom in or draw a smaller box."),
    );
  const sizes = await mapWithConcurrency(tileIds, PROBE_CONCURRENCY, (tileId) =>
    probeFileSize(earthIndexFileUrl(tileId), signal),
  );
  return tileIds.flatMap((tileId, index) => {
    const size = sizes[index];
    const ring = sentinel2TileRing(tileId);
    if (size === null || !ring) return [];
    return [
      {
        id: tileId,
        title: tr("earthIndexRowTitle", "MGRS tile {{tile}}", { tile: tileId }),
        subtitle: `${EARTH_INDEX_YEAR} · ${formatBytes(size)}`,
        ring,
        bbox: ringBbox(ring),
        earthIndex: { url: earthIndexFileUrl(tileId), tileId },
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// Visualize / download
// ---------------------------------------------------------------------------

/** The part of a result to read: the search box clipped to the tile. */
function readRegion(row: ResultRow): LonLatBbox {
  return (state.searchBbox && intersectBboxes(state.searchBbox, row.bbox)) ?? row.bbox;
}

/** Renders an AlphaEarth tile's RGB composite as an image layer. */
async function visualizeAlphaEarth(
  row: ResultRow,
  setStatus: (text: string) => void,
): Promise<void> {
  const tile = row.aef!;
  // Read settings once: the user may change them while the bands load.
  const rgbBands: [number, number, number] = [...state.rgbBands];
  const stretch = state.stretch;
  setStatus(tr("opening", "Opening {{name}}…", { name: row.subtitle }));
  const reader = await getReader(tile.url);
  const plan = planAefWindow(
    reader.georef,
    lonLatBboxToUtm(readRegion(row), tile.epsg),
    reader.levelWidths,
    MAX_RENDER_DIMENSION,
  );
  if (!plan) throw new Error(tr("outsideTile", "The search area does not overlap this tile."));
  setStatus(
    tr("rendering", "Reading bands {{bands}}…", { bands: rgbBands.map(aefBandName).join(", ") }),
  );
  const bands = (await reader.readBands(plan, rgbBands)) as [Int8Array, Int8Array, Int8Array];
  const rgba = renderAefRgba(bands, plan.width, plan.height, plan.bottomUp, stretch);
  const canvas = document.createElement("canvas");
  canvas.width = plan.width;
  canvas.height = plan.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is not available");
  context.putImageData(
    new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, plan.width, plan.height),
    0,
    0,
  );
  const coordinates = utmBoundsToCorners(plan.bounds, tile.epsg);
  const bandLabel = rgbBands.map(aefBandName).join(", ");
  const dataset = getSatelliteEmbeddingDataset("alphaearth");
  const layer: GeoLibreLayer = {
    id: crypto.randomUUID(),
    name: tr("aefLayerName", "AlphaEarth {{year}} ({{bands}})", {
      year: tile.year,
      bands: bandLabel,
    }),
    type: "image",
    source: { type: "image", url: canvas.toDataURL("image/png"), coordinates },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      sourceKind: IMAGE_SOURCE_KIND,
      bounds: ringBbox(coordinates),
      dataset: dataset.id,
      tileUrl: tile.url,
      year: tile.year,
      bands: bandLabel,
      stretch,
      attribution: dataset.attribution,
    },
  };
  useAppStore.getState().addLayer(layer);
  appRef?.fitBounds?.(ringBbox(coordinates));
  const done = tr("visualized", "Added {{name}}.", { name: layer.name });
  setStatus(
    plan.level > 0
      ? `${done} ${tr("overviewNote", "Rendered from a 1/{{factor}} overview; search a smaller area for full 10 m detail.", { factor: 2 ** plan.level })}`
      : done,
  );
}

/** Builds a clipped 64-band GeoTIFF of an AlphaEarth tile and saves it. */
async function downloadAlphaEarthClip(
  row: ResultRow,
  setStatus: (text: string) => void,
): Promise<void> {
  const tile = row.aef!;
  setStatus(tr("opening", "Opening {{name}}…", { name: row.subtitle }));
  const reader = await getReader(tile.url);
  const plan = planAefWindow(reader.georef, lonLatBboxToUtm(readRegion(row), tile.epsg), [
    reader.levelWidths[0],
  ]);
  if (!plan) throw new Error(tr("outsideTile", "The search area does not overlap this tile."));
  // Read settings once: the user may change them while the bands download.
  const asFloat = state.downloadFloat;
  const bytesPerSample = asFloat ? 4 : 1;
  const bytes = plan.width * plan.height * AEF_BAND_COUNT * bytesPerSample;
  if (bytes > MAX_DOWNLOAD_BYTES) {
    throw new Error(
      tr(
        "downloadTooLarge",
        "The clip would be {{size}}; the limit is {{limit}}. Draw a smaller box.",
        {
          size: formatBytes(bytes),
          limit: formatBytes(MAX_DOWNLOAD_BYTES),
        },
      ),
    );
  }
  const batches: number[][] = [];
  for (let first = 0; first < AEF_BAND_COUNT; first += DOWNLOAD_BAND_BATCH) {
    batches.push(
      Array.from(
        { length: Math.min(DOWNLOAD_BAND_BATCH, AEF_BAND_COUNT - first) },
        (_, offset) => first + offset,
      ),
    );
  }
  let done = 0;
  setStatus(
    tr("downloadingBands", "Reading bands {{done}} of {{total}}…", { done, total: AEF_BAND_COUNT }),
  );
  const batchBands = await mapWithConcurrency(batches, DOWNLOAD_CONCURRENCY, async (indices) => {
    const raws = await reader.readBands(plan, indices);
    done += indices.length;
    setStatus(
      tr("downloadingBands", "Reading bands {{done}} of {{total}}…", {
        done,
        total: AEF_BAND_COUNT,
      }),
    );
    return raws.map((raw) => {
      if (plan.bottomUp) flipRows(raw, plan.width, plan.height);
      return asFloat ? dequantizeBand(raw) : raw;
    });
  });
  const bands = batchBands.flat();
  const [minX, , maxX, maxY] = plan.bounds;
  const pixelSize = (maxX - minX) / plan.width;
  const parts = encodeGeoTiff({
    width: plan.width,
    height: plan.height,
    bands,
    sampleType: asFloat ? "float32" : "int8",
    epsg: tile.epsg,
    originX: minX,
    originY: maxY,
    pixelSizeX: pixelSize,
    pixelSizeY: pixelSize,
    nodata: asFloat ? "nan" : String(AEF_NODATA),
    bandNames: Array.from({ length: AEF_BAND_COUNT }, (_, index) => aefBandName(index)),
  });
  const stem = row.subtitle.replace(/[^\w.-]+/g, "_");
  const defaultName = `alphaearth_${tile.year}_${tile.utmZone}_${stem}_clip.tif`;
  await saveBlob(new Blob(parts, { type: "image/tiff" }), {
    defaultName,
    extension: "tif",
    mimeType: "image/tiff",
    description: "GeoTIFF",
  });
  setStatus(
    tr("downloaded", "Saved {{name}} ({{size}}).", { name: defaultName, size: formatBytes(bytes) }),
  );
}

/** Loads the Earth Index points in the search area as a colored point layer. */
async function loadEarthIndex(
  row: ResultRow,
  setStatus: (text: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const region = readRegion(row);
  setStatus(
    tr("loadingPoints", "Loading embeddings for {{tile}}…", { tile: row.earthIndex!.tileId }),
  );
  let result;
  try {
    result = await loadEarthIndexPoints(row.earthIndex!.url, region, { signal });
  } catch (error) {
    if (error instanceof EarthIndexTooLargeError) {
      throw new Error(
        tr(
          "pointsTooMany",
          "The area needs {{rows}} embedding rows. Zoom in or draw a smaller box.",
          {
            rows: error.rows,
          },
        ),
      );
    }
    throw error;
  }
  if (result.features.length === 0) {
    setStatus(tr("noPoints", "No embeddings fall inside the search area in this tile."));
    return;
  }
  const app = appRef;
  if (!app) return;
  const name = tr("earthIndexLayerName", "Earth Index {{tile}} (PCA colors)", {
    tile: row.earthIndex!.tileId,
  });
  const layerId = app.addGeoJsonLayer(name, {
    type: "FeatureCollection",
    features: result.features,
  });
  const store = useAppStore.getState();
  const layer = store.layers.find((candidate) => candidate.id === layerId);
  if (layer) {
    store.updateLayer(layerId, {
      style: {
        ...layer.style,
        vectorStyleMode: "expression",
        vectorStyleExpression: JSON.stringify(["get", "color"]),
        circleRadius: 4,
        strokeWidth: 0,
        fillOpacity: 0.9,
      },
      metadata: { ...layer.metadata, sourceKind: POINTS_SOURCE_KIND, dataset: "earth-index" },
    });
  }
  setStatus(
    tr(
      "pointsLoaded",
      "Added {{count}} embeddings, colored by their top three principal components.",
      {
        count: result.features.length,
      },
    ),
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

function datasetInfo(dataset: SatelliteEmbeddingDataset): HTMLElement {
  const box = element("div", CSS.info);
  box.append(element("div", "font-weight:600;", `${dataset.provider} · ${dataset.model}`));
  const grid = element("div", CSS.infoGrid);
  const add = (key: string, value: string): void => {
    grid.append(element("span", CSS.infoKey, key), element("span", "", value));
  };
  add(
    tr("infoType", "Type"),
    dataset.kind === "pixel"
      ? tr("kindPixel", "Per pixel (raster)")
      : tr("kindPatch", "Per patch (vector)"),
  );
  add(tr("infoResolution", "Resolution"), dataset.resolution);
  add(tr("infoDimensions", "Dimensions"), String(dataset.dimensions));
  if (dataset.years.length > 0) {
    const first = dataset.years[0];
    const last = dataset.years[dataset.years.length - 1];
    add(tr("infoYears", "Years"), first === last ? String(first) : `${first}–${last}`);
  }
  add(tr("infoCoverage", "Coverage"), dataset.coverage);
  add(
    tr("infoLicense", "License"),
    dataset.license ?? tr("licenseUnstated", "See the data source"),
  );
  box.append(grid);
  const links = element("div", CSS.links);
  const link = (text: string, href: string): HTMLAnchorElement => {
    const anchor = element("a", CSS.link, text);
    anchor.href = href;
    anchor.target = "_blank";
    anchor.rel = "noopener";
    return anchor;
  };
  links.append(link(tr("dataSource", "Data source"), dataset.dataUrl));
  if (dataset.paperUrl) links.append(link(tr("paper", "Paper"), dataset.paperUrl));
  box.append(links);
  if (dataset.attribution) box.append(element("p", CSS.attribution, dataset.attribution));
  return box;
}

function labeled(text: string, control: HTMLElement): HTMLLabelElement {
  const label = element("label", CSS.label, text);
  label.append(control);
  return label;
}

function buildPanel(container: HTMLElement): () => void {
  container.replaceChildren();
  container.style.cssText = CSS.panel;
  let disposed = false;
  let controller: AbortController | null = null;
  let cancelDraw: (() => void) | null = null;

  const setStatus = (text: string | null, error = false): void => {
    state.status = text === null ? null : { text, error };
    renderStatus();
  };

  const statusBox = element("div", CSS.status);
  const renderStatus = (): void => {
    statusBox.hidden = !state.status;
    statusBox.textContent = state.status?.text ?? "";
    statusBox.style.color = state.status?.error
      ? "hsl(var(--destructive))"
      : "hsl(var(--muted-foreground))";
  };

  const body = element("div", "display:flex;flex-direction:column;gap:10px;");
  container.append(
    element(
      "p",
      CSS.hint,
      tr(
        "hint",
        "Search, visualize, and download pre-computed satellite embeddings from geospatial foundation models.",
      ),
    ),
    body,
  );

  const stopDrawing = (): void => {
    cancelDraw?.();
    cancelDraw = null;
  };

  const runTask = async (task: (signal: AbortSignal) => Promise<void>): Promise<void> => {
    controller?.abort();
    const current = new AbortController();
    controller = current;
    state.busy = true;
    render();
    try {
      await task(current.signal);
    } catch (error) {
      if (!isAbort(error) && !disposed) setStatus(errorMessage(error), true);
    } finally {
      if (controller === current) {
        controller = null;
        state.busy = false;
        if (!disposed) render();
      }
    }
  };

  const search = (): void => {
    const bbox = state.mode === "view" ? viewBbox() : state.drawnBbox;
    if (!bbox) {
      setStatus(
        state.mode === "draw"
          ? tr("drawFirst", "Draw a box on the map first.")
          : tr("mapUnavailable", "The map is not ready yet."),
        true,
      );
      return;
    }
    void runTask(async (signal) => {
      setStatus(tr("searching", "Searching…"));
      state.searchBbox = bbox;
      let rows: ResultRow[];
      let total: number;
      if (state.datasetId === "alphaearth") {
        ({ rows, total } = await searchAlphaEarth(bbox));
      } else if (state.datasetId === "tessera") {
        rows = await searchTessera(bbox, signal);
        total = rows.length;
      } else {
        rows = await searchEarthIndex(bbox, signal);
        total = rows.length;
      }
      if (signal.aborted || disposed) return;
      state.results = rows;
      state.total = total;
      const map = getStyleMap(appRef);
      if (map) setFootprints(map, rows);
      setStatus(
        rows.length === 0
          ? tr("noResults", "No embeddings found in this area.")
          : total > rows.length
            ? tr("showingSome", "Showing {{shown}} of {{total}} files.", {
                shown: rows.length,
                total,
              })
            : tr("showing", "Found {{count}} files.", { count: rows.length }),
      );
    });
  };

  // A button that runs a long task; disabled while another task is running.
  const taskButton = (
    text: string,
    task: (signal: AbortSignal) => Promise<void>,
    title: string,
  ): HTMLButtonElement => {
    const node = button(text, CSS.action, () => void runTask(task), title);
    node.disabled = state.busy;
    return node;
  };

  const rowActions = (row: ResultRow): HTMLButtonElement[] => {
    const zoom = button(tr("zoom", "Zoom"), CSS.action, () => appRef?.fitBounds?.(row.bbox));
    const statusSetter = (text: string): void => setStatus(text);
    if (row.aef) {
      const tile = row.aef;
      return [
        taskButton(
          tr("visualize", "Visualize"),
          () => visualizeAlphaEarth(row, statusSetter),
          tr("visualizeTitle", "Render the selected bands over the search area as an image layer"),
        ),
        taskButton(
          tr("downloadClip", "GeoTIFF"),
          () => downloadAlphaEarthClip(row, statusSetter),
          tr("downloadClipTitle", "Save all 64 bands over the search area as a GeoTIFF"),
        ),
        button(
          tr("downloadTile", "Full tile"),
          CSS.action,
          () => downloadUrl(tile.url),
          tr(
            "downloadTileTitle",
            "Download the whole source COG (bottom-up; GDAL users should open the .vrt)",
          ),
        ),
        button(
          tr("downloadVrt", "VRT"),
          CSS.action,
          () => downloadUrl(aefVrtUrl(tile.url)),
          tr("downloadVrtTitle", "Download the VRT that reads the source COG north-up in GDAL"),
        ),
        zoom,
      ];
    }
    if (row.tessera) {
      const urls = row.tessera;
      return [
        button(tr("downloadEmbeddings", "Embeddings (.npy)"), CSS.action, () =>
          downloadUrl(urls.embeddings),
        ),
        button(tr("downloadScales", "Scales (.npy)"), CSS.action, () => downloadUrl(urls.scales)),
        zoom,
      ];
    }
    const file = row.earthIndex!;
    return [
      taskButton(
        tr("loadPoints", "Load points"),
        (signal) => loadEarthIndex(row, statusSetter, signal),
        tr("loadPointsTitle", "Add the embeddings in the search area as points colored by PCA"),
      ),
      button(
        tr("downloadParquet", "Parquet"),
        CSS.action,
        () => downloadUrl(file.url),
        tr("downloadParquetTitle", "Download the whole GeoParquet file for this tile"),
      ),
      zoom,
    ];
  };

  const rowElements = new Map<string, HTMLElement>();
  onFootprintClick = (id: string): void => {
    const rowElement = rowElements.get(id);
    if (!rowElement) return;
    rowElement.scrollIntoView({ block: "nearest" });
    rowElement.style.boxShadow = `0 0 0 2px ${HIGHLIGHT_COLOR}`;
    window.setTimeout(() => {
      rowElement.style.boxShadow = "";
    }, 1200);
  };

  function render(): void {
    if (disposed) return;
    const dataset = getSatelliteEmbeddingDataset(state.datasetId);
    body.replaceChildren();
    rowElements.clear();

    const datasetSelect = element("select", CSS.input);
    for (const candidate of SATELLITE_EMBEDDING_DATASETS) {
      const option = element("option", undefined, candidate.name);
      option.value = candidate.id;
      option.selected = candidate.id === state.datasetId;
      datasetSelect.append(option);
    }
    datasetSelect.addEventListener("change", () => {
      controller?.abort();
      stopDrawing();
      const next = getSatelliteEmbeddingDataset(datasetSelect.value as SatelliteEmbeddingDatasetId);
      state.datasetId = next.id;
      state.year = next.years.at(-1) ?? null;
      state.results = [];
      state.total = 0;
      state.status = null;
      const map = getStyleMap(appRef);
      if (map) {
        removeFootprints(map);
        setHover(map, null);
      }
      render();
    });
    body.append(labeled(tr("dataset", "Dataset"), datasetSelect), datasetInfo(dataset));

    if (!dataset.capabilities.search) {
      body.append(
        element(
          "p",
          CSS.hint,
          tr(
            "browseOnly",
            "Searching this dataset in GeoLibre is not supported yet. Use the links above to get it from its source.",
          ),
        ),
      );
      return;
    }

    // --- Search area and year ------------------------------------------------
    const searchSection = element("div", CSS.section);
    searchSection.append(element("div", CSS.sectionTitle, tr("searchArea", "Search area")));
    const modeBar = element("div", CSS.modeBar);
    for (const [mode, text] of [
      ["view", tr("modeView", "Map view")],
      ["draw", tr("modeDraw", "Draw box")],
    ] as const) {
      modeBar.append(
        button(text, state.mode === mode ? CSS.modeButtonActive : CSS.modeButton, () => {
          if (mode !== "draw") stopDrawing();
          state.mode = mode;
          render();
        }),
      );
    }
    searchSection.append(modeBar);
    if (state.mode === "draw") {
      const drawButton = button(
        cancelDraw ? tr("drawCancel", "Cancel drawing") : tr("drawStart", "Draw box on map"),
        CSS.secondary,
        () => {
          const map = getStyleMap(appRef);
          if (!map) return;
          if (cancelDraw) {
            stopDrawing();
            render();
            return;
          }
          cancelDraw = startDraw(map, (bbox) => {
            cancelDraw = null;
            state.drawnBbox = bbox;
            render();
            search();
          });
          setStatus(tr("drawHint", "Click and drag on the map to draw a search box."));
          render();
        },
      );
      searchSection.append(drawButton);
      if (state.drawnBbox) {
        searchSection.append(
          element("div", CSS.hint, state.drawnBbox.map((value) => value.toFixed(4)).join(", ")),
        );
      }
    }
    if (dataset.years.length > 1) {
      const yearSelect = element("select", CSS.input);
      if (dataset.id === "alphaearth") {
        const all = element("option", undefined, tr("allYears", "All years"));
        all.value = "";
        all.selected = state.year === null;
        yearSelect.append(all);
      }
      for (const year of [...dataset.years].reverse()) {
        const option = element("option", undefined, String(year));
        option.value = String(year);
        option.selected = state.year === year;
        yearSelect.append(option);
      }
      yearSelect.addEventListener("change", () => {
        state.year = yearSelect.value ? Number(yearSelect.value) : null;
      });
      searchSection.append(labeled(tr("year", "Year"), yearSelect));
    }
    const searchButton = button(
      state.busy ? tr("working", "Working…") : tr("search", "Search"),
      CSS.primary,
      search,
    );
    searchButton.disabled = state.busy;
    searchSection.append(searchButton);
    body.append(searchSection);

    // --- AlphaEarth rendering options ---------------------------------------
    if (dataset.id === "alphaearth") {
      const options = element("div", CSS.section);
      options.append(element("div", CSS.sectionTitle, tr("renderOptions", "Visualization")));
      const bandGrid = element("div", CSS.grid3);
      (["red", "green", "blue"] as const).forEach((channel, channelIndex) => {
        const select = element("select", CSS.input);
        for (let band = 0; band < AEF_BAND_COUNT; band += 1) {
          const option = element("option", undefined, aefBandName(band));
          option.value = String(band);
          option.selected = state.rgbBands[channelIndex] === band;
          select.append(option);
        }
        select.addEventListener("change", () => {
          state.rgbBands[channelIndex] = Number(select.value);
        });
        const names = {
          red: tr("red", "Red"),
          green: tr("green", "Green"),
          blue: tr("blue", "Blue"),
        };
        bandGrid.append(labeled(names[channel], select));
      });
      const stretch = element("input", CSS.input);
      stretch.type = "number";
      stretch.min = "0.05";
      stretch.max = "1";
      stretch.step = "0.05";
      stretch.value = String(state.stretch);
      stretch.addEventListener("change", () => {
        const value = Number(stretch.value);
        if (Number.isFinite(value) && value > 0 && value <= 1) state.stretch = value;
        else stretch.value = String(state.stretch);
      });
      const valueType = element("select", CSS.input);
      for (const [value, text] of [
        ["float", tr("valuesFloat", "De-quantized (float32)")],
        ["int8", tr("valuesInt8", "Raw (int8)")],
      ] as const) {
        const option = element("option", undefined, text);
        option.value = value;
        option.selected = (value === "float") === state.downloadFloat;
        valueType.append(option);
      }
      valueType.addEventListener("change", () => {
        state.downloadFloat = valueType.value === "float";
      });
      const row = element("div", CSS.grid2);
      row.append(
        labeled(tr("stretch", "Stretch (±)"), stretch),
        labeled(tr("downloadValues", "GeoTIFF values"), valueType),
      );
      options.append(bandGrid, row);
      body.append(options);
    }

    body.append(statusBox);
    renderStatus();

    // --- Results ------------------------------------------------------------
    if (state.results.length > 0) {
      const list = element("div", CSS.list);
      for (const row of state.results) {
        const rowElement = element("div", CSS.row);
        rowElement.append(
          element("div", CSS.rowTitle, row.title),
          element("div", CSS.rowSubtitle, row.subtitle),
        );
        const actions = element("div", CSS.rowActions);
        actions.append(...rowActions(row));
        rowElement.append(actions);
        rowElement.addEventListener("mouseenter", () => {
          const map = getStyleMap(appRef);
          if (map) setHover(map, row.ring);
        });
        rowElement.addEventListener("mouseleave", () => {
          const map = getStyleMap(appRef);
          if (map) setHover(map, null);
        });
        rowElements.set(row.id, rowElement);
        list.append(rowElement);
      }
      body.append(list);
    }
  }

  render();

  // Drop our footprint bookkeeping when the user deletes that layer.
  const unsubscribe = useAppStore.subscribe((store) => {
    if (
      footprintsRegistered &&
      !store.layers.some((layer) => layer.id === FOOTPRINT_STORE_LAYER_ID)
    ) {
      footprintsRegistered = false;
      removeFootprints(getStyleMap(appRef));
    }
  });

  return () => {
    disposed = true;
    controller?.abort();
    stopDrawing();
    unsubscribe();
    onFootprintClick = null;
    container.replaceChildren();
  };
}

function mountPanel(container: HTMLElement): void {
  disposePanel?.();
  panelContainer = container;
  disposePanel = buildPanel(container);
}

/** Clears every map overlay the plugin owns. */
function clearOverlays(app: GeoLibreAppAPI): void {
  const map = getStyleMap(app);
  removeFootprints(map);
  removeChrome(map);
}

/**
 * Satellite Embeddings plugin: a catalog of popular pre-computed embedding
 * datasets (AlphaEarth/Google Satellite Embedding, Tessera, Earth Index, Clay,
 * Major TOM, Copernicus-Embed) with search by map view or drawn box, on-map
 * visualization (AlphaEarth RGB composites, Earth Index points colored by
 * PCA), and downloads (clipped GeoTIFFs, source tiles and files).
 */
export const maplibreSatelliteEmbeddingsPlugin: GeoLibrePlugin = {
  id: SATELLITE_EMBEDDINGS_PLUGIN_ID,
  name: "Satellite Embeddings",
  version: "0.1.0",
  // Footprints, the image composites and the point layers are Style Spec
  // sources and layers, so both 2D engines host them.
  engines: ["maplibre", "mapbox"],
  activate: (app) => {
    appRef = app;
    unregisterPanel =
      app.registerRightPanel?.({
        id: PANEL_ID,
        title: () => tr("title", "Satellite Embeddings"),
        dock: "replace-style",
        defaultWidth: 360,
        render: (container) => {
          mountPanel(container);
          return () => {
            disposePanel?.();
            disposePanel = null;
            if (panelContainer === container) panelContainer = null;
          };
        },
      }) ?? null;
    unsubscribeLocale =
      app.onLocaleChange?.(() => {
        if (panelContainer) mountPanel(panelContainer);
      }) ?? null;
    app.openRightPanel?.(PANEL_ID);
  },
  deactivate: (app) => {
    app.closeRightPanel?.(PANEL_ID);
    unsubscribeLocale?.();
    unsubscribeLocale = null;
    unregisterPanel?.();
    unregisterPanel = null;
    disposePanel?.();
    disposePanel = null;
    panelContainer = null;
    clearOverlays(app);
    state = initialState();
    readerCache.clear();
    appRef = null;
  },
};

export default maplibreSatelliteEmbeddingsPlugin;
