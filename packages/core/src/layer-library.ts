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
  type AttributeFormConfig,
  type GeoLibreLayer,
  type LayerJoin,
  type LayerLibraryEntry,
  type LayerStyle,
  type LayerType,
  type LayerVirtualField,
} from "./types";
import { sanitizeLayerStylePatch } from "./style-library";
import { hasPathTraversal, isAbsoluteFilesystemPath } from "./paths";

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

/**
 * The absolute local path a layer's data can be **re-read** from, or undefined.
 *
 * A non-empty `sourcePath` is not enough on its own: a file picked in the
 * browser has no path, and both the vector and raster controls still record the
 * bare file *name* there for display. Each control marks a genuinely re-readable
 * absolute path differently, so both conventions are honored:
 *
 * - Vector / plain local GeoJSON: `metadata.localFileReloadable` alongside an
 *   absolute `sourcePath` (`prepareLayerForSave`, `needsLocalFileReload`,
 *   `restoreVectorLayers`).
 * - Raster / COG: `metadata.localFilePath` holds the absolute path outright,
 *   and it is what `restoreRasterLayers` re-reads on restore. Without this
 *   branch a locally-opened COG could not be saved at all, even though its
 *   restore pass is fully able to replay it.
 *
 * Every candidate is re-validated, because a hand-edited project or an imported
 * bundle can set these fields to anything.
 */
function layerLocalPath(layer: Pick<GeoLibreLayer, "sourcePath" | "metadata">): string | undefined {
  const metadata = layer.metadata ?? {};
  if (nonEmptyString(metadata.localFilePath) && isReReadablePath(metadata.localFilePath)) {
    return metadata.localFilePath;
  }
  if (metadata.localFileReloadable !== true) return undefined;
  return nonEmptyString(layer.sourcePath) && isReReadablePath(layer.sourcePath)
    ? layer.sourcePath
    : undefined;
}

/**
 * Whether a persisted path is safe to hand to a host file read: absolute, with
 * no `..` traversal. Applied to captured *and* imported entries, because a
 * shared bundle is untrusted input — a crafted `needsLocalFile` entry could
 * otherwise point at any file on the importing user's disk, and clicking it in
 * My Data would read that file. Mirrors the client-side re-validation the
 * project-restore paths already do before calling into Tauri.
 */
function isReReadablePath(path: string): boolean {
  return isAbsoluteFilesystemPath(path) && !hasPathTraversal(path);
}

function featureCount(geojson: FeatureCollection | undefined): number {
  return Array.isArray(geojson?.features) ? geojson.features.length : 0;
}

/**
 * Whether "Save to library" applies to a layer at all — the cheap predicate the
 * layer actions menu gates on. Two things have to hold:
 *
 * 1. There is something to re-add *from*: a re-fetchable source, a local file
 *    path, or features to embed.
 * 2. The host can actually render it again. For a control-painted layer
 *    ({@link isExternalNativeLayerRecord}) that means either the map's own sync
 *    rebuilds it from the record or the owning plugin's restore pass can be
 *    re-run, which only the host knows — so the caller supplies
 *    `canRestoreControlPainted`. Without it, control-painted layers are refused
 *    rather than saved into an entry that would re-add unrendered.
 *
 * A layer that qualifies here can still fail to save because its features are
 * too large to embed ({@link MAX_LAYER_LIBRARY_ENTRY_BYTES}); that outcome needs
 * the full capture, so it is reported by {@link captureLayerLibraryEntry} rather
 * than hidden behind a disabled menu item.
 *
 * @param layer - The layer to test.
 * @param options - `canRestoreControlPainted` answers whether the host can
 *   re-render a control-painted layer (the desktop app passes its
 *   `canRestoreLibraryLayer`).
 * @returns Whether the layer can be offered to the library.
 */
export function canSaveLayerToLibrary(
  layer: GeoLibreLayer,
  options: { canRestoreControlPainted?: (layer: GeoLibreLayer) => boolean } = {},
): boolean {
  const hasSomethingToReAddFrom =
    hasRestorableLayerSource(layer) ||
    layerLocalPath(layer) !== undefined ||
    featureCount(layer.geojson) > 0;
  if (!hasSomethingToReAddFrom) return false;
  if (!isExternalNativeLayerRecord(layer)) return true;
  return options.canRestoreControlPainted?.(layer) === true;
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

/**
 * The presentation state a re-added layer takes from its entry. For the
 * `local-file` plan the host imports the file first (producing a default-styled
 * layer) and then applies this patch, so a degraded entry still comes back
 * "fully configured" rather than losing the styling the entry preserved.
 */
export interface LayerLibraryConfigPatch {
  name: string;
  style: LayerStyle;
  opacity: number;
  joins?: LayerJoin[];
  virtualFields?: LayerVirtualField[];
  attributeForm?: AttributeFormConfig;
}

/** How an entry should be re-added to the current project. */
export type LayerLibraryAddPlan =
  /** Add this layer record to the store; the map sync renders it. */
  | { kind: "layer"; layer: GeoLibreLayer }
  /**
   * The entry's features live only in a local file the host must re-read (its
   * data was too large to embed), so the caller runs its local-file add path for
   * `path` and then applies `config` to the layer that import produced. Only
   * reachable on a host with filesystem access.
   */
  | { kind: "local-file"; path: string; config: LayerLibraryConfigPatch };

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
  if (layerLibraryEntryNeedsLocalFile(entry)) {
    return {
      kind: "local-file",
      // Non-null by the guard above, which also re-validates the path.
      path: entry.sourcePath as string,
      config: layerLibraryConfigPatch(entry),
    };
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
 * The presentation state to apply to a layer the host imported from an entry's
 * file, so the `local-file` plan preserves everything the entry captured.
 *
 * @param entry - The entry being re-added.
 * @returns The patch to merge onto the imported layer.
 */
export function layerLibraryConfigPatch(entry: LayerLibraryEntry): LayerLibraryConfigPatch {
  return {
    name: entry.name,
    style: structuredClone(entry.style),
    opacity: entry.opacity,
    ...(entry.joins ? { joins: structuredClone(entry.joins) } : {}),
    ...(entry.virtualFields ? { virtualFields: structuredClone(entry.virtualFields) } : {}),
    ...(entry.attributeForm ? { attributeForm: structuredClone(entry.attributeForm) } : {}),
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
  return (
    entry.needsLocalFile === true &&
    nonEmptyString(entry.sourcePath) &&
    isReReadablePath(entry.sourcePath)
  );
}

/** A plain JSON object (not an array, not null), or undefined. */
function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Whether every listed key on an object holds a non-empty string. */
function hasStringKeys(object: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => nonEmptyString(object[key]));
}

/**
 * Keep only the {@link LayerJoin} members a hand-edited or imported bundle got
 * right. A join missing any of its required fields resolves to nothing and would
 * sit in the Joins UI as a permanently-broken definition, so drop it rather than
 * the whole entry.
 */
function validJoins(value: unknown): LayerJoin[] | undefined {
  const items = objectArray(value)?.filter((join) =>
    hasStringKeys(join, ["id", "joinLayerId", "targetField", "joinField"]),
  );
  return items && items.length > 0 ? (structuredClone(items) as unknown as LayerJoin[]) : undefined;
}

/** Keep only {@link LayerVirtualField} members that carry an id, name, and expression. */
function validVirtualFields(value: unknown): LayerVirtualField[] | undefined {
  const items = objectArray(value)?.filter((field) =>
    hasStringKeys(field, ["id", "name", "expression"]),
  );
  return items && items.length > 0
    ? (structuredClone(items) as unknown as LayerVirtualField[])
    : undefined;
}

/**
 * Keep an {@link AttributeFormConfig} only when every field entry names the
 * feature property it configures; a field with no `field` key would apply to
 * nothing.
 */
function validAttributeForm(value: unknown): AttributeFormConfig | undefined {
  const config = plainObject(value);
  if (!config || !Array.isArray(config.fields)) return undefined;
  const fields = config.fields.filter(
    (field) =>
      plainObject(field) !== undefined && nonEmptyString((field as { field?: unknown }).field),
  );
  if (fields.length === 0) return undefined;
  return structuredClone({ ...config, fields }) as unknown as AttributeFormConfig;
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
    const metadata = { ...(plainObject(candidate.metadata) ?? {}) };
    // Strip the same per-session keys the capture path drops, so a stale one on
    // an older record or an imported bundle is cleaned up on load instead of
    // replaying a dev-server proxy rewrite indefinitely.
    for (const key of TRANSIENT_METADATA_KEYS) delete metadata[key];
    // `metadata.localFilePath` is the *second* path in an entry, and the one
    // `restoreRasterLayers` re-reads — so it needs the same validation as
    // `sourcePath` below, not a free pass because it happens to live in
    // metadata. Without this a shared bundle could keep a valid-looking
    // `sourcePath` while pointing the raster restore at any file on the
    // importing user's disk.
    if ("localFilePath" in metadata) {
      const path = metadata.localFilePath;
      if (!nonEmptyString(path) || !isReReadablePath(path)) delete metadata.localFilePath;
    }
    // A bundle is shareable, so its `sourcePath` is untrusted: keep it only when
    // it is an absolute, traversal-free path a host could legitimately re-read.
    // Without this a crafted entry could point `onAddFilePath` at any file on the
    // importing user's disk.
    const sourcePath =
      nonEmptyString(candidate.sourcePath) && isReReadablePath(candidate.sourcePath)
        ? candidate.sourcePath
        : undefined;
    const geojson = featureCollection(candidate.geojson);
    // Same "is there anything to re-add from" gate as the capture path, so a
    // hand-edited bundle cannot introduce an entry that always fails. Both path
    // conventions count (a local raster's only path is `metadata.localFilePath`,
    // already validated above), and so does a control-painted entry's
    // `metadata.embeddedGeoJSON`, which holds its features instead of `geojson`.
    if (
      !hasRestorableLayerSource({ source, metadata }) &&
      !sourcePath &&
      !nonEmptyString(metadata.localFilePath) &&
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
      ...(() => {
        // Each block is kept only when its members carry the fields their engine
        // needs; a malformed member is dropped rather than the whole entry.
        const joins = validJoins(candidate.joins);
        const virtualFields = validVirtualFields(candidate.virtualFields);
        const attributeForm = validAttributeForm(candidate.attributeForm);
        return {
          ...(joins ? { joins } : {}),
          ...(virtualFields ? { virtualFields } : {}),
          ...(attributeForm ? { attributeForm } : {}),
        };
      })(),
      ...(geojson ? { geojson: structuredClone(geojson) } : {}),
      // `needsLocalFile` only means anything with a path to read.
      ...(candidate.needsLocalFile === true && sourcePath ? { needsLocalFile: true } : {}),
    });
  }
  return entries;
}

/**
 * `source` fields that can hold a per-user credential and are therefore removed
 * on export. `requestHeaders` carries the bearer token / API key an
 * authenticated 3D Tiles layer was added with (see
 * `persistedThreeDTilesRequestHeaders`, which keeps non-Google auth headers when
 * persisting into a project file).
 *
 * Kept in the local IndexedDB entry so re-adding on this machine still works,
 * and dropped only from the bundle: Export is pitched as a one-click "share with
 * your team" action, which makes it a far more direct exposure path than handing
 * someone a whole project file. A recipient re-enters their own credentials,
 * which is the correct outcome.
 */
const EXPORT_REDACTED_SOURCE_KEYS = ["requestHeaders"] as const;

/**
 * Query-parameter names removed from a source URL on export. Plenty of tile and
 * web services authenticate in the URL rather than a header — an XYZ template
 * with `?api_key=`, a Google `key=`, a Mapbox `access_token=`, an S3 presigned
 * link (`X-Amz-*`), an Azure SAS token (`sig`/`se`/`sp`/…) — so redacting only
 * `requestHeaders` would still ship a credential in a shared bundle.
 *
 * Matched case-insensitively, plus any `x-amz-*` parameter. Erring toward
 * redaction is deliberate for a share action: a stripped parameter leaves the
 * recipient re-entering their own key, while a missed one leaks yours. Every
 * other part of the URL is preserved, so the entry stays recognizable and
 * re-usable once the recipient supplies their credential.
 */
const EXPORT_REDACTED_URL_PARAMS = new Set([
  "access_token",
  "accesstoken",
  "api_key",
  "apikey",
  "key",
  "token",
  "subscription-key",
  "subscriptionkey",
  "signature",
  "sig",
  "se",
  "sp",
  "sv",
  "sr",
  "st",
  "skoid",
]);

/** True when a query-parameter name is treated as a credential on export. */
function isRedactedUrlParam(name: string): boolean {
  const lower = name.toLowerCase();
  return EXPORT_REDACTED_URL_PARAMS.has(lower) || lower.startsWith("x-amz-");
}

/**
 * Strip credential-bearing query parameters from a URL, leaving everything else
 * intact. A value that is not a parseable absolute URL (an XYZ template with
 * `{z}/{x}/{y}` placeholders parses fine; a relative path or a `pmtiles://`
 * form may not) is returned unchanged rather than mangled.
 */
function redactUrlCredentials(value: string): string {
  const separator = value.indexOf("?");
  if (separator === -1) return value;
  const [base, rawQuery] = [value.slice(0, separator), value.slice(separator + 1)];
  // Split by hand rather than through URL/URLSearchParams: those re-encode the
  // `{z}/{x}/{y}` placeholders a tile template depends on.
  const [query, fragment] = rawQuery.split("#", 2);
  const kept = query
    .split("&")
    .filter((pair) => pair !== "" && !isRedactedUrlParam(pair.split("=", 1)[0]));
  const rebuiltQuery = kept.length > 0 ? `?${kept.join("&")}` : "";
  return `${base}${rebuiltQuery}${fragment === undefined ? "" : `#${fragment}`}`;
}

/** Copy of an entry with per-user credentials removed from its source. */
function redactEntryForExport(entry: LayerLibraryEntry): LayerLibraryEntry {
  const source = { ...entry.source };
  let changed = false;
  for (const key of EXPORT_REDACTED_SOURCE_KEYS) {
    if (key in source) {
      delete source[key];
      changed = true;
    }
  }
  if (typeof source.url === "string") {
    const redacted = redactUrlCredentials(source.url);
    if (redacted !== source.url) {
      source.url = redacted;
      changed = true;
    }
  }
  const originalTiles: unknown[] | undefined = Array.isArray(source.tiles)
    ? source.tiles
    : undefined;
  if (originalTiles) {
    const tiles = originalTiles.map((tile) =>
      typeof tile === "string" ? redactUrlCredentials(tile) : tile,
    );
    if (tiles.some((tile, index) => tile !== originalTiles[index])) {
      source.tiles = tiles;
      changed = true;
    }
  }
  // `metadata.originalUrl` is the template a tile layer restores from, so it
  // carries the same credential as `source.tiles`.
  let metadata = entry.metadata;
  if (typeof metadata.originalUrl === "string") {
    const redacted = redactUrlCredentials(metadata.originalUrl);
    if (redacted !== metadata.originalUrl) {
      metadata = { ...metadata, originalUrl: redacted };
      changed = true;
    }
  }
  return changed ? { ...entry, source, metadata } : entry;
}

/**
 * Serialize Layer Library entries into the shareable bundle JSON written by the
 * Export action and read back by {@link parseLayerLibrary}. Per-user credentials
 * are redacted first (see {@link EXPORT_REDACTED_SOURCE_KEYS}).
 *
 * @param entries - The entries to export.
 * @returns Pretty-printed bundle JSON.
 */
export function serializeLayerLibrary(entries: LayerLibraryEntry[]): string {
  return JSON.stringify(
    {
      type: LAYER_LIBRARY_BUNDLE_TYPE,
      version: LAYER_LIBRARY_BUNDLE_VERSION,
      entries: entries.map(redactEntryForExport),
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
