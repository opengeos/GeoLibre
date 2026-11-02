// Resolves the default project storage mode: "local" (default) or "server".
//
// A deployment setting `VITE_GEOLIBRE_PROJECT_STORAGE=server` (or
// `GEOLIBRE_PROJECT_STORAGE=server` in Docker) saves projects directly to the
// configured project sharing server instead of writing local files.

import { readDeploymentEnvValue, type EnvRecord } from "./deployment-env";
import { resolveShareHost } from "./share-geolibre";

export const PROJECT_STORAGE_ENV = "VITE_GEOLIBRE_PROJECT_STORAGE";

export type ProjectStorageMode = "local" | "server";

/**
 * Resolves the active project storage mode ("local" | "server").
 *
 * Returns "server" only if the configured value is "server" (case-insensitive)
 * and an explicit custom share host is configured (`shareHost.status === "configured"`).
 * Unset or default share hosts (e.g. public hosted share) return "local" to avoid
 * silently uploading projects to a public service.
 *
 * @param configured - The raw value; read from the env when omitted.
 * @param deploymentEnv - Runtime env override, for tests.
 * @param shareUrl - Share host override, for tests.
 * @returns The resolved project storage mode: "server" or "local".
 */
export function resolveProjectStorage(
  configured?: unknown,
  deploymentEnv?: EnvRecord,
  shareUrl?: unknown,
): ProjectStorageMode {
  const raw =
    configured !== undefined
      ? configured
      : readDeploymentEnvValue(PROJECT_STORAGE_ENV, deploymentEnv);
  if (typeof raw !== "string" || raw.trim().toLowerCase() !== "server") {
    return "local";
  }
  const shareHost = resolveShareHost(shareUrl, deploymentEnv);
  return shareHost.status === "configured" ? "server" : "local";
}
