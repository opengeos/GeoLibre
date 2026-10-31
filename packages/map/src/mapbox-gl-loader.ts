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

/**
 * Append a CDN element to the document head and wait for it to load.
 *
 * @param element - The configured `<script>` or `<link>` element.
 * @param url - The URL being loaded, named in the failure message.
 * @returns A promise that settles with the element's load or error event.
 */
function appendAndWait(element: HTMLElement, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    element.addEventListener("load", () => resolve(), { once: true });
    element.addEventListener(
      "error",
      () => {
        element.remove();
        reject(new Error(`Could not load Mapbox GL JS from ${url}`));
      },
      { once: true },
    );
    document.head.appendChild(element);
  });
}

/**
 * Load Mapbox GL JS and its stylesheet from Mapbox's CDN, once per page.
 *
 * A failed load clears the cache, so mounting another pane retries it.
 *
 * @returns The `mapboxgl` namespace.
 */
export function loadMapboxGl(): Promise<MapboxGl> {
  if (mapboxGlPromise) return mapboxGlPromise;
  const script = document.createElement("script");
  script.src = MAPBOX_GL_SCRIPT_URL;
  script.integrity = MAPBOX_GL_SCRIPT_INTEGRITY;
  script.crossOrigin = "anonymous";
  const style = document.createElement("link");
  style.rel = "stylesheet";
  style.href = MAPBOX_GL_STYLE_URL;
  style.integrity = MAPBOX_GL_STYLE_INTEGRITY;
  style.crossOrigin = "anonymous";
  mapboxGlPromise = Promise.all([
    appendAndWait(script, MAPBOX_GL_SCRIPT_URL),
    appendAndWait(style, MAPBOX_GL_STYLE_URL),
  ])
    .then(() => {
      const gl = (globalThis as unknown as { mapboxgl?: MapboxGl }).mapboxgl;
      if (!gl) throw new Error("Mapbox GL JS loaded but did not define `mapboxgl`.");
      return gl;
    })
    .catch((error) => {
      script.remove();
      style.remove();
      mapboxGlPromise = null;
      throw error;
    });
  return mapboxGlPromise;
}
