/**
 * Map coordinate reference systems for the MapLibre renderer (issue #1128).
 *
 * MapLibre GL JS 6.15 can draw a flat map in any planar CRS registered with
 * `maplibregl.addProjection`: tiles are placed on a square quad grid laid over
 * the CRS plane and are not reprojected, so every tile has to be made in that
 * CRS already. A WMS does that on request (the `{bbox}` tile token asks for each
 * tile's box in CRS units), which is how the presets below get native polar and
 * simple-cylindrical basemaps of Earth, the Moon, Mars and the outer bodies.
 *
 * `preferences.map.mapCrs` names the CRS: a preset id from
 * {@link MAP_CRS_PRESETS}, or `"EPSG:<code>"` for any code the bundled EPSG
 * tables resolve. Absent means the default Web Mercator / globe map.
 *
 * This module is pure data and string handling. Registering the projection and
 * swapping the style live in `@geolibre/map` (`map-crs.ts`).
 */

/** A square quad tile grid over a CRS plane, as MapLibre's `TileMatrixSet`. */
export interface MapCrsTileMatrixSet {
  /** Top-left corner of tile 0/0/0, in CRS units. */
  origin: [number, number];
  /** Width (and height) of tile 0/0/0, in CRS units. */
  extentAtZoom0: number;
}

/** A WMS basemap served natively in a preset's CRS. */
export interface MapCrsBasemap {
  /** GetMap template whose `BBOX` is MapLibre's `{bbox}` token. */
  tiles: string;
  /** Attribution HTML. */
  attribution: string;
  /** Deepest zoom worth requesting; MapLibre overzooms past it. */
  maxZoom: number;
}

/** Which group a preset is listed under in the settings picker. */
export type MapCrsBody =
  | "earth"
  | "moon"
  | "mars"
  | "mercury"
  | "venus"
  | "io"
  | "europa"
  | "ganymede"
  | "callisto"
  | "titan"
  | "pluto"
  | "charon";

/** A CRS offered in the settings picker. */
export interface MapCrsPreset {
  /** Stable id persisted in `preferences.map.mapCrs`; also the i18n key. */
  id: string;
  /** English name; the UI translates it by `id`. */
  name: string;
  /**
   * The CRS's authority code, registered with MapLibre under this name and
   * written into the `SRS`/`CRS` of WMS layers drawn on the map.
   */
  code: string;
  /**
   * The label WMS and ArcGIS export layers on the map ask for, when servers
   * do not read `code`. MapServer's PROJ rejects the planetary IAU codes, so
   * those presets use the labels USGS Astrogeology serves their grids under.
   */
  wmsSrs?: string;
  /** PROJ string of the CRS, used by proj4 on the page and in the workers. */
  definition: string;
  /** Ellipsoid registry id the preset's coordinates describe. */
  ellipsoidId: MapCrsBody;
  tileMatrixSet: MapCrsTileMatrixSet;
  /** Box the map opens on when the preset is chosen, `[west, south, east, north]`. */
  bounds: [number, number, number, number];
  basemap: MapCrsBasemap;
}

/**
 * Window event the map fires when it enters or leaves a CRS, or is torn down
 * while in one. It carries no detail: the plugin API's `getMapCrs` reads the
 * new value, and its `onMapCrsChange` listens for this.
 */
export const MAP_CRS_CHANGE_EVENT = "geolibre:map-crs-change";

/** Codes that are the default Web Mercator map rather than a custom CRS. */
const WEB_MERCATOR_CODES: ReadonlySet<number> = new Set([3857, 900913, 102100, 102113]);

const USGS_WMS = "https://planetarymaps.usgs.gov/cgi-bin/mapserv";
const USGS_ATTRIBUTION = '<a href="https://astrogeology.usgs.gov/">USGS Astrogeology</a>';
const GIBS_ATTRIBUTION =
  'Imagery: <a href="https://earthdata.nasa.gov/gibs">NASA GIBS</a> / Blue Marble';

/**
 * A WMS 1.1.1 GetMap template. 1.1.1 because its BBOX is always x,y (east,
 * north) order, which is what `{bbox}` fills in; 1.3.0 flips it for
 * geographic CRSs.
 */
function getMapTemplate(base: string, srs: string, layer: string, format: string): string {
  return (
    `${base}${base.includes("?") ? "&" : "?"}SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap` +
    `&SRS=${srs}&STYLES=&LAYERS=${layer}&WIDTH=512&HEIGHT=512&FORMAT=${format}` +
    "&TRANSPARENT=TRUE&BBOX={bbox}"
  );
}

/** A USGS Astrogeology MapServer layer in the CRS of its `.map` file. */
function usgsBasemap(mapFile: string, srs: string, layer: string, maxZoom: number): MapCrsBasemap {
  return {
    tiles: getMapTemplate(`${USGS_WMS}?map=${mapFile}`, srs, layer, "image/png"),
    attribution: USGS_ATTRIBUTION,
    maxZoom,
  };
}

/** A NASA GIBS Blue Marble layer from the WMS endpoint of one of its grids. */
function gibsBasemap(epsg: number): MapCrsBasemap {
  return {
    tiles: getMapTemplate(
      `https://gibs.earthdata.nasa.gov/wms/epsg${epsg}/best/wms.cgi`,
      `EPSG:${epsg}`,
      "BlueMarble_ShadedRelief_Bathymetry",
      "image/jpeg",
    ),
    attribution: GIBS_ATTRIBUTION,
    maxZoom: 7,
  };
}

/** Lng/lat degrees on the whole world, centered so MapLibre can find its edges. */
const GEOGRAPHIC_GRID: MapCrsTileMatrixSet = { origin: [-180, 180], extentAtZoom0: 360 };

/** A square centered on a pole, `halfWidth` CRS units to each side. */
function polarGrid(halfWidth: number): MapCrsTileMatrixSet {
  return { origin: [-halfWidth, halfWidth], extentAtZoom0: 2 * halfWidth };
}

const sphere = (radius: number) => `+R=${radius}`;
const longlat = (radius: number) => `+proj=longlat ${sphere(radius)} +no_defs`;
const polarStereographic = (north: boolean, radius: number) =>
  `+proj=stere +lat_0=${north ? 90 : -90} +lon_0=0 +k=1 +x_0=0 +y_0=0 ${sphere(radius)} +units=m +no_defs`;

const MOON_RADIUS = 1737400;
const MARS_RADIUS = 3396190;

/**
 * A simple-cylindrical (lng/lat degrees) preset for one body's USGS map file.
 *
 * Args:
 *   body: The body, which is also the ellipsoid id.
 *   name: English name of the preset.
 *   naifCode: The body's IAU 2015 code (NAIF id × 100), e.g. `49900` for Mars.
 *   radius: Sphere radius in metres.
 *   mapFile: The USGS `.map` file path.
 *   layer: The WMS layer drawn as the basemap.
 *
 * Returns:
 *   The preset.
 */
function cylindrical(
  body: MapCrsBody,
  name: string,
  naifCode: number,
  radius: number,
  mapFile: string,
  layer: string,
): MapCrsPreset {
  return {
    id: `${body}-cylindrical`,
    name,
    code: `IAU_2015:${naifCode}`,
    // Servers read a lng/lat degree grid as EPSG:4326, whatever the body.
    wmsSrs: "EPSG:4326",
    definition: longlat(radius),
    ellipsoidId: body,
    tileMatrixSet: GEOGRAPHIC_GRID,
    bounds: [-180, -90, 180, 90],
    // The simple-cylindrical map files list only EPSG:4326 and their IAU code,
    // and MapServer's PROJ fails on the IAU code, so ask in EPSG:4326 degrees:
    // the same lng/lat grid, labelled the way the server can read it.
    basemap: usgsBasemap(mapFile, "EPSG:4326", layer, 7),
  };
}

/**
 * Presets verified to render against their WMS on 2026-10-19.
 *
 * The USGS polar map files serve their native polar stereographic grid under
 * `EPSG:32661`/`EPSG:32761` (MapServer's PROJ rejects the IAU codes they also
 * list), centred on the pole with no false origin, so those labels are used for
 * the basemap requests while the map registers the body's IAU code.
 */
export const MAP_CRS_PRESETS: readonly MapCrsPreset[] = [
  {
    id: "earth-arctic",
    name: "Arctic Polar Stereographic",
    code: "EPSG:3413",
    definition:
      "+proj=stere +lat_0=90 +lat_ts=70 +lon_0=-45 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs",
    ellipsoidId: "earth",
    // NASA GIBS' grid for EPSG:3413.
    tileMatrixSet: polarGrid(4194304),
    bounds: [-180, 60, 180, 90],
    basemap: gibsBasemap(3413),
  },
  {
    id: "earth-antarctic",
    name: "Antarctic Polar Stereographic",
    code: "EPSG:3031",
    definition:
      "+proj=stere +lat_0=-90 +lat_ts=-71 +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs",
    ellipsoidId: "earth",
    tileMatrixSet: polarGrid(4194304),
    bounds: [-180, -90, 180, -60],
    basemap: gibsBasemap(3031),
  },
  {
    id: "earth-cylindrical",
    name: "Plate Carrée (WGS 84)",
    code: "EPSG:4326",
    definition: "+proj=longlat +datum=WGS84 +no_defs",
    ellipsoidId: "earth",
    tileMatrixSet: GEOGRAPHIC_GRID,
    bounds: [-180, -90, 180, 90],
    basemap: gibsBasemap(4326),
  },
  cylindrical(
    "moon",
    "Moon Simple Cylindrical",
    30100,
    MOON_RADIUS,
    "/maps/earth/moon_simp_cyl.map",
    "LROC_WAC",
  ),
  {
    id: "moon-north-polar",
    name: "Moon North Polar Stereographic",
    code: "IAU_2015:30118",
    wmsSrs: "EPSG:32661",
    definition: polarStereographic(true, MOON_RADIUS),
    ellipsoidId: "moon",
    // About 60°N at the edge, where the LRO WAC polar mosaic ends.
    tileMatrixSet: polarGrid(931000),
    bounds: [-180, 70, 180, 90],
    basemap: usgsBasemap("/maps/earth/moon_npole.map", "EPSG:32661", "LRO_WAC_north", 8),
  },
  {
    id: "moon-south-polar",
    name: "Moon South Polar Stereographic",
    code: "IAU_2015:30120",
    wmsSrs: "EPSG:32761",
    definition: polarStereographic(false, MOON_RADIUS),
    ellipsoidId: "moon",
    tileMatrixSet: polarGrid(931000),
    bounds: [-180, -90, 180, -70],
    basemap: usgsBasemap("/maps/earth/moon_spole.map", "EPSG:32761", "LRO_WAC_south", 8),
  },
  cylindrical(
    "mars",
    "Mars Simple Cylindrical",
    49900,
    MARS_RADIUS,
    "/maps/mars/mars_simp_cyl.map",
    "MOLA_color",
  ),
  {
    id: "mars-north-polar",
    name: "Mars North Polar Stereographic",
    code: "IAU_2015:49918",
    wmsSrs: "EPSG:32661",
    definition: polarStereographic(true, MARS_RADIUS),
    ellipsoidId: "mars",
    // The extent of the USGS north polar mosaics, about 38°N at the edges.
    tileMatrixSet: polarGrid(2357030),
    bounds: [-180, 65, 180, 90],
    basemap: usgsBasemap("/maps/mars/mars_npole.map", "EPSG:32661", "MOLA_color_north", 7),
  },
  {
    id: "mars-south-polar",
    name: "Mars South Polar Stereographic",
    code: "IAU_2015:49920",
    wmsSrs: "EPSG:32761",
    definition: polarStereographic(false, MARS_RADIUS),
    ellipsoidId: "mars",
    tileMatrixSet: polarGrid(2357030),
    bounds: [-180, -90, 180, -65],
    basemap: usgsBasemap("/maps/mars/mars_spole.map", "EPSG:32761", "MOLA_color_south", 7),
  },
  cylindrical(
    "mercury",
    "Mercury Simple Cylindrical",
    19900,
    2439400,
    "/maps/mercury/mercury_simp_cyl.map",
    "MESSENGER",
  ),
  cylindrical(
    "venus",
    "Venus Simple Cylindrical",
    29900,
    6051800,
    "/maps/venus/venus_simp_cyl.map",
    "MAGELLAN",
  ),
  cylindrical(
    "io",
    "Io Simple Cylindrical",
    50100,
    1821600,
    "/maps/jupiter/io_simp_cyl.map",
    "SSI_color",
  ),
  cylindrical(
    "europa",
    "Europa Simple Cylindrical",
    50200,
    1560800,
    "/maps/jupiter/europa_simp_cyl.map",
    "GALILEO_VOYAGER",
  ),
  cylindrical(
    "ganymede",
    "Ganymede Simple Cylindrical",
    50300,
    2631200,
    "/maps/jupiter/ganymede_simp_cyl.map",
    "GALILEO_VOYAGER",
  ),
  cylindrical(
    "callisto",
    "Callisto Simple Cylindrical",
    50400,
    2410300,
    "/maps/jupiter/callisto_simp_cyl.map",
    "GALILEO_VOYAGER",
  ),
  cylindrical(
    "titan",
    "Titan Simple Cylindrical",
    60600,
    2574730,
    "/maps/saturn/titan_simp_cyl.map",
    "Titan_ISS_Controlled_Mosaic",
  ),
  cylindrical(
    "pluto",
    "Pluto Simple Cylindrical",
    99900,
    1188300,
    "/maps/pluto/pluto_simp_cyl.map",
    "NEWHORIZONS_PLUTO_MOSAIC",
  ),
  cylindrical(
    "charon",
    "Charon Simple Cylindrical",
    90100,
    606000,
    "/maps/pluto/charon_simp_cyl.map",
    "NEWHORIZONS_CHARON_MOSAIC",
  ),
];

/**
 * Look a preset up by its id.
 *
 * Args:
 *   id: A `preferences.map.mapCrs` value.
 *
 * Returns:
 *   The preset, or `undefined` when `id` is not a preset id.
 */
export function getMapCrsPreset(id: string | undefined): MapCrsPreset | undefined {
  return id === undefined ? undefined : MAP_CRS_PRESETS.find((preset) => preset.id === id);
}

/**
 * Read an `EPSG:<code>` map CRS value.
 *
 * Args:
 *   value: A `preferences.map.mapCrs` value.
 *
 * Returns:
 *   The numeric EPSG code, or `null` when the value is not an EPSG CRS.
 */
export function parseMapCrsEpsgCode(value: string | undefined): number | null {
  const match = /^\s*EPSG:(\d+)\s*$/i.exec(value ?? "");
  if (!match) return null;
  const code = Number(match[1]);
  return Number.isSafeInteger(code) && code > 0 ? code : null;
}

/**
 * Normalize a stored map CRS.
 *
 * Args:
 *   value: The raw `preferences.map.mapCrs` value.
 *
 * Returns:
 *   A preset id, `"EPSG:<code>"`, or `undefined` for the default Web Mercator
 *   map (absent, malformed or a Web Mercator code).
 */
export function normalizeMapCrs(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (getMapCrsPreset(value)) return value;
  const code = parseMapCrsEpsgCode(value);
  if (code === null || WEB_MERCATOR_CODES.has(code)) return undefined;
  // A code a preset uses (EPSG:3413, 3031, 4326) is that preset: it carries a
  // basemap, and MapLibre registers one grid per code, so a derived grid for
  // the bare code would clash with the preset's.
  const epsg = `EPSG:${code}`;
  return MAP_CRS_PRESETS.find((preset) => preset.code === epsg)?.id ?? epsg;
}

/**
 * Point a Web Mercator WMS or ArcGIS export template at a map CRS.
 *
 * GeoLibre's WMS layers request `BBOX={bbox-epsg-3857}` in `EPSG:3857`. On a
 * map in another CRS each tile is a box in that CRS instead, which MapLibre
 * writes into the `{bbox}` token, so the template asks for `{bbox}` in `code`.
 * WMS requests move to version 1.1.1, whose `SRS` BBOX is east, north for every
 * CRS (1.3.0 swaps the axes of geographic ones), and an ArcGIS `export`
 * template has its `bboxSR`/`imageSR` set to the EPSG number.
 *
 * Args:
 *   template: A raster tile template.
 *   code: The map CRS's authority code, e.g. `EPSG:3031` or `IAU_2015:49918`.
 *
 * Returns:
 *   The template for the CRS, the template unchanged when it already uses
 *   `{bbox}`, or `null` for a template with no bounding box (an XYZ or TMS
 *   template), which cannot be drawn in another CRS.
 */
export function adaptBboxTemplateToCrs(template: string, code: string): string | null {
  if (template.includes("{bbox}")) return template;
  if (!template.includes("{bbox-epsg-3857}")) return null;
  let url = template.replace(/\{bbox-epsg-3857\}/g, "{bbox}");
  const epsg = /^EPSG:(\d+)$/i.exec(code)?.[1];
  // Replace (or append) one query parameter, matching its name in any case.
  // Hand-rolled because URLSearchParams would percent-encode the braces of the
  // MapLibre tokens.
  const setParam = (name: string, value: string) => {
    const pattern = new RegExp(`([?&])${name}=[^&]*`, "i");
    url = pattern.test(url)
      ? url.replace(pattern, `$1${name}=${value}`)
      : `${url}${url.includes("?") ? "&" : "?"}${name}=${value}`;
  };
  const removeParam = (name: string) => {
    url = url.replace(new RegExp(`([?&])${name}=[^&]*(&?)`, "i"), (_, lead, trail) =>
      trail ? lead : "",
    );
  };
  if (/[?&]bboxSR=/i.test(url)) {
    // An ArcGIS MapServer/ImageServer export: it takes a WKID, not a code.
    if (!epsg) return null;
    setParam("bboxSR", epsg);
    setParam("imageSR", epsg);
    return url;
  }
  removeParam("CRS");
  setParam("SRS", code);
  setParam("VERSION", "1.1.1");
  return url;
}

/**
 * The smallest centered square grid over the part of a CRS worth mapping, for
 * an EPSG code without a published tile grid.
 *
 * Samples a 2° lng/lat lattice and keeps the points `projection` takes forward
 * and back to where they started (a transverse Mercator's far side does not)
 * whose local scale is at most {@link MAX_RELATIVE_SCALE} times the CRS's
 * smallest. A polar stereographic map round-trips almost to the other pole,
 * but out there a kilometre spans thousands of CRS units, and a grid that wide
 * leaves the CRS's own area a speck at every useful zoom. The extent of the
 * kept points is padded by 4%. MapLibre finds the edge of a world projection
 * by walking out from the grid's center, so the grid is centered on them.
 *
 * Args:
 *   projection: Lng/lat to CRS and back, the shape of a proj4 converter.
 *   geographic: Whether the CRS is in degrees, which gets the whole-world grid.
 *
 * Returns:
 *   The grid, or `null` when no sampled point survives the round trip.
 */
export function deriveTileMatrixSet(
  projection: {
    forward(position: number[]): number[];
    inverse(position: number[]): number[] | null;
  },
  geographic: boolean,
): MapCrsTileMatrixSet | null {
  if (geographic) return GEOGRAPHIC_GRID;
  const forward = (lng: number, lat: number): [number, number] | null => {
    try {
      const [x, y] = projection.forward([lng, lat]) ?? [];
      // A billion CRS units (a million km in metres) is no longer a map.
      return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) <= 1e9 && Math.abs(y) <= 1e9
        ? [x, y]
        : null;
    } catch {
      return null;
    }
  };
  const roundTrips = (point: [number, number], lng: number, lat: number): boolean => {
    let back: number[] | null;
    try {
      back = projection.inverse(point);
    } catch {
      return false;
    }
    if (!back || !Number.isFinite(back[0]) || !Number.isFinite(back[1])) return false;
    const dLng = Math.abs(((((back[0] - lng) % 360) + 540) % 360) - 180);
    return Math.abs(back[1] - lat) <= 1e-4 && dLng <= 1e-4;
  };
  // CRS units per radian of arc, along the meridian and the parallel; the
  // larger is the point's scale. Only ratios between points matter, so the
  // CRS's unit (metre, foot) drops out.
  const STEP = 0.01;
  const radians = (STEP * Math.PI) / 180;
  const samples: { x: number; y: number; scale: number }[] = [];
  for (let lng = -180; lng <= 180; lng += 2) {
    for (let lat = -88; lat <= 88; lat += 2) {
      const point = forward(lng, lat);
      if (!point || !roundTrips(point, lng, lat)) continue;
      const north = forward(lng, lat + STEP);
      const east = forward(lng + STEP, lat);
      if (!north || !east) continue;
      const scale = Math.max(
        Math.hypot(north[0] - point[0], north[1] - point[1]) / radians,
        Math.hypot(east[0] - point[0], east[1] - point[1]) /
          (radians * Math.cos((lat * Math.PI) / 180)),
      );
      if (scale > 0 && Number.isFinite(scale)) samples.push({ x: point[0], y: point[1], scale });
    }
  }
  if (samples.length === 0) return null;
  const limit = MAX_RELATIVE_SCALE * Math.min(...samples.map((sample) => sample.scale));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { x, y, scale } of samples) {
    if (scale > limit) continue;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const side = Math.max(maxX - minX, maxY - minY) * 1.04;
  if (!(side > 0)) return null;
  return {
    origin: [(minX + maxX - side) / 2, (minY + maxY + side) / 2],
    extentAtZoom0: side,
  };
}

/**
 * How much more a derived grid's edge may stretch distances than the CRS's
 * least distorted place: about 11°N for an Antarctic polar stereographic map,
 * and some 65° either side of a transverse Mercator's central meridian.
 */
const MAX_RELATIVE_SCALE = 2.5;
