// Export every layer's style to one JSON file and apply such a file back by
// layer name: Project → Export → Export Layer Styles, Project → Import →
// Import Layer Styles, and the Startup setting that restyles each newly added
// layer whose name matches an entry. A style here is exactly what copy/paste
// style carries (see `layer-style-clipboard.ts`), so an exported entry restyles
// a layer the same way pasting a copied style onto it would.

import {
  applyCopiedLayerStyle,
  type CopiedLayerStyle,
  copyableLayerStyleKind,
  extractCopiedLayerStyle,
  type LayerStyleClipboardKind,
  RASTER_APPEARANCE_STATE_KEYS,
} from "./layer-style-clipboard";
import { sanitizeLayerStylePatch } from "./style-library";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer, type LayerStyle } from "./types";

/** `type` tag identifying a layer styles file. */
export const LAYER_STYLES_FILE_TYPE = "geolibre-layer-styles";

/** Format version written by {@link serializeLayerStylesFile}. */
export const LAYER_STYLES_FILE_VERSION = 1;

/** One layer's style in a layer styles file, keyed by the layer's name. */
export type LayerStyleFileEntry =
  | {
      /** Name of the layer the style was exported from; the match key. */
      layerName: string;
      kind: "vector";
      /** The full vector {@link LayerStyle} bag. */
      style: LayerStyle;
    }
  | {
      layerName: string;
      kind: "raster";
      /** Raster visualization state (`metadata.rasterState`). */
      rasterState?: Record<string, unknown>;
      /** Raster classification symbology (`metadata.rasterSymbology`). */
      rasterSymbology?: Record<string, unknown>;
    };

/** The on-disk layer styles document. */
export interface LayerStylesFile {
  type: typeof LAYER_STYLES_FILE_TYPE;
  version: typeof LAYER_STYLES_FILE_VERSION;
  styles: LayerStyleFileEntry[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Capture the style of every layer that has one. Layers without copyable
 * symbology (basemap tiles, 3D tiles, ...) are skipped. Layers that share a
 * name are all written, in stack order; the first one wins when the file is
 * applied (see {@link findLayerStyleEntryIndex}).
 *
 * @param layers - The layers to export, in store (bottom-to-top) order.
 * @returns The style entries.
 */
export function extractLayerStyleEntries(layers: readonly GeoLibreLayer[]): LayerStyleFileEntry[] {
  const entries: LayerStyleFileEntry[] = [];
  for (const layer of layers) {
    const copied = extractCopiedLayerStyle(layer);
    if (!copied) continue;
    if (copied.kind === "vector") {
      entries.push({ layerName: layer.name, kind: "vector", style: copied.style });
    } else {
      entries.push({
        layerName: layer.name,
        kind: "raster",
        ...(copied.rasterState ? { rasterState: copied.rasterState } : {}),
        ...(isPlainObject(copied.rasterSymbology)
          ? { rasterSymbology: copied.rasterSymbology }
          : {}),
      });
    }
  }
  return entries;
}

/**
 * Serialize style entries into the JSON written by Export Layer Styles.
 *
 * @param entries - The entries to write.
 * @returns Pretty-printed file content.
 */
export function serializeLayerStylesFile(entries: readonly LayerStyleFileEntry[]): string {
  const file: LayerStylesFile = {
    type: LAYER_STYLES_FILE_TYPE,
    version: LAYER_STYLES_FILE_VERSION,
    styles: [...entries],
  };
  return JSON.stringify(file, null, 2);
}

const RASTER_STRETCHES: readonly unknown[] = ["linear", "log", "sqrt"];
const RASTER_NODATA_MODES: readonly unknown[] = ["off", "auto"];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Validators for the raster appearance keys a style file may carry, by the
 * types `maplibre-gl-raster`'s `RasterLayerState` declares for them.
 */
const RASTER_APPEARANCE_VALIDATORS: Record<
  (typeof RASTER_APPEARANCE_STATE_KEYS)[number],
  (value: unknown) => boolean
> = {
  colormap: (value) => typeof value === "string" && value.length > 0,
  reversed: (value) => typeof value === "boolean",
  rescale: (value) =>
    value === null ||
    (Array.isArray(value) &&
      // An empty array is not a meaningful rescale (as in savedRasterState).
      value.length > 0 &&
      value.every(
        (range) =>
          Array.isArray(range) &&
          range.length === 2 &&
          isFiniteNumber(range[0]) &&
          isFiniteNumber(range[1]),
      )),
  nodata: (value) => isFiniteNumber(value) || RASTER_NODATA_MODES.includes(value),
  stretch: (value) => RASTER_STRETCHES.includes(value),
  gamma: (value) => isFiniteNumber(value) && value > 0,
};

/**
 * Keep only the raster appearance keys a style applies, each with a value of
 * the type the raster renderer expects. The data selection (`mode`, `bands`,
 * ...) is dropped too: a style never applies it.
 */
function sanitizeRasterAppearanceState(state: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of RASTER_APPEARANCE_STATE_KEYS) {
    if (key in state && RASTER_APPEARANCE_VALIDATORS[key](state[key])) {
      out[key] = structuredClone(state[key]);
    }
  }
  return out;
}

/**
 * Coerce untrusted entries (a hand-edited file, or a copy kept in settings)
 * into clean ones. An entry without a name or a known kind is dropped; a
 * vector style is sanitized and completed against the default style, and a
 * raster state keeps only well-typed appearance keys, so applying an entry
 * never hands a renderer an unknown, missing or wrong-typed field.
 *
 * @param value - The raw `styles` array.
 * @returns The usable entries.
 */
export function normalizeLayerStyleEntries(value: unknown): LayerStyleFileEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: LayerStyleFileEntry[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) continue;
    const layerName = typeof item.layerName === "string" ? item.layerName : "";
    if (!layerName.trim()) continue;
    if (item.kind === "vector") {
      if (!isPlainObject(item.style)) continue;
      entries.push({
        layerName,
        kind: "vector",
        style: { ...structuredClone(DEFAULT_LAYER_STYLE), ...sanitizeLayerStylePatch(item.style) },
      });
    } else if (item.kind === "raster") {
      entries.push({
        layerName,
        kind: "raster",
        ...(isPlainObject(item.rasterState)
          ? { rasterState: sanitizeRasterAppearanceState(item.rasterState) }
          : {}),
        // The symbology's schema lives in `@geolibre/plugins`, which validates
        // it on every read (`savedRasterSymbology`), as it does for a project
        // file; a malformed one renders as unclassified there.
        ...(isPlainObject(item.rasterSymbology)
          ? { rasterSymbology: structuredClone(item.rasterSymbology) }
          : {}),
      });
    }
  }
  return entries;
}

/**
 * Parse a file written by {@link serializeLayerStylesFile}.
 *
 * @param json - The file content.
 * @returns The normalized entries.
 * @throws Error when the content is not a layer styles file, comes from a
 *   newer format version, or holds no usable entries.
 */
export function parseLayerStylesFile(json: string): LayerStyleFileEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Not a valid layer styles file (invalid JSON).");
  }
  if (!isPlainObject(parsed) || parsed.type !== LAYER_STYLES_FILE_TYPE) {
    throw new Error("Not a valid layer styles file.");
  }
  // Refuse a newer format rather than misread it with this version's rules.
  if (parsed.version !== LAYER_STYLES_FILE_VERSION) {
    throw new Error("Unsupported layer styles file version.");
  }
  const entries = normalizeLayerStyleEntries(parsed.styles);
  if (entries.length === 0) {
    throw new Error("The layer styles file holds no usable styles.");
  }
  return entries;
}

function nameKey(name: string): string {
  return name.trim().toLocaleLowerCase();
}

/**
 * Find the entry for a layer name: an exact match first, then one that differs
 * only in case or surrounding whitespace, so `Roads` still picks up a style
 * saved for `roads`. The first match in file order wins.
 *
 * @param entries - The style entries.
 * @param layerName - The layer name to look up.
 * @param kind - When given, only entries of this style family are considered,
 *   so a raster style saved under a shared name does not shadow the vector one.
 * @returns The matching entry's index in `entries`, or -1.
 */
export function findLayerStyleEntryIndex(
  entries: readonly LayerStyleFileEntry[],
  layerName: string,
  kind?: LayerStyleClipboardKind,
): number {
  const ofKind = (entry: LayerStyleFileEntry) => !kind || entry.kind === kind;
  const exact = entries.findIndex((entry) => ofKind(entry) && entry.layerName === layerName);
  if (exact >= 0) return exact;
  const key = nameKey(layerName);
  return entries.findIndex((entry) => ofKind(entry) && nameKey(entry.layerName) === key);
}

function toCopiedLayerStyle(entry: LayerStyleFileEntry): CopiedLayerStyle {
  if (entry.kind === "vector") {
    return { kind: "vector", sourceName: entry.layerName, style: entry.style };
  }
  return {
    kind: "raster",
    sourceName: entry.layerName,
    rasterState: entry.rasterState,
    hasRasterSymbology: entry.rasterSymbology !== undefined,
    ...(entry.rasterSymbology !== undefined ? { rasterSymbology: entry.rasterSymbology } : {}),
  };
}

/** A layer restyled from a style entry, and the entry it took. */
export interface LayerStyleMatch {
  /** Index of the applied entry in the entries array. */
  entryIndex: number;
  /** The patch that applies it. */
  patch: Partial<GeoLibreLayer>;
}

/**
 * Build the patch that restyles a layer from the entry matching its name, with
 * the same semantics as pasting a copied style: a vector style replaces the
 * whole style bag, a raster style merges its appearance keys and keeps the
 * layer's own band selection, and layer opacity is left alone.
 *
 * @param layer - The layer to restyle.
 * @param entries - The style entries.
 * @returns The matched entry and patch, or `null` when no entry of the layer's
 *   style family matches its name (or the layer has no stylable symbology).
 */
export function matchLayerStyleEntry(
  layer: GeoLibreLayer,
  entries: readonly LayerStyleFileEntry[],
): LayerStyleMatch | null {
  const kind = copyableLayerStyleKind(layer);
  if (!kind) return null;
  const entryIndex = findLayerStyleEntryIndex(entries, layer.name, kind);
  if (entryIndex < 0) return null;
  const patch = applyCopiedLayerStyle(layer, toCopiedLayerStyle(entries[entryIndex]));
  return patch ? { entryIndex, patch } : null;
}
