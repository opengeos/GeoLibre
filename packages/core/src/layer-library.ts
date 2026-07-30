// The Layer Library's data layer (issue #1520): capturing a configured layer as
// a reusable entry, planning how to re-add one to a project, the shareable JSON
// bundle format, and untrusted-input normalization. UI-free so both the desktop
// app and tests consume it directly. Mirrors the shape of `style-library.ts`,
// which does the same job for the Style Manager.
//
// The guiding rule is that an entry stores the layer's **source specification,
// not its data**: the library stays small and re-adding an entry always shows
// the current contents of its source. Layers whose features exist only in
// memory (drawn features, processing output) or only in a local file have no
// re-fetchable source, so those embed their features behind a size cap.

import type { FeatureCollection } from "geojson";
import {
  DEFAULT_LAYER_STYLE,
  LAYER_TYPES,
  type GeoLibreLayer,
  type LayerLibraryEntry,
  type LayerType,
} from "./types";
import { sanitizeLayerStylePatch } from "./style-library";

/** `type` discriminator of an exported Layer Library bundle file. */
export const LAYER_LIBRARY_BUNDLE_TYPE = "geolibre-layer-library";

/** Current bundle format version, for forward-compatible readers. */
export const LAYER_LIBRARY_BUNDLE_VERSION = 1;

/**
 * Size ceiling for one library entry's serialized JSON, in bytes. The library
 * lives in IndexedDB and is meant to be a small, shareable index of *sources*,
 * so an entry that can only be stored by embedding a large feature set is
 * refused rather than silently turning the library into a data store.
 *
 * Applied to the whole entry (not just `geojson`), because an Add Vector Layer
 * entry can also carry a `metadata.embeddedGeoJSON` copy of its features.
 */
export const MAX_LAYER_LIBRARY_ENTRY_BYTES = 5 * 1024 * 1024;

/**
 * Metadata keys dropped when capturing an entry. `resolvedUrl` is the dev-server
 * proxy rewrite of an XYZ template — a per-session artifact that must not be
 * baked into a saved source (the same reason `prepareLayerForSave` strips it).
 */
const TRANSIENT_METADATA_KEYS = ["resolvedUrl"] as const;

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Whether a layer's features can be re-fetched from its source specification
 * alone, so an entry need not embed them: a tile/service template, a remote
 * file URL, or a GeoJSON source pointing at a URL. A `geojson` source whose
 * `data` is an inline FeatureCollection (not a URL string) deliberately does
 * not count.
 *
 * @param layer - The layer to inspect (source + metadata only).
 * @returns True when the source alone is enough to recreate the layer's data.
 */
export function hasRestorableLayerSource(
  layer: Pick<GeoLibreLayer, "source" | "metadata">,
): boolean {
  const source = layer.source ?? {};
  if (nonEmptyString(source.url)) return true;
  if (nonEmptyString(source.data)) return true;
  if (Array.isArray(source.tiles) && source.tiles.some(nonEmptyString)) return true;
  return nonEmptyString((layer.metadata ?? {}).originalUrl);
}

/** The absolute local path a layer was read from, or undefined. */
function layerLocalPath(layer: Pick<GeoLibreLayer, "sourcePath">): string | undefined {
  return nonEmptyString(layer.sourcePath) ? layer.sourcePath : undefined;
}

function featureCount(geojson: FeatureCollection | undefined): number {
  return Array.isArray(geojson?.features) ? geojson.features.length : 0;
}

/**
 * Whether "Save to library" applies to a layer at all — the cheap predicate the
 * layer actions menu gates on. A layer qualifies when it has a re-fetchable
 * source, a local file path, or features to embed; the only layers excluded are
 * those with none of the three, which nothing could re-add.
 *
 * A layer that qualifies here can still fail to save because its features are
 * too large to embed ({@link MAX_LAYER_LIBRARY_ENTRY_BYTES}); that outcome
 * needs the full capture, so it is reported by
 * {@link captureLayerLibraryEntry} rather than hidden behind a disabled menu
 * item.
 *
 * @param layer - The layer to test.
 * @returns Whether the layer can be offered to the library.
 */
export function canSaveLayerToLibrary(layer: GeoLibreLayer): boolean {
  return (
    hasRestorableLayerSource(layer) ||
    layerLocalPath(layer) !== undefined ||
    featureCount(layer.geojson) > 0
  );
}

/** Why a layer could not be captured into the library. */
export type LayerLibraryCaptureFailure =
  /** Nothing to re-add from: no source URL, no local path, no features. */
  | "no-source"
  /** Its features are the only copy, and they exceed the per-entry size cap. */
  | "too-large";

/** Outcome of {@link captureLayerLibraryEntry}. */
export type LayerLibraryCaptureResult =
  | { ok: true; entry: LayerLibraryEntry }
  | { ok: false; reason: LayerLibraryCaptureFailure };

/**
 * Approximate serialized size of a value in bytes. `JSON.stringify().length`
 * counts UTF-16 code units, which matches bytes for the ASCII-dominated JSON a
 * library entry holds and under-counts only for non-Latin text — close enough
 * for a size ceiling, and far cheaper than encoding the string.
 */
function approximateJsonBytes(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    // A source or metadata value with a circular reference cannot be stored at
    // all, so treat it as over any cap.
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Whether a layer is painted by a plugin control rather than by GeoLibre's own
 * layer sync (Add Vector Layer, the deck.gl raster/COG control, 3D Tiles,
 * LiDAR, …). These recreate their map output from the layer record through
 * their plugin's restore pass, so an entry for one must carry the metadata that
 * pass reads — and re-adding it has to run that pass.
 *
 * @param layer - The layer to test (metadata only).
 * @returns True when a plugin control owns the layer's rendering.
 */
export function isExternalNativeLayerRecord(layer: Pick<GeoLibreLayer, "metadata">): boolean {
  return (layer.metadata ?? {}).externalNativeLayer === true;
}

/**
 * Capture a configured layer as a reusable Layer Library entry: its source
 * spec, layer type, full style (labels included), opacity, metadata, and the
 * per-layer configuration that makes it "fully configured" — joins, virtual
 * fields, and the attribute form. Project-specific placement (`id`,
 * `groupId`, `beforeId`) is deliberately not captured.
 *
 * Features are embedded only when the source cannot supply them (an in-memory
 * or local-file layer). Where they land depends on who paints the layer:
 * GeoLibre-rendered layers keep them in {@link LayerLibraryEntry.geojson},
 * while a control-painted layer gets them in `metadata.embeddedGeoJSON` — the
 * same field the project format's Embed/Share flow writes and the plugin's
 * restore pass reads.
 *
 * If the result exceeds {@link MAX_LAYER_LIBRARY_ENTRY_BYTES} the capture
 * degrades rather than failing outright: it falls back to a path-only entry
 * (`needsLocalFile`) when a local file can supply the features.
 *
 * @param layer - The live layer to save.
 * @param options - Fresh entry `id`, ISO `addedAt`, an optional `name` override
 *   (defaults to the layer's name), and optional `features` to embed instead of
 *   the layer's own `geojson` (the caller reads a control-painted layer's
 *   current data from its control).
 * @returns The entry, or the reason it could not be captured.
 */
export function captureLayerLibraryEntry(
  layer: GeoLibreLayer,
  options: { id: string; addedAt: string; name?: string; features?: FeatureCollection },
): LayerLibraryCaptureResult {
  const localPath = layerLocalPath(layer);
  const hasSource = hasRestorableLayerSource(layer);
  const supplied = featureCount(options.features) > 0 ? options.features : undefined;
  const features = supplied ?? (featureCount(layer.geojson) > 0 ? layer.geojson : undefined);
  if (!hasSource && !localPath && !features) {
    return { ok: false, reason: "no-source" };
  }

  const metadata: Record<string, unknown> = { ...(layer.metadata ?? {}) };
  for (const key of TRANSIENT_METADATA_KEYS) delete metadata[key];
  // A stale embedded copy from the project this layer was loaded from: the
  // capture below re-embeds current data (or drops the copy when the source can
  // re-fetch it), so never carry the old blob through.
  delete metadata.embeddedGeoJSON;

  const controlPainted = isExternalNativeLayerRecord(layer);
  // Embed features only when the source cannot re-fetch them; a layer with a
  // restorable source stays data-free so its entry keeps reflecting the source.
  const embed = !hasSource && features ? structuredClone(features) : undefined;
  if (embed && controlPainted) {
    metadata.embeddedGeoJSON = embed;
    // Mirrors the project Embed flow: with the data embedded, the restore pass
    // must replay it rather than a file path that may not exist on this machine.
    delete metadata.localFileReloadable;
  }

  const base: LayerLibraryEntry = {
    id: options.id,
    name: options.name?.trim() || layer.name,
    addedAt: options.addedAt,
    layerType: layer.type,
    source: structuredClone(layer.source ?? {}),
    style: structuredClone({ ...DEFAULT_LAYER_STYLE, ...layer.style }),
    opacity:
      typeof layer.opacity === "number" && Number.isFinite(layer.opacity) ? layer.opacity : 1,
    metadata: structuredClone(metadata),
    ...(localPath ? { sourcePath: localPath } : {}),
    ...(layer.joins?.length ? { joins: structuredClone(layer.joins) } : {}),
    ...(layer.virtualFields?.length ? { virtualFields: structuredClone(layer.virtualFields) } : {}),
    ...(layer.attributeForm ? { attributeForm: structuredClone(layer.attributeForm) } : {}),
  };
  const withFeatures = embed && !controlPainted ? { ...base, geojson: embed } : base;

  if (approximateJsonBytes(withFeatures) <= MAX_LAYER_LIBRARY_ENTRY_BYTES) {
    return { ok: true, entry: withFeatures };
  }
  if (embed && localPath) {
    // Last resort for an oversized local file: keep the path and let the
    // desktop host re-read it at add time.
    const { embeddedGeoJSON: _dropped, ...leanMetadata } = withFeatures.metadata;
    const pathOnly: LayerLibraryEntry = {
      ...withFeatures,
      metadata: leanMetadata,
      needsLocalFile: true,
    };
    delete pathOnly.geojson;
    if (approximateJsonBytes(pathOnly) <= MAX_LAYER_LIBRARY_ENTRY_BYTES) {
      return { ok: true, entry: pathOnly };
    }
  }
  return { ok: false, reason: "too-large" };
}

/** How an entry should be re-added to the current project. */
export type LayerLibraryAddPlan =
  /** Add this layer record to the store; the map sync renders it. */
  | { kind: "layer"; layer: GeoLibreLayer }
  /**
   * The entry's features live only in a local file the host must re-read
   * (its data was too large to embed), so the caller runs its local-file add
   * path for `path`. Only reachable on a host with filesystem access.
   */
  | { kind: "local-file"; path: string; name: string };

/**
 * Plan how to re-add a library entry to the current project.
 *
 * @param entry - The library entry to add.
 * @param options - The fresh layer `id` to create it under.
 * @returns Either the layer record to add, or the local file to re-read.
 */
export function planLayerLibraryAdd(
  entry: LayerLibraryEntry,
  options: { id: string },
): LayerLibraryAddPlan {
  if (entry.needsLocalFile && nonEmptyString(entry.sourcePath)) {
    return { kind: "local-file", path: entry.sourcePath, name: entry.name };
  }
  return {
    kind: "layer",
    layer: {
      id: options.id,
      name: entry.name,
      type: entry.layerType,
      source: structuredClone(entry.source),
      // Always added visible: the user just asked for this layer.
      visible: true,
      opacity: entry.opacity,
      style: structuredClone(entry.style),
      metadata: structuredClone(entry.metadata),
      ...(entry.sourcePath ? { sourcePath: entry.sourcePath } : {}),
      ...(entry.geojson ? { geojson: structuredClone(entry.geojson) } : {}),
      ...(entry.joins ? { joins: structuredClone(entry.joins) } : {}),
      ...(entry.virtualFields ? { virtualFields: structuredClone(entry.virtualFields) } : {}),
      ...(entry.attributeForm ? { attributeForm: structuredClone(entry.attributeForm) } : {}),
    },
  };
}

/**
 * Whether re-adding an entry needs a host that can read local files — used to
 * badge the entry in the Browser panel and to explain the failure in the
 * browser build, where there is no filesystem to re-read from.
 *
 * @param entry - The entry to test.
 * @returns True when only a filesystem-capable host can add it.
 */
export function layerLibraryEntryNeedsLocalFile(entry: LayerLibraryEntry): boolean {
  return entry.needsLocalFile === true && nonEmptyString(entry.sourcePath);
}

/** A plain JSON object (not an array, not null), or undefined. */
function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** An array of plain JSON objects, or undefined when nothing usable is present. */
function objectArray(value: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is Record<string, unknown> => Boolean(plainObject(item)));
  return items.length > 0 ? items : undefined;
}

/** A GeoJSON FeatureCollection shape, or undefined. */
function featureCollection(value: unknown): FeatureCollection | undefined {
  const object = plainObject(value);
  if (!object || object.type !== "FeatureCollection" || !Array.isArray(object.features)) {
    return undefined;
  }
  return object as unknown as FeatureCollection;
}

/**
 * Coerce an untrusted entries array (an imported bundle, or a record written by
 * an older version) into valid {@link LayerLibraryEntry} records. Entries
 * without a usable id, name, or layer type are dropped, ids are de-duplicated,
 * the style is sanitized through the Style Manager's
 * {@link sanitizeLayerStylePatch} and completed against the defaults, and each
 * optional block is kept only when structurally plausible.
 *
 * Entries that cannot be re-added at all (no source, no path, no features) are
 * dropped rather than shown as permanently-failing rows.
 *
 * @param value - The raw entries value.
 * @returns Normalized, de-duplicated entries (empty when none survive).
 */
export function normalizeLayerLibraryEntries(value: unknown): LayerLibraryEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: LayerLibraryEntry[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const candidate = plainObject(raw);
    if (!candidate) continue;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
    // An unknown layer type is dropped rather than coerced: every downstream
    // renderer branches on it, so a made-up value would render nothing.
    const layerType = LAYER_TYPES.includes(candidate.layerType as LayerType)
      ? (candidate.layerType as LayerType)
      : undefined;
    if (!id || !name || !layerType || seen.has(id)) continue;
    const source = plainObject(candidate.source) ?? {};
    const metadata = plainObject(candidate.metadata) ?? {};
    const sourcePath = nonEmptyString(candidate.sourcePath) ? candidate.sourcePath : undefined;
    const geojson = featureCollection(candidate.geojson);
    // Same "is there anything to re-add from" gate as the capture path, so a
    // hand-edited bundle cannot introduce an entry that always fails. A
    // control-painted entry carries its features in `metadata.embeddedGeoJSON`
    // instead of `geojson`, so that counts too.
    if (
      !hasRestorableLayerSource({ source, metadata }) &&
      !sourcePath &&
      featureCount(geojson) === 0 &&
      featureCount(featureCollection(metadata.embeddedGeoJSON)) === 0
    ) {
      continue;
    }
    const opacity =
      typeof candidate.opacity === "number" &&
      Number.isFinite(candidate.opacity) &&
      candidate.opacity >= 0 &&
      candidate.opacity <= 1
        ? candidate.opacity
        : 1;
    seen.add(id);
    entries.push({
      id,
      name,
      addedAt: typeof candidate.addedAt === "string" ? candidate.addedAt : "",
      layerType,
      source: structuredClone(source),
      style: { ...DEFAULT_LAYER_STYLE, ...sanitizeLayerStylePatch(candidate.style) },
      opacity,
      metadata: structuredClone(metadata),
      ...(sourcePath ? { sourcePath } : {}),
      ...(objectArray(candidate.joins)
        ? { joins: structuredClone(candidate.joins) as LayerLibraryEntry["joins"] }
        : {}),
      ...(objectArray(candidate.virtualFields)
        ? {
            virtualFields: structuredClone(
              candidate.virtualFields,
            ) as LayerLibraryEntry["virtualFields"],
          }
        : {}),
      ...(plainObject(candidate.attributeForm)
        ? {
            attributeForm: structuredClone(
              candidate.attributeForm,
            ) as LayerLibraryEntry["attributeForm"],
          }
        : {}),
      ...(geojson ? { geojson: structuredClone(geojson) } : {}),
      // `needsLocalFile` only means anything with a path to read.
      ...(candidate.needsLocalFile === true && sourcePath ? { needsLocalFile: true } : {}),
    });
  }
  return entries;
}

/**
 * Serialize Layer Library entries into the shareable bundle JSON written by the
 * Export action and read back by {@link parseLayerLibrary}.
 *
 * @param entries - The entries to export.
 * @returns Pretty-printed bundle JSON.
 */
export function serializeLayerLibrary(entries: LayerLibraryEntry[]): string {
  return JSON.stringify(
    {
      type: LAYER_LIBRARY_BUNDLE_TYPE,
      version: LAYER_LIBRARY_BUNDLE_VERSION,
      entries,
    },
    null,
    2,
  );
}

/**
 * Parse a Layer Library bundle produced by {@link serializeLayerLibrary} (a
 * bare entries array is also accepted, so hand-authored files work). Entries
 * are normalized through {@link normalizeLayerLibraryEntries}.
 *
 * @param json - The bundle file content.
 * @returns The normalized entries.
 * @throws Error when the JSON is not a layer-library bundle or holds no usable
 *   entries.
 */
export function parseLayerLibrary(json: string): LayerLibraryEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Not a valid layer library file (invalid JSON).");
  }
  let rawEntries: unknown = null;
  if (Array.isArray(parsed)) {
    rawEntries = parsed;
  } else if (plainObject(parsed)?.type === LAYER_LIBRARY_BUNDLE_TYPE) {
    // Refuse a bundle from a newer format rather than misreading it with v1
    // semantics. Bare arrays stay accepted for hand-authored files.
    if (plainObject(parsed)?.version !== LAYER_LIBRARY_BUNDLE_VERSION) {
      throw new Error("Unsupported layer library version.");
    }
    rawEntries = plainObject(parsed)?.entries;
  }
  if (rawEntries === null) {
    throw new Error("Not a valid layer library file.");
  }
  const entries = normalizeLayerLibraryEntries(rawEntries);
  if (entries.length === 0) {
    throw new Error("The layer library file holds no usable entries.");
  }
  return entries;
}

/**
 * Create a fresh unique id for a new library entry.
 *
 * @returns A random id (UUID when available).
 */
export function createLayerLibraryEntryId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `layer-lib-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
