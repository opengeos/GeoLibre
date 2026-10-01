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
 * applied (see {@link findLayerStyleEntry}).
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

/**
 * Coerce untrusted entries (a hand-edited file, or a copy kept in settings)
 * into clean ones. An entry without a name or a known kind is dropped; a
 * vector style is sanitized and completed against the default style, so
 * applying it never leaves the renderer reading an unknown or missing field.
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
          ? { rasterState: structuredClone(item.rasterState) }
          : {}),
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
 * @returns The matching entry, or `undefined`.
 */
export function findLayerStyleEntry(
  entries: readonly LayerStyleFileEntry[],
  layerName: string,
  kind?: LayerStyleClipboardKind,
): LayerStyleFileEntry | undefined {
  const candidates = kind ? entries.filter((entry) => entry.kind === kind) : entries;
  const exact = candidates.find((entry) => entry.layerName === layerName);
  if (exact) return exact;
  const key = nameKey(layerName);
  return candidates.find((entry) => nameKey(entry.layerName) === key);
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

/**
 * Build the patch that restyles a layer from the entry matching its name, with
 * the same semantics as pasting a copied style: a vector style replaces the
 * whole style bag, a raster style merges its appearance keys and keeps the
 * layer's own band selection, and layer opacity is left alone.
 *
 * @param layer - The layer to restyle.
 * @param entries - The style entries.
 * @returns The patch, or `null` when no entry of the layer's style family
 *   matches its name (or the layer has no stylable symbology).
 */
export function layerStylePatchFromEntries(
  layer: GeoLibreLayer,
  entries: readonly LayerStyleFileEntry[],
): Partial<GeoLibreLayer> | null {
  const kind = copyableLayerStyleKind(layer);
  if (!kind) return null;
  const entry = findLayerStyleEntry(entries, layer.name, kind);
  if (!entry) return null;
  return applyCopiedLayerStyle(layer, toCopiedLayerStyle(entry));
}
