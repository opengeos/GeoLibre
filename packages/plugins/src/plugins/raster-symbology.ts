import {
  type GeoLibreLayer,
  createEqualIntervalBreaks,
  getVectorColorRamp,
  interpolateColors,
  normalizeHexColor,
  parseHexColor,
} from "@geolibre/core";

/**
 * The classification methods offered for single-band pseudocolor rasters.
 * Mirrors the vector graduated schemes minus natural-breaks (which needs raw
 * per-pixel samples a raster histogram does not provide).
 */
export type RasterClassificationMethod = "equal-interval" | "quantile" | "manual";

/**
 * GeoLibre-owned raster symbology, stored at `metadata.rasterSymbology`. The
 * upstream `maplibre-gl-raster` control owns the continuous render state
 * (`metadata.rasterState`: mode/bands/colormap/reversed/rescale/…); this record
 * adds what the control cannot express: discrete classification and custom
 * color ramps. When `classified` is true the stepped colormap drives color and
 * `rasterState.colormap` is ignored; otherwise the record is needed only for a
 * custom ramp. Reverse lives on `rasterState.reversed` (the control renders it
 * for built-in colormaps; the injected texture reads it for classified/custom).
 */
export type RasterSymbology = {
  /** Whether the single band is rendered as discrete classes. */
  classified: boolean;
  /** Color ramp name (a `VECTOR_COLOR_RAMPS` value / deck.gl-raster colormap). */
  ramp: string;
  /**
   * User-defined anchor colors (`#rrggbb`) overriding the named ramp when set
   * (length >= 2). The upstream control only renders its built-in colormaps,
   * so a custom ramp is always injected as a texture: a stepped lookup when
   * classified, a smooth gradient when continuous.
   */
  customColors?: string[];
  /** How the class edges are derived. */
  method: RasterClassificationMethod;
  /** Number of classes: UI authoring clamps to [2, 12]; a stored categorical
   * symbology (from the Raster Attribute Table) may carry up to
   * {@link RASTER_MAX_STORED_CLASSES}. */
  classCount: number;
  /** Class edges, ascending, length `classCount + 1` (min..max inclusive). */
  breaks: number[];
};

/** Minimum and maximum class count for raster classification. */
export const RASTER_MIN_CLASSES = 2;
export const RASTER_MAX_CLASSES = 12;

/**
 * Upper bound on classes a *stored* symbology may carry. The classification UI
 * caps authoring at {@link RASTER_MAX_CLASSES}, but a categorical symbology
 * applied from the Raster Attribute Table carries one class per pixel value
 * (a landcover raster easily exceeds 12). 256 matches the width of the
 * colormap lookup texture, past which classes cannot be told apart anyway.
 */
export const RASTER_MAX_STORED_CLASSES = 256;

/** Number of columns in a colormap lookup texture (matches deck.gl-raster). */
export const COLORMAP_TEXTURE_WIDTH = 256;

/** Minimum colors that make a usable custom ramp (fewer can't interpolate). */
export const RASTER_MIN_CUSTOM_COLORS = 2;

/** A single band's statistics, as produced by `computeAutoStats`. */
export type RasterBandStats = {
  min: number;
  max: number;
  /** Bin counts evenly distributed over [min, max]. */
  histogram: number[];
};

/**
 * Clamps a requested class count into the supported range.
 *
 * @param value - The requested class count.
 * @returns An integer in [RASTER_MIN_CLASSES, RASTER_MAX_CLASSES].
 */
export function clampRasterClassCount(value: number): number {
  if (!Number.isFinite(value)) return RASTER_MIN_CLASSES;
  return Math.min(RASTER_MAX_CLASSES, Math.max(RASTER_MIN_CLASSES, Math.round(value)));
}

/**
 * Linear-interpolated percentile from a histogram. Mirrors
 * `maplibre-gl-raster`'s `percentileFromHistogram` but kept dependency-free so
 * break computation stays a pure, unit-testable function.
 *
 * @param stats - The band statistics (min, max, histogram bins).
 * @param p - The percentile in [0, 1].
 * @returns The value at percentile `p`.
 */
export function percentileFromHistogram(stats: RasterBandStats, p: number): number {
  const { min, max, histogram } = stats;
  const bins = histogram.length;
  if (bins === 0 || max <= min) return min;
  const total = histogram.reduce((sum, count) => sum + count, 0);
  if (total === 0) return min + (max - min) * p;

  const target = p * total;
  let cumulative = 0;
  const binWidth = (max - min) / bins;
  for (let index = 0; index < bins; index += 1) {
    const next = cumulative + histogram[index];
    if (next >= target) {
      // Linear interpolation within the bin that crosses the target count.
      const within = histogram[index] === 0 ? 0 : (target - cumulative) / histogram[index];
      return min + (index + within) * binWidth;
    }
    cumulative = next;
  }
  return max;
}

/**
 * Computes ascending class edges (length `classCount + 1`) for a band.
 *
 * @param method - The classification method.
 * @param stats - The band statistics (used for equal-interval / quantile).
 * @param classCount - The number of classes.
 * @param manualBreaks - User-entered edges, used when `method` is "manual".
 * @returns The class edges, ascending, length `classCount + 1`.
 */
export function computeRasterBreaks(
  method: RasterClassificationMethod,
  stats: RasterBandStats | null,
  classCount: number,
  manualBreaks?: number[],
): number[] {
  const count = clampRasterClassCount(classCount);
  const edgeCount = count + 1;

  if (method === "manual") {
    const edges = (manualBreaks ?? []).map((value) => Number(value)).filter(Number.isFinite);
    if (edges.length === edgeCount) return [...edges].sort((a, b) => a - b);
    // Fall back to an even spread across whatever range we can infer so the
    // editor always starts from a sensible, correctly sized set of edges.
    // Order the inferred bounds so unsorted manual input cannot produce
    // descending edges (which would violate the ascending-edge contract).
    const sortedEdges = [...edges].sort((a, b) => a - b);
    const inferredMin = stats?.min ?? sortedEdges[0] ?? 0;
    const inferredMax = stats?.max ?? sortedEdges.at(-1) ?? 1;
    return createEqualIntervalBreaks(
      Math.min(inferredMin, inferredMax),
      Math.max(inferredMin, inferredMax),
      edgeCount,
    );
  }

  const min = stats?.min ?? 0;
  const max = stats?.max ?? 1;
  if (method === "quantile" && stats && stats.histogram.length > 0) {
    return Array.from({ length: edgeCount }, (_, index) =>
      percentileFromHistogram(stats, index / count),
    );
  }
  return createEqualIntervalBreaks(min, max, edgeCount);
}

/**
 * Resolves the anchor colors a symbology samples: the custom colors when at
 * least two were supplied, otherwise the named ramp's colors.
 *
 * @param ramp - The named color ramp value.
 * @param customColors - Optional user-defined anchor colors.
 * @returns The anchor colors to interpolate.
 */
export function rampBaseColors(ramp: string, customColors?: readonly string[]): readonly string[] {
  return customColors && customColors.length >= RASTER_MIN_CUSTOM_COLORS
    ? customColors
    : getVectorColorRamp(ramp).colors;
}

/**
 * Builds a 256-wide RGBA lookup row for a classified single-band raster. Each
 * column is colored by the class its normalized position (within
 * `[breaks[0], breaks[last]]`) falls into, so the deck.gl-raster `Colormap`
 * module samples discrete classes after the layer's `LinearRescale` maps the
 * data window to [0, 1]. Returned as a flat `Uint8ClampedArray` (length 1024)
 * rather than an `ImageData` so it is constructible and testable without a DOM.
 *
 * @param breaks - Class edges, ascending, length `classCount + 1`.
 * @param ramp - The color ramp name.
 * @param reversed - Whether to reverse the class colors.
 * @param customColors - Optional user-defined anchor colors overriding `ramp`.
 * @returns A 256x1 RGBA buffer (length COLORMAP_TEXTURE_WIDTH * 4).
 */
export function buildSteppedColormapRgba(
  breaks: number[],
  ramp: string,
  reversed = false,
  customColors?: readonly string[],
): Uint8ClampedArray {
  const width = COLORMAP_TEXTURE_WIDTH;
  const rgba = new Uint8ClampedArray(width * 4);
  const classCount = Math.max(1, breaks.length - 1);
  const colors = interpolateColors(rampBaseColors(ramp, customColors), classCount);
  const orderedColors = reversed ? [...colors].reverse() : colors;

  const min = breaks[0];
  const max = breaks[breaks.length - 1];
  const span = max - min;
  // Normalized interior edges in [0, 1]; degenerate (min === max) → single class.
  const normalizedEdges = span > 0 ? breaks.map((edge) => (edge - min) / span) : null;

  for (let column = 0; column < width; column += 1) {
    const t = column / (width - 1);
    // Defaults to the last class (covers t === 1 and the degenerate range).
    let classIndex = classCount - 1;
    if (normalizedEdges) {
      for (let edge = 1; edge < normalizedEdges.length; edge += 1) {
        if (t < normalizedEdges[edge]) {
          classIndex = edge - 1;
          break;
        }
      }
    }
    const color = parseHexColor(orderedColors[classIndex] ?? orderedColors.at(-1) ?? "#000000");
    const offset = column * 4;
    rgba[offset] = color.r;
    rgba[offset + 1] = color.g;
    rgba[offset + 2] = color.b;
    rgba[offset + 3] = 255;
  }
  return rgba;
}

/**
 * Builds a 256-wide RGBA lookup row that interpolates custom anchor colors
 * smoothly across the rescaled [0, 1] data window, for a continuous
 * (unclassified) single-band raster whose ramp is user-defined. The upstream
 * control renders only its named colormaps, so a custom continuous ramp is
 * injected as this texture. Returned as a flat `Uint8ClampedArray` so it is
 * constructible and testable without a DOM.
 *
 * @param colors - The custom anchor colors (at least one).
 * @param reversed - Whether to sample the colors back-to-front.
 * @returns A 256x1 RGBA buffer (length COLORMAP_TEXTURE_WIDTH * 4).
 */
export function buildContinuousColormapRgba(
  colors: readonly string[],
  reversed = false,
): Uint8ClampedArray {
  const width = COLORMAP_TEXTURE_WIDTH;
  const rgba = new Uint8ClampedArray(width * 4);
  const ordered = reversed ? [...colors].reverse() : colors;
  const sampled = interpolateColors(ordered, width);
  for (let column = 0; column < width; column += 1) {
    const color = parseHexColor(sampled[column] ?? "#000000");
    const offset = column * 4;
    rgba[offset] = color.r;
    rgba[offset + 1] = color.g;
    rgba[offset + 2] = color.b;
    rgba[offset + 3] = 255;
  }
  return rgba;
}

/**
 * Reads and validates the persisted raster symbology from a store layer's
 * metadata, keeping only well-formed fields so a hand-edited project file
 * cannot crash the renderer. Mirrors the defensive style of
 * `savedRasterState`.
 *
 * @param layer - A store layer created by `createRasterStoreLayer`.
 * @returns The validated symbology, or null when absent / malformed.
 */
export function savedRasterSymbology(layer: GeoLibreLayer): RasterSymbology | null {
  const raw = layer.metadata.rasterSymbology;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;

  if (typeof candidate.classified !== "boolean") return null;
  if (typeof candidate.ramp !== "string" || candidate.ramp.length === 0) {
    return null;
  }
  if (
    candidate.method !== "equal-interval" &&
    candidate.method !== "quantile" &&
    candidate.method !== "manual"
  ) {
    return null;
  }
  if (typeof candidate.classCount !== "number") return null;

  // The breaks are the authoritative class edges (the renderer sizes the
  // stepped texture off breaks.length), so the class count is derived from
  // them rather than trusted from the stored field. This keeps records
  // consistent by construction: a categorical symbology from the Raster
  // Attribute Table may carry one class per pixel value (well past the UI's
  // RASTER_MAX_CLASSES authoring cap, up to RASTER_MAX_STORED_CLASSES), and a
  // legacy record whose stored count disagrees with its edges (older versions
  // clamped the count but not the breaks) renders from its edges instead of
  // being dropped.
  if (
    !Array.isArray(candidate.breaks) ||
    candidate.breaks.length < RASTER_MIN_CLASSES + 1 ||
    candidate.breaks.length > RASTER_MAX_STORED_CLASSES + 1 ||
    !candidate.breaks.every((value) => typeof value === "number" && Number.isFinite(value))
  ) {
    return null;
  }
  const breaks = candidate.breaks as number[];
  for (let index = 1; index < breaks.length; index += 1) {
    if (breaks[index] < breaks[index - 1]) return null;
  }
  const classCount = breaks.length - 1;

  // A custom ramp needs at least two valid colors; drop malformed entries so a
  // hand-edited project silently falls back to the named ramp rather than
  // rendering a broken texture.
  let customColors: string[] | undefined;
  if (Array.isArray(candidate.customColors)) {
    const normalized = candidate.customColors
      .filter((color): color is string => typeof color === "string")
      .map(normalizeHexColor)
      .filter((color): color is string => color !== null);
    if (normalized.length >= RASTER_MIN_CUSTOM_COLORS) customColors = normalized;
  }

  return {
    classified: candidate.classified,
    ramp: candidate.ramp,
    ...(customColors ? { customColors } : {}),
    method: candidate.method,
    classCount,
    breaks,
  };
}

/**
 * The default symbology applied when a user first opens the classification
 * controls for a band, given its data range.
 *
 * @param ramp - The initial color ramp.
 * @param stats - The band statistics, when known.
 * @returns A continuous (unclassified) symbology seeded with equal-interval edges.
 */
export function defaultRasterSymbology(
  ramp = "viridis",
  stats: RasterBandStats | null = null,
): RasterSymbology {
  const classCount = 5;
  return {
    classified: false,
    ramp,
    method: "equal-interval",
    classCount,
    breaks: computeRasterBreaks("equal-interval", stats, classCount),
  };
}
