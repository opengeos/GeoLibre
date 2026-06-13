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
