/**
 * Shared consent gate for the reverse-geocode tool.
 *
 * Reverse geocoding sends the coordinates of each clicked point to a public
 * geocoder, so the user must acknowledge a one-time privacy notice before it is
 * enabled. The acknowledgment is a persisted per-device flag, checked from
 * every activation path (the toolbar toggle and restoring a project that has
 * the plugin marked active) so coordinates are never sent without consent.
 */
export const REVERSE_GEOCODE_CONSENT_KEY = "geolibre:reverse-geocode-nominatim-notice";

/** Whether the user has acknowledged the reverse-geocode privacy notice. */
export function hasReverseGeocodeConsent(): boolean {
  try {
    return localStorage.getItem(REVERSE_GEOCODE_CONSENT_KEY) === "1";
  } catch {
    // localStorage unavailable (private mode): treat as not acknowledged so the
    // notice is shown rather than silently sending coordinates.
    return false;
  }
}

/** Record that the user acknowledged the reverse-geocode privacy notice. */
export function recordReverseGeocodeConsent(): void {
  try {
    localStorage.setItem(REVERSE_GEOCODE_CONSENT_KEY, "1");
  } catch {
    // Ignore: the notice will simply show again next time.
  }
}
