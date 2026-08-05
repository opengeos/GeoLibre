import type { Feature, FeatureCollection, Polygon } from "geojson";
import type { GeoJSONSource, Map as MapLibreMap, MapMouseEvent } from "maplibre-gl";
import OpenLocationCodeModule from "open-location-code-typescript";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

// The library ships CommonJS with an `exports.default` class. Depending on
// who loads it (Vite, tsx's CJS transform, Node's native ESM interop) the
// default import is either the class or the exports object wrapping it.
const OpenLocationCode = ((OpenLocationCodeModule as { default?: unknown }).default ??
  OpenLocationCodeModule) as typeof OpenLocationCodeModule;

export const OLC_PLUGIN_ID = "maplibre-olc";

const PANEL_ID = "geolibre-olc-panel";
const SOURCE_ID = "geolibre-olc-grid-source";
const FILL_LAYER_ID = "geolibre-olc-grid-fill";
const LINE_LAYER_ID = "geolibre-olc-grid-line";
const LABEL_LAYER_ID = "geolibre-olc-grid-label";
const SELECTED_SOURCE_ID = "geolibre-olc-selected-source";
const SELECTED_FILL_LAYER_ID = "geolibre-olc-selected-fill";
const SELECTED_LINE_LAYER_ID = "geolibre-olc-selected-line";
const PARENT_SOURCE_ID = "geolibre-olc-parent-source";
const PARENT_LINE_LAYER_ID = "geolibre-olc-parent-line";

const SELECTED_LINE_WIDTH = 3;

/** Prevent a fine code length over a large viewport from freezing the browser. */
export const OLC_VIEWPORT_CELL_LIMIT = 20_000;

/**
 * The code lengths a full Open Location Code can have: digit pairs up to 10,
 * then single grid-refinement digits (where cells stop being square).
 */
export const OLC_CODE_LENGTHS = [2, 4, 6, 8, 10, 11, 12, 13, 14, 15] as const;

export type OlcCodeLength = (typeof OLC_CODE_LENGTHS)[number];

export const MAX_OLC_CODE_LENGTH: OlcCodeLength = 15;

export interface OlcGridSettings {
  /** Derive the code length from the map zoom instead of the manual picker. */
  autoResolution: boolean;
  /** Full code length ("resolution"): one of OLC_CODE_LENGTHS. */
  resolution: OlcCodeLength;
  fillColor: string;
  fillOpacity: number;
  lineColor: string;
  lineWidth: number;
  showLabels: boolean;
  includeNeighbors: boolean;
  includeParent: boolean;
}

export const DEFAULT_OLC_GRID_SETTINGS: OlcGridSettings = {
  autoResolution: true,
  // Useful immediately at GeoLibre's default world view: length-2 codes tile
  // the globe with 162 twenty-degree cells.
  resolution: 2,
  fillColor: "#e11d48",
  fillOpacity: 0.08,
  lineColor: "#e11d48",
  lineWidth: 1,
  showLabels: true,
  includeNeighbors: false,
  includeParent: false,
};

export interface OlcLabels {
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

export const DEFAULT_OLC_LABELS: OlcLabels = {
  title: "OLC",
  controlTitle: "OLC settings",
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
  identifyHint: "Click the map to identify an OLC cell.",
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

let labels: OlcLabels = { ...DEFAULT_OLC_LABELS };
let settings: OlcGridSettings = { ...DEFAULT_OLC_GRID_SETTINGS };
let map: MapLibreMap | null = null;
let appRef: GeoLibreAppAPI | null = null;
let unregisterPanel: (() => void) | null = null;
let moveHandler: (() => void) | null = null;
let clickHandler: ((event: MapMouseEvent) => void) | null = null;
let unsubscribeBasemap: (() => void) | null = null;
let panelContainer: HTMLElement | null = null;
/** The selected cell's full Open Location Code (encodes its own length). */
let selectedCell: string | null = null;

let currentGrid: FeatureCollection<Polygon> = { type: "FeatureCollection", features: [] };
let currentError: string | null = null;
let cachedTextFont: string[] | null = null;
let pendingRefresh: number | null = null;

/**
 * Coalesce viewport-driven rebuilds. Inertial pans emit `moveend` in bursts,
 * and each rebuild materializes up to OLC_VIEWPORT_CELL_LIMIT cells on the
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

export function setOlcLabels(next: Partial<OlcLabels>): void {
  labels = { ...labels, ...next };
  if (panelContainer) renderPanel(panelContainer);
}

export function getOlcGridSettings(): OlcGridSettings {
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

/** Snap an arbitrary number to the nearest valid full-code length. */
function toCodeLength(value: unknown, fallback: OlcCodeLength): OlcCodeLength {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  let best: OlcCodeLength = OLC_CODE_LENGTHS[0];
  for (const length of OLC_CODE_LENGTHS) {
    if (Math.abs(length - number) < Math.abs(best - number)) best = length;
  }
  return best;
}

/**
 * The automatic zoom→code-length rule, mirroring vgrid-maplibre's OLCGrid
 * (https://www.npmjs.com/package/vgrid-maplibre): step through the valid
 * lengths as the ~20°/1°/0.05°… cells reach a useful on-screen size.
 */
export function olcResolutionForZoom(zoom: number): OlcCodeLength {
  if (zoom <= 6) return 2;
  if (zoom <= 10) return 4;
  if (zoom <= 14) return 6;
  if (zoom <= 18) return 8;
  if (zoom <= 21) return 10;
  if (zoom <= 23) return 11;
  if (zoom <= 25) return 12;
  if (zoom <= 27) return 13;
  if (zoom <= 29) return 14;
  return 15;
}

/** The code length actually rendered: zoom-derived when automatic, else manual. */
function effectiveResolution(): OlcCodeLength {
  return settings.autoResolution && map ? olcResolutionForZoom(map.getZoom()) : settings.resolution;
}

export function normalizeOlcGridSettings(value: unknown): OlcGridSettings {
  const candidate = (value ?? {}) as Partial<OlcGridSettings>;
  return {
    autoResolution:
      typeof candidate.autoResolution === "boolean"
        ? candidate.autoResolution
        : DEFAULT_OLC_GRID_SETTINGS.autoResolution,
    resolution: toCodeLength(candidate.resolution, DEFAULT_OLC_GRID_SETTINGS.resolution),
    fillColor: color(candidate.fillColor, DEFAULT_OLC_GRID_SETTINGS.fillColor),
    fillOpacity: clampNumber(candidate.fillOpacity, 0, 1, DEFAULT_OLC_GRID_SETTINGS.fillOpacity),
    lineColor: color(candidate.lineColor, DEFAULT_OLC_GRID_SETTINGS.lineColor),
    lineWidth: clampNumber(candidate.lineWidth, 0.1, 8, DEFAULT_OLC_GRID_SETTINGS.lineWidth),
    showLabels:
      typeof candidate.showLabels === "boolean"
        ? candidate.showLabels
        : DEFAULT_OLC_GRID_SETTINGS.showLabels,
    includeNeighbors:
      typeof candidate.includeNeighbors === "boolean"
        ? candidate.includeNeighbors
        : DEFAULT_OLC_GRID_SETTINGS.includeNeighbors,
    includeParent:
      typeof candidate.includeParent === "boolean"
        ? candidate.includeParent
        : DEFAULT_OLC_GRID_SETTINGS.includeParent,
  };
}

/**
 * Avoid thousands of overlapping IDs when the grid is viewed globally: show
 * labels only from the zoom step below the one whose automatic rule picks the
 * next (finer) code length.
 */
export function olcLabelMinZoom(codeLength: number): number {
  const minZoom: Record<number, number> = {
    2: 2,
    4: 5,
    6: 9,
    8: 13,
    10: 17,
    11: 19,
    12: 21,
    13: 22,
    14: 23,
    15: 24,
  };
  return minZoom[toCodeLength(codeLength, 2)] ?? 2;
}

export function setOlcGridSettings(patch: Partial<OlcGridSettings>): void {
  const previousResolution = effectiveResolution();
  // Leaving automatic mode adopts the current zoom-derived code length as the
  // fixed one, so the grid stays put instead of jumping to the stale picker.
  if (settings.autoResolution && patch.autoResolution === false && patch.resolution === undefined) {
    patch = { ...patch, resolution: previousResolution };
  }
  settings = normalizeOlcGridSettings({ ...settings, ...patch });
  const resolution = effectiveResolution();
  // Re-derive the selection only for an explicit code-length change; toggling
  // automatic resolution (like zooming in automatic mode) keeps the clicked
  // cell and its neighbors/parent as they are.
  if (selectedCell && patch.resolution !== undefined && resolution !== previousResolution) {
    const area = OpenLocationCode.decode(selectedCell);
    selectedCell = OpenLocationCode.encode(area.latitudeCenter, area.longitudeCenter, resolution);
  }
  // Only the rendered code length changes the geometry, so a paint/layout-only
  // edit skips rebuilding up to OLC_VIEWPORT_CELL_LIMIT features.
  if (resolution !== previousResolution) {
    refresh();
  } else {
    applyStyle();
    updateSelectedSource();
  }
  if (panelContainer) renderPanel(panelContainer);
}

/**
 * Convert an OLC cell to a GeoJSON polygon with export attributes. `lngOffset`
 * (a multiple of 360) places the ring in the world copy a dateline-crossing
 * viewport is actually looking at.
 */
export function olcCellFeature(cell: string, lngOffset = 0): Feature<Polygon> {
  const area = OpenLocationCode.decode(cell);
  const west = area.longitudeLo + lngOffset;
  const east = area.longitudeHi + lngOffset;
  return {
    type: "Feature",
    id: cell,
    properties: {
      olc: cell,
      resolution: area.codeLength,
      center_lat: area.latitudeCenter,
      center_lng: area.longitudeCenter,
    },
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [west, area.latitudeLo],
          [east, area.latitudeLo],
          [east, area.latitudeHi],
          [west, area.latitudeHi],
          [west, area.latitudeLo],
        ],
      ],
    },
  };
}

/**
 * Fill a WGS84 bounding box with OLC cells, mirroring vgrid-maplibre's
 * OLCGrid: cells are an axis-aligned lat/lon grid anchored at -180/-90, so
 * the fill walks the rows and columns intersecting the box. Longitudes may
 * run past ±180 (MapLibre's continuous bounds); each cell is encoded from its
 * normalized centroid but drawn in the viewport's world copy.
 */
export function olcGridForBounds(
  bounds: [number, number, number, number],
  codeLength: OlcCodeLength,
  limit = OLC_VIEWPORT_CELL_LIMIT,
): FeatureCollection<Polygon> {
  let [west, south, east, north] = bounds;
  south = Math.max(-90, Math.min(90, south));
  north = Math.max(-90, Math.min(90, north));
  if (east - west >= 360) {
    west = -180;
    east = 180;
  }
  // Above length 10 the grid refinement is 4 columns × 5 rows, so measure the
  // two cell dimensions independently from a reference cell.
  const reference = OpenLocationCode.decode(OpenLocationCode.encode(0, 0, codeLength));
  const latHeight = reference.getLatitudeHeight();
  const lngWidth = reference.getLongitudeWidth();

  if (((east - west) / lngWidth) * ((north - south) / latHeight) > limit * 1.2) {
    throw new RangeError(`OLC cell limit exceeded: ${limit}`);
  }

  const startLng = Math.floor((west + 180) / lngWidth) * lngWidth - 180;
  const startLat = Math.max(-90, Math.floor((south + 90) / latHeight) * latHeight - 90);

  const features: Feature<Polygon>[] = [];
  // Floating-point walks of the grid can land on the same cell twice near
  // cell boundaries; key by (id, world copy) so a dateline-crossing view can
  // still draw the same code in two adjacent copies.
  const seen = new Set<string>();
  for (let lng = startLng; lng < east; lng += lngWidth) {
    for (let lat = startLat; lat < north && lat < 90; lat += latHeight) {
      const centerLng = lng + lngWidth / 2;
      const cell = OpenLocationCode.encode(lat + latHeight / 2, centerLng, codeLength);
      // 360° multiple between the drawn column and the normalized cell.
      const lngOffset =
        Math.round((centerLng - OpenLocationCode.decode(cell).longitudeCenter) / 360) * 360;
      const key = `${cell}@${lngOffset}`;
      if (seen.has(key)) continue;
      seen.add(key);
      features.push(olcCellFeature(cell, lngOffset));
      if (features.length > limit) {
        throw new RangeError(`OLC cell limit exceeded: ${limit}`);
      }
    }
  }
  return { type: "FeatureCollection", features };
}

/**
 * OLC is a strictly nested grid, so a cell has exactly one parent: the cell
 * at the previous valid code length containing its center.
 */
export function olcParentCell(cell: string): string | null {
  const area = OpenLocationCode.decode(cell);
  const index = OLC_CODE_LENGTHS.indexOf(area.codeLength as OlcCodeLength);
  if (index <= 0) return null;
  return OpenLocationCode.encode(
    area.latitudeCenter,
    area.longitudeCenter,
    OLC_CODE_LENGTHS[index - 1],
  );
}

/** How many cells of the next valid code length subdivide this cell. */
export function olcChildCount(cell: string): number {
  const area = OpenLocationCode.decode(cell);
  const index = OLC_CODE_LENGTHS.indexOf(area.codeLength as OlcCodeLength);
  if (index < 0 || index >= OLC_CODE_LENGTHS.length - 1) return 0;
  const child = OpenLocationCode.decode(
    OpenLocationCode.encode(area.latitudeCenter, area.longitudeCenter, OLC_CODE_LENGTHS[index + 1]),
  );
  return Math.round(
    (area.getLatitudeHeight() / child.getLatitudeHeight()) *
      (area.getLongitudeWidth() / child.getLongitudeWidth()),
  );
}

/**
 * The cell plus its (up to 8) surrounding grid cells, encoded from offset
 * centroids. Cells in the top and bottom rows have no neighbors past the
 * poles; the longitude wraps via encode's normalization.
 */
export function olcNeighborCells(cell: string): string[] {
  const area = OpenLocationCode.decode(cell);
  const latHeight = area.getLatitudeHeight();
  const lngWidth = area.getLongitudeWidth();
  const ids = new Set<string>([cell]);
  for (const dLat of [-1, 0, 1]) {
    for (const dLng of [-1, 0, 1]) {
      if (dLat === 0 && dLng === 0) continue;
      const lat = area.latitudeCenter + dLat * latHeight;
      if (lat < -90 || lat > 90) continue;
      ids.add(
        OpenLocationCode.encode(lat, area.longitudeCenter + dLng * lngWidth, area.codeLength),
      );
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
      minzoom: olcLabelMinZoom(effectiveResolution()),
      layout: {
        "text-field": ["get", "olc"],
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
  map.setLayerZoomRange(LABEL_LAYER_ID, olcLabelMinZoom(effectiveResolution()), 24);
}

function refresh(): void {
  if (!map) return;
  const resolution = effectiveResolution();
  // The selected cell (and its neighbors/parent) deliberately stays at the
  // code length it was clicked at: in automatic mode a zoom or pan changes
  // the rendered grid, but re-deriving the selection would silently replace
  // the cell the user identified. Only an explicit settings change re-indexes
  // it (see setOlcGridSettings).
  try {
    const bounds = map.getBounds();
    currentGrid = olcGridForBounds(
      [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
      resolution,
    );
    currentError = null;
  } catch (error) {
    currentGrid = { type: "FeatureCollection", features: [] };
    currentError =
      error instanceof RangeError ? labels.tooManyCells(OLC_VIEWPORT_CELL_LIMIT) : String(error);
  }
  applyStyle();
  (map.getSource(SOURCE_ID) as GeoJSONSource | undefined)?.setData(currentGrid);
  updateSelectedSource();
  if (panelContainer) renderPanel(panelContainer);
}

function selectedCells(): string[] {
  if (!selectedCell) return [];
  return settings.includeNeighbors ? olcNeighborCells(selectedCell) : [selectedCell];
}

function updateSelectedSource(): void {
  const source = map?.getSource(SELECTED_SOURCE_ID) as GeoJSONSource | undefined;
  source?.setData({
    type: "FeatureCollection",
    features: selectedCells().map((cell) => olcCellFeature(cell)),
  });
  const parent = settings.includeParent && selectedCell ? olcParentCell(selectedCell) : null;
  const parentSource = map?.getSource(PARENT_SOURCE_ID) as GeoJSONSource | undefined;
  parentSource?.setData({
    type: "FeatureCollection",
    features: parent ? [olcCellFeature(parent)] : [],
  });
}

function gridCsv(grid: FeatureCollection<Polygon>): string {
  const header = "olc,resolution,center_lat,center_lng";
  const rows = grid.features.map((feature) => {
    const p = feature.properties!;
    return [p.olc, p.resolution, p.center_lat, p.center_lng].join(",");
  });
  return [header, ...rows].join("\n");
}

function fitSelected(): void {
  if (!selectedCell || !appRef) return;
  const area = OpenLocationCode.decode(selectedCell);
  appRef.fitBounds?.([area.longitudeLo, area.latitudeLo, area.longitudeHi, area.latitudeHi]);
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
    setOlcGridSettings({ autoResolution: autoResolution.checked }),
  );
  row(labels.autoResolution, autoResolution);

  // Valid code lengths are not contiguous (…8, 10, 11…), so a dropdown
  // replaces the range slider the other DGGS panels use. In automatic mode it
  // becomes a read-only indicator of the zoom-derived length; refresh()
  // re-renders the panel on every moveend, so it tracks zoom gestures.
  const resolutionSelect = document.createElement("select");
  for (const length of OLC_CODE_LENGTHS) {
    const option = document.createElement("option");
    option.value = String(length);
    option.textContent = String(length);
    resolutionSelect.appendChild(option);
  }
  resolutionSelect.value = String(effectiveResolution());
  resolutionSelect.disabled = settings.autoResolution;
  resolutionSelect.style.padding = "4px 6px";
  resolutionSelect.style.border = "1px solid hsl(var(--border))";
  resolutionSelect.style.borderRadius = "6px";
  resolutionSelect.style.background = "hsl(var(--background))";
  resolutionSelect.style.color = "inherit";
  resolutionSelect.style.opacity = settings.autoResolution ? "0.6" : "1";
  resolutionSelect.addEventListener("change", () =>
    setOlcGridSettings({ resolution: Number(resolutionSelect.value) as OlcCodeLength }),
  );
  row(labels.resolution, resolutionSelect);

  for (const [text, key] of [
    [labels.fillColor, "fillColor"],
    [labels.lineColor, "lineColor"],
  ] as const) {
    const input = document.createElement("input");
    input.type = "color";
    input.value = settings[key];
    // `change` (not `input`): setOlcGridSettings re-renders the panel, which
    // would destroy the picker mid-drag.
    input.addEventListener("change", () => setOlcGridSettings({ [key]: input.value }));
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
    input.addEventListener("change", () => setOlcGridSettings({ [key]: Number(input.value) }));
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
    input.addEventListener("change", () => setOlcGridSettings({ [key]: input.checked }));
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
    const area = OpenLocationCode.decode(selectedCell);
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
    addDetail(labels.resolution, String(area.codeLength));
    addDetail(
      labels.center,
      `${area.latitudeCenter.toFixed(6)}, ${area.longitudeCenter.toFixed(6)}`,
    );
    const parent = olcParentCell(selectedCell);
    if (parent) addDetail(labels.parent, parent);
    const children = olcChildCount(selectedCell);
    if (children > 0) addDetail(labels.children, String(children));
    addDetail(labels.neighbors, String(olcNeighborCells(selectedCell).length - 1));
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
          appRef?.addGeoJsonLayer(`OLC (res ${effectiveResolution()})`, currentGrid);
        }
      },
      currentGrid.features.length === 0,
    ),
    button(
      labels.exportGeoJson,
      () => {
        appRef?.exportTextFile?.(
          `olc-l${effectiveResolution()}.geojson`,
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
        appRef?.exportTextFile?.(`olc-l${effectiveResolution()}.csv`, gridCsv(currentGrid), {
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

function settingsEqual(a: OlcGridSettings, b: OlcGridSettings): boolean {
  return Object.keys(a).every(
    (key) => a[key as keyof OlcGridSettings] === b[key as keyof OlcGridSettings],
  );
}

export const maplibreOlcPlugin: GeoLibrePlugin = {
  id: OLC_PLUGIN_ID,
  name: "OLC",
  version: "1.0.0",
  activate: (app) => {
    const activeMap = app.getMap?.();
    if (!activeMap) return false;
    map = activeMap;
    appRef = app;
    moveHandler = () => scheduleRefresh();
    clickHandler = (event) => {
      selectedCell = OpenLocationCode.encode(
        event.lngLat.lat,
        event.lngLat.lng,
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
    settingsEqual(settings, DEFAULT_OLC_GRID_SETTINGS) ? undefined : { ...settings },
  applyProjectState: (_app, state) => {
    const next = normalizeOlcGridSettings(state);
    if (settingsEqual(settings, next)) return false;
    settings = next;
    refresh();
  },
};
