import {
  compileFeatureExpression,
  compileLayerFilters,
  styleValue,
  type GeoLibreLayer,
} from "@geolibre/core";
import type { FeatureCollection, Feature } from "geojson";
import { detectGeometryProfile, type GeometryProfile } from "./geojson-loader";

// Shared by MapLibre's layer-sync and the Mapbox compiler. Both engines cluster
// at the source, before evaluating style-layer filters, so both narrow the
// clustered source data by the layer's authored filters the same way. Kept free
// of any renderer import so the Mapbox bundle never pulls in maplibre-gl.

const clusteredFilterInputs = new WeakMap<
  FeatureCollection,
  { key: string; value: FeatureCollection }
>();

/** Whether an expression reads `["zoom"]`, and so cannot be evaluated once. */
export function expressionUsesZoom(node: unknown): boolean {
  if (!Array.isArray(node)) return false;
  // `["literal", …]` wraps data, not operators, and a categorical Quick Filter
  // compiles its selected values into one. A field value that happens to be
  // the string "zoom" is not the zoom operator, so do not walk inside.
  if (node[0] === "literal") return false;
  // The operator takes no arguments; a longer array starting with "zoom" is a
  // value list, not a call.
  if (node[0] === "zoom" && node.length === 1) return true;
  return node.some((entry) => expressionUsesZoom(entry));
}

/** Whether two feature lists hold the same feature objects in the same order. */
function sameFeatureList(left: Feature[], right: Feature[]): boolean {
  return left.length === right.length && left.every((feature, index) => feature === right[index]);
}

/**
 * Narrow a cluster renderer's source data by the layer's authored filters.
 * MapLibre clusters before evaluating style-layer filters, so applying the
 * expression only to the unclustered circle would leave hidden points in
 * cluster bubbles and counts. Only the current filter's result is cached per
 * source object, so ordinary sync ticks keep a stable data reference while
 * iterating on a filter does not retain a copy of the dataset per attempt.
 *
 * Unlike a style-layer filter, which MapLibre re-evaluates against the live
 * camera, this runs once per sync, so `zoom` is passed in and joined to the
 * cache key. A zoom-dependent filter therefore needs a sync per zoom (see
 * {@link hasZoomDependentClusterFilter}); when the outcome is unchanged the
 * previous collection is returned so the source is not needlessly re-clustered.
 */
export function authoredClusterInput(layer: GeoLibreLayer, zoom: number): FeatureCollection {
  const geojson = layer.geojson!;
  const filter = compileLayerFilters(layer);
  if (!filter) return geojson;

  const source = JSON.stringify(filter);
  const filterKey = expressionUsesZoom(filter) ? `${source}@${zoom}` : source;
  const cached = clusteredFilterInputs.get(geojson);
  if (cached?.key === filterKey) return cached.value;

  const compiled = compileFeatureExpression(source, { expectedType: "boolean", zoom });
  if (!compiled.ok || !compiled.evaluate) return geojson;
  const evaluate = compiled.evaluate;
  const features = geojson.features.filter((feature) => {
    try {
      return evaluate(feature) === true;
    } catch {
      return false;
    }
  });
  // A zoom tick that changes nothing must not hand back a new object: the
  // inline path would call setData and MapLibre would re-cluster from scratch.
  const reused = cached && sameFeatureList(cached.value.features, features);
  const filtered = reused ? cached.value : { ...geojson, features };
  clusteredFilterInputs.set(geojson, { key: filterKey, value: filtered });
  return filtered;
}

// Resolve the point renderer and clustering parameters from a layer's style.
// The heatmap and cluster renderers only make sense for point geometry, so the
// setting is ignored on layers that also carry lines/polygons. Shared by the
// inline and tiled geojson paths so renderer detection lives in one place.
export function resolveVectorRenderMode(
  layer: GeoLibreLayer,
  profile: GeometryProfile,
): {
  renderer: string;
  wantCluster: boolean;
  clusterRadius: number;
  clusterMaxZoom: number;
} {
  const pointOnly = profile.hasPoint && !profile.hasLine && !profile.hasPolygon;
  const renderer = pointOnly ? styleValue(layer.style, "pointRenderer") : "single";
  return {
    renderer,
    wantCluster: renderer === "cluster",
    clusterRadius: styleValue(layer.style, "clusterRadius"),
    clusterMaxZoom: styleValue(layer.style, "clusterMaxZoom"),
  };
}

/**
 * Whether any layer needs its clustered source re-derived as the camera moves.
 * Pre-filtering a clustered source is a one-shot evaluation, so a filter that
 * reads `["zoom"]` only stays truthful if something re-runs it — see
 * {@link authoredClusterInput}. Callers use this to decide whether a zoom
 * listener is worth attaching at all; the ordinary layer pays nothing.
 */
export function hasZoomDependentClusterFilter(layers: GeoLibreLayer[]): boolean {
  return layers.some((layer) => {
    if (!layer.geojson) return false;
    // Ask the cheap question first. `detectGeometryProfile` walks every feature
    // and this runs on every sync pass, including ones with no filter in sight
    // (a drag, an opacity nudge), so the scan is paid only by a layer that
    // already carries a zoom-dependent authored filter.
    const filter = compileLayerFilters(layer);
    if (filter === null || !expressionUsesZoom(filter)) return false;
    const { wantCluster } = resolveVectorRenderMode(layer, detectGeometryProfile(layer.geojson));
    return wantCluster;
  });
}
