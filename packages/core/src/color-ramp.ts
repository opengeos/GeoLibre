/**
 * Color-ramp definitions and classification-break helpers shared by the
 * vector graduated-styling panel and the raster symbology panel. Kept in
 * `@geolibre/core` (dependency-light, map-agnostic) so both UIs derive class
 * colors and breaks from the same source. The ramp `value`s intentionally
 * match the named colormaps shipped by `@developmentseed/deck.gl-raster`
 * (`COLORMAP_INDEX` keys) so a ramp choice maps 1:1 onto the raster render
 * path.
 */

export type ColorRamp = {
  value: string;
  label: string;
  colors: readonly string[];
};

/** The built-in color ramps offered by the style panels. */
export const VECTOR_COLOR_RAMPS: readonly ColorRamp[] = [
  {
    value: "viridis",
    label: "Viridis",
    colors: ["#440154", "#31688e", "#35b779", "#fde725"],
  },
  {
    value: "plasma",
    label: "Plasma",
    colors: ["#0d0887", "#9c179e", "#ed7953", "#f0f921"],
  },
  {
    value: "inferno",
    label: "Inferno",
    colors: ["#000004", "#781c6d", "#ed6925", "#fcffa4"],
  },
  {
    value: "magma",
    label: "Magma",
    colors: ["#000004", "#721f81", "#f1605d", "#fcfdbf"],
  },
  {
    value: "cividis",
    label: "Cividis",
    colors: ["#00204d", "#575d6d", "#a59c74", "#ffea46"],
  },
  {
    value: "turbo",
    label: "Turbo",
    colors: ["#30123b", "#4777ef", "#1ccfd0", "#b9e642", "#fb8022", "#7a0403"],
  },
  {
    value: "spectral",
    label: "Spectral",
    colors: ["#9e0142", "#f46d43", "#ffffbf", "#66c2a5", "#5e4fa2"],
  },
  {
    value: "blues",
    label: "Blues",
    colors: ["#eff6ff", "#93c5fd", "#2563eb", "#1e3a8a"],
  },
  {
    value: "greens",
    label: "Greens",
    colors: ["#f0fdf4", "#86efac", "#16a34a", "#14532d"],
  },
  {
    value: "oranges",
    label: "Oranges",
    colors: ["#fff7ed", "#fdba74", "#f97316", "#7c2d12"],
  },
  {
    value: "reds",
    label: "Reds",
    colors: ["#fff5f0", "#fcae91", "#fb6a4a", "#cb181d", "#67000d"],
  },
  {
    value: "purples",
    label: "Purples",
    colors: ["#fcfbfd", "#bcbddc", "#807dba", "#54278f", "#3f007d"],
  },
  {
    value: "terrain",
    label: "Terrain",
    colors: ["#333399", "#21bcb3", "#79d05a", "#e8e85a", "#a87b54", "#ffffff"],
  },
  {
    value: "rdylgn",
    label: "Red-Yellow-Green",
    colors: ["#a50026", "#f46d43", "#ffffbf", "#66bd63", "#006837"],
  },
  {
    value: "rdylbu",
    label: "Red-Yellow-Blue",
    colors: ["#a50026", "#f46d43", "#ffffbf", "#74add1", "#313695"],
  },
  {
    value: "rdbu",
    label: "Red-Blue",
    colors: ["#b2182b", "#ef8a62", "#f7f7f7", "#67a9cf", "#2166ac"],
  },
  {
    value: "coolwarm",
    label: "Cool-Warm",
    colors: ["#3b4cc0", "#7b9ff9", "#dddcdc", "#f49a7b", "#b40426"],
  },
  {
    value: "jet",
    label: "Jet",
    colors: ["#000080", "#0000ff", "#00ffff", "#ffff00", "#ff0000", "#800000"],
  },
  {
    value: "greys",
    label: "Greys",
    colors: ["#ffffff", "#bdbdbd", "#636363", "#000000"],
  },
  {
    value: "gray",
    label: "Grayscale",
    colors: ["#000000", "#ffffff"],
  },
] as const;

/**
 * Resolves a ramp definition by name, falling back to the first ramp when the
 * name is unknown.
 *
 * @param value - The ramp `value` (e.g. "viridis").
 * @returns The matching ramp, or the first ramp.
 */
export function getVectorColorRamp(value: string): ColorRamp {
  return VECTOR_COLOR_RAMPS.find((colorRamp) => colorRamp.value === value) ?? VECTOR_COLOR_RAMPS[0];
}

/**
 * Samples a ramp into `count` evenly spaced hex colors by linearly
 * interpolating between the ramp's anchor colors.
 *
 * @param colorRamp - The ramp `value`.
 * @param count - Number of colors to produce.
 * @returns An array of `count` hex colors (a single end color when count <= 1).
 */
export function interpolateRampColors(colorRamp: string, count: number): string[] {
  return interpolateColors(getVectorColorRamp(colorRamp).colors, count);
}

/**
 * Samples an explicit list of anchor colors into `count` evenly spaced hex
 * colors by linear interpolation. Backs both the named ramps and user-defined
 * custom ramps, so a list of hex codes is sampled identically to a built-in.
 *
 * @param colors - The anchor colors (at least one).
 * @param count - Number of colors to produce.
 * @returns An array of `count` hex colors (a single end color when count <= 1).
 */
export function interpolateColors(colors: readonly string[], count: number): string[] {
  const anchors = colors.length > 0 ? colors : ["#000000"];
  if (count <= 0) return [];
  if (count === 1) return [anchors[anchors.length - 1]];
  if (anchors.length === 1) {
    return Array.from({ length: count }, () => anchors[0]);
  }
  return Array.from({ length: count }, (_, index) => {
    const scaled = (index / (count - 1)) * (anchors.length - 1);
    const lowerIndex = Math.floor(scaled);
    const upperIndex = Math.min(anchors.length - 1, Math.ceil(scaled));
    const ratio = scaled - lowerIndex;
    return interpolateHexColor(anchors[lowerIndex], anchors[upperIndex], ratio);
  });
}

/**
 * Normalizes a single user-entered color token into a canonical `#rrggbb`
 * lowercase hex string, or null when it is not a valid 3- or 6-digit hex
 * color. Accepts values with or without a leading `#` and expands shorthand
 * (`#abc` → `#aabbcc`).
 *
 * @param token - A raw color token (e.g. "FF0000", "#f00", " #AaBbCc ").
 * @returns The canonical `#rrggbb` color, or null when invalid.
 */
export function normalizeHexColor(token: string): string | null {
  let value = token.trim().toLowerCase();
  if (value === "") return null;
  if (!value.startsWith("#")) value = `#${value}`;
  if (/^#[0-9a-f]{3}$/.test(value)) {
    value = `#${value
      .slice(1)
      .split("")
      .map((channel) => channel + channel)
      .join("")}`;
  }
  return /^#[0-9a-f]{6}$/.test(value) ? value : null;
}

/**
 * Parses a free-text list of hex color codes into canonical `#rrggbb` colors,
 * for the custom color-ramp inputs. Tokens may be separated by commas,
 * semicolons, or any whitespace (including newlines); invalid tokens are
 * dropped so a partial paste still yields the colors it can.
 *
 * @param input - The raw text the user entered.
 * @returns The valid, normalized colors in input order.
 */
export function parseHexColorList(input: string): string[] {
  return input
    .split(/[\s,;]+/)
    .map(normalizeHexColor)
    .filter((color): color is string => color !== null);
}

/**
 * Linearly interpolates between two hex colors.
 *
 * @param from - Start hex color (e.g. "#440154").
 * @param to - End hex color.
 * @param ratio - Blend factor in [0, 1].
 * @returns The interpolated hex color.
 */
export function interpolateHexColor(from: string, to: string, ratio: number): string {
  const start = parseHexColor(from);
  const end = parseHexColor(to);
  return rgbToHex({
    r: Math.round(start.r + (end.r - start.r) * ratio),
    g: Math.round(start.g + (end.g - start.g) * ratio),
    b: Math.round(start.b + (end.b - start.b) * ratio),
  });
}

/**
 * Parses a `#rrggbb` hex color into its RGB channels.
 *
 * @param value - A `#rrggbb` hex color.
 * @returns The red, green, and blue channels (0-255).
 */
export function parseHexColor(value: string): { b: number; g: number; r: number } {
  // Caller must pass a well-formed "#rrggbb" string; malformed input parses to
  // NaN and the bitwise ops below coerce it to black ({ r: 0, g: 0, b: 0 }).
  const numeric = Number.parseInt(value.slice(1), 16);
  return {
    r: (numeric >> 16) & 255,
    g: (numeric >> 8) & 255,
    b: numeric & 255,
  };
}

/**
 * Formats RGB channels as a `#rrggbb` hex color.
 *
 * @param color - The red, green, and blue channels (0-255).
 * @returns A `#rrggbb` hex color.
 */
export function rgbToHex(color: { b: number; g: number; r: number }): string {
  return `#${[color.r, color.g, color.b]
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}

/**
 * Builds `count` evenly spaced break values across [min, max].
 *
 * @param min - The minimum value.
 * @param max - The maximum value.
 * @param count - Number of breaks to produce.
 * @returns The break values (min..max inclusive when count > 1).
 */
export function createEqualIntervalBreaks(min: number, max: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => {
    const ratio = count === 1 ? 0 : index / (count - 1);
    return min + (max - min) * ratio;
  });
}

/**
 * Builds `count` quantile break values from a sample of numeric values.
 *
 * @param values - The sample values.
 * @param count - Number of breaks to produce.
 * @returns The quantile break values.
 */
export function createQuantileBreaks(values: number[], count: number): number[] {
  if (count <= 0) return [];
  const sorted = [...values].sort((a, b) => a - b);
  // An empty sample would read `undefined` through the index math below and
  // yield NaN breaks; callers that have no values get an empty result instead.
  if (sorted.length === 0) return [];
  return Array.from({ length: count }, (_, index) => {
    const position = count === 1 ? 0 : (index / (count - 1)) * (sorted.length - 1);
    const lowerIndex = Math.floor(position);
    const upperIndex = Math.min(sorted.length - 1, Math.ceil(position));
    const ratio = position - lowerIndex;
    return sorted[lowerIndex] + (sorted[upperIndex] - sorted[lowerIndex]) * ratio;
  });
}
