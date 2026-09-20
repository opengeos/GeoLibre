import { DEFAULT_LAYER_STYLE, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import type { Feature, FeatureCollection } from "geojson";
import type {
  ExpressionSpecification,
  GeoJSONSource,
  Map as MapLibreMap,
  MapLayerMouseEvent,
} from "maplibre-gl";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";
import { fetchIgnLidarHdTiles, type IgnLidarHdTile } from "./ign-lidar-hd-api";
import {
  LIDAR_SOURCE_KIND,
  restoreLidarLayers,
  withLidarAutoZoomSuppressed,
} from "./maplibre-components";
import { getStyleMap } from "./style-map";

export const IGN_LIDAR_HD_PLUGIN_ID = "geolibre-ign-lidar-hd";
const PANEL_ID = IGN_LIDAR_HD_PLUGIN_ID;

// A plugin-owned native layer (not app.addGeoJsonLayer) so map clicks can be
// handled directly, while still appearing as a normal Layers-panel entry.
const FOOTPRINT_SOURCE_ID = "geolibre-ign-lidar-hd-footprints";
const FOOTPRINT_FILL_LAYER_ID = "geolibre-ign-lidar-hd-footprints-fill";
const FOOTPRINT_LINE_LAYER_ID = "geolibre-ign-lidar-hd-footprints-line";
const FOOTPRINT_STORE_LAYER_ID = "geolibre-ign-lidar-hd-footprints-layer";
/** `metadata.sourceKind` of the footprints entry. */
const FOOTPRINT_SOURCE_KIND = "ign-lidar-hd-footprints";
const FOOTPRINT_COLOR = "#2f6feb";

// Plugin-private hover overlay: highlights one tile's footprint on the map
// when its row in the list is hovered. Never registered in the Layers panel
// (see setHoveredTile) — it is transient UI chrome, not user data.
const HOVER_SOURCE_ID = "geolibre-ign-lidar-hd-hover";
const HOVER_FILL_LAYER_ID = "geolibre-ign-lidar-hd-hover-fill";
const HOVER_LINE_LAYER_ID = "geolibre-ign-lidar-hd-hover-line";
const HOVER_HIGHLIGHT_COLOR = "#f5a623";

// Footprint fill/line color while its tile is checked for bulk Add to map.
const SELECTED_COLOR = "#22c55e";

let unregisterPanel: (() => void) | null = null;
let unsubscribeLocale: (() => void) | null = null;
let panelContainer: HTMLElement | null = null;
let disposePanel: (() => void) | null = null;
let refreshPanelLabels: (() => void) | null = null;

// Footprint click/hover handlers are bound once per map (module scope, like
// the store-layer registration below), and dispatch into whichever panel
// instance is currently active — a fresh buildPanel() call replaces this.
let footprintClickHandlersBound = false;
let footprintsRegistered = false;
let onFootprintSelect: ((id: string) => void) | null = null;
let onFootprintHover: ((id: string | null) => void) | null = null;

const CSS = {
  panel:
    "display:flex;flex-direction:column;gap:10px;padding:10px;height:100%;" +
    "box-sizing:border-box;overflow-y:auto;color:hsl(var(--foreground));font-size:12px;",
  hint: "margin:0;color:hsl(var(--muted-foreground));line-height:1.45;",
  attribution:
    "margin:0;display:block;color:hsl(var(--muted-foreground));line-height:1.45;" +
    "text-decoration:underline;",
  field: "display:flex;flex-direction:column;gap:4px;",
  label: "display:flex;flex-direction:column;gap:4px;font-size:11px;font-weight:600;",
  grid: "display:grid;grid-template-columns:1fr 1fr;gap:7px;",
  input:
    "width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid hsl(var(--border));" +
    "border-radius:6px;background:hsl(var(--background));color:hsl(var(--foreground));",
  button:
    "padding:7px 10px;border:1px solid hsl(var(--border));border-radius:6px;" +
    "background:hsl(var(--background));color:hsl(var(--foreground));cursor:pointer;",
  primary:
    "padding:7px 10px;border:1px solid hsl(var(--primary));border-radius:6px;" +
    "background:hsl(var(--primary));color:hsl(var(--primary-foreground));cursor:pointer;font-weight:600;",
  small:
    "padding:4px 8px;border:1px solid hsl(var(--border));border-radius:6px;font-size:11px;" +
    "background:hsl(var(--background));color:hsl(var(--foreground));cursor:pointer;",
  actions: "display:flex;gap:7px;flex-wrap:wrap;",
  status:
    "box-sizing:border-box;width:100%;padding:8px;border-radius:6px;background:hsl(var(--muted));" +
    "color:hsl(var(--muted-foreground));line-height:1.45;",
  list: "display:flex;flex-direction:column;gap:6px;",
  row:
    "box-sizing:border-box;width:100%;display:flex;align-items:center;justify-content:space-between;" +
    "gap:8px;padding:6px 8px;border:1px solid hsl(var(--border));border-radius:6px;",
  rowText: "display:flex;flex-direction:column;gap:2px;min-width:0;",
  rowTitle: "font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
  rowSubtitle: "color:hsl(var(--muted-foreground));font-size:11px;",
  rowActions: "display:flex;gap:6px;flex-shrink:0;",
  rowCheckbox: "flex-shrink:0;cursor:pointer;",
  listToolbar: "display:flex;align-items:center;justify-content:space-between;gap:8px;",
  listToolbarLeft:
    "display:flex;align-items:center;gap:6px;font-size:11px;" +
    "color:hsl(var(--muted-foreground));cursor:pointer;",
};

/** Resolves a plugin-namespaced translation key, falling back to English text. */
function tr(
  app: GeoLibreAppAPI,
  key: string,
  fallback: string,
  params?: Record<string, string | number>,
) {
  return app.translate?.(`plugin.${IGN_LIDAR_HD_PLUGIN_ID}.${key}`, fallback, params) ?? fallback;
}

/** Creates an HTML element with the given inline CSS applied. */
function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (style) node.style.cssText = style;
  return node;
}

/** Wraps a control in a labeled form field. */
function field(labelText: string, control: HTMLElement): HTMLDivElement {
  const wrapper = element("div", CSS.field);
  const label = element("label", CSS.label);
  label.textContent = labelText;
  label.append(control);
  wrapper.append(label);
  return wrapper;
}

/** Updates a field's label text without rebuilding it. */
function setFieldLabel(wrapper: HTMLDivElement, labelText: string): void {
  const text = wrapper.querySelector("label")?.firstChild;
  if (text) text.nodeValue = labelText;
}

/** Formats a coordinate value for the bbox inputs, trimming trailing zeros. */
function formatNumber(value: number): string {
  return Number(value.toFixed(6)).toString();
}

/** Returns the best human-readable identifier for a tile. */
function tileTitle(tile: IgnLidarHdTile): string {
  return tile.tileCoord || tile.missionCode || tile.id || crypto.randomUUID();
}

/** Builds the row subtitle from acquisition date, mission code, and publish status. */
function tileSubtitle(app: GeoLibreAppAPI, tile: IgnLidarHdTile): string {
  const parts: string[] = [];
  if (tile.acquisitionStart) parts.push(tile.acquisitionStart);
  if (tile.missionCode && tile.missionCode !== tileTitle(tile)) parts.push(tile.missionCode);
  if (!tile.downloadUrl) parts.push(tr(app, "noDownload", "no point cloud published"));
  return parts.join(" · ");
}

/** Download a tile's COPC LAZ file */
function downloadTile(app: GeoLibreAppAPI, tile: IgnLidarHdTile): void {
  if (!tile.downloadUrl) return;
  app.openExternalUrl?.(tile.downloadUrl);
}

/** Derives the store layer id for a tile's point cloud. */
function ignLidarLayerId(tile: IgnLidarHdTile): string {
  return `ign-lidar-hd-${tile.id}`;
}

// IGN's Géoplateforme rate-limits (429 Too Many Requests) when several COPC
// files are requested back-to-back, which is exactly what firing off the
// bulk "Add selected to map" loop without delay does. Spacing requests out
// gives it room to breathe.
const ADD_SELECTED_DELAY_MS = 1500;

/** Resolves after the given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type AddTileToMapResult = "added" | "duplicate" | "unsupported-renderer";

/** Adds a tile's point cloud to the map as a `lidar-url` layer. */
async function addTileToMap(
  app: GeoLibreAppAPI,
  tile: IgnLidarHdTile,
): Promise<AddTileToMapResult> {
  const renderer = app.getMapRenderer?.();
  if (renderer && renderer !== "maplibre" && renderer !== "mapbox") return "unsupported-renderer";
  if (!tile.downloadUrl) return "unsupported-renderer";
  const store = useAppStore.getState();
  const alreadyAdded = store.layers.some(
    (layer) =>
      layer.metadata.sourceKind === LIDAR_SOURCE_KIND && layer.sourcePath === tile.downloadUrl,
  );
  if (alreadyAdded) return "duplicate";
  const id = ignLidarLayerId(tile);
  const layer: GeoLibreLayer = {
    id,
    name: tile.filename ?? `${tileTitle(tile)}.copc.laz`,
    type: "lidar",
    source: { type: "lidar", sourceId: id, url: tile.downloadUrl },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      externalNativeLayer: true,
      sourceKind: LIDAR_SOURCE_KIND,
      identifiable: false,
    },
    sourcePath: tile.downloadUrl,
  };
  store.addLayer(layer);
  // Queues the streaming load; resolves once the request is issued, not once
  // the point cloud has finished loading (matches restoreLidarLayers's own
  // fire-and-forget per-layer loads).
  await restoreLidarLayers(app);
  return "added";
}

// ---------------------------------------------------------------------------
// Map overlays: result footprints (clickable) + the hover highlight
// ---------------------------------------------------------------------------

/** Returns an empty GeoJSON FeatureCollection. */
function emptyCollection(): FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

/** Whether the style is ready for addSource/addLayer (they throw before that). */
function styleReady(map: MapLibreMap): boolean {
  return map.isStyleLoaded() === true;
}

/** Converts a tile into a GeoJSON feature carrying its map-only properties. */
function tileFeature(tile: IgnLidarHdTile, selected = false): Feature {
  return {
    type: "Feature",
    id: tile.id,
    geometry: tile.geometry,
    properties: {
      tileId: tile.id,
      // Drives the footprint's fill/line paint (see ensureFootprintLayers).
      selected,
      tileCoord: tile.tileCoord,
      missionCode: tile.missionCode,
      acquisitionStart: tile.acquisitionStart,
      acquisitionEnd: tile.acquisitionEnd,
      pointCount: tile.pointCount,
      downloadUrl: tile.downloadUrl,
    },
  };
}

/** Selects the clicked footprint's tile. */
function onFootprintClick(event: MapLayerMouseEvent): void {
  const id = event.features?.[0]?.properties?.tileId;
  if (typeof id === "string") onFootprintSelect?.(id);
}

/** Switches the cursor to a pointer over a footprint. */
function onFootprintEnter(event: MapLayerMouseEvent): void {
  event.target.getCanvas().style.cursor = "pointer";
}

/** Updates the hover highlight to whichever footprint is under the cursor. */
function onFootprintMove(event: MapLayerMouseEvent): void {
  const id = event.features?.[0]?.properties?.tileId;
  onFootprintHover?.(typeof id === "string" ? id : null);
}

/** Resets the cursor and clears the hover highlight. */
function onFootprintLeave(event: MapLayerMouseEvent): void {
  event.target.getCanvas().style.cursor = "";
  onFootprintHover?.(null);
}

// Selected vs. not is driven by each feature's own `selected` property (see
// tileFeature) through these expressions, so a checked tile restyles in place
// on the same fill/line layer instead of gaining a second shape drawn over it.
const FOOTPRINT_FILL_COLOR_EXPR: ExpressionSpecification = [
  "case",
  ["boolean", ["get", "selected"], false],
  SELECTED_COLOR,
  FOOTPRINT_COLOR,
];
const FOOTPRINT_FILL_OPACITY_EXPR: ExpressionSpecification = [
  "case",
  ["boolean", ["get", "selected"], false],
  0.35,
  0.15,
];
const FOOTPRINT_LINE_WIDTH_EXPR: ExpressionSpecification = [
  "case",
  ["boolean", ["get", "selected"], false],
  3,
  2,
];

/** Adds the footprint fill/outline layers once, lazily. */
function ensureFootprintLayers(map: MapLibreMap): void {
  if (!styleReady(map)) return;
  if (!map.getSource(FOOTPRINT_SOURCE_ID)) {
    map.addSource(FOOTPRINT_SOURCE_ID, { type: "geojson", data: emptyCollection() });
  }
  if (!map.getLayer(FOOTPRINT_FILL_LAYER_ID)) {
    map.addLayer({
      id: FOOTPRINT_FILL_LAYER_ID,
      type: "fill",
      source: FOOTPRINT_SOURCE_ID,
      paint: {
        "fill-color": FOOTPRINT_FILL_COLOR_EXPR,
        "fill-opacity": FOOTPRINT_FILL_OPACITY_EXPR,
      },
    });
  }
  if (!map.getLayer(FOOTPRINT_LINE_LAYER_ID)) {
    map.addLayer({
      id: FOOTPRINT_LINE_LAYER_ID,
      type: "line",
      source: FOOTPRINT_SOURCE_ID,
      paint: {
        "line-color": FOOTPRINT_FILL_COLOR_EXPR,
        "line-width": FOOTPRINT_LINE_WIDTH_EXPR,
        "line-opacity": 1,
      },
    });
  }
  if (!footprintClickHandlersBound) {
    footprintClickHandlersBound = true;
    map.on("click", FOOTPRINT_FILL_LAYER_ID, onFootprintClick);
    map.on("mouseenter", FOOTPRINT_FILL_LAYER_ID, onFootprintEnter);
    map.on("mousemove", FOOTPRINT_FILL_LAYER_ID, onFootprintMove);
    map.on("mouseleave", FOOTPRINT_FILL_LAYER_ID, onFootprintLeave);
  }
}

/** Registers (or updates) the footprints as a Layers-panel entry. */
function syncFootprintStoreLayer(app: GeoLibreAppAPI, features: Feature[]): void {
  app.registerExternalNativeLayer?.({
    id: FOOTPRINT_STORE_LAYER_ID,
    name: tr(app, "layerName", "IGN LiDAR HD tiles"),
    type: "geojson",
    nativeLayerIds: [FOOTPRINT_FILL_LAYER_ID, FOOTPRINT_LINE_LAYER_ID],
    sourceIds: [FOOTPRINT_SOURCE_ID],
    geojson: { type: "FeatureCollection", features },
    metadata: { sourceKind: FOOTPRINT_SOURCE_KIND },
    paintMode: "plugin",
  });
  // Suppresses the host's Identify click popup; registerExternalNativeLayer
  // has no `popup` field of its own, so this sets it directly on the store.
  useAppStore.getState().updateLayer(FOOTPRINT_STORE_LAYER_ID, { popup: { click: false } });
  footprintsRegistered = true;
}

/** Removes the footprints Layers-panel entry (dropping its fill/line). */
function unregisterFootprintStoreLayer(app: GeoLibreAppAPI): void {
  if (!footprintsRegistered) return;
  footprintsRegistered = false;
  app.unregisterExternalNativeLayer?.(FOOTPRINT_STORE_LAYER_ID);
}

/** Updates the footprint source and Layers-panel entry for the current tiles/selection. */
function setFootprints(
  app: GeoLibreAppAPI,
  tiles: IgnLidarHdTile[],
  selectedIds: ReadonlySet<string>,
): void {
  const map = getStyleMap(app);
  if (!map) return;
  ensureFootprintLayers(map);
  const source = map.getSource(FOOTPRINT_SOURCE_ID) as GeoJSONSource | undefined;
  if (!source) return;
  const features = tiles.map((tile) => tileFeature(tile, selectedIds.has(tile.id)));
  source.setData({ type: "FeatureCollection", features });
  if (features.length > 0) syncFootprintStoreLayer(app, features);
  else unregisterFootprintStoreLayer(app);
}

/** Removes the footprint overlay, its Layers-panel entry, and the click/hover handlers. */
function removeFootprintLayers(app: GeoLibreAppAPI, map: MapLibreMap): void {
  if (footprintClickHandlersBound) {
    footprintClickHandlersBound = false;
    map.off("click", FOOTPRINT_FILL_LAYER_ID, onFootprintClick);
    map.off("mouseenter", FOOTPRINT_FILL_LAYER_ID, onFootprintEnter);
    map.off("mousemove", FOOTPRINT_FILL_LAYER_ID, onFootprintMove);
    map.off("mouseleave", FOOTPRINT_FILL_LAYER_ID, onFootprintLeave);
  }
  unregisterFootprintStoreLayer(app);
  for (const layerId of [FOOTPRINT_LINE_LAYER_ID, FOOTPRINT_FILL_LAYER_ID]) {
    if (map.getLayer(layerId)) map.removeLayer(layerId);
  }
  if (map.getSource(FOOTPRINT_SOURCE_ID)) map.removeSource(FOOTPRINT_SOURCE_ID);
}

/** Adds the hover-highlight source/layers once, lazily. */
function ensureHoverLayer(map: MapLibreMap): void {
  if (!styleReady(map)) return;
  if (!map.getSource(HOVER_SOURCE_ID)) {
    map.addSource(HOVER_SOURCE_ID, { type: "geojson", data: emptyCollection() });
  }
  if (!map.getLayer(HOVER_FILL_LAYER_ID)) {
    map.addLayer({
      id: HOVER_FILL_LAYER_ID,
      type: "fill",
      source: HOVER_SOURCE_ID,
      paint: { "fill-color": HOVER_HIGHLIGHT_COLOR, "fill-opacity": 0.2 },
    });
  }
  if (!map.getLayer(HOVER_LINE_LAYER_ID)) {
    map.addLayer({
      id: HOVER_LINE_LAYER_ID,
      type: "line",
      source: HOVER_SOURCE_ID,
      paint: { "line-color": HOVER_HIGHLIGHT_COLOR, "line-width": 3, "line-opacity": 1 },
    });
  }
}

/** Highlights one tile's footprint on the map, or clears the highlight when `tile` is null. */
function setHoveredTile(app: GeoLibreAppAPI, tile: IgnLidarHdTile | null): void {
  const map = getStyleMap(app);
  if (!map) return;
  ensureHoverLayer(map);
  const source = map.getSource(HOVER_SOURCE_ID) as GeoJSONSource | undefined;
  if (!source) return;
  source.setData(
    tile ? { type: "FeatureCollection", features: [tileFeature(tile)] } : emptyCollection(),
  );
}

/** Removes the hover-highlight source/layers. */
function removeHoverLayer(map: MapLibreMap): void {
  for (const layerId of [HOVER_LINE_LAYER_ID, HOVER_FILL_LAYER_ID]) {
    if (map.getLayer(layerId)) map.removeLayer(layerId);
  }
  if (map.getSource(HOVER_SOURCE_ID)) map.removeSource(HOVER_SOURCE_ID);
}

/** Builds the plugin's right-panel UI and returns its dispose function. */
function buildPanel(container: HTMLElement, app: GeoLibreAppAPI): () => void {
  container.replaceChildren();
  const root = element("div", CSS.panel);
  const hint = element("p", CSS.hint);
  hint.textContent = tr(
    app,
    "hint",
    "Search IGN LiDAR HD tile coverage for the current map area, add tiles to the map as point clouds, or download their COPC LAZ files from IGN's servers.",
  );

  const attribution = element("a", CSS.attribution);
  attribution.href = "https://www.data.gouv.fr/pages/legal/licences/etalab-2.0";
  attribution.target = "_blank";
  attribution.rel = "noopener noreferrer";
  attribution.textContent = tr(
    app,
    "attribution",
    "Data © IGN — LiDAR HD, published under the Licence Ouverte 2.0.",
  );

  const coordGrid = element("div", CSS.grid);
  const coordInputs = ["west", "south", "east", "north"].map(() => {
    const input = element("input", CSS.input);
    input.type = "number";
    input.step = "any";
    return input;
  });
  const coordLabels = [
    tr(app, "west", "West"),
    tr(app, "south", "South"),
    tr(app, "east", "East"),
    tr(app, "north", "North"),
  ];
  const coordFields = coordInputs.map((input, index) => field(coordLabels[index], input));
  coordGrid.append(...coordFields);

  const useView = element("button", CSS.button);
  useView.type = "button";
  useView.textContent = tr(app, "useMapExtent", "Use map extent");
  const searchButton = element("button", CSS.primary);
  searchButton.type = "button";
  searchButton.textContent = tr(app, "search", "Search tiles");
  const queryActions = element("div", CSS.actions);
  queryActions.append(useView, searchButton);

  const status = element("div", CSS.status);
  status.setAttribute("role", "status");
  status.textContent = tr(app, "ready", "Choose an area and search for LiDAR HD tiles.");

  const selectAllCheckbox = element("input");
  selectAllCheckbox.type = "checkbox";
  const selectAllText = element("span");
  selectAllText.textContent = tr(app, "selectAll", "Select all");
  const selectAllLabel = element("label", CSS.listToolbarLeft);
  selectAllLabel.append(selectAllCheckbox, selectAllText);

  const addSelectedButton = element("button", CSS.small);
  addSelectedButton.type = "button";
  addSelectedButton.textContent = tr(app, "addSelectedToMap", "Add selected to map");
  addSelectedButton.disabled = true;

  const listToolbar = element("div", CSS.listToolbar);
  listToolbar.append(selectAllLabel, addSelectedButton);

  const list = element("div", CSS.list);

  root.append(hint, attribution, coordGrid, queryActions, status, listToolbar, list);
  container.append(root);

  let controller: AbortController | null = null;
  let disposed = false;
  let currentTiles: IgnLidarHdTile[] = [];
  // Only used to bulk Add to map — download stays per-tile.
  const selectedTileIds = new Set<string>();
  let rowCheckboxes = new Map<string, HTMLInputElement>();

  // Single source of truth for the hover highlight, shared by list-row hover
  // and map-footprint hover, so hovering a tile's geometry on the map
  // highlights it exactly like hovering its row does (and vice versa),
  // without redundantly re-drawing the highlight for the tile already shown.
  let hoveredTileId: string | null = null;
  /** Updates the shared hover state and redraws the highlight. */
  function updateHoveredTile(id: string | null): void {
    if (id === hoveredTileId) return;
    hoveredTileId = id;
    const tile = id ? (currentTiles.find((t) => t.id === id) ?? null) : null;
    setHoveredTile(app, tile);
  }

  /** Syncs the bulk-selection toolbar and footprint styles to the current selection. */
  function refreshBulkToolbar(): void {
    const eligible = currentTiles.filter((tile) => tile.downloadUrl);
    const selectedEligible = eligible.filter((tile) => selectedTileIds.has(tile.id));
    selectAllCheckbox.disabled = eligible.length === 0;
    selectAllCheckbox.checked = eligible.length > 0 && selectedEligible.length === eligible.length;
    selectAllCheckbox.indeterminate =
      selectedEligible.length > 0 && selectedEligible.length < eligible.length;
    addSelectedButton.disabled = selectedTileIds.size === 0;
    addSelectedButton.textContent =
      selectedTileIds.size > 0
        ? tr(app, "addSelectedToMapCount", "Add {{count}} selected to map", {
            count: selectedTileIds.size,
          })
        : tr(app, "addSelectedToMap", "Add selected to map");
    setFootprints(app, currentTiles, selectedTileIds);
  }

  /** Toggles a footprint's tile in the bulk Add-to-map selection. */
  onFootprintSelect = (id: string) => {
    const tile = currentTiles.find((t) => t.id === id);
    if (!tile || !tile.downloadUrl) return;
    const nowSelected = !selectedTileIds.has(tile.id);
    if (nowSelected) selectedTileIds.add(tile.id);
    else selectedTileIds.delete(tile.id);
    const checkbox = rowCheckboxes.get(tile.id);
    if (checkbox) checkbox.checked = nowSelected;
    refreshBulkToolbar();
  };

  /** A footprint hover on the map: same highlight as hovering its row. */
  onFootprintHover = (id: string | null) => updateHoveredTile(id);

  /** Re-applies translated text to the panel after a language change. */
  const refreshLabels = () => {
    hint.textContent = tr(
      app,
      "hint",
      "Search IGN LiDAR HD tile coverage for the current map area, add tiles to the map as point clouds, or download their COPC LAZ files from IGN's servers.",
    );
    attribution.textContent = tr(
      app,
      "attribution",
      "Data © IGN — LiDAR HD, published under the Licence Ouverte 2.0.",
    );
    const translatedCoords = [
      tr(app, "west", "West"),
      tr(app, "south", "South"),
      tr(app, "east", "East"),
      tr(app, "north", "North"),
    ];
    coordFields.forEach((wrapper, index) => setFieldLabel(wrapper, translatedCoords[index]));
    useView.textContent = tr(app, "useMapExtent", "Use map extent");
    searchButton.textContent = tr(app, "search", "Search tiles");
    selectAllText.textContent = tr(app, "selectAll", "Select all");
    renderList();
  };
  refreshPanelLabels = refreshLabels;

  selectAllCheckbox.addEventListener("change", () => {
    const eligible = currentTiles.filter((tile) => tile.downloadUrl);
    for (const tile of eligible) {
      if (selectAllCheckbox.checked) selectedTileIds.add(tile.id);
      else selectedTileIds.delete(tile.id);
      const checkbox = rowCheckboxes.get(tile.id);
      if (checkbox) checkbox.checked = selectAllCheckbox.checked;
    }
    refreshBulkToolbar();
  });

  addSelectedButton.addEventListener("click", async () => {
    const tiles = currentTiles.filter((tile) => selectedTileIds.has(tile.id) && tile.downloadUrl);
    if (tiles.length === 0) return;
    const renderer = app.getMapRenderer?.();
    if (renderer && renderer !== "maplibre" && renderer !== "mapbox") {
      status.textContent = tr(
        app,
        "unsupportedRenderer",
        "Point clouds require the MapLibre or Mapbox renderer.",
      );
      return;
    }
    addSelectedButton.disabled = true;
    selectAllCheckbox.disabled = true;
    status.textContent = tr(app, "addingSelected", "Adding {{count}} tile(s) to the map…", {
      count: tiles.length,
    });
    let added = 0;
    let duplicate = 0;
    let failed = 0;
    try {
      await withLidarAutoZoomSuppressed(app, async () => {
        for (const [index, tile] of tiles.entries()) {
          if (index > 0) await sleep(ADD_SELECTED_DELAY_MS);
          if (disposed) return;
          try {
            const result = await addTileToMap(app, tile);
            if (result === "added") added++;
            else if (result === "duplicate") duplicate++;
            else failed++;
          } catch {
            failed++;
          }
        }
      });
    } catch {
      // openStandaloneLidarControl (inside withLidarAutoZoomSuppressed) can
      // reject before the per-tile loop above ever runs, e.g. if the LiDAR
      // control chunk fails to load — treat every tile as failed so the
      // status/buttons below still recover instead of getting stuck.
      failed = tiles.length;
    }
    if (disposed) return;
    selectedTileIds.clear();
    const parts: string[] = [];
    if (added > 0) {
      parts.push(
        tr(app, "addedSelectedCount", "Added {{count}} tile(s) to the map.", { count: added }),
      );
    }
    if (duplicate > 0) {
      parts.push(
        tr(app, "alreadyOnMapCountPlural", "{{count}} tile(s) were already on the map.", {
          count: duplicate,
        }),
      );
    }
    if (failed > 0) {
      parts.push(
        tr(app, "addSelectedFailedCount", "{{count}} tile(s) could not be added.", {
          count: failed,
        }),
      );
    }
    status.textContent = parts.join(" ");
    renderList();
  });

  /** Rebuilds the tile list rows from the current search results. */
  function renderList(): void {
    list.replaceChildren();
    rowCheckboxes = new Map();
    for (const tile of currentTiles) {
      const row = element("div", CSS.row);
      row.addEventListener("mouseenter", () => updateHoveredTile(tile.id));
      row.addEventListener("mouseleave", () => updateHoveredTile(null));

      const checkbox = element("input", CSS.rowCheckbox);
      checkbox.type = "checkbox";
      checkbox.disabled = !tile.downloadUrl;
      checkbox.checked = selectedTileIds.has(tile.id);
      checkbox.setAttribute(
        "aria-label",
        tr(app, "selectTile", "Select {{name}}", {
          name: tileTitle(tile),
        }),
      );
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selectedTileIds.add(tile.id);
        else selectedTileIds.delete(tile.id);
        refreshBulkToolbar();
      });
      rowCheckboxes.set(tile.id, checkbox);

      const text = element("div", CSS.rowText);
      const title = element("div", CSS.rowTitle);
      title.textContent = tileTitle(tile);
      const subtitle = element("div", CSS.rowSubtitle);
      subtitle.textContent = tileSubtitle(app, tile);
      text.append(title, subtitle);

      const addButton = element("button", CSS.small);
      addButton.type = "button";
      addButton.textContent = tr(app, "addToMap", "Add to map");
      addButton.disabled = !tile.downloadUrl;
      addButton.addEventListener("click", async () => {
        addButton.disabled = true;
        try {
          const result = await withLidarAutoZoomSuppressed(app, () => addTileToMap(app, tile));
          if (result === "added") {
            status.textContent = tr(app, "addedToMap", "Added {{name}} to the map.", {
              name: tileTitle(tile),
            });
          } else if (result === "duplicate") {
            status.textContent = tr(app, "alreadyOnMap", "{{name}} is already on the map.", {
              name: tileTitle(tile),
            });
          } else {
            status.textContent = tr(
              app,
              "unsupportedRenderer",
              "Point clouds require the MapLibre or Mapbox renderer.",
            );
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          status.textContent = tr(
            app,
            "addError",
            "Could not add {{name}} to the map: {{message}}",
            {
              name: tileTitle(tile),
              message,
            },
          );
        } finally {
          if (!disposed) addButton.disabled = !tile.downloadUrl;
        }
      });

      const downloadButton = element("button", CSS.small);
      downloadButton.type = "button";
      downloadButton.textContent = tr(app, "download", "Download");
      downloadButton.disabled = !tile.downloadUrl;
      downloadButton.addEventListener("click", () => downloadTile(app, tile));

      const actions = element("div", CSS.rowActions);
      actions.append(addButton, downloadButton);

      row.append(checkbox, text, actions);
      list.append(row);
    }
    refreshBulkToolbar();
  }

  /** Fills the coordinate inputs from the current map extent. */
  const applyViewBounds = () => {
    const bounds = app.getViewBounds?.();
    if (!bounds) {
      status.textContent = tr(app, "mapUnavailable", "The map extent is not available yet.");
      return;
    }
    bounds.forEach((value, index) => {
      coordInputs[index].value = formatNumber(value);
    });
    status.textContent = tr(app, "extentApplied", "Map extent applied.");
  };

  useView.addEventListener("click", applyViewBounds);
  applyViewBounds();

  searchButton.addEventListener("click", async () => {
    const bbox = coordInputs.map((input) =>
      input.value.trim() === "" ? Number.NaN : Number(input.value),
    ) as [number, number, number, number];
    controller?.abort();
    const requestController = new AbortController();
    controller = requestController;
    currentTiles = [];
    selectedTileIds.clear();
    renderList();
    searchButton.disabled = true;
    status.textContent = tr(app, "searching", "Searching IGN LiDAR HD tiles…");
    try {
      const result = await fetchIgnLidarHdTiles(bbox, { signal: requestController.signal });
      if (disposed) return;
      currentTiles = result.tiles;
      // renderList() calls refreshBulkToolbar() at its end, which draws the
      // footprints for the new results (selection is empty at this point).
      renderList();
      if (result.tiles.length === 0) {
        status.textContent = tr(app, "noTiles", "No LiDAR HD tiles were found in this area.");
      } else {
        status.textContent = result.truncated
          ? tr(
              app,
              "foundTruncated",
              "Showing the first {{count}} of {{matched}} tiles. Narrow the search area to see the rest.",
              { count: result.tiles.length, matched: result.matched },
            )
          : tr(app, "found", "Found {{count}} tile(s).", { count: result.tiles.length });
      }
    } catch (error) {
      if (disposed || (error instanceof DOMException && error.name === "AbortError")) return;
      const message = error instanceof Error ? error.message : String(error);
      status.textContent = tr(app, "error", "Could not search IGN LiDAR HD tiles: {{message}}", {
        message,
      });
    } finally {
      if (!disposed && controller === requestController) {
        controller = null;
        searchButton.disabled = false;
      }
    }
  });

  return () => {
    disposed = true;
    controller?.abort();
    if (refreshPanelLabels === refreshLabels) refreshPanelLabels = null;
    if (onFootprintSelect) onFootprintSelect = null;
    if (onFootprintHover) onFootprintHover = null;
    const map = getStyleMap(app);
    if (map) {
      removeHoverLayer(map);
      removeFootprintLayers(app, map);
    }
    container.replaceChildren();
  };
}

/** Mounts (or remounts) the plugin panel into its container. */
function mountPanel(container: HTMLElement, app: GeoLibreAppAPI): void {
  disposePanel?.();
  panelContainer = container;
  disposePanel = buildPanel(container, app);
}

/** Search the IGN WFS for LiDAR HD tile coverage, add tiles to
 * the map as point clouds, or download their COPC LAZ files directly from IGN. */
export const maplibreIgnLidarHdPlugin: GeoLibrePlugin = {
  id: IGN_LIDAR_HD_PLUGIN_ID,
  name: "IGN LiDAR HD Downloader",
  version: "0.1.0",
  engines: ["maplibre", "mapbox", "cesium"],
  activate: (app) => {
    unregisterPanel =
      app.registerRightPanel?.({
        id: PANEL_ID,
        title: () => tr(app, "title", "IGN LiDAR HD"),
        dock: "replace-style",
        defaultWidth: 340,
        render: (container) => {
          mountPanel(container, app);
          return () => {
            disposePanel?.();
            disposePanel = null;
            if (panelContainer === container) panelContainer = null;
          };
        },
      }) ?? null;
    unsubscribeLocale =
      app.onLocaleChange?.(() => {
        refreshPanelLabels?.();
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
    refreshPanelLabels = null;
    panelContainer = null;
    // Safety net: drop the footprint + hover overlays even if the panel's own
    // cleanup did not run (e.g. deactivated without the panel ever being
    // rendered).
    if (onFootprintSelect) onFootprintSelect = null;
    if (onFootprintHover) onFootprintHover = null;
    const map = getStyleMap(app);
    if (map) {
      removeHoverLayer(map);
      removeFootprintLayers(app, map);
    }
  },
};

export default maplibreIgnLidarHdPlugin;
