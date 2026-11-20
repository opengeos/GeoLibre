/**
 * Reading the symbology of an ArcGIS Pro layer file (`.lyrx`) onto an existing vector layer.
 *
 * A `.lyrx` is CIM JSON: a `CIMLayerDocument` whose `layerDefinitions` carry one or more layers,
 * each with a `renderer`. Only a simple (single symbol) renderer is read, from solid fills, solid
 * strokes and vector or character markers. Any other renderer is refused by name, and a symbol
 * layer GeoLibre cannot draw is named in a warning, rather than importing a half-style silently.
 *
 * Unique value and class breaks renderers are refused for now: ArcGIS's class semantics (upper
 * bound inclusive breaks, `<Null>` and hidden classes, an optional default symbol) need an exact
 * rule-based translation, which belongs with the shared CIM renderer translator rather than a
 * second approximate copy here.
 *
 * The data source a layer file points at is ignored, as the Mapbox reader ignores a style's
 * source: importing dresses the layer the user chose.
 *
 * Pure (no `maplibre-gl`), so `@geolibre/map/style-import` stays loadable under `node --test`.
 */

import type { LabelStyle, LayerStyle } from "@geolibre/core";

/** What a parsed layer file contributes to a layer's symbology. Mirrors the QML/SLD result. */
export interface LyrxImportResult {
  style: Partial<Omit<LayerStyle, "labels">>;
  labels: Partial<LabelStyle> | null;
  warnings: string[];
  /** How many renderer symbols/classes were understood; 0 means nothing to apply. */
  matchedCount: number;
}

type CimObject = Record<string, unknown>;

/** CIM lengths are points; GeoLibre's are CSS pixels. */
const PIXELS_PER_POINT = 96 / 72;

/** Renderer names for the refusal message, so the user reads "heat map", not a CIM type. */
const UNSUPPORTED_RENDERER_NAMES: Record<string, string> = {
  CIMHeatMapRenderer: "heat map",
  CIMDotDensityRenderer: "dot density",
  CIMProportionalRenderer: "proportional symbols",
  CIMChartRenderer: "charts",
  CIMDictionaryRenderer: "dictionary",
  CIMRepresentationRenderer: "representation",
  CIMUnclassedColorsRenderer: "unclassed colours",
  CIMUniqueValueRenderer: "unique values",
  CIMClassBreaksRenderer: "class breaks",
};

/** Symbol layer types worth naming in a warning when they are left behind. */
const UNSUPPORTED_SYMBOL_LAYER_NAMES: Record<string, string> = {
  CIMPictureFill: "picture fill",
  CIMHatchFill: "hatch fill",
  CIMGradientFill: "gradient fill",
  CIMPictureStroke: "picture stroke",
  CIMGradientStroke: "gradient stroke",
  CIMPictureMarker: "picture marker",
};

/**
 * Whether a parsed JSON value is an ArcGIS Pro layer document.
 *
 * Exported so the style-import sniffing and its tests agree on the one check.
 */
export function isLyrxDocument(value: unknown): boolean {
  return isObject(value) && value.type === "CIMLayerDocument";
}

/**
 * Read a parsed `.lyrx` document.
 *
 * @param document - The .lyrx style's JSON, already parsed and known to be a `CIMLayerDocument`.
 */
export function parseLyrx(document: unknown): LyrxImportResult {
  const result: LyrxImportResult = { style: {}, labels: null, warnings: [], matchedCount: 0 };
  const definitions = isObject(document) ? arrayOf(document.layerDefinitions) : [];
  const featureLayers = definitions.filter((layer) =>
    stringOf(layer.type).startsWith("CIMFeatureLayer"),
  );
  const layer = featureLayers[0];
  if (!layer) {
    result.warnings.push(
      "The .lyrx style has no feature layer, so it has no vector symbology to import.",
    );
    return result;
  }
  const renderer = objectOf(layer.renderer);
  const rendererType = stringOf(renderer?.type);
  const notes = new Set<string>();
  if (!renderer) {
    result.warnings.push("The .lyrx style's feature layer has no renderer to import.");
    return result;
  }
  if (rendererType === "CIMSimpleRenderer") {
    result.matchedCount = readSimple(renderer, result.style, notes);
    // Leads the warnings, since a one-line surface shows only the first.
    if (result.matchedCount === 0) {
      // "CIMPolygonSymbol" reads as "polygon symbol".
      const kind = stringOf(objectOf(objectOf(renderer.symbol)?.symbol)?.type)
        .replace(/^CIM|Symbol$/g, "")
        .toLowerCase();
      result.warnings.push(
        `The .lyrx style's ${kind ? `${kind} symbol` : "symbol"} has no fill, outline or marker GeoLibre can import; the layer keeps its current style.`,
      );
    }
  } else {
    const name =
      (Object.hasOwn(UNSUPPORTED_RENDERER_NAMES, rendererType)
        ? UNSUPPORTED_RENDERER_NAMES[rendererType]
        : undefined) ??
      (rendererType.replace(/^CIM|Renderer$/g, "") || "unrecognised");
    result.warnings.push(
      `The .lyrx style uses the ${name} renderer, which GeoLibre cannot import; the layer keeps its current style.`,
    );
  }
  if (notes.size > 0) {
    result.warnings.push(`Not imported from the .lyrx style: ${[...notes].join(", ")}.`);
  }
  if (result.matchedCount === 0) return result;

  if (featureLayers.length > 1) {
    result.warnings.push(
      `The .lyrx style holds ${featureLayers.length} feature layers; only the first, "${stringOf(layer.name)}", was imported.`,
    );
  }
  result.labels = readLabels(layer, result.warnings);
  return result;
}

/** Merge a parsed layer file over a base style. Mirrors {@link applyQmlImport}. */
export function applyLyrxImport(base: LayerStyle, result: LyrxImportResult): LayerStyle {
  return {
    ...base,
    ...result.style,
    labels: result.labels ? { ...base.labels, ...result.labels } : base.labels,
  };
}

/** The flat symbology of one CIM symbol, as far as GeoLibre can carry it. */
interface SymbolInfo {
  geometry: "polygon" | "line" | "point" | "unknown";
  fill?: { color: string; opacity: number };
  stroke?: { color: string; opacity: number; width: number | null; dashed: boolean };
  /** Marker size in points (CIM's own unit); converted to a radius on write. */
  markerSize?: number;
  /** Whether a point marker was read, with or without a size. */
  markerRead?: boolean;
  /** A fill or outline was there but its colour type is not one GeoLibre reads, so the layer
   * keeps its own rather than being made hollow. */
  fillUnread?: boolean;
  strokeUnread?: boolean;
}

function readSymbolReference(reference: unknown, notes: Set<string>): SymbolInfo | null {
  const symbol = objectOf(objectOf(reference)?.symbol);
  return symbol ? readSymbol(symbol, notes) : null;
}

function readSymbol(symbol: CimObject, notes: Set<string>): SymbolInfo {
  const type = stringOf(symbol.type);
  const info: SymbolInfo = {
    geometry:
      type === "CIMPolygonSymbol"
        ? "polygon"
        : type === "CIMLineSymbol"
          ? "line"
          : type === "CIMPointSymbol"
            ? "point"
            : "unknown",
  };
  // A dash effect can sit on the whole symbol as well as on one stroke.
  const isDashes = (effect: CimObject) => effect.type === "CIMGeometricEffectDashes";
  const symbolDashed = arrayOf(symbol.effects).some(isDashes);
  // CIM lists symbol layers top first, so the first enabled one of each kind is what shows. Pro
  // omits false booleans when it saves CIM JSON, so a layer without `enable: true` is switched off.
  for (const layer of arrayOf(symbol.symbolLayers)) {
    if (layer.enable !== true) continue;
    const layerType = stringOf(layer.type);
    if (layerType === "CIMSolidFill") {
      const color = cimColor(objectOf(layer.color));
      if (!color) {
        notes.add("colours GeoLibre cannot read");
        if (!info.fill) info.fillUnread = true;
      } else if (!info.fill) info.fill = color;
      else notes.add("extra fill and outline layers");
    } else if (layerType === "CIMSolidStroke") {
      const color = cimColor(objectOf(layer.color));
      if (!color) {
        notes.add("colours GeoLibre cannot read");
        if (!info.stroke) info.strokeUnread = true;
      } else if (!info.stroke) {
        const dashed = symbolDashed || arrayOf(layer.effects).some(isDashes);
        if (dashed) notes.add("dash pattern");
        info.stroke = { ...color, width: numberOf(layer.width), dashed };
      } else {
        notes.add("extra fill and outline layers");
      }
    } else if (layerType === "CIMVectorMarker" || layerType === "CIMCharacterMarker") {
      // On a line or polygon a marker is a decoration (an arrowhead, a hatch of symbols), often
      // listed above the stroke, so reading it would take its outline for the line's own.
      if (info.geometry !== "point") {
        notes.add("markers along lines and outlines");
        continue;
      }
      if (info.markerRead) {
        notes.add("extra point markers");
        continue;
      }
      info.markerRead = true;
      info.markerSize = numberOf(layer.size) ?? undefined;
      // Drawn as a circle either way. A glyph, or graphics other than a circle, is a shape
      // GeoLibre does not carry.
      const circular =
        layerType === "CIMVectorMarker" &&
        arrayOf(layer.markerGraphics).every((graphic) => isCircle(objectOf(graphic.geometry)));
      if (!circular) notes.add("marker shape (drawn as a circle)");
      // A vector marker draws its graphics, a character marker its glyph, each with a nested
      // symbol whose fill and outline are the marker's colours.
      const nested =
        layerType === "CIMVectorMarker"
          ? arrayOf(layer.markerGraphics).map((graphic) => objectOf(graphic.symbol))
          : [objectOf(layer.symbol)];
      for (const inner of nested) {
        if (!inner) continue;
        const read = readSymbol(inner, notes);
        // A later graphic's colours are not read, so say so rather than drop them silently.
        if ((info.fill && read.fill) || (info.stroke && read.stroke)) {
          notes.add("extra marker graphics");
        }
        info.fill ??= read.fill;
        info.stroke ??= read.stroke;
        info.fillUnread ||= read.fillUnread;
        info.strokeUnread ||= read.strokeUnread;
      }
    } else if (Object.hasOwn(UNSUPPORTED_SYMBOL_LAYER_NAMES, layerType)) {
      notes.add(UNSUPPORTED_SYMBOL_LAYER_NAMES[layerType]);
      // Keep the layer's own fill or outline rather than clearing it for one GeoLibre cannot draw.
      if (layerType.endsWith("Fill") && !info.fill) info.fillUnread = true;
      else if (layerType.endsWith("Stroke") && !info.stroke) info.strokeUnread = true;
    }
  }
  return info;
}

/** Write one symbol's flat symbology (fill, stroke, marker size) onto the patch. */
function applySymbol(info: SymbolInfo, patch: Partial<Omit<LayerStyle, "labels">>): void {
  // A CIM symbol is the whole symbol: a polygon or marker without an outline has none, and one
  // without a fill is hollow, rather than keeping whatever the layer had.
  const areal = info.geometry === "polygon" || info.geometry === "point";
  if (info.fill) {
    patch.fillColor = info.fill.color;
    patch.fillOpacity = info.fill.opacity;
    // A solid fill: a pattern the layer had would otherwise draw over it.
    patch.fillPattern = "none";
  } else if (areal && !info.fillUnread) {
    patch.fillOpacity = 0;
  }
  if (info.stroke) {
    patch.strokeColor = info.stroke.color;
    patch.strokeOpacity = info.stroke.opacity;
    // A dashed stroke's pattern is not read (and is named in a warning), so the layer keeps its own.
    if (!info.stroke.dashed) patch.strokeDash = [];
    if (info.stroke.width !== null) {
      patch.strokeWidth = round(info.stroke.width * PIXELS_PER_POINT);
      patch.strokeWidthUnit = "pixels";
    }
  } else if (areal && !info.strokeUnread) {
    patch.strokeOpacity = 0;
  }
  if (info.geometry === "point") {
    // Read as a circle, so an icon marker the layer had would hide what was imported.
    patch.markerEnabled = false;
    // As the Mapbox reader does for a circle: a heatmap or cluster would hide the symbol.
    patch.pointRenderer = "single";
  }
  if (info.markerSize !== undefined) {
    // A CIM marker size is its diameter in points; GeoLibre's is a radius in pixels.
    patch.circleRadius = round((info.markerSize * PIXELS_PER_POINT) / 2);
    // A fixed size, which proportional sizing would otherwise override.
    patch.proportionalSizeEnabled = false;
  }
}

function readSimple(
  renderer: CimObject,
  patch: Partial<Omit<LayerStyle, "labels">>,
  notes: Set<string>,
): number {
  const info = readSymbolReference(renderer.symbol, notes);
  // A readable colour is what makes the symbol visible: a marker size alone would import as an
  // invisible circle, and an unreadable colour leaves nothing to apply.
  if (!info || (!info.fill && !info.stroke)) return 0;
  applySymbol(info, patch);
  patch.vectorStyleMode = "single";
  return 1;
}

/**
 * The label field of a layer whose labels are on, from its first label class.
 *
 * Labels that are off in the layer file (`labelVisibility` or every class's `visibility` omitted,
 * which is how Pro saves false) are turned off, as the file describes the whole layer.
 *
 * Only a bare field reference reads: `[NAME]` (VBScript/Python/JScript) or `$feature.NAME` /
 * `$feature["NAME"]` (Arcade). A computed expression is named in a warning.
 */
function readLabels(layer: CimObject, warnings: string[]): Partial<LabelStyle> | null {
  if (layer.labelVisibility !== true) return { enabled: false };
  const labelClass = arrayOf(layer.labelClasses).find((candidate) => candidate.visibility === true);
  if (!labelClass) return { enabled: false };
  const expression = stringOf(labelClass.expression).trim();
  const field =
    expression.match(/^\[([^\]]+)\]$/)?.[1]?.trim() ??
    expression.match(/^\$feature\.([A-Za-z_][A-Za-z0-9_]*)$/)?.[1] ??
    expression.match(/^\$feature\[\s*["']([^"']+)["']\s*\]$/)?.[1];
  if (!field) {
    warnings.push(
      "The .lyrx style's label expression is not a single field, so its labels were not imported.",
    );
    return null;
  }
  // Only the field is read; the text symbol is named rather than dropped silently.
  if (labelClass.textSymbol !== undefined) {
    warnings.push(
      "The .lyrx style's label font, size, colour and halo were not imported; the labels keep the layer's own text style.",
    );
  }
  if (stringOf(labelClass.whereClause).trim()) {
    warnings.push(
      "The .lyrx style's label filter (where clause) was not imported, so every feature is labelled.",
    );
  }
  // Cleared, because a label expression takes precedence over the field.
  return { enabled: true, field, expression: "" };
}

/**
 * Convert a CIM colour to hex plus opacity.
 *
 * Every CIMColor subclass stores its channels in `values` with alpha last, but the meaning differs
 * per subclass (CIM spec, docs/v3/CIMColor.md): RGB 0-255, CMYK/Gray/S/V 0-100, hue 0-360, alpha
 * 0-100. An unrecognised subclass returns null rather than an invented colour.
 */
function cimColor(color: CimObject | undefined): { color: string; opacity: number } | null {
  if (!color) return null;
  const type = stringOf(color.type);
  // `Number(null)` is 0, so only real numbers count; anything else makes the colour unreadable.
  const values = Array.isArray(color.values)
    ? color.values.map((value) => (typeof value === "number" ? value : Number.NaN))
    : [];
  if (values.some((value) => !Number.isFinite(value))) return null;

  let rgb: [number, number, number] | null = null;
  let alpha: number | undefined;
  if (type === "CIMRGBColor" && values.length >= 3) {
    rgb = [values[0], values[1], values[2]];
    alpha = values[3];
  } else if (type === "CIMGrayColor" && values.length >= 1) {
    const level = (values[0] / 100) * 255;
    rgb = [level, level, level];
    alpha = values[1];
  } else if (type === "CIMCMYKColor" && values.length >= 4) {
    const [c, m, y, k] = values;
    rgb = [
      255 * (1 - c / 100) * (1 - k / 100),
      255 * (1 - m / 100) * (1 - k / 100),
      255 * (1 - y / 100) * (1 - k / 100),
    ];
    alpha = values[4];
  } else if (type === "CIMHSVColor" && values.length >= 3) {
    rgb = hsvToRgb(values[0], values[1] / 100, values[2] / 100);
    alpha = values[3];
  }
  if (!rgb) return null;

  const hex = `#${rgb
    .map((value) =>
      Math.max(0, Math.min(255, Math.round(value)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
  return { color: hex, opacity: Math.max(0, Math.min(1, (alpha ?? 100) / 100)) };
}

function hsvToRgb(hue: number, saturation: number, value: number): [number, number, number] {
  const h = (((hue % 360) + 360) % 360) / 60;
  const s = Math.max(0, Math.min(1, saturation));
  const v = Math.max(0, Math.min(1, value));
  const chroma = v * s;
  const second = chroma * (1 - Math.abs((h % 2) - 1));
  const [r, g, b] =
    h < 1
      ? [chroma, second, 0]
      : h < 2
        ? [second, chroma, 0]
        : h < 3
          ? [0, chroma, second]
          : h < 4
            ? [0, second, chroma]
            : h < 5
              ? [second, 0, chroma]
              : [chroma, 0, second];
  const match = v - chroma;
  return [(r + match) * 255, (g + match) * 255, (b + match) * 255];
}

/**
 * Whether a marker graphic is a full circle as Pro writes one: a single curve ring holding its
 * start point and one arc (`a`) that ends back at that point. A rounded square or any other curved
 * shape has more segments.
 */
function isCircle(geometry: CimObject | undefined): boolean {
  const rings = geometry?.curveRings;
  if (!Array.isArray(rings) || rings.length !== 1) return false;
  const ring = rings[0];
  if (!Array.isArray(ring) || ring.length !== 2) return false;
  const [start, segment] = ring;
  const arc = objectOf(segment)?.a;
  return (
    Array.isArray(start) &&
    Array.isArray(arc) &&
    Array.isArray(arc[0]) &&
    arc[0][0] === start[0] &&
    arc[0][1] === start[1]
  );
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function isObject(value: unknown): value is CimObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectOf(value: unknown): CimObject | undefined {
  return isObject(value) ? value : undefined;
}

function arrayOf(value: unknown): CimObject[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
