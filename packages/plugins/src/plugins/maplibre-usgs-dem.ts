/**
 * USGS 3DEP Elevation / DEM Explorer plugin (Plugins > Web Services > USGS 3DEP).
 *
 * Allows users to search, visualize footprints, download, and load digital elevation
 * models (1m DEM, 1/3 arc-second, 1 arc-second, Alaska 5m, etc.) directly from
 * USGS The National Map API services onto the GeoLibre display.
 */

import type { Feature, FeatureCollection, Polygon } from "geojson";
import type {
  GeoJSONSource,
  LngLat,
  Map as MapLibreMap,
  MapLayerMouseEvent,
  MapMouseEvent,
} from "maplibre-gl";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";
import { getControlMap } from "./style-map";
import {
  buildUsgsDemSearchUrl,
  footprintCollection,
  footprintFeature,
  get24kQuadGeometry,
  HTTP_URL_RE,
  searchUsgsDem,
  USGS_DEM_DATASETS,
  type UsgsDemFootprintProps,
  type UsgsDemItem,
  type UsgsDemSearchResult,
} from "./usgs-dem-api";

export const USGS_DEM_PLUGIN_ID = "maplibre-gl-usgs-dem";
const PANEL_ID = USGS_DEM_PLUGIN_ID;
const ATTRIBUTION =
  '<a href="https://www.usgs.gov/3dep" target="_blank" rel="noopener">USGS 3DEP Elevation</a>';

type SearchMode = "view" | "draw" | "bbox" | "quad";

const FOOTPRINT_SOURCE_ID = "geolibre-usgs-dem-footprints";
const FOOTPRINT_FILL_LAYER_ID = "geolibre-usgs-dem-footprints-fill";
const FOOTPRINT_LINE_LAYER_ID = "geolibre-usgs-dem-footprints-line";
const FOOTPRINT_STORE_LAYER_ID = "geolibre-usgs-dem-footprints-layer";

const SELECT_SOURCE_ID = "geolibre-usgs-dem-selected";
const SELECT_LINE_LAYER_ID = "geolibre-usgs-dem-selected-line";
const DRAW_SOURCE_ID = "geolibre-usgs-dem-draw";
const DRAW_FILL_LAYER_ID = "geolibre-usgs-dem-draw-fill";
const DRAW_LINE_LAYER_ID = "geolibre-usgs-dem-draw-line";

const FOOTPRINT_COLOR = "#059669"; // Emerald green for elevation
const HIGHLIGHT_COLOR = "#f59e0b"; // Amber highlight

export interface UsgsDemLabels {
  title: string;
  hint: string;
  search: string;
  searching: string;
  noResults: string;
  showing: (shown: number, total: number) => string;
  searchError: (message: string) => string;
  add: string;
  adding: string;
  download: string;
  zoom: string;
  modeView: string;
  modeDraw: string;
  modeBbox: string;
  modeQuad: string;
  drawHint: string;
  drawStart: string;
  drawCancel: string;
  drawnBox: (box: string) => string;
  coordWest: string;
  coordSouth: string;
  coordEast: string;
  coordNorth: string;
  quadName: string;
  stateName: string;
  quadSearchHint: string;
  datasets: string;
  format: string;
  filterRedundant: string;
  footprintsLayer: string;
  exportGeoJson: string;
  errorNoBounds: string;
  errorNoDrawnBox: string;
  errorInvalidCoords: string;
  errorQuadInputs: string;
  errorQuadNotFound: (quad: string, state: string) => string;
  loadError: (message: string) => string;
}

export const DEFAULT_USGS_DEM_LABELS: UsgsDemLabels = {
  title: "USGS 3DEP",
  hint: "Query and load USGS 3DEP Digital Elevation Models onto the map.",
  search: "Search DEMs",
  searching: "Searching USGS API...",
  noResults: "No elevation models found for the selected area.",
  showing: (shown, total) => `Showing ${shown} of ${total} elevation models`,
  searchError: (msg) => `Search failed: ${msg}`,
  add: "Load on Map",
  adding: "Loading...",
  download: "Download",
  zoom: "Zoom",
  modeView: "Current View",
  modeDraw: "Draw BBox",
  modeBbox: "Coordinates",
  modeQuad: "24K Quad",
  drawHint: "Click and drag on the map to draw a search bounding box.",
  drawStart: "Draw Box",
  drawCancel: "Cancel Draw",
  drawnBox: (box) => `Drawn bbox: ${box}`,
  coordWest: "West",
  coordSouth: "South",
  coordEast: "East",
  coordNorth: "North",
  quadName: "Quad Name (e.g. Mount St. Helens)",
  stateName: "State (e.g. WA)",
  quadSearchHint: "Look up a standard USGS 1:24,000 topographic quadrangle extent.",
  datasets: "Elevation Datasets",
  format: "Format",
  filterRedundant: "Exclude redundant partial tiles",
  footprintsLayer: "USGS 3DEP Footprints",
  exportGeoJson: "Export GeoJSON",
  errorNoBounds: "Could not determine current map bounds.",
  errorNoDrawnBox: "Please draw a bounding box on the map first.",
  errorInvalidCoords: "Please enter valid numeric coordinates for West, South, East, and North.",
  errorQuadInputs: "Please enter both Quad Name and State.",
  errorQuadNotFound: (quad, state) => `Could not find 24K Topo Quad '${quad}' in state '${state}'.`,
  loadError: (msg) => `Failed to load DEM: ${msg}`,
};

let currentLabels: UsgsDemLabels = { ...DEFAULT_USGS_DEM_LABELS };

export function setUsgsDemLabels(labels: Partial<UsgsDemLabels>): void {
  currentLabels = { ...currentLabels, ...labels };
  if (panelContainer) {
    disposePanel?.();
    disposePanel = mountPanel(panelContainer);
  }
}

let appRef: GeoLibreAppAPI | null = null;
let unregisterPanel: (() => void) | null = null;
let panelContainer: HTMLElement | null = null;
let disposePanel: (() => void) | null = null;
let onFootprintSelect: ((id: string) => void) | null = null;
let footprintsRegistered = false;

// Search state lives at module scope so a relabel (setUsgsDemLabels on a
// language change remounts the panel) keeps the user's results and selections.
// deactivate() resets it via resetPanelState().
const DEFAULT_DATASETS = [
  "Digital Elevation Model (DEM) 1 meter",
  "National Elevation Dataset (NED) 1/3 arc-second",
  "National Elevation Dataset (NED) 1 arc-second",
];
let mode: SearchMode = "view";
let drawnBbox: [number, number, number, number] | null = null;
let results: UsgsDemItem[] = [];
let totalFound = 0;
let selectedId: string | null = null;
const selectedDatasets = new Set<string>(DEFAULT_DATASETS);
let selectedFormat = "GeoTIFF";
let filterRedundant = true;
const inputValues = new Map<string, string>();

function resetPanelState(): void {
  mode = "view";
  drawnBbox = null;
  results = [];
  totalFound = 0;
  selectedId = null;
  selectedDatasets.clear();
  for (const name of DEFAULT_DATASETS) selectedDatasets.add(name);
  selectedFormat = "GeoTIFF";
  filterRedundant = true;
  inputValues.clear();
}

function normalizeLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

function currentBbox(): [number, number, number, number] | null {
  const map = getControlMap(appRef);
  if (!map) return null;
  const bounds = map.getBounds();
  const clampLat = (n: number): number => Math.max(-90, Math.min(90, n));
  let west = normalizeLon(bounds.getWest());
  let east = normalizeLon(bounds.getEast());
  if (bounds.getEast() - bounds.getWest() >= 360 || west > east) {
    west = -180;
    east = 180;
  }
  return [west, clampLat(bounds.getSouth()), east, clampLat(bounds.getNorth())];
}

function formatBbox(bbox: [number, number, number, number]): string {
  return bbox.map((n) => n.toFixed(3)).join(", ");
}

function emptyFeatureCollection(): FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

function ensureFootprintLayers(map: MapLibreMap): void {
  if (!map.getSource(FOOTPRINT_SOURCE_ID)) {
    map.addSource(FOOTPRINT_SOURCE_ID, {
      type: "geojson",
      data: emptyFeatureCollection(),
    });
  }
  if (!map.getLayer(FOOTPRINT_FILL_LAYER_ID)) {
    map.addLayer({
      id: FOOTPRINT_FILL_LAYER_ID,
      type: "fill",
      source: FOOTPRINT_SOURCE_ID,
      paint: {
        "fill-color": FOOTPRINT_COLOR,
        "fill-opacity": 0.15,
      },
    });
  }
  if (!map.getLayer(FOOTPRINT_LINE_LAYER_ID)) {
    map.addLayer({
      id: FOOTPRINT_LINE_LAYER_ID,
      type: "line",
      source: FOOTPRINT_SOURCE_ID,
      paint: {
        "line-color": FOOTPRINT_COLOR,
        "line-width": 1.5,
        "line-opacity": 0.8,
      },
    });
  }

  if (!map.getSource(SELECT_SOURCE_ID)) {
    map.addSource(SELECT_SOURCE_ID, {
      type: "geojson",
      data: emptyFeatureCollection(),
    });
  }
  if (!map.getLayer(SELECT_LINE_LAYER_ID)) {
    map.addLayer({
      id: SELECT_LINE_LAYER_ID,
      type: "line",
      source: SELECT_SOURCE_ID,
      paint: {
        "line-color": HIGHLIGHT_COLOR,
        "line-width": 3,
        "line-opacity": 1,
      },
    });
  }

  if (!map.getSource(DRAW_SOURCE_ID)) {
    map.addSource(DRAW_SOURCE_ID, {
      type: "geojson",
      data: emptyFeatureCollection(),
    });
  }
  if (!map.getLayer(DRAW_FILL_LAYER_ID)) {
    map.addLayer({
      id: DRAW_FILL_LAYER_ID,
      type: "fill",
      source: DRAW_SOURCE_ID,
      paint: {
        "fill-color": HIGHLIGHT_COLOR,
        "fill-opacity": 0.2,
      },
    });
  }
  if (!map.getLayer(DRAW_LINE_LAYER_ID)) {
    map.addLayer({
      id: DRAW_LINE_LAYER_ID,
      type: "line",
      source: DRAW_SOURCE_ID,
      paint: {
        "line-color": HIGHLIGHT_COLOR,
        "line-width": 2,
        "line-dasharray": [2, 2],
      },
    });
  }
}

function removeFootprintLayers(map: MapLibreMap): void {
  for (const layerId of [
    DRAW_LINE_LAYER_ID,
    DRAW_FILL_LAYER_ID,
    SELECT_LINE_LAYER_ID,
    FOOTPRINT_LINE_LAYER_ID,
    FOOTPRINT_FILL_LAYER_ID,
  ]) {
    if (map.getLayer(layerId)) map.removeLayer(layerId);
  }
  for (const sourceId of [DRAW_SOURCE_ID, SELECT_SOURCE_ID, FOOTPRINT_SOURCE_ID]) {
    if (map.getSource(sourceId)) map.removeSource(sourceId);
  }
}

function updateFootprintSource(
  map: MapLibreMap,
  fc: FeatureCollection<Polygon, UsgsDemFootprintProps>,
): void {
  ensureFootprintLayers(map);
  const source = map.getSource(FOOTPRINT_SOURCE_ID) as GeoJSONSource | undefined;
  if (source) {
    void source.setData(fc);
  }

  // Re-register on every non-empty search so the store layer's geojson tracks
  // the current result set (the Layers panel, attribute table, and exports read it).
  if (appRef?.registerExternalNativeLayer && fc.features.length > 0) {
    appRef.registerExternalNativeLayer({
      id: FOOTPRINT_STORE_LAYER_ID,
      name: currentLabels.footprintsLayer,
      type: "geojson",
      geojson: fc as FeatureCollection,
      nativeLayerIds: [FOOTPRINT_FILL_LAYER_ID, FOOTPRINT_LINE_LAYER_ID],
      sourceIds: [FOOTPRINT_SOURCE_ID],
      metadata: { sourceKind: "usgs-dem-footprints", externalNativeLayer: true },
      // Seed the store style from the native paint on the first registration
      // only, so a re-search keeps the user's Style panel edits. The ArcGIS and
      // Cesium engines draw the footprints from this style, and Mapbox mirrors
      // it onto the native layers, so without it they paint the default fill.
      ...(footprintsRegistered
        ? {}
        : {
            opacity: 1,
            style: {
              fillColor: FOOTPRINT_COLOR,
              fillOpacity: 0.15,
              strokeColor: FOOTPRINT_COLOR,
              strokeWidth: 1.5,
            },
          }),
    });
    footprintsRegistered = true;
  } else if (footprintsRegistered && fc.features.length === 0) {
    // An empty search clears the map source, so drop the Layers-panel entry too.
    footprintsRegistered = false;
    appRef?.unregisterExternalNativeLayer?.(FOOTPRINT_STORE_LAYER_ID);
  }
}

function setSelectedFootprint(map: MapLibreMap, item: UsgsDemItem | null): void {
  ensureFootprintLayers(map);
  const source = map.getSource(SELECT_SOURCE_ID) as GeoJSONSource | undefined;
  if (!source) return;
  if (!item) {
    void source.setData(emptyFeatureCollection());
    return;
  }
  const feat = footprintFeature(item);
  void source.setData(
    feat ? { type: "FeatureCollection", features: [feat] } : emptyFeatureCollection(),
  );
}

function downloadDemItem(item: UsgsDemItem): void {
  if (!HTTP_URL_RE.test(item.downloadUrl)) return;
  const link = document.createElement("a");
  link.href = item.downloadUrl;
  const filename = item.downloadUrl.split("/").pop() || `${item.title}.tif`;
  link.download = filename;
  link.target = "_blank";
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function exportFootprintsAsGeoJson(items: UsgsDemItem[]): void {
  const fc = footprintCollection(items);
  const blob = new Blob([JSON.stringify(fc, null, 2)], { type: "application/geo+json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "usgs-dem-footprints.geojson";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function mountPanel(container: HTMLElement): () => void {
  container.innerHTML = "";
  container.className = "geolibre-usgs-dem-panel";
  container.style.cssText =
    "display:flex;flex-direction:column;gap:8px;padding:12px;height:100%;box-sizing:border-box;font-family:inherit;font-size:12px;color:hsl(var(--foreground));overflow-y:auto;";

  // Per-mount state (search state is module-level, above)
  let isDrawing = false;
  let isLoading = false;
  let activeAddId: string | null = null;
  // Set when this panel instance is torn down (a label change remounts it), so
  // an in-flight search neither paints stale footprints nor writes to detached DOM.
  let disposed = false;
  let searchAbort: AbortController | null = null;

  // Header
  const header = document.createElement("div");
  header.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;";
  const title = document.createElement("h3");
  title.style.cssText = "margin:0;font-size:14px;font-weight:600;";
  title.textContent = currentLabels.title;
  header.appendChild(title);
  container.appendChild(header);

  // Hint
  const hint = document.createElement("div");
  hint.style.cssText = "font-size:11px;color:hsl(var(--muted-foreground));line-height:1.4;";
  hint.textContent = currentLabels.hint;
  container.appendChild(hint);

  // Mode tabs
  const modeBar = document.createElement("div");
  modeBar.style.cssText =
    "display:grid;grid-template-columns:repeat(4,1fr);gap:4px;background:hsl(var(--muted));padding:2px;border-radius:6px;";

  const modes: { id: SearchMode; label: string }[] = [
    { id: "view", label: currentLabels.modeView },
    { id: "draw", label: currentLabels.modeDraw },
    { id: "bbox", label: currentLabels.modeBbox },
    { id: "quad", label: currentLabels.modeQuad },
  ];

  const modeButtons = new Map<SearchMode, HTMLButtonElement>();

  modes.forEach((m) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = m.label;
    btn.style.cssText =
      "padding:4px 2px;font-size:11px;border-radius:4px;border:none;background:transparent;cursor:pointer;color:inherit;text-align:center;font-weight:500;";
    btn.onclick = () => {
      setMode(m.id);
    };
    modeButtons.set(m.id, btn);
    modeBar.appendChild(btn);
  });
  container.appendChild(modeBar);

  // Mode Options Area
  const modeContainer = document.createElement("div");
  modeContainer.style.cssText = "display:flex;flex-direction:column;gap:6px;";
  container.appendChild(modeContainer);

  // Manual Bbox inputs
  const bboxInputs = document.createElement("div");
  bboxInputs.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:4px;";
  const westIn = createInput(currentLabels.coordWest, "-122.5", "west");
  const southIn = createInput(currentLabels.coordSouth, "46.1", "south");
  const eastIn = createInput(currentLabels.coordEast, "-122.1", "east");
  const northIn = createInput(currentLabels.coordNorth, "46.3", "north");
  bboxInputs.appendChild(westIn.wrapper);
  bboxInputs.appendChild(southIn.wrapper);
  bboxInputs.appendChild(eastIn.wrapper);
  bboxInputs.appendChild(northIn.wrapper);

  // 24K Quad inputs
  const quadInputs = document.createElement("div");
  quadInputs.style.cssText = "display:flex;flex-direction:column;gap:4px;";
  const quadIn = createInput(currentLabels.quadName, "Mount St. Helens", "quad");
  const stateIn = createInput(currentLabels.stateName, "WA", "state");
  quadInputs.appendChild(quadIn.wrapper);
  quadInputs.appendChild(stateIn.wrapper);

  // Draw controls
  const drawControls = document.createElement("div");
  drawControls.style.cssText = "display:flex;flex-direction:column;gap:4px;";
  const drawBtn = document.createElement("button");
  drawBtn.type = "button";
  drawBtn.style.cssText =
    "padding:6px;border-radius:4px;border:1px solid hsl(var(--border));background:hsl(var(--background));cursor:pointer;font-size:11px;font-weight:500;";
  drawBtn.textContent = currentLabels.drawStart;
  const drawStatus = document.createElement("div");
  drawStatus.style.cssText = "font-size:10px;color:hsl(var(--muted-foreground));";
  drawStatus.textContent = drawnBbox
    ? currentLabels.drawnBox(formatBbox(drawnBbox))
    : currentLabels.drawHint;
  drawControls.appendChild(drawBtn);
  drawControls.appendChild(drawStatus);

  // Dataset accordion / checklist
  const datasetSection = document.createElement("details");
  datasetSection.style.cssText =
    "border:1px solid hsl(var(--border));border-radius:6px;padding:6px;background:hsl(var(--card));";
  const datasetSummary = document.createElement("summary");
  datasetSummary.style.cssText = "cursor:pointer;font-weight:600;font-size:11px;";
  datasetSummary.textContent = `${currentLabels.datasets} (${selectedDatasets.size})`;
  datasetSection.appendChild(datasetSummary);

  const datasetList = document.createElement("div");
  datasetList.style.cssText =
    "display:flex;flex-direction:column;gap:4px;margin-top:6px;max-height:140px;overflow-y:auto;";
  USGS_DEM_DATASETS.forEach((ds) => {
    const label = document.createElement("label");
    label.style.cssText =
      "display:flex;align-items:flex-start;gap:6px;font-size:11px;cursor:pointer;";
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = selectedDatasets.has(ds.name);
    check.onchange = () => {
      if (check.checked) {
        selectedDatasets.add(ds.name);
      } else {
        selectedDatasets.delete(ds.name);
      }
      datasetSummary.textContent = `${currentLabels.datasets} (${selectedDatasets.size})`;
    };
    const span = document.createElement("span");
    span.innerHTML = `<strong>${ds.name}</strong> <span style="color:hsl(var(--muted-foreground));">(${ds.resolution})</span>`;
    label.appendChild(check);
    label.appendChild(span);
    datasetList.appendChild(label);
  });
  datasetSection.appendChild(datasetList);
  container.appendChild(datasetSection);

  // Filter options (Format + Deduplication)
  const filterRow = document.createElement("div");
  filterRow.style.cssText =
    "display:flex;gap:8px;align-items:center;justify-content:space-between;";
  const formatSelect = document.createElement("select");
  formatSelect.style.cssText =
    "padding:4px 6px;border-radius:4px;border:1px solid hsl(var(--border));background:hsl(var(--background));font-size:11px;";
  ["GeoTIFF", "IMG", "All"].forEach((fmt) => {
    const opt = document.createElement("option");
    opt.value = fmt;
    opt.textContent = fmt;
    opt.selected = fmt === selectedFormat;
    formatSelect.appendChild(opt);
  });
  formatSelect.onchange = () => {
    selectedFormat = formatSelect.value;
  };

  const dedupLabel = document.createElement("label");
  dedupLabel.style.cssText =
    "display:flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;";
  const dedupCheck = document.createElement("input");
  dedupCheck.type = "checkbox";
  dedupCheck.checked = filterRedundant;
  dedupCheck.onchange = () => {
    filterRedundant = dedupCheck.checked;
  };
  dedupLabel.appendChild(dedupCheck);
  dedupLabel.appendChild(document.createTextNode(currentLabels.filterRedundant));

  filterRow.appendChild(formatSelect);
  filterRow.appendChild(dedupLabel);
  container.appendChild(filterRow);

  // Search Action Button
  const searchBtn = document.createElement("button");
  searchBtn.type = "button";
  searchBtn.style.cssText =
    "padding:8px 12px;border-radius:6px;border:none;background:hsl(var(--primary));color:hsl(var(--primary-foreground));font-weight:600;font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;";
  searchBtn.textContent = currentLabels.search;
  container.appendChild(searchBtn);

  // Results Status / Toolbar
  const resultHeader = document.createElement("div");
  resultHeader.style.cssText = "display:flex;justify-content:space-between;align-items:center;";
  const resultStatus = document.createElement("div");
  resultStatus.style.cssText = "font-size:11px;color:hsl(var(--muted-foreground));";
  const exportBtn = document.createElement("button");
  exportBtn.type = "button";
  exportBtn.style.cssText =
    "padding:2px 6px;border-radius:4px;border:1px solid hsl(var(--border));background:transparent;font-size:10px;cursor:pointer;display:none;";
  exportBtn.textContent = currentLabels.exportGeoJson;
  exportBtn.onclick = () => exportFootprintsAsGeoJson(results);
  resultHeader.appendChild(resultStatus);
  resultHeader.appendChild(exportBtn);
  container.appendChild(resultHeader);

  // Results List
  const resultsList = document.createElement("div");
  resultsList.style.cssText =
    "display:flex;flex-direction:column;gap:6px;flex:1 1 auto;overflow-y:auto;";
  container.appendChild(resultsList);

  function setMode(newMode: SearchMode) {
    // Leaving Draw hides its Cancel button, so end any draw in progress here.
    if (newMode !== "draw" && isDrawing) stopDrawing();
    mode = newMode;
    modeButtons.forEach((btn, id) => {
      if (id === mode) {
        btn.style.background = "hsl(var(--background))";
        btn.style.boxShadow = "0 1px 2px rgba(0,0,0,0.1)";
      } else {
        btn.style.background = "transparent";
        btn.style.boxShadow = "none";
      }
    });

    modeContainer.innerHTML = "";
    if (mode === "bbox") {
      modeContainer.appendChild(bboxInputs);
    } else if (mode === "quad") {
      modeContainer.appendChild(quadInputs);
    } else if (mode === "draw") {
      modeContainer.appendChild(drawControls);
    }
  }

  // Draw Bounding Box interaction on map
  let drawStart: LngLat | null = null;

  function onMapMouseDown(e: MapMouseEvent) {
    if (!isDrawing || mode !== "draw") return;
    const map = getControlMap(appRef);
    if (!map) return;
    e.preventDefault();
    drawStart = e.lngLat;
    map.dragPan.disable();
  }

  function onMapMouseMove(e: MapMouseEvent) {
    if (!isDrawing || !drawStart || mode !== "draw") return;
    const map = getControlMap(appRef);
    if (!map) return;
    const current = e.lngLat;
    const w = Math.min(drawStart.lng, current.lng);
    const e_lng = Math.max(drawStart.lng, current.lng);
    const s = Math.min(drawStart.lat, current.lat);
    const n = Math.max(drawStart.lat, current.lat);
    const box: [number, number, number, number] = [w, s, e_lng, n];
    updateDrawBox(map, box);
  }

  function onMapMouseUp(e: MapMouseEvent) {
    if (!isDrawing || !drawStart || mode !== "draw") return;
    const map = getControlMap(appRef);
    if (!map) return;
    const current = e.lngLat;
    const w = Math.min(drawStart.lng, current.lng);
    const e_lng = Math.max(drawStart.lng, current.lng);
    const s = Math.min(drawStart.lat, current.lat);
    const n = Math.max(drawStart.lat, current.lat);
    drawStart = null;
    map.dragPan.enable();
    drawnBbox = [w, s, e_lng, n];
    drawStatus.textContent = currentLabels.drawnBox(formatBbox(drawnBbox));
    stopDrawing();
  }

  function updateDrawBox(map: MapLibreMap, box: [number, number, number, number] | null) {
    ensureFootprintLayers(map);
    const src = map.getSource(DRAW_SOURCE_ID) as GeoJSONSource | undefined;
    if (!src) return;
    if (!box) {
      void src.setData(emptyFeatureCollection());
      return;
    }
    const [w, s, e, n] = box;
    const feat: Feature<Polygon> = {
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
    };
    void src.setData({ type: "FeatureCollection", features: [feat] });
  }

  function startDrawing() {
    isDrawing = true;
    drawBtn.textContent = currentLabels.drawCancel;
    drawStatus.textContent = currentLabels.drawHint;
    const map = getControlMap(appRef);
    if (map) {
      map.getCanvas().style.cursor = "crosshair";
      map.on("mousedown", onMapMouseDown);
      map.on("mousemove", onMapMouseMove);
      map.on("mouseup", onMapMouseUp);
    }
  }

  function stopDrawing() {
    isDrawing = false;
    drawStart = null;
    drawBtn.textContent = currentLabels.drawStart;
    const map = getControlMap(appRef);
    if (map) {
      map.getCanvas().style.cursor = "";
      map.dragPan.enable();
      map.off("mousedown", onMapMouseDown);
      map.off("mousemove", onMapMouseMove);
      map.off("mouseup", onMapMouseUp);
    }
  }

  drawBtn.onclick = () => {
    if (isDrawing) {
      stopDrawing();
    } else {
      startDrawing();
    }
  };

  // Footprint selection binding
  onFootprintSelect = (id: string) => {
    const item = results.find((r) => r.id === id);
    if (item) {
      selectedId = item.id;
      const map = getControlMap(appRef);
      if (map) setSelectedFootprint(map, item);
      renderResults();
      const el = document.getElementById(`usgs-dem-card-${item.id}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  };

  async function performSearch() {
    if (isLoading) return;
    isLoading = true;
    const abort = new AbortController();
    searchAbort = abort;
    searchBtn.disabled = true;
    searchBtn.textContent = currentLabels.searching;
    resultStatus.textContent = currentLabels.searching;
    resultsList.innerHTML = "";

    try {
      let queryBbox: [number, number, number, number] | undefined;

      if (mode === "view") {
        const b = currentBbox();
        if (!b) throw new Error(currentLabels.errorNoBounds);
        queryBbox = b;
      } else if (mode === "draw") {
        if (!drawnBbox) {
          throw new Error(currentLabels.errorNoDrawnBox);
        }
        queryBbox = drawnBbox;
      } else if (mode === "bbox") {
        const w = parseFloat(westIn.input.value);
        const s = parseFloat(southIn.input.value);
        const e = parseFloat(eastIn.input.value);
        const n = parseFloat(northIn.input.value);
        if (
          !Number.isFinite(w) ||
          !Number.isFinite(s) ||
          !Number.isFinite(e) ||
          !Number.isFinite(n)
        ) {
          throw new Error(currentLabels.errorInvalidCoords);
        }
        queryBbox = [w, s, e, n];
      } else if (mode === "quad") {
        const qName = quadIn.input.value.trim();
        const sName = stateIn.input.value.trim();
        if (!qName || !sName) {
          throw new Error(currentLabels.errorQuadInputs);
        }
        const quadGeom = await get24kQuadGeometry(qName, sName);
        if (disposed) return;
        if (!quadGeom) {
          throw new Error(currentLabels.errorQuadNotFound(qName, sName));
        }
        queryBbox = quadGeom.bbox;
        const map = getControlMap(appRef);
        if (map && queryBbox) {
          map.fitBounds(
            [
              [queryBbox[0], queryBbox[1]],
              [queryBbox[2], queryBbox[3]],
            ],
            { padding: 40 },
          );
        }
      }

      const datasets = Array.from(selectedDatasets);
      const prodFormats = selectedFormat === "All" ? [] : [selectedFormat];

      const res = await searchUsgsDem({
        bbox: queryBbox,
        datasets,
        prodFormats,
        max: 100,
        filterRedundant,
        signal: abort.signal,
      });
      if (disposed) return;

      results = res.items;
      totalFound = res.total;

      const map = getControlMap(appRef);
      if (map) {
        const fc = footprintCollection(results);
        updateFootprintSource(map, fc);
      }

      renderResults();
    } catch (err) {
      if (disposed) return;
      const message = err instanceof Error ? err.message : String(err);
      // Drop the previous results so the list, Export button, and footprints
      // don't keep showing a search the user just replaced.
      results = [];
      totalFound = 0;
      selectedId = null;
      const map = getControlMap(appRef);
      if (map) {
        updateFootprintSource(map, footprintCollection([]));
        setSelectedFootprint(map, null);
      }
      renderResults();
      resultStatus.textContent = currentLabels.searchError(message);
    } finally {
      if (searchAbort === abort) searchAbort = null;
      isLoading = false;
      searchBtn.disabled = false;
      searchBtn.textContent = currentLabels.search;
    }
  }

  searchBtn.onclick = performSearch;

  function renderResults() {
    resultsList.innerHTML = "";
    if (results.length === 0) {
      resultStatus.textContent = currentLabels.noResults;
      exportBtn.style.display = "none";
      return;
    }

    resultStatus.textContent = currentLabels.showing(results.length, totalFound);
    exportBtn.style.display = "block";

    results.forEach((item) => {
      const card = document.createElement("div");
      card.id = `usgs-dem-card-${item.id}`;
      const isSelected = selectedId === item.id;
      card.style.cssText = `display:flex;flex-direction:column;gap:4px;padding:8px;border-radius:6px;border:1px solid ${
        isSelected ? "hsl(var(--primary))" : "hsl(var(--border))"
      };background:hsl(var(--card));transition:border-color 0.15s;`;

      card.onclick = (e) => {
        if ((e.target as HTMLElement).tagName === "BUTTON") return;
        selectedId = item.id;
        const map = getControlMap(appRef);
        if (map) setSelectedFootprint(map, item);
        renderResults();
      };

      // Header row
      const top = document.createElement("div");
      top.style.cssText =
        "display:flex;justify-content:space-between;align-items:flex-start;gap:4px;";
      const name = document.createElement("div");
      name.style.cssText = "font-weight:600;font-size:11px;line-height:1.3;word-break:break-word;";
      name.textContent = item.title;
      top.appendChild(name);
      card.appendChild(top);

      // Meta specs
      const meta = document.createElement("div");
      meta.style.cssText =
        "font-size:10px;color:hsl(var(--muted-foreground));display:flex;flex-direction:column;gap:2px;";
      const sizeStr = item.prettyFileSize ? ` · ${item.prettyFileSize}` : "";
      const dateStr = item.publicationDate ? ` · ${item.publicationDate.split("T")[0]}` : "";
      meta.textContent = `${item.dataset} (${item.format})${sizeStr}${dateStr}`;
      card.appendChild(meta);

      // Actions row
      const actions = document.createElement("div");
      actions.style.cssText = "display:flex;gap:4px;margin-top:4px;flex-wrap:wrap;";

      // Load on Map / Add to Map button
      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.style.cssText =
        "padding:3px 8px;border-radius:4px;border:none;background:hsl(var(--primary));color:hsl(var(--primary-foreground));font-size:11px;font-weight:500;cursor:pointer;";
      const isAddingThis = activeAddId === item.id;
      // Only HTTP(S) GeoTIFFs can stream onto the map; other formats (IMG) are
      // download-only.
      const canLoad = HTTP_URL_RE.test(item.downloadUrl) && /tiff?$/i.test(item.format);
      addBtn.textContent = isAddingThis ? currentLabels.adding : currentLabels.add;
      addBtn.disabled = isAddingThis || !canLoad;
      if (!canLoad) addBtn.style.opacity = "0.5";

      addBtn.onclick = async () => {
        if (!appRef || !canLoad) return;
        activeAddId = item.id;
        addBtn.disabled = true;
        addBtn.textContent = currentLabels.adding;
        try {
          if (appRef.addCogLayer) {
            await appRef.addCogLayer(item.title, item.downloadUrl);
          } else {
            const { addRasterToMap } = await import("./maplibre-raster");
            await addRasterToMap(appRef, item.downloadUrl, { name: item.title });
          }
        } catch (err) {
          console.error("Failed to add USGS DEM layer:", err);
          const message = err instanceof Error ? err.message : String(err);
          resultStatus.textContent = currentLabels.loadError(message);
        } finally {
          activeAddId = null;
          addBtn.disabled = false;
          addBtn.textContent = currentLabels.add;
        }
      };
      actions.appendChild(addBtn);

      // Download button
      const dlBtn = document.createElement("button");
      dlBtn.type = "button";
      dlBtn.style.cssText =
        "padding:3px 8px;border-radius:4px;border:1px solid hsl(var(--border));background:transparent;color:hsl(var(--foreground));font-size:11px;cursor:pointer;";
      dlBtn.textContent = currentLabels.download;
      dlBtn.onclick = () => downloadDemItem(item);
      actions.appendChild(dlBtn);

      // Zoom to BBox button
      const zoomBtn = document.createElement("button");
      zoomBtn.type = "button";
      zoomBtn.style.cssText =
        "padding:3px 8px;border-radius:4px;border:1px solid hsl(var(--border));background:transparent;color:hsl(var(--foreground));font-size:11px;cursor:pointer;";
      zoomBtn.textContent = currentLabels.zoom;
      zoomBtn.onclick = () => {
        const map = getControlMap(appRef);
        if (map && item.bbox) {
          map.fitBounds(
            [
              [item.bbox[0], item.bbox[1]],
              [item.bbox[2], item.bbox[3]],
            ],
            { padding: 40 },
          );
        }
      };
      actions.appendChild(zoomBtn);

      card.appendChild(actions);
      resultsList.appendChild(card);
    });
  }

  setMode(mode);
  if (results.length > 0) renderResults();

  return () => {
    disposed = true;
    searchAbort?.abort();
    if (isDrawing) stopDrawing();
    onFootprintSelect = null;
  };
}

function createInput(
  label: string,
  placeholder: string,
  key: string,
): { wrapper: HTMLElement; input: HTMLInputElement } {
  const wrapper = document.createElement("div");
  wrapper.style.cssText = "display:flex;flex-direction:column;gap:2px;";
  const lbl = document.createElement("label");
  lbl.style.cssText = "font-size:10px;color:hsl(var(--muted-foreground));";
  lbl.textContent = label;
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = placeholder;
  input.value = inputValues.get(key) ?? "";
  input.oninput = () => inputValues.set(key, input.value);
  input.style.cssText =
    "padding:4px 6px;border-radius:4px;border:1px solid hsl(var(--border));background:hsl(var(--background));color:hsl(var(--foreground));font-size:11px;box-sizing:border-box;";
  wrapper.appendChild(lbl);
  wrapper.appendChild(input);
  return { wrapper, input };
}

function onMapClick(e: MapLayerMouseEvent): void {
  if (!e.features || e.features.length === 0) return;
  const feat = e.features[0];
  const id = feat?.properties?.id;
  if (id && onFootprintSelect) {
    onFootprintSelect(String(id));
  }
}

function onMapMouseEnter(e: MapLayerMouseEvent): void {
  const map = getControlMap(appRef);
  if (map) map.getCanvas().style.cursor = "pointer";
}

function onMapMouseLeave(e: MapLayerMouseEvent): void {
  const map = getControlMap(appRef);
  if (map) map.getCanvas().style.cursor = "";
}

/**
 * GeoLibre USGS 3DEP DEM Plugin definition.
 */
export const maplibreUsgsDemPlugin: GeoLibrePlugin = {
  id: USGS_DEM_PLUGIN_ID,
  name: "USGS 3DEP",
  version: "1.0.0",
  // The footprints, selection outline and drawn box are GeoJSON Style Spec
  // layers, and a loaded DEM is a store COG layer, so every engine hosts it:
  // the 2D engines draw the overlays directly, and the ArcGIS and Cesium
  // control maps record them for the engine to draw.
  engines: ["maplibre", "mapbox", "arcgis", "cesium"],

  activate(app: GeoLibreAppAPI) {
    appRef = app;
    const map = getControlMap(app);

    if (map) {
      ensureFootprintLayers(map);
      map.on("click", FOOTPRINT_FILL_LAYER_ID, onMapClick);
      map.on("mouseenter", FOOTPRINT_FILL_LAYER_ID, onMapMouseEnter);
      map.on("mouseleave", FOOTPRINT_FILL_LAYER_ID, onMapMouseLeave);
    }

    unregisterPanel =
      app.registerRightPanel?.({
        id: PANEL_ID,
        title: () => currentLabels.title,
        dock: "replace-style",
        defaultWidth: 340,
        deactivatePluginOnClose: true,
        render: (container) => {
          disposePanel?.();
          panelContainer = container;
          disposePanel = mountPanel(container);
          return () => {
            disposePanel?.();
            disposePanel = null;
            if (panelContainer === container) panelContainer = null;
          };
        },
      }) ?? null;

    app.openRightPanel?.(PANEL_ID);
  },

  deactivate(app: GeoLibreAppAPI) {
    app.closeRightPanel?.(PANEL_ID);
    unregisterPanel?.();
    unregisterPanel = null;
    disposePanel?.();
    disposePanel = null;
    panelContainer = null;

    const map = getControlMap(app);
    if (map) {
      map.off("click", FOOTPRINT_FILL_LAYER_ID, onMapClick);
      map.off("mouseenter", FOOTPRINT_FILL_LAYER_ID, onMapMouseEnter);
      map.off("mouseleave", FOOTPRINT_FILL_LAYER_ID, onMapMouseLeave);
      removeFootprintLayers(map);
    }
    if (footprintsRegistered && app.unregisterExternalNativeLayer) {
      app.unregisterExternalNativeLayer(FOOTPRINT_STORE_LAYER_ID);
      footprintsRegistered = false;
    }
    resetPanelState();
    appRef = null;
  },
};
