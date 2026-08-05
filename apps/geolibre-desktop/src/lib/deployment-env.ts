// Reads the deployment env the Docker entrypoint injects at container startup.
//
// `docker/entrypoint.sh` rewrites `geolibre-runtime-config.js` on every boot,
// setting `window.__GEOLIBRE_DEPLOYMENT_ENV__` to a JSON object of
// `VITE_*`-keyed values. `index.html` pulls that script in before the bundle, so
// the values are on `window` by the time any module reads them. This is how an
// operator repoints a *prebuilt* image with `-e GEOLIBRE_…=…` instead of
// rebuilding it.
//
// Precedence for anything configurable both ways is deployment env first, then
// the build-time Vite env — the deployment is the more specific statement, and
// the published image is built with the defaults. `readDeploymentAssistantEnv`
// and `readEmbedOrigins` established that order; this module is the shared
// implementation for the settings that are a single URL.

/** A `VITE_*`-keyed env record, from either the build or the deployment. */
export type EnvRecord = Record<string, string | undefined> | undefined;

/** The deployment env on `window`, or undefined outside a browser. */
export function readDeploymentEnv(): EnvRecord {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { __GEOLIBRE_DEPLOYMENT_ENV__?: EnvRecord })
    .__GEOLIBRE_DEPLOYMENT_ENV__;
}

/**
 * Read one `VITE_*` variable, preferring the deployment env over the build env.
 *
 * @param key - The variable name, e.g. `VITE_GEOLIBRE_SHARE_URL`.
 * @param deploymentEnv - Runtime env; defaults to the value on `window`.
 * @param buildEnv - Build-time env; defaults to `import.meta.env`.
 * @returns The first non-blank value found, or undefined when neither sets it.
 */
export function readDeploymentEnvValue(
  key: string,
  deploymentEnv: EnvRecord = readDeploymentEnv(),
  buildEnv: EnvRecord = import.meta.env as EnvRecord,
): string | undefined {
  for (const source of [deploymentEnv, buildEnv]) {
    const value = source?.[key];
    // Treat a blank string as unset: the entrypoint omits a key it has no value
    // for, but a hand-written config or a `-e VAR=` can still produce "".
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}
