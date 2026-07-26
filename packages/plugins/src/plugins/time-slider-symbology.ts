import { getActiveTimeSliderControl } from "./maplibre-time-slider";
import { getTimeSliderPixelSources } from "./time-slider-pixel-series";

/**
 * Symbology editing for the Time Slider's raster sources.
 *
 * A dock source is not in the raster plugin's layer registry, so the Style
 * panel's usual Raster symbology section (band stats, classification, saved
 * symbology) has nothing to attach to. What a dock source *does* expose is the
 * four fields its spec carries — colormap, band selection, rescale window, and
 * nodata — which the control applies live through `setSourceProperty`. This
 * module is the read/write pair for exactly those fields, so the UI stays a
 * thin form over the spec.
 *
 * Both `cog` and `mosaic` sources are editable and take the same four fields;
 * which adapter renders them is the library's business, not the panel's.
 */

/** The editable symbology of one Time Slider raster source. */
export interface TimeSliderSymbology {
  /**
   * The source type, which decides the nodata vocabulary: a `cog` spec's
   * `nodata` is a TiTiler query parameter (a number or `'nan'`), a `mosaic`'s is
   * the client renderer's own (`number | 'off' | 'auto'`). Note the library
   * reports a COG rendered on the `gpu`/`wasm` engine as `mosaic`, which is
   * correct here: that source really is drawn by the client renderer.
   */
  type: "cog" | "mosaic";
  /** Renderer colormap name, or null when none is applied (RGB/multi-band). */
  colormap: string | null;
  /** 1-based band indexes to render. Empty means "let the renderer decide". */
  bands: number[];
  /** Min/max window applied to every rendered channel, or null to auto-stretch. */
  rescale: [number, number] | null;
  /**
   * NoData handling. A COG spec spells this as a number or `'nan'` (a TiTiler
   * query parameter); a mosaic as a number, `'off'`, or `'auto'`. Kept as the
   * raw spec value so neither vocabulary is mangled on the way through.
   */
  nodata: number | string | null;
}

/** A patch of the fields a user can change. Every key is optional; a key set to
 * its empty value (null / empty array) clears that field. */
export type TimeSliderSymbologyPatch = Partial<TimeSliderSymbology>;

/** Narrows a value to a finite `[min, max]` pair. */
function normalizeRescale(value: unknown): [number, number] | null {
  return Array.isArray(value) && value.length === 2 && value.every((n) => Number.isFinite(n))
    ? [value[0] as number, value[1] as number]
    : null;
}

/**
 * Reads the current symbology of a Time Slider raster source.
 *
 * @param sourceId - The source id (equals the mirrored store layer id).
 * @returns The symbology, or null when the dock is closed or the id is not a
 *   raster source (an XYZ/WMS/GeoJSON source has none to edit).
 */
export function getTimeSliderSymbology(sourceId: string): TimeSliderSymbology | null {
  const spec = getTimeSliderPixelSources().find((candidate) => candidate.id === sourceId);
  if (!spec) return null;
  return {
    type: spec.type,
    colormap: spec.colormap ?? null,
    bands: Array.isArray(spec.bidx) ? spec.bidx.filter((n) => Number.isInteger(n) && n > 0) : [],
    rescale: normalizeRescale(spec.rescale),
    nodata: spec.nodata ?? null,
  };
}

/**
 * Whether a Time Slider source is drawn by the client-side raster pipeline
 * (deck.gl, or the WASM tiler's own MapLibre source) rather than as a native
 * MapLibre raster layer keyed by the source id.
 *
 * The Style panel needs this to know which controls can work: MapLibre's raster
 * paint properties (brightness, contrast, saturation, hue) are written onto the
 * layer's `nativeLayerIds`, which only exist for a source the library renders
 * natively — an XYZ/WMS source, or a COG on the `titiler` engine. Everything
 * else has no such layer, so those sliders would move with no visible effect.
 *
 * `type === 'mosaic'` is exactly that set: a real mosaic, plus a COG on the
 * `gpu`/`wasm` engine, which the library reports as a mosaic because it renders
 * it through the same adapter.
 *
 * @param sourceId - The source id (equals the mirrored store layer id).
 * @returns True when the source is client-rendered.
 */
export function isTimeSliderDeckRasterSource(sourceId: string): boolean {
  return getTimeSliderSymbology(sourceId)?.type === "mosaic";
}

/**
 * Applies a symbology change to a Time Slider raster source.
 *
 * The control merges the patch into the source spec and re-renders, so the
 * change is live and is picked up by `getConfig()` when the project is saved.
 * Cleared fields are sent as `undefined` rather than omitted, so the renderer
 * drops them instead of keeping the previous value.
 *
 * @param sourceId - The source id (equals the mirrored store layer id).
 * @param patch - The fields to change.
 * @returns True when the patch was handed to the control.
 */
export function setTimeSliderSymbology(sourceId: string, patch: TimeSliderSymbologyPatch): boolean {
  const control = getActiveTimeSliderControl();
  if (!control) return false;
  if (!getTimeSliderPixelSources().some((candidate) => candidate.id === sourceId)) return false;

  const spec: Record<string, unknown> = {};
  if ("colormap" in patch) spec.colormap = patch.colormap || undefined;
  if ("bands" in patch) spec.bidx = patch.bands && patch.bands.length > 0 ? patch.bands : undefined;
  if ("rescale" in patch) spec.rescale = patch.rescale ?? undefined;
  if ("nodata" in patch) spec.nodata = patch.nodata ?? undefined;
  if (Object.keys(spec).length === 0) return false;

  control.setSourceProperty(sourceId, spec);
  return true;
}

/**
 * Parses a user-typed band list (e.g. `"4,3,2"`) into 1-based band indexes.
 *
 * Exported for testing and reuse by the panel: the same rule decides what is
 * sent to the renderer and what the field accepts, so a half-typed value never
 * reaches the spec.
 *
 * @param text - The raw field value.
 * @returns The parsed indexes, or null when the text is not a valid list
 *   (empty input parses to an empty list, meaning "let the renderer decide").
 */
export function parseBandList(text: string): number[] | null {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  const parts = trimmed.split(/[,\s]+/).filter(Boolean);
  const bands: number[] = [];
  for (const part of parts) {
    const value = Number(part);
    // Bands are 1-based positions, so anything non-integer or below 1 is a typo
    // rather than a meaningful selection.
    if (!Number.isInteger(value) || value < 1) return null;
    bands.push(value);
  }
  return bands;
}
