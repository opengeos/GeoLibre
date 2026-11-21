import { effectiveVectorRules, isHexColor, styleValue, type LayerStyle } from "@geolibre/core";

/** Most color bands a Style manager thumbnail splits its polygon glyph into. */
export const MAX_STYLE_PREVIEW_COLORS = 6;

/**
 * The class colors a style draws with, for the Style manager's thumbnail.
 *
 * A rule-based, graduated or categorized style colors features per class, so
 * its flat `fillColor` (which for a rule-based style usually holds the else
 * rule's color) does not describe it (GeoLibre#3471). This returns the
 * drawable rule colors followed by the else rule's, or the stop colors, evenly
 * sampled down to {@link MAX_STYLE_PREVIEW_COLORS}.
 *
 * @param style - A complete layer style.
 * @returns The class colors, or `null` for a style drawn in one color.
 */
export function stylePreviewColors(style: LayerStyle): string[] | null {
  const mode = styleValue(style, "vectorStyleMode");
  let colors: string[] = [];
  if (mode === "rule-based") {
    const { rules, elseRule } = effectiveVectorRules(style);
    colors = rules.map((rule) => rule.color);
    if (elseRule && isHexColor(elseRule.color)) colors.push(elseRule.color);
  } else if (mode === "graduated" || mode === "categorized") {
    const stops = styleValue(style, "vectorStyleStops");
    colors = Array.isArray(stops) ? stops.map((stop) => stop.color) : [];
  }
  // An invalid color would draw as a black band, so keep the valid ones only.
  colors = colors.filter(isHexColor);
  if (colors.length === 0) return null;
  if (colors.length <= MAX_STYLE_PREVIEW_COLORS) return colors;
  return Array.from(
    { length: MAX_STYLE_PREVIEW_COLORS },
    (_, index) =>
      colors[Math.round((index * (colors.length - 1)) / (MAX_STYLE_PREVIEW_COLORS - 1))],
  );
}
