// GeoJSON / geojson-vt data layers and their polygon, line, point and geometry-generator render layers.

import {
  DEFAULT_LAYER_STYLE,
  generatorCircleRadiusValue,
  styleValue,
  type GeoLibreLayer,
} from "@geolibre/core";
import { GEOMAN_TEXT_PROPERTY } from "./label-style";
import { flatExtrusionCutoff, hasTextMarkerFeatures } from "./symbology-shared";
import { authoredClusterInput, resolveVectorRenderMode } from "./cluster-input";
import type * as maplibregl from "maplibre-gl";
import type { DataDrivenPropertyValueSpecification, PropertyValueSpecification } from "maplibre-gl";
import {
  ensureGeoJsonVtProtocol,
  geojsonVtTileUrl,
  hasGeoJsonVtSource,
  registerGeoJsonVtSource,
  TILE_MAX_ZOOM,
  TILE_SOURCE_LAYER,
  unregisterGeoJsonVtSource,
} from "./geojson-vt-protocol";
import {
  circleLayerId,
  clusterCountLayerId,
  clusterLayerId,
  detectGeometryProfile,
  fillExtrusionLayerId,
  fillLayerId,
  generatorCircleLayerId,
  generatorFillLayerId,
  generatorLineLayerId,
  generatorSourceId,
  heatmapLayerId,
  invertedFillLayerId,
  invertedSourceId,
  lineDecorationLayerId,
  lineLayerId,
  markerLayerId,
  sourceId,
  textLayerId,
} from "./geojson-loader";
import {
  buildGeneratedGeometry,
  buildInvertedMask,
  generatedGeometryKinds,
} from "./derived-geometry";
import { ensureGeneratedImageHandler } from "./generated-images";
import { prepareFillPattern } from "./fill-patterns";
import { prepareLineDecoration } from "./line-decorations";
import {
  KML_ICON_URL_PROPERTY,
  markerImageValue,
  markerIconSizeValue,
  prepareKmlFeatureIcons,
} from "./markers";
import {
  circlePaint,
  clusterCirclePaint,
  fillExtrusionPaint,
  fillPaint,
  heatmapPaint,
  heatmapWeightMax,
  linePaint,
} from "./style-mapper";
import type { LineGapLabelResult } from "./line-gap-labels";
import {
  pointGeometryFilter,
  textMarkerFilter,
  nonTextMarkerPointFilter,
  unclusteredPointFilter,
  layerHasFeatureFilter,
  withFeatureFilters,
  rememberGeoJsonData,
  setGeoJsonData,
  styleLayerZoomRange,
  stringSource,
  type VectorRenderContext,
  removeSourceIfExists,
  textFontForMapStyle,
  ensureLayer,
  removeIfExists,
  rememberGeoJsonSourceClusterState,
  forgetGeoJsonSourceClusterState,
  geojsonSourceClusterState,
  removeGeoJsonRenderLayers,
} from "./layer-sync-common";
import { applyAttributeLabelLayer, lineGapPlacement } from "./layer-sync-labels";

export function syncGeoJsonLayer(
  map: maplibregl.Map,
  layer: GeoLibreLayer,
  beforeId?: string,
): void {
  const src = sourceId(layer.id);
  const profile = detectGeometryProfile(layer.geojson!);
  const { renderer, wantCluster, clusterRadius, clusterMaxZoom } = resolveVectorRenderMode(
    layer,
    profile,
  );
  const lineGap = wantCluster ? null : lineGapPlacement(map, layer, profile);
  const sourceGeoJson = wantCluster
    ? authoredClusterInput(layer, map.getZoom())
    : (lineGap?.lines ?? layer.geojson!);

  // A layer can drop below the tiling threshold (e.g. a processing tool shrinks
  // it), or some other code may have left a non-geojson source under this id.
  // Either way it must be removed before the inline path's setData runs, since
  // setData only works on a geojson source. Only free a tile index we actually
  // own (unregister is otherwise a harmless no-op).
  const existingSource = map.getSource(src) as maplibregl.Source | undefined;
  if (existingSource && existingSource.type !== "geojson") {
    removeGeoJsonRenderLayers(map, layer.id);
    map.removeSource(src);
    forgetGeoJsonSourceClusterState(map, src);
    if (hasGeoJsonVtSource(layer.id)) unregisterGeoJsonVtSource(layer.id, map);
  }

  // Clustering is a source-level option, so toggling it (or changing its params)
  // means recreating the source — which first requires dropping every layer that
  // references it. MapLibre forbids removing a source still in use.
  const existingCluster = geojsonSourceClusterState(map, src);
  const needsSourceRecreate =
    existingCluster !== null &&
    (existingCluster.cluster !== wantCluster ||
      (wantCluster &&
        (existingCluster.radius !== clusterRadius || existingCluster.maxZoom !== clusterMaxZoom)));
  if (needsSourceRecreate) {
    removeGeoJsonRenderLayers(map, layer.id);
    map.removeSource(src);
    forgetGeoJsonSourceClusterState(map, src);
  }

  if (!map.getSource(src)) {
    // Carry a source attribution (e.g. an ArcGIS service's copyrightText) into
    // MapLibre's attribution control when the layer declares one.
    const attribution = stringSource(layer.source.attribution);
    map.addSource(
      src,
      wantCluster
        ? {
            type: "geojson",
            data: sourceGeoJson,
            cluster: true,
            clusterRadius,
            clusterMaxZoom,
            ...(attribution ? { attribution } : {}),
          }
        : {
            type: "geojson",
            data: sourceGeoJson,
            ...(attribution ? { attribution } : {}),
          },
    );
    rememberGeoJsonSourceClusterState(map, src, {
      cluster: wantCluster,
      radius: wantCluster ? clusterRadius : DEFAULT_LAYER_STYLE.clusterRadius,
      maxZoom: wantCluster ? clusterMaxZoom : DEFAULT_LAYER_STYLE.clusterMaxZoom,
    });
    rememberGeoJsonData(map, src, sourceGeoJson);
  } else {
    setGeoJsonData(map.getSource(src) as maplibregl.GeoJSONSource, sourceGeoJson);
  }

  applyVectorDataRenderLayers(map, layer, src, profile, renderer, beforeId, undefined, lineGap);
}

/**
 * Render local vector layers above {@link LARGE_VECTOR_FEATURE_THRESHOLD}
 * features through client-side vector tiles instead of one in-memory geojson
 * source. Reuses the same source id and render-layer ids as
 * {@link syncGeoJsonLayer}; only the source becomes `type:"vector"` (its tiles
 * served by the geojson-vt protocol) and render layers carry a `source-layer`.
 */
export function syncGeoJsonVtLayer(
  map: maplibregl.Map,
  layer: GeoLibreLayer,
  beforeId?: string,
): void {
  const src = sourceId(layer.id);
  const data = layer.geoarrow ?? layer.geojson!;
  const profile = detectGeometryProfile(data);
  const { renderer, wantCluster, clusterRadius, clusterMaxZoom } = resolveVectorRenderMode(
    layer,
    profile,
  );
  const sourceData = wantCluster ? authoredClusterInput(layer, map.getZoom()) : data;

  ensureGeoJsonVtProtocol();

  // (Re)build the tile index when the data or clustering config changed. A
  // rebuild also means cached tiles are stale, so drop the source to force
  // MapLibre to refetch them.
  const rebuilt = registerGeoJsonVtSource(
    layer.id,
    sourceData,
    {
      cluster: wantCluster,
      clusterRadius,
      clusterMaxZoom,
    },
    map,
  );

  const existing = map.getSource(src) as maplibregl.Source | undefined;
  // The source must be recreated when switching in from the inline geojson path
  // (different source type) or when the index was rebuilt.
  if (existing && (existing.type !== "vector" || rebuilt)) {
    removeGeoJsonRenderLayers(map, layer.id);
    map.removeSource(src);
    forgetGeoJsonSourceClusterState(map, src);
  }

  if (!map.getSource(src)) {
    map.addSource(src, {
      type: "vector",
      tiles: [geojsonVtTileUrl(layer.id)],
      minzoom: 0,
      maxzoom: TILE_MAX_ZOOM,
    });
  }

  applyVectorDataRenderLayers(map, layer, src, profile, renderer, beforeId, TILE_SOURCE_LAYER);
}

/**
 * Create/update the fill, line, circle, heatmap, cluster, and text render layers
 * for a vector data layer. Shared by the inline geojson path
 * ({@link syncGeoJsonLayer}, `sourceLayer` undefined) and the tiled path
 * ({@link syncGeoJsonVtLayer}, `sourceLayer` set), which differ only in whether
 * the underlying source is a geojson source or a vector-tile source. When
 * `sourceLayer` is provided, every render layer references it via `source-layer`.
 *
 * The steps run in a fixed order — polygons, lines, line decorations, points,
 * text markers, attribute labels, then the geometry generator — because each
 * newly added render layer is inserted below `beforeId`, so the order they are
 * first added in is the order they stack in.
 */
function applyVectorDataRenderLayers(
  map: maplibregl.Map,
  layer: GeoLibreLayer,
  src: string,
  profile: ReturnType<typeof detectGeometryProfile>,
  renderer: string,
  beforeId?: string,
  sourceLayer?: string,
  lineGap: LineGapLabelResult | null = null,
): void {
  const sourceSpec: { source: string; "source-layer"?: string } = sourceLayer
    ? { source: src, "source-layer": sourceLayer }
    : { source: src };

  const visibility = layer.visible ? "visible" : "none";
  const opacity = layer.opacity;
  const hasTextMarkers = hasTextMarkerFeatures(layer.geojson!);
  // Lazy sprite generation for fill patterns and marker icons relies on the
  // map's styleimagemissing handler being installed before any layer references
  // a generated image id.
  ensureGeneratedImageHandler(map);
  const fillPatternId = prepareFillPattern(layer.style);
  // markerImageValue resolves the same base marker internally, so it is null
  // exactly when no marker applies — no separate prepareMarker call is needed.
  const markerImage = markerImageValue(layer.style);
  const kmlIconImage = prepareKmlFeatureIcons(layer.geojson!, markerImage ?? "");
  // Derived companion symbology (inverted mask, geometry generator, dedup
  // labels) is built from the raw features, so no MapLibre filter applies to
  // it. While a Time Slider window or a rule-based visibility filter is
  // active, those derivations would disagree with the visible data — skip
  // them for the duration, mirroring the dedup-label behavior.
  const hasFeatureFilter = layerHasFeatureFilter(layer);

  const ctx: VectorRenderContext = {
    map,
    layer,
    src,
    sourceSpec,
    sourceLayer,
    profile,
    renderer,
    beforeId,
    visibility,
    opacity,
    hasTextMarkers,
    hasFeatureFilter,
    lineGap,
  };

  applyPolygonRenderLayers(ctx, fillPatternId);
  applyLineRenderLayer(ctx);
  applyLineDecorationLayer(ctx);
  applyPointRenderLayers(ctx, markerImage, kmlIconImage);
  applyTextMarkerLayer(ctx);
  applyAttributeLabelLayer(ctx);
  applyGeometryGeneratorLayers(map, layer, visibility, opacity, hasFeatureFilter, beforeId);
}

/**
 * Polygon render layers: a flat fill (or its inverted mask) or a 3D
 * extrusion, whichever the style asks for, and the removal of every polygon
 * layer the current style or geometry no longer uses.
 */
function applyPolygonRenderLayers(
  ctx: VectorRenderContext,
  fillPatternId: ReturnType<typeof prepareFillPattern>,
): void {
  const { map, layer, profile } = ctx;
  if (profile.hasPolygon) {
    if (layer.style.extrusionEnabled) {
      applyExtrudedPolygonLayers(ctx, fillPatternId);
    } else {
      applyFlatPolygonFillLayers(ctx, fillPatternId);
    }
  } else {
    removeIfExists(map, fillLayerId(layer.id));
    removeIfExists(map, fillExtrusionLayerId(layer.id));
  }
  if (
    !profile.hasPolygon ||
    layer.style.extrusionEnabled ||
    !styleValue(layer.style, "invertedFillEnabled")
  ) {
    removeIfExists(map, invertedFillLayerId(layer.id));
    removeSourceIfExists(map, invertedSourceId(layer.id));
  }
}

/**
 * The extruded polygon path: a `fill-extrusion` layer, plus a flat fill for
 * the zoom range below the style's flat-extrusion cutoff when it has one.
 */
function applyExtrudedPolygonLayers(
  ctx: VectorRenderContext,
  fillPatternId: ReturnType<typeof prepareFillPattern>,
): void {
  const { map, layer, sourceSpec, beforeId, visibility, opacity } = ctx;
  const zoomRange = styleLayerZoomRange(layer.style);
  const flatBelowZoom = flatExtrusionCutoff(layer.style);
  const hasFlatRange = flatBelowZoom !== null && zoomRange.minzoom < flatBelowZoom;
  if (hasFlatRange) {
    ensureLayer(
      map,
      fillLayerId(layer.id),
      {
        id: fillLayerId(layer.id),
        type: "fill",
        ...sourceSpec,
        minzoom: zoomRange.minzoom,
        maxzoom: Math.min(zoomRange.maxzoom, flatBelowZoom),
        filter: withFeatureFilters(layer, [
          "match",
          ["geometry-type"],
          ["Polygon", "MultiPolygon"],
          true,
          false,
        ]),
        paint: {
          ...fillPaint(layer.style, opacity),
          "fill-pattern": (fillPatternId ?? null) as unknown as string,
        },
        layout: { visibility },
      },
      beforeId,
    );
  } else {
    removeIfExists(map, fillLayerId(layer.id));
  }
  ensureLayer(
    map,
    fillExtrusionLayerId(layer.id),
    {
      id: fillExtrusionLayerId(layer.id),
      type: "fill-extrusion",
      ...sourceSpec,
      ...zoomRange,
      ...(flatBelowZoom !== null
        ? {
            minzoom: Math.min(zoomRange.maxzoom, Math.max(zoomRange.minzoom, flatBelowZoom)),
          }
        : {}),
      filter: withFeatureFilters(layer, [
        "match",
        ["geometry-type"],
        ["Polygon", "MultiPolygon"],
        true,
        false,
      ]),
      paint: fillExtrusionPaint(layer.style, opacity),
      layout: { visibility },
    },
    beforeId,
  );
}

/**
 * The flat polygon path: the normal fill layer, or the inverted mask that
 * replaces it when the style asks for an inverted fill and one can be built.
 */
function applyFlatPolygonFillLayers(
  ctx: VectorRenderContext,
  fillPatternId: ReturnType<typeof prepareFillPattern>,
): void {
  const { map, layer, sourceSpec, beforeId, visibility, opacity, hasFeatureFilter } = ctx;
  removeIfExists(map, fillExtrusionLayerId(layer.id));
  const fillPaintSpec = {
    ...fillPaint(layer.style, opacity),
    // A set fill-pattern replaces fill-color with the recolorable
    // sprite tile; null resets it on the setPaintProperty update path in
    // ensureLayer (MapLibre documents null, not undefined, as the value
    // that removes a paint property — undefined can silently no-op and
    // leave a stale pattern rendered after the user selects "None"). The
    // cast is needed because FillLayerSpecification's paint type omits
    // null even though setPaintProperty accepts it as the reset value.
    "fill-pattern": (fillPatternId ?? null) as unknown as string,
  };
  // Inverted fill (QGIS "Inverted polygons"): the mask — everything
  // outside the features — takes the layer's fill, and the normal fill
  // layer is dropped so the features read as holes. The mask derives from
  // the raw features (no MapLibre filter applies to it), so while a
  // time-slider / rule-visibility filter is active — or when the mask
  // cannot be built (no polygons, oversized layer, clipper failure) — it
  // falls back to the normal filtered fill rather than disagreeing with
  // the visible data or rendering nothing.
  const invertedMask =
    styleValue(layer.style, "invertedFillEnabled") && !hasFeatureFilter && layer.geojson
      ? buildInvertedMask(layer.geojson)
      : null;
  if (invertedMask) {
    removeIfExists(map, fillLayerId(layer.id));
    const maskSrc = invertedSourceId(layer.id);
    if (map.getSource(maskSrc)) {
      setGeoJsonData(map.getSource(maskSrc) as maplibregl.GeoJSONSource, invertedMask);
    } else {
      map.addSource(maskSrc, { type: "geojson", data: invertedMask });
      rememberGeoJsonData(map, maskSrc, invertedMask);
    }
    ensureLayer(
      map,
      invertedFillLayerId(layer.id),
      {
        id: invertedFillLayerId(layer.id),
        type: "fill",
        source: maskSrc,
        ...styleLayerZoomRange(layer.style),
        metadata: { "geolibre:internal": true },
        paint: {
          ...fillPaintSpec,
          // The mask's outer ring is the world rectangle; its hairline
          // outline would draw a visible seam at the antimeridian/poles.
          // Hole edges are already outlined by the layer's line layer.
          "fill-outline-color": "rgba(0, 0, 0, 0)",
        },
        layout: { visibility },
      },
      beforeId,
    );
  } else {
    removeIfExists(map, invertedFillLayerId(layer.id));
    removeSourceIfExists(map, invertedSourceId(layer.id));
    ensureLayer(
      map,
      fillLayerId(layer.id),
      {
        id: fillLayerId(layer.id),
        type: "fill",
        ...sourceSpec,
        ...styleLayerZoomRange(layer.style),
        filter: withFeatureFilters(layer, [
          "match",
          ["geometry-type"],
          ["Polygon", "MultiPolygon"],
          true,
          false,
        ]),
        paint: fillPaintSpec,
        layout: { visibility },
      },
      beforeId,
    );
  }
}

/**
 * The line layer: line features, plus polygon outlines unless the polygons
 * are extruded.
 */
function applyLineRenderLayer(ctx: VectorRenderContext): void {
  const { map, layer, profile, sourceSpec, beforeId, visibility, opacity } = ctx;
  if (profile.hasLine || (!layer.style.extrusionEnabled && profile.hasPolygon)) {
    ensureLayer(
      map,
      lineLayerId(layer.id),
      {
        id: lineLayerId(layer.id),
        type: "line",
        ...sourceSpec,
        ...styleLayerZoomRange(layer.style),
        filter: withFeatureFilters(layer, [
          "match",
          ["geometry-type"],
          layer.style.extrusionEnabled
            ? ["LineString", "MultiLineString"]
            : ["LineString", "MultiLineString", "Polygon", "MultiPolygon"],
          true,
          false,
        ]),
        paint: linePaint(layer.style, opacity),
        layout: { visibility },
      },
      beforeId,
    );
  } else {
    removeIfExists(map, lineLayerId(layer.id));
  }
}

/**
 * Line decorations (QGIS marker-line / arrow lines): a symbol layer that
 * repeats the generated decoration icon along line features and polygon
 * outlines. With line placement MapLibre rotates the icon to follow the
 * line, so the arrow shape points along the feature's direction.
 */
function applyLineDecorationLayer(ctx: VectorRenderContext): void {
  const { map, layer, profile, sourceSpec, beforeId, visibility, opacity } = ctx;
  const decorationImageId = prepareLineDecoration(layer.style);
  if (
    !layer.style.extrusionEnabled &&
    decorationImageId &&
    (profile.hasLine || profile.hasPolygon)
  ) {
    ensureLayer(
      map,
      lineDecorationLayerId(layer.id),
      {
        id: lineDecorationLayerId(layer.id),
        type: "symbol",
        ...sourceSpec,
        ...styleLayerZoomRange(layer.style),
        metadata: { "geolibre:internal": true },
        filter: withFeatureFilters(layer, [
          "match",
          ["geometry-type"],
          ["LineString", "MultiLineString", "Polygon", "MultiPolygon"],
          true,
          false,
        ]),
        layout: {
          "icon-image": decorationImageId,
          // The sprite is baked at its display size, matching the marker path.
          "icon-size": 1,
          "symbol-placement": "line",
          "symbol-spacing": Math.max(1, styleValue(layer.style, "lineDecorationSpacing")),
          // Decorations are deliberate symbology, so they must not thin out
          // under MapLibre's collision placement.
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          "icon-rotation-alignment": "map",
          visibility,
        },
        paint: { "icon-opacity": opacity },
      },
      beforeId,
    );
  } else {
    removeIfExists(map, lineDecorationLayerId(layer.id));
  }
}

/**
 * Point render layers for the layer's point renderer — heatmap, cluster, or
 * the single (default) circle / marker renderer — and the removal of every
 * point layer the other renderers own.
 */
function applyPointRenderLayers(
  ctx: VectorRenderContext,
  markerImage: ReturnType<typeof markerImageValue>,
  kmlIconImage: ReturnType<typeof prepareKmlFeatureIcons>,
): void {
  const { map, layer, profile, renderer } = ctx;
  if (profile.hasPoint && renderer === "heatmap") {
    applyHeatmapPointLayer(ctx);
  } else if (profile.hasPoint && renderer === "cluster") {
    applyClusterPointLayers(ctx);
  } else if (profile.hasPoint) {
    applySinglePointLayers(ctx, markerImage, kmlIconImage);
  } else {
    removeIfExists(map, circleLayerId(layer.id));
    removeIfExists(map, markerLayerId(layer.id));
    removeIfExists(map, heatmapLayerId(layer.id));
    removeIfExists(map, clusterLayerId(layer.id));
    removeIfExists(map, clusterCountLayerId(layer.id));
  }
}

/** Heatmap renderer: one density layer, no circle/cluster/marker layers. */
function applyHeatmapPointLayer(ctx: VectorRenderContext): void {
  const { map, layer, sourceSpec, beforeId, visibility, opacity, hasTextMarkers } = ctx;
  removeIfExists(map, circleLayerId(layer.id));
  removeIfExists(map, markerLayerId(layer.id));
  removeIfExists(map, clusterLayerId(layer.id));
  removeIfExists(map, clusterCountLayerId(layer.id));
  ensureLayer(
    map,
    heatmapLayerId(layer.id),
    {
      id: heatmapLayerId(layer.id),
      type: "heatmap",
      ...sourceSpec,
      ...styleLayerZoomRange(layer.style),
      // Keep text-marker points out of the density, mirroring single mode;
      // they still render through the text symbol layer below.
      filter: withFeatureFilters(
        layer,
        hasTextMarkers ? nonTextMarkerPointFilter : pointGeometryFilter,
      ),
      paint: heatmapPaint(layer.style, opacity, heatmapWeightMax(layer.style, layer.geojson)),
      layout: { visibility },
    },
    beforeId,
  );
}

/**
 * Cluster renderer: a bubble + count for aggregated clusters, plus a circle
 * for the individual (unclustered) points. The source carries clusters
 * (geojson source-level clustering, or supercluster tiles on the tiled path).
 */
function applyClusterPointLayers(ctx: VectorRenderContext): void {
  const { map, layer, sourceSpec, beforeId, visibility, opacity, hasTextMarkers } = ctx;
  removeIfExists(map, heatmapLayerId(layer.id));
  removeIfExists(map, markerLayerId(layer.id));
  ensureLayer(
    map,
    clusterLayerId(layer.id),
    {
      id: clusterLayerId(layer.id),
      type: "circle",
      ...sourceSpec,
      ...styleLayerZoomRange(layer.style),
      filter: ["has", "point_count"],
      paint: clusterCirclePaint(layer.style, opacity),
      layout: { visibility },
    },
    beforeId,
  );
  ensureLayer(
    map,
    clusterCountLayerId(layer.id),
    {
      id: clusterCountLayerId(layer.id),
      type: "symbol",
      ...sourceSpec,
      ...styleLayerZoomRange(layer.style),
      filter: ["has", "point_count"],
      layout: {
        "text-field": ["get", "point_count_abbreviated"],
        "text-font": textFontForMapStyle(map),
        "text-size": 12,
        "text-allow-overlap": true,
        "text-ignore-placement": true,
        visibility,
      },
      paint: {
        "text-color": styleValue(layer.style, "textColor"),
        "text-opacity": opacity,
      },
    },
    beforeId,
  );
  ensureLayer(
    map,
    circleLayerId(layer.id),
    {
      id: circleLayerId(layer.id),
      type: "circle",
      ...sourceSpec,
      ...styleLayerZoomRange(layer.style),
      // Unclustered points, excluding text markers (which the symbol layer
      // renders) so they don't also appear as plain circles.
      filter: withFeatureFilters(layer, unclusteredPointFilter(hasTextMarkers)),
      paint: circlePaint(layer.style, opacity),
      layout: { visibility },
    },
    beforeId,
  );
}

/**
 * Single (default) renderer: a marker icon per point when a marker is
 * configured, otherwise one circle per point.
 */
function applySinglePointLayers(
  ctx: VectorRenderContext,
  markerImage: ReturnType<typeof markerImageValue>,
  kmlIconImage: ReturnType<typeof prepareKmlFeatureIcons>,
): void {
  const { map, layer, sourceSpec, beforeId, visibility, opacity, hasTextMarkers } = ctx;
  removeIfExists(map, heatmapLayerId(layer.id));
  removeIfExists(map, clusterLayerId(layer.id));
  removeIfExists(map, clusterCountLayerId(layer.id));
  const pointFilter = withFeatureFilters(
    layer,
    hasTextMarkers ? nonTextMarkerPointFilter : pointGeometryFilter,
  );
  if (markerImage || kmlIconImage) {
    // KML icons without a marker image keep the circle layer for features
    // that have no icon (ensured below), so removing it here would drop and
    // re-add it on every sync.
    if (markerImage) removeIfExists(map, circleLayerId(layer.id));
    ensureLayer(
      map,
      markerLayerId(layer.id),
      {
        id: markerLayerId(layer.id),
        type: "symbol",
        ...sourceSpec,
        ...styleLayerZoomRange(layer.style),
        filter: pointFilter,
        layout: {
          "icon-image": (kmlIconImage ?? markerImage) as PropertyValueSpecification<string>,
          // The sprite is baked at its display size, so icon-size stays 1
          // unless proportional sizing scales it per feature.
          "icon-size": (kmlIconImage
            ? ["case", ["has", KML_ICON_URL_PROPERTY], 1, markerIconSizeValue(layer.style)]
            : markerIconSizeValue(layer.style)) as PropertyValueSpecification<number>,
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          visibility,
        },
        paint: { "icon-opacity": opacity },
      },
      beforeId,
    );
    if (kmlIconImage && !markerImage) {
      // Features without a KML icon still use the ordinary circle renderer.
      ensureLayer(
        map,
        circleLayerId(layer.id),
        {
          id: circleLayerId(layer.id),
          type: "circle",
          ...sourceSpec,
          ...styleLayerZoomRange(layer.style),
          filter: withFeatureFilters(layer, [
            "all",
            hasTextMarkers ? nonTextMarkerPointFilter : pointGeometryFilter,
            ["!", ["has", KML_ICON_URL_PROPERTY]],
          ] as maplibregl.FilterSpecification),
          paint: circlePaint(layer.style, opacity),
          layout: { visibility },
        },
        beforeId,
      );
    }
  } else {
    removeIfExists(map, markerLayerId(layer.id));
    ensureLayer(
      map,
      circleLayerId(layer.id),
      {
        id: circleLayerId(layer.id),
        type: "circle",
        ...sourceSpec,
        ...styleLayerZoomRange(layer.style),
        filter: pointFilter,
        paint: circlePaint(layer.style, opacity),
        layout: { visibility },
      },
      beforeId,
    );
  }
}

/** The geoman text-marker layer: annotation text points render their own text. */
function applyTextMarkerLayer(ctx: VectorRenderContext): void {
  const { map, layer, sourceSpec, beforeId, visibility, opacity, hasTextMarkers } = ctx;
  if (hasTextMarkers) {
    ensureLayer(
      map,
      textLayerId(layer.id),
      {
        id: textLayerId(layer.id),
        type: "symbol",
        ...sourceSpec,
        ...styleLayerZoomRange(layer.style),
        filter: withFeatureFilters(layer, textMarkerFilter),
        layout: {
          "text-allow-overlap": true,
          "text-font": textFontForMapStyle(map),
          "text-field": [
            "to-string",
            ["coalesce", ["get", GEOMAN_TEXT_PROPERTY], ["get", "text"], ""],
          ],
          "text-ignore-placement": true,
          "text-size": Math.max(1, styleValue(layer.style, "textSize")),
          visibility,
        },
        paint: {
          // Honor an optional per-feature `text-color` (used by annotation text
          // labels so each can keep its own color); text markers without it fall
          // back to the layer's text color.
          "text-color": ["coalesce", ["get", "text-color"], styleValue(layer.style, "textColor")],
          "text-halo-color": styleValue(layer.style, "textHaloColor"),
          "text-halo-width": Math.max(0, styleValue(layer.style, "textHaloWidth")),
          "text-opacity": opacity,
        },
      },
      beforeId,
    );
  } else {
    removeIfExists(map, textLayerId(layer.id));
  }
}

/**
 * Geometry generator (QGIS geometry-generator symbol layers): renders each
 * feature's derived geometry — centroid, bounding box, convex hull, or buffer
 * — as extra symbology over the layer's normal rendering, through a companion
 * GeoJSON source. Derived from the raw features (no MapLibre filter applies),
 * so, like dedup labels, it is suppressed while a time-slider /
 * rule-visibility filter is active rather than rendering hidden features.
 */
function applyGeometryGeneratorLayers(
  map: maplibregl.Map,
  layer: GeoLibreLayer,
  visibility: "visible" | "none",
  opacity: number,
  hasFeatureFilter: boolean,
  beforeId?: string,
): void {
  // Match inverted fill and line decorations: no flat companion symbology
  // while the layer renders as a 3D extrusion. The Style Panel hides the
  // generator controls in extrusion mode without resetting the setting, so
  // this guard is what actually turns the layers off.
  const generatorType =
    layer.style.extrusionEnabled || hasFeatureFilter
      ? "none"
      : styleValue(layer.style, "geometryGenerator");
  const generated =
    generatorType !== "none" && layer.geojson
      ? buildGeneratedGeometry(
          layer.geojson,
          generatorType,
          styleValue(layer.style, "geometryGeneratorBufferDistance"),
          styleValue(layer.style, "geometryGeneratorBufferProperty"),
        )
      : null;
  if (!generated || generated.features.length === 0) {
    removeIfExists(map, generatorFillLayerId(layer.id));
    removeIfExists(map, generatorLineLayerId(layer.id));
    removeIfExists(map, generatorCircleLayerId(layer.id));
    removeSourceIfExists(map, generatorSourceId(layer.id));
    return;
  }

  const genSrc = generatorSourceId(layer.id);
  if (map.getSource(genSrc)) {
    setGeoJsonData(map.getSource(genSrc) as maplibregl.GeoJSONSource, generated);
  } else {
    map.addSource(genSrc, { type: "geojson", data: generated });
    rememberGeoJsonData(map, genSrc, generated);
  }

  const kinds = generatedGeometryKinds(generated);
  const fillColor = styleValue(layer.style, "geometryGeneratorFillColor");
  const strokeColor = styleValue(layer.style, "geometryGeneratorStrokeColor");
  const strokeWidth = Math.max(0, styleValue(layer.style, "geometryGeneratorStrokeWidth"));
  const genOpacity =
    Math.min(1, Math.max(0, styleValue(layer.style, "geometryGeneratorOpacity"))) * opacity;

  if (kinds.hasPolygon) {
    ensureLayer(
      map,
      generatorFillLayerId(layer.id),
      {
        id: generatorFillLayerId(layer.id),
        type: "fill",
        source: genSrc,
        ...styleLayerZoomRange(layer.style),
        metadata: { "geolibre:internal": true },
        filter: ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false],
        paint: { "fill-color": fillColor, "fill-opacity": genOpacity },
        layout: { visibility },
      },
      beforeId,
    );
    ensureLayer(
      map,
      generatorLineLayerId(layer.id),
      {
        id: generatorLineLayerId(layer.id),
        type: "line",
        source: genSrc,
        ...styleLayerZoomRange(layer.style),
        metadata: { "geolibre:internal": true },
        filter: ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false],
        paint: {
          "line-color": strokeColor,
          "line-width": strokeWidth,
          "line-opacity": opacity,
        },
        layout: { visibility },
      },
      beforeId,
    );
  } else {
    removeIfExists(map, generatorFillLayerId(layer.id));
    removeIfExists(map, generatorLineLayerId(layer.id));
  }

  if (kinds.hasPoint) {
    ensureLayer(
      map,
      generatorCircleLayerId(layer.id),
      {
        id: generatorCircleLayerId(layer.id),
        type: "circle",
        source: genSrc,
        ...styleLayerZoomRange(layer.style),
        metadata: { "geolibre:internal": true },
        filter: ["match", ["geometry-type"], ["Point", "MultiPoint"], true, false],
        paint: {
          "circle-color": fillColor,
          "circle-radius": generatorCircleRadiusValue(
            layer.style,
          ) as DataDrivenPropertyValueSpecification<number>,
          "circle-opacity": genOpacity,
          "circle-stroke-color": strokeColor,
          "circle-stroke-width": strokeWidth,
          "circle-stroke-opacity": opacity,
        },
        layout: { visibility },
      },
      beforeId,
    );
  } else {
    removeIfExists(map, generatorCircleLayerId(layer.id));
  }
}
