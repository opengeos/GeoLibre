// Deployment-configurable application name.
//
// A self-hosted deployment can rebrand the name shown at the start of the top
// toolbar (and the browser tab title) with `GEOLIBRE_APP_NAME` at container
// startup, or `VITE_GEOLIBRE_APP_NAME` at build time. Unset keeps the product
// name. Carries no React dependency so it stays unit-testable.

import { readDeploymentEnvValue, type EnvRecord } from "./deployment-env";

/** The `VITE_*` key the deployment and build envs carry the name under. */
export const APP_NAME_ENV_KEY = "VITE_GEOLIBRE_APP_NAME";

/**
 * Longest name kept. The toolbar label shares one row with every menu, so an
 * unbounded value would push the menus off-screen.
 */
export const APP_NAME_MAX_LENGTH = 60;

/**
 * The operator-configured app name, or undefined when none is set.
 *
 * Runs of whitespace (including newlines) collapse to one space, and the result
 * is capped at {@link APP_NAME_MAX_LENGTH} characters.
 *
 * @param deploymentEnv - Runtime env; defaults to the value on `window`.
 * @param buildEnv - Build-time env; defaults to the allowlisted build env.
 * @returns The configured name, or undefined when unset or blank.
 */
export function readConfiguredAppName(
  deploymentEnv?: EnvRecord,
  buildEnv?: EnvRecord,
): string | undefined {
  // Passing undefined through leaves readDeploymentEnvValue's defaults in play.
  const raw = readDeploymentEnvValue(APP_NAME_ENV_KEY, deploymentEnv, buildEnv);
  const name = raw?.replace(/\s+/g, " ").trim();
  if (!name) return undefined;
  // Slice by code point so a cap never splits a surrogate pair (emoji, CJK ext).
  return Array.from(name).slice(0, APP_NAME_MAX_LENGTH).join("").trim();
}

/**
 * The name to display: the configured one, else the given product default.
 *
 * @param defaultName - The product name for this platform.
 * @param deploymentEnv - Runtime env; defaults to the value on `window`.
 * @param buildEnv - Build-time env; defaults to the allowlisted build env.
 * @returns The name to show in the app chrome.
 */
export function resolveAppName(
  defaultName: string,
  deploymentEnv?: EnvRecord,
  buildEnv?: EnvRecord,
): string {
  return readConfiguredAppName(deploymentEnv, buildEnv) ?? defaultName;
}
