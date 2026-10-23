import type { Feature, FeatureCollection, Polygon } from "geojson";
import OpenLocationCodeModule from "open-location-code-typescript";
import {
  createGridPlugin,
  formatCenter,
  snapToOption,
  type GridLabelsBase,
  type GridSettingsBase,
} from "./grid-plugin-factory";

// The library ships CommonJS with an `exports.default` class. Depending on
// who loads it (Vite, tsx's CJS transform, Node's native ESM interop) the
// default import is either the class or the exports object wrapping it.
const OpenLocationCode = ((OpenLocationCodeModule as { default?: unknown }).default ??
  OpenLocationCodeModule) as typeof OpenLocationCodeModule;

export const OLC_PLUGIN_ID = "maplibre-olc";

/** Prevent a fine code length over a large viewport from freezing the browser. */
export const OLC_VIEWPORT_CELL_LIMIT = 20_000;

/**
 * The code lengths a full Open Location Code can have: digit pairs up to 10,
 * then single grid-refinement digits (where cells stop being square).
 */
export const OLC_CODE_LENGTHS = [2, 4, 6, 8, 10, 11, 12, 13, 14, 15] as const;

export type OlcCodeLength = (typeof OLC_CODE_LENGTHS)[number];

export const MAX_OLC_CODE_LENGTH: OlcCodeLength = 15;

export interface OlcGridSettings extends GridSettingsBase {
  /** Full code length ("resolution"): one of OLC_CODE_LENGTHS. */
  resolution: OlcCodeLength;
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

export interface OlcLabels extends GridLabelsBase {
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

/** Snap an arbitrary number to the nearest valid full-code length. */
function toCodeLength(value: unknown, fallback: OlcCodeLength): OlcCodeLength {
  return snapToOption(value, OLC_CODE_LENGTHS, fallback);
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
 * The cell plus its (up to 4) edge neighbors, encoded from offset centroids.
 * Diagonals are omitted — only north/south/east/west. Cells in the top and
 * bottom rows have no neighbors past the poles; the longitude wraps via
 * encode's normalization.
 */
export function olcNeighborCells(cell: string): string[] {
  const area = OpenLocationCode.decode(cell);
  const latHeight = area.getLatitudeHeight();
  const lngWidth = area.getLongitudeWidth();
  const ids = new Set<string>([cell]);
  for (const [dLat, dLng] of [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ] as const) {
    const lat = area.latitudeCenter + dLat * latHeight;
    if (lat < -90 || lat > 90) continue;
    ids.add(OpenLocationCode.encode(lat, area.longitudeCenter + dLng * lngWidth, area.codeLength));
  }
  return [...ids];
}

const grid = createGridPlugin<OlcGridSettings, OlcLabels>({
  id: OLC_PLUGIN_ID,
  name: "OLC",
  slug: "olc",
  parentKey: "includeParent",
  defaultSettings: DEFAULT_OLC_GRID_SETTINGS,
  defaultLabels: DEFAULT_OLC_LABELS,
  // Valid code lengths are not contiguous (…8, 10, 11…), so the panel shows a
  // dropdown instead of the range slider the other DGGS panels use.
  resolutionControl: { kind: "select", options: OLC_CODE_LENGTHS },
  viewportCellLimit: OLC_VIEWPORT_CELL_LIMIT,
  resolutionForZoom: olcResolutionForZoom,
  labelMinZoom: olcLabelMinZoom,
  gridForBounds: (bounds, codeLength) => olcGridForBounds(bounds, codeLength as OlcCodeLength),
  cellFeature: (cell) => olcCellFeature(cell),
  cellAtLngLat: (lng, lat, codeLength) => OpenLocationCode.encode(lat, lng, codeLength),
  reindexCell: (cell, codeLength) => {
    const area = OpenLocationCode.decode(cell);
    return OpenLocationCode.encode(area.latitudeCenter, area.longitudeCenter, codeLength);
  },
  neighborCells: (cell) => olcNeighborCells(cell).filter((neighbor) => neighbor !== cell),
  parentCells: (cell) => {
    const parent = olcParentCell(cell);
    return parent ? [parent] : [];
  },
  cellBounds: (cell) => {
    const area = OpenLocationCode.decode(cell);
    return [area.longitudeLo, area.latitudeLo, area.longitudeHi, area.latitudeHi];
  },
  cellDetails: (cell, labels) => {
    const area = OpenLocationCode.decode(cell);
    const rows: Array<[string, string]> = [
      [labels.resolution, String(area.codeLength)],
      [labels.center, formatCenter(area.latitudeCenter, area.longitudeCenter)],
    ];
    const parent = olcParentCell(cell);
    if (parent) rows.push([labels.parent, parent]);
    const children = olcChildCount(cell);
    if (children > 0) rows.push([labels.children, String(children)]);
    return rows;
  },
  idProperty: "olc",
  csvColumns: ["olc", "resolution", "center_lat", "center_lng"],
  layerName: (codeLength) => `OLC (res ${codeLength})`,
  exportBaseName: (codeLength) => `olc-l${codeLength}`,
});

export const maplibreOlcPlugin = grid.plugin;
export const setOlcLabels = grid.setLabels;
export const getOlcGridSettings = grid.getSettings;
export const setOlcGridSettings = grid.setSettings;
export const normalizeOlcGridSettings = grid.normalizeSettings;
