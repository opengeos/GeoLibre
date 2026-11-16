// Resilient download of the PostGIS extension bundle for the CDN PGlite loader.
//
// `@electric-sql/pglite-postgis` resolves its ~20 MB `postgis.tar.gz` relative to
// its own module URL, so loading the module from jsDelivr makes PGlite fetch the
// tarball from jsDelivr too. That is unreliable for this one file: on a cache
// miss jsDelivr takes 40-55 s before the first byte, and some of its edges give
// up first (Fastly answers 503 after ~60 s), which surfaces in the SQL workspace
// as `extension "postgis" is not available` (issue #3472). unpkg serves the same
// version-pinned file from the npm tarball with a 1-3 s cold start, so try it
// first and fall back to jsDelivr. Both send `Access-Control-Allow-Origin: *`,
// and a plain fetch is governed by connect-src (any `https:` in both CSPs), so
// no CSP change is needed.

/** jsDelivr's npm tree, the prefix of every PGlite CDN URL vite.config.ts injects. */
const JSDELIVR_NPM = "https://cdn.jsdelivr.net/npm/";
/** unpkg serves the same npm package paths without the `/npm/` segment. */
const UNPKG = "https://unpkg.com/";

/** File name the PostGIS extension resolves next to its module. */
export const POSTGIS_BUNDLE_FILE = "postgis.tar.gz";

/**
 * Wait this long for a mirror's response headers before trying the next one.
 * A healthy mirror answers in a few seconds even on a cold cache; jsDelivr's
 * slow cache-miss path is what this cuts short. The last mirror gets no limit,
 * so a slow-but-working download still completes.
 */
export const POSTGIS_MIRROR_HEADER_TIMEOUT_MS = 15_000;

/**
 * Candidate URLs for the PostGIS bundle, most reliable first.
 *
 * @param postgisModuleUrl The jsDelivr URL of the `@electric-sql/pglite-postgis`
 *   ES module (the injected `__PGLITE_POSTGIS_CDN_URL__`).
 * @returns The unpkg mirror (when the module URL is a jsDelivr npm URL) followed
 *   by the URL PGlite would have used on its own.
 */
export function postgisBundleUrls(postgisModuleUrl: string): string[] {
  const original = new URL(`./${POSTGIS_BUNDLE_FILE}`, postgisModuleUrl).href;
  if (!original.startsWith(JSDELIVR_NPM)) return [original];
  return [UNPKG + original.slice(JSDELIVR_NPM.length), original];
}

/**
 * Download the first mirror that answers with a 2xx response.
 *
 * Each mirror but the last must deliver its response headers, and then every
 * body chunk, within `headerTimeoutMs` of the previous one; a slow but moving
 * download is never cut short, and the last mirror has no limit.
 *
 * @param urls Mirrors to try in order.
 * @param fetchImpl The fetch implementation (injectable for tests).
 * @param headerTimeoutMs Header deadline for every mirror except the last.
 * @param expectedSha256 Hex SHA-256 the bundle must match; a mirror serving
 *   other bytes counts as failed. Null skips the check.
 * @returns The downloaded bundle.
 * @throws An error naming every mirror's failure when none succeeds.
 */
export async function fetchFromMirrors(
  urls: readonly string[],
  fetchImpl: typeof fetch = fetch,
  headerTimeoutMs: number = POSTGIS_MIRROR_HEADER_TIMEOUT_MS,
  expectedSha256: string | null = null,
): Promise<Blob> {
  const failures: string[] = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const isLast = i === urls.length - 1;
    const controller = new AbortController();
    // For every mirror but the last, abort when nothing arrives for
    // `headerTimeoutMs`: first the response headers, then each body chunk, so
    // a mirror that stalls mid-download also falls through to the next one.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (isLast) return;
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), headerTimeoutMs);
    };
    arm();
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      if (!response.ok) {
        failures.push(`${url}: HTTP ${response.status}`);
        continue;
      }
      arm(); // a fresh deadline for the first body chunk
      const blob = await readBody(response, arm);
      if (expectedSha256) {
        const actual = await sha256Hex(blob);
        if (actual === null) {
          console.warn(
            "[GeoLibre] Web Crypto is unavailable; the PostGIS bundle was not checked against its SHA-256.",
          );
        } else if (actual !== expectedSha256.toLowerCase()) {
          failures.push(`${url}: SHA-256 mismatch`);
          continue;
        }
      }
      return blob;
    } catch (err) {
      const reason = controller.signal.aborted
        ? `no data for ${Math.round(headerTimeoutMs / 1000)} s`
        : err instanceof Error
          ? err.message
          : String(err);
      failures.push(`${url}: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Could not download the PostGIS extension bundle (${failures.join("; ")}).`);
}

/**
 * Read a response body, calling `onProgress` after each chunk (to re-arm the
 * stall timer).
 *
 * @param response The response to read.
 * @param onProgress Called once per received chunk.
 * @returns The body as a blob.
 */
async function readBody(response: Response, onProgress: () => void): Promise<Blob> {
  const reader = response.body?.getReader();
  if (!reader) return response.blob();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    onProgress();
  }
  return new Blob(chunks as BlobPart[]);
}

/**
 * Hex SHA-256 of a blob, or null where Web Crypto is unavailable (a non-secure
 * context), in which case the caller skips the integrity check.
 *
 * @param blob The bytes to hash.
 * @returns The lower-case hex digest, or null.
 */
async function sha256Hex(blob: Blob): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const digest = new Uint8Array(await subtle.digest("SHA-256", await blob.arrayBuffer()));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Downloaded bundle `blob:` URLs, keyed by mirror list, shared across wrappers
 * so a retried PGlite start does not download another ~20 MB copy.
 */
const bundleUrls = new Map<string, Promise<string>>();

/** The slice of a PGlite extension the wrapper relies on. */
interface PgliteExtensionLike {
  name: string;
  setup: (...args: unknown[]) => Promise<Record<string, unknown> & { bundlePath?: URL }>;
}

/**
 * Wrap the PostGIS extension so its bundle is downloaded from the mirror list
 * and handed to PGlite as a `blob:` URL instead of the module-relative jsDelivr
 * URL it would otherwise fetch.
 *
 * The bundle is checked against the SHA-256 of the installed package's copy
 * (injected at build time), so neither mirror is trusted on its own. The check
 * needs Web Crypto, which browsers only expose in secure contexts (https,
 * localhost, the desktop app); on a plain-http LAN origin it is skipped with a
 * console warning rather than turning PostGIS off. The
 * `blob:` URL is created once per page for a mirror list: a retried PGlite
 * start (which reloads the modules and builds a new wrapper) reuses it
 * instead of downloading and holding another ~20 MB.
 *
 * @param postgis The `postgis` export of `@electric-sql/pglite-postgis`.
 * @param urls Mirrors for the bundle, from {@link postgisBundleUrls}.
 * @param fetchImpl The fetch implementation (injectable for tests).
 * @param expectedSha256 Hex SHA-256 of the bundle, or null to skip the check.
 * @returns An extension with the same name whose setup swaps `bundlePath`.
 */
export function withMirroredPostgisBundle(
  postgis: unknown,
  urls: readonly string[],
  fetchImpl: typeof fetch = fetch,
  expectedSha256: string | null = null,
): unknown {
  const ext = postgis as PgliteExtensionLike;
  if (!ext || typeof ext.setup !== "function") return postgis;
  const key = urls.join("\n");
  return {
    ...ext,
    setup: async (...args: unknown[]) => {
      const result = await ext.setup(...args);
      if (!result?.bundlePath) return result;
      let bundleUrl = bundleUrls.get(key);
      bundleUrl ??= fetchFromMirrors(
        urls,
        fetchImpl,
        POSTGIS_MIRROR_HEADER_TIMEOUT_MS,
        expectedSha256,
      ).then(
        // PGlite fetches this URL while it starts and the extension API has no
        // hook after that read, so the URL lives as long as the wrapper.
        (blob) => URL.createObjectURL(blob),
        (err: unknown) => {
          bundleUrls.delete(key); // let a later start retry the download
          throw err;
        },
      );
      bundleUrls.set(key, bundleUrl);
      return { ...result, bundlePath: new URL(await bundleUrl) };
    },
  };
}
