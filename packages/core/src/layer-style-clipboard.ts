// Copy/paste layer symbology between layers (issue #1339), QGIS-style. The
// transient clipboard slot and its two store actions live in `store.ts`; this
// module holds the UI-free data layer so both the desktop app and tests consume
// the same extract/apply logic.

import { DEFAULT_LAYER_STYLE, type GeoLibreLayer, type LayerStyle } from "./types";
import { isStyleLibraryTargetLayer } from "./style-library";

/**
 * `metadata.sourceKind` marking a deck.gl COG raster managed by the
 * maplibre-gl-raster control. Mirrors `RASTER_SOURCE_KIND` in
 * `@geolibre/plugins` (which `@geolibre/core` must not depend on). The clipboard
 * test imports the real constant from `@geolibre/plugins` and asserts a layer
 * tagged with it classifies as `"raster"`, so a rename of the upstream constant
 * makes the test fail here rather than silently dropping raster copy/paste.
 */
const RASTER_SOURCE_KIND = "maplibre-gl-raster";

/**
 * Which copy/paste style family a layer belongs to. Vector-styled layers and
 * deck.gl rasters store their symbology in different places (the {@link
 * LayerStyle} bag vs `metadata.rasterState`), so a paste only applies between
 * layers of the same family.
 */
export type LayerStyleClipboardKind = "vector" | "raster";

/**
 * The `metadata.rasterState` keys a raster style paste carries over: the
 * appearance of the render (colormap, stretch range, gamma, nodata), but not
 * the data selection (`mode`/`bands`/`index`), which stays with the target so
 * pasting a style never points a raster at a band it does not have.
 */
export const RASTER_APPEARANCE_STATE_KEYS = [
  "colormap",
  "reversed",
  "rescale",
  "nodata",
  "stretch",
  "gamma",
] as const;

/** Fields every clipboard entry carries, regardless of style family. */
interface CopiedLayerStyleBase {
  /** Source layer name, surfaced in the paste tooltip and status message. */
  sourceName: string;
  /** Source layer opacity in [0, 1]. */
  opacity: number;
}

/** A copied vector layer style: the whole {@link LayerStyle} bag. */
export interface CopiedVectorStyle extends CopiedLayerStyleBase {
  kind: "vector";
  /** Deep-cloned full vector layer style. */
  style: LayerStyle;
}

/**
 * A copied deck.gl raster style: the `metadata.rasterState` appearance and the
 * classification symbology. There is no `style` field — the vector
 * {@link LayerStyle} bag holds nothing a deck.gl raster renders from.
 */
export interface CopiedRasterStyle extends CopiedLayerStyleBase {
  kind: "raster";
  /** Raster visualization state (`metadata.rasterState`). */
  rasterState?: Record<string, unknown>;
  /** Whether the source carried a `metadata.rasterSymbology`. */
  hasRasterSymbology: boolean;
  /** Raster classification symbology (`metadata.rasterSymbology`). */
  rasterSymbology?: unknown;
}

/**
 * A layer's symbology captured for the paste clipboard. A discriminated union
 * on {@link LayerStyleClipboardKind} so raster-only fields cannot be read off a
 * vector entry (or vice versa); a paste only applies between layers of the same
 * family.
 */
export type CopiedLayerStyle = CopiedVectorStyle | CopiedRasterStyle;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The copy/paste style family of a layer, or `null` when the layer has no
 * copyable symbology. Deck.gl rasters are `"raster"`; the vector-styled layers
 * the Style Manager targets are `"vector"`.
 *
 * @param layer - The layer to classify.
 * @returns The style family, or `null`.
 */
export function copyableLayerStyleKind(layer: GeoLibreLayer): LayerStyleClipboardKind | null {
  if (layer.metadata?.sourceKind === RASTER_SOURCE_KIND) return "raster";
  if (isStyleLibraryTargetLayer(layer.type)) return "vector";
  return null;
}

/**
 * Snapshot a layer's style for the clipboard, deep-cloned so later edits to the
 * live layer cannot mutate the copied entry.
 *
 * @param layer - The source layer to copy from.
 * @returns The clipboard entry, or `null` when the layer has no copyable
 *   symbology.
 */
export function extractCopiedLayerStyle(layer: GeoLibreLayer): CopiedLayerStyle | null {
  const kind = copyableLayerStyleKind(layer);
  if (!kind) return null;
  if (kind === "vector") {
    return {
      kind,
      sourceName: layer.name,
      opacity: layer.opacity,
      style: structuredClone({ ...DEFAULT_LAYER_STYLE, ...layer.style }),
    };
  }
  // A raster entry never carries the vector `style` bag, so the full-style
  // clone is skipped here.
  const rasterState = layer.metadata?.rasterState;
  const rasterSymbology = layer.metadata?.rasterSymbology;
  return {
    kind,
    sourceName: layer.name,
    opacity: layer.opacity,
    rasterState: isPlainObject(rasterState) ? structuredClone(rasterState) : undefined,
    hasRasterSymbology: rasterSymbology !== undefined,
    ...(rasterSymbology !== undefined ? { rasterSymbology: structuredClone(rasterSymbology) } : {}),
  };
}

/**
 * Build the {@link GeoLibreLayer} patch that pastes a copied style onto a
 * target layer, or `null` when the target's style family does not match the
 * clipboard entry's (so the caller can disable the paste action).
 *
 * @param target - The layer to paste onto.
 * @param copied - The clipboard entry.
 * @returns A partial layer patch to merge, or `null` when incompatible.
 */
export function applyCopiedLayerStyle(
  target: GeoLibreLayer,
  copied: CopiedLayerStyle,
): Partial<GeoLibreLayer> | null {
  if (copyableLayerStyleKind(target) !== copied.kind) return null;
  if (copied.kind === "vector") {
    // The whole style is applied verbatim, including attribute-bound fields
    // (`vectorStyleProperty` and its stops/rules, `labels.field`,
    // `extrusionHeightProperty`, `proportionalSizeProperty`, `diagramFields`).
    // This is deliberate QGIS "Paste Style" behavior and matches the Style
    // Manager's full-"style" preset: a target lacking those attributes just
    // renders that facet inert (no classification / labels), which the user
    // re-points, rather than the paste silently dropping parts of the style.
    return { style: structuredClone(copied.style), opacity: copied.opacity };
  }
  // Merge the appearance keys onto the target's existing rasterState, keeping
  // its own `mode`/`bands`/`index` so the paste restyles the layer without
  // repointing it at the source's band selection.
  const targetState = isPlainObject(target.metadata?.rasterState)
    ? target.metadata.rasterState
    : {};
  const source = copied.rasterState ?? {};
  const targetBandCount = Array.isArray(targetState.bands) ? targetState.bands.length : 1;
  const mergedState: Record<string, unknown> = { ...targetState };
  for (const key of RASTER_APPEARANCE_STATE_KEYS) {
    if (!(key in source)) continue;
    // `rescale` is a per-band min/max array sized to the source's band count.
    // Copying it onto a target with a different band count (e.g. an RGB source
    // onto a single-band target) would leave a rescale whose length disagrees
    // with the preserved `bands` — the same "band it does not have" hazard the
    // mode/bands preservation above avoids, one level down. Skip it then and
    // let the target keep its own stretch. A null source rescale (auto) is safe
    // to carry over regardless.
    if (
      key === "rescale" &&
      Array.isArray(source.rescale) &&
      source.rescale.length !== targetBandCount
    ) {
      continue;
    }
    mergedState[key] = structuredClone(source[key]);
  }
  const metadata: Record<string, unknown> = { ...target.metadata, rasterState: mergedState };
  if (copied.hasRasterSymbology) {
    metadata.rasterSymbology = structuredClone(copied.rasterSymbology);
  } else {
    delete metadata.rasterSymbology;
  }
  return { metadata, opacity: copied.opacity };
}
