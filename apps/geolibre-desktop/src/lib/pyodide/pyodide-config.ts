// Pyodide is loaded from the official jsDelivr CDN at runtime (the multi-MB
// runtime + wheels are fetched lazily on first use, never bundled). The CDN
// asset version MUST match the loader the worker pulls, so the version is
// pinned here and used to build the default indexURL.
//
// As of Pyodide 0.27.x, geopandas/shapely/pyproj (with PROJ data) ship in the
// distribution, so a single loadPackage("geopandas") pulls the whole graph.
import { getRuntimeEnvironment } from "@geolibre/core";

export const PYODIDE_VERSION = "0.27.7";

const DEFAULT_INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

/**
 * Resolve the Pyodide indexURL (where pyodide.js, the wasm runtime, the
 * lockfile, and package wheels are served from).
 *
 * Defaults to the pinned jsDelivr CDN. Set `VITE_PYODIDE_INDEX_URL` to a
 * self-hosted or mirrored copy for offline/air-gapped deployments; a trailing
 * slash is added if missing.
 *
 * Args:
 *   env: Environment record to read from (defaults to `import.meta.env`).
 *
 * Returns:
 *   The indexURL string, guaranteed to end with a slash.
 */
export function getPyodideIndexUrl(
  env: Record<string, string | undefined> = getRuntimeEnvironment(),
): string {
  const override = env.VITE_PYODIDE_INDEX_URL?.trim();
  const url = override || DEFAULT_INDEX_URL;
  return url.endsWith("/") ? url : `${url}/`;
}

/**
 * Whether `indexURL` is the built-in jsDelivr CDN default (rather than a custom
 * `VITE_PYODIDE_INDEX_URL` mirror).
 *
 * The default CDN origin is whitelisted in the app's `script-src` CSP, so
 * consumers can take Pyodide's normal load path for it and reserve the
 * fetch-then-blob workaround for non-whitelisted mirrors.
 *
 * Args:
 *   indexURL: A resolved indexURL, e.g. from `getPyodideIndexUrl()`.
 *
 * Returns:
 *   True when `indexURL` is the default CDN URL.
 */
export function isDefaultPyodideIndexUrl(indexURL: string): boolean {
  return indexURL === DEFAULT_INDEX_URL;
}
