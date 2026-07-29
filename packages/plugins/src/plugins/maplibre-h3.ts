import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";
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

export const H3_PLUGIN_ID = "maplibre-h3-grid";

const PANEL_ID = "geolibre-h3-panel";
const SOURCE_ID = "geolibre-h3-grid-source";
const FILL_LAYER_ID = "geolibre-h3-grid-fill";
const LINE_LAYER_ID = "geolibre-h3-grid-line";
const LABEL_LAYER_ID = "geolibre-h3-grid-label";
const SELECTED_SOURCE_ID = "geolibre-h3-selected-source";
const SELECTED_FILL_LAYER_ID = "geolibre-h3-selected-fill";
const SELECTED_LINE_LAYER_ID = "geolibre-h3-selected-line";

/** Prevent a fine resolution over a large viewport from freezing the browser. */
export const H3_VIEWPORT_CELL_LIMIT = 20_000;

export interface H3GridSettings {
  resolution: number;
  fillColor: string;
  fillOpacity: number;
  lineColor: string;
  lineWidth: number;
  showLabels: boolean;
  includeNeighbors: boolean;
}

export const DEFAULT_H3_GRID_SETTINGS: H3GridSettings = {
  // Useful immediately at GeoLibre's default world view (resolution 3 would
  // already exceed the viewport safety cap).
  resolution: 2,
  fillColor: "#2563eb",
  fillOpacity: 0.08,
  lineColor: "#2563eb",
  lineWidth: 1,
  showLabels: true,
  includeNeighbors: false,
};

export interface H3Labels {
  title: string;
  getTitle?: () => string;
  controlTitle: string;
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
}

export const DEFAULT_H3_LABELS: H3Labels = {
  title: "H3 Grid",
  controlTitle: "H3 grid settings",
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
  parent: "Parent",
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
type H3PolygonGeometry = Polygon | MultiPolygon;

let currentGrid: FeatureCollection<H3PolygonGeometry> = { type: "FeatureCollection", features: [] };
let currentError: string | null = null;
let cachedTextFont: string[] | null = null;

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

export function normalizeH3GridSettings(value: unknown): H3GridSettings {
  const candidate = (value ?? {}) as Partial<H3GridSettings>;
  return {
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
  };
}

/** Avoid thousands of overlapping IDs when the grid is viewed globally. */
export function h3LabelMinZoom(resolution: number): number {
  return Math.min(18, Math.max(3, Math.round(resolution) + 3));
}

export function setH3GridSettings(patch: Partial<H3GridSettings>): void {
  const previousResolution = settings.resolution;
  settings = normalizeH3GridSettings({ ...settings, ...patch });
  if (selectedCell && settings.resolution !== previousResolution) {
    const [lat, lng] = cellToLatLng(selectedCell);
    selectedCell = latLngToCell(lat, lng, settings.resolution);
  }
  refresh();
  if (panelContainer) renderPanel(panelContainer);
}

/**
 * Keep a cell boundary contiguous around its center. h3-js returns longitudes
 * in [-180, 180], so a cell straddling the antimeridian otherwise contains a
 * ~360° jump that MapLibre draws as a line across the entire world.
 *
 * MapLibre accepts unwrapped longitudes outside [-180, 180] and places them in
 * the adjacent world copy, which preserves the small hexagon at the seam.
 */
export function unwrapH3Boundary(
  ring: [number, number][],
  centerLongitude: number,
): [number, number][] {
  return ring.map(([longitude, latitude]) => {
    let unwrapped = longitude;
    while (unwrapped - centerLongitude > 180) unwrapped -= 360;
    while (unwrapped - centerLongitude < -180) unwrapped += 360;
    return [unwrapped, latitude];
  });
}

function clipRingAtLongitude(
  ring: [number, number][],
  longitude: number,
  keepLower: boolean,
): [number, number][] {
  const output: [number, number][] = [];
  const points =
    ring.at(-1)?.[0] === ring[0]?.[0] && ring.at(-1)?.[1] === ring[0]?.[1]
      ? ring.slice(0, -1)
      : ring;
  if (points.length < 3) return [];

  const inside = ([x]: [number, number]): boolean => (keepLower ? x <= longitude : x >= longitude);
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const previous = points[(index + points.length - 1) % points.length];
    const currentInside = inside(current);
    const previousInside = inside(previous);
    if (currentInside !== previousInside) {
      const ratio = (longitude - previous[0]) / (current[0] - previous[0]);
      output.push([longitude, previous[1] + ratio * (current[1] - previous[1])]);
    }
    if (currentInside) output.push(current);
  }
  if (output.length >= 3) output.push([...output[0]] as [number, number]);
  return output;
}

/** Split a contiguous cell ring at ±180° so exported coordinates stay valid. */
export function h3BoundaryGeometry(
  ring: [number, number][],
  centerLongitude: number,
): H3PolygonGeometry {
  const unwrapped = unwrapH3Boundary(ring, centerLongitude);
  const longitudes = unwrapped.map(([longitude]) => longitude);
  const min = Math.min(...longitudes);
  const max = Math.max(...longitudes);
  if (max <= 180 && min >= -180) {
    return { type: "Polygon", coordinates: [unwrapped] };
  }

  if (max > 180) {
    const west = clipRingAtLongitude(unwrapped, 180, true);
    const east = clipRingAtLongitude(unwrapped, 180, false).map(
      ([longitude, latitude]) => [longitude - 360, latitude] as [number, number],
    );
    return { type: "MultiPolygon", coordinates: [[west], [east]] };
  }

  const east = clipRingAtLongitude(unwrapped, -180, false);
  const west = clipRingAtLongitude(unwrapped, -180, true).map(
    ([longitude, latitude]) => [longitude + 360, latitude] as [number, number],
  );
  return { type: "MultiPolygon", coordinates: [[east], [west]] };
}

/** Convert an H3 cell to a GeoJSON polygon with useful export attributes. */
export function h3CellFeature(cell: string): Feature<H3PolygonGeometry> {
  const [lat, lng] = cellToLatLng(cell);
  const boundary = cellToBoundary(cell, true) as [number, number][];
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
    geometry: h3BoundaryGeometry(boundary, lng),
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
): FeatureCollection<H3PolygonGeometry> {
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
    LABEL_LAYER_ID,
    LINE_LAYER_ID,
    FILL_LAYER_ID,
  ]) {
    if (activeMap.getLayer(id)) activeMap.removeLayer(id);
  }
  for (const id of [SELECTED_SOURCE_ID, SOURCE_ID]) {
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
      minzoom: h3LabelMinZoom(settings.resolution),
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
      paint: { "line-color": "#f59e0b", "line-width": 3 },
    });
  }
}

function refresh(): void {
  if (!map) return;
  try {
    const bounds = map.getBounds();
    currentGrid = h3GridForBounds(
      [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
      settings.resolution,
    );
    currentError = null;
  } catch (error) {
    currentGrid = { type: "FeatureCollection", features: [] };
    currentError =
      error instanceof RangeError ? labels.tooManyCells(H3_VIEWPORT_CELL_LIMIT) : String(error);
  }
  ensureLayers();
  (map.getSource(SOURCE_ID) as GeoJSONSource | undefined)?.setData(currentGrid);
  map.setPaintProperty(FILL_LAYER_ID, "fill-color", settings.fillColor);
  map.setPaintProperty(FILL_LAYER_ID, "fill-opacity", settings.fillOpacity);
  map.setPaintProperty(LINE_LAYER_ID, "line-color", settings.lineColor);
  map.setPaintProperty(LINE_LAYER_ID, "line-width", settings.lineWidth);
  map.setPaintProperty(LABEL_LAYER_ID, "text-color", settings.lineColor);
  map.setLayoutProperty(LABEL_LAYER_ID, "visibility", settings.showLabels ? "visible" : "none");
  map.setLayerZoomRange(LABEL_LAYER_ID, h3LabelMinZoom(settings.resolution), 24);
  updateSelectedSource();
  if (panelContainer) renderPanel(panelContainer);
}

function selectedCells(): string[] {
  if (!selectedCell) return [];
  return settings.includeNeighbors ? gridDisk(selectedCell, 1) : [selectedCell];
}

function updateSelectedSource(): void {
  const source = map?.getSource(SELECTED_SOURCE_ID) as GeoJSONSource | undefined;
  source?.setData({
    type: "FeatureCollection",
    features: selectedCells().map(h3CellFeature),
  });
}

function gridCsv(grid: FeatureCollection<H3PolygonGeometry>): string {
  const header = "h3,resolution,base_cell,center_lat,center_lng,is_pentagon";
  const rows = grid.features.map((feature) => {
    const p = feature.properties!;
    return [p.h3, p.resolution, p.base_cell, p.center_lat, p.center_lng, p.is_pentagon].join(",");
  });
  return [header, ...rows].join("\n");
}

function fitSelected(): void {
  if (!selectedCell || !appRef) return;
  const [, centerLongitude] = cellToLatLng(selectedCell);
  const ring = unwrapH3Boundary(
    cellToBoundary(selectedCell, true) as [number, number][],
    centerLongitude,
  );
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

  const resolution = document.createElement("input");
  resolution.type = "range";
  resolution.min = "0";
  resolution.max = "15";
  resolution.value = String(settings.resolution);
  resolution.title = String(settings.resolution);
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
  const resolutionValue = document.createElement("strong");
  resolutionValue.textContent = String(settings.resolution);
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
    input.addEventListener("input", () => setH3GridSettings({ [key]: input.value }));
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
      details.append(dt, dd);
    };
    addDetail("ID", selectedCell);
    addDetail(labels.resolution, String(getResolution(selectedCell)));
    addDetail(labels.baseCell, String(getBaseCellNumber(selectedCell)));
    addDetail(labels.center, `${lat.toFixed(6)}, ${lng.toFixed(6)}`);
    addDetail(labels.pentagon, isPentagon(selectedCell) ? labels.yes : labels.no);
    if (getResolution(selectedCell) > 0) {
      addDetail(labels.parent, cellToParent(selectedCell, getResolution(selectedCell) - 1));
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
          appRef?.addGeoJsonLayer(`H3 grid (resolution ${settings.resolution})`, currentGrid);
        }
      },
      currentGrid.features.length === 0,
    ),
    button(
      labels.exportGeoJson,
      () => {
        appRef?.exportTextFile?.(
          `h3-grid-r${settings.resolution}.geojson`,
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
        appRef?.exportTextFile?.(`h3-grid-r${settings.resolution}.csv`, gridCsv(currentGrid), {
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
    moveHandler = () => refresh();
    clickHandler = (event) => {
      selectedCell = latLngToCell(event.lngLat.lat, event.lngLat.lng, settings.resolution);
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
      }) ?? null;
    refresh();
    app.openRightPanel?.(PANEL_ID);
  },
  deactivate: (app) => {
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
