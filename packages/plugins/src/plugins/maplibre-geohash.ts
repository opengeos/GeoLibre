import type { Feature, FeatureCollection, Polygon } from "geojson";
import type { GeoJSONSource, Map as MapLibreMap, MapMouseEvent } from "maplibre-gl";
import geohash from "ngeohash";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

export const GEOHASH_PLUGIN_ID = "maplibre-geohash";

const PANEL_ID = "geolibre-geohash-panel";
const SOURCE_ID = "geolibre-geohash-grid-source";
const FILL_LAYER_ID = "geolibre-geohash-grid-fill";
const LINE_LAYER_ID = "geolibre-geohash-grid-line";
const LABEL_LAYER_ID = "geolibre-geohash-grid-label";
const SELECTED_SOURCE_ID = "geolibre-geohash-selected-source";
const SELECTED_FILL_LAYER_ID = "geolibre-geohash-selected-fill";
const SELECTED_LINE_LAYER_ID = "geolibre-geohash-selected-line";
const PARENT_SOURCE_ID = "geolibre-geohash-parent-source";
const PARENT_LINE_LAYER_ID = "geolibre-geohash-parent-line";

const SELECTED_LINE_WIDTH = 3;

/** Prevent a fine precision over a large viewport from freezing the browser. */
export const GEOHASH_VIEWPORT_CELL_LIMIT = 20_000;

/** Geohash character precision: each step adds 5 bits of lat/lon. */
export const MIN_GEOHASH_PRECISION = 1;
export const MAX_GEOHASH_PRECISION = 12;

/** Every geohash cell subdivides into 32 children (base32 alphabet). */
export const GEOHASH_CHILDREN_PER_CELL = 32;

export interface GeohashGridSettings {
  /** Derive the precision from the map zoom instead of the manual slider. */
  autoResolution: boolean;
  /** Character precision ("resolution"): 1–12. */
  resolution: number;
  fillColor: string;
  fillOpacity: number;
  lineColor: string;
  lineWidth: number;
  showLabels: boolean;
  includeNeighbors: boolean;
  includeParent: boolean;
}

export const DEFAULT_GEOHASH_GRID_SETTINGS: GeohashGridSettings = {
  autoResolution: true,
  // Useful immediately at GeoLibre's default world view: precision 1 tiles
  // the globe with 32 forty-five-degree cells.
  resolution: 1,
  fillColor: "#7c3aed",
  fillOpacity: 0.08,
  lineColor: "#7c3aed",
  lineWidth: 1,
  showLabels: true,
  includeNeighbors: false,
  includeParent: false,
};

export interface GeohashLabels {
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
  includeParent: string;
}

export const DEFAULT_GEOHASH_LABELS: GeohashLabels = {
  title: "Geohash",
  controlTitle: "Geohash settings",
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
  identifyHint: "Click the map to identify a Geohash cell.",
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
  includeParent: "Include selected cell parent",
};

let labels: GeohashLabels = { ...DEFAULT_GEOHASH_LABELS };
let settings: GeohashGridSettings = { ...DEFAULT_GEOHASH_GRID_SETTINGS };
let map: MapLibreMap | null = null;
let appRef: GeoLibreAppAPI | null = null;
let unregisterPanel: (() => void) | null = null;
let moveHandler: (() => void) | null = null;
let clickHandler: ((event: MapMouseEvent) => void) | null = null;
let unsubscribeBasemap: (() => void) | null = null;
let panelContainer: HTMLElement | null = null;
/** The selected cell's geohash (its length is its precision). */
let selectedCell: string | null = null;

let currentGrid: FeatureCollection<Polygon> = { type: "FeatureCollection", features: [] };
let currentError: string | null = null;
let cachedTextFont: string[] | null = null;
let pendingRefresh: number | null = null;

/**
 * Coalesce viewport-driven rebuilds. Inertial pans emit `moveend` in bursts,
 * and each rebuild materializes up to GEOHASH_VIEWPORT_CELL_LIMIT cells on the
 * main thread.
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

export function setGeohashLabels(next: Partial<GeohashLabels>): void {
  labels = { ...labels, ...next };
  if (panelContainer) renderPanel(panelContainer);
}

export function getGeohashGridSettings(): GeohashGridSettings {
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

/** Wrap a longitude into (−180, 180] so ngeohash's clamp-to-range encode is well-defined. */
function wrapLongitude(lng: number): number {
  const wrapped = ((((lng + 180) % 360) + 360) % 360) - 180;
  // MapLibre's continuous world uses 180 as the east edge of the base copy;
  // ngeohash treats 180 as the west edge of that same cell, so keep −180.
  return wrapped === -180 ? -180 : wrapped === 180 ? -180 : wrapped;
}

/**
 * The automatic zoom→precision rule, mirroring vgrid-maplibre's GeohashGrid
 * (https://www.npmjs.com/package/vgrid-maplibre): `floor(zoom * 0.45)`,
 * clamped to the usable precision range. (vgrid's published clamp starts at
 * 0, but precision 0 is not a valid geohash, so we raise the floor to 1.)
 */
export function geohashResolutionForZoom(zoom: number): number {
  return Math.min(MAX_GEOHASH_PRECISION, Math.max(MIN_GEOHASH_PRECISION, Math.floor(zoom * 0.45)));
}

/** The precision actually rendered: zoom-derived when automatic, else manual. */
function effectiveResolution(): number {
  return settings.autoResolution && map
    ? geohashResolutionForZoom(map.getZoom())
    : settings.resolution;
}

export function normalizeGeohashGridSettings(value: unknown): GeohashGridSettings {
  const candidate = (value ?? {}) as Partial<GeohashGridSettings>;
  return {
    autoResolution:
      typeof candidate.autoResolution === "boolean"
        ? candidate.autoResolution
        : DEFAULT_GEOHASH_GRID_SETTINGS.autoResolution,
    resolution: Math.round(
      clampNumber(
        candidate.resolution,
        MIN_GEOHASH_PRECISION,
        MAX_GEOHASH_PRECISION,
        DEFAULT_GEOHASH_GRID_SETTINGS.resolution,
      ),
    ),
    fillColor: color(candidate.fillColor, DEFAULT_GEOHASH_GRID_SETTINGS.fillColor),
    fillOpacity: clampNumber(
      candidate.fillOpacity,
      0,
      1,
      DEFAULT_GEOHASH_GRID_SETTINGS.fillOpacity,
    ),
    lineColor: color(candidate.lineColor, DEFAULT_GEOHASH_GRID_SETTINGS.lineColor),
    lineWidth: clampNumber(candidate.lineWidth, 0.1, 8, DEFAULT_GEOHASH_GRID_SETTINGS.lineWidth),
    showLabels:
      typeof candidate.showLabels === "boolean"
        ? candidate.showLabels
        : DEFAULT_GEOHASH_GRID_SETTINGS.showLabels,
    includeNeighbors:
      typeof candidate.includeNeighbors === "boolean"
        ? candidate.includeNeighbors
        : DEFAULT_GEOHASH_GRID_SETTINGS.includeNeighbors,
    includeParent:
      typeof candidate.includeParent === "boolean"
        ? candidate.includeParent
        : DEFAULT_GEOHASH_GRID_SETTINGS.includeParent,
  };
}

/**
 * Avoid thousands of overlapping IDs when the grid is viewed globally.
 * Precision grows roughly every 2¼ zoom levels (`1 / 0.45`), so labels appear
 * about one step below the zoom that would pick the next finer precision.
 */
export function geohashLabelMinZoom(precision: number): number {
  return Math.min(22, Math.max(2, Math.round(precision / 0.45) - 1));
}

export function setGeohashGridSettings(patch: Partial<GeohashGridSettings>): void {
  const previousResolution = effectiveResolution();
  // Leaving automatic mode adopts the current zoom-derived precision as the
  // fixed one, so the grid stays put instead of jumping to the stale slider.
  if (settings.autoResolution && patch.autoResolution === false && patch.resolution === undefined) {
    patch = { ...patch, resolution: previousResolution };
  }
  settings = normalizeGeohashGridSettings({ ...settings, ...patch });
  const resolution = effectiveResolution();
  // Re-derive the selection only for an explicit precision change; toggling
  // automatic resolution (like zooming in automatic mode) keeps the clicked
  // cell and its neighbors/parent as they are.
  if (selectedCell && patch.resolution !== undefined && resolution !== previousResolution) {
    const { latitude, longitude } = geohash.decode(selectedCell);
    selectedCell = geohash.encode(latitude, longitude, resolution);
  }
  // Only the rendered precision changes the geometry, so a paint/layout-only
  // edit skips rebuilding up to GEOHASH_VIEWPORT_CELL_LIMIT features.
  if (resolution !== previousResolution) {
    refresh();
  } else {
    applyStyle();
    updateSelectedSource();
  }
  if (panelContainer) renderPanel(panelContainer);
}

/**
 * Convert a geohash to a GeoJSON polygon with export attributes. `lngOffset`
 * (a multiple of 360) places the ring in the world copy a dateline-crossing
 * viewport is actually looking at — ngeohash always returns normalized
 * longitudes in (−180, 180].
 */
export function geohashCellFeature(cell: string, lngOffset = 0): Feature<Polygon> {
  const [south, west, north, east] = geohash.decode_bbox(cell);
  const { latitude, longitude } = geohash.decode(cell);
  return {
    type: "Feature",
    id: cell,
    properties: {
      geohash: cell,
      resolution: cell.length,
      center_lat: latitude,
      center_lng: longitude,
    },
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [west + lngOffset, south],
          [east + lngOffset, south],
          [east + lngOffset, north],
          [west + lngOffset, north],
          [west + lngOffset, south],
        ],
      ],
    },
  };
}

/**
 * Fill a WGS84 bounding box with geohash cells, mirroring vgrid-maplibre's
 * GeohashGrid: cells are an axis-aligned lat/lon grid, so the fill walks the
 * rows and columns intersecting the box. Longitudes may run past ±180
 * (MapLibre's continuous bounds); each cell is encoded from its wrapped
 * centroid but drawn in the viewport's world copy.
 */
export function geohashGridForBounds(
  bounds: [number, number, number, number],
  precision: number,
  limit = GEOHASH_VIEWPORT_CELL_LIMIT,
): FeatureCollection<Polygon> {
  let [west, south, east, north] = bounds;
  south = Math.max(-90, Math.min(90, south));
  north = Math.max(-90, Math.min(90, north));
  if (east - west >= 360) {
    west = -180;
    east = 180;
  }
  // Odd/even precisions swap which axis gets the extra bit, so measure both
  // dimensions from a reference cell rather than hard-coding the table.
  const [refSouth, refWest, refNorth, refEast] = geohash.decode_bbox(
    geohash.encode(0, 0, precision),
  );
  const latHeight = refNorth - refSouth;
  const lngWidth = refEast - refWest;

  if (((east - west) / lngWidth) * ((north - south) / latHeight) > limit * 1.2) {
    throw new RangeError(`Geohash cell limit exceeded: ${limit}`);
  }

  const startLng = Math.floor((west + 180) / lngWidth) * lngWidth - 180;
  const startLat = Math.max(-90, Math.floor((south + 90) / latHeight) * latHeight - 90);

  const features: Feature<Polygon>[] = [];
  // Floating-point walks of the grid can land on the same cell twice near
  // cell boundaries; key by (id, world copy) so a dateline-crossing view can
  // still draw the same hash in two adjacent copies.
  const seen = new Set<string>();
  for (let lng = startLng; lng < east; lng += lngWidth) {
    for (let lat = startLat; lat < north && lat < 90; lat += latHeight) {
      const centerLng = lng + lngWidth / 2;
      const centerLat = lat + latHeight / 2;
      const cell = geohash.encode(centerLat, wrapLongitude(centerLng), precision);
      const [, cellWest, , cellEast] = geohash.decode_bbox(cell);
      const lngOffset = Math.round((centerLng - (cellWest + cellEast) / 2) / 360) * 360;
      const key = `${cell}@${lngOffset}`;
      if (seen.has(key)) continue;
      seen.add(key);
      features.push(geohashCellFeature(cell, lngOffset));
      if (features.length > limit) {
        throw new RangeError(`Geohash cell limit exceeded: ${limit}`);
      }
    }
  }
  return { type: "FeatureCollection", features };
}

/**
 * Geohash is a strictly nested grid, so a cell has exactly one parent: the
 * hash with its last character removed.
 */
export function geohashParentCell(cell: string): string | null {
  return cell.length > MIN_GEOHASH_PRECISION ? cell.slice(0, -1) : null;
}

/**
 * The cell plus its surrounding grid cells. `ngeohash.neighbors` returns the
 * 8-adjacent set and can emit duplicates near the poles, so we dedupe.
 */
export function geohashNeighborCells(cell: string): string[] {
  return [...new Set([cell, ...geohash.neighbors(cell)])];
}

function removeLayers(activeMap: MapLibreMap): void {
  for (const id of [
    SELECTED_LINE_LAYER_ID,
    SELECTED_FILL_LAYER_ID,
    PARENT_LINE_LAYER_ID,
    LABEL_LAYER_ID,
    LINE_LAYER_ID,
    FILL_LAYER_ID,
  ]) {
    if (activeMap.getLayer(id)) activeMap.removeLayer(id);
  }
  for (const id of [SELECTED_SOURCE_ID, PARENT_SOURCE_ID, SOURCE_ID]) {
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
      minzoom: geohashLabelMinZoom(effectiveResolution()),
      layout: {
        "text-field": ["get", "geohash"],
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
  // (larger, surrounding) parent.
  if (!map.getSource(PARENT_SOURCE_ID)) {
    map.addSource(PARENT_SOURCE_ID, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addLayer({
      id: PARENT_LINE_LAYER_ID,
      type: "line",
      source: PARENT_SOURCE_ID,
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
  map.setLayerZoomRange(LABEL_LAYER_ID, geohashLabelMinZoom(effectiveResolution()), 24);
}

function refresh(): void {
  if (!map) return;
  const resolution = effectiveResolution();
  // The selected cell (and its neighbors/parent) deliberately stays at the
  // precision it was clicked at: in automatic mode a zoom or pan changes the
  // rendered grid, but re-deriving the selection would silently replace the
  // cell the user identified. Only an explicit settings change re-indexes it
  // (see setGeohashGridSettings).
  try {
    const bounds = map.getBounds();
    currentGrid = geohashGridForBounds(
      [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
      resolution,
    );
    currentError = null;
  } catch (error) {
    currentGrid = { type: "FeatureCollection", features: [] };
    currentError =
      error instanceof RangeError
        ? labels.tooManyCells(GEOHASH_VIEWPORT_CELL_LIMIT)
        : String(error);
  }
  applyStyle();
  (map.getSource(SOURCE_ID) as GeoJSONSource | undefined)?.setData(currentGrid);
  updateSelectedSource();
  if (panelContainer) renderPanel(panelContainer);
}

function selectedCells(): string[] {
  if (!selectedCell) return [];
  return settings.includeNeighbors ? geohashNeighborCells(selectedCell) : [selectedCell];
}

function updateSelectedSource(): void {
  const source = map?.getSource(SELECTED_SOURCE_ID) as GeoJSONSource | undefined;
  source?.setData({
    type: "FeatureCollection",
    features: selectedCells().map((cell) => geohashCellFeature(cell)),
  });
  const parent = settings.includeParent && selectedCell ? geohashParentCell(selectedCell) : null;
  const parentSource = map?.getSource(PARENT_SOURCE_ID) as GeoJSONSource | undefined;
  parentSource?.setData({
    type: "FeatureCollection",
    features: parent ? [geohashCellFeature(parent)] : [],
  });
}

function gridCsv(grid: FeatureCollection<Polygon>): string {
  const header = "geohash,resolution,center_lat,center_lng";
  const rows = grid.features.map((feature) => {
    const p = feature.properties!;
    return [p.geohash, p.resolution, p.center_lat, p.center_lng].join(",");
  });
  return [header, ...rows].join("\n");
}

function fitSelected(): void {
  if (!selectedCell || !appRef) return;
  const [south, west, north, east] = geohash.decode_bbox(selectedCell);
  appRef.fitBounds?.([west, south, east, north]);
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
    setGeohashGridSettings({ autoResolution: autoResolution.checked }),
  );
  row(labels.autoResolution, autoResolution);

  // In automatic mode the slider becomes a read-only indicator of the
  // zoom-derived precision; refresh() re-renders the panel on every moveend,
  // so it tracks zoom gestures.
  const shownResolution = effectiveResolution();
  const resolution = document.createElement("input");
  resolution.type = "range";
  resolution.min = String(MIN_GEOHASH_PRECISION);
  resolution.max = String(MAX_GEOHASH_PRECISION);
  resolution.value = String(shownResolution);
  resolution.title = String(shownResolution);
  resolution.disabled = settings.autoResolution;
  resolution.addEventListener("input", () => {
    resolution.title = resolution.value;
  });
  resolution.addEventListener("change", () =>
    setGeohashGridSettings({ resolution: Number(resolution.value) }),
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
    // `change` (not `input`): setGeohashGridSettings re-renders the panel,
    // which would destroy the picker mid-drag.
    input.addEventListener("change", () => setGeohashGridSettings({ [key]: input.value }));
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
    input.addEventListener("change", () => setGeohashGridSettings({ [key]: Number(input.value) }));
    row(text, input);
  }
  for (const [text, key] of [
    [labels.showLabels, "showLabels"],
    [labels.includeNeighbors, "includeNeighbors"],
    [labels.includeParent, "includeParent"],
  ] as const) {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = settings[key];
    input.addEventListener("change", () => setGeohashGridSettings({ [key]: input.checked }));
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
    const { latitude, longitude } = geohash.decode(selectedCell);
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
    addDetail(labels.resolution, String(selectedCell.length));
    addDetail(labels.center, `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`);
    const parent = geohashParentCell(selectedCell);
    if (parent) addDetail(labels.parent, parent);
    if (selectedCell.length < MAX_GEOHASH_PRECISION) {
      addDetail(labels.children, String(GEOHASH_CHILDREN_PER_CELL));
    }
    addDetail(labels.neighbors, String(geohashNeighborCells(selectedCell).length - 1));
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
          appRef?.addGeoJsonLayer(`Geohash (res ${effectiveResolution()})`, currentGrid);
        }
      },
      currentGrid.features.length === 0,
    ),
    button(
      labels.exportGeoJson,
      () => {
        appRef?.exportTextFile?.(
          `geohash-p${effectiveResolution()}.geojson`,
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
        appRef?.exportTextFile?.(`geohash-p${effectiveResolution()}.csv`, gridCsv(currentGrid), {
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

function settingsEqual(a: GeohashGridSettings, b: GeohashGridSettings): boolean {
  return Object.keys(a).every(
    (key) => a[key as keyof GeohashGridSettings] === b[key as keyof GeohashGridSettings],
  );
}

export const maplibreGeohashPlugin: GeoLibrePlugin = {
  id: GEOHASH_PLUGIN_ID,
  name: "Geohash",
  version: "1.0.0",
  activate: (app) => {
    const activeMap = app.getMap?.();
    if (!activeMap) return false;
    map = activeMap;
    appRef = app;
    moveHandler = () => scheduleRefresh();
    clickHandler = (event) => {
      selectedCell = geohash.encode(
        event.lngLat.lat,
        wrapLongitude(event.lngLat.lng),
        effectiveResolution(),
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
    settingsEqual(settings, DEFAULT_GEOHASH_GRID_SETTINGS) ? undefined : { ...settings },
  applyProjectState: (_app, state) => {
    const next = normalizeGeohashGridSettings(state);
    if (settingsEqual(settings, next)) return false;
    settings = next;
    refresh();
  },
};
