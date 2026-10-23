/**
 * Resolve the label font stack from a basemap style, shared by the MapLibre
 * and Mapbox layer compilers. A style only serves the glyph ranges of its own
 * font catalog, so project labels must borrow a font the active style already
 * uses or they silently fail to render.
 */

// Operators that can start a data-driven text-font expression. A bare
// ["get", "font"] is all strings, so an every(typeof === "string") check
// alone would mistake it for a font stack.
const FONT_EXPRESSION_OPERATORS = new Set([
  "literal",
  "get",
  "has",
  "at",
  "in",
  "case",
  "match",
  "coalesce",
  "step",
  "interpolate",
  "let",
  "var",
  "concat",
  "to-string",
  "string",
  "array",
  "format",
]);

/** The minimal style-layer shape the resolver reads. */
export interface TextFontStyleLayer {
  type: string;
  layout?: Record<string, unknown>;
}

/**
 * The first text-bearing symbol layer's font stack, or `fallback` when the
 * style has none (a blank or raster-only basemap).
 */
export function resolveTextFontFromStyleLayers(
  layers: readonly TextFontStyleLayer[] | undefined,
  fallback: string[],
): string[] {
  for (const styleLayer of layers ?? []) {
    if (styleLayer.type !== "symbol") continue;
    // Icon-only symbol layers may carry a glyph/sprite font unsuited to text.
    if (!styleLayer.layout?.["text-field"]) continue;
    const textFont = styleLayer.layout?.["text-font"];
    if (!Array.isArray(textFont)) continue;
    // Unwrap the ["literal", ["Font A", "Font B"]] expression form used by
    // many popular styles.
    const fonts =
      textFont[0] === "literal" && Array.isArray(textFont[1])
        ? (textFont[1] as unknown[])
        : (textFont as unknown[]);
    if (
      fonts.length > 0 &&
      fonts.every((font) => typeof font === "string") &&
      !FONT_EXPRESSION_OPERATORS.has(fonts[0] as string)
    ) {
      return fonts as string[];
    }
  }
  return fallback;
}
