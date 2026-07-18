import { parseProject, type GeoLibreProject } from "@geolibre/core";
import { normalizeProjectUrl } from "./urls";

// Query parameters that carry a `.geolibre.json` project URL deep link. A bare
// `?https://...` query (no key) is also accepted by `projectUrlFromLocation`.
export const PROJECT_URL_PARAMS = ["url", "project", "projectUrl", "project_url"];

/**
 * Reads a `.geolibre.json` project URL from the current `window.location` query
 * string, if one is present.
 *
 * Accepts any of {@link PROJECT_URL_PARAMS} or a bare `?https://...` query, and
 * normalizes the value via `normalizeProjectUrl` (absolute http/https only).
 *
 * @returns The normalized project URL, or `null` when none is present or valid.
 */
export function projectUrlFromLocation(): string | null {
  if (typeof window === "undefined") return null;

  const search = window.location.search;
  const params = new URLSearchParams(search);
  for (const key of PROJECT_URL_PARAMS) {
    const value = params.get(key);
    const url = normalizeProjectUrl(value);
    if (url) return url;
  }

  const bareQuery = search.startsWith("?") ? safeDecodeURIComponent(search.slice(1)).trim() : "";
  return /^https?:\/\//i.test(bareQuery) ? normalizeProjectUrl(bareQuery) : null;
}

/**
 * Fetches and parses a `.geolibre.json` project from a URL, turning every
 * failure mode into a message that names the URL and the likely cause.
 *
 * A bare `fetch` rejects with an unhelpful `TypeError` ("Failed to fetch" in
 * Chromium, "Load failed" in Safari) on a network or CORS failure, and
 * `parseProject` throws a raw `SyntaxError` on malformed JSON. Both would
 * otherwise reach the UI verbatim, leaving the user with no idea what went
 * wrong (see issue #734). This wrapper distinguishes the three failure modes
 * so the caller can surface actionable feedback.
 *
 * @param projectUrl - Absolute http(s) URL to a serialized project.
 * @param options - `signal` aborts the request; `fetchImpl` is injected for
 *   testing and defaults to the global `fetch`.
 * @returns The parsed project.
 * @throws {Error} With a descriptive message on a network/CORS failure, a
 *   non-2xx response, or an unparseable/invalid project body. A
 *   caller-initiated abort propagates as the original `AbortError`.
 */
export async function fetchProjectFromUrl(
  projectUrl: string,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<GeoLibreProject> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = options.signal;

  // Shared message for any rejection that means the bytes never arrived: the
  // initial request or the body stream. A bare browser TypeError ("Failed to
  // fetch" / "Load failed") is replaced with the URL and the likely causes,
  // while the original error is preserved as `cause` so the stack survives in
  // DevTools and error-monitoring tools.
  const networkError = (cause: unknown) =>
    new Error(
      `Could not fetch the project from ${projectUrl}. The host may be ` +
        "unreachable or offline, or it may be blocking cross-origin requests " +
        "(CORS). Check the URL and your connection, then try again.",
      { cause },
    );

  // A caller-initiated abort (dialog close / unmount) surfaces as an
  // `AbortError`; let it propagate untouched so the caller can ignore it,
  // matching the abort handling in `share-geolibre.ts`.
  const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

  let response: Response;
  try {
    response = await fetchImpl(projectUrl, {
      headers: { Accept: "application/json, text/plain;q=0.9, */*;q=0.8" },
      signal,
    });
  } catch (error) {
    if (isAbort(error)) throw error;
    throw networkError(error);
  }

  if (!response.ok) {
    // HTTP/2 drops reason phrases, so `statusText` is often empty; only append
    // it when present to avoid a stray "HTTP 404 ." with a dangling period.
    const status = response.statusText
      ? `HTTP ${response.status} ${response.statusText}`
      : `HTTP ${response.status}`;
    throw new Error(
      `Could not fetch the project from ${projectUrl}: the server responded ` + `with ${status}.`,
    );
  }

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    // The connection can still drop while the body is streaming, even after a
    // 200; that rejects with the same opaque TypeError, so treat it the same.
    if (isAbort(error)) throw error;
    throw networkError(error);
  }

  try {
    return parseProject(text);
  } catch (error) {
    // The fetch succeeded but the body is not a usable project: malformed JSON
    // or a file missing the required GeoLibre fields. Name the URL and the
    // underlying reason rather than leaking a bare JSON.parse SyntaxError. Strip
    // parseProject's own "Invalid GeoLibre project:" prefix so the wrapper does
    // not repeat the noun it already states, but fall back to the full message
    // if stripping would leave nothing (so the colon never dangles).
    const raw = error instanceof Error ? error.message : String(error);
    const detail = raw.replace(/^Invalid GeoLibre project:\s*/i, "") || raw;
    throw new Error(
      `The file at ${projectUrl} is not a valid GeoLibre project ` + `(.geolibre.json): ${detail}`,
      { cause: error },
    );
  }
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
