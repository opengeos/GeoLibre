import type { Feature, FeatureCollection, Polygon } from "geojson";
import type { GeoJSONSource, Map as MapLibreMap, MapMouseEvent } from "maplibre-gl";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

export const DGGAL_PLUGIN_ID = "maplibre-dggal";

const PANEL_ID = "geolibre-dggal-panel";
const SOURCE_ID = "geolibre-dggal-grid-source";
const FILL_LAYER_ID = "geolibre-dggal-grid-fill";
const LINE_LAYER_ID = "geolibre-dggal-grid-line";
const LABEL_LAYER_ID = "geolibre-dggal-grid-label";
const SELECTED_SOURCE_ID = "geolibre-dggal-selected-source";
const SELECTED_FILL_LAYER_ID = "geolibre-dggal-selected-fill";
const SELECTED_LINE_LAYER_ID = "geolibre-dggal-selected-line";
const PARENTS_SOURCE_ID = "geolibre-dggal-parents-source";
const PARENTS_LINE_LAYER_ID = "geolibre-dggal-parents-line";

const SELECTED_LINE_WIDTH = 3;

/** Prevent a fine resolution over a large viewport from freezing the browser. */
export const DGGAL_VIEWPORT_CELL_LIMIT = 20_000;

/**
 * The DGGRSs vgrid-maplibre's DGGALGrid exposes, with its per-type maximum
 * resolutions (each at or under the engine's own zone-level limit).
 */
export const DGGAL_TYPES = {
  GNOSISGlobalGrid: 28,
  ISEA4R: 20,
  ISEA9R: 16,
  ISEA3H: 33,
  ISEA7H: 19,
  ISEA7H_Z7: 19,
  IVEA4R: 20,
  IVEA9R: 16,
  IVEA3H: 33,
  IVEA7H: 19,
  IVEA7H_Z7: 19,
  RTEA4R: 20,
  RTEA9R: 16,
  RTEA3H: 33,
  RTEA7H: 19,
  RTEA7H_Z7: 19,
  HEALPix: 26,
  rHEALPix: 16,
} as const;

export type DggalType = keyof typeof DGGAL_TYPES;

export const DGGAL_TYPE_NAMES = Object.keys(DGGAL_TYPES) as DggalType[];

/** A geographic point in radians, DGGAL's native unit. */
interface GeoPoint {
  lat: number;
  lon: number;
}

/**
 * The subset of a DGGAL `DGGRS` instance this plugin uses (dggal ships full
 * TypeScript declarations; this mirror just keeps the type-only surface in
 * one place next to the quirks documented on the helpers below).
 */
export interface DggalDggrs {
  getZoneFromTextID(zoneId: string): bigint;
  getZoneTextID(zone: bigint): string;
  getZoneLevel(zone: bigint): number;
  getZoneParents(zone: bigint): bigint[];
  getZoneChildren(zone: bigint): bigint[];
  getZoneNeighbors(zone: bigint): Array<{ zone: bigint; type: number }>;
  getZoneWGS84Centroid(zone: bigint): GeoPoint;
  getZoneRefinedWGS84Vertices(zone: bigint, edgeRefinement: number): GeoPoint[];
  listZones(level: number, bbox: { ll: GeoPoint; ur: GeoPoint }): bigint[];
  getZoneFromWGS84Centroid(level: number, geoPoint: GeoPoint): bigint;
  countZones(level: number): bigint;
  getMaxDGGRSZoneLevel(): number;
  delete(): void;
}

/** The DGGAL API handle returned by `DGGAL.init()`. */
export interface DggalEngine {
  createDGGRS(name: string): DggalDggrs;
  listDGGRS(): string[];
}

export interface DggalGridSettings {
  /** Which DGGRS to render ("DGGS type" in the panel). */
  dggrsType: DggalType;
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

export const DEFAULT_DGGAL_GRID_SETTINGS: DggalGridSettings = {
  dggrsType: "ISEA3H",
  autoResolution: true,
  // Useful immediately at GeoLibre's default world view: ISEA3H resolution 2
  // tiles the globe with 92 hexagons/pentagons.
  resolution: 2,
  fillColor: "#0d9488",
  fillOpacity: 0.08,
  lineColor: "#0d9488",
  lineWidth: 1,
  showLabels: true,
  includeNeighbors: false,
  includeParents: false,
};

export interface DggalLabels {
  title: string;
  getTitle?: () => string;
  controlTitle: string;
  gridType: string;
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

export const DEFAULT_DGGAL_LABELS: DggalLabels = {
  title: "DGGAL",
  controlTitle: "DGGAL settings",
  gridType: "DGGS type",
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
  identifyHint: "Click the map to identify a DGGAL cell.",
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

const DEG_PER_RAD = 180 / Math.PI;
const RAD_PER_DEG = Math.PI / 180;

let labels: DggalLabels = { ...DEFAULT_DGGAL_LABELS };
let settings: DggalGridSettings = { ...DEFAULT_DGGAL_GRID_SETTINGS };
let map: MapLibreMap | null = null;
let appRef: GeoLibreAppAPI | null = null;
let dggal: DggalEngine | null = null;
let dggrs: DggalDggrs | null = null;
let dggrsType: DggalType | null = null;
let unregisterPanel: (() => void) | null = null;
let moveHandler: (() => void) | null = null;
let clickHandler: ((event: MapMouseEvent) => void) | null = null;
let unsubscribeBasemap: (() => void) | null = null;
let panelContainer: HTMLElement | null = null;
/** The selected zone's text ID (it encodes the zone's level, unlike DGGRID). */
let selectedCell: string | null = null;

let currentGrid: FeatureCollection<Polygon> = { type: "FeatureCollection", features: [] };
let currentError: string | null = null;
let cachedTextFont: string[] | null = null;
let pendingRefresh: number | null = null;
/** Bumped on every activate/deactivate so an in-flight WASM load cannot attach after teardown. */
let activationGeneration = 0;

let dggalPromise: Promise<DggalEngine> | null = null;

/**
 * Load the DGGAL WASM module once and reuse the handle. Imported dynamically
 * so the ~1 MB module stays out of the main bundle until the plugin is
 * activated. A failed load clears the cache so the next activate can retry.
 */
export function loadDggal(): Promise<DggalEngine> {
  dggalPromise ??= import("dggal")
    .then((module) => module.DGGAL.init() as unknown as Promise<DggalEngine>)
    .catch((error) => {
      dggalPromise = null;
      throw error;
    });
  return dggalPromise;
}

/** The DGGRS instance for the active grid type, recreated when it changes. */
function activeDggrs(): DggalDggrs | null {
  if (!dggal) return null;
  if (!dggrs || dggrsType !== settings.dggrsType) {
    dggrs?.delete();
    dggrs = dggal.createDGGRS(settings.dggrsType);
    dggrsType = settings.dggrsType;
  }
  return dggrs;
}

/**
 * Coalesce viewport-driven rebuilds. Inertial pans emit `moveend` in bursts,
 * and each rebuild materializes up to DGGAL_VIEWPORT_CELL_LIMIT zones on the
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

export function setDggalLabels(next: Partial<DggalLabels>): void {
  labels = { ...labels, ...next };
  if (panelContainer) renderPanel(panelContainer);
}

export function getDggalGridSettings(): DggalGridSettings {
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
 * The automatic zoom→resolution rule, mirroring vgrid-maplibre's DGGALGrid
 * (https://www.npmjs.com/package/vgrid-maplibre): the factor depends on the
 * DGGRS refinement — aperture-3 hexagons subdivide slowest (1.15/zoom),
 * 9-fold rhombuses and rHEALPix fastest (0.6/zoom) — clamped to the type's
 * resolution range.
 */
export function dggalResolutionForZoom(zoom: number, type: DggalType): number {
  let factor: number;
  switch (type) {
    case "ISEA3H":
    case "IVEA3H":
    case "RTEA3H":
      factor = 1.15;
      break;
    case "ISEA4R":
    case "IVEA4R":
    case "RTEA4R":
    case "HEALPix":
      factor = 0.95;
      break;
    case "ISEA7H":
    case "ISEA7H_Z7":
    case "IVEA7H":
    case "IVEA7H_Z7":
    case "RTEA7H":
    case "RTEA7H_Z7":
      factor = 0.65;
      break;
    case "ISEA9R":
    case "IVEA9R":
    case "RTEA9R":
    case "rHEALPix":
      factor = 0.6;
      break;
    default:
      // GNOSISGlobalGrid: one resolution per zoom level.
      factor = 1;
      break;
  }
  return Math.min(DGGAL_TYPES[type], Math.max(0, Math.floor(zoom * factor)));
}

/** The resolution actually rendered: zoom-derived when automatic, else manual. */
function effectiveResolution(): number {
  return settings.autoResolution && map
    ? dggalResolutionForZoom(map.getZoom(), settings.dggrsType)
    : Math.min(settings.resolution, DGGAL_TYPES[settings.dggrsType]);
}

export function normalizeDggalGridSettings(value: unknown): DggalGridSettings {
  const candidate = (value ?? {}) as Partial<DggalGridSettings>;
  const dggrsType =
    typeof candidate.dggrsType === "string" && Object.hasOwn(DGGAL_TYPES, candidate.dggrsType)
      ? (candidate.dggrsType as DggalType)
      : DEFAULT_DGGAL_GRID_SETTINGS.dggrsType;
  return {
    dggrsType,
    autoResolution:
      typeof candidate.autoResolution === "boolean"
        ? candidate.autoResolution
        : DEFAULT_DGGAL_GRID_SETTINGS.autoResolution,
    resolution: Math.round(
      clampNumber(
        candidate.resolution,
        0,
        DGGAL_TYPES[dggrsType],
        Math.min(DEFAULT_DGGAL_GRID_SETTINGS.resolution, DGGAL_TYPES[dggrsType]),
      ),
    ),
    fillColor: color(candidate.fillColor, DEFAULT_DGGAL_GRID_SETTINGS.fillColor),
    fillOpacity: clampNumber(candidate.fillOpacity, 0, 1, DEFAULT_DGGAL_GRID_SETTINGS.fillOpacity),
    lineColor: color(candidate.lineColor, DEFAULT_DGGAL_GRID_SETTINGS.lineColor),
    lineWidth: clampNumber(candidate.lineWidth, 0.1, 8, DEFAULT_DGGAL_GRID_SETTINGS.lineWidth),
    showLabels:
      typeof candidate.showLabels === "boolean"
        ? candidate.showLabels
        : DEFAULT_DGGAL_GRID_SETTINGS.showLabels,
    includeNeighbors:
      typeof candidate.includeNeighbors === "boolean"
        ? candidate.includeNeighbors
        : DEFAULT_DGGAL_GRID_SETTINGS.includeNeighbors,
    includeParents:
      typeof candidate.includeParents === "boolean"
        ? candidate.includeParents
        : DEFAULT_DGGAL_GRID_SETTINGS.includeParents,
  };
}

/**
 * Avoid thousands of overlapping IDs when the grid is viewed globally. Zone
 * area shrinks with each resolution step, so roughly one zoom level per
 * resolution keeps the on-screen label density steady.
 */
export function dggalLabelMinZoom(resolution: number): number {
  return Math.min(18, Math.max(2, Math.round(resolution) + 1));
}

export function setDggalGridSettings(patch: Partial<DggalGridSettings>): void {
  const previousResolution = effectiveResolution();
  // Leaving automatic mode adopts the current zoom-derived resolution as the
  // fixed one, so the grid stays put instead of jumping to the stale slider.
  if (settings.autoResolution && patch.autoResolution === false && patch.resolution === undefined) {
    patch = { ...patch, resolution: previousResolution };
  }
  const next = normalizeDggalGridSettings({ ...settings, ...patch });
  const typeChanged = next.dggrsType !== settings.dggrsType;
  const engine = activeDggrs();
  // Grid type changes the lattice entirely — drop the selection and its
  // neighbor/parent overlays rather than re-mapping a meaningless zone id.
  if (typeChanged) {
    selectedCell = null;
  }
  settings = next;
  const resolution = effectiveResolution();
  if (
    engine &&
    selectedCell &&
    patch.resolution !== undefined &&
    resolution !== previousResolution
  ) {
    // Re-derive the selection only for an explicit slider change; toggling
    // automatic resolution (like zooming in automatic mode) keeps the clicked
    // zone and its neighbors/parents as they are.
    const center = engine.getZoneWGS84Centroid(engine.getZoneFromTextID(selectedCell));
    selectedCell = engine.getZoneTextID(engine.getZoneFromWGS84Centroid(resolution, center));
  }
  // Only the rendered type/resolution changes the geometry, so a
  // paint/layout-only edit skips rebuilding up to DGGAL_VIEWPORT_CELL_LIMIT
  // features.
  if (typeChanged || resolution !== previousResolution) {
    refresh();
  } else {
    applyStyle();
    updateSelectedSource();
  }
  if (panelContainer) renderPanel(panelContainer);
}

/**
 * A zone boundary as a closed lon/lat ring in degrees. DGGAL's refined
 * vertices already keep antimeridian-crossing zones contiguous (longitudes
 * may pass ±180, which MapLibre renders in the adjacent world copy).
 */
function zoneRing(engine: DggalDggrs, zone: bigint): [number, number][] {
  const ring = engine
    .getZoneRefinedWGS84Vertices(zone, 0)
    .map(({ lat, lon }): [number, number] => [lon * DEG_PER_RAD, lat * DEG_PER_RAD]);
  if (ring.length > 0) {
    const [firstLng, firstLat] = ring[0];
    const [lastLng, lastLat] = ring[ring.length - 1];
    if (firstLng !== lastLng || firstLat !== lastLat) ring.push([firstLng, firstLat]);
  }
  return ring;
}

/** Convert a DGGAL zone (text ID) to a GeoJSON polygon with export attributes. */
export function dggalZoneFeature(engine: DggalDggrs, cell: string): Feature<Polygon> {
  const zone = engine.getZoneFromTextID(cell);
  const centroid = engine.getZoneWGS84Centroid(zone);
  return {
    type: "Feature",
    id: cell,
    properties: {
      dggal: cell,
      resolution: engine.getZoneLevel(zone),
      center_lat: centroid.lat * DEG_PER_RAD,
      center_lng: centroid.lon * DEG_PER_RAD,
    },
    geometry: { type: "Polygon", coordinates: [zoneRing(engine, zone)] },
  };
}

function normalizeLon(lon: number): number {
  let x = lon;
  while (x > 180) x -= 360;
  while (x < -180) x += 360;
  return x;
}

/**
 * Fill a WGS84 bounding box with DGGAL zones, mirroring vgrid-maplibre's
 * DGGALGrid: the engine's `listZones` does the viewport query natively.
 */
export function dggalGridForBounds(
  engine: DggalDggrs,
  bounds: [number, number, number, number],
  resolution: number,
  limit = DGGAL_VIEWPORT_CELL_LIMIT,
): FeatureCollection<Polygon> {
  let [west, south, east, north] = bounds;
  south = Math.max(-90, Math.min(90, south));
  north = Math.max(-90, Math.min(90, north));
  // Measure the raw span before wrapping endpoints into [-180, 180]. Otherwise
  // [0, …, 360, …] collapses to a zero-width box and listZones returns nothing.
  if (east - west >= 360) {
    west = -180;
    east = 180;
  } else {
    west = normalizeLon(west);
    east = normalizeLon(east);
  }
  // Wrapped antimeridian bounds (west > east) must be split — a negative span
  // undercounts area and feeds listZones an inverted bbox.
  if (east < west) {
    const left = dggalGridForBounds(engine, [west, south, 180, north], resolution, limit);
    const right = dggalGridForBounds(engine, [-180, south, east, north], resolution, limit);
    const seen = new Set<string>();
    const features: Feature<Polygon>[] = [];
    for (const feature of [...left.features, ...right.features]) {
      const id = String(feature.properties?.dggal ?? feature.id);
      if (seen.has(id)) continue;
      seen.add(id);
      features.push(feature);
      if (features.length > limit) {
        throw new RangeError(`DGGAL zone limit exceeded: ${limit}`);
      }
    }
    return { type: "FeatureCollection", features };
  }
  // Reject obviously oversized requests before materializing the zone list.
  // The global zone count is exact per type, so the spherical rectangle
  // estimate is close; the hard cap below remains the final guard.
  const radians = Math.PI / 180;
  const areaFraction =
    ((east - west) * radians * Math.abs(Math.sin(north * radians) - Math.sin(south * radians))) /
    (4 * Math.PI);
  if (Number(engine.countZones(resolution)) * areaFraction > limit * 1.2) {
    throw new RangeError(`DGGAL zone limit exceeded: ${limit}`);
  }

  const zones = engine.listZones(resolution, {
    ll: { lat: south * RAD_PER_DEG, lon: west * RAD_PER_DEG },
    ur: { lat: north * RAD_PER_DEG, lon: east * RAD_PER_DEG },
  });
  if (zones.length > limit) {
    throw new RangeError(`DGGAL zone limit exceeded: ${limit}`);
  }
  return {
    type: "FeatureCollection",
    features: zones.map((zone) => dggalZoneFeature(engine, engine.getZoneTextID(zone))),
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
      minzoom: dggalLabelMinZoom(effectiveResolution()),
      layout: {
        "text-field": ["get", "dggal"],
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
  // Added before the selected layers so the selected zone stays on top of its
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
  map.setLayerZoomRange(LABEL_LAYER_ID, dggalLabelMinZoom(effectiveResolution()), 24);
}

function refresh(): void {
  if (!map) return;
  const engine = activeDggrs();
  if (!engine) return;
  const resolution = effectiveResolution();
  // The selected zone (and its neighbors/parents) deliberately stays at the
  // resolution it was clicked at: in automatic mode a zoom or pan changes the
  // rendered grid, but re-deriving the selection would silently replace the
  // zone the user identified. Only an explicit settings change re-indexes it
  // (see setDggalGridSettings).
  try {
    const bounds = map.getBounds();
    currentGrid = dggalGridForBounds(
      engine,
      [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
      resolution,
    );
    currentError = null;
  } catch (error) {
    currentGrid = { type: "FeatureCollection", features: [] };
    currentError =
      error instanceof RangeError ? labels.tooManyCells(DGGAL_VIEWPORT_CELL_LIMIT) : String(error);
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
  const status = panelContainer?.querySelector<HTMLElement>("[data-dggal-status]");
  if (!status) {
    if (panelContainer) renderPanel(panelContainer);
    return;
  }
  status.textContent = currentError ?? labels.cellCount(currentGrid.features.length);
  status.style.color = currentError ? "#dc2626" : "";
  if (settings.autoResolution) {
    const shown = String(effectiveResolution());
    const resolution = panelContainer?.querySelector<HTMLInputElement>("[data-dggal-resolution]");
    const resolutionValue = panelContainer?.querySelector<HTMLElement>(
      "[data-dggal-resolution-value]",
    );
    if (resolution) {
      resolution.value = shown;
      resolution.title = shown;
    }
    if (resolutionValue) resolutionValue.textContent = shown;
  }
}

/**
 * Every direct parent of a zone, one level up. The JS binding pads the
 * result out to the DGGRS's maximum parent count with uninitialized zone
 * handles, so entries are filtered to the expected level.
 */
export function dggalParentZones(engine: DggalDggrs, cell: string): string[] {
  const zone = engine.getZoneFromTextID(cell);
  const level = engine.getZoneLevel(zone);
  if (level <= 0) return [];
  const parents = new Set<string>();
  for (const parent of engine.getZoneParents(zone)) {
    try {
      if (engine.getZoneLevel(parent) === level - 1) {
        parents.add(engine.getZoneTextID(parent));
      }
    } catch {
      // Garbage padding entry — skip.
    }
  }
  return [...parents];
}

/** Direct children one level down, filtered like {@link dggalParentZones}. */
function childZones(engine: DggalDggrs, cell: string): string[] {
  const zone = engine.getZoneFromTextID(cell);
  const level = engine.getZoneLevel(zone);
  const children = new Set<string>();
  for (const child of engine.getZoneChildren(zone)) {
    try {
      if (engine.getZoneLevel(child) === level + 1) {
        children.add(engine.getZoneTextID(child));
      }
    } catch {
      // Garbage padding entry — skip.
    }
  }
  return [...children];
}

/** The zone plus its edge/vertex neighbors at the same level. */
function neighborCells(cell: string): string[] {
  const engine = activeDggrs();
  if (!engine) return [cell];
  const zone = engine.getZoneFromTextID(cell);
  const level = engine.getZoneLevel(zone);
  const ids = new Set<string>([cell]);
  for (const { zone: neighbor } of engine.getZoneNeighbors(zone)) {
    try {
      if (engine.getZoneLevel(neighbor) === level) {
        ids.add(engine.getZoneTextID(neighbor));
      }
    } catch {
      // Garbage padding entry — skip.
    }
  }
  return [...ids];
}

function selectedCells(): string[] {
  if (!selectedCell) return [];
  return settings.includeNeighbors ? neighborCells(selectedCell) : [selectedCell];
}

function updateSelectedSource(): void {
  const engine = activeDggrs();
  if (!engine) return;
  const source = map?.getSource(SELECTED_SOURCE_ID) as GeoJSONSource | undefined;
  source?.setData({
    type: "FeatureCollection",
    features: selectedCells().map((cell) => dggalZoneFeature(engine, cell)),
  });
  const parentsSource = map?.getSource(PARENTS_SOURCE_ID) as GeoJSONSource | undefined;
  parentsSource?.setData({
    type: "FeatureCollection",
    features:
      settings.includeParents && selectedCell
        ? dggalParentZones(engine, selectedCell).map((cell) => dggalZoneFeature(engine, cell))
        : [],
  });
}

function gridCsv(grid: FeatureCollection<Polygon>): string {
  const header = "dggal,resolution,center_lat,center_lng";
  const rows = grid.features.map((feature) => {
    const p = feature.properties!;
    return [p.dggal, p.resolution, p.center_lat, p.center_lng].join(",");
  });
  return [header, ...rows].join("\n");
}

function fitSelected(): void {
  const engine = activeDggrs();
  if (!selectedCell || !appRef || !engine) return;
  // The ring stays contiguous across the antimeridian, so min/max longitudes
  // never span the world.
  const ring = zoneRing(engine, engine.getZoneFromTextID(selectedCell));
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

  const typeSelect = document.createElement("select");
  for (const name of DGGAL_TYPE_NAMES) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    typeSelect.appendChild(option);
  }
  typeSelect.value = settings.dggrsType;
  typeSelect.style.padding = "4px 6px";
  typeSelect.style.border = "1px solid hsl(var(--border))";
  typeSelect.style.borderRadius = "6px";
  typeSelect.style.background = "hsl(var(--background))";
  typeSelect.style.color = "inherit";
  typeSelect.addEventListener("change", () =>
    setDggalGridSettings({ dggrsType: typeSelect.value as DggalType }),
  );
  row(labels.gridType, typeSelect);

  const autoResolution = document.createElement("input");
  autoResolution.type = "checkbox";
  autoResolution.checked = settings.autoResolution;
  autoResolution.addEventListener("change", () =>
    setDggalGridSettings({ autoResolution: autoResolution.checked }),
  );
  row(labels.autoResolution, autoResolution);

  // In automatic mode the slider is a read-only indicator of the zoom-derived
  // resolution; updatePanelStatus() keeps it in sync on every moveend.
  const shownResolution = effectiveResolution();
  const resolution = document.createElement("input");
  resolution.dataset.dggalResolution = "";
  resolution.type = "range";
  resolution.min = "0";
  resolution.max = String(DGGAL_TYPES[settings.dggrsType]);
  resolution.value = String(shownResolution);
  resolution.title = String(shownResolution);
  resolution.disabled = settings.autoResolution;
  resolution.addEventListener("input", () => {
    resolution.title = resolution.value;
  });
  resolution.addEventListener("change", () =>
    setDggalGridSettings({ resolution: Number(resolution.value) }),
  );
  const resolutionWrap = document.createElement("span");
  resolutionWrap.style.display = "flex";
  resolutionWrap.style.alignItems = "center";
  resolutionWrap.style.gap = "6px";
  resolutionWrap.style.opacity = settings.autoResolution ? "0.6" : "1";
  const resolutionValue = document.createElement("strong");
  resolutionValue.dataset.dggalResolutionValue = "";
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
    // `change` (not `input`): setDggalGridSettings re-renders the panel,
    // which would destroy the picker mid-drag.
    input.addEventListener("change", () => setDggalGridSettings({ [key]: input.value }));
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
    input.addEventListener("change", () => setDggalGridSettings({ [key]: Number(input.value) }));
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
    input.addEventListener("change", () => setDggalGridSettings({ [key]: input.checked }));
    row(text, input);
  }

  const status = document.createElement("div");
  status.dataset.dggalStatus = "";
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

  const engine = activeDggrs();
  if (selectedCell && engine) {
    const zone = engine.getZoneFromTextID(selectedCell);
    const level = engine.getZoneLevel(zone);
    const centroid = engine.getZoneWGS84Centroid(zone);
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
    addDetail(labels.resolution, String(level));
    addDetail(
      labels.center,
      `${(centroid.lat * DEG_PER_RAD).toFixed(6)}, ${(centroid.lon * DEG_PER_RAD).toFixed(6)}`,
    );
    if (level > 0) {
      // Every overlapping parent one level up, matching the dashed parent
      // outlines on the map.
      addDetail(labels.parent, dggalParentZones(engine, selectedCell).join("\n"));
    }
    if (level < DGGAL_TYPES[settings.dggrsType]) {
      addDetail(labels.children, String(childZones(engine, selectedCell).length));
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
          appRef?.addGeoJsonLayer(
            `DGGAL ${settings.dggrsType} (resolution ${effectiveResolution()})`,
            currentGrid,
          );
        }
      },
      currentGrid.features.length === 0,
    ),
    button(
      labels.exportGeoJson,
      () => {
        appRef?.exportTextFile?.(
          `dggal-${settings.dggrsType.toLowerCase()}-r${effectiveResolution()}.geojson`,
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
        appRef?.exportTextFile?.(
          `dggal-${settings.dggrsType.toLowerCase()}-r${effectiveResolution()}.csv`,
          gridCsv(currentGrid),
          {
            description: "CSV",
            extensions: ["csv"],
            mimeType: "text/csv",
            promptName: true,
          },
        );
      },
      currentGrid.features.length === 0,
    ),
  );
  section.appendChild(actions);
}

function settingsEqual(a: DggalGridSettings, b: DggalGridSettings): boolean {
  return Object.keys(a).every(
    (key) => a[key as keyof DggalGridSettings] === b[key as keyof DggalGridSettings],
  );
}

export const maplibreDggalPlugin: GeoLibrePlugin = {
  id: DGGAL_PLUGIN_ID,
  name: "DGGAL",
  version: "1.0.0",
  activate: async (app) => {
    const activeMap = app.getMap?.();
    if (!activeMap) return false;
    const generation = (activationGeneration += 1);
    // Await WASM before mutating map/panel state so a deactivate during the
    // load cannot race a late attach (leaked listeners / panels / layers).
    let engine: DggalEngine;
    try {
      engine = await loadDggal();
    } catch (error) {
      if (generation === activationGeneration) {
        currentError = error instanceof Error ? error.message : String(error);
      }
      return false;
    }
    if (generation !== activationGeneration) return false;
    dggal = engine;
    map = activeMap;
    appRef = app;
    moveHandler = () => scheduleRefresh();
    clickHandler = (event) => {
      const engine = activeDggrs();
      if (!engine) return;
      const zone = engine.getZoneFromWGS84Centroid(effectiveResolution(), {
        lat: event.lngLat.lat * RAD_PER_DEG,
        lon: event.lngLat.lng * RAD_PER_DEG,
      });
      selectedCell = engine.getZoneTextID(zone);
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
        // Closing the panel ends the identify session: drop the clicked zone
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
    dggrs?.delete();
    dggrs = null;
    dggrsType = null;
    currentGrid = { type: "FeatureCollection", features: [] };
    currentError = null;
    cachedTextFont = null;
    dggal = null;
    map = null;
    appRef = null;
    app.closeRightPanel?.(PANEL_ID);
  },
  getProjectState: () =>
    settingsEqual(settings, DEFAULT_DGGAL_GRID_SETTINGS) ? undefined : { ...settings },
  applyProjectState: (_app, state) => {
    const next = normalizeDggalGridSettings(state);
    if (settingsEqual(settings, next)) return false;
    // A selection's zone ID is meaningless under another DGGRS, so a project
    // switching grid type drops it.
    if (next.dggrsType !== settings.dggrsType) {
      selectedCell = null;
    }
    settings = next;
    refresh();
    if (panelContainer) renderPanel(panelContainer);
  },
};
