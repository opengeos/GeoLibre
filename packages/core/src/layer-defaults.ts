import type { FeatureCollection } from "geojson";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer, type LayerStyle } from "./types";

/**
 * Initial styling for a newly added vector layer (issue #1519).
 *
 * {@link DEFAULT_LAYER_STYLE} stays exactly what it is — the schema fallback
 * that fills gaps when a partial style is read back from a project file. It is
 * deliberately NOT changed here: every load path spreads it under a saved
 * style, so editing it would silently restyle existing projects.
 *
 * What this module adds is a separate decision made only at *add* time: give
 * each new layer its own color, and pick sizes that suit the geometry it
 * actually contains, so a stack of freshly loaded layers is legible without
 * anyone opening the Style panel.
 */

/**
 * Qualitative colors cycled across newly added layers, chosen to stay distinct
 * at low opacity over both light and dark basemaps.
 *
 * Distinct from the classification palette the Style panel uses for the classes
 * *within* one layer: this one separates layers from each other, and the two
 * are free to diverge.
 */
export const LAYER_PALETTE = [
  "#3b82f6", // blue — matches the historical default, so the first layer looks unchanged
  "#ef4444", // red
  "#22c55e", // green
  "#a855f7", // purple
  "#f97316", // orange
  "#06b6d4", // cyan
  "#ec4899", // pink
  "#84cc16", // lime
] as const;

/** How much darker an outline is than its fill (0 = black, 1 = unchanged). */
const STROKE_DARKEN = 0.55;

/** Darken a `#rrggbb` color toward black by `factor`. */
export function darkenHex(hex: string, factor: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return hex;
  const value = Number.parseInt(match[1], 16);
  const channels = [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
  return `#${channels
    .map((channel) =>
      Math.max(0, Math.min(255, Math.round(channel * factor)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** Case-insensitive palette lookup, returning the canonical (lowercase) entry. */
function paletteEntryOf(color: string | undefined): string | undefined {
  const normalized = (color ?? "").trim().toLowerCase();
  return LAYER_PALETTE.find((entry) => entry === normalized);
}

/**
 * True when a style's colors are a palette assignment {@link initialLayerStyle}
 * made: a palette fill *paired with* the outline derived from it.
 *
 * The pairing is what makes this precise. Testing the fill alone — or the layer
 * type — would miscount every layer built straight from
 * {@link DEFAULT_LAYER_STYLE}, whose `fillColor` happens to be
 * `LAYER_PALETTE[0]`: rasters, tilesets, video overlays, and the non-spatial
 * attribute tables the delimited-text source adds. None of those paint from a
 * collection, so none should reserve blue and push the next added layer to red.
 * They carry the schema's own `strokeColor`, not one derived from the fill, so
 * this test leaves them out.
 */
function wearsPaletteColor(style: LayerStyle | undefined): boolean {
  const entry = paletteEntryOf(style?.fillColor);
  if (!entry) return false;
  return (style?.strokeColor ?? "").trim().toLowerCase() === darkenHex(entry, STROKE_DARKEN);
}

/**
 * Pick the next layer color: the first palette entry no current layer is
 * already using, so deleting a layer frees its color back up rather than
 * leaving the cycle permanently offset. Falls back to cycling by layer count
 * once every entry is in use.
 *
 * @param layers - The project's current layers. Only those actually wearing a
 *   palette assignment count; see {@link wearsPaletteColor}.
 * @returns A `#rrggbb` color from {@link LAYER_PALETTE}.
 */
export function nextLayerPaletteColor(layers: readonly GeoLibreLayer[]): string {
  const styled = layers.filter((layer) => wearsPaletteColor(layer.style));
  const used = new Set(styled.map((layer) => layer.style.fillColor.trim().toLowerCase()));
  const free = LAYER_PALETTE.find((color) => !used.has(color));
  return free ?? LAYER_PALETTE[styled.length % LAYER_PALETTE.length];
}

/** The geometry family a layer is mostly made of. */
export type DominantGeometry = "point" | "line" | "polygon" | "mixed";

/** Features sampled when deciding a collection's dominant geometry. */
const GEOMETRY_SAMPLE_SIZE = 500;

/**
 * Classify a collection by the geometry family most of its features carry,
 * reading at most {@link GEOMETRY_SAMPLE_SIZE} features so a very large layer
 * does not pay a full scan for a styling default.
 *
 * @param geojson - The collection to inspect.
 * @returns The dominant family, or `"mixed"` when nothing has a clear majority
 *   (or the collection is empty).
 */
export function dominantGeometry(geojson: FeatureCollection | undefined): DominantGeometry {
  const features = geojson?.features ?? [];
  if (!features.length) return "mixed";

  const counts = { point: 0, line: 0, polygon: 0 };
  const sampled = Math.min(features.length, GEOMETRY_SAMPLE_SIZE);
  for (let index = 0; index < sampled; index++) {
    switch (features[index]?.geometry?.type) {
      case "Point":
      case "MultiPoint":
        counts.point += 1;
        break;
      case "LineString":
      case "MultiLineString":
        counts.line += 1;
        break;
      case "Polygon":
      case "MultiPolygon":
        counts.polygon += 1;
        break;
      default:
        break;
    }
  }

  if (!counts.point && !counts.line && !counts.polygon) return "mixed";
  const [family, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] as [
    "point" | "line" | "polygon",
    number,
  ];
  // A clear majority of everything sampled, not just of the geometries this
  // switch understands: two points among three GeometryCollections is not a
  // point layer, so `sampled` is the denominator rather than the matched total.
  // And a majority, not merely the largest slice — a 40/35/25 split has no
  // geometry whose sizing suits the layer.
  return count / sampled > 0.5 ? family : "mixed";
}

/**
 * Per-geometry size and opacity overrides.
 *
 * One set of numbers cannot suit all three families: an opacity that lets a
 * basemap read through a polygon makes a point look washed out, and a stroke
 * heavy enough to see a line is a heavy outline on a polygon.
 */
const GEOMETRY_DEFAULTS: Record<DominantGeometry, Partial<LayerStyle>> = {
  // Solid and slightly smaller: a point is read as a dot, not a translucent blob.
  point: { circleRadius: 5, fillOpacity: 0.9, strokeWidth: 1 },
  // A line's stroke *is* the symbol, so it carries the weight.
  line: { strokeWidth: 2.5, fillOpacity: 1 },
  // Translucent enough that the basemap underneath stays readable.
  polygon: { fillOpacity: 0.45, strokeWidth: 1.5 },
  mixed: {},
};

export interface InitialLayerStyleOptions {
  /** The layer's data, used to pick geometry-appropriate sizes. */
  geojson?: FeatureCollection;
  /** Current project layers, so the new layer gets an unused palette color. */
  layers?: readonly GeoLibreLayer[];
  /** Style values that win over the computed defaults (e.g. a restored style). */
  overrides?: Partial<LayerStyle>;
}

/**
 * Build the style a newly added vector layer starts with: the schema defaults,
 * plus its own palette color and geometry-appropriate sizing.
 *
 * @param options - Data and project context to derive the style from.
 * @returns A complete {@link LayerStyle}.
 */
export function initialLayerStyle(options: InitialLayerStyleOptions = {}): LayerStyle {
  const { geojson, layers = [], overrides } = options;
  const fillColor = nextLayerPaletteColor(layers);
  return {
    ...DEFAULT_LAYER_STYLE,
    fillColor,
    strokeColor: darkenHex(fillColor, STROKE_DARKEN),
    ...GEOMETRY_DEFAULTS[dominantGeometry(geojson)],
    ...overrides,
  };
}

/**
 * True when a layer still wears exactly what {@link initialLayerStyle} gave it.
 *
 * The renderer mode alone is too weak a test for "untouched": nudging the fill,
 * outline, or opacity leaves the mode on `"single"`, and a project restored
 * from disk can carry deliberate single-symbol styling. Both cases should stop
 * the Style panel volunteering suggestions, which is what this gates.
 *
 * The fill color cannot be compared against a fixed value — it is whichever
 * palette entry the layer drew — so the test is that it is *still a palette
 * entry* with the outline derived from it, which a hand-picked color will not
 * satisfy.
 *
 * @param style - The layer's current style.
 * @param geojson - Its data, so the geometry-derived sizes can be recomputed.
 * @returns `true` when nothing about the as-added look has been changed.
 */
export function isInitialLayerStyle(style: LayerStyle, geojson?: FeatureCollection): boolean {
  // Authored symbology, whatever the paint fields say.
  if (style.simpleStyleEnabled) return false;
  if (style.vectorStyleMode !== "single") return false;
  if (style.pointRenderer !== "single") return false;
  if ((style.vectorRules?.length ?? 0) > 0) return false;

  if (!wearsPaletteColor(style)) return false;

  const expected = { ...DEFAULT_LAYER_STYLE, ...GEOMETRY_DEFAULTS[dominantGeometry(geojson)] };
  return (
    style.fillOpacity === expected.fillOpacity &&
    style.strokeWidth === expected.strokeWidth &&
    style.circleRadius === expected.circleRadius
  );
}
