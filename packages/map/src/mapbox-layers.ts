import {
  compileLayerFilters,
  documentLocale,
  generatorCircleRadiusValue,
  labelFieldTextField,
  ruleBasedVisibilityFilter,
  DEFAULT_LAYER_STYLE,
  styleValue,
  type GeoLibreLayer,
} from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import type {
  DataDrivenPropertyValueSpecification,
  LayerSpecification,
  SourceSpecification,
  FilterSpecification,
} from "mapbox-gl";
import {
  circlePaint,
  clusterCirclePaint,
  fillPaint,
  fillExtrusionPaint,
  heatmapPaint,
  linePaint,
  rasterPaint,
} from "./style-mapper";
import { authoredClusterInput, resolveVectorRenderMode } from "./cluster-input";
import {
  buildGeneratedGeometry,
  buildInvertedMask,
  generatedGeometryKinds,
  mapboxRenderableMask,
} from "./derived-geometry";
import { prepareFillPattern } from "./fill-patterns";
import { prepareLineDecoration } from "./line-decorations";
import {
  KML_ICON_URL_PROPERTY,
  markerIconSizeValue,
  markerImageValue,
  prepareKmlFeatureIcons,
} from "./markers";
import { flatExtrusionCutoff, hasTextMarkerFeatures } from "./symbology-shared";
import {
  DEDUPED_LABEL_PROPERTY,
  GEOMAN_TEXT_PROPERTY,
  getDedupedLabelFeatures,
  parseLabelOverride,
  TEXT_MARKER_SHAPE_FILTER,
} from "./label-style";
import { proxyWmsTiles } from "./wms-proxy";
import { arcgisOpacity, arcgisVectorStyle } from "./arcgis-vector-style";
import { mapboxFillLayerId, mapboxLineLayerId, mapboxSourceId } from "./style-layer-ids";
import { detectGeometryProfile, type GeometryProfile } from "./geojson-loader";

export interface MapboxLayerPlan {
  sourceId: string;
  source: SourceSpecification;
  additionalSources?: Record<string, SourceSpecification>;
  layers: LayerSpecification[];
}

/**
 * Whether a compiled style layer draws derived or synthetic features (an
 * inverted-fill mask, generator shapes, decorations, aggregated labels) rather
 * than the layer's own, so identify and selection skip it, as MapLibre's
 * layer-sync marks the same layers.
 */
export function isInternalMapboxLayer(spec: LayerSpecification): boolean {
  return (spec.metadata as Record<string, unknown> | undefined)?.["geolibre:internal"] === true;
}

/** MapLibre's extra compositing properties are not in Mapbox's Style Spec. */
export function mapboxPaint(paint: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(paint).filter(
      ([key, value]) => !key.endsWith("-layer-opacity") && value != null,
    ),
  );
}

function supportedUrl(value: string): boolean {
  return !/^[\w+-]+:/.test(value) || /^(https?:|mapbox:|data:|blob:)/.test(value);
}

/**
 * Whether an inline style's sources all use URLs Mapbox can fetch. GeoLibre's
 * offline basemap builds a `pmtiles://` source, and that protocol is only ever
 * registered with maplibre-gl, so such a style would silently fail to load in
 * a Mapbox pane.
 */
export function styleUsesUnsupportedSource(style: { sources?: object }): boolean {
  return Object.values(style.sources ?? {}).some((source: unknown) => {
    // `data` is a GeoJSON source's external URL when it is a string.
    const { url, tiles, data } = (source ?? {}) as {
      url?: unknown;
      tiles?: unknown;
      data?: unknown;
    };
    const urls = [url, data, ...(Array.isArray(tiles) ? tiles : [])];
    return urls.some((value) => typeof value === "string" && !supportedUrl(value));
  });
}

/**
 * Whether Mapbox can draw a layer through a native plan or a supported plugin.
 * The layer panels use it to badge unsupported layers before the engine's
 * error banner would report them.
 */
export function isMapboxSupportedLayer(layer: GeoLibreLayer): boolean {
  if (isMapboxPluginLayer(layer)) return true;
  const cached = supportedLayerCache.get(layer);
  if (cached !== undefined) return cached;
  let supported = true;
  try {
    compileMapboxLayer(layer);
  } catch {
    supported = false;
  }
  supportedLayerCache.set(layer, supported);
  return supported;
}

/** These plugins own their Mapbox overlays and synchronize the layer store themselves. */
export function isMapboxPluginLayer(layer: GeoLibreLayer): boolean {
  // Drawn by the shared deck.gl overlay (deckgl-viz plugin) and the DuckDB
  // control's own deck overlay; both bind to the Mapbox map directly.
  if (layer.type === "deckgl-viz" && layer.metadata.sourceKind === "deckgl-viz") return true;
  if (layer.type === "duckdb-query" && layer.metadata.sourceKind === "duckdb-query") return true;
  if (layer.metadata.externalNativeLayer === true) {
    // On a renderer switch the Add Vector control first mirrors its persisted
    // source, then asynchronously materializes it as GeoJSON for Mapbox. Until
    // that collection arrives, treat the record as control-owned so Mapbox
    // never tries to parse GeoParquet, GeoPackage, or another source URL as
    // GeoJSON. A later store sync carries `layer.geojson` and takes the normal
    // native compiler path below.
    if (layer.metadata.sourceKind === "maplibre-gl-vector" && !layer.geojson) return true;
    if (layer.type === "lidar" && layer.metadata.sourceKind === "lidar-url") return true;
    // @carbonplan/zarr-layer is a CustomLayerInterface implementation that
    // targets Mapbox GL as well as MapLibre; the Zarr control adds it to
    // whichever map hosts the control.
    if (layer.type === "zarr" && layer.metadata.sourceKind === "zarr-url") return true;
    // The Time Slider dock and the Timelapse control create their own native
    // sources and layers (registered on the mirror as `nativeLayerIds`) and
    // forward the store's visibility/opacity to whatever adapter drew them;
    // the mirrors themselves carry no tiles (`source: { sourceId }` and
    // `source: { providerId }`), so the engine could not compile them anyway.
    if (layer.metadata.sourceKind === "time-slider" || layer.metadata.sourceKind === "timelapse")
      return true;
    // The Overture Maps control adds its PMTiles vector sources and styled
    // layers to whichever map hosts it (mapbox-gl reads the archives through
    // its own tile provider). The store rows only mirror those layers for the
    // Layers panel; their `source.url` names the archive for the record, and
    // compiling it would draw every theme twice.
    if (layer.type === "vector-tiles" && layer.metadata.sourceKind === "overture-maps") return true;
    if (
      layer.type === "3d-tiles" &&
      ["3d-tiles-url", "google-photorealistic-3d-tiles", "arcgis-i3s"].includes(
        String(layer.metadata.sourceKind),
      )
    )
      return true;
  }
  if (
    layer.type === "cog" &&
    layer.metadata.sourceKind === "maplibre-gl-raster" &&
    layer.metadata.externalNativeLayer === true
  )
    return true;
  // A layer a plugin registered as its own native output (the host's
  // `registerExternalNativeLayer`: the Mapillary coverage, the Time Slider's
  // and Timelapse's rasters, ...) whose store record carries nothing the
  // engine could draw itself — no GeoJSON, no tile template, no source URL.
  // The plugin adds those style layers to whichever map hosts it, so the
  // engine only mirrors the store's visibility and opacity onto the native ids
  // (as MapLibre's layer-sync does) instead of failing to compile the record.
  // Records that do carry a drawable source (the vector importer's GeoJSON,
  // Esri Wayback's raster URL, the Web Services' tile templates) still go
  // through the compiler, which adopts their native ids.
  const nativeIds = layer.metadata.nativeLayerIds;
  if (
    layer.metadata.externalNativeLayer === true &&
    Array.isArray(nativeIds) &&
    nativeIds.length > 0 &&
    !hasDrawableSource(layer)
  )
    return true;
  // OpenAerialMap's, Satellite Embeddings' and Fields of the World's search
  // footprints carry their GeoJSON (so the Layers panel can zoom to and restyle
  // them) but the plugin draws the fill and outline itself on whichever map
  // hosts it; compiling the record would paint them twice.
  return (
    layer.type === "geojson" &&
    typeof layer.metadata.sourceKind === "string" &&
    PLUGIN_DRAWN_FOOTPRINT_KINDS.has(layer.metadata.sourceKind) &&
    layer.metadata.externalNativeLayer === true
  );
}

/** `metadata.sourceKind` of search footprints a plugin draws itself. */
const PLUGIN_DRAWN_FOOTPRINT_KINDS = new Set([
  "openaerialmap-footprints",
  "satellite-embeddings-footprints",
  "fields-of-the-world-footprints",
]);

/** Whether the store record alone gives the engine something to draw. */
function hasDrawableSource(layer: GeoLibreLayer): boolean {
  if (layer.geojson) return true;
  const { url, urls, tiles, data } = layer.source as {
    url?: unknown;
    urls?: unknown;
    tiles?: unknown;
    data?: unknown;
  };
  return (
    typeof url === "string" ||
    (Array.isArray(urls) && urls.length > 0) ||
    (Array.isArray(tiles) && tiles.length > 0) ||
    data !== undefined
  );
}

// Store layers are immutable records (every edit creates a new object), so the
// answer is memoized per object: the layer panels ask on every render, and a
// full compile per layer per render would be wasted work.
const supportedLayerCache = new WeakMap<GeoLibreLayer, boolean>();

/** Options the engine derives from the loaded basemap style. */
export interface CompileMapboxLayerOptions {
  /**
   * Font stack for label layers. Mapbox's hosted styles all serve this default
   * from Mapbox's glyph catalog; the engine passes the active basemap's own
   * font instead (`resolveTextFontFromStyleLayers` in text-font.ts) so labels still
   * render on a third-party basemap whose glyphs do not include it.
   */
  textFont?: string[];
  /**
   * The map's current zoom. A clustered layer's authored filters are applied
   * to its source data before clustering (see `authoredClusterInput`), and a
   * filter that reads `["zoom"]` is evaluated at this zoom. Omitted, the
   * clustered source keeps the unfiltered data (a compile-only check).
   */
  zoom?: number;
}

export const DEFAULT_MAPBOX_TEXT_FONT = ["Open Sans Regular"];

/** Store layer types the engine draws as a raster tile source. */
const RASTER_TILE_TYPES = new Set(["raster", "wms", "wmts", "xyz"]);

/** Compile only native Mapbox sources. Never hand MapLibre protocol URLs to its workers. */
export function compileMapboxLayer(
  layer: GeoLibreLayer,
  compileOptions: CompileMapboxLayerOptions = {},
): MapboxLayerPlan {
  const arcgis = arcgisVectorStyle(layer);
  if (arcgis) {
    if (styleUsesUnsupportedSource(arcgis)) {
      throw new Error("MapLibre custom tile protocols are not supported by Mapbox");
    }
    const sources = Object.entries(arcgis.sources).map(([id, original]) => {
      // ArcGIS includes both its REST service URL and resolved tile templates.
      // The service URL is not a Mapbox TileJSON endpoint; use the templates.
      // The Esri SDK always resolves them, so a source without any is a
      // hand-edited project that would only fail later inside Mapbox's worker.
      const source = { ...original };
      if (!("tiles" in source) || !source.tiles?.length) {
        throw new Error(`ArcGIS source "${id}" has no resolved tile templates for Mapbox`);
      }
      delete source.url;
      return [id, source as SourceSpecification] as const;
    });
    const [sourceId, source] = sources[0];
    return {
      sourceId,
      source,
      additionalSources: Object.fromEntries(sources.slice(1)),
      layers: arcgis.layers.map((spec) => {
        const paint = mapboxPaint({ ...spec.paint });
        const properties =
          spec.type === "symbol" ? ["text-opacity", "icon-opacity"] : [`${spec.type}-opacity`];
        for (const property of properties) {
          paint[property] = arcgisOpacity(paint[property], layer.opacity);
        }
        return {
          ...spec,
          paint,
          layout: {
            ...spec.layout,
            visibility: layer.visible ? (spec.layout?.visibility ?? "visible") : "none",
          },
        } as LayerSpecification;
      }),
    };
  }
  // Adopt raster tile layers a plugin control created natively: the shared
  // basemap control, the Web Services panels (FEMA NFHL, NASA Earthdata, ...),
  // Esri Wayback, the USGS LiDAR index. Reusing their native IDs lets store
  // visibility, opacity, removal and a style-reload rebuild work without
  // leaving a second, uncontrolled copy on the map — the contract MapLibre's
  // layer-sync keeps for the same kinds (syncWebServiceTileRasterLayer and
  // friends), so a control that draws on either engine reads the same ids back.
  // The basemap kind is matched by name as well: projects saved before the
  // control flagged its layers as external still carry the native ids.
  const adoptNative =
    RASTER_TILE_TYPES.has(layer.type) &&
    (layer.metadata?.externalNativeLayer === true ||
      layer.metadata?.sourceKind === "maplibre-basemap-control");
  const sourceId =
    adoptNative && typeof layer.metadata?.sourceId === "string"
      ? layer.metadata.sourceId
      : mapboxSourceId(layer.id);
  const nativeIds = adoptNative ? layer.metadata?.nativeLayerIds : undefined;
  const rasterId =
    Array.isArray(nativeIds) && typeof nativeIds[0] === "string"
      ? nativeIds[0]
      : `${sourceId}-raster`;
  const style = { ...DEFAULT_LAYER_STYLE, ...layer.style };
  const layout = { visibility: layer.visible ? ("visible" as const) : ("none" as const) };
  const zoom = { minzoom: style.minZoom, maxzoom: style.maxZoom };
  // An empty array is no filter: the embed API's `setFilter(id, [])` stores
  // one, and as an `all` operand it would be an invalid expression.
  const filters = [
    compileLayerFilters(layer),
    layer.timeFilter,
    layer.embedFilter,
    ruleBasedVisibilityFilter(layer.style),
  ].filter((candidate) => (Array.isArray(candidate) ? candidate.length > 0 : Boolean(candidate)));
  const filter = filters.length ? ["all", ...filters] : null;
  const notPoint = ["match", ["geometry-type"], ["Point", "MultiPoint"], false, true];
  // Which geometry layers to emit. Inline GeoJSON says what it holds, so only
  // the layers its data can draw are added, as MapLibre's layer-sync does: a
  // polygon-only layer gets a fill and an outline, not a circle layer that
  // matches nothing but still shows up in every control that lists style layers
  // (the Layer Swipe panel's "Points" row, #2431). Features that all lack a
  // geometry (a delimited-text table without coordinates) get none of them, as
  // on MapLibre. A collection with no features yet (a new, empty editable
  // layer) and tiled or URL-backed data cannot be inspected here, so they keep
  // all three, each geometry-filtered, and the first drawn feature has a layer.
  const profile: GeometryProfile = layer.geojson?.features?.length
    ? detectGeometryProfile(layer.geojson)
    : { hasPoint: true, hasLine: true, hasPolygon: true };
  // The point renderer, resolved the way MapLibre's layer-sync resolves it:
  // heatmap and cluster apply only to point-only inline GeoJSON, and anything
  // else draws one circle per point.
  const { renderer, wantCluster, clusterRadius, clusterMaxZoom } = layer.geojson
    ? resolveVectorRenderMode(layer, profile)
    : { renderer: "single", wantCluster: false, clusterRadius: 0, clusterMaxZoom: 0 };
  // Geo Editor text markers carry their own annotation text: they draw
  // through their own symbol layer, never as a plain point as well.
  const hasTextMarkers = layer.geojson ? hasTextMarkerFeatures(layer.geojson) : false;
  const isPoint = ["match", ["geometry-type"], ["Point", "MultiPoint"], true, false];
  const plainPoint = hasTextMarkers ? ["all", isPoint, ["!", TEXT_MARKER_SHAPE_FILTER]] : isPoint;
  const withFilter = (condition: unknown): FilterSpecification =>
    (filter ? ["all", condition, filter] : condition) as FilterSpecification;
  // Marker icons and per-feature KML icons are generated sprites resolved by
  // the map's `styleimagemissing` handler (see generated-images.ts), the same
  // images MapLibre draws.
  const markerImage = markerImageValue(layer.style);
  const kmlIconImage = layer.geojson
    ? prepareKmlFeatureIcons(layer.geojson, markerImage ?? "")
    : null;
  const pointLayers = (base: Record<string, unknown>, id: string): LayerSpecification[] => {
    if (renderer === "heatmap") {
      return [
        {
          ...base,
          id: `${id}-heatmap`,
          type: "heatmap",
          filter: withFilter(plainPoint),
          paint: mapboxPaint(heatmapPaint(style, layer.opacity)),
        } as LayerSpecification,
      ];
    }
    if (renderer === "cluster") {
      // The bubble and its count aggregate the source's clusters, which carry
      // no feature properties, so they take no feature filter (a time or rule
      // filter would drop every cluster). The authored filters already
      // narrowed the clustered data itself; see `authoredClusterInput`.
      const isCluster: FilterSpecification = ["has", "point_count"];
      const unclustered = ["!", ["has", "point_count"]];
      return [
        {
          ...base,
          id: `${id}-cluster`,
          type: "circle",
          filter: isCluster,
          paint: mapboxPaint(clusterCirclePaint(style, layer.opacity)),
        },
        {
          ...base,
          id: `${id}-cluster-count`,
          type: "symbol",
          filter: isCluster,
          layout: {
            ...layout,
            "text-field": ["get", "point_count_abbreviated"],
            "text-font": compileOptions.textFont ?? DEFAULT_MAPBOX_TEXT_FONT,
            "text-size": 12,
            "text-allow-overlap": true,
            "text-ignore-placement": true,
          },
          paint: {
            "text-color": styleValue(layer.style, "textColor"),
            "text-opacity": layer.opacity,
          },
        },
        {
          ...base,
          id: `${id}-circle`,
          type: "circle",
          filter: withFilter(hasTextMarkers ? ["all", unclustered, plainPoint] : unclustered),
          paint: mapboxPaint(circlePaint(style, layer.opacity)),
        },
      ] as LayerSpecification[];
    }
    const circle = (condition: unknown) =>
      ({
        ...base,
        id: `${id}-circle`,
        type: "circle",
        filter: withFilter(condition),
        paint: mapboxPaint(circlePaint(style, layer.opacity)),
      }) as LayerSpecification;
    if (!markerImage && !kmlIconImage) return [circle(plainPoint)];
    const marker = {
      ...base,
      id: `${id}-marker`,
      type: "symbol",
      filter: withFilter(plainPoint),
      layout: {
        ...layout,
        "icon-image": kmlIconImage ?? markerImage,
        // The sprite is baked at its display size, so icon-size stays 1
        // unless proportional sizing scales it per feature.
        "icon-size": kmlIconImage
          ? ["case", ["has", KML_ICON_URL_PROPERTY], 1, markerIconSizeValue(layer.style)]
          : markerIconSizeValue(layer.style),
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
      paint: { "icon-opacity": layer.opacity },
    } as LayerSpecification;
    // Features without a KML icon still use the ordinary circle renderer.
    return kmlIconImage && !markerImage
      ? [marker, circle(["all", plainPoint, ["!", ["has", KML_ICON_URL_PROPERTY]]])]
      : [marker];
  };
  // Annotation text for Geo Editor text markers, as layer-sync draws it.
  const textMarkerLayer = (base: Record<string, unknown>, id: string): LayerSpecification =>
    ({
      ...base,
      id: `${id}-text-markers`,
      type: "symbol",
      filter: withFilter(["all", isPoint, TEXT_MARKER_SHAPE_FILTER]),
      layout: {
        ...layout,
        "text-allow-overlap": true,
        "text-font": compileOptions.textFont ?? DEFAULT_MAPBOX_TEXT_FONT,
        "text-field": [
          "to-string",
          ["coalesce", ["get", GEOMAN_TEXT_PROPERTY], ["get", "text"], ""],
        ],
        "text-ignore-placement": true,
        "text-size": Math.max(1, styleValue(layer.style, "textSize")),
      },
      paint: {
        // An optional per-feature `text-color` (annotation text labels keep
        // their own color) falls back to the layer's text color.
        "text-color": ["coalesce", ["get", "text-color"], styleValue(layer.style, "textColor")],
        "text-halo-color": styleValue(layer.style, "textHaloColor"),
        "text-halo-width": Math.max(0, styleValue(layer.style, "textHaloWidth")),
        "text-opacity": layer.opacity,
      },
    }) as unknown as LayerSpecification;
  // Attribute labels, compiled the way MapLibre's layer-sync builds them.
  const labels = { ...DEFAULT_LAYER_STYLE.labels, ...style.labels };
  // Unique/concatenate labels collapse co-located points into one label read
  // from an aggregated source. As on MapLibre it needs inline point-only data
  // and no active time, embed, authored or rule filter: the aggregated source
  // is built from the raw features, which no style filter narrows.
  const hasFeatureFilter = filters.length > 0;
  // Labels draw on neither an extrusion nor the heatmap renderer, as on
  // MapLibre; one guard for the label layer and its dedup companion source.
  const labelsDrawn = labels.enabled && !style.extrusionEnabled && renderer !== "heatmap";
  const dedupedLabels =
    labelsDrawn &&
    labels.dedupe !== "off" &&
    !hasFeatureFilter &&
    layer.geojson &&
    labels.field &&
    profile.hasPoint &&
    !profile.hasLine &&
    !profile.hasPolygon
      ? getDedupedLabelFeatures(layer.geojson, labels)
      : null;
  const labelSourceId = `${sourceId}-labels-dedup`;
  const labelLayer = (
    base: Record<string, unknown>,
    id: string,
    sourceLayer: string | undefined,
  ): LayerSpecification | null => {
    if (!labelsDrawn) return null;
    const deduped = !sourceLayer && dedupedLabels;
    let text: unknown = labelFieldTextField(labels, documentLocale());
    if (deduped) text = ["get", DEDUPED_LABEL_PROPERTY];
    else if (labels.expression.trim()) {
      try {
        const parsed: unknown = JSON.parse(labels.expression);
        // Only an array is an expression; anything else keeps the field text.
        if (Array.isArray(parsed)) text = parsed;
      } catch {
        // An unparseable label expression must not take the geometry with
        // it; keep the field-based text.
      }
    }
    if (text === "") return null;
    // Data-defined overrides read source attributes, which the aggregated
    // dedup features do not carry. An invalid one falls back to the control.
    const override = (source: string, expectedType: "number" | "color" | "boolean") =>
      deduped ? null : parseLabelOverride(source, expectedType);
    const size = override(labels.sizeExpression, "number");
    const color = override(labels.colorExpression, "color");
    const opacity = override(labels.opacityExpression, "number");
    const priority = override(labels.priorityExpression, "number");
    const visible = override(labels.visibilityExpression, "boolean");
    // Geo Editor text markers carry their own annotation text, so the label
    // layer skips them; a visibility override gates each feature's label.
    const labelFilter = [
      "all",
      ["!", TEXT_MARKER_SHAPE_FILTER],
      ...(visible ? [visible] : []),
      ...filters,
    ];
    return {
      ...base,
      // The aggregated dedup points are synthetic, so identify skips them.
      ...(deduped ? { source: labelSourceId, metadata: { "geolibre:internal": true } } : {}),
      id: `${id}-labels`,
      type: "symbol",
      ...(deduped ? {} : { filter: labelFilter as FilterSpecification }),
      minzoom: Math.max(style.minZoom, labels.minZoom),
      maxzoom: Math.min(style.maxZoom, labels.maxZoom),
      layout: {
        ...layout,
        "text-field": text as DataDrivenPropertyValueSpecification<string>,
        "text-font": compileOptions.textFont ?? DEFAULT_MAPBOX_TEXT_FONT,
        "text-size": (size ??
          Math.max(1, labels.size)) as DataDrivenPropertyValueSpecification<number>,
        // The aggregated source is points, so it cannot use line placement.
        "symbol-placement": !deduped && labels.placement === "line" ? "line" : "point",
        "text-allow-overlap": labels.allowOverlap,
        "text-ignore-placement": labels.allowOverlap,
        "text-anchor": labels.anchor,
        "text-offset": [labels.offsetX, labels.offsetY],
        "text-rotate": labels.rotation,
        "text-max-width": Math.max(1, labels.maxWidth),
        "text-transform": labels.transform,
        // Lower sort keys place first, so they win when space is tight.
        ...(priority
          ? { "symbol-sort-key": priority as DataDrivenPropertyValueSpecification<number> }
          : {}),
      },
      paint: {
        "text-color": (color ?? labels.color) as DataDrivenPropertyValueSpecification<string>,
        "text-halo-color": labels.haloColor,
        "text-halo-width": Math.max(0, labels.haloWidth),
        // Replaces the layer opacity rather than multiplying into it, as on
        // MapLibre: wrapping would invalidate top-level zoom interpolations.
        "text-opacity": (opacity ?? layer.opacity) as DataDrivenPropertyValueSpecification<number>,
      },
    } as LayerSpecification;
  };
  // The geometry generator's derived shapes (QGIS geometry generator), drawn
  // from a companion source with the generator's own colors.
  const generatorLayers = (
    base: Record<string, unknown>,
    id: string,
    collection: FeatureCollection,
  ): LayerSpecification[] => {
    const kinds = generatedGeometryKinds(collection);
    const fillColor = styleValue(layer.style, "geometryGeneratorFillColor");
    const strokeColor = styleValue(layer.style, "geometryGeneratorStrokeColor");
    const strokeWidth = Math.max(0, styleValue(layer.style, "geometryGeneratorStrokeWidth"));
    const genOpacity =
      Math.min(1, Math.max(0, styleValue(layer.style, "geometryGeneratorOpacity"))) * layer.opacity;
    const polygon = ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false];
    const result: LayerSpecification[] = [];
    if (kinds.hasPolygon)
      result.push(
        {
          ...base,
          id: `${id}-generator-fill`,
          type: "fill",
          metadata: { "geolibre:internal": true },
          filter: polygon,
          paint: { "fill-color": fillColor, "fill-opacity": genOpacity },
        } as LayerSpecification,
        {
          ...base,
          id: `${id}-generator-line`,
          type: "line",
          metadata: { "geolibre:internal": true },
          filter: polygon,
          paint: {
            "line-color": strokeColor,
            "line-width": strokeWidth,
            "line-opacity": layer.opacity,
          },
        } as LayerSpecification,
      );
    if (kinds.hasPoint)
      result.push({
        ...base,
        id: `${id}-generator-circle`,
        type: "circle",
        metadata: { "geolibre:internal": true },
        filter: isPoint,
        paint: {
          "circle-color": fillColor,
          "circle-radius": generatorCircleRadiusValue(layer.style),
          "circle-opacity": genOpacity,
          "circle-stroke-color": strokeColor,
          "circle-stroke-width": strokeWidth,
          "circle-stroke-opacity": layer.opacity,
        },
      } as LayerSpecification);
    return result;
  };
  // Derived companion symbology (the inverted-fill mask, the geometry
  // generator) is built from the raw features, so, as on MapLibre, it needs
  // inline data and no active filter that the derivation would ignore.
  const invertedMask =
    profile.hasPolygon &&
    !style.extrusionEnabled &&
    styleValue(layer.style, "invertedFillEnabled") &&
    !hasFeatureFilter &&
    layer.geojson
      ? mapboxMask(buildInvertedMask(layer.geojson))
      : null;
  const invertedSourceId = `${sourceId}-inverted`;
  const generatorType =
    style.extrusionEnabled || hasFeatureFilter
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
  const generatedSourceId = `${sourceId}-generated`;
  const fillPatternId = prepareFillPattern(layer.style);
  const decorationImageId = prepareLineDecoration(layer.style);
  const flatBelowZoom = style.extrusionEnabled ? flatExtrusionCutoff(layer.style) : null;
  const vectorLayers = (sourceLayer?: string): LayerSpecification[] => {
    const base = {
      source: sourceId,
      layout,
      ...zoom,
      ...(sourceLayer ? { "source-layer": sourceLayer } : {}),
    };
    const id = `${sourceId}-${sourceLayer ?? "geojson"}`;
    const isPolygon = ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false];
    // A set fill pattern replaces fill-color with the recolorable sprite tile.
    const fill = {
      ...mapboxPaint(fillPaint(style, layer.opacity)),
      ...(fillPatternId ? { "fill-pattern": fillPatternId } : {}),
    };
    const result: LayerSpecification[] = [];
    if (profile.hasPolygon && style.extrusionEnabled) {
      // A zoom-stepped extrusion that is flat below some zoom draws an
      // ordinary fill there: a zero-height extrusion still triangulates as 3D
      // geometry and shards at tile edges on the globe.
      const flatRange = flatBelowZoom !== null && style.minZoom < flatBelowZoom;
      if (flatRange)
        result.push({
          ...base,
          id: `${mapboxFillLayerId(layer.id, sourceLayer)}-flat`,
          type: "fill",
          maxzoom: Math.min(style.maxZoom, flatBelowZoom),
          filter: withFilter(isPolygon),
          paint: fill,
        } as LayerSpecification);
      result.push({
        ...base,
        id: mapboxFillLayerId(layer.id, sourceLayer),
        type: "fill-extrusion",
        ...(flatBelowZoom !== null
          ? { minzoom: Math.min(style.maxZoom, Math.max(style.minZoom, flatBelowZoom)) }
          : {}),
        filter: withFilter(isPolygon),
        paint: mapboxPaint(fillExtrusionPaint(style, layer.opacity)),
      } as LayerSpecification);
    } else if (profile.hasPolygon && !sourceLayer && invertedMask) {
      // Inverted fill (QGIS "Inverted polygons"): the mask outside the
      // features takes the fill, so the features read as holes. Its outer
      // ring is the world rectangle, whose hairline outline would draw a seam.
      result.push({
        ...base,
        source: invertedSourceId,
        id: `${mapboxFillLayerId(layer.id, sourceLayer)}-inverted`,
        type: "fill",
        metadata: { "geolibre:internal": true },
        paint: { ...fill, "fill-outline-color": "rgba(0, 0, 0, 0)" },
      } as LayerSpecification);
    } else if (profile.hasPolygon) {
      result.push({
        ...base,
        id: mapboxFillLayerId(layer.id, sourceLayer),
        type: "fill",
        filter: withFilter(isPolygon),
        paint: fill,
      } as LayerSpecification);
    }
    // Under an extrusion only true lines get a line layer; the extrusion
    // draws its own walls, as on MapLibre.
    if (profile.hasLine || (!style.extrusionEnabled && profile.hasPolygon))
      result.push({
        ...base,
        id: mapboxLineLayerId(layer.id, sourceLayer),
        type: "line",
        filter: withFilter(
          style.extrusionEnabled
            ? ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false]
            : notPoint,
        ),
        paint: mapboxPaint(linePaint(style, layer.opacity)),
      } as LayerSpecification);
    // Line decorations (QGIS marker lines / arrows): the generated icon
    // repeated along lines and polygon outlines, rotated to follow them.
    if (!style.extrusionEnabled && decorationImageId && (profile.hasLine || profile.hasPolygon))
      result.push({
        ...base,
        id: `${id}-line-decoration`,
        type: "symbol",
        metadata: { "geolibre:internal": true },
        filter: withFilter(notPoint),
        layout: {
          ...layout,
          "icon-image": decorationImageId,
          "icon-size": 1,
          "symbol-placement": "line",
          "symbol-spacing": Math.max(1, styleValue(layer.style, "lineDecorationSpacing")),
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          "icon-rotation-alignment": "map",
        },
        paint: { "icon-opacity": layer.opacity },
      } as LayerSpecification);
    if (profile.hasPoint) result.push(...pointLayers(base, id));
    if (hasTextMarkers && !sourceLayer) result.push(textMarkerLayer(base, id));
    const label = labelLayer(base, id, sourceLayer);
    if (label) result.push(label);
    if (!sourceLayer && generated?.features.length)
      result.push(...generatorLayers({ ...base, source: generatedSourceId }, id, generated));
    return result;
  };
  // The companion GeoJSON sources the inline layers above read from.
  const companionSources = (): { additionalSources?: Record<string, SourceSpecification> } => {
    const sources: Record<string, SourceSpecification> = {};
    if (dedupedLabels) sources[labelSourceId] = { type: "geojson", data: dedupedLabels };
    if (invertedMask) sources[invertedSourceId] = { type: "geojson", data: invertedMask };
    if (generated?.features.length)
      sources[generatedSourceId] = { type: "geojson", data: generated };
    return Object.keys(sources).length ? { additionalSources: sources } : {};
  };
  if (layer.geojson) {
    return {
      sourceId,
      source: wantCluster
        ? {
            type: "geojson",
            // Without a live zoom (the support check's dry-run compile) the
            // raw data stands in, so a dry run never touches the one-slot
            // cluster-input cache the engine's real syncs rely on.
            data:
              compileOptions.zoom === undefined
                ? layer.geojson
                : authoredClusterInput(layer, compileOptions.zoom),
            generateId: true,
            cluster: true,
            clusterRadius,
            clusterMaxZoom,
          }
        : { type: "geojson", data: layer.geojson, generateId: true },
      ...companionSources(),
      layers: vectorLayers(),
    };
  }
  if (layer.type === "pmtiles") {
    const url = String(layer.source.url ?? layer.sourcePath ?? "").replace(/^pmtiles:\/\//, "");
    if (
      layer.source.tileType !== "vector" ||
      !/^https?:\/\//.test(url) ||
      !new URL(url).pathname.endsWith(".pmtiles")
    ) {
      throw new Error("Mapbox PMTiles requires a remote vector .pmtiles archive");
    }
    const names = layer.source.sourceLayers;
    if (!Array.isArray(names) || !names.length)
      throw new Error("Vector tiles need a source-layer name");
    return {
      sourceId,
      source: { type: "vector", url },
      layers: names.flatMap((name) => vectorLayers(String(name))),
    };
  }
  const urls = [
    layer.source.url,
    ...(Array.isArray(layer.source.tiles) ? layer.source.tiles : []),
    ...(Array.isArray(layer.source.urls) ? layer.source.urls : []),
  ];
  if (urls.some((url) => typeof url === "string" && !supportedUrl(url))) {
    throw new Error("MapLibre custom tile protocols are not supported by Mapbox");
  }
  const url = typeof layer.source.url === "string" ? layer.source.url : undefined;
  const tiles = Array.isArray(layer.source.tiles)
    ? layer.source.tiles.filter((t): t is string => typeof t === "string")
    : [];
  const options = {
    ...(typeof layer.source.minzoom === "number" ? { minzoom: layer.source.minzoom } : {}),
    ...(typeof layer.source.maxzoom === "number" ? { maxzoom: layer.source.maxzoom } : {}),
    ...(typeof layer.source.attribution === "string"
      ? { attribution: layer.source.attribution }
      : {}),
    ...(Array.isArray(layer.source.bounds) && layer.source.bounds.length === 4
      ? { bounds: layer.source.bounds as [number, number, number, number] }
      : {}),
    ...(layer.source.scheme === "tms" ? { scheme: "tms" as const } : {}),
  };
  if (layer.type === "vector-tiles" && (url || tiles.length)) {
    const names = Array.isArray(layer.source.sourceLayers ?? layer.metadata.sourceLayers)
      ? ((layer.source.sourceLayers ?? layer.metadata.sourceLayers) as unknown[])
      : [layer.source.sourceLayer ?? layer.source["source-layer"]];
    const sourceLayers = names.filter((v): v is string => typeof v === "string" && Boolean(v));
    if (!sourceLayers.length) throw new Error("Vector tiles need a source-layer name");
    return {
      sourceId,
      source: { type: "vector", ...(url ? { url } : { tiles }), ...options },
      layers: sourceLayers.flatMap(vectorLayers),
    };
  }
  const rasterLayers = [
    {
      id: rasterId,
      type: "raster",
      source: sourceId,
      layout,
      ...zoom,
      paint: mapboxPaint(rasterPaint(style, layer.opacity)),
    },
  ] as LayerSpecification[];
  if (["raster", "wms", "wmts", "xyz"].includes(layer.type) && (tiles.length || url)) {
    // Same dev-server WMS proxy as the MapLibre path (getRenderableRasterTiles),
    // so a WMS layer that works in a MapLibre pane also works here in `npm run dev`.
    const rasterTiles = proxyWmsTiles(layer.type, tiles);
    return {
      sourceId,
      source: {
        type: "raster",
        ...(rasterTiles.length ? { tiles: rasterTiles } : { url }),
        tileSize: typeof layer.source.tileSize === "number" ? layer.source.tileSize : 256,
        ...options,
      },
      layers: rasterLayers,
    };
  }
  if (layer.type === "geojson" && url) {
    return {
      sourceId,
      source: { type: "geojson", data: url, generateId: true },
      layers: vectorLayers(),
    };
  }
  if (
    (layer.type === "image" || layer.type === "video") &&
    Array.isArray(layer.source.coordinates)
  ) {
    const coordinates = layer.source.coordinates as [
      [number, number],
      [number, number],
      [number, number],
      [number, number],
    ];
    if (
      coordinates.length !== 4 ||
      coordinates.some((p) => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite))
    )
      throw new Error("Invalid image corners");
    if (layer.type === "image" && url)
      return { sourceId, source: { type: "image", url, coordinates }, layers: rasterLayers };
    if (layer.type === "video" && Array.isArray(layer.source.urls))
      return {
        sourceId,
        source: { type: "video", urls: layer.source.urls as string[], coordinates },
        layers: rasterLayers,
      };
  }
  throw new Error(`Layer type ${layer.type} requires a renderer-specific adapter`);
}

/**
 * Style settings the Mapbox compiler does not draw yet. The Style panel lists
 * the ones a layer has turned on, so a setting that silently does nothing on
 * this renderer is named instead. Remove an entry once the compiler honors it.
 */
export type MapboxUnsupportedStyleSetting = "blendMode";

/** The {@link MapboxUnsupportedStyleSetting}s this layer's style turns on. */
export function mapboxUnsupportedStyleSettings(
  layer: GeoLibreLayer,
): MapboxUnsupportedStyleSetting[] {
  const blendMode = layer.style.blendMode ?? DEFAULT_LAYER_STYLE.blendMode;
  return blendMode !== DEFAULT_LAYER_STYLE.blendMode ? ["blendMode"] : [];
}

/** The inverted-fill mask reshaped so mapbox-gl draws it as MapLibre does. */
function mapboxMask(mask: FeatureCollection | null): FeatureCollection | null {
  return mask ? mapboxRenderableMask(mask as Parameters<typeof mapboxRenderableMask>[0]) : null;
}
