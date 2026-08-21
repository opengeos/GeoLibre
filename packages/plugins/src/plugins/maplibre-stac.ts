import { DEFAULT_LAYER_STYLE, useAppStore } from "@geolibre/core";
import { fillLayerId, lineLayerId } from "@geolibre/map";
import type { FeatureCollection, Geometry } from "geojson";
import type { GeoJSONSource, MapMouseEvent, Map as MapLibreMap } from "maplibre-gl";
import type {
  GeoLibreAppAPI,
  GeoLibreCogLayerOptions,
  GeoLibreCogRenderEngine,
  GeoLibrePlugin,
} from "../types";
import { addPMTilesAsset } from "./stac-layers";
import {
  assetDisplayFormat,
  assetFormat,
  assetTargets,
  canAddAsset,
  connectStac,
  horizontalBbox,
  icechunkBranch,
  isAzureBlobHref,
  isIcechunkAsset,
  isVisualizableAsset,
  requiresTarget,
  itemBbox,
  loadStacIndex,
  openCatalogNode,
  searchStacApi,
  searchStaticStac,
  type StacAsset,
  type StacConnection,
  type StacIndexCatalog,
  type StacItem,
  type StacNextPage,
  type StacSearchResult,
  type StacSearchCursor,
  type ZarrTargetCheck,
  withItemBounds,
  zarrCrs,
  zarrLayerRequest,
  zarrReaderTargetCheck,
  zarrTargetCheck,
  zarrStorePath,
  zarrStoreTakesKeys,
} from "./stac-api";
import { buildCatalogTree } from "./stac-catalog-tree";
import { el, setDisabled } from "../panel-dom";
import { addVectorLayerFromUrl } from "./maplibre-vector";
import { addZarrRasterLayer } from "./maplibre-components";
import {
  icechunkLayerUrl,
  icechunkTimeAttributesReader,
  openIcechunkStore,
  repositoryOpenError,
  type ZarrKeyReader,
} from "./stac-icechunk";

export const STAC_PLUGIN_ID = "geolibre-stac-catalogs";
const PANEL_ID = STAC_PLUGIN_ID;
// The footprints layer is a normal store layer, so it is saved into the project
// while `footprintLayerId` only lives for the session. This marker is how a
// later search — or a reopened project — recognizes the layer as ours instead
// of adding a second copy.
const FOOTPRINT_SOURCE_KIND = "stac-footprints";
const DRAW_SOURCE = "geolibre-stac-draw-bbox";
const DRAW_FILL = "geolibre-stac-draw-bbox-fill";
const DRAW_LINE = "geolibre-stac-draw-bbox-line";
// Selection highlight, like the draw rectangle: a transient interaction overlay
// rather than data, so it stays off the Layers panel.
const SELECT_SOURCE = "geolibre-stac-selected";
const SELECT_FILL = "geolibre-stac-selected-fill";
const SELECT_LINE = "geolibre-stac-selected-line";
const COG_ENGINE_STORAGE_KEY = "geolibre:stac-default-cog-engine";
// "auto" leaves the raster control on whatever engine it already holds. It is
// the default because the engine is control-wide: naming one re-renders every
// raster on the map, including layers another panel put there.
const COG_ENGINES = ["auto", "cog-tiler-wasm", "maplibre-gl-raster", "titiler"] as const;
type StacCogEngine = (typeof COG_ENGINES)[number];

// Web Storage throws rather than returning null when the browser blocks it
// (private mode, a third-party-storage policy), so neither read nor write may
// be the only thing standing between the user and a working panel.
function savedCogEngine(): StacCogEngine {
  let saved: string | null = null;
  try {
    saved =
      typeof localStorage === "undefined" ? null : localStorage.getItem(COG_ENGINE_STORAGE_KEY);
  } catch {
    return "auto";
  }
  return COG_ENGINES.includes(saved as StacCogEngine) ? (saved as StacCogEngine) : "auto";
}

function rememberCogEngine(engine: string): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(COG_ENGINE_STORAGE_KEY, engine);
  } catch {
    // A blocked store just means the choice does not outlive the session.
  }
}

/**
 * Colormaps the COG renderer knows by name (`ColormapName` in
 * `maplibre-gl-components`). This is a convenience list for the dropdown, not a
 * contract: `addCogLayer` documents an unrecognized name as falling back to the
 * renderer default, so if the union gains or drops entries the worst case is a
 * missing or inert choice here, never a runtime error.
 */
const COLORMAPS = [
  "viridis",
  "plasma",
  "inferno",
  "magma",
  "cividis",
  "coolwarm",
  "bwr",
  "seismic",
  "RdBu",
  "RdYlBu",
  "RdYlGn",
  "spectral",
  "jet",
  "rainbow",
  "turbo",
  "terrain",
  "ocean",
  "hot",
  "cool",
  "gray",
  "bone",
] as const;

/**
 * User-facing strings for the STAC panel. This package is framework-agnostic
 * and cannot call react-i18next's `t()` directly, so the host pushes translated
 * values via {@link setStacLabels} (the pattern used by `maplibre-graticule`
 * and `maplibre-timelapse`). Defaults are English.
 */
export interface StacLabels {
  title: string;
  /** Title getter pushed by the host so the panel header re-localizes live. */
  getTitle?: () => string;
  footprintLayerName: string;
  catalogSearch: string;
  catalogSearchPlaceholder: string;
  indexLoading: string;
  indexUnavailable: string;
  indexLoadFailed: string;
  urlLabel: string;
  connect: string;
  connecting: string;
  connected: string;
  connectFailed: string;
  selectCatalog: string;
  noMatchingCatalogs: string;
  catalogApiSuffix: string;
  catalogStaticSuffix: string;
  kindApi: string;
  kindStatic: string;
  collectionsHint: string;
  limitToExtent: string;
  bboxLabel: string;
  bboxPlaceholder: string;
  bboxInvalid: string;
  drawBbox: string;
  cancelDrawing: string;
  clearDrawnBbox: string;
  drawHint: string;
  drawnBboxCleared: string;
  mapNotReady: string;
  startDate: string;
  endDate: string;
  additionalParams: string;
  additionalInvalid: string;
  searchItems: string;
  clearResults: string;
  resultsCleared: string;
  searching: string;
  loadingMore: string;
  noMatchesHere: string;
  treeEmpty: string;
  treeOpenFailed: string;
  noResults: string;
  searchFailed: string;
  loadMore: string;
  renderOptions: string;
  renderingEngine: string;
  engineAuto: string;
  engineGpu: string;
  engineWasm: string;
  engineTitiler: string;
  engineHint: string;
  resizeResults: string;
  bands: string;
  bandsPlaceholder: string;
  colormap: string;
  colormapDefault: string;
  minValue: string;
  maxValue: string;
  nodata: string;
  nodataPlaceholder: string;
  renderHint: string;
  initialStatus: string;
  zoom: string;
  add: string;
  download: string;
  addUnsupported: string;
  addFailed: string;
  addNoSourceLayers: string;
  cogUnsupported: string;
  formatCog: string;
  formatGeoJson: string;
  formatPmtiles: string;
  formatParquet: string;
  formatZarr: string;
  formatUnknown: string;
  addNoTarget: string;
  addIcechunkFailed: string;
  zarrProblem: (problem: Exclude<ZarrTargetCheck, "array">) => string;
  chooseTarget: string;
  notAddable: string;
  showing: (count: number) => string;
  showingOfMatched: (count: number, matched: number) => string;
  adding: (asset: string) => string;
  added: (asset: string) => string;
  drawnBbox: (bbox: string) => string;
  catalogInfo: (title: string, kind: string) => string;
}

/** Why a Zarr variable could not be added, in the panel's own words. */
const ZARR_PROBLEMS: Record<Exclude<ZarrTargetCheck, "array">, string> = {
  group: "This asset names a group of arrays, not one that can be drawn",
  missing: "This store does not hold that variable",
  unauthorized: "This Zarr store needs credentials GeoLibre cannot supply yet",
  "unsupported-url": "This Zarr store's address cannot be read one key at a time",
  unavailable: "This Zarr store could not be opened",
};

let labels: StacLabels = {
  title: "STAC Catalogs",
  footprintLayerName: "STAC search footprints",
  catalogSearch: "Find a public catalog from STAC Index",
  catalogSearchPlaceholder: "Search catalog names…",
  indexLoading: "Loading STAC Index…",
  indexUnavailable: "STAC Index unavailable — enter a URL",
  indexLoadFailed: "Could not load STAC Index",
  urlLabel: "STAC catalog or API URL",
  connect: "Connect",
  connecting: "Connecting to STAC…",
  connected: "Connected. Choose filters and search.",
  connectFailed: "Could not connect to STAC",
  selectCatalog: "Select a catalog…",
  noMatchingCatalogs: "No matching catalogs",
  catalogApiSuffix: " (API)",
  catalogStaticSuffix: " (static)",
  kindApi: "STAC API",
  kindStatic: "static catalog",
  collectionsHint: "Hold Ctrl/Cmd to select multiple collections; drag the bottom edge to resize",
  limitToExtent: "Limit search to the current map extent",
  bboxLabel: "Bounding box (west, south, east, north)",
  bboxPlaceholder: "Optional; overrides map extent",
  bboxInvalid: "Enter a valid bbox: west, south, east, north.",
  drawBbox: "Draw bbox on map",
  cancelDrawing: "Cancel drawing",
  clearDrawnBbox: "Clear drawn bbox",
  drawHint: "Click and drag on the map to draw a search bounding box.",
  drawnBboxCleared: "Drawn bbox cleared.",
  mapNotReady: "The map is not ready for drawing.",
  startDate: "Start date",
  endDate: "End date",
  additionalParams: "Additional search parameters (JSON, STAC API only)",
  additionalInvalid: "Additional search parameters must be a JSON object.",
  searchItems: "Search items",
  clearResults: "Clear results",
  resultsCleared: "Search results cleared.",
  searching: "Searching STAC items…",
  loadingMore: "Loading more items…",
  noMatchesHere: "Nothing matched in that part of the catalog. Load more to keep searching.",
  treeEmpty: "Empty",
  treeOpenFailed: "Could not open this catalog",
  noResults: "No STAC items matched these filters.",
  searchFailed: "STAC search failed",
  loadMore: "Load more",
  renderOptions: "Raster rendering options",
  renderingEngine: "COG rendering engine",
  engineAuto: "Leave unchanged",
  engineGpu: "GPU (deck.gl, Mercator only)",
  engineWasm: "WebAssembly tiler (globe compatible)",
  engineTitiler: "TiTiler server",
  engineHint:
    "Which renderer decodes the imagery. Unlike the settings above this is not per layer: " +
    "it applies to every raster on the map, including ones already added.",
  resizeResults: "Resize search results",
  bands: "Bands",
  bandsPlaceholder: "e.g. 1 or 1,2,3 (default: auto)",
  colormap: "Colormap (single-band only)",
  colormapDefault: "Renderer default",
  minValue: "Min value",
  maxValue: "Max value",
  nodata: "NoData value",
  nodataPlaceholder: "Overrides the file's NoData tag",
  renderHint:
    "Leave a field blank to let the renderer infer it from the GeoTIFF. " +
    "Options apply to assets added after they change.",
  initialStatus: "Choose a catalog from STAC Index or enter a URL.",
  zoom: "Zoom",
  add: "Add",
  download: "Download",
  addUnsupported:
    "Only GeoTIFF/COG, GeoJSON, GeoParquet, PMTiles, and Zarr assets can be added to the map",
  addFailed: "Could not add asset",
  addNoSourceLayers: "This archive lists no layers to draw",
  cogUnsupported: "This GeoLibre host cannot visualize remote GeoTIFF assets",
  formatCog: "COG",
  formatGeoJson: "GeoJSON",
  formatPmtiles: "PMTiles",
  formatParquet: "Parquet",
  formatZarr: "Zarr",
  formatUnknown: "Unknown format",
  addNoTarget: "This asset lists nothing to draw",
  addIcechunkFailed: "This Icechunk repository could not be opened",
  zarrProblem: (problem) => ZARR_PROBLEMS[problem],
  chooseTarget: "Choose what to add",
  notAddable: "not addable",
  showing: (count) => `Showing ${count} items.`,
  showingOfMatched: (count, matched) => `Showing ${count} of ${matched} items.`,
  adding: (asset) => `Adding ${asset}…`,
  added: (asset) => `Added ${asset} to the map.`,
  drawnBbox: (bbox) => `Drawn bbox: ${bbox}`,
  catalogInfo: (title, kind) => `${title} · ${kind}`,
};

/** Push translated strings from the host; rebuilds the open panel in place. */
export function setStacLabels(next: Partial<StacLabels>): void {
  labels = { ...labels, ...next };
  if (panelContainer) mountPanel(panelContainer);
}

let appRef: GeoLibreAppAPI | null = null;
// The result footprints are a first-class store layer, so they show up in the
// Layers panel and can be hidden, restyled, or removed like any other layer.
let footprintLayerId: string | null = null;
let unregisterPanel: (() => void) | null = null;
let disposePanel: (() => void) | null = null;
let panelContainer: HTMLElement | null = null;

// The results pane and the controls above it each keep a floor so neither can
// be dragged away entirely. splitterBounds() reserves the controls floor and
// clamps to the results one, so both are declared here and interpolated into
// the styles rather than written twice.
const RESULTS_MIN_HEIGHT = 150;
const CONTROLS_MIN_HEIGHT = 180;

const style = {
  panel:
    "display:flex;flex-direction:column;gap:10px;height:100%;padding:10px;box-sizing:border-box;" +
    "font-size:12px;color:hsl(var(--foreground));overflow:hidden;",
  section:
    "display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid hsl(var(--border));" +
    "border-radius:7px;background:hsl(var(--background));",
  row: "display:flex;gap:6px;align-items:center;",
  label: "font-size:10px;color:hsl(var(--muted-foreground));",
  input:
    "width:100%;min-width:0;box-sizing:border-box;padding:5px 7px;border-radius:5px;" +
    "border:1px solid hsl(var(--border));background:hsl(var(--background));color:hsl(var(--foreground));",
  button:
    "padding:5px 9px;border-radius:5px;border:1px solid hsl(var(--border));" +
    "background:hsl(var(--background));color:hsl(var(--foreground));cursor:pointer;",
  primary:
    "padding:6px 10px;border-radius:5px;border:1px solid hsl(var(--primary));" +
    "background:hsl(var(--primary));color:hsl(var(--primary-foreground));cursor:pointer;",
  status: "font-size:11px;line-height:1.4;color:hsl(var(--muted-foreground));",
  // The floor keeps a usable result list even with every filter section open;
  // its flex basis gives the search controls most of the panel initially. A
  // splitter between the two lets the user choose a different balance.
  results: `display:flex;flex:0 0 40%;min-height:${RESULTS_MIN_HEIGHT}px;overflow:auto;flex-direction:column;gap:7px;`,
  controls: `display:flex;flex-direction:column;gap:10px;flex:1 1 60%;min-height:${CONTROLS_MIN_HEIGHT}px;overflow:auto;`,
  resultSplitter:
    "height:8px;flex:0 0 8px;cursor:row-resize;border-radius:4px;touch-action:none;" +
    "background:linear-gradient(transparent 3px,hsl(var(--border)) 3px,hsl(var(--border)) 5px,transparent 5px);",
  card:
    "display:flex;flex-direction:column;gap:5px;padding:8px;border:1px solid hsl(var(--border));" +
    "border-radius:7px;background:hsl(var(--muted));",
} as const;

function field(label: string, type = "text"): { wrap: HTMLElement; input: HTMLInputElement } {
  const wrap = el("label");
  wrap.style.cssText = "display:flex;flex:1 1 0;min-width:0;flex-direction:column;gap:2px;";
  const caption = el("span", label);
  caption.style.cssText = style.label;
  const input = el("input");
  input.type = type;
  input.style.cssText = style.input;
  wrap.append(caption, input);
  return { wrap, input };
}

function currentExtent(): [number, number, number, number] | undefined {
  const bounds = appRef?.getMap?.()?.getBounds();
  if (!bounds) return undefined;
  const west = Math.max(-180, bounds.getWest());
  const east = Math.min(180, bounds.getEast());
  if (west >= east)
    return [-180, Math.max(-90, bounds.getSouth()), 180, Math.min(90, bounds.getNorth())];
  return [west, Math.max(-90, bounds.getSouth()), east, Math.min(90, bounds.getNorth())];
}

/** The footprints layer, matched by id first and by ownership marker after a restore. */
function findFootprintLayer(): { id: string } | undefined {
  return useAppStore
    .getState()
    .layers.find(
      (layer) =>
        (footprintLayerId !== null && layer.id === footprintLayerId) ||
        layer.metadata.sourceKind === FOOTPRINT_SOURCE_KIND,
    );
}

function removeFootprints(): void {
  const layer = findFootprintLayer();
  if (layer) useAppStore.getState().removeLayer(layer.id);
  footprintLayerId = null;
}

function removeDrawBox(map: MapLibreMap): void {
  if (map.getLayer(DRAW_LINE)) map.removeLayer(DRAW_LINE);
  if (map.getLayer(DRAW_FILL)) map.removeLayer(DRAW_FILL);
  if (map.getSource(DRAW_SOURCE)) map.removeSource(DRAW_SOURCE);
}

function showDrawBox(map: MapLibreMap, bbox: [number, number, number, number]): void {
  const [west, south, east, north] = bbox;
  const data: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [west, south],
              [east, south],
              [east, north],
              [west, north],
              [west, south],
            ],
          ],
        },
      },
    ],
  };
  const source = map.getSource(DRAW_SOURCE) as GeoJSONSource | undefined;
  if (source) {
    source.setData(data);
    return;
  }
  map.addSource(DRAW_SOURCE, { type: "geojson", data });
  map.addLayer({
    id: DRAW_FILL,
    type: "fill",
    source: DRAW_SOURCE,
    paint: { "fill-color": "#f59e0b", "fill-opacity": 0.12 },
  });
  map.addLayer({
    id: DRAW_LINE,
    type: "line",
    source: DRAW_SOURCE,
    paint: {
      "line-color": "#f59e0b",
      "line-width": 2,
      "line-dasharray": [2, 1],
    },
  });
}

function beginBboxDraw(
  onComplete: (bbox: [number, number, number, number]) => void,
): (() => void) | null {
  const map = appRef?.getMap?.();
  if (!map) return null;
  const canvas = map.getCanvas();
  let start: { lng: number; lat: number } | null = null;
  let finished = false;
  map.dragPan.disable();
  canvas.style.cursor = "crosshair";

  const cleanup = (): void => {
    if (finished) return;
    finished = true;
    canvas.removeEventListener("mousedown", onDown);
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    canvas.style.cursor = "";
    map.dragPan.enable();
  };
  const pointAt = (event: MouseEvent): { lng: number; lat: number } => {
    const rect = canvas.getBoundingClientRect();
    const point = map.unproject([event.clientX - rect.left, event.clientY - rect.top]);
    return {
      lng: Math.max(-180, Math.min(180, point.lng)),
      lat: Math.max(-90, Math.min(90, point.lat)),
    };
  };
  const bboxAt = (event: MouseEvent): [number, number, number, number] | null => {
    if (!start) return null;
    const end = pointAt(event);
    const bbox: [number, number, number, number] = [
      Math.min(start.lng, end.lng),
      Math.min(start.lat, end.lat),
      Math.max(start.lng, end.lng),
      Math.max(start.lat, end.lat),
    ];
    return bbox[0] === bbox[2] || bbox[1] === bbox[3] ? null : bbox;
  };
  const onDown = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    start = pointAt(event);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  const onMove = (event: MouseEvent): void => {
    const bbox = bboxAt(event);
    if (bbox) showDrawBox(map, bbox);
  };
  const onUp = (event: MouseEvent): void => {
    const bbox = bboxAt(event);
    cleanup();
    if (bbox) {
      showDrawBox(map, bbox);
      onComplete(bbox);
    }
  };
  canvas.addEventListener("mousedown", onDown);
  return cleanup;
}

function showFootprints(items: StacItem[]): void {
  const features = items
    .filter((item) => item.geometry)
    .map<FeatureCollection["features"][number]>((item) => ({
      type: "Feature",
      geometry: item.geometry!,
      properties: { id: item.id, collection: item.collection ?? "" },
    }));
  if (!features.length) {
    removeFootprints();
    return;
  }
  const data: FeatureCollection = { type: "FeatureCollection", features };
  const store = useAppStore.getState();
  // The user may have deleted the layer between searches; fall through and re-add.
  const existing = findFootprintLayer();
  if (existing) {
    footprintLayerId = existing.id;
    store.updateLayer(existing.id, { geojson: data });
    return;
  }
  footprintLayerId = store.addGeoJsonLayer(labels.footprintLayerName, data);
  store.updateLayer(footprintLayerId, {
    metadata: { sourceKind: FOOTPRINT_SOURCE_KIND },
    style: {
      ...DEFAULT_LAYER_STYLE,
      fillColor: "#8b5cf6",
      strokeColor: "#8b5cf6",
      fillOpacity: 0.12,
      strokeWidth: 2,
    },
  });
}

function removeSelectionHighlight(map: MapLibreMap): void {
  if (map.getLayer(SELECT_LINE)) map.removeLayer(SELECT_LINE);
  if (map.getLayer(SELECT_FILL)) map.removeLayer(SELECT_FILL);
  if (map.getSource(SELECT_SOURCE)) map.removeSource(SELECT_SOURCE);
}

function showSelectionHighlight(geometry: Geometry | null): void {
  const map = appRef?.getMap?.();
  if (!map) return;
  if (!geometry) {
    removeSelectionHighlight(map);
    return;
  }
  const data: FeatureCollection = {
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: {}, geometry }],
  };
  const source = map.getSource(SELECT_SOURCE) as GeoJSONSource | undefined;
  if (source) {
    source.setData(data);
    return;
  }
  map.addSource(SELECT_SOURCE, { type: "geojson", data });
  map.addLayer({
    id: SELECT_FILL,
    type: "fill",
    source: SELECT_SOURCE,
    paint: { "fill-color": "#f59e0b", "fill-opacity": 0.22 },
  });
  map.addLayer({
    id: SELECT_LINE,
    type: "line",
    source: SELECT_SOURCE,
    paint: { "line-color": "#f59e0b", "line-width": 3 },
  });
}

/** Native style layers backing the footprint store layer, if it is on the map. */
function footprintStyleLayers(map: MapLibreMap): string[] {
  if (!footprintLayerId) return [];
  return [fillLayerId(footprintLayerId), lineLayerId(footprintLayerId)].filter((id) =>
    map.getLayer(id),
  );
}

function assetLabel(key: string, asset: StacAsset): string {
  return asset.title || key;
}

function assetFormatLabel(asset: StacAsset): string {
  switch (assetDisplayFormat(asset)) {
    case "cog":
      return labels.formatCog;
    case "geojson":
      return labels.formatGeoJson;
    case "pmtiles":
      return labels.formatPmtiles;
    case "parquet":
      return labels.formatParquet;
    case "zarr":
      return labels.formatZarr;
    case null:
      return labels.formatUnknown;
  }
}

/** The Add button's tooltip: what it would add, or why it will not. */
function addReason(item: StacItem, key: string, asset: StacAsset): string {
  if (canAddAsset(item, key, asset)) return asset.href;
  if (!isVisualizableAsset(asset)) return labels.addUnsupported;
  if (requiresTarget(asset) && !zarrStoreTakesKeys(zarrStorePath(asset.href).url)) {
    return labels.zarrProblem("unsupported-url");
  }
  return labels.addNoTarget;
}

function assetOptionLabel(item: StacItem, key: string, asset: StacAsset): string {
  const addability = canAddAsset(item, key, asset) ? "" : ` (${labels.notAddable})`;
  return `${assetLabel(key, asset)} — ${assetFormatLabel(asset)}${addability}`;
}

type SasSigner = { signUrl(url: string, collectionId: string): Promise<string> };
let sasManager: Promise<SasSigner> | null = null;

function planetaryComputerSigner(): Promise<SasSigner> {
  sasManager ??= import("maplibre-gl-planetary-computer")
    .then((module) => new module.SASTokenManager())
    .catch((error) => {
      // Don't let one failed import disable signing for the rest of the session.
      sasManager = null;
      throw error;
    });
  return sasManager;
}

/**
 * Planetary Computer serves several collections — most of the GeoParquet ones — from private
 * containers that answer 409 without a SAS token, while others (NAIP) read fine anonymously.
 * Tokens are per-collection and expire within the hour, so they are minted when the asset is
 * added rather than when the item is parsed, and the upstream manager caches them. Anything
 * that is not an Azure blob, or that cannot be signed, is read unsigned.
 *
 * Only the GeoParquet path signs, because that is the one this branch made addable and it cannot
 * read a private container at all unsigned. PMTiles and COG read unsigned exactly as they did
 * before, rather than gaining a token they never had.
 *
 * Every one of these formats persists whatever URL it is handed: PMTiles and COG through the
 * store layer they create, and the vector control through `createVectorStoreLayer`, which records
 * the URL as both `source.url` and `sourcePath`. A project saved with a signed GeoParquet layer
 * therefore holds a token that `restoreVectorLayers` replays as-is and never re-signs, so the
 * layer stops reloading once the token lapses (about an hour). Fixing that properly means minting
 * the token per request, or re-signing on restore, rather than baking one in at add time.
 */
async function readableHref(item: StacItem, href: string): Promise<string> {
  if (!isAzureBlobHref(href) || !item.collection) return href;
  try {
    return await (await planetaryComputerSigner()).signUrl(href, item.collection);
  } catch {
    return href;
  }
}

/**
 * Open the repository an Icechunk asset names, on the branch its item or asset named. A spec
 * version the reader cannot read fails here rather than inside the renderer, where it would arrive
 * as a blank layer.
 */
async function openIcechunkAsset(
  asset: StacAsset,
  branch: string | undefined,
  signal?: AbortSignal,
): Promise<ZarrKeyReader> {
  try {
    return await openIcechunkStore(zarrStorePath(asset.href).url, branch, signal);
  } catch (error) {
    // An add the user abandoned is not a repository that refused, so it is not reported as one.
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw repositoryOpenError(error, labels.addIcechunkFailed);
  }
}

async function visualizeAsset(
  item: StacItem,
  key: string,
  asset: StacAsset,
  cogOptions: GeoLibreCogLayerOptions,
  signal?: AbortSignal,
  target?: string,
): Promise<void> {
  const name = `${item.id} — ${assetLabel(key, asset)}`;
  const format = assetFormat(asset);
  switch (format) {
    case "pmtiles": {
      // No appRef check: the layer goes to the store, not through the app API.
      if (!(await addPMTilesAsset(asset.href, name, signal))) {
        throw new Error(labels.addNoSourceLayers);
      }
      return;
    }
    case "geojson": {
      if (!appRef) throw new Error(labels.addFailed);
      const response = await fetch(asset.href, {
        headers: { Accept: "application/geo+json, application/json" },
        signal,
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const data = (await response.json()) as FeatureCollection;
      appRef.addGeoJsonLayer(name, data, asset.href);
      return;
    }
    case "parquet": {
      if (!appRef) throw new Error(labels.addFailed);
      if (!(await addVectorLayerFromUrl(appRef, await readableHref(item, asset.href), { name }))) {
        throw new Error(labels.addFailed);
      }
      return;
    }
    case "zarr": {
      if (!appRef) throw new Error(labels.addFailed);
      const variable = target ?? assetTargets(item, key, asset)[0]?.id;
      if (!variable) throw new Error(labels.addNoTarget);
      // A repository is opened by its own reader and handed over as a store; a plain store is read
      // from its URL. Unsigned either way — a token cannot survive being followed by a key, so a
      // private container fails the check below and says so.
      // Worked out once: the branch decides which snapshot is opened and, with it, which layer the
      // control keys — two branches of one repository are two layers.
      const isIcechunk = isIcechunkAsset(asset, item);
      const branch = isIcechunk ? icechunkBranch(asset, item) : undefined;
      const icechunk = isIcechunk ? await openIcechunkAsset(asset, branch, signal) : null;
      const { url } = zarrStorePath(asset.href);
      const checked = icechunk
        ? await zarrReaderTargetCheck(
            (key, options) => icechunk.get(key, options),
            variable,
            signal,
          )
        : await zarrTargetCheck(url, variable, fetch, signal);
      if (checked !== "array") throw new Error(labels.zarrProblem(checked));

      const crs = zarrCrs(item, asset);
      const request = zarrLayerRequest(asset.href, variable, {
        ...cogOptions,
        ...(crs ? { crs } : {}),
      });
      const layerId = await addZarrRasterLayer(appRef, {
        ...request,
        name: `${name} — ${variable}`,
        // The renderer's `store` takes `get(key: string)` where the reader wants a rooted key;
        // method bivariance lets it through, and it holds because zarrita addresses keys absolutely.
        // The url is only an identifier once a store is supplied, so it carries the branch: two
        // branches of one repository are two layers, not one patching the other.
        ...(icechunk
          ? {
              url: icechunkLayerUrl(request.url, branch),
              store: icechunk,
              readTimeAttributes: icechunkTimeAttributesReader(icechunk),
            }
          : {}),
      });
      // The renderer places the data from the store's own coordinates and records no extent, so
      // Zoom to layer has nothing to fly to. The item's bbox is WGS84, which is what it wants.
      // `addZarrRasterLayer` throws rather than resolving without an id, so the layer is either
      // in the store or we never got here.
      const layer = useAppStore.getState().layers.find((entry) => entry.id === layerId);
      if (layer) {
        useAppStore
          .getState()
          .updateLayer(layerId, { metadata: withItemBounds(layer.metadata, item) });
      }
      return;
    }
    case "cog": {
      if (!appRef?.addCogLayer) throw new Error(labels.cogUnsupported);
      await appRef.addCogLayer(name, asset.href, cogOptions);
      return;
    }
    case null:
      throw new Error(labels.addUnsupported);
    default: {
      // A format added to VISUALIZABLE_FORMATS with no branch here fails to compile, rather than
      // falling through to a renderer that cannot read it.
      const unhandled: never = format;
      throw new Error(`Unhandled asset format: ${String(unhandled)}`);
    }
  }
}

function buildPanel(container: HTMLElement): () => void {
  container.innerHTML = "";
  container.style.cssText = style.panel;
  const controller = new AbortController();

  const catalogSection = el("div");
  catalogSection.style.cssText = style.section;
  const catalogSearch = field(labels.catalogSearch);
  catalogSearch.input.placeholder = labels.catalogSearchPlaceholder;
  const catalogSelect = el("select");
  catalogSelect.style.cssText = style.input;
  const firstOption = el("option", labels.indexLoading);
  firstOption.value = "";
  catalogSelect.append(firstOption);
  const urlField = field(labels.urlLabel, "url");
  urlField.input.placeholder = "https://example.org/stac/";
  const connectButton = el("button", labels.connect);
  connectButton.type = "button";
  connectButton.style.cssText = style.primary;
  catalogSection.append(catalogSearch.wrap, catalogSelect, urlField.wrap, connectButton);

  const searchSection = el("div");
  searchSection.style.cssText = style.section;
  searchSection.hidden = true;
  const catalogInfo = el("div");
  catalogInfo.style.cssText = "font-weight:600;";
  const collectionSelect = el("select");
  collectionSelect.multiple = true;
  collectionSelect.size = 8;
  // Catalogs can advertise hundreds of collections, so let the list be dragged taller.
  collectionSelect.style.cssText = `${style.input}resize:vertical;overflow:auto;min-height:150px;`;
  collectionSelect.title = labels.collectionsHint;
  // An API answers with a flat list of collections; a static catalog is a tree read as it opens.
  const tree = buildCatalogTree({
    labels: { empty: labels.treeEmpty, openFailed: labels.treeOpenFailed },
    onError: (message) => setStatus(message, true),
    onActivate: showCollection,
    signal: controller.signal,
  });
  const extentRow = el("label");
  extentRow.style.cssText = style.row;
  const useExtent = el("input");
  useExtent.type = "checkbox";
  useExtent.checked = true;
  extentRow.append(useExtent, el("span", labels.limitToExtent));
  const bboxField = field(labels.bboxLabel);
  bboxField.input.placeholder = labels.bboxPlaceholder;
  const drawRow = el("div");
  drawRow.style.cssText = style.row;
  const drawButton = el("button", labels.drawBbox);
  drawButton.type = "button";
  drawButton.style.cssText = style.button;
  const clearDrawButton = el("button", labels.clearDrawnBbox);
  clearDrawButton.type = "button";
  clearDrawButton.style.cssText = style.button;
  clearDrawButton.hidden = true;
  drawRow.append(drawButton, clearDrawButton);
  const dates = el("div");
  dates.style.cssText = style.row;
  const startField = field(labels.startDate, "date");
  const endField = field(labels.endDate, "date");
  dates.append(startField.wrap, endField.wrap);
  const additionalWrap = el("label");
  additionalWrap.style.cssText = "display:flex;min-width:0;flex-direction:column;gap:2px;";
  const additionalCaption = el("span", labels.additionalParams);
  additionalCaption.style.cssText = style.label;
  const additionalParams = el("textarea");
  additionalParams.style.cssText = `${style.input}min-height:58px;resize:vertical;font-family:monospace;`;
  additionalParams.placeholder =
    '{"query":{"eo:cloud_cover":{"lt":10}},"sortby":[{"field":"properties.datetime","direction":"desc"}]}';
  additionalWrap.append(additionalCaption, additionalParams);
  const searchActions = el("div");
  searchActions.style.cssText = style.row;
  const searchButton = el("button", labels.searchItems);
  searchButton.type = "button";
  searchButton.style.cssText = `${style.primary}flex:1 1 0;`;
  const clearResultsButton = el("button", labels.clearResults);
  clearResultsButton.type = "button";
  // cssText first: it replaces the whole inline declaration, so setting the
  // disabled look before it would be wiped out.
  clearResultsButton.style.cssText = `${style.button}flex:1 1 0;`;
  setDisabled(clearResultsButton, true);
  searchActions.append(searchButton, clearResultsButton);
  searchSection.append(
    catalogInfo,
    collectionSelect,
    tree.element,
    extentRow,
    bboxField.wrap,
    drawRow,
    dates,
    additionalWrap,
    searchActions,
  );

  // Raster rendering options, applied to every GeoTIFF/COG asset added from the
  // result list. Collapsed by default so the common case stays a single click.
  const renderSection = el("details");
  renderSection.style.cssText = style.section;
  renderSection.hidden = true;
  const renderSummary = el("summary", labels.renderOptions);
  renderSummary.style.cssText = "cursor:pointer;font-weight:600;";
  const engineWrap = el("label");
  engineWrap.style.cssText = "display:flex;flex-direction:column;gap:2px;";
  const engineCaption = el("span", labels.renderingEngine);
  engineCaption.style.cssText = style.label;
  const engineSelect = el("select");
  engineSelect.style.cssText = style.input;
  for (const [value, title] of [
    ["auto", labels.engineAuto],
    ["cog-tiler-wasm", labels.engineWasm],
    ["maplibre-gl-raster", labels.engineGpu],
    ["titiler", labels.engineTitiler],
  ] as const) {
    const option = el("option", title);
    option.value = value;
    engineSelect.append(option);
  }
  engineSelect.value = savedCogEngine();
  engineSelect.addEventListener("change", () => {
    rememberCogEngine(engineSelect.value);
  });
  const engineHint = el("span", labels.engineHint);
  engineHint.style.cssText = style.status;
  engineWrap.append(engineCaption, engineSelect, engineHint);
  const bandsField = field(labels.bands);
  bandsField.input.placeholder = labels.bandsPlaceholder;
  const colormapWrap = el("label");
  colormapWrap.style.cssText = "display:flex;flex-direction:column;gap:2px;";
  const colormapCaption = el("span", labels.colormap);
  colormapCaption.style.cssText = style.label;
  const colormapSelect = el("select");
  colormapSelect.style.cssText = style.input;
  const colormapDefault = el("option", labels.colormapDefault);
  colormapDefault.value = "";
  colormapSelect.append(colormapDefault);
  for (const name of COLORMAPS) {
    const option = el("option", name);
    option.value = name;
    colormapSelect.append(option);
  }
  colormapWrap.append(colormapCaption, colormapSelect);
  const rescaleRow = el("div");
  rescaleRow.style.cssText = style.row;
  const vminField = field(labels.minValue, "number");
  const vmaxField = field(labels.maxValue, "number");
  rescaleRow.append(vminField.wrap, vmaxField.wrap);
  const nodataField = field(labels.nodata, "number");
  nodataField.input.placeholder = labels.nodataPlaceholder;
  const renderHint = el("div", labels.renderHint);
  renderHint.style.cssText = style.status;
  // The engine picker sits last, after the per-layer options: it is the one
  // control-wide setting here, and its hint reads "unlike the settings above".
  renderSection.append(
    renderSummary,
    bandsField.wrap,
    colormapWrap,
    rescaleRow,
    nodataField.wrap,
    renderHint,
    engineWrap,
  );

  const status = el("div", labels.initialStatus);
  status.style.cssText = style.status;
  const results = el("div");
  results.style.cssText = style.results;
  const resultSplitter = el("div");
  resultSplitter.style.cssText = style.resultSplitter;
  resultSplitter.setAttribute("role", "separator");
  resultSplitter.setAttribute("aria-orientation", "horizontal");
  resultSplitter.setAttribute("aria-label", labels.resizeResults);
  resultSplitter.setAttribute("aria-valuemin", String(RESULTS_MIN_HEIGHT));
  resultSplitter.tabIndex = 0;
  const loadMore = el("button", labels.loadMore);
  loadMore.type = "button";
  loadMore.style.cssText = style.primary;
  loadMore.hidden = true;
  const controls = el("div");
  controls.style.cssText = style.controls;
  controls.append(catalogSection, searchSection, renderSection);
  container.append(controls, status, resultSplitter, results, loadMore);

  // The results pane neither grows nor shrinks once its basis is set, so the
  // ceiling has to be whatever the container has left after the siblings that
  // keep their own size. Guessing a fixed reserve here let a drag to the
  // reported maximum clip the tail of the list and the Load more button.
  const splitterBounds = (): number => {
    const reserved = [status, resultSplitter, loadMore].reduce(
      (total, element) => total + (element.hidden ? 0 : element.getBoundingClientRect().height),
      CONTROLS_MIN_HEIGHT,
    );
    const box = container.getBoundingClientRect();
    const padding = window.getComputedStyle(container);
    const gap = Number.parseFloat(padding.rowGap) || 0;
    const inner =
      box.height -
      (Number.parseFloat(padding.paddingTop) || 0) -
      (Number.parseFloat(padding.paddingBottom) || 0) -
      // One gap per sibling boundary: controls, status, splitter, results, loadMore.
      gap * 4;
    return Math.max(RESULTS_MIN_HEIGHT, inner - reserved);
  };

  // Announcing the size only after the first drag would leave a screen reader
  // with a valueless separator, so the values are also synced on focus -- which
  // must not pin the percentage flex basis into pixels the way a resize does.
  const announceResults = (height: number, maximum: number): void => {
    resultSplitter.setAttribute("aria-valuenow", String(Math.round(height)));
    resultSplitter.setAttribute("aria-valuemax", String(Math.round(maximum)));
  };

  const resizeResults = (height: number): void => {
    const maximum = splitterBounds();
    const next = Math.min(maximum, Math.max(RESULTS_MIN_HEIGHT, height));
    results.style.flexBasis = `${next}px`;
    announceResults(next, maximum);
  };

  resultSplitter.addEventListener("focus", () => {
    announceResults(results.getBoundingClientRect().height, splitterBounds());
  });

  resultSplitter.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = results.getBoundingClientRect().height;
    resultSplitter.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent): void => {
      resizeResults(startHeight - (moveEvent.clientY - startY));
    };
    const stop = (): void => {
      resultSplitter.removeEventListener("pointermove", move);
      resultSplitter.removeEventListener("pointerup", stop);
      resultSplitter.removeEventListener("pointercancel", stop);
    };
    resultSplitter.addEventListener("pointermove", move);
    resultSplitter.addEventListener("pointerup", stop);
    resultSplitter.addEventListener("pointercancel", stop);
  });
  resultSplitter.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const delta = event.key === "ArrowUp" ? 30 : -30;
    resizeResults(results.getBoundingClientRect().height + delta);
  });

  let index: StacIndexCatalog[] = [];
  let filtered: StacIndexCatalog[] = [];
  let connection: StacConnection | null = null;
  let nextPage: StacNextPage | undefined;
  let searchCursor: StacSearchCursor | undefined;
  let allItems: StacItem[] = [];
  let searchGeneration = 0;
  /** The walk a search is doing; starting another stops it, since a static walk reads to find. */
  let walking: AbortController | null = null;
  /** The extent read a collection asked for, cancelled when another collection is asked for. */
  let extentRead: AbortController | null = null;
  let cancelDraw: (() => void) | null = null;
  let selectedItemId: string | null = null;
  const cardsByItemId = new Map<string, HTMLElement>();

  const setStatus = (message: string, error = false): void => {
    status.textContent = message;
    status.style.color = error ? "hsl(var(--destructive))" : "hsl(var(--muted-foreground))";
  };

  const cogOptions = (): GeoLibreCogLayerOptions => {
    const numeric = (input: HTMLInputElement): number | undefined => {
      const value = Number(input.value);
      return input.value.trim() && Number.isFinite(value) ? value : undefined;
    };
    const bands = bandsField.input.value.trim();
    const colormap = colormapSelect.value;
    const rescaleMin = numeric(vminField.input);
    const rescaleMax = numeric(vmaxField.input);
    const nodata = numeric(nodataField.input);
    return {
      // "auto" is sent through as-is so the host leaves the control-wide engine
      // alone rather than falling back to its own default.
      engine: engineSelect.value as GeoLibreCogRenderEngine | "auto",
      ...(bands ? { bands } : {}),
      ...(colormap ? { colormap } : {}),
      ...(rescaleMin !== undefined ? { rescaleMin } : {}),
      ...(rescaleMax !== undefined ? { rescaleMax } : {}),
      ...(nodata !== undefined ? { nodata } : {}),
    };
  };

  /** Paint the selected card and mirror the selection onto the map. */
  const applySelection = (scrollIntoView: boolean): void => {
    for (const [itemId, card] of cardsByItemId) {
      const active = itemId === selectedItemId;
      card.style.borderColor = active ? "#f59e0b" : "hsl(var(--border))";
      card.style.boxShadow = active ? "0 0 0 1px #f59e0b" : "none";
    }
    const card = selectedItemId ? cardsByItemId.get(selectedItemId) : undefined;
    if (card && scrollIntoView) card.scrollIntoView({ block: "nearest" });
    const item = allItems.find((entry) => entry.id === selectedItemId);
    showSelectionHighlight(item?.geometry ?? null);
  };

  const selectItem = (itemId: string | null, scrollIntoView: boolean): void => {
    selectedItemId = itemId;
    applySelection(scrollIntoView);
  };

  const clearSearchResults = (announce = true): void => {
    // Invalidate a response that may still be in flight before clearing the UI.
    searchGeneration += 1;
    allItems = [];
    nextPage = undefined;
    searchCursor = undefined;
    results.innerHTML = "";
    cardsByItemId.clear();
    selectItem(null, false);
    removeFootprints();
    loadMore.hidden = true;
    setDisabled(clearResultsButton, true);
    setDisabled(searchButton, false);
    if (announce) setStatus(labels.resultsCleared);
  };

  const renderCatalogs = (): void => {
    const query = catalogSearch.input.value.trim().toLowerCase();
    filtered = index
      .filter((entry) => !query || `${entry.title} ${entry.summary}`.toLowerCase().includes(query))
      .slice(0, 150);
    catalogSelect.innerHTML = "";
    const prompt = el("option", filtered.length ? labels.selectCatalog : labels.noMatchingCatalogs);
    prompt.value = "";
    catalogSelect.append(prompt);
    for (const entry of filtered) {
      const option = el(
        "option",
        `${entry.title}${entry.isApi ? labels.catalogApiSuffix : labels.catalogStaticSuffix}`,
      );
      option.value = entry.url;
      catalogSelect.append(option);
    }
  };

  const renderItems = (): void => {
    results.innerHTML = "";
    cardsByItemId.clear();
    for (const item of allItems) {
      const card = el("div");
      card.style.cssText = style.card;
      card.style.cursor = "pointer";
      cardsByItemId.set(item.id, card);
      // Clicking anywhere on the card that is not a control selects the item,
      // so the map highlight and the list stay in step in both directions.
      card.addEventListener("click", (event) => {
        const target = event.target as HTMLElement;
        if (target.closest("button, select")) return;
        selectItem(item.id, false);
      });
      const title = el("div", item.id);
      title.style.cssText = "font-weight:600;word-break:break-word;";
      const date = String(item.properties.datetime ?? item.properties.start_datetime ?? "");
      const subtitle = el("div", [item.collection, date.slice(0, 10)].filter(Boolean).join(" · "));
      subtitle.style.cssText = style.label;
      const actions = el("div");
      actions.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;align-items:center;";
      const bbox = itemBbox(item);
      if (bbox) {
        const zoom = el("button", labels.zoom);
        zoom.type = "button";
        zoom.style.cssText = style.button;
        zoom.addEventListener("click", () => appRef?.fitBounds?.(bbox));
        actions.append(zoom);
      }
      const assets = Object.entries(item.assets ?? {}).filter(([, asset]) => asset?.href);
      if (assets.length) {
        const assetSelect = el("select");
        assetSelect.style.cssText = `${style.input}flex:1 1 140px;width:auto;`;
        for (const [key, asset] of assets) {
          const option = el("option", assetOptionLabel(item, key, asset));
          option.value = key;
          assetSelect.append(option);
        }
        // Preselect something the user can actually add; assets often lead with metadata.
        const firstAddable = assets.find(([key, asset]) => canAddAsset(item, key, asset));
        if (firstAddable) assetSelect.value = firstAddable[0];
        const selected = (): [string, StacAsset] =>
          assets.find(([key]) => key === assetSelect.value) ?? assets[0];
        const add = el("button", labels.add);
        add.type = "button";
        add.style.cssText = style.button;
        const download = el("button", labels.download);
        download.type = "button";
        download.style.cssText = style.button;
        // Which part of the asset to draw, for the formats that hold more than one.
        const targetSelect = el("select");
        targetSelect.style.cssText = `${style.input}flex:1 1 140px;width:auto;`;
        targetSelect.title = labels.chooseTarget;
        let adding = false;

        const syncAsset = (): void => {
          const [key, asset] = selected();
          const addable = canAddAsset(item, key, asset);
          const targets = assetTargets(item, key, asset);
          // Rebuilt on every sync, including the one right after Add, so keep the user's pick.
          const chosen = targetSelect.value;
          targetSelect.innerHTML = "";
          for (const target of targets) {
            const option = el("option", target.label);
            option.value = target.id;
            targetSelect.append(option);
          }
          if (targets.some((target) => target.id === chosen)) targetSelect.value = chosen;
          // One target is the asset itself; hide a choice the user does not have.
          targetSelect.hidden = targets.length < 2 || !addable;
          assetSelect.title = asset.href;
          download.title = asset.href;
          setDisabled(add, adding || !addable);
          add.title = addReason(item, key, asset);
        };

        assetSelect.addEventListener("change", syncAsset);
        add.addEventListener("click", async () => {
          const [key, asset] = selected();
          // `visualizeAsset` falls back to the first target itself, so do not decide twice.
          const target = targetSelect.value || undefined;
          adding = true;
          syncAsset();
          setStatus(labels.adding(assetLabel(key, asset)));
          try {
            await visualizeAsset(item, key, asset, cogOptions(), controller.signal, target);
            setStatus(labels.added(assetLabel(key, asset)));
          } catch (error) {
            setStatus(error instanceof Error ? error.message : labels.addFailed, true);
          } finally {
            adding = false;
            syncAsset();
          }
        });
        download.addEventListener("click", () => appRef?.openExternalUrl?.(selected()[1].href));
        syncAsset();
        actions.append(assetSelect, targetSelect, add, download);
      }
      card.append(title, subtitle, actions);
      results.append(card);
    }
  };

  const parseBbox = (): [number, number, number, number] | undefined => {
    const text = bboxField.input.value.trim();
    if (!text) return useExtent.checked ? currentExtent() : undefined;
    const values = text.split(/[ ,]+/).map(Number);
    if (
      values.length !== 4 ||
      !values.every(Number.isFinite) ||
      values[0] >= values[2] ||
      values[1] >= values[3]
    ) {
      throw new Error(labels.bboxInvalid);
    }
    return values as [number, number, number, number];
  };

  const parseAdditionalParams = (): Record<string, unknown> | undefined => {
    const text = additionalParams.value.trim();
    if (!text) return undefined;
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(labels.additionalInvalid);
    }
    return parsed as Record<string, unknown>;
  };

  const searchStatus = (result: StacSearchResult): string => {
    if (!result.items.length && result.cursor) return labels.noMatchesHere;
    if (!allItems.length) return labels.noResults;
    if (result.matched) return labels.showingOfMatched(allItems.length, result.matched);
    return labels.showing(allItems.length);
  };

  // A double-click means the same here as in the tree: search this one.
  collectionSelect.addEventListener("dblclick", () => {
    const chosen = collectionSelect.selectedOptions[0]?.value;
    const extent = connection?.collections.find((collection) => collection.id === chosen)?.extent;
    const box = horizontalBbox(extent?.spatial?.bbox?.[0]);
    void runSearch(false);
    if (box) appRef?.fitBounds?.(box);
  });

  /** The tree asked for a collection: search it, and send the map to it. */
  function showCollection(href: string, bbox?: [number, number, number, number]): void {
    void runSearch(false, ++searchGeneration);
    if (bbox) return void appRef?.fitBounds?.(bbox);
    // A collection guessed from its link has never been read, so its extent has to be fetched.
    // Asking for a second collection cancels that read rather than letting it finish and be
    // thrown away, so the map cannot be sent where the user no longer is.
    extentRead?.abort();
    const reading = new AbortController();
    extentRead = reading;
    const scope = AbortSignal.any([reading.signal, controller.signal]);
    void openCatalogNode(href, fetch, scope)
      .then((node) => {
        if (!scope.aborted && node.bbox) appRef?.fitBounds?.(node.bbox);
      })
      .catch(() => undefined);
  }

  /**
   * `generation` says which search this is, so a late answer can tell whether it is still wanted.
   * The caller may take it first, when it has its own late answer to check; taking it here would
   * mean it moves on a call that does nothing.
   */
  async function runSearch(append: boolean, generation?: number): Promise<void> {
    if (!connection) return;
    const search = generation ?? ++searchGeneration;

    setDisabled(searchButton, true);
    setDisabled(loadMore, true);
    setStatus(append ? labels.loadingMore : labels.searching);
    try {
      const selectedCollections = Array.from(collectionSelect.selectedOptions)
        .map((option) => option.value)
        .filter(Boolean);
      const start = startField.input.value;
      const end = endField.input.value;
      const datetime = start || end ? `${start || ".."}/${end || ".."}` : undefined;
      walking?.abort();
      walking = new AbortController();
      const reading = AbortSignal.any([walking.signal, controller.signal]);
      const options = {
        bbox: parseBbox(),
        datetime,
        collections: selectedCollections,
        entries: connection.isApi ? [] : tree.selection(),
        additional: parseAdditionalParams(),
        limit: 20,
        next: append ? nextPage : undefined,
        cursor: append ? searchCursor : undefined,
        signal: reading,
      };
      const response = connection.isApi
        ? await searchStacApi(connection, options)
        : await searchStaticStac(connection, options);
      if (search !== searchGeneration) return;
      allItems = append ? [...allItems, ...response.items] : response.items;
      nextPage = response.next;
      searchCursor = response.cursor;
      // A fresh search invalidates the selection; "Load more" keeps it.
      if (!append) selectedItemId = null;
      renderItems();
      showFootprints(allItems);
      applySelection(false);
      loadMore.hidden = !nextPage && !searchCursor;
      setDisabled(clearResultsButton, allItems.length === 0);
      setStatus(searchStatus(response));
    } catch (error) {
      // A search the user has moved on from must not report its failure over the current one.
      if (search !== searchGeneration) return;
      setStatus(error instanceof Error ? error.message : labels.searchFailed, true);
    } finally {
      if (search === searchGeneration) {
        setDisabled(searchButton, false);
        setDisabled(loadMore, false);
      }
    }
  }

  catalogSearch.input.addEventListener("input", renderCatalogs);
  catalogSelect.addEventListener("change", () => {
    if (catalogSelect.value) urlField.input.value = catalogSelect.value;
  });
  connectButton.addEventListener("click", async () => {
    const url = urlField.input.value.trim();
    setDisabled(connectButton, true);
    setStatus(labels.connecting);
    try {
      connection = await connectStac(url, fetch, controller.signal);
      catalogInfo.textContent = labels.catalogInfo(
        connection.title,
        connection.isApi ? labels.kindApi : labels.kindStatic,
      );
      collectionSelect.innerHTML = "";
      if (connection.collections.length) {
        for (const collection of connection.collections) {
          const option = el("option", collection.title || collection.id);
          option.value = collection.id;
          collectionSelect.append(option);
        }
        collectionSelect.hidden = false;
      } else {
        collectionSelect.hidden = true;
      }
      const children = connection.children ?? [];
      tree.reset(children);
      tree.element.hidden = connection.isApi || !children.length;
      searchSection.hidden = false;
      renderSection.hidden = false;
      clearSearchResults(false);
      setStatus(connection.description || labels.connected);
    } catch (error) {
      connection = null;
      searchSection.hidden = true;
      renderSection.hidden = true;
      setStatus(error instanceof Error ? error.message : labels.connectFailed, true);
    } finally {
      setDisabled(connectButton, false);
    }
  });
  searchButton.addEventListener("click", () => void runSearch(false));
  clearResultsButton.addEventListener("click", () => clearSearchResults());
  loadMore.addEventListener("click", () => void runSearch(true));
  drawButton.addEventListener("click", () => {
    if (cancelDraw) {
      cancelDraw();
      cancelDraw = null;
      drawButton.textContent = labels.drawBbox;
      return;
    }
    drawButton.textContent = labels.cancelDrawing;
    setStatus(labels.drawHint);
    cancelDraw = beginBboxDraw((bbox) => {
      cancelDraw = null;
      drawButton.textContent = labels.drawBbox;
      bboxField.input.value = bbox.map((value) => value.toFixed(6)).join(", ");
      useExtent.checked = false;
      clearDrawButton.hidden = false;
      setStatus(labels.drawnBbox(bboxField.input.value));
    });
    if (!cancelDraw) {
      drawButton.textContent = labels.drawBbox;
      setStatus(labels.mapNotReady, true);
    }
  });
  clearDrawButton.addEventListener("click", () => {
    bboxField.input.value = "";
    clearDrawButton.hidden = true;
    const map = appRef?.getMap?.();
    if (map) removeDrawBox(map);
    setStatus(labels.drawnBboxCleared);
  });

  // Clicking a footprint selects the matching result card. The bbox-draw mode
  // owns the pointer while it is active, so both handlers stand down for it.
  const footprintIdAt = (event: MapMouseEvent): string | null => {
    const map = appRef?.getMap?.();
    if (!map || cancelDraw) return null;
    const layers = footprintStyleLayers(map);
    if (!layers.length) return null;
    const feature = map.queryRenderedFeatures(event.point, { layers })[0];
    const id = feature?.properties?.id;
    return typeof id === "string" ? id : null;
  };
  const onMapClick = (event: MapMouseEvent): void => {
    const id = footprintIdAt(event);
    if (id) selectItem(id, true);
  };
  const onMapMove = (event: MapMouseEvent): void => {
    const map = appRef?.getMap?.();
    if (!map || cancelDraw) return;
    map.getCanvas().style.cursor = footprintIdAt(event) ? "pointer" : "";
  };
  const map = appRef?.getMap?.();
  map?.on("click", onMapClick);
  map?.on("mousemove", onMapMove);

  void loadStacIndex(fetch, controller.signal).then(
    (catalogs) => {
      index = catalogs;
      renderCatalogs();
    },
    (error) => {
      catalogSelect.innerHTML = "";
      catalogSelect.append(el("option", labels.indexUnavailable));
      setStatus(error instanceof Error ? error.message : labels.indexLoadFailed, true);
    },
  );

  return () => {
    controller.abort();
    cancelDraw?.();
    searchGeneration += 1;
    // The footprints are the user's layer now, so closing the panel leaves them
    // on the map; only deactivating the plugin tears them down.
    const activeMap = appRef?.getMap?.();
    if (activeMap) {
      activeMap.off("click", onMapClick);
      activeMap.off("mousemove", onMapMove);
      activeMap.getCanvas().style.cursor = "";
      removeDrawBox(activeMap);
      removeSelectionHighlight(activeMap);
    }
  };
}

function mountPanel(container: HTMLElement): void {
  disposePanel?.();
  panelContainer = container;
  disposePanel = buildPanel(container);
}

export const maplibreStacCatalogsPlugin: GeoLibrePlugin = {
  id: STAC_PLUGIN_ID,
  name: "STAC Catalogs",
  version: "0.1.0",
  activate(app) {
    appRef = app;
    unregisterPanel =
      app.registerRightPanel?.({
        id: PANEL_ID,
        title: () => labels.getTitle?.() ?? labels.title,
        dock: "replace-style",
        defaultWidth: 380,
        render(container) {
          mountPanel(container);
          return () => {
            disposePanel?.();
            disposePanel = null;
            if (panelContainer === container) panelContainer = null;
          };
        },
      }) ?? null;
    app.openRightPanel?.(PANEL_ID);
  },
  deactivate(app) {
    app.closeRightPanel?.(PANEL_ID);
    unregisterPanel?.();
    unregisterPanel = null;
    removeFootprints();
    const map = app.getMap?.();
    if (map) {
      removeDrawBox(map);
      removeSelectionHighlight(map);
    }
    appRef = null;
  },
};

export default maplibreStacCatalogsPlugin;
