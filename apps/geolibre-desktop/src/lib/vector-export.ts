import { encodePolyline, type GeoLibreLayer } from "@geolibre/core";
import { csvCell as quoteCsvCell } from "./csv";
import type { FeatureCollection } from "geojson";
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import { saveBinaryFileWithFallback, saveTextFileWithFallback } from "./tauri-io";
import { type BinaryVectorExportFormat, exportBinaryVectorLayer } from "./vector-exporter";

export { KmlCoordinateError, kmlExportErrorMessage } from "./vector-export-errors";

type TextVectorExportFormat = "geojson" | "csv" | "kml" | "polyline";

export type VectorExportFormat = TextVectorExportFormat | BinaryVectorExportFormat;

const TEXT_EXPORT_FORMATS: Record<
  TextVectorExportFormat,
  {
    extension: string;
    filterExtensions: string[];
    label: string;
    mimeType: string;
  }
> = {
  geojson: {
    extension: "geojson",
    filterExtensions: ["geojson", "json"],
    label: "GeoJSON",
    mimeType: "application/geo+json",
  },
  csv: {
    extension: "csv",
    filterExtensions: ["csv"],
    label: "CSV",
    mimeType: "text/csv",
  },
  kml: {
    extension: "kml",
    filterExtensions: ["kml"],
    label: "KML",
    mimeType: "application/vnd.google-earth.kml+xml",
  },
  polyline: {
    extension: "polyline",
    filterExtensions: ["polyline", "txt"],
    label: "Encoded Polyline",
    mimeType: "text/plain",
  },
};

/** Render an attribute value as the plain string used in CSV cells and inputs. */
export function formatAttributeValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Turn a layer name into a filesystem-safe export base filename. */
export function sanitizeExportFileName(name: string): string {
  const sanitized = name
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return sanitized || "layer";
}

function csvCell(value: unknown): string {
  return quoteCsvCell(formatAttributeValue(value));
}

function geojsonToCsv(geojson: FeatureCollection): string {
  const propertyKeys = new Set<string>();
  for (const feature of geojson.features) {
    for (const key of Object.keys(feature.properties ?? {})) {
      propertyKeys.add(key);
    }
  }

  const orderedKeys = Array.from(propertyKeys);
  const headers = ["feature_id", ...orderedKeys];
  const rows = geojson.features.map((feature, index) => {
    const featureId = String(feature.id ?? index);
    const properties = feature.properties ?? {};
    const values = [featureId, ...orderedKeys.map((key) => properties[key])];
    return values.map(csvCell).join(",");
  });

  return [headers.map(csvCell).join(","), ...rows].join("\n");
}

function exportFormatLabel(format: BinaryVectorExportFormat): string {
  switch (format) {
    case "geoparquet":
      return "GeoParquet";
    case "geopackage":
      return "GeoPackage";
    case "shapefile":
      return "Shapefile (zipped)";
    case "kmz":
      return "KMZ";
  }
}

function exportFileExtension(format: BinaryVectorExportFormat): string {
  switch (format) {
    case "geoparquet":
      return "parquet";
    case "geopackage":
      return "gpkg";
    case "shapefile":
      return "zip";
    case "kmz":
      return "kmz";
  }
}

function exportMimeType(format: BinaryVectorExportFormat): string {
  switch (format) {
    case "geoparquet":
      return "application/vnd.apache.parquet";
    case "geopackage":
      return "application/geopackage+sqlite3";
    case "shapefile":
      return "application/zip";
    case "kmz":
      return "application/vnd.google-earth.kmz";
  }
}

// Shapefile holds one geometry family per file. Mirror the writer's grouping so
// the warning matches what actually happens on export.
type ShapefileFamily = "point" | "line" | "polygon";

function shapefileFamily(type: string): ShapefileFamily | null {
  switch (type) {
    case "Point":
    case "MultiPoint":
      return "point";
    case "LineString":
    case "MultiLineString":
      return "line";
    case "Polygon":
    case "MultiPolygon":
      return "polygon";
    default:
      return null;
  }
}

/**
 * Field-name limitations the Shapefile format will silently apply on export.
 * Returns a human-readable warning for any attribute name longer than 10
 * characters (which DBF truncates), for truncations that collide into the same
 * name, and when the layer mixes geometry types (extra families are dropped to
 * Null shapes). Empty when the layer is fully Shapefile-safe.
 */
export function shapefileFieldWarnings(geojson: FeatureCollection): string[] {
  const names = new Set<string>();
  for (const feature of geojson.features) {
    for (const key of Object.keys(feature.properties ?? {})) {
      names.add(key);
    }
  }

  const fieldNames = Array.from(names);
  const longNames = fieldNames.filter((name) => name.length > 10);
  const warnings: string[] = [];
  if (longNames.length > 0) {
    warnings.push(`Shapefile truncates field names to 10 characters: ${longNames.join(", ")}`);
  }

  // Normalise non-alphanumerics to "_" before truncating, exactly as the DBF
  // writer does, so collisions caused by character replacement are detected.
  const byTruncated = new Map<string, string[]>();
  for (const name of fieldNames) {
    const key = name
      .replace(/[^0-9A-Za-z_]/g, "_")
      .slice(0, 10)
      .toLowerCase();
    byTruncated.set(key, [...(byTruncated.get(key) ?? []), name]);
  }
  const collisions = Array.from(byTruncated.values()).filter((group) => group.length > 1);
  if (collisions.length > 0) {
    warnings.push(
      `Truncating to 10 characters produces duplicate field names: ${collisions
        .map((group) => group.join(", "))
        .join("; ")}`,
    );
  }

  // The writer locks the file to the first geometry's family; mixed or null
  // geometries become attribute-only Null shapes, which is silent data loss.
  let fileFamily: ShapefileFamily | null = null;
  for (const feature of geojson.features) {
    const family = feature.geometry ? shapefileFamily(feature.geometry.type) : null;
    if (family) {
      fileFamily = family;
      break;
    }
  }
  // Count only features that carry a geometry of a different family; null
  // geometries have nothing to lose and are not flagged.
  let demoted = 0;
  if (fileFamily !== null) {
    for (const feature of geojson.features) {
      const family = feature.geometry ? shapefileFamily(feature.geometry.type) : null;
      if (family && family !== fileFamily) demoted += 1;
    }
  }
  if (fileFamily !== null && demoted > 0) {
    warnings.push(
      `${demoted} feature(s) whose geometry differs from the ${fileFamily} ` +
        "type will be written without geometry (Shapefile allows one geometry " +
        "type per file).",
    );
  }
  return warnings;
}

function geojsonToPolylineText(geojson: FeatureCollection, precision = 5): string {
  const lines: string[] = [];
  for (const feature of geojson.features) {
    const geometry = feature.geometry;
    if (!geometry) continue;
    if (geometry.type === "LineString") {
      const encoded = encodePolyline(geometry.coordinates as [number, number][], precision);
      if (encoded) lines.push(encoded);
    } else if (geometry.type === "MultiLineString") {
      for (const lineCoords of geometry.coordinates) {
        const encoded = encodePolyline(lineCoords as [number, number][], precision);
        if (encoded) lines.push(encoded);
      }
    }
  }
  if (lines.length === 0) {
    throw new Error(
      "No LineString or MultiLineString geometries found to export as Encoded Polyline. Encoded Polyline export is only supported for line layers.",
    );
  }
  return lines.join("\n");
}

/**
 * Whether a layer contains line geometries (LineString or MultiLineString)
 * suitable for Encoded Polyline export. Returns false for points, polygons, or mixed layers.
 */
export function layerSupportsPolylineExport(layer: GeoLibreLayer): boolean {
  if (layer.type !== "geojson") return false;
  const rawType =
    typeof layer.metadata?.geometryType === "string"
      ? layer.metadata.geometryType.toLowerCase()
      : null;
  if (
    rawType === "point" ||
    rawType === "multipoint" ||
    rawType === "polygon" ||
    rawType === "multipolygon"
  ) {
    return false;
  }

  const features = layer.geojson?.features;
  if (!features || features.length === 0) {
    return rawType === "line" || rawType === "linestring" || rawType === "multilinestring";
  }

  const hasLine = features.some((f) => {
    const type = f.geometry?.type;
    return type === "LineString" || type === "MultiLineString";
  });
  const hasNonLine = features.some((f) => {
    const type = f.geometry?.type;
    return type !== "LineString" && type !== "MultiLineString";
  });

  return hasLine && !hasNonLine;
}

async function textExportContent(
  format: TextVectorExportFormat,
  geojson: FeatureCollection,
  documentName: string,
  precision = 5,
): Promise<string> {
  switch (format) {
    case "geojson":
      return JSON.stringify(geojson, null, 2);
    case "csv":
      return geojsonToCsv(geojson);
    case "kml":
      return (await import("./kml-writer")).writeKml(geojson, documentName);
    case "polyline":
      return geojsonToPolylineText(geojson, precision);
  }
}

async function exportTextLayer(
  format: TextVectorExportFormat,
  geojson: FeatureCollection,
  baseName: string,
  documentName: string,
  precision = 5,
): Promise<string | null> {
  const content = await textExportContent(format, geojson, documentName, precision);
  const { extension, filterExtensions, label, mimeType } = TEXT_EXPORT_FORMATS[format];
  return saveTextFileWithFallback(content, {
    defaultName: `${baseName}.${extension}`,
    filters: [{ name: label, extensions: filterExtensions }],
    browserTypes: [
      {
        description: label,
        accept: {
          [mimeType]: filterExtensions.map((candidate) => `.${candidate}`),
        },
      },
    ],
    mimeType,
  });
}

async function exportBinaryLayer(
  format: BinaryVectorExportFormat,
  geojson: FeatureCollection,
  baseName: string,
  documentName: string,
): Promise<string | null> {
  const result = await exportBinaryVectorLayer(geojson, format, baseName, documentName);
  const label = exportFormatLabel(format);
  const extension = exportFileExtension(format);
  return saveBinaryFileWithFallback(result.data, {
    defaultName: `${baseName}.${extension}`,
    filters: [{ name: label, extensions: [extension] }],
    browserTypes: [
      {
        description: label,
        accept: { [exportMimeType(format)]: [`.${extension}`] },
      },
    ],
    mimeType: result.mimeType,
  });
}

/**
 * Save a vector layer's features to disk in the requested format, prompting
 * with the native (Tauri) or browser file-save dialog. Returns the saved path
 * (a name in the browser), or null when the user cancels the save dialog.
 * The optional document name preserves the human-readable layer title inside
 * KML and KMZ while the base name remains safe for the filesystem.
 */
export async function exportVectorLayer(
  geojson: FeatureCollection,
  format: VectorExportFormat,
  baseName: string,
  documentName = baseName,
  precision = 5,
): Promise<string | null> {
  if (format === "geojson" || format === "csv" || format === "kml" || format === "polyline") {
    return exportTextLayer(format, geojson, baseName, documentName, precision);
  }
  return exportBinaryLayer(format, geojson, baseName, documentName);
}

/**
 * Source id of a geojson-render-mode vector layer created by the Add Vector
 * Layer control, or null. These layers hold their features in a MapLibre
 * GeoJSON source rather than in `layer.geojson`, so callers read the data back
 * from the map. Tiles-mode (DuckDB) vector layers are excluded.
 */
export function geojsonVectorSourceId(layer: GeoLibreLayer | undefined): string | null {
  if (
    !layer ||
    layer.type !== "geojson" ||
    layer.metadata.sourceKind !== "maplibre-gl-vector" ||
    layer.metadata.externalNativeLayer !== true
  ) {
    return null;
  }
  const sourceIds = layer.metadata.sourceIds;
  const sourceId = Array.isArray(sourceIds) ? sourceIds[0] : undefined;
  return typeof sourceId === "string" ? sourceId : null;
}

/**
 * Resolve a layer's features for export. Plain geojson layers carry them in
 * `layer.geojson`; Add Vector Layer geojson-mode layers keep them in a MapLibre
 * GeoJSON source, which is read back from the map. Returns null when no feature
 * data is available (e.g. tile or service layers).
 */
export async function resolveLayerGeojson(
  layer: GeoLibreLayer,
  map: MapLibreMap | undefined,
): Promise<FeatureCollection | null> {
  if (layer.geojson) return layer.geojson;

  const sourceId = geojsonVectorSourceId(layer);
  if (!sourceId || !map) return null;

  const source = map.getSource(sourceId) as GeoJSONSource | undefined;
  if (!source || typeof source.getData !== "function") return null;

  const data = await source.getData();
  if (
    data &&
    typeof data === "object" &&
    (data as { type?: string }).type === "FeatureCollection" &&
    Array.isArray((data as { features?: unknown }).features)
  ) {
    return data as FeatureCollection;
  }
  return null;
}
