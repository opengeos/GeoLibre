import type { FeatureCollection } from "geojson";
import { imageMimeFromName } from "./kml-overlays";

/**
 * Raw `<IconStyle><Icon><href>` of a placemark, set by `parseKmlText`. Import
 * metadata only: {@link resolveKmlFeatureIcons} always strips it.
 */
export const KML_ICON_HREF_PROPERTY = "__geolibre_kml_icon_href";

/**
 * The resolved icon as an inline raster `data:` URL, which the map package
 * registers as a per-feature `icon-image` (mirrors `@geolibre/map`'s constant).
 */
export const KML_ICON_URL_PROPERTY = "__geolibre_kml_icon_url";

/**
 * Remote icons are tiny (Google Earth's built-in set is a few KB each), so
 * anything larger is not a placemark icon and is skipped.
 */
const MAX_REMOTE_ICON_BYTES = 1024 * 1024;

/**
 * Distinct remote icons fetched per document. A real file uses a handful; a
 * document with thousands of unique icon URLs would otherwise issue thousands of
 * requests during import. Icons past the cap fall back to the plain marker.
 */
const MAX_REMOTE_ICONS = 64;

/** Bound each icon request so one unresponsive host cannot stall the import. */
const REMOTE_ICON_TIMEOUT_MS = 10_000;

/**
 * Resolves a non-remote icon href (e.g. a file packed inside a KMZ) to a raster
 * `data:` URL, or null when it cannot be resolved.
 */
export type KmlLocalIconResolver = (href: string) => Promise<string | null>;

/**
 * The URLs to try for a remote icon href, most preferred first, or null when
 * the href is not an `http(s)` URL.
 *
 * An `http:` href is tried over `https:` first: Google Earth writes its built-in
 * icons as `http://maps.google.com/mapfiles/kml/...`, which a page served over
 * HTTPS cannot fetch (mixed content), while the same host serves them over
 * HTTPS. The original `http:` URL stays as the fallback for hosts without TLS.
 *
 * @param href - The icon href as written in the KML.
 * @returns The candidate URLs, or null for a relative/archive href.
 */
export function remoteIconCandidates(href: string): string[] | null {
  const trimmed = href.trim();
  const absolute = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;
  let url: URL;
  try {
    url = new URL(absolute);
  } catch {
    return null;
  }
  if (url.protocol === "https:") return [url.href];
  if (url.protocol !== "http:") return null;
  const secure = new URL(url.href);
  secure.protocol = "https:";
  return [secure.href, url.href];
}

/** Content types that say nothing about the payload, so the extension decides. */
const GENERIC_CONTENT_TYPES = new Set(["application/octet-stream", "binary/octet-stream"]);

/**
 * The raster MIME type of a fetched icon. The response's `Content-Type` wins;
 * the URL's file extension is used only when the type is absent or generic, so
 * an error page served as `text/html` for a `.png` URL is rejected rather than
 * inlined as an image. Returns null for SVG and non-image responses, which the
 * marker loader cannot rasterize.
 */
function iconMime(contentType: string | null, url: string): string | null {
  const declared = contentType?.split(";")[0].trim().toLowerCase();
  const mime =
    !declared || GENERIC_CONTENT_TYPES.has(declared)
      ? imageMimeFromName(new URL(url).pathname)
      : declared;
  if (!mime.startsWith("image/") || mime === "image/svg+xml") return null;
  return mime;
}

/**
 * Read a response body, giving up as soon as it passes `limit` bytes so a host
 * that omits `Content-Length` cannot stream an unbounded body into memory.
 *
 * @returns The body bytes, or null when the body is larger than `limit`.
 */
async function readBodyWithinLimit(response: Response, limit: number): Promise<Uint8Array | null> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength > limit ? null : bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  // Chunked so a large icon cannot overflow the argument stack.
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/**
 * Download a remote KML icon and inline it as a raster `data:` URL, so the
 * layer renders it without depending on the host at draw time and a saved
 * project keeps its icons offline.
 *
 * @param href - An `http(s)` icon href.
 * @param fetchImpl - The fetch implementation (injectable for tests).
 * @returns The `data:` URL, or null when no candidate URL yields a raster image.
 */
export async function fetchRemoteIconDataUrl(
  href: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  for (const url of remoteIconCandidates(href) ?? []) {
    try {
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(REMOTE_ICON_TIMEOUT_MS),
      });
      if (!response.ok) continue;
      const mime = iconMime(response.headers.get("content-type"), url);
      if (!mime) continue;
      const contentLength = response.headers.get("content-length");
      if (contentLength !== null && Number(contentLength) > MAX_REMOTE_ICON_BYTES) continue;
      const bytes = await readBodyWithinLimit(response, MAX_REMOTE_ICON_BYTES);
      if (!bytes || bytes.byteLength === 0) continue;
      return `data:${mime};base64,${bytesToBase64(bytes)}`;
    } catch {
      // Network error, CORS refusal, or timeout: try the next candidate.
    }
  }
  return null;
}

/**
 * Resolves a remote `http(s)` icon href to a raster `data:` URL, or null.
 * Created per import by {@link createRemoteIconFetcher}.
 */
export type KmlRemoteIconFetcher = (href: string) => Promise<string | null>;

/**
 * Create a remote-icon fetcher for one import. Each distinct href is fetched
 * once, and at most {@link MAX_REMOTE_ICONS} distinct icons are fetched in
 * total. Share one fetcher across every KML entry of a KMZ so the cache and the
 * request budget cover the whole archive rather than resetting per entry.
 *
 * @param fetchImpl - The fetch implementation (injectable for tests).
 * @returns The fetcher.
 */
export function createRemoteIconFetcher(fetchImpl: typeof fetch = fetch): KmlRemoteIconFetcher {
  const resolved = new Map<string, Promise<string | null>>();
  let warned = false;
  return (href) => {
    const cached = resolved.get(href);
    if (cached) return cached;
    let promise: Promise<string | null>;
    if (resolved.size < MAX_REMOTE_ICONS) {
      promise = fetchRemoteIconDataUrl(href, fetchImpl);
    } else {
      if (!warned) {
        warned = true;
        console.warn(
          `[GeoLibre] The KML references more than ${MAX_REMOTE_ICONS} distinct remote icons; the rest use the plain marker.`,
        );
      }
      // Not cached, so the map stays bounded at MAX_REMOTE_ICONS entries.
      return Promise.resolve(null);
    }
    resolved.set(href, promise);
    return promise;
  };
}

/**
 * Replace each placemark's raw KML icon href with an inline raster URL the map
 * can draw, in place. Remote `http(s)` icons (including Google Earth's built-in
 * set) go to `fetchRemote`; any other href goes to `resolveLocal`, e.g. a file
 * packed inside a KMZ. Each distinct href is resolved once. An icon that cannot
 * be resolved leaves the feature on the plain marker.
 *
 * Never throws: a failed icon only loses that icon, not the import.
 *
 * @param collection - Features parsed by `parseKmlText`.
 * @param resolveLocal - Resolves a non-remote href; omit for a standalone KML,
 *   whose relative icon paths cannot be read.
 * @param fetchRemote - Resolves a remote href. Pass one shared fetcher for all
 *   the KML entries of an archive; defaults to a fresh one for this collection.
 * @returns The same collection, for chaining.
 */
export async function resolveKmlFeatureIcons(
  collection: FeatureCollection,
  resolveLocal?: KmlLocalIconResolver,
  fetchRemote: KmlRemoteIconFetcher = createRemoteIconFetcher(),
): Promise<FeatureCollection> {
  const local = new Map<string, Promise<string | null>>();
  const iconUrl = (href: string): Promise<string | null> => {
    if (remoteIconCandidates(href)) return fetchRemote(href).catch(() => null);
    if (!resolveLocal) return Promise.resolve(null);
    let promise = local.get(href);
    if (!promise) {
      promise = resolveLocal(href).catch(() => null);
      local.set(href, promise);
    }
    return promise;
  };

  await Promise.all(
    collection.features.map(async (feature) => {
      const properties = feature.properties;
      const href = properties?.[KML_ICON_HREF_PROPERTY];
      if (!properties || href === undefined) return;
      delete properties[KML_ICON_HREF_PROPERTY];
      if (typeof href !== "string" || !href.trim()) return;
      const url = await iconUrl(href);
      if (url) properties[KML_ICON_URL_PROPERTY] = url;
    }),
  );
  return collection;
}
