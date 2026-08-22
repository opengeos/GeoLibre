import type { GeoLibreLayer, LayerCapabilities } from "./types";

/**
 * Default inferred capabilities for a layer based on its type and metadata.
 *
 * Inferred rules:
 * - `query`: true for all valid layers.
 * - `create`, `update`, `delete`: true for in-memory or editable GeoJSON vector layers,
 *   false for derived queries (DuckDB/SQL), read-only vector tiles, and raster layers.
 * - `export`: true by default.
 */
export function inferLayerCapabilities(layer: GeoLibreLayer): Required<LayerCapabilities> {
  const isVector = layer.type === "geojson";
  const isDuckDB =
    layer.metadata?.sourceKind === "duckdb-query" ||
    (layer.type === "geojson" && typeof layer.metadata?.query === "string");
  const isExternalNative = layer.metadata?.externalNativeLayer === true;
  const isSketches = layer.metadata?.sourceKind === "geoeditor-sketches";
  const isSqlQuery = layer.metadata?.sourceKind === "sql-query";

  const isReadOnlyVector = isExternalNative && layer.metadata?.sourceKind !== "maplibre-gl-vector";
  const isEditable = isVector && !isDuckDB && !isReadOnlyVector && !isSketches && !isSqlQuery;

  return {
    query: true,
    create: isEditable,
    update: isEditable,
    delete: isEditable,
    export: true,
  };
}

/**
 * Resolves the effective capabilities for a layer by overlaying any explicit
 * capability overrides on top of inferred defaults.
 */
export function resolveLayerCapabilities(
  layer: GeoLibreLayer | undefined,
): Required<LayerCapabilities> {
  if (!layer) {
    return {
      query: false,
      create: false,
      update: false,
      delete: false,
      export: false,
    };
  }

  const defaults = inferLayerCapabilities(layer);
  if (!layer.capabilities) {
    return defaults;
  }

  return {
    query: layer.capabilities.query ?? defaults.query,
    create: layer.capabilities.create ?? defaults.create,
    update: layer.capabilities.update ?? defaults.update,
    delete: layer.capabilities.delete ?? defaults.delete,
    export: layer.capabilities.export ?? defaults.export,
  };
}

/**
 * Normalizes an untrusted capabilities value from JSON/project data.
 */
export function normalizeLayerCapabilities(raw: unknown): LayerCapabilities | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const caps: LayerCapabilities = {};
  let hasAny = false;

  if (typeof obj.query === "boolean") {
    caps.query = obj.query;
    hasAny = true;
  }
  if (typeof obj.create === "boolean") {
    caps.create = obj.create;
    hasAny = true;
  }
  if (typeof obj.update === "boolean") {
    caps.update = obj.update;
    hasAny = true;
  }
  if (typeof obj.delete === "boolean") {
    caps.delete = obj.delete;
    hasAny = true;
  }
  if (typeof obj.export === "boolean") {
    caps.export = obj.export;
    hasAny = true;
  }

  return hasAny ? caps : undefined;
}
