import { PROJECT_URL_PARAMS, projectUrlFromLocation } from "./project-url";

// Values of `?welcome=` that turn the first-launch wizard off.
const WELCOME_DISABLED_VALUES = new Set(["0", "false", "off", "no"]);

// Values of `?embed=` that mark the app as running inside an embedding host
// (the Jupyter widget, the `to_html()` export, and the in-app "Export as
// Interactive HTML" iframe). Mirrors the embed detection in embedHost.ts.
const EMBED_ENABLED_VALUES = new Set(["1", "true"]);

/**
 * Whether to suppress the first-launch onboarding wizard because the app is
 * opened as an embed/deep link, where the modal would just cover the map:
 *   - a project deep link (e.g. web.geolibre.app `?url=`) opens straight
 *     into a shared project,
 *   - an embed (`?embed=1`/`true`) frames the app as a map to view, not to
 *     configure, so the recipient of an exported HTML page lands straight on
 *     the map instead of an experience-level chooser (issue #991), or
 *   - an explicit `?welcome=0` (also `false`/`off`/`no`) opts out, for embeds
 *     that don't load a project URL but still want a clean first paint.
 *
 * @returns True when the onboarding wizard should not be shown.
 */
export function shouldSuppressOnboarding(): boolean {
  return (
    hasProjectDeepLinkIntent() || embeddedByParam() || welcomeDisabledByParam()
  );
}

/**
 * Whether the URL signals an intent to open a project deep link. A recognized
 * project-URL param key (`?url=`, `?project=`, ...) counts even when its value
 * fails to resolve, so the onboarding modal never layers on top of the load
 * error `useProjectUrlLoader` shows for a bad link; otherwise a valid bare
 * `?https://...` project URL also counts.
 *
 * @returns True when a project deep link was requested.
 */
function hasProjectDeepLinkIntent(): boolean {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  if (PROJECT_URL_PARAMS.some((key) => params.has(key))) return true;
  return projectUrlFromLocation() !== null;
}

/**
 * Whether the URL marks the app as embedded via `?embed=1` (also `true`). Embed
 * pages frame the map for viewing, so the experience-level chooser never applies
 * to them; suppressing it lets an exported standalone HTML file open straight on
 * the map for the recipient.
 *
 * @returns True when a truthy `embed` query parameter is present.
 */
function embeddedByParam(): boolean {
  if (typeof window === "undefined") return false;
  const value = new URLSearchParams(window.location.search).get("embed");
  // Match embedHost.ts's isEmbedded() exactly (no trim/case-folding) so a value
  // that suppresses onboarding here also activates the postMessage bridge there.
  return value !== null && EMBED_ENABLED_VALUES.has(value);
}

/**
 * Whether the URL explicitly opts out of the first-launch onboarding wizard via
 * `?welcome=0` (also `false`, `off`, or `no`). Lets an embed suppress the modal
 * without depending on a `?url=` project deep link.
 *
 * @returns True when a falsy `welcome` query parameter is present.
 */
function welcomeDisabledByParam(): boolean {
  if (typeof window === "undefined") return false;
  const value = new URLSearchParams(window.location.search).get("welcome");
  return (
    value !== null && WELCOME_DISABLED_VALUES.has(value.trim().toLowerCase())
  );
}
