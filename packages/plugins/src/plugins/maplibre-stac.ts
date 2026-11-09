import { DEFAULT_LAYER_STYLE, useAppStore } from "@geolibre/core";
import {
  fillLayerId,
  lineLayerId,
  mapboxFillLayerId,
  mapboxLineLayerId,
} from "@geolibre/map/style-layer-ids";
import type { FeatureCollection, Geometry } from "geojson";
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import type { Map as MapboxMap } from "mapbox-gl";

import type {
  GeoLibreAppAPI,
  GeoLibreCogLayerOptions,
  GeoLibreCogRenderEngine,
  GeoLibrePlugin,
} from "../types";
import { addPMTilesAsset } from "./stac-layers";
import { getControlMap } from "./style-map";
import {
  assetDisplayFormat,
  assetFormat,
  assetTargets,
  canAddAsset,
  connectStac,
  horizontalBbox,
  icechunkBranch,
  isIcechunkAsset,
  isVisualizableAsset,
  requiresTarget,
  itemBbox,
  loadStacIndex,
  loadPortolanIndex,
  portolanIndexFromDocument,
  PORTOLAN_REGISTRY_URL,
  openCatalogNode,
  searchStacApi,
  searchStaticStac,
  sortStacItems,
  type StacSortDirection,
  withinCloudCover,
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
  stacDateInterval,
} from "./stac-api";
import {
  AOI_MAX_POSITIONS,
  bufferGeometry,
  countPositions,
  geometryFromFile,
  type MergedArea,
  selectedFeaturesGeometry,
} from "./stac-aoi";
import {
  availableCombinations,
  availableIndices,
  bandsForFormula,
  COMBINATIONS,
  findBand,
  formulaNames,
  INDICES,
  itemBands,
  type StacBand,
} from "./stac-bands";
import { buildCatalogTree } from "./stac-catalog-tree";
import {
  registerStacRenderProtocol,
  renderTileUrl,
  type RenderBand,
  type StacRenderSpec,
} from "./stac-render";
import { el, setDisabled } from "../panel-dom";
import { addVectorLayersFromUrl } from "./maplibre-vector";
import { addLidarLayerFromUrl, addZarrRasterLayer } from "./maplibre-components";
import {
  icechunkLayerUrl,
  icechunkTimeAttributesReader,
  openIcechunkStore,
  repositoryOpenError,
  type ZarrKeyReader,
} from "./stac-icechunk";
import {
  createStacAssetAccess,
  readableStacAssetHref,
  STAC_ASSET_ACCESS_METADATA_KEY,
  type StacAssetAccess,
} from "./stac-signing";

export const STAC_PLUGIN_ID = "geolibre-stac-catalogs";
export const PLANET_OPEN_DATA_PLUGIN_ID = "geolibre-planet-open-data";
export const PORTOLAN_PLUGIN_ID = "geolibre-portolan";
export const PLANET_DISASTER_DATA_CATALOG_URL =
  "https://data.source.coop/planet/disasterdata/catalog.json";
// The footprints layer is a normal store layer, so it is saved into the project
// while `footprintLayerId` only lives for the session. This marker is how a
// later search — or a reopened project — recognizes the layer as ours instead
// of adding a second copy.
type StacPointerEvent = { point: { x: number; y: number } };
type StacMap = Omit<MapLibreMap | MapboxMap, "getSource" | "on" | "off"> & {
  getSource(id: string): unknown;
  on(type: "click" | "mousemove", listener: (event: StacPointerEvent) => void): unknown;
  off(type: "click" | "mousemove", listener: (event: StacPointerEvent) => void): unknown;
};

/**
 * STAC uses the native GeoJSON, picking and pointer APIs shared by both 2D
 * engines; on ArcGIS and the Cesium globe the host's control map records them,
 * draws the GeoJSON itself and answers picks from it.
 */
function getStacMap(app: GeoLibreAppAPI | null): StacMap | null {
  return getControlMap(app) as StacMap | null;
}

const FOOTPRINT_SOURCE_KIND = "stac-footprints";
const DRAW_SOURCE = "geolibre-stac-draw-bbox";
const DRAW_FILL = "geolibre-stac-draw-bbox-fill";
const DRAW_LINE = "geolibre-stac-draw-bbox-line";
const DRAW_POINT = "geolibre-stac-draw-bbox-point";
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
  planetTitle: string;
  /** Planet title getter pushed by the host so the preset panel re-localizes live. */
  getPlanetTitle?: () => string;
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
  areaLabel: string;
  drawPoint: string;
  drawLine: string;
  drawPolygon: string;
  useSelection: string;
  loadAreaFile: string;
  clearArea: string;
  drawPointHint: string;
  drawShapeHint: string;
  areaCleared: string;
  noSelection: string;
  areaFileFailed: string;
  areaTooLarge: (positions: number, max: number) => string;
  areaSet: (description: string) => string;
  areaIgnored: (count: number) => string;
  addAsset: string;
  addAssetHint: string;
  addRendering: string;
  addRenderingHint: string;
  groupCombinations: string;
  groupIndices: string;
  renderNeedsMapLibre: string;
  renderMissingBand: (name: string) => string;
  sortLabel: string;
  sortDefault: string;
  sortNewest: string;
  sortOldest: string;
  sortHint: string;
  bufferLabel: string;
  bufferHint: string;
  bufferDistance: (meters: number) => string;
  cloudLabel: string;
  cloudHint: string;
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
  formatPointCloud: string;
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
  planetTitle: "Planet Open Data",
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
  areaLabel: "Search area",
  drawPoint: "Point",
  drawLine: "Line",
  drawPolygon: "Polygon",
  useSelection: "Selected features",
  loadAreaFile: "From file…",
  clearArea: "Clear shape",
  drawPointHint: "Click the map to place a search point. Escape cancels.",
  drawShapeHint: "Click to add vertices; double-click or press Enter to finish. Escape cancels.",
  areaCleared: "Search shape cleared.",
  noSelection:
    "Select features on the map first: open a layer’s menu, choose Select features, then try again.",
  areaFileFailed: "Could not read a search shape from that file.",
  areaTooLarge: (positions, max) =>
    `That shape has ${positions} vertices; simplify it to ${max} or fewer.`,
  areaSet: (description) => `Searching within ${description}.`,
  areaIgnored: (count) => `${count} lower-dimension shape(s) were left out.`,
  addAsset: "Assets",
  addAssetHint: "Add one of this item's assets to the map",
  addRendering: "Bands",
  addRenderingHint: "Add a band combination or index of this item to the map",
  groupCombinations: "Band combinations",
  groupIndices: "Indices",
  renderNeedsMapLibre: "Renderings need the MapLibre renderer.",
  renderMissingBand: (name) => `This item has no band called ${name}.`,
  sortLabel: "Sort by date",
  sortDefault: "Server default",
  sortNewest: "Newest first",
  sortOldest: "Oldest first",
  bufferLabel: "Buffer points and lines by",
  bufferHint:
    "Widen a point or line into a polygon this many meters either side before searching. Polygons are not changed.",
  bufferDistance: (meters) => `${meters} m`,
  cloudLabel: "Max cloud",
  cloudHint:
    "Keep scenes with at most this much cloud cover. Scenes that report none (radar, elevation, aerial imagery) are kept.",
  sortHint:
    "Orders the results loaded so far by capture date. Load more can bring scenes that belong earlier or later.",
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
    "Only GeoTIFF/COG, GeoJSON, GeoParquet, PMTiles, Zarr, and COPC/LAZ/EPT point cloud assets can be added to the map",
  addFailed: "Could not add asset",
  addNoSourceLayers: "This archive lists no layers to draw",
  cogUnsupported: "This GeoLibre host cannot visualize remote GeoTIFF assets",
  formatCog: "COG",
  formatGeoJson: "GeoJSON",
  formatPmtiles: "PMTiles",
  formatParquet: "Parquet",
  formatZarr: "Zarr",
  formatPointCloud: "Point cloud",
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

// Every createStacPlugin() instance shares the module-level state below, so at
// most one may be active at a time. That is enforced by the `exclusiveGroup`
// the factory sets on each plugin, which PluginManager honours in activate()
// and restoreProjectState(). Activating two instances by calling activate() on
// the plugin objects directly, bypassing the manager, would let them stomp each
// other's catalog url, footprint layer, and panel handles.
let appRef: GeoLibreAppAPI | null = null;
// The result footprints are a first-class store layer, so they show up in the
// Layers panel and can be hidden, restyled, or removed like any other layer.
let footprintLayerId: string | null = null;
let unregisterPanel: (() => void) | null = null;
let disposePanel: (() => void) | null = null;
let panelContainer: HTMLElement | null = null;
let initialCatalogUrl = "";
// A catalog asked for from outside the panel (the `?stac=` deep link), taking the place of the
// plugin's own preset on its next activation.
let requestedCatalogUrl = "";
// Which createStacPlugin() instance owns the shared state above, since they all share it.
let activePluginId: string | null = null;
interface CatalogBrowserOptions {
  loadIndex?: typeof loadStacIndex;
  indexFromConnection?: (connection: StacConnection) => StacIndexCatalog[];
  catalogSearchLabel?: (app: GeoLibreAppAPI) => string;
  indexLabels?: (
    app: GeoLibreAppAPI,
  ) => Pick<StacLabels, "indexLoading" | "indexUnavailable" | "indexLoadFailed">;
}
let browserOptions: CatalogBrowserOptions = {};

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

/**
 * A checkbox that turns a numeric option on, with a number box for its value and a unit beside it.
 * The box is dimmed and locked while the checkbox is off.
 */
function numberOption(config: {
  label: string;
  hint: string;
  min: number;
  max: number;
  value: number;
  unit: string;
  /** Width of the number box in pixels (default 64). */
  width?: number;
  /** Called when the checkbox flips or the number is edited. */
  onChange?: () => void;
}): { wrap: HTMLElement; check: HTMLInputElement; input: HTMLInputElement; value: () => number } {
  const wrap = el("label");
  wrap.style.cssText = `${style.row}cursor:pointer;`;
  wrap.title = config.hint;
  const check = el("input");
  check.type = "checkbox";
  const input = el("input");
  input.type = "number";
  input.min = String(config.min);
  input.max = String(config.max);
  input.step = "1";
  input.value = String(config.value);
  // A label names only its first control (the checkbox), so the number is named explicitly.
  input.setAttribute("aria-label", config.label);
  const width = config.width ?? 64;
  input.style.cssText = `${style.input}width:${width}px;flex:0 0 ${width}px;`;
  const unit = el("span", config.unit);
  unit.style.cssText = style.label;
  // An empty or out-of-range box reads as the nearest value it could mean, never as NaN.
  const value = (): number => {
    const typed = Number(input.value);
    if (input.value.trim() === "" || !Number.isFinite(typed)) return config.value;
    return Math.min(config.max, Math.max(config.min, typed));
  };
  const sync = (): void => {
    input.disabled = !check.checked;
    input.style.opacity = check.checked ? "1" : "0.5";
  };
  check.addEventListener("change", () => {
    sync();
    config.onChange?.();
  });
  input.addEventListener("change", () => config.onChange?.());
  sync();
  wrap.append(check, el("span", config.label), input, unit);
  return { wrap, check, input, value };
}

function currentExtent(): [number, number, number, number] | undefined {
  const bounds = getStacMap(appRef)?.getBounds();
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

function removeDrawBox(map: StacMap): void {
  if (map.getLayer(DRAW_POINT)) map.removeLayer(DRAW_POINT);
  if (map.getLayer(DRAW_LINE)) map.removeLayer(DRAW_LINE);
  if (map.getLayer(DRAW_FILL)) map.removeLayer(DRAW_FILL);
  if (map.getSource(DRAW_SOURCE)) map.removeSource(DRAW_SOURCE);
}

function showDrawBox(map: StacMap, bbox: [number, number, number, number]): void {
  const [west, south, east, north] = bbox;
  showDrawGeometry(map, {
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
  });
}

/** Draws the search area on the map: a rectangle, point, line, polygon, or any mix of them. */
function showDrawGeometry(map: StacMap, geometry: Geometry): void {
  const data: FeatureCollection = {
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: {}, geometry }],
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
    paint: { "line-color": "#f59e0b", "line-width": 2, "line-dasharray": [2, 1] },
  });
  map.addLayer({
    id: DRAW_POINT,
    type: "circle",
    source: DRAW_SOURCE,
    paint: {
      "circle-radius": 5,
      "circle-color": "#f59e0b",
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 1.5,
    },
  });
}

export type StacDrawShape = "point" | "line" | "polygon";

/**
 * Drawings that are open now, and whether double-click zoom was on before the first of them. A
 * drawing turns the zoom off so a double-click can finish it; it is turned back on only when the
 * last one closes, and only if it was on to begin with.
 */
let openShapeDraws = 0;
let doubleClickZoomWasOn = true;

/**
 * Lets the user click out a point, line or polygon on the map. A point finishes on the first
 * click; a line or polygon takes one click per vertex and finishes on a double-click or Enter.
 * Escape cancels. The shape is previewed as it grows and left on the map when finished.
 *
 * @returns A function that abandons the drawing, or null when the map is not ready.
 */
function beginShapeDraw(
  shape: StacDrawShape,
  onComplete: (geometry: Geometry) => void,
  onCancel: () => void,
): (() => void) | null {
  const map = getStacMap(appRef);
  if (!map) return null;
  const canvas = map.getCanvas();
  const vertices: Array<[number, number]> = [];
  let cursor: [number, number] | null = null;
  let downAt: { x: number; y: number } | null = null;
  let finished = false;
  if (openShapeDraws === 0) doubleClickZoomWasOn = map.doubleClickZoom?.isEnabled?.() ?? true;
  openShapeDraws += 1;
  map.doubleClickZoom?.disable();
  canvas.style.cursor = "crosshair";

  const cleanup = (): void => {
    if (finished) return;
    finished = true;
    openShapeDraws -= 1;
    canvas.removeEventListener("mousedown", onDown);
    canvas.removeEventListener("click", onClick);
    canvas.removeEventListener("dblclick", onDouble);
    canvas.removeEventListener("mousemove", onMove);
    window.removeEventListener("keydown", onKey);
    canvas.style.cursor = "";
    // MapLibre treats a double-click zoom disabled mid-gesture as still pending; defer the restore.
    // A drawing begun in the meantime has the zoom switched off again, and keeps it that way.
    setTimeout(() => {
      if (openShapeDraws === 0 && doubleClickZoomWasOn) map.doubleClickZoom?.enable();
    }, 0);
  };
  const pixel = (event: MouseEvent): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const lngLat = (event: MouseEvent): [number, number] => {
    const { x, y } = pixel(event);
    // A world copy of the map gives longitudes past 180; wrapped, 181 is -179, not a clamped 180.
    const point = map.unproject([x, y]).wrap();
    return [point.lng, Math.max(-90, Math.min(90, point.lat))];
  };
  const build = (extra: [number, number] | null): Geometry | null => {
    const points = extra ? [...vertices, extra] : vertices;
    if (shape === "point") return points.length ? { type: "Point", coordinates: points[0] } : null;
    if (points.length < 2) {
      return points.length ? { type: "Point", coordinates: points[0] } : null;
    }
    if (shape === "line" || points.length < 3) return { type: "LineString", coordinates: points };
    return { type: "Polygon", coordinates: [[...points, points[0]]] };
  };
  const finish = (): void => {
    const geometry = build(null);
    const enough = shape === "line" ? vertices.length >= 2 : vertices.length >= 3;
    // Nothing to finish yet: a point with no click, or too few vertices. The drawing stays open
    // rather than ending without a shape.
    if (!geometry || (shape !== "point" && !enough)) return;
    cleanup();
    showDrawGeometry(map, geometry);
    onComplete(geometry);
  };
  const onDown = (event: MouseEvent): void => {
    downAt = pixel(event);
  };
  const onClick = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    const here = pixel(event);
    // A click that ends a pan is not a vertex.
    if (downAt && Math.hypot(here.x - downAt.x, here.y - downAt.y) > 4) return;
    const next = lngLat(event);
    if (vertices.length) {
      const last = map.project(vertices[vertices.length - 1]);
      // The second click of a double-click lands on the first; it is not another vertex.
      if (Math.hypot(here.x - last.x, here.y - last.y) < 4) return;
    }
    vertices.push(next);
    if (shape === "point") return finish();
    const preview = build(null);
    if (preview) showDrawGeometry(map, preview);
  };
  const onDouble = (event: MouseEvent): void => {
    event.preventDefault();
    finish();
  };
  const onMove = (event: MouseEvent): void => {
    if (!vertices.length) return;
    cursor = lngLat(event);
    const preview = build(cursor);
    if (preview) showDrawGeometry(map, preview);
  };
  const onKey = (event: KeyboardEvent): void => {
    // The keys are the drawing's only while the user is not typing: Enter in a field of the panel
    // (a date, the bbox box) is for that field.
    const target = event.target as HTMLElement | null;
    if (target?.closest("input, textarea, select, [contenteditable]")) return;
    if (event.key === "Escape") {
      const wasOpen = !finished;
      cleanup();
      if (wasOpen) onCancel();
    } else if (event.key === "Enter") finish();
  };
  canvas.addEventListener("mousedown", onDown);
  canvas.addEventListener("click", onClick);
  canvas.addEventListener("dblclick", onDouble);
  canvas.addEventListener("mousemove", onMove);
  window.addEventListener("keydown", onKey);
  return cleanup;
}

function beginBboxDraw(
  onComplete: (bbox: [number, number, number, number]) => void,
): (() => void) | null {
  const map = getStacMap(appRef);
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

function removeSelectionHighlight(map: StacMap): void {
  if (map.getLayer(SELECT_LINE)) map.removeLayer(SELECT_LINE);
  if (map.getLayer(SELECT_FILL)) map.removeLayer(SELECT_FILL);
  if (map.getSource(SELECT_SOURCE)) map.removeSource(SELECT_SOURCE);
}

function showSelectionHighlight(geometry: Geometry | null): void {
  const map = getStacMap(appRef);
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
function footprintStyleLayers(map: StacMap): string[] {
  if (!footprintLayerId) return [];
  return [
    fillLayerId(footprintLayerId),
    lineLayerId(footprintLayerId),
    mapboxFillLayerId(footprintLayerId),
    mapboxLineLayerId(footprintLayerId),
  ].filter((id) => map.getLayer(id));
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
    case "pointcloud":
      return labels.formatPointCloud;
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

/**
 * Planetary Computer serves several collections from private containers that answer 409 without
 * a SAS token, while others (NAIP) read fine anonymously.
 * Signed URLs expire within the hour, so they are minted when the asset is added rather than when
 * the item is parsed, and cached until shortly before expiry. Anything
 * that is not an eligible Planetary Computer Azure blob, or that cannot be signed, is read
 * unsigned. COG and GeoParquet layers retain the unsigned asset identity in metadata so project
 * restore can mint a fresh token instead of replaying an expired one.
 */
function assetAccess(
  connection: StacConnection,
  item: StacItem,
  href: string,
): StacAssetAccess | null {
  return createStacAssetAccess(connection.url, item.collection, href);
}

/**
 * Records how a layer's asset can be signed again, so a saved project restores
 * a private asset instead of replaying an expired token.
 *
 * The layer has to be in the store already: every add path here resolves only
 * after its control's store sync has written it (see the Zarr branch below).
 * Should that ever stop holding, signed assets would quietly stop surviving a
 * project save, so say so rather than dropping the record in silence.
 */
function rememberAssetAccess(layerId: string, access: StacAssetAccess | null): void {
  if (!access) return;
  const layer = useAppStore.getState().layers.find((candidate) => candidate.id === layerId);
  if (!layer) {
    console.warn("[GeoLibre] STAC asset access could not be stored: no layer", layerId);
    return;
  }
  useAppStore.getState().updateLayer(layerId, {
    metadata: { ...layer.metadata, [STAC_ASSET_ACCESS_METADATA_KEY]: access },
    source: { ...layer.source, url: access.href },
    sourcePath: access.href,
  });
}

function readableHref(
  connection: StacConnection,
  item: StacItem,
  href: string,
  signal?: AbortSignal,
): Promise<string> {
  return readableStacAssetHref(assetAccess(connection, item, href), href, signal);
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
  connection: StacConnection,
  item: StacItem,
  key: string,
  asset: StacAsset,
  cogOptions: GeoLibreCogLayerOptions,
  signal?: AbortSignal,
  target?: string,
): Promise<void> {
  const name = `${itemTitle(item)} — ${assetLabel(key, asset)}`;
  const format = assetFormat(asset);
  switch (format) {
    case "pmtiles": {
      // No appRef check: the layer goes to the store, not through the app API.
      // Read unsigned, exactly as before: Planetary Computer serves no PMTiles
      // from a private container, and a tile URL that outlives its token would
      // break the layer an hour later rather than fix it.
      if (!(await addPMTilesAsset(asset.href, name, signal))) {
        throw new Error(labels.addNoSourceLayers);
      }
      return;
    }
    case "geojson": {
      if (!appRef) throw new Error(labels.addFailed);
      const response = await fetch(await readableHref(connection, item, asset.href, signal), {
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
      const access = assetAccess(connection, item, asset.href);
      const href = await readableStacAssetHref(access, asset.href, signal);
      const layerIds = await addVectorLayersFromUrl(appRef, href, { name });
      if (!layerIds?.length) {
        throw new Error(labels.addFailed);
      }
      for (const layerId of layerIds) rememberAssetAccess(layerId, access);
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
      const access = assetAccess(connection, item, asset.href);
      const href = await readableStacAssetHref(access, asset.href, signal);
      const layerId = await appRef.addCogLayer(name, href, cogOptions);
      rememberAssetAccess(layerId, access);
      return;
    }
    case "pointcloud": {
      if (!appRef) throw new Error(labels.addFailed);
      // The LiDAR control streams COPC and EPT by URL (range reads / octree nodes). Signed for a
      // private Planetary Computer container, but not remembered: only raster sync re-signs on
      // restore, and recording the access would swap the layer's URL for the unsigned one.
      const href = await readableHref(connection, item, asset.href, signal);
      if (!(await addLidarLayerFromUrl(appRef, href))) throw new Error(labels.addFailed);
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

/**
 * A band as a rendering recipe holds it: the file's own address and how to sign it, not a signed
 * address. A signature would be saved with the project, would expire within the hour, and is a
 * credential; the renderer asks for a fresh one whenever it reads the file.
 */
function renderBandOf(connection: StacConnection, item: StacItem, band: StacBand): RenderBand {
  const access = assetAccess(connection, item, band.href);
  return {
    href: band.href,
    index: band.index,
    scale: band.scale,
    offset: band.offset,
    ...(band.nodata !== undefined ? { nodata: band.nodata } : {}),
    ...(access ? { access } : {}),
  };
}

/** What the "Add rendering" menu offers: a three-band combination, or an index by name. */
export type StacRenderingChoice = { kind: "combination" | "index"; name: string };

/**
 * Adds a band combination or a spectral index of an item to the map as a tile layer.
 *
 * @param connection - The catalog the item came from, for how its private assets are signed.
 * @param item - The item whose bands are drawn.
 * @param choice - The combination or index.
 * @returns The new layer's id.
 * @throws When the renderer is not MapLibre, or the item lacks a band the choice needs.
 */
function addRendering(
  connection: StacConnection,
  item: StacItem,
  choice: StacRenderingChoice,
): string {
  const app = appRef;
  // engine-audit-allow: getMap-mapbox -- detects MapLibre; renderings are hidden on Mapbox
  if (!app?.addTileLayer || !app.getMap?.()) throw new Error(labels.renderNeedsMapLibre);
  const bands = itemBands(item);
  const need = (name: string): StacBand => {
    const band = findBand(bands, name);
    if (!band) throw new Error(labels.renderMissingBand(name));
    return band;
  };
  let spec: StacRenderSpec;
  if (choice.kind === "combination") {
    const channels = COMBINATIONS[choice.name];
    const read = channels.map(need).map((band) => renderBandOf(connection, item, band));
    spec = { kind: "rgb", bands: read as [RenderBand, RenderBand, RenderBand] };
  } else {
    const formula = INDICES[choice.name];
    formulaNames(formula).forEach(need);
    const read = bandsForFormula(formula, bands).map((band) =>
      renderBandOf(connection, item, band),
    );
    spec = { kind: "index", formula, bands: read };
  }
  registerStacRenderProtocol();
  const bbox = itemBbox(item);
  const layerId = app.addTileLayer(`${itemTitle(item)} — ${choice.name}`, renderTileUrl(spec), {
    tileSize: 256,
    // Tiles deeper than the data's own detail just upsample, and each reads only a small window.
    maxzoom: 17,
    ...(bbox ? { bounds: bbox } : {}),
    metadata: { stacItemId: item.id, stacRendering: choice.name },
  });
  if (bbox) app.fitBounds?.(bbox);
  return layerId;
}

/** An item's descriptive title when available, otherwise its stable identifier. */
function itemTitle(item: StacItem): string {
  const title = item.properties.title;
  return typeof title === "string" && title.trim() ? title : item.id;
}

function buildPanel(container: HTMLElement): () => void {
  container.innerHTML = "";
  container.style.cssText = style.panel;
  const controller = new AbortController();

  const catalogSection = el("div");
  catalogSection.style.cssText = style.section;
  const catalogSearch = field(
    (appRef && browserOptions.catalogSearchLabel?.(appRef)) || labels.catalogSearch,
  );
  catalogSearch.input.placeholder = labels.catalogSearchPlaceholder;
  const catalogSelect = el("select");
  catalogSelect.style.cssText = style.input;
  const indexLabels = (appRef && browserOptions.indexLabels?.(appRef)) || labels;
  const firstOption = el("option", indexLabels.indexLoading);
  firstOption.value = "";
  catalogSelect.append(firstOption);
  const urlField = field(labels.urlLabel, "url");
  urlField.input.placeholder = "https://example.org/stac/";
  urlField.input.value = initialCatalogUrl;
  let presetSelectionPending = Boolean(initialCatalogUrl);
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
  const drawButton = el("button", labels.drawBbox);
  drawButton.type = "button";
  drawButton.style.cssText = style.button;
  const clearDrawButton = el("button", labels.clearDrawnBbox);
  clearDrawButton.type = "button";
  clearDrawButton.style.cssText = style.button;
  setDisabled(clearDrawButton, true);

  // Search by a shape instead of a rectangle: drawn on the map, taken from the features selected
  // in a layer, or read from a file. The shape replaces the bbox, as STAC Item Search requires.
  const areaWrap = el("div");
  areaWrap.style.cssText = "display:flex;flex-direction:column;gap:4px;";
  const areaCaption = el("span", labels.areaLabel);
  areaCaption.style.cssText = style.label;
  const areaRow = el("div");
  areaRow.style.cssText = `${style.row}flex-wrap:wrap;`;
  const areaButton = (text: string): HTMLButtonElement => {
    const button = el("button", text);
    button.type = "button";
    button.style.cssText = style.button;
    return button;
  };
  const pointButton = areaButton(labels.drawPoint);
  const lineButton = areaButton(labels.drawLine);
  const polygonButton = areaButton(labels.drawPolygon);
  const selectionButton = areaButton(labels.useSelection);
  const fileButton = areaButton(labels.loadAreaFile);
  const clearAreaButton = areaButton(labels.clearArea);
  setDisabled(clearAreaButton, true);
  const areaFile = el("input");
  areaFile.type = "file";
  areaFile.accept = ".geojson,.json,.zip";
  areaFile.hidden = true;
  areaRow.append(
    pointButton,
    lineButton,
    polygonButton,
    selectionButton,
    fileButton,
    drawButton,
    clearAreaButton,
    clearDrawButton,
    areaFile,
  );
  // A checkbox with an amount in meters. It only affects points and lines, and widening or
  // narrowing it redraws the shape already chosen.
  const buffer = numberOption({
    label: labels.bufferLabel,
    hint: labels.bufferHint,
    min: 1,
    max: 100_000,
    value: 100,
    unit: "m",
    onChange: () => applyArea(),
  });
  const bufferMeters = (): number => (buffer.check.checked ? buffer.value() : 0);
  areaWrap.append(areaCaption, areaRow, buffer.wrap);
  const dates = el("div");
  dates.style.cssText = style.row;
  const startField = field(labels.startDate, "date");
  const endField = field(labels.endDate, "date");
  dates.append(startField.wrap, endField.wrap);
  const sortWrap = el("label");
  sortWrap.style.cssText = "display:flex;min-width:0;flex-direction:column;gap:2px;";
  const sortCaption = el("span", labels.sortLabel);
  sortCaption.style.cssText = style.label;
  const sortSelect = el("select");
  sortSelect.style.cssText = style.input;
  sortSelect.title = labels.sortHint;
  for (const [value, title] of [
    ["", labels.sortDefault],
    ["desc", labels.sortNewest],
    ["asc", labels.sortOldest],
  ] as const) {
    const option = el("option", title);
    option.value = value;
    sortSelect.append(option);
  }
  sortWrap.append(sortCaption, sortSelect);
  const cloud = numberOption({
    label: labels.cloudLabel,
    hint: labels.cloudHint,
    min: 0,
    max: 100,
    value: 10,
    unit: "%",
    width: 52,
  });
  // Sort order and the cloud limit are both about which scenes come back, so they share a row.
  const sortCloudRow = el("div");
  sortCloudRow.style.cssText = "display:flex;gap:8px;align-items:flex-end;flex-wrap:nowrap;";
  sortWrap.style.flex = "1 1 0";
  sortWrap.style.minWidth = "0";
  cloud.wrap.style.flex = "0 0 auto";
  cloud.wrap.style.minHeight = "30px";
  sortCloudRow.append(cloud.wrap, sortWrap);
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
    areaWrap,
    bboxField.wrap,
    dates,
    sortCloudRow,
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
  /** The shape items must intersect, when the search is by shape rather than by rectangle. */
  let searchArea: Geometry | undefined;
  /** Counts area choices, so a file still being read when another is chosen can be dropped. */
  let areaGeneration = 0;
  /** Set when the panel closes, so a read that finishes after it has nothing to update. */
  let disposed = false;
  /** Every result loaded, in the order the server gave them; `allItems` is this, sorted. */
  let fetchedItems: StacItem[] = [];
  /** What a search was run with, kept for its later pages so the list never mixes criteria. */
  let pageCriteria: { maxCloudCover?: number; sortDirection?: StacSortDirection } = {};
  /** The shape as chosen, before any buffer; `searchArea` is this, widened when the buffer is on. */
  let chosenArea: MergedArea | undefined;
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
    fetchedItems = [];
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
    if (
      presetSelectionPending &&
      urlField.input.value === initialCatalogUrl &&
      filtered.some((entry) => entry.url === initialCatalogUrl)
    ) {
      catalogSelect.value = initialCatalogUrl;
      presetSelectionPending = false;
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
      const title = el("div", itemTitle(item));
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
        let busy = false;
        // Each menu shows its own name and acts the moment an entry is chosen, then goes back to
        // its name: it is a button that drops a list, not a setting that keeps a value.
        const menu = (text: string, hint?: string): HTMLSelectElement => {
          const select = el("select");
          // Sized by the row, not by the longest option: a long asset name must not push a menu
          // onto a line of its own. The open list still shows the full names.
          select.style.cssText = `${style.input}flex:1 1 0;min-width:0;width:auto;`;
          if (hint) select.title = hint;
          // The selected option is a value, not a name: a screen reader needs one of its own.
          select.setAttribute("aria-label", hint ?? text);
          const placeholder = el("option", text);
          placeholder.value = "";
          select.append(placeholder);
          return select;
        };
        const menus: HTMLSelectElement[] = [];
        const setBusy = (value: boolean): void => {
          busy = value;
          for (const select of menus) select.disabled = value;
        };

        // Add asset: one entry per asset, and per variable for a Zarr store holding several.
        const addEntries = new Map<string, { key: string; asset: StacAsset; target?: string }>();
        const addSelect = menu(labels.addAsset, labels.addAssetHint);
        for (const [key, asset] of assets) {
          const addable = canAddAsset(item, key, asset);
          const targets = addable ? assetTargets(item, key, asset) : [];
          const choices =
            targets.length > 1
              ? targets.map((target) => ({ target: target.id, suffix: ` — ${target.label}` }))
              : [{ target: undefined, suffix: "" }];
          for (const choice of choices) {
            const id = `a${addEntries.size}`;
            addEntries.set(id, { key, asset, target: choice.target });
            const option = el("option", `${assetOptionLabel(item, key, asset)}${choice.suffix}`);
            option.value = id;
            option.disabled = !addable;
            option.title = addReason(item, key, asset);
            addSelect.append(option);
          }
        }
        menus.push(addSelect);
        addSelect.addEventListener("change", async () => {
          const entry = addEntries.get(addSelect.value);
          addSelect.value = "";
          if (!entry || busy) return;
          const { key, asset, target } = entry;
          setBusy(true);
          setStatus(labels.adding(assetLabel(key, asset)));
          try {
            if (!connection) throw new Error(labels.addFailed);
            await visualizeAsset(
              connection,
              item,
              key,
              asset,
              cogOptions(),
              controller.signal,
              target,
            );
            setStatus(labels.added(assetLabel(key, asset)));
          } catch (error) {
            setStatus(error instanceof Error ? error.message : labels.addFailed, true);
          } finally {
            setBusy(false);
          }
        });

        // Add rendering: the band combinations and indices this item has the bands for.
        const bands = itemBands(item);
        const combinations = availableCombinations(bands);
        const indices = availableIndices(bands);
        let renderSelect: HTMLSelectElement | null = null;
        if (combinations.length || indices.length) {
          const select = menu(labels.addRendering, labels.addRenderingHint);
          const group = (title: string, kind: "combination" | "index", names: string[]): void => {
            if (!names.length) return;
            const optgroup = el("optgroup");
            optgroup.label = title;
            for (const name of names) {
              const option = el("option", name);
              option.value = `${kind}:${name}`;
              optgroup.append(option);
            }
            select.append(optgroup);
          };
          group(labels.groupCombinations, "combination", combinations);
          group(labels.groupIndices, "index", indices);
          select.addEventListener("change", async () => {
            const [kind, ...rest] = select.value.split(":");
            const name = rest.join(":");
            select.value = "";
            if (!name || busy || (kind !== "combination" && kind !== "index")) return;
            setBusy(true);
            setStatus(labels.adding(name));
            try {
              if (!connection) throw new Error(labels.addFailed);
              addRendering(connection, item, { kind, name });
              setStatus(labels.added(name));
            } catch (error) {
              setStatus(error instanceof Error ? error.message : labels.addFailed, true);
            } finally {
              setBusy(false);
            }
          });
          menus.push(select);
          renderSelect = select;
        }

        // Download: an asset's own file, signed first when the catalog keeps it private.
        const downloadSelect = menu(labels.download);
        for (const [key, asset] of assets) {
          const option = el("option", assetOptionLabel(item, key, asset));
          option.value = key;
          option.title = asset.href;
          downloadSelect.append(option);
        }
        menus.push(downloadSelect);
        downloadSelect.addEventListener("change", async () => {
          const chosen = assets.find(([key]) => key === downloadSelect.value);
          downloadSelect.value = "";
          if (!chosen || busy) return;
          const [, asset] = chosen;
          if (!connection) {
            setStatus(labels.addFailed, true);
            return;
          }
          setBusy(true);
          try {
            appRef?.openExternalUrl?.(
              await readableHref(connection, item, asset.href, controller.signal),
            );
          } catch (error) {
            setStatus(error instanceof Error ? error.message : labels.addFailed, true);
          } finally {
            setBusy(false);
          }
        });
        actions.append(addSelect);
        if (renderSelect) actions.append(renderSelect);
        actions.append(downloadSelect);
      }
      card.append(title, subtitle, actions);
      results.append(card);
    }
  };

  /** The sort the dropdown asks for, or undefined for the server's own order. */
  const sortDirectionOf = (): StacSortDirection | undefined =>
    sortSelect.value === "asc" || sortSelect.value === "desc" ? sortSelect.value : undefined;

  const parseBbox = (): [number, number, number, number] | undefined => {
    // A shape replaces the rectangle, so a stale or half-typed bbox must not fail the search.
    if (searchArea) return undefined;
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
    // Nothing on screen yet, but the search is not finished: a page whose items were all left
    // out (by the walk or by the cloud limit) is not "no results".
    if (!allItems.length && (result.cursor || result.next)) return labels.noMatchesHere;
    if (!allItems.length) return labels.noResults;
    if (result.matched) return labels.showingOfMatched(allItems.length, result.matched);
    return labels.showing(allItems.length);
  };

  /** Search the chosen collection and send the map to its extent. */
  function searchChosenCollection(): void {
    const chosen = collectionSelect.selectedOptions[0]?.value;
    const extent = connection?.collections.find((collection) => collection.id === chosen)?.extent;
    const box = horizontalBbox(extent?.spatial?.bbox?.[0]);
    // The map is only on its way to the collection, so "limit to map extent" would still read the
    // bounds it is leaving. The collection's own extent stands in for them; a typed bbox still wins.
    const inView = useExtent.checked && !bboxField.input.value.trim() ? box : undefined;
    void runSearch(false, undefined, inView);
    if (box) appRef?.fitBounds?.(box);
  }
  // A double-click means the same here as in the tree: search this one.
  collectionSelect.addEventListener("dblclick", searchChosenCollection);

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
  async function runSearch(
    append: boolean,
    generation?: number,
    extent?: [number, number, number, number],
  ): Promise<void> {
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
      const datetime = stacDateInterval(start, end);
      // Load more carries on the search it continues, whatever the controls say by now.
      const criteria = append
        ? pageCriteria
        : {
            maxCloudCover: cloud.check.checked ? cloud.value() : undefined,
            sortDirection: sortDirectionOf(),
          };
      const { maxCloudCover, sortDirection } = criteria;
      walking?.abort();
      walking = new AbortController();
      const reading = AbortSignal.any([walking.signal, controller.signal]);
      const options = {
        bbox: searchArea ? undefined : (extent ?? parseBbox()),
        intersects: searchArea,
        sortby: sortDirection,
        maxCloudCover,
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
      // Checked here as well as asked of the server: some accept a cloud filter and ignore it.
      const arrived = withinCloudCover(response.items, maxCloudCover);
      if (!append) pageCriteria = criteria;
      fetchedItems = append ? [...fetchedItems, ...arrived] : arrived;
      // Sorted across every page loaded, so Load more slots new items in rather than appending, and
      // a server that ignored the sort still gives the order asked for.
      allItems = sortDirection ? sortStacItems(fetchedItems, sortDirection) : fetchedItems;
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
    if (catalogSelect.value) {
      presetSelectionPending = false;
      urlField.input.value = catalogSelect.value;
    }
  });
  urlField.input.addEventListener("input", () => {
    if (urlField.input.value !== initialCatalogUrl) presetSelectionPending = false;
  });
  const connectCatalog = async (): Promise<StacConnection | undefined> => {
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
      // The URL named one collection of an API: search it, as a double-click on it would.
      const focus = connection.focusCollection;
      const focusOption = Array.from(collectionSelect.options).find(
        (option) => option.value === focus,
      );
      if (focusOption) {
        focusOption.selected = true;
        focusOption.scrollIntoView?.({ block: "nearest" });
        searchChosenCollection();
      }
      return connection;
    } catch (error) {
      connection = null;
      searchSection.hidden = true;
      renderSection.hidden = true;
      setStatus(error instanceof Error ? error.message : labels.connectFailed, true);
    } finally {
      setDisabled(connectButton, false);
    }
  };
  connectButton.addEventListener("click", () => void connectCatalog());
  const presetConnection = initialCatalogUrl ? connectCatalog() : undefined;
  searchButton.addEventListener("click", () => void runSearch(false));
  clearResultsButton.addEventListener("click", () => clearSearchResults());
  loadMore.addEventListener("click", () => void runSearch(true));
  let activeShape: StacDrawShape | null = null;
  /** Stops a drawing in progress, whichever tool it is, and puts its button back. */
  const stopDrawing = (): void => {
    cancelDraw?.();
    cancelDraw = null;
    activeShape = null;
    drawButton.textContent = labels.drawBbox;
  };
  /** Shows the search area again: what a drawing that was cancelled had been drawn over. */
  const restoreOverlay = (): void => {
    const map = getStacMap(appRef);
    if (!map) return;
    if (searchArea) {
      showDrawGeometry(map, searchArea);
      return;
    }
    const values = bboxField.input.value.trim().split(/[ ,]+/).map(Number);
    if (
      values.length === 4 &&
      values.every(Number.isFinite) &&
      values[0] < values[2] &&
      values[1] < values[3]
    ) {
      showDrawBox(map, values as [number, number, number, number]);
    } else {
      removeDrawBox(map);
    }
  };
  /** Lets go of the search shape, so the rectangle controls are the ones that count again. */
  const dropShape = (): void => {
    areaGeneration += 1;
    searchArea = undefined;
    chosenArea = undefined;
    setDisabled(clearAreaButton, true);
  };
  drawButton.addEventListener("click", () => {
    const wasDrawing = Boolean(cancelDraw);
    // Whichever tool was drawing is finished with, so the next click on its button starts again.
    stopDrawing();
    if (wasDrawing) {
      restoreOverlay();
      return;
    }
    areaGeneration += 1;
    drawButton.textContent = labels.cancelDrawing;
    setStatus(labels.drawHint);
    cancelDraw = beginBboxDraw((bbox) => {
      cancelDraw = null;
      dropShape();
      drawButton.textContent = labels.drawBbox;
      bboxField.input.value = bbox.map((value) => value.toFixed(6)).join(", ");
      useExtent.checked = false;
      setDisabled(clearDrawButton, false);
      setStatus(labels.drawnBbox(bboxField.input.value));
    });
    if (!cancelDraw) {
      drawButton.textContent = labels.drawBbox;
      setStatus(labels.mapNotReady, true);
    }
  });
  /** Makes `area` the search shape, replacing any rectangle, and shows it on the map. */
  const setSearchArea = (area: MergedArea): void => {
    // A drawing still open would later replace this area with its own.
    stopDrawing();
    areaGeneration += 1;
    applyArea(area);
  };
  /** Turns a chosen shape into the search area: widened by the buffer when that is on. */
  function applyArea(area: MergedArea | undefined = chosenArea): void {
    if (!area) return;
    const { geometry: shape, ignored } = area;
    const geometry = bufferMeters() ? bufferGeometry(shape, bufferMeters() / 1000) : shape;
    const positions = countPositions(geometry);
    if (positions > AOI_MAX_POSITIONS) {
      setStatus(labels.areaTooLarge(positions, AOI_MAX_POSITIONS), true);
      return;
    }
    // Only an area that is accepted replaces the one in use.
    chosenArea = area;
    searchArea = geometry;
    bboxField.input.value = "";
    useExtent.checked = false;
    setDisabled(clearDrawButton, true);
    setDisabled(clearAreaButton, false);
    const map = getStacMap(appRef);
    if (map) showDrawGeometry(map, geometry);
    const note = ignored ? ` ${labels.areaIgnored(ignored)}` : "";
    const grown = geometry !== shape ? ` +${labels.bufferDistance(bufferMeters())}` : "";
    setStatus(`${labels.areaSet(`${shape.type} (${positions})${grown}`)}${note}`);
  }
  const startShape = (shape: StacDrawShape): void => {
    const sameTool = Boolean(cancelDraw) && activeShape === shape;
    stopDrawing();
    // The same button toggles off; another tool's switches to it.
    if (sameTool) {
      restoreOverlay();
      return;
    }
    areaGeneration += 1;
    activeShape = shape;
    setStatus(shape === "point" ? labels.drawPointHint : labels.drawShapeHint);
    cancelDraw = beginShapeDraw(
      shape,
      (geometry) => {
        cancelDraw = null;
        activeShape = null;
        setSearchArea({ geometry, ignored: 0 });
      },
      () => {
        cancelDraw = null;
        activeShape = null;
        // Escape ends the preview; what was there before is the search area still.
        restoreOverlay();
      },
    );
    if (!cancelDraw) {
      activeShape = null;
      setStatus(labels.mapNotReady, true);
    }
  };
  pointButton.addEventListener("click", () => startShape("point"));
  lineButton.addEventListener("click", () => startShape("line"));
  polygonButton.addEventListener("click", () => startShape("polygon"));
  selectionButton.addEventListener("click", () => {
    const area = selectedFeaturesGeometry();
    if (!area) return setStatus(labels.noSelection, true);
    setSearchArea(area);
  });
  fileButton.addEventListener("click", () => areaFile.click());
  areaFile.addEventListener("change", () => {
    const file = areaFile.files?.[0];
    // Reset so choosing the same file again still fires a change.
    areaFile.value = "";
    if (!file) return;
    const generation = ++areaGeneration;
    // A read that finishes after another area was chosen or cleared, or after the panel closed,
    // has been overtaken and is dropped rather than put back over what the user did since.
    const current = (): boolean => generation === areaGeneration && !disposed;
    geometryFromFile(file).then(
      (area) => {
        if (current()) setSearchArea(area);
      },
      (error) => {
        if (current()) {
          setStatus(error instanceof Error ? error.message : labels.areaFileFailed, true);
        }
      },
    );
  });
  clearAreaButton.addEventListener("click", () => {
    stopDrawing();
    dropShape();
    const map = getStacMap(appRef);
    if (map) removeDrawBox(map);
    setStatus(labels.areaCleared);
  });
  clearDrawButton.addEventListener("click", () => {
    bboxField.input.value = "";
    setDisabled(clearDrawButton, true);
    const map = getStacMap(appRef);
    if (map) removeDrawBox(map);
    setStatus(labels.drawnBboxCleared);
  });
  // The rectangle and the shape are two ways to say where to search, and the one touched last wins:
  // typing a bbox or turning on the map extent lets the shape go, rather than being ignored.
  const rectangleReplacesShape = (): void => {
    if (!searchArea) return;
    dropShape();
    const map = getStacMap(appRef);
    if (map) removeDrawBox(map);
    setStatus(labels.areaCleared);
  };
  bboxField.input.addEventListener("input", () => {
    if (bboxField.input.value.trim()) rectangleReplacesShape();
  });
  useExtent.addEventListener("change", () => {
    if (useExtent.checked) rectangleReplacesShape();
  });
  // Changing the sort re-orders what is on screen, in the order the server gave it when it is
  // the server's own.
  sortSelect.addEventListener("change", () => {
    pageCriteria = { ...pageCriteria, sortDirection: sortDirectionOf() };
    if (!fetchedItems.length) return;
    allItems = pageCriteria.sortDirection
      ? sortStacItems(fetchedItems, pageCriteria.sortDirection)
      : fetchedItems;
    renderItems();
    showFootprints(allItems);
    applySelection(false);
  });

  // Clicking a footprint selects the matching result card. The bbox-draw mode
  // owns the pointer while it is active, so both handlers stand down for it.
  const footprintIdAt = (event: StacPointerEvent): string | null => {
    const map = getStacMap(appRef);
    if (!map || cancelDraw) return null;
    const layers = footprintStyleLayers(map);
    if (!layers.length) return null;
    const feature = map.queryRenderedFeatures([event.point.x, event.point.y], { layers })[0];
    const id = feature?.properties?.id;
    return typeof id === "string" ? id : null;
  };
  const onMapClick = (event: StacPointerEvent): void => {
    const id = footprintIdAt(event);
    if (id) selectItem(id, true);
  };
  const onMapMove = (event: StacPointerEvent): void => {
    const map = getStacMap(appRef);
    if (!map || cancelDraw) return;
    map.getCanvas().style.cursor = footprintIdAt(event) ? "pointer" : "";
  };
  const map = getStacMap(appRef);
  map?.on("click", onMapClick);
  map?.on("mousemove", onMapMove);

  const loadIndex = browserOptions.loadIndex ?? loadStacIndex;
  const indexFromConnection = browserOptions.indexFromConnection;
  // Portolan's preset and discovery list are the same document. Reuse the initial
  // connection, retaining URL entry and a separate retry if that connection failed.
  const indexRequest =
    presetConnection && indexFromConnection
      ? presetConnection.then((opened) =>
          opened ? indexFromConnection(opened) : loadIndex(fetch, controller.signal),
        )
      : loadIndex(fetch, controller.signal);
  void indexRequest.then(
    (catalogs) => {
      index = catalogs;
      renderCatalogs();
    },
    (error) => {
      catalogSelect.innerHTML = "";
      catalogSelect.append(el("option", indexLabels.indexUnavailable));
      // A preset catalog connects in parallel with this index fetch, so a late
      // index failure must not overwrite a connection that already succeeded —
      // the catalog is usable, only the browse-by-name dropdown is not.
      if (!connection) {
        setStatus(error instanceof Error ? error.message : indexLabels.indexLoadFailed, true);
      }
    },
  );

  return () => {
    controller.abort();
    disposed = true;
    areaGeneration += 1;
    cancelDraw?.();
    searchGeneration += 1;
    // The footprints are the user's layer now, so closing the panel leaves them
    // on the map; only deactivating the plugin tears them down.
    const activeMap = getStacMap(appRef);
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

/** Drop a {@link requestStacCatalogUrl} request no activation took up. */
export function cancelStacCatalogRequest(): void {
  requestedCatalogUrl = "";
}

/**
 * Open the STAC Catalogs browser on a catalog, API, or API collection URL and connect to it.
 *
 * Takes effect on the STAC Catalogs plugin's next activation, or at once when it is already active.
 *
 * Args:
 *   url: The STAC URL to connect to.
 */
export function requestStacCatalogUrl(url: string): void {
  // Only the STAC Catalogs browser takes the request in place. A sibling's (Planet, Portolan) state
  // is left for the activation that replaces it, which reads the request.
  if (activePluginId !== STAC_PLUGIN_ID) {
    requestedCatalogUrl = url;
    return;
  }
  initialCatalogUrl = url;
  if (panelContainer) mountPanel(panelContainer);
  // Active with its panel closed: opening the panel mounts it on the requested catalog.
  else appRef?.openRightPanel?.(STAC_PLUGIN_ID);
}

/**
 * Factory creating a STAC catalog browser plugin instance with optional preset catalog URL.
 *
 * @param id - Unique plugin identifier.
 * @param name - Display name for the plugin.
 * @param presetCatalogUrl - Optional default catalog URL to connect to on load.
 * @returns A {@link GeoLibrePlugin} instance for browsing STAC catalogs.
 */
function createStacPlugin(
  id: string,
  name: string,
  presetCatalogUrl = "",
  options: CatalogBrowserOptions = {},
): GeoLibrePlugin {
  return {
    id,
    name,
    version: "0.1.0",
    // Footprints and interaction use the shared native GeoJSON APIs, which the
    // host's control map answers on ArcGIS and the Cesium globe.
    engines: ["maplibre", "mapbox", "arcgis", "cesium"],
    exclusiveGroup: "stac-catalog-browser",
    activate(app) {
      // The `?stac=` request is for the STAC Catalogs browser, never a sibling preset.
      initialCatalogUrl = (id === STAC_PLUGIN_ID && requestedCatalogUrl) || presetCatalogUrl;
      if (id === STAC_PLUGIN_ID) requestedCatalogUrl = "";
      activePluginId = id;
      browserOptions = options;
      appRef = app;
      unregisterPanel =
        app.registerRightPanel?.({
          id,
          title: () =>
            id === PLANET_OPEN_DATA_PLUGIN_ID
              ? (labels.getPlanetTitle?.() ?? labels.planetTitle)
              : id === STAC_PLUGIN_ID
                ? (labels.getTitle?.() ?? labels.title)
                : name,
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
      app.openRightPanel?.(id);
    },
    deactivate(app) {
      app.closeRightPanel?.(id);
      unregisterPanel?.();
      unregisterPanel = null;
      removeFootprints();
      const map = getStacMap(app);
      if (map) {
        removeDrawBox(map);
        removeSelectionHighlight(map);
      }
      appRef = null;
      activePluginId = null;
      initialCatalogUrl = "";
      browserOptions = {};
    },
  };
}

export const maplibreStacCatalogsPlugin = createStacPlugin(STAC_PLUGIN_ID, "STAC Catalogs");

/** STAC Catalogs browser pinned to Planet's continuously updated disaster releases. */
export const maplibrePlanetOpenDataPlugin = createStacPlugin(
  PLANET_OPEN_DATA_PLUGIN_ID,
  "Planet Open Data",
  PLANET_DISASTER_DATA_CATALOG_URL,
);

/** Browse registered Portolan catalogs or connect directly to a publisher's URL. */
export const maplibrePortolanPlugin = createStacPlugin(
  PORTOLAN_PLUGIN_ID,
  "Portolan",
  PORTOLAN_REGISTRY_URL,
  {
    loadIndex: loadPortolanIndex,
    indexFromConnection: (connection) => portolanIndexFromDocument(connection.root),
    indexLabels: (app) => ({
      indexLoading:
        app.translate?.("stacPlugin.portolanIndexLoading", "Loading Portolan Registry…") ??
        "Loading Portolan Registry…",
      indexUnavailable:
        app.translate?.(
          "stacPlugin.portolanIndexUnavailable",
          "Portolan Registry unavailable: enter a URL",
        ) ?? "Portolan Registry unavailable: enter a URL",
      indexLoadFailed:
        app.translate?.("stacPlugin.portolanIndexLoadFailed", "Could not load Portolan Registry") ??
        "Could not load Portolan Registry",
    }),
    catalogSearchLabel: (app) =>
      app.translate?.(
        "stacPlugin.portolanCatalogSearch",
        "Find a public catalog from Portolan Registry",
      ) ?? "Find a public catalog from Portolan Registry",
  },
);

export default maplibreStacCatalogsPlugin;
