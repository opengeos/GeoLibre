import { readDeploymentEnvValue, type EnvRecord } from "./deployment-env";

export const CLERK_PUBLISHABLE_KEY_ENV = "VITE_GEOLIBRE_CLERK_PUBLISHABLE_KEY";

export const CLERK_WAITLIST_ENV = "VITE_GEOLIBRE_CLERK_WAITLIST";

// Values that turn the waitlist screen on, matching the "1"/"true" convention
// of the other opt-in deployment envs (see onboarding-suppression.ts).
const WAITLIST_ENABLED_VALUES = new Set(["1", "true"]);

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

/**
 * Whether the sign-in gate should also offer Clerk's waitlist form.
 *
 * Opt-in, and only meaningful alongside a publishable key: the gate renders the
 * waitlist screen only when the deployment asks for it *and* the Clerk instance
 * is in waitlist sign-up mode, so an operator running invite-only ("restricted")
 * access never shows visitors a form that implies self-service access.
 *
 * `webApp` carries the same meaning as in {@link resolveClerkPublishableKey} —
 * a build-time fact, never a runtime signal the visitor controls.
 */
export function resolveClerkWaitlistEnabled(
  webApp: boolean,
  deploymentEnv?: EnvRecord,
  buildEnv?: EnvRecord,
): boolean {
  if (!webApp) return false;
  const value = readDeploymentEnvValue(CLERK_WAITLIST_ENV, deploymentEnv, buildEnv);
  return WAITLIST_ENABLED_VALUES.has(value?.trim().toLowerCase() ?? "");
}
