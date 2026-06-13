/**
 * Pure legend construction for the Print Layout composer. Kept free of DOM and
 * PDF dependencies so it can be unit tested directly.
 */
import {
  styleValue,
  type GeoLibreLayer,
  type LayerType,
  type VectorStyleStop,
} from "@geolibre/core";
import type { LegendEntry } from "./print-layout";

/** Layer types styled as vectors (colored fills the legend can represent). */
const VECTOR_TYPES: ReadonlySet<LayerType> = new Set<LayerType>([
  "geojson",
  "flatgeobuf",
  "geoparquet",
  "vector-tiles",
  "pmtiles",
  "duckdb-query",
  "deckgl-viz",
]);

/** Layer types with no meaningful single-swatch legend representation. */
const NON_LEGEND_TYPES: ReadonlySet<LayerType> = new Set<LayerType>([
  "lidar",
  "gaussian-splat",
  "3d-tiles",
  "video",
]);

const NEUTRAL_SWATCH = "#94a3b8";
const MAX_RAMP_SWATCHES = 6;

/**
 * Build legend entries from the visible layers. Vector layers contribute a
 * colored swatch (or several, for graduated/categorized symbology); raster and
 * service layers contribute a single neutral swatch; 3D and media layers are
 * omitted.
 *
 * @param layers - All layers from the store, in render order (bottom first).
 * @returns Legend entries in top-of-stack-first order.
 */
export function buildLegend(layers: GeoLibreLayer[]): LegendEntry[] {
  const entries: LegendEntry[] = [];
  // Render order in the store is bottom-first; legends read top-first.
  for (const layer of [...layers].reverse()) {
    if (!layer.visible) continue;
    if (NON_LEGEND_TYPES.has(layer.type)) continue;

    if (VECTOR_TYPES.has(layer.type)) {
      const mode = styleValue(layer.style, "vectorStyleMode");
      const stops = styleValue(layer.style, "vectorStyleStops");
      if (
        (mode === "graduated" || mode === "categorized") &&
        Array.isArray(stops) &&
        stops.length > 0
      ) {
        entries.push({ name: layer.name, swatches: rampSwatches(stops, mode) });
        continue;
      }
      entries.push({
        name: layer.name,
        swatches: [{ color: styleValue(layer.style, "fillColor") }],
      });
      continue;
    }

    // Raster / service layers: a single neutral marker swatch.
    entries.push({ name: layer.name, swatches: [{ color: NEUTRAL_SWATCH }] });
  }
  return entries;
}

function rampSwatches(
  stops: VectorStyleStop[],
  mode: "graduated" | "categorized",
): { color: string; label: string }[] {
  const limited =
    stops.length > MAX_RAMP_SWATCHES
      ? sampleEvenly(stops, MAX_RAMP_SWATCHES)
      : stops;
  return limited.map((stop) => ({
    color: stop.color,
    label:
      mode === "graduated"
        ? `≥ ${formatStopValue(stop.value)}`
        : formatStopValue(stop.value),
  }));
}

function sampleEvenly<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items;
  const out: T[] = [];
  for (let i = 0; i < count; i++) {
    out.push(items[Math.round((i * (items.length - 1)) / (count - 1))]);
  }
  return out;
}

function formatStopValue(value: unknown): string {
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  return String(value ?? "");
}
