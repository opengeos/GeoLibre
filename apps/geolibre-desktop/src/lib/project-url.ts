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

  const bareQuery = search.startsWith("?")
    ? safeDecodeURIComponent(search.slice(1)).trim()
    : "";
  return /^https?:\/\//i.test(bareQuery)
    ? normalizeProjectUrl(bareQuery)
    : null;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
