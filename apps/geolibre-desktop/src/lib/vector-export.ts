import type { GeoLibreLayer } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import {
  saveBinaryFileWithFallback,
  saveTextFileWithFallback,
} from "./tauri-io";
import {
  type BinaryVectorExportFormat,
  exportBinaryVectorLayer,
} from "./vector-exporter";

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
  const text = formatAttributeValue(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
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
    const values = [
      featureId,
      ...orderedKeys.map((key) => properties[key]),
    ];
    return values.map(csvCell).join(",");
  });

  return [headers.map(csvCell).join(","), ...rows].join("\n");
}

function exportFormatLabel(format: BinaryVectorExportFormat): string {
  switch (format) {
    case "geoparquet":
      return "GeoParquet";
  }
}

function exportFileExtension(format: BinaryVectorExportFormat): string {
  switch (format) {
    case "geoparquet":
      return "parquet";
  }
}

function exportMimeType(format: BinaryVectorExportFormat): string {
  switch (format) {
    case "geoparquet":
      return "application/vnd.apache.parquet";
  }
}

async function exportTextLayer(
  format: "geojson" | "csv",
  geojson: FeatureCollection,
  baseName: string,
) {
  const isCsv = format === "csv";
  const content = isCsv
    ? geojsonToCsv(geojson)
    : JSON.stringify(geojson, null, 2);
  await saveTextFileWithFallback(content, {
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
) {
  const result = await exportBinaryVectorLayer(geojson, format, baseName);
  const label = exportFormatLabel(format);
  const extension = exportFileExtension(format);
  await saveBinaryFileWithFallback(result.data, {
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
 * with the native (Tauri) or browser file-save dialog.
 */
export async function exportVectorLayer(
  geojson: FeatureCollection,
  format: VectorExportFormat,
  baseName: string,
): Promise<void> {
  if (format === "geojson" || format === "csv") {
    await exportTextLayer(format, geojson, baseName);
    return;
  }
  await exportBinaryLayer(format, geojson, baseName);
}

/**
 * Source id of a geojson-render-mode vector layer created by the Add Vector
 * Layer control, or null. These layers hold their features in a MapLibre
 * GeoJSON source rather than in `layer.geojson`, so callers read the data back
 * from the map. Tiles-mode (DuckDB) vector layers are excluded.
 */
export function geojsonVectorSourceId(
  layer: GeoLibreLayer | undefined,
): string | null {
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
    (data as { type?: string }).type === "FeatureCollection"
  ) {
    return data as FeatureCollection;
  }
  return null;
}
