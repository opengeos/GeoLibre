import type * as mapboxgl from "mapbox-gl";

/**
 * Mapbox GL JS v2+ is proprietary, so no GeoLibre build may contain it: the
 * script and stylesheet come from Mapbox's own CDN when a Mapbox pane mounts.
 * The npm package stays a dependency for its types alone.
 *
 * `tests/mapbox-gl-loader.test.ts` ties these constants to the installed
 * package, so a bump fails until they are updated (docs/maintenance.md).
 */
export const MAPBOX_GL_VERSION = "3.33.0";
const MAPBOX_GL_CDN_BASE = `https://api.mapbox.com/mapbox-gl-js/v${MAPBOX_GL_VERSION}`;
export const MAPBOX_GL_SCRIPT_URL = `${MAPBOX_GL_CDN_BASE}/mapbox-gl.js`;
export const MAPBOX_GL_STYLE_URL = `${MAPBOX_GL_CDN_BASE}/mapbox-gl.css`;
export const MAPBOX_GL_SCRIPT_INTEGRITY =
  "sha384-jdGuG3GDIph+ONsjITkxWmlUE2RR0At6jtOVirn6L/6dYy3WcAVDaBNI3X96rUT0";
export const MAPBOX_GL_STYLE_INTEGRITY =
  "sha384-S0a+eT2dLtsB1suB6ZJ/8IX+0d0Fvix9weJQ67L3E+jHOvn6SUKwYXVDyGdMuJtL";

type MapboxGl = typeof mapboxgl.default;

let mapboxGlPromise: Promise<MapboxGl> | null = null;
let scriptPromise: Promise<void> | null = null;
let stylePromise: Promise<void> | null = null;

declare const __NO_EXTERNAL_CDN__: boolean;

/**
 * Load the Mapbox GL JS script and wait for it to run.
 *
 * @returns A promise that settles with the script's load or error event.
 */
function loadScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = MAPBOX_GL_SCRIPT_URL;
    script.integrity = MAPBOX_GL_SCRIPT_INTEGRITY;
    script.crossOrigin = "anonymous";
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener(
      "error",
      () => {
        script.remove();
        reject(new Error(`Could not load Mapbox GL JS from ${MAPBOX_GL_SCRIPT_URL}`));
      },
      { once: true },
    );
    document.head.appendChild(script);
  });
}

/**
 * Inject the Mapbox GL stylesheet as an inline `<style>`.
 *
 * As with `ensureArcgisCss`, a `<link>` would need a CDN host in `style-src`,
 * while the fetch is already allowed by `connect-src https:`. The stylesheet's
 * only `url()`s are data URIs, so moving it off the CDN breaks no references.
 *
 * @returns A promise that settles once the style is in the document.
 */
async function loadStyle(): Promise<void> {
  const response = await fetch(MAPBOX_GL_STYLE_URL, { integrity: MAPBOX_GL_STYLE_INTEGRITY });
  if (!response.ok) {
    throw new Error(`Could not load the Mapbox GL stylesheet (HTTP ${response.status}).`);
  }
  const style = document.createElement("style");
  style.textContent = await response.text();
  document.head.appendChild(style);
}

/**
 * Load Mapbox GL JS and its stylesheet from Mapbox's CDN, once per page.
 *
 * A failed load clears the cache, so mounting another pane retries only the
 * half that failed: re-running the script or duplicating the style would not help.
 *
 * @returns The `mapboxgl` namespace. Rejects in a `GEOLIBRE_NO_EXTERNAL_CDN`
 *   build, which must not run code from a CDN.
 */
export function loadMapboxGl(): Promise<MapboxGl> {
  if (typeof __NO_EXTERNAL_CDN__ !== "undefined" && __NO_EXTERNAL_CDN__) {
    return Promise.reject(new Error("The Mapbox renderer is disabled in this build."));
  }
  if (mapboxGlPromise) return mapboxGlPromise;
  scriptPromise ??= loadScript().catch((error) => {
    scriptPromise = null;
    throw error;
  });
  stylePromise ??= loadStyle().catch((error) => {
    stylePromise = null;
    throw error;
  });
  mapboxGlPromise = Promise.all([scriptPromise, stylePromise])
    .then(() => {
      const gl = (globalThis as unknown as { mapboxgl?: MapboxGl }).mapboxgl;
      if (!gl) {
        // A script that throws while running still fires `load`.
        scriptPromise = null;
        throw new Error("Mapbox GL JS loaded but did not define `mapboxgl`.");
      }
      return gl;
    })
    .catch((error) => {
      mapboxGlPromise = null;
      throw error;
    });
  return mapboxGlPromise;
}

/** Forget the cached load, so each test starts from an unloaded page. */
export function resetMapboxGlForTests(): void {
  mapboxGlPromise = null;
  scriptPromise = null;
  stylePromise = null;
}
