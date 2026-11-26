// Attribute and line-gap label layers for GeoJSON data layers.

import {
  DEFAULT_LAYER_STYLE,
  labelFieldTextField,
  removeTrailingJsonCommas,
  styleValue,
  type GeoLibreLayer,
  type LabelStyle,
  type LayerStyle,
  documentLocale,
} from "@geolibre/core";
import { DEDUPED_LABEL_PROPERTY, getDedupedLabelFeatures, parseLabelOverride } from "./label-style";
import { resolveVectorRenderMode } from "./cluster-input";
import type { FeatureCollection, GeoJSON } from "geojson";
import type * as maplibregl from "maplibre-gl";
import type { PropertyValueSpecification } from "maplibre-gl";
import { detectGeometryProfile, labelLayerId, labelSourceId } from "./geojson-loader";
import {
  LINE_GAP_ANGLE_PROPERTY,
  LINE_GAP_TEXT_PROPERTY,
  getLineGapLabels,
  type LineGapLabelResult,
} from "./line-gap-labels";
import { POLYGON_LABEL_AREA_PROPERTY, polygonLabelPoints } from "./polygon-label-points";
import {
  MIN_LAYER_ZOOM,
  MAX_LAYER_ZOOM,
  textMarkerShapeFilter,
  layerHasFeatureFilter,
  withFeatureFilters,
  rememberGeoJsonData,
  setGeoJsonData,
  clampLayerZoom,
  intersectZoomRange,
  type VectorRenderContext,
  removeSourceIfExists,
  textFontForMapStyle,
  ensureLayer,
  removeIfExists,
} from "./layer-sync-common";

/**
 * Attribute-driven labels: a symbol layer that renders the configured field
 * (or expression) for every feature. Distinct from the geoman text-marker
 * layer ({@link applyTextMarkerLayer}), which only renders annotation features.
 */
export function applyAttributeLabelLayer(ctx: VectorRenderContext): void {
  const { map, layer, renderer } = ctx;
  const labels: LabelStyle = {
    ...DEFAULT_LAYER_STYLE.labels,
    ...styleValue(layer.style, "labels"),
  };
  if (ctx.lineGap) {
    ensureLineGapLabelLayer(ctx, labels, ctx.lineGap.labels);
    return;
  }
  const dedupedLabelFc = dedupedAttributeLabels(ctx, labels);
  if (
    !layer.style.extrusionEnabled &&
    renderer !== "heatmap" &&
    labels.enabled &&
    (dedupedLabelFc || labels.expression.trim() || labels.field)
  ) {
    const textField = attributeLabelTextField(labels, dedupedLabelFc);
    if (textField === "") {
      // An invalid expression with no field falls back to an empty text-field,
      // which would create an invisible label layer that still consumes
      // renderer resources. Remove it instead of adding an empty one.
      removeIfExists(map, labelLayerId(layer.id));
      removeSourceIfExists(map, labelSourceId(layer.id));
    } else {
      ensureAttributeLabelLayer(ctx, labels, dedupedLabelFc, textField);
    }
  } else {
    removeIfExists(map, labelLayerId(layer.id));
    removeSourceIfExists(map, labelSourceId(layer.id));
  }
}

/**
 * The aggregated one-label-per-location features for a unique/concatenate
 * label dedupe, or null when the layer does not dedupe its labels.
 */
function dedupedAttributeLabels(
  ctx: VectorRenderContext,
  labels: LabelStyle,
): ReturnType<typeof getDedupedLabelFeatures> | null {
  const { layer, profile, sourceLayer, hasFeatureFilter } = ctx;
  // Unique/concatenate labels collapse co-located points into a single label.
  // Only the inline GeoJSON path (no source-layer) can build the aggregated
  // source, and dedup keys off the field value rather than the expression. It is
  // gated to point-only layers: the aggregated source holds just points, so a
  // mixed-geometry layer would silently lose its line/polygon labels. It is also
  // skipped while a Time Slider filter or a rule-based visibility filter is
  // active (`hasFeatureFilter`, computed in applyVectorDataRenderLayers): the
  // aggregated source is built from the raw features (no MapLibre filter
  // applies to it), so dedup labels would otherwise ignore the time window /
  // hidden features and disagree with the visible data.
  return labels.enabled &&
    labels.dedupe !== "off" &&
    !sourceLayer &&
    !hasFeatureFilter &&
    layer.geojson &&
    labels.field &&
    profile.hasPoint &&
    !profile.hasLine &&
    !profile.hasPolygon
    ? getDedupedLabelFeatures(layer.geojson, labels)
    : null;
}

/**
 * The one-label-per-polygon points for a point-placed label on a layer with
 * polygons, or null when MapLibre's own placement applies: the option is off,
 * the labels follow lines, or the features are not inline GeoJSON (a
 * GeoArrow-only layer has no feature collection to derive points from).
 * Attribute filters need no gating here (unlike dedup) because each point
 * keeps its feature's properties, so the label layer's filter still evaluates
 * on it. Past MAX_POLYGON_LABEL_FEATURES polygons it is null too (the search
 * would stall the first draw). Geometry-dependent filters and expressions
 * keep MapLibre's placement: a derived Point can have a different geometry
 * type, containment, or distance result than the original polygon.
 */
function onePerPolygonLabelPoints(
  ctx: VectorRenderContext,
  labels: LabelStyle,
): FeatureCollection | null {
  const { layer, profile } = ctx;
  if (
    labels.onePerPolygon === false ||
    labels.placement !== "point" ||
    !profile.hasPolygon ||
    !layer.geojson
  ) {
    return null;
  }
  return readsFeatureGeometry(layer, labels) ? null : polygonLabelPoints(layer.geojson);
}

/**
 * Whether the label layer's filter or any label expression reads the feature's
 * geometry type, containment, or distance. These must evaluate on the original
 * geometry rather than on a derived label anchor.
 */
function readsFeatureGeometry(layer: GeoLibreLayer, labels: LabelStyle): boolean {
  const sources = [
    JSON.stringify(withFeatureFilters(layer, ["all"] as unknown as maplibregl.FilterSpecification)),
    labels.expression,
    labels.sizeExpression,
    labels.colorExpression,
    labels.opacityExpression,
    labels.visibilityExpression,
    labels.priorityExpression,
  ];
  return sources.some((text) => {
    // Escaped operator names must still be parsed (for example \u0064istance).
    if (!text || !/geometry-type|\$type|within|distance|\\/.test(text)) return false;
    let expression: unknown;
    try {
      expression = JSON.parse(removeTrailingJsonCommas(text));
    } catch {
      return false;
    }
    const pending = [expression];
    while (pending.length) {
      const current = pending.pop();
      if (!Array.isArray(current) || current[0] === "literal") continue;
      const operator = current[0];
      if (operator === "geometry-type" || operator === "within" || operator === "distance")
        return true;
      if (operator === "semiliteral" && Array.isArray(current[1])) {
        for (const item of current[1]) pending.push(item);
        continue;
      }
      if (
        current[1] === "$type" &&
        ["==", "!=", ">", ">=", "<", "<=", "in", "!in", "has", "!has"].includes(operator)
      )
        return true;
      for (let i = 1; i < current.length; i++) {
        // Match labels are literal arrays, unlike its input and outputs.
        if (operator === "match" && i >= 2 && i < current.length - 1 && i % 2 === 0) continue;
        if (
          operator === "format" &&
          current[i] &&
          !Array.isArray(current[i]) &&
          typeof current[i] === "object"
        ) {
          for (const key of ["font-scale", "text-font", "text-color", "vertical-align"]) {
            if (Array.isArray(current[i][key])) pending.push(current[i][key]);
          }
        }
        if (Array.isArray(current[i])) pending.push(current[i]);
      }
    }
    return false;
  });
}

/**
 * The label layer's `text-field`: the aggregated label on the dedup source,
 * else the parsed label expression, else the field. An empty string means
 * there is nothing to label.
 */
function attributeLabelTextField(
  labels: LabelStyle,
  dedupedLabelFc: ReturnType<typeof getDedupedLabelFeatures> | null,
): maplibregl.ExpressionSpecification | string {
  const fieldTextField = labelFieldTextField(labels, documentLocale()) as unknown as
    | maplibregl.ExpressionSpecification
    | string;
  let textField: maplibregl.ExpressionSpecification | string;
  if (dedupedLabelFc) {
    // The aggregated source carries the resolved label in `__geolibre_label`.
    textField = ["get", DEDUPED_LABEL_PROPERTY] as unknown as maplibregl.ExpressionSpecification;
  } else {
    try {
      if (labels.expression.trim()) {
        const parsed = JSON.parse(labels.expression);
        // JSON.parse accepts non-expressions (numbers, objects, null); only an
        // array is a usable MapLibre expression, so reject anything else and
        // fall back to the field.
        if (!Array.isArray(parsed)) throw new Error("not an expression");
        textField = parsed as maplibregl.ExpressionSpecification;
      } else {
        textField = fieldTextField;
      }
    } catch {
      // A typo'd or non-expression value must not break the whole layer sync.
      textField = fieldTextField;
    }
  }
  return textField;
}

// Canvas used to measure label widths for line-gap placement.
let measureContext: CanvasRenderingContext2D | null | undefined;

/**
 * Width of a label in pixels at `size`. MapLibre draws with the style's glyph
 * font, which is not available to the canvas, so a sans-serif stand-in is
 * measured; without a DOM (tests, workers) a per-character estimate is used.
 */
function measureLabelText(text: string, size: number): number {
  if (measureContext === undefined) {
    try {
      measureContext =
        typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
    } catch {
      measureContext = null;
    }
  }
  if (!measureContext) return text.length * size * 0.6;
  measureContext.font = `${size}px "Open Sans", "Noto Sans", Arial, sans-serif`;
  return measureContext.measureText(text).width;
}

/** A layer's effective label settings. */
function layerLabelStyle(layer: GeoLibreLayer): LabelStyle {
  return { ...DEFAULT_LAYER_STYLE.labels, ...styleValue(layer.style, "labels") };
}

/**
 * The label zoom range, as the label layers apply it: the label's own range
 * intersected with the layer's style range.
 */
function labelZoomRange(
  labels: LabelStyle,
  style: LayerStyle,
): { minzoom: number; maxzoom: number } {
  return intersectZoomRange(
    {
      minzoom: clampLayerZoom(labels.minZoom, MIN_LAYER_ZOOM),
      maxzoom: clampLayerZoom(labels.maxZoom, MAX_LAYER_ZOOM),
    },
    style,
  );
}

function lineGapWanted(labels: LabelStyle): boolean {
  return (
    labels.enabled &&
    labels.placement === "line" &&
    labels.lineGap === true &&
    Boolean(labels.expression.trim() || labels.field) &&
    // The gap is cut at one size per label, so a size expression (which can
    // vary per feature) keeps the ordinary line labels.
    !parseLabelOverride(labels.sizeExpression, "number") &&
    // Placement gives space to features in source order, so a priority
    // expression (lower value placed first) keeps the ordinary labels too.
    !parseLabelOverride(labels.priorityExpression, "number") &&
    // Duplicate-label collapsing builds its own label points, which gap
    // placement would bypass.
    labels.dedupe === "off" &&
    // Placement evaluates visibility at its half-zoom bucket, while the label
    // filter reads the live zoom; a zoom-dependent visibility could hide a
    // label whose gap is already cut.
    !/"zoom"/.test(labels.visibilityExpression)
  );
}

/**
 * Whether a layer's labels cut gaps in its lines, given its geometry. Only
 * line-only layers on the inline GeoJSON path take it: the cut lines replace
 * the source's features, which a point or polygon in the same source must not
 * see, and the tiled path cuts its tiles once, not per zoom. Layers with an
 * active feature filter keep ordinary labels too: MapLibre applies filters
 * after collision, so a hidden line could take the spot of a visible line's
 * label (the derived-symbology rule). Shared by the placement and the
 * zoom-resync predicate so the two cannot drift.
 */
function lineGapApplies(
  layer: GeoLibreLayer,
  profile: ReturnType<typeof detectGeometryProfile>,
): boolean {
  const { renderer, wantCluster } = resolveVectorRenderMode(layer, profile);
  return (
    !wantCluster &&
    renderer !== "heatmap" &&
    !layer.style.extrusionEnabled &&
    profile.hasLine &&
    !profile.hasPoint &&
    !profile.hasPolygon &&
    !layerHasFeatureFilter(layer)
  );
}

/**
 * The contour-style placement for a layer whose line labels cut gaps in
 * their lines ({@link LabelStyle.lineGap}), or null when it does not apply.
 * The placement is computed for the map's zoom bucket; the controller resyncs
 * on `zoomend` while such a layer exists ({@link hasLineGapLabels}). Outside
 * the label's zoom range nothing is cut, so the line shows whole.
 */
export function lineGapPlacement(
  map: maplibregl.Map,
  layer: GeoLibreLayer,
  profile: ReturnType<typeof detectGeometryProfile>,
): LineGapLabelResult | null {
  const labels = layerLabelStyle(layer);
  if (!layer.geojson || !lineGapWanted(labels) || !lineGapApplies(layer, profile)) {
    return null;
  }
  // The live zoom, not the placement bucket, decides whether the labels show.
  const zoom = map.getZoom();
  const range = labelZoomRange(labels, layer.style);
  if (zoom < range.minzoom || zoom >= range.maxzoom) return null;
  const textField = attributeLabelTextField(labels, null);
  if (textField === "") return null;
  const size = Math.max(1, labels.size);
  return getLineGapLabels(layer.geojson, labels, textField, zoom, (text) =>
    measureLabelText(text, size),
  );
}

/**
 * Whether any layer draws contour-style gap labels, whose placement depends
 * on the zoom and so needs a resync when the zoom changes.
 */
export function hasLineGapLabels(layers: readonly GeoLibreLayer[]): boolean {
  return layers.some((layer) => {
    if (layer.type !== "geojson" || !layer.visible || !layer.geojson) return false;
    const labels = layerLabelStyle(layer);
    // Check the cheap label settings first; the profile walks every feature.
    return lineGapWanted(labels) && lineGapApplies(layer, detectGeometryProfile(layer.geojson));
  });
}

/**
 * The label layer for contour-style gap labels: one point per gap, its text
 * and rotation precomputed, always drawn (the gap is already cut, so a label
 * hidden by collision would leave an empty hole; placement already avoided
 * overlaps).
 */
function ensureLineGapLabelLayer(
  ctx: VectorRenderContext,
  labels: LabelStyle,
  points: GeoJSON,
): void {
  const { map, layer, beforeId, visibility, opacity } = ctx;
  const pointSourceId = labelSourceId(layer.id);
  const existingSource = map.getSource(pointSourceId) as maplibregl.GeoJSONSource | undefined;
  if (existingSource) {
    setGeoJsonData(existingSource, points);
  } else {
    map.addSource(pointSourceId, { type: "geojson", data: points });
    rememberGeoJsonData(map, pointSourceId, points);
  }
  const existingLabel = map.getLayer(labelLayerId(layer.id)) as { source?: string } | undefined;
  if (existingLabel && existingLabel.source !== pointSourceId) {
    removeIfExists(map, labelLayerId(layer.id));
  }
  const labelZoom = labelZoomRange(labels, layer.style);
  // Label points copy their line's attributes, so the visibility override and
  // the layer's feature filters apply to them as to the lines.
  const { labelBaseFilter, colorOverride, opacityOverride } = attributeLabelOverrides(labels, null);
  ensureLayer(
    map,
    labelLayerId(layer.id),
    {
      id: labelLayerId(layer.id),
      type: "symbol",
      source: pointSourceId,
      ...labelZoom,
      filter: withFeatureFilters(layer, labelBaseFilter),
      layout: {
        "text-field": ["get", LINE_GAP_TEXT_PROPERTY],
        "text-font": textFontForMapStyle(map),
        "text-size": Math.max(1, labels.size),
        "symbol-placement": "point",
        "text-allow-overlap": true,
        "text-ignore-placement": true,
        "text-anchor": "center",
        "text-offset": [0, 0],
        "text-rotate": ["get", LINE_GAP_ANGLE_PROPERTY],
        "text-rotation-alignment": "map",
        "text-max-width": 1000,
        "text-transform": labels.transform,
        visibility,
      },
      paint: {
        "text-color": colorOverride ?? labels.color,
        "text-halo-color": labels.haloColor,
        "text-halo-width": Math.max(0, labels.haloWidth),
        "text-opacity": opacityOverride ?? opacity,
      },
    },
    beforeId,
  );
}

/**
 * Create/update the attribute label layer (and, for deduped labels, its
 * aggregated source), then drop the dedup source once nothing references it.
 */
function ensureAttributeLabelLayer(
  ctx: VectorRenderContext,
  labels: LabelStyle,
  dedupedLabelFc: ReturnType<typeof getDedupedLabelFeatures> | null,
  textField: maplibregl.ExpressionSpecification | string,
): void {
  const { map, layer, src, sourceSpec, beforeId, visibility, opacity } = ctx;
  const labelZoom = intersectZoomRange(
    {
      minzoom: clampLayerZoom(labels.minZoom, MIN_LAYER_ZOOM),
      maxzoom: clampLayerZoom(labels.maxZoom, MAX_LAYER_ZOOM),
    },
    layer.style,
  );
  const dedupSourceId = labelSourceId(layer.id);
  // One label point per polygon feature (GH discussion #3554). Unlike the
  // dedup source, these points keep every feature's id and properties, so the
  // layer filters and data-defined overrides below still apply to them.
  const polygonLabelFc = dedupedLabelFc ? null : onePerPolygonLabelPoints(ctx, labels);
  // The aggregated (or one-per-polygon) label features live in their own
  // GeoJSON source so the symbol layer can read them without altering the
  // data the other render layers draw.
  const ownLabelFc = dedupedLabelFc ?? polygonLabelFc;
  if (ownLabelFc) {
    if (map.getSource(dedupSourceId)) {
      setGeoJsonData(map.getSource(dedupSourceId) as maplibregl.GeoJSONSource, ownLabelFc);
    } else {
      map.addSource(dedupSourceId, {
        type: "geojson",
        data: ownLabelFc,
      });
      rememberGeoJsonData(map, dedupSourceId, ownLabelFc);
    }
  }
  // A layer's source is immutable, so when the label source switches between
  // the shared source and the label source the layer must be recreated.
  const targetSource = ownLabelFc ? dedupSourceId : src;
  const existingLabel = map.getLayer(labelLayerId(layer.id)) as { source?: string } | undefined;
  if (existingLabel && existingLabel.source !== targetSource) {
    removeIfExists(map, labelLayerId(layer.id));
  }
  const { labelBaseFilter, sizeOverride, colorOverride, opacityOverride, priorityOverride } =
    attributeLabelOverrides(labels, dedupedLabelFc);
  const sourceRef = ownLabelFc ? { source: dedupSourceId } : sourceSpec;
  ensureLayer(
    map,
    labelLayerId(layer.id),
    {
      id: labelLayerId(layer.id),
      type: "symbol",
      ...sourceRef,
      ...labelZoom,
      // The deduped points carry only the aggregated label, so no filter
      // applies to them. `undefined` (not an absent key) clears a filter left
      // by one-per-polygon points, which share the same label source.
      filter: dedupedLabelFc ? undefined : withFeatureFilters(layer, labelBaseFilter),
      layout: {
        "text-field": textField,
        "text-font": textFontForMapStyle(map),
        "text-size": sizeOverride ?? Math.max(1, labels.size),
        // The dedup source is points, so it cannot use line placement.
        "symbol-placement": !dedupedLabelFc && labels.placement === "line" ? "line" : "point",
        // Only line placement repeats labels; point labels leave it unset.
        ...(!dedupedLabelFc && labels.placement === "line"
          ? {
              "symbol-spacing": Math.max(
                1,
                labels.lineSpacing ?? DEFAULT_LAYER_STYLE.labels.lineSpacing,
              ),
            }
          : {}),
        "text-allow-overlap": labels.allowOverlap,
        "text-ignore-placement": labels.allowOverlap,
        "text-anchor": labels.anchor,
        "text-offset": [labels.offsetX, labels.offsetY],
        "text-rotate": labels.rotation,
        "text-max-width": Math.max(1, labels.maxWidth),
        "text-transform": labels.transform,
        // Lower sort keys place first, so they win when space is tight.
        // Without an explicit priority, one-per-polygon labels place the
        // largest polygons first, so a country is not crowded out by its
        // smaller neighbours now that it has a single label candidate. Only
        // on polygon-only layers: in a mixed layer the polygon labels would
        // otherwise all jump ahead of the point and line labels.
        // `null` resets a previously applied priority (stripped on first
        // add by ensureLayer).
        "symbol-sort-key": (priorityOverride ??
          (polygonLabelFc && !ctx.profile.hasPoint && !ctx.profile.hasLine
            ? ["-", ["coalesce", ["get", POLYGON_LABEL_AREA_PROPERTY], 0]]
            : null)) as unknown as PropertyValueSpecification<number>,
        visibility,
      },
      paint: {
        "text-color": colorOverride ?? labels.color,
        "text-halo-color": labels.haloColor,
        "text-halo-width": Math.max(0, labels.haloWidth),
        // The opacity override replaces the layer opacity rather than
        // multiplying into it: wrapping the expression would invalidate
        // top-level `["zoom"]` interpolations.
        "text-opacity": opacityOverride ?? opacity,
      },
    },
    beforeId,
  );
  // Drop the label source once the label layer no longer references it (it is
  // recreated on the shared source above before this runs).
  if (!ownLabelFc) {
    removeSourceIfExists(map, dedupSourceId);
  }
}

/**
 * The label layer's base filter and its data-defined overrides (GH #1320),
 * each null when unset or invalid.
 */
function attributeLabelOverrides(
  labels: LabelStyle,
  dedupedLabelFc: ReturnType<typeof getDedupedLabelFeatures> | null,
) {
  // Skip geoman text-marker points (they carry their own annotation text),
  // reusing the same two-property predicate the circle/text layers use. The
  // dedup source holds only synthetic points, so it needs neither that
  // filter nor the time filter.
  const nonMarkerFilter = ["!", textMarkerShapeFilter] as unknown as maplibregl.FilterSpecification;
  // Data-defined overrides (GH #1320): expression-driven size / color /
  // opacity, per-feature placement priority (symbol-sort-key), and
  // attribute-gated visibility. They read source feature attributes, so
  // they are skipped on the dedup path, whose synthetic features carry
  // only the aggregated label value. An override that is invalid for its
  // destination — malformed JSON, not an expression, or the wrong result
  // type — parses to null and falls back to the literal control; the
  // style-spec check matters because addLayer validates the whole layer
  // spec, so an unchecked type-mismatched value would reject the entire
  // label layer on first add rather than just that property.
  const labelOverride = (source: string, expectedType: "number" | "color" | "boolean") =>
    (dedupedLabelFc
      ? null
      : parseLabelOverride(source, expectedType)) as maplibregl.ExpressionSpecification | null;
  const sizeOverride = labelOverride(labels.sizeExpression, "number");
  const colorOverride = labelOverride(labels.colorExpression, "color");
  const opacityOverride = labelOverride(labels.opacityExpression, "number");
  const priorityOverride = labelOverride(labels.priorityExpression, "number");
  const visibilityOverride = labelOverride(labels.visibilityExpression, "boolean");
  // The visibility expression joins the marker exclusion before the
  // layer-wide feature filters, so a feature evaluating false simply gets
  // no label.
  const labelBaseFilter = visibilityOverride
    ? (["all", nonMarkerFilter, visibilityOverride] as unknown as maplibregl.FilterSpecification)
    : nonMarkerFilter;
  return { labelBaseFilter, sizeOverride, colorOverride, opacityOverride, priorityOverride };
}
