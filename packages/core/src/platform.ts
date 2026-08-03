/**
 * Platform detection shared across the workspace. Carries no React/MapLibre
 * dependency so callers stay unit-testable.
 */

/**
 * Whether a "Macintosh" user agent is really an iPad.
 *
 * iPadOS 13+ requests desktop sites by default and reports a macOS user agent,
 * so the UA string alone cannot tell an iPad from a Mac. Multi-touch does: a
 * real Mac reports `maxTouchPoints` 0 or 1, an iPad reports more.
 *
 * This lives in `@geolibre/core` because two packages need it and the rule is
 * an Apple behaviour that could change: the desktop app's `isMobile` (which
 * hides sidecar-backed tools on mobile) and `@geolibre/plugins`'
 * `isEarthEngineAvailable` (which hides Earth Engine sign-in on the Apple App
 * Store builds). Keeping one copy means a future correction lands in both.
 *
 * @param userAgent - The user agent string to test.
 * @param maxTouchPoints - `navigator.maxTouchPoints`, or undefined where the
 *   runtime does not provide it (Node exposes a `navigator` without it).
 * @returns True when the UA claims macOS but the device reports multi-touch.
 */
export function isIpadDesktopUserAgent(
  userAgent: string,
  maxTouchPoints: number | undefined,
): boolean {
  return /Macintosh/.test(userAgent) && (maxTouchPoints ?? 0) > 1;
}
