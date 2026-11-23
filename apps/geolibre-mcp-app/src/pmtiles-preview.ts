import type { GeoLibreLayer } from "@geolibre/core";
import type { RangeResponse, Source } from "pmtiles";
import type { NetworkConsent } from "./network-consent";

const PMTILES_PREFIX = "pmtiles://";

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
  ) {}

  getKey(): string {
    return this.key;
  }

  async getBytes(offset: number, length: number, signal?: AbortSignal): Promise<RangeResponse> {
    const range = await this.fetchRange(this.url, offset, length, signal);
    return {
      data: range.data,
      cacheControl: range.cacheControl,
      expires: range.expires,
    };
  }
}
