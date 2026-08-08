/**
 * De-duplication for Add Vector Layer's remote downloads.
 *
 * A multi-layer container (a KMZ of KML folders, a GeoPackage of tables, a DXF)
 * becomes one store layer per source layer, but every one of them keeps the
 * *container's* URL. Restoring such a project replays each layer independently,
 * and auto-refresh ticks them independently too, so a six-layer KMZ issued six
 * concurrent downloads of the same archive on every project open and on every
 * refresh interval (opengeos/GeoLibre discussion #1757). On a slow origin that
 * is enough to blow the fetch budget and fail layers that would have loaded had
 * they asked once.
 *
 * `dedupeVectorUrlFetch` collapses those into a single in-flight request per
 * URL. Two properties matter:
 *
 * - **In-flight only.** The entry is dropped as soon as the download settles, so
 *   this is a request collapser and never a cache: a later auto-refresh always
 *   re-downloads and genuinely refreshes the layer. Sibling layers of one
 *   container share a download only because they ask within the same window.
 * - **One identity.** Every caller gets the *same* `File` object, not a copy.
 *   maplibre-gl-vector keys its per-source caches (the unzipped KML it
 *   registers with DuckDB, a GeoPackage's bytes) on the source object, so
 *   handing all six layers one identical `File` collapses the unzip and the
 *   DuckDB registration too: a 91 MB KML is registered once instead of six
 *   times. Returning a `Blob` would not: the control wraps a plain `Blob` in a
 *   fresh `File` per call, and the caches would miss again.
 */

/**
 * In-flight downloads keyed by URL. Entries live only until they settle.
 *
 * The value is a wrapper rather than the bare promise so the download's own
 * `finally` can identify (and clear) exactly its own entry while still running
 * *inside* the promise. A `.finally()` chained onto the outside would resolve a
 * tick after awaiting callers, leaving a settled entry briefly visible and
 * letting an immediate retry share an already-finished download.
 */
interface InFlightEntry {
  promise: Promise<File | null>;
}

const inFlight = new Map<string, InFlightEntry>();

/**
 * Runs `download` for `url`, sharing the request with any call for the same URL
 * that is still in flight.
 *
 * @param url - The absolute URL being downloaded.
 * @param download - Performs the actual download. Called at most once per
 *   in-flight window; returns null when no loader could serve the URL.
 * @returns The downloaded file (the identical object for every sharer), or null.
 */
export function dedupeVectorUrlFetch(
  url: string,
  download: () => Promise<File | null>,
): Promise<File | null> {
  const existing = inFlight.get(url);
  if (existing) return existing.promise;

  const entry = {} as InFlightEntry;
  entry.promise = (async () => {
    try {
      return await download();
    } finally {
      // Cleared either way: a failure must not be replayed to a later refresh,
      // and a success must not be served as a stale cache hit. Only our own
      // entry is cleared, since a retry that started later owns the key.
      if (inFlight.get(url) === entry) inFlight.delete(url);
    }
  })();
  inFlight.set(url, entry);
  return entry.promise;
}

/**
 * Names a downloaded blob so the vector control's format detection still works.
 *
 * The control derives the format from the file name, so the URL's last path
 * segment is used when it has an extension; otherwise the blob is handed over
 * under a generic name and the control falls back to sniffing the content type.
 *
 * @param url - The URL the bytes came from.
 * @param fallback - Name to use when the URL carries no usable file name.
 * @returns A file name for the downloaded bytes.
 */
export function vectorDownloadFileName(url: string, fallback = "data"): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return fallback;
  }
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  const decoded = safeDecode(last);
  return /\.[A-Za-z0-9]+$/.test(decoded) ? decoded : fallback;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Clears every in-flight entry. Exported for tests. */
export function resetVectorUrlFetchDedupe(): void {
  inFlight.clear();
}

/**
 * Phrases the native fetch command rejects a URL with, mirroring
 * `url_is_fetchable` / `ensure_fetchable_url` in `src-tauri/src/lib.rs`
 * (`SSRF_BLOCKED_MESSAGE` and its siblings). The Rust strings cannot be imported
 * across the process boundary, so re-check this list when that guard's messages
 * change; a phrase that drifts fails open into the browser fallback rather than
 * breaking the build.
 *
 * "Refusing to fetch" covers more than the pre-request check: the guarded
 * redirect policy and `GuardedDnsResolver` reject mid-request, and both are
 * normalised back to `SSRF_BLOCKED_MESSAGE` by `request_error_message` on the
 * Rust side precisely so they land on this list. Without that normalisation a
 * URL that passes the initial check and *then* redirects to (or re-resolves to)
 * a blocked address surfaces as a generic transport failure, and the fallback
 * below follows it with none of the guard's protections.
 */
const URL_POLICY_REJECTIONS = [
  "Refusing to fetch",
  "Unsupported URL scheme",
  "Invalid URL",
  "URL has no host",
];

/**
 * True when the native fetch failed because the URL is one the backend refuses
 * to reach (a link-local, unspecified, or multicast address, or a non-HTTP
 * scheme) rather than because the request itself went wrong.
 *
 * The browser fallback exists for transport failures the native client cannot
 * handle, but the webview is not subject to the Rust SSRF guard, so falling back
 * on a policy rejection would let a crafted project reach exactly the addresses
 * the guard blocked. Those failures are re-thrown instead.
 *
 * @param error - The rejection from the native command.
 * @returns Whether the URL was refused by policy.
 */
export function isBlockedUrlError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  return URL_POLICY_REJECTIONS.some((phrase) => message.includes(phrase));
}
