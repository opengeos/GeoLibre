import { readDeploymentEnvValue, type EnvRecord } from "./deployment-env";

export const CLERK_PUBLISHABLE_KEY_ENV = "VITE_GEOLIBRE_CLERK_PUBLISHABLE_KEY";

/**
 * Resolve the optional Clerk publishable key for a web deployment.
 *
 * A missing key keeps authentication completely disabled. Native and embedded
 * callers should pass `false` for `webApp` so a build-time environment variable
 * cannot accidentally gate an offline application. `webApp` must be derived from
 * the build target alone — a runtime signal the visitor controls (a query
 * parameter such as `?embed=1`) would let anyone switch the gate off.
 */
export function resolveClerkPublishableKey(
  webApp: boolean,
  deploymentEnv?: EnvRecord,
  buildEnv?: EnvRecord,
): string | undefined {
  if (!webApp) return undefined;
  return readDeploymentEnvValue(CLERK_PUBLISHABLE_KEY_ENV, deploymentEnv, buildEnv)?.trim();
}
