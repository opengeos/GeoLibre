import { isDuckDBQueryLayer, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import { getDuckDBLayerRows } from "@geolibre/plugins";
import { useMemo } from "react";
import type { ChartRow } from "../lib/attribute-charts";

export interface LayerChartData {
  /** Attribute rows for charting (just the property bag each chart needs). */
  rows: ChartRow[];
  /** Distinct property keys discovered across the rows, in first-seen order. */
  columns: string[];
  /** The layer's display name (empty when the layer is missing). */
  layerName: string;
  /** True when the layer exists and exposes attribute rows we can chart. */
  hasData: boolean;
}

const EMPTY: LayerChartData = {
  rows: [],
  columns: [],
  layerName: "",
  hasData: false,
};

/**
 * Whether a layer exposes the attribute rows a chart widget needs: a
 * GeoJSON-backed vector layer or a DuckDB query layer. Tile/service/raster
 * layers have no per-feature attributes to chart.
 */
export function isChartableLayer(layer: GeoLibreLayer | null | undefined): boolean {
  return Boolean(layer && (isDuckDBQueryLayer(layer) || layer.geojson));
}

function buildLayerChartData(layer: GeoLibreLayer | null): LayerChartData {
  if (!layer) return EMPTY;
  // Mirror the attribute table's two row sources: DuckDB query layers fetch
  // their rows from the plugin's cache, every other vector layer reads its
  // features straight off `layer.geojson`.
  const rows: ChartRow[] = isDuckDBQueryLayer(layer)
    ? getDuckDBLayerRows(layer.id).map((row) => ({ properties: row.properties }))
    : (layer.geojson?.features ?? []).map((feature) => ({
        properties: (feature.properties ?? {}) as Record<string, unknown>,
      }));

  const keys = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row.properties)) keys.add(key);
  }

  return {
    rows,
    columns: Array.from(keys),
    layerName: layer.name,
    // Require actual rows, not just a chartable layer type: a DuckDB layer whose
    // query cache is still empty has no rows yet, and the widget should show its
    // own "no data" fallback rather than an empty chart.
    hasData: isChartableLayer(layer) && rows.length > 0,
  };
}

/**
 * Resolve a layer id to the rows, columns, and name a chart widget renders
 * from. Recomputes when the layer record changes (e.g. attribute edits replace
 * `layer.geojson`). DuckDB query rows come from the plugin cache and are read
 * once per layer-identity change, matching the attribute table's behavior.
 *
 * @param layerId The layer to chart, or null for an empty result.
 * @returns The layer's chart data, or an empty result when it is missing or has
 *   no chartable attributes.
 */
export function useLayerChartData(layerId: string | null): LayerChartData {
  const layer = useAppStore((s) =>
    layerId ? (s.layers.find((l) => l.id === layerId) ?? null) : null,
  );
  return useMemo(() => buildLayerChartData(layer), [layer]);
}
