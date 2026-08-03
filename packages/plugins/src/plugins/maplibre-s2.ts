import type { Feature, FeatureCollection, Polygon } from "geojson";
import { geojson as s2geojson, s1, s2 } from "s2js";
import type { GeoJSONSource, Map as MapLibreMap, MapMouseEvent } from "maplibre-gl";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

export const S2_PLUGIN_ID = "maplibre-s2-grid";

const PANEL_ID = "geolibre-s2-panel";
const SOURCE_ID = "geolibre-s2-grid-source";
const FILL_LAYER_ID = "geolibre-s2-grid-fill";
const LINE_LAYER_ID = "geolibre-s2-grid-line";
const LABEL_LAYER_ID = "geolibre-s2-grid-label";
const SELECTED_SOURCE_ID = "geolibre-s2-selected-source";
const SELECTED_FILL_LAYER_ID = "geolibre-s2-selected-fill";
const SELECTED_LINE_LAYER_ID = "geolibre-s2-selected-line";
const PARENTS_SOURCE_ID = "geolibre-s2-parents-source";
const PARENTS_LINE_LAYER_ID = "geolibre-s2-parents-line";

const SELECTED_LINE_WIDTH = 3;

/** S2's finest subdivision (leaf cells). */
export const MAX_S2_LEVEL = 30;

/** Prevent a fine level over a large viewport from freezing the browser. */
export const S2_VIEWPORT_CELL_LIMIT = 20_000;

export interface S2GridSettings {
  /** Derive the level from the map zoom instead of the manual slider. */
  autoResolution: boolean;
  /** S2 level (0-30). Named `resolution` for parity with the H3/A5 plugins. */
  resolution: number;
  fillColor: string;
  fillOpacity: number;
  lineColor: string;
  lineWidth: number;
  showLabels: boolean;
  includeNeighbors: boolean;
  includeParents: boolean;
}

export const DEFAULT_S2_GRID_SETTINGS: S2GridSettings = {
  autoResolution: true,
  // Useful immediately at GeoLibre's default world view: level 4 tiles the
  // globe with 1,536 cells (level 6's 24,576 would already exceed the
  // viewport safety cap).
  resolution: 4,
  fillColor: "#2563eb",
  fillOpacity: 0.08,
  lineColor: "#2563eb",
  lineWidth: 1,
  showLabels: true,
  includeNeighbors: false,
  includeParents: false,
};

export interface S2Labels {
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

export const DEFAULT_S2_LABELS: S2Labels = {
  title: "S2 Grid",
  controlTitle: "S2 grid settings",
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
  identifyHint: "Click the map to identify an S2 cell.",
  selectedCell: "Selected cell",
  noSelection: "No cell selected",
  copyId: "Copy ID",
  parent: "Parent",
  children: "Children",
  neighbors: "Neighbors",
  center: "Center",
  zoomToCell: "Zoom to cell",
  addAsLayer: "Add grid as layer",
  exportGeoJson: "Export GeoJSON",
  exportCsv: "Export CSV",
  includeNeighbors: "Include selected cell neighbors",
  includeParents: "Include selected cell parent",
};

let labels: S2Labels = { ...DEFAULT_S2_LABELS };
let settings: S2GridSettings = { ...DEFAULT_S2_GRID_SETTINGS };
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
 * and each rebuild walks up to S2_VIEWPORT_CELL_LIMIT cells on the main thread.
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

export function setS2Labels(next: Partial<S2Labels>): void {
  labels = { ...labels, ...next };
  if (panelContainer) renderPanel(panelContainer);
}

export function getS2GridSettings(): S2GridSettings {
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
 * The automatic zoom→level rule, mirroring vgrid-maplibre's S2Grid
 * (https://www.npmjs.com/package/vgrid-maplibre): one S2 level per zoom
 * level, clamped to the valid range.
 */
export function s2LevelForZoom(zoom: number): number {
  return Math.min(MAX_S2_LEVEL, Math.max(0, Math.floor(zoom)));
}

/** The level actually rendered: zoom-derived when automatic, else manual. */
function effectiveLevel(): number {
  return settings.autoResolution && map ? s2LevelForZoom(map.getZoom()) : settings.resolution;
}

export function normalizeS2GridSettings(value: unknown): S2GridSettings {
  const candidate = (value ?? {}) as Partial<S2GridSettings>;
  return {
    autoResolution:
      typeof candidate.autoResolution === "boolean"
        ? candidate.autoResolution
        : DEFAULT_S2_GRID_SETTINGS.autoResolution,
    resolution: Math.round(
      clampNumber(candidate.resolution, 0, MAX_S2_LEVEL, DEFAULT_S2_GRID_SETTINGS.resolution),
    ),
    fillColor: color(candidate.fillColor, DEFAULT_S2_GRID_SETTINGS.fillColor),
    fillOpacity: clampNumber(candidate.fillOpacity, 0, 1, DEFAULT_S2_GRID_SETTINGS.fillOpacity),
    lineColor: color(candidate.lineColor, DEFAULT_S2_GRID_SETTINGS.lineColor),
    lineWidth: clampNumber(candidate.lineWidth, 0.1, 8, DEFAULT_S2_GRID_SETTINGS.lineWidth),
    showLabels:
      typeof candidate.showLabels === "boolean"
        ? candidate.showLabels
        : DEFAULT_S2_GRID_SETTINGS.showLabels,
    includeNeighbors:
      typeof candidate.includeNeighbors === "boolean"
        ? candidate.includeNeighbors
        : DEFAULT_S2_GRID_SETTINGS.includeNeighbors,
    includeParents:
      typeof candidate.includeParents === "boolean"
        ? candidate.includeParents
        : DEFAULT_S2_GRID_SETTINGS.includeParents,
  };
}

/**
 * Avoid thousands of overlapping IDs when the grid is viewed globally. S2 cell
 * area shrinks 4x per level (2x linearly), so one zoom level per S2 level
 * keeps the on-screen label density roughly constant.
 */
export function s2LabelMinZoom(level: number): number {
  return Math.min(18, Math.max(2, Math.round(level) + 1));
}

export function setS2GridSettings(patch: Partial<S2GridSettings>): void {
  const previousLevel = effectiveLevel();
  // Leaving automatic mode adopts the current zoom-derived level as the fixed
  // one, so the grid stays put instead of jumping to the stale slider.
  if (settings.autoResolution && patch.autoResolution === false && patch.resolution === undefined) {
    patch = { ...patch, resolution: previousLevel };
  }
  settings = normalizeS2GridSettings({ ...settings, ...patch });
  const level = effectiveLevel();
  // Re-derive the selection only for an explicit slider change; toggling
  // automatic resolution (like zooming in automatic mode) keeps the clicked
  // cell and its neighbors/parents as they are.
  if (selectedCell && patch.resolution !== undefined && level !== previousLevel) {
    selectedCell = reindexCell(selectedCell, level);
  }
  // Only the rendered level changes the geometry, so a paint/layout-only edit
  // skips rebuilding up to S2_VIEWPORT_CELL_LIMIT features.
  if (level !== previousLevel) {
    refresh();
  } else {
    applyStyle();
    updateSelectedSource();
  }
  if (panelContainer) renderPanel(panelContainer);
}

function cellIdFromToken(token: string): bigint {
  return s2.cellid.fromToken(token);
}

function cellCenter(id: bigint): [number, number] {
  const latLng = s2.cellid.latLng(id);
  return [s1.angle.degrees(latLng.lng), s1.angle.degrees(latLng.lat)];
}

function cellAtLonLat(lng: number, lat: number, level: number): string {
  const leaf = s2.cellid.fromLatLng(s2.LatLng.fromDegrees(lat, lng));
  return s2.cellid.toToken(s2.cellid.parent(leaf, level));
}

function reindexCell(token: string, level: number): string {
  const [lng, lat] = cellCenter(cellIdFromToken(token));
  return cellAtLonLat(lng, lat, level);
}

/**
 * The cell's four corners as a closed lon/lat ring. Cells crossing the
 * antimeridian are unwrapped relative to their first vertex so the ring stays
 * contiguous (MapLibre renders longitudes past ±180 in the adjacent world
 * copy).
 */
function cellRing(id: bigint): [number, number][] {
  const cell = s2.Cell.fromCellID(id);
  const ring: [number, number][] = [];
  for (let i = 0; i <= 4; i += 1) {
    const vertex = s2.LatLng.fromPoint(cell.vertex(i % 4));
    let lng = s1.angle.degrees(vertex.lng);
    const lat = s1.angle.degrees(vertex.lat);
    if (ring.length > 0) {
      const reference = ring[0][0];
      if (lng - reference > 180) lng -= 360;
      if (lng - reference < -180) lng += 360;
    }
    ring.push([lng, lat]);
  }
  return ring;
}

/** Convert an S2 cell (token) to a GeoJSON polygon with export attributes. */
export function s2CellFeature(cell: string): Feature<Polygon> {
  const id = cellIdFromToken(cell);
  const [lng, lat] = cellCenter(id);
  return {
    type: "Feature",
    id: cell,
    properties: {
      s2: cell,
      // S2 calls this "level"; exported as `resolution` so attribute tables
      // and CSVs read the same across the H3/S2/A5 plugins.
      resolution: s2.cellid.level(id),
      center_lat: lat,
      center_lng: lng,
    },
    geometry: { type: "Polygon", coordinates: [cellRing(id)] },
  };
}

const EARTH_AREA_M2 = 4 * Math.PI * 6371008.8 ** 2;

/** Average S2 cell area: six level-0 faces, each subdividing 4x per level. */
function avgCellAreaM2(level: number): number {
  return EARTH_AREA_M2 / (6 * 4 ** level);
}

/**
 * s2js's GeoJSON reader expects longitudes in [-180, 180] and a loop wider
 * than 180° is ambiguous (either side could be the interior), so bounds are
 * cut into chunks of at most this many degrees before covering. Cells
 * straddling a cut are returned by both chunks and deduplicated by token.
 */
const MAX_COVER_SPAN_DEGREES = 120;

/** Fill a WGS84 bounding box with S2 cells at one level. */
export function s2GridForBounds(
  bounds: [number, number, number, number],
  level: number,
  limit = S2_VIEWPORT_CELL_LIMIT,
): FeatureCollection<Polygon> {
  const [west, southRaw, east, northRaw] = bounds;
  const south = Math.max(-89.999999, Math.min(89.999999, southRaw));
  const north = Math.max(-89.999999, Math.min(89.999999, northRaw));
  const span = Math.min(360, east >= west ? east - west : east + 360 - west);
  // Reject obviously oversized requests before materializing the full result.
  // This spherical rectangle estimate is deliberately a little conservative;
  // the exact hard cap below remains the final guard.
  const radians = Math.PI / 180;
  const areaM2 =
    6371008.8 ** 2 *
    span *
    radians *
    Math.abs(Math.sin(north * radians) - Math.sin(south * radians));
  if (areaM2 / avgCellAreaM2(level) > limit * 1.2) {
    throw new RangeError(`S2 cell limit exceeded: ${limit}`);
  }

  // Normalize the west edge into [-180, 180) and split the longitude span into
  // in-range chunks (also the antimeridian handling: a crossing view becomes
  // one chunk ending at 180 and another starting at -180).
  const chunks: Array<[number, number]> = [];
  let cursor = (((west % 360) + 540) % 360) - 180;
  let remaining = span;
  while (remaining > 1e-9) {
    const step = Math.min(remaining, MAX_COVER_SPAN_DEGREES, 180 - cursor);
    chunks.push([cursor, cursor + step]);
    cursor = cursor + step >= 180 ? -180 : cursor + step;
    remaining -= step;
  }

  const coverer = new s2geojson.RegionCoverer({ minLevel: level, maxLevel: level });
  const cells = new Set<string>();
  for (const [left, right] of chunks) {
    const polygon: Polygon = {
      type: "Polygon",
      coordinates: [
        [
          [left, south],
          [right, south],
          [right, north],
          [left, north],
          [left, south],
        ],
      ],
    };
    for (const id of coverer.covering(polygon)) {
      cells.add(s2.cellid.toToken(id));
      if (cells.size > limit) {
        throw new RangeError(`S2 cell limit exceeded: ${limit}`);
      }
    }
  }
  return {
    type: "FeatureCollection",
    features: [...cells].map(s2CellFeature),
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
      minzoom: s2LabelMinZoom(effectiveLevel()),
      layout: {
        "text-field": ["get", "s2"],
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
  // (larger, overlapping) parent.
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
  map.setLayerZoomRange(LABEL_LAYER_ID, s2LabelMinZoom(effectiveLevel()), 24);
}

function refresh(): void {
  if (!map) return;
  const level = effectiveLevel();
  // The selected cell (and its neighbors/parents) deliberately stays at the
  // level it was clicked at: in automatic mode a zoom or pan changes the
  // rendered grid, but re-deriving the selection would silently replace the
  // cell the user identified. Only an explicit settings change re-indexes it
  // (see setS2GridSettings).
  try {
    const bounds = map.getBounds();
    currentGrid = s2GridForBounds(
      [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
      level,
    );
    currentError = null;
  } catch (error) {
    currentGrid = { type: "FeatureCollection", features: [] };
    currentError =
      error instanceof RangeError ? labels.tooManyCells(S2_VIEWPORT_CELL_LIMIT) : String(error);
  }
  applyStyle();
  (map.getSource(SOURCE_ID) as GeoJSONSource | undefined)?.setData(currentGrid);
  updateSelectedSource();
  if (panelContainer) renderPanel(panelContainer);
}

/** The cell plus its edge and vertex neighbors at the same level. */
function neighborCells(cell: string): string[] {
  const id = cellIdFromToken(cell);
  const level = s2.cellid.level(id);
  const tokens = new Set<string>([cell]);
  for (const neighbor of s2.cellid.allNeighbors(id, level)) {
    tokens.add(s2.cellid.toToken(neighbor));
  }
  return [...tokens];
}

function selectedCells(): string[] {
  if (!selectedCell) return [];
  return settings.includeNeighbors ? neighborCells(selectedCell) : [selectedCell];
}

/**
 * The direct parent, or none for a level-0 (face) cell. Unlike A5, S2 cells
 * nest exactly, so a cell always has a single parent.
 */
function parentCells(cell: string): string[] {
  const id = cellIdFromToken(cell);
  const level = s2.cellid.level(id);
  return level > 0 ? [s2.cellid.toToken(s2.cellid.parent(id, level - 1))] : [];
}

function updateSelectedSource(): void {
  const source = map?.getSource(SELECTED_SOURCE_ID) as GeoJSONSource | undefined;
  source?.setData({
    type: "FeatureCollection",
    features: selectedCells().map(s2CellFeature),
  });
  const parentsSource = map?.getSource(PARENTS_SOURCE_ID) as GeoJSONSource | undefined;
  parentsSource?.setData({
    type: "FeatureCollection",
    features:
      settings.includeParents && selectedCell ? parentCells(selectedCell).map(s2CellFeature) : [],
  });
}

function gridCsv(grid: FeatureCollection<Polygon>): string {
  const header = "s2,resolution,center_lat,center_lng";
  const rows = grid.features.map((feature) => {
    const p = feature.properties!;
    return [p.s2, p.resolution, p.center_lat, p.center_lng].join(",");
  });
  return [header, ...rows].join("\n");
}

function fitSelected(): void {
  if (!selectedCell || !appRef) return;
  // The ring is unwrapped to stay contiguous across the antimeridian, so
  // min/max longitudes never span the world.
  const ring = cellRing(cellIdFromToken(selectedCell));
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
    setS2GridSettings({ autoResolution: autoResolution.checked }),
  );
  row(labels.autoResolution, autoResolution);

  // In automatic mode the slider becomes a read-only indicator of the
  // zoom-derived level; refresh() re-renders the panel on every moveend, so it
  // tracks zoom gestures.
  const shownLevel = effectiveLevel();
  const resolution = document.createElement("input");
  resolution.type = "range";
  resolution.min = "0";
  resolution.max = String(MAX_S2_LEVEL);
  resolution.value = String(shownLevel);
  resolution.title = String(shownLevel);
  resolution.disabled = settings.autoResolution;
  resolution.addEventListener("input", () => {
    resolution.title = resolution.value;
  });
  resolution.addEventListener("change", () =>
    setS2GridSettings({ resolution: Number(resolution.value) }),
  );
  const resolutionWrap = document.createElement("span");
  resolutionWrap.style.display = "flex";
  resolutionWrap.style.alignItems = "center";
  resolutionWrap.style.gap = "6px";
  resolutionWrap.style.opacity = settings.autoResolution ? "0.6" : "1";
  const resolutionValue = document.createElement("strong");
  resolutionValue.textContent = String(shownLevel);
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
    // `change` (not `input`): setS2GridSettings re-renders the panel, which
    // would destroy the picker mid-drag.
    input.addEventListener("change", () => setS2GridSettings({ [key]: input.value }));
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
    input.addEventListener("change", () => setS2GridSettings({ [key]: Number(input.value) }));
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
    input.addEventListener("change", () => setS2GridSettings({ [key]: input.checked }));
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
    const id = cellIdFromToken(selectedCell);
    const cellLevel = s2.cellid.level(id);
    const [lng, lat] = cellCenter(id);
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
      details.append(dt, dd);
    };
    addDetail("ID", selectedCell);
    addDetail(labels.resolution, String(cellLevel));
    addDetail(labels.center, `${lat.toFixed(6)}, ${lng.toFixed(6)}`);
    if (cellLevel > 0) {
      addDetail(labels.parent, s2.cellid.toToken(s2.cellid.parent(id, cellLevel - 1)));
    }
    if (cellLevel < MAX_S2_LEVEL) {
      addDetail(labels.children, String(s2.cellid.children(id).length));
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
          appRef?.addGeoJsonLayer(`S2 grid (resolution ${effectiveLevel()})`, currentGrid);
        }
      },
      currentGrid.features.length === 0,
    ),
    button(
      labels.exportGeoJson,
      () => {
        appRef?.exportTextFile?.(
          `s2-grid-r${effectiveLevel()}.geojson`,
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
        appRef?.exportTextFile?.(`s2-grid-r${effectiveLevel()}.csv`, gridCsv(currentGrid), {
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

function settingsEqual(a: S2GridSettings, b: S2GridSettings): boolean {
  return Object.keys(a).every(
    (key) => a[key as keyof S2GridSettings] === b[key as keyof S2GridSettings],
  );
}

export const maplibreS2Plugin: GeoLibrePlugin = {
  id: S2_PLUGIN_ID,
  name: "S2 Grid",
  version: "1.0.0",
  activate: (app) => {
    const activeMap = app.getMap?.();
    if (!activeMap) return false;
    map = activeMap;
    appRef = app;
    moveHandler = () => scheduleRefresh();
    clickHandler = (event) => {
      selectedCell = cellAtLonLat(event.lngLat.lng, event.lngLat.lat, effectiveLevel());
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
    settingsEqual(settings, DEFAULT_S2_GRID_SETTINGS) ? undefined : { ...settings },
  applyProjectState: (_app, state) => {
    const next = normalizeS2GridSettings(state);
    if (settingsEqual(settings, next)) return false;
    settings = next;
    refresh();
  },
};
