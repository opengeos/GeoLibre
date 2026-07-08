/**
 * Celestial-body ellipsoids and the planetary basemaps that pair with them.
 *
 * GeoLibre is Earth-centric by construction: MapLibre only renders Web Mercator
 * and all vector data is kept as WGS84 lon/lat GeoJSON. This module does *not*
 * change that — MapLibre still treats the planet as a unit sphere and there is
 * no true multi-CRS rendering (see maplibre-gl-js#168). What it adds is a
 * per-project notion of *which body* the coordinates describe, so that:
 *
 *   - distance / area / scale measurements use that body's radius instead of a
 *     hardcoded Earth radius, and
 *   - Moon / Mars basemaps (published in a Web-Mercator tiling scheme) can be
 *     selected like any other basemap.
 *
 * The active ellipsoid is a lightweight module-level singleton kept in sync with
 * the project's map preferences (see the store's `setPreferences`). Measurement
 * helpers read it lazily at call time, so callers in other packages don't need
 * the value threaded through their signatures — a deliberate prototype-friendly
 * shortcut over a full CRS/context refactor.
 */

/** A biaxial (rotational) ellipsoid describing a celestial body. */
export interface Ellipsoid {
  /** Stable id persisted in the project (`map.ellipsoidId`). */
  id: string;
  /** Human-readable name shown in the UI. */
  name: string;
  /** Equatorial (semi-major) radius in metres — the "web mercator" radius. */
  semiMajorAxisMeters: number;
  /**
   * Inverse flattening `1/f`. `0` denotes a perfect sphere (Moon), in which case
   * the polar radius equals {@link semiMajorAxisMeters}.
   */
  inverseFlattening: number;
}

/**
 * Built-in ellipsoids. Earth is WGS 84; the Moon and Mars use IAU-adopted
 * figures. The Moon is modelled as a sphere (its flattening is negligible).
 */
export const ELLIPSOIDS = [
  {
    id: "earth",
    name: "Earth (WGS 84)",
    semiMajorAxisMeters: 6378137,
    inverseFlattening: 298.257223563,
  },
  {
    id: "moon",
    name: "Moon",
    semiMajorAxisMeters: 1737400,
    inverseFlattening: 0,
  },
  {
    id: "mars",
    name: "Mars (IAU 2000)",
    semiMajorAxisMeters: 3396190,
    inverseFlattening: 169.894447,
  },
] as const satisfies readonly Ellipsoid[];

export type EllipsoidId = (typeof ELLIPSOIDS)[number]["id"];

export const DEFAULT_ELLIPSOID_ID: EllipsoidId = "earth";

/** Look an ellipsoid up by id, falling back to Earth for unknown ids. */
export function getEllipsoid(id: string | undefined): Ellipsoid {
  return (
    ELLIPSOIDS.find((e) => e.id === id) ??
    ELLIPSOIDS.find((e) => e.id === DEFAULT_ELLIPSOID_ID)!
  );
}

/**
 * Mean radius `R = (2a + b) / 3` in metres, where `b` is the polar radius
 * derived from the inverse flattening. This is the radius used for spherical
 * (haversine) distance and area math.
 */
export function meanRadiusMeters(ellipsoid: Ellipsoid): number {
  const a = ellipsoid.semiMajorAxisMeters;
  if (!ellipsoid.inverseFlattening) return a;
  const f = 1 / ellipsoid.inverseFlattening;
  const b = a * (1 - f);
  return (2 * a + b) / 3;
}

// --- Active ellipsoid singleton -------------------------------------------

let activeEllipsoidId: EllipsoidId = DEFAULT_ELLIPSOID_ID;

/**
 * Point the measurement helpers at a body. Unknown ids fall back to Earth so a
 * malformed project can never break measurements. Safe to call on every
 * preferences change; it is a cheap assignment.
 */
export function setActiveEllipsoidId(id: string | undefined): void {
  activeEllipsoidId = getEllipsoid(id).id as EllipsoidId;
}

export function getActiveEllipsoid(): Ellipsoid {
  return getEllipsoid(activeEllipsoidId);
}

/** Mean radius (metres) of the active body — for haversine distance/area. */
export function getActiveMeanRadiusMeters(): number {
  return meanRadiusMeters(getActiveEllipsoid());
}

/** Semi-major axis (metres) of the active body — for its Web-Mercator scale. */
export function getActiveSemiMajorAxisMeters(): number {
  return getActiveEllipsoid().semiMajorAxisMeters;
}

// --- Planetary basemaps ----------------------------------------------------

/**
 * A raster basemap for a non-Earth body. The tiles are XYZ PNGs in the standard
 * Web-Mercator scheme (of that body), so MapLibre renders them directly. The
 * `styleUrl` is a `geolibre://basemap/<id>` sentinel; the map controller expands
 * it into a raster style at apply time (it is not a fetchable URL).
 */
export interface PlanetaryBasemap {
  id: string;
  name: string;
  /** Sentinel stored as the basemap style URL. */
  styleUrl: string;
  /** XYZ tile template. */
  tileUrl: string;
  /** Max native zoom of the source (MapLibre overzooms beyond this). */
  maxZoom: number;
  /** Attribution shown on the map. */
  attribution: string;
  /** The body this basemap depicts, so selecting it can set the ellipsoid. */
  ellipsoidId: EllipsoidId;
}

export const PLANETARY_BASEMAP_SENTINEL_PREFIX = "geolibre://basemap/";

const USGS_ATTRIBUTION =
  '<a href="https://astrogeology.usgs.gov">USGS Astrogeology</a> / NASA';

const OPM_ATTRIBUTION =
  '<a href="https://www.openplanetary.org/opm">OpenPlanetaryMap</a> / USGS / NASA';

// USGS Astrogeology MapServer serves these global mosaics as Web-Mercator XYZ
// tiles (`tilemode=gmap`) with open CORS, so MapLibre renders them directly.
// These are the photographic mosaics Google Earth/Moon use — the Viking
// colorized mosaic for Mars and the LRO WAC mosaic for the Moon — rather than a
// stylized cartographic basemap.
//
// MapServer's gmap `tile=` parameter wants the tile coordinates space-separated
// (`x y z`). We encode the separators as `%20`, NOT `+`: the Linux Tauri webview
// (WebKitGTK) re-encodes a literal `+` in the request URL to `%2B`, which
// MapServer then reads as a literal plus rather than a space, so every tile
// comes back as an HTML error and the map goes black. `%20` is the canonical
// space encoding and survives both Chromium and WebKit unchanged.
export const PLANETARY_BASEMAPS: readonly PlanetaryBasemap[] = [
  // Cartographic OpenPlanetaryMap basemaps (colorized shaded relief + labels).
  // These are pre-rendered on a Fastly CDN, so they load fast and reliably —
  // the "just works" choice when the USGS imagery below is slow.
  {
    id: "mars-opm",
    name: "Mars (OpenPlanetaryMap)",
    styleUrl: `${PLANETARY_BASEMAP_SENTINEL_PREFIX}mars-opm`,
    tileUrl:
      "https://cartocdn-gusc.global.ssl.fastly.net/opmbuilder/api/v1/map/named/opm-mars-basemap-v0-2/all/{z}/{x}/{y}.png",
    maxZoom: 6,
    attribution: OPM_ATTRIBUTION,
    ellipsoidId: "mars",
  },
  {
    id: "moon-opm",
    name: "Moon (OpenPlanetaryMap)",
    styleUrl: `${PLANETARY_BASEMAP_SENTINEL_PREFIX}moon-opm`,
    tileUrl:
      "https://cartocdn-gusc.global.ssl.fastly.net/opmbuilder/api/v1/map/named/opm-moon-basemap-v0-1/all/{z}/{x}/{y}.png",
    maxZoom: 6,
    attribution: OPM_ATTRIBUTION,
    ellipsoidId: "moon",
  },
  // Photographic mosaics (the Google Earth/Moon look), served on demand by the
  // USGS Astrogeology MapServer. Higher fidelity but slower — the cgi-bin
  // renders each tile per request rather than serving from a CDN.
  {
    id: "mars-viking",
    name: "Mars (Viking imagery)",
    styleUrl: `${PLANETARY_BASEMAP_SENTINEL_PREFIX}mars-viking`,
    tileUrl:
      "https://planetarymaps.usgs.gov/cgi-bin/mapserv?map=/maps/mars/mars_simp_cyl.map&layers=MDIM21_color&mode=tile&tilemode=gmap&tile={x}%20{y}%20{z}",
    maxZoom: 7,
    attribution: `Mars Viking MDIM 2.1 — ${USGS_ATTRIBUTION}`,
    ellipsoidId: "mars",
  },
  {
    id: "moon-lroc",
    name: "Moon (LRO imagery)",
    styleUrl: `${PLANETARY_BASEMAP_SENTINEL_PREFIX}moon-lroc`,
    tileUrl:
      "https://planetarymaps.usgs.gov/cgi-bin/mapserv?map=/maps/earth/moon_simp_cyl.map&layers=LROC_WAC&mode=tile&tilemode=gmap&tile={x}%20{y}%20{z}",
    maxZoom: 7,
    attribution: `LRO LROC WAC — ${USGS_ATTRIBUTION}`,
    ellipsoidId: "moon",
  },
] as const;

/** Resolve a `geolibre://basemap/<id>` sentinel to its planetary basemap. */
export function getPlanetaryBasemapByStyleUrl(
  styleUrl: string | undefined,
): PlanetaryBasemap | undefined {
  if (!styleUrl?.startsWith(PLANETARY_BASEMAP_SENTINEL_PREFIX)) return undefined;
  return PLANETARY_BASEMAPS.find((b) => b.styleUrl === styleUrl);
}
