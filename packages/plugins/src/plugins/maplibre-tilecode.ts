import type { Feature, FeatureCollection, Polygon } from "geojson";
import type { GeoJSONSource, Map as MapLibreMap, MapMouseEvent } from "maplibre-gl";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

export const TILECODE_PLUGIN_ID = "maplibre-tilecode";

const PANEL_ID = "geolibre-tilecode-panel";
const SOURCE_ID = "geolibre-tilecode-grid-source";
const FILL_LAYER_ID = "geolibre-tilecode-grid-fill";
const LINE_LAYER_ID = "geolibre-tilecode-grid-line";
const LABEL_LAYER_ID = "geolibre-tilecode-grid-label";
const SELECTED_SOURCE_ID = "geolibre-tilecode-selected-source";
const SELECTED_FILL_LAYER_ID = "geolibre-tilecode-selected-fill";
const SELECTED_LINE_LAYER_ID = "geolibre-tilecode-selected-line";
const PARENT_SOURCE_ID = "geolibre-tilecode-parent-source";
const PARENT_LINE_LAYER_ID = "geolibre-tilecode-parent-line";

const SELECTED_LINE_WIDTH = 3;

/** Prevent a deep zoom level over a large viewport from freezing the browser. */
export const TILECODE_VIEWPORT_CELL_LIMIT = 20_000;

/** Web-mercator tile zoom range (26 keeps x/y safely inside bitwise range). */
export const MIN_TILECODE_ZOOM = 0;
export const MAX_TILECODE_ZOOM = 26;

/** Every tile subdivides into 4 children (quadtree). */
export const TILECODE_CHILDREN_PER_CELL = 4;

/** Web-mercator latitude limit; tiles do not exist past it. */
const MERCATOR_MAX_LAT = 85.0511287798066;

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export interface TilecodeGridSettings {
  /** Derive the tile zoom from the map zoom instead of the manual slider. */
  autoResolution: boolean;
  /** Tile zoom level ("resolution"): 0–26. */
  resolution: number;
  fillColor: string;
  fillOpacity: number;
  lineColor: string;
  lineWidth: number;
  showLabels: boolean;
  includeNeighbors: boolean;
  includeParent: boolean;
}

export const DEFAULT_TILECODE_GRID_SETTINGS: TilecodeGridSettings = {
  autoResolution: true,
  // Useful immediately at GeoLibre's default world view: zoom 1 tiles the
  // mercator world with 4 tiles.
  resolution: 1,
  fillColor: "#0284c7",
  fillOpacity: 0.08,
  lineColor: "#0284c7",
  lineWidth: 1,
  showLabels: true,
  includeNeighbors: false,
  includeParent: false,
};

export interface TilecodeLabels {
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
  quadkey: string;
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

export const DEFAULT_TILECODE_LABELS: TilecodeLabels = {
  title: "Tilecode",
  controlTitle: "Tilecode settings",
  autoResolution: "Automatic resolution",
  resolution: "Zoom level",
  cellCount: (count) => `${count.toLocaleString()} tiles in view`,
  tooManyCells: (limit) =>
    `This view exceeds the ${limit.toLocaleString()} tile limit. Zoom in or lower the zoom level.`,
  fillColor: "Fill color",
  fillOpacity: "Fill opacity",
  lineColor: "Outline color",
  lineWidth: "Outline width",
  showLabels: "Show tile IDs",
  identifyHint: "Click the map to identify a tile.",
  selectedCell: "Selected tile",
  noSelection: "No tile selected",
  copyId: "Copy ID",
  quadkey: "Quadkey",
  parent: "Parent",
  children: "Children",
  neighbors: "Neighbors",
  center: "Center",
  zoomToCell: "Zoom to tile",
  addAsLayer: "Add grid as layer",
  exportGeoJson: "Export GeoJSON",
  exportCsv: "Export CSV",
  includeNeighbors: "Include selected tile neighbors",
  includeParent: "Include selected tile parent",
};

let labels: TilecodeLabels = { ...DEFAULT_TILECODE_LABELS };
let settings: TilecodeGridSettings = { ...DEFAULT_TILECODE_GRID_SETTINGS };
let map: MapLibreMap | null = null;
let appRef: GeoLibreAppAPI | null = null;
let unregisterPanel: (() => void) | null = null;
let moveHandler: (() => void) | null = null;
let clickHandler: ((event: MapMouseEvent) => void) | null = null;
let unsubscribeBasemap: (() => void) | null = null;
let panelContainer: HTMLElement | null = null;
/** The selected tile's tilecode, e.g. "z8x203y112" (encodes x, y, and zoom). */
let selectedCell: string | null = null;

let currentGrid: FeatureCollection<Polygon> = { type: "FeatureCollection", features: [] };
let currentError: string | null = null;
let cachedTextFont: string[] | null = null;
let pendingRefresh: number | null = null;

/** [x, y, z] web-mercator tile coordinates. */
export type Tile = [number, number, number];

/** Format a tile as vgrid-maplibre's tilecode ID. */
export function tileToTilecode([x, y, z]: Tile): string {
  return `z${z}x${x}y${y}`;
}

/** Parse a tilecode ID back to tile coordinates (null when malformed). */
export function tilecodeToTile(cell: string): Tile | null {
  const match = /^z(\d+)x(\d+)y(\d+)$/.exec(cell);
  if (!match) return null;
  const z = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);
  const size = 2 ** z;
  return z <= MAX_TILECODE_ZOOM && x < size && y < size ? [x, y, z] : null;
}

/** The Bing-style quadkey of a tile ("" for the z0 root). */
export function tileToQuadkey([x, y, z]: Tile): string {
  let key = "";
  for (let i = z; i > 0; i--) {
    let digit = 0;
    const mask = 1 << (i - 1);
    if ((x & mask) !== 0) digit += 1;
    if ((y & mask) !== 0) digit += 2;
    key += digit.toString();
  }
  return key;
}

function tileToLng(x: number, z: number): number {
  return (x / 2 ** z) * 360 - 180;
}

function tileToLat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return R2D * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/** The tile containing a point. Longitude wraps; latitude is clamped to mercator. */
export function pointToTile(lat: number, lng: number, z: number): Tile {
  const size = 2 ** z;
  const clampedLat = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat));
  const sin = Math.sin(clampedLat * D2R);
  let x = Math.floor(size * (lng / 360 + 0.5));
  x = ((x % size) + size) % size;
  const y = Math.min(
    size - 1,
    Math.max(0, Math.floor(size * (0.5 - (0.25 * Math.log((1 + sin) / (1 - sin))) / Math.PI))),
  );
  return [x, y, z];
}

/**
 * Coalesce viewport-driven rebuilds. Inertial pans emit `moveend` in bursts,
 * and each rebuild materializes up to TILECODE_VIEWPORT_CELL_LIMIT tiles on
 * the main thread.
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

export function setTilecodeLabels(next: Partial<TilecodeLabels>): void {
  labels = { ...labels, ...next };
  if (panelContainer) renderPanel(panelContainer);
}

export function getTilecodeGridSettings(): TilecodeGridSettings {
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
 * The automatic zoom→tile-zoom rule, mirroring vgrid-maplibre's TilecodeGrid
 * (https://www.npmjs.com/package/vgrid-maplibre): tiles one zoom level finer
 * than the map, clamped to the supported range.
 */
export function tilecodeResolutionForZoom(zoom: number): number {
  return Math.min(MAX_TILECODE_ZOOM, Math.max(MIN_TILECODE_ZOOM, Math.floor(zoom) + 1));
}

/** The tile zoom actually rendered: map-derived when automatic, else manual. */
function effectiveResolution(): number {
  return settings.autoResolution && map
    ? tilecodeResolutionForZoom(map.getZoom())
    : settings.resolution;
}

export function normalizeTilecodeGridSettings(value: unknown): TilecodeGridSettings {
  const candidate = (value ?? {}) as Partial<TilecodeGridSettings>;
  return {
    autoResolution:
      typeof candidate.autoResolution === "boolean"
        ? candidate.autoResolution
        : DEFAULT_TILECODE_GRID_SETTINGS.autoResolution,
    resolution: Math.round(
      clampNumber(
        candidate.resolution,
        MIN_TILECODE_ZOOM,
        MAX_TILECODE_ZOOM,
        DEFAULT_TILECODE_GRID_SETTINGS.resolution,
      ),
    ),
    fillColor: color(candidate.fillColor, DEFAULT_TILECODE_GRID_SETTINGS.fillColor),
    fillOpacity: clampNumber(
      candidate.fillOpacity,
      0,
      1,
      DEFAULT_TILECODE_GRID_SETTINGS.fillOpacity,
    ),
    lineColor: color(candidate.lineColor, DEFAULT_TILECODE_GRID_SETTINGS.lineColor),
    lineWidth: clampNumber(candidate.lineWidth, 0.1, 8, DEFAULT_TILECODE_GRID_SETTINGS.lineWidth),
    showLabels:
      typeof candidate.showLabels === "boolean"
        ? candidate.showLabels
        : DEFAULT_TILECODE_GRID_SETTINGS.showLabels,
    includeNeighbors:
      typeof candidate.includeNeighbors === "boolean"
        ? candidate.includeNeighbors
        : DEFAULT_TILECODE_GRID_SETTINGS.includeNeighbors,
    includeParent:
      typeof candidate.includeParent === "boolean"
        ? candidate.includeParent
        : DEFAULT_TILECODE_GRID_SETTINGS.includeParent,
  };
}

/**
 * Avoid thousands of overlapping IDs when the grid is viewed globally. In
 * automatic mode tiles are one zoom finer than the map, so labels are always
 * on; the floor only matters for a fixed fine resolution at a wide view.
 */
export function tilecodeLabelMinZoom(resolution: number): number {
  return Math.min(24, Math.max(2, Math.round(resolution) - 1));
}

export function setTilecodeGridSettings(patch: Partial<TilecodeGridSettings>): void {
  const previousResolution = effectiveResolution();
  // Leaving automatic mode adopts the current map-derived tile zoom as the
  // fixed one, so the grid stays put instead of jumping to the stale slider.
  if (settings.autoResolution && patch.autoResolution === false && patch.resolution === undefined) {
    patch = { ...patch, resolution: previousResolution };
  }
  settings = normalizeTilecodeGridSettings({ ...settings, ...patch });
  const resolution = effectiveResolution();
  // Re-derive the selection only for an explicit zoom-level change; toggling
  // automatic resolution (like zooming in automatic mode) keeps the clicked
  // tile and its neighbors/parent as they are.
  if (selectedCell && patch.resolution !== undefined && resolution !== previousResolution) {
    const tile = tilecodeToTile(selectedCell);
    if (tile) {
      const [west, south, east, north] = tileBounds(tile);
      selectedCell = tileToTilecode(
        pointToTile((south + north) / 2, (west + east) / 2, resolution),
      );
    }
  }
  // Only the rendered tile zoom changes the geometry, so a paint/layout-only
  // edit skips rebuilding up to TILECODE_VIEWPORT_CELL_LIMIT features.
  if (resolution !== previousResolution) {
    refresh();
  } else {
    applyStyle();
    updateSelectedSource();
  }
  if (panelContainer) renderPanel(panelContainer);
}

/** [west, south, east, north] of a tile in degrees. */
function tileBounds([x, y, z]: Tile): [number, number, number, number] {
  return [tileToLng(x, z), tileToLat(y + 1, z), tileToLng(x + 1, z), tileToLat(y, z)];
}

/**
 * Convert a tile to a GeoJSON polygon with export attributes (tilecode and
 * quadkey IDs, like vgrid-maplibre). `lngOffset` (a multiple of 360) places
 * the ring in the world copy a dateline-crossing viewport is looking at.
 */
export function tilecodeCellFeature(cell: string, lngOffset = 0): Feature<Polygon> {
  const tile = tilecodeToTile(cell);
  if (!tile) throw new Error(`Invalid tilecode: ${cell}`);
  const [west, south, east, north] = tileBounds(tile);
  return {
    type: "Feature",
    id: cell,
    properties: {
      tilecode: cell,
      quadkey: tileToQuadkey(tile),
      resolution: tile[2],
      center_lat: (south + north) / 2,
      center_lng: (west + east) / 2,
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
 * Fill a WGS84 bounding box with web-mercator tiles, mirroring
 * vgrid-maplibre's TilecodeGrid. Longitudes may run past ±180 (MapLibre's
 * continuous bounds); the tile columns walk the continuous range and each is
 * normalized into [0, 2^z) for its ID but drawn in the viewport's world copy.
 */
export function tilecodeGridForBounds(
  bounds: [number, number, number, number],
  resolution: number,
  limit = TILECODE_VIEWPORT_CELL_LIMIT,
): FeatureCollection<Polygon> {
  let [west, south, east, north] = bounds;
  south = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, south));
  north = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, north));
  if (east - west >= 360) {
    west = -180;
    east = 180 - 1e-9;
  }
  const size = 2 ** resolution;
  // Unwrapped (continuous) tile columns so dateline-crossing views keep their
  // world copy; rows come from the mercator projection of the lat range.
  const minColumn = Math.floor(size * (west / 360 + 0.5));
  const maxColumn = Math.floor(size * (east / 360 + 0.5));
  const [, minRow] = pointToTile(north, 0, resolution);
  const [, maxRow] = pointToTile(south, 0, resolution);

  if ((maxColumn - minColumn + 1) * (maxRow - minRow + 1) > limit * 1.2) {
    throw new RangeError(`Tilecode tile limit exceeded: ${limit}`);
  }

  const features: Feature<Polygon>[] = [];
  for (let column = minColumn; column <= maxColumn; column++) {
    const x = ((column % size) + size) % size;
    const lngOffset = ((column - x) / size) * 360;
    for (let y = minRow; y <= maxRow; y++) {
      features.push(tilecodeCellFeature(tileToTilecode([x, y, resolution]), lngOffset));
      if (features.length > limit) {
        throw new RangeError(`Tilecode tile limit exceeded: ${limit}`);
      }
    }
  }
  return { type: "FeatureCollection", features };
}

/**
 * Tiles form a strict quadtree, so a tile has exactly one parent (null at
 * the z0 root).
 */
export function tilecodeParentCell(cell: string): string | null {
  const tile = tilecodeToTile(cell);
  if (!tile || tile[2] <= MIN_TILECODE_ZOOM) return null;
  return tileToTilecode([tile[0] >> 1, tile[1] >> 1, tile[2] - 1]);
}

/**
 * The tile plus its (up to 8) surrounding tiles: x wraps around the world,
 * y is clipped at the mercator top and bottom rows.
 */
export function tilecodeNeighborCells(cell: string): string[] {
  const tile = tilecodeToTile(cell);
  if (!tile) return [cell];
  const [x, y, z] = tile;
  const size = 2 ** z;
  const ids = new Set<string>([cell]);
  for (const dx of [-1, 0, 1]) {
    for (const dy of [-1, 0, 1]) {
      if (dx === 0 && dy === 0) continue;
      const ny = y + dy;
      if (ny < 0 || ny >= size) continue;
      const nx = (((x + dx) % size) + size) % size;
      ids.add(tileToTilecode([nx, ny, z]));
    }
  }
  return [...ids];
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
      minzoom: tilecodeLabelMinZoom(effectiveResolution()),
      layout: {
        "text-field": ["get", "tilecode"],
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
  // Added before the selected layers so the selected tile stays on top of its
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
  map.setLayerZoomRange(LABEL_LAYER_ID, tilecodeLabelMinZoom(effectiveResolution()), 24);
}

function refresh(): void {
  if (!map) return;
  const resolution = effectiveResolution();
  // The selected tile (and its neighbors/parent) deliberately stays at the
  // zoom level it was clicked at: in automatic mode a zoom or pan changes the
  // rendered grid, but re-deriving the selection would silently replace the
  // tile the user identified. Only an explicit settings change re-indexes it
  // (see setTilecodeGridSettings).
  try {
    const bounds = map.getBounds();
    currentGrid = tilecodeGridForBounds(
      [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
      resolution,
    );
    currentError = null;
  } catch (error) {
    currentGrid = { type: "FeatureCollection", features: [] };
    currentError =
      error instanceof RangeError
        ? labels.tooManyCells(TILECODE_VIEWPORT_CELL_LIMIT)
        : String(error);
  }
  applyStyle();
  (map.getSource(SOURCE_ID) as GeoJSONSource | undefined)?.setData(currentGrid);
  updateSelectedSource();
  if (panelContainer) renderPanel(panelContainer);
}

function selectedCells(): string[] {
  if (!selectedCell) return [];
  return settings.includeNeighbors ? tilecodeNeighborCells(selectedCell) : [selectedCell];
}

function updateSelectedSource(): void {
  const source = map?.getSource(SELECTED_SOURCE_ID) as GeoJSONSource | undefined;
  source?.setData({
    type: "FeatureCollection",
    features: selectedCells().map((cell) => tilecodeCellFeature(cell)),
  });
  const parent = settings.includeParent && selectedCell ? tilecodeParentCell(selectedCell) : null;
  const parentSource = map?.getSource(PARENT_SOURCE_ID) as GeoJSONSource | undefined;
  parentSource?.setData({
    type: "FeatureCollection",
    features: parent ? [tilecodeCellFeature(parent)] : [],
  });
}

function gridCsv(grid: FeatureCollection<Polygon>): string {
  const header = "tilecode,quadkey,resolution,center_lat,center_lng";
  const rows = grid.features.map((feature) => {
    const p = feature.properties!;
    return [p.tilecode, p.quadkey, p.resolution, p.center_lat, p.center_lng].join(",");
  });
  return [header, ...rows].join("\n");
}

function fitSelected(): void {
  if (!selectedCell || !appRef) return;
  const tile = tilecodeToTile(selectedCell);
  if (tile) appRef.fitBounds?.(tileBounds(tile));
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
    setTilecodeGridSettings({ autoResolution: autoResolution.checked }),
  );
  row(labels.autoResolution, autoResolution);

  // In automatic mode the slider becomes a read-only indicator of the
  // map-derived tile zoom; refresh() re-renders the panel on every moveend,
  // so it tracks zoom gestures.
  const shownResolution = effectiveResolution();
  const resolution = document.createElement("input");
  resolution.type = "range";
  resolution.min = String(MIN_TILECODE_ZOOM);
  resolution.max = String(MAX_TILECODE_ZOOM);
  resolution.value = String(shownResolution);
  resolution.title = String(shownResolution);
  resolution.disabled = settings.autoResolution;
  resolution.addEventListener("input", () => {
    resolution.title = resolution.value;
  });
  resolution.addEventListener("change", () =>
    setTilecodeGridSettings({ resolution: Number(resolution.value) }),
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
    // `change` (not `input`): setTilecodeGridSettings re-renders the panel,
    // which would destroy the picker mid-drag.
    input.addEventListener("change", () => setTilecodeGridSettings({ [key]: input.value }));
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
    input.addEventListener("change", () => setTilecodeGridSettings({ [key]: Number(input.value) }));
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
    input.addEventListener("change", () => setTilecodeGridSettings({ [key]: input.checked }));
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

  const selectedTile = selectedCell ? tilecodeToTile(selectedCell) : null;
  if (selectedCell && selectedTile) {
    const [west, south, east, north] = tileBounds(selectedTile);
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
    addDetail(labels.quadkey, tileToQuadkey(selectedTile) || "—");
    addDetail(labels.resolution, String(selectedTile[2]));
    addDetail(
      labels.center,
      `${((south + north) / 2).toFixed(6)}, ${((west + east) / 2).toFixed(6)}`,
    );
    const parent = tilecodeParentCell(selectedCell);
    if (parent) addDetail(labels.parent, parent);
    if (selectedTile[2] < MAX_TILECODE_ZOOM) {
      addDetail(labels.children, String(TILECODE_CHILDREN_PER_CELL));
    }
    addDetail(labels.neighbors, String(tilecodeNeighborCells(selectedCell).length - 1));
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
          appRef?.addGeoJsonLayer(`Tilecode (zoom ${effectiveResolution()})`, currentGrid);
        }
      },
      currentGrid.features.length === 0,
    ),
    button(
      labels.exportGeoJson,
      () => {
        appRef?.exportTextFile?.(
          `tilecode-z${effectiveResolution()}.geojson`,
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
        appRef?.exportTextFile?.(`tilecode-z${effectiveResolution()}.csv`, gridCsv(currentGrid), {
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

function settingsEqual(a: TilecodeGridSettings, b: TilecodeGridSettings): boolean {
  return Object.keys(a).every(
    (key) => a[key as keyof TilecodeGridSettings] === b[key as keyof TilecodeGridSettings],
  );
}

export const maplibreTilecodePlugin: GeoLibrePlugin = {
  id: TILECODE_PLUGIN_ID,
  name: "Tilecode",
  version: "1.0.0",
  activate: (app) => {
    const activeMap = app.getMap?.();
    if (!activeMap) return false;
    map = activeMap;
    appRef = app;
    moveHandler = () => scheduleRefresh();
    clickHandler = (event) => {
      selectedCell = tileToTilecode(
        pointToTile(event.lngLat.lat, event.lngLat.lng, effectiveResolution()),
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
        // Closing the panel ends the identify session: drop the clicked tile
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
    settingsEqual(settings, DEFAULT_TILECODE_GRID_SETTINGS) ? undefined : { ...settings },
  applyProjectState: (_app, state) => {
    const next = normalizeTilecodeGridSettings(state);
    if (settingsEqual(settings, next)) return false;
    settings = next;
    refresh();
  },
};
