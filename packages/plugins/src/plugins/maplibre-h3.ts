import type { Feature, FeatureCollection, Polygon } from "geojson";
import {
  cellToBoundary,
  cellToChildren,
  cellToLatLng,
  cellToParent,
  getBaseCellNumber,
  getHexagonAreaAvg,
  getResolution,
  gridDisk,
  isPentagon,
  latLngToCell,
  polygonToCells,
} from "h3-js";
import type { GeoJSONSource, Map as MapLibreMap, MapMouseEvent } from "maplibre-gl";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

/**
 * The icosahedron H3 projects onto, as densified great-circle edge lines.
 * Fetched by MapLibre when the layer is first added; the Tauri CSP's blanket
 * `https:` connect-src already allows the host. Offline, the overlay simply
 * stays empty.
 */
const ICOSAHEDRON_GEOJSON_URL =
  "https://raw.githubusercontent.com/opengeoshub/vgrid-maplibre/main/H3/icosahedron.geojson";

export const H3_PLUGIN_ID = "maplibre-h3-grid";

const PANEL_ID = "geolibre-h3-panel";
const SOURCE_ID = "geolibre-h3-grid-source";
const FILL_LAYER_ID = "geolibre-h3-grid-fill";
const LINE_LAYER_ID = "geolibre-h3-grid-line";
const LABEL_LAYER_ID = "geolibre-h3-grid-label";
const SELECTED_SOURCE_ID = "geolibre-h3-selected-source";
const SELECTED_FILL_LAYER_ID = "geolibre-h3-selected-fill";
const SELECTED_LINE_LAYER_ID = "geolibre-h3-selected-line";
const PARENTS_SOURCE_ID = "geolibre-h3-parents-source";
const PARENTS_LINE_LAYER_ID = "geolibre-h3-parents-line";
const ICOSAHEDRON_SOURCE_ID = "geolibre-h3-icosahedron-source";
const ICOSAHEDRON_LINE_LAYER_ID = "geolibre-h3-icosahedron-line";

const SELECTED_LINE_WIDTH = 3;

/** Prevent a fine resolution over a large viewport from freezing the browser. */
export const H3_VIEWPORT_CELL_LIMIT = 20_000;

export interface H3GridSettings {
  /** Derive the resolution from the map zoom instead of the manual slider. */
  autoResolution: boolean;
  resolution: number;
  fillColor: string;
  fillOpacity: number;
  lineColor: string;
  lineWidth: number;
  showLabels: boolean;
  includeNeighbors: boolean;
  includeParents: boolean;
  showIcosahedron: boolean;
}

export const DEFAULT_H3_GRID_SETTINGS: H3GridSettings = {
  autoResolution: true,
  // Useful immediately at GeoLibre's default world view (resolution 3 would
  // already exceed the viewport safety cap).
  resolution: 2,
  fillColor: "#2563eb",
  fillOpacity: 0.08,
  lineColor: "#2563eb",
  lineWidth: 1,
  showLabels: true,
  includeNeighbors: false,
  includeParents: false,
  showIcosahedron: false,
};

export interface H3Labels {
  title: string;
  getTitle?: () => string;
  controlTitle: string;
  autoResolution: string;
  resolution: string;
  cellCount: (count: number) => string;
  tooManyCells: (limit: number) => string;
  fillColor: string;
  fillOpacity: string;
  lineColor: string;
  lineWidth: string;
  showLabels: string;
  identifyHint: string;
  selectedCell: string;
  noSelection: string;
  copyId: string;
  copied: string;
  parent: string;
  children: string;
  neighbors: string;
  baseCell: string;
  center: string;
  pentagon: string;
  yes: string;
  no: string;
  zoomToCell: string;
  addAsLayer: string;
  exportGeoJson: string;
  exportCsv: string;
  includeNeighbors: string;
  includeParents: string;
  showIcosahedron: string;
}

export const DEFAULT_H3_LABELS: H3Labels = {
  title: "H3 Grid",
  controlTitle: "H3 grid settings",
  autoResolution: "Automatic resolution",
  resolution: "Resolution",
  cellCount: (count) => `${count.toLocaleString()} cells in view`,
  tooManyCells: (limit) =>
    `This view exceeds the ${limit.toLocaleString()} cell limit. Zoom in or lower the resolution.`,
  fillColor: "Fill color",
  fillOpacity: "Fill opacity",
  lineColor: "Outline color",
  lineWidth: "Outline width",
  showLabels: "Show cell IDs",
  identifyHint: "Click the map to identify an H3 cell.",
  selectedCell: "Selected cell",
  noSelection: "No cell selected",
  copyId: "Copy ID",
  copied: "Copied",
  parent: "Parent(s)",
  children: "Children",
  neighbors: "Neighbors",
  baseCell: "Base cell",
  center: "Center",
  pentagon: "Pentagon",
  yes: "Yes",
  no: "No",
  zoomToCell: "Zoom to cell",
  addAsLayer: "Add grid as layer",
  exportGeoJson: "Export GeoJSON",
  exportCsv: "Export CSV",
  includeNeighbors: "Include selected cell neighbors",
  includeParents: "Include selected cell parent(s)",
  showIcosahedron: "Show icosahedron",
};

let labels: H3Labels = { ...DEFAULT_H3_LABELS };
let settings: H3GridSettings = { ...DEFAULT_H3_GRID_SETTINGS };
let map: MapLibreMap | null = null;
let appRef: GeoLibreAppAPI | null = null;
let unregisterPanel: (() => void) | null = null;
let moveHandler: (() => void) | null = null;
let clickHandler: ((event: MapMouseEvent) => void) | null = null;
let unsubscribeBasemap: (() => void) | null = null;
let panelContainer: HTMLElement | null = null;
let selectedCell: string | null = null;

let currentGrid: FeatureCollection<Polygon> = { type: "FeatureCollection", features: [] };
let currentError: string | null = null;
let cachedTextFont: string[] | null = null;
let pendingRefresh: number | null = null;

/**
 * Coalesce viewport-driven rebuilds. Inertial pans emit `moveend` in bursts,
 * and each rebuild walks up to H3_VIEWPORT_CELL_LIMIT cells on the main thread.
 */
function scheduleRefresh(): void {
  if (pendingRefresh !== null) return;
  pendingRefresh = requestAnimationFrame(() => {
    pendingRefresh = null;
    refresh();
  });
}

function cancelScheduledRefresh(): void {
  if (pendingRefresh === null) return;
  cancelAnimationFrame(pendingRefresh);
  pendingRefresh = null;
}

/** Reuse a font already present in the active basemap to avoid glyph 404s. */
function pickTextFont(activeMap: MapLibreMap): string[] {
  if (cachedTextFont) return cachedTextFont;
  let fallback: string[] | null = null;
  for (const layer of activeMap.getStyle()?.layers ?? []) {
    if (layer.id === LABEL_LAYER_ID || layer.type !== "symbol") continue;
    const font = (layer.layout as { "text-font"?: string[] } | undefined)?.["text-font"];
    if (!Array.isArray(font) || font.length === 0) continue;
    if (font.every((name) => !/italic|bold/i.test(name))) return (cachedTextFont = font);
    fallback ??= font;
  }
  return (cachedTextFont = fallback ?? ["Open Sans Regular", "Arial Unicode MS Regular"]);
}

export function setH3Labels(next: Partial<H3Labels>): void {
  labels = { ...labels, ...next };
  if (panelContainer) renderPanel(panelContainer);
}

export function getH3GridSettings(): H3GridSettings {
  return { ...settings };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function color(value: unknown, fallback: string): string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)
    ? value.toLowerCase()
    : fallback;
}

/**
 * The automatic zoom→resolution rule, adapted from vgrid-maplibre's H3Grid
 * getResolution (https://www.npmjs.com/package/vgrid-maplibre): H3 cell area
 * shrinks ~7x per resolution step versus 4x per zoom level, so resolution
 * advances at a fraction of a step per zoom level (0.9 here, tuned up from
 * vgrid's 0.8 for a denser grid), offset so the world view starts at 0,
 * clamped to the valid range.
 */
export function h3ResolutionForZoom(zoom: number): number {
  return Math.min(15, Math.max(0, Math.floor((zoom - 3) * 0.9)));
}

/** The resolution actually rendered: zoom-derived when automatic, else manual. */
function effectiveResolution(): number {
  return settings.autoResolution && map ? h3ResolutionForZoom(map.getZoom()) : settings.resolution;
}

export function normalizeH3GridSettings(value: unknown): H3GridSettings {
  const candidate = (value ?? {}) as Partial<H3GridSettings>;
  return {
    autoResolution:
      typeof candidate.autoResolution === "boolean"
        ? candidate.autoResolution
        : DEFAULT_H3_GRID_SETTINGS.autoResolution,
    resolution: Math.round(
      clampNumber(candidate.resolution, 0, 15, DEFAULT_H3_GRID_SETTINGS.resolution),
    ),
    fillColor: color(candidate.fillColor, DEFAULT_H3_GRID_SETTINGS.fillColor),
    fillOpacity: clampNumber(candidate.fillOpacity, 0, 1, DEFAULT_H3_GRID_SETTINGS.fillOpacity),
    lineColor: color(candidate.lineColor, DEFAULT_H3_GRID_SETTINGS.lineColor),
    lineWidth: clampNumber(candidate.lineWidth, 0.1, 8, DEFAULT_H3_GRID_SETTINGS.lineWidth),
    showLabels:
      typeof candidate.showLabels === "boolean"
        ? candidate.showLabels
        : DEFAULT_H3_GRID_SETTINGS.showLabels,
    includeNeighbors:
      typeof candidate.includeNeighbors === "boolean"
        ? candidate.includeNeighbors
        : DEFAULT_H3_GRID_SETTINGS.includeNeighbors,
    includeParents:
      typeof candidate.includeParents === "boolean"
        ? candidate.includeParents
        : DEFAULT_H3_GRID_SETTINGS.includeParents,
    showIcosahedron:
      typeof candidate.showIcosahedron === "boolean"
        ? candidate.showIcosahedron
        : DEFAULT_H3_GRID_SETTINGS.showIcosahedron,
  };
}

/** Avoid thousands of overlapping IDs when the grid is viewed globally. */
export function h3LabelMinZoom(resolution: number): number {
  return Math.min(18, Math.max(3, Math.round(resolution) + 3));
}

export function setH3GridSettings(patch: Partial<H3GridSettings>): void {
  const previousResolution = effectiveResolution();
  // Leaving automatic mode adopts the current zoom-derived resolution as the
  // fixed one, so the grid stays put instead of jumping to the stale slider.
  if (settings.autoResolution && patch.autoResolution === false && patch.resolution === undefined) {
    patch = { ...patch, resolution: previousResolution };
  }
  settings = normalizeH3GridSettings({ ...settings, ...patch });
  const resolution = effectiveResolution();
  // Re-derive the selection only for an explicit slider change; toggling
  // automatic resolution (like zooming in automatic mode) keeps the clicked
  // cell and its neighbors/parents as they are.
  if (selectedCell && patch.resolution !== undefined && resolution !== previousResolution) {
    const [lat, lng] = cellToLatLng(selectedCell);
    selectedCell = latLngToCell(lat, lng, resolution);
  }
  // Only the rendered resolution changes the geometry, so a paint/layout-only
  // edit skips rebuilding up to H3_VIEWPORT_CELL_LIMIT features.
  if (resolution !== previousResolution) {
    refresh();
  } else {
    applyStyle();
    updateSelectedSource();
  }
  if (panelContainer) renderPanel(panelContainer);
}

/**
 * Keep a cell boundary contiguous across the antimeridian, mirroring
 * vgrid-maplibre's H3Grid (https://www.npmjs.com/package/vgrid-maplibre):
 * when a ring carries a vertex west of -130°, every positive longitude is
 * shifted down by 360°. A cell straddling the seam mixes ~+179 and ~-179
 * values, so the shift makes the ring contiguous around -180; MapLibre
 * renders longitudes past -180 in the adjacent world copy. Rings entirely
 * away from the seam never match the -130 test and pass through unchanged.
 */
export function h3FixTransmeridianBoundary(ring: [number, number][]): [number, number][] {
  if (!ring.some(([longitude]) => longitude < -130)) return ring;
  return ring.map(([longitude, latitude]) =>
    longitude > 0 ? [longitude - 360, latitude] : [longitude, latitude],
  );
}

/** Convert an H3 cell to a GeoJSON polygon with useful export attributes. */
export function h3CellFeature(cell: string): Feature<Polygon> {
  const [lat, lng] = cellToLatLng(cell);
  const boundary = h3FixTransmeridianBoundary(cellToBoundary(cell, true) as [number, number][]);
  return {
    type: "Feature",
    id: cell,
    properties: {
      h3: cell,
      resolution: getResolution(cell),
      base_cell: getBaseCellNumber(cell),
      center_lat: lat,
      center_lng: lng,
      is_pentagon: isPentagon(cell),
    },
    geometry: { type: "Polygon", coordinates: [boundary] },
  };
}

/**
 * Fill a WGS84 bounding box with H3 cells. Bounds that cross the antimeridian
 * are split into two polygons because H3 expects longitudes in [-180, 180].
 */
export function h3GridForBounds(
  bounds: [number, number, number, number],
  resolution: number,
  limit = H3_VIEWPORT_CELL_LIMIT,
): FeatureCollection<Polygon> {
  const [west, southRaw, east, northRaw] = bounds;
  const south = Math.max(-89.999999, Math.min(89.999999, southRaw));
  const north = Math.max(-89.999999, Math.min(89.999999, northRaw));
  const span = east >= west ? east - west : east + 360 - west;
  const ranges: Array<[number, number]> =
    span >= 359.999
      ? [
          [-180, 0],
          [0, 180],
        ]
      : east < west
        ? [
            [west, 180],
            [-180, east],
          ]
        : [[Math.max(-180, west), Math.min(180, east)]];
  // Reject obviously oversized requests before polygonToCells allocates the
  // full result. This spherical rectangle estimate is deliberately a little
  // conservative; the exact hard cap below remains the final guard.
  const radians = Math.PI / 180;
  const areaKm2 = ranges.reduce(
    (sum, [left, right]) =>
      sum +
      6371.0088 ** 2 *
        Math.abs((right - left) * radians) *
        Math.abs(Math.sin(north * radians) - Math.sin(south * radians)),
    0,
  );
  if (areaKm2 / getHexagonAreaAvg(resolution, "km2") > limit * 1.2) {
    throw new RangeError(`H3 cell limit exceeded: ${limit}`);
  }
  const cells = new Set<string>();

  for (const [left, right] of ranges) {
    const polygon = [
      [south, left],
      [south, right],
      [north, right],
      [north, left],
      [south, left],
    ];
    for (const cell of polygonToCells(polygon, resolution)) {
      cells.add(cell);
      if (cells.size > limit) {
        throw new RangeError(`H3 cell limit exceeded: ${limit}`);
      }
    }
  }
  return { type: "FeatureCollection", features: [...cells].map(h3CellFeature) };
}

function removeLayers(activeMap: MapLibreMap): void {
  for (const id of [
    SELECTED_LINE_LAYER_ID,
    SELECTED_FILL_LAYER_ID,
    PARENTS_LINE_LAYER_ID,
    ICOSAHEDRON_LINE_LAYER_ID,
    LABEL_LAYER_ID,
    LINE_LAYER_ID,
    FILL_LAYER_ID,
  ]) {
    if (activeMap.getLayer(id)) activeMap.removeLayer(id);
  }
  for (const id of [SELECTED_SOURCE_ID, PARENTS_SOURCE_ID, ICOSAHEDRON_SOURCE_ID, SOURCE_ID]) {
    if (activeMap.getSource(id)) activeMap.removeSource(id);
  }
}

function ensureLayers(): void {
  if (!map) return;
  if (!map.getSource(SOURCE_ID)) {
    map.addSource(SOURCE_ID, { type: "geojson", data: currentGrid });
    map.addLayer({
      id: FILL_LAYER_ID,
      type: "fill",
      source: SOURCE_ID,
      paint: { "fill-color": settings.fillColor, "fill-opacity": settings.fillOpacity },
    });
    map.addLayer({
      id: LINE_LAYER_ID,
      type: "line",
      source: SOURCE_ID,
      paint: { "line-color": settings.lineColor, "line-width": settings.lineWidth },
    });
    map.addLayer({
      id: LABEL_LAYER_ID,
      type: "symbol",
      source: SOURCE_ID,
      minzoom: h3LabelMinZoom(effectiveResolution()),
      layout: {
        "text-field": ["get", "h3"],
        "text-font": pickTextFont(map),
        "text-size": 10,
        visibility: settings.showLabels ? "visible" : "none",
      },
      paint: {
        "text-color": settings.lineColor,
        "text-halo-color": "#ffffff",
        "text-halo-width": 1,
      },
    });
  }
  if (!map.getSource(ICOSAHEDRON_SOURCE_ID)) {
    map.addSource(ICOSAHEDRON_SOURCE_ID, {
      type: "geojson",
      data: ICOSAHEDRON_GEOJSON_URL,
    });
    map.addLayer({
      id: ICOSAHEDRON_LINE_LAYER_ID,
      type: "line",
      source: ICOSAHEDRON_SOURCE_ID,
      layout: { visibility: settings.showIcosahedron ? "visible" : "none" },
      paint: {
        "line-color": "#dc2626",
        "line-width": 1.5,
        "line-dasharray": [2, 2],
      },
    });
  }
  // Added before the selected layers so the selected cell stays on top of its
  // (larger, overlapping) parents.
  if (!map.getSource(PARENTS_SOURCE_ID)) {
    map.addSource(PARENTS_SOURCE_ID, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addLayer({
      id: PARENTS_LINE_LAYER_ID,
      type: "line",
      source: PARENTS_SOURCE_ID,
      paint: {
        "line-color": "#f59e0b",
        "line-width": SELECTED_LINE_WIDTH * 2,
        "line-dasharray": [2, 2],
      },
    });
  }
  if (!map.getSource(SELECTED_SOURCE_ID)) {
    map.addSource(SELECTED_SOURCE_ID, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addLayer({
      id: SELECTED_FILL_LAYER_ID,
      type: "fill",
      source: SELECTED_SOURCE_ID,
      paint: { "fill-color": "#f59e0b", "fill-opacity": 0.25 },
    });
    map.addLayer({
      id: SELECTED_LINE_LAYER_ID,
      type: "line",
      source: SELECTED_SOURCE_ID,
      paint: { "line-color": "#f59e0b", "line-width": SELECTED_LINE_WIDTH },
    });
  }
}

function applyStyle(): void {
  if (!map) return;
  ensureLayers();
  map.setPaintProperty(FILL_LAYER_ID, "fill-color", settings.fillColor);
  map.setPaintProperty(FILL_LAYER_ID, "fill-opacity", settings.fillOpacity);
  map.setPaintProperty(LINE_LAYER_ID, "line-color", settings.lineColor);
  map.setPaintProperty(LINE_LAYER_ID, "line-width", settings.lineWidth);
  map.setPaintProperty(LABEL_LAYER_ID, "text-color", settings.lineColor);
  map.setLayoutProperty(LABEL_LAYER_ID, "visibility", settings.showLabels ? "visible" : "none");
  map.setLayerZoomRange(LABEL_LAYER_ID, h3LabelMinZoom(effectiveResolution()), 24);
  map.setLayoutProperty(
    ICOSAHEDRON_LINE_LAYER_ID,
    "visibility",
    settings.showIcosahedron ? "visible" : "none",
  );
}

function refresh(): void {
  if (!map) return;
  const resolution = effectiveResolution();
  // The selected cell (and its neighbors/parents) deliberately stays at the
  // resolution it was clicked at: in automatic mode a zoom or pan changes the
  // rendered grid, but re-deriving the selection would silently replace the
  // cell the user identified. Only an explicit settings change re-indexes it
  // (see setH3GridSettings).
  try {
    const bounds = map.getBounds();
    currentGrid = h3GridForBounds(
      [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
      resolution,
    );
    currentError = null;
  } catch (error) {
    currentGrid = { type: "FeatureCollection", features: [] };
    currentError =
      error instanceof RangeError ? labels.tooManyCells(H3_VIEWPORT_CELL_LIMIT) : String(error);
  }
  applyStyle();
  (map.getSource(SOURCE_ID) as GeoJSONSource | undefined)?.setData(currentGrid);
  updateSelectedSource();
  if (panelContainer) renderPanel(panelContainer);
}

function selectedCells(): string[] {
  if (!selectedCell) return [];
  return settings.includeNeighbors ? gridDisk(selectedCell, 1) : [selectedCell];
}

/**
 * Every resolution r-1 cell the selected cell overlaps. H3's hierarchy is
 * approximate — a child hexagon is not perfectly contained in cellToParent,
 * its corners can spill into the parent's neighbors. Any overlapping coarser
 * cell is larger than the cell itself, so it must cover part of the boundary:
 * sampling the boundary vertices, nudged slightly toward the center so parents
 * that merely touch the edge are excluded, finds them all.
 */
function parentCells(cell: string): string[] {
  const resolution = getResolution(cell);
  if (resolution <= 0) return [];
  const [centerLat, centerLng] = cellToLatLng(cell);
  const parents = new Set<string>([cellToParent(cell, resolution - 1)]);
  // The unwrapped ring keeps vertex longitudes adjacent to the center for
  // dateline cells; latLngToCell accepts longitudes outside [-180, 180].
  const ring = h3FixTransmeridianBoundary(cellToBoundary(cell, true) as [number, number][]);
  const ringCenterLng =
    centerLng > 0 && ring.some(([lng]) => lng < -130) ? centerLng - 360 : centerLng;
  for (const [lng, lat] of ring) {
    parents.add(
      latLngToCell(
        centerLat + (lat - centerLat) * 0.999,
        ringCenterLng + (lng - ringCenterLng) * 0.999,
        resolution - 1,
      ),
    );
  }
  return [...parents];
}

function updateSelectedSource(): void {
  const source = map?.getSource(SELECTED_SOURCE_ID) as GeoJSONSource | undefined;
  source?.setData({
    type: "FeatureCollection",
    features: selectedCells().map(h3CellFeature),
  });
  const parentsSource = map?.getSource(PARENTS_SOURCE_ID) as GeoJSONSource | undefined;
  parentsSource?.setData({
    type: "FeatureCollection",
    features:
      settings.includeParents && selectedCell ? parentCells(selectedCell).map(h3CellFeature) : [],
  });
}

function gridCsv(grid: FeatureCollection<Polygon>): string {
  const header = "h3,resolution,base_cell,center_lat,center_lng,is_pentagon";
  const rows = grid.features.map((feature) => {
    const p = feature.properties!;
    return [p.h3, p.resolution, p.base_cell, p.center_lat, p.center_lng, p.is_pentagon].join(",");
  });
  return [header, ...rows].join("\n");
}

function fitSelected(): void {
  if (!selectedCell || !appRef) return;
  const ring = h3FixTransmeridianBoundary(cellToBoundary(selectedCell, true) as [number, number][]);
  const lons = ring.map(([lng]) => lng);
  const lats = ring.map(([, lat]) => lat);
  appRef.fitBounds?.([Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)]);
}

function renderPanel(container: HTMLElement): void {
  panelContainer = container;
  container.replaceChildren();
  container.style.font = "13px/1.4 system-ui, sans-serif";

  const section = document.createElement("div");
  section.style.display = "grid";
  section.style.gap = "10px";
  section.style.padding = "12px";
  container.appendChild(section);

  const row = (text: string, input: HTMLElement): void => {
    const label = document.createElement("label");
    label.style.display = "flex";
    label.style.alignItems = "center";
    label.style.justifyContent = "space-between";
    label.style.gap = "12px";
    const span = document.createElement("span");
    span.textContent = text;
    label.append(span, input);
    section.appendChild(label);
  };
  const button = (text: string, action: () => void, disabled = false): HTMLButtonElement => {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = text;
    element.disabled = disabled;
    element.style.padding = "6px 8px";
    element.style.border = "1px solid hsl(var(--border))";
    element.style.borderRadius = "6px";
    element.style.background = "hsl(var(--background))";
    element.style.color = "inherit";
    element.style.cursor = disabled ? "not-allowed" : "pointer";
    element.style.opacity = disabled ? "0.5" : "1";
    element.style.transition = "background-color 120ms ease, border-color 120ms ease";
    element.addEventListener("mouseenter", () => {
      if (!element.disabled) element.style.background = "hsl(var(--muted))";
    });
    element.addEventListener("mouseleave", () => {
      element.style.background = "hsl(var(--background))";
    });
    element.addEventListener("click", action);
    return element;
  };

  const autoResolution = document.createElement("input");
  autoResolution.type = "checkbox";
  autoResolution.checked = settings.autoResolution;
  autoResolution.addEventListener("change", () =>
    setH3GridSettings({ autoResolution: autoResolution.checked }),
  );
  row(labels.autoResolution, autoResolution);

  // In automatic mode the slider becomes a read-only indicator of the
  // zoom-derived resolution; refresh() re-renders the panel on every moveend,
  // so it tracks zoom gestures.
  const shownResolution = effectiveResolution();
  const resolution = document.createElement("input");
  resolution.type = "range";
  resolution.min = "0";
  resolution.max = "15";
  resolution.value = String(shownResolution);
  resolution.title = String(shownResolution);
  resolution.disabled = settings.autoResolution;
  resolution.addEventListener("input", () => {
    resolution.title = resolution.value;
  });
  resolution.addEventListener("change", () =>
    setH3GridSettings({ resolution: Number(resolution.value) }),
  );
  const resolutionWrap = document.createElement("span");
  resolutionWrap.style.display = "flex";
  resolutionWrap.style.alignItems = "center";
  resolutionWrap.style.gap = "6px";
  resolutionWrap.style.opacity = settings.autoResolution ? "0.6" : "1";
  const resolutionValue = document.createElement("strong");
  resolutionValue.textContent = String(shownResolution);
  resolution.addEventListener("input", () => {
    resolutionValue.textContent = resolution.value;
  });
  resolutionWrap.append(resolution, resolutionValue);
  row(labels.resolution, resolutionWrap);

  for (const [text, key] of [
    [labels.fillColor, "fillColor"],
    [labels.lineColor, "lineColor"],
  ] as const) {
    const input = document.createElement("input");
    input.type = "color";
    input.value = settings[key];
    // `change` (not `input`): setH3GridSettings re-renders the panel, which
    // would destroy the picker mid-drag.
    input.addEventListener("change", () => setH3GridSettings({ [key]: input.value }));
    row(text, input);
  }
  for (const [text, key, min, max, step] of [
    [labels.fillOpacity, "fillOpacity", 0, 1, 0.05],
    [labels.lineWidth, "lineWidth", 0.1, 8, 0.1],
  ] as const) {
    const input = document.createElement("input");
    input.type = "number";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(settings[key]);
    input.style.width = "72px";
    input.addEventListener("change", () => setH3GridSettings({ [key]: Number(input.value) }));
    row(text, input);
  }
  for (const [text, key] of [
    [labels.showLabels, "showLabels"],
    [labels.includeNeighbors, "includeNeighbors"],
    [labels.includeParents, "includeParents"],
    [labels.showIcosahedron, "showIcosahedron"],
  ] as const) {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = settings[key];
    input.addEventListener("change", () => setH3GridSettings({ [key]: input.checked }));
    row(text, input);
  }

  const status = document.createElement("div");
  status.textContent = currentError ?? labels.cellCount(currentGrid.features.length);
  status.style.color = currentError ? "#dc2626" : "";
  section.appendChild(status);

  const hint = document.createElement("div");
  hint.textContent = labels.identifyHint;
  hint.style.color = "var(--muted-foreground, #6b7280)";
  section.appendChild(hint);

  const selectedHeading = document.createElement("strong");
  selectedHeading.textContent = labels.selectedCell;
  section.appendChild(selectedHeading);

  if (selectedCell) {
    const [lat, lng] = cellToLatLng(selectedCell);
    const details = document.createElement("dl");
    details.style.margin = "0";
    details.style.display = "grid";
    details.style.gridTemplateColumns = "auto 1fr";
    details.style.gap = "4px 10px";
    const addDetail = (term: string, value: string): void => {
      const dt = document.createElement("dt");
      dt.textContent = term;
      dt.style.color = "var(--muted-foreground, #6b7280)";
      const dd = document.createElement("dd");
      dd.textContent = value;
      dd.style.margin = "0";
      dd.style.overflowWrap = "anywhere";
      // Multi-line values (one overlapping parent per line) keep their breaks.
      dd.style.whiteSpace = "pre-line";
      details.append(dt, dd);
    };
    addDetail("ID", selectedCell);
    addDetail(labels.resolution, String(getResolution(selectedCell)));
    addDetail(labels.baseCell, String(getBaseCellNumber(selectedCell)));
    addDetail(labels.center, `${lat.toFixed(6)}, ${lng.toFixed(6)}`);
    addDetail(labels.pentagon, isPentagon(selectedCell) ? labels.yes : labels.no);
    if (getResolution(selectedCell) > 0) {
      // Every overlapping r-1 cell (canonical cellToParent first), matching
      // the dashed parent outlines on the map.
      addDetail(labels.parent, parentCells(selectedCell).join("\n"));
    }
    if (getResolution(selectedCell) < 15) {
      addDetail(
        labels.children,
        String(cellToChildren(selectedCell, getResolution(selectedCell) + 1).length),
      );
    }
    addDetail(labels.neighbors, String(gridDisk(selectedCell, 1).length - 1));
    section.appendChild(details);
  } else {
    const empty = document.createElement("div");
    empty.textContent = labels.noSelection;
    empty.style.color = "var(--muted-foreground, #6b7280)";
    section.appendChild(empty);
  }

  const actions = document.createElement("div");
  actions.style.display = "grid";
  actions.style.gridTemplateColumns = "1fr 1fr";
  actions.style.gap = "6px";
  actions.append(
    button(
      labels.copyId,
      () => {
        if (selectedCell) void navigator.clipboard?.writeText(selectedCell);
      },
      !selectedCell,
    ),
    button(labels.zoomToCell, fitSelected, !selectedCell),
    button(
      labels.addAsLayer,
      () => {
        if (currentGrid.features.length) {
          appRef?.addGeoJsonLayer(`H3 grid (resolution ${effectiveResolution()})`, currentGrid);
        }
      },
      currentGrid.features.length === 0,
    ),
    button(
      labels.exportGeoJson,
      () => {
        appRef?.exportTextFile?.(
          `h3-grid-r${effectiveResolution()}.geojson`,
          JSON.stringify(currentGrid, null, 2),
          {
            description: "GeoJSON",
            extensions: ["geojson"],
            mimeType: "application/geo+json",
            promptName: true,
          },
        );
      },
      currentGrid.features.length === 0,
    ),
    button(
      labels.exportCsv,
      () => {
        appRef?.exportTextFile?.(`h3-grid-r${effectiveResolution()}.csv`, gridCsv(currentGrid), {
          description: "CSV",
          extensions: ["csv"],
          mimeType: "text/csv",
          promptName: true,
        });
      },
      currentGrid.features.length === 0,
    ),
  );
  section.appendChild(actions);
}

function settingsEqual(a: H3GridSettings, b: H3GridSettings): boolean {
  return Object.keys(a).every(
    (key) => a[key as keyof H3GridSettings] === b[key as keyof H3GridSettings],
  );
}

export const maplibreH3Plugin: GeoLibrePlugin = {
  id: H3_PLUGIN_ID,
  name: "H3 Grid",
  version: "1.0.0",
  activate: (app) => {
    const activeMap = app.getMap?.();
    if (!activeMap) return false;
    map = activeMap;
    appRef = app;
    moveHandler = () => scheduleRefresh();
    clickHandler = (event) => {
      selectedCell = latLngToCell(event.lngLat.lat, event.lngLat.lng, effectiveResolution());
      updateSelectedSource();
      if (panelContainer) renderPanel(panelContainer);
    };
    activeMap.on("moveend", moveHandler);
    activeMap.on("click", clickHandler);
    unsubscribeBasemap = app.onBasemapChange(() => {
      cachedTextFont = null;
      activeMap.once("idle", refresh);
    });
    unregisterPanel =
      app.registerRightPanel?.({
        id: PANEL_ID,
        title: () => labels.getTitle?.() ?? labels.title,
        dock: "right-of-style",
        defaultWidth: 340,
        render: (container) => renderPanel(container),
        // Closing the panel ends the identify session: drop the clicked cell
        // and, with it, the neighbor/parent overlays derived from it.
        onClose: () => {
          selectedCell = null;
          updateSelectedSource();
          if (panelContainer) renderPanel(panelContainer);
        },
      }) ?? null;
    refresh();
    app.openRightPanel?.(PANEL_ID);
  },
  deactivate: (app) => {
    cancelScheduledRefresh();
    if (map && moveHandler) map.off("moveend", moveHandler);
    if (map && clickHandler) map.off("click", clickHandler);
    unsubscribeBasemap?.();
    unregisterPanel?.();
    if (map) removeLayers(map);
    moveHandler = null;
    clickHandler = null;
    unsubscribeBasemap = null;
    unregisterPanel = null;
    panelContainer = null;
    selectedCell = null;
    currentGrid = { type: "FeatureCollection", features: [] };
    currentError = null;
    cachedTextFont = null;
    map = null;
    appRef = null;
    app.closeRightPanel?.(PANEL_ID);
  },
  getProjectState: () =>
    settingsEqual(settings, DEFAULT_H3_GRID_SETTINGS) ? undefined : { ...settings },
  applyProjectState: (_app, state) => {
    const next = normalizeH3GridSettings(state);
    if (settingsEqual(settings, next)) return false;
    settings = next;
    refresh();
  },
};
