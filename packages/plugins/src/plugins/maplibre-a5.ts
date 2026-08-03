import type { Feature, FeatureCollection, Polygon } from "geojson";
import {
  MAX_RESOLUTION,
  cellArea,
  cellToBoundary,
  cellToChildren,
  cellToLonLat,
  cellToParent,
  getNumCells,
  getRes0Cells,
  getResolution,
  gridDisk,
  hexToU64,
  lonLatToCell,
  polygonToCells,
  u64ToHex,
  uncompact,
} from "a5-js";
import type { GeoJSONSource, Map as MapLibreMap, MapMouseEvent } from "maplibre-gl";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

export const A5_PLUGIN_ID = "maplibre-a5-grid";

const PANEL_ID = "geolibre-a5-panel";
const SOURCE_ID = "geolibre-a5-grid-source";
const FILL_LAYER_ID = "geolibre-a5-grid-fill";
const LINE_LAYER_ID = "geolibre-a5-grid-line";
const LABEL_LAYER_ID = "geolibre-a5-grid-label";
const SELECTED_SOURCE_ID = "geolibre-a5-selected-source";
const SELECTED_FILL_LAYER_ID = "geolibre-a5-selected-fill";
const SELECTED_LINE_LAYER_ID = "geolibre-a5-selected-line";
const PARENTS_SOURCE_ID = "geolibre-a5-parents-source";
const PARENTS_LINE_LAYER_ID = "geolibre-a5-parents-line";

const SELECTED_LINE_WIDTH = 3;

/** Prevent a fine resolution over a large viewport from freezing the browser. */
export const A5_VIEWPORT_CELL_LIMIT = 20_000;

// a5-js brands its coordinate tuples; the brand is not exported, so it is
// recovered from the function signatures at the two casting boundaries below.
type A5LonLat = Parameters<typeof lonLatToCell>[0];

export interface A5GridSettings {
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
}

export const DEFAULT_A5_GRID_SETTINGS: A5GridSettings = {
  autoResolution: true,
  // Useful immediately at GeoLibre's default world view: resolution 4 fills it
  // with 3,840 pentagons (resolution 6's 61,440 would already exceed the
  // viewport safety cap).
  resolution: 4,
  fillColor: "#16a34a",
  fillOpacity: 0.08,
  lineColor: "#16a34a",
  lineWidth: 1,
  showLabels: true,
  includeNeighbors: false,
  includeParents: false,
};

export interface A5Labels {
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
  parent: string;
  children: string;
  neighbors: string;
  center: string;
  zoomToCell: string;
  addAsLayer: string;
  exportGeoJson: string;
  exportCsv: string;
  includeNeighbors: string;
  includeParents: string;
}

export const DEFAULT_A5_LABELS: A5Labels = {
  title: "A5 Grid",
  controlTitle: "A5 grid settings",
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
  identifyHint: "Click the map to identify an A5 cell.",
  selectedCell: "Selected cell",
  noSelection: "No cell selected",
  copyId: "Copy ID",
  parent: "Parent(s)",
  children: "Children",
  neighbors: "Neighbors",
  center: "Center",
  zoomToCell: "Zoom to cell",
  addAsLayer: "Add grid as layer",
  exportGeoJson: "Export GeoJSON",
  exportCsv: "Export CSV",
  includeNeighbors: "Include selected cell neighbors",
  includeParents: "Include selected cell parent(s)",
};

let labels: A5Labels = { ...DEFAULT_A5_LABELS };
let settings: A5GridSettings = { ...DEFAULT_A5_GRID_SETTINGS };
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
 * and each rebuild walks up to A5_VIEWPORT_CELL_LIMIT cells on the main thread.
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

export function setA5Labels(next: Partial<A5Labels>): void {
  labels = { ...labels, ...next };
  if (panelContainer) renderPanel(panelContainer);
}

export function getA5GridSettings(): A5GridSettings {
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
 * The automatic zoom→resolution rule, mirroring vgrid-maplibre's A5Grid
 * (https://www.npmjs.com/package/vgrid-maplibre): one A5 resolution per zoom
 * level, clamped to the valid range.
 */
export function a5ResolutionForZoom(zoom: number): number {
  return Math.min(MAX_RESOLUTION, Math.max(0, Math.floor(zoom)));
}

/** The resolution actually rendered: zoom-derived when automatic, else manual. */
function effectiveResolution(): number {
  return settings.autoResolution && map ? a5ResolutionForZoom(map.getZoom()) : settings.resolution;
}

export function normalizeA5GridSettings(value: unknown): A5GridSettings {
  const candidate = (value ?? {}) as Partial<A5GridSettings>;
  return {
    autoResolution:
      typeof candidate.autoResolution === "boolean"
        ? candidate.autoResolution
        : DEFAULT_A5_GRID_SETTINGS.autoResolution,
    resolution: Math.round(
      clampNumber(candidate.resolution, 0, MAX_RESOLUTION, DEFAULT_A5_GRID_SETTINGS.resolution),
    ),
    fillColor: color(candidate.fillColor, DEFAULT_A5_GRID_SETTINGS.fillColor),
    fillOpacity: clampNumber(candidate.fillOpacity, 0, 1, DEFAULT_A5_GRID_SETTINGS.fillOpacity),
    lineColor: color(candidate.lineColor, DEFAULT_A5_GRID_SETTINGS.lineColor),
    lineWidth: clampNumber(candidate.lineWidth, 0.1, 8, DEFAULT_A5_GRID_SETTINGS.lineWidth),
    showLabels:
      typeof candidate.showLabels === "boolean"
        ? candidate.showLabels
        : DEFAULT_A5_GRID_SETTINGS.showLabels,
    includeNeighbors:
      typeof candidate.includeNeighbors === "boolean"
        ? candidate.includeNeighbors
        : DEFAULT_A5_GRID_SETTINGS.includeNeighbors,
    includeParents:
      typeof candidate.includeParents === "boolean"
        ? candidate.includeParents
        : DEFAULT_A5_GRID_SETTINGS.includeParents,
  };
}

/**
 * Avoid thousands of overlapping IDs when the grid is viewed globally. A5 cell
 * area shrinks 4x per resolution step (2x linearly), so one zoom level per
 * resolution keeps the on-screen label density roughly constant.
 */
export function a5LabelMinZoom(resolution: number): number {
  return Math.min(18, Math.max(2, Math.round(resolution) + 1));
}

export function setA5GridSettings(patch: Partial<A5GridSettings>): void {
  const previousResolution = effectiveResolution();
  // Leaving automatic mode adopts the current zoom-derived resolution as the
  // fixed one, so the grid stays put instead of jumping to the stale slider.
  if (settings.autoResolution && patch.autoResolution === false && patch.resolution === undefined) {
    patch = { ...patch, resolution: previousResolution };
  }
  settings = normalizeA5GridSettings({ ...settings, ...patch });
  const resolution = effectiveResolution();
  // Re-derive the selection only for an explicit slider change; toggling
  // automatic resolution (like zooming in automatic mode) keeps the clicked
  // cell and its neighbors/parents as they are.
  if (selectedCell && patch.resolution !== undefined && resolution !== previousResolution) {
    const center = cellToLonLat(hexToU64(selectedCell));
    selectedCell = u64ToHex(lonLatToCell(center, resolution));
  }
  // Only the rendered resolution changes the geometry, so a paint/layout-only
  // edit skips rebuilding up to A5_VIEWPORT_CELL_LIMIT features.
  if (resolution !== previousResolution) {
    refresh();
  } else {
    applyStyle();
    updateSelectedSource();
  }
  if (panelContainer) renderPanel(panelContainer);
}

/**
 * Unwrap antimeridian-crossing A5 rings so longitudes stay contiguous.
 * a5-js returns raw ±180 jumps; MapLibre needs the adjacent world copy.
 */
export function a5UnwrapBoundary(ring: [number, number][]): [number, number][] {
  if (ring.length === 0) return ring;
  const out: [number, number][] = [];
  for (const [lng, lat] of ring) {
    let lon = lng;
    if (out.length > 0) {
      const reference = out[0][0];
      if (lon - reference > 180) lon -= 360;
      if (lon - reference < -180) lon += 360;
    }
    out.push([lon, lat]);
  }
  return out;
}

/** Convert an A5 cell (hex identifier) to a GeoJSON polygon with export attributes. */
export function a5CellFeature(cell: string): Feature<Polygon> {
  const id = hexToU64(cell);
  const [lng, lat] = cellToLonLat(id);
  const boundary = a5UnwrapBoundary(cellToBoundary(id) as [number, number][]);
  return {
    type: "Feature",
    id: cell,
    properties: {
      a5: cell,
      resolution: getResolution(id),
      center_lat: lat,
      center_lng: lng,
    },
    geometry: { type: "Polygon", coordinates: [boundary] },
  };
}

const EARTH_AREA_M2 = 4 * Math.PI * 6371008.8 ** 2;

/**
 * polygonToCells is reliable for viewport-sized polygons, but once a polygon
 * approaches hemisphere scale it starts missing interior cells (observed above
 * roughly 20% of the sphere), and a ring spanning the full 360° of longitude is
 * degenerate. Views larger than this fraction switch to enumerating every cell
 * at the resolution and filtering by center — exact, and only reachable at
 * coarse resolutions (the cell-limit guard rejects large views at fine ones),
 * where the enumeration is cheap.
 */
const POLYGON_FILL_MAX_EARTH_FRACTION = 0.15;

/** Fill a WGS84 bounding box with A5 cells. */
export function a5GridForBounds(
  bounds: [number, number, number, number],
  resolution: number,
  limit = A5_VIEWPORT_CELL_LIMIT,
): FeatureCollection<Polygon> {
  const [west, southRaw, east, northRaw] = bounds;
  const south = Math.max(-90, Math.min(90, southRaw));
  const north = Math.max(-90, Math.min(90, northRaw));
  const span = Math.min(360, east >= west ? east - west : east + 360 - west);
  // Reject obviously oversized requests before materializing the full result.
  // This spherical rectangle estimate is deliberately a little conservative;
  // the exact hard cap below remains the final guard. A5 cells are exactly
  // equal-area, so cellArea is not an average but the true size.
  const radians = Math.PI / 180;
  const areaM2 =
    6371008.8 ** 2 *
    span *
    radians *
    Math.abs(Math.sin(north * radians) - Math.sin(south * radians));
  if (areaM2 / cellArea(resolution) > limit * 1.2) {
    throw new RangeError(`A5 cell limit exceeded: ${limit}`);
  }

  const cells: bigint[] = [];
  const push = (cell: bigint): void => {
    cells.push(cell);
    if (cells.length > limit) {
      throw new RangeError(`A5 cell limit exceeded: ${limit}`);
    }
  };
  const enumerable = getNumCells(resolution) <= limit * 4;
  if (enumerable && (span >= 359.999 || areaM2 > EARTH_AREA_M2 * POLYGON_FILL_MAX_EARTH_FRACTION)) {
    for (const cell of uncompact(getRes0Cells(), resolution)) {
      const [lng, lat] = cellToLonLat(cell);
      if (lat < south || lat > north) continue;
      // Modulo keeps antimeridian-crossing and unwrapped west values working.
      const offset = (((lng - west) % 360) + 360) % 360;
      if (offset <= span || span >= 360) push(cell);
    }
  } else {
    // A5 works on the sphere, so the ring may cross the antimeridian or carry
    // unwrapped longitudes as-is — no splitting needed. polygonToCells compacts
    // its result; uncompact back to one resolution, as mixed-resolution
    // pentagons do not nest and would render gaps/overlaps.
    // Known tradeoff (accepted): on the sphere the top/bottom edges of this
    // plain rectangle are great-circle arcs, not parallels, so high-latitude
    // views (e.g. Svalbard, Antarctica) omit some cells near the poleward
    // edge. Densifying those edges would restore them.
    const eastEdge = west + Math.min(span, 359.999);
    const ring = [
      [west, south],
      [eastEdge, south],
      [eastEdge, north],
      [west, north],
      [west, south],
    ] as A5LonLat[];
    for (const cell of uncompact(polygonToCells(ring, resolution), resolution)) {
      push(cell);
    }
  }
  return {
    type: "FeatureCollection",
    features: cells.map((cell) => a5CellFeature(u64ToHex(cell))),
  };
}

function removeLayers(activeMap: MapLibreMap): void {
  for (const id of [
    SELECTED_LINE_LAYER_ID,
    SELECTED_FILL_LAYER_ID,
    PARENTS_LINE_LAYER_ID,
    LABEL_LAYER_ID,
    LINE_LAYER_ID,
    FILL_LAYER_ID,
  ]) {
    if (activeMap.getLayer(id)) activeMap.removeLayer(id);
  }
  for (const id of [SELECTED_SOURCE_ID, PARENTS_SOURCE_ID, SOURCE_ID]) {
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
      minzoom: a5LabelMinZoom(effectiveResolution()),
      layout: {
        "text-field": ["get", "a5"],
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
  // Added before the selected layers so the selected cell stays on top of its
  // (larger, overlapping) ancestors.
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
  map.setLayerZoomRange(LABEL_LAYER_ID, a5LabelMinZoom(effectiveResolution()), 24);
}

function refresh(): void {
  if (!map) return;
  const resolution = effectiveResolution();
  // The selected cell (and its neighbors/parents) deliberately stays at the
  // resolution it was clicked at: in automatic mode a zoom or pan changes the
  // rendered grid, but re-deriving the selection would silently replace the
  // cell the user identified. Only an explicit settings change re-indexes it
  // (see setA5GridSettings).
  try {
    const bounds = map.getBounds();
    currentGrid = a5GridForBounds(
      [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
      resolution,
    );
    currentError = null;
  } catch (error) {
    currentGrid = { type: "FeatureCollection", features: [] };
    currentError =
      error instanceof RangeError ? labels.tooManyCells(A5_VIEWPORT_CELL_LIMIT) : String(error);
  }
  applyStyle();
  (map.getSource(SOURCE_ID) as GeoJSONSource | undefined)?.setData(currentGrid);
  updateSelectedSource();
  if (panelContainer) renderPanel(panelContainer);
}

function neighborCells(cell: string): string[] {
  const id = hexToU64(cell);
  // gridDisk compacts its result, so expand back to the cell's resolution.
  return [...uncompact(gridDisk(id, 1), getResolution(id))].map(u64ToHex);
}

function selectedCells(): string[] {
  if (!selectedCell) return [];
  return settings.includeNeighbors ? neighborCells(selectedCell) : [selectedCell];
}

/**
 * Every resolution r-1 cell the selected cell overlaps. A5 pentagons do not
 * nest, so a cell can spill across several coarser cells beyond its canonical
 * cellToParent (sampled across the sphere, ~half of all cells overlap 2–3).
 * Any overlapping coarser cell is larger than the cell itself, so it must
 * cover part of the boundary: sampling a densified boundary, nudged slightly
 * toward the center so parents that merely touch the edge are excluded, finds
 * them all.
 */
function parentCells(cell: string): string[] {
  const id = hexToU64(cell);
  const resolution = getResolution(id);
  if (resolution <= 0) return [];
  const [centerLng, centerLat] = cellToLonLat(id);
  const parents = new Set<string>([u64ToHex(cellToParent(id))]);
  for (const [lng, lat] of cellToBoundary(id, { closedRing: false, segments: 12 })) {
    const inset = [
      centerLng + (lng - centerLng) * 0.999,
      centerLat + (lat - centerLat) * 0.999,
    ] as A5LonLat;
    parents.add(u64ToHex(lonLatToCell(inset, resolution - 1)));
  }
  return [...parents];
}

function updateSelectedSource(): void {
  const source = map?.getSource(SELECTED_SOURCE_ID) as GeoJSONSource | undefined;
  source?.setData({
    type: "FeatureCollection",
    features: selectedCells().map(a5CellFeature),
  });
  const parentsSource = map?.getSource(PARENTS_SOURCE_ID) as GeoJSONSource | undefined;
  parentsSource?.setData({
    type: "FeatureCollection",
    features:
      settings.includeParents && selectedCell ? parentCells(selectedCell).map(a5CellFeature) : [],
  });
}

function gridCsv(grid: FeatureCollection<Polygon>): string {
  const header = "a5,resolution,center_lat,center_lng";
  const rows = grid.features.map((feature) => {
    const p = feature.properties!;
    return [p.a5, p.resolution, p.center_lat, p.center_lng].join(",");
  });
  return [header, ...rows].join("\n");
}

function fitSelected(): void {
  if (!selectedCell || !appRef) return;
  // The ring is unwrapped to stay contiguous across the antimeridian, so
  // min/max longitudes never span the world.
  const ring = a5UnwrapBoundary(cellToBoundary(hexToU64(selectedCell)) as [number, number][]);
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
    setA5GridSettings({ autoResolution: autoResolution.checked }),
  );
  row(labels.autoResolution, autoResolution);

  // In automatic mode the slider becomes a read-only indicator of the
  // zoom-derived resolution; refresh() re-renders the panel on every moveend,
  // so it tracks zoom gestures.
  const shownResolution = effectiveResolution();
  const resolution = document.createElement("input");
  resolution.type = "range";
  resolution.min = "0";
  resolution.max = String(MAX_RESOLUTION);
  resolution.value = String(shownResolution);
  resolution.title = String(shownResolution);
  resolution.disabled = settings.autoResolution;
  resolution.addEventListener("input", () => {
    resolution.title = resolution.value;
  });
  resolution.addEventListener("change", () =>
    setA5GridSettings({ resolution: Number(resolution.value) }),
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
    // `change` (not `input`): setA5GridSettings re-renders the panel, which
    // would destroy the picker mid-drag.
    input.addEventListener("change", () => setA5GridSettings({ [key]: input.value }));
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
    input.addEventListener("change", () => setA5GridSettings({ [key]: Number(input.value) }));
    row(text, input);
  }
  for (const [text, key] of [
    [labels.showLabels, "showLabels"],
    [labels.includeNeighbors, "includeNeighbors"],
    [labels.includeParents, "includeParents"],
  ] as const) {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = settings[key];
    input.addEventListener("change", () => setA5GridSettings({ [key]: input.checked }));
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
    const id = hexToU64(selectedCell);
    const cellResolution = getResolution(id);
    const [lng, lat] = cellToLonLat(id);
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
    addDetail(labels.resolution, String(cellResolution));
    addDetail(labels.center, `${lat.toFixed(6)}, ${lng.toFixed(6)}`);
    if (cellResolution > 0) {
      // Every overlapping r-1 cell (canonical cellToParent first), matching
      // the dashed parent outlines on the map.
      addDetail(labels.parent, parentCells(selectedCell).join("\n"));
    }
    if (cellResolution < MAX_RESOLUTION) {
      addDetail(labels.children, String(cellToChildren(id).length));
    }
    addDetail(labels.neighbors, String(neighborCells(selectedCell).length - 1));
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
          appRef?.addGeoJsonLayer(`A5 grid (resolution ${effectiveResolution()})`, currentGrid);
        }
      },
      currentGrid.features.length === 0,
    ),
    button(
      labels.exportGeoJson,
      () => {
        appRef?.exportTextFile?.(
          `a5-grid-r${effectiveResolution()}.geojson`,
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
        appRef?.exportTextFile?.(`a5-grid-r${effectiveResolution()}.csv`, gridCsv(currentGrid), {
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

function settingsEqual(a: A5GridSettings, b: A5GridSettings): boolean {
  return Object.keys(a).every(
    (key) => a[key as keyof A5GridSettings] === b[key as keyof A5GridSettings],
  );
}

export const maplibreA5Plugin: GeoLibrePlugin = {
  id: A5_PLUGIN_ID,
  name: "A5 Grid",
  version: "1.0.0",
  activate: (app) => {
    const activeMap = app.getMap?.();
    if (!activeMap) return false;
    map = activeMap;
    appRef = app;
    moveHandler = () => scheduleRefresh();
    clickHandler = (event) => {
      selectedCell = u64ToHex(
        lonLatToCell([event.lngLat.lng, event.lngLat.lat] as A5LonLat, effectiveResolution()),
      );
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
    settingsEqual(settings, DEFAULT_A5_GRID_SETTINGS) ? undefined : { ...settings },
  applyProjectState: (_app, state) => {
    const next = normalizeA5GridSettings(state);
    if (settingsEqual(settings, next)) return false;
    settings = next;
    refresh();
  },
};
