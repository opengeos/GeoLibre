/**
 * Shared consent gate for the Network analysis tools.
 *
 * Isochrones and OD cost matrices send the coordinates of the input points to a
 * public Valhalla routing server, so the user must acknowledge a one-time
 * privacy notice before the tools open. The acknowledgment is a persisted
 * per-device flag, checked from every activation path (each Network menu item)
 * so coordinates are never sent without consent. Mirrors the directions and
 * reverse-geocode consent gates.
 */
export const ROUTING_CONSENT_KEY = "geolibre:network-routing-valhalla-notice";

/** Whether the user has acknowledged the network-routing privacy notice. */
export function hasRoutingConsent(): boolean {
  try {
    return localStorage.getItem(ROUTING_CONSENT_KEY) === "1";
  } catch {
    // localStorage unavailable (private mode): treat as not acknowledged so the
    // notice is shown rather than silently sending coordinates.
    return false;
  }
}

/** Record that the user acknowledged the network-routing privacy notice. */
export function recordRoutingConsent(): void {
  try {
    localStorage.setItem(ROUTING_CONSENT_KEY, "1");
  } catch {
    // Ignore: the notice will simply show again next time.
  }
}
