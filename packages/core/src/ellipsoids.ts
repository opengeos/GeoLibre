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
 * Built-in ellipsoids. Earth is WGS 84; every other body uses IAU-adopted
 * figures. Only Earth and Mars are appreciably oblate; the rest are modelled as
 * spheres (`inverseFlattening: 0`), which is how the IAU/USGS simple-cylindrical
 * products treat them and is well within the accuracy MapLibre's unit-sphere
 * rendering can represent anyway.
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
  {
    id: "mercury",
    name: "Mercury",
    semiMajorAxisMeters: 2439400,
    inverseFlattening: 0,
  },
  {
    id: "venus",
    name: "Venus",
    semiMajorAxisMeters: 6051800,
    inverseFlattening: 0,
  },
  {
    id: "io",
    name: "Io",
    semiMajorAxisMeters: 1821600,
    inverseFlattening: 0,
  },
  {
    id: "europa",
    name: "Europa",
    semiMajorAxisMeters: 1560800,
    inverseFlattening: 0,
  },
  {
    id: "ganymede",
    name: "Ganymede",
    semiMajorAxisMeters: 2631200,
    inverseFlattening: 0,
  },
  {
    id: "callisto",
    name: "Callisto",
    semiMajorAxisMeters: 2410300,
    inverseFlattening: 0,
  },
  {
    id: "titan",
    name: "Titan",
    semiMajorAxisMeters: 2574730,
    inverseFlattening: 0,
  },
  {
    id: "pluto",
    name: "Pluto",
    semiMajorAxisMeters: 1188300,
    inverseFlattening: 0,
  },
  {
    id: "charon",
    name: "Charon",
    semiMajorAxisMeters: 606000,
    inverseFlattening: 0,
  },
] as const satisfies readonly Ellipsoid[];

export type EllipsoidId = (typeof ELLIPSOIDS)[number]["id"];

export const DEFAULT_ELLIPSOID_ID: EllipsoidId = "earth";

/** Look an ellipsoid up by id, falling back to Earth for unknown ids. */
export function getEllipsoid(id: string | undefined): Ellipsoid {
  return (
    ELLIPSOIDS.find((e) => e.id === id) ?? ELLIPSOIDS.find((e) => e.id === DEFAULT_ELLIPSOID_ID)!
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

const OPM_ATTRIBUTION = '<a href="https://www.openplanetary.org/opm">OpenPlanetaryMap</a>';

/** Data-source credit joined with the OpenPlanetaryMap attribution. */
const opmCredit = (source: string) => `${source} · ${OPM_ATTRIBUTION}`;

// The GeoLibre tiles Worker (workers/tiles), which adds CORS to the OPM S3
// mosaics that lack it. Its dataset keys mirror the DATASETS map in that Worker.
// Tile path: `${TILE_PROXY_BASE}/<dataset>/{z}/{x}/{y}.png`.
const TILE_PROXY_BASE = "https://tiles.geolibre.app/opm";

// The GeoLibre tiles Worker's reprojection endpoint, which warps the USGS
// Astrogeology equirectangular WMS layers to Web Mercator so MapLibre can render
// them (the USGS server offers no EPSG:3857 for these bodies). Its dataset keys
// mirror the WMS_DATASETS map in that Worker (workers/tiles/src/index.ts).
// Tile path: `${WMS_PROXY_BASE}/<dataset>/{z}/{x}/{y}.png` — standard XYZ.
const WMS_PROXY_BASE = "https://tiles.geolibre.app/wms";

// USGS Astrogeology, the origin of every reprojected WMS basemap below.
const USGS_ASTRO_ATTRIBUTION = '<a href="https://astrogeology.usgs.gov/">USGS Astrogeology</a>';

/** Data-source credit joined with the USGS Astrogeology attribution. */
const usgsCredit = (source: string) => `${source} · ${USGS_ASTRO_ATTRIBUTION}`;

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
  // --- Mercury ------------------------------------------------------------
  // USGS Astrogeology WMS layers reprojected to Web Mercator by the tiles
  // Worker (see WMS_PROXY_BASE). Standard XYZ, so no `scheme`.
  {
    id: "mercury-messenger-color",
    name: "MESSENGER Colour Mosaic",
    styleUrl: `${PLANETARY_BASEMAP_SENTINEL_PREFIX}mercury-messenger-color`,
    tileUrl: `${WMS_PROXY_BASE}/mercury-messenger-color/{z}/{x}/{y}.png`,
    maxZoom: 7,
    attribution: usgsCredit("NASA / JHU APL / CIW"),
    ellipsoidId: "mercury",
  },
  {
    id: "mercury-messenger",
    name: "MESSENGER Basemap",
    styleUrl: `${PLANETARY_BASEMAP_SENTINEL_PREFIX}mercury-messenger`,
    tileUrl: `${WMS_PROXY_BASE}/mercury-messenger/{z}/{x}/{y}.png`,
    maxZoom: 7,
    attribution: usgsCredit("NASA / JHU APL"),
    ellipsoidId: "mercury",
  },
  // --- Venus --------------------------------------------------------------
  {
    id: "venus-magellan",
    name: "Magellan FMAP",
    styleUrl: `${PLANETARY_BASEMAP_SENTINEL_PREFIX}venus-magellan`,
    tileUrl: `${WMS_PROXY_BASE}/venus-magellan/{z}/{x}/{y}.png`,
    maxZoom: 6,
    attribution: usgsCredit("NASA / JPL"),
    ellipsoidId: "venus",
  },
  {
    id: "venus-magellan-color",
    name: "Magellan C3-MDIR Colour",
    styleUrl: `${PLANETARY_BASEMAP_SENTINEL_PREFIX}venus-magellan-color`,
    tileUrl: `${WMS_PROXY_BASE}/venus-magellan-color/{z}/{x}/{y}.png`,
    maxZoom: 6,
    attribution: usgsCredit("NASA / JPL"),
    ellipsoidId: "venus",
  },
  // --- Jupiter's Galilean moons -------------------------------------------
  {
    id: "io-galileo-color",
    name: "Galileo SSI Colour",
    styleUrl: `${PLANETARY_BASEMAP_SENTINEL_PREFIX}io-galileo-color`,
    tileUrl: `${WMS_PROXY_BASE}/io-galileo-color/{z}/{x}/{y}.png`,
    maxZoom: 6,
    attribution: usgsCredit("NASA / JPL"),
    ellipsoidId: "io",
  },
  {
    id: "europa-galileo-voyager",
    name: "Galileo / Voyager",
    styleUrl: `${PLANETARY_BASEMAP_SENTINEL_PREFIX}europa-galileo-voyager`,
    tileUrl: `${WMS_PROXY_BASE}/europa-galileo-voyager/{z}/{x}/{y}.png`,
    maxZoom: 6,
    attribution: usgsCredit("NASA / JPL"),
    ellipsoidId: "europa",
  },
  {
    id: "ganymede-galileo-voyager",
    name: "Galileo / Voyager",
    styleUrl: `${PLANETARY_BASEMAP_SENTINEL_PREFIX}ganymede-galileo-voyager`,
    tileUrl: `${WMS_PROXY_BASE}/ganymede-galileo-voyager/{z}/{x}/{y}.png`,
    maxZoom: 6,
    attribution: usgsCredit("NASA / JPL"),
    ellipsoidId: "ganymede",
  },
  {
    id: "callisto-galileo-voyager",
    name: "Galileo / Voyager",
    styleUrl: `${PLANETARY_BASEMAP_SENTINEL_PREFIX}callisto-galileo-voyager`,
    tileUrl: `${WMS_PROXY_BASE}/callisto-galileo-voyager/{z}/{x}/{y}.png`,
    maxZoom: 6,
    attribution: usgsCredit("NASA / JPL"),
    ellipsoidId: "callisto",
  },
  // --- Saturn's moon Titan ------------------------------------------------
  {
    id: "titan-cassini",
    name: "Cassini ISS Mosaic",
    styleUrl: `${PLANETARY_BASEMAP_SENTINEL_PREFIX}titan-cassini`,
    tileUrl: `${WMS_PROXY_BASE}/titan-cassini/{z}/{x}/{y}.png`,
    maxZoom: 6,
    attribution: usgsCredit("NASA / JPL / SSI"),
    ellipsoidId: "titan",
  },
  {
    id: "titan-hisar",
    name: "Cassini HiSAR Mosaic",
    styleUrl: `${PLANETARY_BASEMAP_SENTINEL_PREFIX}titan-hisar`,
    tileUrl: `${WMS_PROXY_BASE}/titan-hisar/{z}/{x}/{y}.png`,
    maxZoom: 6,
    attribution: usgsCredit("NASA / JPL / USGS"),
    ellipsoidId: "titan",
  },
  // --- Pluto & Charon -----------------------------------------------------
  {
    id: "pluto-mosaic",
    name: "New Horizons Mosaic",
    styleUrl: `${PLANETARY_BASEMAP_SENTINEL_PREFIX}pluto-mosaic`,
    tileUrl: `${WMS_PROXY_BASE}/pluto-mosaic/{z}/{x}/{y}.png`,
    maxZoom: 7,
    attribution: usgsCredit("NASA / JHU APL / SwRI"),
    ellipsoidId: "pluto",
  },
  {
    id: "pluto-color",
    name: "New Horizons Colour Shaded Relief",
    styleUrl: `${PLANETARY_BASEMAP_SENTINEL_PREFIX}pluto-color`,
    tileUrl: `${WMS_PROXY_BASE}/pluto-color/{z}/{x}/{y}.png`,
    maxZoom: 7,
    attribution: usgsCredit("NASA / JHU APL / SwRI"),
    ellipsoidId: "pluto",
  },
  {
    id: "charon-mosaic",
    name: "New Horizons Mosaic",
    styleUrl: `${PLANETARY_BASEMAP_SENTINEL_PREFIX}charon-mosaic`,
    tileUrl: `${WMS_PROXY_BASE}/charon-mosaic/{z}/{x}/{y}.png`,
    maxZoom: 6,
    attribution: usgsCredit("NASA / JHU APL / SwRI"),
    ellipsoidId: "charon",
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

/**
 * The section a planetary basemap is grouped under in the New Project and
 * Change Basemap pickers. The Moon and Mars keep dedicated sections (they are
 * the most-used bodies and each has several mosaics); every other body is
 * collapsed into a single "other" section so the picker isn't a wall of
 * one-item headings.
 */
export type PlanetaryBasemapSectionId = "moon" | "mars" | "other";

/** A picker section paired with the planetary basemaps it lists. */
export interface PlanetaryBasemapGroup {
  id: PlanetaryBasemapSectionId;
  basemaps: readonly PlanetaryBasemap[];
}

// Bodies that get their own picker section. Earth is excluded entirely (its
// basemaps live in the OpenFreeMap/Protomaps picker); everything else lands in
// "other".
const DEDICATED_SECTION_BODIES: readonly EllipsoidId[] = ["moon", "mars"];

/**
 * {@link PLANETARY_BASEMAPS} grouped for the pickers: one section each for the
 * Moon and Mars, then a single "Other celestial bodies" section for the rest,
 * in {@link PLANETARY_BASEMAPS} order (grouped by body). Empty sections are
 * dropped.
 */
export const PLANETARY_BASEMAP_GROUPS: readonly PlanetaryBasemapGroup[] = (
  [
    { id: "moon", ellipsoidId: "moon" },
    { id: "mars", ellipsoidId: "mars" },
    { id: "other", ellipsoidId: null },
  ] as const
)
  .map(({ id, ellipsoidId }) => {
    const basemaps = PLANETARY_BASEMAPS.filter((b) =>
      ellipsoidId
        ? b.ellipsoidId === ellipsoidId
        : b.ellipsoidId !== "earth" && !DEDICATED_SECTION_BODIES.includes(b.ellipsoidId),
    );
    // The combined "other" section spans many bodies, so order it alphabetically
    // by body name; a stable sort keeps each body's basemaps grouped together.
    return {
      id,
      basemaps:
        id === "other"
          ? [...basemaps].sort((a, b) =>
              getEllipsoid(a.ellipsoidId).name.localeCompare(getEllipsoid(b.ellipsoidId).name),
            )
          : basemaps,
    };
  })
  .filter((group) => group.basemaps.length > 0);

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
  const resolvedId = Object.prototype.hasOwnProperty.call(LEGACY_PLANETARY_BASEMAP_IDS, id)
    ? LEGACY_PLANETARY_BASEMAP_IDS[id]
    : id;
  return PLANETARY_BASEMAPS.find((b) => b.id === resolvedId);
}

/** Look a planetary basemap up by its stable id. */
export function getPlanetaryBasemapById(id: string): PlanetaryBasemap | undefined {
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
  // The three most-used bodies lead; the rest follow alphabetically.
  { ellipsoidId: "earth", basemapId: "earth-usgs-imagery" },
  { ellipsoidId: "moon", basemapId: "moon-hillshaded-albedo" },
  { ellipsoidId: "mars", basemapId: "mars-viking-mdim21" },
  { ellipsoidId: "callisto", basemapId: "callisto-galileo-voyager" },
  { ellipsoidId: "charon", basemapId: "charon-mosaic" },
  { ellipsoidId: "europa", basemapId: "europa-galileo-voyager" },
  { ellipsoidId: "ganymede", basemapId: "ganymede-galileo-voyager" },
  { ellipsoidId: "io", basemapId: "io-galileo-color" },
  { ellipsoidId: "mercury", basemapId: "mercury-messenger-color" },
  { ellipsoidId: "pluto", basemapId: "pluto-mosaic" },
  { ellipsoidId: "titan", basemapId: "titan-cassini" },
  { ellipsoidId: "venus", basemapId: "venus-magellan-color" },
] as const satisfies readonly {
  ellipsoidId: EllipsoidId;
  basemapId: string;
}[];
