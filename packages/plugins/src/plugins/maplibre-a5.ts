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
import {
  createGridPlugin,
  formatCenter,
  ringBounds,
  type GridLabelsBase,
  type GridSettingsBase,
} from "./grid-plugin-factory";

export const A5_PLUGIN_ID = "maplibre-a5-grid";

/** Prevent a fine resolution over a large viewport from freezing the browser. */
export const A5_VIEWPORT_CELL_LIMIT = 20_000;

// a5-js brands its coordinate tuples; the brand is not exported, so it is
// recovered from the function signatures at the two casting boundaries below.
type A5LonLat = Parameters<typeof lonLatToCell>[0];

export interface A5GridSettings extends GridSettingsBase {
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

export interface A5Labels extends GridLabelsBase {
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
 * The automatic zoom→resolution rule, mirroring vgrid-maplibre's A5Grid
 * (https://www.npmjs.com/package/vgrid-maplibre): one A5 resolution per zoom
 * level, clamped to the valid range.
 */
export function a5ResolutionForZoom(zoom: number): number {
  return Math.min(MAX_RESOLUTION, Math.max(0, Math.floor(zoom)));
}

/**
 * Avoid thousands of overlapping IDs when the grid is viewed globally. A5 cell
 * area shrinks 4x per resolution step (2x linearly), so one zoom level per
 * resolution keeps the on-screen label density roughly constant.
 */
export function a5LabelMinZoom(resolution: number): number {
  return Math.min(18, Math.max(2, Math.round(resolution) + 1));
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

function neighborCells(cell: string): string[] {
  const id = hexToU64(cell);
  // gridDisk compacts its result, so expand back to the cell's resolution.
  return [...uncompact(gridDisk(id, 1), getResolution(id))]
    .map(u64ToHex)
    .filter((neighbor) => neighbor !== cell);
}

/**
 * The canonical parent at resolution r-1, or none for a resolution-0 cell.
 * Uses a5-js `cellToParent` — one unique parent per cell.
 */
function parentCells(cell: string): string[] {
  const id = hexToU64(cell);
  return getResolution(id) > 0 ? [u64ToHex(cellToParent(id))] : [];
}

const grid = createGridPlugin<A5GridSettings, A5Labels>({
  id: A5_PLUGIN_ID,
  name: "A5 Grid",
  slug: "a5",
  parentKey: "includeParents",
  defaultSettings: DEFAULT_A5_GRID_SETTINGS,
  defaultLabels: DEFAULT_A5_LABELS,
  resolutionControl: { kind: "range", min: 0, max: MAX_RESOLUTION },
  viewportCellLimit: A5_VIEWPORT_CELL_LIMIT,
  resolutionForZoom: a5ResolutionForZoom,
  labelMinZoom: a5LabelMinZoom,
  gridForBounds: (bounds, resolution) => a5GridForBounds(bounds, resolution),
  cellFeature: a5CellFeature,
  cellAtLngLat: (lng, lat, resolution) =>
    u64ToHex(lonLatToCell([lng, lat] as A5LonLat, resolution)),
  reindexCell: (cell, resolution) =>
    u64ToHex(lonLatToCell(cellToLonLat(hexToU64(cell)), resolution)),
  neighborCells,
  parentCells,
  // The ring is unwrapped to stay contiguous across the antimeridian, so
  // min/max longitudes never span the world.
  cellBounds: (cell) =>
    ringBounds(a5UnwrapBoundary(cellToBoundary(hexToU64(cell)) as [number, number][])),
  cellDetails: (cell, labels) => {
    const id = hexToU64(cell);
    const resolution = getResolution(id);
    const [lng, lat] = cellToLonLat(id);
    const rows: Array<[string, string]> = [
      [labels.resolution, String(resolution)],
      [labels.center, formatCenter(lat, lng)],
    ];
    if (resolution > 0) {
      const [parent] = parentCells(cell);
      if (parent) rows.push([labels.parent, parent]);
    }
    if (resolution < MAX_RESOLUTION) {
      rows.push([labels.children, String(cellToChildren(id).length)]);
    }
    return rows;
  },
  idProperty: "a5",
  csvColumns: ["a5", "resolution", "center_lat", "center_lng"],
  layerName: (resolution) => `A5 grid (resolution ${resolution})`,
  exportBaseName: (resolution) => `a5-grid-r${resolution}`,
});

export const maplibreA5Plugin = grid.plugin;
export const setA5Labels = grid.setLabels;
export const getA5GridSettings = grid.getSettings;
export const setA5GridSettings = grid.setSettings;
export const normalizeA5GridSettings = grid.normalizeSettings;
