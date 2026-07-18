import type { ExpressionVariable } from "@geolibre/core";
import { OGC_SCALE_DENOMINATOR_AT_ZOOM_0 } from "@geolibre/map";

/**
 * Shared inputs for the Expression Builder's entry points (Style panel,
 * Select by Expression): the attribute field list for a layer and the
 * standard `@` variable set, extracted from StylePanel so every expression
 * dialog offers the same fields and variables.
 */

function getMetadataFieldNames(metadata: Record<string, unknown>): string[] {
  const fieldValues = [
    metadata.fields,
    metadata.columns,
    metadata.properties,
    metadata.attributeFields,
  ];
  const names = new Set<string>();

  for (const value of fieldValues) {
    if (!Array.isArray(value)) continue;
    for (const field of value) {
      if (typeof field === "string") {
        names.add(field);
        continue;
      }
      if (field && typeof field === "object" && "name" in field && typeof field.name === "string") {
        names.add(field.name);
      }
    }
  }

  return Array.from(names);
}

export function getAttributePropertyNames(layer: {
  geojson?: {
    features?: Array<{
      properties?: Record<string, unknown> | null;
    }>;
  };
  metadata: Record<string, unknown>;
}): string[] {
  const names = new Set<string>();

  for (const feature of layer.geojson?.features ?? []) {
    for (const key of Object.keys(feature.properties ?? {})) {
      names.add(key);
    }
  }

  for (const key of getMetadataFieldNames(layer.metadata)) {
    names.add(key);
  }

  return Array.from(names).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
  );
}

/**
 * The standard `@` variable set every Expression Builder entry point offers,
 * with values snapshotted from the caller's current state. `centerLat` feeds
 * the `@map_scale` approximation (96 dpi Web Mercator at the map center).
 */
export function standardExpressionVariables(options: {
  projectName: string;
  layerName: string;
  featureCount: number;
  zoom: number;
  centerLat: number;
}): ExpressionVariable[] {
  const mapScaleDenominator = Math.round(
    (OGC_SCALE_DENOMINATOR_AT_ZOOM_0 / Math.pow(2, options.zoom)) *
      Math.cos((options.centerLat * Math.PI) / 180),
  );
  return [
    { token: "@project_name", value: options.projectName },
    { token: "@layer_name", value: options.layerName },
    { token: "@feature_count", value: options.featureCount },
    { token: "@map_zoom", value: Math.round(options.zoom * 100) / 100 },
    { token: "@map_scale", value: mapScaleDenominator },
  ];
}
