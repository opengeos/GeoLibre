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
  FTW_APP_URL,
  FTW_COG_NODATA,
  FTW_COG_RANGE,
  FTW_CONFIDENCE_STOPS,
  FTW_DATA_URL,
  FTW_DEFAULT_THRESHOLD,
  FTW_DEFAULT_YEAR,
  FTW_DENSITY_COG_URL,
  FTW_DOWNLOAD_GRID_URL,
  FTW_LICENSE,
  FTW_PAPER_URL,
  FTW_WEBSITE_URL,
  FTW_YEARS,
  FtwTooManyFieldsError,
  type FtwGridTile,
  type FtwYear,
  clipCoversTile,
  confidenceColorExpression,
  confidenceFilterExpression,
  ftwArchive,
  ftwTileParquetUrl,
  loadFtwTileFeatures,
  parseFtwDownloadGrid,
  searchFtwGrid,
  thresholdFromFilter,
} from "./fields-of-the-world-data";
import { type LonLatBbox, bboxRing, polygonFeature } from "./satellite-embeddings-grids";
import { getStyleMap } from "./style-map";

export const FIELDS_OF_THE_WORLD_PLUGIN_ID = "geolibre-fields-of-the-world";
const PANEL_ID = FIELDS_OF_THE_WORLD_PLUGIN_ID;

/** Most fields added to the map as one GeoJSON layer. */
const MAX_MAP_FEATURES = 250_000;
/** Most fields written to one GeoJSON file. */
const MAX_GEOJSON_FEATURES = 1_000_000;
/** Zoom above which the field-density raster is hidden. */
const DENSITY_MAX_ZOOM = 12;
/** Delay before a threshold drag is written to the layers. */
const THRESHOLD_DEBOUNCE_MS = 150;

/** `metadata.sourceKind` of the layers this plugin adds (PMTiles keep their own). */
const TILE_FIELDS_SOURCE_KIND = "fields-of-the-world-tile";
/**
 * Marks the field-density COG. Not `sourceKind`: the raster control owns that
 * (`maplibre-gl-raster`), and the raster sync, Style panel and Mapbox COG path
 * all key on it.
 */
const DENSITY_METADATA_KEY = "ftwFieldDensity";
const FOOTPRINT_SOURCE_KIND = "fields-of-the-world-footprints";
/**
 * Marks a field layer (the global archive or a loaded tile) whose threshold
 * filter the panel drives. Its value is the year.
 */
const FTW_FIELDS_METADATA_KEY = "ftwFieldsYear";

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
  checkbox: "display:flex;align-items:center;gap:6px;font-size:11px;",
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

/**
 * Panel state. Kept at module scope so a rebuild (a language change) restores
 * the search instead of wiping it; reset when the plugin deactivates.
 */
interface PanelState {
  year: FtwYear;
  /** Confidence threshold in percent, applied to every FTW field layer. */
  threshold: number;
  mode: SearchMode;
  drawnBbox: LonLatBbox | null;
  /** The box the current results were searched with. */
  searchBbox: LonLatBbox | null;
  /** The year the current results were searched for. */
  searchYear: FtwYear;
  results: FtwGridTile[];
  total: number;
  /** Whether tile loads and GeoJSON exports keep only fields in the search box. */
  clipToSearch: boolean;
  status: { text: string; error: boolean } | null;
  busy: boolean;
  infoExpanded: boolean;
  /** Tiles selected by a footprint or row click, outlined on the map. */
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
    total: 0,
    clipToSearch: true,
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
/** The parsed download grid, fetched once per session (~5.6 MB). */
let gridPromise: Promise<FtwGridTile[]> | null = null;

/** Resolves a plugin-namespaced translation key, falling back to English text. */
function tr(key: string, fallback: string, params?: Record<string, string | number>): string {
  return (
    appRef?.translate?.(`plugin.${FIELDS_OF_THE_WORLD_PLUGIN_ID}.${key}`, fallback, params) ??
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
  const map = getStyleMap(appRef);
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

/** Loads (once) and parses the 1° download grid. */
function loadGrid(): Promise<FtwGridTile[]> {
  gridPromise ??= fetch(FTW_DOWNLOAD_GRID_URL)
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status} loading the FTW download grid`);
      return parseFtwDownloadGrid(await response.json());
    })
    .catch((error: unknown) => {
      gridPromise = null;
      throw error;
    });
  return gridPromise;
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

/** Every store layer showing FTW fields (the global archive or a loaded tile). */
function fieldLayers(): GeoLibreLayer[] {
  return useAppStore
    .getState()
    .layers.filter((layer) => typeof layer.metadata?.[FTW_FIELDS_METADATA_KEY] === "number");
}

/** Applies a threshold to every FTW field layer's filter. */
function applyThreshold(percent: number): void {
  const filter = confidenceFilterExpression(percent);
  const store = useAppStore.getState();
  for (const layer of fieldLayers()) {
    if (JSON.stringify(layer.filterExpression ?? null) === JSON.stringify(filter ?? null)) continue;
    store.updateLayer(layer.id, { filterExpression: filter });
  }
}

/**
 * The shared look of an FTW field layer: outlines and a faint fill colored by
 * confidence (the FTW app's ramp), through the Style panel's expression mode
 * so it stays editable there.
 */
function fieldStyle(base: GeoLibreLayer["style"]): GeoLibreLayer["style"] {
  return {
    ...base,
    vectorStyleMode: "expression",
    vectorStyleExpression: JSON.stringify(confidenceColorExpression()),
    fillOpacity: 0.2,
    strokeWidth: 1.25,
  };
}

/**
 * Adds the global field-boundary archive for the selected year, or says so
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
  const archive = ftwArchive(year);
  const base = createPMTilesStoreLayer({
    id: crypto.randomUUID(),
    name: tr("boundariesLayerName", "FTW field boundaries {{year}}", { year }),
    url: archive.url,
    tileType: "vector",
    sourceLayers: [archive.sourceLayer],
    opacity: 0.9,
  });
  const filter = confidenceFilterExpression(state.threshold);
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
  const zoom = getStyleMap(appRef)?.getZoom() ?? 0;
  setStatus(
    zoom < archive.minZoom
      ? tr(
          "boundariesAddedZoomIn",
          "Added {{name}}. This year's archive starts at zoom {{zoom}}; zoom in to see fields.",
          { name: layer.name, zoom: archive.minZoom },
        )
      : tr("boundariesAdded", "Added {{name}}.", { name: layer.name }),
  );
}

/** Adds the global 500 m field-density COG, for the zoomed-out picture. */
async function addFieldDensity(
  setStatus: (text: string, error?: boolean) => void,
  signal: AbortSignal,
): Promise<void> {
  const app = appRef;
  if (!app?.addCogLayer)
    throw new Error(tr("cogUnavailable", "COG layers are not available here."));
  if (
    useAppStore.getState().layers.some((layer) => layer.metadata?.[DENSITY_METADATA_KEY] === true)
  ) {
    setStatus(tr("densityExists", "The field density layer is already on the map."));
    return;
  }
  setStatus(tr("densityAdding", "Adding the field density layer…"));
  const name = tr("densityLayerName", "FTW field density (500 m)");
  // addCogLayer takes no signal, so an abort is only honored before it starts.
  signal.throwIfAborted();
  const id = await app.addCogLayer(name, FTW_DENSITY_COG_URL, {
    engine: "auto",
    bands: "1",
    // One of the names every COG engine draws (the WASM tiler knows a subset
    // and falls back to gray for the rest).
    colormap: "greens",
    rescaleMin: FTW_COG_RANGE[0],
    rescaleMax: FTW_COG_RANGE[1],
    nodata: FTW_COG_NODATA,
    opacity: 0.8,
    // The raster is global; fitting to it would zoom the map out to the world.
    zoomTo: false,
  });
  // The layer exists now, so finish configuring it even if the task was
  // aborted meanwhile; an unmarked layer would escape the duplicate check and
  // never hide above DENSITY_MAX_ZOOM.
  const store = useAppStore.getState();
  const layer = store.layers.find((candidate) => candidate.id === id);
  if (layer) {
    store.updateLayer(id, {
      // Like the FTW app, hand over to the field boundaries once zoomed in.
      style: { ...layer.style, maxZoom: DENSITY_MAX_ZOOM },
      metadata: { ...layer.metadata, [DENSITY_METADATA_KEY]: true, attribution: ATTRIBUTION },
    });
  }
  if (!signal.aborted) setStatus(tr("densityAdded", "Added {{name}}.", { name }));
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

/** Shows the result tiles, registered as one Layers-panel entry. */
function setFootprints(map: MapLibreMap, tiles: FtwGridTile[], year: number): void {
  if (!styleReady(map)) return;
  const features = tiles.map((tile) =>
    polygonFeature(bboxRing(tile.bbox), {
      id: tile.id,
      fields: tile.featureCounts[String(year)] ?? 0,
    }),
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
    name: tr("footprintsLayer", "FTW download tiles"),
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
// Tile actions
// ---------------------------------------------------------------------------

/** The area to keep from a tile, or null for the whole tile. */
function clipBox(): LonLatBbox | null {
  return state.clipToSearch ? state.searchBbox : null;
}

/**
 * Reads a tile's fields. A read that would keep every field (no clip, or a
 * clip covering the tile) is refused up front when the grid's count is over
 * `maxFeatures`; a partial clip streams the file and stops once it passes.
 */
async function readTile(
  tile: FtwGridTile,
  year: number,
  maxFeatures: number,
  setStatus: (text: string) => void,
  signal: AbortSignal,
): Promise<FeatureCollection> {
  const size = tile.sizeBytes[String(year)] ?? 0;
  const count = tile.featureCounts[String(year)] ?? 0;
  const searchClip = clipBox();
  const clip = searchClip && !clipCoversTile(searchClip, tile) ? searchClip : null;
  if (!clip && count > maxFeatures) {
    throw new Error(
      searchClip
        ? tr(
            "tooManyFieldsInArea",
            "The search area covers all {{count}} fields of this tile (limit {{limit}}). Draw a smaller box, or download the GeoParquet.",
            { count: formatCount(count), limit: formatCount(maxFeatures) },
          )
        : tr(
            "tooManyFields",
            "This tile has {{count}} fields (limit {{limit}}). Turn on “Only fields in the search area” with a smaller box, or download the GeoParquet.",
            { count: formatCount(count), limit: formatCount(maxFeatures) },
          ),
    );
  }
  setStatus(
    tr("readingTile", "Reading {{tile}} ({{size}})…", { tile: tile.id, size: formatBytes(size) }),
  );
  try {
    return await loadFtwTileFeatures(ftwTileParquetUrl(year, tile.id), {
      clip,
      maxFeatures,
      signal,
      onProgress: (rowsRead, totalRows) =>
        setStatus(
          tr("readingTileProgress", "Reading {{tile}}… {{percent}}%", {
            tile: tile.id,
            percent: Math.round((rowsRead / Math.max(1, totalRows)) * 100),
          }),
        ),
    });
  } catch (error) {
    if (error instanceof FtwTooManyFieldsError) {
      throw new Error(
        tr(
          "tooManyClipped",
          "The search area holds more than {{limit}} fields in this tile. Draw a smaller box, or download the GeoParquet.",
          { limit: formatCount(maxFeatures) },
        ),
      );
    }
    throw error;
  }
}

/** Adds a tile's fields to the map as a GeoJSON layer styled like the archive. */
async function addTileToMap(
  tile: FtwGridTile,
  year: number,
  setStatus: (text: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const collection = await readTile(tile, year, MAX_MAP_FEATURES, setStatus, signal);
  signal.throwIfAborted();
  const app = appRef;
  if (!app) return;
  if (collection.features.length === 0) {
    setStatus(tr("noFieldsInArea", "No fields in the search area in {{tile}}.", { tile: tile.id }));
    return;
  }
  const name = tr("tileLayerName", "FTW fields {{tile}} {{year}}", { tile: tile.id, year });
  const layerId = app.addGeoJsonLayer(name, collection);
  const store = useAppStore.getState();
  const layer = store.layers.find((candidate) => candidate.id === layerId);
  if (layer) {
    const filter = confidenceFilterExpression(state.threshold);
    store.updateLayer(layerId, {
      style: fieldStyle(layer.style),
      filterExpression: filter,
      metadata: {
        ...layer.metadata,
        sourceKind: TILE_FIELDS_SOURCE_KIND,
        [FTW_FIELDS_METADATA_KEY]: year,
        tileId: tile.id,
        attribution: ATTRIBUTION,
      },
    });
  }
  setStatus(
    tr("tileAdded", "Added {{count}} fields from {{tile}}.", {
      count: formatCount(collection.features.length),
      tile: tile.id,
    }),
  );
}

/** Saves a tile's source GeoParquet file. */
async function downloadTileParquet(
  tile: FtwGridTile,
  year: number,
  setStatus: (text: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const defaultName = `ftw-fields-${tile.id}-${year}.parquet`;
  const blob = await fetchBlob(ftwTileParquetUrl(year, tile.id), signal, (loaded, total) =>
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

/** Converts a tile's fields to GeoJSON and saves them. */
async function downloadTileGeoJson(
  tile: FtwGridTile,
  year: number,
  setStatus: (text: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const collection = await readTile(tile, year, MAX_GEOJSON_FEATURES, setStatus, signal);
  signal.throwIfAborted();
  const clipped = clipBox() !== null;
  const defaultName = `ftw-fields-${tile.id}-${year}${clipped ? "-clip" : ""}.geojson`;
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
        "infoText",
        "Agricultural field boundaries predicted worldwide from Sentinel-2 imagery by the FTW PRUE model, with a per-field confidence score.",
      ),
    ),
  );
  const grid = element("div", CSS.infoGrid);
  const add = (key: string, value: string): void => {
    grid.append(element("span", CSS.infoKey, key), element("span", "", value));
  };
  add(tr("infoYears", "Years"), FTW_YEARS.join(", "));
  add(tr("infoCoverage", "Coverage"), tr("infoCoverageValue", "Global croplands"));
  add(tr("infoTiles", "Download tiles"), tr("infoTilesValue", "1° × 1° GeoParquet"));
  add(tr("infoLicense", "License"), FTW_LICENSE);
  box.append(grid);
  const links = element("div", CSS.links);
  links.append(
    link(tr("website", "Website"), FTW_WEBSITE_URL),
    link(tr("inferenceApp", "Inference app"), FTW_APP_URL),
    link(tr("dataSource", "Data source"), FTW_DATA_URL),
    link(tr("paper", "Paper"), FTW_PAPER_URL),
  );
  box.append(links);
  box.append(element("p", CSS.attribution, ATTRIBUTION));
  return box;
}

/** A legend strip for the confidence colors. */
function confidenceLegend(): HTMLElement {
  const legend = element("div", CSS.legend);
  const ramp = element("div", CSS.legendRamp);
  ramp.style.background = `linear-gradient(to right, ${FTW_CONFIDENCE_STOPS.map(
    (stop) => `${stop.color} ${stop.percent}%`,
  ).join(", ")})`;
  const labels = element("div", CSS.legendLabels);
  labels.append(
    element("span", "", tr("legendLow", "Low confidence")),
    element("span", "", tr("legendHigh", "High")),
  );
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
      setStatus(tr("searching", "Searching…"));
      const grid = await loadGrid();
      if (signal.aborted || disposed) return;
      const { tiles, total } = searchFtwGrid(grid, bbox, year);
      state.searchBbox = bbox;
      state.searchYear = year;
      state.results = tiles;
      state.total = total;
      state.selectedIds = [];
      const map = getStyleMap(appRef);
      if (map) {
        setFootprints(map, tiles, year);
        setOutline(map, []);
      }
      const fields = tiles.reduce((sum, tile) => sum + (tile.featureCounts[String(year)] ?? 0), 0);
      setStatus(
        tiles.length === 0
          ? tr("noResults", "No FTW tiles for {{year}} in this area.", { year })
          : total > tiles.length
            ? tr("showingSome", "Showing the {{shown}} tiles with the most fields, of {{total}}.", {
                shown: tiles.length,
                total,
              })
            : tr("showing", "Found {{count}} tiles with {{fields}} fields.", {
                count: tiles.length,
                fields: formatCount(fields),
              }),
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

  const rowElements = new Map<string, HTMLElement>();

  // The map outline follows the selection; a hovered row previews its own.
  const showSelection = (): void => {
    const map = getStyleMap(appRef);
    if (!map) return;
    setOutline(
      map,
      state.results.filter((tile) => state.selectedIds.includes(tile.id)).map((tile) => tile.bbox),
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
    // Disabled while any task runs, like the row actions: a second click during
    // addCogLayer would pass the duplicate check before the first layer lands.
    const densityButton = button(
      tr("addDensity", "Field density"),
      CSS.secondary,
      () => void runTask((signal) => addFieldDensity((text) => setStatus(text), signal)),
      tr("addDensityTitle", "Add the global 500 m field-density raster, for zoomed-out views"),
    );
    densityButton.disabled = state.busy;
    const layerButtons = element("div", CSS.grid2);
    layerButtons.append(
      button(
        tr("addBoundaries", "Field boundaries"),
        CSS.secondary,
        () => addFieldBoundaries((text, error) => setStatus(text, error)),
        tr(
          "addBoundariesTitle",
          "Add the global field boundaries for the year, colored by confidence",
        ),
      ),
      densityButton,
    );
    layersSection.append(layerButtons);

    const slider = element("input", CSS.slider);
    slider.type = "range";
    slider.min = "0";
    slider.max = "100";
    slider.step = "1";
    slider.value = String(state.threshold);
    const sliderValue = element("span", CSS.sliderValue, `${state.threshold}%`);
    slider.addEventListener("input", () => {
      state.threshold = Number(slider.value);
      sliderValue.textContent = `${state.threshold}%`;
      if (thresholdTimer) clearTimeout(thresholdTimer);
      thresholdTimer = setTimeout(() => {
        thresholdTimer = null;
        applyThreshold(state.threshold);
      }, THRESHOLD_DEBOUNCE_MS);
    });
    slider.setAttribute("aria-label", tr("threshold", "Confidence threshold"));
    const sliderRow = element("div", CSS.sliderRow);
    sliderRow.append(slider, sliderValue);
    const thresholdLabel = element("div", CSS.label, tr("threshold", "Confidence threshold"));
    thresholdLabel.append(sliderRow);
    layersSection.append(
      thresholdLabel,
      element(
        "p",
        CSS.hint,
        tr(
          "thresholdHint",
          "Shows only fields the model is at least this confident about, on every FTW field layer. Downloads always include every field.",
        ),
      ),
      confidenceLegend(),
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
    const clip = element("input");
    clip.type = "checkbox";
    clip.checked = state.clipToSearch;
    clip.addEventListener("change", () => {
      state.clipToSearch = clip.checked;
    });
    const clipLabel = element("label", CSS.checkbox);
    clipLabel.title = tr(
      "clipTitle",
      "Add to map and GeoJSON keep only fields overlapping the search area; GeoParquet is always the whole tile",
    );
    clipLabel.append(clip, tr("clip", "Only fields in the search area"));
    searchSection.append(clipLabel);
    const searchButton = button(
      state.busy ? tr("working", "Working…") : tr("search", "Search tiles"),
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
      const key = String(year);
      const statusSetter = (text: string): void => setStatus(text);
      const list = element("div", CSS.list);
      for (const tile of state.results) {
        const rowElement = element(
          "div",
          CSS.row + (state.selectedIds.includes(tile.id) ? CSS.rowSelected : ""),
        );
        rowElement.append(
          element("div", CSS.rowTitle, `${tile.id} · ${year}`),
          element(
            "div",
            CSS.rowSubtitle,
            tr("rowSubtitle", "{{count}} fields · {{size}}", {
              count: formatCount(tile.featureCounts[key] ?? 0),
              size: formatBytes(tile.sizeBytes[key] ?? 0),
            }),
          ),
        );
        const actions = element("div", CSS.rowActions);
        actions.append(
          taskButton(
            tr("addToMap", "Add to map"),
            (signal) => addTileToMap(tile, year, statusSetter, signal),
            tr("addToMapTitle", "Add this tile's fields to the map as an editable vector layer"),
          ),
          taskButton(
            tr("downloadParquet", "GeoParquet"),
            (signal) => downloadTileParquet(tile, year, statusSetter, signal),
            tr("downloadParquetTitle", "Save this tile's source GeoParquet file"),
          ),
          taskButton(
            tr("downloadGeoJson", "GeoJSON"),
            (signal) => downloadTileGeoJson(tile, year, statusSetter, signal),
            tr("downloadGeoJsonTitle", "Save this tile's fields as GeoJSON"),
          ),
          button(tr("zoom", "Zoom"), CSS.action, () => appRef?.fitBounds?.(tile.bbox)),
        );
        rowElement.append(actions);
        rowElement.addEventListener("mouseenter", () => {
          const map = getStyleMap(appRef);
          if (map) setOutline(map, [tile.bbox]);
        });
        rowElement.addEventListener("mouseleave", showSelection);
        // Selecting a row from the list; its buttons act without selecting.
        rowElement.addEventListener("click", (event) => {
          if ((event.target as HTMLElement).closest("button")) return;
          select([tile.id], false);
        });
        rowElements.set(tile.id, rowElement);
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
      removeFootprints(getStyleMap(appRef));
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
  const map = getStyleMap(app);
  removeFootprints(map);
  removeChrome(map);
}

/**
 * Fields of the World plugin: the FTW global agricultural field boundaries
 * (2024 and 2025) on the map, colored and filtered by the model's confidence,
 * plus the global field-density raster; a search of the 1° download grid by
 * map view or drawn box; and per-tile loading onto the map and GeoParquet or
 * GeoJSON downloads.
 */
export const maplibreFieldsOfTheWorldPlugin: GeoLibrePlugin = {
  id: FIELDS_OF_THE_WORLD_PLUGIN_ID,
  name: "Fields of the World",
  version: "0.1.0",
  // The field layers are PMTiles and GeoJSON store layers and the footprints
  // are Style Spec sources and layers, so both 2D engines host them.
  engines: ["maplibre", "mapbox"],
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
