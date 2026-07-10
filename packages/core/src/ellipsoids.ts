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
 * A raster basemap for a celestial body — the Moon and Mars mosaics, plus the
 * Earth satellite imagery the planet switcher pairs with Earth. The tiles are
 * XYZ (or TMS, see {@link scheme}) images in that body's Web-Mercator scheme, so
 * MapLibre renders them directly. The `styleUrl` is a `geolibre://basemap/<id>`
 * sentinel; the map controller expands it into a raster style at apply time (it
 * is not a fetchable URL).
 */
export interface PlanetaryBasemap {
  id: string;
  name: string;
  /** Sentinel stored as the basemap style URL. */
  styleUrl: string;
  /** XYZ (or TMS, see {@link scheme}) tile template. */
  tileUrl: string;
  /**
   * Tile row ordering. OpenPlanetaryMap's single-layer raster mosaics (the S3
   * datasets) are published as **TMS** (tile origin bottom-left, Y flipped),
   * whereas the CARTO `opmbuilder` named maps are standard **XYZ**. Omit for
   * XYZ; MapLibre defaults to `"xyz"` when `scheme` is absent.
   */
  scheme?: "tms";
  /** Max native zoom of the source (MapLibre overzooms beyond this). */
  maxZoom: number;
  /** Attribution shown on the map. */
  attribution: string;
  /** The body this basemap depicts, so selecting it can set the ellipsoid. */
  ellipsoidId: EllipsoidId;
}

export const PLANETARY_BASEMAP_SENTINEL_PREFIX = "geolibre://basemap/";

const OPM_ATTRIBUTION =
  '<a href="https://www.openplanetary.org/opm">OpenPlanetaryMap</a>';

/** Data-source credit joined with the OpenPlanetaryMap attribution. */
const opmCredit = (source: string) => `${source} · ${OPM_ATTRIBUTION}`;

// The GeoLibre tiles Worker (workers/tiles), which adds CORS to the OPM S3
// mosaics that lack it. Its dataset keys mirror the DATASETS map in that Worker.
// Tile path: `${TILE_PROXY_BASE}/<dataset>/{z}/{x}/{y}.png`.
const TILE_PROXY_BASE = "https://tiles.geolibre.app/opm";

// The OpenPlanetaryMap Mars and Moon basemaps
// (https://openplanetarymap.org/basemaps/). Every one is a pre-rendered raster
// served from a CDN — fast and reliable, unlike the USGS Astrogeology MapServer
// these replace, which rendered every tile per request from a cgi-bin.
//
// Two tiling schemes are in play (see PlanetaryBasemap.scheme):
//   - The single-layer OPM mosaics (MOLA/Viking/hillshade/Moon albedo) are TMS.
//   - The multi-layer CARTO `opmbuilder` named maps are standard XYZ.
// maxZoom is each source's probed max native zoom, so MapLibre overzooms (blurs)
// rather than 404s.
//
// CORS: MapLibre GL fetches raster tiles with `fetch()`, which enforces CORS.
// The CARTO `opmbuilder` named maps send `Access-Control-Allow-Origin: *`, so
// they are referenced directly. The single-layer OPM mosaics are served from S3
// buckets that send NO CORS header, so the browser blocks them — those go
// through the GeoLibre tiles Worker (workers/tiles, tiles.geolibre.app), which
// re-emits each tile with CORS and edge-caches it. See TILE_PROXY_BASE.
export const PLANETARY_BASEMAPS: readonly PlanetaryBasemap[] = [
  // --- Mars ---------------------------------------------------------------
  {
    id: "mars-colour-mola-elevation",
    name: "Colour MOLA Elevation",
    styleUrl: `${PLANETARY_BASEMAP_SENTINEL_PREFIX}mars-colour-mola-elevation`,
    tileUrl: `${TILE_PROXY_BASE}/mars-mola-color-noshade/{z}/{x}/{y}.png`,
    scheme: "tms",
    maxZoom: 6,
    attribution: opmCredit("NASA / MOLA"),
    ellipsoidId: "mars",
  },
  {
    id: "mars-viking-mdim21",
    name: "Viking MDIM2.1",
    styleUrl: `${PLANETARY_BASEMAP_SENTINEL_PREFIX}mars-viking-mdim21`,
    tileUrl: `${TILE_PROXY_BASE}/mars-viking-mdim21/{z}/{x}/{y}.png`,
    scheme: "tms",
    maxZoom: 7,
    attribution: opmCredit("NASA / Viking / USGS"),
    ellipsoidId: "mars",
  },
  {
    id: "mars-hillshade",
    name: "Hillshade",
    styleUrl: `${PLANETARY_BASEMAP_SENTINEL_PREFIX}mars-hillshade`,
    tileUrl: `${TILE_PROXY_BASE}/mars-hillshade/{z}/{x}/{y}.png`,
    scheme: "tms",
    maxZoom: 6,
    attribution: opmCredit("NASA / MOLA"),
    ellipsoidId: "mars",
  },
  {
    id: "mars-basemap-v0-2",
    name: "OPM Basemap v0.2",
    styleUrl: `${PLANETARY_BASEMAP_SENTINEL_PREFIX}mars-basemap-v0-2`,
    tileUrl:
      "https://cartocdn-gusc.global.ssl.fastly.net/opmbuilder/api/v1/map/named/opm-mars-basemap-v0-2/all/{z}/{x}/{y}.png",
    maxZoom: 6,
    attribution: OPM_ATTRIBUTION,
    ellipsoidId: "mars",
  },
  {
    id: "mars-shaded-colour-mola-elevation",
    name: "Shaded Colour MOLA Elevation",
    styleUrl: `${PLANETARY_BASEMAP_SENTINEL_PREFIX}mars-shaded-colour-mola-elevation`,
    tileUrl: `${TILE_PROXY_BASE}/mars-mola-color/{z}/{x}/{y}.png`,
    scheme: "tms",
    maxZoom: 6,
    attribution: opmCredit("NASA / MOLA"),
    ellipsoidId: "mars",
  },
  {
    id: "mars-shaded-grayscale-mola-elevation",
    name: "Shaded Grayscale MOLA Elevation",
    styleUrl: `${PLANETARY_BASEMAP_SENTINEL_PREFIX}mars-shaded-grayscale-mola-elevation`,
    tileUrl: `${TILE_PROXY_BASE}/mars-mola-gray/{z}/{x}/{y}.png`,
    scheme: "tms",
    maxZoom: 9,
    attribution: opmCredit("NASA / MOLA"),
    ellipsoidId: "mars",
  },
  // --- The Moon -----------------------------------------------------------
  {
    id: "moon-hillshaded-albedo",
    name: "Hillshaded Albedo",
    styleUrl: `${PLANETARY_BASEMAP_SENTINEL_PREFIX}moon-hillshaded-albedo`,
    tileUrl: `${TILE_PROXY_BASE}/moon-hillshaded-albedo/{z}/{x}/{y}.png`,
    scheme: "tms",
    maxZoom: 6,
    attribution: opmCredit("NASA / LOLA / USGS"),
    ellipsoidId: "moon",
  },
  {
    id: "moon-basemap-v0-1",
    name: "OPM Basemap v0.1",
    styleUrl: `${PLANETARY_BASEMAP_SENTINEL_PREFIX}moon-basemap-v0-1`,
    tileUrl:
      "https://cartocdn-gusc.global.ssl.fastly.net/opmbuilder/api/v1/map/named/opm-moon-basemap-v0-1/all/{z}/{x}/{y}.png",
    maxZoom: 6,
    attribution: OPM_ATTRIBUTION,
    ellipsoidId: "moon",
  },
  // --- Earth --------------------------------------------------------------
  // Satellite imagery the planet switcher pairs with Earth. Not shown in the
  // basemap picker's Moon/Mars sections (PLANETARY_BODY_ORDER excludes Earth) —
  // Earth basemaps live in the OpenFreeMap/Protomaps picker. USGS's National Map
  // ImageryOnly tiles are global Web-Mercator XYZ with open CORS.
  {
    id: "earth-usgs-imagery",
    name: "USGS Imagery",
    styleUrl: `${PLANETARY_BASEMAP_SENTINEL_PREFIX}earth-usgs-imagery`,
    tileUrl:
      "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}",
    maxZoom: 16,
    attribution:
      '<a href="https://www.usgs.gov/programs/national-geospatial-program/national-map">USGS The National Map</a>',
    ellipsoidId: "earth",
  },
] as const;

/** The celestial bodies with basemaps, in the order the UI groups them. */
const PLANETARY_BODY_ORDER: readonly EllipsoidId[] = ["moon", "mars"];

/** A celestial body paired with the planetary basemaps that depict it. */
export interface PlanetaryBasemapGroup {
  ellipsoidId: EllipsoidId;
  basemaps: readonly PlanetaryBasemap[];
}

/**
 * {@link PLANETARY_BASEMAPS} grouped by celestial body, so the New Project and
 * Change Basemap panels can render one section per body (The Moon, Mars)
 * instead of a single flat "Planetary" list.
 */
export const PLANETARY_BASEMAP_GROUPS: readonly PlanetaryBasemapGroup[] =
  PLANETARY_BODY_ORDER.map((ellipsoidId) => ({
    ellipsoidId,
    basemaps: PLANETARY_BASEMAPS.filter((b) => b.ellipsoidId === ellipsoidId),
  })).filter((group) => group.basemaps.length > 0);

// Basemap ids the OpenPlanetaryMap migration renamed or dropped, mapped to the
// nearest current basemap. Lets a project saved before the migration keep a
// planetary basemap (instead of falling back to Earth) the next time it opens:
// the two OPM composites kept their exact tiles under new ids, Viking maps to
// the equivalent OPM mosaic, and the retired LRO imagery maps to the flagship
// Moon basemap.
const LEGACY_PLANETARY_BASEMAP_IDS: Record<string, string> = {
  "mars-opm": "mars-basemap-v0-2",
  "moon-opm": "moon-basemap-v0-1",
  "mars-viking": "mars-viking-mdim21",
  "moon-lroc": "moon-basemap-v0-1",
};

/** Resolve a `geolibre://basemap/<id>` sentinel to its planetary basemap. */
export function getPlanetaryBasemapByStyleUrl(
  styleUrl: string | undefined,
): PlanetaryBasemap | undefined {
  if (!styleUrl?.startsWith(PLANETARY_BASEMAP_SENTINEL_PREFIX)) return undefined;
  const id = styleUrl.slice(PLANETARY_BASEMAP_SENTINEL_PREFIX.length);
  const resolvedId = Object.prototype.hasOwnProperty.call(
    LEGACY_PLANETARY_BASEMAP_IDS,
    id,
  )
    ? LEGACY_PLANETARY_BASEMAP_IDS[id]
    : id;
  return PLANETARY_BASEMAPS.find((b) => b.id === resolvedId);
}

/** Look a planetary basemap up by its stable id. */
export function getPlanetaryBasemapById(
  id: string,
): PlanetaryBasemap | undefined {
  return PLANETARY_BASEMAPS.find((b) => b.id === id);
}

/**
 * The celestial bodies offered by the Layers-panel planet switcher, in menu
 * order (like Google Earth's planet dropdown). Each body is paired with the
 * basemap the switcher applies for it — USGS satellite imagery for Earth, the
 * OpenPlanetaryMap Hillshaded Albedo mosaic for the Moon, and the OpenPlanetaryMap
 * Viking mosaic for Mars.
 */
export const PLANET_SWITCHER_OPTIONS = [
  { ellipsoidId: "earth", basemapId: "earth-usgs-imagery" },
  { ellipsoidId: "moon", basemapId: "moon-hillshaded-albedo" },
  { ellipsoidId: "mars", basemapId: "mars-viking-mdim21" },
] as const satisfies readonly {
  ellipsoidId: EllipsoidId;
  basemapId: string;
}[];
