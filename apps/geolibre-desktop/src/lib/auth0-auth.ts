import { readDeploymentEnvValue, type EnvRecord } from "./deployment-env";

export const AUTH0_DOMAIN_ENV = "VITE_GEOLIBRE_AUTH0_DOMAIN";

export const AUTH0_CLIENT_ID_ENV = "VITE_GEOLIBRE_AUTH0_CLIENT_ID";

/** The two public values an Auth0 single-page application needs in the browser. */
export interface Auth0Config {
  /** Tenant (or custom) domain, as a bare hostname: `example.us.auth0.com`. */
  domain: string;
  /** The Auth0 application's client ID, which is public by design. */
  clientId: string;
}

/**
 * Normalize an operator-supplied Auth0 domain to a bare hostname.
 *
 * Auth0's dashboard shows the domain without a scheme, but `https://…` (with or
 * without a trailing slash) is the natural thing to paste, and the SDK builds
 * its authorize/token URLs by string concatenation — a scheme left in place
 * yields `https://https://…` and a redirect that fails with no useful error.
 *
 * @param value - The raw environment value, or undefined when unset.
 * @returns The lowercase hostname, or undefined when unset or malformed.
 */
function normalizeDomain(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  // Drop the scheme and anything from the first path separator onward, so both
  // `https://tenant.us.auth0.com/` and `tenant.us.auth0.com` land on the host.
  const host = trimmed
    .replace(/^https?:\/\//i, "")
    .split("/")[0]
    .toLowerCase();
  // A hostname only: the charset rejects a port, credentials, or a query, any
  // of which would silently produce an unreachable Auth0 endpoint. Requiring a
  // dot rejects a bare label such as `localhost`, which is never a tenant.
  if (!/^[a-z0-9.-]+$/.test(host) || !host.includes(".")) return undefined;
  return host;
}

/**
 * Validate an Auth0 client ID.
 *
 * Auth0 issues base62 identifiers, so anything outside that charset is a paste
 * error (a whole URL, a JSON fragment, a quoted value) rather than a client ID.
 *
 * @param value - The raw environment value, or undefined when unset.
 * @returns The trimmed client ID, or undefined when unset or malformed.
 */
function normalizeClientId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !/^[A-Za-z0-9_-]+$/.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Resolve the optional Auth0 configuration for a web deployment.
 *
 * Both values are required, so a partial configuration keeps authentication
 * disabled rather than initializing an SDK that cannot complete a login. That
 * case is also loud: the Docker entrypoint refuses to boot on a half
 * configuration, so reaching it here means a build-time env was set that way.
 *
 * Native and embedded callers should pass `false` for `webApp` so a build-time
 * environment variable cannot accidentally gate an offline application.
 * `webApp` must be derived from the build target alone — a runtime signal the
 * visitor controls (a query parameter such as `?embed=1`) would let anyone
 * switch the gate off.
 *
 * @param webApp - Whether this is the hosted web build.
 * @param deploymentEnv - Runtime env; defaults to the value on `window`.
 * @param buildEnv - Build-time env; defaults to `import.meta.env`.
 * @returns The domain and client ID, or undefined when the gate is off.
 */
export function resolveAuth0Config(
  webApp: boolean,
  deploymentEnv?: EnvRecord,
  buildEnv?: EnvRecord,
): Auth0Config | undefined {
  if (!webApp) return undefined;
  const rawDomain = readDeploymentEnvValue(AUTH0_DOMAIN_ENV, deploymentEnv, buildEnv);
  const rawClientId = readDeploymentEnvValue(AUTH0_CLIENT_ID_ENV, deploymentEnv, buildEnv);
  const domain = normalizeDomain(rawDomain);
  const clientId = normalizeClientId(rawClientId);
  if (!domain || !clientId) {
    // Only complain when something was configured: an unset gate is the normal
    // case for every public deployment and must stay silent. Tested on the raw
    // values, not the normalized ones — two malformed values normalize to
    // undefined, and reading those would turn the loudest misconfiguration
    // (nothing usable at all) into the one that says nothing.
    if (rawDomain || rawClientId) {
      console.error(
        `[GeoLibre] Ignoring an incomplete Auth0 configuration: ${AUTH0_DOMAIN_ENV} and ` +
          `${AUTH0_CLIENT_ID_ENV} must both be set to valid values. The sign-in gate is OFF.`,
      );
    }
    return undefined;
  }
  return { domain, clientId };
}
