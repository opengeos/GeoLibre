import type { GeoLibreLayer } from "@geolibre/core";
import { csvCell as quoteCsvCell } from "./csv";
import type { FeatureCollection } from "geojson";
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import { saveBinaryFileWithFallback, saveTextFileWithFallback } from "./tauri-io";
import { type BinaryVectorExportFormat, exportBinaryVectorLayer } from "./vector-exporter";

export type VectorExportFormat = "geojson" | "csv" | BinaryVectorExportFormat;

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

async function exportTextLayer(
  format: "geojson" | "csv",
  geojson: FeatureCollection,
  baseName: string,
): Promise<string | null> {
  const isCsv = format === "csv";
  const content = isCsv ? geojsonToCsv(geojson) : JSON.stringify(geojson, null, 2);
  return saveTextFileWithFallback(content, {
    defaultName: `${baseName}.${isCsv ? "csv" : "geojson"}`,
    filters: [
      isCsv
        ? { name: "CSV", extensions: ["csv"] }
        : { name: "GeoJSON", extensions: ["geojson", "json"] },
    ],
    browserTypes: [
      {
        description: isCsv ? "CSV" : "GeoJSON",
        accept: isCsv
          ? { "text/csv": [".csv"] }
          : { "application/geo+json": [".geojson", ".json"] },
      },
    ],
    mimeType: isCsv ? "text/csv" : "application/geo+json",
  });
}

async function exportBinaryLayer(
  format: BinaryVectorExportFormat,
  geojson: FeatureCollection,
  baseName: string,
): Promise<string | null> {
  const result = await exportBinaryVectorLayer(geojson, format, baseName);
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
 */
export async function exportVectorLayer(
  geojson: FeatureCollection,
  format: VectorExportFormat,
  baseName: string,
): Promise<string | null> {
  if (format === "geojson" || format === "csv") {
    return exportTextLayer(format, geojson, baseName);
  }
  return exportBinaryLayer(format, geojson, baseName);
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
