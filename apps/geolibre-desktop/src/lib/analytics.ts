// Optional Google Analytics (GA4) for the *hosted web builds* only.
//
// The tracker is off unless a measurement ID is configured at build time, so
// the desktop app, the Jupyter embed wheel, the Docker image, and every local
// or fork build ship without it. See resolveAnalyticsId for why that gate is
// a build fact rather than a runtime one. Only opengeos' own Pages deploys
// (geolibre.app/demo/ and web.geolibre.app) pass the variable, and the privacy
// policy documents that (docs/privacy.md).
//
// Deliberately not wired into `docker/entrypoint.sh`: the container serves a
// CSP whose script-src does not allow googletagmanager.com, so a runtime value
// would be published into geolibre-runtime-config.js and then silently blocked
// by the browser. Reading through readDeploymentEnvValue keeps the usual
// precedence if that ever changes.

import { readDeploymentEnvValue, type EnvRecord } from "./deployment-env";

export const GA_MEASUREMENT_ID_ENV = "VITE_GEOLIBRE_GA_MEASUREMENT_ID";

/** id of the injected <script>, used to keep installation idempotent. */
const GA_SCRIPT_ID = "geolibre-google-analytics";

// GA4 measurement IDs are "G-" plus an uppercase alphanumeric stream token
// (10 characters today, but the length is not contractual). Validated because
// the value is interpolated into a script URL: anything that is not this shape
// is a paste error, and refusing it beats loading a tag that reports nowhere.
const MEASUREMENT_ID_PATTERN = /^G-[A-Z0-9]{4,24}$/;

/** The globals gtag.js expects to find already present. */
interface AnalyticsWindow {
  dataLayer?: unknown[];
}

/**
 * Resolve the Google Analytics measurement ID for a hosted web deployment.
 *
 * A missing or malformed ID leaves analytics completely disabled.
 *
 * @param webApp - Whether this is the hosted web build. Must be derived from
 *   the build target alone, exactly as `resolveAuthGate` requires: a runtime
 *   signal the visitor controls (`?embed=1`) must not decide whether a
 *   deployment's analytics run, and the desktop/embed builds must never load a
 *   tracker even if a stray variable was present when they were compiled.
 * @param deploymentEnv - Runtime env; defaults to the value on `window`.
 * @param buildEnv - Build-time env; defaults to `import.meta.env`.
 * @returns The normalized `G-…` measurement ID, or undefined when unset.
 */
export function resolveAnalyticsId(
  webApp: boolean,
  deploymentEnv?: EnvRecord,
  buildEnv?: EnvRecord,
): string | undefined {
  if (!webApp) return undefined;
  const value = readDeploymentEnvValue(GA_MEASUREMENT_ID_ENV, deploymentEnv, buildEnv)?.trim();
  if (!value) return undefined;
  // Measurement IDs are issued uppercase; accept a lowercased paste rather than
  // rejecting a value that is otherwise exactly right.
  const id = value.toUpperCase();
  if (!MEASUREMENT_ID_PATTERN.test(id)) {
    console.error(
      `[GeoLibre] Ignoring ${GA_MEASUREMENT_ID_ENV}: ${value} is not a GA4 measurement ID (G-…).`,
    );
    return undefined;
  }
  return id;
}

/**
 * Load gtag.js and configure it for one measurement ID.
 *
 * This is the standard Google tag snippet, written out so the bundle carries no
 * analytics dependency: seed `dataLayer`, queue the `js`/`config` calls, then
 * append the remote script, which drains the queue once it loads. Safe to call
 * more than once: a second call with the tag already present is a no-op, so
 * React StrictMode's double-invoke and dev HMR do not stack tags.
 *
 * @param id - A validated measurement ID from {@link resolveAnalyticsId}.
 * @param doc - Document to install into; defaults to the ambient one.
 */
export function installAnalytics(id: string, doc: Document = document): void {
  if (doc.getElementById(GA_SCRIPT_ID)) return;
  const view = (doc.defaultView ?? globalThis) as AnalyticsWindow;
  const dataLayer = (view.dataLayer ??= []);
  // gtag.js replays each queued entry as an `arguments` object rather than an
  // array, so this stays a function declaration (an arrow function has none)
  // and pushes `arguments` instead of its rest parameters.
  function gtag(_command: string, ..._args: unknown[]): void {
    // eslint-disable-next-line prefer-rest-params
    dataLayer.push(arguments);
  }
  gtag("js", new Date());
  gtag("config", id);

  const script = doc.createElement("script");
  script.id = GA_SCRIPT_ID;
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
  (doc.head ?? doc.documentElement).appendChild(script);
}

/**
 * Install analytics when this deployment has configured a measurement ID.
 *
 * The single entry point called at startup; arguments carry the same meaning as
 * in {@link resolveAnalyticsId}.
 *
 * @returns The measurement ID that was installed, or undefined when analytics
 *   are off, which is the normal case for every build but the hosted ones.
 */
export function startAnalytics(
  webApp: boolean,
  deploymentEnv?: EnvRecord,
  buildEnv?: EnvRecord,
): string | undefined {
  const id = resolveAnalyticsId(webApp, deploymentEnv, buildEnv);
  if (!id) return undefined;
  installAnalytics(id);
  return id;
}
