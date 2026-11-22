/**
 * Reading the symbology of an ArcGIS Pro layer file (`.lyrx`) onto an existing vector layer.
 *
 * A `.lyrx` is CIM JSON: a `CIMLayerDocument` whose `layerDefinitions` carry one or more layers,
 * each with a `renderer`. This module only unwraps the document, reads the label, and turns what
 * the shared CIM reader ({@link translateCimRenderer}) reports into sentences. The renderer,
 * symbols and colours are read there, so a `.lyrx` and an `.aprx` give the same layer the same
 * look: single symbol, unique value and graduated colour renderers import, anything else is
 * refused by name, and whatever a symbol carries that GeoLibre cannot draw is named in a warning.
 *
 * The data source a layer file points at is ignored, as the Mapbox reader ignores a style's
 * source: importing dresses the layer the user chose.
 *
 * Pure (no `maplibre-gl`), so `@geolibre/map/style-import` stays loadable under `node --test`.
 */

import { DEFAULT_LAYER_STYLE, type LabelStyle, type LayerStyle } from "@geolibre/core";
import {
  cimColor,
  translateCimRenderer,
  translateCimSymbol,
  type CimRendererIssue,
} from "./cim-renderer";

/** What a parsed layer file contributes to a layer's symbology. Mirrors the QML/SLD result. */
export interface LyrxImportResult {
  style: Partial<Omit<LayerStyle, "labels">>;
  labels: Partial<LabelStyle> | null;
  warnings: string[];
  /** 1 when the renderer was imported, 0 when there is nothing to apply. */
  matchedCount: number;
}

type CimObject = Record<string, unknown>;

/** CIM lengths are points; GeoLibre's are CSS pixels. */
const PIXELS_PER_POINT = 96 / 72;

/**
 * Style fields a CIM symbol describes in full, reset to GeoLibre's defaults before the imported
 * style is applied, as the APRX importer starts from them. A CIM symbol is the whole symbol: a
 * solid stroke has no dash, blur or arrowheads, a solid fill no pattern and no inverted fill, a
 * marker is drawn as one fixed-size circle, and an outline left at the default is opaque. Without
 * the reset the layer's own versions of these would show through. The reset covers every geometry
 * the fields apply to, so on a layer mixing geometries a line symbol also resets the points'
 * radius and the polygons' fill opacity, as importing a whole symbol in ArcGIS Pro would.
 *
 * Diagrams and geometry generators are left alone: they draw beside the symbol rather than
 * changing it, like labels from another tool. So is extrusion, which ArcGIS Pro also keeps on the
 * layer rather than in the symbol; an extruded layer goes on drawing in its extrusion colour.
 */
const WHOLE_SYMBOL_FIELDS = [
  "strokeOpacity",
  "strokeWidth",
  "strokeWidthUnit",
  "strokeDash",
  "strokeBlur",
  "lineDecoration",
  "invertedFillEnabled",
  "fillOpacity",
  "fillPattern",
  "circleRadius",
  "markerEnabled",
  "pointRenderer",
  "proportionalSizeEnabled",
] as const satisfies readonly (keyof LayerStyle)[];

/**
 * Renderer names that read better than the CIM type spelled out, keyed by the `cimType` the shared
 * reader reports: the renderer type, or for a class breaks renderer of a break type other than
 * graduated colours its `classBreakType` (such as `UnclassedColor`).
 */
const RENDERER_NAMES = new Map([
  ["CIMProportionalRenderer", "proportional symbols"],
  ["CIMChartRenderer", "charts"],
  ["CIMUnclassedColorsRenderer", "unclassed colours"],
  ["UnclassedColor", "unclassed colours"],
]);

/** The ending a refused renderer's warning shares, since nothing of it is applied. */
const KEEPS_STYLE = "the layer keeps its current style.";

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
  if (!isObject(layer.renderer)) {
    result.warnings.push("The .lyrx style's feature layer has no renderer to import.");
    return result;
  }

  const translation = translateCimRenderer(layer.renderer);
  // A refused renderer is refused whole. The translation may still hold its single or default
  // symbol, which the APRX importer uses to give a new layer some colour, but here it would
  // replace the user's own style with a fraction of the file's.
  if (!translation.translated) {
    result.warnings.push(...translation.issues.map(refusal));
    return result;
  }
  result.style = translation.style;
  result.matchedCount = 1;
  result.warnings.push(...translation.issues.map(partial));
  if (featureLayers.length > 1) {
    const name = stringOf(layer.name);
    result.warnings.push(
      `The .lyrx style holds ${featureLayers.length} feature layers; only the first, "${name}", was imported.`,
    );
  }
  result.labels = readLabels(layer, result.warnings);
  return result;
}

/** Merge a parsed layer file over a base style. Mirrors {@link applyQmlImport}. */
export function applyLyrxImport(base: LayerStyle, result: LyrxImportResult): LayerStyle {
  const reset: Partial<LayerStyle> = {};
  if (result.matchedCount > 0) {
    for (const key of WHOLE_SYMBOL_FIELDS) {
      Object.assign(reset, { [key]: structuredClone(DEFAULT_LAYER_STYLE[key]) });
    }
  }
  return {
    ...base,
    ...reset,
    ...result.style,
    labels: result.labels ? { ...base.labels, ...result.labels } : base.labels,
  };
}

/** The warning for a renderer that was refused. Leads, since a one-line surface shows only it. */
function refusal(issue: CimRendererIssue): string {
  switch (issue.code) {
    case "multiple-fields":
      return `The .lyrx style's unique values are not on exactly one field, which GeoLibre cannot import; ${KEEPS_STYLE}`;
    case "expression":
      return `The .lyrx style's symbology is driven by an Arcade expression, which GeoLibre cannot import; ${KEEPS_STYLE}`;
    case "normalization":
      return `The .lyrx style's class breaks are normalised, which GeoLibre cannot import; ${KEEPS_STYLE}`;
    case "graduated-symbols":
      return `The .lyrx style uses graduated symbols (classes drawn by size), which GeoLibre cannot import; ${KEEPS_STYLE}`;
    case "exclusion":
      return `The .lyrx style's class breaks exclude values with a clause, which GeoLibre cannot import; ${KEEPS_STYLE}`;
    case "symbol": {
      // The reader names the symbol, or the first enabled layer it cannot draw flat (a picture
      // or hatch fill, a picture marker), so the user knows what to change in ArcGIS Pro.
      if (issue.cimType?.endsWith("Symbol")) {
        return `The .lyrx style's ${typeName(
          issue.cimType,
          /Symbol$/,
        )} symbol has no fill, outline or marker GeoLibre can import; ${KEEPS_STYLE}`;
      }
      const layer = typeName(issue.cimType);
      return layer
        ? `A symbol in the .lyrx style has nothing GeoLibre can import (its ${layer} cannot be drawn); ${KEEPS_STYLE}`
        : `The .lyrx style's symbol has no fill, outline or marker GeoLibre can import; ${KEEPS_STYLE}`;
    }
    case "no-classes":
      return `The .lyrx style's renderer has no classes GeoLibre can import; ${KEEPS_STYLE}`;
    default: {
      const name =
        RENDERER_NAMES.get(issue.cimType ?? "") ??
        (typeName(issue.cimType, /Renderer$/) || "unrecognised");
      return `The .lyrx style uses the ${name} renderer, which GeoLibre cannot import; ${KEEPS_STYLE}`;
    }
  }
}

/** The warning for something an imported renderer left out. */
function partial(issue: CimRendererIssue): string {
  const name = typeName(issue.cimType);
  switch (issue.code) {
    case "visual-variables":
      return "The .lyrx style's visual variables (size, colour, rotation or transparency by attribute) were not imported.";
    case "symbol-layers":
      return `${article(
        name,
      )} ${name} in the .lyrx style's symbols was not imported, so the symbols draw without it.`;
    case "color": {
      const kind = colourName(issue.cimType);
      return `A fill or outline colour in the .lyrx style${
        kind ? ` (${kind})` : ""
      } could not be read, so that fill or outline is not drawn.`;
    }
    case "transparency":
      return "The .lyrx style's classes have different line or outline transparencies; all lines and outlines were imported at one shared transparency.";
    case "effects":
      return `A geometric effect in the .lyrx style (${
        typeName(issue.cimType, /^GeometricEffect/) || "unnamed"
      }) was not imported, so the symbols draw solid and in place.`;
    case "marker-shape":
      return `The .lyrx style's ${name} is drawn as a circle, not in its own shape.`;
    case "alternate-symbols":
      return "The .lyrx style's alternate symbols for other map scales were not imported; the main symbols draw at every scale.";
    default:
      return `Part of the .lyrx style (${issue.code}) was not imported.`;
  }
}

/**
 * A CIM type in plain words: `CIMHatchFill` reads "hatch fill", `CIMHeatMapRenderer` (with the
 * `Renderer` suffix dropped) "heat map".
 */
function typeName(type: string | undefined, suffix?: RegExp): string {
  let name = (type ?? "").replace(/^CIM/, "");
  if (suffix) name = name.replace(suffix, "");
  return name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

/** A colour subclass in plain words, keeping its model's capitals: `CIMHSLColor` is "HSL colour". */
function colourName(type: string | undefined): string {
  const model = /^CIM(\w+)Color$/.exec(type ?? "")?.[1];
  return model ? `${model} colour` : "";
}

function article(noun: string): string {
  return /^[aeiou]/.test(noun) ? "An" : "A";
}

/**
 * The label of a layer whose labels are on, from its first visible label class.
 *
 * Labels that are off in the layer file (`labelVisibility` or every class's `visibility` omitted,
 * which is how Pro saves false) are turned off, as the file describes the whole layer.
 *
 * Only a bare field reference reads: `[NAME]` (VBScript/Python/JScript) or `$feature.NAME` /
 * `$feature["NAME"]` (Arcade). A computed expression is named in a warning and leaves the layer's
 * labels as they are.
 */
function readLabels(layer: CimObject, warnings: string[]): Partial<LabelStyle> | null {
  if (layer.labelVisibility !== true) return { enabled: false };
  const visible = arrayOf(layer.labelClasses).filter((candidate) => candidate.visibility === true);
  const labelClass = visible[0];
  if (visible.length > 1) {
    warnings.push(
      `The .lyrx style has ${visible.length} visible label classes; only the first was imported.`,
    );
  }
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
  if (stringOf(labelClass.whereClause).trim()) {
    warnings.push(
      "The .lyrx style's label filter (where clause) was not imported, so every feature is labelled.",
    );
  }
  // The file's label replaces the layer's: a text expression would take precedence over the field,
  // and a data-defined opacity or visibility would hide labels the file shows.
  return {
    enabled: true,
    field,
    expression: "",
    opacityExpression: "",
    visibilityExpression: "",
    ...readTextSymbol(labelClass, warnings),
  };
}

/**
 * A label class's text size, colour and halo, from its `CIMTextSymbol`. The text and halo are
 * each drawn with a polygon symbol, read by the shared CIM reader. CIM leaves out a zero halo
 * size, so a missing one means no halo, and so does a fully transparent halo.
 *
 * A data-defined size or colour on the layer is cleared with the value it would override.
 * Transparency is not carried: a label colour is a plain hex colour, which the SLD and QML
 * exporters need, so partly transparent text or halo is named in a warning instead. So is anything
 * else the text or halo symbol draws that a label cannot (an outline, a hatch, a second fill).
 */
function readTextSymbol(labelClass: CimObject, warnings: string[]): Partial<LabelStyle> {
  const text = objectOf(objectOf(labelClass.textSymbol)?.symbol);
  if (!text) {
    if (labelClass.textSymbol !== undefined) {
      warnings.push(
        "The .lyrx style's label text symbol could not be read, so the labels keep the layer's own text style.",
      );
    }
    return {};
  }
  const labels: Partial<LabelStyle> = {};
  let translucent = false;
  const height = numberOf(text.height);
  if (height !== null && height > 0) {
    labels.size = round(height * PIXELS_PER_POINT);
    labels.sizeExpression = "";
  }
  const textTranslation = translateCimSymbol({ symbol: text.symbol });
  const textLook = textTranslation.style;
  const leftOut = labelParts("text", textTranslation);
  // Hollow text (an outline, no fill) reads as the outline colour at fill opacity 0; it draws
  // opaque in that colour, and the outline warning below already names it. The same placeholder
  // stands in for a fill whose colour could not be read, which keeps the layer's text colour.
  // Clear text with no outline draws nothing in ArcGIS Pro; a label cannot be invisible, so the
  // layer keeps its own text colour rather than gaining a colour the file never shows.
  const textOpacity = textLook.fillOpacity ?? 1;
  const hollow = textOpacity === 0 && (textLook.strokeWidth ?? 0) > 0;
  const unreadableFill =
    textOpacity === 0 && textTranslation.issues.some((issue) => issue.code === "color");
  const textLayer = refusedLayer(textTranslation);
  const clear = textOpacity === 0 && !hollow && !unreadableFill;
  if (clear && textLook.fillColor) {
    warnings.push(
      "The .lyrx style's label text is fully transparent, which GeoLibre labels cannot draw; labels keep their colour.",
    );
  } else if (textLook.fillColor && !unreadableFill) {
    labels.color = textLook.fillColor;
    labels.colorExpression = "";
    translucent ||= textOpacity < 1 && !hollow;
  } else if (textLayer) {
    warnings.push(
      `The .lyrx style's label text symbol has nothing GeoLibre can draw (its ${textLayer} cannot be drawn); labels keep their colour.`,
    );
  } else {
    // The reader reports an empty text symbol and one whose colour it cannot read alike.
    warnings.push(
      "The .lyrx style's label text has no fill colour GeoLibre can read; labels keep their colour.",
    );
  }
  const haloSize = numberOf(text.haloSize) ?? 0;
  // ArcGIS Pro draws a halo only from a halo symbol. Its default text symbol keeps a halo size
  // (usually 1) with no halo symbol, which draws none, so that reads as no halo, without a warning.
  const haloTranslation =
    haloSize > 0 && text.haloSymbol !== undefined
      ? translateCimSymbol({ symbol: text.haloSymbol })
      : undefined;
  const haloLook = haloTranslation?.style;
  const haloOpacity = haloLook?.fillOpacity ?? 1;
  if (haloLook?.fillColor && haloOpacity > 0) {
    labels.haloColor = haloLook.fillColor;
    labels.haloWidth = round(haloSize * PIXELS_PER_POINT);
    translucent ||= haloOpacity < 1;
  } else {
    labels.haloWidth = 0;
    const haloLayer = haloTranslation ? refusedLayer(haloTranslation) : "";
    if (haloLayer) {
      warnings.push(
        `The .lyrx style's label halo has nothing GeoLibre can draw (its ${haloLayer} cannot be drawn), so labels have no halo.`,
      );
    } else if (haloLook && !haloLook.fillColor) {
      warnings.push(
        "The .lyrx style's label halo colour could not be read, so labels have no halo.",
      );
    }
  }
  // A clear halo fill with a visible outline is an outlined halo, which a label cannot draw; one
  // with no outline either is no halo at all, as ArcGIS Pro draws it.
  if (haloTranslation) leftOut.push(...labelParts("halo", haloTranslation));
  if (leftOut.length > 0) {
    warnings.push(
      `Part of the .lyrx style's label symbol was not imported: ${leftOut.join(", ")}.`,
    );
  }
  if (translucent) {
    warnings.push(
      "The .lyrx style's label transparency was not imported; labels are drawn opaque.",
    );
  }
  // A drop shadow draws only when it is offset; Pro writes a shadow colour on most text symbols
  // with both offsets at 0.
  const shadow = cimColor(text.shadowColor);
  const offset =
    (numberOf(text.shadowOffsetX) ?? 0) !== 0 || (numberOf(text.shadowOffsetY) ?? 0) !== 0;
  if (offset && shadow && shadow.opacity > 0) {
    warnings.push("The .lyrx style's label shadow was not imported; labels draw without it.");
  }
  const font = stringOf(text.fontFamilyName);
  if (font) {
    warnings.push(
      `The .lyrx style's label font (${font}) was not imported; labels use GeoLibre's font.`,
    );
  }
  return labels;
}

/**
 * What a label's text or halo symbol draws that a label cannot: an outline (a label has one halo,
 * not an outlined one), and whatever the shared reader reports leaving out of the symbol. A
 * symbol it refuses outright is reported as an unreadable colour instead.
 */
function labelParts(
  part: "text" | "halo",
  translation: ReturnType<typeof translateCimSymbol>,
): string[] {
  const { style, issues } = translation;
  if (!translation.translated) return [];
  const parts: string[] = [];
  if ((style.strokeWidth ?? 0) > 0) parts.push(`the ${part} outline`);
  for (const issue of issues) {
    const name =
      issue.code === "effects"
        ? typeName(issue.cimType, /^GeometricEffect/) || "geometric effect"
        : issue.code === "color"
          ? colourName(issue.cimType) || "colour"
          : typeName(issue.cimType) || issue.code;
    parts.push(`the ${part} ${name}`);
  }
  return parts;
}

/**
 * The symbol layer that made the shared reader refuse a label's text or halo symbol, in plain words
 * ("hatch fill"), or "" when the symbol was read or the reader names only the symbol (an unreadable
 * colour, or no layers at all).
 */
function refusedLayer(translation: ReturnType<typeof translateCimSymbol>): string {
  if (translation.translated) return "";
  const type = translation.issues.find((issue) => issue.code === "symbol")?.cimType;
  return type && !type.endsWith("Symbol") ? typeName(type) : "";
}

/**
 * Rounds away float noise from the point-to-pixel conversion (`0.3 * 96 / 72` is
 * 0.39999999999999997), to four places as the shared CIM reader rounds its widths.
 */
function round(value: number): number {
  return Math.round(value * 10000) / 10000;
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
