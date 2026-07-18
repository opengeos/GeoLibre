/**
 * Pure color helpers for charts. Provides the default categorical palette and,
 * when a widget picks a custom color, a monochromatic ramp derived from it so
 * bar/pie marks stay distinguishable. Kept React-free so it can be unit-tested.
 */

/**
 * Categorical color palette for charts whose marks are distinct categories
 * (bar, pie) when no custom color is chosen. Fixed hues (not theme CSS vars) so
 * each category reads as its own color on both light and dark backgrounds, à la
 * Foursquare/CARTO dashboards.
 */
export const CHART_PALETTE = [
  "#3fb1ce", // teal
  "#f4a259", // orange
  "#8b5cf6", // violet
  "#22c55e", // green
  "#eab308", // amber
  "#ef4444", // red
  "#0ea5e9", // sky
  "#ec4899", // pink
];

/** The palette color for the category at `index`, cycling when it overflows. */
export function paletteColor(index: number): string {
  return CHART_PALETTE[index % CHART_PALETTE.length];
}

/** A 3- or 6-digit hex color (with leading `#`), the format we accept and store. */
const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Whether `value` is a hex color string we can use as an SVG fill. */
export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR.test(value.trim());
}

/** Parse a #rgb or #rrggbb string into [r, g, b] (0-255), or null when invalid. */
function parseHex(color: string): [number, number, number] | null {
  const hex = color.trim().replace(/^#/, "");
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex;
  if (full.length !== 6) return null;
  const value = Number.parseInt(full, 16);
  if (!Number.isFinite(value)) return null;
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function toHex(channel: number): string {
  return Math.max(0, Math.min(255, Math.round(channel)))
    .toString(16)
    .padStart(2, "0");
}

/**
 * Build `count` shades of `base`, from the base color toward a lighter tint, so
 * a single chosen color yields a readable monochromatic scheme across
 * categories. Returns the base repeated when it can't be parsed.
 *
 * @param base A hex color (#rgb or #rrggbb).
 * @param count How many shades to produce (>= 1).
 * @returns `count` hex color strings, darkest (the base) first.
 */
export function shadeRamp(base: string, count: number): string[] {
  const n = Math.max(1, count);
  const rgb = parseHex(base);
  if (!rgb) return Array.from({ length: n }, () => base);
  const [r, g, b] = rgb;
  return Array.from({ length: n }, (_, i) => {
    // Lighten progressively up to 60% toward white; a lone shade stays the base.
    const factor = n <= 1 ? 0 : (i / (n - 1)) * 0.6;
    const mix = (c: number) => c + (255 - c) * factor;
    return `#${toHex(mix(r))}${toHex(mix(g))}${toHex(mix(b))}`;
  });
}

/**
 * Colors for a categorical chart's `count` marks: a monochromatic ramp of the
 * chosen `color`, or the multi-color palette when no valid color is given.
 */
export function categoryColors(color: string | null | undefined, count: number): string[] {
  if (isHexColor(color)) return shadeRamp(color, count);
  return Array.from({ length: count }, (_, i) => paletteColor(i));
}
