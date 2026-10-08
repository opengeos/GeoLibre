import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import { createPMTilesStoreLayer } from "@geolibre/map/pmtiles-layer";
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
  FTW_COVERAGE_BINS,
  FTW_DATA_URL,
  FTW_DEFAULT_THRESHOLD,
  FTW_DEFAULT_YEAR,
  FTW_LICENSE,
  FTW_MAP_URL,
  FTW_PAPER_URL,
  FTW_SCORE_BINS,
  FTW_WEBSITE_URL,
  FTW_YEARS,
  FtwTooManyFieldsError,
  type FtwYear,
  type FtwZoneFile,
  type FtwZoneReader,
  coverageColorExpression,
  ftwCellsLayer,
  ftwFieldsLayer,
  loadFtwAreaFeatures,
  loadFtwZoneIndex,
  openFtwZone,
  planFtwRead,
  scoreColorExpression,
  scoreFilterExpression,
  searchFtwZones,
  thresholdFromFilter,
} from "./fields-of-the-world-data";
import { type LonLatBbox, bboxRing, polygonFeature } from "./satellite-embeddings-grids";
import { getControlMap } from "./style-map";
import { createPluginTranslator } from "../plugin-i18n";

export const FIELDS_OF_THE_WORLD_PLUGIN_ID = "geolibre-fields-of-the-world";
const PANEL_ID = FIELDS_OF_THE_WORLD_PLUGIN_ID;

/** Most fields added to the map as one GeoJSON layer. */
const MAX_MAP_FEATURES = 250_000;
/**
 * Most fields written to one GeoJSON file. Decoded polygons, and the
 * per-feature strings joined into the file, take far more memory than their
 * compressed bytes, so this matches the map limit.
 */
const MAX_GEOJSON_FEATURES = 250_000;
/** Most compressed bytes one Add to map reads (row groups run ~17 MB each). */
const MAX_MAP_READ_BYTES = 512 * 1024 ** 2;
/** Most compressed bytes one GeoJSON export reads. */
const MAX_GEOJSON_READ_BYTES = 512 * 1024 ** 2;
/**
 * Largest zone file saved whole (it is buffered in memory first); above it the
 * URL is copied instead.
 */
const MAX_PARQUET_SAVE_BYTES = 256 * 1024 ** 2;
/** Most UTM zones one search opens (each costs a footer read of up to ~2.7 MB). */
const MAX_SEARCH_ZONES = 6;
/** Zone files whose footers stay cached between searches. */
const READER_CACHE_SIZE = 8;
/** Zoom at which the density cells hand over to the field polygons. */
const CELLS_MAX_ZOOM = 9;
/** Delay before a threshold drag is written to the layers. */
const THRESHOLD_DEBOUNCE_MS = 150;

/** `metadata.sourceKind` of the layers this plugin adds (PMTiles keep their own). */
const AREA_FIELDS_SOURCE_KIND = "fields-of-the-world-area";
/** Marks the field-density (A5 cells) layer. Its value is the year. */
const CELLS_METADATA_KEY = "ftwCells2eYear";
const FOOTPRINT_SOURCE_KIND = "fields-of-the-world-footprints";
/**
 * Marks a 2nd Edition field layer (the archive or a loaded area) whose score
 * filter the panel drives. Its value is the year. 1st Edition layers in older
 * projects carry `ftwFieldsYear` and a `confidence_mean` filter instead, so
 * the panel leaves them alone.
 */
const FTW_FIELDS_METADATA_KEY = "ftwFields2eYear";

// Footprints are a Layers-panel entry (hide/restyle/remove like any layer);
// the hover outline and the drawn search box are plugin-private chrome.
const FOOTPRINT_SOURCE_ID = "geolibre-ftw-footprints";
const FOOTPRINT_FILL_LAYER_ID = "geolibre-ftw-footprints-fill";
const FOOTPRINT_LINE_LAYER_ID = "geolibre-ftw-footprints-line";
const FOOTPRINT_STORE_LAYER_ID = "geolibre-ftw-footprints-layer";
const HOVER_SOURCE_ID = "geolibre-ftw-hover";
const HOVER_LINE_LAYER_ID = "geolibre-ftw-hover-line";
const DRAW_SOURCE_ID = "geolibre-ftw-draw";
const DRAW_FILL_LAYER_ID = "geolibre-ftw-draw-fill";
const DRAW_LINE_LAYER_ID = "geolibre-ftw-draw-line";
const INTERNAL_METADATA = { "geolibre:internal": true } as const;
const FOOTPRINT_COLOR = "#008888";
const HIGHLIGHT_COLOR = "#f5a623";
const ATTRIBUTION =
  "Fields of the World (Taylor Geospatial Institute, Microsoft AI for Good, and partners), CC-BY-4.0";

/**
 * Saves a generated file. The plugins package cannot reach the app's Tauri
 * file dialogs, so the host injects a saver (a native dialog on desktop, a
 * browser download on the web); without one the panel falls back to a plain
 * anchor download.
 */
export type FieldsOfTheWorldFileSaver = (
  blob: Blob,
  options: { defaultName: string; extension: string; mimeType: string; description: string },
) => Promise<unknown>;

let fileSaver: FieldsOfTheWorldFileSaver | null = null;

/** Injects the host's file saver (see {@link FieldsOfTheWorldFileSaver}). */
export function setFieldsOfTheWorldFileSaver(saver: FieldsOfTheWorldFileSaver | null): void {
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
  infoSummary: "font-weight:600;cursor:pointer;",
  infoText: "margin:0;font-size:11px;line-height:1.45;",
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
  grid2: "display:grid;grid-template-columns:1fr 1fr;gap:6px;",
  primary:
    "padding:7px 10px;border:1px solid hsl(var(--primary));border-radius:6px;" +
    "background:hsl(var(--primary));color:hsl(var(--primary-foreground));cursor:pointer;font-weight:600;",
  secondary:
    "padding:6px 10px;border:1px solid hsl(var(--border));border-radius:6px;" +
    "background:hsl(var(--background));color:hsl(var(--foreground));cursor:pointer;",
  sliderRow: "display:flex;align-items:center;gap:8px;",
  slider: "flex:1 1 auto;accent-color:hsl(var(--primary));",
  sliderValue: "min-width:36px;text-align:end;font-variant-numeric:tabular-nums;",
  legend: "display:flex;flex-direction:column;gap:2px;",
  legendRamp: "height:8px;border-radius:4px;border:1px solid hsl(var(--border));",
  legendLabels:
    "display:flex;justify-content:space-between;font-size:10px;color:hsl(var(--muted-foreground));",
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
  rowSelected: `border-color:${HIGHLIGHT_COLOR};box-shadow:0 0 0 1px ${HIGHLIGHT_COLOR};`,
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

/** One UTM zone file holding fields in the search area. */
interface ZoneResult {
  /** `utmNN`, the footprint and row id. */
  id: string;
  zone: FtwZoneFile;
  /** Compressed bytes the area's row groups take in the file. */
  readBytes: number;
  /** The part of the search area the zone has row groups in. */
  extent: LonLatBbox;
}

/**
 * Panel state. Kept at module scope so a rebuild (a language change) restores
 * the search instead of wiping it; reset when the plugin deactivates.
 */
interface PanelState {
  year: FtwYear;
  /** Score threshold (0–100), applied to every FTW field layer. */
  threshold: number;
  mode: SearchMode;
  drawnBbox: LonLatBbox | null;
  /** The box the current results were searched with. */
  searchBbox: LonLatBbox | null;
  /** The year the current results were searched for. */
  searchYear: FtwYear;
  results: ZoneResult[];
  status: { text: string; error: boolean } | null;
  busy: boolean;
  infoExpanded: boolean;
  /** Zones selected by a footprint or row click, outlined on the map. */
  selectedIds: string[];
}

function initialState(): PanelState {
  return {
    year: FTW_DEFAULT_YEAR,
    threshold: FTW_DEFAULT_THRESHOLD,
    mode: "view",
    drawnBbox: null,
    searchBbox: null,
    searchYear: FTW_DEFAULT_YEAR,
    results: [],
    status: null,
    busy: false,
    infoExpanded: false,
    selectedIds: [],
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
let onFootprintClick: ((ids: string[]) => void) | null = null;
/** The parsed zone index, fetched once per session (~54 KB). */
let indexPromise: Promise<FtwZoneFile[]> | null = null;
/** Opened zone files by URL, most recently used last. */
const readers = new Map<string, Promise<FtwZoneReader>>();

/** Resolves a plugin-namespaced translation key, falling back to English text. */
const tr = createPluginTranslator(() => appRef, FIELDS_OF_THE_WORLD_PLUGIN_ID);

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

function labeled(text: string, control: HTMLElement): HTMLLabelElement {
  const label = element("label", CSS.label, text);
  label.append(control);
  return label;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatCount(count: number): string {
  return count.toLocaleString(appRef?.getLocale?.() ?? undefined);
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

/**
 * The current map view as a [w, s, e, n] box. A view crossing the
 * antimeridian keeps west > east (the grid helpers split it); a view wider
 * than the world becomes the whole longitude range.
 */
function viewBbox(): LonLatBbox | null {
  const map = getControlMap(appRef);
  if (!map) return null;
  const bounds = map.getBounds();
  const clampLat = (value: number): number => Math.max(-90, Math.min(90, value));
  let west = normalizeLon(bounds.getWest());
  let east = normalizeLon(bounds.getEast());
  if (bounds.getEast() - bounds.getWest() >= 360) {
    west = -180;
    east = 180;
  }
  return [west, clampLat(bounds.getSouth()), east, clampLat(bounds.getNorth())];
}

/** Loads (once) and parses the zone index. */
function loadIndex(): Promise<FtwZoneFile[]> {
  indexPromise ??= loadFtwZoneIndex().catch((error: unknown) => {
    indexPromise = null;
    throw error;
  });
  return indexPromise;
}

/**
 * Opens a zone file (its footer), reusing a recent one. Not tied to a task's
 * signal: a cached reader outlives the task that opened it.
 */
function zoneReader(url: string): Promise<FtwZoneReader> {
  let reader = readers.get(url);
  if (reader) {
    readers.delete(url);
  } else {
    reader = openFtwZone(url).catch((error: unknown) => {
      readers.delete(url);
      throw error;
    });
  }
  readers.set(url, reader);
  while (readers.size > READER_CACHE_SIZE) {
    readers.delete(readers.keys().next().value as string);
  }
  return reader;
}

/** Waits for a promise, rejecting early with an AbortError when aborted. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Saves a generated blob through the host saver, or an anchor download.
 *
 * @returns False when the user cancelled the save dialog (the host saver
 *   resolves to null then).
 */
async function saveBlob(
  blob: Blob,
  options: { defaultName: string; extension: string; mimeType: string; description: string },
): Promise<boolean> {
  if (fileSaver) {
    return (await fileSaver(blob, options)) !== null;
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
  return true;
}

/** Fetches a file into memory, reporting progress as bytes arrive. */
async function fetchBlob(
  url: string,
  signal: AbortSignal,
  onProgress: (loaded: number, total: number | null) => void,
): Promise<Blob> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
  const length = Number(response.headers.get("content-length"));
  const total = Number.isFinite(length) && length > 0 ? length : null;
  if (!response.body) return response.blob();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(loaded, total);
  }
  return new Blob(chunks as BlobPart[]);
}

// ---------------------------------------------------------------------------
// Field layers and the threshold
// ---------------------------------------------------------------------------

/** Every store layer showing FTW fields (the global archive or a loaded area). */
function fieldLayers(): GeoLibreLayer[] {
  return useAppStore
    .getState()
    .layers.filter((layer) => typeof layer.metadata?.[FTW_FIELDS_METADATA_KEY] === "number");
}

/** Applies a score threshold to every FTW field layer's filter. */
function applyThreshold(threshold: number): void {
  const filter = scoreFilterExpression(threshold);
  const store = useAppStore.getState();
  for (const layer of fieldLayers()) {
    if (JSON.stringify(layer.filterExpression ?? null) === JSON.stringify(filter ?? null)) continue;
    store.updateLayer(layer.id, { filterExpression: filter });
  }
}

/**
 * The shared look of an FTW field layer: outlines and a faint fill colored by
 * score (the dataset's own bins), through the Style panel's expression mode so
 * it stays editable there.
 */
function fieldStyle(base: GeoLibreLayer["style"]): GeoLibreLayer["style"] {
  return {
    ...base,
    vectorStyleMode: "expression",
    vectorStyleExpression: JSON.stringify(scoreColorExpression()),
    fillOpacity: 0.2,
    strokeWidth: 1.25,
  };
}

/**
 * Adds the selected year's field polygons from the global archive, or says so
 * when that year is already on the map.
 */
function addFieldBoundaries(setStatus: (text: string, error?: boolean) => void): void {
  const year = state.year;
  const existing = fieldLayers().find(
    (layer) => layer.type === "pmtiles" && layer.metadata[FTW_FIELDS_METADATA_KEY] === year,
  );
  if (existing) {
    setStatus(tr("boundariesExists", "{{name}} is already on the map.", { name: existing.name }));
    return;
  }
  const archive = ftwFieldsLayer(year);
  const base = createPMTilesStoreLayer({
    id: crypto.randomUUID(),
    name: tr("boundariesLayerName", "FTW field boundaries {{year}}", { year }),
    url: archive.url,
    tileType: "vector",
    sourceLayers: [archive.sourceLayer],
    opacity: 0.9,
  });
  const filter = scoreFilterExpression(state.threshold);
  const layer: GeoLibreLayer = {
    ...base,
    style: fieldStyle(base.style),
    ...(filter ? { filterExpression: filter } : {}),
    metadata: {
      ...base.metadata,
      [FTW_FIELDS_METADATA_KEY]: year,
      attribution: ATTRIBUTION,
    },
  };
  useAppStore.getState().addLayer(layer);
  const zoom = getControlMap(appRef)?.getZoom() ?? 0;
  setStatus(
    zoom < archive.minZoom
      ? tr(
          "boundariesZoomIn",
          "Added {{name}}. Fields are drawn from zoom {{zoom}}; zoom in to see them, or add Field density for the overview.",
          { name: layer.name, zoom: archive.minZoom },
        )
      : tr("boundariesAdded", "Added {{name}}.", { name: layer.name }),
  );
}

/**
 * Adds the selected year's A5 cell summaries, colored by the share of each
 * cell covered by fields, for the zoomed-out picture.
 */
function addFieldDensity(setStatus: (text: string, error?: boolean) => void): void {
  const year = state.year;
  const existing = useAppStore
    .getState()
    .layers.find((layer) => layer.metadata?.[CELLS_METADATA_KEY] === year);
  if (existing) {
    setStatus(tr("boundariesExists", "{{name}} is already on the map.", { name: existing.name }));
    return;
  }
  const archive = ftwCellsLayer(year);
  const base = createPMTilesStoreLayer({
    id: crypto.randomUUID(),
    name: tr("cellsLayerName", "FTW field density {{year}}", { year }),
    url: archive.url,
    tileType: "vector",
    sourceLayers: [archive.sourceLayer],
    opacity: 0.8,
  });
  const layer: GeoLibreLayer = {
    ...base,
    style: {
      ...base.style,
      vectorStyleMode: "expression",
      vectorStyleExpression: JSON.stringify(coverageColorExpression()),
      fillOpacity: 0.8,
      strokeWidth: 0,
      // Like the dataset's own styles, hand over to the field polygons.
      maxZoom: CELLS_MAX_ZOOM,
    },
    metadata: {
      ...base.metadata,
      [CELLS_METADATA_KEY]: year,
      attribution: ATTRIBUTION,
    },
  };
  useAppStore.getState().addLayer(layer);
  setStatus(tr("boundariesAdded", "Added {{name}}.", { name: layer.name }));
}

// ---------------------------------------------------------------------------
// Map overlays
// ---------------------------------------------------------------------------

/**
 * Whether sources and layers can be added. Not `isStyleLoaded()`: that also
 * waits for every source to finish loading. Mapbox's `getStyle()` throws while
 * its style is loading.
 */
function styleReady(map: MapLibreMap): boolean {
  try {
    return Boolean(map.getStyle());
  } catch {
    return false;
  }
}

function emptyCollection(): FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

function handleFootprintClick(event: MapLayerMouseEvent): void {
  const ids = (event.features ?? [])
    .map((feature) => feature.properties?.id)
    .filter((id): id is string => typeof id === "string");
  if (ids.length > 0) onFootprintClick?.([...new Set(ids)]);
}

function handleFootprintEnter(event: MapLayerMouseEvent): void {
  event.target.getCanvas().style.cursor = "pointer";
}

function handleFootprintLeave(event: MapLayerMouseEvent): void {
  event.target.getCanvas().style.cursor = "";
}

/** Shows the result zones' parts of the search area, as one Layers-panel entry. */
function setFootprints(map: MapLibreMap, results: ZoneResult[]): void {
  if (!styleReady(map)) return;
  const features = results.map((result) =>
    polygonFeature(bboxRing(result.extent), { id: result.id, zone: result.zone.zone }),
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
      paint: { "fill-color": FOOTPRINT_COLOR, "fill-opacity": 0.05 },
    });
  }
  if (!map.getLayer(FOOTPRINT_LINE_LAYER_ID)) {
    map.addLayer({
      id: FOOTPRINT_LINE_LAYER_ID,
      type: "line",
      source: FOOTPRINT_SOURCE_ID,
      paint: { "line-color": FOOTPRINT_COLOR, "line-width": 1 },
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
  // Without host registration there is no store layer, and the store
  // subscription would read that as the user deleting the footprints.
  const register = appRef?.registerExternalNativeLayer;
  if (!register) return;
  register({
    id: FOOTPRINT_STORE_LAYER_ID,
    name: tr("zoneFootprintsLayer", "FTW search footprints"),
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
            fillOpacity: 0.05,
            strokeColor: FOOTPRINT_COLOR,
            strokeWidth: 1,
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

/** Outlines the given tiles (none clears the outline). */
function setOutline(map: MapLibreMap, boxes: LonLatBbox[]): void {
  if (!styleReady(map)) return;
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
  // Field layers added since would otherwise hide the outline.
  map.moveLayer(HOVER_LINE_LAYER_ID);
  (map.getSource(HOVER_SOURCE_ID) as GeoJSONSource).setData({
    type: "FeatureCollection",
    features: boxes.map((box) => polygonFeature(bboxRing(box), {})),
  });
}

function setDrawBox(map: MapLibreMap, bbox: LonLatBbox | null): void {
  if (!styleReady(map)) return;
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
  // MapLibre does not wrap event longitudes, so a box drawn on another world
  // copy is shifted back by whole worlds, and clamped at the antimeridian.
  const boxFrom = (a: LngLat, b: LngLat): LonLatBbox => {
    const west = Math.min(a.lng, b.lng);
    const offset = normalizeLon(west) - west;
    return [
      west + offset,
      Math.min(a.lat, b.lat),
      Math.min(Math.max(a.lng, b.lng) + offset, 180),
      Math.max(a.lat, b.lat),
    ];
  };
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
// Zone actions
// ---------------------------------------------------------------------------

/** A zone's two-digit number, as in its file name. */
function zoneLabel(zone: FtwZoneFile): string {
  return String(zone.zone).padStart(2, "0");
}

/**
 * Reads the fields of a zone that overlap the search area. A read whose row
 * groups pass `maxBytes` is refused up front; otherwise the groups stream in
 * and reading stops once more than `maxFeatures` fields are kept.
 */
async function readArea(
  result: ZoneResult,
  maxFeatures: number,
  maxBytes: number,
  setStatus: (text: string) => void,
  signal: AbortSignal,
): Promise<FeatureCollection> {
  const area = state.searchBbox;
  if (!area) throw new Error(tr("drawFirst", "Draw a box on the map first."));
  const zone = zoneLabel(result.zone);
  const reader = await untilAborted(zoneReader(result.zone.url), signal);
  const plan = planFtwRead(reader.metadata, area);
  if (plan.bytes > maxBytes) {
    throw new Error(
      tr(
        "tooMuchData",
        "The search area reads about {{size}} from UTM zone {{zone}} (limit {{limit}}). Draw a smaller box.",
        { size: formatBytes(plan.bytes), zone, limit: formatBytes(maxBytes) },
      ),
    );
  }
  setStatus(
    tr("readingZone", "Reading UTM zone {{zone}} (about {{size}})…", {
      zone,
      size: formatBytes(plan.bytes),
    }),
  );
  try {
    return await loadFtwAreaFeatures(reader, area, {
      maxFeatures,
      signal,
      onProgress: (done, total) =>
        setStatus(
          tr("readingZoneProgress", "Reading UTM zone {{zone}}… {{percent}}%", {
            zone,
            percent: Math.round((done / Math.max(1, total)) * 100),
          }),
        ),
    });
  } catch (error) {
    if (error instanceof FtwTooManyFieldsError) {
      throw new Error(
        tr(
          "tooManyInArea",
          "The search area holds more than {{limit}} fields in UTM zone {{zone}}. Draw a smaller box.",
          { limit: formatCount(maxFeatures), zone },
        ),
      );
    }
    throw error;
  }
}

/** Adds a zone's fields in the search area as a GeoJSON layer styled like the archive. */
async function addAreaToMap(
  result: ZoneResult,
  year: number,
  setStatus: (text: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const collection = await readArea(
    result,
    MAX_MAP_FEATURES,
    MAX_MAP_READ_BYTES,
    setStatus,
    signal,
  );
  signal.throwIfAborted();
  const app = appRef;
  if (!app) return;
  const zone = zoneLabel(result.zone);
  if (collection.features.length === 0) {
    setStatus(tr("noFieldsInZone", "No fields in the search area in UTM zone {{zone}}.", { zone }));
    return;
  }
  const name = tr("zoneLayerName", "FTW fields UTM {{zone}} {{year}}", { zone, year });
  const layerId = app.addGeoJsonLayer(name, collection);
  const store = useAppStore.getState();
  const layer = store.layers.find((candidate) => candidate.id === layerId);
  if (layer) {
    const filter = scoreFilterExpression(state.threshold);
    store.updateLayer(layerId, {
      style: fieldStyle(layer.style),
      filterExpression: filter,
      metadata: {
        ...layer.metadata,
        sourceKind: AREA_FIELDS_SOURCE_KIND,
        [FTW_FIELDS_METADATA_KEY]: year,
        utmZone: result.zone.zone,
        attribution: ATTRIBUTION,
      },
    });
  }
  setStatus(
    tr("zoneAdded", "Added {{count}} fields from UTM zone {{zone}}.", {
      count: formatCount(collection.features.length),
      zone,
    }),
  );
}

/**
 * Saves a zone's whole GeoParquet file. Most zones run to gigabytes, more than
 * a tab should hold; for those the URL is copied so DuckDB or GDAL can read
 * the file in place.
 */
async function downloadZoneParquet(
  result: ZoneResult,
  year: number,
  setStatus: (text: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const zone = zoneLabel(result.zone);
  const { url, sizeBytes } = result.zone;
  if (sizeBytes > MAX_PARQUET_SAVE_BYTES) {
    let copied = false;
    try {
      await navigator.clipboard.writeText(url);
      copied = true;
    } catch {
      // No clipboard access (an insecure context or a denied permission).
    }
    setStatus(
      copied
        ? tr(
            "parquetTooLarge",
            "UTM zone {{zone}}'s file is {{size}}, too large to save from here. Its URL is copied to the clipboard; DuckDB or GDAL can read it in place.",
            { zone, size: formatBytes(sizeBytes) },
          )
        : tr(
            "parquetTooLargeUrl",
            "UTM zone {{zone}}'s file is {{size}}, too large to save from here. DuckDB or GDAL can read it in place: {{url}}",
            { zone, size: formatBytes(sizeBytes), url },
          ),
    );
    return;
  }
  const defaultName = `ftw-fields-${year}-utm${zone}.parquet`;
  const blob = await fetchBlob(url, signal, (loaded, total) =>
    setStatus(
      tr("downloadingProgress", "Downloading {{name}}… {{loaded}}{{total}}", {
        name: defaultName,
        loaded: formatBytes(loaded),
        total: total ? ` / ${formatBytes(total)}` : "",
      }),
    ),
  );
  signal.throwIfAborted();
  const saved = await saveBlob(blob, {
    defaultName,
    extension: "parquet",
    mimeType: "application/vnd.apache.parquet",
    description: "GeoParquet",
  });
  if (!saved) {
    setStatus(tr("saveCancelled", "Save cancelled."));
    return;
  }
  setStatus(
    tr("saved", "Saved {{name}} ({{size}}).", { name: defaultName, size: formatBytes(blob.size) }),
  );
}

/** Converts a zone's fields in the search area to GeoJSON and saves them. */
async function downloadAreaGeoJson(
  result: ZoneResult,
  year: number,
  setStatus: (text: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const collection = await readArea(
    result,
    MAX_GEOJSON_FEATURES,
    MAX_GEOJSON_READ_BYTES,
    setStatus,
    signal,
  );
  signal.throwIfAborted();
  const defaultName = `ftw-fields-${year}-utm${zoneLabel(result.zone)}-clip.geojson`;
  // One JSON.stringify of up to a million polygons can pass V8's maximum
  // string length; a Blob joins per-feature strings without one big string.
  const parts: string[] = ['{"type":"FeatureCollection","features":['];
  collection.features.forEach((feature, index) => {
    parts.push(index === 0 ? JSON.stringify(feature) : `,${JSON.stringify(feature)}`);
  });
  parts.push("]}");
  const blob = new Blob(parts, { type: "application/geo+json" });
  const saved = await saveBlob(blob, {
    defaultName,
    extension: "geojson",
    mimeType: "application/geo+json",
    description: "GeoJSON",
  });
  if (!saved) {
    setStatus(tr("saveCancelled", "Save cancelled."));
    return;
  }
  setStatus(
    tr("savedFields", "Saved {{count}} fields to {{name}} ({{size}}).", {
      count: formatCount(collection.features.length),
      name: defaultName,
      size: formatBytes(blob.size),
    }),
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

function link(text: string, href: string): HTMLAnchorElement {
  const anchor = element("a", CSS.link, text);
  anchor.href = href;
  anchor.target = "_blank";
  anchor.rel = "noopener";
  return anchor;
}

/** What FTW is, as a collapsible card (collapsed by default). */
function datasetInfo(): HTMLElement {
  const box = element("details", CSS.info);
  box.open = state.infoExpanded;
  box.addEventListener("toggle", () => {
    state.infoExpanded = box.open;
  });
  box.append(element("summary", CSS.infoSummary, tr("infoSummary", "About Fields of the World")));
  box.append(
    element(
      "p",
      CSS.infoText,
      tr(
        "infoTextV2",
        "Agricultural field boundaries predicted from Sentinel-2 quarterly mosaics by the Fields of the World model (2nd Edition): about 1.24 billion fields over nine years, each with a 0–100 score. These are model predictions, not surveyed or legal parcels.",
      ),
    ),
  );
  const grid = element("div", CSS.infoGrid);
  const add = (key: string, value: string): void => {
    grid.append(element("span", CSS.infoKey, key), element("span", "", value));
  };
  add(tr("infoYears", "Years"), `${FTW_YEARS[0]}–${FTW_YEARS[FTW_YEARS.length - 1]}`);
  add(tr("infoCoverage", "Coverage"), tr("infoCoverageValue", "Global croplands"));
  add(tr("infoFiles", "Downloads"), tr("infoFilesValue", "GeoParquet per UTM zone"));
  add(tr("infoLicense", "License"), FTW_LICENSE);
  box.append(grid);
  const links = element("div", CSS.links);
  links.append(
    link(tr("website", "Website"), FTW_WEBSITE_URL),
    link(tr("interactiveMap", "Interactive map"), FTW_MAP_URL),
    link(tr("dataSource", "Data source"), FTW_DATA_URL),
    link(tr("paper", "Paper"), FTW_PAPER_URL),
  );
  box.append(links);
  box.append(element("p", CSS.attribution, ATTRIBUTION));
  return box;
}

/**
 * A legend strip for stepped color bins: one equal-width swatch per bin,
 * labeled with the value it starts at.
 */
function binLegend(bins: ReadonlyArray<{ min: number; color: string }>, unit = ""): HTMLElement {
  const legend = element("div", CSS.legend);
  // A numeric scale: keep the swatches and labels in the same order under RTL.
  legend.dir = "ltr";
  const ramp = element("div", CSS.legendRamp);
  const width = 100 / bins.length;
  ramp.style.background = `linear-gradient(to right, ${bins
    .map((bin, index) => `${bin.color} ${index * width}% ${(index + 1) * width}%`)
    .join(", ")})`;
  const labels = element("div", CSS.legendLabels);
  for (const bin of bins) {
    labels.append(element("span", "flex:1 1 0;text-align:start;", `${bin.min}${unit}`));
  }
  legend.append(ramp, labels);
  return legend;
}

function buildPanel(container: HTMLElement): () => void {
  container.replaceChildren();
  container.style.cssText = CSS.panel;
  let disposed = false;
  let controller: AbortController | null = null;
  let cancelDraw: (() => void) | null = null;
  let thresholdTimer: ReturnType<typeof setTimeout> | null = null;

  // Pick the threshold back up from a field layer already on the map (a
  // restored project), when its filter is one this panel wrote.
  const restored = fieldLayers()
    .map((layer) => thresholdFromFilter(layer.filterExpression))
    .find((value): value is number => value !== null);
  if (restored !== undefined) state.threshold = restored;

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
        "Visualize, search, and download Fields of the World agricultural field boundaries.",
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

  const clearResults = (): void => {
    state.results = [];
    state.selectedIds = [];
    const map = getControlMap(appRef);
    if (map) {
      setFootprints(map, []);
      setOutline(map, []);
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
    const year = state.year;
    void runTask(async (signal) => {
      try {
        setStatus(tr("searching", "Searching…"));
        const index = await untilAborted(loadIndex(), signal);
        if (disposed) return;
        const zones = searchFtwZones(index, bbox, year);
        if (zones.length > MAX_SEARCH_ZONES) {
          throw new Error(
            tr(
              "tooManyZones",
              "The search area spans {{count}} UTM zones (limit {{limit}}). Zoom in or draw a smaller box.",
              { count: zones.length, limit: MAX_SEARCH_ZONES },
            ),
          );
        }
        // Each zone's footer says which of its row groups overlap the area.
        const results: ZoneResult[] = [];
        for (const zone of zones) {
          setStatus(
            tr("openingZone", "Reading the index of UTM zone {{zone}}…", { zone: zoneLabel(zone) }),
          );
          const reader = await untilAborted(zoneReader(zone.url), signal);
          if (disposed) return;
          const plan = planFtwRead(reader.metadata, bbox);
          if (plan.groups.length === 0 || !plan.extent) continue;
          results.push({
            id: `utm${zoneLabel(zone)}`,
            zone,
            readBytes: plan.bytes,
            extent: plan.extent,
          });
        }
        state.searchBbox = bbox;
        state.searchYear = year;
        state.results = results;
        state.selectedIds = [];
        const map = getControlMap(appRef);
        if (map) {
          setFootprints(map, results);
          setOutline(map, []);
        }
        setStatus(
          results.length === 0
            ? tr(
                "noFields",
                "No FTW fields for {{year}} in this area. Only croplands were processed, so an empty area may simply not have been mapped.",
                { year },
              )
            : tr("foundZones", "Found fields in UTM zone {{zones}}.", {
                zones: results.map((result) => zoneLabel(result.zone)).join(", "),
              }),
        );
      } catch (error) {
        // The old rows and footprints would describe a different area than
        // the error does.
        if (!disposed) clearResults();
        throw error;
      }
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

  const rowElements = new Map<string, HTMLElement>();

  // The map outline follows the selection; a hovered row previews its own.
  const showSelection = (): void => {
    const map = getControlMap(appRef);
    if (!map) return;
    setOutline(
      map,
      state.results
        .filter((result) => state.selectedIds.includes(result.id))
        .map((result) => result.extent),
    );
  };

  const select = (ids: string[], scroll: boolean): void => {
    state.selectedIds = ids.filter((id) => rowElements.has(id));
    for (const [id, rowElement] of rowElements) {
      rowElement.style.cssText = CSS.row + (state.selectedIds.includes(id) ? CSS.rowSelected : "");
    }
    showSelection();
    if (scroll) rowElements.get(state.selectedIds[0])?.scrollIntoView({ block: "nearest" });
  };
  onFootprintClick = (ids: string[]): void => select(ids, true);

  function render(): void {
    if (disposed) return;
    body.replaceChildren();
    rowElements.clear();
    body.append(datasetInfo());

    const yearSelect = element("select", CSS.input);
    for (const year of [...FTW_YEARS].reverse()) {
      const option = element("option", undefined, String(year));
      option.value = String(year);
      option.selected = state.year === year;
      yearSelect.append(option);
    }
    yearSelect.addEventListener("change", () => {
      state.year = Number(yearSelect.value) as FtwYear;
    });
    body.append(labeled(tr("year", "Year"), yearSelect));

    // --- Map layers ---------------------------------------------------------
    const layersSection = element("div", CSS.section);
    layersSection.append(element("div", CSS.sectionTitle, tr("mapLayers", "Map layers")));
    const layerButtons = element("div", CSS.grid2);
    layerButtons.append(
      button(
        tr("addBoundaries", "Field boundaries"),
        CSS.secondary,
        () => addFieldBoundaries((text, error) => setStatus(text, error)),
        tr(
          "addBoundariesHint",
          "Add the year's field boundaries, colored by score. They are drawn from zoom 9.",
        ),
      ),
      button(
        tr("addDensity", "Field density"),
        CSS.secondary,
        () => addFieldDensity((text, error) => setStatus(text, error)),
        tr(
          "addDensityHint",
          "Add the share of land covered by the year's fields, for views zoomed out past zoom 9",
        ),
      ),
    );
    layersSection.append(
      layerButtons,
      element("div", CSS.label, tr("densityLegend", "Field density (% of area in fields)")),
      binLegend(FTW_COVERAGE_BINS, "%"),
    );

    const slider = element("input", CSS.slider);
    slider.type = "range";
    slider.min = "0";
    slider.max = "100";
    slider.step = "1";
    slider.value = String(state.threshold);
    const sliderValue = element("span", CSS.sliderValue, String(state.threshold));
    slider.addEventListener("input", () => {
      state.threshold = Number(slider.value);
      sliderValue.textContent = String(state.threshold);
      if (thresholdTimer) clearTimeout(thresholdTimer);
      thresholdTimer = setTimeout(() => {
        thresholdTimer = null;
        applyThreshold(state.threshold);
      }, THRESHOLD_DEBOUNCE_MS);
    });
    slider.setAttribute("aria-label", tr("scoreThreshold", "Score threshold"));
    const sliderRow = element("div", CSS.sliderRow);
    sliderRow.append(slider, sliderValue);
    const thresholdLabel = element("div", CSS.label, tr("scoreThreshold", "Score threshold"));
    thresholdLabel.append(sliderRow);
    layersSection.append(
      thresholdLabel,
      element(
        "p",
        CSS.hint,
        tr(
          "scoreThresholdHint",
          "Hides fields scoring below this on every FTW field layer. The score is the model's mean field probability × 100, a ranking rather than a calibrated probability. Downloads always include every field.",
        ),
      ),
      binLegend(FTW_SCORE_BINS),
    );
    body.append(layersSection);

    // --- Search -------------------------------------------------------------
    const searchSection = element("div", CSS.section);
    searchSection.append(
      element("div", CSS.sectionTitle, tr("searchDownload", "Search and download")),
    );
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
          const map = getControlMap(appRef);
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
    searchSection.append(
      element(
        "p",
        CSS.hint,
        tr(
          "searchHint",
          "Fields are read straight from each UTM zone's GeoParquet file, fetching only the parts that overlap the search area.",
        ),
      ),
    );
    const searchButton = button(
      state.busy ? tr("working", "Working…") : tr("searchArea", "Search area"),
      CSS.primary,
      search,
    );
    searchButton.disabled = state.busy;
    searchSection.append(searchButton);
    body.append(searchSection);

    body.append(statusBox);
    renderStatus();

    // --- Results ------------------------------------------------------------
    if (state.results.length > 0) {
      const year = state.searchYear;
      const statusSetter = (text: string): void => setStatus(text);
      const list = element("div", CSS.list);
      for (const result of state.results) {
        const rowElement = element(
          "div",
          CSS.row + (state.selectedIds.includes(result.id) ? CSS.rowSelected : ""),
        );
        rowElement.append(
          element(
            "div",
            CSS.rowTitle,
            tr("rowTitle", "UTM zone {{zone}} · {{year}}", { zone: zoneLabel(result.zone), year }),
          ),
          element(
            "div",
            CSS.rowSubtitle,
            tr("rowDetail", "Reads about {{read}} · zone file {{file}}", {
              read: formatBytes(result.readBytes),
              file: formatBytes(result.zone.sizeBytes),
            }),
          ),
        );
        const actions = element("div", CSS.rowActions);
        actions.append(
          taskButton(
            tr("addToMap", "Add to map"),
            (signal) => addAreaToMap(result, year, statusSetter, signal),
            tr(
              "addToMapHint",
              "Add this zone's fields in the search area to the map as an editable vector layer",
            ),
          ),
          taskButton(
            tr("downloadGeoJson", "GeoJSON"),
            (signal) => downloadAreaGeoJson(result, year, statusSetter, signal),
            tr("downloadGeoJsonHint", "Save this zone's fields in the search area as GeoJSON"),
          ),
          taskButton(
            tr("downloadParquet", "GeoParquet"),
            (signal) => downloadZoneParquet(result, year, statusSetter, signal),
            tr(
              "downloadParquetHint",
              "Save this UTM zone's whole GeoParquet file, or copy its URL when it is too large to save",
            ),
          ),
          button(tr("zoom", "Zoom"), CSS.action, () => appRef?.fitBounds?.(result.extent)),
        );
        rowElement.append(actions);
        rowElement.addEventListener("mouseenter", () => {
          const map = getControlMap(appRef);
          if (map) setOutline(map, [result.extent]);
        });
        rowElement.addEventListener("mouseleave", showSelection);
        // Selecting a row from the list; its buttons act without selecting.
        rowElement.addEventListener("click", (event) => {
          if ((event.target as HTMLElement).closest("button")) return;
          select([result.id], false);
        });
        rowElements.set(result.id, rowElement);
        list.append(rowElement);
      }
      body.append(list);
    }
    showSelection();
  }

  render();

  // Drop our footprint bookkeeping when the user deletes that layer.
  const unsubscribe = useAppStore.subscribe((store) => {
    if (
      footprintsRegistered &&
      !store.layers.some((layer) => layer.id === FOOTPRINT_STORE_LAYER_ID)
    ) {
      footprintsRegistered = false;
      removeFootprints(getControlMap(appRef));
    }
  });

  return () => {
    disposed = true;
    controller?.abort();
    controller = null;
    // The aborted task belonged to this panel; the next panel starts idle.
    state.busy = false;
    if (thresholdTimer) {
      clearTimeout(thresholdTimer);
      thresholdTimer = null;
      applyThreshold(state.threshold);
    }
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

/** Clears every map overlay the plugin owns (not the layers it added). */
function clearOverlays(app: GeoLibreAppAPI): void {
  const map = getControlMap(app);
  removeFootprints(map);
  removeChrome(map);
}

/**
 * Fields of the World plugin: the FTW 2nd Edition global agricultural field
 * boundaries (2017–2025) on the map, colored and filtered by the model's
 * score, plus per-year field-density cells for zoomed-out views; a search of
 * the per-UTM-zone GeoParquet files by map view or drawn box; and loading the
 * area's fields onto the map or into GeoJSON, reading only the row groups that
 * overlap it.
 */
export const maplibreFieldsOfTheWorldPlugin: GeoLibrePlugin = {
  id: FIELDS_OF_THE_WORLD_PLUGIN_ID,
  name: "Fields of the World",
  version: "0.2.0",
  // The field layers are PMTiles and GeoJSON store layers and the footprints
  // are Style Spec sources and layers, so both 2D engines host them, and the
  // host's control map draws them on ArcGIS.
  engines: ["maplibre", "mapbox", "arcgis"],
  activate: (app) => {
    appRef = app;
    unregisterPanel =
      app.registerRightPanel?.({
        id: PANEL_ID,
        title: () => tr("title", "Fields of the World"),
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
    appRef = null;
  },
};

export default maplibreFieldsOfTheWorldPlugin;
