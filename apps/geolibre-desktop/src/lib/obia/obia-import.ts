import type { GeoLibreLayer } from "@geolibre/core";
import {
  OBIA_SEGMENT_ID_FIELD,
  decodeLabelGrid,
  encodeLabelGrid,
  fingerprintSegmentLabels,
  labelObjects,
  nativeFeatureTable,
  parseObiaCsv,
  rasterizePolygons,
  type ObiaClass,
  type ObiaFeatureTable,
  type ObiaLabelGrid,
  type ObiaReadArea,
  type ObiaSampleRole,
} from "@geolibre/processing";
import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
import {
  obiaSourceBands,
  obiaSourceInfo,
  planObiaArea,
  wholeImageWindow,
  type ObiaSourceInfo,
} from "./obia-source";

/** Why an import could not be done. */
export class ObiaImportError extends Error {
  readonly code:
    | "no-image"
    | "no-crs"
    | "no-polygons"
    | "no-objects"
    | "bad-file"
    | "no-ids"
    | "dup-ids"
    | "big-ids";

  constructor(code: ObiaImportError["code"], message: string) {
    super(message);
    this.name = "ObiaImportError";
    this.code = code;
  }
}

/**
 * The largest object id an import accepts: label rasters store ids as
 * Float32, which holds whole numbers exactly only up to 2^24.
 */
export const OBIA_MAX_IMPORT_ID = 2 ** 24;

/** A whole number from a table cell: a number, or a non-blank numeric string. */
function cellNumber(raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (typeof raw === "string" && raw.trim() !== "") return Number(raw);
  return Number.NaN;
}

/**
 * Map a WGS84 position to the pixel grid read for an area: full-resolution
 * pixels, scaled to the level and offset to the window.
 */
function gridTransform(info: ObiaSourceInfo, area: ObiaReadArea) {
  const toPixel = info.toPixel;
  if (!toPixel) {
    throw new ObiaImportError("no-crs", "The image's coordinate system is not recognized.");
  }
  const full = info.levels[0];
  const at = info.levels[area.level];
  const sx = full.width / at.width;
  const sy = full.height / at.height;
  const x0 = Math.floor(area.window[0] / sx);
  const y0 = Math.floor(area.window[1] / sy);
  return ([lng, lat]: Position): [number, number] => {
    const [x, y] = toPixel(lng, lat);
    return [x / sx - x0, y / sy - y0];
  };
}

/** The polygons of a geometry, each as its rings. */
function polygonsOf(geometry: Geometry | null): Position[][][] {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  if (geometry.type === "GeometryCollection") return geometry.geometries.flatMap(polygonsOf);
  return [];
}

/** An imported segmentation, ready to record. */
export interface ObiaImportedObjects {
  labels: Uint8Array;
  objects: FeatureCollection;
  objectCount: number;
  labelsHash: string;
  width: number;
  height: number;
  area: ObiaReadArea;
  pixelSize: number;
  /** Polygons that covered no pixel center and were left out. */
  skipped: number;
}

/**
 * Burn objects (polygons) onto the source image's grid, as a segmentation:
 * each polygon becomes an object whose `segment_id` is its id field (a
 * positive whole number) or its position in the layer.
 *
 * @param polygons The objects' polygons, in WGS84.
 * @param source The image the objects belong to.
 * @param bandIndexes Bands to measure later (the first gives the grid).
 * @param idField A field holding each object's id, or null to number them.
 * @param area The area to read; the whole image (at the level that fits)
 *   when omitted.
 * @throws ObiaImportError for an unreadable image, an image without a known
 *   CRS, a layer without polygons, or ids that are not distinct positive whole
 *   numbers up to {@link OBIA_MAX_IMPORT_ID}.
 */
export async function rasterizeObjects(
  polygons: FeatureCollection,
  source: GeoLibreLayer,
  bandIndexes: readonly number[],
  idField: string | null,
  area?: ObiaReadArea,
): Promise<ObiaImportedObjects> {
  const info = await obiaSourceInfo(source);
  if (!info) throw new ObiaImportError("no-image", "Could not read the image.");
  const plan = area
    ? { area, pixelSize: info.pixelSize * (info.levels[0].width / info.levels[area.level].width) }
    : planObiaArea(info, wholeImageWindow(info));
  const image = await obiaSourceBands(source, [bandIndexes[0] ?? 1], plan.area);
  if (!image) throw new ObiaImportError("no-image", "Could not read the image.");
  const grid = await decodeLabelGrid(image.bands[0].bytes);
  const project = gridTransform(info, plan.area);

  const kept: { id: number; feature: Feature }[] = [];
  const seen = new Set<number>();
  polygons.features.forEach((feature, index) => {
    if (!polygonsOf(feature.geometry).length) return;
    const raw = idField ? feature.properties?.[idField] : index + 1;
    const id = cellNumber(raw);
    if (!Number.isInteger(id) || id < 1) {
      throw new ObiaImportError("no-ids", `Object ids must be positive whole numbers (found ${String(raw)}).`);
    }
    if (id > OBIA_MAX_IMPORT_ID) {
      throw new ObiaImportError("big-ids", `Object ids must be at most ${OBIA_MAX_IMPORT_ID} (found ${id}).`);
    }
    if (seen.has(id)) {
      throw new ObiaImportError("dup-ids", `Object ids must be distinct (${id} repeats).`);
    }
    seen.add(id);
    kept.push({ id, feature });
  });
  if (!kept.length) throw new ObiaImportError("no-polygons", "The layer has no polygons.");

  const ids = rasterizePolygons(
    kept.map(({ id, feature }) => ({
      id,
      rings: polygonsOf(feature.geometry).flatMap((rings) =>
        rings.map((ring) => ring.map(project)),
      ),
    })),
    grid.width,
    grid.height,
  );
  const burned = new Set<number>();
  for (const id of ids) if (id) burned.add(id);
  if (!burned.size) {
    throw new ObiaImportError("no-objects", "No object covers the image.");
  }
  const labels = encodeLabelGrid(grid, ids);
  const objects: FeatureCollection = {
    type: "FeatureCollection",
    features: kept
      .filter(({ id }) => burned.has(id))
      .map(({ id, feature }) => ({
        ...feature,
        id,
        properties: { ...feature.properties, [OBIA_SEGMENT_ID_FIELD]: id },
      })),
  };
  const { objectCount, hash } = await fingerprintSegmentLabels(labels);
  return {
    labels,
    objects,
    objectCount,
    labelsHash: hash,
    width: grid.width,
    height: grid.height,
    area: plan.area,
    pixelSize: plan.pixelSize,
    skipped: kept.length - burned.size,
  };
}

/** Whether a point lies inside a polygon (its rings, even-odd, so holes count). */
function insidePolygon([x, y]: Position, rings: Position[][]): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/**
 * A point inside a polygon or multipolygon: its area-weighted centroid when
 * that falls inside, else the middle of the widest span of the largest part
 * along a horizontal line through that part's centroid (a concave shape or a
 * ring can have its centroid outside, or in a hole). Null for a zero-area shape.
 */
function pointOnSurface(polygons: Position[][][]): Position | null {
  const origin = polygons.find((rings) => rings[0]?.length)?.[0][0];
  if (!origin) return null;
  // Relative to the first vertex: raw degrees cancel catastrophically for
  // small polygons.
  const local = polygons.map((rings) =>
    rings.map((ring) => ring.map(([x, y]): Position => [x - origin[0], y - origin[1]])),
  );
  let total = 0;
  let cx = 0;
  let cy = 0;
  let largest: { rings: Position[][]; area: number; y: number } | null = null;
  for (const rings of local) {
    const ring = rings[0] ?? [];
    let a = 0;
    let px = 0;
    let py = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const cross = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      a += cross;
      px += (ring[j][0] + ring[i][0]) * cross;
      py += (ring[j][1] + ring[i][1]) * cross;
    }
    if (!a) continue;
    // Each part by its own area, whatever its winding.
    const weight = Math.abs(a);
    total += weight;
    cx += (px / (3 * a)) * weight;
    cy += (py / (3 * a)) * weight;
    if (!largest || weight > largest.area) largest = { rings, area: weight, y: py / (3 * a) };
  }
  if (!total || !largest) return null;
  const centroid: Position = [cx / total, cy / total];
  const at = (point: Position): Position => [point[0] + origin[0], point[1] + origin[1]];
  if (local.some((rings) => insidePolygon(centroid, rings))) return at(centroid);
  const xs: number[] = [];
  for (const ring of largest.rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > largest.y !== yj > largest.y) {
        xs.push(xi + ((largest.y - yi) * (xj - xi)) / (yj - yi));
      }
    }
  }
  xs.sort((p, q) => p - q);
  let best: Position | null = null;
  let width = -1;
  for (let i = 0; i + 1 < xs.length; i += 2) {
    if (xs[i + 1] - xs[i] > width) {
      width = xs[i + 1] - xs[i];
      best = [(xs[i] + xs[i + 1]) / 2, largest.y];
    }
  }
  return best ? at(best) : null;
}

/**
 * A representative point of a sample: itself, or a point inside a polygon
 * (its centroid when that is inside).
 */
export function samplePoints(geometry: Geometry | null): Position[] {
  if (!geometry) return [];
  switch (geometry.type) {
    case "Point":
      return [geometry.coordinates];
    case "MultiPoint":
      return geometry.coordinates;
    case "Polygon":
    case "MultiPolygon": {
      const point = pointOnSurface(polygonsOf(geometry));
      return point ? [point] : [];
    }
    case "GeometryCollection":
      return geometry.geometries.flatMap(samplePoints);
    default:
      return [];
  }
}

/** Default colors for classes an import adds. */
const PALETTE = [
  "#16a34a",
  "#2563eb",
  "#dc2626",
  "#ca8a04",
  "#7c3aed",
  "#0891b2",
  "#db2777",
  "#65a30d",
];

/**
 * Label objects from imported samples (points, or polygons by a point inside
 * them): each sample gives the object under it its class and role. When
 * samples disagree on an object, the first one wins.
 *
 * @param samples The sample layer, in WGS84.
 * @param classField The field naming each sample's class.
 * @param roleField A field saying training or validation, or null to use `role`.
 * @param role The role when there is no role field (or it is not recognized).
 * @param objects The objects layer to label.
 * @param labels The objects' label raster.
 * @param source The image the objects belong to.
 * @param area The area the labels were read over.
 * @returns The labeled objects, the classes the samples name, how many
 *   samples matched an object or missed (including a polygon with no area),
 *   and how many objects had samples that disagree.
 */
export async function labelFromSamples(
  samples: FeatureCollection,
  classField: string,
  roleField: string | null,
  role: ObiaSampleRole,
  objects: FeatureCollection,
  labels: Uint8Array,
  source: GeoLibreLayer,
  area: ObiaReadArea | undefined,
): Promise<{
  objects: FeatureCollection;
  classNames: string[];
  matched: number;
  missed: number;
  conflicts: number;
}> {
  const info = await obiaSourceInfo(source);
  if (!info) throw new ObiaImportError("no-image", "Could not read the image.");
  const grid: ObiaLabelGrid = await decodeLabelGrid(labels);
  const project = gridTransform(info, area ?? { level: 0, window: wholeImageWindow(info) });
  const groups = new Map<string, Set<number>>();
  const classNames = new Set<string>();
  // Each object's first label, so a later disagreeing sample can't override it.
  const labelOf = new Map<number, string>();
  const conflicted = new Set<number>();
  let matched = 0;
  let missed = 0;
  for (const sample of samples.features) {
    const name = String(sample.properties?.[classField] ?? "").trim();
    if (!name) continue;
    const roleValue = roleField ? String(sample.properties?.[roleField] ?? "")
          .trim()
          .toLowerCase() : "";
    const sampleRole: ObiaSampleRole =
      roleValue === "training" || roleValue === "validation" ? roleValue : role;
    const points = samplePoints(sample.geometry);
    if (!points.length && sample.geometry) missed += 1;
    for (const point of points) {
      const [x, y] = project(point);
      const col = Math.floor(x);
      const row = Math.floor(y);
      const id =
        col >= 0 && row >= 0 && col < grid.width && row < grid.height
          ? grid.ids[row * grid.width + col]
          : 0;
      if (!id) {
        missed += 1;
        continue;
      }
      matched += 1;
      const key = `${name}\u0000${sampleRole}`;
      const first = labelOf.get(id);
      if (first !== undefined) {
        if (first !== key) conflicted.add(id);
        continue;
      }
      labelOf.set(id, key);
      classNames.add(name);
      let set = groups.get(key);
      if (!set) groups.set(key, (set = new Set()));
      set.add(id);
    }
  }
  let labeled = objects;
  for (const [key, ids] of groups) {
    const [className, sampleRole] = key.split("\u0000") as [string, ObiaSampleRole];
    labeled = labelObjects(labeled, ids, { className, role: sampleRole });
  }
  return {
    objects: labeled,
    classNames: [...classNames],
    matched,
    missed,
    conflicts: conflicted.size,
  };
}

/** Add classes the workbench does not have yet, with distinct colors. */
export function withClasses(classes: readonly ObiaClass[], names: readonly string[]): ObiaClass[] {
  const next = [...classes];
  for (const name of names) {
    if (next.some((item) => item.name === name)) continue;
    next.push({ name, color: PALETTE[next.length % PALETTE.length] });
  }
  return next;
}

/**
 * Parse a class schema: JSON (a list of `{name, color}`, or `{classes: [...]}`)
 * or CSV with `name` and `color` columns.
 *
 * @throws ObiaImportError when the file holds no classes.
 */
export function parseClassSchema(text: string): ObiaClass[] {
  const trimmed = text.trim();
  let items: { name?: unknown; color?: unknown }[] = [];
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const value = JSON.parse(trimmed) as unknown;
      const list = Array.isArray(value) ? value : (value as { classes?: unknown }).classes;
      if (Array.isArray(list)) items = list as typeof items;
    } catch {
      throw new ObiaImportError("bad-file", "The class list is not valid JSON.");
    }
  } else {
    const csv = parseObiaCsv(trimmed);
    const name = csv.headers.findIndex((h) => /^(name|class|class_?name)$/i.test(h));
    const color = csv.headers.findIndex((h) => /^colou?r$/i.test(h));
    if (name >= 0)
      items = csv.rows.map((row) => ({
        name: row[name],
        color: color >= 0 ? row[color] : undefined,
      }));
  }
  const classes: ObiaClass[] = [];
  for (const item of items) {
    const name = typeof item?.name === "string" ? item.name.trim() : "";
    if (!name || classes.some((c) => c.name === name)) continue;
    const color =
      typeof item.color === "string" && /^#[0-9a-f]{6}$/i.test(item.color.trim())
        ? item.color.trim()
        : PALETTE[classes.length % PALETTE.length];
    classes.push({ name, color });
  }
  if (!classes.length) throw new ObiaImportError("bad-file", "The file lists no classes.");
  return classes;
}

/**
 * Parse an exported feature table (CSV with a `segment_id` column).
 *
 * @throws ObiaImportError when there is no `segment_id` column or no feature column.
 */
export function parseFeatureTable(text: string): ObiaFeatureTable {
  let table: ObiaFeatureTable;
  try {
    table = nativeFeatureTable(text, []);
  } catch {
    throw new ObiaImportError("bad-file", "The table needs a segment_id column.");
  }
  if (!table.fields.length)
    throw new ObiaImportError("bad-file", "The table has no feature columns.");
  return table;
}

/**
 * Parse a level mapping: CSV with a child id and a parent id per row. The
 * columns are found by a header naming them (`child_id`, `parent_id`), else
 * the first two are child then parent; a file whose first row is numbers has
 * no header.
 *
 * @throws ObiaImportError when no row maps a child to a parent, or an id is
 *   over {@link OBIA_MAX_IMPORT_ID}.
 */
export function parseLevelMapping(text: string): Map<number, number> {
  const csv = parseObiaCsv(text.trim());
  const headless =
    csv.headers.length >= 2 && csv.headers.every((h) => Number.isFinite(cellNumber(h)));
  const rows = headless ? [csv.headers, ...csv.rows] : csv.rows;
  let child = headless ? -1 : csv.headers.findIndex((h) => /child/i.test(h));
  let parent = headless ? -1 : csv.headers.findIndex((h) => /parent/i.test(h));
  if (child < 0 && parent < 0) [child, parent] = [0, 1];
  else if (child < 0) child = parent === 0 ? 1 : 0;
  else if (parent < 0) parent = child === 0 ? 1 : 0;
  const mapping = new Map<number, number>();
  for (const row of rows) {
    const c = cellNumber(row[child]);
    const p = cellNumber(row[parent]);
    if (!(Number.isInteger(c) && Number.isInteger(p) && c > 0 && p > 0)) continue;
    if (c > OBIA_MAX_IMPORT_ID || p > OBIA_MAX_IMPORT_ID) {
      throw new ObiaImportError("big-ids", `Object ids must be at most ${OBIA_MAX_IMPORT_ID}.`);
    }
    mapping.set(c, p);
  }
  if (!mapping.size)
    throw new ObiaImportError("bad-file", "The mapping has no child_id,parent_id rows.");
  return mapping;
}
