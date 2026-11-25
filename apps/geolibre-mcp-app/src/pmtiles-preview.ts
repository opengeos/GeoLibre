import type { GeoLibreLayer } from "@geolibre/core";
import { Compression, TileType, type PMTiles, type RangeResponse, type Source } from "pmtiles";
import type { NetworkConsent } from "./network-consent";
import { pmtilesNativeLayerIds } from "@geolibre/map/pmtiles-layer";
import { previewI18n } from "./preview-i18n";

const PMTILES_PREFIX = "pmtiles://";
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 65_536;
export const MAX_PMTILES_RANGE_BYTES = 4 * 1024 * 1024;
export const MAX_PMTILES_BLOCK_BYTES = 16 * 1024 * 1024;
export const MAX_PMTILES_SOURCE_LAYERS = 128;
const t = previewI18n.getFixedT(null, "translation", "mcpPreview.pmtiles");

function remoteHttpUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const bare = value.startsWith(PMTILES_PREFIX) ? value.slice(PMTILES_PREFIX.length) : value;
  try {
    const url = new URL(bare);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/**
 * The public archive a saved PMTiles layer reads, without the `pmtiles://`
 * prefix, or null for an archive the preview cannot reach (an in-memory
 * extract, a local file).
 */
export function pmtilesArchiveUrl(layer: GeoLibreLayer): string | null {
  if (layer.type !== "pmtiles") return null;
  const source = layer.source as Record<string, unknown> | undefined;
  return remoteHttpUrl(source?.url) ?? remoteHttpUrl(layer.sourcePath);
}

/**
 * The key the shared `pmtiles://` protocol looks the archive up under: the
 * layer's own URL with the prefix removed, which is what layer sync passes on.
 */
export function pmtilesArchiveKey(layer: GeoLibreLayer): string | null {
  if (!pmtilesArchiveUrl(layer)) return null;
  const source = layer.source as Record<string, unknown> | undefined;
  const raw = typeof source?.url === "string" && source.url ? source.url : layer.sourcePath;
  if (typeof raw !== "string") return null;
  return raw.startsWith(PMTILES_PREFIX) ? raw.slice(PMTILES_PREFIX.length) : raw;
}

/** A layer the preview draws through its consent-gated PMTiles source. */
export function isPreviewPMTilesLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "pmtiles" &&
    layer.metadata?.sourceKind === "pmtiles-url" &&
    layer.metadata?.externalNativeLayer === true &&
    pmtilesArchiveUrl(layer) !== null
  );
}

/** URL-only vectors need the archive's own source-layer names before layer sync. */
export function needsPMTilesDiscovery(layer: GeoLibreLayer): boolean {
  return isPreviewPMTilesLayer(layer) && previewPMTilesStyleLayerIds(layer).length === 0;
}

/** Discover archive facts through the already registered consent-backed reader. */
export async function discoverPreviewPMTilesLayer(
  layer: GeoLibreLayer,
  archive: Pick<PMTiles, "getHeader" | "getMetadata">,
  signal: AbortSignal,
): Promise<GeoLibreLayer> {
  signal.throwIfAborted();
  const header = await archive.getHeader();
  signal.throwIfAborted();
  if (
    ![Compression.None, Compression.Unknown, Compression.Gzip].includes(header.tileCompression) ||
    (header.tileCompression === Compression.Gzip && typeof DecompressionStream === "undefined")
  )
    throw new Error(t("unsupportedCompression"));
  const vector = header.tileType === TileType.Mvt || header.tileType === TileType.Mlt;
  if (
    !vector &&
    ![TileType.Png, TileType.Jpeg, TileType.Webp, TileType.Avif].includes(header.tileType)
  )
    throw new Error(t("unsupportedTiles"));
  const kind = vector ? "vector" : "raster";
  const names: string[] = [];
  if (vector) {
    if (header.jsonMetadataLength > MAX_METADATA_BYTES) throw new Error(t("metadataTooLarge"));
    if (header.jsonMetadataLength === 0) throw new Error(t("missingLayers"));
    const metadata = await archive.getMetadata();
    signal.throwIfAborted();
    const items =
      metadata && typeof metadata === "object" && "vector_layers" in metadata
        ? metadata.vector_layers
        : undefined;
    if (!Array.isArray(items) || items.length === 0) throw new Error(t("missingLayers"));
    if (items.length > MAX_PMTILES_SOURCE_LAYERS) throw new Error(t("tooManyLayers"));
    for (const item of items) {
      const id = item && typeof item === "object" && "id" in item ? item.id : undefined;
      if (typeof id !== "string" || !id || id.length > 256) throw new Error(t("invalidLayer"));
      if (!names.includes(id)) names.push(id);
    }
  }
  const sourceId =
    (typeof layer.metadata?.sourceId === "string" && layer.metadata.sourceId) ||
    (typeof layer.source.sourceId === "string" && layer.source.sourceId) ||
    layer.id;
  const nativeLayerIds = pmtilesNativeLayerIds(sourceId, kind, names);
  if (new Set(nativeLayerIds).size !== nativeLayerIds.length)
    throw new Error(t("conflictingLayers"));
  return {
    ...layer,
    source: {
      ...layer.source,
      type: kind,
      sourceId,
      sourceLayers: names,
      tileType: kind,
      ...(vector ? { encoding: header.tileType === TileType.Mlt ? "mlt" : "mvt" } : {}),
    },
    metadata: {
      ...layer.metadata,
      sourceId,
      sourceLayers: names,
      tileType: kind,
      nativeLayerIds,
    },
  };
}

/** Bound decompression of metadata, directories, and tiles before allocating their output. */
export async function decompressPreviewPMTiles(
  buffer: ArrayBuffer,
  compression: Compression,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  signal?.throwIfAborted();
  if (buffer.byteLength > MAX_PMTILES_BLOCK_BYTES) throw new Error(t("blockTooLarge"));
  if (compression === Compression.None || compression === Compression.Unknown) return buffer;
  if (compression !== Compression.Gzip || typeof DecompressionStream === "undefined")
    throw new Error(t("unsupportedCompression"));
  const reader = new Response(buffer)
    .body!.pipeThrough(new DecompressionStream("gzip"))
    .getReader();
  const abort = (): void => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      signal?.throwIfAborted();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_PMTILES_BLOCK_BYTES) throw new Error(t("blockTooLarge"));
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output.buffer;
}

/** Validate directory work before the PMTiles cache expands it into entry objects. */
export async function decompressPreviewPMTilesDirectory(
  buffer: ArrayBuffer,
  compression: Compression,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const decoded = await decompressPreviewPMTiles(buffer, compression, signal);
  const bytes = new Uint8Array(decoded);
  let cursor = 0;
  const readVarint = (): number => {
    let value = 0;
    let factor = 1;
    for (let index = 0; index < 8; index++) {
      if (cursor >= bytes.length) throw new Error(t("invalidDirectory"));
      const byte = bytes[cursor++];
      value += (byte & 127) * factor;
      if (!Number.isSafeInteger(value)) throw new Error(t("invalidDirectory"));
      if (byte < 128) return value;
      factor *= 128;
    }
    throw new Error(t("invalidDirectory"));
  };
  const count = readVarint();
  if (count > MAX_DIRECTORY_ENTRIES) throw new Error(t("directoryTooLarge"));
  // Every entry has four varints, each at least one byte. Do not let an
  // attacker-controlled count send the library beyond this decoded block.
  if (count > Math.floor((bytes.length - cursor) / 4)) throw new Error(t("invalidDirectory"));
  for (let index = 0; index < count * 4; index++) readVarint();
  signal?.throwIfAborted();
  return decoded;
}

/** Style IDs created by layer sync, including Python archives with placeholder saved IDs. */
export function previewPMTilesStyleLayerIds(layer: GeoLibreLayer): string[] {
  if (layer.type !== "pmtiles") return [];
  const sourceId =
    typeof layer.metadata?.sourceId === "string"
      ? layer.metadata.sourceId
      : typeof layer.source.sourceId === "string"
        ? layer.source.sourceId
        : layer.id;
  const raw = layer.source.sourceLayers ?? layer.metadata.sourceLayers;
  const names = Array.isArray(raw)
    ? raw.filter((s): s is string => typeof s === "string" && s.length > 0)
    : [];
  const kind =
    layer.metadata.tileType === "raster" || layer.source.type === "raster" ? "raster" : "vector";
  return pmtilesNativeLayerIds(sourceId, kind, names);
}

/**
 * Whether a MapLibre request names one of the archives this preview
 * registered: the TileJSON (`pmtiles://<key>`) or one of its tiles
 * (`pmtiles://<key>/<z>/<x>/<y>`). Anything else under the scheme would make
 * the shared protocol open a direct `FetchSource`, bypassing consent.
 */
export function isRegisteredPMTilesRequest(url: string, keys: ReadonlySet<string>): boolean {
  if (!url.startsWith(PMTILES_PREFIX)) return false;
  const rest = url.slice(PMTILES_PREFIX.length);
  if (keys.has(rest)) return true;
  const tile = rest.match(/^(.+)\/\d+\/\d+\/\d+$/);
  return tile !== null && keys.has(tile[1]);
}

/** A PMTiles byte source that reads every range through preview network consent. */
export class ConsentPMTilesSource implements Source {
  constructor(
    private readonly key: string,
    private readonly url: string,
    private readonly fetchRange: NetworkConsent["fetchRange"],
    private readonly lifecycle?: AbortSignal,
  ) {}

  getKey(): string {
    return this.key;
  }

  async getBytes(offset: number, length: number, signal?: AbortSignal): Promise<RangeResponse> {
    const effective =
      this.lifecycle && signal
        ? AbortSignal.any([this.lifecycle, signal])
        : (this.lifecycle ?? signal);
    effective?.throwIfAborted();
    if (length > MAX_PMTILES_RANGE_BYTES) throw new Error(t("blockTooLarge"));
    const range = await this.fetchRange(this.url, offset, length, effective);
    effective?.throwIfAborted();
    return {
      data: range.data,
      cacheControl: range.cacheControl,
      expires: range.expires,
    };
  }
}
