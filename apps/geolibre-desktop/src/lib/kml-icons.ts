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

/**
 * The raster MIME type of a fetched icon, preferring the response's
 * `Content-Type` and falling back to the URL's file extension. Returns null for
 * SVG and non-image responses, which the marker loader cannot rasterize.
 */
function iconMime(contentType: string | null, url: string): string | null {
  const declared = contentType?.split(";")[0].trim().toLowerCase();
  const mime = declared?.startsWith("image/") ? declared : imageMimeFromName(new URL(url).pathname);
  if (!mime.startsWith("image/") || mime === "image/svg+xml") return null;
  return mime;
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
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_REMOTE_ICON_BYTES) continue;
      return `data:${mime};base64,${bytesToBase64(bytes)}`;
    } catch {
      // Network error, CORS refusal, or timeout: try the next candidate.
    }
  }
  return null;
}

/**
 * Replace each placemark's raw KML icon href with an inline raster URL the map
 * can draw, in place. Remote `http(s)` icons (including Google Earth's built-in
 * set) are downloaded; any other href goes to `resolveLocal`, e.g. a file
 * packed inside a KMZ. Each distinct href is resolved once. An icon that cannot
 * be resolved leaves the feature on the plain marker.
 *
 * Never throws: a failed icon only loses that icon, not the import.
 *
 * @param collection - Features parsed by `parseKmlText`.
 * @param resolveLocal - Resolves a non-remote href; omit for a standalone KML,
 *   whose relative icon paths cannot be read.
 * @param fetchImpl - The fetch implementation (injectable for tests).
 * @returns The same collection, for chaining.
 */
export async function resolveKmlFeatureIcons(
  collection: FeatureCollection,
  resolveLocal?: KmlLocalIconResolver,
  fetchImpl: typeof fetch = fetch,
): Promise<FeatureCollection> {
  const resolved = new Map<string, Promise<string | null>>();
  let remoteCount = 0;
  const iconUrl = (href: string): Promise<string | null> => {
    const cached = resolved.get(href);
    if (cached) return cached;
    let promise: Promise<string | null>;
    if (remoteIconCandidates(href)) {
      remoteCount += 1;
      promise =
        remoteCount <= MAX_REMOTE_ICONS
          ? fetchRemoteIconDataUrl(href, fetchImpl)
          : Promise.resolve(null);
    } else {
      promise = resolveLocal ? resolveLocal(href).catch(() => null) : Promise.resolve(null);
    }
    resolved.set(href, promise);
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
  if (remoteCount > MAX_REMOTE_ICONS) {
    console.warn(
      `[GeoLibre] The KML references ${remoteCount} distinct remote icons; only the first ${MAX_REMOTE_ICONS} were loaded.`,
    );
  }
  return collection;
}
