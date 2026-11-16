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
 * Each mirror but the last must deliver its response headers within
 * `headerTimeoutMs`; once headers arrive the body is read with no time limit.
 *
 * @param urls Mirrors to try in order.
 * @param fetchImpl The fetch implementation (injectable for tests).
 * @param headerTimeoutMs Header deadline for every mirror except the last.
 * @returns The downloaded bundle.
 * @throws An error naming every mirror's failure when none succeeds.
 */
export async function fetchFromMirrors(
  urls: readonly string[],
  fetchImpl: typeof fetch = fetch,
  headerTimeoutMs: number = POSTGIS_MIRROR_HEADER_TIMEOUT_MS,
): Promise<Blob> {
  const failures: string[] = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const isLast = i === urls.length - 1;
    const controller = new AbortController();
    const timer = isLast ? undefined : setTimeout(() => controller.abort(), headerTimeoutMs);
    try {
      let response: Response;
      try {
        response = await fetchImpl(url, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) {
        failures.push(`${url}: HTTP ${response.status}`);
        continue;
      }
      return await response.blob();
    } catch (err) {
      const reason = controller.signal.aborted
        ? `no response within ${Math.round(headerTimeoutMs / 1000)} s`
        : err instanceof Error
          ? err.message
          : String(err);
      failures.push(`${url}: ${reason}`);
    }
  }
  throw new Error(`Could not download the PostGIS extension bundle (${failures.join("; ")}).`);
}

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
 * @param postgis The `postgis` export of `@electric-sql/pglite-postgis`.
 * @param urls Mirrors for the bundle, from {@link postgisBundleUrls}.
 * @param fetchImpl The fetch implementation (injectable for tests).
 * @returns An extension with the same name whose setup swaps `bundlePath`.
 */
export function withMirroredPostgisBundle(
  postgis: unknown,
  urls: readonly string[],
  fetchImpl: typeof fetch = fetch,
): unknown {
  const ext = postgis as PgliteExtensionLike;
  if (!ext || typeof ext.setup !== "function") return postgis;
  return {
    ...ext,
    setup: async (...args: unknown[]) => {
      const result = await ext.setup(...args);
      if (!result?.bundlePath) return result;
      const blob = await fetchFromMirrors(urls, fetchImpl);
      // PGlite fetches this URL once while it starts. The extension API has no
      // hook that runs after that read, so the URL is not revoked; PGlite is a
      // page-lifetime singleton (pglite-workspace.ts), so this is one blob.
      return { ...result, bundlePath: new URL(URL.createObjectURL(blob)) };
    },
  };
}
