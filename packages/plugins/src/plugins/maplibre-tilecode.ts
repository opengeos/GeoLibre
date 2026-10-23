import type { Feature, FeatureCollection, Polygon } from "geojson";
import {
  createGridPlugin,
  formatCenter,
  type GridLabelsBase,
  type GridSettingsBase,
} from "./grid-plugin-factory";

export const TILECODE_PLUGIN_ID = "maplibre-tilecode";

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

export interface TilecodeGridSettings extends GridSettingsBase {
  /** Tile zoom level ("resolution"): 0–26. */
  resolution: number;
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

export interface TilecodeLabels extends GridLabelsBase {
  quadkey: string;
  includeParent: string;
}

export const DEFAULT_TILECODE_LABELS: TilecodeLabels = {
  title: "Tilecode",
  controlTitle: "Tilecode settings",
  autoResolution: "Automatic resolution",
  resolution: "Resolution",
  cellCount: (count) => `${count.toLocaleString()} tiles in view`,
  tooManyCells: (limit) =>
    `This view exceeds the ${limit.toLocaleString()} tile limit. Zoom in or lower the resolution.`,
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
 * The automatic zoom→tile-zoom rule, mirroring vgrid-maplibre's TilecodeGrid
 * (https://www.npmjs.com/package/vgrid-maplibre): tiles one zoom level finer
 * than the map, clamped to the supported range.
 */
export function tilecodeResolutionForZoom(zoom: number): number {
  return Math.min(MAX_TILECODE_ZOOM, Math.max(MIN_TILECODE_ZOOM, Math.floor(zoom) + 1));
}

/**
 * Avoid thousands of overlapping IDs when the grid is viewed globally. In
 * automatic mode tiles are one zoom finer than the map, so labels are always
 * on; the floor only matters for a fixed fine resolution at a wide view.
 */
export function tilecodeLabelMinZoom(resolution: number): number {
  return Math.min(24, Math.max(2, Math.round(resolution) - 1));
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
 * The tile plus its (up to 4) edge neighbors (N/S/E/W). Diagonals are omitted.
 * x wraps around the world; y is clipped at the mercator top and bottom rows.
 */
export function tilecodeNeighborCells(cell: string): string[] {
  const tile = tilecodeToTile(cell);
  if (!tile) return [cell];
  const [x, y, z] = tile;
  const size = 2 ** z;
  const ids = new Set<string>([cell]);
  for (const [dx, dy] of [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ] as const) {
    const ny = y + dy;
    if (ny < 0 || ny >= size) continue;
    const nx = (((x + dx) % size) + size) % size;
    ids.add(tileToTilecode([nx, ny, z]));
  }
  return [...ids];
}

const grid = createGridPlugin<TilecodeGridSettings, TilecodeLabels>({
  id: TILECODE_PLUGIN_ID,
  name: "Tilecode",
  slug: "tilecode",
  parentKey: "includeParent",
  defaultSettings: DEFAULT_TILECODE_GRID_SETTINGS,
  defaultLabels: DEFAULT_TILECODE_LABELS,
  resolutionControl: { kind: "range", min: MIN_TILECODE_ZOOM, max: MAX_TILECODE_ZOOM },
  viewportCellLimit: TILECODE_VIEWPORT_CELL_LIMIT,
  resolutionForZoom: tilecodeResolutionForZoom,
  labelMinZoom: tilecodeLabelMinZoom,
  gridForBounds: (bounds, zoom) => tilecodeGridForBounds(bounds, zoom),
  cellFeature: (cell) => tilecodeCellFeature(cell),
  cellAtLngLat: (lng, lat, zoom) => tileToTilecode(pointToTile(lat, lng, zoom)),
  reindexCell: (cell, zoom) => {
    const tile = tilecodeToTile(cell);
    if (!tile) return cell;
    const [west, south, east, north] = tileBounds(tile);
    return tileToTilecode(pointToTile((south + north) / 2, (west + east) / 2, zoom));
  },
  neighborCells: (cell) => tilecodeNeighborCells(cell).filter((neighbor) => neighbor !== cell),
  parentCells: (cell) => {
    const parent = tilecodeParentCell(cell);
    return parent ? [parent] : [];
  },
  cellBounds: (cell) => {
    const tile = tilecodeToTile(cell);
    return tile ? tileBounds(tile) : null;
  },
  cellDetails: (cell, labels) => {
    const tile = tilecodeToTile(cell);
    if (!tile) return null;
    const [west, south, east, north] = tileBounds(tile);
    const rows: Array<[string, string]> = [
      [labels.quadkey, tileToQuadkey(tile) || "—"],
      [labels.resolution, String(tile[2])],
      [labels.center, formatCenter((south + north) / 2, (west + east) / 2)],
    ];
    const parent = tilecodeParentCell(cell);
    if (parent) rows.push([labels.parent, parent]);
    if (tile[2] < MAX_TILECODE_ZOOM) {
      rows.push([labels.children, String(TILECODE_CHILDREN_PER_CELL)]);
    }
    return rows;
  },
  idProperty: "tilecode",
  csvColumns: ["tilecode", "quadkey", "resolution", "center_lat", "center_lng"],
  layerName: (zoom) => `Tilecode (res ${zoom})`,
  exportBaseName: (zoom) => `tilecode-z${zoom}`,
});

export const maplibreTilecodePlugin = grid.plugin;
export const setTilecodeLabels = grid.setLabels;
export const getTilecodeGridSettings = grid.getSettings;
export const setTilecodeGridSettings = grid.setSettings;
export const normalizeTilecodeGridSettings = grid.normalizeSettings;
