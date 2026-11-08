// Whether this deployment offers the regional basemaps (Amap and Tencent,
// served from mainland China), and the store policy that follows from it.
//
// The switch is `basemaps.regional: false` in deployment.json, or
// `GEOLIBRE_DISABLE_REGIONAL_BASEMAPS=1` on Docker, which the entrypoint
// publishes as `VITE_GEOLIBRE_DISABLE_REGIONAL_BASEMAPS` in the runtime config.
// A build can bake the same `VITE_*` value in. The policy outranks both, the
// usual order (see deployment-env.ts).

import { useAppStore, type RegionalBasemapPolicy } from "@geolibre/core";
import { readDeploymentEnvValue, type EnvRecord } from "./deployment-env";

/** The `VITE_*` variable that disables the regional basemaps. */
export const DISABLE_REGIONAL_BASEMAPS_ENV = "VITE_GEOLIBRE_DISABLE_REGIONAL_BASEMAPS";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

/**
 * Whether the deployment disabled the regional basemaps.
 *
 * @param deploymentEnv - Runtime env (with the policy overlaid); defaults to the
 *   value on `window`.
 * @param buildEnv - Build-time env; defaults to the allowlisted build env.
 * @returns True when the first non-blank value is `1`, `true`, `yes` or `on`.
 */
export function regionalBasemapsDisabled(deploymentEnv?: EnvRecord, buildEnv?: EnvRecord): boolean {
  // Undefined arguments fall through to readDeploymentEnvValue's defaults.
  const value = readDeploymentEnvValue(DISABLE_REGIONAL_BASEMAPS_ENV, deploymentEnv, buildEnv);
  return value !== undefined && TRUE_VALUES.has(value.trim().toLowerCase());
}

/**
 * The store policy for regional basemaps that a loaded project names: blocked
 * when the deployment disabled them, otherwise confirmed by the user first.
 *
 * @param disabled - Whether the deployment disabled regional basemaps.
 * @returns `"block"` or `"prompt"`.
 */
export function resolveRegionalBasemapPolicy(
  disabled: boolean = regionalBasemapsDisabled(),
): RegionalBasemapPolicy {
  return disabled ? "block" : "prompt";
}

/**
 * Install the regional-basemap policy in the store. Called once at startup,
 * after deployment.json is applied and before the first project can load.
 */
export function installRegionalBasemapPolicy(): void {
  useAppStore.getState().setRegionalBasemapPolicy(resolveRegionalBasemapPolicy());
}

/**
 * React hook: whether the UI should offer the regional basemaps.
 *
 * @returns False when the deployment disabled them.
 */
export function useRegionalBasemapsEnabled(): boolean {
  return useAppStore((s) => s.regionalBasemapPolicy !== "block");
}
