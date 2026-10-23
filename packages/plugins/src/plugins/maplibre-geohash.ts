import type { Feature, FeatureCollection, Polygon } from "geojson";
import geohash from "ngeohash";
import {
  createGridPlugin,
  formatCenter,
  type GridLabelsBase,
  type GridSettingsBase,
} from "./grid-plugin-factory";

export const GEOHASH_PLUGIN_ID = "maplibre-geohash";

/** Prevent a fine precision over a large viewport from freezing the browser. */
export const GEOHASH_VIEWPORT_CELL_LIMIT = 20_000;

/** Geohash character precision: each step adds 5 bits of lat/lon. */
export const MIN_GEOHASH_PRECISION = 1;
export const MAX_GEOHASH_PRECISION = 12;

/** Every geohash cell subdivides into 32 children (base32 alphabet). */
export const GEOHASH_CHILDREN_PER_CELL = 32;

export interface GeohashGridSettings extends GridSettingsBase {
  /** Character precision ("resolution"): 1–12. */
  resolution: number;
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

export interface GeohashLabels extends GridLabelsBase {
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

/**
 * Avoid thousands of overlapping IDs when the grid is viewed globally.
 * Precision grows roughly every 2¼ zoom levels (`1 / 0.45`), so labels appear
 * about one step below the zoom that would pick the next finer precision.
 */
export function geohashLabelMinZoom(precision: number): number {
  return Math.min(22, Math.max(2, Math.round(precision / 0.45) - 1));
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
 * The cell plus its (up to 4) edge neighbors via `ngeohash.neighbor`
 * ([1,0]/[-1,0]/[0,1]/[0,-1] = N/S/E/W). Diagonals from `neighbors` are omitted.
 */
export function geohashNeighborCells(cell: string): string[] {
  return [
    ...new Set([
      cell,
      geohash.neighbor(cell, [1, 0]),
      geohash.neighbor(cell, [-1, 0]),
      geohash.neighbor(cell, [0, 1]),
      geohash.neighbor(cell, [0, -1]),
    ]),
  ];
}

const grid = createGridPlugin<GeohashGridSettings, GeohashLabels>({
  id: GEOHASH_PLUGIN_ID,
  name: "Geohash",
  slug: "geohash",
  parentKey: "includeParent",
  defaultSettings: DEFAULT_GEOHASH_GRID_SETTINGS,
  defaultLabels: DEFAULT_GEOHASH_LABELS,
  resolutionControl: { kind: "range", min: MIN_GEOHASH_PRECISION, max: MAX_GEOHASH_PRECISION },
  viewportCellLimit: GEOHASH_VIEWPORT_CELL_LIMIT,
  resolutionForZoom: geohashResolutionForZoom,
  labelMinZoom: geohashLabelMinZoom,
  gridForBounds: (bounds, precision) => geohashGridForBounds(bounds, precision),
  cellFeature: (cell) => geohashCellFeature(cell),
  cellAtLngLat: (lng, lat, precision) => geohash.encode(lat, wrapLongitude(lng), precision),
  reindexCell: (cell, precision) => {
    const { latitude, longitude } = geohash.decode(cell);
    return geohash.encode(latitude, longitude, precision);
  },
  neighborCells: (cell) => geohashNeighborCells(cell).filter((neighbor) => neighbor !== cell),
  parentCells: (cell) => {
    const parent = geohashParentCell(cell);
    return parent ? [parent] : [];
  },
  cellBounds: (cell) => {
    const [south, west, north, east] = geohash.decode_bbox(cell);
    return [west, south, east, north];
  },
  cellDetails: (cell, labels) => {
    const { latitude, longitude } = geohash.decode(cell);
    const rows: Array<[string, string]> = [
      [labels.resolution, String(cell.length)],
      [labels.center, formatCenter(latitude, longitude)],
    ];
    const parent = geohashParentCell(cell);
    if (parent) rows.push([labels.parent, parent]);
    if (cell.length < MAX_GEOHASH_PRECISION) {
      rows.push([labels.children, String(GEOHASH_CHILDREN_PER_CELL)]);
    }
    return rows;
  },
  idProperty: "geohash",
  csvColumns: ["geohash", "resolution", "center_lat", "center_lng"],
  layerName: (precision) => `Geohash (res ${precision})`,
  exportBaseName: (precision) => `geohash-p${precision}`,
});

export const maplibreGeohashPlugin = grid.plugin;
export const setGeohashLabels = grid.setLabels;
export const getGeohashGridSettings = grid.getSettings;
export const setGeohashGridSettings = grid.setSettings;
export const normalizeGeohashGridSettings = grid.normalizeSettings;
