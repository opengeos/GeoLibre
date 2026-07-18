import {
  DEFAULT_LAYER_STYLE,
  ruleBasedVisibilityFilter,
  styleValue,
  type GeoLibreLayer,
  type LayerStyle,
} from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import type { ExpressionSpecification, LayerSpecification, StyleSpecification } from "maplibre-gl";
import { detectGeometryProfile } from "./geojson-loader";
import {
  circlePaint,
  fillExtrusionPaint,
  fillPaint,
  heatmapPaint,
  linePaint,
} from "./style-mapper";

/**
 * A public glyphs endpoint so text labels in an exported style render without
 * the user having to host their own fonts. The exported style is a fragment
 * meant to be dropped into a MapLibre/Mapbox map, so it points at MapLibre's
 * demo font server rather than embedding fonts.
 */
const DEFAULT_GLYPHS_URL = "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf";

/** Font stack used for exported label layers (a widely available default). */
const DEFAULT_TEXT_FONT = ["Open Sans Regular", "Arial Unicode MS Regular"];

const MIN_LAYER_ZOOM = DEFAULT_LAYER_STYLE.minZoom;
const MAX_LAYER_ZOOM = DEFAULT_LAYER_STYLE.maxZoom;

/**
 * Above this feature count the exporter still embeds the data (an export with no
 * data would be useless) but warns that the resulting file is large. Callers can
 * point the source at a hosted file instead.
 */
const LARGE_EMBED_FEATURE_COUNT = 50_000;

export interface MapboxStyleExportResult {
  /** A MapLibre/Mapbox GL style document containing just this layer. */
  style: StyleSpecification;
  /**
   * Human-readable notes about anything that could not be represented exactly
   * (fill patterns, custom markers, source-backed data), so the export never
   * fails silently. Empty when the symbology mapped cleanly.
   */
  warnings: string[];
}

/**
 * The layer fields the exporter reads. Kept structural (rather than the full
 * {@link GeoLibreLayer}) so it is easy to unit-test with a minimal fixture.
 */
export type ExportableLayer = Pick<
  GeoLibreLayer,
  "id" | "name" | "type" | "style" | "opacity" | "visible"
>;

export interface MapboxStyleExportOptions {
  /**
   * Warn (rather than stay silent) once the embedded FeatureCollection exceeds
   * this many features. Defaults to {@link LARGE_EMBED_FEATURE_COUNT}.
   */
  largeFeatureCount?: number;
  /**
   * Glyphs (font) URL template written to the style when a label layer is
   * emitted. Defaults to {@link DEFAULT_GLYPHS_URL} (MapLibre's public demo
   * font server); pass your own font server for a production style so the
   * export does not depend on a third-party host.
   */
  glyphsUrl?: string;
}

/** Turn a layer name into a stable, style-spec-safe source/layer id prefix. */
function styleIdBase(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return base || "layer";
}

function clampZoom(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(MAX_LAYER_ZOOM, Math.max(MIN_LAYER_ZOOM, value));
}

/**
 * The style's zoom window as MapLibre `minzoom`/`maxzoom`, only when narrower
 * than the full [0, 24] range so a default export stays uncluttered.
 */
function zoomRange(style: LayerStyle): { minzoom?: number; maxzoom?: number } {
  const min = clampZoom(styleValue(style, "minZoom"), MIN_LAYER_ZOOM);
  const max = clampZoom(styleValue(style, "maxZoom"), MAX_LAYER_ZOOM);
  const minzoom = Math.min(min, max);
  const maxzoom = Math.max(min, max);
  const range: { minzoom?: number; maxzoom?: number } = {};
  if (minzoom > MIN_LAYER_ZOOM) range.minzoom = minzoom;
  if (maxzoom < MAX_LAYER_ZOOM) range.maxzoom = maxzoom;
  return range;
}

const POLYGON_FILTER = [
  "match",
  ["geometry-type"],
  ["Polygon", "MultiPolygon"],
  true,
  false,
] as unknown as ExpressionSpecification;

const LINE_FILTER = [
  "match",
  ["geometry-type"],
  ["LineString", "MultiLineString", "Polygon", "MultiPolygon"],
  true,
  false,
] as unknown as ExpressionSpecification;

const POINT_FILTER = [
  "match",
  ["geometry-type"],
  ["Point", "MultiPoint"],
  true,
  false,
] as unknown as ExpressionSpecification;

/** Build the label text-field expression from the layer's label config. */
function labelTextField(style: LayerStyle, warnings: string[]): ExpressionSpecification | null {
  const labels = style.labels ?? DEFAULT_LAYER_STYLE.labels;
  const expression = labels.expression.trim();
  if (expression) {
    try {
      const parsed = JSON.parse(expression);
      // JSON.parse accepts non-expressions (numbers, objects); only an array is
      // a usable MapLibre expression. Fall back to the field otherwise.
      if (Array.isArray(parsed)) return parsed as ExpressionSpecification;
      warnings.push("Label expression is not a MapLibre expression; used the label field instead.");
    } catch {
      warnings.push("Label expression could not be parsed; used the label field instead.");
    }
  }
  if (labels.field) {
    return [
      "to-string",
      ["coalesce", ["get", labels.field], ""],
    ] as unknown as ExpressionSpecification;
  }
  return null;
}

/**
 * The symbol (label) layer for a layer whose labels are enabled. `ruleFilter`
 * is the rule-based hide-unmatched filter (or null) — the live map filters
 * labels too, so the exported label layer must not label features the render
 * layers drop.
 */
function buildLabelLayer(
  layer: ExportableLayer,
  sourceKey: string,
  idBase: string,
  visibility: "visible" | "none",
  pointOnly: boolean,
  warnings: string[],
  ruleFilter: unknown[] | null,
): LayerSpecification | null {
  const style = layer.style;
  const labels = style.labels ?? DEFAULT_LAYER_STYLE.labels;
  if (!labels.enabled) return null;
  const textField = labelTextField(style, warnings);
  if (textField === null) return null;

  // Live dedup only applies to point-only layers that label by a field (not a
  // bare expression), so only warn when it would actually have taken effect
  // (mirrors the map's dedupe gating).
  if (labels.dedupe !== "off" && pointOnly && labels.field) {
    warnings.push(
      "Duplicate-label handling (unique/concatenate) is applied live in " +
        "GeoLibre and is not carried into the exported style; every feature is " +
        "labeled.",
    );
  }

  // Labels at the default 0/24 inherit the layer's own zoom window, so
  // intersect the label range with the style range (tighter bound on each end),
  // matching the live map's intersectZoomRange behavior.
  const labelMin = clampZoom(labels.minZoom, MIN_LAYER_ZOOM);
  const labelMax = clampZoom(labels.maxZoom, MAX_LAYER_ZOOM);
  const styleMin = clampZoom(styleValue(style, "minZoom"), MIN_LAYER_ZOOM);
  const styleMax = clampZoom(styleValue(style, "maxZoom"), MAX_LAYER_ZOOM);
  const intersectedMin = Math.max(labelMin, styleMin);
  const intersectedMax = Math.min(labelMax, styleMax);
  // Swap if the two ranges do not overlap so the spec never gets min > max.
  const zoomMin = Math.min(intersectedMin, intersectedMax);
  const zoomMax = Math.max(intersectedMin, intersectedMax);
  const range: { minzoom?: number; maxzoom?: number } = {};
  if (zoomMin > MIN_LAYER_ZOOM) range.minzoom = zoomMin;
  if (zoomMax < MAX_LAYER_ZOOM) range.maxzoom = zoomMax;

  return {
    id: `${idBase}-label`,
    type: "symbol",
    source: sourceKey,
    ...range,
    ...(ruleFilter ? { filter: ruleFilter as unknown as ExpressionSpecification } : {}),
    layout: {
      "text-field": textField,
      "text-font": DEFAULT_TEXT_FONT,
      "text-size": Math.max(1, labels.size),
      "symbol-placement": labels.placement === "line" ? "line" : "point",
      "text-allow-overlap": labels.allowOverlap,
      "text-ignore-placement": labels.allowOverlap,
      "text-anchor": labels.anchor,
      "text-offset": [labels.offsetX, labels.offsetY],
      "text-rotate": labels.rotation,
      "text-max-width": Math.max(1, labels.maxWidth),
      "text-transform": labels.transform,
      visibility,
    },
    paint: {
      "text-color": labels.color,
      "text-halo-color": labels.haloColor,
      "text-halo-width": Math.max(0, labels.haloWidth),
      "text-opacity": layer.opacity,
    },
  } as LayerSpecification;
}

/**
 * Serialize a vector layer's GeoLibre symbology into a self-contained Mapbox GL
 * / MapLibre style document. The render layers reuse the exact same paint
 * builders the live map uses ({@link fillPaint}, {@link linePaint},
 * {@link circlePaint}, ...), so an exported style reproduces what GeoLibre draws
 * for the single/categorized/graduated/expression/rule-based renderers and
 * labels. Features that rely on generated sprite images (fill patterns, custom
 * markers, heatmap density beyond the built-in ramp) degrade gracefully and are
 * reported in {@link MapboxStyleExportResult.warnings}.
 *
 * @param layer   The layer whose `style` is exported.
 * @param geojson The layer's features, embedded as the style's GeoJSON source.
 *                When `null`, an empty source is written and a warning is added.
 */
export function buildMapboxStyle(
  layer: ExportableLayer,
  geojson: FeatureCollection | null,
  options: MapboxStyleExportOptions = {},
): MapboxStyleExportResult {
  const warnings: string[] = [];
  const style = layer.style;
  const opacity = layer.opacity;
  const visibility: "visible" | "none" = layer.visible ? "visible" : "none";
  const idBase = styleIdBase(layer.name);
  const sourceKey = `${idBase}-source`;

  const featureCount = geojson?.features.length ?? 0;
  const largeThreshold = options.largeFeatureCount ?? LARGE_EMBED_FEATURE_COUNT;
  if (!geojson) {
    warnings.push(
      "This layer's features are not embedded; point the style's source at " +
        "your data before using it.",
    );
  } else if (featureCount > largeThreshold) {
    warnings.push(
      `The style embeds ${featureCount.toLocaleString()} features, so the file ` +
        "is large; consider pointing the source at a hosted file instead.",
    );
  }

  // With no data we cannot detect which geometries are present, so emit fill,
  // line, and circle layers (each geometry-filtered) as a safe superset.
  const profile = geojson
    ? detectGeometryProfile(geojson)
    : { hasPoint: true, hasLine: true, hasPolygon: true };

  // heatmap/cluster and label dedup only apply to point-only layers, matching
  // the live map.
  const pointOnly = profile.hasPoint && !profile.hasLine && !profile.hasPolygon;
  const effectiveRenderer = pointOnly ? styleValue(style, "pointRenderer") : "single";

  const layers: LayerSpecification[] = [];
  const zoom = zoomRange(style);

  // A rule-based layer whose else rule is switched off hides features matching
  // no rule; the live map does that with a per-feature filter, so fold the same
  // filter into every exported render layer or the exported style would draw
  // features GeoLibre hides.
  const ruleFilter = ruleBasedVisibilityFilter(style);
  const withRuleVisibility = (geometryFilter: ExpressionSpecification): ExpressionSpecification =>
    ruleFilter
      ? (["all", geometryFilter, ruleFilter] as unknown as ExpressionSpecification)
      : geometryFilter;

  // Only warn about a dropped fill pattern when the layer actually has polygons
  // to fill (and is not extruded, where the pattern never applies).
  if (
    profile.hasPolygon &&
    !style.extrusionEnabled &&
    style.fillPattern &&
    style.fillPattern !== "none"
  ) {
    warnings.push(
      "Fill pattern is not exported (it relies on a generated sprite); the " +
        "polygon uses a flat fill instead.",
    );
  }

  if (profile.hasPolygon) {
    if (style.extrusionEnabled) {
      layers.push({
        id: `${idBase}-fill-extrusion`,
        type: "fill-extrusion",
        source: sourceKey,
        ...zoom,
        filter: withRuleVisibility(POLYGON_FILTER),
        paint: fillExtrusionPaint(style, opacity),
        layout: { visibility },
      } as LayerSpecification);
    } else {
      layers.push({
        id: `${idBase}-fill`,
        type: "fill",
        source: sourceKey,
        ...zoom,
        filter: withRuleVisibility(POLYGON_FILTER),
        paint: fillPaint(style, opacity),
        layout: { visibility },
      } as LayerSpecification);
    }
  }

  if (!style.extrusionEnabled && (profile.hasLine || profile.hasPolygon)) {
    layers.push({
      id: `${idBase}-line`,
      type: "line",
      source: sourceKey,
      ...zoom,
      filter: withRuleVisibility(LINE_FILTER),
      paint: linePaint(style, opacity),
      layout: { visibility },
    } as LayerSpecification);
  }

  if (!style.extrusionEnabled && profile.hasPoint) {
    if (style.markerEnabled) {
      warnings.push(
        "Custom marker symbol is not exported (it relies on a generated " +
          "sprite); points use a circle instead.",
      );
    }

    if (effectiveRenderer === "heatmap") {
      layers.push({
        id: `${idBase}-heatmap`,
        type: "heatmap",
        source: sourceKey,
        ...zoom,
        filter: withRuleVisibility(POINT_FILTER),
        paint: heatmapPaint(style, opacity),
        layout: { visibility },
      } as LayerSpecification);
    } else if (effectiveRenderer === "cluster") {
      // Clustering is a GeoJSON source option; without a clustered source a
      // static export cannot reproduce it, so warn and fall back to a plain
      // circle layer for the individual points.
      warnings.push(
        "Point clustering requires a clustered GeoJSON source; enable " +
          "`cluster: true` on the source to reproduce it. Exported as plain " +
          "points.",
      );
      layers.push({
        id: `${idBase}-circle`,
        type: "circle",
        source: sourceKey,
        ...zoom,
        filter: withRuleVisibility(POINT_FILTER),
        paint: circlePaint(style, opacity),
        layout: { visibility },
      } as LayerSpecification);
    } else {
      layers.push({
        id: `${idBase}-circle`,
        type: "circle",
        source: sourceKey,
        ...zoom,
        filter: withRuleVisibility(POINT_FILTER),
        paint: circlePaint(style, opacity),
        layout: { visibility },
      } as LayerSpecification);
    }
  }

  // The live map suppresses labels on extruded and heatmap layers, so the
  // export must too (otherwise an extruded/heatmap layer gains labels it never
  // shows in GeoLibre).
  const labelLayer =
    style.extrusionEnabled || effectiveRenderer === "heatmap"
      ? null
      : buildLabelLayer(layer, sourceKey, idBase, visibility, pointOnly, warnings, ruleFilter);
  if (labelLayer) layers.push(labelLayer);

  // Text labels need a glyphs (font) endpoint, so reference one only when a
  // label layer is emitted. Treat a blank glyphsUrl as "not provided" so a
  // caller cannot write an invalid empty `glyphs: ""`.
  const customGlyphs = options.glyphsUrl?.trim();
  const glyphs = labelLayer ? customGlyphs || DEFAULT_GLYPHS_URL : undefined;
  // Flag the default third-party dependency so the user can point `glyphs` at
  // their own font server for a production style.
  if (labelLayer && !customGlyphs) {
    warnings.push(
      "Text labels reference MapLibre's public demo font server " +
        "(demotiles.maplibre.org); replace the style's `glyphs` URL with " +
        "your own font server for production use.",
    );
  }

  const style_: StyleSpecification = {
    version: 8,
    name: layer.name,
    sources: {
      [sourceKey]: {
        type: "geojson",
        data: geojson ?? { type: "FeatureCollection", features: [] },
      },
    },
    layers,
    ...(glyphs ? { glyphs } : {}),
  };

  return { style: style_, warnings };
}

/** Pretty-printed JSON for the exported style. */
export function mapboxStyleToJson(result: MapboxStyleExportResult): string {
  return JSON.stringify(result.style, null, 2);
}
