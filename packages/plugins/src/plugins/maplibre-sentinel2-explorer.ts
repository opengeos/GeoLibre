import { useAppStore } from "@geolibre/core";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import type { GeoJSONSource, Map as MapLibreMap, MapLayerMouseEvent } from "maplibre-gl";
import { createPluginTranslator } from "../plugin-i18n";
import type { GeoLibreAppAPI, GeoLibreCogLayerOptions, GeoLibrePlugin } from "../types";
import {
  MGRS_TILE_RE,
  S2_BANDS,
  S2_COLLECTIONS,
  S2_DEFAULT_COLLECTION,
  S2_EXPLORER_URL,
  S2_MASK_BANDS,
  S2_METRICS,
  S2_RAMP,
  S2_SOURCE_COOP_URL,
  S2_SOURCE_URL,
  type S2CollectionId,
  type S2GridProperties,
  type S2Metric,
  type S2Scene,
  type S2SceneSort,
  type S2TileStats,
  aggregateMonths,
  bandRescale,
  filterScenes,
  loadMgrsGrid,
  loadMonthSlice,
  monthsIn,
  sceneDirectory,
  searchTileScenes,
  tilePasses,
} from "./sentinel2-explorer-data";
import { getStyleMap } from "./style-map";

export const SENTINEL2_EXPLORER_PLUGIN_ID = "geolibre-sentinel2-explorer";
const PANEL_ID = SENTINEL2_EXPLORER_PLUGIN_ID;

// The MGRS choropleth, the hovered/selected tile outline, and the hovered
// scene footprint are plugin-private overlays, not Layers-panel entries: they
// are the explorer's picking surface and vanish when the plugin deactivates.
// The scenes a user adds are ordinary COG layers in the store.
const GRID_SOURCE_ID = "geolibre-s2x-grid";
const GRID_FILL_LAYER_ID = "geolibre-s2x-grid-fill";
const GRID_LINE_LAYER_ID = "geolibre-s2x-grid-line";
const TILE_LINE_LAYER_ID = "geolibre-s2x-tile-line";
const FOOTPRINT_SOURCE_ID = "geolibre-s2x-footprint";
const FOOTPRINT_LINE_LAYER_ID = "geolibre-s2x-footprint-line";
const INTERNAL_METADATA = { "geolibre:internal": true } as const;
const HIGHLIGHT_COLOR = "#f5a623";
const DIMMED_COLOR = "#9aa0a6";
const ATTRIBUTION =
  "Sentinel-2 L2A: Copernicus / ESA, Earth Search by Element 84; s2-stac-geoparquet by Taylor Geospatial";

/** `v` on a grid feature with no scenes in the window. */
const V_UNPAINTED = -1;
/** `v` on a grid feature that fails a map filter. */
const V_DIMMED = -2;
/** Result cards rendered per "Show more" step. */
const PAGE_SIZE = 30;
/** Delay before a slider drag repaints the map. */
const REPAINT_DEBOUNCE_MS = 150;

const CSS = {
  panel:
    "display:flex;flex-direction:column;gap:10px;padding:10px;height:100%;" +
    "box-sizing:border-box;overflow-y:auto;color:hsl(var(--foreground));font-size:12px;",
  hint: "margin:0;color:hsl(var(--muted-foreground));line-height:1.45;",
  label: "display:flex;flex-direction:column;gap:4px;font-size:11px;font-weight:600;",
  input:
    "width:100%;box-sizing:border-box;padding:5px 8px;border:1px solid hsl(var(--border));" +
    "border-radius:6px;background:hsl(var(--background));color:hsl(var(--foreground));" +
    "font-size:12px;",
  links: "display:flex;gap:12px;flex-wrap:wrap;font-size:11px;",
  link: "color:hsl(var(--primary));text-decoration:underline;",
  attribution: "margin:0;font-size:10px;color:hsl(var(--muted-foreground));line-height:1.4;",
  grid2: "display:grid;grid-template-columns:1fr 1fr;gap:6px;",
  sliderLabel: "display:flex;justify-content:space-between;font-size:11px;font-weight:600;",
  slider: "width:100%;accent-color:hsl(var(--primary));",
  legendRamp: "height:8px;border-radius:4px;border:1px solid hsl(var(--border));",
  legendLabels:
    "display:flex;justify-content:space-between;font-size:10px;color:hsl(var(--muted-foreground));",
  status:
    "box-sizing:border-box;width:100%;padding:8px;border-radius:6px;background:hsl(var(--muted));" +
    "color:hsl(var(--muted-foreground));line-height:1.45;",
  statusError:
    "box-sizing:border-box;width:100%;padding:8px;border-radius:6px;" +
    "background:hsl(var(--destructive) / 0.12);color:hsl(var(--destructive));line-height:1.45;",
  section: "display:flex;flex-direction:column;gap:6px;",
  sectionTitle:
    "font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;" +
    "color:hsl(var(--muted-foreground));",
  resultHeader: "display:flex;align-items:center;justify-content:space-between;gap:8px;",
  list: "display:flex;flex-direction:column;gap:6px;",
  card:
    "box-sizing:border-box;display:flex;gap:8px;padding:6px;border:1px solid hsl(var(--border));" +
    "border-radius:6px;",
  thumb:
    "flex:0 0 64px;width:64px;height:64px;object-fit:cover;border-radius:4px;" +
    "background:hsl(var(--muted));",
  cardBody: "display:flex;flex-direction:column;gap:3px;min-width:0;flex:1 1 auto;",
  cardTitle: "font-weight:600;font-variant-numeric:tabular-nums;",
  cardMeta: "color:hsl(var(--muted-foreground));font-size:11px;font-variant-numeric:tabular-nums;",
  cardId:
    "color:hsl(var(--muted-foreground));font-size:10px;overflow:hidden;text-overflow:ellipsis;" +
    "white-space:nowrap;font-family:ui-monospace,monospace;",
  actions: "display:flex;gap:4px;flex-wrap:wrap;",
  action:
    "padding:2px 8px;font-size:11px;border-radius:4px;cursor:pointer;" +
    "border:1px solid hsl(var(--border));background:hsl(var(--background));" +
    "color:hsl(var(--foreground));",
  primaryAction:
    "padding:2px 8px;font-size:11px;border-radius:4px;cursor:pointer;" +
    "border:1px solid hsl(var(--primary));background:hsl(var(--primary));" +
    "color:hsl(var(--primary-foreground));",
  checkbox: "display:flex;align-items:center;gap:6px;font-size:11px;",
} as const;

/** What a scene is drawn as when added to the map. */
type DisplayKey = "TCI" | string;

/**
 * Panel state. Module scope so a rebuild (a language change) keeps the
 * search; reset when the plugin deactivates.
 */
interface PanelState {
  collection: S2CollectionId;
  from: string;
  to: string;
  metric: S2Metric;
  maxCloud: number;
  minCoverage: number;
  minScenes: number;
  showGrid: boolean;
  tile: string | null;
  /** All scenes of the tile in the searched window, unfiltered. */
  scenes: S2Scene[];
  /** The window the scenes were read for. */
  searched: {
    collection: S2CollectionId;
    tile: string;
    from: string;
    to: string;
  } | null;
  sort: S2SceneSort;
  display: DisplayKey;
  shown: number;
  status: { text: string; error: boolean } | null;
  busy: boolean;
}

const todayIso = () => new Date().toISOString().slice(0, 10);

function defaultWindow(): { from: string; to: string } {
  const to = todayIso();
  const start = new Date(`${to}T00:00:00Z`);
  start.setUTCMonth(start.getUTCMonth() - 3);
  return { from: start.toISOString().slice(0, 10), to };
}

function initialState(): PanelState {
  return {
    collection: S2_DEFAULT_COLLECTION,
    ...defaultWindow(),
    metric: "min_cloud_cover",
    maxCloud: 100,
    minCoverage: 10,
    minScenes: 0,
    showGrid: true,
    tile: null,
    scenes: [],
    searched: null,
    sort: "cloud",
    display: "TCI",
    shown: PAGE_SIZE,
    status: null,
    busy: false,
  };
}

let state: PanelState = initialState();
let appRef: GeoLibreAppAPI | null = null;
let panelContainer: HTMLElement | null = null;
let disposePanel: (() => void) | null = null;
let unregisterPanel: (() => void) | null = null;
let unsubscribeLocale: (() => void) | null = null;
/** Re-renders the panel's dynamic parts; set while a panel is mounted. */
let refreshPanel: (() => void) | null = null;
/** Per-tile aggregates of the painted window. */
let tileStats = new Map<string, S2TileStats>();
/** The decoded grid of the painted collection. */
let grid: FeatureCollection<Geometry, S2GridProperties> | null = null;
let gridCollection: S2CollectionId | null = null;
let paintSeq = 0;
let searchController: AbortController | null = null;
let detachMap: (() => void) | null = null;
let repaintTimer: ReturnType<typeof setTimeout> | null = null;

const tr = createPluginTranslator(() => appRef, SENTINEL2_EXPLORER_PLUGIN_ID);

function setStatus(text: string | null, error = false): void {
  state.status = text ? { text, error } : null;
  refreshPanel?.();
}

// ---------------------------------------------------------------------------
// Map overlays
// ---------------------------------------------------------------------------

function mapOf(): MapLibreMap | null {
  return getStyleMap(appRef);
}

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

/** The fill color of a grid cell from its baked `v` (see paintGrid). */
function fillColorExpression(): unknown {
  const ramp: unknown[] = ["interpolate", ["linear"], ["get", "v"]];
  for (const [stop, color] of S2_RAMP) ramp.push(stop, color);
  return [
    "case",
    ["==", ["get", "v"], V_DIMMED],
    DIMMED_COLOR,
    ["<", ["get", "v"], 0],
    "rgba(0,0,0,0)",
    ramp,
  ];
}

/** Adds the plugin's sources and layers when the style lacks them. */
function ensureOverlays(map: MapLibreMap): void {
  if (!styleReady(map)) return;
  if (!map.getSource(GRID_SOURCE_ID)) {
    map.addSource(GRID_SOURCE_ID, {
      type: "geojson",
      data: (grid ?? emptyCollection()) as FeatureCollection,
      // Polygons are coarse already (z0 of the archive); skip re-simplifying.
      tolerance: 0,
    });
  }
  const visibility = state.showGrid ? "visible" : "none";
  if (!map.getLayer(GRID_FILL_LAYER_ID)) {
    map.addLayer({
      id: GRID_FILL_LAYER_ID,
      type: "fill",
      source: GRID_SOURCE_ID,
      metadata: INTERNAL_METADATA,
      layout: { visibility },
      // The selected tile stays unfilled so an added scene shows through.
      paint: {
        "fill-color": fillColorExpression() as never,
        "fill-opacity": ["case", ["==", ["get", "mgrs_tile"], state.tile ?? ""], 0, 0.55] as never,
      },
    });
  }
  if (!map.getLayer(GRID_LINE_LAYER_ID)) {
    map.addLayer({
      id: GRID_LINE_LAYER_ID,
      type: "line",
      source: GRID_SOURCE_ID,
      metadata: INTERNAL_METADATA,
      layout: { visibility },
      paint: {
        "line-color": "#8899bb",
        "line-width": 0.4,
        "line-opacity": 0.4,
      },
    });
  }
  if (!map.getLayer(TILE_LINE_LAYER_ID)) {
    map.addLayer({
      id: TILE_LINE_LAYER_ID,
      type: "line",
      source: GRID_SOURCE_ID,
      metadata: INTERNAL_METADATA,
      filter: ["==", ["get", "mgrs_tile"], state.tile ?? ""],
      paint: { "line-color": HIGHLIGHT_COLOR, "line-width": 2.5 },
    });
  }
  if (!map.getSource(FOOTPRINT_SOURCE_ID)) {
    map.addSource(FOOTPRINT_SOURCE_ID, {
      type: "geojson",
      data: emptyCollection(),
    });
  }
  if (!map.getLayer(FOOTPRINT_LINE_LAYER_ID)) {
    map.addLayer({
      id: FOOTPRINT_LINE_LAYER_ID,
      type: "line",
      source: FOOTPRINT_SOURCE_ID,
      metadata: INTERNAL_METADATA,
      paint: {
        "line-color": "#00b3ff",
        "line-width": 2,
        "line-dasharray": [2, 1],
      },
    });
  }
}

function removeOverlays(map: MapLibreMap | null): void {
  if (!map || !styleReady(map)) return;
  for (const id of [
    FOOTPRINT_LINE_LAYER_ID,
    TILE_LINE_LAYER_ID,
    GRID_LINE_LAYER_ID,
    GRID_FILL_LAYER_ID,
  ]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  for (const id of [FOOTPRINT_SOURCE_ID, GRID_SOURCE_ID]) {
    if (map.getSource(id)) map.removeSource(id);
  }
}

/** Points the selected-tile outline and the fill hole at `state.tile`. */
function syncSelectedTile(map: MapLibreMap | null): void {
  if (!map || !map.getLayer(TILE_LINE_LAYER_ID)) return;
  const tile = state.tile ?? "";
  map.setFilter(TILE_LINE_LAYER_ID, ["==", ["get", "mgrs_tile"], tile]);
  map.setPaintProperty(GRID_FILL_LAYER_ID, "fill-opacity", [
    "case",
    ["==", ["get", "mgrs_tile"], tile],
    0,
    0.55,
  ] as never);
}

function syncGridVisibility(map: MapLibreMap | null): void {
  if (!map) return;
  for (const id of [GRID_FILL_LAYER_ID, GRID_LINE_LAYER_ID]) {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, "visibility", state.showGrid ? "visible" : "none");
    }
  }
}

function showFootprint(scene: S2Scene | null): void {
  const map = mapOf();
  const source = map?.getSource(FOOTPRINT_SOURCE_ID) as GeoJSONSource | undefined;
  if (!source) return;
  if (!scene || scene.bbox.length !== 4) {
    void source.setData(emptyCollection());
    return;
  }
  const [w, s, e, n] = scene.bbox;
  void source.setData({
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
  });
}

/**
 * Bakes each cell's value for the current window, metric and filters into
 * its `v` property and pushes the grid to the map. Reads only the month
 * slices of the window (cached), never the item parts.
 */
async function paintGrid(): Promise<void> {
  const seq = ++paintSeq;
  const collection = S2_COLLECTIONS[state.collection];
  try {
    if (!grid || gridCollection !== state.collection) {
      setStatus(tr("loadingGrid", "Loading the MGRS tile grid…"));
      grid = await loadMgrsGrid(collection);
      gridCollection = state.collection;
    }
    const months = monthsIn(state.from, state.to);
    const slices = await Promise.all(months.map((ym) => loadMonthSlice(collection, ym)));
    if (seq !== paintSeq) return;
    tileStats = aggregateMonths(
      slices.filter((rows): rows is NonNullable<typeof rows> => rows !== null),
      state.metric,
    );
    const filters = {
      maxCloud: state.maxCloud,
      minCoverage: state.minCoverage,
      minScenes: state.minScenes,
    };
    let passing = 0;
    const features: Feature<Geometry, S2GridProperties>[] = grid.features.map((f) => {
      const stats = tileStats.get(f.properties.mgrs_tile);
      let v = V_UNPAINTED;
      if (stats) {
        if (tilePasses(stats, filters)) {
          v = stats.v;
          passing += 1;
        } else {
          v = V_DIMMED;
        }
      }
      return { ...f, properties: { mgrs_tile: f.properties.mgrs_tile, v } };
    });
    const map = mapOf();
    if (map) {
      ensureOverlays(map);
      // The map may not have existed when the plugin activated.
      if (!detachMap) detachMap = attachMap(map);
      const painted = {
        type: "FeatureCollection",
        features,
      } as FeatureCollection;
      void (map.getSource(GRID_SOURCE_ID) as GeoJSONSource | undefined)?.setData(painted);
      grid = painted as FeatureCollection<Geometry, S2GridProperties>;
    }
    setStatus(
      state.tile
        ? null
        : tr(
            "gridPainted",
            "{{passing}} of {{total}} tiles pass the filters. Click a tile to find its scenes.",
            {
              passing: passing.toLocaleString(),
              total: tileStats.size.toLocaleString(),
            },
          ),
    );
  } catch (error) {
    if (seq !== paintSeq) return;
    setStatus(
      tr("gridFailed", "Could not load the tile statistics: {{error}}", {
        error: error instanceof Error ? error.message : String(error),
      }),
      true,
    );
  }
}

function scheduleRepaint(): void {
  if (repaintTimer) clearTimeout(repaintTimer);
  repaintTimer = setTimeout(() => {
    repaintTimer = null;
    void paintGrid();
  }, REPAINT_DEBOUNCE_MS);
}

/** Wires hover, click and style-reload handling on the map. */
function attachMap(map: MapLibreMap): () => void {
  const onClick = (event: MapLayerMouseEvent) => {
    const tile = event.features?.[0]?.properties?.mgrs_tile;
    if (typeof tile === "string" && MGRS_TILE_RE.test(tile)) void selectTile(tile);
  };
  const onEnter = () => {
    map.getCanvas().style.cursor = "pointer";
  };
  const onLeave = () => {
    map.getCanvas().style.cursor = "";
  };
  // A basemap switch replaces the style and drops the overlays; put them back.
  const onStyle = () => {
    if (!map.getSource(GRID_SOURCE_ID)) {
      ensureOverlays(map);
      syncSelectedTile(map);
    }
  };
  map.on("click", GRID_FILL_LAYER_ID, onClick);
  map.on("mouseenter", GRID_FILL_LAYER_ID, onEnter);
  map.on("mouseleave", GRID_FILL_LAYER_ID, onLeave);
  map.on("styledata", onStyle);
  return () => {
    map.off("click", GRID_FILL_LAYER_ID, onClick);
    map.off("mouseenter", GRID_FILL_LAYER_ID, onEnter);
    map.off("mouseleave", GRID_FILL_LAYER_ID, onLeave);
    map.off("styledata", onStyle);
    map.getCanvas().style.cursor = "";
  };
}

// ---------------------------------------------------------------------------
// Search and imagery
// ---------------------------------------------------------------------------

/**
 * Selects a tile and reads its scenes for the window, unless the same tile
 * and window are already loaded.
 */
async function selectTile(tile: string): Promise<void> {
  state.tile = tile;
  state.shown = PAGE_SIZE;
  syncSelectedTile(mapOf());
  const searched = state.searched;
  if (
    searched &&
    searched.tile === tile &&
    searched.collection === state.collection &&
    searched.from === state.from &&
    searched.to === state.to
  ) {
    refreshPanel?.();
    return;
  }
  searchController?.abort();
  const controller = new AbortController();
  searchController = controller;
  state.busy = true;
  state.scenes = [];
  state.searched = null;
  setStatus(tr("searching", "Reading the scenes of tile {{tile}}…", { tile }));
  try {
    const result = await searchTileScenes(
      S2_COLLECTIONS[state.collection],
      tile,
      state.from,
      state.to,
      controller.signal,
    );
    if (searchController !== controller) return;
    state.scenes = result.scenes;
    state.searched = {
      collection: state.collection,
      tile,
      from: state.from,
      to: state.to,
    };
    setStatus(
      tr(
        "searchDone",
        "{{count}} scenes of {{tile}} read in {{seconds}} s ({{gets}} range reads, {{kib}} KiB). No API, just static GeoParquet.",
        {
          count: result.scenes.length,
          tile,
          seconds: (result.ms / 1000).toFixed(1),
          gets: result.gets,
          kib: Math.round(result.bytes / 1024),
        },
      ),
    );
  } catch (error) {
    if (controller.signal.aborted || searchController !== controller) return;
    setStatus(
      tr("searchFailed", "Search failed: {{error}}", {
        error: error instanceof Error ? error.message : String(error),
      }),
      true,
    );
  } finally {
    if (searchController === controller) {
      searchController = null;
      state.busy = false;
      refreshPanel?.();
    }
  }
}

/** The option list of the Display select, collection aware. */
function displayOptions(): Array<{ value: DisplayKey; label: string }> {
  const collection = S2_COLLECTIONS[state.collection];
  const bands = [
    ...S2_BANDS,
    ...S2_MASK_BANDS.filter((band) => collection.masks.includes(band.key)),
  ];
  return [
    { value: "TCI", label: tr("displayTci", "True color (TCI)") },
    ...bands.map((band) => ({
      value: band.key,
      label: `${band.key} · ${band.label} · ${band.res} m`,
    })),
  ];
}

/** Adds one scene to the map as a COG layer in the chosen display. */
async function addSceneToMap(scene: S2Scene, display: DisplayKey): Promise<void> {
  const app = appRef;
  if (!app?.addCogLayer) {
    setStatus(tr("noCog", "This GeoLibre build cannot add COG layers."), true);
    return;
  }
  let dir: string;
  try {
    dir = sceneDirectory(scene.thumbnailUrl);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
    return;
  }
  const url = `${dir}/${display}.tif`;
  const name = `${scene.id} (${display})`;
  let options: GeoLibreCogLayerOptions;
  if (display === "TCI") {
    // The visual COG is already stretched by ESA; 0 is the swath-edge nodata.
    options = { bands: "1,2,3", nodata: 0, zoomTo: true };
  } else if (display === "SCL") {
    options = {
      bands: "1",
      colormap: "tab20",
      rescaleMin: 0,
      rescaleMax: 19,
      nodata: 0,
      zoomTo: true,
    };
  } else {
    const [min, max] = bandRescale(display, scene.baseline);
    options = {
      bands: "1",
      colormap: "gray",
      rescaleMin: min,
      rescaleMax: max,
      nodata: 0,
      zoomTo: true,
    };
  }
  setStatus(tr("adding", "Adding {{name}}…", { name }));
  try {
    const id = await app.addCogLayer(name, url, options);
    const store = useAppStore.getState();
    const layer = store.layers.find((candidate) => candidate.id === id);
    if (layer) {
      store.updateLayer(id, {
        metadata: {
          ...layer.metadata,
          attribution: ATTRIBUTION,
          sentinel2Scene: scene.id,
        },
      });
    }
    setStatus(tr("added", "Added {{name}}.", { name }));
  } catch (error) {
    setStatus(
      tr("addFailed", "Could not add {{name}}: {{error}}", {
        name,
        error: error instanceof Error ? error.message : String(error),
      }),
      true,
    );
  }
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style = "",
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (style) node.style.cssText = style;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, style: string, onClick: () => void, title?: string) {
  const node = element("button", style, label);
  node.type = "button";
  if (title) node.title = title;
  node.addEventListener("click", onClick);
  return node;
}

function link(label: string, href: string): HTMLAnchorElement {
  const node = element("a", CSS.link, label);
  node.href = href;
  node.target = "_blank";
  node.rel = "noopener noreferrer";
  return node;
}

function select<T extends string>(
  options: Array<{ value: T; label: string }>,
  value: T,
  onChange: (value: T) => void,
  ariaLabel: string,
): HTMLSelectElement {
  const node = element("select", CSS.input);
  node.setAttribute("aria-label", ariaLabel);
  for (const option of options) node.append(new Option(option.label, option.value));
  node.value = value;
  node.addEventListener("change", () => onChange(node.value as T));
  return node;
}

function slider(
  label: string,
  value: number,
  max: number,
  onInput: (value: number) => void,
): HTMLElement {
  const wrap = element("label", CSS.section);
  const head = element("span", CSS.sliderLabel);
  const name = element("span", "", label);
  const output = element("span", "font-variant-numeric:tabular-nums;", String(value));
  head.append(name, output);
  const input = element("input", CSS.slider);
  input.type = "range";
  input.min = "0";
  input.max = String(max);
  input.step = "1";
  input.value = String(value);
  input.setAttribute("aria-label", label);
  input.addEventListener("input", () => {
    output.textContent = input.value;
    onInput(Number(input.value));
  });
  wrap.append(head, input);
  return wrap;
}

function metricLabels(): Record<S2Metric, { label: string; lo: string; hi: string }> {
  return {
    min_cloud_cover: {
      label: tr("metricClearest", "Clearest scene"),
      lo: tr("legendClear", "clear"),
      hi: tr("legendCloudy", "cloudy"),
    },
    scene_count: {
      label: tr("metricSceneCount", "Scene count"),
      lo: tr("legendMany", "12+ scenes"),
      hi: tr("legendFew", "few"),
    },
    median_cloud_cover: {
      label: tr("metricMedianCloud", "Median cloud"),
      lo: tr("legendClear", "clear"),
      hi: tr("legendCloudy", "cloudy"),
    },
    max_cover: {
      label: tr("metricCoverage", "Coverage"),
      lo: tr("legendFull", "full tile"),
      hi: tr("legendPartial", "partial"),
    },
  };
}

function rampCss(): string {
  return `linear-gradient(to right, ${S2_RAMP.map(([stop, color]) => `${color} ${stop}%`).join(
    ", ",
  )})`;
}

/** Clamps the window into the collection's span and orders it. */
function normalizeWindow(): void {
  const first = S2_COLLECTIONS[state.collection].firstDate;
  const today = todayIso();
  const clamp = (day: string) => (day < first ? first : day > today ? today : day);
  state.from = clamp(state.from);
  state.to = clamp(state.to);
  if (state.from > state.to) [state.from, state.to] = [state.to, state.from];
}

function onWindowChange(): void {
  normalizeWindow();
  scheduleRepaint();
  // A new window needs a new read of the selected tile.
  if (state.tile) void selectTile(state.tile);
  else refreshPanel?.();
}

function buildPanel(container: HTMLElement): () => void {
  const root = element("div", CSS.panel);
  container.replaceChildren(root);

  const intro = element(
    "p",
    CSS.hint,
    tr(
      "intro",
      "Find and view Sentinel-2 L2A imagery anywhere on Earth. The map colors every MGRS tile by its statistics over the date window; click a tile to search its scenes. Every query is an HTTP range read of static GeoParquet on Source Cooperative, with no API or server.",
    ),
  );
  const links = element("div", CSS.links);
  links.append(
    link(tr("linkExplorer", "Reference explorer"), S2_EXPLORER_URL),
    link(tr("linkSource", "Source code"), S2_SOURCE_URL),
    link(tr("linkData", "Data on Source Cooperative"), S2_SOURCE_COOP_URL),
  );

  // Collection and window.
  const collectionSelect = select<S2CollectionId>(
    [
      {
        value: "sentinel-2-c1-l2a",
        label: tr("collectionC1", "Sentinel-2 Collection 1 L2A (since 2015)"),
      },
      {
        value: "sentinel-2-l2a",
        label: tr("collectionL2a", "Sentinel-2 L2A (since 2016)"),
      },
    ],
    state.collection,
    (value) => {
      state.collection = value;
      state.scenes = [];
      state.searched = null;
      if (!S2_COLLECTIONS[value].masks.includes(state.display) && !isBaseDisplay(state.display)) {
        state.display = "TCI";
      }
      onWindowChange();
      renderDisplaySelect();
    },
    tr("collection", "Collection"),
  );
  const collectionLabel = element("label", CSS.label, tr("collection", "Collection"));
  collectionLabel.append(collectionSelect);

  const dateInput = (value: string, onChange: (value: string) => void, aria: string) => {
    const input = element("input", CSS.input);
    input.type = "date";
    input.value = value;
    input.min = S2_COLLECTIONS[state.collection].firstDate;
    input.max = todayIso();
    input.setAttribute("aria-label", aria);
    input.addEventListener("change", () => {
      if (input.value) onChange(input.value);
    });
    return input;
  };
  const fromInput = dateInput(
    state.from,
    (value) => {
      state.from = value;
      onWindowChange();
      fromInput.value = state.from;
      toInput.value = state.to;
    },
    tr("from", "From"),
  );
  const toInput = dateInput(
    state.to,
    (value) => {
      state.to = value;
      onWindowChange();
      fromInput.value = state.from;
      toInput.value = state.to;
    },
    tr("to", "To"),
  );
  const fromLabel = element("label", CSS.label, tr("from", "From"));
  fromLabel.append(fromInput);
  const toLabel = element("label", CSS.label, tr("to", "To"));
  toLabel.append(toInput);
  const dates = element("div", CSS.grid2);
  dates.append(fromLabel, toLabel);

  // Map coloring and filters.
  const labels = metricLabels();
  const legendLo = element("span", "", labels[state.metric].lo);
  const legendHi = element("span", "", labels[state.metric].hi);
  const metricSelect = select<S2Metric>(
    S2_METRICS.map((metric) => ({
      value: metric,
      label: labels[metric].label,
    })),
    state.metric,
    (value) => {
      state.metric = value;
      legendLo.textContent = labels[value].lo;
      legendHi.textContent = labels[value].hi;
      scheduleRepaint();
    },
    tr("colorBy", "Color tiles by"),
  );
  const metricLabel = element("label", CSS.label, tr("colorBy", "Color tiles by"));
  metricLabel.append(metricSelect);
  const legend = element("div", CSS.section);
  const ramp = element("div", CSS.legendRamp);
  ramp.style.background = rampCss();
  const legendLabels = element("div", CSS.legendLabels);
  legendLabels.append(legendLo, legendHi);
  legend.append(ramp, legendLabels);

  const gridToggle = element("label", CSS.checkbox);
  const gridCheckbox = element("input");
  gridCheckbox.type = "checkbox";
  gridCheckbox.checked = state.showGrid;
  gridCheckbox.addEventListener("change", () => {
    state.showGrid = gridCheckbox.checked;
    syncGridVisibility(mapOf());
  });
  gridToggle.append(gridCheckbox, tr("showGrid", "Show the tile grid"));

  const filters = element("div", CSS.section);
  filters.append(
    element("div", CSS.sectionTitle, tr("filters", "Filters")),
    slider(tr("maxCloud", "Max cloud %"), state.maxCloud, 100, (value) => {
      state.maxCloud = value;
      scheduleRepaint();
      renderResults();
    }),
    slider(tr("minCoverage", "Min coverage %"), state.minCoverage, 100, (value) => {
      state.minCoverage = value;
      scheduleRepaint();
      renderResults();
    }),
    slider(tr("minScenes", "Min scenes per tile"), state.minScenes, 60, (value) => {
      state.minScenes = value;
      scheduleRepaint();
    }),
  );

  const status = element("div");

  // Results.
  const resultsSection = element("div", CSS.section);
  const displayHolder = element("label", CSS.label, tr("display", "Add scenes as"));
  let displaySelect: HTMLSelectElement | null = null;
  function renderDisplaySelect(): void {
    const next = select<DisplayKey>(
      displayOptions(),
      state.display,
      (value) => {
        state.display = value;
      },
      tr("display", "Add scenes as"),
    );
    if (displaySelect) displaySelect.replaceWith(next);
    else displayHolder.append(next);
    displaySelect = next;
  }
  renderDisplaySelect();

  function renderStatus(): void {
    status.replaceChildren();
    if (!state.status) return;
    status.append(
      element("div", state.status.error ? CSS.statusError : CSS.status, state.status.text),
    );
  }

  function sceneCard(scene: S2Scene): HTMLElement {
    const card = element("div", CSS.card);
    const thumb = element("img", CSS.thumb);
    thumb.loading = "lazy";
    thumb.alt = "";
    thumb.referrerPolicy = "no-referrer";
    if (scene.thumbnailUrl) thumb.src = scene.thumbnailUrl;
    const body = element("div", CSS.cardBody);
    body.append(
      element("div", CSS.cardTitle, scene.day),
      element(
        "div",
        CSS.cardMeta,
        tr("sceneMeta", "{{cloud}}% cloud · {{cover}} coverage", {
          cloud: scene.cloud.toFixed(1),
          cover: scene.cover === null ? "?" : `${scene.cover.toFixed(0)}%`,
        }),
      ),
    );
    const id = element("div", CSS.cardId, scene.id);
    id.title = scene.id;
    const actions = element("div", CSS.actions);
    actions.append(
      button(
        tr("addToMap", "Add to map"),
        CSS.primaryAction,
        () => void addSceneToMap(scene, state.display),
        tr("addToMapTitle", "Stream this scene's Cloud-Optimized GeoTIFF onto the map"),
      ),
      button(tr("zoom", "Zoom"), CSS.action, () => {
        if (scene.bbox.length === 4) {
          appRef?.fitBounds?.(scene.bbox as [number, number, number, number]);
        }
      }),
    );
    body.append(id, actions);
    card.append(thumb, body);
    card.addEventListener("mouseenter", () => showFootprint(scene));
    card.addEventListener("mouseleave", () => showFootprint(null));
    return card;
  }

  function renderResults(): void {
    resultsSection.replaceChildren();
    if (!state.tile) return;
    const header = element("div", CSS.resultHeader);
    header.append(
      element("div", CSS.sectionTitle, tr("tileScenes", "Tile {{tile}}", { tile: state.tile })),
    );
    resultsSection.append(header);
    if (state.busy) {
      resultsSection.append(element("p", CSS.hint, tr("loadingScenes", "Loading scenes…")));
      return;
    }
    if (!state.searched) return;
    const view = filterScenes(
      state.scenes,
      {
        from: state.from,
        to: state.to,
        maxCloud: state.maxCloud,
        minCoverage: state.minCoverage,
      },
      state.sort,
    );
    const sortSelect = select<S2SceneSort>(
      [
        { value: "cloud", label: tr("sortCloud", "Least cloud") },
        { value: "coverage", label: tr("sortCoverage", "Most coverage") },
        { value: "date", label: tr("sortDate", "Newest") },
      ],
      state.sort,
      (value) => {
        state.sort = value;
        state.shown = PAGE_SIZE;
        renderResults();
      },
      tr("sort", "Sort"),
    );
    sortSelect.style.width = "auto";
    header.append(sortSelect);
    resultsSection.append(
      element(
        "p",
        CSS.hint,
        tr("matchCount", "{{count}} of {{total}} scenes match the filters.", {
          count: view.length,
          total: state.scenes.length,
        }),
      ),
      displayHolder,
    );
    const list = element("div", CSS.list);
    for (const scene of view.slice(0, state.shown)) list.append(sceneCard(scene));
    resultsSection.append(list);
    if (view.length > state.shown) {
      resultsSection.append(
        button(
          tr("showMore", "Show more ({{count}} left)", {
            count: view.length - state.shown,
          }),
          CSS.action,
          () => {
            state.shown += PAGE_SIZE;
            renderResults();
          },
        ),
      );
    }
  }

  const attribution = element(
    "p",
    CSS.attribution,
    tr(
      "attribution",
      "Imagery: Copernicus Sentinel-2, processed by ESA, indexed by Element 84 Earth Search. Catalog: s2-stac-geoparquet by Taylor Geospatial (CC-BY-4.0).",
    ),
  );

  root.append(
    intro,
    links,
    collectionLabel,
    dates,
    metricLabel,
    legend,
    gridToggle,
    filters,
    status,
    resultsSection,
    attribution,
  );

  refreshPanel = () => {
    renderStatus();
    renderResults();
  };
  refreshPanel();

  return () => {
    refreshPanel = null;
    showFootprint(null);
    container.replaceChildren();
  };
}

function isBaseDisplay(display: DisplayKey): boolean {
  return display === "TCI" || S2_BANDS.some((band) => band.key === display);
}

function mountPanel(container: HTMLElement): void {
  disposePanel?.();
  panelContainer = container;
  disposePanel = buildPanel(container);
}

/**
 * Sentinel-2 Explorer: a GeoLibre port of Taylor Geospatial's
 * s2-stac-geoparquet explorer. The MGRS grid is colored by monthly tile
 * statistics over a date window; a tile click range-reads its scenes from
 * static STAC-GeoParquet, and a scene's true color or any band streams onto
 * the map from its Cloud-Optimized GeoTIFF.
 */
export const maplibreSentinel2ExplorerPlugin: GeoLibrePlugin = {
  id: SENTINEL2_EXPLORER_PLUGIN_ID,
  name: "Sentinel-2 Explorer",
  version: "0.1.0",
  // The grid and outlines are Style Spec sources and layers, so both 2D
  // engines host them; scenes are COG store layers.
  engines: ["maplibre", "mapbox"],
  activate: (app) => {
    appRef = app;
    const map = mapOf();
    if (map) {
      ensureOverlays(map);
      detachMap = attachMap(map);
    }
    void paintGrid();
    unregisterPanel =
      app.registerRightPanel?.({
        id: PANEL_ID,
        title: () => tr("title", "Sentinel-2 Explorer"),
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
    searchController?.abort();
    searchController = null;
    if (repaintTimer) clearTimeout(repaintTimer);
    repaintTimer = null;
    paintSeq++;
    detachMap?.();
    detachMap = null;
    removeOverlays(mapOf());
    state = initialState();
    tileStats = new Map();
    appRef = null;
  },
};

export default maplibreSentinel2ExplorerPlugin;
