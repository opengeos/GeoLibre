import type { Feature, FeatureCollection, Polygon, Position } from "geojson";
import type { GeoJSONSource, Map as MapLibreMap, MapMouseEvent } from "maplibre-gl";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

export const DGGRID_PLUGIN_ID = "maplibre-dggrid";

const PANEL_ID = "geolibre-dggrid-panel";
const SOURCE_ID = "geolibre-dggrid-grid-source";
const FILL_LAYER_ID = "geolibre-dggrid-grid-fill";
const LINE_LAYER_ID = "geolibre-dggrid-grid-line";
const LABEL_LAYER_ID = "geolibre-dggrid-grid-label";
const SELECTED_SOURCE_ID = "geolibre-dggrid-selected-source";
const SELECTED_FILL_LAYER_ID = "geolibre-dggrid-selected-fill";
const SELECTED_LINE_LAYER_ID = "geolibre-dggrid-selected-line";
const PARENTS_SOURCE_ID = "geolibre-dggrid-parents-source";
const PARENTS_LINE_LAYER_ID = "geolibre-dggrid-parents-line";

const SELECTED_LINE_WIDTH = 3;

/** vgrid-maplibre's DGGRID maxResolution default. */
export const MAX_DGGRID_RESOLUTION = 21;

/** Prevent a fine resolution over a large viewport from freezing the browser. */
export const DGGRID_VIEWPORT_CELL_LIMIT = 20_000;

/** Cell shapes DGGRID supports (the panel labels this "Cell type"). */
export const DGGRID_TOPOLOGIES = ["HEXAGON", "DIAMOND", "TRIANGLE"] as const;
export type DggridTopology = (typeof DGGRID_TOPOLOGIES)[number];

/** Projections placing the icosahedron faces onto the sphere. */
export const DGGRID_PROJECTIONS = ["ISEA", "FULLER"] as const;
export type DggridProjection = (typeof DGGRID_PROJECTIONS)[number];

/**
 * Subdivision apertures the engine accepts for hexagons. DIAMOND and
 * TRIANGLE grids only exist with aperture 4 — any other value aborts the
 * WASM engine with `DgIDGGS::makeRF(): invalid aperture` — so normalization
 * pins them to 4.
 */
export const DGGRID_APERTURES = [3, 4, 7] as const;
export type DggridAperture = (typeof DGGRID_APERTURES)[number];

/** A DGGS configuration accepted by webdggrid's `setDggs`. */
export interface DggridConfig {
  poleCoordinates: { lat: number; lng: number };
  azimuth: number;
  topology: DggridTopology;
  projection: DggridProjection;
  aperture?: DggridAperture;
}

/**
 * The subset of a webdggrid `Webdggrid` instance this plugin uses. The
 * package's root typings only describe the async loader — the full class
 * declaration sits behind a subpath export whose declared file casing does
 * not exist on disk — so the shape is mirrored here and the loaded instance
 * is cast to it.
 */
export interface DggridEngine {
  setDggs(dggs: DggridConfig, resolution: number): void;
  cellAreaKM(resolution?: number): number;
  geoToSequenceNum(coordinates: number[][], resolution?: number): bigint[];
  sequenceNumToGeo(sequenceNum: bigint[], resolution?: number): Position[];
  sequenceNumToGrid(sequenceNum: bigint[], resolution?: number, unwrap?: boolean): Position[][];
  sequenceNumNeighbors(sequenceNum: bigint[], resolution?: number): bigint[][];
  sequenceNumParent(sequenceNum: bigint[], resolution?: number): bigint[];
  sequenceNumAllParents(sequenceNum: bigint[], resolution?: number): bigint[][];
  sequenceNumChildren(sequenceNum: bigint[], resolution?: number): bigint[][];
}

/**
 * The default DGGS: ISEA4H (icosahedral Snyder equal-area, aperture-4
 * hexagons), vgrid-maplibre's DGGRID default configuration. The panel's Cell
 * type / Projection / Aperture pickers derive variations of it.
 */
export const DGGRID_CONFIG: DggridConfig = {
  poleCoordinates: { lat: 0, lng: 0 },
  azimuth: 0,
  topology: "HEXAGON",
  projection: "ISEA",
  aperture: 4,
};

export interface DggridGridSettings {
  /** Cell shape ("Cell type" in the panel). Non-hexagon pins aperture to 4. */
  topology: DggridTopology;
  projection: DggridProjection;
  aperture: DggridAperture;
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

export const DEFAULT_DGGRID_GRID_SETTINGS: DggridGridSettings = {
  topology: "HEXAGON",
  projection: "ISEA",
  aperture: 4,
  autoResolution: true,
  // Useful immediately at GeoLibre's default world view: resolution 3 tiles
  // the globe with 642 aperture-4 hexagons.
  resolution: 3,
  fillColor: "#9333ea",
  fillOpacity: 0.08,
  lineColor: "#9333ea",
  lineWidth: 1,
  showLabels: true,
  includeNeighbors: false,
  includeParents: false,
};

export interface DggridLabels {
  title: string;
  getTitle?: () => string;
  controlTitle: string;
  cellType: string;
  topologyHexagon: string;
  topologyDiamond: string;
  topologyTriangle: string;
  projection: string;
  aperture: string;
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

export const DEFAULT_DGGRID_LABELS: DggridLabels = {
  title: "DGGRID",
  controlTitle: "DGGRID settings",
  cellType: "Cell type",
  topologyHexagon: "Hexagon",
  topologyDiamond: "Diamond",
  topologyTriangle: "Triangle",
  projection: "Projection",
  aperture: "Aperture",
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
  identifyHint: "Click the map to identify a DGGRID cell.",
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

let labels: DggridLabels = { ...DEFAULT_DGGRID_LABELS };
let settings: DggridGridSettings = { ...DEFAULT_DGGRID_GRID_SETTINGS };
let map: MapLibreMap | null = null;
let appRef: GeoLibreAppAPI | null = null;
let dggs: DggridEngine | null = null;
let unregisterPanel: (() => void) | null = null;
let moveHandler: (() => void) | null = null;
let clickHandler: ((event: MapMouseEvent) => void) | null = null;
let unsubscribeBasemap: (() => void) | null = null;
let panelContainer: HTMLElement | null = null;
// A DGGRID sequence number does not encode its resolution (unlike H3/S2/A5
// ids), so the selection carries both.
let selectedCell: string | null = null;
let selectedResolution = 0;

let currentGrid: FeatureCollection<Polygon> = { type: "FeatureCollection", features: [] };
let currentError: string | null = null;
let cachedTextFont: string[] | null = null;
let pendingRefresh: number | null = null;
/** Bumped on every activate/deactivate so an in-flight WASM load cannot attach after teardown. */
let activationGeneration = 0;

let dggsPromise: Promise<DggridEngine> | null = null;

/**
 * Load the webdggrid WASM module once and reuse the instance. Imported
 * dynamically so the ~270 kB module stays out of the main bundle until the
 * plugin is activated. `Webdggrid.load()` is typed as returning the class but
 * resolves to an instance, hence the cast. A failed load clears the cache so
 * the next activate can retry.
 */
export function loadDggrid(): Promise<DggridEngine> {
  dggsPromise ??= import("webdggrid")
    .then(async (module) => {
      const instance = (await module.Webdggrid.load()) as unknown as DggridEngine;
      instance.setDggs({ ...DGGRID_CONFIG }, DEFAULT_DGGRID_GRID_SETTINGS.resolution);
      return instance;
    })
    .catch((error) => {
      dggsPromise = null;
      throw error;
    });
  return dggsPromise;
}

/**
 * Coalesce viewport-driven rebuilds. Inertial pans emit `moveend` in bursts,
 * and each rebuild walks up to DGGRID_VIEWPORT_CELL_LIMIT cells on the main
 * thread.
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

export function setDggridLabels(next: Partial<DggridLabels>): void {
  labels = { ...labels, ...next };
  if (panelContainer) renderPanel(panelContainer);
}

export function getDggridGridSettings(): DggridGridSettings {
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
 * The automatic zoom→resolution rule, mirroring vgrid-maplibre's DGGRIDGrid
 * (https://www.npmjs.com/package/vgrid-maplibre): the factor depends on the
 * aperture — a higher aperture means fewer resolution steps cover the same
 * zoom range — clamped to the valid range.
 */
export function dggridResolutionForZoom(zoom: number, aperture: DggridAperture = 4): number {
  const factor = aperture === 3 ? 1.15 : aperture === 7 ? 0.65 : 0.95;
  return Math.min(MAX_DGGRID_RESOLUTION, Math.max(0, Math.floor(zoom * factor)));
}

/** The resolution actually rendered: zoom-derived when automatic, else manual. */
function effectiveResolution(): number {
  return settings.autoResolution && map
    ? dggridResolutionForZoom(map.getZoom(), settings.aperture)
    : settings.resolution;
}

/** The DGGS configuration derived from the current settings. */
function currentConfig(): DggridConfig {
  return {
    poleCoordinates: { lat: 0, lng: 0 },
    azimuth: 0,
    topology: settings.topology,
    projection: settings.projection,
    aperture: settings.aperture,
  };
}

export function normalizeDggridGridSettings(value: unknown): DggridGridSettings {
  const candidate = (value ?? {}) as Partial<DggridGridSettings>;
  const topology = DGGRID_TOPOLOGIES.includes(candidate.topology as DggridTopology)
    ? (candidate.topology as DggridTopology)
    : DEFAULT_DGGRID_GRID_SETTINGS.topology;
  const aperture = DGGRID_APERTURES.includes(candidate.aperture as DggridAperture)
    ? (candidate.aperture as DggridAperture)
    : DEFAULT_DGGRID_GRID_SETTINGS.aperture;
  return {
    topology,
    projection: DGGRID_PROJECTIONS.includes(candidate.projection as DggridProjection)
      ? (candidate.projection as DggridProjection)
      : DEFAULT_DGGRID_GRID_SETTINGS.projection,
    // Diamond and triangle grids only exist with aperture 4 (anything else
    // aborts the WASM engine).
    aperture: topology === "HEXAGON" ? aperture : 4,
    autoResolution:
      typeof candidate.autoResolution === "boolean"
        ? candidate.autoResolution
        : DEFAULT_DGGRID_GRID_SETTINGS.autoResolution,
    resolution: Math.round(
      clampNumber(
        candidate.resolution,
        0,
        MAX_DGGRID_RESOLUTION,
        DEFAULT_DGGRID_GRID_SETTINGS.resolution,
      ),
    ),
    fillColor: color(candidate.fillColor, DEFAULT_DGGRID_GRID_SETTINGS.fillColor),
    fillOpacity: clampNumber(candidate.fillOpacity, 0, 1, DEFAULT_DGGRID_GRID_SETTINGS.fillOpacity),
    lineColor: color(candidate.lineColor, DEFAULT_DGGRID_GRID_SETTINGS.lineColor),
    lineWidth: clampNumber(candidate.lineWidth, 0.1, 8, DEFAULT_DGGRID_GRID_SETTINGS.lineWidth),
    showLabels:
      typeof candidate.showLabels === "boolean"
        ? candidate.showLabels
        : DEFAULT_DGGRID_GRID_SETTINGS.showLabels,
    includeNeighbors:
      typeof candidate.includeNeighbors === "boolean"
        ? candidate.includeNeighbors
        : DEFAULT_DGGRID_GRID_SETTINGS.includeNeighbors,
    includeParents:
      typeof candidate.includeParents === "boolean"
        ? candidate.includeParents
        : DEFAULT_DGGRID_GRID_SETTINGS.includeParents,
  };
}

/**
 * Avoid thousands of overlapping IDs when the grid is viewed globally.
 * Aperture-4 cell area shrinks 4x per resolution step (2x linearly), so one
 * zoom level per resolution keeps the on-screen label density roughly
 * constant.
 */
export function dggridLabelMinZoom(resolution: number): number {
  return Math.min(18, Math.max(2, Math.round(resolution) + 1));
}

export function setDggridGridSettings(patch: Partial<DggridGridSettings>): void {
  const previousResolution = effectiveResolution();
  // Leaving automatic mode adopts the current zoom-derived resolution as the
  // fixed one, so the grid stays put instead of jumping to the stale slider.
  if (settings.autoResolution && patch.autoResolution === false && patch.resolution === undefined) {
    patch = { ...patch, resolution: previousResolution };
  }
  const next = normalizeDggridGridSettings({ ...settings, ...patch });
  const topologyChanged = next.topology !== settings.topology;
  const configChanged =
    topologyChanged ||
    next.projection !== settings.projection ||
    next.aperture !== settings.aperture;
  // Cell type (topology) changes the lattice entirely — drop the selection
  // and its neighbor/parent overlays rather than re-mapping a meaningless id.
  // Projection/aperture still re-derive from the cell center while the engine
  // holds the outgoing config.
  let selectionCenter: Position | null = null;
  if (topologyChanged) {
    selectedCell = null;
    selectedResolution = 0;
  } else if (dggs && selectedCell && configChanged) {
    selectionCenter = dggs.sequenceNumToGeo([BigInt(selectedCell)], selectedResolution)[0];
  }
  settings = next;
  const resolution = effectiveResolution();
  if (dggs && selectedCell && configChanged) {
    dggs.setDggs(currentConfig(), resolution);
    selectedCell = selectionCenter
      ? dggs.geoToSequenceNum([selectionCenter], resolution)[0].toString()
      : null;
    selectedResolution = resolution;
  } else if (
    dggs &&
    selectedCell &&
    patch.resolution !== undefined &&
    resolution !== previousResolution
  ) {
    // Re-derive the selection only for an explicit slider change; toggling
    // automatic resolution (like zooming in automatic mode) keeps the clicked
    // cell and its neighbors/parents as they are.
    const [lng, lat] = dggs.sequenceNumToGeo([BigInt(selectedCell)], selectedResolution)[0];
    selectedCell = dggs.geoToSequenceNum([[lng, lat]], resolution)[0].toString();
    selectedResolution = resolution;
  }
  // Only the rendered configuration/resolution changes the geometry, so a
  // paint/layout-only edit skips rebuilding up to DGGRID_VIEWPORT_CELL_LIMIT
  // features.
  if (configChanged || resolution !== previousResolution) {
    refresh();
  } else {
    applyStyle();
    updateSelectedSource();
  }
  if (panelContainer) renderPanel(panelContainer);
}

function normalizeLon(lon: number): number {
  let x = lon;
  while (x > 180) x -= 360;
  while (x < -180) x += 360;
  return x;
}

/** Ray-casting point-in-polygon; ring is [lng, lat][] (closed or not). */
function pointInRing(lon: number, lat: number, ring: Position[]): boolean {
  if (!ring?.length) return false;
  const last = ring.length - 1;
  const closed = ring[0][0] === ring[last][0] && ring[0][1] === ring[last][1];
  const count = closed ? ring.length - 1 : ring.length;
  let inside = false;
  for (let i = 0, j = count - 1; i < count; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (yj - yi === 0) continue;
    const intersect = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Counter-clockwise test for proper intersection checks. */
function ccw(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
  return (cy - ay) * (bx - ax) > (by - ay) * (cx - ax);
}

function segmentsIntersect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const a = ccw(ax, ay, cx, cy, dx, dy) !== ccw(bx, by, cx, cy, dx, dy);
  const b = ccw(ax, ay, bx, by, cx, cy) !== ccw(ax, ay, bx, by, dx, dy);
  return a && b;
}

function segmentCrossesLonLatRect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  west: number,
  south: number,
  east: number,
  north: number,
): boolean {
  if (Math.max(ax, bx) < west || Math.min(ax, bx) > east) return false;
  if (Math.max(ay, by) < south || Math.min(ay, by) > north) return false;
  if (ax >= west && ax <= east && ay >= south && ay <= north) return true;
  if (bx >= west && bx <= east && by >= south && by <= north) return true;
  const edges: Array<[number, number, number, number]> = [
    [west, south, east, south],
    [east, south, east, north],
    [east, north, west, north],
    [west, north, west, south],
  ];
  return edges.some(([x1, y1, x2, y2]) => segmentsIntersect(ax, ay, bx, by, x1, y1, x2, y2));
}

/** Whether a cell ring intersects the axis-aligned lon/lat rect (planar test). */
function ringIntersectsBounds(
  ring: Position[],
  west: number,
  south: number,
  east: number,
  north: number,
): boolean {
  if (!ring?.length) return false;
  // Unwrap for continuity, then shift into the rect's longitude window so
  // vertex / containment / segment tests share one frame (raw ±180 mixes break
  // antimeridian cells).
  const framed: Position[] = [];
  for (const [rawLon, lat] of ring) {
    let lon = rawLon;
    if (framed.length > 0) {
      const reference = framed[0][0];
      while (lon - reference > 180) lon -= 360;
      while (lon - reference < -180) lon += 360;
    }
    framed.push([lon, lat]);
  }
  const mid = (west + east) / 2;
  const shift = Math.round((mid - framed[0][0]) / 360) * 360;
  const normalized =
    shift === 0 ? framed : framed.map(([lon, lat]) => [lon + shift, lat] as Position);

  const last = normalized.length - 1;
  const closed =
    normalized[0][0] === normalized[last][0] && normalized[0][1] === normalized[last][1];
  const count = closed ? normalized.length - 1 : normalized.length;

  for (let i = 0; i < count; i += 1) {
    const lon = normalized[i][0];
    const lat = normalized[i][1];
    if (lon >= west && lon <= east && lat >= south && lat <= north) return true;
  }
  for (const [lon, lat] of [
    [west, south],
    [west, north],
    [east, south],
    [east, north],
    [(west + east) / 2, (south + north) / 2],
  ]) {
    if (pointInRing(lon, lat, normalized)) return true;
  }
  for (let i = 0; i < count; i += 1) {
    const j = (i + 1) % count;
    if (
      segmentCrossesLonLatRect(
        normalized[i][0],
        normalized[i][1],
        normalized[j][0],
        normalized[j][1],
        west,
        south,
        east,
        north,
      )
    ) {
      return true;
    }
  }
  return false;
}

/** One or two lon/lat rects for viewport bounds (handles the antimeridian). */
function boundsToRects(
  bounds: [number, number, number, number],
): Array<[number, number, number, number]> {
  const west = normalizeLon(bounds[0]);
  const east = normalizeLon(bounds[2]);
  const south = bounds[1];
  const north = bounds[3];
  if (west <= east) return [[west, south, east, north]];
  return [
    [west, south, 180, north],
    [-180, south, east, north],
  ];
}

function closeRing(ring: Position[]): Position[] {
  if (ring.length === 0) return ring;
  const [firstLng, firstLat] = ring[0];
  const [lastLng, lastLat] = ring[ring.length - 1];
  return firstLng === lastLng && firstLat === lastLat ? ring : [...ring, [firstLng, firstLat]];
}

/** Convert a DGGRID cell (sequence number string) to a GeoJSON polygon. */
export function dggridCellFeature(
  engine: DggridEngine,
  cell: string,
  resolution: number,
): Feature<Polygon> {
  const id = BigInt(cell);
  // unwrap (the default) keeps antimeridian-crossing rings contiguous, with
  // longitudes past ±180 rendered in MapLibre's adjacent world copy.
  const ring = closeRing(engine.sequenceNumToGrid([id], resolution)[0]);
  const [lng, lat] = engine.sequenceNumToGeo([id], resolution)[0];
  return {
    type: "Feature",
    id: cell,
    properties: {
      dggrid: cell,
      resolution,
      center_lat: lat,
      center_lng: lng,
    },
    geometry: { type: "Polygon", coordinates: [ring] },
  };
}

/**
 * Cell ids under a lattice of sample points, mirroring vgrid-maplibre's
 * `buildSamplePoints` fallback for grids where neighbor lookup is
 * unavailable (TRIANGLE topology). The sample budget grows with resolution
 * (the stand-in for vgrid's map zoom), so coverage may miss cells that only
 * clip a corner of the view — the tradeoff vgrid accepts.
 */
function sampledCells(
  engine: DggridEngine,
  west: number,
  south: number,
  span: number,
  latSpan: number,
  resolution: number,
): bigint[] {
  const maxSamples = Math.min(
    420,
    Math.max(72, Math.round(56 + resolution * 22 + resolution * resolution * 0.35)),
  );
  const gridCap = Math.min(42, Math.max(10, Math.ceil(Math.sqrt(maxSamples)) + 8));
  const aspect = span / Math.max(1e-9, latSpan);
  let cols = Math.ceil(Math.sqrt(maxSamples * aspect));
  cols = Math.min(gridCap, Math.max(3, cols));
  let rows = Math.ceil(maxSamples / cols);
  rows = Math.min(gridCap, Math.max(3, rows));

  const coords: number[][] = [];
  for (let i = 0; i <= rows; i += 1) {
    const lat = south + (latSpan * i) / rows;
    for (let j = 0; j <= cols; j += 1) {
      coords.push([normalizeLon(west + (span * j) / cols), lat]);
    }
  }
  const seen = new Set<string>();
  const unique: bigint[] = [];
  for (const id of engine.geoToSequenceNum(coords, resolution)) {
    const key = id.toString();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(id);
    }
  }
  return unique;
}

/**
 * Fill a WGS84 bounding box with DGGRID cells, mirroring vgrid-maplibre's
 * DGGRIDGrid: BFS from a seed cell at the viewport center, expanding through
 * `sequenceNumNeighbors` while cells intersect the bounds. TRIANGLE grids
 * have no neighbor lookup, so they fall back to point sampling.
 */
export function dggridGridForBounds(
  engine: DggridEngine,
  bounds: [number, number, number, number],
  resolution: number,
  limit = DGGRID_VIEWPORT_CELL_LIMIT,
  config: DggridConfig = DGGRID_CONFIG,
): FeatureCollection<Polygon> {
  const [west, southRaw, east, northRaw] = bounds;
  const south = Math.max(-89.999999, Math.min(89.999999, southRaw));
  const north = Math.max(-89.999999, Math.min(89.999999, northRaw));
  const span = Math.min(360, east >= west ? east - west : east + 360 - west);
  // Reject obviously oversized requests before the BFS materializes the full
  // result. ISEA cells are equal-area, so the estimate is close; the exact
  // hard cap below remains the final guard.
  const radians = Math.PI / 180;
  const areaKm2 =
    6371.0088 ** 2 *
    span *
    radians *
    Math.abs(Math.sin(north * radians) - Math.sin(south * radians));
  engine.setDggs({ ...config }, resolution);
  if (areaKm2 / engine.cellAreaKM(resolution) > limit * 1.2) {
    throw new RangeError(`DGGRID cell limit exceeded: ${limit}`);
  }

  let collected: bigint[];
  if (config.topology === "TRIANGLE") {
    collected = sampledCells(engine, west, south, span, north - south, resolution);
    if (collected.length > limit) {
      throw new RangeError(`DGGRID cell limit exceeded: ${limit}`);
    }
  } else {
    const rects = boundsToRects([west, south, east, north]);
    const centerLng = normalizeLon(west + span / 2);
    const centerLat = (south + north) / 2;
    const seed = engine.geoToSequenceNum([[centerLng, centerLat]], resolution)[0];

    collected = [];
    const covered = new Set<string>();
    const queue: bigint[] = [seed];
    let head = 0;
    // Guard against pathological loops; generous next to the cell limit
    // because the frontier also visits cells that only touch the bounds.
    const maxPops = Math.max(100_000, limit * 20);
    let pops = 0;

    while (head < queue.length && pops < maxPops) {
      pops += 1;
      const id = queue[head++];
      const key = id.toString();
      if (covered.has(key)) continue;
      covered.add(key);

      const ring = engine.sequenceNumToGrid([id], resolution)[0];
      if (!rects.some(([w, s, e, n]) => ringIntersectsBounds(ring, w, s, e, n))) continue;

      collected.push(id);
      if (collected.length > limit) {
        throw new RangeError(`DGGRID cell limit exceeded: ${limit}`);
      }

      for (const neighbor of engine.sequenceNumNeighbors([id], resolution)[0] ?? []) {
        if (!covered.has(neighbor.toString())) queue.push(neighbor);
      }
    }
    if (head < queue.length) {
      throw new RangeError(`DGGRID traversal limit exceeded: ${maxPops}`);
    }
  }

  return {
    type: "FeatureCollection",
    features: collected.map((id) => dggridCellFeature(engine, id.toString(), resolution)),
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
      minzoom: dggridLabelMinZoom(effectiveResolution()),
      layout: {
        "text-field": ["get", "dggrid"],
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
  map.setLayerZoomRange(LABEL_LAYER_ID, dggridLabelMinZoom(effectiveResolution()), 24);
}

function refresh(): void {
  if (!map || !dggs) return;
  const resolution = effectiveResolution();
  // The selected cell (and its neighbors/parents) deliberately stays at the
  // resolution it was clicked at: in automatic mode a zoom or pan changes the
  // rendered grid, but re-deriving the selection would silently replace the
  // cell the user identified. Only an explicit settings change re-indexes it
  // (see setDggridGridSettings).
  try {
    const bounds = map.getBounds();
    currentGrid = dggridGridForBounds(
      dggs,
      [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
      resolution,
      DGGRID_VIEWPORT_CELL_LIMIT,
      currentConfig(),
    );
    currentError = null;
  } catch (error) {
    currentGrid = { type: "FeatureCollection", features: [] };
    currentError =
      error instanceof RangeError ? labels.tooManyCells(DGGRID_VIEWPORT_CELL_LIMIT) : String(error);
  }
  applyStyle();
  (map.getSource(SOURCE_ID) as GeoJSONSource | undefined)?.setData(currentGrid);
  updateSelectedSource();
  // Pan/zoom only updates the status line (and auto-resolution readout) —
  // rebuilding the whole panel would destroy open color pickers / focused inputs.
  updatePanelStatus();
}

/** Update the status line (and auto-resolution readout) without recreating controls. */
function updatePanelStatus(): void {
  const status = panelContainer?.querySelector<HTMLElement>("[data-dggrid-status]");
  if (!status) {
    if (panelContainer) renderPanel(panelContainer);
    return;
  }
  status.textContent = currentError ?? labels.cellCount(currentGrid.features.length);
  status.style.color = currentError ? "#dc2626" : "";
  if (settings.autoResolution) {
    const shown = String(effectiveResolution());
    const resolution = panelContainer?.querySelector<HTMLInputElement>("[data-dggrid-resolution]");
    const resolutionValue = panelContainer?.querySelector<HTMLElement>(
      "[data-dggrid-resolution-value]",
    );
    if (resolution) {
      resolution.value = shown;
      resolution.title = shown;
    }
    if (resolutionValue) resolutionValue.textContent = shown;
  }
}

/**
 * The cell plus its edge neighbors at the same resolution. The engine has no
 * neighbor lookup for TRIANGLE grids, so the cell stands alone there.
 */
function neighborCells(cell: string): string[] {
  if (!dggs || settings.topology === "TRIANGLE") return [cell];
  const ids = new Set<string>([cell]);
  for (const neighbor of dggs.sequenceNumNeighbors([BigInt(cell)], selectedResolution)[0] ?? []) {
    ids.add(neighbor.toString());
  }
  return [...ids];
}

function selectedCells(): string[] {
  if (!selectedCell) return [];
  return settings.includeNeighbors ? neighborCells(selectedCell) : [selectedCell];
}

/**
 * Every resolution r-1 cell the selected cell overlaps. Aperture-4 hexagons
 * do not nest exactly, so a boundary cell can touch several coarser cells;
 * webdggrid's sequenceNumAllParents returns them all, canonical parent first.
 */
function parentCells(cell: string): string[] {
  if (!dggs || selectedResolution <= 0) return [];
  return (dggs.sequenceNumAllParents([BigInt(cell)], selectedResolution)[0] ?? []).map((id) =>
    id.toString(),
  );
}

function updateSelectedSource(): void {
  if (!dggs) return;
  const source = map?.getSource(SELECTED_SOURCE_ID) as GeoJSONSource | undefined;
  source?.setData({
    type: "FeatureCollection",
    features: selectedCells().map((cell) => dggridCellFeature(dggs!, cell, selectedResolution)),
  });
  const parentsSource = map?.getSource(PARENTS_SOURCE_ID) as GeoJSONSource | undefined;
  parentsSource?.setData({
    type: "FeatureCollection",
    features:
      settings.includeParents && selectedCell
        ? parentCells(selectedCell).map((cell) =>
            dggridCellFeature(dggs!, cell, selectedResolution - 1),
          )
        : [],
  });
}

function gridCsv(grid: FeatureCollection<Polygon>): string {
  const header = "dggrid,resolution,center_lat,center_lng";
  const rows = grid.features.map((feature) => {
    const p = feature.properties!;
    return [p.dggrid, p.resolution, p.center_lat, p.center_lng].join(",");
  });
  return [header, ...rows].join("\n");
}

function fitSelected(): void {
  if (!selectedCell || !appRef || !dggs) return;
  // The ring is unwrapped to stay contiguous across the antimeridian, so
  // min/max longitudes never span the world.
  const ring = dggs.sequenceNumToGrid([BigInt(selectedCell)], selectedResolution)[0];
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

  const select = (
    options: Array<[string, string]>,
    value: string,
    onChange: (value: string) => void,
    disabled = false,
  ): HTMLSelectElement => {
    const element = document.createElement("select");
    for (const [optionValue, optionLabel] of options) {
      const option = document.createElement("option");
      option.value = optionValue;
      option.textContent = optionLabel;
      element.appendChild(option);
    }
    element.value = value;
    element.disabled = disabled;
    element.style.padding = "4px 6px";
    element.style.border = "1px solid hsl(var(--border))";
    element.style.borderRadius = "6px";
    element.style.background = "hsl(var(--background))";
    element.style.color = "inherit";
    element.style.opacity = disabled ? "0.6" : "1";
    element.addEventListener("change", () => onChange(element.value));
    return element;
  };

  row(
    labels.cellType,
    select(
      [
        ["HEXAGON", labels.topologyHexagon],
        ["DIAMOND", labels.topologyDiamond],
        ["TRIANGLE", labels.topologyTriangle],
      ],
      settings.topology,
      (value) => setDggridGridSettings({ topology: value as DggridTopology }),
    ),
  );
  row(
    labels.projection,
    select(
      DGGRID_PROJECTIONS.map((projection) => [projection, projection]),
      settings.projection,
      (value) => setDggridGridSettings({ projection: value as DggridProjection }),
    ),
  );
  // Diamond and triangle grids only exist with aperture 4, so the picker is a
  // read-only indicator there (normalization pins the value regardless).
  row(
    labels.aperture,
    select(
      DGGRID_APERTURES.map((aperture) => [String(aperture), String(aperture)]),
      String(settings.aperture),
      (value) => setDggridGridSettings({ aperture: Number(value) as DggridAperture }),
      settings.topology !== "HEXAGON",
    ),
  );

  const autoResolution = document.createElement("input");
  autoResolution.type = "checkbox";
  autoResolution.checked = settings.autoResolution;
  autoResolution.addEventListener("change", () =>
    setDggridGridSettings({ autoResolution: autoResolution.checked }),
  );
  row(labels.autoResolution, autoResolution);

  // In automatic mode the slider is a read-only indicator of the zoom-derived
  // resolution; updatePanelStatus() keeps it in sync on every moveend.
  const shownResolution = effectiveResolution();
  const resolution = document.createElement("input");
  resolution.dataset.dggridResolution = "";
  resolution.type = "range";
  resolution.min = "0";
  resolution.max = String(MAX_DGGRID_RESOLUTION);
  resolution.value = String(shownResolution);
  resolution.title = String(shownResolution);
  resolution.disabled = settings.autoResolution;
  resolution.addEventListener("input", () => {
    resolution.title = resolution.value;
  });
  resolution.addEventListener("change", () =>
    setDggridGridSettings({ resolution: Number(resolution.value) }),
  );
  const resolutionWrap = document.createElement("span");
  resolutionWrap.style.display = "flex";
  resolutionWrap.style.alignItems = "center";
  resolutionWrap.style.gap = "6px";
  resolutionWrap.style.opacity = settings.autoResolution ? "0.6" : "1";
  const resolutionValue = document.createElement("strong");
  resolutionValue.dataset.dggridResolutionValue = "";
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
    // `change` (not `input`): setDggridGridSettings re-renders the panel,
    // which would destroy the picker mid-drag.
    input.addEventListener("change", () => setDggridGridSettings({ [key]: input.value }));
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
    input.addEventListener("change", () => setDggridGridSettings({ [key]: Number(input.value) }));
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
    // Neighbor lookup does not exist for TRIANGLE grids.
    input.disabled = key === "includeNeighbors" && settings.topology === "TRIANGLE";
    input.addEventListener("change", () => setDggridGridSettings({ [key]: input.checked }));
    row(text, input);
  }

  const status = document.createElement("div");
  status.dataset.dggridStatus = "";
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

  if (selectedCell && dggs) {
    const id = BigInt(selectedCell);
    const [lng, lat] = dggs.sequenceNumToGeo([id], selectedResolution)[0];
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
    addDetail(labels.resolution, String(selectedResolution));
    addDetail(labels.center, `${lat.toFixed(6)}, ${lng.toFixed(6)}`);
    if (selectedResolution > 0) {
      // Every overlapping r-1 cell (canonical parent first), matching the
      // dashed parent outlines on the map.
      addDetail(labels.parent, parentCells(selectedCell).join("\n"));
    }
    if (selectedResolution < MAX_DGGRID_RESOLUTION) {
      addDetail(
        labels.children,
        String((dggs.sequenceNumChildren([id], selectedResolution)[0] ?? []).length),
      );
    }
    if (settings.topology !== "TRIANGLE") {
      addDetail(labels.neighbors, String(neighborCells(selectedCell).length - 1));
    }
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
          appRef?.addGeoJsonLayer(`DGGRID grid (resolution ${effectiveResolution()})`, currentGrid);
        }
      },
      currentGrid.features.length === 0,
    ),
    button(
      labels.exportGeoJson,
      () => {
        appRef?.exportTextFile?.(
          `dggrid-r${effectiveResolution()}.geojson`,
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
        appRef?.exportTextFile?.(`dggrid-r${effectiveResolution()}.csv`, gridCsv(currentGrid), {
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

function settingsEqual(a: DggridGridSettings, b: DggridGridSettings): boolean {
  return Object.keys(a).every(
    (key) => a[key as keyof DggridGridSettings] === b[key as keyof DggridGridSettings],
  );
}

export const maplibreDggridPlugin: GeoLibrePlugin = {
  id: DGGRID_PLUGIN_ID,
  name: "DGGRID",
  version: "1.0.0",
  activate: async (app) => {
    const activeMap = app.getMap?.();
    if (!activeMap) return false;
    const generation = (activationGeneration += 1);
    // Await WASM before mutating map/panel state so a deactivate during the
    // load cannot race a late attach (leaked listeners / panels / layers).
    let engine: DggridEngine;
    try {
      engine = await loadDggrid();
    } catch (error) {
      if (generation === activationGeneration) {
        currentError = error instanceof Error ? error.message : String(error);
      }
      return false;
    }
    if (generation !== activationGeneration) return false;
    dggs = engine;
    map = activeMap;
    appRef = app;
    moveHandler = () => scheduleRefresh();
    clickHandler = (event) => {
      if (!dggs) return;
      const resolution = effectiveResolution();
      selectedCell = dggs
        .geoToSequenceNum([[event.lngLat.lng, event.lngLat.lat]], resolution)[0]
        .toString();
      selectedResolution = resolution;
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
    activationGeneration += 1;
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
    selectedResolution = 0;
    currentGrid = { type: "FeatureCollection", features: [] };
    currentError = null;
    cachedTextFont = null;
    dggs = null;
    map = null;
    appRef = null;
    app.closeRightPanel?.(PANEL_ID);
  },
  getProjectState: () =>
    settingsEqual(settings, DEFAULT_DGGRID_GRID_SETTINGS) ? undefined : { ...settings },
  applyProjectState: (_app, state) => {
    const next = normalizeDggridGridSettings(state);
    if (settingsEqual(settings, next)) return false;
    // A selection's sequence number is meaningless under another DGGS
    // configuration, so a project switching config drops it.
    if (
      next.topology !== settings.topology ||
      next.projection !== settings.projection ||
      next.aperture !== settings.aperture
    ) {
      selectedCell = null;
    }
    settings = next;
    refresh();
    if (panelContainer) renderPanel(panelContainer);
  },
};
