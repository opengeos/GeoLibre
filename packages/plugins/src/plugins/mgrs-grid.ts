/**
 * MGRS / USNG grid overlay geometry for the Gridlines plugin (issue #2869).
 *
 * Draws, for the current viewport only:
 *
 * - the grid zone boundaries (6° UTM zones split into 8° latitude bands, with
 *   the Norway 32V and Svalbard 31X/33X/35X/37X exceptions) and their
 *   designations (`18S`, `32V`);
 * - the 100 km square boundaries with their two-letter identifiers (`UJ`);
 * - finer 10 km and then 1 km lines as the map zooms in, labelled along the
 *   viewport edges with their kilometre value inside the 100 km square (the
 *   "principal digits" printed in a map margin).
 *
 * The finest level drawn is picked from the ground resolution so lines stay at
 * least {@link MIN_LINE_SPACING_PX} apart, which also bounds the feature count:
 * the work done is proportional to what fits on screen, not to the zoom.
 *
 * Grid lines are generated in each zone's own UTM projection and
 * inverse-projected to lng/lat, then clipped to that zone's lng/lat rectangle,
 * so a 100 km square cut by a zone or band edge stops exactly on it, as it does
 * on a printed MGRS map. Square letters come from {@link mgrsSquareId} and zones
 * from {@link gridZoneLongitudeRange}, the same rules the MGRS readout uses.
 *
 * Pure and map-free: the plugin passes in the viewport bounds and the ground
 * resolution, so the geometry is unit-testable without a WebGL map.
 */

import type { Feature, FeatureCollection, LineString, Point } from "geojson";
import proj4, { type Converter } from "proj4";
import { gridZoneLongitudeRange, mgrsSquareId, utmBandRange } from "./mgrs-reference";

/** Which tier of the MGRS grid a line belongs to (drives its width). */
export type MgrsLineLevel = "zone" | "square" | "10km" | "1km";

/** A viewport in degrees. `east` may exceed 180 for an antimeridian view. */
export interface MgrsGridBounds {
  west: number;
  east: number;
  south: number;
  north: number;
}

/** Inputs to {@link buildMgrsGrid} beyond the bounds. */
export interface MgrsGridOptions {
  /** MapLibre zoom level; with the view's centre latitude it sets the density. */
  zoom: number;
  /** Emit label points (zone designations, square IDs, edge kilometres). */
  showLabels: boolean;
  /** Label the left + bottom edges only, or all four. */
  labelEdges: "left-bottom" | "all";
  /** Hard cap on line features, so no viewport can stall the UI. */
  maxLines?: number;
}

/** The grid lines and labels for one viewport. */
export interface MgrsGridGeometry {
  lines: FeatureCollection<LineString>;
  labels: FeatureCollection<Point>;
  /** Finest line spacing drawn, in metres; 0 when only zones are drawn. */
  step: number;
}

/** One grid zone designation (zone + band) as a lng/lat rectangle. */
export interface GridZoneCell {
  zone: number;
  band: string;
  /** Western edge in degrees, within -180..180 (before {@link offset}). */
  west: number;
  east: number;
  south: number;
  north: number;
  /** World-copy shift (a multiple of 360°) that places the cell in the view. */
  offset: number;
}

/** Latitude-band letters, south to north. */
const BANDS = "CDEFGHJKLMNPQRSTUVWX";

/** Line spacings the grid can draw, coarse to fine, in metres. */
export const MGRS_GRID_STEPS = [100_000, 10_000, 1_000] as const;

/** Minimum on-screen gap between neighbouring lines of the finest tier drawn. */
export const MIN_LINE_SPACING_PX = 24;

/** Metres per pixel at zoom 0 on the equator for MapLibre's 512 px tiles. */
const EQUATOR_METERS_PER_PIXEL_Z0 = 78271.517;

/** World width in pixels at zoom 0 (MapLibre's 512 px tiles). */
const WORLD_PX_Z0 = 512;

/** Default hard cap on line features. */
const DEFAULT_MAX_LINES = 3000;

/** Points per inverse-projected grid line before clipping. */
const LINE_SEGMENTS = 16;

/** Boundary samples per edge when measuring a rectangle's UTM extent. */
const EXTENT_SAMPLES = 8;

/** Minimum on-screen size of a clipped 100 km square before it gets a label. */
const MIN_SQUARE_LABEL_PX = { width: 28, height: 16 };

/**
 * Minimum on-screen size of a grid zone before it gets a label. Wider than a
 * square's, because a zone-only view is a continental or whole-world one, where
 * a globe projection squeezes the zones near its rim well below their Mercator
 * size, and a three-character designation in every 34 px zone (zoom 2) turns
 * into an unreadable carpet.
 */
const MIN_ZONE_LABEL_PX = { width: 48, height: 24 };

/** Metres per degree of latitude (and of longitude on the equator). */
const METERS_PER_DEGREE = 111_320;

const EPSILON = 1e-9;

/**
 * Ground resolution of a Web Mercator map.
 *
 * Args:
 *   zoom: MapLibre zoom level.
 *   lat: Latitude of the point of interest (usually the view centre).
 *
 * Returns:
 *   Metres per screen pixel.
 */
export function metersPerPixelAt(zoom: number, lat: number): number {
  return (EQUATOR_METERS_PER_PIXEL_Z0 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

/**
 * The finest grid tier that keeps its lines at least
 * {@link MIN_LINE_SPACING_PX} apart on screen.
 *
 * Args:
 *   metersPerPixel: Ground resolution, in metres per pixel.
 *
 * Returns:
 *   100000, 10000 or 1000 metres, or 0 when even 100 km squares would be too
 *   dense and only the grid zones should be drawn.
 */
export function mgrsGridStep(metersPerPixel: number): number {
  if (!Number.isFinite(metersPerPixel) || metersPerPixel <= 0) return 0;
  let finest = 0;
  for (const step of MGRS_GRID_STEPS) {
    if (step / metersPerPixel >= MIN_LINE_SPACING_PX) finest = step;
  }
  return finest;
}

/** Line tier for a spacing in metres. */
function levelForStep(step: number): MgrsLineLevel {
  if (step >= 100_000) return "square";
  if (step >= 10_000) return "10km";
  return "1km";
}

/**
 * List the grid zone designations that overlap a viewport.
 *
 * Args:
 *   bounds: The viewport; `east` may exceed 180 for an antimeridian view.
 *
 * Returns:
 *   One cell per (zone, band, world copy) overlapping the view, with the
 *   Norway/Svalbard widened zones in place of the regular ones.
 */
export function gridZoneCells(bounds: MgrsGridBounds): GridZoneCell[] {
  const south = Math.max(bounds.south, -80);
  const north = Math.min(bounds.north, 84);
  const cells: GridZoneCell[] = [];
  if (!(north > south) || !(bounds.east > bounds.west)) return cells;
  const firstCopy = Math.floor((bounds.west + 180) / 360);
  const lastCopy = Math.floor((bounds.east + 180) / 360);
  for (const band of BANDS) {
    const range = utmBandRange(band);
    if (!range || range[1] <= south || range[0] >= north) continue;
    for (let copy = firstCopy; copy <= lastCopy; copy += 1) {
      const offset = copy * 360;
      for (let zone = 1; zone <= 60; zone += 1) {
        const lons = gridZoneLongitudeRange(zone, band);
        if (!lons) continue;
        if (lons[1] + offset <= bounds.west || lons[0] + offset >= bounds.east) continue;
        cells.push({
          zone,
          band,
          west: lons[0],
          east: lons[1],
          south: range[0],
          north: range[1],
          offset,
        });
      }
    }
  }
  return cells;
}

type Position = [number, number];

interface Rect {
  west: number;
  east: number;
  south: number;
  north: number;
}

/** Clip one segment to a rectangle (Liang–Barsky), or null when it misses. */
function clipSegment(a: Position, b: Position, rect: Rect): [Position, Position] | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  const edges: Array<[number, number]> = [
    [-dx, a[0] - rect.west],
    [dx, rect.east - a[0]],
    [-dy, a[1] - rect.south],
    [dy, rect.north - a[1]],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  if (t1 - t0 < EPSILON) return null;
  return [
    [a[0] + t0 * dx, a[1] + t0 * dy],
    [a[0] + t1 * dx, a[1] + t1 * dy],
  ];
}

/**
 * Clip a polyline to a rectangle, splitting it where it leaves and re-enters.
 *
 * Args:
 *   coords: The polyline.
 *   rect: The clipping rectangle, in the same units.
 *
 * Returns:
 *   The pieces inside the rectangle, each with at least two points.
 */
export function clipPolyline(coords: Position[], rect: Rect): Position[][] {
  const pieces: Position[][] = [];
  let current: Position[] | null = null;
  for (let i = 0; i + 1 < coords.length; i += 1) {
    const segment = clipSegment(coords[i], coords[i + 1], rect);
    if (!segment) {
      if (current) pieces.push(current);
      current = null;
      continue;
    }
    const last = current?.[current.length - 1];
    if (
      current &&
      last &&
      Math.abs(last[0] - segment[0][0]) < EPSILON &&
      Math.abs(last[1] - segment[0][1]) < EPSILON
    ) {
      current.push(segment[1]);
    } else {
      if (current) pieces.push(current);
      current = [segment[0], segment[1]];
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

/** proj4 converter pair for one zone and hemisphere. */
interface ZoneProjection {
  toUtm: Converter;
  toLngLat: Converter;
}

function zoneProjection(zone: number, south: boolean): ZoneProjection | null {
  const def = `+proj=utm +zone=${zone}${south ? " +south" : ""} +datum=WGS84 +units=m +no_defs +type=crs`;
  try {
    return { toUtm: proj4("EPSG:4326", def), toLngLat: proj4(def, "EPSG:4326") };
  } catch {
    return null;
  }
}

/** Easting/northing bounding box of a lng/lat rectangle, sampled along its edges. */
function utmExtent(
  toUtm: Converter,
  rect: Rect,
): { eMin: number; eMax: number; nMin: number; nMax: number } | null {
  let eMin = Infinity;
  let eMax = -Infinity;
  let nMin = Infinity;
  let nMax = -Infinity;
  for (let i = 0; i <= EXTENT_SAMPLES; i += 1) {
    const f = i / EXTENT_SAMPLES;
    const lon = rect.west + (rect.east - rect.west) * f;
    const lat = rect.south + (rect.north - rect.south) * f;
    const samples: Position[] = [
      [lon, rect.south],
      [lon, rect.north],
      [rect.west, lat],
      [rect.east, lat],
    ];
    for (const sample of samples) {
      try {
        const [e, n] = toUtm.forward(sample);
        if (!Number.isFinite(e) || !Number.isFinite(n)) continue;
        eMin = Math.min(eMin, e);
        eMax = Math.max(eMax, e);
        nMin = Math.min(nMin, n);
        nMax = Math.max(nMax, n);
      } catch {
        // Skip samples proj4 cannot project.
      }
    }
  }
  if (!Number.isFinite(eMin)) return null;
  // The edges bow between samples, so pad the box slightly; the lines are
  // clipped to the rectangle afterwards, so overshoot costs nothing.
  const padE = (eMax - eMin) * 0.02 + 1;
  const padN = (nMax - nMin) * 0.02 + 1;
  return { eMin: eMin - padE, eMax: eMax + padE, nMin: nMin - padN, nMax: nMax + padN };
}

/** Kilometres within the 100 km square, as the two "principal digits" (`23`). */
export function principalDigits(meters: number): string {
  const km = Math.round((((meters % 100_000) + 100_000) % 100_000) / 1000);
  return String(km % 100).padStart(2, "0");
}

function lineFeature(coords: Position[], level: MgrsLineLevel): Feature<LineString> {
  return {
    type: "Feature",
    properties: { level },
    geometry: { type: "LineString", coordinates: coords },
  };
}

function labelFeature(
  lon: number,
  lat: number,
  label: string,
  anchor: "top" | "bottom" | "left" | "right" | "center",
  kind: "zone" | "square" | "edge",
): Feature<Point> {
  return {
    type: "Feature",
    // `scale` multiplies the configured label size, so the square IDs and
    // zone designations read as headings over the edge kilometres.
    properties: { label, anchor, kind, scale: kind === "edge" ? 1 : 1.3 },
    geometry: { type: "Point", coordinates: [lon, lat] },
  };
}

/** Web Mercator y of a latitude, in degree-equivalents (equal to x at the equator). */
function mercatorY(lat: number): number {
  const phi = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  return (Math.log(Math.tan(Math.PI / 4 + phi / 2)) * 180) / Math.PI;
}

/**
 * Whether a lng/lat rectangle is big enough on screen to hold a short label.
 *
 * Args:
 *   rect: The rectangle in degrees.
 *   pxPerDegree: Screen pixels per degree of longitude (constant across a Web
 *     Mercator view).
 *   min: Minimum width and height, in pixels.
 */
function fitsLabel(
  rect: Rect,
  pxPerDegree: number,
  min: { width: number; height: number },
): boolean {
  const widthPx = (rect.east - rect.west) * pxPerDegree;
  const heightPx = (mercatorY(rect.north) - mercatorY(rect.south)) * pxPerDegree;
  return widthPx >= min.width && heightPx >= min.height;
}

/**
 * Build the MGRS grid lines and labels for a viewport.
 *
 * Args:
 *   bounds: The viewport in degrees (`east` may exceed 180 across the
 *     antimeridian). Latitudes are clamped to the UTM range, 80°S–84°N.
 *   options: Ground resolution and label settings.
 *
 * Returns:
 *   Line features tagged with their `level` and label points tagged with an
 *   `anchor`, a `kind` and a size `scale`.
 */
export function buildMgrsGrid(bounds: MgrsGridBounds, options: MgrsGridOptions): MgrsGridGeometry {
  const lineFeatures: Feature<LineString>[] = [];
  const labelFeatures: Feature<Point>[] = [];
  const view: Rect = {
    west: bounds.west,
    east: bounds.east,
    south: Math.max(bounds.south, -80),
    north: Math.min(bounds.north, 84),
  };
  // Density follows the ground resolution at the view centre, so a view
  // over Norway reaches 1 km lines about a zoom level earlier than one over
  // the equator, where the same zoom covers twice the ground.
  const centerLat = Math.max(-85, Math.min(85, (bounds.south + bounds.north) / 2));
  const metersPerPixel = metersPerPixelAt(options.zoom, centerLat);
  const pxPerDegree = (WORLD_PX_Z0 * 2 ** options.zoom) / 360;
  const step = mgrsGridStep(metersPerPixel);
  const result = (): MgrsGridGeometry => ({
    lines: { type: "FeatureCollection", features: lineFeatures },
    labels: { type: "FeatureCollection", features: labelFeatures },
    step,
  });
  if (!(view.north > view.south) || !(view.east > view.west)) return result();

  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const showAllEdges = options.labelEdges === "all";
  const cells = gridZoneCells(bounds);

  // Grid zone boundaries. Each cell draws its west and south edges where they
  // fall inside the view; neighbours share edges, so every visible boundary is
  // drawn once. Meridians and parallels are straight in Web Mercator.
  for (const cell of cells) {
    if (lineFeatures.length >= maxLines) break;
    const west = cell.west + cell.offset;
    const east = cell.east + cell.offset;
    const south = Math.max(cell.south, view.south);
    const north = Math.min(cell.north, view.north);
    if (west > view.west && west < view.east && north > south) {
      lineFeatures.push(
        lineFeature(
          [
            [west, south],
            [west, north],
          ],
          "zone",
        ),
      );
    }
    const clipWest = Math.max(west, view.west);
    const clipEast = Math.min(east, view.east);
    if (clipEast <= clipWest) continue;
    for (const edge of cell.band === "X" ? [cell.south, cell.north] : [cell.south]) {
      // The 80°S and 84°N limits only show when the view reaches past them.
      if (edge > bounds.south && edge < bounds.north) {
        lineFeatures.push(
          lineFeature(
            [
              [clipWest, edge],
              [clipEast, edge],
            ],
            "zone",
          ),
        );
      }
    }
  }

  for (const cell of cells) {
    const clip: Rect = {
      west: Math.max(cell.west + cell.offset, view.west),
      east: Math.min(cell.east + cell.offset, view.east),
      south: Math.max(cell.south, view.south),
      north: Math.min(cell.north, view.north),
    };
    if (clip.east <= clip.west || clip.north <= clip.south) continue;
    const designation = `${cell.zone}${cell.band}`;

    if (options.showLabels && fitsLabel(clip, pxPerDegree, MIN_ZONE_LABEL_PX)) {
      const centerLon = (clip.west + clip.east) / 2;
      // Zones alone: name each zone in its middle. With squares drawn, the
      // middle belongs to a square ID, so the zone moves to the top edge.
      labelFeatures.push(
        step === 0
          ? labelFeature(centerLon, (clip.south + clip.north) / 2, designation, "center", "zone")
          : labelFeature(centerLon, clip.north, designation, "top", "zone"),
      );
    }
    if (step === 0 || lineFeatures.length >= maxLines) continue;

    const projection = zoneProjection(cell.zone, cell.south < 0);
    if (!projection) continue;
    // Work in the cell's own -180..180 longitudes, which is what proj4 reads
    // and returns, and shift the output back into the view's world copy.
    const rect: Rect = {
      west: clip.west - cell.offset,
      east: clip.east - cell.offset,
      south: clip.south,
      north: clip.north,
    };
    const extent = utmExtent(projection.toUtm, rect);
    if (!extent) continue;
    const { eMin, eMax, nMin, nMax } = extent;
    const centralMeridian = (cell.zone - 1) * 6 - 180 + 3;
    const inverse = (e: number, n: number): Position | null => {
      try {
        const [lon, lat] = projection.toLngLat.forward([e, n]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
        // Keep the longitude next to the zone's meridian, so zone 60 does not
        // wrap to -180 on its way past the antimeridian.
        const unwrapped =
          centralMeridian + ((((lon - centralMeridian + 180) % 360) + 360) % 360) - 180;
        return [unwrapped, lat];
      } catch {
        return null;
      }
    };
    const shift = (piece: Position[]): Position[] =>
      piece.map(([lon, lat]) => [lon + cell.offset, lat]);
    const touches = (a: number, b: number) => Math.abs(a - b) < 1e-7;

    for (const tier of MGRS_GRID_STEPS) {
      if (tier < step || lineFeatures.length >= maxLines) break;
      const level = levelForStep(tier);
      // 10 km and 1 km lines carry edge labels; 100 km lines are named by
      // their squares instead.
      const labelEdges = options.showLabels && tier < 100_000;

      // Constant-easting lines, running north.
      for (let e = Math.ceil(eMin / tier) * tier; e <= eMax; e += tier) {
        if (lineFeatures.length >= maxLines) break;
        // A coarser tier already drew this line.
        if (tier < 100_000 && e % (tier * 10) === 0) continue;
        const coords: Position[] = [];
        for (let i = 0; i <= LINE_SEGMENTS; i += 1) {
          const point = inverse(e, nMin + ((nMax - nMin) * i) / LINE_SEGMENTS);
          if (point) coords.push(point);
        }
        for (const piece of clipPolyline(coords, rect)) {
          lineFeatures.push(lineFeature(shift(piece), level));
          if (!labelEdges) continue;
          const first = piece[0];
          const last = piece[piece.length - 1];
          if (touches(first[1], view.south)) {
            labelFeatures.push(
              labelFeature(first[0] + cell.offset, first[1], principalDigits(e), "bottom", "edge"),
            );
          }
          if (showAllEdges && touches(last[1], view.north)) {
            labelFeatures.push(
              labelFeature(last[0] + cell.offset, last[1], principalDigits(e), "top", "edge"),
            );
          }
        }
      }

      // Constant-northing lines, running east.
      for (let n = Math.ceil(nMin / tier) * tier; n <= nMax; n += tier) {
        if (lineFeatures.length >= maxLines) break;
        if (tier < 100_000 && n % (tier * 10) === 0) continue;
        const coords: Position[] = [];
        for (let i = 0; i <= LINE_SEGMENTS; i += 1) {
          const point = inverse(eMin + ((eMax - eMin) * i) / LINE_SEGMENTS, n);
          if (point) coords.push(point);
        }
        for (const piece of clipPolyline(coords, rect)) {
          lineFeatures.push(lineFeature(shift(piece), level));
          if (!labelEdges) continue;
          const first = piece[0];
          const last = piece[piece.length - 1];
          if (touches(first[0], rect.west) && touches(clip.west, view.west)) {
            labelFeatures.push(
              labelFeature(first[0] + cell.offset, first[1], principalDigits(n), "left", "edge"),
            );
          }
          if (showAllEdges && touches(last[0], rect.east) && touches(clip.east, view.east)) {
            labelFeatures.push(
              labelFeature(last[0] + cell.offset, last[1], principalDigits(n), "right", "edge"),
            );
          }
        }
      }
    }

    if (options.showLabels) {
      labelSquares(cell, rect, extent, projection, inverse, pxPerDegree, labelFeatures);
    }
  }

  return result();
}

/**
 * Label each 100 km square visible in a cell with its two-letter ID, at the
 * centre of the part of the square inside the cell and viewport.
 */
function labelSquares(
  cell: GridZoneCell,
  rect: Rect,
  extent: { eMin: number; eMax: number; nMin: number; nMax: number },
  projection: ZoneProjection,
  inverse: (e: number, n: number) => Position | null,
  pxPerDegree: number,
  out: Feature<Point>[],
): void {
  const firstColumn = Math.floor(extent.eMin / 100_000);
  const lastColumn = Math.floor(extent.eMax / 100_000);
  const firstRow = Math.floor(extent.nMin / 100_000);
  const lastRow = Math.floor(extent.nMax / 100_000);
  for (let column = firstColumn; column <= lastColumn; column += 1) {
    for (let row = firstRow; row <= lastRow; row += 1) {
      const e0 = column * 100_000;
      const n0 = row * 100_000;
      const id = mgrsSquareId(cell.zone, e0, n0);
      if (!id) continue;
      // The square's lng/lat bounding box, from its corners and edge midpoints.
      let west = Infinity;
      let east = -Infinity;
      let south = Infinity;
      let north = -Infinity;
      for (const [fe, fn] of [
        [0, 0],
        [0.5, 0],
        [1, 0],
        [1, 0.5],
        [1, 1],
        [0.5, 1],
        [0, 1],
        [0, 0.5],
      ]) {
        const point = inverse(e0 + fe * 100_000, n0 + fn * 100_000);
        if (!point) continue;
        west = Math.min(west, point[0]);
        east = Math.max(east, point[0]);
        south = Math.min(south, point[1]);
        north = Math.max(north, point[1]);
      }
      const clipWest = Math.max(west, rect.west);
      const clipEast = Math.min(east, rect.east);
      const clipSouth = Math.max(south, rect.south);
      const clipNorth = Math.min(north, rect.north);
      if (!(clipEast > clipWest) || !(clipNorth > clipSouth)) continue;
      const lat = (clipSouth + clipNorth) / 2;
      const lon = (clipWest + clipEast) / 2;
      // Skip slivers too small to hold the two letters legibly.
      const clipped = { west: clipWest, east: clipEast, south: clipSouth, north: clipNorth };
      if (!fitsLabel(clipped, pxPerDegree, MIN_SQUARE_LABEL_PX)) continue;
      // The box centre of a clipped, slightly rotated square can fall just
      // outside it; only label a point that really is in this square.
      let inside = false;
      try {
        const [e, n] = projection.toUtm.forward([lon, lat]);
        inside = e >= e0 && e < e0 + 100_000 && n >= n0 && n < n0 + 100_000;
      } catch {
        inside = false;
      }
      if (!inside) continue;
      out.push(labelFeature(lon + cell.offset, lat, id, "center", "square"));
    }
  }
}
