import { cogSourceUrl, cogRenderSignature } from "./cog-imagery";
import {
  BLEND_MODES,
  compileLayerFilters,
  DEFAULT_BLEND_MODE,
  documentLocale,
  DEFAULT_LAYER_STYLE,
  extrusionColorValue,
  extrusionHeightValue,
  generatorCircleRadiusValue,
  geojsonHasZCoordinates,
  heatmapRampColors,
  labelFieldTextField,
  normalizeHexColor,
  ruleBasedVisibilityFilter,
  styleValue,
  transformGeojsonElevation,
  type GeoLibreLayer,
  type LabelAnchor,
  type LayerStyle,
} from "@geolibre/core";
import { createExpression, featureFilter } from "@maplibre/maplibre-gl-style-spec";
import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
import { createFeatureStyleResolver, type FeatureSymbol } from "./cesium-feature-style";
import { KML_ICON_URL_PROPERTY } from "./markers";
import { compileMapboxLayer } from "./mapbox-layers";
import { arcgisVectorStyle } from "./arcgis-vector-style";
import { proxyWmsTiles } from "./wms-proxy";
import { hasRegisteredProtocol, protocolScheme } from "./cesium-protocol-imagery";
import {
  isTileTemplate,
  needsTemplateTileLayer,
  type ArcgisTileTemplateSource,
} from "./arcgis-template-tiles";
import { imageryColorAdjustments } from "./raster-color-adjustments";
import { ARCGIS_TEXT_FONT } from "./arcgis-sprite";
import {
  DEDUPED_LABEL_PROPERTY,
  GEOMAN_TEXT_PROPERTY,
  getDedupedLabelFeatures,
  isTextMarkerFeature,
  parseLabelOverride,
} from "./label-style";
import {
  buildGeneratedGeometry,
  buildInvertedMask,
  lineDecorationColorValue,
  mapboxRenderableMask,
} from "./derived-geometry";
import { arcgisLineDecorationSymbol, hasLineDecoration } from "./arcgis-line-decoration";

/**
 * Translate a store layer into what the ArcGIS Maps SDK can draw (issue #2421).
 *
 * The SDK has no Style Spec: it draws *layers* (GeoJSONLayer, WebTileLayer,
 * WMSLayer, VectorTileLayer, ...) whose symbology is a *renderer* — a symbol
 * per feature class — rather than paint expressions. So this module does for
 * ArcGIS what `cesium-layer-sync` does for the globe: it evaluates the very
 * same MapLibre expressions `@geolibre/core` builds for the 2D map, per
 * feature, with the style-spec engine, and bakes the answers into the data.
 * Each GeoJSON feature carries three synthetic attributes — its GeoLibre
 * identity, a symbol key and its label text — and the layer's renderer is a
 * `unique-value` renderer over the symbol key with one symbol per distinct
 * answer. Categorized, graduated, rule-based, expression and simplestyle modes
 * all reach the SDK through that one path, so a new style mode landing in
 * `vector-color.ts` reaches this renderer too.
 *
 * Like `mapbox-layers.ts`, this module is pure — it never imports the SDK —
 * and returns a plain, serializable plan that the engine instantiates. That is
 * what makes it unit-testable without a browser or the CDN.
 */

/** Attribute names the compiler adds to every feature it hands the SDK. */
export const ARCGIS_ID_FIELD = "gl__id";
export const ARCGIS_SYMBOL_FIELD = "gl__sym";
export const ARCGIS_LABEL_FIELD = "gl__label";
/** The label class a feature's data-defined label overrides resolve to. */
export const ARCGIS_LABEL_CLASS_FIELD = "gl__lcls";
/** Extrusion height in metres, read by the 3D renderer's size visual variable. */
export const ARCGIS_HEIGHT_FIELD = "gl__height";
export const ARCGIS_WEIGHT_FIELD = "gl__weight";

/** The SDK's geometry kinds a GeoJSONLayer can hold; one layer per kind. */
export type ArcgisGeometryKind = "point" | "polyline" | "polygon";

/** A JSON symbol the SDK autocasts (`simple-fill`, `simple-line`, `simple-marker`, `text`). */
export type ArcgisSymbolJson = Record<string, unknown> & { type: string };

/**
 * A marker the engine still has to bake: the Style panel's shape or custom
 * SVG, tinted per feature. `markers.ts` rasterizes it on a canvas (a DOM
 * operation the pure compiler cannot do), so the plan carries the colour and
 * scale and the circle the layer draws until the sprite is ready.
 */
export interface ArcgisMarkerPlaceholder {
  type: "geolibre-marker";
  color: string;
  scale: number;
  fallback: ArcgisSymbolJson;
}

export function isMarkerPlaceholder(symbol: unknown): symbol is ArcgisMarkerPlaceholder {
  return (
    typeof symbol === "object" &&
    symbol !== null &&
    (symbol as { type?: unknown }).type === "geolibre-marker"
  );
}

/** A JSON renderer the SDK autocasts. */
export type ArcgisRendererJson =
  | {
      type: "heatmap";
      field: string;
      radius: string;
      minDensity: number;
      maxDensity: number;
      colorStops: { ratio: number; color: number[] }[];
      visualVariables?: never;
    }
  | { type: "simple"; symbol: ArcgisSymbolJson; visualVariables?: ArcgisVisualVariableJson[] }
  | {
      type: "unique-value";
      field: string;
      uniqueValueInfos: { value: string; symbol: ArcgisSymbolJson }[];
      visualVariables?: ArcgisVisualVariableJson[];
    };

/** A renderer visual variable; only the extrusion height's size variable occurs. */
export interface ArcgisVisualVariableJson {
  type: "size";
  field: string;
  valueUnit: "meters";
}

export interface ArcgisLabelingJson {
  labelExpressionInfo: { expression: string };
  labelPlacement: string;
  symbol: ArcgisSymbolJson;
  minScale: number;
  maxScale: number;
  deconflictionStrategy: "none" | "static";
  /** SQL where clause limiting the class to some features. */
  where?: string;
}

/** One GeoJSONLayer: the features of a single geometry kind, symbolized. */
export interface ArcgisGeoJsonPart {
  geometryType: ArcgisGeometryKind;
  /** Inline features, handed to the SDK through a blob URL. */
  features?: FeatureCollection;
  /** A remote GeoJSON document the SDK fetches itself (no inline features). */
  url?: string;
  renderer: ArcgisRendererJson;
  labelingInfo?: ArcgisLabelingJson[];
  /**
   * The style whose marker the renderer's {@link ArcgisMarkerPlaceholder}
   * symbols stand in for; present only when a point part uses markers.
   */
  markerStyle?: LayerStyle;
  patternStyle?: LayerStyle;
  /**
   * How the SDK places the features vertically in a `SceneView`. Set on
   * extruded polygons so the extrusion starts at the style's base height.
   */
  elevationInfo?: { mode: "relative-to-ground" | "absolute-height"; offset: number };
  hasZ?: boolean;
  featureReduction?: Record<string, unknown>;
  /**
   * False for a companion part drawn for the layer (an inverted-fill mask, a
   * generated geometry, line decorations, de-duplicated labels): its
   * features are not the layer's, so identify and selection skip it.
   */
  interactive?: false;
}

/** Fields every plan shares; applied to each native layer the plan produces. */
interface ArcgisPlanBase {
  /** The store layer id. */
  id: string;
  title: string;
  visible: boolean;
  opacity: number;
  /** SDK scale bounds; 0 means unbounded. */
  minScale: number;
  maxScale: number;
  /** `[west, south, east, north]` in degrees, when the store knows it. */
  bounds?: [number, number, number, number];
  /**
   * Whether any evaluated expression reads `["zoom"]`, so the answers baked
   * into the features are only right at the zoom they were compiled for and
   * the engine should recompile when the integer zoom changes.
   */
  zoomDependent: boolean;
  /**
   * The raster brightness, contrast, saturation and hue sliders as the SDK's
   * CSS-filter `effect`, or null when they are neutral. Only raster plans
   * apply it, as MapLibre applies them only to raster layers.
   */
  effect: string | null;
  /** The SDK's `blendMode` for the layer's blend mode. */
  blendMode: ArcgisBlendMode;
}

/** The SDK blend modes GeoLibre's {@link BlendMode}s translate to. */
export type ArcgisBlendMode = "normal" | "multiply" | "screen" | "lighten" | "plus";

/**
 * Plan kinds drawn as raster imagery, which take the raster colour effect. A
 * tile archive is raster only when its tiles are; see {@link isArcgisRasterPlan}.
 */
const ARCGIS_RASTER_PLAN_KINDS: ReadonlySet<ArcgisLayerPlan["kind"]> = new Set([
  "web-tile",
  "template-tile",
  "wms",
  "tile-service",
  "map-image",
  "imagery",
  "cog",
  "zarr",
  "archive",
  "media-image",
]);

/**
 * Whether a plan draws raster imagery, which the raster colour sliders apply
 * to (MapLibre applies them to `raster` layers only, never a vector archive's).
 */
export function isArcgisRasterPlan(plan: ArcgisLayerPlan): boolean {
  if (plan.kind === "archive") return plan.tileType === "raster";
  return ARCGIS_RASTER_PLAN_KINDS.has(plan.kind);
}

/**
 * The raster colour sliders as an SDK `effect`. The SDK takes CSS filter
 * functions; `brightness` then `contrast` compose into the same affine map
 * MapLibre's brightness window and contrast produce (the solve is shared with
 * the Cesium engine), and `saturate` and `hue-rotate` follow.
 */
export function arcgisRasterEffect(style: LayerStyle): string | null {
  // The shared solve returns the hue in radians (Cesium's unit); CSS wants degrees.
  const { brightness, contrast, saturation, hue } = imageryColorAdjustments(style);
  const round = (value: number) => Number(value.toFixed(4));
  if (
    round(brightness) === 1 &&
    round(contrast) === 1 &&
    round(saturation) === 1 &&
    round(hue) === 0
  )
    return null;
  return [
    `brightness(${round(brightness)})`,
    `contrast(${round(contrast)})`,
    `saturate(${round(saturation)})`,
    `hue-rotate(${round((hue * 180) / Math.PI)}deg)`,
  ].join(" ");
}

/**
 * GeoLibre's blend mode as the SDK's; MapLibre's additive `add` is the SDK's
 * `plus`. The membership check guards a hand-edited project whose value the
 * type does not describe.
 */
export function arcgisBlendMode(style: Partial<LayerStyle> | undefined): ArcgisBlendMode {
  const mode = style?.blendMode ?? DEFAULT_BLEND_MODE;
  return mode === "add" ? "plus" : BLEND_MODES.includes(mode) ? mode : "normal";
}

export type ArcgisLayerPlan = ArcgisPlanBase &
  (
    | {
        kind: "archive";
        format: "pmtiles" | "protocol";
        url: string;
        tileType: "vector" | "raster";
        sourceId: string;
        styleLayers: unknown[];
        tileOptions: Record<string, unknown>;
      }
    | { kind: "external-deck" }
    | { kind: "geojson"; parts: ArcgisGeoJsonPart[] }
    | { kind: "cog" | "zarr"; source: GeoLibreLayer; renderSignature: string }
    | {
        kind: "web-tile";
        urlTemplate: string;
        subDomains?: string[];
        copyright?: string;
      }
    | ({ kind: "template-tile"; copyright?: string } & ArcgisTileTemplateSource)
    | {
        kind: "wms";
        url: string;
        sublayers: { name: string }[];
        version?: string;
        imageFormat?: string;
        imageTransparency: boolean;
        customParameters?: Record<string, string>;
      }
    | { kind: "vector-tile"; style: Record<string, unknown> }
    | {
        kind: "feature-service";
        url: string;
        /**
         * The layer's own symbol per geometry kind; the engine picks the one
         * matching the service's geometry type once loaded.
         */
        symbols?: Record<ArcgisGeometryKind, ArcgisSymbolJson>;
        /** The layer's filters as an SQL where clause, when they translate. */
        definitionExpression?: string;
        /** Filters are active but have no SQL form; the service draws unfiltered. */
        filterUnsupported?: boolean;
      }
    | { kind: "tile-service"; url: string }
    | { kind: "map-image"; url: string }
    | { kind: "imagery"; url: string }
    | {
        kind: "media-image";
        url: string;
        /** Top-left, top-right, bottom-right, bottom-left, as MapLibre orders them. */
        corners: [Position, Position, Position, Position];
        extent: [number, number, number, number];
      }
  );

export interface CompileArcgisLayerOptions {
  /** Whether a primary flat map or local scene hosts the shared deck overlay. */
  deckOverlay?: boolean;
  /** Zoom the per-feature expressions are evaluated at. */
  zoom?: number;
  /**
   * Validate that the layer has an ArcGIS translation without processing its
   * features. The layer panels ask on every render; a full compile of a large
   * GeoJSON layer per render would be wasted work.
   */
  probe?: boolean;
  /**
   * Compile for a 3D `SceneView`: polygons whose style extrudes become
   * `polygon-3d` extrusions. A flat `MapView` cannot draw 3D symbols, so the
   * 2D compile keeps them as fills.
   */
  scene?: boolean;
}

/** Web Mercator scale denominator at zoom 0 for 256 px tiles at 96 dpi. */
const SCALE_AT_ZOOM_0 = 591657527.591555;

/** The SDK's scale denominator for a MapLibre zoom level. */
export function zoomToScale(zoom: number): number {
  return SCALE_AT_ZOOM_0 / 2 ** zoom;
}

/** MapLibre zoom for an SDK scale denominator. */
export function scaleToZoom(scale: number): number {
  return Math.log2(SCALE_AT_ZOOM_0 / scale);
}

/**
 * SDK scale bounds for a MapLibre zoom range. `minScale` is the most zoomed-out
 * scale a layer draws at (the store's `minZoom`), `maxScale` the most zoomed-in
 * (`maxZoom`); 0 lifts the bound, which is what an unrestricted range compiles
 * to so the SDK never hides a layer past its tiling scheme.
 */
export function zoomRangeToScales(
  minZoom: number,
  maxZoom: number,
): { minScale: number; maxScale: number } {
  return {
    minScale: minZoom > 0 ? zoomToScale(minZoom) : 0,
    maxScale: maxZoom < 24 ? zoomToScale(maxZoom) : 0,
  };
}

/**
 * Parse a CSS colour the style engine or the Style panel produced into the
 * `[r, g, b, a]` array the SDK's symbols take. `#rgb`, `#rrggbb`, `#rrggbbaa`
 * and `rgb()`/`rgba()` are the forms that occur; anything else yields opaque
 * black rather than an SDK error.
 */
export function cssToArcgisColor(css: string, alpha = 1): [number, number, number, number] {
  const a = Math.min(1, Math.max(0, alpha));
  const hex = normalizeHexColor(css);
  if (hex) {
    return [
      Number.parseInt(hex.slice(1, 3), 16),
      Number.parseInt(hex.slice(3, 5), 16),
      Number.parseInt(hex.slice(5, 7), 16),
      a,
    ];
  }
  const long = css.trim().match(/^#([0-9a-f]{6})([0-9a-f]{2})$/i);
  if (long) {
    const hex8 = long[1];
    return [
      Number.parseInt(hex8.slice(0, 2), 16),
      Number.parseInt(hex8.slice(2, 4), 16),
      Number.parseInt(hex8.slice(4, 6), 16),
      (Number.parseInt(long[2], 16) / 255) * a,
    ];
  }
  const rgb = css
    .trim()
    .match(
      /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i,
    );
  if (rgb) {
    const channel = (v: string) => Math.max(0, Math.min(255, Math.round(Number(v))));
    const alphaPart = rgb[4];
    const parsed =
      alphaPart === undefined
        ? 1
        : alphaPart.endsWith("%")
          ? Number(alphaPart.slice(0, -1)) / 100
          : Number(alphaPart);
    return [
      channel(rgb[1]),
      channel(rgb[2]),
      channel(rgb[3]),
      (Number.isFinite(parsed) ? parsed : 1) * a,
    ];
  }
  return [0, 0, 0, a];
}

const GEOMETRY_KIND: Record<string, ArcgisGeometryKind | undefined> = {
  Point: "point",
  MultiPoint: "point",
  LineString: "polyline",
  MultiLineString: "polyline",
  Polygon: "polygon",
  MultiPolygon: "polygon",
};

/** Numeric feature type the style-spec filter evaluator expects. */
const FILTER_TYPE: Record<string, 1 | 2 | 3> = {
  Point: 1,
  MultiPoint: 1,
  LineString: 2,
  MultiLineString: 2,
  Polygon: 3,
  MultiPolygon: 3,
};

/** MapLibre's text-anchor to the SDK's point label placement. */
const POINT_PLACEMENT: Record<LabelAnchor, string> = {
  center: "center-center",
  // The anchor names where the text is *pinned*, so text anchored at its top
  // hangs below the point.
  top: "below-center",
  bottom: "above-center",
  left: "center-right",
  right: "center-left",
  "top-left": "below-right",
  "top-right": "below-left",
  "bottom-left": "above-right",
  "bottom-right": "above-left",
};

/** A KML feature's own icon, or a marker configured in the Style panel. */
function pointMarkerSymbol(
  style: LayerStyle,
  feature: Feature,
  symbol: FeatureSymbol,
  circle: ArcgisSymbolJson,
): ArcgisSymbolJson | ArcgisMarkerPlaceholder {
  const icon = feature.properties?.[KML_ICON_URL_PROPERTY];
  if (typeof icon === "string" && /^(?:https?:|data:image\/)/i.test(icon)) {
    const size = `${Math.max(1, style.markerSize)}px`;
    return { type: "picture-marker", url: icon, width: size, height: size };
  }
  if (style.markerEnabled)
    return {
      type: "geolibre-marker",
      color: symbol.markerColor,
      scale: symbol.markerScale,
      fallback: circle,
    };
  return circle;
}

function symbolForKind(kind: ArcgisGeometryKind, symbol: FeatureSymbol): ArcgisSymbolJson {
  const px = (value: number) => `${Math.max(0, value)}px`;
  switch (kind) {
    case "polygon":
      return {
        type: "simple-fill",
        style: "solid",
        color: cssToArcgisColor(symbol.fill, symbol.fillOpacity),
        outline:
          symbol.strokeWidth > 0
            ? {
                style: "solid",
                color: cssToArcgisColor(symbol.stroke, symbol.strokeOpacity),
                width: px(symbol.strokeWidth),
              }
            : { style: "none", width: 0 },
      };
    case "polyline":
      return {
        type: "simple-line",
        style: "solid",
        color: cssToArcgisColor(symbol.stroke, symbol.strokeOpacity),
        width: px(symbol.strokeWidth),
        cap: "round",
        join: "round",
      };
    case "point":
      return {
        type: "simple-marker",
        style: "circle",
        color: cssToArcgisColor(symbol.pointFill, symbol.pointFillOpacity),
        size: px(symbol.radius * 2),
        outline:
          symbol.strokeWidth > 0
            ? {
                style: "solid",
                color: cssToArcgisColor(symbol.outline, symbol.strokeOpacity),
                width: px(symbol.strokeWidth),
              }
            : { style: "none", width: 0 },
      };
  }
}

/** The style-spec feature shape for `createExpression` evaluation. */
function styleFeature(feature: Feature) {
  const type = feature.geometry?.type;
  return {
    type:
      type && FILTER_TYPE[type]
        ? ["", "Point", "LineString", "Polygon"][FILTER_TYPE[type]]
        : "Unknown",
    properties: feature.properties ?? {},
    ...(feature.id !== undefined ? { id: feature.id } : {}),
    geometry: feature.geometry,
  } as never;
}

/** The style-spec feature shape for `featureFilter` evaluation. */
function filterFeature(feature: Feature) {
  const type = feature.geometry?.type;
  return {
    type: (type && FILTER_TYPE[type]) ?? 1,
    properties: feature.properties ?? {},
    ...(feature.id !== undefined ? { id: feature.id } : {}),
    geometry: feature.geometry,
  } as never;
}

const ZOOM_OPERAND = /\[\s*"zoom"\s*\]/;

/** The layer's active filters as one MapLibre filter expression, or null. */
function activeFilters(layer: GeoLibreLayer): unknown[] | null {
  const filters = [
    compileLayerFilters(layer),
    layer.timeFilter,
    layer.embedFilter,
    ruleBasedVisibilityFilter(layer.style),
    // Hidden annotations stay in the collection, as MapLibre's layer sync
    // filters them out rather than dropping them.
    layer.metadata.sourceKind === "annotation" ? ["!=", ["get", "visible"], false] : null,
  ].filter(Boolean) as unknown[][];
  if (filters.length === 0) return null;
  return filters.length === 1 ? filters[0] : ["all", ...filters];
}

const SQL_FIELD = /^[A-Za-z_][A-Za-z0-9_.]*$/;

/** A `["get", f]`, optionally wrapped in a coercion, as the bare field name. */
function sqlField(operand: unknown): string | null {
  if (!Array.isArray(operand)) return null;
  const [op, inner] = operand;
  if (op === "get" && typeof inner === "string") return SQL_FIELD.test(inner) ? inner : null;
  if (op === "to-number" || op === "to-string") return sqlField(inner);
  return null;
}

function sqlLiteral(value: unknown): string | null {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  return null;
}

/** `["downcase", ["to-string", ["get", f]]]`, the quick text filter's haystack. */
function sqlLowerField(operand: unknown): string | null {
  if (!Array.isArray(operand) || operand[0] !== "downcase") return null;
  const field = sqlField(operand[1]);
  return field ? `UPPER(${field})` : null;
}

function sqlLike(needle: unknown, pattern: (escaped: string) => string): string | null {
  if (typeof needle !== "string") return null;
  const escaped = needle.replace(/'/g, "''").replace(/[%_]/g, "\\$&");
  return `'${pattern(escaped.toUpperCase())}' ESCAPE '\\'`;
}

/**
 * Translate a MapLibre filter expression into an ArcGIS SQL where clause, or
 * null when it uses a construct SQL has no equivalent for. The quick filters
 * (`quick-filters.ts`) and the expression builder's common comparisons all
 * translate; anything else leaves the service unfiltered, which the plan
 * reports so the engine can say so.
 */
export function filterToSql(filter: unknown): string | null {
  if (!Array.isArray(filter) || filter.length === 0) return null;
  const [op, ...args] = filter as [string, ...unknown[]];
  switch (op) {
    case "all":
    case "any": {
      const parts = args.map(filterToSql);
      if (parts.length === 0 || parts.some((part) => part === null)) return null;
      return parts.length === 1
        ? parts[0]
        : parts.map((p) => `(${p})`).join(op === "all" ? " AND " : " OR ");
    }
    case "!": {
      const inner = filterToSql(args[0]);
      return inner === null ? null : `NOT (${inner})`;
    }
    case "has":
      return typeof args[0] === "string" && SQL_FIELD.test(args[0])
        ? `${args[0]} IS NOT NULL`
        : null;
    case "!has":
      return typeof args[0] === "string" && SQL_FIELD.test(args[0]) ? `${args[0]} IS NULL` : null;
    case "in": {
      const field = sqlField(args[0]);
      const list = Array.isArray(args[1]) && args[1][0] === "literal" ? args[1][1] : args.slice(1);
      if (!field || !Array.isArray(list) || list.length === 0) return null;
      const values = list.map(sqlLiteral);
      return values.some((v) => v === null) ? null : `${field} IN (${values.join(", ")})`;
    }
    case "==":
    case "!=":
    case "<":
    case "<=":
    case ">":
    case ">=": {
      const [left, right] = args;
      // The quick text filter's three operators.
      const lowered = sqlLowerField(left);
      if (lowered) {
        if (op !== "==" || typeof right !== "string") return null;
        return `${lowered} = ${sqlLiteral(right.toUpperCase())}`;
      }
      if (Array.isArray(left) && left[0] === "index-of") {
        const haystack = sqlLowerField(left[2]);
        if (!haystack) return null;
        if (op === "==" && right === 0) {
          const like = sqlLike(left[1], (n) => `${n}%`);
          return like ? `${haystack} LIKE ${like}` : null;
        }
        if (op === "!=" && right === -1) {
          const like = sqlLike(left[1], (n) => `%${n}%`);
          return like ? `${haystack} LIKE ${like}` : null;
        }
        return null;
      }
      const field = sqlField(left);
      if (!field) return null;
      if (right === null) {
        if (op === "==") return `${field} IS NULL`;
        if (op === "!=") return `${field} IS NOT NULL`;
        return null;
      }
      const literal = sqlLiteral(right);
      if (literal === null) return null;
      return `${field} ${op === "==" ? "=" : op === "!=" ? "<>" : op} ${literal}`;
    }
    default:
      return null;
  }
}

/**
 * Whether `feature` passes the layer's active filters at `zoom`, the way the
 * compiler decides which features reach the SDK. The engine's synchronous
 * identify uses it so a filtered-out feature cannot be picked.
 */
export function featurePassesFilters(
  layer: GeoLibreLayer,
  feature: Feature,
  zoom: number,
): boolean {
  const filter = compileFilter(layer);
  return filter.test ? filter.test(feature, zoom) : true;
}

/**
 * Whether `lngLat` is on `geometry`, with `tolerance` in degrees of longitude
 * (already scaled for latitude by the caller) for points and lines. A pure
 * geometric test the engine uses for the synchronous identify, which the SDK
 * can only answer asynchronously.
 */
export function geometryContainsPoint(
  geometry: Geometry,
  lngLat: [number, number],
  tolerance: number,
): boolean {
  const [x, y] = lngLat;
  const near = (p: Position) => Math.hypot(p[0] - x, p[1] - y) <= tolerance;
  const nearSegment = (a: Position, b: Position) => {
    const dx = b[0] - a[0],
      dy = b[1] - a[1];
    const length = dx * dx + dy * dy;
    const t =
      length === 0 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / length));
    return Math.hypot(a[0] + t * dx - x, a[1] + t * dy - y) <= tolerance;
  };
  const nearLine = (line: Position[]) => line.some((p, i) => i > 0 && nearSegment(line[i - 1], p));
  const inRing = (ring: Position[]) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i],
        [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const inPolygon = (rings: Position[][]) =>
    rings.length > 0 && inRing(rings[0]) && !rings.slice(1).some(inRing);
  switch (geometry.type) {
    case "Point":
      return near(geometry.coordinates);
    case "MultiPoint":
      return geometry.coordinates.some(near);
    case "LineString":
      return nearLine(geometry.coordinates);
    case "MultiLineString":
      return geometry.coordinates.some(nearLine);
    case "Polygon":
      return inPolygon(geometry.coordinates);
    case "MultiPolygon":
      return geometry.coordinates.some(inPolygon);
    case "GeometryCollection":
      return geometry.geometries.some((g) => geometryContainsPoint(g, lngLat, tolerance));
    default:
      return false;
  }
}

/**
 * Compile the layer's active filters into one predicate, or `null` when the
 * layer has none (or one the style-spec rejects, in which case nothing is
 * filtered rather than everything hidden, matching how MapLibre reports a
 * style error and keeps drawing).
 */
function compileFilter(layer: GeoLibreLayer): {
  test: ((feature: Feature, zoom: number) => boolean) | null;
  zoomDependent: boolean;
} {
  const filter = activeFilters(layer);
  if (!filter) return { test: null, zoomDependent: false };
  try {
    const compiled = featureFilter(filter as never, "layers[0].filter");
    return {
      test: (feature, zoom) => {
        try {
          return compiled.filter({ zoom }, filterFeature(feature), undefined as never);
        } catch {
          return true;
        }
      },
      zoomDependent: ZOOM_OPERAND.test(JSON.stringify(filter)),
    };
  } catch {
    return { test: null, zoomDependent: false };
  }
}

/** The label style's case transform, as MapLibre's `text-transform`. */
function labelTransform(style: LayerStyle): (text: string) => string {
  const transform = style.labels.transform;
  return (text) =>
    transform === "uppercase"
      ? text.toUpperCase()
      : transform === "lowercase"
        ? text.toLowerCase()
        : text;
}

/**
 * The label text of each feature, evaluated from the label style the way the
 * 2D map's symbol layer would (field with number formatting, or the user's
 * expression), or `null` when labels are off.
 */
function compileLabelText(
  style: LayerStyle,
): { read: (feature: Feature, zoom: number) => string; zoomDependent: boolean } | null {
  const labels = style.labels;
  if (!labels.enabled || (!labels.field && !labels.expression.trim())) return null;
  // Number formatting follows the app's locale, as on the 2D map.
  let value: unknown = labelFieldTextField(labels, documentLocale());
  if (labels.expression.trim()) {
    try {
      value = JSON.parse(labels.expression);
    } catch {
      // An unparseable expression keeps the field text, as on Mapbox.
    }
  }
  const transform = labelTransform(style);
  if (typeof value === "string") {
    const text = transform(value);
    return { read: () => text, zoomDependent: false };
  }
  if (!Array.isArray(value)) return null;
  const compiled = createExpression(value as never, "expression", {
    type: "string",
    "property-type": "data-driven",
    expression: { parameters: ["zoom", "feature"] },
  } as never);
  if (compiled.result === "error") return null;
  const expression = compiled.value;
  return {
    zoomDependent: ZOOM_OPERAND.test(JSON.stringify(value)),
    read: (feature, zoom) => {
      try {
        const result = expression.evaluate({ zoom }, styleFeature(feature));
        return result == null ? "" : transform(String(result));
      } catch {
        return "";
      }
    },
  };
}

/** One label class of the data-defined label overrides: a size and colour. */
interface LabelClassStyle {
  id: string;
  size: number;
  color: [number, number, number, number];
}

function labelingFor(
  kind: ArcgisGeometryKind,
  style: LayerStyle,
  layerScales: { minScale: number; maxScale: number },
  classes?: LabelClassStyle[],
): ArcgisLabelingJson[] {
  const labels = style.labels;
  const scales = zoomRangeToScales(
    Math.max(style.minZoom, labels.minZoom),
    Math.min(style.maxZoom, labels.maxZoom),
  );
  const placement =
    kind === "point"
      ? (POINT_PLACEMENT[labels.anchor] ?? "above-center")
      : kind === "polyline"
        ? labels.placement === "line"
          ? "center-along"
          : "above-along"
        : "always-horizontal";
  const labelClass = (
    size: number,
    color: [number, number, number, number],
    where?: string,
  ): ArcgisLabelingJson => ({
    labelExpressionInfo: { expression: `$feature.${ARCGIS_LABEL_FIELD}` },
    labelPlacement: placement,
    ...(where ? { where } : {}),
    symbol: {
      type: "text",
      color,
      haloColor: cssToArcgisColor(labels.haloColor),
      haloSize: `${Math.max(0, labels.haloWidth)}px`,
      font: { size: `${size}px`, family: "sans-serif" },
      // MapLibre wraps at `text-max-width` ems of the text size.
      lineWidth: `${Math.max(1, labels.maxWidth ?? 10) * size}px`,
      // MapLibre offsets are in ems of the text size, y down; the SDK's are
      // in points or pixels, y up.
      xoffset: `${labels.offsetX * size}px`,
      yoffset: `${-labels.offsetY * size}px`,
      angle: labels.rotation,
    },
    // The intersection with the layer's own scale range, so a label never
    // shows where its features are hidden.
    minScale:
      scales.minScale === 0
        ? layerScales.minScale
        : Math.min(scales.minScale, layerScales.minScale || Infinity),
    maxScale: Math.max(scales.maxScale, layerScales.maxScale),
    deconflictionStrategy: labels.allowOverlap ? "none" : "static",
  });
  // Data-defined overrides: one class per distinct size and colour, each
  // reading the features the compiler assigned to it.
  if (classes)
    return classes.map(({ id, size, color }) =>
      labelClass(size, color, `${ARCGIS_LABEL_CLASS_FIELD} = '${id}'`),
    );
  return [labelClass(Math.max(1, labels.size), cssToArcgisColor(labels.color))];
}

/** A feature's resolved data-defined label overrides. */
interface LabelOverrideValues {
  /** False when the visibility expression hides the feature's label. */
  visible: boolean;
  size: number;
  color: [number, number, number, number];
}

/**
 * The data-defined label overrides (`sizeExpression`, `colorExpression`,
 * `opacityExpression`, `visibilityExpression`) evaluated per feature, or
 * `null` when none is set. The SDK's label symbols are not data-driven, so the
 * compiler groups features into one label class per resolved size and colour
 * instead. Invalid expressions fall back to the literal control, as
 * `parseLabelOverride` does on the 2D map. The SDK has no per-feature label
 * priority, so `priorityExpression` is not drawn (the Style panel says so).
 *
 * @param style - The layer style.
 * @param layerOpacity - The layer's opacity, which the native layer applies to
 *   its labels too: an opacity override replaces it on the 2D map.
 */
function compileLabelOverrides(
  style: LayerStyle,
  layerOpacity: number,
): {
  read: (feature: Feature, zoom: number) => LabelOverrideValues;
  zoomDependent: boolean;
} | null {
  const labels = style.labels;
  const size = parseLabelOverride(labels.sizeExpression, "number");
  const color = parseLabelOverride(labels.colorExpression, "color");
  const opacity = parseLabelOverride(labels.opacityExpression, "number");
  const visibility = parseLabelOverride(labels.visibilityExpression, "boolean");
  if (!size && !color && !opacity && !visibility) return null;
  const readers = {
    size: size ? featureValue(size, "number") : null,
    color: color ? featureValue(color, "color") : null,
    opacity: opacity ? featureValue(opacity, "number") : null,
    visibility: visibility ? featureValue(visibility, "boolean") : null,
  };
  const baseSize = Math.max(1, labels.size);
  const finite = (value: unknown, fallback: number) => {
    const number = Number(value);
    return value != null && Number.isFinite(number) ? number : fallback;
  };
  return {
    zoomDependent: Object.values(readers).some((reader) => reader?.zoomDependent),
    read(feature, zoom) {
      // Half-pixel sizes and 5 % opacity steps: a continuous expression
      // would otherwise make a label class per feature (colours are binned
      // by `assignLabelClasses` once there are too many).
      const textSize = readers.size
        ? Math.max(1, Math.round(finite(readers.size.read(feature, zoom), baseSize) * 2) / 2)
        : baseSize;
      const colorValue = readers.color?.read(feature, zoom);
      const rgba = cssToArcgisColor(colorValue == null ? labels.color : String(colorValue));
      if (readers.opacity) {
        // The native layer multiplies its labels by the layer opacity, which
        // the override replaces. It can only be divided out, so a label cannot
        // be more opaque than its layer (an override above the layer opacity
        // reaches the layer's).
        const target = Math.min(1, Math.max(0, finite(readers.opacity.read(feature, zoom), 1)));
        const alpha = layerOpacity > 0 ? Math.min(1, target / layerOpacity) : 1;
        rgba[3] = Math.round(rgba[3] * alpha * 20) / 20;
      }
      return {
        visible: readers.visibility ? readers.visibility.read(feature, zoom) !== false : true,
        size: textSize,
        color: rgba,
      };
    },
  };
}

/** Split a MultiPoint into Points so every feature of the part is one marker. */
function explodePoints(geometry: Geometry): Geometry[] {
  if (geometry.type === "MultiPoint")
    return geometry.coordinates.map((position) => ({ type: "Point", coordinates: position }));
  if (geometry.type === "GeometryCollection")
    return geometry.geometries.flatMap((member) => explodePoints(member));
  return [geometry];
}

/**
 * Compile a GeoJSON-backed layer into one part per geometry kind present, the
 * features carrying their identity, symbol key and label text.
 */
/**
 * Per-feature extrusion for a 3D scene. The height and colour are the very
 * values MapLibre paints (`extrusionHeightValue` / `extrusionColorValue` in
 * `@geolibre/core`), evaluated per feature: so categorized, graduated and
 * rule-based colours, the advanced expressions, and an empty height property
 * (a flat extrusion) behave as on the 2D map. As there, the height is the top
 * of the extrusion and the base its bottom, both in metres above the ground.
 */
interface ExtrusionReader {
  base: number;
  zoomDependent: boolean;
  height(feature: Feature, zoom: number): number;
  symbol(feature: Feature, zoom: number): ArcgisSymbolJson;
}

/** Compile a constant or MapLibre expression into a per-feature evaluator. */
function featureValue(
  value: unknown,
  type: "number" | "color" | "boolean",
): { read: (feature: Feature, zoom: number) => unknown; zoomDependent: boolean } {
  if (!Array.isArray(value)) return { read: () => value, zoomDependent: false };
  const compiled = createExpression(value, "expression", {
    type,
    "property-type": "data-driven",
    expression: { parameters: ["zoom", "feature"] },
  } as never);
  if (compiled.result === "error") return { read: () => undefined, zoomDependent: false };
  const expression = compiled.value;
  return {
    zoomDependent: ZOOM_OPERAND.test(JSON.stringify(value)),
    read: (feature, zoom) => {
      try {
        return expression.evaluate({ zoom }, styleFeature(feature));
      } catch {
        return undefined;
      }
    },
  };
}

function compileExtrusion(style: LayerStyle): ExtrusionReader {
  const base = Number.isFinite(style.extrusionBase) ? style.extrusionBase : 0;
  const opacity = Number.isFinite(style.extrusionOpacity) ? style.extrusionOpacity : 0.8;
  const fallbackColor = style.extrusionColor || style.fillColor || "#3b82f6";
  const height = featureValue(extrusionHeightValue(style), "number");
  const color = featureValue(extrusionColorValue(style), "color");
  return {
    base,
    zoomDependent: height.zoomDependent || color.zoomDependent,
    height(feature, zoom) {
      const value = Number(height.read(feature, zoom));
      // The SDK extrudes by a size above the base; a top below the base is flat.
      return Math.max(0, (Number.isFinite(value) ? value : 0) - base);
    },
    symbol(feature, zoom) {
      const value = color.read(feature, zoom);
      return {
        type: "polygon-3d",
        symbolLayers: [
          {
            type: "extrude",
            material: {
              color: cssToArcgisColor(value == null ? fallbackColor : String(value), opacity),
            },
          },
        ],
      };
    },
  };
}

function heatmapWeight(feature: Feature, style: LayerStyle): number {
  const field = style.heatmapWeightProperty.trim();
  const value = field ? Number(feature.properties?.[field] ?? 0) : 1;
  const intensity = Number.isFinite(style.heatmapIntensity)
    ? Math.max(0, style.heatmapIntensity)
    : 1;
  return (Number.isFinite(value) ? Math.max(0, value) : 0) * intensity;
}

function heatmapRenderer(style: LayerStyle, scene: boolean): ArcgisRendererJson {
  const colors = heatmapRampColors(style);
  const radius = Number.isFinite(style.heatmapRadius) ? Math.max(1, style.heatmapRadius) : 30;
  return {
    type: "heatmap",
    field: ARCGIS_WEIGHT_FIELD,
    // SceneView caps its kernel at 112 points (149 1/3 CSS pixels).
    radius: `${scene ? Math.min(radius, (112 * 4) / 3) : radius}px`,
    minDensity: 0,
    // Esri's default density scale. Its kernel differs from MapLibre's;
    // intensity multiplies the baked weights so zero also hides the heatmap.
    maxDensity: 0.04,
    colorStops: [
      { ratio: 0, color: [0, 0, 0, 0] },
      ...colors.map((color, index) => ({
        ratio: (index + 1) / colors.length,
        color: cssToArcgisColor(color),
      })),
    ],
  };
}

function compileGeoJson(
  layer: GeoLibreLayer,
  geojson: FeatureCollection,
  zoom: number,
  probe: boolean,
  scene: boolean,
): { parts: ArcgisGeoJsonPart[]; zoomDependent: boolean } {
  const style: LayerStyle = { ...DEFAULT_LAYER_STYLE, ...layer.style };
  if (probe) return { parts: [], zoomDependent: false };
  const extrusion = scene && style.extrusionEnabled ? compileExtrusion(style) : null;
  const elevated =
    scene && !extrusion && style.elevation3dEnabled && geojsonHasZCoordinates(geojson, true);
  const data = elevated
    ? transformGeojsonElevation(
        geojson,
        Number.isFinite(style.elevation3dVerticalScale) ? style.elevation3dVerticalScale : 1,
        Number.isFinite(style.elevation3dOffset) ? style.elevation3dOffset : 0,
      )
    : geojson;
  const resolver = createFeatureStyleResolver(style);
  const filter = compileFilter(layer);
  const label = compileLabelText(style);
  const scales = zoomRangeToScales(style.minZoom, style.maxZoom);
  // Label de-duplication groups points on the label field (`label-dedup.ts`).
  // As on the 2D map it needs point-only, unfiltered data, so the aggregated
  // labels agree with the points drawn.
  const deduped =
    label &&
    style.labels.dedupe !== "off" &&
    style.labels.field &&
    !filter.test &&
    isPointOnly(geojson)
      ? getDedupedLabelFeatures(geojson, style.labels)
      : null;
  // The aggregated labels carry only their text, so the overrides do not
  // apply to them (as on the 2D map).
  const overrides =
    label && !deduped
      ? compileLabelOverrides(style, Math.min(1, Math.max(0, layer.opacity)))
      : null;
  const overridden = new Map<Feature, LabelOverrideValues>();
  // The source features that pass the filter, for the inverted-fill mask and
  // the geometry generator.
  const kept: Feature[] = [];
  // Symbols are keyed by their JSON for de-duplication but the features carry
  // a short id: the SDK stores string attributes as fixed-length fields, and a
  // 100-character key was truncated past the point where two symbols differ,
  // which rendered every class in the first class's colour.
  const parts = new Map<
    ArcgisGeometryKind,
    {
      features: Feature[];
      symbols: Map<string, { id: string; symbol: ArcgisSymbolJson | ArcgisMarkerPlaceholder }>;
    }
  >();
  // Geo Editor text markers (and annotation text) are drawn as their own
  // text, not as points with the layer's label; each distinct colour is one
  // label class, keyed through the symbol field.
  const textMarkers: Feature[] = [];
  const textColors = new Map<string, string>();
  data.features.forEach((feature, index) => {
    if (!feature.geometry) return;
    if (filter.test && !filter.test(feature, zoom)) return;
    const id = String(feature.id ?? index);
    if (isTextMarkerFeature(feature)) {
      const props = feature.properties ?? {};
      const color =
        typeof props["text-color"] === "string" && props["text-color"]
          ? props["text-color"]
          : style.textColor;
      let colorId = textColors.get(color);
      if (colorId === undefined) {
        colorId = `t${textColors.size}`;
        textColors.set(color, colorId);
      }
      const text = String(props[GEOMAN_TEXT_PROPERTY] ?? props.text ?? "");
      for (const geometry of explodePoints(feature.geometry)) {
        if (GEOMETRY_KIND[geometry.type] !== "point") continue;
        textMarkers.push({
          type: "Feature",
          geometry,
          properties: {
            [ARCGIS_ID_FIELD]: id,
            [ARCGIS_SYMBOL_FIELD]: colorId,
            [ARCGIS_LABEL_FIELD]: text,
          },
        });
      }
      return;
    }
    kept.push(geojson.features[index]);
    let symbol: ReturnType<typeof resolver.resolve> | undefined;
    const override = overrides?.read(feature, zoom);
    const text = label && !deduped && override?.visible !== false ? label.read(feature, zoom) : "";
    for (const geometry of explodePoints(feature.geometry)) {
      const kind = GEOMETRY_KIND[geometry.type];
      if (!kind) continue;
      const extruded = extrusion !== null && kind === "polygon";
      let part = parts.get(kind);
      if (!part) {
        part = { features: [], symbols: new Map() };
        parts.set(kind, part);
      }
      let symbolId = "heatmap";
      if (!(kind === "point" && style.pointRenderer === "heatmap")) {
        symbol ??= resolver.resolve(feature, zoom);
        const shape = extruded ? extrusion.symbol(feature, zoom) : symbolForKind(kind, symbol);
        const json = kind === "point" ? pointMarkerSymbol(style, feature, symbol, shape) : shape;
        const key = JSON.stringify(json);
        let entry = part.symbols.get(key);
        if (!entry) {
          entry = { id: `s${part.symbols.size}`, symbol: json };
          part.symbols.set(key, entry);
        }
        symbolId = entry.id;
      }
      const out: Feature = {
        type: "Feature",
        geometry,
        properties: {
          [ARCGIS_ID_FIELD]: id,
          [ARCGIS_SYMBOL_FIELD]: symbolId,
          [ARCGIS_LABEL_FIELD]: text,
          ...(kind === "point" && style.pointRenderer === "heatmap"
            ? { [ARCGIS_WEIGHT_FIELD]: heatmapWeight(feature, style) }
            : {}),
          ...(extruded ? { [ARCGIS_HEIGHT_FIELD]: extrusion.height(feature, zoom) } : {}),
        },
      };
      if (override) overridden.set(out, override);
      part.features.push(out);
    }
  });
  const labelClassList = overrides ? assignLabelClasses(overridden) : undefined;
  const source = derivedSource(geojson, kept);
  const maskPart =
    style.invertedFillEnabled && !extrusion && parts.has("polygon")
      ? invertedMaskPart(source, style, resolver, zoom, scene)
      : null;
  if (maskPart) {
    // The features keep their outlines; the mask carries the fill.
    for (const entry of parts.get("polygon")!.symbols.values())
      entry.symbol = { ...(entry.symbol as ArcgisSymbolJson), color: [0, 0, 0, 0] };
  }
  const generatorParts = extrusion ? [] : generatedGeometryParts(source, style, zoom);
  const decorationPart =
    !scene && !extrusion && hasLineDecoration(style)
      ? lineDecorationPart(style, [
          ...(parts.get("polyline")?.features ?? []),
          ...(parts.get("polygon")?.features ?? []),
        ])
      : null;
  const dedupedPart: ArcgisGeoJsonPart | null = deduped
    ? {
        geometryType: "point",
        features: {
          type: "FeatureCollection",
          features: deduped.features.map((feature) => ({
            type: "Feature",
            geometry: feature.geometry,
            properties: {
              [ARCGIS_SYMBOL_FIELD]: "s0",
              [ARCGIS_LABEL_FIELD]: labelTransform(style)(
                String(feature.properties?.[DEDUPED_LABEL_PROPERTY] ?? ""),
              ),
            },
          })),
        },
        // The points are drawn by the layer's own part; this one only labels.
        renderer: {
          type: "simple",
          symbol: { type: "simple-marker", color: [0, 0, 0, 0], size: 0, outline: null },
        } as unknown as ArcgisRendererJson,
        labelingInfo: labelingFor("point", style, scales),
        interactive: false,
      }
    : null;
  // A stable order — polygons under lines under points — so the SDK draws the
  // kinds the way the 2D map stacks its fill, line and circle layers.
  const order: ArcgisGeometryKind[] = ["polygon", "polyline", "point"];
  const textPart: ArcgisGeoJsonPart[] = textMarkers.length
    ? [
        {
          geometryType: "point",
          features: { type: "FeatureCollection", features: textMarkers },
          // The text is the marker: the point itself draws nothing.
          // Transparent but sized, so a click on the marker still hits it.
          renderer: {
            type: "simple",
            symbol: { type: "simple-marker", color: [0, 0, 0, 0], size: 12, outline: null },
          } as unknown as ArcgisRendererJson,
          labelingInfo: [...textColors].map(([color, colorId]) => ({
            labelExpressionInfo: { expression: `$feature.${ARCGIS_LABEL_FIELD}` },
            labelPlacement: "center-center",
            where: `${ARCGIS_SYMBOL_FIELD} = '${colorId}'`,
            symbol: {
              type: "text",
              color: cssToArcgisColor(color),
              haloColor: cssToArcgisColor(style.textHaloColor),
              haloSize: `${Math.max(0, style.textHaloWidth)}px`,
              font: { size: `${Math.max(1, style.textSize)}px`, family: "sans-serif" },
            } as unknown as ArcgisSymbolJson,
            ...scales,
            // Text markers always show, as MapLibre allows their overlap.
            deconflictionStrategy: "none" as const,
          })),
        },
      ]
    : [];
  return {
    zoomDependent:
      resolver.zoomDependent ||
      filter.zoomDependent ||
      Boolean(label?.zoomDependent) ||
      Boolean(overrides?.zoomDependent) ||
      Boolean(extrusion?.zoomDependent),
    parts: [
      ...(maskPart ? [maskPart] : []),
      ...order
        .filter((kind) => parts.has(kind))
        .map((kind): ArcgisGeoJsonPart => {
          const { features, symbols } = parts.get(kind)!;
          const entries = [...symbols.values()];
          const extruded = extrusion !== null && kind === "polygon";
          // The extrusion's height varies per feature; a size visual variable
          // reads it from the baked field instead of one symbol per height.
          const visualVariables: ArcgisVisualVariableJson[] | undefined = extruded
            ? [{ type: "size", field: ARCGIS_HEIGHT_FIELD, valueUnit: "meters" }]
            : undefined;
          let renderer = (
            entries.length === 1
              ? {
                  type: "simple",
                  symbol: entries[0].symbol,
                  ...(visualVariables && { visualVariables }),
                }
              : {
                  type: "unique-value",
                  field: ARCGIS_SYMBOL_FIELD,
                  uniqueValueInfos: entries.map(({ id, symbol }) => ({ value: id, symbol })),
                  ...(visualVariables && { visualVariables }),
                }
          ) as ArcgisRendererJson;
          const heatmap = kind === "point" && style.pointRenderer === "heatmap";
          if (heatmap) renderer = heatmapRenderer(style, scene);
          const markers = !heatmap && entries.some(({ symbol }) => isMarkerPlaceholder(symbol));
          return {
            geometryType: kind,
            features: { type: "FeatureCollection", features },
            renderer,
            ...(label && !deduped && !(heatmap && scene)
              ? {
                  labelingInfo: labelingFor(
                    kind,
                    style,
                    scales,
                    labelClassesUsedBy(labelClassList, features),
                  ),
                }
              : {}),
            ...(markers ? { markerStyle: style } : {}),
            // An inverted fill's pattern goes on the mask.
            ...(kind === "polygon" && !scene && !maskPart && style.fillPattern !== "none"
              ? { patternStyle: style }
              : {}),
            ...(extruded
              ? { elevationInfo: { mode: "relative-to-ground" as const, offset: extrusion.base } }
              : {}),
            ...(elevated
              ? { hasZ: true, elevationInfo: { mode: "absolute-height" as const, offset: 0 } }
              : {}),
            ...(kind === "point" && style.pointRenderer === "cluster" && !scene
              ? {
                  featureReduction: {
                    type: "cluster",
                    clusterRadius: `${style.clusterRadius}px`,
                    clusterMinSize: "32px",
                    clusterMaxSize: "60px",
                    // MapLibre clusters through the inclusive integer clusterMaxZoom;
                    // the native scale cutoff is the start of the next zoom level.
                    maxScale: zoomToScale(style.clusterMaxZoom + 1),
                    labelingInfo: [
                      {
                        labelExpressionInfo: {
                          expression: "Text($feature.cluster_count, '#,###')",
                        },
                        labelPlacement: "center-center",
                        deconflictionStrategy: "none",
                        symbol: {
                          type: "text",
                          color: "white",
                          font: { size: "12px" },
                          haloColor: "black",
                          haloSize: "1px",
                        },
                      },
                    ],
                    popupEnabled: false,
                  },
                }
              : {}),
          };
        })
        // Decorations draw over the lines and outlines, under the points.
        .flatMap((part) =>
          part.geometryType === "polyline" ||
          (part.geometryType === "polygon" && !parts.has("polyline"))
            ? [part, ...(decorationPart ? [decorationPart] : [])]
            : [part],
        ),
      ...generatorParts,
      ...(dedupedPart ? [dedupedPart] : []),
      ...textPart,
    ],
  };
}

/** Label classes past which the overrides' colours and sizes are binned. */
const MAX_LABEL_CLASSES = 64;

/**
 * Group features by their resolved label overrides into label classes (the
 * SDK's label symbols are not data-driven), writing each feature's class into
 * {@link ARCGIS_LABEL_CLASS_FIELD}.
 */
function assignLabelClasses(overridden: Map<Feature, LabelOverrideValues>): LabelClassStyle[] {
  // Exact styles while they are few (categories). A continuous ramp would
  // make a class per feature, so past the cap the colour channels, alpha and
  // size are binned, ever more coarsely until the classes fit.
  const values = [...overridden.values()];
  const binned = (value: LabelOverrideValues, step: number): LabelOverrideValues => {
    if (step === 0) return value;
    const channel = (c: number) => Math.min(255, Math.round(c / step) * step);
    const sizeStep = step / 32;
    // Alpha never coarser than eighths, so a fading ramp keeps fading.
    const alphaStep = Math.min(0.125, step / 256);
    const alpha = value.color[3];
    return {
      ...value,
      // Binning coarsens the style; it must not hide a label (only the
      // visibility expression does), so a size or a visible alpha never
      // rounds to 0.
      size: Math.max(sizeStep, Math.round(value.size / sizeStep) * sizeStep),
      color: [
        channel(value.color[0]),
        channel(value.color[1]),
        channel(value.color[2]),
        alpha > 0 ? Math.max(alphaStep, Math.round(alpha / alphaStep) * alphaStep) : 0,
      ],
    };
  };
  const keyOf = (value: LabelOverrideValues) => `${value.size}|${value.color.join(",")}`;
  let step = 0;
  for (const next of [0, 32, 64, 128, 256]) {
    step = next;
    if (new Set(values.map((value) => keyOf(binned(value, step)))).size <= MAX_LABEL_CLASSES) break;
  }
  const classes = new Map<string, LabelClassStyle>();
  for (const [feature, raw] of overridden) {
    const value = binned(raw, step);
    const key = keyOf(value);
    let entry = classes.get(key);
    if (!entry) {
      entry = { id: `l${classes.size}`, size: value.size, color: value.color };
      classes.set(key, entry);
    }
    feature.properties![ARCGIS_LABEL_CLASS_FIELD] = entry.id;
  }
  return [...classes.values()];
}

/** The label classes a part's features use, so no part lists another's. */
function labelClassesUsedBy(
  classes: LabelClassStyle[] | undefined,
  features: Feature[],
): LabelClassStyle[] | undefined {
  if (!classes) return undefined;
  const used = new Set(features.map((feature) => feature.properties?.[ARCGIS_LABEL_CLASS_FIELD]));
  return classes.filter((entry) => used.has(entry.id));
}

/**
 * The filtered features the inverted fill and geometry generator derive from,
 * cached by the input collection and the features kept, so the memoized
 * derivations (`derived-geometry.ts`, keyed by collection identity) still hit
 * when a filter or a text marker drops features.
 */
const derivedSources = new WeakMap<
  FeatureCollection,
  { kept: Feature[]; source: FeatureCollection }
>();

function derivedSource(geojson: FeatureCollection, kept: Feature[]): FeatureCollection {
  if (kept.length === geojson.features.length) return geojson;
  const cached = derivedSources.get(geojson);
  if (
    cached &&
    cached.kept.length === kept.length &&
    cached.kept.every((feature, index) => feature === kept[index])
  )
    return cached.source;
  const source: FeatureCollection = { type: "FeatureCollection", features: kept };
  derivedSources.set(geojson, { kept, source });
  return source;
}

/** Whether every feature with a geometry is a point (text markers included). */
function isPointOnly(geojson: FeatureCollection): boolean {
  let points = false;
  for (const feature of geojson.features) {
    const type = feature.geometry?.type;
    if (!type) continue;
    if (type !== "Point" && type !== "MultiPoint") return false;
    points = true;
  }
  return points;
}

/**
 * The inverted fill (QGIS "Inverted polygons"): a world polygon with the
 * layer's polygons cut out, filled with the layer's fill. `null` when the
 * mask cannot be built (too many features, degenerate rings), in which case
 * the layer keeps its ordinary fill, as on the 2D map.
 */
function invertedMaskPart(
  source: FeatureCollection,
  style: LayerStyle,
  resolver: ReturnType<typeof createFeatureStyleResolver>,
  zoom: number,
  scene: boolean,
): ArcgisGeoJsonPart | null {
  const mask = buildInvertedMask(source);
  if (!mask) return null;
  // The world ring pulled inside the Web Mercator limit, the holes wound
  // against it: the SDK, like mapbox-gl, draws a same-wound hole as a polygon.
  const renderable = mapboxRenderableMask(mask);
  // The fill a feature without attributes resolves to, as the 2D map's
  // mask layer evaluates the fill paint over the attribute-less mask.
  const fill = symbolForKind(
    "polygon",
    resolver.resolve({ ...renderable.features[0], properties: {} }, zoom),
  );
  return {
    geometryType: "polygon",
    features: {
      type: "FeatureCollection",
      features: renderable.features.map((feature) => ({
        type: "Feature",
        geometry: feature.geometry,
        properties: { [ARCGIS_SYMBOL_FIELD]: "s0" },
      })),
    },
    // No outline: the world ring's edge would show as a seam.
    renderer: { type: "simple", symbol: { ...fill, outline: { style: "none", width: 0 } } },
    ...(!scene && style.fillPattern !== "none" ? { patternStyle: style } : {}),
    interactive: false,
  };
}

/**
 * The geometry generator's output (centroids, bounding boxes, convex hulls or
 * buffers) as companion parts: polygons in the generator's fill and stroke,
 * centroids as circles sized by its radius (constant or proportional).
 */
function generatedGeometryParts(
  source: FeatureCollection,
  style: LayerStyle,
  zoom: number,
): ArcgisGeoJsonPart[] {
  const type = styleValue(style, "geometryGenerator");
  if (type === "none") return [];
  const generated = buildGeneratedGeometry(
    source,
    type,
    styleValue(style, "geometryGeneratorBufferDistance"),
    styleValue(style, "geometryGeneratorBufferProperty"),
  );
  if (!generated?.features.length) return [];
  const opacity = Math.min(1, Math.max(0, styleValue(style, "geometryGeneratorOpacity")));
  const fill = styleValue(style, "geometryGeneratorFillColor");
  const stroke = styleValue(style, "geometryGeneratorStrokeColor");
  const width = Math.max(0, styleValue(style, "geometryGeneratorStrokeWidth"));
  const outline =
    width > 0
      ? { style: "solid", color: cssToArcgisColor(stroke), width: `${width}px` }
      : { style: "none", width: 0 };
  const polygons: Feature[] = [];
  const points: Feature[] = [];
  const radius = featureValue(generatorCircleRadiusValue(style), "number");
  const sizes = new Map<number, string>();
  for (const feature of generated.features) {
    const kind = feature.geometry ? GEOMETRY_KIND[feature.geometry.type] : undefined;
    if (kind === "polygon")
      polygons.push({ ...feature, properties: { [ARCGIS_SYMBOL_FIELD]: "s0" } });
    else if (kind === "point") {
      const value = Number(radius.read(feature, zoom));
      const r = Math.round(Math.max(0, Number.isFinite(value) ? value : 5) * 2) / 2;
      // A 0 px radius hides the symbol on purpose (`generatorCircleRadiusValue`).
      if (r === 0) continue;
      let id = sizes.get(r);
      if (id === undefined) {
        id = `s${sizes.size}`;
        sizes.set(r, id);
      }
      points.push({ ...feature, properties: { [ARCGIS_SYMBOL_FIELD]: id } });
    }
  }
  const parts: ArcgisGeoJsonPart[] = [];
  if (polygons.length)
    parts.push({
      geometryType: "polygon",
      features: { type: "FeatureCollection", features: polygons },
      renderer: {
        type: "simple",
        symbol: {
          type: "simple-fill",
          style: "solid",
          color: cssToArcgisColor(fill, opacity),
          outline,
        },
      },
      interactive: false,
    });
  if (points.length)
    parts.push({
      geometryType: "point",
      features: { type: "FeatureCollection", features: points },
      renderer: {
        type: "unique-value",
        field: ARCGIS_SYMBOL_FIELD,
        uniqueValueInfos: [...sizes].map(([r, id]) => ({
          value: id,
          symbol: {
            type: "simple-marker",
            style: "circle",
            color: cssToArcgisColor(fill, opacity),
            size: `${r * 2}px`,
            outline,
          },
        })),
      },
      interactive: false,
    });
  return parts;
}

/**
 * Line decorations along the layer's lines and polygon outlines, as a
 * polyline part drawn with the CIM marker-line symbol. Takes the compiled
 * (already filtered) features.
 */
function lineDecorationPart(style: LayerStyle, features: Feature[]): ArcgisGeoJsonPart | null {
  const lines: Feature[] = [];
  for (const feature of features) {
    const geometry = feature.geometry;
    let coordinates: Position[][] | null = null;
    if (geometry?.type === "LineString") coordinates = [geometry.coordinates];
    else if (geometry?.type === "MultiLineString") coordinates = geometry.coordinates;
    else if (geometry?.type === "Polygon") coordinates = geometry.coordinates;
    else if (geometry?.type === "MultiPolygon") coordinates = geometry.coordinates.flat();
    if (coordinates?.length)
      lines.push({
        type: "Feature",
        geometry: { type: "MultiLineString", coordinates },
        properties: { [ARCGIS_SYMBOL_FIELD]: "s0" },
      });
  }
  if (!lines.length) return null;
  return {
    geometryType: "polyline",
    features: { type: "FeatureCollection", features: lines },
    renderer: {
      type: "simple",
      symbol: arcgisLineDecorationSymbol(style, cssToArcgisColor(lineDecorationColorValue(style))),
    },
    interactive: false,
  };
}

const UNSUPPORTED_TEMPLATE = /\{(?:-y|quadkey|ratio|bbox[^}]*|switch:[^}]*)\}/;

/**
 * Rewrite a `{z}/{x}/{y}` template into the SDK's `{level}/{col}/{row}` form.
 * A `{s}` or `{a-c}` subdomain placeholder becomes `{subDomain}` with the list
 * the SDK rotates through. Placeholders the SDK cannot express (TMS `{-y}`,
 * quadkeys, retina `{ratio}`, WMS bounding boxes) are rejected.
 */
export function webTileTemplate(template: string): { urlTemplate: string; subDomains?: string[] } {
  if (UNSUPPORTED_TEMPLATE.test(template))
    throw new Error("Tile template placeholders are not supported by the ArcGIS renderer");
  let urlTemplate = template
    .replaceAll("{z}", "{level}")
    .replaceAll("{x}", "{col}")
    .replaceAll("{y}", "{row}");
  let subDomains: string[] | undefined;
  const range = urlTemplate.match(/\{([a-z0-9])-([a-z0-9])\}/i);
  if (range) {
    const [from, to] = [range[1].charCodeAt(0), range[2].charCodeAt(0)];
    subDomains = [];
    for (let code = from; code <= to; code++) subDomains.push(String.fromCharCode(code));
    urlTemplate = urlTemplate.replace(range[0], "{subDomain}");
  } else if (urlTemplate.includes("{s}")) {
    subDomains = ["a", "b", "c"];
    urlTemplate = urlTemplate.replaceAll("{s}", "{subDomain}");
  }
  if (!/\{level\}|\{col\}|\{row\}/.test(urlTemplate))
    throw new Error("Tile template has no {z}/{x}/{y} placeholders");
  return { urlTemplate, ...(subDomains ? { subDomains } : {}) };
}

const WMS_STRUCTURAL = new Set([
  "service",
  "request",
  "bbox",
  "width",
  "height",
  "srs",
  "crs",
  "layers",
  "styles",
  "format",
  "version",
  "transparent",
]);

/**
 * Whether a tile template is a WMS GetMap request naming the layers to draw:
 * it says `REQUEST=GetMap`, or `SERVICE=WMS` with no other request. An ArcGIS
 * `/export` template also carries `layers` (`show:3`), but neither of those.
 */
function isWmsGetMap(template: string): boolean {
  const params = new URLSearchParams(template.split("?", 2)[1] ?? "");
  let request: string | undefined;
  let wms = false;
  let layers = false;
  for (const [key, value] of params) {
    const name = key.toLowerCase();
    if (name === "request") request = value.toLowerCase();
    if (name === "service") wms = value.toLowerCase() === "wms";
    if (name === "layers") layers = value.trim() !== "";
  }
  return layers && (request === "getmap" || (request === undefined && wms));
}

/**
 * Split a MapLibre WMS GetMap tile template (`...?SERVICE=WMS&REQUEST=GetMap&
 * LAYERS=...&BBOX={bbox-epsg-3857}`) into the SDK's WMSLayer description: the
 * service endpoint, the sublayers to draw, the image format, and every other
 * parameter (a `TIME`, a vendor option) passed through as custom parameters.
 */
export function wmsLayerFromTemplate(template: string): {
  url: string;
  sublayers: { name: string }[];
  version?: string;
  imageFormat?: string;
  imageTransparency: boolean;
  customParameters?: Record<string, string>;
} {
  const [base, query = ""] = template.split("?", 2);
  const params = new URLSearchParams(query.replace(/\{bbox-epsg-3857\}/g, ""));
  const get = (name: string) => {
    for (const [key, value] of params) if (key.toLowerCase() === name) return value;
    return undefined;
  };
  const layers = (get("layers") ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (!layers.length) throw new Error("WMS template names no layers");
  const custom: Record<string, string> = {};
  for (const [key, value] of params)
    if (!WMS_STRUCTURAL.has(key.toLowerCase()) && value !== "") custom[key] = value;
  const transparent = get("transparent");
  return {
    url: base,
    sublayers: layers.map((name) => ({ name })),
    ...(get("version") ? { version: get("version") } : {}),
    ...(get("format") ? { imageFormat: get("format") } : {}),
    imageTransparency: transparent === undefined || transparent.toLowerCase() !== "false",
    ...(Object.keys(custom).length ? { customParameters: custom } : {}),
  };
}

/**
 * The tile source for a raster record `WebTileLayer` cannot draw as MapLibre
 * would: a TMS scheme, a tile size other than 256 px, a source zoom range, more
 * than one template, or a placeholder it has no form for. Null when the plain
 * `WebTileLayer` path draws it the same.
 */
function templateTileSource(
  layer: GeoLibreLayer,
  templates: string[],
  viaProtocol = false,
): ArcgisTileTemplateSource | null {
  const { scheme, tileSize, minzoom, maxzoom } = layer.source as {
    scheme?: unknown;
    tileSize?: unknown;
    minzoom?: unknown;
    maxzoom?: unknown;
  };
  const finite = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value);
  const size = finite(tileSize) && tileSize > 0 ? tileSize : 256;
  // MapLibre's own defaults (0 and 22) change nothing the plain path draws.
  if (
    !viaProtocol &&
    scheme !== "tms" &&
    size === 256 &&
    !(finite(minzoom) && minzoom > 0) &&
    !(finite(maxzoom) && maxzoom < 22) &&
    templates.length === 1 &&
    !needsTemplateTileLayer(templates[0])
  )
    return null;
  for (const template of templates) {
    if (/\{(?:bbox-(?!epsg-3857\})[^}]*|switch:[^}]*)\}/.test(template))
      throw new Error("Tile template placeholders are not supported by the ArcGIS renderer");
    if (!isTileTemplate(template)) throw new Error("Tile template has no {z}/{x}/{y} placeholders");
  }
  const layerBounds = bounds(layer);
  return {
    templates,
    scheme: scheme === "tms" ? "tms" : "xyz",
    tileSize: size,
    minzoom: finite(minzoom) ? Math.max(0, minzoom) : 0,
    maxzoom: finite(maxzoom) ? Math.max(0, maxzoom) : 22,
    ...(layerBounds ? { bounds: layerBounds } : {}),
  };
}

/** Style settings the ArcGIS renderer does not draw, named in the Style panel. */
export type ArcgisUnsupportedStyleSetting =
  | "diagram"
  | "labelPriority"
  | "lineDecorationScene"
  | "blendModeScene"
  | "clusterScene"
  | "fillPatternScene"
  | "extrusionFlat";

/**
 * The {@link ArcgisUnsupportedStyleSetting}s this layer's style turns on, for
 * the view it would draw in: the SDK draws clusters, fill patterns, blend
 * modes and line decorations (CIM line symbols) on a flat `MapView` only, and
 * extrusion in a `SceneView` only.
 *
 * @param layer - The store layer whose style is checked.
 * @param scene - Whether the ArcGIS map is a 3D `SceneView`.
 * @returns The settings that turn on something the renderer ignores.
 */
export function arcgisUnsupportedStyleSettings(
  layer: GeoLibreLayer,
  scene: boolean,
): ArcgisUnsupportedStyleSetting[] {
  const style: LayerStyle = { ...DEFAULT_LAYER_STYLE, ...layer.style };
  const settings: ArcgisUnsupportedStyleSetting[] = [];
  if (style.diagramType && style.diagramType !== "none") settings.push("diagram");
  const labels = { ...DEFAULT_LAYER_STYLE.labels, ...style.labels };
  if (
    labels.enabled &&
    labels.dedupe === "off" &&
    parseLabelOverride(labels.priorityExpression, "number")
  )
    settings.push("labelPriority");
  if (scene) {
    if (hasLineDecoration(style)) settings.push("lineDecorationScene");
    if ((style.blendMode ?? DEFAULT_BLEND_MODE) !== DEFAULT_BLEND_MODE)
      settings.push("blendModeScene");
    if (style.pointRenderer === "cluster") settings.push("clusterScene");
    if (style.fillPattern && style.fillPattern !== "none") settings.push("fillPatternScene");
  } else if (style.extrusionEnabled) settings.push("extrusionFlat");
  return settings;
}

/** Store layer types the engine draws as a raster tile source. */
const RASTER_TILE_TYPES = new Set(["raster", "wms", "wmts", "xyz"]);

function bounds(layer: GeoLibreLayer): [number, number, number, number] | undefined {
  const value = layer.source.bounds ?? layer.metadata.bounds;
  return Array.isArray(value) && value.length === 4 && value.every((v) => Number.isFinite(v))
    ? (value as [number, number, number, number])
    : undefined;
}

/**
 * Whether the record is a plugin-owned mirror with nothing the engine could
 * draw itself (a control's native layers registered as `nativeLayerIds`). No
 * plugin draws on the ArcGIS map yet, so such a layer is skipped rather than
 * reported as an error.
 */
export function isArcgisPluginLayer(layer: GeoLibreLayer): boolean {
  if (layer.metadata.externalNativeLayer !== true) return false;
  if (layer.geojson || (layer.type === "cog" && cogSourceUrl(layer))) return false;
  const { url, urls, tiles, data } = layer.source as {
    url?: unknown;
    urls?: unknown;
    tiles?: unknown;
    data?: unknown;
  };
  return !(
    typeof url === "string" ||
    (Array.isArray(urls) && urls.length > 0) ||
    (Array.isArray(tiles) && tiles.length > 0) ||
    data !== undefined
  );
}

function isArcgisExternalDeckLayer(layer: GeoLibreLayer): boolean {
  return (
    (layer.type === "deckgl-viz" && layer.metadata.sourceKind === "deckgl-viz") ||
    (layer.type === "lidar" && layer.metadata.sourceKind === "lidar-url") ||
    (layer.type === "duckdb-query" && layer.metadata.sourceKind === "duckdb-query") ||
    (layer.type === "3d-tiles" && layer.metadata.sourceKind === "3d-tiles-url")
  );
}

/** Store layers are immutable records, so the answer is memoized per object. */
const supportedLayerCache = new WeakMap<GeoLibreLayer, boolean>();

/**
 * Whether the ArcGIS engine can draw a layer. The layer panels badge the rest
 * before the engine's error banner would report them.
 */
export function isArcgisSupportedLayer(layer: GeoLibreLayer, deckOverlay = true): boolean {
  if (isArcgisExternalDeckLayer(layer)) return deckOverlay;
  const cached = supportedLayerCache.get(layer);
  if (cached !== undefined) return cached;
  let supported = true;
  if (isArcgisPluginLayer(layer)) supported = false;
  else {
    try {
      compileArcgisLayer(layer, { probe: true });
    } catch {
      supported = false;
    }
  }
  supportedLayerCache.set(layer, supported);
  return supported;
}

const ARCGIS_SERVICE = /\/(FeatureServer|MapServer|ImageServer)(?:\/\d+)?\/?(?:\?|$)/i;

const zarrSignatures = new WeakMap<GeoLibreLayer["source"], string>();
const zarrManifestIds = new WeakMap<object, number>();
let nextZarrManifestId = 0;

/** Store sources and kerchunk manifests are immutable; compare manifests by identity. */
function zarrRenderSignature(source: GeoLibreLayer["source"]): string {
  const cached = zarrSignatures.get(source);
  if (cached !== undefined) return cached;
  const {
    selector: _selector,
    clim: _clim,
    colormap: _colormap,
    kerchunkRefs,
    ...gridSource
  } = source;
  let refs = kerchunkRefs;
  if (kerchunkRefs && typeof kerchunkRefs === "object") {
    let id = zarrManifestIds.get(kerchunkRefs);
    if (id === undefined) {
      id = ++nextZarrManifestId;
      zarrManifestIds.set(kerchunkRefs, id);
    }
    refs = ["manifest", id];
  }
  const signature = JSON.stringify({ ...gridSource, kerchunkRefs: refs });
  zarrSignatures.set(source, signature);
  return signature;
}

/**
 * Compile one store layer. Throws for a layer the SDK has no translation for,
 * naming why; the engine records that against the layer.
 */
export function compileArcgisLayer(
  layer: GeoLibreLayer,
  options: CompileArcgisLayerOptions = {},
): ArcgisLayerPlan {
  const zoom = options.zoom ?? 12;
  const probe = options.probe === true;
  const style: LayerStyle = { ...DEFAULT_LAYER_STYLE, ...layer.style };
  const base: ArcgisPlanBase = {
    id: layer.id,
    title: layer.name,
    visible: layer.visible,
    opacity: Math.min(1, Math.max(0, layer.opacity)),
    ...zoomRangeToScales(style.minZoom, style.maxZoom),
    ...(bounds(layer) ? { bounds: bounds(layer) } : {}),
    zoomDependent: false,
    effect: arcgisRasterEffect(style),
    blendMode: arcgisBlendMode(style),
  };
  if (isArcgisExternalDeckLayer(layer)) {
    if (options.deckOverlay === false)
      throw new Error("deck.gl layers require a flat ArcGIS map or local scene");
    return { ...base, kind: "external-deck" };
  }
  if (layer.type === "zarr") {
    if (!layer.source.url || !layer.source.variable)
      throw new Error("Zarr requires a source and variable");
    // Time slices refresh native tiles in place, retaining metadata and byte caches.
    return {
      ...base,
      kind: "zarr",
      source: layer,
      renderSignature: zarrRenderSignature(layer.source),
    };
  }
  if (layer.type === "cog") {
    if (!cogSourceUrl(layer)) throw new Error("The COG layer has no readable source");
    return { ...base, kind: "cog", source: layer, renderSignature: cogRenderSignature(layer) };
  }
  // Vector tiles from an ArcGIS vector tile service carry a resolved style;
  // the SDK's VectorTileLayer accepts a Mapbox style document directly, so the
  // Mapbox compiler's plan (sources plus style layers) becomes its style.
  if (layer.type === "vector-tiles" || (layer.type === "arcgis" && arcgisVectorStyle(layer))) {
    // Compile the style at full opacity and visible: the Mapbox compiler folds
    // both into paint and layout, but here they are native properties of the
    // VectorTileLayer, and a style that changed with every opacity tick would
    // rebuild the layer (and abort its in-flight tiles) on each one.
    // Labels use a font Esri's glyph service has (the engine adds the glyphs
    // and a sprite of GeoLibre's generated icons; `arcgis-sprite.ts`).
    const plan = compileMapboxLayer(
      { ...layer, opacity: 1, visible: true },
      { textFont: ARCGIS_TEXT_FONT },
    );
    return {
      ...base,
      kind: "vector-tile",
      style: {
        version: 8,
        sources: { [plan.sourceId]: plan.source, ...(plan.additionalSources ?? {}) },
        // An Esri service's own symbol layers name images of its sprite, which
        // the stored style snapshot does not keep.
        layers:
          layer.type === "vector-tiles"
            ? plan.layers
            : plan.layers.filter((spec) => spec.type !== "symbol"),
      },
    };
  }
  if (layer.geojson) {
    const compiled = compileGeoJson(layer, layer.geojson, zoom, probe, options.scene === true);
    return {
      ...base,
      kind: "geojson",
      parts: compiled.parts,
      zoomDependent: compiled.zoomDependent,
    };
  }
  const url = typeof layer.source.url === "string" ? layer.source.url : undefined;
  const tiles = Array.isArray(layer.source.tiles)
    ? layer.source.tiles.filter((t): t is string => typeof t === "string")
    : [];
  if (layer.type === "arcgis") {
    const serviceUrl = url ?? (typeof layer.sourcePath === "string" ? layer.sourcePath : undefined);
    if (!serviceUrl || !ARCGIS_SERVICE.test(serviceUrl))
      throw new Error("ArcGIS layer has no service URL the ArcGIS renderer can load");
    // A FeatureServer, or one MapServer sublayer (`MapServer/2`): a feature
    // layer the SDK's FeatureLayer loads and queries directly. A MapImageLayer
    // pointed at a sublayer would request `/export` from it and fail.
    if (/FeatureServer/i.test(serviceUrl) || /\/MapServer\/\d+\/?(?:\?|$)/i.test(serviceUrl)) {
      // The service filters server-side: the layer's MapLibre filters become
      // an SQL where clause where one exists.
      const filter = activeFilters(layer);
      const sql = filter ? filterToSql(filter) : null;
      // The layer draws with its style, as the 2D map draws the same
      // service's features (Add Data gives every service layer one).
      const resolver = createFeatureStyleResolver(style);
      const symbol = resolver.resolve(undefined, zoom);
      // Points read the point channels (their outline width is not a line's).
      const pointSymbol = resolver.resolve(
        { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [0, 0] } },
        zoom,
      );
      return {
        ...base,
        kind: "feature-service",
        url: serviceUrl,
        // A zoom-dependent style (metre-unit strokes, zoom rules) is resolved
        // again when the integer zoom changes, as for GeoJSON.
        zoomDependent: resolver.zoomDependent,
        symbols: {
          point: symbolForKind("point", pointSymbol),
          polyline: symbolForKind("polyline", symbol),
          polygon: symbolForKind("polygon", symbol),
        },
        ...(sql ? { definitionExpression: sql } : {}),
        ...(filter && !sql ? { filterUnsupported: true } : {}),
      };
    }
    const kind = /ImageServer/i.test(serviceUrl)
      ? "imagery"
      : layer.metadata.arcgisTiled === true
        ? "tile-service"
        : "map-image";
    return { ...base, kind, url: serviceUrl };
  }
  if (layer.type === "pmtiles" || layer.type === "mbtiles") {
    const archiveUrl = layer.type === "pmtiles" ? url : tiles[0];
    if (!archiveUrl) throw new Error("Tile archive has no readable source");
    if (layer.source.encoding === "mlt")
      throw new Error("ArcGIS requires MVT vector tiles, not MLT");
    const tileType =
      layer.source.type === "raster" || layer.source.tileType === "raster" ? "raster" : "vector";
    let styleLayers: unknown[] = [];
    let sourceId = layer.id;
    const tileOptions = {
      ...(typeof layer.source.minzoom === "number" ? { minzoom: layer.source.minzoom } : {}),
      ...(typeof layer.source.maxzoom === "number" ? { maxzoom: layer.source.maxzoom } : {}),
      ...(base.bounds ? { bounds: base.bounds } : {}),
    };
    if (tileType === "vector") {
      const vector = compileMapboxLayer(
        {
          ...layer,
          type: "vector-tiles",
          opacity: 1,
          visible: true,
          source: {
            ...layer.source,
            type: "vector",
            url: undefined,
            tiles: ["https://geolibre.invalid/{z}/{x}/{y}.pbf"],
          },
        },
        { textFont: ARCGIS_TEXT_FONT },
      );
      sourceId = vector.sourceId;
      styleLayers = vector.layers;
    }
    return {
      ...base,
      kind: "archive",
      format: layer.type === "pmtiles" ? "pmtiles" : "protocol",
      url: archiveUrl,
      tileType,
      sourceId,
      styleLayers,
      tileOptions,
    };
  }
  // A GetMap template naming its layers is a WMS service the SDK can draw
  // natively. Other bounding-box templates typed `wms` (an ArcGIS
  // `/exportImage`, say) are plain image requests, drawn tile by tile below.
  // WMS tiles go through the dev server's proxy, as on MapLibre.
  const proxied = proxyWmsTiles(layer.type, tiles);
  if (layer.type === "wms" && tiles.length && isWmsGetMap(tiles[0]))
    return { ...base, kind: "wms", ...wmsLayerFromTemplate(proxied[0]) };
  if (RASTER_TILE_TYPES.has(layer.type) && (tiles.length || url)) {
    const templates = proxied.length ? proxied : [url!];
    // `geolibre-wms://` (the desktop's CORS-exempt WMS fetcher), `cog://` and
    // friends are MapLibre protocol handlers. The template-tile layer asks the
    // registered handler for each tile, as the globe does; a scheme with no
    // handler cannot be drawn.
    const protocols = templates.map(protocolScheme);
    if (protocols.some((scheme) => scheme && !hasRegisteredProtocol(scheme)))
      throw new Error("MapLibre custom tile protocols are not supported by the ArcGIS renderer");
    const copyright =
      typeof layer.source.attribution === "string" ? { copyright: layer.source.attribution } : {};
    const tileSource = templateTileSource(layer, templates, protocols.some(Boolean));
    // An ArcGIS export/tile template (the ArcGIS Layer panel's raster path) is
    // still a plain tile template; the SDK's own service classes are used only
    // for records that name the service itself (the `arcgis` type above).
    if (tileSource) return { ...base, kind: "template-tile", ...tileSource, ...copyright };
    return { ...base, kind: "web-tile", ...webTileTemplate(templates[0]), ...copyright };
  }
  if (layer.type === "geojson" && url) {
    // A remote GeoJSON URL the store never materialized: the SDK can fetch it,
    // but the per-feature symbology needs the features, so draw it flat.
    const resolver = createFeatureStyleResolver(style);
    const symbol = resolver.resolve(undefined, zoom);
    return {
      ...base,
      kind: "geojson",
      zoomDependent: resolver.zoomDependent,
      parts: probe
        ? []
        : (["polygon", "polyline", "point"] as ArcgisGeometryKind[]).map((kind) => ({
            geometryType: kind,
            url,
            renderer: { type: "simple", symbol: symbolForKind(kind, symbol) },
          })),
    };
  }
  if (layer.type === "image" && url && Array.isArray(layer.source.coordinates)) {
    const corners = layer.source.coordinates as Position[];
    if (corners.length !== 4 || corners.some((p) => !Array.isArray(p) || p.length < 2))
      throw new Error("Invalid image corners");
    const xs = corners.map((p) => p[0]);
    const ys = corners.map((p) => p[1]);
    return {
      ...base,
      kind: "media-image",
      url,
      corners: corners.map((p) => [p[0], p[1]]) as [Position, Position, Position, Position],
      extent: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
    };
  }
  throw new Error(`Layer type ${layer.type} requires a renderer-specific adapter`);
}
