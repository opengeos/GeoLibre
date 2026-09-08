import { DEFAULT_LAYER_STYLE, styleValue, type GeoLibreLayer } from "@geolibre/core";
import type { DataSource, Entity, PointPrimitive, PointPrimitiveCollection } from "@cesium/engine";
import type { Feature } from "geojson";
import type { FeatureStyleResolver } from "./cesium-feature-style";

// Point layers on the globe beyond one entity per feature (issue #2282).
//
// Two things the entity path cannot do: cluster (MapLibre's `pointRenderer:
// "cluster"` aggregates points per zoom through geojson-vt; Cesium has
// `EntityCluster`, a screen-space clusterer over a data source), and scale.
// `GeoJsonDataSource` entities carry Property objects, a Cesium-side event
// subscription each, and a per-entity geometry updater, which is fine for a
// few thousand features and sluggish past a few tens of thousands. Above
// {@link MAX_ENTITY_POINT_FEATURES} a point-only layer bypasses entities and
// goes straight into one `PointPrimitiveCollection`, the way the 2D map
// switches from an inline GeoJSON source to client-side tiling — with the
// feature reference kept on each primitive's `id` so picking still works.
//
// The engine namespace is injected (type-only Cesium imports), as everywhere
// in the globe code.

type CesiumNs = typeof import("@cesium/engine");

/**
 * Point-only layers above this many features render as a
 * `PointPrimitiveCollection` rather than entities. Matches the 2D map's
 * `MAX_DERIVED_FEATURES`, the size past which it stops deriving geometry from
 * a collection in the browser.
 */
export const MAX_ENTITY_POINT_FEATURES = 50_000;

/** The reference a batched point primitive carries on its `id`. */
export interface BatchedPointRef {
  readonly geolibreLayerId: string;
  readonly index: number;
}

export function isBatchedPointRef(value: unknown): value is BatchedPointRef {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as BatchedPointRef).geolibreLayerId === "string" &&
    Number.isInteger((value as BatchedPointRef).index)
  );
}

/**
 * geojson-vt's `point_count_abbreviated`, which the 2D cluster count label
 * shows: thousands as `1.5k`, ten-thousands and up rounded to `12k`.
 */
export function abbreviateCount(count: number): string {
  if (count >= 10_000) return `${Math.round(count / 1000)}k`;
  if (count >= 1000) return `${Math.round(count / 100) / 10}k`;
  return String(count);
}

/**
 * A cluster bubble's diameter in pixels for `count` members: the 2D map's
 * `clusterCirclePaint` steps its radius 16 → 22 → 30 at 50 and 200 points.
 */
export function clusterPixelSize(count: number): number {
  const radius = count >= 200 ? 30 : count >= 50 ? 22 : 16;
  return radius * 2;
}

/** How a GeoJSON layer's points should be drawn on the globe. */
export interface PointRenderPlan {
  /** Whether every feature is a point (the renderers below only apply then). */
  pointsOnly: boolean;
  /** The store's point renderer; `heatmap` has no globe form and draws as `single`. */
  renderer: "single" | "cluster" | "heatmap";
  /** Cluster through `EntityCluster`. */
  cluster: boolean;
  /** Draw through a `PointPrimitiveCollection` instead of entities. */
  batched: boolean;
  clusterRadius: number;
  clusterMaxZoom: number;
}

function isPointFeature(feature: Feature): boolean {
  const type = feature.geometry?.type;
  return type === "Point" || type === "MultiPoint";
}

/**
 * Whether a collection holds only points, remembered per collection object.
 * The plan is consulted on every sync tick for every layer (through
 * `entryKind`/`needsRebuild`), and the store swaps the collection object on
 * any feature edit, so the scan runs once per collection rather than once per
 * tick over the very large layers batching exists for.
 */
const pointsOnlyByCollection = new WeakMap<object, boolean>();

function allPoints(collection: object, features: readonly Feature[]): boolean {
  const known = pointsOnlyByCollection.get(collection);
  if (known !== undefined) return known;
  const result = features.every(isPointFeature);
  pointsOnlyByCollection.set(collection, result);
  return result;
}

/**
 * Decide the point rendering for a layer. Clustering and batching are for
 * point-only layers, as on the 2D map; a layer that also carries lines or
 * polygons keeps the entity path for all of it. Markers, extrusion, and true
 * 3D elevation stay on entities too — the primitive path draws plain circles
 * on the ground.
 */
export function planPointRendering(layer: GeoLibreLayer): PointRenderPlan {
  const style = { ...DEFAULT_LAYER_STYLE, ...layer.style };
  const features = layer.geojson?.features ?? [];
  const pointsOnly = features.length > 0 && allPoints(layer.geojson!, features);
  const renderer = styleValue(style, "pointRenderer");
  const cluster = pointsOnly && renderer === "cluster";
  const batched =
    pointsOnly &&
    !cluster &&
    !style.markerEnabled &&
    !style.elevation3dEnabled &&
    features.length > MAX_ENTITY_POINT_FEATURES;
  return {
    pointsOnly,
    renderer,
    cluster,
    batched,
    clusterRadius: Math.max(1, styleValue(style, "clusterRadius")),
    clusterMaxZoom: styleValue(style, "clusterMaxZoom"),
  };
}

/** What the cluster handler needs from the layer at cluster time. */
export interface ClusterAppearance {
  fill: string;
  fillOpacity: number;
  stroke: string;
  strokeWidth: number;
  textColor: string;
  /** Layer (or story) opacity, folded into every colour. */
  opacity: number;
}

/** The cluster appearance a layer's style asks for, before the layer opacity. */
export function clusterAppearance(layer: GeoLibreLayer, opacity: number): ClusterAppearance {
  const style = { ...DEFAULT_LAYER_STYLE, ...layer.style };
  return {
    fill: style.fillColor,
    fillOpacity: style.fillOpacity,
    stroke: style.strokeColor,
    strokeWidth: style.strokeWidth,
    textColor: style.textColor,
    opacity,
  };
}

/**
 * Turn a data source's `EntityCluster` on with the layer's parameters and a
 * handler that styles each bubble like the 2D map's cluster layers: a circle
 * in the fill colour sized by member count, the abbreviated count on top.
 *
 * Returns a handle to re-cluster (after an opacity or style change — the
 * handler reads the appearance afresh) and to tear the listener down.
 */
export function configureClustering(
  Cesium: CesiumNs,
  dataSource: DataSource,
  plan: PointRenderPlan,
  appearance: () => ClusterAppearance,
): { refresh(): void; setEnabled(enabled: boolean): void; dispose(): void } {
  const clustering = dataSource.clustering;
  clustering.pixelRange = plan.clusterRadius;
  clustering.minimumClusterSize = 2;
  clustering.clusterPoints = true;
  clustering.clusterBillboards = true;
  clustering.clusterLabels = true;
  const onCluster = (
    entities: Entity[],
    cluster: Parameters<Parameters<typeof clustering.clusterEvent.addEventListener>[0]>[1],
  ) => {
    const look = appearance();
    const count = entities.length;
    const colour = (css: string, alpha: number) =>
      Cesium.Color.fromCssColorString(css).withAlpha(Math.min(1, Math.max(0, alpha)));
    cluster.billboard.show = false;
    cluster.point.show = true;
    cluster.point.pixelSize = clusterPixelSize(count);
    cluster.point.color = colour(look.fill, look.fillOpacity * look.opacity);
    cluster.point.outlineColor = colour(look.stroke, look.opacity);
    cluster.point.outlineWidth = look.strokeWidth;
    cluster.point.disableDepthTestDistance = Number.POSITIVE_INFINITY;
    cluster.label.show = true;
    cluster.label.text = abbreviateCount(count);
    cluster.label.font = "12px sans-serif";
    cluster.label.fillColor = colour(look.textColor, look.opacity);
    cluster.label.style = Cesium.LabelStyle.FILL;
    cluster.label.horizontalOrigin = Cesium.HorizontalOrigin.CENTER;
    cluster.label.verticalOrigin = Cesium.VerticalOrigin.CENTER;
    cluster.label.disableDepthTestDistance = Number.POSITIVE_INFINITY;
  };
  const remove = clustering.clusterEvent.addEventListener(onCluster as never);
  clustering.enabled = true;
  return {
    refresh() {
      // Flipping `enabled` marks the clusterer dirty so the next frame
      // re-runs the handler with the current appearance; a same-value write
      // would not.
      if (!clustering.enabled) return;
      clustering.enabled = false;
      clustering.enabled = true;
    },
    setEnabled(enabled) {
      clustering.enabled = enabled;
    },
    dispose() {
      remove();
      clustering.enabled = false;
    },
  };
}

/**
 * Whether clustering should be active at `zoom`: the 2D map stops clustering
 * past `clusterMaxZoom` (geojson-vt's own cutoff), so the globe does the same
 * with the camera's MapLibre-equivalent zoom.
 */
export function clusterActiveAtZoom(plan: PointRenderPlan, zoom: number): boolean {
  return plan.cluster && zoom < plan.clusterMaxZoom;
}

/** Every point position a feature contributes (a MultiPoint contributes several). */
function pointCoordinates(feature: Feature): number[][] {
  const geometry = feature.geometry;
  if (geometry?.type === "Point") return [geometry.coordinates];
  if (geometry?.type === "MultiPoint") return geometry.coordinates;
  return [];
}

/**
 * Build a `PointPrimitiveCollection` for a batched point layer: one primitive
 * per point, coloured and sized by the resolver, tagged with its feature
 * reference for picking. Positions sit on the ellipsoid and draw through
 * terrain (`disableDepthTestDistance`), the primitive path's stand-in for
 * ground clamping.
 */
export function buildPointBatch(
  Cesium: CesiumNs,
  layer: GeoLibreLayer,
  resolver: FeatureStyleResolver,
  opacity: number,
  zoom: number,
): PointPrimitiveCollection {
  const collection = new Cesium.PointPrimitiveCollection();
  const features = layer.geojson?.features ?? [];
  for (let index = 0; index < features.length; index++) {
    const feature = features[index];
    const symbol = resolver.resolve(feature, zoom);
    for (const [lng, lat, z] of pointCoordinates(feature)) {
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      collection.add({
        position: Cesium.Cartesian3.fromDegrees(lng, lat, Number.isFinite(z) ? z : 0),
        pixelSize: symbol.radius * 2,
        color: Cesium.Color.fromCssColorString(symbol.fill).withAlpha(symbol.fillOpacity * opacity),
        outlineColor: Cesium.Color.fromCssColorString(symbol.outline).withAlpha(
          symbol.strokeOpacity * opacity,
        ),
        outlineWidth: symbol.strokeWidth,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        id: { geolibreLayerId: layer.id, index } satisfies BatchedPointRef,
      });
    }
  }
  return collection;
}

/** Re-colour and re-size every primitive of a batch from the resolver. */
export function restylePointBatch(
  Cesium: CesiumNs,
  collection: PointPrimitiveCollection,
  layer: GeoLibreLayer,
  resolver: FeatureStyleResolver,
  opacity: number,
  zoom: number,
): void {
  const features = layer.geojson?.features ?? [];
  let lastIndex = -1;
  let symbol = resolver.resolve(undefined, zoom);
  for (let i = 0; i < collection.length; i++) {
    const point: PointPrimitive = collection.get(i);
    const ref = point.id;
    if (!isBatchedPointRef(ref)) continue;
    // Consecutive primitives of one MultiPoint share a symbol.
    if (ref.index !== lastIndex) {
      symbol = resolver.resolve(features[ref.index], zoom);
      lastIndex = ref.index;
    }
    point.pixelSize = symbol.radius * 2;
    point.color = Cesium.Color.fromCssColorString(symbol.fill).withAlpha(
      symbol.fillOpacity * opacity,
    );
    point.outlineColor = Cesium.Color.fromCssColorString(symbol.outline).withAlpha(
      symbol.strokeOpacity * opacity,
    );
    point.outlineWidth = symbol.strokeWidth;
  }
}
