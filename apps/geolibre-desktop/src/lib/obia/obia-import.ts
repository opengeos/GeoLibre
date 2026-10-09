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
  readonly code: "no-crs" | "no-polygons" | "no-objects" | "bad-file" | "no-ids";

  constructor(code: ObiaImportError["code"], message: string) {
    super(message);
    this.name = "ObiaImportError";
    this.code = code;
  }
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
 * @throws ObiaImportError for an image without a known CRS, a layer without
 *   polygons, or ids that are not positive whole numbers.
 */
export async function rasterizeObjects(
  polygons: FeatureCollection,
  source: GeoLibreLayer,
  bandIndexes: readonly number[],
  idField: string | null,
  area?: ObiaReadArea,
): Promise<ObiaImportedObjects> {
  const info = await obiaSourceInfo(source);
  if (!info) throw new Error("Could not read the image.");
  const plan = area
    ? { area, pixelSize: info.pixelSize * (info.levels[0].width / info.levels[area.level].width) }
    : planObiaArea(info, wholeImageWindow(info));
  const image = await obiaSourceBands(source, [bandIndexes[0] ?? 1], plan.area);
  if (!image) throw new Error("Could not read the image.");
  const grid = await decodeLabelGrid(image.bands[0].bytes);
  const project = gridTransform(info, plan.area);

  const kept: { id: number; feature: Feature }[] = [];
  const seen = new Set<number>();
  polygons.features.forEach((feature, index) => {
    if (!polygonsOf(feature.geometry).length) return;
    const raw = idField ? feature.properties?.[idField] : index + 1;
    const id = Number(raw);
    if (!Number.isInteger(id) || id < 1 || seen.has(id)) {
      throw new ObiaImportError(
        "no-ids",
        `The id field must hold distinct positive whole numbers (found ${String(raw)}).`,
      );
    }
    seen.add(id);
    kept.push({ id, feature });
  });
  if (!kept.length) throw new ObiaImportError("no-polygons", "The layer has no polygons.");

  const ids = rasterizePolygons(
    kept.map(({ id, feature }) => ({
      id,
      rings: polygonsOf(feature.geometry).flatMap((rings) => rings.map((ring) => ring.map(project))),
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

/** A representative point of a sample: itself, or a polygon's centroid. */
function samplePoints(geometry: Geometry | null): Position[] {
  if (!geometry) return [];
  switch (geometry.type) {
    case "Point":
      return [geometry.coordinates];
    case "MultiPoint":
      return geometry.coordinates;
    case "Polygon":
    case "MultiPolygon": {
      // Area-weighted centroid of the outer rings, relative to their first
      // vertex: raw degrees cancel catastrophically for small polygons.
      const parts = polygonsOf(geometry).map((rings) => rings[0] ?? []);
      const origin = parts.find((ring) => ring.length)?.[0];
      if (!origin) return [];
      let a = 0;
      let cx = 0;
      let cy = 0;
      for (const ring of parts) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
          const xj = ring[j][0] - origin[0];
          const yj = ring[j][1] - origin[1];
          const xi = ring[i][0] - origin[0];
          const yi = ring[i][1] - origin[1];
          const cross = xj * yi - xi * yj;
          a += cross;
          cx += (xj + xi) * cross;
          cy += (yj + yi) * cross;
        }
      }
      return a ? [[origin[0] + cx / (3 * a), origin[1] + cy / (3 * a)]] : [];
    }
    case "GeometryCollection":
      return geometry.geometries.flatMap(samplePoints);
    default:
      return [];
  }
}

/** Default colors for classes an import adds. */
const PALETTE = ["#16a34a", "#2563eb", "#dc2626", "#ca8a04", "#7c3aed", "#0891b2", "#db2777", "#65a30d"];

/**
 * Label objects from imported samples (points, or polygons by their
 * centroid): each sample gives the object under it its class and role.
 *
 * @param samples The sample layer, in WGS84.
 * @param classField The field naming each sample's class.
 * @param roleField A field saying training or validation, or null to use `role`.
 * @param role The role when there is no role field (or it is not recognized).
 * @param objects The objects layer to label.
 * @param labels The objects' label raster.
 * @param source The image the objects belong to.
 * @param area The area the labels were read over.
 * @returns The labeled objects, the classes the samples name, and how many
 *   samples matched an object.
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
): Promise<{ objects: FeatureCollection; classNames: string[]; matched: number; missed: number }> {
  const info = await obiaSourceInfo(source);
  if (!info) throw new Error("Could not read the image.");
  const grid: ObiaLabelGrid = await decodeLabelGrid(labels);
  const project = gridTransform(info, area ?? { level: 0, window: wholeImageWindow(info) });
  const groups = new Map<string, Set<number>>();
  const classNames: string[] = [];
  let matched = 0;
  let missed = 0;
  for (const sample of samples.features) {
    const name = String(sample.properties?.[classField] ?? "").trim();
    if (!name) continue;
    const roleValue = roleField ? String(sample.properties?.[roleField] ?? "").toLowerCase() : "";
    const sampleRole: ObiaSampleRole =
      roleValue === "training" || roleValue === "validation" ? roleValue : role;
    for (const point of samplePoints(sample.geometry)) {
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
      if (!classNames.includes(name)) classNames.push(name);
      const key = `${name}\u0000${sampleRole}`;
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
  return { objects: labeled, classNames, matched, missed };
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
    if (name >= 0) items = csv.rows.map((row) => ({ name: row[name], color: color >= 0 ? row[color] : undefined }));
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
  if (!table.fields.length) throw new ObiaImportError("bad-file", "The table has no feature columns.");
  return table;
}

/**
 * Parse a level mapping: CSV with a child id and a parent id per row
 * (`child_id,parent_id`, or the first two columns).
 *
 * @throws ObiaImportError when no row maps a child to a parent.
 */
export function parseLevelMapping(text: string): Map<number, number> {
  const csv = parseObiaCsv(text.trim());
  const child = Math.max(0, csv.headers.findIndex((h) => /child/i.test(h)));
  const parentIndex = csv.headers.findIndex((h) => /parent/i.test(h));
  const parent = parentIndex >= 0 ? parentIndex : child === 0 ? 1 : 0;
  const mapping = new Map<number, number>();
  for (const row of csv.rows) {
    const c = Number(row[child]);
    const p = Number(row[parent]);
    if (Number.isInteger(c) && Number.isInteger(p) && c > 0 && p > 0) mapping.set(c, p);
  }
  if (!mapping.size) throw new ObiaImportError("bad-file", "The mapping has no child_id,parent_id rows.");
  return mapping;
}
