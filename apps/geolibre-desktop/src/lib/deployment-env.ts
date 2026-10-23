// Reads the deployment env the Docker entrypoint injects at container startup.
//
// `docker/entrypoint.sh` rewrites `geolibre-runtime-config.js` on every boot,
// setting `window.__GEOLIBRE_DEPLOYMENT_ENV__` to a JSON object of
// `VITE_*`-keyed values. `index.html` pulls that script in before the bundle, so
// the values are on `window` by the time any module reads them. This is how an
// operator repoints a *prebuilt* image with `-e GEOLIBRE_…=…` instead of
// rebuilding it.
//
// One exception to the `VITE_*` rule: the entrypoint also writes the bare
// `GEOLIBRE_NASA_OPERA_NEWS_PROXY_ENDPOINT`, whose reader is a plugin loaded from
// outside this repo and so is not bound by our naming. It is published alongside
// the `VITE_*` aliases this module reads, not instead of them, so nothing here
// needs to handle it.
//
// Precedence for anything configurable is `deployment.json` (the active policy,
// issue #2783), then this deployment env, then the build-time Vite env — each is
// a more specific statement than the next, and the published image is built with
// the defaults. The policy is folded in as an overlay on the deployment env, so
// every reader that goes through `readDeploymentEnv` honours it.

import { getBuildEnvironment } from "@geolibre/core";
import type { DeploymentPolicy } from "./deployment-policy";

/** A `VITE_*`-keyed env record, from either the build or the deployment. */
export type EnvRecord = Record<string, string | undefined> | undefined;

let activePolicy: DeploymentPolicy | null = null;
let policyOverlay: Record<string, string> = {};

/**
 * The `VITE_*` keys a policy contributes to the deployment env. A key appears
 * only when its source field is present; fields a string cannot express
 * ("unset", empty list) are read from the policy directly by their consumers.
 */
export function policyEnvOverlay(policy: DeploymentPolicy | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!policy) return out;
  if (policy.sharing?.shareUrl !== undefined) out.VITE_GEOLIBRE_SHARE_URL = policy.sharing.shareUrl;
  if (policy.sharing?.collabUrl !== undefined) {
    out.VITE_GEOLIBRE_COLLAB_URL = policy.sharing.collabUrl;
  }
  if (policy.geolens?.url !== undefined) out.VITE_GEOLENS_DEFAULT_URL = policy.geolens.url;
  if (policy.branding?.appName !== undefined) out.VITE_GEOLIBRE_APP_NAME = policy.branding.appName;
  if (policy.services?.catalog !== undefined) {
    out.VITE_GEOLIBRE_SERVICES = JSON.stringify({
      services: policy.services.catalog,
    });
  }
  if (policy.services?.builtins !== undefined) {
    out.VITE_GEOLIBRE_BUILTIN_SERVICES = policy.services.builtins ? "on" : "off";
  }
  if (policy.ai?.enabled === true) out.VITE_GEOLIBRE_AI_URL = "/ai";
  return out;
}

/** The active deployment policy, or null when none was loaded. */
export function getDeploymentPolicy(): DeploymentPolicy | null {
  return activePolicy;
}

/** Install (or with null, clear) the active deployment policy. */
export function setDeploymentPolicy(policy: DeploymentPolicy | null): void {
  activePolicy = policy;
  policyOverlay = policyEnvOverlay(policy);
}

/** The deployment env on `window` with the policy overlaid; undefined if neither exists. */
export function readDeploymentEnv(): EnvRecord {
  const windowEnv =
    typeof window === "undefined"
      ? undefined
      : (window as unknown as { __GEOLIBRE_DEPLOYMENT_ENV__?: EnvRecord })
          .__GEOLIBRE_DEPLOYMENT_ENV__;
  if (Object.keys(policyOverlay).length === 0) return windowEnv;
  return { ...windowEnv, ...policyOverlay };
}

/**
 * Read one `VITE_*` variable, preferring the deployment env over the build env.
 *
 * @param key - The variable name, e.g. `VITE_GEOLIBRE_SHARE_URL`.
 * @param deploymentEnv - Runtime env; defaults to the value on `window`.
 * @param buildEnv - Build-time env; defaults to the allowlisted build env.
 * @returns The first non-blank value found, or undefined when neither sets it.
 */
export function readDeploymentEnvValue(
  key: string,
  deploymentEnv: EnvRecord = readDeploymentEnv(),
  buildEnv: EnvRecord = getBuildEnvironment() as EnvRecord,
): string | undefined {
  for (const source of [deploymentEnv, buildEnv]) {
    const value = source?.[key];
    // Treat a blank string as unset: the entrypoint omits a key it has no value
    // for, but a hand-written config or a `-e VAR=` can still produce "".
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}
