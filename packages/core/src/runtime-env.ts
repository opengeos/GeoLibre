/**
 * Resolves runtime environment variables shared by the external-service clients
 * (geocoding, routing). Build-time Vite vars (`import.meta.env`) are overlaid
 * with project-supplied runtime vars (`window.__GEOLIBRE_RUNTIME_ENV__`, set
 * from project preferences) so a self-hosted endpoint can be configured without
 * a rebuild. Carries no React/MapLibre dependency so callers stay unit-testable.
 */

const buildEnv = (
  import.meta as ImportMeta & {
    env?: Record<string, string | undefined>;
  }
).env;

/**
 * Merges build-time env with project runtime env (the latter wins). Falls back
 * to build-time env alone outside a browser (e.g. in tests).
 *
 * @returns The resolved environment variables.
 */
export function getRuntimeEnvironment(): Record<string, string | undefined> {
  if (typeof window === "undefined") return buildEnv ?? {};

  // __GEOLIBRE_RUNTIME_ENV__ is declared globally in ./types.
  return {
    ...(buildEnv ?? {}),
    ...(window.__GEOLIBRE_RUNTIME_ENV__ ?? {}),
  };
}

/**
 * Resolves a local DuckDB spatial extension path from the runtime environment.
 *
 * When `VITE_DUCKDB_SPATIAL_EXTENSION_PATH` is set, DuckDB consumers (the
 * desktop app's own loader and the Add Vector panel's maplibre-gl-vector
 * control) load the spatial extension from this path with `LOAD '<path>'`
 * instead of installing it from the remote repository, which hangs in
 * sandboxed or firewalled environments. Lives in `@geolibre/core` so every
 * consumer shares one implementation.
 *
 * @param env - Environment record (defaults to the runtime environment);
 *   injectable for testing.
 * @returns The trimmed extension path, or undefined when unset.
 */
export function getSpatialExtensionPath(
  env?: Record<string, string | undefined>,
): string | undefined {
  const runtimeEnv = env ?? getRuntimeEnvironment();
  const trimmed = runtimeEnv.VITE_DUCKDB_SPATIAL_EXTENSION_PATH?.trim();
  return trimmed || undefined;
}

/**
 * Resolves the Protomaps API key from the runtime environment.
 *
 * Protomaps' hosted styles require an API key embedded in the style URL. The
 * key is supplied via `VITE_PROTOMAPS_API_KEY` (baked in at build time for the
 * web demo; see the deploy workflow). When unset, the Protomaps basemaps are
 * unavailable and should be hidden from the UI.
 *
 * @param env - Environment record (defaults to the runtime environment);
 *   injectable for testing.
 * @returns The trimmed API key, or undefined when unset.
 */
export function getProtomapsApiKey(
  env?: Record<string, string | undefined>,
): string | undefined {
  const runtimeEnv = env ?? getRuntimeEnvironment();
  const trimmed = runtimeEnv.VITE_PROTOMAPS_API_KEY?.trim();
  return trimmed || undefined;
}

/**
 * Builds a full Protomaps v5 style URL for a flavor, injecting the API key.
 *
 * @param flavor - The Protomaps flavor name (e.g. `light`, `dark`, `white`,
 *   `grayscale`, `black`).
 * @param env - Environment record (defaults to the runtime environment);
 *   injectable for testing.
 * @returns The resolved style URL, or undefined when no API key is configured.
 */
export function getProtomapsStyleUrl(
  flavor: string,
  env?: Record<string, string | undefined>,
): string | undefined {
  const key = getProtomapsApiKey(env);
  if (!key) return undefined;
  return `https://api.protomaps.com/styles/v5/${flavor}/en.json?key=${encodeURIComponent(
    key,
  )}`;
}
