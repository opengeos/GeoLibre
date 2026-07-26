/**
 * Shared JSON fetch for the OGC API clients (Tiles, Features).
 *
 * An OGC API service is browsed by walking its JSON documents (landing page,
 * `/collections`, TileJSON, `/items`), and those hosts frequently send no CORS
 * headers. This module centralizes the three ways GeoLibre can reach them:
 *
 * - **Desktop (Tauri):** the Rust `fetch_url_bytes` command, which is not
 *   subject to browser CORS, so any service works.
 * - **Dev server (Vite):** the same-origin dev proxy.
 * - **Hosted web build:** a direct fetch, which only succeeds when the service
 *   sends `Access-Control-Allow-Origin`.
 */

import { isTauri } from "./is-tauri";

/**
 * Dev-server CORS proxy path. The proxy is a generic pass-through; the
 * `GPX_PROXY_PATH` name it is bound under in vite.config.ts is historical.
 */
const OGC_PROXY_PATH = "/__geolibre_gpx_proxy";

/** Default deadline for a single request when the caller supplies no signal. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * A promise that never resolves and rejects when the signal aborts, with its
 * abort reason. Used to race an uncancellable Tauri invoke against the caller's
 * abort and a timeout.
 */
export function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/**
 * Converts opaque fetch/abort failures into a clear, user-facing Error so the
 * Add Data dialogs surface the real cause instead of a generic fallback.
 */
export function normalizeFetchError(error: unknown): Error {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return new Error("The request timed out.");
  }
  // A CORS/network rejection surfaces as a bare TypeError with no status.
  if (error instanceof TypeError) {
    return new Error(
      "Could not reach the service. It may not allow cross-origin requests from the browser; try the desktop app.",
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Builds the error for a non-2xx response. OGC APIs answer a bad request with a
 * JSON problem document (`{ code, description }` or RFC 7807 `{ title, detail }`),
 * which names the actual problem (an unsupported `limit`, an unknown collection);
 * surface it alongside the status instead of the status alone. Only a JSON body
 * is read, and only a short prefix of it, so an HTML error page or an oversized
 * payload cannot end up rendered into the dialog.
 */
async function responseStatusError(response: Response): Promise<Error> {
  const status = `Request failed with status ${response.status}`;
  try {
    if (!/\bjson\b/i.test(response.headers.get("content-type") ?? "")) {
      return new Error(status);
    }
    const body = (await response.json()) as Record<string, unknown>;
    const detail = [body?.description, body?.detail, body?.title].find(
      (value): value is string => typeof value === "string" && value.trim() !== "",
    );
    return detail ? new Error(`${status}: ${detail.trim().slice(0, 300)}`) : new Error(status);
  } catch {
    return new Error(status);
  }
}

/**
 * Fetches and parses a remote JSON document, working around cross-origin limits
 * (see the module comment). When the caller passes a `signal` it owns the
 * deadline (callers that issue several requests share one across them);
 * otherwise a {@link REQUEST_TIMEOUT_MS} timeout is applied so an unresponsive
 * endpoint cannot hang forever.
 *
 * @param url - The absolute document URL.
 * @param options - An optional abort signal and a diagnostics context label.
 * @returns The parsed JSON document.
 */
export async function fetchOgcJson(
  url: string,
  options: { signal?: AbortSignal; context?: string } = {},
): Promise<unknown> {
  const abort = options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  if (isTauri()) {
    // `fetch_url_bytes` cannot be cancelled mid-flight, so race it against the
    // abort/timeout to still return promptly on a slow or hung host.
    const { fetchUrlBytes } = await import("./native-http");
    const bytesPromise = fetchUrlBytes(url, { context: options.context ?? "OGC API" });
    // If the abort/timeout wins the race, the invoke promise is left unobserved;
    // swallow a later rejection so it does not surface as an unhandled rejection.
    bytesPromise.catch(() => {});
    try {
      const bytes = await Promise.race([bytesPromise, rejectOnAbort(abort)]);
      const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      return JSON.parse(new TextDecoder().decode(array));
    } catch (error) {
      throw normalizeFetchError(error);
    }
  }
  const isDev = Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV);
  const fetchUrl = isDev ? `${OGC_PROXY_PATH}?url=${encodeURIComponent(url)}` : url;
  let response: Response;
  try {
    response = await fetch(fetchUrl, { signal: abort });
  } catch (error) {
    throw normalizeFetchError(error);
  }
  if (!response.ok) {
    throw await responseStatusError(response);
  }
  return response.json();
}
