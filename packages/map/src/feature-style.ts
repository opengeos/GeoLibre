import {
  DEFAULT_LAYER_STYLE,
  circleRadiusValue,
  lineWidthValue,
  normalizeHexColor,
  simpleStyleNumberValue,
  styleValue,
  vectorCircleColorValue,
  vectorColorExpression,
  vectorFillColorValue,
  vectorFillOpacityValue,
  vectorLineColorValue,
  vectorOutlineColorValue,
  vectorStrokeWidthValue,
  type LayerStyle,
} from "@geolibre/core";
import { createExpression, type StyleExpression } from "@maplibre/maplibre-gl-style-spec";
import type { Feature } from "geojson";
import { markerIconSizeValue } from "./markers";

// Per-feature symbology for the globe (issue #2278).
//
// The 2D map never resolves a feature's colour itself: `@geolibre/core` builds
// one MapLibre expression per paint channel from the `LayerStyle` — a `match`
// for categorized, a `step` for graduated, a zoom-wrapped `case` for
// rule-based, the user's own JSON for expression mode, an `interpolate` for
// proportional sizing, `["zoom"]` interpolation for metre-unit strokes — and
// MapLibre evaluates it on the GPU. Cesium draws entities, not a style
// document, so the globe evaluates those *same* expressions per feature in
// JavaScript with the style-spec engine and bakes the answers into each
// entity. Reusing the builders is what keeps the two renderers in agreement:
// a new style mode lands in `vector-color.ts` once and reaches both.
//
// This module is pure — no Cesium, no DOM — so it is unit-tested against real
// expressions and the layer sync only has to turn the answers into colours,
// widths, and pixel sizes.

/** One feature's resolved symbology, in CSS colours and pixels. */
export interface FeatureSymbol {
  /** Polygon fill colour. */
  fill: string;
  /** Polygon fill opacity, before the layer opacity is applied. */
  fillOpacity: number;
  /**
   * Circle fill colour. The 2D circle layer takes the simplestyle
   * `marker-color`, not the polygon `fill`, so points have their own channel.
   */
  pointFill: string;
  /** Circle opacity (simplestyle `marker-opacity`), before the layer opacity. */
  pointFillOpacity: number;
  /** Line colour for line geometry and polygon outlines (both line layers on the 2D map). */
  stroke: string;
  /** Circle stroke colour. */
  outline: string;
  /** Line / outline width in pixels at the evaluated zoom. */
  strokeWidth: number;
  /** Line / outline opacity, before the layer opacity. */
  strokeOpacity: number;
  /** Circle radius in pixels. */
  radius: number;
  /** Marker (icon) colour, for layers rendering points as markers. */
  markerColor: string;
  /** Marker scale relative to the sprite baked at the layer's marker size. */
  markerScale: number;
}

export interface FeatureStyleResolver {
  /** The symbol for `feature` as the map would draw it at `zoom`. */
  resolve(feature: Feature | undefined, zoom: number): FeatureSymbol;
  /** Just the marker colour channel, for baking one sprite per distinct colour. */
  resolveMarkerColor(feature: Feature | undefined, zoom: number): string;
  /**
   * Whether any channel reads `["zoom"]` (metre-unit strokes, per-rule zoom
   * ranges), so the answers change as the camera moves and the caller must
   * re-resolve when the integer zoom changes.
   */
  readonly zoomDependent: boolean;
}

type Channel<T> = (feature: Feature | undefined, zoom: number) => T;

const ROOT_KEY = "expression";
const ZOOM_OPERAND = /\[\s*"zoom"\s*\]/;

/**
 * The minimal property spec that makes `createExpression` enforce a result
 * type while allowing zoom- and feature-dependent input; the same shape
 * `@geolibre/core`'s expression compiler uses.
 */
function propertySpec(type: "color" | "number") {
  return {
    type,
    "property-type": "data-driven",
    expression: { parameters: ["zoom", "feature"] },
  } as unknown as NonNullable<Parameters<typeof createExpression>[2]>;
}

/**
 * The geometry type name MapLibre's evaluator sees. A tiled feature carries
 * the vector-tile kind (Point / LineString / Polygon), so a `Multi*` geometry
 * answers `["geometry-type"]` with its member kind, and the globe must match
 * or an expression branching on it would classify a MultiPolygon differently
 * from the 2D map.
 */
const GEOMETRY_KIND: Record<string, string> = {
  Point: "Point",
  MultiPoint: "Point",
  LineString: "LineString",
  MultiLineString: "LineString",
  Polygon: "Polygon",
  MultiPolygon: "Polygon",
};

/** The style-spec feature shape: geometry type by name, plus properties and id. */
function styleFeature(feature: Feature | undefined) {
  const type = feature?.geometry?.type;
  return {
    type: (type && GEOMETRY_KIND[type]) ?? "Unknown",
    properties: feature?.properties ?? {},
    ...(feature?.id !== undefined ? { id: feature.id } : {}),
    geometry: feature?.geometry,
  } as never;
}

/** A style-spec `Color` evaluates to an object; render it as CSS. */
function cssColor(value: unknown, fallback: string): string {
  if (typeof value === "string") return normalizeHexColor(value) ?? value;
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { toString: unknown }).toString === "function"
  ) {
    const text = String(value);
    if (text.startsWith("rgba(") || text.startsWith("#")) return text;
  }
  return fallback;
}

function compileChannel<T>(
  value: unknown,
  type: "color" | "number",
  fallback: T,
  coerce: (raw: unknown, fallback: T) => T,
): { read: Channel<T>; zoomDependent: boolean } {
  if (!Array.isArray(value)) return { read: () => coerce(value, fallback), zoomDependent: false };
  const compiled = createExpression(value as never, ROOT_KEY, propertySpec(type));
  if (compiled.result === "error") {
    // A malformed expression (a hand-edited project, an import) falls back to
    // the flat layer value rather than blanking the layer, matching how
    // MapLibre reports a style error and keeps drawing.
    return { read: () => fallback, zoomDependent: false };
  }
  const expression: StyleExpression = compiled.value;
  const zoomDependent = ZOOM_OPERAND.test(JSON.stringify(value));
  return {
    zoomDependent,
    read: (feature, zoom) => {
      try {
        return coerce(expression.evaluate({ zoom }, styleFeature(feature)), fallback);
      } catch {
        return fallback;
      }
    },
  };
}

const asNumber = (raw: unknown, fallback: number): number =>
  typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;

/**
 * Build a resolver for `style`. Compiles each paint channel once; resolving a
 * feature is then a handful of expression evaluations, cheap enough to run
 * per entity on load and again on every opacity change.
 */
export function createFeatureStyleResolver(style: LayerStyle | undefined): FeatureStyleResolver {
  const s: LayerStyle = { ...DEFAULT_LAYER_STYLE, ...style };
  const fillColor = styleValue(s, "fillColor");
  const strokeColor = styleValue(s, "strokeColor");
  const markerBase = normalizeHexColor(styleValue(s, "markerColor")) ?? "#3b82f6";
  const asColor = (raw: unknown, fallback: string) => cssColor(raw, fallback);

  const fill = compileChannel(vectorFillColorValue(s), "color", fillColor, asColor);
  const fillOpacity = compileChannel(
    vectorFillOpacityValue(
      s,
      simpleStyleNumberValue(s, "fill-opacity", styleValue(s, "fillOpacity")),
    ),
    "number",
    styleValue(s, "fillOpacity"),
    asNumber,
  );
  // The same pair the 2D `circlePaint` builds: `marker-color` over the
  // classified colour, and `marker-opacity` over the fill opacity.
  const pointFill = compileChannel(vectorCircleColorValue(s), "color", fillColor, asColor);
  const pointFillOpacity = compileChannel(
    vectorFillOpacityValue(
      s,
      simpleStyleNumberValue(s, "marker-opacity", styleValue(s, "fillOpacity")),
    ),
    "number",
    styleValue(s, "fillOpacity"),
    asNumber,
  );
  const stroke = compileChannel(vectorLineColorValue(s), "color", strokeColor, asColor);
  const outline = compileChannel(vectorOutlineColorValue(s), "color", strokeColor, asColor);
  const strokeWidth = compileChannel(
    lineWidthValue(s),
    "number",
    styleValue(s, "strokeWidth"),
    asNumber,
  );
  const outlineWidth = compileChannel(
    vectorStrokeWidthValue(s, styleValue(s, "strokeWidth")),
    "number",
    styleValue(s, "strokeWidth"),
    asNumber,
  );
  const strokeOpacity = compileChannel(
    simpleStyleNumberValue(s, "stroke-opacity", 1),
    "number",
    1,
    asNumber,
  );
  const radius = compileChannel(
    circleRadiusValue(s),
    "number",
    styleValue(s, "circleRadius"),
    asNumber,
  );
  const markerColor = compileChannel(
    vectorColorExpression(s, markerBase),
    "color",
    markerBase,
    asColor,
  );
  const markerScale = compileChannel(markerIconSizeValue(s), "number", 1, asNumber);

  const channels = [
    fill,
    fillOpacity,
    pointFill,
    pointFillOpacity,
    stroke,
    outline,
    strokeWidth,
    outlineWidth,
    strokeOpacity,
    radius,
    markerColor,
    markerScale,
  ];
  return {
    zoomDependent: channels.some((channel) => channel.zoomDependent),
    resolveMarkerColor: (feature, zoom) => markerColor.read(feature, zoom),
    resolve(feature, zoom) {
      // Lines and polygon outlines are line layers on the 2D map, so they take
      // the line width (metre units, proportional sizing, simplestyle); only
      // circle strokes take the pixel outline width.
      const isPoint =
        feature?.geometry?.type === "Point" || feature?.geometry?.type === "MultiPoint";
      return {
        fill: fill.read(feature, zoom),
        fillOpacity: Math.min(1, Math.max(0, fillOpacity.read(feature, zoom))),
        pointFill: pointFill.read(feature, zoom),
        pointFillOpacity: Math.min(1, Math.max(0, pointFillOpacity.read(feature, zoom))),
        stroke: stroke.read(feature, zoom),
        outline: outline.read(feature, zoom),
        strokeWidth: Math.max(0, (isPoint ? outlineWidth : strokeWidth).read(feature, zoom)),
        strokeOpacity: Math.min(1, Math.max(0, strokeOpacity.read(feature, zoom))),
        radius: Math.max(0, radius.read(feature, zoom)),
        markerColor: markerColor.read(feature, zoom),
        markerScale: Math.max(0, markerScale.read(feature, zoom)),
      };
    },
  };
}
