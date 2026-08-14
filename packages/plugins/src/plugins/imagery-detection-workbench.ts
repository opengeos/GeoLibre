import type { Feature, FeatureCollection, Polygon } from "geojson";
import type { GeoLibreLayer } from "@geolibre/core";

export const IMAGERY_DETECTION_WORKBENCH_ID = "imagery-detection-workbench";
export const ANNOTATION_SOURCE_KIND = "imagery-detection-annotations";

export const VESSEL_CLASSES = [
  { key: "a", id: "cargo", label: "Cargo" },
  { key: "s", id: "tanker", label: "Tanker" },
  { key: "d", id: "fishing", label: "Fishing" },
  { key: "f", id: "passenger", label: "Passenger" },
  { key: "g", id: "working_vessel", label: "Working vessel" },
  {
    key: "h",
    id: "military_law_enforcement",
    label: "Military / law enforcement",
  },
  { key: "j", id: "small_boat", label: "Small boat" },
  { key: "k", id: "sailboat", label: "Sailboat" },
  { key: "l", id: "unknown_vessel", label: "Unknown vessel" },
  { key: ";", id: "not_vessel", label: "Not a vessel" },
] as const;

export type VesselClassId = (typeof VESSEL_CLASSES)[number]["id"];
export type LngLatPoint = [longitude: number, latitude: number];
export type ImageBounds = [west: number, south: number, east: number, north: number];

export interface ImageryMetadata {
  layerId: string;
  layerName: string;
  sourceUri?: string;
  sensor: string;
  modality: string;
  acquiredAt?: string;
  resolutionM?: number;
  bands?: string;
  processingLevel?: string;
  widthPx?: number;
  heightPx?: number;
  bounds?: ImageBounds;
}

export type CoverageStatus = "unreviewed" | "reviewed" | "skipped";
export interface CoverageChip {
  id: string;
  row: number;
  column: number;
  bounds: ImageBounds;
  status: CoverageStatus;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
    if (Array.isArray(value) && value.length) return value.map(String).join(",");
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const number = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return undefined;
}

export function imageryMetadataFromLayer(layer: GeoLibreLayer): ImageryMetadata {
  const metadata = layer.metadata as Record<string, unknown>;
  const source = layer.source as Record<string, unknown>;
  const collection =
    firstString(metadata.stacCollectionId, metadata.collectionId, source.collectionId) ?? "";
  const context = `${collection} ${
    firstString(metadata.platform, metadata.constellation, metadata.sensor) ?? ""
  }`;
  const inferredSensor = /sentinel-2/i.test(context)
    ? "Sentinel-2"
    : /sentinel-1/i.test(context)
      ? "Sentinel-1"
      : /landsat/i.test(context)
        ? "Landsat"
        : "Unknown";
  const candidateBounds = metadata.bounds ?? source.bounds;
  const values = Array.isArray(candidateBounds) ? candidateBounds.slice(0, 4).map(Number) : [];
  const bounds =
    values.length === 4 &&
    values.every(Number.isFinite) &&
    values[0]! < values[2]! &&
    values[1]! < values[3]!
      ? (values as ImageBounds)
      : undefined;
  return {
    layerId: layer.id,
    layerName: layer.name,
    sourceUri: firstString(
      metadata.primaryAssetUrl,
      source.url,
      layer.sourcePath,
      metadata.stacItemId,
    ),
    sensor:
      firstString(metadata.sensor, metadata.platform, metadata.constellation) ?? inferredSensor,
    modality: /sentinel-1|sar/i.test(`${context} ${metadata.modality ?? ""}`) ? "SAR" : "optical",
    acquiredAt: firstString(metadata.acquiredAt, metadata.datetime, metadata.nasaDate),
    resolutionM: firstNumber(metadata.resolutionM, metadata.gsd),
    bands: firstString(metadata.bands, metadata.bandNames, source.bands, metadata.assets),
    processingLevel: firstString(metadata.processingLevel, metadata.processing_level),
    widthPx: firstNumber(metadata.widthPx, metadata.width, metadata.rasterWidth),
    heightPx: firstNumber(metadata.heightPx, metadata.height, metadata.rasterHeight),
    bounds,
  };
}

export function createCoverageGrid(
  bounds: ImageBounds,
  rows: number,
  columns: number,
): CoverageChip[] {
  const safeRows = Math.max(1, Math.floor(rows));
  const safeColumns = Math.max(1, Math.floor(columns));
  const [west, south, east, north] = bounds;
  const width = (east - west) / safeColumns;
  const height = (north - south) / safeRows;
  const chips: CoverageChip[] = [];
  for (let row = 0; row < safeRows; row += 1) {
    for (let column = 0; column < safeColumns; column += 1) {
      chips.push({
        id: `r${row + 1}-c${column + 1}`,
        row,
        column,
        bounds: [
          west + column * width,
          north - (row + 1) * height,
          west + (column + 1) * width,
          north - row * height,
        ],
        status: "unreviewed",
      });
    }
  }
  return chips;
}

/** Sentinel-2 L2A SCL classes that should never seed an optical proposal. */
const SCL_EXCLUDED = new Set([0, 1, 3, 8, 9, 10, 11]);

/** Keep water pixels and a configurable coastal margin, while rejecting
 * confident cloud/shadow/snow pixels even when they border water. */
export function sentinel2SclAllowsCandidate(
  scl: ArrayLike<number>,
  width: number,
  height: number,
  x: number,
  y: number,
  coastalRadiusPx = 5,
): boolean {
  const cx = Math.max(0, Math.min(width - 1, Math.round(x)));
  const cy = Math.max(0, Math.min(height - 1, Math.round(y)));
  const value = Math.round(scl[cy * width + cx] ?? 0);
  if (value === 6) return true;
  if (SCL_EXCLUDED.has(value)) return false;
  for (let dy = -coastalRadiusPx; dy <= coastalRadiusPx; dy += 1) {
    for (let dx = -coastalRadiusPx; dx <= coastalRadiusPx; dx += 1) {
      if (dx * dx + dy * dy > coastalRadiusPx * coastalRadiusPx) continue;
      const px = cx + dx;
      const py = cy + dy;
      if (
        px >= 0 &&
        py >= 0 &&
        px < width &&
        py < height &&
        Math.round(scl[py * width + px] ?? 0) === 6
      )
        return true;
    }
  }
  return false;
}

export interface DetectionProperties {
  detection_id: string;
  imagery_layer_id: string;
  imagery_layer_name: string;
  source_uri?: string;
  sensor: string;
  modality: string;
  acquired_at?: string;
  resolution_m?: number;
  bands?: string;
  processing_level?: string;
  vessel_class?: VesselClassId;
  review_status: "unreviewed" | "accepted" | "rejected" | "skipped";
  analyst_confidence: "low" | "medium" | "high";
  geometry_source: "analyst" | "model" | "model_modified";
  model_score?: number;
  created_at: string;
  reviewed_at?: string;
}

export type DetectionFeature = Feature<Polygon, DetectionProperties>;

export function vesselClassForKey(key: string): (typeof VESSEL_CLASSES)[number] | undefined {
  return VESSEL_CLASSES.find((entry) => entry.key === key.toLowerCase());
}

export function createDetectionFeature(
  corners: [LngLatPoint, LngLatPoint, LngLatPoint, LngLatPoint],
  imagery: ImageryMetadata,
  options: {
    id?: string;
    now?: string;
    geometrySource?: DetectionProperties["geometry_source"];
    modelScore?: number;
  } = {},
): DetectionFeature {
  const id =
    options.id ??
    (typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const now = options.now ?? new Date().toISOString();
  return {
    type: "Feature",
    id,
    geometry: { type: "Polygon", coordinates: [[...corners, corners[0]]] },
    properties: {
      detection_id: id,
      imagery_layer_id: imagery.layerId,
      imagery_layer_name: imagery.layerName,
      ...(imagery.sourceUri ? { source_uri: imagery.sourceUri } : {}),
      sensor: imagery.sensor,
      modality: imagery.modality,
      ...(imagery.acquiredAt ? { acquired_at: imagery.acquiredAt } : {}),
      ...(imagery.resolutionM !== undefined ? { resolution_m: imagery.resolutionM } : {}),
      ...(imagery.bands ? { bands: imagery.bands } : {}),
      ...(imagery.processingLevel ? { processing_level: imagery.processingLevel } : {}),
      review_status: "unreviewed",
      analyst_confidence: "medium",
      geometry_source: options.geometrySource ?? "analyst",
      ...(options.modelScore !== undefined ? { model_score: options.modelScore } : {}),
      created_at: now,
    },
  };
}

/** Fit a PCA-oriented rectangle around a source-pixel mask polygon and map it
 * into the scene's north-up geographic bounds. */
export function maskPolygonToOrientedCorners(
  polygon: [number, number][],
  width: number,
  height: number,
  bounds: ImageBounds,
): [LngLatPoint, LngLatPoint, LngLatPoint, LngLatPoint] | null {
  const points =
    polygon.length > 1 &&
    polygon[0]![0] === polygon.at(-1)![0] &&
    polygon[0]![1] === polygon.at(-1)![1]
      ? polygon.slice(0, -1)
      : polygon;
  if (points.length < 3 || width <= 0 || height <= 0) return null;
  const cx = points.reduce((sum, point) => sum + point[0], 0) / points.length;
  const cy = points.reduce((sum, point) => sum + point[1], 0) / points.length;
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (const [x, y] of points) {
    const dx = x - cx;
    const dy = y - cy;
    xx += dx * dx;
    yy += dy * dy;
    xy += dx * dy;
  }
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const vx = -uy;
  const vy = ux;
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const [x, y] of points) {
    const dx = x - cx;
    const dy = y - cy;
    const u = dx * ux + dy * uy;
    const v = dx * vx + dy * vy;
    minU = Math.min(minU, u);
    maxU = Math.max(maxU, u);
    minV = Math.min(minV, v);
    maxV = Math.max(maxV, v);
  }
  const [west, south, east, north] = bounds;
  const toGeographic = (u: number, v: number): LngLatPoint => {
    const px = cx + u * ux + v * vx;
    const py = cy + u * uy + v * vy;
    return [west + (px / width) * (east - west), north - (py / height) * (north - south)];
  };
  return [
    toGeographic(minU, minV),
    toGeographic(maxU, minV),
    toGeographic(maxU, maxV),
    toGeographic(minU, maxV),
  ];
}

export function classifyDetection(
  feature: DetectionFeature,
  vesselClass: VesselClassId,
  now = new Date().toISOString(),
): DetectionFeature {
  return {
    ...feature,
    properties: {
      ...feature.properties,
      vessel_class: vesselClass,
      review_status: vesselClass === "not_vessel" ? "rejected" : "accepted",
      reviewed_at: now,
    },
  };
}

export function skipDetection(feature: DetectionFeature): DetectionFeature {
  return {
    ...feature,
    properties: { ...feature.properties, review_status: "skipped" },
  };
}

export function featureCollection(features: DetectionFeature[]): FeatureCollection<Polygon> {
  return { type: "FeatureCollection", features };
}

export function geographicToPixel(
  point: LngLatPoint,
  bounds: ImageBounds,
  width: number,
  height: number,
): [number, number] {
  const [west, south, east, north] = bounds;
  return [
    ((point[0] - west) / (east - west)) * width,
    ((north - point[1]) / (north - south)) * height,
  ];
}

function pixelPolygon(
  feature: DetectionFeature,
  imagery: ImageryMetadata,
): [number, number][] | null {
  if (!imagery.bounds || !imagery.widthPx || !imagery.heightPx) return null;
  const ring = feature.geometry.coordinates[0]?.slice(0, -1) as LngLatPoint[] | undefined;
  if (!ring || ring.length !== 4) return null;
  return ring.map((point) =>
    geographicToPixel(point, imagery.bounds!, imagery.widthPx!, imagery.heightPx!),
  );
}

function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function exportManifestCsv(imagery: ImageryMetadata, features: DetectionFeature[]): string {
  const header = [
    "scene_id",
    "image_uri",
    "sensor",
    "modality",
    "acquired_at",
    "resolution_m",
    "bands",
    "processing_level",
    "width_px",
    "height_px",
    "west",
    "south",
    "east",
    "north",
    "annotation_count",
    "reviewed_count",
  ];
  const bounds = imagery.bounds ?? [undefined, undefined, undefined, undefined];
  const reviewed = features.filter(
    (feature) => feature.properties.review_status !== "unreviewed",
  ).length;
  const row = [
    imagery.layerId,
    imagery.sourceUri,
    imagery.sensor,
    imagery.modality,
    imagery.acquiredAt,
    imagery.resolutionM,
    imagery.bands,
    imagery.processingLevel,
    imagery.widthPx,
    imagery.heightPx,
    ...bounds,
    features.length,
    reviewed,
  ];
  return `${header.join(",")}\n${row.map(csvCell).join(",")}\n`;
}

export function exportAnnotationsCsv(features: DetectionFeature[]): string {
  const header = [
    "detection_id",
    "scene_id",
    "class",
    "review_status",
    "analyst_confidence",
    "sensor",
    "modality",
    "acquired_at",
    "resolution_m",
    "geometry_source",
    "polygon_geojson",
  ];
  const rows = features.map((feature) => [
    feature.properties.detection_id,
    feature.properties.imagery_layer_id,
    feature.properties.vessel_class,
    feature.properties.review_status,
    feature.properties.analyst_confidence,
    feature.properties.sensor,
    feature.properties.modality,
    feature.properties.acquired_at,
    feature.properties.resolution_m,
    feature.properties.geometry_source,
    JSON.stringify(feature.geometry),
  ]);
  return `${header.join(",")}\n${rows
    .map((row) => row.map(csvCell).join(","))
    .join("\n")}${rows.length ? "\n" : ""}`;
}

export function exportCoco(imagery: ImageryMetadata, features: DetectionFeature[]): object {
  if (!imagery.widthPx || !imagery.heightPx || !imagery.bounds) {
    throw new Error("COCO export requires image width, height, and geographic bounds.");
  }
  const categories = VESSEL_CLASSES.filter((entry) => entry.id !== "not_vessel").map(
    (entry, index) => ({ id: index + 1, name: entry.id }),
  );
  const categoryIds = new Map<string, number>(
    categories.map((entry) => [entry.name, entry.id] as const),
  );
  const annotations = features.flatMap((feature, index) => {
    const categoryId = feature.properties.vessel_class
      ? categoryIds.get(feature.properties.vessel_class)
      : undefined;
    const polygon = pixelPolygon(feature, imagery);
    if (!categoryId || !polygon || feature.properties.review_status !== "accepted") return [];
    const xs = polygon.map(([x]) => x);
    const ys = polygon.map(([, y]) => y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs);
    const maxY = Math.max(...ys);
    return [
      {
        id: index + 1,
        image_id: 1,
        category_id: categoryId,
        bbox: [minX, minY, maxX - minX, maxY - minY],
        area: (maxX - minX) * (maxY - minY),
        segmentation: [polygon.flat()],
        iscrowd: 0,
        detection_id: feature.properties.detection_id,
      },
    ];
  });
  return {
    info: { description: "GeoLibre Imagery Detection Workbench export" },
    images: [
      {
        id: 1,
        file_name: imagery.sourceUri ?? imagery.layerName,
        width: imagery.widthPx,
        height: imagery.heightPx,
        sensor: imagery.sensor,
        acquired_at: imagery.acquiredAt,
      },
    ],
    categories,
    annotations,
  };
}

export function exportYoloObb(imagery: ImageryMetadata, features: DetectionFeature[]): string {
  if (!imagery.widthPx || !imagery.heightPx || !imagery.bounds) {
    throw new Error("YOLO OBB export requires image width, height, and geographic bounds.");
  }
  const categoryIds = new Map<string, number>(
    VESSEL_CLASSES.filter((entry) => entry.id !== "not_vessel").map(
      (entry, index) => [entry.id, index] as const,
    ),
  );
  const lines: string[] = [];
  for (const feature of features) {
    const classId = feature.properties.vessel_class
      ? categoryIds.get(feature.properties.vessel_class)
      : undefined;
    const polygon = pixelPolygon(feature, imagery);
    if (classId === undefined || !polygon || feature.properties.review_status !== "accepted")
      continue;
    const normalized = polygon.flatMap(([x, y]) => [
      Math.max(0, Math.min(1, x / imagery.widthPx!)),
      Math.max(0, Math.min(1, y / imagery.heightPx!)),
    ]);
    lines.push(`${classId} ${normalized.map((value) => value.toFixed(6)).join(" ")}`);
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}
