import {
  compileLayerFilters,
  DEFAULT_LAYER_STYLE,
  extrusionColorValue,
  extrusionHeightValue,
  labelFieldTextField,
  normalizeHexColor,
  ruleBasedVisibilityFilter,
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
/** Extrusion height in metres, read by the 3D renderer's size visual variable. */
export const ARCGIS_HEIGHT_FIELD = "gl__height";

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
  /**
   * How the SDK places the features vertically in a `SceneView`. Set on
   * extruded polygons so the extrusion starts at the style's base height.
   */
  elevationInfo?: { mode: "relative-to-ground"; offset: number };
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
}

export type ArcgisLayerPlan = ArcgisPlanBase &
  (
    | { kind: "geojson"; parts: ArcgisGeoJsonPart[] }
    | {
        kind: "web-tile";
        urlTemplate: string;
        subDomains?: string[];
        copyright?: string;
      }
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
  let value: unknown = labelFieldTextField(labels);
  if (labels.expression.trim()) {
    try {
      value = JSON.parse(labels.expression);
    } catch {
      // An unparseable expression keeps the field text, as on Mapbox.
    }
  }
  if (typeof value === "string") {
    const text = value;
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
  const transform = (text: string) =>
    labels.transform === "uppercase"
      ? text.toUpperCase()
      : labels.transform === "lowercase"
        ? text.toLowerCase()
        : text;
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

function labelingFor(
  kind: ArcgisGeometryKind,
  style: LayerStyle,
  layerScales: { minScale: number; maxScale: number },
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
  return [
    {
      labelExpressionInfo: { expression: `$feature.${ARCGIS_LABEL_FIELD}` },
      labelPlacement: placement,
      symbol: {
        type: "text",
        color: cssToArcgisColor(labels.color),
        haloColor: cssToArcgisColor(labels.haloColor),
        haloSize: `${Math.max(0, labels.haloWidth)}px`,
        font: { size: `${Math.max(1, labels.size)}px`, family: "sans-serif" },
        // MapLibre offsets are in ems of the text size, y down; the SDK's are
        // in points or pixels, y up.
        xoffset: `${labels.offsetX * labels.size}px`,
        yoffset: `${-labels.offsetY * labels.size}px`,
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
    },
  ];
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
  type: "number" | "color",
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
  const resolver = createFeatureStyleResolver(style);
  const filter = compileFilter(layer);
  const label = compileLabelText(style);
  const scales = zoomRangeToScales(style.minZoom, style.maxZoom);
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
  geojson.features.forEach((feature, index) => {
    if (!feature.geometry) return;
    if (filter.test && !filter.test(feature, zoom)) return;
    const id = String(feature.id ?? index);
    const symbol = resolver.resolve(feature, zoom);
    const text = label ? label.read(feature, zoom) : "";
    for (const geometry of explodePoints(feature.geometry)) {
      const kind = GEOMETRY_KIND[geometry.type];
      if (!kind) continue;
      const extruded = extrusion !== null && kind === "polygon";
      const shape = extruded ? extrusion.symbol(feature, zoom) : symbolForKind(kind, symbol);
      const json = kind === "point" ? pointMarkerSymbol(style, feature, symbol, shape) : shape;
      const key = JSON.stringify(json);
      let part = parts.get(kind);
      if (!part) {
        part = { features: [], symbols: new Map() };
        parts.set(kind, part);
      }
      let entry = part.symbols.get(key);
      if (!entry) {
        entry = { id: `s${part.symbols.size}`, symbol: json };
        part.symbols.set(key, entry);
      }
      part.features.push({
        type: "Feature",
        geometry,
        properties: {
          [ARCGIS_ID_FIELD]: id,
          [ARCGIS_SYMBOL_FIELD]: entry.id,
          [ARCGIS_LABEL_FIELD]: text,
          ...(extruded ? { [ARCGIS_HEIGHT_FIELD]: extrusion.height(feature, zoom) } : {}),
        },
      });
    }
  });
  // A stable order — polygons under lines under points — so the SDK draws the
  // kinds the way the 2D map stacks its fill, line and circle layers.
  const order: ArcgisGeometryKind[] = ["polygon", "polyline", "point"];
  return {
    zoomDependent:
      resolver.zoomDependent ||
      filter.zoomDependent ||
      Boolean(label?.zoomDependent) ||
      Boolean(extrusion?.zoomDependent),
    parts: order
      .filter((kind) => parts.has(kind))
      .map((kind) => {
        const { features, symbols } = parts.get(kind)!;
        const entries = [...symbols.values()];
        const extruded = extrusion !== null && kind === "polygon";
        // The extrusion's height varies per feature; a size visual variable
        // reads it from the baked field instead of one symbol per height.
        const visualVariables: ArcgisVisualVariableJson[] | undefined = extruded
          ? [{ type: "size", field: ARCGIS_HEIGHT_FIELD, valueUnit: "meters" }]
          : undefined;
        const renderer = (
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
        const markers = entries.some(({ symbol }) => isMarkerPlaceholder(symbol));
        return {
          geometryType: kind,
          features: { type: "FeatureCollection", features },
          renderer,
          ...(label ? { labelingInfo: labelingFor(kind, style, scales) } : {}),
          ...(markers ? { markerStyle: style } : {}),
          ...(extruded
            ? { elevationInfo: { mode: "relative-to-ground" as const, offset: extrusion.base } }
            : {}),
        };
      }),
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
  if (layer.geojson) return false;
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

/** Store layers are immutable records, so the answer is memoized per object. */
const supportedLayerCache = new WeakMap<GeoLibreLayer, boolean>();

/**
 * Whether the ArcGIS engine can draw a layer. The layer panels badge the rest
 * before the engine's error banner would report them.
 */
export function isArcgisSupportedLayer(layer: GeoLibreLayer): boolean {
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
  };
  // Vector tiles from an ArcGIS vector tile service carry a resolved style;
  // the SDK's VectorTileLayer accepts a Mapbox style document directly, so the
  // Mapbox compiler's plan (sources plus style layers) becomes its style.
  if (layer.type === "vector-tiles" || (layer.type === "arcgis" && arcgisVectorStyle(layer))) {
    // Compile the style at full opacity and visible: the Mapbox compiler folds
    // both into paint and layout, but here they are native properties of the
    // VectorTileLayer, and a style that changed with every opacity tick would
    // rebuild the layer (and abort its in-flight tiles) on each one.
    const plan = compileMapboxLayer({ ...layer, opacity: 1, visible: true });
    return {
      ...base,
      kind: "vector-tile",
      style: {
        version: 8,
        sources: { [plan.sourceId]: plan.source, ...(plan.additionalSources ?? {}) },
        // Symbol layers need a glyph endpoint the SDK would otherwise reject
        // the whole style over; the store's vector-tile records carry none.
        layers: plan.layers.filter((spec) => spec.type !== "symbol"),
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
    if (/FeatureServer/i.test(serviceUrl)) {
      // The service filters server-side: the layer's MapLibre filters become
      // an SQL where clause where one exists.
      const filter = activeFilters(layer);
      const sql = filter ? filterToSql(filter) : null;
      return {
        ...base,
        kind: "feature-service",
        url: serviceUrl,
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
  if (layer.type === "pmtiles" || layer.type === "mbtiles")
    throw new Error(`${layer.type} archives are not supported by the ArcGIS renderer`);
  if (layer.type === "wms" && tiles.length) {
    const [template] = proxyWmsTiles(layer.type, tiles);
    return { ...base, kind: "wms", ...wmsLayerFromTemplate(template) };
  }
  if (RASTER_TILE_TYPES.has(layer.type) && (tiles.length || url)) {
    const template = tiles[0] ?? url!;
    // `cog://`, `pmtiles://`, `mbtiles://` and friends are MapLibre protocol
    // handlers registered with maplibre-gl only.
    if (/^[\w+-]+:/.test(template) && !/^(?:https?|data|blob):/i.test(template))
      throw new Error("MapLibre custom tile protocols are not supported by the ArcGIS renderer");
    // An ArcGIS export/tile template (the ArcGIS Layer panel's raster path) is
    // still a plain tile template; the SDK's own service classes are used only
    // for records that name the service itself (the `arcgis` type above).
    return {
      ...base,
      kind: "web-tile",
      ...webTileTemplate(template),
      ...(typeof layer.source.attribution === "string"
        ? { copyright: layer.source.attribution }
        : {}),
    };
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
