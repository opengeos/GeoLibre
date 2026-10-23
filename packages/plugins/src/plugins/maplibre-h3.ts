import type { Feature, FeatureCollection, Polygon } from "geojson";
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
import {
  createGridPlugin,
  formatCenter,
  ringBounds,
  type GridLabelsBase,
  type GridSettingsBase,
} from "./grid-plugin-factory";

/**
 * The icosahedron H3 projects onto, as densified great-circle edge lines.
 * Fetched by MapLibre when the layer is first added; the Tauri CSP's blanket
 * `https:` connect-src already allows the host. Offline, the overlay simply
 * stays empty.
 */
const ICOSAHEDRON_GEOJSON_URL =
  "https://raw.githubusercontent.com/opengeoshub/vgrid-maplibre/main/H3/icosahedron.geojson";

export const H3_PLUGIN_ID = "maplibre-h3-grid";

const ICOSAHEDRON_SOURCE_ID = "geolibre-h3-icosahedron-source";
const ICOSAHEDRON_LINE_LAYER_ID = "geolibre-h3-icosahedron-line";

/** Prevent a fine resolution over a large viewport from freezing the browser. */
export const H3_VIEWPORT_CELL_LIMIT = 20_000;

export interface H3GridSettings extends GridSettingsBase {
  includeParents: boolean;
  showIcosahedron: boolean;
}

export const DEFAULT_H3_GRID_SETTINGS: H3GridSettings = {
  autoResolution: true,
  // Useful immediately at GeoLibre's default world view (resolution 3 would
  // already exceed the viewport safety cap).
  resolution: 2,
  fillColor: "#2563eb",
  fillOpacity: 0.08,
  lineColor: "#2563eb",
  lineWidth: 1,
  showLabels: true,
  includeNeighbors: false,
  includeParents: false,
  showIcosahedron: false,
};

export interface H3Labels extends GridLabelsBase {
  copied: string;
  baseCell: string;
  pentagon: string;
  yes: string;
  no: string;
  includeParents: string;
  showIcosahedron: string;
}

export const DEFAULT_H3_LABELS: H3Labels = {
  title: "H3 Grid",
  controlTitle: "H3 grid settings",
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
  includeParents: "Include selected cell parent",
  showIcosahedron: "Show icosahedron",
};

/**
 * The automatic zoom→resolution rule, adapted from vgrid-maplibre's H3Grid
 * getResolution (https://www.npmjs.com/package/vgrid-maplibre): H3 cell area
 * shrinks ~7x per resolution step versus 4x per zoom level, so resolution
 * advances at a fraction of a step per zoom level (0.9 here, tuned up from
 * vgrid's 0.8 for a denser grid), offset so the world view starts at 0,
 * clamped to the valid range.
 */
export function h3ResolutionForZoom(zoom: number): number {
  return Math.min(15, Math.max(0, Math.floor((zoom - 3) * 0.9)));
}

/** Avoid thousands of overlapping IDs when the grid is viewed globally. */
export function h3LabelMinZoom(resolution: number): number {
  return Math.min(18, Math.max(3, Math.round(resolution) + 3));
}

/**
 * Keep a cell boundary contiguous across the antimeridian, mirroring
 * vgrid-maplibre's H3Grid (https://www.npmjs.com/package/vgrid-maplibre):
 * when a ring carries a vertex west of -130°, every positive longitude is
 * shifted down by 360°. A cell straddling the seam mixes ~+179 and ~-179
 * values, so the shift makes the ring contiguous around -180; MapLibre
 * renders longitudes past -180 in the adjacent world copy. Rings entirely
 * away from the seam never match the -130 test and pass through unchanged.
 */
export function h3FixTransmeridianBoundary(ring: [number, number][]): [number, number][] {
  if (!ring.some(([longitude]) => longitude < -130)) return ring;
  return ring.map(([longitude, latitude]) =>
    longitude > 0 ? [longitude - 360, latitude] : [longitude, latitude],
  );
}

/** Convert an H3 cell to a GeoJSON polygon with useful export attributes. */
export function h3CellFeature(cell: string): Feature<Polygon> {
  const [lat, lng] = cellToLatLng(cell);
  const boundary = h3FixTransmeridianBoundary(cellToBoundary(cell, true) as [number, number][]);
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
    geometry: { type: "Polygon", coordinates: [boundary] },
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
): FeatureCollection<Polygon> {
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

function neighborCells(cell: string): string[] {
  return gridDisk(cell, 1).filter((neighbor) => neighbor !== cell);
}

/**
 * The canonical parent at resolution r-1, or none for a resolution-0 cell.
 * Uses h3-js `cellToParent` — one unique parent per cell.
 */
function parentCells(cell: string): string[] {
  const resolution = getResolution(cell);
  return resolution > 0 ? [cellToParent(cell, resolution - 1)] : [];
}

/** A cell's ring, kept contiguous across the antimeridian. */
function cellRing(cell: string): [number, number][] {
  return h3FixTransmeridianBoundary(cellToBoundary(cell, true) as [number, number][]);
}

const grid = createGridPlugin<H3GridSettings, H3Labels>({
  id: H3_PLUGIN_ID,
  name: "H3 Grid",
  slug: "h3",
  parentKey: "includeParents",
  extraBooleanKeys: ["showIcosahedron"],
  extraToggles: [{ key: "showIcosahedron", label: (labels) => labels.showIcosahedron }],
  defaultSettings: DEFAULT_H3_GRID_SETTINGS,
  defaultLabels: DEFAULT_H3_LABELS,
  resolutionControl: { kind: "range", min: 0, max: 15 },
  viewportCellLimit: H3_VIEWPORT_CELL_LIMIT,
  resolutionForZoom: h3ResolutionForZoom,
  labelMinZoom: h3LabelMinZoom,
  gridForBounds: (bounds, resolution) => h3GridForBounds(bounds, resolution),
  cellFeature: h3CellFeature,
  cellAtLngLat: (lng, lat, resolution) => latLngToCell(lat, lng, resolution),
  reindexCell: (cell, resolution) => {
    const [lat, lng] = cellToLatLng(cell);
    return latLngToCell(lat, lng, resolution);
  },
  neighborCells,
  parentCells,
  cellBounds: (cell) => ringBounds(cellRing(cell)),
  cellDetails: (cell, labels) => {
    const [lat, lng] = cellToLatLng(cell);
    const resolution = getResolution(cell);
    const rows: Array<[string, string]> = [
      [labels.resolution, String(resolution)],
      [labels.baseCell, String(getBaseCellNumber(cell))],
      [labels.center, formatCenter(lat, lng)],
      [labels.pentagon, isPentagon(cell) ? labels.yes : labels.no],
    ];
    if (resolution > 0) {
      const [parent] = parentCells(cell);
      if (parent) rows.push([labels.parent, parent]);
    }
    if (resolution < 15) {
      rows.push([labels.children, String(cellToChildren(cell, resolution + 1).length)]);
    }
    return rows;
  },
  idProperty: "h3",
  csvColumns: ["h3", "resolution", "base_cell", "center_lat", "center_lng", "is_pentagon"],
  layerName: (resolution) => `H3 grid (resolution ${resolution})`,
  exportBaseName: (resolution) => `h3-grid-r${resolution}`,
  overlay: {
    layerIds: [ICOSAHEDRON_LINE_LAYER_ID],
    sourceIds: [ICOSAHEDRON_SOURCE_ID],
    ensure: (map, settings) => {
      if (map.getSource(ICOSAHEDRON_SOURCE_ID)) return;
      map.addSource(ICOSAHEDRON_SOURCE_ID, {
        type: "geojson",
        data: ICOSAHEDRON_GEOJSON_URL,
      });
      map.addLayer({
        id: ICOSAHEDRON_LINE_LAYER_ID,
        type: "line",
        source: ICOSAHEDRON_SOURCE_ID,
        layout: { visibility: settings.showIcosahedron ? "visible" : "none" },
        paint: {
          "line-color": "#dc2626",
          "line-width": 1.5,
          "line-dasharray": [2, 2],
        },
      });
    },
    apply: (map, settings) =>
      map.setLayoutProperty(
        ICOSAHEDRON_LINE_LAYER_ID,
        "visibility",
        settings.showIcosahedron ? "visible" : "none",
      ),
  },
});

export const maplibreH3Plugin = grid.plugin;
export const setH3Labels = grid.setLabels;
export const getH3GridSettings = grid.getSettings;
export const setH3GridSettings = grid.setSettings;
export const normalizeH3GridSettings = grid.normalizeSettings;
