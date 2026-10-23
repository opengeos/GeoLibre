import type { Feature, FeatureCollection, Polygon } from "geojson";
import { geojson as s2geojson, s1, s2 } from "s2js";
import {
  createGridPlugin,
  formatCenter,
  ringBounds,
  type GridLabelsBase,
  type GridSettingsBase,
} from "./grid-plugin-factory";

export const S2_PLUGIN_ID = "maplibre-s2-grid";

/** S2's finest subdivision (leaf cells). */
export const MAX_S2_LEVEL = 30;

/** Prevent a fine level over a large viewport from freezing the browser. */
export const S2_VIEWPORT_CELL_LIMIT = 20_000;

export interface S2GridSettings extends GridSettingsBase {
  /** S2 level (0-30). Named `resolution` for parity with the H3/A5 plugins. */
  resolution: number;
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

export interface S2Labels extends GridLabelsBase {
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

/**
 * The automatic zoom→level rule, mirroring vgrid-maplibre's S2Grid
 * (https://www.npmjs.com/package/vgrid-maplibre): one S2 level per zoom
 * level, clamped to the valid range.
 */
export function s2LevelForZoom(zoom: number): number {
  return Math.min(MAX_S2_LEVEL, Math.max(0, Math.floor(zoom)));
}

/**
 * Avoid thousands of overlapping IDs when the grid is viewed globally. S2 cell
 * area shrinks 4x per level (2x linearly), so one zoom level per S2 level
 * keeps the on-screen label density roughly constant.
 */
export function s2LabelMinZoom(level: number): number {
  return Math.min(18, Math.max(2, Math.round(level) + 1));
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

  const coverer = new s2geojson.RegionCoverer({
    minLevel: level,
    maxLevel: level,
  });
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

/** Edge neighbors only — `allNeighbors` would also include vertex neighbors. */
function neighborCells(cell: string): string[] {
  const id = cellIdFromToken(cell);
  return s2.cellid.edgeNeighbors(id).map((neighbor) => s2.cellid.toToken(neighbor));
}

/**
 * The direct parent, or none for a level-0 (face) cell. S2 cells nest exactly,
 * so a cell always has a single parent.
 */
function parentCells(cell: string): string[] {
  const id = cellIdFromToken(cell);
  const level = s2.cellid.level(id);
  return level > 0 ? [s2.cellid.toToken(s2.cellid.parent(id, level - 1))] : [];
}

const grid = createGridPlugin<S2GridSettings, S2Labels>({
  id: S2_PLUGIN_ID,
  name: "S2 Grid",
  slug: "s2",
  parentKey: "includeParents",
  defaultSettings: DEFAULT_S2_GRID_SETTINGS,
  defaultLabels: DEFAULT_S2_LABELS,
  resolutionControl: { kind: "range", min: 0, max: MAX_S2_LEVEL },
  viewportCellLimit: S2_VIEWPORT_CELL_LIMIT,
  resolutionForZoom: s2LevelForZoom,
  labelMinZoom: s2LabelMinZoom,
  gridForBounds: (bounds, level) => s2GridForBounds(bounds, level),
  cellFeature: s2CellFeature,
  cellAtLngLat: cellAtLonLat,
  reindexCell,
  neighborCells,
  parentCells,
  cellBounds: (cell) => ringBounds(cellRing(cellIdFromToken(cell))),
  cellDetails: (cell, labels) => {
    const id = cellIdFromToken(cell);
    const level = s2.cellid.level(id);
    const [lng, lat] = cellCenter(id);
    const rows: Array<[string, string]> = [
      [labels.resolution, String(level)],
      [labels.center, formatCenter(lat, lng)],
    ];
    if (level > 0) rows.push([labels.parent, s2.cellid.toToken(s2.cellid.parent(id, level - 1))]);
    if (level < MAX_S2_LEVEL) rows.push([labels.children, String(s2.cellid.children(id).length)]);
    return rows;
  },
  idProperty: "s2",
  csvColumns: ["s2", "resolution", "center_lat", "center_lng"],
  layerName: (level) => `S2 grid (resolution ${level})`,
  exportBaseName: (level) => `s2-grid-r${level}`,
});

export const maplibreS2Plugin = grid.plugin;
export const setS2Labels = grid.setLabels;
export const getS2GridSettings = grid.getSettings;
export const setS2GridSettings = grid.setSettings;
export const normalizeS2GridSettings = grid.normalizeSettings;
