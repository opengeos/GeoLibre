import {
  compileLayerFilters,
  DEFAULT_LAYER_STYLE,
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

/** The SDK's geometry kinds a GeoJSONLayer can hold; one layer per kind. */
export type ArcgisGeometryKind = "point" | "polyline" | "polygon";

/** A JSON symbol the SDK autocasts (`simple-fill`, `simple-line`, `simple-marker`, `text`). */
export type ArcgisSymbolJson = Record<string, unknown> & { type: string };

/** A JSON renderer the SDK autocasts. */
export type ArcgisRendererJson =
  | { type: "simple"; symbol: ArcgisSymbolJson }
  | {
      type: "unique-value";
      field: string;
      uniqueValueInfos: { value: string; symbol: ArcgisSymbolJson }[];
    };

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
    | { kind: "feature-service"; url: string }
    | { kind: "tile-service"; url: string }
    | { kind: "map-image"; url: string }
    | { kind: "imagery"; url: string }
    | {
        kind: "media-image";
        url: string;
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
  const filters = [
    compileLayerFilters(layer),
    layer.timeFilter,
    layer.embedFilter,
    ruleBasedVisibilityFilter(layer.style),
  ].filter(Boolean) as unknown[][];
  if (filters.length === 0) return { test: null, zoomDependent: false };
  const filter = filters.length === 1 ? filters[0] : ["all", ...filters];
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
function compileGeoJson(
  layer: GeoLibreLayer,
  geojson: FeatureCollection,
  zoom: number,
  probe: boolean,
): { parts: ArcgisGeoJsonPart[]; zoomDependent: boolean } {
  const style: LayerStyle = { ...DEFAULT_LAYER_STYLE, ...layer.style };
  if (probe) return { parts: [], zoomDependent: false };
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
    { features: Feature[]; symbols: Map<string, { id: string; symbol: ArcgisSymbolJson }> }
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
      const json = symbolForKind(kind, symbol);
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
        },
      });
    }
  });
  // A stable order — polygons under lines under points — so the SDK draws the
  // kinds the way the 2D map stacks its fill, line and circle layers.
  const order: ArcgisGeometryKind[] = ["polygon", "polyline", "point"];
  return {
    zoomDependent: resolver.zoomDependent || filter.zoomDependent || Boolean(label?.zoomDependent),
    parts: order
      .filter((kind) => parts.has(kind))
      .map((kind) => {
        const { features, symbols } = parts.get(kind)!;
        const entries = [...symbols.values()];
        const renderer: ArcgisRendererJson =
          entries.length === 1
            ? { type: "simple", symbol: entries[0].symbol }
            : {
                type: "unique-value",
                field: ARCGIS_SYMBOL_FIELD,
                uniqueValueInfos: entries.map(({ id, symbol }) => ({ value: id, symbol })),
              };
        return {
          geometryType: kind,
          features: { type: "FeatureCollection", features },
          renderer,
          ...(label ? { labelingInfo: labelingFor(kind, style, scales) } : {}),
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
    const compiled = compileGeoJson(layer, layer.geojson, zoom, probe);
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
    const kind = /FeatureServer/i.test(serviceUrl)
      ? "feature-service"
      : /ImageServer/i.test(serviceUrl)
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
      extent: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
    };
  }
  throw new Error(`Layer type ${layer.type} requires a renderer-specific adapter`);
}
