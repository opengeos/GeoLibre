import { useAppStore } from "@geolibre/core";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import type { GeoJSONSource, Map as MapLibreMap, MapLayerMouseEvent } from "maplibre-gl";
import { createPluginTranslator } from "../plugin-i18n";
import type { GeoLibreAppAPI, GeoLibreCogLayerOptions, GeoLibrePlugin } from "../types";
import {
  S2_COMPOSITES,
  compositeTileUrl,
  registerSentinel2CompositeProtocol,
  isComposite,
  type S2CompositeKey,
} from "./sentinel2-composite";
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
  baselineOffset,
  filterScenes,
  loadMgrsGrid,
  loadMonthSlices,
  monthsIn,
  sceneDirectory,
  searchTileScenes,
  tilePasses,
  timeSeriesIndex,
  timeSeriesScenes,
} from "./sentinel2-explorer-data";
import { getRasterLoadState } from "./maplibre-raster";
import { getSharedDeckLoadState } from "./shared-deck-overlay";
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

/** Layer metadata naming the scene a layer shows, and how it is drawn. */
const SCENE_METADATA_KEY = "sentinel2Scene";
const DISPLAY_METADATA_KEY = "sentinel2Display";

/** Scene/display pairs whose COG is still loading, keyed by `sceneLayerKey`. */
const pendingAdds = new Set<string>();

const sceneLayerKey = (sceneId: string, display: string) => `${sceneId}|${display}`;

/**
 * The store layer showing a scene in a display, if one is on the map.
 *
 * @param sceneId - STAC item id.
 * @param display - TCI, a band, or a composite key.
 * @returns The layer id, or null.
 */
function sceneLayerId(sceneId: string, display: string): string | null {
  const layer = useAppStore
    .getState()
    .layers.find(
      (candidate) =>
        candidate.metadata?.[SCENE_METADATA_KEY] === sceneId &&
        candidate.metadata?.[DISPLAY_METADATA_KEY] === display,
    );
  return layer?.id ?? null;
}

/** `v` on a grid feature with no scenes in the window. */
const V_UNPAINTED = -1;
/** `v` on a grid feature that fails a map filter. */
const V_DIMMED = -2;
/** Result cards rendered per "Show more" step. */
const PAGE_SIZE = 30;
/** Delay before a slider drag repaints the map. */
const REPAINT_DEBOUNCE_MS = 150;
/** Delay before a time slider drag streams the frame it rests on. */
const FRAME_DEBOUNCE_MS = 300;
/** How long playback holds a frame once it is on the map. */
const PLAY_DWELL_MS = 1500;
/** How often, and how long at most, a new frame is polled for its first paint. */
const FRAME_POLL_MS = 100;
const FRAME_WAIT_MS = 20_000;

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
  fileList: "display:flex;gap:4px;flex-wrap:wrap;",
  fileLink:
    "padding:1px 6px;font-size:10px;border-radius:4px;cursor:pointer;" +
    "border:1px dashed hsl(var(--border));background:transparent;" +
    "color:hsl(var(--primary));font-family:ui-monospace,monospace;",
  about:
    "display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:6px;" +
    "border:1px solid hsl(var(--border));background:hsl(var(--muted));",
  aboutSummary: "font-weight:600;cursor:pointer;",
  action:
    "padding:2px 8px;font-size:11px;border-radius:4px;cursor:pointer;" +
    "border:1px solid hsl(var(--border));background:hsl(var(--background));" +
    "color:hsl(var(--foreground));",
  primaryAction:
    "padding:2px 8px;font-size:11px;border-radius:4px;cursor:pointer;" +
    "border:1px solid hsl(var(--primary));background:hsl(var(--primary));" +
    "color:hsl(var(--primary-foreground));",
  checkbox: "display:flex;align-items:center;gap:6px;font-size:11px;",
  timeSlider:
    "display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:6px;" +
    "border:1px solid hsl(var(--primary) / 0.5);",
  frameLabel: "font-weight:600;font-variant-numeric:tabular-nums;",
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
  /** Whether the About section at the top of the panel is expanded. */
  aboutOpen: boolean;
  /** Whether the selected tile gets a time slider over its scenes. */
  timeSlider: boolean;
  /** The scene the time slider rests on, and its time (to stay near it). */
  sliderSceneId: string | null;
  sliderSceneT: number | null;
  /** Whether the time slider is playing. */
  playing: boolean;
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
    aboutOpen: true,
    timeSlider: false,
    sliderSceneId: null,
    sliderSceneT: null,
    playing: false,
  };
}

let state: PanelState = initialState();
let appRef: GeoLibreAppAPI | null = null;
let panelContainer: HTMLElement | null = null;
let disposePanel: (() => void) | null = null;
let unregisterPanel: (() => void) | null = null;
let unsubscribeLocale: (() => void) | null = null;
/** Re-labels the result cards' Add/Remove buttons; set while a panel is mounted. */
let syncSceneButtons: (() => void) | null = null;
/** Re-renders the panel's dynamic parts; set while a panel is mounted. */
let refreshPanel: (() => void) | null = null;
/** Per-tile aggregates of the painted window. */
let tileStats = new Map<string, S2TileStats>();
/** What {@link tileStats} was aggregated from: collection, months, metric. */
let tileStatsKey = "";
/** The decoded grid of the painted collection. */
let grid: FeatureCollection<Geometry, S2GridProperties> | null = null;
let gridCollection: S2CollectionId | null = null;
let paintSeq = 0;
let searchController: AbortController | null = null;
let detachMap: (() => void) | null = null;
let repaintTimer: ReturnType<typeof setTimeout> | null = null;
/** Updates the time slider in place; set while a panel is mounted. */
let renderSlider: (() => void) | null = null;
/**
 * The layer showing the time slider's frame. `owned` is false when the frame
 * was already on the map as the user's own layer, which the slider then
 * never removes.
 */
let sliderLayer: { id: string; owned: boolean } | null = null;
/** `sceneLayerKey` of the frame shown or being streamed. */
let sliderFrameKey = "";
let sliderSeq = 0;
let frameTimer: ReturnType<typeof setTimeout> | null = null;
let playTimer: ReturnType<typeof setTimeout> | null = null;

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
      const loaded = await loadMgrsGrid(collection);
      // A collection switch during the load started a newer paint; label the
      // grid by the collection it was read for, never the current one.
      if (seq !== paintSeq) return;
      grid = loaded;
      gridCollection = collection.id;
    }
    const months = monthsIn(state.from, state.to);
    // The aggregate depends only on the collection, months and metric, so a
    // filter drag repaints without reading or aggregating anything.
    const statsKey = `${collection.id}|${months.join(",")}|${state.metric}`;
    if (statsKey !== tileStatsKey) {
      const slices = await loadMonthSlices(collection, months);
      if (seq !== paintSeq) return;
      tileStats = aggregateMonths(
        slices.filter((rows): rows is NonNullable<typeof rows> => rows !== null),
        state.metric,
      );
      tileStatsKey = statsKey;
    }
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
    // With a tile selected the status line belongs to its search (the read
    // plan, or an error); a repaint must not wipe it.
    if (!state.tile) {
      setStatus(
        tr(
          "gridPainted",
          "{{passing}} of {{total}} tiles pass the filters. Click a tile to find its scenes.",
          {
            passing: passing.toLocaleString(),
            total: tileStats.size.toLocaleString(),
          },
        ),
      );
    }
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
    if (map.getSource(GRID_SOURCE_ID)) return;
    try {
      ensureOverlays(map);
      syncSelectedTile(map);
    } catch {
      // Mid-switch the style may refuse new sources; the next styledata
      // event, once the new style has loaded, retries.
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
function displayOptions(): Array<{
  label: string;
  options: Array<{ value: DisplayKey; label: string }>;
}> {
  const collection = S2_COLLECTIONS[state.collection];
  const bands = [
    ...S2_BANDS,
    ...S2_MASK_BANDS.filter((band) => collection.masks.includes(band.key)),
  ];
  const composites: Array<{ value: DisplayKey; label: string }> = [
    { value: "TCI", label: tr("displayTci", "True color (TCI)") },
  ];
  if (compositesSupported()) {
    composites.push(
      ...(Object.keys(S2_COMPOSITES) as S2CompositeKey[]).map((key) => ({
        value: key,
        label: compositeLabel(key),
      })),
    );
  }
  return [
    {
      label: tr("groupComposites", "Composites and indices"),
      options: composites,
    },
    {
      label: tr("groupBands", "Single bands"),
      options: bands.map((band) => ({
        value: band.key,
        label: `${band.key} · ${tr(`band${band.key}`, band.label)} · ${band.res} m`,
      })),
    },
  ];
}

/** The display name of a composite, with the bands it reads. */
function compositeLabel(key: S2CompositeKey): string {
  const names: Record<S2CompositeKey, string> = {
    fcir: tr("compositeFcir", "False color infrared"),
    agri: tr("compositeAgri", "Agriculture"),
    swir: tr("compositeSwir", "Short-wave infrared"),
    ndvi: tr("compositeNdvi", "NDVI (vegetation index)"),
    ndwi: tr("compositeNdwi", "NDWI (water index)"),
  };
  const spec = S2_COMPOSITES[key];
  return `${names[key]} · ${spec.bands.join(spec.kind === "index" ? "/" : ", ")}`;
}

/**
 * Whether composites can be drawn: they are tiles of a MapLibre protocol,
 * which the Mapbox renderer cannot reach.
 */
function compositesSupported(): boolean {
  // engine-audit-allow: getMap-mapbox -- detects MapLibre; composites are hidden on Mapbox
  return Boolean(appRef?.getMap?.());
}

/**
 * Adds a multi-file composite of a scene as a tile layer.
 *
 * @returns The layer id, or null when composites are unavailable.
 */
function addCompositeToMap(
  scene: S2Scene,
  dir: string,
  key: S2CompositeKey,
  zoomTo: boolean,
): string | null {
  const app = appRef;
  if (!app?.addTileLayer || !compositesSupported()) {
    setStatus(tr("noComposite", "Composites need the MapLibre renderer."), true);
    return null;
  }
  const name = `${scene.id} (${compositeLabel(key)})`;
  const bbox =
    scene.bbox.length === 4 ? (scene.bbox as [number, number, number, number]) : undefined;
  const id = app.addTileLayer(name, compositeTileUrl(dir, key, baselineOffset(scene.baseline)), {
    tileSize: 256,
    // 10 m bands reach their native detail near z14; deeper zooms upsample.
    maxzoom: 14,
    attribution: ATTRIBUTION,
    ...(bbox ? { bounds: bbox } : {}),
    metadata: { [SCENE_METADATA_KEY]: scene.id, [DISPLAY_METADATA_KEY]: key },
  });
  if (bbox && zoomTo) app.fitBounds?.(bbox);
  setStatus(tr("added", "Added {{name}}.", { name }));
  return id;
}

/** The files of a scene the Download list offers. */
function sceneFiles(): Array<{ key: string; label: string }> {
  const collection = S2_COLLECTIONS[state.collection];
  return [
    { key: "TCI", label: "TCI" },
    ...S2_BANDS.map((band) => ({ key: band.key, label: band.key })),
    ...S2_MASK_BANDS.filter((band) => collection.masks.includes(band.key)).map((band) => ({
      key: band.key,
      label: band.key,
    })),
  ];
}

/** Opens a scene file for download (the system browser on desktop). */
function downloadFile(url: string): void {
  if (appRef?.openExternalUrl) {
    appRef.openExternalUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * Adds one scene to the map as a COG layer in the chosen display.
 *
 * @param scene - The scene to add.
 * @param display - TCI, a band, or a composite key.
 * @param zoomTo - Whether to fit the map to the scene once added.
 * @returns The new layer's id, or null when the add failed.
 */
async function addSceneToMap(
  scene: S2Scene,
  display: DisplayKey,
  zoomTo = true,
): Promise<string | null> {
  const app = appRef;
  let dir: string;
  try {
    dir = sceneDirectory(scene.thumbnailUrl);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
    return null;
  }
  if (isComposite(display)) return addCompositeToMap(scene, dir, display, zoomTo);
  if (!app?.addCogLayer) {
    setStatus(tr("noCog", "This GeoLibre build cannot add COG layers."), true);
    return null;
  }
  const url = `${dir}/${display}.tif`;
  const name = `${scene.id} (${display})`;
  let options: GeoLibreCogLayerOptions;
  if (display === "TCI") {
    // The visual COG is already stretched by ESA; 0 is the swath-edge nodata.
    options = { bands: "1,2,3", nodata: 0, zoomTo };
  } else if (display === "SCL") {
    // A categorical palette: one tab20 entry per class value.
    const [min, max] = bandRescale(display, scene.baseline);
    options = {
      bands: "1",
      colormap: "tab20",
      rescaleMin: min,
      rescaleMax: max,
      nodata: 0,
      zoomTo,
    };
  } else {
    const [min, max] = bandRescale(display, scene.baseline);
    options = {
      bands: "1",
      colormap: "gray",
      rescaleMin: min,
      rescaleMax: max,
      nodata: 0,
      zoomTo,
    };
  }
  setStatus(tr("adding", "Adding {{name}}…", { name }));
  const pendingKey = sceneLayerKey(scene.id, display);
  pendingAdds.add(pendingKey);
  syncSceneButtons?.();
  try {
    const id = await app.addCogLayer(name, url, options);
    const store = useAppStore.getState();
    const layer = store.layers.find((candidate) => candidate.id === id);
    if (layer) {
      store.updateLayer(id, {
        metadata: {
          ...layer.metadata,
          attribution: ATTRIBUTION,
          [SCENE_METADATA_KEY]: scene.id,
          [DISPLAY_METADATA_KEY]: display,
        },
      });
    }
    setStatus(tr("added", "Added {{name}}.", { name }));
    return id;
  } catch (error) {
    setStatus(
      tr("addFailed", "Could not add {{name}}: {{error}}", {
        name,
        error: error instanceof Error ? error.message : String(error),
      }),
      true,
    );
    return null;
  } finally {
    pendingAdds.delete(pendingKey);
    syncSceneButtons?.();
  }
}

// ---------------------------------------------------------------------------
// Time slider
// ---------------------------------------------------------------------------

// The slider steps through the selected tile's filtered scenes, oldest first,
// and keeps one store layer showing the frame it rests on: each new frame is
// added before the previous one is removed, so the map never flashes empty.

/** The time slider's frames: the selected tile's passing scenes, oldest first. */
function sliderSeries(): S2Scene[] {
  if (!state.tile || !state.searched || state.searched.tile !== state.tile) return [];
  return timeSeriesScenes(state.scenes, {
    from: state.from,
    to: state.to,
    maxCloud: state.maxCloud,
    minCoverage: state.minCoverage,
  });
}

/** The frame index the slider rests on, or -1 with no frames. */
function sliderIndex(series: S2Scene[]): number {
  return timeSeriesIndex(series, state.sliderSceneId, state.sliderSceneT);
}

function clearPlayTimer(): void {
  if (playTimer) clearTimeout(playTimer);
  playTimer = null;
}

/**
 * Stops the slider driving the map. The frame on the map stays as an
 * ordinary layer the user can keep or remove; a frame still loading has never
 * been shown, so it is superseded and removed like any frame skipped past.
 */
function stopSlider(): void {
  if (frameTimer) clearTimeout(frameTimer);
  frameTimer = null;
  clearPlayTimer();
  sliderSeq++;
  sliderLayer = null;
  sliderFrameKey = "";
  state.playing = false;
}

/**
 * Streams the frame the slider rests on, unless it is already shown or on its
 * way. A drag passes `delay` so only the frame it settles on is read.
 *
 * @param delay - Milliseconds to wait before reading the frame.
 */
function scheduleSliderFrame(delay = 0): void {
  if (!state.timeSlider) return;
  // The user may have removed the frame's layer (Layers panel, card button).
  if (sliderLayer && !useAppStore.getState().layers.some((l) => l.id === sliderLayer?.id)) {
    sliderLayer = null;
    sliderFrameKey = "";
  }
  const series = sliderSeries();
  const scene = series[sliderIndex(series)];
  if (!scene) return;
  const display = state.display;
  const key = sceneLayerKey(scene.id, display);
  if (key === sliderFrameKey) return;
  // Supersede a frame still loading, so it cannot settle and retire the
  // frame on the map before this one is read.
  sliderSeq++;
  sliderFrameKey = key;
  if (frameTimer) clearTimeout(frameTimer);
  frameTimer = setTimeout(() => {
    frameTimer = null;
    void showSliderFrame(scene, display);
  }, delay);
}

/**
 * Whether a frame layer has painted the viewport: the raster control's load
 * state for a COG (plus its deck.gl tiles when the shared overlay draws it),
 * MapLibre's tile state for a composite tile layer. An errored layer counts as
 * settled, so a failed tile never stalls playback.
 *
 * @param layerId - The frame's store layer id.
 * @returns True once the frame is drawn or has failed.
 */
function frameRendered(layerId: string): boolean {
  const layer = useAppStore.getState().layers.find((candidate) => candidate.id === layerId);
  if (!layer) return true;
  if (layer.metadata?.sourceKind === "maplibre-gl-raster") {
    const raster = getRasterLoadState(layerId);
    if (raster.error) return true;
    if (raster.loading) return false;
    if (raster.deckTracked) {
      const deck = getSharedDeckLoadState(layerId);
      return Boolean(deck.error) || (deck.found && !deck.loading);
    }
    // An overlaid deck canvas (desktop) reports nothing past the header state.
    if (!raster.native) return true;
  }
  const map = mapOf();
  return !map || map.areTilesLoaded();
}

/**
 * Resolves once a frame has painted, the wait times out, or a newer frame
 * supersedes it.
 *
 * @param layerId - The frame's store layer id.
 * @param seq - The {@link sliderSeq} the frame was requested under.
 * @returns False when a newer frame superseded this one.
 */
async function waitForFrame(layerId: string, seq: number): Promise<boolean> {
  const started = Date.now();
  while (seq === sliderSeq && !frameRendered(layerId) && Date.now() - started < FRAME_WAIT_MS) {
    await new Promise((resolve) => setTimeout(resolve, FRAME_POLL_MS));
  }
  return seq === sliderSeq;
}

/**
 * Puts a frame on the map and retires the previous one once the new frame has
 * painted, so the map never shows a gap between frames.
 */
async function showSliderFrame(scene: S2Scene, display: DisplayKey): Promise<void> {
  const seq = ++sliderSeq;
  const existing = sceneLayerId(scene.id, display);
  // Zoom to the first frame only; later frames share its footprint.
  const id = existing ?? (await addSceneToMap(scene, display, sliderLayer === null));
  const owned = existing === null;
  if (!id) {
    if (seq !== sliderSeq) return;
    // The add failed (its status says why). The frame key stays set, so a
    // panel refresh does not retry a missing COG in a loop; stepping away and
    // back retries it.
    state.playing = false;
    renderSlider?.();
    return;
  }
  // Hold the previous frame underneath until this one has drawn. A newer
  // frame asked for meanwhile supersedes this one, which then goes.
  if (!(await waitForFrame(id, seq))) {
    if (owned) removeLayerIfPresent(id);
    return;
  }
  const previous = sliderLayer;
  sliderLayer = { id, owned };
  if (previous?.owned && previous.id !== id) removeLayerIfPresent(previous.id);
  if (state.playing) {
    clearPlayTimer();
    playTimer = setTimeout(() => {
      playTimer = null;
      if (state.playing) stepSlider(1, true);
    }, PLAY_DWELL_MS);
  }
}

/** Removes a store layer unless the user already removed it. */
function removeLayerIfPresent(layerId: string): void {
  const store = useAppStore.getState();
  if (store.layers.some((layer) => layer.id === layerId)) store.removeLayer(layerId);
}

/**
 * Moves the slider to a frame and streams it.
 *
 * @param index - The frame index in the current series.
 * @param delay - Milliseconds to wait before reading the frame.
 */
function moveSlider(index: number, delay = 0): void {
  const series = sliderSeries();
  const scene = series[index];
  if (!scene) return;
  state.sliderSceneId = scene.id;
  state.sliderSceneT = scene.t;
  renderSlider?.();
  scheduleSliderFrame(delay);
}

/**
 * Steps the slider by `delta` frames.
 *
 * @param delta - Frames to move, negative for earlier.
 * @param wrap - Whether to wrap around the ends (playback loops).
 */
function stepSlider(delta: number, wrap = false): void {
  const series = sliderSeries();
  if (!series.length) return;
  let next = sliderIndex(series) + delta;
  if (wrap) next = (next + series.length) % series.length;
  else next = Math.max(0, Math.min(series.length - 1, next));
  moveSlider(next);
}

/** Starts or pauses playback. */
function togglePlay(): void {
  state.playing = !state.playing;
  clearPlayTimer();
  if (state.playing) stepSlider(1, true);
  else renderSlider?.();
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
      fromInput.min = S2_COLLECTIONS[value].firstDate;
      toInput.min = S2_COLLECTIONS[value].firstDate;
      fromInput.value = state.from;
      toInput.value = state.to;
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

  const sliderToggle = element("label", CSS.checkbox);
  const sliderCheckbox = element("input");
  sliderCheckbox.type = "checkbox";
  sliderCheckbox.checked = state.timeSlider;
  sliderCheckbox.addEventListener("change", () => {
    state.timeSlider = sliderCheckbox.checked;
    if (!state.timeSlider) stopSlider();
    renderSlider?.();
    scheduleSliderFrame();
  });
  sliderToggle.title = tr(
    "timeSliderTitle",
    "Step through the selected tile's scenes in time order, one layer at a time",
  );
  sliderToggle.append(sliderCheckbox, tr("timeSlider", "Time slider"));

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

  // The time slider, updated in place so a status change mid-drag never
  // rebuilds the range input under the pointer.
  const sliderSection = element("div", CSS.timeSlider);
  const sliderHead = element("div", CSS.resultHeader);
  const sliderCount = element("span", CSS.cardMeta);
  sliderHead.append(element("div", CSS.sectionTitle, tr("timeSlider", "Time slider")), sliderCount);
  const frameDay = element("div", CSS.frameLabel);
  const frameMeta = element("div", CSS.cardMeta);
  const sliderInput = element("input", CSS.slider);
  sliderInput.type = "range";
  sliderInput.min = "0";
  sliderInput.step = "1";
  sliderInput.setAttribute("aria-label", tr("timeSlider", "Time slider"));
  sliderInput.addEventListener("input", () => {
    state.playing = false;
    clearPlayTimer();
    moveSlider(Number(sliderInput.value), FRAME_DEBOUNCE_MS);
  });
  const prevButton = button(tr("previous", "Previous"), CSS.action, () => {
    state.playing = false;
    clearPlayTimer();
    stepSlider(-1);
  });
  const playButton = button("", CSS.primaryAction, togglePlay);
  const nextButton = button(tr("next", "Next"), CSS.action, () => {
    state.playing = false;
    clearPlayTimer();
    stepSlider(1);
  });
  const sliderActions = element("div", CSS.actions);
  sliderActions.append(prevButton, playButton, nextButton);
  const sliderEmpty = element(
    "p",
    CSS.hint,
    tr("timeSliderEmpty", "No scenes of this tile match the filters."),
  );
  sliderSection.append(sliderHead, frameDay, frameMeta, sliderInput, sliderActions, sliderEmpty);

  // `hidden` loses to the inline `display:flex`, so toggle display itself.
  const show = (node: HTMLElement, shown: boolean, display = "block") => {
    node.style.display = shown ? display : "none";
  };
  renderSlider = () => {
    const visible = state.timeSlider && Boolean(state.searched) && !state.busy;
    show(sliderSection, visible, "flex");
    if (!visible) return;
    const series = sliderSeries();
    const index = sliderIndex(series);
    const scene = series[index];
    const hasFrames = Boolean(scene);
    show(sliderEmpty, !hasFrames);
    show(frameDay, hasFrames);
    show(frameMeta, hasFrames);
    show(sliderInput, hasFrames);
    show(sliderActions, hasFrames, "flex");
    sliderCount.textContent = hasFrames
      ? tr("frameCount", "{{index}} / {{count}}", { index: index + 1, count: series.length })
      : "";
    if (!scene) return;
    frameDay.textContent = scene.day;
    frameMeta.textContent = tr("sceneMeta", "{{cloud}}% cloud · {{cover}} coverage", {
      cloud: scene.cloud.toFixed(1),
      cover: scene.cover === null ? "?" : `${scene.cover.toFixed(0)}%`,
    });
    sliderInput.max = String(series.length - 1);
    if (sliderInput.value !== String(index)) sliderInput.value = String(index);
    prevButton.disabled = index <= 0;
    nextButton.disabled = index >= series.length - 1;
    playButton.disabled = series.length < 2;
    playButton.textContent = state.playing ? tr("pause", "Pause") : tr("play", "Play");
    playButton.setAttribute("aria-pressed", String(state.playing));
  };

  // Results.
  const resultsSection = element("div", CSS.section);
  const displayHolder = element("label", CSS.label, tr("display", "Add scenes as"));
  let displaySelect: HTMLSelectElement | null = null;
  function renderDisplaySelect(): void {
    const next = element("select", CSS.input);
    next.setAttribute("aria-label", tr("display", "Add scenes as"));
    for (const group of displayOptions()) {
      const optgroup = element("optgroup");
      optgroup.label = group.label;
      for (const option of group.options) optgroup.append(new Option(option.label, option.value));
      next.append(optgroup);
    }
    // A composite chosen earlier is gone on a renderer without composites.
    if (![...next.options].some((option) => option.value === state.display)) state.display = "TCI";
    next.value = state.display;
    next.addEventListener("change", () => {
      state.display = next.value;
      syncSceneButtons?.();
      scheduleSliderFrame();
    });
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

  /** The Add/Remove buttons of the rendered cards and their scenes. */
  const sceneButtons = new Map<HTMLButtonElement, S2Scene>();

  function syncSceneButton(node: HTMLButtonElement, scene: S2Scene): void {
    const pending = pendingAdds.has(sceneLayerKey(scene.id, state.display));
    const onMap = !pending && sceneLayerId(scene.id, state.display) !== null;
    node.disabled = pending;
    node.textContent = pending
      ? tr("addingShort", "Adding…")
      : onMap
        ? tr("removeFromMap", "Remove from map")
        : tr("addToMap", "Add to map");
    node.title = onMap
      ? tr("removeFromMapTitle", "Remove this scene's layer from the map")
      : tr("addToMapTitle", "Stream this scene's Cloud-Optimized GeoTIFF onto the map");
    node.style.cssText = onMap || pending ? CSS.action : CSS.primaryAction;
    node.setAttribute("aria-pressed", String(onMap));
  }

  function sceneCard(scene: S2Scene): HTMLElement {
    const card = element("div", CSS.card);
    const thumb = element("img", CSS.thumb);
    thumb.loading = "lazy";
    thumb.alt = "";
    thumb.referrerPolicy = "no-referrer";
    // The same https and bucket check the COG reads get.
    try {
      sceneDirectory(scene.thumbnailUrl);
      thumb.src = scene.thumbnailUrl;
    } catch {
      // No preview for a thumbnail off the expected buckets.
    }
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
    // Add or remove, for the display chosen above; kept in step with the
    // store, so removing the layer in the Layers panel flips it back.
    const addButton = button("", CSS.primaryAction, () => {
      const layerId = sceneLayerId(scene.id, state.display);
      if (layerId) useAppStore.getState().removeLayer(layerId);
      else void addSceneToMap(scene, state.display);
    });
    sceneButtons.set(addButton, scene);
    syncSceneButton(addButton, scene);
    actions.append(
      addButton,
      button(tr("zoom", "Zoom"), CSS.action, () => {
        if (scene.bbox.length === 4) {
          appRef?.fitBounds?.(scene.bbox as [number, number, number, number]);
        }
      }),
    );
    // The scene's files, listed on demand: COGs of 100-250 MB each, handed to
    // the browser (or the system browser on desktop) rather than buffered.
    const files = element("div", CSS.fileList);
    files.hidden = true;
    const download = button(
      tr("download", "Download"),
      CSS.action,
      () => {
        if (!files.childElementCount) {
          let dir: string;
          try {
            dir = sceneDirectory(scene.thumbnailUrl);
          } catch (error) {
            setStatus(error instanceof Error ? error.message : String(error), true);
            return;
          }
          for (const file of sceneFiles()) {
            const url = `${dir}/${file.key}.tif`;
            const fileButton = button(
              `${file.label}.tif`,
              CSS.fileLink,
              () => downloadFile(url),
              url,
            );
            files.append(fileButton);
          }
        }
        files.hidden = !files.hidden;
        download.setAttribute("aria-expanded", String(!files.hidden));
      },
      tr("downloadTitle", "Download this scene's Cloud-Optimized GeoTIFFs"),
    );
    download.setAttribute("aria-expanded", "false");
    actions.append(download);
    body.append(id, actions, files);
    card.append(thumb, body);
    card.addEventListener("mouseenter", () => showFootprint(scene));
    card.addEventListener("mouseleave", () => showFootprint(null));
    return card;
  }

  function renderResults(): void {
    sceneButtons.clear();
    resultsSection.replaceChildren();
    // Filters and searches change the frames; a drag settles before a read.
    // Every refresh lands here, and scheduleSliderFrame returns early while
    // the frame key is unchanged, so a status update never re-reads a frame.
    renderSlider?.();
    scheduleSliderFrame(FRAME_DEBOUNCE_MS);
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

  const about = element("details", CSS.about);
  about.open = state.aboutOpen;
  about.addEventListener("toggle", () => {
    state.aboutOpen = about.open;
  });
  about.append(
    element("summary", CSS.aboutSummary, tr("about", "About this explorer")),
    intro,
    links,
  );

  root.append(
    about,
    collectionLabel,
    dates,
    metricLabel,
    legend,
    gridToggle,
    sliderToggle,
    filters,
    status,
    sliderSection,
    resultsSection,
    attribution,
  );

  refreshPanel = () => {
    renderStatus();
    renderResults();
  };
  refreshPanel();
  syncSceneButtons = () => {
    for (const [node, scene] of sceneButtons) syncSceneButton(node, scene);
  };
  // A layer added or removed anywhere (the Layers panel, undo) re-labels the cards.
  const unsubscribeLayers = useAppStore.subscribe((store, previous) => {
    if (store.layers !== previous.layers) syncSceneButtons?.();
  });

  return () => {
    unsubscribeLayers();
    syncSceneButtons = null;
    refreshPanel = null;
    renderSlider = null;
    showFootprint(null);
    container.replaceChildren();
  };
}

function isBaseDisplay(display: DisplayKey): boolean {
  return display === "TCI" || isComposite(display) || S2_BANDS.some((band) => band.key === display);
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
    registerSentinel2CompositeProtocol();
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
    stopSlider();
    if (repaintTimer) clearTimeout(repaintTimer);
    repaintTimer = null;
    paintSeq++;
    detachMap?.();
    detachMap = null;
    removeOverlays(mapOf());
    state = initialState();
    tileStats = new Map();
    tileStatsKey = "";
    // `grid` carries the last window's colors baked in; the raw grid stays
    // cached in the data module.
    grid = null;
    gridCollection = null;
    appRef = null;
  },
};

export default maplibreSentinel2ExplorerPlugin;
