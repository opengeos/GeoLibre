/**
 * Consent gate for the status bar's remote elevation lookups.
 *
 * With 3D terrain enabled the elevation readout is resolved from DEM tiles the
 * map has already fetched, so it costs nothing and leaves no data. Without
 * terrain it falls back to the public Open-Meteo elevation API, which means the
 * pointer's coordinates leave the device.
 *
 * That second path is gated here, on a persisted per-device flag, mirroring the
 * directions, reverse-geocode and network-routing gates.
 *
 * The gate is deliberately on the **remote lookup**, not on the readout as a
 * whole: gating the whole feature would also disable the terrain-only path,
 * which sends nothing anywhere. It is also checked at the point of use rather
 * than by clearing the stored preference, so every activation path is covered
 * at once — including a project file that arrives with the readout switched on,
 * which no amount of UI gating would catch.
 */
export const ELEVATION_CONSENT_KEY = "geolibre:pointer-elevation-open-meteo-notice";

/** Whether the user has acknowledged the elevation-lookup privacy notice. */
export function hasElevationConsent(): boolean {
  try {
    return localStorage.getItem(ELEVATION_CONSENT_KEY) === "1";
  } catch {
    // localStorage unavailable (private mode): treat as not acknowledged so the
    // notice is shown rather than silently sending coordinates.
    return false;
  }
}

/** Record that the user acknowledged the elevation-lookup privacy notice. */
export function recordElevationConsent(): void {
  try {
    localStorage.setItem(ELEVATION_CONSENT_KEY, "1");
  } catch {
    // Ignore: the notice will simply show again next time.
  }
}
